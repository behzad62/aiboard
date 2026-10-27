import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { ControlServer } from "../src/control-server.js";
import type { GitPreflightResult } from "../src/git-preflight.js";
import { parseLauncherArguments, runLauncher } from "../src/launcher.js";
import { createLocalPairTicket, LocalPairing } from "../src/local-pairing.js";
import { RunSupervisor } from "../src/run-supervisor.js";
import { SqliteEventStore } from "../src/sqlite-event-store.js";

interface SharedPairModule {
  createLocalPairTicket(instanceId: string): { code: string; digest: string };
}
// The shared pairing module is a zero-dependency standalone .mjs download with
// no type declarations; SharedPairModule pins the shape this test relies on.
// @ts-expect-error -- untyped standalone module
const shared = (await import("../../scripts/local-pair-runner.mjs")) as unknown as SharedPairModule;

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const ACCOUNT_SCRIPT = join(repoRoot, "lib", "account-provider-runner.mjs");
const LEGACY_SCRIPT = join(repoRoot, "scripts", "runner.mjs");
const BENCH_SCRIPT = join(repoRoot, "scripts", "bench-runner.mjs");
const INSTANCE = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const gitReady: GitPreflightResult = { available: true, version: "2.45.1", code: "git_ready", reason: null };

interface RawResponse { status: number; headers: IncomingMessage["headers"]; text: string }

function raw(port: number, options: {
  method?: string; path?: string; headers?: Record<string, string>; body?: string;
}): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({
      hostname: "127.0.0.1", port, path: options.path ?? "/v1/local-pair/exchange",
      method: options.method ?? "POST", setHost: false,
    }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => { text += chunk; });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, text }));
    });
    req.on("error", reject);
    const headers = options.headers ?? {};
    for (const [name, value] of Object.entries(headers)) req.setHeader(name, value);
    if (!Object.keys(headers).some((name) => name.toLowerCase() === "host")) req.setHeader("Host", `127.0.0.1:${port}`);
    if (options.body !== undefined) req.write(options.body);
    req.end();
  });
}

function exchangeHeaders(port: number, overrides: Record<string, string> = {}): Record<string, string> {
  return {
    Host: `127.0.0.1:${port}`, Origin: "https://aiboard.me",
    "Content-Type": "application/json", "X-AIBoard-Pair-Version": "1", ...overrides,
  };
}

function assertRefused(res: RawResponse, secret?: string): void {
  assert.equal(res.status, 400, res.text);
  const body = JSON.parse(res.text) as Record<string, unknown>;
  assert.equal(body.code, "local_pair_refused");
  assert.equal("sessionToken" in body, false);
  if (secret) assert.equal(res.text.includes(secret), false);
}

async function freePort(): Promise<number> {
  const server = createNetServer();
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => resolve()); });
  const address = server.address();
  const port = address && typeof address !== "string" ? address.port : 0;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  assert.ok(port > 0);
  return port;
}

interface PairChild {
  child: ChildProcess;
  args: string[];
  instanceId: string;
  ticket: { code: string; digest: string };
  controlKey: string;
  instance: { kind: string; port: number; controlPort: number };
  output(): string;
}

async function startPairChild(input: {
  kind: "accounts" | "legacy" | "bench";
  args: string[];
  peers?: Array<{ instanceId: string; kind: string; port: number; code: string }>;
}): Promise<PairChild> {
  const instanceId = randomBytes(16).toString("hex");
  const ticket = shared.createLocalPairTicket(instanceId);
  const controlKey = randomBytes(32).toString("hex");
  const child = spawn(process.execPath, input.args, { stdio: ["ignore", "pipe", "pipe", "ipc"], windowsHide: true });
  let output = "";
  child.stdout?.on("data", (chunk: Buffer) => { output += chunk.toString("utf8"); });
  child.stderr?.on("data", (chunk: Buffer) => { output += chunk.toString("utf8"); });
  const instance = await new Promise<{ kind: string; port: number; controlPort: number }>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`pair child ${input.kind} did not become ready: ${output.slice(-500)}`)), 30_000);
    let sent = false;
    child.on("message", (message: unknown) => {
      if (typeof message !== "object" || message === null || !("type" in message)) return;
      if (message.type === "aiboard-local-pair-awaiting-init" && !sent) {
        sent = true;
        child.send({
          type: "aiboard-local-pair-init", kind: input.kind, instanceId, pairDigest: ticket.digest,
          peers: input.peers ?? [], controlKey,
          identity: { projectPath: process.cwd(), projectKey: process.cwd().toLowerCase(), owner: "test-owner" },
          version: "test", startedAt: Date.now(),
        });
        return;
      }
      if (message.type === "aiboard-local-pair-ready" && "instance" in message) {
        clearTimeout(timer);
        resolve(message.instance as PairChild["instance"]);
      }
    });
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("exit", (code) => { clearTimeout(timer); reject(new Error(`pair child ${input.kind} exited (${code}): ${output.slice(-500)}`)); });
  });
  if (/Token\s*:\s*\S{16,}/.test(output)) {
    child.kill();
    assert.fail(`${input.kind} printed its reusable token while launcher-started`);
  }
  return { child, args: input.args, instanceId, ticket, controlKey, instance, output: () => output };
}

async function stopPairChild(pair: PairChild): Promise<void> {
  if (pair.child.exitCode !== null || pair.child.signalCode !== null) return;
  const closed = new Promise<void>((resolve) => pair.child.once("close", () => resolve()));
  if (pair.child.connected) pair.child.send({ type: "aiboard-launcher-stop" });
  await Promise.race([closed, new Promise((resolve) => setTimeout(resolve, 5_000))]);
  if (pair.child.exitCode === null && pair.child.signalCode === null) pair.child.kill();
  await closed.catch(() => undefined);
}

async function exchange(port: number, code: string, headers?: Record<string, string>): Promise<RawResponse> {
  return raw(port, { headers: headers ?? exchangeHeaders(port), body: JSON.stringify({ version: 1, code }) });
}

test("CLI selection parses singles, any-order combinations and all; duplicates are refused", () => {
  assert.deepEqual(parseLauncherArguments([]).runners, ["runner"]);
  assert.deepEqual(parseLauncherArguments(["accounts"]).runners, ["accounts"]);
  assert.deepEqual(parseLauncherArguments(["legacy"]).runners, ["legacy"]);
  assert.deepEqual(parseLauncherArguments(["bench"]).runners, ["bench"]);
  assert.deepEqual(parseLauncherArguments(["runner", "accounts"]).runners, ["runner", "accounts"]);
  assert.deepEqual(parseLauncherArguments(["bench", "legacy", "accounts"]).runners, ["bench", "legacy", "accounts"]);
  assert.deepEqual(parseLauncherArguments(["all"]).runners, ["runner", "accounts", "legacy", "bench"]);
  assert.throws(() => parseLauncherArguments(["accounts", "accounts"]), /Duplicate runner/);
  assert.throws(() => parseLauncherArguments(["all", "bench"]), /Duplicate runner/);
  assert.throws(() => parseLauncherArguments(["accounts", "runner", "accounts"]), /Duplicate runner/);
  assert.equal(parseLauncherArguments(["status"]).command, "status");
  assert.equal(parseLauncherArguments(["stop"]).command, "stop");
});

test("Runner V2 anchor exchange lists distinct peer tickets and sessions stay per-runner", async () => {
  const directory = mkdtempSync(join(tmpdir(), "aiboard-combined-"));
  const supervisor = new RunSupervisor(new SqliteEventStore(join(directory, "events.sqlite")));
  const pairing = new LocalPairing(INSTANCE);
  const server = new ControlServer({
    supervisor, token: "test-control-token", checkGit: async () => gitReady,
    bootstrapRun: async () => ({ baselineRevision: "a".repeat(40), baselineRef: "refs/aiboard/runs/test/baseline" }),
    runnerInfo: { projectPath: directory, nodeVersion: process.versions.node },
    localPairing: pairing,
  });
  const address = await server.start(0);
  try {
    const anchor = createLocalPairTicket(INSTANCE);
    pairing.register(anchor.digest);
    const peerA = createLocalPairTicket("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
    const peerB = createLocalPairTicket("cccccccccccccccccccccccccccccccc");
    pairing.setPeers([
      { instanceId: peerA.code.split(".")[1]!, kind: "accounts", port: address.port + 1, code: peerA.code },
      { instanceId: peerB.code.split(".")[1]!, kind: "bench", port: address.port + 2, code: peerB.code },
    ]);
    const res = await exchange(address.port, anchor.code);
    assert.equal(res.status, 200, res.text);
    const body = JSON.parse(res.text) as { kind: string; sessionToken: string; peers: Array<{ kind: string; code: string; instanceId: string }> };
    assert.equal(body.kind, "runner");
    assert.deepEqual(body.peers.map((peer) => peer.kind), ["accounts", "bench"]);
    assert.notEqual(body.peers[0]!.code, anchor.code);
    assert.notEqual(body.peers[0]!.code, body.peers[1]!.code);
    assert.equal(body.peers[0]!.instanceId, "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
    // The anchor session authenticates V2 routes; a peer ticket does not.
    const health = await raw(address.port, {
      method: "GET", path: "/v2/health",
      headers: { Host: `127.0.0.1:${address.port}`, Authorization: `Bearer ${body.sessionToken}` },
    });
    assert.equal(health.status, 200, health.text);
    const peerAsSession = await raw(address.port, {
      method: "GET", path: "/v2/health",
      headers: { Host: `127.0.0.1:${address.port}`, Authorization: `Bearer ${peerA.code}` },
    });
    assert.equal(peerAsSession.status, 401);
    assertRefused(await exchange(address.port, anchor.code), anchor.code);
  } finally {
    await server.close();
    supervisor.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("accounts, legacy and bench runners pair over IPC, keep sessions separate and refuse replays", async () => {
  const root = await mkdtemp(join(tmpdir(), "aiboard-combined-runners-"));
  const project = join(root, "project");
  await mkdir(project);
  const authFile = join(root, "accounts-auth.json");
  const children: PairChild[] = [];
  const sessions = new Map<string, string>();
  const ports = new Map<string, number>();
  try {
    const specs = [
      { kind: "accounts" as const, script: [ACCOUNT_SCRIPT, "--port", String(await freePort()), "--host", "127.0.0.1", "--auth-file", authFile] },
      { kind: "legacy" as const, script: [LEGACY_SCRIPT, project, "--port", String(await freePort()), "--host", "127.0.0.1"] },
      { kind: "bench" as const, script: [BENCH_SCRIPT, "--port", String(await freePort()), "--host", "127.0.0.1", "--root", join(root, "bench-runs")] },
    ];
    for (const spec of specs) {
      const pair = await startPairChild({ kind: spec.kind, args: spec.script });
      children.push(pair);
      ports.set(spec.kind, pair.instance.port);
      // No secret travels in the child argv.
      for (const secret of [pair.ticket.code, pair.ticket.digest, pair.controlKey]) {
        assert.equal(pair.args.some((arg) => arg.includes(secret)), false, `${spec.kind} argv must not contain a pairing secret`);
      }
      // Wrong Origin / Host are refused before the code is consumed, on every kind.
      const body = JSON.stringify({ version: 1, code: pair.ticket.code });
      assertRefused(await raw(pair.instance.port, { headers: exchangeHeaders(pair.instance.port, { Origin: "https://evil.example" }), body }), pair.ticket.code);
      assertRefused(await raw(pair.instance.port, { headers: exchangeHeaders(pair.instance.port, { Host: "127.0.0.1:1" }), body }), pair.ticket.code);
      assertRefused(await raw(pair.instance.port, { headers: exchangeHeaders(pair.instance.port, { Origin: "null" }), body }), pair.ticket.code);
      const res = await exchange(pair.instance.port, pair.ticket.code);
      assert.equal(res.status, 200, `${spec.kind}: ${res.text}`);
      const exchanged = JSON.parse(res.text) as { kind: string; instanceId: string; port: number; sessionToken: string; peers: unknown[] };
      assert.equal(exchanged.kind, spec.kind);
      assert.equal(exchanged.instanceId, pair.instanceId);
      assert.equal(exchanged.port, pair.instance.port);
      assert.deepEqual(exchanged.peers, []);
      sessions.set(spec.kind, exchanged.sessionToken);
      // Replayed ticket is refused without a new session.
      assertRefused(await exchange(pair.instance.port, pair.ticket.code), pair.ticket.code);
    }

    const probes: Record<string, { path: string; ok: number }> = {
      accounts: { path: "/providers/chatgpt/status", ok: 200 },
      legacy: { path: "/health", ok: 200 },
      bench: { path: "/bench/health", ok: 200 },
    };
    for (const [kind, probe] of Object.entries(probes)) {
      const port = ports.get(kind)!;
      const own = await raw(port, { method: "GET", path: probe.path, headers: { Host: `127.0.0.1:${port}`, "x-runner-token": sessions.get(kind)! } });
      assert.equal(own.status, probe.ok, `${kind} must accept its own session: ${own.text}`);
      for (const [otherKind, otherToken] of sessions) {
        if (otherKind === kind) continue;
        const cross = await raw(port, { method: "GET", path: probe.path, headers: { Host: `127.0.0.1:${port}`, "x-runner-token": otherToken } });
        assert.equal(cross.status, 401, `${kind} must not accept the ${otherKind} session`);
      }
    }

    // Account identity survives a restart: the persisted runner token still
    // authorizes, while the old pairing session is gone with its process.
    const accountsPair = children.find((pair) => pair.instance.kind === "accounts")!;
    const persisted = JSON.parse(readFileSync(authFile, "utf8")) as { runnerToken?: string };
    assert.match(persisted.runnerToken ?? "", /^[0-9a-f]{32}$/);
    const oldSession = sessions.get("accounts")!;
    await stopPairChild(accountsPair);
    const restarted = await startPairChild({
      kind: "accounts",
      args: [ACCOUNT_SCRIPT, "--port", String(ports.get("accounts")), "--host", "127.0.0.1", "--auth-file", authFile],
    });
    children.push(restarted);
    const withPersisted = await raw(restarted.instance.port, {
      method: "GET", path: "/providers/chatgpt/status",
      headers: { Host: `127.0.0.1:${restarted.instance.port}`, "x-runner-token": persisted.runnerToken! },
    });
    assert.equal(withPersisted.status, 200, withPersisted.text);
    const withOldSession = await raw(restarted.instance.port, {
      method: "GET", path: "/providers/chatgpt/status",
      headers: { Host: `127.0.0.1:${restarted.instance.port}`, "x-runner-token": oldSession },
    });
    assert.equal(withOldSession.status, 401);
    // Revoked sessions stop working on the issuing runner.
    const fresh = await exchange(restarted.instance.port, restarted.ticket.code);
    assert.equal(fresh.status, 200, fresh.text);
    const freshToken = (JSON.parse(fresh.text) as { sessionToken: string }).sessionToken;
    const revoke = await raw(restarted.instance.port, {
      method: "DELETE", path: "/v1/local-pair/session",
      headers: { Host: `127.0.0.1:${restarted.instance.port}`, Origin: "https://aiboard.me", Authorization: `Bearer ${freshToken}` },
    });
    assert.equal(revoke.status, 200, revoke.text);
    const afterRevoke = await raw(restarted.instance.port, {
      method: "GET", path: "/providers/chatgpt/status",
      headers: { Host: `127.0.0.1:${restarted.instance.port}`, "x-runner-token": freshToken },
    });
    assert.equal(afterRevoke.status, 401);
  } finally {
    for (const pair of children) await stopPairChild(pair);
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});

test("standalone runners without launcher IPC refuse pairing and keep their existing auth", async () => {
  const root = await mkdtemp(join(tmpdir(), "aiboard-standalone-"));
  try {
    const port = await freePort();
    const child = spawn(process.execPath, [ACCOUNT_SCRIPT, "--port", String(port), "--host", "127.0.0.1", "--auth-file", join(root, "auth.json")], {
      stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
    });
    try {
      let up = false;
      for (let attempt = 0; attempt < 50 && !up; attempt += 1) {
        up = await raw(port, { method: "GET", path: "/health" }).then((res) => res.status === 200).catch(() => false);
        if (!up) await new Promise((resolve) => setTimeout(resolve, 100));
      }
      assert.equal(up, true);
      const code = shared.createLocalPairTicket("dddddddddddddddddddddddddddddddd").code;
      assertRefused(await exchange(port, code), code);
      // Standalone CORS keeps the previous wildcard fallback for unknown origins.
      const health = await raw(port, { method: "GET", path: "/health", headers: { Host: `127.0.0.1:${port}`, Origin: "https://evil.example" } });
      assert.equal(health.headers["access-control-allow-origin"], "*");
    } finally {
      child.kill();
    }
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});

test("bench Runner V2 children receive their token over IPC, never argv; no peer is relay-dispatched", () => {
  const benchSource = readFileSync(BENCH_SCRIPT, "utf8");
  assert.equal(/"--token",\s*runnerToken/.test(benchSource), false);
  assert.ok(benchSource.includes('"--launcher-ipc"'));
  const launcherSource = readFileSync(join(repoRoot, "runner-v2", "src", "launcher.ts"), "utf8");
  const spawnSection = launcherSource.slice(launcherSource.indexOf("function peerSpawnArguments"), launcherSource.indexOf("function spawnPeerRunner"));
  assert.equal(/ticket|controlKey|sessionToken/.test(spawnSection), false);
  for (const script of [ACCOUNT_SCRIPT, LEGACY_SCRIPT, BENCH_SCRIPT]) {
    const source = readFileSync(script, "utf8");
    assert.equal(/relay|aiboard-tunnel/i.test(source), false, `${script} must not dispatch through a relay`);
  }
  const panel = readFileSync(join(repoRoot, "scripts", "runner-panel.html"), "utf8");
  assert.equal(panel.includes("token="), false, "the legacy panel must not accept a bearer token from the fragment");
});

test("launcher pairs legacy+bench in one tab, reports status and stops every runner", async () => {
  const root = await mkdtemp(join(tmpdir(), "aiboard-combined-launcher-"));
  const project = join(root, "project");
  const state = join(root, "state");
  await mkdir(project);
  const output: string[] = [];
  const runtime = { cwd: project, write: (text: string) => output.push(text) };
  const running = runLauncher(["legacy", "bench", "--state-dir", state, "--no-open"], runtime);
  void running.catch(() => undefined);
  try {
    const deadline = Date.now() + 60_000;
    while (!output.join("").includes("Pairing code:") && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const text = output.join("");
    const codeMatch = /Pairing code: (\S+)/.exec(text);
    const portsMatch = /runners=([0-9,]+)/.exec(text);
    assert.ok(codeMatch && portsMatch, text);
    const ports = portsMatch[1]!.split(",").map(Number);
    assert.equal(ports.length, 2);
    assert.equal(new Set(ports).size, 2);
    // The first listed runner (legacy) is the anchor; its session and the bench peer both pair.
    const anchor = await exchange(ports[0]!, codeMatch[1]!);
    assert.equal(anchor.status, 200, anchor.text);
    const anchorBody = JSON.parse(anchor.text) as { kind: string; peers: Array<{ kind: string; port: number; code: string; instanceId: string }> };
    assert.equal(anchorBody.kind, "legacy");
    assert.equal(anchorBody.peers.length, 1);
    assert.equal(anchorBody.peers[0]!.kind, "bench");
    assert.ok(ports.includes(anchorBody.peers[0]!.port));
    const peer = await exchange(anchorBody.peers[0]!.port, anchorBody.peers[0]!.code);
    assert.equal(peer.status, 200, peer.text);
    const peerBody = JSON.parse(peer.text) as { kind: string; peers: unknown[]; sessionToken: string };
    assert.equal(peerBody.kind, "bench");
    assert.deepEqual(peerBody.peers, []);
    // Records on disk hold no session token or ticket code.
    const records = readFileSync(join(state, "launcher-peers.json"), "utf8");
    assert.equal(records.includes(peerBody.sessionToken), false);
    assert.equal(records.includes(anchorBody.peers[0]!.code), false);
    const status: string[] = [];
    await runLauncher(["status", "--state-dir", state], { cwd: project, write: (line) => status.push(line) });
    assert.match(status.join(""), /Runner running/);
    await runLauncher(["stop", "--state-dir", state], { cwd: project, write: () => undefined });
    await running;
    const afterStop = await raw(ports[0]!, { method: "GET", path: "/health" }).catch(() => null);
    assert.equal(afterStop, null);
  } finally {
    await runLauncher(["stop", "--state-dir", state], { cwd: project, write: () => undefined }).catch(() => undefined);
    await running.catch(() => undefined);
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});
