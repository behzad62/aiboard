import assert from "node:assert/strict";
import fs from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import { createExecutionGrantAuthority } from "../src/execution-grants.js";
import {
  combineProcessRecoveryRuntimes,
  createStreamingProcessRecoveryRuntime,
  recoveryScope,
  type RecoveryAuditRecord,
  type RecoveryTarget,
} from "../src/process-recovery.js";

const now = new Date("2026-09-15T00:00:00.000Z");
const capabilities = {
  tree_termination: "enforced", crash_cleanup: "enforced",
  verified_emptiness: "enforced", write_confinement: "unverified",
} as const;

function fixtureRecord() {
  return {
    revision: 7, sessionId: "stream-session", ownerId: "stream-owner", fencingToken: 4,
    leaseExpiresAt: new Date(now.getTime() + 60_000).toISOString(), runId: "run",
    agentSessionId: "worker:run:task:1", state: "backend_unavailable",
    cleanupOwner: "session_authority", effects: [],
    lease: { providerId: "oci-provider", invocationId: "stream-invocation" },
    backendBinding: {
      registryId: "registry", backendId: "stream-backend", implementationGeneration: "generation",
      implementationDigest: "a".repeat(64), attestationVersion: 1, attestationDigest: "b".repeat(64),
      capabilities, opaqueIdentity: "opaque-stream", birthFingerprint: { observedAt: now.toISOString(), discriminator: "birth-stream" },
      rootPid: 456, startedAt: now.toISOString(),
    },
    history: [{ state: "backend_unavailable", at: now.toISOString() }],
  };
}
test("streaming recovery projects exact provider/backend identity and semantic capabilities", () => {
  const root = fs.mkdtempSync(join(tmpdir(), "aiboard-task11-streaming-project-"));
  const authority = createExecutionGrantAuthority({ clock: () => now });
  const record = fixtureRecord();
  try {
    const runtime = createStreamingProcessRecoveryRuntime({
      runtime: { canRecoverExceptional: () => true, cleanupOwnedSession: async () => ({ released: true as const }) },
      store: { readBySession: () => record as never, listSessionIds: () => [record.sessionId] },
      executionGrants: authority, permissionProfile: "full", workspacePath: root, clock: () => now,
    });
    const target = runtime.inspect("stream-invocation");
    assert.ok(target);
    assert.equal(target.scope.kind, "streaming");
    assert.equal(target.scope.logicalProcessId, record.sessionId);
    assert.equal(target.scope.sessionId, record.agentSessionId);
    assert.equal(target.scope.rootPid, 456);
    assert.match(target.scope.backendIdentity, /^[a-f0-9]{64}$/);
    assert.match(target.scope.birthFingerprint, /^[a-f0-9]{64}$/);
    assert.deepEqual(target.capabilities, capabilities);
    assert.deepEqual(target.backend, {
      backendId: "stream-backend", implementationDigest: "a".repeat(64), providerId: "oci-provider",
    });
  } finally {
    void authority.revokeAll("cleanup"); fs.rmSync(root, { recursive: true, force: true });
  }
});
test("streaming terminate uses one exact native recovery grant and verified cleanup", async () => {
  const root = fs.mkdtempSync(join(tmpdir(), "aiboard-task11-streaming-effect-"));
  const authority = createExecutionGrantAuthority({ clock: () => now });
  let record = fixtureRecord(); let cleanupCalls = 0; let authorityChecks = 0;
  const runtime = createStreamingProcessRecoveryRuntime({
    runtime: {
      canRecoverExceptional: () => true,
      cleanupOwnedSession: async (input) => {
        cleanupCalls += 1; input.assertAuthority?.(); authorityChecks += 1;
        assert.equal(authority.activeSnapshots().length, 1);
        record = { ...record, revision: record.revision + 1, state: "released",
          history: [...record.history, { state: "released", at: now.toISOString() }] };
        return { released: true as const };
      },
    },
    store: { readBySession: () => record as never, listSessionIds: () => [record.sessionId] },
    executionGrants: authority, permissionProfile: "full", workspacePath: root, clock: () => now,
  });
  try {
    const target = runtime.inspect("stream-invocation")!;
    const audit = {
      scope: recoveryScope(target), requestedAction: "terminate",
      expiresAt: new Date(now.getTime() + 60_000).toISOString(),
    } as RecoveryAuditRecord;
    const result = await runtime.execute(audit, {
      userApproved: true, signal: new AbortController().signal, assertCurrent() {},
    });
    assert.equal(cleanupCalls, 1); assert.ok(authorityChecks >= 1);
    assert.equal(result.observation, "exited");
    assert.equal(result.cleanup.state, "verified_empty");
    assert.deepEqual(authority.activeSnapshots(), []);
  } finally {
    await authority.revokeAll("cleanup"); fs.rmSync(root, { recursive: true, force: true });
  }
});

test("combined recovery fails closed on cross-kind invocation collision", () => {
  const target = (kind: "subprocess" | "streaming", logicalProcessId: string, marker: string): RecoveryTarget => ({
    scope: { kind, runId: "run", invocationId: "same", logicalProcessId, revision: 1,
      ownerId: "owner", fencingToken: 1, state: kind === "streaming" ? "outcome_unknown" : "orphaned",
      backendIdentity: marker.repeat(64), birthFingerprint: (marker === "1" ? "2" : "4").repeat(64) },
    owned: true, pendingEffects: false, capabilities, cleanup: { state: "pending" },
  });
  const subprocess = { inspect: () => target("subprocess", "sub", "1"),
    execute: async () => { throw Error("must not dispatch"); } } as never;
  const streaming = { inspect: () => target("streaming", "stream", "3"),
    execute: async () => { throw Error("must not dispatch"); } } as never;
  const combined = combineProcessRecoveryRuntimes(subprocess, streaming);
  assert.equal(combined.inspect("same"), undefined);
});


test("streaming recovery identity survives safe restart adoption generations", () => {
  const root = fs.mkdtempSync(join(tmpdir(), "aiboard-task11-streaming-identity-"));
  const authority = createExecutionGrantAuthority({ clock: () => now });
  let record = fixtureRecord();
  const runtime = createStreamingProcessRecoveryRuntime({
    runtime: { canRecoverExceptional: () => true, cleanupOwnedSession: async () => ({ released: true as const }) },
    store: { readBySession: () => record as never, listSessionIds: () => [record.sessionId] },
    executionGrants: authority, permissionProfile: "full", workspacePath: root, clock: () => now,
  });
  try {
    const before = runtime.inspect("stream-invocation")!;
    record = { ...record, backendBinding: { ...record.backendBinding,
      registryId: "registry-after-restart", implementationGeneration: "generation-after-restart" } };
    const after = runtime.inspect("stream-invocation")!;
    assert.equal(before.scope.backendIdentity, after.scope.backendIdentity);
    assert.equal(before.scope.birthFingerprint, after.scope.birthFingerprint);
  } finally {
    void authority.revokeAll("cleanup"); fs.rmSync(root, { recursive: true, force: true });
  }
});
