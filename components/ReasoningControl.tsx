"use client";

import { Label } from "@/components/ui/label";
import { REASONING_OPTIONS } from "@/lib/orchestrator/config";
import type { ReasoningEffort } from "@/lib/db/schema";
import { cn } from "@/lib/utils";

interface ReasoningControlProps {
  value: ReasoningEffort;
  onChange: (value: ReasoningEffort) => void;
}

/**
 * How hard the models reason. Maps per provider in lib/providers/reasoning.ts.
 */
export function ReasoningControl({ value, onChange }: ReasoningControlProps) {
  // Guard against a stale module binding (e.g. a dev-only HMR transient when
  // this export was newly added) so the control degrades instead of throwing.
  const options = REASONING_OPTIONS ?? [];
  const active = options.find((o) => o.value === value);

  return (
    <div className="space-y-2">
      <Label>Reasoning effort</Label>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-6">
        {options.map((option) => {
          const selected = option.value === value;
          return (
            <button
              key={option.value}
              type="button"
              onClick={() => onChange(option.value)}
              aria-pressed={selected}
              className={cn(
                "rounded-lg border px-2 py-2 text-center text-xs font-medium leading-tight transition-colors",
                selected
                  ? "border-primary bg-primary/5 text-foreground ring-1 ring-primary"
                  : "text-muted-foreground hover:bg-accent hover:text-foreground"
              )}
            >
              {option.label}
            </button>
          );
        })}
      </div>
      {active && (
        <p className="text-xs text-muted-foreground">{active.description}</p>
      )}
    </div>
  );
}
