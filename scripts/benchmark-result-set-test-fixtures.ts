import { benchmarkResultConfigurationKey } from "../lib/benchmark/certified/result-set-identity";
import { aggregateCertifiedRunScores } from "../lib/benchmark/scoring/aggregate";
import type {
  CertifiedAggregateInput,
  CertifiedBenchmarkDashboardInput,
} from "../lib/benchmark/scoring/types";
import type {
  BenchmarkAttemptV2,
  BenchmarkCaseV2,
  BenchmarkResultConfiguration,
  BenchmarkResultSet,
  BenchmarkRun,
  BenchmarkTeamComposition,
  BenchmarkVerifierResult,
} from "../lib/benchmark/types";
import { canonicalTeamCompositionKey } from "../lib/benchmark/teamiq/compositions";
import { normalizeBenchmarkReasoningEffort } from "../lib/benchmark/model-effort";

const SCOREABLE = new Set<BenchmarkAttemptV2["status"]>([
  "passed",
  "failed_model",
  "failed_verifier",
  "failed_tool_use",
]);

export function aggregateCompletedResultSetFixtures(
  input: Omit<CertifiedAggregateInput, "resultSetIds">
) {
  if (input.attempts.length === 0) return [];
  const teamById = new Map(
    (input.teamCompositions ?? []).map((team) => [team.id, team])
  );
  const attempts = input.attempts.map((attempt) => {
    if (attempt.resultSetId) return attempt;
    const team = teamById.get(attempt.teamCompositionId);
    const identity = team
      ? canonicalTeamCompositionKey(team)
      : attempt.teamCompositionId;
    return {
      ...attempt,
      resultSetId: `test-aggregate:${identity}`,
    };
  });
  return aggregateCertifiedRunScores({
    ...input,
    attempts,
    resultSetIds: new Set(attempts.map((attempt) => attempt.resultSetId!)),
  });
}

/**
 * Test-only adapter for pre-result-set dashboard fixtures. It assigns the
 * supplied scoreable evidence to one completed synthetic execution without
 * weakening the production dashboard's fail-closed result-set boundary.
 */
export function withCompletedResultSetFixtures(
  input: Omit<
    CertifiedBenchmarkDashboardInput,
    | "resultSets"
    | "runs"
    | "artifacts"
    | "failures"
    | "traces"
    | "runEvents"
    | "toolCallTraces"
  >
): CertifiedBenchmarkDashboardInput {
  const teamById = new Map(
    input.teamCompositions.map((team) => [team.id, team])
  );
  const casesById = new Map(input.caseV2.map((item) => [item.id, item]));
  for (const attempt of input.attemptsV2) {
    if (!casesById.has(attempt.caseId)) {
      casesById.set(attempt.caseId, syntheticCase(attempt));
    }
  }
  const cases = [...casesById.values()];
  const scoreable = input.attemptsV2.filter(
    (attempt) => attempt.mode === "certified" && SCOREABLE.has(attempt.status)
  );
  const grouped = new Map<string, BenchmarkAttemptV2[][]>();
  for (const attempt of scoreable) {
    const team = teamById.get(attempt.teamCompositionId);
    const identity = team
      ? canonicalTeamCompositionKey(team)
      : attempt.teamCompositionId;
    const batches = grouped.get(identity) ?? [];
    const logicalKey = `${attempt.track}\u0000${attempt.caseId}`;
    let batch = batches.find(
      (candidate) =>
        !candidate.some(
          (item) => `${item.track}\u0000${item.caseId}` === logicalKey
        )
    );
    if (!batch) {
      batch = [];
      batches.push(batch);
    }
    batch.push(attempt);
    grouped.set(identity, batches);
  }

  const clonedById = new Map<string, BenchmarkAttemptV2>();
  const resultSets: BenchmarkResultSet[] = [];
  let groupIndex = 0;
  for (const batches of grouped.values()) {
    for (const batch of batches) {
      const resultSetId = `test-result-set-${groupIndex++}`;
      for (const attempt of batch) {
        clonedById.set(attempt.id, {
          ...attempt,
          runId: `${attempt.runId}--${resultSetId}--${attempt.track}`,
          completedAt: attempt.completedAt ?? attempt.startedAt,
          verifiedQuality: attempt.verifiedQuality ?? 0,
          jobSuccessScore: attempt.jobSuccessScore ?? 0,
          efficiencyScore: attempt.efficiencyScore ?? 0,
          costUsd: attempt.costUsd ?? null,
          inputTokens: attempt.inputTokens ?? 0,
          outputTokens: attempt.outputTokens ?? 0,
          modelCalls: attempt.modelCalls ?? 1,
          toolCalls: attempt.toolCalls ?? 0,
          durationMs: attempt.durationMs ?? 0,
          artifactIds: [],
          traceIds: [],
          failureIds: [],
          harnessVersion: attempt.harnessVersion ?? "test-harness",
          promptSetVersion: attempt.promptSetVersion ?? "test-prompts",
          scoringVersion:
            casesById.get(attempt.caseId)?.scoring.scoringVersion ??
            attempt.scoringVersion ??
            "test-scoring",
          resultSetId,
          verifierResultId: `test-verifier-${attempt.id}`,
        });
      }
      const clonedBatch = batch.map((attempt) => clonedById.get(attempt.id)!);
      const team = teamById.get(batch[0]!.teamCompositionId);
      const configuration = configurationFor(team, clonedBatch, casesById);
      const row = aggregateCertifiedRunScores({
        resultSetIds: new Set([resultSetId]),
        attempts: clonedBatch,
        cases,
        teamCompositions: input.teamCompositions,
      })[0]!;
      const completedAt = clonedBatch
        .map((attempt) => attempt.completedAt ?? attempt.startedAt)
        .sort()
        .at(-1)!;
      resultSets.push({
        id: resultSetId,
        schemaVersion: 1,
        executionId: "test-execution",
        anchorRunId: clonedBatch[0]!.runId,
        runIds: [...new Set(clonedBatch.map((attempt) => attempt.runId))],
        configurationKey: benchmarkResultConfigurationKey(configuration),
        configuration,
        expectedAttempts: clonedBatch.map((attempt) => {
          const benchmarkCase = casesById.get(attempt.caseId)!;
          return {
            runId: attempt.runId,
            track: attempt.track,
            suiteId: `test-suite-${attempt.track}`,
            caseId: attempt.caseId,
            caseVersion: benchmarkCase.caseVersion,
            scoringVersion: attempt.scoringVersion,
            teamCompositionId: attempt.teamCompositionId,
          };
        }),
        status: "completed",
        createdAt: completedAt,
        completedAt,
        terminalAt: completedAt,
        metrics: {
          attempts: row.attempts,
          passed: row.passed,
          failed: row.failed,
          verifiedPassRate: row.verifiedPassRate,
          verifiedQuality: row.verifiedQuality,
          overallScore: row.overallScore,
          trackBreakdown: row.trackBreakdown.map((track) => ({
            track: track.track as BenchmarkAttemptV2["track"],
            attempts: track.attempts,
            passed: track.passed,
            verifiedPassRate: track.verifiedPassRate,
            averageVerifiedQuality: track.averageVerifiedQuality,
          })),
          jobSuccessScore: row.jobSuccessScore,
          efficiencyScore: row.efficiencyScore,
          toolReliabilityScore: row.toolReliabilityScore,
          toolReliabilitySamples: row.toolReliabilitySamples,
          costUsd: row.costUsd,
          averageCostUsd: row.averageCostUsd,
          durationMs: row.durationMs,
          costPerPass: row.costPerPass,
          speedPerPassMs: row.speedPerPassMs,
          inputTokens: row.inputTokens,
          outputTokens: row.outputTokens,
          totalTokens: row.totalTokens,
          tokensPerPass: row.tokensPerPass,
          costBasis: row.costBasis,
        },
      });
    }
  }

  const attempts = input.attemptsV2.map(
    (attempt) => clonedById.get(attempt.id) ?? attempt
  );
  const suppliedVerifierByAttemptId = new Map(
    input.verifierResults.map((result) => [result.attemptId, result])
  );
  const verifierResults: BenchmarkVerifierResult[] = attempts.flatMap(
    (attempt) => {
      if (!attempt.resultSetId || !attempt.verifierResultId) return [];
      const supplied = suppliedVerifierByAttemptId.get(attempt.id);
      return [{
        id: attempt.verifierResultId,
        attemptId: attempt.id,
        caseId: attempt.caseId,
        passed: supplied?.passed ?? attempt.status === "passed",
        score: supplied?.score ?? attempt.verifiedQuality,
        durationMs: supplied?.durationMs ?? 0,
        resultJson: supplied?.resultJson ?? "{}",
        assertionResults: supplied?.assertionResults ?? [],
        artifactIds: [],
        resultSetId: attempt.resultSetId,
      }];
    }
  );
  const runsById = new Map<string, BenchmarkRun>();
  for (const resultSet of resultSets) {
    for (const expected of resultSet.expectedAttempts) {
      const existing = runsById.get(expected.runId);
      runsById.set(expected.runId, {
        id: expected.runId,
        suiteId: expected.suiteId,
        name: expected.runId,
        domain: "build",
        status: "completed",
        startedAt: resultSet.createdAt,
        completedAt: resultSet.completedAt,
        source: "import",
        modelIds: [],
        caseIds: [
          ...new Set([...(existing?.caseIds ?? []), expected.caseId]),
        ],
        summaryJson: JSON.stringify({ track: expected.track }),
        metricValueIds: [],
        artifactIds: [],
        failureIds: [],
        resultSetIds: [
          ...new Set([...(existing?.resultSetIds ?? []), resultSet.id]),
        ],
      });
    }
  }

  return {
    ...input,
    resultSets,
    runs: [...runsById.values()],
    caseV2: cases,
    attemptsV2: attempts,
    verifierResults,
    artifacts: [],
    failures: [],
    traces: [],
    runEvents: [],
    toolCallTraces: [],
  };
}

function configurationFor(
  team: BenchmarkTeamComposition | undefined,
  attempts: BenchmarkAttemptV2[],
  casesById: ReadonlyMap<string, BenchmarkCaseV2>
): BenchmarkResultConfiguration {
  const roles = team?.roles ?? [];
  const solo = roles.length <= 1;
  const tracks = new Map<BenchmarkAttemptV2["track"], BenchmarkAttemptV2[]>();
  for (const attempt of attempts) {
    const records = tracks.get(attempt.track) ?? [];
    records.push(attempt);
    tracks.set(attempt.track, records);
  }
  return {
    subjectKind: solo ? "model" : "team",
    displayName: team?.name ?? attempts[0]!.teamCompositionId,
    providerId: solo ? roles[0]?.providerId : undefined,
    modelId: solo ? roles[0]?.modelId : undefined,
    reasoningEffort: solo
      ? normalizeBenchmarkReasoningEffort(roles[0]?.reasoningEffort)
      : undefined,
    strategy: team?.strategy,
    roles: roles.map((role) => ({
          role: role.role,
          slot: role.slot,
          providerId: role.providerId,
          modelId: role.modelId,
          reasoningEffort: normalizeBenchmarkReasoningEffort(
            role.reasoningEffort
          ),
          maxTokens: role.maxTokens ?? null,
        })),
    tracks: [...tracks.entries()].map(([track, records]) => ({
      track,
      suiteId: `test-suite-${track}`,
      caseManifest: records.map((attempt) => {
        const benchmarkCase = casesById.get(attempt.caseId)!;
        return {
          caseId: attempt.caseId,
          caseVersion: benchmarkCase.caseVersion,
          scoringVersion: attempt.scoringVersion,
        };
      }),
      maxTokens: null,
    })),
  };
}

function syntheticCase(attempt: BenchmarkAttemptV2): BenchmarkCaseV2 {
  return {
    id: attempt.caseId,
    schemaVersion: 2,
    track: attempt.track,
    title: attempt.caseId,
    description: "Synthetic completed-result-set test fixture.",
    difficulty: "easy",
    tags: [],
    caseVersion: "test-case-v1",
    createdAt: attempt.startedAt,
    updatedAt: attempt.completedAt ?? attempt.startedAt,
    prompt: { userRequest: "Test fixture." },
    environment: { type: "browser", timeoutSeconds: 1, network: "none" },
    verifier: { scorer: "rule-checker" },
    budget: {},
    scoring: {
      scoringVersion: attempt.scoringVersion ?? "test-scoring",
      primary: "verified_quality",
    },
    contamination: {
      originalTask: true,
      canary: `fixture-${attempt.caseId}`,
      referenceSolutionPrivate: false,
    },
  };
}
