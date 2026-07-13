"use client";

import { useEffect, useState } from "react";
import type { BuildRunPolicy, BuildSkillMode } from "@/lib/db/schema";
import {
  buildSkillModeLabel,
  buildRunPolicyLabel,
  DEFAULT_BUILD_SKILL_MODE,
  DEFAULT_BUILD_TIME_LIMIT_MINUTES,
} from "@/lib/orchestrator/build-policy";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import { usesBuildBudgetControls } from "@/lib/client/native-build-policy";

const POLICIES: Array<{
  value: BuildRunPolicy;
  description: string;
}> = [
  {
    value: "finish",
    description: "Continues until completed, blocked, or explicitly stopped.",
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

const SKILL_MODES: Array<{
  value: BuildSkillMode;
  description: string;
}> = [
  {
    value: "fast",
    description: "Use compact overlays and light evidence gates.",
  },
  {
    value: "balanced",
    description: "Route skills by phase and task with default review discipline.",
  },
  {
    value: "strict",
    description: "Use strict TDD, worktree guidance, and stronger review gates.",
  },
  {
    value: "safe",
    description: "Keep security and trust-boundary checks active for runner work.",
  },
];

export interface BuildRunPolicyValue {
  runPolicy: BuildRunPolicy;
  skillMode: BuildSkillMode;
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
  const [budgetUsdInput, setBudgetUsdInput] = useState(() =>
    String(value.budgetUsd)
  );
  const [timeLimitMinutesInput, setTimeLimitMinutesInput] = useState(() =>
    String(value.timeLimitMinutes)
  );

  useEffect(() => {
    setBudgetUsdInput(String(value.budgetUsd));
  }, [value.budgetUsd]);

  useEffect(() => {
    setTimeLimitMinutesInput(String(value.timeLimitMinutes));
  }, [value.timeLimitMinutes]);

  const commitBudgetUsd = () => {
    const budgetUsd = numericValue(budgetUsdInput);
    setBudgetUsdInput(String(budgetUsd));
    onChange({ ...value, budgetUsd });
  };

  const commitTimeLimitMinutes = () => {
    const timeLimitMinutes = Math.round(numericValue(timeLimitMinutesInput));
    setTimeLimitMinutesInput(String(timeLimitMinutes));
    onChange({ ...value, timeLimitMinutes });
  };

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

      <div className="space-y-2">
        <Label>Skill mode</Label>
        <div className="grid gap-2 md:grid-cols-4">
          {SKILL_MODES.map((mode) => {
            const selected =
              (value.skillMode ?? DEFAULT_BUILD_SKILL_MODE) === mode.value;
            return (
              <button
                key={mode.value}
                type="button"
                disabled={disabled}
                onClick={() => onChange({ ...value, skillMode: mode.value })}
                className={cn(
                  "rounded-lg border px-3 py-3 text-left text-sm transition-colors disabled:cursor-not-allowed disabled:opacity-60",
                  selected
                    ? "border-primary bg-primary/5 ring-2 ring-primary"
                    : "border-border hover:bg-accent"
                )}
              >
                <div className="font-medium">{buildSkillModeLabel(mode.value)}</div>
                <p className="mt-1 text-xs text-muted-foreground">
                  {mode.description}
                </p>
              </button>
            );
          })}
        </div>
      </div>

      {usesBuildBudgetControls(value.runPolicy) && (
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="build-budget-usd">USD budget</Label>
            <Input
              id="build-budget-usd"
              type="number"
              inputMode="decimal"
              min={0}
              step="0.01"
              disabled={disabled}
              value={budgetUsdInput}
              onChange={(event) => setBudgetUsdInput(event.target.value)}
              onBlur={commitBudgetUsd}
            />
            <p className="text-xs text-muted-foreground">0 means unlimited.</p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="build-time-minutes">Time budget, minutes</Label>
            <Input
              id="build-time-minutes"
              type="number"
              inputMode="numeric"
              min={0}
              step="1"
              disabled={disabled}
              value={timeLimitMinutesInput}
              onChange={(event) => setTimeLimitMinutesInput(event.target.value)}
              onBlur={commitTimeLimitMinutes}
            />
            <p className="text-xs text-muted-foreground">
              0 means unlimited. Default is {DEFAULT_BUILD_TIME_LIMIT_MINUTES}{" "}
              minutes.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
