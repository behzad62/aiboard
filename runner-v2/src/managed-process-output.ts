import { createHmac, timingSafeEqual } from "node:crypto";
import {
  MANAGED_OUTPUT_READ_DEFAULT_BYTES,
  MANAGED_OUTPUT_READ_MAX_BYTES,
  ManagedProcessError,
  type ManagedOutputEvidence,
  type ManagedOutputStreamEvidence,
} from "./managed-process-contracts.js";

/**
 * Incremental process-output reads (N2). Cursor state is caller-held and opaque: one reader's
 * cursor never advances another's view. A cursor binds the exact process, launch and output
 * generation; offsets are absolute byte offsets in each stream. Retention is the bounded evidence
 * spool: the exact live tail (128 KiB per stream) and, after completion, the ingested spill prefix
 * (up to 64 MiB per stream). Bytes outside both are reported as an explicit gap, never as success.
 */
export type ManagedOutputStreamName = "stdout" | "stderr";
export type ManagedOutputStreamSelection = ManagedOutputStreamName | "both";

export interface ManagedOutputCursorBinding {
  readonly processId: string;
  readonly launchId: string;
  /** Output generation: changes whenever the launch configuration or start instant differs. */
  readonly generation: string;
}

export interface ManagedOutputReadRequest {
  readonly cursor?: string;
  readonly stream?: ManagedOutputStreamSelection;
  readonly maxBytes?: number;
  readonly waitMs?: number;
  /** Bounded tail read: the last N bytes of each selected stream. */
  readonly tailBytes?: number;
  /** Explicit earlier range of one stream, by absolute byte offset. */
  readonly range?: Readonly<{ stream: ManagedOutputStreamName; startOffset: number }>;
}

export interface ManagedOutputSlice {
  readonly stream: ManagedOutputStreamName;
  readonly startOffset: number;
  readonly endOffset: number;
  readonly totalBytes: number;
  readonly text: string;
  readonly hasMore: boolean;
  readonly retained: Readonly<{ tailStartOffset: number; spillEndOffset?: number }>;
  /** Bytes the caller asked for that bounded retention no longer holds. Never silently skipped. */
  readonly gap?: Readonly<{ fromOffset: number; toOffset: number; reason: "retention_window_exceeded" | "evidence_lossy" | "utf8_boundary" }>;
  readonly lossyBytes: number;
  readonly lossReasons: readonly string[];
}

export interface ManagedOutputReadResult {
  readonly processId: string;
  readonly status: string;
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly source: ManagedOutputEvidence["source"];
  readonly waited?: ManagedOutputEvidence["waited"];
  readonly slices: readonly ManagedOutputSlice[];
  readonly cursor: string;
  /** True only when the process is terminal, every selected stream was read to its end and nothing was lost. */
  readonly complete: boolean;
  readonly limits: Readonly<{ maxBytesPerStream: number; liveTailBytesPerStream: number; finalSpillBytesPerStream: number }>;
}

export const MANAGED_OUTPUT_LIVE_TAIL_BYTES = 128 * 1024;
export const MANAGED_OUTPUT_FINAL_SPILL_BYTES = 64 * 1024 * 1024;

interface CursorPayload { v: 1; p: string; l: string; g: string; o: [number, number] }

export function encodeOutputCursor(key: Uint8Array, binding: ManagedOutputCursorBinding, offsets: Readonly<Record<ManagedOutputStreamName, number>>): string {
  const payload: CursorPayload = { v: 1, p: binding.processId, l: binding.launchId, g: binding.generation, o: [offsets.stdout, offsets.stderr] };
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${body}.${mac(key, body)}`;
}

export function decodeOutputCursor(key: Uint8Array, binding: ManagedOutputCursorBinding, cursor: string): Record<ManagedOutputStreamName, number> {
  if (typeof cursor !== "string" || cursor.length > 1024 || !/^[A-Za-z0-9_-]+\.[a-f0-9]{32}$/.test(cursor)) throw cursorError("process_output_cursor_invalid", "Output cursor is malformed.");
  const [body, signature] = cursor.split(".") as [string, string];
  const expected = Buffer.from(mac(key, body), "hex");
  if (!timingSafeEqual(expected, Buffer.from(signature, "hex"))) throw cursorError("process_output_cursor_invalid", "Output cursor was not issued for this Runner state or was altered.");
  let payload: CursorPayload;
  try { payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as CursorPayload; }
  catch { throw cursorError("process_output_cursor_invalid", "Output cursor is malformed."); }
  if (payload.v !== 1 || !Array.isArray(payload.o) || payload.o.length !== 2 || payload.o.some(value => !Number.isSafeInteger(value) || value < 0)) throw cursorError("process_output_cursor_invalid", "Output cursor is malformed.");
  if (payload.p !== binding.processId) throw cursorError("process_output_cursor_foreign", "Output cursor belongs to a different process.");
  if (payload.l !== binding.launchId || payload.g !== binding.generation) throw cursorError("process_output_cursor_stale", "Output cursor belongs to an earlier output generation of this process.");
  return { stdout: payload.o[0], stderr: payload.o[1] };
}

export function normalizeOutputRead(request: ManagedOutputReadRequest): Required<Pick<ManagedOutputReadRequest, "stream" | "maxBytes" | "waitMs">> & ManagedOutputReadRequest {
  const stream = request.stream ?? "both";
  if (!["stdout", "stderr", "both"].includes(stream)) throw invalid("stream must be stdout, stderr or both");
  const maxBytes = request.maxBytes ?? MANAGED_OUTPUT_READ_DEFAULT_BYTES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 4 || maxBytes > MANAGED_OUTPUT_READ_MAX_BYTES) throw invalid(`maxBytes must be 4..${MANAGED_OUTPUT_READ_MAX_BYTES}`);
  const waitMs = request.waitMs ?? 0;
  if (!Number.isSafeInteger(waitMs) || waitMs < 0) throw invalid("waitMs must be a non-negative integer");
  const modes = [request.cursor !== undefined, request.tailBytes !== undefined, request.range !== undefined].filter(Boolean).length;
  if (modes > 1) throw invalid("use only one of cursor, tailBytes or range");
  if (request.tailBytes !== undefined && (!Number.isSafeInteger(request.tailBytes) || request.tailBytes < 1 || request.tailBytes > MANAGED_OUTPUT_READ_MAX_BYTES)) throw invalid(`tailBytes must be 1..${MANAGED_OUTPUT_READ_MAX_BYTES}`);
  if (request.range !== undefined) {
    if (!["stdout", "stderr"].includes(request.range.stream) || !Number.isSafeInteger(request.range.startOffset) || request.range.startOffset < 0) throw invalid("range needs stream stdout|stderr and a non-negative startOffset");
    if (waitMs > 0) throw invalid("range reads do not wait");
  }
  return { ...request, stream, maxBytes, waitMs };
}

/** Selected streams have output beyond the given offsets, or the process is no longer running. */
export function hasNewOutput(evidence: ManagedOutputEvidence, offsets: Readonly<Record<ManagedOutputStreamName, number>>, selection: ManagedOutputStreamSelection): boolean {
  if (evidence.snapshot.status !== "running") return true;
  return evidence.streams.some(stream => (selection === "both" || selection === stream.stream) && stream.totalBytes > offsets[stream.stream]);
}

/**
 * Slice exact retained bytes. `readSpill` is consulted only for finalized evidence and only when
 * the requested start precedes the retained tail.
 */
export async function sliceOutput(input: Readonly<{
  evidence: ManagedOutputEvidence;
  stream: ManagedOutputStreamName;
  startOffset: number;
  maxBytes: number;
  readSpill?: (artifactId: string) => Promise<Uint8Array>;
}>): Promise<ManagedOutputSlice> {
  const value = input.evidence.streams.find(entry => entry.stream === input.stream);
  if (!value) throw new ManagedProcessError("process_output_unavailable", `No ${input.stream} evidence is available.`);
  const total = value.totalBytes, tailStart = total - value.tail.byteLength;
  if (input.startOffset > total) throw cursorError("process_output_cursor_stale", `Requested ${input.stream} offset ${input.startOffset} is beyond the ${total} bytes produced.`);
  const spill = input.evidence.source === "final" ? value.spill : undefined;
  let start = input.startOffset, gap: ManagedOutputSlice["gap"] | undefined, bytes: Uint8Array;
  if (start < tailStart && spill && start < spill.bytes && input.readSpill) {
    const whole = await input.readSpill(spill.artifactId);
    if (whole.byteLength < spill.bytes) throw new ManagedProcessError("process_output_unavailable", "Finalized output spill is shorter than its recorded length.");
    bytes = whole.subarray(start, Math.min(spill.bytes, start + input.maxBytes));
  } else {
    if (start < tailStart) {
      gap = { fromOffset: start, toOffset: tailStart, reason: value.lossyBytes > 0 && !spill ? "evidence_lossy" : "retention_window_exceeded" };
      start = tailStart;
    }
    bytes = value.tail.subarray(start - tailStart, Math.min(value.tail.byteLength, start - tailStart + input.maxBytes));
  }
  // A start inside a multi-byte character (gap edge or explicit range) skips to the next boundary.
  let lead = 0;
  while (lead < bytes.byteLength && lead < 3 && (bytes[lead]! & 0xc0) === 0x80) lead += 1;
  if (lead) {
    gap = gap ? { ...gap, toOffset: start + lead } : { fromOffset: start, toOffset: start + lead, reason: "utf8_boundary" };
    start += lead; bytes = bytes.subarray(lead);
  }
  const end = start + utf8CompleteLength(bytes, start + bytes.byteLength < total);
  const exact = bytes.subarray(0, end - start);
  return Object.freeze({
    stream: input.stream, startOffset: start, endOffset: end, totalBytes: total,
    text: Buffer.from(exact).toString("utf8"), hasMore: end < total,
    retained: Object.freeze({ tailStartOffset: tailStart, ...(spill ? { spillEndOffset: spill.bytes } : {}) }),
    ...(gap ? { gap: Object.freeze(gap) } : {}),
    lossyBytes: value.lossyBytes, lossReasons: value.lossReasons,
  });
}

/** Length of the longest prefix that does not end inside a UTF-8 sequence (only trimmed when more bytes follow). */
export function utf8CompleteLength(bytes: Uint8Array, moreFollows: boolean): number {
  if (!moreFollows || bytes.byteLength === 0) return bytes.byteLength;
  let index = bytes.byteLength - 1, continuation = 0;
  while (index >= 0 && continuation < 3 && (bytes[index]! & 0xc0) === 0x80) { index -= 1; continuation += 1; }
  if (index < 0) return bytes.byteLength;
  const leadByte = bytes[index]!;
  const width = leadByte >= 0xf0 ? 4 : leadByte >= 0xe0 ? 3 : leadByte >= 0xc0 ? 2 : 1;
  if (width === 1) return bytes.byteLength;
  const complete = continuation + 1 >= width;
  // maxBytes >= 4 guarantees the next read from this boundary holds the whole character.
  return complete ? bytes.byteLength : index;
}

export function streamsFor(selection: ManagedOutputStreamSelection): ManagedOutputStreamName[] {
  return selection === "both" ? ["stdout", "stderr"] : [selection];
}

export function streamEvidence(evidence: ManagedOutputEvidence, stream: ManagedOutputStreamName): ManagedOutputStreamEvidence | undefined {
  return evidence.streams.find(entry => entry.stream === stream);
}

function mac(key: Uint8Array, body: string): string {
  return createHmac("sha256", key).update(body).digest("hex").slice(0, 32);
}
function invalid(message: string): ManagedProcessError { return new ManagedProcessError("invalid_arguments", message); }
function cursorError(code: string, message: string): ManagedProcessError { return new ManagedProcessError(code, message); }
