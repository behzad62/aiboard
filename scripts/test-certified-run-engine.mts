/* Certified run engine checks (run: npx tsx scripts/test-certified-run-engine.mts) */
import {
  __resetBenchmarkStoreForTests,
  exportBenchmarkReportBundleV2,
  importBenchmarkReportBundleV2,
  listBenchmarkAttemptsV2,
  listBenchmarkCaseV2,
  listBenchmarkRunEvents,
  listBenchmarkRuns,
  listBenchmarkTeamCompositions,
  listBenchmarkToolCallTraces,
  listBenchmarkVerifierResults,
  saveBenchmarkCaseV2,
  saveBenchmarkTeamComposition,
} from "../lib/benchmark/store";
import { runHarnessCertification } from "../lib/benchmark/certified/certification";
import { runCertifiedBenchmark } from "../lib/benchmark/certified/run-engine";
import type {
  BenchmarkAttemptV2,
  BenchmarkCaseV2,
  BenchmarkFailure,
  BenchmarkModelCallTrace,
  BenchmarkTeamComposition,
  BenchmarkVerifierResult,
} from "../lib/benchmark/types";

let failures = 0;

function check(name: string, ok: boolean, detail?: unknown): void {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` -> ${JSON.stringify(detail)}`}`);
}

async function expectReject(
  name: string,
  action: () => Promise<unknown>,
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

const now = "2026-06-28T08:00:00.000Z";
const caseOne: BenchmarkCaseV2 = {
  id: "gameiq-engine-case-1",
  schemaVersion: 2,
  track: "gameiq",
  title: "Engine case one",
  description: "A deterministic GameIQ case.",
  difficulty: "easy",
  tags: ["engine"],
  caseVersion: "0.1.0",
  createdAt: now,
  updatedAt: now,
  prompt: {
    userRequest: "Choose the winning move.",
    publicContext: "Return JSON.",
  },
  game: {
    gameId: "connect-four",
    seed: "engine-case-1",
    scenarioId: "engine-scenario-1",
  },
  environment: {
    type: "browser",
    timeoutSeconds: 30,
    network: "none",
  },
  verifier: {
    scorer: "game-engine",
  },
  budget: {
    maxUsd: 1,
    maxModelCalls: 4,
  },
  scoring: {
    scoringVersion: "certified-v0.1",
    primary: "game_iq",
  },
  contamination: {
    originalTask: true,
    canary: "AIBENCH-RUN-ENGINE-1",
    referenceSolutionPrivate: true,
  },
};

const caseTwo: BenchmarkCaseV2 = {
  ...caseOne,
  id: "gameiq-engine-case-2",
  title: "Engine case two",
  game: {
    gameId: "connect-four",
    seed: "engine-case-2",
    scenarioId: "engine-scenario-2",
  },
  contamination: {
    ...caseOne.contamination,
    canary: "AIBENCH-RUN-ENGINE-2",
  },
};

const team: BenchmarkTeamComposition = {
  id: "team-engine-single",
  name: "Engine single model",
  comboHash: "combo:engine-single",
  roles: [
    {
      role: "single",
      slot: "single",
      modelId: "openai:gpt-engine",
      providerId: "openai",
      displayName: "GPT Engine",
      temperature: 0,
      maxTokens: 512,
    },
  ],
};
const passingCertification = {
  ...runHarnessCertification("raw-single-model"),
  passed: true,
  checks: [{ id: "run-engine-fixture", label: "Run engine fixture", passed: true }],
};

__resetBenchmarkStoreForTests();
await saveBenchmarkCaseV2(caseOne);
await saveBenchmarkCaseV2(caseTwo);
await saveBenchmarkTeamComposition(team);

await expectReject(
  "failed harness certification blocks certified run",
  () =>
    runCertifiedBenchmark({
      runId: "run-blocked-cert",
      suiteId: "suite-engine",
      track: "gameiq",
      harnessProfile: "raw-single-model",
      caseIds: [caseOne.id],
      teamCompositionIds: [team.id],
      certification: {
        ...runHarnessCertification("raw-single-model"),
        passed: false,
        checks: [{ id: "forced-fail", label: "Forced fail", passed: false }],
      },
      runner: async () => undefined,
    }),
  /certification failed/i
);

await expectReject(
  "missing certified case is rejected",
  () =>
    runCertifiedBenchmark({
      runId: "run-missing-case",
      suiteId: "suite-engine",
      track: "gameiq",
      harnessProfile: "raw-single-model",
      caseIds: ["missing-case"],
      teamCompositionIds: [team.id],
      certification: passingCertification,
      runner: async () => undefined,
    }),
  /missing certified case/i
);

const summary = await runCertifiedBenchmark({
  runId: "run-certified-engine",
  suiteId: "suite-engine",
  track: "gameiq",
  harnessProfile: "raw-single-model",
  caseIds: [caseOne.id, caseTwo.id],
  teamCompositionIds: [team.id],
  certification: passingCertification,
  modelBudget: {
    maxUsd: 1,
    maxModelCalls: 4,
  },
  runner: async (context) => {
    const passedAttemptId = `${context.runId}:${caseOne.id}:${team.id}`;
    const failedAttemptId = `${context.runId}:${caseTwo.id}:${team.id}`;
    const failure: BenchmarkFailure = {
      id: `${failedAttemptId}:failure:verification_failed`,
      runId: context.runId,
      attemptId: failedAttemptId,
      caseId: caseTwo.id,
      domain: "game",
      source: "rules",
      code: "verification_failed",
      severity: "error",
      message: "Deterministic rule checker rejected the move.",
      createdAt: context.startedAt,
    };
    const passedVerifier: BenchmarkVerifierResult = {
      id: `${passedAttemptId}:verifier`,
      attemptId: passedAttemptId,
      caseId: caseOne.id,
      passed: true,
      score: 1,
      durationMs: 5,
      resultJson: JSON.stringify({ passed: true, score: 1 }),
      assertionResults: [{ id: "move", label: "Winning move", passed: true, weight: 1 }],
      artifactIds: [],
    };
    const failedVerifier: BenchmarkVerifierResult = {
      id: `${failedAttemptId}:verifier`,
      attemptId: failedAttemptId,
      caseId: caseTwo.id,
      passed: false,
      score: 0,
      durationMs: 5,
      resultJson: JSON.stringify({ passed: false, score: 0 }),
      assertionResults: [{ id: "move", label: "Winning move", passed: false, weight: 1 }],
      artifactIds: [],
    };
    const trace: BenchmarkModelCallTrace = {
      id: `${passedAttemptId}:trace:model`,
      runId: context.runId,
      attemptId: passedAttemptId,
      caseId: caseOne.id,
      modelId: "openai:gpt-engine",
      providerId: "openai",
      participantId: "single",
      schemaMode: "structured",
      startedAt: context.startedAt,
      completedAt: new Date().toISOString(),
      latencyMs: 25,
      inputTokens: 12,
      outputTokens: 8,
      estimatedUsd: 0.001,
      rawResponse: "{\"move\":3}",
      parsedResponseJson: JSON.stringify({ move: 3 }),
      retryHistory: [],
    };
    const passedAttempt: BenchmarkAttemptV2 = {
      id: passedAttemptId,
      runId: context.runId,
      caseId: caseOne.id,
      teamCompositionId: team.id,
      mode: "certified",
      track: "gameiq",
      harnessProfile: context.harnessProfile,
      status: "passed",
      startedAt: context.startedAt,
      completedAt: new Date().toISOString(),
      verifiedQuality: 1,
      jobSuccessScore: 100,
      efficiencyScore: 100,
      gameIqScore: 100,
      costUsd: 0.001,
      inputTokens: 12,
      outputTokens: 8,
      modelCalls: 1,
      toolCalls: 0,
      durationMs: 25,
      verifierResultId: passedVerifier.id,
      artifactIds: [],
      traceIds: [trace.id],
      failureIds: [],
      harnessVersion: "raw-single-model-v0.1",
      promptSetVersion: "certified-prompts-v0.1",
      scoringVersion: "certified-v0.1",
    };
    const failedAttempt: BenchmarkAttemptV2 = {
      ...passedAttempt,
      id: failedAttemptId,
      caseId: caseTwo.id,
      status: "failed_verifier",
      verifiedQuality: 0,
      jobSuccessScore: 0,
      efficiencyScore: 0,
      gameIqScore: 0,
      costUsd: 0.001,
      verifierResultId: failedVerifier.id,
      traceIds: [],
      failureIds: [failure.id],
    };

    await context.recordTrace(trace);
    await context.recordVerifier(passedVerifier);
    await context.recordVerifier(failedVerifier);
    await context.recordEvent({
      id: `${passedAttemptId}:event:model-completed`,
      attemptId: passedAttemptId,
      caseId: caseOne.id,
      type: "model_call_completed",
      phase: "single",
      at: context.startedAt,
      message: "Model call completed.",
      modelId: "openai:gpt-engine",
      providerId: "openai",
      detailsJson: JSON.stringify({ runId: context.runId }),
    });
    await context.recordToolCall({
      id: `${passedAttemptId}:tool:validator`,
      attemptId: passedAttemptId,
      caseId: caseOne.id,
      toolName: "game-engine",
      status: "ok",
      startedAt: context.startedAt,
      completedAt: new Date().toISOString(),
      durationMs: 5,
      inputJson: JSON.stringify({ move: 3 }),
      outputPreview: "legal winning move",
    });
    await context.recordFailure(failure);
    await context.recordAttempt(passedAttempt);
    return [failedAttempt];
  },
});

check("certified run completes", summary.status === "completed" && summary.runId === "run-certified-engine", summary);
check("certified run summary counts persisted records", summary.attemptCount === 2 && summary.verifierCount === 2 && summary.traceCount === 1 && summary.eventCount === 1 && summary.toolCallCount === 1 && summary.failureCount === 1, summary);
check("certified dashboard updates after run", summary.dashboard.summary.certifiedAttempts === 2 && summary.dashboard.summary.verifiedPassRate === 0.5, summary.dashboard.summary);

const runs = await listBenchmarkRuns();
check("run record persisted as completed", runs.some((run) => run.id === "run-certified-engine" && run.status === "completed" && run.completedAt), runs);
check("attempts persisted", (await listBenchmarkAttemptsV2()).length === 2);
check("verifiers persisted", (await listBenchmarkVerifierResults()).length === 2);
check("events persisted", (await listBenchmarkRunEvents()).length === 1);
check("tool traces persisted", (await listBenchmarkToolCallTraces()).length === 1);

const bundle = exportBenchmarkReportBundleV2();
check("v2 export includes engine run evidence", bundle.attemptsV2.length === 2 && bundle.verifierResults.length === 2 && bundle.traces.length === 1 && bundle.failures.length === 1, bundle);

__resetBenchmarkStoreForTests();
await importBenchmarkReportBundleV2(bundle);
check("v2 import round-trips engine attempts", (await listBenchmarkAttemptsV2()).length === 2);
check("v2 import round-trips engine teams", (await listBenchmarkTeamCompositions()).length === 1);
check("v2 import round-trips engine cases", (await listBenchmarkCaseV2()).length === 2);

__resetBenchmarkStoreForTests();
await saveBenchmarkCaseV2(caseOne);
await saveBenchmarkTeamComposition(team);
const failedWithoutFailureSummary = await runCertifiedBenchmark({
  runId: "run-certified-engine-generated-failure",
  suiteId: "suite-engine",
  track: "gameiq",
  harnessProfile: "raw-single-model",
  caseIds: [caseOne.id],
  teamCompositionIds: [team.id],
  certification: passingCertification,
  runner: async (context) => [
    {
      id: `${context.runId}:${caseOne.id}:${team.id}:failed`,
      runId: context.runId,
      caseId: caseOne.id,
      teamCompositionId: team.id,
      mode: "certified",
      track: "gameiq",
      harnessProfile: context.harnessProfile,
      status: "failed_verifier",
      startedAt: context.startedAt,
      completedAt: new Date().toISOString(),
      verifiedQuality: 0,
      jobSuccessScore: 0,
      efficiencyScore: 0,
      gameIqScore: 0,
      costUsd: null,
      inputTokens: 0,
      outputTokens: 0,
      modelCalls: 1,
      toolCalls: 0,
      durationMs: 1,
      artifactIds: [],
      traceIds: [],
      failureIds: [],
      harnessVersion: "raw-single-model-v0.1",
      promptSetVersion: "certified-prompts-v0.1",
      scoringVersion: "certified-v0.1",
    },
  ],
});
const generatedFailureBundle = exportBenchmarkReportBundleV2();
const generatedFailureAttempt = generatedFailureBundle.attemptsV2.find(
  (attempt) => attempt.runId === failedWithoutFailureSummary.runId
);
check(
  "failed returned attempt gets persisted failure id",
  Boolean(generatedFailureAttempt?.failureIds.length),
  generatedFailureAttempt
);
check(
  "failed returned attempt gets persisted failure record",
  generatedFailureBundle.failures.some(
    (failure) =>
      generatedFailureAttempt?.failureIds.includes(failure.id) &&
      failure.attemptId === generatedFailureAttempt.id
  ),
  generatedFailureBundle.failures
);

__resetBenchmarkStoreForTests();
await saveBenchmarkCaseV2(caseOne);
await saveBenchmarkTeamComposition(team);
const providerCrashSummary = await runCertifiedBenchmark({
  runId: "run-certified-engine-provider-crash",
  suiteId: "suite-engine",
  track: "gameiq",
  harnessProfile: "raw-single-model",
  caseIds: [caseOne.id],
  teamCompositionIds: [team.id],
  certification: passingCertification,
  runner: async (context) => {
    await context.recordTrace({
      id: `${context.runId}:trace:provider-error`,
      runId: context.runId,
      caseId: caseOne.id,
      modelId: "openai:gpt-engine",
      providerId: "openai",
      participantId: team.id,
      schemaMode: "structured",
      startedAt: context.startedAt,
      completedAt: new Date().toISOString(),
      latencyMs: 10,
      inputTokens: 6,
      outputTokens: 0,
      estimatedUsd: 0.0001,
      rawResponse: "",
      retryHistory: [
        {
          attempt: 1,
          status: "provider_error",
          message: "Provider 503 before output",
        },
      ],
      error: "Provider 503 before output",
    });
    throw new Error("Provider 503 before output");
  },
});
const providerCrashBundle = exportBenchmarkReportBundleV2();
const providerCrashAttempt = providerCrashBundle.attemptsV2.find(
  (attempt) => attempt.runId === providerCrashSummary.runId
);
check(
  "runner crash creates failed certified attempt",
  providerCrashSummary.status === "failed" &&
    providerCrashAttempt?.status === "provider_unavailable",
  { summary: providerCrashSummary, attempt: providerCrashAttempt }
);
check(
  "runner crash attempt keeps trace evidence and failure record",
  providerCrashAttempt?.traceIds.length === 1 &&
    providerCrashBundle.failures.some((failure) =>
      providerCrashAttempt.failureIds.includes(failure.id)
    ),
  { attempt: providerCrashAttempt, failures: providerCrashBundle.failures }
);

if (failures === 0) {
  console.log("PASS");
} else {
  console.log(`FAIL ${failures} check(s) failed`);
}

process.exit(failures === 0 ? 0 : 1);
