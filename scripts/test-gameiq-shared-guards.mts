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
 * 7. The GameIQ score ignores the diagnostic latencyFactor.
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
import type { GameIqScenario } from "../lib/benchmark/gameiq/types";
import { scoreGameIqAttempt } from "../lib/benchmark/scoring/gameiq";

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
const followLine = battleshipScenarios.find(
  (scenario) => scenario.id === "gameiq-v0.1-battleship-follow-line"
);
const followLineView = followLine
  ? (gameIqModelStateView(followLine) as {
      youAre?: string;
      yourShots?: Array<{ result?: string; label?: string }>;
    })
  : undefined;
check(
  "battleship redacted view keeps the model's own shot history",
  followLineView?.youAre === "blue" &&
    followLineView.yourShots?.length === 2 &&
    followLineView.yourShots.every((shot) => shot.result === "hit") &&
    followLineView.yourShots.map((shot) => shot.label).join(",") === "A1,A2",
  followLineView
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
const connectFourPack = packs.find((pack) => pack.gameId === "connect-four");
const winHorizontal = connectFourPack?.scenarios.find(
  (scenario) => scenario.id === "gameiq-v0.1-connect-four-win-horizontal"
);
const blockHorizontal = connectFourPack?.scenarios.find(
  (scenario) => scenario.id === "gameiq-v0.1-connect-four-block-horizontal"
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
// The demotions from the 2026-07 review must not silently regress: these
// packs currently fail the floor, so they cannot be first-class. (Fireworks
// packs are intentionally NOT pinned here: their scenarios are being
// re-authored, and the generic first-class-implies-floor guard above already
// prevents a dishonest promotion.)
for (const packId of ["gameiq-v0.1-chess", "gameiq-v0.1-codenames"]) {
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

// 8. latencyFactor is diagnostic only: the score must ignore it.
const baseMetrics = {
  outcomeScore: 0.8,
  moveQuality: 0.7,
  legalActionRate: 0.9,
  structuredReliability: 1,
  fallbackRate: 0,
  latencyFactor: 1,
};
check(
  "GameIQ score ignores the diagnostic latencyFactor",
  scoreGameIqAttempt(baseMetrics) ===
    scoreGameIqAttempt({ ...baseMetrics, latencyFactor: 0 }),
  {
    withLatency: scoreGameIqAttempt(baseMetrics),
    withoutLatency: scoreGameIqAttempt({ ...baseMetrics, latencyFactor: 0 }),
  }
);

if (failures === 0) {
  console.log("PASS");
} else {
  console.log(`FAIL ${failures} check(s) failed`);
}

process.exit(failures === 0 ? 0 : 1);
