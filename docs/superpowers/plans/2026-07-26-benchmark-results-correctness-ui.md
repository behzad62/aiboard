# Benchmark Results Correctness and Clarity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve completed TeamIQ evidence, give the all-modes suite enough time to finish, remove invalid cross-track team-lift claims, and make benchmark result identity, failure provenance, WorkBench verdicts, and responsive layouts unambiguous.

**Architecture:** Keep Certified Index v1.0 and immutable historical attempts. Add a small TeamIQ budget policy module, persist each completed TeamIQ composition through the certified run context, and compute team lift only from common team/solo tracks. Enrich read-side leaderboard rows with certified failure metadata, then render the corrected semantics through the verdicts, charts, leaderboard, and evidence profile without changing verifier behavior.

**Tech Stack:** Next.js App Router, React 19, strict TypeScript, Recharts 3, Tailwind CSS, local certified benchmark store, `tsx` assertion scripts, Chrome control.

## Global Constraints

- TeamIQ Tool Reliability all-modes wall-clock budget is exactly 3,600 seconds.
- TeamIQ Tool Reliability quick single-strategy wall-clock budget remains exactly 900 seconds.
- TeamIQ model-call ceiling remains exactly 150 calls.
- Certified Index v1.0 remains the equal-weighted mean of per-track average verified quality.
- Existing attempts are never deleted, migrated, or rewritten.
- Team lift is unavailable when the team and its members have no common scored track.
- Full Certified remains team-only for WorkBench.
- The WorkBench verdict is `Best WorkBench team`.
- Product Build mode continues to use Runner V2; no legacy WorkBench engine imports are added.
- New behavior is implemented test-first.

---

### Task 1: TeamIQ all-modes budget and partial-result persistence

**Files:**

- Create: `lib/benchmark/teamiq/budget.ts`
- Modify: `lib/benchmark/teamiq/index.ts`
- Modify: `lib/benchmark/certified/run-execution.ts`
- Modify: `lib/benchmark/teamiq/certified-runner.ts`
- Create: `scripts/test-certified-teamiq-partial-persistence.mts`
- Modify: `scripts/test-teamiq-toolreliability-quick-suite.mts`
- Modify: `package.json`

**Interfaces:**

- Produces: `TEAMIQ_TOOL_RELIABILITY_QUICK_WALL_CLOCK_SECONDS = 900`
- Produces: `TEAMIQ_TOOL_RELIABILITY_ALL_MODES_WALL_CLOCK_SECONDS = 3600`
- Produces: `teamIqToolReliabilityWallClockSecondsForSuite(suiteId: string): number`
- Consumes: `persistReturnedAttempts(context, attempts)` from `lib/benchmark/certified/model-runner.ts`

- [ ] **Step 1: Write failing budget-policy tests**

Extend `scripts/test-teamiq-toolreliability-quick-suite.mts` with:

```ts
import {
  TEAMIQ_TOOL_RELIABILITY_ALL_MODES_WALL_CLOCK_SECONDS,
  TEAMIQ_TOOL_RELIABILITY_QUICK_WALL_CLOCK_SECONDS,
  teamIqToolReliabilityWallClockSecondsForSuite,
} from "../lib/benchmark/teamiq";

check(
  "TeamIQ all-modes allows one hour",
  TEAMIQ_TOOL_RELIABILITY_ALL_MODES_WALL_CLOCK_SECONDS === 3600 &&
    teamIqToolReliabilityWallClockSecondsForSuite(
      "teamiq-toolreliability-current-all-modes"
    ) === 3600
);
check(
  "TeamIQ quick retains its fifteen-minute budget",
  TEAMIQ_TOOL_RELIABILITY_QUICK_WALL_CLOCK_SECONDS === 900 &&
    teamIqToolReliabilityWallClockSecondsForSuite(
      "teamiq-toolreliability-current"
    ) === 900
);
```

Exercise the TeamIQ case-record builder through an exported
`caseForSelection` and assert that the all-modes case record has
`budget.maxWallClockSeconds === 3600` and `budget.maxModelCalls === 150`.
This catches a wrong budget reaching the certified runner rather than merely
checking a constant or source string.

- [ ] **Step 2: Write a failing partial-persistence test**

Create `scripts/test-certified-teamiq-partial-persistence.mts`. Build two
minimal team compositions and a one-case Tool Reliability task. Use a stream
mock that lets the first composition finish, then throws
`new Error("Wall-clock budget exceeded in simulated later composition.")` for
the second composition.
Run through `runCertifiedBenchmark`, then assert:

```ts
const attempts = await listBenchmarkAttemptsV2();
const completed = attempts.find(
  (attempt) => attempt.teamCompositionId === firstTeam.id
);
const failed = attempts.find(
  (attempt) => attempt.teamCompositionId === secondTeam.id
);

check("first TeamIQ composition survives a later failure", completed?.status === "passed");
check(
  "only the missing TeamIQ composition is synthesized as failed",
  failed?.status === "failed_budget" && attempts.length === 2
);
check(
  "completed TeamIQ attempt is not recorded twice",
  attempts.filter((attempt) => attempt.id === completed?.id).length === 1
);
```

Use distinct providers/model IDs so the stream mock can identify the second
composition without shared mutable call-order assumptions.

- [ ] **Step 3: Run the focused tests and verify failure**

Run:

```powershell
npx tsx scripts/test-teamiq-toolreliability-quick-suite.mts
npx tsx scripts/test-certified-teamiq-partial-persistence.mts
```

Expected: budget exports are missing and the first composition is absent after
the later throw.

- [ ] **Step 4: Add the TeamIQ budget policy**

Create `lib/benchmark/teamiq/budget.ts`:

```ts
export const TEAMIQ_TOOL_RELIABILITY_QUICK_WALL_CLOCK_SECONDS = 900;
export const TEAMIQ_TOOL_RELIABILITY_ALL_MODES_WALL_CLOCK_SECONDS = 3600;

export function teamIqToolReliabilityWallClockSecondsForSuite(
  suiteId: string
): number {
  return suiteId === "teamiq-toolreliability-current-all-modes"
    ? TEAMIQ_TOOL_RELIABILITY_ALL_MODES_WALL_CLOCK_SECONDS
    : TEAMIQ_TOOL_RELIABILITY_QUICK_WALL_CLOCK_SECONDS;
}
```

Export it from `lib/benchmark/teamiq/index.ts`. In
`caseForSelection` inside `lib/benchmark/certified/run-execution.ts`, replace
the literal 900 TeamIQ wall-clock value with the helper result while retaining
`maxUsd: 5` and `maxModelCalls: 150`.

- [ ] **Step 5: Persist each completed TeamIQ composition**

Import `persistReturnedAttempts` into
`lib/benchmark/teamiq/certified-runner.ts`. Inside the `for (const team of
allTeams)` loop, record the new attempt immediately:

```ts
const attempt = await runTeamIqToolReliabilityAttempt(
  input,
  team,
  input.task.casePack
);
attempts.push(attempt);
await persistReturnedAttempts(input.context, [attempt]);
```

After baseline links update `teamLift`, record linked team attempts again so
the context's map-by-id snapshot contains the final lift value. Keep returning
the completed `attempts` array: the outer run engine may record those stable IDs
again, and the certified context's map-by-id semantics must make that
idempotent. Do not change the public return contract or the delegated Fireworks
runner's return contract.

- [ ] **Step 6: Run focused and neighboring TeamIQ tests**

Run:

```powershell
npx tsx scripts/test-teamiq-toolreliability-quick-suite.mts
npx tsx scripts/test-certified-teamiq-partial-persistence.mts
npx tsx scripts/test-certified-teamiq-runner.mts
npx tsx scripts/test-certified-e2e-teamiq.mts
```

Expected: all commands print `PASS`.

- [ ] **Step 7: Add the partial-persistence test to the benchmark E2E script and commit**

Insert `tsx scripts/test-certified-teamiq-partial-persistence.mts` in
`test:benchmark:e2e` next to the existing TeamIQ E2E check.

```powershell
git add lib/benchmark/teamiq/budget.ts lib/benchmark/teamiq/index.ts lib/benchmark/certified/run-execution.ts lib/benchmark/teamiq/certified-runner.ts scripts/test-teamiq-toolreliability-quick-suite.mts scripts/test-certified-teamiq-partial-persistence.mts package.json
git commit -m "fix(benchmark): preserve TeamIQ results within one-hour budget"
```

---

### Task 2: Track-comparable team lift

**Files:**

- Modify: `lib/benchmark/certified/team-lift.ts`
- Modify: `lib/benchmark/scoring/types.ts`
- Modify: `lib/benchmark/scoring/aggregate.ts`
- Modify: `lib/benchmark/certified/dashboard-selectors.ts`
- Modify: `scripts/test-benchmark-team-lift.mts`
- Modify: `scripts/test-benchmark-decision-dashboard.mts`

**Interfaces:**

- Produces: `ComparableTrackRowLike`
- Produces: `computeComparableTrackTeamLift(teamRow, soloByVariant)`
- Adds: `CertifiedRunScore.teamLiftTracks: string[]`
- Adds: `CertifiedLeaderboardRow.teamLiftTracks: string[]`

- [ ] **Step 1: Write failing common-track lift tests**

Add fixtures to `scripts/test-benchmark-team-lift.mts` for:

```ts
const team = comparableRow({
  modelVariantKeys: ["model-a\u0000medium", "model-b\u0000medium"],
  tracks: { teamiq: 0.8, workbench: 1 },
});
const solos = new Map([
  ["model-a\u0000medium", comparableRow({ tracks: { teamiq: 0.7 } })],
  ["model-b\u0000medium", comparableRow({ tracks: { teamiq: 0.6 } })],
]);
```

Assert the result has `teamLift === 10`, `bestSoloScore === 70`, and
`tracks === ["teamiq"]`. Then assert:

- No overlapping tracks returns `null`.
- A track that is missing a solo baseline for any team member is excluded.
- Two common tracks average the two track-local percentage-point differences
  equally, regardless of attempt counts.
- Only matching member variant keys participate.

Add an aggregate-level regression fixture matching the user's data shape:
solos have GameIQ/Tool Reliability, the team has TeamIQ/WorkBench. Assert the
team aggregate row has `teamLift === null` and `teamLiftTracks` is empty.

- [ ] **Step 2: Run the tests and verify the cross-track fixture fails**

Run:

```powershell
npx tsx scripts/test-benchmark-team-lift.mts
```

Expected: the current aggregate produces a numeric lift for the disjoint-track
fixture and the new helper is missing.

- [ ] **Step 3: Implement comparable-track lift**

Add to `lib/benchmark/certified/team-lift.ts`:

```ts
export interface ComparableTrackRowLike extends TeamLiftRowLike {
  modelVariantKeys: string[];
  trackBreakdown: Array<{
    track: string;
    averageVerifiedQuality: number;
  }>;
}

export interface ComparableTrackTeamLift {
  bestSoloScore: number;
  teamLift: number;
  label: TeamLiftLabel;
  tracks: string[];
}
```

`computeComparableTrackTeamLift` must:

1. Resolve solo rows only by the team's `modelVariantKeys`.
2. For each team track, require every team member variant to have solo evidence
   on that same track; incomplete member baselines do not qualify.
3. Compare team quality to the best member quality on that track.
4. Average common-track team scores and best-solo scores in 0–100 points.
5. Reuse `scoreTeamLift` for rounding/label semantics.
6. Return `null` when no common track exists.

- [ ] **Step 4: Wire comparable lift through aggregation and selectors**

Add `teamLiftTracks: string[]` to `CertifiedRunScore`, initialize it to `[]`,
and replace `computeTeamLift` inside aggregate `applyTeamLift` with
`computeComparableTrackTeamLift`. Set:

```ts
row.bestSoloScore = lift.bestSoloScore;
row.teamLift = lift.teamLift;
row.teamLiftLabel = lift.label;
row.teamLiftTracks = lift.tracks;
```

Add `teamLiftTracks` to `CertifiedLeaderboardRow`,
`readLeaderboardRow`, alternate-sort metadata reattachment, and track scoping.
When a track-scoped row excludes the lift's comparison track, set its lift to
`null` and `teamLiftTracks` to `[]`.

- [ ] **Step 5: Update decision-model expectations**

In `scripts/test-benchmark-decision-dashboard.mts`, add:

```ts
check(
  "disjoint solo and team tracks are not comparable",
  disjointTeam.teamLift == null && disjointTeam.teamLiftTracks.length === 0,
  disjointTeam
);
```

Keep the existing direct `computeTeamLift` assertions for TeamIQ combo-matrix
callers; only the merged decision-dashboard aggregate adopts the comparable-
track helper.

- [ ] **Step 6: Run scoring and dashboard tests, then commit**

Run:

```powershell
npx tsx scripts/test-benchmark-team-lift.mts
npx tsx scripts/test-benchmark-scoring.mts
npx tsx scripts/test-benchmark-decision-dashboard.mts
```

Expected: all commands print `PASS`.

```powershell
git add lib/benchmark/certified/team-lift.ts lib/benchmark/scoring/types.ts lib/benchmark/scoring/aggregate.ts lib/benchmark/certified/dashboard-selectors.ts scripts/test-benchmark-team-lift.mts scripts/test-benchmark-decision-dashboard.mts
git commit -m "fix(benchmark): compare team lift only on shared tracks"
```

---

### Task 3: Certified failure provenance and WorkBench team verdict

**Files:**

- Modify: `components/benchmark/useBenchmarkDashboard.ts`
- Modify: `lib/benchmark/certified/dashboard-selectors.ts`
- Modify: `lib/benchmark/certified/decision-dashboard.ts`
- Modify: `components/benchmark/results/DecisionVerdicts.tsx`
- Modify: `scripts/test-benchmark-decision-dashboard.mts`
- Modify: `scripts/test-benchmark-decision-dashboard-ui.mts`

**Interfaces:**

- Produces: `CertifiedFailureDetail`
- Adds: `CertifiedLeaderboardRow.failureDetails: CertifiedFailureDetail[]`
- Changes: WorkBench verdict selection from solo rows to team rows

- [ ] **Step 1: Write failing verdict and provenance tests**

Change the WorkBench fixture in
`scripts/test-benchmark-decision-dashboard.mts` to `isTeam: true` and add a
higher-scoring solo WorkBench fixture. Assert the team wins and the solo row is
ignored. Assert the label and empty hint are:

```ts
"Best WorkBench team"
"Run a team WorkBench pack to compare verified coding work."
```

Add a `withCertifiedDeleteMetadata` fixture containing a `failed_budget`
attempt and a linked `BenchmarkFailure` with message
`Wall-clock budget exceeded (900000ms >= 900000ms).` Assert the resulting row
exposes that message, code, status, attempt ID, and track.

- [ ] **Step 2: Run decision tests and verify failure**

Run:

```powershell
npx tsx scripts/test-benchmark-decision-dashboard.mts
npx tsx scripts/test-benchmark-decision-dashboard-ui.mts
```

Expected: WorkBench still selects a solo row and failure details are absent.

- [ ] **Step 3: Attach certified failure details at the read boundary**

Add to `dashboard-selectors.ts`:

```ts
export interface CertifiedFailureDetail {
  attemptId: string;
  track: string;
  status: string;
  code: string;
  message: string;
}
```

Pass `benchmarkFailures` into `withCertifiedDeleteMetadata` from
`useBenchmarkDashboard`. For every canonical leaderboard row, join failures to
its represented attempts by `attemptId` or referenced `failureIds`, deduplicate
by failure ID, and attach normalized details. Reattach them to alternate sort
arrays in `readLeaderboard`; filter them in `resolveLeaderboardDeleteFields`
when a single track is selected. Legacy rows default to `[]`.

- [ ] **Step 4: Correct the WorkBench verdict**

In `buildDecisionVerdicts`, use `teamRows` for the WorkBench verdict. Change
both the model-layer label and `CARD_META.workbench.label` to
`Best WorkBench team`. Change the empty hint to request a team WorkBench pack.
Change the displayed metric suffix from `quality` to `verified quality` while
retaining the normalized 0–100 formatter.

For team-lift empty state, use:

```ts
"Run the same certified track solo and as a team to measure added value."
```

- [ ] **Step 5: Run decision tests and commit**

Run:

```powershell
npx tsx scripts/test-benchmark-decision-dashboard.mts
npx tsx scripts/test-benchmark-decision-dashboard-ui.mts
npx tsx scripts/test-benchmark-delete-results.mts
```

Expected: all commands print `PASS`.

```powershell
git add components/benchmark/useBenchmarkDashboard.ts lib/benchmark/certified/dashboard-selectors.ts lib/benchmark/certified/decision-dashboard.ts components/benchmark/results/DecisionVerdicts.tsx scripts/test-benchmark-decision-dashboard.mts scripts/test-benchmark-decision-dashboard-ui.mts
git commit -m "fix(benchmark): expose failures and team WorkBench verdict"
```

---

### Task 4: Stable chart identity, terminology, and accessible interaction

**Files:**

- Modify: `components/benchmark/chart-utils.tsx`
- Modify: `components/benchmark/results/DecisionTradeoffCharts.tsx`
- Modify: `scripts/test-benchmark-decision-dashboard-ui.mts`

**Interfaces:**

- Produces: `chartColorForIdentity(identity: string): string`
- Produces: `projectDecisionTradeoffPoints(rows, basis): TradeoffPoint[]`
- Produces: `decisionTradeoffPointAriaLabel(point, xLabel, formatX): string`
- Adds to `TradeoffPoint`: `kind`, `tracks`, `color`
- Keeps the existing `DecisionTradeoffCharts({ rows })` public component API

- [ ] **Step 1: Write failing chart behavior tests**

Exercise exported projection/label helpers with literal rows and assert:

- Reordering/filtering rows keeps each row's color unchanged.
- Both token/time projections use the same color for one row.
- The projected Y value is `(overallScore ?? verifiedQuality) * 100`.
- Point labels contain the full model/team identity, kind, tracks, index, and
  X metric.

Render `DecisionTradeoffCharts` with React DOM server and literal rows. Assert
the rendered HTML includes `Overall index vs tokens per successful case`,
`Overall index vs time per successful case`, `Overall index`, every full legend
label, `Solo model`/`Team`, and the accessible data values. Export and render
the custom point shape directly with fixed SVG coordinates; assert it carries
`tabindex="0"` and the identity-rich `aria-label`.

- [ ] **Step 2: Run the chart behavior tests and verify failure**

Run:

```powershell
npx tsx scripts/test-benchmark-decision-dashboard-ui.mts
```

Expected: the projection/label APIs are absent and rendered output still uses
the old quality terminology and has no visible identity legend.

- [ ] **Step 3: Add stable color assignment**

In `chart-utils.tsx`, export:

```ts
export function chartColorForIdentity(identity: string): string {
  let hash = 0;
  for (const character of identity) {
    hash = (hash * 31 + character.codePointAt(0)!) >>> 0;
  }
  return CHART_COLORS[hash % CHART_COLORS.length]!;
}
```

Use the row's canonical `id` for both charts, so filter/sort changes cannot
reassign colors.

- [ ] **Step 4: Rebuild chart identity and tooltip rendering**

Project each point with:

```ts
{
  id: row.id,
  label: row.label,
  kind: row.isTeam ? "Team" : "Solo model",
  tracks: row.tracks,
  quality: (row.overallScore ?? row.verifiedQuality) * 100,
  color: chartColorForIdentity(row.id),
}
```

Render an HTML legend above the plot. Replace the generic Recharts formatter
with a custom tooltip that starts with the full label and includes kind,
overall index, X metric, attempts, and human-readable track names. Render a
custom SVG point shape with stable fill, focus ring, `tabIndex={0}`, and an
`aria-label` carrying the same identity and metrics. Keep the HTML accessible
data disclosure.

- [ ] **Step 5: Correct terminology and contrast**

Use `Overall index` in chart titles, descriptions, Y axis, tooltip, and data
table. Set explicit theme-token strokes/fills:

```tsx
<CartesianGrid stroke="var(--border)" strokeDasharray="3 3" />
<XAxis tick={{ fill: "var(--muted-foreground)", fontSize: 12 }} />
<YAxis tick={{ fill: "var(--muted-foreground)", fontSize: 12 }} />
```

Do not call the cross-track value `Verified quality`.

- [ ] **Step 6: Run UI tests and commit**

Run:

```powershell
npx tsx scripts/test-benchmark-decision-dashboard-ui.mts
npm run test:benchmark:decision
```

Expected: both commands pass.

```powershell
git add components/benchmark/chart-utils.tsx components/benchmark/results/DecisionTradeoffCharts.tsx scripts/test-benchmark-decision-dashboard-ui.mts
git commit -m "fix(benchmark): identify tradeoff chart points accessibly"
```

---

### Task 5: Responsive leaderboard cards and evidence explanations

**Files:**

- Modify: `components/benchmark/results/DecisionLeaderboard.tsx`
- Modify: `components/benchmark/results/ModelEvidenceProfile.tsx`
- Modify: `scripts/test-benchmark-decision-dashboard-ui.mts`

**Interfaces:**

- Keeps: `DecisionLeaderboard({ rows, sortKey, onSortKeyChange })`
- Consumes: `row.failureDetails` and `row.teamLiftTracks`

- [ ] **Step 1: Write failing rendered responsive/profile tests**

Render `DecisionLeaderboard` and `ModelEvidenceProfile` with literal solo,
team, and failed-budget rows. Assert the rendered markup and visible text:

- The desktop table wrapper carries the responsive desktop class.
- A mobile stacked-card list carries the complementary mobile class and
  renders every row.
- Mobile cards show full wrapping labels, overall index, pass range, coverage,
  reliability, tokens/pass, time/pass, and the profile action.
- The profile label is `Overall index`, not `Overall quality`.
- The profile states that represented tracks receive equal weight and missing
  tracks are not zero.
- Failed rows render a visible failure summary.
- A budget failure renders its certified message.
- A team with no `teamLiftTracks` renders `Not comparable`.

- [ ] **Step 2: Run the rendered UI tests and verify failure**

Run:

```powershell
npx tsx scripts/test-benchmark-decision-dashboard-ui.mts
```

Expected: the mobile card path, failure summary, and corrected copy are absent.

- [ ] **Step 3: Add a stacked mobile leaderboard**

Keep the existing table inside a `hidden overflow-x-auto md:block` wrapper.
Add a semantic list with `md:hidden`; each card must include:

```tsx
<h3 className="break-words text-base font-semibold">{row.label}</h3>
<Badge>{row.isTeam ? "Team" : "Solo"}</Badge>
```

Render the same core metrics as the desktop row, using a two-column definition
grid. Use the existing profile toggle state and `aria-controls` for both
layouts. Place the expanded profile immediately after the selected mobile card.

- [ ] **Step 4: Surface failure provenance and comparability**

When `row.failureDetails.length > 0`, render an amber/red evidence notice that
groups failures by track and shows the persisted failure message. If no
persisted message exists but the latest status is `failed_budget`, render
`Certified budget exhausted before this track completed.`

When a team has `teamLift == null`, show `Not comparable` and
`Run the same track solo and as a team.` Do not format unavailable lift as
`+0.0`.

- [ ] **Step 5: Explain the index in the profile**

Rename the top metric to `Overall index`. Above the per-track cards, add:

```text
Certified Index v1.0 averages these per-track scores with equal weight.
Missing tracks are not scored as zero.
```

Show passed/attempt counts and budget-failure counts in each track card. List
deduplicated certified failure messages below track coverage. Preserve the
existing provider, effort, case-title, uncertainty, and keyboard-focus
behavior.

- [ ] **Step 6: Run UI and decision regression tests, then commit**

Run:

```powershell
npx tsx scripts/test-benchmark-decision-dashboard-ui.mts
npm run test:benchmark:decision
```

Expected: all commands print `PASS`.

```powershell
git add components/benchmark/results/DecisionLeaderboard.tsx components/benchmark/results/ModelEvidenceProfile.tsx scripts/test-benchmark-decision-dashboard-ui.mts
git commit -m "fix(benchmark): make result evidence responsive and explicit"
```

---

### Task 6: Full regression and Chrome verification

**Files:**

- Modify only files required to resolve verified regressions.

**Interfaces:**

- Consumes the completed behavior from Tasks 1–5.
- Produces a clean production build and browser-verified result surface.

- [ ] **Step 1: Run focused benchmark suites**

Run:

```powershell
npm run test:benchmark:unit
npm run test:benchmark:tracks
npm run test:benchmark:e2e
```

Expected: every script exits 0.

- [ ] **Step 2: Run lint and production build**

Confirm no development server is using the worktree's `.next` directory, then
run:

```powershell
npm run lint
npm run build
```

Expected: both commands exit 0. If a dev server is started afterward, start it
only after the build completes.

- [ ] **Step 3: Inspect the complete diff**

Run:

```powershell
git diff --check HEAD~5..HEAD
git status --short
git log --oneline -7
```

Verify no certified evidence files, user storage, provider routing, WorkBench
engine code, or unrelated application files changed.

- [ ] **Step 4: Run local UI in Chrome**

Start the app on an unused localhost port, open `/benchmark` using Chrome
control, and verify at desktop width:

- WorkBench verdict reads `Best WorkBench team`.
- The historical failed TeamIQ row explains its budget failure.
- Team lift is `Not comparable` for disjoint evidence.
- Both charts show a visible stable model/team legend.
- Hover and keyboard focus identify the full model/team and metrics.
- Axis and tooltip copy say `Overall index`.
- No console errors appear.

- [ ] **Step 5: Verify mobile Chrome behavior**

At approximately 390 CSS pixels:

- Leaderboard uses stacked cards with no 980-pixel overflow.
- Full model/team names remain readable.
- Profile toggles work by keyboard and pointer.
- Failure messages and index explanation fit without clipping.
- Charts and accessible data remain usable.

- [ ] **Step 6: Stop the local server and commit any verified fix-only changes**

If browser or regression verification required changes, rerun the affected
focused test and:

```powershell
git add <only-the-verified-fix-files>
git commit -m "fix(benchmark): resolve results verification findings"
```

Do not commit generated `.next` or benchmark storage artifacts.
