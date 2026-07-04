import { estimatedUsdForTokens } from "@/lib/client/build-usage";
import {
  CUSTOM_PROVIDER_ID,
  getDecryptedApiKey,
  getCustomModelByFullId,
  getProvider,
  getProviderBaseURL,
  streamCustomChat,
} from "@/lib/client/providers";
import { getUserSettings } from "@/lib/client/store";
import { estimateModelCallUsage } from "@/lib/client/token-usage";
import { getModelPricing, type ModelPricing } from "@/lib/providers/pricing";
import {
  formatModelId,
  parseModelId,
  type ChatMessage,
  type ChatParams,
  type SelectedModel,
  type StreamChunk,
  type StructuredOutputFormat,
} from "@/lib/providers/base";
import type { ReasoningEffort } from "@/lib/db/schema";
import type { CertifiedRunContext } from "./run-context";
import { CertifiedBudgetExceededError } from "./budget";
import { buildCertifiedMessages, certifiedPromptText } from "./prompting";
import {
  createCertifiedModelCallTrace,
  recordCertifiedModelCallTrace,
} from "./trace-recorder";
import {
  classifyProviderFailure,
  type ProviderFailureClass,
} from "./classify-provider-failure";

const DEFAULT_CERTIFIED_MODEL_CALL_TIMEOUT_MS = 120_000;

/**
 * Default backoff policy for transient provider failures: one retry per entry,
 * so `[2_000, 8_000]` means up to 2 retries (3 attempts total). Exported so
 * downstream callers reference the canonical policy instead of hardcoding the
 * delays in a second place.
 */
export const DEFAULT_RETRY_DELAYS_MS: number[] = [2_000, 8_000];

/**
 * Thrown by `callCertifiedModelOnce` for every non-budget failure, tagged
 * with a classification so the retry loop in `callCertifiedModel` (and
 * downstream containment logic in the GameIQ runner) can tell a transient
 * transport blip from a fatal account/config problem without re-parsing the
 * message string. The message itself is preserved byte-for-byte from the
 * original error so `statusForRunError` (run-engine.ts) and
 * `isProviderFailureMessage` keep matching on the same text they always have.
 */
export class CertifiedProviderError extends Error {
  readonly classification: ProviderFailureClass;
  constructor(message: string, classification: ProviderFailureClass) {
    super(message);
    this.name = "CertifiedProviderError";
    this.classification = classification;
  }
}

export interface CertifiedModelStreamInput {
  providerId: string;
  params: ChatParams;
}

export type CertifiedModelStream = (
  input: CertifiedModelStreamInput
) => AsyncIterable<StreamChunk>;

export interface CallCertifiedModelInput {
  model: SelectedModel;
  system: string;
  user: string;
  /**
   * Optional full multi-turn conversation. When set it is sent verbatim instead
   * of the derived [system, user] pair (still one model call). Used by the
   * Fireworks memory recall episodes; all other callers omit it and are
   * unaffected.
   */
  messages?: ChatMessage[];
  structuredOutput?: StructuredOutputFormat;
  maxTokens: number;
  temperature: 0;
  reasoningEffort?: ReasoningEffort;
  context: CertifiedRunContext;
  participantId: string;
  caseId?: string;
  attemptId?: string;
  // The GameIQ scenario id this call answers, threaded onto the recorded
  // trace so trace consumers can map by id instead of positional order.
  scenarioId?: string;
  pricing?: Pick<ModelPricing, "inputUsdPer1M" | "outputUsdPer1M"> | null;
  apiKey?: string;
  baseURL?: string;
  streamChat?: CertifiedModelStream;
  allowInvalidStructuredOutput?: boolean;
  signal?: AbortSignal;
  /**
   * Base delays (ms, before jitter) between retry attempts for transient
   * provider failures. One retry is made per array entry, so `[2_000, 8_000]`
   * (the default) means up to 2 retries / 3 attempts total. Pass `[]` to
   * disable retries entirely. `[0, 0]` still retries but is near-instant: only
   * the 0-499ms jitter is slept, never the base delay — tests use it to
   * exercise the retry path without waiting out the real backoff.
   */
  retryDelaysMs?: number[];
  /**
   * 1-based attempt number for this physical call, set by the retry loop in
   * `callCertifiedModel` so each attempt's run-events carry an `attempt`
   * marker (an operator can then tell "one call retried twice" apart from
   * "three separate calls"). Absent → treated as 1.
   */
  attemptNumber?: number;
}

export interface CertifiedModelCallResult {
  rawResponse: string;
  parsedJson?: unknown;
  traceId: string;
  latencyMs: number;
  inputTokens: number;
  outputTokens: number;
  estimatedUsd: number | null;
  /**
   * "reported" when the provider surfaced real billed token counts for this
   * call; "estimated" when we fell back to the chars/4 approximation.
   */
  usageSource: "reported" | "estimated";
}

/**
 * Runs a single certified model call attempt: builds params, streams the
 * response, parses/traces the result. Every call — success or failure —
 * records its own trace/event, which is what makes each retry attempt in
 * `callCertifiedModel` individually auditable in the trace store.
 */
async function callCertifiedModelOnce(
  input: CallCertifiedModelInput
): Promise<CertifiedModelCallResult> {
  throwIfCertifiedRunAborted(input.signal);
  const startedAt = new Date().toISOString();
  const startedMs = Date.now();
  const messages = buildCertifiedMessages(input);
  const providerId = input.model.providerId;
  const providerModel = providerModelId(input.model);
  const fullModelId = fullModelIdForPricing(input.model);
  const customModel =
    providerId === CUSTOM_PROVIDER_ID ? getCustomModelByFullId(fullModelId) : null;
  if (providerId === CUSTOM_PROVIDER_ID && !customModel) {
    throw new Error(`Unknown custom certified model: ${fullModelId}.`);
  }
  const apiKey =
    input.apiKey ??
    (customModel ? customModel.apiKey || "not-needed" : getDecryptedApiKey(providerId)) ??
    "";
  const streamChat =
    input.streamChat ??
    (customModel
      ? (async function* customCertifiedModelStream({ params }) {
          yield* streamCustomChat(customModel, params);
        } satisfies CertifiedModelStream)
      : defaultCertifiedModelStream);
  if (!input.streamChat && !customModel && !apiKey) {
    throw new Error(`No API key configured for certified provider ${providerId}.`);
  }

  const params: ChatParams = {
    apiKey,
    model: customModel?.model ?? providerModel,
    messages,
    maxTokens: input.maxTokens,
    temperature: input.temperature,
    reasoningEffort: input.reasoningEffort,
    structuredOutput: input.structuredOutput,
    baseURL:
      input.baseURL ??
      customModel?.baseURL ??
      (input.streamChat ? undefined : getProviderBaseURL(providerId)),
    capabilities: customModel?.capabilities,
    contextProfile: input.model.contextProfile,
  };
  const preflightUsage = estimateModelCallUsage({
    messages,
    output: "",
    maxTokens: input.maxTokens,
  });
  try {
    input.context.reserveModelCall?.({ inputTokens: preflightUsage.inputTokens });
    assertProjectedUsdWithinBudget(input, preflightUsage, "model-call preflight");
  } catch (error) {
    await recordCertifiedBudgetEvent(input, error);
    throw error;
  }
  await recordCertifiedModelCallEvent(input, {
    type: "model_call_started",
    phase: "model-call",
    message: `Certified model call started for ${fullModelId}.`,
    details: {
      attempt: input.attemptNumber ?? 1,
      maxTokens: input.maxTokens,
      timeoutMs: certifiedModelCallTimeoutMs(input),
      schemaMode: input.structuredOutput ? "structured" : "text",
    },
  });
  let rawResponse = "";
  let parsePhase = false;
  // Provider-reported billed token counts, captured from the "usage" chunk when
  // the provider emits one. Preferred over the chars/4 estimate below.
  let reportedInputTokens: number | undefined;
  let reportedOutputTokens: number | undefined;
  const wallClockBudgetMs = input.context.modelBudget.maxWallClockMs;
  const runStartedMs = new Date(input.context.startedAt).getTime();

  try {
    for await (const chunk of withCertifiedModelCallTimeout(
      streamChat({ providerId, params }),
      certifiedModelCallTimeoutMs(input),
      input.signal
    )) {
      throwIfCertifiedRunAborted(input.signal);
      if (
        typeof wallClockBudgetMs === "number" &&
        Number.isFinite(runStartedMs) &&
        Date.now() - runStartedMs > wallClockBudgetMs
      ) {
        throw new CertifiedBudgetExceededError(
          `Certified budget exceeded during model-call streaming: wall-clock time exceeded maxWallClockMs ${wallClockBudgetMs}.`
        );
      }
      if (chunk.type === "token" && chunk.content) {
        rawResponse += chunk.content;
        try {
          assertProjectedUsdWithinBudget(
            input,
            estimateModelCallUsage({
              messages,
              output: rawResponse,
              maxTokens: input.maxTokens,
            }),
            "model-call streaming"
          );
        } catch (error) {
          await recordCertifiedBudgetEvent(input, error);
          throw error;
        }
      } else if (chunk.type === "usage" && chunk.usage) {
        if (typeof chunk.usage.inputTokens === "number") {
          reportedInputTokens = chunk.usage.inputTokens;
        }
        if (typeof chunk.usage.outputTokens === "number") {
          reportedOutputTokens = chunk.usage.outputTokens;
        }
      } else if (chunk.type === "error") {
        throw new Error(chunk.error ?? "Certified provider returned an error.");
      }
    }

    if (rawResponse.trim().length === 0) {
      throw new Error("Certified provider returned an empty response.");
    }

    parsePhase = true;
    const parsed = parseCertifiedStructuredOutput(rawResponse, {
      enabled: Boolean(input.structuredOutput),
      allowInvalid: Boolean(input.allowInvalidStructuredOutput),
    });
    const usage = resolveModelCallUsage({
      messages,
      output: rawResponse,
      maxTokens: input.maxTokens,
      reportedInputTokens,
      reportedOutputTokens,
    });
    const estimatedUsd = estimateCertifiedModelUsd({
      fullModelId,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      pricing: input.pricing,
    });
    const latencyMs = Math.max(0, Date.now() - startedMs);
    const trace = createCertifiedModelCallTrace({
      modelId: fullModelId,
      providerId,
      participantId: input.participantId,
      runId: input.context.runId,
      caseId: input.caseId,
      attemptId: input.attemptId,
      scenarioId: input.scenarioId,
      reasoningEffort: input.reasoningEffort,
      schemaMode: input.structuredOutput ? "structured" : "text",
      promptText: certifiedPromptText(messages),
      startedAt,
      completedAt: new Date().toISOString(),
      latencyMs,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      usageSource: usage.usageSource,
      estimatedUsd,
      rawResponse,
      parsedResponseJson:
        parsed.value === undefined ? undefined : JSON.stringify(parsed.value),
      finalStatus: parsed.error ? "parse_error" : "parsed",
      error: parsed.error,
    });
    const traceId = await recordCertifiedModelCallTrace(input.context, trace);
    await recordCertifiedModelCallEvent(input, {
      type: "model_call_completed",
      phase: "model-call",
      message: `Certified model call completed for ${fullModelId}.`,
      details: {
        attempt: input.attemptNumber ?? 1,
        traceId,
        latencyMs,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        estimatedUsd,
      },
    });
    try {
      input.context.recordModelCallUsage?.({
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        estimatedUsd,
      });
    } catch (error) {
      await recordCertifiedBudgetEvent(input, error);
      throw error;
    }
    return {
      rawResponse,
      parsedJson: parsed.value,
      traceId,
      latencyMs,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      estimatedUsd,
      usageSource: usage.usageSource,
    };
  } catch (error) {
    if (error instanceof CertifiedBudgetExceededError) {
      throw error;
    }
    const message = errorMessage(error);
    const usage = resolveModelCallUsage({
      messages,
      output: rawResponse,
      maxTokens: input.maxTokens,
      reportedInputTokens,
      reportedOutputTokens,
    });
    const latencyMs = Math.max(0, Date.now() - startedMs);
    const trace = createCertifiedModelCallTrace({
      modelId: fullModelId,
      providerId,
      participantId: input.participantId,
      runId: input.context.runId,
      caseId: input.caseId,
      attemptId: input.attemptId,
      scenarioId: input.scenarioId,
      reasoningEffort: input.reasoningEffort,
      schemaMode: input.structuredOutput ? "structured" : "text",
      promptText: certifiedPromptText(messages),
      startedAt,
      completedAt: new Date().toISOString(),
      latencyMs,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      usageSource: usage.usageSource,
      estimatedUsd: estimateCertifiedModelUsd({
        fullModelId,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        pricing: input.pricing,
      }),
      rawResponse,
      finalStatus: parsePhase ? "parse_error" : "provider_error",
      error: message,
    });
    const traceId = await recordCertifiedModelCallTrace(input.context, trace);
    await recordCertifiedModelCallEvent(input, {
      type: "model_call_failed",
      phase: parsePhase ? "model-parse" : "model-call",
      message,
      details: {
        attempt: input.attemptNumber ?? 1,
        traceId,
        latencyMs,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        estimatedUsd: trace.estimatedUsd,
      },
    });
    try {
      input.context.recordModelCallUsage?.({
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        estimatedUsd: trace.estimatedUsd,
      });
    } catch (recordError) {
      if (recordError instanceof CertifiedBudgetExceededError) {
        await recordCertifiedBudgetEvent(input, recordError);
        throw recordError;
      }
      // Otherwise preserve the provider/parser error that caused the failed model call.
    }
    // Wrap in a classified, typed error for the retry loop above. The
    // message is preserved byte-for-byte (via `message`, computed above from
    // the original error) so message-text consumers — `statusForRunError` in
    // run-engine.ts and `isProviderFailureMessage` — keep matching exactly
    // what they always have.
    throw new CertifiedProviderError(message, classifyProviderFailure(message));
  }
}

/**
 * Runs a certified model call, retrying transient provider failures (5xx,
 * timeouts, empty responses, rate limits, network blips) with backoff before
 * giving up. Fatal failures (quota/billing, invalid key, unauthorized) and
 * everything else (parse errors, budget errors, aborts) are never retried —
 * they rethrow from the first attempt.
 *
 * Each physical attempt runs through `callCertifiedModelOnce`, which records
 * its own trace/event; a retried call therefore leaves an auditable trail of
 * every attempt (failed + eventual success) in the trace store, not just the
 * final outcome. Each attempt's run-events carry a 1-based `attempt` marker
 * (in `details`) so the retried attempts are distinguishable in the event log.
 * Consumers that map traces positionally to scenarios (audit/replay scripts)
 * must be updated in Task B4 to key by scenarioId instead of assuming one
 * trace per scenario.
 */
export async function callCertifiedModel(
  input: CallCertifiedModelInput
): Promise<CertifiedModelCallResult> {
  const delays = input.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
  let lastError: unknown;
  for (let attempt = 0; attempt <= delays.length; attempt++) {
    if (attempt > 0) {
      const jitterMs = Math.floor(Math.random() * 500);
      await sleepUnlessAborted(delays[attempt - 1] + jitterMs, input.signal);
    }
    throwIfCertifiedRunAborted(input.signal);
    try {
      return await callCertifiedModelOnce({ ...input, attemptNumber: attempt + 1 });
    } catch (error) {
      lastError = error;
      if (error instanceof CertifiedBudgetExceededError) throw error;
      const transient =
        error instanceof CertifiedProviderError && error.classification === "transient";
      if (!transient) throw error;
      // transient: fall through and loop for the next attempt.
    }
  }
  throw lastError;
}

/**
 * Sleeps for `ms`, but rejects immediately (with the same abort error
 * `throwIfCertifiedRunAborted` would throw) if `signal` fires first — abort
 * always wins over a pending retry sleep. The pending timer is always
 * cleared so an aborted run never leaves a dangling timer behind.
 */
async function sleepUnlessAborted(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) {
    throwIfCertifiedRunAborted(signal);
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortedError(signal as AbortSignal));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    if (signal) {
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}

async function recordCertifiedBudgetEvent(
  input: CallCertifiedModelInput,
  error: unknown
): Promise<void> {
  const message = errorMessage(error);
  await input.context.recordEvent({
    id: `${input.context.runId}:${input.attemptId ?? "attempt"}:budget:${Date.now()}:${Math.random().toString(16).slice(2, 8)}`,
    attemptId: input.attemptId ?? `${input.context.runId}:budget`,
    caseId: input.caseId ?? input.context.caseIds[0] ?? "unknown",
    type: "run_blocked",
    phase: "budget",
    at: new Date().toISOString(),
    message,
    modelId: fullModelIdForPricing(input.model),
    providerId: input.model.providerId,
    detailsJson: JSON.stringify({
      budget: input.context.modelBudget,
      snapshot: input.context.budgetSnapshot?.() ?? null,
    }),
  });
}

async function recordCertifiedModelCallEvent(
  input: CallCertifiedModelInput,
  event: {
    type: "model_call_started" | "model_call_completed" | "model_call_failed";
    phase: string;
    message: string;
    details?: Record<string, unknown>;
  }
): Promise<void> {
  await input.context.recordEvent({
    id: `${input.context.runId}:${input.attemptId ?? "attempt"}:${event.type}:${Date.now()}:${Math.random().toString(16).slice(2, 8)}`,
    attemptId: input.attemptId ?? `${input.context.runId}:attempt`,
    caseId: input.caseId ?? input.context.caseIds[0] ?? "unknown",
    type: event.type,
    phase: event.phase,
    at: new Date().toISOString(),
    message: event.message,
    modelId: fullModelIdForPricing(input.model),
    providerId: input.model.providerId,
    ...(event.details ? { detailsJson: JSON.stringify(event.details) } : {}),
  });
}

async function* defaultCertifiedModelStream(
  input: CertifiedModelStreamInput
): AsyncIterable<StreamChunk> {
  const provider = getProvider(input.providerId);
  if (!provider) throw new Error(`Unknown certified provider: ${input.providerId}`);
  yield* provider.streamChat(input.params);
}

async function* withCertifiedModelCallTimeout<T>(
  iterable: AsyncIterable<T>,
  timeoutMs: number,
  signal?: AbortSignal
): AsyncIterable<T> {
  const iterator = iterable[Symbol.asyncIterator]();
  try {
    for (;;) {
      throwIfCertifiedRunAborted(signal);
      const next = await withTimeout(
        iterator.next(),
        timeoutMs,
        `Certified model call timed out after ${timeoutMs}ms.`,
        signal
      );
      if (next.done) return;
      yield next.value;
    }
  } finally {
    void iterator.return?.().catch(() => undefined);
  }
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
  signal?: AbortSignal
): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  let abortListener: (() => void) | undefined;
  try {
    throwIfCertifiedRunAborted(signal);
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
      new Promise<T>((_, reject) => {
        if (!signal) return;
        abortListener = () => reject(abortedError(signal));
        signal.addEventListener("abort", abortListener, { once: true });
      }),
    ]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
    if (signal && abortListener) {
      signal.removeEventListener("abort", abortListener);
    }
  }
}

function certifiedModelCallTimeoutMs(input: CallCertifiedModelInput): number {
  const configured = input.context.modelBudget.maxModelCallMs;
  return typeof configured === "number" && Number.isFinite(configured) && configured > 0
    ? Math.round(configured)
    : DEFAULT_CERTIFIED_MODEL_CALL_TIMEOUT_MS;
}

function providerModelId(model: SelectedModel): string {
  const parsed = parseModelId(model.modelId);
  if (parsed.providerId === model.providerId && parsed.model) return parsed.model;
  return model.modelId;
}

function fullModelIdForPricing(model: SelectedModel): string {
  const parsed = parseModelId(model.modelId);
  if (parsed.providerId === model.providerId && parsed.model) return model.modelId;
  return formatModelId(model.providerId, model.modelId);
}

function parseStructuredJson(rawResponse: string): unknown {
  try {
    return JSON.parse(rawResponse.trim());
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Certified structured response was not valid JSON: ${message}`);
  }
}

function parseCertifiedStructuredOutput(
  rawResponse: string,
  options: {
    enabled: boolean;
    allowInvalid: boolean;
  }
): {
  value?: unknown;
  error?: string;
} {
  if (!options.enabled) return {};
  try {
    return { value: parseStructuredJson(rawResponse) };
  } catch (error) {
    if (!options.allowInvalid) throw error;
    return { error: errorMessage(error) };
  }
}

/**
 * Resolve the token counts to record for a model call, preferring the
 * provider's real billed counts (from the "usage" stream chunk) and falling
 * back to the chars/4 estimate per side. `usageSource` is "reported" when at
 * least one side was provider-reported, otherwise "estimated".
 */
function resolveModelCallUsage(input: {
  messages: ChatMessage[];
  output: string;
  maxTokens: number;
  reportedInputTokens?: number;
  reportedOutputTokens?: number;
}): { inputTokens: number; outputTokens: number; usageSource: "reported" | "estimated" } {
  const estimate = estimateModelCallUsage({
    messages: input.messages,
    output: input.output,
    maxTokens: input.maxTokens,
  });
  const inputReported =
    typeof input.reportedInputTokens === "number" &&
    Number.isFinite(input.reportedInputTokens) &&
    input.reportedInputTokens >= 0;
  const outputReported =
    typeof input.reportedOutputTokens === "number" &&
    Number.isFinite(input.reportedOutputTokens) &&
    input.reportedOutputTokens >= 0;
  return {
    inputTokens: inputReported
      ? (input.reportedInputTokens as number)
      : estimate.inputTokens,
    outputTokens: outputReported
      ? (input.reportedOutputTokens as number)
      : estimate.outputTokens,
    usageSource: inputReported || outputReported ? "reported" : "estimated",
  };
}

function estimateCertifiedModelUsd(input: {
  fullModelId: string;
  inputTokens: number;
  outputTokens: number;
  pricing?: Pick<ModelPricing, "inputUsdPer1M" | "outputUsdPer1M"> | null;
}): number | null {
  const pricing =
    input.pricing === undefined
      ? getModelPricing(
          input.fullModelId,
          getUserSettings().modelPricingOverrides
        )
      : input.pricing;
  if (!pricing) return null;
  return estimatedUsdForTokens({
    inputTokens: input.inputTokens,
    outputTokens: input.outputTokens,
    pricing,
  });
}

function assertProjectedUsdWithinBudget(
  input: CallCertifiedModelInput,
  usage: { inputTokens: number; outputTokens: number },
  phase: string
): void {
  const maxUsd = input.context.modelBudget.maxUsd;
  if (typeof maxUsd !== "number") return;
  const estimatedUsd = estimateCertifiedModelUsd({
    fullModelId: fullModelIdForPricing(input.model),
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    pricing: input.pricing,
  });
  if (typeof estimatedUsd !== "number" || !Number.isFinite(estimatedUsd)) return;
  const priorUsd = input.context.budgetSnapshot?.().estimatedUsd ?? 0;
  const projectedUsd = priorUsd + Math.max(0, estimatedUsd);
  if (projectedUsd > maxUsd) {
    throw new CertifiedBudgetExceededError(
      `Certified budget exceeded during ${phase}: projected USD ${projectedUsd.toFixed(6)} exceeded maxUsd ${maxUsd}.`
    );
  }
}

export function throwIfCertifiedRunAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw abortedError(signal);
}

function abortedError(signal: AbortSignal): Error {
  const reason = signal.reason;
  if (reason instanceof Error) return reason;
  const suffix =
    typeof reason === "string" && reason.trim() ? ` ${reason.trim()}` : "";
  return new Error(`Certified run aborted by user.${suffix}`);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
