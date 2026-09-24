import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ArtifactStore } from "../src/artifact-store.js";
import { createEvidenceTools, createValidationEvidenceTools } from "../src/evidence-tools.js";
import type { EvidenceRecord, StoredValidationObservation } from "../src/evidence-store.js";
import {
  assessObservationForAcceptance,
  createValidationObservation,
} from "../src/validation-observation.js";
import type { EvidenceApplicabilityDecision, ValidationObservation } from "../src/planning-contracts.js";
import { SqliteEvidenceStore } from "../src/sqlite-evidence-store.js";
import { ToolRegistry } from "../src/tool-registry.js";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

function recordCommandEvidence(store: SqliteEvidenceStore, runId: string, key: string): EvidenceRecord {
  return store.record({
    runId,
    taskId: "task_1",
    actor: { role: "worker", id: "worker_1" },
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
      stdoutArtifactHash: HASH_A,
      stderrArtifactHash: HASH_B,
      repositoryRevision: "rev_1",
    },
    createdAt: "2026-01-01T00:00:01.000Z",
    idempotencyKey: key,
  });
}

function observation(evidenceId: string): ValidationObservation {
  return {
    id: "obs_1",
    intentId: "intent_1",
    evidenceId,
    command: "npm test",
    method: "junit",
    snapshotRevision: "rev_1",
    dirty: false,
    exitCode: 0,
    environmentFingerprint: "env_1",
    configFingerprint: "cfg_1",
    dependencyFingerprint: "dep_1",
    outcome: "passed",
    counts: { selected: 2, passed: 2, failed: 0, skipped: 0 },
    selectedAssertionIds: ["a1", "a2"],
  };
}

function decision(): EvidenceApplicabilityDecision {
  const same = (id: string) => ({ inspected: true, oldIdentity: id, newIdentity: id });
  return {
    id: "dec_1",
    observationId: "obs_1",
    oldSnapshotRevision: "rev_1",
    newSnapshotRevision: "rev_2",
    inspectedImpact: { dependency: same("d"), contract: same("c"), config: same("g"), environment: same("e") },
    outcome: "reusable",
    rationale: "all dimensions match",
  };
}

function recordObs(store: SqliteEvidenceStore, runId: string, evidenceId: string, key: string): StoredValidationObservation {
  return store.recordObservation({
    runId,
    observation: observation(evidenceId),
    capabilityFingerprint: "cap_1",
    artifactHashes: [HASH_A],
    createdAt: "2026-01-01T00:00:00.000Z",
    idempotencyKey: key,
  });
}

test("sqlite store records and lists validation observations with idempotency", () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-t5-obs-"));
  const store = new SqliteEvidenceStore(join(root, "evidence.sqlite"));
  try {
    const evidence = recordCommandEvidence(store, "run_1", "ev-k1");
    const first = recordObs(store, "run_1", evidence.id, "obs-k1");
    assert.match(first.id, /^observation_/);
    const replay = recordObs(store, "run_1", evidence.id, "obs-k1");
    assert.deepEqual(replay, first);
    assert.throws(() => store.recordObservation({
      runId: "run_1",
      observation: { ...observation(evidence.id), outcome: "failed" },
      capabilityFingerprint: "cap_1",
      artifactHashes: [HASH_A],
      createdAt: "2026-01-01T00:00:00.000Z",
      idempotencyKey: "obs-k1",
    }), /idempotency conflict/);
    assert.throws(() => store.recordObservation({
      runId: "run_1",
      observation: { ...observation(evidence.id), outcome: "passed", counts: { selected: 0, passed: 0, failed: 0, skipped: 0 } },
      capabilityFingerprint: "cap_1",
      artifactHashes: [HASH_A],
      createdAt: "2026-01-01T00:00:00.000Z",
      idempotencyKey: "obs-bad",
    }), /Invalid validation observation/);
    assert.deepEqual(store.listObservations({ runId: "run_1" }), [first]);
    assert.deepEqual(store.listObservations({ runId: "run_other" }), []);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("sqlite store records and lists applicability decisions with idempotency", () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-t5-appl-"));
  const store = new SqliteEvidenceStore(join(root, "evidence.sqlite"));
  try {
    const first = store.recordApplicability({
      runId: "run_1", decision: decision(), createdAt: "2026-01-01T00:00:00.000Z", idempotencyKey: "dec-k1",
    });
    assert.match(first.id, /^applicability_/);
    const replay = store.recordApplicability({
      runId: "run_1", decision: decision(), createdAt: "2026-01-01T00:00:00.000Z", idempotencyKey: "dec-k1",
    });
    assert.deepEqual(replay, first);
    assert.throws(() => store.recordApplicability({
      runId: "run_1",
      decision: { ...decision(), rationale: "" },
      createdAt: "2026-01-01T00:00:00.000Z",
      idempotencyKey: "dec-bad",
    }), /Invalid applicability decision/);
    assert.deepEqual(store.listApplicability({ runId: "run_1" }), [first]);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("observations and decisions survive SQLite reopen", () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-t5-reopen-"));
  const database = join(root, "evidence.sqlite");
  const first = new SqliteEvidenceStore(database);
  try {
    const evidence = recordCommandEvidence(first, "run_1", "ev-o1");
    recordObs(first, "run_1", evidence.id, "o1");
    first.recordApplicability({ runId: "run_1", decision: decision(), createdAt: "2026-01-01T00:00:00.000Z", idempotencyKey: "d1" });
  } finally {
    first.close();
  }
  const second = new SqliteEvidenceStore(database);
  try {
    assert.equal(second.listObservations({ runId: "run_1" }).length, 1);
    assert.equal(second.listApplicability({ runId: "run_1" }).length, 1);
  } finally {
    second.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("validation inspect tools list durable observations and decisions; legacy inspect_evidence unchanged", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-t5-tools-"));
  const store = new SqliteEvidenceStore(join(root, "evidence.sqlite"));
  const artifacts = new ArtifactStore(join(root, "artifacts"));
  try {
    const evidence = recordCommandEvidence(store, "run_1", "ev-o1");
    recordObs(store, "run_1", evidence.id, "o1");
    store.recordApplicability({ runId: "run_1", decision: decision(), createdAt: "2026-01-01T00:00:00.000Z", idempotencyKey: "d1" });
    const registry = new ToolRegistry();
    for (const tool of createEvidenceTools({ store, artifacts, taskId: "task_1" })) registry.register(tool);
    for (const tool of createValidationEvidenceTools({ store, artifacts, taskId: "task_1" })) registry.register(tool);
    const context = {
      runId: "run_1",
      sessionId: "session_1",
      actor: { role: "architect", id: "architect_1" } as const,
      workspacePath: root,
    };
    const observations = await registry.invoke(
      { type: "tool_call", callId: "c1", name: "inspect_validation_observations", arguments: {} }, context,
    );
    assert.equal(observations.isError, false);
    assert.equal((observations.content[0] as { value: unknown[] }).value.length, 1);
    const decisions = await registry.invoke(
      { type: "tool_call", callId: "c2", name: "inspect_applicability_decisions", arguments: {} }, context,
    );
    assert.equal(decisions.isError, false);
    assert.equal((decisions.content[0] as { value: unknown[] }).value.length, 1);
    const legacy = await registry.invoke(
      { type: "tool_call", callId: "c3", name: "inspect_evidence", arguments: {} }, context,
    );
    assert.equal(legacy.isError, false);
    assert.equal((legacy.content[0] as { value: unknown[] }).value.length, 1);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("repair B9: envelope survives restart and acceptance re-runs to the same decision", () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-t5-roundtrip-"));
  const database = join(root, "evidence.sqlite");
  const meaningful = createValidationObservation({
    id: "obs_rt",
    intentId: "intent_1",
    evidenceId: "placeholder",
    command: "npm test",
    method: "junit",
    methodSupported: true,
    snapshotRevision: "rev_1",
    dirty: true,
    dirtySummary: "M src/a.ts",
    uncommittedContentDigest: "digest_1",
    exitCode: 0,
    fingerprints: { environment: "env_1", capability: "cap_1", config: "cfg_1", dependency: "dep_1" },
    outcome: "passed",
    counts: { selected: 2, passed: 1, failed: 0, skipped: 1 },
    selectedAssertionIds: ["a1", "a2"],
    skippedAssertionIds: ["a2"],
    skipRationale: "a2 is platform-specific",
    artifactHashes: [HASH_A],
  });
  const assessInput = {
    requiredAssertionIds: ["a1"],
    expectedSnapshotRevision: "rev_1",
    expectedDirty: true,
    expectedUncommittedContentDigest: "digest_1",
    expectedEnvironmentFingerprint: "env_1",
    expectedCapabilityFingerprint: "cap_1",
    expectedConfigFingerprint: "cfg_1",
    expectedDependencyFingerprint: "dep_1",
    expectedArtifactHashes: [HASH_A],
    isRequiredPassingTest: false,
  } as const;
  const before = assessObservationForAcceptance({ observation: meaningful, ...assessInput });
  assert.equal(before.satisfies, true);
  const first = new SqliteEvidenceStore(database);
  let storedEvidenceId = "";
  try {
    const evidence = recordCommandEvidence(first, "run_1", "ev-rt");
    storedEvidenceId = evidence.id;
    first.recordObservation({
      runId: "run_1",
      observation: { ...meaningful.observation, evidenceId: evidence.id },
      capabilityFingerprint: meaningful.capabilityFingerprint,
      artifactHashes: [...meaningful.artifactHashes],
      uncommittedContentDigest: meaningful.uncommittedContentDigest,
      skipRationale: meaningful.skipRationale,
      createdAt: "2026-01-01T00:00:00.000Z",
      idempotencyKey: "rt-1",
    });
  } finally {
    first.close();
  }
  const second = new SqliteEvidenceStore(database);
  try {
    const loaded = second.listObservations({ runId: "run_1" });
    assert.equal(loaded.length, 1);
    assert.equal(loaded[0].observation.evidenceId, storedEvidenceId);
    assert.equal(loaded[0].capabilityFingerprint, "cap_1");
    assert.deepEqual(loaded[0].artifactHashes, [HASH_A]);
    assert.equal(loaded[0].uncommittedContentDigest, "digest_1");
    assert.equal(loaded[0].skipRationale, "a2 is platform-specific");
    const reloaded = {
      observation: loaded[0].observation,
      capabilityFingerprint: loaded[0].capabilityFingerprint as string,
      artifactHashes: loaded[0].artifactHashes as readonly string[],
      uncommittedContentDigest: loaded[0].uncommittedContentDigest,
      skipRationale: loaded[0].skipRationale,
    };
    const after = assessObservationForAcceptance({ observation: reloaded, ...assessInput });
    assert.deepEqual(after, before);
    const stale = assessObservationForAcceptance({
      observation: reloaded,
      ...assessInput,
      expectedUncommittedContentDigest: "digest_2",
    });
    assert.equal(stale.satisfies, false);
  } finally {
    second.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("repair N9: an observation citing non-existent evidence is refused", () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-t5-noev-"));
  const store = new SqliteEvidenceStore(join(root, "evidence.sqlite"));
  try {
    assert.throws(() => store.recordObservation({
      runId: "run_1",
      observation: observation("does_not_exist"),
      capabilityFingerprint: "cap_1",
      artifactHashes: [HASH_A],
      createdAt: "2026-01-01T00:00:00.000Z",
      idempotencyKey: "noev-1",
    }), /non-existent evidence/);
    assert.deepEqual(store.listObservations({ runId: "run_1" }), []);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
