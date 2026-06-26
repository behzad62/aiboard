/** Code intelligence provider checks (run: npx tsx scripts/test-code-intel-provider.mts) */
import assert from "node:assert/strict";

import {
  BuildContextManager,
  type ContextPack,
} from "../lib/build-context";
import {
  codeIntelResultToContextPack,
  createCodeIntelPhaseBudget,
  createCodeIntelProvider,
  filterCodebaseMemoryMcpToolsForGenericUse,
  isGenericMcpToolAllowed,
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
      name: "list_projects",
      description: "List indexed projects",
      inputSchema: { properties: {} },
    },
    {
      name: "get_architecture",
      description: "Codebase overview",
      inputSchema: {
        properties: {
          project: { type: "string" },
          aspects: { type: "array" },
        },
        required: ["project"],
      },
    },
    {
      name: "search_graph",
      description: "Structured symbol search",
      inputSchema: {
        properties: {
          project: { type: "string" },
          name_pattern: { type: "string" },
          label: { type: "string" },
          limit: { type: "integer" },
          offset: { type: "integer" },
        },
        required: ["project"],
      },
    },
    {
      name: "trace_path",
      description: "Trace inbound/outbound symbol paths",
      inputSchema: {
        properties: {
          project: { type: "string" },
          function_name: { type: "string" },
          direction: { type: "string" },
          depth: { type: "integer" },
          mode: { type: "string" },
        },
        required: ["function_name", "project"],
      },
    },
    {
      name: "detect_changes",
      description: "Detect git diff blast radius",
      inputSchema: {
        properties: {
          project: { type: "string" },
          scope: { type: "string" },
          depth: { type: "integer" },
          base_branch: { type: "string" },
        },
        required: ["project"],
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
    projectHints: [
      "C:/Users/b_a_s/source/repos/ai-discussion-board",
      "https://github.com/behzad62/aiboard.git",
    ],
    callTool: async (serverName, tool, args) => {
      calls.push({ server: serverName, tool, args });
      if (tool === "list_projects") {
        return {
          text: JSON.stringify({
            projects: [
              {
                name: "unrelated",
                root_path: "C:/work/unrelated",
              },
              {
                name: "aiboard",
                root_path: "C:/Users/b_a_s/source/repos/ai-discussion-board",
                git: {
                  canonical_root:
                    "C:/Users/b_a_s/source/repos/ai-discussion-board",
                },
              },
            ],
          }),
          isError: false,
          truncated: false,
        };
      }
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

const genericFiltered = filterCodebaseMemoryMcpToolsForGenericUse(server);
assert.ok(genericFiltered.tools.some((tool) => tool.name === "search_graph"));
assert.ok(genericFiltered.tools.some((tool) => tool.name === "list_projects"));
assert.ok(!genericFiltered.tools.some((tool) => tool.name === "index_repository"));
assert.ok(!genericFiltered.tools.some((tool) => tool.name === "manage_adr"));
assert.equal(isGenericMcpToolAllowed(server, "search_graph"), true);
for (const mutating of [
  "index_repository",
  "manage_adr",
  "delete_project",
  "ingest_traces",
  "write_cache",
  "update_graph",
  "store_memory",
  "create_project",
  "delete_project",
  "remove_project",
]) {
  assert.equal(isGenericMcpToolAllowed(server, mutating), false, mutating);
}
const nonCodebaseServer: CodeIntelMcpServer = {
  name: "playwright",
  status: "ready",
  tools: [
    {
      name: "browser_create_context",
      description: "Create an isolated browser context",
      inputSchema: { properties: {} },
    },
  ],
};
assert.equal(
  filterCodebaseMemoryMcpToolsForGenericUse(nonCodebaseServer).tools.length,
  1
);
assert.equal(
  isGenericMcpToolAllowed(nonCodebaseServer, "browser_create_context"),
  true
);

const architecture = await provider.query({
  op: "architecture",
  repoFiles: files,
});
assert.equal(architecture.mode, "codebase-memory-mcp");
assert.equal(calls.at(-1)?.tool, "get_architecture");
assert.equal((calls.at(-1)?.args as { project?: string }).project, "aiboard");
assert.ok(architecture.content.includes("get_architecture result"));

const search = await provider.query({
  op: "search_symbols",
  query: "BuildContextManager",
  limit: 50,
});
assert.equal(search.mode, "codebase-memory-mcp");
assert.equal(calls.at(-1)?.tool, "search_graph");
assert.equal((calls.at(-1)?.args as { project?: string }).project, "aiboard");
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
assert.equal((calls.at(-1)?.args as { project?: string }).project, "aiboard");
assert.equal((calls.at(-1)?.args as { depth?: number }).depth, 3);
assert.equal((calls.at(-1)?.args as { mode?: string }).mode, "calls");

const impact = await provider.query({
  op: "detect_change_impact",
  paths: ["lib/client/build-engine.ts"],
  limit: 99,
});
assert.equal(impact.mode, "codebase-memory-mcp");
assert.equal(calls.at(-1)?.tool, "detect_changes");
assert.equal((calls.at(-1)?.args as { project?: string }).project, "aiboard");
assert.match(
  (calls.at(-1)?.args as { scope?: string }).scope ?? "",
  /lib\/client\/build-engine\.ts/
);

const resolverCalls = calls.filter((call) => call.tool === "list_projects");
assert.equal(resolverCalls.length, 1);
assert.ok(
  ["get_architecture", "search_graph", "trace_path", "detect_changes"].every(
    (tool) =>
      calls.some(
        (call) =>
          call.tool === tool &&
          (call.args as { project?: string }).project === "aiboard"
      )
  ),
  calls
);

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

const singleProjectCalls: Array<{ tool: string; args: unknown }> = [];
const singleProject = createCodeIntelProvider({
  mcp: {
    servers: [server],
    projectHints: ["C:/missing/root"],
    callTool: async (_serverName, tool, args) => {
      singleProjectCalls.push({ tool, args });
      if (tool === "list_projects") {
        return {
          text: JSON.stringify({
            projects: [{ name: "only-project", root_path: "C:/one" }],
          }),
          isError: false,
          truncated: false,
        };
      }
      return { text: "ok", isError: false, truncated: false };
    },
  },
  native: { listFiles: async () => files },
});
const singleProjectResult = await singleProject.query({ op: "architecture" });
assert.equal(singleProjectResult.mode, "codebase-memory-mcp");
assert.equal(
  (singleProjectCalls.at(-1)?.args as { project?: string }).project,
  "only-project"
);

const ambiguousProject = createCodeIntelProvider({
  mcp: {
    servers: [server],
    projectHints: ["C:/missing/root"],
    callTool: async (_serverName, tool) => {
      if (tool === "list_projects") {
        return {
          text: JSON.stringify({
            projects: [
              { name: "first", root_path: "C:/first" },
              { name: "second", root_path: "C:/second" },
            ],
          }),
          isError: false,
          truncated: false,
        };
      }
      return { text: "should not call graph tool", isError: false, truncated: false };
    },
  },
  native: {
    listFiles: async () => files,
    searchText: async (query) => [
      { path: "lib/client/build-engine.ts", line: 1, text: query },
    ],
  },
});
const ambiguousFallback = await ambiguousProject.query({
  op: "search_symbols",
  query: "BuildContextManager",
});
assert.equal(ambiguousFallback.mode, "native");
assert.equal(ambiguousFallback.fallbackFrom, "codebase-memory-mcp");
assert.match(ambiguousFallback.content, /Could not resolve codebase-memory project/);

const phaseBudget = createCodeIntelPhaseBudget({ perPhase: 2, total: 5 });
assert.equal(phaseBudget.callsLeft(), 2);
assert.equal(phaseBudget.recordCall(), true);
assert.equal(phaseBudget.callsLeft(), 1);
assert.equal(phaseBudget.recordCall(), true);
assert.equal(phaseBudget.callsLeft(), 0);
assert.equal(phaseBudget.recordCall(), false);
phaseBudget.resetPhase();
assert.equal(phaseBudget.callsLeft(), 2);
assert.equal(phaseBudget.recordCall(), true);
assert.equal(phaseBudget.recordCall(), true);
phaseBudget.resetPhase();
assert.equal(phaseBudget.callsLeft(), 1);
assert.equal(phaseBudget.recordCall(), true);
assert.equal(phaseBudget.callsLeft(), 0);
phaseBudget.resetPhase();
assert.equal(phaseBudget.callsLeft(), 0);
assert.equal(phaseBudget.recordCall(), false);

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
