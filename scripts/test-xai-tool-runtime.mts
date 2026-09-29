import assert from "node:assert/strict";
import type { ChatParams } from "../lib/providers/base";
import { resolveProviderCallPlan } from "../lib/providers/call-planner";
import { resolveProviderCapabilityProfile } from "../lib/providers/capability-resolution";
import type {
  GeneratedArtifactRef,
  ProviderArtifactPayload,
  ProviderArtifactSink,
} from "../lib/providers/provider-events";
import {
  ProviderCallPlanError,
  type ProviderCallPlan,
  type ResolvedTool,
  type ToolCapabilityId,
  type ToolExecutionLocation,
} from "../lib/providers/tool-capabilities";
import {
  streamXAIResponses,
  xAIResponsesToolField,
} from "../lib/providers/xai";

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
    toolChoice: "auto",
    parallelToolCalls: true,
  };
}

const tools = [
  resolved("function_calling", "client"),
  resolved("web_search", "provider", {
    allowedDomains: ["example.com"],
    enableImageUnderstanding: true,
  }),
  resolved("x_search", "provider", {
    fromDate: "2026-09-01",
    toDate: "2026-09-30",
    xHandles: ["openai"],
  }),
  resolved("code_execution", "provider"),
  resolved("file_search", "provider", {
    vectorStoreIds: ["collection-1"],
    maxNumResults: 5,
  }),
  resolved("remote_mcp", "provider", {
    serverUrl: "https://mcp.example.com/mcp",
    serverLabel: "docs",
    authorization: "Bearer test",
    allowedTools: ["search"],
    headers: { "x-tenant": "test" },
  }),
  resolved("image_generation", "provider", { aspect_ratio: "16:9" }),
];

const params: ChatParams = {
  apiKey: "test",
  model: "grok-4.7",
  messages: [{ role: "user", content: "Use all tools." }],
  nativeTools: [
    {
      name: "lookup",
      description: "Look up data",
      parameters: { type: "object", properties: { id: { type: "number" } } },
      strict: true,
    },
  ],
  callPlan: responsesPlan(tools),
};

assert.deepEqual(xAIResponsesToolField(params), {
  tools: [
    {
      type: "function",
      name: "lookup",
      description: "Look up data",
      parameters: { type: "object", properties: { id: { type: "number" } } },
      strict: true,
    },
    {
      type: "web_search",
      allowed_domains: ["example.com"],
      enable_image_understanding: true,
    },
    {
      type: "x_search",
      from_date: "2026-09-01",
      to_date: "2026-09-30",
      x_handles: ["openai"],
    },
    { type: "code_interpreter" },
    {
      type: "file_search",
      vector_store_ids: ["collection-1"],
      max_num_results: 5,
    },
    {
      type: "mcp",
      server_url: "https://mcp.example.com/mcp",
      server_label: "docs",
      authorization: "Bearer test",
      allowed_tools: ["search"],
      headers: { "x-tenant": "test" },
    },
    { type: "image_generation", aspect_ratio: "16:9" },
  ],
  tool_choice: "auto",
  parallel_tool_calls: true,
  include: [
    "web_search_call.action.sources",
    "code_interpreter_call.outputs",
    "file_search_call.results",
  ],
});
console.log("PASS xAI Responses serializes every planned native tool family");

const unresolved = resolveProviderCapabilityProfile({
  providerId: "xai",
  modelId: "grok-4.7",
});
assert.equal(unresolved.capabilities.file_search.descriptor.support, "supported");
assert.equal(unresolved.capabilities.file_search.readiness.status, "setup_required");
assert.equal(unresolved.capabilities.remote_mcp.descriptor.support, "supported");
assert.equal(unresolved.capabilities.remote_mcp.readiness.status, "setup_required");
assert.throws(
  () =>
    resolveProviderCallPlan({
      context: { providerId: "xai", modelId: "grok-4.7", features: {} },
      requestedTools: [{ id: "file_search", requirement: "required" }],
    }),
  ProviderCallPlanError,
);
const readyPlan = resolveProviderCallPlan({
  context: {
    providerId: "xai",
    modelId: "grok-4.7",
    resourceState: {
      prerequisites: {
        xai_collection: { ready: true },
        remote_mcp_server: { ready: true },
      },
    },
    features: {},
  },
  requestedTools: [
    { id: "file_search", requirement: "required", parameters: { vectorStoreIds: ["collection-1"] } },
    { id: "remote_mcp", requirement: "required", parameters: { serverUrl: "https://mcp.example.com/mcp", serverLabel: "docs" } },
  ],
});
assert.deepEqual(
  readyPlan.enabledTools.map((tool) => tool.intent.id),
  ["file_search", "remote_mcp"],
);
console.log("PASS xAI collection search and MCP readiness stay separate from model discovery");

class ArtifactSink implements ProviderArtifactSink {
  payloads: ProviderArtifactPayload[] = [];
  async persist(payload: ProviderArtifactPayload): Promise<GeneratedArtifactRef> {
    this.payloads.push(payload);
    const bytes = payload.bytes instanceof Uint8Array ? payload.bytes : new Uint8Array(payload.bytes);
    return {
      id: payload.id ?? "image-1",
      mimeType: payload.mimeType,
      filename: payload.filename,
      size: bytes.byteLength,
      storageRef: `provider-artifact:${payload.id ?? "image-1"}`,
    };
  }
}

const artifactSink = new ArtifactSink();
let requestBody: Record<string, unknown> | undefined;
const fakeClient = {
  responses: {
    create: async (request: Record<string, unknown>) => {
      requestBody = request;
      return (async function* () {
        for (const [id, type] of [
          ["web-1", "web_search_call"],
          ["x-1", "x_search_call"],
          ["code-1", "code_interpreter_call"],
          ["file-1", "file_search_call"],
          ["mcp-1", "mcp_call"],
        ] as const) {
          yield { type: "response.output_item.added", item: { id, type } };
          yield { type: "response.output_item.done", item: { id, type, status: "completed" } };
        }
        yield {
          type: "response.output_item.done",
          item: {
            id: "image-1",
            type: "image_generation_call",
            status: "completed",
            result: Buffer.from([1, 2, 3, 4]).toString("base64"),
          },
        };
        yield {
          type: "response.output_text.done",
          text: "grounded",
          annotations: [
            {
              type: "url_citation",
              url: "https://example.com/source",
              title: "Example source",
              start_index: 0,
              end_index: 8,
            },
          ],
        };
        yield {
          type: "response.output_item.done",
          item: {
            id: "fn-1",
            call_id: "call-1",
            type: "function_call",
            name: "lookup",
            arguments: '{"id":7}',
          },
        };
        yield { type: "response.output_text.delta", delta: "Done." };
        yield {
          type: "response.completed",
          response: {
            usage: {
              input_tokens: 5,
              output_tokens: 3,
              total_tokens: 8,
              output_tokens_details: { reasoning_tokens: 1 },
              input_tokens_details: { cached_tokens: 2 },
            },
          },
        };
      })();
    },
  },
};

const chunks = [];
for await (const chunk of streamXAIResponses(fakeClient as never, { ...params, artifactSink })) {
  chunks.push(chunk);
}
assert.equal((requestBody?.tools as unknown[])?.length, 7);
assert.deepEqual(requestBody?.include, [
  "web_search_call.action.sources",
  "code_interpreter_call.outputs",
  "file_search_call.results",
]);
for (const capability of ["web_search", "x_search", "code_execution", "file_search", "remote_mcp"] as const) {
  assert.ok(chunks.some((chunk) => chunk.type === "provider_tool_event" && chunk.providerToolEvent?.tool === capability && chunk.providerToolEvent.phase === "started"));
  assert.ok(chunks.some((chunk) => chunk.type === "provider_tool_event" && chunk.providerToolEvent?.tool === capability && chunk.providerToolEvent.phase === "completed"));
}
const citationEvent = chunks.find((chunk) => chunk.type === "provider_tool_event" && chunk.providerToolEvent?.citations?.length);
assert.deepEqual(citationEvent?.providerToolEvent?.citations?.[0], {
  url: "https://example.com/source",
  title: "Example source",
  sourceSpan: { start: 0, end: 8 },
  providerData: { type: "url_citation" },
});
const imageEvent = chunks.find((chunk) => chunk.type === "provider_tool_event" && chunk.providerToolEvent?.tool === "image_generation");
assert.equal(imageEvent?.providerToolEvent?.artifacts?.[0]?.storageRef, "provider-artifact:image-1");
assert.deepEqual(Array.from(artifactSink.payloads[0]?.bytes as Uint8Array), [1, 2, 3, 4]);
assert.equal(JSON.stringify(imageEvent).includes(Buffer.from([1, 2, 3, 4]).toString("base64")), false, "base64 image bytes must not leak into streamed UI state");
assert.ok(chunks.some((chunk) => chunk.type === "tool_call" && chunk.toolCall?.name === "lookup"));
assert.ok(chunks.some((chunk) => chunk.type === "token" && chunk.content === "Done."));
assert.ok(chunks.some((chunk) => chunk.type === "usage" && chunk.usage?.inputTokens === 5 && chunk.usage?.reasoningTokens === 1));
console.log("PASS xAI hosted calls emit provider events, preserve citations/artifacts, and keep functions client-executed");

console.log("PASS");
