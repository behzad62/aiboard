import assert from "node:assert/strict";
import { evidenceFactArtifactHashes, type EvidenceFact } from "../../src/evidence-store.js";
import { parseContextManifestPayload, type ContextManifest } from "../../src/context-manifest-store.js";
import { finalVerificationEventArtifactHashes, type SchedulerEvent } from "../../src/scheduler-store.js";
import type { ApprovedSourceManifest } from "../../src/source-manifest.js";

export type A1Row = Record<string, unknown>;
export type A1Tables = Record<string, A1Row[]>;
export type A1Stores = Record<string, A1Tables>;
export type A1ReferenceKind = "raw" | "checkpoint" | "changeset";
export interface A1Reference { hash: string; kind: A1ReferenceKind; origin: string }
export function object(value: unknown): A1Row {
  assert.ok(value !== null && typeof value === "object" && !Array.isArray(value), "Expected schema object");
  return value as A1Row;
}
function array(value: unknown): unknown[] { assert.ok(Array.isArray(value), "Expected schema array"); return value; }
function json(value: unknown): unknown { assert.equal(typeof value, "string"); return JSON.parse(value as string); }
export function a1Reference(hash: unknown, origin: string, kind: A1ReferenceKind = "raw"): A1Reference {
  assert.ok(typeof hash === "string" && /^[a-f0-9]{64}$/.test(hash), "Malformed artifact reference at " + origin);
  return { hash, origin, kind };
}
function field(refs: A1Reference[], record: A1Row, key: string, origin: string, required = false) {
  if (record[key] !== undefined || required) refs.push(a1Reference(record[key], origin + "/" + key));
}
function hashes(refs: A1Reference[], value: unknown, origin: string) {
  for (const [i, hash] of array(value).entries()) refs.push(a1Reference(hash, origin + "/" + i));
}
function links(refs: A1Reference[], value: unknown, origin: string) {
  if (value === undefined) return;
  for (const [i, link] of array(value).entries()) {
    const item = object(link);
    if (item.artifactHashes !== undefined) hashes(refs, item.artifactHashes, origin + "/" + i + "/artifactHashes");
  }
}
function factReferences(refs: A1Reference[], value: unknown, origin: string) {
  const fact = object(value);
  assert.ok(["command", "browser_snapshot", "browser_screenshot", "browser_events"].includes(String(fact.kind)), "Unknown evidence kind at " + origin);
  for (const [i, hash] of evidenceFactArtifactHashes(fact as unknown as EvidenceFact).entries()) refs.push(a1Reference(hash, origin + "/fact-artifact/" + i));
  if (fact.kind === "command" && fact.executionSnapshot !== undefined) {
    const process = object(object(fact.executionSnapshot).process);
    for (const [i, output] of array(process.output).entries()) field(refs, object(output), "spillArtifactId", origin + "/executionSnapshot/process/output/" + i);
  }
}
export function a1Roots(stores: A1Stores, runId: string) {
  const refs: A1Reference[] = [];
  const events: SchedulerEvent[] = [];
  const manifests: ContextManifest[] = [];
  const sources: ApprovedSourceManifest[] = [];
  for (const row of stores["scheduler.sqlite"]!.scheduler_events!) {
    assert.equal(row.run_id, runId, "A1 run-scoped scheduler identity");
    const p = object(json(row.payload_json));
    const event = { eventId: row.event_id, runId, sequence: row.sequence, type: row.event_type,
      occurredAt: row.occurred_at, actor: json(row.actor_json), idempotencyKey: row.idempotency_key, payload: p } as SchedulerEvent;
    events.push(event);
    const origin = "scheduler_events/" + row.sequence + "/" + event.type;
    for (const hash of finalVerificationEventArtifactHashes(event)) refs.push(a1Reference(hash, origin + "/final-verification-artifact"));
    switch (event.type) {
      case "planning.source_registered": case "planning.source_amended": {
        const manifest = object(p.manifest) as unknown as ApprovedSourceManifest;
        sources.push(manifest);
        refs.push(a1Reference(manifest.artifactDigest, origin + "/manifest/artifactDigest"));
        if (manifest.amendment) refs.push(a1Reference(manifest.amendment.priorArtifactDigest, origin + "/manifest/amendment/priorArtifactDigest"));
        break;
      }
      case "task.transitioned":
        if (p.status === "submitted") links(refs, object(p.patch).criterionEvidenceLinks, origin + "/patch/criterionEvidenceLinks");
        break;
      case "review.requested": case "review.decided":
        if (p.evidenceArtifactHashes !== undefined) hashes(refs, p.evidenceArtifactHashes, origin + "/evidenceArtifactHashes");
        links(refs, p.criterionEvidenceLinks, origin + "/criterionEvidenceLinks");
        links(refs, p.criterionVerdicts, origin + "/criterionVerdicts");
        break;
      case "project_doc.requested": field(refs, p, "contentArtifactHash", origin, true); break;
      case "delivery.criteria_and_diff_delivered": field(refs, p, "diffArtifactHash", origin, true); break;
      case "delivery.reads_captured":
        for (const [i, read] of array(object(p.capture).reads).entries()) {
          const entry = object(read);
          if (entry.toolName === "artifact.read") field(refs, entry, "artifactHash", origin + "/capture/reads/" + i, true);
        }
        break;
    }
  }
  events.sort((a, b) => a.sequence - b.sequence);
  for (const row of stores["context-manifests.sqlite"]!.context_manifests!) {
    assert.equal(row.run_id, runId);
    const manifest = parseContextManifestPayload(String(row.payload_json), String(row.manifest_id));
    assert.equal(manifest.manifestId, row.manifest_id, "A1 context manifest row identity mismatch");
    assert.equal(manifest.runId, row.run_id); assert.equal(manifest.sessionId, row.session_id); assert.equal(manifest.recordedAt, row.recorded_at);
    manifests.push(manifest);
    const origin = "context_manifests/" + row.manifest_id;
    field(refs, manifest as unknown as A1Row, "packArtifactHash", origin);
    for (const [key, entries] of [["sections", manifest.sections], ["omissions", manifest.omissions]] as const) {
      for (const [i, entry] of entries.entries()) field(refs, entry as unknown as A1Row, "artifactHash", origin + "/" + key + "/" + i);
    }
  }
  for (const row of stores["evidence.sqlite"]!.evidence_records!) {
    assert.equal(row.run_id, runId); factReferences(refs, json(row.fact_json), "evidence_records/" + row.evidence_id);
  }
  for (const row of stores["evidence.sqlite"]!.validation_observations!) {
    assert.equal(row.run_id, runId, "A1 observation run identity mismatch");
    if (row.artifact_hashes_json !== undefined && row.artifact_hashes_json !== null) hashes(refs, json(row.artifact_hashes_json), "validation_observations/" + row.observation_id + "/artifact_hashes_json");
  }
  const sessionRows = stores["sessions.sqlite"]!.agent_session_events!;
  const sessions = new Set<string>();
  for (const row of sessionRows) {
    if (row.event_type !== "session.created") continue;
    assert.equal(object(json(row.payload_json)).runId, runId, "A1 session run association mismatch");
    assert.equal(typeof row.session_id, "string"); sessions.add(row.session_id as string);
  }
  for (const row of sessionRows) {
    assert.ok(sessions.has(String(row.session_id)), "A1 session run association is missing");
    if (row.artifact_hash !== null && row.artifact_hash !== undefined) refs.push(a1Reference(row.artifact_hash, "agent_session_events/" + row.sequence + "/artifact_hash",
      row.event_type === "session.checkpointed" ? "checkpoint" : row.event_type === "session.submitted" ? "changeset" : "raw"));
  }
  for (const row of stores["sessions.sqlite"]!.agent_compacted_checkpoint_idempotency!) {
    assert.ok(sessions.has(String(row.session_id)), "A1 compacted session run association is missing");
    refs.push(a1Reference(row.artifact_hash, "agent_compacted_checkpoint_idempotency/" + row.session_id + "/" + row.idempotency_key, "checkpoint"));
  }
  // Cleanup queue hashes, arbitrary text/digests and budget quantities are retained facts, not declared live edges.
  return { refs, events, manifests, sources };
}
export function a1NestedReferences(kind: A1ReferenceKind, bytes: Uint8Array, origin: string): A1Reference[] {
  if (kind === "raw") return [];
  const item = object(JSON.parse(Buffer.from(bytes).toString("utf8")));
  const refs: A1Reference[] = [];
  if (kind === "changeset") {
    field(refs, item, "diffArtifactHash", origin, true);
    hashes(refs, item.evidenceArtifactHashes, origin + "/evidenceArtifactHashes");
    links(refs, item.criterionEvidenceLinks, origin + "/criterionEvidenceLinks");
    for (const [i, effect] of array(item.externalEffects).entries()) field(refs, object(effect), "artifactHash", origin + "/externalEffects/" + i);
    return refs;
  }
  assert.ok(Number.isSafeInteger(item.turns) && Number(item.turns) >= 0, "Malformed checkpoint turns");
  array(item.seenCallIds);
  for (const [mi, message] of array(item.messages).entries()) {
    const msg = object(message);
    if (msg.role !== "tool") continue;
    const result = object(msg.content);
    const at = origin + "/messages/" + mi + "/content";
    for (const [bi, block] of array(result.content).entries()) {
      const b = object(block); const where = at + "/content/" + bi;
      if (b.type === "artifact") refs.push(a1Reference(b.hash, where + "/hash"));
      if (b.type !== "json" || result.isError !== false) continue;
      switch (result.toolName) {
        case "run_evidence_command": factReferences(refs, object(b.value).fact, where + "/value/fact"); break;
        case "inspect_evidence":
          for (const [i, record] of array(b.value).entries()) factReferences(refs, object(record).fact, where + "/value/" + i + "/fact");
          break;
        case "inspect_validation_observations":
          for (const [i, observation] of array(b.value).entries()) {
            const entry = object(observation);
            if (entry.artifactHashes !== undefined) hashes(refs, entry.artifactHashes, where + "/value/" + i + "/artifactHashes");
          }
          break;
        case "artifact.read": field(refs, object(b.value), "hash", where + "/value", true); break;
      }
    }
    if (result.lifecycle !== undefined) {
      const signal = object(result.lifecycle);
      if (signal.type === "return_subagent" && signal.artifactHashes !== undefined) hashes(refs, signal.artifactHashes, at + "/lifecycle/artifactHashes");
    }
  }
  return refs;
}
