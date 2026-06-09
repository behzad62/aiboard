"use client";

import { cn } from "@/lib/utils";
import type { EffortLevel } from "@/lib/db/schema";
import { getEffortLabel } from "@/lib/orchestrator/config";
import { Label } from "@/components/ui/label";

const LEVELS: EffortLevel[] = ["low", "medium", "high"];

interface EffortSliderProps {
  value: EffortLevel;
  onChange: (value: EffortLevel) => void;
}

export function EffortSlider({ value, onChange }: EffortSliderProps) {
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
              {getEffortLabel(level)}
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}
