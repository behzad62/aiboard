// The Windows Job stdin drain wait and the supervisor's input protocol, below the end-to-end slow-reader tests
// (managed-stdin-slow-reader.test.ts): the host's drain loop against a fake supervisor that parks as the real one does,
// the supervisor's own wait parsing run from its source, and, on Windows, the refusals a real supervisor sends.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import test, { after } from "node:test";
import { checkNoWindowsJobProcessesLeft, retireOwnedTreeForTests } from "./support/windows-job-leftover-guard.js";
import {
  createWindowsJobProcessHost,
  waitForAdmittedInput,
  WindowsJobInputUnacknowledgedError,
  type WindowsJobOwnershipKey,
  type WindowsJobWriterFence,
} from "../src/windows-job-process-host.js";

/** The supervisor's own input-wait helpers, run from its source so a change there is what these tests see. */
async function supervisorInputHelpers(): Promise<{
  parseInputWait(raw: unknown): number;
  settleInput(entry: InputEntry, error?: unknown): void;
  waitForInput(entry: InputEntry, timeoutMs: number): Promise<string>;
}> {
  const source = await readFile(new URL("../src/managed-process-supervisor.mjs", import.meta.url), "utf8");
  const start = source.indexOf("/** A bounded park for one input settlement");
  const end = source.indexOf("\nfunction parseWaitStatusSince", start);
  assert.ok(start >= 0 && end > start, "the supervisor's input helpers moved; update this test");
  const context: Record<string, unknown> = { setTimeout, clearTimeout, Promise, Number, Math, Error, String };
  runInNewContext(`${source.slice(start, end)}\nthis.helpers = { parseInputWait, settleInput, waitForInput };`, context);
  return context.helpers as never;
}
interface InputEntry { sequence: number; state: string; error?: string; waiters: Set<() => void> }

function realElapsed(): () => number {
  const started = performance.now();
  return () => performance.now() - started;
}

/** A fake /input-status: it parks for the wait the real supervisor would read from the slice, and counts polls. */
async function fakeSupervisor(settle?: { afterMs: number; state: "acknowledged" | "failed"; error?: string; sequence?: number }) {
  const helpers = await supervisorInputHelpers();
  const entry: InputEntry = { sequence: 1, state: "pending", waiters: new Set() };
  const slices: number[] = [];
  if (settle) setTimeout(() => helpers.settleInput(entry, settle.state === "failed" ? new Error(settle.error ?? "EPIPE") : undefined), settle.afterMs);
  return {
    slices,
    observe: async (sliceMs: number) => {
      slices.push(sliceMs);
      const state = await helpers.waitForInput(entry, helpers.parseInputWait(String(sliceMs)));
      return { sequence: settle?.sequence ?? entry.sequence, state, ...(state === "failed" ? { error: entry.error } : {}) };
    },
  };
}

test("the supervisor parks only for a whole-millisecond wait, rounded down and clamped to 0-5000 ms", async () => {
  const { parseInputWait } = await supervisorInputHelpers();
  assert.equal(parseInputWait("1000"), 1000);
  assert.equal(parseInputWait("999.6"), 999);
  assert.equal(parseInputWait("0.4"), 0);
  assert.equal(parseInputWait(250), 250);
  assert.equal(parseInputWait("9000"), 5000);
  assert.equal(parseInputWait("-5"), 0);
  for (const raw of [null, undefined, "", "abc", "Infinity"]) assert.equal(parseInputWait(raw), 0, String(raw));
});

test("a drain the reader finishes is acknowledged; every poll asks for whole milliseconds", async () => {
  const supervisor = await fakeSupervisor({ afterMs: 1_300, state: "acknowledged" });
  await waitForAdmittedInput({ sequence: 1, timeoutMs: 5_000, elapsed: realElapsed(), observe: supervisor.observe });
  assert.ok(supervisor.slices.length >= 2 && supervisor.slices.length <= 3, `polls: ${supervisor.slices.join(",")}`);
  assert.ok(supervisor.slices.every((slice) => Number.isSafeInteger(slice) && slice >= 1 && slice <= 1_000), supervisor.slices.join(","));
});

test("a drain cut off at its ceiling parks through the last slice instead of polling at once", async () => {
  const supervisor = await fakeSupervisor();
  const started = performance.now();
  await assert.rejects(waitForAdmittedInput({ sequence: 1, timeoutMs: 1_500, elapsed: realElapsed(), observe: supervisor.observe }),
    (error: unknown) => error instanceof WindowsJobInputUnacknowledgedError && /not drained by the reader within 1500 ms/.test(error.message));
  const tookMs = performance.now() - started;
  // About 1000 + 500 ms of parking; a fractional last slice used to be answered at once, hundreds of times.
  assert.ok(supervisor.slices.length <= 3, `polls: ${supervisor.slices.length} (${supervisor.slices.slice(0, 8).join(",")}...)`);
  assert.ok(supervisor.slices.every((slice) => Number.isSafeInteger(slice) && slice >= 1), supervisor.slices.join(","));
  assert.ok(tookMs >= 1_450 && tookMs < 3_000, `took ${Math.round(tookMs)} ms`);
});

test("a failed drain, an invalid reply and a poll that throws all end unacknowledged, never a guess", async () => {
  const failed = await fakeSupervisor({ afterMs: 50, state: "failed", error: "EPIPE: the reader exited" });
  await assert.rejects(waitForAdmittedInput({ sequence: 1, timeoutMs: 5_000, elapsed: realElapsed(), observe: failed.observe }),
    (error: unknown) => error instanceof WindowsJobInputUnacknowledgedError && /failed: EPIPE/.test(error.message));
  const wrongSequence = await fakeSupervisor({ afterMs: 10, state: "acknowledged", sequence: 2 });
  await assert.rejects(waitForAdmittedInput({ sequence: 1, timeoutMs: 5_000, elapsed: realElapsed(), observe: wrongSequence.observe }),
    (error: unknown) => error instanceof WindowsJobInputUnacknowledgedError && /invalid/.test(error.message));
  await assert.rejects(waitForAdmittedInput({ sequence: 1, timeoutMs: 5_000, elapsed: realElapsed(), observe: async () => ({ sequence: 1, state: "queued" }) }),
    (error: unknown) => error instanceof WindowsJobInputUnacknowledgedError && /invalid/.test(error.message));
  await assert.rejects(waitForAdmittedInput({ sequence: 1, timeoutMs: 5_000, elapsed: realElapsed(), observe: async () => { throw new Error("Windows Job process is not owned."); } }),
    (error: unknown) => error instanceof WindowsJobInputUnacknowledgedError && /not owned/.test(error.message));
});

test("the session stopping or the caller cancelling ends the drain wait", async () => {
  const abort = new AbortController();
  let polls = 0;
  const observe = (_sliceMs: number) => new Promise<never>((_resolve, reject) => {
    polls += 1;
    abort.signal.addEventListener("abort", () => reject(new Error("The supervisor request was abandoned.")), { once: true });
  });
  setTimeout(() => abort.abort(), 200);
  const started = performance.now();
  await assert.rejects(waitForAdmittedInput({ sequence: 1, timeoutMs: 30_000, elapsed: realElapsed(), signal: abort.signal, observe }),
    (error: unknown) => error instanceof WindowsJobInputUnacknowledgedError);
  assert.ok(performance.now() - started < 1_000);
  assert.equal(polls, 1);
  // Already abandoned: no poll at all.
  await assert.rejects(waitForAdmittedInput({ sequence: 1, timeoutMs: 30_000, elapsed: realElapsed(), signal: abort.signal, observe }),
    (error: unknown) => error instanceof WindowsJobInputUnacknowledgedError && /abandoned/.test(error.message));
  assert.equal(polls, 1);
});

const OWN_MARKER = `aiboard-stdin-drain-${randomUUID().slice(0, 8)}-`;
const ownRoot = mkdtempSync(join(tmpdir(), OWN_MARKER));
after(async () => {
  try {
    if (process.platform === "win32") await checkNoWindowsJobProcessesLeft([OWN_MARKER]);
  } finally {
    rmSync(ownRoot, { recursive: true, force: true, maxRetries: 30, retryDelay: 50 });
  }
});

function allowedEnv(): Record<string, string> {
  const keep = new Set(["systemroot", "windir", "comspec", "path", "pathext", "temp", "tmp"]);
  return Object.fromEntries(Object.entries(process.env).filter(([key, value]) => value !== undefined && keep.has(key.toLowerCase()))) as Record<string, string>;
}

function raw(supervisor: { port: number; token: string }, path: string, method: "GET" | "POST", body?: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    const call = request({ hostname: "127.0.0.1", port: supervisor.port, path, method, agent: false,
      headers: { authorization: `Bearer ${supervisor.token}`, connection: "close", ...(payload ? { "content-type": "application/json", "content-length": String(payload.byteLength) } : {}) } }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => resolve({ status: response.statusCode ?? 0, body: JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as Record<string, unknown> }));
    });
    call.on("error", reject);
    call.end(payload);
  });
}

test("a real Job supervisor refuses an invalid, stale or unknown sequence before the pipe, and input stays usable", {
  timeout: 60_000, skip: process.platform !== "win32" && "the Windows Job supervisor needs a Windows host",
}, async () => {
  const stateDirectory = join(ownRoot, "job-host");
  const service = createWindowsJobProcessHost({ stateDirectory });
  const owner: WindowsJobOwnershipKey = { runId: "stdin-drain", sessionId: "stdin-drain" };
  const fence: WindowsJobWriterFence = { ownerId: "stdin-drain", fencingToken: 1 };
  const launched = await service.launchOwned({
    ...owner, command: process.execPath, args: ["-e", "process.stdin.resume(); setInterval(() => {}, 1000);"],
    workingDirectory: ownRoot, environment: allowedEnv(), interactive: true, fence: { ...fence },
  });
  try {
    assert.deepEqual(await service.writeOwnedInput!(launched.processId, owner, fence, 1, Buffer.from("one\n"), 5_000), { acknowledged: true, sequence: 1 });
    const record = JSON.parse(await readFile(join(stateDirectory, `${launched.processId}.json`), "utf8")) as { supervisor: { port: number; token: string } };
    const payload = Buffer.from("never\n").toString("base64");
    assert.deepEqual(await raw(record.supervisor, "/write", "POST", { sequence: 0, payload, fence }), { status: 400, body: { error: "input_sequence_invalid" } });
    assert.deepEqual(await raw(record.supervisor, "/write", "POST", { sequence: 1, payload, fence }), { status: 409, body: { error: "input_sequence_stale" } });
    assert.deepEqual(await raw(record.supervisor, "/input-status?sequence=7&timeoutMs=10", "GET"), { status: 409, body: { error: "input_sequence_unknown" } });
    // A fractional wait is read as whole milliseconds; the admitted write's outcome is observed, never changed.
    assert.deepEqual(await raw(record.supervisor, "/input-status?sequence=1&timeoutMs=250.7", "GET"), { status: 200, body: { sequence: 1, state: "acknowledged" } });
    assert.deepEqual(await service.writeOwnedInput!(launched.processId, owner, fence, 2, Buffer.from("two\n"), 5_000), { acknowledged: true, sequence: 2 });
  } finally {
    await retireOwnedTreeForTests(service, { processId: launched.processId, owner, fence: { ...fence }, startedAt: launched.startedAt });
  }
});
