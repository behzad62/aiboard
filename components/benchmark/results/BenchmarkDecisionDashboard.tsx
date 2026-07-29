"use client";

import { useMemo, useState } from "react";
import { BenchmarkIndexRibbon } from "./BenchmarkIndexRibbon";
import {
  DecisionFilters,
  EMPTY_DECISION_FILTERS,
} from "./DecisionFilters";
import { DecisionLeaderboard } from "./DecisionLeaderboard";
import { DecisionTradeoffCharts } from "./DecisionTradeoffCharts";
import { DecisionVerdicts } from "./DecisionVerdicts";
import {
  readCertifiedResultHistory,
  readLeaderboard,
  type LeaderboardSortKey,
} from "@/lib/benchmark/certified/dashboard-selectors";
import {
  filterDecisionRows,
  sortDecisionRows,
  type DecisionFilters as DecisionFilterState,
  type DecisionRow,
} from "@/lib/benchmark/certified/decision-dashboard";
import type { BenchmarkResultSet } from "@/lib/benchmark/types";
import { useBenchmarkResultSetDeletion } from "@/components/benchmark/useBenchmarkResultSetDeletion";

export function BenchmarkDecisionDashboard({
  certified,
  onRefresh,
  setMessage,
}: {
  certified: unknown;
  onRefresh: () => Promise<void>;
  setMessage: (message: string | null) => void;
}) {
  const [filters, setFilters] = useState<DecisionFilterState>(
    EMPTY_DECISION_FILTERS
  );
  const [sortKey, setSortKey] = useState<LeaderboardSortKey>("overall");
  const [selectedResultSetId, setSelectedResultSetId] = useState<string | null>(null);

  const allRows = useMemo(
    () => readLeaderboard(certified, "all", "quality") as DecisionRow[],
    [certified]
  );
  const filteredRows = useMemo(
    () => readDecisionDashboardRows(certified, filters, sortKey),
    [certified, filters, sortKey]
  );
  const rankedRowCount = useMemo(
    () => readLeaderboard(certified, filters.track, sortKey).length,
    [certified, filters.track, sortKey]
  );
  const history = useMemo(() => readCertifiedResultHistory(certified), [certified]);
  const resultSets = useMemo(() => readResultSets(certified), [certified]);
  const resultSetById = useMemo(
    () => new Map(resultSets.map((resultSet) => [resultSet.id, resultSet])),
    [resultSets]
  );
  const promotableResultSetIds = useMemo(
    () =>
      new Set(
        history
          .filter((series) => series.older.length > 0)
          .map((series) => series.latestResultSetId)
      ),
    [history]
  );
  const deletion = useBenchmarkResultSetDeletion({
    onRefresh,
    setMessage,
    promotableResultSetIds,
  });

  return (
    <div className="space-y-8">
      <section aria-labelledby="benchmark-decide-heading" className="space-y-4">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-emerald-600 dark:text-emerald-400">
            Decide
          </p>
          <h2 id="benchmark-decide-heading" className="mt-1 font-display text-2xl font-semibold tracking-tight">
            What the evidence says
          </h2>
          <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
            Compare verified task outcomes first. Sample size, coverage, tokens, and time stay visible so a thin win never looks definitive.
          </p>
        </div>
        <DecisionVerdicts rows={allRows} />
        <BenchmarkIndexRibbon rows={allRows} />
        <DecisionFilters
          value={filters}
          rows={allRows}
          onChange={(next) => {
            setFilters(next);
            setSelectedResultSetId(null);
          }}
        />
        <DecisionLeaderboard
          rows={filteredRows}
          totalRows={rankedRowCount}
          sortKey={sortKey}
          onSortChange={setSortKey}
          history={history}
          selectedResultSetId={selectedResultSetId}
          onSelect={(row) =>
            setSelectedResultSetId((current) =>
              current === row.resultSetId ? null : row.resultSetId
            )
          }
          deletingIds={deletion.deletingIds}
          deleteInFlight={deletion.deleteInFlight}
          onDelete={(row) => {
            const resultSet = resultSetById.get(row.resultSetId);
            if (resultSet) void deletion.requestDelete(resultSet, row.label);
          }}
          hasRawEvidence={hasBenchmarkRawEvidence(certified)}
        />
      </section>

      <section aria-labelledby="benchmark-understand-heading" className="space-y-4">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-sky-600 dark:text-sky-400">
            Understand
          </p>
          <h2 id="benchmark-understand-heading" className="mt-1 font-display text-2xl font-semibold tracking-tight">
            Understand the trade-offs
          </h2>
          <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
            These charts use the same filtered evidence as the comparison table. Results without a measured axis are omitted, not treated as zero.
          </p>
        </div>
        <DecisionTradeoffCharts rows={filteredRows} />
      </section>
    </div>
  );
}

export function hasBenchmarkRawEvidence(certified: unknown): boolean {
  if (!certified || typeof certified !== "object") return false;
  const record = certified as {
    resultSets?: unknown;
    audit?: {
      completedSnapshots?: unknown;
      unpublishedSnapshots?: unknown;
      legacyAttempts?: unknown;
    };
  };
  if (Array.isArray(record.resultSets) && record.resultSets.length > 0) {
    return true;
  }
  return [
    record.audit?.completedSnapshots,
    record.audit?.unpublishedSnapshots,
    record.audit?.legacyAttempts,
  ].some(
    (value) => typeof value === "number" && Number.isFinite(value) && value > 0
  );
}

function readResultSets(certified: unknown): BenchmarkResultSet[] {
  if (!certified || typeof certified !== "object") return [];
  const value = (certified as { resultSets?: unknown }).resultSets;
  return Array.isArray(value)
    ? value.filter(
        (item): item is BenchmarkResultSet =>
          Boolean(
            item &&
              typeof item === "object" &&
              typeof (item as { id?: unknown }).id === "string"
          )
      )
    : [];
}

export function readDecisionDashboardRows(
  certified: unknown,
  filters: DecisionFilterState,
  sortKey: LeaderboardSortKey
): DecisionRow[] {
  const scopedRows = readLeaderboard(
    certified,
    filters.track,
    sortKey
  ) as DecisionRow[];
  const filtered = filterDecisionRows(scopedRows, filters);
  return filters.track === "all"
    ? filtered
    : sortDecisionRows(filtered, sortKey);
}
