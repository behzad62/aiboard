import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { CERTIFIED_RETRY_DELAYS_MS } from "../../lib/benchmark/certified/retry-policy.js";
import { ProviderTransportError } from "../src/account-runner-model.js";
import {
  RUNNER_PROVIDER_RETRY_DELAYS_MS,
  runnerProviderRetryDeadlineMs,
  completeWithProviderRetry,
} from "../src/provider-call-retry.js";
import { classifyProviderFailure } from "../src/provider-health.js";
import { BudgetExceededError } from "../src/budget-ledger.js";
import { SqliteSchedulerStore } from "../src/sqlite-scheduler-store.js";

test("provider call retry uses the certified midpoint schedule and caps physical calls at six", async () => {
  const sleeps: number[] = [];
  const progress: Array<{ retry: number; delayMs: number; reason: string }> = [];
  let calls = 0;
  await assert.rejects(
    completeWithProviderRetry({
      complete: async () => {
        calls += 1;
        throw new ProviderTransportError(
          `temporary failure containing secret-token-${calls}`,
          503
        );
      },
      classify: classifyProviderFailure,
      runtimeId: "runtime_1",
      providerId: "provider_1",
      modelId: "model_1",
      random: () => 0.5,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      onRetry: (event) => progress.push(event),
    }),
    /secret-token-6/
  );

  assert.equal(calls, 6);
  assert.deepEqual(sleeps, [2_000, 5_000, 15_000, 30_000, 60_000]);
  assert.deepEqual(progress.map(({ retry, delayMs }) => ({ retry, delayMs })), [
    { retry: 1, delayMs: 2_000 },
    { retry: 2, delayMs: 5_000 },
    { retry: 3, delayMs: 15_000 },
    { retry: 4, delayMs: 30_000 },
    { retry: 5, delayMs: 60_000 },
  ]);
  assert.ok(progress.every((event) => !event.reason.includes("secret-token")));
});

test("provider call retry gives a longer Retry-After precedence over jitter", async () => {
  const sleeps: number[] = [];
  let calls = 0;
  const result = await completeWithProviderRetry({
    complete: async () => {
      calls += 1;
      if (calls === 1) {
        throw new ProviderTransportError("slow down", 429, "rate_limit", 12_000);
      }
      return "ok";
    },
    classify: classifyProviderFailure,
    runtimeId: "runtime_1",
    providerId: "provider_1",
    modelId: "model_1",
    random: () => 0,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  });

  assert.equal(result, "ok");
  assert.deepEqual(sleeps, [12_000]);
});

test("provider call retry stops admission for cancellation and deadlines", async () => {
  const controller = new AbortController();
  controller.abort(new DOMException("cancelled", "AbortError"));
  let cancelledCalls = 0;
  await assert.rejects(
    completeWithProviderRetry({
      complete: async () => {
        cancelledCalls += 1;
        return "unexpected";
      },
      signal: controller.signal,
      classify: classifyProviderFailure,
      runtimeId: "runtime_1",
      providerId: "provider_1",
      modelId: "model_1",
    }),
    /cancelled/
  );
  assert.equal(cancelledCalls, 0);

  let deadlineCalls = 0;
  let slept = false;
  await assert.rejects(
    completeWithProviderRetry({
      complete: async () => {
        deadlineCalls += 1;
        throw new ProviderTransportError("temporary", 503);
      },
      deadlineMs: 11_999,
      now: () => 10_000,
      classify: classifyProviderFailure,
      runtimeId: "runtime_1",
      providerId: "provider_1",
      modelId: "model_1",
      random: () => 0.5,
      sleep: async () => {
        slept = true;
      },
    }),
    /deadline/i
  );
  assert.equal(deadlineCalls, 1);
  assert.equal(slept, false);
});

test("Runner retry deadline uses the remaining active-time budget as an absolute boundary", () => {
  assert.equal(runnerProviderRetryDeadlineMs(undefined, 25, 1_000), undefined);
  assert.equal(runnerProviderRetryDeadlineMs(100, 25, 1_000), 1_075);
  assert.equal(runnerProviderRetryDeadlineMs(100, 125, 1_000), 1_000);
});

test("provider call retry never retries fatal provider classifications", async () => {
  const failures = [
    new ProviderTransportError("bad key", 401),
    new ProviderTransportError("billing required", 402),
    new ProviderTransportError("hard quota", 429, "insufficient_quota"),
    new ProviderTransportError("missing model", 404),
    new ProviderTransportError("invalid request", 400),
  ];

  for (const failure of failures) {
    let calls = 0;
    await assert.rejects(
      completeWithProviderRetry({
        complete: async () => {
          calls += 1;
          throw failure;
        },
        classify: classifyProviderFailure,
        runtimeId: "runtime_1",
        providerId: "provider_1",
        modelId: "model_1",
        sleep: async () => {
          throw new Error("fatal failures must not sleep");
        },
      }),
      failure
    );
    assert.equal(calls, 1);
  }
});

test("provider call retry fails closed for budget and untyped local failures", async () => {
  for (const failure of [
    new BudgetExceededError("run_1", "modelCalls", 2, 1),
    new Error("local accounting failed"),
  ]) {
    let calls = 0;
    let sleeps = 0;
    await assert.rejects(
      completeWithProviderRetry({
        complete: async () => {
          calls += 1;
          throw failure;
        },
        classify: classifyProviderFailure,
        sleep: async () => {
          sleeps += 1;
        },
      }),
      failure
    );
    assert.equal(calls, 1);
    assert.equal(sleeps, 0);
  }
});

test("stable logical retry identity reuses byte-equivalent durable jitter", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-retry-event-"));
  const store = new SqliteSchedulerStore(join(root, "scheduler.sqlite"));
  try {
    store.append({
      runId: "run_1",
      type: "run.initialized",
      occurredAt: "2026-07-29T00:00:00.000Z",
      actor: { role: "runner", id: "test" },
      idempotencyKey: "run:init",
      payload: {},
    });
    const persisted: unknown[] = [];
    for (const random of [() => 0, () => 1]) {
      let calls = 0;
      await assert.rejects(
        completeWithProviderRetry({
          complete: async () => {
            calls += 1;
            throw new ProviderTransportError("temporary", 503);
          },
          classify: classifyProviderFailure,
          retryIdentity: "worker:run_1:task_1:1:turn:1",
          runtimeId: "runtime_1",
          providerId: "provider_1",
          modelId: "model_1",
          random,
          onRetry: (event) => {
            const durable = store.append({
              runId: "run_1",
              type: "provider.retry_scheduled",
              occurredAt: "2026-07-29T00:00:01.000Z",
              actor: { role: "runner", id: "test" },
              idempotencyKey: "retry:logical:1",
              payload: { ...event },
            });
            persisted.push(durable.payload);
          },
          sleep: async () => {
            throw new Error("stop after persisted retry");
          },
        }),
        /stop after persisted retry/
      );
      assert.equal(calls, 1);
    }
    assert.equal(store.readRun("run_1").filter(
      (event) => event.type === "provider.retry_scheduled"
    ).length, 1);
    assert.deepEqual(persisted[0], persisted[1]);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("Runner V2 and certified browser retry schedules remain identical", () => {
  assert.deepEqual(
    [...RUNNER_PROVIDER_RETRY_DELAYS_MS],
    [...CERTIFIED_RETRY_DELAYS_MS]
  );
});
