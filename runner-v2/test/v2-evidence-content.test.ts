import assert from "node:assert/strict";
import test from "node:test";
import { validateRepairApproachDecision, type RepairApproachValidationInput } from "../src/repair-approach-contracts.js";
import {mkdtempSync, rmSync} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {ArtifactStore} from "../src/artifact-store.js";
import {SqliteEvidenceStore} from "../src/sqlite-evidence-store.js";
import {SqliteSchedulerStore} from "../src/sqlite-scheduler-store.js";
import {createArchitectTools} from "../src/architect-tools.js";
import {rebuildSchedulerProjection, type SchedulerEventType} from "../src/scheduler-store.js";
import {resolveEvidenceContent, evidenceContentDigest} from "../src/evidence-content.js";

function decision(content: Record<string, string>): RepairApproachValidationInput {
  return {
    actorRole: "architect", actorId: "a", decisionActorRole: "architect", decisionActorId: "a",
    priorApproaches: [{approachId: "fix", failed: true, hypothesis: "h", diagnosticSet: ["old"], evidenceIds: ["old"], failureEvidenceIds: []}],
    decision: {approachId: "fix", repeat: true, hypothesis: "h", diagnosticSet: ["old"], evidenceIds: ["new"]},
    knownEvidenceIds: ["old", "new"], evidenceContentDigests: content,
  } as RepairApproachValidationInput;
}

test("V2 same observed output under a new evidence ID cannot authorize a repeat", () => {
  assert.throws(() => validateRepairApproachDecision(decision({old: "same", new: "same"})), /NEW|identical/);
});

test("V2 native repair tool and SQLite replay compare store-derived observed content both ways", async () => {
  const root = mkdtempSync(join(tmpdir(), "v2-repair-content-")); const artifacts = new ArtifactStore(join(root, "artifacts"));
  const evidence = new SqliteEvidenceStore(join(root, "evidence.sqlite")); const schedulerPath = join(root, "scheduler.sqlite");
  let scheduler = new SqliteSchedulerStore(schedulerPath, {evidenceStore: evidence, artifacts}); let ordinal = 0;
  const append = (type: SchedulerEventType, payload: Record<string, unknown>, role: "runner" | "architect" = "runner") => scheduler.append({runId: "run", type, payload, actor: {role, id: role === "architect" ? "architect" : "build-runtime"}, occurredAt: "2026-10-04T00:00:00.000Z", idempotencyKey: `event-${++ordinal}`});
  const observe = async (text: string, label: string) => {
    const out = await artifacts.put(Buffer.from(text), "text/plain"); const err = await artifacts.put(Buffer.alloc(0), "text/plain");
    return evidence.record({runId: "run", taskId: "task", actor: {role: "worker", id: label}, createdAt: `2026-10-04T00:00:${String(++ordinal).padStart(2, "0")}.000Z`, idempotencyKey: label, fact: {kind: "command", label, command: "node", args: ["--test", "same-command.mjs"], cwd: root, startedAt: label, finishedAt: label, exitCode: 1, signal: null, timedOut: false, cancelled: false, outputTruncated: false, cleanup: {state: "verified_empty", verifiedAt: label, proofArtifactId: `native-empty:${label}`}, stdoutArtifactHash: out.hash, stderrArtifactHash: err.hash}});
  };
  const call = async (input: unknown, stores = true) => {
    const tool = createArchitectTools({store: scheduler, repairApproachAvailable: true, ...(stores ? {evidenceStore: evidence, artifacts} : {})}).find((tool) => tool.definition.name === "record_repair_approach_decision")!;
    const valid = tool.validate(input); assert.equal(valid.ok, true);
    if (!valid.ok) throw new Error("invalid fixture");
    return await tool.execute(valid.value, {runId: "run", sessionId: "architect-session", actor: {role: "architect", id: "architect"}});
  };
  try {
    append("run.initialized", {}); append("run.evidence_policy_activated", {version: 1}); append("repair.issue_recorded", {issueId: "issue", rootCause: "command failure", limit: 3});
    const old = await observe("same observed failure", "old"); const duplicate = await observe("same observed failure", "new ID/time/actor"); const changed = await observe("different observed failure", "changed"); const failure = await observe("failure own output", "failed-attempt"); const failureDuplicate = await observe("failure own output", "failed-attempt-rerun");
    assert.equal(evidenceContentDigest(old), evidenceContentDigest(duplicate)); assert.notEqual(evidenceContentDigest(old), evidenceContentDigest(changed));
    const initial = {issueId: "issue", approachId: "fix", repeat: false, hypothesis: "first", diagnosticSet: [old.id], evidenceIds: [old.id]};
    assert.equal((await call(initial)).isError, false);
    append("repair.cycle_recorded", {issueId: "issue", approachId: "fix", hypothesis: "first", outcome: "failed", evidenceIds: [failure.id]});
    const repeat = {...initial, repeat: true, hypothesis: "updated", evidenceIds: [duplicate.id]};
    const rejected = await call(repeat); assert.equal(rejected.isError, true); assert.match(JSON.stringify(rejected), /NEW/);
    assert.equal((await call({...repeat, evidenceIds: [failureDuplicate.id]})).isError, true, "failure-own content stays excluded under a new record ID");
    assert.equal((await call({...repeat, evidenceIds: ["fabricated"]})).isError, true);
    assert.equal((await call({...repeat, evidenceIds: [changed.id]}, false)).isError, true, "current native policy cannot omit stores");
    const ids = [old.id, failure.id, duplicate.id];
    const digests = resolveEvidenceContent(evidence, artifacts, "run", ids);
    assert.throws(() => append("repair.approach_decided", {...repeat, contentPolicyVersion: 1, evidenceContentDigests: {...digests, [duplicate.id]: "forged"}}, "architect"), /Forged|NEW/);
    assert.throws(() => append("repair.approach_decided", repeat, "architect"), /requires evidence content policy/);
    assert.throws(() => append("repair.approach_decided", {...repeat, evidenceIds: [changed.id], contentPolicyVersion: 1, evidenceContentDigests: {}}, "architect"), /Unresolved/);
    assert.equal((await call({...repeat, evidenceIds: [changed.id]})).isError, false, "same command with changed output is new content");
    const events = scheduler.readRun("run"); const projection = rebuildSchedulerProjection(events); assert.equal(projection.repairIssues!.issue!.approaches.length, 2);
    assert.equal(projection.repairIssues!.issue!.approaches[0]!.failed, true);
    scheduler.close(); scheduler = new SqliteSchedulerStore(schedulerPath, {evidenceStore: evidence, artifacts});
    assert.deepEqual(rebuildSchedulerProjection(scheduler.readRun("run")), projection);
    // Genuinely absent historical policy remains replayable; activation applies only forward.
    assert.doesNotThrow(() => rebuildSchedulerProjection(events.filter((event) => event.type !== "run.evidence_policy_activated").map((event, index) => ({...event, sequence: index + 1}))));
  } finally {scheduler.close(); evidence.close(); rmSync(root, {recursive: true, force: true});}
});

test("V2 changed observed output from the same command authorizes new evidence", () => {
  assert.doesNotThrow(() => validateRepairApproachDecision(decision({old: "before", new: "after"})));
});
