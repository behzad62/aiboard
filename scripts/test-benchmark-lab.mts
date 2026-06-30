/* Benchmark lab regression checks (run: npx tsx scripts/test-benchmark-lab.mts) */
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { CertifiedBenchmarkOverview } from "../components/benchmark/certified/CertifiedBenchmarkOverview";
import type {
  BuildCheckpoint,
  GenericGameMatchRecord,
  ModelBuildStat,
} from "../lib/db/schema";
import { buildBenchmarkDashboardData } from "../lib/benchmark/metrics";
import {
  __resetBenchmarkStoreForTests,
  exportBenchmarkReportBundleV2,
  importBenchmarkReportBundleV2,
  listBenchmarkCases,
  saveBenchmarkCase,
  saveBenchmarkFailure,
  saveBenchmarkRun,
  __exportBenchmarkStoreForTests,
  __replaceBenchmarkStoreForTests,
} from "../lib/benchmark/store";
import { formatBenchmarkMarkdownReport } from "../lib/benchmark/reports";
import {
  createGameModelCallTrace,
  recordBenchmarkModelCallTrace,
} from "../lib/benchmark/model-call-traces";
import type { BenchmarkCase, BenchmarkRun } from "../lib/benchmark/types";

let failures = 0;

function check(name: string, ok: boolean, detail?: unknown): void {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` -> ${JSON.stringify(detail)}`}`);
}

async function expectReject(
  name: string,
  action: () => Promise<void>,
  messagePattern: RegExp
): Promise<void> {
  try {
    await action();
    check(name, false, "resolved");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    check(name, messagePattern.test(message), message);
  }
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
const trace = createGameModelCallTrace({
  modelId: "google:gemini-test",
  providerId: "google",
  participantId: "yellow",
  reasoningEffort: "medium",
  schemaMode: "structured",
  promptText: "connect four prompt",
  startedAt: "2026-06-24T10:00:00.000Z",
  completedAt: "2026-06-24T10:00:02.000Z",
  latencyMs: 2000,
  rawResponse: `${"x".repeat(9000)}done`,
  parsedResponseJson: JSON.stringify({ column: 4 }),
  diagnostics: [
    {
      attempt: 1,
      type: "parse",
      message: "Bad JSON",
      rawResponse: "{",
    },
    {
      attempt: 2,
      type: "request",
      message: "Provider unavailable",
    },
  ],
  finalStatus: "parsed",
});
const terminalFailureTrace = createGameModelCallTrace({
  modelId: "google:gemini-test",
  providerId: "google",
  startedAt: "2026-06-24T10:00:00.000Z",
  diagnostics: [
    { attempt: 1, type: "request", message: "First provider failure" },
    { attempt: 2, type: "request", message: "Second provider failure" },
    { attempt: 3, type: "request", message: "Final provider failure" },
  ],
  finalStatus: "provider_error",
  error: "Final provider failure",
});
await recordBenchmarkModelCallTrace(trace);
__replaceBenchmarkStoreForTests({
  ...__exportBenchmarkStoreForTests(),
  gameMatchRecords: [match],
  buildCheckpoints: [checkpoint],
  modelStats: [buildStat],
});

const bundle = exportBenchmarkReportBundleV2();
const markdown = formatBenchmarkMarkdownReport(bundle, dashboard);
check("bundle exports benchmark case", bundle.cases.length === 1, bundle);
check("trace records prompt hash", Boolean(bundle.traces[0]?.promptHash), bundle.traces);
check(
  "trace maps diagnostic retry statuses",
  bundle.traces[0]?.retryHistory[0]?.status === "parse_error" &&
    bundle.traces[0]?.retryHistory[1]?.status === "provider_error" &&
    bundle.traces[0]?.retryHistory[2]?.status === "parsed",
  bundle.traces[0]?.retryHistory
);
check(
  "trace caps raw response size",
  (bundle.traces[0]?.rawResponse?.length ?? 0) < 9000,
  bundle.traces[0]?.rawResponse?.length
);
check(
  "terminal trace does not add phantom retry attempts",
  terminalFailureTrace.retryHistory.length === 3 &&
    terminalFailureTrace.retryHistory.at(-1)?.message === "Final provider failure",
  terminalFailureTrace.retryHistory
);
check(
  "bundle exports game match source evidence",
  bundle.sourceEvidence?.gameMatches.length === 1,
  bundle.sourceEvidence
);
check(
  "bundle exports build checkpoint source evidence",
  bundle.sourceEvidence?.buildCheckpoints.length === 1,
  bundle.sourceEvidence
);
check(
  "bundle exports build model stats source evidence",
  bundle.sourceEvidence?.buildStats.length === 1,
  bundle.sourceEvidence
);
check("markdown report includes scorecards", markdown.includes("Model Scorecards"), markdown);
check(
  "markdown report includes source evidence counts",
  markdown.includes("Game match records: 1") &&
    markdown.includes("Build checkpoints: 1") &&
    markdown.includes("Build model stats: 1"),
  markdown
);

__resetBenchmarkStoreForTests();
await importBenchmarkReportBundleV2(bundle);
const importedCases = await listBenchmarkCases();
const importedStore = __exportBenchmarkStoreForTests();
check("bundle import restores case", importedCases.length === 1, importedCases);
check(
  "bundle import restores game match source evidence",
  importedStore.gameMatchRecords.length === 1,
  importedStore.gameMatchRecords
);
check(
  "bundle import restores build checkpoint source evidence",
  importedStore.buildCheckpoints.length === 1,
  importedStore.buildCheckpoints
);
check(
  "bundle import restores build model stats source evidence",
  importedStore.modelStats.some((stat) => stat.modelId === buildStat.modelId),
  importedStore.modelStats
);

const certifiedCounts = {
  runs: 0,
  runsByMode: { lab: 0, certified: 1 },
  runsBySource: {},
  runsByTrack: {},
  cases: 0,
  certifiedCases: 1,
  benchmarkAttempts: 0,
  certifiedAttempts: 1,
  verifierResults: 0,
  teamCompositions: 0,
};
const providerOnlyCertifiedMarkup = renderToStaticMarkup(
  React.createElement(CertifiedBenchmarkOverview, {
    certified: {
      summary: {
        certifiedRuns: 1,
        certifiedCases: 1,
        certifiedAttempts: 1,
        scoredAttempts: 0,
        excludedAttempts: 1,
        excludedProviderAttempts: 1,
        excludedHarnessAttempts: 0,
        excludedEnvironmentAttempts: 0,
        excludedUserAttempts: 0,
      },
      leaderboard: [],
      providerErrorAttempts: [
        {
          id: "attempt-provider-only",
          track: "workbench",
        },
      ],
    },
    counts: certifiedCounts,
    track: "workbench",
  })
);
check(
  "certified provider-error cleanup remains visible when track has only excluded attempts",
  providerOnlyCertifiedMarkup.includes("Remove provider-error results"),
  providerOnlyCertifiedMarkup
);
check(
  "certified provider-only empty state still explains there are no scored attempts",
  providerOnlyCertifiedMarkup.includes("no scored certified attempts"),
  providerOnlyCertifiedMarkup
);

await expectReject(
  "bundle import rejects malformed records",
  () =>
    importBenchmarkReportBundleV2({
      ...bundle,
      cases: [{ ...benchmarkCase, id: 42 } as unknown as BenchmarkCase],
    }),
  /invalid/i
);
await expectReject(
  "bundle import rejects malformed game match source evidence",
  () =>
    importBenchmarkReportBundleV2({
      ...bundle,
      sourceEvidence: {
        ...bundle.sourceEvidence!,
        gameMatches: [{ id: "bad-match" } as never],
      },
    }),
  /invalid/i
);
await expectReject(
  "bundle import rejects malformed build checkpoint source evidence",
  () =>
    importBenchmarkReportBundleV2({
      ...bundle,
      sourceEvidence: {
        ...bundle.sourceEvidence!,
        buildCheckpoints: [{ discussionId: "bad-checkpoint" } as never],
      },
    }),
  /invalid/i
);
await expectReject(
  "bundle import rejects malformed build task source evidence",
  () =>
    importBenchmarkReportBundleV2({
      ...bundle,
      sourceEvidence: {
        ...bundle.sourceEvidence!,
        buildCheckpoints: [
          {
            ...checkpoint,
            tasks: [
              {
                id: "task-1",
                title: "Task",
                instructions: "Do work",
                contextFiles: [42],
                status: "planned",
              },
            ],
          } as never,
        ],
      },
    }),
  /invalid/i
);
await expectReject(
  "bundle import rejects malformed usage model source evidence",
  () =>
    importBenchmarkReportBundleV2({
      ...bundle,
      sourceEvidence: {
        ...bundle.sourceEvidence!,
        buildCheckpoints: [
          {
            ...checkpoint,
            usageWindow: {
              ...checkpoint.usageWindow,
              models: [{ modelId: "bad-model" }],
            },
          } as never,
        ],
      },
    }),
  /invalid/i
);
await expectReject(
  "bundle import rejects malformed model stat source evidence",
  () =>
    importBenchmarkReportBundleV2({
      ...bundle,
      sourceEvidence: {
        ...bundle.sourceEvidence!,
        buildStats: [{ modelId: "bad-stat" } as never],
      },
    }),
  /invalid/i
);
await expectReject(
  "bundle import rejects malformed model-stat judges source evidence",
  () =>
    importBenchmarkReportBundleV2({
      ...bundle,
      sourceEvidence: {
        ...bundle.sourceEvidence!,
        buildStats: [{ ...buildStat, judges: { "bad-judge": "many" } } as never],
      },
    }),
  /invalid/i
);

if (failures === 0) {
  console.log("PASS");
} else {
  console.log(`FAIL ${failures} check(s) failed`);
}

process.exit(failures === 0 ? 0 : 1);
