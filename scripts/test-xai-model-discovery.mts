import assert from "node:assert/strict";
import { fetchProviderModelCatalog } from "../lib/client/settings-api";

const originalFetch = globalThis.fetch;
const requests: Array<{ url: string; authorization?: string }> = [];
try {
  globalThis.fetch = async (input, init) => {
    requests.push({
      url: String(input),
      authorization: new Headers(init?.headers).get("authorization") ?? undefined,
    });
    return new Response(
      JSON.stringify({
        models: [
          { id: "grok-4.7", input_modalities: ["text", "image"] },
          { id: "grok-4.7-fast-non-reasoning", input_modalities: ["text"] },
        ],
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  };

  const catalog = await fetchProviderModelCatalog({ providerId: "xai", apiKey: "xai-key" });
  assert.equal(requests[0]?.url, "https://api.x.ai/v1/language-models");
  assert.equal(requests[0]?.authorization, "Bearer xai-key");
  const grok = catalog.find((model) => model.id === "grok-4.7");
  const fast = catalog.find((model) => model.id === "grok-4.7-fast-non-reasoning");
  assert.equal(grok?.supportsImageInput, true);
  assert.equal(grok?.supportsTools, false);
  assert.equal(grok?.supportsToolChoice, false);
  assert.equal(grok?.supportsReasoningEffort, true);
  assert.equal(fast?.supportsImageInput, false);
  assert.equal(fast?.supportsReasoningEffort, false);
  console.log("PASS xAI discovery lists models without inventing unreported tool support");
  requests.length = 0;
  globalThis.fetch = async (input, init) => {
    requests.push({ url: String(input), authorization: new Headers(init?.headers).get("authorization") ?? undefined });
    assert.ok(!init?.method || init.method === "GET", "catalog discovery must not make a generation request");
    return new Response(JSON.stringify({ error: "Your team has either used all available credits or reached its monthly spending limit." }), { status: 403 });
  };
  await assert.rejects(fetchProviderModelCatalog({ providerId: "xai", apiKey: "xai-key" }), /blocked model catalog access.*no generation request was sent/i);
  assert.equal(requests.length, 1);
  globalThis.fetch = async () => new Response(JSON.stringify({ error: "Permission denied for this endpoint" }), { status: 403 });
  await assert.rejects(fetchProviderModelCatalog({ providerId: "xai", apiKey: "xai-key" }), /^Error: Permission denied for this endpoint$/);
  console.log("PASS xAI catalog credit restrictions are distinct from endpoint permission errors");
} finally {
  globalThis.fetch = originalFetch;
}
