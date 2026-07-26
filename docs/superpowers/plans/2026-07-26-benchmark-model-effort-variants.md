# Benchmark Model Effort Variants Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let every benchmark model use its own reasoning effort and keep each model-and-effort variant separate throughout execution, persistence, scoring, and results.

**Architecture:** Add one canonical benchmark-effort module for normalization, support checks, variant keys, and labels. The Run UI owns a `modelId -> effort` map and passes it into all composition builders; persisted team roles remain the source of truth for execution and aggregation. Result builders use stable model-variant keys while retaining base model IDs for provider lookup and backward-compatible imports.

**Tech Stack:** Next.js App Router, React 19, strict TypeScript, localStorage, existing benchmark bundle storage, `tsx` assertion scripts.

## Global Constraints

- Reasoning choices are `default`, `none`, `low`, `medium`, `high`, `xhigh`, and `max`.
- Unsupported provider/model choices are not selectable and normalize to `default`.
- Missing, empty, or invalid historical effort values normalize to `default` without rewriting stored evidence.
- A model-and-effort tuple is a distinct solo benchmark identity.
- Team lift must use solo baselines with the same model and effort.
- Existing benchmark imports remain readable.
- Product Build mode continues to use Runner V2; legacy Build engines are not imported.
- New behavior is implemented test-first.

---

### Task 1: Canonical effort values, support rules, variant identity, and labels

**Files:**

- Create: `lib/benchmark/model-effort.ts`
- Modify: `lib/db/schema.ts`
- Modify: `lib/orchestrator/config.ts`
- Modify: `lib/providers/reasoning.ts`
- Modify: `lib/account-provider-runner.mjs`
- Test: `scripts/test-benchmark-model-effort.mts`
- Test: `scripts/test-reasoning-routing.mts`
- Modify: `package.json`

**Interfaces:**

- Produces: `BenchmarkModelEffortMap = Record<string, ReasoningEffort>`
- Produces: `normalizeBenchmarkReasoningEffort(value: unknown): ReasoningEffort`
- Produces: `benchmarkEffortForModel(map: BenchmarkModelEffortMap, modelId: string): ReasoningEffort`
- Produces: `benchmarkVariantKey(modelId: string, effort: unknown): string`
- Produces: `benchmarkVariantLabel(displayName: string, effort: unknown): string`
- Produces: `supportedBenchmarkReasoningEfforts(model: Pick<SelectedModel, "modelId" | "providerId">): ReasoningEffort[]`
- Produces: `normalizeBenchmarkEffortForModel(model: Pick<SelectedModel, "modelId" | "providerId">, effort: unknown): ReasoningEffort`

- [ ] **Step 1: Write the failing canonical-effort tests**

Add literal assertions to `scripts/test-benchmark-model-effort.mts`:

```ts
import assert from "node:assert/strict";
import {
  benchmarkVariantKey,
  benchmarkVariantLabel,
  normalizeBenchmarkEffortForModel,
  normalizeBenchmarkReasoningEffort,
  supportedBenchmarkReasoningEfforts,
} from "../lib/benchmark/model-effort";

assert.equal(normalizeBenchmarkReasoningEffort(undefined), "default");
assert.equal(normalizeBenchmarkReasoningEffort("xhigh"), "xhigh");
assert.equal(normalizeBenchmarkReasoningEffort("bogus"), "default");
assert.equal(
  benchmarkVariantKey("anthropic:claude-opus-5", "high"),
  "anthropic:claude-opus-5\u0000high"
);
assert.equal(
  benchmarkVariantLabel("Claude Opus 5", "xhigh"),
  "Claude Opus 5 · Extra high"
);
assert.deepEqual(
  supportedBenchmarkReasoningEfforts({
    modelId: "custom:plain-model",
    providerId: "custom",
  }),
  ["default"]
);
assert.equal(
  normalizeBenchmarkEffortForModel(
    { modelId: "google:gemini-3.6-flash", providerId: "google" },
    "max"
  ),
  "default"
);
```

Extend `scripts/test-reasoning-routing.mts` with direct expectations that
OpenAI/OpenRouter `xhigh` remains `xhigh`, GPT-5.6 `max` remains `max`, older
OpenAI `max` is not exposed as a separate supported choice, and providers with
only a high native ceiling do not expose duplicate `xhigh`/`max` choices.

- [ ] **Step 2: Run the tests and verify the missing APIs fail**

Run:

```powershell
npx tsx scripts/test-benchmark-model-effort.mts
npx tsx scripts/test-reasoning-routing.mts
```

Expected: the first command fails because `lib/benchmark/model-effort.ts` and
`xhigh` do not exist; the routing test fails on the new `xhigh` expectations.

- [ ] **Step 3: Add `xhigh` to the shared reasoning type and option list**

Extend `ReasoningEffort` in `lib/db/schema.ts`:

```ts
export type ReasoningEffort =
  | "default"
  | "none"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max";
```

Add a separate `Extra high` entry before `Max` in `REASONING_OPTIONS`. Keep Max
described as the provider's true maximum rather than as an alias for xhigh.

- [ ] **Step 4: Make provider mappings preserve `xhigh`**

Add explicit `case "xhigh"` branches in `lib/providers/reasoning.ts` and the
account-provider runner. Use each provider/model's existing native mapping:

```ts
case "xhigh":
  return "xhigh";
```

Where a provider has no distinct xhigh or max setting, keep the existing safe
native fallback for stale/imported values, but exclude that choice from
`supportedBenchmarkReasoningEfforts` so two UI variants cannot produce the same
native request.

- [ ] **Step 5: Implement the canonical benchmark-effort module**

Use the shared reasoning options for labels, `parseModelId` for the provider
model name, `providerSupportsReasoningEffortFeature` for the initial gate, and
small provider/model rules matching `lib/providers/reasoning.ts`. Always include
`default`; return only native-distinct choices.

```ts
export const BENCHMARK_REASONING_EFFORTS: ReasoningEffort[] = [
  "default",
  "none",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

export function benchmarkVariantKey(modelId: string, effort: unknown): string {
  return `${modelId}\u0000${normalizeBenchmarkReasoningEffort(effort)}`;
}
```

`benchmarkVariantLabel` must use `Default`, not `Provider default`, in result
suffixes so historical evidence reads `Model · Default`.

- [ ] **Step 6: Register and run the focused tests**

Add `tsx scripts/test-benchmark-model-effort.mts` to
`test:benchmark:unit`. Run:

```powershell
npx tsx scripts/test-benchmark-model-effort.mts
npx tsx scripts/test-reasoning-routing.mts
```

Expected: both pass.

- [ ] **Step 7: Commit Task 1**

```powershell
git add lib/benchmark/model-effort.ts lib/db/schema.ts lib/orchestrator/config.ts lib/providers/reasoning.ts lib/account-provider-runner.mjs scripts/test-benchmark-model-effort.mts scripts/test-reasoning-routing.mts package.json
git commit -m "feat: define benchmark effort variants"
```

---

### Task 2: Persist and edit per-model effort in the Run UI

**Files:**

- Modify: `components/benchmark/run/ModelChecklist.tsx`
- Create: `components/benchmark/run/ModelEffortSelect.tsx`
- Modify: `components/benchmark/teamiq/TeamCompositionBuilder.tsx`
- Modify: `components/benchmark/certified/CertifiedRunPanel.tsx`
- Test: `scripts/test-benchmark-model-effort-ui.tsx`
- Test: `scripts/test-model-selection-migration.mts`
- Modify: `package.json`

**Interfaces:**

- Produces: `PersistedBenchmarkModelSelectionV2`
- Produces: `readPersistedModelChecklistConfig(): { selectedModelIds: string[]; effortByModelId: BenchmarkModelEffortMap }`
- Produces: `persistModelChecklistConfig(config): void`
- Consumes: Task 1 normalization, support, and label helpers.

- [ ] **Step 1: Write failing migration and rendered-control tests**

Extend `scripts/test-model-selection-migration.mts` so the legacy array:

```json
["anthropic:claude-opus-5", "openai:gpt-5.6"]
```

reads as:

```ts
{
  selectedModelIds: ["anthropic:claude-opus-5", "openai:gpt-5.6"],
  effortByModelId: {
    "anthropic:claude-opus-5": "default",
    "openai:gpt-5.6": "default",
  },
}
```

Add a version-2 round-trip fixture:

```ts
{
  version: 2,
  selectedModelIds: ["openai:gpt-5.6"],
  effortByModelId: { "openai:gpt-5.6": "xhigh" },
}
```

In `scripts/test-benchmark-model-effort-ui.tsx`, render `ModelChecklist` and
`TeamCompositionBuilder` with `react-dom/server`. Assert that a selected
reasoning model renders a uniquely labelled `Reasoning effort for GPT-5.6`
select with `Extra high`, while a non-configurable model renders `Default` and
no enabled effort choices.

- [ ] **Step 2: Run the UI tests and verify failure**

Run:

```powershell
npx tsx scripts/test-model-selection-migration.mts
npx tsx scripts/test-benchmark-model-effort-ui.tsx
```

Expected: both fail because version-2 config helpers and effort controls are
missing.

- [ ] **Step 3: Implement versioned localStorage persistence**

Keep `MODEL_CHECKLIST_STORAGE_KEY` unchanged. Read both legacy arrays and the
new object shape. Migrate full model IDs with `migrateFullModelId`, normalize
efforts, and immediately persist migrated data.

Keep `readPersistedModelChecklistSelection()` as a compatibility wrapper that
returns `readPersistedModelChecklistConfig().selectedModelIds`.

- [ ] **Step 4: Add the reusable model effort selector**

`ModelEffortSelect` receives one `SelectedModel`, its current effort, and an
`onChange` callback. It renders a native select using
`supportedBenchmarkReasoningEfforts(model)`, uses a model-specific accessible
label, and normalizes stale values before rendering.

```ts
export interface ModelEffortSelectProps {
  model: SelectedModel;
  value: ReasoningEffort;
  onChange: (effort: ReasoningEffort) => void;
  compact?: boolean;
}
```

- [ ] **Step 5: Wire effort controls into both selectors**

Change `ModelChecklist` and `TeamCompositionBuilder` props to accept:

```ts
effortByModelId: BenchmarkModelEffortMap;
onEffortChange: (modelId: string, effort: ReasoningEffort) => void;
```

The checklist shows the selector inside checked model cards. The team builder
shows it below each occupied role. Because the map is keyed by model ID,
changing one repeated model updates all roles that use it.

- [ ] **Step 6: Make `CertifiedRunPanel` own and persist the effort map**

Initialize both model IDs and efforts from
`readPersistedModelChecklistConfig()`. Normalize the map after enabled models
load. Pass the same map and change handler to preset and advanced solo/team
controls. Persist IDs and efforts together in one effect.

- [ ] **Step 7: Run the focused UI tests**

Run:

```powershell
npx tsx scripts/test-model-selection-migration.mts
npx tsx scripts/test-benchmark-model-effort-ui.tsx
```

Expected: both pass.

- [ ] **Step 8: Register and commit Task 2**

Add the new UI test to `test:benchmark:unit`, then:

```powershell
git add components/benchmark/run/ModelChecklist.tsx components/benchmark/run/ModelEffortSelect.tsx components/benchmark/teamiq/TeamCompositionBuilder.tsx components/benchmark/certified/CertifiedRunPanel.tsx scripts/test-benchmark-model-effort-ui.tsx scripts/test-model-selection-migration.mts package.json
git commit -m "feat: configure benchmark effort per model"
```

---

### Task 3: Propagate effort through every benchmark composition and model call

**Files:**

- Modify: `lib/benchmark/teamiq/compositions.ts`
- Modify: `lib/benchmark/teamiq/ui-selection.ts`
- Modify: `lib/benchmark/certified/run-execution.ts`
- Modify: `lib/benchmark/workbench/build-adapter.ts`
- Modify: `lib/benchmark/workbench/native-runner-adapter.ts`
- Test: `scripts/test-benchmark-model-effort-execution.mts`
- Test: `scripts/test-certified-model-call.mts`
- Test: `scripts/test-certified-workbench-ui.mts`
- Modify: `package.json`

**Interfaces:**

- Consumes: `BenchmarkModelEffortMap` from Task 1.
- Produces: `getTeamCompositionModelVariantKeys(team): string[]`.
- Changes: `RunSelectedContext`, `RunGameIqMultiModelContext`, and
  `RunPresetContext` each receive `effortByModelId`.
- Changes: `CreateTeamIqCompositionSelectionInput` receives
  `effortByModelId?: BenchmarkModelEffortMap`.

- [ ] **Step 1: Write failing composition and propagation tests**

Create `scripts/test-benchmark-model-effort-execution.mts` with literal
expectations for:

```ts
const effortByModelId = {
  "openai:gpt-5.6": "xhigh",
  "anthropic:claude-opus-5": "low",
} as const;
```

Assert that:

- a solo composition persists `xhigh`;
- a TeamIQ composition persists `xhigh` and `low` on the matching roles;
- changing only effort changes `comboHash` and composition ID;
- `getTeamCompositionModelVariantKeys` returns sorted
  `modelId + NUL + effort` keys;
- WorkBench provider configs receive the matching role efforts.

Extend `scripts/test-certified-model-call.mts` to assert a certified call sends
`reasoningEffort: "xhigh"` and records it on the trace.

- [ ] **Step 2: Run the tests and verify failure**

Run:

```powershell
npx tsx scripts/test-benchmark-model-effort-execution.mts
npx tsx scripts/test-certified-model-call.mts
npx tsx scripts/test-certified-workbench-ui.mts
```

Expected: the new execution test fails on missing parameters/helpers and the
model-call test fails on the new xhigh fixture.

- [ ] **Step 3: Add effort-aware composition helpers**

Add:

```ts
export function getTeamCompositionModelVariantKeys(
  team: BenchmarkTeamComposition | undefined
): string[] {
  if (!team) return [];
  return Array.from(new Set(team.roles.map((role) =>
    benchmarkVariantKey(role.modelId, role.reasoningEffort)
  ))).sort();
}
```

Update every `roleFor` and solo composition call to persist a normalized effort,
including explicit `default`.

- [ ] **Step 4: Thread the effort map through run contexts**

Add `effortByModelId` to all three execution contexts and every call site in
`CertifiedRunPanel`. Use `benchmarkEffortForModel` while building GameIQ solo
teams, Tool Reliability solo teams, TeamIQ roles, and WorkBench roles.

Export the pure `teamIqCompositionsForRun` and
`createWorkBenchTeamComposition` helpers so the execution test exercises the
real composition-building boundary without model-provider mocks.

- [ ] **Step 5: Preserve role effort in WorkBench/Runner V2**

Confirm `createWorkBenchBuildDiscussion` and
`createNativeProviderConfig` consume `teamComposition.roles[].reasoningEffort`.
Remove any fallback that overwrites a configured role with global `default`;
retain `default` only when the role has no stored value.

- [ ] **Step 6: Run focused execution tests**

Run:

```powershell
npx tsx scripts/test-benchmark-model-effort-execution.mts
npx tsx scripts/test-certified-model-call.mts
npx tsx scripts/test-certified-workbench-ui.mts
```

Expected: all pass.

- [ ] **Step 7: Register and commit Task 3**

Add the new execution test to `test:benchmark:unit`, then:

```powershell
git add lib/benchmark/teamiq/compositions.ts lib/benchmark/teamiq/ui-selection.ts lib/benchmark/certified/run-execution.ts lib/benchmark/workbench/build-adapter.ts lib/benchmark/workbench/native-runner-adapter.ts scripts/test-benchmark-model-effort-execution.mts scripts/test-certified-model-call.mts scripts/test-certified-workbench-ui.mts package.json
git commit -m "feat: propagate benchmark model effort"
```

---

### Task 4: Separate model variants in aggregation and team-lift baselines

**Files:**

- Modify: `lib/benchmark/scoring/types.ts`
- Modify: `lib/benchmark/scoring/aggregate.ts`
- Modify: `lib/benchmark/metrics.ts`
- Modify: `lib/benchmark/teamiq/baselines.ts`
- Modify: `lib/benchmark/teamiq/combo-matrix.ts`
- Modify: `lib/benchmark/certified/team-lift.ts`
- Modify: `lib/benchmark/certified/dashboard-selectors.ts`
- Test: `scripts/test-benchmark-model-effort-aggregation.mts`
- Test: `scripts/test-benchmark-team-lift.mts`
- Test: `scripts/test-benchmark-token-usage.mts`
- Modify: `package.json`

**Interfaces:**

- Adds: `modelVariantKeys: string[]` to certified aggregate rows.
- Adds: `reasoningEffort: string` and `variantKey: string` to solo model and
  WorkBench role leaderboard rows.
- Changes: model intelligence and role-board grouping keys from `modelId` to
  `benchmarkVariantKey(modelId, effort)`.

- [ ] **Step 1: Write failing aggregation tests**

Create two solo compositions for the same model, one Low and one High, with
different attempt scores. Assert `aggregateCertifiedRunScores` returns two
rows, `buildModelIntelligenceRows` returns two rows, and their literal labels
are `Model · Low` and `Model · High`.

Create a team using High and solo baselines at Low and High. Assert the computed
team lift uses only the High baseline. Remove the High baseline and assert team
lift is `null`; it must not fall back to Low.

Add a legacy composition with missing effort and assert its variant key and
label use Default.

- [ ] **Step 2: Run aggregation tests and verify failure**

Run:

```powershell
npx tsx scripts/test-benchmark-model-effort-aggregation.mts
npx tsx scripts/test-benchmark-team-lift.mts
npx tsx scripts/test-benchmark-token-usage.mts
```

Expected: variant rows merge in the model-intelligence/role paths and team lift
uses a baseline from the wrong effort.

- [ ] **Step 3: Carry variant keys in certified score rows**

Populate `modelVariantKeys` from composition roles in
`aggregateCertifiedRunScores`. Set a solo row's `displayName` and `teamName` to
`benchmarkVariantLabel(baseName, effort)`. Keep team names unchanged and expose
role effort through metadata.

- [ ] **Step 4: Match team lift by variant**

Change `computeTeamLift` to use `modelVariantKeys` when present. Build the solo
baseline map by variant key rather than base model ID.

In `linkTeamLiftBaselines`, change `SoloCandidate` from `{ modelId }` to
`{ variantKey }` and match every team role's normalized variant key. Keep
case/track/harness/scoring compatibility checks unchanged.

- [ ] **Step 5: Separate model intelligence and WorkBench role boards**

In `lib/benchmark/metrics.ts`, group solo attempts and WorkBench roles by
variant key. Include normalized effort in each output row, build labels with
`benchmarkVariantLabel`, and use the variant key for stable row IDs.

Update dashboard readers to normalize missing effort to Default while accepting
older serialized rows that lack the new properties.

- [ ] **Step 6: Run focused aggregation tests**

Run:

```powershell
npx tsx scripts/test-benchmark-model-effort-aggregation.mts
npx tsx scripts/test-benchmark-team-lift.mts
npx tsx scripts/test-benchmark-token-usage.mts
```

Expected: all pass.

- [ ] **Step 7: Register and commit Task 4**

Add the new aggregation test to `test:benchmark:unit`, then:

```powershell
git add lib/benchmark/scoring/types.ts lib/benchmark/scoring/aggregate.ts lib/benchmark/metrics.ts lib/benchmark/teamiq/baselines.ts lib/benchmark/teamiq/combo-matrix.ts lib/benchmark/certified/team-lift.ts lib/benchmark/certified/dashboard-selectors.ts scripts/test-benchmark-model-effort-aggregation.mts scripts/test-benchmark-team-lift.mts scripts/test-benchmark-token-usage.mts package.json
git commit -m "feat: separate benchmark effort results"
```

---

### Task 5: Surface effort variants in filters, profiles, charts, and reports

**Files:**

- Modify: `components/benchmark/useBenchmarkDashboard.ts`
- Modify: `components/benchmark/results/DecisionLeaderboard.tsx`
- Modify: `components/benchmark/results/ModelEvidenceProfile.tsx`
- Modify: `components/benchmark/certified/CertifiedResultTables.tsx`
- Modify: `lib/benchmark/reports.ts`
- Modify: `lib/benchmark/certified/decision-dashboard.ts`
- Test: `scripts/test-benchmark-decision-dashboard.mts`
- Test: `scripts/test-benchmark-decision-dashboard-ui.mts`
- Test: `scripts/test-benchmark-report-v2.mts`

**Interfaces:**

- Consumes: normalized effort and variant label helpers from Task 1.
- Keeps: `DecisionFilters.effort` as the existing filter contract.

- [ ] **Step 1: Write failing result-surface tests**

Extend the decision-dashboard fixture with Low and High rows for the same model.
Assert:

- the unfiltered result contains both rows;
- `effort: "high"` returns only the High row;
- Default legacy metadata appears as `["default"]`;
- the leaderboard/profile markup contains the effort badge or suffix;
- the Markdown report contains separate `Model · Low` and `Model · High`
  entries and never a merged base-model entry.

- [ ] **Step 2: Run the tests and verify failure**

Run:

```powershell
npx tsx scripts/test-benchmark-decision-dashboard.mts
npx tsx scripts/test-benchmark-decision-dashboard-ui.mts
npx tsx scripts/test-benchmark-report-v2.mts
```

Expected: Default is absent for legacy rows and labels do not consistently
expose effort.

- [ ] **Step 3: Normalize dashboard metadata**

In `withCertifiedDeleteMetadata`, derive normalized effort from every role and
return `["default"]` when roles omit effort. Preserve multiple efforts for team
rows. The existing Reasoning filter then works without changing its public
shape.

- [ ] **Step 4: Render effort identity consistently**

Use variant labels for solo rows. For teams, render compact role/member effort
badges in the evidence profile. WorkBench role tables and overall model tables
use their new effort-aware display names.

Charts already use leaderboard display names; verify they receive the variant
label rather than adding chart-specific grouping.

- [ ] **Step 5: Export distinct effort variants**

Update Markdown formatting to print normalized effort metadata for each row and
team roster. JSON bundles already carry role and trace effort, so retain the
bundle version unless validation proves a schema bump is required.

- [ ] **Step 6: Run result-surface tests**

Run:

```powershell
npx tsx scripts/test-benchmark-decision-dashboard.mts
npx tsx scripts/test-benchmark-decision-dashboard-ui.mts
npx tsx scripts/test-benchmark-report-v2.mts
```

Expected: all pass.

- [ ] **Step 7: Commit Task 5**

```powershell
git add components/benchmark/useBenchmarkDashboard.ts components/benchmark/results/DecisionLeaderboard.tsx components/benchmark/results/ModelEvidenceProfile.tsx components/benchmark/certified/CertifiedResultTables.tsx lib/benchmark/reports.ts lib/benchmark/certified/decision-dashboard.ts scripts/test-benchmark-decision-dashboard.mts scripts/test-benchmark-decision-dashboard-ui.mts scripts/test-benchmark-report-v2.mts
git commit -m "feat: display benchmark effort variants"
```

---

### Task 6: Full regression and production verification

**Files:**

- Modify only files required to fix failures caused by Tasks 1-5.

**Interfaces:**

- Verifies the completed model-effort feature against repository-wide
  benchmark, lint, and build contracts.

- [ ] **Step 1: Run the focused model-effort tests together**

Run:

```powershell
npx tsx scripts/test-benchmark-model-effort.mts
npx tsx scripts/test-benchmark-model-effort-ui.tsx
npx tsx scripts/test-benchmark-model-effort-execution.mts
npx tsx scripts/test-benchmark-model-effort-aggregation.mts
```

Expected: all pass with no warnings.

- [ ] **Step 2: Run the benchmark unit suite**

Run:

```powershell
npm run test:benchmark:unit
```

Expected: exit code 0.

- [ ] **Step 3: Run track and WorkBench regression suites**

Run:

```powershell
npm run test:benchmark:tracks
npm run test:benchmark:workbench
```

Expected: both exit with code 0.

- [ ] **Step 4: Run static verification**

Run:

```powershell
npm run lint
npm run build
```

Expected: both exit with code 0. Ensure no dev server is active during the
build, per repository guidance.

- [ ] **Step 5: Inspect final diff and requirement coverage**

Run:

```powershell
git status --short
git diff --check HEAD~5..HEAD
git log -6 --oneline
```

Confirm that:

- every benchmark run path receives per-model effort;
- all new compositions persist explicit normalized effort;
- same-model different-effort results never merge;
- matching-effort solo baselines are required for team lift;
- legacy evidence appears as Default;
- all visible comparison and export surfaces expose effort.
