import {
  benchmarkResultConfigurationKey,
  canonicalBenchmarkResultConfigurationString,
} from "@/lib/benchmark/certified/result-set-identity";
import type {
  BenchmarkArtifact,
  BenchmarkAttemptV2,
  BenchmarkCaseV2,
  BenchmarkFailure,
  BenchmarkModelCallTrace,
  BenchmarkResultSeries,
  BenchmarkResultSet,
  BenchmarkRun,
  BenchmarkRunEvent,
  BenchmarkTeamComposition,
  BenchmarkToolCallTrace,
  BenchmarkVerifierResult,
} from "@/lib/benchmark/types";
import { normalizeBenchmarkReasoningEffort } from "@/lib/benchmark/model-effort";
import { aggregateCertifiedRunScores } from "@/lib/benchmark/scoring/aggregate";
import type { CertifiedResultSnapshotMetrics } from "@/lib/benchmark/types";

const SCOREABLE_STATUSES = new Set<BenchmarkAttemptV2["status"]>([
  "passed",
  "failed_model",
  "failed_verifier",
  "failed_tool_use",
]);

export interface BenchmarkResultSetEvidence {
  runs: readonly BenchmarkRun[];
  attempts: readonly BenchmarkAttemptV2[];
  cases: readonly BenchmarkCaseV2[];
  verifierResults: readonly BenchmarkVerifierResult[];
  artifacts: readonly BenchmarkArtifact[];
  failures: readonly BenchmarkFailure[];
  traces: readonly BenchmarkModelCallTrace[];
  runEvents: readonly BenchmarkRunEvent[];
  toolCallTraces: readonly BenchmarkToolCallTrace[];
  teamCompositions: readonly BenchmarkTeamComposition[];
}

interface CompletedResultSet {
  resultSet: BenchmarkResultSet;
  completedAtMs: number;
  canonicalConfiguration: string;
}

export function isPublishableBenchmarkResultSet(
  resultSet: BenchmarkResultSet,
  evidence: BenchmarkResultSetEvidence
): boolean {
  if (
    resultSet.status !== "completed" ||
    !resultSet.metrics ||
    !Number.isFinite(Date.parse(resultSet.completedAt ?? "")) ||
    resultSet.configurationKey !==
      benchmarkResultConfigurationKey(resultSet.configuration) ||
    resultSet.expectedAttempts.length === 0
  ) {
    return false;
  }

  const configuredCases = new Set(
    resultSet.configuration.tracks.flatMap((track) =>
      track.caseManifest.map((item) =>
        [
          track.track,
          track.suiteId,
          item.caseId,
          item.caseVersion,
          item.scoringVersion,
        ].join("\u0000")
      )
    )
  );
  const expectedRunIds = new Set(
    resultSet.expectedAttempts.map((expected) => expected.runId)
  );
  if (
    configuredCases.size !== resultSet.expectedAttempts.length ||
    expectedRunIds.size !== resultSet.runIds.length ||
    resultSet.runIds.some((runId) => !expectedRunIds.has(runId)) ||
    resultSet.expectedAttempts.some(
      (expected) =>
        !resultSet.runIds.includes(expected.runId) ||
        !configuredCases.has(
          [
            expected.track,
            expected.suiteId,
            expected.caseId,
            expected.caseVersion,
            expected.scoringVersion,
          ].join("\u0000")
        )
    )
  ) {
    return false;
  }

  const ownedAttempts = evidence.attempts.filter(
    (attempt) => attempt.resultSetId === resultSet.id
  );
  if (ownedAttempts.length !== resultSet.expectedAttempts.length) {
    return false;
  }
  const attemptsByKey = new Map<string, BenchmarkAttemptV2[]>();
  for (const attempt of ownedAttempts) {
    const key = attemptEvidenceKey(attempt);
    const records = attemptsByKey.get(key) ?? [];
    records.push(attempt);
    attemptsByKey.set(key, records);
  }
  const casesById = new Map(evidence.cases.map((item) => [item.id, item]));
  const runsById = new Map(evidence.runs.map((item) => [item.id, item]));
  const verifiersById = new Map(
    evidence.verifierResults.map((item) => [item.id, item])
  );
  const artifactsById = new Map(
    evidence.artifacts.map((item) => [item.id, item])
  );
  const failuresById = new Map(
    evidence.failures.map((item) => [item.id, item])
  );
  const tracesById = new Map(evidence.traces.map((item) => [item.id, item]));
  const ownedAttemptIds = new Set(ownedAttempts.map((attempt) => attempt.id));
  const ownedCaseIds = new Set(
    resultSet.expectedAttempts.map((expected) => expected.caseId)
  );
  const ownedRunIds = new Set(resultSet.runIds);
  const expectedCompositionIds = new Set(
    resultSet.expectedAttempts.map((expected) => expected.teamCompositionId)
  );
  if (
    expectedCompositionIds.size !== 1 ||
    !compositionMatchesConfiguration(
      evidence.teamCompositions.find(
        (composition) =>
          composition.id === [...expectedCompositionIds][0]
      ),
      resultSet
    )
  ) {
    return false;
  }

  const expectedEvidenceIsComplete = resultSet.expectedAttempts.every((expected) => {
    const matches = attemptsByKey.get(attemptEvidenceKey(expected)) ?? [];
    if (matches.length !== 1) return false;
    const attempt = matches[0]!;
    const benchmarkCase = casesById.get(expected.caseId);
    const run = runsById.get(expected.runId);
    if (
      !attempt.completedAt ||
      !SCOREABLE_STATUSES.has(attempt.status) ||
      attempt.scoringVersion !== expected.scoringVersion ||
      !run ||
      run.suiteId !== expected.suiteId ||
      !run.caseIds.includes(expected.caseId) ||
      !run.resultSetIds?.includes(resultSet.id) ||
      parseRunTrack(run.summaryJson) !== expected.track ||
      !benchmarkCase ||
      benchmarkCase.track !== expected.track ||
      benchmarkCase.caseVersion !== expected.caseVersion ||
      benchmarkCase.scoring.scoringVersion !== expected.scoringVersion ||
      !attempt.verifierResultId ||
      !allOwnedReferencesExist(
        attempt.artifactIds,
        artifactsById,
        resultSet.id,
        attempt.id
      ) ||
      !allOwnedReferencesExist(
        attempt.traceIds,
        tracesById,
        resultSet.id,
        attempt.id
      )
    ) {
      return false;
    }
    const verifier = verifiersById.get(attempt.verifierResultId);
    return Boolean(
      verifier &&
        verifier.resultSetId === resultSet.id &&
        verifier.attemptId === attempt.id &&
        verifier.caseId === expected.caseId &&
        allOwnedFailureReferencesExist(
          attempt.failureIds,
          failuresById,
          resultSet.id,
          attempt.id,
          verifier
        ) &&
        allOwnedReferencesExist(
          verifier.artifactIds,
          artifactsById,
          resultSet.id,
          attempt.id
        )
    );
  });
  if (!expectedEvidenceIsComplete) return false;
  const canonicalMetrics = materializeCertifiedResultSnapshotMetrics(
    resultSet.id,
    ownedAttempts,
    evidence.cases
  );
  if (
    !canonicalMetrics ||
    !hasValidSnapshotMetricInvariants(resultSet.metrics) ||
    JSON.stringify(canonicalMetrics) !== JSON.stringify(resultSet.metrics)
  ) {
    return false;
  }

  return (
    evidence.verifierResults
      .filter((record) => record.resultSetId === resultSet.id)
      .every(
        (record) =>
          ownedAttemptIds.has(record.attemptId) &&
          ownedCaseIds.has(record.caseId) &&
          allOwnedReferencesExist(
            record.artifactIds,
            artifactsById,
            resultSet.id,
            record.attemptId
          )
      ) &&
    resultSet.runIds.every((runId) => {
      const run = runsById.get(runId);
      // A shared execution run aggregates artifact/failure ids for every
      // subject. Subject publication validates only this result set's owned
      // children below; sibling-owned run references must not hide it.
      return run?.resultSetIds?.includes(resultSet.id) === true;
    }) &&
    everyOwnedRecordHasValidReferences(
      evidence.artifacts,
      resultSet.id,
      ownedRunIds,
      ownedCaseIds,
      ownedAttemptIds
    ) &&
    everyOwnedRecordHasValidReferences(
      evidence.failures,
      resultSet.id,
      ownedRunIds,
      ownedCaseIds,
      ownedAttemptIds
    ) &&
    everyOwnedRecordHasValidReferences(
      evidence.traces,
      resultSet.id,
      ownedRunIds,
      ownedCaseIds,
      ownedAttemptIds
    ) &&
    evidence.traces
      .filter((record) => record.resultSetId === resultSet.id)
      .every((record) => isTerminalTimestamp(record.completedAt)) &&
    everyOwnedAttemptRecordHasValidReferences(
      evidence.runEvents,
      resultSet.id,
      ownedAttemptIds
    ) &&
    everyOwnedAttemptRecordHasValidReferences(
      evidence.toolCallTraces,
      resultSet.id,
      ownedAttemptIds
    ) &&
    evidence.toolCallTraces
      .filter((record) => record.resultSetId === resultSet.id)
      .every((record) => isTerminalTimestamp(record.completedAt))
  );
}

function allOwnedFailureReferencesExist(
  ids: readonly string[],
  failuresById: ReadonlyMap<string, BenchmarkFailure>,
  resultSetId: string,
  attemptId: string,
  verifier: BenchmarkVerifierResult
): boolean {
  return ids.every((id) => {
    const failure = failuresById.get(id);
    if (
      failure?.resultSetId === resultSetId &&
      (failure.attemptId === undefined || failure.attemptId === attemptId)
    ) {
      return true;
    }
    // TeamIQ Tool Reliability keeps deterministic per-case failures nested in
    // the owned verifier rather than materializing a top-level failure row.
    return verifier.assertionResults.some(
      (assertion) => !assertion.passed && id === `${assertion.id}:result`
    );
  });
}

function compositionMatchesConfiguration(
  composition: BenchmarkTeamComposition | undefined,
  resultSet: BenchmarkResultSet
): boolean {
  if (!composition) return false;
  const configuration = resultSet.configuration;
  const roles = composition.roles.map((role) => ({
    role: role.role,
    slot: role.slot,
    providerId: role.providerId,
    modelId: role.modelId,
    reasoningEffort: normalizeBenchmarkReasoningEffort(role.reasoningEffort),
    maxTokens: role.maxTokens ?? null,
  }));
  const configuredRoles = configuration.roles.map((role) => ({
    ...role,
    reasoningEffort: normalizeBenchmarkReasoningEffort(role.reasoningEffort),
  }));
  if (
    roles.length !== configuredRoles.length ||
    roles.some((role, index) => {
      const configured = configuredRoles[index];
      return (
        !configured ||
        configured.role !== role.role ||
        configured.slot !== role.slot ||
        configured.providerId !== role.providerId ||
        configured.modelId !== role.modelId ||
        configured.reasoningEffort !== role.reasoningEffort ||
        configured.maxTokens !== role.maxTokens
      );
    })
  ) {
    return false;
  }
  const solo = roles.length === 1 && roles[0]?.role === "single";
  if ((configuration.subjectKind === "model") !== solo) return false;
  if (!solo) {
    return (
      (configuration.strategy ?? null) === (composition.strategy ?? null) &&
      configuration.providerId === undefined &&
      configuration.modelId === undefined
    );
  }
  const role = roles[0]!;
  return (
    configuration.providerId === role.providerId &&
    configuration.modelId === role.modelId &&
    normalizeBenchmarkReasoningEffort(configuration.reasoningEffort) ===
      role.reasoningEffort
  );
}

function parseRunTrack(summaryJson: string): BenchmarkAttemptV2["track"] | null {
  try {
    const parsed = JSON.parse(summaryJson) as { track?: unknown };
    return parsed.track === "gameiq" ||
      parsed.track === "teamiq" ||
      parsed.track === "workbench" ||
      parsed.track === "toolreliability" ||
      parsed.track === "harnessbench"
      ? parsed.track
      : null;
  } catch {
    return null;
  }
}

function allOwnedReferencesExist<
  T extends { id: string; resultSetId?: string; attemptId?: string },
>(
  ids: readonly string[],
  recordsById: ReadonlyMap<string, T>,
  resultSetId: string,
  attemptId?: string
): boolean {
  return ids.every((id) => {
    const record = recordsById.get(id);
    return Boolean(
      record &&
        record.resultSetId === resultSetId &&
        (record.attemptId === undefined ||
          attemptId === undefined ||
          record.attemptId === attemptId)
    );
  });
}

function everyOwnedRecordHasValidReferences<
  T extends {
    resultSetId?: string;
    runId?: string;
    caseId?: string;
    attemptId?: string;
  },
>(
  records: readonly T[],
  resultSetId: string,
  runIds: ReadonlySet<string>,
  caseIds: ReadonlySet<string>,
  attemptIds: ReadonlySet<string>
): boolean {
  return records
    .filter((record) => record.resultSetId === resultSetId)
    .every(
      (record) =>
        (record.runId === undefined || runIds.has(record.runId)) &&
        (record.caseId === undefined ||
          caseIds.has(record.caseId) ||
          (record.attemptId !== undefined && attemptIds.has(record.attemptId))) &&
        (record.attemptId === undefined || attemptIds.has(record.attemptId))
    );
}

function everyOwnedAttemptRecordHasValidReferences<
  T extends { resultSetId?: string; caseId: string; attemptId: string },
>(
  records: readonly T[],
  resultSetId: string,
  attemptIds: ReadonlySet<string>
): boolean {
  return records
    .filter((record) => record.resultSetId === resultSetId)
    .every((record) => attemptIds.has(record.attemptId));
}

function isTerminalTimestamp(value: string | undefined): boolean {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

export function materializeCertifiedResultSnapshotMetrics(
  resultSetId: string,
  attempts: readonly BenchmarkAttemptV2[],
  cases: readonly BenchmarkCaseV2[]
): CertifiedResultSnapshotMetrics | null {
  const rows = aggregateCertifiedRunScores({
    resultSetIds: new Set([resultSetId]),
    attempts: [...attempts],
    cases: [...cases],
  });
  if (rows.length !== 1) return null;
  const row = rows[0]!;
  return {
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
  };
}

export function hasValidSnapshotMetricInvariants(
  metrics: CertifiedResultSnapshotMetrics
): boolean {
  const count = (value: number) =>
    Number.isInteger(value) && Number.isFinite(value) && value >= 0;
  const fraction = (value: number | null) =>
    value === null || (Number.isFinite(value) && value >= 0 && value <= 1);
  const score100 = (value: number | null) =>
    value === null || (Number.isFinite(value) && value >= 0 && value <= 100);
  const nonNegative = (value: number | null) =>
    value === null || (Number.isFinite(value) && value >= 0);
  return (
    count(metrics.attempts) &&
    count(metrics.passed) &&
    count(metrics.failed) &&
    metrics.passed + metrics.failed === metrics.attempts &&
    fraction(metrics.verifiedPassRate) &&
    fraction(metrics.verifiedQuality) &&
    fraction(metrics.overallScore) &&
    score100(metrics.jobSuccessScore) &&
    score100(metrics.efficiencyScore) &&
    score100(metrics.toolReliabilityScore) &&
    count(metrics.toolReliabilitySamples) &&
    nonNegative(metrics.costUsd) &&
    nonNegative(metrics.averageCostUsd) &&
    nonNegative(metrics.durationMs) &&
    nonNegative(metrics.costPerPass) &&
    nonNegative(metrics.speedPerPassMs) &&
    nonNegative(metrics.inputTokens) &&
    nonNegative(metrics.outputTokens) &&
    nonNegative(metrics.totalTokens) &&
    nonNegative(metrics.tokensPerPass) &&
    metrics.trackBreakdown.length > 0 &&
    new Set(metrics.trackBreakdown.map((track) => track.track)).size ===
      metrics.trackBreakdown.length &&
    metrics.trackBreakdown.every(
      (track) =>
        count(track.attempts) &&
        count(track.passed) &&
        track.passed <= track.attempts &&
        fraction(track.verifiedPassRate) &&
        fraction(track.averageVerifiedQuality)
    ) &&
    metrics.trackBreakdown.reduce((sum, track) => sum + track.attempts, 0) ===
      metrics.attempts
  );
}

function attemptEvidenceKey(
  value: Pick<
    BenchmarkAttemptV2,
    "runId" | "track" | "caseId" | "teamCompositionId"
  >
): string {
  return [
    value.runId,
    value.track,
    value.caseId,
    value.teamCompositionId,
  ].join("\u0000");
}

function completedResultSet(
  resultSet: BenchmarkResultSet,
  isValid: (resultSet: BenchmarkResultSet) => boolean
): CompletedResultSet | null {
  if (!isValid(resultSet) || resultSet.status !== "completed" || !resultSet.metrics) {
    return null;
  }
  const completedAtMs = Date.parse(resultSet.completedAt ?? "");
  if (!Number.isFinite(completedAtMs)) {
    return null;
  }
  return {
    resultSet,
    completedAtMs,
    canonicalConfiguration: canonicalBenchmarkResultConfigurationString(
      resultSet.configuration
    ),
  };
}

export function selectBenchmarkResultSeries(
  resultSets: readonly BenchmarkResultSet[],
  isValid: (resultSet: BenchmarkResultSet) => boolean
): BenchmarkResultSeries[] {
  const groups = new Map<string, Map<string, CompletedResultSet[]>>();

  for (const resultSet of resultSets) {
    const completed = completedResultSet(resultSet, isValid);
    if (!completed) {
      continue;
    }
    const configurations = groups.get(resultSet.configurationKey) ?? new Map();
    const records = configurations.get(completed.canonicalConfiguration) ?? [];
    records.push(completed);
    configurations.set(completed.canonicalConfiguration, records);
    groups.set(resultSet.configurationKey, configurations);
  }

  return [...groups.entries()].flatMap(([configurationKey, configurations]) =>
    [...configurations.values()].map((records) => {
      records.sort(
        (left, right) =>
          right.completedAtMs - left.completedAtMs ||
          right.resultSet.id.localeCompare(left.resultSet.id)
      );
      const [latest, ...older] = records.map((record) => record.resultSet);
      const previous = older[0];
      return {
        configurationKey,
        latest,
        older,
        overallDelta:
          latest.metrics!.overallScore !== null &&
          previous?.metrics?.overallScore !== null &&
          previous?.metrics?.overallScore !== undefined
            ? roundDelta(
                latest.metrics!.overallScore - previous.metrics.overallScore
              )
            : null,
        passRateDelta:
          latest.metrics!.verifiedPassRate !== null &&
          previous?.metrics?.verifiedPassRate !== null &&
          previous?.metrics?.verifiedPassRate !== undefined
            ? roundDelta(
                latest.metrics!.verifiedPassRate -
                  previous.metrics.verifiedPassRate
              )
            : null,
      };
    })
  );
}

function roundDelta(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}
