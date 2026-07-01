"use client";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import type { ModelBuildStat } from "@/lib/db/schema";
import { BuildModelRow } from "@/components/benchmark/BuildModelRow";
import {
  BUILD_LEADERBOARD_COLUMNS,
  type BuildSortKey,
} from "@/components/benchmark/BuildLeaderboardShared";

export { type BuildSortKey } from "@/components/benchmark/BuildLeaderboardShared";

export function BuildLeaderboardTable({
  rows,
  sortKey,
  sortDir,
  expanded,
  onToggleSort,
  onToggleExpanded,
  onResetModel,
}: {
  rows: ModelBuildStat[];
  sortKey: BuildSortKey;
  sortDir: "asc" | "desc";
  expanded: string | null;
  onToggleSort: (key: BuildSortKey) => void;
  onToggleExpanded: (modelId: string) => void;
  onResetModel: (modelId: string) => void;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Leaderboard</CardTitle>
        <CardDescription>
          Click a column to sort; click a row for the full breakdown.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-xs text-muted-foreground">
                <th className="w-8 py-2" />
                <th className="w-10 py-2 pr-2 text-right font-medium">#</th>
                {BUILD_LEADERBOARD_COLUMNS.map((column) => (
                  <th
                    key={column.key}
                    aria-sort={
                      sortKey === column.key
                        ? sortDir === "asc"
                          ? "ascending"
                          : "descending"
                        : undefined
                    }
                    className={`px-2 py-2 font-medium ${
                      column.align === "right" ? "text-right" : "text-left"
                    }`}
                  >
                    <button
                      type="button"
                      onClick={() => onToggleSort(column.key)}
                      aria-label={`Sort by ${column.label}`}
                      className={`inline-flex items-center gap-1 hover:text-foreground ${
                        sortKey === column.key ? "text-foreground" : ""
                      }`}
                    >
                      {column.label}
                      {sortKey === column.key && (
                        <span aria-hidden>{sortDir === "asc" ? "▲" : "▼"}</span>
                      )}
                    </button>
                  </th>
                ))}
                <th className="w-8 py-2" />
              </tr>
            </thead>
            <tbody>
              {rows.map((stat, index) => (
                <BuildModelRow
                  key={stat.modelId}
                  stat={stat}
                  rank={index + 1}
                  open={expanded === stat.modelId}
                  onToggle={() => onToggleExpanded(stat.modelId)}
                  onReset={() => onResetModel(stat.modelId)}
                />
              ))}
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
  );
}
