import assert from "node:assert/strict";
import {
  openAIResponsesToolField,
  streamOpenAIByPlan,
  streamOpenAIResponses,
} from "../lib/providers/openai";
import type { ChatParams } from "../lib/providers/base";
import type {
  GeneratedArtifactRef,
  ProviderArtifactPayload,
  ProviderArtifactSink,
} from "../lib/providers/provider-events";
import type {
  ProviderCallPlan,
  ResolvedTool,
  ToolCapabilityId,
  ToolExecutionLocation,
  ToolIntent,
} from "../lib/providers/tool-capabilities";

function resolved(
  id: ToolCapabilityId,
  execution: ToolExecutionLocation,
  parameters?: Record<string, unknown>,
): ResolvedTool {
  const intent: ToolIntent = {
    id,
    requirement: "optional",
    ...(parameters ? { parameters } : {}),
  };
  return {
    intent,
    descriptor: {
      id,
      support: "supported",
      execution,
      transports: ["responses"],
      supportSource: "provider-docs",
    },
    transport: "responses",
    readiness: "available",
  };
}

function responsesPlan(tools: ResolvedTool[]): ProviderCallPlan {
  return {
    transport: "responses",
    enabledTools: tools,
    omittedOptionalTools: [],
    toolPolicyTrace: {
      requestedTools: tools.map((tool) => tool.intent),
      enabledTools: tools.map((tool) => tool.intent.id),
      omittedTools: [],
      transport: "responses",
      decisions: [],
    },
    toolChoice: "required",
    parallelToolCalls: true,
  };
}

const tools = [
  resolved("function_calling", "client"),
  resolved("web_search", "provider", { searchContextSize: "high" }),
  resolved("file_search", "provider", { vectorStoreIds: ["vs_1"] }),
  resolved("remote_mcp", "provider", {
    serverLabel: "docs",
    serverUrl: "https://mcp.example.com",
    authorization: "Bearer test",
    allowedTools: ["search"],
  }),
  resolved("tool_search", "provider"),
  resolved("shell", "provider", { environment: { type: "container_auto" } }),
  resolved("code_execution", "provider", { fileIds: ["file_1"], memoryLimit: "4g" }),
  resolved("computer_use", "client"),
  resolved("image_generation", "provider", { background: "opaque" }),
];

const params: ChatParams = {
  apiKey: "test",
  model: "gpt-5.6-sol",
  messages: [{ role: "user", content: "use tools" }],
  nativeTools: [
    {
      name: "lookup",
      description: "Lookup data",
      parameters: { type: "object", properties: {} },
      strict: true,
      deferLoading: true,
    },
  ],
  callPlan: responsesPlan(tools),
};

const field = openAIResponsesToolField(params);
assert.deepEqual(field, {
  tools: [
    {
      type: "function",
      name: "lookup",
      description: "Lookup data",
      parameters: { type: "object", properties: {} },
      strict: true,
      defer_loading: true,
    },
    { type: "web_search", search_context_size: "high" },
    { type: "file_search", vector_store_ids: ["vs_1"] },
    {
      type: "mcp",
      server_label: "docs",
      server_url: "https://mcp.example.com",
      authorization: "Bearer test",
      allowed_tools: ["search"],
    },
    { type: "tool_search", execution: "server" },
    { type: "shell", environment: { type: "container_auto" } },
    {
      type: "code_interpreter",
      container: { type: "auto", file_ids: ["file_1"], memory_limit: "4g" },
    },
    { type: "computer" },
    { type: "image_generation", background: "opaque" },
  ],
  tool_choice: "required",
  parallel_tool_calls: true,
});
console.log("PASS OpenAI Responses serializes every planner-enabled applicable tool family");

const structuredParams: ChatParams = {
  ...params,
  structuredOutput: { name: "answer", schema: { type: "object" } },
};
assert.equal(openAIResponsesToolField(structuredParams).tools?.length, 9);
console.log("PASS structured output does not blanket-disable planner-approved OpenAI tools");

class ArtifactSink implements ProviderArtifactSink {
  payloads: ProviderArtifactPayload[] = [];
  async persist(payload: ProviderArtifactPayload): Promise<GeneratedArtifactRef> {
    this.payloads.push(payload);
    return {
      id: payload.id ?? "image-1",
      mimeType: payload.mimeType,
      filename: payload.filename,
      size: payload.bytes instanceof Uint8Array ? payload.bytes.byteLength : payload.bytes.byteLength,
      storageRef: "provider-artifact:image-1",
    };
  }
}

const artifactSink = new ArtifactSink();
const fakeResponsesClient = {
  responses: {
    create: async () =>
      (async function* () {
        yield {
          type: "response.output_item.added",
          item: { id: "search-1", type: "web_search_call" },
        };
        yield {
          type: "response.output_text.done",
          text: "answer",
          annotations: [
            {
              type: "url_citation",
              url: "https://example.com/source",
              title: "Example",
              start_index: 0,
              end_index: 6,
            },
          ],
        };
        yield {
          type: "response.output_item.done",
          item: {
            id: "image-1",
            type: "image_generation_call",
            status: "completed",
            result: Buffer.from([1, 2, 3]).toString("base64"),
          },
        };
        yield {
          type: "response.output_item.done",
          item: {
            id: "fn-1",
            call_id: "call-1",
            type: "function_call",
            name: "lookup",
            arguments: '{"q":"x"}',
          },
        };
        yield {
          type: "response.completed",
          response: { usage: { input_tokens: 2, output_tokens: 3, total_tokens: 5 } },
        };
      })(),
  },
};
const streamed = [];
for await (const chunk of streamOpenAIResponses(
  fakeResponsesClient as never,
  { ...params, artifactSink },
  "openai",
)) {
  streamed.push(chunk);
}
assert.ok(
  streamed.some(
    (chunk) =>
      chunk.type === "provider_tool_event" &&
      chunk.providerToolEvent?.tool === "web_search" &&
      chunk.providerToolEvent.phase === "started",
  ),
);
const cited = streamed.find(
  (chunk) =>
    chunk.type === "provider_tool_event" &&
    chunk.providerToolEvent?.citations?.length,
);
assert.deepEqual(cited?.providerToolEvent?.citations?.[0], {
  url: "https://example.com/source",
  title: "Example",
  sourceSpan: { start: 0, end: 6 },
  providerData: { type: "url_citation" },
});
const imageEvent = streamed.find(
  (chunk) =>
    chunk.type === "provider_tool_event" &&
    chunk.providerToolEvent?.tool === "image_generation" &&
    chunk.providerToolEvent.artifacts?.length,
);
assert.equal(imageEvent?.providerToolEvent?.artifacts?.[0]?.storageRef, "provider-artifact:image-1");
assert.deepEqual(Array.from(artifactSink.payloads[0]?.bytes as Uint8Array), [1, 2, 3]);
assert.ok(streamed.some((chunk) => chunk.type === "tool_call" && chunk.toolCall?.name === "lookup"));
console.log("PASS OpenAI hosted events preserve citations/artifacts while functions remain client tool calls");

let responsesCalls = 0;
let chatCalls = 0;
const fakeDualClient = {
  responses: {
    create: async () => {
      responsesCalls++;
      return (async function* () {
        yield { type: "response.completed", response: {} };
      })();
    },
  },
  chat: {
    completions: {
      create: async () => {
        chatCalls++;
        return (async function* () {
          yield { choices: [{ delta: { content: "chat" } }] };
        })();
      },
    },
  },
};
const chatPlan: ProviderCallPlan = {
  transport: "chat_completions",
  enabledTools: [],
  omittedOptionalTools: [],
  toolPolicyTrace: {
    requestedTools: [],
    enabledTools: [],
    omittedTools: [],
    transport: "chat_completions",
    decisions: [],
  },
  toolChoice: "auto",
  parallelToolCalls: false,
};
const fallbackChunks = [];
for await (const chunk of streamOpenAIByPlan(fakeDualClient as never, {
  apiKey: "test",
  model: "legacy-chat-model",
  messages: [{ role: "user", content: "hello" }],
  callPlan: chatPlan,
})) {
  fallbackChunks.push(chunk);
}
assert.equal(responsesCalls, 0);
assert.equal(chatCalls, 1);
assert.ok(fallbackChunks.some((chunk) => chunk.type === "token" && chunk.content === "chat"));
console.log("PASS OpenAI dispatches Chat Completions only when the resolved plan selects fallback");

console.log("PASS");
