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

const DEFAULT_CERTIFIED_MODEL_CALL_TIMEOUT_MS = 120_000;

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
  structuredOutput?: StructuredOutputFormat;
  maxTokens: number;
  temperature: 0;
  reasoningEffort?: ReasoningEffort;
  context: CertifiedRunContext;
  participantId: string;
  caseId?: string;
  attemptId?: string;
  pricing?: Pick<ModelPricing, "inputUsdPer1M" | "outputUsdPer1M"> | null;
  apiKey?: string;
  baseURL?: string;
  streamChat?: CertifiedModelStream;
  allowInvalidStructuredOutput?: boolean;
}

export interface CertifiedModelCallResult {
  rawResponse: string;
  parsedJson?: unknown;
  traceId: string;
  latencyMs: number;
  inputTokens: number;
  outputTokens: number;
  estimatedUsd: number | null;
}

export async function callCertifiedModel(
  input: CallCertifiedModelInput
): Promise<CertifiedModelCallResult> {
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
  } catch (error) {
    await recordCertifiedBudgetEvent(input, error);
    throw error;
  }
  await recordCertifiedModelCallEvent(input, {
    type: "model_call_started",
    phase: "model-call",
    message: `Certified model call started for ${fullModelId}.`,
    details: {
      maxTokens: input.maxTokens,
      timeoutMs: certifiedModelCallTimeoutMs(input),
      schemaMode: input.structuredOutput ? "structured" : "text",
    },
  });
  let rawResponse = "";
  let parsePhase = false;

  try {
    for await (const chunk of withCertifiedModelCallTimeout(
      streamChat({ providerId, params }),
      certifiedModelCallTimeoutMs(input)
    )) {
      if (chunk.type === "token" && chunk.content) {
        rawResponse += chunk.content;
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
    const usage = estimateModelCallUsage({
      messages,
      output: rawResponse,
      maxTokens: input.maxTokens,
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
      reasoningEffort: input.reasoningEffort,
      schemaMode: input.structuredOutput ? "structured" : "text",
      promptText: certifiedPromptText(messages),
      startedAt,
      completedAt: new Date().toISOString(),
      latencyMs,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
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
    };
  } catch (error) {
    if (error instanceof CertifiedBudgetExceededError) {
      throw error;
    }
    const message = errorMessage(error);
    const usage = estimateModelCallUsage({
      messages,
      output: rawResponse,
      maxTokens: input.maxTokens,
    });
    const latencyMs = Math.max(0, Date.now() - startedMs);
    const trace = createCertifiedModelCallTrace({
      modelId: fullModelId,
      providerId,
      participantId: input.participantId,
      runId: input.context.runId,
      caseId: input.caseId,
      attemptId: input.attemptId,
      reasoningEffort: input.reasoningEffort,
      schemaMode: input.structuredOutput ? "structured" : "text",
      promptText: certifiedPromptText(messages),
      startedAt,
      completedAt: new Date().toISOString(),
      latencyMs,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
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
    } catch {
      // Preserve the provider/parser error that caused the failed model call.
    }
    throw error;
  }
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
  timeoutMs: number
): AsyncIterable<T> {
  const iterator = iterable[Symbol.asyncIterator]();
  try {
    for (;;) {
      const next = await withTimeout(
        iterator.next(),
        timeoutMs,
        `Certified model call timed out after ${timeoutMs}ms.`
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
  message: string
): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
