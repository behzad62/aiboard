import {
  codeIntelResultToContextPack as baseCodeIntelResultToContextPack,
  createCodeIntelProvider as createBaseCodeIntelProvider,
  filterCodebaseMemoryMcpToolsForGenericUse as baseFilterCodebaseMemoryMcpToolsForGenericUse,
  isGenericMcpToolAllowed as baseIsGenericMcpToolAllowed,
} from "./code-intel";
import type {
  CodeIntelMcpBridge,
  CodeIntelMcpServer,
  CodeIntelMcpTool,
  CodeIntelMode,
  CodeIntelOperation,
  CodeIntelProvider,
  CodeIntelQuery,
  CodeIntelResult,
  CodeIntelStatus,
  NativeCodeIntelAdapter,
} from "./code-intel";

export * from "./code-intel";

const CODEGRAPH_NAME = "codegraph";
const CODEGRAPH_EXPLORE_TOOL = "codegraph_explore";
const CODEGRAPH_SAFE_TOOL_NAMES = new Set([
  CODEGRAPH_EXPLORE_TOOL,
  "codegraph_search",
  "codegraph_status",
]);

interface CodeGraphCandidate {
  server: CodeIntelMcpServer;
  tool: CodeIntelMcpTool;
  safeToolNames: string[];
}

function normalizeToolName(name: string): string {
  return name.trim().toLowerCase();
}

function schemaProperties(tool: CodeIntelMcpTool): Set<string> | null {
  const properties = tool.inputSchema?.properties;
  if (!properties || Object.keys(properties).length === 0) return null;
  return new Set(Object.keys(properties));
}

function filterArgsForTool(
  tool: CodeIntelMcpTool,
  args: Record<string, unknown>
): Record<string, unknown> {
  const properties = schemaProperties(tool);
  if (!properties) return args;
  const filtered: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    if (properties.has(key) && value !== undefined) filtered[key] = value;
  }
  return filtered;
}

function boundedLimit(limit: unknown): number {
  if (typeof limit !== "number" || !Number.isFinite(limit)) return 8;
  return Math.max(1, Math.min(10, Math.round(limit)));
}

function boundedPaths(paths: string[] | undefined): string[] {
  return (paths ?? [])
    .map((path) => path.trim().replace(/\\/g, "/").replace(/^\.?\//, ""))
    .filter(Boolean)
    .slice(0, 20);
}

function truncate(text: string, maxChars = 12_000): {
  text: string;
  truncated: boolean;
} {
  if (text.length <= maxChars) return { text, truncated: false };
  return {
    text: `${text.slice(0, Math.max(0, maxChars - 48))}\n[code intelligence result truncated]`,
    truncated: true,
  };
}

export function isCodeGraphMcpServer(server: CodeIntelMcpServer): boolean {
  const name = server.name.trim().toLowerCase();
  return (
    name === CODEGRAPH_NAME ||
    name.includes(CODEGRAPH_NAME) ||
    server.tools.some((tool) => normalizeToolName(tool.name) === CODEGRAPH_EXPLORE_TOOL)
  );
}

function isSafeCodeGraphToolName(toolName: string): boolean {
  return CODEGRAPH_SAFE_TOOL_NAMES.has(normalizeToolName(toolName));
}

function detectCodeGraphMcpServer(
  servers: CodeIntelMcpServer[]
): CodeGraphCandidate | null {
  const candidates: Array<CodeGraphCandidate & { score: number }> = [];
  for (const server of servers) {
    if (server.status !== "ready") continue;
    const name = server.name.trim().toLowerCase();
    const safeTools = server.tools.filter((tool) => isSafeCodeGraphToolName(tool.name));
    const exploreTool =
      safeTools.find((tool) => normalizeToolName(tool.name) === CODEGRAPH_EXPLORE_TOOL) ??
      safeTools.find((tool) => normalizeToolName(tool.name).includes("explore"));
    if (!exploreTool) continue;
    const named = name === CODEGRAPH_NAME || name.includes(CODEGRAPH_NAME);
    candidates.push({
      server,
      tool: exploreTool,
      safeToolNames: safeTools.map((tool) => normalizeToolName(tool.name)).sort(),
      score: (named ? 100 : 0) + (normalizeToolName(exploreTool.name) === CODEGRAPH_EXPLORE_TOOL ? 50 : 0),
    });
  }
  return candidates.sort((a, b) => b.score - a.score)[0] ?? null;
}

function titleFor(op: CodeIntelOperation): string {
  switch (op) {
    case "architecture":
      return "Code intelligence architecture digest";
    case "search_symbols":
      return "Code intelligence symbol search";
    case "trace_symbol":
      return "Code intelligence symbol trace";
    case "detect_change_impact":
      return "Code intelligence change-impact digest";
  }
}

function codeGraphQuery(input: CodeIntelQuery): string {
  const query = (input.query ?? input.symbol ?? "").trim();
  const symbol = (input.symbol ?? input.query ?? "").trim();
  const paths = boundedPaths(input.paths);
  if (input.op === "architecture") {
    return (
      query ||
      "Give a concise architecture overview of this project: main entry points, important modules, routes, dependency boundaries, high-risk files, and the files most worth reading before planning changes."
    );
  }
  if (input.op === "search_symbols") {
    return `Find symbols and source snippets relevant to ${JSON.stringify(query || "the requested change")}. Return exact symbol names, file paths, and why each result matters.`;
  }
  if (input.op === "trace_symbol") {
    return `Trace callers, callees, data/control flow, and likely edit blast radius for symbol ${JSON.stringify(symbol || query || "the target symbol")}. Include relevant source snippets and call paths.`;
  }
  return `Analyze change impact and likely tests for these changed files: ${paths.length ? paths.join(", ") : "the current diff"}. Return affected symbols, call paths, risk areas, and verification suggestions.`;
}

function argsForCodeGraph(tool: CodeIntelMcpTool, input: CodeIntelQuery): Record<string, unknown> {
  const query = codeGraphQuery(input);
  const paths = boundedPaths(input.paths);
  const limit = boundedLimit(input.limit);
  return filterArgsForTool(tool, {
    query,
    question: query,
    prompt: query,
    symbol: input.symbol ?? input.query,
    paths,
    files: paths,
    changed_files: paths,
    changedFiles: paths,
    limit,
    max_results: limit,
    maxResults: limit,
    depth: Math.min(3, limit),
  });
}

function statusForCodeGraph(candidate: CodeGraphCandidate): CodeIntelStatus {
  return {
    // Keep the existing public event/schema type compatible: this means
    // "external MCP-backed code intelligence"; the detail/server fields identify CodeGraph.
    mode: "codebase-memory-mcp" as CodeIntelMode,
    available: true,
    detail: `Code intelligence via CodeGraph MCP server "${candidate.server.name}" (${candidate.tool.name}).`,
    serverName: candidate.server.name,
    tools: candidate.safeToolNames,
    capabilities: ["architecture", "search_symbols", "trace_symbol", "detect_change_impact"],
  };
}

async function runCodeGraphQuery(input: {
  bridge: CodeIntelMcpBridge;
  candidate: CodeGraphCandidate;
  query: CodeIntelQuery;
  status: CodeIntelStatus;
}): Promise<CodeIntelResult> {
  const result = await input.bridge.callTool(
    input.candidate.server.name,
    input.candidate.tool.name,
    argsForCodeGraph(input.candidate.tool, input.query)
  );
  if (result.isError) {
    throw new Error(result.text || `${input.candidate.tool.name} returned an error`);
  }
  const bounded = truncate(
    [
      `Code intelligence (${input.query.op}) via CodeGraph ${input.candidate.server.name}.${input.candidate.tool.name}.`,
      result.truncated ? "Runner reported the MCP result was truncated." : "",
      result.text,
    ]
      .filter(Boolean)
      .join("\n"),
    input.query.maxChars ?? 12_000
  );
  return {
    ok: true,
    op: input.query.op,
    mode: "codebase-memory-mcp" as CodeIntelMode,
    title: titleFor(input.query.op),
    content: bounded.text,
    status: input.status,
    serverName: input.candidate.server.name,
    toolName: input.candidate.tool.name,
    truncated: bounded.truncated || !!result.truncated,
  };
}

export function filterCodebaseMemoryMcpToolsForGenericUse<T extends CodeIntelMcpServer>(
  server: T
): T {
  if (isCodeGraphMcpServer(server)) {
    return { ...server, tools: [] };
  }
  return baseFilterCodebaseMemoryMcpToolsForGenericUse(server);
}

export function isGenericMcpToolAllowed(
  server: CodeIntelMcpServer | undefined,
  toolName: string
): boolean {
  if (server && isCodeGraphMcpServer(server)) return false;
  return baseIsGenericMcpToolAllowed(server, toolName);
}

export function createCodeIntelProvider(input: {
  mcp?: CodeIntelMcpBridge | null;
  native?: NativeCodeIntelAdapter;
}): CodeIntelProvider {
  const baseProvider = createBaseCodeIntelProvider(input);
  const candidate = input.mcp?.servers ? detectCodeGraphMcpServer(input.mcp.servers) : null;
  if (!candidate || !input.mcp) return baseProvider;

  const status = statusForCodeGraph(candidate);
  return {
    status,
    query: async (query) => {
      try {
        return await runCodeGraphQuery({
          bridge: input.mcp!,
          candidate,
          query,
          status,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : "CodeGraph code intelligence failed";
        if (!baseProvider.status.available) {
          return {
            ok: false,
            op: query.op,
            mode: "codebase-memory-mcp" as CodeIntelMode,
            title: titleFor(query.op),
            content: `Code intelligence unavailable: ${message}`,
            status,
            serverName: candidate.server.name,
            toolName: candidate.tool.name,
            error: message,
          };
        }
        const fallback = await baseProvider.query(query);
        return {
          ...fallback,
          content: [
            `CodeGraph code intelligence failed (${message}); ${fallback.mode === "native" ? "native" : "MCP"} fallback used.`,
            fallback.content,
          ].join("\n"),
          fallbackFrom: "codebase-memory-mcp" as CodeIntelMode,
          error: message,
        };
      }
    },
  };
}

export const codeIntelResultToContextPack = baseCodeIntelResultToContextPack;
