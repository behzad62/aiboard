import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ArtifactStore } from "../src/artifact-store.js";
import type { ToolCallBlock, ToolResult } from "../src/agent-contracts.js";
import { createFilesystemTools } from "../src/filesystem-tools.js";
import { ToolBroker } from "../src/tool-broker.js";

test("filesystem tools read, inspect, list, search, and preserve CRLF edits", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-fs-tools-"));
  const workspace = join(root, "workspace");
  mkdirSync(join(workspace, "src"), { recursive: true });
  writeFileSync(join(workspace, "src", "app.ts"), "const alpha = 1;\r\nconst beta = 2;\r\n");
  writeFileSync(join(workspace, "src", "minified.js"), "x".repeat(7 * 1024));
  writeFileSync(join(workspace, "binary.bin"), Buffer.from([0, 1, 2, 255]));
  const artifacts = new ArtifactStore(join(root, "artifacts"));
  const broker = brokerWithFilesystem(workspace, artifacts);
  try {
    assert.match(
      broker.definitions().find((tool) => tool.name === "fs.patch")?.description ?? "",
      /one fs\.patch per file per model turn/i,
    );
    const read = await invoke(broker, "read", "fs.read", { path: "src/app.ts" });
    assert.equal(read.isError, false);
    assert.match(text(read), /const alpha/);
    const metadata = json(read) as { sha256: string; byteLength: number };
    assert.match(metadata.sha256, /^[a-f0-9]{64}$/);
    assert.equal(metadata.byteLength, 35);

    const ranged = await invoke(broker, "read_range", "fs.read", {
      path: "src/app.ts",
      startLine: 2,
      endLine: 2,
    });
    assert.equal(ranged.isError, false);
    assert.equal(text(ranged), "const beta = 2;\r\n");
    assert.deepEqual(json(ranged), {
      path: "src/app.ts",
      sha256: metadata.sha256,
      byteLength: 35,
      totalLines: 3,
      startLine: 2,
      endLine: 2,
      truncated: true,
    });

    const invalidRange = await invoke(broker, "read_bad_range", "fs.read", {
      path: "src/app.ts",
      startLine: 3,
      endLine: 2,
    });
    assert.equal(invalidRange.isError, true);
    assert.equal(invalidRange.error?.code, "invalid_arguments");

    const oversizedRange = await invoke(broker, "read_oversized_range", "fs.read", {
      path: "src/minified.js",
      startLine: 1,
      endLine: 1,
    });
    assert.equal(oversizedRange.isError, true);
    assert.equal(oversizedRange.error?.code, "line_range_too_large");
    assert.match(text(oversizedRange), /narrow the range/i);

    const stat = await invoke(broker, "stat", "fs.stat", { path: "src/app.ts" });
    assert.equal((json(stat) as { type: string }).type, "file");
    const list = await invoke(broker, "list", "fs.list", { path: ".", maxDepth: 2 });
    assert.deepEqual(
      (json(list) as { entries: Array<{ path: string }> }).entries.map((entry) => entry.path),
      ["binary.bin", "src", "src/app.ts", "src/minified.js"]
    );
    const search = await invoke(broker, "search", "fs.search", {
      path: ".",
      pattern: "beta",
    });
    assert.deepEqual((json(search) as { matches: unknown[] }).matches, [
      { path: "src/app.ts", line: 2, column: 7, text: "const beta = 2;" },
    ]);
    const fileSearch = await invoke(broker, "search_file", "fs.search", {
      path: "src/app.ts",
      pattern: "const",
      maxMatches: 1,
    });
    assert.equal(fileSearch.isError, false);
    assert.deepEqual(
      (json(fileSearch) as {
        matches: unknown[];
        truncated: boolean;
      }),
      {
        matches: [
          { path: "src/app.ts", line: 1, column: 1, text: "const alpha = 1;" },
        ],
        truncated: true,
      }
    );

    const patch = await invoke(broker, "patch", "fs.patch", {
      path: "src/app.ts",
      expectedSha256: metadata.sha256,
      search: "const beta = 2;",
      replace: "const beta = 3;",
    });
    assert.equal(patch.isError, false);
    assert.equal(
      readFileSync(join(workspace, "src", "app.ts"), "utf8"),
      "const alpha = 1;\r\nconst beta = 3;\r\n"
    );

    const binary = await invoke(broker, "binary", "fs.read", { path: "binary.bin" });
    const artifact = binary.content.find((block) => block.type === "artifact");
    assert.ok(artifact && artifact.type === "artifact");
    assert.deepEqual(await artifacts.get(artifact.hash), Buffer.from([0, 1, 2, 255]));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("filesystem mutations are revision-aware, serialized, movable, and deletable", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-fs-mutations-"));
  const workspace = join(root, "workspace");
  mkdirSync(workspace);
  writeFileSync(join(workspace, "value.txt"), "one\n");
  const broker = brokerWithFilesystem(
    workspace,
    new ArtifactStore(join(root, "artifacts"))
  );
  try {
    const originalHash = sha256(Buffer.from("one\n"));
    const [first, second] = await Promise.all([
      invoke(broker, "patch_a", "fs.patch", {
        path: "value.txt",
        expectedSha256: originalHash,
        search: "one",
        replace: "two",
      }),
      invoke(broker, "patch_b", "fs.patch", {
        path: "value.txt",
        expectedSha256: originalHash,
        search: "one",
        replace: "three",
      }),
    ]);
    assert.deepEqual(
      [first, second].map((result) => result.error?.code ?? "ok").sort(),
      ["ok", "revision_conflict"]
    );
    const conflict = [first, second].find(
      (result) => result.error?.code === "revision_conflict"
    );
    assert.ok(conflict);
    const conflictDetails = json(conflict) as {
      path: string;
      expectedSha256: string;
      currentSha256: string;
      recovery: string;
    };
    assert.deepEqual(conflictDetails, {
      path: "value.txt",
      expectedSha256: originalHash,
      currentSha256: sha256(readFileSync(join(workspace, "value.txt"))),
      recovery: "Retry fs.patch with currentSha256 after confirming the replacement still applies.",
    });
    assert.match(text(conflict), /currentSha256/);

    const write = await invoke(broker, "write", "fs.write", {
      path: "created/note.txt",
      content: "note\n",
      createDirectories: true,
    });
    assert.equal(write.isError, false);
    const move = await invoke(broker, "move", "fs.move", {
      source: "created/note.txt",
      destination: "moved.txt",
    });
    assert.equal(move.isError, false);
    assert.equal(existsSync(join(workspace, "created", "note.txt")), false);
    assert.equal(readFileSync(join(workspace, "moved.txt"), "utf8"), "note\n");
    const remove = await invoke(broker, "delete", "fs.delete", { path: "moved.txt" });
    assert.equal(remove.isError, false);
    assert.equal(existsSync(join(workspace, "moved.txt")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function brokerWithFilesystem(workspace: string, artifacts: ArtifactStore): ToolBroker {
  const broker = new ToolBroker({
    permissionProfile: "project",
    workspacePath: workspace,
    artifacts,
  });
  for (const tool of createFilesystemTools({ artifacts })) broker.register(tool);
  return broker;
}

async function invoke(
  broker: ToolBroker,
  callId: string,
  name: string,
  argumentsValue: unknown
): Promise<ToolResult> {
  const call: ToolCallBlock = {
    type: "tool_call",
    callId,
    name,
    arguments: argumentsValue,
  };
  return await broker.invoke(call, {
    runId: "run_1",
    sessionId: "session_1",
    actor: { role: "worker", id: "worker_1" },
  });
}

function text(result: ToolResult): string {
  return result.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

function json(result: ToolResult): unknown {
  return result.content.find((block) => block.type === "json")?.value;
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}
