/**
 * Browser-safe provider registry + key/model resolution, reading from the
 * client store. Mirrors lib/providers/index.ts + the custom provider, but
 * without the Node-only crypto/fs imports.
 */

import OpenAI from "openai";
import type {
  AIProvider,
  ChatParams,
  ModelCapabilities,
  ModelInfo,
  StreamChunk,
} from "@/lib/providers/base";
import { formatModelId, parseModelId } from "@/lib/providers/base";
import {
  resolveModelContextProfile,
  type ModelContextOverrides,
} from "@/lib/providers/model-context";
import { openaiProvider, streamOpenAIResponses } from "@/lib/providers/openai";
import { anthropicProvider } from "@/lib/providers/anthropic";
import { foundryProvider } from "@/lib/providers/foundry";
import { googleProvider } from "@/lib/providers/google";
import { openrouterProvider } from "@/lib/providers/openrouter";
import { xaiProvider } from "@/lib/providers/xai";
import { metaProvider } from "@/lib/providers/meta";
import { chatgptProvider } from "@/lib/providers/chatgpt";
import { githubCopilotProvider } from "@/lib/providers/github-copilot";
import { nvidiaProvider } from "@/lib/providers/nvidia";
import { getModelDisplayName } from "@/lib/providers/catalog";
import { PROVIDER_IDS, type ProviderId } from "@/lib/providers/constants";
import { streamOpenAICompatibleChat } from "@/lib/providers/openai-compat";
import { customCompatibleTransports } from "@/lib/providers/custom-capabilities";
import type { CustomModel } from "@/lib/db/schema";
import type {
  CapabilityEvidence,
  ProviderTransportId,
} from "@/lib/providers/tool-capabilities";
import {
  ACCOUNT_RUNNER_CAPABILITY_MINIMUM_VERSION,
  getCachedAccountRunnerCapabilities,
} from "@/lib/providers/account-runner";
import {
  runnerCapabilityEvidence,
  type RunnerCapabilityProviderId,
  type RunnerCapabilityValidationResult,
} from "@/lib/providers/runner-capabilities";
import {
  getCustomModelById,
  getCustomModels,
  getProviderKey,
  getUserSettings,
} from "./store";

export const CUSTOM_PROVIDER_ID = "custom";
export const FOUNDRY_PROVIDER_ID = "foundry";
export const CHATGPT_PROVIDER_ID = "chatgpt";
export const GITHUB_COPILOT_PROVIDER_ID = "github-copilot";
export const NVIDIA_PROVIDER_ID = "nvidia";
export const OPENROUTER_PROVIDER_ID = "openrouter";

const RUNNER_CAPABILITY_PROVIDER_IDS = new Set<RunnerCapabilityProviderId>([
  "chatgpt",
  "github-copilot",
  "nvidia",
]);

export interface RunnerCapabilityPlanningContext {
  evidence?: CapabilityEvidence[];
  allowedTransports?: ProviderTransportId[];
  validation?: RunnerCapabilityValidationResult;
}

export function isRunnerCapabilityProvider(
  providerId: string,
): providerId is RunnerCapabilityProviderId {
  return RUNNER_CAPABILITY_PROVIDER_IDS.has(providerId as RunnerCapabilityProviderId);
}

export async function getRunnerCapabilityPlanningContext(
  providerId: string,
  modelId: string,
  signal?: AbortSignal,
  connectionOverride?: {
    baseURL?: string;
    runnerToken?: string;
    apiKey?: string;
  },
): Promise<RunnerCapabilityPlanningContext> {
  if (!isRunnerCapabilityProvider(providerId)) return {};
  const needsStoredConnection =
    !connectionOverride?.baseURL ||
    !connectionOverride?.runnerToken ||
    (providerId === "nvidia" && !connectionOverride?.apiKey);
  const row = needsStoredConnection ? getProviderKey(providerId) : undefined;
  const baseURL = connectionOverride?.baseURL ?? row?.baseURL ?? undefined;
  const providerApiKey = connectionOverride?.apiKey ?? row?.apiKey ?? undefined;
  const runnerToken =
    connectionOverride?.runnerToken ??
    (providerId === "nvidia" ? row?.runnerToken ?? undefined : providerApiKey);
  if (!baseURL?.trim() || !runnerToken?.trim()) return {};

  const validation = await getCachedAccountRunnerCapabilities({
    baseURL,
    runnerToken,
    providerId,
    ...(providerId === "nvidia" && providerApiKey ? { apiKey: providerApiKey } : {}),
    signal,
    minimumRunnerVersion: ACCOUNT_RUNNER_CAPABILITY_MINIMUM_VERSION,
  });
  if (validation.status !== "valid") return { validation, evidence: [] };
  return {
    validation,
    evidence: runnerCapabilityEvidence(validation, modelId),
    allowedTransports: [...validation.handshake.transports],
  };
}

const TEXT_ONLY = {
  image: false,
  document: false,
  audio: false,
  video: false,
} as const;

function getDiscoveredCapabilities(fullModelId: string): ModelCapabilities | null {
  const metadata = getUserSettings().discoveredModelMetadata?.[fullModelId];
  if (!metadata) return null;
  return {
    image: metadata.image,
    document: metadata.document,
    audio: metadata.audio,
    video: metadata.video,
  };
}

export function getDiscoveredModelMetadata(fullModelId: string) {
  return getUserSettings().discoveredModelMetadata?.[fullModelId] ?? null;
}

export function getPersistedProviderCapabilityEvidence(
  providerId: string,
  modelId: string,
  nowMs = Date.now(),
): CapabilityEvidence[] | undefined {
  const evidence = (getUserSettings().providerToolCapabilityEvidence ?? []).filter((item) => {
    if (item.providerId !== providerId) return false;
    if (item.modelId !== undefined && item.modelId !== modelId) return false;
    if (item.expiresAt) {
      const expiresAt = Date.parse(item.expiresAt);
      if (Number.isFinite(expiresAt) && expiresAt <= nowMs) return false;
    }
    return true;
  });
  return evidence.length > 0 ? evidence : undefined;
}

/** Compatibility alias for callers/tests that still use the OpenRouter-specific name. */
export function getDiscoveredOpenRouterApiCapabilities(modelId: string) {
  return getDiscoveredModelMetadata(
    formatModelId(OPENROUTER_PROVIDER_ID, normalizeOpenRouterModelId(modelId)),
  );
}

export function getDiscoveredOpenRouterCapabilityEvidence(
  modelId: string,
): CapabilityEvidence[] | undefined {
  return getPersistedProviderCapabilityEvidence(
    OPENROUTER_PROVIDER_ID,
    normalizeOpenRouterModelId(modelId),
  );
}

// Foundry serves Claude models, which accept image + document inputs.
const FOUNDRY_CAPABILITIES = {
  image: true,
  document: true,
  audio: false,
  video: false,
} as const;

const NVIDIA_MODEL_CAPABILITIES: Record<string, ModelCapabilities> = {
  "minimaxai/minimax-m3": {
    image: true,
    document: false,
    audio: false,
    video: false,
  },
};

const providers: Record<ProviderId, AIProvider> = {
  openai: openaiProvider,
  anthropic: anthropicProvider,
  foundry: foundryProvider,
  google: googleProvider,
  openrouter: openrouterProvider,
  xai: xaiProvider,
  meta: metaProvider,
  chatgpt: chatgptProvider,
  "github-copilot": githubCopilotProvider,
  nvidia: nvidiaProvider,
};

export function getProvider(id: string): AIProvider | undefined {
  return providers[id as ProviderId];
}

export function getAllProviders(): AIProvider[] {
  return PROVIDER_IDS.map((id) => providers[id]);
}

function withContextProfile(
  model: ModelInfo,
  overrides?: ModelContextOverrides
): ModelInfo {
  return {
    ...model,
    contextProfile: resolveModelContextProfile(
      model.id,
      model.providerId,
      overrides
    ),
  };
}

function withContextProfiles(
  models: ModelInfo[],
  overrides?: ModelContextOverrides
): ModelInfo[] {
  return models.map((model) => withContextProfile(model, overrides));
}

export function customModelPlanningContext(model: CustomModel): {
  customOverrides: CustomModel["toolCapabilityOverrides"];
  allowedTransports: ProviderTransportId[];
} {
  return {
    customOverrides: model.toolCapabilityOverrides ?? [],
    allowedTransports: customCompatibleTransports(model.compatibleTransports),
  };
}
function customModelToInfo(model: CustomModel): ModelInfo {
  return {
    id: model.id,
    name: model.label,
    providerId: CUSTOM_PROVIDER_ID,
    description: `Custom · ${model.model}`,
    capabilities: model.capabilities ?? { ...TEXT_ONLY },
  };
}

export function listCustomModelInfos(): ModelInfo[] {
  return getCustomModels().map(customModelToInfo);
}

/** User-defined Azure Foundry model ids (from the provider key). */
export function normalizeFoundryModelId(id: string): string {
  const trimmed = id.trim();
  const parsed = parseModelId(trimmed);
  return parsed.providerId === FOUNDRY_PROVIDER_ID ? parsed.model : trimmed;
}

export function listFoundryModelInfos(): ModelInfo[] {
  const ids = getProviderKey(FOUNDRY_PROVIDER_ID)?.models ?? [];
  return ids
    .map(normalizeFoundryModelId)
    .filter((id) => id.length > 0)
    .map((id) => ({
      id,
      name: id,
      providerId: FOUNDRY_PROVIDER_ID,
      description: "Azure AI Foundry deployment",
      capabilities: { ...FOUNDRY_CAPABILITIES },
    }));
}

export function normalizeProviderModelId(providerId: string, id: string): string {
  const trimmed = id.trim();
  const parsed = parseModelId(trimmed);
  return parsed.providerId === providerId ? parsed.model : trimmed;
}

export function normalizeOpenRouterModelId(id: string): string {
  return normalizeProviderModelId(OPENROUTER_PROVIDER_ID, id);
}

/** Built-in models plus user-added live-catalog ids for one provider. */
export function listProviderModelInfos(providerId: ProviderId): ModelInfo[] {
  if (providerId === FOUNDRY_PROVIDER_ID) return listFoundryModelInfos();

  const provider = getProvider(providerId);
  const catalogModels = provider?.listModels() ?? [];
  const knownIds = new Set(catalogModels.map((model) => model.id));
  const additions = (getProviderKey(providerId)?.models ?? [])
    .map((id) => normalizeProviderModelId(providerId, id))
    .filter((id) => id.length > 0 && !knownIds.has(id))
    .map((id) => ({
      id,
      name: id,
      providerId,
      description: `User-added ${provider?.name ?? providerId} model`,
      capabilities:
        getDiscoveredCapabilities(formatModelId(providerId, id)) ??
        (providerId === NVIDIA_PROVIDER_ID
          ? { ...(NVIDIA_MODEL_CAPABILITIES[id] ?? TEXT_ONLY) }
          : { ...TEXT_ONLY }),
    }));
  return [...catalogModels, ...additions];
}

export function listOpenRouterModelInfos(): ModelInfo[] {
  return listProviderModelInfos(OPENROUTER_PROVIDER_ID);
}

export function normalizeNvidiaModelId(id: string): string {
  return normalizeProviderModelId(NVIDIA_PROVIDER_ID, id);
}


export function listNvidiaModelInfos(): ModelInfo[] {
  return listProviderModelInfos(NVIDIA_PROVIDER_ID);
}

export function getAllModels(): ModelInfo[] {
  const overrides = getUserSettings().modelContextOverrides;
  return withContextProfiles(
    [
      ...getAllProviders().flatMap((provider) =>
        listProviderModelInfos(provider.id as ProviderId)
      ),
      ...listCustomModelInfos(),
    ],
    overrides
  );
}

/** Client keys are stored as plaintext apiKey (protected by the store envelope). */
export function getDecryptedApiKey(providerId: string): string | null {
  const row = getProviderKey(providerId);
  if (!row || !row.enabled) return null;
  return row.apiKey ?? null;
}

/** Endpoint override saved with the key (gateway providers, e.g. Foundry/account runners). */
export function getProviderBaseURL(providerId: string): string | undefined {
  return getProviderKey(providerId)?.baseURL ?? undefined;
}

/** Local provider-runner token saved separately from provider API keys. */
export function getProviderRunnerToken(providerId: string): string | undefined {
  return getProviderKey(providerId)?.runnerToken ?? undefined;
}

export function getEnabledModels(): ModelInfo[] {
  const overrides = getUserSettings().modelContextOverrides;
  const keyed = getAllProviders()
    .map((p) => p.id as ProviderId)
    .filter((id) => getDecryptedApiKey(id) !== null);
  return withContextProfiles(
    [
      ...keyed.flatMap((providerId) => listProviderModelInfos(providerId)),
      ...listCustomModelInfos(),
    ],
    overrides
  );
}

export function resolveClientModelContextProfile(fullId: string) {
  const { providerId, model } = parseModelId(fullId);
  return resolveModelContextProfile(
    model,
    providerId,
    getUserSettings().modelContextOverrides
  );
}

export function resolveModelName(fullId: string): string {
  const { providerId, model } = parseModelId(fullId);
  if (providerId === CUSTOM_PROVIDER_ID) {
    return getCustomModelById(model)?.label ?? model;
  }
  if (PROVIDER_IDS.includes(providerId as ProviderId)) {
    return (
      listProviderModelInfos(providerId as ProviderId).find((entry) => entry.id === model)
        ?.name ?? model
    );
  }
  return getModelDisplayName(fullId);
}

/**
 * Capabilities for a full model id, resolving user-defined gateway models
 * (Foundry/custom) that aren't in the static catalog.
 */
export function resolveModelCapabilities(fullId: string) {
  const { providerId, model } = parseModelId(fullId);
  if (providerId === CUSTOM_PROVIDER_ID) {
    return getCustomModelById(model)?.capabilities ?? { ...TEXT_ONLY };
  }
  if (!PROVIDER_IDS.includes(providerId as ProviderId)) return null;
  return (
    listProviderModelInfos(providerId as ProviderId).find((entry) => entry.id === model)
      ?.capabilities ?? null
  );
}

export function getCustomModelByFullId(fullId: string): CustomModel | null {
  const { providerId, model } = parseModelId(fullId);
  if (providerId !== CUSTOM_PROVIDER_ID) return null;
  return getCustomModelById(model) ?? null;
}

export async function* streamCustomChat(
  model: CustomModel,
  params: ChatParams
): AsyncIterable<StreamChunk> {
  const client = new OpenAI({
    apiKey: model.apiKey || "not-needed",
    baseURL: model.baseURL,
    dangerouslyAllowBrowser: true,
    ...(params.disableAutomaticRetries ? { maxRetries: 0 } : {}),
  });
  const prepared = {
    ...params,
    model: model.model,
    capabilities: model.capabilities ?? { ...TEXT_ONLY },
  };
  if (params.callPlan?.transport === "responses") {
    yield* streamOpenAIResponses(client, prepared, "custom");
    return;
  }
  yield* streamOpenAICompatibleChat(
    client,
    prepared,
    CUSTOM_PROVIDER_ID,
    model.label,
    "max_tokens"
  );
}
