import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  CLAUDE_CODE_EFFORTS,
  CLI_STREAM_LINE_MAX_CHARS,
  CLI_WORKER_ADAPTERS,
  WINDOWS_BATCH_SHIM_UNSAFE_ARGUMENT,
  agyQuotaFailure,
  buildAgyArgs,
  buildClaudeCodeArgs,
  buildCliWorkerArgs,
  buildCliWorkerPrompt,
  buildCliWorkerStdin,
  buildCodexArgs,
  cliExecutableMissingFailure,
  cliWorkerPlatformRefusal,
  cliWorkerRootRefusal,
  parseAgyModels,
  parseAgyModelsLogin,
  parseAgyQuota,
  parseClaudeAuthStatus,
  parseCliVersionOutput,
  parseCodexDebugModels,
  parseCodexLoginStatus,
  resolveCliExecutable,
  windowsBatchShimRefusedArguments,
  type CliProbeOutput,
  type CliRunInput,
  type CliRunReading,
} from "../src/cli-worker-adapters.js";
import { CLI_WORKER_PROVIDER_IDS, isCliArgumentValue, scrubCliMessage, type CliWorkerProviderId } from "../src/cli-worker-config.js";
import { classifyCliFailureText, fixedOffsetLocalClock, statedResetFromText, type CliFailureKind, type LocalClock } from "../src/cli-worker-failures.js";
import { CLI_RESULT_LIMITS, CLI_WORKER_RESULT_SCHEMA, cliWorkerResultSchemaJson, parseCliWorkerResult, parseCliWorkerResultText } from "../src/cli-worker-result.js";
import { MODEL_CATALOG_SNAPSHOT } from "../src/generated/model-catalog.js";
import type { CheckToolLookup } from "../src/check-tool-lookup.js";
import { CLI_FIXTURES, FAKE_CLI_SCENARIO_ENV, FAKE_CLI_SCRIPT, cliFixture, readCliFixture, writeFakeCliScenario, type FakeCliRecord } from "./support/fake-cli.js";

/** Fixture readers accept LF or CRLF: every run below is also read with its line endings turned into CRLF. */
const crlf = (text: string) => text.replace(/\r?\n/g, "\r\n");
/** A fixture that must exist: a missing one fails the test instead of reading as empty output. */
const fixture = (relative: string) => readCliFixture(relative);
/** A part that a run may not have (stderr, Codex's -o file). */
const optionalFixture = (relative: string) => existsSync(cliFixture(relative)) ? readCliFixture(relative) : "";
/** The synthetic fixtures' resets are Unix 4102444800 (2100-01-01); "now" one hour before reads them as stated. */
const HOUR_BEFORE_2100 = (4102444800 - 3600) * 1000;
const NOW = Date.parse("2026-11-17T12:00:00.000Z");
const CANARIES = ["canary@example.test", "00000000-0000-4000-8000-000000000000", "Canary Org", "2099-01-01T00:00:00.000Z", "loginExpiresAt", "credential_expires_at", "orgId", "orgName", "email"];

function read(cli: CliWorkerProviderId, input: CliRunInput, lineEndings: "lf" | "crlf" = "lf"): CliRunReading {
  const adapter = CLI_WORKER_ADAPTERS[cli];
  return adapter.readRun(lineEndings === "lf" ? input : { ...input, stdout: crlf(input.stdout), ...(input.stderr ? { stderr: crlf(input.stderr) } : {}) });
}

interface RunCase {
  name: string;
  cli: CliWorkerProviderId;
  /** `<cli>/<case>.<os|synthetic>`; the parts are read from the fixture folder, and its stdout part must exist. */
  base?: string;
  /** A run written out here, for a probe no fixture holds (what a CLI printed while the Runner stopped it). */
  inline?: { stdout: string; stderr?: string; outputFile?: string };
  exitCode: number | null;
  stdoutPart?: "stdout.jsonl" | "stdout.json";
  stoppedBy?: "deadline" | "cancelled";
  now?: number;
  expect:
    | { type: "result"; outcome: "done" | "needs_decision" | "cannot_do" }
    | { type: "failure"; kind: CliFailureKind; reason?: "cli_error" | "no_result" | "unreadable_result"; retryAfterMs?: number | "none"; message?: RegExp }
    | { type: "stopped"; reason: "deadline" | "cancelled" };
  sessionId?: string;
}

const CODEX_THREAD = '{"type":"thread.started","thread_id":"00000000-0000-7000-8000-0000000c0de2"}';
const RECONNECT_401 = '{"type":"error","message":"Reconnecting... 1/5 (unexpected status 401 Unauthorized: Missing bearer or basic authentication in header, url: wss://api.openai.com/v1/responses)"}';
/** A recorded Codex stream with one notice after its thread.started line. */
function withCodexNotice(relative: string, notice: string): string {
  const lines = readCliFixture(relative).split("\n");
  return [lines[0], notice, ...lines.slice(1)].join("\n");
}

function runInput(entry: RunCase): CliRunInput {
  const common = {
    exitCode: entry.exitCode,
    ...(entry.stoppedBy ? { stoppedBy: entry.stoppedBy } : {}),
    now: entry.now ?? NOW,
  };
  if (entry.inline) {
    return { stdout: entry.inline.stdout, stderr: entry.inline.stderr ?? "", ...(entry.inline.outputFile !== undefined ? { outputFile: entry.inline.outputFile } : {}), ...common };
  }
  assert.ok(entry.base, `${entry.name} names no fixture`);
  const part = entry.stdoutPart ?? (existsSync(cliFixture(`${entry.base}.stdout.jsonl`)) ? "stdout.jsonl" : "stdout.json");
  const outputFile = entry.cli === "codex-cli" && existsSync(cliFixture(`${entry.base}.last-message.json`))
    ? readFileSync(cliFixture(`${entry.base}.last-message.json`)) : undefined;
  return {
    stdout: fixture(`${entry.base}.${part}`),
    stderr: optionalFixture(`${entry.base}.stderr.txt`),
    exitCode: entry.exitCode,
    ...(outputFile !== undefined ? { outputFile } : {}),
    ...(entry.stoppedBy ? { stoppedBy: entry.stoppedBy } : {}),
    now: entry.now ?? NOW,
  };
}

/**
 * Every §3.8 row, pinned on a fixture: recorded CW0 output where it exists, a `*.synthetic.*` fixture where none
 * does (the README says what each is modelled on).
 */
const RUNS: RunCase[] = [
  // Results.
  { name: "Codex success", cli: "codex-cli", base: "codex-cli/success.windows", exitCode: 0, expect: { type: "result", outcome: "done" }, sessionId: "01a1e9c2-d41e-7543-ba78-0ce6501b9a8f" },
  { name: "Codex success (Linux)", cli: "codex-cli", base: "codex-cli/success.linux", exitCode: 0, expect: { type: "result", outcome: "done" } },
  { name: "Codex needs-decision", cli: "codex-cli", base: "codex-cli/needs-decision.windows", exitCode: 0, expect: { type: "result", outcome: "needs_decision" } },
  { name: "Codex resume", cli: "codex-cli", base: "codex-cli/resume.windows", exitCode: 0, expect: { type: "result", outcome: "done" }, sessionId: "01a1e9c2-d41e-7543-ba78-0ce6501b9a8f" },
  { name: "Codex background", cli: "codex-cli", base: "codex-cli/background-escaped.windows", exitCode: 0, expect: { type: "result", outcome: "done" } },
  { name: "Claude Code success", cli: "claude-code", base: "claude-code/success.windows", exitCode: 0, expect: { type: "result", outcome: "done" }, sessionId: "3139a957-fc06-44f1-bbe3-d651f906244f" },
  { name: "Claude Code success (Linux)", cli: "claude-code", base: "claude-code/success.linux", exitCode: 0, expect: { type: "result", outcome: "done" } },
  { name: "Claude Code needs-decision", cli: "claude-code", base: "claude-code/needs-decision.windows", exitCode: 0, expect: { type: "result", outcome: "needs_decision" } },
  { name: "Claude Code resume", cli: "claude-code", base: "claude-code/resume.windows", exitCode: 0, expect: { type: "result", outcome: "done" }, sessionId: "3139a957-fc06-44f1-bbe3-d651f906244f" },
  // The result event ends the turn while a background task keeps the process up: the reading has the result with no exit.
  { name: "Claude Code stream-json background", cli: "claude-code", base: "claude-code/background-streamjson.windows", exitCode: null, stoppedBy: "deadline", expect: { type: "result", outcome: "done" }, sessionId: "8aadb5b0-b06a-4394-9b2f-f42614de8239" },
  { name: "agy success", cli: "agy", base: "agy/success.windows", exitCode: 0, expect: { type: "result", outcome: "done" }, sessionId: "0b24ca58-5362-4e0c-bf3d-aa39b24c4a33" },
  { name: "agy needs-decision", cli: "agy", base: "agy/needs-decision.windows", exitCode: 0, expect: { type: "result", outcome: "needs_decision" } },
  { name: "agy resume", cli: "agy", base: "agy/resume.windows", exitCode: 0, expect: { type: "result", outcome: "done" }, sessionId: "0b24ca58-5362-4e0c-bf3d-aa39b24c4a33" },
  { name: "agy background", cli: "agy", base: "agy/background.windows", exitCode: 0, expect: { type: "result", outcome: "done" } },
  { name: "agy json output", cli: "agy", base: "agy/literal-dash-prompt.windows", exitCode: 0, expect: { type: "result", outcome: "done" } },

  // §3.8 usage_limit.
  { name: "Codex usage limit (owner-log prose, no reset)", cli: "codex-cli", base: "codex-cli/usage-limit.synthetic", exitCode: 1, expect: { type: "failure", kind: "usage_limit", reason: "cli_error", retryAfterMs: "none", message: /usage limit/ } },
  { name: "Codex usage limit with a stated duration", cli: "codex-cli", base: "codex-cli/usage-limit-stated-reset.synthetic", exitCode: 1, expect: { type: "failure", kind: "usage_limit", retryAfterMs: (3 * 60 + 12) * 60_000 } },
  { name: "agy exit 3 with Resets in 4h53m36s", cli: "agy", base: "agy/usage-limit.synthetic", exitCode: 3, expect: { type: "failure", kind: "usage_limit", retryAfterMs: ((4 * 60 + 53) * 60 + 36) * 1000 } },
  { name: "agy weekly cap 162h13m35s", cli: "agy", base: "agy/usage-limit-weekly.synthetic", exitCode: 3, expect: { type: "failure", kind: "usage_limit", retryAfterMs: ((162 * 60 + 13) * 60 + 35) * 1000 } },
  { name: "Claude Code rejected rate_limit_event and its resetsAt", cli: "claude-code", base: "claude-code/usage-limit.synthetic", exitCode: 1, now: HOUR_BEFORE_2100, expect: { type: "failure", kind: "usage_limit", retryAfterMs: 3_600_000 } },
  { name: "Claude Code usage-limit message with unix seconds", cli: "claude-code", base: "claude-code/usage-limit-result-only.synthetic", exitCode: 1, now: HOUR_BEFORE_2100, expect: { type: "failure", kind: "usage_limit", retryAfterMs: 3_600_000 } },
  // A reset further than 31 days away is a misparse, never a cooldown: 2100 seen from 2026 sets none.
  { name: "Claude Code usage limit, reset too far to trust", cli: "claude-code", base: "claude-code/usage-limit.synthetic", exitCode: 1, expect: { type: "failure", kind: "usage_limit", retryAfterMs: "none" } },

  // §3.8 authentication: not logged in.
  { name: "Codex logged out (401 after reconnects)", cli: "codex-cli", base: "codex-cli/logged-out.linux", exitCode: 1, expect: { type: "failure", kind: "authentication", reason: "cli_error", message: /401/ } },
  { name: "Claude Code Not logged in (json)", cli: "claude-code", base: "claude-code/logged-out.linux", exitCode: 1, expect: { type: "failure", kind: "authentication", message: /Not logged in/ } },
  { name: "Claude Code Not logged in (stream-json)", cli: "claude-code", base: "claude-code/free/logged-out-streamjson.linux", stdoutPart: "stdout.jsonl", exitCode: 1, expect: { type: "failure", kind: "authentication" } },
  { name: "agy logged out", cli: "agy", base: "agy/logged-out.synthetic", exitCode: 1, expect: { type: "failure", kind: "authentication" } },
  { name: "Claude Code as root", cli: "claude-code", base: "claude-code/root-refuses-skip-permissions.linux", exitCode: 1, expect: { type: "failure", kind: "authentication", message: /root/ } },

  // §3.8 authentication: the model is not available.
  { name: "Codex model not supported (its metadata warning alone is not the failure)", cli: "codex-cli", base: "codex-cli/model-unavailable.windows", exitCode: 1, expect: { type: "failure", kind: "authentication", message: /not supported when using Codex/ } },
  { name: "Claude Code 404 not_found_error", cli: "claude-code", base: "claude-code/model-unavailable.windows", exitCode: 1, expect: { type: "failure", kind: "authentication", message: /selected model/ } },
  { name: "agy invalid model selection", cli: "agy", base: "agy/model-unavailable.windows", exitCode: 1, expect: { type: "failure", kind: "authentication", message: /invalid model selection/ } },

  // §3.8 rate_limit and provider_unavailable.
  { name: "Codex 429", cli: "codex-cli", base: "codex-cli/rate-limit.synthetic", exitCode: 1, expect: { type: "failure", kind: "rate_limit", retryAfterMs: "none" } },
  { name: "Claude Code 429", cli: "claude-code", base: "claude-code/rate-limit.synthetic", exitCode: 1, expect: { type: "failure", kind: "rate_limit", retryAfterMs: "none" } },
  { name: "agy 429", cli: "agy", base: "agy/rate-limit.synthetic", exitCode: 3, expect: { type: "failure", kind: "rate_limit" } },
  { name: "Codex 503", cli: "codex-cli", base: "codex-cli/server-error.synthetic", exitCode: 1, expect: { type: "failure", kind: "provider_unavailable" } },
  { name: "Claude Code 529 overloaded", cli: "claude-code", base: "claude-code/overloaded.synthetic", exitCode: 1, expect: { type: "failure", kind: "provider_unavailable" } },
  { name: "agy 503 overloaded", cli: "agy", base: "agy/server-error.synthetic", exitCode: 3, expect: { type: "failure", kind: "provider_unavailable" } },

  // §3.8 transient: a crash, a non-zero exit with no result, an unreadable result.
  { name: "Codex killed, -o 0 bytes, no Runner stop recorded", cli: "codex-cli", base: "codex-cli/killed.windows", exitCode: null, expect: { type: "failure", kind: "transient", reason: "no_result" } },
  { name: "Claude Code killed, nothing printed", cli: "claude-code", base: "claude-code/killed.windows", exitCode: null, expect: { type: "failure", kind: "transient", reason: "no_result" } },
  { name: "agy killed mid-stream", cli: "agy", base: "agy/killed.windows", exitCode: null, expect: { type: "failure", kind: "transient", reason: "no_result" } },
  { name: "agy argument error, exit 2", cli: "agy", base: "agy/argv-prompt-flag-error.windows", exitCode: 2, expect: { type: "failure", kind: "transient", reason: "no_result" } },
  { name: "agy stream input refused", cli: "agy", base: "agy/stream-input-missing-event.windows", exitCode: 1, expect: { type: "failure", kind: "transient", reason: "cli_error" } },

  // §3.8 the attempt's deadline or a cancelled Build: not a provider failure.
  { name: "Codex killed at the deadline", cli: "codex-cli", base: "codex-cli/killed.linux", exitCode: null, stoppedBy: "deadline", expect: { type: "stopped", reason: "deadline" } },
  { name: "Claude Code hang stopped at the deadline (json mode prints nothing)", cli: "claude-code", base: "claude-code/background-hang.windows", exitCode: null, stoppedBy: "deadline", expect: { type: "stopped", reason: "deadline" } },
  { name: "agy cancelled", cli: "agy", base: "agy/killed.windows", exitCode: null, stoppedBy: "cancelled", expect: { type: "stopped", reason: "cancelled" } },
  // The Runner's own stop wins over anything the CLI printed while being stopped: never a provider failure.
  { name: "Codex cancelled after a recovered 503 reconnect", cli: "codex-cli", exitCode: null, stoppedBy: "cancelled", expect: { type: "stopped", reason: "cancelled" },
    inline: { stdout: `${CODEX_THREAD}\n{"type":"turn.started"}\n{"type":"error","message":"Reconnecting... 1/5 (unexpected status 503 Service Unavailable, url: https://api.openai.com/v1/responses)"}\n`, outputFile: "" } },
  { name: "Codex cancelled: Turn interrupted", cli: "codex-cli", exitCode: 1, stoppedBy: "cancelled", expect: { type: "stopped", reason: "cancelled" },
    inline: { stdout: `${CODEX_THREAD}\n{"type":"turn.started"}\n{"type":"turn.failed","error":{"message":"Turn interrupted"}}\n`, outputFile: "" } },
  // stoppedBy's contract: set only when the turn had not ended as the signal went out, so this turn.failed came while
  // Codex was being stopped. A turn that ended first is read by itself (the contract test below).
  { name: "Codex at the deadline, turn.failed printed while being stopped", cli: "codex-cli", exitCode: 1, stoppedBy: "deadline", expect: { type: "stopped", reason: "deadline" },
    inline: { stdout: `${CODEX_THREAD}\n{"type":"turn.failed","error":{"message":"You've hit your usage limit."}}\n`, outputFile: "" } },
  { name: "Claude Code at the deadline: Request was aborted.", cli: "claude-code", exitCode: null, stoppedBy: "deadline", expect: { type: "stopped", reason: "deadline" },
    inline: { stdout: '{"type":"result","is_error":true,"result":"Request was aborted."}\n' } },
  { name: "Claude Code cancelled with a rejected rate_limit_event", cli: "claude-code", base: "claude-code/usage-limit.synthetic", exitCode: null, stoppedBy: "cancelled", now: HOUR_BEFORE_2100, expect: { type: "stopped", reason: "cancelled" } },
  { name: "agy cancelled with a 429 on stderr", cli: "agy", exitCode: null, stoppedBy: "cancelled", expect: { type: "stopped", reason: "cancelled" },
    inline: { stdout: "", stderr: "error: model request failed: 429 Too Many Requests\n" } },
  { name: "agy cancelled: context canceled", cli: "agy", exitCode: 1, stoppedBy: "cancelled", expect: { type: "stopped", reason: "cancelled" },
    inline: { stdout: '{"event":"result","result":{"conversation_id":"","status":"ERROR","response":"","error":"context canceled"}}\n' } },
  // A result the CLI delivered before the stop still counts (Claude Code's background run above does the same).
  { name: "agy result delivered, then cancelled", cli: "agy", base: "agy/success.windows", exitCode: null, stoppedBy: "cancelled", expect: { type: "result", outcome: "done" } },
  // A recovered reconnect says nothing about the run: never a 24-hour authentication cooldown.
  { name: "Codex recovered 401 reconnect, then a result", cli: "codex-cli", exitCode: 0, expect: { type: "result", outcome: "done" },
    inline: { stdout: withCodexNotice("codex-cli/success.windows.stdout.jsonl", RECONNECT_401), outputFile: optionalFixture("codex-cli/success.windows.last-message.json") } },
  { name: "Codex recovered 401 reconnect, then an unrelated turn.failed", cli: "codex-cli", exitCode: 1, expect: { type: "failure", kind: "transient", reason: "cli_error", message: /stream disconnected/ },
    inline: { stdout: `${CODEX_THREAD}\n{"type":"turn.started"}\n${RECONNECT_401}\n{"type":"turn.failed","error":{"message":"stream disconnected before completion: transport error"}}\n`, outputFile: "" } },
  { name: "Codex recovered 401 reconnect, then killed without a stop recorded", cli: "codex-cli", exitCode: null, expect: { type: "failure", kind: "transient", reason: "no_result" },
    inline: { stdout: `${CODEX_THREAD}\n{"type":"turn.started"}\n${RECONNECT_401}\n`, outputFile: "" } },
];

for (const entry of RUNS) {
  test(`run reading: ${entry.name}`, () => {
    const input = runInput(entry);
    const reading = read(entry.cli, input);
    const { expect } = entry;
    assert.equal(reading.outcome.type, expect.type, JSON.stringify(reading.outcome));
    if (expect.type === "result" && reading.outcome.type === "result") assert.equal(reading.outcome.result.outcome, expect.outcome);
    if (expect.type === "stopped" && reading.outcome.type === "stopped") assert.equal(reading.outcome.reason, expect.reason);
    if (expect.type === "failure" && reading.outcome.type === "failure") {
      assert.equal(reading.outcome.failure.kind, expect.kind, reading.outcome.failure.message);
      if (expect.reason) assert.equal(reading.outcome.reason, expect.reason);
      if (expect.retryAfterMs === "none") assert.equal(reading.outcome.failure.retryAfterMs, undefined);
      else if (expect.retryAfterMs !== undefined) assert.equal(reading.outcome.failure.retryAfterMs, expect.retryAfterMs);
      if (expect.message) assert.match(reading.outcome.failure.message, expect.message);
      assert.ok(reading.outcome.failure.message.length <= 300);
    }
    if (entry.sessionId) assert.equal(reading.sessionId, entry.sessionId);
    for (const canary of CANARIES) assert.ok(!JSON.stringify(reading).includes(canary), `${canary} left the parser`);
    // The same bytes with CRLF line endings read the same.
    assert.deepEqual(read(entry.cli, input, "crlf"), reading);
  });
}

test("every case reads a fixture that exists, and every recorded and synthetic run fixture is read by some case", () => {
  // Case → fixture: a case names a fixture or writes its run inline, never both, and its stdout part exists, so no
  // case passes on empty output by a misspelt name.
  for (const entry of RUNS) {
    assert.equal(Boolean(entry.base) !== Boolean(entry.inline), true, `${entry.name}: a fixture or an inline run`);
    if (!entry.base) continue;
    const parts = entry.stdoutPart ? [entry.stdoutPart] : ["stdout.jsonl", "stdout.json"];
    assert.equal(parts.filter((part) => existsSync(cliFixture(`${entry.base}.${part}`))).length, 1, `${entry.name}: ${entry.base} has no stdout fixture`);
  }
  // Fixture → case.
  const covered = new Set(RUNS.map((entry) => entry.base));
  const bases = new Set<string>();
  for (const folder of CLI_WORKER_PROVIDER_IDS.flatMap((cli) => [cli, `${cli}/free`])) {
    if (!existsSync(join(CLI_FIXTURES, folder))) continue;
    for (const name of readdirSync(join(CLI_FIXTURES, folder))) {
      const match = /^(.+)\.(?:stdout\.jsonl?)$/.exec(name);
      if (match) bases.add(`${folder}/${match[1]}`);
    }
  }
  assert.ok(bases.has("claude-code/free/logged-out-streamjson.linux"), "the free/ folders are scanned");
  const unread = [...bases].filter((base) => !covered.has(base));
  // background-escaped-run2 and background.linux repeat background-escaped's result shape; background-hang.linux and
  // success-before-signal.linux are read below.
  assert.deepEqual(unread.sort(), ["claude-code/background-hang.linux", "claude-code/success-before-signal.linux", "codex-cli/background-escaped-run2.windows", "codex-cli/background.linux"]);
  for (const base of unread) {
    const cli = base.split("/")[0] as CliWorkerProviderId;
    const reading = read(cli, runInput({ name: base, cli, base, exitCode: 0, expect: { type: "result", outcome: "done" } }));
    if (base === "claude-code/background-hang.linux") assert.equal(reading.outcome.type, "failure");
    else assert.equal(reading.outcome.type, "result", base);
  }
});

test("stoppedBy's contract: a failure the CLI delivered before the Runner's stop is read by itself", () => {
  const limit = fixture("claude-code/usage-limit.synthetic.stdout.jsonl");
  const resultAt = limit.indexOf('{"duration_api_ms"');
  // Claude Code delivers its is_error usage-limit result; a background task keeps it up; then the deadline fires.
  const ended = CLI_WORKER_ADAPTERS["claude-code"].createStreamReader();
  ended.push(limit);
  assert.equal(ended.turnEnded, true);
  assert.equal(ended.noteRunnerStop("deadline"), false, "the turn had ended: the stop is not recorded");
  const delivered = ended.read({ exitCode: null, now: HOUR_BEFORE_2100 });
  assert.deepEqual(delivered.outcome.type === "failure" && [delivered.outcome.failure.kind, delivered.outcome.failure.retryAfterMs], ["usage_limit", 3_600_000]);
  // The same bytes when the deadline went out mid-turn: the stop is recorded, and what followed reads as stopped.
  const midTurn = CLI_WORKER_ADAPTERS["claude-code"].createStreamReader();
  midTurn.push(limit.slice(0, resultAt));
  assert.equal(midTurn.noteRunnerStop("deadline"), true);
  midTurn.push(limit.slice(resultAt));
  assert.deepEqual(midTurn.read({ exitCode: null, now: HOUR_BEFORE_2100 }).outcome, { type: "stopped", reason: "deadline" });
  // A noted stop wins over the caller's field; a stop noted twice keeps the first reason.
  const agy = CLI_WORKER_ADAPTERS.agy.createStreamReader();
  agy.noteRunnerStop("cancelled");
  agy.noteRunnerStop("deadline");
  agy.push('{"event":"result","result":{"conversation_id":"","status":"ERROR","response":"","error":"context canceled"}}\n');
  assert.deepEqual(agy.read({ exitCode: 1, now: NOW }).outcome, { type: "stopped", reason: "cancelled" });
  // A Codex turn that failed before the stop is the same: the caller following the contract passes no stoppedBy.
  const codex = CLI_WORKER_ADAPTERS["codex-cli"].createStreamReader();
  codex.push('{"type":"turn.failed","error":{"message":"You\'ve hit your usage limit."}}\n');
  assert.equal(codex.noteRunnerStop("deadline"), false);
  assert.equal(codex.read({ exitCode: 1, outputFile: "", now: NOW }).outcome.type, "failure");
});

test("a status code counts only in HTTP context: crash output with 401, 403 or 429 in it is transient", () => {
  for (const text of [
    "    at Object.<anonymous> (C:\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js:401:17)",
    "goroutine 403 [running]:\nmain.main()\n\t/src/main.go:12 +0x1d",
    "thread 'main' panicked at src/x.rs:401:9:\ncalled `Option::unwrap()` on a `None` value",
    "Error: ENOENT at line 429 of config.toml",
    "TypeError: cannot read properties of undefined (reading 'code') at parse (index.js:503:12)",
  ]) {
    assert.equal(classifyCliFailureText(text), "transient", text);
    const reading = read("agy", { stdout: "", stderr: text, exitCode: 1, now: NOW });
    assert.deepEqual(reading.outcome.type === "failure" && [reading.outcome.failure.kind, reading.outcome.reason], ["transient", "no_result"], text);
  }
  for (const [text, kind] of [
    ["unexpected status 401 Unauthorized", "authentication"], ["HTTP 403", "authentication"], ["status code 403", "authentication"],
    ["403 Forbidden", "authentication"], ["HTTP/1.1 429", "rate_limit"], ["API Error: 429 slow down", "rate_limit"],
    ["last status: 429 Too Many Requests", "rate_limit"], ["HTTP 502 from upstream", "provider_unavailable"],
    ["Error: Forbidden", "authentication"], ["request forbidden by policy", "authentication"], ["received 429 from the API", "rate_limit"],
    ["model request failed: 429", "rate_limit"], ['{"statusCode":429,"message":"slow down"}', "rate_limit"], ["upstream returned 401", "authentication"],
    ["got 503 while streaming", "provider_unavailable"], ['{"status_code": 503}', "provider_unavailable"],
  ] as const) assert.equal(classifyCliFailureText(text), kind, text);
});

test("organization ids never reach a failure message", () => {
  const anthropic = "API Error: 429 This request would exceed the rate limit for your organization (813ed5d4-1a2b-4c3d-8e9f-0123456789ab) of 40,000 input tokens per minute.";
  const reading = read("claude-code", { stdout: `${JSON.stringify({ type: "result", is_error: true, result: anthropic, api_error_status: 429 })}\n`, exitCode: 1, now: NOW });
  assert.equal(reading.outcome.type === "failure" && reading.outcome.failure.kind, "rate_limit");
  const message = reading.outcome.type === "failure" ? reading.outcome.failure.message : "";
  assert.ok(!message.includes("813ed5d4"), message);
  assert.match(message, /organization \(\[redacted\]\)/);
  for (const text of ["Rate limit reached for org-AbCdEf0123456789xyz on tokens per min.", "organization_id: 813ed5d4-1a2b-4c3d-8e9f-0123456789ab", "org id 813ed5d4-1a2b-4c3d-8e9f-0123456789ab",
    "organization ids: 813ed5d4-1a2b-4c3d-8e9f-0123456789ab", '{"organizationUuid":"813ed5d4-1a2b-4c3d-8e9f-0123456789ab"}', '{"orgId":"813ed5d4-1a2b-4c3d-8e9f-0123456789ab"}',
    "the organization 'Acme Labs' (813ed5d4-1a2b-4c3d-8e9f-0123456789ab) is over its limit", 'organization "Acme": 813ed5d4-1a2b-4c3d-8e9f-0123456789ab']) {
    const scrubbed = scrubCliMessage(text);
    assert.ok(!/org-AbCdEf|813ed5d4/.test(scrubbed), scrubbed);
  }
  // A session id that follows no organization word stays: it is the resume key, not an account field.
  assert.ok(scrubCliMessage("session 8aadb5b0-b06a-4394-9b2f-f42614de8239 ended").includes("8aadb5b0-b06a-4394-9b2f-f42614de8239"));
});

test("a line over the cap is dropped unread, whether it arrives whole or in pieces", () => {
  const huge = `{"type":"result","is_error":false,"structured_output":{"outcome":"done","summary":"${"x".repeat(CLI_STREAM_LINE_MAX_CHARS)}","checks":[]}}`;
  const whole = CLI_WORKER_ADAPTERS["claude-code"].createStreamReader();
  whole.push(`${huge}\n`);
  assert.equal(whole.turnEnded, false);
  const pieces = CLI_WORKER_ADAPTERS["claude-code"].createStreamReader();
  for (let index = 0; index < huge.length; index += 1 << 20) pieces.push(huge.slice(index, index + (1 << 20)));
  pieces.push('\n{"type":"result","is_error":true,"result":"after"}\n');
  assert.equal(pieces.turnEnded, true, "the next line is read normally");
  const after = pieces.read({ exitCode: 1, now: NOW });
  assert.equal(after.outcome.type === "failure" && after.outcome.failure.message, "after");
});

test("an unknown failure message is transient, never a success", () => {
  assert.equal(classifyCliFailureText("the flux capacitor is misaligned"), "transient");
  assert.equal(classifyCliFailureText(""), "transient");
  const codex = read("codex-cli", { stdout: '{"type":"turn.failed","error":{"message":"the flux capacitor is misaligned"}}\n', exitCode: 1, outputFile: "", now: NOW });
  assert.deepEqual(codex.outcome.type === "failure" && [codex.outcome.failure.kind, codex.outcome.reason], ["transient", "cli_error"]);
  const claude = read("claude-code", { stdout: '{"type":"result","is_error":true,"result":"the flux capacitor is misaligned"}\n', exitCode: 1, now: NOW });
  assert.equal(claude.outcome.type === "failure" && claude.outcome.failure.kind, "transient");
  const agy = read("agy", { stdout: '{"event":"result","result":{"status":"ERROR","error":"the flux capacitor is misaligned","conversation_id":""}}\n', exitCode: 3, now: NOW });
  assert.equal(agy.outcome.type === "failure" && agy.outcome.failure.kind, "transient");
  // Exit 0 and no result at all.
  assert.equal(read("claude-code", { stdout: "", exitCode: 0, now: NOW }).outcome.type, "failure");
  assert.equal(read("agy", { stdout: "", exitCode: 0, now: NOW }).outcome.type, "failure");
});

test("a Codex error event or item alone is not fatal: only turn.failed ends the turn", () => {
  const success = fixture("codex-cli/success.windows.stdout.jsonl").split("\n");
  const warnings = [
    '{"type":"item.completed","item":{"id":"item_w","type":"error","message":"Model metadata for `gpt-x` not found. Defaulting to fallback metadata; this can degrade performance and cause issues."}}',
    '{"type":"error","message":"Reconnecting... 1/5 (unexpected status 401 Unauthorized: Missing bearer or basic authentication in header)"}',
    '{"type":"error","message":"Reconnecting... 2/5 (unexpected status 429 Too Many Requests)"}',
  ];
  const stdout = [success[0], ...warnings, ...success.slice(1)].join("\n");
  const outputFile = readFileSync(cliFixture("codex-cli/success.windows.last-message.json"));
  const reading = read("codex-cli", { stdout, exitCode: 0, outputFile, now: NOW });
  assert.equal(reading.outcome.type, "result");
  assert.equal(reading.turnEnded, true);
  // The model-metadata warning is not read as "model unavailable" even when the run then ends without a result.
  const noResult = read("codex-cli", { stdout: [success[0], warnings[0]].join("\n"), exitCode: null, outputFile: "", now: NOW });
  assert.deepEqual(noResult.outcome.type === "failure" && [noResult.outcome.failure.kind, noResult.outcome.reason], ["transient", "no_result"]);
  assert.equal(noResult.turnEnded, false);
});

test("the Codex -o file counts only when non-empty and parsable", () => {
  const stdout = fixture("codex-cli/success.windows.stdout.jsonl");
  const good = readFileSync(cliFixture("codex-cli/success.windows.last-message.json"));
  const outcome = (outputFile: CliRunInput["outputFile"], exitCode: number | null = 0) => read("codex-cli", { stdout, exitCode, ...(outputFile === undefined ? {} : { outputFile }), now: NOW }).outcome;
  assert.equal(outcome(good).type, "result");
  assert.equal(outcome(good.toString("utf8")).type, "result");
  for (const [file, reason] of [["", "no_result"], [" \r\n", "no_result"], [null, "no_result"], [undefined, "no_result"], ["{not json", "unreadable_result"], ['{"outcome":"done"}', "unreadable_result"]] as const) {
    const result = outcome(file);
    assert.deepEqual(result.type === "failure" && [result.failure.kind, result.reason], ["transient", reason], `${JSON.stringify(file)}`);
  }
  // The recorded failures all left a 0-byte file (CW0): it exists and is not a result.
  for (const base of ["killed.windows", "killed.linux", "logged-out.linux", "model-unavailable.windows"]) {
    assert.equal(readFileSync(cliFixture(`codex-cli/${base}.last-message.json`)).length, 0);
  }
  // A non-zero exit with a parsable file is not a result.
  assert.equal(outcome(good, 1).type, "failure");
  // Nor is a parsable file whose run never completed its turn: a file an earlier attempt left behind.
  const unfinished = stdout.split("\n").filter((line) => !line.includes('"turn.completed"')).join("\n");
  const stale = read("codex-cli", { stdout: unfinished, exitCode: 0, outputFile: good, now: NOW }).outcome;
  assert.deepEqual(stale.type === "failure" && [stale.failure.kind, stale.reason], ["transient", "no_result"]);
});

test("usage is read per CLI, and totalInputTokens counts cached input the same way", () => {
  const codex = read("codex-cli", runInput(RUNS[0]!));
  assert.deepEqual(codex.usage, { inputTokens: 73230, outputTokens: 430, cacheReadTokens: 35840, cacheWriteTokens: 0, reasoningTokens: 0, totalInputTokens: 73230 });
  const claude = read("claude-code", runInput(RUNS.find((entry) => entry.base === "claude-code/success.windows")!));
  assert.deepEqual(claude.usage, { inputTokens: 6, outputTokens: 467, cacheReadTokens: 99462, cacheWriteTokens: 51791, totalInputTokens: 6 + 99462 + 51791 });
  assert.equal(claude.model, "claude-opus-5-5");
  const agy = read("agy", runInput(RUNS.find((entry) => entry.base === "agy/success.windows")!));
  assert.deepEqual(agy.usage, { inputTokens: 31572, outputTokens: 842, cacheReadTokens: 82004, reasoningTokens: 163, totalInputTokens: 31572 + 82004 });
});

test("Claude Code's rate_limit_event is read per window; allowed_warning and a rejected overage are not a usage limit", () => {
  const reading = read("claude-code", runInput(RUNS.find((entry) => entry.base === "claude-code/background-streamjson.windows")!));
  assert.equal(reading.outcome.type, "result");
  assert.deepEqual(reading.rateLimits, [
    { window: "five_hour", status: "allowed", utilization: 0.2, resetsAt: "2100-01-01T00:00:00.000Z" },
    { window: "seven_day", status: "allowed_warning", utilization: 0.8, resetsAt: "2100-01-01T00:00:00.000Z" },
  ]);
});

test("the stream reader sees the end of the turn incrementally, over any chunking", () => {
  const stdout = fixture("claude-code/background-streamjson.windows.stdout.jsonl");
  const reader = CLI_WORKER_ADAPTERS["claude-code"].createStreamReader();
  const resultAt = stdout.indexOf('{"duration_api_ms"');
  for (let index = 0; index < resultAt; index += 97) reader.push(crlf(stdout.slice(index, Math.min(index + 97, resultAt))));
  assert.equal(reader.turnEnded, false);
  assert.equal(reader.sessionId, "8aadb5b0-b06a-4394-9b2f-f42614de8239");
  reader.push(stdout.slice(resultAt, -1));
  assert.equal(reader.turnEnded, false, "a line is read only when it ends");
  reader.push("\n");
  assert.equal(reader.turnEnded, true);
  assert.equal(reader.read({ exitCode: null, now: NOW }).outcome.type, "result");

  const agy = CLI_WORKER_ADAPTERS.agy.createStreamReader();
  const agyStdout = fixture("agy/success.windows.stdout.jsonl");
  for (const character of agyStdout.slice(0, -2)) agy.push(character);
  assert.equal(agy.turnEnded, false);
  agy.push(agyStdout.slice(-2));
  assert.equal(agy.turnEnded, true);

  // A last line without a newline is read at end().
  const codex = CLI_WORKER_ADAPTERS["codex-cli"].createStreamReader();
  codex.push(fixture("codex-cli/success.windows.stdout.jsonl").trimEnd());
  assert.equal(codex.turnEnded, false);
  codex.end();
  assert.equal(codex.turnEnded, true);
});

test("a stated reset: durations, timestamps, unix seconds and clock times; nothing guessed", () => {
  const at = (text: string, now = NOW) => statedResetFromText(text, now)?.retryAfterMs;
  assert.equal(at("Resets in 4h53m36s."), ((4 * 60 + 53) * 60 + 36) * 1000);
  assert.equal(at("try again in 4 days 20 hours 9 minutes."), ((4 * 24 + 20) * 60 + 9) * 60_000);
  assert.equal(at("Your limit resets in 45m."), 45 * 60_000);
  assert.equal(at("Limit reached; resets at 2026-11-17T15:30:00Z"), 3.5 * 3_600_000);
  assert.equal(at("Claude AI usage limit reached|1763395200"), undefined, "a stated time in the past sets nothing");
  assert.equal(at("Claude AI usage limit reached|4102444800", HOUR_BEFORE_2100), 3_600_000);
  // A clock time is the next such time in the machine's zone, within a day. NOW is 12:00 UTC on 17 November 2026:
  // 07:00 in UTC-05:00 and 15:30 in UTC+03:30, so the same words give different, literal resets in each zone, and a
  // reading in UTC (Date.UTC) fails both.
  const west = fixedOffsetLocalClock(-300), east = fixedOffsetLocalClock(210);
  const inZone = (text: string, clock: LocalClock) => statedResetFromText(text, NOW, clock)?.retryAfterMs;
  const hm = (hours: number, minutes: number) => (hours * 60 + minutes) * 60_000;
  assert.equal(inZone("You've hit your usage limit. Try again at 3:02 PM.", west), hm(8, 2), "15:02 today in UTC-5");
  assert.equal(inZone("You've hit your usage limit. Try again at 3:02 PM.", east), hm(23, 32), "15:02 has passed in UTC+3:30: tomorrow");
  assert.equal(inZone("try again at 9 am", west), hm(2, 0));
  assert.equal(inZone("try again at 9 am", east), hm(17, 30));
  assert.equal(inZone("or try again at Nov 20th, 2026 3:02 PM.", west), hm(80, 2));
  assert.equal(inZone("or try again at Nov 20th, 2026 3:02 PM.", east), hm(71, 32));
  // The run readers pass their clock through.
  const codex = read("codex-cli", { stdout: '{"type":"turn.failed","error":{"message":"You\'ve hit your usage limit. Try again at 3:02 PM."}}\n', exitCode: 1, outputFile: "", now: NOW, localClock: west });
  assert.deepEqual(codex.outcome.type === "failure" && [codex.outcome.failure.kind, codex.outcome.failure.retryAfterMs], ["usage_limit", hm(8, 2)]);
  // Nothing stated, in the past, too far away, in a zone that is not this machine's, or a number that is not a
  // reset: no reset.
  for (const text of ["You've hit your usage limit.", "Please try again later.", "resets 7pm (Europe/London)",
    "Claude usage limit reached. Your limit will reset at 7pm (Europe/London).", "resets at 2020-01-01T00:00:00Z", "try again in 40 days",
    "5-hour limit reached", "limit (5h) reached", '{"retryable":true}', "retry budget exhausted after 4h", "retry limit 3 in 5m window",
    "the cap resets weekly; used 4h of it"]) assert.equal(at(text), undefined, text);
  assert.equal(at("will fully refresh in 2h30m"), hm(2, 30));
  assert.equal(at("Try again after 90 seconds"), 90_000);
});

test("agy's retryable is never read", () => {
  const base = runInput(RUNS.find((entry) => entry.base === "agy/usage-limit.synthetic")!);
  const flipped = { ...base, stdout: base.stdout.replace('"retryable":true', '"retryable":false') };
  assert.notEqual(flipped.stdout, base.stdout);
  const removed = { ...base, stdout: base.stdout.replace('"retryable":true,', "") };
  const outcomes = [base, flipped, removed].map((input) => read("agy", input).outcome);
  assert.deepEqual(outcomes[1], outcomes[0]);
  assert.deepEqual(outcomes[2], outcomes[0]);
  // retryable with no stated time sets no reset.
  const unstated = read("agy", { stdout: '{"event":"result","result":{"status":"ERROR","error":"Quota exhausted for Gemini Models.","retryable":true,"conversation_id":""}}\n', exitCode: 3, now: NOW });
  assert.deepEqual(unstated.outcome.type === "failure" && [unstated.outcome.failure.kind, unstated.outcome.failure.retryAfterMs], ["usage_limit", undefined]);
});

test("agy /quota: groups and buckets only; an empty bucket for the chosen model is a usage limit with its stated reset", () => {
  const now = Date.parse("2099-01-01T00:00:00.000Z");
  const recorded = parseAgyQuota(fixture("agy/free/quota.json"), now - 3_600_000);
  assert.ok(recorded);
  assert.deepEqual(recorded.map((group) => [group.name, group.models, group.buckets.map((bucket) => [bucket.id, bucket.window, bucket.remainingFraction, bucket.resetsAt])]), [
    ["Gemini Models", ["Gemini 4 Hydrogen", "Gemini 3.8 Flash"], [["gemini-weekly", "weekly", 0.5, "2099-01-01T00:00:00.000Z"], ["gemini-5h", "5h", 0.5, "2099-01-01T00:00:00.000Z"]]],
    ["Claude and GPT models", ["Claude Opus 5.5", "Claude Sonnet 5.5", "GPT-OSS 120B"], [["3p-weekly", "weekly", 0.5, "2099-01-01T00:00:00.000Z"], ["3p-5h", "5h", 0.5, "2099-01-01T00:00:00.000Z"]]],
    ["Gemini 4 Argon", [], [["gemini-argon-wtu-weekly", "weekly", 0.5, "2099-01-01T00:00:00.000Z"]]],
  ]);
  assert.equal(agyQuotaFailure(recorded, now), undefined);
  const exhausted = parseAgyQuota(crlf(fixture("agy/free/quota-exhausted.synthetic.json")), now)!;
  const failure = agyQuotaFailure(exhausted, now, "Claude Opus 5.5 (Low)");
  assert.deepEqual(failure && [failure.kind, failure.retryAfterMs], ["usage_limit", ((4 * 60 + 53) * 60 + 36) * 1000]);
  assert.equal(agyQuotaFailure(exhausted, now, "Gemini 3.8 Flash (High)"), undefined);
  // An exact name, not a prefix, and a display name, not an id: these match no group, and no group alone is empty.
  assert.equal(agyQuotaFailure(exhausted, now, "Claude Opus 5"), undefined);
  assert.equal(agyQuotaFailure(exhausted, now, "claude-opus-5-5-low"), undefined);
  assert.equal(agyQuotaFailure(exhausted, now, "claude opus 5.5")?.kind, "usage_limit");
  // The CLI default (no model): only when every group has an empty bucket.
  assert.equal(agyQuotaFailure(exhausted, now), undefined);
  assert.equal(parseAgyQuota("not json", now), undefined);
});

test("free checks: versions and logins, keeping only the named fields", () => {
  assert.equal(parseCliVersionOutput("codex-cli 0.169.0\n"), "0.169.0");
  assert.equal(parseCliVersionOutput("2.1.326 (Claude Code)\r\n"), "2.1.326");
  assert.equal(parseCliVersionOutput("1.5.10\n"), "1.5.10");
  assert.equal(parseCliVersionOutput("v1.6.0-beta.2"), "1.6.0-beta.2");
  assert.equal(parseCliVersionOutput("no version here"), undefined);

  const codexIn = { exitCode: 0, stdout: "", stderr: fixture("codex-cli/free/login-status.logged-in.txt") };
  assert.deepEqual(parseCodexLoginStatus(codexIn), { status: "logged_in", method: "chatgpt" });
  assert.deepEqual(parseCodexLoginStatus({ exitCode: 1, stdout: "", stderr: fixture("codex-cli/free/login-status.logged-out.txt") }), { status: "logged_out" });
  const apiKey = parseCodexLoginStatus({ exitCode: 0, stdout: "", stderr: "Logged in using an API key - sk-proj-CANARYCANARYCANARY***\n" });
  assert.deepEqual(apiKey, { status: "logged_in", method: "api_key" });
  assert.deepEqual(parseCodexLoginStatus({ exitCode: 2, stdout: "", stderr: "error: unexpected" }), { status: "unknown" });

  const claudeIn = parseClaudeAuthStatus({ exitCode: 0, stdout: fixture("claude-code/free/auth-status.logged-in.json"), stderr: "" });
  assert.deepEqual(claudeIn, { status: "logged_in", method: "claude.ai", subscription: "pro" });
  for (const canary of CANARIES) assert.ok(!JSON.stringify(claudeIn).includes(canary), canary);
  assert.deepEqual(parseClaudeAuthStatus({ exitCode: 1, stdout: crlf(fixture("claude-code/free/auth-status.logged-out.json")), stderr: "" }), { status: "logged_out" });
  assert.deepEqual(parseClaudeAuthStatus({ exitCode: 1, stdout: "garbage", stderr: "" }), { status: "unknown" });
  // A field holding an account value in place of a short token is dropped, not kept.
  const odd = parseClaudeAuthStatus({ exitCode: 0, stdout: JSON.stringify({ loggedIn: true, authMethod: "canary@example.test", subscriptionType: "Canary Org" }), stderr: "" });
  assert.deepEqual(odd, { status: "logged_in" });

  assert.deepEqual(parseAgyModelsLogin({ exitCode: 0, stdout: fixture("agy/free/models.txt"), stderr: "" }), { status: "logged_in" });
  assert.deepEqual(parseAgyModelsLogin({ exitCode: 1, stdout: "", stderr: fixture("agy/free/models-logged-out.synthetic.stderr.txt") }), { status: "logged_out" });
  assert.deepEqual(parseAgyModelsLogin({ exitCode: 1, stdout: "", stderr: "error: network unreachable" }), { status: "unknown" });

  assert.deepEqual(CLI_WORKER_ADAPTERS["codex-cli"].freeChecks, { version: ["--version"], login: ["login", "status"], models: ["debug", "models"] });
  assert.deepEqual(CLI_WORKER_ADAPTERS["claude-code"].freeChecks, { version: ["--version"], login: ["auth", "status"] });
  assert.deepEqual(CLI_WORKER_ADAPTERS.agy.freeChecks, { version: ["--version"], login: ["models"], models: ["models"], quota: ["--output-format", "json", "-p=/quota"] });
});

const probe = (output: Partial<CliProbeOutput> | Error, seen: string[][] = []) => async (args: readonly string[]): Promise<CliProbeOutput> => {
  seen.push([...args]);
  if (output instanceof Error) throw output;
  return { exitCode: 0, stdout: "", stderr: "", ...output };
};

test("model lists: Codex keeps only listed models with their efforts and falls back to the catalog", async () => {
  const seen: string[][] = [];
  const listed = await CLI_WORKER_ADAPTERS["codex-cli"].listModels(probe({ stdout: crlf(fixture("codex-cli/free/debug-models.json")) }, seen));
  assert.deepEqual(seen, [["debug", "models"]]);
  assert.equal(listed.source, "cli");
  assert.deepEqual(listed.models[0], { id: null, name: "CLI default", source: "default" });
  assert.deepEqual(listed.models.slice(1).map((model) => model.id), ["gpt-6.1-sol", "gpt-6-astra", "gpt-6.1-terra", "gpt-6-sol", "gpt-6-luna", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"]);
  assert.deepEqual(listed.models[1], { id: "gpt-6.1-sol", name: "GPT-6.1-Sol", reasoningEfforts: ["low", "medium", "high", "xhigh", "max", "ultra"], defaultReasoningEffort: "low", source: "cli" });
  assert.deepEqual(listed.models.find((model) => model.id === "gpt-6-luna")?.reasoningEfforts, ["low", "medium", "high", "xhigh", "max"]);

  const catalog = MODEL_CATALOG_SNAPSHOT.models.filter((entry) => entry.providerId === "openai").map((entry) => entry.id);
  for (const fallback of [probe({ stdout: '{"models": "changed shape"}' }), probe({ stdout: "Error: unknown command" }), probe({ exitCode: 2, stdout: fixture("codex-cli/free/debug-models.json") }), probe(new Error("spawn failed")), undefined]) {
    const list = await CLI_WORKER_ADAPTERS["codex-cli"].listModels(fallback);
    assert.equal(list.source, "catalog");
    assert.ok(list.note);
    assert.deepEqual(list.models[0], { id: null, name: "CLI default", source: "default" });
    assert.deepEqual(list.models.slice(1).map((model) => [model.id, model.source]), catalog.map((id) => [id, "catalog"]));
  }
  // An entry whose slug or effort would not be a safe argument is left out.
  const unsafe = parseCodexDebugModels(JSON.stringify({ models: [
    { slug: "--model", visibility: "list" }, { slug: "ok-model", visibility: "list", supported_reasoning_levels: [{ effort: "low" }, { effort: "--x" }] },
  ] }));
  assert.deepEqual(unsafe, [{ id: "ok-model", name: "ok-model", reasoningEfforts: ["low"], source: "cli" }]);
});

test("model lists: Claude Code lists the catalog's Anthropic models and its aliases", async () => {
  const list = await CLI_WORKER_ADAPTERS["claude-code"].listModels();
  const anthropic = MODEL_CATALOG_SNAPSHOT.models.filter((entry) => entry.providerId === "anthropic").map((entry) => entry.id);
  assert.ok(anthropic.length > 0);
  assert.deepEqual(list.models.map((model) => model.id), [null, ...anthropic, "opus", "sonnet", "haiku"]);
  assert.deepEqual(list.models.slice(1).map((model) => model.reasoningEfforts), list.models.slice(1).map(() => [...CLAUDE_CODE_EFFORTS]));
  assert.ok(list.models.slice(1).every((model) => isCliArgumentValue(model.id)));
});

test("model lists: agy models is parsed; a logged-out agy offers only the CLI default", async () => {
  const list = await CLI_WORKER_ADAPTERS.agy.listModels(probe({ stdout: `Fetching available models...\r\n${crlf(fixture("agy/free/models.txt"))}` }));
  assert.equal(list.models.length, 19);
  assert.deepEqual(list.models[0], { id: null, name: "CLI default", source: "default" });
  assert.deepEqual(list.models[1], { id: "gemini-4-argon-medium", name: "Gemini 4 Argon (Medium)", source: "cli" });
  assert.deepEqual(list.login, { status: "logged_in" });
  assert.deepEqual(parseAgyModels(fixture("agy/free/models.txt")), list.models.slice(1));
  const loggedOut = await CLI_WORKER_ADAPTERS.agy.listModels(probe({ exitCode: 1, stderr: fixture("agy/free/models-logged-out.synthetic.stderr.txt") }));
  assert.deepEqual(loggedOut.models, [{ id: null, name: "CLI default", source: "default" }]);
  assert.deepEqual(loggedOut.login, { status: "logged_out" });
});

/** The CW0 harness's arguments, with its placeholders made into real absolute paths. */
function cw0Args(metaPath: string, replacements: Record<string, string>): string[] {
  const meta = JSON.parse(fixture(metaPath)) as { args: string[] };
  return meta.args.map((arg) => Object.entries(replacements).reduce((value, [from, to]) => value.split(from).join(to), arg));
}
const ROOT = "C:\\cw0";
const SCHEMA = cliWorkerResultSchemaJson();

test("Codex arguments match §3.5 and CW0's confirmed runs", () => {
  const meta = JSON.parse(fixture("codex-cli/success.windows.meta.json")) as { args: string[] };
  const at = (index: number) => meta.args[index]!.split("<root>").join(ROOT);
  assert.deepEqual(buildCodexArgs({ mode: "worker", schemaPath: at(3), outputPath: at(5), worktree: at(10), reasoningEffort: "low" }),
    cw0Args("codex-cli/success.windows.meta.json", { "<root>": ROOT }));
  const modelMeta = JSON.parse(fixture("codex-cli/model-unavailable.windows.meta.json")) as { args: string[] };
  const m = (index: number) => modelMeta.args[index]!.split("<root>").join(ROOT);
  // An unknown model is refused by the charset only when it is not a safe value; this one is, so it is built.
  assert.deepEqual(buildCodexArgs({ mode: "worker", schemaPath: m(3), outputPath: m(5), worktree: m(12), model: "cw0-no-such-model", reasoningEffort: "low" }),
    cw0Args("codex-cli/model-unavailable.windows.meta.json", { "<root>": ROOT }));
  const resumeMeta = JSON.parse(fixture("codex-cli/resume.windows.meta.json")) as { args: string[] };
  const r = (index: number) => resumeMeta.args[index]!.split("<root>").join(ROOT);
  assert.deepEqual(buildCodexArgs({ mode: "worker", schemaPath: r(5), outputPath: r(7), worktree: "C:\\cw0\\w\\any", reasoningEffort: "low", resumeThreadId: "01a1e9c2-d41e-7543-ba78-0ce6501b9a8f" }),
    cw0Args("codex-cli/resume.windows.meta.json", { "<root>": ROOT }));
  // The plan's form, spelled out.
  assert.deepEqual(buildCodexArgs({ mode: "worker", schemaPath: "/s/schema.json", outputPath: "/s/out.json", worktree: "/w", model: "gpt-6.1-sol", reasoningEffort: "high" }),
    ["exec", "--json", "--output-schema", "/s/schema.json", "-o", "/s/out.json", "-m", "gpt-6.1-sol", "-c", "model_reasoning_effort=high", "--dangerously-bypass-approvals-and-sandbox", "-C", "/w", "-"]);
  assert.deepEqual(buildCodexArgs({ mode: "worker", schemaPath: "/s/schema.json", outputPath: "/s/out.json", worktree: "/w", model: null }),
    ["exec", "--json", "--output-schema", "/s/schema.json", "-o", "/s/out.json", "--dangerously-bypass-approvals-and-sandbox", "-C", "/w", "-"]);
});

test("Claude Code arguments match §3.5 (stream-json, verbose) and CW0's stream-json run", () => {
  const session = "8aadb5b0-b06a-4394-9b2f-f42614de8239";
  assert.deepEqual(buildClaudeCodeArgs({ mode: "worker", schemaJson: SCHEMA, sessionId: session, reasoningEffort: "low" }),
    cw0Args("claude-code/background-streamjson.windows.meta.json", { "<schema-json>": SCHEMA }));
  assert.deepEqual(buildClaudeCodeArgs({ mode: "worker", schemaJson: SCHEMA, sessionId: session, model: "sonnet", reasoningEffort: "low" }),
    ["-p", "--output-format", "stream-json", "--verbose", "--json-schema", SCHEMA, "--model", "sonnet", "--effort", "low", "--dangerously-skip-permissions", "--session-id", session]);
  // Resume as CW0 confirmed it (--resume in place of --session-id), in the amended stream-json form.
  const resume = cw0Args("claude-code/resume.windows.meta.json", { "<schema-json>": SCHEMA });
  resume.splice(resume.indexOf("json"), 1, "stream-json", "--verbose");
  assert.deepEqual(buildClaudeCodeArgs({ mode: "worker", schemaJson: SCHEMA, sessionId: "3139a957-fc06-44f1-bbe3-d651f906244f", reasoningEffort: "low", resume: true }), resume);
});

test("agy arguments match §3.5 as amended after CW0: stream-json both ways, -p= empty and last", () => {
  const schema = `${ROOT}\\schemas\\result.schema.json`;
  assert.deepEqual(buildAgyArgs({ mode: "worker", schemaPath: schema, reasoningEffort: "low" }), cw0Args("agy/success.windows.meta.json", { "<root>": ROOT }));
  assert.deepEqual(buildAgyArgs({ mode: "worker", schemaPath: schema, model: "cw0-no-such-model", reasoningEffort: "low" }), cw0Args("agy/model-unavailable.windows.meta.json", { "<root>": ROOT }));
  assert.deepEqual(buildAgyArgs({ mode: "worker", schemaPath: schema, reasoningEffort: "low", resumeConversationId: "0b24ca58-5362-4e0c-bf3d-aa39b24c4a33" }),
    cw0Args("agy/resume.windows.meta.json", { "<root>": ROOT }));
  const args = buildAgyArgs({ mode: "worker", schemaPath: "/s/schema.json" });
  assert.equal(args.at(-1), "-p=");
  assert.equal(args.filter((arg) => arg.startsWith("-p")).length, 1);
});

test("the Test button's forms are the restricted modes of §3.4, never a bypass flag, never a resume", () => {
  const forms = [
    buildCodexArgs({ mode: "test", schemaPath: "/s/schema.json", outputPath: "/s/out.json", worktree: "/t", model: "gpt-6.1-sol", reasoningEffort: "low" }),
    buildClaudeCodeArgs({ mode: "test", schemaJson: SCHEMA, sessionId: "8aadb5b0-b06a-4394-9b2f-f42614de8239" }),
    buildAgyArgs({ mode: "test", schemaPath: "/s/schema.json" }),
  ];
  assert.deepEqual(forms[0], ["exec", "--json", "--output-schema", "/s/schema.json", "-o", "/s/out.json", "-m", "gpt-6.1-sol", "-c", "model_reasoning_effort=low", "-s", "read-only", "--skip-git-repo-check", "--ephemeral", "-C", "/t", "-"]);
  assert.deepEqual(forms[1], ["-p", "--output-format", "stream-json", "--verbose", "--json-schema", SCHEMA, "--permission-mode", "plan", "--no-session-persistence"]);
  assert.deepEqual(forms[2], ["--input-format", "stream-json", "--output-format", "stream-json", "--json-schema", "/s/schema.json", "--mode", "plan", "--print-timeout", "0", "-p="]);
  for (const form of forms) assert.ok(!form.some((arg) => arg.startsWith("--dangerously")), form.join(" "));
  assert.throws(() => buildCodexArgs({ mode: "test", schemaPath: "/s", outputPath: "/o", worktree: "/t", resumeThreadId: "01a1e9c2-d41e-7543-ba78-0ce6501b9a8f" }));
  assert.throws(() => buildClaudeCodeArgs({ mode: "test", schemaJson: SCHEMA, sessionId: "8aadb5b0-b06a-4394-9b2f-f42614de8239", resume: true }));
  assert.throws(() => buildAgyArgs({ mode: "test", schemaPath: "/s", resumeConversationId: "0b24ca58-5362-4e0c-bf3d-aa39b24c4a33" }));
});

test("argv never contains prompt text: the prompt goes on stdin, and every Runner-built value is checked", () => {
  const prompt = buildCliWorkerPrompt({ taskContext: "PROMPT-CANARY: add mul(a, b) to sum.js", earlierWork: "EARLIER-CANARY", browserNote: "BROWSER-CANARY" });
  const specs = [
    { providerId: "codex-cli" as const, mode: "worker" as const, schemaPath: "/s/schema.json", outputPath: "/s/out.json", worktree: "/w", model: "gpt-6.1-sol", reasoningEffort: "high" },
    { providerId: "codex-cli" as const, mode: "worker" as const, schemaPath: "/s/schema.json", outputPath: "/s/out.json", worktree: "/w", resumeThreadId: "01a1e9c2-d41e-7543-ba78-0ce6501b9a8f" },
    { providerId: "claude-code" as const, mode: "worker" as const, schemaJson: SCHEMA, sessionId: "8aadb5b0-b06a-4394-9b2f-f42614de8239", model: "opus", reasoningEffort: "max" },
    { providerId: "claude-code" as const, mode: "worker" as const, schemaJson: SCHEMA, sessionId: "8aadb5b0-b06a-4394-9b2f-f42614de8239", resume: true },
    { providerId: "agy" as const, mode: "worker" as const, schemaPath: "/s/schema.json", model: "claude-opus-5-5-low" },
    { providerId: "agy" as const, mode: "worker" as const, schemaPath: "/s/schema.json", resumeConversationId: "0b24ca58-5362-4e0c-bf3d-aa39b24c4a33" },
  ];
  for (const spec of specs) {
    const args = buildCliWorkerArgs(spec);
    for (const canary of ["PROMPT-CANARY", "EARLIER-CANARY", "BROWSER-CANARY", "mul(a, b)"]) assert.ok(!args.some((arg) => arg.includes(canary)), `${spec.providerId}: ${canary}`);
    const stdin = buildCliWorkerStdin(spec.providerId, prompt);
    assert.ok(stdin.includes("PROMPT-CANARY"));
  }
  // agy's one stream-json line, in the shape CW0 sent.
  const agyStdin = buildCliWorkerStdin("agy", prompt);
  assert.ok(agyStdin.endsWith("\n") && agyStdin.indexOf("\n") === agyStdin.length - 1);
  assert.deepEqual(JSON.parse(agyStdin), { event: "user", message: { content: prompt } });
  const recorded = JSON.parse((JSON.parse(fixture("agy/success.windows.meta.json")) as { stdin: string }).stdin);
  assert.deepEqual(Object.keys(recorded), ["event", "message"]);
  assert.deepEqual(Object.keys(recorded.message), ["content"]);
  assert.equal(buildCliWorkerStdin("codex-cli", "text"), "text\n");
  assert.throws(() => buildCliWorkerStdin("agy", "  "));

  const refused: Array<() => unknown> = [
    () => buildCodexArgs({ mode: "worker", schemaPath: "/s", outputPath: "/o", worktree: "/w", model: "default" }),
    () => buildCodexArgs({ mode: "worker", schemaPath: "/s", outputPath: "/o", worktree: "/w", model: "gpt 6" }),
    () => buildCodexArgs({ mode: "worker", schemaPath: "/s", outputPath: "/o", worktree: "/w", reasoningEffort: "-x" }),
    () => buildCodexArgs({ mode: "worker", schemaPath: "relative/schema.json", outputPath: "/o", worktree: "/w" }),
    () => buildCodexArgs({ mode: "worker", schemaPath: "/s", outputPath: "/o\nx", worktree: "/w" }),
    () => buildCodexArgs({ mode: "worker", schemaPath: "/s", outputPath: "/o", worktree: "/w", resumeThreadId: "not-a-uuid" }),
    () => buildClaudeCodeArgs({ mode: "worker", schemaJson: SCHEMA, sessionId: "--resume" }),
    () => buildClaudeCodeArgs({ mode: "worker", schemaJson: `${SCHEMA}\n`, sessionId: "8aadb5b0-b06a-4394-9b2f-f42614de8239" }),
    () => buildClaudeCodeArgs({ mode: "worker", schemaJson: "add mul", sessionId: "8aadb5b0-b06a-4394-9b2f-f42614de8239" }),
    () => buildAgyArgs({ mode: "worker", schemaPath: "/s", model: "a;b" }),
  ];
  for (const build of refused) assert.throws(build);
});

test("the prompt restates the worker rules and ends with the result instruction", () => {
  const prompt = buildCliWorkerPrompt({ taskContext: "Task T1: add mul.", browserNote: "A Playwright CLI session is running for you." });
  assert.ok(prompt.startsWith("Task T1: add mul."));
  for (const rule of ["Do not commit, push", "docs/project/", "narrowest check first", "Never weaken", "own command", "Playwright CLI session", "\"needs_decision\"", "List every check you ran"])
    assert.ok(prompt.includes(rule), rule);
  assert.ok(!prompt.includes("Earlier work on this task"));
  assert.ok(buildCliWorkerPrompt({ taskContext: "x", earlierWork: "Codex changed sum.js" }).includes("## Earlier work on this task\nCodex changed sum.js"));
  assert.throws(() => buildCliWorkerPrompt({ taskContext: " " }));
});

test("the result schema is OpenAI's strict form of CliWorkerResultV1, as one line", () => {
  assert.ok(!/[\r\n]/.test(SCHEMA));
  assert.deepEqual(JSON.parse(SCHEMA), CLI_WORKER_RESULT_SCHEMA);
  const walk = (node: Record<string, unknown>) => {
    if (node.type === "object") {
      assert.equal(node.additionalProperties, false);
      assert.deepEqual([...(node.required as string[])].sort(), Object.keys(node.properties as object).sort());
      for (const child of Object.values(node.properties as Record<string, Record<string, unknown>>)) walk(child);
    }
    if (node.items) walk(node.items as Record<string, unknown>);
  };
  walk(CLI_WORKER_RESULT_SCHEMA as unknown as Record<string, unknown>);
  const check = CLI_WORKER_RESULT_SCHEMA.properties.checks.items.properties;
  assert.deepEqual([check.cwd.type, check.outputs.type, check.criterionIds.type], [["string", "null"], ["array", "null"], ["array", "null"]]);
  // CW0's reduced schema is this one without the three check fields.
  const cw0 = JSON.parse(fixture("result.schema.json"));
  const reduced = JSON.parse(SCHEMA);
  for (const field of ["cwd", "outputs", "criterionIds"]) delete reduced.properties.checks.items.properties[field];
  reduced.properties.checks.items.required = ["label", "executable", "args"];
  assert.deepEqual(reduced, cw0);
});

test("the result parser maps null to absent and bounds every field", () => {
  const parsed = parseCliWorkerResultText(readFileSync(cliFixture("codex-cli/needs-decision.windows.last-message.json"), "utf8"));
  assert.deepEqual(parsed, { ok: true, result: { outcome: "needs_decision", summary: "The behavior of divide(a, b) when b is 0 needs the owner's decision.", question: "What should divide(a, b) do when b is 0?", checks: [] } });
  const full = parseCliWorkerResult({
    outcome: "done", summary: "x".repeat(5000), question: null, replanReason: null,
    checks: Array.from({ length: 14 }, (_, index) => ({ label: `c${index}`, executable: "node", args: ["--test"], cwd: null, outputs: index === 0 ? ["shot.png"] : null, criterionIds: index === 0 ? ["AC-1"] : null })),
    notRun: [{ what: "e2e", why: "no browser" }], concerns: ["flaky"],
  });
  assert.ok(full.ok);
  assert.equal(full.result.summary.length, 4000);
  assert.equal(full.result.checks.length, 12);
  assert.deepEqual(full.result.checks[0], { label: "c0", executable: "node", args: ["--test"], outputs: ["shot.png"], criterionIds: ["AC-1"] });
  assert.deepEqual(full.result.checks[1], { label: "c1", executable: "node", args: ["--test"] });
  assert.deepEqual(full.result.concerns, ["flaky", "The CLI reported 14 checks; only the first 12 are kept."]);
  for (const bad of [
    {}, { outcome: "finished", summary: "s", checks: [] }, { outcome: "done", summary: "", checks: [] }, { outcome: "done", summary: "s" },
    { outcome: "needs_decision", summary: "s", question: null, checks: [] }, { outcome: "cannot_do", summary: "s", replanReason: " ", checks: [] },
    { outcome: "done", summary: "s", checks: "node --test" }, { outcome: "done", summary: "s", checks: [], concerns: [1] },
  ]) assert.equal(parseCliWorkerResult(bad).ok, false, JSON.stringify(bad));
  // One check over a bound, or malformed, is dropped with a concern; the rest of the result stands.
  const good = { label: "unit", executable: "node", args: ["--test"], cwd: null, outputs: null, criterionIds: ["AC-1"] };
  const overBound = [
    { ...good, outputs: [""] }, { ...good, args: Array.from({ length: 65 }, () => "a") },
    { ...good, criterionIds: Array.from({ length: 33 }, (_, index) => `AC-${index}`) }, { ...good, executable: "" }, { ...good, args: "--test" },
  ];
  const kept = parseCliWorkerResult({ outcome: "done", summary: "s", question: null, replanReason: null, checks: [good, ...overBound], notRun: [], concerns: [] });
  assert.ok(kept.ok);
  assert.deepEqual(kept.result.checks, [{ label: "unit", executable: "node", args: ["--test"], criterionIds: ["AC-1"] }]);
  assert.deepEqual(kept.result.concerns, [2, 3, 4, 5, 6].map((index) => `Check ${index} the CLI reported was dropped: it is malformed or over AIBoard's limits.`));
  // Concerns stay within their limit in all, the parser's own notes kept: 32 reported plus 14 notes would be 46.
  const crowded = parseCliWorkerResult({ outcome: "done", summary: "s", question: null, replanReason: null, notRun: [],
    checks: [...Array.from({ length: 13 }, () => ({ ...good, args: "--test" })), ...Array.from({ length: 13 }, () => good)],
    concerns: Array.from({ length: 32 }, (_, index) => `concern ${index}`) });
  assert.ok(crowded.ok);
  assert.equal(crowded.result.concerns!.length, CLI_RESULT_LIMITS.concerns);
  assert.equal(crowded.result.checks.length, 12);
  assert.deepEqual(crowded.result.concerns!.slice(-2), ["1 more checks were dropped.", "The CLI reported 13 checks; only the first 12 are kept."]);
  assert.equal(parseCliWorkerResultText("").ok, false);
  assert.equal(parseCliWorkerResultText("\uFEFF{\"outcome\":\"done\",\"summary\":\"s\",\"checks\":[]}\r\n").ok, true);
});

test("a .cmd shim launch refuses Claude Code's inline schema: the guard both Windows launchers apply, pinned to their source", () => {
  // The batch-argv probe (windows-process-semantic-probes.ts) checks only that ordinary values reach a .cmd intact.
  // Before it matters, both launchers refuse any .cmd argument with a cmd.exe metacharacter or a quote; this pins
  // that the copy here is theirs. Their quoting runs inside the Job host's C# and the portable child script, which a
  // pure test cannot call.
  const source = (name: string) => readFileSync(fileURLToPath(new URL(`../src/${name}`, import.meta.url)), "utf8");
  assert.ok(source("portable-process-child.mjs").includes(`if (${WINDOWS_BATCH_SHIM_UNSAFE_ARGUMENT.toString()}.test(argument)) throw new Error("Unsafe .cmd/.bat argument rejected before launch.");`));
  const jobHost = /argument\.IndexOfAny\(new char\[\] \{ ([^}]*) \}\) >= 0\)\s*throw new InvalidOperationException\(\s*"Unsafe \.cmd\/\.bat argument rejected/.exec(source("managed-process-job-host.ps1"));
  assert.ok(jobHost, "the Job host's batch guard moved");
  const characters = jobHost[1]!.split(",").map((entry) => JSON.parse(entry.trim().replace(/^'(.*)'$/, (_, inner: string) => `"${inner === '"' ? '\\"' : inner}"`)) as string);
  assert.deepEqual(characters.sort(), ['"', "%", "!", "^", "&", "|", "<", ">", "(", ")", "\r", "\n"].sort());
  for (const character of characters) assert.ok(WINDOWS_BATCH_SHIM_UNSAFE_ARGUMENT.test(`a${character}b`), JSON.stringify(character));

  const claude = buildClaudeCodeArgs({ mode: "worker", schemaJson: SCHEMA, sessionId: "8aadb5b0-b06a-4394-9b2f-f42614de8239", reasoningEffort: "low" });
  assert.deepEqual(windowsBatchShimRefusedArguments(claude), [claude.indexOf(SCHEMA)]);
  assert.equal(CLI_WORKER_ADAPTERS["claude-code"].schemaDelivery, "inline_argument");
  // Codex and agy take the schema as a file; their arguments pass the guard while the Runner's paths do.
  const codex = buildCodexArgs({ mode: "worker", schemaPath: "C:\\Users\\me\\.aiboard\\state\\cli-workers\\r\\s\\result.schema.json", outputPath: "C:\\Users\\me\\.aiboard\\state\\cli-workers\\r\\s\\last-message.json", worktree: "C:\\repo\\.aiboard\\worktrees\\t1", model: "gpt-6.1-sol", reasoningEffort: "high" });
  assert.deepEqual(windowsBatchShimRefusedArguments(codex), []);
  assert.deepEqual(windowsBatchShimRefusedArguments(buildAgyArgs({ mode: "worker", schemaPath: "C:\\Users\\me\\.aiboard\\state\\s.json", model: "claude-opus-5-5-low" })), []);
  // A path with parentheses would be refused through a shim ("Program Files (x86)").
  assert.deepEqual(windowsBatchShimRefusedArguments(["-C", "C:\\Program Files (x86)\\w"]), [1]);
});

test("lookup: the home's path wins; on Windows only .exe and .cmd are launched", async () => {
  const lookupOf = (result: Awaited<ReturnType<CheckToolLookup>>, seen: string[] = []): CheckToolLookup => async (executable) => { seen.push(executable); return result; };
  const seen: string[] = [];
  assert.deepEqual(await resolveCliExecutable({ providerId: "claude-code", lookup: lookupOf({ status: "found", path: "C:\\bin\\claude.exe" }, seen), cwd: "C:\\w", platform: "win32" }),
    { status: "found", path: "C:\\bin\\claude.exe", source: "path", form: "exe" });
  assert.deepEqual(seen, ["claude"]);
  assert.deepEqual(await resolveCliExecutable({ providerId: "codex-cli", lookup: lookupOf({ status: "found", path: "C:\\npm\\codex.CMD" }), cwd: "C:\\w", platform: "win32" }),
    { status: "found", path: "C:\\npm\\codex.CMD", source: "path", form: "cmd" });
  const ps1 = await resolveCliExecutable({ providerId: "agy", lookup: lookupOf({ status: "found", path: "C:\\bin\\agy.ps1" }), cwd: "C:\\w", platform: "win32" });
  assert.equal(ps1.status, "refused");
  assert.deepEqual(await resolveCliExecutable({ providerId: "agy", lookup: lookupOf({ status: "found", path: "/usr/bin/agy" }), cwd: "/w", platform: "linux" }),
    { status: "found", path: "/usr/bin/agy", source: "path", form: "native" });
  assert.deepEqual(await resolveCliExecutable({ providerId: "agy", lookup: lookupOf({ status: "missing" }), cwd: "/w", platform: "linux" }), { status: "missing", source: "path" });
  // VF2's lookup searches its own folder before PATH on Windows: a CLI found there (a claude.cmd committed at a
  // repository's root, if a caller passed the worktree) is refused, never launched with the bypass flags.
  const shadow = await resolveCliExecutable({ providerId: "claude-code", lookup: lookupOf({ status: "found", path: "C:\\Repo\\claude.cmd" }), cwd: "c:\\repo\\", platform: "win32" });
  assert.equal(shadow.status, "refused");
  assert.equal((await resolveCliExecutable({ providerId: "agy", lookup: lookupOf({ status: "found", path: "/w/agy" }), cwd: "/w", platform: "linux" })).status, "refused");
  assert.deepEqual(await resolveCliExecutable({ providerId: "agy", lookup: lookupOf({ status: "unknown", reason: "no PATH" }), cwd: "/w", platform: "linux" }), { status: "unknown", source: "path", reason: "no PATH" });

  const never: CheckToolLookup = async () => { throw new Error("the home's path is not looked up on PATH"); };
  const inspect = (state: "file" | "absent" | "unknown") => async () => state;
  assert.deepEqual(await resolveCliExecutable({ providerId: "codex-cli", executablePath: "D:\\tools\\codex.exe", lookup: never, cwd: "C:\\w", platform: "win32", inspect: inspect("file") }),
    { status: "found", path: "D:\\tools\\codex.exe", source: "home", form: "exe" });
  assert.deepEqual(await resolveCliExecutable({ providerId: "codex-cli", executablePath: "D:\\tools\\codex.exe", lookup: never, cwd: "C:\\w", platform: "win32", inspect: inspect("absent") }),
    { status: "missing", source: "home" });
  for (const path of ["codex.exe", "D:\\tools\\codex.bat", "D:\\tools\\codex", ""]) {
    assert.equal((await resolveCliExecutable({ providerId: "codex-cli", executablePath: path, lookup: never, cwd: "C:\\w", platform: "win32", inspect: inspect("file") })).status, "refused", path);
  }
  assert.equal(CLI_WORKER_ADAPTERS["claude-code"].executableName, "claude");
  assert.deepEqual(cliExecutableMissingFailure("agy", NOW).kind, "authentication");
});

test("facts for CW3 and CW4: the per-OS refusals of §3.11 and the root refusal of §3.12, stated, not enforced", () => {
  const allowed = (id: CliWorkerProviderId, platform: NodeJS.Platform) => cliWorkerPlatformRefusal(id, platform) === undefined;
  assert.deepEqual(CLI_WORKER_PROVIDER_IDS.map((id) => [id, allowed(id, "win32"), allowed(id, "linux"), allowed(id, "darwin"), allowed(id, "freebsd")]), [
    ["codex-cli", false, false, false, false],
    ["claude-code", true, false, false, false],
    ["agy", true, false, false, false],
  ]);
  assert.match(cliWorkerPlatformRefusal("codex-cli", "linux")!, /Codex runs its commands outside the process group AIBoard can stop/);
  assert.match(cliWorkerRootRefusal("claude-code")!, /refuses to skip its permission prompts as root/);
  assert.equal(cliWorkerRootRefusal("codex-cli"), undefined);
  assert.equal(cliWorkerRootRefusal("agy"), undefined);
});

/** Runs the fake with its scenario written in `directory`, from `cwd` (the CLI's worktree; `directory` by default). */
function runFake(scenario: Parameters<typeof writeFakeCliScenario>[1], args: string[], stdin: string, directory: string, cwd = directory) {
  const scenarioPath = writeFakeCliScenario(directory, scenario);
  return spawnSync(process.execPath, [FAKE_CLI_SCRIPT, ...args], {
    input: stdin, cwd, encoding: "utf8", env: { ...process.env, [FAKE_CLI_SCENARIO_ENV]: scenarioPath }, timeout: 30_000,
  });
}

test("the fake CLIs replay a fixture from the CLI's argv and stdin", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "aiboard-fake-cli-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const prompt = buildCliWorkerPrompt({ taskContext: "Add mul." });

  // Codex: the -o file is written from the fixture, stdout replayed byte for byte, argv and stdin recorded.
  const outputPath = join(directory, "last-message.json");
  const codexArgs = buildCodexArgs({ mode: "worker", schemaPath: join(directory, "schema.json"), outputPath, worktree: directory });
  const codex = runFake({ cli: "codex-cli", expectArgs: codexArgs, stdout: cliFixture("codex-cli/success.windows.stdout.jsonl"), outputFile: cliFixture("codex-cli/success.windows.last-message.json"), exitCode: 0, record: "codex-run.json" },
    codexArgs, buildCliWorkerStdin("codex-cli", prompt), directory);
  assert.equal(codex.status, 0, codex.stderr);
  assert.equal(codex.stdout, fixture("codex-cli/success.windows.stdout.jsonl"));
  const recorded = JSON.parse(readFileSync(join(directory, "codex-run.json"), "utf8"));
  assert.deepEqual(recorded.argv, codexArgs);
  assert.equal(recorded.stdin, buildCliWorkerStdin("codex-cli", prompt));
  const reading = CLI_WORKER_ADAPTERS["codex-cli"].readRun({ stdout: codex.stdout, exitCode: codex.status, outputFile: readFileSync(outputPath), now: NOW });
  assert.equal(reading.outcome.type, "result");

  // A killed Codex run leaves its -o file at 0 bytes.
  const killed = runFake({ cli: "codex-cli", stdout: cliFixture("codex-cli/killed.windows.stdout.jsonl"), exitCode: 1 }, codexArgs, "x\n", directory);
  assert.equal(killed.status, 1);
  assert.equal(readFileSync(outputPath).length, 0);

  // agy: the stream-json line is accepted; a message without `event` is refused as agy refuses it.
  const agyArgs = buildAgyArgs({ mode: "worker", schemaPath: join(directory, "schema.json") });
  const agy = runFake({ cli: "agy", stdout: cliFixture("agy/success.windows.stdout.jsonl"), exitCode: 0 }, agyArgs, buildCliWorkerStdin("agy", prompt), directory);
  assert.equal(agy.status, 0, agy.stderr);
  assert.equal(CLI_WORKER_ADAPTERS.agy.readRun({ stdout: agy.stdout, exitCode: agy.status, now: NOW }).outcome.type, "result");
  const refused = runFake({ cli: "agy", stdout: cliFixture("agy/success.windows.stdout.jsonl"), exitCode: 0 }, agyArgs, `${JSON.stringify({ type: "user", message: { content: prompt } })}\n`, directory);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /missing the "event" field/);

  // Free checks: an exact argv answers with its own output; unexpected run arguments fail loudly.
  const login = runFake({ cli: "claude-code", responses: [{ args: ["auth", "status"], stdout: cliFixture("claude-code/free/auth-status.logged-out.json"), exitCode: 1 }] }, ["auth", "status"], "", directory);
  assert.equal(login.status, 1);
  assert.deepEqual(parseClaudeAuthStatus({ exitCode: login.status, stdout: login.stdout, stderr: login.stderr }), { status: "logged_out" });
  const wrong = runFake({ cli: "claude-code", expectArgs: ["-p"], stdout: cliFixture("claude-code/success.windows.stdout.json") }, ["-p", "--verbose"], "x", directory);
  assert.equal(wrong.status, 64);
});

test("the fake CLIs: unmatched argv exits before stdin, no stray -o file, the grandchild's pid, and worktree actions", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "aiboard-fake-cli-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));

  // Unexpected arguments exit 64 while stdin is still open: a test never hangs on it.
  const scenarioPath = writeFakeCliScenario(directory, { cli: "claude-code", expectArgs: ["-p"], stdout: cliFixture("claude-code/success.windows.stdout.json") }, "open-stdin.json");
  const child = spawn(process.execPath, [FAKE_CLI_SCRIPT, "-p", "--verbose"], { cwd: directory, env: { ...process.env, [FAKE_CLI_SCENARIO_ENV]: scenarioPath }, stdio: ["pipe", "ignore", "pipe"] });
  const status = await new Promise<number | null>((resolve) => child.once("exit", resolve));
  child.stdin.destroy();
  assert.equal(status, 64);

  // A Codex run without -o writes no file named after its first argument.
  const before = new Set(readdirSync(directory));
  const noOutput = runFake({ cli: "codex-cli", stdout: cliFixture("codex-cli/success.windows.stdout.jsonl") }, ["exec", "--json", "-"], "x\n", directory);
  assert.equal(noOutput.status, 0, noOutput.stderr);
  assert.deepEqual(readdirSync(directory).filter((name) => !before.has(name) && name !== "fake-cli-scenario.json"), []);

  // The grandchild's pid is recorded, so a later test can prove it stopped; actions write and commit in the cwd.
  const repo = join(directory, "repo");
  mkdirSync(repo);
  for (const args of [["init", "-q"], ["config", "commit.gpgsign", "false"], ["config", "user.name", "t"], ["config", "user.email", "t@example.invalid"],
    ["commit", "-q", "--allow-empty", "-m", "base"]]) {
    assert.equal(spawnSync("git", args, { cwd: repo, encoding: "utf8" }).status, 0, args.join(" "));
  }
  const agyArgs = buildAgyArgs({ mode: "worker", schemaPath: join(directory, "schema.json") });
  const actions = [{ write: "docs/project/plan.md", content: "edited by the CLI\n" }, { commit: "cli commit" }];
  // agy refuses a bad stream message before any action or child, as real agy does.
  const refused = runFake({ cli: "agy", stdout: cliFixture("agy/success.windows.stdout.jsonl"), grandchildMs: 200, actions, record: join(directory, "refused-run.json") },
    agyArgs, `${JSON.stringify({ type: "user", message: { content: "x" } })}\n`, directory, repo);
  assert.equal(refused.status, 1);
  assert.equal(existsSync(join(repo, "docs")), false);
  assert.equal((JSON.parse(readFileSync(join(directory, "refused-run.json"), "utf8")) as FakeCliRecord).grandchildPid, undefined);
  // The scenario file is written outside the repository, so the CLI's commit holds only what its actions changed.
  const acted = runFake({ cli: "agy", stdout: cliFixture("agy/success.windows.stdout.jsonl"), grandchildMs: 200, record: join(directory, "agy-run.json"), actions },
    agyArgs, buildCliWorkerStdin("agy", "Add mul."), directory, repo);
  assert.equal(acted.status, 0, acted.stderr);
  const record = JSON.parse(readFileSync(join(directory, "agy-run.json"), "utf8")) as FakeCliRecord;
  assert.ok(Number.isSafeInteger(record.grandchildPid) && record.grandchildPid! > 0);
  // process.cwd() is the real path: on macOS the temp folder under /var is reached through /private/var.
  assert.equal(record.cwd, realpathSync.native(repo));
  assert.equal(readFileSync(join(repo, "docs", "project", "plan.md"), "utf8"), "edited by the CLI\n");
  assert.equal(spawnSync("git", ["log", "-1", "--format=%s"], { cwd: repo, encoding: "utf8" }).stdout.trim(), "cli commit");
  assert.deepEqual(spawnSync("git", ["show", "--name-only", "--format=", "HEAD"], { cwd: repo, encoding: "utf8" }).stdout.trim().split(/\r?\n/), ["docs/project/plan.md"]);
});

test("the fake CLI's detached grandchild outlives the fake, so a stop test can prove it stopped", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "aiboard-fake-cli-"));
  let pid: number | undefined;
  t.after(() => {
    if (pid) try { process.kill(pid); } catch { /* already gone */ }
    rmSync(directory, { recursive: true, force: true });
  });
  const run = runFake({ cli: "claude-code", stdout: cliFixture("claude-code/success.windows.stdout.json"), grandchildMs: 30_000, grandchildDetached: true, record: "detached-run.json" },
    // Started outside the folder the test removes: on Windows a live process's working folder cannot be deleted.
    ["-p"], "x", directory, tmpdir());
  assert.equal(run.status, 0, run.stderr);
  pid = (JSON.parse(readFileSync(join(directory, "detached-run.json"), "utf8")) as FakeCliRecord).grandchildPid;
  assert.ok(pid && pid > 0);
  // Signal 0 only asks whether the process exists: the fake has exited and its detached grandchild is still there.
  assert.doesNotThrow(() => process.kill(pid!, 0));
});
