import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type {
  ArchiveProjectMemoryInput,
  ProjectMemoryEntry,
  ProjectMemoryEvent,
  ProjectMemoryEventType,
  ProjectMemoryStore,
  PromoteProjectMemoryInput,
  ProposeProjectMemoryInput,
  SearchProjectMemoryInput,
} from "./project-memory.js";
import { rebuildProjectMemories } from "./project-memory.js";
import type { AgentActor } from "./agent-contracts.js";

interface MemoryRow {
  sequence: number;
  event_id: string;
  project_id: string;
  event_type: ProjectMemoryEventType;
  occurred_at: string;
  actor_json: string;
  idempotency_key: string;
  payload_json: string;
}

export class SqliteProjectMemoryStore implements ProjectMemoryStore {
  private readonly database: DatabaseSync;

  constructor(databasePath: string) {
    mkdirSync(dirname(databasePath), { recursive: true });
    this.database = new DatabaseSync(databasePath);
    this.database.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS project_memory_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id TEXT NOT NULL UNIQUE,
        project_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        occurred_at TEXT NOT NULL,
        actor_json TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        UNIQUE(project_id, idempotency_key)
      );
      CREATE INDEX IF NOT EXISTS idx_project_memory_events
      ON project_memory_events(project_id, sequence);
    `);
  }

  propose(input: ProposeProjectMemoryInput): ProjectMemoryEntry {
    assertBase(input.projectId, input.content, input.concepts);
    assertProvenance(input);
    const memoryId = `memory_${createHash("sha256")
      .update(`${input.projectId}\0${input.idempotencyKey}`)
      .digest("hex")}`;
    const event = this.append({
      projectId: input.projectId,
      type: "memory.proposed",
      occurredAt: input.occurredAt,
      actor: input.actor,
      idempotencyKey: input.idempotencyKey,
      payload: {
        memoryId,
        runId: input.runId,
        ...(input.taskId ? { taskId: input.taskId } : {}),
        content: input.content.trim(),
        concepts: normalizeConcepts(input.concepts),
        ...(input.workspaceRevision
          ? { workspaceRevision: input.workspaceRevision.trim() }
          : {}),
        ...(input.confidence !== undefined ? { confidence: input.confidence } : {}),
        ...(input.evidenceIds ? { evidenceIds: normalizeLinks(input.evidenceIds) } : {}),
        ...(input.supersedes ? { supersedes: normalizeLinks(input.supersedes) } : {}),
      },
    });
    return this.requireEntry(input.projectId, requiredMemoryId(event));
  }

  promote(input: PromoteProjectMemoryInput): ProjectMemoryEntry {
    assertArchitect(input.actor);
    const event = this.append({
      projectId: input.projectId,
      type: "memory.promoted",
      occurredAt: input.occurredAt,
      actor: input.actor,
      idempotencyKey: input.idempotencyKey,
      payload: { memoryId: input.memoryId },
    });
    return this.requireEntry(input.projectId, requiredMemoryId(event));
  }

  archive(input: ArchiveProjectMemoryInput): ProjectMemoryEntry {
    assertArchitect(input.actor);
    if (!input.reason.trim()) throw new Error("Archive reason is required.");
    const event = this.append({
      projectId: input.projectId,
      type: "memory.archived",
      occurredAt: input.occurredAt,
      actor: input.actor,
      idempotencyKey: input.idempotencyKey,
      payload: { memoryId: input.memoryId, reason: input.reason.trim() },
    });
    return this.requireEntry(input.projectId, requiredMemoryId(event));
  }

  search(input: SearchProjectMemoryInput): ProjectMemoryEntry[] {
    if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 100) {
      throw new Error("Memory search limit must be from 1 to 100.");
    }
    const queryTokens = tokens(input.query);
    const concepts = normalizeConcepts(input.concepts ?? []);
    return [...rebuildProjectMemories(this.events(input.projectId)).values()]
      .filter((entry) => entry.status === "promoted")
      .map((entry) => ({ entry, score: score(entry, queryTokens, concepts) }))
      .filter((result) => result.score > 0 || (queryTokens.length === 0 && concepts.length === 0))
      .sort(
        (left, right) =>
          right.score - left.score ||
          right.entry.updatedAt.localeCompare(left.entry.updatedAt) ||
          left.entry.id.localeCompare(right.entry.id)
      )
      .slice(0, input.limit)
      .map((result) => cloneEntry(result.entry));
  }

  proposals(projectId: string, limit = 100): ProjectMemoryEntry[] {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new Error("Proposal limit must be from 1 to 100.");
    }
    return [...rebuildProjectMemories(this.events(projectId)).values()]
      .filter((entry) => entry.status === "proposed")
      .sort(
        (left, right) =>
          left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id)
      )
      .slice(0, limit)
      .map(cloneEntry);
  }

  events(projectId: string): ProjectMemoryEvent[] {
    return (
      this.database
        .prepare(
          `SELECT sequence, event_id, project_id, event_type, occurred_at,
                  actor_json, idempotency_key, payload_json
           FROM project_memory_events WHERE project_id = ? ORDER BY sequence`
        )
        .all(projectId) as unknown as MemoryRow[]
    ).map(decode);
  }

  close(): void {
    this.database.close();
  }

  private append(input: Omit<ProjectMemoryEvent, "sequence" | "eventId">): ProjectMemoryEvent {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.database
        .prepare(
          `SELECT sequence, event_id, project_id, event_type, occurred_at,
                  actor_json, idempotency_key, payload_json
           FROM project_memory_events
           WHERE project_id = ? AND idempotency_key = ?`
        )
        .get(input.projectId, input.idempotencyKey) as MemoryRow | undefined;
      if (existing) {
        const decoded = decode(existing);
        if (
          decoded.type !== input.type ||
          JSON.stringify(decoded.actor) !== JSON.stringify(input.actor) ||
          JSON.stringify(decoded.payload) !== JSON.stringify(input.payload)
        ) throw new Error(`Memory idempotency conflict for ${input.idempotencyKey}.`);
        this.database.exec("COMMIT");
        return decoded;
      }
      const event: ProjectMemoryEvent = {
        ...input,
        eventId: `memory_event_${randomUUID()}`,
        sequence: Number(
          (
            this.database
              .prepare("SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence FROM project_memory_events")
              .get() as { sequence: number }
          ).sequence
        ),
      };
      const prior = this.events(input.projectId);
      rebuildProjectMemories([...prior, event]);
      this.database
        .prepare(
          `INSERT INTO project_memory_events (
            event_id, project_id, event_type, occurred_at, actor_json,
            idempotency_key, payload_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          event.eventId,
          event.projectId,
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

  private requireEntry(projectId: string, memoryId: string): ProjectMemoryEntry {
    const entry = rebuildProjectMemories(this.events(projectId)).get(memoryId);
    if (!entry) throw new Error(`Unknown memory ${memoryId}.`);
    return cloneEntry(entry);
  }
}

function decode(row: MemoryRow): ProjectMemoryEvent {
  return {
    sequence: row.sequence,
    eventId: row.event_id,
    projectId: row.project_id,
    type: row.event_type,
    occurredAt: row.occurred_at,
    actor: JSON.parse(row.actor_json) as AgentActor,
    idempotencyKey: row.idempotency_key,
    payload: JSON.parse(row.payload_json) as Record<string, unknown>,
  };
}

function score(entry: ProjectMemoryEntry, query: string[], concepts: string[]): number {
  const contentTokens = new Set(tokens(entry.content));
  const entryConcepts = new Set(entry.concepts);
  return (
    query.filter((token) => contentTokens.has(token) || entryConcepts.has(token)).length +
    concepts.filter((concept) => entryConcepts.has(concept)).length * 5
  );
}
function tokens(value: string): string[] {
  return [...new Set(value.toLowerCase().match(/[\p{L}\p{N}_-]+/gu) ?? [])];
}
function normalizeConcepts(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim().toLowerCase()).filter(Boolean))].sort();
}
function assertBase(projectId: string, content: string, concepts: string[]): void {
  if (!projectId.trim()) throw new Error("projectId is required.");
  if (!content.trim()) throw new Error("Memory content is required.");
  if (Buffer.byteLength(content) > 64 * 1024) throw new Error("Memory content exceeds 64 KiB.");
  if (concepts.length > 50) throw new Error("Memory concepts exceed 50 entries.");
}
function assertProvenance(input: ProposeProjectMemoryInput): void {
  if (
    input.workspaceRevision !== undefined &&
    (!input.workspaceRevision.trim() || input.workspaceRevision.length > 512)
  ) throw new Error("Memory workspace revision must be a non-empty string of at most 512 characters.");
  if (
    input.confidence !== undefined &&
    (!Number.isFinite(input.confidence) || input.confidence < 0 || input.confidence > 1)
  ) throw new Error("Memory confidence must be from 0 to 1.");
  if (input.evidenceIds) normalizeLinks(input.evidenceIds);
  if (input.supersedes) normalizeLinks(input.supersedes);
}
function assertArchitect(actor: AgentActor): void {
  if (actor.role !== "architect") throw new Error("Only the Architect may change durable memory status.");
}
function requiredMemoryId(event: ProjectMemoryEvent): string {
  const value = event.payload.memoryId;
  if (typeof value !== "string") throw new Error("Memory event is missing memoryId.");
  return value;
}
function cloneEntry(entry: ProjectMemoryEntry): ProjectMemoryEntry {
  return {
    ...entry,
    concepts: [...entry.concepts],
    proposedBy: { ...entry.proposedBy },
    ...(entry.evidenceIds ? { evidenceIds: [...entry.evidenceIds] } : {}),
    ...(entry.supersedes ? { supersedes: [...entry.supersedes] } : {}),
  };
}

function normalizeLinks(values: string[]): string[] {
  if (
    values.length > 100 ||
    values.some((value) => !value.trim() || value.length > 512)
  ) {
    throw new Error("Memory evidence and supersession links must contain at most 100 non-empty IDs of at most 512 characters.");
  }
  return [...new Set(values.map((value) => value.trim()))].sort();
}
