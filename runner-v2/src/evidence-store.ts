import type { AgentActor } from "./agent-contracts.js";

export interface CommandEvidenceFact {
  kind: "command";
  label: string;
  command: string;
  args: string[];
  cwd: string;
  startedAt: string;
  finishedAt: string;
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  cancelled: boolean;
  outputTruncated: boolean;
  stdoutArtifactHash: string;
  stderrArtifactHash: string;
  repositoryRevision?: string;
}

export type EvidenceFact = CommandEvidenceFact;

export interface EvidenceRecord {
  id: string;
  runId: string;
  taskId: string;
  actor: AgentActor;
  status: "observed";
  fact: EvidenceFact;
  createdAt: string;
  idempotencyKey: string;
}

export interface RecordEvidenceInput {
  runId: string;
  taskId: string;
  actor: AgentActor;
  fact: EvidenceFact;
  createdAt: string;
  idempotencyKey: string;
}

export interface ListEvidenceInput {
  runId: string;
  taskId?: string;
  limit?: number;
}

export interface EvidenceStore {
  record(input: RecordEvidenceInput): EvidenceRecord;
  list(input: ListEvidenceInput): EvidenceRecord[];
  close(): void;
}
