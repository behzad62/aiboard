import assert from "node:assert/strict";
import {
  DEFAULT_TOOL_SEARCH_THRESHOLD,
  resolveToolLoadingPolicy,
  type LogicalToolEntry,
} from "../lib/providers/tool-inventory";
import type { ProviderCallPlan, ResolvedTool } from "../lib/providers/tool-capabilities";

function functionEntry(index: number, patch: Partial<LogicalToolEntry> = {}): LogicalToolEntry {
  return {
    logicalName: `tool_${index}`,
    capabilityId: "function_calling",
    execution: "client",
    namespace: index % 2 === 0 ? "files" : "repo",
    ...patch,
  };
}

function enabledToolSearch(): ResolvedTool {
  return {
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
  };
}

function planWithNativeToolSearch(enabled = true): ProviderCallPlan {
  return {
    transport: "responses",
    enabledTools: enabled ? [enabledToolSearch()] : [],
    omittedOptionalTools: [],
    toolPolicyTrace: {
      requestedTools: [],
      enabledTools: enabled ? ["tool_search"] : [],
      omittedTools: [],
      transport: "responses",
      decisions: [],
    },
    toolChoice: "auto",
    parallelToolCalls: false,
  };
}

assert.equal(DEFAULT_TOOL_SEARCH_THRESHOLD, 16);
const below = resolveToolLoadingPolicy({
  entries: Array.from({ length: DEFAULT_TOOL_SEARCH_THRESHOLD }, (_, index) => functionEntry(index)),
  plan: planWithNativeToolSearch(),
});
assert.equal(below.strategy, "eager");
assert.equal(below.modelVisibleTools.length, 16);
assert.equal(below.tools.some((tool) => tool.deferLoading), false);
console.log("PASS inventories at or below the threshold stay eager");

const aboveEntries = Array.from({ length: DEFAULT_TOOL_SEARCH_THRESHOLD + 1 }, (_, index) =>
  functionEntry(index),
);
const native = resolveToolLoadingPolicy({
  entries: aboveEntries,
  plan: planWithNativeToolSearch(),
});
assert.equal(native.strategy, "native_tool_search");
assert.equal(native.modelVisibleTools.length, 17);
assert.equal(native.tools.every((tool) => tool.deferLoading), true);
console.log("PASS large inventories use native tool search when the selected plan supports it");

const explicitEager = resolveToolLoadingPolicy({
  entries: aboveEntries.map((entry, index) =>
    index === 0 ? { ...entry, deferLoading: false } : entry,
  ),
  plan: planWithNativeToolSearch(),
});
assert.equal(explicitEager.tools[0]?.deferLoading, false);
assert.equal(explicitEager.tools[1]?.deferLoading, true);
console.log("PASS explicit deferLoading false survives generic policy");

const namespaces = resolveToolLoadingPolicy({
  entries: [
    functionEntry(0, { logicalName: "read", namespace: "files" }),
    functionEntry(1, { logicalName: "write", namespace: "files" }),
    functionEntry(2, { logicalName: "status", namespace: "repo" }),
  ],
  plan: planWithNativeToolSearch(),
});
assert.deepEqual(namespaces.namespaceGroups, {
  files: ["read", "write"],
  repo: ["status"],
});
console.log("PASS namespace grouping is provider-neutral and stable");

const protectedEntries = resolveToolLoadingPolicy({
  entries: aboveEntries.map((entry, index) => {
    if (index === 0) return { ...entry, lifecycleCritical: true };
    if (index === 1) return { ...entry, safetyCritical: true };
    return entry;
  }),
  plan: planWithNativeToolSearch(),
});
assert.equal(protectedEntries.tools[0]?.deferLoading, false);
assert.equal(protectedEntries.tools[1]?.deferLoading, false);
assert.equal(protectedEntries.tools[2]?.deferLoading, true);
console.log("PASS lifecycle and safety tools opt out of deferred loading");

const orchestrated = resolveToolLoadingPolicy({
  entries: aboveEntries,
  plan: planWithNativeToolSearch(false),
});
assert.equal(orchestrated.strategy, "orchestrator_preselection");
assert.equal(orchestrated.modelVisibleTools.length, 0);
assert.equal(orchestrated.orchestratorCandidates.length, 17);
console.log("PASS large inventories fall back to orchestrator preselection without native search");

const mcpEntries: LogicalToolEntry[] = [
  {
    logicalName: "docs.search.client",
    capabilityId: "function_calling",
    execution: "client",
    mcpSourceId: "docs-mcp",
  },
  {
    logicalName: "docs.search.remote",
    capabilityId: "remote_mcp",
    execution: "provider",
    mcpSourceId: "docs-mcp",
  },
];
const hostedMcpPlan: ProviderCallPlan = {
  ...planWithNativeToolSearch(false),
  enabledTools: [
    {
      intent: { id: "remote_mcp", requirement: "optional" },
      descriptor: {
        id: "remote_mcp",
        support: "supported",
        execution: "provider",
        transports: ["responses"],
        supportSource: "provider-docs",
      },
      transport: "responses",
      readiness: "available",
    },
  ],
};
const hostedMcp = resolveToolLoadingPolicy({ entries: mcpEntries, plan: hostedMcpPlan });
assert.deepEqual(hostedMcp.tools.map((tool) => tool.logicalName), ["docs.search.remote"]);
assert.equal(hostedMcp.decisions[0]?.code, "duplicate_mcp_path");
const clientMcp = resolveToolLoadingPolicy({
  entries: mcpEntries,
  plan: planWithNativeToolSearch(false),
});
assert.deepEqual(clientMcp.tools.map((tool) => tool.logicalName), ["docs.search.client"]);
assert.equal(clientMcp.decisions[0]?.code, "duplicate_mcp_path");
console.log("PASS one MCP source is surfaced through provider-hosted or client execution, never both");

console.log("PASS");
