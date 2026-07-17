/* Certified GameIQ shared-layer guards (run: npx tsx scripts/test-gameiq-shared-guards.mts)
 *
 * Guards the shared GameIQ harness against answer leakage and score-gaming:
 * 1. The model-facing prompt never contains scenario titles or expected-action
 *    notes (titles historically named the answer outright).
 * 2. JSON shape examples are never a legal or scoreable answer for any pack.
 * 3. Battleship state is redacted for the model: own shot history + remaining
 *    enemy ship sizes only, never ship cells or per-hit ship ids; the
 *    coordinate convention is stated in the prompt.
 * 4. The codenames placeholder clue word is rejected by validation.
 * 5. Metric de-duplication keys on game + canonical state + expected-action
 *    content, not on label/note prose.
 * 6. Every pack labeled "first-class" passes the mechanical rigor floor.
 * 7. (removed) latencyFactor no longer exists on GameIqScoreInput; see the
 *    comment at guard 8's former location below.
 */
import {
  gameIqDecisionKey,
  gameIqPackFirstClassFloor,
  listGameIqScenarioPacks,
} from "../lib/benchmark/gameiq/packs";
import {
  gameIqActionShapeExample,
  gameIqModelStateView,
  gameIqScenarioPrompt,
} from "../lib/benchmark/gameiq/certified-runner";
import {
  GAMEIQ_PLACEHOLDER_CLUE_WORD,
  actionMatchesExpected,
  validateGameIqAction,
} from "../lib/benchmark/gameiq/validation";
import { runGameIqScenarios } from "../lib/benchmark/gameiq/runner";
import { GAMEIQ_CORRECT_QUALITY_BAR } from "../lib/benchmark/gameiq/types";
import type { GameIqScenario } from "../lib/benchmark/gameiq/types";

let failures = 0;

function check(name: string, ok: boolean, detail?: unknown): void {
  if (!ok) failures++;
  console.log(
    `${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` -> ${JSON.stringify(detail)}`}`
  );
}

const packs = listGameIqScenarioPacks();
const allScenarios = packs.flatMap((pack) => pack.scenarios);

// 1. Prompt de-leak: no scenario title, no expected-action note prose.
const promptLeaks = allScenarios.filter((scenario, index) => {
  const prompt = gameIqScenarioPrompt(scenario, index, allScenarios.length);
  if (prompt.includes(scenario.title)) return true;
  return scenario.expectedActions.some(
    (expected) => expected.note && prompt.includes(expected.note)
  );
});
check(
  "model prompt never contains scenario titles or expected-action notes",
  promptLeaks.length === 0,
  promptLeaks.map((scenario) => scenario.id)
);

// 2. Shape examples must be illegal and non-scoreable on every scenario.
const scoreableExamples = allScenarios.filter((scenario) => {
  const parsed = JSON.parse(gameIqActionShapeExample(scenario)) as {
    action: unknown;
  };
  return (
    validateGameIqAction(scenario, parsed.action).ok ||
    actionMatchesExpected(scenario, parsed.action) > 0
  );
});
check(
  "JSON shape example is never a legal or scoreable answer",
  scoreableExamples.length === 0,
  scoreableExamples.map((scenario) => scenario.id)
);

// 3. Battleship redaction + coordinate convention.
const battleshipScenarios = allScenarios.filter(
  (scenario) => scenario.gameId === "battleship"
);
check("battleship scenarios exist for redaction guard", battleshipScenarios.length > 0);
const redactionLeaks = battleshipScenarios.filter((scenario) => {
  const viewText = JSON.stringify(gameIqModelStateView(scenario));
  return (
    viewText.includes('"ships"') ||
    viewText.includes('"cells"') ||
    viewText.includes('"shipId"') ||
    !viewText.includes('"yourShots"') ||
    !viewText.includes('"remainingEnemyShipSizes"')
  );
});
check(
  "battleship model view redacts fleets (shot history + remaining sizes only)",
  redactionLeaks.length === 0,
  redactionLeaks.map((scenario) => scenario.id)
);
const conventionMissing = battleshipScenarios.filter((scenario, index) => {
  const prompt = gameIqScenarioPrompt(scenario, index, battleshipScenarios.length);
  return !(
    prompt.includes("rows A-J map to row 0-9") &&
    prompt.includes("columns 1-10 map to column 0-9")
  );
});
check(
  "battleship prompt states the row-letter/column-number convention",
  conventionMissing.length === 0,
  conventionMissing.map((scenario) => scenario.id)
);
// The convention example cell (B7 = {row:1,column:6}) must never be an
// expected answer, or the rules text itself would leak it.
const conventionCellExpected = battleshipScenarios.filter((scenario) =>
  scenario.expectedActions.some((expected) => {
    const action = expected.action as { target?: { row?: number; column?: number } };
    return action.target?.row === 1 && action.target.column === 6;
  })
);
check(
  "battleship convention example cell B7 is never an expected answer",
  conventionCellExpected.length === 0,
  conventionCellExpected.map((scenario) => scenario.id)
);
// Generic (not id-pinned, so it survives pack churn): every battleship
// scenario's redacted view must retain the mover's OWN full shot history —
// same length, same results in the same order as the underlying state's
// opponent-board shotsReceived — proving the redaction never strips it.
const shotHistoryMismatches = battleshipScenarios.filter((scenario) => {
  const state = scenario.initialState as {
    turn: "blue" | "orange";
    boards: Record<"blue" | "orange", { shotsReceived: Array<{ result: string }> }>;
  };
  const opponent = state.turn === "blue" ? "orange" : "blue";
  const expectedShots = state.boards[opponent].shotsReceived;
  const view = gameIqModelStateView(scenario) as {
    youAre?: string;
    yourShots?: Array<{ result?: string }>;
  };
  return (
    view.youAre !== state.turn ||
    view.yourShots?.length !== expectedShots.length ||
    !view.yourShots.every((shot, index) => shot.result === expectedShots[index].result)
  );
});
check(
  "battleship redacted view keeps the mover's own full shot history (every scenario)",
  shotHistoryMismatches.length === 0,
  shotHistoryMismatches.map((scenario) => scenario.id)
);

// 4. Codenames placeholder clue word is rejected (any casing).
const codenamesScenario = allScenarios.find(
  (scenario) => scenario.gameId === "codenames"
);
if (!codenamesScenario) {
  check("codenames scenario available for placeholder guard", false);
} else {
  const rejections = ["example", "EXAMPLE", "Example", ` ${GAMEIQ_PLACEHOLDER_CLUE_WORD} `].map(
    (word) => {
      const action = { type: "clue", clue: { word, count: 1 }, cardId: null };
      return (
        validateGameIqAction(codenamesScenario, action).ok === false &&
        actionMatchesExpected(codenamesScenario, action) === 0
      );
    }
  );
  check(
    "codenames placeholder clue word is illegal and non-scoreable in any casing",
    rejections.every(Boolean),
    rejections
  );
  const legalClue = {
    type: "clue",
    clue: { word: "XYLOPHONE", count: 1 },
    cardId: null,
  };
  check(
    "codenames still accepts a normal legal clue",
    validateGameIqAction(codenamesScenario, legalClue).ok === true,
    validateGameIqAction(codenamesScenario, legalClue)
  );
}

// 5. Decision key: note prose does not split groups; state differences do.
// gameiq-v0.2-connect-four-depth-1 and -depth-5 are distinct boards that both
// key column 2 (see connect-four-v2.ts) — the same "same action, different
// board" shape the old v0.1 win-horizontal/block-horizontal pair exercised.
const connectFourPack = packs.find((pack) => pack.gameId === "connect-four");
const winHorizontal = connectFourPack?.scenarios.find(
  (scenario) => scenario.id === "gameiq-v0.2-connect-four-depth-1"
);
const blockHorizontal = connectFourPack?.scenarios.find(
  (scenario) => scenario.id === "gameiq-v0.2-connect-four-depth-5"
);
if (!winHorizontal || !blockHorizontal) {
  check("connect-four scenarios available for decision-key guard", false);
} else {
  const sameDecisionRewordedNote: GameIqScenario = {
    ...winHorizontal,
    id: `${winHorizontal.id}-guard-reworded`,
    expectedActions: winHorizontal.expectedActions.map((expected) => ({
      ...expected,
      label: "Guard label",
      note: "Completely different prose that must not split the group.",
    })),
  };
  check(
    "decision key ignores label/note prose",
    gameIqDecisionKey(winHorizontal) === gameIqDecisionKey(sameDecisionRewordedNote),
    {
      a: gameIqDecisionKey(winHorizontal).slice(0, 120),
      b: gameIqDecisionKey(sameDecisionRewordedNote).slice(0, 120),
    }
  );
  check(
    "decision key separates different boards sharing an expected action",
    JSON.stringify(winHorizontal.expectedActions[0]?.action) ===
      JSON.stringify(blockHorizontal.expectedActions[0]?.action) &&
      gameIqDecisionKey(winHorizontal) !== gameIqDecisionKey(blockHorizontal),
    {
      winExpected: winHorizontal.expectedActions[0]?.action,
      blockExpected: blockHorizontal.expectedActions[0]?.action,
    }
  );

  // End-to-end: metric groups must reflect the same semantics. Three
  // scenarios, two decisions: [win-horizontal correct, reworded clone wrong]
  // averages 0.5, [block-horizontal correct] averages 1 -> outcome 0.75.
  const guardRun = await runGameIqScenarios({
    runId: "gameiq-guard-run-decision-key",
    modelId: "fake:decision-key",
    teamCompositionId: "team-guard-decision-key",
    scenarios: [winHorizontal, sameDecisionRewordedNote, blockHorizontal],
    moveProvider: ({ scenario }) => ({
      action:
        scenario.id === sameDecisionRewordedNote.id
          ? { column: 0 }
          : scenario.expectedActions[0]?.action,
      rawResponse: "decision-key-guard",
      latencyMs: 0,
    }),
  });
  check(
    "runner groups metrics by decision (state-aware, prose-blind)",
    Math.abs(guardRun.metrics.outcomeScore - 0.75) < 1e-9,
    guardRun.metrics
  );
}

// 6. Certification tier honesty: every first-class pack passes the floor.
for (const pack of packs) {
  const floor = gameIqPackFirstClassFloor(pack);
  if (pack.certificationTier === "first-class") {
    check(
      `${pack.id} (first-class) passes the mechanical rigor floor`,
      floor.ok,
      floor
    );
  } else {
    // Lightweight packs are allowed to pass or fail the floor (it is
    // necessary, not sufficient); just assert the floor computes sane values.
    check(
      `${pack.id} rigor floor computes sane diagnostics`,
      floor.distinctDecisions > 0 &&
        floor.maxConstantAnswerRate >= 0 &&
        floor.maxConstantAnswerRate <= 1,
      floor
    );
  }
}
// The demotions from the 2026-07 review must not silently regress: any pack
// pinned here currently fails the floor, so it cannot be first-class. (Fireworks
// packs are intentionally NOT pinned here: their scenarios are being
// re-authored, and the generic first-class-implies-floor guard above already
// prevents a dishonest promotion. Codenames was UN-pinned on 2026-07-02: it
// was re-authored from 25 legality clones into 10 distinct skill-binding
// decisions, now passes the rigor floor, and is honestly first-class. The v0.1
// Chess pack was similarly UN-pinned on 2026-07-02 before being hard-deleted
// 2026-07-17 in favor of the v0.2 quiet-mate pack, which is honestly
// first-class and verified by scripts/test-gameiq-chess-v2-pack.mts.)
const lightweightPinnedPackIds: string[] = [];
for (const packId of lightweightPinnedPackIds) {
  const pack = packs.find((candidate) => candidate.id === packId);
  if (!pack) {
    check(`${packId} exists for tier-honesty guard`, false);
    continue;
  }
  const floor = gameIqPackFirstClassFloor(pack);
  check(
    `${packId} fails the rigor floor and is labeled lightweight`,
    floor.ok === false && pack.certificationTier === "lightweight",
    { tier: pack.certificationTier, floor }
  );
}

// 7. Chess prompt states the accepted promotion vocabulary.
const chessScenario = allScenarios.find((scenario) => scenario.gameId === "chess");
if (!chessScenario) {
  check("chess scenario available for promotion vocabulary guard", false);
} else {
  const prompt = gameIqScenarioPrompt(chessScenario, 0, 1);
  check(
    "chess prompt states the accepted promotion strings",
    ['"queen"', '"rook"', '"bishop"', '"knight"'].every((token) =>
      prompt.includes(token)
    ),
    prompt
  );
}

// 8. (removed) latencyFactor was a diagnostic-only field on GameIqScoreInput;
// the B6 task removed the last maxResponseMs latency plumbing, and
// GameIqScoreInput (lib/benchmark/scoring/types.ts) no longer has a
// latencyFactor field at all, so there is nothing left for scoreGameIqAttempt
// to ignore. This guard is intentionally gone rather than kept as a
// tautological x === x check against a field the type no longer accepts.

// 9. Every keyed expected-action weight must clear the correct bar: a scenario
// that keys a sub-bar weight would mean its own "best" answer can never count
// as correct, which is a pack-authoring defect this task must not paper over.
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

if (failures === 0) {
  console.log("PASS");
} else {
  console.log(`FAIL ${failures} check(s) failed`);
}

process.exit(failures === 0 ? 0 : 1);
