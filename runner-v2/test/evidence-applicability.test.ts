import assert from "node:assert/strict";
import test from "node:test";

import type { EvidenceRecord } from "../src/evidence-store.js";
import {
  decideApplicability,
  decideUnverifiedClaim,
  propagateInvalidation,
  toFrozenDecision,
} from "../src/evidence-applicability.js";
import type { EvidenceApplicabilityImpact } from "../src/planning-contracts.js";

function impact(overrides: Partial<Record<keyof EvidenceApplicabilityImpact, { inspected: boolean; oldIdentity?: string; newIdentity?: string }>> = {}): EvidenceApplicabilityImpact {
  const same = (id: string) => ({ inspected: true, oldIdentity: id, newIdentity: id });
  return {
    dependency: same("dep_1"),
    contract: same("contract_1"),
    config: same("cfg_1"),
    environment: same("env_1"),
    ...overrides,
  };
}

test("unchanged evidence is reusable across an unrelated commit only with a recorded proof", () => {
  const proof = decideApplicability({
    observationId: "obs_1",
    oldSnapshotRevision: "rev_1",
    newSnapshotRevision: "rev_2",
    inspectedImpact: impact(),
    rationale: "unrelated docs commit; all dimensions match",
    checkId: "check_login",
    downstreamCheckIds: [],
    changedCheckIds: [],
    codeImpact: { inspected: true, oldIdentity: "code_1", newIdentity: "code_1" },
  });
  assert.equal(proof.outcome, "reusable");
  assert.match(proof.rationale, /All dimensions inspected/);
  const decision = toFrozenDecision("dec_1", {
    observationId: "obs_1",
    oldSnapshotRevision: "rev_1",
    newSnapshotRevision: "rev_2",
    inspectedImpact: impact(),
    rationale: proof.rationale,
    checkId: "check_login",
  }, proof);
  assert.equal(decision.outcome, "reusable");
});

test("changed dependency/config/environment invalidates the affected check", () => {
  const proof = decideApplicability({
    observationId: "obs_1",
    oldSnapshotRevision: "rev_1",
    newSnapshotRevision: "rev_2",
    inspectedImpact: impact({ dependency: { inspected: true, oldIdentity: "dep_1", newIdentity: "dep_2" } }),
    rationale: "lockfile bump",
    checkId: "check_login",
    downstreamCheckIds: ["check_session"],
    changedCheckIds: [],
    codeImpact: { inspected: true, oldIdentity: "code_1", newIdentity: "code_1" },
  });
  assert.equal(proof.outcome, "invalidated");
  assert.deepEqual(proof.invalidatedDownstreamCheckIds, ["check_session"]);
});

test("lockfile/schema/shared-consumer change invalidates affected edges while independent tasks stay accepted", () => {
  const edges = new Map<string, readonly string[]>([
    ["check_auth", ["check_session", "check_audit"]],
    ["check_session", ["check_profile"]],
    ["check_billing", []],
  ]);
  const invalidated = propagateInvalidation(["check_auth"], edges);
  assert.deepEqual(invalidated, ["check_audit", "check_auth", "check_profile", "check_session"]);
  assert.ok(!invalidated.includes("check_billing"), "independent check_billing stays accepted");
});

test("missing impact info yields bounded investigation, never unconditional reuse or blind full rerun", () => {
  const proof = decideApplicability({
    observationId: "obs_1",
    oldSnapshotRevision: "rev_1",
    newSnapshotRevision: "rev_2",
    inspectedImpact: impact({ environment: { inspected: false } }),
    rationale: "env fingerprints unavailable",
    checkId: "check_login",
    downstreamCheckIds: ["check_session"],
    changedCheckIds: [],
    codeImpact: { inspected: true, oldIdentity: "code_1", newIdentity: "code_1" },
  });
  assert.equal(proof.outcome, "unknown");
  assert.ok((proof.investigation ?? []).some((s) => s.includes("environment")));
  assert.deepEqual(proof.expandedChecks, ["check_login", "check_session"]);
  assert.throws(() => toFrozenDecision("dec_x", {
    observationId: "obs_1",
    oldSnapshotRevision: "rev_1",
    newSnapshotRevision: "rev_2",
    inspectedImpact: impact({ environment: { inspected: false } }),
    rationale: "x",
    checkId: "check_login",
  }, proof), /pending investigation/);
});

test("changed behavior invalidates the affected check even when dimensions match", () => {
  const proof = decideApplicability({
    observationId: "obs_1",
    oldSnapshotRevision: "rev_1",
    newSnapshotRevision: "rev_2",
    inspectedImpact: impact(),
    rationale: "auth behavior changed",
    checkId: "check_login",
    downstreamCheckIds: [],
    changedCheckIds: ["check_login"],
    codeImpact: { inspected: true, oldIdentity: "code_1", newIdentity: "code_1" },
  });
  assert.equal(proof.outcome, "invalidated");
});

function commandRecord(overrides: Partial<EvidenceRecord["fact"] & { id?: string }> = {}): EvidenceRecord {
  const { id, ...factOverrides } = overrides as { id?: string } & Record<string, unknown>;
  return {
    id: id ?? "evidence_1",
    runId: "run_1",
    taskId: "task_1",
    actor: { role: "worker", id: "worker_1" },
    status: "observed",
    fact: {
      kind: "command",
      label: "tests",
      command: "npm",
      args: ["test"],
      cwd: "/w",
      startedAt: "2026-01-01T00:00:00.000Z",
      finishedAt: "2026-01-01T00:00:01.000Z",
      exitCode: 0,
      signal: null,
      timedOut: false,
      cancelled: false,
      outputTruncated: false,
      stdoutArtifactHash: "a".repeat(64),
      stderrArtifactHash: "b".repeat(64),
      repositoryRevision: "rev_1",
      ...(factOverrides as object),
    } as EvidenceRecord["fact"],
    createdAt: "2026-01-01T00:00:01.000Z",
    idempotencyKey: "k1",
  };
}

test("unverified_claim is decided mechanically: matching citation verifies", () => {
  const record = commandRecord();
  const verdict = decideUnverifiedClaim({
    claim: {
      evidenceId: "evidence_1",
      command: "npm",
      args: ["test"],
      exitCode: 0,
      snapshotRevision: "rev_1",
      artifactHashes: ["a".repeat(64)],
    },
    recordsById: new Map([["evidence_1", record]]),
    hasSemanticResidue: false,
  });
  assert.equal(verdict.status, "verified");
});

test("unverified_claim: missing record or any field mismatch is unverified_claim", () => {
  const record = commandRecord();
  const byId = new Map([["evidence_1", record]]);
  const missing = decideUnverifiedClaim({
    claim: { evidenceId: "evidence_nope", command: "npm",
      args: ["test"], exitCode: 0, snapshotRevision: "rev_1", artifactHashes: [] },
    recordsById: byId,
    hasSemanticResidue: false,
  });
  assert.equal(missing.status, "unverified_claim");
  const wrongExit = decideUnverifiedClaim({
    claim: { evidenceId: "evidence_1", command: "npm",
      args: ["test"], exitCode: 1, snapshotRevision: "rev_1", artifactHashes: ["a".repeat(64)] },
    recordsById: byId,
    hasSemanticResidue: false,
  });
  assert.equal(wrongExit.status, "unverified_claim");
  assert.match(wrongExit.reason, /exit mismatch/);
  const wrongArtifact = decideUnverifiedClaim({
    claim: { evidenceId: "evidence_1", command: "npm",
      args: ["test"], exitCode: 0, snapshotRevision: "rev_1", artifactHashes: ["c".repeat(64)] },
    recordsById: byId,
    hasSemanticResidue: false,
  });
  assert.equal(wrongArtifact.status, "unverified_claim");
  const wrongRevision = decideUnverifiedClaim({
    claim: { evidenceId: "evidence_1", command: "npm",
      args: ["test"], exitCode: 0, snapshotRevision: "rev_2", artifactHashes: ["a".repeat(64)] },
    recordsById: byId,
    hasSemanticResidue: false,
  });
  assert.equal(wrongRevision.status, "unverified_claim");
});

test("unverified_claim residue is labelled reviewer judgement", () => {
  const record = commandRecord();
  const verdict = decideUnverifiedClaim({
    claim: {
      evidenceId: "evidence_1",
      command: "npm",
      args: ["test"],
      exitCode: 0,
      snapshotRevision: "rev_1",
      artifactHashes: ["a".repeat(64)],
    },
    recordsById: new Map([["evidence_1", record]]),
    hasSemanticResidue: true,
    semanticNote: "whether the assertions cover the security boundary",
  });
  assert.equal(verdict.status, "reviewer_judgement");
  assert.match(verdict.reason, /reviewer judgement/);
});

// ---------------------------------------------------------------------------
// Repair cycle 1: fail-closed regression tests (independent review probes).
// ---------------------------------------------------------------------------

test("repair B6: omitted behavior impact is unknown, never reusable", () => {
  const proof = decideApplicability({
    observationId: "obs_1",
    oldSnapshotRevision: "r1",
    newSnapshotRevision: "r2",
    inspectedImpact: impact(),
    rationale: "fingerprints match",
    checkId: "c1",
    codeImpact: { inspected: true, oldIdentity: "code_1", newIdentity: "code_1" },
  });
  assert.equal(proof.outcome, "unknown");
  assert.ok((proof.investigation ?? []).some((s) => s.includes("behavior")));
  const explicit = decideApplicability({
    observationId: "obs_1",
    oldSnapshotRevision: "r1",
    newSnapshotRevision: "r2",
    inspectedImpact: impact(),
    rationale: "fingerprints match",
    checkId: "c1",
    changedCheckIds: [],
    behaviorImpactInspected: false,
    codeImpact: { inspected: true, oldIdentity: "code_1", newIdentity: "code_1" },
  });
  assert.equal(explicit.outcome, "unknown");
});

test("repair B6: the code/dirty-content dimension gates reuse", () => {
  const base = {
    observationId: "obs_1",
    oldSnapshotRevision: "r1",
    newSnapshotRevision: "r2",
    inspectedImpact: impact(),
    rationale: "all four dimensions match",
    checkId: "c1",
    changedCheckIds: [],
  } as const;
  const missing = decideApplicability({ ...base });
  assert.equal(missing.outcome, "unknown");
  const uninspected = decideApplicability({ ...base, codeImpact: { inspected: false } });
  assert.equal(uninspected.outcome, "unknown");
  const drifted = decideApplicability({
    ...base,
    codeImpact: { inspected: true, oldIdentity: "code_1", newIdentity: "code_2" },
  });
  assert.equal(drifted.outcome, "invalidated");
  assert.match(drifted.rationale, /source content changed/);
  const clean = decideApplicability({
    ...base,
    codeImpact: { inspected: true, oldIdentity: "code_1", newIdentity: "code_1" },
  });
  assert.equal(clean.outcome, "reusable");
});

test("repair N5: empty revision or no cited artifacts cannot verify", () => {
  const record = commandRecord();
  const byId = new Map([["evidence_1", record]]);
  const emptyRevision = decideUnverifiedClaim({
    claim: { evidenceId: "evidence_1", command: "npm", args: ["test"], exitCode: 0, snapshotRevision: "", artifactHashes: ["a".repeat(64)] },
    recordsById: byId,
    hasSemanticResidue: false,
  });
  assert.equal(emptyRevision.status, "unverified_claim");
  assert.match(emptyRevision.reason, /empty revision/);
  const noArtifacts = decideUnverifiedClaim({
    claim: { evidenceId: "evidence_1", command: "npm", args: ["test"], exitCode: 0, snapshotRevision: "rev_1", artifactHashes: [] },
    recordsById: byId,
    hasSemanticResidue: false,
  });
  assert.equal(noArtifacts.status, "unverified_claim");
  assert.match(noArtifacts.reason, /no artifacts/);
});

test("repair N5: argv compares structurally, not by joining", () => {
  const joined = commandRecord({ id: "evidence_2", command: "npm test", args: [] as unknown as string[] });
  const verdict = decideUnverifiedClaim({
    claim: { evidenceId: "evidence_2", command: "npm", args: ["test"], exitCode: 0, snapshotRevision: "rev_1", artifactHashes: ["a".repeat(64)] },
    recordsById: new Map([["evidence_2", joined]]),
    hasSemanticResidue: false,
  });
  assert.equal(verdict.status, "unverified_claim");
  assert.match(verdict.reason, /(command|args) mismatch/);
});
