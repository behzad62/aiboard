import { hashExecutableDescriptor } from "./mcp-executable-digest.js";
import {
  freezeExecutionLifecycleRequirements,
  lifecycleRequirementsDigest,
  resolveRequiredLifecycleScope,
} from "./execution-lifecycle-policy.js";
import { createHash, randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import type { PermissionProfile } from "./contracts.js";
import { AUTHORIZED_STOP_CLEANUP_TIMEOUT_MS } from "./cleanup-timeouts.js";
import type { ExecutionGrantBinding } from "./execution-grants.js";
import type { ExecutionHostRunBinding } from "./execution-host.js";
import type { ExecutionHostStreamingHandshakeChannel } from "./execution-host-streaming.js";
import type { McpOwnedTransport, McpTransportFactory, McpTransportOpenRequest, McpRequestOwner, McpTransportWriter } from "./mcp-tools.js";
import type { McpRuntimeServerLaunch } from "./runner-internal-execution-context.js";
import { canonicalMcpDigest, mcpConfigurationDigest } from "./mcp-configuration.js";
import { McpSessionError } from "./mcp-session-manager.js";
import { McpProtocolError } from "./mcp-rpc-peer.js";
import type { StreamingRequestChannel } from "./streaming-request-operation.js";
import type { StreamingSessionRecord } from "./streaming-session-store.js";

const MCP_CLEANUP_TIMEOUT_MS = AUTHORIZED_STOP_CLEANUP_TIMEOUT_MS;
type StreamingFacade = Awaited<ReturnType<ExecutionHostRunBinding["openStreaming"]>>;

/** Exact per-call host adapter. It never issues an execution grant or invents an
 * actor. The first request uses the original launch claims once; subsequent
 * requests consume the fresh actual ToolBroker grant through SessionAuthority.
 */
export function createExecutionHostMcpTransportFactory(options: {
  readonly run: ExecutionHostRunBinding;
  readonly permissionProfile: PermissionProfile;
  readonly projectDirectory: string;
  readonly launches: readonly McpRuntimeServerLaunch[];
}): McpTransportFactory {
  const launches = new Map(options.launches.map((launch) => [launch.name, launch]));
  if (launches.size !== options.launches.length) throw new Error("MCP runtime launch descriptors contain duplicate names.");
  return Object.freeze({
    async open(request: McpTransportOpenRequest): Promise<McpOwnedTransport> {
      const owner = request.owner;
      if (!owner?.context.executionGrant || owner.context.runId !== options.run.runId || !owner.context.sessionId ||
          !owner.context.actor?.id || !owner.context.callId || !owner.context.toolName?.startsWith("mcp."))
        throw new McpSessionError("mcp_authority_required", "MCP live launch requires the exact current run/call grant authority.");
      const launch = launches.get(request.server.name);
      const lifecycleRequirements = freezeExecutionLifecycleRequirements(launch?.lifecycleRequirements);
      const expectedLifecycleDigest = lifecycleRequirementsDigest(lifecycleRequirements);
      if (!launch || launch.command !== request.server.command || launch.configDigest !== mcpConfigurationDigest(request.server) ||
          request.expected?.configDigest !== launch.configDigest || request.expected?.executableDigest !== launch.executableDigest ||
          (launch.lifecycleRequirementsDigest ?? lifecycleRequirementsDigest(undefined)) !== expectedLifecycleDigest)
        throw new McpSessionError("mcp_attestation_mismatch", "MCP server lacks its exact discovered runtime attestation.");
      const executable = await realpath(launch.executablePath);
      if (executable !== launch.executablePath || await hashExecutableDescriptor(executable) !== launch.executableDigest)
        throw new McpSessionError("mcp_attestation_mismatch", "MCP executable identity changed before live launch.");
      const projectDirectory = await realpath(options.projectDirectory);
      const identity = createHash("sha256").update(`${options.run.runId}\0${launch.name}\0${owner.context.sessionId}\0${randomUUID()}`).digest("hex");
      const sessionId = `mcp-stream-${identity}`;
      const launchId = `mcp-launch-${identity}`;
      const binding = bindingFor(owner, options.permissionProfile);
      const facade = await options.run.openStreaming({
        sessionId, launchId, grant: owner.context.executionGrant, binding, envelope: owner.envelope,
        ...(owner.context.signal ? { signal: owner.context.signal } : {}), protocolStreams: ["stdout"],
        ...(launch.imageExecutable ? { imageExecutable: launch.imageExecutable } : {}),
        intent: { invocationId: launchId, runId: options.run.runId, sessionId: owner.context.sessionId,
          kind: "mcp_server", executable: launch.executablePath, arguments: launch.arguments, workingDirectory: projectDirectory,
          requiredLifecycleScope: resolveRequiredLifecycleScope({
            permissionProfile: options.permissionProfile,
            lifecycleRequirements,
          }), requestedCapabilities: [] },
        verifyHandshake: (channel) => verifyMcpHandshake(channel, request),
      });
      return liveTransport({ run: options.run, facade, request, firstOwner: owner, binding, sessionId, permissionProfile: options.permissionProfile });
    },
  });
}

/** Authenticated durable state is the only recovery source. No process search,
 * similar-PID adoption, autonomous launch or replacement grant is permitted. */
export async function cleanupRecoveredMcpTransports(run: ExecutionHostRunBinding): Promise<void> {
  const isMcp = (record: Readonly<StreamingSessionRecord> | undefined) => record && record.runId === run.runId &&
    (record.actor.role === "runner_internal" && record.toolName === "mcp.transport.open" ||
      record.sessionId.startsWith("mcp-stream-") && record.toolName.startsWith("mcp."));
  const failures: unknown[] = [];
  for (const sessionId of run.streamingState.listSessionIds()) {
    const record = run.streamingState.readSession(sessionId);
    if (!isMcp(record) || record!.state === "released") continue;
    try { await run.streamingRuntime.cleanupOwnedSession({ sessionId, timeoutMs: MCP_CLEANUP_TIMEOUT_MS }); }
    catch (error) { failures.push(error); }
  }
  for (const sessionId of run.streamingState.listSessionIds()) {
    const record = run.streamingState.readSession(sessionId);
    if (isMcp(record) && record!.state !== "released") failures.push(new Error("Recovered MCP ownership remains durably unreleased; replacement is refused."));
  }
  if (failures.length) throw new AggregateError(failures, "Recovered MCP process cleanup could not be verified.");
}

async function verifyMcpHandshake(
  channel: ExecutionHostStreamingHandshakeChannel,
  request: McpTransportOpenRequest,
): Promise<string> {
  const controller = new AbortController();
  const handshake = request.handshake(Object.freeze({
    write: async (payload: Uint8Array, timeoutMs: number) =>
      await channel.write(payload, timeoutMs),
  }));
  void handshake.finally(() => controller.abort()).catch(() => undefined);
  for (;;) {
    const outcome = await Promise.race([
      handshake.then(
        (digest) => ({ kind: "handshake" as const, digest }),
        (error) => ({ kind: "failure" as const, error }),
      ),
      channel.waitForOutput(controller.signal).then((available) => ({
        kind: "output" as const,
        available,
      })),
    ]);
    if (outcome.kind === "handshake") return outcome.digest;
    if (outcome.kind === "failure") throw outcome.error;
    if (!outcome.available) {
      const settled = await handshake.then(
        (digest) => ({ digest }),
        (error) => ({ error }),
      );
      if ("digest" in settled) return settled.digest;
      throw settled.error;
    }
    await channel.deliverOutput(async (stream, bytes) => {
      await request.onOutput(stream, new Uint8Array(bytes));
    });
  }
}


function bindingFor(owner: McpRequestOwner, permissionProfile: PermissionProfile): ExecutionGrantBinding {
  return Object.freeze({ runId: owner.context.runId, sessionId: owner.context.sessionId, actor: Object.freeze({ ...owner.context.actor }),
    callId: owner.context.callId!, toolName: owner.context.toolName!, permissionProfile });
}
function sameAgent(a: McpRequestOwner, b: McpRequestOwner): boolean {
  return a.context.runId === b.context.runId && a.context.sessionId === b.context.sessionId &&
    a.context.actor.role === b.context.actor.role && a.context.actor.id === b.context.actor.id &&
    canonicalMcpDigest(a.envelope) === canonicalMcpDigest(b.envelope);
}
function liveTransport(input: Readonly<{ run: ExecutionHostRunBinding; facade: StreamingFacade; request: McpTransportOpenRequest;
  firstOwner: McpRequestOwner; binding: ExecutionGrantBinding; sessionId: string; permissionProfile: PermissionProfile }>): McpOwnedTransport {
  let first = true; let closing = false; let closed = false;
  let closePromise: Promise<void> | undefined;
  let activeRequest: Promise<unknown> | undefined;
  let requestAbort: AbortController | undefined;
  let idleAbort: AbortController | undefined; let idleWait: Promise<void> | undefined;
  const observeIdleTermination = () => {
    if (closing) return;
    const control = new AbortController(); idleAbort = control;
    idleWait = input.facade.waitForOutput(control.signal).then((available) => {
      if (!available && !control.signal.aborted && !closing) input.request.onFailure(new McpProtocolError("mcp_transport_unavailable", "MCP server terminated between requests.", "not_sent"));
      // Available bytes remain in the bounded provider window until a fresh
      // authorized request may deliver them; idle observation consumes nothing.
    }).catch((error: unknown) => { if (!control.signal.aborted && !closing) input.request.onFailure(error instanceof Error ? error : new Error(String(error))); });
  };
  return Object.freeze({
    async write(): Promise<void> { throw new McpSessionError("mcp_authority_required", "MCP writes require a current scoped request authorization."); },
    async request<T>(owner: McpRequestOwner, perform: (writer: McpTransportWriter) => Promise<T>, timeoutMs: number): Promise<T> {
      if (closing || closed || !sameAgent(input.firstOwner, owner) || !owner.context.executionGrant)
        throw new McpSessionError("mcp_authority_required", "MCP request does not match its active exact session envelope/owner.");
      if (activeRequest) throw new McpProtocolError("mcp_request_busy", "MCP transport request is already in progress.", "not_sent");
      const grant = owner.context.executionGrant;
      const control = new AbortController(); requestAbort = control;
      const signal = owner.context.signal ? AbortSignal.any([owner.context.signal, control.signal]) : control.signal;
      const operation = (async () => {
        idleAbort?.abort(); await idleWait;
        if (closing || signal.aborted) throw new McpProtocolError("mcp_request_cancelled", "MCP request was closed before authorization.", "not_sent");
        const binding = bindingFor(owner, input.permissionProfile);
        const expected = { sessionId: input.sessionId, operation: "request" as const, requestAccess: owner.envelope.access,
          credentialNames: owner.envelope.credentialNames, networkApproved: owner.envelope.networkApproved,
          externalApproved: owner.envelope.externalApproved, destructiveApproved: owner.envelope.destructiveApproved };
        let authorization;
        if (first) {
          if (grant !== input.firstOwner.context.executionGrant || owner.context.callId !== input.binding.callId || owner.context.toolName !== input.binding.toolName)
            throw new McpSessionError("mcp_authority_required", "The first MCP request must retain its original launching call.");
          authorization = input.facade.authorizeFirstOperation(expected); first = false;
        } else authorization = input.facade.authorizeOperation({ ...expected, binding, grant });
        return await input.facade.request(authorization, { ...expected, binding },
          (io) => performWithOutput(io, perform, input.request, signal), timeoutMs, signal);
      })();
      activeRequest = operation;
      try { return await operation; }
      finally {
        if (activeRequest === operation) activeRequest = undefined;
        if (requestAbort === control) requestAbort = undefined;
        observeIdleTermination();
      }
    },
    async closeVerified() {
      if (closed) return;
      if (closePromise) return await closePromise;
      closing = true; idleAbort?.abort(); requestAbort?.abort();
      const attempt = (async () => {
        await idleWait;
        // The active request may be rejected by cancellation, but its current
        // coherent delivery must settle before we move into owned cleanup.
        if (activeRequest) await Promise.allSettled([activeRequest]);
        await input.run.streamingRuntime.cleanupOwnedSession({ sessionId: input.sessionId, timeoutMs: MCP_CLEANUP_TIMEOUT_MS, gracefulShutdownMs: 250 });
        if (input.run.streamingState.readSession(input.sessionId)?.state !== "released") throw new Error("MCP transport process cleanup is not durably released.");
        closed = true;
      })();
      closePromise = attempt;
      try { await attempt; } finally { if (closePromise === attempt) closePromise = undefined; }
    },
  });
}
async function performWithOutput<T>(io: StreamingRequestChannel, perform: (writer: McpTransportWriter) => Promise<T>, request: McpTransportOpenRequest, signal: AbortSignal): Promise<T> {
  // Already-buffered notifications belong to this newly authorized request.
  // Process them before writing an external call; do not mint an idle grant.
  const noWait = new AbortController(); noWait.abort();
  while (await io.waitForOutput(noWait.signal)) {
    if (signal.aborted) throw new McpProtocolError("mcp_request_cancelled", "MCP request closed before its write.", "not_sent");
    await io.deliverOutput(async (stream, bytes) => request.onOutput(stream, new Uint8Array(bytes)));
  }
  const finished = new AbortController();
  const operation = perform({ write: (bytes, timeoutMs) => io.write(bytes, timeoutMs) });
  void operation.finally(() => finished.abort()).catch(() => undefined);
  for (;;) {
    if (signal.aborted) throw new McpProtocolError("mcp_request_cancelled", "MCP transport closed during its request; no replay is permitted.", "outcome_unknown");
    const outcome = await Promise.race([
      operation.then((value) => ({ kind: "result" as const, value })),
      io.waitForOutput(AbortSignal.any([finished.signal, signal])).then((available) => ({ kind: "output" as const, available })),
    ]);
    if (outcome.kind === "result") return outcome.value;
    if (!outcome.available) {
      if (finished.signal.aborted) return await operation;
      throw new McpProtocolError("mcp_transport_unavailable", "MCP output became unavailable after the request; outcome is unknown.", "outcome_unknown");
    }
    await io.deliverOutput(async (stream, bytes) => request.onOutput(stream, new Uint8Array(bytes)));
  }
}
