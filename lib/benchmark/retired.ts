import type {
  BenchmarkAttemptV2,
  BenchmarkCaseV2,
  BenchmarkResultSet,
  BenchmarkRun,
} from "@/lib/benchmark/types";
import type { CertifiedBenchmarkDashboardInput } from "@/lib/benchmark/scoring/types";

// GameIQ and the Fireworks TeamIQ suites were removed from the benchmark.
// Their historical run files stay on disk until the user deletes them from
// the Data tab, but nothing they produced may feed a leaderboard: a result
// set that blended a GameIQ pack into its score is no longer comparable with
// one that did not.
const RETIRED_TRACKS = new Set<string>(["gameiq"]);
const RETIRED_SUITE_PREFIXES = ["gameiq-", "fireworks-", "toolreliability-current-", "workbench-current-"];

function isHistoricalCase(track: string, id: string, version?: string): boolean {
  if (track === "toolreliability" && id.startsWith("toolrel-")) return true;
  if (track === "workbench" && (id.includes("recoverable-job-service") || Number.parseInt(version ?? "0", 10) < 4)) return true;
  return false;
}

export function isRetiredBenchmarkSuite(suiteId: string | undefined): boolean {
  return Boolean(
    suiteId && RETIRED_SUITE_PREFIXES.some((prefix) => suiteId.startsWith(prefix))
  );
}

export function isRetiredBenchmarkTrack(track: string | undefined): boolean {
  return Boolean(track && RETIRED_TRACKS.has(track));
}

export function isRetiredBenchmarkResultSet(resultSet: BenchmarkResultSet): boolean {
  return (
    resultSet.configuration.tracks.some(
      (track) =>
        isRetiredBenchmarkTrack(track.track) ||
        isRetiredBenchmarkSuite(track.suiteId) ||
        track.caseManifest.some(item => isHistoricalCase(track.track, item.caseId, item.caseVersion))
    ) ||
    resultSet.expectedAttempts.some(
      (attempt) =>
        isRetiredBenchmarkTrack(attempt.track) ||
        isRetiredBenchmarkSuite(attempt.suiteId) ||
        isHistoricalCase(attempt.track, attempt.caseId, attempt.caseVersion)
    )
  );
}

export function isRetiredBenchmarkCase(caseRecord: BenchmarkCaseV2): boolean {
  return (
    isRetiredBenchmarkTrack(caseRecord.track) ||
    isRetiredBenchmarkSuite(caseRecord.id) ||
    isHistoricalCase(caseRecord.track, caseRecord.id, caseRecord.caseVersion)
  );
}

export function isRetiredBenchmarkRun(run: BenchmarkRun): boolean {
  if (isRetiredBenchmarkSuite(run.suiteId)) return true;
  try {
    const summary = JSON.parse(run.summaryJson) as { track?: unknown };
    return typeof summary.track === "string" && isRetiredBenchmarkTrack(summary.track);
  } catch {
    return false;
  }
}

/** Runs whose evidence is retired; the Data tab offers to delete them. */
export function listRetiredBenchmarkRunIds(
  runs: BenchmarkRun[],
  attempts: BenchmarkAttemptV2[],
  cases: BenchmarkCaseV2[]
): string[] {
  const retiredCaseIds = new Set(
    cases.filter(isRetiredBenchmarkCase).map((item) => item.id)
  );
  const ids = new Set(runs.filter(isRetiredBenchmarkRun).map((run) => run.id));
  for (const attempt of attempts) {
    if (isRetiredBenchmarkTrack(attempt.track) || retiredCaseIds.has(attempt.caseId)) {
      ids.add(attempt.runId);
    }
  }
  return [...ids];
}

/** Drops every record that belongs to a retired track or suite. */
export function withoutRetiredBenchmarkEvidence(
  input: CertifiedBenchmarkDashboardInput
): CertifiedBenchmarkDashboardInput {
  const retiredRunIds = new Set(
    listRetiredBenchmarkRunIds(input.runs, input.attemptsV2, input.caseV2)
  );
  if (
    retiredRunIds.size === 0 &&
    !input.resultSets.some(isRetiredBenchmarkResultSet)
  ) {
    return input;
  }
  const attemptsV2 = input.attemptsV2.filter(
    (attempt) => !retiredRunIds.has(attempt.runId)
  );
  const keptAttemptIds = new Set(attemptsV2.map((attempt) => attempt.id));
  const keepByAttempt = <T extends { attemptId?: string | null; runId?: string }>(
    record: T
  ) =>
    !(record.runId && retiredRunIds.has(record.runId)) &&
    (record.attemptId == null || keptAttemptIds.has(record.attemptId));
  return {
    ...input,
    resultSets: input.resultSets.filter(
      (resultSet) => !isRetiredBenchmarkResultSet(resultSet)
    ),
    runs: input.runs.filter((run) => !retiredRunIds.has(run.id)),
    caseV2: input.caseV2.filter((item) => !isRetiredBenchmarkCase(item)),
    attemptsV2,
    verifierResults: input.verifierResults.filter(keepByAttempt),
    artifacts: input.artifacts.filter(keepByAttempt),
    failures: input.failures.filter(keepByAttempt),
    traces: input.traces.filter(keepByAttempt),
    runEvents: input.runEvents.filter(keepByAttempt),
    toolCallTraces: input.toolCallTraces.filter(keepByAttempt),
  };
}
