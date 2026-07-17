"use client";

import { Square } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  TRACK_OPTIONS,
  type GameIqModelRunStatus,
  type PresetLegStatus,
} from "@/lib/benchmark/certified/run-execution";
import type { BenchmarkPresetLeg } from "@/lib/benchmark/certified/run-presets";

export interface RunProgressModelRow {
  modelId: string;
  displayName: string;
  status: GameIqModelRunStatus;
  detail?: string;
}

export interface RunProgressLegRow {
  legIndex: number;
  leg: BenchmarkPresetLeg;
  status: PresetLegStatus | "queued";
  detail?: string;
  models: RunProgressModelRow[];
}

// Generalized from CertifiedRunPanel's old GameIqModelRunProgress
// (2026-07-17 benchmark UX overhaul, Task 4 Step 4): one row per preset leg
// (GameIQ / ToolReliability / TeamIQ / WorkBench), each optionally expanding
// into per-model rows for solo legs. Statuses: Queued/Running/Passed/
// Partial/Failed/Skipped, matching runPreset's PresetProgressEvent stream.
export function RunProgressList({
  rows,
  running,
  onCancel,
}: {
  rows: RunProgressLegRow[];
  running: boolean;
  onCancel: () => void;
}) {
  if (rows.length === 0) {
    return (
      <div className="rounded-md border border-dashed px-3 py-3 text-sm text-muted-foreground">
        Run a preset above to see live progress here.
      </div>
    );
  }
  return (
    <div className="space-y-2">
      {rows.map((row) => (
        <div key={row.legIndex} className="rounded-md border px-3 py-2 text-sm">
          <div className="flex items-center justify-between gap-2">
            <span className="font-medium">
              {trackLabel(row.leg.track)}
              <span className="ml-1 text-xs font-normal text-muted-foreground">
                {row.leg.suiteId}
              </span>
            </span>
            <StatusBadge status={row.status} />
          </div>
          {row.detail && (
            <p className="mt-1 text-xs leading-snug text-muted-foreground">
              {row.detail}
            </p>
          )}
          {row.models.length > 0 && (
            <div className="mt-2 space-y-1">
              {row.models.map((model) => (
                <div
                  key={model.modelId}
                  className="flex items-center justify-between gap-2 rounded border px-2 py-1 text-xs"
                >
                  <span className="min-w-0 truncate">{model.displayName}</span>
                  <StatusBadge status={model.status} />
                </div>
              ))}
            </div>
          )}
        </div>
      ))}
      {running && (
        <Button variant="outline" size="sm" onClick={onCancel}>
          <Square className="h-4 w-4" />
          Cancel
        </Button>
      )}
    </div>
  );
}

function trackLabel(track: BenchmarkPresetLeg["track"]): string {
  return TRACK_OPTIONS.find((option) => option.id === track)?.label ?? track;
}

function StatusBadge({
  status,
}: {
  status: GameIqModelRunStatus | PresetLegStatus | "queued";
}) {
  const label =
    status === "queued"
      ? "Queued"
      : status === "running"
        ? "Running"
        : status === "passed"
          ? "Passed"
          : status === "partial"
            ? "Partial"
            : status === "skipped"
              ? "Skipped"
              : "Failed";
  const tone =
    status === "passed"
      ? "border-primary/40 bg-primary/10 text-primary"
      : status === "partial"
        ? "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300"
        : status === "failed"
          ? "border-destructive/40 bg-destructive/10 text-destructive"
          : status === "running"
            ? "border-border bg-muted text-foreground"
            : status === "skipped"
              ? "border-border bg-muted/40 text-muted-foreground"
              : "border-border bg-muted/50 text-muted-foreground";
  return (
    <span
      className={`shrink-0 rounded-full border px-2 py-0.5 text-xs font-medium ${tone}`}
    >
      {label}
    </span>
  );
}
