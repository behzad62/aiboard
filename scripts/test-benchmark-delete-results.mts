import {
  __resetBenchmarkStoreForTests,
  deleteBenchmarkAttemptCascade,
  deleteBenchmarkAttemptsCascade,
  deleteBenchmarkRunCascade,
  listBenchmarkAttemptsV2,
  listBenchmarkArtifacts,
  listBenchmarkFailures,
  listBenchmarkRunEvents,
  listBenchmarkRuns,
  listBenchmarkToolCallTraces,
  listBenchmarkTraces,
  listBenchmarkVerifierResults,
  saveBenchmarkArtifact,
  saveBenchmarkAttemptV2,
  saveBenchmarkFailure,
  saveHarnessCertificationResult,
  saveBenchmarkRun,
  saveBenchmarkRunEvent,
  saveBenchmarkToolCallTrace,
  saveBenchmarkTrace,
  saveBenchmarkVerifierResult,
} from "../lib/benchmark/store";
import type {
  BenchmarkArtifact,
  BenchmarkAttemptV2,
  BenchmarkFailure,
  BenchmarkModelCallTrace,
  BenchmarkRun,
  BenchmarkRunEvent,
  BenchmarkToolCallTrace,
  BenchmarkVerifierResult,
} from "../lib/benchmark/types";

let failures = 0;
function check(name: string, ok: boolean, detail?: unknown): void {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` -> ${JSON.stringify(detail)}`}`);
}

const now = "2026-06-29T12:00:00.000Z";
const run: BenchmarkRun = {
  id: "run-delete-me",
  suiteId: "suite-delete",
  name: "Deletion cascade fixture",
  domain: "model-call",
  status: "completed",
  startedAt: now,
  completedAt: now,
  source: "manual",
  modelIds: ["provider:model-delete"],
  caseIds: ["case-delete"],
  summaryJson: "{}",
  metricValueIds: [],
  artifactIds: ["artifact-run-referenced"],
  failureIds: ["failure-delete-me"],
};
const attempt: BenchmarkAttemptV2 = {
  id: "attempt-delete-me",
  runId: run.id,
  caseId: "case-delete",
  teamCompositionId: "team-delete",
  mode: "certified",
  track: "toolreliability",
  harnessProfile: "raw-single-model",
  status: "provider_unavailable",
  startedAt: now,
  completedAt: now,
  verifiedQuality: 0,
  jobSuccessScore: 0,
  efficiencyScore: 0,
  toolReliabilityScore: 0,
  costUsd: null,
  inputTokens: 0,
  outputTokens: 0,
  modelCalls: 1,
  toolCalls: 0,
  durationMs: 1000,
  verifierResultId: "verifier-delete-me",
  artifactIds: ["artifact-attempt-referenced"],
  traceIds: ["trace-delete-me"],
  failureIds: ["failure-delete-me"],
  harnessVersion: "toolreliability-harness-current",
  promptSetVersion: "toolreliability-prompts-current",
  scoringVersion: "toolreliability-current",
};
const verifier: BenchmarkVerifierResult = {
  id: "verifier-delete-me",
  attemptId: attempt.id,
  caseId: attempt.caseId,
  passed: false,
  score: 0,
  durationMs: 1,
  resultJson: "{}",
  assertionResults: [],
  artifactIds: ["artifact-verifier-referenced"],
};
const failure: BenchmarkFailure = {
  id: "failure-delete-me",
  runId: run.id,
  attemptId: attempt.id,
  caseId: attempt.caseId,
  domain: "model-call",
  source: "provider",
  code: "provider_unavailable",
  severity: "error",
  message: "Provider failed before output.",
  createdAt: now,
};
const event: BenchmarkRunEvent = {
  id: "event-delete-me",
  attemptId: attempt.id,
  caseId: attempt.caseId,
  type: "model_call_failed",
  phase: "model_call_failed",
  at: now,
  message: "Provider error.",
};
const toolTrace: BenchmarkToolCallTrace = {
  id: "tool-delete-me",
  attemptId: attempt.id,
  caseId: attempt.caseId,
  toolName: "toolreliability:tool_validation",
  status: "failed",
  startedAt: now,
  completedAt: now,
  durationMs: 0,
};
const modelTrace: BenchmarkModelCallTrace = {
  id: "trace-delete-me",
  runId: run.id,
  attemptId: attempt.id,
  caseId: attempt.caseId,
  modelId: "provider:model-delete",
  providerId: "provider",
  startedAt: now,
  completedAt: now,
  latencyMs: 1000,
  inputTokens: 0,
  outputTokens: 0,
  estimatedUsd: null,
  retryHistory: [
    {
      attempt: 1,
      status: "provider_error",
      message: "Provider error.",
      latencyMs: 1000,
    },
  ],
  error: "Provider error.",
};

const artifacts: BenchmarkArtifact[] = [
  {
    id: "artifact-attempt-referenced",
    runId: run.id,
    attemptId: attempt.id,
    caseId: attempt.caseId,
    kind: "json",
    label: "Attempt referenced artifact",
    mimeType: "application/json",
    content: "{}",
    createdAt: now,
  },
  {
    id: "artifact-verifier-referenced",
    runId: run.id,
    attemptId: attempt.id,
    caseId: attempt.caseId,
    kind: "json",
    label: "Verifier referenced artifact",
    mimeType: "application/json",
    content: "{}",
    createdAt: now,
  },
  {
    id: "artifact-attempt-field-only",
    attemptId: attempt.id,
    caseId: attempt.caseId,
    kind: "log",
    label: "Attempt field artifact",
    mimeType: "text/plain",
    content: "attempt scoped",
    createdAt: now,
  },
  {
    id: "artifact-run-referenced",
    runId: run.id,
    caseId: attempt.caseId,
    kind: "markdown",
    label: "Run referenced artifact",
    mimeType: "text/markdown",
    content: "# run",
    createdAt: now,
  },
  {
    id: "artifact-run-field-only",
    runId: run.id,
    caseId: attempt.caseId,
    kind: "log",
    label: "Run field artifact",
    mimeType: "text/plain",
    content: "run scoped",
    createdAt: now,
  },
  {
    id: "artifact-harness-only",
    kind: "json",
    label: "Shared harness artifact",
    mimeType: "application/json",
    content: "{}",
    createdAt: now,
  },
  {
    id: "artifact-unrelated",
    runId: "run-unrelated",
    attemptId: "attempt-unrelated",
    caseId: "case-unrelated",
    kind: "json",
    label: "Unrelated artifact",
    mimeType: "application/json",
    content: "{}",
    createdAt: now,
  },
];

async function saveLinkedRecords(): Promise<void> {
  await saveBenchmarkAttemptV2(attempt);
  await saveBenchmarkVerifierResult(verifier);
  await saveBenchmarkFailure(failure);
  await saveBenchmarkRunEvent(event);
  await saveBenchmarkToolCallTrace(toolTrace);
  await saveBenchmarkTrace(modelTrace);
  for (const artifact of artifacts) await saveBenchmarkArtifact(artifact);
  await saveHarnessCertificationResult({
    id: "cert-delete-fixture",
    createdAt: now,
    aiboardVersion: "test",
    benchmarkEngineVersion: "test",
    harnessProfile: "raw-single-model",
    harnessVersion: "toolreliability-harness-current",
    promptSetVersion: "toolreliability-prompts-current",
    passed: true,
    checks: [{ id: "check", label: "check", passed: true }],
    artifactIds: ["artifact-harness-only"],
  });
}

__resetBenchmarkStoreForTests();
await saveBenchmarkRun(run);
await saveLinkedRecords();

const attemptSummary = await deleteBenchmarkAttemptCascade(attempt.id);
check("attempt cascade summary leaves runs alone", attemptSummary.runs === 0, attemptSummary);
check("attempt cascade summary removes artifacts", attemptSummary.artifacts === 3, attemptSummary);
check("attempt cascade removes attempt", (await listBenchmarkAttemptsV2()).length === 0);
check("attempt cascade removes verifier", (await listBenchmarkVerifierResults()).length === 0);
check("attempt cascade removes failure", (await listBenchmarkFailures()).length === 0);
check("attempt cascade removes event", (await listBenchmarkRunEvents()).length === 0);
check("attempt cascade removes tool trace", (await listBenchmarkToolCallTraces()).length === 0);
check("attempt cascade removes model trace", (await listBenchmarkTraces()).length === 0);
check(
  "attempt cascade removes attempt and verifier artifacts",
  !(await listBenchmarkArtifacts()).some((artifact) =>
    [
      "artifact-attempt-referenced",
      "artifact-verifier-referenced",
      "artifact-attempt-field-only",
    ].includes(artifact.id)
  )
);
check(
  "attempt cascade keeps run and unrelated artifacts",
  (await listBenchmarkArtifacts()).some((artifact) => artifact.id === "artifact-run-referenced") &&
    (await listBenchmarkArtifacts()).some((artifact) => artifact.id === "artifact-run-field-only") &&
    (await listBenchmarkArtifacts()).some((artifact) => artifact.id === "artifact-harness-only") &&
    (await listBenchmarkArtifacts()).some((artifact) => artifact.id === "artifact-unrelated")
);
check("attempt cascade keeps run", (await listBenchmarkRuns()).length === 1);

await saveLinkedRecords();
const runSummary = await deleteBenchmarkRunCascade(run.id);
check("run cascade summary removes run", runSummary.runs === 1, runSummary);
check("run cascade summary removes artifacts", runSummary.artifacts === 5, runSummary);
check("run cascade removes run", (await listBenchmarkRuns()).length === 0);
check("run cascade removes attempt", (await listBenchmarkAttemptsV2()).length === 0);
check("run cascade removes verifier", (await listBenchmarkVerifierResults()).length === 0);
check("run cascade removes failure", (await listBenchmarkFailures()).length === 0);
check("run cascade removes event", (await listBenchmarkRunEvents()).length === 0);
check("run cascade removes tool trace", (await listBenchmarkToolCallTraces()).length === 0);
check("run cascade removes model trace", (await listBenchmarkTraces()).length === 0);
check(
  "run cascade removes run-scoped artifacts",
  !(await listBenchmarkArtifacts()).some((artifact) =>
    [
      "artifact-attempt-referenced",
      "artifact-verifier-referenced",
      "artifact-attempt-field-only",
      "artifact-run-referenced",
      "artifact-run-field-only",
    ].includes(artifact.id)
  )
);
check(
  "run cascade keeps shared harness-only and unrelated artifacts",
  (await listBenchmarkArtifacts()).some((artifact) => artifact.id === "artifact-harness-only") &&
    (await listBenchmarkArtifacts()).some((artifact) => artifact.id === "artifact-unrelated")
);

__resetBenchmarkStoreForTests();
const batchAttemptA: BenchmarkAttemptV2 = {
  ...attempt,
  id: "attempt-batch-a",
  verifierResultId: "verifier-batch-a",
  artifactIds: ["artifact-batch-a"],
};
const batchAttemptB: BenchmarkAttemptV2 = {
  ...attempt,
  id: "attempt-batch-b",
  verifierResultId: "verifier-batch-b",
  artifactIds: ["artifact-batch-b"],
};
await saveBenchmarkAttemptV2(batchAttemptA);
await saveBenchmarkAttemptV2(batchAttemptB);
await saveBenchmarkVerifierResult({
  ...verifier,
  id: "verifier-batch-a",
  attemptId: batchAttemptA.id,
  artifactIds: ["artifact-verifier-batch-a"],
});
await saveBenchmarkVerifierResult({
  ...verifier,
  id: "verifier-batch-b",
  attemptId: batchAttemptB.id,
  artifactIds: ["artifact-verifier-batch-b"],
});
for (const artifact of [
  {
    ...artifacts[0],
    id: "artifact-batch-a",
    attemptId: batchAttemptA.id,
  },
  {
    ...artifacts[0],
    id: "artifact-batch-b",
    attemptId: batchAttemptB.id,
  },
  {
    ...artifacts[0],
    id: "artifact-verifier-batch-a",
    attemptId: batchAttemptA.id,
  },
  {
    ...artifacts[0],
    id: "artifact-verifier-batch-b",
    attemptId: batchAttemptB.id,
  },
]) {
  await saveBenchmarkArtifact(artifact);
}
const batchSummary = await deleteBenchmarkAttemptsCascade([
  batchAttemptA.id,
  batchAttemptB.id,
  batchAttemptA.id,
]);
check("batch cascade deduplicates and removes attempts", batchSummary.attempts === 2, batchSummary);
check("batch cascade removes verifiers", batchSummary.verifiers === 2, batchSummary);
check("batch cascade removes artifacts", batchSummary.artifacts === 4, batchSummary);
check("batch cascade leaves no batch attempts", (await listBenchmarkAttemptsV2()).length === 0);
check("batch cascade leaves no batch artifacts", (await listBenchmarkArtifacts()).length === 0);

if (failures > 0) {
  console.log(`FAIL ${failures} check(s) failed`);
  process.exit(1);
}
console.log("PASS");
