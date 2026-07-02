/* Fireworks GameIQ port checks (run: npx tsx scripts/test-fireworks-gameiq-port.mts) */
import {
  FIREWORKS_GAMEIQ_BASIC_SCENARIOS,
  FIREWORKS_GAMEIQ_HARD_SCENARIOS,
  FIREWORKS_GAMEIQ_MEMORY_STRESS_SCENARIOS,
} from "../lib/benchmark/gameiq/fireworks";
import {
  FIREWORKS_MEMORY_SCENARIOS,
  FIREWORKS_TACTICS_SCENARIOS,
} from "../lib/benchmark/fireworks/scenario-packs";

let failures = 0;

function check(name: string, ok: boolean, detail?: unknown): void {
  if (!ok) failures++;
  console.log(
    `${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` -> ${JSON.stringify(detail)}`}`
  );
}

const allPacks = [
  ...FIREWORKS_GAMEIQ_BASIC_SCENARIOS,
  ...FIREWORKS_GAMEIQ_HARD_SCENARIOS,
  ...FIREWORKS_GAMEIQ_MEMORY_STRESS_SCENARIOS,
];

check(
  "GameIQ fireworks packs keep their sizes (basic 20 / hard 40 / memory 30)",
  FIREWORKS_GAMEIQ_BASIC_SCENARIOS.length === 20 &&
    FIREWORKS_GAMEIQ_HARD_SCENARIOS.length === 40 &&
    FIREWORKS_GAMEIQ_MEMORY_STRESS_SCENARIOS.length === 30,
  {
    basic: FIREWORKS_GAMEIQ_BASIC_SCENARIOS.length,
    hard: FIREWORKS_GAMEIQ_HARD_SCENARIOS.length,
    memory: FIREWORKS_GAMEIQ_MEMORY_STRESS_SCENARIOS.length,
  }
);

function sourceIdOf(tags: string[]): string | null {
  const tag = tags.find((candidate) => candidate.startsWith("source:"));
  return tag ? tag.slice("source:".length) : null;
}

const sourceIds = new Set(
  [...FIREWORKS_TACTICS_SCENARIOS, ...FIREWORKS_MEMORY_SCENARIOS].map(
    (scenario) => scenario.id
  )
);
check(
  "every GameIQ fireworks scenario records its TeamIQ source scenario (dedup provenance)",
  allPacks.every((scenario) => {
    const source = sourceIdOf(scenario.tags);
    return source !== null && sourceIds.has(source);
  }),
  allPacks
    .filter((scenario) => {
      const source = sourceIdOf(scenario.tags);
      return source === null || !sourceIds.has(source);
    })
    .map((scenario) => scenario.id)
);

// The old filter(safe_play || needed_clue).slice(0, 10) silently dropped every
// needed_clue scenario: clue-giving was unreachable from any GameIQ pack.
const basicSources = FIREWORKS_GAMEIQ_BASIC_SCENARIOS.map((scenario) =>
  sourceIdOf(scenario.tags)
);
check(
  "basic pack tests clue-giving: 5 safe_play + 5 needed_clue + 10 combine sources",
  basicSources.filter((source) => source?.includes("-safe_play-")).length === 5 &&
    basicSources.filter((source) => source?.includes("-needed_clue-")).length === 5 &&
    basicSources.filter((source) => source?.includes("-combine_color_and_rank-"))
      .length === 10,
  basicSources
);
check(
  "basic pack includes multi-weight expected actions (needed_clue alternatives)",
  FIREWORKS_GAMEIQ_BASIC_SCENARIOS.some(
    (scenario) =>
      scenario.expectedActions.length >= 2 &&
      scenario.expectedActions.some((expected) => expected.weight === 1) &&
      scenario.expectedActions.some((expected) => expected.weight < 1)
  )
);

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
check(
  "no GameIQ fireworks initialState leaks category names or card-role labels",
  allPacks.every((scenario) => {
    const text = JSON.stringify(scenario.initialState).toLowerCase();
    return BANNED_VIEW_TOKENS.every((token) => !text.includes(token));
  }),
  allPacks
    .filter((scenario) => {
      const text = JSON.stringify(scenario.initialState).toLowerCase();
      return BANNED_VIEW_TOKENS.some((token) => text.includes(token));
    })
    .map((scenario) => scenario.id)
);

check(
  "an 'always play cardIndex 0' baseline cannot match the weight-1 answer on most scenarios",
  (() => {
    const matches = allPacks.filter((scenario) =>
      scenario.expectedActions.some(
        (expected) =>
          expected.weight === 1 &&
          (expected.action as { action?: string; cardIndex?: number }).action ===
            "play" &&
          (expected.action as { cardIndex?: number }).cardIndex === 0
      )
    );
    return matches.length <= Math.floor(allPacks.length * 0.3);
  })(),
  allPacks.length
);

if (failures === 0) {
  console.log("PASS");
} else {
  console.log(`FAIL ${failures} check(s) failed`);
}

process.exit(failures === 0 ? 0 : 1);
