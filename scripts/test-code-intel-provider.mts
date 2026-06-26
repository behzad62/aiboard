/** Code intelligence provider checks (run: npx tsx scripts/test-code-intel-provider.mts) */
import assert from "node:assert/strict";

import {
  BuildContextManager,
  type ContextPack,
} from "../lib/build-context";
import {
  codeIntelResultToContextPack,
  createCodeIntelProvider,
  shouldAutoIncludeCodeIntelArchitecture,
  type CodeIntelMcpServer,
} from "../lib/build-context/code-intel";
import {
  buildArchitectPlanPrompt,
  buildArchitectReviewPrompt,
} from "../lib/orchestrator/build";

const text = (label: string, words: number) =>
  Array.from({ length: words }, (_, index) => `${label}_${index}`).join(" ");

const files = [
  "package.json",
  "tsconfig.json",
  "lib/build-context/index.ts",
  "lib/build-context/context-packs.ts",
  "lib/client/build-engine.ts",
  ...Array.from({ length: 140 }, (_, index) => `src/feature-${index}.ts`),
];

const server: CodeIntelMcpServer = {
  name: "codebase-memory-mcp",
  status: "ready",
  tools: [
    {
      name: "get_architecture",
      description: "Codebase overview",
      inputSchema: {
        properties: {
          aspects: { type: "array" },
          limit: { type: "integer" },
        },
      },
    },
    {
      name: "search_graph",
      description: "Structured symbol search",
      inputSchema: {
        properties: {
          name_pattern: { type: "string" },
          label: { type: "string" },
          limit: { type: "integer" },
          offset: { type: "integer" },
        },
      },
    },
    {
      name: "trace_path",
      description: "Trace inbound/outbound symbol paths",
      inputSchema: {
        properties: {
          function_name: { type: "string" },
          direction: { type: "string" },
          depth: { type: "integer" },
          limit: { type: "integer" },
        },
      },
    },
    {
      name: "detect_changes",
      description: "Detect git diff blast radius",
      inputSchema: {
        properties: {
          paths: { type: "array" },
          limit: { type: "integer" },
        },
      },
    },
    {
      name: "index_repository",
      description: "Index a repository",
      inputSchema: { properties: { repo_path: { type: "string" } } },
    },
    {
      name: "manage_adr",
      description: "CRUD ADRs",
      inputSchema: { properties: { action: { type: "string" } } },
    },
  ],
};

const calls: Array<{ server: string; tool: string; args: unknown }> = [];
const provider = createCodeIntelProvider({
  mcp: {
    servers: [server],
    callTool: async (serverName, tool, args) => {
      calls.push({ server: serverName, tool, args });
      return {
        text: `${tool} result for ${JSON.stringify(args)}`,
        isError: false,
        truncated: false,
      };
    },
  },
  native: {
    listFiles: async () => files,
    readFile: async (path) =>
      path === "lib/build-context/index.ts"
        ? "export class BuildContextManager {}"
        : null,
    searchText: async (query) => [
      {
        path: "lib/build-context/index.ts",
        line: 1,
        text: `export class ${query} {}`,
      },
    ],
  },
});

assert.equal(provider.status.mode, "codebase-memory-mcp");
assert.equal(provider.status.available, true);
assert.equal(provider.status.serverName, "codebase-memory-mcp");
assert.deepEqual(provider.status.capabilities, [
  "architecture",
  "search_symbols",
  "trace_symbol",
  "detect_change_impact",
]);
assert.ok(provider.status.detail.includes("codebase-memory-mcp"));
assert.ok(!provider.status.tools.includes("index_repository"));
assert.ok(!provider.status.tools.includes("manage_adr"));

const architecture = await provider.query({
  op: "architecture",
  repoFiles: files,
});
assert.equal(architecture.mode, "codebase-memory-mcp");
assert.equal(calls.at(-1)?.tool, "get_architecture");
assert.ok((calls.at(-1)?.args as { limit?: number }).limit! <= 10);
assert.ok(architecture.content.includes("get_architecture result"));

const search = await provider.query({
  op: "search_symbols",
  query: "BuildContextManager",
  limit: 50,
});
assert.equal(search.mode, "codebase-memory-mcp");
assert.equal(calls.at(-1)?.tool, "search_graph");
assert.match(
  (calls.at(-1)?.args as { name_pattern?: string }).name_pattern ?? "",
  /BuildContextManager/
);
assert.ok((calls.at(-1)?.args as { limit?: number }).limit! <= 10);

const trace = await provider.query({
  op: "trace_symbol",
  symbol: "runBuildDiscussion",
  limit: 99,
});
assert.equal(trace.mode, "codebase-memory-mcp");
assert.equal(calls.at(-1)?.tool, "trace_path");
assert.equal((calls.at(-1)?.args as { depth?: number }).depth, 3);
assert.ok((calls.at(-1)?.args as { limit?: number }).limit! <= 10);

const impact = await provider.query({
  op: "detect_change_impact",
  paths: ["lib/client/build-engine.ts"],
  limit: 99,
});
assert.equal(impact.mode, "codebase-memory-mcp");
assert.equal(calls.at(-1)?.tool, "detect_changes");
assert.deepEqual((calls.at(-1)?.args as { paths?: string[] }).paths, [
  "lib/client/build-engine.ts",
]);
assert.ok((calls.at(-1)?.args as { limit?: number }).limit! <= 10);

assert.ok(
  calls.every(
    (call) => !["index_repository", "delete_project", "manage_adr", "ingest_traces"].includes(call.tool)
  ),
  calls
);

const compatible = createCodeIntelProvider({
  mcp: {
    servers: [{ ...server, name: "structural-code-intel" }],
    callTool: async () => ({ text: "ok", isError: false, truncated: false }),
  },
  native: { listFiles: async () => files },
});
assert.equal(compatible.status.mode, "codebase-memory-mcp");
assert.equal(compatible.status.serverName, "structural-code-intel");

const native = createCodeIntelProvider({
  mcp: { servers: [], callTool: async () => ({ text: "", isError: true, truncated: false }) },
  native: {
    listFiles: async () => files,
    readFile: async (path) =>
      path === "lib/client/build-engine.ts"
        ? "export async function runBuildDiscussion() {}\nconst BuildContextManager = 1;"
        : null,
    searchText: async (query) => [
      { path: "lib/client/build-engine.ts", line: 1, text: `function ${query}() {}` },
      { path: "lib/build-context/index.ts", line: 2, text: `class ${query} {}` },
    ],
  },
});
assert.equal(native.status.mode, "native");
assert.equal(native.status.available, true);
assert.ok(shouldAutoIncludeCodeIntelArchitecture(files, native.status));

const nativeArchitecture = await native.query({
  op: "architecture",
  repoFiles: files,
});
assert.equal(nativeArchitecture.mode, "native");
assert.match(nativeArchitecture.content, /Native code intelligence/);
assert.match(nativeArchitecture.content, /lib\/client\/build-engine\.ts/);

const planPack = codeIntelResultToContextPack(nativeArchitecture, {
  id: "plan-code-intel-architecture",
  title: "Code intelligence architecture digest",
  priority: 75,
});
assert.ok(planPack);

const nativeImpact = await native.query({
  op: "detect_change_impact",
  paths: ["lib/client/build-engine.ts"],
});
const impactPack = codeIntelResultToContextPack(nativeImpact, {
  id: "review-code-intel-impact",
  title: "Code intelligence change-impact digest",
  priority: 145,
});
assert.ok(impactPack);
assert.match(impactPack.content, /lib\/client\/build-engine\.ts/);

const manager = new BuildContextManager();
const planContext = manager.buildPlanContext({
  request: "Add code intelligence",
  treeText: files.join("\n"),
  fileContext: "",
  contextPacks: [planPack as ContextPack],
});
const planPrompt = buildArchitectPlanPrompt({
  request: "Add code intelligence",
  treeText: files.join("\n"),
  fileContext: "",
  maxTasks: 3,
  workerNames: ["Worker A"],
  readHopsLeft: 0,
  codeIntelStatus: native.status.detail,
  codeIntelCallsLeft: 2,
  assembledContext: planContext,
});
assert.match(planPrompt, /Code intelligence architecture digest/);
assert.match(planPrompt, /Native code intelligence/);
assert.match(planPrompt, /"action":"code_intel"/);
assert.match(planPrompt, /search_symbols/);

const reviewContext = manager.buildReviewContext({
  request: "Add code intelligence",
  treeText: files.join("\n"),
  executedText: text("executed", 80),
  contextPacks: [impactPack as ContextPack],
});
const reviewPrompt = buildArchitectReviewPrompt({
  request: "Add code intelligence",
  treeText: files.join("\n"),
  executedText: "",
  maxNewTasks: 2,
  cyclesLeft: 1,
  codeIntelStatus: native.status.detail,
  codeIntelCallsLeft: 2,
  assembledContext: reviewContext,
});
assert.match(reviewPrompt, /Code intelligence change-impact digest/);
assert.match(reviewPrompt, /detect_change_impact/);

const failingMcp = createCodeIntelProvider({
  mcp: {
    servers: [server],
    callTool: async () => {
      throw new Error("server missing index");
    },
  },
  native: {
    listFiles: async () => files,
    searchText: async (query) => [
      { path: "lib/client/build-engine.ts", line: 1, text: query },
    ],
  },
});
const fallback = await failingMcp.query({
  op: "search_symbols",
  query: "BuildContextManager",
});
assert.equal(fallback.mode, "native");
assert.equal(fallback.fallbackFrom, "codebase-memory-mcp");
assert.match(fallback.content, /server missing index/);
assert.match(fallback.content, /lib\/client\/build-engine\.ts/);

console.log("PASS code intelligence provider tests");
