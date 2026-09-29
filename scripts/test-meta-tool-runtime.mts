import assert from "node:assert/strict";
import { resolveProviderCallPlan } from "../lib/providers/call-planner";
import {
  metaResponsesToolField,
  streamMetaByPlan,
  streamMetaResponses,
} from "../lib/providers/meta";
import type { ChatParams } from "../lib/providers/base";
import { ProviderCallPlanError, type ProviderCallPlan } from "../lib/providers/tool-capabilities";

function plan(tools: ProviderCallPlan["enabledTools"]): ProviderCallPlan {
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
    toolChoice: "auto",
    parallelToolCalls: false,
  };
}

const enabledTools: ProviderCallPlan["enabledTools"] = [
  {
    intent: { id: "function_calling", requirement: "optional" },
    descriptor: {
      id: "function_calling",
      support: "supported",
      execution: "client",
      transports: ["responses"],
      supportSource: "provider-docs",
    },
    transport: "responses",
    readiness: "available",
  },
  {
    intent: { id: "web_search", requirement: "optional", parameters: { searchContextSize: "high" } },
    descriptor: {
      id: "web_search",
      support: "supported",
      execution: "provider",
      transports: ["responses"],
      supportSource: "provider-docs",
    },
    transport: "responses",
    readiness: "available",
  },
  {
    intent: { id: "tool_search", requirement: "optional" },
    descriptor: {
      id: "tool_search",
      support: "supported",
      execution: "provider",
      transports: ["responses"],
      supportSource: "provider-docs",
    },
    transport: "responses",
    readiness: "available",
  },
];

const params: ChatParams = {
  apiKey: "test",
  model: "muse-spark-1.3",
  messages: [{ role: "user", content: "Find current weather" }],
  reasoningEffort: "high",
  nativeTools: [
    {
      name: "weather.lookup",
      description: "Look up weather",
      parameters: {
        type: "object",
        properties: { city: { type: "string" } },
        required: ["city"],
      },
      strict: true,
      deferLoading: true,
    },
  ],
  callPlan: plan(enabledTools),
};

assert.deepEqual(metaResponsesToolField(params), {
  tools: [
    {
      type: "function",
      name: "weather.lookup",
      description: "Look up weather",
      parameters: {
        type: "object",
        properties: { city: { type: "string" } },
        required: ["city"],
      },
      strict: true,
      defer_loading: true,
    },
    { type: "web_search", search_context_size: "high" },
    { type: "tool_search" },
  ],
  tool_choice: "auto",
  parallel_tool_calls: false,
});
console.log("PASS Meta Responses serializes functions, web search, and hosted tool search");

assert.throws(
  () =>
    resolveProviderCallPlan({
      context: {
        providerId: "meta",
        modelId: "muse-spark-1.3",
        features: { toolChoice: "required" },
      },
      requestedTools: [{ id: "function_calling", requirement: "required" }],
    }),
  (error: unknown) =>
    error instanceof ProviderCallPlanError &&
    error.decisions.some((decision) => decision.code === "combination_forbidden"),
);
console.log("PASS Meta auto-only tool choice is enforced by manifest/planner constraints");

assert.throws(
  () =>
    resolveProviderCallPlan({
      context: {
        providerId: "meta",
        modelId: "muse-spark-1.3",
        features: { structuredOutput: true },
      },
      requestedTools: [{ id: "tool_search", requirement: "required" }],
    }),
  (error: unknown) =>
    error instanceof ProviderCallPlanError &&
    error.decisions.some((decision) => decision.code === "combination_forbidden"),
);
const structuredFunctionPlan = resolveProviderCallPlan({
  context: {
    providerId: "meta",
    modelId: "muse-spark-1.3",
    features: { structuredOutput: true, toolChoice: "auto" },
  },
  requestedTools: [{ id: "function_calling", requirement: "optional" }],
});
assert.equal(structuredFunctionPlan.enabledTools[0]?.intent.id, "function_calling");
console.log("PASS Meta forbids only tool-search plus JSON schema, not ordinary functions");

let capturedRequest: Record<string, unknown> | undefined;
const fakeClient = {
  responses: {
    create: async (request: Record<string, unknown>) => {
      capturedRequest = request;
      return (async function* () {
        yield {
          type: "response.output_item.added",
          item: { id: "search-1", type: "web_search_call" },
        };
        yield {
          type: "response.output_item.added",
          item: { id: "tool-search-1", type: "tool_search_call" },
        };
        yield {
          type: "response.output_text.done",
          text: "sunny",
          annotations: [
            {
              type: "url_citation",
              url: "https://example.com/weather",
              title: "Weather source",
              start_index: 0,
              end_index: 5,
            },
          ],
        };
        yield {
          type: "response.output_item.done",
          item: {
            id: "fn-1",
            call_id: "call-1",
            type: "function_call",
            name: "weather.lookup",
            arguments: '{"city":"Dubai"}',
          },
        };
        yield {
          type: "response.completed",
          response: { usage: { input_tokens: 4, output_tokens: 6, total_tokens: 10 } },
        };
      })();
    },
  },
};
const multimodalParams: ChatParams = {
  ...params,
  attachments: [
    {
      id: "image-1",
      filename: "sky.png",
      mimeType: "image/png",
      category: "image",
      base64Data: "AQID",
    },
  ],
};
const chunks = [];
for await (const chunk of streamMetaResponses(fakeClient as never, multimodalParams)) {
  chunks.push(chunk);
}
assert.equal(capturedRequest?.model, "muse-spark-1.3");
assert.equal(capturedRequest?.tool_choice, "auto");
assert.equal((capturedRequest?.reasoning as { effort?: string })?.effort, "high");
assert.ok(
  JSON.stringify(capturedRequest?.input).includes("data:image/png;base64,AQID"),
  "Meta Responses must preserve supported multimodal image input",
);
assert.ok(chunks.some((chunk) => chunk.type === "provider_tool_event" && chunk.providerToolEvent?.tool === "web_search"));
assert.ok(chunks.some((chunk) => chunk.type === "provider_tool_event" && chunk.providerToolEvent?.tool === "tool_search"));
assert.deepEqual(
  chunks.find((chunk) => chunk.type === "provider_tool_event" && chunk.providerToolEvent?.citations?.length)
    ?.providerToolEvent?.citations?.[0],
  {
    url: "https://example.com/weather",
    title: "Weather source",
    sourceSpan: { start: 0, end: 5 },
    providerData: { type: "url_citation" },
  },
);
assert.ok(chunks.some((chunk) => chunk.type === "tool_call" && chunk.toolCall?.name === "weather.lookup"));
console.log("PASS Meta Responses normalizes hosted events/citations while functions remain client tool calls");

let responsesCalls = 0;
let chatCalls = 0;
const dualClient = {
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
          yield { choices: [{ delta: { content: "fallback" } }] };
        })();
      },
    },
  },
};
const fallbackPlan: ProviderCallPlan = {
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
for await (const chunk of streamMetaByPlan(dualClient as never, {
  apiKey: "test",
  model: "muse-spark-1.3",
  messages: [{ role: "user", content: "hello" }],
  callPlan: fallbackPlan,
})) {
  fallbackChunks.push(chunk);
}
assert.equal(responsesCalls, 0);
assert.equal(chatCalls, 1);
assert.ok(fallbackChunks.some((chunk) => chunk.type === "token" && chunk.content === "fallback"));
console.log("PASS Meta Chat Completions exists only as planner-selected compatibility fallback");

console.log("PASS");