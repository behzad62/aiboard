# Build Mode Run Policy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Redesign Build mode so it runs toward completion with USD/time guardrails, resumable checkpoints, compact Build activity, aggregate model usage stats, safer failure recovery, and batched safe tool actions.

**Architecture:** Keep Build orchestration browser-side. Add Build-specific persisted settings/checkpoints, pure helper modules for policy, budget, usage, progress, and tool batching, then wire those helpers into `lib/client/build-engine.ts` and the existing discussion page. UI changes stay client-only and render Build mode as an operational dashboard instead of a full transcript by default.

**Tech Stack:** Next.js 15 static export, React 19, TypeScript strict, browser-side Build engine, local runner HTTP bridge, existing `tsx` script tests, existing Tailwind/Radix UI components.

---

## Scope Check

The approved spec covers one coherent subsystem: Build mode runtime behavior and presentation. It touches persistence, dashboard controls, the Build engine, activity UI, and tool scheduling, but each task below leaves the app in a buildable state and is testable without requiring the full redesign to land at once.

## File Structure

- Create: `lib/orchestrator/build-policy.ts` - pure Build policy/default/guardrail helpers.
- Create: `lib/client/build-usage.ts` - aggregate per-model token and USD usage helpers for Build mode.
- Create: `lib/orchestrator/build-progress.ts` - pure no-progress fingerprint and stop-decision helpers.
- Create: `lib/orchestrator/build-tool-scheduler.ts` - pure action classification, batch planning, and result-packing helpers.
- Modify: `lib/db/schema.ts` - add Build policy, stop reason, checkpoint, and usage types.
- Modify: `lib/client/store.ts` - persist Build checkpoints and normalize older stores.
- Modify: `lib/client/api.ts` - accept/update Build policy settings and preserve checkpoints on resume.
- Modify: `lib/orchestrator/config.ts` - remove Build worker-call budget labels and expose Build wave/task constants.
- Modify: `lib/orchestrator/build.ts` - parse multiple tool actions and update prompts away from one-action-only wording.
- Modify: `lib/orchestrator/engine.ts` - extend `OrchestratorEvent` with Build usage, checkpoint, batch tool, and stop events.
- Modify: `lib/client/build-engine.ts` - remove worker-call stopping, enforce USD/time guardrails, persist checkpoints, track progress, and execute scheduled tool batches.
- Create: `components/BuildRunPolicyControl.tsx` - Build-specific run policy and budget inputs for dashboard/session settings.
- Create: `components/BuildRunStats.tsx` - top Build stats segment with compact per-model token/USD usage.
- Create: `components/BuildTranscriptPanel.tsx` - collapsed raw transcript for Build mode.
- Modify: `components/DashboardPage.tsx` - replace Build effort control with Build policy/budget guardrails.
- Modify: `components/DiscussionSessionSettings.tsx` - allow Build policy/budget edits before resume.
- Modify: `components/DetailControl.tsx` - label Build detail as Handoff detail.
- Modify: `components/DiscussionDiagnostics.tsx` - hide per-entry token usage by default for Build mode and keep aggregate log count.
- Modify: `app/discussion/discussion-client.tsx` - render Build stats, compact activity, collapsed transcript, stop reasons, and checkpoint/resume state.
- Create: `scripts/test-build-run-policy.mts` - policy/default/guardrail tests.
- Create: `scripts/test-build-usage.mts` - compact token and USD aggregation tests.
- Create: `scripts/test-build-progress.mts` - progress/no-progress fingerprint tests.
- Create: `scripts/test-build-tool-scheduler.mts` - batch parsing/classification/result-packing tests.
- Modify: `scripts/test-tool-call-validation.mts` - update old single-tool expectations to batch-aware expectations.
- Modify: `scripts/test-github-workflow.mts` - remove assumptions that normal command budget is a Build job budget.
- Modify: `scripts/test-build-prompts.mts` - update prompt assertions from "ONE JSON action" to "one or more scheduled JSON actions".

---

## Task 1: Build Policy Types, Defaults, And Checkpoint Store

**Files:**
- Create: `lib/orchestrator/build-policy.ts`
- Modify: `lib/db/schema.ts`
- Modify: `lib/client/store.ts`
- Modify: `lib/client/api.ts`
- Create: `scripts/test-build-run-policy.mts`

- [ ] **Step 1: Write the failing Build policy helper test**

Create `scripts/test-build-run-policy.mts`:

```ts
/** Build run policy checks (run: npx tsx scripts/test-build-run-policy.mts) */
import {
  DEFAULT_BUILD_TIME_LIMIT_MINUTES,
  isBuildBudgetUnlimited,
  normalizeBuildSettings,
  shouldStopForBuildGuardrail,
} from "../lib/orchestrator/build-policy";

let failed = 0;
const check = (name: string, ok: boolean, detail?: unknown) => {
  console.log(`${ok ? "PASS" : "FAIL"} - ${name}${ok ? "" : ` -> ${JSON.stringify(detail)}`}`);
  if (!ok) failed++;
};

const defaults = normalizeBuildSettings({});
check("default policy is finish", defaults.runPolicy === "finish", defaults);
check("default USD budget is unlimited", defaults.budgetUsd === 0, defaults);
check("default time limit is 2 hours", defaults.timeLimitMinutes === DEFAULT_BUILD_TIME_LIMIT_MINUTES, defaults);

const clamped = normalizeBuildSettings({
  buildRunPolicy: "not-real",
  buildBudgetUsd: -4,
  buildTimeLimitMinutes: -30,
});
check("invalid policy falls back to finish", clamped.runPolicy === "finish", clamped);
check("negative USD budget is unlimited", clamped.budgetUsd === 0, clamped);
check("negative time limit is unlimited", clamped.timeLimitMinutes === 0, clamped);
check("zero budget is unlimited", isBuildBudgetUnlimited(0), clamped);

const noStop = shouldStopForBuildGuardrail({
  settings: normalizeBuildSettings({ buildBudgetUsd: 0, buildTimeLimitMinutes: 0 }),
  spentUsd: 999,
  elapsedMs: 24 * 60 * 60 * 1000,
});
check("both zero limits do not stop", noStop === null, noStop);

const moneyStop = shouldStopForBuildGuardrail({
  settings: normalizeBuildSettings({ buildBudgetUsd: 2.5, buildTimeLimitMinutes: 0 }),
  spentUsd: 2.51,
  elapsedMs: 1,
});
check("USD budget stops at threshold", moneyStop === "budget", moneyStop);

const timeStop = shouldStopForBuildGuardrail({
  settings: normalizeBuildSettings({ buildBudgetUsd: 0, buildTimeLimitMinutes: 120 }),
  spentUsd: 0,
  elapsedMs: 121 * 60 * 1000,
});
check("time budget stops at threshold", timeStop === "time", timeStop);

process.exit(failed === 0 ? 0 : 1);
```

- [ ] **Step 2: Run the failing test**

Run: `npx tsx scripts/test-build-run-policy.mts`

Expected: FAIL because `lib/orchestrator/build-policy.ts` does not exist.

- [ ] **Step 3: Add Build policy and checkpoint schema types**

Modify `lib/db/schema.ts`:

```ts
export type BuildRunPolicy = "finish" | "budgeted" | "plan_only";
export type BuildStopReason = "budget" | "time" | "blocked" | "user" | "completed";

export interface BuildUsageModelTotal {
  modelId: string;
  modelName: string;
  providerId: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  estimatedUsd: number | null;
  priced: boolean;
}

export interface BuildUsageWindow {
  startedAt: string;
  elapsedMs: number;
  estimatedUsd: number;
  unknownPricedModelIds: string[];
  models: BuildUsageModelTotal[];
}

export interface BuildCheckpointTask {
  id: string;
  title: string;
  instructions: string;
  contextFiles: string[];
  outputPaths?: string[];
  expectedOutputs?: string;
  status: "planned" | "in_progress" | "review" | "fixing" | "done" | "failed";
  dependsOn?: string[];
  assignTo?: string;
  workerIndex?: number;
  failCount?: number;
  retryAfterMs?: number;
  difficulty?: number;
}

export interface BuildCheckpoint {
  discussionId: string;
  status: "running" | "stopped" | "blocked" | "completed";
  updatedAt: string;
  runPolicy: BuildRunPolicy;
  stopReason?: BuildStopReason | null;
  wave: number;
  tasks: BuildCheckpointTask[];
  architectNotes: string;
  verifyCommand: string;
  branch: string | null;
  prUrl: string | null;
  milestone: string | null;
  issueNumbers: number[];
  failureFingerprints: Record<string, number>;
  recoveryLog: string[];
  usageWindow: BuildUsageWindow;
}
```

Add optional fields to `Discussion`:

```ts
buildRunPolicy?: BuildRunPolicy;
buildBudgetUsd?: number;
buildTimeLimitMinutes?: number;
buildStopReason?: BuildStopReason | null;
buildStoppedAt?: string | null;
```

Add optional fields to `UserSettings`:

```ts
defaultBuildRunPolicy?: BuildRunPolicy;
defaultBuildBudgetUsd?: number;
defaultBuildTimeLimitMinutes?: number;
```

- [ ] **Step 4: Add Build policy helper implementation**

Create `lib/orchestrator/build-policy.ts`:

```ts
import type { BuildRunPolicy, BuildStopReason, Discussion } from "@/lib/db/schema";

export const DEFAULT_BUILD_RUN_POLICY: BuildRunPolicy = "finish";
export const DEFAULT_BUILD_BUDGET_USD = 0;
export const DEFAULT_BUILD_TIME_LIMIT_MINUTES = 120;

export interface NormalizedBuildSettings {
  runPolicy: BuildRunPolicy;
  budgetUsd: number;
  timeLimitMinutes: number;
}

const RUN_POLICIES = new Set<BuildRunPolicy>(["finish", "budgeted", "plan_only"]);

function coerceNonNegativeNumber(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(0, value);
}

export function normalizeBuildSettings(
  input: Partial<Pick<Discussion, "buildRunPolicy" | "buildBudgetUsd" | "buildTimeLimitMinutes">>
): NormalizedBuildSettings {
  const requested = input.buildRunPolicy;
  const runPolicy =
    requested && RUN_POLICIES.has(requested) ? requested : DEFAULT_BUILD_RUN_POLICY;
  return {
    runPolicy,
    budgetUsd: coerceNonNegativeNumber(input.buildBudgetUsd, DEFAULT_BUILD_BUDGET_USD),
    timeLimitMinutes: coerceNonNegativeNumber(
      input.buildTimeLimitMinutes,
      DEFAULT_BUILD_TIME_LIMIT_MINUTES
    ),
  };
}

export function isBuildBudgetUnlimited(value: number): boolean {
  return value <= 0;
}

export function isBuildTimeUnlimited(minutes: number): boolean {
  return minutes <= 0;
}

export function shouldStopForBuildGuardrail(input: {
  settings: NormalizedBuildSettings;
  spentUsd: number;
  elapsedMs: number;
}): BuildStopReason | null {
  if (
    !isBuildBudgetUnlimited(input.settings.budgetUsd) &&
    input.spentUsd >= input.settings.budgetUsd
  ) {
    return "budget";
  }
  if (
    !isBuildTimeUnlimited(input.settings.timeLimitMinutes) &&
    input.elapsedMs >= input.settings.timeLimitMinutes * 60_000
  ) {
    return "time";
  }
  return null;
}

export function buildRunPolicyLabel(policy: BuildRunPolicy): string {
  switch (policy) {
    case "finish":
      return "Finish job";
    case "budgeted":
      return "Budgeted run";
    case "plan_only":
      return "Plan only";
  }
}
```

- [ ] **Step 5: Persist Build checkpoints in the client store**

Modify `lib/client/store.ts` imports and `ClientStore`:

```ts
import type {
  BuildCheckpoint,
  BuildFileRecord,
  CustomModel,
  Discussion,
  FinalResult,
  Message,
  ModelBuildStat,
  ProviderKey,
  UserSettings,
} from "@/lib/db/schema";

export interface ClientStore {
  userSettings: UserSettings;
  providerKeys: ProviderKey[];
  customModels: CustomModel[];
  discussions: Discussion[];
  messages: Message[];
  finalResults: FinalResult[];
  attachments: AttachmentRecord[];
  buildFiles: BuildFileRecord[];
  buildCheckpoints: BuildCheckpoint[];
  modelStats: ModelBuildStat[];
}
```

Add `buildCheckpoints: []` to `DEFAULT_STORE`.

Add store functions:

```ts
export function getBuildCheckpoint(discussionId: string): BuildCheckpoint | undefined {
  return store().buildCheckpoints?.find((c) => c.discussionId === discussionId);
}

export function upsertBuildCheckpoint(checkpoint: BuildCheckpoint): void {
  const s = store();
  if (!s.buildCheckpoints) s.buildCheckpoints = [];
  const i = s.buildCheckpoints.findIndex((c) => c.discussionId === checkpoint.discussionId);
  if (i >= 0) s.buildCheckpoints[i] = checkpoint;
  else s.buildCheckpoints.push(checkpoint);
  schedulePersist();
}

export function deleteBuildCheckpoint(discussionId: string): void {
  const s = store();
  s.buildCheckpoints = (s.buildCheckpoints ?? []).filter(
    (c) => c.discussionId !== discussionId
  );
  schedulePersist();
}
```

Update `deleteDiscussion` and `clearDiscussionRun`:

```ts
s.buildCheckpoints = (s.buildCheckpoints ?? []).filter((c) => c.discussionId !== id);
```

For `clearDiscussionRun`, delete the checkpoint because restart is from scratch. Do not delete it in `continueDiscussion`.

- [ ] **Step 6: Add API input fields and resume-safe updates**

Modify `lib/client/api.ts`.

Extend `DiscussionConfigInput`:

```ts
buildRunPolicy?: BuildRunPolicy;
buildBudgetUsd?: number;
buildTimeLimitMinutes?: number;
```

Extend `CreateDiscussionInput` with the same three fields.

In `createDiscussion`, load Build defaults:

```ts
const buildSettings = normalizeBuildSettings({
  buildRunPolicy:
    input.buildRunPolicy ?? settings.defaultBuildRunPolicy ?? "finish",
  buildBudgetUsd:
    input.buildBudgetUsd ?? settings.defaultBuildBudgetUsd ?? 0,
  buildTimeLimitMinutes:
    input.buildTimeLimitMinutes ?? settings.defaultBuildTimeLimitMinutes ?? 120,
});
```

Set fields on the inserted discussion:

```ts
buildRunPolicy: input.mode === "build" ? buildSettings.runPolicy : undefined,
buildBudgetUsd: input.mode === "build" ? buildSettings.budgetUsd : undefined,
buildTimeLimitMinutes:
  input.mode === "build" ? buildSettings.timeLimitMinutes : undefined,
buildStopReason: null,
buildStoppedAt: null,
```

In `updateDiscussionConfig`, only set Build fields when `discussion.mode === "build"`:

```ts
const nextBuildSettings = normalizeBuildSettings({
  buildRunPolicy: input.buildRunPolicy ?? discussion.buildRunPolicy,
  buildBudgetUsd: input.buildBudgetUsd ?? discussion.buildBudgetUsd,
  buildTimeLimitMinutes:
    input.buildTimeLimitMinutes ?? discussion.buildTimeLimitMinutes,
});

if (discussion.mode === "build") {
  patch.buildRunPolicy = nextBuildSettings.runPolicy;
  patch.buildBudgetUsd = nextBuildSettings.budgetUsd;
  patch.buildTimeLimitMinutes = nextBuildSettings.timeLimitMinutes;
}
```

In `continueDiscussion`, reset only the active budget stop fields:

```ts
updateDiscussion(id, {
  status: "pending",
  buildStopReason: null,
  buildStoppedAt: null,
  updatedAt: new Date().toISOString(),
});
```

- [ ] **Step 7: Run the policy test**

Run: `npx tsx scripts/test-build-run-policy.mts`

Expected: PASS.

- [ ] **Step 8: Commit Task 1**

```bash
git add lib/db/schema.ts lib/client/store.ts lib/client/api.ts lib/orchestrator/build-policy.ts scripts/test-build-run-policy.mts
git commit -m "feat: add build run policy persistence"
```

---

## Task 2: Build Usage And Dollar Accounting Helpers

**Files:**
- Create: `lib/client/build-usage.ts`
- Modify: `lib/client/token-usage.ts`
- Create: `scripts/test-build-usage.mts`

- [ ] **Step 1: Write the failing usage aggregation test**

Create `scripts/test-build-usage.mts`:

```ts
/** Build usage aggregation checks (run: npx tsx scripts/test-build-usage.mts) */
import {
  addBuildUsageCall,
  createBuildUsageWindow,
  estimatedUsdForTokens,
} from "../lib/client/build-usage";
import { formatTokenCount } from "../lib/client/token-usage";

let failed = 0;
const check = (name: string, ok: boolean, detail?: unknown) => {
  console.log(`${ok ? "PASS" : "FAIL"} - ${name}${ok ? "" : ` -> ${JSON.stringify(detail)}`}`);
  if (!ok) failed++;
};

check("formats thousands compactly", formatTokenCount(18_734) === "18.7k");
check("formats millions compactly", formatTokenCount(1_234_567) === "1.2M");

const usd = estimatedUsdForTokens({
  inputTokens: 500_000,
  outputTokens: 100_000,
  pricing: { inputUsdPer1M: 2, outputUsdPer1M: 10 },
});
check("calculates blended token USD", Math.abs(usd - 2) < 0.000001, usd);

let window = createBuildUsageWindow("2026-06-21T00:00:00.000Z");
window = addBuildUsageCall(window, {
  modelId: "google:gemini-3.5-flash",
  modelName: "Gemini 3.5 Flash",
  providerId: "google",
  inputTokens: 18_000,
  outputTokens: 700,
  pricing: { inputUsdPer1M: 1.5, outputUsdPer1M: 9 },
  elapsedMs: 5_000,
});
window = addBuildUsageCall(window, {
  modelId: "custom:local",
  modelName: "Local",
  providerId: "custom",
  inputTokens: 1000,
  outputTokens: 100,
  pricing: null,
  elapsedMs: 10_000,
});

const gemini = window.models.find((m) => m.modelId === "google:gemini-3.5-flash");
const local = window.models.find((m) => m.modelId === "custom:local");

check("aggregates calls by model", gemini?.calls === 1 && gemini.totalTokens === 18_700, window);
check("tracks unknown priced model ids", window.unknownPricedModelIds.includes("custom:local"), window);
check("unknown priced model has null USD", local?.estimatedUsd === null, local);
check("window elapsed tracks latest event", window.elapsedMs === 10_000, window);

process.exit(failed === 0 ? 0 : 1);
```

- [ ] **Step 2: Run the failing test**

Run: `npx tsx scripts/test-build-usage.mts`

Expected: FAIL because `lib/client/build-usage.ts` does not exist.

- [ ] **Step 3: Add usage helper implementation**

Create `lib/client/build-usage.ts`:

```ts
import type { BuildUsageWindow, BuildUsageModelTotal } from "@/lib/db/schema";
import type { ModelPricing } from "@/lib/providers/pricing";

export interface TokenPricingInput {
  inputTokens: number;
  outputTokens: number;
  pricing: Pick<ModelPricing, "inputUsdPer1M" | "outputUsdPer1M">;
}

export function estimatedUsdForTokens(input: TokenPricingInput): number {
  return (
    (input.inputTokens * input.pricing.inputUsdPer1M +
      input.outputTokens * input.pricing.outputUsdPer1M) /
    1_000_000
  );
}

export function createBuildUsageWindow(startedAt: string): BuildUsageWindow {
  return {
    startedAt,
    elapsedMs: 0,
    estimatedUsd: 0,
    unknownPricedModelIds: [],
    models: [],
  };
}

export function addBuildUsageCall(
  window: BuildUsageWindow,
  input: {
    modelId: string;
    modelName: string;
    providerId: string;
    inputTokens: number;
    outputTokens: number;
    pricing: Pick<ModelPricing, "inputUsdPer1M" | "outputUsdPer1M"> | null;
    elapsedMs: number;
  }
): BuildUsageWindow {
  const totalTokens = input.inputTokens + input.outputTokens;
  const callUsd = input.pricing
    ? estimatedUsdForTokens({
        inputTokens: input.inputTokens,
        outputTokens: input.outputTokens,
        pricing: input.pricing,
      })
    : null;
  const models = window.models.map((m) => ({ ...m }));
  let model = models.find((m) => m.modelId === input.modelId);
  if (!model) {
    model = {
      modelId: input.modelId,
      modelName: input.modelName,
      providerId: input.providerId,
      calls: 0,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      estimatedUsd: input.pricing ? 0 : null,
      priced: !!input.pricing,
    } satisfies BuildUsageModelTotal;
    models.push(model);
  }
  model.calls += 1;
  model.inputTokens += input.inputTokens;
  model.outputTokens += input.outputTokens;
  model.totalTokens += totalTokens;
  model.priced = model.priced && !!input.pricing;
  model.estimatedUsd =
    model.estimatedUsd == null || callUsd == null
      ? null
      : model.estimatedUsd + callUsd;

  const unknownPricedModelIds = new Set(window.unknownPricedModelIds);
  if (!input.pricing) unknownPricedModelIds.add(input.modelId);

  return {
    startedAt: window.startedAt,
    elapsedMs: Math.max(window.elapsedMs, input.elapsedMs),
    estimatedUsd:
      window.estimatedUsd + (callUsd == null ? 0 : callUsd),
    unknownPricedModelIds: [...unknownPricedModelIds].sort(),
    models,
  };
}
```

- [ ] **Step 4: Tighten compact token formatting**

Modify `lib/client/token-usage.ts` so `formatTokenCount` returns lowercase `k` and uppercase `M`, and trims trailing `.0` for values below 10 only when appropriate:

```ts
export function formatTokenCount(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}k`;
  return String(tokens);
}
```

This matches the current behavior and locks it with a test.

- [ ] **Step 5: Run the usage test**

Run: `npx tsx scripts/test-build-usage.mts`

Expected: PASS.

- [ ] **Step 6: Commit Task 2**

```bash
git add lib/client/build-usage.ts lib/client/token-usage.ts scripts/test-build-usage.mts
git commit -m "feat: add build usage accounting helpers"
```

---

## Task 3: Build-Specific Dashboard And Session Settings

**Files:**
- Create: `components/BuildRunPolicyControl.tsx`
- Modify: `components/DashboardPage.tsx`
- Modify: `components/DiscussionSessionSettings.tsx`
- Modify: `components/DetailControl.tsx`
- Modify: `lib/orchestrator/config.ts`
- Modify: `scripts/test-build-run-policy.mts`

- [ ] **Step 1: Add policy option labels to the policy test**

Extend `scripts/test-build-run-policy.mts`:

```ts
import { buildRunPolicyLabel } from "../lib/orchestrator/build-policy";

check("finish label is user-facing", buildRunPolicyLabel("finish") === "Finish job");
check("budgeted label is user-facing", buildRunPolicyLabel("budgeted") === "Budgeted run");
check("plan_only label is user-facing", buildRunPolicyLabel("plan_only") === "Plan only");
```

- [ ] **Step 2: Run the policy test**

Run: `npx tsx scripts/test-build-run-policy.mts`

Expected: PASS after Task 1, because `buildRunPolicyLabel` already exists.

- [ ] **Step 3: Remove Build budget language from effort config**

Modify `lib/orchestrator/config.ts`:

```ts
export const BUILD_TASKS_PER_WAVE = 8;
export const BUILD_MAX_WAVES = 50;
export const BUILD_NO_PROGRESS_WAVES = 4;
```

Keep `BUILD_LIMITS` only for compatibility with existing stored discussions until the engine task removes its stopping use. Change `getBuildEffortLabel` so it no longer mentions worker calls:

```ts
export function getBuildEffortLabel(effort: EffortLevel): string {
  const config = EFFORT_CONFIG[effort];
  return `${formatCompactNumber(Math.max(config.maxTokens, BUILD_ROUND_MIN_TOKENS))} worker response ceiling`;
}
```

- [ ] **Step 4: Create Build run policy control**

Create `components/BuildRunPolicyControl.tsx`:

```tsx
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
    description: "Keep working until completed, stopped, blocked, or guardrails are reached.",
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
                <div className="font-medium">{buildRunPolicyLabel(policy.value)}</div>
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
            0 means unlimited. Default is {DEFAULT_BUILD_TIME_LIMIT_MINUTES} minutes.
          </p>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 5: Wire dashboard state and creation input**

Modify `components/DashboardPage.tsx` imports:

```ts
import { BuildRunPolicyControl } from "@/components/BuildRunPolicyControl";
import type { BuildRunPolicy } from "@/lib/db/schema";
import {
  DEFAULT_BUILD_BUDGET_USD,
  DEFAULT_BUILD_RUN_POLICY,
  DEFAULT_BUILD_TIME_LIMIT_MINUTES,
} from "@/lib/orchestrator/build-policy";
```

Add state:

```ts
const [buildRunPolicy, setBuildRunPolicy] =
  useState<BuildRunPolicy>(DEFAULT_BUILD_RUN_POLICY);
const [buildBudgetUsd, setBuildBudgetUsd] =
  useState(DEFAULT_BUILD_BUDGET_USD);
const [buildTimeLimitMinutes, setBuildTimeLimitMinutes] =
  useState(DEFAULT_BUILD_TIME_LIMIT_MINUTES);
```

When loading settings:

```ts
setBuildRunPolicy(d.settings.defaultBuildRunPolicy ?? DEFAULT_BUILD_RUN_POLICY);
setBuildBudgetUsd(d.settings.defaultBuildBudgetUsd ?? DEFAULT_BUILD_BUDGET_USD);
setBuildTimeLimitMinutes(
  d.settings.defaultBuildTimeLimitMinutes ?? DEFAULT_BUILD_TIME_LIMIT_MINUTES
);
```

Replace the existing Build `EffortSlider` render:

```tsx
{mode === "build" ? (
  <BuildRunPolicyControl
    value={{
      runPolicy: buildRunPolicy,
      budgetUsd: buildBudgetUsd,
      timeLimitMinutes: buildTimeLimitMinutes,
    }}
    onChange={(next) => {
      setBuildRunPolicy(next.runPolicy);
      setBuildBudgetUsd(next.budgetUsd);
      setBuildTimeLimitMinutes(next.timeLimitMinutes);
    }}
  />
) : (
  <EffortSlider value={effort} onChange={setEffort} mode={mode} />
)}
```

In `createDiscussion`, send internal high effort for Build mode and Build fields:

```ts
effort: mode === "build" ? "high" : effort,
buildRunPolicy: mode === "build" ? buildRunPolicy : undefined,
buildBudgetUsd: mode === "build" ? buildBudgetUsd : undefined,
buildTimeLimitMinutes: mode === "build" ? buildTimeLimitMinutes : undefined,
```

- [ ] **Step 6: Wire session settings for resume**

Modify `components/DiscussionSessionSettings.tsx`:

```ts
import { BuildRunPolicyControl } from "@/components/BuildRunPolicyControl";
import type { BuildRunPolicy } from "@/lib/db/schema";
import {
  DEFAULT_BUILD_BUDGET_USD,
  DEFAULT_BUILD_RUN_POLICY,
  DEFAULT_BUILD_TIME_LIMIT_MINUTES,
} from "@/lib/orchestrator/build-policy";
```

Extend `DiscussionSessionSettingsValue`:

```ts
buildRunPolicy?: BuildRunPolicy;
buildBudgetUsd?: number;
buildTimeLimitMinutes?: number;
```

Add state initialized from `discussion`:

```ts
const [buildRunPolicy, setBuildRunPolicy] = useState<BuildRunPolicy>(
  discussion.buildRunPolicy ?? DEFAULT_BUILD_RUN_POLICY
);
const [buildBudgetUsd, setBuildBudgetUsd] = useState(
  discussion.buildBudgetUsd ?? DEFAULT_BUILD_BUDGET_USD
);
const [buildTimeLimitMinutes, setBuildTimeLimitMinutes] = useState(
  discussion.buildTimeLimitMinutes ?? DEFAULT_BUILD_TIME_LIMIT_MINUTES
);
```

Update the existing `useEffect` to reset these three values from `discussion`.

Replace `EffortSlider` with:

```tsx
{discussion.mode === "build" ? (
  <BuildRunPolicyControl
    value={{
      runPolicy: buildRunPolicy,
      budgetUsd: buildBudgetUsd,
      timeLimitMinutes: buildTimeLimitMinutes,
    }}
    onChange={(next) => {
      setBuildRunPolicy(next.runPolicy);
      setBuildBudgetUsd(next.budgetUsd);
      setBuildTimeLimitMinutes(next.timeLimitMinutes);
    }}
    disabled={!canEdit || busy}
  />
) : (
  <EffortSlider value={effort} onChange={setEffort} mode={discussion.mode} />
)}
```

In `save`, include:

```ts
buildRunPolicy: discussion.mode === "build" ? buildRunPolicy : undefined,
buildBudgetUsd: discussion.mode === "build" ? buildBudgetUsd : undefined,
buildTimeLimitMinutes:
  discussion.mode === "build" ? buildTimeLimitMinutes : undefined,
```

- [ ] **Step 7: Rename Build detail label**

Modify `components/DetailControl.tsx` so the label and helper text depend on `mode`:

```tsx
<Label>{mode === "build" ? "Handoff detail" : "Answer detail"}</Label>
```

Keep the same `verbosity` field. Update the Build helper text to say it shapes worker notes and final handoff, not files produced.

- [ ] **Step 8: Run focused checks**

Run:

```bash
npx tsx scripts/test-build-run-policy.mts
npx tsc --noEmit
```

Expected: both pass.

- [ ] **Step 9: Commit Task 3**

```bash
git add components/BuildRunPolicyControl.tsx components/DashboardPage.tsx components/DiscussionSessionSettings.tsx components/DetailControl.tsx lib/orchestrator/config.ts scripts/test-build-run-policy.mts
git commit -m "feat: add build run policy controls"
```

---

## Task 4: Aggregate Build Stats And Compact Activity UI

**Files:**
- Create: `components/BuildRunStats.tsx`
- Create: `components/BuildTranscriptPanel.tsx`
- Modify: `components/DiscussionDiagnostics.tsx`
- Modify: `app/discussion/discussion-client.tsx`
- Modify: `lib/orchestrator/engine.ts`
- Modify: `scripts/test-build-usage.mts`

- [ ] **Step 1: Extend usage test for stat-ready model rows**

Add to `scripts/test-build-usage.mts`:

```ts
check("window estimated USD accumulates only priced calls", window.estimatedUsd > 0, window);
check("model rows preserve provider", gemini?.providerId === "google", gemini);
check("model rows include compactable total", formatTokenCount(gemini?.totalTokens ?? 0) === "18.7k", gemini);
```

- [ ] **Step 2: Add Build usage event type**

Modify `lib/orchestrator/engine.ts` event union:

```ts
import type { BuildStopReason, BuildUsageWindow } from "../db/schema";
```

Add:

```ts
| {
    type: "build_usage";
    usage: BuildUsageWindow;
  }
| {
    type: "build_stopped";
    reason: BuildStopReason;
    message: string;
    usage?: BuildUsageWindow;
  }
| {
    type: "tool_batch";
    actor: string;
    served: number;
    skipped: number;
    summary: string;
  }
```

- [ ] **Step 3: Create top Build stats component**

Create `components/BuildRunStats.tsx`:

```tsx
"use client";

import type { BuildRunPolicy, BuildStopReason, BuildUsageWindow } from "@/lib/db/schema";
import { buildRunPolicyLabel } from "@/lib/orchestrator/build-policy";
import { formatTokenCount } from "@/lib/client/token-usage";

interface BuildRunStatsProps {
  status: string;
  policy: BuildRunPolicy;
  budgetUsd: number;
  timeLimitMinutes: number;
  stopReason?: BuildStopReason | null;
  branch?: string | null;
  prUrl?: string | null;
  usage?: BuildUsageWindow | null;
}

function formatUsd(value: number): string {
  if (value < 0.01) return `$${value.toFixed(3)}`;
  return `$${value.toFixed(2)}`;
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes >= 60) {
    const hours = Math.floor(minutes / 60);
    const rest = minutes % 60;
    return `${hours}h ${rest}m`;
  }
  return `${minutes}m ${seconds}s`;
}

export function BuildRunStats({
  status,
  policy,
  budgetUsd,
  timeLimitMinutes,
  stopReason,
  branch,
  prUrl,
  usage,
}: BuildRunStatsProps) {
  const totalTokens =
    usage?.models.reduce((sum, model) => sum + model.totalTokens, 0) ?? 0;
  return (
    <section className="rounded-xl border bg-card p-4 shadow-sm">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Stat label="Status" value={stopReason ? `${status} - ${stopReason}` : status} />
        <Stat label="Policy" value={buildRunPolicyLabel(policy)} />
        <Stat
          label="Budget"
          value={`${budgetUsd > 0 ? formatUsd(budgetUsd) : "unlimited"} / ${
            timeLimitMinutes > 0 ? `${timeLimitMinutes}m` : "unlimited"
          }`}
        />
        <Stat
          label="Usage"
          value={`${formatUsd(usage?.estimatedUsd ?? 0)} / ${formatDuration(
            usage?.elapsedMs ?? 0
          )}`}
        />
      </div>
      {(branch || prUrl || totalTokens > 0) && (
        <div className="mt-3 flex flex-wrap gap-2 text-xs text-muted-foreground">
          {branch && <span className="rounded border bg-muted/20 px-2 py-1">Branch: {branch}</span>}
          {prUrl && (
            <a className="rounded border bg-muted/20 px-2 py-1 underline" href={prUrl} target="_blank">
              Pull request
            </a>
          )}
          {totalTokens > 0 && (
            <span className="rounded border bg-muted/20 px-2 py-1">
              Total tokens: {formatTokenCount(totalTokens)}
            </span>
          )}
          {usage && usage.unknownPricedModelIds.length > 0 && (
            <span className="rounded border border-amber-300 bg-amber-50 px-2 py-1 text-amber-900 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-100">
              Partial USD estimate: {usage.unknownPricedModelIds.length} model(s) missing pricing
            </span>
          )}
        </div>
      )}
      {usage && usage.models.length > 0 && (
        <div className="mt-4 overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-xs text-muted-foreground">
              <tr className="border-b">
                <th className="py-2 text-left font-medium">Model</th>
                <th className="py-2 text-right font-medium">Calls</th>
                <th className="py-2 text-right font-medium">Input</th>
                <th className="py-2 text-right font-medium">Output</th>
                <th className="py-2 text-right font-medium">Total</th>
                <th className="py-2 text-right font-medium">USD</th>
              </tr>
            </thead>
            <tbody>
              {usage.models.map((model) => (
                <tr key={model.modelId} className="border-b last:border-0">
                  <td className="py-2 pr-3">{model.modelName}</td>
                  <td className="py-2 text-right tabular-nums">{model.calls}</td>
                  <td className="py-2 text-right tabular-nums">{formatTokenCount(model.inputTokens)}</td>
                  <td className="py-2 text-right tabular-nums">{formatTokenCount(model.outputTokens)}</td>
                  <td className="py-2 text-right tabular-nums">{formatTokenCount(model.totalTokens)}</td>
                  <td className="py-2 text-right tabular-nums">
                    {model.estimatedUsd == null ? "unknown" : formatUsd(model.estimatedUsd)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border bg-muted/20 px-3 py-2">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="mt-0.5 truncate font-medium">{value}</div>
    </div>
  );
}
```

- [ ] **Step 4: Create collapsed Build transcript component**

Create `components/BuildTranscriptPanel.tsx`:

```tsx
"use client";

import { useState } from "react";
import { ChevronDown, Download } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DiscussionTimeline,
  type TimelineMessage,
} from "@/components/DiscussionTimeline";
import type { ModelAccent } from "@/lib/ui/model-accent";

interface BuildTranscriptPanelProps {
  messages: TimelineMessage[];
  accentMap: Map<string, ModelAccent>;
  onDownload: () => void;
}

export function BuildTranscriptPanel({
  messages,
  accentMap,
  onDownload,
}: BuildTranscriptPanelProps) {
  const [open, setOpen] = useState(false);
  return (
    <section className="rounded-xl border bg-card shadow-sm">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left"
      >
        <span>
          <span className="font-medium">Raw transcript</span>
          <span className="ml-2 text-xs text-muted-foreground">
            {messages.length} model turn{messages.length === 1 ? "" : "s"}
          </span>
        </span>
        <ChevronDown className={open ? "h-4 w-4 rotate-180" : "h-4 w-4"} />
      </button>
      {open && (
        <div className="border-t p-4">
          <div className="mb-4 flex justify-end">
            <Button variant="outline" size="sm" onClick={onDownload}>
              <Download className="mr-1 h-3.5 w-3.5" />
              Download .md
            </Button>
          </div>
          <DiscussionTimeline
            messages={messages}
            accentMap={accentMap}
            emptyTitle="No raw model turns yet"
            emptyHint="Build progress appears in the task board and activity log."
          />
        </div>
      )}
    </section>
  );
}
```

- [ ] **Step 5: Hide per-row token usage in diagnostics**

Modify `components/DiscussionDiagnostics.tsx` props:

```ts
showEntryTokenUsage?: boolean;
```

Pass the prop into `EntriesList`. Change the token usage render to:

```tsx
{showEntryTokenUsage !== false && entry.tokenUsage && (
  <span>
    - ~{formatTokens(entry.tokenUsage.totalTokens)} tokens (
    {formatTokens(entry.tokenUsage.inputTokens)} in /{" "}
    {formatTokens(entry.tokenUsage.outputTokens)} out)
  </span>
)}
```

Use a normal hyphen separator in new code. Leave older separators untouched unless formatting the edited line.

- [ ] **Step 6: Wire Build stats and compact transcript on discussion page**

Modify `app/discussion/discussion-client.tsx`:

Add imports:

```ts
import { BuildRunStats } from "@/components/BuildRunStats";
import { BuildTranscriptPanel } from "@/components/BuildTranscriptPanel";
import type { BuildUsageWindow } from "@/lib/db/schema";
```

Add state:

```ts
const [buildUsage, setBuildUsage] = useState<BuildUsageWindow | null>(null);
```

In `handleEvent`, add cases:

```ts
case "build_usage":
  setBuildUsage(event.usage);
  break;
case "build_stopped":
  setBuildUsage(event.usage ?? null);
  setDiagnostics((prev) => {
    const next: DiagnosticEntry[] = [
      {
        id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
        at: new Date().toLocaleTimeString(),
        phase: "finished",
        message: event.message,
      },
      ...prev,
    ].slice(0, ACTIVITY_LOG_CAP);
    saveDiagnostics(id, next);
    return next;
  });
  break;
case "tool_batch":
  setDiagnostics((prev) => {
    const next: DiagnosticEntry[] = [
      {
        id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
        at: new Date().toLocaleTimeString(),
        phase: "model_streaming",
        message: `${event.actor}: ${event.summary}`,
      },
      ...prev,
    ].slice(0, ACTIVITY_LOG_CAP);
    saveDiagnostics(id, next);
    return next;
  });
  break;
```

Change the `token_usage` case:

```ts
if (discussion?.mode === "build") {
  return;
}
```

Keep existing non-Build diagnostic behavior after that guard.

Render `BuildRunStats` near the top of the activity tab when `discussion.mode === "build"`:

```tsx
{discussion.mode === "build" && (
  <BuildRunStats
    status={status}
    policy={discussion.buildRunPolicy ?? "finish"}
    budgetUsd={discussion.buildBudgetUsd ?? 0}
    timeLimitMinutes={discussion.buildTimeLimitMinutes ?? 120}
    stopReason={discussion.buildStopReason}
    branch={repoWorkflow?.pushedBranch ?? repoStatus?.currentBranch ?? null}
    prUrl={repoWorkflow?.prUrl ?? null}
    usage={buildUsage}
  />
)}
```

Replace the Build-mode transcript render:

```tsx
{discussion.mode === "build" ? (
  <BuildTranscriptPanel
    messages={messages}
    accentMap={accentMap}
    onDownload={downloadTranscript}
  />
) : (
  <DiscussionTimeline messages={messages} accentMap={accentMap} />
)}
```

Pass `showEntryTokenUsage={discussion.mode !== "build"}` to both `DiscussionDiagnostics` instances.

- [ ] **Step 7: Run checks**

Run:

```bash
npx tsx scripts/test-build-usage.mts
npx tsc --noEmit
```

Expected: both pass.

- [ ] **Step 8: Commit Task 4**

```bash
git add components/BuildRunStats.tsx components/BuildTranscriptPanel.tsx components/DiscussionDiagnostics.tsx app/discussion/discussion-client.tsx lib/orchestrator/engine.ts scripts/test-build-usage.mts
git commit -m "feat: add compact build run stats"
```

---

## Task 5: Engine Budget Guardrails And Worker-Call Limit Removal

**Files:**
- Modify: `lib/client/build-engine.ts`
- Modify: `lib/orchestrator/config.ts`
- Modify: `scripts/test-github-workflow.mts`
- Modify: `scripts/test-build-run-policy.mts`

- [ ] **Step 1: Add guardrail stop tests**

Extend `scripts/test-build-run-policy.mts`:

```ts
const finishWithBudget = shouldStopForBuildGuardrail({
  settings: normalizeBuildSettings({
    buildRunPolicy: "finish",
    buildBudgetUsd: 1,
    buildTimeLimitMinutes: 0,
  }),
  spentUsd: 1.01,
  elapsedMs: 100,
});
check("finish policy still respects explicit USD guardrail", finishWithBudget === "budget", finishWithBudget);
```

- [ ] **Step 2: Remove job-budget wording from GitHub budget test**

Modify `scripts/test-github-workflow.mts` so it continues to assert command throttling but no longer describes it as the Build worker budget:

```ts
check("normal run command throttle is 8 per phase", budget.normalRunsLeft === 8, budget);
check("normal run command throttle has 16 remaining after 8 used", budget.totalNormalRunsLeft === 16, budget);
```

- [ ] **Step 3: Import policy, usage, pricing, and settings helpers in Build engine**

Modify `lib/client/build-engine.ts` imports:

```ts
import {
  BUILD_MAX_WAVES,
  BUILD_NO_PROGRESS_WAVES,
  BUILD_TASKS_PER_WAVE,
  BUILD_INTEGRATOR_MIN_TOKENS,
  BUILD_ROUND_MIN_TOKENS,
  EFFORT_CONFIG,
} from "@/lib/orchestrator/config";
import {
  normalizeBuildSettings,
  shouldStopForBuildGuardrail,
} from "@/lib/orchestrator/build-policy";
import {
  addBuildUsageCall,
  createBuildUsageWindow,
} from "./build-usage";
import { getModelPricing } from "@/lib/providers/pricing";
import { getUserSettings } from "./store";
```

Remove `BUILD_LIMITS` import.

- [ ] **Step 4: Initialize Build policy and active usage window**

Near current `effort/config` initialization:

```ts
const buildSettings = normalizeBuildSettings(discussion);
const buildWindowStartedAt = new Date().toISOString();
const buildWindowStartMs = Date.now();
const settings = getUserSettings();
let usageWindow = createBuildUsageWindow(buildWindowStartedAt);

const emitBuildUsage = (): void => {
  emit({ type: "build_usage", usage: usageWindow });
};

const currentGuardrailStop = (): BuildStopReason | null =>
  shouldStopForBuildGuardrail({
    settings: buildSettings,
    spentUsd: usageWindow.estimatedUsd,
    elapsedMs: Date.now() - buildWindowStartMs,
  });
```

Use the existing `discussion.effort` only for token ceilings:

```ts
const effort = discussion.effort as EffortLevel;
const config = EFFORT_CONFIG[effort];
```

- [ ] **Step 5: Update usage after every model call**

Inside `streamConversation`, after `estimateModelCallUsage`:

```ts
const pricing = getModelPricing(model.modelId, settings.modelPricingOverrides);
usageWindow = addBuildUsageCall(usageWindow, {
  modelId: model.modelId,
  modelName: model.displayName,
  providerId,
  inputTokens: usage.inputTokens,
  outputTokens: usage.outputTokens,
  pricing,
  elapsedMs: Date.now() - buildWindowStartMs,
});
emitBuildUsage();
```

Leave the existing `token_usage` event in place. The UI suppresses it for Build diagnostics but it remains useful for diagnostics and future exports.

- [ ] **Step 6: Add controlled stop helper**

Inside `runBuildDiscussion`:

```ts
class BuildGuardrailStop extends Error {
  constructor(public readonly reason: BuildStopReason) {
    super(`Build stopped by ${reason} guardrail.`);
  }
}

const throwIfGuardrailReached = (): void => {
  const reason = currentGuardrailStop();
  if (reason) throw new BuildGuardrailStop(reason);
};

const markStopped = (reason: BuildStopReason, message: string): void => {
  const now = new Date().toISOString();
  updateDiscussion(discussion.id, {
    status: reason === "completed" ? "completed" : "stopped",
    buildStopReason: reason,
    buildStoppedAt: now,
    updatedAt: now,
  });
  emit({ type: "build_stopped", reason, message, usage: usageWindow });
  emit({
    type: "status",
    status: reason === "completed" ? "completed" : "stopped",
  });
};
```

Call `throwIfGuardrailReached()`:

- before planning model call
- before each worker batch
- after each worker batch
- before Architect review
- after final summary call

Do not check during streaming token emission. Stop after the current model call completes.

- [ ] **Step 7: Replace worker-call stop condition**

Remove these Build job stopping checks from `lib/client/build-engine.ts`:

```ts
if (workerCalls >= limits.totalWorkerCalls) {
  emit({
    type: "diagnostic",
    phase: "round_preparing",
    message: `Worker call budget reached (${limits.totalWorkerCalls}); moving to review`,
  });
  break;
}
const cap = limits.totalWorkerCalls - workerCalls;
```

Use only the wave task width:

```ts
const cap = BUILD_TASKS_PER_WAVE;
```

Keep `workerCalls += batch.length;` as telemetry if still useful, but never branch on it.

- [ ] **Step 8: Replace cycle limit with hard safety waves**

Change:

```ts
const totalPhases = limits.cycles * 2 + 2;
```

to:

```ts
const totalPhases = 0;
```

Emit progress with wave count and no fixed max:

```ts
emit({ type: "status", status: "running", round: 0, maxRounds: 0 });
```

Change the main loop:

```ts
for (let cycle = 1; cycle <= BUILD_MAX_WAVES && !done; cycle++) {
  throwIfGuardrailReached();
  emit({ type: "status", status: "running", round: cycle, maxRounds: 0 });
```

Change prompt inputs:

```ts
maxTasks: BUILD_TASKS_PER_WAVE,
maxNewTasks: BUILD_TASKS_PER_WAVE,
cyclesLeft: Math.max(0, BUILD_MAX_WAVES - cycle),
```

Change initial task slicing and new task slicing to `BUILD_TASKS_PER_WAVE`.

- [ ] **Step 9: Handle plan-only policy**

After the plan is parsed and task events are emitted:

```ts
if (buildSettings.runPolicy === "plan_only") {
  const summary = [
    "Plan-only Build run completed.",
    "",
    "Planned tasks:",
    ...tasks.map((task) => `- ${task.id}: ${task.title}`),
  ].join("\n");
  insertFinalResult({
    discussionId: discussion.id,
    answer: summary,
    confidence: 1,
    dissent: JSON.stringify([]),
    createdAt: new Date().toISOString(),
  });
  markStopped("completed", "Plan-only Build run completed.");
  return;
}
```

- [ ] **Step 10: Catch guardrail stops at the top-level Build engine caller**

Wrap the implementation body with existing `try`/`catch` handling. If the file does not currently have a top-level catch inside `runBuildDiscussion`, add a narrow catch around the main sequence:

```ts
try {
  // existing plan, waves, review, summary sequence
} catch (err) {
  if (err instanceof BuildGuardrailStop) {
    markStopped(
      err.reason,
      err.reason === "budget"
        ? "Build stopped because the active USD budget window was reached. Resume starts a fresh budget window."
        : "Build stopped because the active time budget window was reached. Resume starts a fresh time window."
    );
    return;
  }
  throw err;
}
```

If `runBuildDiscussion` already has a catch in the surrounding caller, keep this catch inside Build mode so the discussion status becomes `stopped`, not `failed`.

- [ ] **Step 11: Run checks**

Run:

```bash
npx tsx scripts/test-build-run-policy.mts
npx tsx scripts/test-github-workflow.mts
npx tsc --noEmit
```

Expected: all pass.

- [ ] **Step 12: Commit Task 5**

```bash
git add lib/client/build-engine.ts lib/orchestrator/config.ts scripts/test-build-run-policy.mts scripts/test-github-workflow.mts
git commit -m "feat: enforce build spend and time guardrails"
```

---

## Task 6: Checkpoint Persistence And Resume Integration

**Files:**
- Modify: `lib/client/build-engine.ts`
- Modify: `lib/client/store.ts`
- Modify: `app/discussion/discussion-client.tsx`
- Create: `scripts/test-build-checkpoint.mts`

- [ ] **Step 1: Write checkpoint store test**

Create `scripts/test-build-checkpoint.mts`:

```ts
/** Build checkpoint shape checks (run: npx tsx scripts/test-build-checkpoint.mts) */
import type { BuildCheckpoint } from "../lib/db/schema";

let failed = 0;
const check = (name: string, ok: boolean, detail?: unknown) => {
  console.log(`${ok ? "PASS" : "FAIL"} - ${name}${ok ? "" : ` -> ${JSON.stringify(detail)}`}`);
  if (!ok) failed++;
};

const checkpoint: BuildCheckpoint = {
  discussionId: "d1",
  status: "stopped",
  updatedAt: "2026-06-21T00:00:00.000Z",
  runPolicy: "budgeted",
  stopReason: "budget",
  wave: 3,
  tasks: [
    {
      id: "T1",
      title: "Implement settings",
      instructions: "Add Build settings fields.",
      contextFiles: [],
      outputPaths: ["lib/db/schema.ts"],
      status: "done",
    },
  ],
  architectNotes: "Continue with UI.",
  verifyCommand: "npm run build",
  branch: "codex/build-mode-run-policy",
  prUrl: null,
  milestone: "Build mode redesign",
  issueNumbers: [12, 13],
  failureFingerprints: { "npm run build|TS123": 2 },
  recoveryLog: ["Split UI task after first failure."],
  usageWindow: {
    startedAt: "2026-06-21T00:00:00.000Z",
    elapsedMs: 1000,
    estimatedUsd: 0.42,
    unknownPricedModelIds: [],
    models: [],
  },
};

check("checkpoint stores discussion id", checkpoint.discussionId === "d1", checkpoint);
check("checkpoint stores task graph", checkpoint.tasks.length === 1, checkpoint);
check("checkpoint stores budget stop reason", checkpoint.stopReason === "budget", checkpoint);

process.exit(failed === 0 ? 0 : 1);
```

- [ ] **Step 2: Run checkpoint type test**

Run: `npx tsx scripts/test-build-checkpoint.mts`

Expected: PASS after Task 1 types exist.

- [ ] **Step 3: Add checkpoint save helper inside Build engine**

Modify `lib/client/build-engine.ts` imports:

```ts
import {
  accumulateModelStats,
  getBuildCheckpoint,
  getBuildFiles,
  getFinalResult,
  getMessagesForDiscussion,
  getUserSettings,
  insertFinalResult,
  insertMessage,
  updateDiscussion,
  upsertBuildCheckpoint,
  upsertBuildFile,
} from "./store";
```

Add a local helper after mutable run state is declared:

```ts
const saveCheckpoint = (input: {
  status: BuildCheckpoint["status"];
  stopReason?: BuildStopReason | null;
  wave: number;
  tasks: BuildTask[];
  architectNotes: string;
  verifyCommand: string;
  failureFingerprints?: Record<string, number>;
  recoveryLog?: string[];
}): void => {
  upsertBuildCheckpoint({
    discussionId: discussion.id,
    status: input.status,
    updatedAt: new Date().toISOString(),
    runPolicy: buildSettings.runPolicy,
    stopReason: input.stopReason ?? null,
    wave: input.wave,
    tasks: input.tasks.map((task) => ({ ...task })),
    architectNotes: input.architectNotes,
    verifyCommand: input.verifyCommand,
    branch: repoActiveBranch,
    prUrl: repoPrUrl,
    milestone: repoMilestoneTitle,
    issueNumbers: [
      ...(repoIssueNumber == null ? [] : [repoIssueNumber]),
      ...repoCreatedIssues.map((item) => item.issue),
    ],
    failureFingerprints: input.failureFingerprints ?? {},
    recoveryLog: input.recoveryLog ?? [],
    usageWindow,
  });
};
```

- [ ] **Step 4: Load checkpoint before planning**

Before the planning phase:

```ts
const existingCheckpoint = getBuildCheckpoint(discussion.id);
let resumedFromCheckpoint = false;

if (
  existingCheckpoint &&
  existingCheckpoint.status !== "completed" &&
  existingCheckpoint.tasks.length > 0
) {
  tasks = existingCheckpoint.tasks.map((task) => ({ ...task }));
  architectNotes = existingCheckpoint.architectNotes;
  planVerifyCommand = existingCheckpoint.verifyCommand;
  repoActiveBranch = existingCheckpoint.branch;
  repoPrUrl = existingCheckpoint.prUrl;
  repoMilestoneTitle = existingCheckpoint.milestone;
  resumedFromCheckpoint = true;
  emit({
    type: "diagnostic",
    phase: "initializing",
    message: `Resuming Build checkpoint from wave ${existingCheckpoint.wave} with ${tasks.length} task(s).`,
  });
  emit({
    type: "build_plan",
    cycle: existingCheckpoint.wave,
    tasks: tasks.map((task) => ({
      id: task.id,
      title: task.title,
      status: task.status,
    })),
  });
  for (const task of tasks) {
    emit({
      type: "task_status",
      taskId: task.id,
      title: task.title,
      status: task.status,
      worker: task.workerIndex == null ? undefined : workers[task.workerIndex]?.displayName,
      cycle: existingCheckpoint.wave,
    });
  }
}
```

Wrap the plan block:

```ts
if (!resumedFromCheckpoint) {
  // existing planning block
}
```

- [ ] **Step 5: Save checkpoint after every meaningful state change**

Call `saveCheckpoint`:

- after initial plan
- after each task failure
- after each task approval/fix review
- after adding review tasks
- before budget/time stop
- before throwing incomplete-task blocked errors
- after final summary with `status: "completed"` and `stopReason: "completed"`

Use:

```ts
saveCheckpoint({
  status: "running",
  wave: cycle,
  tasks,
  architectNotes,
  verifyCommand,
});
```

For budget/time stop:

```ts
saveCheckpoint({
  status: "stopped",
  stopReason: err.reason,
  wave: currentCycle,
  tasks,
  architectNotes,
  verifyCommand,
});
```

- [ ] **Step 6: Reset usage window on resume**

Do not copy `existingCheckpoint.usageWindow` into the new active `usageWindow`. Keep it visible in the checkpoint only as historical data. The current run starts with `createBuildUsageWindow(new Date().toISOString())`.

- [ ] **Step 7: Show checkpoint stop reason on discussion page**

In `app/discussion/discussion-client.tsx`, when loading discussion data, the existing `discussion.buildStopReason` is available. Add a small stopped-state note near `BuildRunStats`:

```tsx
{discussion.mode === "build" && discussion.buildStopReason && status === "stopped" && (
  <p className="rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-100">
    Build stopped because {discussion.buildStopReason}. Resume starts a fresh budget window and keeps the current checkpoint.
  </p>
)}
```

- [ ] **Step 8: Run checks**

Run:

```bash
npx tsx scripts/test-build-checkpoint.mts
npx tsc --noEmit
```

Expected: both pass.

- [ ] **Step 9: Commit Task 6**

```bash
git add lib/client/build-engine.ts lib/client/store.ts app/discussion/discussion-client.tsx scripts/test-build-checkpoint.mts
git commit -m "feat: persist resumable build checkpoints"
```

---

## Task 7: Failure Progress Tracking And Blocked State

**Files:**
- Create: `lib/orchestrator/build-progress.ts`
- Modify: `lib/client/build-engine.ts`
- Create: `scripts/test-build-progress.mts`

- [ ] **Step 1: Write progress/no-progress tests**

Create `scripts/test-build-progress.mts`:

```ts
/** Build progress tracking checks (run: npx tsx scripts/test-build-progress.mts) */
import {
  fingerprintBuildFailure,
  hasMeaningfulBuildProgress,
  recordBuildFailure,
  shouldStopForNoProgress,
} from "../lib/orchestrator/build-progress";

let failed = 0;
const check = (name: string, ok: boolean, detail?: unknown) => {
  console.log(`${ok ? "PASS" : "FAIL"} - ${name}${ok ? "" : ` -> ${JSON.stringify(detail)}`}`);
  if (!ok) failed++;
};

const first = fingerprintBuildFailure("npm run build", "src/app.ts(12,4): error TS2345: Bad type");
const second = fingerprintBuildFailure("npm run build", "src/app.ts(18,7): error TS2345: Bad type again");
check("typescript failures with same code fingerprint together", first === second, { first, second });

let counts: Record<string, number> = {};
counts = recordBuildFailure(counts, first);
counts = recordBuildFailure(counts, first);
counts = recordBuildFailure(counts, first);
check("same failure records count", counts[first] === 3, counts);
check("three same failures can stop", shouldStopForNoProgress({ repeatedFailureCount: 3, noProgressWaves: 0 }));
check("four no-progress waves can stop", shouldStopForNoProgress({ repeatedFailureCount: 0, noProgressWaves: 4 }));
check("file writes count as progress", hasMeaningfulBuildProgress({ filesWritten: 1, tasksAdvanced: 0, failureChanged: false, repoAdvanced: false }));
check("changed failure counts as progress", hasMeaningfulBuildProgress({ filesWritten: 0, tasksAdvanced: 0, failureChanged: true, repoAdvanced: false }));

process.exit(failed === 0 ? 0 : 1);
```

- [ ] **Step 2: Run failing test**

Run: `npx tsx scripts/test-build-progress.mts`

Expected: FAIL because `build-progress.ts` does not exist.

- [ ] **Step 3: Add progress helper implementation**

Create `lib/orchestrator/build-progress.ts`:

```ts
export interface BuildProgressSignals {
  filesWritten: number;
  tasksAdvanced: number;
  failureChanged: boolean;
  repoAdvanced: boolean;
}

export function fingerprintBuildFailure(command: string, output: string): string {
  const normalizedOutput = output
    .replace(/\b\d+:\d+\b/g, "line:col")
    .replace(/\(\d+,\d+\)/g, "(line,col)")
    .replace(/\bline\s+\d+\b/gi, "line n")
    .replace(/\s+/g, " ")
    .trim();
  const code =
    /\b(TS\d+|ERR_[A-Z0-9_]+|Error:\s*[^.]+)/.exec(normalizedOutput)?.[1] ??
    normalizedOutput.slice(0, 160);
  return `${command.trim()}|${code}`;
}

export function recordBuildFailure(
  counts: Record<string, number>,
  fingerprint: string
): Record<string, number> {
  return { ...counts, [fingerprint]: (counts[fingerprint] ?? 0) + 1 };
}

export function hasMeaningfulBuildProgress(signals: BuildProgressSignals): boolean {
  return (
    signals.filesWritten > 0 ||
    signals.tasksAdvanced > 0 ||
    signals.failureChanged ||
    signals.repoAdvanced
  );
}

export function shouldStopForNoProgress(input: {
  repeatedFailureCount: number;
  noProgressWaves: number;
}): boolean {
  return input.repeatedFailureCount >= 3 || input.noProgressWaves >= 4;
}
```

- [ ] **Step 4: Wire progress tracking into Build engine**

Modify `lib/client/build-engine.ts` imports:

```ts
import {
  fingerprintBuildFailure,
  hasMeaningfulBuildProgress,
  recordBuildFailure,
  shouldStopForNoProgress,
} from "@/lib/orchestrator/build-progress";
```

Add mutable state near `tasks`:

```ts
let failureFingerprints: Record<string, number> =
  existingCheckpoint?.failureFingerprints ?? {};
let recoveryLog: string[] = existingCheckpoint?.recoveryLog ?? [];
let noProgressWaves = 0;
let lastFailureFingerprint: string | null = null;
```

When `runVerify` returns failing output, fingerprint it:

```ts
if (verifyFeedback && /failed|error|exit/i.test(verifyFeedback)) {
  const fingerprint = fingerprintBuildFailure(verifyCommand, verifyFeedback);
  const failureChanged = lastFailureFingerprint !== null && lastFailureFingerprint !== fingerprint;
  lastFailureFingerprint = fingerprint;
  failureFingerprints = recordBuildFailure(failureFingerprints, fingerprint);
  if (failureChanged) {
    recoveryLog.push(`Verification failure changed after wave ${cycle}.`);
  }
}
```

At the end of each wave, calculate progress:

```ts
const progress = hasMeaningfulBuildProgress({
  filesWritten: executed.reduce((sum, item) => sum + item.files.length, 0),
  tasksAdvanced: action.results.length + novelTasks.accepted.length,
  failureChanged: recoveryLog.some((entry) => entry.includes(`wave ${cycle}`)),
  repoAdvanced: !!repoActiveBranch || repoCommits.length > 0 || !!repoPrUrl,
});
noProgressWaves = progress ? 0 : noProgressWaves + 1;
```

Before continuing the loop:

```ts
const repeatedFailureCount =
  lastFailureFingerprint == null ? 0 : failureFingerprints[lastFailureFingerprint] ?? 0;
if (shouldStopForNoProgress({ repeatedFailureCount, noProgressWaves })) {
  saveCheckpoint({
    status: "blocked",
    stopReason: "blocked",
    wave: cycle,
    tasks,
    architectNotes,
    verifyCommand,
    failureFingerprints,
    recoveryLog,
  });
  markStopped(
    "blocked",
    "Build stopped after repeated no-progress recovery attempts. Resume keeps the checkpoint and lets you change settings or add guidance."
  );
  return;
}
```

- [ ] **Step 5: Preserve failure state in checkpoints**

Update every `saveCheckpoint` call to pass `failureFingerprints` and `recoveryLog`.

- [ ] **Step 6: Run checks**

Run:

```bash
npx tsx scripts/test-build-progress.mts
npx tsc --noEmit
```

Expected: both pass.

- [ ] **Step 7: Commit Task 7**

```bash
git add lib/orchestrator/build-progress.ts lib/client/build-engine.ts scripts/test-build-progress.mts
git commit -m "feat: stop build mode on repeated no-progress failures"
```

---

## Task 8: Tool Batch Parser And Scheduler Helpers

**Files:**
- Create: `lib/orchestrator/build-tool-scheduler.ts`
- Modify: `lib/orchestrator/build.ts`
- Modify: `scripts/test-tool-call-validation.mts`
- Create: `scripts/test-build-tool-scheduler.mts`
- Modify: `scripts/test-build-prompts.mts`

- [ ] **Step 1: Write scheduler tests**

Create `scripts/test-build-tool-scheduler.mts`:

```ts
/** Build tool scheduler checks (run: npx tsx scripts/test-build-tool-scheduler.mts) */
import {
  classifyBuildToolActionForScheduling,
  isSafeQueuedRunCommand,
  packToolBatchResult,
  scheduleBuildToolActions,
} from "../lib/orchestrator/build-tool-scheduler";
import { inspectStrictToolActionBatchOutput } from "../lib/orchestrator/build";

let failed = 0;
const check = (name: string, ok: boolean, detail?: unknown) => {
  console.log(`${ok ? "PASS" : "FAIL"} - ${name}${ok ? "" : ` -> ${JSON.stringify(detail)}`}`);
  if (!ok) failed++;
};

const inspected = inspectStrictToolActionBatchOutput(
  [
    '{"action":"read","paths":["package.json","app/page.tsx"]}',
    '{"action":"search","query":"BUILD_LIMITS"}',
  ].join("\n")
);
check("multiple safe read actions parse as a batch", inspected.valid && inspected.actions.length === 2, inspected);

check("read action is batch safe", classifyBuildToolActionForScheduling({ action: "read", paths: ["a.ts"] }) === "batch_read");
check("patch action is queued mutation", classifyBuildToolActionForScheduling({ action: "patch", path: "a.ts", ops: [] }) === "queued_mutation");
check("npm build is safe queued command", isSafeQueuedRunCommand("npm run build"));
check("npm install is not safe queued command", !isSafeQueuedRunCommand("npm install"));

const scheduled = scheduleBuildToolActions(inspected.actions, { allowSafeRunQueue: true, maxSafeRuns: 3 });
check("safe reads are served", scheduled.served.length === 2, scheduled);
check("no skipped actions for safe batch", scheduled.skipped.length === 0, scheduled);

const mixed = scheduleBuildToolActions(
  [
    { action: "run", command: "npm run build" },
    { action: "run", command: "npm install" },
  ],
  { allowSafeRunQueue: true, maxSafeRuns: 3 }
);
check("unsafe command is skipped from safe queue", mixed.served.length === 1 && mixed.skipped.length === 1, mixed);

const packed = packToolBatchResult({
  served: [{ label: "read package.json", result: "x".repeat(100) }],
  skipped: [{ label: "run npm install", reason: "unsafe command" }],
  maxChars: 80,
});
check("packed result lists served", /Served/.test(packed), packed);
check("packed result lists skipped", /Skipped/.test(packed), packed);
check("packed result caps output", packed.length < 500, packed);

process.exit(failed === 0 ? 0 : 1);
```

- [ ] **Step 2: Run failing scheduler test**

Run: `npx tsx scripts/test-build-tool-scheduler.mts`

Expected: FAIL because the scheduler helper does not exist.

- [ ] **Step 3: Add batch parser to build action protocol**

Modify `lib/orchestrator/build.ts` near strict tool validation:

```ts
export interface StrictToolActionBatchInspection {
  valid: boolean;
  actions: ArchitectAction[];
  feedback?: string;
}

export function inspectStrictToolActionBatchOutput(
  text: string
): StrictToolActionBatchInspection {
  const actions = extractJsonObjects(text)
    .map((candidate) => parseArchitectAction(candidate))
    .filter((action): action is ArchitectAction => !!action && isBuildToolAction(action));
  if (actions.length === 0) {
    const single = inspectStrictToolActionOutput(text);
    return {
      valid: !!single.valid && !!single.action,
      actions: single.action ? [single.action] : [],
      feedback: single.feedback,
    };
  }
  const chatty = text.trim().replace(/```json|```/g, "").trim();
  const feedback =
    actions.length > 1
      ? "TOOL CALL BATCH: multiple tool actions were requested. The engine will schedule safe actions and report served/skipped results."
      : chatty.startsWith("{")
        ? undefined
        : "TOOL CALL WARNING: tool calls should be JSON actions with no prose.";
  return { valid: true, actions, feedback };
}
```

If `extractJsonObjects` is not exported today, promote the existing internal JSON-object scanner used by `parseArchitectAction` into a local exported helper:

```ts
export function extractJsonObjects(text: string): string[] {
  const objects: string[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "{") {
      if (depth === 0) start = i;
      depth += 1;
      continue;
    }
    if (ch === "}") {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        objects.push(text.slice(start, i + 1));
        start = -1;
      }
    }
  }
  return objects;
}
```

- [ ] **Step 4: Add scheduler helper**

Create `lib/orchestrator/build-tool-scheduler.ts`:

```ts
import type { ArchitectAction } from "@/lib/orchestrator/build";

export type BuildToolScheduleClass =
  | "batch_read"
  | "queued_mutation"
  | "safe_run"
  | "exclusive";

export interface ScheduledToolAction {
  action: ArchitectAction;
  label: string;
  scheduleClass: BuildToolScheduleClass;
}

export interface SkippedToolAction {
  action: ArchitectAction;
  label: string;
  reason: string;
}

export function classifyBuildToolActionForScheduling(
  action: ArchitectAction
): BuildToolScheduleClass {
  switch (action.action) {
    case "read":
    case "read_range":
    case "search":
    case "repo_status":
    case "repo_diff":
    case "repo_issue_list":
    case "repo_issue_read":
      return "batch_read";
    case "patch":
    case "append":
    case "repo_branch_create":
    case "repo_commit":
    case "repo_push":
    case "repo_pr_create":
    case "repo_milestone_create":
    case "repo_issue_create":
      return "queued_mutation";
    case "run":
      return isSafeQueuedRunCommand(action.command) ? "safe_run" : "exclusive";
    default:
      return "exclusive";
  }
}

export function isSafeQueuedRunCommand(command: string): boolean {
  const trimmed = command.trim();
  return (
    /^git\s+(?:status|diff|show|log|branch)(?:\s|$)/i.test(trimmed) ||
    /^rg(?:\s|$)/i.test(trimmed) ||
    /^npm\s+(?:test|run\s+(?:build|lint|test|typecheck))(?:\s|$)/i.test(trimmed) ||
    /^npx\s+tsx\s+scripts\/[\w.-]+\.mts(?:\s|$)/i.test(trimmed.replace(/\\/g, "/"))
  ) && !/[;&|]|\d?>|>>/.test(trimmed);
}

function labelFor(action: ArchitectAction): string {
  switch (action.action) {
    case "read":
      return `read ${action.paths.join(", ")}`;
    case "read_range":
      return `read_range ${action.path}:${action.startLine}`;
    case "search":
      return `search ${action.query}`;
    case "run":
      return `run ${action.command}`;
    case "patch":
      return `patch ${action.path}`;
    case "append":
      return `append ${action.path}`;
    default:
      return action.action;
  }
}

export function scheduleBuildToolActions(
  actions: ArchitectAction[],
  options: { allowSafeRunQueue: boolean; maxSafeRuns: number }
): { served: ScheduledToolAction[]; skipped: SkippedToolAction[] } {
  const served: ScheduledToolAction[] = [];
  const skipped: SkippedToolAction[] = [];
  let safeRuns = 0;
  const mutationPaths = new Set<string>();

  for (const action of actions) {
    const scheduleClass = classifyBuildToolActionForScheduling(action);
    const label = labelFor(action);
    if (scheduleClass === "safe_run") {
      if (!options.allowSafeRunQueue || safeRuns >= options.maxSafeRuns) {
        skipped.push({ action, label, reason: "safe command queue is not available" });
        continue;
      }
      safeRuns += 1;
      served.push({ action, label, scheduleClass });
      continue;
    }
    if (scheduleClass === "queued_mutation") {
      const path =
        action.action === "patch" || action.action === "append"
          ? action.path.toLowerCase()
          : "";
      if (path && mutationPaths.has(path)) {
        skipped.push({ action, label, reason: "another mutation in this batch targets the same path" });
        continue;
      }
      if (path) mutationPaths.add(path);
      served.push({ action, label, scheduleClass });
      continue;
    }
    if (scheduleClass === "exclusive" && served.length > 0) {
      skipped.push({ action, label, reason: "exclusive action must run alone" });
      continue;
    }
    served.push({ action, label, scheduleClass });
  }

  return { served, skipped };
}

export function packToolBatchResult(input: {
  served: Array<{ label: string; result: string }>;
  skipped: Array<{ label: string; reason: string }>;
  maxChars: number;
}): string {
  const lines: string[] = ["TOOL BATCH RESULT", ""];
  lines.push("Served:");
  lines.push(...(input.served.length ? input.served.map((item) => `- ${item.label}`) : ["- none"]));
  lines.push("", "Skipped:");
  lines.push(...(input.skipped.length ? input.skipped.map((item) => `- ${item.label}: ${item.reason}`) : ["- none"]));
  lines.push("", "Results:");
  let remaining = input.maxChars - lines.join("\n").length;
  for (const item of input.served) {
    if (remaining <= 0) {
      lines.push(`\n--- ${item.label} ---\n[omitted: output cap reached]`);
      continue;
    }
    const header = `\n--- ${item.label} ---\n`;
    const slice = item.result.slice(0, Math.max(0, remaining - header.length));
    const suffix = slice.length < item.result.length ? "\n[truncated: output cap reached]" : "";
    lines.push(`${header}${slice}${suffix}`);
    remaining -= header.length + slice.length + suffix.length;
  }
  return lines.join("\n");
}
```

- [ ] **Step 5: Update prompt wording tests**

Modify `scripts/test-build-prompts.mts`:

Replace:

```ts
check("fix prompt enforces one JSON tool action", /entire response must be exactly ONE JSON object/i.test(prompt), prompt);
```

with:

```ts
check(
  "fix prompt allows scheduled JSON tool actions",
  /one or more JSON tool actions/i.test(prompt),
  prompt
);
```

Update worker tool instructions in `lib/client/build-engine.ts` in Task 9. This test can fail until Task 9 if the prompt source has not changed. Commit Task 8 only after updating the prompt text enough for this test to pass.

- [ ] **Step 6: Update strict validation test for batch behavior**

Modify `scripts/test-tool-call-validation.mts`:

Import `inspectStrictToolActionBatchOutput`.

Replace old "multiple tool actions with safe first action execute only first" assertions with:

```ts
const multipleSafe = inspectStrictToolActionBatchOutput(
  [
    '{"action":"read_range","path":"tests/run-tests.ts","startLine":1,"lineCount":100}',
    '{"action":"read_range","path":"tests/run-tests.ts","startLine":100,"lineCount":100}',
    '{"action":"search","query":"coerceValue"}',
  ].join("\n\n")
);
check("multiple safe tool actions parse as a valid batch", multipleSafe.valid && multipleSafe.actions.length === 3, multipleSafe);
check("batch parse includes scheduling feedback", /batch/i.test(multipleSafe.feedback ?? ""), multipleSafe);
```

Keep single-action tests for `inspectStrictToolActionOutput` so existing callers remain supported.

- [ ] **Step 7: Run checks**

Run:

```bash
npx tsx scripts/test-build-tool-scheduler.mts
npx tsx scripts/test-tool-call-validation.mts
npx tsx scripts/test-build-prompts.mts
npx tsc --noEmit
```

Expected: all pass.

- [ ] **Step 8: Commit Task 8**

```bash
git add lib/orchestrator/build.ts lib/orchestrator/build-tool-scheduler.ts scripts/test-build-tool-scheduler.mts scripts/test-tool-call-validation.mts scripts/test-build-prompts.mts
git commit -m "feat: parse and schedule build tool batches"
```

---

## Task 9: Wire Tool Scheduler Into Architect And Worker Loops

**Files:**
- Modify: `lib/client/build-engine.ts`
- Modify: `lib/orchestrator/build.ts`
- Modify: `scripts/test-build-prompts.mts`
- Modify: `scripts/test-tool-loop-robustness.mts`

- [ ] **Step 1: Update Build prompt instructions**

Modify `workerToolInstructions` in `lib/client/build-engine.ts`:

```ts
"FILE TOOLS - before your final answer, you may inspect or patch files by responding with one or more JSON tool actions. The engine schedules safe reads/searches together, queues mutations safely, and reports which requests were served or skipped.",
```

Update Architect tool docs in `lib/orchestrator/build.ts` from "one command at a time" to:

```ts
"You may request multiple JSON tool actions when they are independent. The engine will execute safe read/search/status actions as a batch, queue mutations in order, and return a served/skipped report. Risky commands still run alone."
```

- [ ] **Step 2: Import scheduler helpers in Build engine**

Modify `lib/client/build-engine.ts`:

```ts
import {
  packToolBatchResult,
  scheduleBuildToolActions,
} from "@/lib/orchestrator/build-tool-scheduler";
import { inspectStrictToolActionBatchOutput } from "@/lib/orchestrator/build";
```

Add constants:

```ts
const TOOL_BATCH_RESULT_CHARS = 24_000;
const SAFE_RUN_QUEUE_LIMIT = 3;
```

- [ ] **Step 3: Add Architect batch dispatch helper**

Replace the single-action dispatch path in `runArchitectInspectionLoop` with:

```ts
const dispatchArchitectToolBatch = async (
  actions: ArchitectAction[],
  budgets: InspectionBudgets,
  appendContext: (text: string) => void
): Promise<{ result: string; exhausted: boolean; deliveredRanges: Array<{ action: ArchitectAction; range?: { startLine: number; endLine: number } }> }> => {
  const schedule = scheduleBuildToolActions(actions, {
    allowSafeRunQueue: allowAllCommands,
    maxSafeRuns: SAFE_RUN_QUEUE_LIMIT,
  });
  const served: Array<{ label: string; result: string }> = [];
  const skipped = schedule.skipped.map((item) => ({
    label: item.label,
    reason: item.reason,
  }));
  const deliveredRanges: Array<{ action: ArchitectAction; range?: { startLine: number; endLine: number } }> = [];
  let exhausted = false;

  for (const item of schedule.served) {
    const dispatched = await dispatchArchitectTool(item.action, budgets, appendContext);
    served.push({ label: item.label, result: dispatched.result });
    if (dispatched.exhausted) exhausted = true;
    deliveredRanges.push({ action: item.action, range: dispatched.deliveredRange });
  }

  emit({
    type: "tool_batch",
    actor: "Architect",
    served: served.length,
    skipped: skipped.length,
    summary: `${served.length} served, ${skipped.length} skipped`,
  });

  return {
    result: packToolBatchResult({ served, skipped, maxChars: TOOL_BATCH_RESULT_CHARS }),
    exhausted,
    deliveredRanges,
  };
};
```

Change parser usage:

```ts
const strict = inspectStrictToolActionBatchOutput(text);
```

If `strict.actions.length === 0`, keep the malformed/no-action path. For duplicate tracking, apply `isRedundantToolCall` to each action and skip redundant actions with a skipped reason instead of rejecting the whole batch. Record each served action with `recordToolCall`.

- [ ] **Step 4: Add worker batch dispatch helper**

Inside `runWorkerTask`, replace single action dispatch with a worker-only batch function:

```ts
const dispatchWorkerToolBatch = async (
  actions: ArchitectAction[],
  warning: string,
  actor: string
): Promise<string> => {
  const schedule = scheduleBuildToolActions(actions, {
    allowSafeRunQueue: false,
    maxSafeRuns: 0,
  });
  const served: Array<{ label: string; result: string }> = [];
  const skipped = schedule.skipped.map((item) => ({
    label: item.label,
    reason: item.reason,
  }));

  for (const item of schedule.served) {
    const action = item.action;
    if (!isWorkerFileAction(action)) {
      skipped.push({ label: item.label, reason: "worker file loop cannot run this action" });
      continue;
    }
    if (isRedundantToolCall(tracker, action)) {
      skipped.push({ label: item.label, reason: "duplicate tool request" });
      continue;
    }
    if (action.action === "read" && budgets.reads > 0) {
      budgets.reads -= 1;
      const paths = action.paths.slice(0, 6);
      const chunks: string[] = [];
      for (const path of paths) {
        const content = await readFile(path);
        chunks.push(`\n--- ${path} ---\n${content ?? "[not found or binary]"}`);
      }
      const joined = chunks.join("\n");
      recordToolCall(tracker, action);
      served.push({ label: item.label, result: joined });
      continue;
    }
    skipped.push({ label: item.label, reason: "tool budget exhausted or unsupported in this worker loop" });
  }

  emit({
    type: "tool_batch",
    actor,
    served: served.length,
    skipped: skipped.length,
    summary: `${served.length} served, ${skipped.length} skipped`,
  });

  return `${warning}${packToolBatchResult({ served, skipped, maxChars: TOOL_BATCH_RESULT_CHARS })}`;
};
```

Port the existing `read_range`, `search`, `patch`, and `append` logic into this helper using the same budgets and side effects:

- `patchedFiles.push`
- `toolIssues.push`
- `emitFileToolDiagnostic`
- `recordToolCall`

Keep writes sequential.

- [ ] **Step 5: Keep exclusive shell commands safe**

For Architect batches containing multiple `run` actions:

- In full-access mode, run up to `SAFE_RUN_QUEUE_LIMIT` safe commands from `isSafeQueuedRunCommand`.
- In ask mode, skip all but the first run command and tell the model they require separate approval.
- Unknown/risky commands remain single-step through `executeRun`.

Use `scheduleBuildToolActions` options:

```ts
allowSafeRunQueue: allowAllCommands,
maxSafeRuns: SAFE_RUN_QUEUE_LIMIT,
```

- [ ] **Step 6: Run checks**

Run:

```bash
npx tsx scripts/test-build-tool-scheduler.mts
npx tsx scripts/test-tool-call-validation.mts
npx tsx scripts/test-tool-loop-robustness.mts
npx tsx scripts/test-build-prompts.mts
npx tsc --noEmit
```

Expected: all pass.

- [ ] **Step 7: Commit Task 9**

```bash
git add lib/client/build-engine.ts lib/orchestrator/build.ts scripts/test-build-prompts.mts scripts/test-tool-loop-robustness.mts
git commit -m "feat: execute safe build tool batches"
```

---

## Task 10: End-To-End Polish, Build Verification, And Docs

**Files:**
- Modify: `components/BuildTaskBoard.tsx`
- Modify: `components/RepoWorkflowPanel.tsx`
- Modify: `components/RunnerSetup.tsx`
- Modify: `README.md`
- Modify: `docs/superpowers/specs/2026-06-21-build-mode-run-policy-design.md` only if implementation intentionally diverged from the approved design.

- [ ] **Step 1: Polish Build dashboard ordering**

In `app/discussion/discussion-client.tsx`, order Build activity tab as:

1. `BuildRunStats`
2. stopped/budget checkpoint notice
3. `BuildTaskBoard`
4. `RepoWorkflowPanel`
5. note to Architect
6. attachments
7. result card
8. persisted files
9. collapsed raw transcript

Do not render full `DiscussionTimeline` directly for Build mode.

- [ ] **Step 2: Update runner copy**

Modify `components/RunnerSetup.tsx` text so full-access mode says:

```text
Commands and safe tool batches run without asking. Risky actions are still constrained by the Build engine and typed repo workflow.
```

Keep ask mode text clear that approval can include a batch summary.

- [ ] **Step 3: Update README Build mode section**

Add a short Build mode paragraph to `README.md`:

```md
Build mode uses a Build-specific run policy. By default it tries to finish the job; optional USD and time guardrails can stop the run cleanly with a resumable checkpoint. Worker calls are tracked as telemetry, not used as the stopping budget. The activity view shows aggregate per-model token/cost stats and keeps the raw transcript collapsed by default.
```

- [ ] **Step 4: Run focused test suite**

Run:

```bash
npx tsx scripts/test-build-run-policy.mts
npx tsx scripts/test-build-usage.mts
npx tsx scripts/test-build-checkpoint.mts
npx tsx scripts/test-build-progress.mts
npx tsx scripts/test-build-tool-scheduler.mts
npx tsx scripts/test-tool-call-validation.mts
npx tsx scripts/test-build-task-scheduling.mts
npx tsx scripts/test-build-prompts.mts
npx tsx scripts/test-github-workflow.mts
npx tsc --noEmit
```

Expected: all pass.

- [ ] **Step 5: Run production build**

Run: `npm run build`

Expected: Next static export succeeds. If the dev server is running, stop and restart it after this command because this repo's notes say production build corrupts the dev server `.next`.

- [ ] **Step 6: Manual Build-mode smoke test**

Use a disposable local Git repo through the runner:

1. Start runner: `node runner.mjs C:\path\to\disposable-repo`
2. Create a Build discussion with one worker model and one Architect.
3. Select `Budgeted run`, USD budget `0`, time budget `5`.
4. Ask for a small file change with a verification command.
5. Confirm the Build stats segment shows compact token totals by model.
6. Confirm activity rows do not show per-call token usage.
7. Confirm raw transcript is collapsed.
8. Confirm the run stops by time if it exceeds the time window.
9. Resume with time budget `0`.
10. Confirm the task graph and produced files continue from the checkpoint.

- [ ] **Step 7: Commit Task 10**

```bash
git add app/discussion/discussion-client.tsx components/BuildTaskBoard.tsx components/RepoWorkflowPanel.tsx components/RunnerSetup.tsx README.md docs/superpowers/specs/2026-06-21-build-mode-run-policy-design.md
git commit -m "docs: document build run policy behavior"
```

---

## Final Verification For The Whole Plan

- [ ] `npx tsx scripts/test-build-run-policy.mts`
- [ ] `npx tsx scripts/test-build-usage.mts`
- [ ] `npx tsx scripts/test-build-checkpoint.mts`
- [ ] `npx tsx scripts/test-build-progress.mts`
- [ ] `npx tsx scripts/test-build-tool-scheduler.mts`
- [ ] `npx tsx scripts/test-tool-call-validation.mts`
- [ ] `npx tsx scripts/test-build-task-scheduling.mts`
- [ ] `npx tsx scripts/test-build-prompts.mts`
- [ ] `npx tsx scripts/test-github-workflow.mts`
- [ ] `npx tsc --noEmit`
- [ ] `npm run build`

## Known Implementation Constraints

- Keep all runtime code client-side. Do not add API routes.
- Keep typed Git/GitHub mutations through the runner endpoints.
- Do not automatically merge PRs.
- Preserve the existing raw transcript data so users can export/debug it.
- Treat USD usage as estimated. Unknown-priced models must show a partial estimate warning.
- Do not reintroduce worker-call count as a stopping rule.
