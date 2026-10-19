/** Catalog facts and optional user corrections. Missing is distinct from false/zero. */
export interface ModelMetadataValues {
  contextWindowTokens?: number;
  maxOutputTokens?: number;
  inputUsdPer1M?: number;
  outputUsdPer1M?: number;
  cachedInputUsdPer1M?: number;
  text?: boolean;
  image?: boolean;
  document?: boolean;
  audio?: boolean;
  video?: boolean;
}
export type ModelMetadataField = keyof ModelMetadataValues;
export const MODEL_METADATA_FIELDS: Record<ModelMetadataField, string> = {
  contextWindowTokens: "Context window", maxOutputTokens: "Max output tokens",
  inputUsdPer1M: "Input price / 1M tokens", outputUsdPer1M: "Output price / 1M tokens",
  cachedInputUsdPer1M: "Cached input price / 1M tokens",
  text: "Text input", image: "Image input", document: "Document input", audio: "Audio input", video: "Video input",
};
export interface ModelMetadataDetails extends ModelMetadataValues {
  /** API list rates for comparison only; never evidence of subscription billing. */
  apiEquivalentPricing?: {
    modelId: string;
    source: "models.dev";
    fetchedAt: string;
    values: Pick<ModelMetadataValues, "inputUsdPer1M" | "outputUsdPer1M" | "cachedInputUsdPer1M">;
  };
  supplemental?: {
    source: "models.dev";
    scope?: "model";
    modelId?: string;
    fetchedAt: string;
    updatedAt?: string;
    values: ModelMetadataValues;
    pricingNote?: string;
  };
  catalogFetchedAt?: string;
  name?: string;
  description?: string;
  createdAtMs?: number;
  inputModalities?: string[];
  supportedParameters?: string[];
  reportedFields?: ModelMetadataField[];
  overrides?: ModelMetadataValues;
}
export function effectiveModelMetadata(metadata?: ModelMetadataDetails): ModelMetadataValues {
  if (!metadata) return {};
  const result: ModelMetadataValues = {};
  for (const key of Object.keys(MODEL_METADATA_FIELDS) as ModelMetadataField[]) {
    const value = metadata.overrides?.[key] ??
      (metadata.reportedFields === undefined || metadata.reportedFields.includes(key) ? metadata[key] : undefined) ??
      (metadata.apiEquivalentPricing?.values as ModelMetadataValues | undefined)?.[key] ??
      metadata.supplemental?.values[key];
    if (value !== undefined) Object.assign(result, { [key]: value });
  }
  return result;
}
export function missingModelMetadata(metadata?: ModelMetadataDetails): ModelMetadataField[] {
  const values = effectiveModelMetadata(metadata);
  return (Object.keys(MODEL_METADATA_FIELDS) as ModelMetadataField[]).filter((key) => values[key] === undefined);
}
const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" ? value as Record<string, unknown> : {};
const positive = (...values: unknown[]) => values.find((value): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0);
const price = (value: unknown): number | undefined => {
  if ((typeof value !== "number" && typeof value !== "string") || (typeof value === "string" && value.trim() === "")) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
};

/** Read only fields with explicit units/meaning; never infer modalities from a model id. */
export function extractModelMetadata(record: Record<string, unknown>, providerId?: string): ModelMetadataDetails {
  const capabilities = object(record.capabilities), supports = object(capabilities.supports);
  const limits = object(capabilities.limits), top = object(record.top_provider);
  const pricing = object(record.pricing);
  const values: ModelMetadataValues = {
    contextWindowTokens: positive(record.contextWindowTokens, record.context_window, record.context_length, record.context_window_tokens,
      record.max_context_tokens, record.max_input_tokens, record.input_token_limit, record.inputTokenLimit, record.token_limit, limits.max_context_window_tokens, top.context_length),
    maxOutputTokens: positive(record.maxOutputTokens, record.max_output_tokens, record.max_completion_tokens, record.output_token_limit,
      record.outputTokenLimit, record.max_tokens, limits.max_output_tokens, top.max_completion_tokens),
    inputUsdPer1M: price(record.inputUsdPer1M), outputUsdPer1M: price(record.outputUsdPer1M), cachedInputUsdPer1M: price(record.cachedInputUsdPer1M),
  };
  if (providerId === "openrouter") {
    for (const [field, raw] of [["inputUsdPer1M", pricing.prompt], ["outputUsdPer1M", pricing.completion], ["cachedInputUsdPer1M", pricing.input_cache_read]] as const) {
      const amount = price(raw);
      if (amount !== undefined) values[field] = amount * 1_000_000;
    }
  }
  if (providerId === "xai") {
    // xAI reports USD cents per 100 million tokens: divide by 10,000 for USD/1M.
    for (const [field, raw] of [["inputUsdPer1M", record.prompt_text_token_price], ["outputUsdPer1M", record.completion_text_token_price], ["cachedInputUsdPer1M", record.cached_prompt_text_token_price]] as const) {
      const amount = price(raw);
      if (amount !== undefined) values[field] = amount / 10_000;
    }
  }
  const modalities = record.input_modalities ?? object(record.architecture).input_modalities;
  if (Array.isArray(modalities)) {
    const set = new Set(modalities.filter((value): value is string => typeof value === "string").map((value) => value.toLowerCase()));
    for (const type of ["text", "image", "document", "audio", "video"] as const) values[type] = set.has(type) || (type === "document" && set.has("file"));
  }
  for (const type of ["text", "image", "document", "audio", "video"] as const) {
    const explicit = record[type] ?? supports[type === "image" ? "vision" : type];
    if (typeof explicit === "boolean") values[type] = explicit;
  }
  return { ...values, reportedFields: (Object.keys(MODEL_METADATA_FIELDS) as ModelMetadataField[]).filter((key) => values[key] !== undefined) };
}

export function validateModelMetadataOverrides(values: ModelMetadataValues): void {
  for (const [field, value] of Object.entries(values)) {
    if (!Object.hasOwn(MODEL_METADATA_FIELDS, field)) throw new Error("Unknown model metadata field.");
    if (value === undefined) continue;
    if (["text", "image", "document", "audio", "video"].includes(field)) {
      if (typeof value !== "boolean") throw new Error("Input support must be yes, no, or unknown.");
    } else if (typeof value !== "number" || !Number.isFinite(value) || value < 0 ||
      (["contextWindowTokens", "maxOutputTokens"].includes(field) && (!Number.isSafeInteger(value) || value === 0))) {
      throw new Error("Enter non-negative prices and positive whole token limits.");
    }
  }
}
