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
import {
  estimateModelCallUsage,
  mergeStreamUsage,
  resolveModelCallUsage,
} from "@/lib/client/token-usage";
import { getModelPricing, type ModelPricing } from "@/lib/providers/pricing";
import {
  formatModelId,
  parseModelId,
  type ChatMessage,
  type ChatParams,
  type CertifiedProviderErrorMetadata,
  type SelectedModel,
  type StreamUsage,
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
import {
  CERTIFIED_RETRY_DELAYS_MS,
  DEFAULT_CERTIFIED_RETRY_RUNTIME,
  certifiedRetryDelayMs,
  type CertifiedRetryRuntime,
} from "./retry-policy";

const DEFAULT_CERTIFIED_MODEL_CALL_TIMEOUT_MS = 120_000;
const CERTIFIED_ITERATOR_TEARDOWN_TIMEOUT_MS = 5_000;

/**
 * Default backoff policy for transient provider failures. Exported under the
 * legacy name for callers that disable or shorten delays in deterministic
 * tests; production uses the canonical five-delay policy.
 */
export const DEFAULT_RETRY_DELAYS_MS: number[] = [...CERTIFIED_RETRY_DELAYS_MS];

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
  /**
   * Trace id + billed usage of the physical attempt that failed. A retried
   * attempt still costs real tokens, so `callCertifiedModel` carries these
   * forward on the eventual success (as `retryAttempts`) — without them a
   * caller that sums the returned result under-reports both call count and
   * cost by exactly the attempts that were retried away.
   */
  readonly attemptUsage?: CertifiedModelCallAttemptUsage;
  /**
   * Every physical attempt billed for this logical call when recovery is
   * exhausted. Populated by the retry coordinator before the terminal error
   * crosses into a track runner.
   */
  retryAttempts?: CertifiedModelCallAttemptUsage[];
  readonly statusCode?: number;
  readonly code?: string;
  readonly retryAfterMs?: number;
  constructor(
    message: string,
    classification: ProviderFailureClass,
    attemptUsage?: CertifiedModelCallAttemptUsage,
    metadata?: CertifiedProviderErrorMetadata
  ) {
    super(message);
    this.name = "CertifiedProviderError";
    this.classification = classification;
    this.attemptUsage = attemptUsage;
    this.statusCode = metadata?.statusCode;
    this.code = metadata?.code;
    this.retryAfterMs = metadata?.retryAfterMs;
  }
}

/**
 * One physical model call's traced cost. Reported for the failed attempts of
 * a retried call so callers can account for every call the provider billed,
 * not only the attempt that returned an answer.
 */
export interface CertifiedModelCallAttemptUsage {
  traceId: string;
  latencyMs: number;
  inputTokens: number;
  outputTokens: number;
  estimatedUsd: number | null;
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
   * provider failures. One retry is made per array entry. Pass `[]` to
   * disable retries entirely. Tests may pass zeroes with an injected runtime
   * to exercise retry control flow without real waiting.
   */
  retryDelaysMs?: number[];
  retryRuntime?: CertifiedRetryRuntime;
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
  usageSource: "reported" | "partial" | "estimated";
  reasoningTokens?: number;
  cachedInputTokens?: number;
  cacheWriteInputTokens?: number;
  inputAudioTokens?: number;
  outputAudioTokens?: number;
  providerCost?: number;
  providerCostUnit?: "usd" | "credits" | "unknown";
  /**
   * The transient attempts that failed before this one succeeded, oldest
   * first — empty when the call succeeded on its first try. The provider
   * billed these, so a caller totalling model calls or cost must add them to
   * the fields above rather than counting this result as one call.
   */
  retryAttempts?: CertifiedModelCallAttemptUsage[];
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
  let reportedUsage: StreamUsage | undefined;
  const wallClockBudgetMs = input.context.modelBudget.maxWallClockMs;
  const runStartedMs = new Date(input.context.startedAt).getTime();
  const attemptController = new AbortController();
  let attemptAbortSource: "parent" | "timeout" | "failure" | undefined;
  const abortAttempt = (
    source: "parent" | "timeout" | "failure",
    reason: unknown
  ): void => {
    if (attemptController.signal.aborted) return;
    attemptAbortSource = source;
    attemptController.abort(reason);
  };
  const abortAttemptFromParent = input.signal
    ? () => abortAttempt("parent", input.signal?.reason)
    : undefined;
  if (input.signal?.aborted) {
    abortAttemptFromParent?.();
  } else if (input.signal && abortAttemptFromParent) {
    input.signal.addEventListener("abort", abortAttemptFromParent, { once: true });
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
    signal: attemptController.signal,
    contextProfile: input.model.contextProfile,
    disableAutomaticRetries: true,
  };
  let iterator: AsyncIterator<StreamChunk> | undefined;
  let attemptSucceeded = false;
  let surfacedError: unknown;

  try {
    iterator = streamChat({ providerId, params })[Symbol.asyncIterator]();
    for (;;) {
      throwIfCertifiedRunAborted(input.signal);
      const next = await withTimeout(
        iterator.next(),
        certifiedModelCallTimeoutMs(input),
        `Certified model call timed out after ${certifiedModelCallTimeoutMs(input)}ms.`,
        input.signal,
        (timeoutError) => abortAttempt("timeout", timeoutError)
      );
      if (next.done) break;
      const chunk = next.value;
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
        reportedUsage = mergeStreamUsage(reportedUsage, chunk.usage);
      } else if (chunk.type === "tool_call" && chunk.toolCall) {
        // A provider-native tool call is a substantive completion even when
        // the provider emits no token chunks. Preserve it as deterministic
        // JSON so benchmark parsers/auditors can consume the physical result
        // without misclassifying it as an empty transient response.
        rawResponse += JSON.stringify(chunk.toolCall);
      } else if (chunk.type === "error") {
        throw new CertifiedStreamError(
          chunk.error ?? "Certified provider returned an error.",
          chunk.errorMetadata
        );
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
      reportedUsage,
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
      totalTokens: usage.totalTokens,
      usageSource: usage.usageSource,
      reasoningTokens: usage.reasoningTokens,
      cachedInputTokens: usage.cachedInputTokens,
      cacheWriteInputTokens: usage.cacheWriteInputTokens,
      inputAudioTokens: usage.inputAudioTokens,
      outputAudioTokens: usage.outputAudioTokens,
      providerCost: usage.providerCost,
      providerCostUnit: usage.providerCostUnit,
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
    attemptSucceeded = true;
    return {
      rawResponse,
      parsedJson: parsed.value,
      traceId,
      latencyMs,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      estimatedUsd,
      usageSource: usage.usageSource,
      reasoningTokens: usage.reasoningTokens,
      cachedInputTokens: usage.cachedInputTokens,
      cacheWriteInputTokens: usage.cacheWriteInputTokens,
      inputAudioTokens: usage.inputAudioTokens,
      outputAudioTokens: usage.outputAudioTokens,
      providerCost: usage.providerCost,
      providerCostUnit: usage.providerCostUnit,
    };
  } catch (error) {
    const effectiveError =
      attemptAbortSource === "parent" && input.signal?.aborted
        ? abortedError(input.signal)
        : error;
    surfacedError = effectiveError;
    if (
      (attemptAbortSource === "parent" && input.signal?.aborted) ||
      effectiveError instanceof CertifiedBudgetExceededError
    ) {
      throw effectiveError;
    }
    const message = errorMessage(effectiveError);
    const usage = resolveModelCallUsage({
      messages,
      output: rawResponse,
      maxTokens: input.maxTokens,
      reportedUsage,
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
      totalTokens: usage.totalTokens,
      usageSource: usage.usageSource,
      reasoningTokens: usage.reasoningTokens,
      cachedInputTokens: usage.cachedInputTokens,
      cacheWriteInputTokens: usage.cacheWriteInputTokens,
      inputAudioTokens: usage.inputAudioTokens,
      outputAudioTokens: usage.outputAudioTokens,
      providerCost: usage.providerCost,
      providerCostUnit: usage.providerCostUnit,
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
        surfacedError = recordError;
        throw recordError;
      }
      // Otherwise preserve the provider/parser error that caused the failed model call.
    }
    // Wrap in a classified, typed error for the retry loop above. The
    // message is preserved byte-for-byte (via `message`, computed above from
    // the original error) so message-text consumers — `statusForRunError` in
    // run-engine.ts and `isProviderFailureMessage` — keep matching exactly
    // what they always have.
    const errorMetadata = certifiedProviderErrorMetadata(error);
    const providerError = new CertifiedProviderError(
      message,
      classifyProviderFailure(message, errorMetadata),
      {
        traceId,
        latencyMs,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        estimatedUsd: trace.estimatedUsd ?? null,
      },
      errorMetadata
    );
    surfacedError = providerError;
    throw providerError;
  } finally {
    try {
      if (!attemptSucceeded) {
        const winningError =
          surfacedError ?? new Error("Certified provider attempt exited without success.");
        abortAttempt("failure", winningError);
        const teardownError = iterator
          ? await closeIteratorBeforeRetry(iterator, winningError)
          : undefined;
        const parentCancellationWon =
          attemptAbortSource === "parent" && input.signal?.aborted === true;
        if (
          teardownError &&
          !parentCancellationWon &&
          !(winningError instanceof CertifiedBudgetExceededError)
        ) {
          throw teardownError;
        }
      }
    } finally {
      if (input.signal && abortAttemptFromParent) {
        input.signal.removeEventListener("abort", abortAttemptFromParent);
      }
    }
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
  const delays = (input.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS).slice(
    0,
    CERTIFIED_RETRY_DELAYS_MS.length
  );
  const runtime = input.retryRuntime ?? DEFAULT_CERTIFIED_RETRY_RUNTIME;
  const retryAttempts: CertifiedModelCallAttemptUsage[] = [];
  let lastError: unknown;
  for (let attempt = 0; attempt <= delays.length; attempt++) {
    if (attempt > 0) {
      const transientError = lastError as CertifiedProviderError;
      const delayMs = certifiedRetryDelayMs(
        delays[attempt - 1]!,
        transientError.retryAfterMs,
        runtime.random()
      );
      try {
        assertRetryFitsWallClock(input, runtime, delayMs);
      } catch (error) {
        await recordCertifiedBudgetEvent(input, error);
        throw error;
      }
      throwIfCertifiedRunAborted(input.signal);
      input.context.reportRetry?.({
        providerId: input.model.providerId,
        modelId: input.model.modelId,
        participantId: input.participantId,
        resultSetId: input.context.resultSetIdForAttempt(input.attemptId ?? ""),
        retry: attempt,
        maxRetries: 5,
        delayMs,
        reason: sanitizedRetryReason(transientError),
      });
      await runtime.sleep(delayMs, input.signal);
      throwIfCertifiedRunAborted(input.signal);
      try {
        assertRetryFitsWallClock(input, runtime, 0);
      } catch (error) {
        await recordCertifiedBudgetEvent(input, error);
        throw error;
      }
    }
    throwIfCertifiedRunAborted(input.signal);
    try {
      const result = await callCertifiedModelOnce({
        ...input,
        attemptNumber: attempt + 1,
      });
      return retryAttempts.length > 0 ? { ...result, retryAttempts } : result;
    } catch (error) {
      lastError = error;
      if (error instanceof CertifiedBudgetExceededError) throw error;
      if (!(error instanceof CertifiedProviderError)) throw error;
      // Preserve the complete physical bill even when a later retry changes
      // classification (for example, transient 503 followed by typed 400).
      if (error.attemptUsage) retryAttempts.push(error.attemptUsage);
      error.retryAttempts = [...retryAttempts];
      if (error.classification !== "transient") throw error;
    }
  }
  throw lastError;
}

/** Physical usage expansion keeps failed retries ordered before the success. */
export function expandCertifiedPhysicalUsages(
  call: CertifiedModelCallResult | unknown
): CertifiedModelCallAttemptUsage[] {
  if (typeof call === "object" && call !== null && "classification" in call) {
    const failed = call as {
      retryAttempts?: CertifiedModelCallAttemptUsage[];
      attemptUsage?: CertifiedModelCallAttemptUsage;
    };
    return [
      ...(failed.retryAttempts ??
        (failed.attemptUsage ? [failed.attemptUsage] : [])),
    ];
  }
  if (typeof call !== "object" || call === null || !("rawResponse" in call)) {
    return [];
  }
  const result = call as CertifiedModelCallResult;
  return [
    ...(result.retryAttempts ?? []),
    {
      traceId: result.traceId,
      latencyMs: result.latencyMs,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      estimatedUsd: result.estimatedUsd,
    },
  ];
}

function assertRetryFitsWallClock(
  input: CallCertifiedModelInput,
  runtime: CertifiedRetryRuntime,
  delayMs: number
): void {
  const maxWallClockMs = input.context.modelBudget.maxWallClockMs;
  if (maxWallClockMs == null) return;
  const startedMs = Date.parse(input.context.startedAt);
  if (
    Number.isFinite(startedMs) &&
    runtime.now() - startedMs + delayMs > maxWallClockMs
  ) {
    throw new CertifiedBudgetExceededError(
      `Certified budget exceeded before provider retry: delay ${delayMs}ms cannot fit within maxWallClockMs ${maxWallClockMs}.`
    );
  }
}

function sanitizedRetryReason(error: CertifiedProviderError): string {
  if (error.statusCode) return `Temporary provider failure (HTTP ${error.statusCode})`;
  if (
    error.code &&
    /^[A-Za-z0-9_.-]{1,64}$/.test(error.code) &&
    !/key|token|secret|authorization/i.test(error.code)
  ) {
    return `Temporary provider failure (${error.code})`;
  }
  return "Temporary provider failure";
}

class CertifiedStreamError extends Error {
  constructor(
    message: string,
    readonly metadata?: CertifiedProviderErrorMetadata
  ) {
    super(message);
  }
}

function certifiedProviderErrorMetadata(
  error: unknown
): CertifiedProviderErrorMetadata | undefined {
  if (error instanceof CertifiedStreamError) return error.metadata;
  if (error instanceof CertifiedProviderError) {
    return {
      statusCode: error.statusCode,
      code: error.code,
      retryAfterMs: error.retryAfterMs,
    };
  }
  return undefined;
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

async function closeIteratorBeforeRetry(
  iterator: AsyncIterator<StreamChunk>,
  originalError: unknown
): Promise<CertifiedProviderError | undefined> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  try {
    if (!iterator.return) {
      throw new Error("Certified provider iterator does not expose return().");
    }
    const teardown = iterator.return();
    const timedOut = Symbol("certified-iterator-teardown-timeout");
    const resultOrTimeout = await Promise.race([
      teardown,
      new Promise<typeof timedOut>((resolve) => {
        timeoutId = setTimeout(
          () => resolve(timedOut),
          CERTIFIED_ITERATOR_TEARDOWN_TIMEOUT_MS
        );
      }),
    ]);
    if (resultOrTimeout === timedOut) {
      // The five-second bound still suppresses retry, but it must not turn an
      // unconfirmed physical call into logical idleness. Keep the full run
      // tree pending until the provider's iterator teardown actually settles.
      await teardown;
      throw new Error("Certified provider iterator teardown exceeded its confirmation limit.");
    }
    const result = resultOrTimeout;
    if (result.done !== true) {
      throw new Error("Certified provider iterator return() did not report done.");
    }
    return undefined;
  } catch {
    return new CertifiedProviderError(
      `Certified provider iterator teardown was not confirmed within ${CERTIFIED_ITERATOR_TEARDOWN_TIMEOUT_MS}ms; retry was suppressed to avoid overlapping paid calls.`,
      "other",
      originalError instanceof CertifiedProviderError
        ? originalError.attemptUsage
        : undefined
    );
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
  signal?: AbortSignal,
  onTimeout?: (error: Error) => void
): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  let abortListener: (() => void) | undefined;
  try {
    throwIfCertifiedRunAborted(signal);
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timeoutId = setTimeout(() => {
          const timeoutError = new Error(message);
          reject(timeoutError);
          onTimeout?.(timeoutError);
        }, timeoutMs);
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

function abortedError(signal: AbortSignal): unknown {
  if (signal.reason !== undefined) return signal.reason;
  return new Error("Certified run aborted by user.");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
