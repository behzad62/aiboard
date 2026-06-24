/* Benchmark lab regression checks (run: npx tsx scripts/test-benchmark-lab.mts) */
import type {
  BuildCheckpoint,
  GenericGameMatchRecord,
  ModelBuildStat,
} from "../lib/db/schema";
import { buildBenchmarkDashboardData } from "../lib/benchmark/metrics";
import {
  __resetBenchmarkStoreForTests,
  exportBenchmarkReportBundle,
  importBenchmarkReportBundle,
  listBenchmarkCases,
  saveBenchmarkCase,
  saveBenchmarkFailure,
  saveBenchmarkRun,
} from "../lib/benchmark/store";
import { formatBenchmarkMarkdownReport } from "../lib/benchmark/reports";
import type { BenchmarkCase, BenchmarkRun } from "../lib/benchmark/types";

let failures = 0;

function check(name: string, ok: boolean, detail?: unknown): void {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` -> ${JSON.stringify(detail)}`}`);
}

const match: GenericGameMatchRecord = {
  id: "connect-four-match-1",
  gameId: "connect-four",
  timestamp: "2026-06-24T10:00:00.000Z",
  participants: [
    {
      id: "red",
      kind: "ai",
      label: "Red",
      modelId: "google:gemini-test",
      reasoningEffort: "medium",
    },
    {
      id: "yellow",
      kind: "ai",
      label: "Yellow",
      modelId: "openai:gpt-test",
      reasoningEffort: "low",
    },
  ],
  resultJson: JSON.stringify({ result: "red", winner: "red", draw: false }),
  statsJson: JSON.stringify({
    moves: 12,
    durationMs: 6000,
    avgAiResponseMs: 500,
    invalidResponses: 2,
    fallbackMoves: 1,
  }),
};

const buildStat: ModelBuildStat = {
  modelId: "google:gemini-test",
  displayName: "Gemini Test",
  builds: 1,
  attempts: 4,
  approvals: 2,
  fixes: 1,
  badOutput: 1,
  unavailable: 0,
  wApprovals: 2,
  wFixes: 1,
  wBadOutput: 1,
  responseMs: 2000,
  responseChars: 800,
  judges: { "openai:gpt-test": 3 },
  independentVerdicts: 3,
  updatedAt: "2026-06-24T10:05:00.000Z",
};

const checkpoint: BuildCheckpoint = {
  discussionId: "discussion-1",
  status: "blocked",
  updatedAt: "2026-06-24T10:06:00.000Z",
  runPolicy: "finish",
  stopReason: "blocked",
  wave: 2,
  tasks: [],
  architectNotes: "",
  verifyCommand: "npm run build",
  branch: "codex/test",
  prUrl: null,
  milestone: null,
  issueNumbers: [],
  failureFingerprints: {},
  recoveryLog: [],
  buildProblems: [
    {
      id: "problem-1",
      createdAt: "2026-06-24T10:06:00.000Z",
      code: "malformed_tool_call",
      severity: "error",
      source: "worker",
      message: "Tool call was malformed.",
      modelId: "google:gemini-test",
      modelName: "Gemini Test",
      providerId: "google",
    },
  ],
  commandProblems: [],
  stopReport: null,
  toolReviewReport: null,
  usageWindow: {
    startedAt: "2026-06-24T10:00:00.000Z",
    elapsedMs: 10_000,
    estimatedUsd: 0.12,
    unknownPricedModelIds: [],
    models: [
      {
        modelId: "google:gemini-test",
        modelName: "Gemini Test",
        providerId: "google",
        calls: 4,
        inputTokens: 1000,
        outputTokens: 200,
        totalTokens: 1200,
        estimatedUsd: 0.12,
        priced: true,
      },
    ],
  },
};

const dashboard = buildBenchmarkDashboardData({
  gameMatches: [match],
  buildStats: [buildStat],
  buildCheckpoints: [checkpoint],
  benchmarkRuns: [],
  benchmarkCases: [],
  benchmarkMetricValues: [],
  benchmarkFailures: [],
});

const gemini = dashboard.models.find((model) => model.modelId === "google:gemini-test");
const gpt = dashboard.models.find((model) => model.modelId === "openai:gpt-test");

check("dashboard tracks both game models", dashboard.models.length === 2, dashboard.models);
check("winner model receives game win", gemini?.wins === 1, gemini);
check("losing model receives game loss", gpt?.losses === 1, gpt);
check("fallback rate is represented", (gemini?.fallbackRate ?? 0) > 0, gemini);
check("build failures are categorized", dashboard.failureRows[0]?.tool === 1, dashboard.failureRows);
check("head-to-head result is tracked", dashboard.headToHeadRows[0]?.modelAWins + dashboard.headToHeadRows[0]?.modelBWins === 1, dashboard.headToHeadRows);
check("summary includes cost", dashboard.summary.averageCostUsd === 0.12, dashboard.summary);

__resetBenchmarkStoreForTests();
const benchmarkCase: BenchmarkCase = {
  id: "case-1",
  kind: "real-work",
  domain: "build",
  title: "Fix build",
  createdAt: "2026-06-24T10:00:00.000Z",
  updatedAt: "2026-06-24T10:00:00.000Z",
  tags: ["real-work"],
  configJson: "{}",
};
const benchmarkRun: BenchmarkRun = {
  id: "run-1",
  name: "Run 1",
  domain: "build",
  status: "completed",
  startedAt: "2026-06-24T10:00:00.000Z",
  source: "manual",
  modelIds: ["google:gemini-test"],
  caseIds: ["case-1"],
  summaryJson: "{}",
  metricValueIds: [],
  artifactIds: [],
  failureIds: [],
};

await saveBenchmarkCase(benchmarkCase);
await saveBenchmarkRun(benchmarkRun);
await saveBenchmarkFailure({
  id: "failure-1",
  domain: "build",
  source: "parser",
  code: "malformed_json",
  severity: "error",
  message: "Bad JSON",
  createdAt: "2026-06-24T10:00:00.000Z",
});

const bundle = exportBenchmarkReportBundle();
const markdown = formatBenchmarkMarkdownReport(bundle, dashboard);
check("bundle exports benchmark case", bundle.cases.length === 1, bundle);
check("markdown report includes scorecards", markdown.includes("Model Scorecards"), markdown);

__resetBenchmarkStoreForTests();
await importBenchmarkReportBundle(bundle);
const importedCases = await listBenchmarkCases();
check("bundle import restores case", importedCases.length === 1, importedCases);

if (failures === 0) {
  console.log("PASS");
} else {
  console.log(`FAIL ${failures} check(s) failed`);
}

process.exit(failures === 0 ? 0 : 1);
