import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { NativeTool } from "../src/agent-contracts.js";
import { ArtifactStore } from "../src/artifact-store.js";
import { SqlitePermissionStore } from "../src/permission-store.js";
import { SqliteToolLedger } from "../src/sqlite-tool-ledger.js";
import { ToolBroker } from "../src/tool-broker.js";

test("permission requests and decisions are durable, idempotent, and wake waiters", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-permissions-"));
  const path = join(root, "permissions.sqlite");
  let store = new SqlitePermissionStore(path);
  try {
    store.request({
      requestId: "perm_1",
      runId: "run_1",
      sessionId: "session_1",
      callId: "call_1",
      toolName: "deploy.release",
      actor: { role: "worker", id: "worker_1" },
      permissionProfile: "project",
      access: { capability: "deploy.release", external: true },
      outsideWorkspace: false,
      occurredAt: "2026-01-01T00:00:00.000Z",
    });
    assert.equal(store.list("run_1")[0].status, "pending");
    store.close();
    store = new SqlitePermissionStore(path);
    const recovered = store.list("run_1")[0];
    assert.equal(recovered.requestId, "perm_1");
    assert.equal(recovered.status, "pending");
    const pending = store.request({
      requestId: "perm_1",
      runId: "run_1",
      sessionId: "session_1",
      callId: "call_1",
      toolName: "deploy.release",
      actor: { role: "worker", id: "worker_1" },
      permissionProfile: "project",
      access: { capability: "deploy.release", external: true },
      outsideWorkspace: false,
      occurredAt: "2026-01-01T00:00:30.000Z",
    });
    store.decide({
      requestId: "perm_1",
      decision: "approved",
      idempotencyKey: "approve:perm_1",
      occurredAt: "2026-01-01T00:01:00.000Z",
    });
    assert.equal(await pending, true);
    assert.equal(store.list("run_1")[0].status, "approved");
    assert.equal(store.request({
      requestId: "perm_1",
      runId: "run_1",
      sessionId: "session_1",
      callId: "call_1",
      toolName: "deploy.release",
      actor: { role: "worker", id: "worker_1" },
      permissionProfile: "project",
      access: { capability: "deploy.release", external: true },
      outsideWorkspace: false,
      occurredAt: "2026-01-01T00:02:00.000Z",
    }), true);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("tool approval waits before side-effect ledger start and resumes the exact call", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-permission-broker-"));
  const permissions = new SqlitePermissionStore(join(root, "permissions.sqlite"));
  const ledger = new SqliteToolLedger(join(root, "tools.sqlite"));
  const artifacts = new ArtifactStore(join(root, "artifacts"));
  let executions = 0;
  try {
    const broker = new ToolBroker({
      permissionProfile: "project",
      workspacePath: root,
      artifacts,
      ledger,
      approve: (request) => permissions.requestTool(request),
    });
    broker.register(externalTool(() => { executions += 1; }));
    const context = {
      runId: "run_approval",
      sessionId: "session_approval",
      actor: { role: "worker" as const, id: "worker_1" },
      workspacePath: root,
    };
    const invocation = broker.invoke({
      type: "tool_call",
      callId: "deploy-call",
      name: "deploy.release",
      arguments: { target: "staging" },
    }, context);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const [request] = permissions.list("run_approval");
    assert.equal(request.status, "pending");
    assert.deepEqual(ledger.events("run_approval\0session_approval\0deploy-call"), []);
    assert.equal(executions, 0);
    permissions.decide({
      requestId: request.requestId,
      decision: "approved",
      idempotencyKey: `approve:${request.requestId}`,
      occurredAt: "2026-01-01T00:00:00.000Z",
    });
    const result = await invocation;
    assert.equal(result.isError, false);
    assert.equal(executions, 1);
    assert.equal(ledger.events("run_approval\0session_approval\0deploy-call").at(-1)?.type, "tool.completed");
  } finally {
    permissions.close();
    ledger.close();
    rmSync(root, { recursive: true, force: true });
  }
});

function externalTool(executed: () => void): NativeTool<{ target: string }> {
  return {
    definition: {
      name: "deploy.release",
      description: "Deploy a release",
      inputSchema: {
        type: "object",
        properties: { target: { type: "string" } },
        required: ["target"],
        additionalProperties: false,
      },
      readOnly: false,
      effect: "external",
    },
    validate: (input) =>
      typeof input === "object" && input !== null &&
      typeof (input as { target?: unknown }).target === "string"
        ? { ok: true, value: input as { target: string } }
        : { ok: false, issues: ["target is required"] },
    assessAccess: () => ({ capability: "deploy.release", external: true }),
    execute: async (input) => {
      executed();
      return { content: [{ type: "json", value: input }], isError: false };
    },
  };
}
