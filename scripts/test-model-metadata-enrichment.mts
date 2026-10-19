import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { enrichApiEquivalentPricing, enrichCatalogMetadata, fetchSupplementalCatalogMetadata } from "../lib/client/model-metadata-enrichment";
import { buildProviderCatalogModel, persistProviderCatalogModels, saveModelMetadataOverrides, saveProviderKey } from "../lib/client/settings-api";
import { __resetClientStoreForTests, getUserSettings } from "../lib/client/store";
import { effectiveModelMetadata, missingModelMetadata } from "../lib/providers/model-metadata";
import { resolveClientModelContextProfile, resolveModelCapabilities } from "../lib/client/providers";
import { getModelPricing } from "../lib/providers/pricing";
import { ModelMetadataEditor } from "../components/ModelMetadataEditor";

const primary = buildProviderCatalogModel({ id: "new-model", context_window: 1000000, image: false, inputUsdPer1M: 0 });
const references = { google: { models: {
  "new-model": { id: "new-model", cost: { input: 5, output: 10, cache_read: 0.2, input_audio: 8 },
    limit: { context: 128000, output: 32768 }, modalities: { input: ["text", "image", "pdf"] }, last_updated: "2026-10-19" },
  "reference-only": { id: "reference-only", cost: { input: 1, output: 2 } },
} }, openai: { models: { "new-model": { id: "new-model", cost: { output: 99 } } } } };
const result = enrichCatalogMetadata("google", [primary], references, "2026-10-19T00:00:00Z");
assert.equal(result.models.length, 1, "reference catalogs must not add models or imply account availability");
const model = result.models[0];
assert.equal(model.contextWindowTokens, 1000000);
assert.equal(model.inputUsdPer1M, 0, "provider-reported zero wins over reference rates");
assert.equal(model.supportsImageInput, false, "provider-reported false wins over reference capabilities");
assert.equal(model.maxOutputTokens, 32768);
assert.equal(model.outputUsdPer1M, 10);
assert.equal(model.supportsDocumentInput, true);
assert.equal(model.supplemental?.values.contextWindowTokens, undefined);
assert.equal(model.reportedFields?.includes("outputUsdPer1M"), false, "references must not become provider-reported facts");
assert.equal(missingModelMetadata(model).length, 0);
assert.deepEqual(enrichCatalogMetadata("google", [buildProviderCatalogModel({ id: "new-model-preview" })], references, "now").models[0].supplemental, undefined, "never guess aliases");
const account = enrichCatalogMetadata("github-copilot", [primary], { "github-copilot": references.google }, "now").models[0];
assert.equal(account.supplemental?.values.outputUsdPer1M, undefined, "API prices must not become subscription billing");
const invalid = enrichCatalogMetadata("google", [buildProviderCatalogModel({ id: "bad" })], { google: { models: { bad: { id: "bad", cost: { input: -1, output: null }, limit: { output: 0 }, modalities: { input: [] } } } } }, "now");
assert.equal(invalid.fieldsAdded, 0, "invalid/missing references stay unknown");

__resetClientStoreForTests({});
saveProviderKey({ providerId: "google", apiKey: "private-provider-key", models: [model.id], enabledModelIds: [model.id] });
persistProviderCatalogModels("google", [model]);
const id = "google:new-model";
assert.equal(getModelPricing(id, undefined, getUserSettings().discoveredModelMetadata)?.outputUsdPer1M, 10);
assert.match(getModelPricing(id, undefined, getUserSettings().discoveredModelMetadata)!.sourceLabel, /Models.dev/);
assert.equal(resolveClientModelContextProfile(id).maxOutputTokens, 32768);
assert.equal(resolveModelCapabilities(id)?.document, true);
saveModelMetadataOverrides(id, { outputUsdPer1M: 3 });
assert.equal(effectiveModelMetadata(getUserSettings().discoveredModelMetadata?.[id]).outputUsdPer1M, 3);
persistProviderCatalogModels("google", [primary]);
assert.equal(effectiveModelMetadata(getUserSettings().discoveredModelMetadata?.[id]).maxOutputTokens, 32768, "plain provider refreshes preserve saved references");
assert.equal(effectiveModelMetadata(getUserSettings().discoveredModelMetadata?.[id]).outputUsdPer1M, 3, "refreshes preserve manual overrides");
const html = renderToStaticMarkup(React.createElement(ModelMetadataEditor, { modelId: id, metadata: getUserSettings().discoveredModelMetadata?.[id], overrides: {}, onChange: () => {} }));
assert.match(html, /Models.dev reference: 10/);
assert.match(html, /community-maintained/);
assert.match(html, /Catalog: Not reported/);

const realFetch = globalThis.fetch;
try {
  let requests = 0;
  globalThis.fetch = async (input, init) => {
    requests++;
    assert.equal(String(input), "https://models.dev/api.json");
    assert.equal(new Headers(init?.headers).has("authorization"), false);
    assert.equal(init?.credentials, "omit");
    assert.equal(init?.referrerPolicy, "no-referrer");
    return new Response(JSON.stringify(references), { status: 200 });
  };
  assert.match((await fetchSupplementalCatalogMetadata("google", [primary])).note, /Filled/);
  assert.equal(requests, 1);
  const subscription = buildProviderCatalogModel({ id: "gpt-6.1-sol", context_window: 500000, input_modalities: ["text", "image"] });
  globalThis.fetch = async (input, init) => {
    requests++;
    assert.equal(new Headers(init?.headers).has("authorization"), false);
    assert.equal(init?.credentials, "omit");
    if (String(input) === "https://models.dev/api.json") return new Response(JSON.stringify({ openai: { models: {
      "gpt-6.1-sol": { id: "gpt-6.1-sol", cost: { input: 2, output: 10, cache_read: 0.1 } },
    } } }));
    assert.equal(String(input), "https://models.dev/models.json");
    return new Response(JSON.stringify({ "openai/gpt-6.1-sol": { id: "openai/gpt-6.1-sol", limit: { context: 1050000, output: 128000 },
      modalities: { input: ["text", "image", "pdf"] }, cost: { input: 5, output: 30 } } }));
  };
  const plan = await fetchSupplementalCatalogMetadata("chatgpt", [subscription]);
  assert.equal(requests, 3);
  assert.equal(plan.models[0].contextWindowTokens, 500000, "account context wins over the generic model context");
  assert.equal(plan.models[0].maxOutputTokens, 128000);
  assert.equal(plan.models[0].supportsDocumentInput, false, "model references cannot override account-reported input types");
  assert.equal(plan.models[0].inputUsdPer1M, 2);
  assert.equal(plan.models[0].outputUsdPer1M, 10, "API-equivalent rates use the serving API catalog, never costs in canonical specs");
  assert.equal(plan.models[0].supplemental?.scope, "model");
  assert.match(plan.note, /API-equivalent/);
  persistProviderCatalogModels("chatgpt", plan.models);
  const price = getModelPricing("chatgpt:gpt-6.1-sol", undefined, getUserSettings().discoveredModelMetadata);
  assert.equal(price?.basis, "api-equivalent");
  assert.equal(price?.inputUsdPer1M, 2);
  const apiOverride = { "openai:gpt-6.1-sol": { inputUsdPer1M: 4, outputUsdPer1M: 20, cachedInputUsdPer1M: 0.2, updatedAt: "now" } };
  assert.equal(getModelPricing("chatgpt:gpt-6.1-sol", apiOverride, getUserSettings().discoveredModelMetadata)?.inputUsdPer1M, 4, "comparison tracks the API mode's current prices");
  const localOverride = { ...apiOverride, "chatgpt:gpt-6.1-sol": { inputUsdPer1M: 3, outputUsdPer1M: 15, updatedAt: "now" } };
  assert.equal(getModelPricing("chatgpt:gpt-6.1-sol", localOverride, getUserSettings().discoveredModelMetadata)?.inputUsdPer1M, 3, "subscription-specific manual comparisons remain editable");
  assert.match(price!.notes!, /not a subscription charge/);
  persistProviderCatalogModels("chatgpt", [subscription]);
  assert.equal(getUserSettings().discoveredModelMetadata?.["chatgpt:gpt-6.1-sol"]?.apiEquivalentPricing?.values.outputUsdPer1M, 10, "raw refresh keeps the comparison reference");
  const copilot = enrichApiEquivalentPricing("github-copilot", [buildProviderCatalogModel({id:"auto"}),buildProviderCatalogModel({id:"claude-sonnet-4.6"})], {
    "github-copilot": {models:{"claude-sonnet-4.6":{id:"claude-sonnet-4.6",canonical_model_id:"anthropic/claude-sonnet-4-6"}}},
    anthropic:{models:{"claude-sonnet-4-6":{id:"claude-sonnet-4-6",cost:{input:3,output:15}}}},
  }, "now");
  assert.equal(copilot[0].apiEquivalentPricing, undefined, "Auto must not be assigned a fabricated fixed price");
  assert.equal(copilot[1].apiEquivalentPricing?.values.inputUsdPer1M, 3);
  globalThis.fetch = async () => { throw new Error("network unavailable"); };
  const failed = await fetchSupplementalCatalogMetadata("google", [primary]);
  assert.deepEqual(failed.models, [primary]);
  assert.match(failed.note, /could not be refreshed/);
} finally { globalThis.fetch = realFetch; }
console.log("PASS browser-only metadata enrichment, exact matching, provenance, precedence, subscription billing isolation, persistence, and graceful failure");
