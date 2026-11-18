/**
 * CW5: the CLI worker loop (docs/plans/2026-11-14-cli-workers.md §3.5, §3.10, §3.11), part 2 of 3: the stop. §3.11
 * case 2 (an unproven stop and its later collect), the deadline, a cancel, case 3 (no browser), and a wait that fails
 * after the launch. No real CLI is started and no prompt is sent; host facts are injected.
 */
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import {
  CLI_COLLECT_PENDING_PREFIX,
  CLI_COLLECT_WORKTREE_CHANGED,
  cliWorkerStateFolder,
  runCliWorkerAttempt,
  type CliProcessLauncher,
} from "../src/cli-worker-runtime.js";
import { FAKE_CLI_SCRIPT } from "./support/fake-cli.js";
import { RUN, TASK, SESSION, OWNER, harness, claudeStream, claudeWorking, records, done } from "./support/cli-worker-runtime-harness.js";

test("case 2: a result whose stop is unproven is recorded uncollected; the proven retry collects it without a CLI", async (t) => {
  const h = await harness(t, "case2");
  const launcher = h.launcher({ cli: "claude-code", stdout: claudeStream(h, done()), actions: [{ write: "value.txt", content: "two\n" }] });
  launcher.stopFailures = 1;
  const deps = h.deps(launcher, { rerunChecks: h.rerun });
  const first = await runCliWorkerAttempt(deps, h.input());
  assert.equal(first.type, "stop_unproven");
  if (first.type !== "stop_unproven") return;
  assert.deepEqual(first.outcome, { type: "paused", reason: `${CLI_COLLECT_PENDING_PREFIX}${TASK}` });
  assert.match(first.reason, /the stop of its processes is not proven: Shared managed cleanup did not prove release\./);
  const [pending] = records(h);
  assert.equal(pending?.collected, false);
  assert.ok(pending?.resultDigest && pending.worktree?.head && pending.worktree.tree);
  assert.equal(h.owners.has(OWNER), true, "the owner keeps its depth until its stop is proven");
  // Nothing was submitted, and the worktree still holds the CLI's change.
  assert.equal((await h.sessions.load(SESSION)).status !== "submitted", true);
  assert.equal(readFileSync(join(h.workspace.path, "value.txt"), "utf8"), "two\n");

  // The collect proves the stop itself, not only the scheduler's retried stop: still unproven, it keeps waiting.
  launcher.stopFailures = 1;
  const waiting = await runCliWorkerAttempt(deps, h.input());
  assert.deepEqual(waiting.type === "stop_unproven" && waiting.outcome, { type: "paused", reason: `${CLI_COLLECT_PENDING_PREFIX}${TASK}` });
  assert.equal(records(h).length, 1);
  const second = await runCliWorkerAttempt(deps, h.input());
  assert.equal(second.type, "submitted", JSON.stringify(second));
  assert.equal(launcher.starts.length, 1, "the collect starts no CLI");
  assert.deepEqual(records(h).map((record) => record.collected), [false, true]);
  assert.equal(h.owners.has(OWNER), false);
});

test("case 2: a worktree changed after the unproven stop is never collected", async (t) => {
  const h = await harness(t, "case2-changed");
  const launcher = h.launcher({ cli: "claude-code", stdout: claudeStream(h, done()), actions: [{ write: "value.txt", content: "two\n" }] });
  launcher.stopFailures = 1;
  const deps = h.deps(launcher, { rerunChecks: h.rerun });
  assert.equal((await runCliWorkerAttempt(deps, h.input())).type, "stop_unproven");
  writeFileSync(join(h.workspace.path, "value.txt"), "three\n");
  const second = await runCliWorkerAttempt(deps, h.input());
  assert.equal(second.type, "settled");
  assert.match(JSON.stringify(second), new RegExp(`${CLI_COLLECT_WORKTREE_CHANGED}: the working files differ`));

  // The Runner's result file is checked against its digest too.
  const h2 = await harness(t, "case2-file");
  const launcher2 = h2.launcher({ cli: "claude-code", stdout: claudeStream(h2, done()) });
  launcher2.stopFailures = 1;
  const deps2 = h2.deps(launcher2);
  assert.equal((await runCliWorkerAttempt(deps2, h2.input())).type, "stop_unproven");
  const file = join(cliWorkerStateFolder(h2.state, RUN, SESSION), "run-1.result.json");
  writeFileSync(file, readFileSync(file, "utf8").replace("Changed value.txt", "Claimed value.txt"));
  assert.match(JSON.stringify(await runCliWorkerAttempt(deps2, h2.input())), /differs from its recorded digest/);
});

test("case 2: a CLI still running at an unproven stop keeps failed process_stop_unproven", async (t) => {
  const h = await harness(t, "case2-running");
  const launcher = h.launcher({ cli: "claude-code", stdout: claudeWorking(h), holdMs: 30_000 });
  launcher.stopFailures = 1;
  const result = await runCliWorkerAttempt(h.deps(launcher, { settings: async () => ({
    executable: { status: "found", path: process.execPath, source: "home", form: "exe" }, attemptLimitMs: 300, argsPrefix: [FAKE_CLI_SCRIPT],
  }) }), h.input());
  assert.equal(result.type, "stop_unproven");
  if (result.type !== "stop_unproven") return;
  assert.deepEqual(result.outcome, { type: "failed", reason: "process_stop_unproven" });
  assert.match(result.reason, /was stopped by the Runner's deadline without a result/);
  assert.equal(records(h).length, 0);
});

test("case 2: a browser still running after the stop leaves it unproven until a later check proves it gone", async (t) => {
  const h = await harness(t, "case2-browser");
  const launcher = h.launcher({ cli: "claude-code", stdout: claudeStream(h, done()) });
  // The owner folder's browser, as checkOwnerBrowsers reads it afresh after every proven stop: a known escape stays
  // escaped on every later check while it runs.
  let browser: "escaped" | "exited" | "unknown" = "escaped";
  const checks: string[] = [];
  const deps = h.deps(launcher, { rerunChecks: h.rerun, browser: { checkAfterStop: async () => { checks.push(browser); return browser; } } });
  const first = await runCliWorkerAttempt(deps, h.input());
  assert.equal(first.type, "stop_unproven");
  assert.match(JSON.stringify(first), /the browser the CLI's session ran is still running/);
  assert.equal(records(h)[0]?.collected, false);
  // The next run checks again before it collects: still escaped, still pending.
  assert.deepEqual((await runCliWorkerAttempt(deps, h.input())).type === "stop_unproven", true);
  browser = "unknown";
  assert.match(JSON.stringify(await runCliWorkerAttempt(deps, h.input())), /not known to be stopped/);
  browser = "exited";
  assert.equal((await runCliWorkerAttempt(deps, h.input())).type, "submitted");
  assert.deepEqual(checks, ["escaped", "escaped", "unknown", "exited"]);
  assert.equal(launcher.starts.length, 1);
});

test("the deadline stops a CLI that never ends its turn: the deadline outcome, not a CLI failure", async (t) => {
  const h = await harness(t, "deadline");
  const launcher = h.launcher({ cli: "claude-code", stdout: claudeWorking(h), holdMs: 30_000 });
  const result = await runCliWorkerAttempt(h.deps(launcher, { settings: async () => ({
    executable: { status: "found", path: process.execPath, source: "home", form: "exe" }, attemptLimitMs: 300, argsPrefix: [FAKE_CLI_SCRIPT],
  }) }), h.input());
  assert.equal(result.type, "settled");
  assert.match(JSON.stringify(result), /cli_attempt_deadline: Claude Code did not finish within its time limit/);
  assert.equal(records(h)[0]?.stoppedBy, "deadline");
});

test("a cancel stops the CLI and pauses the attempt", async (t) => {
  const h = await harness(t, "cancel");
  const launcher = h.launcher({ cli: "claude-code", stdout: claudeWorking(h), holdMs: 30_000 });
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 300);
  const result = await runCliWorkerAttempt(h.deps(launcher), h.input({ signal: controller.signal }));
  assert.deepEqual(result, { type: "settled", outcome: { type: "paused", reason: "worker_cancelled" } });
  assert.equal(records(h)[0]?.stoppedBy, "cancelled");
  assert.equal(launcher.stops, 1);
});

test("a cancel that lands while the CLI is launching stops it and pauses the attempt", async (t) => {
  const h = await harness(t, "cancel-launch");
  const launcher = h.launcher({ cli: "claude-code", stdout: claudeWorking(h), holdMs: 30_000 });
  const controller = new AbortController();
  const start = launcher.start.bind(launcher);
  launcher.start = async (input) => {
    const handle = await start(input);
    controller.abort();
    return handle;
  };
  const result = await runCliWorkerAttempt(h.deps(launcher), h.input({ signal: controller.signal }));
  assert.deepEqual(result, { type: "settled", outcome: { type: "paused", reason: "worker_cancelled" } });
  assert.equal(launcher.stops, 1);
  assert.equal(h.owners.has(OWNER), false);
});

test("case 3: a browser session that does not start is recorded, and the CLI runs without a browser", async (t) => {
  const h = await harness(t, "case3");
  const record = join(h.root, "fake", "run3.json");
  const launcher = h.launcher({ cli: "claude-code", stdout: claudeStream(h, done()), record });
  let rerunSawBrowser: boolean | undefined;
  const deps = h.deps(launcher, {
    browser: { start: async () => { throw new Error("playwright-cli is not installed"); } },
    rerunChecks: async (input) => { rerunSawBrowser = input.browserUnavailable; return await h.rerun(input); },
  });
  assert.equal((await runCliWorkerAttempt(deps, h.input())).type, "submitted");
  assert.match((JSON.parse(readFileSync(record, "utf8")) as { stdin: string }).stdin, /No browser is running for this task/);
  assert.deepEqual(records(h)[0]?.browser, { status: "start_failed", reason: "playwright-cli is not installed" });
  assert.equal(rerunSawBrowser, true);
});

test("a run whose wait fails after the launch stands only once the owner's stop is proven", async (t) => {
  const h = await harness(t, "wait-fails");
  const failing = (stopFailures: number, at: "write" | "read" = "write"): CliProcessLauncher & { stops: number } => {
    const launcher = {
      stops: 0,
      async start() {
        return {
          processId: "proc",
          async write() { if (at === "write") throw new Error("The CLI's stdin was not delivered (outcome_unknown: process_input_outcome_unknown)."); },
          async read(): Promise<never> { throw new Error("The CLI's output could not be read."); },
        };
      },
      async stopOwner() {
        launcher.stops += 1;
        if (stopFailures-- > 0) throw Object.assign(new Error("Shared managed cleanup did not prove release."), { code: "process_cleanup_unverified" });
      },
    };
    return launcher;
  };
  const unproven = failing(1);
  const result = await runCliWorkerAttempt(h.deps(unproven), h.input());
  assert.equal(result.type, "stop_unproven");
  assert.deepEqual((result as { outcome: unknown }).outcome, { type: "failed", reason: "process_stop_unproven" });
  assert.match((result as { reason: string }).reason, /stdin was not delivered.*the stop of its processes is not proven/);
  assert.equal(h.owners.has(OWNER), true);
  // Proven stopped, a prompt that never reached the CLI (a write past its limit) is the Runner's coded failure: not a
  // provider failure, so the driver leaves the CLI's health as it is.
  const proven = failing(0);
  const undelivered = await runCliWorkerAttempt(h.deps(proven), h.input());
  assert.equal(undelivered.type, "settled");
  assert.match(JSON.stringify(undelivered), /"reason":"cli_stdin_undelivered: The prompt's write 1 of 1 to the CLI's stdin was not delivered: .*outcome_unknown/);
  assert.equal(proven.stops, 1);
  assert.equal(h.owners.has(OWNER), false);
  // Any other failure of the wait stands as thrown once the stop is proven.
  const unreadable = failing(0, "read");
  await assert.rejects(runCliWorkerAttempt(h.deps(unreadable), h.input()), /output could not be read/);
  assert.equal(unreadable.stops, 1);
  assert.equal(h.owners.has(OWNER), false);
});
