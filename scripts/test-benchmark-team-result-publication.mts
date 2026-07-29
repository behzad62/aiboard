import assert from "node:assert/strict";
import {
  __clearClientStoreForTests,
  __resetBenchmarkStoreForTests,
  listBenchmarkAttemptsV2,
  listBenchmarkResultSets,
  saveBenchmarkCaseV2,
  saveBenchmarkResultSet,
  saveBenchmarkRun,
  saveBenchmarkTeamComposition,
} from "../lib/benchmark/store";
import { runCertifiedBenchmark } from "../lib/benchmark/certified/run-engine";
import {
  createPendingBenchmarkResultSet,
  failBenchmarkResultSet,
  publishBenchmarkResultSetIfComplete,
} from "../lib/benchmark/certified/result-set-publication";
import type {
  BenchmarkAttemptV2,
  BenchmarkCaseV2,
  BenchmarkResultSet,
  BenchmarkRun,
  BenchmarkTeamComposition,
  HarnessCertificationResult,
} from "../lib/benchmark/types";

const now = "2026-07-29T10:00:00.000Z";
const caseRecord: BenchmarkCaseV2 = {
  id: "team-case",
  schemaVersion: 2,
  track: "teamiq",
  title: "Team case",
  description: "Team case",
  difficulty: "easy",
  tags: [],
  caseVersion: "case-v1",
  createdAt: now,
  updatedAt: now,
  prompt: { userRequest: "team" },
  environment: { type: "browser", timeoutSeconds: 30, network: "none" },
  verifier: { scorer: "rule-checker" },
  budget: {},
  scoring: { scoringVersion: "score-v1", primary: "verified_quality" },
  contamination: {
    originalTask: true,
    canary: "team-case-canary",
    referenceSolutionPrivate: true,
  },
};
const certification: HarnessCertificationResult = {
  id: "cert",
  createdAt: now,
  aiboardVersion: "v1",
  benchmarkEngineVersion: "v1",
  harnessProfile: "aiboard-panel",
  harnessVersion: "v1",
  promptSetVersion: "v1",
  passed: true,
  checks: [],
};
const teams: BenchmarkTeamComposition[] = [
  {
    id: "solo-a",
    name: "Solo A",
    comboHash: "solo-a",
    strategy: "solo",
    roles: [{
      role: "single", slot: "single", providerId: "test", modelId: "a",
      displayName: "A", reasoningEffort: "medium", temperature: 0,
    }],
  },
  {
    id: "team-b",
    name: "Team B",
    comboHash: "team-b",
    strategy: "architect_worker",
    roles: [{
      role: "architect", slot: "architect", providerId: "test", modelId: "b",
      displayName: "B", reasoningEffort: "medium", temperature: 0,
    }],
  },
];

function runRecord(): BenchmarkRun {
  return {
    id: "shared-team-run",
    suiteId: "suite-teamiq",
    name: "team",
    domain: "model-call",
    status: "running",
    startedAt: now,
    source: "manual",
    modelIds: [],
    caseIds: [caseRecord.id],
    summaryJson: JSON.stringify({ mode: "certified", track: "teamiq" }),
    metricValueIds: [],
    artifactIds: [],
    failureIds: [],
    resultSetIds: [],
  };
}

function pending(id: string): Omit<BenchmarkResultSet, "status" | "createdAt" | "metrics"> {
  return {
    id,
    schemaVersion: 1,
    executionId: "execution-team",
    anchorRunId: "shared-team-run",
    runIds: ["shared-team-run"],
    configurationKey: `${id}-key`,
    configuration: {
      subjectKind: id.startsWith("solo") ? "model" : "team",
      displayName: id,
      roles: [],
      tracks: [{
        track: "teamiq",
        suiteId: "suite-teamiq",
        caseManifest: [{
          caseId: caseRecord.id,
          caseVersion: caseRecord.caseVersion,
          scoringVersion: caseRecord.scoring.scoringVersion,
        }],
        maxTokens: null,
      }],
    },
    expectedAttempts: [{
      runId: "shared-team-run",
      track: "teamiq",
      suiteId: "suite-teamiq",
      caseId: caseRecord.id,
      caseVersion: caseRecord.caseVersion,
      scoringVersion: caseRecord.scoring.scoringVersion,
      teamCompositionId: id,
    }],
  };
}

function scoreableAttempt(id: string): BenchmarkAttemptV2 {
  return {
    id: `attempt-${id}`,
    runId: "shared-team-run",
    caseId: caseRecord.id,
    teamCompositionId: id,
    mode: "certified",
    track: "teamiq",
    harnessProfile: "aiboard-panel",
    status: "failed_model",
    startedAt: now,
    completedAt: now,
    verifiedQuality: 0,
    jobSuccessScore: 0,
    efficiencyScore: 0,
    costUsd: null,
    inputTokens: 0,
    outputTokens: 0,
    modelCalls: 1,
    toolCalls: 0,
    durationMs: 1,
    verifierResultId: `verifier-attempt-${id}`,
    artifactIds: [],
    traceIds: [],
    failureIds: [],
    harnessVersion: "v1",
    promptSetVersion: "v1",
    scoringVersion: "score-v1",
  };
}

__clearClientStoreForTests();
__resetBenchmarkStoreForTests();
await saveBenchmarkCaseV2(caseRecord);
await saveBenchmarkRun(runRecord());
for (const team of teams) await saveBenchmarkTeamComposition(team);
for (const team of teams) await createPendingBenchmarkResultSet(pending(team.id));

const callbacks: string[] = [];
const summary = await runCertifiedBenchmark({
  runId: "shared-team-run",
  suiteId: "suite-teamiq",
  track: "teamiq",
  harnessProfile: "aiboard-panel",
  caseIds: [caseRecord.id],
  teamCompositionIds: teams.map((team) => team.id),
  certification,
  resultSetOwnership: {
    byTeamCompositionId: { "solo-a": "solo-a", "team-b": "team-b" },
  },
  onSubjectCompleted: async (teamCompositionId) => {
    callbacks.push(teamCompositionId);
    await publishBenchmarkResultSetIfComplete(teamCompositionId);
  },
  runner: async (context) => {
    const attempt = scoreableAttempt("solo-a");
    await context.registerAttemptOwner({
      attemptId: attempt.id,
      caseId: attempt.caseId,
      teamCompositionId: attempt.teamCompositionId,
    });
    await context.recordAttempt(attempt);
    await context.recordVerifier({
      id: attempt.verifierResultId!,
      attemptId: attempt.id,
      caseId: attempt.caseId,
      passed: false,
      score: 0,
      durationMs: 1,
      resultJson: "{}",
      assertionResults: [],
      artifactIds: [],
    });
    await context.recordArtifact({
      id: "artifact-a",
      attemptId: attempt.id,
      kind: "text",
      label: "A",
      mimeType: "text/plain",
      content: "A",
      createdAt: now,
    });
    await context.recordFailure({
      id: "failure-a",
      attemptId: attempt.id,
      domain: "model-call",
      source: "benchmark",
      code: "model_failed",
      severity: "error",
      message: "scoreable failure",
      createdAt: now,
    });
    await context.recordTrace({
      id: "trace-a",
      attemptId: attempt.id,
      caseId: attempt.caseId,
      modelId: "a",
      providerId: "test",
      startedAt: now,
      retryHistory: [],
    });
    await context.recordEvent({
      id: "event-a",
      attemptId: attempt.id,
      caseId: attempt.caseId,
      type: "model_call_completed",
      phase: "model",
      at: now,
      message: "done",
    });
    await context.recordToolCall({
      id: "tool-a",
      attemptId: attempt.id,
      caseId: attempt.caseId,
      toolName: "test",
      status: "ok",
      startedAt: now,
    });
    await inputSubjectCompleted(context, "solo-a");
    throw new Error("composition B infrastructure failed");
  },
});
assert.equal(summary.status, "failed");
await failBenchmarkResultSet("team-b", {
  kind: "infrastructure",
  code: "runner_failed",
  message: "composition B infrastructure failed",
});
assert.deepEqual(callbacks, ["solo-a"]);
assert.deepEqual(
  (await listBenchmarkResultSets()).map(({ id, status }) => [id, status]),
  [["solo-a", "completed"], ["team-b", "failed"]]
);
const ownedA = (await listBenchmarkAttemptsV2()).find((item) => item.teamCompositionId === "solo-a");
assert.equal(ownedA?.resultSetId, "solo-a");

async function inputSubjectCompleted(
  context: { subjectCompleted?(teamCompositionId: string): Promise<void> },
  teamCompositionId: string
): Promise<void> {
  await context.subjectCompleted?.(teamCompositionId);
}

console.log("PASS benchmark team result publication");
