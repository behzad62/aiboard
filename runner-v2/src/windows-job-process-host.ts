/** Internal ownership key. It is deliberately independent of model/agent identities. */
export interface WindowsJobOwnershipKey {
  readonly runId: string;
  readonly sessionId: string;
}

export interface WindowsJobLaunchRequest extends WindowsJobOwnershipKey {
  readonly command: string;
  readonly args: readonly string[];
  readonly workingDirectory: string;
  readonly environment: Readonly<Record<string, string>>;
}

export interface WindowsJobProcessSnapshot {
  readonly processId: string;
  readonly pid: number;
  readonly status: "running" | "stopped" | "exited_unknown";
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly startedAt: string;
  readonly updatedAt: string;
  readonly stdout: string;
  readonly stderr: string;
  readonly ownershipReleased?: boolean;
}

export interface WindowsJobOutputRead {
  readonly stdout: Uint8Array;
  readonly stderr: Uint8Array;
  readonly next: { readonly stdout: number; readonly stderr: number };
}

/** Backend-private host contract. Implementations own authentication and durable reconciliation. */
export interface WindowsJobProcessHost {
  launchOwned(request: WindowsJobLaunchRequest): Promise<WindowsJobProcessSnapshot>;
  signalOwned(
    processId: string,
    signal: "SIGTERM" | "SIGINT" | "SIGKILL",
    owner: WindowsJobOwnershipKey,
  ): Promise<WindowsJobProcessSnapshot>;
  reconcileOwned(processId: string, owner: WindowsJobOwnershipKey): Promise<WindowsJobProcessSnapshot & { readonly ownershipReleased: boolean }>;
  releaseOwned(processId: string, owner: WindowsJobOwnershipKey, expectedStartedAt: string): Promise<WindowsJobProcessSnapshot & { readonly ownershipReleased: boolean }>;
  readOwnedOutput(processId: string, owner: WindowsJobOwnershipKey, offsets: { readonly stdout: number; readonly stderr: number }): WindowsJobOutputRead;
  probeActiveJobCreateClose(): Promise<boolean>;
}

/**
 * Constructs the authenticated backend-private host boundary. The injected
 * mechanics remain inaccessible to adapters and no agent/model identity can
 * enter this surface.
 */
export function createWindowsJobProcessHost(
  operations: WindowsJobProcessHost,
): WindowsJobProcessHost {
  return Object.freeze({
    launchOwned: operations.launchOwned.bind(operations),
    signalOwned: operations.signalOwned.bind(operations),
    reconcileOwned: operations.reconcileOwned.bind(operations),
    releaseOwned: operations.releaseOwned.bind(operations),
    readOwnedOutput: operations.readOwnedOutput.bind(operations),
    probeActiveJobCreateClose: operations.probeActiveJobCreateClose.bind(operations),
  });
}
