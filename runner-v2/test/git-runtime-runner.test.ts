import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createRuntimeGitCommandRunner } from "../src/git-runtime-runner.js";
import { GitCommandError } from "../src/git-command.js";
import type { ArtifactStore } from "../src/artifact-store.js";
import type { OneShotCommandRequest, OneShotCommandResult } from "../src/one-shot-command-executor.js";

const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const at = "2026-09-11T00:00:00.000Z";
const cwd = "C:/synthetic-owned/project";
const binding = { runId: "run-a", sessionId: "agent-a", actor: { role: "worker" as const, id: "worker-a" }, callId: "call-a", toolName: "git.show" };
function fixture(stdout = Buffer.from("one\n"), stderr = Buffer.alloc(0)) {
  const records = new Map([[sha(stdout), stdout], [sha(stderr), stderr]]);
  const calls: string[] = []; const requests: OneShotCommandRequest[] = [];
  const outcome: OneShotCommandResult = {
    process: { logicalProcessId: "owned-process", outcome: "exited", exitCode: 0, finishedAt: at,
      cleanup: { state: "verified_empty", verifiedAt: at },
      output: (["stdout", "stderr"] as const).map((stream) => {
        const bytes = stream === "stdout" ? stdout : stderr;
        return { stream, tail: "display is not binary authority", totalBytes: bytes.length, truncated: true,
          spillBytes: bytes.length, lossyBytes: 0, ...(bytes.length ? { spillArtifactId: sha(bytes) } : {}) };
      }) },
    enforcement: "unconfined_explicit_full", disclosure: "unconfined_explicit_full",
  };
  const state: { outcome: OneShotCommandResult; failure?: unknown; fail: boolean; released: boolean; releaseFail: boolean;
    context: typeof binding; pause?: Promise<void>; workingDirectory?: string } = {
    outcome, fail: false, released: false, releaseFail: false, context: binding,
  };
  const runner = createRuntimeGitCommandRunner({
    runId: "run-a", executable: "git", timeoutMs: 10_000,
    execution: { execute: async (request) => { calls.push("execute"); requests.push(request); await state.pause; if (state.fail) throw state.failure; return state.outcome; } },
    authorize: async () => { calls.push("authorize"); return { context: state.context,
      ...(state.workingDirectory ? { workingDirectory: state.workingDirectory } : {}),
      release: async () => { calls.push("release"); state.released = true; if (state.releaseFail) throw undefined; } }; },
    artifacts: {
      stat: async (digest: string) => { calls.push("stat"); return { byteLength: records.get(digest)?.length ?? 0 }; },
      get: async (digest: string) => { calls.push("get"); const bytes = records.get(digest); if (!bytes) throw new Error("artifact missing"); return Buffer.from(bytes); },
    } as Pick<ArtifactStore, "stat" | "get">,
    observe: (actual) => { calls.push("observe"); assert.equal(actual, state.outcome); },
  });
  return { runner, state, calls, requests, records };
}

test("Git runtime returns exact non-UTF8 bytes through the shared bounded output artifact", async () => {
  const bytes = Buffer.from([0, 255, 254, 128, 13, 10]); const f = fixture(bytes, Buffer.from("diagnostic\n"));
  assert.deepEqual(await f.runner.runBytes({ cwd, args: ["show", "HEAD:file.bin"] }), { exitCode: 0, stdout: bytes, stderr: "diagnostic\n" });
  assert.equal(f.requests.length, 1); assert.equal(f.requests[0]!.executable, "git");
  assert.deepEqual(f.requests[0]!.context, binding); assert.equal(f.state.released, true);
  assert.deepEqual(f.calls.slice(0, 3), ["authorize", "execute", "observe"]);
  assert.equal(f.calls.at(-1), "release");
});

test("Git runtime reconstructs text beyond the display tail without output-triggered termination", async () => {
  const text = "original-prefix:" + "data".repeat(100_000); const f = fixture(Buffer.from(text));
  const output = await f.runner.run({ cwd, args: ["diff"], maxOutputBytes: 1_000_000 });
  assert.equal(output.stdout, text); assert.equal(output.exitCode, 0);
  assert.equal(f.requests.length, 1); assert.equal(f.state.released, true);
});

for (const variant of ["exceeds-bound", "lossy", "missing-artifact", "short-spill", "corrupt-artifact"] as const) {
  test(`Git runtime rejects ${variant} rather than silently presenting a partial Git result`, async () => {
    const f = fixture(); const stream = { ...f.state.outcome.process.output[0]! };
    if (variant === "lossy") stream.lossyBytes = 1;
    if (variant === "missing-artifact") delete stream.spillArtifactId;
    if (variant === "short-spill") stream.spillBytes--;
    if (variant === "corrupt-artifact") f.records.set(stream.spillArtifactId!, Buffer.from("bad!"));
    f.state.outcome = { ...f.state.outcome, process: { ...f.state.outcome.process, output: [stream, f.state.outcome.process.output[1]!] } };
    await assert.rejects(f.runner.runBytes({ cwd, args: ["show"], maxOutputBytes: variant === "exceeds-bound" ? 1 : 100 }),
      (error: unknown) => error instanceof GitCommandError && error.code === "output_limit");
    assert.equal(f.state.released, true); assert.equal(f.requests.length, 1);
    if (variant === "exceeds-bound") assert.equal(f.calls.includes("get"), false, "bound must be checked before artifact allocation");
  });
}

for (const state of ["pending", "failed", "not_required"] as const) {
  test(`Git allowFailure never hides ${state} cleanup`, async () => {
    const f = fixture();
    f.state.outcome = { ...f.state.outcome, process: { ...f.state.outcome.process, exitCode: 1,
      cleanup: state === "failed" ? { state, failedAt: at, code: "uncertain", detail: "owned tree remains" } : { state } } };
    await assert.rejects(f.runner.run({ cwd, args: ["status"], allowFailure: true }), (error: unknown) => error instanceof GitCommandError && error.code === "command_failed");
    assert.equal(f.state.released, true); assert.equal(f.calls.includes("get"), false);
  });
}

test("Git allowFailure preserves a verified nonzero result but normal execution throws the existing typed error", async () => {
  const f = fixture(Buffer.from(""), Buffer.from("not a repository\n"));
  f.state.outcome = { ...f.state.outcome, process: { ...f.state.outcome.process, exitCode: 128 } };
  assert.deepEqual(await f.runner.run({ cwd, args: ["status"], allowFailure: true }), { exitCode: 128, stdout: "", stderr: "not a repository\n" });
  await assert.rejects(f.runner.run({ cwd, args: ["status"] }), (error: unknown) => error instanceof GitCommandError && error.code === "command_failed" && error.result?.exitCode === 128);
});

for (const outcome of ["cancelled", "timed_out", "cleanup_failed", "launch_failed"] as const) {
  test(`Git ${outcome} is not accepted by allowFailure`, async () => {
    const f = fixture(); f.state.outcome = { ...f.state.outcome, process: { ...f.state.outcome.process, outcome } };
    await assert.rejects(f.runner.run({ cwd, args: ["status"], allowFailure: true }), (error: unknown) => error instanceof GitCommandError && error.code === (outcome === "launch_failed" ? "git_unavailable" : "command_failed"));
    assert.equal(f.state.released, true);
  });
}

test("Git snapshots caller arguments and explicit environment before asynchronous authorization", async () => {
  const f = fixture(); const args = ["status"]; const env = { GIT_AUTHOR_NAME: "expected" };
  const running = f.runner.run({ cwd, args, env }); args.push("--evil"); env.GIT_AUTHOR_NAME = "changed";
  await running;
  assert.deepEqual(f.requests[0]!.arguments.slice(-1), ["status"]);
  assert.equal(f.requests[0]!.arguments.includes("core.hooksPath="), true);
  assert.equal(f.requests[0]!.explicitEnvironment?.GIT_AUTHOR_NAME, "expected");
  assert.equal(f.requests[0]!.explicitEnvironment?.GIT_CONFIG_NOSYSTEM, "1");
  assert.equal(f.requests[0]!.explicitEnvironment?.GIT_SSH_COMMAND, undefined);
});

test("Git validates request bounds before acquiring authority or executing anything", async () => {
  const f = fixture();
  for (const maximum of [0, -1, Infinity, 1.5]) await assert.rejects(f.runner.run({ cwd, args: ["status"], maxOutputBytes: maximum }), /positive integer/);
  await assert.rejects(f.runner.run({ cwd, args: [] }), /arguments/);
  await assert.rejects(f.runner.run({ cwd, args: ["sta\u0000tus"] }), /arguments/);
  assert.deepEqual(f.calls, []);
});

test("Git repository policy refuses after cwd authorization but before execution and releases exact command authority", async () => {
  const root = await mkdtemp(join(tmpdir(), "aiboard-git-runtime-policy-"));
  await mkdir(join(root, ".git"));
  await writeFile(join(root, ".git", "config"), "[core]\n\trepositoryformatversion = 0\n[alias]\n\tevil = !helper\n", "utf8");
  const f = fixture();
  f.state.workingDirectory = root;
  try {
    await assert.rejects(f.runner.run({ cwd: root, args: ["status"] }),
      (error: unknown) => error instanceof GitCommandError && error.code === "policy_refused");
    assert.deepEqual(f.calls, ["authorize", "release"]);
    assert.equal(f.requests.length, 0);
    assert.equal(f.state.released, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Git cannot use a foreign run context returned by its authority source", async () => {
  const f = fixture(); f.state.context = { ...binding, runId: "foreign" };
  await assert.rejects(f.runner.run({ cwd, args: ["status"] }), /run authority/);
  assert.deepEqual(f.calls, ["authorize", "release"]);
});

test("Git retains an undefined execution failure and a subsequent authorization-release failure", async () => {
  const f = fixture(); f.state.fail = true; f.state.failure = undefined; f.state.releaseFail = true;
  const outcome = await f.runner.run({ cwd, args: ["status"] }).then(() => ({ ok: true as const }), (error: unknown) => ({ ok: false as const, error }));
  assert.equal(outcome.ok, false); if (outcome.ok) assert.fail("failure was swallowed");
  assert.ok(outcome.error instanceof AggregateError); assert.deepEqual(outcome.error.errors, [undefined, undefined]);
});

test("Git joins runtime completion before releasing its exact authorization", async () => {
  const f = fixture(); let release!: () => void; f.state.pause = new Promise<void>((resolve) => { release = resolve; });
  const pending = f.runner.run({ cwd, args: ["status"] });
  try { await new Promise<void>((resolve) => setImmediate(resolve)); assert.equal(f.state.released, false); }
  finally { release(); await pending; }
  assert.equal(f.state.released, true);
});


for (const variant of ["complete", "incomplete", "short", "over-bound"] as const) {
  test(`Git live capture ${variant} preserves exact bytes without falsifying diagnostic storage`, async () => {
    const bytes = Buffer.alloc(192 * 1024 + 3);
    for (let i = 0; i < bytes.length; i++) bytes[i] = i % 256;
    const f = fixture(bytes);
    const output = f.state.outcome.process.output.map((entry) => ({ ...entry,
      tail: "diagnostic display is not binary authority", spillArtifactId: undefined,
      spillBytes: 0, lossyBytes: entry.totalBytes, truncated: entry.stream === "stdout" }));
    f.state.outcome = { ...f.state.outcome, process: { ...f.state.outcome.process, output },
      capturedOutput: { complete: variant !== "incomplete", stdout: variant === "short" ? bytes.subarray(1) : bytes, stderr: new Uint8Array() } };
    const request = { cwd, args: ["cat-file", "blob", "fixture"], maxOutputBytes: variant === "over-bound" ? 128 * 1024 : 256 * 1024 };
    if (variant === "complete") {
      const result = await f.runner.runBytes(request);
      assert.deepEqual(result.stdout, bytes);
      assert.equal(f.state.outcome.process.output[0]!.lossyBytes, bytes.length);
      assert.equal(f.calls.includes("get"), false, "the complete live transport cannot claim a missing disk artifact");
    } else await assert.rejects(f.runner.runBytes(request), (error: unknown) => error instanceof GitCommandError && error.code === "output_limit");
    assert.equal(f.state.released, true);
  });
}
