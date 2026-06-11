/**
 * Browser-safe provider registry + key/model resolution, reading from the
 * client store. Mirrors lib/providers/index.ts + the custom provider, but
 * without the Node-only crypto/fs imports.
 */

import OpenAI from "openai";
import type {
  AIProvider,
  ChatParams,
  ModelInfo,
  StreamChunk,
} from "@/lib/providers/base";
import { parseModelId } from "@/lib/providers/base";
import { openaiProvider } from "@/lib/providers/openai";
import { anthropicProvider } from "@/lib/providers/anthropic";
import { foundryProvider } from "@/lib/providers/foundry";
import { googleProvider } from "@/lib/providers/google";
import { openrouterProvider } from "@/lib/providers/openrouter";
import { getModelDisplayName } from "@/lib/providers/catalog";
import { streamOpenAICompatibleChat } from "@/lib/providers/openai-compat";
import type { CustomModel } from "@/lib/db/schema";
import { getCustomModelById, getCustomModels, getProviderKey } from "./store";

export const CUSTOM_PROVIDER_ID = "custom";
export const FOUNDRY_PROVIDER_ID = "foundry";

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

const providers: Record<string, AIProvider> = {
  openai: openaiProvider,
  anthropic: anthropicProvider,
  foundry: foundryProvider,
  google: googleProvider,
  openrouter: openrouterProvider,
};

export function getProvider(id: string): AIProvider | undefined {
  return providers[id];
}

export function getAllProviders(): AIProvider[] {
  return Object.values(providers);
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
export function listFoundryModelInfos(): ModelInfo[] {
  const ids = getProviderKey(FOUNDRY_PROVIDER_ID)?.models ?? [];
  return ids
    .map((id) => id.trim())
    .filter((id) => id.length > 0)
    .map((id) => ({
      id,
      name: id,
      providerId: FOUNDRY_PROVIDER_ID,
      description: "Azure AI Foundry deployment",
      capabilities: { ...FOUNDRY_CAPABILITIES },
    }));
}

export function getAllModels(): ModelInfo[] {
  return [
    ...getAllProviders().flatMap((p) => p.listModels()),
    ...listFoundryModelInfos(),
    ...listCustomModelInfos(),
  ];
}

/** Client keys are stored as plaintext apiKey (protected by the store envelope). */
export function getDecryptedApiKey(providerId: string): string | null {
  const row = getProviderKey(providerId);
  if (!row || !row.enabled) return null;
  return row.apiKey ?? null;
}

/** Endpoint override saved with the key (gateway providers, e.g. Foundry). */
export function getProviderBaseURL(providerId: string): string | undefined {
  return getProviderKey(providerId)?.baseURL ?? undefined;
}

export function getEnabledModels(): ModelInfo[] {
  const keyed = getAllProviders()
    .map((p) => p.id)
    .filter((id) => getDecryptedApiKey(id) !== null);
  const builtin = getAllProviders()
    .flatMap((p) => p.listModels())
    .filter((m) => keyed.includes(m.providerId));
  const foundry = keyed.includes(FOUNDRY_PROVIDER_ID)
    ? listFoundryModelInfos()
    : [];
  return [...builtin, ...foundry, ...listCustomModelInfos()];
}

export function resolveModelName(fullId: string): string {
  const { providerId, model } = parseModelId(fullId);
  if (providerId === CUSTOM_PROVIDER_ID) {
    return getCustomModelById(model)?.label ?? model;
  }
  // Foundry model ids are user-defined (not in the catalog) — show the id.
  if (providerId === FOUNDRY_PROVIDER_ID) return model;
  return getModelDisplayName(fullId);
}

/**
 * Capabilities for a full model id, resolving user-defined gateway models
 * (Foundry/custom) that aren't in the static catalog.
 */
export function resolveModelCapabilities(fullId: string) {
  const { providerId, model } = parseModelId(fullId);
  if (providerId === FOUNDRY_PROVIDER_ID) return { ...FOUNDRY_CAPABILITIES };
  if (providerId === CUSTOM_PROVIDER_ID) {
    return getCustomModelById(model)?.capabilities ?? { ...TEXT_ONLY };
  }
  return null; // use the catalog registry
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
