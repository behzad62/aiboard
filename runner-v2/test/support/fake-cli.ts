/**
 * Fake CLIs for CLI worker tests (packet CW2): `node fake-cli.mjs <the CLI's argv>` with AIBOARD_FAKE_CLI_SCENARIO
 * naming a scenario file. fake-cli.mjs documents the scenario's fields, and why on Windows a test injects
 * `[process.execPath, FAKE_CLI_SCRIPT]` where the resolved CLI would go rather than hiding the fake behind a `.cmd`.
 */
import { execFile } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { promisify } from "node:util";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const FAKE_CLI_SCRIPT = fileURLToPath(new URL("./fake-cli.mjs", import.meta.url));
export const CLI_FIXTURES = fileURLToPath(new URL("../fixtures/cli-workers/", import.meta.url));
export const FAKE_CLI_SCENARIO_ENV = "AIBOARD_FAKE_CLI_SCENARIO";
const execFileAsync = promisify(execFile);

export interface FakeCliResponse {
  args: string[];
  stdout?: string;
  stderr?: string;
  exitCode?: number;
}

export interface FakeCliScenario {
  cli: "codex-cli" | "claude-code" | "agy";
  responses?: FakeCliResponse[];
  expectArgs?: string[];
  stdout?: string;
  stderr?: string;
  outputFile?: string;
  exitCode?: number;
  lineDelayMs?: number;
  holdMs?: number;
  grandchildMs?: number;
  /** Spawn the grandchild detached; on Windows the only form that outlives the fake (fake-cli.mjs says why). */
  grandchildDetached?: boolean;
  /** `codexBackground`: Windows only, CW0's escape shape through the shell Codex would pick (fake-cli.mjs, §3.11c). */
  actions?: Array<{ write: string; content?: string } | { commit: string } | { run: string[] } | { codexBackground: number }>;
  record?: string;
  /** The record carries `AIBOARD_MCP_DEPTH`, the only environment variable the fake writes down. */
  recordMcpDepth?: boolean;
  /** The record names where each of these resolves on the fake's own PATH (`resolved`). */
  recordResolution?: string[];
  /** The record says whether each of these is set in the fake's environment (`sensitivePresent`), never its value. */
  recordSensitive?: string[];
}

/** What the fake wrote to `record`. */
export interface FakeCliRecord {
  argv: string[];
  stdin: string;
  cwd: string;
  grandchildPid?: number;
  /** The token in the grandchild's command line, so a test tells it from a later process given the same ID. */
  grandchildToken?: string;
  mcpDepth?: string | null;
  /** The `run` actions' commands, in order, with their exit codes and output. */
  runs?: Array<{ args: string[]; exitCode: number | null; stdout: string; stderr: string }>;
  /** The first `codexBackground` action: the shell the fake picked as Codex would, and the background node it started. */
  codexShell?: {
    shell: string; exitCode: number | null; backgroundPid?: number; backgroundToken: string;
    /** The background node wrote its marker: it really ran, so its absence after the stop is the stop's doing. */
    backgroundStarted: boolean;
    stderr?: string;
  };
  resolved?: Record<string, string | null>;
  sensitivePresent?: Record<string, boolean>;
}

/**
 * Whether the fake's grandchild still runs. Windows can give a freed process ID to a later process within seconds, so
 * on Windows an ID that still answers counts only when that process's command line carries the grandchild's token (CI
 * run 44515741684: after a proven stop the ID still answered). A grandchild that really outlived the stop still counts,
 * and a query that fails throws rather than calling it stopped. POSIX hands out IDs in sequence, so there the ID decides.
 */
export async function fakeGrandchildAlive(record: FakeCliRecord): Promise<boolean> {
  const pid = record.grandchildPid;
  if (!pid) throw new Error("The fake recorded no grandchild.");
  if (process.platform === "win32" && !record.grandchildToken) throw new Error("The fake recorded no grandchild token.");
  return await fakeProcessAlive(pid, record.grandchildToken ?? "");
}

/** As fakeGrandchildAlive, for any process the fake started whose command line carries `token` (the codexBackground node). */
export async function fakeProcessAlive(pid: number, token: string): Promise<boolean> {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  if (process.platform !== "win32") return true;
  if (!token) throw new Error("No token to tell the fake's process from a later one.");
  // Async, so a slow query never blocks the event loop.
  const { stdout } = await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
    `Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}' -ErrorAction Stop | Select-Object Name, CommandLine | ConvertTo-Json -Compress`],
  { encoding: "utf8", windowsHide: true });
  const found = stdout.trim() ? JSON.parse(stdout) as { Name?: string | null; CommandLine?: string | null } : undefined;
  if (found?.CommandLine?.includes(token)) return true;
  // Which of the two it was (a later process on the ID, or the grandchild gone between the calls), for the CI log. Only
  // the name: another process's command line may hold anything.
  const holder = !found ? "no process" : `${JSON.stringify(found.Name ?? "an unnamed process")}${found.CommandLine ? "" : " (command line unreadable)"}`;
  console.error(`fakeProcessAlive: ID ${pid} answered without the token; it now holds ${holder}`);
  return false;
}

/** A fixture's path; scenario paths may be absolute, so tests point straight into the fixtures folder. */
export function cliFixture(relative: string): string {
  return join(CLI_FIXTURES, relative);
}

/** Reads a fixture as text, with its line endings as recorded (LF). */
export function readCliFixture(relative: string): string {
  return readFileSync(cliFixture(relative), "utf8");
}

/** Writes a scenario into `directory` and returns its path, for AIBOARD_FAKE_CLI_SCENARIO. */
export function writeFakeCliScenario(directory: string, scenario: FakeCliScenario, name = "fake-cli-scenario.json"): string {
  const path = join(directory, name);
  writeFileSync(path, JSON.stringify(scenario, null, 2));
  return path;
}
