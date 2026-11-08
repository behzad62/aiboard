import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";

import type { ToolExecutionContext, ToolResult } from "../src/agent-contracts.js";
import { ControlServer } from "../src/control-server.js";
import { assertGitForUnfinishedRuns, checkGit, createBoundedGitCommandExecutor, gitUnavailableNotice } from "../src/git-preflight.js";
import { deepestBuildWorkingDirectory } from "../src/git-run-context.js";
import { projectDataDirectory, remoteDeviceDirectory, type StateLocationOptions } from "../src/launcher-instance.js";
import { withOwnedFenceLockSync } from "../src/owned-fence-lock.mjs";
import { remotePayloadDigest, type RemoteRequest } from "../src/remote-admission-store.js";
import { REMOTE_CONNECT_SCOPE, REMOTE_RELAY_AUDIENCE, type RelayChallenge } from "../src/remote-auth.js";
import { RemoteDeviceStore } from "../src/remote-device-store.js";
import { createRunnerInternalProcessKernel } from "../src/runner-internal-process-kernel.js";
import { RunSupervisor } from "../src/run-supervisor.js";
import { startRunner, type StartedRunner } from "../src/runner-start.js";
import { SqliteEventStore } from "../src/sqlite-event-store.js";
import { SqliteToolLedger } from "../src/sqlite-tool-ledger.js";
import { ToolBroker } from "../src/tool-broker.js";
import {
  assertTempDirectoryUsable, assertUsableWorkingDirectory, buildWorkspacePathProblem, sqliteDatabaseLocation,
  windowsNativeFilePath, WINDOWS_MAX_TEMP_DIRECTORY, WINDOWS_PLAIN_PATH_LIMIT, WindowsPathTooLongError,
} from "../src/windows-path-limits.mjs";
import { FakeRelay, FixtureWebSocketTransport, pairedDuplex, TestRelayAuthority } from "./fixtures/remote-fake-relay.js";

const windowsOnly = { skip: process.platform === "win32" ? false : "Windows path limits" };

/** A real directory whose full path is exactly `length` characters. */
async function directoryOfLength(root: string, length: number): Promise<string> {
  let path = root;
  while (path.length < length) {
    const remaining = length - path.length - 1;
    const segment = remaining > 60 ? 40 : remaining;
    if (segment < 1) throw new Error("Cannot build a path of that length.");
    path = join(path, "d".repeat(segment));
  }
  assert.equal(path.length, length);
  await mkdir(path, { recursive: true });
  return path;
}

test("a database past MAX_PATH opens and journals its writes", windowsOnly, async () => {
  const root = await mkdtemp(join(tmpdir(), "aiboard-long-sqlite-"));
  try {
    // 1040 and up are past SQLite's default Windows path buffer, which the \\?\ form alone does not get past.
    for (const length of [251, 252, 260, 313, 900, 1040, 1100, 5000, 32_000]) {
      const directory = await directoryOfLength(root, length - "\\events.sqlite".length);
      const file = join(directory, "events.sqlite");
      const store = new SqliteEventStore(file);
      store.close();
      assert.equal(existsSync(file), true, `database at ${file.length} characters`);
    }
  } finally { await rm(root, { recursive: true, force: true }).catch(() => undefined); }
});

test("a long database keeps WAL, ATTACH, reopening and file names SQLite reads as URI syntax", windowsOnly, async () => {
  const root = await mkdtemp(join(tmpdir(), "aiboard-long-uri-"));
  try {
    const directory = await directoryOfLength(root, 2000);
    const main = join(directory, "main 100% #1.sqlite");
    const attached = join(directory, "device policy%3F.sqlite");
    const database = new DatabaseSync(sqliteDatabaseLocation(main));
    database.exec("PRAGMA journal_mode=WAL; CREATE TABLE kept(value TEXT); INSERT INTO kept VALUES ('main');");
    database.prepare("ATTACH DATABASE ? AS other").run(sqliteDatabaseLocation(attached));
    database.exec("CREATE TABLE other.kept(value TEXT); INSERT INTO other.kept VALUES ('attached');");
    database.close();
    // Exactly these names, in exactly this folder: nothing decoded or created anywhere else.
    assert.deepEqual((await readdir(directory)).sort(), ["device policy%3F.sqlite", "main 100% #1.sqlite"]);
    const reopened = new DatabaseSync(sqliteDatabaseLocation(main), { readOnly: true });
    assert.deepEqual({ ...reopened.prepare("SELECT value FROM kept").get() }, { value: "main" });
    assert.throws(() => reopened.exec("INSERT INTO kept VALUES ('no')"), /readonly/);
    reopened.close();
    const other = new DatabaseSync(sqliteDatabaseLocation(attached), { readOnly: true });
    assert.deepEqual({ ...other.prepare("SELECT value FROM kept").get() }, { value: "attached" });
    other.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("the owned fence lock works on a path past MAX_PATH", windowsOnly, async () => {
  const root = await mkdtemp(join(tmpdir(), "aiboard-long-fence-"));
  try {
    const directory = await directoryOfLength(root, 280);
    const lock = join(directory, ".fence.lock");
    assert.equal(withOwnedFenceLockSync(lock, () => "ran"), "ran");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Git is found when the internal process state folder is deep", { ...windowsOnly, timeout: 90_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "aiboard-long-git-"));
  const project = join(root, "project");
  await mkdir(project);
  // %LOCALAPPDATA%\AIBoard\projects\<sha256>\internal-processes with a 120-character LOCALAPPDATA.
  const state = await directoryOfLength(root, 220);
  const processKernel = createRunnerInternalProcessKernel({ stateDirectory: state });
  try {
    const execute = createBoundedGitCommandExecutor({
      executionDeadlineMs: 30_000, terminationDeadlineMs: 15_000, environment: process.env, cwd: project, processKernel,
    });
    const raw = await execute("git", ["--version"]);
    assert.equal(raw.exitCode, 0, raw.stderr);
    assert.equal((await checkGit(execute)).code, "git_ready");
    assert.equal(processKernel.activeCount(), 0);
  } finally {
    await processKernel.close();
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

/** The real default layout under a long LOCALAPPDATA, driven over a fake relay the way a remote AI client drives it. */
async function startRemoteRunner(t: TestContext, localAppDataLength: number, longTemp = false) {
  const root = await mkdtemp(join(tmpdir(), "aiboard-long-remote-"));
  const oldExitCode = process.exitCode;
  const home = join(root, "h");
  const project = join(root, "p");
  await mkdir(project);
  await writeFile(join(project, "visible.txt"), "visible content\n");
  execFileSync("git", ["init", "--quiet"], { cwd: project });
  const localAppData = await directoryOfLength(home, localAppDataLength);
  if (longTemp) {
    // The Windows default: %TEMP% lives under %LOCALAPPDATA%, so it is just as long.
    const temp = join(localAppData, "Temp");
    await mkdir(temp);
    const old = { TEMP: process.env.TEMP, TMP: process.env.TMP };
    process.env.TEMP = temp;
    process.env.TMP = temp;
    t.after(() => { process.env.TEMP = old.TEMP; process.env.TMP = old.TMP; });
  }
  const location: StateLocationOptions = {
    platform: process.platform, home,
    environment: { ...process.env, USERPROFILE: home, APPDATA: join(home, "r"), LOCALAPPDATA: localAppData },
  };
  const state = projectDataDirectory(project.toLowerCase(), location);
  const device = remoteDeviceDirectory(location);
  const extensions = join(dirname(device), "extensions");
  await mkdir(device, { recursive: true });
  const identity = new RemoteDeviceStore(device).ensure("account-1");
  const authority = new TestRelayAuthority();
  const session = authority.session("account-1", "client-1", new Date().toISOString());
  const relay = new FakeRelay();
  const [client, server] = pairedDuplex();
  relay.accept(server);
  const transport = new FixtureWebSocketTransport(client, relay.certificate);
  const lifecycle: { runner?: StartedRunner } = {};
  let shutdownResolve!: (error?: unknown) => void;
  const shutdownComplete = new Promise<unknown>((resolve) => { shutdownResolve = resolve; });
  t.after(async () => {
    if (lifecycle.runner?.started) {
      await lifecycle.runner.shutdown();
      const error = await shutdownComplete;
      if (error) throw error;
    }
    await relay.close();
    process.exitCode = oldExitCode;
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  let startupError: unknown;
  const starting = startRunner([
    "--project", project, "--state-dir", state, "--extensions-home", extensions, "--remote", "--remote-device-dir", device,
  ], {
    location, controlListener: "none", createTransport: () => transport,
    issuer: { pairingUrl: "https://mcp.aiboard.me/pair", restoreSession: async () => session,
      requestSession: async () => { throw new Error("Unexpected pairing request."); } },
    onStartupError: (error) => { startupError = error; },
    onShutdownComplete: shutdownResolve,
  });
  const challenge: RelayChallenge = {
    audience: REMOTE_RELAY_AUDIENCE, accountId: session.accountId, deviceId: identity.deviceId,
    scope: REMOTE_CONNECT_SCOPE, nonce: "long-path-challenge", epoch: "5",
    expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
  };
  await Promise.race([
    relay.send(authority.challenge(challenge)),
    starting.then((value) => { if (!value.started) throw startupError ?? new Error("Runner failed before relay authentication."); }),
  ]);
  await Promise.race([
    relay.nextMessage(),
    starting.then(async (value) => {
      if (!value.started) throw startupError ?? new Error("Runner failed before answering the relay.");
      await new Promise(() => undefined);
    }),
  ]);
  await relay.send({ type: "authenticated", epoch: "5" });
  const runner = await starting;
  lifecycle.runner = runner;
  assert.equal(runner.started, true);
  const runtime = runner.remoteService!.composition.runtime;
  const results: ToolResult[] = [];
  const originalInvokeAdmitted = runtime.invokeAdmitted.bind(runtime);
  runtime.invokeAdmitted = async (...args) => {
    const outcome = await originalInvokeAdmitted(...args);
    results.push(outcome.result);
    return outcome;
  };
  const admission = runner.remoteService!.composition.admission;
  const jobIdentity = { accountId: "account-1", clientId: "client-1", deviceId: identity.deviceId };
  const settled = async (jobId: string) => {
    const deadline = Date.now() + 60_000;
    for (;;) {
      const job = admission.getJob(jobIdentity, jobId);
      if (job && !["queued", "running", "awaiting_approval"].includes(job.state)) return job;
      if (Date.now() > deadline) assert.fail(`job ${jobId} did not settle (last ${job?.state ?? "missing"})`);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  };
  let sequence = 0;
  const send = async (toolId: string, payload: Record<string, unknown>, operationClass = "read") => {
    sequence += 1;
    const request: RemoteRequest = {
      protocolVersion: "1.0.0", requestId: `long-${sequence}`, accountId: "account-1", clientId: "client-1",
      deviceId: identity.deviceId, deviceEpoch: "5", toolId, operationClass, scopeRef: "scope-project",
      issuedAt: new Date(Date.now() - 1_000).toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString(),
      nonce: `long-nonce-${sequence}`, idempotencyKey: `long-key-${sequence}`, payloadDigest: "",
      traceId: `long-trace-${sequence}`, payload,
    };
    request.payloadDigest = remotePayloadDigest(request);
    await relay.send({ type: "request", request, authorization: authority.authorize(request) });
    const message = await relay.nextMessage();
    assert.equal(message.type, "response");
    if (message.type !== "response") throw new Error("Expected a relay response.");
    const response = message.response;
    if (!response.admitted || !response.jobId) return { response, status: undefined, job: undefined };
    const job = await settled(response.jobId);
    return { response, status: job.state, job };
  };
  return { runner, send, results, project, state, device, localAppData };
}

// 129 puts the deepest channel file at the 313 characters of the original report, and 1000 puts every Runner database
// past SQLite's default 1040-byte path buffer. 195 with TEMP under it is the longest
// TEMP the Runner accepts. Long-TEMP cases run first: the compiled Job host helper is cached per process, and in a long
// TEMP it falls back to compiling in-process, which is the path that has to work there.
for (const [localAppDataLength, longTemp] of [[129, true], [195, true], [320, false], [1000, false]] as const) test(`remote tools work with a ${localAppDataLength}-character LOCALAPPDATA and ${longTemp ? "a TEMP inside it" : "a short TEMP"}`, { ...windowsOnly, timeout: 240_000 }, async (t) => {
  const { runner, send, results, project, state } = await startRemoteRunner(t, localAppDataLength, longTemp);
  assert.ok(state.length > 210, `state folder is ${state.length} characters`);
  const channelFile = join(state, "internal-processes", `owned-${"0".repeat(36)}`, "channel", "output", "stdout-000000000001.json");
  assert.ok(channelFile.length >= 313, `deepest channel file is ${channelFile.length} characters`);
  assert.equal(runner.remoteService?.status().state, "tool-ready");

  const read = await send("files_read", { path: "visible.txt" });
  assert.equal(read.status, "completed", JSON.stringify(results.at(-1)));
  assert.match(JSON.stringify(results.at(-1)?.content), /visible content/);

  const write = await send("files_write", { path: "written.txt", content: "written\n" }, "write");
  assert.equal(write.status, "completed", JSON.stringify(results.at(-1)));
  assert.equal(await readFile(join(project, "written.txt"), "utf8"), "written\n");

  const git = await send("git_status", {});
  assert.equal(git.status, "completed", JSON.stringify(results.at(-1)));

  const run = await send("process_run", { command: process.execPath, args: ["-e", "console.log('ran-'+(6*7))"] }, "write");
  assert.equal(run.status, "completed", JSON.stringify(results.at(-1)));
  assert.match(JSON.stringify(results.at(-1)?.content), /ran-42/);

  // The Windows Job host really ran here, so its log paths were exercised at this length.
  assert.ok((await readdir(join(state, "managed-processes-job-host"))).some((name) => name.startsWith("process_")));
  const marker = join(project, "started.txt");
  const started = await send("process_start", { command: process.execPath, args: ["-e", "require('node:fs').writeFileSync('started.txt', 'yes')"] }, "write");
  assert.equal(started.status, "completed", JSON.stringify(results.at(-1)));
  const deadline = Date.now() + 30_000;
  while (!existsSync(marker) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(existsSync(marker), true);

  // A folder Windows cannot start a process in: a failed job that says so, not outcome_unknown, and nothing ran.
  const deep = await directoryOfLength(project, 300);
  const refused = await send("process_run", { command: process.execPath, args: ["-e", "require('node:fs').writeFileSync('ran.txt', 'ran')"], cwd: deep }, "write");
  assert.equal(refused.status, "failed", JSON.stringify(results.at(-1)));
  assert.ok(results.at(-1)?.error?.message.startsWith("windows_path_too_long: "), JSON.stringify(results.at(-1)));
  assert.ok(results.at(-1)?.error?.message.includes(deep), "names the path");
  assert.match(results.at(-1)?.error?.message ?? "", /300 characters long.*258.*--state-dir/s);
  assert.equal(existsSync(join(deep, "ran.txt")), false);
  const refusedStart = await send("process_start", { command: process.execPath, args: ["-e", "require('node:fs').writeFileSync('ran.txt', 'ran')"], cwd: deep }, "write");
  assert.equal(refusedStart.status, "failed", JSON.stringify(results.at(-1)));
  assert.ok(results.at(-1)?.error?.message.includes(deep), JSON.stringify(results.at(-1)));
  assert.equal(existsSync(join(deep, "ran.txt")), false);
  assert.equal(runner.remoteService?.status().state, "tool-ready");
});

test("a remote tool that cannot bind its run reports the path instead of outcome_unknown", { ...windowsOnly, timeout: 120_000 }, async (t) => {
  const { runner, send } = await startRemoteRunner(t, 129);
  const runtime = runner.remoteService!.composition.runtime as unknown as { binding: (principal: unknown) => Promise<unknown> };
  const reason = new WindowsPathTooLongError("A Runner database path", "C:\\deep\\tool-ledger.sqlite", 1100, "the limit");
  runtime.binding = () => Promise.reject(new AggregateError([new Error("cleanup"), reason], "Remote binding failed."));
  const { status, job } = await send("files_read", { path: "visible.txt" });
  assert.equal(status, "failed");
  assert.equal(job?.state, "failed");
  const stored = runner.remoteService!.composition.admission.result(job!.principal, job!.jobId);
  assert.match(Buffer.from(stored?.inline ?? []).toString("utf8"), /windows_path_too_long.*1100 characters.*tool-ledger\.sqlite/s);
});

test("a refusal raised before a tool's effect starts settles durably; any other failure stays in doubt", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "aiboard-long-broker-"));
  const ledger = new SqliteToolLedger(join(workspace, "tools.sqlite"));
  const register = (broker: ToolBroker) => {
    for (const [name, notStarted] of [["fixture.refused", true], ["fixture.unproven", false]] as const) broker.register({
      definition: { name, description: "Throws", inputSchema: { type: "object" }, readOnly: false, effect: "workspace" },
      validate: () => ({ ok: true, value: {} }),
      execute: async () => { throw new Error("wrapped", { cause: new WindowsPathTooLongError("A folder", "C:\\deep", 300, "the limit", notStarted) }); },
    });
  };
  const context = { runId: "run", sessionId: "session", actor: { role: "worker", id: "w" }, workspacePath: workspace } as ToolExecutionContext;
  const call = (name: string) => ({ type: "tool_call" as const, callId: name, name, arguments: {} });
  try {
    const broker = new ToolBroker({ permissionProfile: "full", workspacePath: workspace, ledger });
    register(broker);
    const refused = await broker.invoke(call("fixture.refused"), context);
    assert.equal(refused.error?.code, "windows_path_too_long");
    assert.match(refused.error?.message ?? "", /300 characters long.*C:\\deep/s);
    assert.equal((await broker.invoke(call("fixture.unproven"), context)).error?.code, "tool_execution_failed");
    const restarted = new ToolBroker({ permissionProfile: "full", workspacePath: workspace, ledger });
    register(restarted);
    assert.equal((await restarted.invoke(call("fixture.refused"), context)).error?.code, "windows_path_too_long");
    assert.equal((await restarted.invoke(call("fixture.unproven"), context)).error?.code, "reconciliation_required");
  } finally {
    ledger.close();
    await rm(workspace, { recursive: true, force: true });
  }
});

test("a state folder past SQLite's default path buffer starts, with its databases in it", { ...windowsOnly, timeout: 120_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "aiboard-long-state-"));
  const oldExitCode = process.exitCode;
  let runner: StartedRunner | undefined;
  let shutdownResolve!: (error?: unknown) => void;
  const shutdownComplete = new Promise<unknown>((resolve) => { shutdownResolve = resolve; });
  try {
    const project = join(root, "project");
    await mkdir(project);
    const state = join(root, "s".repeat(240), "s".repeat(240), "s".repeat(240), "s".repeat(240), "s".repeat(240));
    assert.ok(state.length > 1040, `state folder is ${state.length} characters`);
    let failure: unknown;
    runner = await startRunner(["--project", project, "--state-dir", state], {
      controlListener: "none", onStartupError: (error) => { failure = error; }, onShutdownComplete: shutdownResolve,
    });
    assert.equal(runner.started, true, String(failure));
    const databases = (await readdir(state, { recursive: true })).filter((name) => name.endsWith(".sqlite"));
    assert.ok(databases.length > 0, "the Runner keeps its databases in the long state folder");
  } finally {
    if (runner?.started) {
      await runner.shutdown();
      const error = await shutdownComplete;
      if (error) throw error;
    }
    process.exitCode = oldExitCode;
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("a TEMP folder Windows PowerShell cannot work with is refused at startup, with the way out", windowsOnly, async () => {
  const root = await mkdtemp(join(tmpdir(), "aiboard-long-temp-"));
  const oldExitCode = process.exitCode;
  const old = { TEMP: process.env.TEMP, TMP: process.env.TMP };
  try {
    const project = join(root, "project");
    const state = join(root, "state");
    await mkdir(project);
    const temp = await directoryOfLength(root, WINDOWS_MAX_TEMP_DIRECTORY + 1);
    process.env.TEMP = temp;
    process.env.TMP = temp;
    let failure: unknown;
    const started = Date.now();
    const result = await startRunner(["--project", project, "--state-dir", state], {
      controlListener: "none", onStartupError: (error) => { failure = error; },
    });
    assert.equal(result.started, false);
    assert.ok(failure instanceof Error);
    assert.ok(failure.message.startsWith(`windows_path_too_long: The TEMP folder is ${temp.length} characters long`), failure.message);
    assert.ok(failure.message.includes(temp), "names the path");
    assert.match(failure.message, /Set TEMP and TMP to a shorter folder/);
    assert.ok(Date.now() - started < 5_000, "no process was started first");
    assert.equal(existsSync(state), false, "no state was created");
    assert.doesNotThrow(() => assertTempDirectoryUsable(`C:\\${"t".repeat(WINDOWS_MAX_TEMP_DIRECTORY - 3)}`, "win32"));
  } finally {
    process.env.TEMP = old.TEMP;
    process.env.TMP = old.TMP;
    process.exitCode = oldExitCode;
    await rm(root, { recursive: true, force: true });
  }
});

test("Git that could not be started is not reported as missing", async () => {
  const reason = "windows_path_too_long: A process working directory is 300 characters long.";
  const result = await checkGit(async () => ({ exitCode: 1, stdout: "", stderr: reason, launchFailure: reason }));
  assert.equal(result.available, false);
  assert.equal(result.code, "git_unverified");
  assert.ok(result.reason?.includes(reason));
  const notice = gitUnavailableNotice("git_unverified", "win32", result.reason ?? undefined);
  assert.doesNotMatch(notice, /not found|Install Git/);
  assert.ok(notice.includes(reason));
  assert.throws(() => assertGitForUnfinishedRuns(result, ["run-1"], "win32"), (error: Error) =>
    error.message.startsWith("git_unverified: ") && !error.message.includes("Install Git") && error.message.includes("--set-aside-run run-1"));
});

test("the real Git executor reports a too-long working directory by name", windowsOnly, async () => {
  const root = await mkdtemp(join(tmpdir(), "aiboard-long-cwd-"));
  const processKernel = createRunnerInternalProcessKernel({ stateDirectory: join(root, "kernel") });
  try {
    const cwd = await directoryOfLength(root, 300);
    const execute = createBoundedGitCommandExecutor({
      executionDeadlineMs: 30_000, terminationDeadlineMs: 15_000, environment: process.env, cwd, processKernel,
    });
    const result = await checkGit(execute);
    assert.equal(result.code, "git_unverified");
    assert.ok(result.reason?.includes(cwd), "names the path");
    assert.match(result.reason ?? "", /300 characters long/);
    assert.equal(processKernel.activeCount(), 0, "nothing was launched");
  } finally {
    await processKernel.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("Build is refused with the reason when its workspaces could not run a process", { ...windowsOnly, timeout: 60_000 }, async () => {
  const state = `C:\\${"s".repeat(200)}`;
  const deepest = deepestBuildWorkingDirectory("C:\\project", state);
  assert.ok(deepest.length > 258);
  assert.ok(deepest.startsWith(state));
  const problem = buildWorkspacePathProblem(deepest);
  assert.ok(problem?.startsWith("windows_path_too_long: Build and ToolBench are off"));
  assert.ok(problem?.includes(deepest) && problem.includes(`${deepest.length} characters`));
  assert.match(problem ?? "", /--state-dir.*Chat and Remote still work/s);
  assert.equal(buildWorkspacePathProblem(deepestBuildWorkingDirectory("C:\\project", "C:\\aiboard-state")), undefined);
  // The default layout: a 108-character LOCALAPPDATA is the longest whose Build workspaces all still fit.
  const location = (length: number): StateLocationOptions => ({ platform: "win32", home: "C:\\h", environment: { LOCALAPPDATA: `C:\\${"l".repeat(length - 3)}` } });
  const defaultDeepest = (length: number) => deepestBuildWorkingDirectory("C:\\project", projectDataDirectory("c:\\project", location(length)));
  assert.equal(defaultDeepest(108).length, 258);
  assert.equal(defaultDeepest(109).length, 259);

  const root = await mkdtemp(join(tmpdir(), "aiboard-long-control-"));
  const supervisor = new RunSupervisor(new SqliteEventStore(":memory:"));
  const token = "t".repeat(32);
  const server = new ControlServer({
    supervisor, token, buildPathProblem: problem,
    checkGit: async () => ({ available: true, version: "2.53.0", code: "git_ready", reason: null }),
    bootstrapRun: async () => { throw new Error("Build must not start."); },
  });
  try {
    const { url } = await server.start(0);
    const response = await fetch(`${url}/v2/runs`, {
      method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ runId: "run_blocked", projectPath: root, permissionProfile: "project", idempotencyKey: "create:run_blocked" }),
    });
    const body = await response.json() as { code?: string; message?: string };
    assert.equal(response.status, 412, JSON.stringify(body));
    assert.equal(body.code, "windows_path_too_long");
    assert.deepEqual(supervisor.listRuns(), []);
  } finally {
    await server.close();
    supervisor.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("state written through a plain path stays readable and locked once the Runner uses the long form", windowsOnly, async () => {
  const root = await mkdtemp(join(tmpdir(), "aiboard-long-existing-"));
  try {
    // 245 characters: an older Runner could open this with a plain path, this one uses the long form for it.
    const directory = await directoryOfLength(root, 245 - "\\e.sqlite".length);
    const file = join(directory, "e.sqlite");
    assert.equal(file.length, 245);
    assert.ok(sqliteDatabaseLocation(file).startsWith("file:////%3F/"));
    const older = new DatabaseSync(file, { timeout: 0 });
    older.exec("CREATE TABLE kept(value TEXT); INSERT INTO kept VALUES ('from before');");
    const current = new DatabaseSync(sqliteDatabaseLocation(file), { timeout: 0 });
    assert.deepEqual({ ...current.prepare("SELECT value FROM kept").get() }, { value: "from before" });
    older.exec("BEGIN IMMEDIATE");
    assert.throws(() => current.exec("BEGIN IMMEDIATE"), /database is locked/);
    older.exec("ROLLBACK");
    current.exec("BEGIN IMMEDIATE");
    assert.throws(() => older.exec("BEGIN IMMEDIATE"), /database is locked/);
    current.exec("ROLLBACK");
    older.close();
    current.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("paths the Windows limits do not reach are left exactly as given", () => {
  const short = "C:\\Users\\Alice\\AppData\\Local\\AIBoard\\events.sqlite";
  assert.equal(sqliteDatabaseLocation(short, "win32"), short);
  assert.equal(sqliteDatabaseLocation(":memory:", "win32"), ":memory:");
  assert.equal(sqliteDatabaseLocation("/home/alice/" + "x".repeat(400), "linux"), "/home/alice/" + "x".repeat(400));
  const atLimit = `C:\\${"x".repeat(WINDOWS_PLAIN_PATH_LIMIT - 4)}`;
  assert.equal(sqliteDatabaseLocation(atLimit, "win32"), atLimit);
  const past = `${atLimit}x`;
  assert.equal(windowsNativeFilePath(past, "win32"), `\\\\?\\${past}`);
  assert.equal(sqliteDatabaseLocation(past, "win32"), `file:////%3F/C:/${"x".repeat(WINDOWS_PLAIN_PATH_LIMIT - 3)}?vfs=win32-longpath`);
  assert.equal(windowsNativeFilePath(past, "linux"), past);
  const server = `\\\\server\\share\\${"x".repeat(300)}`;
  assert.equal(sqliteDatabaseLocation(server, "win32"), `file:////%3F/UNC/server/share/${"x".repeat(300)}?vfs=win32-longpath`);
  const odd = `C:\\${"x".repeat(300)}\\a 100%#b%3F.sqlite`;
  assert.equal(sqliteDatabaseLocation(odd, "win32"), `file:////%3F/C:/${"x".repeat(300)}/a 100%25%23b%253F.sqlite?vfs=win32-longpath`);
  assert.equal(sqliteDatabaseLocation("file:already-a-uri.sqlite", "win32"), "file:already-a-uri.sqlite");
  assert.doesNotThrow(() => assertUsableWorkingDirectory(`C:\\${"x".repeat(255)}`, "win32"));
  assert.throws(() => assertUsableWorkingDirectory(`C:\\${"x".repeat(256)}`, "win32"), /259 characters long/);
  assert.doesNotThrow(() => assertUsableWorkingDirectory(`/home/${"x".repeat(400)}`, "linux"));
  assert.doesNotThrow(() => assertTempDirectoryUsable(`/tmp/${"x".repeat(2000)}`, "linux"));
});

test("every SQLite open in the Runner goes through the long path helper", async () => {
  const source = join(dirname(fileURLToPath(import.meta.url)), "..", "src");
  const offenders: string[] = [];
  for (const name of await readdir(source)) {
    if (!/\.(ts|mjs)$/.test(name) || name.endsWith(".d.ts")) continue;
    const text = await readFile(join(source, name), "utf8");
    if (/new DatabaseSync\((?!sqliteDatabaseLocation\()/.test(text)) offenders.push(`${name}: new DatabaseSync`);
    if (/ATTACH DATABASE[^\n]*\.run\((?!sqliteDatabaseLocation\()/.test(text)) offenders.push(`${name}: ATTACH DATABASE`);
  }
  assert.deepEqual(offenders, []);
});
