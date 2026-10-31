/**
 * Client backend for the Settings surface: provider keys, validation, pricing
 * overrides, custom models, and attachments. Mirrors the old /api/keys,
 * /api/providers/validate, /api/custom-models and /api/attachments routes, but
 * runs against the client store and calls providers in-browser.
 */

import { v4 as uuidv4 } from "uuid";
import OpenAI from "openai";
import Anthropic from "@anthropic-ai/sdk";
import { GoogleGenAI, type Model as GoogleModel } from "@google/genai";
import type { CustomModel, UserSettings, ReasoningEffort } from "@/lib/db/schema";
import type { ModelInfo, StreamChunk } from "@/lib/providers/base";
import { extractModelMetadata, validateModelMetadataOverrides, type ModelMetadataDetails, type ModelMetadataValues } from "@/lib/providers/model-metadata";
import { getProviderDefinition } from "@/lib/providers/provider-registry";
import { streamOpenAICompatibleChat, isLoopbackOllamaEndpoint } from "@/lib/providers/openai-compat";
import { META_MODEL_API_BASE_URL } from "@/lib/providers/meta";
import {
  resolveModelContextProfile,
  type ModelContextProfileOverride,
} from "@/lib/providers/model-context";
import type { AttachmentPayload, AttachmentSummary } from "@/lib/attachments/types";
import { classifyMimeType } from "@/lib/attachments/classify";
import { maskApiKey } from "@/lib/utils";
import {
  addAttachment,
  addCustomModel as storeAddCustomModel,
  deleteAttachmentRecord,
  deleteCustomModel as storeDeleteCustomModel,
  getAttachment,
  getCustomModelById,
  getCustomModels,
  getProviderKey,
  getProviderKeys,
  getUserSettings,
  updateCustomModel as storeUpdateCustomModel,
  updateProviderKey,
  updateUserSettings,
  upsertProviderKey,
} from "./store";
import {
  CUSTOM_PROVIDER_ID,
  DEEPSEEK_PROVIDER_ID,
  FOUNDRY_PROVIDER_ID,
  NVIDIA_PROVIDER_ID,
  OPENROUTER_PROVIDER_ID,
  getAllProviders,
  getProvider,
  getPersistedProviderCapabilityEvidence,
  getRunnerCapabilityPlanningContext,
  getCustomModelByFullId,
  customModelPlanningContext,
  listProviderModelInfos,
  normalizeProviderModelId,
  normalizeOpenRouterModelId,
  resolveModelCapabilities,
} from "./providers";
import { formatModelId } from "@/lib/providers/base";
import { getPeerConnection } from "./local-runner-handoff";
import { DEEPSEEK_BASE_URL } from "@/lib/providers/deepseek";
import type { ProviderId } from "@/lib/providers/provider-registry";
import type {
  CapabilityEvidence,
  ProviderTransportId,
  ToolCapabilityDescriptor,
  ToolResourceState,
} from "@/lib/providers/tool-capabilities";
import { customCompatibleTransports } from "@/lib/providers/custom-capabilities";
import { resolveProviderCapabilityProfile } from "@/lib/providers/capability-resolution";
import { capabilityStatusRows, type ProviderCapabilityStatusRow } from "@/lib/providers/capability-status";
import { mergeCapabilityEvidenceRecords } from "./provider-capability-migration";
import { resolveToolRuntimeResourceStateCached } from "./tool-runtime";

// ── Providers / keys ──────────────────────────────────────────────────────────

export interface ProviderConfig {
  providerId: string;
  name: string;
  models: ModelInfo[];
  enabledModelIds?: string[];
  hasKey: boolean;
  keyHint?: string | null;
  baseURL?: string | null;
  runnerTokenHint?: string | null;
  /** Optional extra model ids saved for providers that support user additions. */
  modelIds?: string[];
  defaultModel?: string | null;
  enabled: boolean;
  lastValidationSucceeded?: boolean | null;
  lastValidatedAt?: string | null;
}

export function loadProviders(): {
  providers: ProviderConfig[];
  settings: UserSettings;
} {
  const keys = getProviderKeys();
  const settings = getUserSettings();
  const withContext = (model: ModelInfo): ModelInfo => ({
    ...model,
    contextProfile: resolveModelContextProfile(
      model.id,
      model.providerId,
      settings.modelContextOverrides,
      settings.discoveredModelMetadata
    ),
  });
  const providers = getAllProviders().map((p) => {
    const saved = keys.find((k) => k.providerId === p.id);
    return {
      providerId: p.id,
      name: p.name,
      models: listProviderModelInfos(p.id as ProviderId).map(withContext),
      enabledModelIds: saved?.enabledModelIds ?? undefined,
      hasKey: !!saved,
      keyHint: saved?.keyHint,
      baseURL: saved?.baseURL ?? null,
      runnerTokenHint: saved?.runnerTokenHint ?? null,
      modelIds: getProviderDefinition(p.id)?.modelDiscovery ? listProviderModelInfos(p.id as ProviderId).map((model) => model.id) : saved?.models ?? [],
      defaultModel: saved?.defaultModel,
      enabled: saved?.enabled ?? false,
      lastValidationSucceeded: saved?.lastValidationSucceeded ?? null,
      lastValidatedAt: saved?.lastValidatedAt ?? null,
    };
  });
  return { providers, settings };
}

export async function resolveProviderCapabilityStatus(input: {
  providerId: string;
  modelId: string;
  resourceState?: ToolResourceState;
}): Promise<ProviderCapabilityStatusRow[]> {
  const persistedEvidence = getPersistedProviderCapabilityEvidence(
    input.providerId,
    input.modelId,
  );
  const runner = await getRunnerCapabilityPlanningContext(
    input.providerId,
    input.modelId,
  );
  const custom = input.providerId === CUSTOM_PROVIDER_ID
    ? getCustomModelByFullId(formatModelId(CUSTOM_PROVIDER_ID, input.modelId))
    : null;
  const customContext = custom ? customModelPlanningContext(custom) : undefined;
  const resourceState = input.resourceState ?? await resolveToolRuntimeResourceStateCached();
  const profile = resolveProviderCapabilityProfile({
    providerId: input.providerId,
    modelId: input.modelId,
    catalogEvidence: persistedEvidence,
    runnerEvidence: runner.evidence,
    resourceState,
    customOverrides: customContext?.customOverrides,
  });
  return capabilityStatusRows(profile, {
    allowedTransports: customContext?.allowedTransports ?? runner.allowedTransports,
  });
}
/** Tab-scoped account Runner connection issued by `aiboard` (or `aiboard accounts`), if any. Never persisted. */
export function getLauncherAccountRunnerConnection(): { baseURL: string; runnerToken: string } | null {
  const connection = getPeerConnection("accounts");
  return connection ? { baseURL: connection.url, runnerToken: connection.token } : null;
}

/** A launcher-issued account session wins; a saved manual connection keeps working. */
export function resolveAccountRunnerConnection(saved?: { baseURL?: string | null; runnerToken?: string | null } | null): { baseURL: string; runnerToken: string } | null {
  const launcher = getLauncherAccountRunnerConnection();
  if (launcher) return launcher;
  return saved?.baseURL && saved?.runnerToken ? { baseURL: saved.baseURL, runnerToken: saved.runnerToken } : null;
}

export function saveOpenAIConnectionMode(mode: "api" | "subscription"): void {
  updateUserSettings({ openAIConnectionMode: mode });
}

export function saveProviderKey(input: {
  providerId: string;
  apiKey?: string;
  baseURL?: string;
  runnerToken?: string;
  models?: string[];
  enabledModelIds?: string[];
  defaultModel?: string | null;
  enabled?: boolean;
}): void {
  const existing = getProviderKey(input.providerId);
  const now = new Date().toISOString();
  const baseURL = input.baseURL?.trim();
  const runnerToken = input.runnerToken?.trim();
  const models = input.models
    ?.map((m) => m.trim())
    .filter((m) => m.length > 0);
  const enabledModelIds = input.enabledModelIds
    ?.map((m) => m.trim())
    .filter((m) => m.length > 0);
  if (existing) {
    updateProviderKey(input.providerId, {
      ...(input.apiKey
        ? {
            apiKey: input.apiKey,
            keyHint: maskApiKey(input.apiKey),
            lastValidationSucceeded: null,
            lastValidatedAt: null,
          }
        : {}),
      ...(input.baseURL !== undefined ? { baseURL: baseURL || null } : {}),
      ...(input.runnerToken
        ? {
            runnerToken,
            runnerTokenHint: runnerToken ? maskApiKey(runnerToken) : null,
            lastValidationSucceeded: null,
            lastValidatedAt: null,
          }
        : {}),
      ...(input.models !== undefined ? { models: models ?? [] } : {}),
      ...(input.enabledModelIds !== undefined
        ? { enabledModelIds: enabledModelIds ?? [] }
        : {}),
      defaultModel:
        input.defaultModel !== undefined
          ? input.defaultModel
          : existing.defaultModel,
      enabled: input.enabled ?? existing.enabled,
      updatedAt: now,
    });
  } else if (input.apiKey) {
    upsertProviderKey({
      providerId: input.providerId,
      apiKey: input.apiKey,
      baseURL: baseURL || null,
      runnerToken: runnerToken || null,
      runnerTokenHint: runnerToken ? maskApiKey(runnerToken) : null,
      models: models ?? [],
      enabledModelIds: enabledModelIds ?? null,
      defaultModel: input.defaultModel ?? null,
      enabled: input.enabled ?? true,
      keyHint: maskApiKey(input.apiKey),
      lastValidationSucceeded: null,
      lastValidatedAt: null,
      updatedAt: now,
    });
  } else {
    throw new Error("API key required");
  }
  if (getProviderDefinition(input.providerId)?.modelDiscovery) {
    const settings = getUserSettings();
    const metadata = { ...(settings.discoveredModelMetadata ?? {}) };
    let changed = false;
    for (const model of listProviderModelInfos(input.providerId as ProviderId)) {
      const key = formatModelId(input.providerId, model.id);
      if (metadata[key]) continue;
      metadata[key] = {
        name: model.id, reportedFields: [],
        image: false, document: false, audio: false, video: false,
        source: "provider-models", updatedAt: now,
      };
      changed = true;
    }
    if (changed) updateUserSettings({ discoveredModelMetadata: metadata });
  }
}

interface OpenRouterModelsResponse {
  data?: Array<{
    id?: string;
    name?: string;
    description?: string;
    created?: number;
    context_length?: number;
    max_output_tokens?: number;
    max_completion_tokens?: number;
    top_provider?: { context_length?: number; max_completion_tokens?: number | null };
    pricing?: { prompt?: string; completion?: string; input_cache_read?: string };
    supported_parameters?: string[];
    architecture?: {
      input_modalities?: string[];
    };
  }>;
}

export interface OpenRouterCatalogModel extends ModelMetadataDetails {
  id: string;
  name: string;
  description?: string;
  createdAtMs?: number;
  contextWindowTokens?: number;
  maxOutputTokens?: number;
  inputUsdPer1M?: number;
  outputUsdPer1M?: number;
  /** Cache-read price (OpenRouter `pricing.input_cache_read`); absent when the provider does not publish one. */
  cachedInputUsdPer1M?: number;
  inputModalities: string[];
  supportedParameters: string[];
  supportsImageInput: boolean;
  supportsDocumentInput: boolean;
  supportsAudioInput: boolean;
  supportsVideoInput: boolean;
  supportsTools: boolean;
  supportsToolChoice: boolean;
  supportsStructuredOutputs: boolean;
  supportsReasoning: boolean;
  supportsReasoningEffort: boolean;
  supportsTemperature: boolean;
  supportsMaxTokens: boolean;
  parametersReported?: boolean;
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : undefined;
}

export type ProviderCatalogModel = OpenRouterCatalogModel;
export function openRouterCatalogCapabilityEvidence(
  model: OpenRouterCatalogModel,
  verifiedAt?: string,
): CapabilityEvidence[] {
  return [
    {
      providerId: "openrouter",
      modelId: model.id,
      capabilityId: "function_calling",
      transport: "responses",
      support: model.supportsTools ? "supported" : "unsupported",
      execution: "client",
      source: "provider-catalog",
      ...(verifiedAt ? { verifiedAt } : {}),
    },
  ];
}

function normalizeOpenRouterSupportedParameters(
  parameters?: string[]
): Set<string> {
  return new Set(
    (parameters ?? []).map((value) => value.trim().toLowerCase()).filter(Boolean)
  );
}

function normalizeOpenRouterInputModalities(modalities?: string[]): Set<string> {
  return new Set(
    (modalities ?? []).map((value) => value.trim().toLowerCase()).filter(Boolean)
  );
}

export function buildOpenRouterCatalogModel(
  entry: NonNullable<OpenRouterModelsResponse["data"]>[number] & { id: string }
): OpenRouterCatalogModel {
  const record = entry as Record<string, unknown>;
  const maxCompletionTokens =
    positiveInteger(record.max_output_tokens) ??
    positiveInteger(record.max_completion_tokens) ?? positiveInteger(entry.top_provider?.max_completion_tokens);
  const inputModalities = [...(entry.architecture?.input_modalities ?? [])];
  const modalitySet = normalizeOpenRouterInputModalities(inputModalities);
  const supportedParameters = [...(entry.supported_parameters ?? [])];
  const parameterSet = normalizeOpenRouterSupportedParameters(supportedParameters);
  const createdAtMs = Number.isFinite(entry.created) ? Number(entry.created) * 1_000 : undefined;
  const metadata = extractModelMetadata(record, "openrouter");
  const { inputUsdPer1M, outputUsdPer1M, cachedInputUsdPer1M } = metadata;
  return {
    ...metadata,
    id: entry.id,
    name: entry.name?.trim() || entry.id,
    description: entry.description?.trim() || undefined,
    createdAtMs,
    contextWindowTokens: metadata.contextWindowTokens,
    maxOutputTokens: maxCompletionTokens,
    inputUsdPer1M,
    outputUsdPer1M,
    ...(cachedInputUsdPer1M !== undefined ? { cachedInputUsdPer1M } : {}),
    inputModalities,
    supportedParameters,
    parametersReported: Array.isArray(entry.supported_parameters),
    supportsImageInput: modalitySet.has("image"),
    supportsDocumentInput: modalitySet.has("file"),
    supportsAudioInput: modalitySet.has("audio"),
    supportsVideoInput: modalitySet.has("video"),
    supportsTools: parameterSet.has("tools"),
    supportsToolChoice: parameterSet.has("tool_choice"),
    supportsStructuredOutputs: parameterSet.has("structured_outputs"),
    supportsReasoning: parameterSet.has("reasoning"),
    supportsReasoningEffort: parameterSet.has("reasoning_effort"),
    supportsTemperature: parameterSet.has("temperature"),
    supportsMaxTokens: parameterSet.has("max_tokens"),
  };
}

async function fetchOpenRouterModelsPayload(): Promise<OpenRouterModelsResponse> {
  const response = await fetch("https://openrouter.ai/api/v1/models");
  if (!response.ok) {
    throw new Error(`OpenRouter model catalog request failed (${response.status})`);
  }
  return (await response.json()) as OpenRouterModelsResponse;
}

export async function fetchOpenRouterModelCatalog(): Promise<OpenRouterCatalogModel[]> {
  const payload = await fetchOpenRouterModelsPayload();
  return (payload.data ?? [])
    .filter(
      (
        entry
      ): entry is NonNullable<OpenRouterModelsResponse["data"]>[number] & { id: string } =>
        typeof entry.id === "string" && entry.id.length > 0
    )
    .map(buildOpenRouterCatalogModel)
    .sort((a, b) => a.id.localeCompare(b.id));
}

function basicCatalogModel(
  id: string,
  name = id,
  options: {
    description?: string;
    createdAtMs?: number;
    contextWindowTokens?: number;
    maxOutputTokens?: number;
    inputUsdPer1M?: number;
    outputUsdPer1M?: number;
    image?: boolean;
    reasoningEffort?: boolean;
  } & ModelMetadataDetails = {}
): ProviderCatalogModel {
  return {
    ...extractModelMetadata({ ...options }),
    id,
    name,
    description: options.description,
    createdAtMs: options.createdAtMs,
    contextWindowTokens: options.contextWindowTokens,
    maxOutputTokens: options.maxOutputTokens,
    inputUsdPer1M: options.inputUsdPer1M,
    outputUsdPer1M: options.outputUsdPer1M,
    inputModalities: [options.text ? "text" : null, options.image ? "image" : null].filter((value): value is string => value !== null),
    supportedParameters: [],
    supportsImageInput: options.image === true,
    supportsDocumentInput: options.document === true,
    supportsAudioInput: options.audio === true,
    supportsVideoInput: options.video === true,
    supportsTools: false,
    supportsToolChoice: false,
    supportsStructuredOutputs: false,
    supportsReasoning: options.reasoningEffort === true,
    supportsReasoningEffort: options.reasoningEffort === true,
    supportsTemperature: false,
    supportsMaxTokens: false,
  };
}

export function buildProviderCatalogModel(record: Record<string, unknown>): ProviderCatalogModel {
  const metadata = extractModelMetadata(record);
  const id = String(record.id ?? record.slug ?? "").trim();
  const name = String(record.name ?? record.display_name ?? record.displayName ?? id);
  return { ...basicCatalogModel(id, name, {
    ...metadata,
    description: typeof record.description === "string" ? record.description : undefined,
    createdAtMs: typeof record.created === "number" ? record.created * 1_000 : typeof record.created_at === "string" ? Date.parse(record.created_at) : undefined,
    reasoningEffort: typeof (record.capabilities as RunnerCatalogEntry["capabilities"])?.supports?.reasoningEffort === "boolean"
      ? (record.capabilities as RunnerCatalogEntry["capabilities"])?.supports?.reasoningEffort : undefined,
  }), ...metadata };
}

type GoogleCatalogModelRecord = Pick<
  GoogleModel,
  "name" | "displayName" | "description" | "thinking" | "supportedActions" | "inputTokenLimit" | "outputTokenLimit"
>;

export async function collectGoogleModelCatalog(
  models: AsyncIterable<GoogleCatalogModelRecord>
): Promise<ProviderCatalogModel[]> {
  const byId = new Map<string, ProviderCatalogModel>();
  for await (const model of models) {
    const resourceName = typeof model.name === "string" ? model.name.trim() : "";
    const id = resourceName.replace(/^models\//, "");
    if (!id) continue;
    const actions = Array.isArray(model.supportedActions) ? model.supportedActions : [];
    if (actions.length > 0 && !actions.includes("generateContent")) continue;
    byId.set(
      id,
      basicCatalogModel(id, model.displayName?.trim() || id, {
        description: model.description?.trim() || undefined,
        reasoningEffort: model.thinking === true,
        contextWindowTokens: positiveInteger(model.inputTokenLimit),
        maxOutputTokens: positiveInteger(model.outputTokenLimit),
      })
    );
  }
  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
}

async function fetchGoogleModelCatalog(apiKey: string): Promise<ProviderCatalogModel[]> {
  const pager = await new GoogleGenAI({ apiKey }).models.list({
    config: { pageSize: 1000, queryBase: true },
  });
  return collectGoogleModelCatalog(pager);
}
async function fetchOpenAICompatibleModelCatalog(
  apiKey: string,
  baseURL?: string
): Promise<ProviderCatalogModel[]> {
  const page = await new OpenAI({
    apiKey,
    ...(baseURL ? { baseURL } : {}),
    dangerouslyAllowBrowser: true,
  }).models.list();
  return page.data
    .filter((model) => typeof model.id === "string" && model.id.length > 0)
    .map((model) => {
      const record = model as unknown as Record<string, unknown>;
      return { ...buildProviderCatalogModel(record),
        createdAtMs: Number.isFinite(model.created) ? model.created * 1_000 : undefined,
      };
    })
    .sort((a, b) => a.id.localeCompare(b.id));
}

async function fetchAnthropicModelCatalog(
  apiKey: string
): Promise<ProviderCatalogModel[]> {
  const page = await new Anthropic({ apiKey, dangerouslyAllowBrowser: true }).models.list({
    limit: 1000,
  });
  const models: ProviderCatalogModel[] = [];
  for await (const model of page) {
    if (typeof model.id !== "string" || !model.id.trim()) continue;
    models.push(basicCatalogModel(model.id, model.display_name || model.id, {
      ...extractModelMetadata(model as unknown as Record<string, unknown>),
      createdAtMs: Number.isFinite(Date.parse(model.created_at)) ? Date.parse(model.created_at) : undefined,
    }));
  }
  return models.sort((a, b) => a.id.localeCompare(b.id));
}

async function fetchMetaModelCatalog(apiKey: string): Promise<ProviderCatalogModel[]> {
  const response = await fetch(`${META_MODEL_API_BASE_URL}/models`, {
    headers: { authorization: `Bearer ${apiKey}` },
  });
  const payload = (await response.json().catch(() => ({}))) as {
    data?: Array<{ id?: string; name?: string; display_name?: string }>;
    error?: { message?: string } | string;
  };
  if (!response.ok) {
    const error =
      typeof payload.error === "string" ? payload.error : payload.error?.message;
    throw new Error(error ?? `Meta Model API catalog request failed (${response.status})`);
  }
  return (payload.data ?? [])
    .filter((model): model is { id: string; name?: string; display_name?: string } =>
      typeof model.id === "string" && /^muse-spark-/i.test(model.id)
    )
    .map((model) =>
      basicCatalogModel(
        model.id,
        model.display_name?.trim() || model.name?.trim() || model.id,
        extractModelMetadata(model as unknown as Record<string, unknown>)
      )
    )
    .sort((a, b) => a.id.localeCompare(b.id));
}

async function fetchXaiLanguageModelCatalog(apiKey: string): Promise<ProviderCatalogModel[]> {
  const response = await fetch("https://api.x.ai/v1/language-models", {
    headers: { authorization: `Bearer ${apiKey}` },
  });
  const payload = (await response.json().catch(() => ({}))) as {
    models?: Array<{ id?: string; input_modalities?: string[] }>;
    error?: { message?: string } | string;
  };
  if (!response.ok) {
    const error =
      typeof payload.error === "string" ? payload.error : payload.error?.message;
    if (error && /credits|spending limit/i.test(error)) {
      throw new Error(`xAI blocked model catalog access because of your team's credit or spending limit. Browsing only requests model metadata; no generation request was sent. Check your team's billing settings in the xAI Console. Provider response: ${error}`);
    }
    throw new Error(error ?? `xAI language-model catalog request failed (${response.status})`);
  }
  return (payload.models ?? [])
    .filter((model): model is { id: string; input_modalities?: string[] } =>
      typeof model.id === "string" && model.id.length > 0
    )
    .map((model) => ({
      ...basicCatalogModel(model.id, model.id, {
        ...extractModelMetadata(model as unknown as Record<string, unknown>, "xai"),
        reasoningEffort: !model.id.toLowerCase().includes("non-reasoning"),
      }),
      supportsTemperature: true,
      supportsMaxTokens: true,
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
}
interface RunnerCatalogEntry {
  id?: string;
  name?: string;
  capabilities?: {
    supports?: {
      vision?: boolean;
      reasoningEffort?: boolean;
    };
  };
}

export interface ChatGPTAccountStatus {
  runnerVersion: number;
  connected: boolean;
  requiresSignIn: boolean;
  message?: string | null;
  email?: string | null;
  accountId?: string | null;
  accounts: Array<{ clientId: string; email?: string | null; active: boolean }>;
}

export async function fetchChatGPTAccountStatus(baseURL: string, runnerToken: string, signal?: AbortSignal): Promise<ChatGPTAccountStatus> {
  const response = await fetch(`${baseURL.replace(/\/$/, "")}/providers/chatgpt/status`, {
    headers: { "x-runner-token": runnerToken }, signal,
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error ?? `Account runner status failed (${response.status})`);
  if (!(payload.runnerVersion >= 25)) {
    throw new Error("This account runner is too old for ChatGPT public API sign-in. Download and restart account runner v25 or newer, then Continue with ChatGPT again.");
  }
  return payload as ChatGPTAccountStatus;
}

async function fetchRunnerModelCatalog(input: {
  providerId: "chatgpt" | "github-copilot" | "nvidia";
  apiKey: string;
  baseURL: string;
  runnerToken: string;
}): Promise<ProviderCatalogModel[]> {
  if (input.providerId === "chatgpt") {
    const status = await fetchChatGPTAccountStatus(input.baseURL, input.runnerToken);
    if (!status.connected) throw new Error(status.message ?? "Continue with ChatGPT to authorize plan usage first.");
    if (status.runnerVersion < 26) {
      throw new Error("This account runner is too old for complete ChatGPT model metadata. Download and restart account runner v26 or newer, then refresh the catalog.");
    }
  }
  const response = await fetch(
    `${input.baseURL.replace(/\/$/, "")}/providers/${input.providerId}/models`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-runner-token": input.runnerToken,
      },
      body: JSON.stringify(
        input.providerId === "nvidia" ? { apiKey: input.apiKey } : {}
      ),
    }
  );
  const payload = (await response.json().catch(() => ({}))) as {
    data?: RunnerCatalogEntry[];
    error?: string;
  };
  if (!response.ok) {
    if (response.status === 401) {
      throw new Error("Runner session token was rejected. Copy the current session token printed by the account runner, paste it above, and save. Restarting the runner changes this token; your provider login is separate.");
    }
    if (
      input.providerId === "chatgpt" &&
      /does not expose a stable model catalog/i.test(payload.error ?? "")
    ) {
      throw new Error(
        "This account runner is too old for ChatGPT live model discovery. Download and restart account runner v25 or newer, then Continue with ChatGPT again.",
      );
    }
    throw new Error(payload.error ?? `Provider model catalog request failed (${response.status})`);
  }
  return (payload.data ?? [])
    .filter((model): model is RunnerCatalogEntry & { id: string } =>
      typeof model.id === "string" && model.id.length > 0
    )
    .map((model) =>
      buildProviderCatalogModel(model as unknown as Record<string, unknown>)
    )
    .sort((a, b) => a.id.localeCompare(b.id));
}

export async function fetchProviderModelCatalog(input: {
  providerId: string;
  apiKey?: string;
  baseURL?: string;
  runnerToken?: string;
}): Promise<ProviderCatalogModel[]> {
  if (input.providerId === OPENROUTER_PROVIDER_ID) {
    return fetchOpenRouterModelCatalog();
  }
  const explicitApiKey = input.apiKey?.trim() || "";
  const explicitBaseURL = input.baseURL?.trim() || "";
  const explicitRunnerToken = input.runnerToken?.trim() || "";
  const isChatGPT = input.providerId === "chatgpt";
  const isGitHubCopilot = input.providerId === "github-copilot";
  const isNvidia = input.providerId === NVIDIA_PROVIDER_ID;
  const needsSavedRunnerSettings =
    ((isChatGPT || isGitHubCopilot) && !explicitBaseURL) ||
    (isNvidia && (!explicitBaseURL || !explicitRunnerToken));
  const saved = !explicitApiKey || needsSavedRunnerSettings
    ? getProviderKey(input.providerId)
    : undefined;
  const apiKey = explicitApiKey || saved?.apiKey?.trim() || "";
  if (!apiKey) throw new Error("Save or enter the provider credential first");

  if (input.providerId === "anthropic") {
    return fetchAnthropicModelCatalog(apiKey);
  }
  if (input.providerId === "meta") {
    return fetchMetaModelCatalog(apiKey);
  }
  if (input.providerId === "xai") {
    return fetchXaiLanguageModelCatalog(apiKey);
  }
  if (isChatGPT || isGitHubCopilot || input.providerId === NVIDIA_PROVIDER_ID) {
    const baseURL = input.baseURL?.trim() || saved?.baseURL?.trim() || "";
    const runnerToken =
      isChatGPT || isGitHubCopilot
        ? apiKey
        : input.runnerToken?.trim() || saved?.runnerToken?.trim() || "";
    if (!baseURL || !runnerToken) {
      throw new Error("Save the local runner URL and token before browsing models");
    }
    const runnerProviderId = isChatGPT
      ? "chatgpt"
      : isGitHubCopilot
        ? "github-copilot"
        : NVIDIA_PROVIDER_ID;
    return fetchRunnerModelCatalog({
      providerId: runnerProviderId,
      apiKey,
      baseURL,
      runnerToken,
    });
  }
  if (input.providerId === "google") {
    return fetchGoogleModelCatalog(apiKey);
  }
  if (input.providerId === "openai") {
    return fetchOpenAICompatibleModelCatalog(apiKey);
  }
  if (input.providerId === DEEPSEEK_PROVIDER_ID) {
    return fetchOpenAICompatibleModelCatalog(apiKey, DEEPSEEK_BASE_URL);
  }
  throw new Error(`Live model discovery is not supported for ${input.providerId}`);
}

export function discoveryMetadataFromCatalogModel(
  model: ProviderCatalogModel,
  source: "openrouter-models" | "provider-models",
  updatedAt: string,
) {
  return {
    catalogFetchedAt: updatedAt,
    supplemental: model.supplemental,
    apiEquivalentPricing: model.apiEquivalentPricing,
    name: model.name,
    description: model.description,
    createdAtMs: model.createdAtMs,
    inputModalities: model.inputModalities,
    supportedParameters: model.supportedParameters,
    text: model.text,
    reportedFields: model.reportedFields ?? [],
    image: model.supportsImageInput,
    document: model.supportsDocumentInput,
    audio: model.supportsAudioInput,
    video: model.supportsVideoInput,
    ...(model.contextWindowTokens !== undefined
      ? { contextWindowTokens: model.contextWindowTokens }
      : {}),
    ...(model.maxOutputTokens !== undefined
      ? { maxOutputTokens: model.maxOutputTokens }
      : {}),
    ...(model.inputUsdPer1M !== undefined
      ? { inputUsdPer1M: model.inputUsdPer1M }
      : {}),
    ...(model.outputUsdPer1M !== undefined
      ? { outputUsdPer1M: model.outputUsdPer1M }
      : {}),
    ...(model.cachedInputUsdPer1M !== undefined
      ? { cachedInputUsdPer1M: model.cachedInputUsdPer1M }
      : {}),
    apiParameters: model.parametersReported ? {
      toolChoice: model.supportsToolChoice,
      structuredOutputs: model.supportsStructuredOutputs,
      reasoning: model.supportsReasoning,
      reasoningEffort: model.supportsReasoningEffort,
      temperature: model.supportsTemperature,
      maxTokens: model.supportsMaxTokens,
    } : model.supportsReasoningEffort ? { reasoning: true, reasoningEffort: true } : undefined,
    updatedAt,
    source,
  };
}

export function persistProviderCatalogModels(providerId: string, models: ProviderCatalogModel[]): void {
  const settings = getUserSettings();
  const metadata = { ...(settings.discoveredModelMetadata ?? {}) };
  let evidence = [...(settings.providerToolCapabilityEvidence ?? [])];
  const updatedAt = new Date().toISOString();
  for (const model of models) {
    const key = formatModelId(providerId, model.id);
    metadata[key] = { ...discoveryMetadataFromCatalogModel(model, providerId === "openrouter" ? "openrouter-models" : "provider-models", updatedAt),
      overrides: metadata[key]?.overrides, supplemental: model.supplemental ?? metadata[key]?.supplemental,
      apiEquivalentPricing: model.apiEquivalentPricing ?? metadata[key]?.apiEquivalentPricing };
    if (providerId === "openrouter" && model.parametersReported) evidence = mergeCapabilityEvidenceRecords(evidence, openRouterCatalogCapabilityEvidence(model, updatedAt));
  }
  updateUserSettings({ discoveredModelMetadata: metadata, providerToolCapabilityEvidence: evidence });
}

export function saveModelMetadataOverrides(fullModelId: string, values: ModelMetadataValues): void {
  validateModelMetadataOverrides(values);
  const settings = getUserSettings();
  const metadata = { ...(settings.discoveredModelMetadata ?? {}) };
  const previous = metadata[fullModelId] ?? { image: false, document: false, audio: false, video: false,
    source: "provider-models" as const, updatedAt: new Date().toISOString(), reportedFields: [] };
  metadata[fullModelId] = { ...previous, overrides: values };
  const prices = { ...(settings.modelPricingOverrides ?? {}) };
  delete prices[fullModelId];
  const contexts = { ...(settings.modelContextOverrides ?? {}) };
  if (contexts[fullModelId]) {
    const next = { ...contexts[fullModelId] };
    delete next.contextWindowTokens;
    delete next.maxOutputTokens;
    if (Object.keys(next).every((field) => field === "updatedAt")) delete contexts[fullModelId];
    else contexts[fullModelId] = next;
  }
  updateUserSettings({ discoveredModelMetadata: metadata, modelPricingOverrides: prices, modelContextOverrides: contexts });
}

export function getModelMetadataOverrides(fullModelId: string): ModelMetadataValues {
  const settings = getUserSettings();
  const pricing = settings.modelPricingOverrides?.[fullModelId];
  const context = settings.modelContextOverrides?.[fullModelId];
  return { ...settings.discoveredModelMetadata?.[fullModelId]?.overrides,
    ...(pricing ? { inputUsdPer1M: pricing.inputUsdPer1M, outputUsdPer1M: pricing.outputUsdPer1M,
      ...(pricing.cachedInputUsdPer1M != null ? { cachedInputUsdPer1M: pricing.cachedInputUsdPer1M } : {}) } : {}),
    ...(context?.contextWindowTokens != null ? { contextWindowTokens: context.contextWindowTokens } : {}),
    ...(context?.maxOutputTokens != null ? { maxOutputTokens: context.maxOutputTokens } : {}),
  };
}

export async function refreshOpenRouterModelCapabilities(
  modelIds?: string[]
): Promise<{ synced: number; missing: string[] }> {
  const targets = (modelIds ?? getProviderKey(OPENROUTER_PROVIDER_ID)?.models ?? [])
    .map(normalizeOpenRouterModelId)
    .filter((id, index, all) => id.length > 0 && all.indexOf(id) === index);
  if (targets.length === 0) return { synced: 0, missing: [] };

  const payload = await fetchOpenRouterModelsPayload();
  const modelIndex = new Map(
    (payload.data ?? [])
      .filter((entry): entry is NonNullable<OpenRouterModelsResponse["data"]>[number] & { id: string } =>
        typeof entry.id === "string" && entry.id.length > 0
      )
      .map((entry) => [entry.id, entry])
  );

  const settings = getUserSettings();
  const nextMetadata = { ...(settings.discoveredModelMetadata ?? {}) };
  let nextEvidence = [...(settings.providerToolCapabilityEvidence ?? [])];
  const missing: string[] = [];
  let synced = 0;
  const updatedAt = new Date().toISOString();
  for (const id of targets) {
    const entry = modelIndex.get(id);
    if (!entry) {
      missing.push(id);
      continue;
    }
    const model = buildOpenRouterCatalogModel(entry);
    const key = formatModelId(OPENROUTER_PROVIDER_ID, id);
    nextMetadata[key] = { ...discoveryMetadataFromCatalogModel(model, "openrouter-models", updatedAt), overrides: nextMetadata[key]?.overrides, supplemental: model.supplemental ?? nextMetadata[key]?.supplemental };
    if (model.parametersReported) nextEvidence = mergeCapabilityEvidenceRecords(
      nextEvidence, openRouterCatalogCapabilityEvidence(model, updatedAt),
    );
    synced += 1;
  }
  updateUserSettings({
    discoveredModelMetadata: nextMetadata,
    providerToolCapabilityEvidence: nextEvidence,
  });
  return { synced, missing };
}

export async function refreshProviderModelCapabilities(input: {
  providerId: string;
  modelIds?: string[];
  apiKey?: string;
  baseURL?: string;
  runnerToken?: string;
}): Promise<{ synced: number; missing: string[] }> {
  if (input.providerId === OPENROUTER_PROVIDER_ID) {
    return refreshOpenRouterModelCapabilities(input.modelIds);
  }
  const targets = (
    input.modelIds ?? getProviderKey(input.providerId)?.models ?? []
  )
    .map((id) => normalizeProviderModelId(input.providerId, id))
    .filter((id, index, all) => id.length > 0 && all.indexOf(id) === index);
  if (targets.length === 0) return { synced: 0, missing: [] };

  const catalog = await fetchProviderModelCatalog(input);
  const modelIndex = new Map(catalog.map((model) => [model.id, model]));
  const nextMetadata = { ...(getUserSettings().discoveredModelMetadata ?? {}) };
  const missing: string[] = [];
  let synced = 0;
  const updatedAt = new Date().toISOString();
  for (const id of targets) {
    const model = modelIndex.get(id);
    if (!model) {
      missing.push(id);
      continue;
    }
    const key = formatModelId(input.providerId, id);
    nextMetadata[key] = { ...discoveryMetadataFromCatalogModel(model, "provider-models", updatedAt), overrides: nextMetadata[key]?.overrides, supplemental: model.supplemental ?? nextMetadata[key]?.supplemental };
    synced += 1;
  }
  updateUserSettings({ discoveredModelMetadata: nextMetadata });
  return { synced, missing };
}

const TEST_IMAGE: AttachmentPayload = {
  id: "test-image-red-dot",
  filename: "tiny-red-square.png",
  mimeType: "image/png",
  category: "image",
  base64Data:
    "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJcEhZcwAADsMAAA7DAcdvqGQAAAAcSURBVDhPY7ijpvafEjxqwKgBIDxqwDAwQO0/AEkhJx9IQd3PAAAAAElFTkSuQmCC",
};

const TEST_SYSTEM =
  "You are validating that this model can answer a short settings test request.";
const VISION_PROMPT =
  "Look at the attached test image and reply with only 2 to 4 words describing its color and shape, for example 'red square'. Do not use a full sentence.";
const TEXT_PROMPT =
  "Reply with one short sentence confirming this model test works.";
// Generous ceiling so "thinking" models (e.g. local Gemma via Ollama, which
// streams its reasoning before any visible content) have room to finish
// reasoning AND emit an answer. Cloud models bill per token generated, so a high
// cap costs nothing for their short replies.
const TEST_MAX_TOKENS = 4096;
const DEFAULT_MODEL_TEST_TIMEOUT_MS = 30_000;

export interface ModelTestResult {
  valid: boolean;
  usedImage: boolean;
  preview?: string;
  error?: string;
}

async function collectPreview(
  stream: AsyncIterable<StreamChunk>,
  options: { signal?: AbortSignal; timeoutMs: number }
): Promise<{ preview: string; error?: string }> {
  const iterator = stream[Symbol.asyncIterator]();
  let preview = "";
  let error: string | undefined;
  try {
    for (;;) {
      const next = await nextPreviewChunk(iterator, options);
      if (next.done) break;
      const chunk = next.value;
      if (chunk.type === "error") {
        error = chunk.error ?? "Validation failed";
        break;
      }
      if (chunk.type === "token" && chunk.content) {
        preview += chunk.content;
        if (preview.length >= 240) break;
      }
    }
  } catch (err) {
    error = err instanceof Error ? err.message : "Validation failed";
  } finally {
    closePreviewIterator(iterator);
  }
  return { preview: preview.trim(), error };
}

function modelTestTimeoutMessage(timeoutMs: number): string {
  return `Model test timed out after ${(timeoutMs / 1000).toFixed(1)}s`;
}

async function nextPreviewChunk(
  iterator: AsyncIterator<StreamChunk>,
  options: { signal?: AbortSignal; timeoutMs: number }
): Promise<IteratorResult<StreamChunk>> {
  if (options.signal?.aborted) {
    closePreviewIterator(iterator);
    throw new Error(modelTestTimeoutMessage(options.timeoutMs));
  }
  if (!options.signal) return iterator.next();

  let abortHandler: (() => void) | undefined;
  const abortPromise = new Promise<never>((_, reject) => {
    abortHandler = () => {
      closePreviewIterator(iterator);
      reject(new Error(modelTestTimeoutMessage(options.timeoutMs)));
    };
    options.signal?.addEventListener("abort", abortHandler, { once: true });
  });

  try {
    return await Promise.race([iterator.next(), abortPromise]);
  } finally {
    if (abortHandler) {
      options.signal.removeEventListener("abort", abortHandler);
    }
  }
}

function closePreviewIterator(iterator: AsyncIterator<StreamChunk>): void {
  try {
    const closeResult = iterator.return?.();
    if (closeResult) {
      void Promise.resolve(closeResult).catch(() => undefined);
    }
  } catch {
    // The caller is already unwinding a completed, failed, or aborted stream.
  }
}

/**
 * Unified test used by every provider AND custom models: try the "red dot"
 * vision test when model metadata allows images, then fall back to a plain text
 * confirmation for text-only models or endpoints that reject images.
 */
type StreamFactory = (
  prompt: string,
  attachments: AttachmentPayload[],
  signal?: AbortSignal
) => AsyncIterable<StreamChunk>;

async function collectProbePreview(
  makeStream: StreamFactory,
  prompt: string,
  attachments: AttachmentPayload[],
  timeoutMs: number
): Promise<{ preview: string; error?: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await collectPreview(makeStream(prompt, attachments, controller.signal), {
      signal: controller.signal,
      timeoutMs,
    });
  } finally {
    clearTimeout(timer);
  }
}

function normalizeModelTestTimeoutMs(timeoutMs: number | undefined): number {
  return typeof timeoutMs === "number" && Number.isFinite(timeoutMs) && timeoutMs > 0
    ? Math.floor(timeoutMs)
    : DEFAULT_MODEL_TEST_TIMEOUT_MS;
}

async function runModelTest(
  makeStream: StreamFactory,
  options?: { allowImage?: boolean; timeoutMs?: number }
): Promise<ModelTestResult> {
  const timeoutMs = normalizeModelTestTimeoutMs(options?.timeoutMs);
  if (options?.allowImage !== false) {
    const vision = await collectProbePreview(
      makeStream,
      VISION_PROMPT,
      [TEST_IMAGE],
      timeoutMs
    );
    if (!vision.error && vision.preview.length > 0) {
      return { valid: true, usedImage: true, preview: vision.preview };
    }
  }
  const text = await collectProbePreview(makeStream, TEXT_PROMPT, [], timeoutMs);
  const valid = !text.error && text.preview.length > 0;
  return {
    valid,
    usedImage: false,
    preview: text.preview || undefined,
    error: valid ? undefined : text.error ?? "No response received from model",
  };
}

export async function validateProvider(input: {
  providerId: string;
  apiKey?: string;
  baseURL?: string;
  runnerToken?: string;
  modelId?: string;
}, options?: { timeoutMs?: number }): Promise<ModelTestResult & { modelId?: string }> {
  const provider = getProvider(input.providerId);
  if (!provider) return { valid: false, usedImage: false, error: "Unknown provider" };

  const saved = getProviderKey(input.providerId);
  const usingSaved = !input.apiKey;
  const apiKey = input.apiKey ?? saved?.apiKey ?? null;
  if (!apiKey) return { valid: false, usedImage: false, error: "No API key available" };
  const baseURL = input.baseURL?.trim() || saved?.baseURL || undefined;
  const runnerToken =
    input.runnerToken?.trim() || saved?.runnerToken || undefined;

  const modelId =
    input.modelId ??
    saved?.defaultModel ??
    listProviderModelInfos(input.providerId as ProviderId)[0]?.id;
  if (!modelId)
    return {
      valid: false,
      usedImage: false,
      error:
        input.providerId === FOUNDRY_PROVIDER_ID
          ? "Add at least one model id (e.g. claude-opus-4-5) and save first"
          : input.providerId === OPENROUTER_PROVIDER_ID
            ? "Add an OpenRouter model id (e.g. qwen/qwen3-coder) or pick a built-in OpenRouter model"
          : input.providerId === NVIDIA_PROVIDER_ID
            ? "Add at least one NVIDIA model id (e.g. z-ai/glm-5.2) and save first"
            : "No model available",
    };

  const capabilities = resolveModelCapabilities(formatModelId(input.providerId, modelId));
  const result = await runModelTest(
    (prompt, attachments, signal) =>
      provider.streamChat({
        apiKey,
        baseURL,
        runnerToken,
        model: modelId,
        messages: [
          { role: "system", content: TEST_SYSTEM },
          { role: "user", content: prompt },
        ],
        attachments,
        maxTokens: TEST_MAX_TOKENS,
        temperature: 0.2,
        signal,
      }),
    { allowImage: capabilities?.image !== false, timeoutMs: options?.timeoutMs }
  );

  if (usingSaved && saved) {
    updateProviderKey(input.providerId, {
      lastValidationSucceeded: result.valid,
      lastValidatedAt: new Date().toISOString(),
    });
  }
  return { ...result, modelId };
}

// ── Pricing overrides ─────────────────────────────────────────────────────────

function clearMetadataOverrideFields(fullModelId: string, fields: Array<keyof ModelMetadataValues>) {
  const metadata = { ...(getUserSettings().discoveredModelMetadata ?? {}) };
  const record = metadata[fullModelId];
  if (record?.overrides) {
    const overrides = { ...record.overrides };
    for (const field of fields) delete overrides[field];
    metadata[fullModelId] = { ...record, overrides };
  }
  return metadata;
}

export function savePricingOverride(input: {
  fullModelId: string;
  inputUsdPer1M?: number;
  outputUsdPer1M?: number;
  cachedInputUsdPer1M?: number | null;
  clear?: boolean;
}): void {
  const settings = getUserSettings();
  const next = { ...(settings.modelPricingOverrides ?? {}) };
  if (input.clear) {
    delete next[input.fullModelId];
  } else {
    if (input.inputUsdPer1M === undefined || input.outputUsdPer1M === undefined) {
      throw new Error("Input and output pricing are required");
    }
    next[input.fullModelId] = {
      inputUsdPer1M: input.inputUsdPer1M,
      outputUsdPer1M: input.outputUsdPer1M,
      cachedInputUsdPer1M: input.cachedInputUsdPer1M ?? null,
      updatedAt: new Date().toISOString(),
    };
  }
  updateUserSettings({ modelPricingOverrides: next,
    ...(input.clear ? { discoveredModelMetadata: clearMetadataOverrideFields(input.fullModelId, ["inputUsdPer1M", "outputUsdPer1M", "cachedInputUsdPer1M"]) } : {}),
  });
}

// ── Context overrides ─────────────────────────────────────────────────────────

export function saveModelContextOverride(input: {
  fullModelId: string;
  contextWindowTokens?: number;
  maxOutputTokens?: number;
  buildOutputReserveTokens?: number;
  effectiveBuildInputCeilingTokens?: number;
  longContextQuality?: ModelContextProfileOverride["longContextQuality"];
  promptCaching?: boolean;
  recommendedBuildRoles?: ModelContextProfileOverride["recommendedBuildRoles"];
  clearBuildSettings?: boolean;
  clear?: boolean;
}): void {
  const settings = getUserSettings();
  const next = { ...(settings.modelContextOverrides ?? {}) };
  if (input.clear) {
    delete next[input.fullModelId];
  } else if (input.clearBuildSettings) {
    const previous = next[input.fullModelId];
    const limits = {
      ...(previous?.contextWindowTokens != null ? { contextWindowTokens: previous.contextWindowTokens } : {}),
      ...(previous?.maxOutputTokens != null ? { maxOutputTokens: previous.maxOutputTokens } : {}),
    };
    if (Object.keys(limits).length) next[input.fullModelId] = { ...limits, updatedAt: new Date().toISOString() };
    else delete next[input.fullModelId];
  } else {
    next[input.fullModelId] = {
      ...(input.contextWindowTokens !== undefined
        ? { contextWindowTokens: input.contextWindowTokens }
        : {}),
      ...(input.maxOutputTokens !== undefined
        ? { maxOutputTokens: input.maxOutputTokens }
        : {}),
      ...(input.buildOutputReserveTokens !== undefined
        ? { buildOutputReserveTokens: input.buildOutputReserveTokens }
        : {}),
      ...(input.effectiveBuildInputCeilingTokens !== undefined
        ? {
            effectiveBuildInputCeilingTokens:
              input.effectiveBuildInputCeilingTokens,
          }
        : {}),
      ...(input.longContextQuality !== undefined
        ? { longContextQuality: input.longContextQuality }
        : {}),
      ...(input.promptCaching !== undefined
        ? { promptCaching: input.promptCaching }
        : {}),
      ...(input.recommendedBuildRoles !== undefined
        ? { recommendedBuildRoles: input.recommendedBuildRoles }
        : {}),
      updatedAt: new Date().toISOString(),
    };
  }
  updateUserSettings({ modelContextOverrides: next,
    ...(input.clear ? { discoveredModelMetadata: clearMetadataOverrideFields(input.fullModelId, ["contextWindowTokens", "maxOutputTokens"]) } : {}),
  });
}

// ── Custom models ─────────────────────────────────────────────────────────────

const NO_CAPS = { image: false, document: false, audio: false, video: false };

export interface CustomModelView {
  id: string;
  label: string;
  baseURL: string;
  model: string;
  hasKey: boolean;
  capabilities: { image: boolean; document: boolean; audio: boolean; video: boolean };
  toolCapabilityOverrides: ToolCapabilityDescriptor[];
  compatibleTransports: ProviderTransportId[];
  reasoningEffort?: ReasoningEffort;
  lastValidationSucceeded?: boolean | null;
  lastValidatedAt?: string | null;
}

function redactCustom(m: CustomModel): CustomModelView {
  return {
    id: m.id,
    label: m.label,
    baseURL: m.baseURL,
    model: m.model,
    hasKey: !!m.apiKey,
    capabilities: m.capabilities ?? { ...NO_CAPS },
    toolCapabilityOverrides: m.toolCapabilityOverrides ?? [],
    compatibleTransports: customCompatibleTransports(m.compatibleTransports),
    reasoningEffort: m.reasoningEffort ?? "default",
    lastValidationSucceeded: m.lastValidationSucceeded ?? null,
    lastValidatedAt: m.lastValidatedAt ?? null,
  };
}

export function listCustomModels(): CustomModelView[] {
  return getCustomModels().map(redactCustom);
}

export function addCustomModel(input: {
  label: string;
  baseURL: string;
  model: string;
  apiKey?: string;
  capabilities?: CustomModelView["capabilities"];
  toolCapabilityOverrides?: ToolCapabilityDescriptor[];
  compatibleTransports?: ProviderTransportId[];
  reasoningEffort?: ReasoningEffort;
}): CustomModelView {
  const record: CustomModel = {
    id: uuidv4(),
    label: input.label,
    baseURL: input.baseURL,
    model: input.model,
    apiKey: input.apiKey || undefined,
    hasKey: !!input.apiKey,
    capabilities: input.capabilities ?? { ...NO_CAPS },
    toolCapabilityOverrides: input.toolCapabilityOverrides ?? [],
    compatibleTransports: customCompatibleTransports(input.compatibleTransports),
    reasoningEffort: input.reasoningEffort ?? "default",
    createdAt: new Date().toISOString(),
  };
  storeAddCustomModel(record);
  return redactCustom(record);
}

export function updateCustomModelCapabilities(
  id: string,
  capabilities: CustomModelView["capabilities"]
): void {
  storeUpdateCustomModel(id, { capabilities });
}

export function updateCustomModelToolConfiguration(
  id: string,
  input: {
    toolCapabilityOverrides: ToolCapabilityDescriptor[];
    compatibleTransports: ProviderTransportId[];
  },
): void {
  storeUpdateCustomModel(id, {
    toolCapabilityOverrides: input.toolCapabilityOverrides,
    compatibleTransports: customCompatibleTransports(input.compatibleTransports),
  });
}
export function updateCustomModelReasoning(id: string, effort: ReasoningEffort): void {
  storeUpdateCustomModel(id, { reasoningEffort: effort, lastValidationSucceeded: null });
}
export function deleteCustomModel(id: string): void {
  storeDeleteCustomModel(id);
}

export async function testCustomModel(input: {
  baseURL: string;
  model: string;
  apiKey?: string;
  capabilities?: { image?: boolean };
  reasoningEffort?: ReasoningEffort;
}): Promise<ModelTestResult> {
  const localOllama = isLoopbackOllamaEndpoint(input.baseURL);
  const client = new OpenAI({
    apiKey: input.apiKey || "not-needed",
    baseURL: input.baseURL,
    dangerouslyAllowBrowser: true,
  });
  // A text-only model must not waste its first probe on an unsupported image.
  // Cold-starting Ollama on a 10 GB GPU may exceed the cloud-model timeout.
  const result = await runModelTest((prompt, attachments, signal) =>
    streamOpenAICompatibleChat(
      client,
      {
        apiKey: input.apiKey ?? "",
        model: input.model,
        messages: [
          { role: "system", content: TEST_SYSTEM },
          { role: "user", content: prompt },
        ],
        attachments,
        // Keep the connection test cheap when thinking is disabled, but allow
        // thinking-capable local models enough tokens to reach a visible answer.
        maxTokens: localOllama && input.reasoningEffort === "none" ? 256 : TEST_MAX_TOKENS,
        reasoningEffort: input.reasoningEffort ?? "default",
        temperature: 0.2,
        signal,
        capabilities: { image: input.capabilities?.image === true, document: false, audio: false, video: false },
      },
      CUSTOM_PROVIDER_ID,
      input.model,
      "max_tokens"
    ),
    { allowImage: input.capabilities?.image === true, timeoutMs: localOllama ? 90_000 : undefined }
  );
  if (localOllama && !result.valid && result.error === "No response received from model") {
    return { ...result, error: `Ollama returned no visible answer using reasoning ${input.reasoningEffort ?? "default"}. Choose Off to verify text generation, or select a supported reasoning level and retest.` };
  }
  return result;
}

/** Test a saved custom model by id (uses its stored key/base URL), and record
 * the result so the list can show a "Connection verified" badge like providers. */
export async function testSavedCustomModel(id: string): Promise<ModelTestResult> {
  const model = getCustomModelById(id);
  if (!model) return { valid: false, usedImage: false, error: "Model not found" };
  const result = await testCustomModel({
    baseURL: model.baseURL,
    model: model.model,
    apiKey: model.apiKey,
    capabilities: model.capabilities,
    reasoningEffort: model.reasoningEffort,
  });
  storeUpdateCustomModel(id, {
    lastValidationSucceeded: result.valid,
    lastValidatedAt: new Date().toISOString(),
  });
  return result;
}

// ── Attachments ───────────────────────────────────────────────────────────────

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(
      ...(bytes.subarray(i, i + chunk) as unknown as number[])
    );
  }
  return btoa(binary);
}

export async function saveAttachmentFile(file: File): Promise<AttachmentSummary> {
  const category = classifyMimeType(file.type, file.name);
  const id = uuidv4();
  const mimeType = file.type || "application/octet-stream";

  let textContent: string | undefined;
  let base64Data: string | undefined;
  if (category === "text_inline") {
    textContent = await file.text();
  } else {
    base64Data = arrayBufferToBase64(await file.arrayBuffer());
  }

  addAttachment({
    id,
    filename: file.name,
    mimeType,
    category,
    size: file.size,
    textContent,
    base64Data,
    createdAt: new Date().toISOString(),
  });

  return { id, filename: file.name, mimeType, category, size: file.size };
}

export function deleteAttachmentFile(id: string): void {
  deleteAttachmentRecord(id);
}

export function getAttachmentDataUrl(id: string): string | null {
  const record = getAttachment(id);
  if (!record?.base64Data) return null;
  return `data:${record.mimeType};base64,${record.base64Data}`;
}
