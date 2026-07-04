/* Certified GameIQ Fireworks pack checks
 * (run: npx tsx scripts/test-gameiq-fireworks-pack.mts)
 *
 * Fireworks had no pack completeness test before this file — the gap that let
 * hard-v1-14/-20 ship with an equal-information clue twin unkeyed (2026-07-03
 * oracle audit; fixed in scenario-packs.ts's widenEquivalentClues, task A2).
 * Chess and connect-four already have engine-verified completeness tests;
 * this is fireworks's counterpart. Every GameIQ fireworks scenario's
 * `initialState` is the (possibly redacted) player VIEW, never ground truth —
 * this file resolves each scenario's `source:<teamiq-id>` tag back to its
 * TeamIQ source (full state) and engine-verifies against THAT, not the view:
 *
 *  - source resolution: every GameIQ scenario's source tag resolves to a real
 *    TeamIQ scenario;
 *  - keyed-action soundness: every keyed action is legal in the prepared
 *    ground-truth state; every keyed `play` targets an engine-playable card;
 *    every keyed `discard` targets a non-critical card;
 *  - forbidden-action soundness (forbidden => harmful): every forbidden
 *    `play` targets an engine-UNplayable card (verified: 42/42, zero
 *    exceptions). Every forbidden `discard` is harmful in one of two
 *    engine-checkable ways (verified: 10 critical-discard + 28
 *    negates-the-keyed-play, zero exceptions, no third case) — either it
 *    targets a CRITICAL card (the critical_discard_avoidance tactics
 *    scenarios), or it discards the exact card index a keyed `play` action
 *    also targets (the memory categories' non-"dead" scenarios key `play` at
 *    weight 1 and forbid `discard` of that identical card, so discarding it
 *    destroys the proven-playable answer the recalled clues established — a
 *    real harm isCriticalCard cannot see, since the card need not be the last
 *    surviving copy to be the scenario's tested decision). No forbidden clue
 *    actions exist today (flagged if one appears, so the invariant gets
 *    revisited consciously rather than silently passing);
 *  - clue-equivalence completeness: for every keyed clue with weight >= 0.75,
 *    every OTHER legal clue on the same target touching the identical
 *    card-id set is itself keyed (any weight) — the invariant behind the
 *    hard-v1-14/-20 fix;
 *  - trap-category coverage: every scenario sourced from avoid_bad_play or
 *    critical_discard_avoidance has at least one forbiddenAction;
 *  - harm-completeness drift alarm (soft-gated, not a soundness bug): the A1
 *    quality review found the GameIQ grader awards the 0.3 neutral floor to
 *    engine-harmful plays/discards that are legal but not enumerated in
 *    forbiddenActions (the redacted view can't detect harm; TeamIQ's
 *    full-state scorer gives 0 for the same action). Mass-adding
 *    forbiddenActions is a content change out of scope for a test file, so
 *    this file instead COUNTS harmful-but-unforbidden actions per pack and
 *    pins the current totals as fixture constants below. A pack change that
 *    moves a pinned number must be a conscious decision — either enumerate
 *    the newly-harmful action as forbidden or accept the inflation and update
 *    the pin with a comment explaining why;
 *  - widening fingerprint: exactly 5 keyed entries across all three packs
 *    carry the label "Equivalent-information clue (auto-widened)". This is
 *    deliberately the SAME count===5 pin test-fireworks-gameiq-port.mts
 *    already carries — duplicated, not complementary — so each file stands
 *    alone as a complete guard; a widening change is expected to update the
 *    pin in both files.
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
import type { FireworksGameIqScenario } from "../lib/benchmark/gameiq/types";
import {
  cloneFireworksState,
  fireworksActionsEqual,
  getLegalFireworksActions,
  isCriticalCard,
  isPlayableCard,
} from "../lib/games/fireworks/engine";
import type {
  FireworksAction,
  FireworksGameState,
} from "../lib/games/fireworks/types";

let failures = 0;

function check(name: string, ok: boolean, detail?: unknown): void {
  if (!ok) failures++;
  console.log(
    `${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` -> ${JSON.stringify(detail)}`}`
  );
}

// --- source resolution --------------------------------------------------

const sources = new Map<string, FireworksScenario>(
  [...FIREWORKS_TACTICS_SCENARIOS, ...FIREWORKS_MEMORY_SCENARIOS].map(
    (scenario) => [scenario.id, scenario]
  )
);

function sourceIdOf(tags: string[]): string | null {
  const tag = tags.find((candidate) => candidate.startsWith("source:"));
  return tag ? tag.slice("source:".length) : null;
}

function sourceOf(tags: string[]): FireworksScenario | null {
  const id = sourceIdOf(tags);
  return id ? (sources.get(id) ?? null) : null;
}

// Prepared ground-truth state: clone the TeamIQ source's full state and force
// the invariants a fresh decision point requires (actor current, status
// "playing") exactly as the widening pass and the port test do, so this file
// stays correct even if a future generator forgets to set them.
function prepared(source: FireworksScenario): FireworksGameState {
  const state = cloneFireworksState(source.state);
  const index = state.players.findIndex(
    (player) => player.id === source.actingPlayerId
  );
  if (index >= 0) state.currentPlayerIndex = index;
  state.status = "playing";
  return state;
}

// Sorted touched-card-id set for a clue action, prefixed by target player so
// two different targets' identical rank/color never collide. Mirrors
// widenEquivalentClues's touchedIds in scenario-packs.ts.
function touchedKey(state: FireworksGameState, action: FireworksAction): string | null {
  if (action.action !== "clue_color" && action.action !== "clue_rank") return null;
  const hand = state.hands.find(
    (candidate) => candidate.playerId === action.targetPlayerId
  );
  if (!hand) return null;
  const ids = hand.cards
    .filter((card) =>
      action.action === "clue_color"
        ? card.color === action.color
        : card.rank === action.rank
    )
    .map((card) => card.id)
    .sort();
  return `${action.targetPlayerId}:${ids.join(",")}`;
}

const TRAP_SOURCE_CATEGORIES = new Set([
  "avoid_bad_play",
  "critical_discard_avoidance",
]);

// Closed label union: PINNED_UNFORBIDDEN_HARM is keyed by this, so adding a
// fourth pack without a conscious pin fails at compile time (missing Record
// key) instead of comparing against a runtime `pinned: undefined`.
type GameIqFireworksPackLabel = "basic" | "hard" | "memory";

interface PackSpec {
  label: GameIqFireworksPackLabel;
  scenarios: FireworksGameIqScenario[];
}

const PACKS: PackSpec[] = [
  { label: "basic", scenarios: FIREWORKS_GAMEIQ_BASIC_SCENARIOS },
  { label: "hard", scenarios: FIREWORKS_GAMEIQ_HARD_SCENARIOS },
  { label: "memory", scenarios: FIREWORKS_GAMEIQ_MEMORY_STRESS_SCENARIOS },
];

// Pinned harm-completeness drift alarm (invariant 6). Counts of legal but
// engine-harmful plays/discards (misplay-certain plays, critical-card
// discards) that are NOT already enumerated as forbiddenActions, per pack.
// Scope: deliberately NARROWER than the forbidden-discard soundness
// disjunction above — class-2 harm (discarding the keyed play's card) is not
// counted, because it is scenario-decision-relative rather than state-harm,
// and counting it would double-count the keyed decision itself.
// These numbers were computed by running this file against the packs landed
// through commit f55739d (A1 graded scoring + A2 clue widening). They are a
// DRIFT ALARM, not an endorsement: each unforbidden-harmful action is a case
// where a real misplay/critical-discard currently earns the GameIQ grader's
// 0.3 neutral floor (TeamIQ's full-state scorer gives 0 for the same action)
// instead of 0, inflating moveQuality (0.4 weight) by up to 0.12 per answer.
// If a future pack change moves a number, that is a conscious decision:
// either enumerate the newly-harmful action(s) as forbidden, or update this
// pin with a comment explaining why the new number is acceptable.
//
// Composition at pin time (basic 65 play / 0 discard, hard 115 play / 10
// discard, memory 90 play / 8 discard): almost entirely unenumerated
// misplays of ordinary filler cards in the acting player's 4-card hand — most
// hands hold 2-3 cards that are neither the scenario's proven-safe decision
// card nor its enumerated trap card, and a random Fireworks hand usually has
// at most one immediately-playable card, so playing any of those filler cards
// is a real (if un-narrated) misplay the redacted view cannot help the model
// detect. This is expected scale for an un-curated-for-this-purpose pack, not
// a sign of a new bug.
const PINNED_UNFORBIDDEN_HARM: Record<GameIqFireworksPackLabel, number> = {
  basic: 65,
  hard: 125,
  memory: 98,
};

const WIDENED_LABEL = "Equivalent-information clue (auto-widened)";
const widenedEntries: Array<{ scenarioId: string; action: FireworksAction }> = [];

for (const pack of PACKS) {
  // One entry per harmful-but-unforbidden action ("<scenario-id> <action-json>"),
  // so a drift failure names every offender instead of a bare count.
  const harmOffenders: string[] = [];

  for (const scenario of pack.scenarios) {
    const source = sourceOf(scenario.tags);
    check(`${scenario.id}: source scenario resolves`, source !== null, {
      tags: scenario.tags,
    });
    if (!source) continue;

    const state = prepared(source);
    const hand = state.hands.find(
      (candidate) => candidate.playerId === source.actingPlayerId
    );
    check(`${scenario.id}: acting player has a hand in the prepared state`, Boolean(hand), {
      actingPlayerId: source.actingPlayerId,
    });
    if (!hand) continue;

    const legal = getLegalFireworksActions(state, source.actingPlayerId);

    // --- keyed-action soundness ------------------------------------------
    for (const expected of scenario.expectedActions) {
      const action = expected.action;
      check(
        `${scenario.id}: keyed action ${JSON.stringify(action)} is legal in the ground-truth state`,
        legal.some((candidate) => fireworksActionsEqual(candidate, action)),
        { action, legal }
      );
      if (action.action === "play") {
        const card = hand.cards[action.cardIndex];
        check(
          `${scenario.id}: keyed play ${JSON.stringify(action)} targets an engine-playable card`,
          Boolean(card) && isPlayableCard(state, card),
          { action, card }
        );
      }
      if (action.action === "discard") {
        const card = hand.cards[action.cardIndex];
        check(
          `${scenario.id}: keyed discard ${JSON.stringify(action)} targets a non-critical card`,
          Boolean(card) && !isCriticalCard(state, card),
          { action, card }
        );
      }
    }

    // --- forbidden-action soundness (forbidden => harmful) ----------------
    for (const forbidden of scenario.forbiddenActions ?? []) {
      if (forbidden.action === "play") {
        const card = hand.cards[forbidden.cardIndex];
        check(
          `${scenario.id}: forbidden play ${JSON.stringify(forbidden)} is engine-UNplayable`,
          Boolean(card) && !isPlayableCard(state, card),
          { forbidden, card }
        );
      } else if (forbidden.action === "discard") {
        const card = hand.cards[forbidden.cardIndex];
        // Harmful in one of two engine-checkable ways (see file header): a
        // CRITICAL-card discard, or a discard that negates a keyed `play` at
        // the identical cardIndex (the memory categories' shape — discarding
        // the card the scenario's own ground truth proves is the answer).
        const critical = Boolean(card) && isCriticalCard(state, card);
        const negatesKeyedPlay = scenario.expectedActions.some(
          (expected) =>
            expected.action.action === "play" &&
            expected.action.cardIndex === forbidden.cardIndex
        );
        check(
          `${scenario.id}: forbidden discard ${JSON.stringify(forbidden)} is harmful (critical card OR negates a keyed play at the same index)`,
          Boolean(card) && (critical || negatesKeyedPlay),
          { forbidden, card, critical, negatesKeyedPlay }
        );
      } else {
        // No forbidden clue actions exist in the packs today (verified
        // directly against scenario-packs.ts). If one appears, fail loudly so
        // the invariant (what would make a forbidden clue "harmful"?) gets a
        // conscious design decision instead of silently passing unchecked.
        check(
          `${scenario.id}: forbidden clue action ${JSON.stringify(forbidden)} is unexpected — revisit this invariant`,
          false,
          { forbidden }
        );
      }
    }

    // --- clue-equivalence completeness ------------------------------------
    // 0.75 = widenEquivalentClues' keyed-clue threshold (scenario-packs.ts)
    // = GAMEIQ_CORRECT_QUALITY_BAR (gameiq/types.ts); keep all three in
    // lockstep.
    const keyedSets = new Set(
      scenario.expectedActions
        .filter((expected) => expected.weight >= 0.75)
        .map((expected) => touchedKey(state, expected.action))
        .filter((key): key is string => key !== null)
    );
    for (const candidate of legal) {
      const key = touchedKey(state, candidate);
      if (!key || !keyedSets.has(key)) continue;
      check(
        `${scenario.id}: equivalent clue ${JSON.stringify(candidate)} (touched set ${key}) is keyed`,
        scenario.expectedActions.some((expected) =>
          fireworksActionsEqual(expected.action, candidate)
        ),
        { candidate, keyedActions: scenario.expectedActions.map((e) => e.action) }
      );
    }

    // --- trap-category coverage --------------------------------------------
    if (TRAP_SOURCE_CATEGORIES.has(source.category)) {
      check(
        `${scenario.id}: trap-category source (${source.category}) has at least one forbiddenAction`,
        (scenario.forbiddenActions ?? []).length > 0,
        { sourceCategory: source.category, forbiddenActions: scenario.forbiddenActions }
      );
    }

    // --- harm-completeness drift alarm (collect offenders; asserted per
    // pack below with the full offender list in the failure detail) ---------
    const forbidden = scenario.forbiddenActions ?? [];
    for (const candidate of legal) {
      const alreadyForbidden = forbidden.some((f) =>
        fireworksActionsEqual(f, candidate)
      );
      if (alreadyForbidden) continue;
      if (candidate.action === "play") {
        const card = hand.cards[candidate.cardIndex];
        if (card && !isPlayableCard(state, card)) {
          harmOffenders.push(`${scenario.id} ${JSON.stringify(candidate)}`);
        }
      } else if (candidate.action === "discard") {
        const card = hand.cards[candidate.cardIndex];
        if (card && isCriticalCard(state, card)) {
          harmOffenders.push(`${scenario.id} ${JSON.stringify(candidate)}`);
        }
      }
    }

    // --- widening fingerprint (accumulate identity, asserted after loop) ---
    for (const expected of scenario.expectedActions) {
      if (expected.label === WIDENED_LABEL) {
        widenedEntries.push({ scenarioId: scenario.id, action: expected.action });
      }
    }
  }

  // Offender identity rides in the detail (printed only on failure), so a
  // drift is diagnosable from the failure line alone — no re-instrumenting.
  check(
    `${pack.label} pack: unforbidden-harm count (${harmOffenders.length}) matches the pinned drift alarm (${PINNED_UNFORBIDDEN_HARM[pack.label]})`,
    harmOffenders.length === PINNED_UNFORBIDDEN_HARM[pack.label],
    {
      pack: pack.label,
      actual: harmOffenders.length,
      pinned: PINNED_UNFORBIDDEN_HARM[pack.label],
      offenders: harmOffenders,
    }
  );
}

// --- widening fingerprint --------------------------------------------------
// Deliberately duplicates test-fireworks-gameiq-port.mts's count===5 pin so
// each file stands alone; a widening change updates both. The collected
// entries (scenario id + action) ride in the detail so a fingerprint failure
// names exactly which widened keys exist.
check(
  "exactly 5 auto-widened clue entries across all three GameIQ fireworks packs",
  widenedEntries.length === 5,
  widenedEntries
);

if (failures === 0) {
  console.log("PASS");
} else {
  console.log(`FAIL ${failures} check(s) failed`);
}

process.exit(failures === 0 ? 0 : 1);
