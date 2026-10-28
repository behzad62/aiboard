import { randomUUID } from "node:crypto";

import type { ToolResult } from "./agent-contracts.js";
import { RemoteAdmissionError, parseRemoteRequest, remotePayloadDigest, type RemoteAdmissionStore, type RemoteJob, type RemoteRequest } from "./remote-admission-store.js";
import { RemoteAuthError, type RelayChallenge, type RemoteAuthorization, type RemoteAuthenticator } from "./remote-auth.js";
import type { RemoteDeviceSession, RemoteDeviceStore } from "./remote-device-store.js";
import type { VerifiedRemoteIdentity } from "./remote-principal.js";
import type { RemoteInvocationResult } from "./remote-tool-runtime.js";

export type RemoteConnectionStateName =
  | "disconnected" | "authenticating" | "connected-degraded" | "tool-ready" | "suspended" | "revoked";
export type RemoteConnectionReason =
  | "initial" | "connecting" | "reconnecting" | "socket_lost" | "authentication_failed" | "reprovisioned"
  | "reconciliation_pending" | "required_tool_unavailable" | "optional_tool_unavailable" | "recovery_unverified"
  | "ready" | "local_pause" | "owner_lock_lost" | "device_policy_expired" | "entitlement_expired"
  | "recovery_unresolved" | "device_clone_detected" | "device_key_revoked";

/** Shape of connection-state.v1 (pinned contract data, redeclared locally). */
export interface RemoteConnectionState {
  readonly protocolVersion: string;
  readonly deviceId: string;
  readonly state: RemoteConnectionStateName;
  readonly reasonCode: RemoteConnectionReason;
  readonly changedAt: string;
  readonly deviceEpoch?: string;
}

export interface RemoteResponseMessage {
  readonly requestId: string;
  readonly traceId: string;
  readonly admitted: boolean;
  readonly status: string;
  readonly jobId?: string;
  readonly errorCode?: string;
  readonly uncertainty?: string;
}

/** Injected duplex framing. The real WebSocket/TLS transport lands in R1e. */
export type RemoteTransportMessage =
  | { readonly type: "challenge"; readonly challenge: RelayChallenge }
  | { readonly type: "proof"; readonly deviceId: string; readonly publicKey: string; readonly signature: string }
  | { readonly type: "authenticated"; readonly epoch: string }
  | { readonly type: "auth_error"; readonly code: string }
  | { readonly type: "request"; readonly request: RemoteRequest; readonly authorization?: RemoteAuthorization }
  | { readonly type: "response"; readonly response: RemoteResponseMessage; readonly data?: unknown }
  | { readonly type: "heartbeat"; readonly at: string }
  | { readonly type: "revoked" };

export interface RemoteTransport {
  connect(): Promise<void>;
  close(): Promise<void>;
  send(message: RemoteTransportMessage): Promise<void> | void;
  onMessage(handler: (message: RemoteTransportMessage) => void | Promise<void>): void;
  onClose(handler: () => void): void;
}

/** The slice of RemoteToolRuntime the connector may use. Never an authority. */
export interface RemoteRequestRuntime {
  invoke(identity: VerifiedRemoteIdentity, name: string, args: unknown, signal?: AbortSignal, rawRequest?: string): Promise<ToolResult>;
  invokeAdmitted?(identity: VerifiedRemoteIdentity, name: string, args: unknown, signal: AbortSignal, rawRequest: string, jobId: string, beforeBroker?: () => boolean): Promise<RemoteInvocationResult>;
  authorizeJob?(identity: VerifiedRemoteIdentity, name?: string, args?: unknown): string | undefined;
  stopStartedProcess?(identity: VerifiedRemoteIdentity, processId: string): Promise<boolean>;
}

/** One admitted extension tool as offered to the relay (plan P2 naming). */
export interface RemotePluginToolInfo {
  readonly relayToolId: string;
  readonly required: boolean;
  readonly available: boolean;
}

/**
 * Extension tools admitted for remote use (R1c `remoteAdmittedTools` for the
 * current generation and policy). The connector routes only listed relay ids;
 * an unavailable listed tool degrades the connection, never fakes readiness.
 */
export interface RemotePluginToolProvider {
  list(): Promise<readonly RemotePluginToolInfo[]>;
  invoke(identity: VerifiedRemoteIdentity, relayToolId: string, args: unknown, signal?: AbortSignal, beforeBroker?: () => boolean): Promise<ToolResult>;
  invokeAdmitted?(identity: VerifiedRemoteIdentity, relayToolId: string, args: unknown, signal: AbortSignal, beforeBroker?: () => boolean): Promise<RemoteInvocationResult>;
  close?(): Promise<void>;
}

/** Relay tool ids (remote-tool-surface.md) mapped to Runner broker names. */
export const REMOTE_TOOL_ID_TO_RUNNER: Readonly<Record<string, string>> = Object.freeze({
  files_read: "fs.read",
  files_list: "fs.list",
  files_search: "fs.search",
  files_write: "fs.write",
  files_patch: "fs.patch",
  files_move: "fs.move",
  files_delete: "fs.delete",
  process_start: "process.start",
  process_run: "process.run",
  process_read_output: "process.read_output",
  process_list: "process.list",
  process_write_stdin: "process.write_stdin",
  process_signal: "process.signal",
  git_status: "git.status",
  git_diff: "git.diff",
  git_log: "git.log",
  image_inspect: "image.inspect",
});

const JOB_TOOL_IDS: ReadonlySet<string> = new Set(["jobs_status", "jobs_events", "jobs_result", "jobs_cancel"]);
const EFFECT_TOOL_IDS: ReadonlySet<string> = new Set(["files_write", "files_patch", "files_move", "files_delete",
  "process_start", "process_run", "process_write_stdin", "process_signal"]);

export interface RemoteConnectorOptions {
  readonly deviceStore: RemoteDeviceStore;
  readonly authenticator: RemoteAuthenticator;
  readonly admission: RemoteAdmissionStore;
  readonly runtime: RemoteRequestRuntime;
  readonly session: RemoteDeviceSession;
  readonly createTransport: () => RemoteTransport;
  /** Startup reconciliation gate (reconcileRunnerStartup + admission). */
  readonly reconcile: () => Promise<void>;
  readonly now?: () => Date;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly random?: () => number;
  readonly handshakeTimeoutMs?: number;
  readonly drainTimeoutMs?: number;
  /** Maximum live dispatches per device; defaults to 8. */
  readonly maxConcurrentJobsPerDevice?: number;
  /** Maximum waiting admissions per device; defaults to 64. */
  readonly maxQueuedJobsPerDevice?: number;
  /** Deadline measured from admission, capped by request expiry; defaults to five minutes. */
  readonly toolDeadlineMs?: number;
  /** Time to await stop evidence after cancellation; defaults to five seconds. */
  readonly cancellationGraceMs?: number;
  readonly reconnect?: { readonly baseDelayMs: number; readonly maxDelayMs: number; readonly maxAttempts: number };
  readonly isOwnerLockHeld?: () => boolean;
  readonly onStateChange?: (state: RemoteConnectionState) => void;
  readonly onShutdownStep?: (step: string) => void;
  /** Admitted extension tools for the current generation/policy (R1c), when composed. */
  readonly pluginTools?: RemotePluginToolProvider;
}

interface InFlight {
  readonly identity: VerifiedRemoteIdentity;
  readonly jobId: string;
  rawRequest: string;
  request: RemoteRequest;
  authorization: RemoteAuthorization;
  readonly runnerName: string;
  readonly isPlugin: boolean;
  readonly controller: AbortController;
  deadline: number;
  readonly done: Promise<RemoteResponseMessage>;
  readonly resolve: (response: RemoteResponseMessage) => void;
  started: boolean;
  settled: boolean;
  physicalDone?: Promise<void>;
}
const PROTOCOL_VERSION = "1.0.0";

/**
 * One outbound device connection inside Runner ownership. It verifies relay
 * claims, admits through R1b, dispatches through R1a, and is never itself an
 * execution authority. A heartbeat alone never grants readiness.
 */
export class RemoteConnector {
  private readonly now: () => Date;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly random: () => number;
  private transport: RemoteTransport | undefined;
  private current: RemoteConnectionState;
  private admitting = false;
  private closing = false;
  private closed = false;
  private readonly completedSteps = new Set<string>();
  private readonly inFlight = new Set<InFlight>();
  private readonly queue: InFlight[] = [];
  private readonly processStops = new Map<string, { identity: VerifiedRemoteIdentity; promise: Promise<void> }>();
  private lastClientId: string | undefined;
  private startupReconciled = false;
  private challengeWaiter: { resolve: (challenge: RelayChallenge) => void; reject: (error: Error) => void } | undefined;
  private authWaiter: { resolve: () => void; reject: (error: Error) => void } | undefined;
  private earlyChallenge: RelayChallenge | undefined;
  private earlyAuth: boolean | undefined;
  private reconnectTimer: Promise<void> | undefined;
  private reconnectAttempts = 0;
  private established = false;
  private lastHeartbeatAt: string | undefined;
  private pluginDegradedReason: "optional_tool_unavailable" | "required_tool_unavailable" | undefined;

  constructor(private readonly options: RemoteConnectorOptions) {
    this.now = options.now ?? (() => new Date());
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.random = options.random ?? Math.random;
    for (const [value, minimum] of [[options.maxConcurrentJobsPerDevice ?? 8, 1],
      [options.maxQueuedJobsPerDevice ?? 64, 0], [options.toolDeadlineMs ?? 300_000, 1],
      [options.cancellationGraceMs ?? 5_000, 1]] as const) {
      if (!Number.isSafeInteger(value) || value < minimum) throw new Error("Invalid remote job limits.");
    }
    const identity = options.deviceStore.load();
    this.current = Object.freeze({
      protocolVersion: PROTOCOL_VERSION,
      deviceId: identity?.deviceId ?? "device-unprovisioned",
      state: identity?.revoked ? "revoked" : "disconnected",
      reasonCode: identity?.revoked ? "device_key_revoked" : "initial",
      changedAt: this.now().toISOString(),
      ...(identity ? { deviceEpoch: identity.epoch } : {}),
    });
  }

  state(): RemoteConnectionState {
    return this.current;
  }

  /** Healthy admitted tools may be called in plugin-degraded state; nothing else may. */
  pluginDegraded(): boolean {
    return this.pluginDegradedReason !== undefined;
  }

  isReady(): boolean {
    if (!this.admitting) return false;
    if (this.current.state === "tool-ready") return true;
    // Plugin degradation admits only individually healthy tools (ADR-A).
    return this.current.state === "connected-degraded" && this.pluginDegradedReason !== undefined;
  }

  heartbeatObservedAt(): string | undefined {
    return this.lastHeartbeatAt;
  }

  async start(): Promise<void> {
    if (this.closed || this.closing) return;
    if (this.options.deviceStore.isRevoked()) {
      this.transition("revoked", "device_key_revoked");
      return;
    }
    this.reconnectAttempts = 0;
    await this.connectOnce("connecting");
  }

  /** Owner-lock loss or unverified cleanup: stop admitting, fail closed. */
  suspend(reason: "owner_lock_lost" | "recovery_unresolved"): void {
    this.admitting = false;
    if (this.current.state !== "revoked") this.transition("suspended", reason);
  }

  resumeAfterSuspension(): void {
    if (this.current.state === "suspended") this.transition("disconnected", "socket_lost");
  }

  /** Ordered, retryable shutdown: admission, in-flight settle, transport. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closing = true;
    if (!this.completedSteps.has("admission-stopped")) {
      this.admitting = false;
      this.completedSteps.add("admission-stopped");
      this.options.onShutdownStep?.("admission-stopped");
    }
    if (!this.completedSteps.has("inflight-settled")) {
      for (const entry of [...this.inFlight]) {
        if (entry.settled) continue;
        this.options.admission.requestCancel(entry.identity, entry.jobId, "shutdown-" + randomUUID(), entry.request.traceId);
        this.cancelEntry(entry);
      }
      const drainMs = this.options.drainTimeoutMs ?? 5_000;
      const all = Promise.allSettled([
        ...[...this.inFlight].map((entry) => entry.physicalDone ?? entry.done),
        ...[...this.processStops.values()].map((entry) => entry.promise),
      ]);
      await Promise.race([all, this.sleep(drainMs)]);
      for (const entry of [...this.inFlight]) {
        if (entry.settled) continue;
        const job = this.options.admission.getJob(entry.identity, entry.jobId);
        if (job?.state === "running") {
          this.options.admission.recordStop(entry.identity, entry.jobId, "unverified");
          this.finish(entry, this.options.admission.settleCancelled(entry.identity, entry.jobId, "effect_outcome_unknown"));
        } else if (job) this.finish(entry, job);
      }
      for (const [jobId, entry] of this.processStops) {
        try { this.options.admission.recordStop(entry.identity, jobId, "unverified"); } catch { /* Retain unresolved evidence. */ }
      }
      this.completedSteps.add("inflight-settled");
      this.options.onShutdownStep?.("inflight-settled");
    }
    if (!this.completedSteps.has("transport-closed")) {
      const transport = this.transport;
      this.transport = undefined;
      if (transport) await transport.close();
      await this.options.pluginTools?.close?.();
      this.completedSteps.add("transport-closed");
      this.options.onShutdownStep?.("transport-closed");
    }
    if ([...this.inFlight].some((entry) => entry.started) || this.processStops.size > 0) {
      throw new Error("Remote dispatch cleanup remains unverified.");
    }
    this.closed = true;
    this.closing = false;
    if (this.current.state !== "revoked") this.transition("disconnected", "socket_lost");
  }

  private async connectOnce(reason: "connecting" | "reconnecting"): Promise<void> {
    const deviceStore = this.options.deviceStore;
    if (deviceStore.isRevoked()) {
      this.transition("revoked", "device_key_revoked");
      return;
    }
    if (this.options.isOwnerLockHeld && !this.options.isOwnerLockHeld()) {
      this.suspend("owner_lock_lost");
      return;
    }
    this.transition("authenticating", reason);
    const transport = this.options.createTransport();
    this.transport = transport;
    transport.onMessage((message) => this.onMessage(message));
    transport.onClose(() => { if (this.transport === transport) this.onTransportClose(); });
    try {
      await transport.connect();
      const challenge = await this.waitForChallenge();
      const proof = this.options.authenticator.answerChallenge(challenge, this.options.session);
      await transport.send({ type: "proof", deviceId: proof.deviceId, publicKey: proof.publicKey, signature: proof.signature });
      await this.waitForAuthenticated();
    } catch {
      this.admitting = false;
      if (!deviceStore.isRevoked() && this.current.state !== "suspended") {
        this.transition("disconnected", "authentication_failed");
      }
      if (this.transport === transport) this.transport = undefined;
      try { await transport.close(); } catch { /* the next start retries cleanly */ }
      return;
    }
    const identity = deviceStore.load()!;
    this.options.admission.registerAuthenticatedEpoch(
      { accountId: this.options.session.accountId, deviceId: identity.deviceId }, identity.epoch);
    this.transition("connected-degraded", "reconciliation_pending");
    try {
      if (!this.startupReconciled) {
        await this.options.reconcile();
        this.startupReconciled = true;
      }
    } catch {
      this.admitting = false;
      this.transition("connected-degraded", "recovery_unverified");
      return;
    }
    if (this.closing || this.closed) return;
    if (deviceStore.isRevoked()) {
      this.transition("revoked", "device_key_revoked");
      return;
    }
    if (this.options.isOwnerLockHeld && !this.options.isOwnerLockHeld()) {
      this.suspend("owner_lock_lost");
      return;
    }
    this.admitting = true;
    await this.refreshPluginState();
    this.established = true;
    this.reconnectAttempts = 0;
    // refreshPluginState above already transitioned to tool-ready or plugin-degraded.
  }

  /** Recompute plugin degradation from the admitted set; healthy again returns to tool-ready. */
  async refreshPluginState(): Promise<void> {
    const provider = this.options.pluginTools;
    if (!provider) {
      this.pluginDegradedReason = undefined;
      if (this.admitting) this.transition("tool-ready", "ready");
      return;
    }
    let tools: readonly RemotePluginToolInfo[];
    try { tools = await provider.list(); } catch { this.pluginDegradedReason = "optional_tool_unavailable"; if (!this.closing && !this.closed) this.transition("connected-degraded", this.pluginDegradedReason); return; }
    const unavailable = tools.filter((tool) => !tool.available);
    if (unavailable.length === 0) {
      const wasDegraded = this.pluginDegradedReason !== undefined;
      this.pluginDegradedReason = undefined;
      if (this.admitting && (wasDegraded || this.current.state !== "tool-ready")) this.transition("tool-ready", "ready");
      return;
    }
    this.pluginDegradedReason = unavailable.some((tool) => tool.required) ? "required_tool_unavailable" : "optional_tool_unavailable";
    if (!this.closing && !this.closed) this.transition("connected-degraded", this.pluginDegradedReason);
  }

  private waitForChallenge(): Promise<RelayChallenge> {
    if (this.earlyChallenge) {
      const challenge = this.earlyChallenge;
      this.earlyChallenge = undefined;
      return Promise.resolve(challenge);
    }
    const timeout = this.options.handshakeTimeoutMs ?? 10_000;
    return Promise.race([
      new Promise<RelayChallenge>((resolve, reject) => { this.challengeWaiter = { resolve, reject }; }),
      this.sleep(timeout).then(() => { throw new Error("Remote handshake timed out."); }),
    ]);
  }

  private waitForAuthenticated(): Promise<void> {
    if (this.earlyAuth !== undefined) {
      const ok = this.earlyAuth;
      this.earlyAuth = undefined;
      return ok ? Promise.resolve() : Promise.reject(new Error("Remote authentication was refused."));
    }
    const timeout = this.options.handshakeTimeoutMs ?? 10_000;
    return Promise.race([
      new Promise<void>((resolve, reject) => { this.authWaiter = { resolve, reject }; }),
      this.sleep(timeout).then(() => { throw new Error("Remote authentication timed out."); }),
    ]);
  }

  private async onMessage(message: RemoteTransportMessage): Promise<void> {
    switch (message.type) {
      case "challenge":
        if (this.challengeWaiter) {
          this.challengeWaiter.resolve(message.challenge);
          this.challengeWaiter = undefined;
        } else {
          this.earlyChallenge = message.challenge;
        }
        return;
      case "authenticated":
        if (this.authWaiter) {
          this.authWaiter.resolve();
          this.authWaiter = undefined;
        } else {
          this.earlyAuth = true;
        }
        return;
      case "auth_error":
        if (this.authWaiter) {
          this.authWaiter.reject(new Error("Remote authentication was refused."));
          this.authWaiter = undefined;
        } else {
          this.earlyAuth = false;
        }
        return;
      case "heartbeat":
        // Liveness only. Readiness requires handshake + reconciliation.
        this.lastHeartbeatAt = message.at;
        if (this.options.isOwnerLockHeld && !this.options.isOwnerLockHeld() && this.admitting) {
          this.suspend("owner_lock_lost");
        }
        return;
      case "revoked":
        this.admitting = false;
        this.transition("revoked", "device_key_revoked");
        this.cancelForRevocation();
        return;
      case "request": {
        // Strict codec at the trust boundary, before any authentication logic reads the fields.
        let request: RemoteRequest;
        try { request = parseRemoteRequest(JSON.stringify(message.request)); }
        catch {
          try { await this.transport?.send({ type: "response", response: malformed(message.request) }); } catch { /* socket loss is fenced by epoch */ }
          return;
        }
        await this.onRequest(request, message.authorization);
        return;
      }
      default:
        return;
    }
  }

  private onTransportClose(): void {
    if (this.closing || this.closed) return;
    this.challengeWaiter?.reject(new Error("Remote transport closed."));
    this.authWaiter?.reject(new Error("Remote transport closed."));
    this.challengeWaiter = undefined;
    this.authWaiter = undefined;
    this.admitting = false;
    if (this.current.state === "revoked" || this.current.state === "suspended") return;
    this.transition("disconnected", "socket_lost");
    // Only an established connection reconnects; auth failure fails closed.
    if (this.established) this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    const config = this.options.reconnect ?? { baseDelayMs: 500, maxDelayMs: 30_000, maxAttempts: 8 };
    if (this.reconnectAttempts >= config.maxAttempts) return;
    if (this.reconnectTimer) return;
    const attempt = this.reconnectAttempts;
    this.reconnectAttempts += 1;
    const backoff = Math.min(config.maxDelayMs, config.baseDelayMs * 2 ** attempt);
    const delay = backoff + Math.floor(this.random() * config.baseDelayMs);
    const pending = (async () => {
      await this.sleep(delay);
      if (this.closing || this.closed) return;
      await this.connectOnce("reconnecting");
    })();
    this.reconnectTimer = pending;
    void pending.finally(() => {
      if (this.reconnectTimer === pending) this.reconnectTimer = undefined;
      if (!this.isReady() && !this.closing && !this.closed &&
        this.current.state !== "suspended" && this.current.state !== "revoked") this.scheduleReconnect();
    }).catch(() => undefined);
  }

  private async onRequest(request: RemoteRequest, authorization?: RemoteAuthorization): Promise<void> {
    const transport = this.transport;
    const respond = async (response: RemoteResponseMessage, data?: unknown): Promise<void> => {
      try { await transport?.send({ type: "response", response, ...(data !== undefined ? { data } : {}) }); }
      catch { /* A disconnected wait does not own the admitted job. */ }
    };
    if (this.options.deviceStore.isRevoked()) {
      this.admitting = false;
      this.transition("revoked", "device_key_revoked");
      this.cancelForRevocation();
      await respond(rejected(request, "device_revoked"));
      return;
    }
    try {
      this.options.authenticator.verifyAuthorization(request, authorization, this.options.session);
    } catch {
      await respond(rejected(request, "unauthorized"));
      return;
    }
    if (this.options.isOwnerLockHeld && !this.options.isOwnerLockHeld()) {
      this.suspend("owner_lock_lost");
      await respond(rejected(request, "unauthorized"));
      return;
    }
    if (!this.isReady()) {
      await respond(rejected(request, "device_offline"));
      return;
    }
    try {
      this.options.authenticator.verifyRequest(request, this.options.session);
      if (remotePayloadDigest(request) !== request.payloadDigest) throw new Error("Invalid digest.");
    } catch (error) {
      await respond(rejected(request, error instanceof RemoteAuthError ? error.code : "invalid_request"));
      return;
    }
    const identity: VerifiedRemoteIdentity = {
      accountId: request.accountId, clientId: request.clientId, deviceId: request.deviceId,
    };
    try {
      const refusal = this.options.runtime.authorizeJob?.(identity);
      if (refusal) { await respond(rejected(request, "unauthorized")); return; }
      if (JOB_TOOL_IDS.has(request.toolId)) {
        const answer = this.jobTool(identity, request);
        await respond(answer.response, answer.data);
        return;
      }
      const isPlugin = request.toolId.startsWith("plugin_");
      const runnerName = isPlugin ? request.toolId : REMOTE_TOOL_ID_TO_RUNNER[request.toolId];
      if (!runnerName || (isPlugin && !this.options.pluginTools)) {
        await respond(rejected(request, "unsupported_tool"));
        return;
      }
      if (!isPlugin && isEffect(request) && !this.options.runtime.invokeAdmitted) {
        await respond(rejected(request, "internal_error"));
        return;
      }
      if (isPlugin) {
        const tools = await this.options.pluginTools!.list();
        if (!tools.some((tool) => tool.relayToolId === request.toolId)) {
          await respond(rejected(request, "unsupported_tool"));
          return;
        }
      }
      // Plugin discovery may await; shutdown, fencing and policy still win before admission.
      if (this.closing || !this.isReady()) { await respond(rejected(request, "device_offline")); return; }
      this.options.authenticator.verifyAuthorization(request, authorization, this.options.session);
      if (this.options.deviceStore.isRevoked() ||
        (this.options.isOwnerLockHeld && !this.options.isOwnerLockHeld()) ||
        this.options.deviceStore.load()?.epoch !== request.deviceEpoch ||
        this.options.runtime.authorizeJob?.(identity, runnerName, request.payload)) {
        await respond(rejected(request, "unauthorized")); return;
      }
      if (Date.parse(request.expiresAt) <= this.now().getTime()) {
        await respond(rejected(request, "expired_request")); return;
      }
      // The store checks an existing key before rejecting a new admission at capacity.
      const rawRequest = JSON.stringify(request);
      const full = this.runningCount() >= this.concurrentLimit() && this.queue.length >= this.queueLimit();
      const decision = this.options.admission.admit(identity, rawRequest, { rejectNew: full });
      const deadline = Math.min(Date.parse(request.expiresAt),
        Date.parse(decision.job.createdAt) + (this.options.toolDeadlineMs ?? 300_000));
      if (!decision.created) {
        const existing = [...this.inFlight].find((item) => item.jobId === decision.job.jobId);
        if (decision.job.state !== "queued") {
          await respond(jobResponse(request, decision.job));
          return;
        }
        if (existing) {
          if (!existing.settled) {
            this.options.admission.refreshQueuedRequest(identity, decision.job.jobId, rawRequest);
            existing.rawRequest = rawRequest;
            existing.request = request;
            existing.authorization = authorization!;
            existing.deadline = deadline;
          }
          await respond(jobResponse(request, decision.job));
          return;
        }
        if (full) { await respond(jobResponse(request, decision.job)); return; }
        this.options.admission.refreshQueuedRequest(identity, decision.job.jobId, rawRequest);
      }
      let resolve!: (response: RemoteResponseMessage) => void;
      const done = new Promise<RemoteResponseMessage>((accept) => { resolve = accept; });
      const entry: InFlight = {
        identity, request, rawRequest, authorization: authorization!, runnerName, isPlugin,
        jobId: decision.job.jobId, controller: new AbortController(),
        deadline,
        done, resolve, started: false, settled: false,
      };
      this.inFlight.add(entry);
      this.queue.push(entry);
      this.pump();
      await respond(jobResponse(request, this.options.admission.view(identity, entry.jobId).job));
    } catch (error) {
      await respond(rejected(request, admissionCode(error)));
    }
  }

  private jobTool(identity: VerifiedRemoteIdentity, request: RemoteRequest): { response: RemoteResponseMessage; data: unknown } {
    const args = jobArguments(request);
    const admission = this.options.admission;
    const view = admission.view(identity, args.jobId);
    // The current signed scope must still cover the original job.
    if (view.job.scopeRef !== request.scopeRef) throw new RemoteAdmissionError("not_found", "Remote job is unavailable.");
    const name = REMOTE_TOOL_ID_TO_RUNNER[view.job.toolId] ?? view.job.toolId;
    if (this.options.runtime.authorizeJob?.(identity, name)) throw new RemoteAdmissionError("not_found", "Remote job is unavailable.");
    let data: unknown;
    if (request.toolId === "jobs_status") {
      data = view;
    } else if (request.toolId === "jobs_events") {
      data = admission.events(identity, args.jobId, args.cursor, args.limit);
    } else if (request.toolId === "jobs_result") {
      const result = admission.result(identity, args.jobId);
      const offset = resultOffset(args.cursor, args.jobId);
      const bytes = result.inline;
      if (offset > (bytes?.byteLength ?? 0)) throw new Error("Invalid result cursor.");
      const end = Math.min(bytes?.byteLength ?? 0, offset + (args.maxBytes ?? 64 * 1024));
      data = {
        state: result.state,
        ...(result.outputRef ? { outputRef: result.outputRef } : {}),
        ...(bytes ? { inline: Buffer.from(bytes.subarray(offset, end)).toString("base64"), encoding: "base64" } : {}),
        ...(bytes && end < bytes.byteLength ? { nextCursor: resultCursor(args.jobId, end) } : {}),
      };
    } else {
      // Persist the request before aborting or signalling any work.
      data = admission.requestCancel(identity, args.jobId, request.idempotencyKey, request.traceId);
      const entry = [...this.inFlight].find((item) => item.jobId === args.jobId);
      if (view.job.toolId === "process_start" && view.job.state === "completed") {
        const processId = admission.startedProcess(identity, args.jobId);
        if (processId && admission.view(identity, args.jobId).job.cancellation?.stop !== "stopped") {
          this.startProcessStop(identity, args.jobId, processId);
        }
      } else if (entry) this.cancelEntry(entry);
    }
    return { response: jobResponse(request, admission.view(identity, args.jobId).job), data };
  }

  private concurrentLimit(): number { return this.options.maxConcurrentJobsPerDevice ?? 8; }
  private queueLimit(): number { return this.options.maxQueuedJobsPerDevice ?? 64; }
  private runningCount(): number { return [...this.inFlight].filter((entry) => entry.started).length; }

  private pump(): void {
    if (this.closing || this.closed || this.current.state === "revoked" || this.current.state === "suspended") return;
    while (this.queue.length && this.runningCount() < this.concurrentLimit()) {
      const clients = [...new Set(this.queue.map((entry) => entry.identity.clientId))];
      const last = this.lastClientId === undefined ? -1 : clients.indexOf(this.lastClientId);
      const selected = clients[(last + 1) % clients.length];
      const index = this.queue.findIndex((entry) => entry.identity.clientId === selected);
      const entry = this.queue.splice(index, 1)[0]!;
      entry.started = true;
      this.lastClientId = selected;
      entry.physicalDone = this.dispatch(entry).finally(() => {
        this.inFlight.delete(entry);
        this.pump();
      });
      void entry.physicalDone.catch(() => undefined);
    }
  }

  private async dispatch(entry: InFlight): Promise<void> {
    const { identity, jobId } = entry;
    const admission = this.options.admission;
    try {
      if (entry.isPlugin) {
        const tools = await this.options.pluginTools!.list();
        if (!tools.some((tool) => tool.relayToolId === entry.request.toolId)) {
          if (!entry.settled) this.finish(entry, admission.blockPolicy(identity, jobId, "tool_unavailable"));
          return;
        }
      }
      if (entry.settled) return;
      const request = entry.request;
      // Recheck the original relay grant, local policy, deadline and current epoch
      // after every asynchronous preparation and immediately before the marker.
      try {
        this.options.authenticator.verifyAuthorization(request, entry.authorization, this.options.session);
        if (this.options.deviceStore.isRevoked() ||
          (this.options.isOwnerLockHeld && !this.options.isOwnerLockHeld()) ||
          this.options.deviceStore.load()?.epoch !== request.deviceEpoch ||
          this.options.runtime.authorizeJob?.(identity, entry.runnerName, request.payload)) {
          throw new Error("authorization_changed");
        }
        if (this.now().getTime() >= entry.deadline) throw new Error("expired_before_dispatch");
      } catch (error) {
        const reason = error instanceof Error && error.message === "expired_before_dispatch" ? error.message : "authorization_changed";
        this.finish(entry, admission.blockPolicy(identity, jobId, reason));
        return;
      }
      admission.markDispatching(identity, jobId, request.deviceEpoch);
      let result: ToolResult;
      let brokerInvoked = true;
      let stopEvidence: RemoteInvocationResult["stopEvidence"];
      try {
        if (entry.isPlugin) {
          const provider = this.options.pluginTools!;
          if (provider.invokeAdmitted) {
            const outcome = await provider.invokeAdmitted(identity, request.toolId, request.payload, entry.controller.signal, () => this.canDispatch(entry));
            result = outcome.result;
            brokerInvoked = outcome.brokerInvoked;
            stopEvidence = outcome.stopEvidence;
          } else {
            result = await provider.invoke(identity, request.toolId, request.payload, entry.controller.signal, () => this.canDispatch(entry));
          }
        } else if (this.options.runtime.invokeAdmitted) {
          const outcome = await this.options.runtime.invokeAdmitted(identity, entry.runnerName, request.payload,
            entry.controller.signal, entry.rawRequest, jobId, () => this.canDispatch(entry));
          result = outcome.result;
          brokerInvoked = outcome.brokerInvoked;
          stopEvidence = outcome.stopEvidence;
        } else {
          result = await this.options.runtime.invoke(identity, entry.runnerName, request.payload, entry.controller.signal, entry.rawRequest);
        }
      } catch (error) {
        if (entry.settled) return;
        const notSent = isRecord(error) && error.outcome === "not_sent";
        if (entry.controller.signal.aborted && notSent) {
          admission.recordStop(identity, jobId, "verified");
          this.finish(entry, admission.settleCancelled(identity, jobId, "no_effect"));
        } else {
          if (entry.controller.signal.aborted) admission.recordStop(identity, jobId, "unverified");
          this.finish(entry, admission.settle(identity, jobId, notSent ? "failed" : "outcome_unknown"));
        }
        return;
      }
      if (entry.isPlugin) await this.refreshPluginState();
      if (entry.settled) {
        if (entry.controller.signal.aborted && entry.runnerName === "process.start" && !result.isError) {
          const processId = resultProcessId(result);
          if (processId) {
            admission.bindStartedProcess(identity, jobId, processId);
            await this.stopProcess(identity, jobId, processId);
          }
        }
        return;
      }
      if (entry.runnerName === "process.start" && !result.isError) {
        const processId = resultProcessId(result);
        if (!processId) throw new Error("Managed process identity is unavailable.");
        admission.bindStartedProcess(identity, jobId, processId);
      }
      const unknown = isUnknownResult(result) || (entry.isPlugin && result.isError &&
        (entry.controller.signal.aborted || (this.pluginDegradedReason !== undefined &&
          /crash|closed|unavailable|restart/i.test(result.error?.message ?? ""))));
      if (entry.controller.signal.aborted && entry.runnerName === "process.start" && !result.isError) {
        const processId = resultProcessId(result);
        if (processId) await this.stopProcess(identity, jobId, processId);
        else admission.recordStop(identity, jobId, "unverified");
        if (!entry.settled) this.finish(entry, admission.settleCancelled(identity, jobId, "effect_outcome_unknown"));
      } else if (entry.controller.signal.aborted && (!brokerInvoked || stopEvidence)) {
        admission.recordStop(identity, jobId, "verified");
        this.finish(entry, admission.settleCancelled(identity, jobId,
          stopEvidence?.effect ?? "no_effect"));
      } else if (!brokerInvoked && result.isError) {
        this.finish(entry, admission.settle(identity, jobId, "failed",
          { inline: Buffer.from(JSON.stringify({ reason: result.error?.code ?? "dispatch_refused" }), "utf8") }));
      } else if (entry.controller.signal.aborted && unknown) {
        admission.recordStop(identity, jobId, "unverified");
        this.finish(entry, admission.settleCancelled(identity, jobId, "effect_outcome_unknown"));
      } else {
        if (entry.controller.signal.aborted) admission.recordStop(identity, jobId, "unverified");
        const bytes = Buffer.from(JSON.stringify(result), "utf8");
        const inline = bytes.byteLength <= 256 * 1024 ? bytes : Buffer.from(JSON.stringify({ truncated: true }), "utf8");
        this.finish(entry, admission.settle(identity, jobId, unknown ? "outcome_unknown" : result.isError ? "failed" : "completed",
          unknown ? undefined : { inline }));
      }
    } catch {
      if (!entry.settled) {
        try {
          const current = admission.getJob(identity, jobId);
          if (current?.state === "queued") this.finish(entry, admission.blockPolicy(identity, jobId, "dispatch_refused"));
          else if (current?.state === "running") this.finish(entry, admission.settle(identity, jobId, "outcome_unknown"));
          else if (current) this.finish(entry, current);
        } catch { entry.settled = true; entry.resolve(rejected(entry.request, "internal_error")); }
      }
    }
  }

  private startProcessStop(identity: VerifiedRemoteIdentity, jobId: string, processId: string): void {
    if (this.processStops.has(jobId)) return;
    const promise = this.stopProcess(identity, jobId, processId).finally(() => { this.processStops.delete(jobId); });
    this.processStops.set(jobId, { identity, promise });
    void promise.catch(() => undefined);
  }

  private async stopProcess(identity: VerifiedRemoteIdentity, jobId: string, processId: string): Promise<void> {
    let stopped = false;
    try { stopped = !!await this.options.runtime.stopStartedProcess?.(identity, processId); }
    catch { /* An unverified stop remains visible and retryable. */ }
    this.options.admission.recordStop(identity, jobId, stopped ? "verified" : "unverified");
  }
  private canDispatch(entry: InFlight): boolean {
    try {
      this.options.authenticator.verifyAuthorization(entry.request, entry.authorization, this.options.session);
      return !this.closing && !entry.settled && !entry.controller.signal.aborted &&
        !this.options.deviceStore.isRevoked() &&
        (!this.options.isOwnerLockHeld || this.options.isOwnerLockHeld()) &&
        this.options.deviceStore.load()?.epoch === entry.request.deviceEpoch &&
        this.now().getTime() < entry.deadline &&
        !this.options.runtime.authorizeJob?.(entry.identity, entry.runnerName, entry.request.payload);
    } catch { return false; }
  }
  private finish(entry: InFlight, job: RemoteJob): void {
    if (entry.settled) return;
    entry.settled = true;
    entry.resolve(jobResponse(entry.request, job));
  }

  private cancelForRevocation(): void {
    if (this.options.isOwnerLockHeld && !this.options.isOwnerLockHeld()) return;
    for (const entry of [...this.inFlight]) {
      if (entry.settled) continue;
      try {
        this.options.admission.requestCancel(entry.identity, entry.jobId, "revoke-" + randomUUID(), entry.request.traceId);
        this.cancelEntry(entry);
      } catch { /* An unrecorded request cannot authorize a cancellation signal. */ }
    }
  }
  private cancelEntry(entry: InFlight): void {
    entry.controller.abort();
    if (!entry.started) {
      const index = this.queue.indexOf(entry);
      if (index >= 0) this.queue.splice(index, 1);
      this.finish(entry, this.options.admission.view(entry.identity, entry.jobId).job);
      this.inFlight.delete(entry);
      this.pump();
      return;
    }
    void this.sleep(this.options.cancellationGraceMs ?? 5_000).then(() => {
      if (entry.settled) return;
      try {
        const job = this.options.admission.getJob(entry.identity, entry.jobId);
        if (job?.state === "running") {
          this.options.admission.recordStop(entry.identity, entry.jobId, "unverified");
          this.finish(entry, this.options.admission.settleCancelled(entry.identity, entry.jobId, "effect_outcome_unknown"));
        } else if (job) this.finish(entry, job);
      } catch { /* The durable marker remains for startup reconciliation. */ }
    });
  }

  private transition(state: RemoteConnectionStateName, reasonCode: RemoteConnectionReason): void {
    const identity = this.options.deviceStore.load();
    const needsEpoch = state === "connected-degraded" || state === "tool-ready";
    this.current = Object.freeze({
      protocolVersion: PROTOCOL_VERSION,
      deviceId: identity?.deviceId ?? this.current.deviceId,
      state, reasonCode,
      changedAt: this.now().toISOString(),
      ...(needsEpoch && identity ? { deviceEpoch: identity.epoch } : {}),
    });
    this.options.onStateChange?.(this.current);
  }
}

interface JobArguments { jobId: string; cursor?: string; limit?: number; maxBytes?: number }

function jobArguments(request: RemoteRequest): JobArguments {
  if (!isRecord(request.payload)) throw new Error("Invalid job arguments.");
  const payload = request.payload;
  const allowed = request.toolId === "jobs_events" ? ["jobId", "cursor", "limit"] :
    request.toolId === "jobs_result" ? ["jobId", "cursor", "maxBytes"] : ["jobId"];
  if (Object.keys(payload).some((key) => !allowed.includes(key)) ||
    typeof payload.jobId !== "string" || !payload.jobId || payload.jobId.length > 256 ||
    (payload.cursor !== undefined && (typeof payload.cursor !== "string" || !payload.cursor || payload.cursor.length > 512)) ||
    (payload.limit !== undefined && (!Number.isInteger(payload.limit) || Number(payload.limit) < 1 || Number(payload.limit) > 256)) ||
    (payload.maxBytes !== undefined && (!Number.isInteger(payload.maxBytes) || Number(payload.maxBytes) < 1 || Number(payload.maxBytes) > 64 * 1024))) {
    throw new Error("Invalid job arguments.");
  }
  return {
    jobId: payload.jobId,
    ...(typeof payload.cursor === "string" ? { cursor: payload.cursor } : {}),
    ...(typeof payload.limit === "number" ? { limit: payload.limit } : {}),
    ...(typeof payload.maxBytes === "number" ? { maxBytes: payload.maxBytes } : {}),
  };
}

function resultCursor(jobId: string, offset: number): string {
  return Buffer.from(JSON.stringify([jobId, offset]), "utf8").toString("base64url");
}

function resultOffset(cursor: string | undefined, jobId: string): number {
  if (cursor === undefined) return 0;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (Array.isArray(parsed) && parsed.length === 2 && parsed[0] === jobId &&
      Number.isSafeInteger(parsed[1]) && parsed[1] >= 0 && resultCursor(jobId, parsed[1]) === cursor) return parsed[1] as number;
  } catch { /* Invalid cursors never grant access. */ }
  throw new Error("Invalid result cursor.");
}

function jobResponse(request: RemoteRequest, job: RemoteJob): RemoteResponseMessage {
  return {
    requestId: request.requestId, traceId: request.traceId, admitted: true, jobId: job.jobId, status: job.state,
    ...(job.state === "outcome_unknown" ? { errorCode: "outcome_unknown", uncertainty: "effect_outcome_unknown" } : {}),
  };
}

function resultProcessId(result: ToolResult): string | undefined {
  for (const block of result.content) {
    if (block.type === "json" && isRecord(block.value) && typeof block.value.processId === "string") return block.value.processId;
  }
  return undefined;
}

function isEffect(request: RemoteRequest): boolean {
  return EFFECT_TOOL_IDS.has(request.toolId) ||
    (request.toolId === "files_search" && isRecord(request.payload) && request.payload.cancel === true);
}

function isUnknownResult(result: ToolResult): boolean {
  return ["tool_timeout", "tool_cancelled", "process_timeout", "process_cancelled",
    "reconciliation_required", "process_input_outcome_unknown", "process_input_interrupted",
    "mcp_request_timeout", "mcp_request_cancelled", "mcp_write_outcome_unknown",
    "mcp_session_unavailable", "mcp_restart_exhausted"].includes(result.error?.code ?? "") ||
    result.content.some((block) => (block.type === "json" && isRecord(block.value) && block.value.status === "outcome_unknown") ||
      (result.isError && block.type === "text" && /OUTCOME UNKNOWN \(not retried\)/i.test(block.text)));
}

/** Echo only well-formed correlation ids from a request that failed the strict codec. */
function malformed(raw: unknown): RemoteResponseMessage {
  const record = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
  const id = (value: unknown) => typeof value === "string" && /^[A-Za-z0-9._:-]{1,128}$/.test(value) ? value : "invalid";
  return { requestId: id(record.requestId), traceId: id(record.traceId), admitted: false, status: "rejected", errorCode: "invalid_request" };
}

function rejected(request: RemoteRequest, errorCode: string): RemoteResponseMessage {
  const blocked = errorCode === "device_revoked" || errorCode === "unauthorized" || errorCode === "device_epoch_mismatch";
  return {
    requestId: request.requestId, traceId: request.traceId, admitted: false,
    status: errorCode === "blocked_quota" ? "blocked_quota" : blocked ? "blocked_policy" : "rejected", errorCode,
  };
}

function admissionCode(error: unknown): string {
  if (isRecord(error) && typeof error.code === "string") {
    if (error.code === "storage_exhausted" || error.code === "schema_migration_failed") return "internal_error";
    return error.code;
  }
  return "invalid_request";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
