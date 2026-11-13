import { NativeOwnedProcessBackend } from "./native-process-backend.js";
import type { NativeProcessOperations } from "./native-process-backend.js";

export interface PosixProcessBackendOptions {
  readonly stateDirectory?: string;
  readonly pollIntervalMs?: number;
  readonly operations?: NativeProcessOperations;
  readonly replayCapacityChunks?: number;
  readonly replayCapacityBytes?: number;
}

/**
 * The POSIX retained output window: 16 chunks of up to 256 KiB. Every pass over the window costs a
 * fenced snapshot, one fenced ACK effect and one fenced supervisor retirement, each a pair of durable
 * SQLite commits, so the window size sets POSIX output throughput. A 256 KiB window held it near
 * 1 MiB/s on a Linux overlay disk. The chunk count stays 16, which streaming sessions require
 * (maxAcceptedChunks), and a chunk never exceeds one streaming frame.
 */
export const POSIX_REPLAY_CAPACITY_CHUNKS = 16;
export const POSIX_REPLAY_CAPACITY_BYTES = 16 * 256 * 1024;

export class PosixProcessBackend extends NativeOwnedProcessBackend {
  constructor(options: PosixProcessBackendOptions = {}) {
    super({
      ...options,
      replayCapacityChunks: options.replayCapacityChunks ?? POSIX_REPLAY_CAPACITY_CHUNKS,
      replayCapacityBytes: options.replayCapacityBytes ?? POSIX_REPLAY_CAPACITY_BYTES,
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
