import assert from "node:assert/strict";
import test from "node:test";
import { parseProcessOutputDisposition } from "../src/execution-safety-contracts.js";
import { GitCommandError } from "../src/git-command.js";
import { createRuntimeGitCommandRunner } from "../src/git-runtime-runner.js";

const base = { stream: "stdout" as const, tail: "display is not byte authority", totalBytes: 6, truncated: false, spillBytes: 0, lossyBytes: 6 };
const bytes = Buffer.from([0, 255, 254, 128, 13, 10]);
const exact = { ...base, tailBytesBase64: bytes.toString("base64"), tailByteLength: bytes.length };

test("binary output retains optional exact tail bytes while preserving truthful diagnostic spill loss", () => {
  assert.deepEqual(parseProcessOutputDisposition(exact), exact);
  assert.deepEqual(parseProcessOutputDisposition(base), base, "legacy output records remain readable without invented bytes");
  const empty = { ...base, totalBytes: 0, lossyBytes: 0, tailBytesBase64: "", tailByteLength: 0 };
  assert.deepEqual(parseProcessOutputDisposition(empty), empty);
});

for (const [name, update] of [
  ["missing-length", { tailByteLength: undefined }],
  ["missing-bytes", { tailBytesBase64: undefined }],
  ["invalid-alphabet", { tailBytesBase64: "!!invalid!!" }],
  ["noncanonical-padding", { tailBytesBase64: bytes.toString("base64") + "=" }],
  ["length-mismatch", { tailByteLength: 5 }],
  ["larger-than-total", { totalBytes: 5 }],
  ["false-complete", { totalBytes: 7 }],
  ["false-truncated", { truncated: true }],
  ["oversized-tail", { tailByteLength: 131_073, totalBytes: 131_073, tailBytesBase64: Buffer.alloc(131_073).toString("base64") }],
] as const) {
  test(`binary output refuses ${name} metadata`, () => {
    assert.throws(() => parseProcessOutputDisposition({ ...exact, ...update }));
  });
}

test("binary output accepts a bounded suffix without mistaking it for complete output", () => {
  const suffix = { ...exact, totalBytes: 20, truncated: true };
  assert.deepEqual(parseProcessOutputDisposition(suffix), suffix);
});

function runner(stream: typeof base & { tailBytesBase64?: string; tailByteLength?: number }) {
  let released = false;
  const git = createRuntimeGitCommandRunner({
    runId: "run", executable: "git", timeoutMs: 100,
    authorize: async () => ({ context: { runId: "run", sessionId: "session", actor: { role: "worker", id: "worker" }, callId: "call", toolName: "git.show" }, release: () => { released = true; } }),
    execution: { execute: async () => ({ enforcement: "unconfined_explicit_full", disclosure: "unconfined_explicit_full",
      process: { logicalProcessId: "test-process", outcome: "exited", exitCode: 0, finishedAt: "2026-09-11T00:00:00.000Z",
        cleanup: { state: "verified_empty", verifiedAt: "2026-09-11T00:00:00.000Z" },
        output: [stream, { stream: "stderr", tail: "", totalBytes: 0, truncated: false, spillBytes: 0, lossyBytes: 0 }] } }) },
    artifacts: { stat: async () => assert.fail("complete exact tail needs no artifact allocation"), get: async () => assert.fail("display/spill fallback cannot invent binary bytes") },
  });
  return { git, released: () => released };
}

test("Git returns a complete exact binary tail when private diagnostic spill is unavailable", async () => {
  const f = runner(exact);
  const result = await f.git.runBytes({ cwd: "C:/synthetic-owned", args: ["show"] });
  assert.deepEqual(result.stdout, bytes);
  assert.equal(f.released(), true);
});

for (const [name, stream] of [
  ["incomplete-suffix", { ...exact, totalBytes: 20, truncated: true }],
  ["malformed-bytes", { ...exact, tailBytesBase64: "!!!" }],
  ["display-only", base],
  ["inconsistent-length", { ...exact, tailByteLength: 5 }],
] as const) {
  test(`Git fails closed for ${name} instead of reconstructing bytes from UTF8 display`, async () => {
    const f = runner(stream);
    await assert.rejects(f.git.runBytes({ cwd: "C:/synthetic-owned", args: ["show"] }),
      (error: unknown) => error instanceof GitCommandError && error.code === "output_limit");
    assert.equal(f.released(), true);
  });
}

test("Git applies the caller byte limit even when the entire exact tail is present", async () => {
  const f = runner(exact);
  await assert.rejects(f.git.runBytes({ cwd: "C:/synthetic-owned", args: ["show"], maxOutputBytes: 5 }),
    (error: unknown) => error instanceof GitCommandError && error.code === "output_limit");
  assert.equal(f.released(), true);
});
