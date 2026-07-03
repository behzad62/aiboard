# GameIQ Benchmark Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make GameIQ runs survive provider failures without losing completed work, fix the two engine-verified miskeyed fireworks oracles (and guard against the class), make the score discriminate frontier models, and set up the saturated-scenario cut — without breaking leaderboard comparability.

**Architecture:** All changes are in the browser-side benchmark engine (`lib/benchmark/**`), its pack data (`lib/benchmark/fireworks/scenario-packs.ts`), and plain-`tsx` test/CLI scripts (`scripts/*.mts`). No app-runtime env vars, no server. Scoring/harness semantic changes bump the version strings in `lib/benchmark/gameiq/types.ts` so old attempts stay comparable to themselves.

**Tech Stack:** Next.js 15 client-side app, TypeScript strict, `npx tsx scripts/*.mts` PASS/FAIL test scripts (no test runner), import alias `@/*` → repo root.

---

## Investigation record (2026-07-03, read before implementing)

Four models ran the 7-pack suite 2026-07-02/03 (run files in `C:\Users\b_a_s\OneDrive\Documents\AIBoard\benchmarks\runs`). Every scenario where ≥2 models converged on the same non-keyed answer was adjudicated by simulating candidate actions through the real game engines (`scripts/audit-gameiq-consensus.mts` found the flags; engine simulation adjudicated them):

| Scenario | Verdict | Evidence |
|---|---|---|
| `gameiq-fireworks-hard-v1-14` | **MISKEYED-NARROW** | Models' `clue_color P1 blue` touches the identical single card (P1's playable blue1) as the keyed `clue_rank P1 1`@0.8. Equal information, scored 0. |
| `gameiq-fireworks-hard-v1-20` | **MISKEYED-NARROW** | Same shape, same fix. 3 frontier models converged on the color clue. |
| `gameiq-fireworks-hard-v1-23/-27/-28` | Oracle correct | Models played a partially-known card that was an engine-certain or high-risk misplay (e.g. -27: played known-red unknown-rank on a red-0 stack; card was the only red5 — critical). Keyed safe clue existed. Real trap failures. |
| `gameiq-fireworks-memory-v1-13/-16/-19/-29` | Oracle correct | Models played cards their own narrated clue history proves dead (e.g. -29: history says rank-1, all stacks past 1 → guaranteed misplay). Real memory/inference failures. |
| `connect-four-win-diagonal-up`, `connect-four-trap-fork-horizontal-diagonal` | Oracle correct | Engine: col 4 is the *unique* winning column; col 2 the *unique* ≥2-threat fork. The official pack test already asserts key-completeness for chess and connect-four. |

**Root cause of the miskeys:** the GameIQ port scores fireworks with binary exact-match (`actionMatchesExpected`), while the TeamIQ source has a graded rubric (`scoreFireworksScenarioAction`: harm→0, dead-clue→0.1, neutral-legal→0.3). And fireworks has **no pack completeness test** — chess (`test-gameiq-chess-pack.mts`: "listed mates == all engine mates") and connect-four have one; fireworks does not, so an equal-information clue variant can go unkeyed.

**Root cause of the dead runs:** one unretried provider error (Gemini: 429 credits-depleted; GPT-5.5: one transient 503) escapes to `runCertifiedBenchmark`'s single try/catch ([run-engine.ts:75-95](../../lib/benchmark/certified/run-engine.ts)), which persists attempts only after ALL packs finish — so 6 completed, verified packs were voided as `provider_unavailable`. The per-scenario catch that previously existed in `evaluateScenario` was removed in commits `a87a2ea`/`71d1675`; it had its own flaw (it scored transport failures as wrong answers — Spark's only chess "fail" was a 120s timeout).

Useful tooling already in the repo from the investigation (keep): `scripts/replay-gameiq-traces.mts` (replays run-file traces through the real scorer; validated to reproduce official scores exactly), `scripts/audit-gameiq-consensus.mts` (standing convergence-flag report). Ad-hoc leftovers to delete in Task A4: `scripts/investigate-fireworks-oracles.mts`, `scripts/show-disputed-views.mts`, `scripts/audit-flagged-scenarios.mts`.

---

## Phase A — Oracle correctness (highest priority)

### Task A1: GameIQ scoring v0.3 — graded fireworks quality, correct-bar, reweighted score

**Files:**
- Modify: `lib/benchmark/gameiq/validation.ts` (add `gradeFireworksAction`, route fireworks through it)
- Modify: `lib/benchmark/gameiq/types.ts` (version bumps, `GAMEIQ_CORRECT_QUALITY_BAR`)
- Modify: `lib/benchmark/gameiq/runner.ts` (`correct` uses the bar)
- Modify: `lib/benchmark/gameiq/packs.ts` (rigor floor uses the bar)
- Modify: `lib/benchmark/scoring/gameiq.ts` (reweight)
- Test: `scripts/test-gameiq-scoring.mts`, `scripts/test-gameiq-shared-guards.mts`

Semantics being built (one coherent scoring change → one version bump):
1. Fireworks `actionQuality` becomes graded: keyed match → weight; forbidden/harmful → 0; clue touching only dead cards → 0.1; other legal → 0.3; illegal/unstructured → 0.
2. `correct` (drives `outcomeScore` and the rigor floor) = `actionQuality >= GAMEIQ_CORRECT_QUALITY_BAR` (0.75), so the 0.3 neutral floor never counts as "correct".
3. Score weights become outcome 0.6 / moveQuality 0.4 (legality & structure move fully into the `failed_tool_use` gate that `statusFromScore` already applies at HEAD — they stop being 31 free points).

- [ ] **Step 1: Write failing tests for the graded rubric and reweight**

Append to `scripts/test-gameiq-scoring.mts` (follow its existing `check(name, ok, detail)` pattern):

```ts
// --- v0.3 scoring: graded fireworks quality + correct bar + reweight ---
import { gradeFireworksAction } from "../lib/benchmark/gameiq/validation";
import { GAMEIQ_CORRECT_QUALITY_BAR, GAMEIQ_SCORING_VERSION } from "../lib/benchmark/gameiq/types";
import { scoreGameIqAttempt } from "../lib/benchmark/scoring/gameiq";

const fireworksScenario = listGameIqScenarios().find(
  (s) => s.id === "gameiq-fireworks-hard-v1-27"
)! as GameIqScenario;

check(
  "v0.3: keyed fireworks action grades at its weight",
  gradeFireworksAction(fireworksScenario, { action: "clue_rank", targetPlayerId: "P2", rank: 2 }) === 1
);
check(
  "v0.3: forbidden fireworks action grades 0",
  gradeFireworksAction(fireworksScenario, { action: "play", cardIndex: 2 }) === 0
);
check(
  "v0.3: neutral legal fireworks action grades 0.3 (not correct)",
  gradeFireworksAction(fireworksScenario, { action: "discard", cardIndex: 0 }) === 0.3 &&
    0.3 < GAMEIQ_CORRECT_QUALITY_BAR
);
check(
  "v0.3: scoring version bumped",
  GAMEIQ_SCORING_VERSION === "certified-gameiq-v0.3"
);
check(
  "v0.3: reweighted score = 0.6*outcome + 0.4*quality (no free legality points)",
  scoreGameIqAttempt({
    outcomeScore: 0.5, moveQuality: 0.5, legalActionRate: 1, structuredReliability: 1, fallbackRate: 0,
  }) === 50
);
check(
  "v0.3: all-legal-but-all-wrong scores 0, not 31",
  scoreGameIqAttempt({
    outcomeScore: 0, moveQuality: 0, legalActionRate: 1, structuredReliability: 1, fallbackRate: 0,
  }) === 0
);
```

Note: `hard-v1-27` state facts used above (from the investigation): keyed = `clue_rank P2 2`@1 / `clue_color P2 green`@0.9; forbidden = play/discard idx2 (red5 critical); discard idx0 (blue4, one of two copies, not critical, not keyed) is a neutral legal action.

- [ ] **Step 2: Run to verify failure**

Run: `npx tsx scripts/test-gameiq-scoring.mts`
Expected: FAIL (no export `gradeFireworksAction`, version still v0.2).

- [ ] **Step 3: Implement `gradeFireworksAction` in `lib/benchmark/gameiq/validation.ts`**

Port of the TeamIQ rubric in `lib/benchmark/fireworks/scenario-packs.ts:134-186` (`scoreFireworksScenarioAction`), adapted to the GameIQ scenario shape whose `initialState` is a `FireworksPlayerView`, not the full state. The view carries ground-truth `otherHands` and own-hand info is only needed for play/discard harm checks — which need TRUE identities. The port therefore grades from the scenario's `expectedActions`/`forbiddenActions` plus what the VIEW can prove:

```ts
import {
  getLegalFireworksActionsForView, // add: see below
} from "@/lib/games/fireworks/engine";

// Graded quality for fireworks actions (GameIQ port of TeamIQ's
// scoreFireworksScenarioAction). Keyed match earns the keyed weight; a
// forbidden action earns 0; a clue that touches only already-played cards
// earns 0.1; any other legal action earns the 0.3 neutral floor. The neutral
// floor is deliberately below GAMEIQ_CORRECT_QUALITY_BAR so it feeds
// moveQuality without ever counting as a correct outcome.
export function gradeFireworksAction(
  scenario: GameIqScenario,
  action: unknown
): number {
  if (!isStructuredGameIqAction(scenario, action)) return 0;
  const candidate = action as FireworksAction;
  const view = scenario.initialState as FireworksPlayerView;

  if (
    (scenario.forbiddenActions ?? []).some((forbidden) =>
      fireworksActionsEqual(forbidden as FireworksAction, candidate)
    )
  ) {
    return 0;
  }
  let bestWeight = 0;
  for (const expected of scenario.expectedActions) {
    if (fireworksActionsEqual(expected.action as FireworksAction, candidate)) {
      bestWeight = Math.max(bestWeight, expected.weight);
    }
  }
  if (bestWeight > 0) return Math.min(1, bestWeight);

  if (!view.legalActions.some((legal) => fireworksActionsEqual(legal, candidate))) {
    return 0;
  }
  if (candidate.action === "clue_color" || candidate.action === "clue_rank") {
    const target = view.otherHands.find(
      (hand) => hand.playerId === candidate.targetPlayerId
    );
    const touched = (target?.cards ?? []).filter((card) =>
      candidate.action === "clue_color"
        ? card.color === candidate.color
        : card.rank === candidate.rank
    );
    if (
      touched.length > 0 &&
      touched.every(
        (card) =>
          card.color !== null &&
          card.rank !== null &&
          view.stacks[card.color] >= card.rank
      )
    ) {
      return 0.1;
    }
  }
  return 0.3;
}
```

Implementation notes:
- `FireworksPlayerView.legalActions` already exists (populated by `getFireworksPlayerView`) — no engine change is actually needed; drop the `getLegalFireworksActionsForView` import if unused.
- Then route fireworks in `actionMatchesExpected` (validation.ts:376): before the generic `expectedActions` loop add:

```ts
  if (scenario.gameId === "fireworks") {
    return gradeFireworksAction(scenario, action);
  }
```

- [ ] **Step 4: Add the correct bar**

In `lib/benchmark/gameiq/types.ts` next to the version constants:

```ts
// Minimum actionQuality that counts as a CORRECT outcome. Graded fireworks
// quality can award sub-bar partial credit (0.1 dead clue / 0.3 neutral) that
// feeds moveQuality without ever counting as correct.
export const GAMEIQ_CORRECT_QUALITY_BAR = 0.75;
```

and bump `GAMEIQ_SCORING_VERSION` to `"certified-gameiq-v0.3"`.

In `lib/benchmark/gameiq/runner.ts` `evaluateScenario`, change:

```ts
    correct: quality > 0,
```
to
```ts
    correct: quality >= GAMEIQ_CORRECT_QUALITY_BAR,
```
(import the constant from `./types`).

In `lib/benchmark/gameiq/packs.ts` `gameIqPackFirstClassFloor`, change the constant-answer probe from `actionMatchesExpected(scenario, candidate) > 0` to `actionMatchesExpected(scenario, candidate) >= GAMEIQ_CORRECT_QUALITY_BAR` (same import), so the floor measures the same "correct" the runner scores.

- [ ] **Step 5: Reweight `lib/benchmark/scoring/gameiq.ts`**

```ts
const GAME_IQ_WEIGHTS = {
  outcomeScore: 0.6,
  moveQuality: 0.4,
  // Legality and structured output are pass/fail gates (statusFromScore →
  // failed_tool_use), not score components: a model must not harvest 31 free
  // points for emitting valid JSON.
  legalActionRate: 0,
  structuredReliability: 0,
} as const;
```

(keep the function body unchanged — zero weights neutralize the terms; the fallback penalty stays).

- [ ] **Step 6: Add a shared-guards check that every keyed weight clears the bar**

Append to `scripts/test-gameiq-shared-guards.mts`:

```ts
import { GAMEIQ_CORRECT_QUALITY_BAR } from "../lib/benchmark/gameiq/types";
for (const pack of listGameIqScenarioPacks()) {
  for (const scenario of pack.scenarios) {
    for (const expected of scenario.expectedActions) {
      check(
        `${scenario.id}: keyed weight ${expected.weight} >= correct bar`,
        expected.weight >= GAMEIQ_CORRECT_QUALITY_BAR
      );
    }
  }
}
```

If any pack keys a sub-0.75 weight this surfaces immediately; decide per case (raise the weight or drop the alternative) — do not silently lower the bar.

- [ ] **Step 7: Run all scoring-related tests**

Run: `npx tsx scripts/test-gameiq-scoring.mts && npx tsx scripts/test-gameiq-shared-guards.mts && npx tsx scripts/test-gameiq-scenarios.mts && npx tsx scripts/test-gameiq-action-normalization.mts`
Expected: PASS everywhere. `test-gameiq-scenarios.mts` exercises pack aggregation — if its expectations encode v0.2 scores, update them to the v0.3 formula (0.6/0.4, gates in status), never by weakening assertions.

- [ ] **Step 8: Commit**

```bash
git add lib/benchmark/gameiq lib/benchmark/scoring/gameiq.ts scripts/test-gameiq-scoring.mts scripts/test-gameiq-shared-guards.mts scripts/test-gameiq-scenarios.mts
git commit -m "feat(gameiq): scoring v0.3 - graded fireworks rubric, correct bar, reweighted score"
```

### Task A2: Widen equivalent clues in the fireworks source packs (fixes hard-v1-14/-20)

**Files:**
- Modify: `lib/benchmark/fireworks/scenario-packs.ts` (post-pass over generated scenarios)
- Modify: `lib/benchmark/gameiq/packs.ts` (fireworks pack version bumps)
- Test: `scripts/test-fireworks-gameiq-port.mts` (existing port test must stay green), new assertions in Task A3's pack test

The generators key `clue_rank` alternatives but miss color twins that touch the identical card set. Fix the CLASS with a deterministic post-pass, not two hand-edits:

- [ ] **Step 1: Write the failing test (temporary inline check, superseded by Task A3)**

Append to `scripts/test-fireworks-gameiq-port.mts`:

```ts
import { FIREWORKS_GAMEIQ_HARD_SCENARIOS } from "../lib/benchmark/gameiq/fireworks";
for (const id of ["gameiq-fireworks-hard-v1-14", "gameiq-fireworks-hard-v1-20"]) {
  const scenario = FIREWORKS_GAMEIQ_HARD_SCENARIOS.find((s) => s.id === id)!;
  check(
    `${id}: equivalent color clue is keyed`,
    scenario.expectedActions.some(
      (e) =>
        (e.action as { action?: string }).action === "clue_color" &&
        (e.action as { color?: string }).color === "blue"
    )
  );
}
```

- [ ] **Step 2: Run to verify failure**

Run: `npx tsx scripts/test-fireworks-gameiq-port.mts`
Expected: FAIL on both new checks.

- [ ] **Step 3: Implement the widening post-pass in `lib/benchmark/fireworks/scenario-packs.ts`**

Add near the exports (after the scenario array construction):

```ts
// Key every clue that carries the same information as an already-keyed clue:
// if a keyed clue (weight >= 0.75) touches card set S of a target hand, then
// any other legal clue on the same target touching exactly S is
// informationally equivalent and must be keyed at the same weight — three
// frontier models independently chose such a twin on safe_discard-04/-10 and
// were scored 0 (2026-07-03 oracle audit).
function widenEquivalentClues(scenarios: FireworksScenario[]): FireworksScenario[] {
  for (const scenario of scenarios) {
    const keyedClues = scenario.expectedActions.filter(
      (expected) =>
        expected.weight >= 0.75 &&
        (expected.action.action === "clue_color" || expected.action.action === "clue_rank")
    );
    if (keyedClues.length === 0) continue;
    const touchedIds = (action: FireworksAction): string | null => {
      if (action.action !== "clue_color" && action.action !== "clue_rank") return null;
      const hand = scenario.state.hands.find(
        (candidate) => candidate.playerId === action.targetPlayerId
      );
      if (!hand) return null;
      const ids = hand.cards
        .filter((card) =>
          action.action === "clue_color" ? card.color === action.color : card.rank === action.rank
        )
        .map((card) => card.id)
        .sort();
      return `${action.targetPlayerId}:${ids.join(",")}`;
    };
    const keyedSets = new Map<string, number>();
    for (const keyed of keyedClues) {
      const key = touchedIds(keyed.action);
      if (key) keyedSets.set(key, Math.max(keyedSets.get(key) ?? 0, keyed.weight));
    }
    const alreadyKeyed = (candidate: FireworksAction) =>
      scenario.expectedActions.some((expected) =>
        fireworksActionsEqual(expected.action, candidate)
      );
    for (const legal of getLegalFireworksActions(scenario.state, scenario.actingPlayerId)) {
      if (legal.action !== "clue_color" && legal.action !== "clue_rank") continue;
      if (alreadyKeyed(legal)) continue;
      const key = touchedIds(legal);
      if (!key) continue;
      const weight = keyedSets.get(key);
      if (weight === undefined) continue;
      scenario.expectedActions.push({
        action: legal,
        weight,
        label: "Equivalent-information clue (auto-widened)",
      });
    }
  }
  return scenarios;
}
```

Apply it where the tactics/memory scenario arrays are exported (wrap the existing arrays):

```ts
export const FIREWORKS_TACTICS_SCENARIOS = widenEquivalentClues(/* existing array expr */);
export const FIREWORKS_MEMORY_SCENARIOS = widenEquivalentClues(/* existing array expr */);
```

`getLegalFireworksActions` needs `state.status === "playing"` and the acting player current — the generated scenario states already satisfy this (verified during the audit for the tactics states; if any memory state differs, compute legal actions on a prepared clone: set `currentPlayerIndex` to the actor and `status` to `"playing"` exactly as `scripts/test-fireworks-gameiq-port.mts` does).

- [ ] **Step 4: Bump content versions**

In `lib/benchmark/gameiq/packs.ts`: `gameiq-fireworks-basic-v1` → `0.4.1`, `gameiq-fireworks-hard-v1` → `0.4.0`, `gameiq-fireworks-memory-v1` → `0.4.1`, each with a one-line comment `// 0.4.x: equivalent-information clues auto-keyed (oracle-narrowness fix, 2026-07-03)`. TeamIQ pack digests change automatically via `stableFireworksScenarioPackDigest`.

- [ ] **Step 5: Verify**

Run: `npx tsx scripts/test-fireworks-gameiq-port.mts && npx tsx scripts/test-gameiq-shared-guards.mts && npx tsx scripts/test-gameiq-scenarios.mts && npx tsx scripts/test-gameiq-bundle-suite.mts`
Expected: PASS, including the two new checks. The shared-guards constant-answer floor re-runs against widened packs — if `fireworks-hard` now exceeds the 50% constant rate it stays `lightweight` tier (it already is; no tier change in this task).

- [ ] **Step 6: Replay the recorded runs to confirm the fix changes exactly the intended verdicts**

Run: `npx tsx scripts/replay-gameiq-traces.mts "C:/Users/b_a_s/OneDrive/Documents/AIBoard/benchmarks/runs/ui-gameiq-1783026417445-google-google-gemini-3-5-flash-0.json" "C:/Users/b_a_s/OneDrive/Documents/AIBoard/benchmarks/runs/ui-gameiq-1783063556370-chatgpt-chatgpt-gpt-5-5-0.json"`
Expected: gemini/gpt-5.5 now pass `hard-v1-14`/`hard-v1-20` (correct count on Trap States rises by 1–2 each); no other scenario verdict changes vs the run recorded in the investigation. (Scores shift globally from A1's reweight — verify VERDICTS, not absolute scores.)

- [ ] **Step 7: Commit**

```bash
git add lib/benchmark/fireworks/scenario-packs.ts lib/benchmark/gameiq/packs.ts scripts/test-fireworks-gameiq-port.mts
git commit -m "fix(gameiq): key equivalent-information fireworks clues (hard-v1-14/-20 oracle narrowness)"
```

### Task A3: Fireworks pack completeness test (the missing guard)

**Files:**
- Create: `scripts/test-gameiq-fireworks-pack.mts`
- Modify: `CLAUDE.md` (add to the test list — do this in Task F2, not here)

Mirror the chess/connect-four guard philosophy: keyed answers must be engine-sound, forbidden answers engine-harmful, and no unkeyed action may be information-equivalent to a keyed one.

- [ ] **Step 1: Write the test**

```ts
/* Engine-verifies the three fireworks GameIQ packs (run: npx tsx scripts/test-gameiq-fireworks-pack.mts)
 *  - keyed plays are engine-playable; keyed discards are never critical cards;
 *  - forbidden play/discard actions are engine-provably harmful (misplay or
 *    critical discard);
 *  - clue-equivalence completeness: any legal clue touching exactly the same
 *    card set of the same target as a keyed (weight >= 0.75) clue is itself
 *    keyed — the invariant behind the hard-v1-14/-20 fix;
 *  - every expected action is legal in the scenario state;
 *  - the pack still passes the shared scenario validator.
 */
import {
  FIREWORKS_GAMEIQ_BASIC_SCENARIOS,
  FIREWORKS_GAMEIQ_HARD_SCENARIOS,
  FIREWORKS_GAMEIQ_MEMORY_STRESS_SCENARIOS,
} from "../lib/benchmark/gameiq/fireworks";
import {
  FIREWORKS_MEMORY_SCENARIOS,
  FIREWORKS_TACTICS_SCENARIOS,
} from "../lib/benchmark/fireworks/scenario-packs";
import type { FireworksScenario } from "../lib/benchmark/fireworks/types";
import {
  applyFireworksAction,
  cloneFireworksState,
  getLegalFireworksActions,
  isCriticalCard,
  isPlayableCard,
  fireworksActionsEqual,
} from "../lib/games/fireworks/engine";
import type { FireworksAction, FireworksGameState } from "../lib/games/fireworks/types";

let failures = 0;
function check(name: string, ok: boolean, detail?: unknown): void {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` -> ${JSON.stringify(detail)}`}`);
}

// GameIQ scenarios carry `source:<teamiq-id>` tags; resolve ground-truth state
// through the source scenario (the GameIQ initialState is the redactable VIEW).
const sources = new Map<string, FireworksScenario>(
  [...FIREWORKS_TACTICS_SCENARIOS, ...FIREWORKS_MEMORY_SCENARIOS].map((s) => [s.id, s])
);
function sourceOf(tags: string[]): FireworksScenario {
  const tag = tags.find((t) => t.startsWith("source:"))!;
  return sources.get(tag.slice("source:".length))!;
}
function prepared(source: FireworksScenario): FireworksGameState {
  const state = cloneFireworksState(source.state);
  const idx = state.players.findIndex((p) => p.id === source.actingPlayerId);
  if (idx >= 0) state.currentPlayerIndex = idx;
  state.status = "playing";
  return state;
}
function touchedKey(state: FireworksGameState, action: FireworksAction): string | null {
  if (action.action !== "clue_color" && action.action !== "clue_rank") return null;
  const hand = state.hands.find((h) => h.playerId === action.targetPlayerId);
  if (!hand) return null;
  const ids = hand.cards
    .filter((c) => (action.action === "clue_color" ? c.color === action.color : c.rank === action.rank))
    .map((c) => c.id)
    .sort();
  return `${action.targetPlayerId}:${ids.join(",")}`;
}

for (const pack of [
  FIREWORKS_GAMEIQ_BASIC_SCENARIOS,
  FIREWORKS_GAMEIQ_HARD_SCENARIOS,
  FIREWORKS_GAMEIQ_MEMORY_STRESS_SCENARIOS,
]) {
  for (const scenario of pack) {
    const source = sourceOf(scenario.tags);
    check(`${scenario.id}: source scenario resolves`, Boolean(source));
    if (!source) continue;
    const state = prepared(source);
    const hand = state.hands.find((h) => h.playerId === source.actingPlayerId)!;
    const legal = getLegalFireworksActions(state, source.actingPlayerId);

    for (const expected of scenario.expectedActions) {
      const action = expected.action as FireworksAction;
      check(
        `${scenario.id}: keyed ${JSON.stringify(action)} is legal`,
        legal.some((l) => fireworksActionsEqual(l, action))
      );
      if (action.action === "play") {
        check(
          `${scenario.id}: keyed play is engine-playable`,
          Boolean(hand.cards[action.cardIndex] && isPlayableCard(state, hand.cards[action.cardIndex]))
        );
      }
      if (action.action === "discard") {
        check(
          `${scenario.id}: keyed discard is not a critical card`,
          Boolean(hand.cards[action.cardIndex]) && !isCriticalCard(state, hand.cards[action.cardIndex])
        );
      }
    }
    for (const forbidden of scenario.forbiddenActions ?? []) {
      const action = forbidden as FireworksAction;
      if (action.action === "play") {
        const card = hand.cards[action.cardIndex];
        check(
          `${scenario.id}: forbidden play is engine-harmful`,
          Boolean(card) && !isPlayableCard(state, card)
        );
      } else if (action.action === "discard") {
        const card = hand.cards[action.cardIndex];
        check(
          `${scenario.id}: forbidden discard destroys a critical card`,
          Boolean(card) && isCriticalCard(state, card)
        );
      }
    }
    // clue-equivalence completeness
    const keyedSets = new Set(
      scenario.expectedActions
        .filter((e) => e.weight >= 0.75)
        .map((e) => touchedKey(state, e.action as FireworksAction))
        .filter((k): k is string => k !== null)
    );
    for (const candidate of legal) {
      const key = touchedKey(state, candidate);
      if (!key || !keyedSets.has(key)) continue;
      check(
        `${scenario.id}: equivalent clue ${JSON.stringify(candidate)} is keyed`,
        scenario.expectedActions.some((e) =>
          fireworksActionsEqual(e.action as FireworksAction, candidate)
        )
      );
    }
  }
}

console.log(failures === 0 ? "PASS" : `FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
```

- [ ] **Step 2: Run it**

Run: `npx tsx scripts/test-gameiq-fireworks-pack.mts`
Expected: PASS after Task A2. If any scenario fails a soundness check (e.g. a keyed discard that IS critical), treat it as a newly found oracle bug: fix the generator in `scenario-packs.ts`, bump the pack version again, re-run — do not relax the assertion.

- [ ] **Step 3: Commit**

```bash
git add scripts/test-gameiq-fireworks-pack.mts
git commit -m "test(gameiq): fireworks pack completeness guard (engine-verified keys, clue equivalence)"
```

### Task A4: Consolidate audit tooling

**Files:**
- Delete: `scripts/investigate-fireworks-oracles.mts`, `scripts/show-disputed-views.mts`, `scripts/audit-flagged-scenarios.mts` (ad-hoc, superseded by A3's test + the consensus audit)
- Keep as standing tools: `scripts/audit-gameiq-consensus.mts`, `scripts/replay-gameiq-traces.mts`

- [ ] **Step 1: Delete the ad-hoc scripts**

```bash
git rm scripts/investigate-fireworks-oracles.mts scripts/show-disputed-views.mts scripts/audit-flagged-scenarios.mts
```

- [ ] **Step 2: Make the consensus audit exit non-zero on flags (so it can gate future pack releases)**

At the end of `scripts/audit-gameiq-consensus.mts`, replace the final `console.log` with:

```ts
console.log(`${flagged} convergence flag(s) across ${table.size} scenarios with 2+ model answers.`);
process.exit(flagged === 0 ? 0 : 1);
```

- [ ] **Step 3: Verify and commit**

Run: `npx tsx scripts/audit-gameiq-consensus.mts <the four run files>` — expected: the two connect-four flags remain listed (they are adjudicated-correct oracles; the tool reports convergence, humans adjudicate — that is its designed use), the fireworks hard-14/20 flags are GONE (now keyed).

```bash
git add scripts/audit-gameiq-consensus.mts
git commit -m "chore(gameiq): consolidate oracle audit tooling"
```

---

## Phase B — Run reliability (no more voided runs)

### Task B1: Retry transient provider errors in `callCertifiedModel`

**Files:**
- Modify: `lib/benchmark/certified/classify-provider-failure.ts` (transient/fatal classification)
- Modify: `lib/benchmark/certified/model-call.ts` (retry loop + typed error)
- Test: `scripts/test-certified-model-call-retry.mts` (new)

- [ ] **Step 1: Write the failing test**

`callCertifiedModel` accepts an injected `streamChat` and a `context` — build a minimal context the same way `scripts/test-certified-gameiq-runner.mts` does (reuse its context/mock helpers; it already constructs `CertifiedRunContext` objects for Node runs).

```ts
/* Retry behavior for certified model calls (run: npx tsx scripts/test-certified-model-call-retry.mts) */
import { callCertifiedModel, CertifiedProviderError } from "../lib/benchmark/certified/model-call";
import { classifyProviderFailure } from "../lib/benchmark/certified/classify-provider-failure";
// ...reuse the context/mock scaffolding from test-certified-gameiq-runner.mts...

let failures = 0;
function check(name: string, ok: boolean, detail?: unknown): void {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` -> ${JSON.stringify(detail)}`}`);
}

check("503 classifies transient", classifyProviderFailure("ChatGPT request failed: 503") === "transient");
check("timeout classifies transient", classifyProviderFailure("Certified model call timed out after 120000ms.") === "transient");
check("empty response classifies transient", classifyProviderFailure("Certified provider returned an empty response.") === "transient");
check(
  "quota-depleted classifies fatal",
  classifyProviderFailure("[429] Your prepayment credits are depleted. Please go to AI Studio…") === "fatal"
);
check("invalid key classifies fatal", classifyProviderFailure("Unauthorized: invalid api key") === "fatal");

// transient error then success -> call succeeds with 2 attempts recorded
let calls = 0;
const flaky = async function* () {
  calls++;
  if (calls === 1) throw new Error("ChatGPT request failed: 503");
  yield { type: "token" as const, content: '{"action":{"column":3}}' };
};
const result = await callCertifiedModel({
  model: { modelId: "test:model", providerId: "test", displayName: "t" } as never,
  system: "s", user: "u", maxTokens: 128, temperature: 0,
  context: makeTestContext(), participantId: "p",
  streamChat: () => flaky(),
  retryDelaysMs: [0, 0], // test override: no real sleeping
});
check("transient error retried to success", result.rawResponse.includes('"column":3') && calls === 2);

// fatal error -> throws CertifiedProviderError immediately (1 call, no retry)
calls = 0;
const dead = async function* () {
  calls++;
  throw new Error("Your prepayment credits are depleted.");
  yield { type: "token" as const, content: "" };
};
let threw: unknown = null;
try {
  await callCertifiedModel({
    model: { modelId: "test:model", providerId: "test", displayName: "t" } as never,
    system: "s", user: "u", maxTokens: 128, temperature: 0,
    context: makeTestContext(), participantId: "p",
    streamChat: () => dead(),
    retryDelaysMs: [0, 0],
  });
} catch (error) { threw = error; }
check(
  "fatal error throws typed error without retry",
  threw instanceof CertifiedProviderError && threw.classification === "fatal" && calls === 1
);

console.log(failures === 0 ? "PASS" : `FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
```

- [ ] **Step 2: Run to verify failure** — `npx tsx scripts/test-certified-model-call-retry.mts` → FAIL (no `classifyProviderFailure`, no `CertifiedProviderError`, no `retryDelaysMs`).

- [ ] **Step 3: Implement classification in `classify-provider-failure.ts`**

```ts
const PROVIDER_FAILURE_PATTERN =
  /provider|api key|unauthorized|rate.?limit|quota|429|502|503|timed?\s?out|timeout/;

export function isProviderFailureMessage(message: string): boolean {
  return PROVIDER_FAILURE_PATTERN.test(message.toLowerCase());
}

export type ProviderFailureClass = "transient" | "fatal" | "other";

// Fatal patterns win over transient ones: a quota/billing 429 must not be
// retried (every retry burns nothing but time — the account is out of funds),
// while a rate-limit 429 or any 5xx/timeout usually clears on its own.
const FATAL_PATTERN =
  /credits? (are )?depleted|prepayment|billing|quota exceeded|insufficient (funds|quota|credit)|payment required|api key|unauthorized|forbidden|invalid.*key|model.*not.*(found|exist)/i;
const TRANSIENT_PATTERN =
  /timed?\s?out|timeout|too many requests|rate.?limit|429|500|502|503|504|overloaded|server error|unavailable|network|fetch failed|econn|socket|empty response|aborted.*stream/i;

export function classifyProviderFailure(message: string): ProviderFailureClass {
  if (FATAL_PATTERN.test(message)) return "fatal";
  if (TRANSIENT_PATTERN.test(message)) return "transient";
  return "other";
}
```

- [ ] **Step 4: Implement the retry loop and typed error in `model-call.ts`**

Add to the module:

```ts
export class CertifiedProviderError extends Error {
  readonly classification: ProviderFailureClass;
  constructor(message: string, classification: ProviderFailureClass) {
    super(message);
    this.name = "CertifiedProviderError";
    this.classification = classification;
  }
}

const DEFAULT_RETRY_DELAYS_MS = [2_000, 8_000];
```

Add `retryDelaysMs?: number[]` to `CallCertifiedModelInput`. Then rename the current function body to `callCertifiedModelOnce` (private, unchanged except: in its catch, before `throw error`, wrap non-budget errors: `throw new CertifiedProviderError(message, classifyProviderFailure(message))` — keep `CertifiedBudgetExceededError` rethrown as-is). The public `callCertifiedModel` becomes:

```ts
export async function callCertifiedModel(
  input: CallCertifiedModelInput
): Promise<CertifiedModelCallResult> {
  const delays = input.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
  let lastError: unknown;
  for (let attempt = 0; attempt <= delays.length; attempt++) {
    if (attempt > 0) {
      const jitter = Math.floor(Math.random() * 500);
      await sleepUnlessAborted(delays[attempt - 1] + jitter, input.signal);
    }
    throwIfCertifiedRunAborted(input.signal);
    try {
      return await callCertifiedModelOnce(input);
    } catch (error) {
      lastError = error;
      if (error instanceof CertifiedBudgetExceededError) throw error;
      const transient =
        error instanceof CertifiedProviderError && error.classification === "transient";
      if (!transient) throw error;
      // transient: loop for the next attempt (each attempt records its own
      // trace via callCertifiedModelOnce, so the retry history is auditable)
    }
  }
  throw lastError;
}

async function sleepUnlessAborted(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => { clearTimeout(timer); reject(abortedError(signal)); },
      { once: true }
    );
  });
}
```

Notes: abort signal still wins over sleeping; every physical attempt records its own trace (`finalStatus: "provider_error"` for failures) so replay/consensus tooling must key traces by `scenarioId` (added in Task B4) rather than assuming one trace per scenario.

- [ ] **Step 5: Run tests** — `npx tsx scripts/test-certified-model-call-retry.mts` → PASS; also `npx tsx scripts/test-certified-gameiq-runner.mts && npx tsx scripts/test-certified-e2e-gameiq.mts` → PASS (mock models never throw transient errors, so behavior is unchanged there).

- [ ] **Step 6: Commit**

```bash
git add lib/benchmark/certified/classify-provider-failure.ts lib/benchmark/certified/model-call.ts scripts/test-certified-model-call-retry.mts
git commit -m "feat(certified): retry transient provider errors with backoff; typed provider failures"
```

### Task B2: Per-scenario transport containment (score integrity for unanswered scenarios)

**Files:**
- Modify: `lib/benchmark/gameiq/types.ts` (`GameIqScenarioResult.unscored`, metrics fields, harness version bump)
- Modify: `lib/benchmark/gameiq/runner.ts` (catch → unscored, denominator exclusion, validity rule)
- Modify: `lib/benchmark/gameiq/certified-runner.ts` (assertion detail shows unscored)
- Test: `scripts/test-gameiq-transport-containment.mts` (new)

Semantics: after B1's retries a scenario call can still fail. That scenario becomes `unscored: "transport"` — excluded from every metric denominator (outcome, quality, legality, structure, fallback). If unscored/total > 0.1 the attempt is invalid (`provider_unavailable`, excluded from the leaderboard like today's excluded attempts); otherwise the attempt scores on the scenarios that ran. A `fatal` provider error rethrows (aborts the remaining scenarios — Task B3 keeps completed packs). This replaces both old behaviors: silent zero-scoring (pre-07-03) and whole-run voiding (HEAD).

- [ ] **Step 1: Write the failing test**

```ts
/* Transport containment (run: npx tsx scripts/test-gameiq-transport-containment.mts) */
import { runGameIqScenarios } from "../lib/benchmark/gameiq";
import { listGameIqScenarioPacks } from "../lib/benchmark/gameiq";
import { CertifiedProviderError } from "../lib/benchmark/certified/model-call";

let failures = 0;
function check(name: string, ok: boolean, detail?: unknown): void {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` -> ${JSON.stringify(detail)}`}`);
}

const pack = listGameIqScenarioPacks().find((p) => p.id === "gameiq-v0.1-connect-four")!;
const scenarios = pack.scenarios.slice(0, 10);
const perfect = (scenario: (typeof scenarios)[number]) => scenario.expectedActions[0].action;

// one transient transport failure among 10 -> excluded, attempt still scored
const one = await runGameIqScenarios({
  runId: "t", modelId: "m", teamCompositionId: "team", scenarios,
  moveProvider: ({ scenario, scenarioIndex }) => {
    if (scenarioIndex === 3) throw new CertifiedProviderError("timed out", "transient");
    return { action: perfect(scenario) };
  },
});
check("1/10 transport: scenario marked unscored", one.caseResults[3].unscored === "transport");
check("1/10 transport: metrics exclude it", one.metrics.scenarioCount === 10 && one.metrics.scoredScenarioCount === 9);
check("1/10 transport: outcome unaffected by the gap", one.metrics.outcomeScore === 1);
check("1/10 transport: attempt still passes", one.attempt.status === "passed");

// four transport failures among 10 (> 10%) -> attempt invalid
const many = await runGameIqScenarios({
  runId: "t2", modelId: "m", teamCompositionId: "team", scenarios,
  moveProvider: ({ scenario, scenarioIndex }) => {
    if (scenarioIndex % 3 === 0) throw new CertifiedProviderError("503", "transient");
    return { action: perfect(scenario) };
  },
});
check("4/10 transport: attempt provider_unavailable", many.attempt.status === "provider_unavailable");

// fatal error -> rethrows out of the runner
let threw: unknown = null;
try {
  await runGameIqScenarios({
    runId: "t3", modelId: "m", teamCompositionId: "team", scenarios,
    moveProvider: () => { throw new CertifiedProviderError("credits depleted", "fatal"); },
  });
} catch (error) { threw = error; }
check("fatal: rethrows", threw instanceof CertifiedProviderError);

console.log(failures === 0 ? "PASS" : `FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
```

- [ ] **Step 2: Run to verify failure** — `npx tsx scripts/test-gameiq-transport-containment.mts` → FAIL.

- [ ] **Step 3: Implement**

`lib/benchmark/gameiq/types.ts`:
- `GameIqScenarioResult` gains `unscored?: "transport"`.
- `GameIqRunMetrics` gains `scoredScenarioCount: number; unscoredTransport: number;`.
- `GAMEIQ_HARNESS_VERSION` → `"gameiq-runner-v0.3"` with comment `// v0.3: transport-failed scenarios are excluded from scoring (unscored) instead of counted as wrong; >10% unscored invalidates the attempt.`
- Add `export const GAMEIQ_MAX_UNSCORED_RATE = 0.1;`
- `CertifiedAttemptStatus` already includes `provider_unavailable` (verify in `lib/benchmark/types.ts` — it is the status the run engine synthesizes today).

`lib/benchmark/gameiq/runner.ts` — in `evaluateScenario`, wrap the `moveProvider` call:

```ts
  let providerResult: GameIqProviderResult;
  try {
    providerResult = normalizeProviderResult(
      await input.moveProvider({ scenario, scenarioIndex, totalScenarios })
    );
  } catch (error) {
    if (
      error instanceof CertifiedProviderError &&
      error.classification === "transient"
    ) {
      return {
        scenarioId: scenario.id,
        gameId: scenario.gameId,
        category: scenario.category,
        initialState: scenario.initialState,
        expectedActions: scenario.expectedActions,
        action: null,
        rawResponse: error.message,
        structured: false,
        legal: false,
        correct: false,
        actionQuality: 0,
        latencyMs: 0,
        forbiddenBlunder: false,
        fallbackUsed: false,
        unscored: "transport",
        messages: [`Provider transport failure after retries: ${error.message}`],
      };
    }
    throw error; // fatal / other / budget: abort the attempt (run engine + B3 handle it)
  }
```

In `runGameIqScenarios`, compute metrics over scored results only and apply the validity rule:

```ts
  const scored = caseResults.filter((result) => !result.unscored);
  const unscoredTransport = caseResults.length - scored.length;
  // ...existing counters and grouped averages, but built from `scored`...
  const metrics: GameIqRunMetrics = {
    scenarioCount: caseResults.length,
    scoredScenarioCount: scored.length,
    unscoredTransport,
    // ...existing fields computed from `scored`/its groups...
  };
  const score = scoreGameIqAttempt(metrics);
  const status =
    scored.length === 0 ||
    unscoredTransport / caseResults.length > GAMEIQ_MAX_UNSCORED_RATE
      ? "provider_unavailable"
      : statusFromScore(score, metrics);
```

and use `status` in the returned attempt. Import `CertifiedProviderError` from `@/lib/benchmark/certified/model-call` — if that import direction creates a cycle (`model-call` must not import the runner; it doesn't today), keep it; otherwise move the error class to a new `lib/benchmark/certified/provider-error.ts` and re-export from `model-call.ts`.

`lib/benchmark/gameiq/certified-runner.ts` — in `createGameIqVerifierResult`, surface containment: assertion `label` gets ` (unscored: transport)` suffix and `passed: false` is replaced by `passed: true, weight: 0` for unscored scenarios? **No** — keep it simple and honest: unscored assertions keep `passed: false` but their `message` starts with `UNSCORED (transport)` and the `caseResults` entry carries `unscored`. Dashboards already read `resultJson`.

- [ ] **Step 4: Run tests** — containment test PASS; also `npx tsx scripts/test-gameiq-scoring.mts && npx tsx scripts/test-gameiq-scenarios.mts && npx tsx scripts/test-certified-gameiq-runner.mts` → PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/benchmark/gameiq scripts/test-gameiq-transport-containment.mts
git commit -m "feat(gameiq): contain transient transport failures as unscored scenarios (10% validity rule)"
```

### Task B3: Incremental attempt persistence (a failed run keeps its finished packs)

**Files:**
- Modify: `components/benchmark/certified/CertifiedRunPanel.tsx` (record each pack's attempts as they land)
- Verify (no change expected): `lib/benchmark/certified/run-engine.ts` `createFailedAttemptsForRunError` already skips already-recorded attempts via `existingKeys` from `context.snapshot()`
- Test: `scripts/test-certified-run-partial-persistence.mts` (new)

- [ ] **Step 1: Write the failing test**

Drive `runCertifiedBenchmark` with a scripted runner that records one attempt then throws a fatal provider error; assert the summary keeps the recorded attempt and synthesizes failed rows only for the rest. Reuse the certification/context scaffolding from `scripts/test-certified-gameiq-runner.mts` (it already builds a passing `HarnessCertificationResult` and team compositions for Node).

```ts
/* Partial persistence on mid-run failure (run: npx tsx scripts/test-certified-run-partial-persistence.mts) */
// scaffolding imports as in test-certified-gameiq-runner.mts ...
import { runCertifiedBenchmark } from "../lib/benchmark/certified/run-engine";

const summary = await runCertifiedBenchmark({
  suiteId: "suite-test", track: "gameiq", harnessProfile: DIRECT_MODEL_HARNESS,
  caseIds: ["case-a", "case-b", "case-c"], teamCompositionIds: [team.id],
  certification, runner: async (context) => {
    await context.recordAttempt(makeScoredAttempt(context, "case-a", team.id)); // helper: a passed attempt for case-a
    throw new Error("Your prepayment credits are depleted.");
  },
});

check("run reports failed", summary.status === "failed");
const attempts = summary.snapshot.attempts;
check("scored attempt for case-a survives", attempts.some(a => a.caseId === "case-a" && a.status === "passed"));
check("case-b/c synthesized as provider_unavailable",
  ["case-b", "case-c"].every(id => attempts.some(a => a.caseId === id && a.status === "provider_unavailable")));
check("no synthesized row clobbers case-a",
  attempts.filter(a => a.caseId === "case-a").length === 1);
```

(`makeScoredAttempt` builds a minimal `BenchmarkAttemptV2` with the run's id/track — copy the attempt shape from `runGameIqScenarios`' returned attempt.)

- [ ] **Step 2: Run to verify current behavior**

Run: `npx tsx scripts/test-certified-run-partial-persistence.mts`
Expected: PASS already at the engine level (the engine skips `existingKeys`) — the missing piece is that the **GameIQ UI runner never records attempts before the end**. If it passes, keep the test (it pins the engine contract) and move to Step 3.

- [ ] **Step 3: Record per pack in `CertifiedRunPanel.tsx`**

In the GameIQ `runner:` callback (around line 757), record each pack's re-idd attempts as soon as the pack finishes, and return `[]` so `persistReturnedAttempts` cannot double-record:

```ts
          runner: async (context, options) => {
            const attempts: BenchmarkAttempt[] = [];
            for (const packId of gameIqPackIds) {
              const packContext = gameIqPackRunContext(context, packId);
              const packAttempts = await runCertifiedGameIq({
                context: packContext,
                models: [model],
                scenarioPackIds: [packId],
                teamCompositionIds: [team.id],
                trials: 1,
                signal: options?.signal,
              });
              const reidd = packAttempts.map((attempt) =>
                reidGameIqPackAttempt(attempt, packId)
              );
              // Persist immediately: a provider failure in a later pack must
              // not void packs that already completed and verified.
              for (const attempt of reidd) {
                await context.recordAttempt(attempt);
              }
              attempts.push(...reidd);
              capturedAttempts = [...attempts];
            }
            capturedAttempts = attempts;
            return []; // already recorded incrementally
          },
```

Also update the UI outcome derivation right below: `classifyGameIqModelRunOutcome(true, capturedAttempts)` already reads `capturedAttempts` — now, on a failed run, derive partial outcome too: in the `result.status !== "completed"` branch, if `capturedAttempts.length > 0` include `packsScored`/`packsPassed` from `classifyGameIqModelRunOutcome(false, capturedAttempts)` so the per-model badge shows "failed (4/7 packs scored)" instead of a bare failure. (Check `classifyGameIqModelRunOutcome`'s signature in this file and pass whatever its first parameter expects for a failed run.)

- [ ] **Step 4: Verify the verifier linkage survives**

`recordVerifier` already persists verifiers as they are created inside `runCertifiedGameIq`; with attempts now recorded too, the exported run file keeps both (the investigation showed verifiers were dropped only because their attempts were voided). Run: `npx tsx scripts/test-certified-e2e-gameiq.mts` → PASS.

- [ ] **Step 5: Lint and commit**

Run: `npm run lint`

```bash
git add components/benchmark/certified/CertifiedRunPanel.tsx scripts/test-certified-run-partial-persistence.mts
git commit -m "feat(benchmark): persist GameIQ pack attempts incrementally; mid-run failure keeps finished packs"
```

### Task B4: Scenario-level parallelism + trace→scenario linkage

**Files:**
- Modify: `lib/benchmark/gameiq/runner.ts` (bounded-concurrency loop)
- Modify: `lib/benchmark/gameiq/types.ts` (`RunGameIqScenariosInput.concurrency`)
- Modify: `lib/benchmark/gameiq/certified-runner.ts` (pass `scenarioId` to `callCertifiedModel`, plumb concurrency)
- Modify: `lib/benchmark/certified/model-call.ts` + `lib/benchmark/certified/trace-recorder.ts` + `lib/benchmark/types.ts` (`scenarioId?` on traces)
- Modify: `components/benchmark/certified/CertifiedRunPanel.tsx` (pass `concurrency: 4`)
- Modify: `scripts/replay-gameiq-traces.mts`, `scripts/audit-gameiq-consensus.mts` (prefer `scenarioId`, fall back to `startedAt` order for legacy files)
- Test: extend `scripts/test-gameiq-scoring.mts`

Wall-clock effect: GPT-5.5's 42-minute suite drops to ~11 min at concurrency 4; the failure-exposure window and cache/quota burn shrink with it.

- [ ] **Step 1: Write the failing test**

Append to `scripts/test-gameiq-scoring.mts`:

```ts
// --- concurrency: results stay in scenario order, all scenarios run ---
const order: number[] = [];
const parallel = await runGameIqScenarios({
  runId: "c", modelId: "m", teamCompositionId: "team",
  scenarios: scenarios.slice(0, 8),
  concurrency: 4,
  moveProvider: async ({ scenario, scenarioIndex }) => {
    await new Promise((r) => setTimeout(r, (8 - scenarioIndex) * 5)); // reverse-ordered delays
    order.push(scenarioIndex);
    return { action: scenario.expectedActions[0].action };
  },
});
check(
  "concurrency: caseResults preserve scenario order",
  parallel.caseResults.map((r) => r.scenarioId).join() ===
    scenarios.slice(0, 8).map((s) => s.id).join()
);
check("concurrency: out-of-order completion occurred", order.join() !== [...order].sort((a, b) => a - b).join());
```

- [ ] **Step 2: Run to verify failure** — `concurrency` is not an accepted input → type/compile error or ignored-option failure.

- [ ] **Step 3: Implement the pool in `runGameIqScenarios`**

Replace the sequential for-loop:

```ts
  const concurrency = Math.max(1, Math.floor(input.concurrency ?? 1));
  const caseResults: GameIqScenarioResult[] = new Array(input.scenarios.length);
  let cursor = 0;
  let firstFatal: unknown = null;
  const workers = Array.from({ length: Math.min(concurrency, input.scenarios.length) }, async () => {
    for (;;) {
      if (firstFatal) return;
      const index = cursor++;
      if (index >= input.scenarios.length) return;
      try {
        caseResults[index] = await evaluateScenario(
          input.scenarios[index], index, input.scenarios.length, input
        );
      } catch (error) {
        firstFatal = firstFatal ?? error; // fatal/budget: stop pulling new work
      }
    }
  });
  await Promise.all(workers);
  if (firstFatal) throw firstFatal;
```

(`evaluateScenario` already absorbs transient failures from B2, so only fatal/budget errors reach `firstFatal`.) Default `concurrency` 1 keeps every existing test deterministic.

- [ ] **Step 4: Trace linkage**

- `lib/benchmark/types.ts`: add `scenarioId?: string` to `BenchmarkModelCallTrace`.
- `lib/benchmark/certified/trace-recorder.ts` (`createCertifiedModelCallTrace` input) and `lib/benchmark/certified/model-call.ts` (`CallCertifiedModelInput`): plumb `scenarioId?: string` through to the trace record (both the success and error trace constructions).
- `lib/benchmark/gameiq/certified-runner.ts` moveProvider: pass `scenarioId: scenario.id` to `callCertifiedModel`, and `concurrency: input.concurrency` through `RunCertifiedGameIqInput` → `runGameIqScenarios`.
- `components/benchmark/certified/CertifiedRunPanel.tsx`: pass `concurrency: 4` in the `runCertifiedGameIq` call.
- Replay/consensus scripts: group traces by `trace.scenarioId` when present; keep the `startedAt`-order fallback for pre-v0.3 run files.

- [ ] **Step 5: Run tests** — `npx tsx scripts/test-gameiq-scoring.mts && npx tsx scripts/test-certified-gameiq-runner.mts && npx tsx scripts/test-certified-e2e-gameiq.mts && npm run lint` → PASS.

- [ ] **Step 6: Commit**

```bash
git add lib/benchmark components/benchmark/certified/CertifiedRunPanel.tsx scripts/replay-gameiq-traces.mts scripts/audit-gameiq-consensus.mts scripts/test-gameiq-scoring.mts
git commit -m "feat(gameiq): bounded scenario concurrency (4x wall-clock cut) + scenarioId on traces"
```

### Task B5: Recovery CLI for voided runs + index hygiene

**Files:**
- Create: `scripts/recover-gameiq-run.mts`
- Test: manual dry-run + `--write` against the two dead run files (this IS the deliverable: recover the Gemini and GPT-5.5 results)

- [ ] **Step 1: Write the recovery script**

Build on `replay-gameiq-traces.mts` (same trace→scenario mapping): for each case whose traces cover ALL scenarios of the pack, re-score with `runGameIqScenarios` and replace the synthesized `provider_unavailable` attempt in the run file with the replayed attempt + verifier result; leave incomplete cases (the interrupted Memory pack) excluded. Mark recovered attempts honestly: `harnessVersion: `${GAMEIQ_HARNESS_VERSION}+recovered``. Also rewrite `benchmarks/index.json` to drop entries whose file is missing (the stale `ui-gameiq-1783024693655-…` entry).

Key logic (complete script structure — flesh out with the replay script's existing loaders):

```ts
/* Recover voided GameIQ attempts from recorded traces.
 * Usage: npx tsx scripts/recover-gameiq-run.mts <run-file.json> [--write]
 */
// 1. load run file; require runs[0].status === "failed"
// 2. per pack (listGameIqScenarioPacks): map traces (scenarioId ?? startedAt order),
//    skip pack unless usable traces === pack.scenarios.length
// 3. replay through runGameIqScenarios (concurrency 1) with recorded actions
// 4. rebuild attempt (re-id to `${runId}:${packId}:${teamCompositionId}:recovered`? NO —
//    reuse the ORIGINAL synthesized attempt id so verifierResultId/attempt joins stay stable;
//    replace status/scores/verifiedQuality/... from the replay, set
//    harnessVersion suffix "+recovered")
// 5. build verifier via the same shape as createGameIqVerifierResult (copy that
//    function's output shape; it is module-private, so reconstruct: passed/score/
//    resultJson with assertions + caseResults)
// 6. --write: back up `<file>.bak`, write updated JSON (attemptsV2, verifierResults,
//    runs[0].summaryJson left untouched but append a `recovery` note object), and
//    prune missing-file entries from ../index.json
// 7. always print a per-pack before/after table
```

- [ ] **Step 2: Dry-run both dead runs**

Run: `npx tsx scripts/recover-gameiq-run.mts "C:/Users/b_a_s/OneDrive/Documents/AIBoard/benchmarks/runs/ui-gameiq-1783026417445-google-google-gemini-3-5-flash-0.json"` and the GPT-5.5 file.
Expected: 6 packs recoverable each; Memory reported "incomplete (13/30, 26/30 usable) — not recovered". Scores match the investigation's replay table (under v0.3 scoring the absolute numbers differ from the v0.2 table — verify pass/fail verdicts and correct-counts instead).

- [ ] **Step 3: Recover for real**

Run both with `--write`. Then start the dev server, open the benchmark dashboard, and confirm the Gemini/GPT-5.5 rows show 6 scored packs each (verify via `npm run dev` + the certified dashboard; per CLAUDE.md do not run a production build while the dev server is up).

- [ ] **Step 4: Commit**

```bash
git add scripts/recover-gameiq-run.mts
git commit -m "feat(gameiq): trace-replay recovery CLI for voided runs; prune stale index entries"
```

### Task B6: Call defaults & dead-field cleanup

**Files:**
- Modify: `lib/benchmark/gameiq/certified-runner.ts` (`DEFAULT_GAMEIQ_MAX_TOKENS`)
- Modify: `lib/benchmark/gameiq/types.ts` (remove `maxResponseMs` from `GameIqScenario`)
- Modify: pack files `lib/benchmark/gameiq/{chess,connect-four,battleship,codenames}.ts` + `lib/benchmark/gameiq/fireworks.ts` (`toGameIqScenario`) — delete the field
- Test: existing pack tests + `npx tsx scripts/test-gameiq-shared-guards.mts`

- [ ] **Step 1: Raise the completion cap**

```ts
// Reasoning models bill/stream thinking tokens against max output tokens: the
// observed GPT-5.5 GameIQ calls emitted 3-19k tokens before the ~20-token
// answer. 2048 would truncate them into empty answers on providers that
// enforce the cap (conciseness is prompt-driven, never maxTokens-driven).
const DEFAULT_GAMEIQ_MAX_TOKENS = 16_384;
```

- [ ] **Step 2: Remove `maxResponseMs`**

It is set on all 166 scenarios and read by nothing (verified 2026-07-03: only pack literals + the type). Delete the field from `GameIqScenario`, every pack literal, and `toGameIqScenario`. It misleads authors into thinking latency is enforced; the enforced timeout is `DEFAULT_CERTIFIED_MODEL_CALL_TIMEOUT_MS` (120s per call). Do NOT bump pack `version` fields for this — model-facing prompts and expected actions are unchanged (the field never reached the model), and `stableGameIqScenarioPackDigest` changes are acceptable for a non-behavioral field removal… **Correction:** the digest feeds contamination/certification records; to stay conservative bump each affected GameIQ pack's patch version (`0.2.0`→`0.2.1`, chess `0.3.0`→`0.3.1`, fireworks packs to their next patch after A2) with comment `// 0.x.y: removed dead maxResponseMs field (never enforced, never model-visible)`.

- [ ] **Step 3: Verify + commit**

Run: `npx tsx scripts/test-gameiq-chess-pack.mts && npx tsx scripts/test-gameiq-connect-four-pack.mts && npx tsx scripts/test-gameiq-battleship-pack.mts && npx tsx scripts/test-gameiq-codenames-pack.mts && npx tsx scripts/test-gameiq-fireworks-pack.mts && npx tsx scripts/test-gameiq-shared-guards.mts && npm run lint`

```bash
git add lib/benchmark/gameiq
git commit -m "chore(gameiq): raise completion cap for reasoning models; remove dead maxResponseMs"
```

---

## Phase C — Saturation registry and frontier reporting

### Task C1: Saturation registry generated from the four reference runs

**Files:**
- Create: `scripts/generate-gameiq-saturation.mts`
- Create (generated, committed): `lib/benchmark/gameiq/saturation.ts`

No pack surgery yet (physical pruning happens with the Phase D content plans, so caseIds and leaderboard history stay comparable). The registry powers reporting and the eventual cut list.

- [ ] **Step 1: Write the generator**

```ts
/* Regenerates lib/benchmark/gameiq/saturation.ts from exported run files.
 * Usage: npx tsx scripts/generate-gameiq-saturation.mts <run1.json> <run2.json> ... > lib/benchmark/gameiq/saturation.ts
 * A scenario is SATURATED when every model that attempted it (min 3 models)
 * answered correctly (official verifier verdicts for completed runs; trace
 * replay verdicts for voided runs — same mapping as replay-gameiq-traces.mts).
 */
```

Implementation: reuse the replay mapping to produce a `scenarioId -> {model: passed}` table (verifier `assertionResults` when present, replay otherwise), then emit:

```ts
// AUTO-GENERATED by scripts/generate-gameiq-saturation.mts — do not hand-edit.
// Source runs: <run ids + models>, generated <ISO date>.
// A scenario is listed when every model that attempted it (>= 3) passed.
export const GAMEIQ_SATURATED_SCENARIO_IDS: ReadonlySet<string> = new Set([
  // ...ids...
]);
```

- [ ] **Step 2: Generate and sanity-check**

Run the generator over the four run files. Expected: ~105 ids; spot-check that `gameiq-v0.1-battleship-*` contributes all 11 of its ids and that none of `gameiq-fireworks-hard-v1-{11,12,13,14,16,17,18,19,20,23,27,28,29}` appear.

- [ ] **Step 3: Commit**

```bash
git add scripts/generate-gameiq-saturation.mts lib/benchmark/gameiq/saturation.ts
git commit -m "feat(gameiq): saturation registry generated from 2026-07 reference runs"
```

### Task C2: Frontier report + drop Battleship from the default bundle

**Files:**
- Create: `scripts/report-gameiq-frontier.mts`
- Modify: `components/benchmark/certified/CertifiedRunPanel.tsx` (`gameIqBundlePackIds`: remove `gameiq-v0.1-battleship` from the all-packs bundle; it stays selectable standalone)

- [ ] **Step 1: Frontier report script**

```ts
/* Frontier leaderboard: per-model, per-pack scores recomputed EXCLUDING
 * saturated scenarios, from exported run files.
 * Usage: npx tsx scripts/report-gameiq-frontier.mts <run1.json> ...
 */
```

Implementation: for each run file, per pack, take per-scenario verdicts (verifier `resultJson.caseResults`, falling back to trace replay for voided runs), filter out `GAMEIQ_SATURATED_SCENARIO_IDS`, recompute correct-rate and a frontier score via `scoreGameIqAttempt` over the filtered scenario results (rebuild grouped metrics exactly the way `runGameIqScenarios` does — extract that aggregation into an exported helper `aggregateGameIqMetrics(caseResults)` in `lib/benchmark/gameiq/runner.ts` and reuse it in both places). Print a models × packs table plus an overall frontier ranking.

- [ ] **Step 2: Battleship out of the default bundle**

In `gameIqBundlePackIds` remove `"gameiq-v0.1-battleship"` from the all-packs list with the comment `// battleship: 11/11 saturated across all four 2026-07 reference models — zero discrimination; standalone runs remain available until the pack is re-authored (content plan).` Default suite drops 166→155 scenarios.

- [ ] **Step 3: Verify + commit**

Run: `npx tsx scripts/report-gameiq-frontier.mts <four run files>` — expected: Battleship rows show "no unsaturated scenarios"; Trap States ranks as the most discriminating pack; `npx tsx scripts/test-gameiq-bundle-suite.mts && npm run lint` PASS (update the bundle-suite test's expected pack list — it pins the bundle contents).

```bash
git add scripts/report-gameiq-frontier.mts components/benchmark/certified/CertifiedRunPanel.tsx scripts/test-gameiq-bundle-suite.mts lib/benchmark/gameiq/runner.ts
git commit -m "feat(gameiq): frontier (saturation-excluded) report; drop saturated battleship pack from default bundle"
```

---

## Phase D — Content hardening charters (separate follow-up plans)

New scenario authoring is creative work with per-game oracles — each charter below becomes its own brainstorm + plan (superpowers flow) AFTER a fresh 4-model run on the hardened harness provides updated discrimination data. Do NOT start these inside this plan. Shared rules for every charter:

- Every new scenario must ship with an engine/oracle completeness test (the chess/connect-four/fireworks pack tests are the pattern) — keys = ALL optimal actions, forbidden = engine-provable blunders only.
- Difficulty gate: a candidate scenario is kept only if, in trace replay against the four 2026-07 reference runs (or a fresh probe run), at least one frontier model fails it — otherwise it is born saturated.
- `scripts/audit-gameiq-consensus.mts` runs after every new multi-model run; any ≥2-model non-keyed convergence gets engine-adjudicated before the pack version ships.
- Rigor floor (`gameIqPackFirstClassFloor`) with the A1 correct-bar must pass for first-class tier claims.

| Charter | Scope sketch |
|---|---|
| **Battleship v2** | Replace the saturated pack: multi-shot hunt efficiency scored against the placement-enumeration oracle already used by `test-gameiq-battleship-pack.mts` (expected-shots-to-sink vs oracle optimum), parity targeting, overlapping-ship deduction boards. |
| **Chess depth** | Mate-in-2 with unique keys (engine search proves uniqueness), only-move defenses, underpromotion-only wins. |
| **Connect Four depth** | Win-in-2 forced sequences, don't-enable-the-fork traps (opponent fork columns as `forbiddenActions` — the observed Opus weakness), odd/even threat parity endgames. |
| **Codenames adversarial** | More assassin-adjacent semantic traps (the only non-fireworks scenario a frontier model failed), distractor-heavy boards, multi-step guess chains. |
| **Fireworks horizon** | Longer memory episodes with distractor clues (GPT-5.5 went 25/25 on current memory), 3-player views, discard-race endgames; avoid value-locked states where the keyed move is not strictly better (memory-v1-29 review note). |

---

## Phase E — Validation & rollout

### Task E1: Full test sweep

- [ ] Run every GameIQ-related script and lint; all must PASS:

```bash
npx tsx scripts/test-gameiq-scoring.mts
npx tsx scripts/test-gameiq-scenarios.mts
npx tsx scripts/test-gameiq-shared-guards.mts
npx tsx scripts/test-gameiq-action-normalization.mts
npx tsx scripts/test-gameiq-chess-pack.mts
npx tsx scripts/test-gameiq-connect-four-pack.mts
npx tsx scripts/test-gameiq-battleship-pack.mts
npx tsx scripts/test-gameiq-codenames-pack.mts
npx tsx scripts/test-gameiq-fireworks-pack.mts
npx tsx scripts/test-gameiq-bundle-suite.mts
npx tsx scripts/test-gameiq-multi-model.mts
npx tsx scripts/test-fireworks-gameiq-port.mts
npx tsx scripts/test-fireworks-memory-episode.mts
npx tsx scripts/test-certified-gameiq-runner.mts
npx tsx scripts/test-certified-e2e-gameiq.mts
npx tsx scripts/test-certified-model-call-retry.mts
npx tsx scripts/test-gameiq-transport-containment.mts
npx tsx scripts/test-certified-run-partial-persistence.mts
npm run lint
```

### Task E2: Documentation

- [ ] Update `CLAUDE.md`: add the new test scripts to the test list; add one line to the GameIQ notes: transient provider errors retry (2 backoff attempts) then contain as unscored scenarios (>10% invalidates the attempt); attempts persist per pack; traces carry `scenarioId`; recovery via `scripts/recover-gameiq-run.mts`; saturation registry + frontier report; scoring v0.3 = 0.6 outcome / 0.4 quality with legality/structure as gates.
- [ ] Commit: `git add CLAUDE.md && git commit -m "docs: GameIQ hardening (scoring v0.3, retry/containment, recovery tooling)"`

### Task E3: Fresh reference run (manual, user-driven)

- [ ] Re-run the full suite from the UI with the same four models (Gemini needs credits topped up first). Acceptance:
  - wall-clock per model ≤ ~15 min at concurrency 4;
  - zero `provider_unavailable` **runs** (transient blips appear as retries in `retryHistory` or as isolated unscored scenarios instead);
  - `scripts/audit-gameiq-consensus.mts` over the new run files → adjudicate any new flags;
  - regenerate the saturation registry (`scripts/generate-gameiq-saturation.mts`) with the new runs added, and use the updated frontier report to finalize the physical cut list for the Phase D content plans.

---

## Self-review notes

- Every agreed topic from the analysis maps to a task: oracle fixes (A1-A4), retry (B1), containment + failed_tool_use trap (B2), incremental persistence + verifier export (B3), parallelism (B4), resume/recovery + index hygiene (B5), maxTokens + maxResponseMs (B6), scoring reweight + free-points removal (A1), saturated cut + battleship + review trigger (C1-C2, A4), harder content (Phase D charters), validation (Phase E).
- Version bumps: scoring v0.2→v0.3 once (A1); harness v0.2→v0.3 once (B2); pack patch versions in A2/B6. No double-bumping.
- Type consistency checked: `CertifiedProviderError.classification` (B1) is what B2 catches; `GameIqScenarioResult.unscored` (B2) is what B5's recovery and C2's report read; `scenarioId` on traces (B4) is what B5/A4 scripts prefer; `aggregateGameIqMetrics` is extracted in C2 where first needed.
- Known interim state: between A1 and B2 landing, a single transport failure still nukes a pack via the `failed_tool_use` gate — acceptable inside one plan execution; do not re-run real benchmarks until Phase B completes.
