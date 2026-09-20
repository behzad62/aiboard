import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { createWindowsJobProcessHost } from "../src/windows-job-process-host.js";
import { createWindowsJobProcessChannelProvider } from "../src/windows-job-process-channel.js";
import type { ProcessBackendBinding } from "../src/process-backend.js";

const owner = { runId: "replay-run", sessionId: "replay-agent" };
const fence = { ownerId: "replay-owner", fencingToken: 1 };
const processId = "replay-job";
const metadata = (text: string) => ({ stream: "stdout", sequence: 1, startOffset: 0, endOffset: Buffer.byteLength(text),
  byteLength: Buffer.byteLength(text), digest: createHash("sha256").update(text).digest("hex") });

test("Windows Job output reservation survives host reopen without coalescing an accepted frame", async (t) => withFixture(t, async (f) => {
  await f.append("shutdown");
  assert.equal(Buffer.from((await f.host().readOwnedOutput(processId, owner, { stdout: 0, stderr: 0 }, fence, 16)).stdout).toString(), "shutdown");
  await f.append("-later");
  const reopened = f.host();
  const replay = await reopened.readOwnedOutput(processId, owner, { stdout: 0, stderr: 0 }, fence, 16);
  assert.equal(Buffer.from(replay.stdout).toString(), "shutdown", "durable acceptance fixes the exact bytes until their ACK");
  const attached = await reopened.attachOwnedChannel!(processId, owner, fence);
  assert.deepEqual(attached.retainedOutput, [metadata("shutdown")]);
  assert.equal(f.acks.length, 0);
}));

test("Windows Job reattachment exposes pending replay without starting a reader or ACK", async (t) => withFixture(t, async (f) => {
  await f.append("shutdown");
  await f.host().readOwnedOutput(processId, owner, { stdout: 0, stderr: 0 }, fence, 16);
  const service = f.host();
  const provider = createWindowsJobProcessChannelProvider({ replayCapacityChunks: 4, replayCapacityBytes: 16, pollIntervalMs: 1,
    authority: () => ({ processId, owner, fence, service: service as Required<typeof service>,
      control: async (effect) => await effect(), reattest: async () => { await service.reconcileOwned(processId, owner, fence); return "live"; } }) });
  const result = await provider.reattach({} as ProcessBackendBinding, fence);
  try {
    assert.deepEqual(result.retainedWindow, [metadata("shutdown")]);
    assert.equal(f.acks.length, 0);
    await f.append("-later");
    const delivered: string[] = [];
    result.channel.subscribeBackpressuredOutput(async (chunk, bytes) => { delivered.push(Buffer.from(bytes).toString()); return chunk; });
    await f.untilAcknowledged(14);
    assert.deepEqual(delivered, ["shutdown", "-later"], "reattachment must not merge or replay the original frame twice");
  } finally { await result.channel.detach(); }
}));

test("Windows Job retained replay refuses changed bytes before exposing metadata", async (t) => withFixture(t, async (f) => {
  await f.append("shutdown");
  await f.host().readOwnedOutput(processId, owner, { stdout: 0, stderr: 0 }, fence, 16);
  await writeFile(f.stdout, "tampered");
  await assert.rejects(f.host().attachOwnedChannel!(processId, owner, fence), /retained.*(digest|identity|bytes)/i);
  assert.equal(f.acks.length, 0);
}));

test("Windows Job replay reservation bounds aggregate bytes and refuses a non-exact ACK", async (t) => withFixture(t, async (f) => {
  await f.append("abcdefgh"); await appendFile(f.stderr, "ijklmnop");
  const host = f.host();
  const output = await host.readOwnedOutput(processId, owner, { stdout: 0, stderr: 0 }, fence, 8);
  assert.ok(output.stdout.byteLength + output.stderr.byteLength <= 8, "a single replay window respects its aggregate capacity");
  await assert.rejects(host.acknowledgeOwnedOutput!(processId, owner, fence, "stdout", 7), /acknowledgement.*(exact|retained|frame)/i);
  assert.equal(f.acks.length, 0, "an invalid ACK is refused before its concrete host effect");
}));

async function withFixture(t: TestContext, body: (fixture: Awaited<ReturnType<typeof createFixture>>) => Promise<void>) {
  const fixture = await createFixture(t); let passed = false;
  try { await body(fixture); passed = true; }
  finally {
    await new Promise<void>((resolve, reject) => fixture.server.close((error) => error ? reject(error) : resolve()));
    if (passed) { await rm(fixture.root, { recursive: true }); t.diagnostic(`synthetic authenticated Job fixture closed and removed: ${fixture.root}`); }
    else t.diagnostic(`synthetic authenticated Job failure retained, no OS workload was launched: ${fixture.root}`);
  }
}

async function createFixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "p683-job-replay-"));
  t.diagnostic(`exact synthetic Job replay fixture acquired: ${root}`);
  const dir = join(root, processId); await mkdir(dir);
  const stdout = join(dir, "stdout.log"), stderr = join(dir, "stderr.log"), statusPath = join(dir, "supervisor.jsonl");
  await writeFile(stdout, ""); await writeFile(stderr, "");
  const token = randomBytes(32).toString("hex"), acks: number[] = [];
  let port = 0; const acknowledged = { stdout: 0, stderr: 0 };
  const status = async () => {
    const retained = (await readFile(stdout)).byteLength + (await readFile(stderr)).byteLength - acknowledged.stdout - acknowledged.stderr;
    return { protocol: "aiboard-managed-process/v1", processId, supervisorPid: process.pid, childPid: 42, port, status: "running",
      exitCode: null, signal: null, error: null, ownershipReleased: false, updatedAt: "2026-09-12T00:00:00.000Z",
      retainedOutputChunks: retained ? 1 : 0, retainedOutputBytes: retained };
  };
  const server: Server = createServer((request, response) => {
    void (async () => {
      assert.equal(request.headers.authorization, `Bearer ${token}`);
      if (request.url === "/status") { response.end(JSON.stringify(await status())); return; }
      assert.equal(request.url, "/ack-output");
      const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const input = JSON.parse(Buffer.concat(chunks).toString()) as { stream: "stdout" | "stderr"; endOffset: number; fence: typeof fence };
      assert.deepEqual(input.fence, fence);
      acknowledged[input.stream] = input.endOffset; acks.push(input.endOffset);
      response.end(JSON.stringify({ acknowledged: true, stream: input.stream, endOffset: input.endOffset, status: await status() }));
    })().catch((error: unknown) => { response.statusCode = 500; response.end(error instanceof Error ? error.message : String(error)); });
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address(); if (!address || typeof address === "string") throw new Error("Synthetic supervisor did not acquire an exact port");
  port = address.port;
  await writeFile(statusPath, JSON.stringify(await status()) + "\n");
  await writeFile(join(root, processId + ".json"), JSON.stringify({ processId, ...owner, pid: 42, command: "synthetic-no-launch", args: [], cwd: root,
    environmentKeys: [], startedAt: "2026-09-12T00:00:00.000Z", updatedAt: "2026-09-12T00:00:00.000Z", status: "running", exitCode: null, signal: null,
    stdoutPath: stdout, stderrPath: stderr, supervisor: { protocol: "aiboard-managed-process/v1", token, statusPath, supervisorPid: process.pid, port },
    interactive: true, nextInputSequence: 1, inputClosed: false, outputOffsets: { stdout: 0, stderr: 0 }, outputSequences: { stdout: 0, stderr: 0 }, currentFence: fence }));
  return { root, stdout, stderr, server, acks,
    host: () => createWindowsJobProcessHost({ stateDirectory: root, platform: "win32", maxPollBytes: 16 }),
    append: async (text: string) => await appendFile(stdout, text),
    untilAcknowledged: async (endOffset: number) => {
      const deadline = Date.now() + 2_000;
      while (acknowledged.stdout < endOffset) { if (Date.now() >= deadline) throw new Error("Exact synthetic Job ACK did not settle"); await new Promise((resolve) => setTimeout(resolve, 5)); }
    },
  };
}