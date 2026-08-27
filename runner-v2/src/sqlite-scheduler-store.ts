import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type {
  NewSchedulerEvent,
  SchedulerActor,
  SchedulerEvent,
  SchedulerEventType,
  SchedulerProjection,
  SchedulerStore,
} from "./scheduler-store.js";
import {
  finalVerificationEventArtifactHashes,
  reduceSchedulerEvent,
  validateSchedulerEvidenceEvent,
} from "./scheduler-store.js";
import type { EvidenceStore } from "./evidence-store.js";
import type { ArtifactStore } from "./artifact-store.js";
import type { FinalVerificationCleanupReceiptIdentity } from "./final-verification-cleanup.js";
import type { FinalVerificationExecutionProfile } from "./final-verification-profile.js";

interface EventRow {
  event_id: string;
  run_id: string;
  sequence: number;
  event_type: SchedulerEventType;
  occurred_at: string;
  actor_json: string;
  idempotency_key: string;
  payload_json: string;
}

export interface SqliteSchedulerStoreOptions {
  /**
   * Required whenever a run carries acceptance-evidence events. It may be
   * omitted only for deterministic legacy runs that contain no such events;
   * those events fail closed if this store is absent.
   */
  evidenceStore?: EvidenceStore;
  /** Required for final-verification facts that cite content-addressed artifacts. */
  artifacts?: Pick<ArtifactStore, "verifySync">;
  /** Production authority for exact-owned cleanup receipts. */
  validateCleanupReceipt?: (identity: FinalVerificationCleanupReceiptIdentity) => void;
  /** Production authority for runner-inspected exact-revision profiles. */
  validateExecutionProfile?: (input: {
    runId: string;
    targetRevision: string;
    profile: FinalVerificationExecutionProfile;
  }) => void;
}

export class SqliteSchedulerStore implements SchedulerStore {
  private readonly database: DatabaseSync;
  private readonly evidenceStore?: EvidenceStore;
  private readonly artifacts?: Pick<ArtifactStore, "verifySync">;
  private readonly validateCleanupReceipt?: SqliteSchedulerStoreOptions["validateCleanupReceipt"];
  private readonly validateExecutionProfile?: SqliteSchedulerStoreOptions["validateExecutionProfile"];

  constructor(databasePath: string, options: SqliteSchedulerStoreOptions = {}) {
    this.evidenceStore = options.evidenceStore;
    this.artifacts = options.artifacts;
    this.validateCleanupReceipt = options.validateCleanupReceipt;
    this.validateExecutionProfile = options.validateExecutionProfile;
    mkdirSync(dirname(databasePath), { recursive: true });
    this.database = new DatabaseSync(databasePath);
    this.database.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS scheduler_events (
        event_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        event_type TEXT NOT NULL,
        occurred_at TEXT NOT NULL,
        actor_json TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        UNIQUE(run_id, sequence),
        UNIQUE(run_id, idempotency_key)
      );
      CREATE INDEX IF NOT EXISTS idx_scheduler_events
      ON scheduler_events(run_id, sequence);
    `);
  }

  append(input: NewSchedulerEvent): SchedulerEvent {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const priorRows = this.database
        .prepare(
          "SELECT * FROM scheduler_events WHERE run_id = ? ORDER BY sequence"
        )
        .all(input.runId) as unknown as EventRow[];
      const priorEvents = priorRows.map(decode);
      const priorProjection = replaySchedulerEvents(
        priorEvents,
        this.evidenceStore,
        this.artifacts,
        this.validateCleanupReceipt,
        this.validateExecutionProfile,
      );
      const existing = this.database
        .prepare(
          "SELECT * FROM scheduler_events WHERE run_id = ? AND idempotency_key = ?"
        )
        .get(input.runId, input.idempotencyKey) as EventRow | undefined;
      if (existing) {
        const event = decode(existing);
        if (
          event.type !== input.type ||
          (
            JSON.stringify(event.payload) !== JSON.stringify(input.payload) &&
            !sameLegacyGuidanceSubmissionReplay(event, input)
          ) ||
          JSON.stringify(event.actor) !== JSON.stringify(input.actor)
        ) {
          throw new Error(
            `Scheduler idempotency conflict for ${input.idempotencyKey}.`
          );
        }
        this.database.exec("COMMIT");
        return event;
      }
      if (
        input.type === "user.guidance_submitted" &&
        input.payload.interruptionProtocolVersion !== 1
      ) {
        throw new Error("New user guidance requires managed interruption protocol version 1.");
      }
      if (input.type === "user.guidance_acknowledged") {
        const guidanceId = input.payload.guidanceId;
        const guidance = typeof guidanceId === "string"
          ? priorProjection?.userGuidance[guidanceId]
          : undefined;
        if (guidance && guidance.interruptionStatus !== "completed") {
          throw new Error(
            `User guidance ${guidanceId} interruption must complete before acknowledgement.`,
          );
        }
      }
      if (
        input.type === "final_verification.generation_created" &&
        priorProjection?.finalVerification?.current
      ) {
        const current = priorProjection.finalVerification.current;
        if (sameGenerationPayload(input.payload, current)) {
          const generationEvent = priorEvents.find(
            (candidate) =>
              candidate.type === "final_verification.generation_created" &&
              sameGenerationPayload(candidate.payload, current) &&
              JSON.stringify(candidate.actor) === JSON.stringify(input.actor),
          );
          if (generationEvent) {
            this.database.exec("COMMIT");
            return generationEvent;
          }
        }
      }
      const row = this.database
        .prepare(
          "SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence FROM scheduler_events WHERE run_id = ?"
        )
        .get(input.runId) as { sequence: number };
      const event: SchedulerEvent = {
        ...input,
        eventId: `sched_${randomUUID()}`,
        sequence: row.sequence,
      };
      reduceSchedulerEvent(priorProjection, event);
      validateSchedulerEvent(
        priorProjection,
        event,
        this.evidenceStore,
        this.artifacts,
        this.validateCleanupReceipt,
        this.validateExecutionProfile,
      );
      this.database
        .prepare(
          `INSERT INTO scheduler_events (
            event_id, run_id, sequence, event_type, occurred_at,
            actor_json, idempotency_key, payload_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          event.eventId,
          event.runId,
          event.sequence,
          event.type,
          event.occurredAt,
          JSON.stringify(event.actor),
          event.idempotencyKey,
          JSON.stringify(event.payload)
        );
      this.database.exec("COMMIT");
      return event;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  readRun(runId: string, afterSequence = 0): SchedulerEvent[] {
    const events = (
      this.database
        .prepare(
          "SELECT * FROM scheduler_events WHERE run_id = ? ORDER BY sequence"
        )
        .all(runId) as unknown as EventRow[]
    ).map(decode);
    replaySchedulerEvents(
      events,
      this.evidenceStore,
      this.artifacts,
      this.validateCleanupReceipt,
      this.validateExecutionProfile,
    );
    return events.filter((event) => event.sequence > afterSequence);
  }

  close(): void {
    this.database.close();
  }
}

function sameLegacyGuidanceSubmissionReplay(
  existing: SchedulerEvent,
  input: NewSchedulerEvent,
): boolean {
  if (
    existing.type !== "user.guidance_submitted" ||
    input.type !== "user.guidance_submitted" ||
    existing.payload.interruptionProtocolVersion !== undefined ||
    input.payload.interruptionProtocolVersion !== 1
  ) {
    return false;
  }
  const { interruptionProtocolVersion: _ignored, ...currentPayload } = input.payload;
  return JSON.stringify(existing.payload) === JSON.stringify(currentPayload);
}

function sameGenerationPayload(
  payload: Record<string, unknown>,
  current: NonNullable<NonNullable<SchedulerProjection["finalVerification"]>["current"]>,
): boolean {
  return payload.taskId === current.taskId &&
    payload.generationId === current.generationId &&
    payload.targetRevision === current.targetRevision &&
    payload.planVersion === current.planVersion &&
    canonicalJson(payload.plan) === canonicalJson(current.plan);
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}

function replaySchedulerEvents(
  events: readonly SchedulerEvent[],
  evidenceStore?: EvidenceStore,
  artifacts?: Pick<ArtifactStore, "verifySync">,
  validateCleanupReceipt?: SqliteSchedulerStoreOptions["validateCleanupReceipt"],
  validateExecutionProfile?: SqliteSchedulerStoreOptions["validateExecutionProfile"],
): SchedulerProjection | undefined {
  let projection: SchedulerProjection | undefined;
  for (const event of events) {
    const next = reduceSchedulerEvent(projection, event);
    validateSchedulerEvent(
      projection,
      event,
      evidenceStore,
      artifacts,
      validateCleanupReceipt,
      validateExecutionProfile,
    );
    projection = next;
  }
  return projection;
}

function validateSchedulerEvent(
  projection: SchedulerProjection | undefined,
  event: SchedulerEvent,
  evidenceStore?: EvidenceStore,
  artifacts?: Pick<ArtifactStore, "verifySync">,
  validateCleanupReceipt?: SqliteSchedulerStoreOptions["validateCleanupReceipt"],
  validateExecutionProfile?: SqliteSchedulerStoreOptions["validateExecutionProfile"],
): void {
  if (requiresAuthoritativeEvidenceStore(projection, event) && !evidenceStore) {
    throw new Error(
      "An authoritative evidence store is required for acceptance evidence events.",
    );
  }
  if (evidenceStore) {
    validateSchedulerEvidenceEvent(projection, event, evidenceStore);
  }
  const artifactHashes = finalVerificationEventArtifactHashes(event);
  if (artifactHashes.length > 0 && !artifacts) {
    throw new Error("An ArtifactStore is required for final-verification evidence artifacts.");
  }
  for (const hash of artifactHashes) artifacts!.verifySync(hash);
  if (event.type === "final_verification.generation_created") {
    if (!validateExecutionProfile) {
      throw new Error(
        "A runner-owned execution-profile authority is required for final verification.",
      );
    }
    validateExecutionProfile({
      runId: event.runId,
      targetRevision: requiredEventString(event.payload, "targetRevision"),
      profile: event.payload.executionProfile as FinalVerificationExecutionProfile,
    });
  }
  if (event.type === "final_verification.cleanup_succeeded") {
    const current = projection?.finalVerification?.current;
    if (current?.cleanup?.status === "started" && (current.submissionResult || current.failure)) {
      if (!validateCleanupReceipt) {
        throw new Error("An authentic owned cleanup receipt validator is required.");
      }
      validateCleanupReceipt({
        runId: event.runId,
        generationId: requiredEventString(event.payload, "generationId"),
        taskId: requiredEventString(event.payload, "taskId"),
        targetRevision: requiredEventString(event.payload, "targetRevision"),
        ...(typeof event.payload.diagnosticsPath === "string"
          ? { diagnosticsPath: event.payload.diagnosticsPath }
          : {}),
        requiresDiagnostics: current.failure !== undefined,
      });
    }
  }
}

function requiredEventString(payload: Record<string, unknown>, key: string): string {
  const value = payload[key];
  if (typeof value !== "string" || !value.trim()) throw new Error(`${key} is required.`);
  return value;
}

function requiresAuthoritativeEvidenceStore(
  projection: SchedulerProjection | undefined,
  event: SchedulerEvent,
): boolean {
  if (!projection) return false;
  if (event.type === "user.guidance_acknowledged") {
    const resolution = event.payload.resolution;
    return typeof resolution === "object" &&
      resolution !== null &&
      !Array.isArray(resolution) &&
      (resolution as Record<string, unknown>).type === "no_plan_change";
  }
  if (
    event.type !== "task.transitioned" &&
    event.type !== "review.requested" &&
    event.type !== "review.decided" &&
    event.type !== "verifier.verdict_submitted" &&
    event.type !== "final_verification.review_decided" &&
    event.type !== "final_verification.repairs_planned" &&
    event.type !== "final_verification.check_completed" &&
    event.type !== "final_verification.submitted"
  ) {
    return false;
  }
  if (event.type === "verifier.verdict_submitted") return true;
  if (event.type === "task.transitioned" && event.payload.status !== "submitted") {
    return false;
  }
  if (event.type === "final_verification.review_decided") {
    return Array.isArray(event.payload.categoryReviews);
  }
  if (event.type === "final_verification.repairs_planned") return true;
  if (event.type === "final_verification.check_completed") {
    const result = event.payload.result;
    return typeof result === "object" && result !== null &&
      (Array.isArray((result as Record<string, unknown>).evidenceIds) ||
        Array.isArray((result as Record<string, unknown>).facts));
  }
  if (event.type === "final_verification.submitted") return true;
  const taskId = event.payload.taskId;
  return (
    typeof taskId === "string" &&
    taskId.length > 0 &&
    projection.tasks[taskId]?.acceptanceCriteria !== undefined
  );
}

function decode(row: EventRow): SchedulerEvent {
  try {
    return {
      eventId: row.event_id,
      runId: row.run_id,
      sequence: row.sequence,
      type: row.event_type,
      occurredAt: row.occurred_at,
      actor: JSON.parse(row.actor_json) as SchedulerActor,
      idempotencyKey: row.idempotency_key,
      payload: JSON.parse(row.payload_json) as Record<string, unknown>,
    };
  } catch (error) {
    throw new Error(`Scheduler event ${row.event_id} contains invalid JSON.`, {
      cause: error,
    });
  }
}
