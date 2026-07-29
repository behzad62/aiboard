/* Benchmark report v2 checks (run: npx tsx scripts/test-benchmark-report-v2.mts) */
import { readFileSync } from "node:fs";
import { buildCertifiedBenchmarkDashboardData } from "../lib/benchmark/metrics";
import { formatBenchmarkMarkdownReport } from "../lib/benchmark/reports";
import { formatBenchmarkImportMessage } from "../components/benchmark/useBenchmarkReportActions";
import { withCompletedResultSetFixtures } from "./benchmark-result-set-test-fixtures";
import { benchmarkResultConfigurationKey } from "../lib/benchmark/certified/result-set-identity";
import {
  __resetBenchmarkStoreForTests,
  __exportBenchmarkStoreForTests,
  __replaceBenchmarkStoreForTests,
  importBenchmarkReportBundleV2,
} from "../lib/benchmark/store";
import type { BuildCheckpoint, ModelBuildStat } from "../lib/db/schema";
import type {
  BenchmarkAttemptV2,
  BenchmarkCaseV2,
  BenchmarkReportBundleV2,
  BenchmarkTeamComposition,
  BenchmarkVerifierResult,
} from "../lib/benchmark/types";

let failures = 0;

function check(name: string, ok: boolean, detail?: unknown): void {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` -> ${JSON.stringify(detail)}`}`);
}

const caseV2: BenchmarkCaseV2 = {
  id: "tool-json-0001",
  schemaVersion: 2,
  track: "toolreliability",
  title: "JSON schema repair",
  description: "Repair invalid structured output.",
  difficulty: "easy",
  tags: ["json"],
  caseVersion: "0.1.0",
  createdAt: "2026-06-27T10:00:00.000Z",
  updatedAt: "2026-06-27T10:00:00.000Z",
  prompt: { userRequest: "Return valid JSON." },
  environment: {
    type: "browser",
    timeoutSeconds: 60,
    network: "none",
  },
  verifier: {
    scorer: "rule-checker",
  },
  budget: {},
  scoring: {
    scoringVersion: "certified-v0.1",
    primary: "tool_reliability",
  },
  contamination: {
    originalTask: true,
    canary: "AIBENCH-CANARY-TOOL-0001",
    referenceSolutionPrivate: false,
  },
};

const team: BenchmarkTeamComposition = {
  id: "solo-gpt",
  name: "GPT solo",
  comboHash: "solo:gpt",
  roles: [
    {
      role: "single",
      slot: "single",
      modelId: "openai:gpt-test",
      providerId: "openai",
      displayName: "GPT Test",
      temperature: 0,
    },
  ],
};

const explicitDefaultTeam: BenchmarkTeamComposition = {
  ...team,
  id: "solo-gpt-explicit-default",
  comboHash: "solo:gpt:explicit-default",
  roles: [{ ...team.roles[0], reasoningEffort: "default" }],
};

const verifier: BenchmarkVerifierResult = {
  id: "verifier-tool-1",
  attemptId: "attempt-tool-1",
  caseId: caseV2.id,
  passed: true,
  score: 1,
  durationMs: 500,
  resultJson: JSON.stringify({ passed: true, score: 1 }),
  assertionResults: [
    {
      id: "schema-valid",
      label: "Schema valid",
      passed: true,
      weight: 1,
    },
  ],
  artifactIds: [],
};

const publishVerifier: BenchmarkVerifierResult = {
  id: "verifier-publish-1",
  attemptId: "attempt-publish-1",
  caseId: caseV2.id,
  passed: false,
  score: 0,
  durationMs: 500,
  resultJson: JSON.stringify({ passed: false, score: 0 }),
  assertionResults: [
    {
      id: "publish-only",
      label: "Publish-only assertion",
      passed: false,
      weight: 1,
    },
  ],
  artifactIds: [],
};

const attempt: BenchmarkAttemptV2 = {
  id: "attempt-tool-1",
  runId: "run-tool-1",
  caseId: caseV2.id,
  teamCompositionId: team.id,
  mode: "certified",
  track: "toolreliability",
  harnessProfile: "raw-single-model",
  status: "passed",
  startedAt: "2026-06-27T10:00:00.000Z",
  completedAt: "2026-06-27T10:00:01.000Z",
  verifiedQuality: 1,
  jobSuccessScore: 100,
  efficiencyScore: 100,
  toolReliabilityScore: 100,
  costUsd: 0.01,
  inputTokens: 200,
  outputTokens: 80,
  modelCalls: 1,
  toolCalls: 1,
  durationMs: 1000,
  verifierResultId: verifier.id,
  artifactIds: [],
  traceIds: [],
  failureIds: [],
  harnessVersion: "raw-v0.1",
  promptSetVersion: "tool-v0.1",
  scoringVersion: "certified-v0.1",
};

const failedAttemptWithPartialQuality: BenchmarkAttemptV2 = {
  ...attempt,
  id: "attempt-tool-failed",
  runId: "run-tool-2",
  teamCompositionId: explicitDefaultTeam.id,
  status: "failed_verifier",
  verifiedQuality: 0.5,
  jobSuccessScore: 50,
  efficiencyScore: 40,
  costUsd: 0.02,
  verifierResultId: undefined,
};

const excludedProviderAttempt: BenchmarkAttemptV2 = {
  ...attempt,
  id: "attempt-tool-excluded-provider",
  runId: "run-tool-3",
  status: "provider_unavailable",
  verifiedQuality: 0.99,
  jobSuccessScore: 99,
  efficiencyScore: 99,
  costUsd: 9.99,
  durationMs: 9999,
  verifierResultId: undefined,
};

const publishAttempt: BenchmarkAttemptV2 = {
  ...attempt,
  id: "attempt-publish-1",
  runId: "run-publish-1",
  mode: "publish",
  verifiedQuality: 1,
  jobSuccessScore: 100,
  efficiencyScore: 100,
};

const bundle: BenchmarkReportBundleV2 = {
  version: 2,
  exportedAt: "2026-06-27T10:00:02.000Z",
  suites: [],
  runs: [],
  cases: [],
  attempts: [],
  metricValues: [],
  artifacts: [],
  failures: [],
  traces: [],
  caseV2: [caseV2],
  attemptsV2: [
    attempt,
    failedAttemptWithPartialQuality,
    excludedProviderAttempt,
    publishAttempt,
  ],
  verifierResults: [verifier, publishVerifier],
  runEvents: [],
  toolCallTraces: [],
  teamCompositions: [team, explicitDefaultTeam],
  harnessCertifications: [],
  bundleHash: "test-hash",
  redactionSummary: {
    scannedArtifacts: 0,
    scannedRecords: 2,
    redactedSecrets: 1,
    warnings: ["Tool-call trace tool-1 contains blocked ssh_private_key content."],
  },
};

const invalidArtifactBundle: BenchmarkReportBundleV2 = {
  ...bundle,
  artifacts: [
    {
      id: "artifact-invalid-content",
      kind: "log",
      label: "Invalid content",
      mimeType: "text/plain",
      content: {} as unknown as string,
      createdAt: "2026-06-27T10:00:00.000Z",
    },
  ],
};
let invalidArtifactThrew = false;
try {
  __resetBenchmarkStoreForTests();
  await importBenchmarkReportBundleV2(invalidArtifactBundle);
} catch {
  invalidArtifactThrew = true;
}
check("non-string artifact content rejected", invalidArtifactThrew);

function modelStat(updatedAt: string, builds: number): ModelBuildStat {
  return {
    modelId: "openai:gpt-merge",
    displayName: "GPT Merge",
    builds,
    attempts: builds,
    approvals: builds,
    fixes: 0,
    badOutput: 0,
    unavailable: 0,
    wApprovals: builds,
    wFixes: 0,
    wBadOutput: 0,
    responseMs: builds * 100,
    responseChars: builds * 1000,
    judges: {},
    independentVerdicts: 0,
    updatedAt,
  };
}

function checkpoint(updatedAt: string, wave: number): BuildCheckpoint {
  return {
    discussionId: "discussion-merge",
    status: "running",
    updatedAt,
    runPolicy: "finish",
    stopReason: null,
    wave,
    tasks: [],
    architectNotes: "",
    verifyCommand: "npm test",
    branch: null,
    prUrl: null,
    milestone: null,
    issueNumbers: [],
    failureFingerprints: {},
    recoveryLog: [],
    buildProblems: [],
    commandProblems: [],
    stopReport: null,
    toolReviewReport: null,
    usageWindow: {
      startedAt: updatedAt,
      elapsedMs: 0,
      estimatedUsd: 0,
      unknownPricedModelIds: [],
      models: [],
    },
  };
}

const newerLocalStat = modelStat("2026-06-30T00:00:00.000Z", 30);
__replaceBenchmarkStoreForTests({ modelStats: [newerLocalStat] });
await importBenchmarkReportBundleV2({
  ...bundle,
  sourceEvidence: {
    gameMatches: [],
    buildCheckpoints: [],
    buildStats: [modelStat("2026-06-01T00:00:00.000Z", 1)],
  },
});
check(
  "legacy modelStats source evidence is ignored",
  __exportBenchmarkStoreForTests().modelStats?.find((stat) => stat.modelId === "openai:gpt-merge")?.updatedAt ===
    "2026-06-30T00:00:00.000Z",
  __exportBenchmarkStoreForTests().modelStats
);
const newerModelStatsImport = await importBenchmarkReportBundleV2({
  ...bundle,
  sourceEvidence: {
    gameMatches: [],
    buildCheckpoints: [],
    buildStats: [modelStat("2026-07-01T00:00:00.000Z", 40)],
  },
});
check(
  "newer legacy modelStats source evidence is ignored",
  __exportBenchmarkStoreForTests().modelStats?.find((stat) => stat.modelId === "openai:gpt-merge")?.updatedAt ===
    "2026-06-30T00:00:00.000Z",
  __exportBenchmarkStoreForTests().modelStats
);
check(
  "ignored modelStats source evidence is not reported as an update",
  (newerModelStatsImport?.updatedByCategory.modelStats ?? 0) === 0,
  newerModelStatsImport
);

const newerLocalCheckpoint = checkpoint("2026-06-30T00:00:00.000Z", 30);
__replaceBenchmarkStoreForTests({ buildCheckpoints: [newerLocalCheckpoint] });
await importBenchmarkReportBundleV2({
  ...bundle,
  sourceEvidence: {
    gameMatches: [],
    buildCheckpoints: [checkpoint("2026-06-01T00:00:00.000Z", 1)],
    buildStats: [],
  },
});
check(
  "legacy buildCheckpoint source evidence is ignored",
  __exportBenchmarkStoreForTests().buildCheckpoints?.find((item) => item.discussionId === "discussion-merge")?.updatedAt ===
    "2026-06-30T00:00:00.000Z",
  __exportBenchmarkStoreForTests().buildCheckpoints
);
const newerBuildCheckpointImport = await importBenchmarkReportBundleV2({
  ...bundle,
  sourceEvidence: {
    gameMatches: [],
    buildCheckpoints: [checkpoint("2026-07-01T00:00:00.000Z", 40)],
    buildStats: [],
  },
});
check(
  "newer legacy buildCheckpoint source evidence is ignored",
  __exportBenchmarkStoreForTests().buildCheckpoints?.find((item) => item.discussionId === "discussion-merge")?.updatedAt ===
    "2026-06-30T00:00:00.000Z",
  __exportBenchmarkStoreForTests().buildCheckpoints
);
check(
  "ignored buildCheckpoint source evidence is not reported as an update",
  (newerBuildCheckpointImport?.updatedByCategory.buildCheckpoints ?? 0) === 0,
  newerBuildCheckpointImport
);

const certifiedFixture = withCompletedResultSetFixtures({
  caseV2: bundle.caseV2,
  attemptsV2: bundle.attemptsV2,
  verifierResults: bundle.verifierResults,
  teamCompositions: bundle.teamCompositions,
  harnessCertifications: bundle.harnessCertifications,
});
const certified = buildCertifiedBenchmarkDashboardData(certifiedFixture);

check("certified dashboard counts only latest completed runs and cases", certified.summary.certifiedRuns === 1 && certified.summary.certifiedCases === 1, certified.summary);
check("certified dashboard filters non-certified and historical attempts", certified.summary.certifiedAttempts === 1, certified.summary);
check(
  "certified dashboard keeps unpublished exclusions audit-only",
  certified.summary.scoredAttempts === 1 &&
    certified.summary.excludedAttempts === 0 &&
    certified.summary.excludedProviderAttempts === 0 &&
    certified.audit.legacyAttempts === 1,
  certified.summary
);
check("certified dashboard preserves honest failed-verifier quality", certified.summary.verifiedPassRate === 0, certified.summary);
check("certified dashboard uses the latest immutable snapshot", certified.leaderboard[0]?.verifiedQuality === 0.5 && certified.leaderboard[0]?.historyCount === 1, certified.leaderboard);
check("certified leaderboard pass count uses latest snapshot status", certified.leaderboard[0]?.passed === 0 && certified.leaderboard[0]?.failed === 1, certified.leaderboard[0]);
check("certified dashboard filters non-certified verifier assertions", !certified.verifierAssertionRows.some((row) => row.id === "publish-only"), certified.verifierAssertionRows);
check(
  "certified dashboard excludes historical and provider-unavailable evidence from averages",
  certified.summary.averageVerifiedQuality === 0.5 &&
    certified.summary.averageCostUsd === 0.02 &&
    certified.summary.averageDurationMs === 1000,
  certified.summary
);

const completedBundle: BenchmarkReportBundleV2 = {
  ...bundle,
  runs: certifiedFixture.runs,
  caseV2: certifiedFixture.caseV2,
  attemptsV2: certifiedFixture.attemptsV2,
  verifierResults: certifiedFixture.verifierResults,
  artifacts: certifiedFixture.artifacts,
  failures: certifiedFixture.failures,
  traces: certifiedFixture.traces,
  runEvents: certifiedFixture.runEvents,
  toolCallTraces: certifiedFixture.toolCallTraces,
  harnessCertifications: [{
    id: "unscoped-certification",
    createdAt: "2026-06-27T10:00:00.000Z",
    aiboardVersion: "test",
    benchmarkEngineVersion: "test",
    harnessProfile: "raw-single-model",
    harnessVersion: "test",
    promptSetVersion: "test",
    passed: true,
    checks: [],
  }],
  resultSets: certifiedFixture.resultSets.map((resultSet) => ({
    ...resultSet,
    metrics: {
      ...resultSet.metrics!,
      verifiedQuality: 0.9,
      overallScore: 0.9,
      jobSuccessScore: 90,
      efficiencyScore: 90,
      trackBreakdown: resultSet.metrics!.trackBreakdown.map((track) => ({
        ...track,
        averageVerifiedQuality: 0.9,
      })),
    },
  })),
};
const markdown = formatBenchmarkMarkdownReport(completedBundle, {
  summary: {
    totalRuns: 0,
    totalCases: 0,
    capturedCases: 0,
    totalModels: 0,
    completionRate: null,
    schemaValidRate: null,
    legalActionRate: null,
    fallbackRate: null,
    averageCostUsd: null,
    averageLatencyMs: null,
  },
  models: [],
  radarRows: [],
  rateBars: [],
  costQualityPoints: [],
  latencyQualityPoints: [],
  trendRows: [],
  failureRows: [],
  headToHeadRows: [],
  evidenceByModel: {},
});

const lowVariantTeam: BenchmarkTeamComposition = {
  ...team,
  id: "solo-variant-low",
  name: "Variant Model low",
  comboHash: "solo:variant-model:low",
  roles: [
    {
      ...team.roles[0],
      modelId: "openai:variant-model",
      displayName: "Variant Model",
      reasoningEffort: "low",
    },
  ],
};
const highVariantTeam: BenchmarkTeamComposition = {
  ...lowVariantTeam,
  id: "solo-variant-high",
  name: "Variant Model high",
  comboHash: "solo:variant-model:high",
  roles: [
    {
      ...lowVariantTeam.roles[0],
      reasoningEffort: "high",
    },
  ],
};
const variantFixture = withCompletedResultSetFixtures({
  caseV2: bundle.caseV2,
  attemptsV2: [
    {
      ...attempt,
      id: "attempt-variant-low",
      runId: "run-variant-low",
      teamCompositionId: lowVariantTeam.id,
    },
    {
      ...attempt,
      id: "attempt-variant-high",
      runId: "run-variant-high",
      teamCompositionId: highVariantTeam.id,
    },
  ],
  verifierResults: [],
  teamCompositions: [lowVariantTeam, highVariantTeam],
  harnessCertifications: [],
});
const variantMarkdown = formatBenchmarkMarkdownReport(
  {
    ...bundle,
    runs: variantFixture.runs,
    caseV2: variantFixture.caseV2,
    attemptsV2: variantFixture.attemptsV2,
    verifierResults: variantFixture.verifierResults,
    artifacts: variantFixture.artifacts,
    failures: variantFixture.failures,
    traces: variantFixture.traces,
    runEvents: variantFixture.runEvents,
    toolCallTraces: variantFixture.toolCallTraces,
    teamCompositions: variantFixture.teamCompositions,
    resultSets: variantFixture.resultSets,
  },
  {
    summary: {
      totalRuns: 0,
      totalCases: 0,
      capturedCases: 0,
      totalModels: 0,
      completionRate: null,
      schemaValidRate: null,
      legalActionRate: null,
      fallbackRate: null,
      averageCostUsd: null,
      averageLatencyMs: null,
    },
    models: [],
    radarRows: [],
    rateBars: [],
    costQualityPoints: [],
    latencyQualityPoints: [],
    trendRows: [],
    failureRows: [],
    headToHeadRows: [],
    evidenceByModel: {},
  }
);
check(
  "markdown keeps model effort variants as separate entries",
  variantMarkdown.includes("- Variant Model · Low:") &&
    variantMarkdown.includes("- Variant Model · High:") &&
    !variantMarkdown.includes("- Variant Model:"),
  variantMarkdown
);

const exactReportFixture = withCompletedResultSetFixtures({
  caseV2: bundle.caseV2,
  attemptsV2: [
    {
      ...attempt,
      id: "attempt-max-100",
      runId: "run-max-100",
      teamCompositionId: lowVariantTeam.id,
    },
    {
      ...attempt,
      id: "attempt-max-200",
      runId: "run-max-200",
      teamCompositionId: lowVariantTeam.id,
    },
  ],
  verifierResults: [],
  teamCompositions: [lowVariantTeam],
  harnessCertifications: [],
});
const exactReportResultSets = exactReportFixture.resultSets.map(
  (resultSet, index) => {
    const configuration = {
      ...resultSet.configuration,
      tracks: resultSet.configuration.tracks.map((track) => ({
        ...track,
        maxTokens: index === 0 ? 100 : 200,
      })),
    };
    const quality = index === 0 ? 0.3 : 0.8;
    return {
      ...resultSet,
      configuration,
      configurationKey: benchmarkResultConfigurationKey(configuration),
      metrics: {
        ...resultSet.metrics!,
        verifiedQuality: quality,
        overallScore: quality,
        trackBreakdown: resultSet.metrics!.trackBreakdown.map((track) => ({
          ...track,
          averageVerifiedQuality: quality,
        })),
      },
    };
  }
);
const exactReportMarkdown = formatBenchmarkMarkdownReport(
  {
    ...bundle,
    runs: exactReportFixture.runs,
    caseV2: exactReportFixture.caseV2,
    attemptsV2: exactReportFixture.attemptsV2,
    verifierResults: exactReportFixture.verifierResults,
    artifacts: exactReportFixture.artifacts,
    failures: exactReportFixture.failures,
    traces: exactReportFixture.traces,
    runEvents: exactReportFixture.runEvents,
    toolCallTraces: exactReportFixture.toolCallTraces,
    teamCompositions: exactReportFixture.teamCompositions,
    resultSets: exactReportResultSets,
  },
  {
    summary: {
      totalRuns: 0,
      totalCases: 0,
      capturedCases: 0,
      totalModels: 0,
      completionRate: null,
      schemaValidRate: null,
      legalActionRate: null,
      fallbackRate: null,
      averageCostUsd: null,
      averageLatencyMs: null,
    },
    models: [],
    radarRows: [],
    rateBars: [],
    costQualityPoints: [],
    latencyQualityPoints: [],
    trendRows: [],
    failureRows: [],
    headToHeadRows: [],
    evidenceByModel: {},
  }
);
check(
  "markdown preserves exact max-token snapshot configurations",
  exactReportMarkdown
    .slice(
      exactReportMarkdown.indexOf("## Top Certified Models"),
      exactReportMarkdown.indexOf("## Cost Speed")
    )
    .match(/quality/g)?.length === 2 &&
    exactReportMarkdown.includes("quality 30/100") &&
    exactReportMarkdown.includes("quality 80/100"),
  exactReportMarkdown
);
check(
  "markdown renders legacy missing effort as Default",
  markdown.includes("- GPT Test · Default:"),
  markdown
);

check("markdown report includes certified run summary", markdown.includes("Certified Run Summary"), markdown);
check("markdown report includes verifier assertion summary", markdown.includes("Verifier Assertion Summary"), markdown);
check(
  "markdown report includes certified tradeoffs",
  markdown.includes("Cost Speed Verified Quality Tradeoffs"),
  markdown
);
check("markdown report includes team lift matrix", markdown.includes("Team Lift Matrix"), markdown);
check("markdown report includes failure taxonomy", markdown.includes("Failure Taxonomy"), markdown);
check("markdown report reports latest snapshot evidence counts", markdown.includes("Certified attempts: 1"), markdown);
check(
  "markdown report keeps unpublished evidence out of certified counts",
  markdown.includes("Scored attempts: 1") &&
    markdown.includes("Excluded attempts: 0") &&
    markdown.includes("provider 0"),
  markdown
);
check("markdown report uses the latest snapshot verifier pass rate", markdown.includes("Verified pass rate: 0%"), markdown);
check("markdown report filters non-certified verifier assertions", !markdown.includes("Publish-only assertion"), markdown);
check("markdown report scores one latest completed snapshot", markdown.includes("Completed attempts: 1"), markdown);
check(
  "markdown report excludes history and provider-unavailable attempts from latest scoring rows",
  markdown.includes("Average verified quality: 90/100") &&
    markdown.includes("Average cost: $0.020") &&
    markdown.includes("Average duration: 1.0s") &&
    markdown.includes("GPT solo: quality 90/100, pass rate 0%, 1 attempt(s), avg cost $0.020") &&
    markdown.includes("Certified Snapshot History"),
  markdown
);
check(
  "certified markdown keeps raw audit counts, warnings, and unscoped certifications out",
  !markdown.includes("Raw V2 Counts") &&
    !markdown.includes("Raw Bundle Counts") &&
    !markdown.includes("## Summary") &&
    !markdown.includes("## Model Scorecards") &&
    !markdown.includes("## Head To Head") &&
    !markdown.includes("Redaction warnings") &&
    !markdown.includes("Certification raw-single-model"),
  markdown
);

const reportSource = readFileSync("lib/benchmark/reports.ts", "utf8");
const reportActionSource = readFileSync(
  "components/benchmark/useBenchmarkReportActions.ts",
  "utf8"
);
check(
  "benchmark download attaches link and defers blob revocation",
  reportSource.includes("document.body.appendChild(a)") &&
    reportSource.includes("setTimeout") &&
    reportSource.includes("URL.revokeObjectURL(url)"),
  reportSource.slice(reportSource.indexOf("function downloadText"), reportSource.length)
);
check(
  "benchmark markdown copy handles clipboard denial after download",
  reportActionSource.includes("try {") &&
    reportActionSource.includes("navigator.clipboard") &&
    reportActionSource.includes("catch") &&
    reportActionSource.includes("Clipboard copy"),
  reportActionSource
);
check(
  "benchmark import success message surfaces existing record updates",
  reportActionSource.includes("updatedCount") &&
    reportActionSource.includes("existing record"),
  reportActionSource
);
check(
  "benchmark import success message surfaces result-set counts",
  reportActionSource.includes("resultSetCount") && reportActionSource.includes("completedResultSetCount"),
  reportActionSource
);
const appliedImportMessage = formatBenchmarkImportMessage(
  {
    ...bundle,
    resultSets: [{ status: "completed" }, { status: "completed" }],
  } as BenchmarkReportBundleV2,
  {
    addedCount: 1,
    updatedCount: 0,
    addedByCategory: { resultSets: 1 },
    updatedByCategory: {},
    resultSetCount: 1,
    completedResultSetCount: 0,
    hashMismatch: false,
  }
);
check(
  "benchmark import message reports applied rather than source result sets",
  appliedImportMessage.includes("1 result set(s) (0 publishable completed)") &&
    !appliedImportMessage.includes("2 result set(s)"),
  appliedImportMessage
);
check(
  "benchmark export message surfaces redaction warnings",
  reportActionSource.includes("warning(s)") &&
    reportActionSource.includes("summary?.warnings"),
  reportActionSource
);

__replaceBenchmarkStoreForTests({});
const malformedCompletedImport = await importBenchmarkReportBundleV2({
  ...completedBundle,
  verifierResults: [
    ...completedBundle.verifierResults,
    {
      ...completedBundle.verifierResults[0]!,
      id: "import-extra-owned-verifier",
      resultSetId: completedBundle.resultSets![0]!.id,
      attemptId: completedBundle.attemptsV2.find(
        (record) => record.resultSetId === completedBundle.resultSets![0]!.id
      )!.id,
      artifactIds: ["missing-import-artifact"],
    },
  ],
});
check(
  "import completed count includes only read-time publishable snapshots",
  malformedCompletedImport.resultSetCount > 0 &&
    malformedCompletedImport.completedResultSetCount <
      completedBundle.resultSets!.filter((record) => record.status === "completed")
        .length,
  malformedCompletedImport
);

if (failures === 0) {
  console.log("PASS");
} else {
  console.log(`FAIL ${failures} check(s) failed`);
}

process.exit(failures === 0 ? 0 : 1);
