import { createHash } from "node:crypto";
import { open, type FileHandle } from "node:fs/promises";
import type { RemoteFrameLimits } from "./remote-frame-codec.js";

/**
 * R3 artifact data plane, device side. A content-addressed artifact streams as
 * bounded chunk frames under a credit window: at most `window` chunks are ever
 * unacknowledged. A whole-file preflight and bounded block digests verify each
 * in-memory block again before its chunks leave. Each chunk carries its own SHA-256; the end
 * frame is sent only after every chunk is acknowledged and the whole artifact
 * re-hashed to its address. Resume is a new transfer from an acknowledged
 * offset — no transfer state survives the connection that carried it.
 */

export interface ArtifactTransferSource {
  readonly path: string;
  readonly hash: string;
  readonly byteLength: number;
}

const VERIFY_BLOCK_BYTES = 4 * 1024 * 1024;
/** Cap the preflight digest table at 3.2 MiB (about 390 GiB of artifact data). */
const MAX_VERIFY_BLOCKS = 100_000;

export type ArtifactTransferErrorCode = "transfer_stalled" | "artifact_corrupt" | "artifact_unavailable" | "result_withheld_by_policy";

export type ArtifactTransferFrame =
  | {
    readonly type: "chunk"; readonly transferId: string; readonly seq: number;
    readonly offset: number; readonly length: number; readonly sha256: string; readonly data: string;
  }
  | { readonly type: "artifact_end"; readonly transferId: string; readonly byteLength: number; readonly sha256: string }
  | { readonly type: "artifact_error"; readonly transferId: string; readonly code: ArtifactTransferErrorCode };

export interface ArtifactTransferOptions {
  readonly limits: () => RemoteFrameLimits;
  readonly send: (frame: ArtifactTransferFrame, signal: AbortSignal, beforeSend?: () => boolean) => Promise<void> | void;
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
  readonly controller: AbortController;
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
    if (!Number.isSafeInteger(source.byteLength) || source.byteLength < 0 ||
      !Number.isSafeInteger(offset) || offset < 0 || offset > source.byteLength) {
      throw new ArtifactTransferError("invalid_offset", "Transfer offset is outside the artifact.");
    }
    this.transfers.set(transferId, { id: transferId, unacked: new Set(), controller: new AbortController(), aborted: false, wake: undefined, maxUnacked: 0 });
  }

  /** Stream a reserved transfer to completion, error or abort. Never throws. */
  async run(transferId: string, source: ArtifactTransferSource, offset: number, beforeRelease?: () => ArtifactTransferErrorCode | undefined): Promise<void> {
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
      const blockCount = Math.ceil(source.byteLength / VERIFY_BLOCK_BYTES);
      if (blockCount > MAX_VERIFY_BLOCKS) { await this.fail(transfer, "artifact_unavailable"); return; }
      const buffer = Buffer.allocUnsafe(VERIFY_BLOCK_BYTES);
      const blockHashes = Buffer.allocUnsafe(blockCount * 32);
      const verified = createHash("sha256");
      for (let position = 0, block = 0; position < source.byteLength; block++) {
        const length = Math.min(buffer.byteLength, source.byteLength - position);
        const { bytesRead } = await handle.read(buffer, 0, length, position);
        if (bytesRead !== length) { await this.fail(transfer, "artifact_corrupt"); return; }
        const bytes = buffer.subarray(0, bytesRead);
        verified.update(bytes);
        createHash("sha256").update(bytes).digest().copy(blockHashes, block * 32);
        position += bytesRead;
        if (transfer.aborted) return;
      }
      if (verified.digest("hex") !== source.hash) { await this.fail(transfer, "artifact_corrupt"); return; }
      const whole = createHash("sha256");
      // A resumed transfer still proves the whole artifact: hash the prefix without sending it.
      for (let position = 0; position < offset;) {
        const length = Math.min(buffer.byteLength, offset - position);
        const { bytesRead } = await handle.read(buffer, 0, length, position);
        if (bytesRead !== length) { await this.fail(transfer, "artifact_corrupt"); return; }
        if (transfer.aborted) return;
        const refusal = beforeRelease?.();
        if (refusal) { await this.fail(transfer, refusal); return; }
        whole.update(buffer.subarray(0, bytesRead));
        position += bytesRead;
        if (transfer.aborted) return;
      }
      let seq = 0;
      for (let position = offset; position < source.byteLength;) {
        const block = Math.floor(position / VERIFY_BLOCK_BYTES);
        const blockStart = block * VERIFY_BLOCK_BYTES;
        const length = Math.min(VERIFY_BLOCK_BYTES, source.byteLength - blockStart);
        const { bytesRead } = await handle.read(buffer, 0, length, blockStart);
        if (bytesRead !== length || !createHash("sha256").update(buffer.subarray(0, bytesRead)).digest()
          .equals(blockHashes.subarray(block * 32, (block + 1) * 32))) {
          await this.fail(transfer, "artifact_corrupt"); return;
        }
        for (let inBlock = position - blockStart; inBlock < bytesRead;) {
          if (!(await this.awaitCredit(transfer, limits.window))) return;
          const refusal = beforeRelease?.();
          if (refusal) { await this.fail(transfer, refusal); return; }
          const chunkLength = Math.min(limits.chunkBytes, bytesRead - inBlock);
          const chunk = buffer.subarray(inBlock, inBlock + chunkLength);
          whole.update(chunk);
          transfer.unacked.add(seq);
          transfer.maxUnacked = Math.max(transfer.maxUnacked, transfer.unacked.size);
          if (!(await this.emit(transfer, {
            type: "chunk", transferId, seq, offset: position, length: chunkLength,
            sha256: createHash("sha256").update(chunk).digest("hex"), data: chunk.toString("base64"),
          }, beforeRelease))) return;
          inBlock += chunkLength;
          position += chunkLength;
          seq += 1;
        }
      }
      if (!(await this.awaitCredit(transfer, 1, true))) return;
      if (whole.digest("hex") !== source.hash) { await this.fail(transfer, "artifact_corrupt"); return; }
      const refusal = beforeRelease?.();
      if (refusal) { await this.fail(transfer, refusal); return; }
      await this.emit(transfer, { type: "artifact_end", transferId, byteLength: source.byteLength, sha256: source.hash }, beforeRelease);
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
    transfer.controller.abort();
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

  private async emit(transfer: Transfer, frame: ArtifactTransferFrame, beforeSend?: () => ArtifactTransferErrorCode | undefined): Promise<boolean> {
    if (transfer.aborted) return false;
    try {
      const signal = transfer.controller.signal;
      await new Promise<void>((resolve, reject) => {
        const abort = () => { signal.removeEventListener("abort", abort); reject(new Error("Transfer aborted.")); };
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) { abort(); return; }
        Promise.resolve().then(() => this.options.send(frame, signal, beforeSend ? () => beforeSend() === undefined : undefined)).then(
          () => { signal.removeEventListener("abort", abort); resolve(); },
          (error: unknown) => { signal.removeEventListener("abort", abort); reject(error); },
        );
      });
      return !transfer.aborted;
    } catch {
      const refusal = beforeSend?.();
      if (!transfer.aborted && refusal) {
        await this.fail(transfer, refusal);
        return false;
      }
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
