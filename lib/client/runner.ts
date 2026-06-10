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
}

export const DEFAULT_RUNNER_URL = "http://127.0.0.1:8787";

function headers(token: string): HeadersInit {
  return { "content-type": "application/json", "x-runner-token": token };
}

export async function checkRunner(
  config: RunnerConfig
): Promise<{ ok: boolean; dir?: string; error?: string }> {
  try {
    const res = await fetch(`${config.url.replace(/\/$/, "")}/health`, {
      headers: headers(config.token),
    });
    const data = await res.json();
    if (!res.ok) return { ok: false, error: data.error ?? `HTTP ${res.status}` };
    return { ok: true, dir: data.dir };
  } catch {
    return {
      ok: false,
      error: "Could not reach the runner. Is it started? (node scripts/runner.mjs <folder>)",
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

/** Render a command result the way the Architect sees it. */
export function formatCommandResult(
  command: string,
  result: CommandResult
): string {
  const parts = [
    `$ ${command}`,
    `exit ${result.exitCode} (${(result.durationMs / 1000).toFixed(1)}s)${result.truncated ? " — output truncated" : ""}`,
  ];
  if (result.stdout.trim()) parts.push(`stdout:\n${result.stdout.trim()}`);
  if (result.stderr.trim()) parts.push(`stderr:\n${result.stderr.trim()}`);
  if (!result.stdout.trim() && !result.stderr.trim()) parts.push("(no output)");
  return parts.join("\n");
}
