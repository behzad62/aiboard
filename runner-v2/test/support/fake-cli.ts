/**
 * Fake CLIs for CLI worker tests (packet CW2): `node fake-cli.mjs <the CLI's argv>` with AIBOARD_FAKE_CLI_SCENARIO
 * naming a scenario file. fake-cli.mjs documents the scenario's fields.
 */
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
  record?: string;
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
