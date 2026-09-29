import assert from "node:assert/strict";
import {
  preflightProviderChatParams,
  streamProviderWithPreflight,
} from "../lib/client/engine";
import type {
  AIProvider,
  ChatParams,
  StreamChunk,
} from "../lib/providers/base";
import { buildProviderToolRequest } from "../lib/providers/tool-request";
import { webSearchToolIntent } from "../lib/providers/web-search";

const baseParams: ChatParams = {
  apiKey: "test-key",
  model: "gpt-5.6-sol",
  messages: [{ role: "user", content: "hello" }],
};

const mapped = buildProviderToolRequest({
  toolIntents: [
    webSearchToolIntent({ allowWebSearch: true })!,
    { id: "web_fetch", requirement: "optional" },
    { id: "code_execution", requirement: "optional" },
    { id: "shell", requirement: "optional" },
    { id: "datetime", requirement: "optional" },
  ],
  functionTools: [
    {
      name: "repo.read",
      description: "Read repository files",
      parameters: { type: "object", properties: {} },
      deferLoading: false,
    },
    {
      name: "repo.write",
      description: "Write repository files",
      parameters: { type: "object", properties: {} },
    },
  ],
  toolChoice: "required",
});
assert.deepEqual(
  mapped.toolIntents.map((intent) => [intent.id, intent.requirement]),
  [
    ["web_search", "optional"],
    ["web_fetch", "optional"],
    ["code_execution", "optional"],
    ["shell", "optional"],
    ["datetime", "optional"],
    ["function_calling", "required"],
  ],
);
assert.deepEqual(
  mapped.toolInventory.map((entry) => ({
    logicalName: entry.logicalName,
    capabilityId: entry.capabilityId,
    execution: entry.execution,
    deferLoading: entry.deferLoading,
  })),
  [
    {
      logicalName: "repo.read",
      capabilityId: "function_calling",
      execution: "client",
      deferLoading: false,
    },
    {
      logicalName: "repo.write",
      capabilityId: "function_calling",
      execution: "client",
      deferLoading: undefined,
    },
  ],
);
console.log("PASS canonical tool request normalizes explicit intents and function inventory");

let fakeNetworkCalls = 0;
const fakeProvider: AIProvider = {
  id: "fake",
  name: "Fake",
  listModels: () => [],
  validateApiKey: async () => true,
  streamChat(): AsyncIterable<StreamChunk> {
    fakeNetworkCalls++;
    return (async function* () {
      yield { type: "done" as const };
    })();
  },
};

assert.throws(
  () =>
    streamProviderWithPreflight(fakeProvider, "openai", {
      ...baseParams,
      toolIntents: [{ id: "maps", requirement: "required" }],
    }),
  /Required provider tools are unavailable/,
);
assert.equal(fakeNetworkCalls, 0);
console.log("PASS required unsupported capabilities fail before provider network invocation");

const optionalPrepared = preflightProviderChatParams("openai", {
  ...baseParams,
  ...buildProviderToolRequest({
    toolIntents: [{ id: "maps", requirement: "optional" }],
    functionTools: [
      {
        name: "read",
        description: "Read",
        parameters: { type: "object", properties: {} },
      },
    ],
  }),
});
assert.equal(optionalPrepared.callPlan?.enabledTools.some((tool) => tool.intent.id === "maps"), false);
assert.equal(optionalPrepared.callPlan?.omittedOptionalTools[0]?.code, "unsupported");
assert.equal(optionalPrepared.functionTools?.length, 1);
console.log("PASS optional unsupported capabilities are omitted while supported client tools remain");

const buildPrepared = preflightProviderChatParams("openrouter", {
  ...baseParams,
  model: "qwen/qwen3.7-max",
  ...buildProviderToolRequest({
    functionTools: [
      {
        name: "repo.apply_patch",
        description: "Edit the local repository through AI Board",
        parameters: { type: "object", properties: {} },
      },
    ],
    toolIntents: [
      { id: "web_fetch", requirement: "optional" },
      { id: "datetime", requirement: "optional" },
    ],
  }),
});
const buildFunctions = buildPrepared.callPlan?.enabledTools.find(
  (tool) => tool.intent.id === "function_calling",
);
assert.equal(buildFunctions?.descriptor.execution, "client");
assert.ok(buildPrepared.functionTools?.length);
assert.equal(
  buildPrepared.callPlan?.enabledTools.some((tool) => tool.intent.id === "shell"),
  false,
);
console.log("PASS local Build functions remain client-executed and no hosted shell is inferred");

const structuredSearch = preflightProviderChatParams("openai", {
  ...baseParams,
  structuredOutput: {
    name: "answer",
    schema: { type: "object", properties: { ok: { type: "boolean" } } },
  },
  ...buildProviderToolRequest({
    toolIntents: [webSearchToolIntent({ allowWebSearch: true })!],
  }),
});
assert.equal(
  structuredSearch.callPlan?.enabledTools.some((tool) => tool.intent.id === "web_search"),
  true,
);
console.log("PASS structured output no longer globally suppresses unrelated web-search intent");

console.log("PASS");
