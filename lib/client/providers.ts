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
import { parseModelId } from "@/lib/providers/base";
import {
  resolveModelContextProfile,
  type ModelContextOverrides,
} from "@/lib/providers/model-context";
import { openaiProvider } from "@/lib/providers/openai";
import { anthropicProvider } from "@/lib/providers/anthropic";
import { foundryProvider } from "@/lib/providers/foundry";
import { googleProvider } from "@/lib/providers/google";
import { openrouterProvider } from "@/lib/providers/openrouter";
import { xaiProvider } from "@/lib/providers/xai";
import { chatgptProvider } from "@/lib/providers/chatgpt";
import { githubCopilotProvider } from "@/lib/providers/github-copilot";
import { nvidiaProvider } from "@/lib/providers/nvidia";
import { getModelDisplayName } from "@/lib/providers/catalog";
import { PROVIDER_IDS, type ProviderId } from "@/lib/providers/constants";
import { streamOpenAICompatibleChat } from "@/lib/providers/openai-compat";
import type { CustomModel } from "@/lib/db/schema";
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

const TEXT_ONLY = {
  image: false,
  document: false,
  audio: false,
  video: false,
} as const;

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

/** User-defined NVIDIA NIM model ids (from the provider key). */
export function normalizeNvidiaModelId(id: string): string {
  const trimmed = id.trim();
  const parsed = parseModelId(trimmed);
  return parsed.providerId === NVIDIA_PROVIDER_ID ? parsed.model : trimmed;
}

function nvidiaCapabilitiesForModel(modelId: string) {
  return {
    ...(NVIDIA_MODEL_CAPABILITIES[modelId] ?? TEXT_ONLY),
  };
}

export function listNvidiaModelInfos(): ModelInfo[] {
  const ids = getProviderKey(NVIDIA_PROVIDER_ID)?.models ?? [];
  return ids
    .map(normalizeNvidiaModelId)
    .filter((id) => id.length > 0)
    .map((id) => ({
      id,
      name: id,
      providerId: NVIDIA_PROVIDER_ID,
      description: "NVIDIA NIM model",
      capabilities: nvidiaCapabilitiesForModel(id),
    }));
}

export function getAllModels(): ModelInfo[] {
  const overrides = getUserSettings().modelContextOverrides;
  return withContextProfiles(
    [
      ...getAllProviders().flatMap((p) => p.listModels()),
      ...listFoundryModelInfos(),
      ...listNvidiaModelInfos(),
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
    .map((p) => p.id)
    .filter((id) => getDecryptedApiKey(id) !== null);
  const builtin = getAllProviders()
    .flatMap((p) => p.listModels())
    .filter((m) => keyed.includes(m.providerId));
  const foundry = keyed.includes(FOUNDRY_PROVIDER_ID)
    ? listFoundryModelInfos()
    : [];
  const nvidia = keyed.includes(NVIDIA_PROVIDER_ID)
    ? listNvidiaModelInfos()
    : [];
  return withContextProfiles(
    [...builtin, ...foundry, ...nvidia, ...listCustomModelInfos()],
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
  // Foundry model ids are user-defined (not in the catalog) — show the id.
  if (providerId === FOUNDRY_PROVIDER_ID) return model;
  if (providerId === NVIDIA_PROVIDER_ID) return model;
  const providerModel = getProvider(providerId)
    ?.listModels()
    .find((m) => m.id === model);
  if (providerModel) return providerModel.name;
  return getModelDisplayName(fullId);
}

/**
 * Capabilities for a full model id, resolving user-defined gateway models
 * (Foundry/custom) that aren't in the static catalog.
 */
export function resolveModelCapabilities(fullId: string) {
  const { providerId, model } = parseModelId(fullId);
  if (providerId === FOUNDRY_PROVIDER_ID) return { ...FOUNDRY_CAPABILITIES };
  if (providerId === NVIDIA_PROVIDER_ID) return nvidiaCapabilitiesForModel(model);
  if (providerId === CUSTOM_PROVIDER_ID) {
    return getCustomModelById(model)?.capabilities ?? { ...TEXT_ONLY };
  }
  const providerModel = getProvider(providerId)
    ?.listModels()
    .find((m) => m.id === model);
  return providerModel?.capabilities ?? null; // otherwise use the catalog registry
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
  });
  yield* streamOpenAICompatibleChat(
    client,
    {
      ...params,
      model: model.model,
      capabilities: model.capabilities ?? { ...TEXT_ONLY },
    },
    CUSTOM_PROVIDER_ID,
    model.label,
    "max_tokens"
  );
}
