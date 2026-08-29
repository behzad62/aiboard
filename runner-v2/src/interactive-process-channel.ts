import { createHash } from "node:crypto";

import type { ProcessBackendBinding, ProcessEffectFence } from "./process-backend.js";

export const INTERACTIVE_PROCESS_CHANNEL_VERSION = 1 as const;

/** Closed set of family-facing actions that must carry a current authority token. */
export type InteractiveFamilyAction =
  | "write"
  | "close_input"
  | "request"
  | "stop"
  | "graceful_shutdown"
  | "subscribe"
  | "parse_delivery"
  | "input_control"
  | "protocol_response"
  | "family_delivery";

export type InteractiveProcessChannelErrorCode =
  | "authorization_required"
  | "channel_unavailable"
  | "stale_fence"
  | "write_out_of_order"
  | "write_mismatch"
  | "write_timeout"
  | "write_outcome_unknown"
  | "input_closed"
  | "session_released"
  | "input_unavailable";

export class InteractiveProcessChannelError extends Error {
  constructor(readonly code: InteractiveProcessChannelErrorCode, message: string) {
    super(message);
    this.name = "InteractiveProcessChannelError";
  }
}

export interface InteractiveProcessWrite {
  readonly sequence: number;
  readonly byteLength: number;
  readonly digest: string;
  readonly timeoutMs: number;
}

export interface InteractiveProcessChannel {
  write(input: InteractiveProcessWrite, payload: Uint8Array): Promise<unknown>;
  closeInput(): Promise<unknown>;
  subscribePrivateOutput(sink: (bytes: Uint8Array) => void): () => void;
  gracefulStop(): Promise<unknown>;
  waitForTerminal(): Promise<unknown>;
  detach(): Promise<unknown>;
}

export interface InteractiveProcessReattachResult {
  readonly binding: ProcessBackendBinding;
  readonly channel: InteractiveProcessChannel;
  /** Backend-attested in-memory protocol sequence; it is never guessed from durable state. */
  readonly nextSequence: number;
  readonly inputClosed: boolean;
}

/** Optional backend-private capability. It is never surfaced to a tool family. */
export interface InteractiveProcessChannelProvider {
  readonly version: typeof INTERACTIVE_PROCESS_CHANNEL_VERSION;
  acquire(
    binding: ProcessBackendBinding,
    fence: ProcessEffectFence,
  ): Promise<InteractiveProcessChannel>;
  reattach?(
    binding: ProcessBackendBinding,
    fence: ProcessEffectFence,
  ): Promise<InteractiveProcessReattachResult | undefined>;
}

export interface InteractiveProcessChannelRegistryOptions {
  readonly authorize: (
    authorization: unknown,
    expected: Readonly<{ sessionId: string; operation: InteractiveFamilyAction }>,
  ) => boolean;
  /** Runner-private durable-state bridge; never receives payload bytes. */
  readonly onDisposition?: (
    sessionId: string,
    fence: ProcessEffectFence,
    disposition: "input_unavailable" | "backend_unavailable" | "outcome_unknown",
  ) => void | Promise<void>;
  readonly maxWriteBytes?: number;
  readonly maxWriteTimeoutMs?: number;
  readonly maxPrivateOutputBytes?: number;
}

export interface InteractiveProcessAttachRequest {
  readonly sessionId: string;
  readonly binding: ProcessBackendBinding;
  readonly fence: ProcessEffectFence;
  readonly provider: InteractiveProcessChannelProvider;
}

export interface InteractiveProcessWriteRequest extends InteractiveProcessWrite {
  readonly sessionId: string;
  readonly authorization: unknown;
  readonly fencingToken: number;
  readonly payload: Uint8Array;
}

export interface InteractiveProcessControlRequest {
  readonly sessionId: string;
  readonly authorization: unknown;
  readonly fencingToken: number;
}

export interface InteractiveFamilyActionRequest extends InteractiveProcessControlRequest {
  readonly operation: InteractiveFamilyAction;
}

export interface InteractivePrivateOutputRequest {
  readonly sessionId: string;
  readonly sink: (bytes: Uint8Array) => void;
}

export interface InteractiveFamilyOutputRequest extends InteractiveProcessControlRequest {
  readonly deliver: (bytes: Uint8Array) => void;
}

export interface InteractiveLifecycleRequest {
  readonly sessionId: string;
}

interface AttachedChannel {
  readonly binding: ProcessBackendBinding;
  readonly fence: ProcessEffectFence;
  readonly channel: InteractiveProcessChannel;
  nextSequence: number;
  inputClosed: boolean;
  released: boolean;
  outcomeUnknown: boolean;
}

export interface InteractiveProcessChannelRegistry {
  attach(request: InteractiveProcessAttachRequest): Promise<void>;
  reattach(request: InteractiveProcessAttachRequest): Promise<void>;
  write(request: InteractiveProcessWriteRequest): Promise<void>;
  closeInput(request: InteractiveProcessControlRequest): Promise<boolean>;
  gracefulStop(request: InteractiveProcessControlRequest): Promise<void>;
  /** Runner lifecycle only; removes the live channel from the private registry. */
  release(request: InteractiveLifecycleRequest): Promise<boolean>;
  /** Gate for family request, parse, delivery, and protocol pathways; never returns the backend channel. */
  assertFamilyActionAuthorization(request: InteractiveFamilyActionRequest): void;
  subscribePrivateOutput(request: InteractivePrivateOutputRequest): () => void;
  subscribeFamilyOutput(request: InteractiveFamilyOutputRequest): () => void;
  waitForTerminal(request: InteractiveLifecycleRequest): Promise<unknown>;
}

export function createInteractiveProcessChannelRegistry(
  options: InteractiveProcessChannelRegistryOptions,
): InteractiveProcessChannelRegistry {
  const maxWriteBytes = options.maxWriteBytes ?? 1024 * 1024;
  if (!Number.isSafeInteger(maxWriteBytes) || maxWriteBytes < 1) {
    throw new InteractiveProcessChannelError("write_mismatch", "Interactive channel max write bytes is invalid.");
  }
  const maxWriteTimeoutMs = options.maxWriteTimeoutMs ?? 120_000;
  if (!Number.isSafeInteger(maxWriteTimeoutMs) || maxWriteTimeoutMs < 1) {
    throw new InteractiveProcessChannelError("write_timeout", "Interactive channel max write timeout is invalid.");
  }
  const maxPrivateOutputBytes = options.maxPrivateOutputBytes ?? 128 * 1024;
  if (!Number.isSafeInteger(maxPrivateOutputBytes) || maxPrivateOutputBytes < 1) {
    throw new InteractiveProcessChannelError("channel_unavailable", "Interactive channel private output bound is invalid.");
  }
  const attached = new Map<string, AttachedChannel>();
  return Object.freeze({
    async attach(request: InteractiveProcessAttachRequest): Promise<void> {
      if (request.provider.version !== INTERACTIVE_PROCESS_CHANNEL_VERSION) {
        return await failAttach(options, request.sessionId, request.fence, "Interactive channel provider version is unsupported.");
      }
      let channel: InteractiveProcessChannel;
      try {
        channel = await request.provider.acquire(request.binding, request.fence);
        assertChannel(channel);
      } catch {
        return await failAttach(options, request.sessionId, request.fence, "Interactive channel acquisition could not be proven.");
      }
      attached.set(request.sessionId, {
        binding: request.binding,
        fence: request.fence,
        channel,
        nextSequence: 1,
        inputClosed: false,
        released: false,
        outcomeUnknown: false,
      });
    },
    async reattach(request: InteractiveProcessAttachRequest): Promise<void> {
      if (request.provider.version !== INTERACTIVE_PROCESS_CHANNEL_VERSION || !request.provider.reattach) {
        return await failReattach(options, request.sessionId, request.fence, "Interactive channel reattach is unavailable.");
      }
      let result: InteractiveProcessReattachResult | undefined;
      try {
        result = await request.provider.reattach(request.binding, request.fence);
      } catch {
        return await failReattach(options, request.sessionId, request.fence, "Interactive channel reattach could not be proven.");
      }
      if (!result || !sameBinding(result.binding, request.binding)) {
        return await failReattach(options, request.sessionId, request.fence, "Interactive channel reattach binding is not exact.");
      }
      try {
        assertChannel(result.channel);
      } catch {
        return await failReattach(options, request.sessionId, request.fence, "Interactive channel reattach capability is invalid.");
      }
      if (!Number.isSafeInteger(result.nextSequence) || result.nextSequence < 1 ||
          typeof result.inputClosed !== "boolean") {
        return await failReattach(options, request.sessionId, request.fence, "Interactive channel reattach state is not attested.");
      }
      attached.set(request.sessionId, {
        binding: request.binding,
        fence: request.fence,
        channel: result.channel,
        nextSequence: result.nextSequence,
        inputClosed: result.inputClosed,
        released: false,
        outcomeUnknown: false,
      });
    },
    async write(request: InteractiveProcessWriteRequest): Promise<void> {
      const current = requiredAttachment(attached, request.sessionId);
      assertAuthorization(options, request.authorization, request.sessionId, "write");
      if (current.released) throw new InteractiveProcessChannelError("session_released", "Streaming session has been released.");
      if (current.outcomeUnknown) throw new InteractiveProcessChannelError("write_outcome_unknown", "Prior write acknowledgement is unknown.");
      if (request.fencingToken !== current.fence.fencingToken) {
        throw new InteractiveProcessChannelError("stale_fence", "Interactive channel fence is stale.");
      }
      if (current.inputClosed) throw new InteractiveProcessChannelError("input_closed", "Interactive channel input is closed.");
      if (request.sequence !== current.nextSequence) {
        throw new InteractiveProcessChannelError("write_out_of_order", "Interactive channel write sequence is out of order.");
      }
      if (!Number.isSafeInteger(request.timeoutMs) || request.timeoutMs < 1 || request.timeoutMs > maxWriteTimeoutMs) {
        throw new InteractiveProcessChannelError("write_timeout", "Interactive channel write timeout is invalid.");
      }
      if (request.payload.byteLength !== request.byteLength ||
          request.byteLength > maxWriteBytes ||
          createHash("sha256").update(request.payload).digest("hex") !== request.digest) {
        throw new InteractiveProcessChannelError("write_mismatch", "Interactive channel write metadata does not match the payload.");
      }
      let acknowledgement: unknown;
      try {
        acknowledgement = await awaitAcknowledgement(
          current.channel.write({
            sequence: request.sequence,
            byteLength: request.byteLength,
            digest: request.digest,
            timeoutMs: request.timeoutMs,
          }, request.payload),
          request.timeoutMs,
        );
      } catch {
        current.outcomeUnknown = true;
        await reportDisposition(options, request.sessionId, current.fence, "outcome_unknown");
        throw new InteractiveProcessChannelError("write_outcome_unknown", "Interactive channel write acknowledgement is unknown.");
      }
      if (!isAcknowledged(acknowledgement, request.sequence)) {
        current.outcomeUnknown = true;
        await reportDisposition(options, request.sessionId, current.fence, "outcome_unknown");
        throw new InteractiveProcessChannelError("write_outcome_unknown", "Interactive channel write acknowledgement is unknown.");
      }
      current.nextSequence += 1;
    },
    async closeInput(request: InteractiveProcessControlRequest): Promise<boolean> {
      const current = requiredAttachment(attached, request.sessionId);
      assertAuthorization(options, request.authorization, request.sessionId, "close_input");
      if (current.released) throw new InteractiveProcessChannelError("session_released", "Streaming session has been released.");
      if (request.fencingToken !== current.fence.fencingToken) {
        throw new InteractiveProcessChannelError("stale_fence", "Interactive channel fence is stale.");
      }
      if (current.inputClosed) return false;
      await current.channel.closeInput();
      current.inputClosed = true;
      return true;
    },
    async gracefulStop(request: InteractiveProcessControlRequest): Promise<void> {
      const current = requiredAttachment(attached, request.sessionId);
      assertAuthorization(options, request.authorization, request.sessionId, "graceful_shutdown");
      if (current.released) throw new InteractiveProcessChannelError("session_released", "Streaming session has been released.");
      if (request.fencingToken !== current.fence.fencingToken) {
        throw new InteractiveProcessChannelError("stale_fence", "Interactive channel fence is stale.");
      }
      await current.channel.gracefulStop();
    },
    async release(request: InteractiveLifecycleRequest): Promise<boolean> {
      const current = requiredAttachment(attached, request.sessionId);
      if (current.released) return false;
      current.released = true;
      await current.channel.detach();
      return true;
    },
    assertFamilyActionAuthorization(request: InteractiveFamilyActionRequest): void {
      const current = requiredAttachment(attached, request.sessionId);
      assertAuthorization(options, request.authorization, request.sessionId, request.operation);
      if (current.released) throw new InteractiveProcessChannelError("session_released", "Streaming session has been released.");
      if (request.fencingToken !== current.fence.fencingToken) {
        throw new InteractiveProcessChannelError("stale_fence", "Interactive channel fence is stale.");
      }
    },
    subscribePrivateOutput(request: InteractivePrivateOutputRequest): () => void {
      const current = requiredAttachment(attached, request.sessionId);
      return current.channel.subscribePrivateOutput(boundedOutputSink(request.sink, maxPrivateOutputBytes));
    },
    subscribeFamilyOutput(request: InteractiveFamilyOutputRequest): () => void {
      const current = requiredAttachment(attached, request.sessionId);
      assertAuthorization(options, request.authorization, request.sessionId, "family_delivery");
      if (current.released) throw new InteractiveProcessChannelError("session_released", "Streaming session has been released.");
      if (request.fencingToken !== current.fence.fencingToken) {
        throw new InteractiveProcessChannelError("stale_fence", "Interactive channel fence is stale.");
      }
      return current.channel.subscribePrivateOutput(boundedOutputSink(request.deliver, maxPrivateOutputBytes));
    },
    async waitForTerminal(request: InteractiveLifecycleRequest): Promise<unknown> {
      const current = requiredAttachment(attached, request.sessionId);
      return await current.channel.waitForTerminal();
    },
  });
}

async function reportDisposition(
  options: InteractiveProcessChannelRegistryOptions,
  sessionId: string,
  fence: ProcessEffectFence,
  disposition: "input_unavailable" | "backend_unavailable" | "outcome_unknown",
): Promise<void> {
  try {
    await options.onDisposition?.(sessionId, fence, disposition);
  } catch {
    // The in-memory fence remains fail-closed even if durable reporting itself is unavailable.
  }
}

async function failReattach(
  options: InteractiveProcessChannelRegistryOptions,
  sessionId: string,
  fence: ProcessEffectFence,
  message: string,
): Promise<never> {
  await reportDisposition(options, sessionId, fence, "input_unavailable");
  throw new InteractiveProcessChannelError("input_unavailable", message);
}

async function failAttach(
  options: InteractiveProcessChannelRegistryOptions,
  sessionId: string,
  fence: ProcessEffectFence,
  message: string,
): Promise<never> {
  await reportDisposition(options, sessionId, fence, "backend_unavailable");
  throw new InteractiveProcessChannelError("channel_unavailable", message);
}

async function awaitAcknowledgement<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error("interactive write acknowledgement timed out")), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

function boundedOutputSink(
  sink: (bytes: Uint8Array) => void,
  maximumBytes: number,
): (bytes: Uint8Array) => void {
  let remaining = maximumBytes;
  return (bytes) => {
    if (remaining < 1 || !(bytes instanceof Uint8Array)) return;
    const accepted = Math.min(remaining, bytes.byteLength);
    remaining -= accepted;
    if (accepted > 0) sink(new Uint8Array(bytes.subarray(0, accepted)));
  };
}

function assertChannel(value: unknown): asserts value is InteractiveProcessChannel {
  if (!value || typeof value !== "object" ||
      typeof (value as InteractiveProcessChannel).write !== "function" ||
      typeof (value as InteractiveProcessChannel).closeInput !== "function" ||
      typeof (value as InteractiveProcessChannel).subscribePrivateOutput !== "function" ||
      typeof (value as InteractiveProcessChannel).gracefulStop !== "function" ||
      typeof (value as InteractiveProcessChannel).waitForTerminal !== "function" ||
      typeof (value as InteractiveProcessChannel).detach !== "function") {
    throw new InteractiveProcessChannelError("channel_unavailable", "Interactive channel provider returned an invalid channel.");
  }
}

function requiredAttachment(
  attached: ReadonlyMap<string, AttachedChannel>,
  sessionId: string,
): AttachedChannel {
  const current = attached.get(sessionId);
  if (!current) throw new InteractiveProcessChannelError("channel_unavailable", "Interactive channel is unavailable.");
  return current;
}

function assertAuthorization(
  options: InteractiveProcessChannelRegistryOptions,
  authorization: unknown,
  sessionId: string,
  operation: InteractiveFamilyAction,
): void {
  if (!options.authorize(authorization, { sessionId, operation })) {
    throw new InteractiveProcessChannelError("authorization_required", "A current session operation authorization is required.");
  }
}

function isAcknowledged(value: unknown, sequence: number): boolean {
  return !!value && typeof value === "object" &&
    (value as Record<string, unknown>).acknowledged === true &&
    (value as Record<string, unknown>).sequence === sequence;
}

function sameBinding(left: ProcessBackendBinding, right: ProcessBackendBinding): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonicalJson).join(",") + "]";
  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, nested]) => JSON.stringify(key) + ":" + canonicalJson(nested));
  return "{" + entries.join(",") + "}";
}
