import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  applyToolRuntimeToRequest,
  buildToolResourceState,
  configuredOpenAIFileSearchIntent,
  configuredRemoteMcpIntent,
  resolveToolRuntimeResourceState,
  toolRuntimeSetupTarget,
} from "../lib/client/tool-runtime";
import { resolveProviderCapabilityProfile } from "../lib/providers/capability-resolution";
import { capabilityStatusRows } from "../lib/providers/capability-status";
import { __resetClientStoreForTests } from "../lib/client/store";

const ready = buildToolResourceState({
  runner: { configured: true, ready: true, detail: "Runner V2 connected" },
  remoteMcp: { configured: true, ready: true, detail: "docs" },
  openaiFileSearch: { configured: true, ready: true, detail: "vs_docs" },
  computerExecutor: { ready: false, detail: "No computer executor registered" },
  browserExecutor: { ready: false, detail: "No browser executor registered" },
});
assert.equal(ready.prerequisites.local_shell_executor?.ready, true);
assert.equal(ready.prerequisites.local_editor_executor?.ready, true);
assert.equal(ready.prerequisites.remote_mcp_server?.ready, true);
assert.equal(ready.prerequisites.openai_vector_store?.ready, true);
assert.equal(ready.prerequisites.computer_executor?.ready, false);
assert.equal(ready.prerequisites.browser_executor?.ready, false);
console.log("PASS runner-backed shell/editor and configured MCP become ready without faking client executors");

const offline = buildToolResourceState({
  runner: { configured: true, ready: false, detail: "Runner V2 is unreachable" },
  remoteMcp: { configured: false, ready: false, detail: "No approved remote MCP server" },
  openaiFileSearch: { configured: false, ready: false, detail: "No OpenAI vector store" },
  computerExecutor: { ready: false, detail: "No computer executor registered" },
  browserExecutor: { ready: false, detail: "No browser executor registered" },
});
assert.equal(offline.prerequisites.local_shell_executor?.ready, false);
assert.match(offline.prerequisites.local_shell_executor?.reason ?? "", /unreachable/i);
assert.match(offline.prerequisites.remote_mcp_server?.reason ?? "", /No approved remote MCP server/i);
console.log("PASS missing runtime resources carry actionable readiness reasons");

const mcpIntent = configuredRemoteMcpIntent({
  enabled: true,
  name: "docs",
  url: "https://mcp.example.test/sse",
  authorizationToken: "secret",
});
assert.deepEqual(mcpIntent, {
  id: "remote_mcp",
  requirement: "optional",
  parameters: {
    serverName: "docs",
    serverLabel: "docs",
    serverUrl: "https://mcp.example.test/sse",
    authorizationToken: "secret",
    authorization: "secret",
  },
});
assert.equal(configuredRemoteMcpIntent({ enabled: false, name: "docs", url: "https://mcp.example.test/sse" }), undefined);
console.log("PASS approved MCP setup maps to the provider runtime intent without exposing disabled servers");
const fileSearchIntent = configuredOpenAIFileSearchIntent({
  enabled: true,
  vectorStoreIds: [" vs_docs ", "vs_docs", "vs_code"],
});
assert.deepEqual(fileSearchIntent, {
  id: "file_search",
  requirement: "optional",
  parameters: { vectorStoreIds: ["vs_docs", "vs_code"] },
});
assert.equal(
  configuredOpenAIFileSearchIntent({ enabled: false, vectorStoreIds: ["vs_docs"] }),
  undefined,
);
console.log("PASS OpenAI vector-store setup maps to a scoped File Search intent");

const openaiFileSearchRequest = applyToolRuntimeToRequest(
  { toolIntents: [], toolInventory: [] },
  {
    openaiFileSearch: { enabled: true, vectorStoreIds: ["vs_docs"] },
  },
  "openai",
);
assert.deepEqual(openaiFileSearchRequest.toolIntents.map((intent) => intent.id), ["file_search"]);
const googleWithOpenAIStore = applyToolRuntimeToRequest(
  { toolIntents: [], toolInventory: [] },
  {
    openaiFileSearch: { enabled: true, vectorStoreIds: ["vs_docs"] },
  },
  "google",
);
assert.equal(
  googleWithOpenAIStore.toolIntents.some((intent) => intent.id === "file_search"),
  false,
  "OpenAI vector stores must never enable Gemini/xAI File Search",
);
console.log("PASS OpenAI File Search runtime intent is provider-scoped");
const openaiRowsWithStore = capabilityStatusRows(resolveProviderCapabilityProfile({
  providerId: "openai",
  modelId: "gpt-5.5",
  resourceState: ready,
}));
assert.equal(
  openaiRowsWithStore.find((row) => row.capabilityId === "file_search")?.statusLabel,
  "Available now",
);
console.log("PASS configured OpenAI vector store makes File Search available now");


const mergedRequest = applyToolRuntimeToRequest(
  { toolIntents: [{ id: "web_search", requirement: "optional" }], toolInventory: [] },
  { remoteMcpServer: { enabled: true, name: "docs", url: "https://mcp.example.test/sse" } },
);
assert.deepEqual(mergedRequest.toolIntents.map((intent) => intent.id), ["web_search", "remote_mcp"]);
console.log("PASS configured MCP is merged into real provider tool requests without replacing existing intents");

const anthropicRows = capabilityStatusRows(resolveProviderCapabilityProfile({
  providerId: "anthropic",
  modelId: "claude-opus-4-8",
  resourceState: offline,
}));
const shellRow = anthropicRows.find((row) => row.capabilityId === "shell");
assert.equal(shellRow?.statusLabel, "Supported — setup required");
assert.match(shellRow?.missingPrerequisites[0]?.reason ?? "", /unreachable/i);
console.log("PASS provider readiness rows expose the real runtime failure reason");


__resetClientStoreForTests();
const liveRunnerState = await resolveToolRuntimeResourceState({
  runner: { url: "http://127.0.0.1:8787", token: "runner-token", access: "project" },
  checkRunner: async () => ({
    ok: true,
    protocolVersion: 2,
    projectPath: "C:/repo",
    nodeVersion: "24.18.0",
  }),
});
assert.equal(liveRunnerState.prerequisites.local_shell_executor?.ready, true);
assert.equal(liveRunnerState.prerequisites.local_editor_executor?.ready, true);
assert.equal(liveRunnerState.prerequisites.computer_executor?.ready, false);
assert.equal(liveRunnerState.prerequisites.browser_executor?.ready, false);
console.log("PASS live Runner V2 health unlocks only the local execution capabilities it actually provides");


let healthChecks = 0;
const mcpOnlyState = await resolveToolRuntimeResourceState({
  runner: { url: "http://127.0.0.1:8787", token: "runner-token", access: "project" },
  checkRunnerHealth: false,
  checkRunner: async () => {
    healthChecks += 1;
    throw new Error("must not run");
  },
});
assert.equal(healthChecks, 0);
assert.equal(mcpOnlyState.prerequisites.local_shell_executor?.ready, false);
console.log("PASS MCP-only/provider calls do not probe Runner V2 unless a local executor capability is requested");

const tableSource = await readFile(new URL("../components/ProviderCapabilityTable.tsx", import.meta.url), "utf8");
const settingsSource = await readFile(new URL("../app/settings/settings-client.tsx", import.meta.url), "utf8");
const toolsPanelSource = await readFile(new URL("../components/ToolRuntimeSettingsPanel.tsx", import.meta.url), "utf8");
assert.match(tableSource, /Configure tools/);
assert.doesNotMatch(tableSource, /configuration:\s*\$\{item\.configurationPath\}/);
assert.match(settingsSource, /TabsTrigger value="tools"/);
assert.match(settingsSource, /ToolRuntimeSettingsPanel/);
assert.match(toolsPanelSource, /OpenAI File Search/);
assert.match(toolsPanelSource, /Vector store IDs/);
console.log("PASS setup-required rows lead to a real Tools settings surface instead of internal config keys");

for (const prerequisite of [
  "local_shell_executor",
  "local_editor_executor",
  "remote_mcp_server",
] as const) {
  assert.equal(toolRuntimeSetupTarget(prerequisite), "/settings?tab=tools");
}
assert.equal(toolRuntimeSetupTarget("computer_executor"), undefined);
assert.equal(toolRuntimeSetupTarget("browser_executor"), undefined);
console.log("PASS only tools with real setup controls receive Configure tools links");
