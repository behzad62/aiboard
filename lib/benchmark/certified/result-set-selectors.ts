import {
  canonicalBenchmarkResultConfigurationString,
} from "@/lib/benchmark/certified/result-set-identity";
import type {
  BenchmarkResultSeries,
  BenchmarkResultSet,
} from "@/lib/benchmark/types";

interface CompletedResultSet {
  resultSet: BenchmarkResultSet;
  completedAtMs: number;
  canonicalConfiguration: string;
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
            ? latest.metrics!.overallScore - previous.metrics.overallScore
            : null,
        passRateDelta:
          latest.metrics!.verifiedPassRate !== null &&
          previous?.metrics?.verifiedPassRate !== null &&
          previous?.metrics?.verifiedPassRate !== undefined
            ? latest.metrics!.verifiedPassRate - previous.metrics.verifiedPassRate
            : null,
      };
    })
  );
}
