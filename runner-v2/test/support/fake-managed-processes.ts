import {
  ManagedProcessService,
  type ManagedOutputEvidence,
  type ManagedProcessSnapshot,
} from "../../src/managed-process.js";

/**
 * VF5: a ManagedProcessService over an in-memory run runtime, the shape the
 * managed-process unit tests use. Nothing is spawned. Every started process
 * prints `listening` and runs until the service stops it; `log` records each
 * start (with its working directory) and each stop in order, so a test can
 * prove where a process ran and when it ended.
 */
export interface FakeManagedProcesses {
  readonly service: ManagedProcessService;
  readonly log: string[];
  status(processId: string): ManagedProcessSnapshot["status"] | undefined;
}

export function fakeManagedProcesses(input: {
  stateDirectory: string;
  runId: string;
  log?: string[];
  /** A stop the runtime cannot prove: the process stays running. */
  failStop?: boolean;
}): FakeManagedProcesses {
  const log = input.log ?? [];
  const processes = new Map<string, { status: ManagedProcessSnapshot["status"]; stdout: Buffer }>();
  let ids = 0;
  const snapshot = (processId: string): ManagedProcessSnapshot => {
    const status = processes.get(processId)?.status ?? "stopped";
    return {
      processId,
      pid: 4242,
      status,
      exitCode: status === "running" ? null : 0,
      signal: null,
      startedAt: "2026-11-13T00:00:00.000Z",
      updatedAt: "2026-11-13T00:00:00.000Z",
      stdout: "",
      stderr: "",
    };
  };
  const runtime = {
    runId: input.runId,
    async start(request: { identity: { processId: string }; cwd: string }) {
      processes.set(request.identity.processId, { status: "running", stdout: Buffer.from("listening\n") });
      log.push(`start:${request.cwd}`);
      return snapshot(request.identity.processId);
    },
    async observe(target: { processId: string }) {
      return snapshot(target.processId);
    },
    async stop(target: { processId: string }) {
      log.push(`stop:${target.processId}`);
      const state = processes.get(target.processId);
      if (state && !input.failStop) state.status = "stopped";
      return snapshot(target.processId);
    },
    async readOutput(target: { processId: string }): Promise<ManagedOutputEvidence> {
      const state = processes.get(target.processId);
      const stdout = state?.stdout ?? Buffer.alloc(0);
      return {
        snapshot: snapshot(target.processId),
        source: state?.status === "running" ? "live" : "final",
        streams: [
          { stream: "stdout", totalBytes: stdout.byteLength, tail: new Uint8Array(stdout), lossyBytes: 0, lossReasons: [] },
          { stream: "stderr", totalBytes: 0, tail: new Uint8Array(), lossyBytes: 0, lossReasons: [] },
        ],
      };
    },
  };
  const service = new ManagedProcessService({
    stateDirectory: input.stateDirectory,
    runtime,
    idFactory: () => `p${++ids}`,
  } as unknown as ConstructorParameters<typeof ManagedProcessService>[0]);
  return {
    service,
    log,
    status: (processId) => processes.get(processId)?.status,
  };
}
