// CLI workers CW3 (docs/plans/2026-11-14-cli-workers.md §3.2, §3.4): the free checks (`GET /v2/cli-workers`) and the
// Test button (`POST /v2/cli-workers/<providerId>/test`). Fake CLIs only (test/support/fake-cli.mjs): no test starts a
// real CLI or sends a prompt. The OS is a seam, so the Windows-only v1 path runs on every CI host.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { resolveAiboardHome, type AiboardHomeLocation } from "../src/aiboard-home-paths.js";
import { applyHomeBatch, readAiboardHome } from "../src/aiboard-home-store.js";
import type { CheckToolLookup } from "../src/check-tool-lookup.js";
import { buildCliWorkerArgs } from "../src/cli-worker-adapters.js";
import type { CliWorkerProviderId } from "../src/cli-worker-config.js";
import { CliWorkerDetection, cliWorkerCmdArgumentRefusal, type CliWorkerCheck, type CliWorkerDetectionOptions } from "../src/cli-worker-detection.js";
import { ControlServer } from "../src/control-server.js";
import type { ProcessHostSemanticFact } from "../src/process-host-semantic-probes.js";
import { RunSupervisor } from "../src/run-supervisor.js";
import {
  createRunnerInternalProcessKernel,
  type RunnerInternalOwnedProcess,
  type RunnerInternalProcessKernel,
  type RunnerInternalProcessLaunchInput,
} from "../src/runner-internal-process-kernel.js";
import { SqliteEventStore } from "../src/sqlite-event-store.js";
import { cliFixture, FAKE_CLI_SCENARIO_ENV, FAKE_CLI_SCRIPT, writeFakeCliScenario, type FakeCliRecord, type FakeCliScenario } from "./support/fake-cli.js";

const token = "test-control-token";
const CLAUDE = "C:\\Tools\\claude.exe";
const AGY = "C:\\Tools\\agy.exe";
const CODEX = "C:\\Tools\\codex.exe";
const CANARIES = ["canary@example.test", "Canary Org", "00000000-0000-4000-8000-000000000000", "loginExpiresAt", "2099-01-01T00:00:00.000Z", "credential_expires_at"];

// ---------------------------------------------------------------------------------------------------------------
// A launcher double: real child processes (node + the fake CLI), with a stop that is proven by waiting for the exit,
// or reported unproven on demand. Each launch's scenario follows the CLI path the detection resolved.

interface Launcher extends Pick<RunnerInternalProcessKernel, "launch"> {
  launches: RunnerInternalProcessLaunchInput[];
  failStop: boolean;
}

function fakeLauncher(scenarios: Map<string, string>): Launcher {
  const launcher: Launcher = {
    launches: [],
    failStop: false,
    async launch(input) {
      launcher.launches.push(input);
      const scenario = scenarios.get(input.executable);
      if (!scenario) throw new Error(`no fake CLI for ${input.executable}`);
      const child = spawn(process.execPath, [FAKE_CLI_SCRIPT, ...input.arguments], {
        cwd: input.workingDirectory,
        env: { ...input.environment, [FAKE_CLI_SCENARIO_ENV]: scenario },
        stdio: "pipe",
        windowsHide: true,
      });
      let exitCode: number | null | undefined;
      const closed = new Promise<void>((resolve) => child.on("close", (code) => { exitCode = code; resolve(); }));
      child.on("error", () => undefined);
      child.stdin.on("error", () => undefined);
      const pending: Array<["stdout" | "stderr", Uint8Array]> = [];
      let sink: ((metadata: { stream: string }, bytes: Uint8Array) => void | Promise<void>) | undefined;
      const deliver = (stream: "stdout" | "stderr") => (bytes: Buffer) => {
        if (sink) void sink({ stream }, bytes);
        else pending.push([stream, bytes]);
      };
      child.stdout.on("data", deliver("stdout"));
      child.stderr.on("data", deliver("stderr"));
      const owned = {
        binding: {} as RunnerInternalOwnedProcess["binding"],
        setOutputSink(next: typeof sink) {
          sink = next;
          for (const [stream, bytes] of pending.splice(0)) void sink!({ stream }, bytes);
          return () => { sink = undefined; };
        },
        async write(payload: Uint8Array) { child.stdin.write(payload); },
        async closeInput() { child.stdin.end(); },
        async reconcile() { return { state: exitCode === undefined ? "running" : "exited" }; },
        async closeVerified() {
          if (exitCode === undefined) child.kill();
          await closed;
          if (launcher.failStop && input.runId === "runner-cli-worker-tests") throw new Error("Runner internal cleanup could not prove emptiness.");
          return exitCode === null || exitCode === undefined ? {} : { exitCode };
        },
      };
      return owned as unknown as RunnerInternalOwnedProcess;
    },
  };
  return launcher;
}

// ---------------------------------------------------------------------------------------------------------------

interface Fixture {
  root: string;
  state: string;
  location: AiboardHomeLocation;
  launcher: Launcher;
  detection: CliWorkerDetection;
  now: { value: number };
  ended: string[];
  responses: string[];
  call(path: string, init?: { method?: string; body?: unknown }): Promise<{ status: number; body: Record<string, unknown> }>;
  scenario(name: string, scenario: FakeCliScenario): string;
  record(name: string): FakeCliRecord;
  close(): Promise<void>;
}

interface FixtureOptions {
  platform?: NodeJS.Platform;
  isRoot?: boolean;
  batch?: ProcessHostSemanticFact;
  state?: string;
  found?: Partial<Record<string, string>>;
  absent?: string[];
  testTimeoutMs?: number;
  now?: number;
  launcher?: (root: string) => Pick<RunnerInternalProcessKernel, "launch">;
  command?: CliWorkerDetectionOptions["command"];
  scenarios?: (f: { scenario: Fixture["scenario"]; root: string }) => Record<string, string>;
}

async function fixture(options: FixtureOptions = {}): Promise<Fixture> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "aiboard-cli-workers-")));
  const userHome = join(root, "user");
  mkdirSync(userHome, { recursive: true });
  const location = resolveAiboardHome({
    platform: process.platform,
    environment: { AIBOARD_HOME: join(root, "home"), LOCALAPPDATA: join(userHome, "local"), XDG_DATA_HOME: join(userHome, "data") },
    home: userHome,
  });
  const state = options.state ?? join(root, "state");
  mkdirSync(state, { recursive: true });
  const scenarioDir = join(root, "scenarios");
  mkdirSync(scenarioDir, { recursive: true });
  const scenario = (name: string, value: FakeCliScenario) => writeFakeCliScenario(scenarioDir, value, `${name}.json`);
  const scenarios = new Map(Object.entries(options.scenarios?.({ scenario, root }) ?? {}));
  const launcher = fakeLauncher(scenarios);
  const found: Record<string, string> = { claude: CLAUDE, agy: AGY, codex: CODEX, ...options.found };
  const lookup: CheckToolLookup = async (name) => (found[name] ? { status: "found", path: found[name]! } : { status: "missing" });
  const now = { value: options.now ?? Date.parse("2026-11-18T00:00:00.000Z") };
  const detection = new CliWorkerDetection({
    stateDirectory: state,
    processes: options.launcher ? options.launcher(root) : launcher,
    environment: () => Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
    lookup,
    home: location,
    windowsBatchArgv: async () => options.batch ?? "verified",
    platform: options.platform ?? "win32",
    isRoot: () => options.isRoot ?? false,
    now: () => now.value,
    inspect: async (path) => (options.absent?.includes(path) ? "absent" : "file"),
    ...(options.command ? { command: options.command } : {}),
    ...(options.testTimeoutMs ? { testTimeoutMs: options.testTimeoutMs } : {}),
  });
  const ended: string[] = [];
  const supervisor = new RunSupervisor(new SqliteEventStore(join(root, "events.sqlite")));
  const server = new ControlServer({
    supervisor,
    token,
    bootstrapRun: async () => ({ baselineRevision: "a".repeat(40), baselineRef: "refs/x" }),
    runnerInfo: { projectPath: root, nodeVersion: process.versions.node },
    home: location,
    cliWorkers: detection,
    builds: { providerTestPassed: async (providerId: string) => { ended.push(providerId); return ["run_paused", "run_running"]; } } as never,
  });
  const { url } = await server.start(0);
  const responses: string[] = [];
  return {
    root, state, location, launcher, detection, now, ended, responses,
    async call(path, init = {}) {
      const response = await fetch(`${url}${path}`, {
        method: init.method ?? "GET",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
      });
      const text = await response.text();
      responses.push(text);
      return { status: response.status, body: text ? JSON.parse(text) as Record<string, unknown> : {} };
    },
    scenario,
    record: (name) => JSON.parse(readFileSync(join(scenarioDir, name), "utf8")) as FakeCliRecord,
    async close() {
      await server.close();
      supervisor.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function version(root: string, text: string): string {
  const path = join(root, `version-${text.replace(/\W+/g, "-")}.txt`);
  writeFileSync(path, `${text}\n`);
  return path;
}

/** Claude Code answering its free checks: logged in (the canary account fields included). */
function claudeScenario(f: { scenario: Fixture["scenario"]; root: string }, run: Partial<FakeCliScenario> = {}, login = "auth-status.logged-in.json"): string {
  return f.scenario("claude", {
    cli: "claude-code",
    responses: [
      { args: ["--version"], stdout: version(f.root, "2.1.326 (Claude Code)") },
      { args: ["auth", "status"], stdout: cliFixture(`claude-code/free/${login}`), exitCode: login.includes("logged-out") ? 1 : 0 },
    ],
    record: "claude-run.json",
    ...run,
  });
}

function agyScenario(f: { scenario: Fixture["scenario"]; root: string }, options: { quota?: string; loggedOut?: boolean; run?: Partial<FakeCliScenario> } = {}): string {
  return f.scenario("agy", {
    cli: "agy",
    responses: [
      { args: ["--version"], stdout: version(f.root, "1.5.10") },
      options.loggedOut
        ? { args: ["models"], stderr: cliFixture("agy/free/models-logged-out.synthetic.stderr.txt"), exitCode: 1 }
        : { args: ["models"], stdout: cliFixture("agy/free/models.txt") },
      { args: ["--output-format", "json", "-p=/quota"], stdout: cliFixture(`agy/free/${options.quota ?? "quota.json"}`) },
    ],
    record: "agy-run.json",
    ...options.run,
  });
}

function worker(body: Record<string, unknown>, providerId: CliWorkerProviderId): CliWorkerCheck {
  const workers = body.workers as CliWorkerCheck[];
  const found = workers.find((entry) => entry.providerId === providerId);
  assert.ok(found, providerId);
  return found;
}

function testFolders(f: Fixture): string[] {
  const folder = join(f.state, "cli-worker-tests");
  return existsSync(folder) ? readdirSync(folder) : [];
}

async function lastTest(f: Fixture, providerId: CliWorkerProviderId): Promise<Record<string, unknown> | undefined> {
  const snapshot = await readAiboardHome(f.location, { credentials: false });
  return snapshot.config.cliWorkers?.[providerId]?.lastTest as Record<string, unknown> | undefined;
}

// ---------------------------------------------------------------------------------------------------------------
// The free checks

test("on Linux and macOS every CLI is refused with its reason, and nothing is looked up or launched", async () => {
  for (const platform of ["linux", "darwin"] as const) {
    const f = await fixture({ platform });
    try {
      const { status, body } = await f.call("/v2/cli-workers");
      assert.equal(status, 200);
      assert.equal(body.platform, platform);
      for (const providerId of ["codex-cli", "claude-code", "agy"] as const) {
        const check = worker(body, providerId);
        assert.equal(check.status, "refused", `${providerId} on ${platform}`);
        assert.equal(check.code, "platform_refused");
        assert.match(check.reason!, platform === "linux" ? /not available on Linux/ : /not available on macOS/);
        assert.equal(check.executable, undefined, "a refused CLI is not even looked up");
      }
      assert.equal(f.launcher.launches.length, 0);
    } finally {
      await f.close();
    }
  }
});

test("on Windows Codex is refused until CW0b's fix, and Claude Code under root, each without a launch", async () => {
  const f = await fixture({ isRoot: true, scenarios: (s) => ({ [AGY]: agyScenario(s) }) });
  try {
    const { body } = await f.call("/v2/cli-workers");
    const codex = worker(body, "codex-cli");
    assert.equal(codex.status, "refused");
    assert.match(codex.reason!, /not available on Windows yet/);
    const claude = worker(body, "claude-code");
    assert.equal(claude.status, "refused");
    assert.equal(claude.code, "root_refused");
    assert.match(claude.reason!, /can't run as a worker when AIBoard runs as root/);
    assert.equal(worker(body, "agy").status, "ready", "the root rule is Claude Code's alone");
    assert.ok(f.launcher.launches.every((launch) => launch.executable === AGY), "only agy was launched");
  } finally {
    await f.close();
  }
});

test("a ready Claude Code: version, login method and catalog models, from a Runner-owned lookup folder, with no account field anywhere", async () => {
  const f = await fixture({ scenarios: (s) => ({ [CLAUDE]: claudeScenario(s), [AGY]: agyScenario(s) }) });
  try {
    const { body } = await f.call("/v2/cli-workers");
    const claude = worker(body, "claude-code");
    assert.equal(claude.status, "ready");
    assert.equal(claude.version, "2.1.326");
    assert.deepEqual(claude.login, { status: "logged_in", method: "claude.ai", subscription: "pro" });
    assert.deepEqual(claude.executable, { path: CLAUDE, source: "path", form: "exe" });
    assert.equal(claude.models?.[0]?.id, null, "CLI default first");
    assert.ok(claude.models?.some((model) => model.id === "opus"));
    const agy = worker(body, "agy");
    assert.equal(agy.status, "ready");
    assert.equal(agy.version, "1.5.10");
    assert.ok(agy.models?.some((model) => model.id === "gemini-4-argon-high"));
    assert.ok(agy.quota && agy.quota.length > 0);
    const lookupFolder = join(f.state, "cli-workers", "lookup");
    for (const launch of f.launcher.launches) {
      assert.equal(launch.workingDirectory, lookupFolder, "every probe runs from the Runner-owned lookup folder");
      assert.equal(launch.runId, "runner-cli-worker-checks");
    }
    assert.deepEqual(readdirSync(lookupFolder), [], "the lookup folder stays empty");
    const launchedArgs = f.launcher.launches.map((launch) => launch.arguments.join(" "));
    assert.ok(launchedArgs.includes("auth status") && launchedArgs.includes("--output-format json -p=/quota"));
    for (const text of f.responses) for (const canary of CANARIES) assert.ok(!text.includes(canary), `${canary} reached the response`);
  } finally {
    await f.close();
  }
});

test("the lookup runs from the Runner-owned folder: a CLI found in that folder is refused", async () => {
  const f = await fixture();
  try {
    const lookupFolder = join(f.state, "cli-workers", "lookup");
    const detection = new CliWorkerDetection({
      stateDirectory: f.state, processes: f.launcher, environment: () => ({}), platform: "win32", isRoot: () => false,
      lookup: async (_name, input) => {
        assert.equal(input.cwd, lookupFolder, "the lookup's folder is the Runner's, never a worktree");
        return { status: "found", path: join(input.cwd, "agy.exe") };
      },
    });
    const check = await detection.check("agy");
    assert.equal(check.status, "unavailable");
    assert.equal(check.code, "executable_refused");
    assert.match(check.reason!, /lookup's own folder/);
    assert.equal(f.launcher.launches.length, 0);
  } finally {
    await f.close();
  }
});

test("free checks are cached for 60 s; Refresh and a changed executable path check again", async () => {
  const f = await fixture({ scenarios: (s) => ({ [CLAUDE]: claudeScenario(s), [AGY]: agyScenario(s), ["C:\\Other\\agy.exe"]: agyScenario(s) }) });
  try {
    await f.call("/v2/cli-workers");
    const first = f.launcher.launches.length;
    assert.ok(first > 0);
    await f.call("/v2/cli-workers");
    assert.equal(f.launcher.launches.length, first, "a second read within 60 s launches nothing");
    f.now.value += 59_000;
    await f.call("/v2/cli-workers");
    assert.equal(f.launcher.launches.length, first);
    f.now.value += 2_000;
    await f.call("/v2/cli-workers");
    const second = f.launcher.launches.length;
    assert.ok(second > first, "after 60 s the checks run again");
    await f.call("/v2/cli-workers?refresh=1");
    const third = f.launcher.launches.length;
    assert.ok(third > second, "Refresh bypasses the cache");
    const snapshot = await readAiboardHome(f.location, { credentials: false });
    await applyHomeBatch(f.location, { baseRevision: snapshot.revision, ops: [{ path: "cliWorkers.agy", op: "merge", value: { executablePath: "C:\\Other\\agy.exe" } }] });
    const { body } = await f.call("/v2/cli-workers");
    assert.deepEqual(worker(body, "agy").executable, { path: "C:\\Other\\agy.exe", source: "home", form: "exe" });
    assert.ok(f.launcher.launches.slice(third).every((launch) => launch.executable === "C:\\Other\\agy.exe"), "only the changed CLI was checked again");
    assert.equal((await f.call("/v2/cli-workers?refresh=yes")).status, 400);
  } finally {
    await f.close();
  }
});

test("not installed, logged out and out of usage are reported with their failure kinds", async () => {
  const f = await fixture({
    found: { claude: undefined },
    // The quota fixture's resets are in 2099: a reset counts only within 31 days of now.
    now: Date.parse("2098-12-31T12:00:00.000Z"),
    scenarios: (s) => ({ [AGY]: agyScenario(s, { quota: "quota-exhausted.synthetic.json" }) }),
  });
  try {
    const { body } = await f.call("/v2/cli-workers");
    const claude = worker(body, "claude-code");
    assert.equal(claude.status, "unavailable");
    assert.equal(claude.code, "not_installed");
    assert.equal(claude.failure?.kind, "authentication");
    // One of agy's two quota groups is spent: the CLI default still has a group left, so agy is ready, and the spent
    // bucket is shown with the reset agy stated. A Test of a model in the spent group is a usage limit (below).
    const agy = worker(body, "agy");
    assert.equal(agy.status, "ready");
    const spent = agy.quota?.flatMap((group) => group.buckets).find((bucket) => bucket.remainingFraction === 0);
    assert.equal(spent?.resetsAt, "2099-01-01T04:53:36.000Z");
    const exhausted = await f.detection.check("agy");
    assert.equal(exhausted.status, "ready");
  } finally {
    await f.close();
  }
  const g = await fixture({ scenarios: (s) => ({ [AGY]: agyScenario(s, { loggedOut: true }), [CLAUDE]: claudeScenario(s, {}, "auth-status.logged-out.json") }) });
  try {
    const { body } = await g.call("/v2/cli-workers");
    for (const providerId of ["agy", "claude-code"] as const) {
      const check = worker(body, providerId);
      assert.equal(check.status, "unavailable", providerId);
      assert.equal(check.code, "not_logged_in");
      assert.equal(check.failure?.kind, "authentication");
    }
    assert.ok(!g.launcher.launches.some((launch) => launch.arguments.includes("-p=/quota")), "a logged-out agy's quota is not read");
  } finally {
    await g.close();
  }
});

test(".cmd CLIs: Claude Code's shim, a host that can't launch .cmd, and unsafe folders are refused without a launch", async () => {
  const claudeCmd = "C:\\npm\\claude.cmd";
  const agyCmd = "C:\\npm\\agy.cmd";
  {
    const f = await fixture({ batch: "verified", found: { claude: claudeCmd, agy: agyCmd } });
    try {
      const { body } = await f.call("/v2/cli-workers");
      const claude = worker(body, "claude-code");
      assert.equal(claude.code, "cmd_shim_schema");
      assert.match(claude.reason!, /npm shim \(claude\.cmd\) can't carry its result schema; install the native claude\.exe/);
      const agy = worker(body, "agy");
      assert.equal(agy.status, "unknown", "a safe .cmd on a verified host is not launched by the Runner-internal kernel");
      assert.equal(agy.code, "cmd_checks_unavailable");
      assert.equal(f.launcher.launches.length, 0);
    } finally {
      await f.close();
    }
  }
  for (const batch of ["unavailable", "partial"] as const) {
    const f = await fixture({ batch, found: { agy: agyCmd } });
    try {
      const agy = worker((await f.call("/v2/cli-workers")).body, "agy");
      assert.equal(agy.status, "unavailable");
      assert.equal(agy.code, "cmd_launch_unavailable");
      assert.match(agy.reason!, /^This PC can't launch \.cmd CLIs/);
      assert.equal(agy.failure?.kind, "authentication");
      assert.ok(!f.launcher.launches.some((launch) => launch.executable === agyCmd), "the .cmd was never launched");
    } finally {
      await f.close();
    }
  }
  for (const character of ["(", ")", "!", "%", "&", "^"]) {
    const base = realpathSync(mkdtempSync(join(tmpdir(), "aiboard-cli-cmd-")));
    const f = await fixture({ found: { agy: agyCmd }, state: join(base, `state ${character} x`) });
    try {
      const agy = worker((await f.call("/v2/cli-workers")).body, "agy");
      assert.equal(agy.code, "cmd_argument_unsafe", `a state folder with ${character}`);
      assert.match(agy.reason!, /has a character a \.cmd argument can't carry/);
      assert.ok(!f.launcher.launches.some((launch) => launch.executable === agyCmd));
    } finally {
      await f.close();
      rmSync(base, { recursive: true, force: true });
    }
  }
  {
    // CW4 passes the project's worktree folder. agy's worktree is only its working folder, never an argument, so it
    // passes; Codex takes it as `-C <worktree>`, so a Codex .cmd whose worktree folder can't be a .cmd argument is
    // refused. Codex is refused on every OS in v1, so its rule is pinned on the exported function.
    const f = await fixture({ found: { agy: agyCmd } });
    try {
      const ampersand = join(f.root, "Tom & Jerry", "worktrees");
      assert.equal((await f.detection.check("agy", { worktreeFolder: ampersand })).code, "cmd_checks_unavailable");
      assert.ok(!f.launcher.launches.some((launch) => launch.executable === agyCmd));
      assert.equal(cliWorkerCmdArgumentRefusal({ providerId: "codex-cli", file: "codex.cmd", stateDirectory: f.state, worktreeFolder: join(f.root, "plain") }), undefined);
      for (const character of ["(", ")", "!", "%", "&", "^"]) {
        assert.match(cliWorkerCmdArgumentRefusal({ providerId: "codex-cli", file: "codex.cmd", stateDirectory: f.state, worktreeFolder: join(f.root, `a ${character} b`) }) ?? "",
          /codex\.cmd can't be launched here: the folder .* has a character/, `a worktree with ${character}`);
        assert.ok(cliWorkerCmdArgumentRefusal({ providerId: "codex-cli", file: "codex.cmd", stateDirectory: join(f.root, `s ${character}`) }), `a state folder with ${character}`);
      }
    } finally {
      await f.close();
    }
  }
});

// ---------------------------------------------------------------------------------------------------------------
// The Test button

test("a passing Claude Code test: restricted mode, prompt on stdin, an empty Runner-owned folder removed after, saved, cooldowns ended", async () => {
  const f = await fixture({ scenarios: (s) => ({ [CLAUDE]: claudeScenario(s, { stdout: cliFixture("claude-code/success.windows.stdout.json") }) }) });
  try {
    const { status, body } = await f.call("/v2/cli-workers/claude-code/test", { method: "POST", body: { model: "sonnet", reasoningEffort: "low" } });
    assert.equal(status, 200, JSON.stringify(body));
    assert.equal((body.lastTest as { outcome: string }).outcome, "passed");
    assert.equal(body.stopVerified, true);
    assert.deepEqual(body.endedCooldownIn, ["run_paused", "run_running"]);
    assert.deepEqual(f.ended, ["claude-code"]);
    const record = f.record("claude-run.json");
    assert.deepEqual(record.argv.slice(0, 4), ["-p", "--output-format", "stream-json", "--verbose"]);
    assert.ok(record.argv.join(" ").includes("--model sonnet --effort low --permission-mode plan --no-session-persistence"));
    assert.ok(!record.argv.some((arg) => /dangerously/.test(arg)), "never a bypass flag");
    assert.match(record.stdin, /connection test from AIBoard/);
    assert.ok(!record.argv.some((arg) => arg.includes("connection test")), "the prompt never goes in argv");
    assert.ok(record.cwd.startsWith(join(f.state, "cli-worker-tests")), "the test runs in a Runner-owned folder");
    assert.deepEqual(testFolders(f), [], "the test folder is removed after a verified stop");
    const saved = await lastTest(f, "claude-code");
    assert.equal(saved?.outcome, "passed");
    assert.equal(saved?.cliVersion, "2.1.326");
    assert.equal(saved?.modelId, "sonnet");
    const launch = f.launcher.launches.find((entry) => entry.runId === "runner-cli-worker-tests");
    assert.ok(launch && launch.workingDirectory.endsWith("work"));
    const home = readFileSync(f.location.configPath, "utf8");
    for (const canary of CANARIES) {
      assert.ok(!home.includes(canary), `${canary} reached the home`);
      for (const text of f.responses) assert.ok(!text.includes(canary), `${canary} reached a response`);
    }
  } finally {
    await f.close();
  }
});

test("a passing agy test runs in plan mode with its schema file beside the empty folder", async () => {
  const f = await fixture({ scenarios: (s) => ({ [AGY]: agyScenario(s, { run: { stdout: cliFixture("agy/success.windows.stdout.jsonl") } }) }) });
  try {
    const { status, body } = await f.call("/v2/cli-workers/agy/test", { method: "POST", body: { model: null } });
    assert.equal(status, 200, JSON.stringify(body));
    assert.equal((body.lastTest as { outcome: string }).outcome, "passed");
    const record = f.record("agy-run.json");
    assert.ok(record.argv.join(" ").includes("--mode plan --print-timeout 0"));
    assert.equal(record.argv.at(-1), "-p=");
    assert.ok(!record.argv.some((arg) => /dangerously/.test(arg)));
    const schema = record.argv[record.argv.indexOf("--json-schema") + 1]!;
    assert.ok(schema.endsWith("result.schema.json"));
    assert.equal(dirname(schema), dirname(record.cwd), "the schema sits beside the empty folder, not in it");
    assert.deepEqual(JSON.parse(record.stdin.trim()).event, "user");
    assert.deepEqual(testFolders(f), []);
  } finally {
    await f.close();
  }
});

test("Codex's Test form is its most restricted one, never with a bypass flag", () => {
  const args = buildCliWorkerArgs({ providerId: "codex-cli", mode: "test", model: null, schemaPath: "C:\\s\\result.schema.json", outputPath: "C:\\s\\result.json", worktree: "C:\\s\\work" });
  assert.ok(args.join(" ").includes("-s read-only --skip-git-repo-check --ephemeral"));
  assert.ok(!args.some((arg) => /dangerously/.test(arg)));
});

test("each lastTest outcome is reached with a fake CLI", async () => {
  const unreadable = join(tmpdir(), `aiboard-cli-unreadable-${process.pid}.jsonl`);
  writeFileSync(unreadable, `${JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "not the schema", session_id: "00000000-0000-4000-8000-000000000001" })}\n`);
  const cases: Array<{ outcome: string; providerId?: CliWorkerProviderId; options: FixtureOptions; body?: Record<string, unknown>; launched: boolean; resetsAt?: boolean }> = [
    { outcome: "not_installed", options: { found: { claude: undefined } }, launched: false },
    { outcome: "not_logged_in", options: { scenarios: (s) => ({ [CLAUDE]: claudeScenario(s, {}, "auth-status.logged-out.json") }) }, launched: false },
    { outcome: "not_logged_in", options: { scenarios: (s) => ({ [CLAUDE]: claudeScenario(s, { stdout: cliFixture("claude-code/free/logged-out-streamjson.linux.stdout.jsonl"), exitCode: 1 }) }) }, launched: true },
    { outcome: "usage_limit", options: { now: Date.parse("2099-12-31T12:00:00.000Z"), scenarios: (s) => ({ [CLAUDE]: claudeScenario(s, { stdout: cliFixture("claude-code/usage-limit.synthetic.stdout.jsonl"), exitCode: 1 }) }) }, launched: true, resetsAt: true },
    { outcome: "usage_limit", providerId: "agy", options: { now: Date.parse("2098-12-31T12:00:00.000Z"), scenarios: (s) => ({ [AGY]: agyScenario(s, { quota: "quota-exhausted.synthetic.json" }) }) }, body: { model: "claude-opus-5-5-low" }, launched: false, resetsAt: true },
    { outcome: "model_unavailable", options: { scenarios: (s) => ({ [CLAUDE]: claudeScenario(s, { stdout: cliFixture("claude-code/model-unavailable.windows.stdout.json"), exitCode: 1 }) }) }, body: { model: "cw0-no-such-model" }, launched: true },
    { outcome: "timed_out", options: { testTimeoutMs: 400, scenarios: (s) => ({ [CLAUDE]: claudeScenario(s, { holdMs: 30_000 }) }) }, launched: true },
    { outcome: "unreadable_result", options: { scenarios: (s) => ({ [CLAUDE]: claudeScenario(s, { stdout: unreadable }) }) }, launched: true },
  ];
  try {
    for (const entry of cases) {
      const f = await fixture(entry.options);
      const providerId = entry.providerId ?? "claude-code";
      try {
        const { status, body } = await f.call(`/v2/cli-workers/${providerId}/test`, { method: "POST", body: entry.body ?? { model: null } });
        assert.equal(status, 200, `${entry.outcome}: ${JSON.stringify(body)}`);
        const result = body.lastTest as { outcome: string; resetsAt?: string; message?: string };
        assert.equal(result.outcome, entry.outcome, JSON.stringify(body));
        assert.equal(body.launched, entry.launched, `${entry.outcome} launched`);
        assert.equal(Boolean(result.resetsAt), Boolean(entry.resetsAt), `${entry.outcome} resetsAt`);
        assert.equal((await lastTest(f, providerId))?.outcome, entry.outcome, "saved to the home");
        assert.deepEqual(f.ended, [], "only a passing test ends a cooldown");
        assert.deepEqual(testFolders(f), [], "removed after a verified stop");
      } finally {
        await f.close();
      }
    }
  } finally {
    rmSync(unreadable, { force: true });
  }
});

test("an unverified stop reports timed_out and keeps the test folder", async () => {
  const f = await fixture({ scenarios: (s) => ({ [CLAUDE]: claudeScenario(s, { stdout: cliFixture("claude-code/success.windows.stdout.json") }) }) });
  try {
    await f.call("/v2/cli-workers");
    f.launcher.failStop = true;
    const { status, body } = await f.call("/v2/cli-workers/claude-code/test", { method: "POST", body: { model: null } });
    assert.equal(status, 200);
    assert.equal((body.lastTest as { outcome: string }).outcome, "timed_out");
    assert.match((body.lastTest as { message: string }).message, /could not be proven stopped/);
    assert.equal(body.stopVerified, false);
    assert.equal(testFolders(f).length, 1, "the folder is kept for cleanup");
    assert.deepEqual(f.ended, []);
  } finally {
    await f.close();
  }
});

test("a refused CLI is not tested: 409 with its reason, nothing launched or saved; bodies are checked", async () => {
  const f = await fixture({ platform: "linux" });
  try {
    const { status, body } = await f.call("/v2/cli-workers/claude-code/test", { method: "POST", body: { model: null } });
    assert.equal(status, 409);
    assert.equal(body.code, "platform_refused");
    assert.match(body.error as string, /not available on Linux/);
    assert.equal(f.launcher.launches.length, 0);
    assert.equal(await lastTest(f, "claude-code"), undefined);
    assert.equal((await f.call("/v2/cli-workers/codex-cli/test", { method: "POST", body: { model: "gpt 5" } })).status, 400);
    assert.equal((await f.call("/v2/cli-workers/codex-cli/test", { method: "POST", body: { model: null, extra: 1 } })).status, 400);
    assert.equal((await f.call("/v2/cli-workers/gemini-cli/test", { method: "POST", body: { model: null } })).status, 404);
    assert.equal((await f.call("/v2/cli-workers/codex-cli/test", { method: "GET" })).status, 404);
  } finally {
    await f.close();
  }
  const g = await fixture({ found: { claude: "C:\\npm\\claude.cmd" } });
  try {
    const { status, body } = await g.call("/v2/cli-workers/claude-code/test", { method: "POST", body: { model: null } });
    assert.equal(status, 409);
    assert.equal(body.code, "cmd_shim_schema");
    assert.equal(g.launcher.launches.length, 0);
  } finally {
    await g.close();
  }
});

test("a passing API key test saved to the home ends that provider's cooldowns (CWD-4)", async () => {
  const f = await fixture();
  try {
    const save = async (value: Record<string, unknown>) => {
      const snapshot = await readAiboardHome(f.location, { credentials: false });
      return await f.call("/v2/home", { method: "POST", body: { baseRevision: snapshot.revision, ops: [{ path: "providers.anthropic", op: "merge", value }] } });
    };
    assert.equal((await save({ lastValidationSucceeded: false, lastValidatedAt: "2026-11-18T00:00:00.000Z" })).status, 200);
    assert.equal((await save({ lastValidationSucceeded: null })).status, 200);
    assert.deepEqual(f.ended, [], "a failed or cleared test ends nothing");
    assert.equal((await save({ lastValidationSucceeded: true, lastValidatedAt: "2026-11-18T00:00:01.000Z" })).status, 200);
    assert.deepEqual(f.ended, ["anthropic"]);
  } finally {
    await f.close();
  }
});

test("with the Runner-internal process kernel, a passing test's folder is removed after its verified stop", async () => {
  let kernel: RunnerInternalProcessKernel | undefined;
  const f = await fixture({
    launcher: (root) => {
      kernel = createRunnerInternalProcessKernel({ stateDirectory: join(root, "kernel"), windowsBirthHelperDirectory: join(root, "windows-birth-helper") });
      return kernel;
    },
    command: (_path, args) => ({ executable: process.execPath, arguments: [FAKE_CLI_SCRIPT, ...args] }),
  });
  try {
    const scenario = claudeScenario({ scenario: f.scenario, root: f.root }, { stdout: cliFixture("claude-code/success.windows.stdout.json") });
    process.env[FAKE_CLI_SCENARIO_ENV] = scenario;
    const { status, body } = await f.call("/v2/cli-workers/claude-code/test", { method: "POST", body: { model: null } });
    assert.equal(status, 200, JSON.stringify(body));
    assert.equal((body.lastTest as { outcome: string }).outcome, "passed", JSON.stringify(body));
    assert.equal(body.stopVerified, true);
    assert.deepEqual(testFolders(f), []);
    assert.ok(f.record("claude-run.json").cwd.startsWith(join(f.state, "cli-worker-tests")));
  } finally {
    delete process.env[FAKE_CLI_SCENARIO_ENV];
    await kernel?.close();
    await f.close();
  }
});
