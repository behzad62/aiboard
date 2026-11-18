import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { assertSubprocessCleanupSettled, releasedWindowsJobRecords } from "../src/inspection-cleanup.js";
import { createWindowsJobProcessHost, type WindowsJobProcessHost } from "../src/windows-job-process-host.js";
import { windowsJobRecordOfBinding } from "../src/windows-process-backend.js";
import type { DurableProcessStore } from "../src/durable-process-store.js";
import type { StreamingSessionStore } from "../src/streaming-session-store.js";

// Synthetic Job-host records only: no supervisor, Job or workload is ever launched. A record's supervisor is, by
// default, the PID of a child that already exited, with no port, so nothing here can signal or contact a process.
const exitedPid = spawnSync(process.execPath, ["-e", ""]).pid;
const PROTOCOL = "aiboard-managed-process/v1";
const runId = "retention-run";
const sessionId = "retention-session";
const startedAt = "2026-11-18T00:00:00.000Z";

interface SyntheticRecord {
  readonly processId: string;
  readonly runId?: string;
  readonly released?: boolean;
  readonly supervisorStatus?: "stopped" | "running" | "missing" | "stopped-unreleased" | "stopped-unsettled";
  readonly spare?: "unclaimed" | "claimed" | "claim-window";
  readonly retentionRemovingAt?: string;
  readonly output?: string;
  readonly supervisorPid?: number;
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "job-record-retention-"));
  const write = (input: SyntheticRecord) => {
    const { processId } = input;
    const folder = join(root, processId);
    mkdirSync(folder, { recursive: true });
    const stdoutPath = join(folder, "stdout.log"), stderrPath = join(folder, "stderr.log");
    const statusPath = join(folder, "supervisor.jsonl");
    const output = input.output ?? "secret printed by a command\n";
    writeFileSync(stdoutPath, output); writeFileSync(stderrPath, "");
    writeFileSync(join(folder, "job-events.jsonl"), "{}\n");
    const supervisorStatus = input.supervisorStatus ?? (input.released === false ? "running" : "stopped");
    const stopped = supervisorStatus.startsWith("stopped");
    const supervisorPid = input.supervisorPid ?? exitedPid;
    if (supervisorStatus !== "missing") {
      writeFileSync(statusPath, `${JSON.stringify({
        protocol: PROTOCOL, processId, supervisorPid, childPid: 42, port: 0,
        status: stopped ? "stopped" : "running", exitCode: stopped ? 0 : null, signal: null, error: null,
        ownershipReleased: supervisorStatus === "stopped" || supervisorStatus === "stopped-unsettled",
        updatedAt: startedAt, retainedOutputChunks: supervisorStatus === "stopped-unsettled" ? 1 : 0,
        retainedOutputBytes: supervisorStatus === "stopped-unsettled" ? 7 : 0, jobEmptyProof: stopped,
      })}\n`);
    }
    const released = input.released !== false;
    const record = {
      processId, runId: input.runId ?? runId, sessionId, pid: 42, command: "synthetic-no-launch", args: [], cwd: root,
      environmentKeys: [], startedAt, updatedAt: startedAt, status: released ? "stopped" : "running",
      exitCode: released ? 0 : null, signal: null, stdoutPath, stderrPath,
      supervisor: { protocol: PROTOCOL, token: randomBytes(32).toString("hex"), statusPath, supervisorPid, port: 0 },
      interactive: true, nextInputSequence: 1, inputClosed: false,
      outputOffsets: { stdout: Buffer.byteLength(output), stderr: 0 }, outputSequences: { stdout: 1, stderr: 0 },
      ...(released ? { backendOwnershipReleasedAt: startedAt } : {}),
      ...(input.spare ? { spare: true, spareClaimed: input.spare === "claimed" } : {}),
      ...(input.spare === "claim-window" ? { spareClaimInFlight: true } : {}),
      ...(input.retentionRemovingAt ? { retentionRemovingAt: input.retentionRemovingAt } : {}),
    };
    writeFileSync(join(root, `${processId}.json`), JSON.stringify(record, null, 2));
    return record;
  };
  const named = (processId: string) => ({ processId, sessionId, startedAt });
  const present = (processId: string) => ({ record: existsSync(join(root, `${processId}.json`)), folder: existsSync(join(root, processId)) });
  const host = (options: { maxRecordScan?: number; retentionSupervisorExitMs?: number } = {}): WindowsJobProcessHost =>
    createWindowsJobProcessHost({ stateDirectory: root, platform: "win32", ...options });
  return { root, write, named, present, host, close: () => rmSync(root, { recursive: true, force: true }) };
}

test("retention deletes a released, stop-proven record with its raw output folder", async () => {
  const f = fixture();
  try {
    f.write({ processId: "process_released" });
    const result = await f.host().retireReleasedRecords!({ runId, released: [f.named("process_released")] });
    assert.deepEqual(result, { deleted: 1, kept: 0 });
    assert.deepEqual(f.present("process_released"), { record: false, folder: false }, "record, folder and raw stdout are gone");
    assert.deepEqual(readdirSync(f.root), [], "no lock, temporary or residue is left");
  } finally { f.close(); }
});

for (const [label, input] of [
  ["a live record without the release tombstone", { released: false }],
  ["a released record whose supervisor status is missing", { supervisorStatus: "missing" }],
  ["a released record whose supervisor never released ownership", { supervisorStatus: "stopped-unreleased" }],
  ["a released record whose supervisor still retains output", { supervisorStatus: "stopped-unsettled" }],
  ["a released record whose supervisor still reports running", { supervisorStatus: "running" }],
  ["an unclaimed spare record", { spare: "unclaimed" }],
] as const) {
  test(`retention keeps ${label}, untouched`, async () => {
    const f = fixture();
    try {
      // Built first: startup crash recovery already drops a previous Runner's unclaimed spare records.
      const host = f.host();
      const written = f.write({ processId: "process_unproven", ...input });
      const before = readFileSync(join(f.root, "process_unproven.json"), "utf8");
      const result = await host.retireReleasedRecords!({ runId, released: [f.named("process_unproven")] });
      assert.deepEqual(result, { deleted: 0, kept: 1 });
      assert.deepEqual(f.present("process_unproven"), { record: true, folder: true });
      assert.equal(readFileSync(join(f.root, "process_unproven.json"), "utf8"), before, "no retention mark is written before the proof");
      assert.equal(readFileSync(written.stdoutPath, "utf8"), "secret printed by a command\n");
    } finally { f.close(); }
  });
}

test("retention deletes only records the run's owner named, with the identity it named", async () => {
  const f = fixture();
  try {
    f.write({ processId: "process_not_named" });
    f.write({ processId: "process_other_run", runId: "other-run" });
    f.write({ processId: "process_other_session" });
    f.write({ processId: "process_other_birth" });
    const result = await f.host().retireReleasedRecords!({ runId, released: [
      f.named("process_other_run"),
      { processId: "process_other_session", sessionId: "another-session", startedAt },
      { processId: "process_other_birth", sessionId, startedAt: "2026-11-18T00:00:01.000Z" },
      f.named("process_absent"),
    ] });
    assert.deepEqual(result, { deleted: 0, kept: 3 }, "an absent named record is neither deleted nor kept");
    for (const processId of ["process_not_named", "process_other_run", "process_other_session", "process_other_birth"])
      assert.deepEqual(f.present(processId), { record: true, folder: true }, processId);
  } finally { f.close(); }
});

test("retention finishes a marked record whose earlier pass stopped after removing its status", async () => {
  const f = fixture();
  try {
    // Built first: a record already marked at startup is finished by the startup recovery itself.
    const host = f.host();
    f.write({ processId: "process_marked", retentionRemovingAt: startedAt });
    rmSync(join(f.root, "process_marked", "supervisor.jsonl"));
    const result = await host.retireReleasedRecords!({ runId, released: [f.named("process_marked")] });
    assert.deepEqual(result, { deleted: 1, kept: 0 });
    assert.deepEqual(f.present("process_marked"), { record: false, folder: false });
  } finally { f.close(); }
});

test("a run-end sweep finishes a marked record no owner names again", async () => {
  const f = fixture();
  try {
    const host = f.host();
    f.write({ processId: "process_marked_other_run", runId: "earlier-run", retentionRemovingAt: startedAt });
    rmSync(join(f.root, "process_marked_other_run", "supervisor.jsonl"));
    f.write({ processId: "process_unmarked" });
    await host.retireSpare!({ runId });
    assert.deepEqual(f.present("process_marked_other_run"), { record: false, folder: false });
    assert.deepEqual(f.present("process_unmarked"), { record: true, folder: true }, "a sweep never starts a deletion");
  } finally { f.close(); }
});

test("retention keeps a named record file that is not a valid record", async () => {
  const f = fixture();
  try {
    writeFileSync(join(f.root, "process_invalid.json"), JSON.stringify({ processId: "process_invalid" }));
    const host = f.host();
    assert.deepEqual(await host.retireReleasedRecords!({ runId, released: [f.named("process_invalid")] }), { deleted: 0, kept: 1 });
    assert.equal(existsSync(join(f.root, "process_invalid.json")), true);
  } finally { f.close(); }
});

test("retention waits for a live supervisor, keeps the record marked, and a sweep finishes it once it is gone", async () => {
  const f = fixture();
  const lingering = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  try {
    f.write({ processId: "process_lingering", supervisorPid: lingering.pid! });
    const host = f.host({ retentionSupervisorExitMs: 100 });
    assert.deepEqual(await host.retireReleasedRecords!({ runId, released: [f.named("process_lingering")] }), { deleted: 0, kept: 1 });
    assert.deepEqual(f.present("process_lingering"), { record: true, folder: true }, "nothing is deleted under a live supervisor");
    const marked = JSON.parse(readFileSync(join(f.root, "process_lingering.json"), "utf8")) as { retentionRemovingAt?: unknown };
    assert.equal(typeof marked.retentionRemovingAt, "string", "the proven record is marked for a later pass");
    await host.retireSpare!({ runId: "another-run" });
    assert.deepEqual(f.present("process_lingering"), { record: true, folder: true }, "a sweep never waits for, nor deletes under, a live supervisor");
    const exited = new Promise((resolveExit) => lingering.once("exit", resolveExit));
    lingering.kill();
    await exited;
    await host.retireSpare!({ runId: "another-run" });
    assert.deepEqual(f.present("process_lingering"), { record: false, folder: false });
  } finally { lingering.kill(); f.close(); }
});

test("startup finishes a record a previous Runner's retention pass had marked", async () => {
  const f = fixture();
  try {
    f.write({ processId: "process_marked_before_restart", retentionRemovingAt: startedAt });
    const host = f.host();
    await (host as unknown as { startupRecovery?: Promise<void> }).startupRecovery;
    assert.deepEqual(f.present("process_marked_before_restart"), { record: false, folder: false });
  } finally { f.close(); }
});

test("retention deletes a released claimed spare like any released call", async () => {
  const f = fixture();
  try {
    f.write({ processId: "process_claimed_spare", spare: "claimed" });
    assert.deepEqual(await f.host().retireReleasedRecords!({ runId, released: [f.named("process_claimed_spare")] }), { deleted: 1, kept: 0 });
    assert.deepEqual(f.present("process_claimed_spare"), { record: false, folder: false });
  } finally { f.close(); }
});

test("a run-end sweep always reaches the closing run's own spares, whatever its bounded window", async () => {
  const f = fixture();
  try {
    const host = f.host({ maxRecordScan: 1 });
    for (const processId of ["process_a_other", "process_b_other", "process_z_own"])
      f.write({ processId, spare: "unclaimed", supervisorStatus: "missing", runId: processId.endsWith("own") ? runId : "other-run" });
    // As startSpare records it: this host started process_z_own for the run.
    (host as unknown as { startedSpares: Map<string, Set<string>> }).startedSpares.set(runId, new Set(["process_z_own"]));
    await host.retireSpare!({ runId });
    assert.equal(f.present("process_z_own").record, false, "the run's own spare is swept though its name is outside the window");
    assert.equal(f.present("process_a_other").record, true);
    assert.equal(f.present("process_b_other").record, true);
    assert.equal((host as unknown as { startedSpares: Map<string, Set<string>> }).startedSpares.has(runId), false, "a swept spare is forgotten");
  } finally { f.close(); }
});

test("retention keeps a record whose folder is a link, and never follows it", async () => {
  const f = fixture();
  const outside = mkdtempSync(join(tmpdir(), "job-record-retention-outside-"));
  try {
    const host = f.host();
    f.write({ processId: "process_linked", retentionRemovingAt: startedAt });
    rmSync(join(f.root, "process_linked"), { recursive: true });
    writeFileSync(join(outside, "keep.txt"), "outside");
    symlinkSync(outside, join(f.root, "process_linked"), "junction");
    const result = await host.retireReleasedRecords!({ runId, released: [f.named("process_linked")] });
    assert.deepEqual(result, { deleted: 0, kept: 1 });
    assert.equal(readFileSync(join(outside, "keep.txt"), "utf8"), "outside");
    assert.equal(existsSync(join(f.root, "process_linked.json")), true);
  } finally { f.close(); rmSync(outside, { recursive: true, force: true }); }
});

test("a restart keeps and recovers a live record while retention deletes the released one", async () => {
  const f = fixture();
  try {
    f.write({ processId: "process_live", released: false });
    f.write({ processId: "process_done" });
    const first = f.host();
    const result = await first.retireReleasedRecords!({ runId, released: [f.named("process_live"), f.named("process_done")] });
    assert.deepEqual(result, { deleted: 1, kept: 1 }, "a live record is kept even when an owner names it");
    assert.deepEqual(f.present("process_done"), { record: false, folder: false });
    const restarted = f.host();
    const live = await restarted.reconcileOwned("process_live", { runId, sessionId });
    assert.equal(live.status, "running");
    assert.equal(live.ownershipReleased, false);
    await assert.rejects(restarted.reconcileOwned("process_done", { runId, sessionId }),
      (error) => (error as { code?: string }).code === "process_not_found");
  } finally { f.close(); }
});

test("a release replay recovers before retention and fails closed after it", async () => {
  const f = fixture();
  try {
    f.write({ processId: "process_replay", released: false, supervisorStatus: "stopped" });
    const host = f.host();
    const owner = { runId, sessionId };
    assert.equal((await host.releaseOwned("process_replay", owner, startedAt)).ownershipReleased, true);
    assert.equal((await host.releaseOwned("process_replay", owner, startedAt)).ownershipReleased, true, "replay finishes from the tombstone");
    assert.deepEqual(await host.retireReleasedRecords!({ runId, released: [f.named("process_replay")] }), { deleted: 1, kept: 0 });
    await assert.rejects(host.releaseOwned("process_replay", owner, startedAt),
      (error) => (error as { code?: string }).code === "process_not_found", "nothing answers for a deleted record");
    assert.deepEqual(readdirSync(f.root), []);
  } finally { f.close(); }
});

test("startup reads a bounded slice at once and recovers the rest in the background, losing no previous spare", async () => {
  const f = fixture();
  try {
    const ids = ["process_a", "process_b", "process_c", "process_d", "process_e"];
    for (const processId of ids) f.write({ processId, spare: "unclaimed", supervisorStatus: "missing" });
    const host = f.host({ maxRecordScan: 2 });
    const remaining = () => ids.filter((processId) => f.present(processId).record);
    assert.deepEqual(remaining(), ["process_c", "process_d", "process_e"], "the constructor reads only the first two records");
    await (host as unknown as { startupRecovery?: Promise<void> }).startupRecovery;
    assert.deepEqual(remaining(), [], "background batches give every previous spare the same crash recovery");
  } finally { f.close(); }
});

test("a previous Runner's claim-window spare past the startup slice still gets its crash recovery", async () => {
  const f = fixture();
  try {
    f.write({ processId: "process_a_call", released: false });
    f.write({ processId: "process_b_call", released: false });
    f.write({ processId: "process_c_claim", spare: "claim-window", supervisorStatus: "missing" });
    const host = f.host({ maxRecordScan: 1 });
    await (host as unknown as { startupRecovery?: Promise<void> }).startupRecovery;
    const record = JSON.parse(readFileSync(join(f.root, "process_c_claim.json"), "utf8")) as { spareReapedAt?: unknown };
    assert.equal(typeof record.spareReapedAt, "string", "the claim-window record is marked reaped and kept as its audit trail");
    assert.deepEqual(f.present("process_a_call"), { record: true, folder: true });
    assert.deepEqual(f.present("process_b_call"), { record: true, folder: true });
  } finally { f.close(); }
});

test("run-end spare sweeps read a bounded number of records and continue where the last stopped", async () => {
  const f = fixture();
  try {
    const host = f.host({ maxRecordScan: 2 });
    const ids = ["process_a", "process_b", "process_c", "process_d", "process_e"];
    for (const processId of ids) f.write({ processId, spare: "unclaimed", supervisorStatus: "missing" });
    const remaining = () => ids.filter((processId) => f.present(processId).record);
    await host.retireSpare!();
    assert.deepEqual(remaining(), ["process_c", "process_d", "process_e"]);
    await host.retireSpare!();
    assert.deepEqual(remaining(), ["process_e"], "the next sweep continues after the last");
    await host.retireSpare!();
    assert.deepEqual(remaining(), []);
  } finally { f.close(); }
});

test("a settled close forgets the run's keepWarm retirement mark", async () => {
  const f = fixture();
  try {
    const host = f.host();
    const marks = (host as unknown as { retiredSpareRuns: Set<string> }).retiredSpareRuns;
    await host.retireSpare!({ runId });
    await host.retireSpare!({ runId: "other-run" });
    assert.deepEqual([...marks].sort(), ["other-run", runId]);
    await host.retireReleasedRecords!({ runId, released: [] });
    assert.deepEqual([...marks], ["other-run"]);
  } finally { f.close(); }
});

function jobBinding(processId: string, bindingRunId = runId, backendId = "runner-windows-job-v1") {
  const identity = { processId, runId: bindingRunId, sessionId, startedAt, fence: { ownerId: "owner", fencingToken: 1 } };
  return {
    registryId: "registry", backendId, implementationGeneration: "generation", implementationDigest: "1".repeat(64),
    attestationVersion: 2, attestationDigest: "2".repeat(64), startedAt,
    opaqueIdentity: Buffer.from(JSON.stringify(identity)).toString("base64url"),
    birthFingerprint: { observedAt: startedAt, discriminator: createHash("sha256").update(`${processId}\0${startedAt}`).digest("hex") },
  };
}

test("a Job binding names its record; other backends and forged births name none", () => {
  assert.deepEqual(windowsJobRecordOfBinding(jobBinding("process_x")), { processId: "process_x", runId, sessionId, startedAt });
  assert.equal(windowsJobRecordOfBinding(jobBinding("process_x", runId, "runner-windows-supervisor-v1")), undefined);
  const forged = { ...jobBinding("process_x"), birthFingerprint: { observedAt: startedAt, discriminator: "0".repeat(64) } };
  assert.equal(windowsJobRecordOfBinding(forged), undefined);
});

test("the settled subprocess check collects only cleaned bindings, never the residue it exempts", () => {
  const rows: Record<string, { revision: number; state: string; cleanup: { state: string }; pendingEffects: unknown[]; backendBinding?: unknown }> = {
    cleaned: { revision: 3, state: "cleaned", cleanup: { state: "verified_empty" }, pendingEffects: [], backendBinding: jobBinding("process_cleaned") },
    reused: { revision: 1, state: "reused", cleanup: { state: "not_required" }, pendingEffects: [] },
    residue: { revision: 7, state: "outcome_unknown", cleanup: { state: "required" }, pendingEffects: [{ kind: "backend_release" }], backendBinding: jobBinding("process_residue") },
  };
  const store = { listRowIds: () => Object.keys(rows), readByInvocation: (id: string) => rows[id] } as unknown as DurableProcessStore;
  const settled = assertSubprocessCleanupSettled(store, new Map([["residue", 7]]));
  assert.deepEqual(settled.cleaned.map((binding) => windowsJobRecordOfBinding(binding)?.processId), ["process_cleaned"]);
});

test("only processes the run's stores record as released for good are named for retention", () => {
  const settled = { cleaned: [jobBinding("process_cleaned"), jobBinding("process_foreign", "other-run"), jobBinding("process_portable", runId, "runner-windows-supervisor-v1")] };
  const sessions: Record<string, unknown> = {
    "session-released": { state: "released", backendBinding: jobBinding("process_session") },
    "session-active": { state: "active", backendBinding: jobBinding("process_active_session") },
  };
  const launches: Record<string, unknown> = {
    released: { state: "released", sessionId: "none", backendBinding: jobBinding("process_launch") },
    handedReleased: { state: "handed_off", sessionId: "session-released", backendBinding: jobBinding("process_session") },
    handedActive: { state: "handed_off", sessionId: "session-active", backendBinding: jobBinding("process_active_session") },
    blocked: { state: "cleanup_blocked", sessionId: "none", backendBinding: jobBinding("process_blocked") },
  };
  const streaming = {
    listSessionIds: () => Object.keys(sessions), readBySession: (id: string) => sessions[id],
    listHostLaunchIds: () => Object.keys(launches), readHostLaunch: (id: string) => launches[id],
  } as unknown as StreamingSessionStore;
  const named = releasedWindowsJobRecords(runId, settled, streaming).map((entry) => entry.processId).sort();
  assert.deepEqual(named, ["process_cleaned", "process_launch", "process_session"]);
});
