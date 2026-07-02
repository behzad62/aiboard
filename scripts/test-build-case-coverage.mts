/*
 * Coverage-honesty checks for captured "real-work" build cases.
 * (run: npx tsx scripts/test-build-case-coverage.mts)
 *
 * Task E: captured Build stop-report cases are diagnostics only — never run,
 * verified, or scored. They must NOT be presented as benchmark coverage:
 *  - excluded from the dashboard/report "Cases" (coverage) count,
 *  - surfaced separately as captured (not runnable),
 *  - flagged (not counted as runnable evidence) in export/report bundles,
 * while a certified v2 case IS counted as coverage. Old persisted captured
 * cases must still load unchanged (read-time exclusion, no data deletion).
 */
import {
  createBuildBenchmarkCaseFromStopReport,
  isCapturedBuildCase,
  partitionBenchmarkCases,
} from "../lib/benchmark/build-cases";
import { buildBenchmarkDashboardData } from "../lib/benchmark/metrics";
import { formatBenchmarkMarkdownReport } from "../lib/benchmark/reports";
import type { BuildStopReport } from "../lib/db/schema";
import type {
  BenchmarkCase,
  BenchmarkCaseV2,
  BenchmarkMetricValue,
  BenchmarkReportBundleV2,
} from "../lib/benchmark/types";

let failures = 0;

function check(name: string, ok: boolean, detail?: unknown): void {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` -> ${JSON.stringify(detail)}`}`);
}

const stopReport: BuildStopReport = {
  id: "stop-report-1",
  discussionId: "disc-1",
  createdAt: "2026-07-02T10:00:00.000Z",
  topic: "Finish the auth refactor",
  status: "incomplete",
  stopReason: "incomplete",
  stopMessage: "Ran out of budget.",
  wave: 2,
  branch: "feature/auth",
  prUrl: null,
  verifyCommand: "npm test",
  summary: "Auth refactor stalled with 2 tasks remaining.",
  nextAction: "Fix the failing login test first.",
  tasksDone: 3,
  tasksTotal: 5,
  incompleteTasks: [
    { id: "t4", title: "Wire session store", status: "failed", failCount: 2 },
  ],
  primaryCause: null,
  problems: [],
  commandProblems: [],
  repeatedFailureCount: 1,
  recoveryLog: ["retried task t4"],
};

const { benchmarkCase: capturedCase, artifact: capturedArtifact } =
  createBuildBenchmarkCaseFromStopReport(stopReport);

check(
  "captured case is kind real-work",
  capturedCase.kind === "real-work",
  capturedCase.kind
);
check("captured case classified as captured", isCapturedBuildCase(capturedCase));

// A runnable (non-captured) v1 case for contrast.
const runnableV1Case: BenchmarkCase = {
  id: "game-case-1",
  kind: "game-match",
  domain: "game",
  title: "Chess mate-in-1",
  createdAt: "2026-07-02T10:00:00.000Z",
  updatedAt: "2026-07-02T10:00:00.000Z",
  tags: [],
  configJson: "{}",
};
check(
  "runnable v1 case not classified as captured",
  !isCapturedBuildCase(runnableV1Case)
);

// partitionBenchmarkCases splits correctly.
const partitioned = partitionBenchmarkCases([capturedCase, runnableV1Case]);
check(
  "partition puts captured and runnable in the right buckets",
  partitioned.runnable.length === 1 &&
    partitioned.runnable[0]?.id === runnableV1Case.id &&
    partitioned.captured.length === 1 &&
    partitioned.captured[0]?.id === capturedCase.id,
  partitioned
);

// Dashboard summary: captured excluded from totalCases, surfaced as capturedCases.
const dashboard = buildBenchmarkDashboardData({
  gameMatches: [],
  buildStats: [],
  buildCheckpoints: [],
  benchmarkRuns: [],
  benchmarkCases: [capturedCase, runnableV1Case],
  benchmarkMetricValues: [] as BenchmarkMetricValue[],
  benchmarkFailures: [],
});

check(
  "dashboard totalCases counts only runnable cases",
  dashboard.summary.totalCases === 1,
  dashboard.summary.totalCases
);
check(
  "dashboard surfaces captured stop-report cases separately",
  dashboard.summary.capturedCases === 1,
  dashboard.summary.capturedCases
);

// With ONLY a captured case present, coverage is zero (not 1).
const capturedOnly = buildBenchmarkDashboardData({
  gameMatches: [],
  buildStats: [],
  buildCheckpoints: [],
  benchmarkRuns: [],
  benchmarkCases: [capturedCase],
  benchmarkMetricValues: [] as BenchmarkMetricValue[],
  benchmarkFailures: [],
});
check(
  "a lone captured case yields zero runnable coverage",
  capturedOnly.summary.totalCases === 0 && capturedOnly.summary.capturedCases === 1,
  capturedOnly.summary
);

// A certified v2 case IS coverage.
const certifiedV2Case: BenchmarkCaseV2 = {
  id: "workbench-real-0001",
  schemaVersion: 2,
  track: "workbench",
  title: "Fix off-by-one in pager",
  description: "Repair the pagination boundary.",
  difficulty: "medium",
  tags: ["workbench"],
  caseVersion: "1.0.0",
  createdAt: "2026-07-02T10:00:00.000Z",
  updatedAt: "2026-07-02T10:00:00.000Z",
  prompt: { userRequest: "Fix the pager." },
  environment: { type: "browser", timeoutSeconds: 60, network: "none" },
  verifier: { scorer: "verifier-json" },
  budget: {},
  scoring: { scoringVersion: "certified-v0.1", primary: "verified_quality" },
  contamination: {
    originalTask: true,
    canary: "AIBENCH-CANARY-WB-0001",
    referenceSolutionPrivate: true,
  },
};

// Export/report bundle: captured case rides along (diagnostics + round-trip)
// but is flagged, not counted as runnable evidence; certified v2 case is
// counted as certified coverage.
const bundle: BenchmarkReportBundleV2 = {
  version: 2,
  exportedAt: "2026-07-02T10:00:02.000Z",
  suites: [],
  runs: [],
  cases: [capturedCase, runnableV1Case],
  attempts: [],
  metricValues: [],
  artifacts: [capturedArtifact],
  failures: [],
  traces: [],
  caseV2: [certifiedV2Case],
  attemptsV2: [],
  verifierResults: [],
  runEvents: [],
  toolCallTraces: [],
  teamCompositions: [],
  harnessCertifications: [],
  bundleHash: "test-hash",
};

const markdown = formatBenchmarkMarkdownReport(bundle, dashboard);

check(
  "report labels captured cases as diagnostics, not runnable coverage",
  markdown.includes("captured stop-report case(s), diagnostics only"),
  markdown.slice(markdown.indexOf("## Raw Bundle Counts"), markdown.indexOf("## Raw Bundle Counts") + 300)
);
check(
  "report raw bundle Cases line does not present captured cases as runnable",
  markdown.includes("- Cases: 1 runnable"),
  markdown.slice(markdown.indexOf("## Raw Bundle Counts"), markdown.indexOf("## Raw Bundle Counts") + 200)
);
check(
  "report summary reports captured cases separately from runnable cases",
  markdown.includes("- Runnable cases: 1") &&
    markdown.includes("Captured stop-report cases (diagnostics, not runnable): 1"),
  markdown.slice(0, markdown.indexOf("## Model Scorecards"))
);
check(
  "certified v2 case IS counted as certified coverage",
  markdown.includes("Certified cases: 1"),
  markdown.slice(markdown.indexOf("## Certified Run Summary"), markdown.indexOf("## Certified Run Summary") + 200)
);

// Captured case still fully loads/serializes (no data loss).
check(
  "captured case retains its diagnostic artifact",
  capturedArtifact.caseId === capturedCase.id &&
    capturedArtifact.kind === "markdown" &&
    capturedArtifact.content.length > 0,
  capturedArtifact
);

if (failures === 0) {
  console.log("PASS");
} else {
  console.log(`FAIL ${failures} check(s) failed`);
}

process.exit(failures === 0 ? 0 : 1);
