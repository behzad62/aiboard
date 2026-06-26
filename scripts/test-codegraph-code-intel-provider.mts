/** CodeGraph-first code intelligence checks (run: npx tsx scripts/test-codegraph-code-intel-provider.mts) */
import assert from "node:assert/strict";

import {
  codeIntelResultToContextPack,
  createCodeIntelProvider,
  filterCodebaseMemoryMcpToolsForGenericUse,
  isCodeGraphMcpServer,
  isGenericMcpToolAllowed,
  type CodeIntelMcpServer,
} from "../lib/build-context/code-intel-plus";

const codegraphServer: CodeIntelMcpServer = {
  name: "codegraph",
  status: "ready",
  tools: [
    {
      name: "codegraph_explore",
      description: "Return surgical source context, call paths, and blast radius.",
      inputSchema: {
        properties: {
          query: { type: "string" },
          limit: { type: "integer" },
          paths: { type: "array" },
        },
        required: ["query"],
      },
    },
    {
      name: "codegraph_reindex",
      description: "Mutating maintenance command that should not be exposed generically.",
      inputSchema: { properties: {} },
    },
  ],
};

const codebaseServer: CodeIntelMcpServer = {
  name: "codebase-memory-mcp",
  status: "ready",
  tools: [
    {
      name: "list_projects",
      inputSchema: { properties: {} },
    },
    {
      name: "get_architecture",
      inputSchema: {
        properties: {
          project: { type: "string" },
          aspects: { type: "array" },
          limit: { type: "integer" },
        },
        required: ["project"],
      },
    },
  ],
};

assert.equal(isCodeGraphMcpServer(codegraphServer), true);
assert.equal(isCodeGraphMcpServer(codebaseServer), false);
assert.equal(filterCodebaseMemoryMcpToolsForGenericUse(codegraphServer).tools.length, 0);
assert.equal(isGenericMcpToolAllowed(codegraphServer, "codegraph_explore"), false);

const calls: Array<{ server: string; tool: string; args: Record<string, unknown> }> = [];
const provider = createCodeIntelProvider({
  mcp: {
    servers: [codebaseServer, codegraphServer],
    callTool: async (server, tool, args) => {
      calls.push({ server, tool, args });
      if (server === "codegraph") {
        return {
          text: `CodeGraph surgical context for ${(args.query as string).slice(0, 80)}`,
          isError: false,
          truncated: false,
        };
      }
      if (tool === "list_projects") {
        return {
          text: JSON.stringify({ projects: [{ name: "aiboard", root_path: "C:/repo/aiboard" }] }),
          isError: false,
          truncated: false,
        };
      }
      return { text: `codebase fallback ${tool}`, isError: false, truncated: false };
    },
  },
  native: {
    listFiles: () => ["lib/client/build-engine.ts", "lib/build-context/code-intel.ts"],
    searchText: (query) => [
      { path: "lib/client/build-engine.ts", line: 1, text: `match ${query}` },
    ],
  },
});

assert.equal(provider.status.available, true);
assert.equal(provider.status.serverName, "codegraph");
assert.match(provider.status.detail, /CodeGraph/);
assert.deepEqual(provider.status.capabilities, [
  "architecture",
  "search_symbols",
  "trace_symbol",
  "detect_change_impact",
]);

const architecture = await provider.query({ op: "architecture" });
assert.equal(architecture.serverName, "codegraph");
assert.equal(architecture.toolName, "codegraph_explore");
assert.match(architecture.content, /CodeGraph surgical context/);
assert.match(calls.at(-1)?.args.query as string, /architecture overview/i);

const search = await provider.query({
  op: "search_symbols",
  query: "BuildContextManager",
  limit: 50,
});
assert.equal(search.serverName, "codegraph");
assert.equal((calls.at(-1)?.args.limit as number), 10);
assert.match(calls.at(-1)?.args.query as string, /BuildContextManager/);
assert.match(calls.at(-1)?.args.query as string, /symbol/i);

const trace = await provider.query({
  op: "trace_symbol",
  symbol: "runBuildDiscussion",
});
assert.equal(trace.serverName, "codegraph");
assert.match(calls.at(-1)?.args.query as string, /runBuildDiscussion/);
assert.match(calls.at(-1)?.args.query as string, /call/i);

const impact = await provider.query({
  op: "detect_change_impact",
  paths: ["lib/client/build-engine.ts"],
});
assert.equal(impact.serverName, "codegraph");
assert.match(calls.at(-1)?.args.query as string, /lib\/client\/build-engine\.ts/);
assert.match(calls.at(-1)?.args.query as string, /impact/i);

const pack = codeIntelResultToContextPack(impact, {
  id: "review-code-intel-impact",
  title: "Code intelligence change-impact digest",
});
assert.ok(pack);
assert.equal(pack.metadata?.codeIntelServer, "codegraph");

const fallbackCalls: Array<{ server: string; tool: string }> = [];
const fallbackProvider = createCodeIntelProvider({
  mcp: {
    servers: [codegraphServer, codebaseServer],
    callTool: async (server, tool) => {
      fallbackCalls.push({ server, tool });
      if (server === "codegraph") throw new Error("index missing");
      if (tool === "list_projects") {
        return {
          text: JSON.stringify({ projects: [{ name: "aiboard", root_path: "C:/repo/aiboard" }] }),
          isError: false,
          truncated: false,
        };
      }
      return { text: "codebase-memory fallback ok", isError: false, truncated: false };
    },
  },
  native: {
    listFiles: () => ["lib/client/build-engine.ts"],
    searchText: (query) => [{ path: "lib/client/build-engine.ts", line: 1, text: query }],
  },
});
const fallback = await fallbackProvider.query({ op: "architecture" });
assert.match(fallback.content, /CodeGraph code intelligence failed/);
assert.match(fallback.content, /codebase-memory fallback ok/);
assert.ok(fallbackCalls.some((call) => call.server === "codebase-memory-mcp"));

console.log("PASS CodeGraph code intelligence provider tests");
