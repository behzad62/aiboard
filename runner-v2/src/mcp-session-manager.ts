import { realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import type { ToolExecutionContext, ToolAccessRequest } from "./agent-contracts.js";
import { canonicalMcpDigest, fixedMcpEnvelope, mcpConfigurationDigest, snapshotMcpServerSpec, type McpServerSpec } from "./mcp-configuration.js";
import { McpRpcPeer, McpProtocolError, parseMcpToolList } from "./mcp-rpc-peer.js";
import type { McpDiscoveryResult, McpDiscoveryTool } from "./runner-internal-execution-context.js";
import type { McpCallResult, McpManagerOptions, McpOwnedTransport, McpRequestOwner, McpServerStatus } from "./mcp-tools.js";

export class McpSessionError extends Error {
  constructor(readonly code: "mcp_authority_required" | "mcp_access_refused" | "mcp_session_unavailable" | "mcp_restart_exhausted" | "mcp_schema_changed" | "mcp_attestation_mismatch" | "mcp_request_replayed", message: string) {
    super(message); this.name = "McpSessionError";
  }
}
interface ConfiguredServer {
  readonly spec: Readonly<McpServerSpec>;
  readonly discovered?: McpDiscoveryResult["servers"][number];
  readonly tools: readonly McpDiscoveryTool[];
  available: boolean;
  status: McpServerStatus["status"];
  error?: string;
  invalidation?: Promise<void>;
  invalidationOrigin?: Slot;
}
interface Slot {
  readonly key: string;
  readonly agent: string;
  readonly server: ConfiguredServer;
  readonly owner: McpRequestOwner;
  attempts: number;
  waiting: number;
  closed: boolean;
  busy: boolean;
  tail: Promise<unknown>;
  transport?: McpOwnedTransport;
  peer?: McpRpcPeer;
  closing?: Promise<void>;
  controller?: AbortController;
}

/** This manager owns no global live child. Its catalog is the result of verified
 * ephemeral discovery. Live children belong to exact agent/envelope slots and
 * are created only in an actual call carrying a ToolBroker execution grant.
 */
export class McpSessionManager {
  private readonly configured: readonly ConfiguredServer[];
  private readonly slots = new Map<string, Slot>();
  private readonly usedCalls = new Set<string>();
  private readonly agentEpochs = new Map<string, symbol>();
  private readonly maximumRestarts: number;
  private readonly maximumSessions: number;
  private readonly timeoutMs: number;
  private closed = false;
  private started = false;
  private closePromise?: Promise<void>;

  constructor(private readonly options: McpManagerOptions) {
    this.maximumRestarts = bound(options.maximumRestarts ?? 2, 0, 5, "restart");
    this.maximumSessions = bound(options.maximumSessions ?? 128, 1, 256, "session");
    this.timeoutMs = bound(options.requestTimeoutMs ?? 120_000, 1, 3_600_000, "request timeout");
    bound(options.maximumLineBytes ?? 1024 * 1024, 1, 1024 * 1024, "line");
    const names = new Set<string>();
    this.configured = Object.freeze(options.servers.map((value) => {
      const spec = snapshotMcpServerSpec(value);
      if (names.has(spec.name)) throw new Error(`Duplicate MCP server ${spec.name}.`);
      names.add(spec.name);
      const recorded = options.discovery?.servers.find((entry) => entry.name === spec.name);
      const valid = options.discovery?.runId === options.runId && !!options.runId && recorded?.cleanupVerified === true &&
        recorded.configDigest === mcpConfigurationDigest(spec) && recorded.status === "ready";
      const tools = valid ? parseMcpToolList({ tools: recorded.tools }) : [];
      const available = valid && recorded.schemaDigest === canonicalMcpDigest(tools) && /^[a-f0-9]{64}$/u.test(recorded.executableDigest);
      return { spec, ...(recorded ? { discovered: Object.freeze(structuredClone(recorded)) } : {}), tools: available ? tools : [],
        available, status: "stopped" as const };
    }));
  }

  async start(): Promise<void> {
    if (this.closed) throw new McpSessionError("mcp_session_unavailable", "MCP manager is closed.");
    this.started = true;
    for (const server of this.configured) {
      server.status = server.available ? "ready" : "error";
      if (!server.available) server.error = "MCP configuration lacks verified matching discovery.";
    }
  }

  status(): McpServerStatus[] {
    return this.configured.map((server) => ({ name: server.spec.name, command: server.spec.command,
      status: server.status, toolCount: !this.closed && server.status === "ready" && server.available ? server.tools.length : 0,
      ...(server.error ? { error: server.error } : {}) }));
  }

  toolEntries() {
    if (!this.started || this.closed) return [];
    return this.configured.flatMap((server) => server.available ? server.tools.map((tool) => ({ tool,
      client: Object.freeze({ spec: server.spec,
        call: (name: string, arguments_: Record<string, unknown>, context?: ToolExecutionContext) => this.call(server, name, arguments_, context),
        access: (context: ToolExecutionContext) => this.access(server, tool, context),
      }),
    })) : []);
  }

  private access(server: ConfiguredServer, tool: McpDiscoveryTool, _context: ToolExecutionContext): ToolAccessRequest {
    const envelope = fixedMcpEnvelope(server.spec.envelope);
    return { capability: `mcp.${server.spec.name}.${tool.name}`, external: true,
      destructive: tool.annotations?.destructiveHint !== false, network: envelope.network,
      paths: envelope.paths.map((entry) => ({ path: isAbsolute(entry.path) ? entry.path : resolve(this.options.cwd, entry.path), access: entry.mode })) };
  }

  private async owner(server: ConfiguredServer, tool: McpDiscoveryTool, context: ToolExecutionContext): Promise<McpRequestOwner> {
    const envelope = fixedMcpEnvelope(server.spec.envelope);
    // The current ExecutionHost has no configured credential resolver. Required
    // credentials fail explicitly; they are never inherited or silently omitted.
    if (envelope.credentialNames.length) throw new McpSessionError("mcp_access_refused", "MCP configured credentials cannot be expressed by the current host credential authority.");
    const workspace = await realpath(context.workspacePath ?? this.options.cwd);
    const access = await Promise.all(envelope.paths.map(async (entry) => Object.freeze({
      canonicalPath: await realpath(isAbsolute(entry.path) ? entry.path : resolve(this.options.cwd, entry.path)), mode: entry.mode,
    })));
    const externalApproved = access.some((entry) => { const path = relative(workspace, entry.canonicalPath); return path === ".." || path.startsWith("..\\") || path.startsWith("../") || isAbsolute(path); });
    return Object.freeze({ context: Object.freeze({ ...context, actor: Object.freeze({ ...context.actor }) }),
      envelope: Object.freeze({ access: Object.freeze(access), credentialNames: Object.freeze([]), networkApproved: envelope.network,
        externalApproved, destructiveApproved: tool.annotations?.destructiveHint !== false }) });
  }

  private async call(server: ConfiguredServer, name: string, arguments_: Record<string, unknown>, context?: ToolExecutionContext): Promise<McpCallResult> {
    if (!this.started || this.closed || !server.available) throw new McpSessionError("mcp_session_unavailable", "MCP server is not available from verified discovery.");
    if (!context || context.runId !== this.options.runId || !context.sessionId || !context.actor?.id || !context.callId || !context.toolName || !context.executionGrant)
      throw new McpSessionError("mcp_authority_required", "MCP requires the exact run, actor, agent session and ToolBroker call grant.");
    if (context.signal?.aborted) throw new McpProtocolError("mcp_request_cancelled", "MCP request was cancelled before launch.", "not_sent");
    const tool = server.tools.find((entry) => entry.name === name);
    if (!tool) throw new McpSessionError("mcp_schema_changed", "MCP tool is absent from the discovered schema.");
    const original = Object.freeze({ ...context, actor: Object.freeze({ ...context.actor }) });
    const agent = JSON.stringify([original.runId, original.actor.role, original.actor.id, original.sessionId]);
    let epoch = this.agentEpochs.get(agent);
    if (!epoch) { epoch = Symbol("MCP agent epoch"); this.agentEpochs.set(agent, epoch); }
    const callId = JSON.stringify([agent, original.toolName, original.callId]);
    if (this.usedCalls.has(callId)) throw new McpSessionError("mcp_request_replayed", "An external MCP call cannot be replayed or reuse an earlier call identity.");
    if (this.usedCalls.size >= 16384) throw new McpSessionError("mcp_session_unavailable", "MCP run request capacity is exhausted.");
    this.usedCalls.add(callId);
    const controller = new AbortController();
    const combined = original.signal ? AbortSignal.any([original.signal, controller.signal]) : controller.signal;
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    const at = Date.now();
    if (process.env.TASK12_MCP_TRACE === "1") {
      combined.addEventListener("abort", () => {
        process.stderr.write(`${JSON.stringify({
          t: Date.now(),
          event: "mcp.signal.abort",
          elapsedMs: Date.now() - at,
          timeoutMs: this.timeoutMs,
          originalAborted: original.signal?.aborted === true,
          controllerAborted: controller.signal.aborted,
          sessionId: original.sessionId,
        })}\n`);
      }, { once: true });
    }
    let abortListener: (() => void) | undefined;
    try {
      const owner = await abortable(() => this.owner(server, tool, { ...original, signal: combined }), combined);
      if (this.closed || this.agentEpochs.get(agent) !== epoch || combined.aborted) throw new McpProtocolError("mcp_request_cancelled", "MCP request was cancelled before launch.", "not_sent");
      const key = JSON.stringify([agent, server.spec.name, canonicalMcpDigest(owner.envelope)]);
      let slot = this.slots.get(key);
      if (!slot) {
        if (this.slots.size >= this.maximumSessions) throw new McpSessionError("mcp_session_unavailable", "MCP live-session capacity is exhausted.");
        slot = { key, agent, server, owner, attempts: 0, waiting: 0, closed: false, busy: false, tail: Promise.resolve() };
        this.slots.set(key, slot);
      }
      if (slot.waiting >= 64) throw new McpSessionError("mcp_session_unavailable", "MCP request queue capacity is exhausted.");
      const owned = slot;
      const args = structuredClone(arguments_);
      owned.waiting++;
      let entered = false;
      const running = owned.tail.then(async () => {
        entered = true;
        if (this.closed || owned.closed || combined.aborted) throw new McpProtocolError("mcp_request_cancelled", "MCP queued request was cancelled before write.", "not_sent");
        owned.busy = true; owned.controller = controller;
        try { return await this.perform(owned, owner, name, args, Math.max(1, this.timeoutMs - (Date.now() - at))); }
        finally { owned.busy = false; owned.controller = undefined; }
      }).finally(() => { owned.waiting--; });
      owned.tail = running.catch(() => undefined);
      // Queued callers remain bounded even if a previous provider cleanup is
      // slow. The queued task still owns its promise and refuses later effects.
      const cancelled = new Promise<never>((_resolve, reject) => {
        abortListener = () => { if (!entered) reject(new McpProtocolError("mcp_request_cancelled", "MCP queued request was cancelled.", "not_sent")); };
        combined.addEventListener("abort", abortListener, { once: true });
      });
      return await Promise.race([running, cancelled]);
    } finally { clearTimeout(timeout); if (abortListener) combined.removeEventListener("abort", abortListener); }
  }

  private async perform(slot: Slot, owner: McpRequestOwner, name: string, args: Record<string, unknown>, timeoutMs: number): Promise<McpCallResult> {
    const server = slot.server;
    try {
      if (!this.options.reattest) throw new McpSessionError("mcp_attestation_mismatch", "MCP executable must be re-attested by its exact configuration owner.");
      if (slot.closed || this.closed) throw new McpProtocolError("mcp_request_cancelled", "MCP session closed before re-attestation.", "not_sent");
      const launches = await abortable(() => this.options.reattest!(), owner.context.signal).catch((error: unknown) => {
        if (error instanceof McpProtocolError) throw error;
        throw new McpSessionError("mcp_attestation_mismatch", "MCP pinned executable or configuration failed current re-attestation.");
      });
      if (slot.closed || this.closed || owner.context.signal?.aborted) throw new McpProtocolError("mcp_request_cancelled", "MCP owner closed before live launch.", "not_sent");
      const launch = launches.find((entry) => entry.name === server.spec.name);
      if (!launch || launch.command !== server.spec.command || launch.configDigest !== server.discovered!.configDigest || launch.executableDigest !== server.discovered!.executableDigest)
        throw new McpSessionError("mcp_attestation_mismatch", "MCP executable or configuration changed after discovery.");
      if (slot.closing) await slot.closing;
      if (!slot.transport) {
        if (slot.attempts > this.maximumRestarts) throw new McpSessionError("mcp_restart_exhausted", "MCP restart budget is exhausted; a call will not be replayed.");
        slot.attempts++;
        const peer = new McpRpcPeer({ maximumLineBytes: this.options.maximumLineBytes, onFailure: (error) => {
          server.error = error.message; server.status = "error";
          if (error.code === "mcp_schema_changed") this.invalidateServer(server, slot.busy ? slot : undefined);
          else if (!slot.busy) void this.retire(slot).catch((failure: unknown) => { server.error = `MCP cleanup is unverified: ${asError(failure).message}`; });
        } });
        slot.peer = peer;
        if (process.env.TASK12_MCP_TRACE === "1") process.stderr.write(`${JSON.stringify({ t: Date.now(), event: "mcp.open.start", agent: slot.agent, timeoutMs })}\n`);
        const transport = await this.options.transportFactory.open({
          server: server.spec, owner, expected: server.discovered,
          onOutput: (stream, bytes) => {
            if (process.env.TASK12_MCP_TRACE === "1") process.stderr.write(`${JSON.stringify({ t: Date.now(), event: "mcp.feed", stream, bytes: bytes.byteLength, agent: slot.agent })}\n`);
            peer.feed(stream, bytes);
          }, onFailure: (error) => peer.close(error),
          handshake: async (writer) => {
            if (process.env.TASK12_MCP_TRACE === "1") process.stderr.write(`${JSON.stringify({ t: Date.now(), event: "mcp.handshake.start", agent: slot.agent })}\n`);
            const initialized = await peer.request(writer, "initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "aiboard-runner-v2", version: "2" } }, timeoutMs, owner.context.signal);
            if (!initialized || typeof initialized !== "object") throw new McpSessionError("mcp_schema_changed", "MCP initialize response is invalid.");
            await peer.notify(writer, "notifications/initialized", {}, timeoutMs);
            const listed = await peer.request(writer, "tools/list", {}, timeoutMs, owner.context.signal);
            const tools = parseMcpToolList(listed);
            if (canonicalMcpDigest(tools) !== server.discovered!.schemaDigest) throw new McpSessionError("mcp_schema_changed", "MCP schema changed between discovery and live handshake.");
            return canonicalMcpDigest({ initialized, tools });
          },
        });
        if (process.env.TASK12_MCP_TRACE === "1") process.stderr.write(`${JSON.stringify({ t: Date.now(), event: "mcp.open.done", agent: slot.agent })}\n`);
        slot.transport = transport;
        if (slot.closed || this.closed || owner.context.signal?.aborted) throw new McpProtocolError("mcp_request_cancelled", "MCP owner closed during live acquisition.", "outcome_unknown");
        if (peer.error) throw peer.error;
      }
      if (!slot.transport.request) throw new McpSessionError("mcp_authority_required", "MCP transport lacks exact session-request authorization.");
      if (process.env.TASK12_MCP_TRACE === "1") process.stderr.write(`${JSON.stringify({ t: Date.now(), event: "mcp.tools_call.start", agent: slot.agent, timeoutMs })}\n`);
      const result = await slot.transport.request(owner,
        (writer) => slot.peer!.request(writer, "tools/call", { name, arguments: args }, timeoutMs, owner.context.signal), timeoutMs);
      if (!result || typeof result !== "object" || Array.isArray(result)) throw new McpProtocolError("mcp_protocol_invalid", "MCP tools/call result is invalid.", "outcome_unknown");
      server.status = "ready"; server.error = undefined;
      return result as McpCallResult;
    } catch (cause) {
      // The shared runtime may observe session loss before the JSON-RPC pump.
      // Close the pending peer with that cause so its write/response state, not
      // an error-string match, supplies the external call's truthful outcome.
      let primary = cause;
      if (!(cause instanceof McpProtocolError) && !(cause instanceof McpSessionError) && slot.peer) {
        slot.peer.close(cause);
        primary = slot.peer.error!;
      }
      server.status = "error"; server.error = asError(primary).message;
      if (primary instanceof McpProtocolError && primary.code === "mcp_remote_error" && slot.peer?.idle) throw primary;
      if (primary instanceof McpSessionError && ["mcp_schema_changed", "mcp_attestation_mismatch"].includes(primary.code) ||
          primary instanceof McpProtocolError && primary.code === "mcp_schema_changed") this.invalidateServer(server, slot);
      try {
        const cleanup = await Promise.allSettled([this.retire(slot),
          ...(server.invalidationOrigin === slot && server.invalidation ? [server.invalidation] : [])]);
        const failures = cleanup.flatMap((entry) => entry.status === "rejected" ? [entry.reason as unknown] : []);
        if (failures.length) throw new AggregateError(failures, "MCP invalidated ownership cleanup is unverified.");
      }
      catch (cleanup) {
        server.error = "MCP transport failed; owned cleanup remains unverified.";
        throw new AggregateError([primary, cleanup], "MCP request failed with unverified owned cleanup.");
      }
      throw primary;
    }
  }

  private invalidateServer(server: ConfiguredServer, origin?: Slot): void {
    if (server.invalidation) return;
    // Revoke publication synchronously. Only the originating request joins the
    // siblings, avoiding mutual waits when two agents detect replacement at once.
    server.available = false;
    server.invalidationOrigin = origin;
    server.invalidation = this.closeSlots([...this.slots.values()].filter((slot) => slot.server === server && slot !== origin));
    void server.invalidation.catch(() => { server.error = "MCP replacement cleanup remains unverified."; });
  }

  private retire(slot: Slot): Promise<void> {
    if (slot.closing) return slot.closing;
    const transport = slot.transport;
    if (!transport) return Promise.resolve();
    const closing = (async () => {
      await transport.closeVerified();
      if (slot.transport === transport) { slot.transport = undefined; slot.peer?.close(); slot.peer = undefined; }
    })();
    slot.closing = closing;
    void closing.finally(() => { if (slot.closing === closing) slot.closing = undefined; }).catch(() => undefined);
    return closing;
  }

  async closeAgent(owner: Pick<ToolExecutionContext, "runId" | "sessionId" | "actor">): Promise<void> {
    if (owner.runId !== this.options.runId) throw new McpSessionError("mcp_authority_required", "MCP agent termination belongs to a different run.");
    const agent = JSON.stringify([owner.runId, owner.actor.role, owner.actor.id, owner.sessionId]);
    if (this.agentEpochs.has(agent)) this.agentEpochs.set(agent, Symbol("MCP resumed agent epoch"));
    await this.closeSlots([...this.slots.values()].filter((slot) => slot.agent === agent));
  }

  async close(): Promise<void> {
    if (this.closePromise) return await this.closePromise;
    this.closed = true;
    const attempt = this.closeSlots([...this.slots.values()]).then(() => {
      for (const server of this.configured) { server.status = "stopped"; server.error = undefined; }
    });
    this.closePromise = attempt;
    try { await attempt; } finally { if (this.closePromise === attempt) this.closePromise = undefined; }
  }
  private async closeSlots(slots: readonly Slot[]): Promise<void> {
    const results = await Promise.allSettled(slots.map(async (slot) => {
      slot.closed = true; slot.controller?.abort(); slot.peer?.close(new Error("MCP owning agent/run terminated."));
      await slot.tail;
      await this.retire(slot);
      if (this.slots.get(slot.key) === slot) this.slots.delete(slot.key);
    }));
    const errors = results.flatMap((entry) => entry.status === "rejected" ? [entry.reason as unknown] : []);
    if (errors.length) throw new AggregateError(errors, "MCP manager cleanup could not be verified.");
  }
}
function bound(value: number, minimum: number, maximum: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new Error(`MCP ${label} bound is invalid.`);
  return value;
}
function asError(value: unknown): Error { return value instanceof Error ? value : new Error(String(value)); }


/** Pure path/hash checks cannot acquire process authority after their caller
 * leaves. Their late result is observed but discarded, never adopted or replayed.
 */
async function abortable<T>(perform: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  const cancelled = () => new McpProtocolError("mcp_request_cancelled", "MCP preparation was cancelled before a live effect.", "not_sent");
  if (signal?.aborted) throw cancelled();
  let listener: (() => void) | undefined;
  const work = Promise.resolve().then(perform);
  try {
    return await Promise.race([work, new Promise<never>((_resolve, reject) => {
      if (signal) { listener = () => reject(cancelled()); signal.addEventListener("abort", listener, { once: true }); }
    })]);
  } finally { if (listener) signal?.removeEventListener("abort", listener); }
}
