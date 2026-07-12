import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { AgentActor } from "./agent-contracts.js";
import type { AgentLoopCheckpoint } from "./agent-loop.js";
import type {
  AgentSessionEvent,
  AgentSessionEventType,
  AgentSessionProjection,
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
      artifact.hash
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

  close(): void {
    this.database.close();
  }

  private append(
    sessionId: string,
    type: AgentSessionEventType,
    occurredAt: string,
    idempotencyKey: string,
    payload: Record<string, unknown>,
    artifactHash?: string
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
      } else {
        this.database
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
      }
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
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
