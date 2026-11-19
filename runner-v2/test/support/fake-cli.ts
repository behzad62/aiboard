/**
 * Fake CLIs for CLI worker tests (packet CW2): `node fake-cli.mjs <the CLI's argv>` with AIBOARD_FAKE_CLI_SCENARIO
 * naming a scenario file. fake-cli.mjs documents the scenario's fields, and why on Windows a test injects
 * `[process.execPath, FAKE_CLI_SCRIPT]` where the resolved CLI would go rather than hiding the fake behind a `.cmd`.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const FAKE_CLI_SCRIPT = fileURLToPath(new URL("./fake-cli.mjs", import.meta.url));
export const CLI_FIXTURES = fileURLToPath(new URL("../fixtures/cli-workers/", import.meta.url));
export const FAKE_CLI_SCENARIO_ENV = "AIBOARD_FAKE_CLI_SCENARIO";

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
  actions?: Array<{ write: string; content?: string } | { commit: string } | { run: string[] }>;
  record?: string;
  /** The record carries `AIBOARD_MCP_DEPTH`, the only environment variable the fake writes down. */
  recordMcpDepth?: boolean;
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
}

/**
 * Whether the fake's grandchild still runs. Windows gives a freed process ID to the next process at once, so on Windows
 * an ID that still answers counts only when that process's command line carries the grandchild's token (CI run
 * 44515741684: after a proven stop the ID still answered). A grandchild that really outlived the stop still counts.
 * POSIX hands out IDs in sequence, so there the ID decides.
 */
export function fakeGrandchildAlive(record: FakeCliRecord): boolean {
  const pid = record.grandchildPid;
  if (!pid) throw new Error("The fake recorded no grandchild.");
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  if (process.platform !== "win32") return true;
  if (!record.grandchildToken) throw new Error("The fake recorded no grandchild token.");
  const commandLine = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
    `(Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}').CommandLine`], { encoding: "utf8", windowsHide: true });
  return commandLine.includes(record.grandchildToken);
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
