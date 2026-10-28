/**
 * R3 frame limits for the device transport. One negotiated maximum governs
 * every frame in both directions (fixing the old 4 MiB relay / 8 MiB stdio
 * mismatch); artifact bytes travel as bounded chunks under that maximum.
 * Sizes are checked on raw bytes before any JSON parsing.
 */

export const REMOTE_FRAME_MIN_BYTES = 64 * 1024;
export const REMOTE_FRAME_MAX_BYTES = 1024 * 1024;
export const REMOTE_TRANSFER_MAX_WINDOW = 16;

/** Bytes reserved for a chunk frame's JSON envelope around its base64 data. */
const CHUNK_ENVELOPE_BYTES = 1024;
const CHUNK_ALIGN_BYTES = 4 * 1024;

export interface RemoteFrameLimits {
  /** Largest encoded frame either side may send. */
  readonly maxFrameBytes: number;
  /** Raw artifact bytes per chunk frame (before base64). */
  readonly chunkBytes: number;
  /** Chunks a sender may have in flight without an acknowledgment. */
  readonly window: number;
}

export type RemoteFrameErrorCode = "frame_too_large" | "malformed_frame" | "unsupported_limits";

export class RemoteFrameError extends Error {
  constructor(readonly code: RemoteFrameErrorCode, message: string) {
    super(message);
    this.name = "RemoteFrameError";
  }
}

/** Largest 4 KiB-aligned raw chunk whose base64 frame fits under maxFrameBytes. */
export function chunkBytesFor(maxFrameBytes: number): number {
  const raw = Math.floor((maxFrameBytes - CHUNK_ENVELOPE_BYTES) / 4) * 3;
  return Math.max(CHUNK_ALIGN_BYTES, Math.floor(raw / CHUNK_ALIGN_BYTES) * CHUNK_ALIGN_BYTES);
}

export const DEFAULT_REMOTE_FRAME_LIMITS: RemoteFrameLimits = Object.freeze({
  maxFrameBytes: REMOTE_FRAME_MAX_BYTES,
  chunkBytes: chunkBytesFor(REMOTE_FRAME_MAX_BYTES),
  window: 8,
});

function boundedInteger(value: unknown, minimum: number, maximum: number): number | undefined {
  return Number.isSafeInteger(value) && (value as number) >= minimum && (value as number) <= maximum ? value as number : undefined;
}

/**
 * Effective limits are the minimum of what each side offers. A malformed or
 * out-of-range offer fails closed instead of being clamped silently; an absent
 * offer means the peer accepts the local defaults.
 */
export function negotiateFrameLimits(local: RemoteFrameLimits, offered: unknown): RemoteFrameLimits {
  if (offered === undefined) return local;
  if (typeof offered !== "object" || offered === null || Array.isArray(offered)) {
    throw new RemoteFrameError("unsupported_limits", "Frame limits must be an object.");
  }
  const record = offered as Record<string, unknown>;
  if (Object.keys(record).some((key) => !["maxFrameBytes", "chunkBytes", "window"].includes(key))) {
    throw new RemoteFrameError("unsupported_limits", "Frame limits contain an unknown field.");
  }
  const maxFrameBytes = boundedInteger(record.maxFrameBytes, REMOTE_FRAME_MIN_BYTES, REMOTE_FRAME_MAX_BYTES);
  const chunkBytes = record.chunkBytes === undefined ? Number.MAX_SAFE_INTEGER :
    boundedInteger(record.chunkBytes, CHUNK_ALIGN_BYTES, REMOTE_FRAME_MAX_BYTES);
  const window = record.window === undefined ? Number.MAX_SAFE_INTEGER :
    boundedInteger(record.window, 1, REMOTE_TRANSFER_MAX_WINDOW);
  if (maxFrameBytes === undefined || chunkBytes === undefined || window === undefined) {
    throw new RemoteFrameError("unsupported_limits", "Frame limits are outside the supported range.");
  }
  const effectiveFrame = Math.min(local.maxFrameBytes, maxFrameBytes);
  return {
    maxFrameBytes: effectiveFrame,
    chunkBytes: Math.min(local.chunkBytes, chunkBytes, chunkBytesFor(effectiveFrame)),
    window: Math.min(local.window, window),
  };
}

/** Encode one outbound frame; a frame over the negotiated maximum is never sent. */
export function encodeFrame(message: unknown, limits: RemoteFrameLimits): Buffer {
  const bytes = Buffer.from(JSON.stringify(message), "utf8");
  if (bytes.byteLength > limits.maxFrameBytes) {
    throw new RemoteFrameError("frame_too_large", `Frame of ${bytes.byteLength} bytes exceeds ${limits.maxFrameBytes}.`);
  }
  return bytes;
}

export type DecodedFrame =
  | { readonly ok: true; readonly message: Record<string, unknown> }
  | { readonly ok: false; readonly code: "frame_too_large" | "malformed_frame" };

/**
 * Decode one inbound frame. Oversized input is refused by length before it is
 * parsed, and a refusal is a value — the session survives a bad frame.
 */
export function decodeFrame(bytes: Uint8Array, limits: RemoteFrameLimits): DecodedFrame {
  if (bytes.byteLength > limits.maxFrameBytes) return { ok: false, code: "frame_too_large" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return { ok: false, code: "malformed_frame" };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed) || typeof (parsed as Record<string, unknown>).type !== "string") {
    return { ok: false, code: "malformed_frame" };
  }
  return { ok: true, message: parsed as Record<string, unknown> };
}

/** Encoded size of a message, for guards that must not build the frame twice. */
export function frameByteLength(message: unknown): number {
  return Buffer.byteLength(JSON.stringify(message), "utf8");
}
