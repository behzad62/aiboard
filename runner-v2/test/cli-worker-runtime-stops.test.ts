/**
 * CW5: the CLI worker loop (docs/plans/2026-11-14-cli-workers.md §3.5, §3.10, §3.11), part 2 of 3: the stop. §3.11
 * case 2 (an unproven stop and its later collect), the deadline, a cancel, case 3 (no browser), and a wait that fails
 * after the launch. No real CLI is started and no prompt is sent; host facts are injected.
 */
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test, { describe } from "node:test";
import {
  CLI_COLLECT_PENDING_PREFIX,
  CLI_COLLECT_WORKTREE_CHANGED,
  CLI_RERUNS_PENDING_PREFIX,
  cliWorkerStateFolder,
  proveCliStop,
  runCliWorkerAttempt,
  type CliProcessLauncher,
  type CliWorkerLaunchSettings,
  type CliWorkerRuntimeDeps,
} from "../src/cli-worker-runtime.js";
import { restoreWorkingTree } from "../src/command-evidence-identity.js";
import { policyGit } from "./support/cli-worker-fixture.js";
import { FAKE_CLI_SCRIPT, type FakeCliScenario } from "./support/fake-cli.js";
import { RUN, TASK, SESSION, OWNER, harness, claudeStream, claudeWorking, records, done, CLI_RUNTIME_TEST_CONCURRENCY, type Harness } from "./support/cli-worker-runtime-harness.js";

// Each test has its own project, worktree, stores and owner, so a file's tests run side by side: most of their
// time is Git and the fake CLI, which overlap. A test that reads process-wide state runs alone, outside the group.
describe("CW5 loop: the stop, cases 2 and 3", { concurrency: CLI_RUNTIME_TEST_CONCURRENCY }, () => {
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
    const deps = h.deps(launcher, { rerunChecks: h.rerun, browser: {
      checkAfterStop: async () => { checks.push(browser); return browser; },
      escapedPids: () => (browser === "escaped" ? [4242, 4243] : []),
    } });
    const first = await runCliWorkerAttempt(deps, h.input());
    assert.equal(first.type, "stop_unproven");
    // The owner's way out is in the reason: which browser to stop before Resume.
    assert.match(JSON.stringify(first), /the browser the CLI's session ran is still running \(PIDs 4242, 4243\); stop it, then Resume/);
    assert.equal(records(h)[0]?.collected, false);
    // The next run checks again before it collects: still escaped, still pending.
    assert.deepEqual((await runCliWorkerAttempt(deps, h.input())).type === "stop_unproven", true);
    browser = "unknown";
    assert.match(JSON.stringify(await runCliWorkerAttempt(deps, h.input())), /not known to be stopped: the Runner could not read its processes \(the Runner's log names what it found\); Resume checks again/);
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

  test("a prompt still going in ends at the attempt's cancellation or deadline, after the proven stop", async (t) => {
    const h = await harness(t, "prompt-stopped");
    // A CLI that never reads its stdin: each write waits until its signal ends it, as ManagedProcessService's does.
    const unread = (): CliProcessLauncher & { stops: number; signals: Array<AbortSignal | undefined> } => {
      const launcher = {
        stops: 0,
        signals: [] as Array<AbortSignal | undefined>,
        async start() {
          return {
            processId: "proc",
            write: (_text: string, _closeInput: boolean, signal?: AbortSignal) => new Promise<void>((_resolve, reject) => {
              launcher.signals.push(signal);
              // Without a signal the wait would run to the 60 s ceiling: the undelivered failure stands in for it here.
              if (!signal) { reject(new Error("The CLI's stdin was not delivered (outcome_unknown: no signal ended the wait).")); return; }
              const fail = () => reject(new Error("The CLI's stdin was not delivered (outcome_unknown: process_input_outcome_unknown)."));
              if (signal.aborted) fail(); else signal.addEventListener("abort", fail, { once: true });
            }),
            async read(): Promise<never> { throw new Error("no output is read before the prompt is in"); },
          };
        },
        async stopOwner() { launcher.stops += 1; },
      };
      return launcher;
    };
    const cancel = new AbortController();
    const cancelled = unread();
    setTimeout(() => cancel.abort(), 100);
    const started = Date.now();
    const paused = await runCliWorkerAttempt(h.deps(cancelled), h.input({ signal: cancel.signal }));
    assert.deepEqual(paused, { type: "settled", outcome: { type: "paused", reason: "worker_cancelled" } });
    assert.ok(Date.now() - started < 10_000, "the cancellation ends the write's wait, not its 60 s ceiling");
    assert.equal(cancelled.signals.length, 1);
    assert.equal(cancelled.stops, 1);
    assert.equal(h.owners.has(OWNER), false);

    const late = unread();
    const settings = await h.deps(late).settings("claude-code");
    const deadline = await runCliWorkerAttempt(h.deps(late, { settings: async () => ({ ...settings, attemptLimitMs: 300 }) }), h.input());
    assert.equal(deadline.type, "settled");
    assert.match(JSON.stringify(deadline), /"type":"failed","reason":"cli_attempt_deadline: .*prompt was still being delivered/);
    assert.equal(late.signals.length, 1, "the deadline is shared across the prompt's writes, so the wait ends with the first");
    assert.equal(late.stops, 1);
    assert.equal(h.owners.has(OWNER), false);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// CW8: the owner's browser session (§3.10). A fake session that runs from its start until the owner's next proven
// stop, and a fake browser check: after every way an attempt ends, the session is not running, or the stop is not
// proven and nothing is submitted (case 2). cli-worker-browser.test.ts runs the real session path.

interface FakeSession {
  starts: number;
  live: boolean;
  /** Each start's status, in order; the default is "started". */
  plan: Array<"started" | "start_failed">;
  /** Called during a start, before it reports (a cancel that lands while the session starts). */
  during?: () => void;
}

function withSession(h: Harness, launcher: CliProcessLauncher, session: FakeSession, overrides: Partial<CliWorkerRuntimeDeps> = {}): CliWorkerRuntimeDeps {
  // The owner's stop stops the session too, as the managed service's closeAgent does; a stop that throws proves nothing.
  const owned: CliProcessLauncher = {
    start: (input) => launcher.start(input),
    async stopOwner(owner) { await launcher.stopOwner(owner); session.live = false; },
  };
  return h.deps(owned, {
    rerunChecks: h.rerun,
    browser: {
      async start() {
        session.starts += 1;
        session.live = true;
        session.during?.();
        const status = session.plan.shift() ?? "started";
        return status === "started" ? { status, note: "A browser is running for this task." } : { status, reason: "the session's ready wait failed" };
      },
      checkAfterStop: async () => (session.live ? "unknown" : "exited"),
    },
    ...overrides,
  });
}

const BROWSER_CHECKS = [
  { label: "screenshot", executable: "playwright-cli", args: ["--json", "screenshot", "--filename=.aiboard-browser/a.png"], outputs: [".aiboard-browser/a.png"] },
  { label: "node --test", executable: "node", args: ["--test"] },
];

// Each test has its own harness, so they run side by side like CW5's.
describe("CW8: the owner's browser session", { concurrency: CLI_RUNTIME_TEST_CONCURRENCY }, () => {
  test("CW8: the owner's session runs before the CLI and is not running after the attempt, however it ends", async (t) => {
    const h = await harness(t, "browser-stops");
    const deadline: CliWorkerLaunchSettings = { executable: { status: "found", path: process.execPath, source: "home", form: "exe" }, attemptLimitMs: 300, argsPrefix: [FAKE_CLI_SCRIPT] };
    // The same attempt run again after each kind; the submission comes last, since a submitted session is the attempt's
    // outcome from then on.
    const kinds: Array<{ kind: string; scenario: FakeCliScenario; cancel?: boolean; settings?: CliWorkerLaunchSettings; expect: RegExp; starts?: number }> = [
      { kind: "a provider failure", scenario: { cli: "claude-code", stdout: claudeStream(h, null, { isError: true, result: "API Error: 529 overloaded" }), exitCode: 1 }, expect: /"type":"provider_failure"/ },
      { kind: "the deadline", scenario: { cli: "claude-code", stdout: claudeWorking(h), holdMs: 30_000 }, settings: deadline, expect: /cli_attempt_deadline/ },
      { kind: "a cancel", scenario: { cli: "claude-code", stdout: claudeWorking(h), holdMs: 30_000 }, cancel: true, expect: /worker_cancelled/ },
      { kind: "a result", scenario: { cli: "claude-code", stdout: claudeStream(h, done()), actions: [{ write: "value.txt", content: "two\n" }] }, expect: /"type":"submitted"/, starts: 2 },
    ];
    for (const entry of kinds) {
      const session: FakeSession = { starts: 0, live: false, plan: [] };
      const launcher = h.launcher(entry.scenario);
      let liveAtLaunch: boolean | undefined;
      const controller = new AbortController();
      const start = launcher.start.bind(launcher);
      launcher.start = async (input) => {
        liveAtLaunch = session.live;
        const handle = await start(input);
        // The cancel lands while the CLI runs.
        if (entry.cancel) setTimeout(() => controller.abort(), 300);
        return handle;
      };
      const result = await runCliWorkerAttempt(withSession(h, launcher, session, entry.settings ? { settings: async () => entry.settings! } : {}),
        h.input(entry.cancel ? { signal: controller.signal } : {}));
      assert.match(JSON.stringify(result), entry.expect, entry.kind);
      assert.equal(liveAtLaunch, true, `${entry.kind}: the session runs before the CLI starts`);
      // A submitted run also started one for the Runner's re-runs of its checks.
      assert.equal(session.starts, entry.starts ?? 1, entry.kind);
      assert.equal(session.live, false, `${entry.kind}: no session is left`);
      assert.equal(h.owners.has(OWNER), false, entry.kind);
    }
  });

  test("CW8: a launch the Runner refuses after the session started stops the session first", async (t) => {
    const h = await harness(t, "browser-refused");
    const refusal = () => Object.assign(new Error("The batch-argv probe is not verified on this host."), { code: "windows_batch_argv_unverified" });
    // Not proven, the refusal is kept and the owner's stop is retried (case 2): no CLI ran, nothing to collect.
    const unprovenLauncher = h.launcher({ cli: "claude-code", stdout: claudeStream(h, done()) });
    unprovenLauncher.startError = refusal();
    unprovenLauncher.stopFailures = 1;
    const unproven = await runCliWorkerAttempt(withSession(h, unprovenLauncher, { starts: 0, live: false, plan: [] }), h.input());
    assert.equal(unproven.type, "stop_unproven");
    assert.deepEqual((unproven as { outcome: unknown }).outcome, { type: "failed", reason: "process_launch_unproven:windows_batch_argv_unverified" });
    assert.match((unproven as { reason: string }).reason, /Claude Code was not started; the stop of the Playwright CLI session the Runner started for it is not proven/);
    assert.equal(h.owners.has(OWNER), true, "the owner keeps its depth until the retried stop proves it");
    assert.equal(records(h).length, 0);
    // Proven: the session is stopped and the refusal stands.
    const session: FakeSession = { starts: 0, live: false, plan: [] };
    const launcher = h.launcher({ cli: "claude-code", stdout: claudeStream(h, done()) });
    launcher.startError = refusal();
    const result = await runCliWorkerAttempt(withSession(h, launcher, session), h.input());
    assert.deepEqual(result, { type: "settled", outcome: { type: "failed", reason: "process_launch_unproven:windows_batch_argv_unverified" } });
    assert.equal(session.live, false);
    assert.equal(h.owners.has(OWNER), false);
  });

  test("CW8: case 3's failed start is stopped and proven before the CLI runs; a cancel during the start launches nothing", async (t) => {
    const h = await harness(t, "browser-case3");
    // The failed start's stop not proven: no CLI is started, and the claim is kept (case 2).
    const unprovenLauncher = h.launcher({ cli: "claude-code", stdout: claudeStream(h, done()) });
    unprovenLauncher.stopFailures = 1;
    const unproven = await runCliWorkerAttempt(withSession(h, unprovenLauncher, { starts: 0, live: false, plan: ["start_failed"] }), h.input());
    assert.equal(unproven.type, "stop_unproven");
    assert.deepEqual((unproven as { outcome: unknown }).outcome, { type: "failed", reason: "process_stop_unproven" });
    assert.equal(unprovenLauncher.starts.length, 0);

    // A cancel while the session starts: the session stops, no CLI starts, the attempt pauses. The real start reports a
    // cancelled start as failed (its process start and ready wait throw on the abort); a start that finished first
    // reports started.
    for (const status of ["start_failed", "started"] as const) {
      const controller = new AbortController();
      const cancelledSession: FakeSession = { starts: 0, live: false, plan: [status], during: () => controller.abort() };
      const cancelledLauncher = h.launcher({ cli: "claude-code", stdout: claudeStream(h, done()) });
      const cancelled = await runCliWorkerAttempt(withSession(h, cancelledLauncher, cancelledSession), h.input({ signal: controller.signal }));
      assert.deepEqual(cancelled, { type: "settled", outcome: { type: "paused", reason: "worker_cancelled" } }, status);
      assert.equal(cancelledLauncher.starts.length, 0, status);
      assert.equal(cancelledSession.live, false, status);
      assert.equal(h.owners.has(OWNER), false, status);
    }

    // Proven: what the failed start left is stopped before the CLI, which runs without a browser.
    const session: FakeSession = { starts: 0, live: false, plan: ["start_failed"] };
    const launcher = h.launcher({ cli: "claude-code", stdout: claudeStream(h, done()), actions: [{ write: "value.txt", content: "two\n" }] });
    let liveAtLaunch: boolean | undefined;
    const start = launcher.start.bind(launcher);
    launcher.start = async (input) => { liveAtLaunch = session.live; return await start(input); };
    assert.equal((await runCliWorkerAttempt(withSession(h, launcher, session), h.input())).type, "submitted");
    assert.equal(liveAtLaunch, false, "what the failed start left was stopped before the CLI");
    assert.deepEqual(records(h).at(-1)?.browser, { status: "start_failed", reason: "the session's ready wait failed" });
    assert.equal(session.starts, 1, "a CLI that ran without a browser gets no re-run session");
  });

  test("CW8: the re-runs of the CLI's browser checks get a session of their own, stopped and proven before anything is submitted", async (t) => {
    const reported = { ...done(), checks: BROWSER_CHECKS };
    // The re-run session's stop not proven: nothing is submitted (case 2), and the attempt is held with the CLI's tree.
    const hu = await harness(t, "browser-reruns-unproven");
    const restoreTree = (cwd: string, treeId: string) => restoreWorkingTree(cwd, join(hu.state, "tree-index"), policyGit, treeId);
    const unprovenSession: FakeSession = { starts: 0, live: false, plan: [] };
    const unprovenLauncher = hu.launcher({ cli: "claude-code", stdout: claudeStream(hu, reported), actions: [{ write: "value.txt", content: "two\n" }] });
    const unprovenDeps = withSession(hu, unprovenLauncher, unprovenSession, { restoreTree });
    let reruns = 0;
    const unproven = await runCliWorkerAttempt({ ...unprovenDeps, rerunChecks: async (input) => {
      reruns += 1;
      unprovenLauncher.stopFailures = 1;
      return await hu.rerun(input);
    } }, hu.input());
    assert.equal(unproven.type, "stop_unproven", JSON.stringify(unproven));
    assert.match((unproven as { reason: string }).reason, /re-ran Claude Code's browser checks in a Playwright CLI session; the stop of that session is not proven/);
    assert.deepEqual((unproven as { outcome: unknown }).outcome, { type: "paused", reason: `${CLI_RERUNS_PENDING_PREFIX}${TASK}` });
    assert.notEqual((await hu.sessions.load(SESSION)).status, "submitted");
    assert.equal(hu.owners.has(OWNER), true, "the owner keeps its depth until the retried stop proves it");
    // Its next entry (the Resume after the proven stop) re-runs on the CLI's tree in a new re-run session, starting no CLI.
    const resumed = await runCliWorkerAttempt({ ...unprovenDeps, rerunChecks: async (input) => {
      reruns += 1;
      assert.equal(input.browserUnavailable, false);
      return await hu.rerun(input);
    } }, hu.input());
    assert.equal(resumed.type, "submitted", JSON.stringify(resumed));
    assert.equal(unprovenLauncher.starts.length, 1, "no CLI is started again");
    assert.equal(reruns, 2);
    assert.equal(unprovenSession.starts, 3, "the CLI's, the first re-run session, the re-entry's");
    assert.equal(unprovenSession.live, false);
    assert.equal(hu.owners.has(OWNER), false);

    const h = await harness(t, "browser-reruns");

    // Proven: the re-runs ran with the session up, and it was stopped before the submission.
    const session: FakeSession = { starts: 0, live: false, plan: [] };
    const launcher = h.launcher({ cli: "claude-code", stdout: claudeStream(h, reported), actions: [{ write: "value.txt", content: "two\n" }] });
    let rerunSaw: { live: boolean; browserUnavailable: boolean; depth: boolean } | undefined;
    const deps = withSession(h, launcher, session);
    const result = await runCliWorkerAttempt({ ...deps, rerunChecks: async (input) => {
      rerunSaw = { live: session.live, browserUnavailable: input.browserUnavailable, depth: h.owners.has(OWNER) };
      return await h.rerun(input);
    } }, h.input());
    assert.equal(result.type, "submitted", JSON.stringify(result));
    assert.deepEqual(rerunSaw, { live: true, browserUnavailable: false, depth: true }, "the owner keeps its MCP depth through the re-runs");
    assert.equal(h.owners.has(OWNER), false);
    assert.equal(session.starts, 2, "one for the CLI, one for the re-runs");
    assert.equal(session.live, false);

    // A re-run session that does not start: the re-runs run without a browser, and the Architect reads why.
    const h2 = await harness(t, "browser-reruns-case3");
    const session2: FakeSession = { starts: 0, live: false, plan: ["started", "start_failed"] };
    const launcher2 = h2.launcher({ cli: "claude-code", stdout: claudeStream(h2, reported), actions: [{ write: "value.txt", content: "two\n" }] });
    let unavailable: boolean | undefined;
    const deps2 = withSession(h2, launcher2, session2);
    const result2 = await runCliWorkerAttempt({ ...deps2, rerunChecks: async (input) => { unavailable = input.browserUnavailable; return await h2.rerun(input); } }, h2.input());
    assert.equal(result2.type, "submitted", JSON.stringify(result2));
    assert.equal(unavailable, true);
    assert.equal(session2.live, false);
    assert.match(JSON.stringify(result2), /The Runner could not start the Playwright CLI session for its re-runs, so the browser checks were not re-run: the session's ready wait failed/);
  });
});

test("a stop proof for runtime deps that re-run checks but cannot read the Runner's commands is unproven", async () => {
  const stopped: unknown[] = [];
  const launcher = { stopOwner: async (owner: unknown) => { stopped.push(owner); } } as unknown as CliProcessLauncher;
  const rerunChecks = (async () => ({ criterionEvidenceLinks: [], notRun: [] })) as unknown as NonNullable<CliWorkerRuntimeDeps["rerunChecks"]>;
  assert.equal(await proveCliStop({ launcher, rerunChecks }, OWNER), "the Runner cannot check the commands it ran for this attempt");
  assert.equal(await proveCliStop({ launcher, rerunChecks, oneShotCommands: async () => undefined }, OWNER), undefined);
  assert.equal(await proveCliStop({ launcher, rerunChecks, oneShotCommands: async () => "1 command(s) are not proven stopped" }, OWNER), "1 command(s) are not proven stopped");
  assert.equal(await proveCliStop({ launcher }, OWNER), undefined, "no re-runs, no one-shot commands to check");
  assert.equal(stopped.length, 4, "the managed stop runs first every time");
});
