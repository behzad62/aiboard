import type { BenchmarkCaseV2 } from "@/lib/benchmark/types";
import {
  createEmptyFireworksKnowledge,
  createFireworksGame,
  fireworksActionsEqual,
  getLegalFireworksActions,
} from "@/lib/games/fireworks/engine";
import type {
  FireworksAction,
  FireworksCard,
  FireworksCardKnowledge,
  FireworksColor,
  FireworksGameState,
  FireworksRank,
} from "@/lib/games/fireworks/types";
import type {
  FireworksBenchmarkSuite,
  FireworksFullGameCase,
  FireworksMemoryCategory,
  FireworksScenario,
  FireworksTacticsCategory,
} from "./types";

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
  return getLegalFireworksActions(scenario.state, scenario.actingPlayerId).some(
    (candidate) => fireworksActionsEqual(candidate, action)
  )
    ? 0.3
    : 0;
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
  suite: FireworksBenchmarkSuite = "mixed"
): BenchmarkCaseV2 {
  const timestamp = new Date().toISOString();
  const cases = getFireworksBenchmarkCasesForSuite(suite);
  return {
    id,
    schemaVersion: 2,
    track: "teamiq",
    title: labelForSuite(suite),
    description:
      "Fireworks tests whether model teams can cooperate when no player sees their own cards.",
    difficulty: suite === "full" || suite === "mixed" ? "hard" : "medium",
    tags: ["teamiq", "fireworks", suite],
    caseVersion: "0.1.0",
    createdAt: timestamp,
    updatedAt: timestamp,
    prompt: {
      userRequest:
        "Run Fireworks TeamIQ with hidden information, limited legal clues, memory pressure, and objective scoring.",
      publicContext: JSON.stringify({
        suite,
        caseCount: cases.length,
        deckEmptyRule:
          "In AI Board Fireworks, when the deck is empty, play continues until hands are empty or the benchmark maxTurns limit is reached.",
        digest: stableFireworksScenarioPackDigest({
          id: `fireworks-${suite}-v0.1`,
          scenarios: cases.filter(isScenario),
          fullGames: cases.filter(isFullGame),
        }),
      }),
    },
    environment: { type: "browser", timeoutSeconds: 120, network: "none" },
    verifier: { scorer: "game-engine" },
    budget: { maxUsd: 5, maxModelCalls: 500 },
    scoring: { scoringVersion: "fireworks-teamiq-v0.1", primary: "team_lift" },
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
  const seed = `fireworks-tactics-${category}-${number}`;
  const color = COLORS[(number - 1) % COLORS.length];
  const nextRank = ((number - 1) % 4 + 1) as FireworksRank;
  const state = createPuzzleState(seed);
  let expectedActions: FireworksScenario["expectedActions"];
  let forbiddenActions: FireworksAction[] | undefined;
  let title = "";

  if (category === "safe_play") {
    state.stacks[color] = nextRank - 1;
    state.hands[0].cards[0] = card(seed, color, nextRank, "own-play");
    state.hands[0].knowledge[0] = knowledge({ color, rank: nextRank });
    expectedActions = [
      { action: { action: "play", cardIndex: 0 }, weight: 1, label: "Known playable card" },
    ];
    title = "Play a card proven playable by clues";
  } else if (category === "needed_clue") {
    state.hands[1].cards[0] = card(seed, color, 1, "partner-play");
    expectedActions = [
      {
        action: { action: "clue_rank", targetPlayerId: "P2", rank: 1 },
        weight: 1,
        label: "Tell partner about playable rank",
      },
      {
        action: { action: "clue_color", targetPlayerId: "P2", color },
        weight: 0.8,
        label: "Tell partner about playable color",
      },
    ];
    title = "Give the clue that unlocks a partner play";
  } else if (category === "avoid_bad_play") {
    state.stacks[color] = 1;
    state.hands[0].cards[0] = card(seed, color, 3, "own-trap");
    state.hands[0].knowledge[0] = knowledge({});
    state.hands[1].cards[0] = card(seed, "green", 1, "partner-safe");
    expectedActions = [
      {
        action: { action: "clue_rank", targetPlayerId: "P2", rank: 1 },
        weight: 1,
        label: "Clue a known playable partner card instead of guessing",
      },
    ];
    forbiddenActions = [{ action: "play", cardIndex: 0 }];
    title = "Avoid playing an unknown non-playable card";
  } else if (category === "safe_discard") {
    state.stacks[color] = 1;
    state.hands[0].cards[0] = card(seed, color, 1, "own-dead");
    state.hands[0].knowledge[0] = knowledge({ color, rank: 1 });
    state.clueTokens = 2;
    expectedActions = [
      { action: { action: "discard", cardIndex: 0 }, weight: 1, label: "Discard already-played card" },
    ];
    title = "Discard a card known to be no longer needed";
  } else if (category === "critical_discard_avoidance") {
    state.hands[0].cards[0] = card(seed, color, 5, "own-critical");
    state.hands[0].knowledge[0] = knowledge({ color });
    state.hands[1].cards[0] = card(seed, "red", 1, "partner-critical-clue");
    expectedActions = [
      {
        action: { action: "clue_rank", targetPlayerId: "P2", rank: 1 },
        weight: 1,
        label: "Use a useful clue instead of discarding a unique 5",
      },
    ];
    forbiddenActions = [{ action: "discard", cardIndex: 0 }];
    title = "Avoid discarding a critical card";
  } else {
    state.stacks[color] = 4;
    state.hands[0].cards[0] = card(seed, color, 5, "own-endgame");
    state.hands[0].knowledge[0] = knowledge({ color, rank: 5 });
    expectedActions = [
      { action: { action: "play", cardIndex: 0 }, weight: 1, label: "Finish a stack" },
    ];
    title = "Finish a stack in the endgame";
  }

  return {
    id: `fireworks-tactics-v0.1-${category}-${String(number).padStart(2, "0")}`,
    suite: "fireworks-tactics-v0.1",
    category,
    title: `${title} #${number}`,
    seed,
    state,
    actingPlayerId: "P1",
    expectedActions,
    forbiddenActions,
    tags: ["fireworks", "tactics", category],
  };
}

function createMemoryScenario(
  category: FireworksMemoryCategory,
  number: number
): FireworksScenario {
  const seed = `fireworks-memory-${category}-${number}`;
  const color = COLORS[(number - 1) % COLORS.length];
  const rank = (((number - 1) % 4) + 1) as FireworksRank;
  const state = createPuzzleState(seed);
  state.stacks[color] = rank - 1;
  state.hands[0].cards[0] = card(seed, color, rank, "memory-card");
  let title = "";

  if (category === "combine_color_and_rank") {
    state.hands[0].knowledge[0] = knowledge({
      color,
      rank,
      history: [`Turn 1: ${color}`, `Turn 3: rank ${rank}`],
    });
    title = "Combine color and rank clues";
  } else if (category === "old_clue_recall") {
    state.hands[0].knowledge[0] = knowledge({
      color,
      rank,
      history: [`Turn 1: ${color}`, `Turn 6: rank ${rank}`],
    });
    title = "Remember an old clue";
  } else if (category === "negative_information") {
    const possibleColors = COLORS.filter((candidate) => candidate !== color);
    state.hands[0].knowledge[0] = knowledge({
      color,
      rank,
      notColors: possibleColors,
      notRanks: [1, 2, 3, 4, 5].filter((candidate) => candidate !== rank) as FireworksRank[],
      history: ["Earlier clues ruled out every non-playable identity."],
    });
    title = "Respect negative information";
  } else {
    state.hands[0].knowledge[0] = knowledge({
      color,
      rank,
      history: [
        "Turn 2: partner clued this card before the stack advanced.",
        `Turn 5: rank ${rank} is now playable.`,
      ],
    });
    title = "Infer from clue timing";
  }

  state.events = state.hands[0].knowledge[0].clueHistory.map((message, index) => ({
    id: `${seed}:history:${index + 1}`,
    turn: index + 1,
    playerId: "P2",
    action:
      index % 2 === 0
        ? { action: "clue_color", targetPlayerId: "P1", color }
        : { action: "clue_rank", targetPlayerId: "P1", rank },
    legal: true,
    useful: true,
    memoryConsistent: true,
    message,
    resultingScore: state.stacks.red + state.stacks.blue + state.stacks.green,
  }));

  return {
    id: `fireworks-memory-v0.1-${category}-${String(number).padStart(2, "0")}`,
    suite: "fireworks-memory-v0.1",
    category,
    title: `${title} #${number}`,
    seed,
    state,
    actingPlayerId: "P1",
    expectedActions: [
      { action: { action: "play", cardIndex: 0 }, weight: 1, label: "Use remembered clues to play" },
    ],
    forbiddenActions: [{ action: "discard", cardIndex: 0 }],
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

function createPuzzleState(seed: string): FireworksGameState {
  const state = createFireworksGame({
    seed,
    players: [
      { id: "P1", label: "Player 1", kind: "ai" },
      { id: "P2", label: "Player 2", kind: "ai" },
    ],
  });
  state.deck = [];
  state.currentPlayerIndex = 0;
  state.turn = 0;
  state.status = "playing";
  state.stacks = { red: 0, blue: 0, green: 0 };
  state.clueTokens = 6;
  state.mistakeTokens = 3;
  state.hands = [
    {
      playerId: "P1",
      cards: [
        card(seed, "red", 1, "p1-0"),
        card(seed, "blue", 2, "p1-1"),
        card(seed, "green", 3, "p1-2"),
        card(seed, "red", 4, "p1-3"),
      ],
      knowledge: [
        createEmptyFireworksKnowledge(),
        createEmptyFireworksKnowledge(),
        createEmptyFireworksKnowledge(),
        createEmptyFireworksKnowledge(),
      ],
    },
    {
      playerId: "P2",
      cards: [
        card(seed, "blue", 1, "p2-0"),
        card(seed, "red", 2, "p2-1"),
        card(seed, "green", 4, "p2-2"),
        card(seed, "blue", 5, "p2-3"),
      ],
      knowledge: [
        createEmptyFireworksKnowledge(),
        createEmptyFireworksKnowledge(),
        createEmptyFireworksKnowledge(),
        createEmptyFireworksKnowledge(),
      ],
    },
  ];
  return state;
}

function card(
  seed: string,
  color: FireworksColor,
  rank: FireworksRank,
  suffix: string
): FireworksCard {
  return { id: `${seed}:${suffix}:${color}-${rank}`, color, rank };
}

function knowledge(input: {
  color?: FireworksColor;
  rank?: FireworksRank;
  notColors?: FireworksColor[];
  notRanks?: FireworksRank[];
  history?: string[];
}): FireworksCardKnowledge {
  return {
    color: input.color,
    rank: input.rank,
    notColors: [...(input.notColors ?? [])],
    notRanks: [...(input.notRanks ?? [])],
    clueHistory: [...(input.history ?? [])],
  };
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
