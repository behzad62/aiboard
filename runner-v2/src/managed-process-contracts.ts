import type { AgentActor } from "./agent-contracts.js";

/** Public snapshot/legacy historical schemas. Legacy endpoint data is never active execution authority. */
export type ManagedProcessStatus = "running" | "stopped" | "exited_unknown";

export interface ManagedProcessSupervisorRecord {
  protocol: "aiboard-managed-process/v1";
  token: string;
  statusPath: string;
  supervisorPid: number;
  port: number;
}

export interface ManagedProcessRecord {
  processId: string;
  pid: number;
  runId: string;
  sessionId: string;
  actor: AgentActor;
  command: string;
  args: string[];
  cwd: string;
  environmentKeys: string[];
  startedAt: string;
  updatedAt: string;
  status: ManagedProcessStatus;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdoutPath: string;
  stderrPath: string;
  supervisor?: ManagedProcessSupervisorRecord;
  /** Durable terminal authority for the backend adapter; absent for ordinary managed-process use. */
  backendOwnershipReleasedAt?: string;
}

export interface StartManagedProcessInput {
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  /** Runner backend seam; ordinary managed-process callers retain ambient inheritance. */
  inheritEnvironment?: boolean;
}

export interface ManagedProcessSnapshot {
  processId: string;
  pid: number;
  status: ManagedProcessStatus;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  startedAt: string;
  updatedAt: string;
  stdout: string;
  stderr: string;
}

export interface ManagedProcessObservation extends ManagedProcessSnapshot {
  runId: string;
  sessionId: string;
  actor: AgentActor;
  command: string;
  args: string[];
  cwd: string;
  environmentKeys: string[];
}

export interface ManagedProcessOwnershipSnapshot extends ManagedProcessSnapshot {
  ownershipReleased: boolean;
}

export interface ManagedProcessOutputRead {
  readonly stdout: Uint8Array;
  readonly stderr: Uint8Array;
  readonly next: { readonly stdout: number; readonly stderr: number };
}

export class ManagedProcessError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "ManagedProcessError";
  }
}
