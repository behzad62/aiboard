import type { ToolExecutionContext } from "./agent-contracts.js";
import { isProcessStopUnprovenError } from "./process-stop-proof.js";
import type { ManagedProcessSnapshot } from "./managed-process-contracts.js";

export type ManagedProcessOwner = Readonly<Pick<ToolExecutionContext, "runId" | "sessionId" | "actor">>;
export interface ManagedProcessIdentity extends ManagedProcessOwner { readonly processId: string }
export type ManagedProcessTarget = ManagedProcessIdentity & Readonly<ManagedProcessSnapshot>;
export interface ManagedProcessLaunchRequest {
  readonly identity: ManagedProcessIdentity;
  readonly context: Readonly<ToolExecutionContext>;
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly environment: Readonly<Record<string, string>>;
  readonly startTimeoutMs: number;
  readonly cleanupTimeoutMs: number;
  readonly maxOutputBytes: number;
  /** Trusted lifecycle requirements; never inferred from argv or model text. */
  readonly lifecycleRequirements?: import("./execution-lifecycle-policy.js").ExecutionLifecycleRequirements;
  /** Terminal metadata only; never a protocol callback, byte stream or control capability. */
  readonly onTerminal: (observation: Readonly<{ exitCode: number | null; signal: NodeJS.Signals | null }>) => void;
}

/**
 * CW5a: a runtime's `start` throws this only when it has proven that nothing of the launch exists: no process, no
 * fence authority, and no launch or session state that would need a stop. `refusal` is the coded refusal that
 * stopped the launch (for example `windows_batch_argv_unverified`). The managed service then records the process
 * as stopped and throws `refusal` alone, with no stop. A runtime that cannot prove this throws the refusal itself,
 * and the service keeps its exact stop.
 */
export class ManagedLaunchNeverStartedError extends Error {
  readonly refusal: Error & { readonly code: string };
  constructor(refusal: Error & { readonly code: string }) {
    if (!(refusal instanceof Error) || typeof refusal.code !== "string" || !refusal.code)
      throw new TypeError("A never-started launch needs the coded refusal that stopped it.");
    if (isProcessStopUnprovenError(refusal)) throw new TypeError("An unproven stop is never a launch that never started.");
    super(refusal.message, { cause: refusal });
    this.name = "ManagedLaunchNeverStartedError";
    this.refusal = refusal;
  }
}

/** A run-bound shared-session adapter, not an OS process host. No caller can
 * recover an input endpoint, spawn primitive, token or handle from this API. */
export interface ManagedProcessRunRuntime {
  readonly runId: string;
  start(request: ManagedProcessLaunchRequest): Promise<ManagedProcessSnapshot>;
  observe(target: ManagedProcessTarget, context?: Readonly<ToolExecutionContext>, maxOutputBytes?: number): Promise<ManagedProcessSnapshot>;
  observeMany?(targets: readonly ManagedProcessTarget[], context: Readonly<ToolExecutionContext>, maxOutputBytes: number): Promise<readonly ManagedProcessSnapshot[]>;
  stop(target: ManagedProcessTarget, context?: Readonly<ToolExecutionContext>, signal?: NodeJS.Signals, timeoutMs?: number): Promise<ManagedProcessSnapshot>;
  /** Acknowledged, ordered stdin delivery through the owned session channel. Absent: typed unsupported. */
  writeInput?(target: ManagedProcessTarget, context: Readonly<ToolExecutionContext>, request: Readonly<{ bytes: Uint8Array; closeInput: boolean; timeoutMs: number }>): Promise<Readonly<{ inputClosed: boolean }>>;
  /** Exact bounded evidence bytes, optionally after one event-driven wait for new evidence or termination. */
  readOutput?(target: ManagedProcessTarget, context: Readonly<ToolExecutionContext>, request: Readonly<{ waitMs: number; satisfied: (evidence: import("./managed-process-contracts.js").ManagedOutputEvidence) => boolean;
    /** T1: attach read-only CPU evidence when the backend can report it. */
    usage?: boolean;
    /** T1: re-evaluate `satisfied` at least this often for time-based conditions (idle, port). */
    recheckMs?: number;
    /** T1: process.interact reads declare the turn's input operation; one grant covers input and observation. */
    interaction?: "write" | "close_input" }>): Promise<import("./managed-process-contracts.js").ManagedOutputEvidence>;
  /** Finalized spill artifact bytes; read-only evidence, never an execution capability. */
  readSpill?(artifactId: string): Promise<Uint8Array>;
}
