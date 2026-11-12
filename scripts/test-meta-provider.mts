import assert from "node:assert/strict";
import { fetchProviderModelCatalog } from "../lib/client/settings-api";
import { metaProvider } from "../lib/providers/meta";
import { installStubRunner, STUB_PROXY_URL } from "./model-proxy-test-support.mts";

// Meta calls go through the Runner's model proxy (HM4a); the stub answers for both.
const META_PROXY_BASE = `${STUB_PROXY_URL}/v2/model-proxy/meta`;
const stub = installStubRunner({
  upstream: () =>
    new Response(
      JSON.stringify({
        data: [
          { id: "muse-spark-1.3", name: "Muse Spark 1.3" },
          { id: "muse-spark-1.2", name: "Muse Spark 1.2" },
          { id: "muse-image-1", name: "Muse Image" },
        ],
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    ),
});
try {
  const valid = await metaProvider.validateConnection({ apiKey: "proxy_stub-token", baseURL: META_PROXY_BASE });
  assert.equal(valid, true);
  assert.equal(stub.requests[0]?.url, `${META_PROXY_BASE}/models`);
  assert.equal(stub.requests[0]?.headers.get("authorization"), "Bearer proxy_stub-token");

  const catalog = await fetchProviderModelCatalog({ providerId: "meta" });
  assert.deepEqual(
    catalog.map((model) => [model.id, model.name]),
    [["muse-spark-1.2", "Muse Spark 1.2"], ["muse-spark-1.3", "Muse Spark 1.3"]]
  );
  assert.equal(stub.requests[1]?.url, `${META_PROXY_BASE}/models`);
  assert.equal(stub.requests[1]?.headers.get("authorization"), "Bearer proxy_stub-token");
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
  stub.restore();
}