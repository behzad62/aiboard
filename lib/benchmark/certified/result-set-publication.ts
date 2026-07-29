import {
  listBenchmarkAttemptsV2,
  listBenchmarkCaseV2,
  listBenchmarkResultSets,
  listBenchmarkRuns,
  listBenchmarkVerifierResults,
  saveBenchmarkResultSet,
} from "@/lib/benchmark/store";
import { aggregateCertifiedRunScores } from "@/lib/benchmark/scoring/aggregate";
import type {
  BenchmarkAttemptV2,
  BenchmarkExpectedResultAttempt,
  BenchmarkResultSet,
  CertifiedResultSnapshotMetrics,
} from "@/lib/benchmark/types";

const STALE_PENDING_RESULT_SET_MS = 24 * 60 * 60 * 1000;
const SCOREABLE_STATUSES = new Set<BenchmarkAttemptV2["status"]>([
  "passed",
  "failed_model",
  "failed_verifier",
  "failed_tool_use",
]);

export interface BenchmarkResultSetBinding {
  resultSetId: string;
  runId: string;
}

export interface ResultSetOwnershipMap {
  defaultResultSetId?: string;
  byTeamCompositionId: Record<string, string>;
}

export async function createPendingBenchmarkResultSet(
  input: Omit<BenchmarkResultSet, "status" | "createdAt" | "metrics">
): Promise<BenchmarkResultSet> {
  const record: BenchmarkResultSet = {
    ...input,
    status: "pending",
    createdAt: new Date().toISOString(),
  };
  await saveBenchmarkResultSet(record);
  return record;
}

export async function publishBenchmarkResultSetIfComplete(
  resultSetId: string
): Promise<BenchmarkResultSet> {
  return validateAndPublishBenchmarkResultSet(resultSetId);
}

export async function publishBenchmarkResultSetAfterRuns(
  resultSetId: string,
  settledRunIds: string[]
): Promise<BenchmarkResultSet> {
  return validateAndPublishBenchmarkResultSet(
    resultSetId,
    new Set(settledRunIds)
  );
}

async function validateAndPublishBenchmarkResultSet(
  resultSetId: string,
  settledRunIds?: ReadonlySet<string>
): Promise<BenchmarkResultSet> {
  const resultSet = await requireResultSet(resultSetId);
  if (resultSet.status === "completed") return resultSet;
  if (resultSet.status !== "pending") {
    throw new Error(
      `Benchmark result set ${resultSetId} is ${resultSet.status}, not pending.`
    );
  }
  if (resultSet.expectedAttempts.length === 0) {
    throw new Error(
      `Benchmark result set ${resultSetId} has no expected attempts.`
    );
  }

  const [allAttempts, cases, verifierResults, runs] = await Promise.all([
    listBenchmarkAttemptsV2(),
    listBenchmarkCaseV2(),
    listBenchmarkVerifierResults(),
    listBenchmarkRuns(),
  ]);
  const ownedAttempts = allAttempts.filter(
    (attempt) => attempt.resultSetId === resultSetId
  );
  const casesById = new Map(cases.map((item) => [item.id, item]));
  const runsById = new Map(runs.map((item) => [item.id, item]));
  const verifiersById = new Map(
    verifierResults.map((item) => [item.id, item])
  );
  const attemptsByKey = new Map<string, BenchmarkAttemptV2[]>();
  const expectedByAttemptKey = new Map(
    resultSet.expectedAttempts.map((expected) => [
      evidenceAttemptKey(expected),
      expected,
    ])
  );
  for (const attempt of ownedAttempts) {
    const key = evidenceAttemptKey(attempt);
    if (!expectedByAttemptKey.has(key)) {
      throw new Error(
        `Benchmark result set ${resultSetId} contains an unexpected owned attempt ${attempt.id}.`
      );
    }
    const list = attemptsByKey.get(key) ?? [];
    list.push(attempt);
    attemptsByKey.set(key, list);
  }

  const scoreableAttempts: BenchmarkAttemptV2[] = [];
  for (const expected of resultSet.expectedAttempts) {
    if (!resultSet.runIds.includes(expected.runId)) {
      throw new Error(
        `Benchmark result set ${resultSetId} expected run ${expected.runId} is not owned by the result set.`
      );
    }
    const matches = attemptsByKey.get(evidenceAttemptKey(expected)) ?? [];
    if (settledRunIds && !settledRunIds.has(expected.runId)) {
      if (matches.length > 0) {
        throw new Error(
          `Benchmark result set ${resultSetId} has evidence for unsettled run ${expected.runId}.`
        );
      }
      continue;
    }
    const run = runsById.get(expected.runId);
    if (!run) {
      throw new Error(
        `Benchmark result set ${resultSetId} is missing run ${expected.runId}.`
      );
    }
    if (run.suiteId !== expected.suiteId) {
      throw new Error(
        `Benchmark result set ${resultSetId} run ${expected.runId} uses suite ${run.suiteId ?? "(none)"}, expected ${expected.suiteId}.`
      );
    }
    if (!run.caseIds.includes(expected.caseId)) {
      throw new Error(
        `Benchmark result set ${resultSetId} run ${expected.runId} does not own case ${expected.caseId}.`
      );
    }
    const runTrack = parseRunTrack(run.summaryJson);
    if (runTrack !== expected.track) {
      throw new Error(
        `Benchmark result set ${resultSetId} run ${expected.runId} uses track ${runTrack ?? "(none)"}, expected ${expected.track}.`
      );
    }
    if (matches.length === 0) {
      throw new Error(
        `Benchmark result set ${resultSetId} is missing expected attempt ${describeExpected(expected)}.`
      );
    }
    if (matches.length !== 1) {
      throw new Error(
        `Benchmark result set ${resultSetId} has duplicate attempts for ${describeExpected(expected)}.`
      );
    }
    const attempt = matches[0]!;
    const benchmarkCase = casesById.get(expected.caseId);
    if (
      !benchmarkCase ||
      benchmarkCase.track !== expected.track ||
      benchmarkCase.caseVersion !== expected.caseVersion ||
      benchmarkCase.scoring.scoringVersion !== expected.scoringVersion ||
      attempt.scoringVersion !== expected.scoringVersion
    ) {
      throw new Error(
        `Benchmark result set ${resultSetId} has mismatched case/scoring versions for ${describeExpected(expected)}.`
      );
    }
    if (!attempt.completedAt || !SCOREABLE_STATUSES.has(attempt.status)) {
      throw new Error(
        `Benchmark result set ${resultSetId} has unpublishable infrastructure status ${attempt.status}.`
      );
    }
    if (!attempt.verifierResultId) {
      throw new Error(
        `Benchmark result set ${resultSetId} is missing a verifier reference for ${attempt.id}.`
      );
    }
    const verifier = verifiersById.get(attempt.verifierResultId);
    if (!verifier || verifier.resultSetId !== resultSetId) {
      throw new Error(
        `Benchmark result set ${resultSetId} is missing its owned verifier ${attempt.verifierResultId}.`
      );
    }
    if (verifier.attemptId !== attempt.id) {
      throw new Error(
        `Benchmark result set ${resultSetId} verifier ${verifier.id} references attempt ${verifier.attemptId}, expected ${attempt.id}.`
      );
    }
    if (verifier.caseId !== expected.caseId) {
      throw new Error(
        `Benchmark result set ${resultSetId} verifier ${verifier.id} references case ${verifier.caseId}, expected ${expected.caseId}.`
      );
    }
    scoreableAttempts.push(attempt);
  }

  if (scoreableAttempts.length !== ownedAttempts.length) {
    throw new Error(
      `Benchmark result set ${resultSetId} contains unexpected or duplicate owned attempts.`
    );
  }
  if (scoreableAttempts.length !== resultSet.expectedAttempts.length) {
    return resultSet;
  }
  const rows = aggregateCertifiedRunScores({
    resultSetIds: new Set([resultSetId]),
    attempts: scoreableAttempts,
    cases,
  });
  if (rows.length !== 1) {
    throw new Error(
      `Benchmark result set ${resultSetId} must resolve to exactly one scoreable subject.`
    );
  }
  const completedAt = new Date().toISOString();
  const completed: BenchmarkResultSet = {
    ...resultSet,
    status: "completed",
    completedAt,
    terminalAt: completedAt,
    metrics: intrinsicMetrics(rows[0]!),
  };
  await saveBenchmarkResultSet(completed);
  return completed;
}

export async function failBenchmarkResultSet(
  resultSetId: string,
  failure: BenchmarkResultSet["failure"]
): Promise<void> {
  if (!failure) {
    throw new Error("A benchmark result-set failure is required.");
  }
  const resultSet = await requireResultSet(resultSetId);
  if (resultSet.status !== "pending") return;
  await saveBenchmarkResultSet({
    ...resultSet,
    status: "failed",
    terminalAt: new Date().toISOString(),
    failure: {
      kind: failure.kind,
      code: failure.code,
      message: failure.message,
    },
  });
}

export async function cancelBenchmarkResultSet(
  resultSetId: string,
  message: string
): Promise<void> {
  const resultSet = await requireResultSet(resultSetId);
  if (resultSet.status !== "pending") return;
  await saveBenchmarkResultSet({
    ...resultSet,
    status: "cancelled",
    terminalAt: new Date().toISOString(),
    failure: {
      kind: "cancelled",
      code: "cancelled_user",
      message,
    },
  });
}

export async function reconcileStaleBenchmarkResultSets(input: {
  nowMs?: number;
  hasLiveTabRun: boolean;
}): Promise<number> {
  if (input.hasLiveTabRun) return 0;
  const nowMs = input.nowMs ?? Date.now();
  let reconciled = 0;
  for (const resultSet of await listBenchmarkResultSets()) {
    if (resultSet.status !== "pending") continue;
    const createdMs = Date.parse(resultSet.createdAt);
    if (
      !Number.isFinite(createdMs) ||
      nowMs - createdMs < STALE_PENDING_RESULT_SET_MS
    ) {
      continue;
    }
    await failBenchmarkResultSet(resultSet.id, {
      kind: "interrupted",
      code: "stale_pending",
      message:
        "Benchmark execution was interrupted before this result set could be published.",
    });
    reconciled += 1;
  }
  return reconciled;
}

function evidenceAttemptKey(
  attempt: Pick<
    BenchmarkExpectedResultAttempt,
    "runId" | "track" | "caseId" | "teamCompositionId"
  >
): string {
  return [
    attempt.runId,
    attempt.track,
    attempt.caseId,
    attempt.teamCompositionId,
  ].join("\u0000");
}

function parseRunTrack(summaryJson: string): BenchmarkAttemptV2["track"] | null {
  try {
    const parsed = JSON.parse(summaryJson) as { track?: unknown };
    return typeof parsed.track === "string"
      ? (parsed.track as BenchmarkAttemptV2["track"])
      : null;
  } catch {
    return null;
  }
}

function describeExpected(expected: BenchmarkExpectedResultAttempt): string {
  return `${expected.runId}/${expected.track}/${expected.suiteId}/${expected.caseId}/${expected.teamCompositionId}`;
}

async function requireResultSet(resultSetId: string): Promise<BenchmarkResultSet> {
  const record = (await listBenchmarkResultSets()).find(
    (item) => item.id === resultSetId
  );
  if (!record) {
    throw new Error(`Unknown benchmark result set: ${resultSetId}`);
  }
  return record;
}

function intrinsicMetrics(
  row: ReturnType<typeof aggregateCertifiedRunScores>[number]
): CertifiedResultSnapshotMetrics {
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
