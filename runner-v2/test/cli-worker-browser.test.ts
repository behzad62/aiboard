/**
 * CW8: browsing for CLI workers (docs/plans/2026-11-14-cli-workers.md §3.10, §3.11 case 3), end to end through the
 * Runner's real process paths: the production ExecutionHost with the Playwright CLI sessions' per-owner environment
 * and stop observer, the managed CLI launcher, and the managed browser sessions. The fake CLI's `playwright-cli`
 * commands reach the session the Runner started for the worker's owner, and the Runner's re-runs keep a screenshot as
 * evidence through `outputs`.
 *
 * No browser is started and nothing is downloaded: the real shims run a stand-in daemon (it serves `goto`,
 * `screenshot` and refuses everything else, over a port it writes into the owner's registry folder) and a stand-in
 * client in place of the guarded Playwright CLI (exit 1 on a failed command, as playwright-cli-guard.mjs does). No real
 * CLI is started and no prompt is sent.
 *
 * CW6's re-runs: this file stubs CW6's `rerunChecks` seam with the real `run_evidence_command` tool, run as the
 * assigned worker (each passing re-run links its criteria; a re-run with a failing exit links nothing).
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test, { describe, type TestContext } from "node:test";

import { composeRunnerProcessEnvironments } from "../src/child-environment.js";
import { CLI_BROWSER_SESSION_READY_WAIT_MS, CLI_NO_BROWSER_NOTE, createManagedCliBrowserSessions, isPlaywrightCliCheck } from "../src/cli-worker-browser.js";
import { createManagedCliProcessLauncher, runCliWorkerAttempt, type CliCheckRerunner, type CliWorkerHostFacts } from "../src/cli-worker-runtime.js";
import { createEvidenceTools } from "../src/evidence-tools.js";
import { createExecutionHost } from "../src/execution-host.js";
import { ManagedProcessError, MANAGED_OUTPUT_WAIT_MAX_MS } from "../src/managed-process-contracts.js";
import { snapshotNativeBuildAmbientEnvironment } from "../src/native-build-factory.js";
import { PATTERN_WALL_CEILING_MS } from "../src/pattern-cpu-budget.js";
import {
  installPlaywrightCliShims,
  playwrightCliSessionName,
  playwrightCliSkillPath,
  PlaywrightCliSessions,
  resolvePlaywrightCliInstall,
} from "../src/playwright-cli.js";
import { emptyRunnerCapabilitiesConfig } from "../src/runner-capabilities-config.js";
import type { RunnerCapabilityContract } from "../src/runner-capability-contract.js";
import { FAKE_CLI_SCENARIO_ENV, writeFakeCliScenario, type FakeCliRecord, type FakeCliScenario } from "./support/fake-cli.js";
import { RUN, TASK, SESSION, WINDOWS, harness, claudeStream, records, type Harness } from "./support/cli-worker-runtime-harness.js";

const ON_WINDOWS = process.platform === "win32";
const APP = "http://127.0.0.1:9/app";
const SHOT = ".aiboard-browser/home.png";
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// The stand-in daemon: started by the real `playwright-cli-session` shim in place of cliDaemon.js. It records its PID,
// serves one JSON command per connection, and keeps the page's URL between commands, as the real session does.
const DAEMON = `
import { createServer } from "node:net";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
const session = process.argv[2];
const registry = process.env.PWTEST_DAEMON_SESSION_DIR;
const log = process.env.AIBOARD_STANDIN_LOG;
let url = "about:blank";
const handle = (args) => {
  const [command, ...rest] = args.filter((arg) => arg !== "--json");
  if (command === "goto") { url = rest[0]; return { ok: true, url }; }
  if (command === "screenshot") {
    const file = rest.find((arg) => arg.startsWith("--filename="))?.slice("--filename=".length) ?? "page.png";
    writeFileSync(resolve(process.cwd(), file), Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.from(\`screenshot of \${url} by daemon \${process.pid} of \${session}\`)]));
    return { ok: true, file };
  }
  return { ok: false, error: \`Ref \${rest[0] ?? ""} not found in the current page snapshot\` };
};
const server = createServer((socket) => {
  let text = "";
  socket.setEncoding("utf8").on("data", (chunk) => {
    text += chunk;
    if (text.includes("\\n")) socket.end(JSON.stringify(handle(JSON.parse(text))) + "\\n");
  });
});
server.listen(0, "127.0.0.1", () => {
  mkdirSync(registry, { recursive: true });
  writeFileSync(join(registry, session + ".port"), String(server.address().port));
  if (log) appendFileSync(log, JSON.stringify({ pid: process.pid, session, cwd: process.cwd() }) + "\\n");
  process.stdout.write("Daemon listening on 127.0.0.1:" + server.address().port + "\\n");
});
`;

// The stand-in client: run by the real `playwright-cli` shim in place of playwright-cli-guard.mjs. It reaches only
// the session the owner's environment names, and exits 1 when the command fails or no session answers.
const CLIENT = `
import { connect } from "node:net";
import { readFileSync } from "node:fs";
import { join } from "node:path";
const session = process.env.PLAYWRIGHT_CLI_SESSION;
let port;
try { port = Number(readFileSync(join(process.env.PWTEST_DAEMON_SESSION_DIR, session + ".port"), "utf8")); }
catch { process.stderr.write("The browser '" + session + "' is not open\\n"); process.exit(1); }
const socket = connect(port, "127.0.0.1");
let text = "";
socket.setEncoding("utf8");
socket.on("error", (error) => { process.stderr.write(String(error) + "\\n"); process.exit(1); });
socket.on("data", (chunk) => { text += chunk; });
socket.on("end", () => {
  const reply = JSON.parse(text);
  process.stdout.write(JSON.stringify({ isError: !reply.ok, ...reply }) + "\\n");
  process.exitCode = reply.ok ? 0 : 1;
});
socket.write(JSON.stringify(process.argv.slice(2)) + "\\n");
`;

interface Fixture {
  h: Harness;
  sessions: PlaywrightCliSessions;
  /** One line per daemon start: its PID and working directory. */
  daemons(): Array<{ pid: number; cwd: string }>;
  /** The fake CLI's scenario: one path, rewritten per run (the host's ambient environment names it). */
  scenario(scenario: FakeCliScenario): void;
  deps(overrides?: { rerun?: boolean }): Parameters<typeof runCliWorkerAttempt>[0];
  run: Awaited<ReturnType<ReturnType<typeof createExecutionHost>["bindRun"]>>;
  /** Re-runs found in the evidence store, oldest first. */
  reruns(): Array<{ command: string; args: string[]; exitCode: number | null; outputs: string[] }>;
  /** The managed processes of the run that are still running. */
  running(): Promise<string[]>;
}

/**
 * Runs `body` with a fixture, and closes the run's binding and the host before the harness removes its folder. A
 * Windows host that cannot hold a Job refuses every CLI launch (cli-worker-runtime-runs.test.ts checks that); one
 * whose batch-argv fact is not verified refuses the `.cmd` session shim, so a test that needs a session skips there
 * (the probe can read `unavailable` on a loaded host).
 */
async function withFixture(t: TestContext, label: string, browser: "chromium" | null, needsSession: boolean, body: (f: Fixture) => Promise<void>): Promise<void> {
  const h = await harness(t, label);
  let close: (() => Promise<void>) | undefined;
  try {
    const f = await fixture(t, h, browser, needsSession, (closer) => { close = closer; });
    if (f) await body(f);
  } finally {
    await close?.();
  }
}

async function fixture(t: TestContext, h: Harness, browser: "chromium" | null, needsSession: boolean, onClose: (close: () => Promise<void>) => void): Promise<Fixture | undefined> {
  const standIn = join(h.root, "pw-standin");
  mkdirSync(standIn);
  writeFileSync(join(standIn, "daemon.mjs"), DAEMON);
  writeFileSync(join(standIn, "client.mjs"), CLIENT);
  const log = join(standIn, "daemons.jsonl");
  const bin = installPlaywrightCliShims(join(h.root, "pw-bin"), {
    ...resolvePlaywrightCliInstall(), daemon: join(standIn, "daemon.mjs"), guard: join(standIn, "client.mjs"),
  });
  const sessions = new PlaywrightCliSessions({ stateRoot: join(h.state, "playwright-cli"), binDirectory: bin });
  sessions.configureRun(RUN, { browser });
  const scenarioPath = join(h.root, "fake", "browser-scenario.json");
  const ambient = { ...snapshotNativeBuildAmbientEnvironment(), [FAKE_CLI_SCENARIO_ENV]: scenarioPath, AIBOARD_STANDIN_LOG: log };
  const host = createExecutionHost({ projectRoot: h.project, stateDirectory: h.state, artifacts: h.artifacts, ambientEnvironment: ambient });
  const run = await host.bindRun({
    runId: RUN, permissionProfile: "full", capabilityContract: { digest: "d".repeat(64) } as RunnerCapabilityContract,
    capabilitiesConfig: emptyRunnerCapabilitiesConfig(),
    processEnvironment: composeRunnerProcessEnvironments(sessions.environmentFor, h.owners.environmentFor),
    managedStopObserver: sessions.stopObserver(),
  });
  // The host too: its Job host and fact probe keep pipes open (cli-worker-runtime-runs.test.ts says why).
  onClose(async () => { try { await run.close(); } finally { await host.close(); } });
  let hostFacts: CliWorkerHostFacts = { platform: process.platform, isRoot: false };
  if (ON_WINDOWS) {
    const facts = await host.windowsProcessFacts?.();
    // A Windows host that cannot hold a Job refuses every CLI launch (cli-worker-runtime-runs.test.ts checks that).
    if (facts?.jobContainment !== "verified" || (needsSession && facts.windowsBatchArgv !== "verified")) {
      t.skip(`this Windows host cannot run this case (Job containment ${facts?.jobContainment}, batch argv ${facts?.windowsBatchArgv})`);
      return undefined;
    }
    hostFacts = { ...WINDOWS, jobContainment: facts.jobContainment, windowsBatchArgv: facts.windowsBatchArgv };
  }
  const launcher = createManagedCliProcessLauncher({ managedProcesses: run.managedProcesses, executionGrants: run.executionGrants, permissionProfile: "full" });
  const browserSessions = createManagedCliBrowserSessions({
    managedProcesses: run.managedProcesses, executionGrants: run.executionGrants, permissionProfile: "full", runs: sessions, skillPath: playwrightCliSkillPath(),
  });
  // CW6's seam, stubbed with the real run_evidence_command as the assigned worker: a re-run whose exit is not 0 links
  // nothing, and a browser check without a browser is not run.
  const rerun: CliCheckRerunner = async ({ owner, workspace, attempt, result, browserUnavailable }) => {
    // Without the run's git context: its working-tree captures cost about 10 s per call in a Linux container, and the
    // re-run itself is the same one-shot command as the owner either way.
    const [tool] = createEvidenceTools({ store: h.evidence, artifacts: h.artifacts, taskId: TASK, attempt, execution: run.commandExecution });
    const links: Awaited<ReturnType<CliCheckRerunner>>["criterionEvidenceLinks"] = [];
    const notRun: { what: string; why: string }[] = [];
    for (const check of result.checks) {
      if (browserUnavailable && isPlaywrightCliCheck(check)) { notRun.push({ what: check.label, why: "no browser" }); continue; }
      const validated = tool!.validate({ label: check.label, command: check.executable, args: check.args, ...(check.outputs ? { outputs: check.outputs } : {}) });
      assert.ok(validated.ok, JSON.stringify(validated));
      const callId = `rerun:${check.label}`;
      const grant = await run.executionGrants.issue({
        runId: owner.runId, sessionId: owner.sessionId, actor: { ...owner.actor }, toolName: "run_evidence_command", callId,
        permissionProfile: "full", workspacePath: workspace.path, access: [{ path: workspace.path, mode: "write" }],
        externalApproved: false, destructiveApproved: false, networkApproved: false,
      });
      try {
        const output = await tool!.execute(validated.value, {
          runId: owner.runId, sessionId: owner.sessionId, actor: { ...owner.actor }, callId, toolName: "run_evidence_command",
          workspacePath: workspace.path, executionGrant: grant,
        });
        const view = output.content.find((block) => block.type === "json")?.value as { evidenceId?: string; id?: string; exitCode?: number } | undefined;
        assert.equal(output.isError, false, JSON.stringify(output));
        const record = h.evidence.list({ runId: RUN, taskId: TASK }).at(-1)!;
        assert.ok(view);
        if (record.fact.kind === "command" && record.fact.exitCode === 0) {
          for (const criterionId of check.criterionIds ?? []) {
            links.push({ criterionId, evidenceId: record.id, artifactHashes: [
              record.fact.stdoutArtifactHash, record.fact.stderrArtifactHash, ...(record.fact.outputs?.files ?? []).map((file) => file.artifactHash),
            ] });
          }
        }
      } finally {
        await run.executionGrants.revoke(grant, "completed");
      }
    }
    return { criterionEvidenceLinks: links, notRun };
  };
  return {
    h, sessions, run,
    daemons: () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : []),
    scenario: (scenario) => { writeFakeCliScenario(join(h.root, "fake"), scenario, "browser-scenario.json"); },
    deps: (overrides = {}) => h.deps(launcher, {
      host: hostFacts, browser: browserSessions, ...(overrides.rerun === false ? {} : { rerunChecks: rerun }),
      ...(ON_WINDOWS ? {} : { platformRefusal: () => undefined }),
    }),
    reruns: () => h.evidence.list({ runId: RUN, taskId: TASK }).flatMap((record) => record.fact.kind === "command"
      ? [{ command: record.fact.command, args: record.fact.args, exitCode: record.fact.exitCode, outputs: (record.fact.outputs?.files ?? []).map((file) => file.artifactHash) }]
      : []),
    running: async () => (await run.managedProcesses.listRun(RUN)).filter((entry) => entry.status === "running").map((entry) => entry.command),
  };
}

/**
 * Whether the stand-in daemon with this PID still runs: the PID answers and its command line still names the stand-in
 * daemon (Windows reuses PIDs within seconds on a busy host, so a PID alone proves nothing). Read by PID only.
 */
function daemonAlive(pid: number): boolean {
  try { process.kill(pid, 0); } catch { return false; }
  const command = ON_WINDOWS
    ? spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`], { encoding: "utf8", windowsHide: true }).stdout
    : (() => { try { return readFileSync(`/proc/${pid}/cmdline`, "utf8"); } catch { return ""; } })();
  return /pw-standin[\\/]daemon\.mjs/.test(command ?? "");
}

function browserChecks(extra: Array<Record<string, unknown>> = []): Array<Record<string, unknown>> {
  return [
    { label: "open the app", executable: "playwright-cli", args: ["--json", "goto", APP], cwd: null, outputs: null, criterionIds: null },
    { label: "home screenshot", executable: "playwright-cli", args: ["--json", "screenshot", `--filename=${SHOT}`], cwd: null, outputs: [SHOT], criterionIds: ["value"] },
    ...extra,
  ];
}

function done(checks: Array<Record<string, unknown>>): Record<string, unknown> {
  return { outcome: "done", summary: "Changed value.txt to two and checked the page.", question: null, replanReason: null, checks, notRun: [], concerns: [] };
}

// The two tests have their own harness, host and stand-ins, so they run side by side.
describe("CW8: a CLI worker's browser session, end to end", { concurrency: 2 }, () => {
  test("CW8: the fake CLI's playwright-cli reaches the owner's session, a re-run keeps its screenshot as evidence, a failed command fails its re-run, and no session is left", (t) => withFixture(t, "browse", "chromium", true, async (f) => {
    const record = join(f.h.root, "fake", "browse.json");
    // A failed command: exit 1 in the CLI's run and in its re-run, so it supports nothing.
    const click = { label: "submit the form", executable: "playwright-cli", args: ["--json", "click", "e99"], cwd: null, outputs: null, criterionIds: ["value"] };
    f.scenario({
      cli: "claude-code", stdout: claudeStream(f.h, done(browserChecks([click]))), record,
      actions: [
        { write: "value.txt", content: "two\n" },
        { run: ["playwright-cli", "--json", "goto", APP] },
        { run: ["playwright-cli", "--json", "screenshot", `--filename=${SHOT}`] },
        { run: ["playwright-cli", "--json", "click", "e99"] },
      ],
    });
    const result = await runCliWorkerAttempt(f.deps(), f.h.input());
    assert.equal(result.type, "submitted", JSON.stringify(result));

    // The CLI's own commands reached the session the Runner started for its owner, in its worktree.
    const ran = JSON.parse(readFileSync(record, "utf8")) as FakeCliRecord;
    assert.deepEqual(ran.runs?.map((entry) => entry.exitCode), [0, 0, 1], JSON.stringify(ran.runs));
    assert.match(ran.runs![2]!.stdout, /"isError":true/);
    assert.match(ran.stdin, /A browser is running for this task/);
    assert.ok(ran.stdin.includes(playwrightCliSkillPath()), "the preamble names the skill file by its absolute path");
    assert.ok(existsSync(playwrightCliSkillPath()));
    const [cliSession, rerunSession, ...more] = f.daemons();
    assert.equal(more.length, 0, "one session for the CLI, one for the Runner's re-runs");
    assert.equal(cliSession!.cwd.toLowerCase(), f.h.workspace.path.toLowerCase());
    assert.deepEqual(records(f.h)[0]?.browser, { status: "started" });

    // The Runner's re-runs ran in a session of the same owner: the screenshot became evidence through `outputs`, and the
    // failed command's re-run failed (exit 1) and supports nothing.
    const reruns = f.reruns();
    assert.deepEqual(reruns.map((entry) => [entry.command, entry.exitCode]), [["playwright-cli", 0], ["playwright-cli", 0], ["playwright-cli", 1]]);
    const shot = await f.h.artifacts.get(reruns[1]!.outputs[0]!);
    assert.ok(shot.subarray(0, PNG.length).equals(PNG));
    assert.equal(shot.subarray(PNG.length).toString("utf8"),
      `screenshot of ${APP} by daemon ${rerunSession!.pid} of ${playwrightCliSessionName(RUN, SESSION)}`);
    const changeSet = (await f.h.sessions.load(SESSION)).changeSet!;
    assert.deepEqual((changeSet.criterionEvidenceLinks ?? []).map((link) => link.artifactHashes.includes(reruns[1]!.outputs[0]!)), [true],
      "only the screenshot's re-run supports the criterion, and it cites the screenshot");

    // Nothing of either session is left: both daemons stopped with the owner.
    assert.equal(daemonAlive(cliSession!.pid), false);
    assert.equal(daemonAlive(rerunSession!.pid), false);
    assert.deepEqual(await f.running(), []);
  }));

  test("CW8: a session start that fails with the until.pattern wall ceiling is recorded and the CLI runs without a browser; with no browser recorded no session starts", (t) => withFixture(t, "wall-ceiling", "chromium", true, async (f) => {
    // The busy host's failure, injected where the real one is thrown: the session's ready wait (managed-process-wait.ts).
    const readOutput = f.run.managedProcesses.readOutput.bind(f.run.managedProcesses);
    const start = f.run.managedProcesses.start.bind(f.run.managedProcesses);
    const started: string[] = [];
    f.run.managedProcesses.start = async (request, context, root) => { started.push(request.command); return await start(request, context, root); };
    let injected = 0;
    f.run.managedProcesses.readOutput = async (processId, request, context) => {
      if (request.until?.pattern) {
        injected += 1;
        throw new ManagedProcessError("invalid_arguments", `until.pattern could not be evaluated within ${PATTERN_WALL_CEILING_MS} ms on this busy host.`);
      }
      return await readOutput(processId, request, context);
    };
    const record = join(f.h.root, "fake", "wall.json");
    f.scenario({ cli: "claude-code", record, stdout: claudeStream(f.h, done(browserChecks())), actions: [{ write: "value.txt", content: "two\n" }] });
    let browserUnavailable: boolean | undefined;
    const deps = f.deps();
    const rerun = deps.rerunChecks!;
    const result = await runCliWorkerAttempt({ ...deps, rerunChecks: async (input) => { browserUnavailable = input.browserUnavailable; return await rerun(input); } }, f.h.input());

    assert.equal(injected, 1, "one start, never retried");
    const browser = records(f.h)[0]?.browser;
    assert.equal(browser?.status, "start_failed");
    assert.match(browser?.reason ?? "", /could not be evaluated within 8000 ms on this busy host/);
    assert.match((JSON.parse(readFileSync(record, "utf8")) as FakeCliRecord).stdin, /No browser is running for this task/);
    // The CLI ran, and its browser checks were not run: no re-run session, no browser re-run.
    assert.equal(browserUnavailable, true);
    assert.equal(f.reruns().length, 0);
    // One session start, whose ready wait failed, then the CLI; nothing of either is left.
    assert.deepEqual(started, ["playwright-cli-session", process.execPath]);
    for (const daemon of f.daemons()) assert.equal(daemonAlive(daemon.pid), false);
    assert.deepEqual(await f.running(), []);
    // Nothing was submitted: the screenshot criterion has no evidence.
    assert.match(JSON.stringify(result), /cli_submission_refused/);
    // Neither bound was raised: the pattern's wall ceiling and the one ready read.
    assert.equal(PATTERN_WALL_CEILING_MS, 8_000);
    assert.equal(CLI_BROWSER_SESSION_READY_WAIT_MS, MANAGED_OUTPUT_WAIT_MAX_MS);
    assert.equal(MANAGED_OUTPUT_WAIT_MAX_MS, 30_000);

    // The run's inventory recorded no browser: the next run of the attempt starts no session, and the CLI is told so.
    f.run.managedProcesses.readOutput = readOutput;
    f.sessions.configureRun(RUN, { browser: null });
    // The failed start's daemon may have registered its port before it was stopped: gone, so no stale port is reached.
    rmSync(join(f.sessions.ownerFolder({ runId: RUN, sessionId: SESSION }), "registry"), { recursive: true, force: true });
    started.length = 0;
    const none = join(f.h.root, "fake", "none.json");
    f.scenario({
      cli: "claude-code", record: none, actions: [{ write: "value.txt", content: "two\n" }, { run: ["playwright-cli", "--json", "goto", APP] }],
      stdout: claudeStream(f.h, done([{ label: "node", executable: "node", args: ["-e", "0"], cwd: null, outputs: null, criterionIds: ["value"] }])),
    });
    const second = await runCliWorkerAttempt(f.deps(), f.h.input());
    assert.equal(second.type, "submitted", JSON.stringify(second));
    assert.deepEqual(started, [process.execPath], "no session was started");
    assert.deepEqual(records(f.h).at(-1)?.browser, { status: "none" });
    const ran = JSON.parse(readFileSync(none, "utf8")) as FakeCliRecord;
    assert.ok(ran.stdin.includes(CLI_NO_BROWSER_NOTE));
    // A playwright-cli command finds no session to reach.
    assert.equal(ran.runs?.[0]?.exitCode, 1);
    assert.match(ran.runs?.[0]?.stderr ?? "", /is not open/);
    assert.deepEqual(await f.running(), []);
  }));
});
