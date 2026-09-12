import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ToolBroker } from "../src/tool-broker.js";
import { ArtifactStore } from "../src/artifact-store.js";
import { createExecutionGrantAuthority } from "../src/execution-grants.js";

for (const access of [[], [{ path: ".", access: "read" as const }]]) test(`MCP ToolBroker retains explicit configured path envelope ${JSON.stringify(access)}`, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "p682-broker-")); t.diagnostic(`exact synthetic MCP broker root acquired: ${root}`);
  const authority = createExecutionGrantAuthority(); let passed = false;
  try {
    const broker = new ToolBroker({ permissionProfile: "full", workspacePath: root, artifacts: new ArtifactStore(join(root, "artifacts")), executionGrants: authority });
    broker.register({ definition: { name: "mcp.docs.lookup", description: "controlled envelope check", inputSchema: { type: "object" }, readOnly: false, effect: "external" },
      validate: (input) => ({ ok: true, value: input }), assessAccess: () => ({ capability: "mcp.docs.lookup", paths: access, network: false, destructive: false, external: true }),
      execute: async (_input, context) => {
        const claims = authority.consume(context.executionGrant!, { ...context, callId: context.callId!, toolName: context.toolName!, permissionProfile: "full" });
        assert.deepEqual(claims.access, access.length ? [{ canonicalPath: root, mode: "read" }] : [], "explicit empty configuration must not become workspace write authority");
        assert.equal(claims.networkApproved, false);
        return { content: [{ type: "text", text: "exact" }], isError: false };
      } });
    const result = await broker.invoke({ type: "tool_call", callId: "exact-call", name: "mcp.docs.lookup", arguments: {} },
      { runId: "run", sessionId: "agent", actor: { role: "worker", id: "worker" }, workspacePath: root });
    assert.equal(result.isError, false); assert.deepEqual(authority.activeSnapshots(), []); passed = true;
  } finally { await authority.revokeAll("cleanup"); if (passed) { await rm(root, { recursive: true }); t.diagnostic(`synthetic broker root removed: ${root}`); } }
});
