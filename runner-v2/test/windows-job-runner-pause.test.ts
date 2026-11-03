import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { createWindowsJobProcessHost } from "../src/windows-job-process-host.js";
import { WindowsJobObjectProcessBackend } from "../src/windows-process-backend.js";
import type { ProcessBackendBinding } from "../src/process-backend.js";

// Staging (Windows Remote Runner, 2026-11-03): the Runner's main thread paused
// at 0% CPU for 10 s and 134 s. On resume, every live session's in-flight
// supervisor /status probe hit its socket timeout before the already-arrived
// reply was read, the sticky output failure surfaced from waitForTerminal, and
// the streaming runtime recorded each LIVE sibling as backend_unavailable and
// terminated it. A Runner pause is not supervisor silence.

const owner = { runId: "pause-run", sessionId: "pause-session" };
const fence = { ownerId: "pause-owner", fencingToken: 1 };
const startedAt = "2026-11-03T14:16:15.000Z";
const CONTROL_DEADLINE_MS = 250; // supervisor request timeout = 500 ms
const PAUSE_MS = 1_500;

// "reply-ready": as on staging, the supervisor (another process) answered
// during the pause, and the probe had already spent most of its budget, so the
// first tick after resume reaches the deadline. "reply-after-resume": the
// supervisor was paused too (host sleep); its reply leaves only after resume.
for (const reply of ["reply-ready", "reply-after-resume"] as const) {
  test(`a Runner main-thread pause does not turn live Job sessions terminal (${reply})`, { timeout: 20_000 }, t => pauseCase(t, reply));
}

async function pauseCase(t: TestContext, reply: "reply-ready" | "reply-after-resume") {
  const root = await mkdtemp(join(tmpdir(), "runner-pause-"));
  let pauseArmed = false, paused = false;
  const park = () => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, PAUSE_MS);
  const pause = (respond: () => void) => {
    if (!pauseArmed || paused) { setTimeout(respond, 5); return; }
    paused = true;
    // Park inside a check-phase callback while this probe is in flight, like a
    // blocked synchronous write: the next loop turn runs timers before I/O.
    if (reply === "reply-ready") { setTimeout(respond, 450); setTimeout(() => setImmediate(park), 420); }
    else setImmediate(() => { park(); setTimeout(respond, 50); });
  };
  const a = await syntheticSupervisor(root, "live-a", pause);
  const b = await syntheticSupervisor(root, "live-b", pause);
  const host = createWindowsJobProcessHost({ stateDirectory: root, platform: "win32", maxPollBytes: 128, controlDeadlineMs: CONTROL_DEADLINE_MS });
  const backend = new WindowsJobObjectProcessBackend(host, "verified", "verified");
  const provider = backend.backpressuredChannelProvider();
  const channels: Array<{ detach(): Promise<unknown> }> = [];
  let passed = false;
  try {
    const watch = async (supervisor: typeof a) => {
      await host.claimOwnedFence!(supervisor.processId, owner, fence);
      const channel = await provider.acquire(supervisor.binding, fence);
      channels.push(channel);
      channel.subscribeBackpressuredOutput(async metadata => metadata);
      const outcome: { settled?: "resolved" | "rejected"; value?: unknown } = {};
      const terminal = channel.waitForTerminal().then(
        value => { outcome.settled = "resolved"; outcome.value = value; },
        error => { outcome.settled = "rejected"; outcome.value = error; });
      return { outcome, terminal };
    };
    const liveA = await watch(a), liveB = await watch(b);
    await delay(150);
    pauseArmed = true;
    await waitUntil(() => paused, 5_000);
    await delay(PAUSE_MS + 750);
    assert.equal(liveA.outcome.settled, undefined, `live session A must stay observed, got ${String(liveA.outcome.value)}`);
    assert.equal(liveB.outcome.settled, undefined, `live session B must stay observed, got ${String(liveB.outcome.value)}`);
    assert.equal(a.statusRequests() > 0 && b.statusRequests() > 0, true, "both sessions were actively probed");

    // The exact exit still lands, and only for the process that exited.
    await a.complete();
    await liveA.terminal;
    assert.deepEqual(liveA.outcome, { settled: "resolved", value: { state: "exited", exitCode: 0 } });
    await delay(200);
    assert.equal(liveB.outcome.settled, undefined, "a sibling exit cannot settle the live session");
    assert.equal((await b.record()).status, "running");
    passed = true;
  } finally {
    for (const channel of channels) await channel.detach().catch(() => undefined);
    await a.close(); await b.close();
    if (passed) await rm(root, { recursive: true, force: true });
    else t.diagnostic(`retained synthetic fixture; no Job or workload launched: ${root}`);
  }
}

test("a supervisor silent while the Runner runs still times out", { timeout: 20_000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), "runner-silent-"));
  const silent = await syntheticSupervisor(root, "silent", () => undefined);
  const host = createWindowsJobProcessHost({ stateDirectory: root, platform: "win32", maxPollBytes: 128, controlDeadlineMs: CONTROL_DEADLINE_MS });
  let passed = false;
  try {
    await host.claimOwnedFence!(silent.processId, owner, fence);
    const started = performance.now();
    await assert.rejects(host.reconcileOwned(silent.processId, owner, fence), /Supervisor request timed out/);
    const elapsed = performance.now() - started;
    assert.ok(elapsed >= CONTROL_DEADLINE_MS + 250 - 20 && elapsed < 3_000, `silence deadline held at ${Math.round(elapsed)} ms`);
    passed = true;
  } finally {
    await silent.close();
    if (passed) await rm(root, { recursive: true, force: true });
    else t.diagnostic(`retained synthetic fixture; no Job or workload launched: ${root}`);
  }
});

/** onStatusRequest decides when the /status reply leaves; never calling it holds the probe. */
async function syntheticSupervisor(root: string, processId: string, onStatusRequest: (respond: () => void) => void) {
  const directory = join(root, processId); await mkdir(directory);
  const stdoutPath = join(directory, "stdout.log"), stderrPath = join(directory, "stderr.log");
  const statusPath = join(directory, "supervisor.jsonl"), recordPath = join(root, `${processId}.json`);
  await writeFile(stdoutPath, ""); await writeFile(stderrPath, "");
  const token = randomBytes(32).toString("hex");
  let port = 0, completed = false, statusRequests = 0, updatedAt = startedAt;
  const status = () => ({ protocol: "aiboard-managed-process/v1", processId, supervisorPid: process.pid,
    childPid: 42, port, status: completed ? "stopped" : "running", exitCode: completed ? 0 : null, signal: null, error: null,
    ownershipReleased: completed, jobEmptyProof: completed, terminationRequested: false, updatedAt,
    retainedOutputChunks: 0, retainedOutputBytes: 0 });
  const server: Server = createServer((request, response) => {
    if (request.headers.authorization !== `Bearer ${token}`) { response.statusCode = 401; response.end("{}"); return; }
    if (request.url === "/status") {
      statusRequests += 1;
      onStatusRequest(() => response.end(JSON.stringify(status())));
      return;
    }
    if (request.url?.startsWith("/wait-status")) { setTimeout(() => response.end(JSON.stringify(status())), 100); return; }
    response.statusCode = 404; response.end("{}");
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address(); if (!address || typeof address === "string") throw new Error("Synthetic server has no port");
  port = address.port;
  await writeFile(statusPath, JSON.stringify(status()) + "\n");
  await writeFile(recordPath, JSON.stringify({ processId, ...owner, pid: 42, command: "synthetic-no-launch", args: [], cwd: root,
    environmentKeys: [], startedAt, updatedAt: startedAt, status: "running", exitCode: null, signal: null,
    stdoutPath, stderrPath, supervisor: { protocol: "aiboard-managed-process/v1", token, statusPath, supervisorPid: process.pid, port },
    interactive: true, nextInputSequence: 1, inputClosed: false, outputOffsets: { stdout: 0, stderr: 0 },
    outputSequences: { stdout: 0, stderr: 0 }, currentFence: fence }));
  const identity = { processId, ...owner, startedAt, fence };
  const binding: ProcessBackendBinding = { registryId: "registry", backendId: "runner-windows-job-v1",
    implementationGeneration: "generation", implementationDigest: "1".repeat(64), attestationVersion: 2,
    attestationDigest: "2".repeat(64), lifecycle: { scope: "contained_workload", termination: "enforced", emptiness: "enforced" },
    opaqueIdentity: Buffer.from(JSON.stringify(identity)).toString("base64url"),
    birthFingerprint: { observedAt: startedAt, discriminator: createHash("sha256").update(`${processId}\0${startedAt}`).digest("hex") },
    rootPid: 42, startedAt };
  return { processId, binding, statusRequests: () => statusRequests,
    record: async () => JSON.parse(await readFile(recordPath, "utf8")) as { status: string },
    // Append like the real supervisor's jsonl: a reader never sees a truncated file.
    complete: async () => { completed = true; updatedAt = new Date().toISOString(); await appendFile(statusPath, JSON.stringify(status()) + "\n"); },
    close: async () => { server.closeAllConnections(); if (server.listening) await new Promise<void>(resolve => server.close(() => resolve())); } };
}

function delay(milliseconds: number) { return new Promise(resolve => setTimeout(resolve, milliseconds)); }
async function waitUntil(predicate: () => boolean, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) { if (Date.now() >= deadline) throw new Error("condition was not reached"); await delay(10); }
}
