import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createOpenRouterApplyPatchTool } from "../src/openrouter-apply-patch-tool.js";
import { ToolBroker } from "../src/tool-broker.js";

function context(workspacePath: string) {
  return {
    runId: "run_1",
    sessionId: "session_1",
    actor: { role: "worker" as const, id: "worker_1" },
    workspacePath,
  };
}

function call(callId: string, operation: Record<string, unknown>) {
  return {
    type: "tool_call" as const,
    callId,
    name: "openrouter.apply_patch",
    arguments: { status: "completed", operation },
  };
}

test("OpenRouter apply_patch executes create update and delete operations inside the workspace", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-openrouter-patch-"));
  mkdirSync(join(root, "src"));
  const broker = new ToolBroker({ permissionProfile: "project", workspacePath: root });
  broker.register(createOpenRouterApplyPatchTool());
  try {
    assert.equal(
      broker.definitions().some((definition) => definition.name === "openrouter.apply_patch"),
      false,
      "hosted apply_patch executor must not be advertised as a local function tool"
    );
    const created = await broker.invoke(
      call("create_1", {
        type: "create_file",
        path: "/src/example.txt",
        diff: "+alpha\n+beta\n",
      }),
      context(root)
    );
    assert.equal(created.isError, false);
    assert.equal(readFileSync(join(root, "src/example.txt"), "utf8"), "alpha\nbeta\n");

    const updated = await broker.invoke(
      call("update_1", {
        type: "update_file",
        path: "/src/example.txt",
        diff: "@@\n alpha\n-beta\n+gamma\n",
      }),
      context(root)
    );
    assert.equal(updated.isError, false);
    assert.equal(readFileSync(join(root, "src/example.txt"), "utf8"), "alpha\ngamma\n");

    const deleted = await broker.invoke(
      call("delete_1", { type: "delete_file", path: "/src/example.txt" }),
      context(root)
    );
    assert.equal(deleted.isError, false);
    assert.equal(existsSync(join(root, "src/example.txt")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("OpenRouter apply_patch applies multiple context-anchored update hunks", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-openrouter-patch-hunks-"));
  const path = join(root, "code.ts");
  writeFileSync(path, "function one() {\n  return 1;\n}\n\nfunction two() {\n  return 2;\n}\n");
  const broker = new ToolBroker({ permissionProfile: "project", workspacePath: root });
  broker.register(createOpenRouterApplyPatchTool());
  try {
    const result = await broker.invoke(
      call("update_hunks", {
        type: "update_file",
        path: "code.ts",
        diff:
          "@@ function one() {\n function one() {\n-  return 1;\n+  return 10;\n }\n@@ function two() {\n function two() {\n-  return 2;\n+  return 20;\n }\n",
      }),
      context(root)
    );
    assert.equal(result.isError, false);
    assert.equal(
      readFileSync(path, "utf8"),
      "function one() {\n  return 10;\n}\n\nfunction two() {\n  return 20;\n}\n"
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("OpenRouter apply_patch rejects traversal and protected paths", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-openrouter-patch-policy-"));
  const outside = join(root, "..", "outside.txt");
  writeFileSync(join(root, "protected.txt"), "keep\n");
  const broker = new ToolBroker({ permissionProfile: "full", workspacePath: root });
  broker.register(createOpenRouterApplyPatchTool({ protectedPaths: ["protected.txt"] }));
  try {
    const traversal = await broker.invoke(
      call("outside_1", {
        type: "create_file",
        path: "../outside.txt",
        diff: "+nope\n",
      }),
      context(root)
    );
    assert.equal(traversal.isError, true);
    assert.equal(existsSync(outside), false);

    const protectedResult = await broker.invoke(
      call("protected_1", {
        type: "update_file",
        path: "protected.txt",
        diff: "@@\n-keep\n+changed\n",
      }),
      context(root)
    );
    assert.equal(protectedResult.isError, true);
    assert.equal(readFileSync(join(root, "protected.txt"), "utf8"), "keep\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
