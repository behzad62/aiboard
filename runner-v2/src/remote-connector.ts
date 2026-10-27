import type { ToolResult } from "./agent-contracts.js";
import { parseRemoteRequest, type RemoteAdmissionStore, type RemoteRequest } from "./remote-admission-store.js";
import { RemoteAuthError, type RelayChallenge, type RemoteAuthorization, type RemoteAuthenticator } from "./remote-auth.js";
import type { RemoteDeviceSession, RemoteDeviceStore } from "./remote-device-store.js";
import type { VerifiedRemoteIdentity } from "./remote-principal.js";

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
  | { readonly type: "response"; readonly response: RemoteResponseMessage }
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
  invoke(identity: VerifiedRemoteIdentity, relayToolId: string, args: unknown, signal?: AbortSignal): Promise<ToolResult>;
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

/** Tool ids whose dispatch is admitted by RemoteToolRuntime's effect adapter. */
const EFFECT_TOOL_IDS: ReadonlySet<string> = new Set([
  "files_write", "files_patch", "files_move", "files_delete",
  "process_start", "process_run", "process_write_stdin", "process_signal",
]);

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
  readonly reconnect?: { readonly baseDelayMs: number; readonly maxDelayMs: number; readonly maxAttempts: number };
  readonly isOwnerLockHeld?: () => boolean;
  readonly onStateChange?: (state: RemoteConnectionState) => void;
  readonly onShutdownStep?: (step: string) => void;
  /** Admitted extension tools for the current generation/policy (R1c), when composed. */
  readonly pluginTools?: RemotePluginToolProvider;
}

interface InFlight {
  readonly rawRequest: string;
  readonly request: RemoteRequest;
  settled: boolean;
  done: Promise<void>;
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
      const drainMs = this.options.drainTimeoutMs ?? 5_000;
      const all = Promise.allSettled([...this.inFlight].map((entry) => entry.done));
      await Promise.race([all, this.sleep(drainMs)]);
      for (const entry of [...this.inFlight]) {
        if (!entry.settled) this.settleUnknown(entry);
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
      await this.options.reconcile();
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
    this.reconnectTimer = (async () => {
      try {
        await this.sleep(delay);
        if (this.closing || this.closed) return;
        await this.connectOnce("reconnecting");
        if (!this.isReady() && !this.closing && !this.closed &&
          this.current.state !== "suspended" && this.current.state !== "revoked") {
          this.scheduleReconnect();
        }
      } finally {
        this.reconnectTimer = undefined;
      }
    })();
  }

  private async onRequest(request: RemoteRequest, authorization?: RemoteAuthorization): Promise<void> {
    const transport = this.transport;
    const respond = async (response: RemoteResponseMessage): Promise<void> => {
      try { await transport?.send({ type: "response", response }); } catch { /* socket loss is fenced by epoch */ }
    };
    if (this.options.deviceStore.isRevoked()) {
      this.admitting = false;
      this.transition("revoked", "device_key_revoked");
      await respond(rejected(request, "device_revoked"));
      return;
    }
    // Relay-signed authorization next: any failure is unauthorized, with no
    // admission and zero broker/tool invocations (ADR-A verify order).
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
    } catch (error) {
      const code = error instanceof RemoteAuthError ? error.code : "unauthorized";
      await respond(rejected(request, code));
      return;
    }
    const isPlugin = request.toolId.startsWith("plugin_");
    const runnerName = isPlugin ? request.toolId : REMOTE_TOOL_ID_TO_RUNNER[request.toolId];
    if (!runnerName || (isPlugin && !this.options.pluginTools)) {
      await respond(rejected(request, "unsupported_tool"));
      return;
    }
    const identity: VerifiedRemoteIdentity = {
      accountId: this.options.session.accountId,
      clientId: this.options.session.clientId,
      deviceId: this.options.deviceStore.load()!.deviceId,
    };
    const rawRequest = JSON.stringify(request);
    const entry: InFlight = {
      rawRequest, request, settled: false,
      done: Promise.resolve(),
    };
    const work = (async (): Promise<void> => {
      try {
        const response = isPlugin
          ? await this.dispatchPlugin(identity, request, rawRequest)
          : EFFECT_TOOL_IDS.has(request.toolId) || isSearchCancel(request)
          ? await this.dispatchEffect(identity, runnerName, request, rawRequest)
          : await this.dispatchRead(identity, runnerName, request, rawRequest);
        entry.settled = true;
        await respond(response);
      } catch {
        entry.settled = true;
        await respond(rejected(request, "internal_error"));
      } finally {
        this.inFlight.delete(entry);
      }
    })();
    entry.done = work;
    this.inFlight.add(entry);
    await work;
  }

  /** Plugin tools: only admitted relay ids, record-before-dispatch, never replayed. */
  private async dispatchPlugin(
    identity: VerifiedRemoteIdentity, request: RemoteRequest, rawRequest: string,
  ): Promise<RemoteResponseMessage> {
    const provider = this.options.pluginTools!;
    let tools: readonly RemotePluginToolInfo[];
    try { tools = await provider.list(); } catch { return rejected(request, "unsupported_tool"); }
    const tool = tools.find((entry) => entry.relayToolId === request.toolId);
    if (!tool) return rejected(request, "unsupported_tool");
    if (!tool.available) {
      // A fresh request is the supervised recovery attempt: the manager
      // re-attests and restarts the same executable/schema on this call.
      // It is never a replay of the interrupted request (new admission key).
      await this.refreshPluginState();
    }
    const admission = this.options.admission;
    let decision;
    try { decision = admission.admit(identity, rawRequest); } catch (error) { return rejected(request, admissionCode(error)); }
    if (!decision.created) {
      const job = decision.job;
      return { requestId: request.requestId, traceId: request.traceId, admitted: true, jobId: job.jobId, status: job.state };
    }
    try { admission.markDispatching(identity, decision.job.jobId, request.deviceEpoch); } catch (error) { return rejected(request, admissionCode(error)); }
    let result: ToolResult;
    try {
      result = await provider.invoke(identity, request.toolId, request.payload, undefined);
    } catch {
      // An interrupted plugin call is settled unknown and never replayed.
      const job = admission.settle(identity, decision.job.jobId, "outcome_unknown");
      await this.refreshPluginState();
      return { requestId: request.requestId, traceId: request.traceId, admitted: true, jobId: job.jobId, status: job.state, errorCode: "outcome_unknown", uncertainty: "effect_outcome_unknown" };
    }
    await this.refreshPluginState();
    const unknown = ["tool_timeout", "tool_cancelled", "process_timeout", "process_cancelled", "mcp_session_unavailable", "mcp_restart_exhausted"].includes(result.error?.code ?? "") ||
      (result.isError && this.pluginDegradedReason !== undefined && /crash|closed|unavailable|restart/i.test(result.error?.message ?? ""));
    const job = admission.settle(identity, decision.job.jobId, unknown ? "outcome_unknown" : result.isError ? "failed" : "completed");
    return {
      requestId: request.requestId, traceId: request.traceId, admitted: true, jobId: job.jobId, status: job.state,
      ...(job.state === "outcome_unknown" ? { errorCode: "outcome_unknown", uncertainty: "effect_outcome_unknown" } : {}),
      ...(result.isError && job.state === "failed" ? { errorCode: result.error?.code ?? "internal_error" } : {}),
    };
  }

  /** Reads: connector-level record-before-dispatch, then the R1a runtime. */
  private async dispatchRead(
    identity: VerifiedRemoteIdentity, runnerName: string, request: RemoteRequest, rawRequest: string,
  ): Promise<RemoteResponseMessage> {
    const admission = this.options.admission;
    let decision;
    try {
      decision = admission.admit(identity, rawRequest);
    } catch (error) {
      return rejected(request, admissionCode(error));
    }
    if (!decision.created) {
      const job = decision.job;
      return { requestId: request.requestId, traceId: request.traceId, admitted: true, jobId: job.jobId, status: job.state };
    }
    try {
      admission.markDispatching(identity, decision.job.jobId, request.deviceEpoch);
    } catch (error) {
      return rejected(request, admissionCode(error));
    }
    let result: ToolResult;
    try {
      result = await this.options.runtime.invoke(identity, runnerName, request.payload, undefined, rawRequest);
    } catch {
      const job = admission.settle(identity, decision.job.jobId, "outcome_unknown");
      return { requestId: request.requestId, traceId: request.traceId, admitted: true, jobId: job.jobId, status: job.state, errorCode: "outcome_unknown", uncertainty: "effect_outcome_unknown" };
    }
    const unknown = ["tool_timeout", "tool_cancelled", "process_timeout", "process_cancelled"].includes(result.error?.code ?? "");
    const job = admission.settle(identity, decision.job.jobId, unknown ? "outcome_unknown" : result.isError ? "failed" : "completed");
    return {
      requestId: request.requestId, traceId: request.traceId, admitted: true, jobId: job.jobId, status: job.state,
      ...(job.state === "outcome_unknown" ? { errorCode: "outcome_unknown", uncertainty: "effect_outcome_unknown" } : {}),
      ...(result.isError && job.state === "failed" ? { errorCode: result.error?.code ?? "internal_error" } : {}),
    };
  }

  /** Effects: RemoteToolRuntime admits (R1b) immediately before dispatch (R1a). */
  private async dispatchEffect(
    identity: VerifiedRemoteIdentity, runnerName: string, request: RemoteRequest, rawRequest: string,
  ): Promise<RemoteResponseMessage> {
    const result = await this.options.runtime.invoke(identity, runnerName, request.payload, undefined, rawRequest);
    const first = result.content[0];
    const value: unknown = first?.type === "json" ? first.value : undefined;
    if (isRecord(value) && typeof value.jobId === "string") {
      const jobId: string = value.jobId;
      return {
        requestId: request.requestId, traceId: request.traceId, admitted: true,
        jobId, status: typeof value.status === "string" ? value.status : "completed",
        ...(result.error?.code === "outcome_unknown" ? { errorCode: "outcome_unknown", uncertainty: "effect_outcome_unknown" } : {}),
      };
    }
    if (result.isError) return rejected(request, result.error?.code ?? "internal_error");
    return rejected(request, "internal_error");
  }

  private settleUnknown(entry: InFlight): void {
    try {
      const identity: VerifiedRemoteIdentity = {
        accountId: this.options.session.accountId,
        clientId: this.options.session.clientId,
        deviceId: this.options.deviceStore.load()!.deviceId,
      };
      const decision = this.options.admission.admit(identity, entry.rawRequest);
      if (decision.job.state === "running") {
        this.options.admission.settle(identity, decision.job.jobId, "outcome_unknown");
      }
    } catch { /* an unsettled record stays as admission left it */ }
    entry.settled = true;
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
    status: blocked ? "blocked_policy" : "rejected", errorCode,
  };
}

function admissionCode(error: unknown): string {
  if (isRecord(error) && typeof error.code === "string") return error.code;
  return "invalid_request";
}

function isSearchCancel(request: RemoteRequest): boolean {
  return request.toolId === "files_search" && isRecord(request.payload) && request.payload.cancel === true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
