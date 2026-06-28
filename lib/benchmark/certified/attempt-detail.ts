import type {
  BenchmarkArtifact,
  BenchmarkAttemptV2,
  BenchmarkCaseV2,
  BenchmarkFailure,
  BenchmarkModelCallTrace,
  BenchmarkTeamComposition,
  BenchmarkToolCallTrace,
  BenchmarkVerifierResult,
} from "@/lib/benchmark/types";
import type { CertifiedRunSummary } from "./run-status";

export interface AttemptDetailViewModelInput {
  summary: CertifiedRunSummary | null;
  cases: BenchmarkCaseV2[];
  attempts: BenchmarkAttemptV2[];
  teams: BenchmarkTeamComposition[];
  verifiers: BenchmarkVerifierResult[];
  traces: BenchmarkModelCallTrace[];
  toolCalls: BenchmarkToolCallTrace[];
  artifacts: BenchmarkArtifact[];
  failures: BenchmarkFailure[];
}

export interface AttemptDetailViewModel {
  attempt: BenchmarkAttemptV2;
  caseRecord: BenchmarkCaseV2 | null;
  team: BenchmarkTeamComposition | null;
  verifier: BenchmarkVerifierResult | null;
  modelTraces: BenchmarkModelCallTrace[];
  toolCalls: BenchmarkToolCallTrace[];
  artifacts: BenchmarkArtifact[];
  patchArtifacts: BenchmarkArtifact[];
  failures: BenchmarkFailure[];
  metrics: {
    costUsd: number | null;
    inputTokens: number;
    outputTokens: number;
    modelCalls: number;
    toolCalls: number;
    durationMs: number;
    verifiedQuality: number;
    jobSuccessScore: number;
  };
  versions: {
    harnessVersion: string;
    promptSetVersion: string;
    scoringVersion: string;
  };
}

export function buildAttemptDetailViewModel(
  input: AttemptDetailViewModelInput
): AttemptDetailViewModel | null {
  if (!input.summary) return null;
  const attempt = input.attempts
    .filter((candidate) => candidate.runId === input.summary?.runId)
    .sort(compareAttemptRecency)[0];
  if (!attempt) return null;

  const artifacts = input.artifacts.filter(
    (artifact) =>
      artifact.attemptId === attempt.id ||
      attempt.artifactIds.includes(artifact.id)
  );
  return {
    attempt,
    caseRecord:
      input.cases.find((caseRecord) => caseRecord.id === attempt.caseId) ?? null,
    team:
      input.teams.find((team) => team.id === attempt.teamCompositionId) ?? null,
    verifier:
      input.verifiers.find((verifier) => verifier.id === attempt.verifierResultId) ??
      input.verifiers.find((verifier) => verifier.attemptId === attempt.id) ??
      null,
    modelTraces: input.traces.filter(
      (trace) => trace.attemptId === attempt.id || attempt.traceIds.includes(trace.id)
    ),
    toolCalls: input.toolCalls.filter((trace) => trace.attemptId === attempt.id),
    artifacts,
    patchArtifacts: artifacts.filter((artifact) => artifact.kind === "patch"),
    failures: input.failures.filter(
      (failure) =>
        failure.attemptId === attempt.id || attempt.failureIds.includes(failure.id)
    ),
    metrics: {
      costUsd: attempt.costUsd,
      inputTokens: attempt.inputTokens,
      outputTokens: attempt.outputTokens,
      modelCalls: attempt.modelCalls,
      toolCalls: attempt.toolCalls,
      durationMs: attempt.durationMs,
      verifiedQuality: attempt.verifiedQuality,
      jobSuccessScore: attempt.jobSuccessScore,
    },
    versions: {
      harnessVersion: attempt.harnessVersion,
      promptSetVersion: attempt.promptSetVersion,
      scoringVersion: attempt.scoringVersion,
    },
  };
}

function compareAttemptRecency(
  left: BenchmarkAttemptV2,
  right: BenchmarkAttemptV2
): number {
  const leftTime = Date.parse(left.completedAt ?? left.startedAt);
  const rightTime = Date.parse(right.completedAt ?? right.startedAt);
  return (Number.isFinite(rightTime) ? rightTime : 0) -
    (Number.isFinite(leftTime) ? leftTime : 0);
}
