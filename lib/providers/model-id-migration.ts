const OPENAI_LEGACY_MODEL_IDS: Readonly<Record<string, string>> = {
  "gpt-5.6": "gpt-5.6-terra",
  "gpt-5.6-pro": "gpt-5.6-sol",
  "gpt-5.6-mini": "gpt-5.6-luna",
};

export function migrateProviderModelId(
  providerId: string,
  modelId: string
): string {
  return providerId === "openai"
    ? (OPENAI_LEGACY_MODEL_IDS[modelId] ?? modelId)
    : modelId;
}

export function migrateFullModelId(fullModelId: string): string {
  const separator = fullModelId.indexOf(":");
  if (separator < 1) return fullModelId;

  const providerId = fullModelId.slice(0, separator);
  const modelId = fullModelId.slice(separator + 1);
  const migrated = migrateProviderModelId(providerId, modelId);
  return migrated === modelId ? fullModelId : `${providerId}:${migrated}`;
}

export function migrateModelIdKeyedRecord<T>(
  record: Record<string, T> | undefined
): Record<string, T> | undefined {
  if (!record) return undefined;

  const output: Record<string, T> = {};
  for (const [key, value] of Object.entries(record)) {
    if (migrateFullModelId(key) === key) output[key] = value;
  }
  for (const [key, value] of Object.entries(record)) {
    const migrated = migrateFullModelId(key);
    if (!(migrated in output)) output[migrated] = value;
  }
  return output;
}
