import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createWindowsProcessBackend,
  WindowsJobObjectProcessBackend,
  type WindowsJobProcessService,
} from "../src/windows-process-backend.js";
import { ManagedProcessService } from "../src/managed-process.js";
import { NativeProcessLaunchBlockedError, type NativeProcessOperations } from "../src/native-process-backend.js";
import {
  parseProcessEmptyVerification,
  parseProcessLaunchResult,
  parseProcessReconciliation,
  parseProcessSignalResult,
  type ProcessLaunchResult,
} from "../src/process-backend.js";

test("Windows portable baseline is selectable without Job Objects and reports crash cleanup honestly", async () => {
  const backend = createWindowsProcessBackend({ jobObjects: "unavailable" });
  const probe = await backend.probe() as {
    backendId: string;
    platformLabel: string;
    capabilities: Record<string, string>;
  };
  assert.equal(probe.backendId, "runner-windows-supervisor-v1");
  assert.equal(probe.platformLabel, "windows");
  assert.equal(probe.capabilities.tree_termination, "partial");
  assert.equal(probe.capabilities.verified_emptiness, "partial");
  assert.equal(probe.capabilities.crash_cleanup, "unavailable");
});

test("Windows reconciliation distinguishes missing opaque identity from a birth mismatch", async () => {
  const backend = createWindowsProcessBackend({ jobObjects: "unavailable" });
  const missing = bindingFor({
    opaqueIdentity: "not-an-identity",
    birthFingerprint: { observedAt: "x", discriminator: "x" },
    startedAt: "x",
  });
  assert.deepEqual(await backend.reconcile(missing, fence), { state: "outcome_unknown" });
  const encoded = Buffer.from(JSON.stringify({
    version: 1,
    backendId: "runner-windows-supervisor-v1",
    nonce: "nonce",
    directory: process.cwd(),
    supervisorPid: process.pid,
    supervisorBirth: "recycled-birth",
  })).toString("base64url");
  const mismatch = bindingFor({
    opaqueIdentity: encoded,
    birthFingerprint: { observedAt: "x", discriminator: "0".repeat(64) },
    rootPid: process.pid,
    startedAt: "x",
  });
  assert.deepEqual(await backend.reconcile(mismatch, fence), { state: "identity_mismatch" });
});

test("Windows portable ownership rejects a recycled descendant before control is written", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-windows-identity-contract-"));
  const operations: NativeProcessOperations = {
    inspectProcessBirth: (pid) => ({ state: "present", fingerprint: pid === 9001 ? "supervisor-birth" : "recycled-birth" }),
    listPosixGroup: () => undefined,
    signal: () => undefined,
  };
  const backend = createWindowsProcessBackend({ stateDirectory: root, operations });
  const stateDirectory = join(root, "identity");
  mkdirSync(stateDirectory);
  writeFileSync(join(stateDirectory, "state.json"), JSON.stringify({
    protocol: "aiboard-portable-process/v1",
    nonce: "windows-contract-nonce",
    supervisorPid: 9001,
    childPid: 9002,
    revision: 1,
    handledControl: 0,
    status: "running",
    exitCode: null,
    signal: null,
    launchEffect: "started",
    rootProcess: { pid: 9002, birth: "owned-descendant-birth" },
    knownProcesses: [{ pid: 9002, birth: "owned-descendant-birth" }],
    error: null,
    updatedAt: "2026-01-01T00:00:00.000Z",
  }));
  const binding = portableWindowsBinding(stateDirectory, "supervisor-birth");
  try {
    assert.deepEqual(parseProcessReconciliation(await backend.reconcile(binding, fence)), { state: "identity_mismatch" });
    await assert.rejects(backend.signal(binding, "force_terminate", fence), /identity/i);
    assert.equal(existsSync(join(stateDirectory, "control.json")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Windows birth inspection failure is unknown and cannot prove empty, release, or signal", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-windows-inspection-unknown-"));
  const operations: NativeProcessOperations = {
    inspectProcessBirth: (pid) => pid === 9001
      ? { state: "present", fingerprint: "supervisor-birth" }
      : { state: "unknown" },
    listPosixGroup: () => undefined,
    signal: () => undefined,
  };
  const backend = createWindowsProcessBackend({ stateDirectory: root, operations });
  const stateDirectory = join(root, "identity");
  mkdirSync(stateDirectory);
  writePortableState(stateDirectory, {
    launchEffect: "started",
    rootProcess: { pid: 9002, birth: "owned-descendant-birth" },
    knownProcesses: [{ pid: 9002, birth: "owned-descendant-birth" }],
  });
  const binding = portableWindowsBinding(stateDirectory, "supervisor-birth");
  try {
    assert.deepEqual(parseProcessReconciliation(await backend.reconcile(binding, fence)), { state: "outcome_unknown" });
    assert.equal(parseProcessEmptyVerification(await backend.verifyEmpty(binding, fence)).empty, false);
    await assert.rejects(backend.release(binding, fence), /unknown|verify|empty/i);
    await assert.rejects(backend.signal(binding, "force_terminate", fence), /unknown|unavailable|inspect/i);
    assert.equal(existsSync(join(stateDirectory, "control.json")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Windows supervisor treats unavailable CIM inspection as unknown and ignores destructive control", async (t) => {
  if (process.platform !== "win32") {
    t.skip("Windows CIM failure fixture requires a Windows host.");
    return;
  }
  const root = mkdtempSync(join(tmpdir(), "aiboard-windows-cim-unknown-"));
  const directory = join(root, "owned-query-failure");
  mkdirSync(directory);
  const supervisor = join(process.cwd(), "runner-v2", "src", "portable-process-supervisor.mjs");
  const nonce = "cim-query-failure";
  const encoded = Buffer.from(JSON.stringify({
    nonce,
    directory,
    executable: process.execPath,
    arguments: ["-e", "setInterval(()=>{},1000)"],
    workingDirectory: process.cwd(),
    environment: { ...process.env },
    platform: "windows",
    pollIntervalMs: 20,
  })).toString("base64url");
  const child = spawn(process.execPath, [supervisor, encoded], {
    env: { ...process.env, Path: root, PATH: root },
    stdio: "ignore",
    windowsHide: true,
  });
  assert.ok(child.pid);
  try {
    const state = await waitForPortableState(directory, (value) => value.status === "outcome_unknown");
    assert.equal(state.launchEffect, "unknown");
    assert.equal(state.rootProcess, null);
    assert.deepEqual(state.knownProcesses, []);
    writeFileSync(join(directory, "control.json"), JSON.stringify({ revision: 1, action: "force_terminate" }));
    await new Promise((resolve) => setTimeout(resolve, 100));
    const afterControl = await waitForPortableState(directory, () => true);
    assert.equal(afterControl.handledControl, 0);
    assert.equal(afterControl.status, "outcome_unknown");
  } finally {
    try { execFileSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" }); } catch {}
    rmSync(root, { recursive: true, force: true });
  }
});

test("Windows state with a bare initial child PID is unknown and never traverses a recycled process", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-windows-bare-child-"));
  const inspected: number[] = [];
  const operations: NativeProcessOperations = {
    inspectProcessBirth: (pid) => {
      inspected.push(pid);
      return { state: "present", fingerprint: pid === 9001 ? "supervisor-birth" : "recycled-child-birth" };
    },
    listPosixGroup: () => undefined,
    signal: () => undefined,
  };
  const backend = createWindowsProcessBackend({ stateDirectory: root, operations });
  const stateDirectory = join(root, "identity");
  mkdirSync(stateDirectory);
  writePortableState(stateDirectory, { childPid: 9002, knownProcesses: [] });
  const binding = portableWindowsBinding(stateDirectory, "supervisor-birth");
  try {
    assert.deepEqual(parseProcessReconciliation(await backend.reconcile(binding, fence)), { state: "outcome_unknown" });
    assert.equal(parseProcessEmptyVerification(await backend.verifyEmpty(binding, fence)).empty, false);
    await assert.rejects(backend.release(binding, fence), /unknown|verify|empty/i);
    assert.ok(inspected.length >= 2);
    assert.ok(inspected.every((pid) => pid === 9001), "bare child PID must never be inspected or traversed");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Windows launch rollback persists a recoverable blocker when live-supervisor inspection is unknown", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-windows-live-inspection-unknown-"));
  const operations: NativeProcessOperations = {
    inspectProcessBirth: (pid) => pid === 9001
      ? { state: "present", fingerprint: "supervisor-birth" }
      : { state: "unknown" },
    listPosixGroup: () => undefined,
    signal: () => assert.fail("Windows unknown inspection must not call a native signal action."),
  };
  const backend = createWindowsProcessBackend({ stateDirectory: root, pollIntervalMs: 10, operations });
  writePortableState(root, {
    launchEffect: "unknown",
    rootProcess: null,
    knownProcesses: [],
  });
  const rollback = backend as unknown as { cleanupFailedLaunch(identity: ReturnType<typeof portableIdentity>): Promise<void> };
  try {
    await assert.rejects(
      rollback.cleanupFailedLaunch(portableIdentity(root, "supervisor-birth")),
      (error) => {
        assert.ok(error instanceof NativeProcessLaunchBlockedError);
        assert.equal(error.evidenceDirectory, root);
        return /inspection|verification|evidence/i.test(error.message);
      },
    );
    assert.equal(existsSync(join(root, "control.json")), false);
    assert.equal(existsSync(join(root, "state.json")), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Windows launch rollback preserves an immediate blocker when the supervisor exited with an owned descendant", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-windows-dead-supervisor-"));
  const operations: NativeProcessOperations = {
    inspectProcessBirth: (pid) => pid === 9002
      ? { state: "present", fingerprint: "owned-descendant-birth" }
      : { state: "absent" },
    listPosixGroup: () => undefined,
    signal: () => undefined,
  };
  const backend = createWindowsProcessBackend({ stateDirectory: root, pollIntervalMs: 10, operations });
  writePortableState(root, {
    launchEffect: "started",
    rootProcess: { pid: 9002, birth: "owned-descendant-birth" },
    knownProcesses: [{ pid: 9002, birth: "owned-descendant-birth" }],
  });
  const rollback = backend as unknown as { cleanupFailedLaunch(identity: ReturnType<typeof portableIdentity>): Promise<void> };
  const started = Date.now();
  let blocker: NativeProcessLaunchBlockedError | undefined;
  try {
    await assert.rejects(
      rollback.cleanupFailedLaunch(portableIdentity(root, "supervisor-birth")),
      (error) => {
        assert.ok(error instanceof NativeProcessLaunchBlockedError);
        assert.equal(error.code, "native_process_launch_cleanup_blocked");
        assert.equal(error.evidenceDirectory, root);
        blocker = error;
        return /supervisor.*exited|blocker|evidence/i.test(error.message);
      },
    );
    assert.ok(Date.now() - started < 500, "rollback must not treat a polling timeout as its blocker proof");
    assert.equal(existsSync(join(root, "state.json")), true);
    assert.equal(existsSync(join(root, "control.json")), false);
    assert.ok(blocker);
    const retainedBinding = { ...bindingFor(blocker.launchResult), backendId: "runner-windows-supervisor-v1" };
    assert.deepEqual(parseProcessReconciliation(await backend.reconcile(retainedBinding, fence)), { state: "running" });
    await assert.rejects(backend.release(retainedBinding, fence), /non-empty/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Windows portable launch failure verifies owned cleanup instead of killing only the supervisor PID", async () => {
  if (process.platform !== "win32") return;
  const root = mkdtempSync(join(tmpdir(), "aiboard-windows-launch-cleanup-"));
  const backend = createWindowsProcessBackend({ stateDirectory: root, pollIntervalMs: 20 });
  try {
    await assert.rejects(backend.launch({
      ...request([]),
      intent: { ...request([]).intent, executable: join(root, "missing-executable.exe") },
    }), /launch|process|supervisor|cleanup|ENOENT/i);
    assert.deepEqual(readdirSync(root), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Windows native supervisor owns a surviving descendant after launcher exit", async (t) => {
  if (process.platform !== "win32") {
    t.skip("Windows supervisor ownership requires a Windows host.");
    return;
  }
  const backend = createWindowsProcessBackend({
    jobObjects: "unavailable",
    pollIntervalMs: 20,
  });
  const launch = parseProcessLaunchResult(await backend.launch(request([
    "-e",
    "const{spawn}=require('node:child_process');const c=spawn(process.execPath,['-e',\"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)\"],{stdio:'ignore',detached:true});c.unref();console.log(c.pid);setTimeout(()=>process.exit(0),1500)",
  ])));
  const binding = bindingFor(launch);
  try {
    await new Promise((resolve) => setTimeout(resolve, 1_800));
    const reconciled = parseProcessReconciliation(await backend.reconcile(binding, fence));
    const identity = JSON.parse(Buffer.from(launch.opaqueIdentity, "base64url").toString("utf8"));
    const diagnosticState = readFileSync(join(identity.directory, "state.json"), "utf8");
    assert.deepEqual(reconciled, { state: "running" }, diagnosticState);
    assert.equal(parseProcessSignalResult(await backend.signal(binding, "terminate", fence)).state, "running");
    assert.equal(parseProcessEmptyVerification(await backend.verifyEmpty(binding, fence)).empty, false);
  } finally {
    await backend.signal(binding, "force_terminate", fence).catch(() => undefined);
    const identity = JSON.parse(Buffer.from(launch.opaqueIdentity, "base64url").toString("utf8"));
    const state = JSON.parse(readFileSync(join(identity.directory, "state.json"), "utf8")) as { knownProcesses: Array<{ pid: number; birth: string }> };
    assert.ok(state.knownProcesses.every((process) => process.birth.length > 0));
    for (const pid of [...state.knownProcesses.map((process) => process.pid), identity.supervisorPid]) {
      try { execFileSync("taskkill.exe", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" }); } catch {}
    }
    await backend.release(binding, fence).catch(() => undefined);
  }
});

test("optional Windows Job adapter terminates and verifies a TERM-ignoring descendant tree", async (t) => {
  if (process.platform !== "win32") {
    t.skip("Windows Job Object fixture requires a Windows host.");
    return;
  }
  const root = mkdtempSync(join(tmpdir(), "aiboard-windows-backend-job-"));
  const workspace = join(root, "workspace");
  mkdirSync(workspace);
  const service = new ManagedProcessService({ stateDirectory: join(root, "state") });
  const backend = createWindowsProcessBackend({ jobObjects: { service } });
  const attestation = await backend.probe() as { capabilities: Record<string, string> };
  assert.equal(attestation.capabilities.crash_cleanup, "enforced");
  const jobRequest = request([
    "-e",
    "const{spawn}=require('node:child_process');const c=spawn(process.execPath,['-e',\"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)\"],{stdio:'ignore',detached:true});c.unref();console.log(c.pid);setTimeout(()=>process.exit(0),30)",
  ]);
  const launch = parseProcessLaunchResult(await backend.launch({
    ...jobRequest,
    intent: {
      ...jobRequest.intent,
      invocationId: "windows-job-native",
      workingDirectory: workspace,
    },
    grant: { ...jobRequest.grant, invocationId: "windows-job-native" },
  }));
  const binding = { ...bindingFor(launch), backendId: "runner-windows-job-v1" };
  try {
    assert.deepEqual(
      parseProcessReconciliation(await backend.reconcile({
        ...binding,
        birthFingerprint: { ...binding.birthFingerprint, discriminator: "0".repeat(64) },
      }, fence)),
      { state: "identity_mismatch" },
    );
    assert.deepEqual(
      parseProcessReconciliation(await backend.reconcile({ ...binding, opaqueIdentity: "missing" }, fence)),
      { state: "outcome_unknown" },
    );
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(parseProcessReconciliation(await backend.reconcile(binding, fence)).state, "running");
    const observation = backend.observe(binding, async () => undefined, fence);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(parseProcessSignalResult(await backend.signal(binding, "force_terminate", fence)).state, "exited");
    assert.equal((await observation as { state: string }).state, "exited");
    assert.equal(parseProcessEmptyVerification(await backend.verifyEmpty(binding, fence)).empty, true);
  } finally {
    await service.stopRun("run").catch(() => undefined);
    service.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 30, retryDelay: 50 });
  }
});

test("Windows Job observation uses absolute durable offsets beyond the configured tail", async (t) => {
  if (process.platform !== "win32") {
    t.skip("Windows Job Object output fixture requires a Windows host.");
    return;
  }
  const root = mkdtempSync(join(tmpdir(), "aiboard-windows-backend-output-"));
  const workspace = join(root, "workspace");
  mkdirSync(workspace);
  const maxPollBytes = 64 * 1024;
  const service = new ManagedProcessService({ stateDirectory: join(root, "state"), maxPollBytes });
  const backend = createWindowsProcessBackend({ jobObjects: { service } });
  const oversized = "x".repeat(300_000);
  const outputRequest = request(["-e", "process.stdout.write('x'.repeat(300000))"]);
  const launch = parseProcessLaunchResult(await backend.launch({
    ...outputRequest,
    intent: { ...outputRequest.intent, invocationId: "windows-job-output", workingDirectory: workspace },
    grant: { ...outputRequest.grant, invocationId: "windows-job-output" },
  }));
  const binding = { ...bindingFor(launch), backendId: "runner-windows-job-v1" };
  const chunks: Buffer[] = [];
  try {
    const observation = await backend.observe(binding, async (stream, bytes) => {
      if (stream === "stdout") {
        assert.ok(bytes.byteLength <= maxPollBytes);
        chunks.push(Buffer.from(bytes));
      }
    }, fence);
    assert.equal(parseProcessReconciliation(observation).state, "exited");
    assert.equal(Buffer.concat(chunks).toString(), oversized);
    assert.equal(parseProcessEmptyVerification(await backend.verifyEmpty(binding, fence)).empty, true);
  } finally {
    await service.stopRun("run").catch(() => undefined);
    service.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 30, retryDelay: 50 });
  }
});

test("Windows Job observation advances absolute offsets across incremental durable reads", async () => {
  const durable = Buffer.from("first-second-third");
  const requestedOffsets: number[] = [];
  let deliveredThrough = 0;
  const service: WindowsJobProcessService = {
    probeJobObjectAvailability: async () => true,
    start: async () => { throw new Error("fixture does not launch"); },
    signal: async () => { throw new Error("fixture does not signal"); },
    readOutputSince: (_processId, _context, offsets) => {
      requestedOffsets.push(offsets.stdout);
      if (requestedOffsets.length > 4) throw new Error("absolute output offset did not advance");
      const end = Math.min(offsets.stdout + 6, durable.byteLength);
      const stdout = durable.subarray(offsets.stdout, end);
      deliveredThrough = end;
      return {
        stdout,
        stderr: new Uint8Array(),
        next: { stdout: end, stderr: offsets.stderr },
      };
    },
    reconcileOwnership: async () => ({
      processId: "job-output-contract",
      pid: 9001,
      status: deliveredThrough === durable.byteLength ? "stopped" : "running",
      exitCode: deliveredThrough === durable.byteLength ? 0 : null,
      signal: null,
      startedAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      stdout: "",
      stderr: "",
      ownershipReleased: deliveredThrough === durable.byteLength,
    }),
  };
  const backend = new WindowsJobObjectProcessBackend(service);
  const chunks: Buffer[] = [];

  const observation = await backend.observe(jobBinding("job-output-contract"), async (stream, bytes) => {
    if (stream === "stdout") chunks.push(Buffer.from(bytes));
  }, fence);

  assert.deepEqual(requestedOffsets, [0, 6, 12, 18]);
  assert.equal(Buffer.concat(chunks).toString(), "first-second-third");
  assert.deepEqual(parseProcessReconciliation(observation), { state: "exited", exitCode: 0 });
});

const fence = { ownerId: "test-owner", fencingToken: 1 } as const;
function request(args: string[]) {
  return {
    intent: {
      invocationId: "windows-native",
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
      invocationId: "windows-native",
      issuedAt: new Date().toISOString(),
      access: [],
    },
    environment: { ...process.env } as Record<string, string>,
    outputOwnerId: "output",
    fence,
  };
}
function bindingFor(launch: ProcessLaunchResult) {
  return {
    registryId: "registry",
    backendId: "runner-windows-supervisor-v1",
    implementationGeneration: "generation",
    implementationDigest: "1".repeat(64),
    attestationVersion: 1,
    attestationDigest: "2".repeat(64),
    ...launch,
  };
}

function portableWindowsBinding(directory: string, birth: string) {
  const identity = portableIdentity(directory, birth);
  return bindingFor({
    opaqueIdentity: Buffer.from(JSON.stringify(identity)).toString("base64url"),
    birthFingerprint: {
      observedAt: "2026-01-01T00:00:00.000Z",
      discriminator: createHash("sha256").update(`windows-contract-nonce\0${birth}`).digest("hex"),
    },
    rootPid: 9001,
    startedAt: "2026-01-01T00:00:00.000Z",
  });
}

function portableIdentity(directory: string, birth: string) {
  return {
    version: 1,
    backendId: "runner-windows-supervisor-v1",
    nonce: "windows-contract-nonce",
    directory,
    supervisorPid: 9001,
    supervisorBirth: birth,
  } as const;
}

async function waitForPortableState(
  directory: string,
  predicate: (state: {
    status: string;
    launchEffect?: string;
    rootProcess?: { pid: number; birth: string } | null;
    knownProcesses: Array<{ pid: number; birth: string }>;
    handledControl: number;
  }) => boolean,
) {
  const path = join(directory, "state.json");
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
      const state = JSON.parse(readFileSync(path, "utf8"));
      if (predicate(state)) return state;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Portable supervisor state did not settle at ${path}.`);
}

function writePortableState(
  directory: string,
  overrides: {
    childPid?: number;
    launchEffect?: "not_started" | "started" | "unknown";
    rootProcess?: { pid: number; birth: string } | null;
    knownProcesses: Array<{ pid: number; birth: string }>;
  },
) {
  writeFileSync(join(directory, "state.json"), JSON.stringify({
    protocol: "aiboard-portable-process/v1",
    nonce: "windows-contract-nonce",
    supervisorPid: 9001,
    revision: 1,
    handledControl: 0,
    status: "running",
    exitCode: null,
    signal: null,
    error: null,
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  }));
}

function jobBinding(processId: string) {
  const startedAt = "2026-01-01T00:00:00.000Z";
  const identity = { processId, runId: "run", sessionId: "session", startedAt };
  return {
    ...bindingFor({
      opaqueIdentity: Buffer.from(JSON.stringify(identity)).toString("base64url"),
      birthFingerprint: {
        observedAt: startedAt,
        discriminator: createHash("sha256").update(`${processId}\0${startedAt}`).digest("hex"),
      },
      rootPid: 9001,
      startedAt,
    }),
    backendId: "runner-windows-job-v1",
  };
}
