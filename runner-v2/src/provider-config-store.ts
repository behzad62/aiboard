export type ProviderTransport =
  | "account-runner"
  | "openai-compatible"
  | "anthropic"
  | "google";

export interface RunnerProviderConfig {
  runtimeId: string;
  providerId: string;
  modelId: string;
  transport: ProviderTransport;
  baseUrl?: string;
  secret: string;
  runnerToken?: string;
  capabilities: string[];
  inputCapabilities?: {
    image: boolean;
    document: boolean;
    audio: boolean;
    video: boolean;
  };
  priority: number;
  reasoningEffort?: string;
  protocol?: "chat-completions" | "responses";
  inputCostMicrosPerMillion?: number;
  outputCostMicrosPerMillion?: number;
  cachedInputCostMicrosPerMillion?: number;
  cacheWriteInputCostMicrosPerMillion?: number;
}

export interface ProviderConfigStore {
  load(): RunnerProviderConfig[];
  save(configs: readonly RunnerProviderConfig[]): void;
  close(): void;
}

export function validateProviderConfigs(
  configs: readonly RunnerProviderConfig[]
): void {
  const ids = new Set<string>();
  for (const config of configs) {
    if (
      !config.runtimeId ||
      !config.providerId ||
      !config.modelId ||
      !config.secret
    ) {
      throw new Error("Provider runtime identity and secret are required.");
    }
    if (ids.has(config.runtimeId)) {
      throw new Error(`Duplicate provider runtime ${config.runtimeId}.`);
    }
    if (!(TRANSPORTS as readonly unknown[]).includes(config.transport)) {
      throw new Error(`Provider runtime ${config.runtimeId} has invalid transport.`);
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
    ids.add(config.runtimeId);
  }
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
  return value === undefined || (Number.isSafeInteger(value) && value >= 0);
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
  }));
}
