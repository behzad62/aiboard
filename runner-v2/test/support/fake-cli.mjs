#!/usr/bin/env node
// A fake Codex CLI, Claude Code or agy for CLI worker tests (docs/plans/2026-11-14-cli-workers.md §5, packet CW2).
// It reads its argv and stdin like the real CLI and replays a recorded fixture (runner-v2/test/fixtures/cli-workers/).
// No test starts a real CLI or sends a prompt.
//
// The scenario is a JSON file named by AIBOARD_FAKE_CLI_SCENARIO (paths in it are relative to that file):
// {
//   "cli": "codex-cli" | "claude-code" | "agy",
//   "responses": [{ "args": ["login", "status"], "stdout": "…", "stderr": "…", "exitCode": 0 }],  // free checks, exact argv
//   "expectArgs": ["exec", "--json", "<any>", …],   // the run's argv; "<any>" matches one argument
//   "stdout": "codex-cli/success.windows.stdout.jsonl",
//   "stderr": "…",                                  // optional
//   "outputFile": "codex-cli/success.windows.last-message.json",  // Codex: copied to the -o path (else it stays 0 bytes)
//   "exitCode": 0,
//   "lineDelayMs": 0,                               // between stdout lines
//   "holdMs": 0,                                    // stay up after the output, as Claude Code does for a background task
//   "grandchildMs": 0,                              // start a child that lives this long (same process group, not detached)
//   "record": "run.json"                            // written: { argv, stdin, cwd } before any output
// }
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";

const scenarioPath = process.env.AIBOARD_FAKE_CLI_SCENARIO;
if (!scenarioPath) {
  process.stderr.write("fake-cli: AIBOARD_FAKE_CLI_SCENARIO is not set\n");
  process.exit(70);
}
const scenario = JSON.parse(readFileSync(scenarioPath, "utf8"));
const base = dirname(resolve(scenarioPath));
const at = (path) => (isAbsolute(path) ? path : resolve(base, path));
const read = (path) => (path ? readFileSync(at(path)) : Buffer.alloc(0));
const argv = process.argv.slice(2);
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

const response = (scenario.responses ?? []).find((entry) => sameArgs(entry.args, argv));
if (response) {
  process.stdout.write(read(response.stdout));
  process.stderr.write(read(response.stderr));
  process.exitCode = response.exitCode ?? 0;
} else {
  await run();
}

async function run() {
  const stdin = await readStdin();
  if (scenario.record) writeFileSync(at(scenario.record), JSON.stringify({ argv, stdin, cwd: process.cwd() }, null, 2));
  if (scenario.expectArgs && !sameArgs(scenario.expectArgs, argv)) {
    process.stderr.write(`fake-cli: unexpected arguments ${JSON.stringify(argv)}\n`);
    process.exitCode = 64;
    return;
  }
  if (scenario.cli === "agy" && !agyInputAccepted(stdin)) return;
  const outputPath = scenario.cli === "codex-cli" ? argv[argv.indexOf("-o") + 1] : undefined;
  // Codex creates its -o file at once; it is still 0 bytes when the run fails or is killed (CW0).
  if (outputPath) writeFileSync(outputPath, "");
  let grandchild;
  if (scenario.grandchildMs > 0) {
    grandchild = spawn(process.execPath, ["-e", `setTimeout(() => {}, ${Number(scenario.grandchildMs)})`], { stdio: "ignore" });
  }
  const stdout = read(scenario.stdout).toString("utf8");
  for (const line of stdout.split(/(?<=\n)/)) {
    if (!line) continue;
    process.stdout.write(line);
    if (scenario.lineDelayMs > 0) await sleep(scenario.lineDelayMs);
  }
  process.stderr.write(read(scenario.stderr));
  if (outputPath && scenario.outputFile) writeFileSync(outputPath, read(scenario.outputFile));
  if (scenario.holdMs > 0) await sleep(scenario.holdMs);
  grandchild?.unref();
  process.exitCode = scenario.exitCode ?? 0;
}

function sameArgs(expected, actual) {
  return Array.isArray(expected) && expected.length === actual.length &&
    expected.every((value, index) => value === "<any>" || value === actual[index]);
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

// agy refuses a stream message without `event` or `message` before any model call, exit 1 (CW0).
function agyInputAccepted(stdin) {
  let message;
  try {
    message = JSON.parse(stdin.trim().split(/\r?\n/)[0] ?? "");
  } catch {
    message = undefined;
  }
  const error = argv.at(-1) !== "-p=" ? "the prompt flag must be -p= and last"
    : !message || typeof message !== "object" || !("event" in message) ? "stream input message is missing the \"event\" field"
      : !message.message ? "stream input message is missing the \"message\" field"
        : typeof message.message.content !== "string" || !message.message.content ? "empty prompt" : undefined;
  if (!error) return true;
  process.stdout.write(`${JSON.stringify({ event: "result", result: { conversation_id: "", status: "ERROR", response: "", error, duration_seconds: 0, num_turns: 0,
    usage: { input_tokens: 0, output_tokens: 0, thinking_tokens: 0, cache_read_tokens: 0, total_tokens: 0 }, finished_reason: "error" } })}\n`);
  process.stderr.write(`error: ${error}\n`);
  process.exitCode = 1;
  return false;
}
