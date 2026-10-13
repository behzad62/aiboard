import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";
import test, { type TestContext } from "node:test";
import { createWindowsJobProcessHost } from "../src/windows-job-process-host.js";
import { WindowsJobObjectProcessBackend } from "../src/windows-process-backend.js";
import type { ProcessBackendBinding } from "../src/process-backend.js";

const owner = { runId: "status-run", sessionId: "status-session" };
const firstFence = { ownerId: "first-owner", fencingToken: 1 };
const nextFence = { ownerId: "next-owner", fencingToken: 2 };
const startedAt = "2026-10-13T00:00:00.000Z";

function barrier() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

for (const operation of ["signal", "release"] as const) {
  test(`Windows Job ${operation} status prefetch cannot overwrite a replacement writer fence`, { timeout: 10_000 }, async t => {
    const f = await fixture(); let passed = false;
    let pending: Promise<unknown> | undefined;
    try {
      pending = f.own(operation === "signal"
        ? f.first.signalOwned(f.processId, "SIGTERM", owner, firstFence)
        : f.first.releaseOwned(f.processId, owner, startedAt, firstFence));
      void pending.catch(() => undefined);
      await f.statusEntered.promise;
      await f.replacement.claimOwnedFence!(f.processId, owner, nextFence);
      assert.deepEqual((await f.record()).currentFence, nextFence, "takeover committed while the earlier HTTP response was held");
      f.resumeStatus.resolve();
      await assert.rejects(pending);
      assert.deepEqual((await f.record()).currentFence, nextFence, "old status must not replace the committed writer authority");
      assert.equal(f.signals(), 0, "a stale observer cannot authorize a native signal");
      assert.equal((await f.record()).backendOwnershipReleasedAt, undefined, "stale observation cannot publish a release tombstone");
      assert.equal((await f.replacement.reconcileOwned(f.processId, owner, nextFence)).status, "running", "replacement authority remains usable");
      passed = true;
    } finally {
      f.resumeStatus.resolve(); await pending?.catch(() => undefined); await f.close();
      if (passed) await rm(f.root, { recursive: true });
      else t.diagnostic(`retained synthetic fixture; no Job or workload launched: ${f.root}`);
    }
  });
}

test("Windows Job stopped signal fast path rejects takeover during its status precheck", { timeout: 10_000 }, async t => {
  await withFixture(t, { stoppedResponse: true }, async f => {
    const pending = f.own(f.first.signalOwned(f.processId, "SIGTERM", owner, firstFence)); void pending.catch(() => undefined);
    await f.statusEntered.promise; await f.replacement.claimOwnedFence!(f.processId, owner, nextFence);
    f.resumeStatus.resolve();
    await assert.rejects(pending, error => (error as { code?: string }).code === "process_identity_mismatch");
    assert.deepEqual((await f.record()).currentFence, nextFence); assert.equal(f.signals(), 0);
  });
});

test("Windows Job stale signal failure cannot become another owner's pending-output result", { timeout: 10_000 }, async t => {
  await withFixture(t, {}, async f => {
    const pending = f.own(f.first.signalOwned(f.processId, "SIGTERM", owner, firstFence)); void pending.catch(() => undefined);
    await f.statusEntered.promise; await f.replacement.claimOwnedFence!(f.processId, owner, nextFence);
    await f.pendingOutput("retained"); f.resumeStatus.resolve();
    await assert.rejects(pending, error => (error as { code?: string }).code === "process_identity_mismatch");
    assert.deepEqual((await f.record()).currentFence, nextFence); assert.equal(f.signals(), 0);
  });
});

for (const operation of ["signal", "release"] as const) {
  test(`Windows Job ${operation} rejects takeover before classifying an already-pending output response`, { timeout: 10_000 }, async t => {
    await withFixture(t, {}, async f => {
      await f.pendingOutput("retained");
      const pending = f.own(operation === "signal"
        ? f.first.signalOwned(f.processId, "SIGTERM", owner, firstFence)
        : f.first.releaseOwned(f.processId, owner, startedAt, firstFence));
      await f.statusEntered.promise; await f.replacement.claimOwnedFence!(f.processId, owner, nextFence);
      f.resumeStatus.resolve();
      await assert.rejects(pending, error => (error as { code?: string }).code === "process_identity_mismatch");
      assert.deepEqual((await f.record()).currentFence, nextFence); assert.equal(f.signals(), 0);
    });
  });
}

test("Windows Job old status cannot undo an exact release tombstone or revive its retired protocol", { timeout: 10_000 }, async t => {
  await withFixture(t, {}, async f => {
    const pending = f.own(f.first.signalOwned(f.processId, "SIGTERM", owner, firstFence)); void pending.catch(() => undefined);
    await f.statusEntered.promise; await f.complete();
    await f.replacement.releaseOwned(f.processId, owner, startedAt, firstFence);
    const releasedAt = (await f.record()).backendOwnershipReleasedAt;
    assert.ok(releasedAt); assert.equal(existsSync(f.lockPath), false);
    f.resumeStatus.resolve();
    await assert.rejects(pending, error => (error as { code?: string }).code === "process_backend_ownership_released");
    assert.equal((await f.record()).backendOwnershipReleasedAt, releasedAt);
    assert.equal(existsSync(f.lockPath), false); assert.equal(f.signals(), 0);
  });
});

for (const response of ["stale-running", "fresh-stopped"] as const) {
  test(`Windows Job ${response} prefetch preserves an ACK committed during HTTP observation`, { timeout: 10_000 }, async t => {
    await withFixture(t, { currentResponse: response === "fresh-stopped" }, async f => {
      const pending = f.own(response === "fresh-stopped"
        ? f.first.signalOwned(f.processId, "SIGTERM", owner, firstFence)
        : f.first.releaseOwned(f.processId, owner, startedAt, firstFence));
      void pending.catch(() => undefined);
      await f.statusEntered.promise;
      const bytes = "refs/heads/aiboard/run-openrouter-patch-factory-99c19176af/integration\n";
      assert.equal(Buffer.byteLength(bytes), 71);
      await f.pendingOutput(bytes);
      const unread = await f.replacement.readOwnedOutput(f.processId, owner, { stdout: 0, stderr: 0 }, firstFence);
      assert.equal(Buffer.from(unread.stdout).toString(), bytes);
      await f.replacement.acknowledgeOwnedOutput!(f.processId, owner, firstFence, "stdout", 71);
      await f.complete(); f.resumeStatus.resolve();
      if (response === "fresh-stopped") assert.equal((await pending as { status: string }).status, "stopped");
      else await assert.rejects(pending, error => (error as { code?: string }).code === "process_control_unavailable");
      assert.equal((await f.record()).outputOffsets.stdout, 71);
      assert.equal((await f.record()).outputSequences.stdout, 1);
      assert.equal((await f.replacement.releaseOwned(f.processId, owner, startedAt, firstFence)).ownershipReleased, true);
    });
  });
}

for (const bytes of ["", "refs/heads/aiboard/run-openrouter-patch-factory-99c19176af/integration\n"]) {
  test(`Windows Job public observe settles an already-empty Job with ${Buffer.byteLength(bytes)} retained bytes`, { timeout: 10_000 }, async t => {
    await withFixture(t, {}, async f => {
      if (bytes) await f.pendingOutput(bytes);
      await f.complete();
      const identity = { processId: f.processId, ...owner, startedAt, fence: firstFence };
      const binding: ProcessBackendBinding = { registryId: "registry", backendId: "runner-windows-job-v1",
        implementationGeneration: "generation", implementationDigest: "1".repeat(64), attestationVersion: 2,
        attestationDigest: "2".repeat(64), lifecycle: { scope: "contained_workload", termination: "enforced", emptiness: "enforced" },
        opaqueIdentity: Buffer.from(JSON.stringify(identity)).toString("base64url"),
        birthFingerprint: { observedAt: startedAt, discriminator: createHash("sha256").update(`${f.processId}\0${startedAt}`).digest("hex") },
        rootPid: 42, startedAt };
      const backend = new WindowsJobObjectProcessBackend(f.first, "verified", "verified");
      const delivered: Buffer[] = [];
      // Let the authentic synthetic endpoint respond normally; no workload is
      // launched. The real host, fused attach and backend consume these states.
      f.resumeStatus.resolve();
      assert.deepEqual(await f.own(backend.observe(binding, async (stream, chunk) => {
        assert.equal(stream, "stdout"); delivered.push(Buffer.from(chunk));
      }, firstFence)), { state: "exited", exitCode: 0 });
      assert.equal(Buffer.concat(delivered).toString(), bytes);
      assert.equal(delivered.length, bytes ? 1 : 0);
      assert.equal((await f.record()).outputOffsets.stdout, Buffer.byteLength(bytes));
      assert.deepEqual(await backend.release(binding, firstFence), { released: true });
      assert.equal(f.signals(), 0);
    });
  });
}

type FixtureOptions = { stoppedResponse?: boolean; currentResponse?: boolean };
async function withFixture(t: TestContext, options: FixtureOptions, body: (f: Awaited<ReturnType<typeof fixture>>) => Promise<void>) {
  const f = await fixture(options); let passed = false;
  try { await body(f); passed = true; }
  finally {
    f.resumeStatus.resolve(); await f.close();
    if (passed) await rm(f.root, { recursive: true });
    else t.diagnostic(`retained synthetic fixture; no Job or workload launched: ${f.root}`);
  }
}

async function fixture(options: FixtureOptions = {}) {
  const root = await mkdtemp(join(tmpdir(), "t8-status-fencing-"));
  const processId = "status-job";
  const directory = join(root, processId); await mkdir(directory);
  const stdoutPath = join(directory, "stdout.log"), stderrPath = join(directory, "stderr.log");
  const statusPath = join(directory, "supervisor.jsonl"), recordPath = join(root, `${processId}.json`);
  await writeFile(stdoutPath, ""); await writeFile(stderrPath, "");
  const token = randomBytes(32).toString("hex");
  const statusEntered = barrier(), resumeStatus = barrier();
  let port = 0, signals = 0, held = false, completed = false, acknowledged = 0, retainedBytes = 0;
  const stopped = () => completed && acknowledged === retainedBytes;
  const status = () => ({ protocol: "aiboard-managed-process/v1", processId, supervisorPid: process.pid,
    childPid: 42, port, status: stopped() ? "stopped" : retainedBytes > acknowledged ? "exited_unknown" : "running",
    exitCode: completed ? 0 : null, signal: null, error: null, ownershipReleased: stopped(),
    updatedAt: startedAt, retainedOutputChunks: retainedBytes > acknowledged ? 1 : 0, retainedOutputBytes: retainedBytes - acknowledged,
    jobEmptyProof: completed || retainedBytes > 0 });
  const server = createServer((request, response) => {
    void (async () => {
      assert.equal(request.headers.authorization, `Bearer ${token}`);
      if (request.url === "/status") {
        const observed = status();
        if (!held) {
          held = true; statusEntered.resolve(); await resumeStatus.promise;
          response.end(JSON.stringify(options.currentResponse ? status() : options.stoppedResponse ? { ...observed, status: "stopped", ownershipReleased: true, exitCode: 0 } : observed));
        } else response.end(JSON.stringify(status()));
        return;
      }
      if (request.url === "/ack-output") {
        const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const body = JSON.parse(Buffer.concat(chunks).toString());
        assert.deepEqual(body.fence, firstFence); assert.equal(body.stream, "stdout"); assert.equal(body.endOffset, 71);
        acknowledged = body.endOffset;
        response.end(JSON.stringify({ acknowledged: true, stream: body.stream, endOffset: body.endOffset, status: status() })); return;
      }
      assert.equal(request.url, "/signal"); signals++;
      for await (const _chunk of request) { /* Consume only this synthetic request. */ }
      response.end(JSON.stringify({ ...status(), status: "stopped", exitCode: 0, ownershipReleased: true, jobEmptyProof: true }));
    })().catch(error => { response.statusCode = 500; response.end(JSON.stringify({ error: String(error) })); });
  });
  const pendingOperations = new Set<Promise<unknown>>();
  const own = <T>(promise: Promise<T>): Promise<T> => {
    pendingOperations.add(promise);
    void promise.then(() => pendingOperations.delete(promise), () => pendingOperations.delete(promise));
    return promise;
  };
  const close = async () => {
    resumeStatus.resolve(); await Promise.allSettled([...pendingOperations]);
    server.closeAllConnections();
    if (server.listening) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  };
  try {
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address(); if (!address || typeof address === "string") throw new Error("Synthetic server has no port");
  port = address.port;
  await writeFile(statusPath, JSON.stringify(status()) + "\n");
  await writeFile(recordPath, JSON.stringify({ processId, ...owner, pid: 42, command: "synthetic-no-launch", args: [], cwd: root,
    environmentKeys: [], startedAt, updatedAt: startedAt, status: "running", exitCode: null, signal: null,
    stdoutPath, stderrPath, supervisor: { protocol: "aiboard-managed-process/v1", token, statusPath, supervisorPid: process.pid, port },
    interactive: true, nextInputSequence: 1, inputClosed: false, outputOffsets: { stdout: 0, stderr: 0 },
    outputSequences: { stdout: 0, stderr: 0 }, currentFence: firstFence }));
  const first = createWindowsJobProcessHost({ stateDirectory: root, platform: "win32", maxPollBytes: 128 });
  const replacement = createWindowsJobProcessHost({ stateDirectory: root, platform: "win32", maxPollBytes: 128 });
  // Establish the normal real coordination identity before holding HTTP.
  await first.claimOwnedFence!(processId, owner, firstFence);
  return { root, processId, first, replacement, statusEntered, resumeStatus, signals: () => signals,
    record: async () => JSON.parse(await readFile(recordPath, "utf8")),
    lockPath: join(root, `${processId}.fence.lock`), close, own,
    complete: async () => { completed = true; await writeFile(statusPath, JSON.stringify(status()) + "\n"); },
    pendingOutput: async (text: string) => { retainedBytes = Buffer.byteLength(text); await writeFile(stdoutPath, text); await writeFile(statusPath, JSON.stringify(status()) + "\n"); } };
  } catch (error) { await close(); throw error; }
}
