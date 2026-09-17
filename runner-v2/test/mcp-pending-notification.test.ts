import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createExecutionHostMcpTransportFactory } from "../src/execution-host-mcp-transport.js";
import type { ExecutionHostRunBinding } from "../src/execution-host.js";
import { mcpConfigurationDigest } from "../src/mcp-configuration.js";
import { McpProtocolError, McpRpcPeer } from "../src/mcp-rpc-peer.js";
import type { McpRequestOwner } from "../src/mcp-tools.js";
import type { OpaqueExecutionGrant } from "../src/execution-grants.js";
import type { StreamingRequestChannel } from "../src/streaming-request-operation.js";

test("MCP processes an already pending schema invalidation before writing another external request", async () => {
  const server = { name: "docs", command: `"${process.execPath}"` };
  const configDigest = mcpConfigurationDigest(server);
  const executableDigest = createHash("sha256").update(await readFile(process.execPath)).digest("hex");
  const peer = new McpRpcPeer(); let pending = true; let writes = 0; let released = false;
  const owner: McpRequestOwner = { context: { runId: "pending-run", sessionId: "agent", actor: { role: "worker", id: "worker" },
    callId: "call", toolName: "mcp.docs.lookup", executionGrant: {} as OpaqueExecutionGrant },
    envelope: { access: [], credentialNames: [], networkApproved: false, externalApproved: false, destructiveApproved: false } };
  const wait = async (signal?: AbortSignal): Promise<boolean> => {
    if (pending) return true;
    if (signal?.aborted) return false;
    return await new Promise<boolean>((resolve) => signal?.addEventListener("abort", () => resolve(false), { once: true }));
  };
  const facade = {
    authorizeFirstOperation: () => ({}),
    request: async (_authorization: unknown, _assertion: unknown, perform: (io: StreamingRequestChannel) => Promise<unknown>) => perform({
      write: async () => { writes++; }, waitForOutput: wait,
      deliverOutput: async (deliver) => { pending = false; await deliver("stdout", Buffer.from('{"jsonrpc":"2.0","method":"notifications/tools/list_changed"}\n')); return true; },
    }),
    waitForOutput: wait,
  };
  const run = { runId: owner.context.runId, openStreaming: async () => facade,
    streamingRuntime: { cleanupOwnedSession: async () => { released = true; } },
    streamingState: { readSession: () => ({ state: released ? "released" : "active" }) },
  } as unknown as ExecutionHostRunBinding;
  const transport = await createExecutionHostMcpTransportFactory({ run, permissionProfile: "full", projectDirectory: process.cwd(),
    launches: [{ ...server, configDigest, executableDigest, executablePath: process.execPath, arguments: [], envelope: { paths: [], network: false, credentialNames: [] } }],
  }).open({ server, owner, expected: { name: "docs", configDigest, executableDigest, status: "ready", tools: [], cleanupVerified: true },
    handshake: async () => "a".repeat(64), onOutput: (stream, bytes) => peer.feed(stream, bytes), onFailure: (error) => peer.close(error) });
  try {
    await assert.rejects(transport.request!(owner, async (writer) => {
      if (peer.error) throw peer.error;
      await writer.write(Buffer.from('{"jsonrpc":"2.0","id":1,"method":"tools/call"}\n'), 100);
    }, 100), (error: unknown) => error instanceof McpProtocolError && error.code === "mcp_schema_changed");
    assert.equal(writes, 0, "pending schema replacement must be handled before an external write");
  } finally { pending = false; await transport.closeVerified(); }
  assert.equal(released, true);
});

test("MCP refuses a new request when an earlier incomplete notification prevents proof of protocol idleness", async () => {
  const peer = new McpRpcPeer(); let writes = 0;
  peer.feed("stdout", Buffer.from('{"jsonrpc":"2.0","method":"notifications/'));
  try {
    await assert.rejects(peer.request({ write: async () => { writes++; } }, "tools/call", {}, 20),
      (error: unknown) => error instanceof McpProtocolError && error.code === "mcp_protocol_invalid" && error.outcome === "not_sent");
    assert.equal(writes, 0);
  } finally { peer.close(); }
});
