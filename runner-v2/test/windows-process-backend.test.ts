import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createWindowsProcessBackend } from "../src/windows-process-backend.js";
import { ManagedProcessService } from "../src/managed-process.js";
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
    "const{spawn}=require('node:child_process');const c=spawn(process.execPath,['-e',\"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)\"],{stdio:'ignore',detached:true});c.unref();console.log(c.pid);setTimeout(()=>process.exit(0),30)",
  ])));
  const binding = bindingFor(launch);
  try {
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.deepEqual(parseProcessReconciliation(await backend.reconcile(binding, fence)), { state: "running" });
    assert.equal(parseProcessSignalResult(await backend.signal(binding, "terminate", fence)).state, "running");
    assert.equal(parseProcessEmptyVerification(await backend.verifyEmpty(binding, fence)).empty, false);
  } finally {
    await backend.signal(binding, "force_terminate", fence).catch(() => undefined);
    const identity = JSON.parse(Buffer.from(launch.opaqueIdentity, "base64url").toString("utf8"));
    const state = JSON.parse(readFileSync(join(identity.directory, "state.json"), "utf8")) as { knownPids: number[] };
    for (const pid of [...state.knownPids, identity.supervisorPid]) {
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
