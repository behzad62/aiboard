import type { AgentActor } from "./agent-contracts.js";
import type { AgentLoopCheckpoint } from "./agent-loop.js";
import type { ChangeSet } from "./change-set.js";

export type AgentSessionEventType =
  | "session.created"
  | "session.checkpointed"
  | "session.suspended"
  | "session.submitted"
  | "session.completed";

export interface AgentSessionEvent {
  sequence: number;
  sessionId: string;
  type: AgentSessionEventType;
  occurredAt: string;
  idempotencyKey: string;
  payload: Record<string, unknown>;
  artifactHash?: string;
}

export interface CreateAgentSession {
  sessionId: string;
  runId: string;
  actor: AgentActor;
  occurredAt: string;
}

export interface AgentSessionProjection {
  sessionId: string;
  runId: string;
  actor: AgentActor;
  status: "active" | "suspended" | "submitted" | "completed";
  checkpoint?: AgentLoopCheckpoint;
  suspensionReason?: string;
  error?: string;
  changeSetId?: string;
  changeSet?: ChangeSet;
  lastSequence: number;
}
