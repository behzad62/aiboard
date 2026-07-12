import type { AgentActor } from "./agent-contracts.js";

export type ProjectMemoryStatus = "proposed" | "promoted" | "archived";

export interface ProjectMemoryEntry {
  id: string;
  projectId: string;
  runId: string;
  taskId?: string;
  content: string;
  concepts: string[];
  status: ProjectMemoryStatus;
  proposedBy: AgentActor;
  createdAt: string;
  updatedAt: string;
  archivedReason?: string;
  workspaceRevision?: string;
  confidence?: number;
  evidenceIds?: string[];
  supersedes?: string[];
}

export type ProjectMemoryEventType =
  | "memory.proposed"
  | "memory.promoted"
  | "memory.archived";

export interface ProjectMemoryEvent {
  sequence: number;
  eventId: string;
  projectId: string;
  type: ProjectMemoryEventType;
  occurredAt: string;
  actor: AgentActor;
  idempotencyKey: string;
  payload: Record<string, unknown>;
}

export interface ProposeProjectMemoryInput {
  projectId: string;
  runId: string;
  taskId?: string;
  actor: AgentActor;
  content: string;
  concepts: string[];
  occurredAt: string;
  idempotencyKey: string;
  workspaceRevision?: string;
  confidence?: number;
  evidenceIds?: string[];
  supersedes?: string[];
}

export interface PromoteProjectMemoryInput {
  projectId: string;
  memoryId: string;
  actor: AgentActor;
  occurredAt: string;
  idempotencyKey: string;
}

export interface ArchiveProjectMemoryInput extends PromoteProjectMemoryInput {
  reason: string;
}

export interface SearchProjectMemoryInput {
  projectId: string;
  query: string;
  concepts?: string[];
  limit: number;
}

export interface ProjectMemoryStore {
  propose(input: ProposeProjectMemoryInput): ProjectMemoryEntry;
  promote(input: PromoteProjectMemoryInput): ProjectMemoryEntry;
  archive(input: ArchiveProjectMemoryInput): ProjectMemoryEntry;
  search(input: SearchProjectMemoryInput): ProjectMemoryEntry[];
  proposals(projectId: string, limit?: number): ProjectMemoryEntry[];
  events(projectId: string): ProjectMemoryEvent[];
  close(): void;
}

export function rebuildProjectMemories(
  events: readonly ProjectMemoryEvent[]
): Map<string, ProjectMemoryEntry> {
  const entries = new Map<string, ProjectMemoryEntry>();
  for (const event of events) {
    const memoryId = requiredString(event.payload, "memoryId");
    if (event.type === "memory.proposed") {
      if (entries.has(memoryId)) throw new Error(`Duplicate memory ${memoryId}.`);
      entries.set(memoryId, {
        id: memoryId,
        projectId: event.projectId,
        runId: requiredString(event.payload, "runId"),
        ...(typeof event.payload.taskId === "string"
          ? { taskId: event.payload.taskId }
          : {}),
        content: requiredString(event.payload, "content"),
        concepts: stringArray(event.payload, "concepts"),
        status: "proposed",
        proposedBy: event.actor,
        createdAt: event.occurredAt,
        updatedAt: event.occurredAt,
        ...(typeof event.payload.workspaceRevision === "string"
          ? { workspaceRevision: event.payload.workspaceRevision }
          : {}),
        ...(typeof event.payload.confidence === "number"
          ? { confidence: event.payload.confidence }
          : {}),
        ...optionalArrayProperty(event.payload, "evidenceIds"),
        ...optionalArrayProperty(event.payload, "supersedes"),
      });
      continue;
    }
    const entry = entries.get(memoryId);
    if (!entry) throw new Error(`Unknown memory ${memoryId}.`);
    if (event.actor.role !== "architect") {
      throw new Error(`Only the Architect may ${event.type.replace("memory.", "")} memory.`);
    }
    if (event.type === "memory.promoted") {
      if (entry.status !== "proposed") {
        throw new Error(`Memory ${memoryId} is not proposed.`);
      }
      entries.set(memoryId, {
        ...entry,
        status: "promoted",
        updatedAt: event.occurredAt,
      });
    } else {
      if (entry.status === "archived") throw new Error(`Memory ${memoryId} is archived.`);
      entries.set(memoryId, {
        ...entry,
        status: "archived",
        updatedAt: event.occurredAt,
        archivedReason: requiredString(event.payload, "reason"),
      });
    }
  }
  return entries;
}

function requiredString(payload: Record<string, unknown>, key: string): string {
  const value = payload[key];
  if (typeof value !== "string" || !value.trim()) throw new Error(`Missing ${key}.`);
  return value;
}

function stringArray(payload: Record<string, unknown>, key: string): string[] {
  const value = payload[key];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`Missing ${key}.`);
  }
  return [...value] as string[];
}
function optionalStringArray(
  payload: Record<string, unknown>,
  key: string
): string[] | undefined {
  const value = payload[key];
  return Array.isArray(value) && value.every((item) => typeof item === "string")
    ? [...value] as string[]
    : undefined;
}
function optionalArrayProperty(
  payload: Record<string, unknown>,
  key: "evidenceIds" | "supersedes"
): Partial<Pick<ProjectMemoryEntry, "evidenceIds" | "supersedes">> {
  const value = optionalStringArray(payload, key);
  return value ? { [key]: value } : {};
}
