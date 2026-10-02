import assert from "node:assert/strict";
import { lstatSync, mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { defectClassBrief, TOP_DEFECT_CLASSES_TOKEN_LIMIT } from "../src/agent-prompts.js";
import {
  createSchedulerTempRecorders,
  decideRecordedTempCleanup,
  filterRecordsForOwner,
  isPathUnderAnyRoot,
  recordTempCreation,
  searchOwnedProcesses,
  tempCreationIdempotencyKey,
  tempCreationRecordKey,
} from "../src/cleanup-ownership.js";
import { nativeBuildCleanupRoots, searchRunnerOwnedTempLeftovers } from "../src/native-build-factory.js";
import { defectClassId, modelRiskSnapshot, topDefectClasses } from "../src/defect-history.js";
import { rebuildSchedulerProjection } from "../src/scheduler-store.js";
import { SqliteProjectMemoryStore } from "../src/sqlite-project-memory.js";
import { SqliteSchedulerStore } from "../src/sqlite-scheduler-store.js";

test("defect classes aggregate and inject the top five within the recorded cap", () => {
  const classes = Array.from({ length: 7 }, (_, index) => ({ projectId: "p", classId: defectClassId("p", `c${index}`), label: `c${index}`, count: index + 1 }));
  assert.deepEqual(topDefectClasses(classes), ["c6", "c5", "c4", "c3", "c2"]);
  const brief = defectClassBrief(topDefectClasses(classes));
  assert.ok(brief.length <= TOP_DEFECT_CLASSES_TOKEN_LIMIT, `brief is ${brief.length} chars`);
  assert.equal(defectClassBrief([]), "");
  // Long labels truncate at a word boundary, never mid-word.
  const long = defectClassBrief(["a".repeat(120), "b".repeat(120), "c".repeat(120)]);
  assert.ok(long.length <= TOP_DEFECT_CLASSES_TOKEN_LIMIT);
  assert.ok(long.endsWith(`- ${"a".repeat(120)}`), "truncates at a line boundary, never mid-word");
  assert.ok(!long.includes("b"), "the overflowing label is dropped whole");
  assert.deepEqual(modelRiskSnapshot([{ projectId: "p", modelId: "m", taskId: "t", accepted: true, defectFound: true, recordedAt: "now" }], "m"), {
    reviewedTasks: 1,
    defectTasks: 1,
    defaultTierUsed: false,
  });
  assert.equal(modelRiskSnapshot([], "m").defaultTierUsed, true);
});

test("project memory records defect classes and per-model outcomes across runs", () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-t6b-memory-"));
  try {
    const store = new SqliteProjectMemoryStore(join(root, "project-memory.sqlite"));
    store.recordDefectFinding({ projectId: "p", label: "guard never exercised", taskId: "t", reviewId: "r1", findingId: "f1", recordedAt: "2026-09-25T00:00:00.000Z" });
    // A retried tool call records the same source again without double-counting.
    store.recordDefectFinding({ projectId: "p", label: "guard never exercised", taskId: "t", reviewId: "r1", findingId: "f1", recordedAt: "2026-09-25T00:00:01.000Z" });
    store.recordDefectFinding({ projectId: "p", label: "guard never exercised", taskId: "t", reviewId: "r1", findingId: "f2", recordedAt: "2026-09-25T00:00:02.000Z" });
    store.recordModelReviewOutcome({ projectId: "p", modelId: "m", taskId: "t", accepted: true, defectFound: true, recordedAt: "2026-09-25T00:00:03.000Z" });
    store.close();
    const reopened = new SqliteProjectMemoryStore(join(root, "project-memory.sqlite"));
    try {
      assert.equal(reopened.defectClasses("p")[0]?.count, 2);
      assert.equal(reopened.defectClasses("p")[0]?.label, "guard never exercised");
      const outcomes = reopened.modelReviewOutcomes("p");
      assert.equal(outcomes.length, 1);
      assert.equal(outcomes[0]?.defectFound, true);
      assert.equal(outcomes[0]?.modelId, "m");
      // A fix re-review that clears the findings keeps one row per task and
      // model, but an earlier round's defect is never erased (B7).
      reopened.recordModelReviewOutcome({ projectId: "p", modelId: "m", taskId: "t", accepted: true, defectFound: false, recordedAt: "2026-09-25T00:00:04.000Z" });
      assert.equal(reopened.modelReviewOutcomes("p").length, 1);
      assert.equal(reopened.modelReviewOutcomes("p")[0]?.defectFound, true);
      assert.equal(reopened.modelReviewOutcomes("p")[0]?.accepted, true);
      // A task whose rounds never found a defect stays clean.
      reopened.recordModelReviewOutcome({ projectId: "p", modelId: "m", taskId: "t2", accepted: true, defectFound: false, recordedAt: "2026-09-25T00:00:05.000Z" });
      assert.equal(reopened.modelReviewOutcomes("p").length, 2);
      assert.equal(modelRiskSnapshot(reopened.modelReviewOutcomes("p"), "m").defectTasks, 1);
      assert.throws(() => reopened.recordDefectFinding({ projectId: "p", label: "   ", taskId: "t", reviewId: "r1", findingId: "f3", recordedAt: "now" }), /short defect class/);
    } finally {
      reopened.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("creation records validate identity and require absolute paths", () => {
  const record = recordTempCreation({ path: join(tmpdir(), "owned"), ownerRunId: "r", ownerProjectId: "p", createdAt: "now", kind: "directory" });
  assert.equal(record.ownerRunId, "r");
  assert.throws(() => recordTempCreation({ path: "", ownerRunId: "r", ownerProjectId: "p", createdAt: "now", kind: "directory" }), /path and owner identity/);
  assert.throws(() => recordTempCreation({ path: "relative/path", ownerRunId: "r", ownerProjectId: "p", createdAt: "now", kind: "directory" }), /absolute path/);
  // Idempotency keys derive from durable record identity, never the clock.
  assert.equal(
    tempCreationIdempotencyKey({ ...record, createdAt: "later" }),
    tempCreationIdempotencyKey(record),
  );
});

test("ownership decision keeps candidates inside runner roots and retains the rest", () => {
  const roots = [tmpdir()];
  const expected = { ownerRunId: "r", ownerProjectId: "p" };
  const eligible = { path: join(tmpdir(), "owned"), ownerRunId: "r", ownerProjectId: "p", createdAt: "now", kind: "directory" as const };
  assert.equal(
    decideRecordedTempCleanup(eligible, expected, roots, { exists: true, isSymbolicLink: false, kindMatches: true }).action,
    "cleaned",
  );
  assert.equal(
    decideRecordedTempCleanup(eligible, expected, roots, { exists: false, isSymbolicLink: false, kindMatches: true }).reason,
    "Recorded path is already absent.",
  );
  assert.equal(
    decideRecordedTempCleanup({ ...eligible, ownerRunId: "other" }, expected, roots, { exists: true, isSymbolicLink: false, kindMatches: true }).action,
    "retained",
  );
  assert.equal(
    decideRecordedTempCleanup({ ...eligible, retained: true }, expected, roots, { exists: true, isSymbolicLink: false, kindMatches: true }).action,
    "retained",
  );
  assert.equal(
    decideRecordedTempCleanup(eligible, expected, roots, { exists: true, isSymbolicLink: true, kindMatches: true }).action,
    "retained",
  );
  assert.equal(
    decideRecordedTempCleanup(eligible, expected, roots, { exists: true, isSymbolicLink: false, kindMatches: false }).action,
    "retained",
  );
  const outside = { ...eligible, path: join(tmpdir(), "..", "user-project") };
  const outsideDecision = decideRecordedTempCleanup(outside, expected, [join(tmpdir(), "aiboard-owned-root")], { exists: true, isSymbolicLink: false, kindMatches: true });
  assert.equal(outsideDecision.ownership, "unproven");
  assert.equal(outsideDecision.action, "retained");
  const inWorkspace = decideRecordedTempCleanup(eligible, expected, roots, { exists: true, isSymbolicLink: false, kindMatches: true }, [tmpdir()]);
  assert.equal(inWorkspace.action, "retained");
  assert.ok(!isPathUnderAnyRoot(join(tmpdir(), "..", "elsewhere"), roots.slice(0, 0)));
});

function seedRun(store: SqliteSchedulerStore, runId: string): void {
  store.append({
    runId,
    type: "run.initialized",
    occurredAt: "2026-09-26T00:00:00.000Z",
    actor: { role: "runner", id: "runner-test" },
    idempotencyKey: `${runId}:initialized`,
    payload: {},
  });
}

function rmTree(path: string): void {
  let last: unknown;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      rmSync(path, { recursive: true, force: true });
      return;
    } catch (error) {
      last = error;
      const start = Date.now();
      while (Date.now() - start < 25) { /* let Windows release file locks */ }
    }
  }
  throw last;
}

test("creation records persist in Runner-private scheduler state across reopen", () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-t6b-temprecords-"));
  try {
    const runId = "run_temprec";
    const store = new SqliteSchedulerStore(join(root, "scheduler.sqlite"));
    seedRun(store, runId);
    const owned = join(root, "owned");
    try {
      const sink = createSchedulerTempRecorders(store, { runId, projectId: "p" }, () => "2026-09-26T00:00:00.000Z");
      mkdirSync(owned);
      sink.recorded({ path: owned, ownerRunId: runId, kind: "directory", createdAt: "2026-09-26T00:00:00.000Z" });
      // Re-recording the same path is idempotent, not a duplicate.
      sink.recorded({ path: owned, ownerRunId: runId, kind: "directory", createdAt: "2026-09-26T00:00:01.000Z" });
    } finally {
      store.close();
    }
    const reopened = new SqliteSchedulerStore(join(root, "scheduler.sqlite"));
    try {
      const records = Object.values(rebuildSchedulerProjection(reopened.readRun(runId)).tempRecords ?? {});
      assert.equal(records.length, 1);
      assert.equal(records[0]?.path, owned);
      assert.deepEqual(filterRecordsForOwner(records, { ownerRunId: runId, ownerProjectId: "p" }).length, 1);
      assert.deepEqual(filterRecordsForOwner(records, { ownerRunId: "other", ownerProjectId: "p" }).length, 0);
      sinkCleared(reopened, runId, owned);
      assert.deepEqual(Object.values(rebuildSchedulerProjection(reopened.readRun(runId)).tempRecords ?? {}).length, 0);
    } finally {
      reopened.close();
    }
  } finally {
    rmTree(root);
  }
});

test("re-recording a path upgrades retained but never downgrades it (R3 N-3)", () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-t6b-retained-"));
  try {
    const runId = "run_retained";
    const store = new SqliteSchedulerStore(join(root, "scheduler.sqlite"));
    seedRun(store, runId);
    const sink = createSchedulerTempRecorders(store, { runId, projectId: "p" }, () => "2026-09-26T00:00:00.000Z");
    const target = join(root, "target");
    mkdirSync(target);
    sink.recorded({ path: target, ownerRunId: runId, kind: "directory", createdAt: "2026-09-26T00:00:00.000Z" });
    // A later retained record upgrades the durable record (no throw).
    sink.recorded({ path: target, ownerRunId: runId, kind: "directory", createdAt: "2026-09-26T00:00:01.000Z", retained: true });
    const key = tempCreationRecordKey(target);
    assert.equal(rebuildSchedulerProjection(store.readRun(runId)).tempRecords?.[key]?.retained, true);
    // A later non-retained record never downgrades it (no throw).
    sink.recorded({ path: target, ownerRunId: runId, kind: "directory", createdAt: "2026-09-26T00:00:02.000Z" });
    assert.equal(rebuildSchedulerProjection(store.readRun(runId)).tempRecords?.[key]?.retained, true);
    store.close();
  } finally {
    rmTree(root);
  }
});

function sinkCleared(store: SqliteSchedulerStore, runId: string, path: string): void {
  createSchedulerTempRecorders(store, { runId, projectId: "p" }, () => "2026-09-26T00:00:02.000Z").cleared(path);
}

test("conflicting temp records are refused and foreign appends are rejected", () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-t6b-tempconflict-"));
  try {
    const runId = "run_tempconflict";
    const store = new SqliteSchedulerStore(join(root, "scheduler.sqlite"));
    seedRun(store, runId);
    try {
      const sink = createSchedulerTempRecorders(store, { runId, projectId: "p" }, () => "2026-09-26T00:00:00.000Z");
      const target = join(root, "target");
      mkdirSync(target);
      sink.recorded({ path: target, ownerRunId: runId, kind: "directory", createdAt: "2026-09-26T00:00:00.000Z" });
      assert.throws(
        () => store.append({
          runId,
          type: "temp.creation_recorded",
          occurredAt: "2026-09-26T00:00:01.000Z",
          actor: { role: "runner", id: "build-runtime" },
          idempotencyKey: "temp:conflict:probe",
          payload: { path: target, ownerRunId: "forged-run", ownerProjectId: "p", createdAt: "now", kind: "directory" },
        }),
        /conflicts with its durable record/,
      );
      assert.throws(
        () => store.append({
          runId,
          type: "temp.creation_recorded",
          occurredAt: "2026-09-26T00:00:01.000Z",
          actor: { role: "worker", id: "w" },
          idempotencyKey: "temp:worker:probe",
          payload: { path: join(root, "w"), ownerRunId: runId, ownerProjectId: "p", createdAt: "now", kind: "directory" },
        }),
        /Only the runner may record temp creation/,
      );
    } finally {
      store.close();
    }
  } finally {
    rmTree(root);
  }
});

test("probe F: a forged record outside runner roots never deletes a user folder", async () => {
  const runnerRoot = mkdtempSync(join(tmpdir(), "aiboard-t6b-probef-owner-"));
  const userHome = mkdtempSync(join(tmpdir(), "aiboard-t6b-probef-user-"));
  const victim = join(userHome, "user-project");
  try {
    mkdirSync(victim);
    writeFileSync(join(victim, "precious.txt"), "user data");
    const linkFarm = join(runnerRoot, "links");
    mkdirSync(linkFarm);
    const linkPath = join(linkFarm, "evil-link");
    let haveSymlink = true;
    try {
      symlinkSync(victim, linkPath, "junction");
    } catch {
      haveSymlink = false;
    }
    const cleared: string[] = [];
    const forged = recordTempCreation({ path: victim, ownerRunId: "r", ownerProjectId: "p", createdAt: "now", kind: "directory" });
    const findings = await searchRunnerOwnedTempLeftovers({
      records: [forged],
      ownerRunId: "r",
      ownerProjectId: "p",
      runnerRoots: [runnerRoot],
      excludedRoots: [],
      cleared: (path) => { cleared.push(path); },
    });
    assert.equal(findings.length, 1);
    assert.equal(findings[0]?.action, "retained");
    assert.equal(findings[0]?.ownership, "unproven");
    assert.equal(cleared.length, 0);
    assert.equal(lstatSync(victim).isDirectory(), true);
    assert.equal(lstatSync(join(victim, "precious.txt")).isFile(), true);
    if (haveSymlink) {
      const linkRecord = recordTempCreation({ path: linkPath, ownerRunId: "r", ownerProjectId: "p", createdAt: "now", kind: "directory" });
      const linkFindings = await searchRunnerOwnedTempLeftovers({
        records: [linkRecord],
        ownerRunId: "r",
        ownerProjectId: "p",
        runnerRoots: [runnerRoot],
        excludedRoots: [],
        cleared: (path) => { cleared.push(path); },
      });
      assert.equal(linkFindings[0]?.action, "retained");
      assert.equal(cleared.length, 0);
      assert.equal(lstatSync(victim).isDirectory(), true);
    }
    // An eligible owned leftover under the roots is still cleaned.
    const leftover = join(runnerRoot, "leftover");
    mkdirSync(leftover);
    const ownedRecord = recordTempCreation({ path: leftover, ownerRunId: "r", ownerProjectId: "p", createdAt: "now", kind: "directory" });
    const ownedFindings = await searchRunnerOwnedTempLeftovers({
      records: [ownedRecord],
      ownerRunId: "r",
      ownerProjectId: "p",
      runnerRoots: [runnerRoot],
      excludedRoots: [],
      cleared: (path) => { cleared.push(path); },
    });
    assert.equal(ownedFindings[0]?.action, "cleaned");
    assert.deepEqual(cleared, [leftover]);
  } finally {
    rmSync(runnerRoot, { recursive: true, force: true });
    rmSync(userHome, { recursive: true, force: true });
  }
});

test("probe F2 (R2-B6): production roots never delete records under the system temp or Runner state directories", async () => {
  // The exact root set the factory's cleanupAfterAttempt passes. Before
  // R2-B6 it was [tmpdir(), stateDirectory, runRoot], so both victims below
  // were deletion candidates.
  const state = mkdtempSync(join(tmpdir(), "aiboard-r2-state-"));
  const project = mkdtempSync(join(tmpdir(), "aiboard-r2-project-"));
  const userHome = mkdtempSync(join(tmpdir(), "someone-elses-folder-"));
  const runId = "run-1";
  try {
    const victim = join(userHome, "user-data");
    mkdirSync(victim);
    writeFileSync(join(victim, "precious.txt"), "user data");
    const stateVictim = join(state, "credentials-dir");
    mkdirSync(stateVictim);
    writeFileSync(join(stateVictim, "secret.txt"), "credentials");
    const runRootVictim = join(state, "builds", "run-1", "scheduler-copy");
    mkdirSync(runRootVictim, { recursive: true });
    const roots = nativeBuildCleanupRoots(state, runId);
    assert.ok(!roots.includes(tmpdir()) && !roots.includes(state), roots.join(","));
    const verificationRoot = roots[0]!;
    mkdirSync(verificationRoot, { recursive: true });
    const report = join(verificationRoot, ".aiboard-report-fv-g-tests-0-1.xml");
    writeFileSync(report, "<testsuites/>");
    const record = (path: string, kind: "directory" | "file") => recordTempCreation({ path, ownerRunId: runId, ownerProjectId: "proj-1", createdAt: "now", kind });
    const cleared: string[] = [];
    const findings = await searchRunnerOwnedTempLeftovers({
      records: [record(victim, "directory"), record(stateVictim, "directory"), record(runRootVictim, "directory"), record(report, "file")],
      ownerRunId: runId,
      ownerProjectId: "proj-1",
      runnerRoots: roots,
      excludedRoots: [project],
      cleared: (path) => { cleared.push(path); },
    });
    assert.equal(lstatSync(join(victim, "precious.txt")).isFile(), true, "a user folder under the system temp directory survives");
    assert.equal(lstatSync(join(stateVictim, "secret.txt")).isFile(), true, "a Runner state folder outside the workspace roots survives");
    assert.equal(lstatSync(runRootVictim).isDirectory(), true, "the run root is not a deletion root");
    assert.deepEqual(findings.filter((finding) => finding.action === "retained").map((finding) => finding.path).sort(), [victim, stateVictim, runRootVictim].sort());
    // A recorded junit report inside the verification workspace is cleaned.
    assert.deepEqual(cleared, [report]);
    assert.throws(() => lstatSync(report));
  } finally {
    rmSync(state, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
    rmSync(userHome, { recursive: true, force: true });
  }
});

test("process search stops proven-owned leftovers and retains the uncertain", async () => {
  let stopped = 0;
  const service = {
    listRun: async (runId: string) => {
      assert.equal(runId, "r");
      const alive = stopped === 0 ? "running" : "stopped";
      return [
        { processId: "alive", runId: "r", status: alive },
        { processId: "gone", runId: "r", status: "exited_unknown" },
        { processId: "done", runId: "r", status: "stopped" },
      ];
    },
    stopRun: async (runId: string) => {
      assert.equal(runId, "r");
      stopped += 1;
    },
  };
  const findings = await searchOwnedProcesses(service as never, "r");
  assert.equal(stopped, 1);
  const byId = new Map(findings.map((finding) => [finding.processId, finding]));
  assert.equal(byId.get("alive")?.action, "cleaned");
  assert.equal(byId.get("alive")?.ownership, "proven");
  assert.equal(byId.get("gone")?.action, "retained");
  assert.ok(byId.get("gone")?.reason.includes("unknown"));
  assert.ok(!byId.has("done"), "stopped processes are not leftovers");
});

test("process search retains everything when the stop request fails", async () => {
  const service = {
    listRun: async () => [{ processId: "alive", runId: "r", status: "running" }],
    stopRun: async () => { throw new Error("stop unavailable"); },
  };
  const findings = await searchOwnedProcesses(service as never, "r");
  assert.equal(findings.length, 1);
  assert.equal(findings[0]?.action, "retained");
  assert.equal(findings[0]?.ownership, "proven");
});
