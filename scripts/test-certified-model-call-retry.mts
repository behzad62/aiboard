/* Retry behavior for certified model calls (run: npx tsx scripts/test-certified-model-call-retry.mts) */
import { __resetBenchmarkStoreForTests } from "../lib/benchmark/store";
import { createCertifiedRunContext } from "../lib/benchmark/certified/run-persistence";
import {
  callCertifiedModel,
  CertifiedProviderError,
} from "../lib/benchmark/certified/model-call";
import { classifyProviderFailure } from "../lib/benchmark/certified/classify-provider-failure";
import type { SelectedModel, StreamChunk } from "../lib/providers/base";
import type { PersistentCertifiedRunContext } from "../lib/benchmark/certified/run-context";

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
    retryDelaysMs: [0, 0], // near-instant retries (jitter only)
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
      err.message === "Your prepayment credits are depleted."
  );
  check("fatal error made exactly 1 stream invocation", calls === 1, calls);
  check(
    "fatal error preserves the original message text",
    error instanceof CertifiedProviderError &&
      error.message === "Your prepayment credits are depleted.",
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
    "exhausted retries surface the last transient error's message",
    error instanceof CertifiedProviderError &&
      error.message === "ChatGPT request failed: 503",
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
