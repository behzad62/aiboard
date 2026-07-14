import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
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
import { RepositoryIntelligence } from "../src/repository-intelligence.js";
import { ToolBroker } from "../src/tool-broker.js";

test("filesystem tools read, inspect, list, search, and preserve CRLF edits", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-fs-tools-"));
  const workspace = join(root, "workspace");
  mkdirSync(join(workspace, "src"), { recursive: true });
  writeFileSync(join(workspace, "src", "app.ts"), "const alpha = 1;\r\nconst beta = 2;\r\n");
  writeFileSync(
    join(workspace, "src", "dense.ts"),
    Array.from({ length: 100 }, (_, index) => `const value${index} = "${"x".repeat(80)}";\n`).join("")
  );
  writeFileSync(join(workspace, "src", "minified.js"), "x".repeat(7 * 1024));
  writeFileSync(join(workspace, "binary.bin"), Buffer.from([0, 1, 2, 255]));
  const artifacts = new ArtifactStore(join(root, "artifacts"));
  const broker = brokerWithFilesystem(workspace, artifacts);
  try {
    const patchDefinition = broker.definitions().find(
      (tool) => tool.name === "fs.patch"
    );
    const readDefinition = broker.definitions().find(
      (tool) => tool.name === "fs.read"
    );
    assert.match(
      readDefinition?.description ?? "",
      /6144 bytes/i,
      "the model-facing read contract must advertise its byte ceiling"
    );
    assert.match(
      patchDefinition?.description ?? "",
      /one or many.*atomically/i,
    );
    assert.deepEqual(
      ((patchDefinition?.inputSchema as {
        properties?: { edits?: { minItems?: number; maxItems?: number } };
      }).properties?.edits),
      {
        type: "array",
        minItems: 1,
        maxItems: 50,
        items: {
          type: "object",
          properties: {
            search: { type: "string", minLength: 1 },
            replace: { type: "string" },
          },
          required: ["search", "replace"],
          additionalProperties: false,
        },
      },
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

    const clippedRange = await invoke(broker, "read_clipped_range", "fs.read", {
      path: "src/dense.ts",
      startLine: 1,
      endLine: 100,
    });
    assert.equal(clippedRange.isError, false);
    const clippedMetadata = json(clippedRange) as {
      endLine: number;
      requestedEndLine: number;
      nextStartLine: number;
      rangeByteLength: number;
    };
    assert.ok(clippedMetadata.endLine < 100);
    assert.equal(clippedMetadata.requestedEndLine, 100);
    assert.equal(clippedMetadata.nextStartLine, clippedMetadata.endLine + 1);
    assert.ok(clippedMetadata.rangeByteLength <= 6144);
    assert.match(text(clippedRange), /const value0/);

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
      ["binary.bin", "src", "src/app.ts", "src/dense.ts", "src/minified.js"]
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

    const patchedMetadata = json(patch) as { sha256: string };
    const multiPatch = await invoke(broker, "patch_many", "fs.patch", {
      path: "src/app.ts",
      expectedSha256: patchedMetadata.sha256,
      edits: [
        { search: "const alpha = 1;", replace: "const alpha = 10;" },
        {
          search: "const alpha = 10;\r\nconst beta = 3;",
          replace: "const alpha = 10;\r\nconst beta = 30;",
        },
      ],
    });
    assert.equal(multiPatch.isError, false);
    assert.equal(
      readFileSync(join(workspace, "src", "app.ts"), "utf8"),
      "const alpha = 10;\r\nconst beta = 30;\r\n"
    );

    const beforeFailedPatch = readFileSync(join(workspace, "src", "app.ts"));
    const failedPatch = await invoke(broker, "patch_many_invalid", "fs.patch", {
      path: "src/app.ts",
      expectedSha256: (json(multiPatch) as { sha256: string }).sha256,
      edits: [
        { search: "const alpha = 10;", replace: "const alpha = 11;" },
        { search: "missing text", replace: "never written" },
      ],
    });
    assert.equal(failedPatch.isError, true);
    assert.equal(failedPatch.error?.code, "ambiguous_patch");
    assert.match(text(failedPatch), /edit 2/i);
    assert.deepEqual(
      readFileSync(join(workspace, "src", "app.ts")),
      beforeFailedPatch,
      "all replacements must validate before the atomic write"
    );

    const staleBatch = await invoke(broker, "patch_many_stale", "fs.patch", {
      path: "src/app.ts",
      expectedSha256: patchedMetadata.sha256,
      edits: [{ search: "const beta = 30;", replace: "const beta = 31;" }],
    });
    assert.equal(staleBatch.isError, true);
    assert.equal(staleBatch.error?.code, "revision_conflict");
    assert.deepEqual(
      readFileSync(join(workspace, "src", "app.ts")),
      beforeFailedPatch,
    );

    const mixedPatchShape = await invoke(broker, "patch_mixed_shape", "fs.patch", {
      path: "src/app.ts",
      expectedSha256: (json(multiPatch) as { sha256: string }).sha256,
      search: "const alpha = 10;",
      replace: "const alpha = 11;",
      edits: [{ search: "const beta = 30;", replace: "const beta = 31;" }],
    });
    assert.equal(mixedPatchShape.isError, true);
    assert.equal(mixedPatchShape.error?.code, "invalid_arguments");

    const emptyBatch = await invoke(broker, "patch_empty_batch", "fs.patch", {
      path: "src/app.ts",
      expectedSha256: (json(multiPatch) as { sha256: string }).sha256,
      edits: [],
    });
    assert.equal(emptyBatch.isError, true);
    assert.equal(emptyBatch.error?.code, "invalid_arguments");

    const binary = await invoke(broker, "binary", "fs.read", { path: "binary.bin" });
    const artifact = binary.content.find((block) => block.type === "artifact");
    assert.ok(artifact && artifact.type === "artifact");
    assert.deepEqual(await artifacts.get(artifact.hash), Buffer.from([0, 1, 2, 255]));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("fs.patch accepts LF multiline edits for CRLF files without mixing line endings", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-fs-patch-crlf-"));
  const workspace = join(root, "workspace");
  mkdirSync(workspace);
  const file = join(workspace, "renderer.js");
  const original = "const first = 1;\r\nconst second = 2;\r\nconst third = 3;\r\n";
  writeFileSync(file, original);
  const broker = brokerWithFilesystem(
    workspace,
    new ArtifactStore(join(root, "artifacts")),
  );

  try {
    const result = await invoke(broker, "patch_crlf_with_lf", "fs.patch", {
      path: "renderer.js",
      expectedSha256: sha256(Buffer.from(original)),
      edits: [
        {
          search: "const first = 1;\nconst second = 2;",
          replace: "const first = 10;\nconst inserted = true;\nconst second = 20;",
        },
      ],
    });

    assert.equal(result.isError, false);
    assert.equal(
      readFileSync(file, "utf8"),
      "const first = 10;\r\nconst inserted = true;\r\nconst second = 20;\r\nconst third = 3;\r\n",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("directory listing and search follow Git discovery and classification", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-fs-git-aware-"));
  const workspace = join(root, "workspace");
  mkdirSync(join(workspace, "dist"), { recursive: true });
  mkdirSync(join(workspace, "src"), { recursive: true });
  mkdirSync(join(workspace, "vendor"), { recursive: true });
  writeFileSync(join(workspace, ".gitignore"), "ignored/\n");
  mkdirSync(join(workspace, "ignored"), { recursive: true });
  writeFileSync(join(workspace, "ignored", "secret.ts"), "export const needle = 'ignored';\n");
  writeFileSync(join(workspace, "dist", "generated.ts"), "// @generated\nexport const needle = 'generated';\n");
  writeFileSync(join(workspace, "src", "app.ts"), "export const needle = 'source';\n");
  writeFileSync(join(workspace, "vendor", "library.js"), "export const needle = 'vendor';\n");
  git(workspace, "init");
  git(workspace, "add", ".gitignore", "src/app.ts", "vendor/library.js");
  git(workspace, "add", "-f", "dist/generated.ts");
  const broker = brokerWithFilesystem(
    workspace,
    new ArtifactStore(join(root, "artifacts")),
  );

  try {
    const list = await invoke(broker, "git_list", "fs.list", {
      path: ".",
      maxDepth: 2,
    });
    assert.equal(list.isError, false);
    const listed = (json(list) as { entries: Array<{ path: string }> }).entries
      .map((item) => item.path);
    assert.equal(listed.includes("ignored"), false);
    assert.equal(listed.includes("ignored/secret.ts"), false);
    assert.equal(listed.includes("dist/generated.ts"), true);

    const defaultSearch = await invoke(broker, "git_search", "fs.search", {
      path: ".",
      pattern: "needle",
    });
    assert.deepEqual(searchPaths(defaultSearch), ["src/app.ts"]);

    const inclusiveSearch = await invoke(broker, "git_search_all", "fs.search", {
      path: ".",
      pattern: "needle",
      includeGenerated: true,
      includeVendored: true,
      includeIgnored: true,
    });
    assert.deepEqual(searchPaths(inclusiveSearch), [
      "dist/generated.ts",
      "ignored/secret.ts",
      "src/app.ts",
      "vendor/library.js",
    ]);
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
  for (const tool of createFilesystemTools({
    artifacts,
    repository: new RepositoryIntelligence(),
  })) broker.register(tool);
  return broker;
}

function searchPaths(result: ToolResult): string[] {
  return (json(result) as { matches: Array<{ path: string }> }).matches
    .map((match) => match.path);
}

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "pipe", windowsHide: true });
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
