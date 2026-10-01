import assert from "node:assert/strict";
import { createAccountRunnerProvider } from "../lib/providers/account-runner";

const originalFetch = globalThis.fetch;
try {
  globalThis.fetch = async () => new Response(
    [
      'data: {"type":"provider_tool_event","providerToolEvent":{"tool":"web_search","phase":"started","providerManaged":true,"callId":"call-1"}}',
      "",
      'data: {"type":"provider_tool_event","providerToolEvent":{"tool":"web_search","phase":"completed","providerManaged":true,"callId":"call-1"}}',
      "",
      'data: {"type":"done"}',
      "",
      "",
    ].join("\n"),
    { headers: { "content-type": "text/event-stream" } },
  );

  const provider = createAccountRunnerProvider({
    id: "github-copilot",
    name: "GitHub Copilot",
    runnerPath: "github-copilot",
    models: [{
      id: "gpt-test",
      name: "GPT Test",
      providerId: "github-copilot",
      capabilities: { image: false, document: false, audio: false, video: false },
    }],
  });
  const chunks = [];
  for await (const chunk of provider.streamChat({
    apiKey: "runner-token",
    baseURL: "http://127.0.0.1:1455",
    model: "gpt-test",
    messages: [{ role: "user", content: "Search." }],
  })) chunks.push(chunk);

  assert.deepEqual(
    chunks.filter((chunk) => chunk.type === "provider_tool_event").map((chunk) => chunk.providerToolEvent),
    [
      { tool: "web_search", phase: "started", providerManaged: true, callId: "call-1" },
      { tool: "web_search", phase: "completed", providerManaged: true, callId: "call-1" },
    ],
  );
  console.log("PASS account-runner SSE preserves observable provider tool events");
} finally {
  globalThis.fetch = originalFetch;
}
