import assert from "node:assert/strict";
import test from "node:test";

import { projectExecutionSafetyObservability } from "../src/build-observability.js";
import type { RecoveryAuditRecord, RecoveryTarget } from "../src/process-recovery.js";

const capabilities = {
  tree_termination: "enforced", crash_cleanup: "enforced",
  verified_emptiness: "enforced", write_confinement: "unverified",
} as const;
const target: RecoveryTarget = {
  scope: { kind: "subprocess", runId: "run", invocationId: "inv", logicalProcessId: "logical",
    revision: 4, ownerId: "owner", fencingToken: 3, state: "outcome_unknown",
    backendIdentity: "a".repeat(64), birthFingerprint: "b".repeat(64) },
  owned: true, pendingEffects: false, capabilities, cleanup: { state: "pending" },
  backend: { backendId: "runner-windows-job-v1", implementationDigest: "c".repeat(64) },
  leaseExpiresAt: "2026-09-15T17:00:00.000Z", requiredCapabilities: ["tree_termination"],
  output: { totalBytes: 100, truncated: true, lossyBytes: 5 },
};
const recovery = { proposalId: "p", proposalFingerprint: "d".repeat(64), state: "user_decision_required",
  requestedAction: "terminate", cleanupState: "pending" } as RecoveryAuditRecord;
test("execution disclosure names Full bypass, backend semantics, output loss and unresolved recovery", () => {
  const result = projectExecutionSafetyObservability({
    permissionProfile: "full",
    isolation: { version: 1, boundary: "provider_specific_not_universal_security_boundary", records: [{
      occurredAt: "2026-09-15T00:00:00.000Z", runId: "run", invocationId: "inv", grantId: "secret-grant-id",
      status: "unconfined_explicit_full", enforcement: "unconfined_explicit_full", disclosure: "unconfined_explicit_full", access: [],
    }] },
    activeIsolationLeaseCount: 0,
    grantStates: ["issued"],
    processes: [target],
    recovery: { p: recovery },
  });
  assert.equal(result.fullBypass, true);
  assert.equal(result.isolation.status, "unconfined_explicit_full");
  assert.equal(result.isolation.securityBoundary, "provider_specific_not_universal_security_boundary");
  assert.deepEqual(result.grants, { active: 1, consumed: 0 });
  assert.equal(result.processes[0]?.backend?.backendId, "runner-windows-job-v1");
  assert.deepEqual(result.processes[0]?.capabilities, capabilities);
  assert.deepEqual(result.processes[0]?.output, { status: "lossy", totalBytes: 100, truncated: true, lossyBytes: 5 });
  assert.equal(result.processes[0]?.cleanup.state, "pending");
  assert.equal(result.recovery[0]?.state, "user_decision_required");
  assert.equal(JSON.stringify(result).includes("secret-grant-id"), false);
});
test("execution disclosure never upgrades absent or partial facts into confinement", () => {
  const result = projectExecutionSafetyObservability({
    permissionProfile: "project",
    isolation: { version: 1, boundary: "provider_specific_not_universal_security_boundary", records: [] },
    activeIsolationLeaseCount: 0,
    grantStates: [],
    processes: [{ ...target, capabilities: { ...capabilities, tree_termination: "unverified" }, backend: undefined, output: undefined }],
    recovery: {},
  });
  assert.equal(result.fullBypass, false);
  assert.equal(result.isolation.status, "unverified");
  assert.equal(result.processes[0]?.backend, undefined);
  assert.equal(result.processes[0]?.capabilities.tree_termination, "unverified");
  assert.deepEqual(result.processes[0]?.output, { status: "unavailable" });
});

test("execution disclosure preserves any isolation blocker even after a later success", () => {
  const result = projectExecutionSafetyObservability({
    permissionProfile: "project",
    isolation: { version: 1, boundary: "provider_specific_not_universal_security_boundary", records: [
      { occurredAt: "2026-09-15T00:00:00.000Z", runId: "run", invocationId: "blocked", grantId: "grant-a",
        status: "blocked", enforcement: "write_confinement_exact_grant", disclosure: "provider_specific_not_universal_boundary",
        providerId: "oci", access: [], blocker: "password=do-not-leak" },
      { occurredAt: "2026-09-15T00:01:00.000Z", runId: "run", invocationId: "later", grantId: "grant-b",
        status: "active", enforcement: "write_confinement_exact_grant", disclosure: "provider_specific_not_universal_boundary",
        providerId: "oci", access: [] },
    ] },
    activeIsolationLeaseCount: 1, grantStates: [], processes: [], recovery: {},
  });
  assert.equal(result.isolation.status, "blocked");
  assert.equal(result.isolation.blockers.length, 1);
  assert.equal(JSON.stringify(result).includes("do-not-leak"), false);
});

test("execution disclosure does not call a past confinement record currently active", () => {
  const result = projectExecutionSafetyObservability({
    permissionProfile: "project",
    isolation: { version: 1, boundary: "provider_specific_not_universal_security_boundary", records: [{
      occurredAt: "2026-09-15T00:00:00.000Z", runId: "run", invocationId: "old", grantId: "old-grant",
      status: "revoked", enforcement: "write_confinement_exact_grant",
      disclosure: "provider_specific_not_universal_boundary", providerId: "oci", access: [],
    }] },
    activeIsolationLeaseCount: 0, grantStates: [], processes: [], recovery: {},
  });
  assert.equal(result.isolation.status, "unverified");
  assert.equal(result.isolation.activeLeaseCount, 0);
});
