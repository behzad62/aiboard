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
import { buildCertifiedMessages, certifiedPromptText } from "./prompting";
import {
  createCertifiedModelCallTrace,
  recordCertifiedModelCallTrace,
} from "./trace-recorder";

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
  let rawResponse = "";
  let parsePhase = false;

  try {
    for await (const chunk of streamChat({ providerId, params })) {
      if (chunk.type === "token" && chunk.content) {
        rawResponse += chunk.content;
      } else if (chunk.type === "error") {
        throw new Error(chunk.error ?? "Certified provider returned an error.");
      }
    }

    parsePhase = true;
    const parsedJson = input.structuredOutput
      ? parseStructuredJson(rawResponse)
      : undefined;
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
        parsedJson === undefined ? undefined : JSON.stringify(parsedJson),
      finalStatus: "parsed",
    });
    const traceId = await recordCertifiedModelCallTrace(input.context, trace);
    return {
      rawResponse,
      parsedJson,
      traceId,
      latencyMs,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      estimatedUsd,
    };
  } catch (error) {
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
    await recordCertifiedModelCallTrace(input.context, trace);
    throw error;
  }
}

async function* defaultCertifiedModelStream(
  input: CertifiedModelStreamInput
): AsyncIterable<StreamChunk> {
  const provider = getProvider(input.providerId);
  if (!provider) throw new Error(`Unknown certified provider: ${input.providerId}`);
  yield* provider.streamChat(input.params);
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
