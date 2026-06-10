import OpenAI from "openai";
import type { ChatParams, ModelInfo, StreamChunk } from "./base";
import { parseModelId } from "./base";
import { streamOpenAICompatibleChat } from "./openai-compat";
import { getCustomModels, getCustomModelById } from "../db";
import { decrypt } from "../crypto/keys";
import type { CustomModel } from "../db/schema";

export const CUSTOM_PROVIDER_ID = "custom";

const TEXT_ONLY_CAPABILITIES = {
  image: false,
  document: false,
  audio: false,
  video: false,
} as const;

export function customModelToInfo(model: CustomModel): ModelInfo {
  return {
    id: model.id,
    name: model.label,
    providerId: CUSTOM_PROVIDER_ID,
    description: `Custom · ${model.model}`,
    capabilities: model.capabilities ?? { ...TEXT_ONLY_CAPABILITIES },
  };
}

export function listCustomModelInfos(): ModelInfo[] {
  return getCustomModels().map(customModelToInfo);
}

/** Resolve a `custom:<id>` full id back to its stored record. */
export function getCustomModelByFullId(fullId: string): CustomModel | null {
  const { providerId, model } = parseModelId(fullId);
  if (providerId !== CUSTOM_PROVIDER_ID) return null;
  return getCustomModelById(model) ?? null;
}

export function resolveCustomModelName(fullId: string): string | null {
  return getCustomModelByFullId(fullId)?.label ?? null;
}

function decryptCustomKey(model: CustomModel): string | null {
  if (model.apiKey) return model.apiKey;
  if (!model.hasKey || !model.encryptedKey || !model.iv || !model.authTag) {
    return null;
  }
  try {
    return decrypt({
      encrypted: model.encryptedKey,
      iv: model.iv,
      authTag: model.authTag,
    });
  } catch {
    return null;
  }
}

/**
 * Stream from a custom OpenAI-compatible endpoint. The OpenAI SDK requires a
 * non-empty apiKey even for keyless local servers, so a placeholder is used.
 */
export async function* streamCustomChat(
  model: CustomModel,
  params: ChatParams
): AsyncIterable<StreamChunk> {
  const apiKey = decryptCustomKey(model) ?? "not-needed";
  const client = new OpenAI({ apiKey, baseURL: model.baseURL });
  yield* streamOpenAICompatibleChat(
    client,
    {
      ...params,
      model: model.model,
      capabilities: model.capabilities ?? { ...TEXT_ONLY_CAPABILITIES },
    },
    CUSTOM_PROVIDER_ID,
    model.label,
    "max_tokens"
  );
}
