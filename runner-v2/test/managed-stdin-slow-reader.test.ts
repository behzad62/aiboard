// A managed stdin write waits for a reader that is slow to start, on the real process backend of this host (the
// Windows Job, or the POSIX process group): the write blocks only while the pipe buffer is full, and settles the
// moment the reader drains it. Stop never waits for an undrained write, a reader that exits without reading fails the
// write at once, and a reader that stays alive without reading is cut off at the ceiling. Every unacknowledged write
// is coded `outcome_unknown`. The host's process facts are injected (their probe alone is about 9 s on Windows).
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ArtifactStore } from "../src/artifact-store.js";
import type { ToolExecutionContext } from "../src/agent-contracts.js";
import { createExecutionHost, type ExecutionHostRunBinding } from "../src/execution-host.js";
import { MANAGED_INPUT_WRITE_CEILING_MS, type ManagedInputWriteResult } from "../src/managed-process-contracts.js";
import { ManagedProcessService } from "../src/managed-process.js";
import { snapshotNativeBuildAmbientEnvironment } from "../src/native-build-factory.js";
import { emptyRunnerCapabilitiesConfig } from "../src/runner-capabilities-config.js";
import type { RunnerCapabilityContract } from "../src/runner-capability-contract.js";

const PROCESS_HOST_FACTS = process.platform === "win32"
  ? { processHostFacts: { portableDuplex: "unavailable", windowsBatchArgv: "unavailable", exactTreeBirth: "verified", jobContainment: "verified" } as const }
  : {};

// gate: reads stdin only once the marker file exists, reports the running count as it reads ("seen:<n>") and the total
// at EOF ("bytes:<n>"). never: stays alive, never reads.
// exit: exits without reading. Every mode ends itself after two minutes, so a failed test leaves nothing behind.
const READER = `import { existsSync } from "node:fs";
const [mode, marker] = process.argv.slice(2);
setTimeout(() => process.exit(9), 120_000).unref();
if (mode === "exit") setTimeout(() => process.exit(0), 300);
else if (mode === "never") setInterval(() => {}, 1_000);
else {
  const gate = setInterval(() => {
    if (!existsSync(marker)) return;
    clearInterval(gate);
    let bytes = 0;
    process.stdin.on("data", (chunk) => { bytes += chunk.length; process.stdout.write("seen:" + bytes + "\\n"); });
    process.stdin.on("end", () => process.stdout.write("bytes:" + bytes + "\\n", () => process.exit(0)));
  }, 20);
}`;

/** Three 48 KiB writes: 144 KiB is more than any of these hosts' pipe buffers (64 KiB), so one write must wait. */
const CHUNK = "x".repeat(48 * 1024), CHUNKS = 3;

interface Fixture { readonly project: string; readonly service: ManagedProcessService; readonly invoke: <T>(toolName: string, perform: (context: ToolExecutionContext) => Promise<T>, signal?: AbortSignal) => Promise<T> }

async function withHost(options: { inputWriteCeilingMs?: number }, body: (f: Fixture) => Promise<void>): Promise<void> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "managed-stdin-slow-")));
  const project = join(root, "project"), state = join(root, "state");
  mkdirSync(project); mkdirSync(state);
  writeFileSync(join(project, "reader.mjs"), READER);
  const own = options.inputWriteCeilingMs === undefined ? undefined : new ManagedProcessService({
    stateDirectory: join(state, "managed-processes"), platform: process.platform, inputWriteCeilingMs: options.inputWriteCeilingMs,
  });
  const host = createExecutionHost({ projectRoot: project, stateDirectory: state, artifacts: new ArtifactStore(join(state, "artifacts")),
    ambientEnvironment: snapshotNativeBuildAmbientEnvironment(), ...(own ? { managedProcesses: own } : {}), ...PROCESS_HOST_FACTS });
  let run: ExecutionHostRunBinding | undefined;
  const failures: unknown[] = [];
  try {
    run = await host.bindRun({ runId: "stdin-slow", permissionProfile: "full", capabilityContract: { digest: "d".repeat(64) } as RunnerCapabilityContract, capabilitiesConfig: emptyRunnerCapabilitiesConfig() });
    const binding = run;
    let calls = 0;
    const invoke = async <T>(toolName: string, perform: (context: ToolExecutionContext) => Promise<T>, signal?: AbortSignal): Promise<T> => {
      const callId = `call-${++calls}`, actor = { role: "worker" as const, id: "worker" };
      const grant = await binding.executionGrants.issue({ runId: binding.runId, sessionId: "agent", actor, toolName, callId, permissionProfile: "full",
        workspacePath: project, access: [{ path: project, mode: "write" }], externalApproved: false, destructiveApproved: false, networkApproved: false });
      try { return await perform({ runId: binding.runId, sessionId: "agent", actor, callId, toolName, workspacePath: project, executionGrant: grant, ...(signal ? { signal } : {}) }); }
      finally { await binding.executionGrants.revoke(grant, "completed"); }
    };
    await body({ project, service: binding.managedProcesses, invoke });
  } catch (error) { failures.push(error); }
  for (const close of [() => run?.close(), () => host.close(), () => own?.close()]) { try { await close(); } catch (error) { failures.push(error); } }
  rmSync(root, { recursive: true, force: true });
  // The body's own failure comes first; a cleanup failure never hides it.
  if (failures.length === 1) throw failures[0];
  if (failures.length) throw new AggregateError(failures, "stdin slow-reader test failed");
}

async function startReader(f: Fixture, mode: "gate" | "never" | "exit") {
  const started = await f.invoke("process.start", (context) => f.service.start({ command: process.execPath, args: ["reader.mjs", mode, join(f.project, "go")], cwd: ".", interactive: true }, context, f.project));
  return started.processId;
}

/** Sends the chunks in order, stopping at the first that is not acknowledged; `settled` resolves with every result. */
function sendChunks(f: Fixture, processId: string, closeInput: boolean, signal?: AbortSignal) {
  const results: Array<ManagedInputWriteResult & { readonly ms: number }> = [];
  let done = false;
  const settled = (async () => {
    for (let index = 0; index < CHUNKS; index += 1) {
      const startedAt = performance.now();
      const result = await f.invoke("process.write_stdin", (context) => f.service.writeInput(processId,
        { writeId: `chunk-${index}`, data: CHUNK, ...(closeInput && index === CHUNKS - 1 ? { closeInput: true } : {}) }, context), signal);
      results.push({ ...result, ms: performance.now() - startedAt });
      if (result.status !== "acknowledged") break;
    }
    done = true;
    return results;
  })();
  return { settled, get done() { return done; } };
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Reads stdout until `done` holds (60 s at most); `exited` also waits for the exit (a process group reads `exited_unknown` until stopped). */
async function readUntil(f: Fixture, processId: string, done: (stdout: string) => boolean, exited: boolean): Promise<{ stdout: string; exitCode: number | null }> {
  let stdout = "", cursor: string | undefined;
  const deadline = performance.now() + 60_000;
  while (performance.now() < deadline) {
    const read = await f.invoke("process.read_output", (context) => f.service.readOutput(processId, { ...(cursor ? { cursor } : {}), waitMs: 2_000, maxBytes: 16_384 }, context));
    cursor = read.cursor;
    stdout += read.slices.filter((slice) => slice.stream === "stdout").map((slice) => slice.text).join("");
    if (done(stdout) && (!exited || (read.status !== "running" && read.exitCode !== null))) return { stdout, exitCode: read.exitCode };
  }
  throw new Error(`The reader did not get there; stdout so far: ${stdout.slice(-400)}`);
}
const reported = (stdout: string, total: number) => stdout.endsWith(`bytes:${total}\n`);

// Windows only: the limit it guards against (5.25 s) was the Windows Job's; the POSIX bound was 15 s, so a 6 s reader
// proves nothing there, and the other tests below cover the shared bound on every OS.
test("a write waits for a reader that starts reading late, past the old 5 s Windows Job limit, and the reader gets every byte", {
  timeout: 120_000, skip: process.platform !== "win32" && "guards the old Windows Job limit (5.25 s); the POSIX bound was 15 s",
}, async () => {
  await withHost({}, async (f) => {
    const processId = await startReader(f, "gate");
    const writes = sendChunks(f, processId, true);
    // The reader has not started: a write waits for room in the pipe. Before the adaptive bound the Windows Job host
    // cut that wait at its 5 s control deadline (5.25 s), so the write would have ended outcome_unknown by now.
    await sleep(6_000);
    assert.equal(writes.done, false, "a write still waits for the reader to start");
    writeFileSync(join(f.project, "go"), "");
    const results = await writes.settled;
    assert.deepEqual(results.map((result) => result.status), ["acknowledged", "acknowledged", "acknowledged"]);
    assert.ok(results.some((result) => result.ms >= 5_500), `one write waited for the late reader: ${results.map((result) => Math.round(result.ms)).join(", ")} ms`);
    const exit = await readUntil(f, processId, (stdout) => reported(stdout, CHUNKS * CHUNK.length), true);
    assert.equal(exit.exitCode, 0);
  });
});

test("stop never waits for an undrained write; the write ends outcome_unknown and the reader is stopped", { timeout: 120_000 }, async () => {
  await withHost({}, async (f) => {
    const processId = await startReader(f, "never");
    const writes = sendChunks(f, processId, false);
    await sleep(800);
    assert.equal(writes.done, false, "a write waits for a reader that does not read");
    const stopStartedAt = performance.now();
    const stopped = await f.invoke("process.signal", (context) => f.service.signal(processId, "SIGKILL", context));
    const stopMs = performance.now() - stopStartedAt;
    assert.equal(stopped.status, "stopped");
    const results = await writes.settled;
    const last = results.at(-1)!;
    assert.equal(last.status, "outcome_unknown");
    assert.equal(last.errorCode, "process_input_outcome_unknown");
    // Joined to the write, the stop would last until the write's 60 s ceiling. Measured unjoined: 0.3-0.5 s on Windows.
    assert.ok(stopMs < MANAGED_INPUT_WRITE_CEILING_MS / 2, `stop took ${Math.round(stopMs)} ms`);
    assert.ok(performance.now() - stopStartedAt < MANAGED_INPUT_WRITE_CEILING_MS / 2, "the undrained write ended with the stop, not at its ceiling");
  });
});

// POSIX: a portable write whose acknowledgement the channel never consumes (it failed, or it landed after the wait was
// given up) leaves the session's cleanup cleanup_blocked ("Streaming operation exceeded its recovery bound"). On main
// before this change too: 4 of 10 runs after an EPIPE-failed write, and 2 of 2 after a write that drained after its
// 15 s deadline (Linux Docker). It is a separate portable-channel bug, named as a follow-up in
// docs/runner-v2/managed-stdin-write-bound.md; the two tests that end that way run on Windows until it is fixed.
const POSIX_UNCONSUMED_ACK_SKIP = process.platform !== "win32" &&
  "POSIX cleanup after an unconsumed portable input acknowledgement is a known separate bug (cleanup_blocked)";

test("a reader that exits without reading fails the pending write at once, coded", {
  timeout: 120_000, skip: POSIX_UNCONSUMED_ACK_SKIP,
}, async () => {
  await withHost({}, async (f) => {
    const processId = await startReader(f, "exit");
    const results = await sendChunks(f, processId, false).settled;
    const last = results.at(-1)!;
    assert.notEqual(last.status, "acknowledged");
    assert.ok(last.errorCode === "process_input_outcome_unknown" || last.errorCode === "process_input_unavailable", `coded failure: ${last.errorCode}`);
    assert.ok(last.ms < MANAGED_INPUT_WRITE_CEILING_MS / 2, `the write failed with the reader's exit, not at its ceiling (${Math.round(last.ms)} ms)`);
  });
});

test("a write past its ceiling is outcome_unknown and delivered once; input works again after the reader drains it", {
  timeout: 120_000, skip: POSIX_UNCONSUMED_ACK_SKIP,
}, async () => {
  const ceilingMs = 2_000;
  await withHost({ inputWriteCeilingMs: ceilingMs }, async (f) => {
    const processId = await startReader(f, "gate");
    const results = await sendChunks(f, processId, false).settled;
    const last = results.at(-1)!;
    assert.equal(last.status, "outcome_unknown");
    assert.equal(last.errorCode, "process_input_outcome_unknown");
    assert.ok(last.ms >= ceilingMs - 100, `the write waited out its ceiling (${Math.round(last.ms)} ms)`);
    // A retry while that write still waits in the pipe is refused before anything is sent (the Job supervisor
    // admits one write at a time) and leaves input usable: the next write after the drain still goes through.
    const retry = await f.invoke("process.write_stdin", (context) => f.service.writeInput(processId, { writeId: "retry", data: "never" }, context));
    assert.equal(retry.status, "rejected", "refused before admission: a certain refusal, not an unknown outcome");
    // The unacknowledged write was handed to the pipe once: when the reader starts, it reads every admitted byte.
    const admitted = results.length * CHUNK.length;
    writeFileSync(join(f.project, "go"), "");
    await readUntil(f, processId, (stdout) => stdout.includes(`seen:${admitted}\n`), false);
    // Drained, the next write is admitted and acknowledged (on the Windows Job too: the spent sequence moved on).
    const tail = await f.invoke("process.write_stdin", (context) => f.service.writeInput(processId, { writeId: "tail", data: "tail", closeInput: true }, context));
    assert.equal(tail.status, "acknowledged");
    const exit = await readUntil(f, processId, (stdout) => reported(stdout, admitted + 4), true);
    assert.equal(exit.exitCode, 0, "never resent: the reader got exactly the admitted bytes and the tail, and nothing of the refused retry");
  });
});

test("a reader that stays alive without reading is cut off at the ceiling, outcome_unknown, and still stops", { timeout: 120_000 }, async () => {
  const ceilingMs = 2_000;
  await withHost({ inputWriteCeilingMs: ceilingMs }, async (f) => {
    const processId = await startReader(f, "never");
    const results = await sendChunks(f, processId, false).settled;
    const last = results.at(-1)!;
    assert.equal(last.status, "outcome_unknown");
    assert.equal(last.errorCode, "process_input_outcome_unknown");
    assert.ok(last.ms >= ceilingMs - 100, `the write waited out its ceiling (${Math.round(last.ms)} ms)`);
    const stopped = await f.invoke("process.signal", (context) => f.service.signal(processId, "SIGKILL", context));
    assert.equal(stopped.status, "stopped");
  });
});

test("a cancelled call ends its write's wait for the reader at once, outcome_unknown, well before the ceiling", { timeout: 120_000 }, async () => {
  await withHost({}, async (f) => {
    const processId = await startReader(f, "never");
    const cancel = new AbortController();
    const writes = sendChunks(f, processId, false, cancel.signal);
    await sleep(800);
    assert.equal(writes.done, false, "a write waits for a reader that does not read");
    const cancelledAt = performance.now();
    cancel.abort();
    const last = (await writes.settled).at(-1)!;
    assert.equal(last.status, "outcome_unknown");
    assert.ok(performance.now() - cancelledAt < MANAGED_INPUT_WRITE_CEILING_MS / 2, "the cancellation ended the wait, not the 60 s ceiling");
    const stopped = await f.invoke("process.signal", (context) => f.service.signal(processId, "SIGKILL", context));
    assert.equal(stopped.status, "stopped");
  });
});
