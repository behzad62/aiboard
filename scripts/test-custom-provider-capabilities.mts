import assert from "node:assert/strict";
import { resolveProviderCallPlan } from "../lib/providers/call-planner";
import {
  buildCustomToolCapabilityOverrides,
  customCompatibleTransports,
} from "../lib/providers/custom-capabilities";
import { ProviderCallPlanError } from "../lib/providers/tool-capabilities";
import {
  addCustomModel,
  listCustomModels,
  testSavedCustomModel,
  updateCustomModelToolConfiguration,
} from "../lib/client/settings-api";
import {
  __clearClientStoreForTests,
  __resetClientStoreForTests,
} from "../lib/client/store";
import { streamCustomChat } from "../lib/providers/custom";
import type { CustomModel } from "../lib/db/schema";
import type { ChatParams, NativeToolDefinition, StreamChunk } from "../lib/providers/base";
import { customModelPlanningContext } from "../lib/client/providers";

const defaultPlan = resolveProviderCallPlan({
  context: {
    providerId: "custom",
    modelId: "local-model",
    allowedTransports: customCompatibleTransports(undefined),
    features: { mode: "discussion" },
  },
  requestedTools: [
    { id: "function_calling", requirement: "optional" },
    { id: "web_search", requirement: "optional" },
  ],
});
assert.deepEqual(defaultPlan.enabledTools, []);
assert.deepEqual(
  defaultPlan.omittedOptionalTools.map((item) => [item.capabilityId, item.code]),
  [["function_calling", "unknown"], ["web_search", "unsupported"]],
);
console.log("PASS custom endpoints default to conservative tool support");

const functionOverrides = buildCustomToolCapabilityOverrides(["function_calling"]);
const functionPlan = resolveProviderCallPlan({
  context: {
    providerId: "custom",
    modelId: "local-model",
    customOverrides: functionOverrides,
    allowedTransports: customCompatibleTransports(["chat_completions"]),
    features: { mode: "discussion" },
  },
  requestedTools: [
    { id: "function_calling", requirement: "required" },
    { id: "web_search", requirement: "optional" },
  ],
});
assert.equal(functionPlan.transport, "chat_completions");
assert.deepEqual(functionPlan.enabledTools.map((tool) => tool.intent.id), ["function_calling"]);
assert.equal(functionPlan.enabledTools[0]?.descriptor.supportSource, "user-override");
assert.equal(functionPlan.omittedOptionalTools[0]?.capabilityId, "web_search");
console.log("PASS explicit custom override enables only the declared function capability");

const responsesOverrides = buildCustomToolCapabilityOverrides([
  "function_calling",
  "web_search",
]);
const responsesPlan = resolveProviderCallPlan({
  context: {
    providerId: "custom",
    modelId: "responses-endpoint",
    customOverrides: responsesOverrides,
    allowedTransports: customCompatibleTransports(["responses"]),
    features: { mode: "discussion" },
  },
  requestedTools: [
    { id: "function_calling", requirement: "required" },
    { id: "web_search", requirement: "required" },
  ],
});
assert.equal(responsesPlan.transport, "responses");
assert.deepEqual(
  responsesPlan.enabledTools.map((tool) => tool.intent.id),
  ["function_calling", "web_search"],
);
console.log("PASS declared Responses transport is selected for compatible custom tools");

assert.throws(
  () =>
    resolveProviderCallPlan({
      context: {
        providerId: "custom",
        modelId: "chat-only-endpoint",
        customOverrides: responsesOverrides,
        allowedTransports: customCompatibleTransports(["chat_completions"]),
        features: { mode: "discussion" },
      },
      requestedTools: [{ id: "web_search", requirement: "required" }],
    }),
  (error: unknown) =>
    error instanceof ProviderCallPlanError &&
    error.decisions.some((item) => item.code === "transport_incompatible"),
);
console.log("PASS custom transport declarations cannot enable incompatible tool shapes");

const openAIPlan = resolveProviderCallPlan({
  context: {
    providerId: "openai",
    modelId: "gpt-5.6-sol",
    customOverrides: [
      {
        id: "function_calling",
        support: "unsupported",
        execution: "client",
        transports: ["responses"],
        supportSource: "user-override",
      },
    ],
    features: { mode: "discussion" },
  },
  requestedTools: [{ id: "function_calling", requirement: "required" }],
});
assert.equal(openAIPlan.enabledTools[0]?.descriptor.support, "supported");
assert.equal(openAIPlan.enabledTools[0]?.descriptor.supportSource, "provider-docs");
console.log("PASS user-override capability evidence is ignored for non-custom providers");


__resetClientStoreForTests();
try {
  const saved = addCustomModel({
    label: "Declared endpoint",
    baseURL: "http://127.0.0.1:9/v1",
    model: "declared-model",
    toolCapabilityOverrides: functionOverrides,
    compatibleTransports: ["responses"],
  });
  assert.deepEqual(saved.toolCapabilityOverrides, functionOverrides);
  assert.deepEqual(saved.compatibleTransports, ["responses"]);
  updateCustomModelToolConfiguration(saved.id, {
    toolCapabilityOverrides: responsesOverrides,
    compatibleTransports: ["responses"],
  });
  const updated = listCustomModels().find((item) => item.id === saved.id);
  assert.deepEqual(updated?.toolCapabilityOverrides, responsesOverrides);
  assert.deepEqual(updated?.compatibleTransports, ["responses"]);
  console.log("PASS custom settings persist explicit tool and transport declarations");

  const beforeTest = JSON.stringify({
    toolCapabilityOverrides: updated?.toolCapabilityOverrides,
    compatibleTransports: updated?.compatibleTransports,
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("unavailable", { status: 503 });
  try {
    await testSavedCustomModel(saved.id);
  } finally {
    globalThis.fetch = originalFetch;
  }
  const afterTest = listCustomModels().find((item) => item.id === saved.id);
  assert.equal(
    JSON.stringify({
      toolCapabilityOverrides: afterTest?.toolCapabilityOverrides,
      compatibleTransports: afterTest?.compatibleTransports,
    }),
    beforeTest,
  );
  console.log("PASS connection tests never mutate custom tool declarations");
} finally {
  __clearClientStoreForTests();
}

const responseNativeTool: NativeToolDefinition = {
  name: "lookup",
  description: "Lookup a value",
  parameters: { type: "object", properties: { query: { type: "string" } } },
};
const runtimeModel: CustomModel = {
  id: "runtime",
  label: "Responses custom",
  baseURL: "https://custom.example/v1",
  model: "custom-responses-model",
  apiKey: "test-key",
  hasKey: true,
  capabilities: { image: false, document: false, audio: false, video: false },
  toolCapabilityOverrides: responsesOverrides,
  compatibleTransports: ["responses"],
  createdAt: "2026-09-30T00:00:00.000Z",
};
const planningContext = customModelPlanningContext(runtimeModel);
assert.deepEqual(planningContext.customOverrides, responsesOverrides);
assert.deepEqual(planningContext.allowedTransports, ["responses"]);
console.log("PASS browser custom model planning context preserves explicit endpoint declarations");
const runtimeParams: ChatParams = {
  apiKey: "test-key",
  model: runtimeModel.model,
  messages: [{ role: "user", content: "Search and call the tool." }],
  functionTools: [responseNativeTool],
  webSearch: true,
  callPlan: responsesPlan,
};
let requestedUrl = "";
let requestedBody: Record<string, unknown> | undefined;
const originalFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  requestedUrl = String(input);
  requestedBody = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
  return new Response(
    [
      'data: {"type":"response.output_text.delta","delta":"ok"}',
      'data: {"type":"response.completed","response":{"id":"resp_custom","status":"completed","output":[],"usage":{"input_tokens":1,"output_tokens":1,"total_tokens":2}}}',
      "data: [DONE]",
      "",
    ].join("\n\n"),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
};
try {
  const chunks: StreamChunk[] = [];
  for await (const chunk of streamCustomChat(runtimeModel, runtimeParams)) chunks.push(chunk);
  assert.match(requestedUrl, /\/responses$/);
  const tools = requestedBody?.tools as Array<Record<string, unknown>> | undefined;
  assert.equal(tools?.some((tool) => tool.type === "web_search"), true);
  assert.equal(tools?.some((tool) => tool.type === "function" && tool.name === "lookup"), true);
  assert.equal(chunks.some((chunk) => chunk.type === "token"), true);
  console.log("PASS declared custom Responses transport is used by the real custom stream path");
} finally {
  globalThis.fetch = originalFetch;
}

console.log("PASS");
