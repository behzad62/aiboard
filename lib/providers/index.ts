import type { AIProvider, ModelInfo } from "./base";
import { openaiProvider } from "./openai";
import { anthropicProvider } from "./anthropic";
import { googleProvider } from "./google";
import { openrouterProvider } from "./openrouter";
import { listCustomModelInfos, resolveCustomModelName } from "./custom";
import { getModelDisplayName } from "./catalog";
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
  return [
    ...getAllProviders().flatMap((p) => p.listModels()),
    ...listCustomModelInfos(),
  ];
}

/** Display name for any full model id, including user-defined custom models. */
export function resolveModelName(fullId: string): string {
  return resolveCustomModelName(fullId) ?? getModelDisplayName(fullId);
}

export function getDecryptedApiKey(providerId: string): string | null {
  const row = getProviderKey(providerId);
  if (!row || !row.enabled) return null;

  // Client representation stores the plaintext key (protected by the store-level
  // passphrase envelope); server representation is AES-encrypted at rest.
  if (row.apiKey) return row.apiKey;
  if (!row.encryptedKey || !row.iv || !row.authTag) return null;

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
  const keyedProviderIds = getAllProviders()
    .map((p) => p.id)
    .filter((id) => getDecryptedApiKey(id) !== null);

  const builtin = getAllProviders()
    .flatMap((p) => p.listModels())
    .filter((m) => keyedProviderIds.includes(m.providerId));

  // Custom endpoints are always available once added (a key is optional).
  return [...builtin, ...listCustomModelInfos()];
}

export { providers };
