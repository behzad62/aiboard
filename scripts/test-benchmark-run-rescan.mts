/* Benchmark run-file rescan checks (run: npx tsx scripts/test-benchmark-run-rescan.mts)
 *
 * Covers the A3 plumbing: a run file that appears AFTER init is merged by
 * rescanBenchmarkRunFiles(); a corrupt blob is counted, skipped, and warned;
 * an unchanged file is not re-merged on a double rescan (record counts stable).
 */
import {
  __clearClientStoreForTests,
  __resetClientStoreForTests,
  __enableBenchmarkRunBlobStorageForTests,
  __setBenchmarkRunBlobRawForTests,
  getBenchmarkRuns,
  getBenchmarkAttemptsV2,
  getCorruptBenchmarkRunCount,
  rescanBenchmarkRunFiles,
} from "../lib/client/store";
import type {
  BenchmarkAttemptV2,
  BenchmarkReportBundleV2,
  BenchmarkRun,
} from "../lib/benchmark/types";

let failures = 0;
function check(name: string, ok: boolean, detail?: unknown): void {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` -> ${JSON.stringify(detail)}`}`);
}

const now = "2026-07-02T12:00:00.000Z";

function runFixture(id: string): BenchmarkRun {
  return {
    id,
    suiteId: "suite-rescan",
    name: `Run ${id}`,
    domain: "model-call",
    status: "completed",
    startedAt: now,
    completedAt: now,
    source: "manual",
    modelIds: ["provider:model"],
    caseIds: ["case-rescan"],
    summaryJson: "{}",
    metricValueIds: [],
    artifactIds: [],
    failureIds: [],
  };
}

function attemptFixture(runId: string): BenchmarkAttemptV2 {
  return {
    id: `attempt-${runId}`,
    runId,
    caseId: "case-rescan",
    teamCompositionId: "team-rescan",
    mode: "certified",
    track: "toolreliability",
    harnessProfile: "raw-single-model",
    status: "passed",
    startedAt: now,
    completedAt: now,
    verifiedQuality: 1,
    jobSuccessScore: 100,
    efficiencyScore: 100,
    toolReliabilityScore: 100,
    costUsd: null,
    inputTokens: 10,
    outputTokens: 5,
    modelCalls: 1,
    toolCalls: 0,
    durationMs: 100,
    artifactIds: [],
    traceIds: [],
    failureIds: [],
    harnessVersion: "toolreliability-harness-current",
    promptSetVersion: "toolreliability-prompts-current",
    scoringVersion: "toolreliability-current",
  };
}

/** Minimal report bundle with just runs + attemptsV2 — matches the run-file shape. */
function bundleJson(runId: string): string {
  const bundle: Pick<BenchmarkReportBundleV2, "runs" | "attemptsV2"> &
    Record<string, unknown[]> = {
    suites: [],
    runs: [runFixture(runId)],
    cases: [],
    caseV2: [],
    attempts: [],
    attemptsV2: [attemptFixture(runId)],
    metricValues: [],
    artifacts: [],
    failures: [],
    traces: [],
    runEvents: [],
    toolCallTraces: [],
    verifierResults: [],
    teamCompositions: [],
    harnessCertifications: [],
  };
  return JSON.stringify(bundle);
}

// ── Setup: fresh store + test blob storage ────────────────────────────────────
__resetClientStoreForTests();
__enableBenchmarkRunBlobStorageForTests();

check(
  "store starts with no benchmark runs in memory",
  getBenchmarkRuns().length === 0 && getBenchmarkAttemptsV2().length === 0
);

// ── 1) A new run file appears after init -> rescan merges it ───────────────────
__setBenchmarkRunBlobRawForTests("run-new-1", bundleJson("run-new-1"));
const first = await rescanBenchmarkRunFiles();
check("rescan reports one merged run file", first.merged === 1, first);
check("rescan reports zero corrupt files", first.corrupt === 0, first);
check(
  "rescan merged the run record into memory",
  getBenchmarkRuns().some((run) => run.id === "run-new-1")
);
check(
  "rescan merged the attempt record into memory",
  getBenchmarkAttemptsV2().some((attempt) => attempt.id === "attempt-run-new-1")
);

// ── 2) Unchanged files are not re-merged on a double rescan ───────────────────
const runsAfterFirst = getBenchmarkRuns().length;
const attemptsAfterFirst = getBenchmarkAttemptsV2().length;
const second = await rescanBenchmarkRunFiles();
check("second rescan merges nothing new", second.merged === 0, second);
check(
  "record counts stay stable across a double rescan",
  getBenchmarkRuns().length === runsAfterFirst &&
    getBenchmarkAttemptsV2().length === attemptsAfterFirst,
  { runsAfterFirst, attemptsAfterFirst }
);

// ── 3) A corrupt blob is counted, skipped, and warned once ────────────────────
const warnings: string[] = [];
const originalWarn = console.warn;
console.warn = (...args: unknown[]) => {
  warnings.push(args.map(String).join(" "));
};
__setBenchmarkRunBlobRawForTests("run-corrupt-1", "{ this is not valid json");
// A second valid file alongside the corrupt one confirms the good one still merges.
__setBenchmarkRunBlobRawForTests("run-new-2", bundleJson("run-new-2"));
const third = await rescanBenchmarkRunFiles();
console.warn = originalWarn;

check("rescan still merges the healthy file next to a corrupt one", third.merged === 1, third);
check("rescan counts the corrupt file", third.corrupt === 1, third);
check(
  "getCorruptBenchmarkRunCount reflects the corrupt file",
  getCorruptBenchmarkRunCount() === 1
);
check(
  "corrupt file is skipped (not merged into memory)",
  !getBenchmarkRuns().some((run) => run.id === "run-corrupt-1")
);
check(
  "healthy sibling file merged into memory",
  getBenchmarkRuns().some((run) => run.id === "run-new-2")
);
check(
  "corrupt blob is warned with the run id",
  warnings.some((line) => line.includes("run-corrupt-1")),
  warnings
);

// ── 4) Corrupt blob warned at most once per session ───────────────────────────
const warnings2: string[] = [];
console.warn = (...args: unknown[]) => {
  warnings2.push(args.map(String).join(" "));
};
const fourth = await rescanBenchmarkRunFiles();
console.warn = originalWarn;
check("corrupt count stays at one across a repeat rescan", fourth.corrupt === 1, fourth);
check(
  "corrupt blob is not warned again on a repeat rescan",
  !warnings2.some((line) => line.includes("run-corrupt-1")),
  warnings2
);

__clearClientStoreForTests();

if (failures === 0) {
  console.log("PASS");
} else {
  console.log(`FAIL ${failures} check(s) failed`);
}
process.exit(failures === 0 ? 0 : 1);
