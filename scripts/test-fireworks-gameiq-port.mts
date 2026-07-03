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
import { runGameIqScenarios } from "../lib/benchmark/gameiq/runner";
import { fireworksActionsEqual } from "../lib/games/fireworks/engine";
import type { FireworksAction } from "../lib/games/fireworks/types";

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

// --- forbiddenActions carry-through (prior-review #34 remaining half) ---

// Every TeamIQ source scenario that declares forbiddenActions must have them
// preserved (deep-equal) on its ported GameIQ scenario, so trap-state packs can
// tell falling into the trap from an ordinary wrong move.
const teamIqById = new Map(
  [...FIREWORKS_TACTICS_SCENARIOS, ...FIREWORKS_MEMORY_SCENARIOS].map(
    (scenario) => [scenario.id, scenario]
  )
);
const portedWithForbidden = allPacks.filter((scenario) => {
  const source = sourceIdOf(scenario.tags);
  const teamiq = source ? teamIqById.get(source) : undefined;
  return (teamiq?.forbiddenActions?.length ?? 0) > 0;
});
check(
  "port preserves forbiddenActions for every TeamIQ source that declares them",
  portedWithForbidden.length > 0 &&
    portedWithForbidden.every((scenario) => {
      const source = sourceIdOf(scenario.tags);
      const teamiq = source ? teamIqById.get(source) : undefined;
      const expected = teamiq?.forbiddenActions ?? [];
      const actual = scenario.forbiddenActions ?? [];
      return (
        actual.length === expected.length &&
        expected.every((forbidden, index) =>
          fireworksActionsEqual(forbidden, actual[index] as FireworksAction)
        )
      );
    }),
  {
    portedWithForbidden: portedWithForbidden.length,
    firstMissing: portedWithForbidden.find((scenario) => {
      const source = sourceIdOf(scenario.tags);
      const teamiq = source ? teamIqById.get(source) : undefined;
      const expected = teamiq?.forbiddenActions ?? [];
      const actual = scenario.forbiddenActions ?? [];
      return actual.length !== expected.length;
    })?.id,
  }
);

check(
  "scenarios with no source forbiddenActions do not gain a forbiddenActions field",
  allPacks
    .filter((scenario) => {
      const source = sourceIdOf(scenario.tags);
      const teamiq = source ? teamIqById.get(source) : undefined;
      return (teamiq?.forbiddenActions?.length ?? 0) === 0;
    })
    .every((scenario) => scenario.forbiddenActions === undefined)
);

async function runOne(
  scenario: (typeof allPacks)[number],
  action: FireworksAction
) {
  const result = await runGameIqScenarios({
    runId: "test-forbidden",
    modelId: "test:model",
    teamCompositionId: "test-team",
    scenarios: [scenario],
    moveProvider: () => ({ action }),
  });
  return result.caseResults[0];
}

async function main(): Promise<void> {
  // Pick a scenario whose forbidden action is legal (so it isn't rejected for
  // shape/legality first) and whose expected weight-1 answer is a different
  // legal action, plus a third legal action that is neither expected nor
  // forbidden (the "ordinary wrong-but-legal move").
  const trap = allPacks.find((scenario) => {
    const view = scenario.initialState as { legalActions: FireworksAction[] };
    const forbidden = scenario.forbiddenActions ?? [];
    if (forbidden.length === 0) return false;
    const forbiddenLegal = forbidden.every((f) =>
      view.legalActions.some((legal) => fireworksActionsEqual(legal, f))
    );
    const expected = scenario.expectedActions.map(
      (e) => e.action as FireworksAction
    );
    const ordinaryWrong = view.legalActions.find(
      (legal) =>
        !forbidden.some((f) => fireworksActionsEqual(f, legal)) &&
        !expected.some((e) => fireworksActionsEqual(e, legal))
    );
    return forbiddenLegal && ordinaryWrong !== undefined;
  });

  check("a fireworks trap scenario is available for runner assertions", trap !== undefined);
  if (!trap) return;

  const view = trap.initialState as { legalActions: FireworksAction[] };
  const forbidden = (trap.forbiddenActions ?? [])[0]!;
  const expected = trap.expectedActions.map((e) => e.action as FireworksAction);
  const ordinaryWrong = view.legalActions.find(
    (legal) =>
      !(trap.forbiddenActions ?? []).some((f) =>
        fireworksActionsEqual(f, legal)
      ) && !expected.some((e) => fireworksActionsEqual(e, legal))
  )!;

  const trapResult = await runOne(trap, forbidden);
  check(
    "a forbidden action scores 0 with forbiddenBlunder set (legal but a trap)",
    trapResult.legal === true &&
      trapResult.forbiddenBlunder === true &&
      trapResult.correct === false &&
      trapResult.actionQuality === 0,
    {
      legal: trapResult.legal,
      forbiddenBlunder: trapResult.forbiddenBlunder,
      correct: trapResult.correct,
      actionQuality: trapResult.actionQuality,
    }
  );

  const ordinaryResult = await runOne(trap, ordinaryWrong);
  check(
    "an ordinary wrong-but-legal action does NOT set forbiddenBlunder",
    ordinaryResult.legal === true &&
      ordinaryResult.forbiddenBlunder === false &&
      ordinaryResult.correct === false,
    {
      action: ordinaryWrong,
      legal: ordinaryResult.legal,
      forbiddenBlunder: ordinaryResult.forbiddenBlunder,
      correct: ordinaryResult.correct,
    }
  );

  // --- Equivalent-information clue widening (2026-07-03 oracle audit) ---
  // hard-v1-14/-20 were miskeyed: models chose a clue_color that touches the
  // identical card set as the keyed clue_rank and scored 0. Equal information
  // must earn equal credit — see widenEquivalentClues in scenario-packs.ts.
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

  // Negative space for the widening pass: it must not fire where no keyed
  // (weight >= 0.75) clue exists, must add exactly ONE twin where it fires,
  // and must leave the basic/memory packs untouched.
  const WIDENED_LABEL = "Equivalent-information clue (auto-widened)";
  const hard13 = FIREWORKS_GAMEIQ_HARD_SCENARIOS.find(
    (s) => s.id === "gameiq-fireworks-hard-v1-13"
  )!;
  check(
    "gameiq-fireworks-hard-v1-13: no keyed clue to widen, expectedActions stays at 1",
    hard13.expectedActions.length === 1,
    hard13.expectedActions
  );
  const hard14 = FIREWORKS_GAMEIQ_HARD_SCENARIOS.find(
    (s) => s.id === "gameiq-fireworks-hard-v1-14"
  )!;
  check(
    "gameiq-fireworks-hard-v1-14: exactly one widened twin (discard + clue_rank-1 + clue_color-blue; non-equivalent red/green/rank-4 clues stay unkeyed)",
    hard14.expectedActions.length === 3,
    hard14.expectedActions
  );
  const widenedOutsideHard = [
    ...FIREWORKS_GAMEIQ_BASIC_SCENARIOS,
    ...FIREWORKS_GAMEIQ_MEMORY_STRESS_SCENARIOS,
  ].filter((scenario) =>
    scenario.expectedActions.some((e) => e.label === WIDENED_LABEL)
  );
  check(
    "widening adds nothing to the basic/memory packs (their version bumps are no-content-change)",
    widenedOutsideHard.length === 0,
    widenedOutsideHard.map((s) => s.id)
  );
  const widenedEntryCount = allPacks
    .flatMap((scenario) => scenario.expectedActions)
    .filter((e) => e.label === WIDENED_LABEL).length;
  check(
    "exactly 5 auto-widened entries across all GameIQ fireworks packs (safe_discard-02/04/06/08/10)",
    widenedEntryCount === 5,
    widenedEntryCount
  );

  if (failures === 0) {
    console.log("PASS");
  } else {
    console.log(`FAIL ${failures} check(s) failed`);
  }
  process.exit(failures === 0 ? 0 : 1);
}

void main();
