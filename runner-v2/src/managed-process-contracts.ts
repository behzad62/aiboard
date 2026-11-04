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
  /** Enables process.write_stdin for this process. Off by default: stdin behavior is otherwise unchanged. */
  interactive?: boolean;
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

/**
 * Interactive input (N1). Line-oriented pipes only: stdin is never a terminal (no PTY/TUI emulation).
 * One write is at most MANAGED_INPUT_MAX_BYTES of UTF-8; appendNewline adds exactly one "
".
 */
export const MANAGED_INPUT_MAX_BYTES = 64 * 1024;
export const MANAGED_INPUT_HISTORY_LIMIT = 256;
export const MANAGED_INPUT_WRITE_TIMEOUT_MS = 15_000;
/** Incremental output (N2): per-call default/maximum and bounded wait for new output. */
export const MANAGED_OUTPUT_READ_DEFAULT_BYTES = 16 * 1024;
export const MANAGED_OUTPUT_READ_MAX_BYTES = 64 * 1024;
export const MANAGED_OUTPUT_WAIT_MAX_MS = 30_000;

/** pending is durable before any byte leaves the Runner; a restart turns it into outcome_unknown, never a replay. */
export type ManagedInputWriteStatus = "pending" | "acknowledged" | "rejected" | "outcome_unknown";

/** Durable input journal entry. Payload bytes are never persisted: digest and length only. */
export interface ManagedInputWriteRecord {
  readonly writeId: string;
  readonly digest: string;
  readonly byteLength: number;
  readonly closeInput: boolean;
  readonly status: ManagedInputWriteStatus;
  readonly requestedAt: string;
  readonly settledAt?: string;
  readonly errorCode?: string;
}

export interface ManagedInputState {
  readonly interactive: boolean;
  readonly inputClosed: boolean;
  readonly writes: readonly ManagedInputWriteRecord[];
}

export interface ManagedInputWriteRequest {
  readonly writeId: string;
  readonly data?: string;
  readonly appendNewline?: boolean;
  readonly closeInput?: boolean;
}

export interface ManagedInputWriteResult {
  readonly processId: string;
  readonly writeId: string;
  readonly status: Exclude<ManagedInputWriteStatus, "pending">;
  readonly byteLength: number;
  readonly inputClosed: boolean;
  /** True when this call returned an earlier identical write's settled outcome without sending again. */
  readonly deduplicated: boolean;
  readonly errorCode?: string;
  readonly message?: string;
}

/** Exact bytes available for one stream from bounded evidence; offsets are absolute stream byte offsets. */
export interface ManagedOutputStreamEvidence {
  readonly stream: "stdout" | "stderr";
  readonly totalBytes: number;
  /** Exact retained suffix [totalBytes - tail.byteLength, totalBytes). */
  readonly tail: Uint8Array;
  readonly lossyBytes: number;
  readonly lossReasons: readonly string[];
  /** Finalized prefix [0, spillBytes) in the artifact store; completed sessions only. */
  readonly spill?: Readonly<{ artifactId: string; bytes: number }>;
}

export interface ManagedOutputEvidence {
  readonly snapshot: ManagedProcessSnapshot;
  /** live: a current owned session; final: authenticated terminal evidence; historical: persisted bounded metadata only. */
  readonly source: "live" | "final" | "historical";
  readonly streams: readonly ManagedOutputStreamEvidence[];
  readonly waited?: "changed" | "terminal" | "timeout" | "cancelled" | "unavailable";
  /** T1: CPU time of the whole owned tree, when the backend reports it. Absent: input_wait is unavailable. */
  readonly cpu?: ManagedProcessCpuEvidence;
}

/**
 * T1 evidence-based waits. A wait ends on the strongest available evidence and labels it:
 * a heuristic may end a wait but never reports success (N1: no success from a guessed prompt).
 */
export const MANAGED_UNTIL_IDLE_MIN_MS = 250;
export const MANAGED_UNTIL_IDLE_MAX_MS = 10_000;
export const MANAGED_UNTIL_IDLE_DEFAULT_MS = 1_500;
export const MANAGED_PATTERN_MAX_CHARS = 256;
/** A pattern is evaluated only on this many trailing bytes of the plain new output. */
export const MANAGED_PATTERN_TAIL_BYTES = 4 * 1024;
/** input_wait requires tree CPU of at most this fraction of one core over the quiet window. */
export const MANAGED_INPUT_WAIT_CPU_FRACTION = 0.02;

export interface ManagedOutputUntil {
  /** Only exit (or waitMs) ends the wait; exclusive with every other condition. */
  readonly exit?: true;
  readonly pattern?: string;
  readonly patternFlags?: "i";
  /** Something accepts TCP on loopback at this port. */
  readonly port?: number;
  /** Enables input_wait / known_prompt / idle after this much output silence. */
  readonly idleMs?: number;
}
/** `unavailable`: the session stopped running observably (input/backend unavailable, cleanup pending) without a proven exit. */
export type ManagedCompletionSource = "exited" | "unavailable" | "pattern" | "port" | "input_wait" | "idle" | "known_prompt" | "changed" | "timeout";
export type ManagedCompletionConfidence = "certain" | "likely" | "heuristic";
export interface ManagedOutputCompletion {
  readonly source: ManagedCompletionSource;
  /** null for changed, timeout and unavailable, which make no claim about the process. */
  readonly confidence: ManagedCompletionConfidence | null;
  readonly quietMs?: number;
  readonly cpuDeltaMs?: number;
  readonly preexistingPort?: true;
  readonly matched?: string;
}
/** `unknown`: not running, and exit is not proven (see ManagedCompletionSource `unavailable`). */
export type ManagedInteractionState = "running" | "awaiting_input" | "idle" | "exited" | "unknown";
export interface ManagedProcessCpuEvidence {
  /** User + kernel CPU time of the owned tree, monotonic within one launch. */
  readonly totalMs: number;
  readonly sampledAt: string;
  /** sampledAt is refreshed on a fixed cadence even when CPU is flat, so an old sample really is old (POSIX). */
  readonly steady?: true;
}

export class ManagedProcessError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "ManagedProcessError";
  }
}
