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
  priority: number;
  reasoningEffort?: string;
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
    if (!Number.isSafeInteger(config.priority) || config.priority < 0) {
      throw new Error(`Provider runtime ${config.runtimeId} has invalid priority.`);
    }
    if (!Array.isArray(config.capabilities) || config.capabilities.some((item) => !item)) {
      throw new Error(`Provider runtime ${config.runtimeId} has invalid capabilities.`);
    }
    ids.add(config.runtimeId);
  }
}

export function cloneProviderConfigs(
  configs: readonly RunnerProviderConfig[]
): RunnerProviderConfig[] {
  return configs.map((config) => ({
    ...config,
    capabilities: [...config.capabilities],
  }));
}
