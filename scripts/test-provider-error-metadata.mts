import assert from "node:assert/strict";
import { streamOpenAICompatibleChat } from "../lib/providers/openai-compat";
import type { ChatParams, StreamChunk } from "../lib/providers/base";

const params: ChatParams = {
  apiKey: "fake-key",
  model: "test-model",
  messages: [{ role: "user", content: "hello" }],
  maxTokens: 32,
  disableAutomaticRetries: true,
};

async function terminalChunk(error: unknown): Promise<StreamChunk> {
  const client = {
    chat: {
      completions: {
        create: async () => {
          throw error;
        },
      },
    },
  };
  let last: StreamChunk | undefined;
  for await (const chunk of streamOpenAICompatibleChat(
    client as never,
    params,
    "openai",
    "OpenAI"
  )) {
    last = chunk;
  }
  assert.ok(last);
  return last;
}

const badRequest = await terminalChunk({
  status: 400,
  code: "invalid_request_error",
  message: "misleading timeout text",
});
assert.equal(badRequest.type, "error");
assert.deepEqual(badRequest.errorMetadata, {
  statusCode: 400,
  code: "invalid_request_error",
});

const unavailable = await terminalChunk({
  status: 503,
  code: "overloaded",
  message: "temporarily unavailable",
  headers: new Headers({ "retry-after": "12" }),
});
assert.equal(unavailable.type, "error");
assert.deepEqual(unavailable.errorMetadata, {
  statusCode: 503,
  code: "overloaded",
  retryAfterMs: 12_000,
});

console.log("PASS provider error metadata");
