import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createPosixProcessBackend } from "../src/posix-process-backend.js";
import {
  parseProcessEmptyVerification,
  parseProcessLaunchResult,
  parseProcessReconciliation,
  type ProcessLaunchResult,
} from "../src/process-backend.js";
import type { NativeProcessOperations } from "../src/native-process-backend.js";

test("POSIX backend attests session ownership without claiming host-crash cleanup", async () => {
  const backend = createPosixProcessBackend();
  const probe = await backend.probe() as {
    backendId: string;
    platformLabel: string;
    capabilities: Record<string, string>;
  };
  assert.equal(probe.backendId, "runner-posix-process-group-v1");
  assert.equal(probe.platformLabel, "posix");
  assert.equal(probe.capabilities.tree_termination, "enforced");
  assert.equal(probe.capabilities.verified_emptiness, "enforced");
  assert.equal(probe.capabilities.crash_cleanup, "unavailable");
});

test("generic POSIX birth discovery keeps its one-second absolute envelope", { timeout: 5_000 }, async () => {
  const waiter = new Int32Array(new SharedArrayBuffer(4));
  let attempts = 0;
  const operations: NativeProcessOperations = {
    inspectProcessBirth: (_pid, _platform, attemptDeadlineMs = 1_000) => {
      attempts += 1;
      Atomics.wait(waiter, 0, 0, Math.min(600, attemptDeadlineMs));
      return { state: "unknown" };
    },
    listPosixGroup: () => [],
    signal: () => undefined,
  };
  const backend = createPosixProcessBackend({ operations, pollIntervalMs: 10 });
  const internal = backend as unknown as {
    waitForBirth(pid: number, startupDeadline: number): Promise<unknown>;
  };
  const started = Date.now();
  await internal.waitForBirth(2_147_483_646, started + 4_000);
  const elapsed = Date.now() - started;
  assert.ok(elapsed >= 900 && elapsed < 1_750, `POSIX birth discovery exceeded its one-second envelope: ${elapsed}ms`);
  assert.ok(attempts >= 2 && attempts <= 3, `unexpected POSIX birth attempt count: ${attempts}`);
});

test("POSIX native session fixture owns descendants after launcher exit", async (t) => {
  if (process.platform === "win32") {
    t.skip("POSIX session/process-group behavior requires a POSIX host.");
    return;
  }
  const backend = createPosixProcessBackend({ pollIntervalMs: 20 });
  const launch = parseProcessLaunchResult(await backend.launch(request([
    "-e",
    "const{spawn}=require('node:child_process');const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});console.log(c.pid);setTimeout(()=>process.exit(0),30)",
  ])));
  const binding = bindingFor(launch);
  try {
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.deepEqual(parseProcessReconciliation(await backend.reconcile(binding, fence)), { state: "running" });
    await backend.signal(binding, "terminate", fence);
    await new Promise((resolve) => setTimeout(resolve, 100));
    if (!parseProcessEmptyVerification(await backend.verifyEmpty(binding, fence)).empty)
      await backend.signal(binding, "force_terminate", fence);
    assert.equal(parseProcessEmptyVerification(await backend.verifyEmpty(binding, fence)).empty, true);
  } finally {
    await backend.signal(binding, "force_terminate", fence).catch(() => undefined);
    await backend.release(binding, fence).catch(() => undefined);
  }
});

test("POSIX contracts fail closed on enumeration errors and failed quiescence", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-posix-contract-"));
  const signals: Array<[number, NodeJS.Signals]> = [];
  let members: readonly number[] | undefined;
  const operations: NativeProcessOperations = {
    inspectProcessBirth: () => ({ state: "present", fingerprint: "supervisor-birth" }),
    listPosixGroup: () => members,
    signal: (pid, signal) => { signals.push([pid, signal]); },
  };
  const backend = createPosixProcessBackend({ stateDirectory: root, operations });
  const binding = portableBinding(root, "supervisor-birth");
  writeFileSync(join(root, "state.json"), JSON.stringify({
    protocol: "aiboard-portable-process/v1",
    nonce: "contract-nonce",
    supervisorPid: 9001,
    childPid: 9002,
    revision: 1,
    handledControl: 0,
    status: "running",
    exitCode: null,
    signal: null,
    knownProcesses: [],
    error: null,
    updatedAt: "2026-01-01T00:00:00.000Z",
  }));
  try {
    const unknown = parseProcessEmptyVerification(await backend.verifyEmpty(binding, fence));
    assert.equal(unknown.empty, false);
    assert.match(unknown.empty ? "" : unknown.detail, /enumerat|unknown|verify/i);
    await assert.rejects(backend.release(binding, fence), /verify|unknown|empty/i);

    members = [9001, 9002];
    assert.equal(parseProcessEmptyVerification(await backend.verifyEmpty(binding, fence)).empty, false);
    assert.deepEqual(parseProcessReconciliation(await backend.reconcile(binding, fence)), { state: "running" });

    await backend.signal(binding, "terminate", fence);
    await backend.signal(binding, "force_terminate", fence);
    assert.deepEqual(signals, [[-9001, "SIGTERM"], [-9001, "SIGKILL"]]);
  } finally {
    removeFixtureRoot(root);
  }
});

test("POSIX validates birth identity before any group signal", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-posix-identity-"));
  const signals: number[] = [];
  const operations: NativeProcessOperations = {
    inspectProcessBirth: () => ({ state: "present", fingerprint: "recycled-birth" }),
    listPosixGroup: () => [9001],
    signal: (pid) => { signals.push(pid); },
  };
  const backend = createPosixProcessBackend({ stateDirectory: root, operations });
  try {
    await assert.rejects(backend.signal(portableBinding(root, "owned-birth"), "terminate", fence), /identity/i);
    assert.deepEqual(signals, []);
  } finally {
    removeFixtureRoot(root);
  }
});

test("POSIX signal reaches the owned group after the supervisor exits", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-posix-dead-signal-"));
  const signals: Array<[number, NodeJS.Signals]> = [];
  let live = true;
  const backend = createPosixProcessBackend({ stateDirectory: root, operations: {
    inspectProcessBirth: () => ({ state: "absent" }),
    listPosixGroup: () => live ? [9002] : [],
    signal: (pid, signal) => { signals.push([pid, signal]); live = false; },
  } });
  try {
    assert.deepEqual(await backend.signal(portableBinding(root, "supervisor-birth"), "terminate", fence), { state: "exited" });
    assert.deepEqual(signals, [[-9001, "SIGTERM"]]);
  } finally { removeFixtureRoot(root); }
});

test("POSIX terminal proof permits fenced empty verification and release without Windows tree records", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-posix-terminal-contract-"));
  for (const path of ["channel/output", "channel/input", "channel/ack"]) mkdirSync(join(root, path), { recursive: true });
  writeFileSync(join(root, "state.json"), JSON.stringify({ protocol: "aiboard-portable-process/v1", nonce: "contract-nonce", supervisorPid: 9001, revision: 2, handledControl: 0, status: "stopped", exitCode: 0, signal: null, launchEffect: "started", rootProcess: null, knownProcesses: [], error: null }));
  writeFileSync(join(root, "channel/output-checkpoint.json"), JSON.stringify({ nonce: "contract-nonce", stdout: { sequence: 0, endOffset: 0 }, stderr: { sequence: 0, endOffset: 0 } }));
  const operations: NativeProcessOperations = { inspectProcessBirth: () => ({ state: "absent" }), listPosixGroup: () => [], signal: () => assert.fail("terminal contract must not signal") };
  const backend = createPosixProcessBackend({ stateDirectory: root, operations });
  const binding = portableBinding(root, "supervisor-birth");
  try {
    assert.equal(parseProcessEmptyVerification(await backend.verifyEmpty(binding, fence)).empty, true);
    assert.deepEqual(await backend.release(binding, fence), { released: true });
    assert.equal(existsSync(root), false);
  } finally { removeFixtureRoot(root); }
});

test("POSIX launch rollback kills the owned group and requires a stable empty discovery window", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-posix-launch-rollback-"));
  const signals: Array<[number, NodeJS.Signals]> = [];
  let signalled = false;
  let postSignalChecks = 0;
  const operations: NativeProcessOperations = {
    inspectProcessBirth: () => ({ state: "present", fingerprint: "supervisor-birth" }),
    listPosixGroup: () => {
      if (!signalled) return [9001, 9002];
      postSignalChecks += 1;
      return postSignalChecks === 2 ? [9002] : [];
    },
    signal: (pid, signal) => {
      signals.push([pid, signal]);
      signalled = true;
    },
  };
  const backend = createPosixProcessBackend({ stateDirectory: root, pollIntervalMs: 10, operations });
  const rollback = backend as unknown as {
    cleanupFailedLaunch(identity: {
      version: 1;
      backendId: string;
      nonce: string;
      directory: string;
      supervisorPid: number;
      supervisorBirth: string;
    }): Promise<void>;
  };
  try {
    await rollback.cleanupFailedLaunch({
      version: 1,
      backendId: "runner-posix-process-group-v1",
      nonce: "rollback-nonce",
      directory: root,
      supervisorPid: 9001,
      supervisorBirth: "supervisor-birth",
    });
    assert.deepEqual(signals, [[-9001, "SIGKILL"]]);
    assert.ok(postSignalChecks >= 10, `expected stable empty polling, observed ${postSignalChecks} checks`);
  } finally {
    removeFixtureRoot(root);
  }
});

test("POSIX launch rollback signals an identity-proven owned group after its supervisor exits", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-posix-dead-supervisor-"));
  const signals: Array<[number, NodeJS.Signals]> = [];
  let signalled = false;
  const operations: NativeProcessOperations = {
    inspectProcessBirth: () => ({ state: "absent" }),
    listPosixGroup: () => signalled ? [] : [9002],
    signal: (pid, signal) => {
      signals.push([pid, signal]);
      signalled = true;
    },
  };
  const backend = createPosixProcessBackend({ stateDirectory: root, pollIntervalMs: 10, operations });
  const rollback = backend as unknown as {
    cleanupFailedLaunch(identity: {
      version: 1;
      backendId: string;
      nonce: string;
      directory: string;
      supervisorPid: number;
      supervisorBirth: string;
    }): Promise<void>;
  };
  try {
    await rollback.cleanupFailedLaunch({
      version: 1,
      backendId: "runner-posix-process-group-v1",
      nonce: "rollback-nonce",
      directory: root,
      supervisorPid: 9001,
      supervisorBirth: "supervisor-birth",
    });
    assert.deepEqual(signals, [[-9001, "SIGKILL"]]);
  } finally {
    removeFixtureRoot(root);
  }
});

test("POSIX launch rollback rechecks the durable fence before signalling the owned group", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-posix-cleanup-fence-"));
  const original = { ownerId: "launch-owner", fencingToken: 1 } as const;
  let enumerations = 0; const signals: number[] = [];
  writeFileSync(join(root, "fence.json"), JSON.stringify({ nonce: "rollback-nonce", ...original }));
  const operations: NativeProcessOperations = {
    inspectProcessBirth: () => ({ state: "present", fingerprint: "supervisor-birth" }),
    listPosixGroup: () => {
      enumerations += 1;
      if (enumerations === 1) writeFileSync(join(root, "fence.json"), JSON.stringify({ nonce: "rollback-nonce", ownerId: "takeover", fencingToken: 2 }));
      return [9001];
    },
    signal: (pid) => { signals.push(pid); },
  };
  const backend = createPosixProcessBackend({ stateDirectory: root, operations });
  const rollback = backend as unknown as { cleanupFailedLaunch(identity: { version: 1; backendId: string; nonce: string; directory: string; supervisorPid: number; supervisorBirth: string; fence: typeof original }): Promise<void> };
  try {
    await assert.rejects(rollback.cleanupFailedLaunch({ version: 1, backendId: "runner-posix-process-group-v1", nonce: "rollback-nonce", directory: root, supervisorPid: 9001, supervisorBirth: "supervisor-birth", fence: original }), /fence|stale|identity/i);
    assert.deepEqual(signals, []);
  } finally { removeFixtureRoot(root); }
});

test("portable POSIX graceful control signals the exact owned process group", async () => {
  const { signalOwnedPosixGroup } = await import("../src/portable-process-posix-control.mjs");
  const effects: Array<[number, NodeJS.Signals]> = [];
  signalOwnedPosixGroup("terminate", (pid: number, signal: NodeJS.Signals) => { effects.push([pid, signal]); return true; }, 9001);
  signalOwnedPosixGroup("force_terminate", (pid: number, signal: NodeJS.Signals) => { effects.push([pid, signal]); return true; }, 9001);
  assert.deepEqual(effects, [[-9001, "SIGTERM"], [-9001, "SIGKILL"]]);
  const source = await import("node:fs").then(({ readFileSync }) => readFileSync(join(process.cwd(), "runner-v2", "src", "portable-process-supervisor.mjs"), "utf8"));
  assert.match(source, /withCurrentFenceEffect\(request\.ownerId, request\.fencingToken, \(\) => signalOwnedPosixGroup\(request\.action\)\)/);
  assert.match(source, /spawnSync\("ps", \["-e", "-o", "pid=,pgid="\], \{ encoding: "utf8", timeout: 2_000 \}\)/);
  const backendSource = await import("node:fs").then(({ readFileSync }) => readFileSync(join(process.cwd(), "runner-v2", "src", "native-process-backend.ts"), "utf8"));
  assert.match(backendSource, /execFileSync\("ps", \["-e", "-o", "pid=,pgid="\], \{ encoding: "utf8", timeout: 2_000 \}\)/);
});

const fence = { ownerId: "test-owner", fencingToken: 1 } as const;
function removeFixtureRoot(root: string): void {
  rmSync(root, { recursive: true, force: true, maxRetries: 30, retryDelay: 50 });
  rmSync(`${root}.fence.lock`, { force: true, maxRetries: 30, retryDelay: 50 });
  assert.equal(existsSync(root), false);
  assert.equal(existsSync(`${root}.fence.lock`), false);
}
function request(args: string[]) {
  return {
    intent: {
      invocationId: "posix-native",
      runId: "run",
      kind: "command" as const,
      executable: process.execPath,
      arguments: args,
      workingDirectory: process.cwd(),
      requestedCapabilities: ["tree_termination", "verified_emptiness"] as const,
    },
    grant: {
      grantId: "grant",
      runId: "run",
      invocationId: "posix-native",
      issuedAt: new Date().toISOString(),
      access: [],
    },
    environment: fixtureEnvironment(),
    outputOwnerId: "output",
    fence,
  };
}
function fixtureEnvironment(): Record<string, string> {
  const allowed = new Set(["systemroot", "windir", "comspec", "path", "pathext", "temp", "tmp"]);
  return Object.fromEntries(Object.entries(process.env).filter(([key, value]) => allowed.has(key.toLowerCase()) && value !== undefined)) as Record<string, string>;
}
function bindingFor(launch: ProcessLaunchResult) {
  return {
    registryId: "registry",
    backendId: "runner-posix-process-group-v1",
    implementationGeneration: "generation",
    implementationDigest: "1".repeat(64),
    attestationVersion: 1,
    attestationDigest: "2".repeat(64),
    ...launch,
  };
}

function portableBinding(directory: string, birth: string) {
  const identity = {
    version: 1,
    backendId: "runner-posix-process-group-v1",
    nonce: "contract-nonce",
    directory,
    supervisorPid: 9001,
    supervisorBirth: birth,
  };
  return bindingFor({
    opaqueIdentity: Buffer.from(JSON.stringify(identity)).toString("base64url"),
    birthFingerprint: {
      observedAt: "2026-01-01T00:00:00.000Z",
      discriminator: createHash("sha256").update(`contract-nonce\0${birth}`).digest("hex"),
    },
    rootPid: 9001,
    startedAt: "2026-01-01T00:00:00.000Z",
  });
}
