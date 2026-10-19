import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { __resetClientStoreForTests, getUserSettings } from "../lib/client/store";
import { getAllProviders, listProviderModelInfos, getEnabledModels, resolveModelCapabilities, resolveClientModelContextProfile } from "../lib/client/providers";
import { getProviderDefinition } from "../lib/providers/provider-registry";
import { buildProviderCatalogModel, buildOpenRouterCatalogModel, collectGoogleModelCatalog, fetchProviderModelCatalog, persistProviderCatalogModels, saveModelMetadataOverrides, getModelMetadataOverrides, savePricingOverride, saveModelContextOverride, saveProviderKey, loadProviders } from "../lib/client/settings-api";
import { effectiveModelMetadata, extractModelMetadata, missingModelMetadata } from "../lib/providers/model-metadata";
import { getModelPricing } from "../lib/providers/pricing";
import { ModelMetadataEditor } from "../components/ModelMetadataEditor";

__resetClientStoreForTests({});
for (const provider of getAllProviders()) if (getProviderDefinition(provider.id)?.modelDiscovery) {
  assert.deepEqual(listProviderModelInfos(provider.id as Parameters<typeof listProviderModelInfos>[0]), [], `${provider.id} must not prepopulate preset models`);
}
assert.deepEqual(getEnabledModels(), []);
saveProviderKey({ providerId: "openai", apiKey: "fake-key", enabledModelIds: ["saved-selection"], defaultModel: "saved-selection" });
assert.deepEqual(listProviderModelInfos("openai").map((model) => model.id), ["saved-selection"], "retain existing saved selections");
assert.deepEqual(loadProviders().providers.find((provider) => provider.providerId === "openai")?.modelIds, ["saved-selection"]);
saveProviderKey({ providerId: "openai", models: [], enabledModelIds: [], defaultModel: null });
assert.deepEqual(listProviderModelInfos("openai"), [], "removed models must not reappear from the static catalog");
saveProviderKey({ providerId: "openai", models: ["gpt-5.4"], enabledModelIds: ["gpt-5.4"], defaultModel: "gpt-5.4" });
assert.equal(getModelPricing("openai:gpt-5.4", undefined, getUserSettings().discoveredModelMetadata), null,
  "manually added ids without catalog data must not inherit stale reference prices");
assert.deepEqual(getUserSettings().discoveredModelMetadata?.["openai:gpt-5.4"]?.reportedFields, []);
saveProviderKey({ providerId: "nvidia", apiKey: "fake-key", models: ["minimaxai/minimax-m3"] });
assert.equal(resolveModelCapabilities("nvidia:minimaxai/minimax-m3")?.image, false,
  "unreported modalities cannot inherit assumptions from bundled records");

const model = buildOpenRouterCatalogModel({ id: "google/gemini-3.1-pro-preview", name: "Fresh name", context_length: 16384,
  top_provider: { max_completion_tokens: 2048 }, pricing: { prompt: "0.000012", completion: "0.000034", input_cache_read: "0" },
  architecture: { input_modalities: ["text", "image", "file"] }, supported_parameters: ["tools"] });
assert.equal(model.maxOutputTokens, 2048);
assert.equal(model.cachedInputUsdPer1M, 0);
saveProviderKey({ providerId: "openrouter", apiKey: "fake-key", models: [model.id], enabledModelIds: [model.id], defaultModel: model.id });
persistProviderCatalogModels("openrouter", [model]);
const key = `openrouter:${model.id}`;
assert.equal(listProviderModelInfos("openrouter")[0].name, "Fresh name");
assert.equal(resolveModelCapabilities(key)?.image, true);
assert.equal(resolveModelCapabilities(key)?.document, true);
assert.equal(resolveClientModelContextProfile(key).contextWindowTokens, 16384, "live limits replace historical static limits");
assert.equal(resolveClientModelContextProfile(key).maxOutputTokens, 2048);
assert.equal(getModelPricing(key, undefined, getUserSettings().discoveredModelMetadata)?.inputUsdPer1M, 12);
saveModelMetadataOverrides(key, { contextWindowTokens: 8192, maxOutputTokens: 1024, inputUsdPer1M: 0, image: false });
assert.equal(resolveModelCapabilities(key)?.image, false);
assert.equal(resolveClientModelContextProfile(key).contextWindowTokens, 8192);
assert.equal(getModelPricing(key, undefined, getUserSettings().discoveredModelMetadata)?.inputUsdPer1M, 0, "explicit zero remains valid");
persistProviderCatalogModels("openrouter", [{ ...model, contextWindowTokens: 32768, inputUsdPer1M: 50 }]);
assert.equal(resolveClientModelContextProfile(key).contextWindowTokens, 8192, "refresh preserves manual overrides");
assert.equal(getModelPricing(key, undefined, getUserSettings().discoveredModelMetadata)?.outputUsdPer1M, 34);
saveModelMetadataOverrides(key, {});
assert.equal(resolveClientModelContextProfile(key).contextWindowTokens, 32768);
assert.equal(getModelPricing(key, undefined, getUserSettings().discoveredModelMetadata)?.inputUsdPer1M, 50);

const sparse = buildProviderCatalogModel({ id: "gpt-5.6-sol", created: 1800000000 });
assert.equal(sparse.inputUsdPer1M, undefined);
assert.equal(sparse.inputModalities.length, 0);
assert.ok(missingModelMetadata(sparse).includes("image"));
assert.ok(missingModelMetadata(sparse).includes("text"));
saveProviderKey({ providerId: "openai", models: [sparse.id], enabledModelIds: [sparse.id], defaultModel: sparse.id });
persistProviderCatalogModels("openai", [sparse]);
assert.equal(getModelPricing(`openai:${sparse.id}`, undefined, getUserSettings().discoveredModelMetadata), null, "unknown prices cannot fall back silently to stale reference prices");
assert.equal(resolveModelCapabilities(`openai:${sparse.id}`)?.image, false, "unknown input support is conservative at runtime");
saveModelMetadataOverrides(`openai:${sparse.id}`, { image: true, inputUsdPer1M: 3 });
assert.equal(resolveModelCapabilities(`openai:${sparse.id}`)?.image, true);
assert.equal(getModelPricing(`openai:${sparse.id}`, undefined, getUserSettings().discoveredModelMetadata), null, "one missing price still yields unknown cost");
assert.throws(() => saveModelMetadataOverrides(key, { maxOutputTokens: -1 }));
assert.throws(() => saveModelMetadataOverrides(key, { contextWindowTokens: 2.5 }));
assert.throws(() => saveModelMetadataOverrides(key, { inputUsdPer1M: NaN }));
const copilot = buildProviderCatalogModel({ id: "copilot-model", capabilities: { supports: { vision: false }, limits: { max_context_window_tokens: 64000 } }, billing: { multiplier: 2 } });
assert.equal(copilot.contextWindowTokens, 64000);
assert.equal(effectiveModelMetadata(copilot).image, false);
assert.equal(copilot.inputUsdPer1M, undefined, "Copilot credit multipliers are not USD token prices");
const anthropic = buildProviderCatalogModel({ id: "claude-new", max_input_tokens: 200000, max_tokens: 32000 });
assert.equal(anthropic.contextWindowTokens, 200000); assert.equal(anthropic.maxOutputTokens, 32000);
const google = await collectGoogleModelCatalog({ async *[Symbol.asyncIterator]() {
  yield { name: "models/gemini-new", inputTokenLimit: 1048576, outputTokenLimit: 65536, supportedActions: ["generateContent"] };
} });
assert.equal(google[0].contextWindowTokens, 1048576); assert.equal(google[0].maxOutputTokens, 65536);
assert.equal(buildOpenRouterCatalogModel({ id: "missing", pricing: { prompt: "", completion: "" } }).inputUsdPer1M, undefined);
assert.equal(buildOpenRouterCatalogModel({ id: "missing", pricing: { prompt: " ", completion: "0" } }).inputUsdPer1M, undefined);
const xai = extractModelMetadata({ prompt_text_token_price: 12500, completion_text_token_price: 25000, cached_prompt_text_token_price: 2000 }, "xai");
assert.equal(xai.inputUsdPer1M, 1.25); assert.equal(xai.outputUsdPer1M, 2.5); assert.equal(xai.cachedInputUsdPer1M, 0.2);
savePricingOverride({ fullModelId: key, inputUsdPer1M: 4, outputUsdPer1M: 5 });
saveModelContextOverride({ fullModelId: key, contextWindowTokens: 65536, maxOutputTokens: 4096 });
const previousOverrides = getModelMetadataOverrides(key);
assert.equal(previousOverrides.inputUsdPer1M, 4); assert.equal(previousOverrides.contextWindowTokens, 65536);
saveModelMetadataOverrides(key, { ...previousOverrides, inputUsdPer1M: 6, contextWindowTokens: 16384 });
assert.equal(getModelPricing(key, getUserSettings().modelPricingOverrides, getUserSettings().discoveredModelMetadata)?.inputUsdPer1M, 6);
assert.equal(resolveClientModelContextProfile(key).contextWindowTokens, 16384, "older settings overrides cannot shadow new details edits");
savePricingOverride({ fullModelId: key, clear: true });
saveModelContextOverride({ fullModelId: key, clear: true });
assert.equal(getModelPricing(key, getUserSettings().modelPricingOverrides, getUserSettings().discoveredModelMetadata)?.inputUsdPer1M, 50);
assert.equal(resolveClientModelContextProfile(key).contextWindowTokens, 32768, "reset in the existing editor also clears metadata overrides");
saveModelMetadataOverrides(key, { inputUsdPer1M: 7, contextWindowTokens: 64000 });
saveModelContextOverride({ fullModelId: key, contextWindowTokens: 65536, maxOutputTokens: 4096,
  buildOutputReserveTokens: 1024, effectiveBuildInputCeilingTokens: 60000, longContextQuality: "excellent", promptCaching: true, recommendedBuildRoles: ["architect"] });
saveModelContextOverride({ fullModelId: key, clearBuildSettings: true });
assert.equal(getUserSettings().modelContextOverrides?.[key]?.contextWindowTokens, 65536);
assert.equal(getUserSettings().modelContextOverrides?.[key]?.maxOutputTokens, 4096);
assert.equal(getUserSettings().modelContextOverrides?.[key]?.buildOutputReserveTokens, undefined);
assert.equal(getUserSettings().discoveredModelMetadata?.[key]?.overrides?.contextWindowTokens, 64000);
assert.equal(getUserSettings().discoveredModelMetadata?.[key]?.overrides?.inputUsdPer1M, 7, "Build resets preserve separate model details");
const realFetch = globalThis.fetch;
let pages = 0;
globalThis.fetch = (async (input) => {
  pages++;
  const second = String(input).includes("after_id=");
  return new Response(JSON.stringify({ data: [{ id: second ? "claude-second" : "claude-first", display_name: "Published model", created_at: "2026-10-19T00:00:00Z", max_input_tokens: 64000, max_tokens: 4096 }],
    has_more: !second, first_id: second ? "claude-second" : "claude-first", last_id: second ? "claude-second" : "claude-first" }), { headers: { "content-type": "application/json" } });
}) as typeof fetch;
try {
  const catalog = await fetchProviderModelCatalog({ providerId: "anthropic", apiKey: "fake-key" });
  assert.equal(pages, 2); assert.equal(catalog.length, 2);
  assert.equal(catalog[1].contextWindowTokens, 64000); assert.equal(catalog[1].maxOutputTokens, 4096);
} finally { globalThis.fetch = realFetch; }
const html = renderToStaticMarkup(React.createElement(ModelMetadataEditor, { modelId: "new", metadata: sparse, overrides: {}, onChange: () => {} }));
assert.match(html, /unknown/); assert.match(html, /Not checked/); assert.match(html, /Max output tokens/); assert.match(html, /Input price/);
assert.equal(html.includes('value="0"'), false, "blank fields must not turn into free pricing");
const subscription = buildProviderCatalogModel({ slug: "gpt-6.1-sol", display_name: "GPT-6.1-Sol", context_window: 500000,
  max_context_window: 872000, input_modalities: ["text", "image"] });
persistProviderCatalogModels("chatgpt", [subscription]);
const subscriptionMetadata = getUserSettings().discoveredModelMetadata?.["chatgpt:gpt-6.1-sol"];
assert.equal(subscriptionMetadata?.contextWindowTokens, 500000, "use the default context, not the opt-in expanded limit");
assert.equal(effectiveModelMetadata(subscriptionMetadata).text, true);
assert.equal(effectiveModelMetadata(subscriptionMetadata).image, true);
assert.equal(effectiveModelMetadata(subscriptionMetadata).video, false);
assert.deepEqual(missingModelMetadata(subscriptionMetadata), ["maxOutputTokens", "inputUsdPer1M", "outputUsdPer1M", "cachedInputUsdPer1M"]);
const checkedHtml = renderToStaticMarkup(React.createElement(ModelMetadataEditor, { modelId: "subscription", metadata: subscriptionMetadata, overrides: {}, onChange: () => {} }));
assert.match(checkedHtml, /Not reported/);
assert.doesNotMatch(checkedHtml, /Not checked/);
console.log("PASS no preset models, saved selections, provider metadata, runtime pricing/context/inputs, optional overrides, refresh preservation, and unknown-data UI");
