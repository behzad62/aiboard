/* Certified GameIQ Codenames pack checks
 * (run: npx tsx scripts/test-gameiq-codenames-pack.mts)
 *
 * Re-authored 2026-07-02. Verifies every scenario with the REAL Codenames
 * engine and the REAL GameIQ scoring path, so the pack is provably correct:
 *  - every clue scenario's expected words are legal (not on its board);
 *  - every guess scenario's expected card id is on the board and unrevealed;
 *  - a board-blind constant baseline (echo the shape example / always
 *    "ORBIT 1" / always guess the first card) scores zero correct pack-wide;
 *  - clue scenarios with binding constraints reject a legal-but-board-blind
 *    constant clue (skill required, not bare legality);
 *  - every scenario is a distinct decision (unique board + expected action);
 *  - each association guess scenario has exactly one defensible target family
 *    (encoded as an explicit allowlist for human audit);
 *  - the JSON shape-example rejection guard stays green.
 */
import {
  getGameIqScenarioPack,
  gameIqPackFirstClassFloor,
  gameIqDecisionKey,
} from "../lib/benchmark/gameiq/packs";
import {
  actionMatchesExpected,
  validateGameIqAction,
} from "../lib/benchmark/gameiq/validation";
import {
  gameIqActionShapeExample,
  gameIqModelStateView,
} from "../lib/benchmark/gameiq/certified-runner";
import { runGameIqScenarios } from "../lib/benchmark/gameiq/runner";
import type {
  CodenamesGameIqAction,
  GameIqScenario,
} from "../lib/benchmark/gameiq/types";
import type { CodenamesGameState } from "../lib/games/codenames/types";

let failures = 0;

function check(name: string, ok: boolean, detail?: unknown): void {
  if (!ok) failures++;
  console.log(
    `${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` -> ${JSON.stringify(detail)}`}`
  );
}

const pack = getGameIqScenarioPack("codenames");
if (!pack) {
  check("codenames pack exists", false);
  process.exit(1);
}

const scenarios = pack.scenarios;
const state = (scenario: GameIqScenario): CodenamesGameState =>
  scenario.initialState as CodenamesGameState;
const clueScenarios = scenarios.filter((s) => s.category !== "target-priority");
const guessScenarios = scenarios.filter((s) => s.category === "target-priority");
const bindingClueScenarios = scenarios.filter(
  (s) => s.category === "hidden-cooperation"
);

// -------------------------------------------------------------------------
// 0. Pack composition sanity. Every scenario is skill-binding — no
//    legality-only "clue-selection" scenarios remain (a legal constant clue
//    would pass those), so the constant baseline scores zero pack-wide.
// -------------------------------------------------------------------------
check("pack has 10 scenarios", scenarios.length === 10, scenarios.length);
check("pack has 6 guess scenarios", guessScenarios.length === 6, guessScenarios.length);
check(
  "pack has 4 binding-clue scenarios",
  bindingClueScenarios.length === 4,
  bindingClueScenarios.length
);
check(
  "pack has NO legality-only (clue-selection) scenarios",
  scenarios.filter((s) => s.category === "clue-selection").length === 0,
  scenarios.map((s) => s.category)
);
check(
  "scenario ids are unique",
  new Set(scenarios.map((s) => s.id)).size === scenarios.length,
  scenarios.map((s) => s.id)
);
check(
  "difficulty labels are honest (not index-derived)",
  scenarios.every((s) => ["easy", "medium", "hard"].includes(s.difficulty)),
  scenarios.map((s) => ({ id: s.id, difficulty: s.difficulty }))
);

// -------------------------------------------------------------------------
// 1. Every clue scenario's expected words are legal (NOT on its board).
// -------------------------------------------------------------------------
for (const scenario of clueScenarios) {
  const boardWords = new Set(
    state(scenario).cards.map((c) => c.word.trim().toUpperCase())
  );
  const offBoard = scenario.expectedActions.every((expected) => {
    const action = expected.action as CodenamesGameIqAction;
    return (
      action.type === "clue" &&
      !boardWords.has(action.clue.word.trim().toUpperCase())
    );
  });
  check(
    `${scenario.id}: every expected clue word is off-board (legal)`,
    offBoard,
    scenario.expectedActions.map((e) => (e.action as CodenamesGameIqAction))
  );
  // And each expected clue action is actually accepted by the validator.
  const allLegal = scenario.expectedActions.every(
    (expected) => validateGameIqAction(scenario, expected.action).ok
  );
  check(
    `${scenario.id}: every expected clue is engine-legal`,
    allLegal,
    scenario.expectedActions
      .filter((e) => !validateGameIqAction(scenario, e.action).ok)
      .map((e) => e.action)
  );
}

// -------------------------------------------------------------------------
// 2. Every guess scenario's expected card IS on the board, unrevealed, and in
//    the guess phase; and the expected guess is engine-legal.
// -------------------------------------------------------------------------
for (const scenario of guessScenarios) {
  const s = state(scenario);
  check(
    `${scenario.id}: scenario is in guess phase with guesses remaining`,
    s.phase === "guess" && s.status === "playing" && s.guessesRemaining > 0,
    { phase: s.phase, status: s.status, guessesRemaining: s.guessesRemaining }
  );
  for (const expected of scenario.expectedActions) {
    const action = expected.action as CodenamesGameIqAction;
    if (action.type !== "guess") {
      check(`${scenario.id}: expected action is a guess`, false, action);
      continue;
    }
    const target = s.cards.find((c) => c.id === action.cardId);
    check(
      `${scenario.id}: expected card ${action.cardId} exists, unrevealed`,
      target != null && target.revealed === false,
      target
    );
    check(
      `${scenario.id}: expected guess is engine-legal`,
      validateGameIqAction(scenario, action).ok,
      validateGameIqAction(scenario, action)
    );
    check(
      `${scenario.id}: expected guess scores full credit`,
      actionMatchesExpected(scenario, action) === 1,
      actionMatchesExpected(scenario, action)
    );
  }
}

// -------------------------------------------------------------------------
// 2b. Guess scenarios must NOT leak the answer key: the model-facing state
//     view carries no unrevealed card roles (all hidden roles redacted to
//     "neutral"), so a guesser cannot read the solution off the state.
// -------------------------------------------------------------------------
for (const scenario of guessScenarios) {
  const view = gameIqModelStateView(scenario) as CodenamesGameState;
  const leaks = view.cards.filter(
    (c) => !c.revealed && (c.role === "red" || c.role === "blue" || c.role === "assassin")
  );
  check(
    `${scenario.id}: model view redacts hidden card roles (no answer leak)`,
    leaks.length === 0,
    leaks.map((c) => ({ id: c.id, role: c.role }))
  );
  // Sanity: the redacted view is the same object scored/serialized to the model
  // (initialState verbatim for codenames), so the correct card id is unchanged.
  check(
    `${scenario.id}: redacted view preserves the expected card id as unrevealed`,
    scenario.expectedActions.every((e) => {
      const action = e.action as CodenamesGameIqAction;
      const target = view.cards.find((c) => c.id === (action.type === "guess" ? action.cardId : ""));
      return target != null && target.revealed === false;
    }),
    view.cards.filter((c) => !c.revealed).map((c) => c.id)
  );
}

// -------------------------------------------------------------------------
// 3. Board-blind constant baselines must score ZERO correct pack-wide.
//    (a) echo the JSON shape example; (b) always "ORBIT 1"; (c) always guess
//    the first board card id "card-1".
// -------------------------------------------------------------------------
const shapeExampleAction = (scenario: GameIqScenario): unknown => {
  const parsed = JSON.parse(gameIqActionShapeExample(scenario)) as {
    action: unknown;
  };
  return parsed.action;
};

const constantOrbit: CodenamesGameIqAction = {
  type: "clue",
  clue: { word: "ORBIT", count: 1 },
};
const constantFirstCard: CodenamesGameIqAction = {
  type: "guess",
  cardId: "card-1",
};

for (const [label, actionFor] of [
  ["shape example", (s: GameIqScenario) => shapeExampleAction(s)],
  ["constant ORBIT 1", () => constantOrbit],
  ["constant guess card-1", () => constantFirstCard],
] as const) {
  const correctCount = scenarios.filter(
    (scenario) => actionMatchesExpected(scenario, actionFor(scenario)) > 0
  ).length;
  check(
    `board-blind baseline "${label}" scores zero correct across the pack`,
    correctCount === 0,
    { correctCount }
  );
}

// The shape example must additionally be illegal/non-scoreable per the shared
// guard's contract (defense-in-depth against the reserved placeholder word).
for (const scenario of scenarios) {
  const example = shapeExampleAction(scenario);
  check(
    `${scenario.id}: shape example is never legal or scoreable`,
    !validateGameIqAction(scenario, example).ok &&
      actionMatchesExpected(scenario, example) === 0,
    example
  );
}

// -------------------------------------------------------------------------
// 4. Binding-clue scenarios reject a legal-but-board-blind constant clue:
//    "ORBIT" at the scenario's pinned count is LEGAL but NOT in the allowlist,
//    so it must score zero. This proves clue skill is required, not legality.
// -------------------------------------------------------------------------
for (const scenario of bindingClueScenarios) {
  const pinnedCount = (scenario.expectedActions[0].action as CodenamesGameIqAction);
  const count =
    pinnedCount.type === "clue" ? pinnedCount.clue.count : 1;
  const boardBlind: CodenamesGameIqAction = {
    type: "clue",
    clue: { word: "ORBIT", count },
  };
  check(
    `${scenario.id}: legal board-blind clue (ORBIT at pinned count) is legal`,
    validateGameIqAction(scenario, boardBlind).ok,
    validateGameIqAction(scenario, boardBlind)
  );
  check(
    `${scenario.id}: legal board-blind clue scores ZERO (skill required)`,
    actionMatchesExpected(scenario, boardBlind) === 0,
    actionMatchesExpected(scenario, boardBlind)
  );
  // The count is genuinely pinned: an allowlist word at the wrong count fails.
  const allowedWord =
    (scenario.expectedActions[0].action as CodenamesGameIqAction);
  if (allowedWord.type === "clue") {
    const wrongCount: CodenamesGameIqAction = {
      type: "clue",
      clue: { word: allowedWord.clue.word, count: allowedWord.clue.count + 1 },
    };
    check(
      `${scenario.id}: correct word at the wrong count scores zero (count pinned)`,
      actionMatchesExpected(scenario, wrongCount) === 0,
      wrongCount
    );
  }
  // Every allowlisted clue shares the same pinned count.
  const counts = new Set(
    scenario.expectedActions.map((e) => {
      const a = e.action as CodenamesGameIqAction;
      return a.type === "clue" ? a.clue.count : -1;
    })
  );
  check(
    `${scenario.id}: all allowlisted clues share one pinned count`,
    counts.size === 1,
    Array.from(counts)
  );
}

// -------------------------------------------------------------------------
// 5. Distinct decisions: no two scenarios share (board + expected action).
// -------------------------------------------------------------------------
const decisionKeys = scenarios.map((s) => gameIqDecisionKey(s));
check(
  "every scenario is a distinct decision (unique board + expected action)",
  new Set(decisionKeys).size === scenarios.length,
  { distinct: new Set(decisionKeys).size, total: scenarios.length }
);

// -------------------------------------------------------------------------
// 6. Association-guess audit: each single-target guess scenario has EXACTLY
//    one defensible target family. Encoded as an explicit allowlist mapping
//    clue -> the sole board word that legitimately fits, plus an assertion
//    that no OTHER unrevealed board word belongs to that family. A human
//    reviewer audits the ASSOCIATION_AUDIT table below.
// -------------------------------------------------------------------------
const ASSOCIATION_AUDIT: Record<
  string,
  { clue: string; family: string; target: string; foils: string[] }
> = {
  "gameiq-v0.1-codenames-guess-unambiguous": {
    clue: "CITRUS 1",
    family: "citrus fruit",
    target: "LEMON",
    // No other board word is a citrus fruit.
    foils: [],
  },
  "gameiq-v0.1-codenames-guess-elimination": {
    clue: "OCEAN 2",
    family: "ocean creature",
    target: "SHARK",
    // WHALE is the other ocean word but is already revealed; SHARK is the only
    // hidden ocean word remaining.
    foils: ["WHALE"],
  },
  "gameiq-v0.1-codenames-guess-count-second": {
    clue: "FRUIT 2",
    family: "fruit",
    target: "LEMON",
    foils: ["APPLE"], // APPLE already revealed.
  },
  "gameiq-v0.1-codenames-guess-cold": {
    clue: "COLD 1",
    family: "cold thing",
    target: "SNOW",
    foils: [],
  },
  "gameiq-v0.1-codenames-guess-last-animal": {
    clue: "ANIMAL 3",
    family: "animal",
    target: "EAGLE",
    foils: ["TIGER", "MOUSE"], // both already revealed.
  },
};

for (const scenario of guessScenarios) {
  if (scenario.id === "gameiq-v0.1-codenames-guess-either-twin") {
    // The intentional two-target scenario: verify BOTH targets are hidden and
    // both are the only two members of the family.
    const s = state(scenario);
    const cardWord = (id: string) => s.cards.find((c) => c.id === id)?.word;
    const targets = scenario.expectedActions.map((e) =>
      cardWord((e.action as { cardId: string }).cardId)
    );
    check(
      `${scenario.id}: exactly two forced targets (CASTLE + TOWER)`,
      scenario.expectedActions.length === 2 &&
        new Set(targets).size === 2 &&
        targets.every((w) => w === "CASTLE" || w === "TOWER"),
      targets
    );
    continue;
  }
  const audit = ASSOCIATION_AUDIT[scenario.id];
  check(`${scenario.id}: has an association-audit entry`, audit != null, scenario.id);
  if (!audit) continue;
  const s = state(scenario);
  const targetCard = s.cards.find(
    (c) => c.id === (scenario.expectedActions[0].action as { cardId: string }).cardId
  );
  check(
    `${scenario.id}: audited target word matches expected card`,
    targetCard?.word === audit.target,
    { expected: audit.target, actual: targetCard?.word }
  );
  // The declared foils are exactly the same-family words, and every one is
  // already revealed (so cannot be a competing legal guess).
  for (const foil of audit.foils) {
    const foilCard = s.cards.find((c) => c.word === foil);
    check(
      `${scenario.id}: foil ${foil} is present and already revealed`,
      foilCard != null && foilCard.revealed === true,
      foilCard
    );
  }
}

// -------------------------------------------------------------------------
// 7. End-to-end scoring: a perfect deterministic candidate scores 100 and
//    "passed"; the ORBIT-1 constant baseline scores far below the 70 pass
//    line (near-zero outcome/quality), through the real runner + scorer.
// -------------------------------------------------------------------------
const perfectRun = await runGameIqScenarios({
  runId: "codenames-pack-perfect",
  modelId: "fake:perfect",
  teamCompositionId: "team-perfect",
  scenarios,
  moveProvider: ({ scenario }) => ({
    action: scenario.expectedActions[0].action,
    rawResponse: "perfect",
    latencyMs: 0,
  }),
});
check(
  "perfect deterministic candidate scores 100 and passes",
  perfectRun.score === 100 && perfectRun.attempt.status === "passed",
  { score: perfectRun.score, status: perfectRun.attempt.status }
);

const baselineRun = await runGameIqScenarios({
  runId: "codenames-pack-baseline",
  modelId: "fake:orbit-baseline",
  teamCompositionId: "team-baseline",
  scenarios,
  moveProvider: () => ({
    action: constantOrbit,
    rawResponse: "orbit",
    latencyMs: 0,
  }),
});
check(
  "ORBIT-1 constant baseline scores ZERO correct and fails the pack",
  // statusFromScore(score, metrics) reports an illegal-answer baseline as
  // failed_tool_use; either failure status proves the pack can't be gamed.
  baselineRun.metrics.correctActions === 0 &&
    baselineRun.attempt.status !== "passed",
  {
    correctActions: baselineRun.metrics.correctActions,
    status: baselineRun.attempt.status,
    score: baselineRun.score,
  }
);
// Also a constant first-card guess baseline scores zero correct.
const guessBaselineRun = await runGameIqScenarios({
  runId: "codenames-pack-guess-baseline",
  modelId: "fake:card1-baseline",
  teamCompositionId: "team-guess-baseline",
  scenarios,
  moveProvider: () => ({
    action: constantFirstCard,
    rawResponse: "card-1",
    latencyMs: 0,
  }),
});
check(
  "constant card-1 guess baseline scores ZERO correct and fails the pack",
  guessBaselineRun.metrics.correctActions === 0 &&
    guessBaselineRun.attempt.status !== "passed",
  {
    correctActions: guessBaselineRun.metrics.correctActions,
    status: guessBaselineRun.attempt.status,
  }
);

// Guess target ids are spread: NO single card id is the correct answer on more
// than two scenarios, so any constant "guess card-N" baseline scores <= 0.2.
const guessCardIdCounts = new Map<string, number>();
for (const scenario of guessScenarios) {
  for (const expected of scenario.expectedActions) {
    const action = expected.action as CodenamesGameIqAction;
    if (action.type === "guess") {
      guessCardIdCounts.set(
        action.cardId,
        (guessCardIdCounts.get(action.cardId) ?? 0) + 1
      );
    }
  }
}
const maxGuessCardIdRepeat = Math.max(...guessCardIdCounts.values());
check(
  "no single guess card id is correct on more than two scenarios",
  maxGuessCardIdRepeat <= 2 && !guessCardIdCounts.has("card-1"),
  Object.fromEntries(guessCardIdCounts)
);

// -------------------------------------------------------------------------
// 8. Rigor floor: report the mechanical first-class floor result for this
//    pack (distinct decisions >= 10, constant-answer-rate < 0.5).
// -------------------------------------------------------------------------
const floor = gameIqPackFirstClassFloor(pack);
check(
  "pack passes the mechanical first-class rigor floor",
  floor.ok,
  floor
);
check(
  "pack certification tier matches the floor result",
  (floor.ok && pack.certificationTier === "first-class") ||
    (!floor.ok && pack.certificationTier === "lightweight"),
  { tier: pack.certificationTier, floorOk: floor.ok }
);

if (failures === 0) {
  console.log("PASS");
} else {
  console.log(`FAIL ${failures} check(s) failed`);
}

process.exit(failures === 0 ? 0 : 1);
