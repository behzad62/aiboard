import { createHash } from "node:crypto";

import type { ProcessBackendBinding, ProcessEffectFence } from "./process-backend.js";
import type {
  OperationAuthorizationAssertion,
  SessionOperationAuthorization,
} from "./session-authority.js";

export const INTERACTIVE_PROCESS_CHANNEL_VERSION = 1 as const;
export const BACKPRESSURED_INTERACTIVE_PROCESS_CHANNEL_VERSION = 2 as const;

/** Additive v2 capability. V1 remains valid for terminal/non-streaming callers. */
export interface BackpressuredOutputMetadata {
  readonly stream: "stdout" | "stderr";
  readonly sequence: number;
  readonly startOffset: number;
  readonly endOffset: number;
  readonly byteLength: number;
  readonly digest: string;
}
export type BackpressuredOutputAcknowledgement = BackpressuredOutputMetadata;
export interface BackpressuredInteractiveProcessChannelProvider {
  readonly version: typeof BACKPRESSURED_INTERACTIVE_PROCESS_CHANNEL_VERSION;
  readonly replayCapacityChunks: number;
  readonly replayCapacityBytes: number;
  acquire(binding: ProcessBackendBinding, fence: ProcessEffectFence): Promise<InteractiveProcessChannel & Readonly<{
    subscribeBackpressuredOutput(
      sink: (metadata: BackpressuredOutputMetadata, ownedBytes: Uint8Array) => Promise<BackpressuredOutputAcknowledgement>,
    ): () => void;
  }>>;
  reattach?(binding: ProcessBackendBinding, fence: ProcessEffectFence): Promise<InteractiveProcessReattachResult>;
}

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
    authorization: SessionOperationAuthorization,
    expected: OperationAuthorizationAssertion,
  ) => void | boolean;
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
  readonly authorization: SessionOperationAuthorization;
  readonly authorizationAssertion: OperationAuthorizationAssertion;
  readonly fencingToken: number;
  readonly payload: Uint8Array;
}

export interface InteractiveProcessControlRequest {
  readonly sessionId: string;
  readonly authorization: SessionOperationAuthorization;
  readonly authorizationAssertion: OperationAuthorizationAssertion;
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
  /**
   * Every write reserves its sequence before awaiting the backend.  Keeping a
   * settled tail also lets a later request observe an earlier unknown outcome
   * instead of racing it.
   */
  writeTail: Promise<void>;
  inputClosed: boolean;
  released: boolean;
  outcomeUnknown: boolean;
}

interface PreparedInteractiveProcessWrite {
  readonly sessionId: string;
  readonly authorization: SessionOperationAuthorization;
  readonly authorizationAssertion: OperationAuthorizationAssertion;
  readonly fencingToken: number;
  readonly sequence: number;
  readonly byteLength: number;
  readonly digest: string;
  readonly timeoutMs: number;
  /** An owned snapshot, never the caller's mutable buffer. */
  readonly payload: Uint8Array;
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
  const attachmentTails = new Map<string, Promise<void>>();
  return Object.freeze({
    async attach(request: InteractiveProcessAttachRequest): Promise<void> {
      const binding = cloneBinding(request.binding);
      const fence = cloneFence(request.fence);
      return await enqueueAttachmentChange(attachmentTails, request.sessionId, async () => {
        if (request.provider.version !== INTERACTIVE_PROCESS_CHANNEL_VERSION) {
          return await failAttach(options, request.sessionId, fence, "Interactive channel provider version is unsupported.");
        }
        let channel: InteractiveProcessChannel;
        try {
          channel = await request.provider.acquire(binding, fence);
          assertChannel(channel);
        } catch {
          return await failAttach(options, request.sessionId, fence, "Interactive channel acquisition could not be proven.");
        }
        await installAttachment(options, attached, request.sessionId, {
          binding,
          fence,
          channel,
          nextSequence: 1,
          writeTail: Promise.resolve(),
          inputClosed: false,
          released: false,
          outcomeUnknown: false,
        }, "attach");
      });
    },
    async reattach(request: InteractiveProcessAttachRequest): Promise<void> {
      const binding = cloneBinding(request.binding);
      const fence = cloneFence(request.fence);
      return await enqueueAttachmentChange(attachmentTails, request.sessionId, async () => {
        if (request.provider.version !== INTERACTIVE_PROCESS_CHANNEL_VERSION || !request.provider.reattach) {
          return await failReattach(options, request.sessionId, fence, "Interactive channel reattach is unavailable.");
        }
        let result: InteractiveProcessReattachResult | undefined;
        try {
          result = await request.provider.reattach(binding, fence);
        } catch {
          return await failReattach(options, request.sessionId, fence, "Interactive channel reattach could not be proven.");
        }
        if (!result || !sameBinding(result.binding, binding)) {
          await discardReturnedChannel(options, request.sessionId, fence, result?.channel);
          return await failReattach(options, request.sessionId, fence, "Interactive channel reattach binding is not exact.");
        }
        try {
          assertChannel(result.channel);
        } catch {
          return await failReattach(options, request.sessionId, fence, "Interactive channel reattach capability is invalid.");
        }
        if (!Number.isSafeInteger(result.nextSequence) || result.nextSequence < 1 ||
            typeof result.inputClosed !== "boolean") {
          await discardReturnedChannel(options, request.sessionId, fence, result.channel);
          return await failReattach(options, request.sessionId, fence, "Interactive channel reattach state is not attested.");
        }
        await installAttachment(options, attached, request.sessionId, {
          binding,
          fence,
          channel: result.channel,
          nextSequence: result.nextSequence,
          writeTail: Promise.resolve(),
          inputClosed: result.inputClosed,
          released: false,
          outcomeUnknown: false,
        }, "reattach");
      });
    },
    async write(request: InteractiveProcessWriteRequest): Promise<void> {
      const current = requiredAttachment(attached, request.sessionId);
      const prepared = copyWriteRequest(request);
      return await enqueueWrite(current, async () => {
        assertCurrentAttachment(attached, prepared.sessionId, current);
        assertAuthorization(
          options,
          prepared.authorization,
          prepared.authorizationAssertion,
          prepared.sessionId,
          "write",
        );
        if (current.released) throw new InteractiveProcessChannelError("session_released", "Streaming session has been released.");
        if (current.outcomeUnknown) throw new InteractiveProcessChannelError("write_outcome_unknown", "Prior write acknowledgement is unknown.");
        if (prepared.fencingToken !== current.fence.fencingToken) {
          throw new InteractiveProcessChannelError("stale_fence", "Interactive channel fence is stale.");
        }
        if (current.inputClosed) throw new InteractiveProcessChannelError("input_closed", "Interactive channel input is closed.");
        if (prepared.sequence !== current.nextSequence) {
          throw new InteractiveProcessChannelError("write_out_of_order", "Interactive channel write sequence is out of order.");
        }
        if (!Number.isSafeInteger(prepared.timeoutMs) || prepared.timeoutMs < 1 || prepared.timeoutMs > maxWriteTimeoutMs) {
          throw new InteractiveProcessChannelError("write_timeout", "Interactive channel write timeout is invalid.");
        }
        if (prepared.payload.byteLength !== prepared.byteLength ||
            prepared.byteLength > maxWriteBytes ||
            createHash("sha256").update(prepared.payload).digest("hex") !== prepared.digest) {
          throw new InteractiveProcessChannelError("write_mismatch", "Interactive channel write metadata does not match the payload.");
        }
        // Reserve before the await: even a timeout or rejected acknowledgement
        // cannot permit a second call to reuse this backend sequence.
        current.nextSequence += 1;
        let acknowledgement: unknown;
        try {
          acknowledgement = await awaitAcknowledgement(
            current.channel.write({
              sequence: prepared.sequence,
              byteLength: prepared.byteLength,
              digest: prepared.digest,
              timeoutMs: prepared.timeoutMs,
            }, prepared.payload),
            prepared.timeoutMs,
          );
        } catch {
          current.outcomeUnknown = true;
          await reportDisposition(options, prepared.sessionId, current.fence, "outcome_unknown");
          throw new InteractiveProcessChannelError("write_outcome_unknown", "Interactive channel write acknowledgement is unknown.");
        }
        if (!isAcknowledged(acknowledgement, prepared.sequence)) {
          current.outcomeUnknown = true;
          await reportDisposition(options, prepared.sessionId, current.fence, "outcome_unknown");
          throw new InteractiveProcessChannelError("write_outcome_unknown", "Interactive channel write acknowledgement is unknown.");
        }
      });
    },
    async closeInput(request: InteractiveProcessControlRequest): Promise<boolean> {
      const current = requiredAttachment(attached, request.sessionId);
      assertAuthorization(options, request.authorization, request.authorizationAssertion, request.sessionId, "close_input");
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
      assertAuthorization(options, request.authorization, request.authorizationAssertion, request.sessionId, "graceful_shutdown");
      if (current.released) throw new InteractiveProcessChannelError("session_released", "Streaming session has been released.");
      if (request.fencingToken !== current.fence.fencingToken) {
        throw new InteractiveProcessChannelError("stale_fence", "Interactive channel fence is stale.");
      }
      await current.channel.gracefulStop();
    },
    async release(request: InteractiveLifecycleRequest): Promise<boolean> {
      return await enqueueAttachmentChange(attachmentTails, request.sessionId, async () => {
        const current = requiredAttachment(attached, request.sessionId);
        if (current.released) return false;
        current.released = true;
        await current.channel.detach();
        return true;
      });
    },
    assertFamilyActionAuthorization(request: InteractiveFamilyActionRequest): void {
      const current = requiredAttachment(attached, request.sessionId);
      assertAuthorization(options, request.authorization, request.authorizationAssertion, request.sessionId, request.operation);
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
      assertCurrentFamilyDelivery(attached, options, current, request);
      const deliver = boundedOutputSink(request.deliver, maxPrivateOutputBytes);
      let stopped = false;
      let unsubscribe: () => void = () => undefined;
      unsubscribe = current.channel.subscribePrivateOutput((bytes) => {
        if (stopped) return;
        try {
          assertCurrentFamilyDelivery(attached, options, current, request);
          deliver(bytes);
        } catch {
          stopped = true;
          unsubscribe();
        }
      });
      return () => {
        stopped = true;
        unsubscribe();
      };
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

function assertCurrentAttachment(
  attached: ReadonlyMap<string, AttachedChannel>,
  sessionId: string,
  current: AttachedChannel,
): void {
  if (attached.get(sessionId) !== current) {
    throw new InteractiveProcessChannelError("channel_unavailable", "Interactive channel attachment is no longer current.");
  }
}

function copyWriteRequest(request: InteractiveProcessWriteRequest): PreparedInteractiveProcessWrite {
  if (!(request.payload instanceof Uint8Array)) {
    throw new InteractiveProcessChannelError("write_mismatch", "Interactive channel payload is invalid.");
  }
  return {
    sessionId: request.sessionId,
    authorization: request.authorization,
    authorizationAssertion: request.authorizationAssertion,
    fencingToken: request.fencingToken,
    sequence: request.sequence,
    byteLength: request.byteLength,
    digest: request.digest,
    timeoutMs: request.timeoutMs,
    payload: new Uint8Array(request.payload),
  };
}

function enqueueWrite(current: AttachedChannel, operation: () => Promise<void>): Promise<void> {
  const task = current.writeTail.catch(() => undefined).then(operation);
  // Keep the tail settled so a terminal failure is reported to its caller but
  // never prevents a later request from making its own fail-closed decision.
  current.writeTail = task.catch(() => undefined);
  return task;
}

function enqueueAttachmentChange<T>(
  attachmentTails: Map<string, Promise<void>>,
  sessionId: string,
  operation: () => Promise<T>,
): Promise<T> {
  const predecessor = attachmentTails.get(sessionId) ?? Promise.resolve();
  const task = predecessor.catch(() => undefined).then(operation);
  const settled = task.then(() => undefined, () => undefined);
  attachmentTails.set(sessionId, settled);
  void settled.then(() => {
    if (attachmentTails.get(sessionId) === settled) attachmentTails.delete(sessionId);
  });
  return task;
}

async function installAttachment(
  options: InteractiveProcessChannelRegistryOptions,
  attached: Map<string, AttachedChannel>,
  sessionId: string,
  candidate: AttachedChannel,
  mode: "attach" | "reattach",
): Promise<void> {
  try {
    const current = attached.get(sessionId);
    if (current) {
      if (current.released) {
        throw new InteractiveProcessChannelError("session_released", "Streaming session has been released.");
      }
      if (!isStrictlyNewerFence(candidate.fence, current.fence)) {
        throw new InteractiveProcessChannelError("stale_fence", "Interactive channel fence is stale.");
      }
      // Stop all old output subscriptions before changing the map.  If the
      // old capability cannot be detached, keep the session fail-closed.
      current.released = true;
      try {
        await current.channel.detach();
      } catch {
        throw new InteractiveProcessChannelError("channel_unavailable", "Current interactive channel could not be detached.");
      }
    }
    attached.set(sessionId, candidate);
  } catch (error) {
    await discardReturnedChannel(options, sessionId, candidate.fence, candidate.channel);
    if (error instanceof InteractiveProcessChannelError && error.code === "channel_unavailable") {
      if (mode === "attach") {
        return await failAttach(options, sessionId, candidate.fence, "Interactive channel replacement could not be proven.");
      }
      return await failReattach(options, sessionId, candidate.fence, "Interactive channel replacement could not be proven.");
    }
    throw error;
  }
}

async function discardReturnedChannel(
  options: InteractiveProcessChannelRegistryOptions,
  sessionId: string,
  fence: ProcessEffectFence,
  channel: InteractiveProcessChannel | undefined,
): Promise<void> {
  if (!channel) return;
  try {
    await channel.detach();
  } catch {
    await reportDisposition(options, sessionId, fence, "backend_unavailable");
    throw new InteractiveProcessChannelError("channel_unavailable", "A rejected interactive channel could not be detached.");
  }
}

function cloneBinding(binding: ProcessBackendBinding): ProcessBackendBinding {
  return Object.freeze({
    registryId: binding.registryId,
    backendId: binding.backendId,
    implementationGeneration: binding.implementationGeneration,
    implementationDigest: binding.implementationDigest,
    attestationVersion: binding.attestationVersion,
    attestationDigest: binding.attestationDigest,
    opaqueIdentity: binding.opaqueIdentity,
    birthFingerprint: Object.freeze({
      observedAt: binding.birthFingerprint.observedAt,
      discriminator: binding.birthFingerprint.discriminator,
    }),
    ...(binding.rootPid === undefined ? {} : { rootPid: binding.rootPid }),
    startedAt: binding.startedAt,
  });
}

function cloneFence(fence: ProcessEffectFence): ProcessEffectFence {
  return Object.freeze({ ownerId: fence.ownerId, fencingToken: fence.fencingToken });
}

function isStrictlyNewerFence(candidate: ProcessEffectFence, current: ProcessEffectFence): boolean {
  return Number.isSafeInteger(candidate.fencingToken) && candidate.fencingToken > current.fencingToken;
}

function assertAuthorization(
  options: InteractiveProcessChannelRegistryOptions,
  authorization: SessionOperationAuthorization,
  assertion: OperationAuthorizationAssertion,
  sessionId: string,
  operation: InteractiveFamilyAction,
): void {
  if (!assertion || assertion.sessionId !== sessionId || assertion.operation !== operation) {
    throw new InteractiveProcessChannelError("authorization_required", "A current session operation authorization is required.");
  }
  try {
    if (options.authorize(authorization, assertion) === false) {
      throw new Error("interactive authorization rejected");
    }
  } catch {
    throw new InteractiveProcessChannelError("authorization_required", "A current session operation authorization is required.");
  }
}

function assertCurrentFamilyDelivery(
  attached: ReadonlyMap<string, AttachedChannel>,
  options: InteractiveProcessChannelRegistryOptions,
  current: AttachedChannel,
  request: InteractiveFamilyOutputRequest,
): void {
  if (attached.get(request.sessionId) !== current || current.released) {
    throw new InteractiveProcessChannelError("session_released", "Streaming session has been released.");
  }
  if (request.fencingToken !== current.fence.fencingToken) {
    throw new InteractiveProcessChannelError("stale_fence", "Interactive channel fence is stale.");
  }
  assertAuthorization(
    options,
    request.authorization,
    request.authorizationAssertion,
    request.sessionId,
    "family_delivery",
  );
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
