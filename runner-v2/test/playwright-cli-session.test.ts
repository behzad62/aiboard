// VF7b: the task's Playwright CLI session as a Runner-owned managed process, through the Runner's real process paths
// (ExecutionHost -> bindRun -> ToolBroker -> process.run / process.start / process.signal), as a Build worker's tool
// calls reach them. The CI list of docs/runner-v2/playwright-cli-spike-2026-11-13.md §8:
//   1. a managed session serves three later CLI calls and stops with close;
//   2. no daemon, Chrome or crashpad of the session is left after each kill kind;
//   3. the playwright-cli shim's refusals;
//   4. two agent sessions never share a browser session, and one cannot list the other's;
//   5. a hard kill leaves no profile or artifacts folder in the user's temp folder;
//   6. the daemon's POSIX socket path fits in 103 bytes.
// It also pins the Playwright hooks the design leans on (PWTEST_DAEMON_SESSION_DIR) and proves the output folder
// never reaches a task commit. The browser tests need an installed Chrome, Edge or Playwright Chromium: CI's
// ubuntu-latest and macos-latest images ship Chrome; without one they are skipped, never failed.
// CI must finish in a few minutes, so CI runs one Runner run with one browser per agent (items 1, 3, 4, 6 and a hard
// kill of 2). The full kill-kind matrix and its user-temp check (2, 5) start a browser per kind and run with
// AIBOARD_PLAYWRIGHT_EXHAUSTIVE=1, locally and in Docker.
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { ArtifactStore } from "../src/artifact-store.js";
import { createChildEnvironmentFactory } from "../src/child-environment.js";
import { createExecutionHost } from "../src/execution-host.js";
import { createManagedProcessTools } from "../src/managed-process-tools.js";
import { snapshotNativeBuildAmbientEnvironment } from "../src/native-build-factory.js";
import {
  installPlaywrightCliShims,
  PLAYWRIGHT_CLI_OUTPUT_FOLDER,
  PLAYWRIGHT_CLI_READY_PATTERN,
  playwrightCliSessionName,
  playwrightCliShimFiles,
  PlaywrightCliSessions,
  POSIX_BROWSER_EXIT_GRACE_MS,
  POSIX_BROWSER_KILL_VERIFY_MS,
  POSIX_SOCKET_NAME_BYTES,
  POSIX_SOCKET_PATH_MAX,
  resolvePlaywrightCliInstall,
  type PlaywrightCliBrowser,
  type PosixProcessTable,
} from "../src/playwright-cli.js";
import { refusalFor, rewriteNotOpen } from "../src/playwright-cli-guard.mjs";
import { listPosixProcessCommands } from "../src/portable-process-posix-control.mjs";
import { createProcessTools, processRunSupport } from "../src/process-tools.js";
import { emptyRunnerCapabilitiesConfig } from "../src/runner-capabilities-config.js";
import { ToolBroker } from "../src/tool-broker.js";
import { loadPlaywrightRegistry } from "../src/verification-inventory.js";

const WINDOWS = process.platform === "win32";
const execFileAsync = promisify(execFile);
type Block = { type: string; text?: string; value?: Record<string, unknown>; hash?: string };
type Output = { content: Block[]; isError?: boolean; error?: { code: string; message: string } };

// ---------------------------------------------------------------- the browser this machine has

function installedBrowser(): PlaywrightCliBrowser | undefined {
  if (process.env.AIBOARD_TEST_PLAYWRIGHT_BROWSER === "none") return undefined;
  try {
    const registry = loadPlaywrightRegistry();
    for (const id of ["chrome", "msedge", "chromium"] as const) {
      const path = registry.findExecutable(id)?.executablePath("javascript");
      if (path && existsSync(path)) return id;
    }
  } catch { /* no registry */ }
  return undefined;
}
const BROWSER = installedBrowser();
// CI sets AIBOARD_TEST_REQUIRE_PLAYWRIGHT_BROWSER=1, so a runner image without a browser fails instead of skipping.
const REQUIRE_BROWSER = process.env.AIBOARD_TEST_REQUIRE_PLAYWRIGHT_BROWSER === "1";
const browserSkip = BROWSER || REQUIRE_BROWSER ? false : "no Chrome, Edge or Playwright Chromium on this machine";
test("a browser is installed when CI requires one", { skip: REQUIRE_BROWSER ? false : "only when AIBOARD_TEST_REQUIRE_PLAYWRIGHT_BROWSER=1" }, () => {
  assert.ok(BROWSER, "CI's runner image has no Chrome, Edge or Playwright Chromium, so the browser tests cannot run");
});

// ---------------------------------------------------------------- a process census keyed on the owner's folder

interface Row { pid: number; command: string }
function processTable(): Row[] {
  if (!WINDOWS) return (listPosixProcessCommands() ?? []).map((row) => ({ pid: row.pid, command: row.command }));
  const script = "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CommandLine | ConvertTo-Json -Compress";
  const out = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8", maxBuffer: 64 << 20, windowsHide: true }).trim();
  const rows = out ? JSON.parse(out) : [];
  return (Array.isArray(rows) ? rows : [rows]).map((row: { ProcessId: number; CommandLine: string | null }) => ({ pid: row.ProcessId, command: row.CommandLine ?? "" }));
}
const naming = (folder: string) => (row: Row) => (WINDOWS ? row.command.toLowerCase().includes(folder.toLowerCase()) : row.command.includes(folder)) && row.pid !== process.pid && !/Get-CimInstance/.test(row.command);
/** Every process of the session: the daemon (its --config), Chrome (its profile in the folder's temp), on Linux crashpad (its database). */
function sessionProcesses(folder: string): Row[] {
  return processTable().filter(naming(folder));
}
async function waitFor<T>(read: () => T, done: (value: T) => boolean, ms: number): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = read();
    if (done(value) || Date.now() > deadline) return value;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------- one Runner run with the CLI turned on

interface Fixture {
  root: string; project: string; state: string; sessions: PlaywrightCliSessions; runId: string;
  run: Awaited<ReturnType<ReturnType<typeof createExecutionHost>["bindRun"]>>;
  invoke(name: string, input: Record<string, unknown>, agent?: string): Promise<Output>;
  cli(args: string[], agent?: string, extra?: Record<string, unknown>): Promise<{ output: Output; text: string; json?: Record<string, unknown> }>;
  start(agent?: string): Promise<{ processId: string; output: Output }>;
  folder(agent?: string): string;
  closeRun(): Promise<void>;
}

async function withRun(label: string, body: (fixture: Fixture) => Promise<void>, browser: PlaywrightCliBrowser | null = BROWSER ?? null): Promise<void> {
  // A short root: the POSIX socket budget is part of what this file proves.
  const root = await mkdtemp(join(tmpdir(), "pw-"));
  const project = join(root, "p"), state = join(root, "s");
  await mkdir(project); await mkdir(state);
  const artifacts = new ArtifactStore(join(state, "artifacts"));
  const binDirectory = installPlaywrightCliShims(join(state, "pw", "bin"), resolvePlaywrightCliInstall());
  const sessions = new PlaywrightCliSessions({ stateRoot: join(state, "pw"), binDirectory });
  const runId = `vf7b-${label}`;
  sessions.configureRun(runId, { browser });
  const host = createExecutionHost({ projectRoot: project, stateDirectory: state, artifacts, ambientEnvironment: snapshotNativeBuildAmbientEnvironment() });
  const run = await host.bindRun({
    runId, permissionProfile: "full", capabilityContract: { digest: "d".repeat(64) } as never, capabilitiesConfig: emptyRunnerCapabilitiesConfig(),
    processEnvironment: sessions.environmentFor, managedStopObserver: sessions.stopObserver(),
  });
  const broker = new ToolBroker({ permissionProfile: "full", workspacePath: project, executionGrants: run.executionGrants, artifacts });
  for (const tool of createProcessTools({ execution: run.commandExecution, support: processRunSupport(run.managedProcesses, artifacts) })) broker.register(tool);
  for (const tool of createManagedProcessTools(run.managedProcesses)) broker.register(tool);
  let seq = 0;
  const invoke = async (name: string, input: Record<string, unknown>, agent = "worker-a"): Promise<Output> =>
    await broker.invoke({ type: "tool_call", callId: `${label}-${++seq}`, name, arguments: input },
      { runId, sessionId: agent, actor: { role: "worker", id: agent }, workspacePath: project }) as Output;
  const textOf = async (output: Output): Promise<string> => (await Promise.all(output.content.map(async (block) => {
    if (block.type === "text") return block.text ?? "";
    if (block.type === "json") return JSON.stringify(block.value);
    if (block.type === "artifact" && block.hash) return Buffer.from(await artifacts.get(block.hash)).toString("utf8");
    return "";
  }))).join("\n");
  let closed = false;
  const closeRun = async () => { if (closed) return; closed = true; await run.close(); await host.close(); await sessions.removeRun(runId); };
  const fixture: Fixture = {
    root, project, state, sessions, runId, run, invoke,
    folder: (agent = "worker-a") => sessions.ownerFolder({ runId, sessionId: agent }),
    async cli(args, agent = "worker-a", extra = {}) {
      const output = await invoke("process.run", { command: "playwright-cli", args, timeoutMs: 60_000, ...extra }, agent);
      const text = await textOf(output);
      const jsonStart = text.indexOf("{\"");
      let json: Record<string, unknown> | undefined;
      if (args.includes("--json")) {
        const stdout = text.slice(text.indexOf("STDOUT") >= 0 ? text.indexOf("STDOUT") + 6 : 0);
        const start = stdout.indexOf("{");
        try { json = JSON.parse(stdout.slice(start, stdout.lastIndexOf("}") + 1)); } catch { json = undefined; }
      }
      void jsonStart;
      return { output, text, ...(json ? { json } : {}) };
    },
    async start(agent = "worker-a") {
      const output = await invoke("process.start", { command: "playwright-cli-session", until: { pattern: PLAYWRIGHT_CLI_READY_PATTERN }, waitMs: 30_000 }, agent);
      const value = output.content.find((block) => block.type === "json")?.value as { processId?: string } | undefined;
      assert.equal(output.isError, false, await textOf(output));
      assert.match(await textOf(output), /Daemon listening on/, await textOf(output));
      return { processId: value!.processId!, output };
    },
    closeRun,
  };
  try {
    await body(fixture);
  } finally {
    try { await closeRun(); }
    finally {
      // Nothing of a session may outlive its run (each test asserts its own kill kind before this).
      for (const row of sessionProcesses(join(state, "pw"))) { try { process.kill(row.pid, "SIGKILL"); } catch { /* gone */ } }
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    }
  }
}

async function page(): Promise<{ url: string; close: () => Promise<void> }> {
  const { createServer } = await import("node:http");
  const html = "<!doctype html><title>VF7b probe</title><h1>Hello VF7b</h1><button onclick=\"console.error('clicked-error')\">Press</button><script>console.log('page-loaded')</script>";
  const server = createServer((_request, response) => { response.writeHead(200, { "content-type": "text/html" }); response.end(html); });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  return { url: `http://127.0.0.1:${address.port}/`, close: () => new Promise((resolve) => server.close(() => resolve())) };
}

async function poll(fixture: Fixture, processId: string, agent = "worker-a"): Promise<Record<string, unknown>> {
  const output = await fixture.invoke("process.poll", { processId }, agent);
  return output.content.find((block) => block.type === "json")?.value ?? {};
}

function profilesInUserTemp(): string[] {
  try { return readdirSync(tmpdir()).filter((name) => /^playwright_chromiumdev_profile-|^playwright-artifacts-/.test(name)); }
  catch { return []; }
}

// ---------------------------------------------------------------- CI: one run, one shared session per agent

// The design's own bounds: a stop runs the POSIX check (its grace, then the kill's verify) before it returns, so
// nothing of a stopped session may still run once both have passed; Windows' Job proves the tree at the stop itself.
const AFTER_STOP_MS = POSIX_BROWSER_EXIT_GRACE_MS + POSIX_BROWSER_KILL_VERIFY_MS;

async function pollUntilStopped(f: Fixture, processId: string, agent = "worker-a"): Promise<Record<string, unknown>> {
  for (const deadline = Date.now() + AFTER_STOP_MS; ;) {
    const polled = await poll(f, processId, agent);
    if (polled.status !== "running" || Date.now() > deadline) return polled;
    await sleep(250);
  }
}

/**
 * A CLI call as the agent's command makes it, minus the Runner's process launch: the guard with the owner's Runner
 * values (process-tools.test.ts proves process.run passes them). It keeps CI short; the session itself, its stop
 * and the calls that prove the Runner's own path still go through process.start, process.signal and process.run.
 */
async function direct(f: Fixture, args: string[], agent = "worker-a"): Promise<string> {
  const values = f.sessions.environmentFor({ runId: f.runId, sessionId: agent })!.values;
  const result = await execFileAsync(process.execPath, [resolvePlaywrightCliInstall().guard, ...args], {
    cwd: f.project, env: { ...process.env, ...values }, timeout: 30_000, windowsHide: true,
  }).catch((error: { stdout?: string; stderr?: string }) => ({ stdout: error.stdout ?? "", stderr: error.stderr ?? "" }));
  return `${result.stdout}${result.stderr}`;
}

test("one run: a refusal, the no-browser message, a managed session serving later calls, a second agent's own session, a hard kill and close", { skip: browserSkip, timeout: 90_000 }, async () => {
  const site = await page();
  try {
    await withRun("ci", async (f) => {
      // No browser: the session command fails at once, names the install, and starts nothing.
      f.sessions.configureRun(f.runId, { browser: null });
      const none = await f.invoke("process.start", { command: "playwright-cli-session", until: { pattern: PLAYWRIGHT_CLI_READY_PATTERN }, waitMs: 30_000 }, "worker-none");
      assert.match(JSON.stringify(none.content), /aiboard browser install/, JSON.stringify(none.content));
      assert.equal(sessionProcesses(f.folder("worker-none")).length, 0);
      f.sessions.configureRun(f.runId, { browser: BROWSER! });

      // 3. Refused through the Runner's process.run, and nothing starts.
      assert.match((await f.cli(["open", "about:blank"])).text, /Refused by AIBoard: playwright-cli open/);
      assert.equal(sessionProcesses(f.folder()).length, 0);

      // 1. One managed session serves three later calls; its files go to the gitignored output folder.
      const { processId } = await f.start();
      assert.doesNotMatch(await direct(f, ["--json", "goto", site.url]), /"isError":\s*true/);
      assert.doesNotMatch(await direct(f, ["--json", "screenshot", `--filename=${PLAYWRIGHT_CLI_OUTPUT_FOLDER}/home.png`]), /"isError":\s*true/);
      assert.match(await direct(f, ["--json", "console"]), /page-loaded/);
      assert.equal(readFileSync(join(f.project, PLAYWRIGHT_CLI_OUTPUT_FOLDER, "home.png")).subarray(1, 4).toString("latin1"), "PNG");
      assert.equal(readFileSync(join(f.project, PLAYWRIGHT_CLI_OUTPUT_FOLDER, ".gitignore"), "utf8").trim(), "*");
      // 6. The registry is the owner's own (PWTEST_DAEMON_SESSION_DIR), and its socket fits 103 bytes.
      const registry = join(f.folder(), "registry");
      const sessionFile = readdirSync(registry, { recursive: true }).map(String).find((name) => name.endsWith(".session"));
      assert.ok(sessionFile, `the session registered in ${registry}`);
      if (!WINDOWS) {
        const socketPath = String((JSON.parse(readFileSync(join(registry, sessionFile!), "utf8")) as { socketPath?: string }).socketPath ?? "");
        assert.ok(socketPath.startsWith(f.sessions.socketFolder({ runId: f.runId, sessionId: "worker-a" })), socketPath);
        assert.ok(Buffer.byteLength(socketPath) <= POSIX_SOCKET_PATH_MAX, `${socketPath} is ${Buffer.byteLength(socketPath)} bytes`);
      }

      // 4. A second agent gets its own session, which the first cannot list (the foreign -s refusal is unit-tested).
      const b = await f.start("worker-b");
      const listA = await direct(f, ["list"]);
      assert.ok(listA.includes(playwrightCliSessionName(f.runId, "worker-a")), listA);
      assert.ok(!listA.includes(playwrightCliSessionName(f.runId, "worker-b")), listA);

      // 2. A hard kill of worker-b's session leaves nothing of it, and worker-a's still runs.
      const killed = await f.invoke("process.signal", { processId: b.processId, signal: "SIGKILL" }, "worker-b");
      assert.equal(killed.isError, false, JSON.stringify(killed));
      await f.run.managedProcesses.closeAgent({ runId: f.runId, sessionId: "worker-b", actor: { role: "worker", id: "worker-b" } });
      assert.deepEqual(await waitFor(() => sessionProcesses(f.folder("worker-b")), (rows) => rows.length === 0, AFTER_STOP_MS), []);
      assert.ok(sessionProcesses(f.folder("worker-a")).length > 0, "worker-a's browser still runs");
      if (!WINDOWS) {
        // The check really ran on the session's own stop (the stop target's pid is the supervisor's, not the daemon's).
        const records = f.sessions.cleanupRecords().filter((record) => record.sessionId === "worker-b");
        assert.ok(records.length > 0 && records.every((record) => ["none", "exited", "killed"].includes(record.status)), JSON.stringify(f.sessions.cleanupRecords()));
      }

      // 1. close stops worker-a's session, and a later call through process.run says how to start it again.
      assert.match(await direct(f, ["close"]), /closed/i);
      const state = await pollUntilStopped(f, processId);
      assert.notEqual(state.status, "running", JSON.stringify(state));
      assert.deepEqual(await waitFor(() => sessionProcesses(f.folder()), (rows) => rows.length === 0, AFTER_STOP_MS), [], "nothing is left after close");
      const after = await f.cli(["snapshot"]);
      assert.match(after.text, /is not running\. Start this agent session's browser once with process\.start: command playwright-cli-session/, after.text);
      assert.doesNotMatch(after.text, /playwright-cli open/, after.text);
    });
  } finally { await site.close(); }
});

// ---------------------------------------------------------------- exhaustive (local and Docker, not CI): every kill kind

// Each kind starts its own run and browser, so the matrix takes minutes; CI covers the hard kill above.
const exhaustiveSkip = browserSkip || (process.env.AIBOARD_PLAYWRIGHT_EXHAUSTIVE === "1" ? false : "the kill-kind matrix runs with AIBOARD_PLAYWRIGHT_EXHAUSTIVE=1 (locally and in Docker), not in CI");

for (const kind of ["SIGTERM", "SIGKILL", "task end", "daemon only", "chrome only"] as const) {
  test(`after ${kind}, no daemon, browser or crashpad of the session is left`, { skip: exhaustiveSkip, timeout: 240_000 }, async () => {
    const site = await page();
    const profilesBefore = new Set(profilesInUserTemp());
    let folder = "";
    try {
      await withRun(`kill-${kind.replace(/\s+/g, "-").toLowerCase()}`, async (f) => {
        folder = f.folder();
        const { processId } = await f.start();
        assert.notEqual((await f.cli(["--json", "goto", site.url])).json?.isError, true);
        const running = sessionProcesses(folder);
        assert.ok(running.some((row) => row.command.includes("cliDaemon.js")), "the daemon names its folder");
        assert.ok(running.some((row) => !row.command.includes("cliDaemon.js")), "the browser names its folder");
        if (kind === "SIGTERM" || kind === "SIGKILL") {
          const signalled = await f.invoke("process.signal", { processId, signal: kind });
          assert.equal(signalled.isError, false, JSON.stringify(signalled));
        } else if (kind === "task end") {
          await f.closeRun();
        } else if (kind === "daemon only") {
          const daemon = running.find((row) => row.command.includes("cliDaemon.js"))!;
          process.kill(daemon.pid, "SIGKILL");
        } else {
          const chrome = running.find((row) => !row.command.includes("cliDaemon.js") && !/--type=/.test(row.command) && !/crashpad/i.test(row.command));
          assert.ok(chrome, "Chrome's main process");
          process.kill(chrome!.pid, "SIGKILL");
          // The daemon notices its browser is gone and exits by itself.
          const exited = await waitFor(() => sessionProcesses(folder).filter((row) => row.command.includes("cliDaemon.js")), (rows) => rows.length === 0, 30_000);
          assert.deepEqual(exited, [], "the daemon exits when its browser dies");
        }
        // The owner ends (its processes are stopped, and the POSIX check runs after each stop).
        await f.closeRun();
        const left = await waitFor(() => sessionProcesses(folder), (rows) => rows.length === 0, 15_000);
        assert.deepEqual(left, [], `nothing of the session is left after ${kind}`);
        if (!WINDOWS) {
          // A stop of the session is checked at the stop; a session that ended by itself, at the run's removal.
          await f.closeRun();
          const records = f.sessions.cleanupRecords();
          assert.ok(records.length > 0 && records.every((record) => ["none", "exited", "killed"].includes(record.status)), JSON.stringify(records));
        }
      });
    } finally { await site.close(); }
    const fresh = profilesInUserTemp().filter((name) => !profilesBefore.has(name));
    assert.deepEqual(fresh, [], "no browser profile or artifacts folder is left in the user's temp folder");
    assert.equal(existsSync(folder), false, "the owner's state folder is removed with the run");
  });
}

// ---------------------------------------------------------------- 3. the shim's refusals

test("the playwright-cli shim refuses what would escape the managed session and says what to do instead", async () => {
  const own = "t-0000aaaa";
  const cases: Array<[string[], RegExp]> = [
    [["open", "https://example.com"], /process\.start: command playwright-cli-session.*goto/],
    [["attach", "--cdp=chrome"], /attach connects to a browser/],
    [["goto", "https://example.com", "--cdp=http://localhost:9222"], /--cdp connects/],
    [["goto", "x", "--endpoint=ws://x"], /--endpoint/],
    [["goto", "x", "--extension"], /--extension/],
    [["show"], /show starts a detached dashboard/],
    [["show", "--annotate"], /show starts a detached dashboard/],
    [["install"], /aiboard browser install/],
    [["install-browser", "chromium"], /aiboard browser install/],
    [["close-all"], /close-all would close other sessions/],
    [["kill-all"], /kill-all would kill other sessions/],
    [["delete-data"], /persistent profiles/],
    [["goto", "x", "--profile=/tmp/p"], /--profile/],
    [["goto", "x", "--persistent"], /--persistent/],
    [["-s=t-ffffffff", "goto", "x"], /names another browser session/],
    [["--session", "other", "snapshot"], /names another browser session/],
    [["-s", "t-ffffffff", "snapshot"], /names another browser session/],
  ];
  for (const [args, expected] of cases) assert.match(refusalFor(args, own) ?? "(allowed)", expected, args.join(" "));
  for (const args of [["goto", "https://example.com"], ["fill", "e3", "open"], ["-s=t-0000aaaa", "snapshot"], ["--json", "screenshot", "--filename=.aiboard-browser/x.png"], ["close"], ["list"], ["console", "error"]]) {
    assert.equal(refusalFor(args, own), undefined, args.join(" "));
  }
  assert.match(refusalFor(["-s=x", "goto", "y"], undefined) ?? "", /not running for a Build agent session/);
  // The CLI's "please run open first", in text and JSON output, becomes the instruction that works here.
  const text = rewriteNotOpen("The browser 't-1' is not open, please run open first\n\n  playwright-cli -s=t-1 open [params]\n");
  assert.match(text, /Browser session 't-1' is not running\. Start this agent session's browser once with process\.start/);
  assert.doesNotMatch(text, /playwright-cli -s=t-1 open/);
  const json = rewriteNotOpen(`{"isError":true,"error":"The browser 't-1' is not open, please run open first"}\n`);
  assert.equal((JSON.parse(json) as { error: string }).error.includes("process.start"), true, json);
  const thrown = rewriteNotOpen("Browser 't-1' is not open. Run\n\n  playwright-cli open\n\nto start the browser session.\n");
  assert.match(thrown, /is not running/);
  assert.doesNotMatch(thrown, /playwright-cli open|to start the browser session/);
});

// ---------------------------------------------------------------- environment, naming and state folders (no browser)

test("every process the Runner starts for an owner gets that owner's session, registry and the commands first on PATH", () => {
  const sessions = new PlaywrightCliSessions({ stateRoot: join(tmpdir(), "pw-env"), binDirectory: join(tmpdir(), "pw-env", "bin") });
  assert.equal(sessions.environmentFor({ runId: "r", sessionId: "a" }), undefined, "a run that did not opt in gets nothing");
  sessions.configureRun("r", { browser: "chrome" });
  const factory = createChildEnvironmentFactory({ credentialResolver: { consume() { throw new Error("none"); } }, processEnvironment: sessions.environmentFor });
  const read = (sessionId: string | undefined, explicit: Record<string, string> = {}) => {
    const prepared = factory.prepare({ ambient: { PATH: "/usr/bin", HOME: "/h" }, explicitOverrides: explicit, runId: "r", ...(sessionId ? { sessionId } : {}) });
    return factory.withChildEnvironment(prepared.capability, (environment) => ({ ...environment }));
  };
  const a = read("a", { PLAYWRIGHT_CLI_SESSION: "forged" });
  assert.equal(a.PLAYWRIGHT_CLI_SESSION, playwrightCliSessionName("r", "a"), "Runner authority wins over a caller's value");
  assert.match(a.PLAYWRIGHT_CLI_SESSION!, /^t-[0-9a-f]{8}$/);
  assert.equal(a.PWTEST_DAEMON_SESSION_DIR, join(sessions.ownerFolder({ runId: "r", sessionId: "a" }), "registry"));
  assert.equal(a.PLAYWRIGHT_MCP_OUTPUT_DIR, PLAYWRIGHT_CLI_OUTPUT_FOLDER);
  assert.equal(a.AIBOARD_PLAYWRIGHT_BROWSER, "chrome");
  const path = a.PATH ?? a.Path!;
  assert.equal(path.split(WINDOWS ? ";" : ":")[0], join(tmpdir(), "pw-env", "bin"));
  assert.ok(path.endsWith("/usr/bin"));
  // The daemon-only folders are not set for ordinary commands.
  for (const name of ["TMPDIR", "TEMP", "TMP", "XDG_CONFIG_HOME", "PWTEST_SOCKETS_DIR"]) assert.equal(a[name], undefined, name);
  const b = read("b");
  assert.notEqual(b.PLAYWRIGHT_CLI_SESSION, a.PLAYWRIGHT_CLI_SESSION);
  assert.notEqual(b.PWTEST_DAEMON_SESSION_DIR, a.PWTEST_DAEMON_SESSION_DIR);
  assert.equal(read(undefined).PLAYWRIGHT_CLI_SESSION, undefined, "no owner, no session");
  sessions.configureRun("r", { browser: null });
  assert.equal(read("a").AIBOARD_PLAYWRIGHT_BROWSER, undefined, "no browser: the session command says so");
});

test("the POSIX socket path fits in 103 bytes with the Runner's real state paths, or moves to a short folder", () => {
  // The default state directory: <home>/.aiboard/runner-v2/... with a project hash, and the run's segment and session.
  const realistic = new PlaywrightCliSessions({ stateRoot: join(homedir(), ".aiboard", "runner-v2", "state", "a".repeat(64), "pw"), binDirectory: "/bin", platform: "linux" });
  for (const sessions of [realistic, new PlaywrightCliSessions({ stateRoot: "/tmp/s/pw", binDirectory: "/bin", platform: "linux" })]) {
    const owner = { runId: "run-0f6c3a0e-7d1e-4c55-9f00-1234567890ab", sessionId: "worker-task-7-attempt-2" };
    const socket = `${sessions.socketFolder(owner)}${"/cli/"}${"0".repeat(16)}-${playwrightCliSessionName(owner.runId, owner.sessionId)}.sock`;
    assert.ok(Buffer.byteLength(socket) <= POSIX_SOCKET_PATH_MAX, `${socket} is ${Buffer.byteLength(socket)} bytes`);
  }
  assert.equal(POSIX_SOCKET_NAME_BYTES, "/cli/".length + 16 + 1 + 10 + 5);
  const short = new PlaywrightCliSessions({ stateRoot: "/tmp/s/pw", binDirectory: "/bin", platform: "linux" });
  assert.ok(short.socketFolder({ runId: "r", sessionId: "a" }).startsWith(short.ownerFolder({ runId: "r", sessionId: "a" })), "a short state root keeps the socket in the owner's folder");
});

test("Playwright still reads the hooks the session design relies on (fails when an upgrade drops one)", () => {
  const require = createRequire(import.meta.url);
  const core = dirname(createRequire(require.resolve("playwright/package.json")).resolve("playwright-core/package.json"));
  const registry = readFileSync(join(core, "lib", "tools", "cli-client", "registry.js"), "utf8");
  assert.match(registry, /process\.env\.PWTEST_DAEMON_SESSION_DIR/, "the client's registry folder");
  const bundle = readFileSync(join(core, "lib", "coreBundle.js"), "utf8");
  assert.match(bundle, /if \(process\.env\.PWTEST_DAEMON_SESSION_DIR\)\s*return process\.env\.PWTEST_DAEMON_SESSION_DIR;/, "the daemon's registry folder");
  assert.match(bundle, /process\.env\.PWTEST_SOCKETS_DIR \|\|/, "the POSIX socket folder");
  assert.match(bundle, /UNIX_SOCKET_PATH_MAX = 103/, "the socket budget this module computes with");
  assert.match(bundle, /options\.outputDir = envToString\(e\.PLAYWRIGHT_MCP_OUTPUT_DIR\)/, "the output folder");
  assert.match(bundle, /"Daemon listening on/, "the readiness line");
  assert.ok(existsSync(resolvePlaywrightCliInstall().daemon), "the daemon entry the session command runs");
  assert.ok(existsSync(resolvePlaywrightCliInstall().cli), "the CLI entry the shim runs");
});

test("the shims run the bundled CLI and daemon in the foreground: an exec-ing sh script on POSIX, a .cmd on Windows", () => {
  const install = { node: "/opt/aiboard/node", cli: "/opt/aiboard/app/node_modules/playwright/cli.js", daemon: "/opt/aiboard/app/node_modules/playwright-core/lib/entry/cliDaemon.js", guard: "/opt/aiboard/app/runner-v2/src/playwright-cli-guard.mjs" };
  for (const platform of ["linux", "darwin"] as const) {
    const [session, cli] = playwrightCliShimFiles(install, platform);
    assert.equal(session!.name, "playwright-cli-session");
    assert.match(session!.content, /^#!\/bin\/sh\n/);
    assert.match(session!.content, /\nexec '\/opt\/aiboard\/node' '\/opt\/aiboard\/app\/node_modules\/playwright-core\/lib\/entry\/cliDaemon\.js' "\$PLAYWRIGHT_CLI_SESSION" "--browser=\$AIBOARD_PLAYWRIGHT_BROWSER"/);
    assert.match(session!.content, /aiboard browser install/);
    assert.equal(session!.content.includes("XDG_CONFIG_HOME"), platform === "linux");
    assert.match(session!.content, /PWTEST_SOCKETS_DIR=/);
    assert.doesNotMatch(session!.content, / open\b|&\s*$|nohup|setsid/m, "never detached, never the CLI's open");
    assert.equal(cli!.name, "playwright-cli");
    assert.match(cli!.content, /exec '\/opt\/aiboard\/node' '\/opt\/aiboard\/app\/runner-v2\/src\/playwright-cli-guard\.mjs' "\$@"/);
    assert.equal(session!.mode, 0o755);
  }
  const [session, cli] = playwrightCliShimFiles({ ...install, node: "C:\\AIBoard\\node.exe", daemon: "C:\\AIBoard\\app\\cliDaemon.js", guard: "C:\\AIBoard\\guard.mjs" }, "win32");
  assert.equal(session!.name, "playwright-cli-session.cmd");
  assert.match(session!.content, /"C:\\AIBoard\\node\.exe" "C:\\AIBoard\\app\\cliDaemon\.js" "%PLAYWRIGHT_CLI_SESSION%" --browser=%AIBOARD_PLAYWRIGHT_BROWSER%/);
  assert.match(session!.content, /set "TEMP=%AIBOARD_PLAYWRIGHT_STATE%\\tmp"/);
  assert.match(session!.content, /aiboard browser install/);
  assert.doesNotMatch(session!.content, /start "|start \/b/i, "never detached");
  assert.equal(cli!.name, "playwright-cli.cmd");
  assert.match(cli!.content, /"C:\\AIBoard\\node\.exe" "C:\\AIBoard\\guard\.mjs" %\*/);
});

// ---------------------------------------------------------------- the POSIX post-stop check (fake process table)

test("the POSIX post-stop check runs on the session's own stop, kills only exact matches of the Runner's user, and fails closed", async () => {
  const root = await mkdtemp(join(tmpdir(), "pw-check-"));
  try {
    type Proc = { pid: number; pgid: number; birth: string; uid: number; command: string; alive: boolean; immortal?: boolean };
    const table = new Map<number, Proc>();
    const kills: string[] = [];
    let lists = 0;
    let listable = true;
    const add = (proc: Omit<Proc, "alive" | "uid"> & { uid?: number }) => table.set(proc.pid, { uid: 1000, ...proc, alive: true });
    const processes: PosixProcessTable = {
      list: () => { lists += 1; return listable ? [...table.values()].filter((p) => p.alive).map((p) => ({ pid: p.pid, groupId: p.pgid, birth: p.birth, uid: p.uid, command: p.command })) : undefined; },
      inspect: (pids) => new Map(pids.map((pid) => {
        if (pid === process.pid) return [pid, { state: "present", value: { pid, groupId: 4242, birth: "self" } }] as const;
        const p = table.get(pid);
        return [pid, p?.alive ? { state: "present", value: { pid, groupId: p.pgid, birth: p.birth } } : { state: "absent" }] as const;
      })),
      kill: (pid, signal) => {
        kills.push(`${pid}:${signal}`);
        for (const p of table.values()) if ((pid < 0 ? p.pgid === -pid : p.pid === pid) && !p.immortal) p.alive = false;
      },
      uid: () => 1000,
    };
    const records: string[] = [];
    const sessions = new PlaywrightCliSessions({ stateRoot: join(root, "pw"), binDirectory: join(root, "bin"), platform: "linux", processes,
      graceMs: 200, killVerifyMs: 200, sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 10))), onCleanup: (record) => { records.push(record.status); } });
    const owner = { runId: "run-1", sessionId: "worker-a", actor: { role: "worker" as const, id: "worker-a" } };
    sessions.configureRun(owner.runId, { browser: "chromium" });
    const folder = sessions.ownerFolder(owner);
    await mkdir(folder, { recursive: true });
    const observer = sessions.stopObserver();
    // In production the stop target's pid is the POSIX supervisor's, never the daemon's: the check must not depend on it.
    const target = (processId: string) => ({ ...owner, processId, pid: 99, status: "running" as const, exitCode: null, signal: null, startedAt: "", updatedAt: "", stdout: "", stderr: "" });
    const launch = (processId: string, command = "playwright-cli-session", args: string[] = []) => observer.launching!({ runId: owner.runId, sessionId: owner.sessionId, processId, command, args });
    const stop = async (processId: string, die: () => void = () => {}) => { const recorded = await observer.beforeStop(target(processId)); die(); await observer.afterStop(target(processId), recorded); };

    launch("mp-session");
    launch("mp-dev", "npm", ["run", "dev"]);
    launch("mp-forged", "sh", ["-c", "playwright-cli-session"]);
    add({ pid: 100, pgid: 100, birth: "b100", command: `node /app/cliDaemon.js t-1 --browser=chromium --config=${folder}${sep}cli.config.json` });
    add({ pid: 200, pgid: 200, birth: "b200", command: `/chrome --user-data-dir=${folder}${sep}tmp/playwright_chromiumdev_profile-x --remote-debugging-pipe` });
    add({ pid: 201, pgid: 200, birth: "b201", command: `/chrome --type=renderer --user-data-dir=${folder}${sep}tmp/p` });
    add({ pid: 300, pgid: 299, birth: "b300", command: `/chrome_crashpad_handler --database=${folder}${sep}xdg/Crash Reports` });
    add({ pid: 400, pgid: 400, birth: "b400", command: "/usr/bin/google-chrome --user-data-dir=/home/u/.config/google-chrome" });
    add({ pid: 410, pgid: 410, birth: "b410", command: `/chrome --user-data-dir=${folder}x${sep}tmp/p`, });
    add({ pid: 420, pgid: 420, birth: "b420", uid: 0, command: `less ${folder}${sep}cli.config.json` });

    // A stop of anything but the session process (a dev server, a forged `sh -c`) is not checked and lists nothing.
    await stop("mp-dev");
    await stop("mp-forged");
    assert.equal(lists, 0, "no process listing on other processes' stops");
    assert.deepEqual(kills, []);

    // The session's stop (its group dies with the daemon); Chrome and crashpad linger outside the group.
    await stop("mp-session", () => { table.get(100)!.alive = false; });
    assert.deepEqual(kills.sort(), ["-200:SIGKILL", "300:SIGKILL"], "Chrome's own group by its leader, crashpad by PID");
    assert.equal(table.get(400)!.alive, true, "the user's own Chrome is never matched by name");
    assert.equal(table.get(410)!.alive, true, "a longer sibling folder is not the owner's folder");
    assert.equal(table.get(420)!.alive, true, "another user's process is never attributed");
    const last = sessions.cleanupRecords().at(-1)!;
    assert.equal(last.status, "killed");
    assert.deepEqual([...last.killed].sort(), [200, 300]);
    assert.deepEqual(records, ["killed"], "every outcome reaches onCleanup");
    table.get(410)!.alive = false; // inside the run folder, so the run's own removal would sweep it
    table.get(420)!.alive = false; // the other user's `less` ends, so nothing names the folder any more
    await mkdir(folder, { recursive: true });

    // A recorded PID reused by another program (new birth) is never signalled.
    kills.length = 0;
    launch("mp-session-2");
    add({ pid: 700, pgid: 700, birth: "b700", command: `/chrome --user-data-dir=${folder}${sep}tmp/p` });
    await stop("mp-session-2", () => { table.set(700, { pid: 700, pgid: 700, birth: "reused", uid: 1000, command: "/bin/other", alive: true }); });
    assert.deepEqual(kills, [], "a PID whose birth changed is not the recorded process");

    // A session started again between the two halves of a stop: only what was recorded before is killed; the new
    // session's browser and the folder stay.
    launch("mp-session-3");
    add({ pid: 710, pgid: 710, birth: "b710", command: `/chrome --user-data-dir=${folder}${sep}tmp/old` });
    await mkdir(folder, { recursive: true });
    await stop("mp-session-3", () => {
      launch("mp-session-4");
      add({ pid: 720, pgid: 720, birth: "b720", command: `/chrome --user-data-dir=${folder}${sep}tmp/new` });
    });
    assert.deepEqual(kills, ["-710:SIGKILL"]);
    assert.equal(table.get(720)!.alive, true, "the restarted session's browser is left alone");
    assert.equal(existsSync(folder), true);
    table.get(720)!.alive = false;

    // Nothing could be listed before or after the stop: unknown, and the stop fails closed.
    listable = false;
    await assert.rejects(stop("mp-session-4"), /could not be listed/);
    assert.equal(sessions.cleanupRecords().at(-1)!.status, "unknown");
    listable = true;

    // A survivor of SIGKILL leaves the stop unverified and keeps the folder.
    launch("mp-session-5");
    add({ pid: 800, pgid: 800, birth: "b800", command: `/chrome --user-data-dir=${folder}${sep}tmp/p`, immortal: true });
    await assert.rejects(stop("mp-session-5"), /still running after SIGKILL/);
    assert.equal(sessions.cleanupRecords().at(-1)!.status, "unverified");
    assert.equal(existsSync(folder), true, "an unverified stop keeps the folder");
    table.get(800)!.alive = false;

    // A session that ended by itself was never stopped: the run's removal sweeps what still names its folder.
    add({ pid: 900, pgid: 900, birth: "b900", command: `/chrome_crashpad_handler --database=${folder}${sep}xdg/Crash Reports` });
    kills.length = 0;
    await sessions.removeRun(owner.runId);
    assert.deepEqual(kills, ["-900:SIGKILL"]);
    assert.equal(sessions.cleanupRecords().at(-1)!.processId, "run");
    assert.equal(existsSync(sessions.runFolder(owner.runId)), false);

    // Windows has the Job's proof: the check does nothing there.
    const windows = new PlaywrightCliSessions({ stateRoot: join(root, "pw"), binDirectory: join(root, "bin"), platform: "win32", processes });
    windows.configureRun(owner.runId, { browser: "chrome" });
    kills.length = 0; lists = 0;
    const w = windows.stopObserver();
    w.launching!({ runId: owner.runId, sessionId: owner.sessionId, processId: "mp-w", command: "playwright-cli-session", args: [] });
    await w.afterStop(target("mp-w"), await w.beforeStop(target("mp-w")));
    assert.deepEqual(kills, []);
    assert.equal(lists, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- the output folder and the task commit

test("the output folder never lands in a task commit: the Runner's git add -A takes the screenshot's neighbours, never the folder", async () => {
  const root = await mkdtemp(join(tmpdir(), "pw-git-"));
  try {
    const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8" });
    git("init", "-q");
    git("config", "user.email", "t@example.com"); git("config", "user.name", "t"); git("config", "core.autocrlf", "false");
    await writeFile(join(root, "README.md"), "x\n");
    git("add", "-A"); git("commit", "-q", "-m", "base");
    // What the session command does in the agent's workspace, then what a model and the CLI write there.
    const out = join(root, PLAYWRIGHT_CLI_OUTPUT_FOLDER);
    await mkdir(out);
    await writeFile(join(out, ".gitignore"), "*\n");
    await writeFile(join(out, "page-1.yml"), "- heading\n");
    await writeFile(join(out, "home.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    await writeFile(join(root, "app.js"), "console.log(1)\n");
    assert.equal(git("status", "--porcelain=v1", "--untracked-files=all").trim(), "?? app.js");
    git("add", "-A");
    assert.deepEqual(git("diff", "--cached", "--name-only").trim().split("\n"), ["app.js"]);
    // And the shims write exactly that .gitignore.
    for (const platform of ["linux", "win32"] as const) {
      const session = playwrightCliShimFiles(resolvePlaywrightCliInstall(), platform)[0]!.content;
      assert.ok(platform === "win32" ? session.includes('>"%PLAYWRIGHT_MCP_OUTPUT_DIR%\\.gitignore" echo *') : session.includes("printf '*\\n' > \"$PLAYWRIGHT_MCP_OUTPUT_DIR/.gitignore\""), platform);
    }
    assert.deepEqual((await readdir(out)).sort(), [".gitignore", "home.png", "page-1.yml"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the POSIX process table reads birth with the command line, leaves zombies out, and matches inspect's birth", async () => {
  const { parsePosixPsCommands, parsePosixPsIdentity } = await import("../src/portable-process-posix-control.mjs");
  const rows = parsePosixPsCommands("  501   501   501 Ss   Thu Nov  3 10:00:00 2026 /bin/zsh -l\n  777   700   501 Z    Thu Nov 13 10:00:00 2026 (chrome)\n");
  assert.deepEqual(rows, [{ pid: 501, groupId: 501, uid: 501, birth: "Thu Nov  3 10:00:00 2026", command: "/bin/zsh -l" }]);
  assert.equal(parsePosixPsIdentity(501, "  501   501 Thu Nov  3 10:00:00 2026")?.birth, rows![0]!.birth, "the same fingerprint as the stop check's re-read");
  assert.deepEqual(parsePosixPsCommands("  777   700   501 Z    Thu Nov 13 10:00:00 2026 (chrome)\n"), [], "only zombies: an empty table, not an unreadable one");
  assert.equal(parsePosixPsCommands(""), undefined);
  assert.equal(parsePosixPsCommands("garbage"), undefined);
});
