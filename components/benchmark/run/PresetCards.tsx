"use client";

import { Play, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
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

// Three preset cards, each with its OWN Run button. Choosing a card (a radio,
// so it is keyboard reachable without nesting buttons) focuses it — the panel
// shows the shared team builder while a team-leg preset is focused, and the
// bench-runner controls while Full is focused. Gates come from the panel,
// which owns the checklist / team selection / runner health.
export function PresetCards({
  busy,
  runningPresetId,
  focusedPresetId,
  gates,
  onFocus,
  onRun,
}: {
  busy: boolean;
  runningPresetId: BenchmarkPreset["id"] | null;
  focusedPresetId: BenchmarkPreset["id"];
  gates: Record<BenchmarkPreset["id"], PresetCardGate>;
  onFocus: (id: BenchmarkPreset["id"]) => void;
  onRun: (preset: BenchmarkPreset) => void;
}) {
  return (
    <div
      role="radiogroup"
      aria-label="Benchmark preset"
      className="grid gap-3 md:grid-cols-3"
    >
      {BENCHMARK_PRESETS.map((preset) => {
        const gate = gates[preset.id];
        const focused = preset.id === focusedPresetId;
        const isRunningThis = busy && runningPresetId === preset.id;
        return (
          <div
            key={preset.id}
            className={`flex flex-col rounded-xl border p-4 transition-colors has-[input:focus-visible]:ring-2 has-[input:focus-visible]:ring-ring ${
              focused
                ? "border-primary bg-accent/50"
                : "bg-background/40 hover:bg-accent/30"
            }`}
          >
            <label className="block flex-1 cursor-pointer">
              <input
                type="radio"
                name="benchmark-preset"
                className="sr-only"
                checked={focused}
                onChange={() => onFocus(preset.id)}
              />
              <span className="block text-sm font-semibold">{preset.title}</span>
              <span className="mt-1 block text-sm text-muted-foreground">
                {preset.description}
              </span>
            </label>
            <div className="mt-4 space-y-2">
              {gate.note && (
                <p className="text-xs text-muted-foreground">{gate.note}</p>
              )}
              <Button
                className="w-full"
                variant={focused ? "default" : "outline"}
                disabled={gate.disabled || busy}
                onClick={() => {
                  onFocus(preset.id);
                  onRun(preset);
                }}
              >
                {isRunningThis ? (
                  <RefreshCw className="h-4 w-4 animate-spin" aria-hidden="true" />
                ) : (
                  <Play className="h-4 w-4" aria-hidden="true" />
                )}
                Run {preset.title}
              </Button>
              {gate.disabled && gate.reason && (
                <p className="text-xs text-muted-foreground">{gate.reason}</p>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
