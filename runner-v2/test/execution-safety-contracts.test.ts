import assert from "node:assert/strict";
import test from "node:test";

import {
  EXECUTION_SAFETY_CAPABILITY_NAMES,
  assertDurableExecutionSafetyValue,
  cloneExecutionBackendAttestation,
  cloneDurableProcessRecord,
  cloneIsolationProviderAttestation,
  createOpaqueOneCallExecutionGrant,
  executionSafetyCapabilitiesSatisfy,
  parseDurableProcessRecord,
  parseExceptionalRecoveryOutcome,
  parseExceptionalRecoveryProposal,
  parseExecutionBackendAttestation,
  parseExecutionBackendIdentity,
  parseExecutionInvocationIntent,
  parseExactPathAccess,
  parseGenericProcessResult,
  parseIsolationProviderAttestation,
  parseIsolationLease,
  parseModelExecutionInvocationIntent,
  parseOpaqueOneCallExecutionGrant,
  parseProcessBirthFingerprint,
  parseProcessCleanupStatus,
  parseProcessEscalationHistoryEntry,
  parseProcessLifecycleHistoryEntry,
  parseProcessOutputDisposition,
  type ExecutionBackendAttestation,
  type ExecutionSafetyCapabilityName,
} from "../src/execution-safety-contracts.js";

const enforcedCapabilities: Record<ExecutionSafetyCapabilityName, "enforced"> = {
  tree_termination: "enforced",
  crash_cleanup: "enforced",
  verified_emptiness: "enforced",
  write_confinement: "enforced",
};

test("execution-safety attestations use closed semantic capability and state names", () => {
  assert.deepEqual(EXECUTION_SAFETY_CAPABILITY_NAMES, [
    "tree_termination",
    "crash_cleanup",
    "verified_emptiness",
    "write_confinement",
  ]);
  const parsed = parseExecutionBackendAttestation({
    backendId: "fixture.portable",
    mechanism: "fixture process supervisor",
    platformLabel: "fixture-os",
    capabilities: enforcedCapabilities,
  });
  assert.equal(parsed.capabilities.write_confinement, "enforced");

  assert.throws(
    () => parseExecutionBackendAttestation({
      backendId: "fixture.portable",
      mechanism: "fixture process supervisor",
      platformLabel: "fixture-os",
      capabilities: { ...enforcedCapabilities, job_object: "enforced" },
    }),
    /unknown.*capability|capability.*unknown/i,
  );
  assert.throws(
    () => parseExecutionBackendAttestation({
      backendId: "fixture.portable",
      mechanism: "fixture process supervisor",
      platformLabel: "fixture-os",
      capabilities: { ...enforcedCapabilities, crash_cleanup: "best_effort" },
    }),
    /state/i,
  );
  assert.throws(
    () => parseExecutionBackendAttestation({
      backendId: "fixture.portable",
      mechanism: "fixture process supervisor",
      platformLabel: "fixture-os",
      capabilities: enforcedCapabilities,
      nativeHandle: 42,
    }),
    /unknown.*nativeHandle/i,
  );
});

test("execution-safety attestation clones do not retain caller-owned mutable values", () => {
  const source: ExecutionBackendAttestation = {
    backendId: "fixture.portable",
    mechanism: "fixture process supervisor",
    platformLabel: "fixture-os",
    capabilities: { ...enforcedCapabilities },
  };
  const clone = cloneExecutionBackendAttestation(source);
  (source.capabilities as Record<string, string>).tree_termination = "unavailable";
  assert.equal(clone.capabilities.tree_termination, "enforced");
  assert.notEqual(clone.capabilities, source.capabilities);
});

test("isolation-provider attestations share the closed semantic capability contract", () => {
  const source = {
    providerId: "fixture.isolation",
    mechanism: "fixture isolated executor",
    platformLabel: "fixture-os",
    capabilities: { ...enforcedCapabilities } as Record<
      ExecutionSafetyCapabilityName,
      "enforced" | "unavailable"
    >,
  };
  const parsed = parseIsolationProviderAttestation(source);
  const clone = cloneIsolationProviderAttestation(parsed);
  source.capabilities.write_confinement = "unavailable";
  assert.equal(clone.capabilities.write_confinement, "enforced");
  assert.throws(
    () => parseIsolationProviderAttestation({ ...source, platformFamily: "fixture" }),
    /unknown.*platformFamily/i,
  );
});

test("durable execution-safety values reject handles, secret material, and live values", () => {
  assert.doesNotThrow(() => assertDurableExecutionSafetyValue({
    backendIdentity: { backendId: "fixture.portable", opaqueIdentity: "process-identity-7" },
    artifactIds: ["stdout-7", "stderr-7"],
  }));
  assert.throws(
    () => assertDurableExecutionSafetyValue({ cleanup: { nativeHandle: 1234 } }),
    /nativeHandle/i,
  );
  assert.throws(
    () => assertDurableExecutionSafetyValue({ grant: { credentialValue: "secret" } }),
    /credentialValue/i,
  );
  assert.throws(
    () => assertDurableExecutionSafetyValue({ grant: { oneCallToken: "secret" } }),
    /oneCallToken/i,
  );
  assert.throws(
    () => assertDurableExecutionSafetyValue({ process: { nativeFd: 7 } }),
    /nativeFd/i,
  );
  assert.throws(
    () => assertDurableExecutionSafetyValue({ process: { nativeDescriptor: 7 } }),
    /nativeDescriptor/i,
  );
  assert.throws(
    () => assertDurableExecutionSafetyValue({ close: () => undefined }),
    /durable/i,
  );
});

test("durable execution-safety parsers reject undeclared fields at every frozen shape", () => {
  const cases: Array<[string, (value: unknown) => unknown, Record<string, unknown>]> = [
    ["invocation", parseExecutionInvocationIntent, validInvocation()],
    ["path access", parseExactPathAccess, validPathAccess()],
    ["grant", parseOpaqueOneCallExecutionGrant, validGrant()],
    ["birth fingerprint", parseProcessBirthFingerprint, validBirthFingerprint()],
    ["backend identity", parseExecutionBackendIdentity, validBackendIdentity()],
    ["lifecycle", parseProcessLifecycleHistoryEntry, validLifecycle()],
    ["escalation", parseProcessEscalationHistoryEntry, validEscalation()],
    ["cleanup", parseProcessCleanupStatus, validCleanup()],
    ["output", parseProcessOutputDisposition, validOutput()],
    ["process record", parseDurableProcessRecord, validProcessRecord()],
    ["process result", parseGenericProcessResult, validProcessResult()],
    ["isolation lease", parseIsolationLease, validLease()],
    ["recovery proposal", parseExceptionalRecoveryProposal, validRecoveryProposal()],
    ["recovery outcome", parseExceptionalRecoveryOutcome, validRecoveryOutcome()],
  ];
  for (const [label, parse, value] of cases) {
    assert.doesNotThrow(() => parse(value), `${label} fixture must be valid`);
    assert.throws(
      () => parse({ ...value, undeclared: true }),
      /unknown.*undeclared/i,
      `${label} must be closed`,
    );
  }

  assert.throws(
    () => parseExecutionBackendIdentity({ ...validBackendIdentity(), nativeDescriptor: 7 }),
    /unknown.*nativeDescriptor/i,
  );
  assert.throws(
    () => parseDurableProcessRecord({ ...validProcessRecord(), nativeFd: 7 }),
    /unknown.*nativeFd/i,
  );
});

test("model invocation parsing rejects forged grants while Runner-created grants are branded and call-bound", () => {
  assert.throws(
    () => parseModelExecutionInvocationIntent({
      ...validInvocation(),
      grant: validGrant(),
    }),
    /unknown.*grant|grant.*model/i,
  );
  const grant = createOpaqueOneCallExecutionGrant(validGrant());
  assert.equal(grant.invocationId, "invocation-1");
  assert.equal(parseOpaqueOneCallExecutionGrant(grant).grantId, "grant-1");
});

test("durable process clones own every nested mutable value", () => {
  const source = validProcessRecord();
  const clone = cloneDurableProcessRecord(source);
  (source.lifecycle as Array<Record<string, unknown>>)[0]!.state = "cleanup_failed";
  (source.logArtifactIds as string[]).push("forged-log");
  assert.equal(clone.lifecycle[0]?.state, "running");
  assert.deepEqual(clone.logArtifactIds, ["log-1"]);
});

test("capability comparison selects semantic enforcement independently of mechanism labels", () => {
  const first = parseExecutionBackendAttestation({
    backendId: "fixture.first",
    mechanism: "alpha",
    platformLabel: "host-a",
    capabilities: enforcedCapabilities,
  });
  const second = parseExecutionBackendAttestation({
    backendId: "fixture.second",
    mechanism: "beta",
    platformLabel: "host-b",
    capabilities: { ...enforcedCapabilities, write_confinement: "partial" },
  });
  assert.equal(
    executionSafetyCapabilitiesSatisfy(first.capabilities, ["tree_termination", "write_confinement"]),
    true,
  );
  assert.equal(
    executionSafetyCapabilitiesSatisfy(second.capabilities, ["tree_termination", "write_confinement"]),
    false,
  );
});

function validInvocation(): Record<string, unknown> {
  return {
    invocationId: "invocation-1",
    runId: "run-1",
    taskId: "task-1",
    sessionId: "session-1",
    kind: "command",
    executable: "fixture-command",
    arguments: ["--fixture"],
    workingDirectory: "C:\\fixture",
    requestedCapabilities: ["tree_termination"],
  };
}

function validPathAccess(): Record<string, unknown> {
  return { canonicalPath: "C:\\fixture", mode: "write" };
}

function validGrant(): Record<string, unknown> {
  return {
    grantId: "grant-1",
    invocationId: "invocation-1",
    issuedAt: "2026-08-28T00:00:00.000Z",
    expiresAt: "2026-08-28T00:01:00.000Z",
    access: [validPathAccess()],
    state: "issued",
  };
}

function validBirthFingerprint(): Record<string, unknown> {
  return { observedAt: "2026-08-28T00:00:00.000Z", discriminator: "birth-1" };
}

function validBackendIdentity(): Record<string, unknown> {
  return { backendId: "fixture.portable", opaqueIdentity: "identity-1" };
}

function validLifecycle(): Record<string, unknown> {
  return { state: "running", at: "2026-08-28T00:00:00.000Z", reason: "launched" };
}

function validEscalation(): Record<string, unknown> {
  return {
    action: "terminate",
    at: "2026-08-28T00:00:01.000Z",
    outcome: "requested",
    detail: "timeout",
  };
}

function validCleanup(): Record<string, unknown> {
  return {
    state: "verified_empty",
    verifiedAt: "2026-08-28T00:00:02.000Z",
    proofArtifactId: "cleanup-proof-1",
  };
}

function validOutput(): Record<string, unknown> {
  return {
    stream: "stdout",
    tail: "fixture output",
    totalBytes: 14,
    truncated: false,
    spillArtifactId: "spill-1",
    spillBytes: 14,
    lossyBytes: 0,
  };
}

function validProcessRecord(): Record<string, unknown> {
  return {
    logicalProcessId: "process-1",
    runId: "run-1",
    taskId: "task-1",
    sessionId: "session-1",
    invocationId: "invocation-1",
    rootPid: 123,
    birthFingerprint: validBirthFingerprint(),
    backend: validBackendIdentity(),
    attestedCapabilities: { ...enforcedCapabilities },
    lifecycle: [validLifecycle()],
    escalation: [validEscalation()],
    logArtifactIds: ["log-1"],
    spillArtifactIds: ["spill-1"],
    cleanup: validCleanup(),
  };
}

function validProcessResult(): Record<string, unknown> {
  return {
    logicalProcessId: "process-1",
    outcome: "exited",
    exitCode: 0,
    signal: "none",
    startedAt: "2026-08-28T00:00:00.000Z",
    finishedAt: "2026-08-28T00:00:02.000Z",
    output: [validOutput()],
    cleanup: validCleanup(),
  };
}

function validLease(): Record<string, unknown> {
  return {
    leaseId: "lease-1",
    providerId: "fixture.isolation",
    invocationId: "invocation-1",
    grantedAccess: [validPathAccess()],
    acquiredAt: "2026-08-28T00:00:00.000Z",
    expiresAt: "2026-08-28T00:01:00.000Z",
    state: "active",
  };
}

function validRecoveryProposal(): Record<string, unknown> {
  return {
    proposalId: "proposal-1",
    logicalProcessId: "process-1",
    birthFingerprint: validBirthFingerprint(),
    requestedAction: "inspect",
    targetScope: ["process-1"],
    rationale: "bounded recovery",
    requiresUserAuthority: false,
  };
}

function validRecoveryOutcome(): Record<string, unknown> {
  return {
    proposalId: "proposal-1",
    state: "executed",
    decidedAt: "2026-08-28T00:00:03.000Z",
    detail: "recovered",
    evidenceArtifactIds: ["evidence-1"],
  };
}
