/* Certified WorkBench UI data checks (run: npx tsx scripts/test-certified-workbench-ui.mts) */
import { readFileSync } from "node:fs";
import {
  listWorkBenchCasePacks,
  listWorkBenchCaseOptions,
  workBenchCaseToBenchmarkCaseV2,
} from "../lib/benchmark/workbench/corpus";
import {
  normalizeWorkBenchModelSelection,
  workBenchHarnessProfileForRoleMode,
  workBenchRoleCount,
} from "../lib/benchmark/workbench/ui-selection";
import { listCertifiedSuiteOptions } from "../lib/benchmark/certified/suite-options";
import { getCertifiedRunGate } from "../lib/benchmark/certified/ui-gates";
import { buildAttemptDetailViewModel } from "../lib/benchmark/certified/attempt-detail";
import { buildCertifiedBenchmarkDashboardData } from "../lib/benchmark/metrics";
import type {
  BenchmarkArtifact,
  BenchmarkAttemptV2,
  BenchmarkCaseV2,
  BenchmarkFailure,
  BenchmarkModelCallTrace,
  BenchmarkRunEvent,
  BenchmarkTeamComposition,
  BenchmarkToolCallTrace,
  BenchmarkVerifierResult,
} from "../lib/benchmark/types";

let failures = 0;

function check(name: string, ok: boolean, detail?: unknown): void {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` -> ${JSON.stringify(detail)}`}`);
}

const cases = listWorkBenchCaseOptions();
const casePacks = listWorkBenchCasePacks();
const allCasePack = casePacks.find((pack) => pack.id === "workbench-current-all");
const workBenchSuiteOptions = listCertifiedSuiteOptions("workbench");
const languageCounts = new Map<string, number>();
for (const item of cases) {
  languageCounts.set(item.fixtureLanguage, (languageCounts.get(item.fixtureLanguage) ?? 0) + 1);
}

check("WorkBench UI loader exposes current generated cases", cases.length >= 19, cases.map((item) => item.case.id));
check(
  "WorkBench UI loader exposes all-cases pack",
  allCasePack?.caseCount === cases.length &&
    allCasePack?.cases.length === cases.length &&
    allCasePack?.caseIds.length === cases.length &&
    allCasePack?.caseIds.join("|") === cases.map((item) => item.id).join("|"),
  allCasePack
);
check(
  "WorkBench suite options expose packs instead of individual cases",
  workBenchSuiteOptions[0]?.id === "workbench-current-all" &&
    casePacks.every((pack) =>
      workBenchSuiteOptions.some(
        (option) => option.id === pack.id && option.label === pack.label
      )
    ) &&
    cases.every((item) =>
      !workBenchSuiteOptions.some((option) => option.id === item.id)
    ),
  workBenchSuiteOptions
);
check(
  "WorkBench packs keep unique ordered case ids",
  casePacks.every((pack) => {
    const ids = pack.cases.map((item) => item.id);
    return (
      ids.join("|") === pack.caseIds.join("|") &&
      new Set(pack.caseIds).size === pack.caseIds.length
    );
  }),
  casePacks.map((pack) => ({ id: pack.id, caseIds: pack.caseIds }))
);
check(
  "WorkBench UI loader exposes language packs",
  ["typescript", "python", "go", "rust", "react-ui", "json", "csharp", "cpp"].every((language) =>
    casePacks.some(
      (pack) =>
        pack.id === `workbench-current-language-${language}` &&
        pack.caseCount === languageCounts.get(language)
    )
  ),
  casePacks.map((pack) => ({ id: pack.id, caseCount: pack.caseCount }))
);
check(
  "WorkBench UI loader exposes non-empty challenge-kind packs",
  casePacks
    .filter((pack) => pack.id.startsWith("workbench-current-kind-"))
    .length >= 6 &&
    casePacks.every((pack) => pack.caseCount > 0 && pack.cases.length === pack.caseCount),
  casePacks.map((pack) => ({ id: pack.id, caseCount: pack.caseCount }))
);
check("WorkBench UI loader labels cases", cases.every((item) => item.label.includes(item.case.title)), cases);
check(
  "WorkBench UI loader exposes current language mix",
  languageCounts.get("csharp") === 2 &&
    languageCounts.get("cpp") === 2 &&
    languageCounts.get("python") === 2 &&
    languageCounts.get("go") === 2 &&
    languageCounts.get("rust") === 1 &&
    languageCounts.get("react-ui") === 2,
  Object.fromEntries(languageCounts)
);
const workBenchSelectionModels = [
  { modelId: "openai:gpt-a" },
  { modelId: "anthropic:claude-b" },
  { modelId: "google:gemini-c" },
];
check(
  "WorkBench role counts match UI modes",
  workBenchRoleCount("solo") === 1 &&
    workBenchRoleCount("architect_worker") === 2 &&
    workBenchRoleCount("architect_worker_reviewer") === 3,
  null
);
check(
  "WorkBench harness profile is derived from role mode",
  workBenchHarnessProfileForRoleMode("solo") === "aiboard-build-single-worker" &&
    workBenchHarnessProfileForRoleMode("architect_worker") === "aiboard-build-multi-worker" &&
    workBenchHarnessProfileForRoleMode("architect_worker_reviewer") === "aiboard-build-multi-worker",
  null
);
check(
  "WorkBench role mode expansion stores displayed fallback model slots",
  normalizeWorkBenchModelSelection({
    models: workBenchSelectionModels,
    selectedModelIds: ["openai:gpt-a"],
    roleMode: "architect_worker",
  }).join("|") === "openai:gpt-a|anthropic:claude-b",
  null
);
check(
  "WorkBench role mode expansion avoids phantom duplicate fallback slots",
  normalizeWorkBenchModelSelection({
    models: workBenchSelectionModels,
    selectedModelIds: ["anthropic:claude-b"],
    roleMode: "architect_worker",
  }).join("|") === "anthropic:claude-b|openai:gpt-a",
  null
);
check(
  "WorkBench role mode shrink trims stored model slots",
  normalizeWorkBenchModelSelection({
    models: workBenchSelectionModels,
    selectedModelIds: [
      "openai:gpt-a",
      "anthropic:claude-b",
      "google:gemini-c",
    ],
    roleMode: "solo",
  }).join("|") === "openai:gpt-a",
  null
);
check(
  "WorkBench UI loader exposes stable hashes",
  cases.every((item) => item.caseHash.startsWith("workbench:")),
  cases.map((item) => item.caseHash)
);
check(
  "WorkBench UI loader does not expose versioned labels",
  cases.every((item) => !/\bv[12]\b/i.test(item.label)),
  cases.map((item) => item.label)
);

const firstCase = cases[0];
const caseV2 = firstCase ? workBenchCaseToBenchmarkCaseV2(firstCase) : null;
check(
  "WorkBench UI case converts to BenchmarkCaseV2",
  Boolean(caseV2 && caseV2.track === "workbench" && caseV2.id === firstCase?.case.id),
  caseV2
);

const failedGate = getCertifiedRunGate({
  suiteId: "workbench-case",
  running: false,
  selectedTrack: "workbench",
  modelId: "openai:gpt-workbench",
  teamModelIds: [],
  workBenchRunnerReady: true,
  certification: {
    id: "cert-failed",
    createdAt: "2026-06-28T10:00:00.000Z",
    aiboardVersion: "test",
    benchmarkEngineVersion: "test",
    harnessProfile: "aiboard-build-multi-worker",
    harnessVersion: "test",
    promptSetVersion: "test",
    passed: false,
    checks: [
      {
        id: "bad-json",
        label: "Bad JSON is classified as failed_tool_use",
        passed: false,
        message: "Received invalid_harness instead.",
      },
    ],
  },
});
check(
  "certified run gate blocks failed harness certification",
  !failedGate.canRun &&
    failedGate.reason?.includes("Bad JSON is classified as failed_tool_use") === true &&
    failedGate.reason?.includes("Received invalid_harness instead.") === true,
  failedGate
);

const passingGate = getCertifiedRunGate({
  suiteId: "workbench-case",
  running: false,
  selectedTrack: "workbench",
  modelId: "openai:gpt-workbench",
  teamModelIds: [],
  workBenchRunnerReady: true,
  certification: { ...failedGate.certification, passed: true, checks: [] },
});
check("certified run gate allows passing certification", passingGate.canRun, passingGate);

const detailAttempt: BenchmarkAttemptV2 = {
  id: "attempt-detail",
  runId: "run-detail",
  caseId: "case-detail",
  teamCompositionId: "team-detail",
  mode: "certified",
  track: "workbench",
  harnessProfile: "aiboard-build-multi-worker",
  status: "failed_verifier",
  startedAt: "2026-06-28T10:00:00.000Z",
  completedAt: "2026-06-28T10:00:10.000Z",
  verifiedQuality: 0.5,
  jobSuccessScore: 50,
  efficiencyScore: 40,
  costUsd: 0.02,
  inputTokens: 100,
  outputTokens: 40,
  modelCalls: 1,
  toolCalls: 2,
  durationMs: 10_000,
  verifierResultId: "verifier-detail",
  artifactIds: ["patch-detail", "artifact-detail"],
  traceIds: ["trace-detail"],
  failureIds: ["failure-detail"],
  harnessVersion: "workbench-runner-v0.1",
  promptSetVersion: "workbench-prompts-v0.1",
  scoringVersion: "workbench-v0.1",
};
const detailCase: BenchmarkCaseV2 = {
  id: "case-detail",
  schemaVersion: 2,
  track: "workbench",
  title: "Detail case",
  description: "A case with complete details.",
  difficulty: "easy",
  tags: ["detail"],
  caseVersion: "0.1.0",
  createdAt: "2026-06-28T10:00:00.000Z",
  updatedAt: "2026-06-28T10:00:00.000Z",
  prompt: { userRequest: "Fix the detail fixture.", publicContext: "Use the public docs." },
  environment: { type: "local-runner", timeoutSeconds: 30, network: "dependency-only" },
  verifier: { command: "npm test", scorer: "verifier-json" },
  budget: { maxUsd: 1 },
  scoring: { scoringVersion: "workbench-v0.1", primary: "verified_quality" },
  contamination: {
    originalTask: true,
    canary: "AIBENCH-DETAIL",
    referenceSolutionPrivate: true,
  },
};
const detailTeam: BenchmarkTeamComposition = {
  id: "team-detail",
  name: "Detail team",
  comboHash: "team:detail",
  strategy: "architect_worker",
  roles: [
    {
      role: "architect",
      slot: "01-architect",
      modelId: "openai:gpt-detail",
      providerId: "openai",
      displayName: "GPT Detail",
      temperature: 0,
    },
  ],
};
const detailVerifier: BenchmarkVerifierResult = {
  id: "verifier-detail",
  attemptId: "attempt-detail",
  caseId: "case-detail",
  passed: false,
  score: 0.5,
  durationMs: 1000,
  resultJson: "{}",
  assertionResults: [
    { id: "assertion-detail", label: "Verifier assertion", passed: false, weight: 1 },
  ],
  artifactIds: ["artifact-detail"],
};
const detailTrace: BenchmarkModelCallTrace = {
  id: "trace-detail",
  runId: "run-detail",
  caseId: "case-detail",
  attemptId: "attempt-detail",
  modelId: "openai:gpt-detail",
  providerId: "openai",
  startedAt: "2026-06-28T10:00:01.000Z",
  inputTokens: 100,
  outputTokens: 40,
  retryHistory: [{ attempt: 1, status: "parsed", message: "ok" }],
};
const detailToolTrace: BenchmarkToolCallTrace = {
  id: "tool-detail",
  attemptId: "attempt-detail",
  caseId: "case-detail",
  toolName: "bench.patch-file",
  status: "ok",
  startedAt: "2026-06-28T10:00:02.000Z",
};
const detailPatch: BenchmarkArtifact = {
  id: "patch-detail",
  runId: "run-detail",
  caseId: "case-detail",
  attemptId: "attempt-detail",
  kind: "patch",
  label: "Patch diff",
  mimeType: "text/x-patch",
  content: "--- a/file.ts\n+++ b/file.ts\n+fixed",
  createdAt: "2026-06-28T10:00:03.000Z",
};
const detailArtifact: BenchmarkArtifact = {
  id: "artifact-detail",
  runId: "run-detail",
  caseId: "case-detail",
  attemptId: "attempt-detail",
  kind: "json",
  label: "Verifier artifact",
  mimeType: "application/json",
  content: "{}",
  createdAt: "2026-06-28T10:00:04.000Z",
};
const detailFailure: BenchmarkFailure = {
  id: "failure-detail",
  runId: "run-detail",
  caseId: "case-detail",
  attemptId: "attempt-detail",
  domain: "build",
  source: "benchmark",
  code: "verification_failed",
  severity: "error",
  message: "Verifier failed.",
  createdAt: "2026-06-28T10:00:05.000Z",
};
const detailRunEvent: BenchmarkRunEvent = {
  id: "event-detail",
  attemptId: "attempt-detail",
  caseId: "case-detail",
  type: "model_call_failed",
  phase: "model-call",
  at: "2026-06-28T10:00:06.000Z",
  message: "Provider stream timed out.",
  modelId: "openai:gpt-detail",
  providerId: "openai",
};
const detail = buildAttemptDetailViewModel({
  summary: {
    runId: "run-detail",
    status: "completed",
    attemptCount: 1,
    verifierCount: 1,
    artifactCount: 2,
    traceCount: 1,
    eventCount: 0,
    toolCallCount: 1,
    failureCount: 1,
    dashboard: passingGate.certification as never,
  },
  cases: [detailCase],
  attempts: [detailAttempt],
  teams: [detailTeam],
  verifiers: [detailVerifier],
  traces: [detailTrace],
  toolCalls: [detailToolTrace],
  artifacts: [detailPatch, detailArtifact],
  failures: [detailFailure],
  runEvents: [detailRunEvent],
});
check(
  "attempt detail view model exposes certified evidence categories",
  detail?.caseRecord?.prompt.userRequest === "Fix the detail fixture." &&
    detail.team?.strategy === "architect_worker" &&
    detail.verifier?.assertionResults[0]?.id === "assertion-detail" &&
    detail.modelTraces.length === 1 &&
    detail.toolCalls.length === 1 &&
    detail.patchArtifacts[0]?.content.includes("+fixed") &&
    detail.artifacts.length === 2 &&
    detail.runEvents[0]?.message === "Provider stream timed out." &&
    detail.failures[0]?.message === "Verifier failed." &&
    detail.metrics.costUsd === 0.02 &&
    detail.metrics.inputTokens === 100 &&
    detail.metrics.outputTokens === 40 &&
    detail.metrics.durationMs === 10_000 &&
    detail.versions.harnessVersion === "workbench-runner-v0.1" &&
    detail.versions.scoringVersion === "workbench-v0.1",
  detail
);

const roleDashboard = buildCertifiedBenchmarkDashboardData({
  caseV2: [detailCase],
  attemptsV2: [
    {
      ...detailAttempt,
      status: "passed",
      verifiedQuality: 0.8,
      jobSuccessScore: 80,
      efficiencyScore: 70,
    },
  ],
  verifierResults: [{ ...detailVerifier, passed: true, score: 0.8 }],
  teamCompositions: [
    {
      ...detailTeam,
      roles: [
        {
          role: "architect",
          slot: "01-architect",
          modelId: "openai:gpt-architect",
          providerId: "openai",
          displayName: "GPT Architect",
          temperature: 0,
        },
        {
          role: "worker",
          slot: "02-worker",
          modelId: "anthropic:claude-worker",
          providerId: "anthropic",
          displayName: "Claude Worker",
          temperature: 0,
        },
        {
          role: "reviewer",
          slot: "03-reviewer",
          modelId: "google:gemini-reviewer",
          providerId: "google",
          displayName: "Gemini Reviewer",
          temperature: 0,
        },
      ],
    },
  ],
  harnessCertifications: [],
});
check(
  "certified dashboard exposes WorkBench role leaderboards",
  roleDashboard.workBenchRoleLeaderboards.architect[0]?.modelId === "openai:gpt-architect" &&
    roleDashboard.workBenchRoleLeaderboards.worker[0]?.modelId === "anthropic:claude-worker" &&
    roleDashboard.workBenchRoleLeaderboards.reviewer[0]?.modelId === "google:gemini-reviewer",
  roleDashboard.workBenchRoleLeaderboards
);

const runnerStatusSource = readFileSync(
  "components/benchmark/workbench/WorkBenchRunnerStatus.tsx",
  "utf8"
);
const certifiedRunPanelSource = readFileSync(
  "components/benchmark/certified/CertifiedRunPanel.tsx",
  "utf8"
);
// The run-execution helpers (runSelected/runGameIqMultiModel + their pure
// helpers) were extracted out of CertifiedRunPanel.tsx into run-execution.ts
// (2026-07-17 benchmark UX overhaul, Task 4 Step 1) — the WorkBench
// pack-batching evidence below now lives there, not in the panel.
const runExecutionSource = readFileSync(
  "lib/benchmark/certified/run-execution.ts",
  "utf8"
);
check(
  "WorkBench runner panel links the generated benchmark runner download",
  runnerStatusSource.includes('href="/bench-runner.mjs"') &&
    runnerStatusSource.includes('download="bench-runner.mjs"') &&
    runnerStatusSource.includes("Download bench runner"),
  runnerStatusSource
);
check(
  "certified run timeline uses distinct phase state",
  certifiedRunPanelSource.includes("runPhase") &&
    certifiedRunPanelSource.includes('"certifying"') &&
    certifiedRunPanelSource.includes('"persisting"') &&
    !certifiedRunPanelSource.includes('{ label: "Certify", status: running ? "running" : summary ? "done" : "idle" }') &&
    !certifiedRunPanelSource.includes('{ label: "Run", status: running ? "running" : summary ? "done" : "idle" }'),
  certifiedRunPanelSource
);
check(
  "certified WorkBench UI derives harness profile from role mode",
  certifiedRunPanelSource.includes("workBenchHarnessProfileForRoleMode(workBenchRoleMode)") &&
    !certifiedRunPanelSource.includes("profiles={WORKBENCH_HARNESS_PROFILES}"),
  certifiedRunPanelSource
);
check(
  "certified WorkBench UI runs packs instead of individual cases",
  certifiedRunPanelSource.includes("getWorkBenchCasePack(suiteId)") &&
    runExecutionSource.includes("selectedWorkBenchPack.cases.map") &&
    runExecutionSource.includes("caseRecords.map((caseRecord) => caseRecord.id)") &&
    runExecutionSource.includes("cases: selectedWorkBenchPack.cases.map") &&
    !certifiedRunPanelSource.includes("getWorkBenchCaseOption(suiteId)") &&
    !certifiedRunPanelSource.includes("selectedCaseId={suiteId}"),
  { certifiedRunPanelSource, runExecutionSource }
);

if (failures === 0) {
  console.log("PASS");
} else {
  console.log(`FAIL ${failures} check(s) failed`);
}

process.exit(failures === 0 ? 0 : 1);
