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
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

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
const browserSkip = BROWSER ? false : "no Chrome, Edge or Playwright Chromium on this machine";

// ---------------------------------------------------------------- a process census keyed on the owner's folder

interface Row { pid: number; ppid: number; command: string }
function processTable(): Row[] {
  if (!WINDOWS) return [...(listPosixProcessCommands() ?? [])];
  const script = "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CommandLine | ConvertTo-Json -Compress";
  const out = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8", maxBuffer: 64 << 20, windowsHide: true }).trim();
  const rows = out ? JSON.parse(out) : [];
  return (Array.isArray(rows) ? rows : [rows]).map((row: { ProcessId: number; ParentProcessId: number; CommandLine: string | null }) => ({ pid: row.ProcessId, ppid: row.ParentProcessId, command: row.CommandLine ?? "" }));
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

// ---------------------------------------------------------------- 1. three calls, close, and the output folder

test("a managed session serves later CLI calls, keeps its files in the gitignored output folder, and stops with close", { skip: browserSkip, timeout: 240_000 }, async () => {
  const site = await page();
  try {
    await withRun("close", async (f) => {
      const { processId } = await f.start();
      const goto = await f.cli(["--json", "goto", site.url]);
      assert.equal(goto.output.isError, false, goto.text);
      assert.notEqual(goto.json?.isError, true, goto.text);
      const title = await f.cli(["--json", "eval", "document.title"]);
      assert.match(title.text, /VF7b probe/, title.text);
      const shot = await f.cli(["--json", "screenshot", `--filename=${PLAYWRIGHT_CLI_OUTPUT_FOLDER}/home.png`]);
      assert.notEqual(shot.json?.isError, true, shot.text);
      const png = readFileSync(join(f.project, PLAYWRIGHT_CLI_OUTPUT_FOLDER, "home.png"));
      assert.equal(png.subarray(1, 4).toString("latin1"), "PNG");
      // The folder ignores itself, so a task commit (`git add -A`) never takes it.
      assert.equal(readFileSync(join(f.project, PLAYWRIGHT_CLI_OUTPUT_FOLDER, ".gitignore"), "utf8").trim(), "*");
      const console = await f.cli(["--json", "console"]);
      assert.match(console.text, /page-loaded/, console.text);
      // The registry is the owner's own (PWTEST_DAEMON_SESSION_DIR), and its socket fits the POSIX budget.
      const registry = join(f.folder(), "registry");
      const sessionFile = readdirSync(registry, { recursive: true }).map(String).find((name) => name.endsWith(".session"));
      assert.ok(sessionFile, `the session registered in ${registry}`);
      const socketPath = String((JSON.parse(readFileSync(join(registry, sessionFile!), "utf8")) as { socketPath?: string }).socketPath ?? "");
      if (!WINDOWS) {
        assert.ok(socketPath.startsWith(f.sessions.socketFolder({ runId: f.runId, sessionId: "worker-a" })), socketPath);
        assert.ok(Buffer.byteLength(socketPath) <= POSIX_SOCKET_PATH_MAX, `${socketPath} is ${Buffer.byteLength(socketPath)} bytes`);
      }
      const closed = await f.cli(["close"]);
      assert.match(closed.text, /closed/i, closed.text);
      const stopped = await waitFor(() => 0, () => true, 0);
      void stopped;
      const state = await (async () => { for (let i = 0; i < 60; i += 1) { const p = await poll(f, processId); if (p.status !== "running") return p; await sleep(500); } return poll(f, processId); })();
      assert.notEqual(state.status, "running", JSON.stringify(state));
      assert.equal(state.exitCode, 0, JSON.stringify(state));
      const left = await waitFor(() => sessionProcesses(f.folder()), (rows) => rows.length === 0, 10_000);
      assert.deepEqual(left, [], "nothing of the session is left after close");
      // A later call says how to start it again, not the CLI's own "run open".
      const after = await f.cli(["snapshot"]);
      assert.match(after.text, /process\.start: command playwright-cli-session/, after.text);
      assert.doesNotMatch(after.text, /playwright-cli open/, after.text);
    });
  } finally { await site.close(); }
});

// ---------------------------------------------------------------- 2. every kill kind, and 5. no profile in the user's temp

for (const kind of ["SIGTERM", "SIGKILL", "task end", "daemon only", "chrome only"] as const) {
  test(`after ${kind}, no daemon, browser or crashpad of the session is left`, { skip: browserSkip, timeout: 240_000 }, async () => {
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
        if (!WINDOWS && kind !== "task end") {
          const records = f.sessions.cleanupRecords();
          assert.ok(records.every((record) => record.status !== "unverified"), JSON.stringify(records));
        }
      });
    } finally { await site.close(); }
    const fresh = profilesInUserTemp().filter((name) => !profilesBefore.has(name));
    assert.deepEqual(fresh, [], "no browser profile or artifacts folder is left in the user's temp folder");
    assert.equal(existsSync(folder), false, "the owner's state folder is removed with the run");
  });
}

// ---------------------------------------------------------------- 4. two agent sessions

test("two agent sessions never share a browser session, and one cannot list or drive the other's", { skip: browserSkip, timeout: 240_000 }, async () => {
  const site = await page();
  try {
    await withRun("two", async (f) => {
      assert.notEqual(playwrightCliSessionName(f.runId, "worker-a"), playwrightCliSessionName(f.runId, "worker-b"));
      await f.start("worker-a");
      await f.start("worker-b");
      await f.cli(["goto", site.url], "worker-a");
      await f.cli(["goto", `${site.url}?b`], "worker-b");
      const listA = await f.cli(["list"], "worker-a");
      assert.ok(listA.text.includes(playwrightCliSessionName(f.runId, "worker-a")), listA.text);
      assert.ok(!listA.text.includes(playwrightCliSessionName(f.runId, "worker-b")), listA.text);
      const foreign = await f.cli([`-s=${playwrightCliSessionName(f.runId, "worker-b")}`, "eval", "location.href"], "worker-a");
      assert.match(foreign.text, /Refused by AIBoard: -s\/--session names another browser session/, foreign.text);
      const hrefA = await f.cli(["eval", "location.href"], "worker-a");
      assert.ok(hrefA.text.includes(site.url) && !hrefA.text.includes("?b"), hrefA.text);
      // Ending one owner stops only its browser.
      await f.run.managedProcesses.closeAgent({ runId: f.runId, sessionId: "worker-b", actor: { role: "worker", id: "worker-b" } });
      const leftB = await waitFor(() => sessionProcesses(f.folder("worker-b")), (rows) => rows.length === 0, 15_000);
      assert.deepEqual(leftB, []);
      assert.ok(sessionProcesses(f.folder("worker-a")).length > 0, "worker-a's browser still runs");
      assert.match((await f.cli(["eval", "document.title"], "worker-a")).text, /VF7b probe/);
    });
  } finally { await site.close(); }
});

// ---------------------------------------------------------------- no browser: a clear message, nothing started

test("with no usable browser the session command fails at once and names aiboard browser install", { timeout: 120_000 }, async () => {
  await withRun("nobrowser", async (f) => {
    const output = await f.invoke("process.start", { command: "playwright-cli-session", until: { pattern: PLAYWRIGHT_CLI_READY_PATTERN }, waitMs: 30_000 });
    const text = JSON.stringify(output.content);
    assert.match(text, /aiboard browser install/, text);
    assert.equal(sessionProcesses(f.folder()).length, 0);
  }, null);
});

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

test("a refused command through the Runner's process.run says so and starts nothing", { timeout: 120_000 }, async () => {
  await withRun("refused", async (f) => {
    const opened = await f.cli(["open", "about:blank"]);
    assert.match(opened.text, /Refused by AIBoard: playwright-cli open/, opened.text);
    const killed = await f.cli(["kill-all"]);
    assert.match(killed.text, /Refused by AIBoard/, killed.text);
    assert.equal(sessionProcesses(f.folder()).length, 0);
    const notRunning = await f.cli(["snapshot"]);
    assert.match(notRunning.text, /is not running\. Start this agent session's browser once with process\.start/, notRunning.text);
  });
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

test("the POSIX post-stop check kills only processes it attributes exactly, by PID and birth, and fails closed when one survives", async () => {
  const root = await mkdtemp(join(tmpdir(), "pw-check-"));
  try {
    type Proc = { pid: number; ppid: number; pgid: number; birth: string; command: string; alive: boolean; immortal?: boolean };
    const table = new Map<number, Proc>();
    const kills: string[] = [];
    const add = (proc: Omit<Proc, "alive">) => table.set(proc.pid, { ...proc, alive: true });
    const processes: PosixProcessTable = {
      list: () => [...table.values()].filter((p) => p.alive).map((p) => ({ pid: p.pid, ppid: p.ppid, command: p.command })),
      inspect: (pid) => {
        const p = table.get(pid);
        if (pid === process.pid) return { state: "present", value: { pid, groupId: 4242, birth: "self" } };
        return p?.alive ? { state: "present", value: { pid, groupId: p.pgid, birth: p.birth } } : { state: "absent" };
      },
      kill: (pid, signal) => {
        kills.push(`${pid}:${signal}`);
        for (const p of table.values()) if ((pid < 0 ? p.pgid === -pid : p.pid === pid) && !p.immortal) p.alive = false;
      },
    };
    const sessions = new PlaywrightCliSessions({ stateRoot: join(root, "pw"), binDirectory: join(root, "bin"), platform: "linux", processes, graceMs: 200, killVerifyMs: 200, sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 10))) });
    const owner = { runId: "run-1", sessionId: "worker-a", actor: { role: "worker" as const, id: "worker-a" } };
    sessions.configureRun(owner.runId, { browser: "chromium" });
    const folder = sessions.ownerFolder(owner);
    await mkdir(folder, { recursive: true });
    const daemon = { ...owner, processId: "mp-1", pid: 100, status: "running" as const, exitCode: null, signal: null, startedAt: "", updatedAt: "", stdout: "", stderr: "" };
    add({ pid: 100, ppid: 50, pgid: 100, birth: "b100", command: `node /app/cliDaemon.js t-1 --browser=chromium --config=${folder}/cli.config.json` });
    add({ pid: 200, ppid: 100, pgid: 200, birth: "b200", command: `/chrome --user-data-dir=${folder}/tmp/playwright_chromiumdev_profile-x --remote-debugging-pipe` });
    add({ pid: 201, ppid: 200, pgid: 200, birth: "b201", command: `/chrome --type=renderer --user-data-dir=${folder}/tmp/p` });
    add({ pid: 300, ppid: 1, pgid: 299, birth: "b300", command: `/chrome_crashpad_handler --database=${folder}/xdg/Crash Reports` });
    add({ pid: 400, ppid: 1, pgid: 400, birth: "b400", command: "/usr/bin/google-chrome --user-data-dir=/home/u/.config/google-chrome" });
    add({ pid: 500, ppid: 100, pgid: 4242, birth: "b500", command: "unrelated child sharing the Runner's own group" });
    const observer = sessions.stopObserver();

    // Another of the owner's processes stops while the session runs: nothing of the session is touched.
    const devServer = { ...daemon, processId: "mp-2", pid: 600 };
    const skip = await observer.beforeStop(devServer);
    await observer.afterStop(devServer, skip);
    assert.deepEqual(kills, []);

    // The daemon stops (its group dies); Chrome and crashpad linger outside the group.
    const recorded = await observer.beforeStop(daemon);
    table.get(100)!.alive = false;
    table.get(500)!.alive = false;
    await observer.afterStop(daemon, recorded);
    assert.deepEqual(kills.sort(), ["-200:SIGKILL", "300:SIGKILL"], "Chrome's own group by its leader, crashpad by PID; never the user's Chrome or the Runner's group");
    assert.equal(table.get(400)!.alive, true, "the user's own Chrome is never matched by name");
    const last = sessions.cleanupRecords().at(-1)!;
    assert.equal(last.status, "killed");
    assert.deepEqual([...last.killed].sort(), [200, 300]);
    assert.equal(existsSync(folder), false, "the owner's folder goes once nothing names it");

    // A recorded PID reused by another program (new birth) is never signalled.
    await mkdir(folder, { recursive: true });
    kills.length = 0;
    add({ pid: 700, ppid: 1, pgid: 700, birth: "b700", command: `/chrome --user-data-dir=${folder}/tmp/p` });
    const again = await observer.beforeStop({ ...daemon, pid: 0 });
    table.set(700, { pid: 700, ppid: 1, pgid: 700, birth: "reused", command: "/bin/other", alive: true });
    await observer.afterStop({ ...daemon, pid: 0 }, again);
    assert.deepEqual(kills, [], "a PID whose birth changed is not the recorded process");

    // A survivor of SIGKILL leaves the stop unverified.
    await mkdir(folder, { recursive: true });
    add({ pid: 800, ppid: 1, pgid: 800, birth: "b800", command: `/chrome --user-data-dir=${folder}/tmp/p`, immortal: true });
    table.get(800)!.immortal = true;
    await assert.rejects(async () => { const r = await observer.beforeStop({ ...daemon, pid: 0 }); await observer.afterStop({ ...daemon, pid: 0 }, r); }, /still running after SIGKILL/);
    assert.equal(sessions.cleanupRecords().at(-1)!.status, "unverified");
    assert.equal(existsSync(folder), true, "an unverified stop keeps the folder");

    // Windows has the Job's proof: the check does nothing there.
    const windows = new PlaywrightCliSessions({ stateRoot: join(root, "pw"), binDirectory: join(root, "bin"), platform: "win32", processes });
    windows.configureRun(owner.runId, { browser: "chrome" });
    kills.length = 0;
    const w = windows.stopObserver();
    await w.afterStop(daemon, await w.beforeStop(daemon));
    assert.deepEqual(kills, []);
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
