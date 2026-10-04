import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ToolBroker } from "../src/tool-broker.js";
import { createFilesystemTools } from "../src/filesystem-tools.js";
import { inspectEncodingDelta, preserveUtf8Bom, captureEncodingSubmission, validateEncodingSubmission, encodingFindingFacts, type EncodingFindingCode } from "../src/encoding-safety.js";
import { runGit, runGitBytes } from "./support/git-fixture.js";
import { rebuildSchedulerProjection } from "../src/scheduler-store.js";

for (const operation of ["fs.patch", "fs.write"] as const) {
  test(`E4 ${operation} preserves an existing UTF-8 BOM and CRLF through real authorization`, async () => {
    const root = mkdtempSync(join(tmpdir(), "aiboard-e4-bom-"));
    const workspace = join(root, "workspace"); mkdirSync(workspace);
    const path = join(workspace, "value.txt");
    const original = Buffer.from("\ufeffcaf\u00e9 = 1;\r\nsecond line\r\n");
    const expected = Buffer.from("\ufeffcaf\u00e9 = 2;\r\nsecond line\r\n");
    writeFileSync(path, original);
    const broker = new ToolBroker({ permissionProfile: "full", workspacePath: workspace });
    for (const tool of createFilesystemTools()) broker.register(tool);
    try {
      const result = await broker.invoke({ type: "tool_call", callId: "e4-write", name: operation,
        arguments: { path: "value.txt", expectedSha256: createHash("sha256").update(original).digest("hex"),
          ...(operation === "fs.patch" ? { search: "caf\u00e9 = 1;\nsecond line", replace: "caf\u00e9 = 2;\nsecond line" } : { content: "caf\u00e9 = 2;\r\nsecond line\r\n" }) } },
      { runId: "e4-bom", sessionId: "s1", actor: { role: "worker", id: "w1" } });
      assert.equal(result.isError, false);
      assert.deepEqual(readFileSync(path), expected);
      const metadata = result.content.find((block) => block.type === "json")?.value as { sha256: string; byteLength: number };
      assert.equal(metadata.sha256, createHash("sha256").update(expected).digest("hex"));
      assert.equal(metadata.byteLength, expected.length);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
}

test("E4 each encoding damage class has a mechanical finding, with clean and pre-existing controls", () => {
  const cases: Array<[EncodingFindingCode, Buffer | null, Buffer]> = [
    ["bom_added", Buffer.from("a\n"), Buffer.from("\ufeffa\n")],
    ["bom_removed", Buffer.from("\ufeffa\n"), Buffer.from("a\n")],
    ["line_endings_flipped", Buffer.from("a\r\nb\r\n"), Buffer.from("a\nb\n")],
    ["mixed_endings_introduced", Buffer.from("a\r\nb\r\n"), Buffer.from("a\r\nb\n")],
    ["replacement_character", Buffer.from("a\n"), Buffer.from("a\n\ufffd\n")],
    ["mojibake", Buffer.from("a\n"), Buffer.from("a\n\u00e2\u20ac\u201d\n")],
    ["invalid_utf8", Buffer.from("a\n"), Buffer.from([0x61, 0x0a, 0xc3, 0x28])],
  ];
  for (const [code, before, after] of cases) assert.ok(inspectEncodingDelta("file.txt", before, after)!.codes.includes(code), code);
  for (const marker of ["\u00c3", "\u00c2"]) assert.ok(inspectEncodingDelta("file.txt", null, Buffer.from(marker))!.codes.includes("mojibake"));
  assert.deepEqual(inspectEncodingDelta("file.txt", Buffer.from("a\n"), Buffer.from("b\n"))!.codes, []);
  assert.deepEqual(inspectEncodingDelta("file.txt", Buffer.from("\ufffd\n\u00e2\u20ac\u201d\nold\r\n"), Buffer.from("\ufffd\n\u00e2\u20ac\u201d\nnew\r\n"))!.codes, []);
  assert.equal(inspectEncodingDelta("photo.bin", null, Buffer.from([0, 0xff, 0x80])), undefined);
  assert.ok(inspectEncodingDelta("file.txt", null, Buffer.from([0, 0x61]))!.codes.includes("invalid_utf8"));
  assert.ok(inspectEncodingDelta("file.txt", null, Buffer.from("\ufeffnew"))!.codes.includes("bom_added"));
  assert.deepEqual(preserveUtf8Bom(Buffer.from("plain"), Buffer.from("plain")), Buffer.from("plain"));
  assert.deepEqual(preserveUtf8Bom(Buffer.from("\ufeffold"), Buffer.from("\ufeffnew")), Buffer.from("\ufeffnew"));
});

test("E4 immutable Git bytes expose invalid UTF-8 and line flips despite dirty checkout/index", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-e4-git-")); const project = join(root, "project"); mkdirSync(project);
  const git = (args: string[]) => runGit({ cwd: project, args });
  try {
    await git(["init"]); await git(["config", "core.autocrlf", "false"]);
    writeFileSync(join(project, "file.txt"), "before\r\n"); await git(["add", "-A"]); await git(["commit", "-m", "baseline"]);
    const baseline = (await git(["rev-parse", "HEAD"])).stdout.trim();
    writeFileSync(join(project, "file.txt"), Buffer.from([0x61, 0x0a, 0xc3, 0x28])); await git(["add", "-A"]); await git(["commit", "-m", "candidate"]);
    const revision = (await git(["rev-parse", "HEAD"])).stdout.trim();
    writeFileSync(join(project, "file.txt"), "clean\r\n"); await git(["add", "-A"]);
    const record = await captureEncodingSubmission({ git: runGit, gitBytes: runGitBytes, workspacePath: project, runId: "e4-bytes", taskId: "T1", baselineRevision: baseline, taskRevision: revision });
    assert.deepEqual(record.files[0]!.codes, ["invalid_utf8"]);
    assert.equal(record.files[0]!.candidateSha256, createHash("sha256").update(Buffer.from([0x61, 0x0a, 0xc3, 0x28])).digest("hex"));
    const copy = validateEncodingSubmission(record, record); copy.files[0]!.codes.length = 0;
    assert.deepEqual(record.files[0]!.codes, ["invalid_utf8"]);
    assert.throws(() => validateEncodingSubmission({ ...record, taskRevision: baseline }, record), /exact runner authority/);
    assert.throws(() => validateEncodingSubmission({ ...record, files: [{ ...record.files[0], codes: ["invented"] }] }, record), /exact runner authority/);
    assert.match(encodingFindingFacts(record)[0]!.id, /^submission-encoding:/);
    await git(["commit", "-m", "valid clean bytes"]); const cleanRevision = (await git(["rev-parse", "HEAD"])).stdout.trim();
    assert.deepEqual((await captureEncodingSubmission({ git: runGit, gitBytes: runGitBytes, workspacePath: project, runId: "e4-bytes", taskId: "T1", baselineRevision: baseline, taskRevision: cleanRevision })).files[0]!.codes, []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("E4 text classification catches extensionless UTF-16 damage and binary-to-text conversion without flagging PDFs", () => {
  for (const path of [".editorconfig", ".npmrc", "LICENSE"]) {
    assert.ok(inspectEncodingDelta(path, Buffer.from("setting=true\n"), Buffer.from("setting=true\n", "utf16le"))?.codes.includes("invalid_utf8"), path);
  }
  assert.ok(inspectEncodingDelta("unknown.data", Buffer.from([0, 0xff]), Buffer.from("\ufeff\u00e2\u20ac\u201d\r\nnext\n"))?.codes.includes("mojibake"));
  assert.equal(inspectEncodingDelta("manual.pdf", null, Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37, 0x0a, 0x25, 0xe2, 0xe3, 0xcf, 0xd3])), undefined);
});

test("E4 moved suspicious lines remain added-line encoding findings", () => {
  for (const marker of ["\ufffd", "\u00e2\u20ac\u201d"]) {
    const before = Buffer.from(`${marker}\na\nb\nc\n`); const after = Buffer.from(`a\nb\nc\n${marker}\n`);
    assert.ok(inspectEncodingDelta("file.txt", before, after)!.codes.includes(marker === "\ufffd" ? "replacement_character" : "mojibake"));
  }
});

test("E4 immutable Git added hunks catch moved damaged lines and ignore untouched damaged lines", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-e4-hunks-")); mkdirSync(join(root, "project")); const project = join(root, "project");
  const git = (args: string[]) => runGit({ cwd: project, args });
  try {
    await git(["init"]); await git(["config", "core.autocrlf", "false"]);
    for (const marker of ["\ufffd", "\u00e2\u20ac\u201d"]) {
      writeFileSync(join(project, "move.txt"), `${marker}\na\nb\nc\n`); await git(["add", "-A"]); await git(["commit", "-m", "before"]);
      const baseline = (await git(["rev-parse", "HEAD"])).stdout.trim();
      writeFileSync(join(project, "move.txt"), `a\nb\nc\n${marker}\n`); await git(["add", "-A"]); await git(["commit", "-m", "move"]);
      const revision = (await git(["rev-parse", "HEAD"])).stdout.trim();
      const capture = (base: string, rev: string) => captureEncodingSubmission({ git: runGit, gitBytes: runGitBytes, workspacePath: project, runId: "e4-hunks", taskId: "T1", baselineRevision: base, taskRevision: rev });
      assert.ok((await capture(baseline, revision)).files[0]!.codes.includes(marker === "\ufffd" ? "replacement_character" : "mojibake"));
      writeFileSync(join(project, "move.txt"), `edited\nb\nc\n${marker}\n`); await git(["add", "-A"]); await git(["commit", "-m", "untouched damage control"]);
      const control = (await git(["rev-parse", "HEAD"])).stdout.trim();
      assert.deepEqual((await capture(revision, control)).files[0]!.codes, []);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("E4 legacy initialization keeps absent policy shape and activated invalid version is refused", () => {
  const event = { runId: "e4-legacy", eventId: "init", sequence: 1, type: "run.initialized" as const, occurredAt: "2026-10-04T00:00:00Z", actor: { role: "runner" as const, id: "build-runtime" }, idempotencyKey: "init", payload: {} };
  assert.equal(Object.hasOwn(rebuildSchedulerProjection([event]), "encodingSafetyPolicyVersion"), false);
  assert.equal(rebuildSchedulerProjection([{ ...event, payload: { encodingSafetyPolicyVersion: 1 } }]).encodingSafetyPolicyVersion, 1);
  assert.throws(() => rebuildSchedulerProjection([{ ...event, payload: { encodingSafetyPolicyVersion: 2 } }]), /Invalid encoding-safety/);
});
