import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import { ArtifactStore } from "../src/artifact-store.js";
import {
  captureCommandOutputs,
  COMMAND_OUTPUT_LIMITS,
  commandOutputArtifactHashes,
  normalizeOutputPatterns,
  outputCaptureBlocker,
} from "../src/command-output-files.js";
import { encodePng, IMAGE_LIMITS } from "../src/image-inspection.js";

function png(width = 2, height = 2): Buffer {
  return encodePng({ width, height, data: new Uint8Array(width * height * 4).fill(200) });
}

function fixture() {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "aiboard-outputs-")));
  const workspace = join(root, "workspace");
  const outside = join(root, "outside");
  mkdirSync(workspace, { recursive: true });
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(outside, "secret.txt"), "outside secret");
  const artifacts = new ArtifactStore(join(root, "artifacts"));
  const write = (path: string, bytes: string | Buffer) => {
    const target = join(workspace, ...path.split("/"));
    mkdirSync(join(target, ".."), { recursive: true });
    writeFileSync(target, bytes);
  };
  const capture = (patterns: string[], extra: Partial<Parameters<typeof captureCommandOutputs>[0]> = {}) =>
    captureCommandOutputs({ workspace, patterns, artifacts, label: "check", ...extra });
  return { root, workspace, outside, artifacts, write, capture, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

/** A file or directory symlink; skipped where the OS refuses unprivileged symlinks. */
function symlinkOrSkip(t: TestContext, target: string, path: string, type: "file" | "dir"): boolean {
  try {
    symlinkSync(target, path, type);
    return true;
  } catch (error) {
    if (process.platform === "win32" && (error as NodeJS.ErrnoException).code === "EPERM") {
      t.skip("symlinks need Developer Mode or elevation on this Windows host");
      return false;
    }
    throw error;
  }
}

test("the caps are explicit constants", () => {
  assert.deepEqual({ ...COMMAND_OUTPUT_LIMITS }, {
    maxPatterns: 16,
    maxPatternLength: 256,
    maxFiles: 32,
    maxFileBytes: IMAGE_LIMITS.maxSourceBytes,
    maxTotalBytes: 64 * 1024 * 1024,
    maxScanEntries: 10_000,
  });
  assert.ok(COMMAND_OUTPUT_LIMITS.maxFileBytes <= COMMAND_OUTPUT_LIMITS.maxTotalBytes);
});

test("output patterns are workspace-relative: .., absolute, drive, UNC, home and ':' paths are refused before running", () => {
  for (const refused of [
    "../escape.txt", "a/../../escape.txt", "a/..", "..\\escape.txt",
    "/etc/passwd", "\\\\server\\share\\x", "//server/share/x", "C:/Windows/win.ini", "C:relative.txt", "c:\\x",
    "~/screens/x.png", "file.txt:stream", ".", "./", "./.",
  ]) {
    const result = normalizeOutputPatterns([refused]);
    assert.equal(result.ok, false, `${refused} must be refused`);
  }
  assert.equal(normalizeOutputPatterns("shot.png").ok, false, "a string is not a list");
  assert.equal(normalizeOutputPatterns([""]).ok, false);
  assert.equal(normalizeOutputPatterns(["a\u0000b"]).ok, false);
  assert.equal(normalizeOutputPatterns(["x".repeat(COMMAND_OUTPUT_LIMITS.maxPatternLength + 1)]).ok, false);
  assert.equal(normalizeOutputPatterns(Array.from({ length: COMMAND_OUTPUT_LIMITS.maxPatterns + 1 }, (_, i) => `f${i}`)).ok, false);
  assert.equal(normalizeOutputPatterns(["shots/{a,b.png"]).ok, false, "an unbalanced glob is refused");
  assert.deepEqual(normalizeOutputPatterns(["./out\\shot.png", "out/shot.png", "reports//**/*.xml", "a/./b"]), {
    ok: true,
    patterns: ["out/shot.png", "reports/**/*.xml", "a/b"],
  });
  assert.deepEqual(normalizeOutputPatterns([]), { ok: true, patterns: [] });
});

test("files are read only after the process tree is verified gone, and never for a reused result", () => {
  const ended = { cleanup: { state: "verified_empty" } };
  for (const outcome of ["exited", "timed_out", "cancelled"]) assert.equal(outputCaptureBlocker({ outcome, ...ended }), undefined);
  assert.equal(outputCaptureBlocker({ outcome: "exited", cleanup: { state: "pending" } }), "process_not_proven_ended");
  assert.equal(outputCaptureBlocker({ outcome: "exited", cleanup: { state: "failed" } }), "process_not_proven_ended");
  assert.equal(outputCaptureBlocker({ outcome: "launch_failed", cleanup: { state: "not_required" } }), "process_not_proven_ended");
  assert.equal(outputCaptureBlocker({ outcome: "cleanup_failed", cleanup: { state: "failed" } }), "process_not_proven_ended");
  assert.equal(outputCaptureBlocker({ outcome: "exited", ...ended, reused: true }), "reused_execution");
});

test("literal paths and globs are stored as artifacts; a path that matches nothing is missing, not an error", async () => {
  const f = fixture();
  try {
    const image = png(4, 3);
    f.write("test-results/run-1/shot.png", image);
    f.write("test-results/run-2/shot.png", png(2, 2));
    f.write("test-results/run-2/notes.txt", "not a png");
    f.write("report.xml", "<testsuite/>");
    f.write("misnamed.png", "plain text with an image name");
    f.write(".git/hooks/shot.png", image);
    f.write("node_modules/pkg/shot.png", image);
    mkdirSync(join(f.workspace, "empty-dir"));
    const capture = await f.capture(["test-results/**/*.png", "report.xml", "misnamed.png", "logs/*.log", "absent.txt", "empty-dir", "**/shot.png"]);
    assert.deepEqual(capture.requested, ["test-results/**/*.png", "report.xml", "misnamed.png", "logs/*.log", "absent.txt", "empty-dir", "**/shot.png"]);
    assert.deepEqual(capture.files.map((file) => [file.path, file.mediaType]), [
      ["test-results/run-1/shot.png", "image/png"],
      ["test-results/run-2/shot.png", "image/png"],
      ["report.xml", "application/xml"],
      // Content decides: a text file named .png is not an image.
      ["misnamed.png", "application/octet-stream"],
    ]);
    assert.deepEqual(capture.missing, ["logs/*.log", "absent.txt"]);
    // A literal path naming a folder is reported; wildcards never enter .git or node_modules.
    assert.deepEqual(capture.refused, [{ path: "empty-dir", reason: "not_a_file" }]);
    const first = capture.files[0]!;
    assert.equal(first.byteLength, image.byteLength);
    assert.deepEqual(await f.artifacts.get(first.artifactHash), image);
    assert.equal((await f.artifacts.stat(first.artifactHash)).mediaType, "image/png");
    assert.deepEqual(commandOutputArtifactHashes(capture), capture.files.map((file) => file.artifactHash));
    assert.deepEqual(commandOutputArtifactHashes(undefined), []);
  } finally { f.cleanup(); }
});

test("a trailing ** keeps every file below a folder", async () => {
  const f = fixture();
  try {
    f.write("reports/a.json", "{}");
    f.write("reports/deep/b.log", "log");
    const capture = await f.capture(["reports/**"]);
    assert.deepEqual(capture.files.map((file) => file.path), ["reports/a.json", "reports/deep/b.log"]);
    assert.deepEqual(capture.missing, []);
  } finally { f.cleanup(); }
});

test("a symlinked file that leads out of the workspace is refused, and one inside is read", async (t) => {
  const f = fixture();
  try {
    f.write("inside.txt", "inside");
    if (!symlinkOrSkip(t, join(f.outside, "secret.txt"), join(f.workspace, "escape.txt"), "file")) return;
    if (!symlinkOrSkip(t, join(f.workspace, "inside.txt"), join(f.workspace, "alias.txt"), "file")) return;
    const capture = await f.capture(["escape.txt", "*.txt"]);
    assert.deepEqual(capture.files.map((file) => file.path), ["alias.txt", "inside.txt"]);
    assert.deepEqual(capture.refused, [{ path: "escape.txt", reason: "outside_workspace" }]);
    for (const file of capture.files) assert.equal((await f.artifacts.get(file.artifactHash)).toString(), "inside");
    assert.equal(capture.files.some((file) => file.path === "escape.txt"), false);
  } finally { f.cleanup(); }
});

test("a symlinked directory that leads out is refused as a literal step and never entered by a wildcard", async (t) => {
  const f = fixture();
  try {
    if (!symlinkOrSkip(t, f.outside, join(f.workspace, "linked"), "dir")) return;
    const capture = await f.capture(["linked/secret.txt", "linked/*.txt", "**/*.txt"]);
    assert.deepEqual(capture.files, []);
    assert.deepEqual(capture.refused, [{ path: "linked", reason: "outside_workspace" }]);
    assert.deepEqual(capture.missing, ["**/*.txt"]);
  } finally { f.cleanup(); }
});

test("a junction that leads out is refused (a directory symlink off Windows)", async () => {
  const f = fixture();
  try {
    // "junction" needs no privilege on Windows; elsewhere Node creates a directory symlink.
    symlinkSync(f.outside, join(f.workspace, "junction"), "junction");
    const capture = await f.capture(["junction/secret.txt", "junction/**", "*/secret.txt"]);
    assert.deepEqual(capture.files, []);
    assert.deepEqual(capture.refused, [{ path: "junction", reason: "outside_workspace" }]);
    assert.deepEqual(capture.missing, ["*/secret.txt"], "a wildcard does not step through a junction");
  } finally { f.cleanup(); }
});

test("file count, per-file and total size caps refuse the overflow and keep the rest", async () => {
  const f = fixture();
  try {
    for (let index = 0; index < 5; index += 1) f.write(`many/f${index}.txt`, "x".repeat(10));
    const counted = await f.capture(["many/*.txt"], { limits: { maxFiles: 3 } });
    assert.deepEqual(counted.files.map((file) => file.path), ["many/f0.txt", "many/f1.txt", "many/f2.txt"]);
    assert.deepEqual(counted.refused, [
      { path: "many/f3.txt", reason: "file_cap", byteLength: 10 },
      { path: "many/f4.txt", reason: "file_cap", byteLength: 10 },
    ]);

    f.write("big.bin", Buffer.alloc(101));
    f.write("small.bin", Buffer.alloc(100));
    const sized = await f.capture(["big.bin", "small.bin"], { limits: { maxFileBytes: 100 } });
    assert.deepEqual(sized.files.map((file) => file.path), ["small.bin"]);
    assert.deepEqual(sized.refused, [{ path: "big.bin", reason: "file_too_large", byteLength: 101 }]);

    const total = await f.capture(["many/*.txt"], { limits: { maxTotalBytes: 25 } });
    assert.deepEqual(total.files.map((file) => file.path), ["many/f0.txt", "many/f1.txt"]);
    assert.deepEqual(total.refused?.map((refusal) => refusal.reason), ["total_size_cap", "total_size_cap", "total_size_cap"]);

    // A caller may only tighten the bounds.
    const loose = await f.capture(["big.bin"], { limits: { maxFileBytes: COMMAND_OUTPUT_LIMITS.maxFileBytes * 4 } });
    assert.equal(loose.files.length, 1);
  } finally { f.cleanup(); }
});

test("the default per-file cap refuses a file above it without reading it", async () => {
  const f = fixture();
  try {
    f.write("huge.bin", Buffer.alloc(COMMAND_OUTPUT_LIMITS.maxFileBytes + 1));
    const capture = await f.capture(["huge.bin"]);
    assert.deepEqual(capture.files, []);
    assert.deepEqual(capture.refused, [{ path: "huge.bin", reason: "file_too_large", byteLength: COMMAND_OUTPUT_LIMITS.maxFileBytes + 1 }]);
  } finally { f.cleanup(); }
});

test("an exhausted directory scan is reported, never called missing", async () => {
  const f = fixture();
  try {
    for (let index = 0; index < 6; index += 1) f.write(`wide/d${index}/x.txt`, "x");
    f.write("literal.txt", "literal");
    const capture = await f.capture(["wide/**/*.log", "literal.txt"], { limits: { maxScanEntries: 4 } });
    assert.deepEqual(capture.missing, []);
    assert.deepEqual(capture.refused, [{ path: "wide/**/*.log", reason: "scan_cap" }]);
    assert.deepEqual(capture.files.map((file) => file.path), ["literal.txt"], "a literal path needs no scan");
  } finally { f.cleanup(); }
});

test("hidden paths are refused and files matched twice are stored once", async () => {
  const f = fixture();
  try {
    f.write("hidden/answer.txt", "hidden");
    f.write("shown.txt", "shown");
    const capture = await f.capture(["hidden/answer.txt", "*.txt", "shown.txt"], {
      isHidden: async (path) => path.replace(/\\/g, "/").includes("/hidden/"),
    });
    assert.deepEqual(capture.files.map((file) => file.path), ["shown.txt"]);
    assert.deepEqual(capture.refused, [{ path: "hidden/answer.txt", reason: "hidden" }]);
  } finally { f.cleanup(); }
});

test("a FIFO is not a regular file and is never opened", { skip: process.platform === "win32" ? "no FIFOs on Windows" : false }, async () => {
  const f = fixture();
  try {
    execFileSync("mkfifo", [join(f.workspace, "pipe.log")]);
    const capture = await f.capture(["pipe.log"]);
    assert.deepEqual(capture.files, []);
    assert.deepEqual(capture.refused, [{ path: "pipe.log", reason: "not_a_file" }]);
  } finally { f.cleanup(); }
});
