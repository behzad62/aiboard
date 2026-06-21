"use client";

import type { BuildRunPolicy } from "@/lib/db/schema";
import {
  buildRunPolicyLabel,
  DEFAULT_BUILD_TIME_LIMIT_MINUTES,
} from "@/lib/orchestrator/build-policy";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

const POLICIES: Array<{
  value: BuildRunPolicy;
  description: string;
}> = [
  {
    value: "finish",
    description:
      "Keep working until completed, stopped, blocked, or guardrails are reached.",
  },
  {
    value: "budgeted",
    description: "Stop cleanly when the active USD or time window is consumed.",
  },
  {
    value: "plan_only",
    description: "Plan tasks and GitHub work without implementation.",
  },
];

export interface BuildRunPolicyValue {
  runPolicy: BuildRunPolicy;
  budgetUsd: number;
  timeLimitMinutes: number;
}

interface BuildRunPolicyControlProps {
  value: BuildRunPolicyValue;
  onChange: (value: BuildRunPolicyValue) => void;
  disabled?: boolean;
}

function numericValue(value: string): number {
  if (!value.trim()) return 0;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, parsed) : 0;
}

export function BuildRunPolicyControl({
  value,
  onChange,
  disabled = false,
}: BuildRunPolicyControlProps) {
  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <Label>Run policy</Label>
        <div className="grid gap-2 sm:grid-cols-3">
          {POLICIES.map((policy) => {
            const selected = value.runPolicy === policy.value;
            return (
              <button
                key={policy.value}
                type="button"
                disabled={disabled}
                onClick={() => onChange({ ...value, runPolicy: policy.value })}
                className={cn(
                  "rounded-lg border px-3 py-3 text-left text-sm transition-colors disabled:cursor-not-allowed disabled:opacity-60",
                  selected
                    ? "border-primary bg-primary/5 ring-2 ring-primary"
                    : "border-border hover:bg-accent"
                )}
              >
                <div className="font-medium">
                  {buildRunPolicyLabel(policy.value)}
                </div>
                <p className="mt-1 text-xs text-muted-foreground">
                  {policy.description}
                </p>
              </button>
            );
          })}
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor="build-budget-usd">USD budget</Label>
          <Input
            id="build-budget-usd"
            inputMode="decimal"
            min={0}
            step="0.01"
            disabled={disabled}
            value={String(value.budgetUsd)}
            onChange={(event) =>
              onChange({ ...value, budgetUsd: numericValue(event.target.value) })
            }
          />
          <p className="text-xs text-muted-foreground">0 means unlimited.</p>
        </div>
        <div className="space-y-2">
          <Label htmlFor="build-time-minutes">Time budget, minutes</Label>
          <Input
            id="build-time-minutes"
            inputMode="numeric"
            min={0}
            step="1"
            disabled={disabled}
            value={String(value.timeLimitMinutes)}
            onChange={(event) =>
              onChange({
                ...value,
                timeLimitMinutes: Math.round(numericValue(event.target.value)),
              })
            }
          />
          <p className="text-xs text-muted-foreground">
            0 means unlimited. Default is {DEFAULT_BUILD_TIME_LIMIT_MINUTES}{" "}
            minutes.
          </p>
        </div>
      </div>
    </div>
  );
}
