import assert from "node:assert/strict";
import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { createServer as createHttpServer, type Server as HttpServer } from "node:http";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { parseLauncherArguments, runLauncher, type RunnerKind } from "../src/launcher.js";
import {
  assertDefaultStateOutsideProject, assertExternalState, canonicalFuturePath, projectDataDirectory, projectIdentity,
  readControlKey, readInstance, remoteDeviceDirectory, tryAcquireLock,
} from "../src/launcher-instance.js";
import { requestLauncherControl, startLauncherControl, type LauncherHandshake, type LauncherRemoteControl } from "../src/launcher-ipc.js";
import type { RemoteEnableSettings, RemoteEvent } from "../src/remote-in-place.js";
import { RemoteDeviceStore } from "../src/remote-device-store.js";

const bin = fileURLToPath(new URL("../bin/aiboard.mjs", import.meta.url));
const legacyBin = fileURLToPath(new URL("../bin/aiboard-runner-v2.mjs", import.meta.url));

test("remote device policy and audit flags are validated and forwarded", () => {
  const parsed = parseLauncherArguments(["remote", "--only-here", "--read-only", "--no-shell"]);
  assert.deepEqual(parsed.runnerFlags, ["--only-here", "--read-only", "--no-shell"]);
  assert.deepEqual(parseLauncherArguments(["remote", "--anywhere", "--writable", "--shell"]).runnerFlags,
    ["--anywhere", "--writable", "--shell"]);
  assert.equal(parseLauncherArguments(["remote", "--policy"]).policy, true);
  assert.equal(parseLauncherArguments(["remote", "--audit", "--limit", "12"]).auditLimit, 12);
  for (const args of [["remote", "--only-here", "--only-here"], ["remote", "--only-here", "--anywhere"],
    ["remote", "--read-only", "--writable"], ["remote", "--no-shell", "--shell"],
    ["remote", "--audit", "--policy"], ["remote", "--audit", "--read-only"],
    ["remote", "--limit", "3"], ["remote", "--audit", "--limit", "0"], ["remote", "--bogus"],
    ["--only-here"], ["remote", "--logout", "--logout"]]) {
    assert.throws(() => parseLauncherArguments(args), /invalid_arguments/);
  }
});

/** Tests must never open the developer's real browser: start-mode pairing URLs are captured here. */
const interceptedBrowserOpens: string[] = [];
const neverOpenBrowser = (url: string): void => { interceptedBrowserOpens.push(url); };

async function fixture(): Promise<{ root: string; project: string; state: string; cleanup: () => Promise<void> }> {
  const prefix = join(tmpdir(), "aiboard-l1b-");
  const root = await mkdtemp(prefix);
  const project = join(root, "project");
  const state = join(root, "state");
  await mkdir(project);
  return { root, project, state, cleanup: async () => {
    assert.ok(root.startsWith(prefix));
    await rm(root, { recursive: true, force: true });
  } };
}

async function waitUntil(check: () => boolean | Promise<boolean>, timeout = 5_000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!(await check())) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for launcher test state.");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** The Runner side of an in-place Remote: enabling queues what a pairing Runner would report. */
class FakeRemote {
  on = false;
  readonly enables: RemoteEnableSettings[] = [];
  disables = 0;
  polls = 0;
  private readonly queued: { sequence: number; event: RemoteEvent }[] = [];
  private sequence = 0;

  push(event: RemoteEvent): void { this.queued.push({ sequence: ++this.sequence, event }); }

  control(): LauncherRemoteControl {
    return {
      active: () => this.on,
      enable: async (settings) => {
        this.enables.push(settings);
        if (this.on) return;
        this.on = true;
        this.push({ type: "aiboard-remote-pairing", userCode: "BCDF-GHJK", verificationUri: "https://mcp.aiboard.me/pair",
          expiresAt: new Date(Date.now() + 600_000).toISOString(), deviceName: "Desktop" });
        this.push({ type: "aiboard-remote-open", url: "https://mcp.aiboard.me/pair" });
        this.push({ type: "aiboard-remote-session", deviceName: "Desktop", accountId: "account-1" });
        this.push({ type: "aiboard-remote-state", state: "tool-ready", reasonCode: "ready", persisted: false });
      },
      events: (cursor) => {
        this.polls += 1;
        return { events: this.queued.filter((entry) => entry.sequence > cursor).map((entry) => entry.event), cursor: this.sequence, active: this.on };
      },
      disable: async () => { this.disables += 1; this.on = false; },
    };
  }
}

class FakeRunner extends EventEmitter {
  readonly pid = process.pid;
  readonly remote = new FakeRemote();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  connected = true;
  stops = 0;
  handshake?: LauncherHandshake;
  control?: Awaited<ReturnType<typeof startLauncherControl>>;
  server?: HttpServer;
  release?: () => void;
  healthy = true;
  beforeReady?: () => void;
  /** What the Runner reports about Git in its ready message (absent: Git is usable). */
  git?: "git_missing" | "git_too_old";

  send(message: unknown, callback?: (error: Error | null) => void): boolean {
    callback?.(null);
    if (typeof message === "object" && message !== null && "type" in message && message.type === "aiboard-launcher-init") {
      void this.start(message as LauncherHandshake).catch((error: unknown) => this.emit("error", error));
    } else if (typeof message === "object" && message !== null && "type" in message && message.type === "aiboard-launcher-stop") {
      void this.stop();
    }
    return true;
  }

  disconnect(): void { this.connected = false; void this.stop(); }

  private async start(handshake: LauncherHandshake): Promise<void> {
    this.handshake = handshake;
    const release = tryAcquireLock(handshake.stateDirectory, "lifetime");
    if (!release) throw new Error("Fake Runner could not acquire its lifetime lock.");
    this.release = release;
    this.server = createHttpServer((request, response) => {
      if (!this.healthy || request.headers.authorization !== `Bearer ${handshake.token}` || request.url !== "/v2/health") {
        response.writeHead(503).end(); return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true, projectPath: handshake.identity.projectPath }));
    });
    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(0, "127.0.0.1", resolve);
    });
    const address = this.server.address();
    assert.ok(address && typeof address !== "string");
    this.control = await startLauncherControl({
      identity: handshake.identity, instanceId: handshake.instanceId, version: handshake.version,
      startedAt: 1_700_000_000_000, port: address.port, token: handshake.token,
      controlKey: Buffer.from(handshake.controlKey, "hex"), shutdown: () => { void this.stop(); },
      registerPair: () => undefined, remote: this.remote.control(),
    });
    this.beforeReady?.();
    this.emit("message", { type: "aiboard-launcher-ready", instance: this.control.instance, ...(this.git ? { git: this.git } : {}) });
  }

  async stop(): Promise<void> {
    if (!this.release) return;
    this.stops += 1;
    const release = this.release;
    this.release = undefined;
    await this.control?.close();
    if (this.server) await new Promise<void>((resolve, reject) => this.server!.close((error) => error ? reject(error) : resolve()));
    release();
    this.connected = false;
    this.stdout.end(); this.stderr.end();
    this.emit("close", 0, null);
  }
}

function fakeSpawner(children: FakeRunner[], calls: { command: string; args: string[]; options: SpawnOptions }[]) {
  return (command: string, args: string[], options: SpawnOptions): ChildProcess => {
    calls.push({ command, args, options });
    const child = new FakeRunner();
    children.push(child);
    setImmediate(() => child.emit("message", { type: "aiboard-launcher-awaiting-init" }));
    return child as unknown as ChildProcess;
  };
}

test("canonical cwd and per-platform user data directories are stable and external", async () => {
  const f = await fixture();
  try {
    const identity = await projectIdentity(f.project);
    assert.equal(identity.projectPath, await realpath(f.project));
    const options = { environment: {}, home: "/home/alice", platform: "linux" as const };
    const linux = projectDataDirectory(identity.projectKey, options);
    assert.match(linux, /^\/home\/alice\/\.local\/share\/aiboard\/projects\/[0-9a-f]{64}$/);
    assert.match(projectDataDirectory(identity.projectKey, { ...options, environment: { XDG_DATA_HOME: "/data/alice" } }), /^\/data\/alice\/aiboard\/projects\//);
    assert.match(projectDataDirectory(identity.projectKey, { ...options, platform: "darwin" }), /^\/home\/alice\/Library\/Application Support\/AIBoard\/projects\//);
    assert.match(projectDataDirectory(identity.projectKey, { platform: "win32", home: "C:\\Users\\Alice", environment: { LOCALAPPDATA: "C:\\Users\\Alice\\AppData\\Local" } }), /^C:\\Users\\Alice\\AppData\\Local\\AIBoard\\projects\\/);
    assert.notEqual(linux, projectDataDirectory(`${identity.projectKey}-other`, options));
    const nested = await canonicalFuturePath(join(f.project, "nested", "state"));
    assert.throws(() => assertExternalState(identity.projectPath, nested), /--state-dir/);
    await assert.rejects(runLauncher(["--state-dir", nested], { cwd: f.project, write: () => undefined }), /--state-dir/);
    const alias = join(f.root, "project-alias");
    await symlink(f.project, alias, process.platform === "win32" ? "junction" : "dir");
    const linkedState = await canonicalFuturePath(join(alias, "linked-state"));
    assert.throws(() => assertExternalState(identity.projectPath, linkedState), /--state-dir/);
  } finally { await f.cleanup(); }
});

test("Windows default state requires absolute LOCALAPPDATA inside the profile", async () => {
  if (process.platform !== "win32") return;
  const f = await fixture();
  try {
    const outside = join(dirname(f.root), basename(f.root) + "-outside");
    for (const environment of [{}, { LOCALAPPDATA: "relative" }, { LOCALAPPDATA: f.root }, { LOCALAPPDATA: outside }]) {
      await assert.rejects(runLauncher(["--no-open"], { cwd: f.project, home: f.root, environment, write: () => undefined }), /launcher_state_unverified/);
    }
  } finally { await f.cleanup(); }
});

test("Windows default state refuses an existing directory without matching launcher ownership", async () => {
  if (process.platform !== "win32") return;
  const f = await fixture();
  try {
    const identity = await projectIdentity(f.project);
    const environment = { LOCALAPPDATA: join(f.root, "data") };
    const state = projectDataDirectory(identity.projectKey, { platform: "win32", home: f.root, environment });
    await mkdir(state, { recursive: true });
    const runtime = { cwd: f.project, home: f.root, environment, write: () => undefined };
    await assert.rejects(runLauncher(["--no-open"], runtime), /Existing state has no launcher ownership record/);
    assert.deepEqual(await readdir(state), []);
    const marker = join(state, "launcher-project.json");
    for (const foreign of [
      { schemaVersion: 1, projectKey: identity.projectKey, owner: identity.owner + "-foreign" },
      { schemaVersion: 1, projectKey: identity.projectKey + "-foreign", owner: identity.owner },
    ]) {
      await writeFile(marker, JSON.stringify(foreign));
      await assert.rejects(runLauncher(["--no-open"], runtime), /instance_identity_mismatch/);
      assert.equal(await readFile(marker, "utf8"), JSON.stringify(foreign));
    }
  } finally { await f.cleanup(); }
});

test("Windows refuses junctions in default and explicitly chosen state paths", async () => {
  if (process.platform !== "win32") return;
  const f = await fixture();
  try {
    const data = join(f.root, "data");
    const target = join(f.root, "target");
    await mkdir(data);
    await mkdir(target);
    const junction = join(data, "AIBoard");
    await symlink(target, junction, "junction");
    const runtime = { cwd: f.project, home: f.root, environment: { LOCALAPPDATA: data }, write: () => undefined };
    await assert.rejects(runLauncher(["--no-open"], runtime), /symlinks or junctions/);
    await assert.rejects(runLauncher(["status"], runtime), /symlinks or junctions/);
    await assert.rejects(runLauncher(["--state-dir", join(junction, "state")], runtime), /symlinks or junctions/);
    assert.deepEqual(await readdir(target), []);

    const localLink = join(f.root, "local-link");
    await symlink(target, localLink, "junction");
    await assert.rejects(runLauncher(["--no-open"], {
      cwd: f.project, home: f.root, environment: { LOCALAPPDATA: localLink }, write: () => undefined,
    }), /symlinks or junctions/);

    const secondEnvironment = { LOCALAPPDATA: join(f.root, "data2") };
    const identity = await projectIdentity(f.project);
    const stateLink = projectDataDirectory(identity.projectKey, { platform: "win32", home: f.root, environment: secondEnvironment });
    const stateTarget = join(f.root, "state-target");
    await mkdir(dirname(stateLink), { recursive: true });
    await mkdir(stateTarget);
    await symlink(stateTarget, stateLink, "junction");
    await assert.rejects(runLauncher(["--no-open"], { ...runtime, environment: secondEnvironment }), /symlinks or junctions/);
    await assert.rejects(runLauncher(["--state-dir", stateLink], runtime), /symlinks or junctions/);
    assert.deepEqual(await readdir(stateTarget), []);

    const profile = join(f.root, "profile");
    const profileLink = join(f.root, "profile-link");
    await mkdir(profile);
    await symlink(profile, profileLink, "junction");
    await assert.rejects(runLauncher(["--no-open"], {
      cwd: f.project, home: profileLink, environment: { LOCALAPPDATA: join(profileLink, "data") }, write: () => undefined,
    }), /symlinks or junctions/);
    await assert.rejects(runLauncher(["--state-dir", join(f.project, "state")], runtime), /--state-dir/);
    assert.deepEqual(await readdir(profile), []);
  } finally { await f.cleanup(); }
});

test("unowned existing Runner state is not adopted or overwritten", async () => {
  const f = await fixture();
  try {
    await mkdir(f.state, { mode: 0o700 });
    const existing = join(f.state, "events.sqlite");
    await writeFile(existing, "original state");
    await assert.rejects(runLauncher(["--state-dir", f.state], { cwd: f.project, write: () => undefined }), /Existing state has no launcher ownership record/);
    assert.equal(await readFile(existing, "utf8"), "original state");
  } finally { await f.cleanup(); }
});

test("racing same-project launches reuse one verified Runner and never disclose its token", async () => {
  const f = await fixture();
  const children: FakeRunner[] = [];
  const calls: { command: string; args: string[]; options: SpawnOptions }[] = [];
  const output: string[] = [];
  const runtime = { cwd: f.project, write: (text: string) => output.push(text), spawnRunner: fakeSpawner(children, calls), openUrl: neverOpenBrowser };
  const flags = ["--state-dir", f.state, "--port", "0", "--no-open", "--allow-origin", "https://aiboard.me"];
  await mkdir(f.state, { mode: 0o700 });
  const first = runLauncher(flags, runtime);
  const second = runLauncher(flags, runtime);
  void first.catch(() => undefined); void second.catch(() => undefined);
  try {
    await waitUntil(() => output.some((line) => line.includes("already running")));
    assert.equal(children.length, 1);
    const token = children[0]!.handshake!.token;
    const key = children[0]!.handshake!.controlKey;
    assert.equal(calls[0]!.command, process.execPath);
    assert.ok(calls[0]!.args.includes("--launcher-ipc"));
    assert.ok(calls[0]!.args.includes("--allow-origin"));
    assert.ok(calls[0]!.args.includes(await realpath(f.project)));
    assert.ok(!calls[0]!.args.some((arg) => arg.includes(token) || arg.includes(key)));
    assert.ok(!JSON.stringify(output).includes(token));
    assert.ok(!JSON.stringify(output).includes(key));
    await runLauncher(["status", "--state-dir", f.state], runtime);
    assert.match(output.at(-1)!, /Runner running[\s\S]*URL: http:\/\/127\.0\.0\.1:/);
    await runLauncher(["stop", "--state-dir", f.state], runtime);
    await Promise.all([first, second]);
    assert.equal(children[0]!.stops, 1);
    assert.match(output.at(-1)!, /Runner stopped/);
  } finally {
    await Promise.all(children.map((child) => child.stop()));
    await Promise.allSettled([first, second]);
    await f.cleanup();
  }
});

test("the default state location is keyed to the canonical cwd and reused across races", async () => {
  const f = await fixture();
  const children: FakeRunner[] = [];
  const calls: { command: string; args: string[]; options: SpawnOptions }[] = [];
  const output: string[] = [];
  const environment = process.platform === "win32" ? { LOCALAPPDATA: join(f.root, "data").toLowerCase() } : { XDG_DATA_HOME: join(f.root, "data") };
  const home = process.platform === "win32" ? f.root.toUpperCase() : f.root;
  const runtime = { cwd: f.project, home, environment, spawnRunner: fakeSpawner(children, calls), write: (line: string) => output.push(line), openUrl: neverOpenBrowser };
  const first = runLauncher(["--no-open"], runtime);
  const second = runLauncher(["--no-open"], runtime);
  void first.catch(() => undefined); void second.catch(() => undefined);
  let restarted: Promise<void> | undefined;
  try {
    await waitUntil(() => output.some((line) => line.includes("already running")));
    assert.equal(children.length, 1);
    const identity = await projectIdentity(f.project);
    const expected = projectDataDirectory(identity.projectKey, { platform: process.platform, environment, home });
    assert.equal(children[0]!.handshake!.stateDirectory, await realpath(expected));
    await runLauncher(["stop"], runtime);
    await Promise.all([first, second]);
    restarted = runLauncher(["--no-open"], runtime);
    void restarted.catch(() => undefined);
    await waitUntil(() => children.length === 2 && output.filter((line) => line.includes("Runner running")).length === 2);
    await runLauncher(["stop"], runtime);
    await restarted;
  } finally {
    await Promise.all(children.map((child) => child.stop()));
    await Promise.allSettled([first, second, ...(restarted ? [restarted] : [])]);
    await f.cleanup();
  }
});

test("a verified unhealthy instance closes before its replacement starts", async () => {
  const f = await fixture();
  const children: FakeRunner[] = [];
  const calls: { command: string; args: string[]; options: SpawnOptions }[] = [];
  const output: string[] = [];
  const runtime = { cwd: f.project, spawnRunner: fakeSpawner(children, calls), write: (line: string) => output.push(line), openUrl: neverOpenBrowser };
  const first = runLauncher(["--state-dir", f.state], runtime);
  void first.catch(() => undefined);
  let replacement: Promise<void> | undefined;
  try {
    await waitUntil(() => output.some((line) => line.includes("Runner running")));
    assert.ok(interceptedBrowserOpens.some((url) => url.startsWith("https://aiboard.me/connect#pair=")), "start mode routes its pairing URL through the injected opener");
    children[0]!.healthy = false;
    replacement = runLauncher(["--state-dir", f.state], runtime);
    void replacement.catch(() => undefined);
    await waitUntil(() => children.length === 2 && output.filter((line) => line.includes("Runner running")).length === 2);
    assert.equal(children[0]!.stops, 1);
    assert.equal(children[1]!.stops, 0);
    await runLauncher(["stop", "--state-dir", f.state], runtime);
    await Promise.all([first, replacement]);
  } finally {
    await Promise.all(children.map((child) => child.stop()));
    await Promise.allSettled([first, ...(replacement ? [replacement] : [])]);
    await f.cleanup();
  }
});

test("remote pairing prompts and browser opening pass through launcher IPC", async () => {
  const f = await fixture();
  const children: FakeRunner[] = [];
  const calls: { command: string; args: string[]; options: SpawnOptions }[] = [];
  const output: string[] = [], opened: string[] = [];
  const baseSpawner = fakeSpawner(children, calls);
  const spawnRunner = (command: string, args: string[], options: SpawnOptions): ChildProcess => {
    const child = baseSpawner(command, args, options);
    const fake = children[children.length - 1]!;
    fake.beforeReady = () => {
      fake.emit("message", { type: "aiboard-remote-pairing", userCode: "BCDF-GHJK", verificationUri: "https://mcp.aiboard.me/pair",
        expiresAt: new Date(Date.now() + 600_000).toISOString(), deviceName: "Desktop" });
      fake.emit("message", { type: "aiboard-remote-open", url: "https://mcp.aiboard.me/pair" });
      fake.emit("message", { type: "aiboard-remote-session", deviceName: "Desktop", accountId: "account-1" });
      fake.emit("message", { type: "aiboard-remote-state", state: "tool-ready", reasonCode: "ready" });
    };
    return child;
  };
  const environment = process.platform === "win32" ? { LOCALAPPDATA: join(f.root, "data") } : { XDG_DATA_HOME: join(f.root, "data") };
  const runtime = { cwd: f.project, home: f.root, environment, spawnRunner, write: (line: string) => output.push(line), openUrl: (url: string) => opened.push(url) };
  const args = ["remote", "--state-dir", f.state, "--acknowledge-remote-access", "--relay-url", "wss://mcp.aiboard.me/connect"];
  const first = runLauncher(args, runtime);
  void first.catch(() => undefined);
  let second: Promise<void> | undefined;
  try {
    await waitUntil(() => output.some((line) => line.includes("Runner running")));
    assert.ok(output.some((line) => line.includes("open https://mcp.aiboard.me/pair and enter code BCDF-GHJK")));
    assert.ok(output.some((line) => line.includes("Desktop; account: account-1") && line.includes("Ctrl+C to disconnect")));
    assert.equal(opened[0], "https://mcp.aiboard.me/pair");
    assert.equal(opened[0]!.includes("BCDF"), false);
    // Live: a device revoked while running printed nothing; state changes after ready must still reach the terminal.
    children[0]!.emit("message", { type: "aiboard-remote-state", state: "disconnected", reasonCode: "socket_lost" });
    children[0]!.emit("message", { type: "aiboard-remote-state", state: "revoked", reasonCode: "device_key_revoked" });
    await waitUntil(() => output.some((line) => line.includes("removed from your AIBoard account")));
    assert.equal(output.filter((line) => line.includes("reconnecting...")).length, 1);
    assert.match(output.find((line) => line.includes("removed from your AIBoard account"))!, /^\[\d{2}:\d{2}:\d{2}\] AIBoard Remote: /u);
    await runLauncher(["stop", "--state-dir", f.state], runtime);
    await first;
    const before = opened.length;
    second = runLauncher([...args, "--no-open"], runtime);
    void second.catch(() => undefined);
    await waitUntil(() => children.length === 2 && output.filter((line) => line.includes("Runner running")).length === 2);
    assert.equal(opened.length, before);
    await runLauncher(["stop", "--state-dir", f.state], runtime);
    await second;
  } finally {
    await Promise.all(children.map((child) => child.stop()));
    await Promise.allSettled([first, ...(second ? [second] : [])]);
    await f.cleanup();
  }
});

test("a persisted revoke stops the Runner and starts it again to pair a new key, without opening the browser", async () => {
  const f = await fixture();
  const children: FakeRunner[] = [];
  const calls: { command: string; args: string[]; options: SpawnOptions }[] = [];
  const output: string[] = [], opened: string[] = [];
  const baseSpawner = fakeSpawner(children, calls);
  const spawnRunner = (command: string, args: string[], options: SpawnOptions): ChildProcess => {
    const child = baseSpawner(command, args, options);
    const fake = children[children.length - 1]!;
    fake.beforeReady = () => {
      fake.emit("message", { type: "aiboard-remote-open", url: "https://mcp.aiboard.me/pair" });
      fake.emit("message", { type: "aiboard-remote-state", state: "tool-ready", reasonCode: "ready" });
    };
    return child;
  };
  const environment = process.platform === "win32" ? { LOCALAPPDATA: join(f.root, "data") } : { XDG_DATA_HOME: join(f.root, "data") };
  const runtime = { cwd: f.project, home: f.root, environment, spawnRunner, write: (line: string) => output.push(line), openUrl: (url: string) => opened.push(url) };
  const args = ["remote", "--state-dir", f.state, "--acknowledge-remote-access", "--relay-url", "wss://mcp.aiboard.me/connect"];
  const first = runLauncher(args, runtime);
  void first.catch(() => undefined);
  try {
    await waitUntil(() => output.some((line) => line.includes("Runner running")));
    const openedByFirstRun = opened.length;
    assert.ok(openedByFirstRun >= 1);
    // Not on disk (e.g. an unverified frame): the off line, and no restart.
    children[0]!.emit("message", { type: "aiboard-remote-state", state: "revoked", reasonCode: "device_key_revoked", persisted: false });
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
    assert.equal(children.length, 1);
    assert.equal(children[0]!.stops, 0);
    children[0]!.emit("message", { type: "aiboard-remote-state", state: "revoked", reasonCode: "device_key_revoked", persisted: true });
    children[0]!.emit("message", { type: "aiboard-remote-state", state: "revoked", reasonCode: "device_key_revoked", persisted: true });
    await waitUntil(() => children.length === 2 && output.filter((line) => line.includes("Runner running")).length === 2);
    assert.equal(children[0]!.stops, 1);
    assert.equal(output.filter((line) => line.includes("pairing it again with a new key")).length, 1);
    assert.match(output.find((line) => line.includes("pairing it again with a new key"))!, /^\[\d{2}:\d{2}:\d{2}\] /u);
    assert.equal(opened.length, openedByFirstRun, "the restart runs with --no-open");
    await runLauncher(["stop", "--state-dir", f.state], runtime);
    await first;
    assert.equal(children.length, 2, "a clean stop after the restart does not restart again");
  } finally {
    // A failed assertion can land while a restart is still spawning; stop whatever exists, bounded, never hang.
    for (let round = 0; round < 3; round += 1) {
      await Promise.all(children.map((child) => child.stop()));
      await Promise.race([Promise.allSettled([first]), new Promise<void>((resolve) => setTimeout(resolve, 1_000))]);
    }
    await f.cleanup();
  }
});

test("aiboard remote turns Remote on inside a reused Runner, and Ctrl+C turns it off while the Runner keeps running", async () => {
  const f = await fixture();
  const children: FakeRunner[] = [];
  const calls: { command: string; args: string[]; options: SpawnOptions }[] = [];
  const output: string[] = [], opened: string[] = [];
  const environment = process.platform === "win32" ? { LOCALAPPDATA: join(f.root, "data") } : { XDG_DATA_HOME: join(f.root, "data") };
  const runtime = { cwd: f.project, home: f.root, environment, spawnRunner: fakeSpawner(children, calls), write: (line: string) => output.push(line), openUrl: (url: string) => opened.push(url) };
  const oldExitCode = process.exitCode;
  const plain = runLauncher(["--state-dir", f.state, "--no-open"], runtime);
  void plain.catch(() => undefined);
  const interrupt = new AbortController();
  let remote: Promise<void> | undefined;
  try {
    await waitUntil(() => output.some((line) => line.includes("Runner running")));
    const record = (await readInstance(f.state))!;
    const status = async () => {
      const key = await readControlKey(f.state);
      try { return await requestLauncherControl(record, key, "status"); } finally { key.fill(0); }
    };
    assert.equal((await status()).remoteActive, false);
    remote = runLauncher(["remote", "--state-dir", f.state, "--acknowledge-remote-access", "--relay-url", "wss://mcp.aiboard.me/connect"],
      { ...runtime, interrupt: interrupt.signal });
    void remote.catch(() => undefined);
    await waitUntil(() => output.some((line) => line.includes("open https://mcp.aiboard.me/pair and enter code BCDF-GHJK")));
    assert.equal(children.length, 1, "the running Runner is reused; no second Runner is spawned");
    assert.ok(output.some((line) => line.includes("Runner already running")));
    const fake = children[0]!.remote;
    assert.equal(fake.enables.length, 1);
    assert.deepEqual(fake.enables[0], {
      deviceDirectory: await realpath(remoteDeviceDirectory({ platform: process.platform, environment, home: f.root })),
      relayUrl: "wss://mcp.aiboard.me/connect", relayRootKeys: [],
    });
    assert.equal((await status()).remoteActive, true);
    await waitUntil(() => output.some((line) => line.includes("Desktop; account: account-1") && line.includes("Ctrl+C to disconnect")));
    assert.ok(opened.includes("https://mcp.aiboard.me/pair"));
    // The launcher keeps polling, which is what keeps an in-place Remote's lease alive.
    const polled = fake.polls;
    await waitUntil(() => fake.polls >= polled + 2);
    interrupt.abort();
    await remote;
    assert.equal(fake.disables, 1);
    assert.equal(fake.on, false);
    assert.equal(children[0]!.stops, 0, "Ctrl+C turns Remote off without stopping the Runner");
    assert.ok(output.some((line) => line.includes("Remote is off; the Runner keeps running")));
    const after = await status();
    assert.equal(after.healthy, true);
    assert.equal(after.remoteActive, false);
    await runLauncher(["stop", "--state-dir", f.state], runtime);
    await plain;
  } finally {
    interrupt.abort();
    await Promise.all(children.map((child) => child.stop()));
    await Promise.allSettled([plain, ...(remote ? [remote] : [])]);
    process.exitCode = oldExitCode;
    await f.cleanup();
  }
});

test("aiboard remote still refuses policy flags and remote-only mode for a reused Runner, saying what to run", async () => {
  const f = await fixture(); const g = await fixture();
  const children: FakeRunner[] = [];
  const calls: { command: string; args: string[]; options: SpawnOptions }[] = [];
  const output: string[] = [];
  const dataIn = (root: string) => process.platform === "win32" ? { LOCALAPPDATA: join(root, "data") } : { XDG_DATA_HOME: join(root, "data") };
  const spawnRunner = fakeSpawner(children, calls);
  const runtime = { cwd: f.project, home: f.root, environment: dataIn(f.root), spawnRunner, write: (line: string) => output.push(line), openUrl: neverOpenBrowser };
  // The per-user AIBoard data (device custody) inside the project, as when starting from the home folder: remote-only.
  const homeRuntime = { ...runtime, cwd: g.project, home: g.root, environment: dataIn(g.project) };
  const runs: Promise<void>[] = [];
  try {
    runs.push(runLauncher(["--state-dir", f.state, "--no-open"], runtime));
    await waitUntil(() => output.some((line) => line.includes("Runner running")));
    await assert.rejects(runLauncher(["remote", "--state-dir", f.state, "--acknowledge-remote-access", "--read-only", "--no-open"], runtime),
      /^Error: remote_policy_requires_restart: .*Run `aiboard stop --state-dir .+`, then run `aiboard remote --state-dir .+ --read-only --no-open` again\.$/);
    assert.equal(children[0]!.remote.enables.length, 0);
    // A Runner that is not remote-only cannot serve a folder that needs remote-only mode.
    runs.push(runLauncher(["--state-dir", g.state, "--no-open"], homeRuntime));
    await waitUntil(() => children.length === 2 && output.filter((line) => line.includes("Runner running")).length === 2);
    await assert.rejects(runLauncher(["remote", "--state-dir", g.state, "--acknowledge-remote-access", "--no-open"], homeRuntime),
      /^Error: remote_restart_required: .*Run `aiboard stop --state-dir .+`, then run `aiboard remote --state-dir .+` again\.$/);
    assert.equal(children[1]!.remote.enables.length, 0);
    assert.equal(children.length, 2);
    assert.ok(children.every((child) => child.stops === 0));
    await runLauncher(["stop", "--state-dir", f.state], runtime);
    await runLauncher(["stop", "--state-dir", g.state], homeRuntime);
    await Promise.all(runs);
  } finally {
    await Promise.all(children.map((child) => child.stop()));
    await Promise.allSettled(runs);
    await f.cleanup(); await g.cleanup();
  }
});

test("aiboard remote refuses while another project's Runner holds this device's Remote", async () => {
  const f = await fixture();
  const children: FakeRunner[] = [];
  const calls: { command: string; args: string[]; options: SpawnOptions }[] = [];
  const environment = process.platform === "win32" ? { LOCALAPPDATA: join(f.root, "data") } : { XDG_DATA_HOME: join(f.root, "data") };
  const runtime = { cwd: f.project, home: f.root, environment, spawnRunner: fakeSpawner(children, calls), write: () => undefined, openUrl: neverOpenBrowser };
  const device = remoteDeviceDirectory({ platform: process.platform, environment, home: f.root });
  await mkdir(device, { recursive: true, mode: 0o700 });
  const other = join(f.root, "other-project");
  const release = new RemoteDeviceStore(device).acquireOwnerLock(other);
  assert.ok(release);
  try {
    await assert.rejects(runLauncher(["remote", "--state-dir", f.state, "--acknowledge-remote-access", "--no-open"], runtime),
      (error: unknown) => error instanceof Error && error.message.startsWith("remote_already_active: ") && error.message.includes(other));
    assert.equal(children.length, 0);
  } finally {
    release();
    await Promise.all(children.map((child) => child.stop()));
    await f.cleanup();
  }
});

test("two projects have separate instances and stop only their own", async () => {
  const a = await fixture(); const b = await fixture();
  const children: FakeRunner[] = [];
  const calls: { command: string; args: string[]; options: SpawnOptions }[] = [];
  const spawnRunner = fakeSpawner(children, calls);
  const output: string[] = [];
  const runtimeA = { cwd: a.project, spawnRunner, write: (line: string) => output.push(line), openUrl: neverOpenBrowser };
  const runtimeB = { cwd: b.project, spawnRunner, write: (line: string) => output.push(line), openUrl: neverOpenBrowser };
  const first = runLauncher(["--state-dir", a.state], runtimeA);
  const second = runLauncher(["--state-dir", b.state], runtimeB);
  void first.catch(() => undefined); void second.catch(() => undefined);
  try {
    await waitUntil(() => output.filter((line) => line.includes("Runner running")).length === 2);
    assert.equal(children.length, 2);
    await runLauncher(["stop", "--state-dir", a.state], runtimeA);
    await first;
    const projectA = await realpath(a.project);
    assert.equal(children.find((child) => child.handshake?.identity.projectPath === projectA)?.stops, 1);
    await runLauncher(["status", "--state-dir", b.state], runtimeB);
    assert.match(output.at(-1)!, /Runner running/);
    await runLauncher(["stop", "--state-dir", b.state], runtimeB);
    await second;
  } finally {
    await Promise.all(children.map((child) => child.stop()));
    await Promise.allSettled([first, second]);
    await a.cleanup(); await b.cleanup();
  }
});

test("stop refuses foreign identity, pid reuse, stale records, and unauthenticated control", async () => {
  const f = await fixture();
  const children: FakeRunner[] = [];
  const calls: { command: string; args: string[]; options: SpawnOptions }[] = [];
  const output: string[] = [];
  const runtime = { cwd: f.project, spawnRunner: fakeSpawner(children, calls), write: (line: string) => output.push(line), openUrl: neverOpenBrowser };
  const running = runLauncher(["--state-dir", f.state], runtime);
  void running.catch(() => undefined);
  try {
    await waitUntil(() => output.some((line) => line.includes("Runner running")));
    const record = (await readInstance(f.state))!;
    const recordPath = join(f.state, "launcher-instance.json");
    for (const altered of [
      { ...record, owner: `${record.owner}-foreign` },
      { ...record, projectKey: `${record.projectKey}-other` },
      { ...record, projectPath: `${record.projectPath}-other` },
      { ...record, pid: record.pid + 1, startedAt: record.startedAt + 1 },
      { ...record, startedAt: record.startedAt + 1 },
    ]) {
      await writeFile(recordPath, JSON.stringify(altered));
      await assert.rejects(runLauncher(["stop", "--state-dir", f.state], runtime), /instance_(?:identity_mismatch|unverified)/);
      assert.equal(children[0]!.stops, 0);
    }
    await writeFile(recordPath, JSON.stringify(record));
    const lockIdentity = join(f.state, "launcher-lifetime.sqlite.identity");
    const originalLockIdentity = await readFile(lockIdentity, "utf8");
    await writeFile(lockIdentity, "changed");
    await assert.rejects(runLauncher(["stop", "--state-dir", f.state], runtime), /launcher_lock_unverified/);
    assert.equal(children[0]!.stops, 0);
    await writeFile(lockIdentity, originalLockIdentity);
    const key = await readControlKey(f.state);
    try {
      const wrongKey = Buffer.alloc(32, 7);
      await assert.rejects(requestLauncherControl(record, wrongKey, "stop"));
      await assert.rejects(requestLauncherControl({ ...record, startedAt: record.startedAt + 1 }, key, "stop"));
      assert.equal(children[0]!.stops, 0);
    } finally { key.fill(0); }
    await runLauncher(["stop", "--state-dir", f.state], runtime);
    await running;
    await writeFile(recordPath, JSON.stringify(record), { mode: 0o600 });
    await assert.rejects(runLauncher(["stop", "--state-dir", f.state], runtime), /instance_stale/);
    assert.equal(children[0]!.stops, 1);
  } finally {
    await Promise.all(children.map((child) => child.stop()));
    await Promise.allSettled([running]);
    await f.cleanup();
  }
});

test("existing advanced Runner options pass through", () => {
  const parsed = parseLauncherArguments(["--port", "0", "--mcp", "example=command", "--allow-origin", "https://aiboard.me", "--set-aside-run", "run-1"]);
  assert.deepEqual(parsed.runnerFlags, ["--port", "0", "--mcp", "example=command", "--allow-origin", "https://aiboard.me", "--set-aside-run", "run-1"]);
  assert.throws(() => parseLauncherArguments(["--token", "old-bearer-token"]), {
    message: "invalid_arguments: aiboard uses fresh state and does not accept --token; legacy users should use aiboard-runner-v2.",
  });
});

test("the legacy Runner command retains its flags", async () => {
  const output = await childOutput(spawn(process.execPath, [legacyBin, "--help"], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true }));
  assert.equal(output.code, 0);
  for (const flag of ["--project", "--state-dir", "--port", "--token", "--mcp", "--mcp-envelope", "--allow-origin", "--set-aside-run"]) assert.ok(output.stdout.includes(flag), flag);
});

test("real launcher reaches Runner health and stops through owned cleanup", async () => {
  const f = await fixture();
  const extensions = join(f.root, "extensions");
  const child = spawn(process.execPath, [bin, "runner", "--no-open", "--port", "0", "--state-dir", f.state, "--extensions-home", extensions], {
    cwd: f.project, stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
  });
  let stdout = ""; let stderr = "";
  let spawnError: Error | undefined;
  child.once("error", (error) => { spawnError = error; });
  child.stdout!.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
  child.stderr!.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
  const closed = childClose(child);
  void closed.catch(() => undefined);
  let uncertainCleanup = false;
  try {
    await waitUntil(() => stdout.includes("Runner running") || child.exitCode !== null || spawnError !== undefined, 30_000);
    assert.ifError(spawnError);
    assert.match(stdout, /Runner running[\s\S]*URL: http:\/\/127\.0\.0\.1:\d+/, stderr);
    assert.ok(stdout.includes(await realpath(f.project)));
    const status: string[] = [];
    await runLauncher(["status", "--state-dir", f.state], { cwd: f.project, write: (line) => status.push(line) });
    assert.match(status.join(""), /Runner running/);
    await runLauncher(["stop", "--state-dir", f.state], { cwd: f.project, write: () => undefined });
    assert.deepEqual(await closed, { code: 0, signal: null });
    assert.doesNotMatch(`${stdout}\n${stderr}`, /"token"\s*:/i);
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      try { await runLauncher(["stop", "--state-dir", f.state], { cwd: f.project, write: () => undefined }); }
      catch { if (child.pid !== undefined) { uncertainCleanup = true; child.kill("SIGINT"); } }
    }
    await closed.catch(() => undefined);
    if (uncertainCleanup) throw new Error(`Runner cleanup is unverified; fixture retained at ${f.root}.`);
    // If startup failed, retain the fixture unless the Runner lifetime lock is free.
    try {
      const release = tryAcquireLock(f.state, "lifetime");
      if (!release) throw new Error(`Runner cleanup is unverified; fixture retained at ${f.root}.`);
      release();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await f.cleanup();
  }
});

function childClose(child: ChildProcess): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
}

async function childOutput(child: ChildProcess): Promise<{ code: number | null; stdout: string; stderr: string }> {
  let stdout = ""; let stderr = "";
  child.stdout!.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
  child.stderr!.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
  const result = await childClose(child);
  return { code: result.code, stdout, stderr };
}

test("a Runner that exits before it is ready surfaces its own error, with launcher secrets redacted", async () => {
  const f = await fixture();
  const spawnRunner = (): ChildProcess => {
    const child = new FakeRunner();
    child.send = (message: unknown, callback?: (error: Error | null) => void) => {
      callback?.(null);
      const handshake = message as LauncherHandshake;
      if (handshake.type === "aiboard-launcher-init") {
        child.stderr.write(`{"error":"ExecutionHost state must remain outside the project root."} token=${handshake.token}\n`);
        setImmediate(() => { child.stdout.end(); child.stderr.end(); child.emit("close", 1, null); });
      }
      return true;
    };
    setImmediate(() => child.emit("message", { type: "aiboard-launcher-awaiting-init" }));
    return child as unknown as ChildProcess;
  };
  try {
    const failure = await runLauncher(["--state-dir", f.state, "--no-open"], { cwd: f.project, spawnRunner, write: () => undefined, openUrl: neverOpenBrowser })
      .then(() => undefined, (error: unknown) => error as Error);
    assert.ok(failure);
    assert.match(failure.message, /^runner_start_failed: Runner exited before it became ready\.\n.*ExecutionHost state must remain outside the project root/su);
    assert.match(failure.message, /token=\[redacted\]/u);
  } finally { await f.cleanup(); }
});

test("a plain start runs no selection; `aiboard runner` names Runner V2 alone", () => {
  assert.equal(parseLauncherArguments([]).defaultSelection, true);
  assert.equal(parseLauncherArguments(["--no-open"]).defaultSelection, true);
  assert.equal(parseLauncherArguments(["runner"]).defaultSelection, undefined);
  assert.equal(parseLauncherArguments(["accounts"]).defaultSelection, undefined);
});

/** Starts the real account runner as the launcher's peer, with its credentials file inside the fixture. */
function realAccountsPeer(authFile: string, spawned: RunnerKind[]) {
  return (kind: RunnerKind, command: string, args: string[], options: SpawnOptions): ChildProcess => {
    spawned.push(kind);
    return spawn(command, [...args, "--auth-file", authFile], options);
  };
}

test("a plain start also runs the account runner, announced by Runner V2 and stopped with it", async () => {
  const f = await fixture();
  const children: FakeRunner[] = [];
  const calls: { command: string; args: string[]; options: SpawnOptions }[] = [];
  const peers: RunnerKind[] = [];
  const output: string[] = [];
  const runtime = { cwd: f.project, spawnRunner: fakeSpawner(children, calls), spawnPeer: realAccountsPeer(join(f.root, "accounts.json"), peers),
    write: (line: string) => output.push(line), openUrl: neverOpenBrowser };
  const running = runLauncher(["--state-dir", f.state, "--no-open"], runtime);
  void running.catch(() => undefined);
  try {
    await waitUntil(() => output.join("").includes("Pairing code:"), 30_000);
    const text = output.join("");
    assert.deepEqual(peers, ["accounts"]);
    assert.match(text, /^Runner running\n/m);
    assert.match(text, /^Account runner running\n/m);
    const ports = /runners=([0-9,]+)/.exec(text)![1]!.split(",").map(Number);
    assert.equal(ports.length, 2);
    assert.deepEqual(children[0]!.handshake!.peers!.map((peer) => [peer.kind, peer.port]), [["accounts", ports[1]]]);
    const status: string[] = [];
    await runLauncher(["status", "--state-dir", f.state], { cwd: f.project, write: (line) => status.push(line) });
    assert.match(status.join(""), /Runner running[\s\S]*Account runner running/);
    await runLauncher(["stop", "--state-dir", f.state], { cwd: f.project, write: () => undefined });
    await running;
  } finally {
    await runLauncher(["stop", "--state-dir", f.state], { cwd: f.project, write: () => undefined }).catch(() => undefined);
    await Promise.all(children.map((child) => child.stop()));
    await running.catch(() => undefined);
    await f.cleanup();
  }
});

test("an implicit account runner that exits early leaves Runner V2 running with a warning", async () => {
  const f = await fixture();
  const children: FakeRunner[] = [];
  const calls: { command: string; args: string[]; options: SpawnOptions }[] = [];
  const output: string[] = [];
  const spawnPeer = (): ChildProcess => {
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(), stderr: new PassThrough(), connected: false, pid: 1, send: () => false, disconnect: () => undefined,
    });
    setImmediate(() => { child.stdout.end(); child.stderr.end(); child.emit("close", 1, null); });
    return child as unknown as ChildProcess;
  };
  const runtime = { cwd: f.project, spawnRunner: fakeSpawner(children, calls), spawnPeer, write: (line: string) => output.push(line), openUrl: neverOpenBrowser };
  const running = runLauncher(["--state-dir", f.state, "--no-open"], runtime);
  void running.catch(() => undefined);
  try {
    await waitUntil(() => output.join("").includes("Pairing code:"));
    const text = output.join("");
    assert.match(text, /Warning: The account runner did not start, so ChatGPT, GitHub Copilot and NVIDIA accounts are unavailable\./);
    assert.match(text, /^Runner running\n/m);
    assert.doesNotMatch(text, /Account runner running/);
    assert.match(text, /runners=\d+\n/);
    assert.deepEqual(children[0]!.handshake!.peers, []);
    await assert.rejects(readFile(join(f.state, "launcher-peers.json")), { code: "ENOENT" });
    assert.deepEqual((await readdir(f.state)).filter((name) => name.includes("accounts")), []);
    await runLauncher(["stop", "--state-dir", f.state], runtime);
    await running;
  } finally {
    await Promise.all(children.map((child) => child.stop()));
    await running.catch(() => undefined);
    await f.cleanup();
  }
});

test("a Runner without Git starts, and the launcher says how to install Git", async () => {
  const f = await fixture();
  const children: FakeRunner[] = [];
  const calls: { command: string; args: string[]; options: SpawnOptions }[] = [];
  const output: string[] = [];
  const spawnRunner = (command: string, args: string[], options: SpawnOptions): ChildProcess => {
    const child = fakeSpawner(children, calls)(command, args, options);
    children.at(-1)!.git = "git_missing";
    return child;
  };
  const runtime = { cwd: f.project, spawnRunner, platform: "win32" as const, write: (line: string) => output.push(line), openUrl: neverOpenBrowser };
  const running = runLauncher(["runner", "--state-dir", f.state, "--no-open"], runtime);
  void running.catch(() => undefined);
  try {
    await waitUntil(() => output.join("").includes("Pairing code:"));
    assert.match(output.join(""), /Runner running[\s\S]*Warning: Git was not found, so Build and ToolBench are off\. Chat and account providers still work\. Install Git for Windows from https:\/\/git-scm\.com\/download\/win/);
    await runLauncher(["stop", "--state-dir", f.state], runtime);
    await running;
  } finally {
    await Promise.all(children.map((child) => child.stop()));
    await running.catch(() => undefined);
    await f.cleanup();
  }
});

test("a start from the home folder asks for a project folder instead of a state directory", async () => {
  const f = await fixture();
  try {
    const home = await realpath(f.root);
    const environment = process.platform === "win32" ? { LOCALAPPDATA: join(home, "AppData", "Local") } : { XDG_DATA_HOME: join(home, ".local", "share") };
    const failure = await runLauncher(["--no-open"], { cwd: home, home, environment, write: () => undefined }).then(() => undefined, (error: unknown) => error as Error);
    assert.ok(failure);
    assert.match(failure.message, /^project_folder_required: aiboard was started in your home folder, which holds AI Board's own data\. Open a project folder first, for example:\n {2}cd "/);
    assert.doesNotMatch(failure.message, /--state-dir/);
    assert.deepEqual(await readdir(home), ["project"], "nothing was created");
    // A folder above the data root (not the home folder) gets the same advice, naming the folder.
    assert.throws(() => assertDefaultStateOutsideProject(f.root, join(f.root, "data", "AIBoard", "projects", "x"), join(f.root, "elsewhere"), process.platform),
      /^Error: project_folder_required: aiboard was started in .+, a folder that contains AI Board's own data\./);
    assert.doesNotThrow(() => assertDefaultStateOutsideProject(f.project, join(f.root, "data", "AIBoard", "projects", "x"), f.root, process.platform));
    // An explicit --state-dir inside the project keeps the original refusal.
    await assert.rejects(runLauncher(["--state-dir", join(f.project, "state")], { cwd: f.project, write: () => undefined }), /^Error: invalid_state_directory: .*--state-dir/);
  } finally { await f.cleanup(); }
});

test("launcher output is colored only when asked, and plain text is unchanged", async () => {
  const f = await fixture();
  const children: FakeRunner[] = [];
  const calls: { command: string; args: string[]; options: SpawnOptions }[] = [];
  const output: string[] = [];
  const runtime = { cwd: f.project, spawnRunner: fakeSpawner(children, calls), color: true, write: (line: string) => output.push(line), openUrl: neverOpenBrowser };
  const running = runLauncher(["runner", "--state-dir", f.state, "--no-open"], runtime);
  void running.catch(() => undefined);
  try {
    await waitUntil(() => output.join("").includes("Pairing code:"));
    const text = output.join("");
    assert.match(text, /\u001b\[32m\u001b\[1mRunner running\u001b\[22m\u001b\[39m/);
    assert.match(text, /\u001b\[36mhttps:\/\/aiboard\.me\/connect#pair=/);
    const plain: string[] = [];
    await runLauncher(["status", "--state-dir", f.state], { cwd: f.project, write: (line) => plain.push(line) });
    assert.match(plain.join(""), /^Runner running\nProject: /);
    assert.doesNotMatch(plain.join(""), /\u001b\[/);
    await runLauncher(["stop", "--state-dir", f.state], runtime);
    await running;
  } finally {
    await Promise.all(children.map((child) => child.stop()));
    await running.catch(() => undefined);
    await f.cleanup();
  }
});
