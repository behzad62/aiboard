export const PROVIDER_IDS = [
  "openai",
  "anthropic",
  "google",
  "openrouter",
] as const;

export type ProviderId = (typeof PROVIDER_IDS)[number];
