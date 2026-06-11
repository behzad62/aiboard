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

const TEXT_ONLY = {
  image: false,
  document: false,
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

export function getAllModels(): ModelInfo[] {
  return [
    ...getAllProviders().flatMap((p) => p.listModels()),
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
  return [...builtin, ...listCustomModelInfos()];
}

export function resolveModelName(fullId: string): string {
  const { providerId, model } = parseModelId(fullId);
  if (providerId === CUSTOM_PROVIDER_ID) {
    return getCustomModelById(model)?.label ?? model;
  }
  return getModelDisplayName(fullId);
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
