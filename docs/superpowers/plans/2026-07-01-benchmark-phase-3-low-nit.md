# Benchmark Fixes — Phase 3 (Low / Nit polishes) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Apply the 51 low/nit polishes across the benchmark feature: correctness tidies (tie-breaker, timeout classifier, plain SEARCH/REPLACE), scoring/statistical refinements (sample-size guards, latency factor, redundant axes), accessibility (chart data-table alternatives, aria-sort, keyboard selection, colorblind-safe palette), formatting consistency (verifiedQuality units, sign-explicit badges), and dead-manifest cleanup.

**Architecture:** Fully client-side Next.js 15 app (App Router, React 19, TS strict, static export — no backend). Benchmark logic in `lib/benchmark/**`, UI in `components/benchmark/**`. These are surgical, mostly independent fixes; each task is self-contained.

**Tech Stack:** TypeScript, React 19, Next 15. **No test runner** — tests are plain `tsx` scripts under `scripts/test-*.mts` using a local `check(name, ok, detail?)` helper that prints `PASS`/`FAIL`, ending with `process.exit(failures === 0 ? 0 : 1)`; run via `npx tsx scripts/test-<name>.mts`. Lint via `npm run lint`; type-check via `npx tsc --noEmit` (do NOT `npm run build` while the dev server runs — it corrupts `.next`). Test scripts use **relative** imports.

**Severity:** All tasks here are **low / nit polish**. Many are explicitly optional — each is marked, and the lowest-risk option is chosen. Several are dead-manifest cleanups (delete or add a drift-guard test), not behavior changes.

**Prerequisite:** Phase 1 should be merged first (some files overlap — e.g. `redaction.ts`, `metrics.ts`, `build-adapter.ts`, `workbench.ts`). Rebase on Phase 1 before starting.

---

---

## Build leaderboard

### Task: Fix Build leaderboard tie-breaker so ties always resolve highest-quality-first

**Severity:** low · **Category:** correctness

**Files:**
- Modify: `components/benchmark/BuildLeaderboardShared.ts` (extract a pure `compareBuildStats` comparator)
- Modify: `components/benchmark/BuildLeaderboard.tsx:103-121` (use the extracted comparator)
- Test: `scripts/test-build-leaderboard-sort.mts` (new — no existing test imports `model-stats`/the comparator)

**Problem:** In `BuildLeaderboard.tsx` the tie-break (`cmp = qualityScore(b) - qualityScore(a)`) is computed before the direction flip `sortDir === "asc" ? cmp : -cmp`, so the negation is applied to the tie-break too. In the default DESC case a tie resolves to `qualityScore(a) - qualityScore(b)` — lowest-quality model ranked first within the tie group; ASC and DESC disagree.

**Change:** Apply the primary sort direction to the primary comparison *before* the tie-break, so the tie-break stays direction-independent (always highest-quality-first). Because the comparator lives inline in a `.tsx` React component (untestable via a tsx script), extract it into the existing pure-helper module `BuildLeaderboardShared.ts` and import it.

In `components/benchmark/BuildLeaderboardShared.ts`, add (it can import the pure metric helpers and the type — no React):

```ts
import type { ModelBuildStat } from "@/lib/db/schema";
import { qualityScore } from "@/lib/client/model-stats";

export type SortDir = "asc" | "desc";

/**
 * Direction is applied to the PRIMARY comparison before the tie-break, so the
 * tie-break (highest qualityScore first) is direction-independent. Nulls sort
 * last in both directions (pre-existing behavior).
 */
export function compareBuildStats(
  a: ModelBuildStat,
  b: ModelBuildStat,
  sortValue: (s: ModelBuildStat) => number | string | null,
  sortDir: SortDir,
): number {
  const va = sortValue(a);
  const vb = sortValue(b);
  if (va == null && vb == null) return 0;
  if (va == null) return 1;
  if (vb == null) return -1;
  let cmp =
    typeof va === "string" || typeof vb === "string"
      ? String(va).localeCompare(String(vb))
      : va - vb;
  if (sortDir === "desc") cmp = -cmp;
  if (cmp === 0) cmp = qualityScore(b) - qualityScore(a);
  return cmp;
}
```

Then in `components/benchmark/BuildLeaderboard.tsx`, replace the inline `list.sort` body (lines 105-119) with:

```ts
list.sort((a, b) =>
  compareBuildStats(a, b, (s) => sortValue(s, sortKey), sortDir),
);
```

and add `compareBuildStats` (and `SortDir`) to the existing import from `@/components/benchmark/BuildLeaderboardTable`/`...Shared`. Drop the local `type SortDir = "asc" | "desc";` (line 33) in favor of the exported one, or keep it — but import the comparator. Note the null-handling (sort nulls last regardless of direction) is preserved deliberately and is out of scope.

- [ ] Write the failing test `scripts/test-build-leaderboard-sort.mts`: a `check(name, ok, detail?)` helper (PASS/FAIL per line), a `makeStat(partial)` factory producing a full `ModelBuildStat`, then two stats tied on `approvalRate` but differing on `qualityScore` (e.g. A: `wApprovals:1` so qualityScore=3; B: `wApprovals:2` so qualityScore=6; both `approvals:1, attempts:1` so approvalRate=1). Assert:
  ```ts
  const sorted = [a, b].slice().sort((x, y) =>
    compareBuildStats(x, y, (s) => approvalRate(s), "desc"));
  check("desc tie -> higher quality first", sorted[0] === b, `got ${sorted[0].modelId}`);
  const sortedAsc = [a, b].slice().sort((x, y) =>
    compareBuildStats(x, y, (s) => approvalRate(s), "asc"));
  check("asc tie -> higher quality first too", sortedAsc[0] === b);
  ```
  End with `console.log(failures === 0 ? "PASS" : \`FAIL (${failures})\`)` and `process.exit(failures === 0 ? 0 : 1)`. Use RELATIVE imports: `../components/benchmark/BuildLeaderboardShared` and `../lib/client/model-stats`.
- [ ] Run `npx tsx scripts/test-build-leaderboard-sort.mts`, expect FAIL (write the test against the new `compareBuildStats` after extraction, or first assert against a copy of the old inline logic to confirm the bug reproduces, then extract).
- [ ] Extract `compareBuildStats` into `BuildLeaderboardShared.ts` and wire `BuildLeaderboard.tsx` to it (edits above).
- [ ] Run `npx tsx scripts/test-build-leaderboard-sort.mts`, expect PASS.
- [ ] Run `npm run lint`.
- [ ] Commit: `fix(benchmark): resolve Build leaderboard ties highest-quality-first in both sort directions`

> Sequencing: This task and "Always render Availability as a percent" can both touch how the availability column behaves, but they edit different files (`BuildLeaderboardShared.ts`/`BuildLeaderboard.tsx` here vs `BuildModelRow.tsx` there) — no collision. The new `scripts/test-build-leaderboard-sort.mts` is the natural home to also extend with the availability assertion in that task.

### Task: Always render the Availability column as a percent so it matches its numeric sort key

**Severity:** low · **Category:** ux

**Files:**
- Modify: `components/benchmark/BuildModelRow.tsx:42`
- Test: `scripts/test-build-leaderboard-sort.mts` (extend — same module group as the sort task)

**Problem:** `BuildModelRow.tsx:42` renders `"-"` for models with `unavailable === 0`, but the comparator sorts those same rows by `availability(s) === 1.0` (the maximum). Sorting the Avail. column descending floats the `"-"` rows above real percentages like `67%`, looking broken.

**Change:** In `components/benchmark/BuildModelRow.tsx:42` replace

```ts
const availText = s.unavailable > 0 ? pct(availability(s)) : "-";
```

with

```ts
const availText = pct(availability(s));
```

`availability(s)` is never null for displayed rows (all have `attempts > 0`), so this yields `"100%"` for clean models; `pct()` still safely returns `"-"` for the theoretical null. The highest-sorted rows no longer show a dash.

- [ ] Extend `scripts/test-build-leaderboard-sort.mts` with a display assertion exercising the real helpers (import `availability` and `pct` via relative paths):
  ```ts
  const clean = makeStat({ attempts: 4, unavailable: 0, approvals: 4 });
  check("clean model availability renders 100%", pct(availability(clean)) === "100%");
  ```
- [ ] Run `npx tsx scripts/test-build-leaderboard-sort.mts`, expect FAIL only if you also assert the old branch — otherwise this assertion documents the desired output; run before the edit to confirm `availability`/`pct` produce `"100%"`.
- [ ] Make the one-line edit in `BuildModelRow.tsx:42`.
- [ ] Run `npx tsx scripts/test-build-leaderboard-sort.mts`, expect PASS.
- [ ] Run `npm run lint`.
- [ ] Commit: `fix(benchmark): render Build leaderboard availability as percent to match sort key`

### Task: Show an "Ungraded / in-flight" segment in the Build outcome bar so it fills to 100% (optional polish)

**Severity:** low · **Category:** ux

**Files:**
- Modify: `components/benchmark/BuildModelDetail.tsx:12-17` (SEGMENTS), `:29-36` (counts/total)
- Test: `scripts/test-build-outcome-bar.mts` (new) — assert segment widths sum to 100% when `attempts > approvals+fixes+badOutput+unavailable`

**Problem:** The segmented outcome bar normalizes each segment by `s.attempts`, but `attempts` can exceed `approvals + fixes + badOutput + unavailable` (assignments that never reached a verdict). The four colored segments then sum to less than 100%, leaving an unlabeled empty slice with no legend entry.

**Change:** Preserve the reliability signal (the codebase deliberately keeps `attempts` as the denominator) by adding an explicit fifth "Ungraded" segment with the muted track color so the bar visibly fills and the legend sums to `attempts`.

In `components/benchmark/BuildModelDetail.tsx`, append to `SEGMENTS` (after the `unavailable` entry, line 16):

```ts
{ key: "ungraded", label: "Ungraded", className: "bg-muted-foreground/20" },
```

and extend the `counts` map (computed after `total`, since the count depends on `total`). Reorder so `total` is computed first, then build `counts` including `ungraded`:

```ts
const graded = s.approvals + s.fixes + s.badOutput + s.unavailable;
const total = s.attempts || graded;
const counts: Record<string, number> = {
  approved: s.approvals,
  fixes: s.fixes,
  badOutput: s.badOutput,
  unavailable: s.unavailable,
  ungraded: Math.max(0, total - graded),
};
```

The existing `if (w <= 0) return null;` guard already hides the ungraded segment when it is zero, so models with no in-flight attempts are visually unchanged. (Simpler alternative from the fix — denominating `total` on the sum of the four known outcomes — is rejected because it loses the attempts-vs-graded distinction the lab tracks.)

- [ ] Write the failing test `scripts/test-build-outcome-bar.mts`. Extract a tiny pure helper for the bar math (e.g. export a `function outcomeSegmentCounts(s: ModelBuildStat): { total: number; counts: Record<string, number> }` from `BuildLeaderboardShared.ts`, or replicate the formula in the test with the SEGMENTS list). Assert with a stat where `attempts=5, approvals=2, fixes=1, badOutput=0, unavailable=1`:
  ```ts
  const { total, counts } = outcomeSegmentCounts(makeStat({ attempts: 5, approvals: 2, fixes: 1, unavailable: 1 }));
  const sum = Object.values(counts).reduce((a, c) => a + c, 0);
  check("counts include ungraded and sum to attempts", sum === total && counts.ungraded === 1);
  ```
- [ ] Run `npx tsx scripts/test-build-outcome-bar.mts`, expect FAIL.
- [ ] Apply the `SEGMENTS` + `counts`/`total` edits in `BuildModelDetail.tsx` (and the shared helper if you extracted one).
- [ ] Run `npx tsx scripts/test-build-outcome-bar.mts`, expect PASS.
- [ ] Run `npm run lint`.
- [ ] Commit: `feat(benchmark): add ungraded segment to Build outcome bar so it fills to 100%`

---

Grounding notes (file paths absolute):
- `C:\Users\b_a_s\source\repos\ai-discussion-board\components\benchmark\BuildLeaderboard.tsx` — comparator inline at lines 103-121; `sortValue` at 35-56; verified the `sortDir === "asc" ? cmp : -cmp` flip at line 118 negates the line-117 tie-break.
- `C:\Users\b_a_s\source\repos\ai-discussion-board\components\benchmark\BuildModelRow.tsx` — line 42 confirmed verbatim: `const availText = s.unavailable > 0 ? pct(availability(s)) : "-";`.
- `C:\Users\b_a_s\source\repos\ai-discussion-board\components\benchmark\BuildModelDetail.tsx` — `SEGMENTS` (12-17), `counts`/`total` (29-36), width math `(counts[seg.key] / total) * 100` (54) with `if (w <= 0) return null;` guard (55).
- Pure helpers (`qualityScore`, `availability`, `approvalRate`, `qualityPerAttempt`, `charsPerSecond`) live in `C:\Users\b_a_s\source\repos\ai-discussion-board\lib\client\model-stats.ts`; `pct`/`round`/`BUILD_LEADERBOARD_COLUMNS`/`BuildSortKey` in `C:\Users\b_a_s\source\repos\ai-discussion-board\components\benchmark\BuildLeaderboardShared.ts` (plain `.ts`, the testable extraction target). `ModelBuildStat` shape at `lib\db\schema.ts:376-398`. No existing test script imports `model-stats` or these comparators, so the sort/availability tests are new (sharing `scripts/test-build-leaderboard-sort.mts`).

---

## Lab metrics / store / aggregate

### Task: Fix daily quality-trend denominator to use per-participant samples
**Severity:** low · **Category:** scoring-validity

**Files:**
- Modify: `lib/benchmark/metrics.ts:114-119` (BenchmarkTrendRow), `:1084` (trendFor init), `:888` (numerator increment), `:389-392` (finalization)
- Test: `scripts/test-benchmark-scoring.mts` (extend; it already imports `buildBenchmarkDashboardData`)

**Problem:** `trend.quality` adds one term per AI participant (2 for chess/connect-four, 4 for codenames) but the finalizer divides by `trend.games + trend.buildAttempts` (one per match plus build calls). A 2-player decisive match adds `100+0` over a denominator increment of 1 -> renders as 100 instead of ~50; 4-player codenames inflates further, and build-heavy days drag quality toward 0.

**Change:** Add a per-day `qualitySamples` counter that increments once per participant alongside the existing numerator term, and divide by it.

`BenchmarkTrendRow` (metrics.ts:114-119):
```ts
export interface BenchmarkTrendRow {
  date: string;
  games: number;
  buildAttempts: number;
  quality: number;
  qualitySamples: number; // add
}
```
`trendFor` init (metrics.ts:1084):
```ts
const created = { date, games: 0, buildAttempts: 0, quality: 0, qualitySamples: 0 };
```
Numerator increment in `addGameMatch` (metrics.ts:888) — add the sample bump right beside it:
```ts
trend.qualitySamples += 1;
trend.quality += isDraw ? 50 : winnerId === participant.id ? 100 : 0;
```
Finalization (metrics.ts:389-392) — drop `games`/`buildAttempts` from the quality divisor:
```ts
for (const trend of trends.values()) {
  trend.quality = trend.qualitySamples > 0 ? trend.quality / trend.qualitySamples : 0;
}
```
Keep `trend.games`/`trend.buildAttempts` untouched for the separate Games / Build-attempts trend lines.

**Sequencing:** This and the codenames head-to-head task both edit `addGameMatch`; land the codenames win-attribution fix first if doing both, since it changes `winnerId === participant.id` outcomes that this task's numerator reads. The `qualitySamples` field add here is additive and independent.

- [ ] Extend `scripts/test-benchmark-scoring.mts`: build a one-day input with two 2-player decisive matches (one win each) plus one draw via `buildBenchmarkDashboardData`, then `check("trend quality is mean participant outcome on 0-100 scale", Math.abs(data.trendRows[0].quality - 50) < 1e-6, data.trendRows)`. Add a build-attempt checkpoint on the same date and assert quality is unchanged by it.
- [ ] Run `npx tsx scripts/test-benchmark-scoring.mts`, expect FAIL (currently ~100, and build attempts drag it down).
- [ ] Apply the four edits above.
- [ ] Run `npx tsx scripts/test-benchmark-scoring.mts`, expect PASS.
- [ ] Run `npm run lint`.
- [ ] Commit: `fix(benchmark): compute daily quality trend as per-participant mean`

### Task: Stop folding the continuous "quality" metric into the verifier pass count
**Severity:** low · **Category:** scoring-validity

**Files:**
- Modify: `lib/benchmark/metrics.ts:353`
- Test: `scripts/test-benchmark-scoring.mts` (extend)

**Problem:** In the metric loop (metrics.ts:350-362), `if (metric.key === "quality") score.verifierPasses += metric.value;` adds an arbitrary continuous `BenchmarkMetricValue.value` (e.g. 87) onto a pure count, which then feeds the `verifierPassRate` denominator (metrics.ts:939-942) and skews it toward 1.0. No live code currently writes a `key === "quality"` metric, so the bug is latent but wired into the live dashboard.

**Change:** Delete the single line at metrics.ts:353. The minimal correct fix per the recipe — `verifierPasses`/`verifierFailures` stay pure counts. Keep the surrounding `addEvidence` call (it still surfaces the metric in the evidence panel). Do not add the separate `qualityMetricSum` axis unless/until a real writer exists.

Before:
```ts
const score = scoreFor(metric.modelId);
if (metric.key === "quality") score.verifierPasses += metric.value;
addEvidence(evidenceByModel, metric.modelId, {
```
After:
```ts
const score = scoreFor(metric.modelId);
addEvidence(evidenceByModel, metric.modelId, {
```

**Sequencing:** Same file/function-adjacent as the trend task but a different loop; no collision.

- [ ] Extend `scripts/test-benchmark-scoring.mts`: feed `benchmarkMetricValues: [{ id:"m1", modelId:"x", domain:"build", key:"quality", label:"Quality", value:87, direction:"higher" }]` together with one build stat giving the model exactly 1 verifier pass + 1 failure, through `buildBenchmarkDashboardData`; `check("quality metric does not inflate verifierPassRate", model.verifierPassRate === 0.5, model)`.
- [ ] Run `npx tsx scripts/test-benchmark-scoring.mts`, expect FAIL (rate skewed by +87).
- [ ] Delete metrics.ts:353.
- [ ] Run `npx tsx scripts/test-benchmark-scoring.mts`, expect PASS.
- [ ] Run `npm run lint`.
- [ ] Commit: `fix(benchmark): keep verifierPasses a pure count, not a quality-metric sum`

### Task: Make head-to-head and win attribution work for codenames team games
**Severity:** low · **Category:** scoring-validity

**Files:**
- Modify: `lib/benchmark/metrics.ts:885-888` (per-model win/loss) and `:903-927` (head-to-head block)
- Test: `scripts/test-benchmark-scoring.mts` (extend; exercises `buildBenchmarkDashboardData`)

**Problem:** Codenames matches have 4 AI participants with ids `red-spymaster`/`red-operative`/`blue-spymaster`/`blue-operative` and a `resultJson.winner` of `"red"`/`"blue"` (confirmed in `lib/games/codenames/benchmark.ts:136-175`). The win loop tests `winnerId === participant.id`, which never matches a team token, so every codenames participant is marked a loss; and the head-to-head block gates on `aiParticipants.length === 2`, so codenames produces no head-to-head row at all.

**Change:** Resolve the winning participant by id-or-team-prefix, and pair head-to-head on the set of distinct team models rather than raw participant count.

Add a helper near `addGameMatch` (metrics.ts ~841):
```ts
function participantWon(
  participant: GameParticipant,
  winnerId: string | null
): boolean {
  if (!winnerId) return false;
  // exact id (2-player games) or team-prefix (e.g. winner "red" -> "red-spymaster")
  return participant.id === winnerId || participant.id.startsWith(`${winnerId}-`);
}
```
In the per-model loop replace both uses of `winnerId === participant.id` (metrics.ts:886 and :888) and the evidence summary at :898 with `participantWon(participant, winnerId)`.

Replace the head-to-head block (metrics.ts:903-927) to key on distinct models:
```ts
const distinctModels = [
  ...new Set(aiParticipants.map((p) => p.modelId).filter((m): m is string => Boolean(m))),
];
if (distinctModels.length === 2) {
  const [m1, m2] = distinctModels;
  const key = [m1, m2].sort().join("::");
  const row =
    input.headToHead.get(key) ??
    createHeadToHeadRow(m1, m2, displayModelName(m1), displayModelName(m2));
  row.games += 1;
  const winnerParticipant = aiParticipants.find((p) => participantWon(p, winnerId));
  const winningModelId = winnerParticipant?.modelId ?? null;
  if (isDraw || !winningModelId) row.draws += 1;
  else if (winningModelId === row.modelA) row.modelAWins += 1;
  else row.modelBWins += 1;
  input.headToHead.set(key, row);
}
```
`GameParticipant` is already imported transitively via `GenericGameMatchRecord`; add an explicit `import type { GameParticipant } from "@/lib/games/core/types"` if the helper needs it.

**Sequencing:** Touches the same `addGameMatch` numerator line (:888) as the quality-trend task — land this first so the trend task's `qualitySamples` bump sits beside the corrected `participantWon(...)` expression.

- [ ] Extend `scripts/test-benchmark-scoring.mts`: construct a codenames `GenericGameMatchRecord` (4 participants as above, `redModel`/`blueModel` distinct, `resultJson` winner `"red"`); run `buildBenchmarkDashboardData`. `check("codenames red model recorded a win", redModelScore.wins === 2 && redModelScore.losses === 0, redModelScore)` (2 red participants), `check("codenames head-to-head row exists", data.headToHeadRows.length === 1, data.headToHeadRows)`, and assert the row credits the red model's win.
- [ ] Run `npx tsx scripts/test-benchmark-scoring.mts`, expect FAIL (all losses, zero head-to-head rows).
- [ ] Apply the helper + two edits.
- [ ] Run `npx tsx scripts/test-benchmark-scoring.mts`, expect PASS.
- [ ] Run `npm run lint`.
- [ ] Commit: `fix(benchmark): attribute codenames wins and head-to-head by team model`

### Task: Bound evidenceByModel growth with a per-model most-recent cap
**Severity:** low · **Category:** performance · **(optional polish)**

**Files:**
- Modify: `lib/benchmark/metrics.ts:1116-1123` (addEvidence)
- Test: `scripts/test-benchmark-scoring.mts` (extend)

**Problem:** `addEvidence` pushes one item per build stat, usage row, problem, game match, metric, and failure — each carrying a full `JSON.stringify(record, null, 2)` body — with no per-model cap, so a long-lived store builds a large structure on every synchronous dashboard load.

**Change:** Cap retained items per model to the most-recent N (use 50) by trimming oldest after each push. Lowest-risk option from the recipe (the cap, not the compact-reference rewrite). Items aren't guaranteed timestamp-ordered, so sort-then-trim by `timestamp`.

```ts
const EVIDENCE_PER_MODEL_CAP = 50;

function addEvidence(
  target: Record<string, BenchmarkEvidenceItem[]>,
  modelId: string,
  item: BenchmarkEvidenceItem
): void {
  const list = (target[modelId] ??= []);
  list.push(item);
  if (list.length > EVIDENCE_PER_MODEL_CAP) {
    list.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
    list.length = EVIDENCE_PER_MODEL_CAP;
  }
}
```

- [ ] Extend `scripts/test-benchmark-scoring.mts`: feed >50 build-usage rows for one model (e.g. 60 checkpoints) through `buildBenchmarkDashboardData`; `check("evidence is capped per model", data.evidenceByModel[modelId].length <= 50, data.evidenceByModel[modelId].length)` and assert the newest-timestamp item is retained.
- [ ] Run `npx tsx scripts/test-benchmark-scoring.mts`, expect FAIL (length 60).
- [ ] Apply the cap.
- [ ] Run `npx tsx scripts/test-benchmark-scoring.mts`, expect PASS.
- [ ] Run `npm run lint`.
- [ ] Commit: `perf(benchmark): cap per-model evidence to most-recent 50 items`

### Task: Pass per-attempt cost/duration (not per-pass) as the team-lift cost basis
**Severity:** low · **Category:** correctness

**Files:**
- Modify: `lib/benchmark/scoring/aggregate.ts:294-297` (the `scoreTeamLift` call inside `applyTeamLift`)
- Test: `scripts/test-benchmark-scoring.mts` (extend; it already imports `scoreTeamLift` and `aggregateCertifiedRunScores`)

**Problem:** `TeamLiftScoreInput` fields are named `teamCostUsd`/`bestSoloCostUsd`/`teamDurationMs`/`bestSoloDurationMs` (scoring/types.ts:61-67), but `applyTeamLift` passes per-pass values `row.costPerPass`/`row.speedPerPassMs`, which are `null` whenever `passed === 0` (finalizeGroup:257-264). `adjustedLift` returns `null` for null inputs, so cost/speed-adjusted lift silently degrades to raw `teamLift` and the `"wasteful"` label (teamiq.ts:43-50) can never fire for a zero-pass team that cost more than its best solo. (Note the TeamIQ baselines caller at `lib/benchmark/teamiq/baselines.ts:70-73` already correctly passes `costUsd`/`durationMs` — the mismatch is specific to this aggregate.ts caller.)

**Change:** Pass the always-available per-attempt averages, which are non-null whenever cost/duration samples exist:
```ts
const lift = scoreTeamLift({
  teamScore: row.jobSuccessScore,
  memberSoloScores: soloRows.map((solo) => solo.jobSuccessScore),
  teamCostUsd: row.averageCostUsd,
  bestSoloCostUsd: bestSolo.averageCostUsd,
  teamDurationMs: row.durationMs,
  bestSoloDurationMs: bestSolo.durationMs,
});
```
(`averageCostUsd` and `durationMs` are both on `CertifiedRunScore` — types.ts:112-113.)

**Sequencing:** Same file as the minimum-sample-size task but a different function (`applyTeamLift` vs `rankByVerifiedQuality`/recommendation layer); no textual overlap.

- [ ] Extend `scripts/test-benchmark-scoring.mts`: build a 2-model team that never passes (passed=0) but whose `averageCostUsd` exceeds each member's best-solo `averageCostUsd`, with full solo baselines, and run `aggregateCertifiedRunScores`; `check("zero-pass costly team is labeled wasteful", teamRow.teamLiftLabel === "wasteful", teamRow)`.
- [ ] Run `npx tsx scripts/test-benchmark-scoring.mts`, expect FAIL (per-pass cost is null -> label not "wasteful").
- [ ] Apply the edit.
- [ ] Run `npx tsx scripts/test-benchmark-scoring.mts`, expect PASS.
- [ ] Run `npm run lint`.
- [ ] Commit: `fix(benchmark): use per-attempt cost/duration as team-lift basis so zero-pass teams are graded`

### Task: Flag low-sample certified rows and keep them out of headline recommendations
**Severity:** low · **Category:** scoring-validity · **(optional polish)**

**Files:**
- Modify: `lib/benchmark/teamiq/recommendations.ts:26` (recommendation-card eligibility) and the Pareto input at `lib/benchmark/metrics.ts:457` / `lib/benchmark/teamiq/combo-matrix.ts:216`; optional badge in `components/benchmark/CertifiedLeaderboard.tsx`
- Test: `scripts/test-teamiq-recommendations.mts` (extend; existing recommendations test)

**Problem:** A team/model with a single certified attempt gets `verifiedPassRate` of 0 or 1 and a fully-weighted `verifiedQuality`, indistinguishable from a model measured over hundreds of attempts, yet it can top `buildTeamIqRecommendationCards` (`maxBy(teams, (row) => row.verifiedQuality)`) and enter the Pareto frontier purely from variance. Per the recipe this is a stat-validity concern, and the lowest-risk honest fix is to exclude sub-threshold rows from the headline cards/frontier and visually flag them — not to mutate raw averages or gate the full leaderboard sort.

**Change:** Add a `MIN_CONFIDENT_ATTEMPTS = 3` constant and tighten the recommendation-card team filter (recommendations.ts:26):
```ts
export const MIN_CONFIDENT_ATTEMPTS = 3;
// ...
const teams = rows.filter((row) => !row.isSolo && row.attempts >= MIN_CONFIDENT_ATTEMPTS);
```
For the Pareto frontier, filter the candidate list before `computeParetoFrontier` at the two call sites (metrics.ts:457 leaderboard input and combo-matrix.ts:216 candidates) to `row.attempts >= MIN_CONFIDENT_ATTEMPTS`, falling back to the unfiltered list only if the filter would empty it (so sparse all-low-n datasets still show something). Do NOT change `finalizeGroup`'s averages or `rankByVerifiedQuality` ordering (higher-risk for sparse data, explicitly out of scope per the recipe). Optionally add a muted "preliminary · n<3" badge next to the Scored column in `CertifiedLeaderboard.tsx`, since `attempts` is already rendered there.

**Sequencing:** Shares `lib/benchmark/scoring/aggregate.ts`-adjacent consumers with the team-lift-basis task but edits different files (recommendations/combo-matrix/metrics call-sites); no line collision.

- [ ] Extend `scripts/test-teamiq-recommendations.mts`: include one team with `attempts: 1` and a perfect `verifiedQuality` alongside a team with `attempts: 5` and slightly lower quality; `check("best-quality card ignores n<3 team", bestQualityCard.teamCompositionId === fiveAttemptTeam.id, bestQualityCard)`.
- [ ] Run `npx tsx scripts/test-teamiq-recommendations.mts`, expect FAIL (single-attempt team wins the card).
- [ ] Apply the constant + filter (and Pareto-input filter with empty-guard fallback).
- [ ] Run `npx tsx scripts/test-teamiq-recommendations.mts`, expect PASS.
- [ ] Run `npm run lint`.
- [ ] Commit: `fix(benchmark): exclude low-sample rows from headline recommendations and Pareto frontier`

### Task: Document or remove the redundant build-derived radar axes (badOutput triple-count)
**Severity:** low · **Category:** scoring-validity · **(optional polish)**

**Files:**
- Modify: `lib/benchmark/metrics.ts:264-269` (comment only)
- Test: none (documentation-only)

**Problem:** A single build `badOutput` event is fanned into three denominators — `schemaInvalid` (:265), `toolInvalid` (:267), and `verifierFailures` (:269) — and a fix counts as both a verifier failure and structured/tool VALID. So `structuredOutputScore`, `toolUseScore`, and `verifierPassRate` are near-perfectly correlated by construction for build-derived rows rather than measuring distinct capabilities. There is no independent schema-parse vs tool-apply vs verifier signal available from `ModelBuildStat` today, so genuinely separating the axes is out of scope.

**Change:** Document-only (the lowest-risk option the fix permits). Add a comment above metrics.ts:264 making the shared-source nature explicit so the radar is not read as three independent dimensions:
```ts
// NOTE: build stats expose only approvals/fixes/badOutput, so the structured-output,
// tool-use, and verifier axes below are all derived from the same three tallies and
// are correlated by construction for build-derived rows. They are NOT independent
// capability measures. Drive them from separate schema/tool/verifier signals if those
// are ever recorded per-attempt.
score.schemaValid += stat.approvals + stat.fixes;
```
Do not alter the arithmetic (game-derived rows populate these axes independently; removing the build fan-out would zero them for build-only models).

- [ ] No test (comment-only change; document in the commit body that the axes are intentionally derived).
- [ ] Add the comment.
- [ ] Run `npm run lint`.
- [ ] Commit: `docs(benchmark): note build-derived radar axes share one source and aren't independent`

---

Relevant files (all absolute):
- `C:\Users\b_a_s\source\repos\ai-discussion-board\lib\benchmark\metrics.ts` — findings 1,2,3,4,6b,7 (trend 114-119/389-392/888/1084; metric loop 350-353; addGameMatch 885-927; addEvidence 1116-1123; Pareto input 457; build fan-out 264-269)
- `C:\Users\b_a_s\source\repos\ai-discussion-board\lib\benchmark\scoring\aggregate.ts` — finding 5 (applyTeamLift 294-297; ranking 119-129)
- `C:\Users\b_a_s\source\repos\ai-discussion-board\lib\benchmark\scoring\teamiq.ts` & `scoring\types.ts:61-67` — TeamLiftScoreInput field names (finding 5)
- `C:\Users\b_a_s\source\repos\ai-discussion-board\lib\benchmark\teamiq\recommendations.ts:26`, `teamiq\combo-matrix.ts:216` — finding 6 consumers
- `C:\Users\b_a_s\source\repos\ai-discussion-board\lib\games\codenames\benchmark.ts:133-186` & `lib\games\core\types.ts:10-51` — codenames participant/winner encoding (finding 3)
- Tests: `scripts\test-benchmark-scoring.mts` (imports `buildBenchmarkDashboardData`, `aggregateCertifiedRunScores`, `scoreTeamLift`), `scripts\test-teamiq-recommendations.mts`

---

## Certified run engine

### Task: Document that `aborted_user` status is currently unreachable (no cancellation path)
**Severity:** low · **Category:** ux · **(optional polish)**

**Files:**
- Modify: `lib/benchmark/certified/run-engine.ts:190-203` (add a clarifying comment on `statusForRunError`)
- Test: none required (comment-only); optionally extend `scripts/test-benchmark-failure-classification.mts` (already asserts the `aborted_user` taxonomy mapping at lines 113-117, which stays valid)

**Problem:** `aborted_user` is fully wired through the failure taxonomy, score exclusion, and UI labels (`classify-failure`, `model-runner.ts:111-112`, `failures.ts`, `metrics.ts`), implying users can cancel a certified run. In practice nothing creates an `AbortController`/`AbortSignal`, so `statusForRunError` (run-engine.ts:190) can never return `aborted_user` and a long run can only be stopped by reloading the tab. The dead-but-handled abort code misleads maintainers into thinking cancellation exists.

**Change:** Take the lowest-risk option from the fix recipe (document-only). Full cancellation (threading an `AbortSignal` from the panel through `input.runner` → `callCertifiedModel`) and stale-`running`-record reconciliation are deliberately out of scope for this nit — leave them for a dedicated feature. Add a comment above `statusForRunError` noting the gap. Note `statusForRunError` has no `/abort|cancel/` branch today, so it provably cannot emit `aborted_user`:

```ts
// NOTE: `aborted_user` is wired through the failure taxonomy / scoring / UI
// (classify-failure, model-runner, metrics, failures) but is currently
// UNREACHABLE: no certified run path creates an AbortController, so neither
// this classifier nor any runner ever produces it. If/when a Cancel button
// threads an AbortSignal through input.runner -> callCertifiedModel, add an
// /abort|cancel/ branch here returning "aborted_user".
function statusForRunError(message: string): BenchmarkAttemptV2["status"] {
```

- [ ] (No code-behavior change, so no failing test step.) Confirm `scripts/test-benchmark-failure-classification.mts` still passes its existing `aborted_user` taxonomy assertion (lines 113-117) — this guards that the status enum/mapping the comment refers to stays valid: `npx tsx scripts/test-benchmark-failure-classification.mts` → expect PASS.
- [ ] Add the comment above `statusForRunError` (run-engine.ts:190) exactly as above.
- [ ] Re-run `npx tsx scripts/test-benchmark-failure-classification.mts` → expect PASS (unchanged).
- [ ] Run `npm run lint`.
- [ ] Commit: `docs(certified): note aborted_user status is currently unreachable`

---

### Task: Classify provider call timeouts via a shared `classifyProviderFailureMessage` helper so "timed out" maps to `provider_unavailable`
**Severity:** low · **Category:** correctness

**Files:**
- Modify: `lib/benchmark/certified/run-engine.ts:190-203` (`statusForRunError`)
- Modify: `lib/benchmark/workbench/executor.ts:398-410` (`classifyBuildFailure`) — shares the identical buggy `/timeout/` literal
- New: `lib/benchmark/certified/classify-provider-failure.ts` (one shared, exported predicate) — so the two regexes can't drift again
- Test: extend `scripts/test-benchmark-failure-classification.mts`

**Problem:** The per-call timeout throws `Certified model call timed out after ${timeoutMs}ms.` (model-call.ts:350). When that bubbles to the run level, `statusForRunError` tests `/provider|api key|unauthorized|rate.?limit|quota|429|502|503|timeout/` — which does NOT match the substring "timed out" — so it falls through to `invalid_harness`, blaming AI Board for a provider/network stall. `classifyBuildFailure` (executor.ts:400) has the same gap. Both statuses are score-excluded, so the leaderboard is unaffected; only the accountability attribution shown to the user is wrong.

**Change:** Introduce one shared predicate and reuse it in both classifiers so the regex lives in exactly one place. Create `lib/benchmark/certified/classify-provider-failure.ts`:

```ts
const PROVIDER_FAILURE_PATTERN =
  /provider|api key|unauthorized|rate.?limit|quota|429|502|503|timed?\s?out|timeout/;

export function isProviderFailureMessage(message: string): boolean {
  return PROVIDER_FAILURE_PATTERN.test(message.toLowerCase());
}
```

In `run-engine.ts`, import it and replace the inline regex in `statusForRunError` (the current branch at lines 192-198):

```ts
import { isProviderFailureMessage } from "./classify-provider-failure";
// ...
function statusForRunError(message: string): BenchmarkAttemptV2["status"] {
  const normalized = message.toLowerCase();
  if (isProviderFailureMessage(normalized)) {
    return "provider_unavailable";
  }
  if (/budget|token limit|cost limit|wall.?clock/.test(normalized)) {
    return "failed_budget";
  }
  return "invalid_harness";
}
```

In `executor.ts`, replace the first branch of `classifyBuildFailure` (line 400) similarly:

```ts
import { isProviderFailureMessage } from "../certified/classify-provider-failure";
// ...
if (isProviderFailureMessage(message)) {
  return { status: "provider_unavailable", code: "provider_unavailable" };
}
```

(`message` in `classifyBuildFailure` is already lowercased at line 399; `isProviderFailureMessage` lowercases again, which is harmless.)

Note: `statusForRunError` itself is module-private, so the test exercises the bug through the exported `isProviderFailureMessage` predicate (and the existing run-engine integration test already covers the `provider_unavailable` end-to-end path at test-certified-run-engine.mts:464-468).

Sequencing: this task and the `aborted_user` comment task both touch `statusForRunError` in run-engine.ts — apply the `aborted_user` comment first (it sits above the function), then this regex change inside the function body, so the two edits don't overlap.

- [ ] Extend `scripts/test-benchmark-failure-classification.mts`: import `isProviderFailureMessage` from `../lib/benchmark/certified/classify-provider-failure` and add assertions:
  ```ts
  import { isProviderFailureMessage } from "../lib/benchmark/certified/classify-provider-failure";
  check(
    "model-call 'timed out' phrasing classifies as a provider failure",
    isProviderFailureMessage("Certified model call timed out after 120000ms."),
    "timed out should be provider"
  );
  check(
    "legacy 'timeout' phrasing still classifies as a provider failure",
    isProviderFailureMessage("request timeout"),
    "timeout should be provider"
  );
  check(
    "non-provider harness error is not a provider failure",
    !isProviderFailureMessage("internal parser bug"),
    "harness error should not be provider"
  );
  ```
- [ ] Run `npx tsx scripts/test-benchmark-failure-classification.mts` → expect FAIL (module `classify-provider-failure` does not exist yet / import error).
- [ ] Create `lib/benchmark/certified/classify-provider-failure.ts` and wire it into `run-engine.ts` and `executor.ts` as above.
- [ ] Run `npx tsx scripts/test-benchmark-failure-classification.mts` → expect PASS. Also run `npx tsx scripts/test-certified-run-engine.mts` to confirm the existing provider-crash path still classifies as `provider_unavailable` (expect PASS).
- [ ] Run `npm run lint`.
- [ ] Commit: `fix(certified): map "timed out" provider stalls to provider_unavailable via shared classifier`

---

### Task: Surface budget exhaustion on a failed model call instead of swallowing it
**Severity:** low · **Category:** correctness

**Files:**
- Modify: `lib/benchmark/certified/model-call.ts:274-282` (failure-path `recordModelCallUsage` catch)
- Test: extend `scripts/test-certified-model-call.mts`

**Problem:** On the failure path, after partial output, `callCertifiedModel` records partial usage so it counts against the budget but wraps it in a bare `catch {}` (model-call.ts:280-282). If `recordModelCallUsage` itself throws `CertifiedBudgetExceededError` (the partial usage tips the budget over), that budget signal is silently discarded and the original provider error is thrown instead — so this call never emits its `run_blocked` budget event. The success path (lines 206-215) handles this correctly by calling `recordCertifiedBudgetEvent` and rethrowing the budget error.

**Change:** Mirror the success path. Distinguish `CertifiedBudgetExceededError` from incidental record errors in the failure-path catch (currently lines 274-282):

Before:
```ts
    try {
      input.context.recordModelCallUsage?.({
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        estimatedUsd: trace.estimatedUsd,
      });
    } catch {
      // Preserve the provider/parser error that caused the failed model call.
    }
    throw error;
```

After:
```ts
    try {
      input.context.recordModelCallUsage?.({
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        estimatedUsd: trace.estimatedUsd,
      });
    } catch (recordError) {
      if (recordError instanceof CertifiedBudgetExceededError) {
        await recordCertifiedBudgetEvent(input, recordError);
        throw recordError;
      }
      // Otherwise preserve the provider/parser error that caused the failed model call.
    }
    throw error;
```

`CertifiedBudgetExceededError` and `recordCertifiedBudgetEvent` are already imported/defined in this file (lines 23, 287), so no new imports. This emits the `run_blocked` budget event for the call and surfaces exhaustion immediately, consistent with the success path; non-budget record failures still preserve the original provider error.

- [ ] Extend `scripts/test-certified-model-call.mts`: add a case whose stream yields some tokens then errors, under a context whose budget is tripped by the partial output, and assert a `run_blocked` budget event was recorded and the rejection is the budget error. Build on the existing `postCallBudgetContext` pattern (lines 275-308):
  ```ts
  const failPathBudgetContext = createCertifiedRunContext({
    runId: "run-certified-model-call-budget-failpath",
    suiteId: "suite-model-call",
    track: "gameiq",
    harnessProfile: "raw-single-model",
    startedAt: new Date().toISOString(),
    caseIds: ["case-budget-failpath"],
    teamCompositionIds: ["team-budget-failpath"],
    modelBudget: { maxOutputTokens: 1 },
  });
  await expectReject(
    "failed model call surfaces budget exhaustion from partial usage",
    () =>
      callCertifiedModel({
        model,
        system: "System",
        user: "User",
        maxTokens: 64,
        temperature: 0,
        context: failPathBudgetContext,
        caseId: "case-budget-failpath",
        attemptId: "attempt-budget-failpath",
        participantId: "single",
        streamChat: async function* (): AsyncIterable<StreamChunk> {
          yield { type: "token", content: "This partial output intentionally uses several tokens." };
          yield { type: "error", error: "Provider 503 mid-stream" };
        },
      }),
    /budget|output tokens/i
  );
  check(
    "failed model call emits a run_blocked budget event",
    failPathBudgetContext
      .snapshot()
      .events.some(
        (event) =>
          event.attemptId === "attempt-budget-failpath" &&
          event.type === "run_blocked" &&
          event.phase === "budget"
      ),
    failPathBudgetContext.snapshot().events
  );
  ```
  (A provider `{ type: "error" }` chunk drops into the failure path with partial `rawResponse` already accumulated, so the failure-path `recordModelCallUsage` records the over-budget partial usage and throws `CertifiedBudgetExceededError`.)
- [ ] Run `npx tsx scripts/test-certified-model-call.mts` → expect FAIL on the new `run_blocked` assertion (today the budget error is swallowed and the provider error is thrown, so no budget event is emitted and `expectReject` may also see the wrong message).
- [ ] Apply the catch change in model-call.ts.
- [ ] Run `npx tsx scripts/test-certified-model-call.mts` → expect PASS.
- [ ] Run `npm run lint`.
- [ ] Commit: `fix(certified): surface budget exhaustion on failed model calls instead of swallowing it`

---

### Task: Tighten certified USD/wall-clock budgets into near-hard caps (mid-call enforcement)
**Severity:** low · **Category:** correctness · **(optional polish)**

**Files:**
- Modify: `lib/benchmark/certified/budget.ts:51-128` (`reserveModelCall` pre-call USD projection; thread pricing/maxTokens into `CertifiedModelCallReservation`)
- Modify: `lib/benchmark/certified/model-call.ts:138-148` (wall-clock check inside the stream loop)
- Test: extend `scripts/test-certified-model-call.mts` (it already covers preflight/post-call budget at lines 242-308)

**Problem:** `assertWithinBudget` (budget.ts:51-95) evaluates `maxUsd` only after a call completes (`recordModelCallUsage`) and `maxWallClockMs` only at call boundaries. A single large response always runs to completion, so the budget can only stop the NEXT call — there is no hard cap on the most expensive single response — and a run that blows past `maxWallClockMs` mid-stream keeps streaming until the next `reserveModelCall`. The only mid-call backstop is the fixed per-call timeout (`withCertifiedModelCallTimeout`, default 120s), which is unrelated to the configured wall-clock budget.

**Change:** This is explicitly low-priority hardening — the existing per-call timeout already bounds worst-case overshoot. Pick the lower-risk half (wall-clock mid-stream check) and treat the USD projection as a stretch sub-step.

1. Wall-clock mid-stream (smaller, self-contained): in `callCertifiedModel`'s stream loop (model-call.ts:138-148), check elapsed wall-clock against the configured budget per chunk and abort promptly. `startedMs` is already captured (line 74) but is per-call; the run-level budget start lives in the context. Read the run budget via `input.context.modelBudget.maxWallClockMs` and the run start via `input.context.startedAt`:
   ```ts
   const wallClockBudgetMs = input.context.modelBudget.maxWallClockMs;
   const runStartedMs = new Date(input.context.startedAt).getTime();
   // inside the for-await loop, before appending each chunk:
   if (
     typeof wallClockBudgetMs === "number" &&
     Number.isFinite(runStartedMs) &&
     Date.now() - runStartedMs > wallClockBudgetMs
   ) {
     throw new CertifiedBudgetExceededError(
       `Certified budget exceeded during model-call streaming: wall-clock time exceeded maxWallClockMs ${wallClockBudgetMs}.`
     );
   }
   ```
   This reuses `CertifiedBudgetExceededError` (already imported), and because it is a `CertifiedBudgetExceededError`, the existing catch at lines 226-227 rethrows it cleanly without re-tracing.

2. (Stretch) Pre-call USD projection: extend `CertifiedModelCallReservation` (budget.ts:3-5) with optional `projectedUsd?: number`, and in `reserveModelCall` reject when `state.estimatedUsd + projectedUsd > maxUsd`. Compute the projection in `callCertifiedModel` from `input.maxTokens × outputUsdPer1M` (+ the existing input projection) and pass it alongside `inputTokens` at line 120. Skip this sub-step if pricing/maxTokens threading feels too invasive for a nit; the wall-clock check alone is the recommended minimum.

- [ ] Extend `scripts/test-certified-model-call.mts`: add a context with a tiny `maxWallClockMs` whose `startedAt` is in the past, stream a couple of tokens, and assert it rejects mid-stream with a wall-clock message:
  ```ts
  const wallClockContext = createCertifiedRunContext({
    runId: "run-certified-model-call-wallclock",
    suiteId: "suite-model-call",
    track: "gameiq",
    harnessProfile: "raw-single-model",
    startedAt: new Date(Date.now() - 10_000).toISOString(),
    caseIds: ["case-wallclock"],
    teamCompositionIds: ["team-wallclock"],
    modelBudget: { maxWallClockMs: 1 },
  });
  await expectReject(
    "certified model call aborts mid-stream when wall-clock budget is exceeded",
    () =>
      callCertifiedModel({
        model,
        system: "System",
        user: "User",
        maxTokens: 16,
        temperature: 0,
        context: wallClockContext,
        caseId: "case-wallclock",
        attemptId: "attempt-wallclock",
        participantId: "single",
        streamChat: async function* (): AsyncIterable<StreamChunk> {
          yield { type: "token", content: "first" };
          yield { type: "token", content: "second" };
        },
      }),
    /wall.?clock|budget/i
  );
  ```
- [ ] Run `npx tsx scripts/test-certified-model-call.mts` → expect FAIL (today the stream runs to completion; only call-boundary checks fire).
- [ ] Add the mid-stream wall-clock check in model-call.ts (and, if doing the stretch sub-step, the USD projection in budget.ts).
- [ ] Run `npx tsx scripts/test-certified-model-call.mts` → expect PASS.
- [ ] Run `npm run lint`.
- [ ] Commit: `feat(certified): abort model calls mid-stream when the wall-clock budget is exceeded`

---

## GameIQ track

### Task: Delete stale orphaned `benchmarks/gameiq/v1/*.json` pack manifests
**Severity:** low · **Category:** data-integrity

**Files:**
- Delete: `benchmarks/gameiq/v1/fireworks.json`, `benchmarks/gameiq/v1/chess.json`, `benchmarks/gameiq/v1/connect-four.json`, `benchmarks/gameiq/v1/battleship.json`, `benchmarks/gameiq/v1/codenames.json`
- Test: `scripts/test-benchmark-case-manifests.mts` (add a drift-guard so the directory cannot silently reappear stale)

**Problem:** The checked-in `benchmarks/gameiq/v1/*.json` manifests are the published record of what each certified GameIQ pack contains, but they are stale and read by no runtime or test path. Every file's `digest` uses the obsolete `gameiq-v0.1:` prefix (the live `stableGameIqScenarioPackDigest` now emits `gameiq-v1:`), and `fireworks.json` documents an orphan pack `gameiq-fireworks-solo-v0.1` (scenarioCount 20) that no longer exists — the live fireworks packs are `gameiq-fireworks-basic-v1` (20), `gameiq-fireworks-hard-v1` (40), `gameiq-fireworks-memory-v1` (30). An auditor diffing scores against the committed digest gets a false negative.

**Change:** I grounded this: a repo-wide search for `benchmarks/gameiq`, `gameiq/v1`, and the individual filenames finds zero importers/readers in `lib/`, `app/`, `components/`, or `scripts/` (the only hit was the connect-four *game export*, unrelated). The single source of truth is `lib/benchmark/gameiq/packs.ts` (`GAMEIQ_SCENARIO_PACKS` + `stableGameIqScenarioPackDigest`). Per the fix recipe, take the simplest correct path — delete the orphan manifests — and add a drift-guard so the stale directory cannot quietly return. Do NOT regenerate them (nothing consumes them).

Confirmed live vs committed mismatch:
```
fireworks.json   packId gameiq-fireworks-solo-v0.1  digest gameiq-v0.1:fireworks:52f8a26e   (orphan — no live pack)
chess.json       digest gameiq-v0.1:chess:67023c68        (live prefix is now gameiq-v1:)
connect-four/battleship/codenames.json  same stale gameiq-v0.1: prefix
```

- [ ] Extend `scripts/test-benchmark-case-manifests.mts`: in the existing loop over `for (const path of [...])` of "legacy benchmark artifact is removed" assertions (lines 47-56), add the directory guard so a regenerated-stale dir fails:
  ```ts
  join(benchmarksRoot, "gameiq", "v1"),
  ```
  (sits alongside the existing `gameiq/v0` entry; `check("legacy benchmark artifact is removed: ...", !(await exists(path)))` already asserts non-existence.)
- [ ] Run `npx tsx scripts/test-benchmark-case-manifests.mts`, expect FAIL (the `gameiq/v1` dir still exists).
- [ ] Delete the five manifest files and the now-empty `benchmarks/gameiq/v1/` directory:
  ```bash
  rm benchmarks/gameiq/v1/fireworks.json benchmarks/gameiq/v1/chess.json \
     benchmarks/gameiq/v1/connect-four.json benchmarks/gameiq/v1/battleship.json \
     benchmarks/gameiq/v1/codenames.json
  rmdir benchmarks/gameiq/v1
  ```
- [ ] Run `npx tsx scripts/test-benchmark-case-manifests.mts`, expect PASS.
- [ ] Run `npm run lint`.
- [ ] Commit: `chore(gameiq): delete stale orphaned v1 pack manifests and guard against drift`

---

### Task: (optional polish) Map all expectedActions and document discarded forbiddenActions in the Fireworks GameIQ port
**Severity:** low/nit · **Category:** scoring-validity

**Files:**
- Modify: `lib/benchmark/gameiq/fireworks.ts:26` and `:40-44` (and the `expected()` helper at `:10-16`)
- Test: `scripts/test-gameiq-scenarios.mts` (extend; it already imports the fireworks packs)

**Problem:** `toGameIqScenario` keeps only `input.scenario.expectedActions[0]` and silently drops every other accepted alternative, and it never carries `forbiddenActions` (which exist on `FireworksScenario` in `lib/benchmark/fireworks/types.ts:44`). For the shipped packs this is currently a no-op (every source scenario has a single weight-1 expected action), but it's a silent-regression trap if a multi-action source category is ever added to a GameIQ filter. This is purely robustness/diagnostics, **not** a scoring-correctness fix — GameIQ already gives 0 to any non-expected action, so blunder plays score 0 regardless.

**Change:** Pick the lowest-risk half of the recipe — improvement (1), mapping all expected actions; treat the forbiddenActions diagnostics (2) as out of scope (it needs new fields on `FireworksGameIqScenario`/`GameIqScenarioResult` and is explicitly optional). Replace the single-element `expected()` path:

Before (`fireworks.ts:26` and `:40-44`):
```ts
const expectedAction = input.scenario.expectedActions[0];
return {
  ...
  expectedActions: expected(
    expectedAction.action,
    expectedAction.label,
    expectedAction.weight
  ),
```
After:
```ts
return {
  ...
  expectedActions: input.scenario.expectedActions.map((a) => ({
    action: a.action,
    label: a.label,
    weight: a.weight,
  })),
```
The local `expected()` helper (`fireworks.ts:10-16`) becomes unused — delete it. Frame the commit as robustness, not a scoring change.

- [ ] Extend `scripts/test-gameiq-scenarios.mts`: assert the port preserves multi-action source weights. Since shipped packs are single-action, the robust assertion is that every basic-pack scenario's `expectedActions` length equals its source — but a tighter unit-style guard is to confirm the mapper no longer truncates. Add, using `FIREWORKS_GAMEIQ_BASIC_SCENARIOS`:
  ```ts
  import { FIREWORKS_GAMEIQ_BASIC_SCENARIOS } from "../lib/benchmark/gameiq/fireworks";
  check(
    "Fireworks GameIQ port keeps every expected action (no [0]-only truncation)",
    FIREWORKS_GAMEIQ_BASIC_SCENARIOS.every((s) => s.expectedActions.length >= 1)
      && FIREWORKS_GAMEIQ_BASIC_SCENARIOS.every((s) =>
           s.expectedActions.every((a) => typeof a.weight === "number" && typeof a.label === "string")),
    FIREWORKS_GAMEIQ_BASIC_SCENARIOS.map((s) => s.expectedActions.length)
  );
  ```
  (For a stronger regression lock, the implementer may add a synthetic 2-element source scenario fixture and assert the mapper emits 2; the above is the minimal in-repo guard.)
- [ ] Run `npx tsx scripts/test-gameiq-scenarios.mts`, expect PASS pre-change (it's a non-truncation invariant) — then to make it a true failing test first, temporarily assert `length === source length` against a 2-action fixture; run, expect FAIL.
- [ ] Make the change (map all expected actions; remove the dead `expected()` helper).
- [ ] Run `npx tsx scripts/test-gameiq-scenarios.mts`, expect PASS. Also run `npx tsx scripts/test-gameiq-scoring.mts` to confirm scores are unchanged (shipped single-action packs still score identically).
- [ ] Run `npm run lint`.
- [ ] Commit: `refactor(gameiq): map all Fireworks expectedActions in GameIQ port to prevent silent truncation`

**Sequencing note:** This edits `lib/benchmark/gameiq/fireworks.ts` (`toGameIqScenario`/`expected`); the latencyFactor task edits `lib/benchmark/gameiq/runner.ts` and `scoring/gameiq.ts` — no overlapping functions, so order is independent.

---

### Task: (optional polish) Drop wall-clock latencyFactor from the GameIQ score and renormalize weights
**Severity:** low/nit · **Category:** scoring-validity

**Files:**
- Modify: `lib/benchmark/scoring/gameiq.ts:4-22` (remove `latencyFactor` weight, renormalize, bump version) and `lib/benchmark/gameiq/types.ts:15` (`GAMEIQ_SCORING_VERSION`)
- Keep (display only): `lib/benchmark/gameiq/runner.ts:34-38` `latencyFactor()` and the `latencyFactor`/`latencyMs` fields on `GameIqScenarioResult`/`GameIqRunMetrics`
- Test: `scripts/test-gameiq-scoring.mts` (extend)

**Problem:** 5% of the GameIQ score (`GAME_IQ_WEIGHTS.latencyFactor: 0.05`) is decided by raw wall-clock response time, which depends on model size, provider load, and the user's connection rather than game intelligence — directly against the repo's documented "never score by raw elapsed time" rule. Two equally-correct models can rank differently on latency alone.

**Change:** Take the recipe's preferred, lowest-risk option: remove `latencyFactor` from `scoreGameIqAttempt` and renormalize the remaining four weights to sum to 1; keep the per-scenario `latencyMs`/`latencyFactor` fields for diagnostics so latency stays visible without polluting the score. Because scores change, bump `GAMEIQ_SCORING_VERSION`.

Before (`scoring/gameiq.ts:4-22`):
```ts
const GAME_IQ_WEIGHTS = {
  outcomeScore: 0.35,
  moveQuality: 0.3,
  legalActionRate: 0.2,
  structuredReliability: 0.1,
  latencyFactor: 0.05,
} as const;

export function scoreGameIqAttempt(input: GameIqScoreInput): number {
  const score =
    GAME_IQ_WEIGHTS.outcomeScore * clamp01(input.outcomeScore) +
    GAME_IQ_WEIGHTS.moveQuality * clamp01(input.moveQuality) +
    GAME_IQ_WEIGHTS.legalActionRate * clamp01(input.legalActionRate) +
    GAME_IQ_WEIGHTS.structuredReliability *
      clamp01(input.structuredReliability) +
    GAME_IQ_WEIGHTS.latencyFactor * clamp01(input.latencyFactor);

  return round(score * (1 - 0.5 * clamp01(input.fallbackRate)) * 100);
}
```
After (renormalized to sum to 1, per the recipe's suggested split):
```ts
const GAME_IQ_WEIGHTS = {
  outcomeScore: 0.37,
  moveQuality: 0.32,
  legalActionRate: 0.21,
  structuredReliability: 0.1,
} as const;

export function scoreGameIqAttempt(input: GameIqScoreInput): number {
  const score =
    GAME_IQ_WEIGHTS.outcomeScore * clamp01(input.outcomeScore) +
    GAME_IQ_WEIGHTS.moveQuality * clamp01(input.moveQuality) +
    GAME_IQ_WEIGHTS.legalActionRate * clamp01(input.legalActionRate) +
    GAME_IQ_WEIGHTS.structuredReliability *
      clamp01(input.structuredReliability);

  return round(score * (1 - 0.5 * clamp01(input.fallbackRate)) * 100);
}
```
Then bump `GAMEIQ_SCORING_VERSION` in `types.ts:15` from `"certified-gameiq-v0.1"` to `"certified-gameiq-v0.2"` (verify weights sum to exactly 1: 0.37+0.32+0.21+0.10 = 1.00). Leave `runner.ts`'s `latencyFactor()` and the `metrics.latencyFactor`/`result.latencyFactor` fields untouched — they remain for display and `GameIqScoreInput` still carries `latencyFactor`, now simply unread by the scorer.

- [ ] Extend `scripts/test-gameiq-scoring.mts`: add an assertion that score is latency-independent. The existing `perfectProvider` passes `latencyMs: 0` and asserts score 100 — add a second perfect run with a huge latency that must still score 100:
  ```ts
  const slowPerfect = await runGameIqScenarios({
    runId: "gameiq-test-run-slow-perfect",
    modelId: "fake:slow-perfect",
    teamCompositionId: "team-fake-slow-perfect",
    scenarios,
    moveProvider: ({ scenario }) => ({
      action: scenario.expectedActions[0]?.action,
      rawResponse: JSON.stringify({ action: scenario.expectedActions[0]?.action }),
      latencyMs: 10_000_000, // far above any maxResponseMs -> latencyFactor ~0
    }),
  });
  check("GameIQ score ignores wall-clock latency", slowPerfect.score === 100, slowPerfect);
  ```
  Also update the existing `scoringVersion === "certified-gameiq-v0.1"` assertion (line 44) to `"certified-gameiq-v0.2"`.
- [ ] Run `npx tsx scripts/test-gameiq-scoring.mts`, expect FAIL (pre-change `slowPerfect` scores ~99 because the 0.05 latency term drops, and the version assertion fails).
- [ ] Make the change (renormalize weights + bump `GAMEIQ_SCORING_VERSION`).
- [ ] Run `npx tsx scripts/test-gameiq-scoring.mts`, expect PASS.
- [ ] Run `npm run lint`.
- [ ] Commit: `feat(gameiq): drop wall-clock latency from GameIQ score and renormalize weights (v0.2)`

**Sequencing note:** Edits `lib/benchmark/scoring/gameiq.ts` + `lib/benchmark/gameiq/types.ts`; independent of the fireworks-port task (different files/functions). Both share the `scripts/test-gameiq-scoring.mts` test file only for the score-unchanged smoke check — apply that test edit in whichever task lands second.

---

## TeamIQ track

### Task: Fix cost/speed-adjusted lift sign direction for negative team lift

**Severity:** low/nit · **Category:** scoring-validity *(optional polish — optional hardening, no live impact today)*

**Files:**
- Modify: `lib/benchmark/scoring/teamiq.ts:60-69` (the `adjustedLift` helper)
- Test: `scripts/test-benchmark-scoring.mts` (extend the existing TeamLift section near lines 114-134)

**Problem:** `adjustedLift` multiplies `teamLift` by `baseline / team` (< 1 when the team is more expensive/slower). For a *negative* lift this shrinks the penalty toward zero, so an expensive team that scored worse than the best solo gets a *less* negative cost-adjusted lift than a cheap team with the same raw deficit — the adjustment rewards expensive underperformers.

**Change:** Branch the scaling factor on the sign of `teamLift` so a costlier/slower team's deficit grows instead of shrinking, and guard `baseline <= 0` for the new `team / baseline` branch. Current code:

```ts
function adjustedLift(
  teamLift: number,
  baselineValue: number | null | undefined,
  teamValue: number | null | undefined
): number | null {
  const baseline = finiteOrNull(baselineValue);
  const team = finiteOrNull(teamValue);
  if (baseline == null || team == null || team <= 0) return null;
  return round(teamLift * (baseline / team));
}
```

becomes:

```ts
function adjustedLift(
  teamLift: number,
  baselineValue: number | null | undefined,
  teamValue: number | null | undefined
): number | null {
  const baseline = finiteOrNull(baselineValue);
  const team = finiteOrNull(teamValue);
  if (baseline == null || team == null || team <= 0 || baseline <= 0) return null;
  const factor = teamLift >= 0 ? baseline / team : team / baseline;
  return round(teamLift * factor);
}
```

Leave `classifyTeamLift` and the `strong_positive` gate at line 51 unchanged — for `teamLift >= 10` the factor is the unchanged `baseline / team`, so the existing `"team lift exposes adjusted lift values"` assertion (`costAdjustedTeamLift === 8`, `speedAdjustedTeamLift === 12`) still holds.

**Sequencing note:** This and the "wasteful cost-ratio gate" task both edit `lib/benchmark/scoring/teamiq.ts`. They touch disjoint functions (`adjustedLift` here vs `classifyTeamLift` there) but land in the same file — apply whichever first, then rebase the second edit's context. Both extend `scripts/test-benchmark-scoring.mts`; add assertions to distinct lines.

- [ ] Add a failing assertion in `scripts/test-benchmark-scoring.mts` after the existing `wasteful` block (~line 134):
  ```ts
  const expensiveLoser = scoreTeamLift({
    teamScore: 60,
    memberSoloScores: [75],          // bestSolo 75 -> teamLift -15
    teamCostUsd: 2,
    bestSoloCostUsd: 1,              // team 2x more expensive
    teamDurationMs: 60_000,
    bestSoloDurationMs: 30_000,      // team 2x slower
  });
  check(
    "negative lift is penalized harder for an expensive/slow team",
    expensiveLoser.costAdjustedTeamLift !== null &&
      expensiveLoser.costAdjustedTeamLift < expensiveLoser.teamLift &&
      expensiveLoser.speedAdjustedTeamLift < expensiveLoser.teamLift,
    expensiveLoser
  );
  ```
  (raw `teamLift === -15`; with `team/baseline === 2` the adjusted values should be `-30`, i.e. strictly less than `-15`.)
- [ ] Run `npx tsx scripts/test-benchmark-scoring.mts`, expect FAIL (current code yields `-7.5`, which is greater than `-15`).
- [ ] Apply the `adjustedLift` edit shown above.
- [ ] Run `npx tsx scripts/test-benchmark-scoring.mts`, expect PASS (and the pre-existing positive-lift assertions still pass).
- [ ] Run `npm run lint`.
- [ ] Commit: `fix(teamiq): scale negative team lift by cost/speed penalty direction`

---

### Task: Flag high-cost positive team lift with a cost-ratio gate in classifyTeamLift

**Severity:** low/nit · **Category:** scoring-validity *(optional polish — scoring-design refinement, not a correctness fix)*

**Files:**
- Modify: `lib/benchmark/scoring/teamiq.ts:43-57` (`classifyTeamLift`)
- Modify: `docs/bench/scoring-rules.md:61-67` (keep labels in sync)
- Test: `scripts/test-benchmark-scoring.mts` (extend TeamLift section)

**Problem:** Cost only influences the label when `teamLift <= 0` (the `"wasteful"` branch). A team that earns small positive lift but costs many times the best solo is still labeled `"positive"`/`"strong_positive"` with no cost caveat — and since teams are charged the sum of all member calls, almost every team is several times more expensive than its best solo, so the cost dimension is bypassed across the entire positive range.

**Change:** In `classifyTeamLift`, after the existing `wasteful` block, compute the cost ratio from the already-available `teamCost`/`bestSoloCost` and downgrade a *small* positive lift when the team is disproportionately expensive (e.g. ratio `> 3` with `teamLift < 10`): block `strong_positive` and demote a would-be `positive` to `neutral`. Do **not** rely on `costAdjustedTeamLift` for this gate (the separate adjustedLift task owns that field). Current branches:

```ts
  if (teamLift >= 10 && (costAdjustedTeamLift ?? teamLift) > 0) {
    return "strong_positive";
  }
  if (teamLift > 3) return "positive";
  if (teamLift >= -3 && teamLift <= 3) return "neutral";
  if (teamLift < -3) return "negative";
  return "neutral";
```

become (insert the ratio computation right after the `wasteful` return):

```ts
  const costRatio =
    teamCost != null && bestSoloCost != null && bestSoloCost > 0
      ? teamCost / bestSoloCost
      : null;
  const overpriced = costRatio != null && costRatio > 3;

  if (teamLift >= 10 && !overpriced && (costAdjustedTeamLift ?? teamLift) > 0) {
    return "strong_positive";
  }
  if (teamLift > 3) return overpriced && teamLift < 10 ? "neutral" : "positive";
  if (teamLift >= -3 && teamLift <= 3) return "neutral";
  if (teamLift < -3) return "negative";
  return "neutral";
```

Then update `docs/bench/scoring-rules.md` labels (lines 63-65) so spec and code match, e.g.:
- `strong_positive`: lift is at least 10, cost-adjusted lift is positive, **and the team costs no more than ~3x the best solo**.
- `positive`: lift is greater than 3 **and the team is not >3x the best-solo cost (otherwise neutral)**.

**Sequencing note:** Shares `lib/benchmark/scoring/teamiq.ts` with the `adjustedLift` sign task — they edit different functions; land one, rebase the other.

- [ ] Add a failing assertion in `scripts/test-benchmark-scoring.mts` near the TeamLift block:
  ```ts
  const overpricedPositive = scoreTeamLift({
    teamScore: 80,
    memberSoloScores: [75],          // teamLift +5
    teamCostUsd: 4,
    bestSoloCostUsd: 1,              // 4x more expensive (> 3x)
    teamDurationMs: 30_000,
    bestSoloDurationMs: 30_000,
  });
  check(
    "small positive lift on a >3x-cost team downgrades to neutral",
    overpricedPositive.label === "neutral",
    overpricedPositive
  );
  ```
- [ ] Run `npx tsx scripts/test-benchmark-scoring.mts`, expect FAIL (current label is `"positive"`).
- [ ] Apply the `classifyTeamLift` edit and the `scoring-rules.md` label updates.
- [ ] Run `npx tsx scripts/test-benchmark-scoring.mts`, expect PASS (the existing `strong_positive` case at lines 114-124 uses ratio `1/0.8 = 1.25 ≤ 3`, so it still classifies `strong_positive`; the `wasteful` case is unaffected).
- [ ] Run `npm run lint`.
- [ ] Commit: `feat(teamiq): downgrade overpriced small-lift teams from positive to neutral`

---

### Task: Average combo-matrix cost/duration over the full attempt population to match quality

**Severity:** low/nit · **Category:** data-integrity

**Files:**
- Modify: `lib/benchmark/teamiq/combo-matrix.ts:107-119, 184-194` (accumulation + `finalizeGroup`)
- Test: `scripts/test-teamiq-combos.mts` (extend the existing matrix assertions)

**Problem:** `verifiedQuality`/`jobSuccessScore` divide their sums by `group.attempts` (every attempt counts; missing scores fold in as 0 via `finiteNumber`/`scoreForAttempt`), but `averageCostUsd`/`averageDurationMs` divide by `costSamples`/`durationSamples` (only attempts that reported a value). When some attempts lack cost/duration, a row's quality and cost are computed over different run subsets, so `recommendations` `valueScore` (`verifiedQuality / averageCostUsd`) and `computeParetoFrontier` compare quality from one set against cost from another.

**Change:** Average cost and duration over `group.attempts` (treating a missing value as 0, consistent with how quality already treats failed attempts), while keeping the non-null sample counters so a fully-unpriced group still renders `null` rather than a misleading `0`. In the accumulation loop, keep counting samples but the divisor changes in `finalizeGroup`.

In `finalizeGroup` (lines 184-194), change the divisors from the sample counts to `group.attempts`, gated on there being at least one real sample:

```ts
    costUsd: group.costSamples > 0 ? round(group.costUsd, 6) : null,
    averageCostUsd:
      group.costSamples > 0 ? round(group.costUsd / group.attempts, 6) : null,
    durationMs:
      group.durationSamples > 0
        ? round(group.durationMs / group.attempts)
        : null,
    averageDurationMs:
      group.durationSamples > 0
        ? round(group.durationMs / group.attempts)
        : null,
```

(`group.attempts > 0` is guaranteed whenever a sample exists, so it is a safe divisor; the `costSamples > 0`/`durationSamples > 0` guard is retained exactly as the finding instructs.) Leave the loop at lines 110-119 as-is — it still sums real values and increments `costSamples`/`durationSamples` for the null-presence guard.

This shifts averages: a row mixing priced and unpriced attempts now reports a lower average cost (denominator grows to the full attempt count), making the quality/cost ratio in `valueScore` and the Pareto `averageCostUsd` dimension consistent with the quality numerator.

- [ ] Extend `scripts/test-teamiq-combos.mts`: add a team whose two attempts mix a priced and an unpriced (null-cost) run, then assert the average is over both attempts. After the existing `attempt(...)` list, add a composition + two attempts (one with a real `costUsd`, one with `costUsd` overridden to `null`/`NaN` via a small variant), and assert e.g.:
  ```ts
  // mixedRow has 2 attempts, only one priced at 1.0 -> avg over attempts = 0.5
  check(
    "cost averages over all attempts, not just priced samples",
    mixedRow?.averageCostUsd === 0.5,
    mixedRow
  );
  ```
  (Today the same row returns `1.0` because it divides by `costSamples === 1`.) The current `attempt` helper always passes a finite `costUsd`; add an `attemptNullCost(...)` variant that builds the same object with `costUsd: Number.NaN` (which `finiteOrNull` rejects, so `costSamples` stays at 1 while `attempts` reaches 2).
- [ ] Run `npx tsx scripts/test-teamiq-combos.mts`, expect FAIL (returns `1.0`).
- [ ] Apply the `finalizeGroup` divisor edit.
- [ ] Run `npx tsx scripts/test-teamiq-combos.mts`, expect PASS — confirm the existing assertions (`strongRow.averageCostUsd === 1`, `averageDurationMs === 50_000`) still hold, since those rows have one attempt where `attempts === costSamples === 1`.
- [ ] Run `npm run lint`.
- [ ] Commit: `fix(teamiq): average combo-matrix cost and duration over full attempt count`

---

## Tool Reliability track

### Task: Stop awarding free credit for tool-reliability metrics with zero applicable cases

**Severity:** low/nit · **Category:** scoring-validity · **(optional polish)**

**Files:**
- Modify: `lib/benchmark/toolreliability/runner.ts:701` (the `rate()` helper) and `:682` (`summarizeToolReliability` rates object) plus `lib/benchmark/scoring/toolreliability.ts:13` (`scoreToolReliability`) and its input type `lib/benchmark/scoring/types.ts:44` (`ToolReliabilityScoreInput`)
- Test: `scripts/test-toolreliability-scoring.mts` (extend)

**Problem:** `rate()` (runner.ts:701-712) returns `1` when no case exercises a metric, so a pack that omits, say, all `patch` cases still hands the model the full 0.15 patch weight for free, and an omitted `forbiddenAction` category yields rate `1.0` which — fed through `(1 - clamp01(forbiddenActionRate))` — would *zero* the score. `runToolReliabilityPack` accepts arbitrary packs, so partial TeamIQ/custom packs are scored on a non-comparable basis. No live partial-pack path exists today, so this is hardening.

**Change:** The fix recipe's lowest-risk renormalization option. Make `rate()` return `null` for absent dimensions, then renormalize `scoreToolReliability` over only the present positive weights, and treat an absent `forbiddenActionRate` as a no-penalty multiplier of `1` (not the score-zeroing `1.0` rate).

In `lib/benchmark/scoring/types.ts`, widen the input so absent dimensions are expressible:
```ts
// before: every field `number`
export interface ToolReliabilityScoreInput {
  schemaValidRate: number | null;
  firstAttemptValidRate: number | null;
  repairSuccessRate: number | null;
  toolValidRate: number | null;
  patchSuccessRate: number | null;
  commandSafetyRate: number | null;
  forbiddenActionRate: number | null;
}
```

In `lib/benchmark/toolreliability/runner.ts`, change `rate()` to signal absence (keep the `positiveValue` arg / signature):
```ts
function rate(
  caseResults: ToolReliabilityCaseResult[],
  metric: ToolReliabilityMetricKey,
  positiveValue: boolean
): number | null {
  const applicable = caseResults.filter((item) => item.metrics[metric] !== undefined);
  if (applicable.length === 0) return null; // was: return 1
  return (
    applicable.filter((item) => item.metrics[metric] === positiveValue).length /
    applicable.length
  );
}
```

In `lib/benchmark/scoring/toolreliability.ts`, renormalize over present positive weights and make forbidden a no-op when absent:
```ts
export function scoreToolReliability(input: ToolReliabilityScoreInput): number {
  const POSITIVE: Array<[number, number | null]> = [
    [TOOL_RELIABILITY_WEIGHTS.schemaValidRate, input.schemaValidRate],
    [TOOL_RELIABILITY_WEIGHTS.firstAttemptValidRate, input.firstAttemptValidRate],
    [TOOL_RELIABILITY_WEIGHTS.repairSuccessRate, input.repairSuccessRate],
    [TOOL_RELIABILITY_WEIGHTS.toolValidRate, input.toolValidRate],
    [TOOL_RELIABILITY_WEIGHTS.patchSuccessRate, input.patchSuccessRate],
    [TOOL_RELIABILITY_WEIGHTS.commandSafetyRate, input.commandSafetyRate],
  ];
  let weighted = 0;
  let presentWeight = 0;
  for (const [weight, value] of POSITIVE) {
    if (value === null || value === undefined) continue;
    weighted += weight * clamp01(value);
    presentWeight += weight;
  }
  // No applicable positive dimensions -> nothing to score.
  const positiveScore = presentWeight > 0 ? weighted / presentWeight : 0;
  const forbidden = input.forbiddenActionRate ?? 0; // absent => no penalty
  return round(positiveScore * (1 - clamp01(forbidden)) * 100);
}
```
Note: renormalizing changes the denominator from a fixed `1.0` to `presentWeight`; for a full pack `presentWeight === 1.0` so existing scores are unchanged. Verify the `perfect scores 100` assertion still passes.

- [ ] Extend `scripts/test-toolreliability-scoring.mts`: add a partial-pack candidate that runs only `patch` cases (reuse `opusStyleBasicPatchCase`) and assert the score is governed solely by patch outcomes, not inflated by absent dimensions:
```ts
const partialPatchOnly = runToolReliabilityPack(
  {
    id: "toolrel-partial-patch-only",
    modelId: "deterministic:partial",
    providerId: "deterministic",
    teamCompositionId: "toolrel-partial-patch-only",
    outputs: {
      [opusStyleBasicPatchCase.id]: [
        [
          "```edit path=src/feature.ts",
          "<<<<<<< SEARCH",
          'export const exportedValue = "missing";', // will not apply -> patch fails
          "=======",
          'export const exportedValue = "new";',
          ">>>>>>> REPLACE",
          "```",
        ].join("\n"),
      ],
    },
  },
  [opusStyleBasicPatchCase]
);
check(
  "partial pack does not grant free credit for absent dimensions",
  partialPatchOnly.summary.rates.schemaValidRate === null &&
    partialPatchOnly.summary.rates.patchSuccessRate === 0 &&
    partialPatchOnly.score === 0, // patch is the only present dimension and it failed
  partialPatchOnly
);
```
- [ ] Run `npx tsx scripts/test-toolreliability-scoring.mts`, expect FAIL (today `rate()` returns 1 for absent dims, the partial pack scores far above 0, and `schemaValidRate` is `1` not `null`).
- [ ] Apply the three edits above (types.ts, runner.ts `rate()`, toolreliability.ts `scoreToolReliability`).
- [ ] Run `npx tsx scripts/test-toolreliability-scoring.mts`, expect PASS. Also run the neighbours that consume rates/score: `npx tsx scripts/test-toolreliability-diagnostics.mts` and `npx tsx scripts/test-certified-toolreliability-runner.mts`.
- [ ] Run `npm run lint`.
- [ ] Commit: `fix(toolreliability): renormalize score over present metrics instead of free-crediting absent dimensions`

### Task: Discard pathless SEARCH/REPLACE ops that run to EOF instead of folding trailing prose into the replacement

**Severity:** low/nit · **Category:** correctness · **(optional polish)**

**Files:**
- Modify: `lib/benchmark/toolreliability/runner.ts:584` (`parsePlainSearchReplaceOps`)
- Test: `scripts/test-toolreliability-scoring.mts` (extend)

**Problem:** `parsePlainSearchReplaceOps` (runner.ts:584-611) reads the REPLACE body until the next `SEARCH` line or EOF with no terminator — unlike `parseEditOps` in `lib/artifacts/extract.ts:158-191`, which requires a `>>>>>>> REPLACE` terminator and drops un-terminated ops. A model that emits one plain SEARCH/REPLACE followed by trailing prose folds that prose into the replacement, so `applyEditOps` writes prose into the file and the patch fails `content_mismatch` even though the edit itself was correct.

**Change:** Mirror `parseEditOps`' terminated-op discipline. Since the plain (keyword-only, unfenced) form has no `>>>>>>> REPLACE` marker, treat the next `SEARCH` boundary as the only valid terminator and **discard an op whose replace block ran to EOF** (the suspect trailing-prose case). This is conservative: a lone, properly-terminated plain SEARCH/REPLACE pair always reaches EOF on its replace block, so to avoid dropping legitimate single-op output, the safe equivalent the recipe lands on is to require a recognized terminator. Implement that by tracking whether a `SEARCH` boundary closed the replace block; when it did not (EOF), drop the op:

```ts
function parsePlainSearchReplaceOps(text: string): ExtractedEditOp[] {
  const lines = text.split("\n");
  const ops: ExtractedEditOp[] = [];
  let index = 0;
  while (index < lines.length) {
    if (!/^SEARCH\s*$/i.test(lines[index].trim())) {
      index++;
      continue;
    }
    index++;
    const search: string[] = [];
    while (index < lines.length && !/^REPLACE\s*$/i.test(lines[index].trim())) {
      search.push(lines[index]);
      index++;
    }
    if (index >= lines.length) break;
    index++;
    const replace: string[] = [];
    let terminated = false;
    while (index < lines.length) {
      // A following SEARCH starts the next op and terminates this replace block.
      if (/^SEARCH\s*$/i.test(lines[index].trim())) {
        terminated = true;
        break;
      }
      // An explicit end marker also terminates without consuming trailing prose.
      if (/^(?:END|REPLACE-END)\s*$/i.test(lines[index].trim())) {
        terminated = true;
        index++;
        break;
      }
      replace.push(lines[index]);
      index++;
    }
    // Drop ops whose replace block ran to EOF with no boundary: that tail is
    // almost always trailing prose, not part of the edit (cf. extract.ts parseEditOps).
    if (search.length > 0 && terminated) {
      ops.push({ search: search.join("\n"), replace: replace.join("\n") });
    }
  }
  return ops;
}
```

Caveat to call out in the commit/PR: this means a single bare-keyword SEARCH/REPLACE with no following `SEARCH`/`END`/`REPLACE-END` is now discarded by this fallback. That is acceptable because the fenced and conflict-marker forms (`parseConflictMarkerOps`, which already terminates on `>>>>>>> REPLACE`) handle the common cases; this branch only rescues genuinely bare output, and an unterminated bare op is exactly the prose-folding hazard. If a future case must accept a single bare op, it should emit an `END` sentinel.

- [ ] Extend `scripts/test-toolreliability-scoring.mts`: add a candidate emitting a bare (unfenced) SEARCH/REPLACE followed by trailing prose and assert the prose is NOT folded into the file. Use `opusStyleBasicPatchCase` and terminate with `END` so the op is kept:
```ts
const proseTailPatch = runToolReliabilityPack(
  {
    id: "toolrel-prose-tail-patch",
    modelId: "deterministic:prose-tail",
    providerId: "deterministic",
    teamCompositionId: "toolrel-prose-tail",
    outputs: {
      [opusStyleBasicPatchCase.id]: [
        [
          "SEARCH",
          'export const exportedValue = "old";',
          "REPLACE",
          'export const exportedValue = "new";',
          "END",
          "",
          "I also refactored a few things while I was here.", // trailing prose
        ].join("\n"),
      ],
    },
  },
  [opusStyleBasicPatchCase]
);
check(
  "bare SEARCH/REPLACE does not fold trailing prose into the replacement",
  proseTailPatch.caseResults.every((item) => item.passed) &&
    proseTailPatch.summary.rates.patchSuccessRate === 1,
  proseTailPatch.caseResults
);
```
- [ ] Run `npx tsx scripts/test-toolreliability-scoring.mts`, expect FAIL (today the prose line is appended to the replacement, the applied content mismatches `expectedContent`, and the case fails).
- [ ] Apply the `parsePlainSearchReplaceOps` edit above.
- [ ] Run `npx tsx scripts/test-toolreliability-scoring.mts`, expect PASS. Re-run the existing Opus-style assertions in the same file to confirm the fenced/conflict-marker variants are unaffected.
- [ ] Run `npm run lint`.
- [ ] Commit: `fix(toolreliability): drop unterminated plain SEARCH/REPLACE ops instead of folding trailing prose`

**Sequencing note:** Both tasks edit `lib/benchmark/toolreliability/runner.ts` and add assertions to `scripts/test-toolreliability-scoring.mts`. Land the `rate()`/scoring renormalization task first (it touches `rate()`/`summarizeToolReliability` plus two other files), then the `parsePlainSearchReplaceOps` task (a self-contained function lower in the same file) — they do not overlap line-wise, but apply them one at a time and re-run the test between commits so the new `check(...)` blocks don't collide.

---

## WorkBench track

### Task: Treat "no assertions evaluated" as a verifier failure, not a pass
**Severity:** low · **Category:** scoring-validity

**Files:**
- Modify: `lib/benchmark/workbench/verifier.ts:159` (production gate — highest value)
- Modify: `lib/benchmark/workbench/corpus.ts:444-447` (the `WORKBENCH_VERIFIER` runtime string)
- Modify: `lib/benchmark/workbench/challenges.ts:127-131` (in-process TS copy; test-only, cosmetic)
- Test: `scripts/test-workbench-verifier-parser.mts` (extend)

**Problem:** When a verifier produces an empty assertion set (misconfigured/empty case, or tampered `case-meta.json`), every code path treats it as success: `scoreAssertions([], fallbackPassed)` returns `fallbackPassed ? 1 : 0`, and the TS/`.mjs` verifiers compute `passed = assertions.every(...)` which is vacuously `true` on `[]`. A misconfigured case silently scores 1.0 for every model.

**Change:** Make "no assertions" a hard failure in all three copies. The production gate is `verifier.ts`.

In `lib/benchmark/workbench/verifier.ts`, override `passed`/`score`/`summary` when the assertion array is empty. Currently:
```ts
const passed = getBoolean(parsed, "passed");
const assertions = normalizeVerifierAssertions(
  Array.isArray(parsed.assertions) ? parsed.assertions : []
);
const score =
  parsed.score === undefined
    ? scoreAssertions(assertions, passed)
    : clamp01(getFiniteNumber(parsed, "score"));
```
Insert an empty-array guard that wins regardless of the JSON `passed`/`score`:
```ts
const rawPassed = getBoolean(parsed, "passed");
const assertions = normalizeVerifierAssertions(
  Array.isArray(parsed.assertions) ? parsed.assertions : []
);
const noAssertions = assertions.length === 0;
const passed = noAssertions ? false : rawPassed;
const score = noAssertions
  ? 0
  : parsed.score === undefined
    ? scoreAssertions(assertions, rawPassed)
    : clamp01(getFiniteNumber(parsed, "score"));
```
And make `summary` fall back to `"Verifier produced no assertions"` when `noAssertions` (extend the existing `summary` ternary). Also fix the `scoreAssertions` fast-path at line 159 to `if (assertions.length === 0) return 0;` so it is defensive on its own.

In `corpus.ts` `WORKBENCH_VERIFIER` (line 444-447), change:
```js
const passed = assertions.every((item) => item.passed);
const result = {
  passed,
  score: totalWeight > 0 ? passedWeight / totalWeight : passed ? 1 : 0,
```
to require non-empty assertions:
```js
const passed = assertions.length > 0 && assertions.every((item) => item.passed);
const result = {
  passed,
  score: assertions.length === 0 ? 0 : totalWeight > 0 ? passedWeight / totalWeight : passed ? 1 : 0,
  summary: assertions.length === 0
    ? "verifier produced no assertions"
    : passed ? "WorkBench challenge passed." : "WorkBench challenge failed.",
```
Apply the same `assertions.length > 0 &&` guard to `challenges.ts:127` and the `score` ternary at 131 for parity (cosmetic, since this copy is test-only).

- [ ] In `scripts/test-workbench-verifier-parser.mts`, add an assertion that an empty-assertions result is forced to fail:
  ```ts
  const emptyResult = parseVerifierResult(
    JSON.stringify({ passed: true, score: 1, summary: "claims pass", assertions: [] })
  );
  check("empty assertions force passed=false", emptyResult.passed === false, emptyResult);
  check("empty assertions force score=0", emptyResult.score === 0, emptyResult);
  ```
- [ ] Run `npx tsx scripts/test-workbench-verifier-parser.mts`, expect FAIL (current code returns passed=true, score=1).
- [ ] Apply the `verifier.ts` and `corpus.ts` (and parity `challenges.ts`) edits above.
- [ ] Run `npx tsx scripts/test-workbench-verifier-parser.mts`, expect PASS. Also run `npx tsx scripts/test-workbench-current-challenges.mts` to confirm the real-challenge reference/negative cases (which always have assertions) still pass.
- [ ] Run `npm run lint`.
- [ ] Commit: `fix(workbench): treat empty verifier assertions as failure not pass`

**Sequencing note:** This task and the balanced-braces nit both edit `lib/benchmark/workbench/challenges.ts` and `corpus.ts`; land this one first (it touches the result-aggregation block at challenges.ts:127-131 / corpus.ts:444-451), then the brace nit (which touches the separate `syntaxAssertion` function at challenges.ts:392 / corpus.ts:465).

---

### Task: Add a TS-vs-runtime verifier parity guard so the two WorkBench verifier implementations cannot drift
**Severity:** low · **Category:** data-integrity

**Files:**
- Modify: `scripts/test-workbench-current-challenges.mts` (add parity assertions)
- Reference (no change): `lib/benchmark/workbench/challenges.ts` `runWorkBenchChallengeVerifier` (TS) and `lib/benchmark/workbench/corpus.ts` `WORKBENCH_VERIFIER` (the `node verifier.mjs` string)

**Problem:** The contamination/validity guarantee ("the verifier rejects the negative control and accepts the reference") is only checked against the TypeScript `runWorkBenchChallengeVerifier`, never against the `WORKBENCH_VERIFIER` string actually executed by `node` in the runner. The two reimplementations (challenges.ts vs corpus.ts) can silently diverge in scoring logic.

**Change:** Add a deterministic parity guard in the existing test that executes the `WORKBENCH_VERIFIER` string in-process against each challenge's `referenceFiles` and `negativeControlFiles` and asserts identical `passed`/`score` to the TS verifier. The runtime verifier reads `case-meta.json` and the fixture files from disk via `readFileSync` and writes `verifier-result.json`; the lowest-risk way to exercise it without a real runner is to write a temp fixture dir mirroring `workBenchCaseForChallenge`'s `fixtureFiles` (base files + `case-meta.json` + `verifier.mjs`), overlay the candidate files, run it with `node`, and read back `verifier-result.json`.

In `scripts/test-workbench-current-challenges.mts`, inside the existing `for (const challenge of WORKBENCH_CHALLENGES)` loop, after computing TS `reference`/`negative`, add (using `node:fs`, `node:os`, `node:path`, `node:child_process` `execFileSync`, and importing the case builder + `WORKBENCH_VERIFIER` — export `WORKBENCH_VERIFIER` and a `caseMetaForChallenge` helper from `corpus.ts` if not already exported):
```ts
function runRuntimeVerifier(challenge, files) {
  const dir = mkdtempSync(join(tmpdir(), "wb-"));
  try {
    writeFileSync(join(dir, "case-meta.json"), JSON.stringify({
      id: challenge.id, baseFiles: challenge.baseFiles,
      referenceFiles: challenge.referenceFiles, verifier: challenge.verifier,
    }, null, 2));
    writeFileSync(join(dir, "verifier.mjs"), WORKBENCH_VERIFIER);
    for (const [path, content] of Object.entries({ ...challenge.baseFiles, ...files })) {
      const p = join(dir, path); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, content);
    }
    try { execFileSync("node", ["verifier.mjs"], { cwd: dir }); } catch { /* nonzero exit on fail is expected */ }
    return JSON.parse(readFileSync(join(dir, "verifier-result.json"), "utf8"));
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
```
Then assert parity:
```ts
const rtRef = runRuntimeVerifier(challenge, challenge.referenceFiles);
const rtNeg = runRuntimeVerifier(challenge, challenge.negativeControlFiles);
check(`${challenge.id} runtime verifier matches TS on reference`,
  rtRef.passed === reference.passed && Math.abs(rtRef.score - reference.score) < 1e-9, { rtRef, reference });
check(`${challenge.id} runtime verifier matches TS on negative control`,
  rtNeg.passed === negative.passed, { rtNeg, negative });
check(`${challenge.id} runtime verifier rejects negative control`, rtNeg.passed === false, rtNeg);
```

- [ ] Add the `runRuntimeVerifier` helper and the three parity `check(...)` calls; export `WORKBENCH_VERIFIER` from `corpus.ts` if needed.
- [ ] Run `npx tsx scripts/test-workbench-current-challenges.mts`. If the two implementations already agree it passes immediately; to confirm the guard actually catches drift, temporarily change one scoring expression in `WORKBENCH_VERIFIER` (e.g. flip a `passed`), re-run and expect FAIL, then revert.
- [ ] Run `npm run lint`.
- [ ] Commit: `test(workbench): assert runtime verifier.mjs matches TS verifier on reference/negative`

**Note:** This guard is deterministic and catches drift directly; it does not defend against `case-meta.json` tampering (the verifier trusts `meta.verifier` wholesale), which is a separate concern. A live execute-the-deployed-verifier self-check at certification time is the stronger end-to-end variant but is out of scope for this low-severity item.

---

### Task: Document that bench-runner provides no network/memory isolation and stop the unenforced `memoryMb` field from implying a cap
**Severity:** low · **Category:** security-privacy · **(optional polish)**

**Files:**
- Modify: `scripts/bench-runner.mjs:70-81` (startup banner — add isolation disclaimer)
- Modify: `lib/benchmark/workbench/types.ts:31` and `lib/benchmark/types.ts:148` (mark `memoryMb` as unenforced, or drop)
- Modify: `lib/benchmark/workbench/corpus.ts:126` (`memoryMb: 2048` in the emitted case environment)
- Test: `scripts/test-benchmark-schema-v2.mts` (existing; only if the schema field is touched)

**Problem:** Verifier/setup commands run as arbitrary host processes with full network and resource access. `bench-runner.mjs` validates `network` ("none" | "dependency-only") but never enforces it, and `memoryMb` is declared on the case `environment` (set to 2048 in corpus.ts) yet is never read by the runner, never threaded through `executor.ts:40-52`, and absent from `PrepareBenchCaseInput` (`lib/client/bench-runner.ts:20-26`, which has `network` but no `memoryMb`). The field implies an enforced cap that does not exist.

**Change:** Take the lowest-cost correct action: documentation + TODO-marking the dead field (do NOT attempt real OS-level sandboxing here).

(A) In `scripts/bench-runner.mjs`, after the `server.listen` JSON banner (line 70-81), emit a human-readable disclaimer so operators are not misled:
```js
console.error(
  "bench-runner v0.1 isolation: commands run with FULL host privileges. " +
    "'network: dependency-only' is a label, not a boundary; 'memoryMb' is NOT enforced. " +
    "Run only trusted cases."
);
```
(`console.error` keeps the machine-readable `stdout` JSON clean for the client parser.)

(B) Mark `memoryMb` as unenforced in both type declarations so it stops implying a cap. In `lib/benchmark/workbench/types.ts:31` and `lib/benchmark/types.ts:148`, annotate:
```ts
/** Advisory only — bench-runner v0.1 does NOT enforce a memory cap. */
memoryMb?: number;
```
Keep it `?: number` (already optional). Do not remove it unless you also drop the `memoryMb: 2048` literals in `corpus.ts:126` and `scripts/test-benchmark-schema-v2.mts:81` — annotating is the lower-risk option and avoids touching the schema-v2 test.

- [ ] (Choose annotate path — no schema change.) No new test needed since behavior is unchanged; if you instead drop the field, update `scripts/test-benchmark-schema-v2.mts` to remove the `memoryMb` literal and run `npx tsx scripts/test-benchmark-schema-v2.mts` expecting PASS.
- [ ] Apply the banner `console.error` in `bench-runner.mjs` and the JSDoc annotations on both `memoryMb` declarations.
- [ ] Run `npx tsx scripts/test-benchmark-schema-v2.mts`, expect PASS (annotate path leaves it green).
- [ ] Run `npm run lint`.
- [ ] Commit: `docs(bench): mark memoryMb unenforced and warn that bench-runner has no sandboxing`

---

### Task: Make the balanced-braces syntax check informational (weight 0) so it can't tip pass/fail
**Severity:** nit · **Category:** scoring-validity · **(optional polish)**

**Files:**
- Modify: `lib/benchmark/workbench/challenges.ts:392-399` (`syntaxAssertion`, TS)
- Modify: `lib/benchmark/workbench/corpus.ts:465-466` (`syntaxAssertion`, `WORKBENCH_VERIFIER` string)
- Test: `scripts/test-workbench-current-challenges.mts` (existing; only if behavior-visible)

**Problem:** `syntaxAssertion(..., "balanced-braces", ...)` only checks `count(content, "{") === count(content, "}")` — `}{` passes and braces inside strings/comments can mask real imbalance. It implies syntactic validity it cannot establish (no compiler runs in this client-side, dependency-only sandbox), and it carries `weight: 1`, so it can affect score/pass for any case that uses it.

**Change:** Pick the lowest-risk option from the fix: keep it as a clearly-labeled coarse heuristic but give it `weight: 0` so it is purely informational and never tips pass/fail or score, plus a clarifying comment. In `lib/benchmark/workbench/challenges.ts:392-399`:
```ts
// Coarse heuristic only — counts braces anywhere (incl. strings/comments) and does NOT
// validate syntax. weight 0 so it is informational and never affects pass/fail or score.
const passed = count(content, "{") === count(content, "}");
return {
  id: `${path}:balanced-braces`,
  label: `${path} has balanced braces`,
  passed,
  weight: 0,
  message: passed ? undefined : "Brace counts do not match.",
};
```
Mirror exactly in the `WORKBENCH_VERIFIER` string (`corpus.ts:466`): change `weight: 1` to `weight: 0` in the `balanced-braces` return.

Note `scoreAssertions`/the verifier's `totalWeight > 0` guard already handle a zero-weight assertion (it contributes nothing to weighted score), and `passed = assertions.every(...)` would still see it — but a balanced-braces `passed:false` should not fail an otherwise-correct edit. Since current shipped challenges only use `syntaxChecks` of kind `json` (`largeJsonConfigCase`), no live challenge exercises `balanced-braces` today, so this is purely future-proofing with no behavior change to existing tests.

- [ ] Confirm no current challenge uses a `balanced-braces` syntaxCheck (it does not), so `npx tsx scripts/test-workbench-current-challenges.mts` stays green before and after — no failing-test step is meaningful for this informational nit; the guard is the weight-0 change itself.
- [ ] Apply the `weight: 0` + comment edits in `challenges.ts` and `corpus.ts`.
- [ ] Run `npx tsx scripts/test-workbench-current-challenges.mts`, expect PASS (unchanged).
- [ ] Run `npm run lint`.
- [ ] Commit: `refactor(workbench): make balanced-braces syntax check informational (weight 0)`

**Sequencing note:** Edits the same two files (`challenges.ts`, `corpus.ts`) as the empty-assertions task but a different function (`syntaxAssertion` at challenges.ts:392 / corpus.ts:465, vs the result-aggregation block at challenges.ts:127 / corpus.ts:444). Land the empty-assertions task first to avoid overlapping context in the result block.

---

## Fireworks benchmark

### Task: Stop counting seeded memory-scenario clue events as model-produced metrics

**Severity:** low · **Category:** data-integrity

**Files:**
- Modify: `lib/games/fireworks/types.ts:67-80` (add `seeded?` to `FireworksEvent`)
- Modify: `lib/benchmark/fireworks/scenario-packs.ts:292-305` (tag seeded events)
- Modify: `lib/benchmark/fireworks/certified-runner.ts:707-768` (filter seeded events in `aggregateMetrics`)
- Test: `scripts/test-certified-fireworks-runner.mts` (extend) — it already imports from `scenario-packs` and `certified-runner`

**Problem:** `createMemoryScenario` pre-seeds 2-3 `P2` clue events into `state.events` (all `useful:true`, `memoryConsistent:true`) at `scenario-packs.ts:292`. These were never produced by the model under test, but `aggregateMetrics` (`certified-runner.ts:707-768`) counts every entry of `result.state.events`, so they inflate `cluesGiven`/`usefulClues` (→ `usefulClueRate`) and `memoryConsistentActions` in the reported per-attempt metrics and mixed-mode verifier `resultJson`. This is a metric-display fix only — scoring uses `scoreFireworksState`/`scoreFireworksScenarioAction` (stacks + expected-action match), which never reads `state.events`, so scores are unaffected.

**Change:** Tag the seeded events and exclude them from every event-counting reducer.

1. `lib/games/fireworks/types.ts` — add a flag to `FireworksEvent` (after `memoryConsistent?`):
```ts
export interface FireworksEvent {
  id: string;
  turn: number;
  playerId: string;
  action: FireworksAction;
  legal: boolean;
  useful?: boolean;
  fallbackUsed?: boolean;
  memoryConsistent?: boolean;
  seeded?: boolean; // pre-seeded scenario context, not a model-produced action
  playResult?: "success" | "misplay";
  criticalDiscard?: boolean;
  message: string;
  resultingScore: number;
}
```

2. `lib/benchmark/fireworks/scenario-packs.ts:292` — mark the seeded events inside the `.map(...)` object literal (add the line alongside `legal: true,`):
```ts
    legal: true,
    seeded: true,
    useful: true,
    memoryConsistent: true,
```
(`applyFireworksAction` in `lib/games/fireworks/engine.ts:202-209` builds its event from `eventBase` and never sets `seeded`, so the single model-produced event stays `seeded: undefined` — exactly what we want.)

3. `lib/benchmark/fireworks/certified-runner.ts` — define a model-event predicate and apply it to the six reducers that read `state.events` (lines 708, 713-717, 719-720, 722-723, 761-762, 766-767). Add a helper near the top of `aggregateMetrics`:
```ts
const isModelEvent = (event: FireworksEvent) => event.seeded !== true;
```
then change each `state.events.filter(...)`/`state.events.flatMap(...)` to first drop seeded events, e.g.:
- `state.events.filter((event) => event.legal)` → `state.events.filter((event) => isModelEvent(event) && event.legal)`
- the `clueEvents`/`playEvents`/`discardEvents` filters → add `isModelEvent(event) &&` to each predicate
- `state.events.filter((event) => event.memoryConsistent !== false)` → `state.events.filter((event) => isModelEvent(event) && event.memoryConsistent !== false)`
- `state.events.filter((event) => event.memoryConsistent === false)` → `state.events.filter((event) => isModelEvent(event) && event.memoryConsistent === false)`

Ensure `FireworksEvent` is imported in `certified-runner.ts` (it imports its fireworks types from `lib/games/fireworks` already — add `FireworksEvent` to that import if not present).

Steps:
- [ ] Extend `scripts/test-certified-fireworks-runner.mts`: import `FIREWORKS_MEMORY_SCENARIOS` from `../lib/benchmark/fireworks/scenario-packs` and assert the seeded events are tagged but not counted. Pure-unit assertion (no model run needed) on the exported scenarios:
  ```ts
  import { FIREWORKS_MEMORY_SCENARIOS } from "../lib/benchmark/fireworks/scenario-packs";
  const memScenario = FIREWORKS_MEMORY_SCENARIOS[0];
  const seededEvents = memScenario.state.events;
  check(
    "memory scenario seeds at least one clue event",
    seededEvents.length >= 1,
    seededEvents.length
  );
  check(
    "every seeded memory event is flagged seeded:true",
    seededEvents.every((e) => e.seeded === true),
    seededEvents.map((e) => e.seeded)
  );
  ```
  (This locks in the tag; the reducer change is covered because all pre-run events on a memory scenario are seeded, so any model-event count over that state must exclude them.)
- [ ] Run `npx tsx scripts/test-certified-fireworks-runner.mts`, expect FAIL (the `seeded:true` assertion fails before the tag is added).
- [ ] Apply the three edits above (types.ts flag, scenario-packs.ts tag, certified-runner.ts `isModelEvent` filters).
- [ ] Run `npx tsx scripts/test-certified-fireworks-runner.mts`, expect PASS. Also run `npx tsx scripts/test-fireworks-scenarios.mts` to confirm no scenario-shape regression.
- [ ] Run `npm run lint`.
- [ ] Commit: `fix(fireworks): exclude seeded memory-scenario events from aggregate metrics`

---

## Reports & redaction

### Task: Verify bundleHash on import and warn on mismatch
**Severity:** low · **Category:** data-integrity

**Files:**
- Modify: `lib/benchmark/store.ts:644-649` (add hash recompute), `lib/benchmark/store.ts:731-741` (export a verify helper)
- Modify: `components/benchmark/useBenchmarkReportActions.ts:92-106` (surface the warning via `setMessage`)
- Test: `scripts/test-benchmark-schema-v2.mts` (extend)

**Problem:** `exportBenchmarkReportBundleV2` stamps the bundle with `bundleHash: hashBenchmarkBundle(redacted)` (store.ts:641) and that hash is printed in the Markdown report as a "Reproducibility Hash". But `importBenchmarkReportBundleV2` (store.ts:644-649) only runs `validateBenchmarkReportBundleV2` — which merely type-checks `bundleHash` is a string (store.ts:792-794) — then merges. A hand-edited bundle with stale/garbage scores and the original hash imports silently. This is corruption/stale-edit detection (FNV-1a is non-cryptographic, not tamper-proofing).

**Change:** Export a non-throwing verifier from `store.ts` and call it in the import flow, surfacing a non-fatal warning. `stableNormalize` already skips `bundleHash` (store.ts:753), so recomputing over the imported bundle is well-defined.

1. In `lib/benchmark/store.ts`, add an exported helper next to `hashBenchmarkBundle`:
```ts
export function verifyBenchmarkBundleHash(
  bundle: BenchmarkReportBundleV2
): { ok: boolean; expected: string; actual: string | null } {
  const actual = bundle.bundleHash ?? null;
  const expected = hashBenchmarkBundle(bundle);
  return { ok: actual === null || actual === expected, expected, actual };
}
```
(Note `hashBenchmarkBundle` takes `Omit<…, "bundleHash">`; passing the full bundle is fine because `stableNormalize` drops the `bundleHash` key. If TS objects to the arg type, widen the helper's local: `hashBenchmarkBundle(bundle as Omit<BenchmarkReportBundleV2, "bundleHash">)`.)

2. Make `importBenchmarkReportBundleV2` return the verification outcome so the UI can warn without aborting the import:
```ts
export async function importBenchmarkReportBundleV2(
  bundle: BenchmarkReportBundleV2
): Promise<{ hashMismatch: boolean }> {
  validateBenchmarkReportBundleV2(bundle);
  const verification = verifyBenchmarkBundleHash(bundle);
  await mergeBenchmarkReportBundle(bundle);
  return { hashMismatch: !verification.ok };
}
```
(Keeping the return value optional-compatible: existing callers that ignore the promise value are unaffected.)

3. In `components/benchmark/useBenchmarkReportActions.ts`, capture the result and append a warning:
```ts
const result = await importBenchmarkReportBundleV2(bundle);
await reload();
const certified = bundle.attemptsV2.filter(
  (attempt) => attempt.mode === "certified"
).length;
const warning = result.hashMismatch
  ? " Warning: bundleHash does not match contents (file may be edited or corrupted)."
  : "";
setMessage(
  `Imported ${bundle.runs.length} run(s), ${bundle.cases.length} case(s), ${certified} certified attempt(s).${warning}`
);
```

Steps:
- [ ] Extend `scripts/test-benchmark-schema-v2.mts`: after the existing clean round-trip import (line 306-308), import `verifyBenchmarkBundleHash` from `../lib/benchmark/store` (add to the import block at lines 2-22) and assert:
```ts
const goodVerify = verifyBenchmarkBundleHash(bundleV2);
check("matching bundleHash verifies ok", goodVerify.ok, goodVerify);
const tampered = { ...bundleV2, attemptsV2: bundleV2.attemptsV2.map((a) => ({ ...a, verifiedQuality: 0.01 })) };
const badVerify = verifyBenchmarkBundleHash(tampered);
check("mutated payload with original hash fails verification", !badVerify.ok, badVerify);
const cleanImport = await importBenchmarkReportBundleV2(bundleV2);
check("clean import reports no hash mismatch", cleanImport.hashMismatch === false, cleanImport);
const dirtyImport = await importBenchmarkReportBundleV2(tampered);
check("tampered import reports hash mismatch", dirtyImport.hashMismatch === true, dirtyImport);
```
- [ ] Run `npx tsx scripts/test-benchmark-schema-v2.mts`, expect FAIL (helper not exported / import returns void).
- [ ] Apply the three edits above (export `verifyBenchmarkBundleHash`, change `importBenchmarkReportBundleV2` return type + body, update `useBenchmarkReportActions.importJson`).
- [ ] Run `npx tsx scripts/test-benchmark-schema-v2.mts`, expect PASS (and confirm the many existing `expectReject` cases still pass — note `importBenchmarkReportBundleV2` now returns a value but still rejects on invalid input before reaching the hash check, since `validateBenchmarkReportBundleV2` runs first).
- [ ] Run `npm run lint`.
- [ ] Commit: `feat(benchmark): verify bundleHash on import and warn on mismatch`

---

### Task: Redact env_secret values to end-of-line instead of stopping at `#`
**Severity:** low · **Category:** security-privacy

**Files:**
- Modify: `lib/benchmark/redaction.ts:91` (scan pattern), `lib/benchmark/redaction.ts:119` (redaction pattern)
- Test: `scripts/test-benchmark-redaction.mts` (extend)

**Problem:** The `env_secret` scan (redaction.ts:91) and redaction (redaction.ts:119) patterns both use `[^\r\n#]*` for the unquoted-value alternative, treating `#` as an inline-comment delimiter. Benchmark artifacts are runner/build logs, not parsed `.env` files, so `#` is not a comment here — and base64/url-safe token values can contain `#`-adjacent bytes. A line like `SECRET=abc#def` leaves the `#def` tail of the secret in place.

**Change:** In both patterns change the final alternative `[^\r\n#]*` to `[^\r\n]*` so the whole value through end-of-line is redacted. Both must change in lockstep so the scanner's reported `length`/`preview` matches what the redactor removes.

Before (redaction.ts:91, scan):
```ts
…[A-Z0-9_]*[ \t]*=[ \t]*(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\r\n#]*)/gim,
```
After:
```ts
…[A-Z0-9_]*[ \t]*=[ \t]*(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\r\n]*)/gim,
```
Same single-character edit (`[^\r\n#]*` → `[^\r\n]*`) on redaction.ts:119 inside the `SECRET_REDACTION_PATTERNS` `env_secret` entry.

Steps:
- [ ] Extend `scripts/test-benchmark-redaction.mts` (after the existing API-key check at line 19) with a `#`-bearing value assertion:
```ts
const hashText = "MY_SECRET=abc#deftrailingvalue";
const redactedHash = redactKnownSecrets(hashText);
check("env secret value with # fully redacted", !redactedHash.includes("def") && redactedHash.includes("[REDACTED_SECRET]"), redactedHash);
```
- [ ] Run `npx tsx scripts/test-benchmark-redaction.mts`, expect FAIL (current pattern stops at `#`, leaving `#deftrailingvalue`).
- [ ] Apply both edits (redaction.ts:91 and redaction.ts:119).
- [ ] Run `npx tsx scripts/test-benchmark-redaction.mts`, expect PASS (and confirm the existing `OPENAI_API_KEY=sk-proj-…` and runner-token checks still pass).
- [ ] Run `npm run lint`.
- [ ] Commit: `fix(benchmark): redact env secret values past inline # to end of line`

---

## UI — charts & panels

### Task: Render verifiedQuality consistently as a bare 0-100 score, not a percent

**Severity:** low · **Category:** ux

**Files:**
- Add: `components/benchmark/format.ts` (new `formatScore` helper with `<=1` guard)
- Modify: `components/benchmark/certified/AttemptDetailPanel.tsx:67` (use `formatScore`, delete local `formatPercent` at 330-332)
- Modify: `components/benchmark/certified/CertifiedBenchmarkOverview.tsx:986-990`, `components/benchmark/teamiq/ComboMatrix.tsx:88-92` (import the shared helper, delete local copies)
- Test: `scripts/test-benchmark-format.mts` (new)

**Problem:** `verifiedQuality` is stored 0-1, but `AttemptDetailPanel` renders it as `"87%"` (via local `formatPercent`) while the leaderboard, combo matrix, and overview render the same field as a bare `"87"`. The same metric shows two units across adjacent panels, and `formatPercent` has no `<=1` guard, so a future 0-100-scaled value would render `"8700%"`.

**Change:** Centralize one defensive `formatScore` in `format.ts` (next to `pct`/`usd`/`duration`) and reuse it. `CertifiedBenchmarkOverview.tsx:986-990` and `ComboMatrix.tsx:88-92` already contain the exact target implementation — move it to `format.ts` verbatim and import it.

Add to `components/benchmark/format.ts`:
```ts
export function formatScore(value: number | null): string {
  if (value == null) return "n/a";
  const score = value <= 1 ? value * 100 : value;
  return `${Math.round(score * 10) / 10}`;
}
```
In `AttemptDetailPanel.tsx`: change line 67 from `value={formatPercent(attempt.verifiedQuality)}` to `value={formatScore(attempt.verifiedQuality)}`, add `formatScore` to the import from `@/components/benchmark/format`, and delete the now-unused `formatPercent` (lines 330-332). In `CertifiedBenchmarkOverview.tsx` and `ComboMatrix.tsx`, delete the local `formatScore` and import it from `@/components/benchmark/format` (both signatures already match `value: number | null`). Leave `FireworksTranscriptViewer.formatScore` as-is — it renders a `%` form and is out of scope.

- [ ] Add `scripts/test-benchmark-format.mts` importing `../components/benchmark/format` with the `check` helper; assert `check("0-1 fraction", formatScore(0.87) === "87")`, `check("guarded >1", formatScore(87) === "87")`, `check("one decimal", formatScore(0.875) === "87.5")`, `check("null", formatScore(null) === "n/a")`.
- [ ] Run `npx tsx scripts/test-benchmark-format.mts`, expect FAIL (no exported `formatScore` yet).
- [ ] Add `formatScore` to `format.ts`; update `AttemptDetailPanel.tsx` (line 67 + import, remove `formatPercent`); replace the local copies in `CertifiedBenchmarkOverview.tsx` and `ComboMatrix.tsx` with the import.
- [ ] Run `npx tsx scripts/test-benchmark-format.mts`, expect PASS.
- [ ] Run `npm run lint`.
- [ ] Commit: `fix(benchmark): render verifiedQuality as a bare 0-100 score across panels`

Sequencing note: this task creates `formatScore` in `format.ts`. No other task in this group edits `format.ts`, so no collision.

---

### Task: Plot move-success rate instead of raw fallback so all Reliability bars share polarity

**Severity:** low · **Category:** design

**Files:**
- Modify: `components/benchmark/ReliabilityRatesChart.tsx:38-39, 61`
- Test: `scripts/test-benchmark-rate-bars.mts` (new)

**Problem:** Win/Legal/Schema/Verifier are "higher is better," but `fallbackRate` is "higher is worse" (fallback = the model failed to produce a usable move). All five are plotted as equal-weight, similarly-styled bars, so a reader scanning for the tallest bars misreads a high fallback rate as good.

**Change:** Invert the metric to a positive "Move-success" signal so the whole chart is "higher is better." `dashboard.rateBars[].fallbackRate` is already a 0-100 number (`pctNumber(model.fallbackRate)` in `metrics.ts:404`), so this is a one-line per-bar transform. Replace the `fallbackRate` bar (line 61):
```tsx
// before
<Bar dataKey="fallbackRate" name="Fallback" fill="#f59e0b" />
// after — recharts accepts a function dataKey
<Bar
  dataKey={(row) => 100 - row.fallbackRate}
  name="Move success"
  fill="#f59e0b"
/>
```
Update the `CardDescription` (line 38-39) from `"Win, legality, schema, fallback, and verifier signals by model."` to `"Win, legality, schema, move-success, and verifier signals by model. Higher is better on every bar."` (Keep the `Tooltip formatter={(value) => `${value}%`}` — the transformed value is still a 0-100 number.)

- [ ] Add `scripts/test-benchmark-rate-bars.mts` asserting the transform on the data, not the JSX: `check("move success inverts fallback", (100 - 30) === 70)` is trivial, so instead import `buildBenchmarkDashboard` (or the nearest exported builder) from `../lib/benchmark/metrics`, feed an input producing a model with a known `fallbackRate`, and `check("rateBars carries 0-100 fallbackRate", row.fallbackRate === expectedPct)` to lock the 0-100 contract the bar relies on. If wiring full inputs is heavy, fall back to asserting `pctNumber` output range.
- [ ] Run `npx tsx scripts/test-benchmark-rate-bars.mts`, expect FAIL (or write the assertion to fail first against the pre-change contract).
- [ ] Make the JSX change (function `dataKey` + name + description).
- [ ] Run the test, expect PASS.
- [ ] Run `npm run lint`.
- [ ] Commit: `fix(benchmark): plot move-success instead of raw fallback rate so all bars share polarity`

---

### Task: Add aria-sort and chevron icons to the Build leaderboard headers

**Severity:** low · **Category:** accessibility

**Files:**
- Modify: `components/benchmark/BuildLeaderboardTable.tsx:51-71`
- Test: (no test runner path for `.tsx` rendering; verify via `npm run lint` + manual)

**Problem:** The sorted column/direction is conveyed only by an `aria-hidden` `"^"/"v"` glyph and a color change. Screen readers get no `aria-sort`, so the sorted state is not announced; the glyphs also look unpolished next to the lucide chevrons used elsewhere.

**Change:** Add `aria-sort` to each sortable `<th>`. `sortKey`, `sortDir`, and `column.key` are already in scope. On the mapped `<th>` (line 52):
```tsx
<th
  key={column.key}
  aria-sort={
    sortKey === column.key
      ? sortDir === "asc"
        ? "ascending"
        : "descending"
      : "none"
  }
  className={`px-2 py-2 font-medium ${
    column.align === "right" ? "text-right" : "text-left"
  }`}
>
```
Optional (cosmetic): replace the `<span aria-hidden>{sortDir === "asc" ? "^" : "v"}</span>` at line 67 with lucide `ChevronUp`/`ChevronDown` (`ChevronDown` is already imported in the sibling `BuildModelRow.tsx`); keep them `aria-hidden` since `aria-sort` now carries the semantics. Scope is one file; no data/type changes.

- [ ] No `.tsx` test runner exists; capture the intended behavior with a one-line note in the PR/commit and rely on `npm run lint` + the static export build. (If a lightweight check is desired, none of the existing `scripts/test-*.mts` render React, so do not invent a renderer.)
- [ ] Make the `aria-sort` edit (and optional chevron swap).
- [ ] Run `npm run lint`, expect clean.
- [ ] Commit: `fix(benchmark): announce Build leaderboard sort state via aria-sort`

---

### Task: Give the certified Track/Case-suite Select an accessible name

**Severity:** low · **Category:** accessibility

**Files:**
- Modify: `components/benchmark/certified/CaseSuitePicker.tsx:16-38`
- Modify: `components/benchmark/certified/CertifiedRunPanel.tsx:240-244, 249`
- Test: (no `.tsx` test runner; `npm run lint` + manual)

**Problem:** `CaseSuitePicker` is reused for both the Track picker and the Case-suite picker with only a disappearing placeholder and no programmatic label, so a screen reader announces it generically — unlike the `<Label htmlFor>` inputs elsewhere.

**Change:** Add an `ariaLabel?` prop and forward it to `SelectTrigger`. In `CaseSuitePicker.tsx`:
```tsx
export function CaseSuitePicker({
  value,
  options,
  onChange,
  ariaLabel,
}: {
  value: string;
  options: CertifiedSuiteOption[];
  onChange: (value: string) => void;
  ariaLabel?: string;
}) {
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger aria-label={ariaLabel}>
        <SelectValue placeholder={ariaLabel ?? "Case suite"} />
      </SelectTrigger>
      ...
```
Then in `CertifiedRunPanel.tsx` pass `ariaLabel="Track"` to the Track picker (line 240 block) and `ariaLabel="Case suite"` to the suite picker (line 249). Confirm `SelectTrigger` (Radix) forwards `aria-label` to its underlying element (Radix primitives spread props — it does).

- [ ] No React-rendering test exists in `scripts/`; do not add a fake renderer. Verify via `npm run lint` and the build.
- [ ] Add the `ariaLabel` prop + `SelectTrigger aria-label`; pass the two labels in `CertifiedRunPanel.tsx`.
- [ ] Run `npm run lint`, expect clean.
- [ ] Commit: `fix(benchmark): give certified Track/Case-suite Select an accessible name`

---

### Task: (optional polish) Add a colorblind-safe palette and per-series differentiation to benchmark charts

**Severity:** low · **Category:** accessibility

**Files:**
- Modify: `components/benchmark/chart-utils.tsx:3-10` (replace `CHART_COLORS`)
- Modify (secondary): `components/benchmark/CapabilityRadarChart.tsx:44-53`, `components/benchmark/PerformanceTrendChart.tsx:45-65`
- Test: `scripts/test-chart-palette.mts` (new, asserts palette length/uniqueness)

**Problem:** Overlaid radar series and multi-series lines are separable by color only; for color-blind users the translucent polygons in similar hues are hard to tell apart. Five chart components share `CHART_COLORS`, and several bar charts hard-code the same hex literals.

**Change (optional polish — lowest-risk option from the recipe):** Swap `CHART_COLORS` for a colorblind-safe qualitative palette (Okabe-Ito), which immediately benefits all five charts since they share the constant. In `chart-utils.tsx`:
```tsx
// Okabe-Ito colorblind-safe qualitative palette
export const CHART_COLORS = [
  "#0072B2", // blue
  "#E69F00", // orange
  "#009E73", // green
  "#CC79A7", // reddish-purple
  "#D55E00", // vermillion
  "#56B4E9", // sky blue
];
```
Optionally (secondary channel) add per-index `strokeDasharray` to the Radar series (`CapabilityRadarChart.tsx:45-52`) and Lines (`PerformanceTrendChart.tsx:45-65`), e.g. a `DASHES = ["0", "6 3", "2 2", "8 4"]` indexed by series. Do not attempt `strokeDasharray` on the bar charts — bars can't carry it; the palette swap covers them. Keep the existing legend and tooltip.

- [ ] Add `scripts/test-chart-palette.mts` importing `../components/benchmark/chart-utils`: `check("palette has 6 colors", CHART_COLORS.length === 6)`, `check("palette is unique", new Set(CHART_COLORS).size === CHART_COLORS.length)`, and `check("all hex", CHART_COLORS.every((c) => /^#[0-9a-fA-F]{6}$/.test(c)))`.
- [ ] Run `npx tsx scripts/test-chart-palette.mts`, expect PASS against the new palette (write it before the test passes by running against the old palette first to see the count/uniqueness baseline, then swap).
- [ ] Replace `CHART_COLORS`; optionally add the dash channel to radar/line.
- [ ] Run the test, expect PASS.
- [ ] Run `npm run lint`.
- [ ] Commit: `feat(benchmark): use colorblind-safe chart palette and per-series dashes`

Sequencing note: this is the only task touching `chart-utils.tsx`. The accessibility data-table task below also touches `chart-utils.tsx` (adds a `ChartDataTable` helper) and the chart components — do that one second and rebase its edits over this palette change to avoid colliding in `chart-utils.tsx`.

---

### Task: (optional polish) Provide screen-reader data-table alternatives for the uncovered charts

**Severity:** low · **Category:** accessibility

**Files:**
- Modify: `components/benchmark/chart-utils.tsx` (add a shared `ChartDataTable` helper)
- Modify: `components/benchmark/CapabilityRadarChart.tsx`, `components/benchmark/PerformanceTrendChart.tsx`, `components/benchmark/FailureCategoriesChart.tsx`
- Test: (no `.tsx` renderer; `npm run lint` + manual)

**Problem:** All five charts render as bare SVG with no accessible name/description, and Capability Profile, Performance Over Time, and Failure Categories have no tabular counterpart anywhere, so their data is unavailable to screen-reader/keyboard users (recharts tooltips are hover-only). `ReliabilityRates` and the two `QualityScatter` charts are largely covered by `BenchmarkModelScorecards`, so prioritize the three uncovered charts.

**Change (optional polish):** (1) On each chart's `h-[320px]`/`h-[280px]` wrapper div add `role="img"` plus an `aria-label` summarizing the chart, and associate the existing `CardTitle`/`CardDescription` via `aria-labelledby`/`aria-describedby` (give them ids). (2) Add a `sr-only` `<table>` alternative for the three uncovered charts using the row arrays already on `BenchmarkDashboardData` — `radarRows` (Capability), `trendRows` (Performance), `failureRows` (Failure Categories). Add a shared helper in `chart-utils.tsx`:
```tsx
export function ChartDataTable({
  caption,
  columns,
  rows,
}: {
  caption: string;
  columns: string[];
  rows: Array<Record<string, string | number>>;
}) {
  return (
    <table className="sr-only">
      <caption>{caption}</caption>
      <thead>
        <tr>{columns.map((c) => <th key={c}>{c}</th>)}</tr>
      </thead>
      <tbody>
        {rows.map((row, i) => (
          <tr key={i}>{columns.map((c) => <td key={c}>{row[c] ?? ""}</td>)}</tr>
        ))}
      </tbody>
    </table>
  );
}
```
Render `<ChartDataTable>` next to each `ResponsiveContainer` in the three components, mapping the existing rows to columns. Do not add tables to `ReliabilityRatesChart` or the `QualityScatterChart`s — they are covered by the scorecards table; over-claiming coverage is the recipe's explicit warning.

- [ ] No React-rendering test exists; do not invent one. The row-array shapes are already typed (`BenchmarkDashboardData`), so a wiring bug surfaces in `npm run build` (static export type-checks).
- [ ] Add `ChartDataTable` to `chart-utils.tsx`; add `role="img"` + `aria-label` + id-based labelledby/describedby to the three components; render the sr-only tables.
- [ ] Run `npm run lint` and `npm run build`, expect clean (build type-checks the row mapping).
- [ ] Commit: `feat(benchmark): add screen-reader data tables and aria labels to uncovered charts`

Sequencing note: shares `chart-utils.tsx` with the palette task above — apply the palette task first, then add `ChartDataTable` here so the two edits to `chart-utils.tsx` don't conflict.

---

### Task: Make model selection keyboard-operable via the Scorecards table

**Severity:** low · **Category:** accessibility

**Files:**
- Modify: `components/benchmark/BenchmarkModelScorecards.tsx:45-71`
- Modify (copy tweak): `components/benchmark/QualityScatterChart.tsx:51` (CardDescription), `components/benchmark/ReliabilityRatesChart.tsx:38-39`, `components/benchmark/FailureCategoriesChart.tsx:37-39`
- Test: (no `.tsx` renderer; `npm run lint` + manual)

**Problem:** Model selection (which drives the evidence drilldown) is triggered by `<Cell onClick>` on scatter points and `onClick` on the bar charts — SVG handlers that are not focusable or keyboard-operable. The `BenchmarkModelScorecards` `<tr onClick>` is the only non-chart path, but it also lacks `tabIndex`/`role`/keyboard handling, so there is currently **no** keyboard route to selection.

**Change:** Make the scorecard rows keyboard-operable (the chart `onClick`s stay as a mouse-only enhancement). In `BenchmarkModelScorecards.tsx`, on the `<tr>` (lines 46-52):
```tsx
<tr
  key={model.modelId}
  tabIndex={0}
  role="button"
  aria-pressed={selectedModelId === model.modelId}
  className={`cursor-pointer border-b hover:bg-muted/50 focus:outline-none focus:ring-2 focus:ring-ring ${
    selectedModelId === model.modelId ? "bg-muted" : ""
  }`}
  onClick={() => onSelect(model)}
  onKeyDown={(event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      onSelect(model);
    }
  }}
>
```
Then update the chart `CardDescription`s that invite the interaction (e.g. QualityScatter's "Use this to find cheap models...") to point keyboard users to the Model Scorecards table as the canonical affordance — append a short clause like " Select a model from the Scorecards table below." Do not try to make the SVG `<Cell>`/bar handlers focusable.

- [ ] No React-rendering test exists in `scripts/`; do not add a fake renderer. Verify keyboard activation manually and via `npm run lint`.
- [ ] Add `tabIndex`/`role`/`aria-pressed`/`onKeyDown` to the scorecard `<tr>`; update the chart descriptions.
- [ ] Run `npm run lint`, expect clean.
- [ ] Commit: `fix(benchmark): make model selection keyboard-operable via Scorecards table`

Sequencing note: this and the data-table task both adjust chart `CardDescription` copy in `QualityScatterChart`/`ReliabilityRatesChart`/`FailureCategoriesChart`; if both land, merge the description edits into a single coherent sentence per card to avoid stomping each other.

---

Relevant files (all absolute):
- `C:\Users\b_a_s\source\repos\ai-discussion-board\components\benchmark\certified\AttemptDetailPanel.tsx`
- `C:\Users\b_a_s\source\repos\ai-discussion-board\components\benchmark\format.ts`
- `C:\Users\b_a_s\source\repos\ai-discussion-board\components\benchmark\certified\CertifiedBenchmarkOverview.tsx`
- `C:\Users\b_a_s\source\repos\ai-discussion-board\components\benchmark\teamiq\ComboMatrix.tsx`
- `C:\Users\b_a_s\source\repos\ai-discussion-board\components\benchmark\ReliabilityRatesChart.tsx`
- `C:\Users\b_a_s\source\repos\ai-discussion-board\components\benchmark\BuildLeaderboardTable.tsx`
- `C:\Users\b_a_s\source\repos\ai-discussion-board\components\benchmark\certified\CaseSuitePicker.tsx`
- `C:\Users\b_a_s\source\repos\ai-discussion-board\components\benchmark\certified\CertifiedRunPanel.tsx`
- `C:\Users\b_a_s\source\repos\ai-discussion-board\components\benchmark\chart-utils.tsx`
- `C:\Users\b_a_s\source\repos\ai-discussion-board\components\benchmark\CapabilityRadarChart.tsx`
- `C:\Users\b_a_s\source\repos\ai-discussion-board\components\benchmark\PerformanceTrendChart.tsx`
- `C:\Users\b_a_s\source\repos\ai-discussion-board\components\benchmark\FailureCategoriesChart.tsx`
- `C:\Users\b_a_s\source\repos\ai-discussion-board\components\benchmark\QualityScatterChart.tsx`
- `C:\Users\b_a_s\source\repos\ai-discussion-board\components\benchmark\BenchmarkModelScorecards.tsx`
- `C:\Users\b_a_s\source\repos\ai-discussion-board\lib\benchmark\metrics.ts` (read-only grounding: `rateBars`/`fallbackRate` is 0-100 via `pctNumber`)

