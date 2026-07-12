import type { AgentActor } from "./agent-contracts.js";
import type { BudgetProjection } from "./budget-ledger.js";
import type { EvidenceRecord } from "./evidence-store.js";
import type { ManagedProcessObservation } from "./managed-process.js";
import type { ProjectMemoryEntry } from "./project-memory.js";
import type { SkillMetadata } from "./skill-catalog.js";

export interface BuildAgentObservation {
  sessionId: string;
  actor: AgentActor;
  status: "active" | "suspended" | "submitted";
  turns: number;
  suspensionReason?: string;
  error?: string;
  changeSetId?: string;
  lastSequence: number;
}

export interface BuildToolObservation {
  sequence: number;
  sessionId: string;
  callId: string;
  toolName: string;
  status: "started" | "retrying" | "completed";
  occurredAt: string;
  isError?: boolean;
  errorCode?: string;
}

export interface BuildObservabilitySnapshot {
  runId: string;
  budget: BudgetProjection;
  agents: BuildAgentObservation[];
  tools: BuildToolObservation[];
  evidence: EvidenceRecord[];
  memories: ProjectMemoryEntry[];
  skills: SkillMetadata[];
  processes: ManagedProcessObservation[];
}
