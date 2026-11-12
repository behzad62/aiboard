import assert from "node:assert/strict";
import { fetchProviderModelCatalog } from "../lib/client/settings-api";
import { installStubRunner, STUB_PROXY_URL, type StubRequest } from "./model-proxy-test-support.mts";

// xAI's catalog goes through the Runner's model proxy (HM4a), which adds the key from the AIBoard home.
let answer: (request: StubRequest) => Response = () => new Response("{}");
const stub = installStubRunner({ proxyTokens: ["proxy_xai-stub"], upstream: (request) => answer(request) });
try {
  answer = () => new Response(
    JSON.stringify({
      models: [
        { id: "grok-4.7", input_modalities: ["text", "image"] },
        { id: "grok-4.7-fast-non-reasoning", input_modalities: ["text"] },
      ],
    }),
    { status: 200, headers: { "content-type": "application/json" } }
  );

  const catalog = await fetchProviderModelCatalog({ providerId: "xai" });
  assert.equal(stub.requests[0]?.url, `${STUB_PROXY_URL}/v2/model-proxy/xai/language-models`);
  assert.equal(stub.requests[0]?.headers.get("authorization"), "Bearer proxy_xai-stub");
  const grok = catalog.find((model) => model.id === "grok-4.7");
  const fast = catalog.find((model) => model.id === "grok-4.7-fast-non-reasoning");
  assert.equal(grok?.supportsImageInput, true);
  assert.equal(grok?.supportsTools, false);
  assert.equal(grok?.supportsToolChoice, false);
  assert.equal(grok?.supportsReasoningEffort, true);
  assert.equal(fast?.supportsImageInput, false);
  assert.equal(fast?.supportsReasoningEffort, false);
  console.log("PASS xAI discovery lists models without inventing unreported tool support");
  stub.requests.length = 0;
  answer = (request) => {
    assert.equal(request.method, "GET", "catalog discovery must not make a generation request");
    return new Response(JSON.stringify({ error: "Your team has either used all available credits or reached its monthly spending limit." }), { status: 403 });
  };
  await assert.rejects(fetchProviderModelCatalog({ providerId: "xai" }), /blocked model catalog access.*no generation request was sent/i);
  assert.equal(stub.requests.length, 1);
  answer = () => new Response(JSON.stringify({ error: "Permission denied for this endpoint" }), { status: 403 });
  await assert.rejects(fetchProviderModelCatalog({ providerId: "xai" }), /^Error: Permission denied for this endpoint$/);
  console.log("PASS xAI catalog credit restrictions are distinct from endpoint permission errors");
} finally {
  stub.restore();
}
