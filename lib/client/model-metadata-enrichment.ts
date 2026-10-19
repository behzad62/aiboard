import { effectiveModelMetadata, extractModelMetadata, MODEL_METADATA_FIELDS, type ModelMetadataDetails, type ModelMetadataField, type ModelMetadataValues } from "@/lib/providers/model-metadata";
import type { ProviderCatalogModel } from "./settings-api";

type RecordValue = Record<string, unknown>;
const record = (value: unknown): RecordValue => value && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : {};
const own = (value: RecordValue, key: string): unknown => Object.hasOwn(value, key) ? value[key] : undefined;

/** Match the exact serving id, or an explicitly selected underlying-model catalog. Never infer aliases or billing. */
export function enrichCatalogMetadata(providerId: string, models: ProviderCatalogModel[], payload: unknown, fetchedAt: string, scope: "provider" | "model" = "provider") {
  const provider = record(own(record(payload), providerId));
  const entries = record(provider.models);
  let fieldsAdded = 0;
  const enriched = models.map((model) => {
    const lookupId = scope === "model" && providerId === "chatgpt" ? `openai/${model.id}` : model.id;
    const entry = record(own(scope === "model" ? record(payload) : entries, lookupId));
    if (entry.id !== lookupId) return model;
    const limit = record(entry.limit), cost = record(entry.cost), modalities = record(entry.modalities);
    const reference = extractModelMetadata({
      context_window: limit.context, max_output_tokens: limit.output,
      input_modalities: Array.isArray(modalities.input) && modalities.input.length > 0 && modalities.input.every((value) => typeof value === "string")
        ? modalities.input.map((value) => value === "pdf" ? "document" : value) : undefined,
      ...(scope === "provider" && !["chatgpt", "github-copilot"].includes(providerId) ? {
        inputUsdPer1M: cost.input, outputUsdPer1M: cost.output, cachedInputUsdPer1M: cost.cache_read,
      } : {}),
    });
    const current = effectiveModelMetadata({ ...model, supplemental: undefined, overrides: undefined });
    const values: ModelMetadataValues = {};
    for (const key of Object.keys(MODEL_METADATA_FIELDS) as ModelMetadataField[]) {
      if (current[key] === undefined && reference[key] !== undefined) Object.assign(values, { [key]: reference[key] });
    }
    const added = Object.keys(values).length;
    if (!added) return model;
    fieldsAdded += added;
    const supplemental: ModelMetadataDetails["supplemental"] = {
      source: "models.dev", fetchedAt, values,
      ...(scope === "model" ? { scope: "model" as const, modelId: lookupId } : {}),
      ...(typeof entry.last_updated === "string" && /^\d{4}-\d{2}-\d{2}$/.test(entry.last_updated) ? { updatedAt: entry.last_updated } : {}),
      ...(Object.keys(cost).some((key) => !["input", "output", "cache_read", "cache_write"].includes(key)) ? {
        pricingNote: "Base token rates only. Additional modality or tier rates may apply; check the provider's pricing before relying on estimates.",
      } : {}),
    };
    return applySupplementalCatalogMetadata(model, supplemental);
  });
  return { models: enriched, fieldsAdded };
}

export function applySupplementalCatalogMetadata(model: ProviderCatalogModel, supplemental: ModelMetadataDetails["supplemental"]) {
  if (!supplemental) return model;
  const effective = effectiveModelMetadata({ ...model, supplemental });
  return { ...model, ...effective, supplemental,
    inputModalities: ["text", "image", "document", "audio", "video"].filter((type) => effective[type as keyof ModelMetadataValues] === true),
    supportsImageInput: effective.image === true, supportsDocumentInput: effective.document === true,
    supportsAudioInput: effective.audio === true, supportsVideoInput: effective.video === true,
  };
}

/** Resolve exact underlying API model ids; Auto has no fixed API equivalent. */
export function enrichApiEquivalentPricing(providerId: string, models: ProviderCatalogModel[], payload: unknown, fetchedAt: string) {
  const catalog = record(payload);
  return models.map((model) => {
    const serving = record(own(record(record(own(catalog, providerId)).models), model.id));
    const canonicalId = providerId === "chatgpt" ? `openai/${model.id}` : serving.canonical_model_id;
    if (typeof canonicalId !== "string" || model.id === "auto") return model;
    const slash = canonicalId.indexOf("/");
    if (slash < 1) return model;
    const lab = canonicalId.slice(0, slash), id = canonicalId.slice(slash + 1);
    const entry = record(own(record(record(own(catalog, lab)).models), id));
    if (entry.id !== id) return model;
    const cost = record(entry.cost);
    const rates = extractModelMetadata({ inputUsdPer1M: cost.input, outputUsdPer1M: cost.output, cachedInputUsdPer1M: cost.cache_read });
    if (rates.inputUsdPer1M === undefined || rates.outputUsdPer1M === undefined) return model;
    const apiEquivalentPricing: NonNullable<ModelMetadataDetails["apiEquivalentPricing"]> = {
      source: "models.dev", modelId: `${lab}:${id}`, fetchedAt,
      values: { inputUsdPer1M: rates.inputUsdPer1M, outputUsdPer1M: rates.outputUsdPer1M,
        ...(rates.cachedInputUsdPer1M !== undefined ? { cachedInputUsdPer1M: rates.cachedInputUsdPer1M } : {}) },
    };
    return { ...model, ...effectiveModelMetadata({ ...model, apiEquivalentPricing }), apiEquivalentPricing };
  });
}

/** Public metadata only: provider credentials are never sent to this origin. */
export async function fetchSupplementalCatalogMetadata(providerId: string, models: ProviderCatalogModel[]) {
  if (models.length === 0) return { models, note: "" };
  // Canonical model-only facts are separate from OpenAI API serving details and prices.
  const isSubscription = providerId === "chatgpt";
  try {
    const response = await fetch(isSubscription ? "https://models.dev/models.json" : "https://models.dev/api.json", {
      credentials: "omit", referrerPolicy: "no-referrer", signal: AbortSignal.timeout(6000),
    });
    if (!response.ok) throw new Error("Reference catalog unavailable");
    const payload = await response.json();
    const result = enrichCatalogMetadata(providerId, models, payload, new Date().toISOString(), isSubscription ? "model" : "provider");
    if (isSubscription || providerId === "github-copilot") {
      // Canonical specifications contain no serving prices. Fetch the public API catalog separately.
      const apiPayload = isSubscription ? await fetch("https://models.dev/api.json", {
        credentials: "omit", referrerPolicy: "no-referrer", signal: AbortSignal.timeout(6000),
      }).then((response) => { if (!response.ok) throw new Error("API pricing references unavailable"); return response.json(); }).catch(() => undefined) : undefined;
      const priced = enrichApiEquivalentPricing(providerId, result.models, apiPayload ?? (isSubscription ? {} : payload), new Date().toISOString());
      const priceNote = priced.some((model) => model.apiEquivalentPricing)
        ? "API-equivalent reference rates show comparison costs, not subscription charges."
        : "No exact API-equivalent rates were found; comparison pricing remains unknown unless set manually.";
      return { models: priced, note: `${result.fieldsAdded
      ? `Filled ${result.fieldsAdded} missing model specifications from Models.dev underlying-model references.`
      : "No additional specifications were found for these exact model IDs."} ${priceNote} ${models.some((model) => model.id === "auto") ? "Auto pricing has no fixed API equivalent. " : ""}Subscription-specific limits can differ.` };
    }
    return { models: result.models, note: result.fieldsAdded
      ? `Filled ${result.fieldsAdded} missing model details from Models.dev references. Review the source labels below; save the provider to keep them.`
      : "Models.dev had no additional details for the exact provider/model IDs. Unmatched fields remain unknown." };
  } catch {
    return { models, note: "Provider catalog loaded. Models.dev details could not be refreshed. Saved references are retained; other missing fields remain unknown." };
  }
}
