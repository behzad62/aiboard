import assert from "node:assert/strict";
import test from "node:test";

import { ManagedProcessError, type ManagedOutputUntil } from "../src/managed-process-contracts.js";
import {
  evaluateCompletion,
  exitProven,
  interactionState,
  MANAGED_PATTERN_EVAL_TIMEOUT_MS,
  matchKnownPrompt,
  matchOutputPattern,
  renderPlain,
  reportedStatus,
  sliceLines,
  summarizeOutput,
  timeoutCompletion,
  validateOutputPattern,
  validateUntil,
  type ManagedCompletionFacts,
} from "../src/managed-process-wait.js";

const invalidArguments = (error: unknown) => error instanceof ManagedProcessError && error.code === "invalid_arguments";

test("validateUntil normalizes {} to the default idle wait and freezes its result", () => {
  const until = validateUntil({});
  assert.deepEqual(until, { idleMs: 1500 });
  assert.ok(Object.isFrozen(until));
  assert.deepEqual(validateUntil({ pattern: "ready", patternFlags: "i", port: 3000, idleMs: 250 }), { pattern: "ready", patternFlags: "i", port: 3000, idleMs: 250 });
  assert.deepEqual(validateUntil({ exit: true }), { exit: true });
});

test("validateUntil rejects malformed conditions", () => {
  for (const value of [null, [], "x", 1, { other: 1 }, { exit: false }, { exit: true, idleMs: 500 }, { exit: true, pattern: "a" },
    { idleMs: 249 }, { idleMs: 10_001 }, { idleMs: 1.5 }, { port: 0 }, { port: 65_536 }, { port: 1.5 }, { port: "80" },
    { patternFlags: "i" }, { pattern: "a", patternFlags: "g" }, { pattern: 5 }, { pattern: "(a+)+" }]) {
    assert.throws(() => validateUntil(value), invalidArguments, JSON.stringify(value));
  }
});

test("validateOutputPattern accepts ordinary prompt and readiness patterns", () => {
  for (const pattern of ["\\[y/N\\]", "Password:\\s*$", "ready in \\d+ ms", "Local:\\s+http://", "(?:error|warning) TS\\d+", ">>> $", "(?<word>ab)c", "[(+*)]+", "a{2,3}?b", "colou?r"]) {
    assert.deepEqual(validateOutputPattern(pattern), { ok: true }, pattern);
  }
});

test("validateOutputPattern rejects ReDoS shapes, backreferences, lookaround and bad input quickly", () => {
  const rejected = ["(a+)+$", "(a*)*", "(a+)*", "(\\w+\\s?)+", "((ab)+)+", "(a|aa)+", "(.*a){12}", "((a|b)c)+", "(x)\\1", "(?<n>x)\\k<n>",
    "(?<=a)b", "(?<!a)b", "(?=a)", "(?!a)", "x".repeat(257), "", "(", "a)", "[a"];
  const started = performance.now();
  for (const pattern of rejected) assert.equal(validateOutputPattern(pattern).ok, false, pattern);
  assert.ok(performance.now() - started < 50, "rejection must be decided without evaluating the pattern");
});

test("matchOutputPattern searches only the bounded tail and honors the case flag", () => {
  const early = "READY on port 3000\n" + "x".repeat(10 * 1024);
  assert.equal(matchOutputPattern("READY", undefined, early), undefined);
  assert.equal(matchOutputPattern("READY", undefined, "x".repeat(10 * 1024) + "READY\n"), "READY");
  assert.equal(matchOutputPattern("ready", "i", "Server READY"), "READY");
  assert.equal(matchOutputPattern("ready", undefined, "Server READY"), undefined);
  assert.equal(matchOutputPattern("é$", undefined, "€".repeat(2000) + "é"), "é");
});

test("renderPlain strips escapes and collapses carriage-return progress", () => {
  assert.equal(renderPlain("\x1b[31mred\x1b[0m \x1b[1;32mgreen\x1b[m\n"), "red green\n");
  assert.equal(renderPlain("\x1b]0;title\x07a\x1b]2;other\x1b\\b\n"), "ab\n");
  assert.equal(renderPlain("10%\r50%\r100%\n"), "100%\n");
  assert.equal(renderPlain("downloading\r"), "downloading");
  assert.equal(renderPlain("one\r\ntwo\r\n"), "one\ntwo\n");
  assert.equal(renderPlain("abc\b\bX\n"), "aX\n");
  assert.equal(renderPlain("bell\x07 and\x00 nul\tok"), "bell and nul\tok");
  assert.equal(renderPlain("no newline"), "no newline");
  assert.equal(renderPlain(""), "");
  assert.equal(renderPlain("\ufffd kept\n"), "\ufffd kept\n");
});

test("renderPlain folds runs of more than three identical lines", () => {
  assert.equal(renderPlain("start\n" + "same\n".repeat(10) + "end\n"), "start\nsame\n… (9 more identical lines)\nend\n");
  assert.equal(renderPlain("same\nsame\nsame\n"), "same\nsame\nsame\n");
  const bar = Array.from({ length: 100 }, (_, n) => `\r[${"#".repeat(n % 20)}] ${n}%`).join("") + "\rdone\n";
  assert.equal(renderPlain(bar), "done\n");
});

test("sliceLines returns absolute windows, tails and clamps to retention", () => {
  const plain = "l0\nl1\nl2\nl3\nl4\n";
  assert.deepEqual(sliceLines(plain, { start: 1, count: 2 }), { lines: ["l1", "l2"], startLine: 1, totalLines: 5, firstRetainedLine: 0, hasMore: true });
  assert.deepEqual(sliceLines(plain, { start: -2, count: 10 }), { lines: ["l3", "l4"], startLine: 3, totalLines: 5, firstRetainedLine: 0, hasMore: false });
  assert.deepEqual(sliceLines("r0\nr1\nlast", { start: 2, count: 5 }, 100), { lines: ["r0", "r1", "last"], startLine: 100, totalLines: 103, firstRetainedLine: 100, hasMore: false });
  assert.deepEqual(sliceLines("r0\nr1\nlast", { start: -1, count: 1 }, 100).lines, ["last"]);
  assert.deepEqual(sliceLines(plain, { start: 9, count: 1 }), { lines: [], startLine: 5, totalLines: 5, firstRetainedLine: 0, hasMore: false });
  assert.equal(sliceLines("", { start: 0, count: 1 }).totalLines, 0);
  for (const request of [{ start: 0, count: 0 }, { start: 0, count: 2001 }, { start: 0.5, count: 1 }, { start: 0, count: 1.5 }])
    assert.throws(() => sliceLines(plain, request), invalidArguments);
});

test("summarizeOutput keeps small output and condenses large output around diagnostics", () => {
  assert.deepEqual(summarizeOutput("ok\n"), { text: "ok\n", summarized: false, totalLines: 1, errorLines: [] });
  const lines = Array.from({ length: 1000 }, (_, n) => `line ${n} ${"x".repeat(20)}`);
  lines[500] = "src/app.ts:12:5 - error TS2322: Type 'string' is not assignable";
  lines[600] = "  at run (C:\\repo\\lib\\job.js:88:13)";
  lines[10] = "head error stays in the head";
  const summary = summarizeOutput(lines.join("\n") + "\n");
  assert.equal(summary.summarized, true);
  assert.equal(summary.totalLines, 1000);
  assert.deepEqual(summary.errorLines.map((entry) => entry.line), [500, 600]);
  const text = summary.text.split("\n");
  assert.equal(text[0], lines[0]);
  assert.equal(text[40], "… (880 lines omitted; read the full output by cursor or lines) …");
  assert.equal(text[41], "Diagnostics from omitted lines:");
  assert.equal(text[42], `L500: ${lines[500]}`);
  assert.equal(text.at(-2), lines[999]);
  assert.ok(summary.text.endsWith("\n"));
  const noisy = Array.from({ length: 500 }, (_, n) => `step ${n} failed ${"x".repeat(20)}`).join("\n");
  assert.ok(Buffer.byteLength(noisy) > 8 * 1024);
  assert.equal(summarizeOutput(noisy).errorLines.length, 30);
  const wide = summarizeOutput(Array.from({ length: 50 }, () => "w".repeat(400)).join("\n"));
  assert.equal(wide.summarized, true);
  assert.ok(wide.text.split("\n").every((line) => line.length <= 301));
});

test("matchKnownPrompt recognizes REPL and shell prompts but not prompt-looking output", () => {
  for (const [line, expected] of [[">>> ", ">>> "], ["... ", "... "], ["$ ", "$ "], ["PS C:\\repo> ", "PS C:\\repo> "], ["C:\\repo>", "C:\\repo>"],
    ["In [3]: ", "In [3]: "], ["user=# ", "user=# "], ["app=> ", "app=> "], ["(venv) >>> ", ">>> "], ["mysql> ", "mysql> "]] as const) {
    assert.equal(matchKnownPrompt(line), expected, line);
  }
  for (const line of ["progress 45% ", "Proceed with deploy? [y/N] ", "a > b", "Step 1 of 2 >", "Loading data > ", "cost: 5 $ ", ""])
    assert.equal(matchKnownPrompt(line), undefined, line);
});

const idle: ManagedOutputUntil = Object.freeze({ idleMs: 1500 });
function facts(overrides: Partial<ManagedCompletionFacts>): ManagedCompletionFacts {
  return { until: idle, running: true, exitProven: true, newBytes: 10, quietMs: 0, tailEndsWithNewline: false, plainNewTail: "", lastLine: "", ...overrides };
}

test("dc replay: a program's own [y/N] prompt is likely input_wait after the quiet window", () => {
  assert.deepEqual(evaluateCompletion(facts({ quietMs: 1600, cpuDeltaMs: 3, plainNewTail: "Proceed with deploy? [y/N] ", lastLine: "Proceed with deploy? [y/N] " })),
    { source: "input_wait", confidence: "likely", quietMs: 1600, cpuDeltaMs: 3 });
  assert.deepEqual(evaluateCompletion(facts({ quietMs: 1600, cpuDeltaMs: 0, stdinReadObserved: true, lastLine: "Proceed? " })),
    { source: "input_wait", confidence: "certain", quietMs: 1600, cpuDeltaMs: 0 });
});

test("dc replay: progress 45% with a busy CPU keeps waiting", () => {
  assert.equal(evaluateCompletion(facts({ quietMs: 1600, cpuDeltaMs: 1500, lastLine: "progress 45% " })), undefined);
  assert.equal(evaluateCompletion(facts({ quietMs: 5000, cpuDeltaMs: 4900, lastLine: "progress 45% " })), undefined);
});

test("dc replay: progress 45% while sleeping is at most likely, never certain", () => {
  const sleeping = evaluateCompletion(facts({ quietMs: 1600, cpuDeltaMs: 0, lastLine: "progress 45% " }));
  assert.deepEqual(sleeping, { source: "input_wait", confidence: "likely", quietMs: 1600, cpuDeltaMs: 0 });
  assert.deepEqual(evaluateCompletion(facts({ quietMs: 1600, stdinReadObserved: false, lastLine: "progress 45% " })),
    { source: "idle", confidence: "heuristic", quietMs: 1600 });
  for (const cpuDeltaMs of [undefined, 0, 10]) {
    const result = evaluateCompletion(facts({ quietMs: 1600, cpuDeltaMs, lastLine: "progress 45% " }));
    assert.notEqual(result?.confidence, "certain");
  }
});

test("dc replay: no instant prompt guess on the first chunk", () => {
  assert.equal(evaluateCompletion(facts({ quietMs: 173, lastLine: "progress 45% " })), undefined);
  assert.equal(evaluateCompletion(facts({ quietMs: 173, lastLine: ">>> " })), undefined);
});

test("known prompts are a heuristic: after half the window without CPU evidence, after the full window with it", () => {
  assert.deepEqual(evaluateCompletion(facts({ quietMs: 800, lastLine: ">>> " })), { source: "known_prompt", confidence: "heuristic", matched: ">>> ", quietMs: 800 });
  assert.equal(evaluateCompletion(facts({ quietMs: 800, cpuDeltaMs: 0, lastLine: ">>> " })), undefined);
  assert.deepEqual(evaluateCompletion(facts({ quietMs: 1600, cpuDeltaMs: 0, tailEndsWithNewline: true, lastLine: "PS C:\\repo> " })),
    { source: "known_prompt", confidence: "heuristic", matched: "PS C:\\repo> ", quietMs: 1600, cpuDeltaMs: 0 });
  assert.deepEqual(evaluateCompletion(facts({ quietMs: 1600, cpuDeltaMs: 0, tailEndsWithNewline: true, lastLine: "building" })),
    { source: "idle", confidence: "heuristic", quietMs: 1600, cpuDeltaMs: 0 });
});

test("legacy mode keeps today's any-new-byte semantics", () => {
  assert.equal(evaluateCompletion(facts({ until: undefined, newBytes: 0, quietMs: 99_999 })), undefined);
  assert.deepEqual(evaluateCompletion(facts({ until: undefined, newBytes: 5 })), { source: "changed", confidence: null });
});

test("exit beats every condition and until.exit ignores idle and patterns", () => {
  assert.deepEqual(evaluateCompletion(facts({ running: false })), { source: "exited", confidence: "certain" });
  assert.deepEqual(evaluateCompletion(facts({ until: undefined, running: false, newBytes: 0 })), { source: "exited", confidence: "certain" });
  // A session that stopped running without a proven exit (input/backend unavailable, cleanup pending) is never "certain".
  assert.deepEqual(evaluateCompletion(facts({ running: false, exitProven: false })), { source: "unavailable", confidence: null });
  assert.equal(interactionState({ source: "unavailable", confidence: null }, false), "unknown");
  assert.equal(exitProven({ status: "exited_unknown", exitCode: null, signal: null }), false);
  assert.equal(exitProven({ status: "exited_unknown", exitCode: 0, signal: null }), true);
  assert.equal(exitProven({ status: "stopped", exitCode: null, signal: null }), true);
  // The response status follows the same proof: "exited" only beside a proven exit.
  assert.equal(reportedStatus({ status: "exited_unknown", exitCode: 0, signal: null }), "exited");
  assert.equal(reportedStatus({ status: "exited_unknown", exitCode: null, signal: "SIGKILL" }), "exited");
  assert.equal(reportedStatus({ status: "exited_unknown", exitCode: null, signal: null }), "exited_unknown");
  assert.equal(reportedStatus({ status: "running", exitCode: 0, signal: null }), "running");
  assert.equal(reportedStatus({ status: "stopped", exitCode: 0, signal: null }), "stopped");
  assert.equal(evaluateCompletion(facts({ until: { exit: true }, quietMs: 99_999, cpuDeltaMs: 0, lastLine: ">>> " })), undefined);
});

test("pattern and port conditions are certain; a port open before the wait is only a heuristic", () => {
  const until: ManagedOutputUntil = { pattern: "Local:\\s+http://", port: 3000 };
  assert.deepEqual(evaluateCompletion(facts({ until, plainNewTail: "  Local:   http://localhost:3000/\n" })),
    { source: "pattern", confidence: "certain", matched: "Local:   http://" });
  assert.deepEqual(evaluateCompletion(facts({ until, portOpen: true })), { source: "port", confidence: "certain" });
  assert.deepEqual(evaluateCompletion(facts({ until, portOpen: true, preexistingPort: true })), { source: "port", confidence: "heuristic", preexistingPort: true });
  assert.equal(evaluateCompletion(facts({ until, portOpen: false, quietMs: 99_999 })), undefined, "without idleMs, silence alone never ends the wait");
});

test("timeout and interaction states", () => {
  assert.deepEqual(timeoutCompletion(), { source: "timeout", confidence: null });
  assert.equal(interactionState({ source: "input_wait", confidence: "likely" }, true), "awaiting_input");
  assert.equal(interactionState({ source: "known_prompt", confidence: "heuristic" }, true), "awaiting_input");
  assert.equal(interactionState({ source: "idle", confidence: "heuristic" }, true), "idle");
  assert.equal(interactionState({ source: "pattern", confidence: "certain" }, true), "running");
  assert.equal(interactionState(undefined, true), "running");
  assert.equal(interactionState({ source: "input_wait", confidence: "likely" }, false), "exited");
});

test("a polynomial pattern that passes the static screen is stopped by the evaluation bound", () => {
  // Review finding: `a*a*!` passes validateOutputPattern but takes ~10 s on a 4 KiB tail.
  for (const pattern of ["a*a*!", ".*.*.*.*!", "[a]*[a]*[a]*!"]) {
    assert.deepEqual(validateOutputPattern(pattern), { ok: true }, pattern);
    const began = Date.now();
    assert.throws(() => matchOutputPattern(pattern, undefined, "a".repeat(4096)), invalidArguments, pattern);
    assert.ok(Date.now() - began < MANAGED_PATTERN_EVAL_TIMEOUT_MS * 10, `${pattern} took ${Date.now() - began} ms`);
  }
  assert.equal(matchOutputPattern("ready on port (\\d+)", undefined, "x".repeat(4000) + "ready on port 3000"), "ready on port 3000");
});

test("renderPlain stays linear on unterminated OSC and still strips terminated ones", () => {
  const hostile = "\u001b]x".repeat(70_000);
  const began = Date.now();
  renderPlain(hostile);
  assert.ok(Date.now() - began < 500, `unterminated OSC took ${Date.now() - began} ms`);
  assert.equal(renderPlain("a\u001b]0;title\u0007b\u001b]8;;https://x\u001b\\c\n"), "abc\n");
  assert.equal(renderPlain("\u001b]" + "t".repeat(5000) + "\nrest\n").endsWith("rest\n"), true, "an unterminated OSC swallows a bounded body only");
});
