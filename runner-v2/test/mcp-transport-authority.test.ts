import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { OpaqueExecutionGrant } from "../src/execution-grants.js";
import assert from "node:assert/strict";
import test from "node:test";
import { createExecutionHostMcpTransportFactory } from "../src/execution-host-mcp-transport.js";
import type { ExecutionHostRunBinding } from "../src/execution-host.js";
import { mcpConfigurationDigest } from "../src/mcp-configuration.js";

for (const label of ["absent", "foreign-run", "missing-grant"] as const) test(`MCP transport refuses ${label} actual-call authority before grants or launch`, async () => {
  const server = { name: "docs", command: `"${process.execPath}"` };
  let issued = 0; let launched = 0;
  const run = { runId: "actual-run", executionGrants: { issue: async () => { issued++; throw new Error("must not mint transport authority"); } },
    openStreaming: async () => { launched++; throw new Error("must not launch"); } } as unknown as ExecutionHostRunBinding;
  const factory = createExecutionHostMcpTransportFactory({ run, projectDirectory: process.cwd(), permissionProfile: "full",
    launches: [{ ...server, executablePath: process.execPath, arguments: [], configDigest: mcpConfigurationDigest(server), executableDigest: "a".repeat(64), envelope: { paths: [], network: false, credentialNames: [] } }] });
  await assert.rejects(factory.open({ server, handshake: async () => "a".repeat(64), onOutput: () => undefined, onFailure: () => undefined,
    ...(label === "absent" ? {} : { owner: { context: { runId: label === "foreign-run" ? "foreign" : run.runId, sessionId: "agent", actor: { role: "worker" as const, id: "worker" }, callId: "actual-call", toolName: "mcp.docs.lookup" },
      envelope: { access: [], credentialNames: [], networkApproved: false, externalApproved: false, destructiveApproved: false } } })
  }), /authority|grant|context|run/i);
  assert.equal(issued, 0); assert.equal(launched, 0);
});


test("MCP transport retains portable lifecycle capabilities instead of requiring the optional Windows Job enhancement", async () => {
  const server = { name: "docs", command: `"${process.execPath}"` };
  const configDigest = mcpConfigurationDigest(server); const executableDigest = createHash("sha256").update(await readFile(process.execPath)).digest("hex");
  let observed = false;
  const stop = new Error("controlled before-runtime invocation boundary");
  const run = { runId: "actual-run", openStreaming: async (request: { intent: { requestedCapabilities: readonly string[] } }) => {
    assert.deepEqual(request.intent.requestedCapabilities, ["tree_termination", "verified_emptiness"]);
    observed = true; throw stop;
  } } as unknown as ExecutionHostRunBinding;
  const factory = createExecutionHostMcpTransportFactory({ run, projectDirectory: process.cwd(), permissionProfile: "full",
    launches: [{ ...server, executablePath: process.execPath, arguments: [], configDigest, executableDigest, envelope: { paths: [], network: false, credentialNames: [] } }] });
  await assert.rejects(factory.open({ server, expected: { name: "docs", configDigest, executableDigest, tools: [], status: "ready", cleanupVerified: true },
    owner: { context: { runId: run.runId, sessionId: "agent", actor: { role: "worker", id: "worker" }, callId: "call", toolName: "mcp.docs.lookup", executionGrant: {} as OpaqueExecutionGrant },
      envelope: { access: [], credentialNames: [], networkApproved: false, externalApproved: false, destructiveApproved: false } },
    handshake: async () => assert.fail("no backend is being launched"), onOutput: () => undefined, onFailure: () => undefined }),
    (error: unknown) => error === stop);
  assert.equal(observed, true);
});
