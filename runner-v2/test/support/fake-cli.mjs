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
//   "grandchildMs": 0,                              // start a child that lives this long
//   "grandchildDetached": false,                    // see below: true for a "grandchild proven stopped" test
//   "actions": [{ "write": "docs/project/x.md", "content": "…" }, { "commit": "message" },  // in the cwd, before output
//               { "run": ["playwright-cli", "--json", "goto", "http://…"] }],  // a command on PATH, as the CLI's shell runs it
//   "record": "run.json",                           // written: { argv, stdin, cwd, grandchildPid?, grandchildToken?, mcpDepth?, runs? } before any output
//   "recordMcpDepth": false                         // true: the record carries AIBOARD_MCP_DEPTH, the only variable it reads
// }
//
// Launching it: tests run [process.execPath, FAKE_CLI_SCRIPT, ...argv] (fake-cli.ts). That is the seam on Windows too:
// the CLI lookup accepts only an .exe or a .cmd, and a .cmd can never carry Claude Code's inline schema (both Windows
// launchers refuse a quote in a .cmd argument), so a test injects the node command where the resolved CLI path would
// go instead of hiding the fake behind a .cmd shim.
//
// The grandchild, for CW5: by default it is an ordinary child. On Windows libuv puts every child it spawns without
// `detached` in a kill-on-close job of its own, so that grandchild dies with the fake and a "grandchild proven
// stopped" test proves nothing there. With "grandchildDetached": true it is spawned detached: outside libuv's job (and,
// on POSIX, in a new session), so it outlives the fake unless the Runner stops it. Under the Runner's Windows Job, which
// allows no breakaway, it is still inside that Job; on POSIX it has left the process group, as a CLI's setsid commands
// do (CW0), so a POSIX test of it shows what the Runner cannot prove stopped.
//
// The grandchild's command line carries a token the record names. Windows can give a freed process ID to a later process
// within seconds, so a test that finds the ID still answering asks whether that process is the grandchild (fake-cli.ts
// fakeGrandchildAlive) before calling it alive.
//
// The run's order: argv is checked against expectArgs before stdin is read (a mismatch exits 64 at once, never waiting
// on an open stdin); then stdin is read to EOF and, for agy, refused as agy would before anything else; then Codex's
// -o file is created empty, the grandchild started, the actions run, the record written, and the output replayed.
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
  if (scenario.expectArgs && !sameArgs(scenario.expectArgs, argv)) {
    process.stderr.write(`fake-cli: unexpected arguments ${JSON.stringify(argv)}\n`);
    process.exit(64);
  }
  const stdin = await readStdin();
  // agy refuses a bad stream message before it does anything else (CW0): no file, no child, no action.
  if (scenario.cli === "agy" && !agyInputAccepted(stdin)) {
    if (scenario.record) writeFileSync(at(scenario.record), JSON.stringify({ argv, stdin, cwd: process.cwd() }, null, 2));
    return;
  }
  const outputFlag = scenario.cli === "codex-cli" ? argv.indexOf("-o") : -1;
  const outputPath = outputFlag >= 0 && argv[outputFlag + 1] ? argv[outputFlag + 1] : undefined;
  // Codex creates its -o file at once; it is still 0 bytes when the run fails or is killed (CW0).
  if (outputPath) writeFileSync(outputPath, "");
  let grandchild, grandchildToken;
  if (scenario.grandchildMs > 0) {
    grandchildToken = `aiboard-fake-grandchild-${randomUUID()}`;
    grandchild = spawn(process.execPath, ["-e", `setTimeout(() => {}, ${Number(scenario.grandchildMs)}); // ${grandchildToken}`],
      { stdio: "ignore", detached: scenario.grandchildDetached === true });
  }
  const runs = [];
  for (const action of scenario.actions ?? []) act(action, runs);
  if (scenario.record) {
    writeFileSync(at(scenario.record), JSON.stringify({
      argv, stdin, cwd: process.cwd(), ...(grandchild ? { grandchildPid: grandchild.pid, grandchildToken } : {}), ...(runs.length ? { runs } : {}),
      // Only this one variable of the environment is ever written down.
      ...(scenario.recordMcpDepth === true ? { mcpDepth: process.env.AIBOARD_MCP_DEPTH ?? null } : {}),
    }, null, 2));
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

// What a CLI may do in its worktree at Full access: write a file (docs/project/** included), commit, or run a command
// found on PATH in its environment (CW8: `playwright-cli`, which reaches the owner's browser session). A run's exit code
// and output are recorded, never thrown: a failed command is something a CLI sees and reports.
function act(action, runs) {
  if (Array.isArray(action.run)) {
    const [command, ...args] = action.run;
    // A Windows command shim (.cmd) runs through cmd.exe, as a CLI's shell runs it; the tests' arguments hold no cmd
    // metacharacters.
    const result = spawnSync(command, args, { cwd: process.cwd(), encoding: "utf8", shell: process.platform === "win32", windowsHide: true });
    runs.push({ args: action.run, exitCode: result.status, stdout: (result.stdout ?? "").slice(0, 2_000), stderr: (result.stderr ?? "").slice(0, 2_000) });
    return;
  }
  if (typeof action.write === "string") {
    const target = resolve(process.cwd(), action.write);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, action.content ?? "");
    return;
  }
  if (typeof action.commit === "string") {
    const identity = ["-c", "user.name=Fake CLI", "-c", "user.email=fake-cli@example.invalid", "-c", "commit.gpgsign=false"];
    for (const args of [["add", "-A"], [...identity, "commit", "-q", "-m", action.commit]]) {
      const result = spawnSync("git", args, { cwd: process.cwd(), encoding: "utf8" });
      if (result.status !== 0) throw new Error(`fake-cli: git ${args.join(" ")} failed: ${result.stderr}`);
    }
    return;
  }
  throw new Error(`fake-cli: unknown action ${JSON.stringify(action)}`);
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
