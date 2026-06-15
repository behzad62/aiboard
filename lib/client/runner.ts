/**
 * Client for the optional local command runner (scripts/runner.mjs). The user
 * starts the runner themselves and pastes its URL + token into the app — that
 * is the opt-in: no runner, no command execution. Browser-only.
 */

export interface RunnerConfig {
  url: string;
  token: string;
}

export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  truncated: boolean;
  background?: boolean;
}

export const DEFAULT_RUNNER_URL = "http://127.0.0.1:8787";

function headers(token: string): HeadersInit {
  return { "content-type": "application/json", "x-runner-token": token };
}

export async function checkRunner(
  config: RunnerConfig
): Promise<{ ok: boolean; dir?: string; platform?: string; error?: string }> {
  try {
    const res = await fetch(`${config.url.replace(/\/$/, "")}/health`, {
      headers: headers(config.token),
    });
    const data = await res.json();
    if (!res.ok) return { ok: false, error: data.error ?? `HTTP ${res.status}` };
    return {
      ok: true,
      dir: data.dir,
      platform: typeof data.platform === "string" ? data.platform : undefined,
    };
  } catch {
    return {
      ok: false,
      error: "Could not reach the runner. Is it started? (node runner.mjs <folder> — needs Node.js installed)",
    };
  }
}

/** Write a file into the runner's project folder (the real disk folder). */
export async function writeFileViaRunner(
  config: RunnerConfig,
  path: string,
  content: string
): Promise<number> {
  const res = await fetch(`${config.url.replace(/\/$/, "")}/write`, {
    method: "POST",
    headers: headers(config.token),
    body: JSON.stringify({ path, content }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `Runner write failed (HTTP ${res.status})`);
  return data.bytes ?? content.length;
}

/**
 * List the project folder's files via the runner (runner v2+).
 * Returns null when the runner doesn't support /ls (old version) or fails —
 * callers fall back to the File System Access tree.
 */
export async function listFilesViaRunner(
  config: RunnerConfig
): Promise<string[] | null> {
  try {
    const res = await fetch(`${config.url.replace(/\/$/, "")}/ls`, {
      headers: headers(config.token),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return Array.isArray(data.files) ? (data.files as string[]) : null;
  } catch {
    return null;
  }
}

/**
 * Read a project file via the runner (runner v2+). Returns null when the file
 * is missing/binary or the runner doesn't support /read.
 */
export async function readFileViaRunner(
  config: RunnerConfig,
  path: string
): Promise<string | null> {
  try {
    const res = await fetch(`${config.url.replace(/\/$/, "")}/read`, {
      method: "POST",
      headers: headers(config.token),
      body: JSON.stringify({ path }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return typeof data.content === "string" ? data.content : null;
  } catch {
    return null;
  }
}

export interface RunnerReadRangeResult {
  content: string | null;
  startLine: number;
  endLine: number;
  totalLines: number;
  truncated: boolean;
  hasMoreBefore?: boolean;
  hasMoreAfter?: boolean;
}

export async function readFileRangeViaRunner(
  config: RunnerConfig,
  path: string,
  startLine: number,
  lineCount: number
): Promise<RunnerReadRangeResult | null> {
  try {
    const res = await fetch(`${config.url.replace(/\/$/, "")}/read-range`, {
      method: "POST",
      headers: headers(config.token),
      body: JSON.stringify({ path, startLine, lineCount }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return {
      content: typeof data.content === "string" ? data.content : null,
      startLine: typeof data.startLine === "number" ? data.startLine : startLine,
      endLine: typeof data.endLine === "number" ? data.endLine : startLine - 1,
      totalLines: typeof data.totalLines === "number" ? data.totalLines : 0,
      truncated: !!data.truncated,
      hasMoreBefore: !!data.hasMoreBefore,
      hasMoreAfter: !!data.hasMoreAfter,
    };
  } catch {
    return null;
  }
}

export interface RunnerPatchOp {
  search: string;
  replace: string;
}

export interface RunnerPatchResult {
  content: string | null;
  applied: number;
  failed: number;
  failedOps?: Array<{ index: number; searchPreview: string }>;
  bytes: number;
}

export async function patchFileViaRunner(
  config: RunnerConfig,
  path: string,
  ops: RunnerPatchOp[]
): Promise<RunnerPatchResult> {
  const res = await fetch(`${config.url.replace(/\/$/, "")}/patch`, {
    method: "POST",
    headers: headers(config.token),
    body: JSON.stringify({ path, ops }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `Runner patch failed (HTTP ${res.status})`);
  return {
    content: typeof data.content === "string" ? data.content : null,
    applied: typeof data.applied === "number" ? data.applied : 0,
    failed: typeof data.failed === "number" ? data.failed : 0,
    failedOps: Array.isArray(data.failedOps)
      ? data.failedOps
          .filter(
            (op: unknown): op is { index: number; searchPreview: string } =>
              !!op &&
              typeof (op as { index?: unknown }).index === "number" &&
              typeof (op as { searchPreview?: unknown }).searchPreview ===
                "string"
          )
          .slice(0, 8)
      : undefined,
    bytes: typeof data.bytes === "number" ? data.bytes : 0,
  };
}

export interface RunnerAppendResult {
  content: string | null;
  bytes: number;
  totalBytes: number;
}

export async function appendFileViaRunner(
  config: RunnerConfig,
  path: string,
  content: string,
  reset = false
): Promise<RunnerAppendResult> {
  const res = await fetch(`${config.url.replace(/\/$/, "")}/append`, {
    method: "POST",
    headers: headers(config.token),
    body: JSON.stringify({ path, content, reset }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `Runner append failed (HTTP ${res.status})`);
  return {
    content: typeof data.content === "string" ? data.content : null,
    bytes: typeof data.bytes === "number" ? data.bytes : content.length,
    totalBytes: typeof data.totalBytes === "number" ? data.totalBytes : 0,
  };
}

export interface RunnerSearchMatch {
  path: string;
  line: number;
  text: string;
}

/**
 * Case-insensitive substring search across the project via the runner
 * (runner v2+). Returns null when unsupported or failed.
 */
export async function searchViaRunner(
  config: RunnerConfig,
  query: string
): Promise<RunnerSearchMatch[] | null> {
  try {
    const res = await fetch(`${config.url.replace(/\/$/, "")}/search`, {
      method: "POST",
      headers: headers(config.token),
      body: JSON.stringify({ query }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return Array.isArray(data.results)
      ? (data.results as RunnerSearchMatch[])
      : null;
  } catch {
    return null;
  }
}

// ── MCP bridge (runner v2+ with --mcp flags) ─────────────────────────────────

export interface McpToolInfo {
  name: string;
  description: string;
  /** JSON Schema for the tool's arguments (from tools/list), if provided. */
  inputSchema?: {
    properties?: Record<string, { type?: string }>;
    required?: string[];
  } | null;
}

export interface McpServerInfo {
  name: string;
  status: "starting" | "ready" | "error";
  error?: string | null;
  tools: McpToolInfo[];
}

/** MCP servers the runner bridges. Null when unsupported/unreachable. */
export async function listMcpServers(
  config: RunnerConfig
): Promise<McpServerInfo[] | null> {
  try {
    const res = await fetch(`${config.url.replace(/\/$/, "")}/mcp/servers`, {
      headers: headers(config.token),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return Array.isArray(data.servers) ? (data.servers as McpServerInfo[]) : null;
  } catch {
    return null;
  }
}

/** Call one MCP tool through the runner bridge. Throws on failure. */
export async function callMcpTool(
  config: RunnerConfig,
  server: string,
  tool: string,
  args: unknown
): Promise<{ text: string; isError: boolean }> {
  const res = await fetch(`${config.url.replace(/\/$/, "")}/mcp/call`, {
    method: "POST",
    headers: headers(config.token),
    body: JSON.stringify({ server, tool, args }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error ?? `MCP call failed (HTTP ${res.status})`);
  }
  return { text: data.text ?? "", isError: !!data.isError };
}

export interface RunnerFetchResult {
  status: number;
  statusText: string;
  finalUrl: string;
  contentType: string;
  text: string;
  durationMs: number;
  truncated: boolean;
}

/**
 * Fetch a public http(s) URL through the runner (runner v3+). The runner
 * refuses non-web schemes and local/private addresses, and caps the response.
 * Throws on runner/validation errors (including older runners without /fetch).
 */
export async function fetchViaRunner(
  config: RunnerConfig,
  url: string
): Promise<RunnerFetchResult> {
  const res = await fetch(`${config.url.replace(/\/$/, "")}/fetch`, {
    method: "POST",
    headers: headers(config.token),
    body: JSON.stringify({ url }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(
      data.error ??
        (res.status === 404
          ? "This runner is too old for web fetch — download the latest runner.mjs"
          : `Runner fetch failed (HTTP ${res.status})`)
    );
  }
  return {
    status: typeof data.status === "number" ? data.status : 0,
    statusText: typeof data.statusText === "string" ? data.statusText : "",
    finalUrl: typeof data.finalUrl === "string" ? data.finalUrl : url,
    contentType: typeof data.contentType === "string" ? data.contentType : "",
    text: typeof data.text === "string" ? data.text : "",
    durationMs: typeof data.durationMs === "number" ? data.durationMs : 0,
    truncated: !!data.truncated,
  };
}

export async function runCommand(
  config: RunnerConfig,
  command: string
): Promise<CommandResult> {
  const res = await fetch(`${config.url.replace(/\/$/, "")}/run`, {
    method: "POST",
    headers: headers(config.token),
    body: JSON.stringify({ command }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error ?? `Runner error (HTTP ${res.status})`);
  }
  return (await res.json()) as CommandResult;
}

/**
 * Strip ANSI escape sequences (CSI/OSC color codes etc.) from command output
 * so the Architect — and the UI preview — see plain text, not `\x1b[41m` noise.
 * Covers CSI (`ESC [ … letter`), OSC (`ESC ] … BEL/ST`), other two-char escapes,
 * and any stray bare ESC bytes.
 */
export function stripAnsi(text: string): string {
  return text
    // OSC: ESC ] ... (terminated by BEL or ST = ESC \)
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    // CSI: ESC [ params intermediates final
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
    // Other escape sequences: ESC followed by a single byte (e.g. ESC ( B)
    .replace(/\x1b[@-Z\\-_]/g, "")
    // Any remaining bare ESC
    .replace(/\x1b/g, "");
}

/** Render a command result the way the Architect sees it. */
export function formatCommandResult(
  command: string,
  result: CommandResult
): string {
  const stdout = stripAnsi(result.stdout).trim();
  const stderr = stripAnsi(result.stderr).trim();
  const parts = [
    `$ ${command}`,
    result.background
      ? `started in background (${(result.durationMs / 1000).toFixed(1)}s startup window)${result.truncated ? " — output truncated" : ""}`
      : `exit ${result.exitCode} (${(result.durationMs / 1000).toFixed(1)}s)${result.truncated ? " — output truncated" : ""}`,
  ];
  if (stdout) parts.push(`stdout:\n${stdout}`);
  if (stderr) parts.push(`stderr:\n${stderr}`);
  if (!stdout && !stderr) parts.push("(no output)");
  return parts.join("\n");
}
