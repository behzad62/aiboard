import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ArtifactStore } from "../src/artifact-store.js";
import type {
  NativeTool,
  ToolCallBlock,
  ToolExecutionContext,
} from "../src/agent-contracts.js";
import { ToolBroker } from "../src/tool-broker.js";

test("project profile allows contained writes but blocks traversal and symlink escape", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-broker-paths-"));
  const workspace = join(root, "workspace");
  const outside = join(root, "outside");
  mkdirSync(workspace);
  mkdirSync(outside);
  symlinkSync(outside, join(workspace, "escape"), "junction");
  let executions = 0;
  const broker = new ToolBroker({
    permissionProfile: "project",
    workspacePath: workspace,
  });
  broker.register(pathTool(() => executions++));
  try {
    const inside = await broker.invoke(call("inside", join(workspace, "new.txt")), context());
    assert.equal(inside.isError, false);
    const traversal = await broker.invoke(call("traversal", join(workspace, "..", "outside.txt")), context());
    assert.equal(traversal.error?.code, "approval_required");
    const symlink = await broker.invoke(call("symlink", join(workspace, "escape", "file.txt")), context());
    assert.equal(symlink.error?.code, "approval_required");
    assert.equal(executions, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("guarded approvals and full access follow the configured permission ceiling", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-broker-permission-"));
  const workspace = join(root, "workspace");
  mkdirSync(workspace);
  let executions = 0;
  let approvals = 0;
  const guarded = new ToolBroker({
    permissionProfile: "guarded",
    workspacePath: workspace,
    approve: async (request) => {
      approvals += 1;
      return request.callId === "approved";
    },
  });
  guarded.register(pathTool(() => executions++));
  const denied = await guarded.invoke(call("denied", join(workspace, "a.txt")), context());
  const approved = await guarded.invoke(call("approved", join(workspace, "b.txt")), context());
  assert.equal(denied.error?.code, "permission_denied");
  assert.equal(approved.isError, false);
  assert.equal(approvals, 2);
  assert.equal(executions, 1);

  const full = new ToolBroker({ permissionProfile: "full", workspacePath: workspace });
  full.register(pathTool(() => executions++));
  const outside = await full.invoke(call("full", join(root, "outside.txt")), context());
  assert.equal(outside.isError, false);
  assert.equal(executions, 2);
  assert.equal(Object.isFrozen(full.auditRecords()[0]), true);
  rmSync(root, { recursive: true, force: true });
});

test("project profile never treats an external effect as an ordinary workspace action", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "aiboard-broker-external-"));
  let executions = 0;
  const broker = new ToolBroker({
    permissionProfile: "project",
    workspacePath: workspace,
  });
  broker.register({
    definition: {
      name: "deploy",
      description: "Affect an external system",
      inputSchema: { type: "object" },
      readOnly: false,
      effect: "external",
    },
    validate: () => ({ ok: true, value: {} }),
    execute: async () => {
      executions += 1;
      return { content: [], isError: false };
    },
  });
  try {
    const result = await broker.invoke(
      { type: "tool_call", callId: "deploy_1", name: "deploy", arguments: {} },
      context()
    );
    assert.equal(result.error?.code, "approval_required");
    assert.equal(executions, 0);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("call identity prevents duplicate or conflicting side effects", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "aiboard-broker-idempotency-"));
  let executions = 0;
  const broker = new ToolBroker({ permissionProfile: "project", workspacePath: workspace });
  broker.register(pathTool(() => executions++));
  try {
    const first = await broker.invoke(call("same", join(workspace, "a.txt")), context());
    const repeated = await broker.invoke(call("same", join(workspace, "a.txt")), context());
    const conflict = await broker.invoke(call("same", join(workspace, "b.txt")), context());
    assert.deepEqual(repeated, first);
    assert.equal(conflict.error?.code, "idempotency_conflict");
    assert.equal(executions, 1);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("large outputs become artifacts and timeouts abort the tool", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-broker-output-"));
  const artifacts = new ArtifactStore(join(root, "artifacts"));
  const broker = new ToolBroker({
    permissionProfile: "project",
    workspacePath: root,
    artifacts,
    maxInlineOutputBytes: 16,
    toolTimeoutMs: 30,
  });
  broker.register({
    definition: {
      name: "large_read",
      description: "Return large text",
      inputSchema: { type: "object" },
      readOnly: true,
      effect: "none",
    },
    validate: () => ({ ok: true, value: {} }),
    execute: async () => ({
      content: [
        { type: "json", value: { exitCode: 0 } },
        { type: "text", text: `START-${"x".repeat(88)}-END` },
      ],
      isError: false,
    }),
  });
  let observedAbort = false;
  broker.register({
    definition: {
      name: "slow_read",
      description: "Wait for cancellation",
      inputSchema: { type: "object" },
      readOnly: true,
      effect: "none",
    },
    validate: () => ({ ok: true, value: {} }),
    execute: async (_input, toolContext) =>
      await new Promise((resolve) => {
        toolContext.signal?.addEventListener(
          "abort",
          () => {
            observedAbort = true;
            resolve({ content: [], isError: false });
          },
          { once: true }
        );
      }),
  });
  try {
    const large = await broker.invoke(
      { type: "tool_call", callId: "large", name: "large_read", arguments: {} },
      context()
    );
    const artifact = large.content.find((block) => block.type === "artifact");
    assert.ok(artifact && artifact.type === "artifact");
    assert.equal(
      (await artifacts.get(artifact.hash)).toString(),
      `START-${"x".repeat(88)}-END`
    );
    assert.deepEqual(
      large.content.find((block) => block.type === "json"),
      { type: "json", value: { exitCode: 0 } }
    );
    const preview = large.content.find((block) => block.type === "text");
    assert.ok(preview && preview.type === "text");
    assert.match(preview.text, /START-/);
    assert.match(preview.text, /-END/);
    assert.match(preview.text, /stored as an artifact/i);

    const defaultBroker = new ToolBroker({
      permissionProfile: "project",
      workspacePath: root,
      artifacts,
    });
    defaultBroker.register({
      definition: {
        name: "default_large_read",
        description: "Return output above the default inline budget",
        inputSchema: { type: "object" },
        readOnly: true,
        effect: "none",
      },
      validate: () => ({ ok: true, value: {} }),
      execute: async () => ({
        content: [{ type: "text", text: "y".repeat(9 * 1024) }],
        isError: false,
      }),
    });
    const boundedByDefault = await defaultBroker.invoke(
      {
        type: "tool_call",
        callId: "default-large",
        name: "default_large_read",
        arguments: {},
      },
      context()
    );
    assert.equal(
      boundedByDefault.content.some((block) => block.type === "artifact"),
      true
    );

    const slow = await broker.invoke(
      { type: "tool_call", callId: "slow", name: "slow_read", arguments: {} },
      context()
    );
    assert.equal(slow.error?.code, "tool_timeout");
    assert.equal(observedAbort, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function pathTool(onExecute: () => void): NativeTool<{ path: string }> {
  return {
    definition: {
      name: "write_path",
      description: "Write a path",
      inputSchema: { type: "object" },
      readOnly: false,
      effect: "workspace",
    },
    validate: (input) =>
      typeof input === "object" &&
      input !== null &&
      typeof (input as { path?: unknown }).path === "string"
        ? { ok: true, value: input as { path: string } }
        : { ok: false, issues: ["path required"] },
    assessAccess: (input) => ({
      capability: "filesystem.write",
      paths: [{ path: input.path, access: "write" }],
    }),
    execute: async () => {
      onExecute();
      return { content: [{ type: "text", text: "written" }], isError: false };
    },
  };
}

function call(callId: string, path: string): ToolCallBlock {
  return { type: "tool_call", callId, name: "write_path", arguments: { path } };
}

function context(): ToolExecutionContext {
  return {
    runId: "run_1",
    sessionId: "session_1",
    actor: { role: "worker", id: "worker_1" },
  };
}
