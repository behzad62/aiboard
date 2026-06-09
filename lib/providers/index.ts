import type { AIProvider, ModelInfo } from "./base";
import { openaiProvider } from "./openai";
import { anthropicProvider } from "./anthropic";
import { googleProvider } from "./google";
import { openrouterProvider } from "./openrouter";
import { decrypt } from "../crypto/keys";
import { getProviderKey } from "../db";

const providers: Record<string, AIProvider> = {
  openai: openaiProvider,
  anthropic: anthropicProvider,
  google: googleProvider,
  openrouter: openrouterProvider,
};

export function getProvider(id: string): AIProvider | undefined {
  return providers[id];
}

export function getAllProviders(): AIProvider[] {
  return Object.values(providers);
}

export function getAllModels(): ModelInfo[] {
  return getAllProviders().flatMap((p) => p.listModels());
}

export function getDecryptedApiKey(providerId: string): string | null {
  const row = getProviderKey(providerId);
  if (!row || !row.enabled) return null;

  try {
    return decrypt({
      encrypted: row.encryptedKey,
      iv: row.iv,
      authTag: row.authTag,
    });
  } catch {
    return null;
  }
}

export function getEnabledModels(): ModelInfo[] {
  const keys = getAllProviders()
    .map((p) => p.id)
    .filter((id) => getDecryptedApiKey(id) !== null);

  return getAllModels().filter((m) => keys.includes(m.providerId));
}

export { providers };
