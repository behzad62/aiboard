import assert from "node:assert/strict";
import {
  anthropicToolConfigForPlan,
  streamAnthropicWithClient,
} from "../lib/providers/anthropic";
import type { ChatParams } from "../lib/providers/base";
import { resolveProviderCallPlan } from "../lib/providers/call-planner";
import {
  ProviderCallPlanError,
  type ProviderCallPlan,
  type ResolvedTool,
  type ToolCapabilityId,
  type ToolExecutionLocation,
} from "../lib/providers/tool-capabilities";

function resolved(
  id: ToolCapabilityId,
  execution: ToolExecutionLocation,
  parameters?: Record<string, unknown>,
): ResolvedTool {
  return {
    intent: {
      id,
      requirement: "optional",
      ...(parameters ? { parameters } : {}),
    },
    descriptor: {
      id,
      support: "supported",
      execution,
      transports: ["messages"],
      supportSource: "provider-docs",
    },
    transport: "messages",
    readiness: "available",
  };
}

function messagesPlan(
  tools: ResolvedTool[],
  toolChoice: ProviderCallPlan["toolChoice"] = "required",
  parallelToolCalls = false,
): ProviderCallPlan {
  return {
    transport: "messages",
    enabledTools: tools,
    omittedOptionalTools: [],
    toolPolicyTrace: {
      requestedTools: tools.map((tool) => tool.intent),
      enabledTools: tools.map((tool) => tool.intent.id),
      omittedTools: [],
      transport: "messages",
      decisions: [],
    },
    toolChoice,
    parallelToolCalls,
  };
}

const allTools = [
  resolved("function_calling", "client"),
  resolved("web_search", "provider", { maxUses: 4 }),
  resolved("web_fetch", "provider", { maxUses: 3 }),
  resolved("code_execution", "provider"),
  resolved("advisor", "provider", { model: "claude-opus-5" }),
  resolved("tool_search", "provider", { variant: "regex" }),
  resolved("remote_mcp", "provider", {
    serverName: "docs",
    serverUrl: "https://mcp.example.com",
    authorizationToken: "test-token",
  }),
  resolved("shell", "client"),
  resolved("apply_patch", "client", { maxCharacters: 12000 }),
  resolved("computer_use", "client"),
  resolved("browser_use", "client"),
];

const params: ChatParams = {
  apiKey: "test",
  model: "claude-opus-5",
  messages: [{ role: "user", content: "Use the available tools." }],
  nativeTools: [
    {
      name: "lookup",
      description: "Look up app data",
      parameters: { type: "object", properties: {} },
    },
  ],
  callPlan: messagesPlan(allTools),
};

assert.deepEqual(anthropicToolConfigForPlan(params, "anthropic"), {
  tools: [
    {
      name: "lookup",
      description: "Look up app data",
      input_schema: { type: "object", properties: {} },
    },
    { type: "web_search_20250305", name: "web_search", max_uses: 4 },
    { type: "web_fetch_20250910", name: "web_fetch", max_uses: 3 },
    { type: "code_execution_20260521", name: "code_execution" },
    { type: "advisor_20260301", name: "advisor", model: "claude-opus-5" },
    { type: "tool_search_tool_regex_20251119", name: "tool_search" },
    { type: "mcp_toolset", mcp_server_name: "docs" },
    { type: "bash_20250124", name: "bash" },
    {
      type: "text_editor_20250728",
      name: "str_replace_based_edit_tool",
      max_characters: 12000,
    },
    { type: "computer_toolset_20260801" },
    { type: "browser_toolset_20260801" },
  ],
  tool_choice: { type: "any", disable_parallel_tool_use: true },
  mcp_servers: [
    {
      type: "url",
      url: "https://mcp.example.com",
      name: "docs",
      authorization_token: "test-token",
    },
  ],
  betas: ["advisor-tool-2026-03-01", "mcp-client-2025-11-20"],
});
console.log("PASS Anthropic Messages serializes every represented tool family from the resolved plan");

assert.deepEqual(
  anthropicToolConfigForPlan(
    { ...params, callPlan: messagesPlan([resolved("function_calling", "client")], { name: "lookup" }, true) },
    "anthropic",
  ).tool_choice,
  { type: "tool", name: "lookup" },
);
assert.deepEqual(
  anthropicToolConfigForPlan(
    { ...params, callPlan: messagesPlan([resolved("function_calling", "client")], "auto", false) },
    "anthropic",
  ).tool_choice,
  { type: "auto", disable_parallel_tool_use: true },
);
console.log("PASS Anthropic tool choice and parallel policy translate from the normalized plan");

const structuredParams: ChatParams = {
  ...params,
  structuredOutput: {
    name: "answer",
    schema: { type: "object", properties: { ok: { type: "boolean" } } },
  },
  callPlan: messagesPlan([
    resolved("function_calling", "client"),
    resolved("web_search", "provider"),
  ], "auto"),
};
assert.equal(anthropicToolConfigForPlan(structuredParams, "anthropic").tools.length >= 3, true);
console.log("PASS structured output does not blanket-remove planner-approved Anthropic tools");

function asyncEvents(events: unknown[]) {
  return (async function* () {
    for (const event of events) yield event;
  })();
}

const pauseRequests: Array<Record<string, unknown>> = [];
let pauseCall = 0;
const pauseClient = {
  messages: {
    stream: async (request: Record<string, unknown>) => {
      pauseRequests.push(request);
      pauseCall++;
      return pauseCall === 1
        ? asyncEvents([
            {
              type: "content_block_start",
              index: 0,
              content_block: {
                type: "server_tool_use",
                id: "srv-1",
                name: "web_search",
                input: {},
              },
            },
            {
              type: "content_block_delta",
              index: 0,
              delta: { type: "input_json_delta", partial_json: '{"query":"Dubai weather"}' },
            },
            {
              type: "content_block_start",
              index: 1,
              content_block: {
                type: "web_search_tool_result",
                tool_use_id: "srv-1",
                content: [{ type: "web_search_result", url: "https://example.com", title: "Weather" }],
              },
            },
            { type: "message_delta", delta: { stop_reason: "pause_turn" }, usage: { output_tokens: 3 } },
          ])
        : asyncEvents([
            { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Finished." } },
            { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 5 } },
          ]);
    },
  },
};

const pauseChunks = [];
for await (const chunk of streamAnthropicWithClient(
  pauseClient as never,
  {
    apiKey: "test",
    model: "claude-opus-5",
    messages: [{ role: "user", content: "Search." }],
    callPlan: messagesPlan([resolved("web_search", "provider")], "auto"),
  },
  "anthropic",
  "Anthropic",
)) {
  pauseChunks.push(chunk);
}
assert.equal(pauseRequests.length, 2, "pause_turn must continue with another Messages request");
assert.deepEqual(
  (pauseRequests[1].messages as Array<Record<string, unknown>>).at(-1),
  {
    role: "assistant",
    content: [
      {
        type: "server_tool_use",
        id: "srv-1",
        name: "web_search",
        input: { query: "Dubai weather" },
      },
      {
        type: "web_search_tool_result",
        tool_use_id: "srv-1",
        content: [{ type: "web_search_result", url: "https://example.com", title: "Weather" }],
      },
    ],
  },
);
assert.deepEqual(pauseRequests[1].tools, pauseRequests[0].tools, "pause continuation must preserve the same tools");
assert.ok(pauseChunks.some((chunk) => chunk.type === "provider_tool_event" && chunk.providerToolEvent?.tool === "web_search" && chunk.providerToolEvent.phase === "started"));
assert.ok(pauseChunks.some((chunk) => chunk.type === "provider_tool_event" && chunk.providerToolEvent?.tool === "web_search" && chunk.providerToolEvent.phase === "completed"));
assert.ok(pauseChunks.some((chunk) => chunk.type === "token" && chunk.content === "Finished."));
assert.equal(pauseChunks.some((chunk) => chunk.type === "tool_call"), false, "provider server tools must never reach the local broker");
console.log("PASS pause_turn continues server execution with the same tools and provider-managed events");

const mixedClient = {
  messages: {
    stream: async () =>
      asyncEvents([
        {
          type: "content_block_start",
          index: 0,
          content_block: { type: "server_tool_use", id: "srv-2", name: "web_fetch", input: { url: "https://example.com" } },
        },
        {
          type: "content_block_start",
          index: 1,
          content_block: { type: "tool_use", id: "client-1", name: "lookup", input: { id: 7 } },
        },
        { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 2 } },
      ]),
  },
};
const mixedChunks = [];
for await (const chunk of streamAnthropicWithClient(
  mixedClient as never,
  params,
  "anthropic",
  "Anthropic",
)) {
  mixedChunks.push(chunk);
}
assert.ok(mixedChunks.some((chunk) => chunk.type === "provider_tool_event" && chunk.providerToolEvent?.tool === "web_fetch"));
assert.ok(mixedChunks.some((chunk) => chunk.type === "tool_call" && chunk.toolCall?.name === "lookup"));
console.log("PASS mixed server/client events preserve provider execution while client functions reach the broker");

assert.throws(
  () =>
    resolveProviderCallPlan({
      context: {
        providerId: "foundry",
        modelId: "claude-deployment",
        features: {},
      },
      requestedTools: [{ id: "web_search", requirement: "required" }],
    }),
  ProviderCallPlanError,
);
const foundryResolved = resolveProviderCallPlan({
  context: {
    providerId: "foundry",
    modelId: "claude-deployment",
    evidence: [
      {
        providerId: "foundry",
        modelId: "claude-deployment",
        capabilityId: "web_search",
        transport: "messages",
        support: "supported",
        execution: "provider",
        source: "provider-catalog",
        verifiedAt: "2026-09-29T12:00:00.000Z",
      },
    ],
    features: {},
  },
  requestedTools: [{ id: "web_search", requirement: "required" }],
});
assert.equal(foundryResolved.enabledTools[0]?.intent.id, "web_search");
console.log("PASS Foundry hosted tools fail closed until deployment-specific evidence resolves them");

console.log("PASS");
