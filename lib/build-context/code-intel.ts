import type { ContextPack } from "./context-packs";

export type CodeIntelOperation =
  | "architecture"
  | "search_symbols"
  | "trace_symbol"
  | "detect_change_impact";

export type CodeIntelMode = "native" | "codebase-memory-mcp";

export interface CodeIntelMcpTool {
  name: string;
  description?: string;
  inputSchema?: {
    properties?: Record<string, { type?: string }>;
    required?: string[];
  } | null;
}

export interface CodeIntelMcpServer {
  name: string;
  status: "starting" | "ready" | "error";
  error?: string | null;
  tools: CodeIntelMcpTool[];
}

export interface CodeIntelMcpToolResult {
  text: string;
  isError?: boolean;
  truncated?: boolean;
}

export interface CodeIntelMcpBridge {
  servers: CodeIntelMcpServer[];
  projectHints?: string[];
  callTool: (
    server: string,
    tool: string,
    args: Record<string, unknown>
  ) => Promise<CodeIntelMcpToolResult>;
}

export interface CodeIntelSearchMatch {
  path: string;
  line: number;
  text: string;
}

export type CodeIntelNativeSearchResult = CodeIntelSearchMatch[] | string;

export interface NativeCodeIntelAdapter {
  listFiles?: () => Promise<string[]> | string[];
  readFile?: (path: string) => Promise<string | null> | string | null;
  searchText?: (
    query: string
  ) => Promise<CodeIntelNativeSearchResult> | CodeIntelNativeSearchResult;
}

export interface CodeIntelStatus {
  mode: CodeIntelMode;
  available: boolean;
  detail: string;
  serverName?: string;
  tools: string[];
  capabilities: CodeIntelOperation[];
}

export interface CodeIntelQuery {
  op: CodeIntelOperation;
  query?: string;
  symbol?: string;
  paths?: string[];
  repoFiles?: string[];
  limit?: number;
  reason?: string;
  maxChars?: number;
}

export interface CodeIntelResult {
  ok: boolean;
  op: CodeIntelOperation;
  mode: CodeIntelMode;
  title: string;
  content: string;
  status: CodeIntelStatus;
  serverName?: string;
  toolName?: string;
  fallbackFrom?: CodeIntelMode;
  error?: string;
  truncated?: boolean;
}

export interface CodeIntelProvider {
  status: CodeIntelStatus;
  query: (input: CodeIntelQuery) => Promise<CodeIntelResult>;
}

interface CodeIntelMcpCandidate {
  server: CodeIntelMcpServer;
  tools: Map<string, CodeIntelMcpTool>;
  safeToolNames: string[];
  capabilities: CodeIntelOperation[];
}

export interface CodeIntelPhaseBudget {
  callsLeft: () => number;
  recordCall: () => boolean;
  resetPhase: () => void;
}

const OP_ORDER: CodeIntelOperation[] = [
  "architecture",
  "search_symbols",
  "trace_symbol",
  "detect_change_impact",
];

const CODEBASE_MEMORY_SERVER_NAME = "codebase-memory-mcp";
const DEFAULT_LIMIT = 8;
const MAX_LIMIT = 10;
const MAX_PATHS = 20;
const MAX_RESULT_CHARS = 12_000;
const NATIVE_ARCH_FILE_SAMPLE = 24;
const NATIVE_SEARCH_RESULTS = 12;
const LARGE_REPO_FILE_THRESHOLD = 120;

const OP_TOOL_CANDIDATES: Record<CodeIntelOperation, string[]> = {
  architecture: ["get_architecture"],
  search_symbols: [
    "search_graph",
    "search_symbols",
    "symbol_search",
    "find_symbols",
    "search_code",
  ],
  trace_symbol: [
    "trace_path",
    "trace_call_path",
    "trace_symbol",
    "find_callers",
    "find_references",
  ],
  detect_change_impact: [
    "detect_changes",
    "detect_change_impact",
    "impact_analysis",
    "analyze_impact",
  ],
};

const READ_ONLY_TOOL_NAMES = new Set([
  "get_architecture",
  "search_graph",
  "search_symbols",
  "symbol_search",
  "find_symbols",
  "search_code",
  "trace_path",
  "trace_call_path",
  "trace_symbol",
  "find_callers",
  "find_references",
  "detect_changes",
  "detect_change_impact",
  "impact_analysis",
  "analyze_impact",
  "query_graph",
  "get_graph_schema",
  "get_code_snippet",
  "list_projects",
  "index_status",
]);

const MUTATING_TOOL_PATTERNS = [
  /^index_repository$/i,
  /^delete_project$/i,
  /^manage_adr$/i,
  /^ingest_traces$/i,
  /^write/i,
  /^update/i,
  /^store/i,
  /^create/i,
  /^delete/i,
  /^remove/i,
];

export function createCodeIntelPhaseBudget(input: {
  perPhase: number;
  total: number;
}): CodeIntelPhaseBudget {
  const perPhase = Math.max(0, Math.floor(input.perPhase));
  const total = Math.max(0, Math.floor(input.total));
  let totalUsed = 0;
  let phaseUsed = 0;
  return {
    callsLeft: () => Math.max(0, Math.min(perPhase - phaseUsed, total - totalUsed)),
    recordCall: () => {
      if (phaseUsed >= perPhase || totalUsed >= total) return false;
      phaseUsed += 1;
      totalUsed += 1;
      return true;
    },
    resetPhase: () => {
      phaseUsed = 0;
    },
  };
}

function normalizeToolName(name: string): string {
  return name.trim().toLowerCase();
}

export function isReadOnlyCodeIntelToolName(name: string): boolean {
  const normalized = normalizeToolName(name);
  if (!normalized) return false;
  if (MUTATING_TOOL_PATTERNS.some((pattern) => pattern.test(normalized))) {
    return false;
  }
  return READ_ONLY_TOOL_NAMES.has(normalized);
}

export function isCodebaseMemoryMcpServer(
  server: CodeIntelMcpServer
): boolean {
  const name = server.name.trim().toLowerCase();
  if (
    name === CODEBASE_MEMORY_SERVER_NAME ||
    name.includes(CODEBASE_MEMORY_SERVER_NAME)
  ) {
    return true;
  }
  const safeToolNames = server.tools
    .map((tool) => tool.name)
    .filter(isReadOnlyCodeIntelToolName);
  return capabilitiesFromTools(safeToolNames).length >= 2;
}

export function filterCodebaseMemoryMcpToolsForGenericUse<T extends CodeIntelMcpServer>(
  server: T
): T {
  if (!isCodebaseMemoryMcpServer(server)) return server;
  return {
    ...server,
    tools: server.tools.filter((tool) => isReadOnlyCodeIntelToolName(tool.name)),
  };
}

export function isGenericMcpToolAllowed(
  server: CodeIntelMcpServer | undefined,
  toolName: string
): boolean {
  if (!server || !isCodebaseMemoryMcpServer(server)) return true;
  return isReadOnlyCodeIntelToolName(toolName);
}

function boundedLimit(limit: unknown): number {
  if (typeof limit !== "number" || !Number.isFinite(limit)) return DEFAULT_LIMIT;
  return Math.max(1, Math.min(MAX_LIMIT, Math.round(limit)));
}

function boundedPaths(paths: string[] | undefined): string[] {
  return (paths ?? [])
    .map((path) => path.trim().replace(/\\/g, "/").replace(/^\.?\//, ""))
    .filter(Boolean)
    .slice(0, MAX_PATHS);
}

function truncate(text: string, maxChars = MAX_RESULT_CHARS): {
  text: string;
  truncated: boolean;
} {
  if (text.length <= maxChars) return { text, truncated: false };
  return {
    text: `${text.slice(0, Math.max(0, maxChars - 48))}\n[code intelligence result truncated]`,
    truncated: true,
  };
}

function extensionOf(path: string): string {
  const name = path.split("/").pop() ?? path;
  const index = name.lastIndexOf(".");
  return index > 0 ? name.slice(index).toLowerCase() : "(none)";
}

function topLevelOf(path: string): string {
  return path.replace(/\\/g, "/").split("/").filter(Boolean)[0] ?? "(root)";
}

function addCount(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}

function topCounts(map: Map<string, number>, limit: number): string {
  return [...map.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([key, count]) => `${key}: ${count}`)
    .join(", ");
}

function regexEscape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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

function withCommonBounds(
  tool: CodeIntelMcpTool,
  args: Record<string, unknown>,
  limit: number
): Record<string, unknown> {
  return filterArgsForTool(tool, {
    ...args,
    limit,
    max_results: limit,
    maxResults: limit,
    offset: 0,
    depth: Math.min(3, limit),
  });
}

function capabilitiesFromTools(tools: Iterable<string>): CodeIntelOperation[] {
  const names = new Set([...tools].map(normalizeToolName));
  return OP_ORDER.filter((op) =>
    OP_TOOL_CANDIDATES[op].some((tool) => names.has(tool))
  );
}

export function detectCodeIntelMcpServer(
  servers: CodeIntelMcpServer[]
): CodeIntelMcpCandidate | null {
  const candidates: Array<CodeIntelMcpCandidate & { score: number }> = [];

  for (const server of servers) {
    if (server.status !== "ready") continue;
    const safeTools = server.tools.filter((tool) =>
      isReadOnlyCodeIntelToolName(tool.name)
    );
    const tools = new Map(
      safeTools.map((tool) => [normalizeToolName(tool.name), tool])
    );
    const capabilities = capabilitiesFromTools(tools.keys());
    const name = server.name.trim().toLowerCase();
    const named =
      name === CODEBASE_MEMORY_SERVER_NAME ||
      name.includes(CODEBASE_MEMORY_SERVER_NAME);
    const compatible = capabilities.length >= 2;
    if (!named && !compatible) continue;
    if (capabilities.length === 0) continue;

    candidates.push({
      server,
      tools,
      safeToolNames: [...tools.keys()].sort(),
      capabilities,
      score:
        (named ? 100 : 0) +
        capabilities.length * 20 +
        Math.min(10, safeTools.length),
    });
  }

  return candidates.sort((a, b) => b.score - a.score)[0] ?? null;
}

function selectTool(
  candidate: CodeIntelMcpCandidate,
  op: CodeIntelOperation
): CodeIntelMcpTool | null {
  for (const name of OP_TOOL_CANDIDATES[op]) {
    const tool = candidate.tools.get(name);
    if (tool) return tool;
  }
  return null;
}

function toolSupportsProject(tool: CodeIntelMcpTool): boolean {
  return schemaProperties(tool)?.has("project") ?? false;
}

function toolRequiresProject(tool: CodeIntelMcpTool): boolean {
  return (tool.inputSchema?.required ?? []).includes("project");
}

interface IndexedMcpProject {
  name: string;
  rootPath?: string;
  gitRoots: string[];
}

function normalizedHint(value: string): string {
  return value
    .trim()
    .replace(/\\/g, "/")
    .replace(/^file:\/\//i, "")
    .replace(/\/+$/, "")
    .replace(/\.git$/i, "")
    .toLowerCase();
}

function basename(value: string): string {
  const normalized = normalizedHint(value);
  return normalized.split("/").filter(Boolean).pop() ?? normalized;
}

function parseJsonObject(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(text.slice(start, end + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
}

function stringProp(
  value: Record<string, unknown>,
  key: string
): string | undefined {
  const raw = value[key];
  return typeof raw === "string" && raw.trim() ? raw.trim() : undefined;
}

function parseProjectsFromListProjects(text: string): IndexedMcpProject[] {
  const parsed = parseJsonObject(text);
  if (!parsed || typeof parsed !== "object") return [];
  const projects = (parsed as { projects?: unknown }).projects;
  if (!Array.isArray(projects)) return [];
  return projects
    .map((item): IndexedMcpProject | null => {
      if (!item || typeof item !== "object") return null;
      const record = item as Record<string, unknown>;
      const name = stringProp(record, "name");
      if (!name) return null;
      const rootPath =
        stringProp(record, "root_path") ??
        stringProp(record, "root") ??
        stringProp(record, "path") ??
        stringProp(record, "repo_path") ??
        stringProp(record, "repository_path");
      const git = record.git && typeof record.git === "object"
        ? (record.git as Record<string, unknown>)
        : {};
      const gitRoots = [
        stringProp(git, "canonical_root"),
        stringProp(git, "worktree_root"),
      ].filter((value): value is string => !!value);
      return { name, rootPath, gitRoots };
    })
    .filter((project): project is IndexedMcpProject => project != null);
}

function projectMatchesHints(
  project: IndexedMcpProject,
  hints: string[]
): boolean {
  const projectStrings = [
    project.name,
    project.rootPath,
    ...project.gitRoots,
  ].filter((value): value is string => !!value);
  const normalizedProjects = projectStrings.map(normalizedHint);
  const projectNames = new Set([
    normalizedHint(project.name),
    basename(project.name),
    ...projectStrings.map(basename),
  ]);

  for (const hint of hints) {
    const normalized = normalizedHint(hint);
    if (!normalized) continue;
    const hintBase = basename(normalized);
    if (
      normalizedProjects.some(
        (projectValue) =>
          projectValue === normalized ||
          normalized.endsWith(`/${projectValue}`) ||
          projectValue.endsWith(`/${normalized}`)
      )
    ) {
      return true;
    }
    if (hintBase && projectNames.has(hintBase)) return true;
  }
  return false;
}

async function resolveMcpProject(input: {
  bridge: CodeIntelMcpBridge;
  candidate: CodeIntelMcpCandidate;
}): Promise<string | null> {
  const listProjects = input.candidate.tools.get("list_projects");
  if (!listProjects) return null;
  const result = await input.bridge.callTool(
    input.candidate.server.name,
    listProjects.name,
    {}
  );
  if (result.isError) {
    throw new Error(result.text || "list_projects returned an error");
  }
  const projects = parseProjectsFromListProjects(result.text);
  if (projects.length === 0) return null;
  const hints = input.bridge.projectHints ?? [];
  const matches = projects.filter((project) => projectMatchesHints(project, hints));
  if (matches.length === 1) return matches[0].name;
  if (matches.length > 1) return null;
  return projects.length === 1 ? projects[0].name : null;
}

function argsForMcpQuery(
  tool: CodeIntelMcpTool,
  input: CodeIntelQuery,
  project: string | null
): Record<string, unknown> {
  const limit = boundedLimit(input.limit);
  const query = (input.query ?? input.symbol ?? "").trim();
  const symbol = (input.symbol ?? input.query ?? "").trim();
  const paths = boundedPaths(input.paths);
  const toolName = normalizeToolName(tool.name);
  const projectArg = project ? { project } : {};

  if (input.op === "architecture") {
    return withCommonBounds(
      tool,
      {
        ...projectArg,
        aspects: [
          "languages",
          "packages",
          "entry_points",
          "routes",
          "hotspots",
          "boundaries",
          "clusters",
        ],
      },
      limit
    );
  }

  if (input.op === "search_symbols") {
    if (toolName === "search_code") {
      return withCommonBounds(tool, { ...projectArg, pattern: query, query }, limit);
    }
    return withCommonBounds(
      tool,
      {
        ...projectArg,
        name_pattern: query ? `.*${regexEscape(query)}.*` : ".*",
        pattern: query,
        query,
      },
      limit
    );
  }

  if (input.op === "trace_symbol") {
    return withCommonBounds(
      tool,
      {
        ...projectArg,
        function_name: symbol,
        symbol,
        name: symbol,
        direction: "both",
        mode: "calls",
      },
      limit
    );
  }

  return withCommonBounds(
    tool,
    {
      ...projectArg,
      paths,
      files: paths,
      changed_files: paths,
      changedFiles: paths,
      scope: paths.length > 0 ? paths.join(",") : undefined,
      depth: Math.min(3, limit),
    },
    limit
  );
}

function statusForMcp(candidate: CodeIntelMcpCandidate): CodeIntelStatus {
  return {
    mode: "codebase-memory-mcp",
    available: true,
    detail: `Code intelligence via MCP server "${candidate.server.name}" (${candidate.capabilities.join(", ")}).`,
    serverName: candidate.server.name,
    tools: candidate.safeToolNames,
    capabilities: candidate.capabilities,
  };
}

function nativeStatus(adapter: NativeCodeIntelAdapter): CodeIntelStatus {
  const available = !!(adapter.listFiles || adapter.searchText || adapter.readFile);
  return {
    mode: "native",
    available,
    detail: available
      ? "Native code intelligence available (bounded tree/search fallback)."
      : "Code intelligence unavailable.",
    tools: [],
    capabilities: available ? [...OP_ORDER] : [],
  };
}

async function filesFor(
  adapter: NativeCodeIntelAdapter,
  input: CodeIntelQuery
): Promise<string[]> {
  if (input.repoFiles?.length) return input.repoFiles;
  return adapter.listFiles ? await adapter.listFiles() : [];
}

function formatMatches(
  results: CodeIntelNativeSearchResult,
  limit = NATIVE_SEARCH_RESULTS
): string {
  if (typeof results === "string") return results.trim() || "(no matches)";
  if (results.length === 0) return "(no matches)";
  return results
    .slice(0, limit)
    .map((match) => `${match.path}:${match.line}: ${match.text}`)
    .join("\n");
}

async function nativeSearch(
  adapter: NativeCodeIntelAdapter,
  query: string
): Promise<string> {
  if (!query.trim()) return "No query provided.";
  if (!adapter.searchText) {
    return "Native text search is unavailable in this environment.";
  }
  return formatMatches(await adapter.searchText(query));
}

function nativeArchitecture(files: string[]): string {
  const byTopLevel = new Map<string, number>();
  const byExtension = new Map<string, number>();
  for (const path of files) {
    addCount(byTopLevel, topLevelOf(path));
    addCount(byExtension, extensionOf(path));
  }
  const manifests = files.filter((path) =>
    /(^|\/)(package\.json|tsconfig\.json|next\.config\.[jt]s|vite\.config\.[jt]s|Cargo\.toml|go\.mod|pyproject\.toml|requirements\.txt|pom\.xml|build\.gradle|README\.md)$/i.test(
      path
    )
  );
  const sourceSample = files
    .filter((path) => /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|cs|cpp|c|h|css|scss)$/i.test(path))
    .slice(0, NATIVE_ARCH_FILE_SAMPLE);
  return [
    "Native code intelligence architecture digest.",
    `Files indexed by fallback: ${files.length}.`,
    `Top folders: ${topCounts(byTopLevel, 12) || "(none)"}.`,
    `Top extensions: ${topCounts(byExtension, 12) || "(none)"}.`,
    manifests.length
      ? `Detected manifests/config: ${manifests.slice(0, 20).join(", ")}.`
      : "Detected manifests/config: none in the available tree.",
    sourceSample.length
      ? `Representative source files: ${sourceSample.join(", ")}.`
      : "Representative source files: none found in the available tree.",
  ].join("\n");
}

function fileStem(path: string): string {
  const name = path.replace(/\\/g, "/").split("/").pop() ?? path;
  return name.replace(/\.[^.]+$/, "");
}

async function nativeImpact(
  adapter: NativeCodeIntelAdapter,
  input: CodeIntelQuery
): Promise<string> {
  const paths = boundedPaths(input.paths);
  const files = await filesFor(adapter, input);
  const related = new Set<string>();
  for (const changed of paths) {
    const top = topLevelOf(changed);
    for (const file of files) {
      if (topLevelOf(file) === top && file !== changed) related.add(file);
      if (related.size >= 20) break;
    }
    if (related.size >= 20) break;
  }

  const searchSections: string[] = [];
  for (const changed of paths.slice(0, 3)) {
    const stem = fileStem(changed);
    if (!stem || stem.length < 3) continue;
    searchSections.push(`References to ${stem}:\n${await nativeSearch(adapter, stem)}`);
  }

  return [
    "Native code intelligence change-impact digest.",
    paths.length
      ? `Changed files: ${paths.join(", ")}.`
      : "Changed files were not provided; impact analysis is limited.",
    related.size > 0
      ? `Nearby files sharing top-level folders: ${[...related].slice(0, 20).join(", ")}.`
      : "Nearby files sharing top-level folders: none found in the available tree.",
    ...searchSections,
  ].join("\n\n");
}

async function runNativeQuery(
  adapter: NativeCodeIntelAdapter,
  input: CodeIntelQuery,
  status: CodeIntelStatus
): Promise<CodeIntelResult> {
  const maxChars = input.maxChars ?? MAX_RESULT_CHARS;
  let content = "";
  if (input.op === "architecture") {
    content = nativeArchitecture(await filesFor(adapter, input));
  } else if (input.op === "search_symbols") {
    content = [
      "Native code intelligence symbol search.",
      await nativeSearch(adapter, (input.query ?? input.symbol ?? "").trim()),
    ].join("\n");
  } else if (input.op === "trace_symbol") {
    const symbol = (input.symbol ?? input.query ?? "").trim();
    content = [
      "Native code intelligence symbol trace.",
      "Fallback tracing is text-based; use these matches as starting points for read_range.",
      await nativeSearch(adapter, symbol),
    ].join("\n");
  } else {
    content = await nativeImpact(adapter, input);
  }
  const bounded = truncate(content, maxChars);
  return {
    ok: true,
    op: input.op,
    mode: "native",
    title: codeIntelTitle(input.op),
    content: bounded.text,
    status,
    truncated: bounded.truncated,
  };
}

function codeIntelTitle(op: CodeIntelOperation): string {
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

async function runMcpQuery(
  bridge: CodeIntelMcpBridge,
  candidate: CodeIntelMcpCandidate,
  input: CodeIntelQuery,
  status: CodeIntelStatus,
  resolveProject: () => Promise<string | null>
): Promise<CodeIntelResult> {
  const tool = selectTool(candidate, input.op);
  if (!tool) {
    throw new Error(`No read-only MCP tool is available for ${input.op}.`);
  }
  let project: string | null = null;
  if (toolSupportsProject(tool) || toolRequiresProject(tool)) {
    project = await resolveProject();
    if (!project && toolRequiresProject(tool)) {
      throw new Error("Could not resolve codebase-memory project from list_projects.");
    }
  }
  const args = argsForMcpQuery(tool, input, project);
  const result = await bridge.callTool(candidate.server.name, tool.name, args);
  if (result.isError) {
    throw new Error(result.text || `${tool.name} returned an error`);
  }
  const bounded = truncate(
    [
      `Code intelligence (${input.op}) via MCP ${candidate.server.name}.${tool.name}.`,
      result.truncated ? "Runner reported the MCP result was truncated." : "",
      result.text,
    ]
      .filter(Boolean)
      .join("\n"),
    input.maxChars ?? MAX_RESULT_CHARS
  );
  return {
    ok: true,
    op: input.op,
    mode: "codebase-memory-mcp",
    title: codeIntelTitle(input.op),
    content: bounded.text,
    status,
    serverName: candidate.server.name,
    toolName: tool.name,
    truncated: bounded.truncated || !!result.truncated,
  };
}

export function createCodeIntelProvider(input: {
  mcp?: CodeIntelMcpBridge | null;
  native?: NativeCodeIntelAdapter;
}): CodeIntelProvider {
  const native = input.native ?? {};
  const candidate = input.mcp?.servers
    ? detectCodeIntelMcpServer(input.mcp.servers)
    : null;
  if (!candidate || !input.mcp) {
    const status = nativeStatus(native);
    return {
      status,
      query: (query) => runNativeQuery(native, query, status),
    };
  }

  const status = statusForMcp(candidate);
  const fallbackStatus = nativeStatus(native);
  let projectPromise: Promise<string | null> | null = null;
  const resolveProject = (): Promise<string | null> => {
    projectPromise ??= resolveMcpProject({
      bridge: input.mcp!,
      candidate,
    });
    return projectPromise;
  };
  return {
    status,
    query: async (query) => {
      try {
        return await runMcpQuery(
          input.mcp!,
          candidate,
          query,
          status,
          resolveProject
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : "MCP code intelligence failed";
        if (!fallbackStatus.available) {
          return {
            ok: false,
            op: query.op,
            mode: "codebase-memory-mcp",
            title: codeIntelTitle(query.op),
            content: `Code intelligence unavailable: ${message}`,
            status,
            serverName: candidate.server.name,
            fallbackFrom: undefined,
            error: message,
          };
        }
        const fallback = await runNativeQuery(native, query, fallbackStatus);
        return {
          ...fallback,
          content: [
            `MCP code intelligence failed (${message}); native fallback used.`,
            fallback.content,
          ].join("\n"),
          fallbackFrom: "codebase-memory-mcp",
          error: message,
        };
      }
    },
  };
}

export function codeIntelResultToContextPack(
  result: CodeIntelResult,
  options: {
    id: string;
    title?: string;
    priority?: number;
    required?: boolean;
  }
): ContextPack | null {
  const content = result.content.trim();
  if (!content) return null;
  return {
    id: options.id,
    title: options.title ?? result.title,
    kind: "digest",
    content,
    digest: content.length > 1_200 ? `${content.slice(0, 1_200)}\n[digest truncated]` : content,
    priority: options.priority,
    required: options.required,
    exact: false,
    metadata: {
      codeIntelOp: result.op,
      codeIntelMode: result.mode,
      ...(result.serverName ? { codeIntelServer: result.serverName } : {}),
      ...(result.toolName ? { codeIntelTool: result.toolName } : {}),
      ...(result.fallbackFrom ? { codeIntelFallbackFrom: result.fallbackFrom } : {}),
      ok: result.ok,
    },
  };
}

export function shouldAutoIncludeCodeIntelArchitecture(
  files: string[],
  status: CodeIntelStatus,
  threshold = LARGE_REPO_FILE_THRESHOLD
): boolean {
  return status.available && files.length >= threshold;
}
