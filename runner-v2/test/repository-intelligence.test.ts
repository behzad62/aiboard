import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { RepositoryIntelligence } from "../src/repository-intelligence.js";

test("repository snapshots follow Git ignore rules and classify retained files", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-repository-intelligence-"));
  try {
    git(root, "init");
    mkdirSync(join(root, "assets"), { recursive: true });
    mkdirSync(join(root, "dist"), { recursive: true });
    mkdirSync(join(root, "src"), { recursive: true });
    mkdirSync(join(root, "vendor"), { recursive: true });
    writeFileSync(join(root, ".gitignore"), "dist/*\n!dist/keep.ts\n");
    writeFileSync(join(root, "assets", "blob.bin"), Buffer.from([0, 1, 2, 255]));
    writeFileSync(join(root, "dist", "ignored.js"), "const ignored = true;\n");
    writeFileSync(join(root, "dist", "keep.ts"), "// @generated\nexport const kept = true;\n");
    writeFileSync(join(root, "dist", "tracked.generated.ts"), "// @generated\nexport const generated = true;\n");
    writeFileSync(join(root, "src", "app.ts"), "export const app = true;\n");
    writeFileSync(join(root, "src", "extra.ts"), "export const extra = true;\n");
    writeFileSync(join(root, "vendor", "library.js"), "export const library = true;\n");
    git(root, "add", ".gitignore", "src/app.ts", "vendor/library.js", "dist/keep.ts");
    git(root, "add", "-f", "dist/tracked.generated.ts");

    const intelligence = new RepositoryIntelligence();
    const snapshot = await intelligence.snapshot(root);

    assert.equal(snapshot.source, "git");
    assert.deepEqual(snapshot.entries.map((entry) => entry.path), [
      ".gitignore",
      "assets/blob.bin",
      "dist/keep.ts",
      "dist/tracked.generated.ts",
      "src/app.ts",
      "src/extra.ts",
      "vendor/library.js",
    ]);
    assert.equal(entry(snapshot, "assets/blob.bin").kind, "binary");
    assert.equal(entry(snapshot, "dist/keep.ts").kind, "generated");
    assert.equal(entry(snapshot, "dist/tracked.generated.ts").kind, "generated");
    assert.equal(entry(snapshot, "vendor/library.js").kind, "vendored");
    assert.equal(entry(snapshot, "src/app.ts").gitState, "tracked");
    assert.equal(entry(snapshot, "src/extra.ts").gitState, "untracked");
    assert.equal(snapshot.entries.some((item) => item.path === "dist/ignored.js"), false);

    const withIgnored = await intelligence.snapshot(root, { includeIgnored: true });
    assert.equal(entry(withIgnored, "dist/ignored.js").gitState, "ignored");
    assert.ok(
      entry(withIgnored, "dist/ignored.js").classificationReasons.includes("git:ignored"),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("repository manifests paginate deterministically and maps cite source paths", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-repository-map-"));
  try {
    git(root, "init");
    mkdirSync(join(root, "src"), { recursive: true });
    mkdirSync(join(root, "test"), { recursive: true });
    writeFileSync(join(root, "package.json"), '{"name":"fixture"}\n');
    writeFileSync(join(root, "src", "app.ts"), "export const app = true;\n");
    writeFileSync(join(root, "src", "worker.ts"), "export const worker = true;\n");
    writeFileSync(join(root, "test", "app.test.ts"), "export const tested = true;\n");
    git(root, "add", ".");

    const intelligence = new RepositoryIntelligence();
    const snapshot = await intelligence.snapshot(root);
    const page = await intelligence.manifest(root, { cursor: "1", pageSize: 2 });

    assert.equal(page.source, "git");
    assert.deepEqual(page.entries, snapshot.entries.slice(1, 3));
    assert.equal(page.nextCursor, "3");
    assert.equal(page.totals.gitState.tracked, 4);
    assert.equal(page.totals.kind.source, 2);
    assert.equal(page.totals.kind.test, 1);

    const map = await intelligence.map(root);
    assert.deepEqual(map.configurationFiles, ["package.json"]);
    assert.deepEqual(map.sourceRoots, [{
      path: "src",
      sources: ["src/app.ts", "src/worker.ts"],
    }]);
    assert.deepEqual(map.testRoots, [{
      path: "test",
      sources: ["test/app.test.ts"],
    }]);
    assert.equal(map.languages.typescript, 3);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("repository snapshots report bounded filesystem fallback semantics", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-repository-fallback-"));
  try {
    mkdirSync(join(root, "node_modules", "dependency"), { recursive: true });
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "node_modules", "dependency", "index.js"), "ignored\n");
    writeFileSync(join(root, "src", "app.ts"), "export const app = true;\n");
    writeFileSync(join(root, "README.md"), "# Fixture\n");

    const snapshot = await new RepositoryIntelligence().snapshot(root);

    assert.equal(snapshot.source, "filesystem");
    assert.deepEqual(snapshot.entries.map((item) => item.path), ["README.md", "src/app.ts"]);
    assert.equal(snapshot.entries.every((item) => item.gitState === "not_applicable"), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function entry(
  snapshot: Awaited<ReturnType<RepositoryIntelligence["snapshot"]>>,
  path: string,
) {
  const result = snapshot.entries.find((item) => item.path === path);
  assert.ok(result, `missing repository entry ${path}`);
  return result;
}

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "pipe", windowsHide: true });
}
