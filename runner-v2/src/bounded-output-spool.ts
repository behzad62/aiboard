import { randomUUID } from "node:crypto";
import type { FileHandle } from "node:fs/promises";
import {
  mkdir,
  open,
  readFile,
  readdir,
  rmdir,
  unlink,
} from "node:fs/promises";
import { resolve } from "node:path";

export type OutputStream = "stdout" | "stderr";
export type OutputLossReasonCode =
  | "spill_cap_exceeded"
  | "spill_open_failed"
  | "spill_write_failed"
  | "spill_close_failed"
  | "artifact_ingestion_failed";
export type OutputSpillState = "empty" | "discarded" | "artifact_ingested" | "lossy";

export interface OutputLossReason {
  readonly code: OutputLossReasonCode;
  readonly stream: OutputStream;
}

export interface BoundedOutputStreamResult {
  readonly stream: OutputStream;
  readonly tail: string;
  readonly totalBytes: number;
  readonly truncated: boolean;
  readonly spillState: OutputSpillState;
  readonly spillArtifactId?: string;
  readonly spillBytes: number;
  readonly lossyBytes: number;
  readonly lossyOutput: boolean;
  readonly lossReason?: OutputLossReason;
}

export interface BoundedOutputSpoolResult {
  readonly streams: readonly BoundedOutputStreamResult[];
}

export interface OutputSpillFile {
  write(bytes: Uint8Array): Promise<number>;
  close(): Promise<void>;
}

export interface OutputSpillStorage {
  prepareRoot(root: string): Promise<void>;
  openExclusive(path: string): Promise<OutputSpillFile>;
  read(path: string): Promise<Buffer>;
  remove(path: string): Promise<void>;
  removeRootIfEmpty(root: string): Promise<void>;
  list(root: string): Promise<string[]>;
}

export interface OutputArtifactStore {
  put(bytes: Uint8Array, mediaType: string, label?: string): Promise<{ readonly hash: string }>;
}

export interface BoundedOutputSpoolOptions {
  readonly spillRoot: string;
  readonly tailBytes?: number;
  readonly spillBytes?: number;
  readonly artifactStore?: OutputArtifactStore;
  readonly storage?: OutputSpillStorage;
}

interface MutableStreamState {
  readonly stream: OutputStream;
  tail: Buffer;
  totalBytes: number;
  spillBytes: number;
  lossyBytes: number;
  lossReason?: OutputLossReason;
  spillPath?: string;
  spillFile?: OutputSpillFile;
  spillArtifactId?: string;
  finalized: boolean;
}

const DEFAULT_TAIL_BYTES = 128 * 1024;
const DEFAULT_SPILL_BYTES = 64 * 1024 * 1024;
const SPILL_PREFIX = "output-spill-";
const SPILL_SUFFIX = ".tmp";

export class BoundedOutputSpool {
  private readonly spillRoot: string;
  private readonly tailBytes: number;
  private readonly maximumSpillBytes: number;
  private readonly artifactStore?: OutputArtifactStore;
  private readonly storage: OutputSpillStorage;
  private readonly states = new Map<OutputStream, MutableStreamState>([
    ["stdout", freshState("stdout")],
    ["stderr", freshState("stderr")],
  ]);
  private operation = Promise.resolve();
  private result?: BoundedOutputSpoolResult;

  constructor(options: BoundedOutputSpoolOptions) {
    this.spillRoot = resolve(requiredText(options.spillRoot, "spillRoot"));
    this.tailBytes = positiveInteger(options.tailBytes ?? DEFAULT_TAIL_BYTES, "tailBytes");
    this.maximumSpillBytes = positiveInteger(options.spillBytes ?? DEFAULT_SPILL_BYTES, "spillBytes");
    this.artifactStore = options.artifactStore;
    this.storage = options.storage ?? createNodeOutputSpillStorage();
  }

  async write(stream: OutputStream, chunk: Uint8Array): Promise<void> {
    if (this.result) throw new Error("Output spool is already finalized.");
    const bytes = Buffer.from(chunk);
    const work = this.operation.then(async () => await this.writeNow(stream, bytes));
    this.operation = work.catch(() => undefined);
    await work;
  }

  async finalize(): Promise<BoundedOutputSpoolResult> {
    await this.operation;
    if (this.result) return this.result;
    for (const state of this.states.values()) await this.finalizeStream(state);
    this.result = {
      streams: (["stdout", "stderr"] as const).map((stream) => this.snapshot(this.states.get(stream)!)),
    };
    await this.cleanup();
    return this.result;
  }

  async cleanup(): Promise<void> {
    await this.operation;
    for (const state of this.states.values()) {
      if (state.spillFile) {
        await state.spillFile.close().catch(() => undefined);
        state.spillFile = undefined;
      }
      if (state.spillPath) {
        await this.storage.remove(state.spillPath).catch(() => undefined);
        state.spillPath = undefined;
      }
    }
    await this.storage.removeRootIfEmpty(this.spillRoot).catch(() => undefined);
  }

  private async writeNow(stream: OutputStream, bytes: Buffer): Promise<void> {
    const state = this.states.get(stream);
    if (!state) throw new Error(`Unsupported output stream: ${stream as string}.`);
    if (state.finalized) throw new Error("Output spool stream is already finalized.");
    if (bytes.byteLength === 0) return;

    state.totalBytes += bytes.byteLength;
    state.tail = appendTail(state.tail, bytes, this.tailBytes);
    if (state.lossReason && state.lossReason.code !== "spill_cap_exceeded") {
      state.lossyBytes += bytes.byteLength;
      return;
    }

    const remaining = this.maximumSpillBytes - state.spillBytes;
    const spillable = bytes.subarray(0, Math.max(0, remaining));
    const overflow = bytes.byteLength - spillable.byteLength;
    if (spillable.byteLength > 0) {
      if (!(await this.ensureOpen(state))) {
        state.lossyBytes += bytes.byteLength;
        return;
      }
      try {
        const written = await state.spillFile!.write(spillable);
        if (written !== spillable.byteLength) throw new Error("Short spill write.");
        state.spillBytes += written;
      } catch {
        this.markLoss(state, "spill_write_failed");
        state.lossyBytes += bytes.byteLength;
        return;
      }
    }
    if (overflow > 0) {
      this.markLoss(state, "spill_cap_exceeded");
      state.lossyBytes += overflow;
    }
  }

  private async ensureOpen(state: MutableStreamState): Promise<boolean> {
    if (state.spillFile) return true;
    try {
      await this.storage.prepareRoot(this.spillRoot);
      state.spillPath = resolve(
        this.spillRoot,
        `${SPILL_PREFIX}${state.stream}-${randomUUID()}${SPILL_SUFFIX}`
      );
      state.spillFile = await this.storage.openExclusive(state.spillPath);
      return true;
    } catch {
      this.markLoss(state, "spill_open_failed");
      if (state.spillPath) await this.storage.remove(state.spillPath).catch(() => undefined);
      state.spillPath = undefined;
      return false;
    }
  }

  private async finalizeStream(state: MutableStreamState): Promise<void> {
    if (state.finalized) return;
    state.finalized = true;
    let closeFailed = false;
    if (state.spillFile) {
      try {
        await state.spillFile.close();
      } catch {
        closeFailed = true;
        state.lossReason = { code: "spill_close_failed", stream: state.stream };
        state.lossyBytes = state.totalBytes;
      } finally {
        state.spillFile = undefined;
      }
    }
    if (!state.spillPath || state.spillBytes === 0 || closeFailed) return;
    if (this.artifactStore) {
      try {
        const bytes = await this.storage.read(state.spillPath);
        const artifact = await this.artifactStore.put(
          bytes,
          "application/octet-stream",
          `${state.stream} process output`
        );
        state.spillArtifactId = artifact.hash;
      } catch {
        this.markLoss(state, "artifact_ingestion_failed");
        state.lossyBytes = Math.max(state.lossyBytes, state.spillBytes);
      }
    }
  }

  private markLoss(state: MutableStreamState, code: OutputLossReasonCode): void {
    state.lossReason ??= { code, stream: state.stream };
  }

  private snapshot(state: MutableStreamState): BoundedOutputStreamResult {
    const marker = state.lossReason ? Buffer.from(`[runner output lossy: ${state.lossReason.code}]\n`) : Buffer.alloc(0);
    const retainedTail = state.lossReason
      ? utf8AlignedSuffix(state.tail, Math.max(0, this.tailBytes - marker.byteLength))
      : state.tail;
    const tail = state.lossReason
      ? Buffer.concat([marker, retainedTail])
      : retainedTail;
    const retainedOutputBytes = retainedTail.byteLength;
    const spillState: OutputSpillState = state.lossReason
      ? "lossy"
      : state.spillArtifactId
        ? "artifact_ingested"
        : state.spillBytes > 0
          ? "discarded"
          : "empty";
    return {
      stream: state.stream,
      tail: decodeUtf8Tail(tail),
      totalBytes: state.totalBytes,
      truncated: state.totalBytes > retainedOutputBytes,
      spillState,
      ...(state.spillArtifactId ? { spillArtifactId: state.spillArtifactId } : {}),
      spillBytes: state.spillBytes,
      lossyBytes: state.lossyBytes,
      lossyOutput: Boolean(state.lossReason),
      ...(state.lossReason ? { lossReason: state.lossReason } : {}),
    };
  }
}

export function createNodeOutputSpillStorage(): OutputSpillStorage {
  return {
    prepareRoot: async (root) => await mkdir(root, { recursive: true, mode: 0o700 }).then(() => undefined),
    openExclusive: async (path) => nodeSpillFile(await open(path, "wx", 0o600)),
    read: async (path) => await readFile(path),
    remove: async (path) => await unlink(path).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    }),
    removeRootIfEmpty: async (root) => await rmdir(root).catch((error: NodeJS.ErrnoException) => {
      if (!new Set(["ENOENT", "ENOTEMPTY", "EEXIST"]).has(error.code ?? "")) throw error;
    }),
    list: async (root) => await readdir(root).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    }),
  };
}

export async function cleanupOutputSpillRoot(
  spillRoot: string,
  storage: OutputSpillStorage = createNodeOutputSpillStorage()
): Promise<void> {
  const root = resolve(requiredText(spillRoot, "spillRoot"));
  for (const name of await storage.list(root)) {
    if (name.startsWith(SPILL_PREFIX) && name.endsWith(SPILL_SUFFIX)) {
      await storage.remove(resolve(root, name));
    }
  }
  await storage.removeRootIfEmpty(root).catch(() => undefined);
}

function nodeSpillFile(handle: FileHandle): OutputSpillFile {
  return {
    write: async (bytes) => (await handle.write(bytes)).bytesWritten,
    close: async () => await handle.close(),
  };
}

function freshState(stream: OutputStream): MutableStreamState {
  return { stream, tail: Buffer.alloc(0), totalBytes: 0, spillBytes: 0, lossyBytes: 0, finalized: false };
}

function appendTail(current: Buffer, incoming: Buffer, maximum: number): Buffer {
  if (incoming.byteLength >= maximum) return Buffer.from(incoming.subarray(incoming.byteLength - maximum));
  const retained = Math.min(current.byteLength, maximum - incoming.byteLength);
  return Buffer.concat([current.subarray(current.byteLength - retained), incoming], retained + incoming.byteLength);
}

function suffix(bytes: Buffer, maximum: number): Buffer {
  return bytes.byteLength <= maximum ? bytes : bytes.subarray(bytes.byteLength - maximum);
}

function utf8AlignedSuffix(bytes: Buffer, maximum: number): Buffer {
  const candidate = suffix(bytes, maximum);
  let start = 0;
  while (start < candidate.byteLength && (candidate[start]! & 0xc0) === 0x80) start += 1;
  return candidate.subarray(start);
}

function decodeUtf8Tail(bytes: Buffer): string {
  return utf8AlignedSuffix(bytes, bytes.byteLength).toString("utf8");
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive integer.`);
  return value;
}

function requiredText(value: string, name: string): string {
  if (!value.trim()) throw new Error(`${name} is required.`);
  return value;
}
