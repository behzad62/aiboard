import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
    rmSync(root, { recursive: true, force: true });
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
    rmSync(root, { recursive: true, force: true });
  }
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
    rmSync(root, { recursive: true, force: true });
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
    rmSync(root, { recursive: true, force: true });
  }
});

const fence = { ownerId: "test-owner", fencingToken: 1 } as const;
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
    environment: { ...process.env } as Record<string, string>,
    outputOwnerId: "output",
    fence,
  };
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
