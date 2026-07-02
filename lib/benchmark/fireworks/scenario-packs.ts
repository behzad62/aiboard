import type { BenchmarkCaseV2 } from "@/lib/benchmark/types";
import {
  createEmptyFireworksKnowledge,
  createFireworksGame,
  fireworksActionsEqual,
  getLegalFireworksActions,
  isCriticalCard,
  isPlayableCard,
} from "@/lib/games/fireworks/engine";
import type {
  FireworksAction,
  FireworksCard,
  FireworksCardKnowledge,
  FireworksColor,
  FireworksEvent,
  FireworksGameState,
  FireworksRank,
  FireworksStackState,
} from "@/lib/games/fireworks/types";
import type {
  FireworksBenchmarkCase,
  FireworksBenchmarkSuite,
  FireworksFullGameCase,
  FireworksMemoryCategory,
  FireworksScenario,
  FireworksTacticsCategory,
} from "./types";

// Bumped whenever generated scenario content changes (ids stay stable).
// 0.2.0: opaque seeds/card ids (no category or card-role leakage), varied
// decision slots and acting players, engine-verified expected actions,
// dead-card memory variants, seeded events consistent with clue knowledge,
// and engine-derived harm scoring.
export const FIREWORKS_SCENARIO_PACK_VERSION = "0.2.0";

const TACTICS_CATEGORIES: FireworksTacticsCategory[] = [
  "safe_play",
  "needed_clue",
  "avoid_bad_play",
  "safe_discard",
  "critical_discard_avoidance",
  "endgame_play",
];

const MEMORY_CATEGORIES: FireworksMemoryCategory[] = [
  "combine_color_and_rank",
  "old_clue_recall",
  "negative_information",
  "timing_inference",
];

const COLORS: FireworksColor[] = ["red", "blue", "green"];
const ALL_RANKS: FireworksRank[] = [1, 2, 3, 4, 5];

export const FIREWORKS_TACTICS_SCENARIOS: FireworksScenario[] =
  TACTICS_CATEGORIES.flatMap((category) =>
    Array.from({ length: 10 }, (_, index) =>
      createTacticsScenario(category, index + 1)
    )
  );

export const FIREWORKS_MEMORY_SCENARIOS: FireworksScenario[] =
  MEMORY_CATEGORIES.flatMap((category) =>
    Array.from({ length: 10 }, (_, index) =>
      createMemoryScenario(category, index + 1)
    )
  );

export const FIREWORKS_FULL_GAME_CASES: FireworksFullGameCase[] = [
  ...Array.from({ length: 10 }, (_, index) => createFullGameCase(2, index + 1)),
  ...Array.from({ length: 10 }, (_, index) => createFullGameCase(3, index + 1)),
];

export function getFireworksBenchmarkCasesForSuite(
  suite: FireworksBenchmarkSuite
): Array<FireworksScenario | FireworksFullGameCase> {
  if (suite === "tactics") return clone(FIREWORKS_TACTICS_SCENARIOS);
  if (suite === "memory") return clone(FIREWORKS_MEMORY_SCENARIOS);
  if (suite === "full") return clone(FIREWORKS_FULL_GAME_CASES);
  return clone([
    ...FIREWORKS_TACTICS_SCENARIOS.slice(0, 20),
    ...FIREWORKS_MEMORY_SCENARIOS.slice(0, 10),
    ...FIREWORKS_FULL_GAME_CASES.slice(0, 5),
  ]);
}

/**
 * The exact case list a certified TeamIQ run executes for a suite. The
 * persisted case record's digest, case count, and budget are derived from
 * THIS list (not the full authoring corpus), so provenance describes what
 * actually runs.
 *
 * Scenario slices are stratified across every category (scenario numbers
 * 06-08, or 06-07 for the mixed suite) so all six tactics categories and all
 * four memory categories are exercised, and so the TeamIQ slices stay
 * disjoint from the GameIQ basic pack (which uses safe_play/needed_clue
 * 01-05 and combine 01-10... combine overlap is limited to numbers 06-08).
 */
export function getFireworksRuntimeCasesForSuite(
  suite: FireworksBenchmarkSuite,
  playerCount: 2 | 3 = 2
): FireworksBenchmarkCase[] {
  if (suite === "tactics") return clone(pickTacticsNumbers([6, 7, 8]));
  if (suite === "memory") return clone(pickMemoryNumbers([6, 7, 8]));
  if (suite === "full") return clone(fullGamesForPlayerCount(playerCount));
  return clone([
    ...pickTacticsNumbers([6, 7]),
    ...pickMemoryNumbers([6, 7]),
    ...fullGamesForPlayerCount(playerCount).slice(0, 3),
  ]);
}

/**
 * Worst-case model calls one team composition needs to finish these cases:
 * one call per scenario decision, up to maxTurns calls per full game.
 */
export function estimateFireworksModelCallsPerComposition(
  cases: FireworksBenchmarkCase[]
): number {
  return cases.reduce(
    (sum, benchmarkCase) =>
      sum + ("maxTurns" in benchmarkCase ? benchmarkCase.maxTurns : 1),
    0
  );
}

export function scoreFireworksScenarioAction(
  scenario: FireworksScenario,
  action: FireworksAction
): number {
  if (
    (scenario.forbiddenActions ?? []).some((forbidden) =>
      fireworksActionsEqual(forbidden, action)
    )
  ) {
    return 0;
  }
  const expected = scenario.expectedActions.find((candidate) =>
    fireworksActionsEqual(candidate.action, action)
  );
  if (expected) return expected.weight;
  const legal = getLegalFireworksActions(
    scenario.state,
    scenario.actingPlayerId
  ).some((candidate) => fireworksActionsEqual(candidate, action));
  if (!legal) return 0;
  // Engine-provable harm never earns the neutral legal-action floor: a play
  // that misfires burns a mistake token and a discard of a critical card
  // destroys the last copy, so both score 0 even when not enumerated as
  // forbidden. Clues that touch only dead cards waste a token for almost no
  // information and score below neutral alternatives.
  const actingHand = scenario.state.hands.find(
    (hand) => hand.playerId === scenario.actingPlayerId
  );
  if (action.action === "play") {
    const card = actingHand?.cards[action.cardIndex];
    if (card && !isPlayableCard(scenario.state, card)) return 0;
  }
  if (action.action === "discard") {
    const card = actingHand?.cards[action.cardIndex];
    if (card && isCriticalCard(scenario.state, card)) return 0;
  }
  if (action.action === "clue_color" || action.action === "clue_rank") {
    const targetHand = scenario.state.hands.find(
      (hand) => hand.playerId === action.targetPlayerId
    );
    const touched = (targetHand?.cards ?? []).filter((card) =>
      action.action === "clue_color"
        ? card.color === action.color
        : card.rank === action.rank
    );
    if (
      touched.length > 0 &&
      touched.every((card) => scenario.state.stacks[card.color] >= card.rank)
    ) {
      return 0.1;
    }
  }
  return 0.3;
}

export function stableFireworksScenarioPackDigest(input: {
  id: string;
  scenarios: FireworksScenario[];
  fullGames: FireworksFullGameCase[];
}): string {
  return `fireworks-v0.1:${hashString(stableStringify(input))}`;
}

export function fireworksCaseToBenchmarkCaseV2(
  id: string,
  suite: FireworksBenchmarkSuite = "mixed",
  playerCount: 2 | 3 = 2
): BenchmarkCaseV2 {
  const timestamp = new Date().toISOString();
  const cases = getFireworksRuntimeCasesForSuite(suite, playerCount);
  const callsPerComposition = estimateFireworksModelCallsPerComposition(cases);
  // Budget must let a default run finish: worst case is one selected team
  // plus up to three auto-derived solo baselines all playing every case.
  const maxModelCalls = Math.max(200, callsPerComposition * 4);
  return {
    id,
    schemaVersion: 2,
    track: "teamiq",
    title: labelForSuite(suite),
    description:
      suite === "tactics" || suite === "memory"
        ? "Fireworks single-decision scenario probes with hidden information and objective engine scoring."
        : "Fireworks tests whether model teams can cooperate when no player sees their own cards.",
    difficulty: suite === "full" || suite === "mixed" ? "hard" : "medium",
    tags: ["teamiq", "fireworks", suite],
    caseVersion: FIREWORKS_SCENARIO_PACK_VERSION,
    createdAt: timestamp,
    updatedAt: timestamp,
    prompt: {
      userRequest:
        "Run Fireworks TeamIQ with hidden information, limited legal clues, memory pressure, and objective scoring.",
      publicContext: JSON.stringify({
        suite,
        playerCount,
        caseCount: cases.length,
        deckEmptyRule:
          "In AI Board Fireworks, when the deck is empty, play continues until hands are empty or the benchmark maxTurns limit is reached.",
        digest: stableFireworksScenarioPackDigest({
          id: `fireworks-${suite}-${playerCount}p-v${FIREWORKS_SCENARIO_PACK_VERSION}`,
          scenarios: cases.filter(isScenario),
          fullGames: cases.filter(isFullGame),
        }),
      }),
    },
    environment: { type: "browser", timeoutSeconds: 120, network: "none" },
    verifier: { scorer: "game-engine" },
    budget: { maxUsd: 5, maxModelCalls },
    scoring: {
      scoringVersion: "fireworks-teamiq-v0.1",
      // Scenario suites are single-decision probes (one acting player per
      // case); team lift is only meaningful where full games rotate players.
      primary:
        suite === "full" || suite === "mixed" ? "team_lift" : "verified_quality",
    },
    contamination: {
      originalTask: true,
      canary: "AIBENCH-FIREWORKS-TEAMIQ-V0-1",
      referenceSolutionPrivate: true,
    },
  };
}

function createTacticsScenario(
  category: FireworksTacticsCategory,
  number: number
): FireworksScenario {
  // Opaque seed: the seed and game id reach the model-facing player view, so
  // they must not encode the category (that leaked the expected action type).
  const seed = opaqueSeed("tactics", category, number);
  const actorId = number % 2 === 1 ? "P1" : "P2";
  const partnerId = actorId === "P1" ? "P2" : "P1";
  const slot = (number - 1) % 4;
  const partnerSlot = number % 4;
  const color = COLORS[(number - 1) % COLORS.length];
  const [alt1, alt2] = COLORS.filter((candidate) => candidate !== color);
  const stacks: FireworksStackState = { red: 0, blue: 0, green: 0 };
  const actorCards: Array<FireworksCard | null> = [null, null, null, null];
  const actorKnowledge: FireworksCardKnowledge[] = emptyKnowledgeRow();
  const partnerCards: Array<FireworksCard | null> = [null, null, null, null];
  const events: FireworksEvent[] = [];
  let partnerAvoidColors: FireworksColor[] = [];
  let partnerAvoidRanks: FireworksRank[] = [];
  let clueTokens = 6;
  let expectedActions: FireworksScenario["expectedActions"] = [];
  let forbiddenActions: FireworksAction[] | undefined;
  let title = "";

  if (category === "safe_play") {
    const rank = (((number - 1) % 4) + 1) as FireworksRank;
    stacks[color] = rank - 1;
    stacks[alt1] = number % 3;
    stacks[alt2] = (number + 1) % 3;
    clueTokens = [6, 2, 0][(number - 1) % 3];
    actorCards[slot] = card(seed, `a${slot}`, color, rank);
    events.push(
      seededClueEvent(seed, 1, partnerId, {
        action: "clue_color",
        targetPlayerId: actorId,
        color,
      }),
      seededClueEvent(seed, 2, partnerId, {
        action: "clue_rank",
        targetPlayerId: actorId,
        rank,
      })
    );
    expectedActions = [
      {
        action: { action: "play", cardIndex: slot },
        weight: 1,
        label: "Play the card proven playable by clues",
      },
    ];
    title = "Play a card proven playable by clues";
  } else if (category === "needed_clue") {
    const partnerRank = (((number - 1) % 2) + 1) as FireworksRank;
    stacks[color] = partnerRank - 1;
    stacks[alt1] = (number + 1) % 3;
    stacks[alt2] = number % 2;
    clueTokens = ((number - 1) % 3) + 1;
    partnerCards[partnerSlot] = card(seed, `b${partnerSlot}`, color, partnerRank);
    partnerAvoidColors = [color];
    partnerAvoidRanks = [partnerRank];
    expectedActions = [
      {
        action: {
          action: "clue_rank",
          targetPlayerId: partnerId,
          rank: partnerRank,
        },
        weight: 1,
        label: "Tell partner about the playable rank",
      },
      {
        action: { action: "clue_color", targetPlayerId: partnerId, color },
        weight: 0.8,
        label: "Tell partner about the playable color",
      },
    ];
    title = "Give the clue that unlocks a partner play";
  } else if (category === "avoid_bad_play") {
    const stackHeight = (number - 1) % 3;
    const trapRank = (stackHeight + 2) as FireworksRank;
    stacks[color] = stackHeight;
    const partnerColor = alt1;
    const partnerStack = number % 2;
    stacks[partnerColor] = partnerStack;
    const partnerRank = (partnerStack + 1) as FireworksRank;
    stacks[alt2] = (number + 1) % 3;
    clueTokens = ((number - 1) % 2) + 1;
    // Trap card stays unknown: playing it would burn a mistake token.
    actorCards[slot] = card(seed, `a${slot}`, color, trapRank);
    partnerCards[partnerSlot] = card(
      seed,
      `b${partnerSlot}`,
      partnerColor,
      partnerRank
    );
    partnerAvoidColors = [partnerColor];
    partnerAvoidRanks = [partnerRank];
    expectedActions = [
      {
        action: {
          action: "clue_rank",
          targetPlayerId: partnerId,
          rank: partnerRank,
        },
        weight: 1,
        label: "Clue the partner's playable card instead of guessing",
      },
      {
        action: {
          action: "clue_color",
          targetPlayerId: partnerId,
          color: partnerColor,
        },
        weight: 0.8,
        label: "Color clue that also identifies the playable card",
      },
    ];
    forbiddenActions = [{ action: "play", cardIndex: slot }];
    title = "Avoid playing an unknown non-playable card";
  } else if (category === "safe_discard") {
    const rank = (((number - 1) % 2) + 1) as FireworksRank;
    stacks[color] = rank;
    stacks[alt1] = number % 2;
    stacks[alt2] = (number + 1) % 3;
    actorCards[slot] = card(seed, `a${slot}`, color, rank);
    events.push(
      seededClueEvent(seed, 1, partnerId, {
        action: "clue_color",
        targetPlayerId: actorId,
        color,
      }),
      seededClueEvent(seed, 3, partnerId, {
        action: "clue_rank",
        targetPlayerId: actorId,
        rank,
      })
    );
    expectedActions = [
      {
        action: { action: "discard", cardIndex: slot },
        weight: 1,
        label: "Discard the already-played card",
      },
    ];
    if (number % 2 === 0) {
      // Token available: a useful clue on the partner's playable card is an
      // acceptable alternative, not a failure.
      clueTokens = 2;
      const partnerColor = alt1;
      const partnerRank = (stacks[partnerColor] + 1) as FireworksRank;
      partnerCards[partnerSlot] = card(
        seed,
        `b${partnerSlot}`,
        partnerColor,
        partnerRank
      );
      partnerAvoidColors = [partnerColor];
      partnerAvoidRanks = [partnerRank];
      expectedActions.push({
        action: {
          action: "clue_rank",
          targetPlayerId: partnerId,
          rank: partnerRank,
        },
        weight: 0.8,
        label: "Useful clue instead of the free discard",
      });
    } else {
      clueTokens = 0;
    }
    forbiddenActions = [{ action: "play", cardIndex: slot }];
    title = "Discard a card known to be no longer needed";
  } else if (category === "critical_discard_avoidance") {
    stacks[color] = (number - 1) % 3;
    const partnerColor = alt2;
    const partnerStack = number % 2;
    stacks[partnerColor] = partnerStack;
    const partnerRank = (partnerStack + 1) as FireworksRank;
    stacks[alt1] = (number + 1) % 3;
    clueTokens = [1, 3, 5][(number - 1) % 3];
    actorCards[slot] = card(seed, `a${slot}`, color, 5);
    events.push(
      seededClueEvent(seed, 2, partnerId, {
        action: "clue_color",
        targetPlayerId: actorId,
        color,
      })
    );
    const cluePartnerSlot = (number + 1) % 4;
    partnerCards[cluePartnerSlot] = card(
      seed,
      `b${cluePartnerSlot}`,
      partnerColor,
      partnerRank
    );
    partnerAvoidColors = [partnerColor];
    partnerAvoidRanks = [partnerRank];
    expectedActions = [
      {
        action: {
          action: "clue_rank",
          targetPlayerId: partnerId,
          rank: partnerRank,
        },
        weight: 1,
        label: "Use a useful clue instead of discarding a unique 5",
      },
      {
        action: {
          action: "clue_color",
          targetPlayerId: partnerId,
          color: partnerColor,
        },
        weight: 0.9,
        label: "Equally informative color clue",
      },
    ];
    forbiddenActions = [
      { action: "discard", cardIndex: slot },
      { action: "play", cardIndex: slot },
    ];
    title = "Avoid discarding a critical card";
  } else {
    stacks[color] = 4;
    stacks[alt1] = 3 + (number % 2);
    stacks[alt2] = ((number + 1) % 3) + 2;
    clueTokens = (number % 3) * 2;
    actorCards[slot] = card(seed, `a${slot}`, color, 5);
    events.push(
      seededClueEvent(seed, 4, partnerId, {
        action: "clue_color",
        targetPlayerId: actorId,
        color,
      }),
      seededClueEvent(seed, 6, partnerId, {
        action: "clue_rank",
        targetPlayerId: actorId,
        rank: 5,
      })
    );
    expectedActions = [
      {
        action: { action: "play", cardIndex: slot },
        weight: 1,
        label: "Finish a stack",
      },
    ];
    if (number % 2 === 0) {
      // Two proven-playable cards: either play is fine this turn.
      const secondSlot = (slot + 2) % 4;
      const secondRank = (stacks[alt1] + 1) as FireworksRank;
      actorCards[secondSlot] = card(seed, `a${secondSlot}`, alt1, secondRank);
      events.push(
        seededClueEvent(seed, 5, partnerId, {
          action: "clue_color",
          targetPlayerId: actorId,
          color: alt1,
        }),
        seededClueEvent(seed, 7, partnerId, {
          action: "clue_rank",
          targetPlayerId: actorId,
          rank: secondRank,
        })
      );
      expectedActions.push({
        action: { action: "play", cardIndex: secondSlot },
        weight: 0.95,
        label: "Equally proven playable card",
      });
    }
    title = "Finish a stack in the endgame";
  }

  fillHand({
    seed,
    prefix: "a",
    cards: actorCards,
    stacks,
    rotate: number,
  });
  fillHand({
    seed,
    prefix: "b",
    cards: partnerCards,
    stacks,
    avoidColors: partnerAvoidColors,
    avoidRanks: partnerAvoidRanks,
    rotate: number + 1,
  });

  const state = createPuzzleState(seed, {
    actorId,
    stacks,
    clueTokens,
    actorCards: actorCards as FireworksCard[],
    actorKnowledge,
    partnerCards: partnerCards as FireworksCard[],
    events,
  });
  applySeededClueConsistency(state);

  return {
    id: `fireworks-tactics-v0.1-${category}-${String(number).padStart(2, "0")}`,
    suite: "fireworks-tactics-v0.1",
    category,
    title: `${title} #${number}`,
    seed,
    state,
    actingPlayerId: actorId,
    expectedActions,
    forbiddenActions,
    tags: ["fireworks", "tactics", category],
  };
}

function createMemoryScenario(
  category: FireworksMemoryCategory,
  number: number
): FireworksScenario {
  const seed = opaqueSeed("memory", category, number);
  const actorId = number % 2 === 1 ? "P1" : "P2";
  const partnerId = actorId === "P1" ? "P2" : "P1";
  const slot = (number - 1) % 4;
  const color = COLORS[(number - 1) % COLORS.length];
  const [alt1, alt2] = COLORS.filter((candidate) => candidate !== color);
  // Every third scenario the recalled identity proves the card is DEAD, so a
  // "just play the remembered card" heuristic demonstrably fails: the correct
  // action flips to discard.
  const dead = number % 3 === 0;
  const stacks: FireworksStackState = { red: 0, blue: 0, green: 0 };
  const actorCards: Array<FireworksCard | null> = [null, null, null, null];
  const actorKnowledge: FireworksCardKnowledge[] = emptyKnowledgeRow();
  const partnerCards: Array<FireworksCard | null> = [null, null, null, null];
  const events: FireworksEvent[] = [];
  let avoidRanks: FireworksRank[] = [];
  let avoidColors: FireworksColor[] = [];
  let title = "";
  let rank: FireworksRank;
  let postBuild: ((state: FireworksGameState) => void) | undefined;

  if (category === "combine_color_and_rank") {
    rank = (((number - 1) % 4) + 1) as FireworksRank;
    stacks[color] = dead ? rank : rank - 1;
    stacks[alt1] = number % 3;
    stacks[alt2] = (number + 1) % 2;
    actorCards[slot] = card(seed, `a${slot}`, color, rank);
    avoidColors = [color];
    avoidRanks = [rank];
    events.push(
      seededClueEvent(seed, 1, partnerId, {
        action: "clue_color",
        targetPlayerId: actorId,
        color,
      }),
      seededClueEvent(seed, 3, partnerId, {
        action: "clue_rank",
        targetPlayerId: actorId,
        rank,
      })
    );
    title = "Combine color and rank clues";
  } else if (category === "old_clue_recall") {
    rank = (((number - 1) % 3) + 1) as FireworksRank;
    stacks[color] = dead ? rank : rank - 1;
    stacks[alt1] = number % 3;
    stacks[alt2] = (number + 1) % 2;
    actorCards[slot] = card(seed, `a${slot}`, color, rank);
    // Distractor: a LATER rank clue on a different slot. Confusing the old
    // clue with the recent one means misplaying a non-playable card.
    const distractorSlot = (slot + 1) % 4;
    actorCards[distractorSlot] = card(seed, `a${distractorSlot}`, alt1, 4);
    avoidColors = [color];
    avoidRanks = [rank, 4];
    events.push(
      seededClueEvent(seed, 1, partnerId, {
        action: "clue_color",
        targetPlayerId: actorId,
        color,
      }),
      seededClueEvent(seed, 2, partnerId, {
        action: "clue_rank",
        targetPlayerId: actorId,
        rank,
      }),
      seededClueEvent(seed, 5, partnerId, {
        action: "clue_rank",
        targetPlayerId: actorId,
        rank: 4,
      })
    );
    title = "Remember an old clue among newer ones";
  } else if (category === "negative_information") {
    rank = (((number - 1) % 4) + 1) as FireworksRank;
    stacks[color] = dead ? rank : rank - 1;
    stacks[alt1] = number % 2;
    stacks[alt2] = (number + 1) % 3;
    // No positive clue ever touched the decision card: its identity is
    // determined only by elimination (notColors/notRanks).
    actorCards[slot] = card(seed, `a${slot}`, color, rank);
    const excluded = ALL_RANKS.filter((candidate) => candidate !== rank);
    const fillerRankA = pickRank(excluded, [(stacks[alt1] + 1) as FireworksRank]);
    const fillerRankB = pickRank(excluded, [
      (stacks[alt2] + 1) as FireworksRank,
      fillerRankA,
    ]);
    const fillerRankC = pickRank(excluded, [
      (stacks[alt1] + 1) as FireworksRank,
      fillerRankA,
      fillerRankB,
    ]);
    const remainingRank = excluded.find(
      (candidate) =>
        candidate !== fillerRankA &&
        candidate !== fillerRankB &&
        candidate !== fillerRankC
    );
    const slotA = (slot + 1) % 4;
    const slotB = (slot + 2) % 4;
    const slotC = (slot + 3) % 4;
    actorCards[slotA] = card(seed, `a${slotA}`, alt1, fillerRankA);
    actorCards[slotB] = card(seed, `a${slotB}`, alt2, fillerRankB);
    actorCards[slotC] = card(seed, `a${slotC}`, alt1, fillerRankC);
    events.push(
      seededClueEvent(seed, 1, partnerId, {
        action: "clue_color",
        targetPlayerId: actorId,
        color: alt1,
      }),
      seededClueEvent(seed, 2, partnerId, {
        action: "clue_rank",
        targetPlayerId: actorId,
        rank: fillerRankA,
      }),
      seededClueEvent(seed, 3, partnerId, {
        action: "clue_color",
        targetPlayerId: actorId,
        color: alt2,
      }),
      seededClueEvent(seed, 4, partnerId, {
        action: "clue_rank",
        targetPlayerId: actorId,
        rank: fillerRankB,
      }),
      seededClueEvent(seed, 6, partnerId, {
        action: "clue_rank",
        targetPlayerId: actorId,
        rank: fillerRankC,
      })
    );
    // The one rank the seeded clues cannot justify is recorded as prior
    // knowledge so the identity is uniquely determined by elimination.
    postBuild = (state) => {
      const hand = state.hands.find((candidate) => candidate.playerId === actorId);
      const decision = hand?.knowledge[slot];
      if (decision && remainingRank && !decision.notRanks.includes(remainingRank)) {
        decision.notRanks.push(remainingRank);
      }
    };
    title = "Deduce identity from negative information";
  } else {
    rank = (((number - 1) % 4) + 1) as FireworksRank;
    // Rank known, color unknown: playability must be inferred from the rank
    // plus the stack heights (all stacks equal, so the inference is provable).
    const height = dead ? rank : rank - 1;
    stacks.red = height;
    stacks.blue = height;
    stacks.green = height;
    actorCards[slot] = card(seed, `a${slot}`, color, rank);
    avoidRanks = [rank];
    events.push(
      seededClueEvent(seed, 2 + (number % 3), partnerId, {
        action: "clue_rank",
        targetPlayerId: actorId,
        rank,
      })
    );
    title = "Infer playability from a rank clue and the stacks";
  }

  fillHand({
    seed,
    prefix: "a",
    cards: actorCards,
    stacks,
    avoidColors,
    avoidRanks,
    rotate: number,
  });
  fillHand({
    seed,
    prefix: "b",
    cards: partnerCards,
    stacks,
    rotate: number + 2,
  });

  const state = createPuzzleState(seed, {
    actorId,
    stacks,
    clueTokens: 4,
    actorCards: actorCards as FireworksCard[],
    actorKnowledge,
    partnerCards: partnerCards as FireworksCard[],
    events,
  });
  applySeededClueConsistency(state);
  postBuild?.(state);

  return {
    id: `fireworks-memory-v0.1-${category}-${String(number).padStart(2, "0")}`,
    suite: "fireworks-memory-v0.1",
    category,
    title: `${title} #${number}`,
    seed,
    state,
    actingPlayerId: actorId,
    expectedActions: [
      dead
        ? {
            action: { action: "discard", cardIndex: slot },
            weight: 1,
            label: "Recalled clues prove the card is already played",
          }
        : {
            action: { action: "play", cardIndex: slot },
            weight: 1,
            label: "Recalled clues prove the card is playable",
          },
    ],
    forbiddenActions: [
      dead
        ? { action: "play", cardIndex: slot }
        : { action: "discard", cardIndex: slot },
    ],
    tags: ["fireworks", "memory", category],
  };
}

function createFullGameCase(
  playerCount: 2 | 3,
  number: number
): FireworksFullGameCase {
  return {
    id: `fireworks-full-v0.1-${playerCount}p-${String(number).padStart(2, "0")}`,
    suite: "fireworks-full-v0.1",
    playerCount,
    seed: `fireworks-full-${playerCount}p-${number}`,
    maxTurns: playerCount === 2 ? 60 : 75,
    maxScore: 15,
    clueTokens: 6,
    mistakeTokens: 3,
  };
}

function createPuzzleState(
  seed: string,
  input: {
    actorId: "P1" | "P2";
    stacks: FireworksStackState;
    clueTokens: number;
    actorCards: FireworksCard[];
    actorKnowledge: FireworksCardKnowledge[];
    partnerCards: FireworksCard[];
    events?: FireworksEvent[];
  }
): FireworksGameState {
  const state = createFireworksGame({
    seed,
    players: [
      { id: "P1", label: "Player 1", kind: "ai" },
      { id: "P2", label: "Player 2", kind: "ai" },
    ],
  });
  const actorIndex = input.actorId === "P1" ? 0 : 1;
  const events = input.events ?? [];
  state.deck = [];
  state.currentPlayerIndex = actorIndex;
  state.turn = events.reduce((max, event) => Math.max(max, event.turn), -1) + 1;
  state.status = "playing";
  state.stacks = { ...input.stacks };
  state.clueTokens = input.clueTokens;
  state.mistakeTokens = 3;
  state.events = events;
  const actorHand = {
    playerId: input.actorId,
    cards: input.actorCards,
    knowledge: input.actorKnowledge,
  };
  const partnerHand = {
    playerId: input.actorId === "P1" ? "P2" : "P1",
    cards: input.partnerCards,
    knowledge: emptyKnowledgeRow(),
  };
  state.hands =
    actorIndex === 0 ? [actorHand, partnerHand] : [partnerHand, actorHand];
  return state;
}

/**
 * Derives clue knowledge from the seeded clue events exactly the way the
 * engine would have (positive marks on touched cards, negative marks on the
 * rest), so the authored state cannot contradict its own history and cannot
 * leak identity through a channel the clues do not justify.
 */
function applySeededClueConsistency(state: FireworksGameState): void {
  for (const event of state.events) {
    const action = event.action;
    if (action.action !== "clue_color" && action.action !== "clue_rank") continue;
    const hand = state.hands.find(
      (candidate) => candidate.playerId === action.targetPlayerId
    );
    if (!hand) continue;
    hand.cards.forEach((cardValue, index) => {
      const know = hand.knowledge[index];
      if (!know) return;
      if (action.action === "clue_color") {
        if (cardValue.color === action.color) {
          if (know.color !== action.color) {
            know.color = action.color;
            know.clueHistory.push(`Turn ${event.turn}: ${action.color}`);
          }
        } else if (!know.notColors.includes(action.color)) {
          know.notColors.push(action.color);
        }
      } else if (cardValue.rank === action.rank) {
        if (know.rank !== action.rank) {
          know.rank = action.rank;
          know.clueHistory.push(`Turn ${event.turn}: rank ${action.rank}`);
        }
      } else if (!know.notRanks.includes(action.rank)) {
        know.notRanks.push(action.rank);
      }
    });
  }
}

function fillHand(input: {
  seed: string;
  prefix: string;
  cards: Array<FireworksCard | null>;
  stacks: FireworksStackState;
  avoidColors?: FireworksColor[];
  avoidRanks?: FireworksRank[];
  rotate: number;
}): void {
  const colorPool = COLORS.filter(
    (candidate) => !(input.avoidColors ?? []).includes(candidate)
  );
  for (let index = 0; index < input.cards.length; index++) {
    if (input.cards[index]) continue;
    const color = colorPool[(input.rotate + index) % colorPool.length];
    const rank = nonPlayableRank(color, input.stacks, input.avoidRanks ?? []);
    input.cards[index] = card(input.seed, `${input.prefix}${index}`, color, rank);
  }
}

function nonPlayableRank(
  color: FireworksColor,
  stacks: FireworksStackState,
  avoidRanks: FireworksRank[]
): FireworksRank {
  const playable = stacks[color] + 1;
  const candidates: FireworksRank[] = [3, 4, 2, 5, 1];
  const rank = candidates.find(
    (candidate) => candidate !== playable && !avoidRanks.includes(candidate)
  );
  return rank ?? 5;
}

function pickRank(
  pool: FireworksRank[],
  avoid: FireworksRank[]
): FireworksRank {
  return pool.find((candidate) => !avoid.includes(candidate)) ?? pool[0];
}

function seededClueEvent(
  seed: string,
  turn: number,
  playerId: string,
  action: Extract<FireworksAction, { action: "clue_color" | "clue_rank" }>
): FireworksEvent {
  return {
    id: `${seed}:history:${turn}`,
    turn,
    playerId,
    action,
    legal: true,
    seeded: true,
    useful: true,
    memoryConsistent: true,
    message:
      action.action === "clue_color"
        ? `${playerId} clued ${action.targetPlayerId} about ${action.color}.`
        : `${playerId} clued ${action.targetPlayerId} about ${action.rank}s.`,
    resultingScore: 0,
  };
}

function card(
  seed: string,
  slotKey: string,
  color: FireworksColor,
  rank: FireworksRank
): FireworksCard {
  // Positional ids only: card ids are visible for other hands (and in the
  // discard pile), so they must not describe the card's benchmark role.
  return { id: `${seed}:${slotKey}`, color, rank };
}

function emptyKnowledgeRow(): FireworksCardKnowledge[] {
  return [
    createEmptyFireworksKnowledge(),
    createEmptyFireworksKnowledge(),
    createEmptyFireworksKnowledge(),
    createEmptyFireworksKnowledge(),
  ];
}

function pickTacticsNumbers(numbers: number[]): FireworksScenario[] {
  return TACTICS_CATEGORIES.flatMap((_category, categoryIndex) =>
    numbers.map(
      (number) => FIREWORKS_TACTICS_SCENARIOS[categoryIndex * 10 + number - 1]
    )
  );
}

function pickMemoryNumbers(numbers: number[]): FireworksScenario[] {
  return MEMORY_CATEGORIES.flatMap((_category, categoryIndex) =>
    numbers.map(
      (number) => FIREWORKS_MEMORY_SCENARIOS[categoryIndex * 10 + number - 1]
    )
  );
}

function fullGamesForPlayerCount(playerCount: 2 | 3): FireworksFullGameCase[] {
  return FIREWORKS_FULL_GAME_CASES.filter(
    (benchmarkCase) => benchmarkCase.playerCount === playerCount
  );
}

function opaqueSeed(
  kind: "tactics" | "memory",
  category: string,
  number: number
): string {
  // Hash the descriptive key so the seed is deterministic but carries no
  // category text into the player view (gameId/seed are model-visible).
  return `fw-${hashString(`fireworks-${kind}-${category}-${number}`)}`;
}

function labelForSuite(suite: FireworksBenchmarkSuite): string {
  if (suite === "tactics") return "Fireworks TeamIQ Tactics v0.1";
  if (suite === "memory") return "Fireworks TeamIQ Memory v0.1";
  if (suite === "full") return "Fireworks TeamIQ Full Games v0.1";
  return "Fireworks TeamIQ Quick v0.1";
}

function isScenario(
  value: FireworksScenario | FireworksFullGameCase
): value is FireworksScenario {
  return "state" in value;
}

function isFullGame(
  value: FireworksScenario | FireworksFullGameCase
): value is FireworksFullGameCase {
  return "playerCount" in value;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(",")}}`;
}

function hashString(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}
