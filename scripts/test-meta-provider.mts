import assert from "node:assert/strict";
import { fetchProviderModelCatalog } from "../lib/client/settings-api";
import { META_MODEL_API_BASE_URL, metaProvider } from "../lib/providers/meta";

const requests: Array<{ url: string; authorization?: string }> = [];
const originalFetch = globalThis.fetch;
try {
  globalThis.fetch = async (input, init) => {
    requests.push({
      url: String(input),
      authorization: new Headers(init?.headers).get("authorization") ?? undefined,
    });
    return new Response(
      JSON.stringify({
        data: [
          { id: "muse-spark-1.3", name: "Muse Spark 1.3" },
          { id: "muse-spark-1.2", name: "Muse Spark 1.2" },
          { id: "muse-image-1", name: "Muse Image" },
        ],
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  };

  const valid = await metaProvider.validateApiKey("meta-key");
  assert.equal(valid, true);
  assert.equal(requests[0]?.url, `${META_MODEL_API_BASE_URL}/models`);
  assert.equal(requests[0]?.authorization, "Bearer meta-key");

  const catalog = await fetchProviderModelCatalog({ providerId: "meta", apiKey: "meta-key" });
  assert.deepEqual(
    catalog.map((model) => [model.id, model.name]),
    [["muse-spark-1.2", "Muse Spark 1.2"], ["muse-spark-1.3", "Muse Spark 1.3"]]
  );
  assert.equal(requests[1]?.url, `${META_MODEL_API_BASE_URL}/models`);
  assert.equal(requests[1]?.authorization, "Bearer meta-key");
  assert.equal(catalog.every((model) => model.id.startsWith("muse-spark-")), true);
  assert.equal(
    catalog.every(
      (model) =>
        !model.supportsTools &&
        !model.supportsToolChoice &&
        !model.supportsStructuredOutputs &&
        !model.supportsReasoning &&
        !model.supportsReasoningEffort
    ),
    true,
    "Meta model listing proves model existence only; tool/structured/reasoning support comes from manifests or scoped evidence"
  );
  console.log("PASS Meta model discovery filters Muse Spark without guessing tool capability truth");
} finally {
  globalThis.fetch = originalFetch;
}