import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ExecutionGrantError, createExecutionGrantAuthority } from "../src/execution-grants.js";
import {
  authorizeFilesystemMutation,
  captureFilesystemMutation,
} from "../src/filesystem-mutation-fence.js";
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
  const broker = new ToolBroker({ permissionProfile: "project", workspacePath: root, approve: async () => true });
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

test("OpenRouter apply_patch revocation at the last mile prevents update", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-openrouter-patch-revoke-"));
  const path = join(root, "value.txt");
  writeFileSync(path, "original\n");
  const authority = createExecutionGrantAuthority();
  const broker = new ToolBroker({ permissionProfile: "full", workspacePath: root, executionGrants: authority });
  const tool = createOpenRouterApplyPatchTool();
  broker.register({
    ...tool,
    execute: async (input, context) => {
      await authority.revokeAll("cancelled");
      return tool.execute(input, context);
    },
  });
  try {
    const result = await broker.invoke(
      call("revoke_1", { type: "update_file", path: "value.txt", diff: "@@\n-original\n+replacement\n" }),
      context(root)
    );
    assert.equal(result.isError, true);
    assert.equal(result.error?.code, "grant_revoked");
    assert.equal(readFileSync(path, "utf8"), "original\n");
  } finally {
    await authority.revokeAll("cleanup");
    rmSync(root, { recursive: true, force: true });
  }
});

test("OpenRouter apply_patch alias swap during approval is refused without effect", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-openrouter-patch-alias-"));
  const target = join(root, "value.txt");
  const real = join(root, "real.txt");
  writeFileSync(target, "original\n");
  writeFileSync(real, "original\n");
  const broker = new ToolBroker({
    permissionProfile: "guarded",
    workspacePath: root,
    approve: async () => {
      rmSync(target);
      symlinkSync(real, target, "file");
      return true;
    },
  });
  broker.register(createOpenRouterApplyPatchTool());
  try {
    const result = await broker.invoke(
      call("alias_1", { type: "update_file", path: "value.txt", diff: "@@\n-original\n+replacement\n" }),
      context(root)
    );
    assert.equal(result.isError, true);
    assert.equal(result.error?.code, "grant_invalid_path");
    assert.equal(lstatSync(target).isSymbolicLink(), true);
    assert.equal(readFileSync(real, "utf8"), "original\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("OpenRouter apply_patch create existing file does not overwrite", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-openrouter-patch-exists-"));
  const path = join(root, "exists.txt");
  writeFileSync(path, "keep\n");
  const broker = new ToolBroker({ permissionProfile: "full", workspacePath: root });
  broker.register(createOpenRouterApplyPatchTool());
  try {
    const result = await broker.invoke(
      call("exists_1", { type: "create_file", path: "exists.txt", diff: "+new\n" }),
      context(root)
    );
    assert.equal(result.isError, true);
    assert.equal(result.error?.code, "file_exists");
    assert.equal(readFileSync(path, "utf8"), "keep\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("OpenRouter apply_patch rejects reserved native extension registration, other extensions unchanged", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-openrouter-patch-spoof-"));
  const broker = new ToolBroker({ permissionProfile: "full", workspacePath: root });
  try {
    assert.throws(
      () => broker.registerExtensionTool("evil", createOpenRouterApplyPatchTool()),
      (error) => error instanceof Error && /reserved native tool/.test(error.message)
    );
    broker.registerExtensionTool("helper", {
      definition: {
        name: "helper.echo",
        description: "Benign extension helper.",
        inputSchema: { type: "object" },
        readOnly: true,
        effect: "none",
      },
      validate: () => ({ ok: true, value: {} }),
      execute: async () => ({ content: [{ type: "text", text: "ok" }], isError: false }),
    });
    const result = await broker.invoke(
      { type: "tool_call", callId: "helper_1", name: "helper.echo", arguments: {} },
      context(root)
    );
    assert.equal(result.isError, false);
    const standalone = await broker.invoke(
      call("spoof_1", { type: "create_file", path: "evil.txt", diff: "+evil\n" }),
      context(root)
    );
    assert.equal(standalone.isError, true);
    assert.equal(standalone.error?.code, "unknown_tool");
    assert.equal(existsSync(join(root, "evil.txt")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("OpenRouter apply_patch rejects reserved native extension execution even if registration is bypassed", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-openrouter-patch-spoofexec-"));
  writeFileSync(join(root, "value.txt"), "original\n");
  const broker = new ToolBroker({ permissionProfile: "full", workspacePath: root });
  const spoof = createOpenRouterApplyPatchTool();
  const backdoor = broker as unknown as {
    registerAttributed(tool: Parameters<ToolBroker["register"]>[0], extensionId?: string): void;
  };
  backdoor.registerAttributed(spoof, "evil");
  try {
    const result = await broker.invoke(
      call("spoofexec_1", { type: "update_file", path: "value.txt", diff: "@@\n-original\n+evil\n" }),
      context(root)
    );
    assert.equal(result.isError, true);
    assert.equal(result.error?.code, "grant_mismatch");
    assert.equal(readFileSync(join(root, "value.txt"), "utf8"), "original\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("OpenRouter apply_patch rejects in-place content change captured before approval", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-openrouter-patch-inplace-"));
  const path = join(root, "value.txt");
  writeFileSync(path, "original\n");
  const broker = new ToolBroker({
    permissionProfile: "guarded",
    workspacePath: root,
    approve: async () => {
      writeFileSync(path, "tampered\n");
      return true;
    },
  });
  broker.register(createOpenRouterApplyPatchTool());
  try {
    const result = await broker.invoke(
      call("inplace_1", { type: "update_file", path: "value.txt", diff: "@@\n-original\n+replacement\n" }),
      context(root)
    );
    assert.equal(result.isError, true);
    assert.equal(result.error?.code, "revision_conflict");
    assert.equal(readFileSync(path, "utf8"), "tampered\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("OpenRouter apply_patch rejects input-swapped operation after capture", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-openrouter-patch-opswap-"));
  const swapped = call("opswap_1", { type: "create_file", path: "new.txt", diff: "+fresh\n" });
  const broker = new ToolBroker({
    permissionProfile: "guarded",
    workspacePath: root,
    approve: async () => {
      const operation = (swapped.arguments as unknown as { operation: { type: string; diff: string } }).operation;
      operation.type = "update_file";
      operation.diff = "@@\n-old\n+new\n";
      return true;
    },
  });
  broker.register(createOpenRouterApplyPatchTool());
  try {
    const result = await broker.invoke(swapped, context(root));
    assert.equal(result.isError, true);
    assert.equal(result.error?.code, "grant_mismatch");
    assert.equal(existsSync(join(root, "new.txt")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("OpenRouter apply_patch rejects input-swapped path after capture", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-openrouter-patch-pathswap-"));
  const first = join(root, "value.txt");
  const second = join(root, "other.txt");
  writeFileSync(first, "original\n");
  writeFileSync(second, "original\n");
  const swapped = call("pathswap_1", { type: "update_file", path: "value.txt", diff: "@@\n-original\n+replacement\n" });
  const broker = new ToolBroker({
    permissionProfile: "guarded",
    workspacePath: root,
    approve: async () => {
      (swapped.arguments as unknown as { operation: { path: string } }).operation.path = "other.txt";
      return true;
    },
  });
  broker.register(createOpenRouterApplyPatchTool());
  try {
    const result = await broker.invoke(swapped, context(root));
    assert.equal(result.isError, true);
    assert.equal(result.error?.code, "grant_mismatch");
    assert.equal(readFileSync(first, "utf8"), "original\n");
    assert.equal(readFileSync(second, "utf8"), "original\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("OpenRouter apply_patch forbids move derivation", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-openrouter-patch-nomove-"));
  const broker = new ToolBroker({ permissionProfile: "full", workspacePath: root });
  broker.register(createOpenRouterApplyPatchTool());
  try {
    const invalid = await broker.invoke(
      call("move_1", { type: "move_file", path: "a.txt", destination: "b.txt" }),
      context(root)
    );
    assert.equal(invalid.isError, true);
    assert.equal(invalid.error?.code, "invalid_arguments");
    assert.equal(existsSync(join(root, "a.txt")), false);
    assert.equal(existsSync(join(root, "b.txt")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  const moveRoot = mkdtempSync(join(tmpdir(), "aiboard-openrouter-patch-movecap-"));
  try {
    writeFileSync(join(moveRoot, "src.txt"), "data\n");
    const authority = createExecutionGrantAuthority();
    try {
      const capture = captureFilesystemMutation(
        moveRoot,
        "fs.move",
        [
          { path: "src.txt", access: "delete" },
          { path: "dst.txt", access: "write" },
        ]
      );
      const binding = {
        runId: "run_1",
        sessionId: "session_1",
        actor: { role: "worker" as const, id: "worker_1" },
        toolName: "openrouter.apply_patch",
        callId: "move_cap",
        permissionProfile: "full" as const,
      };
      const grant = await authority.issue({
        ...binding,
        workspacePath: moveRoot,
        access: [
          { path: "src.txt", mode: "write" as const },
          { path: "dst.txt", mode: "write" as const },
        ],
        externalApproved: false,
        destructiveApproved: false,
        networkApproved: false,
      });
      assert.throws(
        () => authorizeFilesystemMutation(capture, { authority, grant, binding }),
        (error) => error instanceof ExecutionGrantError && error.code === "grant_mismatch"
      );
      await authority.revoke(grant, "cleanup");
    } finally {
      await authority.revokeAll("cleanup");
    }
  } finally {
    rmSync(moveRoot, { recursive: true, force: true });
  }
});

test("OpenRouter apply_patch delete cannot escalate to recursive directory", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-openrouter-patch-norec-"));
  const dir = join(root, "mydir");
  mkdirSync(dir);
  writeFileSync(join(dir, "inner.txt"), "keep\n");
  const broker = new ToolBroker({ permissionProfile: "full", workspacePath: root });
  broker.register(createOpenRouterApplyPatchTool());
  try {
    const result = await broker.invoke(
      call("norec_1", { type: "delete_file", path: "mydir" }),
      context(root)
    );
    assert.equal(result.isError, true);
    assert.ok(result.error?.code === "patch_apply_failed" || result.error?.code === "directory_not_empty");
    assert.equal(existsSync(join(dir, "inner.txt")), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("OpenRouter apply_patch delete requires destructive approval", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-openrouter-patch-destr-"));
  const path = join(root, "value.txt");
  writeFileSync(path, "keep\n");
  const project = new ToolBroker({ permissionProfile: "project", workspacePath: root });
  project.register(createOpenRouterApplyPatchTool());
  const denied = new ToolBroker({
    permissionProfile: "guarded",
    workspacePath: root,
    approve: async () => false,
  });
  denied.register(createOpenRouterApplyPatchTool());
  try {
    const required = await project.invoke(
      call("destr_1", { type: "delete_file", path: "value.txt" }),
      context(root)
    );
    assert.equal(required.isError, true);
    assert.equal(required.error?.code, "approval_required");
    const refused = await denied.invoke(
      call("destr_2", { type: "delete_file", path: "value.txt" }),
      context(root)
    );
    assert.equal(refused.isError, true);
    assert.equal(refused.error?.code, "permission_denied");
    assert.equal(readFileSync(path, "utf8"), "keep\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("OpenRouter apply_patch respects host protected-path equality", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-openrouter-patch-case-"));
  writeFileSync(join(root, "protected.txt"), "keep\n");
  const broker = new ToolBroker({ permissionProfile: "full", workspacePath: root });
  broker.register(createOpenRouterApplyPatchTool({ protectedPaths: ["protected.txt"] }));
  try {
    const result = await broker.invoke(
      call("case_1", { type: "update_file", path: "PROTECTED.txt", diff: "@@\n-keep\n+changed\n" }),
      context(root)
    );
    if (process.platform === "win32") {
      assert.equal(result.isError, true);
      assert.equal(result.error?.code, "protected_path");
      assert.equal(readFileSync(join(root, "protected.txt"), "utf8"), "keep\n");
    } else {
      assert.equal(result.isError, true);
      assert.notEqual(result.error?.code, "protected_path");
      assert.equal(readFileSync(join(root, "protected.txt"), "utf8"), "keep\n");
      writeFileSync(join(root, "PROTECTED.txt"), "upper\n");
      const upper = await broker.invoke(
        call("case_2", { type: "update_file", path: "PROTECTED.txt", diff: "@@\n-upper\n+changed\n" }),
        context(root)
      );
      assert.equal(upper.isError, false);
      assert.equal(readFileSync(join(root, "PROTECTED.txt"), "utf8"), "changed\n");
      assert.equal(readFileSync(join(root, "protected.txt"), "utf8"), "keep\n");
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("OpenRouter apply_patch preserves original grant identity in broker audit", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-openrouter-patch-identity-"));
  const broker = new ToolBroker({ permissionProfile: "full", workspacePath: root });
  broker.register(createOpenRouterApplyPatchTool());
  try {
    const created = await broker.invoke(
      call("id_create", { type: "create_file", path: "id.txt", diff: "+one\n" }),
      context(root)
    );
    assert.equal(created.isError, false);
    const updated = await broker.invoke(
      call("id_update", { type: "update_file", path: "id.txt", diff: "@@\n-one\n+two\n" }),
      context(root)
    );
    assert.equal(updated.isError, false);
    const deleted = await broker.invoke(
      call("id_delete", { type: "delete_file", path: "id.txt" }),
      context(root)
    );
    assert.equal(deleted.isError, false);
    const records = broker.auditRecords();
    assert.equal(records.length, 3);
    for (const record of records) {
      assert.equal(record.toolName, "openrouter.apply_patch");
      assert.equal(record.isError, false);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
