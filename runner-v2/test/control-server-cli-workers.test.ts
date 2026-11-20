// CLI workers CW3 (docs/plans/2026-11-14-cli-workers.md §3.2, §3.4): the free checks (`GET /v2/cli-workers`) and the
// Test button (`POST /v2/cli-workers/<providerId>/test`). Fake CLIs only (test/support/fake-cli.mjs): no test starts a
// real CLI or sends a prompt. The OS is a seam, so the Windows-only v1 path runs on every CI host. The process host is
// a double here (real child processes, a stop proven by their exit or reported unproven on demand); the execution-host
// path itself is cli-worker-processes.test.ts.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { resolveAiboardHome, type AiboardHomeLocation } from "../src/aiboard-home-paths.js";
import { applyHomeBatch, readAiboardHome } from "../src/aiboard-home-store.js";
import type { CheckToolLookup } from "../src/check-tool-lookup.js";
import { buildCliWorkerArgs } from "../src/cli-worker-adapters.js";
import type { CliWorkerProviderId } from "../src/cli-worker-config.js";
import { CliWorkerDetection, cliWorkerCmdArgumentRefusal, cliWorkerFreeCheckEntry, type CliWorkerCheck } from "../src/cli-worker-detection.js";
import { ControlServer } from "../src/control-server.js";
import type { ProcessHostSemanticFact } from "../src/process-host-semantic-probes.js";
import { RunSupervisor } from "../src/run-supervisor.js";
import { SqliteEventStore } from "../src/sqlite-event-store.js";
import { cliFixture, writeFakeCliScenario, type FakeCliRecord, type FakeCliScenario } from "./support/fake-cli.js";
import { fakeProcesses, type FakeProcesses } from "./support/fake-cli-processes.js";

const token = "test-control-token";
const CLAUDE = "C:\\Tools\\claude.exe";
const AGY = "C:\\Tools\\agy.exe";
const CODEX = "C:\\Tools\\codex.exe";
const CANARIES = ["canary@example.test", "Canary Org", "00000000-0000-4000-8000-000000000000", "loginExpiresAt", "2099-01-01T00:00:00.000Z", "credential_expires_at"];

// ---------------------------------------------------------------------------------------------------------------

interface Fixture {
  root: string;
  state: string;
  location: AiboardHomeLocation;
  processes: FakeProcesses;
  detection: CliWorkerDetection;
  now: { value: number };
  ended: string[];
  responses: string[];
  call(path: string, init?: { method?: string; body?: unknown }): Promise<{ status: number; body: Record<string, unknown> }>;
  scenario(name: string, scenario: FakeCliScenario): string;
  record(name: string): FakeCliRecord;
  /** The control server's close alone, as the Runner's shutdown closes it after the CLI worker service. */
  closeServer(): Promise<void>;
  close(): Promise<void>;
}

interface FixtureOptions {
  platform?: NodeJS.Platform;
  isRoot?: boolean;
  /** The host's batch-argv fact; "absent" is no fact at all (the detection gets undefined). Default "verified". */
  batch?: ProcessHostSemanticFact | "absent";
  /** The host's Job containment fact, the same way. Default "verified". */
  jobContainment?: ProcessHostSemanticFact | "absent";
  state?: string;
  found?: Partial<Record<string, string>>;
  absent?: string[];
  testTimeoutMs?: number;
  now?: number;
  scenarios?: (f: { scenario: Fixture["scenario"]; root: string }) => Record<string, string>;
  /** The Build manager's providerTestPassed; the default records the provider and names two Builds. */
  providerTestPassed?: (providerId: string) => Promise<string[]>;
  /** false: a Runner without the CLI worker service. */
  service?: false;
  nestedState?: boolean;
}

async function fixture(options: FixtureOptions = {}): Promise<Fixture> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "aiboard-cli-workers-")));
  let supervisor: RunSupervisor | undefined;
  let server: ControlServer | undefined;
  try {
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
    const processes = fakeProcesses(scenarios);
    // Codex is found only where a test gives it a scenario (`found: { codex: CODEX }`): on Windows it is checked like
    // the others (§3.11c), and a found CLI with no scenario cannot answer its probes.
    const found: Record<string, string> = { claude: CLAUDE, agy: AGY, ...options.found };
    const lookup: CheckToolLookup = async (name) => (found[name] ? { status: "found", path: found[name]! } : { status: "missing" });
    const now = { value: options.now ?? Date.parse("2026-11-18T00:00:00.000Z") };
    const batch = options.batch ?? "verified";
    const job = options.jobContainment ?? "verified";
    const detection = new CliWorkerDetection({
      stateDirectory: state,
      processes,
      lookup,
      home: location,
      windowsBatchArgv: async () => (batch === "absent" ? undefined : batch),
      windowsJobContainment: async () => (job === "absent" ? undefined : job),
      platform: options.platform ?? "win32",
      isRoot: () => options.isRoot ?? false,
      now: () => now.value,
      inspect: async (path) => (options.absent?.includes(path) ? "absent" : "file"),
      ...(options.testTimeoutMs ? { testTimeoutMs: options.testTimeoutMs } : {}),
    });
    const ended: string[] = [];
    supervisor = new RunSupervisor(new SqliteEventStore(join(root, "events.sqlite")));
    server = new ControlServer({
      supervisor,
      token,
      bootstrapRun: async () => ({ baselineRevision: "a".repeat(40), baselineRef: "refs/x" }),
      runnerInfo: { projectPath: root, nodeVersion: process.versions.node },
      home: location,
      ...(options.service === false ? {} : { cliWorkers: detection }),
      ...(options.nestedState ? { localAgentsUnavailableNestedState: true } : {}),
      builds: { providerTestPassed: options.providerTestPassed ?? (async (providerId: string) => { ended.push(providerId); return ["run_paused", "run_running"]; }) } as never,
    });
    const { url } = await server.start(0);
    const responses: string[] = [];
    const started = { server, supervisor };
    let serverClosed = false;
    return {
      root, state, location, processes, detection, now, ended, responses,
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
      async closeServer() {
        if (serverClosed) return;
        serverClosed = true;
        await started.server.close();
      },
      async close() {
        try {
          if (!serverClosed) await started.server.close();
          serverClosed = true;
          started.supervisor.close();
        } finally {
          rmSync(root, { recursive: true, force: true });
        }
      },
    };
  } catch (error) {
    // A setup that failed half-way leaves no temp folder behind.
    try { await server?.close(); } catch { /* it never started */ }
    try { supervisor?.close(); } catch { /* already closed */ }
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

function version(root: string, text: string): string {
  const path = join(root, `version-${text.replace(/\W+/g, "-")}.txt`);
  writeFileSync(path, `${text}\n`);
  return path;
}

/** Codex answering its free checks (CW0's recordings): version, logged in with ChatGPT, its model catalog. */
function codexScenario(f: { scenario: Fixture["scenario"]; root: string }): string {
  return f.scenario("codex", {
    cli: "codex-cli",
    responses: [
      { args: ["--version"], stdout: version(f.root, "codex-cli 0.169.0") },
      { args: ["login", "status"], stderr: cliFixture("codex-cli/free/login-status.logged-in.txt") },
      { args: ["debug", "models"], stdout: cliFixture("codex-cli/free/debug-models.json") },
    ],
    record: "codex-run.json",
  });
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

function agyScenario(f: { scenario: Fixture["scenario"]; root: string }, options: { quota?: string; loggedOut?: boolean; run?: Partial<FakeCliScenario>; name?: string } = {}): string {
  return f.scenario(options.name ?? "agy", {
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

/** No account field reached a response this fixture served, or the home. */
function assertNoCanary(f: Fixture, label: string): void {
  const home = existsSync(f.location.configPath) ? readFileSync(f.location.configPath, "utf8") : "";
  for (const canary of CANARIES) {
    assert.ok(!home.includes(canary), `${label}: ${canary} reached the home`);
    for (const text of f.responses) assert.ok(!text.includes(canary), `${label}: ${canary} reached a response`);
  }
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
      assert.equal(f.processes.opens.length, 0);
    } finally {
      await f.close();
    }
  }
});

test("on Windows Claude Code under root is refused without a launch", async () => {
  const f = await fixture({ isRoot: true, scenarios: (s) => ({ [AGY]: agyScenario(s) }) });
  try {
    const { body } = await f.call("/v2/cli-workers");
    const claude = worker(body, "claude-code");
    assert.equal(claude.status, "refused");
    assert.equal(claude.code, "root_refused");
    assert.match(claude.reason!, /can't run as a worker when AIBoard runs as root/);
    assert.equal(worker(body, "agy").status, "ready", "the root rule is Claude Code's alone");
    assert.ok(f.processes.launches.every((launch) => launch.executable === AGY), "only agy was launched");
  } finally {
    await f.close();
  }
});

test("§3.11c: on Windows Codex is checked like the other CLIs (version, login, its own model list), with no OS refusal", async () => {
  const f = await fixture({ found: { codex: CODEX }, scenarios: (s) => ({ [CODEX]: codexScenario(s), [CLAUDE]: claudeScenario(s), [AGY]: agyScenario(s) }) });
  try {
    const { body } = await f.call("/v2/cli-workers");
    const codex = worker(body, "codex-cli");
    assert.equal(codex.status, "ready", JSON.stringify(codex));
    assert.equal(codex.version, "0.169.0");
    assert.equal(codex.login?.status, "logged_in");
    assert.deepEqual(codex.executable, { path: CODEX, source: "path", form: "exe" });
    assert.equal(codex.models?.[0]?.id, null, "CLI default first");
    assert.ok((codex.models?.length ?? 0) > 1, "Codex's own catalog is listed");
    const codexArgs = f.processes.launches.filter((launch) => launch.executable === CODEX).map((launch) => launch.args.join(" "));
    assert.deepEqual([...codexArgs].sort(), ["--version", "debug models", "login status"]);
    assertNoCanary(f, "codex ready");
  } finally {
    await f.close();
  }
});

test("§3.11c: a packaged (Microsoft Store) Codex is refused with its reason, without a launch", async () => {
  for (const path of [
    "C:\\Users\\someone\\AppData\\Local\\Microsoft\\WindowsApps\\codex.exe",
    "C:\\Users\\someone\\AppData\\Local\\Microsoft\\WindowsApps\\OpenAI.Codex_2p2nqsd0c76g0\\codex.exe",
    "C:\\Program Files\\WindowsApps\\OpenAI.Codex_26.1.0.0_x64__2p2nqsd0c76g0\\app\\resources\\codex.exe",
  ]) {
    const f = await fixture({ found: { codex: path }, scenarios: (s) => ({ [path]: codexScenario(s) }) });
    try {
      const codex = worker((await f.call("/v2/cli-workers")).body, "codex-cli");
      assert.equal(codex.status, "unavailable", path);
      assert.equal(codex.code, "executable_refused", path);
      assert.match(codex.reason!, /packaged \(Microsoft Store\) program/);
      assert.ok(!f.processes.launches.some((launch) => launch.executable === path), "the packaged Codex was never launched");
    } finally {
      await f.close();
    }
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
    assert.equal(f.processes.opens.length, 2, "one process session per CLI");
    for (const launch of f.processes.launches) {
      assert.equal(launch.workingDirectory, lookupFolder, "every probe runs from the Runner-owned lookup folder");
      assert.equal(launch.purpose, "check");
    }
    assert.deepEqual(f.processes.closes, [{ purpose: "check", verified: true }, { purpose: "check", verified: true }]);
    assert.deepEqual(readdirSync(lookupFolder), [], "the lookup folder stays empty");
    const launchedArgs = f.processes.launches.map((launch) => launch.args.join(" "));
    assert.ok(launchedArgs.includes("auth status") && launchedArgs.includes("--output-format json -p=/quota"));
    assert.equal(launchedArgs.filter((args) => args === "--version").length, 2, "agy's models list and version are not probed twice");
    assertNoCanary(f, "ready");
  } finally {
    await f.close();
  }
});

test("the lookup runs from the Runner-owned folder: a CLI found in that folder is refused", async () => {
  const f = await fixture();
  try {
    const lookupFolder = join(f.state, "cli-workers", "lookup");
    const detection = new CliWorkerDetection({
      stateDirectory: f.state, processes: f.processes, platform: "win32", isRoot: () => false,
      lookup: async (_name, input) => {
        assert.equal(input.cwd, lookupFolder, "the lookup's folder is the Runner's, never a worktree");
        return { status: "found", path: join(input.cwd, "agy.exe") };
      },
    });
    const check = await detection.check("agy");
    assert.equal(check.status, "unavailable");
    assert.equal(check.code, "executable_refused");
    assert.match(check.reason!, /lookup's own folder/);
    assert.equal(f.processes.opens.length, 0);
  } finally {
    await f.close();
  }
});

test("free checks are cached for 60 s; Refresh and a changed executable path check again; a running check is joined", async () => {
  const f = await fixture({ scenarios: (s) => ({ [CLAUDE]: claudeScenario(s), [AGY]: agyScenario(s), ["C:\\Other\\agy.exe"]: agyScenario(s, { name: "other-agy" }) }) });
  try {
    await f.call("/v2/cli-workers");
    const first = f.processes.launches.length;
    assert.ok(first > 0);
    await f.call("/v2/cli-workers");
    assert.equal(f.processes.launches.length, first, "a second read within 60 s launches nothing");
    f.now.value += 59_000;
    await f.call("/v2/cli-workers");
    assert.equal(f.processes.launches.length, first);
    f.now.value += 2_000;
    await f.call("/v2/cli-workers");
    const second = f.processes.launches.length;
    assert.ok(second > first, "after 60 s the checks run again");
    await f.call("/v2/cli-workers?refresh=1");
    const third = f.processes.launches.length;
    assert.ok(third > second, "Refresh bypasses the cache");
    // Two Refresh clicks while the first is still checking: one set of probes, both answered.
    const opened = f.processes.opens.length;
    const [one, two] = await Promise.all([f.call("/v2/cli-workers?refresh=1"), f.call("/v2/cli-workers?refresh=1")]);
    assert.equal(one.status, 200);
    assert.deepEqual(one.body.workers, two.body.workers);
    assert.equal(f.processes.opens.length - opened, 2, "a Refresh joins the check already running (one session per CLI)");
    const joined = f.processes.launches.length;
    const snapshot = await readAiboardHome(f.location, { credentials: false });
    await applyHomeBatch(f.location, { baseRevision: snapshot.revision, ops: [{ path: "cliWorkers.agy", op: "merge", value: { executablePath: "C:\\Other\\agy.exe" } }] });
    const { body } = await f.call("/v2/cli-workers");
    assert.deepEqual(worker(body, "agy").executable, { path: "C:\\Other\\agy.exe", source: "home", form: "exe" });
    assert.ok(f.processes.launches.slice(joined).every((launch) => launch.executable === "C:\\Other\\agy.exe"), "only the changed CLI was checked again");
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
    assert.ok(!g.processes.launches.some((launch) => launch.args.includes("-p=/quota")), "a logged-out agy's quota is not read");
  } finally {
    await g.close();
  }
});

test("a version or a quota that does not parse leaves the field out and the CLI ready", async () => {
  const garbage = (root: string) => { const path = join(root, "garbage.txt"); writeFileSync(path, "not a version\n"); return path; };
  const f = await fixture({
    scenarios: (s) => ({
      [AGY]: s.scenario("agy", {
        cli: "agy",
        responses: [
          { args: ["--version"], stdout: garbage(s.root) },
          { args: ["models"], stdout: cliFixture("agy/free/models.txt") },
          { args: ["--output-format", "json", "-p=/quota"], stdout: garbage(s.root) },
        ],
      }),
    }),
  });
  try {
    const agy = worker((await f.call("/v2/cli-workers")).body, "agy");
    assert.equal(agy.status, "ready", JSON.stringify(agy));
    assert.equal(agy.version, undefined);
    assert.equal(agy.quota, undefined);
  } finally {
    await f.close();
  }
});

test("a probe whose read fails or whose stop is not proven gives unknown, its session still closed, and a Test then answers 409", async () => {
  for (const fault of ["read", "stop"] as const) {
    const f = await fixture({ scenarios: (s) => ({ [CLAUDE]: claudeScenario(s), [AGY]: agyScenario(s) }) });
    try {
      f.processes.fail[fault] = "check";
      const { body } = await f.call("/v2/cli-workers");
      const claude = worker(body, "claude-code");
      assert.equal(claude.status, "unknown", `${fault}: ${JSON.stringify(claude)}`);
      assert.equal(claude.code, "probe_failed");
      assert.match(claude.reason!, fault === "stop" ? /could not be proven stopped/ : /checks could not run/);
      assert.equal(claude.login, undefined, "nothing a probe printed is used");
      assert.equal(f.processes.closes.length, f.processes.opens.length, `${fault}: every session's stop was tried`);
      const tested = await f.call("/v2/cli-workers/claude-code/test", { method: "POST", body: { model: null } });
      assert.equal(tested.status, 409, JSON.stringify(tested.body));
      assert.equal(tested.body.code, "probe_failed");
      assert.equal(f.processes.launched("test").length, 0, "nothing was launched for the Test");
      assert.equal(await lastTest(f, "claude-code"), undefined);
    } finally {
      await f.close();
    }
  }
});

test(".cmd CLIs: Claude Code's shim, a host that can't launch .cmd, and unsafe folders are refused without a launch", async () => {
  const claudeCmd = "C:\\npm\\claude.cmd";
  const agyCmd = "C:\\npm\\agy.cmd";
  {
    // On a host whose batch fact is verified a safe agy.cmd runs under the Job like an .exe.
    const f = await fixture({ batch: "verified", found: { claude: claudeCmd, agy: agyCmd }, scenarios: (s) => ({ [agyCmd]: agyScenario(s) }) });
    try {
      const { body } = await f.call("/v2/cli-workers");
      const claude = worker(body, "claude-code");
      assert.equal(claude.code, "cmd_shim_schema");
      assert.match(claude.reason!, /npm shim \(claude\.cmd\) can't carry its result schema; install the native claude\.exe/);
      assert.ok(!f.processes.launches.some((launch) => launch.executable === claudeCmd));
      const agy = worker(body, "agy");
      assert.equal(agy.status, "ready", JSON.stringify(agy));
      assert.deepEqual(agy.executable, { path: agyCmd, source: "path", form: "cmd" });
      assert.ok(f.processes.launched("check").some((launch) => launch.executable === agyCmd));
    } finally {
      await f.close();
    }
  }
  for (const batch of ["unavailable", "partial", "absent"] as const) {
    const f = await fixture({ batch, found: { agy: agyCmd } });
    try {
      const agy = worker((await f.call("/v2/cli-workers")).body, "agy");
      assert.equal(agy.status, "unavailable", batch);
      assert.equal(agy.code, "cmd_launch_unavailable");
      assert.match(agy.reason!, /^This PC can't launch \.cmd CLIs/);
      assert.equal(agy.failure?.kind, "authentication");
      const tested = await f.call("/v2/cli-workers/agy/test", { method: "POST", body: { model: null } });
      assert.equal(tested.status, 409, `${batch}: ${JSON.stringify(tested.body)}`);
      assert.equal(tested.body.code, "cmd_launch_unavailable");
      assert.match(tested.body.error as string, /^This PC can't launch \.cmd CLIs/);
      assert.ok(!f.processes.launches.some((launch) => launch.executable === agyCmd), `${batch}: the .cmd was never launched`);
      assert.equal(f.processes.launched("test").length, 0);
    } finally {
      await f.close();
    }
  }
  for (const character of ["(", ")", "!", "%", "&", "^"]) {
    const base = realpathSync(mkdtempSync(join(tmpdir(), "aiboard-cli-cmd-")));
    try {
      const f = await fixture({ found: { agy: agyCmd }, state: join(base, `state ${character} x`) });
      try {
        const agy = worker((await f.call("/v2/cli-workers")).body, "agy");
        assert.equal(agy.code, "cmd_argument_unsafe", `a state folder with ${character}`);
        assert.match(agy.reason!, /has a character a \.cmd argument can't carry/);
        assert.ok(!f.processes.launches.some((launch) => launch.executable === agyCmd));
      } finally {
        await f.close();
      }
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  }
  {
    // CW4 passes the project's worktree folder. agy's worktree is only its working folder, never an argument, so it
    // passes; Codex takes it as `-C <worktree>`, so a Codex .cmd whose worktree folder can't be a .cmd argument is
    // refused. Codex is refused on every OS in v1, so its rule is pinned on the exported function.
    const f = await fixture({ found: { agy: agyCmd }, scenarios: (s) => ({ [agyCmd]: agyScenario(s) }) });
    try {
      const ampersand = join(f.root, "Tom & Jerry", "worktrees");
      assert.equal((await f.detection.check("agy", { worktreeFolder: ampersand })).status, "ready");
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

test("on Windows a CLI runs only under a verified Job: otherwise it is unavailable with its reason, nothing launches, and a Test answers 409", async () => {
  for (const jobContainment of ["unavailable", "partial", "absent"] as const) {
    const f = await fixture({ jobContainment, scenarios: (s) => ({ [CLAUDE]: claudeScenario(s), [AGY]: agyScenario(s) }) });
    try {
      const { body } = await f.call("/v2/cli-workers");
      for (const providerId of ["claude-code", "agy"] as const) {
        const check = worker(body, providerId);
        assert.equal(check.status, "unavailable", `${jobContainment} ${providerId}`);
        assert.equal(check.code, "job_containment_unavailable");
        assert.match(check.reason!, /can't run .* as a worker: Windows did not pass AIBoard's check that a Job object holds a CLI/);
        assert.equal(check.failure?.kind, "provider_unavailable", "a host fact: unhealthy, but never a 24 h login cooldown");
      }
      const tested = await f.call("/v2/cli-workers/claude-code/test", { method: "POST", body: { model: null } });
      assert.equal(tested.status, 409, JSON.stringify(tested.body));
      assert.equal(tested.body.code, "job_containment_unavailable");
      assert.equal(f.processes.opens.length, 0, `${jobContainment}: nothing was launched`);
      assert.equal(await lastTest(f, "claude-code"), undefined);
    } finally {
      await f.close();
    }
  }
  // The rule is Windows': a POSIX host has no Job fact, and its CLIs are refused for the OS anyway (v1).
  const g = await fixture({ platform: "linux", jobContainment: "absent" });
  try {
    assert.equal(worker((await g.call("/v2/cli-workers")).body, "claude-code").code, "platform_refused");
  } finally {
    await g.close();
  }
});

test("CW4's seam: each check maps to a CliWorkerFreeCheck, and freeChecks never rejects", async () => {
  const base = { displayName: "agy", checkedAt: "2026-11-18T00:00:00.000Z" };
  const executable = { path: AGY, source: "path" as const, form: "exe" as const };
  assert.deepEqual(cliWorkerFreeCheckEntry({ ...base, providerId: "agy", status: "ready", executable, version: "1.5.10" }),
    { providerId: "agy", status: "ready", executable: { path: AGY, form: "exe" }, version: "1.5.10" });
  assert.deepEqual(cliWorkerFreeCheckEntry({ ...base, providerId: "agy", status: "refused", code: "platform_refused", reason: "agy is not available on Linux." }),
    { providerId: "agy", status: "unhealthy", failure: { kind: "authentication", message: "agy is not available on Linux." } });
  const quota = { kind: "usage_limit" as const, message: "agy is out of usage.", retryAfterMs: 1_000 };
  assert.deepEqual(cliWorkerFreeCheckEntry({ ...base, providerId: "agy", status: "unavailable", code: "usage_limit", reason: quota.message, failure: quota, executable }),
    { providerId: "agy", status: "unhealthy", executable: { path: AGY, form: "exe" }, failure: quota });
  assert.deepEqual(cliWorkerFreeCheckEntry({ ...base, providerId: "agy", status: "unknown", code: "login_unknown", reason: "AIBoard could not tell whether agy is logged in." }),
    { providerId: "agy", status: "unknown", note: "AIBoard could not tell whether agy is logged in." });

  const f = await fixture({ scenarios: (s) => ({ [CLAUDE]: claudeScenario(s), [AGY]: agyScenario(s, { loggedOut: true }) }) });
  try {
    const checks = await f.detection.freeChecks({ providerIds: ["claude-code", "agy", "codex-cli"] });
    assert.deepEqual(checks.map((entry) => [entry.providerId, entry.status, entry.failure?.kind]), [
      ["claude-code", "ready", undefined], ["agy", "unhealthy", "authentication"], ["codex-cli", "unhealthy", "authentication"],
    ]);
    assert.match(checks[1]!.failure!.message, /not logged in/);
    const aborted = new AbortController();
    aborted.abort();
    assert.deepEqual(await f.detection.freeChecks({ providerIds: ["agy"], signal: aborted.signal }), [{ providerId: "agy", status: "unknown", note: "The check was cancelled." }]);
    f.processes.fail.open = "check";
    const failed = await f.detection.freeChecks({ providerIds: ["claude-code"] });
    assert.equal(failed[0]!.status, "unknown", "a check that could not run is a result, never a rejection");
  } finally {
    await f.close();
  }
});

test("the routes: the health capability, a Runner without the service, and a nested state folder", async () => {
  const f = await fixture();
  try {
    const health = await f.call("/v2/health");
    assert.equal((health.body.capabilities as Record<string, unknown>).cliWorkerChecks, true);
  } finally {
    await f.close();
  }
  const g = await fixture({ service: false });
  try {
    for (const [path, method] of [["/v2/cli-workers", "GET"], ["/v2/cli-workers/agy/test", "POST"]] as const) {
      const { status, body } = await g.call(path, { method, ...(method === "POST" ? { body: { model: null } } : {}) });
      assert.equal(status, 404, path);
      assert.equal(body.code, "cli_workers_unavailable");
    }
    assert.equal(((await g.call("/v2/health")).body.capabilities as Record<string, unknown>).cliWorkerChecks, false);
  } finally {
    await g.close();
  }
  const h = await fixture({ nestedState: true, scenarios: (s) => ({ [AGY]: agyScenario(s) }) });
  try {
    for (const [path, method] of [["/v2/cli-workers", "GET"], ["/v2/cli-workers/agy/test", "POST"]] as const) {
      const { status, body } = await h.call(path, { method, ...(method === "POST" ? { body: { model: null } } : {}) });
      assert.equal(status, 409, path);
      assert.equal(body.code, "local_agents_unavailable_nested_state");
    }
    assert.equal(h.processes.opens.length, 0);
  } finally {
    await h.close();
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
    assert.equal(body.launched, true);
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
    const [launch] = f.processes.launched("test");
    assert.ok(launch && launch.workingDirectory.endsWith("work"));
    assert.deepEqual(f.processes.closes.at(-1), { purpose: "test", verified: true });
    assertNoCanary(f, "passed");
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

test("each lastTest outcome is reached with a fake CLI, with no account field in any answer or the home", async () => {
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
      const label = `${providerId} ${entry.outcome}`;
      try {
        const { status, body } = await f.call(`/v2/cli-workers/${providerId}/test`, { method: "POST", body: entry.body ?? { model: null } });
        assert.equal(status, 200, `${label}: ${JSON.stringify(body)}`);
        const result = body.lastTest as { outcome: string; resetsAt?: string; message?: string };
        assert.equal(result.outcome, entry.outcome, JSON.stringify(body));
        assert.equal(f.processes.launched("test").length, entry.launched ? 1 : 0, `${label}: launched (the process host's record)`);
        assert.equal(body.launched, entry.launched, `${label}: the answer's launched`);
        assert.equal(Boolean(result.resetsAt), Boolean(entry.resetsAt), `${label} resetsAt`);
        assert.equal((await lastTest(f, providerId))?.outcome, entry.outcome, "saved to the home");
        assert.deepEqual(f.ended, [], "only a passing test ends a cooldown");
        assert.deepEqual(testFolders(f), [], "removed after a verified stop");
        assertNoCanary(f, label);
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
    f.processes.fail.stop = "test";
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

test("a start that throws the process host's aggregate: the folder is kept unless the session's stop is then proven, and then the Test is saved", async () => {
  {
    const f = await fixture({ scenarios: (s) => ({ [CLAUDE]: claudeScenario(s) }) });
    try {
      f.processes.fail.start = "test";
      f.processes.fail.stop = "test";
      const { status, body } = await f.call("/v2/cli-workers/claude-code/test", { method: "POST", body: { model: null } });
      assert.equal(status, 200, JSON.stringify(body));
      assert.equal((body.lastTest as { outcome: string }).outcome, "timed_out");
      assert.equal(body.stopVerified, false);
      assert.equal(f.processes.launched("test").length, 1);
      assert.deepEqual(f.processes.closes.at(-1), { purpose: "test", verified: false }, "the stop was tried after the failed start");
      assert.equal(testFolders(f).length, 1, "the folder is kept: the failed start may have left a process in it");
    } finally {
      await f.close();
    }
  }
  {
    const f = await fixture({ scenarios: (s) => ({ [CLAUDE]: claudeScenario(s, { stdout: cliFixture("claude-code/success.windows.stdout.json") }) }) });
    try {
      f.processes.fail.start = "test";
      const { status, body } = await f.call("/v2/cli-workers/claude-code/test", { method: "POST", body: { model: null } });
      assert.equal(status, 200, JSON.stringify(body));
      const saved = body.lastTest as { outcome: string; message: string };
      assert.equal(saved.outcome, "not_installed");
      assert.match(saved.message, /could not be started for the test; anything it started was stopped/);
      assert.doesNotMatch(JSON.stringify(body), /cleanup remains owned/, "the process host's own wording is only logged");
      assert.equal(body.stopVerified, true);
      assert.deepEqual(f.processes.closes.at(-1), { purpose: "test", verified: true });
      assert.deepEqual(testFolders(f), [], "the stop was proven, so the folder is removed");
      assert.equal((await lastTest(f, "claude-code"))?.outcome, "not_installed", "saved to the home");
      // Nothing of the failed start is left to hold up the next Test.
      delete f.processes.fail.start;
      const again = await f.call("/v2/cli-workers/claude-code/test", { method: "POST", body: { model: null } });
      assert.equal(again.status, 200, JSON.stringify(again.body));
      assert.equal((again.body.lastTest as { outcome: string }).outcome, "passed");
    } finally {
      await f.close();
    }
  }
  {
    const f = await fixture({ scenarios: (s) => ({ [CLAUDE]: claudeScenario(s) }) });
    try {
      f.processes.fail.open = "test";
      const { status } = await f.call("/v2/cli-workers/claude-code/test", { method: "POST", body: { model: null } });
      // The Runner could not open a process session: its own failure, never recorded as the CLI's (§3.11).
      assert.equal(status, 500);
      assert.equal(await lastTest(f, "claude-code"), undefined);
      assert.equal(f.processes.launched("test").length, 0);
      assert.deepEqual(testFolders(f), [], "no process session opened, so nothing ran in the folder");
    } finally {
      await f.close();
    }
  }
});

test("a Test already running answers 409; a second provider is not held up", async () => {
  const f = await fixture({ testTimeoutMs: 5_000, scenarios: (s) => ({ [CLAUDE]: claudeScenario(s, { holdMs: 1_500 }), [AGY]: agyScenario(s, { run: { stdout: cliFixture("agy/success.windows.stdout.jsonl") } }) }) });
  try {
    const first = f.call("/v2/cli-workers/claude-code/test", { method: "POST", body: { model: null } });
    for (let tries = 0; f.processes.launched("test").length === 0 && tries < 200; tries += 1) await new Promise((resolve) => setTimeout(resolve, 25));
    const busy = await f.call("/v2/cli-workers/claude-code/test", { method: "POST", body: { model: null } });
    assert.equal(busy.status, 409, JSON.stringify(busy.body));
    assert.equal(busy.body.code, "cli_worker_test_running");
    const other = await f.call("/v2/cli-workers/agy/test", { method: "POST", body: { model: null } });
    assert.equal(other.status, 200, JSON.stringify(other.body));
    assert.equal((await first).status, 200);
    assert.equal(f.processes.launched("test").length, 2, "the refused second Claude Code Test launched nothing");
  } finally {
    await f.close();
  }
});

test("a shutdown during a Test stops it and answers runner_shutting_down; nothing is saved, and no Test starts after", async () => {
  const f = await fixture({ testTimeoutMs: 30_000, scenarios: (s) => ({ [CLAUDE]: claudeScenario(s, { holdMs: 30_000 }) }) });
  try {
    const pending = f.call("/v2/cli-workers/claude-code/test", { method: "POST", body: { model: null } });
    for (let tries = 0; f.processes.launched("test").length === 0 && tries < 400; tries += 1) await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(f.processes.launched("test").length, 1, "the Test's CLI is running");
    const started = Date.now();
    // The Runner's order: the CLI worker service, then the server (which drops every open connection at once).
    await f.detection.close();
    await f.closeServer();
    assert.ok(Date.now() - started < 10_000, "the shutdown does not wait out the Test's deadline");
    const { status, body } = await pending;
    assert.equal(status, 503, JSON.stringify(body));
    assert.equal(body.code, "runner_shutting_down");
    assert.match(body.error as string, /shutting down, so the test did not finish; nothing was saved/);
    assert.deepEqual(f.processes.closes.at(-1), { purpose: "test", verified: true });
    assert.equal(await lastTest(f, "claude-code"), undefined, "an interrupted Test is not the CLI's outcome");
    assert.deepEqual(testFolders(f), [], "its stop was proven, so its folder is removed");
    const opened = f.processes.opens.length;
    await assert.rejects(f.detection.test("claude-code", { model: null }), { code: "runner_shutting_down" });
    const check = await f.detection.check("claude-code");
    assert.equal(check.status, "unknown");
    assert.match(check.reason ?? "", /shutting down/);
    assert.equal(f.processes.opens.length, opened, "no check or Test opened a process session after the shutdown began");
  } finally {
    await f.close();
  }
});

test("a passing test whose cooldown end fails still answers 200 with the saved result", async () => {
  const f = await fixture({
    providerTestPassed: async () => { throw new Error("the Build manager is closing"); },
    scenarios: (s) => ({ [CLAUDE]: claudeScenario(s, { stdout: cliFixture("claude-code/success.windows.stdout.json") }) }),
  });
  try {
    const { status, body } = await f.call("/v2/cli-workers/claude-code/test", { method: "POST", body: { model: null } });
    assert.equal(status, 200, JSON.stringify(body));
    assert.equal((body.lastTest as { outcome: string }).outcome, "passed");
    assert.deepEqual(body.endedCooldownIn, []);
    assert.equal((await lastTest(f, "claude-code"))?.outcome, "passed");
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
    assert.equal(f.processes.opens.length, 0);
    assert.equal(await lastTest(f, "claude-code"), undefined);
    assert.equal((await f.call("/v2/cli-workers/codex-cli/test", { method: "POST", body: { model: "gpt 5" } })).status, 400);
    assert.equal((await f.call("/v2/cli-workers/codex-cli/test", { method: "POST", body: { model: "default" } })).status, 400, "the CLI default is null, never \"default\"");
    assert.equal((await f.call("/v2/cli-workers/codex-cli/test", { method: "POST", body: { model: null, extra: 1 } })).status, 400);
    assert.equal((await f.call("/v2/cli-workers/codex-cli/test", { method: "POST", body: { model: null, reasoningEffort: "a b" } })).status, 400);
    const unknown = await f.call("/v2/cli-workers/gemini-cli/test", { method: "POST", body: { model: null } });
    assert.equal(unknown.status, 404);
    assert.equal(unknown.body.code, "unknown_cli_worker");
    assert.equal((await f.call("/v2/cli-workers/codex-cli/test", { method: "GET" })).status, 404);
  } finally {
    await f.close();
  }
  const g = await fixture({ found: { claude: "C:\\npm\\claude.cmd" } });
  try {
    const { status, body } = await g.call("/v2/cli-workers/claude-code/test", { method: "POST", body: { model: null } });
    assert.equal(status, 409);
    assert.equal(body.code, "cmd_shim_schema");
    assert.equal(g.processes.opens.length, 0);
  } finally {
    await g.close();
  }
});

test("a passing API key test saved to the home ends that provider's cooldowns after the answer (CWD-4)", async () => {
  let release: (() => void) | undefined;
  const ended: string[] = [];
  const f = await fixture({
    providerTestPassed: async (providerId) => {
      ended.push(providerId);
      await new Promise<void>((resolve) => { release = resolve; });
      return [];
    },
  });
  try {
    const save = async (path: string, value: Record<string, unknown>) => {
      const snapshot = await readAiboardHome(f.location, { credentials: false });
      return await f.call("/v2/home", { method: "POST", body: { baseRevision: snapshot.revision, ops: [{ path, op: "merge", value }] } });
    };
    assert.equal((await save("providers.anthropic", { lastValidationSucceeded: false, lastValidatedAt: "2026-11-18T00:00:00.000Z" })).status, 200);
    assert.equal((await save("providers.anthropic", { lastValidationSucceeded: null })).status, 200);
    assert.deepEqual(ended, [], "a failed or cleared test ends nothing");
    // The cooldown's end never holds up the save: the answer arrives while providerTestPassed is still waiting.
    assert.equal((await save("providers.anthropic", { lastValidationSucceeded: true, lastValidatedAt: "2026-11-18T00:00:01.000Z" })).status, 200);
    for (let tries = 0; ended.length === 0 && tries < 200; tries += 1) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.deepEqual(ended, ["anthropic"]);
    release?.();
  } finally {
    release?.();
    await f.close();
  }
});
