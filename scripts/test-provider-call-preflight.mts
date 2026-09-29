import assert from "node:assert/strict";
import {
  legacyChatParamsToToolRequest,
} from "../lib/providers/legacy-tool-intents";
import {
  preflightProviderChatParams,
  streamProviderWithPreflight,
} from "../lib/client/engine";
import type {
  AIProvider,
  ChatParams,
  StreamChunk,
} from "../lib/providers/base";

const baseParams: ChatParams = {
  apiKey: "test-key",
  model: "gpt-5.6-sol",
  messages: [{ role: "user", content: "hello" }],
};

const mapped = legacyChatParamsToToolRequest({
  ...baseParams,
  webSearch: true,
  nativeTools: [
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
  hostedTools: [{ type: "tool_search" }, { type: "web_fetch" }],
  hostedBuildTools: true,
});
assert.deepEqual(
  mapped.toolIntents.map((intent) => [intent.id, intent.requirement]),
  [
    ["web_search", "optional"],
    ["function_calling", "required"],
    ["tool_search", "optional"],
    ["web_fetch", "optional"],
    ["code_execution", "optional"],
    ["shell", "optional"],
    ["datetime", "optional"],
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
console.log("PASS legacy tool fields map deterministically to normalized intent and inventory");

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
    streamProviderWithPreflight(
      fakeProvider,
      "openai",
      {
        ...baseParams,
        toolIntents: [{ id: "maps", requirement: "required" }],
      },
    ),
  /Required provider tools are unavailable/,
);
assert.equal(fakeNetworkCalls, 0);
console.log("PASS required unsupported capabilities fail before provider network invocation");

const optionalPrepared = preflightProviderChatParams("openai", {
  ...baseParams,
  toolIntents: [
    { id: "maps", requirement: "optional" },
    { id: "function_calling", requirement: "optional" },
  ],
  nativeTools: [
    {
      name: "read",
      description: "Read",
      parameters: { type: "object", properties: {} },
    },
  ],
});
assert.equal(optionalPrepared.callPlan?.enabledTools.some((tool) => tool.intent.id === "maps"), false);
assert.equal(optionalPrepared.callPlan?.omittedOptionalTools[0]?.code, "unsupported");
assert.equal(optionalPrepared.nativeTools?.length, 1);
console.log("PASS optional unsupported capabilities are omitted while supported client tools remain");

const buildPrepared = preflightProviderChatParams("openrouter", {
  ...baseParams,
  model: "qwen/qwen3.7-max",
  nativeTools: [
    {
      name: "repo.apply_patch",
      description: "Edit the local repository",
      parameters: { type: "object", properties: {} },
    },
  ],
  hostedBuildTools: true,
});
const buildFunctions = buildPrepared.callPlan?.enabledTools.find(
  (tool) => tool.intent.id === "function_calling",
);
const hostedShell = buildPrepared.callPlan?.enabledTools.find(
  (tool) => tool.intent.id === "shell",
);
assert.equal(buildFunctions?.descriptor.execution, "client");
assert.equal(hostedShell?.descriptor.execution, "provider");
assert.ok(buildPrepared.nativeTools?.length);
assert.equal(buildPrepared.hostedBuildTools, true);
console.log("PASS local Build functions remain client-executed and are not replaced by hosted shell");

const structuredSearch = preflightProviderChatParams("openai", {
  ...baseParams,
  structuredOutput: {
    name: "answer",
    schema: { type: "object", properties: { ok: { type: "boolean" } } },
  },
  webSearch: true,
});
assert.equal(structuredSearch.webSearch, true);
assert.equal(
  structuredSearch.callPlan?.enabledTools.some((tool) => tool.intent.id === "web_search"),
  true,
);
console.log("PASS structured output no longer globally suppresses unrelated web-search intent");

console.log("PASS");
