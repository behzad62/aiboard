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
  readLeaderboard,
  type LeaderboardSortKey,
} from "@/lib/benchmark/certified/dashboard-selectors";
import {
  filterDecisionRows,
  sortDecisionRows,
  type DecisionFilters as DecisionFilterState,
  type DecisionRow,
} from "@/lib/benchmark/certified/decision-dashboard";

export function BenchmarkDecisionDashboard({ certified }: { certified: unknown }) {
  const [filters, setFilters] = useState<DecisionFilterState>(
    EMPTY_DECISION_FILTERS
  );
  const [sortKey, setSortKey] = useState<LeaderboardSortKey>("overall");
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const allRows = useMemo(
    () => readLeaderboard(certified, "all", "quality") as DecisionRow[],
    [certified]
  );
  const rankedRows = useMemo(
    () => readLeaderboard(certified, "all", sortKey) as DecisionRow[],
    [certified, sortKey]
  );
  const filteredRows = useMemo(
    () => {
      const filtered = filterDecisionRows(rankedRows, filters);
      return filters.track === "all"
        ? filtered
        : sortDecisionRows(filtered, sortKey);
    },
    [rankedRows, filters, sortKey]
  );
  const selected = filteredRows.find((row) => row.id === selectedId) ?? null;

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
            setSelectedId(null);
          }}
        />
        <DecisionLeaderboard
          rows={filteredRows}
          totalRows={rankedRows.length}
          sortKey={sortKey}
          onSortChange={setSortKey}
          selectedId={selected?.id ?? null}
          onSelect={(row) => setSelectedId((current) => (current === row.id ? null : row.id))}
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
