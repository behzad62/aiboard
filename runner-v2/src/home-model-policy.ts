import { MODEL_CATALOG_SNAPSHOT } from "./generated/model-catalog.js";

/**
 * The web's model rules that are code, ported for the Runner (Simple Build plan §9 "The Runner knows
 * models", packet HM2, OD-30). The data they read is the generated catalog snapshot; the rules are
 * copies of lib/ code, which Runner code may not import. scripts/test-runner-model-catalog-parity.mts
 * compares every rule here with its web original, so a change to one side fails until the other follows.
 *
 * Ported from: lib/client/build-crew.ts (`runtimeModelId`), lib/providers/base.ts (`parseModelId`),
 * lib/providers/provider-registry.ts (reasoning-effort and max-token support), lib/providers/
 * model-id-migration.ts, lib/providers/model-metadata.ts (`effectiveModelMetadata`), lib/providers/
 * pricing.ts (`getModelPricing`, with the account API-equivalent rule), lib/providers/model-context.ts
 * (`resolveModelContextProfile`), lib/client/providers.ts (`getPersistedProviderCapabilityEvidence`)
 * and lib/providers/capability-resolution.ts (OpenRouter's `function_calling` support).
 */

export type CatalogSnapshot = typeof MODEL_CATALOG_SNAPSHOT;
export type SnapshotProviderId = keyof CatalogSnapshot["providers"];
export type SnapshotProvider = CatalogSnapshot["providers"][SnapshotProviderId];
export type SnapshotModel = CatalogSnapshot["models"][number];

export const CUSTOM_PROVIDER_ID = "custom";
const RUNTIME_EFFORT_SEPARATOR = "#";
const RUNTIME_EFFORTS = new Set(["default", "none", "low", "medium", "high", "xhigh", "max"]);

// ------------------------------------------------------------------ ids

export function parseFullModelId(fullId: string): { providerId: string; model: string } {
  const [providerId, ...rest] = fullId.split(":");
  return { providerId: providerId ?? "", model: rest.join(":") };
}

export function formatFullModelId(providerId: string, model: string): string {
  return `${providerId}:${model}`;
}

/** `model#effort` → `model`: a Build role at a second reasoning effort runs the same model (build-crew.ts). */
export function runtimeModelRef(runtimeId: string): string {
  const index = runtimeId.lastIndexOf(RUNTIME_EFFORT_SEPARATOR);
  return index > 0 ? runtimeId.slice(0, index) : runtimeId;
}

/** The effort a `model#effort` runtime id names, when it names a known one. */
export function runtimeEffort(runtimeId: string): string | undefined {
  const index = runtimeId.lastIndexOf(RUNTIME_EFFORT_SEPARATOR);
  if (index <= 0) return undefined;
  const effort = runtimeId.slice(index + 1);
  return RUNTIME_EFFORTS.has(effort) ? effort : undefined;
}

export function snapshotProvider(providerId: string): SnapshotProvider | undefined {
  return Object.hasOwn(MODEL_CATALOG_SNAPSHOT.providers, providerId)
    ? MODEL_CATALOG_SNAPSHOT.providers[providerId as SnapshotProviderId]
    : undefined;
}

/** Every provider id, in the web's registry order (PROVIDER_IDS). */
export function snapshotProviderIds(): SnapshotProviderId[] {
  return [...MODEL_CATALOG_SNAPSHOT.providerOrder];
}

export function snapshotCatalogModel(providerId: string, modelId: string): SnapshotModel | undefined {
  return MODEL_CATALOG_SNAPSHOT.models.find((entry) => entry.providerId === providerId && entry.id === modelId);
}

/** The id inside one provider: `openrouter:qwen/x` → `qwen/x` (lib/client/providers.ts `normalizeProviderModelId`). */
export function normalizeProviderModelId(providerId: string, id: string): string {
  const trimmed = id.trim();
  const parsed = parseFullModelId(trimmed);
  return parsed.providerId === providerId ? parsed.model : trimmed;
}

// ------------------------------------------------------------------ provider feature rules

function normalizedModelId(modelId = ""): string {
  return modelId.trim().toLowerCase();
}

/** The model-dependent rules of provider-registry.ts `reasoningEffort`. */
const REASONING_EFFORT_RULES: Readonly<Record<string, (modelId: string) => boolean>> = {
  anthropic: (modelId) => modelId !== "claude-haiku-4-5-20251001",
  xai: (modelId) => !normalizedModelId(modelId).includes("non-reasoning"),
  meta: (modelId) => /^muse-spark-/i.test(modelId.trim()),
  "github-copilot": (modelId) =>
    normalizedModelId(modelId) === "auto" ||
    /^gpt-\d+/i.test(modelId) ||
    normalizedModelId(modelId) === "gemini-3.5-flash",
};
/** provider-registry.ts `maxTokens` has no model-dependent rule today; one would be ported here. */
const MAX_TOKENS_RULES: Readonly<Record<string, (modelId: string) => boolean>> = {};

function featureSupport(
  support: boolean | "model-rule" | undefined,
  rule: ((modelId: string) => boolean) | undefined,
  modelId: string,
): boolean {
  if (support === "model-rule") {
    if (!rule) throw new Error("A provider feature rule is missing from home-model-policy.ts; rerun the parity script.");
    return rule(modelId);
  }
  return support === true;
}

/** provider-registry.ts `providerSupportsReasoningEffortFeature`. */
export function providerSupportsReasoningEffort(providerId: string, modelId = ""): boolean {
  return featureSupport(snapshotProvider(providerId)?.reasoningEffort, REASONING_EFFORT_RULES[providerId], modelId);
}

/** provider-registry.ts `providerSupportsMaxTokensFeature`. */
export function providerSupportsMaxTokens(providerId: string, modelId = ""): boolean {
  return featureSupport(snapshotProvider(providerId)?.maxTokens, MAX_TOKENS_RULES[providerId], modelId);
}

/** Providers whose snapshot entry names a model rule; the parity script checks each has a port. */
export function portedFeatureRuleProviders(): { reasoningEffort: string[]; maxTokens: string[] } {
  return { reasoningEffort: Object.keys(REASONING_EFFORT_RULES).sort(), maxTokens: Object.keys(MAX_TOKENS_RULES).sort() };
}

// ------------------------------------------------------------------ model-id migration

const MODEL_ID_MIGRATIONS: Readonly<Record<string, Readonly<Record<string, string>>>> = MODEL_CATALOG_SNAPSHOT.modelIdMigrations;

/** model-id-migration.ts `migrateProviderModelId`. */
export function migrateProviderModelId(providerId: string, modelId: string): string {
  const table = Object.hasOwn(MODEL_ID_MIGRATIONS, providerId) ? MODEL_ID_MIGRATIONS[providerId]! : undefined;
  return table && Object.hasOwn(table, modelId) ? table[modelId]! : modelId;
}

/** model-id-migration.ts `migrateFullModelId`. */
export function migrateFullModelId(fullModelId: string): string {
  const separator = fullModelId.indexOf(":");
  if (separator < 1) return fullModelId;
  const providerId = fullModelId.slice(0, separator);
  const modelId = fullModelId.slice(separator + 1);
  const migrated = migrateProviderModelId(providerId, modelId);
  return migrated === modelId ? fullModelId : `${providerId}:${migrated}`;
}

/** model-id-migration.ts `migrateModelIdKeyedRecord`: an entry already under the new id wins. */
export function migrateModelIdKeyedRecord<T>(record: Record<string, T> | undefined): Record<string, T> | undefined {
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Applies the model-id migration to every id the home holds that can still drive a model call
 * (§5.8 "Model ids"): each provider's default model, its enabled and user-defined model lists, the
 * judge default, `exec.defaultModelId` once DX1 adds it, and the keys of the pricing and context
 * overrides. Discovered metadata and capability evidence keep their exact ids, as in the web
 * (lib/client/model-selection-migration.ts). Mutates `config`; returns whether anything changed.
 * Readers apply it to every read, so the next write saves the migrated ids.
 */
export function migrateHomeConfigModelIds(config: {
  providers: Record<string, Record<string, unknown>>;
  settings: Record<string, unknown>;
  [field: string]: unknown;
}): boolean {
  let changed = false;
  const full = (value: unknown): unknown => {
    if (typeof value !== "string" || !value) return value;
    const migrated = migrateFullModelId(value);
    if (migrated !== value) changed = true;
    return migrated;
  };
  for (const [providerId, entry] of Object.entries(config.providers)) {
    if (!isRecord(entry)) continue;
    if (typeof entry.defaultModel === "string" && entry.defaultModel) {
      const migrated = migrateProviderModelId(providerId, entry.defaultModel);
      if (migrated !== entry.defaultModel) { entry.defaultModel = migrated; changed = true; }
    }
    for (const field of ["enabledModelIds", "models"] as const) {
      const list = entry[field];
      if (!Array.isArray(list) || !list.every((id) => typeof id === "string")) continue;
      const mapped = (list as string[]).map((id) => migrateProviderModelId(providerId, id));
      if (mapped.every((id, index) => id === list[index])) continue;
      // A renamed id that is already listed under its new name is listed once.
      const original = list as string[];
      const added = new Set<string>();
      entry[field] = mapped.filter((id, index) => {
        if (id === original[index]) return true;
        if (original.includes(id) || added.has(id)) return false;
        added.add(id);
        return true;
      });
      changed = true;
    }
  }
  if ("judgeModelId" in config.settings) config.settings.judgeModelId = full(config.settings.judgeModelId);
  for (const field of ["modelPricingOverrides", "modelContextOverrides"] as const) {
    const record = config.settings[field];
    if (!isRecord(record)) continue;
    const migrated = migrateModelIdKeyedRecord(record)!;
    if (JSON.stringify(migrated) !== JSON.stringify(record)) { config.settings[field] = migrated; changed = true; }
  }
  const exec = config.exec;
  if (isRecord(exec) && "defaultModelId" in exec) exec.defaultModelId = full(exec.defaultModelId);
  return changed;
}

// ------------------------------------------------------------------ discovered metadata

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
type ModelMetadataField = keyof ModelMetadataValues;
const MODEL_METADATA_FIELDS: readonly ModelMetadataField[] = [
  "contextWindowTokens", "maxOutputTokens", "inputUsdPer1M", "outputUsdPer1M", "cachedInputUsdPer1M",
  "text", "image", "document", "audio", "video",
];

/** lib/providers/model-metadata.ts `ModelMetadataDetails`, as far as the rules here read it. */
export interface DiscoveredModelMetadata extends ModelMetadataValues {
  apiEquivalentPricing?: { modelId: string; values: Pick<ModelMetadataValues, "inputUsdPer1M" | "outputUsdPer1M" | "cachedInputUsdPer1M"> };
  supplemental?: { fetchedAt: string; values: ModelMetadataValues; pricingNote?: string };
  reportedFields?: ModelMetadataField[];
  overrides?: ModelMetadataValues;
  updatedAt?: string;
  source?: "openrouter-models" | "provider-models";
  [field: string]: unknown;
}
export type DiscoveredMetadataMap = Record<string, DiscoveredModelMetadata | undefined>;

/** model-metadata.ts `effectiveModelMetadata`. */
export function effectiveModelMetadata(metadata?: DiscoveredModelMetadata): ModelMetadataValues {
  if (!metadata) return {};
  const result: ModelMetadataValues = {};
  for (const key of MODEL_METADATA_FIELDS) {
    const value = metadata.overrides?.[key] ??
      (metadata.reportedFields === undefined || metadata.reportedFields.includes(key) ? metadata[key] : undefined) ??
      (metadata.apiEquivalentPricing?.values as ModelMetadataValues | undefined)?.[key] ??
      metadata.supplemental?.values[key];
    if (value !== undefined) Object.assign(result, { [key]: value });
  }
  return result;
}

// ------------------------------------------------------------------ pricing

export interface ModelPricing {
  inputUsdPer1M: number;
  outputUsdPer1M: number;
  cachedInputUsdPer1M?: number;
  notes?: string;
  sourceLabel: string;
  sourceUrl: string;
  verifiedAt: string;
  isOverride?: boolean;
  basis?: "api-equivalent";
}
/** lib/db/schema.ts `ModelPricingOverride`. */
export interface ModelPricingOverride {
  inputUsdPer1M: number;
  outputUsdPer1M: number;
  cachedInputUsdPer1M?: number | null;
  updatedAt: string;
}

const MODEL_PRICING: Readonly<Record<string, ModelPricing>> = MODEL_CATALOG_SNAPSHOT.pricing;
const ACCOUNT_PRICED_MODEL = /^(chatgpt|github-copilot):/;

/**
 * pricing.ts `getModelPricing`. Account-backed models (ChatGPT, Copilot) are not metered per token, so
 * their price is the API-equivalent comparison: the discovered `apiEquivalentPricing` model, else for
 * ChatGPT and any `gpt-` model the same id at OpenAI, with the account model's own manual overrides on top.
 */
export function getModelPricing(
  fullModelId: string,
  overrides?: Record<string, ModelPricingOverride>,
  discoveredMetadata?: DiscoveredMetadataMap,
): ModelPricing | null {
  const account = ACCOUNT_PRICED_MODEL.test(fullModelId);
  let pricing = directModelPricing(fullModelId, overrides, discoveredMetadata);
  if (!account) return pricing;
  const modelId = fullModelId.slice(fullModelId.indexOf(":") + 1);
  const apiModelId = discoveredMetadata?.[fullModelId]?.apiEquivalentPricing?.modelId ??
    (fullModelId.startsWith("chatgpt:") || /^gpt-/.test(modelId) ? `openai:${modelId}` : undefined);
  const apiPricing = apiModelId ? directModelPricing(apiModelId, overrides, discoveredMetadata) : null;
  if (apiPricing) {
    const manual = { ...discoveredMetadata?.[fullModelId]?.overrides, ...overrides?.[fullModelId] };
    pricing = { ...apiPricing,
      ...([manual.inputUsdPer1M, manual.outputUsdPer1M, manual.cachedInputUsdPer1M].some((value) => typeof value === "number")
        ? { sourceLabel: "Local comparison override", isOverride: true } : {}),
      ...(typeof manual.inputUsdPer1M === "number" ? { inputUsdPer1M: manual.inputUsdPer1M } : {}),
      ...(typeof manual.outputUsdPer1M === "number" ? { outputUsdPer1M: manual.outputUsdPer1M } : {}),
      ...(typeof manual.cachedInputUsdPer1M === "number" ? { cachedInputUsdPer1M: manual.cachedInputUsdPer1M } : {}),
    };
  }
  return pricing ? { ...pricing, basis: "api-equivalent", sourceLabel: `API-equivalent estimate · ${pricing.sourceLabel}`,
    notes: `Comparison with API list rates${apiModelId ? ` for ${apiModelId}` : ""}; this is not a subscription charge. ${pricing.notes ?? "Base tier; actual API rates can vary by request and service tier."}` } : null;
}

function directModelPricing(
  fullModelId: string,
  overrides?: Record<string, ModelPricingOverride>,
  discoveredMetadata?: DiscoveredMetadataMap,
): ModelPricing | null {
  const base = Object.hasOwn(MODEL_PRICING, fullModelId) ? MODEL_PRICING[fullModelId]! : null;
  const override = overrides?.[fullModelId];
  const originalMetadata = discoveredMetadata?.[fullModelId];
  const effective = effectiveModelMetadata(originalMetadata);
  const discovered = originalMetadata ? { ...originalMetadata, inputUsdPer1M: effective.inputUsdPer1M,
    outputUsdPer1M: effective.outputUsdPer1M, cachedInputUsdPer1M: effective.cachedInputUsdPer1M } : undefined;
  const discoveredInput = discovered?.inputUsdPer1M;
  const discoveredOutput = discovered?.outputUsdPer1M;
  const hasDiscoveredPricing =
    typeof discoveredInput === "number" && Number.isFinite(discoveredInput) && discoveredInput >= 0 &&
    typeof discoveredOutput === "number" && Number.isFinite(discoveredOutput) && discoveredOutput >= 0;

  if (!override && !hasDiscoveredPricing && (!base || originalMetadata?.reportedFields !== undefined)) return null;
  if (!override && base && !hasDiscoveredPricing) return base;
  if (!override && hasDiscoveredPricing) {
    const discoveredCached = discovered?.cachedInputUsdPer1M;
    const manual = [originalMetadata?.overrides?.inputUsdPer1M, originalMetadata?.overrides?.outputUsdPer1M, originalMetadata?.overrides?.cachedInputUsdPer1M].some((value) => value !== undefined);
    const reference = originalMetadata?.supplemental;
    const usesReference = reference && (["inputUsdPer1M", "outputUsdPer1M", "cachedInputUsdPer1M"] as const).some((field) =>
      originalMetadata?.overrides?.[field] === undefined && originalMetadata?.reportedFields?.includes(field) === false && reference.values[field] !== undefined);
    return {
      inputUsdPer1M: discoveredInput!,
      outputUsdPer1M: discoveredOutput!,
      ...(typeof discoveredCached === "number" && Number.isFinite(discoveredCached) && discoveredCached >= 0
        ? { cachedInputUsdPer1M: discoveredCached } : {}),
      sourceLabel: manual ? "Catalog pricing with local overrides" : originalMetadata?.apiEquivalentPricing ? "Models.dev API pricing reference" : usesReference ? "Pricing with Models.dev references" :
        discovered?.source === "openrouter-models" ? "OpenRouter live catalog pricing" : "Provider live catalog pricing",
      sourceUrl: usesReference || originalMetadata?.apiEquivalentPricing ? "https://models.dev" : "",
      ...(usesReference ? { notes: reference.pricingNote ?? "Community-maintained reference rates; actual costs depend on the provider's billing tier and request." } : {}),
      ...(manual ? { isOverride: true } : {}),
      verifiedAt: (usesReference ? reference.fetchedAt : discovered?.updatedAt)?.split("T")[0] ?? new Date().toISOString().split("T")[0]!,
    };
  }
  return {
    inputUsdPer1M: override!.inputUsdPer1M,
    outputUsdPer1M: override!.outputUsdPer1M,
    cachedInputUsdPer1M: override!.cachedInputUsdPer1M === null || override!.cachedInputUsdPer1M === undefined ? undefined : override!.cachedInputUsdPer1M,
    notes: base ? `Using your local override. Built-in reference source remains ${base.sourceLabel}.` : "Using your local override.",
    sourceLabel: "Local pricing override",
    sourceUrl: base?.sourceUrl ?? "",
    verifiedAt: override!.updatedAt.split("T")[0]!,
    isOverride: true,
  };
}

/** lib/client/native-build-engine.ts `nativePricingMicros`. */
export function pricingMicros(pricing: ModelPricing | null): {
  inputCostMicrosPerMillion?: number;
  outputCostMicrosPerMillion?: number;
  cachedInputCostMicrosPerMillion?: number;
  cacheWriteInputCostMicrosPerMillion?: number;
} {
  if (!pricing) return {};
  const input = usdToMicros(pricing.inputUsdPer1M);
  return {
    inputCostMicrosPerMillion: input,
    outputCostMicrosPerMillion: usdToMicros(pricing.outputUsdPer1M),
    ...(pricing.cachedInputUsdPer1M === undefined ? {} : { cachedInputCostMicrosPerMillion: usdToMicros(pricing.cachedInputUsdPer1M) }),
    // The catalog has no separate cache-write price: normal input pricing, never a free cache write.
    cacheWriteInputCostMicrosPerMillion: input,
  };
}

function usdToMicros(usd: number): number {
  return Math.round(usd * 1_000_000);
}

// ------------------------------------------------------------------ context profiles

export type LongContextQuality = "poor" | "ok" | "good" | "excellent";
export type ModelBuildRole = "architect" | "worker" | "reviewer" | "summary";
export type ModelContextProfileSource = "registry" | "discovered" | "provider-default" | "default" | "override";

export interface ModelContextProfile {
  modelId: string;
  providerId: string;
  fullModelId: string;
  contextWindowTokens: number;
  maxOutputTokens?: number;
  buildOutputReserveTokens?: number;
  effectiveBuildInputCeilingTokens?: number;
  longContextQuality?: LongContextQuality;
  promptCaching?: boolean;
  recommendedBuildRoles?: ModelBuildRole[];
  source: ModelContextProfileSource;
}
export interface ModelContextProfileOverride {
  contextWindowTokens?: number | null;
  maxOutputTokens?: number | null;
  buildOutputReserveTokens?: number | null;
  effectiveBuildInputCeilingTokens?: number | null;
  longContextQuality?: LongContextQuality | null;
  promptCaching?: boolean | null;
  recommendedBuildRoles?: ModelBuildRole[] | null;
  updatedAt?: string;
}
export type ModelContextOverrides = Record<string, ModelContextProfileOverride>;
interface StaticModelContextProfile {
  contextWindowTokens: number;
  maxOutputTokens?: number;
  buildOutputReserveTokens?: number;
  effectiveBuildInputCeilingTokens?: number;
  longContextQuality?: LongContextQuality;
  promptCaching?: boolean;
  recommendedBuildRoles?: readonly ModelBuildRole[];
}

const CONTEXT = MODEL_CATALOG_SNAPSHOT.contextProfiles;
const DEFAULT_PROFILE: StaticModelContextProfile = CONTEXT.default;
const PROVIDER_DEFAULT_PROFILES: Readonly<Record<string, StaticModelContextProfile>> = CONTEXT.providers;
const MODEL_PROFILES: Readonly<Record<string, StaticModelContextProfile>> = CONTEXT.models;
const { minContextWindowTokens: MIN_CONTEXT, maxContextWindowTokens: MAX_CONTEXT, minOutputTokens: MIN_OUTPUT, maxOutputTokens: MAX_OUTPUT } = CONTEXT.limits;
const LONG_CONTEXT_QUALITIES = new Set<string>(["poor", "ok", "good", "excellent"]);
const BUILD_ROLES = new Set<string>(["architect", "worker", "reviewer", "summary"]);

function finiteInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : null;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function lookup<T>(record: Readonly<Record<string, T>>, key: string): T | undefined {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

function normalizeRoles(overrideRoles: unknown, baseRoles: readonly ModelBuildRole[] | undefined): ModelBuildRole[] | undefined {
  if (!Array.isArray(overrideRoles)) return baseRoles ? [...baseRoles] : undefined;
  const roles = overrideRoles.filter((role): role is ModelBuildRole => BUILD_ROLES.has(role as string));
  const deduped = [...new Set(roles)];
  return deduped.length > 0 ? deduped : baseRoles ? [...baseRoles] : undefined;
}

function normalizeProfile(input: {
  providerId: string;
  modelId: string;
  base: StaticModelContextProfile;
  override?: ModelContextProfileOverride;
  source: ModelContextProfileSource;
}): ModelContextProfile {
  const overrideContext = finiteInteger(input.override?.contextWindowTokens);
  const contextWindowTokens = clamp(overrideContext ?? input.base.contextWindowTokens, MIN_CONTEXT, MAX_CONTEXT);
  const maxOutputCeiling = Math.min(MAX_OUTPUT, contextWindowTokens);
  const overrideMaxOutput = finiteInteger(input.override?.maxOutputTokens);
  const baseMaxOutput = finiteInteger(input.base.maxOutputTokens);
  const maxOutputTokens = clamp(overrideMaxOutput ?? baseMaxOutput ?? Math.min(4_096, maxOutputCeiling), MIN_OUTPUT, maxOutputCeiling);
  const maxReserve = Math.min(maxOutputTokens, MAX_OUTPUT, Math.max(MIN_OUTPUT, Math.floor(contextWindowTokens / 2)));
  const overrideReserve = finiteInteger(input.override?.buildOutputReserveTokens);
  const baseReserve = finiteInteger(input.base.buildOutputReserveTokens);
  const buildOutputReserveTokens = clamp(overrideReserve ?? baseReserve ?? maxOutputTokens, MIN_OUTPUT, maxReserve);
  const maxInputCeiling = Math.max(0, contextWindowTokens - buildOutputReserveTokens);
  const overrideInputCeiling = finiteInteger(input.override?.effectiveBuildInputCeilingTokens);
  const baseInputCeiling = finiteInteger(input.base.effectiveBuildInputCeilingTokens);
  const effectiveBuildInputCeilingTokens = clamp(overrideInputCeiling ?? baseInputCeiling ?? maxInputCeiling, 0, maxInputCeiling);
  const quality = LONG_CONTEXT_QUALITIES.has(input.override?.longContextQuality as string)
    ? (input.override?.longContextQuality as LongContextQuality)
    : input.base.longContextQuality;
  const promptCaching = typeof input.override?.promptCaching === "boolean" ? input.override.promptCaching : input.base.promptCaching;
  return {
    modelId: input.modelId,
    providerId: input.providerId,
    fullModelId: formatFullModelId(input.providerId, input.modelId),
    contextWindowTokens,
    maxOutputTokens,
    buildOutputReserveTokens,
    effectiveBuildInputCeilingTokens,
    longContextQuality: quality,
    promptCaching,
    recommendedBuildRoles: normalizeRoles(input.override?.recommendedBuildRoles, input.base.recommendedBuildRoles),
    source: input.source,
  };
}

function resolveOverride(providerId: string, modelId: string, overrides?: ModelContextOverrides): ModelContextProfileOverride | undefined {
  if (!overrides) return undefined;
  return overrides[formatFullModelId(providerId, modelId)] ?? overrides[formatFullModelId(providerId, "*")] ?? overrides["*"];
}

/** model-context.ts `resolveModelContextProfile`. */
export function resolveModelContextProfile(
  modelId: string,
  providerId: string,
  overrides?: ModelContextOverrides,
  discoveredModelContext?: DiscoveredMetadataMap,
): ModelContextProfile {
  const normalizedProviderId = providerId.trim();
  const normalizedModelId = modelId.trim();
  const key = formatFullModelId(normalizedProviderId, normalizedModelId);
  const registry = lookup(MODEL_PROFILES, key);
  const metadata = discoveredModelContext?.[key];
  const discovered = metadata ? effectiveModelMetadata(metadata) : undefined;
  const providerDefault = lookup(PROVIDER_DEFAULT_PROFILES, normalizedProviderId);
  const discoveredBase = ((): StaticModelContextProfile | null => {
    if (!discovered) return null;
    const contextWindowTokens = finiteInteger(discovered.contextWindowTokens);
    const maxOutputTokens = finiteInteger(discovered.maxOutputTokens);
    if (contextWindowTokens == null && maxOutputTokens == null) return null;
    const fallback = providerDefault ?? DEFAULT_PROFILE;
    return {
      ...fallback,
      ...(contextWindowTokens != null ? { contextWindowTokens } : {}),
      ...(maxOutputTokens != null ? { maxOutputTokens, buildOutputReserveTokens: maxOutputTokens } : {}),
    };
  })();
  const base = discoveredBase ?? (metadata?.reportedFields !== undefined ? undefined : registry) ?? providerDefault ?? DEFAULT_PROFILE;
  const baseSource: ModelContextProfileSource = discoveredBase
    ? "discovered"
    : registry && metadata?.reportedFields === undefined
      ? "registry"
      : providerDefault
        ? "provider-default"
        : "default";
  const override = resolveOverride(normalizedProviderId, normalizedModelId, overrides);
  return normalizeProfile({
    providerId: normalizedProviderId,
    modelId: normalizedModelId,
    base,
    override,
    source: override || metadata?.overrides?.contextWindowTokens !== undefined || metadata?.overrides?.maxOutputTokens !== undefined ? "override" : baseSource,
  });
}

// ------------------------------------------------------------------ OpenRouter function tools

/** lib/providers/tool-capabilities.ts `CapabilityEvidence`, as far as the rule reads it. */
export interface CapabilityEvidence {
  providerId: string;
  modelId?: string;
  capabilityId: string;
  support: string;
  expiresAt?: string;
  [field: string]: unknown;
}

/** lib/client/providers.ts `getPersistedProviderCapabilityEvidence`. */
export function persistedCapabilityEvidence(
  evidence: readonly CapabilityEvidence[] | undefined,
  providerId: string,
  modelId: string,
  nowMs = Date.now(),
): CapabilityEvidence[] | undefined {
  const matching = (evidence ?? []).filter((item) => {
    if (item.providerId !== providerId) return false;
    if (item.modelId !== undefined && item.modelId !== modelId) return false;
    if (item.expiresAt) {
      const expiresAt = Date.parse(item.expiresAt);
      if (Number.isFinite(expiresAt) && expiresAt <= nowMs) return false;
    }
    return true;
  });
  return matching.length > 0 ? matching : undefined;
}

/**
 * Whether OpenRouter's `function_calling` resolves to available for a model: the manifest's default
 * support, then its model rules, then catalog evidence (capability-resolution.ts `mergeCapabilityEvidence`;
 * readiness is available only for `supported` with no missing prerequisite).
 */
export function openRouterSupportsFunctionTools(modelId: string, catalogEvidence?: readonly CapabilityEvidence[]): boolean {
  const rule = MODEL_CATALOG_SNAPSHOT.functionCalling.openrouter;
  let support: string = rule.defaultSupport;
  for (const entry of rule.rules as ReadonlyArray<{ modelId?: string; modelPattern?: { source: string; flags: string }; support: string }>) {
    if (entry.modelId !== undefined && entry.modelId !== modelId) continue;
    if (entry.modelPattern !== undefined && !new RegExp(entry.modelPattern.source, entry.modelPattern.flags.replace("g", "")).test(modelId)) continue;
    if (entry.modelId === undefined && entry.modelPattern === undefined) continue;
    support = entry.support;
  }
  for (const evidence of catalogEvidence ?? []) {
    if (evidence.providerId !== "openrouter" || (evidence.modelId !== undefined && evidence.modelId !== modelId)) continue;
    if (evidence.capabilityId !== "function_calling") continue;
    support = evidence.support;
  }
  return support === "supported" && rule.prerequisiteIds.length === 0;
}
