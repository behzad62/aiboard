import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import filesystem, { realpath as namedRealpath } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";

import { ArtifactStore } from "../src/artifact-store.js";
import type { ToolCallBlock, ToolExecutionContext, ToolResult } from "../src/agent-contracts.js";
import { createFilesystemTools } from "../src/filesystem-tools.js";
import { RepositoryIntelligence } from "./support/git-fixture.js";
import { ToolBroker } from "../src/tool-broker.js";
import { TypeScriptIntelligence } from "./support/git-fixture.js";

test("filesystem tools read, inspect, list, search, and preserve CRLF edits", async () => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "aiboard-fs-tools-")));
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
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "aiboard-fs-patch-crlf-")));
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
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "aiboard-fs-git-aware-")));
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
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "aiboard-fs-mutations-")));
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

test("text mutations attach changed-file TypeScript diagnostics", async () => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "aiboard-fs-diagnostics-")));
  const workspace = join(root, "workspace");
  mkdirSync(workspace);
  writeFileSync(join(workspace, "tsconfig.json"), JSON.stringify({
    compilerOptions: { strict: true, target: "ES2022", module: "ESNext" },
    include: ["*.ts"],
  }));
  const original = 'export const total: string = "ok";\n';
  writeFileSync(join(workspace, "value.ts"), original);
  const repository = new RepositoryIntelligence();
  const diagnostics = new TypeScriptIntelligence(repository);
  const broker = brokerWithFilesystem(
    workspace,
    new ArtifactStore(join(root, "artifacts")),
    diagnostics,
  );

  try {
    const patch = await invoke(broker, "diagnostic_patch", "fs.patch", {
      path: "value.ts",
      expectedSha256: sha256(Buffer.from(original)),
      search: '"ok"',
      replace: "1",
    });
    assert.equal(patch.isError, false);
    const metadata = json(patch) as {
      sha256: string;
      diagnostics: { results: Array<{ code: number }>; truncated: boolean };
    };
    assert.match(metadata.sha256, /^[a-f0-9]{64}$/);
    assert.ok(metadata.diagnostics.results.some((item) => item.code === 2322));

    const write = await invoke(broker, "diagnostic_skip", "fs.write", {
      path: "note.txt",
      content: "plain text\n",
    });
    assert.equal((json(write) as { diagnosticsSkipped: string }).diagnosticsSkipped,
      "unsupported_language");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("diagnostic failures never roll back a successful atomic mutation", async () => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "aiboard-fs-diagnostic-failure-")));
  const workspace = join(root, "workspace");
  mkdirSync(workspace);
  const broker = brokerWithFilesystem(
    workspace,
    new ArtifactStore(join(root, "artifacts")),
    {
      diagnostics: async () => {
        throw new Error("injected diagnostic failure");
      },
    },
  );

  try {
    const result = await invoke(broker, "diagnostic_failure", "fs.write", {
      path: "created.ts",
      content: "export const created = true;\n",
    });
    assert.equal(result.isError, false);
    assert.equal(
      (json(result) as { diagnosticsUnavailable: string }).diagnosticsUnavailable,
      "code_intelligence_failed",
    );
    assert.equal(
      readFileSync(join(workspace, "created.ts"), "utf8"),
      "export const created = true;\n",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("benchmark filesystem policy hides oracle files and protects verifier assets", async () => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "aiboard-fs-benchmark-policy-")));
  const workspace = join(root, "workspace");
  mkdirSync(workspace);
  writeFileSync(join(workspace, "case-meta.json"), '{"secret":true}\n');
  writeFileSync(join(workspace, "verifier.mjs"), "export default true;\n");
  writeFileSync(join(workspace, "visible.txt"), "public\n");
  const artifacts = new ArtifactStore(join(root, "artifacts"));
  const broker = new ToolBroker({
    permissionProfile: "full",
    workspacePath: workspace,
    artifacts,
  });
  for (const tool of createFilesystemTools({
    artifacts,
    repository: new RepositoryIntelligence(),
    hiddenPaths: ["case-meta.json"],
    protectedPaths: ["case-meta.json", "verifier.mjs"],
  })) broker.register(tool);

  try {
    const listing = await invoke(broker, "list", "fs.list", { path: ".", maxDepth: 2 });
    assert.equal(listing.isError, false);
    assert.doesNotMatch(JSON.stringify(json(listing)), /case-meta\.json/);
    assert.match(JSON.stringify(json(listing)), /visible\.txt/);

    const search = await invoke(broker, "search", "fs.search", {
      path: ".",
      pattern: "secret",
    });
    assert.equal(search.isError, false);
    assert.deepEqual(searchPaths(search), []);

    const hiddenRead = await invoke(broker, "read_hidden", "fs.read", {
      path: "case-meta.json",
    });
    assert.equal(hiddenRead.isError, true);
    assert.match(text(hiddenRead), /benchmark_hidden_path/);

    for (const [index, [name, input]] of ([
      ["fs.write", { path: "verifier.mjs", content: "tampered\n" }],
      ["fs.delete", { path: "verifier.mjs" }],
      ["fs.move", { source: "verifier.mjs", destination: "moved.mjs" }],
      ["fs.move", { source: "visible.txt", destination: "case-meta.json" }],
    ] as const).entries()) {
      const denied = await invoke(broker, `denied_${index}`, name, input);
      assert.equal(denied.isError, true, `${name} should be denied`);
      assert.match(text(denied), /benchmark_protected_path/);
    }
    assert.equal(readFileSync(join(workspace, "verifier.mjs"), "utf8"), "export default true;\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("filesystem tools respect host protected-path equality for patch", async () => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "aiboard-fs-protected-case-patch-")));
  const workspace = join(root, "workspace");
  mkdirSync(workspace, { recursive: true });
  writeFileSync(join(workspace, "protected.txt"), "keep\n");
  const artifacts = new ArtifactStore(join(root, "artifacts"));
  const broker = new ToolBroker({ permissionProfile: "full", workspacePath: workspace, artifacts });
  for (const tool of createFilesystemTools({ artifacts, repository: new RepositoryIntelligence(), protectedPaths: ["protected.txt"] })) broker.register(tool);
  try {
    const result = await invoke(broker, "patch_case_1", "fs.patch", { path: "PROTECTED.txt", expectedSha256: sha256(Buffer.from("keep\n")), search: "keep", replace: "changed" });
    if (process.platform === "win32") {
      assert.equal(result.isError, true);
      assert.equal(result.error?.code, "benchmark_protected_path");
      assert.equal(readFileSync(join(workspace, "protected.txt"), "utf8"), "keep\n");
    } else {
      assert.equal(result.isError, true);
      assert.notEqual(result.error?.code, "benchmark_protected_path");
      assert.equal(readFileSync(join(workspace, "protected.txt"), "utf8"), "keep\n");
      const sameObject = sameFilesystemObject(join(workspace, "protected.txt"), join(workspace, "PROTECTED.txt"));
      if (sameObject) {
        assert.equal(result.error?.code, "filesystem_alias", "case-variant same object must fail closed on canonical spelling");
        assert.equal(readFileSync(join(workspace, "PROTECTED.txt"), "utf8"), "keep\n", "same object shares protected bytes");
        assert.equal(readFileSync(join(workspace, "protected.txt"), "utf8"), "keep\n");
      } else {
        writeFileSync(join(workspace, "PROTECTED.txt"), "upper\n");
        const upper = await invoke(broker, "patch_case_2", "fs.patch", { path: "PROTECTED.txt", expectedSha256: sha256(Buffer.from("upper\n")), search: "upper", replace: "changed" });
        assert.equal(upper.isError, false);
        assert.equal(readFileSync(join(workspace, "PROTECTED.txt"), "utf8"), "changed\n");
        assert.equal(readFileSync(join(workspace, "protected.txt"), "utf8"), "keep\n");
      }
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("filesystem tools respect host protected-path equality for write", async () => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "aiboard-fs-protected-case-write-")));
  const workspace = join(root, "workspace");
  mkdirSync(workspace, { recursive: true });
  writeFileSync(join(workspace, "protected.txt"), "keep\n");
  writeFileSync(join(workspace, "visible.txt"), "public\n");
  const artifacts = new ArtifactStore(join(root, "artifacts"));
  const broker = new ToolBroker({ permissionProfile: "full", workspacePath: workspace, artifacts });
  for (const tool of createFilesystemTools({ artifacts, repository: new RepositoryIntelligence(), protectedPaths: ["protected.txt"] })) broker.register(tool);
  try {
    const attempt = await invoke(broker, "write_case_1", "fs.write", { path: "PROTECTED.txt", content: "evil\n", expectedSha256: sha256(Buffer.from("keep\n")) });
    if (process.platform === "win32") {
      assert.equal(attempt.isError, true);
      assert.equal(attempt.error?.code, "benchmark_protected_path");
      assert.equal(readFileSync(join(workspace, "protected.txt"), "utf8"), "keep\n");
    } else {
      assert.equal(attempt.isError, true);
      assert.notEqual(attempt.error?.code, "benchmark_protected_path");
      assert.equal(readFileSync(join(workspace, "protected.txt"), "utf8"), "keep\n");
      if (sameFilesystemObject(join(workspace, "protected.txt"), join(workspace, "PROTECTED.txt"))) {
        assert.equal(attempt.error?.code, "filesystem_alias", "case-variant same object must fail closed on canonical spelling");
        assert.equal(readFileSync(join(workspace, "protected.txt"), "utf8"), "keep\n");
      }
    }
    const positive = await invoke(broker, "write_positive", "fs.write", { path: "visible.txt", content: "changed\n", expectedSha256: sha256(Buffer.from("public\n")) });
    assert.equal(positive.isError, false);
    assert.equal(readFileSync(join(workspace, "visible.txt"), "utf8"), "changed\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("filesystem tools respect host protected-path equality for delete", async () => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "aiboard-fs-protected-case-delete-")));
  const workspace = join(root, "workspace");
  mkdirSync(workspace, { recursive: true });
  writeFileSync(join(workspace, "protected.txt"), "keep\n");
  const artifacts = new ArtifactStore(join(root, "artifacts"));
  const broker = new ToolBroker({ permissionProfile: "full", workspacePath: workspace, artifacts });
  for (const tool of createFilesystemTools({ artifacts, repository: new RepositoryIntelligence(), protectedPaths: ["protected.txt"] })) broker.register(tool);
  try {
    const attempt = await invoke(broker, "delete_case_1", "fs.delete", { path: "PROTECTED.txt" });
    if (process.platform === "win32") {
      assert.equal(attempt.isError, true);
      assert.equal(attempt.error?.code, "benchmark_protected_path");
      assert.equal(existsSync(join(workspace, "protected.txt")), true);
      assert.equal(readFileSync(join(workspace, "protected.txt"), "utf8"), "keep\n");
    } else {
      assert.equal(attempt.isError, true);
      assert.notEqual(attempt.error?.code, "benchmark_protected_path");
      assert.equal(readFileSync(join(workspace, "protected.txt"), "utf8"), "keep\n");
      if (sameFilesystemObject(join(workspace, "protected.txt"), join(workspace, "PROTECTED.txt"))) {
        assert.equal(attempt.error?.code, "filesystem_alias", "case-variant same object must fail closed on canonical spelling");
        assert.equal(existsSync(join(workspace, "protected.txt")), true);
        assert.equal(readFileSync(join(workspace, "protected.txt"), "utf8"), "keep\n");
      }
    }
    const created = await invoke(broker, "delete_positive_create", "fs.write", { path: "temp.txt", content: "temp\n" });
    assert.equal(created.isError, false);
    const removed = await invoke(broker, "delete_positive", "fs.delete", { path: "temp.txt" });
    assert.equal(removed.isError, false);
    assert.equal(existsSync(join(workspace, "temp.txt")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("filesystem tools respect host protected-path equality for move", async () => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "aiboard-fs-protected-case-move-")));
  const workspace = join(root, "workspace");
  mkdirSync(workspace, { recursive: true });
  writeFileSync(join(workspace, "protected.txt"), "keep\n");
  writeFileSync(join(workspace, "visible.txt"), "public\n");
  writeFileSync(join(workspace, "visible2.txt"), "public2\n");
  const artifacts = new ArtifactStore(join(root, "artifacts"));
  const broker = new ToolBroker({ permissionProfile: "full", workspacePath: workspace, artifacts });
  for (const tool of createFilesystemTools({ artifacts, repository: new RepositoryIntelligence(), protectedPaths: ["protected.txt", "protected-dest.txt"] })) broker.register(tool);
  try {
    const srcAttempt = await invoke(broker, "move_src_1", "fs.move", { source: "PROTECTED.txt", destination: "moved.txt" });
    if (process.platform === "win32") {
      assert.equal(srcAttempt.isError, true);
      assert.equal(srcAttempt.error?.code, "benchmark_protected_path");
      assert.equal(readFileSync(join(workspace, "protected.txt"), "utf8"), "keep\n");
      assert.equal(existsSync(join(workspace, "moved.txt")), false);
    } else {
      assert.equal(srcAttempt.isError, true);
      assert.notEqual(srcAttempt.error?.code, "benchmark_protected_path");
      assert.equal(readFileSync(join(workspace, "protected.txt"), "utf8"), "keep\n");
      if (sameFilesystemObject(join(workspace, "protected.txt"), join(workspace, "PROTECTED.txt"))) {
        assert.equal(srcAttempt.error?.code, "filesystem_alias", "case-variant same object must fail closed on canonical spelling");
        assert.equal(readFileSync(join(workspace, "protected.txt"), "utf8"), "keep\n");
        assert.equal(existsSync(join(workspace, "moved.txt")), false);
      }
    }
    const destExact = await invoke(broker, "move_dest_exact", "fs.move", { source: "visible.txt", destination: "protected-dest.txt" });
    assert.equal(destExact.isError, true);
    assert.equal(destExact.error?.code, "benchmark_protected_path");
    assert.equal(readFileSync(join(workspace, "visible.txt"), "utf8"), "public\n");
    assert.equal(existsSync(join(workspace, "protected-dest.txt")), false);
    const destAttempt = await invoke(broker, "move_dest_1", "fs.move", { source: "visible2.txt", destination: "PROTECTED-DEST.txt" });
    if (process.platform === "win32") {
      assert.equal(destAttempt.isError, true);
      assert.equal(destAttempt.error?.code, "benchmark_protected_path");
      assert.equal(readFileSync(join(workspace, "visible2.txt"), "utf8"), "public2\n");
      assert.equal(existsSync(join(workspace, "PROTECTED-DEST.txt")), false);
    } else {
      assert.equal(destAttempt.isError, false);
      assert.equal(existsSync(join(workspace, "visible2.txt")), false);
      assert.equal(readFileSync(join(workspace, "PROTECTED-DEST.txt"), "utf8"), "public2\n");
      assert.equal(readFileSync(join(workspace, "protected.txt"), "utf8"), "keep\n");
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("filesystem tools preserve nested basename hidden scope under host equality", async () => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "aiboard-fs-protected-scope-")));
  const workspace = join(root, "workspace");
  mkdirSync(join(workspace, "nested"), { recursive: true });
  writeFileSync(join(workspace, "protected.txt"), "keep\n");
  writeFileSync(join(workspace, "nested", "protected.txt"), "nested-keep\n");
  writeFileSync(join(workspace, "nested", "inner.txt"), "inner-keep\n");
  writeFileSync(join(workspace, "secret.txt"), "hidden-content\n");
  writeFileSync(join(workspace, "visible.txt"), "public\n");
  const artifacts = new ArtifactStore(join(root, "artifacts"));
  const broker = new ToolBroker({ permissionProfile: "full", workspacePath: workspace, artifacts });
  for (const tool of createFilesystemTools({ artifacts, repository: new RepositoryIntelligence(), protectedPaths: ["protected.txt", "nested/inner.txt"], hiddenPaths: ["secret.txt"] })) broker.register(tool);
  try {
    const exactBase = await invoke(broker, "scope_exact_base", "fs.patch", { path: "protected.txt", expectedSha256: sha256(Buffer.from("keep\n")), search: "keep", replace: "changed" });
    assert.equal(exactBase.isError, true);
    assert.equal(exactBase.error?.code, "benchmark_protected_path");
    const exactBasename = await invoke(broker, "scope_exact_basename", "fs.patch", { path: "nested/protected.txt", expectedSha256: sha256(Buffer.from("nested-keep\n")), search: "nested-keep", replace: "changed" });
    assert.equal(exactBasename.isError, true);
    assert.equal(exactBasename.error?.code, "benchmark_protected_path");
    const exactNested = await invoke(broker, "scope_exact_nested", "fs.patch", { path: "nested/inner.txt", expectedSha256: sha256(Buffer.from("inner-keep\n")), search: "inner-keep", replace: "changed" });
    assert.equal(exactNested.isError, true);
    assert.equal(exactNested.error?.code, "benchmark_protected_path");
    const hiddenExact = await invoke(broker, "scope_hidden_exact", "fs.read", { path: "secret.txt" });
    assert.equal(hiddenExact.isError, true);
    assert.equal(hiddenExact.error?.code, "benchmark_hidden_path");
    if (process.platform === "win32") {
      const upperBase = await invoke(broker, "scope_upper_base", "fs.patch", { path: "PROTECTED.txt", expectedSha256: sha256(Buffer.from("keep\n")), search: "keep", replace: "changed" });
      assert.equal(upperBase.isError, true);
      assert.equal(upperBase.error?.code, "benchmark_protected_path");
      const upperBasename = await invoke(broker, "scope_upper_basename", "fs.patch", { path: "NESTED/PROTECTED.txt", expectedSha256: sha256(Buffer.from("nested-keep\n")), search: "nested-keep", replace: "changed" });
      assert.equal(upperBasename.isError, true);
      assert.equal(upperBasename.error?.code, "benchmark_protected_path");
      const upperNested = await invoke(broker, "scope_upper_nested", "fs.patch", { path: "NESTED/INNER.txt", expectedSha256: sha256(Buffer.from("inner-keep\n")), search: "inner-keep", replace: "changed" });
      assert.equal(upperNested.isError, true);
      assert.equal(upperNested.error?.code, "benchmark_protected_path");
      const hiddenUpper = await invoke(broker, "scope_hidden_upper", "fs.read", { path: "SECRET.txt" });
      assert.equal(hiddenUpper.isError, true);
      assert.equal(hiddenUpper.error?.code, "benchmark_hidden_path");
    } else {
      const upperBase = await invoke(broker, "scope_upper_base", "fs.patch", { path: "PROTECTED.txt", expectedSha256: sha256(Buffer.from("keep\n")), search: "keep", replace: "changed" });
      assert.equal(upperBase.isError, true);
      assert.notEqual(upperBase.error?.code, "benchmark_protected_path");
      if (sameFilesystemObject(join(workspace, "protected.txt"), join(workspace, "PROTECTED.txt"))) {
        assert.equal(upperBase.error?.code, "filesystem_alias", "case-variant same object must fail closed on canonical spelling");
      }
      const sameSecret = sameFilesystemObject(join(workspace, "secret.txt"), join(workspace, "SECRET.txt"));
      const hiddenUpper = await invoke(broker, "scope_hidden_upper", "fs.read", { path: "SECRET.txt" });
      if (sameSecret) {
        assert.equal(hiddenUpper.isError, true);
        assert.equal(hiddenUpper.error?.code, "benchmark_hidden_path");
        assert.doesNotMatch(text(hiddenUpper), /hidden-content/);
      } else {
        assert.equal(hiddenUpper.isError, true);
        assert.notEqual(hiddenUpper.error?.code, "benchmark_hidden_path");
      }
    }
    assert.equal(readFileSync(join(workspace, "protected.txt"), "utf8"), "keep\n");
    assert.equal(readFileSync(join(workspace, "nested", "protected.txt"), "utf8"), "nested-keep\n");
    assert.equal(readFileSync(join(workspace, "nested", "inner.txt"), "utf8"), "inner-keep\n");
    const writeNew = await invoke(broker, "scope_positive_write", "fs.write", { path: "new.txt", content: "hello\n" });
    assert.equal(writeNew.isError, false);
    const patchVisible = await invoke(broker, "scope_positive_patch", "fs.patch", { path: "visible.txt", expectedSha256: sha256(Buffer.from("public\n")), search: "public", replace: "changed" });
    assert.equal(patchVisible.isError, false);
    assert.equal(readFileSync(join(workspace, "visible.txt"), "utf8"), "changed\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("hidden same-object alias is refused for stat and file search while visible remains", async () => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "aiboard-fs-hidden-alias-stat-")));
  const workspace = join(root, "workspace");
  mkdirSync(join(workspace, "nested"), { recursive: true });
  writeFileSync(join(workspace, "secret.txt"), "hidden-content needle\n");
  writeFileSync(join(workspace, "nested", "secret.txt"), "nested-hidden-content needle\n");
  writeFileSync(join(workspace, "visible.txt"), "public needle\n");
  writeFileSync(join(workspace, "nested", "visible2.txt"), "nested-public needle\n");
  const artifacts = new ArtifactStore(join(root, "artifacts"));
  const broker = new ToolBroker({ permissionProfile: "full", workspacePath: workspace, artifacts });
  for (const tool of createFilesystemTools({ artifacts, repository: new RepositoryIntelligence(), hiddenPaths: ["secret.txt"] })) broker.register(tool);
  try {
    const hiddenStat = await invoke(broker, "alias_stat_exact", "fs.stat", { path: "secret.txt" });
    assert.equal(hiddenStat.isError, true);
    assert.equal(hiddenStat.error?.code, "benchmark_hidden_path");
    assert.equal(json(hiddenStat), undefined);
    assert.doesNotMatch(text(hiddenStat), /hidden-content/);
    const visibleStat = await invoke(broker, "alias_stat_visible", "fs.stat", { path: "visible.txt" });
    assert.equal(visibleStat.isError, false);
    assert.equal((json(visibleStat) as { type: string }).type, "file");
    const sameSecret = sameFilesystemObject(join(workspace, "secret.txt"), join(workspace, "SECRET.txt"));
    const aliasStat = await invoke(broker, "alias_stat_upper", "fs.stat", { path: "SECRET.txt" });
    const aliasFileSearch = await invoke(broker, "alias_search_file_upper", "fs.search", { path: "SECRET.txt", pattern: "needle" });
    const visibleFileSearch = await invoke(broker, "alias_search_file_visible", "fs.search", { path: "visible.txt", pattern: "needle" });
    assert.equal(visibleFileSearch.isError, false);
    assert.deepEqual(searchPaths(visibleFileSearch), ["visible.txt"]);
    if (sameSecret) {
      assert.equal(aliasStat.isError, true);
      assert.equal(aliasStat.error?.code, "benchmark_hidden_path");
      assert.equal(json(aliasStat), undefined);
      assert.doesNotMatch(text(aliasStat), /hidden-content/);
      assert.equal(aliasFileSearch.isError, false);
      assert.deepEqual(searchPaths(aliasFileSearch), []);
      assert.doesNotMatch(JSON.stringify(json(aliasFileSearch)), /hidden-content/);
      const sameNested = sameFilesystemObject(join(workspace, "nested", "secret.txt"), join(workspace, "nested", "SECRET.txt"));
      if (sameNested) {
        const nestedAliasStat = await invoke(broker, "alias_stat_nested_upper", "fs.stat", { path: "nested/SECRET.txt" });
        assert.equal(nestedAliasStat.isError, true);
        assert.equal(nestedAliasStat.error?.code, "benchmark_hidden_path");
        assert.doesNotMatch(text(nestedAliasStat), /nested-hidden-content/);
      }
      assert.equal(readFileSync(join(workspace, "secret.txt"), "utf8"), "hidden-content needle\n");
      const hiddenExact = await invoke(broker, "alias_read_exact", "fs.read", { path: "secret.txt" });
      assert.equal(hiddenExact.isError, true);
      assert.equal(hiddenExact.error?.code, "benchmark_hidden_path");
    } else {
      assert.equal(aliasStat.isError, true);
      assert.notEqual(aliasStat.error?.code, "benchmark_hidden_path");
      assert.equal(aliasFileSearch.isError, true);
      assert.notEqual(aliasFileSearch.error?.code, "benchmark_hidden_path");
      writeFileSync(join(workspace, "SECRET.txt"), "upper-distinct needle\n");
      const distinctStat = await invoke(broker, "alias_stat_distinct", "fs.stat", { path: "SECRET.txt" });
      assert.equal(distinctStat.isError, false);
      const distinctRead = await invoke(broker, "alias_read_distinct", "fs.read", { path: "SECRET.txt" });
      assert.equal(distinctRead.isError, false);
      assert.match(text(distinctRead), /upper-distinct/);
      assert.doesNotMatch(text(distinctRead), /hidden-content/);
      const distinctSearch = await invoke(broker, "alias_search_distinct", "fs.search", { path: "SECRET.txt", pattern: "needle" });
      assert.equal(distinctSearch.isError, false);
      assert.deepEqual(searchPaths(distinctSearch), ["SECRET.txt"]);
      assert.equal(readFileSync(join(workspace, "secret.txt"), "utf8"), "hidden-content needle\n");
      const hiddenExact = await invoke(broker, "alias_read_exact_2", "fs.read", { path: "secret.txt" });
      assert.equal(hiddenExact.isError, true);
      assert.equal(hiddenExact.error?.code, "benchmark_hidden_path");
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("hidden omission preserves visible entries in plain walk and repository discovery", async () => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "aiboard-fs-hidden-discovery-")));
  const walkWorkspace = join(root, "walk");
  const repoWorkspace = join(root, "repo");
  const hiddenPaths = ["secret.txt", "nested/inner.txt", "hidden-dir"];
  for (const workspace of [walkWorkspace, repoWorkspace]) {
    mkdirSync(join(workspace, "nested"), { recursive: true });
    mkdirSync(join(workspace, "hidden-dir"), { recursive: true });
    writeFileSync(join(workspace, "secret.txt"), "hidden-content needle\n");
    writeFileSync(join(workspace, "nested", "secret.txt"), "nested-hidden-content needle\n");
    writeFileSync(join(workspace, "nested", "inner.txt"), "inner-hidden-content needle\n");
    writeFileSync(join(workspace, "hidden-dir", "file.txt"), "hidden-dir-content needle\n");
    writeFileSync(join(workspace, "visible.txt"), "public needle\n");
    writeFileSync(join(workspace, "nested", "visible2.txt"), "nested-public needle\n");
  }
  const artifacts = new ArtifactStore(join(root, "artifacts"));
  const walkBroker = new ToolBroker({ permissionProfile: "full", workspacePath: walkWorkspace, artifacts });
  for (const tool of createFilesystemTools({ artifacts, hiddenPaths })) walkBroker.register(tool);
  try {
    const walkList = await invoke(walkBroker, "walk_list", "fs.list", { path: ".", maxDepth: 2 });
    assert.equal(walkList.isError, false);
    assert.deepEqual(
      (json(walkList) as { entries: Array<{ path: string }> }).entries.map((entry) => entry.path),
      ["nested", "nested/visible2.txt", "visible.txt"]
    );
    assert.doesNotMatch(JSON.stringify(json(walkList)), /hidden-content/);
    const walkSearch = await invoke(walkBroker, "walk_search", "fs.search", { path: ".", pattern: "needle" });
    assert.equal(walkSearch.isError, false);
    assert.deepEqual(searchPaths(walkSearch).sort(), ["nested/visible2.txt", "visible.txt"]);
    assert.doesNotMatch(JSON.stringify(json(walkSearch)), /hidden-content/);
    const sameNestedDir = sameFilesystemObject(join(walkWorkspace, "nested"), join(walkWorkspace, "NESTED"));
    if (sameNestedDir) {
      const aliasList = await invoke(walkBroker, "walk_list_alias_dir", "fs.list", { path: "NESTED", maxDepth: 1 });
      assert.equal(aliasList.isError, false);
      assert.deepEqual(
        (json(aliasList) as { entries: Array<{ path: string }> }).entries.map((entry) => entry.path),
        ["NESTED/visible2.txt"]
      );
      const aliasSearch = await invoke(walkBroker, "walk_search_alias_dir", "fs.search", { path: "NESTED", pattern: "needle" });
      assert.equal(aliasSearch.isError, false);
      assert.deepEqual(searchPaths(aliasSearch), ["NESTED/visible2.txt"]);
      assert.doesNotMatch(JSON.stringify(json(aliasSearch)), /hidden-content/);
    } else {
      const missingList = await invoke(walkBroker, "walk_list_missing_dir", "fs.list", { path: "NESTED", maxDepth: 1 });
      assert.equal(missingList.isError, true);
      assert.notEqual(missingList.error?.code, "benchmark_hidden_path");
      const missingSearch = await invoke(walkBroker, "walk_search_missing_dir", "fs.search", { path: "NESTED", pattern: "needle" });
      assert.equal(missingSearch.isError, true);
      assert.notEqual(missingSearch.error?.code, "benchmark_hidden_path");
    }
    git(repoWorkspace, "init");
    git(repoWorkspace, "add", ".");
    const repoBroker = new ToolBroker({ permissionProfile: "full", workspacePath: repoWorkspace, artifacts });
    for (const tool of createFilesystemTools({ artifacts, repository: new RepositoryIntelligence(), hiddenPaths })) repoBroker.register(tool);
    const repoList = await invoke(repoBroker, "repo_list", "fs.list", { path: ".", maxDepth: 2 });
    assert.equal(repoList.isError, false);
    const repoListed = (json(repoList) as { entries: Array<{ path: string }> }).entries.map((entry) => entry.path);
    assert.equal(repoListed.includes("secret.txt"), false);
    assert.equal(repoListed.includes("nested/secret.txt"), false);
    assert.equal(repoListed.includes("nested/inner.txt"), false);
    assert.equal(repoListed.includes("hidden-dir"), false);
    assert.equal(repoListed.includes("visible.txt"), true);
    assert.equal(repoListed.includes("nested/visible2.txt"), true);
    const repoSearch = await invoke(repoBroker, "repo_search", "fs.search", { path: ".", pattern: "needle" });
    assert.equal(repoSearch.isError, false);
    assert.deepEqual(searchPaths(repoSearch).sort(), ["nested/visible2.txt", "visible.txt"]);
    const sameRepoSecret = sameFilesystemObject(join(repoWorkspace, "secret.txt"), join(repoWorkspace, "SECRET.txt"));
    if (sameRepoSecret) {
      const secretBlob = gitOutput(repoWorkspace, "rev-parse", ":secret.txt").trim();
      assert.match(secretBlob, /^[a-f0-9]{40,64}$/, "real indexed secret blob must be available");
      const secretMode = gitOutput(repoWorkspace, "ls-files", "-s", "secret.txt").split(/\s+/)[0]?.trim();
      assert.ok(secretMode && /^[0-7]{6}$/.test(secretMode), "real indexed secret mode must be available");
      git(repoWorkspace, "rm", "--cached", "secret.txt");
      assert.equal(existsSync(join(repoWorkspace, "secret.txt")), true, "index-only removal must preserve disk file");
      assert.equal(readFileSync(join(repoWorkspace, "secret.txt"), "utf8"), "hidden-content needle\n");
      git(repoWorkspace, "update-index", "--add", "--cacheinfo", `${secretMode},${secretBlob},SECRET.txt`);
      assert.equal(readFileSync(join(repoWorkspace, "secret.txt"), "utf8"), "hidden-content needle\n", "actual Git index alias must not rewrite disk bytes");
      assert.equal(sameFilesystemObject(join(repoWorkspace, "secret.txt"), join(repoWorkspace, "SECRET.txt")), true, "actual Git index alias keeps same dev/ino");
      const trackedSpelling = gitOutput(repoWorkspace, "ls-files").split("\n").map((line) => line.trim()).filter(Boolean);
      assert.ok(trackedSpelling.includes("SECRET.txt"), "real index must contain raw SECRET.txt");
      assert.equal(trackedSpelling.includes("secret.txt"), false, "real index must not retain old lowercase spelling");
      const aliasSnapshot = await new RepositoryIntelligence().snapshot(repoWorkspace, { maxEntries: 20000 });
      const aliasSnapshotPaths = aliasSnapshot.entries.map((entry) => entry.path);
      assert.ok(aliasSnapshotPaths.includes("SECRET.txt"), "real snapshot must contain raw SECRET.txt");
      assert.equal(aliasSnapshotPaths.includes("secret.txt"), false, "real snapshot must not contain stale lowercase");
      assert.equal(sameFilesystemObject(join(repoWorkspace, "secret.txt"), join(repoWorkspace, "SECRET.txt")), true);
      const aliasRepoList = await invoke(repoBroker, "repo_list_alias", "fs.list", { path: ".", maxDepth: 2 });
      assert.equal(aliasRepoList.isError, false);
      const aliasListed = JSON.stringify(json(aliasRepoList));
      assert.doesNotMatch(aliasListed, /SECRET\.txt/);
      assert.doesNotMatch(aliasListed, /secret\.txt/);
      assert.match(aliasListed, /visible\.txt/);
      const aliasRepoSearch = await invoke(repoBroker, "repo_search_alias", "fs.search", { path: ".", pattern: "needle" });
      assert.equal(aliasRepoSearch.isError, false);
      assert.deepEqual(searchPaths(aliasRepoSearch).sort(), ["nested/visible2.txt", "visible.txt"]);
      assert.equal(readFileSync(join(repoWorkspace, "secret.txt"), "utf8"), "hidden-content needle\n");
    } else {
      writeFileSync(join(repoWorkspace, "SECRET.txt"), "upper-distinct needle\n");
      git(repoWorkspace, "add", "SECRET.txt");
      const distinctRepoList = await invoke(repoBroker, "repo_list_distinct", "fs.list", { path: ".", maxDepth: 2 });
      assert.equal(distinctRepoList.isError, false);
      const distinctListed = (json(distinctRepoList) as { entries: Array<{ path: string }> }).entries.map((entry) => entry.path);
      assert.equal(distinctListed.includes("secret.txt"), false);
      assert.equal(distinctListed.includes("SECRET.txt"), true);
      assert.equal(distinctListed.includes("visible.txt"), true);
      const distinctRepoSearch = await invoke(repoBroker, "repo_search_distinct", "fs.search", { path: ".", pattern: "needle" });
      assert.equal(distinctRepoSearch.isError, false);
      assert.deepEqual(searchPaths(distinctRepoSearch).sort(), ["SECRET.txt", "nested/visible2.txt", "visible.txt"]);
      assert.equal(readFileSync(join(repoWorkspace, "secret.txt"), "utf8"), "hidden-content needle\n");
      const distinctRead = await invoke(repoBroker, "repo_read_distinct", "fs.read", { path: "SECRET.txt" });
      assert.equal(distinctRead.isError, false);
      assert.match(text(distinctRead), /upper-distinct/);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("policy inspection root fault injection fails closed without hidden match (error fidelity)", async () => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "aiboard-fs-policy-root-fault-")));
  const workspace = join(root, "workspace");
  mkdirSync(workspace, { recursive: true });
  writeFileSync(join(workspace, "visible.txt"), "public\n");
  writeFileSync(join(workspace, "hidden.txt"), "hidden-content\n");
  const hiddenTools = createFilesystemTools({ hiddenPaths: ["hidden.txt"] });
  const readTool = hiddenTools.find((tool) => tool.definition.name === "fs.read")!;
  const searchTool = hiddenTools.find((tool) => tool.definition.name === "fs.search")!;
  const validContext: ToolExecutionContext = {
    runId: "run_1",
    sessionId: "session_1",
    actor: { role: "worker", id: "worker_1" },
    workspacePath: workspace,
  };
  const stubEmptyRepository = {
    snapshot: async () => ({ root: workspace, source: "filesystem" as const, entries: [], truncated: false }),
  } as unknown as RepositoryIntelligence;
  const listToolsWithRepo = createFilesystemTools({ hiddenPaths: ["hidden.txt"], repository: stubEmptyRepository });
  const listToolWithRepo = listToolsWithRepo.find((tool) => tool.definition.name === "fs.list")!;
  const originalRealpath = filesystem.realpath;
  let hits = 0;
  const faultingRealpath = (async (path: unknown, ...rest: unknown[]) => {
    if (String(path) === workspace) {
      hits += 1;
      throw eaccesError(String(path));
    }
    return Reflect.apply(originalRealpath as (...args: unknown[]) => unknown, filesystem, [path, ...rest]);
  }) as typeof originalRealpath;
  (filesystem as { realpath: typeof originalRealpath }).realpath = faultingRealpath;
  syncBuiltinESMExports();
  try {
    assert.equal(namedRealpath, faultingRealpath, "production named realpath must see the injected fault");
    assert.equal(filesystem.realpath, faultingRealpath, "builtin default export must carry the injected fault");
    let readThrown: unknown;
    try {
      await readTool.execute({ path: "visible.txt" }, validContext);
    } catch (error) {
      readThrown = error;
    }
    assert.ok(readThrown instanceof Error, "root inspection fault must throw");
    assert.equal((readThrown as NodeJS.ErrnoException).code, "EACCES");
    assert.doesNotMatch((readThrown as Error).message, /hidden-content/);
    assert.doesNotMatch((readThrown as Error).message, /benchmark_hidden_path/);
    let listThrown: unknown;
    try {
      await listToolWithRepo.execute({ path: ".", maxDepth: 1 }, validContext);
    } catch (error) {
      listThrown = error;
    }
    assert.ok(listThrown instanceof Error, "root inspection fault must throw for enumeration");
    assert.equal((listThrown as NodeJS.ErrnoException).code, "EACCES");
    assert.doesNotMatch((listThrown as Error).message, /hidden-content/);
    let searchThrown: unknown;
    try {
      await searchTool.execute({ path: join(workspace, "visible.txt"), pattern: "public" }, validContext);
    } catch (error) {
      searchThrown = error;
    }
    assert.ok(searchThrown instanceof Error, "root inspection fault must throw for search");
    assert.equal((searchThrown as NodeJS.ErrnoException).code, "EACCES");
    assert.doesNotMatch((searchThrown as Error).message, /hidden-content/);
    assert.doesNotMatch((searchThrown as Error).message, /benchmark_hidden_path/);
    assert.ok(hits >= 3, `root fault helper must be reached (hits=${hits})`);
    assert.equal(readFileSync(join(workspace, "visible.txt"), "utf8"), "public\n");
    assert.equal(readFileSync(join(workspace, "hidden.txt"), "utf8"), "hidden-content\n");
    assert.equal(existsSync(workspace), true);
  } finally {
    (filesystem as { realpath: typeof originalRealpath }).realpath = originalRealpath;
    syncBuiltinESMExports();
    assert.equal(namedRealpath, originalRealpath, "post-restoration named realpath must be healthy");
    assert.equal(filesystem.realpath, originalRealpath, "post-restoration default export must be healthy");
    const restored = await namedRealpath(workspace);
    assert.equal(restored, workspace, "post-restoration realpath must resolve the valid workspace");
    rmSync(root, { recursive: true, force: true });
  }
});

test("policy inspection target fault injection fails closed without empty discovery (error fidelity)", async () => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "aiboard-fs-policy-target-fault-")));
  const workspace = join(root, "workspace");
  mkdirSync(workspace, { recursive: true });
  writeFileSync(join(workspace, "visible.txt"), "public needle\n");
  writeFileSync(join(workspace, "hidden.txt"), "hidden-content needle\n");
  writeFileSync(join(workspace, "protected.txt"), "keep\n");
  const faultTarget = "fault.txt";
  const faultBytes = "public-fault needle\n";
  writeFileSync(join(workspace, faultTarget), faultBytes);
  const absoluteFaultTarget = join(workspace, faultTarget);
  const validContext: ToolExecutionContext = {
    runId: "run_1",
    sessionId: "session_1",
    actor: { role: "worker", id: "worker_1" },
    workspacePath: workspace,
  };
  const hiddenTools = createFilesystemTools({ hiddenPaths: ["hidden.txt"] });
  const protectedTools = createFilesystemTools({ protectedPaths: ["protected.txt"] });
  const statTool = hiddenTools.find((tool) => tool.definition.name === "fs.stat")!;
  const readTool = hiddenTools.find((tool) => tool.definition.name === "fs.read")!;
  const writeTool = protectedTools.find((tool) => tool.definition.name === "fs.write")!;
  const originalRealpath = filesystem.realpath;
  let hits = 0;
  const faultingRealpath = (async (path: unknown, ...rest: unknown[]) => {
    if (String(path) === absoluteFaultTarget) {
      hits += 1;
      throw eaccesError(String(path));
    }
    return Reflect.apply(originalRealpath as (...args: unknown[]) => unknown, filesystem, [path, ...rest]);
  }) as typeof originalRealpath;
  (filesystem as { realpath: typeof originalRealpath }).realpath = faultingRealpath;
  syncBuiltinESMExports();
  try {
    assert.equal(namedRealpath, faultingRealpath, "production named realpath must see the injected fault");
    assert.equal(filesystem.realpath, faultingRealpath, "builtin default export must carry the injected fault");
    let statThrown: unknown;
    try {
      await statTool.execute({ path: faultTarget }, validContext);
    } catch (error) {
      statThrown = error;
    }
    assert.ok(statThrown instanceof Error, "target inspection fault must throw for stat");
    assert.equal((statThrown as NodeJS.ErrnoException).code, "EACCES");
    assert.doesNotMatch((statThrown as Error).message, /hidden-content/);
    assert.doesNotMatch((statThrown as Error).message, /benchmark_hidden_path/);
    let readThrown: unknown;
    try {
      await readTool.execute({ path: faultTarget }, validContext);
    } catch (error) {
      readThrown = error;
    }
    assert.ok(readThrown instanceof Error, "target inspection fault must throw for read");
    assert.equal((readThrown as NodeJS.ErrnoException).code, "EACCES");
    assert.doesNotMatch((readThrown as Error).message, /hidden-content/);
    const writeResult = await writeTool.execute({ path: faultTarget, content: "evil\n", expectedSha256: sha256(Buffer.from(faultBytes)) }, validContext);
    assert.equal(writeResult.isError, true);
    assert.equal(writeResult.error?.code, "filesystem_operation_failed");
    assert.equal((outputJson(writeResult) as { osCode: string }).osCode, "EACCES");
    assert.doesNotMatch(outputText(writeResult), /benchmark_protected_path/);
    assert.doesNotMatch(outputText(writeResult), /benchmark_hidden_path/);
    assert.doesNotMatch(outputText(writeResult), /evil/);
    assert.doesNotMatch(JSON.stringify(outputJson(writeResult)), /evil/);
    assert.equal(readFileSync(join(workspace, faultTarget), "utf8"), faultBytes);
    assert.equal(readFileSync(join(workspace, "protected.txt"), "utf8"), "keep\n");
    const stubEntries = [
      { path: "visible.txt", gitState: "tracked", kind: "source", byteLength: 0, classificationReasons: [] },
      { path: faultTarget, gitState: "tracked", kind: "source", byteLength: 0, classificationReasons: [] },
    ];
    const stubRepository = {
      snapshot: async () => ({ root: workspace, source: "filesystem" as const, entries: stubEntries, truncated: false }),
    } as unknown as RepositoryIntelligence;
    const artifacts = new ArtifactStore(join(root, "artifacts"));
    const broker = new ToolBroker({ permissionProfile: "full", workspacePath: workspace, artifacts });
    for (const tool of createFilesystemTools({ artifacts, repository: stubRepository, hiddenPaths: ["hidden.txt"] })) broker.register(tool);
    const listing = await invoke(broker, "target_fault_list", "fs.list", { path: ".", maxDepth: 2 });
    assert.equal(listing.isError, true);
    assert.equal(listing.error?.code, "tool_execution_failed");
    assert.match(text(listing), /EACCES/);
    assert.notEqual(listing.error?.code, "benchmark_hidden_path");
    assert.notEqual(listing.error?.code, "benchmark_protected_path");
    assert.equal(json(listing), undefined);
    assert.doesNotMatch(text(listing), /hidden-content/);
    assert.doesNotMatch(text(listing), /public needle/);
    assert.doesNotMatch(text(listing), /public-fault needle/);
    const search = await invoke(broker, "target_fault_search", "fs.search", { path: ".", pattern: "needle" });
    assert.equal(search.isError, true);
    assert.equal(search.error?.code, "tool_execution_failed");
    assert.match(text(search), /EACCES/);
    assert.notEqual(search.error?.code, "benchmark_hidden_path");
    assert.equal(json(search), undefined);
    assert.doesNotMatch(text(search), /hidden-content/);
    assert.doesNotMatch(text(search), /public needle/);
    assert.doesNotMatch(text(search), /public-fault needle/);
    assert.ok(hits >= 5, `target fault helper must be reached (hits=${hits})`);
    assert.equal(readFileSync(join(workspace, "visible.txt"), "utf8"), "public needle\n");
    assert.equal(readFileSync(join(workspace, "hidden.txt"), "utf8"), "hidden-content needle\n");
    assert.equal(readFileSync(join(workspace, "protected.txt"), "utf8"), "keep\n");
    assert.equal(readFileSync(join(workspace, faultTarget), "utf8"), faultBytes);
  } finally {
    (filesystem as { realpath: typeof originalRealpath }).realpath = originalRealpath;
    syncBuiltinESMExports();
    assert.equal(namedRealpath, originalRealpath, "post-restoration named realpath must be healthy");
    assert.equal(filesystem.realpath, originalRealpath, "post-restoration default export must be healthy");
    const restored = await namedRealpath(absoluteFaultTarget);
    assert.equal(restored, absoluteFaultTarget, "post-restoration realpath must resolve the valid target");
    rmSync(root, { recursive: true, force: true });
  }
});

function sameFilesystemObject(lowerPath: string, upperPath: string): boolean {
  try {
    const lower = statSync(lowerPath, { bigint: true });
    const upper = statSync(upperPath, { bigint: true });
    return lower.dev === upper.dev && lower.ino === upper.ino;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function eaccesError(path: string): NodeJS.ErrnoException {
  const error = new Error(`EACCES: permission denied, realpath '${path}'`) as NodeJS.ErrnoException;
  error.code = "EACCES";
  return error;
}

function brokerWithFilesystem(
  workspace: string,
  artifacts: ArtifactStore,
  diagnostics?: Pick<TypeScriptIntelligence, "diagnostics">,
): ToolBroker {
  const broker = new ToolBroker({
    permissionProfile: "full",
    workspacePath: workspace,
    artifacts,
  });
  for (const tool of createFilesystemTools({
    artifacts,
    repository: new RepositoryIntelligence(),
    ...(diagnostics ? { diagnostics } : {}),
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

function gitOutput(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: "pipe", windowsHide: true }) as unknown as string;
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

function outputText(result: Pick<ToolResult, "content">): string {
  return result.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

function outputJson(result: Pick<ToolResult, "content">): unknown {
  return result.content.find((block) => block.type === "json")?.value;
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}
