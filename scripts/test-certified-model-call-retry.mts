/* Retry behavior for certified model calls (run: npx tsx scripts/test-certified-model-call-retry.mts) */
import assert from "node:assert/strict";
import fs from "node:fs";
import { __resetBenchmarkStoreForTests } from "../lib/benchmark/store";
import { createCertifiedRunContext } from "../lib/benchmark/certified/run-persistence";
import {
  callCertifiedModel,
  CertifiedProviderError,
  expandCertifiedPhysicalUsages,
} from "../lib/benchmark/certified/model-call";
import { CertifiedBudgetExceededError } from "../lib/benchmark/certified/budget";
import { classifyProviderFailure } from "../lib/benchmark/certified/classify-provider-failure";
import { createCertifiedTabRunCoordinator } from "../lib/benchmark/certified/run-session";
import type { SelectedModel, StreamChunk } from "../lib/providers/base";
import type { PersistentCertifiedRunContext } from "../lib/benchmark/certified/run-context";
import { parseRetryAfter } from "../lib/providers/account-runner";
import {
  CERTIFIED_RETRY_DELAYS_MS,
  certifiedRetryDelayMs,
  type CertifiedRetryRuntime,
} from "../lib/benchmark/certified/retry-policy";

let failures = 0;

function check(name: string, ok: boolean, detail?: unknown): void {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` -> ${JSON.stringify(detail)}`}`);
}

async function expectReject(
  name: string,
  action: () => Promise<unknown>,
  check2: (error: unknown) => boolean
): Promise<unknown> {
  try {
    const value = await action();
    check(name, false, { resolved: value });
    return undefined;
  } catch (error) {
    check(name, check2(error), error instanceof Error ? error.message : String(error));
    return error;
  }
}

// Reads the 1-based `attempt` marker out of a run-event's serialized details.
// Returns NaN when absent so a missing marker fails the assertion loudly.
function eventDetailAttempt(detailsJson: string | undefined): number {
  if (!detailsJson) return Number.NaN;
  try {
    const parsed = JSON.parse(detailsJson) as { attempt?: unknown };
    return typeof parsed.attempt === "number" ? parsed.attempt : Number.NaN;
  } catch {
    return Number.NaN;
  }
}

const model: SelectedModel = {
  modelId: "openai:gpt-retry",
  providerId: "openai",
  displayName: "GPT Retry",
};

let contextCounter = 0;
function makeTestContext(): PersistentCertifiedRunContext {
  contextCounter += 1;
  return createCertifiedRunContext({
    runId: `run-certified-model-call-retry-${contextCounter}`,
    suiteId: "suite-model-call-retry",
    track: "gameiq",
    harnessProfile: "raw-single-model",
    startedAt: new Date().toISOString(),
    caseIds: [`case-retry-${contextCounter}`],
    teamCompositionIds: [`team-retry-${contextCounter}`],
  });
}

__resetBenchmarkStoreForTests();

// ---------------------------------------------------------------------------
// Classification unit checks
// ---------------------------------------------------------------------------

check(
  "503 classifies transient",
  classifyProviderFailure("ChatGPT request failed: 503") === "transient"
);
check(
  "timeout classifies transient",
  classifyProviderFailure("Certified model call timed out after 120000ms.") === "transient"
);
check(
  "empty response classifies transient",
  classifyProviderFailure("Certified provider returned an empty response.") === "transient"
);
const genericOpenAiProcessingError =
  "An error occurred while processing your request. You can retry your request, or contact us through our help center at help.openai.com if the error persists. Please include the request ID 12857d04-3d48-4f42-821c-7ef7eba4efc3 in your message.";
check(
  "generic OpenAI processing error classifies transient",
  classifyProviderFailure(genericOpenAiProcessingError) === "transient"
);
check(
  "quota-depleted classifies fatal (fatal wins over 429 in the same message)",
  classifyProviderFailure(
    "[429] Your prepayment credits are depleted. Please go to AI Studio to add a payment method."
  ) === "fatal"
);
check(
  "invalid api key classifies fatal",
  classifyProviderFailure("Unauthorized: invalid api key") === "fatal"
);
// 2026-07 fresh-run additions: the verbatim OpenRouter 402 credits error
// (killed the GLM/MiniMax GameIQ runs) and Gemini's quota phrasing are
// account errors — fatal, never retried.
check(
  "OpenRouter 402 credits error classifies fatal",
  classifyProviderFailure(
    "402 This request requires more credits, or fewer max_tokens. You requested up to 16384 tokens, but can only afford 9914. To increase, visit https://openrouter.ai/workspaces/default/keys"
  ) === "fatal"
);
check(
  "exceeded-your-current-quota classifies fatal",
  classifyProviderFailure(
    "You exceeded your current quota, please check your plan and billing details."
  ) === "fatal"
);
check(
  "structured-output parse failure classifies other",
  classifyProviderFailure("Certified structured response was not valid JSON: x") === "other"
);
check(
  "user abort classifies other",
  classifyProviderFailure("Certified run aborted by user.") === "other"
);

// ---------------------------------------------------------------------------
// Behavior: transient failure retried to success (exactly 2 invocations)
// ---------------------------------------------------------------------------

{
  const sleeps: number[] = [];
  const context = makeTestContext();
  let now = Date.parse(context.startedAt);
  const runtime: CertifiedRetryRuntime = {
    now: () => now,
    random: () => 0.5,
    sleep: async (ms, signal) => {
      if (signal?.aborted) throw signal.reason;
      sleeps.push(ms);
      now += ms;
    },
  };
  let calls = 0;
  let active = 0;
  let overlapped = false;
  async function* fiveFailuresThenSuccess(): AsyncIterable<StreamChunk> {
    calls += 1;
    active += 1;
    if (active > 1) overlapped = true;
    try {
      if (calls <= 5) {
        yield {
          type: "error",
          error: "temporarily unavailable",
          errorMetadata: { statusCode: 503 },
        };
        return;
      }
      yield { type: "token", content: '{"action":{"column":6}}' };
      yield { type: "done" };
    } finally {
      active -= 1;
    }
  }
  const result = await callCertifiedModel({
    model,
    system: "s",
    user: "u",
    maxTokens: 128,
    temperature: 0,
    context,
    caseId: context.caseIds[0],
    attemptId: "attempt-five-retries",
    participantId: "p",
    streamChat: () => fiveFailuresThenSuccess(),
    retryRuntime: runtime,
  });
  check(
    "central policy makes five delayed retries and six non-overlapping physical calls",
    calls === 6 &&
      !overlapped &&
      JSON.stringify(sleeps) === JSON.stringify([2_000, 5_000, 15_000, 30_000, 60_000]) &&
      result.retryAttempts?.length === 5 &&
      context.snapshot().traces.filter((trace) => trace.attemptId === "attempt-five-retries").length === 6,
    { calls, sleeps, overlapped, retryAttempts: result.retryAttempts?.length }
  );
}

check(
  "jitter lower bound is minus twenty percent",
  certifiedRetryDelayMs(5_000, undefined, 0) === 4_000
);
check(
  "jitter upper bound is plus twenty percent",
  certifiedRetryDelayMs(5_000, undefined, 1) === 6_000
);
check(
  "Retry-After overrides a shorter jittered base",
  certifiedRetryDelayMs(5_000, 12_000, 0.5) === 12_000
);
check(
  "canonical policy has the approved five delays",
  JSON.stringify(CERTIFIED_RETRY_DELAYS_MS) ===
    JSON.stringify([2_000, 5_000, 15_000, 30_000, 60_000])
);
const retryAfterNow = Date.parse("2026-07-29T00:00:00.000Z");
check("delta-seconds Retry-After parses", parseRetryAfter("12", retryAfterNow) === 12_000);
check(
  "HTTP-date Retry-After parses",
  parseRetryAfter("Wed, 29 Jul 2026 00:00:12 GMT", retryAfterNow) === 12_000
);
for (const malformed of ["-1", "NaN", "not-a-date", ""]) {
  check(
    `malformed Retry-After ${JSON.stringify(malformed)} is rejected`,
    parseRetryAfter(malformed, retryAfterNow) === undefined
  );
}

for (const statusCode of [429, 500, 502, 503, 504]) {
  check(
    `typed HTTP ${statusCode} classifies transient`,
    classifyProviderFailure("safe provider failure", { statusCode }) === "transient"
  );
}
for (const statusCode of [400, 401, 403, 501]) {
  const expected = statusCode === 401 || statusCode === 403 ? "fatal" : "other";
  check(
    `typed HTTP ${statusCode} does not enter transient recovery`,
    classifyProviderFailure("safe provider failure", { statusCode }) === expected
  );
}
for (const statusCode of [400, 418, 501]) {
  check(
    `typed HTTP ${statusCode} overrides transient-looking message text`,
    classifyProviderFailure("timeout while unavailable; retry after 503", {
      statusCode,
    }) === "other",
  );
}

{
  const context = makeTestContext();
  let calls = 0;
  let sleeps = 0;
  await expectReject(
    "typed non-retryable status makes exactly one physical call",
    () =>
      callCertifiedModel({
        model,
        system: "s",
        user: "u",
        maxTokens: 128,
        temperature: 0,
        context,
        caseId: context.caseIds[0],
        attemptId: "attempt-explicit-400",
        participantId: "p",
        streamChat: async function* () {
          calls++;
          yield {
            type: "error",
            error: "timeout while unavailable; retry after 503",
            errorMetadata: { statusCode: 400 },
          };
        },
        retryRuntime: {
          now: () => Date.parse(context.startedAt),
          random: () => 0.5,
          sleep: async () => {
            sleeps++;
          },
        },
      }),
    (error) =>
      error instanceof CertifiedProviderError &&
      error.classification === "other",
  );
  check(
    "typed non-retryable status never sleeps",
    calls === 1 && sleeps === 0,
    {
      calls,
      sleeps,
    },
  );
}

{
  const context = makeTestContext();
  let calls = 0;
  const result = await callCertifiedModel({
    model,
    system: "s",
    user: "u",
    maxTokens: 128,
    temperature: 0,
    context,
    caseId: context.caseIds[0],
    attemptId: "attempt-tool-call-output",
    participantId: "p",
    streamChat: async function* () {
      calls++;
      yield {
        type: "tool_call",
        toolCall: {
          id: "call-1",
          name: "submit_answer",
          arguments: { answer: 42 },
        },
      };
      yield { type: "done" };
    },
  });
  check(
    "tool-call-only completion is usable output and is not retried",
    calls === 1 &&
      result.rawResponse.includes("submit_answer") &&
      result.rawResponse.includes("42"),
    { calls, rawResponse: result.rawResponse },
  );
}

{
  const context = makeTestContext();
  let calls = 0;
  const error = await expectReject(
    "terminal transient exhaustion returns every physical usage",
    () =>
      callCertifiedModel({
        model,
        system: "s",
        user: "u",
        maxTokens: 128,
        temperature: 0,
        context,
        caseId: context.caseIds[0],
        attemptId: "attempt-terminal-exhaustion-usage",
        participantId: "p",
        retryDelaysMs: [0, 0],
        retryRuntime: {
          now: () => Date.parse(context.startedAt),
          random: () => 0.5,
          sleep: async () => {},
        },
        streamChat: async function* () {
          calls++;
          yield {
            type: "usage",
            usage: { inputTokens: 10 * calls, outputTokens: calls },
          };
          yield {
            type: "error",
            error: "temporary",
            errorMetadata: { statusCode: 503 },
          };
        },
      }),
    (candidate) =>
      candidate instanceof CertifiedProviderError &&
      expandCertifiedPhysicalUsages(candidate).length === 3,
  );
  check(
    "terminal exhaustion usage remains ordered and complete",
    error instanceof CertifiedProviderError &&
      calls === 3 &&
      expandCertifiedPhysicalUsages(error)
        .map((usage) => usage.inputTokens)
        .join(",") === "10,20,30",
    error,
  );
}

{
  const context = makeTestContext();
  context.modelBudget.maxWallClockMs = 10_000;
  let sleeps = 0;
  const runtime: CertifiedRetryRuntime = {
    now: () => Date.parse(context.startedAt),
    random: () => 0.5,
    sleep: async () => {
      sleeps += 1;
    },
  };
  await expectReject(
    "Retry-After beyond remaining wall clock fails budget without sleeping",
    () => callCertifiedModel({
      model,
      system: "s",
      user: "u",
      maxTokens: 128,
      temperature: 0,
      context,
      caseId: context.caseIds[0],
      attemptId: "attempt-retry-after-budget",
      participantId: "p",
      streamChat: async function* () {
        yield {
          type: "error",
          error: "temporary",
          errorMetadata: { statusCode: 503, retryAfterMs: 12_000 },
        };
      },
      retryRuntime: runtime,
    }),
    (error) => error instanceof CertifiedBudgetExceededError
  );
  check("budget rejection performs no retry sleep", sleeps === 0, sleeps);
}

{
  const context = makeTestContext();
  const progress: unknown[] = [];
  context.reportRetry = (event) => progress.push(event);
  let calls = 0;
  await callCertifiedModel({
    model,
    system: "s",
    user: "u",
    maxTokens: 128,
    temperature: 0,
    context,
    caseId: context.caseIds[0],
    attemptId: "attempt-sanitized-progress",
    participantId: "participant-safe",
    streamChat: async function* () {
      calls += 1;
      if (calls === 1) {
        yield {
          type: "error",
          error: "secret-token-value must never reach progress",
          errorMetadata: { statusCode: 503 },
        };
        return;
      }
      yield { type: "token", content: "{}" };
      yield { type: "done" };
    },
    retryRuntime: {
      now: () => Date.parse(context.startedAt),
      random: () => 0.5,
      sleep: async () => {},
    },
  });
  check(
    "retry progress is typed and sanitized",
    progress.length === 1 &&
      JSON.stringify(progress).includes("HTTP 503") &&
      !JSON.stringify(progress).includes("secret-token-value"),
    progress
  );
}

for (let waitIndex = 0; waitIndex < CERTIFIED_RETRY_DELAYS_MS.length; waitIndex++) {
  const context = makeTestContext();
  const controller = new AbortController();
  const reason = new Error(`cancel-wait-${waitIndex}`);
  let calls = 0;
  const error = await expectReject(
    `cancellation during wait ${waitIndex + 1} preserves reason identity`,
    () => callCertifiedModel({
      model,
      system: "s",
      user: "u",
      maxTokens: 128,
      temperature: 0,
      context,
      caseId: context.caseIds[0],
      attemptId: `attempt-cancel-wait-${waitIndex}`,
      participantId: "p",
      signal: controller.signal,
      streamChat: async function* () {
        calls += 1;
        yield {
          type: "error",
          error: "temporary",
          errorMetadata: { statusCode: 503 },
        };
      },
      retryDelaysMs: [...CERTIFIED_RETRY_DELAYS_MS.slice(waitIndex)],
      retryRuntime: {
        now: () => Date.parse(context.startedAt),
        random: () => 0.5,
        sleep: async () => {
          controller.abort(reason);
          throw reason;
        },
      },
    }),
    (candidate) => candidate === reason
  );
  check(`wait ${waitIndex + 1} starts no next physical call`, error === reason && calls === 1);
}

{
  const providerSources = [
    "lib/providers/openai.ts",
    "lib/providers/anthropic.ts",
    "lib/providers/custom.ts",
    "lib/providers/openrouter.ts",
    "lib/providers/xai.ts",
    "lib/client/providers.ts",
  ].map((file) => fs.readFileSync(file, "utf8"));
  check(
    "certified calls disable automatic SDK retries at every supported constructor",
    providerSources.every((source) =>
      source.includes("disableAutomaticRetries") && source.includes("maxRetries: 0")
    )
  );
}

{
  let calls = 0;
  async function* flaky(): AsyncIterable<StreamChunk> {
    calls++;
    if (calls === 1) {
      throw new Error("ChatGPT request failed: 503");
    }
    yield { type: "token", content: '{"action":{"column":3}}' };
    yield { type: "done" };
  }

  const context = makeTestContext();
  const result = await callCertifiedModel({
    model,
    system: "s",
    user: "u",
    maxTokens: 128,
    temperature: 0,
    context,
    caseId: context.caseIds[0],
    attemptId: "attempt-retry-success",
    participantId: "p",
    streamChat: () => flaky(),
    retryDelaysMs: [0, 0],
  });
  check(
    "transient error retried to success",
    result.rawResponse === '{"action":{"column":3}}' && calls === 2,
    { rawResponse: result.rawResponse, calls }
  );

  const traces = context.snapshot().traces.filter(
    (trace) => trace.attemptId === "attempt-retry-success"
  );
  check(
    "transient-retry success recorded one failed trace and one parsed trace",
    traces.length === 2 &&
      traces.some((trace) =>
        trace.retryHistory.some((attempt) => attempt.status === "provider_error")
      ) &&
      traces.some((trace) =>
        trace.retryHistory.some((attempt) => attempt.status === "parsed")
      ),
    traces
  );
}

{
  let calls = 0;
  async function* flakyGenericOpenAiError(): AsyncIterable<StreamChunk> {
    calls++;
    if (calls === 1) {
      throw new Error(genericOpenAiProcessingError);
    }
    yield { type: "token", content: '{"action":{"column":2}}' };
    yield { type: "done" };
  }

  const context = makeTestContext();
  const result = await callCertifiedModel({
    model,
    system: "s",
    user: "u",
    maxTokens: 128,
    temperature: 0,
    context,
    caseId: context.caseIds[0],
    attemptId: "attempt-retry-generic-openai-error",
    participantId: "p",
    streamChat: () => flakyGenericOpenAiError(),
    retryDelaysMs: [0, 0],
  });
  check(
    "generic OpenAI processing error retried to success",
    result.rawResponse === '{"action":{"column":2}}' && calls === 2,
    { rawResponse: result.rawResponse, calls }
  );
}

async function waitFor(check2: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 1_000; attempt++) {
    if (check2()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("Timed out waiting for certified model-call state.");
}

// ---------------------------------------------------------------------------
// Behavior: a timed-out physical attempt is aborted before retry admission,
// and the retry owns a distinct fresh provider signal.
// ---------------------------------------------------------------------------

{
  const providerSignals: AbortSignal[] = [];
  let firstSignalAbortedBeforeRetry = false;
  async function* timeoutThenSucceed(input: {
    params: { signal?: AbortSignal };
  }): AsyncIterable<StreamChunk> {
    const signal = input.params.signal;
    if (!signal) throw new Error("Certified provider did not receive a signal.");
    providerSignals.push(signal);
    if (providerSignals.length === 1) {
      await new Promise<void>((resolve) => {
        if (signal.aborted) {
          resolve();
          return;
        }
        signal.addEventListener("abort", () => resolve(), { once: true });
      });
      return;
    }
    firstSignalAbortedBeforeRetry = providerSignals[0]!.aborted;
    yield { type: "token", content: '{"action":{"column":4}}' };
    yield { type: "done" };
  }

  const context = makeTestContext();
  context.modelBudget.maxModelCallMs = 10;
  const result = await callCertifiedModel({
    model,
    system: "s",
    user: "u",
    maxTokens: 128,
    temperature: 0,
    context,
    caseId: context.caseIds[0],
    attemptId: "attempt-timeout-fresh-retry-signal",
    participantId: "p",
    streamChat: timeoutThenSucceed,
    retryDelaysMs: [0],
  });
  check(
    "timed-out physical attempt is aborted before retry stream starts",
    firstSignalAbortedBeforeRetry,
    providerSignals.map((signal) => signal.aborted)
  );
  check(
    "retry receives a distinct fresh provider signal",
    providerSignals.length === 2 &&
      providerSignals[0] !== providerSignals[1] &&
      providerSignals[0]!.aborted &&
      !providerSignals[1]!.aborted,
    providerSignals.map((signal) => signal.aborted)
  );
  check(
    "retry after timeout succeeds without changing retry policy",
    result.rawResponse === '{"action":{"column":4}}' &&
      result.retryAttempts?.length === 1,
    result
  );
}

// ---------------------------------------------------------------------------
// Behavior: retry admission waits for the prior provider iterator to confirm
// teardown, and suppresses retry if that confirmation never arrives.
// ---------------------------------------------------------------------------

{
  let calls = 0;
  let firstSignal!: AbortSignal;
  let firstReturnResolved = false;
  let secondAttemptStartedBeforeFirstReturnResolved = false;
  let rejectFirstNext!: (error: Error) => void;
  let resolveFirstReturn!: () => void;
  let notifyFirstNextStarted!: () => void;
  let notifyFirstReturnStarted!: () => void;
  let notifySecondAttemptStarted!: () => void;
  const firstNextStarted = new Promise<void>((resolve) => {
    notifyFirstNextStarted = resolve;
  });
  const firstReturnStarted = new Promise<void>((resolve) => {
    notifyFirstReturnStarted = resolve;
  });
  const secondAttemptStarted = new Promise<void>((resolve) => {
    notifySecondAttemptStarted = resolve;
  });
  const originalRandom = Math.random;
  Math.random = () => 0;
  try {
    const context = makeTestContext();
    const pending = callCertifiedModel({
      model,
      system: "s",
      user: "u",
      maxTokens: 128,
      temperature: 0,
      context,
      caseId: context.caseIds[0],
      attemptId: "attempt-retry-awaits-teardown",
      participantId: "p",
      streamChat: ({ params }): AsyncIterable<StreamChunk> => {
        calls++;
        if (calls === 1) {
          if (!params.signal) throw new Error("Certified provider did not receive a signal.");
          firstSignal = params.signal;
          return {
            [Symbol.asyncIterator](): AsyncIterator<StreamChunk> {
              return {
                next: () => {
                  notifyFirstNextStarted();
                  return new Promise<IteratorResult<StreamChunk>>((_, reject) => {
                    rejectFirstNext = reject;
                  });
                },
                return: () => {
                  notifyFirstReturnStarted();
                  return new Promise<IteratorResult<StreamChunk>>((resolve) => {
                    resolveFirstReturn = () => {
                      firstReturnResolved = true;
                      resolve({ done: true, value: undefined });
                    };
                  });
                },
              };
            },
          };
        }
        secondAttemptStartedBeforeFirstReturnResolved = !firstReturnResolved;
        notifySecondAttemptStarted();
        return (async function* (): AsyncIterable<StreamChunk> {
          yield { type: "token", content: '{"action":{"column":5}}' };
          yield { type: "done" };
        })();
      },
      retryDelaysMs: [0],
    });

    await firstNextStarted;
    rejectFirstNext(new Error("ChatGPT request failed: 503"));
    await firstReturnStarted;
    await Promise.race([
      secondAttemptStarted,
      new Promise<void>((resolve) => setTimeout(resolve, 50)),
    ]);
    assert.equal(firstSignal.aborted, true);
    assert.equal(secondAttemptStartedBeforeFirstReturnResolved, false);
    resolveFirstReturn();
    const result = await pending;
    check(
      "retry starts only after the prior iterator confirms teardown",
      calls === 2 && result.rawResponse === '{"action":{"column":5}}',
      { calls, rawResponse: result.rawResponse }
    );
  } finally {
    Math.random = originalRandom;
  }
}

{
  let calls = 0;
  let retryCountWhenIteratorNeverConfirmsClose = 0;
  let teardownStartedAt = 0;
  let notifyFirstNextStarted!: () => void;
  let rejectFirstNext!: (error: Error) => void;
  let resolveFirstReturn!: () => void;
  const firstNextStarted = new Promise<void>((resolve) => {
    notifyFirstNextStarted = resolve;
  });
  const coordinator = createCertifiedTabRunCoordinator();
  const context = makeTestContext();
  assert.equal(
    coordinator.tryStart("advanced", {}, async () => {
      await callCertifiedModel({
        model,
        system: "s",
        user: "u",
        maxTokens: 128,
        temperature: 0,
        context,
        caseId: context.caseIds[0],
        attemptId: "attempt-retry-suppressed-unconfirmed-teardown",
        participantId: "p",
        streamChat: (): AsyncIterable<StreamChunk> => {
          calls++;
          if (calls > 1) retryCountWhenIteratorNeverConfirmsClose++;
          return {
            [Symbol.asyncIterator](): AsyncIterator<StreamChunk> {
              return {
                next: () => {
                  notifyFirstNextStarted();
                  return new Promise<IteratorResult<StreamChunk>>((_, reject) => {
                    rejectFirstNext = reject;
                  });
                },
                return: () => {
                  teardownStartedAt = Date.now();
                  return new Promise<IteratorResult<StreamChunk>>((resolve) => {
                    resolveFirstReturn = () =>
                      resolve({ done: true, value: undefined });
                  });
                },
              };
            },
          };
        },
        retryDelaysMs: [0],
      });
    }),
    true
  );
  await firstNextStarted;
  rejectFirstNext(new Error("ChatGPT request failed: 503"));
  await waitFor(() => teardownStartedAt > 0);
  await new Promise((resolve) => setTimeout(resolve, 5_100));
  const teardownElapsedMs = Date.now() - teardownStartedAt;
  assert.equal(retryCountWhenIteratorNeverConfirmsClose, 0);
  check(
    "unconfirmed iterator teardown retains tab ownership beyond the teardown limit",
    coordinator.getSnapshot().owner === "advanced" &&
      calls === 1 &&
      teardownElapsedMs >= 4_900 &&
      coordinator.tryStart("preset", { presetId: "model-iq" }, async () => undefined) === false,
    {
      calls,
      teardownElapsedMs,
      snapshot: coordinator.getSnapshot(),
    }
  );
  resolveFirstReturn();
  await waitFor(() => coordinator.getSnapshot().owner === null);
  check(
    "ownership releases only after physical teardown settles and the fail-closed error remains explicit",
    /retry was suppressed to avoid overlapping paid calls/i.test(
      coordinator.getSnapshot().error ?? ""
    ) &&
      coordinator.tryStart("preset", { presetId: "model-iq" }, async () => undefined) === true,
    coordinator.getSnapshot()
  );
}

// Removing the post-timeout `await teardown` makes both variants fail: the
// coordinator publishes idle and admits a replacement while the same physical
// iterator's return() is still pending.
for (const variant of ["parent cancellation", "budget cancellation"] as const) {
  let calls = 0;
  let surfacedError: unknown;
  let providerSignal!: AbortSignal;
  let notifyNextStarted!: () => void;
  let notifyReturnStarted!: () => void;
  let resolveReturn!: () => void;
  const nextStarted = new Promise<void>((resolve) => {
    notifyNextStarted = resolve;
  });
  const returnStarted = new Promise<void>((resolve) => {
    notifyReturnStarted = resolve;
  });
  const returnGate = new Promise<IteratorResult<StreamChunk>>((resolve) => {
    resolveReturn = () => resolve({ done: true, value: undefined });
  });
  const coordinator = createCertifiedTabRunCoordinator();
  const context = makeTestContext();
  const parentReason = new Error(
    "cancel coordinator while physical iterator teardown is pending"
  );
  if (variant === "budget cancellation") {
    context.modelBudget.maxUsd = 0;
  }

  assert.equal(
    coordinator.tryStart("advanced", {}, async (signal) => {
      try {
        await callCertifiedModel({
          model,
          system: "s",
          user: "u",
          maxTokens: 128,
          temperature: 0,
          context,
          caseId: context.caseIds[0],
          attemptId: `attempt-pending-teardown-${variant.replaceAll(" ", "-")}`,
          participantId: "p",
          signal,
          pricing:
            variant === "budget cancellation"
              ? { inputUsdPer1M: 0, outputUsdPer1M: 1_000_000 }
              : null,
          streamChat: ({ params }): AsyncIterable<StreamChunk> => {
            calls++;
            assert.ok(params.signal);
            providerSignal = params.signal;
            let emittedBudgetToken = false;
            return {
              [Symbol.asyncIterator](): AsyncIterator<StreamChunk> {
                return {
                  next: () => {
                    notifyNextStarted();
                    if (
                      variant === "budget cancellation" &&
                      !emittedBudgetToken
                    ) {
                      emittedBudgetToken = true;
                      return Promise.resolve({
                        done: false,
                        value: { type: "token", content: "budget" },
                      });
                    }
                    return new Promise<IteratorResult<StreamChunk>>(() => {});
                  },
                  return: () => {
                    notifyReturnStarted();
                    return returnGate;
                  },
                };
              },
            };
          },
          retryDelaysMs: [0],
        });
      } catch (error) {
        surfacedError = error;
        throw error;
      }
    }),
    true
  );

  await nextStarted;
  if (variant === "parent cancellation") {
    assert.equal(coordinator.cancel(parentReason), true);
  }
  await returnStarted;
  const winningReason = providerSignal.reason;
  assert.equal(providerSignal.aborted, true);
  if (variant === "parent cancellation") {
    assert.equal(winningReason, parentReason);
  } else {
    assert.ok(winningReason instanceof CertifiedBudgetExceededError);
    assert.match(winningReason.message, /projected USD .* exceeded maxUsd 0/i);
  }

  await new Promise((resolve) => setTimeout(resolve, 5_100));
  const replacementWhilePending = coordinator.tryStart(
    "preset",
    { presetId: "model-iq" },
    async () => undefined
  );
  check(
    `${variant} retains coordinator ownership beyond the teardown limit`,
    coordinator.getSnapshot().owner === "advanced" &&
      replacementWhilePending === false &&
      calls === 1,
    {
      calls,
      replacementWhilePending,
      snapshot: coordinator.getSnapshot(),
    }
  );

  resolveReturn();
  await waitFor(() => coordinator.getSnapshot().owner === null);
  const replacementAfterRelease = coordinator.tryStart(
    "preset",
    { presetId: "model-iq" },
    async () => undefined
  );
  check(
    `${variant} releases only after teardown and preserves the exact winning reason`,
    surfacedError === winningReason &&
      calls === 1 &&
      replacementAfterRelease === true,
    {
      calls,
      exactReason: surfacedError === winningReason,
      replacementAfterRelease,
      error:
        surfacedError instanceof Error ? surfacedError.message : String(surfacedError),
    }
  );
  await waitFor(() => coordinator.getSnapshot().owner === null);
}

{
  let calls = 0;
  const context = makeTestContext();
  const error = await expectReject(
    "missing iterator return suppresses a transient retry",
    () =>
      callCertifiedModel({
        model,
        system: "s",
        user: "u",
        maxTokens: 128,
        temperature: 0,
        context,
        caseId: context.caseIds[0],
        attemptId: "attempt-retry-suppressed-missing-return",
        participantId: "p",
        streamChat: (): AsyncIterable<StreamChunk> => {
          calls++;
          return {
            [Symbol.asyncIterator](): AsyncIterator<StreamChunk> {
              return {
                next: async () => {
                  throw new Error("ChatGPT request failed: 503");
                },
              };
            },
          };
        },
        retryDelaysMs: [0],
      }),
    (candidate) =>
      candidate instanceof CertifiedProviderError &&
      candidate.classification !== "transient" &&
      /retry was suppressed to avoid overlapping paid calls/i.test(candidate.message)
  );
  check(
    "missing iterator return fails closed without attempt 2",
    calls === 1 &&
      error instanceof CertifiedProviderError &&
      error.classification !== "transient",
    { calls, error: error instanceof Error ? error.message : String(error) }
  );
}

{
  let calls = 0;
  const context = makeTestContext();
  const error = await expectReject(
    "iterator return done false suppresses a transient retry",
    () =>
      callCertifiedModel({
        model,
        system: "s",
        user: "u",
        maxTokens: 128,
        temperature: 0,
        context,
        caseId: context.caseIds[0],
        attemptId: "attempt-retry-suppressed-return-done-false",
        participantId: "p",
        streamChat: (): AsyncIterable<StreamChunk> => {
          calls++;
          return {
            [Symbol.asyncIterator](): AsyncIterator<StreamChunk> {
              return {
                next: async () => {
                  throw new Error("ChatGPT request failed: 503");
                },
                return: async () => ({
                  done: false,
                  value: { type: "token", content: "still open" },
                }),
              };
            },
          };
        },
        retryDelaysMs: [0],
      }),
    (candidate) =>
      candidate instanceof CertifiedProviderError &&
      candidate.classification !== "transient" &&
      /retry was suppressed to avoid overlapping paid calls/i.test(candidate.message)
  );
  check(
    "iterator return done false fails closed without attempt 2",
    calls === 1 &&
      error instanceof CertifiedProviderError &&
      error.classification !== "transient",
    { calls, error: error instanceof Error ? error.message : String(error) }
  );
}

// ---------------------------------------------------------------------------
// Behavior: fatal failure throws immediately (exactly 1 invocation, typed error)
// ---------------------------------------------------------------------------

{
  let calls = 0;
  async function* dead(): AsyncIterable<StreamChunk> {
    calls++;
    throw new Error("Your prepayment credits are depleted.");
    yield { type: "token", content: "" };
  }

  const context = makeTestContext();
  const error = await expectReject(
    "fatal error throws typed CertifiedProviderError without retry",
    () =>
      callCertifiedModel({
        model,
        system: "s",
        user: "u",
        maxTokens: 128,
        temperature: 0,
        context,
        caseId: context.caseIds[0],
        attemptId: "attempt-retry-fatal",
        participantId: "p",
        streamChat: () => dead(),
        retryDelaysMs: [0, 0],
      }),
    (err) =>
      err instanceof CertifiedProviderError &&
      err.classification === "fatal" &&
      err.message ===
        "Certified provider request failed because the account or configuration is unavailable."
  );
  check("fatal error made exactly 1 stream invocation", calls === 1, calls);
  check(
    "fatal error persists only the typed account/configuration reason",
    error instanceof CertifiedProviderError &&
      error.message ===
        "Certified provider request failed because the account or configuration is unavailable.",
    error
  );
}

// ---------------------------------------------------------------------------
// Behavior: three consecutive transient failures exhaust retries (exactly 3
// invocations, then throws)
// ---------------------------------------------------------------------------

{
  let calls = 0;
  async function* alwaysFails(): AsyncIterable<StreamChunk> {
    calls++;
    throw new Error("ChatGPT request failed: 503");
    yield { type: "token", content: "" };
  }

  const context = makeTestContext();
  const error = await expectReject(
    "three consecutive transient failures exhaust retries and throw",
    () =>
      callCertifiedModel({
        model,
        system: "s",
        user: "u",
        maxTokens: 128,
        temperature: 0,
        context,
        caseId: context.caseIds[0],
        attemptId: "attempt-retry-exhausted",
        participantId: "p",
        streamChat: () => alwaysFails(),
        retryDelaysMs: [0, 0], // 1 initial attempt + 2 retries = 3 total
      }),
    (err) => err instanceof CertifiedProviderError && err.classification === "transient"
  );
  check("exhausted retries made exactly 3 stream invocations", calls === 3, calls);
  check(
    "exhausted retries surface only the typed transient reason",
    error instanceof CertifiedProviderError &&
      error.message === "Certified provider request failed temporarily.",
    error
  );

  const traces = context.snapshot().traces.filter(
    (trace) => trace.attemptId === "attempt-retry-exhausted"
  );
  check(
    "exhausted retries recorded one trace per physical attempt",
    traces.length === 3 &&
      traces.every((trace) =>
        trace.retryHistory.some((attempt) => attempt.status === "provider_error")
      ),
    traces
  );

  // Each physical attempt's run-events carry a 1-based `attempt` marker so an
  // operator can tell "one call retried twice" from "three separate calls".
  const startedAttemptNumbers = context
    .snapshot()
    .events.filter(
      (event) =>
        event.attemptId === "attempt-retry-exhausted" &&
        event.type === "model_call_started"
    )
    .map((event) => eventDetailAttempt(event.detailsJson))
    .sort((a, b) => a - b);
  check(
    "exhausted retries emit started events numbered 1, 2, 3",
    JSON.stringify(startedAttemptNumbers) === JSON.stringify([1, 2, 3]),
    startedAttemptNumbers
  );
  const failedAttemptNumbers = context
    .snapshot()
    .events.filter(
      (event) =>
        event.attemptId === "attempt-retry-exhausted" &&
        event.type === "model_call_failed"
    )
    .map((event) => eventDetailAttempt(event.detailsJson))
    .sort((a, b) => a - b);
  check(
    "exhausted retries emit failed events numbered 1, 2, 3",
    JSON.stringify(failedAttemptNumbers) === JSON.stringify([1, 2, 3]),
    failedAttemptNumbers
  );
}

// ---------------------------------------------------------------------------
// Behavior: already-aborted signal throws before any invocation (0 calls)
// ---------------------------------------------------------------------------

{
  let calls = 0;
  async function* neverCalled(): AsyncIterable<StreamChunk> {
    calls++;
    yield { type: "token", content: "{}" };
    yield { type: "done" };
  }

  const controller = new AbortController();
  controller.abort();
  const context = makeTestContext();
  await expectReject(
    "already-aborted signal throws an abort error before any invocation",
    () =>
      callCertifiedModel({
        model,
        system: "s",
        user: "u",
        maxTokens: 128,
        temperature: 0,
        context,
        caseId: context.caseIds[0],
        attemptId: "attempt-retry-aborted",
        participantId: "p",
        streamChat: () => neverCalled(),
        retryDelaysMs: [0, 0],
        signal: controller.signal,
      }),
    (err) => err instanceof Error && /abort/i.test(err.message)
  );
  check("already-aborted signal made zero stream invocations", calls === 0, calls);
}

// ---------------------------------------------------------------------------
// Behavior: no lingering timers after an abort fires mid-sleep (retry sleep
// is cancelled, not merely ignored)
// ---------------------------------------------------------------------------

{
  let calls = 0;
  async function* alwaysTransient(): AsyncIterable<StreamChunk> {
    calls++;
    throw new Error("Service unavailable: 503");
    yield { type: "token", content: "" };
  }

  const controller = new AbortController();
  const context = makeTestContext();
  const pending = callCertifiedModel({
    model,
    system: "s",
    user: "u",
    maxTokens: 128,
    temperature: 0,
    context,
    caseId: context.caseIds[0],
    attemptId: "attempt-retry-abort-mid-sleep",
    participantId: "p",
    streamChat: () => alwaysTransient(),
    retryDelaysMs: [10_000], // long enough that the test would hang if abort didn't win
    signal: controller.signal,
  });
  // Let the first attempt fail and enter the retry sleep, then abort.
  await new Promise((resolve) => setTimeout(resolve, 20));
  controller.abort();
  await expectReject(
    "abort mid-retry-sleep wins over the pending backoff timer",
    () => pending,
    (err) => err instanceof Error && /abort/i.test(err.message)
  );
  check("abort mid-retry-sleep made exactly 1 stream invocation", calls === 1, calls);
}

if (failures === 0) {
  console.log("PASS");
} else {
  console.log(`FAIL ${failures} check(s) failed`);
}

process.exit(failures === 0 ? 0 : 1);
