import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createExecutionGrantAuthority, type OpaqueExecutionGrant } from "../src/execution-grants.js";
import { createChildEnvironmentFactory } from "../src/child-environment.js";
import {
  createRuntimeBackedOneShotCommandExecutor,
} from "../src/one-shot-command-executor.js";
import type { ExecutionIsolationSelection } from "../src/execution-isolation-provider.js";
import type { SubprocessRuntime } from "../src/subprocess-runtime.js";
import { ExecutionIsolationError } from "../src/execution-isolation-provider.js";

test("shared executor selects isolation before launch and releases after verified cleanup", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-one-shot-"));
  const workspace = join(root, "workspace");
  mkdirSync(workspace);
  const order: string[] = [];
  const authority = createExecutionGrantAuthority();
  const grant = await authority.issue({
    runId: "run_1",
    sessionId: "session_1",
    actor: { role: "worker", id: "worker_1" },
    toolName: "process.run",
    callId: "call_1",
    permissionProfile: "project",
    workspacePath: workspace,
    access: [{ path: workspace, mode: "write" }],
    externalApproved: false,
    destructiveApproved: false,
    networkApproved: false,
  });
  const selection: ExecutionIsolationSelection = {
    enforcement: "write_confinement_exact_grant",
    disclosure: "provider_specific_not_universal_boundary",
    providerId: "oci",
    implementationDigest: "a".repeat(64),
    attestation: {
      attestationVersion: 1,
      providerId: "oci",
      verified: true,
      mechanism: "fixture",
      exactGrantWriteConfinement: true,
      capabilities: {
        tree_termination: "enforced",
        crash_cleanup: "enforced",
        verified_emptiness: "enforced",
        write_confinement: "enforced",
      },
    },
    lease: {
      leaseId: "lease-1",
      providerId: "oci",
      invocationId: "run_1-session_1-call_1",
      grantId: "unused-in-structural-fixture",
      grantedAccess: [],
      acquiredAt: "2026-08-29T00:00:00.000Z",
      state: "active",
      providerIdentity: "a".repeat(64),
    },
  };
  const runtime: SubprocessRuntime = {
    invoke: async (request) => {
      order.push("runtime");
      assert.equal(request.intent.executable, "attested-oci-cli");
      assert.deepEqual(request.intent.arguments, ["start", "--attach", "owned-container"]);
      assert.equal("SENTINEL_SECRET" in request.ambientEnvironment, false);
      return {
        logicalProcessId: "logical-1",
        outcome: "exited",
        exitCode: 0,
        finishedAt: "2026-08-29T00:00:01.000Z",
        output: [],
        cleanup: { state: "verified_empty", verifiedAt: "2026-08-29T00:00:01.000Z" },
      };
    },
    cancel: async () => false,
    reconcileStartup: async () => [],
  };
  const executor = createRuntimeBackedOneShotCommandExecutor({
    runtime,
    runtimeGrants: { issue: () => order.push("runtime-grant"), revoke: () => { order.push("runtime-revoke"); return true; } },
    executionGrants: authority,
    isolation: {
      acquire: async (input) => {
        order.push("isolation");
        assert.equal("SENTINEL_SECRET" in (input.environment ?? {}), false);
        assert.equal(input.environment?.SAFE_EXPLICIT, "approved");
        return selection;
      },
      prepareExecution: async (_selection, intent) => {
        order.push("launch-plan");
        return {
          invocationId: intent.invocationId,
          runId: "run_1",
          sessionId: "session_1",
          kind: "command",
          executable: "attested-oci-cli",
          arguments: ["start", "--attach", "owned-container"],
          workingDirectory: workspace,
          requestedCapabilities: ["tree_termination", "verified_emptiness"],
        };
      },
      release: async () => { order.push("release"); },
      recoverOwnedLeases: async () => [],
      activeLeases: () => [],
      enforcementState: async () => ({ version: 1, boundary: "provider_specific_not_universal_security_boundary", records: [] }),
    },
    permissionProfile: "project",
    ambientEnvironment: { PATH: "safe", SENTINEL_SECRET: "must-be-scrubbed-by-runtime" },
    environments: createChildEnvironmentFactory({
      credentialResolver: { consume: () => { throw new Error("unexpected credential"); } },
    }),
    clock: () => new Date("2026-08-29T00:00:00.000Z"),
  });
  try {
    const result = await executor.execute({
      executable: "node",
      arguments: ["--version"],
      workingDirectory: workspace,
      explicitEnvironment: { SAFE_EXPLICIT: "approved" },
      timeoutMs: 5_000,
      context: {
        runId: "run_1",
        sessionId: "session_1",
        actor: { role: "worker", id: "worker_1" },
        callId: "call_1",
        toolName: "process.run",
        executionGrant: grant,
      },
    });
    assert.equal(result.enforcement, "write_confinement_exact_grant");
    assert.deepEqual(order, ["isolation", "launch-plan", "runtime-grant", "runtime", "runtime-revoke", "release"]);
  } finally {
    await authority.revoke(grant, "cleanup");
    rmSync(root, { recursive: true, force: true });
  }
});

test("a pre-consumption runtime failure revokes its runtime grant exactly once before isolation release", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "aiboard-one-shot-preconsume-"));
  const authority = createExecutionGrantAuthority();
  const grant = await authority.issue(grantRequest(workspace, "project", "preconsume"));
  const order: string[] = [];
  const executor = createRuntimeBackedOneShotCommandExecutor({
    runtime: {
      invoke: async () => { order.push("runtime"); throw new Error("rejected before grant consumption"); },
      cancel: async () => false, reconcileStartup: async () => [],
    },
    runtimeGrants: {
      issue: () => order.push("issue"),
      revoke: () => { order.push("revoke"); return true; },
    },
    executionGrants: authority,
    isolation: {
      acquire: async () => strictSelection("preconsume"),
      prepareExecution: async (_selection, intent) => intent,
      release: async () => { order.push("release"); },
      recoverOwnedLeases: async () => [], activeLeases: () => [],
      enforcementState: async () => ({ version: 1, boundary: "provider_specific_not_universal_security_boundary", records: [] }),
    },
    permissionProfile: "project", ambientEnvironment: {},
    environments: createChildEnvironmentFactory({ credentialResolver: { consume: () => { throw new Error(); } } }),
  });
  try {
    await assert.rejects(executor.execute(commandRequest(workspace, grant, "preconsume")), /before grant consumption/);
    assert.deepEqual(order, ["issue", "runtime", "revoke", "release"]);
  } finally {
    await authority.revoke(grant, "cleanup").catch(() => undefined);
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("strict capability failure happens before runtime launch", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "aiboard-one-shot-unavailable-"));
  const authority = createExecutionGrantAuthority();
  const grant = await authority.issue(grantRequest(workspace, "project", "unavailable"));
  let launches = 0;
  const executor = createRuntimeBackedOneShotCommandExecutor({
    runtime: {
      invoke: async () => { launches += 1; throw new Error("must not launch"); },
      cancel: async () => false,
      reconcileStartup: async () => [],
    },
    runtimeGrants: { issue: () => undefined, revoke: () => true },
    executionGrants: authority,
    isolation: {
      acquire: async () => { throw new ExecutionIsolationError("isolation_capability_unavailable", "strict unavailable"); },
      prepareExecution: async () => { throw new Error("must not prepare"); },
      release: async () => undefined,
      recoverOwnedLeases: async () => [],
      activeLeases: () => [],
      enforcementState: async () => ({ version: 1, boundary: "provider_specific_not_universal_security_boundary", records: [] }),
    },
    permissionProfile: "project",
    ambientEnvironment: { SENTINEL_SECRET: "removed" },
    environments: createChildEnvironmentFactory({ credentialResolver: { consume: () => { throw new Error(); } } }),
  });
  try {
    await assert.rejects(
      executor.execute(commandRequest(workspace, grant, "unavailable")),
      (error) => error instanceof ExecutionIsolationError && error.code === "isolation_capability_unavailable",
    );
    assert.equal(launches, 0);
  } finally {
    await authority.revoke(grant, "cleanup");
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("runtime outcome uncertainty still releases strict isolation and a release blocker wins truthfully", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "aiboard-one-shot-unknown-"));
  const authority = createExecutionGrantAuthority();
  const grant = await authority.issue(grantRequest(workspace, "project", "unknown"));
  let releases = 0;
  let runtimeRevokes = 0;
  const selection = strictSelection("placeholder");
  const executor = createRuntimeBackedOneShotCommandExecutor({
    runtime: {
      invoke: async () => { throw Object.assign(new Error("runtime outcome unknown"), { code: "outcome_unknown" }); },
      cancel: async () => false,
      reconcileStartup: async () => [],
    },
    runtimeGrants: { issue: () => undefined, revoke: () => { runtimeRevokes += 1; return true; } },
    executionGrants: authority,
    isolation: {
      acquire: async () => selection,
      prepareExecution: async (_selection, intent) => intent,
      release: async () => {
        releases += 1;
        throw new ExecutionIsolationError("isolation_revocation_failed", "cleanup blocker");
      },
      recoverOwnedLeases: async () => [],
      activeLeases: () => [],
      enforcementState: async () => ({ version: 1, boundary: "provider_specific_not_universal_security_boundary", records: [] }),
    },
    permissionProfile: "project",
    ambientEnvironment: {},
    environments: createChildEnvironmentFactory({ credentialResolver: { consume: () => { throw new Error(); } } }),
  });
  try {
    await assert.rejects(
      executor.execute(commandRequest(workspace, grant, "unknown")),
      (error) => error instanceof ExecutionIsolationError && error.code === "isolation_revocation_failed",
    );
    assert.equal(releases, 1);
    assert.equal(runtimeRevokes, 1);
  } finally {
    await authority.revoke(grant, "cleanup").catch(() => undefined);
    rmSync(workspace, { recursive: true, force: true });
  }
});

function grantRequest(workspace: string, permissionProfile: "project", callId: string) {
  return {
    runId: "run_1",
    sessionId: "session_1",
    actor: { role: "worker" as const, id: "worker_1" },
    toolName: "process.run",
    callId,
    permissionProfile,
    workspacePath: workspace,
    access: [{ path: workspace, mode: "write" as const }],
    externalApproved: false,
    destructiveApproved: false,
    networkApproved: false,
  };
}

function commandRequest(workspace: string, executionGrant: OpaqueExecutionGrant, callId: string) {
  return {
    executable: "fixture",
    arguments: [],
    workingDirectory: workspace,
    timeoutMs: 1_000,
    context: {
      runId: "run_1",
      sessionId: "session_1",
      actor: { role: "worker" as const, id: "worker_1" },
      callId,
      toolName: "process.run",
      executionGrant,
    },
  };
}

function strictSelection(invocationId: string): ExecutionIsolationSelection {
  return {
    enforcement: "write_confinement_exact_grant",
    disclosure: "provider_specific_not_universal_boundary",
    providerId: "oci",
    implementationDigest: "a".repeat(64),
    attestation: {
      attestationVersion: 1,
      providerId: "oci",
      verified: true,
      mechanism: "fixture",
      exactGrantWriteConfinement: true,
      capabilities: { tree_termination: "enforced", crash_cleanup: "enforced", verified_emptiness: "enforced", write_confinement: "enforced" },
    },
    lease: {
      leaseId: "lease",
      providerId: "oci",
      invocationId,
      grantId: "grant",
      grantedAccess: [],
      acquiredAt: "2026-08-29T00:00:00.000Z",
      state: "active",
      providerIdentity: "a".repeat(64),
    },
  };
}
