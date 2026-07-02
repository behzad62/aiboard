/* Fireworks scenario checks (run: npx tsx scripts/test-fireworks-scenarios.mts) */
import {
  FIREWORKS_FULL_GAME_CASES,
  FIREWORKS_MEMORY_SCENARIOS,
  FIREWORKS_TACTICS_SCENARIOS,
  estimateFireworksModelCallsPerComposition,
  fireworksCaseToBenchmarkCaseV2,
  getFireworksRuntimeCasesForSuite,
  scoreFireworksScenarioAction,
  stableFireworksScenarioPackDigest,
} from "../lib/benchmark/fireworks/scenario-packs";
import type {
  FireworksBenchmarkSuite,
  FireworksFullGameCase,
  FireworksScenario,
} from "../lib/benchmark/fireworks/types";
import {
  getLegalFireworksActions,
  isCriticalCard,
  isPlayableCard,
} from "../lib/games/fireworks/engine";
import { getFireworksPlayerView } from "../lib/games/fireworks/hidden-view";
import type { FireworksAction } from "../lib/games/fireworks/types";

let failures = 0;

function check(name: string, ok: boolean, detail?: unknown): void {
  if (!ok) failures++;
  console.log(
    `${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` -> ${JSON.stringify(detail)}`}`
  );
}

const scenarios = [...FIREWORKS_TACTICS_SCENARIOS, ...FIREWORKS_MEMORY_SCENARIOS];
const scenarioIds = scenarios.map((scenario) => scenario.id);

check(
  "Fireworks corpus has 60 tactics, 40 memory, and 20 full-game cases",
  FIREWORKS_TACTICS_SCENARIOS.length === 60 &&
    FIREWORKS_MEMORY_SCENARIOS.length === 40 &&
    FIREWORKS_FULL_GAME_CASES.length === 20,
  {
    tactics: FIREWORKS_TACTICS_SCENARIOS.length,
    memory: FIREWORKS_MEMORY_SCENARIOS.length,
    full: FIREWORKS_FULL_GAME_CASES.length,
  }
);
check(
  "scenario IDs are unique",
  new Set(scenarioIds).size === scenarioIds.length,
  scenarioIds.filter((id, index) => scenarioIds.indexOf(id) !== index)
);
check(
  "every expected scenario action is legal and scores its weight",
  scenarios.every((scenario) => {
    const legal = getLegalFireworksActions(scenario.state, scenario.actingPlayerId);
    return scenario.expectedActions.every(
      (expected) =>
        legal.some((action) =>
          JSON.stringify(action) === JSON.stringify(expected.action)
        ) && scoreFireworksScenarioAction(scenario, expected.action) === expected.weight
    );
  }),
  scenarios
    .filter((scenario) => {
      const legal = getLegalFireworksActions(scenario.state, scenario.actingPlayerId);
      return !scenario.expectedActions.every(
        (expected) =>
          legal.some((action) =>
            JSON.stringify(action) === JSON.stringify(expected.action)
          ) && scoreFireworksScenarioAction(scenario, expected.action) === expected.weight
      );
    })
    .map((scenario) => scenario.id)
);
check(
  "every scenario has a weight-1 action, so a perfect candidate can score 100",
  scenarios.every((scenario) =>
    scenario.expectedActions.some((expected) => expected.weight === 1)
  ),
  scenarios
    .filter(
      (scenario) =>
        !scenario.expectedActions.some((expected) => expected.weight === 1)
    )
    .map((scenario) => scenario.id)
);
check(
  "forbidden actions score zero",
  scenarios.every((scenario) =>
    (scenario.forbiddenActions ?? []).every(
      (action) => scoreFireworksScenarioAction(scenario, action) === 0
    )
  ),
  scenarios.map((scenario) => scenario.id)
);

// --- Oracle validity: expected/forbidden actions verified against the engine.

function actingHandOf(scenario: FireworksScenario) {
  return scenario.state.hands.find(
    (hand) => hand.playerId === scenario.actingPlayerId
  )!;
}

check(
  "every expected play targets a card the engine proves playable",
  scenarios.every((scenario) =>
    scenario.expectedActions.every((expected) => {
      if (expected.action.action !== "play") return true;
      const card = actingHandOf(scenario).cards[expected.action.cardIndex];
      return card !== undefined && isPlayableCard(scenario.state, card);
    })
  ),
  scenarios
    .filter((scenario) =>
      scenario.expectedActions.some((expected) => {
        if (expected.action.action !== "play") return false;
        const card = actingHandOf(scenario).cards[expected.action.cardIndex];
        return card === undefined || !isPlayableCard(scenario.state, card);
      })
    )
    .map((scenario) => scenario.id)
);
check(
  "every expected clue touches at least one LIVE playable card in the target hand",
  scenarios.every((scenario) =>
    scenario.expectedActions.every((expected) => {
      const action = expected.action;
      if (action.action !== "clue_color" && action.action !== "clue_rank") {
        return true;
      }
      const target = scenario.state.hands.find(
        (hand) => hand.playerId === action.targetPlayerId
      );
      return (target?.cards ?? []).some(
        (card) =>
          (action.action === "clue_color"
            ? card.color === action.color
            : card.rank === action.rank) && isPlayableCard(scenario.state, card)
      );
    })
  ),
  scenarios
    .filter((scenario) =>
      scenario.expectedActions.some((expected) => {
        const action = expected.action;
        if (action.action !== "clue_color" && action.action !== "clue_rank") {
          return false;
        }
        const target = scenario.state.hands.find(
          (hand) => hand.playerId === action.targetPlayerId
        );
        return !(target?.cards ?? []).some(
          (card) =>
            (action.action === "clue_color"
              ? card.color === action.color
              : card.rank === action.rank) && isPlayableCard(scenario.state, card)
        );
      })
    )
    .map((scenario) => scenario.id)
);
check(
  "every expected discard targets a dead, non-critical card",
  scenarios.every((scenario) =>
    scenario.expectedActions.every((expected) => {
      if (expected.action.action !== "discard") return true;
      const card = actingHandOf(scenario).cards[expected.action.cardIndex];
      return (
        card !== undefined &&
        scenario.state.stacks[card.color] >= card.rank &&
        !isCriticalCard(scenario.state, card)
      );
    })
  )
);
check(
  "every forbidden action is engine-provably harmful (misplay, critical or playable discard)",
  scenarios.every((scenario) =>
    (scenario.forbiddenActions ?? []).every((action) => {
      const hand = actingHandOf(scenario);
      if (action.action === "play") {
        const card = hand.cards[action.cardIndex];
        return card !== undefined && !isPlayableCard(scenario.state, card);
      }
      if (action.action === "discard") {
        const card = hand.cards[action.cardIndex];
        return (
          card !== undefined &&
          (isCriticalCard(scenario.state, card) ||
            isPlayableCard(scenario.state, card))
        );
      }
      return true;
    })
  )
);

// --- Engine-derived harm scoring: strictly-bad moves must not get the 0.3 floor.

check(
  "unlisted misplays and critical discards score 0, not the legal floor",
  scenarios.every((scenario) => {
    const hand = actingHandOf(scenario);
    return hand.cards.every((card, index) => {
      const play: FireworksAction = { action: "play", cardIndex: index };
      const discard: FireworksAction = { action: "discard", cardIndex: index };
      const playOk =
        isPlayableCard(scenario.state, card) ||
        scoreFireworksScenarioAction(scenario, play) === 0;
      const discardOk =
        !isCriticalCard(scenario.state, card) ||
        scoreFireworksScenarioAction(scenario, discard) === 0;
      return playOk && discardOk;
    });
  })
);

// --- Positional-baseline guard: "always play cardIndex 0" must fail.

function baselineScore(pack: FireworksScenario[]): number {
  const scores = pack.map((scenario) =>
    scoreFireworksScenarioAction(scenario, { action: "play", cardIndex: 0 })
  );
  return scores.reduce((sum, value) => sum + value, 0) / scores.length;
}

const tacticsBaseline = baselineScore(FIREWORKS_TACTICS_SCENARIOS);
const memoryBaseline = baselineScore(FIREWORKS_MEMORY_SCENARIOS);
check(
  "an 'always play cardIndex 0' baseline scores far below passing on both packs",
  tacticsBaseline < 0.3 && memoryBaseline < 0.3,
  { tacticsBaseline, memoryBaseline }
);
check(
  "the play-0 baseline fails the >=0.7 case assertion on at least 70% of scenarios",
  (() => {
    const failing = scenarios.filter(
      (scenario) =>
        scoreFireworksScenarioAction(scenario, { action: "play", cardIndex: 0 }) < 0.7
    );
    return failing.length >= Math.ceil(scenarios.length * 0.7);
  })(),
  scenarios.length
);

function primaryDecisionSlots(pack: FireworksScenario[]): number[] {
  return pack
    .flatMap((scenario) =>
      scenario.expectedActions
        .filter(
          (expected) =>
            expected.weight === 1 &&
            (expected.action.action === "play" ||
              expected.action.action === "discard")
        )
        .map((expected) =>
          expected.action.action === "play" || expected.action.action === "discard"
            ? expected.action.cardIndex
            : -1
        )
    )
    .filter((slot) => slot >= 0);
}

const categories = new Set(scenarios.map((scenario) => scenario.category));
check(
  "no category pins every decision to hand slot 0 (slot varies within packs)",
  [...categories].every((category) => {
    const pack = scenarios.filter((scenario) => scenario.category === category);
    const slots = primaryDecisionSlots(pack);
    if (slots.length === 0) return true;
    return new Set(slots).size >= 3;
  }),
  [...categories].map((category) => ({
    category,
    slots: [
      ...new Set(
        primaryDecisionSlots(
          scenarios.filter((scenario) => scenario.category === category)
        )
      ),
    ],
  }))
);
check(
  "acting player varies across each category (P2-acting scenarios exist)",
  [...categories].every((category) => {
    const actors = new Set(
      scenarios
        .filter((scenario) => scenario.category === category)
        .map((scenario) => scenario.actingPlayerId)
    );
    return actors.has("P1") && actors.has("P2");
  })
);

// --- De-templating: each category must contain genuinely distinct decisions.

function decisionKey(scenario: FireworksScenario): string {
  return JSON.stringify({
    stacks: scenario.state.stacks,
    clueTokens: scenario.state.clueTokens,
    actor: scenario.actingPlayerId,
    hands: scenario.state.hands.map((hand) => ({
      cards: hand.cards.map((card) => `${card.color}-${card.rank}`),
      knowledge: hand.knowledge,
    })),
    expected: scenario.expectedActions.map((expected) => ({
      action: expected.action,
      weight: expected.weight,
    })),
  });
}

check(
  "all 10 scenarios per category are pairwise-distinct decisions (no re-skinning)",
  [...categories].every((category) => {
    const pack = scenarios.filter((scenario) => scenario.category === category);
    return new Set(pack.map(decisionKey)).size === pack.length;
  }),
  [...categories].map((category) => ({
    category,
    distinct: new Set(
      scenarios
        .filter((scenario) => scenario.category === category)
        .map(decisionKey)
    ).size,
  }))
);

// --- Leak guard: category names / card roles / identities must not reach the
// model-facing view (the exact view both benchmark runners serialize).

const BANNED_VIEW_TOKENS = [
  "safe_play",
  "needed_clue",
  "avoid_bad_play",
  "safe_discard",
  "critical_discard_avoidance",
  "endgame_play",
  "combine_color_and_rank",
  "old_clue_recall",
  "negative_information",
  "timing_inference",
  "own-",
  "partner-",
  "trap",
  "critical",
  "endgame",
  // Old descriptive seeds/card ids ("fireworks-memory-...", "memory-card").
  // The engine event field `memoryConsistent` is schema, not a leak, so plain
  // "memory" is not banned.
  "fireworks-memory",
  "fireworks-tactics",
  "memory-card",
  "recall",
  "tactics-",
];

function viewJsonFor(scenario: FireworksScenario): string {
  return JSON.stringify(
    getFireworksPlayerView(scenario.state, scenario.actingPlayerId, {
      omitRecommendations: true,
      redactOwnIdentity: scenario.suite === "fireworks-memory-v0.1",
    })
  );
}

check(
  "model-facing views contain no category names or card-role labels",
  scenarios.every((scenario) => {
    const text = viewJsonFor(scenario).toLowerCase();
    return BANNED_VIEW_TOKENS.every((token) => !text.includes(token));
  }),
  scenarios
    .filter((scenario) => {
      const text = viewJsonFor(scenario).toLowerCase();
      return BANNED_VIEW_TOKENS.some((token) => text.includes(token));
    })
    .map((scenario) => scenario.id)
);

check(
  "negative_information views never state the true color or rank positively",
  FIREWORKS_MEMORY_SCENARIOS.filter(
    (scenario) => scenario.category === "negative_information"
  ).every((scenario) => {
    const hand = actingHandOf(scenario);
    const decisionSlot = scenario.expectedActions[0].action;
    const slot =
      decisionSlot.action === "play" || decisionSlot.action === "discard"
        ? decisionSlot.cardIndex
        : 0;
    const trueCard = hand.cards[slot];
    const events = scenario.state.events.filter(
      (event) =>
        (event.action.action === "clue_color" ||
          event.action.action === "clue_rank") &&
        event.action.targetPlayerId === scenario.actingPlayerId
    );
    const positiveColor = events.some(
      (event) =>
        event.action.action === "clue_color" && event.action.color === trueCard.color
    );
    const positiveRank = events.some(
      (event) =>
        event.action.action === "clue_rank" && event.action.rank === trueCard.rank
    );
    const decisionKnowledge = hand.knowledge[slot];
    return (
      !positiveColor &&
      !positiveRank &&
      decisionKnowledge.clueHistory.length === 0 &&
      decisionKnowledge.notColors.length === 2 &&
      decisionKnowledge.notRanks.length === 4
    );
  })
);

check(
  "timing_inference views never reveal the color channel",
  FIREWORKS_MEMORY_SCENARIOS.filter(
    (scenario) => scenario.category === "timing_inference"
  ).every((scenario) =>
    scenario.state.events.every(
      (event) =>
        !(
          event.action.action === "clue_color" &&
          event.action.targetPlayerId === scenario.actingPlayerId
        )
    )
  )
);

check(
  "memory scenarios include dead-card variants where the right answer is NOT play",
  MEMORY_HAS_DISCARD_VARIANTS(),
  FIREWORKS_MEMORY_SCENARIOS.map((scenario) => scenario.expectedActions[0].action)
);

function MEMORY_HAS_DISCARD_VARIANTS(): boolean {
  const byCategory = new Map<string, Set<string>>();
  for (const scenario of FIREWORKS_MEMORY_SCENARIOS) {
    const set = byCategory.get(scenario.category) ?? new Set<string>();
    set.add(scenario.expectedActions[0].action.action);
    byCategory.set(scenario.category, set);
  }
  return [...byCategory.values()].every(
    (set) => set.has("play") && set.has("discard")
  );
}

// --- Runtime slices, digests, and budgets describe what actually runs.

const SUITES: FireworksBenchmarkSuite[] = ["tactics", "memory", "full", "mixed"];
check(
  "TeamIQ tactics slice covers all 6 categories and memory slice covers all 4",
  (() => {
    const tactics = getFireworksRuntimeCasesForSuite("tactics").filter(
      (item): item is FireworksScenario => "state" in item
    );
    const memory = getFireworksRuntimeCasesForSuite("memory").filter(
      (item): item is FireworksScenario => "state" in item
    );
    return (
      new Set(tactics.map((scenario) => scenario.category)).size === 6 &&
      new Set(memory.map((scenario) => scenario.category)).size === 4
    );
  })(),
  {
    tactics: getFireworksRuntimeCasesForSuite("tactics").length,
    memory: getFireworksRuntimeCasesForSuite("memory").length,
  }
);
check(
  "persisted case digest/caseCount match the exact runtime case list for every suite",
  SUITES.every((suite) =>
    ([2, 3] as const).every((playerCount) => {
      const cases = getFireworksRuntimeCasesForSuite(suite, playerCount);
      const record = fireworksCaseToBenchmarkCaseV2(
        `digest-test-${suite}-${playerCount}`,
        suite,
        playerCount
      );
      const context = JSON.parse(record.prompt.publicContext ?? "{}") as {
        caseCount?: number;
        digest?: string;
      };
      const expectedDigest = stableFireworksScenarioPackDigest({
        id: `fireworks-${suite}-${playerCount}p-v${record.caseVersion}`,
        scenarios: cases.filter(
          (item): item is FireworksScenario => "state" in item
        ),
        fullGames: cases.filter(
          (item): item is FireworksFullGameCase => "playerCount" in item
        ),
      });
      return context.caseCount === cases.length && context.digest === expectedDigest;
    })
  )
);
check(
  "every suite budget covers a default run (1 team + up to 3 solo baselines)",
  SUITES.every((suite) =>
    ([2, 3] as const).every((playerCount) => {
      const cases = getFireworksRuntimeCasesForSuite(suite, playerCount);
      const record = fireworksCaseToBenchmarkCaseV2(
        `budget-test-${suite}-${playerCount}`,
        suite,
        playerCount
      );
      const needed = estimateFireworksModelCallsPerComposition(cases) * 4;
      return (record.budget.maxModelCalls ?? 0) >= needed;
    })
  ),
  SUITES.map((suite) => ({
    suite,
    budget: fireworksCaseToBenchmarkCaseV2(`b-${suite}`, suite, 2).budget,
  }))
);
check(
  "scenario suites use verified_quality as primary (team_lift needs rotating players)",
  fireworksCaseToBenchmarkCaseV2("p-t", "tactics").scoring.primary ===
    "verified_quality" &&
    fireworksCaseToBenchmarkCaseV2("p-m", "memory").scoring.primary ===
      "verified_quality" &&
    fireworksCaseToBenchmarkCaseV2("p-f", "full").scoring.primary === "team_lift" &&
    fireworksCaseToBenchmarkCaseV2("p-x", "mixed").scoring.primary === "team_lift"
);

const firstDigest = stableFireworksScenarioPackDigest({
  id: "fireworks-combined-v0.1",
  scenarios,
  fullGames: FIREWORKS_FULL_GAME_CASES,
});
const secondDigest = stableFireworksScenarioPackDigest({
  id: "fireworks-combined-v0.1",
  scenarios,
  fullGames: FIREWORKS_FULL_GAME_CASES,
});
check(
  "scenario pack digest is stable",
  firstDigest === secondDigest && firstDigest.startsWith("fireworks-v0.1:"),
  { firstDigest, secondDigest }
);

if (failures === 0) {
  console.log("PASS");
} else {
  console.log(`FAIL ${failures} check(s) failed`);
}

process.exit(failures === 0 ? 0 : 1);
