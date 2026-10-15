import assert from "node:assert/strict";
import test from "node:test";

import type { EvidenceRecord } from "../src/evidence-store.js";
import {
  assessObservationForAcceptance,
  createValidationObservation,
  recordFaultInjection,
  recordFlakyIsolation,
  recordRedGreenPair,
  type AcceptanceAssessmentInput,
  type CreateObservationInput,
  type MeaningfulObservation,
} from "../src/validation-observation.js";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

function baseInput(overrides: Partial<CreateObservationInput> = {}): CreateObservationInput {
  return {
    id: "obs_1",
    intentId: "intent_1",
    evidenceId: "evidence_1",
    command: "npm test",
    method: "junit",
    methodSupported: true,
    snapshotRevision: "rev_1",
    dirty: false,
    exitCode: 0,
    fingerprints: { environment: "env_1", capability: "cap_1", config: "cfg_1", dependency: "dep_1" },
    outcome: "passed",
    counts: { selected: 3, passed: 3, failed: 0, skipped: 0 },
    selectedAssertionIds: ["assert_login", "assert_logout", "assert_session"],
    artifactHashes: [HASH_A],
    ...overrides,
  };
}

function green(overrides: Partial<CreateObservationInput> = {}) {
  return createValidationObservation(baseInput(overrides));
}

test("exit 0 with zero selected tests cannot satisfy acceptance", () => {
  assert.throws(() => green({ counts: { selected: 0, passed: 0, failed: 0, skipped: 0 } }), /at least one passing assertion/);
  const unknown = createValidationObservation(baseInput({ outcome: "unknown", counts: { selected: 0, passed: 0, failed: 0, skipped: 0 }, selectedAssertionIds: [] }));
  const assessment = assessObservationForAcceptance({
    observation: unknown,
    requiredAssertionIds: ["assert_login"],
    expectedSnapshotRevision: "rev_1",
    expectedDirty: false,
    expectedEnvironmentFingerprint: "env_1",
    expectedCapabilityFingerprint: "cap_1",
    expectedConfigFingerprint: "cfg_1",
    expectedDependencyFingerprint: "dep_1",
    expectedArtifactHashes: [HASH_A],
    isRequiredPassingTest: true,
  });
  assert.equal(assessment.satisfies, false);
  assert.ok(assessment.reasons.some((r) => r.includes("Zero selected")));
});

test("no relevant assertions cannot satisfy acceptance", () => {
  const obs = green({ selectedAssertionIds: ["assert_unrelated"] });
  const assessment = assessObservationForAcceptance({
    observation: obs,
    requiredAssertionIds: ["assert_login"],
    expectedSnapshotRevision: "rev_1",
    expectedDirty: false,
    expectedEnvironmentFingerprint: "env_1",
    expectedCapabilityFingerprint: "cap_1",
    expectedConfigFingerprint: "cfg_1",
    expectedDependencyFingerprint: "dep_1",
    expectedArtifactHashes: [HASH_A],
    isRequiredPassingTest: false,
  });
  assert.equal(assessment.satisfies, false);
  assert.ok(assessment.reasons.some((r) => r.includes("never exercised")));
});

test("unexplained skip cannot satisfy acceptance", () => {
  assert.throws(() => green({
    counts: { selected: 3, passed: 2, failed: 0, skipped: 1 },
    skippedAssertionIds: ["assert_skip"],
  }), /skipRationale/);
  const obs = green({
    counts: { selected: 3, passed: 2, failed: 0, skipped: 1 },
    skippedAssertionIds: ["assert_skip"],
    skipRationale: "todo: platform-specific, tracked",
  });
  const assessment = assessObservationForAcceptance({
    observation: obs,
    requiredAssertionIds: ["assert_login"],
    expectedSnapshotRevision: "rev_1",
    expectedDirty: false,
    expectedEnvironmentFingerprint: "env_1",
    expectedCapabilityFingerprint: "cap_1",
    expectedConfigFingerprint: "cfg_1",
    expectedDependencyFingerprint: "dep_1",
    expectedArtifactHashes: [HASH_A],
    isRequiredPassingTest: false,
  });
  assert.equal(assessment.satisfies, true);
});

test("stale dirty-tree hash cannot satisfy acceptance", () => {
  assert.throws(() => green({ dirty: true, dirtySummary: "2 files" }), /uncommittedContentDigest/);
  const obs = green({ dirty: true, dirtySummary: "2 files", uncommittedContentDigest: "digest_old" });
  const assessment = assessObservationForAcceptance({
    observation: obs,
    requiredAssertionIds: ["assert_login"],
    expectedSnapshotRevision: "rev_1",
    expectedDirty: true,
    expectedUncommittedContentDigest: "digest_new",
    expectedEnvironmentFingerprint: "env_1",
    expectedCapabilityFingerprint: "cap_1",
    expectedConfigFingerprint: "cfg_1",
    expectedDependencyFingerprint: "dep_1",
    expectedArtifactHashes: [HASH_A],
    isRequiredPassingTest: false,
  });
  assert.equal(assessment.satisfies, false);
  assert.ok(assessment.reasons.some((r) => r.includes("Stale dirty-tree")));
});

test("substituted artifact cannot satisfy acceptance", () => {
  const obs = green();
  const assessment = assessObservationForAcceptance({
    observation: obs,
    requiredAssertionIds: ["assert_login"],
    expectedSnapshotRevision: "rev_1",
    expectedDirty: false,
    expectedEnvironmentFingerprint: "env_1",
    expectedCapabilityFingerprint: "cap_1",
    expectedConfigFingerprint: "cfg_1",
    expectedDependencyFingerprint: "dep_1",
    expectedArtifactHashes: [HASH_B],
    isRequiredPassingTest: false,
  });
  assert.equal(assessment.satisfies, false);
  assert.ok(assessment.reasons.some((r) => r.includes("Substituted artifact")));
});

test("wrong environment or capability cannot satisfy acceptance", () => {
  const obs = green();
  const wrongEnv = assessObservationForAcceptance({
    observation: obs,
    requiredAssertionIds: ["assert_login"],
    expectedSnapshotRevision: "rev_1",
    expectedDirty: false,
    expectedEnvironmentFingerprint: "env_other",
    expectedCapabilityFingerprint: "cap_1",
    expectedConfigFingerprint: "cfg_1",
    expectedDependencyFingerprint: "dep_1",
    expectedArtifactHashes: [HASH_A],
    isRequiredPassingTest: false,
  });
  assert.equal(wrongEnv.satisfies, false);
  assert.ok(wrongEnv.reasons.some((r) => r.includes("Wrong environment")));
  const wrongCap = assessObservationForAcceptance({
    observation: obs,
    requiredAssertionIds: ["assert_login"],
    expectedSnapshotRevision: "rev_1",
    expectedDirty: false,
    expectedEnvironmentFingerprint: "env_1",
    expectedCapabilityFingerprint: "cap_other",
    expectedConfigFingerprint: "cfg_1",
    expectedDependencyFingerprint: "dep_1",
    expectedArtifactHashes: [HASH_A],
    isRequiredPassingTest: false,
  });
  assert.equal(wrongCap.satisfies, false);
  assert.ok(wrongCap.reasons.some((r) => r.includes("Wrong capability")));
});

test("unrelated RED cannot pair and a prose claim cannot satisfy acceptance", () => {
  const red = createValidationObservation(baseInput({
    id: "obs_red", intentId: "intent_other", outcome: "failed", exitCode: 1,
    counts: { selected: 1, passed: 0, failed: 1, skipped: 0 },
  }));
  const greenObs = green();
  assert.throws(() => recordRedGreenPair({ defectId: "d1", red, green: greenObs, redFailureClass: "assertion" }), /same intent/);

  const prose = createValidationObservation(baseInput({ method: "prose", command: "npm test" }));
  const assessment = assessObservationForAcceptance({
    observation: prose,
    requiredAssertionIds: ["assert_login"],
    expectedSnapshotRevision: "rev_1",
    expectedDirty: false,
    expectedEnvironmentFingerprint: "env_1",
    expectedCapabilityFingerprint: "cap_1",
    expectedConfigFingerprint: "cfg_1",
    expectedDependencyFingerprint: "dep_1",
    expectedArtifactHashes: [HASH_A],
    isRequiredPassingTest: false,
  });
  assert.equal(assessment.satisfies, false);
  assert.ok(assessment.reasons.some((r) => r.includes("prose claim")));
});

test("a literal zero-selected passed record cannot satisfy acceptance", () => {
  // Hand-built record (e.g. legacy/stale): createValidationObservation would
  // reject it via T1, but the acceptance gate must also fail closed on it.
  const literal = {
    observation: {
      id: "obs_legacy",
      intentId: "intent_1",
      evidenceId: "evidence_1",
      command: "npm test",
      method: "junit",
      snapshotRevision: "rev_1",
      dirty: false,
      exitCode: 0,
      environmentFingerprint: "env_1",
      configFingerprint: "cfg_1",
      dependencyFingerprint: "dep_1",
      outcome: "passed",
      counts: { selected: 0, passed: 0, failed: 0, skipped: 0 },
      selectedAssertionIds: ["assert_login"],
    },
    capabilityFingerprint: "cap_1",
    artifactHashes: [HASH_A],
  } as const;
  const assessment = assessObservationForAcceptance({
    observation: literal,
    requiredAssertionIds: ["assert_login"],
    expectedSnapshotRevision: "rev_1",
    expectedDirty: false,
    expectedEnvironmentFingerprint: "env_1",
    expectedCapabilityFingerprint: "cap_1",
    expectedConfigFingerprint: "cfg_1",
    expectedDependencyFingerprint: "dep_1",
    expectedArtifactHashes: [HASH_A],
    isRequiredPassingTest: true,
  });
  assert.equal(assessment.satisfies, false);
  assert.ok(assessment.reasons.some((r) => r.includes("Zero selected")));
});

test("unsupported output is unknown, never guessed green", () => {
  assert.throws(() => green({ methodSupported: false, outcome: "passed" }), /never passed/);
  const unknown = createValidationObservation(baseInput({ methodSupported: false, outcome: "unknown" }));
  assert.equal(unknown.observation.outcome, "unknown");
});

test("RG-2: failing-command evidence cannot satisfy a required passing test via rationale", () => {
  const failingRecord: EvidenceRecord = {
    id: "evidence_red",
    runId: "run_1",
    taskId: "task_1",
    actor: { role: "worker", id: "worker_1" },
    status: "observed",
    fact: {
      kind: "command", label: "red", command: "npm", args: ["test"], cwd: "/w",
      startedAt: "2026-01-01T00:00:00.000Z", finishedAt: "2026-01-01T00:00:01.000Z",
      exitCode: 1, signal: null, timedOut: false, cancelled: false, outputTruncated: false,
      stdoutArtifactHash: HASH_A, stderrArtifactHash: HASH_B,
    },
    createdAt: "2026-01-01T00:00:01.000Z",
    idempotencyKey: "k1",
  };
  const red = createValidationObservation(baseInput({
    id: "obs_red", evidenceId: "evidence_red", outcome: "failed", exitCode: 1,
    counts: { selected: 1, passed: 0, failed: 1, skipped: 0 },
  }));
  const assessment = assessObservationForAcceptance({
    observation: red,
    requiredAssertionIds: ["assert_login"],
    expectedSnapshotRevision: "rev_1",
    expectedDirty: false,
    expectedEnvironmentFingerprint: "env_1",
    expectedCapabilityFingerprint: "cap_1",
    expectedConfigFingerprint: "cfg_1",
    expectedDependencyFingerprint: "dep_1",
    expectedArtifactHashes: [HASH_A],
    isRequiredPassingTest: true,
    citedEvidenceRecords: [failingRecord],
    acceptedFailures: [{ evidenceId: "evidence_red", rationale: "intentional RED for defect detection" }],
    rationale: "the failure is understood",
  });
  assert.equal(assessment.satisfies, false);
  assert.ok(assessment.reasons.some((r) => r.includes("RG-2")));
});

test("RG-2: an accepted RED citation cannot discharge a required passing test even when the observation is green", () => {
  // A green non-process observation (exitCode null) that cites failing
  // command evidence with an acceptedFailures entry: RG-2's citation rule
  // passes, but the required-GREEN gate must still refuse the accepted RED.
  const failingRecord: EvidenceRecord = {
    id: "evidence_red",
    runId: "run_1",
    taskId: "task_1",
    actor: { role: "worker", id: "worker_1" },
    status: "observed",
    fact: {
      kind: "command", label: "red", command: "npm", args: ["test"], cwd: "/w",
      startedAt: "2026-01-01T00:00:00.000Z", finishedAt: "2026-01-01T00:00:01.000Z",
      exitCode: 1, signal: null, timedOut: false, cancelled: false, outputTruncated: false,
      stdoutArtifactHash: HASH_A, stderrArtifactHash: HASH_B,
    },
    createdAt: "2026-01-01T00:00:01.000Z",
    idempotencyKey: "k1",
  };
  const browserGreen = createValidationObservation(baseInput({
    id: "obs_browser", method: "browser_assertion", exitCode: null,
  }));
  const assessment = assessObservationForAcceptance({
    observation: browserGreen,
    requiredAssertionIds: ["assert_login"],
    expectedSnapshotRevision: "rev_1",
    expectedDirty: false,
    expectedEnvironmentFingerprint: "env_1",
    expectedCapabilityFingerprint: "cap_1",
    expectedConfigFingerprint: "cfg_1",
    expectedDependencyFingerprint: "dep_1",
    expectedArtifactHashes: [HASH_A],
    isRequiredPassingTest: true,
    citedEvidenceRecords: [failingRecord],
    acceptedFailures: [{ evidenceId: "evidence_red", rationale: "intentional RED" }],
  });
  assert.equal(assessment.satisfies, false);
  assert.ok(assessment.reasons.some((r) => r.includes("RG-2")));
});

test("RED->GREEN pair records the same defect; harness failures are not proof", () => {
  const red = createValidationObservation(baseInput({
    id: "obs_red", outcome: "failed", exitCode: 1,
    counts: { selected: 1, passed: 0, failed: 1, skipped: 0 },
  }));
  const greenObs = green({ id: "obs_green" });
  const pair = recordRedGreenPair({ defectId: "d_login", red, green: greenObs, redFailureClass: "assertion" });
  assert.deepEqual(pair, { defectId: "d_login", redObservationId: "obs_red", greenObservationId: "obs_green" });
  assert.throws(
    () => recordRedGreenPair({ defectId: "d2", red, green: greenObs, redFailureClass: "harness" }),
    /harness\/setup failure/,
  );
});

test("fault injection retains the test, restores only the fault, and refuses protected-evidence mutation", () => {
  const record = recordFaultInjection({
    guardId: "guard_auth",
    defectId: "d_guard",
    faultDescription: "flip boundary check",
    retainedTestId: "test_boundary",
    testRetained: true,
    originalSnapshotDigest: "digest_abc",
    restoredSnapshotDigest: "digest_abc",
    changedFiles: ["src/auth.ts"],
    allowedGuardFiles: ["src/auth.ts"],
    noExistingRedGreenForDefect: true,
    protectedEvidenceMutated: false,
  });
  assert.deepEqual(record, { guardId: "guard_auth", defectId: "d_guard", retainedTestId: "test_boundary" });
  assert.throws(() => recordFaultInjection({
    guardId: "g", defectId: "d", faultDescription: "f", retainedTestId: "t", testRetained: false,
    originalSnapshotDigest: "a", restoredSnapshotDigest: "a", changedFiles: [], allowedGuardFiles: [],
    noExistingRedGreenForDefect: true, protectedEvidenceMutated: false,
  }), /retain the catching test/);
  assert.throws(() => recordFaultInjection({
    guardId: "g", defectId: "d", faultDescription: "f", retainedTestId: "t", testRetained: true,
    originalSnapshotDigest: "a", restoredSnapshotDigest: "b", changedFiles: [], allowedGuardFiles: [],
    noExistingRedGreenForDefect: true, protectedEvidenceMutated: false,
  }), /restore only the fault/);
  assert.throws(() => recordFaultInjection({
    guardId: "g", defectId: "d", faultDescription: "f", retainedTestId: "t", testRetained: true,
    originalSnapshotDigest: "a", restoredSnapshotDigest: "a", changedFiles: [], allowedGuardFiles: [],
    noExistingRedGreenForDefect: true, protectedEvidenceMutated: true,
  }), /protected evidence/);
  assert.throws(() => recordFaultInjection({
    guardId: "g", defectId: "d", faultDescription: "f", retainedTestId: "t", testRetained: true,
    originalSnapshotDigest: "a", restoredSnapshotDigest: "a", changedFiles: [], allowedGuardFiles: [],
    noExistingRedGreenForDefect: false, protectedEvidenceMutated: false,
  }), /Redundant same-defect/);
  assert.throws(() => recordFaultInjection({
    guardId: "g", defectId: "d", faultDescription: "f", retainedTestId: "t", testRetained: true,
    originalSnapshotDigest: "a", restoredSnapshotDigest: "a", changedFiles: ["src/other.ts"], allowedGuardFiles: ["src/auth.ts"],
    noExistingRedGreenForDefect: true, protectedEvidenceMutated: false,
  }), /outside the isolated guard/);
});

test("flaky isolation re-runs only failing tests once on the same revision and environment", () => {
  const first = createValidationObservation(baseInput({
    id: "obs_first", outcome: "failed", exitCode: 1,
    counts: { selected: 5, passed: 3, failed: 2, skipped: 0 },
    selectedAssertionIds: ["a1", "a2", "a3", "a4", "a5"],
  }));
  const rerunPass = createValidationObservation(baseInput({
    id: "obs_rerun", outcome: "passed", exitCode: 0,
    counts: { selected: 2, passed: 2, failed: 0, skipped: 0 },
    selectedAssertionIds: ["a4", "a5"],
  }));
  const flaky = recordFlakyIsolation({ first, rerun: rerunPass, priorRerunCount: 0, failedAssertionIds: ["a4", "a5"] });
  assert.equal(flaky.outcome, "flaky");
  assert.deepEqual(flaky.rerunSelectedAssertionIds, ["a4", "a5"]);

  const rerunFail = createValidationObservation(baseInput({
    id: "obs_rerun2", outcome: "failed", exitCode: 1,
    counts: { selected: 2, passed: 0, failed: 2, skipped: 0 },
    selectedAssertionIds: ["a4", "a5"],
  }));
  const consistent = recordFlakyIsolation({ first, rerun: rerunFail, priorRerunCount: 0, failedAssertionIds: ["a4", "a5"] });
  assert.equal(consistent.outcome, "consistent_failure");

  assert.throws(() => recordFlakyIsolation({ first, rerun: rerunPass, priorRerunCount: 1, failedAssertionIds: ["a4", "a5"] }), /once/);
  const wrongEnv = createValidationObservation(baseInput({
    id: "obs_rerun3", outcome: "passed", exitCode: 0,
    counts: { selected: 2, passed: 2, failed: 0, skipped: 0 },
    selectedAssertionIds: ["a4", "a5"],
    fingerprints: { environment: "env_other", capability: "cap_1", config: "cfg_1", dependency: "dep_1" },
  }));
  assert.throws(() => recordFlakyIsolation({ first, rerun: wrongEnv, priorRerunCount: 0, failedAssertionIds: ["a4", "a5"] }), /same environment/);
  const tooMany = createValidationObservation(baseInput({
    id: "obs_rerun4", outcome: "passed", exitCode: 0,
    counts: { selected: 5, passed: 5, failed: 0, skipped: 0 },
    selectedAssertionIds: ["a1", "a2", "a3", "a4", "a5"],
  }));
  assert.throws(() => recordFlakyIsolation({ first, rerun: tooMany, priorRerunCount: 0, failedAssertionIds: ["a4", "a5"] }), /only the failing tests/);
});

// ---------------------------------------------------------------------------
// Repair cycle 1: fail-closed regression tests (independent review probes).
// Each asserts the actual acceptance result, not only which rung fired.
// ---------------------------------------------------------------------------

function assessRepair(
  obs: MeaningfulObservation,
  over: Partial<AcceptanceAssessmentInput> = {},
): ReturnType<typeof assessObservationForAcceptance> {
  return assessObservationForAcceptance({
    observation: obs,
    requiredAssertionIds: ["assert_login"],
    expectedSnapshotRevision: "rev_1",
    expectedDirty: false,
    expectedEnvironmentFingerprint: "env_1",
    expectedCapabilityFingerprint: "cap_1",
    expectedConfigFingerprint: "cfg_1",
    expectedDependencyFingerprint: "dep_1",
    expectedArtifactHashes: [HASH_A],
    isRequiredPassingTest: false,
    ...over,
  });
}

test("repair B1: a passed observation with zero passing assertions is rejected", () => {
  assert.throws(() => green({
    counts: { selected: 3, passed: 0, failed: 0, skipped: 3 },
    skippedAssertionIds: ["assert_login", "assert_logout", "assert_session"],
    skipRationale: "all skipped",
  }), /at least one passing assertion/);
  const literal = {
    observation: {
      id: "obs_all_skipped",
      intentId: "intent_1",
      evidenceId: "evidence_1",
      command: "npm test",
      method: "junit",
      snapshotRevision: "rev_1",
      dirty: false,
      exitCode: 0,
      environmentFingerprint: "env_1",
      configFingerprint: "cfg_1",
      dependencyFingerprint: "dep_1",
      outcome: "passed",
      counts: { selected: 2, passed: 0, failed: 0, skipped: 2 },
      selectedAssertionIds: ["assert_login", "assert_logout"],
      skippedAssertionIds: ["assert_login", "assert_logout"],
    },
    capabilityFingerprint: "cap_1",
    artifactHashes: [HASH_A],
    skipRationale: "skip",
  } as unknown as MeaningfulObservation;
  const assessment = assessRepair(literal);
  assert.equal(assessment.satisfies, false);
  assert.ok(assessment.reasons.some((r) => r.includes("No passing assertions")));
});

test("repair B4: dirty observation against a clean tree (and reverse) is stale", () => {
  const dirty = green({ dirty: true, dirtySummary: "M src/a.ts", uncommittedContentDigest: "dirtyX" });
  const staleWithDigest = assessRepair(dirty, { expectedUncommittedContentDigest: "dirtyX" });
  assert.equal(staleWithDigest.satisfies, false);
  assert.ok(staleWithDigest.reasons.some((r) => r.includes("Stale dirty-tree evidence")));
  const againstClean = assessRepair(dirty);
  assert.equal(againstClean.satisfies, false);
  assert.ok(againstClean.reasons.some((r) => r.includes("Stale dirty-tree evidence")));
  const clean = green();
  const againstDirty = assessRepair(clean, { expectedDirty: true, expectedUncommittedContentDigest: "dirtyX" });
  assert.equal(againstDirty.satisfies, false);
  assert.ok(againstDirty.reasons.some((r) => r.includes("Stale clean-tree evidence")));
  const missingDigest = assessRepair(dirty, { expectedDirty: true });
  assert.equal(missingDigest.satisfies, false);
  assert.ok(missingDigest.reasons.some((r) => r.includes("missing uncommitted-content digest")));
  const matching = assessRepair(dirty, { expectedDirty: true, expectedUncommittedContentDigest: "dirtyX" });
  assert.equal(matching.satisfies, true);
});

test("repair B5: skipped, unselected, or undeclared required assertions fail acceptance", () => {
  const skippedRequired = green({
    counts: { selected: 3, passed: 2, failed: 0, skipped: 1 },
    skippedAssertionIds: ["assert_login"],
    skipRationale: "n/a",
  });
  const skipped = assessRepair(skippedRequired);
  assert.equal(skipped.satisfies, false);
  assert.ok(skipped.reasons.some((r) => r.includes("Required assertions skipped")));
  const partial = green({
    selectedAssertionIds: ["assert_login"],
    counts: { selected: 1, passed: 1, failed: 0, skipped: 0 },
  });
  const partialAssessment = assessRepair(partial, { requiredAssertionIds: ["assert_login", "assert_logout", "assert_session"] });
  assert.equal(partialAssessment.satisfies, false);
  assert.ok(partialAssessment.reasons.some((r) => r.includes("never exercised")));
  const empty = assessRepair(green(), { requiredAssertionIds: [] });
  assert.equal(empty.satisfies, false);
  assert.ok(empty.reasons.some((r) => r.includes("No required assertions declared")));
});

test("repair N2: config or dependency fingerprint drift fails acceptance", () => {
  const drifted = createValidationObservation(baseInput({
    fingerprints: { environment: "env_1", capability: "cap_1", config: "OLDcfg", dependency: "OLDdep" },
  }));
  const assessment = assessRepair(drifted);
  assert.equal(assessment.satisfies, false);
  assert.ok(assessment.reasons.some((r) => r.includes("Wrong config")));
  assert.ok(assessment.reasons.some((r) => r.includes("Wrong dependency")));
  const missing = assessObservationForAcceptance({
    observation: green(),
    requiredAssertionIds: ["assert_login"],
    expectedSnapshotRevision: "rev_1",
    expectedDirty: false,
    expectedEnvironmentFingerprint: "env_1",
    expectedCapabilityFingerprint: "cap_1",
    expectedArtifactHashes: [HASH_A],
    isRequiredPassingTest: false,
  });
  assert.equal(missing.satisfies, false);
  assert.ok(missing.reasons.some((r) => r.includes("Missing config/dependency expectation")));
});

test("repair N3: prose under another method name cannot satisfy acceptance", () => {
  const claim = createValidationObservation(baseInput({ method: "manual-claim", command: "reviewer says it works" }));
  const assessment = assessRepair(claim);
  assert.equal(assessment.satisfies, false);
  assert.ok(assessment.reasons.some((r) => r.includes("prose claim")));
});

test("repair N4 (cycle 2): empty artifact expectations and assertion-less methods fail acceptance", () => {
  const obs = green();
  const emptyArtifacts = assessRepair(obs, { expectedArtifactHashes: [] });
  assert.equal(emptyArtifacts.satisfies, false);
  assert.ok(emptyArtifacts.reasons.some((r) => r.includes("No expected artifacts declared")));
  for (const method of ["command", "exit_code"]) {
    const cmd = createValidationObservation(baseInput({ method }));
    const assessment = assessRepair(cmd);
    assert.equal(assessment.satisfies, false, method);
    assert.ok(assessment.reasons.some((r) => r.includes("prose claim")), method);
  }
});

test("repair N5 (cycle 2): the rerun must repeat exactly the failing tests", () => {
  const first = createValidationObservation(baseInput({
    id: "obs_first",
    outcome: "failed",
    exitCode: 1,
    counts: { selected: 3, passed: 2, failed: 1, skipped: 0 },
    selectedAssertionIds: ["a1", "a2", "a3"],
  }));
  const passingRerun = createValidationObservation(baseInput({
    id: "obs_rerun_a1",
    counts: { selected: 1, passed: 1, failed: 0, skipped: 0 },
    selectedAssertionIds: ["a1"],
  }));
  // a1 was selected by the first run, but the failure was a3: refused.
  assert.throws(
    () => recordFlakyIsolation({ first, rerun: passingRerun, priorRerunCount: 0, failedAssertionIds: ["a3"] }),
    /only the failing tests/,
  );
  // Without the failing ids the rerun cannot be shown to repeat the failure.
  assert.throws(
    () => recordFlakyIsolation({
      first,
      rerun: passingRerun,
      priorRerunCount: 0,
      failedAssertionIds: [],
    }),
    /failing assertion ids/,
  );
  // The exact failing test re-run records flaky.
  const failingRerun = createValidationObservation(baseInput({
    id: "obs_rerun_a3",
    counts: { selected: 1, passed: 1, failed: 0, skipped: 0 },
    selectedAssertionIds: ["a3"],
  }));
  const flaky = recordFlakyIsolation({ first, rerun: failingRerun, priorRerunCount: 0, failedAssertionIds: ["a3"] });
  assert.equal(flaky.outcome, "flaky");
  assert.deepEqual(flaky.rerunSelectedAssertionIds, ["a3"]);
});

test("repair N4: flaky isolation rejects different tests, fingerprints, and skips", () => {
  const first = createValidationObservation(baseInput({
    id: "obs_first",
    outcome: "failed",
    exitCode: 1,
    counts: { selected: 3, passed: 2, failed: 1, skipped: 0 },
    selectedAssertionIds: ["a1", "a2", "a3"],
  }));
  const differentTests = createValidationObservation(baseInput({
    id: "obs_rerun",
    counts: { selected: 1, passed: 1, failed: 0, skipped: 0 },
    selectedAssertionIds: ["zzz"],
  }));
  assert.throws(() => recordFlakyIsolation({ first, rerun: differentTests, priorRerunCount: 0, failedAssertionIds: ["a1"] }), /never selected/);
  for (const fingerprints of [
    { environment: "env_1", capability: "OTHERcap", config: "cfg_1", dependency: "dep_1" },
    { environment: "env_1", capability: "cap_1", config: "OTHERcfg", dependency: "dep_1" },
    { environment: "env_1", capability: "cap_1", config: "cfg_1", dependency: "OTHERdep" },
  ]) {
    const drifted = createValidationObservation(baseInput({
      id: "obs_rerun_fp",
      counts: { selected: 1, passed: 1, failed: 0, skipped: 0 },
      selectedAssertionIds: ["a1"],
      fingerprints,
    }));
    assert.throws(() => recordFlakyIsolation({ first, rerun: drifted, priorRerunCount: 0, failedAssertionIds: ["a1"] }), /same (capability|config|dependency)/);
  }
  const skipping = createValidationObservation(baseInput({
    id: "obs_rerun_skip",
    outcome: "failed",
    exitCode: 1,
    counts: { selected: 1, passed: 0, failed: 0, skipped: 1 },
    selectedAssertionIds: ["a1"],
    skippedAssertionIds: ["a1"],
    skipRationale: "flake",
  }));
  assert.throws(() => recordFlakyIsolation({ first, rerun: skipping, priorRerunCount: 0, failedAssertionIds: ["a1"] }), /must not skip/);
});
