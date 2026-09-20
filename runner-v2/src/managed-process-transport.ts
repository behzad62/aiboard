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
}
