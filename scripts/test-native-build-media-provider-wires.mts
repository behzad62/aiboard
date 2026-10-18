import assert from "node:assert/strict";
import { AnthropicModel } from "../runner-v2/src/anthropic-model";
import { GoogleModel } from "../runner-v2/src/google-model";
import { OpenAICompatibleModel } from "../runner-v2/src/openai-compatible-model";
import { AccountRunnerModel } from "../runner-v2/src/account-runner-model";
import type { AgentModelRequest } from "../runner-v2/src/agent-contracts";

const img = { filename: "screenshot.png", mimeType: "image/png" as const, base64Data: "iVBORw0KGgo=" };
const pdf = { filename: "report.pdf", mimeType: "application/pdf" as const, base64Data: "JVBERi0xLjc=" };
const request: AgentModelRequest = {
  sessionId: "visual-wire",
  messages: [{ id: "system", role: "system", content: "You are helpful." }, { id: "user", role: "user", content: "Describe these files." }],
  tools: [], toolChoice: "none", attachments: [img, pdf],
};

async function runProvider(
  create: (fetchImpl: typeof fetch) => { complete(input: AgentModelRequest): Promise<unknown> },
  reply: unknown,
): Promise<Record<string, unknown>> {
  let payload: Record<string, unknown> | null = null;
  const mockFetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    payload = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    return new Response(JSON.stringify(reply), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  await create(mockFetch).complete(request);
  assert.ok(payload);
  return payload!;
}
const anth = await runProvider(
  (fetchImpl) => new AnthropicModel({ apiKey: "test", modelId: "claude-test", fetch: fetchImpl }),
  { stop_reason: "end_turn", content: [{ type: "text", text: "ok" }] },
);
const anthUser = (anth.messages as Array<Record<string, unknown>>).at(-1)!;
const anthParts = anthUser.content as Array<Record<string, unknown>>;
assert.equal(anthParts[1]?.type, "image");
assert.equal(anthParts[2]?.type, "document");

const google = await runProvider(
  (fetchImpl) => new GoogleModel({ apiKey: "test", modelId: "gemini-test", fetch: fetchImpl }),
  { candidates: [{ content: { parts: [{ text: "ok" }] } }] },
);
const googUser = (google.contents as Array<Record<string, unknown>>).at(-1)!;
const parts = googUser.parts as Array<{ inlineData?: { mimeType?: string } }>;
assert.equal(parts[1]?.inlineData?.mimeType, "image/png");
assert.equal(parts[2]?.inlineData?.mimeType, "application/pdf");

const responses = await runProvider(
  (fetchImpl) => new OpenAICompatibleModel({ baseUrl: "https://example.test", apiKey: "test", modelId: "gpt-test", protocol: "responses", fetch: fetchImpl }),
  { status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: "ok" }] }] },
);
const openUser = (responses.input as Array<Record<string, unknown>>).at(-1)!;
assert.deepEqual((openUser.content as Array<Record<string, unknown>>).slice(1).map((x) => x.type), ["input_image", "input_file"]);

const chatRequest = { ...request, attachments: [img] };
let chatPayload: Record<string, unknown> | undefined;
const chatFetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
  chatPayload = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
  return new Response(JSON.stringify({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }] }), { status: 200 });
}) as typeof fetch;
const chatModel = new OpenAICompatibleModel({ baseUrl: "https://example.test", apiKey: "test", modelId: "gpt-test", fetch: chatFetch });
await chatModel.complete(chatRequest);
assert.equal(((chatPayload!.messages as Array<Record<string, unknown>>).at(-1)!.content as Array<Record<string, unknown>>)[1]!.type, "image_url");
await assert.rejects(chatModel.complete(request), /PDF input requires/);

const account = await runProvider(
  (fetchImpl) => new AccountRunnerModel({ baseUrl: "http://127.0.0.1", runnerPath: "chatgpt", runnerToken: "test", modelId: "gpt-test",
    inputCapabilities: { image: true, document: true, audio: false, video: false }, fetch: fetchImpl }),
  { content: "ok" },
);
assert.deepEqual((account.attachments as Array<Record<string, unknown>>).map((x) => x.category), ["image", "document"]);
console.log("PASS native model provider wire payloads for images and PDF: Anthropic, Gemini, OpenAI Chat/Responses, account runner");
