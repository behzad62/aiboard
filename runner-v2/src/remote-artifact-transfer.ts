import { createHash } from "node:crypto";
import { open, type FileHandle } from "node:fs/promises";
import type { RemoteFrameLimits } from "./remote-frame-codec.js";

/**
 * R3 artifact data plane, device side. A content-addressed artifact streams as
 * bounded chunk frames under a credit window: at most `window` chunks are ever
 * unacknowledged, and only one chunk buffer is read at a time, so memory stays
 * bounded under a slow receiver. Each chunk carries its own SHA-256; the end
 * frame is sent only after every chunk is acknowledged and the whole artifact
 * re-hashed to its address. Resume is a new transfer from an acknowledged
 * offset — no transfer state survives the connection that carried it.
 */

export interface ArtifactTransferSource {
  readonly path: string;
  readonly hash: string;
  readonly byteLength: number;
}

export type ArtifactTransferErrorCode = "transfer_stalled" | "artifact_corrupt" | "artifact_unavailable";

export type ArtifactTransferFrame =
  | {
    readonly type: "chunk"; readonly transferId: string; readonly seq: number;
    readonly offset: number; readonly length: number; readonly sha256: string; readonly data: string;
  }
  | { readonly type: "artifact_end"; readonly transferId: string; readonly byteLength: number; readonly sha256: string }
  | { readonly type: "artifact_error"; readonly transferId: string; readonly code: ArtifactTransferErrorCode };

export interface ArtifactTransferOptions {
  readonly limits: () => RemoteFrameLimits;
  readonly send: (frame: ArtifactTransferFrame) => Promise<void> | void;
  /** Time with a full window and no acknowledgment before the transfer fails; defaults to 60 s. */
  readonly stallTimeoutMs?: number;
  /** Concurrent transfers per connection; defaults to 4. */
  readonly maxConcurrent?: number;
}

export class ArtifactTransferError extends Error {
  constructor(readonly code: "transfer_limit" | "invalid_offset" | "duplicate_transfer", message: string) {
    super(message);
    this.name = "ArtifactTransferError";
  }
}

interface Transfer {
  readonly id: string;
  readonly unacked: Set<number>;
  aborted: boolean;
  wake: (() => void) | undefined;
  maxUnacked: number;
}

export class ArtifactTransferManager {
  private readonly transfers = new Map<string, Transfer>();
  private readonly stallTimeoutMs: number;
  private readonly maxConcurrent: number;

  constructor(private readonly options: ArtifactTransferOptions) {
    this.stallTimeoutMs = options.stallTimeoutMs ?? 60_000;
    this.maxConcurrent = options.maxConcurrent ?? 4;
  }

  get active(): number { return this.transfers.size; }

  /** Highest number of unacknowledged chunks a live transfer has reached (test evidence). */
  peakUnacked(transferId: string): number | undefined { return this.transfers.get(transferId)?.maxUnacked; }

  /** Validate and reserve a transfer slot; streaming starts with `run`. */
  reserve(transferId: string, source: ArtifactTransferSource, offset: number): void {
    if (this.transfers.has(transferId)) throw new ArtifactTransferError("duplicate_transfer", "Transfer id is already active.");
    if (this.transfers.size >= this.maxConcurrent) throw new ArtifactTransferError("transfer_limit", "Too many concurrent artifact transfers.");
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > source.byteLength) {
      throw new ArtifactTransferError("invalid_offset", "Transfer offset is outside the artifact.");
    }
    this.transfers.set(transferId, { id: transferId, unacked: new Set(), aborted: false, wake: undefined, maxUnacked: 0 });
  }

  /** Stream a reserved transfer to completion, error or abort. Never throws. */
  async run(transferId: string, source: ArtifactTransferSource, offset: number): Promise<void> {
    const transfer = this.transfers.get(transferId);
    if (!transfer) return;
    let handle: FileHandle | undefined;
    try {
      try {
        handle = await open(source.path, "r");
        if ((await handle.stat()).size !== source.byteLength) throw new Error("size");
      } catch {
        await this.fail(transfer, "artifact_corrupt");
        return;
      }
      const limits = this.options.limits();
      const whole = createHash("sha256");
      // A resumed transfer still proves the whole artifact: hash the prefix without sending it.
      const buffer = Buffer.allocUnsafe(limits.chunkBytes);
      for (let position = 0; position < offset;) {
        const length = Math.min(buffer.byteLength, offset - position);
        const { bytesRead } = await handle.read(buffer, 0, length, position);
        if (bytesRead !== length) { await this.fail(transfer, "artifact_corrupt"); return; }
        whole.update(buffer.subarray(0, bytesRead));
        position += bytesRead;
        if (transfer.aborted) return;
      }
      let seq = 0;
      for (let position = offset; position < source.byteLength;) {
        if (!(await this.awaitCredit(transfer, limits.window))) return;
        const length = Math.min(limits.chunkBytes, source.byteLength - position);
        const { bytesRead } = await handle.read(buffer, 0, length, position);
        if (bytesRead !== length) { await this.fail(transfer, "artifact_corrupt"); return; }
        const chunk = buffer.subarray(0, length);
        whole.update(chunk);
        transfer.unacked.add(seq);
        transfer.maxUnacked = Math.max(transfer.maxUnacked, transfer.unacked.size);
        if (!(await this.emit(transfer, {
          type: "chunk", transferId, seq, offset: position, length,
          sha256: createHash("sha256").update(chunk).digest("hex"), data: chunk.toString("base64"),
        }))) return;
        position += length;
        seq += 1;
      }
      if (!(await this.awaitCredit(transfer, 1, true))) return;
      if (whole.digest("hex") !== source.hash) { await this.fail(transfer, "artifact_corrupt"); return; }
      await this.emit(transfer, { type: "artifact_end", transferId, byteLength: source.byteLength, sha256: source.hash });
    } catch {
      await this.fail(transfer, "artifact_unavailable");
    } finally {
      await handle?.close().catch(() => undefined);
      if (this.transfers.get(transferId) === transfer) this.transfers.delete(transferId);
    }
  }

  /** A receiver acknowledgment for one chunk; unknown or duplicate sequences are ignored. */
  ack(transferId: string, seq: unknown): void {
    const transfer = this.transfers.get(transferId);
    if (!transfer || typeof seq !== "number" || !transfer.unacked.delete(seq)) return;
    transfer.wake?.();
  }

  /** Receiver-initiated stop; nothing further is sent for this transfer. */
  abort(transferId: string): void {
    const transfer = this.transfers.get(transferId);
    if (!transfer) return;
    transfer.aborted = true;
    transfer.wake?.();
    this.transfers.delete(transferId);
  }

  /** The carrying connection closed; the receiver resumes with a new transfer. */
  abortAll(): void {
    for (const id of [...this.transfers.keys()]) this.abort(id);
  }

  /** Wait until fewer than `window` chunks are unacknowledged (or none, when draining). */
  private async awaitCredit(transfer: Transfer, window: number, drain = false): Promise<boolean> {
    const satisfied = () => drain ? transfer.unacked.size === 0 : transfer.unacked.size < window;
    while (!transfer.aborted && !satisfied()) {
      const progressed = await new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => { transfer.wake = undefined; resolve(false); }, this.stallTimeoutMs);
        transfer.wake = () => { clearTimeout(timer); transfer.wake = undefined; resolve(true); };
      });
      if (!progressed && !transfer.aborted) {
        await this.fail(transfer, "transfer_stalled");
        return false;
      }
    }
    return !transfer.aborted;
  }

  private async emit(transfer: Transfer, frame: ArtifactTransferFrame): Promise<boolean> {
    if (transfer.aborted) return false;
    try {
      await this.options.send(frame);
      return !transfer.aborted;
    } catch {
      // The socket is gone; the receiver resumes from its last verified offset.
      transfer.aborted = true;
      return false;
    }
  }

  private async fail(transfer: Transfer, code: ArtifactTransferErrorCode): Promise<void> {
    if (transfer.aborted) return;
    await this.emit(transfer, { type: "artifact_error", transferId: transfer.id, code });
    transfer.aborted = true;
  }
}
