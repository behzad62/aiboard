import assert from "node:assert/strict";

import { formatModelId } from "../lib/providers/base";
import {
  getCatalogModelsForProvider,
  getValidationModelId,
} from "../lib/providers/catalog";
import { resolveModelContextProfile } from "../lib/providers/model-context";
import { getModelPricing } from "../lib/providers/pricing";
import { resolveProviderCapabilityProfile } from "../lib/providers/capability-resolution";
import {
  geminiThinkingConfig,
  providerSupportsReasoning,
} from "../lib/providers/reasoning";
import * as googleModule from "../lib/providers/google";

const modelId = "gemini-3.6-flash";
const fullModelId = formatModelId("google", modelId);
const model = getCatalogModelsForProvider("google").find(
  (candidate) => candidate.id === modelId
);

assert.ok(model, "Google catalog must expose stable Gemini 3.6 Flash");
assert.equal(model.name, "Gemini 3.6 Flash");
assert.deepEqual(model.capabilities, {
  image: true,
  document: true,
  audio: true,
  video: true,
});
assert.equal(
  getValidationModelId("google"),
  "gemini-3.8-flash",
  "Google validation should use the inherited Gemini 3.8 Flash candidate while 3.6 stays supported"
);

const pricing = getModelPricing(fullModelId);
assert.equal(pricing?.inputUsdPer1M, 1.5);
assert.equal(pricing?.cachedInputUsdPer1M, 0.15);
assert.equal(pricing?.outputUsdPer1M, 7.5);
assert.equal(pricing?.verifiedAt, "2026-07-22");

const context = resolveModelContextProfile(modelId, "google");
assert.equal(context.contextWindowTokens, 1_048_576);
assert.equal(context.maxOutputTokens, 65_536);
assert.equal(context.buildOutputReserveTokens, 65_536);
assert.equal(context.longContextQuality, "excellent");
assert.equal(context.promptCaching, true);
assert.deepEqual(context.recommendedBuildRoles, [
  "architect",
  "worker",
  "reviewer",
  "summary",
]);

assert.equal(providerSupportsReasoning(fullModelId), true);
const toolProfile = resolveProviderCapabilityProfile({ providerId: "google", modelId });
assert.equal(toolProfile.capabilities.web_search?.descriptor.support, "supported");
assert.equal(toolProfile.capabilities.function_calling?.descriptor.support, "supported");
assert.equal(toolProfile.capabilities.code_execution?.descriptor.support, "supported");

for (const effort of ["none", "low", "medium"] as const) {
  assert.deepEqual(geminiThinkingConfig(modelId, effort, 4096), {
    thinkingLevel: "MEDIUM",
  });
}
for (const effort of ["high", "max"] as const) {
  assert.deepEqual(geminiThinkingConfig(modelId, effort, 4096), {
    thinkingLevel: "HIGH",
  });
}
assert.equal(geminiThinkingConfig(modelId, "default", 4096), null);

const googleSamplingConfig = (
  googleModule as unknown as {
    googleSamplingConfig?: (
      model: string,
      temperature: number | undefined
    ) => Record<string, number>;
  }
).googleSamplingConfig;
assert.equal(
  typeof googleSamplingConfig,
  "function",
  "Google transport must expose its model-specific sampling compatibility rule"
);
assert.deepEqual(googleSamplingConfig!(modelId, 0.2), {});
assert.deepEqual(googleSamplingConfig!("gemini-3.5-flash", 0.2), {
  temperature: 0.2,
});

console.log("Gemini 3.6 Flash support: PASS");
