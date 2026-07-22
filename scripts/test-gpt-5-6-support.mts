/* GPT-5.6 provider support checks (run: npx tsx scripts/test-gpt-5-6-support.mts) */
import assert from "node:assert/strict";
import { formatModelId } from "../lib/providers/base";
import {
  getCatalogModelsForProvider,
  getValidationModelId,
} from "../lib/providers/catalog";
import { resolveModelContextProfile } from "../lib/providers/model-context";
import { getModelPricing } from "../lib/providers/pricing";
import {
  providerSupportsMaxTokensFeature,
  providerSupportsNativeBuildToolsFeature,
  providerSupportsNativeWebSearchFeature,
} from "../lib/providers/provider-registry";
import {
  openAIReasoningEffort,
  providerSupportsReasoning,
} from "../lib/providers/reasoning";

const ids = ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"] as const;
const legacyIds = ["gpt-5.6", "gpt-5.6-pro", "gpt-5.6-mini"];
const prices = {
  "gpt-5.6-sol": [5, 0.5, 30],
  "gpt-5.6-terra": [2.5, 0.25, 15],
  "gpt-5.6-luna": [1, 0.1, 6],
} as const;

for (const providerId of ["openai", "chatgpt"] as const) {
  const family = getCatalogModelsForProvider(providerId).filter((model) =>
    model.id.startsWith("gpt-5.6")
  );
  assert.deepEqual(
    family.map((model) => model.id),
    ids,
    `${providerId} must expose only the official GPT-5.6 family`
  );
  assert.equal(
    family.some((model) => legacyIds.includes(model.id)),
    false,
    `${providerId} must remove legacy GPT-5.6 aliases`
  );

  for (const id of ids) {
    const model = family.find((candidate) => candidate.id === id);
    assert.deepEqual(model?.capabilities, {
      image: true,
      document: true,
      audio: false,
      video: false,
    });

    const context = resolveModelContextProfile(id, providerId);
    assert.equal(context.contextWindowTokens, 1_050_000);
    assert.equal(context.maxOutputTokens, 128_000);
    assert.equal(context.buildOutputReserveTokens, 128_000);
    assert.equal(context.effectiveBuildInputCeilingTokens, 922_000);
    assert.equal(context.longContextQuality, "excellent");
    assert.equal(context.promptCaching, true);
    assert.deepEqual(context.recommendedBuildRoles, [
      "architect",
      "worker",
      "reviewer",
      "summary",
    ]);

    assert.equal(providerSupportsReasoning(`${providerId}:${id}`), true);
    assert.equal(providerSupportsNativeWebSearchFeature(providerId, id), true);

    const pricing = getModelPricing(formatModelId(providerId, id));
    assert.equal(pricing?.inputUsdPer1M, prices[id][0]);
    assert.equal(pricing?.cachedInputUsdPer1M, prices[id][1]);
    assert.equal(pricing?.outputUsdPer1M, prices[id][2]);
    assert.equal(pricing?.verifiedAt, "2026-07-22");
    if (providerId === "chatgpt") {
      assert.match(pricing?.notes ?? "", /reference/i);
      assert.match(pricing?.notes ?? "", /not ChatGPT billing/i);
    }
  }
}

assert.equal(getValidationModelId("openai"), "gpt-5.6-luna");
assert.equal(
  openAIReasoningEffort("max", "gpt-5.6-sol"),
  "max",
  "GPT-5.6 must receive native max reasoning"
);
assert.equal(
  openAIReasoningEffort("max", "gpt-5.5"),
  "xhigh",
  "older GPT models must retain the compatibility mapping"
);
for (const id of ids) {
  assert.equal(providerSupportsMaxTokensFeature("chatgpt", id), false);
  assert.equal(providerSupportsNativeBuildToolsFeature("chatgpt", id), false);
}

console.log("PASS");
