import type { AgentHostedToolDefinition } from "./agent-contracts.js";

export type ProviderTransport =
  | "account-runner"
  | "openai-compatible"
  | "anthropic"
  | "google";

export type ProviderBillingBasis =
  | "account_not_metered"
  | "api_priced"
  | "unknown";

export interface RunnerProviderConfig {
  runtimeId: string;
  providerId: string;
  modelId: string;
  displayName?: string;
  billingBasis?: ProviderBillingBasis;
  transport: ProviderTransport;
  baseUrl?: string;
  /**
   * The key sent upstream. A stored `secretSource: "home"` config holds HOME_SECRET_PLACEHOLDER instead:
   * the Runner reads the key from the AIBoard home each time it builds a runtime (home-provider-configs.ts, HM3).
   */
  secret: string;
  /** "home": stored with no key; the key, base URL, transport and protocol come from the AIBoard home. */
  secretSource?: "home";
  runnerToken?: string;
  capabilities: string[];
  inputCapabilities?: {
    image: boolean;
    document: boolean;
    audio: boolean;
    video: boolean;
  };
  supportsTools?: boolean;
  hostedTools?: AgentHostedToolDefinition[];
  priority: number;
  reasoningEffort?: string;
  protocol?: "chat-completions" | "responses";
  inputCostMicrosPerMillion?: number;
  outputCostMicrosPerMillion?: number;
  cachedInputCostMicrosPerMillion?: number;
  cacheWriteInputCostMicrosPerMillion?: number;
  /** The model's context window in tokens, from the owner's model settings. */
  contextWindowTokens?: number;
  /** Optional per-response generation limit for OpenAI-compatible endpoints. */
  maxOutputTokens?: number;
}

export interface ProviderConfigStore {
  load(): RunnerProviderConfig[];
  save(configs: readonly RunnerProviderConfig[]): void;
  close(): void;
}

export interface ProviderUsageConfig {
  runtimeId: string;
  providerId: string;
  modelId: string;
  displayName?: string;
  billingBasis: ProviderBillingBasis;
  transport: ProviderTransport;
  inputCostMicrosPerMillion?: number;
  outputCostMicrosPerMillion?: number;
  cachedInputCostMicrosPerMillion?: number;
  cacheWriteInputCostMicrosPerMillion?: number;
}

export function providerUsageConfig(
  config: RunnerProviderConfig
): ProviderUsageConfig {
  return {
    runtimeId: config.runtimeId,
    providerId: config.providerId,
    modelId: config.modelId,
    ...(config.displayName ? { displayName: config.displayName } : {}),
    billingBasis: resolvedProviderBillingBasis(config),
    transport: config.transport,
    ...(config.inputCostMicrosPerMillion !== undefined
      ? { inputCostMicrosPerMillion: config.inputCostMicrosPerMillion }
      : {}),
    ...(config.outputCostMicrosPerMillion !== undefined
      ? { outputCostMicrosPerMillion: config.outputCostMicrosPerMillion }
      : {}),
    ...(config.cachedInputCostMicrosPerMillion !== undefined
      ? { cachedInputCostMicrosPerMillion: config.cachedInputCostMicrosPerMillion }
      : {}),
    ...(config.cacheWriteInputCostMicrosPerMillion !== undefined
      ? { cacheWriteInputCostMicrosPerMillion: config.cacheWriteInputCostMicrosPerMillion }
      : {}),
  };
}

/**
 * The `secret` of a stored `secretSource: "home"` config. It is not a key and is never sent by a Runner
 * that knows the home, which fills the real key at use. It is not empty because a Runner from before
 * HM3 (0.3.16 and older) refuses to load a store holding a config with no secret ("Could not decrypt
 * provider configuration"), so `aiboard update --rollback` would leave it unable to start any Build.
 * With the placeholder an older Runner loads the store, and only these models fail, with the provider's
 * 401. Never change this value: each released Runner validates stored configs against it.
 */
export const HOME_SECRET_PLACEHOLDER = "aiboard-home-key";

export function validateProviderConfigs(
  configs: readonly RunnerProviderConfig[]
): void {
  const ids = new Set<string>();
  for (const config of configs) {
    if (
      !config.runtimeId ||
      !config.providerId ||
      !config.modelId ||
      (config.secretSource === undefined ? !config.secret : config.secret !== HOME_SECRET_PLACEHOLDER)
    ) {
      throw new Error("Provider runtime identity and secret are required.");
    }
    if (config.secretSource !== undefined && (config.secretSource !== "home" || config.transport === "account-runner" || config.runnerToken !== undefined)) {
      throw new Error(`Provider runtime ${config.runtimeId} has an invalid secret source.`);
    }
    if (ids.has(config.runtimeId)) {
      throw new Error(`Duplicate provider runtime ${config.runtimeId}.`);
    }
    if (!(TRANSPORTS as readonly unknown[]).includes(config.transport)) {
      throw new Error(`Provider runtime ${config.runtimeId} has invalid transport.`);
    }
    if (
      config.billingBasis !== undefined &&
      !(["account_not_metered", "api_priced", "unknown"] as const).includes(
        config.billingBasis
      )
    ) {
      throw new Error(`Provider runtime ${config.runtimeId} has invalid billing basis.`);
    }
    if (
      config.billingBasis === "api_priced" &&
      !hasUsableNormalPricing(config)
    ) {
      throw new Error(
        `Provider runtime ${config.runtimeId} API-priced billing requires valid input and output pricing.`
      );
    }
    if (
      config.protocol !== undefined &&
      (!(OPENAI_PROTOCOLS as readonly unknown[]).includes(config.protocol) ||
        config.transport !== "openai-compatible")
    ) {
      throw new Error(`Provider runtime ${config.runtimeId} has invalid protocol.`);
    }
    if (!Number.isSafeInteger(config.priority) || config.priority < 0) {
      throw new Error(`Provider runtime ${config.runtimeId} has invalid priority.`);
    }
    if (!Array.isArray(config.capabilities) || config.capabilities.some((item) => !item)) {
      throw new Error(`Provider runtime ${config.runtimeId} has invalid capabilities.`);
    }
    if (config.supportsTools !== undefined && typeof config.supportsTools !== "boolean") {
      throw new Error(`Provider runtime ${config.runtimeId} has invalid tool support.`);
    }
    if (
      config.hostedTools !== undefined &&
      (!Array.isArray(config.hostedTools) ||
        config.hostedTools.some((tool) => !tool || typeof tool.type !== "string"))
    ) {
      throw new Error(`Provider runtime ${config.runtimeId} has invalid hosted tools.`);
    }
    if (
      config.inputCapabilities !== undefined &&
      ["image", "document", "audio", "video"].some(
        (key) => typeof config.inputCapabilities?.[key as keyof typeof config.inputCapabilities] !== "boolean"
      )
    ) {
      throw new Error(`Provider runtime ${config.runtimeId} has invalid input capabilities.`);
    }
    if (PRICING_FIELDS.some((field) => !isOptionalNonNegativeInteger(config[field]))) {
      throw new Error(`Provider runtime ${config.runtimeId} has invalid pricing.`);
    }
    if (config.contextWindowTokens !== undefined && (!Number.isSafeInteger(config.contextWindowTokens) || config.contextWindowTokens < 1)) {
      throw new Error(`Provider runtime ${config.runtimeId} has an invalid context window.`);
    }
    if (config.maxOutputTokens !== undefined && (
      !Number.isSafeInteger(config.maxOutputTokens) || config.maxOutputTokens < 1 ||
      (config.contextWindowTokens !== undefined && config.maxOutputTokens >= config.contextWindowTokens)
    )) {
      throw new Error(`Provider runtime ${config.runtimeId} has an invalid output token limit.`);
    }
    ids.add(config.runtimeId);
  }
}

export function resolvedProviderBillingBasis(
  config: Pick<
    RunnerProviderConfig,
    | "billingBasis"
    | "transport"
    | "inputCostMicrosPerMillion"
    | "outputCostMicrosPerMillion"
  >
): ProviderBillingBasis {
  if (config.billingBasis === "account_not_metered") return "account_not_metered";
  if (config.billingBasis === "unknown") return "unknown";
  if (config.billingBasis === "api_priced") {
    return hasUsableNormalPricing(config) ? "api_priced" : "unknown";
  }
  if (hasUsableNormalPricing(config)) return "api_priced";
  return config.transport === "account-runner" ? "account_not_metered" : "unknown";
}

function hasUsableNormalPricing(
  config: Pick<
    RunnerProviderConfig,
    "inputCostMicrosPerMillion" | "outputCostMicrosPerMillion"
  >
): boolean {
  return (
    isNonNegativeInteger(config.inputCostMicrosPerMillion) &&
    isNonNegativeInteger(config.outputCostMicrosPerMillion)
  );
}

const TRANSPORTS = [
  "account-runner",
  "openai-compatible",
  "anthropic",
  "google",
] as const;

const OPENAI_PROTOCOLS = ["chat-completions", "responses"] as const;

const PRICING_FIELDS = [
  "inputCostMicrosPerMillion",
  "outputCostMicrosPerMillion",
  "cachedInputCostMicrosPerMillion",
  "cacheWriteInputCostMicrosPerMillion",
] as const;

function isOptionalNonNegativeInteger(value: number | undefined): boolean {
  return value === undefined || isNonNegativeInteger(value);
}

function isNonNegativeInteger(value: number | undefined): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

export function cloneProviderConfigs(
  configs: readonly RunnerProviderConfig[]
): RunnerProviderConfig[] {
  return configs.map((config) => ({
    ...config,
    capabilities: [...config.capabilities],
    ...(config.inputCapabilities
      ? { inputCapabilities: { ...config.inputCapabilities } }
      : {}),
    ...(config.hostedTools
      ? { hostedTools: config.hostedTools.map((tool) => ({ ...tool, ...(tool.parameters ? { parameters: { ...tool.parameters } } : {}) })) }
      : {}),
  }));
}
