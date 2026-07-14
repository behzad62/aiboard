import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { AgentActor, AgentMessage } from "./agent-contracts.js";
import type { AgentLoopCheckpoint } from "./agent-loop.js";
import type {
  AgentSessionEvent,
  AgentSessionEventType,
  AgentSessionProjection,
  AgentTranscriptPage,
  CreateAgentSession,
} from "./agent-session-store.js";
import type { ArtifactStore } from "./artifact-store.js";
import type { ChangeSet } from "./change-set.js";

interface EventRow {
  sequence: number;
  session_id: string;
  event_type: AgentSessionEventType;
  occurred_at: string;
  idempotency_key: string;
  payload_json: string;
  artifact_hash: string | null;
}

interface CheckpointRow {
  sequence: number;
  artifact_hash: string | null;
}

interface TranscriptRow {
  id: string;
  session_id: string;
  actor_json: string;
  sequence: number;
  occurred_at: string;
  text: string;
}

export class SqliteAgentSessionStore {
  private readonly database: DatabaseSync;

  constructor(
    databasePath: string,
    private readonly artifacts: ArtifactStore
  ) {
    mkdirSync(dirname(databasePath), { recursive: true });
    this.database = new DatabaseSync(databasePath);
    this.database.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS agent_session_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        occurred_at TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        artifact_hash TEXT,
        UNIQUE(session_id, idempotency_key)
      );
      CREATE INDEX IF NOT EXISTS idx_agent_session_events
      ON agent_session_events(session_id, sequence);
      CREATE TABLE IF NOT EXISTS agent_transcript_checkpoints (
        sequence INTEGER PRIMARY KEY,
        run_id TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_agent_transcript_checkpoints_run
      ON agent_transcript_checkpoints(run_id, sequence);
      CREATE TABLE IF NOT EXISTS agent_transcript_turns (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        actor_json TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        ordinal INTEGER NOT NULL,
        occurred_at TEXT NOT NULL,
        text TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_agent_transcript_turns_run
      ON agent_transcript_turns(run_id, sequence, ordinal);
      CREATE TABLE IF NOT EXISTS agent_artifact_cleanup (
        hash TEXT PRIMARY KEY
      );
    `);
  }

  async create(input: CreateAgentSession): Promise<void> {
    this.append(
      input.sessionId,
      "session.created",
      input.occurredAt,
      `create:${input.sessionId}`,
      { runId: input.runId, actor: input.actor }
    );
  }

  async checkpoint(
    sessionId: string,
    checkpoint: AgentLoopCheckpoint,
    occurredAt: string
  ): Promise<void> {
    const artifact = await this.artifacts.put(
      Buffer.from(JSON.stringify(checkpoint)),
      "application/json",
      `Agent checkpoint ${sessionId}`
    );
    this.append(
      sessionId,
      "session.checkpointed",
      occurredAt,
      `checkpoint:${artifact.hash}`,
      { turns: checkpoint.turns },
      artifact.hash,
      checkpoint.messages
    );
  }

  suspend(
    sessionId: string,
    reason: string,
    error: string | undefined,
    occurredAt: string
  ): void {
    this.append(
      sessionId,
      "session.suspended",
      occurredAt,
      `suspend:${reason}:${error ?? ""}`,
      { reason, ...(error ? { error } : {}) }
    );
  }

  async submit(
    sessionId: string,
    changeSet: ChangeSet,
    occurredAt: string
  ): Promise<void> {
    const artifact = await this.artifacts.put(
      Buffer.from(JSON.stringify(changeSet)),
      "application/json",
      `Change set ${changeSet.id}`
    );
    this.append(
      sessionId,
      "session.submitted",
      occurredAt,
      `submit:${changeSet.id}`,
      { changeSetId: changeSet.id },
      artifact.hash
    );
  }

  complete(sessionId: string, occurredAt: string): void {
    this.append(
      sessionId,
      "session.completed",
      occurredAt,
      "complete",
      {}
    );
  }

  async load(sessionId: string): Promise<AgentSessionProjection> {
    const events = this.events(sessionId);
    if (events.length === 0) throw new Error(`Unknown agent session ${sessionId}.`);
    const created = events[0];
    if (created.type !== "session.created") {
      throw new Error(`Agent session ${sessionId} does not begin with session.created.`);
    }
    const actor = created.payload.actor as AgentActor;
    const projection: AgentSessionProjection = {
      sessionId,
      runId: requiredString(created.payload, "runId"),
      actor,
      status: "active",
      lastSequence: created.sequence,
    };
    for (const event of events.slice(1)) {
      projection.lastSequence = event.sequence;
      if (event.type === "session.checkpointed") {
        if (!event.artifactHash) throw new Error(`Checkpoint event ${event.sequence} has no artifact.`);
        await this.artifacts.verify(event.artifactHash);
        projection.checkpoint = JSON.parse(
          (await this.artifacts.get(event.artifactHash)).toString("utf8")
        ) as AgentLoopCheckpoint;
        projection.status = "active";
        delete projection.suspensionReason;
        delete projection.error;
      } else if (event.type === "session.suspended") {
        projection.status = "suspended";
        projection.suspensionReason = requiredString(event.payload, "reason");
        projection.error =
          typeof event.payload.error === "string" ? event.payload.error : undefined;
      } else if (event.type === "session.submitted") {
        projection.status = "submitted";
        delete projection.suspensionReason;
        delete projection.error;
        projection.changeSetId = requiredString(event.payload, "changeSetId");
        if (!event.artifactHash) {
          throw new Error(`Submitted session event ${event.sequence} has no change set.`);
        }
        await this.artifacts.verify(event.artifactHash);
        projection.changeSet = JSON.parse(
          (await this.artifacts.get(event.artifactHash)).toString("utf8")
        ) as ChangeSet;
      } else if (event.type === "session.completed") {
        projection.status = "completed";
        delete projection.suspensionReason;
        delete projection.error;
      }
    }
    return projection;
  }

  events(sessionId: string): AgentSessionEvent[] {
    return (
      this.database
        .prepare(
          `SELECT sequence, session_id, event_type, occurred_at,
                  idempotency_key, payload_json, artifact_hash
           FROM agent_session_events
           WHERE session_id = ? ORDER BY sequence ASC`
        )
        .all(sessionId) as unknown as EventRow[]
    ).map(decodeEvent);
  }

  async listRun(runId: string): Promise<AgentSessionProjection[]> {
    const created = (
      this.database
        .prepare(
          `SELECT sequence, session_id, event_type, occurred_at,
                  idempotency_key, payload_json, artifact_hash
           FROM agent_session_events
           WHERE event_type = 'session.created' ORDER BY session_id ASC`
        )
        .all() as unknown as EventRow[]
    )
      .map(decodeEvent)
      .filter((event) => event.payload.runId === runId);
    return await Promise.all(created.map((event) => this.load(event.sessionId)));
  }

  async transcript(runId: string, afterSequence = 0): Promise<AgentTranscriptPage> {
    await this.ensureTranscriptProjection(runId);
    const rows = this.database
      .prepare(
        `SELECT id, session_id, actor_json, sequence, occurred_at, text
         FROM agent_transcript_turns
         WHERE run_id = ? AND sequence > ?
         ORDER BY sequence ASC, ordinal ASC, id ASC`
      )
      .all(runId, afterSequence) as unknown as TranscriptRow[];
    const latest = this.database
      .prepare(
        `SELECT MAX(sequence) AS sequence
         FROM agent_transcript_checkpoints WHERE run_id = ?`
      )
      .get(runId) as { sequence: number | null };
    return {
      turns: rows.map((row) => ({
        id: row.id,
        sessionId: row.session_id,
        actor: JSON.parse(row.actor_json) as AgentActor,
        sequence: row.sequence,
        occurredAt: row.occurred_at,
        text: row.text,
      })),
      cursor: Math.max(afterSequence, latest.sequence ?? 0),
    };
  }

  async compactRun(runId: string): Promise<void> {
    await this.ensureTranscriptProjection(runId);
    const sessionIds = this.createdEvents(runId).map((event) => event.sessionId);
    const candidates = new Set<string>();
    const unreachable = new Set<string>();
    const checkpointsForSession = this.database.prepare(
      `SELECT sequence, artifact_hash
       FROM agent_session_events
       WHERE session_id = ? AND event_type = 'session.checkpointed'
       ORDER BY sequence DESC`
    );

    for (const sessionId of sessionIds) {
      const latest = (
        checkpointsForSession.all(sessionId) as unknown as CheckpointRow[]
      )[0];
      if (!latest) continue;
      if (!latest.artifact_hash) {
        throw new Error(`Checkpoint event ${latest.sequence} has no artifact.`);
      }
      await this.artifacts.verify(latest.artifact_hash);
      parseCheckpoint(await this.artifacts.get(latest.artifact_hash), latest.sequence);
    }

    this.database.exec("BEGIN IMMEDIATE");
    try {
      const deleteCheckpoint = this.database.prepare(
        `DELETE FROM agent_session_events
         WHERE sequence = ? AND event_type = 'session.checkpointed'`
      );
      for (const sessionId of sessionIds) {
        const checkpoints = checkpointsForSession.all(
          sessionId
        ) as unknown as CheckpointRow[];
        for (const checkpoint of checkpoints.slice(1)) {
          deleteCheckpoint.run(checkpoint.sequence);
          if (checkpoint.artifact_hash) candidates.add(checkpoint.artifact_hash);
        }
      }
      const artifactReference = this.database.prepare(
        `SELECT 1 FROM agent_session_events WHERE artifact_hash = ? LIMIT 1`
      );
      for (const hash of candidates) {
        if (!artifactReference.get(hash)) unreachable.add(hash);
      }
      const enqueueCleanup = this.database.prepare(
        `INSERT OR IGNORE INTO agent_artifact_cleanup (hash) VALUES (?)`
      );
      for (const hash of unreachable) enqueueCleanup.run(hash);
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }

    await this.drainArtifactCleanup();
  }

  close(): void {
    this.database.close();
  }

  private append(
    sessionId: string,
    type: AgentSessionEventType,
    occurredAt: string,
    idempotencyKey: string,
    payload: Record<string, unknown>,
    artifactHash?: string,
    transcriptMessages?: readonly AgentMessage[]
  ): void {
    const payloadJson = JSON.stringify(payload);
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.database
        .prepare(
          `SELECT sequence, session_id, event_type, occurred_at,
                  idempotency_key, payload_json, artifact_hash
           FROM agent_session_events
           WHERE session_id = ? AND idempotency_key = ?`
        )
        .get(sessionId, idempotencyKey) as EventRow | undefined;
      let eventSequence: number;
      if (existing) {
        if (
          existing.event_type !== type ||
          existing.payload_json !== payloadJson ||
          existing.artifact_hash !== (artifactHash ?? null)
        ) {
          throw new Error(
            `Agent session ${sessionId} idempotency conflict for ${idempotencyKey}.`
          );
        }
        eventSequence = existing.sequence;
      } else {
        const result = this.database
          .prepare(
            `INSERT INTO agent_session_events (
              session_id, event_type, occurred_at, idempotency_key,
              payload_json, artifact_hash
            ) VALUES (?, ?, ?, ?, ?, ?)`
          )
          .run(
            sessionId,
            type,
            occurredAt,
            idempotencyKey,
            payloadJson,
            artifactHash ?? null
          );
        eventSequence = Number(result.lastInsertRowid);
      }
      if (transcriptMessages) {
        const created = this.database
          .prepare(
            `SELECT payload_json FROM agent_session_events
             WHERE session_id = ? AND event_type = 'session.created'
             ORDER BY sequence ASC LIMIT 1`
          )
          .get(sessionId) as { payload_json: string } | undefined;
        if (!created) throw new Error(`Unknown agent session ${sessionId}.`);
        const createdPayload = JSON.parse(created.payload_json) as Record<string, unknown>;
        this.insertTranscriptCheckpoint(
          eventSequence,
          requiredString(createdPayload, "runId"),
          sessionId,
          createdPayload.actor as AgentActor,
          occurredAt,
          transcriptMessages
        );
      }
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  private async ensureTranscriptProjection(runId: string): Promise<void> {
    const sessions = new Map(
      this.createdEvents(runId).map((event) => [
        event.sessionId,
        event.payload.actor as AgentActor,
      ])
    );
    const processed = new Set(
      (
        this.database
          .prepare(
            `SELECT sequence FROM agent_transcript_checkpoints WHERE run_id = ?`
          )
          .all(runId) as Array<{ sequence: number }>
      ).map((row) => row.sequence)
    );
    const pending: Array<{
      event: AgentSessionEvent;
      checkpoint: AgentLoopCheckpoint;
      actor: AgentActor;
    }> = [];
    const checkpoints = (
      this.database
        .prepare(
          `SELECT sequence, session_id, event_type, occurred_at,
                  idempotency_key, payload_json, artifact_hash
           FROM agent_session_events
           WHERE event_type = 'session.checkpointed' ORDER BY sequence ASC`
        )
        .all() as unknown as EventRow[]
    )
      .map(decodeEvent)
      .filter(
        (event) => sessions.has(event.sessionId) && !processed.has(event.sequence)
      );
    for (const event of checkpoints) {
      if (!event.artifactHash) {
        throw new Error(`Checkpoint event ${event.sequence} has no artifact.`);
      }
      await this.artifacts.verify(event.artifactHash);
      pending.push({
        event,
        checkpoint: parseCheckpoint(
          await this.artifacts.get(event.artifactHash),
          event.sequence
        ),
        actor: sessions.get(event.sessionId)!,
      });
    }
    if (pending.length === 0) return;

    this.database.exec("BEGIN IMMEDIATE");
    try {
      for (const { event, checkpoint, actor } of pending) {
        this.insertTranscriptCheckpoint(
          event.sequence,
          runId,
          event.sessionId,
          actor,
          event.occurredAt,
          checkpoint.messages
        );
      }
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  private insertTranscriptCheckpoint(
    sequence: number,
    runId: string,
    sessionId: string,
    actor: AgentActor,
    occurredAt: string,
    messages: readonly AgentMessage[]
  ): void {
    this.database
      .prepare(
        `INSERT OR IGNORE INTO agent_transcript_checkpoints (sequence, run_id)
         VALUES (?, ?)`
      )
      .run(sequence, runId);
    const insertTurn = this.database.prepare(
      `INSERT OR IGNORE INTO agent_transcript_turns (
        id, run_id, session_id, actor_json, sequence, ordinal, occurred_at, text
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const actorJson = JSON.stringify(actor);
    messages.forEach((message, ordinal) => {
      const text = assistantText(message);
      if (text === undefined) return;
      insertTurn.run(
        `${sessionId}:${message.id}`,
        runId,
        sessionId,
        actorJson,
        sequence,
        ordinal,
        occurredAt,
        text
      );
    });
  }

  private async drainArtifactCleanup(): Promise<void> {
    const pending = this.database
      .prepare(`SELECT hash FROM agent_artifact_cleanup ORDER BY hash ASC`)
      .all() as Array<{ hash: string }>;
    const referenced = this.database.prepare(
      `SELECT 1 FROM agent_session_events WHERE artifact_hash = ? LIMIT 1`
    );
    const complete = this.database.prepare(
      `DELETE FROM agent_artifact_cleanup WHERE hash = ?`
    );
    for (const { hash } of pending) {
      if (!referenced.get(hash)) await this.artifacts.remove(hash);
      complete.run(hash);
    }
  }

  private createdEvents(runId: string): AgentSessionEvent[] {
    return (
      this.database
        .prepare(
          `SELECT sequence, session_id, event_type, occurred_at,
                  idempotency_key, payload_json, artifact_hash
           FROM agent_session_events
           WHERE event_type = 'session.created' ORDER BY session_id ASC`
        )
        .all() as unknown as EventRow[]
    )
      .map(decodeEvent)
      .filter((event) => event.payload.runId === runId);
  }
}

function decodeEvent(row: EventRow): AgentSessionEvent {
  return {
    sequence: row.sequence,
    sessionId: row.session_id,
    type: row.event_type,
    occurredAt: row.occurred_at,
    idempotencyKey: row.idempotency_key,
    payload: JSON.parse(row.payload_json) as Record<string, unknown>,
    ...(row.artifact_hash ? { artifactHash: row.artifact_hash } : {}),
  };
}

function requiredString(payload: Record<string, unknown>, key: string): string {
  const value = payload[key];
  if (typeof value !== "string" || !value) throw new Error(`Missing ${key}.`);
  return value;
}

function assistantText(message: AgentMessage): string | undefined {
  if (message.role !== "assistant") return undefined;
  if (typeof message.content === "string") {
    return message.content.length > 0 ? message.content : undefined;
  }
  if (!Array.isArray(message.content)) return undefined;
  const text = message.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");
  return text.length > 0 ? text : undefined;
}

function parseCheckpoint(bytes: Uint8Array, sequence: number): AgentLoopCheckpoint {
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(bytes).toString("utf8"));
  } catch (error) {
    throw new Error(`Checkpoint event ${sequence} is invalid JSON.`, { cause: error });
  }
  if (!value || typeof value !== "object") {
    throw new Error(`Checkpoint event ${sequence} is malformed.`);
  }
  const checkpoint = value as Record<string, unknown>;
  if (
    !Array.isArray(checkpoint.messages) ||
    !checkpoint.messages.every(isAgentMessage) ||
    !Number.isSafeInteger(checkpoint.turns) ||
    (checkpoint.turns as number) < 0 ||
    !Array.isArray(checkpoint.seenCallIds) ||
    !checkpoint.seenCallIds.every((callId) => typeof callId === "string")
  ) {
    throw new Error(`Checkpoint event ${sequence} is malformed.`);
  }
  return value as AgentLoopCheckpoint;
}

function isAgentMessage(value: unknown): value is AgentMessage {
  if (!value || typeof value !== "object") return false;
  const message = value as Record<string, unknown>;
  return (
    typeof message.id === "string" &&
    ["system", "user", "assistant", "tool"].includes(String(message.role)) &&
    Object.hasOwn(message, "content")
  );
}
