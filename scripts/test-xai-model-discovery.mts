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
  assert.equal(grok?.supportsTools, true);
  assert.equal(grok?.supportsReasoningEffort, true);
  assert.equal(fast?.supportsImageInput, false);
  assert.equal(fast?.supportsReasoningEffort, false);
  console.log("PASS xAI discovery uses the language-model catalog and preserves capabilities");
} finally {
  globalThis.fetch = originalFetch;
}