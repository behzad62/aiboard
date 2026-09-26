import assert from "node:assert/strict";

import type { NativeToolDefinition, StreamChunk } from "../lib/providers/base";
import { openrouterProvider } from "../lib/providers/openrouter";

function sseResponse(events: unknown[]): Response {
  const body = events
    .map((event) => `data: ${typeof event === "string" ? event : JSON.stringify(event)}\n\n`)
    .join("");
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

async function collect(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return chunks;
}

const readTool: NativeToolDefinition = {
  name: "read",
  description: "Read a file",
  parameters: {
    type: "object",
    properties: { paths: { type: "array", items: { type: "string" } } },
    required: ["paths"],
    additionalProperties: false,
  },
  strict: true,
};

const originalFetch = globalThis.fetch;
try {
  {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = async (input, init) => {
      const url = String(input);
      requests.push({ url, init });
      if (!url.endsWith("/responses")) {
        return sseResponse([
          { choices: [{ delta: { content: "wrong transport" } }] },
          "[DONE]",
        ]);
      }
      return sseResponse([
        {
          type: "response.output_text.delta",
          delta: "Responses worked.",
          output_index: 0,
          content_index: 0,
          item_id: "msg_1",
          sequence_number: 1,
          logprobs: [],
        },
        {
          type: "response.output_item.done",
          output_index: 1,
          sequence_number: 2,
          item: {
            type: "function_call",
            id: "fc_1",
            call_id: "call_1",
            name: "read",
            arguments: '{"paths":["README.md"]}',
            status: "completed",
          },
        },
        {
          type: "response.completed",
          sequence_number: 3,
          response: {
            id: "resp_openrouter",
            object: "response",
            status: "completed",
            output: [],
            usage: {
              input_tokens: 21,
              input_tokens_details: { cached_tokens: 8, cache_write_tokens: 4 },
              output_tokens: 7,
              output_tokens_details: { reasoning_tokens: 3 },
              total_tokens: 28,
              cost: 0.00125,
            },
          },
        },
        "[DONE]",
      ]);
    };

    const chunks = await collect(openrouterProvider.streamChat({
      apiKey: "test-key",
      model: "openai/gpt-5.6",
      messages: [
        { role: "system", content: "Use tools when useful." },
        { role: "user", content: "Inspect the README." },
      ],
      nativeTools: [readTool],
      webSearch: true,
      hostedBuildTools: true,
      maxTokens: 512,
      temperature: 0.2,
      reasoningEffort: "high",
      capabilities: { image: false, document: false, audio: false, video: false },
      disableAutomaticRetries: true,
    }));

    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, "https://openrouter.ai/api/v1/responses");
    const body = JSON.parse(String(requests[0].init?.body)) as {
      instructions?: string;
      input?: unknown[];
      tools?: Array<{ type?: string; name?: string; function?: unknown }>;
      max_output_tokens?: number;
      temperature?: number;
      reasoning?: { effort?: string };
      cache_control?: { type?: string };
    };
    assert.equal(body.instructions, "Use tools when useful.");
    assert.ok(Array.isArray(body.input));
    const readFunction = body.tools?.find((tool) => tool.type === "function" && tool.name === "read");
    assert.equal(readFunction?.type, "function");
    assert.equal(readFunction?.name, "read");
    assert.equal(readFunction?.function, undefined, "Responses tools use the flat function shape");
    assert.equal(
      body.tools?.filter((tool) => tool.type === "openrouter:web_search").length,
      1,
      "OpenRouter server tools are deduplicated across web-search and hosted-build sources"
    );
    assert.equal(body.max_output_tokens, 512);
    assert.equal(body.temperature, 0.2);
    assert.equal(body.reasoning?.effort, "high");
    assert.deepEqual(body.cache_control, { type: "ephemeral" });
    assert.equal(chunks.some((chunk) => chunk.type === "token" && chunk.content === "Responses worked."), true);
    assert.deepEqual(
      chunks.find((chunk) => chunk.type === "tool_call")?.toolCall,
      { id: "call_1", name: "read", argumentsJson: '{"paths":["README.md"]}' }
    );
    assert.deepEqual(chunks.find((chunk) => chunk.type === "usage")?.usage, {
      inputTokens: 21,
      outputTokens: 7,
      totalTokens: 28,
      reasoningTokens: 3,
      cachedInputTokens: 8,
      cacheWriteInputTokens: 4,
      providerCost: 0.00125,
      providerCostUnit: "credits",
    });
    assert.equal(chunks.at(-1)?.type, "done");
  }

  {
    const requests: string[] = [];
    globalThis.fetch = async (input) => {
      const url = String(input);
      requests.push(url);
      if (url.endsWith("/responses")) {
        return Response.json(
          { error: { message: "Responses route unavailable" } },
          { status: 404 }
        );
      }
      return sseResponse([
        { choices: [{ delta: { content: "Chat fallback worked." } }] },
        { choices: [{ delta: {}, finish_reason: "stop" }] },
        "[DONE]",
      ]);
    };

    const chunks = await collect(openrouterProvider.streamChat({
      apiKey: "test-key",
      model: "vendor/legacy-model",
      messages: [{ role: "user", content: "Hello" }],
      capabilities: { image: false, document: false, audio: false, video: false },
      disableAutomaticRetries: true,
    }));

    assert.deepEqual(requests, [
      "https://openrouter.ai/api/v1/responses",
      "https://openrouter.ai/api/v1/chat/completions",
    ]);
    assert.equal(
      chunks.some((chunk) => chunk.type === "token" && chunk.content === "Chat fallback worked."),
      true
    );
    assert.equal(chunks.some((chunk) => chunk.type === "error"), false);
    assert.equal(chunks.at(-1)?.type, "done");
  }

  console.log("PASS OpenRouter Responses-first transport and compatibility fallback");
} finally {
  globalThis.fetch = originalFetch;
}
