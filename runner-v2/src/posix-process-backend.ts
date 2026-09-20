import { NativeOwnedProcessBackend } from "./native-process-backend.js";
import type { NativeProcessOperations } from "./native-process-backend.js";

export interface PosixProcessBackendOptions {
  readonly stateDirectory?: string;
  readonly pollIntervalMs?: number;
  readonly operations?: NativeProcessOperations;
  readonly replayCapacityChunks?: number;
  readonly replayCapacityBytes?: number;
}

export class PosixProcessBackend extends NativeOwnedProcessBackend {
  constructor(options: PosixProcessBackendOptions = {}) {
    super({
      ...options,
      platform: "posix",
      backendId: "runner-posix-process-group-v1",
      lifecycleScope: "process_group",
      capabilities: {
        tree_termination: "enforced",
        crash_cleanup: "unavailable",
        verified_emptiness: "enforced",
        write_confinement: "unavailable",
      },
    });
  }
}

export function createPosixProcessBackend(options: PosixProcessBackendOptions = {}): PosixProcessBackend {
  return new PosixProcessBackend(options);
}
