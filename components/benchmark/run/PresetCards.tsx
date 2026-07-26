"use client";

import { Play, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  BENCHMARK_PRESETS,
  type BenchmarkPreset,
} from "@/lib/benchmark/certified/run-presets";

export interface PresetCardGate {
  /** Blocks the Run button; reason is shown under it. */
  disabled: boolean;
  reason?: string;
  /** Non-blocking inline note (e.g. "runner offline — WorkBench skipped"). */
  note?: string;
}

// Three preset cards (2026-07-17 benchmark UX overhaul, Task 4 Step 4): each
// has its OWN Run button (no separate "select then run" step), and clicking
// the card body focuses it — the panel shows the shared team builder only
// while a team-leg preset is focused. Disabled-state reasons and the
// WorkBench-runner note are computed by the panel (it owns the model
// checklist / team selection / runner health this depends on) and passed in
// as `gates` so this component stays presentational.
export function PresetCards({
  running,
  runningPresetId,
  focusedPresetId,
  gates,
  onFocus,
  onRun,
}: {
  running: boolean;
  runningPresetId: BenchmarkPreset["id"] | null;
  focusedPresetId: BenchmarkPreset["id"];
  gates: Record<BenchmarkPreset["id"], PresetCardGate>;
  onFocus: (id: BenchmarkPreset["id"]) => void;
  onRun: (preset: BenchmarkPreset) => void;
}) {
  return (
    <div className="grid gap-3 md:grid-cols-3">
      {BENCHMARK_PRESETS.map((preset) => {
        const gate = gates[preset.id];
        const focused = preset.id === focusedPresetId;
        const isRunningThis = running && runningPresetId === preset.id;
        return (
          <Card
            key={preset.id}
            role="button"
            tabIndex={0}
            aria-pressed={focused}
            onClick={() => onFocus(preset.id)}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                onFocus(preset.id);
              }
            }}
            className={`cursor-pointer transition-colors ${
              focused ? "border-primary" : ""
            }`}
          >
            <CardHeader>
              <CardTitle className="text-base">{preset.title}</CardTitle>
              <CardDescription>{preset.description}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-2">
              {gate.note && (
                <p className="text-xs text-muted-foreground">{gate.note}</p>
              )}
              <Button
                className="w-full"
                disabled={gate.disabled || running}
                onClick={(event) => {
                  event.stopPropagation();
                  onFocus(preset.id);
                  onRun(preset);
                }}
              >
                {isRunningThis ? (
                  <RefreshCw className="h-4 w-4 animate-spin" />
                ) : (
                  <Play className="h-4 w-4" />
                )}
                Run {preset.title}
              </Button>
              {gate.disabled && gate.reason && (
                <p className="text-xs text-muted-foreground">{gate.reason}</p>
              )}
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}
