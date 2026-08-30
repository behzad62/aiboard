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

test("Windows portable supervisor reuses one birth-tagged tree snapshot per ownership tick", () => {
  const source = readFileSync(join(process.cwd(), "runner-v2", "src", "portable-process-supervisor.mjs"), "utf8");
  assert.equal(source.match(/Get-CimInstance Win32_Process/g)?.length, 1);
  assert.doesNotMatch(source, /Get-CimInstance Win32_Process -Filter/);
  assert.match(source, /lastWindowsProcesses/);
  assert.match(source, /windowsTreeRefreshInFlight/);
  assert.match(source, /WINDOWS_TREE_REFRESH_INTERVAL_MS\s*=\s*250/);
  assert.match(source, /const gap\s*=\s*now\s*-\s*lastWindowsTreeRefreshFinishedAt/);
  assert.match(source, /gap\s*<\s*WINDOWS_TREE_REFRESH_INTERVAL_MS/);
  assert.match(source, /WINDOWS_TREE_FAILURE_LIMIT/);
});

test("Windows portable backend launches a batch shim with argv boundaries while Job containment is unavailable", async (t) => {
  if (process.platform !== "win32") { t.skip("Windows batch fixture requires Windows."); return; }
  const root = mkdtempSync(join(tmpdir(), "aiboard-portable-batch-"));
  const workspace = join(root, "workspace"); mkdirSync(workspace);
  const shim = join(workspace, "argv.cmd");
  writeFileSync(shim, "@echo off\r\necho [%~1][%~2]\r\n");
  const backend = createWindowsProcessBackend({ stateDirectory: join(root, "state"), jobObjects: "unavailable" });
  const batchRequest = request(["hello world", "literal"]);
  const launch = parseProcessLaunchResult(await backend.launch({ ...batchRequest, intent: { ...batchRequest.intent, executable: shim, invocationId: "portable-batch", workingDirectory: workspace }, grant: { ...batchRequest.grant, invocationId: "portable-batch" } }));
  const binding = bindingFor(launch); const output: Buffer[] = [];
  try {
    await backend.observe(binding, async (stream, bytes) => { if (stream === "stdout") output.push(Buffer.from(bytes)); }, fence);
    assert.equal(Buffer.concat(output).toString().trim(), "[hello world][literal]");
    const unsafe = request(["safe", "bad&injected"]);
    await assert.rejects(backend.launch({ ...unsafe, intent: { ...unsafe.intent, executable: shim, invocationId: "portable-batch-refusal", workingDirectory: workspace }, grant: { ...unsafe.grant, invocationId: "portable-batch-refusal" } }), /unsafe.*batch|launch/i);
  } finally {
    await backend.signal(binding, "force_terminate", fence).catch(() => undefined);
    await backend.release(binding, fence).catch(() => undefined);
    rmSync(root, { recursive: true, force: true, maxRetries: 30, retryDelay: 50 });
  }
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

test("Windows signal retries transient descendant inspection uncertainty without accepting persistent unknown", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-windows-signal-reattest-"));
  let descendantInspections = 0;
  const operations: NativeProcessOperations = {
    inspectProcessBirth: (pid) => pid === 9001
      ? { state: "present", fingerprint: "supervisor-birth" }
      : ++descendantInspections < 3
        ? { state: "unknown" }
        : { state: "present", fingerprint: "owned-descendant-birth" },
    listPosixGroup: () => undefined,
    signal: () => undefined,
  };
  const backend = createWindowsProcessBackend({ stateDirectory: root, operations, pollIntervalMs: 5 });
  const stateDirectory = join(root, "identity"); mkdirSync(stateDirectory);
  writePortableState(stateDirectory, {
    launchEffect: "started",
    rootProcess: { pid: 9002, birth: "owned-descendant-birth" },
    knownProcesses: [{ pid: 9002, birth: "owned-descendant-birth" }],
  });
  try {
    assert.equal(parseProcessSignalResult(await backend.signal(portableWindowsBinding(stateDirectory, "supervisor-birth"), "terminate", fence)).state, "running");
    assert.ok(descendantInspections >= 3);
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

test("Windows launch rollback retries transient identity uncertainty before proving empty", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-windows-transient-launch-"));
  let inspections = 0;
  const operations: NativeProcessOperations = {
    inspectProcessBirth: () => ++inspections <= 2 ? { state: "unknown" } : { state: "absent" },
    listPosixGroup: () => undefined,
    signal: () => assert.fail("transient launch cleanup must not signal an unverified identity"),
  };
  const backend = createWindowsProcessBackend({ stateDirectory: root, pollIntervalMs: 5, operations });
  const evidence = join(root, "identity");
  mkdirSync(evidence);
  writePortableState(evidence, { launchEffect: "not_started", rootProcess: null, knownProcesses: [] });
  const rollback = backend as unknown as { cleanupFailedLaunch(identity: ReturnType<typeof portableIdentity>): Promise<void> };
  try {
    await rollback.cleanupFailedLaunch(portableIdentity(evidence, "supervisor-birth"));
    assert.ok(inspections >= 3);
  } finally {
    try { rmSync(root, { recursive: true, force: true, maxRetries: 30, retryDelay: 50 }); } catch {}
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
    const failures = await Promise.all(Array.from({ length: 4 }, async (_, index) => {
      try {
        await backend.launch({
          ...request([]),
          intent: {
            ...request([]).intent,
            invocationId: `missing-executable-${index}`,
            executable: join(root, `missing-executable-${index}.exe`),
          },
        });
        assert.fail("missing executable unexpectedly launched");
      } catch (error) {
        assert.match(error instanceof Error ? error.message : String(error), /launch|process|supervisor|cleanup|ENOENT/i);
        return error;
      }
    }));
    assert.equal(failures.length, 4);
    const residue = readdirSync(root);
    assert.deepEqual(residue, [], JSON.stringify({
      failures: failures.map((error) => error instanceof Error ? error.message : String(error)),
      residue: residue.map((entry) => ({
        entry,
        state: existsSync(join(root, entry, "state.json")) ? readFileSync(join(root, entry, "state.json"), "utf8") : "missing",
      })),
    }));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Windows native supervisor owns a surviving descendant after launcher exit", async (t) => {
  if (process.platform !== "win32") {
    t.skip("Windows supervisor ownership requires a Windows host.");
    return;
  }
  const root = mkdtempSync(join(tmpdir(), "aiboard-windows-descendant-"));
  const backend = createWindowsProcessBackend({
    jobObjects: "unavailable",
    stateDirectory: root,
    pollIntervalMs: 20,
  });
  const launch = parseProcessLaunchResult(await backend.launch(request([
    "-e",
    "const{spawn}=require('node:child_process');const c=spawn(process.execPath,['-e',\"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)\"],{stdio:'ignore',detached:true});c.unref();console.log(c.pid);setTimeout(()=>process.exit(0),1500)",
  ])));
  const binding = bindingFor(launch);
  try {
    await new Promise((resolve) => setTimeout(resolve, 1_800));
    let reconciled = parseProcessReconciliation(await backend.reconcile(binding, fence));
    const inspectionDeadline = Date.now() + 5_000;
    while (reconciled.state === "outcome_unknown" && Date.now() < inspectionDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      reconciled = parseProcessReconciliation(await backend.reconcile(binding, fence));
    }
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
    rmSync(root, { recursive: true, force: true, maxRetries: 30, retryDelay: 50 });
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
    const takeoverFence = { ownerId: "job-recovery", fencingToken: fence.fencingToken + 1 };
    assert.equal(parseProcessReconciliation(await backend.reconcile(binding, takeoverFence)).state, "running");
    await assert.rejects(backend.signal(binding, "terminate", fence), /fence|identity/i);
    assert.deepEqual(
      parseProcessReconciliation(await backend.reconcile({
        ...binding,
        birthFingerprint: { ...binding.birthFingerprint, discriminator: "0".repeat(64) },
      }, takeoverFence)),
      { state: "identity_mismatch" },
    );
    assert.deepEqual(
      parseProcessReconciliation(await backend.reconcile({ ...binding, opaqueIdentity: "missing" }, takeoverFence)),
      { state: "outcome_unknown" },
    );
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(parseProcessReconciliation(await backend.reconcile(binding, takeoverFence)).state, "running");
    const observation = backend.observe(binding, async () => undefined, takeoverFence);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(parseProcessSignalResult(await backend.signal(binding, "force_terminate", takeoverFence)).state, "exited");
    assert.equal((await observation as { state: string }).state, "exited");
    assert.equal(parseProcessEmptyVerification(await backend.verifyEmpty(binding, takeoverFence)).empty, true);
  } finally {
    await backend.signal(binding, "force_terminate", { ownerId: "job-recovery", fencingToken: fence.fencingToken + 1 }).catch(() => undefined);
    await service.stopRun("run").catch(() => undefined);
    service.close();
    try { rmSync(root, { recursive: true, force: true, maxRetries: 30, retryDelay: 50 }); } catch {}
  }
});

test("Windows Job v2 channel performs a real duplex roundtrip with detach and reattach", async (t) => {
  if (process.platform !== "win32") {
    t.skip("Windows Job Object duplex fixture requires a Windows host.");
    return;
  }
  const root = mkdtempSync(join(tmpdir(), "aiboard-windows-job-channel-"));
  const workspace = join(root, "workspace");
  mkdirSync(workspace);
  const service = new ManagedProcessService({ stateDirectory: join(root, "state") });
  const backend = createWindowsProcessBackend({ jobObjects: { service } }) as WindowsJobObjectProcessBackend;
  const duplexRequest = request(["-e", "process.stdin.on('data',b=>process.stdout.write(Buffer.from('echo:'+b)));process.stdin.on('end',()=>process.exit(0))"]);
  const launch = parseProcessLaunchResult(await backend.launch({
    ...duplexRequest,
    intent: { ...duplexRequest.intent, invocationId: "windows-job-duplex", workingDirectory: workspace },
    grant: { ...duplexRequest.grant, invocationId: "windows-job-duplex" },
  }));
  const binding = { ...bindingFor(launch), backendId: "runner-windows-job-v1" };
  try {
    const provider = backend.backpressuredChannelProvider();
    const first = await provider.acquire(binding, fence);
    const received: Buffer[] = [];
    first.subscribeBackpressuredOutput(async (metadata, bytes) => {
      received.push(Buffer.from(bytes));
      return metadata;
    });
    const payload = Buffer.from("one\n");
    assert.deepEqual(await first.write({ sequence: 1, byteLength: payload.byteLength, digest: createHash("sha256").update(payload).digest("hex"), timeoutMs: 2_000 }, payload), { acknowledged: true, sequence: 1 });
    const higherFence = { ownerId: "recovery-owner", fencingToken: fence.fencingToken + 1 };
    const takeover = await provider.acquire(binding, higherFence);
    await assert.rejects(first.closeInput(), /fence|stale|ownership/i);
    await takeover.detach();
    const recovered = await provider.reattach(binding, higherFence);
    assert.equal(recovered.nextSequence, 2);
    recovered.channel.subscribeBackpressuredOutput(async (metadata, bytes) => { received.push(Buffer.from(bytes)); return metadata; });
    await recovered.channel.closeInput();
    await recovered.channel.waitForTerminal();
    assert.match(Buffer.concat(received).toString(), /echo:one/);
  } finally {
    await service.stopRun("run").catch(() => undefined);
    service.close();
    try { rmSync(root, { recursive: true, force: true, maxRetries: 30, retryDelay: 50 }); } catch {}
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
    probeActiveJobCreateClose: async () => true,
    launchOwned: async () => { throw new Error("fixture does not launch"); },
    signalOwned: async () => { throw new Error("fixture does not signal"); },
    releaseOwned: async (processId) => stoppedJobSnapshot(processId),
    readOwnedOutput: (_processId, _context, offsets) => {
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
    reconcileOwned: async () => ({
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

test("Windows Job serializes ownership observation with cancellation control", async () => {
  let running = true;
  let reconciliationActive = false;
  let signalCalls = 0;
  let releaseReconciliation!: () => void;
  const reconciliationBarrier = new Promise<void>((resolve) => { releaseReconciliation = resolve; });
  const snapshot = () => ({
    processId: "job-control-serialization",
    pid: 9001,
    status: running ? "running" as const : "stopped" as const,
    exitCode: running ? null : 143,
    signal: running ? null : "SIGTERM" as const,
    startedAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    stdout: "",
    stderr: "",
    ownershipReleased: !running,
  });
  const service: WindowsJobProcessService = {
    probeActiveJobCreateClose: async () => true,
    launchOwned: async () => { throw new Error("fixture does not launch"); },
    readOwnedOutput: (_processId, _context, offsets) => ({
      stdout: new Uint8Array(),
      stderr: new Uint8Array(),
      next: offsets,
    }),
    reconcileOwned: async () => {
      if (running) {
        reconciliationActive = true;
        await reconciliationBarrier;
        reconciliationActive = false;
      }
      return snapshot();
    },
    signalOwned: async () => {
      signalCalls += 1;
      if (reconciliationActive) {
        const error = new Error("read ECONNRESET") as Error & { code: string };
        error.code = "ECONNRESET";
        throw error;
      }
      running = false;
      return snapshot();
    },
    releaseOwned: async () => snapshot(),
  };
  const backend = new WindowsJobObjectProcessBackend(service);
  const binding = jobBinding("job-control-serialization");

  const observation = backend.observe(binding, async () => undefined, fence);
  while (!reconciliationActive) await new Promise((resolve) => setImmediate(resolve));
  const cancellation = backend.signal(binding, "terminate");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(signalCalls, 0, "cancellation must queue behind the in-flight authenticated ownership observation");

  releaseReconciliation();
  assert.equal(parseProcessSignalResult(await cancellation).state, "exited");
  assert.deepEqual(parseProcessReconciliation(await observation), { state: "exited", exitCode: 143, signal: "SIGTERM" });
});

test("Windows Job shared activation rejects a different exact birth before service action", async () => {
  let entered!: () => void;
  let resume!: () => void;
  const activationEntered = new Promise<void>((resolve) => { entered = resolve; });
  const activationBarrier = new Promise<void>((resolve) => { resume = resolve; });
  let reconciliations = 0;
  let signalCalls = 0;
  const processId = "job-shared-activation-identity";
  const service: WindowsJobProcessService = {
    probeActiveJobCreateClose: async () => true,
    launchOwned: async () => { throw new Error("fixture does not launch"); },
    readOwnedOutput: (_processId, _context, offsets) => ({ stdout: new Uint8Array(), stderr: new Uint8Array(), next: offsets }),
    reconcileOwned: async () => {
      reconciliations += 1;
      if (reconciliations === 1) { entered(); await activationBarrier; }
      return stoppedJobSnapshot(processId);
    },
    signalOwned: async () => { signalCalls += 1; return stoppedJobSnapshot(processId); },
    releaseOwned: async () => stoppedJobSnapshot(processId),
  };
  const backend = new WindowsJobObjectProcessBackend(service);
  const firstBirth = jobBindingAt(processId, "2026-01-01T00:00:00.000Z");
  const secondBirth = jobBindingAt(processId, "2026-01-02T00:00:00.000Z");

  const firstVerification = backend.verifyEmpty(firstBirth);
  await activationEntered;
  const wrongBirthSignal = backend.signal(secondBirth, "terminate");
  resume();

  assert.equal(parseProcessEmptyVerification(await firstVerification).empty, true);
  await assert.rejects(wrongBirthSignal, /identity mismatch/i);
  assert.equal(signalCalls, 0, "the different birth must be rejected before its service action");
  assert.equal(parseProcessEmptyVerification(await backend.verifyEmpty(firstBirth)).empty, true, "the valid lane must not be poisoned");
});

test("Windows Job release waits for active output delivery and closes later observation", async () => {
  let releaseOutput!: () => void;
  const barrier = new Promise<void>((resolve) => { releaseOutput = resolve; });
  let outputActive = false;
  let reads = 0;
  let released = false;
  const service: WindowsJobProcessService = {
    probeActiveJobCreateClose: async () => true,
    launchOwned: async () => { throw new Error("fixture does not launch"); },
    readOwnedOutput: (_processId, _context, offsets) => ++reads === 1
      ? { stdout: Buffer.from("held output"), stderr: new Uint8Array(), next: { stdout: 11, stderr: offsets.stderr } }
      : { stdout: new Uint8Array(), stderr: new Uint8Array(), next: offsets },
    reconcileOwned: async () => {
      if (released) throw new Error("backend ownership was released");
      return stoppedJobSnapshot("job-release-lane");
    },
    signalOwned: async () => stoppedJobSnapshot("job-release-lane"),
    releaseOwned: async () => { released = true; return stoppedJobSnapshot("job-release-lane"); },
  };
  const backend = new WindowsJobObjectProcessBackend(service);
  const binding = jobBinding("job-release-lane");
  const observation = backend.observe(binding, async () => {
    outputActive = true;
    await barrier;
    outputActive = false;
  }, fence);
  while (!outputActive) await new Promise((resolve) => setImmediate(resolve));

  let releaseSettled = false;
  const firstRelease = backend.release(binding);
  void firstRelease.then(() => { releaseSettled = true; });
  const concurrentRelease = backend.release(binding);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(releaseSettled, false, "release must queue behind active output delivery");
  await assert.rejects(backend.verifyEmpty(binding), /release is pending/i);
  await assert.rejects(backend.signal(binding, "terminate"), /release is pending/i);
  releaseOutput();
  assert.deepEqual(await Promise.all([firstRelease, concurrentRelease]), [{ released: true }, { released: true }]);
  await assert.rejects(observation, /released/i);
  assert.equal((backend as unknown as { offsets: Map<string, unknown> }).offsets.has("job-release-lane"), false);
});

test("Windows Job release drains callback and reconcile errors without retaining offsets", async (t) => {
  for (const mode of ["callback", "reconcile"] as const) {
    await t.test(mode, async () => {
      let entered!: () => void;
      let resume!: () => void;
      const active = new Promise<void>((resolve) => { entered = resolve; });
      const barrier = new Promise<void>((resolve) => { resume = resolve; });
      const processId = `job-release-${mode}-error`;
      let reconciliations = 0;
      const service: WindowsJobProcessService = {
        probeActiveJobCreateClose: async () => true,
        launchOwned: async () => { throw new Error("fixture does not launch"); },
        readOwnedOutput: (_processId, _context, offsets) => ({
          stdout: Buffer.from("fault output"), stderr: new Uint8Array(), next: { stdout: 12, stderr: offsets.stderr },
        }),
        reconcileOwned: async () => {
          reconciliations += 1;
          if (mode === "reconcile" && reconciliations > 1) { entered(); await barrier; throw new Error("injected reconcile failure"); }
          return stoppedJobSnapshot(processId);
        },
        signalOwned: async () => stoppedJobSnapshot(processId),
        releaseOwned: async () => stoppedJobSnapshot(processId),
      };
      const backend = new WindowsJobObjectProcessBackend(service);
      const observation = backend.observe(jobBinding(processId), async () => {
        if (mode === "callback") { entered(); await barrier; throw new Error("injected callback failure"); }
      }, fence);
      await active;
      const releasing = backend.release(jobBinding(processId));
      resume();
      await assert.rejects(observation, new RegExp(`injected ${mode} failure`));
      assert.deepEqual(await releasing, { released: true });
      assert.equal((backend as unknown as { offsets: Map<string, unknown> }).offsets.has(processId), false);
    });
  }
});

test("Windows Job control lane advances after an operation error and still releases", async () => {
  let fail = true;
  let signalCalls = 0;
  let releaseCalls = 0;
  const service: WindowsJobProcessService = {
    probeActiveJobCreateClose: async () => true,
    launchOwned: async () => { throw new Error("fixture does not launch"); },
    readOwnedOutput: (_processId, _context, offsets) => ({ stdout: new Uint8Array(), stderr: new Uint8Array(), next: offsets }),
    reconcileOwned: async () => {
      if (fail) { fail = false; throw new Error("injected ownership failure"); }
      return stoppedJobSnapshot("job-release-error");
    },
    signalOwned: async () => { signalCalls += 1; return stoppedJobSnapshot("job-release-error"); },
    releaseOwned: async () => {
      releaseCalls += 1;
      if (releaseCalls === 1) throw new Error("injected durable release failure");
      return stoppedJobSnapshot("job-release-error");
    },
  };
  const backend = new WindowsJobObjectProcessBackend(service);
  const binding = jobBinding("job-release-error");
  await assert.rejects(backend.observe(binding, async () => undefined, fence), /injected ownership failure/);
  assert.equal(parseProcessSignalResult(await backend.signal(binding, "terminate")).state, "exited");
  assert.equal(signalCalls, 1);
  await assert.rejects(backend.release(binding), /injected durable release failure/);
  await assert.rejects(backend.verifyEmpty(binding), /release is pending/i);
  assert.deepEqual(await backend.release(binding), { released: true });
  assert.equal(releaseCalls, 2);
});

test("Windows Job durable release authority rejects stale identities beyond prior cache capacity", async () => {
  const released = new Map<string, string>();
  let releasedReattestations = 0;
  const service: WindowsJobProcessService = {
    probeActiveJobCreateClose: async () => true,
    launchOwned: async () => { throw new Error("fixture does not launch"); },
    signalOwned: async () => { throw new Error("released identity reached signal"); },
    readOwnedOutput: () => { throw new Error("released identity reached output"); },
    reconcileOwned: async (processId, _context) => {
      if (released.has(processId)) {
        releasedReattestations += 1;
        throw new Error("durable backend ownership was released");
      }
      return stoppedJobSnapshot(processId);
    },
    releaseOwned: async (processId, _context, expectedStartedAt) => {
      assert.equal(expectedStartedAt, "2026-01-01T00:00:00.000Z");
      released.set(processId, expectedStartedAt);
      return stoppedJobSnapshot(processId);
    },
  };
  const backend = new WindowsJobObjectProcessBackend(service);
  const first = jobBinding("job-release-churn-0");
  for (let index = 0; index < 4_097; index += 1) {
    await backend.release(jobBinding(`job-release-churn-${index}`));
  }

  await assert.rejects(backend.verifyEmpty({ ...first }), /released/i);
  assert.equal(releasedReattestations, 1, "stale clone must fail during exact durable re-attestation");
  assert.equal((backend as unknown as { controls: Map<string, unknown> }).controls.size, 0);
});

test("Windows Job durable release rejects a stale clone after adapter restart and startedAt mismatch", async () => {
  const released = new Map<string, string>();
  const service: WindowsJobProcessService = {
    probeActiveJobCreateClose: async () => true,
    launchOwned: async () => { throw new Error("fixture does not launch"); },
    signalOwned: async () => { throw new Error("fixture does not signal"); },
    readOwnedOutput: () => { throw new Error("fixture does not read"); },
    reconcileOwned: async (processId) => {
      if (released.has(processId)) throw new Error("durable backend ownership was released");
      return stoppedJobSnapshot(processId);
    },
    releaseOwned: async (processId, _context, expectedStartedAt) => {
      if (expectedStartedAt !== "2026-01-01T00:00:00.000Z") throw new Error("exact startedAt mismatch");
      released.set(processId, expectedStartedAt);
      return stoppedJobSnapshot(processId);
    },
  };
  const binding = jobBinding("job-release-restart");
  const first = new WindowsJobObjectProcessBackend(service);
  assert.deepEqual(await Promise.all([first.release(binding), first.release({ ...binding })]), [{ released: true }, { released: true }]);

  const restarted = new WindowsJobObjectProcessBackend(service);
  await assert.rejects(restarted.verifyEmpty({ ...binding }), /released/i);
  const wrongStartedAt = jobBindingAt("job-release-restart", "2026-01-02T00:00:00.000Z");
  await assert.rejects(restarted.release(wrongStartedAt), /startedAt mismatch/i);
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
  return jobBindingAt(processId, "2026-01-01T00:00:00.000Z");
}

function jobBindingAt(processId: string, startedAt: string) {
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

function stoppedJobSnapshot(processId: string) {
  return {
    processId,
    pid: 9001,
    status: "stopped" as const,
    exitCode: 0,
    signal: null,
    startedAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    stdout: "",
    stderr: "",
    ownershipReleased: true,
  };
}
