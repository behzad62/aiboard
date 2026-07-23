"use client";

import { FlaskConical, Scale, ShieldQuestion } from "lucide-react";
import {
  CERTIFIED_INDEX_VERSION,
  MIN_MATURE_ATTEMPTS,
  type DecisionRow,
} from "@/lib/benchmark/certified/decision-dashboard";

const TRACKS = [
  { id: "gameiq", label: "GameIQ" },
  { id: "toolreliability", label: "Tool Reliability" },
  { id: "workbench", label: "WorkBench" },
  { id: "teamiq", label: "TeamIQ" },
  { id: "harnessbench", label: "HarnessBench" },
] as const;

export function BenchmarkIndexRibbon({ rows }: { rows: DecisionRow[] }) {
  const observedTracks = new Set(rows.flatMap((row) => row.tracks));
  const observedTrackCount = TRACKS.filter((track) =>
    observedTracks.has(track.id)
  ).length;
  const matureRows = rows.filter(
    (row) => row.attempts >= MIN_MATURE_ATTEMPTS
  ).length;
  const latest = latestCompletion(rows);

  return (
    <section
      aria-label="Benchmark index definition"
      className="overflow-hidden rounded-xl border bg-card"
    >
      <div className="grid divide-y md:grid-cols-[1.15fr_1fr_1fr] md:divide-x md:divide-y-0">
        <div className="flex gap-3 p-4">
          <FlaskConical className="mt-0.5 h-5 w-5 shrink-0 text-emerald-600 dark:text-emerald-400" aria-hidden="true" />
          <div>
            <p className="text-sm font-semibold">{CERTIFIED_INDEX_VERSION}</p>
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
              Deterministic verifier evidence from {observedTrackCount} of {TRACKS.length} tracks.
              {latest ? ` Latest result ${latest}.` : ""}
            </p>
          </div>
        </div>
        <div className="flex gap-3 p-4">
          <Scale className="mt-0.5 h-5 w-5 shrink-0 text-sky-600 dark:text-sky-400" aria-hidden="true" />
          <div>
            <p className="text-sm font-semibold">Equal weight per completed track</p>
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
              Quality is averaged within each track, then each completed track contributes equally.
            </p>
          </div>
        </div>
        <div className="flex gap-3 p-4">
          <ShieldQuestion className="mt-0.5 h-5 w-5 shrink-0 text-amber-600 dark:text-amber-400" aria-hidden="true" />
          <div>
            <p className="text-sm font-semibold">{matureRows} mature result{matureRows === 1 ? "" : "s"}</p>
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
              Mature means {MIN_MATURE_ATTEMPTS}+ scored attempts. Missing tracks are not scored as zero.
            </p>
          </div>
        </div>
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1 border-t bg-muted/25 px-4 py-2 text-[11px] text-muted-foreground">
        {TRACKS.map((track) => (
          <span key={track.id}>{track.label}</span>
        ))}
        <span className="ml-auto">95% pass-rate ranges use Wilson intervals</span>
      </div>
    </section>
  );
}

function latestCompletion(rows: DecisionRow[]): string | null {
  const timestamps = rows
    .map((row) => row.latestCompletedAt)
    .filter((value): value is string => Boolean(value))
    .map((value) => Date.parse(value))
    .filter(Number.isFinite);
  if (timestamps.length === 0) return null;
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
  }).format(new Date(Math.max(...timestamps)));
}
