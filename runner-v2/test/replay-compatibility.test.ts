/**
 * AC-18 guard.
 *
 * Do not regenerate this fixture after the capability program starts; a mismatch
 * means a compatibility break, not a stale fixture.
 *
 * Fixture `runner-v2/test/support/pre-capability-run.fixture.json`, captured at
 * base revision 6c166f97 by the scratch script recorded in `generator`:
 *
 * - `capturedAt` — fixed capture clock.
 * - `baseRevision` — `6c166f97`.
 * - `generator` — `{ path, sha256 }` of the capture script.
 * - `schedulerEvents` — durable scheduler events from that run, in sequence order.
 * - `schedulerProjection` — `rebuildSchedulerProjection(schedulerEvents)` at capture.
 * - `evidenceRecords` — authoritative evidence cited by review and verdict events.
 *   Sqlite replay re-records these before appending events. The pure reducer does
 *   not read them.
 * - `contextManifests` — each entry is `{ manifestId, payloadJson, manifest }`.
 *   `payloadJson` is the exact stored payload. `manifest` is that payload parsed
 *   at capture. A later parser must reproduce `manifest` from `payloadJson`.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { parseContextManifestPayload, type ContextManifest } from "../src/context-manifest-store.js";
import type { EvidenceRecord } from "../src/evidence-store.js";
import {
  rebuildSchedulerProjection,
  type SchedulerEvent,
  type SchedulerProjection,
} from "../src/scheduler-store.js";
import { SqliteContextManifestStore } from "../src/sqlite-context-manifest-store.js";
import { SqliteEvidenceStore } from "../src/sqlite-evidence-store.js";
import { SqliteSchedulerStore } from "../src/sqlite-scheduler-store.js";
import { acceptFinalVerificationProfile } from "./support/final-verification-profile.js";

const FIXTURE_PATH = fileURLToPath(new URL(
  "./support/pre-capability-run.fixture.json",
  import.meta.url,
));
const RUN_ID = "run-pre-capability";

interface CapturedContextManifest {
  manifestId: string;
  payloadJson: string;
  manifest: ContextManifest;
}

interface PreCapabilityRunFixture {
  capturedAt: string;
  baseRevision: string;
  generator: { path: string; sha256: string };
  schedulerEvents: SchedulerEvent[];
  schedulerProjection: SchedulerProjection;
  evidenceRecords: EvidenceRecord[];
  contextManifests: CapturedContextManifest[];
}

function loadFixture(): PreCapabilityRunFixture {
  const parsed: unknown = JSON.parse(readFileSync(FIXTURE_PATH, "utf8"));
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("schedulerEvents" in parsed) ||
    !Array.isArray(parsed.schedulerEvents) ||
    !("schedulerProjection" in parsed) ||
    !("evidenceRecords" in parsed) ||
    !Array.isArray(parsed.evidenceRecords) ||
    !("contextManifests" in parsed) ||
    !Array.isArray(parsed.contextManifests) ||
    !("baseRevision" in parsed)
  ) {
    throw new Error("Pre-capability fixture is missing captured run fields.");
  }
  return parsed as PreCapabilityRunFixture;
}

test("AC-18 replays captured scheduler events to the stored projection", () => {
  const fixture = loadFixture();
  assert.equal(fixture.baseRevision, "6c166f97");
  const replayed = rebuildSchedulerProjection(fixture.schedulerEvents);
  assert.deepEqual(replayed, fixture.schedulerProjection);
  assert.equal(replayed.tasks.task_feature?.status, "integrated");
  assert.equal(replayed.verifier?.current?.twoPass, true);
  assert.equal(replayed.verifier?.current?.status, "submitted");
  assert.equal(replayed.verifier?.current?.expectations !== undefined, true);
  const types = new Set(fixture.schedulerEvents.map((event) => event.type));
  for (const type of [
    "plan.created",
    "verifier.review_requested",
    "verifier.expectations_recorded",
    "verifier.verdict_submitted",
  ] as const) {
    assert.equal(types.has(type), true, type);
  }
});

test("AC-18 re-parses captured context manifests through the current reader", () => {
  const fixture = loadFixture();
  assert.equal(fixture.contextManifests.length > 0, true);
  for (const entry of fixture.contextManifests) {
    const parsed = parseContextManifestPayload(entry.payloadJson, entry.manifestId);
    assert.equal(parsed.manifestId, entry.manifestId);
    assert.deepEqual(parsed, entry.manifest);
  }

  const root = mkdtempSync(join(tmpdir(), "aiboard-ac18-manifests-"));
  const databasePath = join(root, "context-manifests.sqlite");
  const created = new SqliteContextManifestStore(databasePath);
  created.close();
  const database = new DatabaseSync(databasePath);
  try {
    const insert = database.prepare(
      `INSERT INTO context_manifests (
        manifest_id, run_id, session_id, recorded_at, payload_json
      ) VALUES (?, ?, ?, ?, ?)`,
    );
    for (const entry of fixture.contextManifests) {
      insert.run(
        entry.manifestId,
        entry.manifest.runId,
        entry.manifest.sessionId,
        entry.manifest.recordedAt,
        entry.payloadJson,
      );
    }
  } finally {
    database.close();
  }
  const store = new SqliteContextManifestStore(databasePath, { readOnly: true });
  try {
    assert.deepEqual(
      store.listRun(RUN_ID),
      fixture.contextManifests.map((entry) => entry.manifest),
    );
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("AC-18 replays captured events through a fresh SqliteSchedulerStore", () => {
  const fixture = loadFixture();
  const root = mkdtempSync(join(tmpdir(), "aiboard-ac18-scheduler-"));
  const evidence = new SqliteEvidenceStore(join(root, "evidence.sqlite"));
  const store = new SqliteSchedulerStore(join(root, "scheduler.sqlite"), {
    evidenceStore: evidence,
    validateCleanupReceipt: () => undefined,
    validateExecutionProfile: acceptFinalVerificationProfile,
  });
  try {
    for (const record of fixture.evidenceRecords) {
      const recorded = evidence.record({
        runId: record.runId,
        taskId: record.taskId,
        actor: record.actor,
        fact: record.fact,
        createdAt: record.createdAt,
        idempotencyKey: record.idempotencyKey,
        ...(record.attempt !== undefined ? { attempt: record.attempt } : {}),
      });
      assert.equal(recorded.id, record.id);
    }
    for (const event of fixture.schedulerEvents) {
      store.append({
        runId: event.runId,
        type: event.type,
        occurredAt: event.occurredAt,
        actor: event.actor,
        idempotencyKey: event.idempotencyKey,
        payload: event.payload,
      });
    }
    assert.deepEqual(
      rebuildSchedulerProjection(store.readRun(RUN_ID)),
      fixture.schedulerProjection,
    );
  } finally {
    store.close();
    evidence.close();
    rmSync(root, { recursive: true, force: true });
  }
});
