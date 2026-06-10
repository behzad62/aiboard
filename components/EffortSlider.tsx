"use client";

import { cn } from "@/lib/utils";
import type { DiscussionMode, EffortLevel } from "@/lib/db/schema";
import { getBuildEffortLabel, getEffortLabel } from "@/lib/orchestrator/config";
import { Label } from "@/components/ui/label";

const LEVELS: EffortLevel[] = ["low", "medium", "high"];

interface EffortSliderProps {
  value: EffortLevel;
  onChange: (value: EffortLevel) => void;
  /** Build mode shows cycle/task budgets instead of discussion rounds. */
  mode?: DiscussionMode;
}

export function EffortSlider({ value, onChange, mode }: EffortSliderProps) {
  const isBuild = mode === "build";
  return (
    <div className="space-y-3">
      <Label>Effort level</Label>
      <div className="grid grid-cols-3 gap-2">
        {LEVELS.map((level) => (
          <button
            key={level}
            type="button"
            onClick={() => onChange(level)}
            className={cn(
              "rounded-lg border px-3 py-3 text-left text-sm transition-colors",
              value === level
                ? "border-primary bg-primary/5 ring-2 ring-primary"
                : "border-border hover:bg-accent"
            )}
          >
            <div className="font-medium capitalize">{level}</div>
            <div className="mt-1 text-xs text-muted-foreground">
              {isBuild ? getBuildEffortLabel(level) : getEffortLabel(level)}
            </div>
          </button>
        ))}
      </div>
      {isBuild && (
        <p className="text-xs text-muted-foreground">
          In Build mode the effort sets the team&apos;s budget: how many
          plan→implement→review cycles run, how many tasks per wave, and how
          many worker calls in total.
        </p>
      )}
    </div>
  );
}
