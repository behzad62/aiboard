import type { ToolExecutionContext } from "./agent-contracts.js";
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
  readOutput?(target: ManagedProcessTarget, context: Readonly<ToolExecutionContext>, request: Readonly<{ waitMs: number; satisfied: (evidence: import("./managed-process-contracts.js").ManagedOutputEvidence) => boolean }>): Promise<import("./managed-process-contracts.js").ManagedOutputEvidence>;
  /** Finalized spill artifact bytes; read-only evidence, never an execution capability. */
  readSpill?(artifactId: string): Promise<Uint8Array>;
}
