import assert from "node:assert/strict";
import test from "node:test";

import { CERTIFIED_RETRY_DELAYS_MS } from "../../lib/benchmark/certified/retry-policy.js";
import { ProviderTransportError } from "../src/account-runner-model.js";
import {
  RUNNER_PROVIDER_RETRY_DELAYS_MS,
  completeWithProviderRetry,
} from "../src/provider-call-retry.js";
import { classifyProviderFailure } from "../src/provider-health.js";

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

test("Runner V2 and certified browser retry schedules remain identical", () => {
  assert.deepEqual(
    [...RUNNER_PROVIDER_RETRY_DELAYS_MS],
    [...CERTIFIED_RETRY_DELAYS_MS]
  );
});
