"use client";

import React, { useEffect, useState } from "react";
import type { BuildRunPolicy, BuildSkillMode } from "@/lib/db/schema";
import {
  buildSkillModeLabel,
  buildRunPolicyLabel,
  DEFAULT_BUILD_SKILL_MODE,
  DEFAULT_BUILD_TIME_LIMIT_MINUTES,
} from "@/lib/orchestrator/build-policy";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
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
  alwaysRequireIndependentVerifier: boolean;
  evidenceGatedPlanning?: boolean;
  answerReview?: boolean;
  specCopy?: boolean;
  handoffFiles?: "commit" | "export_only";
}

interface BuildRunPolicyControlProps {
  value: BuildRunPolicyValue;
  onChange: (value: BuildRunPolicyValue) => void;
  disabled?: boolean;
  planningOptionsLocked?: boolean;
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
  planningOptionsLocked = false,
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

      <div className="flex items-start justify-between gap-4 rounded-lg border bg-muted/20 p-4">
        <div className="space-y-1">
          <Label htmlFor="build-always-independent-verifier">
            Always run independent verification
          </Label>
          <p className="text-xs text-muted-foreground">
            High-risk builds always require an independent verifier. Enable this
            to verify low-risk builds too.
          </p>
        </div>
        <Switch
          id="build-always-independent-verifier"
          checked={value.alwaysRequireIndependentVerifier}
          disabled={disabled}
          onCheckedChange={(alwaysRequireIndependentVerifier) =>
            onChange({ ...value, alwaysRequireIndependentVerifier })
          }
          aria-label="Always run independent verification"
        />
      </div>

      {planningOptionsLocked ? <p className="rounded border p-3 text-xs text-muted-foreground">This run uses its recorded planning options. See the planning panel for the runner&apos;s saved policy, specification-copy and handoff settings.</p> : <fieldset className="space-y-3 rounded-lg border p-3" disabled={disabled}>
        <div className="flex items-center justify-between gap-3">
          <Label htmlFor="build-evidence-planning">Evidence-gated planning</Label>
          <Switch id="build-evidence-planning" checked={value.evidenceGatedPlanning === true} onCheckedChange={(checked) => onChange({ ...value, evidenceGatedPlanning: checked })} />
        </div>
        <p className="text-xs text-muted-foreground">Approve a specification, inspect the independently reviewed plan, then explicitly start execution. Attaching a document does not enable this option.</p>
        {planningOptionsLocked && <p className="text-xs">This run uses its saved planning policy and options. Start a new run to choose different options.</p>}
        {value.evidenceGatedPlanning && <>
          <div className="flex items-center justify-between gap-3">
            <Label htmlFor="build-answer-review">Review answers independently</Label>
            <Switch id="build-answer-review" checked={value.answerReview === true} onCheckedChange={(checked) => onChange({ ...value, answerReview: checked })} />
          </div>
          <p className="text-xs text-muted-foreground">Optional extra review if the request produces an answer rather than a build. May add model calls; choose before the run starts.</p>
          <div className="flex items-center justify-between gap-3">
            <Label htmlFor="build-spec-copy">Save approved specification in project</Label>
            <Switch id="build-spec-copy" checked={value.specCopy !== false} disabled={disabled || planningOptionsLocked || value.handoffFiles === "export_only"} onCheckedChange={(checked) => onChange({ ...value, specCopy: checked })} />
          </div>
          <p className="text-xs text-muted-foreground">Copies the exact approved text into Git when handoff files are saved to the project.</p>
          <Label htmlFor="build-handoff-files">Handoff files</Label>
          <select id="build-handoff-files" className="w-full rounded border bg-background p-2 text-sm" value={value.handoffFiles ?? "commit"} onChange={(event) => onChange({ ...value, handoffFiles: event.target.value as "commit" | "export_only" })}>
            <option value="commit">Save to project</option><option value="export_only">Export only</option>
          </select>
          <p className="text-xs text-muted-foreground">Save to project records state at build stops. Export only writes no handoff files or specification copy; implementation files are still written.</p>
          <p className="text-xs text-muted-foreground">Changes beyond task scope block acceptance for Architect resolution. Secret and key files are refused, with secrets redacted from the reason.</p>
        </>}
      </fieldset>}

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
