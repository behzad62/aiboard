import assert from "node:assert/strict";
import {
  googleInteractionsToolField,
  streamGoogleInteractions,
} from "../lib/providers/google-interactions";
import { streamGoogleByPlan } from "../lib/providers/google";
import type { ChatParams } from "../lib/providers/base";
import { resolveProviderCallPlan } from "../lib/providers/call-planner";
import { resolveProviderCapabilityProfile } from "../lib/providers/capability-resolution";
import type {
  ProviderCallPlan,
  ResolvedTool,
  ToolCapabilityId,
  ToolExecutionLocation,
} from "../lib/providers/tool-capabilities";
import type { ClientExecutionToolCall } from "../lib/providers/client-execution";

function resolved(
  id: ToolCapabilityId,
  execution: ToolExecutionLocation,
  parameters?: Record<string, unknown>,
): ResolvedTool {
  return {
    intent: { id, requirement: "optional", ...(parameters ? { parameters } : {}) },
    descriptor: {
      id,
      support: "supported",
      execution,
      transports: ["gemini_interactions"],
      supportSource: "provider-docs",
    },
    transport: "gemini_interactions",
    readiness: "available",
  };
}

function plan(
  transport: ProviderCallPlan["transport"],
  tools: ResolvedTool[],
  toolChoice: ProviderCallPlan["toolChoice"] = "auto",
): ProviderCallPlan {
  return {
    transport,
    enabledTools: tools,
    omittedOptionalTools: [],
    toolPolicyTrace: {
      requestedTools: tools.map((tool) => tool.intent),
      enabledTools: tools.map((tool) => tool.intent.id),
      omittedTools: [],
      transport,
      decisions: [],
    },
    toolChoice,
    parallelToolCalls: true,
  };
}

const tools = [
  resolved("function_calling", "client"),
  resolved("web_search", "provider", { searchTypes: ["web_search"] }),
  resolved("url_context", "provider"),
  resolved("file_search", "provider", {
    fileSearchStoreNames: ["fileSearchStores/docs"],
    topK: 5,
    metadataFilter: "category=guide",
  }),
  resolved("maps", "provider", { latitude: 25.2048, longitude: 55.2708, enableWidget: true }),
  resolved("code_execution", "provider"),
  resolved("remote_mcp", "provider", {
    serverName: "docs_server",
    serverUrl: "https://mcp.example.com/mcp",
    headers: { Authorization: "Bearer test" },
  }),
  resolved("computer_use", "client", {
    environment: "desktop",
    enablePromptInjectionDetection: true,
  }),
];

const params: ChatParams = {
  apiKey: "test",
  model: "gemini-3.8-flash",
  messages: [{ role: "user", content: "Use the tools." }],
  nativeTools: [
    {
      name: "lookup",
      description: "Look up application data",
      parameters: { type: "object", properties: { id: { type: "number" } } },
    },
  ],
  callPlan: plan("gemini_interactions", tools),
};

assert.deepEqual(googleInteractionsToolField(params), {
  tools: [
    {
      type: "function",
      name: "lookup",
      description: "Look up application data",
      parameters: { type: "object", properties: { id: { type: "number" } } },
    },
    { type: "google_search", search_types: ["web_search"] },
    { type: "url_context" },
    {
      type: "file_search",
      file_search_store_names: ["fileSearchStores/docs"],
      top_k: 5,
      metadata_filter: "category=guide",
    },
    { type: "google_maps", latitude: 25.2048, longitude: 55.2708, enable_widget: true },
    { type: "code_execution" },
    {
      type: "mcp_server",
      name: "docs_server",
      url: "https://mcp.example.com/mcp",
      headers: { Authorization: "Bearer test" },
    },
    {
      type: "computer_use",
      environment: "desktop",
      enable_prompt_injection_detection: true,
    },
  ],
  toolChoice: "validated",
});
console.log("PASS Gemini Interactions serializes functions and all planned native tool families");

const selected = resolveProviderCallPlan({
  context: {
    providerId: "google",
    modelId: "gemini-3.8-flash",
    features: { toolChoice: "auto" },
  },
  requestedTools: [
    { id: "function_calling", requirement: "required" },
    { id: "web_search", requirement: "required" },
  ],
});
assert.equal(selected.transport, "gemini_interactions");
console.log("PASS Google planner prefers Interactions for modern multi-tool calls");

const currentComputer = resolveProviderCapabilityProfile({
  providerId: "google",
  modelId: "gemini-3.8-flash",
}).capabilities.computer_use;
assert.equal(currentComputer.descriptor.support, "supported");
assert.equal(currentComputer.readiness.status, "setup_required");
const oldComputer = resolveProviderCapabilityProfile({
  providerId: "google",
  modelId: "gemini-2.5-flash",
}).capabilities.computer_use;
assert.equal(oldComputer.descriptor.support, "unsupported");
console.log("PASS Computer Use is Gemini-3.x-only and reports setup-required without an executor");

function asyncEvents(events: unknown[]) {
  return (async function* () {
    for (const event of events) yield event;
  })();
}

let interactionsRequest: Record<string, unknown> | undefined;
const interactionClient = {
  interactions: {
    create: async (request: Record<string, unknown>) => {
      interactionsRequest = request;
      return asyncEvents([
        {
          event_type: "step.start",
          index: 0,
          step: { type: "google_search_call", id: "search-1", arguments: { queries: ["Gemini"] } },
        },
        {
          event_type: "step.start",
          index: 1,
          step: { type: "google_search_result", call_id: "search-1", result: [] },
        },
        {
          event_type: "step.start",
          index: 2,
          step: { type: "function_call", id: "computer-1", name: "click_at", arguments: { x: 10, y: 20, intent: "Open menu" } },
        },
        {
          event_type: "step.start",
          index: 3,
          step: { type: "function_call", id: "fn-1", name: "lookup", arguments: { id: 7 } },
        },
        { event_type: "step.delta", index: 4, delta: { type: "text", text: "Done." } },
        {
          event_type: "interaction.completed",
          interaction: {
            id: "interaction-1",
            status: "completed",
            usage: { total_input_tokens: 8, total_output_tokens: 4, total_thought_tokens: 1, total_cached_tokens: 2 },
          },
        },
      ]);
    },
  },
  models: { generateContentStream: async () => { throw new Error("Generate Content must not run"); } },
};
const chunks = [];
for await (const chunk of streamGoogleInteractions(interactionClient as never, params)) {
  chunks.push(chunk);
}
assert.equal(interactionsRequest?.model, "gemini-3.8-flash");
assert.equal((interactionsRequest?.tools as unknown[])?.length, 8);
assert.ok(chunks.some((chunk) => chunk.type === "provider_tool_event" && chunk.providerToolEvent?.tool === "web_search" && chunk.providerToolEvent.phase === "started"));
assert.ok(chunks.some((chunk) => chunk.type === "provider_tool_event" && chunk.providerToolEvent?.tool === "web_search" && chunk.providerToolEvent.phase === "completed"));
const computerCall = chunks.find((chunk) => chunk.type === "tool_call" && chunk.toolCall?.id === "computer-1")?.toolCall as ClientExecutionToolCall | undefined;
assert.equal(computerCall?.clientExecution.capabilityId, "computer_use");
assert.equal(computerCall?.clientExecution.environment, "desktop");
assert.equal(computerCall?.clientExecution.requiresNextScreenshot, true);
assert.equal(computerCall?.clientExecution.action.intent, "Open menu");
const normalCall = chunks.find((chunk) => chunk.type === "tool_call" && chunk.toolCall?.id === "fn-1")?.toolCall as ClientExecutionToolCall | undefined;
assert.equal(normalCall?.clientExecution, undefined);
assert.ok(chunks.some((chunk) => chunk.type === "token" && chunk.content === "Done."));
assert.ok(chunks.some((chunk) => chunk.type === "usage" && chunk.usage?.inputTokens === 8 && chunk.usage?.reasoningTokens === 1));
console.log("PASS Interactions hosted steps normalize as provider events while computer actions hand off to the client executor contract");

let fallbackGenerateCalls = 0;
const fallbackClient = {
  interactions: { create: async () => { throw new Error("Interactions must not run"); } },
  models: {
    generateContentStream: async () => {
      fallbackGenerateCalls++;
      return asyncEvents([{ text: "fallback", usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 } }]);
    },
  },
};
const fallbackChunks = [];
for await (const chunk of streamGoogleByPlan(
  fallbackClient as never,
  {
    ...params,
    callPlan: plan("gemini_generate_content", []),
    nativeTools: undefined,
  },
)) {
  fallbackChunks.push(chunk);
}
assert.equal(fallbackGenerateCalls, 1);
assert.ok(fallbackChunks.some((chunk) => chunk.type === "token" && chunk.content === "fallback"));
console.log("PASS planner-selected Generate Content compatibility fallback remains available");

console.log("PASS");
