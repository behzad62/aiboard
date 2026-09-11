import { createHash, randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";

import type { PermissionProfile } from "./contracts.js";
import type { ExecutionGrantBinding } from "./execution-grants.js";
import type { ExecutionHostRunBinding } from "./execution-host.js";
import type { ExecutionHostStreamingHandshakeChannel } from "./execution-host-streaming.js";
import type {
  McpOwnedTransport,
  McpTransportFactory,
  McpTransportOpenRequest,
} from "./mcp-tools.js";
import type { McpRuntimeServerLaunch } from "./runner-internal-execution-context.js";
import type { OperationAuthorizationAssertion } from "./session-authority.js";

const MCP_OPERATION_ACCESS = Object.freeze([]);
const MCP_WRITE_TIMEOUT_MS = 30_000;
const MCP_CLEANUP_TIMEOUT_MS = 30_000;

type StreamingFacade = Awaited<ReturnType<ExecutionHostRunBinding["openStreaming"]>>;

/**
 * Binds the existing public MCP line protocol to one run's durable streaming
 * authority. It owns only processes launched from the exact static
 * attestation; it never scans for or adopts a similar host process.
 */
export function createExecutionHostMcpTransportFactory(options: {
  readonly run: ExecutionHostRunBinding;
  readonly permissionProfile: PermissionProfile;
  readonly projectDirectory: string;
  readonly launches: readonly McpRuntimeServerLaunch[];
}): McpTransportFactory {
  const launches = new Map(options.launches.map((launch) => [launch.name, launch]));
  if (launches.size !== options.launches.length) {
    throw new Error("MCP runtime launch descriptors contain duplicate names.");
  }

  return Object.freeze({
    async open(request: McpTransportOpenRequest): Promise<McpOwnedTransport> {
      const launch = launches.get(request.server.name);
      if (!launch || launch.command !== request.server.command) {
        throw new Error(`MCP server ${request.server.name} lacks exact runtime attestation.`);
      }
      const projectDirectory = await realpath(options.projectDirectory);
      const identity = createHash("sha256")
        .update(`${options.run.runId}\0${launch.name}\0${randomUUID()}`)
        .digest("hex");
      const agentSessionId = `mcp-agent-${identity.slice(0, 32)}`;
      const streamingSessionId = `mcp-stream-${identity}`;
      const launchId = `mcp-launch-${identity}`;
      const actor = Object.freeze({
        role: "runner_internal" as const,
        id: `mcp:${launch.name}`,
      });
      const launchBinding: ExecutionGrantBinding = Object.freeze({
        runId: options.run.runId,
        sessionId: agentSessionId,
        actor,
        toolName: "mcp.transport.open",
        callId: launchId,
        permissionProfile: options.permissionProfile,
      });
      const envelope = Object.freeze({
        access: Object.freeze([{ canonicalPath: projectDirectory, mode: "write" as const }]),
        credentialNames: Object.freeze([]),
        networkApproved: true,
        externalApproved: false,
        destructiveApproved: false,
      });
      const grant = await options.run.executionGrants.issue({
        ...launchBinding,
        workspacePath: projectDirectory,
        access: [{ path: projectDirectory, mode: "write" }],
        externalApproved: false,
        destructiveApproved: false,
        networkApproved: true,
      });
      const facade = await options.run.openStreaming({
        sessionId: streamingSessionId,
        launchId,
        grant,
        binding: launchBinding,
        intent: Object.freeze({
          invocationId: launchId,
          runId: options.run.runId,
          sessionId: agentSessionId,
          kind: "mcp_server" as const,
          executable: launch.executablePath,
          arguments: Object.freeze([...launch.arguments]),
          workingDirectory: projectDirectory,
          requestedCapabilities: Object.freeze([
            "tree_termination" as const,
            "verified_emptiness" as const,
          ]),
        }),
        ...(launch.imageExecutable
          ? { imageExecutable: launch.imageExecutable }
          : {}),
        protocolStreams: Object.freeze(["stdout" as const]),
        envelope,
        verifyHandshake: async (channel) => await verifyMcpHandshake(channel, request),
      });

      return createLiveTransport({
        run: options.run,
        projectDirectory,
        permissionProfile: options.permissionProfile,
        request,
        facade,
        launchBinding,
        streamingSessionId,
      });
    },
  });
}

/** Clean exact recovered MCP identities before this Build creates new facades. */
export async function cleanupRecoveredMcpTransports(
  run: ExecutionHostRunBinding,
): Promise<void> {
  const failures: unknown[] = [];
  for (const sessionId of run.streamingState.listSessionIds()) {
    const record = run.streamingState.readSession(sessionId);
    if (!record || record.actor.role !== "runner_internal" ||
        record.toolName !== "mcp.transport.open") continue;
    if (record.state === "released") continue;
    try {
      await run.streamingRuntime.cleanupOwnedSession({
        sessionId,
        timeoutMs: MCP_CLEANUP_TIMEOUT_MS,
      });
    } catch (error) { failures.push(error); }
  }
  for (const sessionId of run.streamingState.listSessionIds()) {
    const retained = run.streamingState.readSession(sessionId);
    if (retained && retained.actor.role === "runner_internal" &&
        retained.toolName === "mcp.transport.open" && retained.state !== "released") {
      failures.push(new Error("Recovered MCP ownership remains durably unreleased; replacement is refused."));
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, "Recovered MCP process cleanup could not be verified.");
  }
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

function createLiveTransport(input: {
  readonly run: ExecutionHostRunBinding;
  readonly projectDirectory: string;
  readonly permissionProfile: PermissionProfile;
  readonly request: McpTransportOpenRequest;
  readonly facade: StreamingFacade;
  readonly launchBinding: ExecutionGrantBinding;
  readonly streamingSessionId: string;
}): McpOwnedTransport {
  let closing = false;
  let closeComplete = false;
  let closePromise: Promise<void> | undefined;
  let operationSequence = 0;
  const outputAbort = new AbortController();

  const authorize = async (operation: "write" | "family_delivery") => {
    const base = Object.freeze({
      sessionId: input.streamingSessionId,
      operation,
      requestAccess: MCP_OPERATION_ACCESS,
      credentialNames: Object.freeze([]),
      networkApproved: false,
      externalApproved: false,
      destructiveApproved: false,
    });
    const binding: ExecutionGrantBinding = Object.freeze({
      ...input.launchBinding,
      toolName: `mcp.transport.${operation}`,
      callId: `mcp-operation-${operation}-${++operationSequence}-${randomUUID()}`,
    });
    const grant = await input.run.executionGrants.issue({
      ...binding,
      workspacePath: input.projectDirectory,
      access: [],
      externalApproved: false,
      destructiveApproved: false,
      networkApproved: false,
    });
    const operationRequest = Object.freeze({ ...base, grant, binding });
    return Object.freeze({
      authorization: input.facade.authorizeOperation(operationRequest),
      assertion: Object.freeze({ ...base, binding }),
    });
  };

  const outputPump = (async () => {
    for (;;) {
      if (closing) return;
      const available = await input.facade.waitForOutput(outputAbort.signal);
      // An aborted wait may still report an already-pending frame. Shutdown
      // owns that retained suffix through exact cleanup; do not require an
      // idle observation before force-capable cleanup can begin.
      if (closing) return;
      if (!available) {
        throw new Error("MCP transport process exited after becoming ready.");
      }
      const operation = await authorize("family_delivery");
      await input.facade.deliverOutput(
        operation.authorization,
        operation.assertion as OperationAuthorizationAssertion,
        async (stream, bytes) => {
          await input.request.onOutput(stream, new Uint8Array(bytes));
        },
      );
    }
  })();
  void outputPump.catch((error) => {
    if (!closing) input.request.onFailure(asError(error));
  });

  const transport: McpOwnedTransport = Object.freeze({
    async write(payload: Uint8Array, timeoutMs: number) {
      if (closing || closeComplete) throw new Error("MCP transport is closing.");
      const operation = await authorize("write");
      await input.facade.write(
        operation.authorization,
        operation.assertion as OperationAuthorizationAssertion,
        new Uint8Array(payload),
        Number.isSafeInteger(timeoutMs) && timeoutMs > 0
          ? timeoutMs
          : MCP_WRITE_TIMEOUT_MS,
      );
    },
    async closeVerified() {
      if (closeComplete) return;
      if (closePromise) return await closePromise;
      closing = true;
      outputAbort.abort();
      const attempt = (async () => {
        await outputPump.catch(() => undefined);
        await input.run.streamingRuntime.cleanupOwnedSession({
          sessionId: input.streamingSessionId,
          timeoutMs: MCP_CLEANUP_TIMEOUT_MS,
        });
        const record = input.run.streamingState.readSession(input.streamingSessionId);
        if (record?.state !== "released") {
          throw new Error("MCP transport process cleanup is not durably released.");
        }
        closeComplete = true;
      })();
      closePromise = attempt;
      try {
        await attempt;
      } finally {
        if (closePromise === attempt) closePromise = undefined;
      }
    },
  });
  return transport;
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
