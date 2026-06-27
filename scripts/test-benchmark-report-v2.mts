/* Benchmark report v2 checks (run: npx tsx scripts/test-benchmark-report-v2.mts) */
import { buildCertifiedBenchmarkDashboardData } from "../lib/benchmark/metrics";
import { formatBenchmarkMarkdownReport } from "../lib/benchmark/reports";
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
  status: "failed_verifier",
  verifiedQuality: 0.5,
  jobSuccessScore: 50,
  efficiencyScore: 40,
  costUsd: 0.02,
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
  attemptsV2: [attempt, failedAttemptWithPartialQuality, publishAttempt],
  verifierResults: [verifier, publishVerifier],
  runEvents: [],
  toolCallTraces: [],
  teamCompositions: [team],
  harnessCertifications: [],
  bundleHash: "test-hash",
  redactionSummary: {
    scannedArtifacts: 0,
    redactedSecrets: 0,
    warnings: [],
  },
};

const certified = buildCertifiedBenchmarkDashboardData({
  caseV2: bundle.caseV2,
  attemptsV2: bundle.attemptsV2,
  verifierResults: bundle.verifierResults,
  teamCompositions: bundle.teamCompositions,
  harnessCertifications: bundle.harnessCertifications,
});

check("certified dashboard counts certified runs and cases", certified.summary.certifiedRuns === 2 && certified.summary.certifiedCases === 1, certified.summary);
check("certified dashboard filters non-certified attempts", certified.summary.certifiedAttempts === 2, certified.summary);
check("certified dashboard does not pass failed partial-quality attempts", certified.summary.verifiedPassRate === 0.5, certified.summary);
check("certified dashboard ranks verified quality", certified.leaderboard[0]?.verifiedQuality === 0.75, certified.leaderboard);
check("certified leaderboard pass count uses status", certified.leaderboard[0]?.passed === 1 && certified.leaderboard[0]?.failed === 1, certified.leaderboard[0]);
check("certified dashboard filters non-certified verifier assertions", !certified.verifierAssertionRows.some((row) => row.id === "publish-only"), certified.verifierAssertionRows);

const markdown = formatBenchmarkMarkdownReport(bundle, {
  summary: {
    totalRuns: 0,
    totalCases: 0,
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

check("markdown report includes certified run summary", markdown.includes("Certified Run Summary"), markdown);
check("markdown report includes verifier assertion summary", markdown.includes("Verifier Assertion Summary"), markdown);
check("markdown report includes certified tradeoffs", markdown.includes("Cost Speed Quality Tradeoffs"), markdown);
check("markdown report includes team lift matrix", markdown.includes("Team Lift Matrix"), markdown);
check("markdown report includes failure taxonomy", markdown.includes("Failure Taxonomy"), markdown);
check("markdown report filters certified attempts", markdown.includes("Certified attempts: 2") && !markdown.includes("Certified attempts: 3"), markdown);
check("markdown report filters non-certified verifier pass rate", markdown.includes("Verified pass rate: 100%"), markdown);
check("markdown report filters non-certified verifier assertions", !markdown.includes("Publish-only assertion"), markdown);
check("markdown report treats v2 failure statuses as complete", markdown.includes("Completed attempts: 2"), markdown);
check("markdown report includes v2 raw counts", markdown.includes("Verifier results: 2"), markdown);
check("markdown report includes run evidence counts", markdown.includes("Run events: 0") && markdown.includes("Tool-call traces: 0"), markdown);

if (failures === 0) {
  console.log("PASS");
} else {
  console.log(`FAIL ${failures} check(s) failed`);
}

process.exit(failures === 0 ? 0 : 1);
