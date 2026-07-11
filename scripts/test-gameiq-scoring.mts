/* Certified GameIQ v0.1 scoring runner checks (run: npx tsx scripts/test-gameiq-scoring.mts) */
import {
  getGameIqScenarioPack,
  listGameIqScenarios,
  runGameIqScenarios,
  type GameIqMoveProvider,
  type GameIqScenario,
} from "../lib/benchmark/gameiq";
import {
  actionMatchesExpected,
  FIREWORKS_DEAD_CLUE_GRADE,
  FIREWORKS_NEUTRAL_LEGAL_GRADE,
  gradeBattleshipAction,
  gradeFireworksAction,
} from "../lib/benchmark/gameiq/validation";
import {
  GAMEIQ_CORRECT_QUALITY_BAR,
  GAMEIQ_SCORING_VERSION,
  type BattleshipGameIqScenario,
  type FireworksGameIqScenario,
} from "../lib/benchmark/gameiq/types";
import { scoreGameIqAttempt } from "../lib/benchmark/scoring/gameiq";
import { fireworksActionsEqual } from "../lib/games/fireworks/engine";
import type { FireworksAction } from "../lib/games/fireworks/types";
import {
  blueShotHistory as bsHistory,
  cell as bsCell,
  shipFor as bsShip,
} from "../lib/benchmark/gameiq/battleship-builders";
import { battleshipKeyedCells } from "../lib/benchmark/gameiq/battleship-oracle";

let failures = 0;

function check(name: string, ok: boolean, detail?: unknown): void {
  if (!ok) failures++;
  console.log(
    `${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` -> ${JSON.stringify(detail)}`}`
  );
}

const scenarios = listGameIqScenarios();

const perfectProvider: GameIqMoveProvider = ({ scenario }) => ({
  action: scenario.expectedActions[0]?.action,
  rawResponse: JSON.stringify({ action: scenario.expectedActions[0]?.action }),
  latencyMs: 0,
});

const perfect = await runGameIqScenarios({
  runId: "gameiq-test-run-perfect",
  modelId: "fake:perfect",
  teamCompositionId: "team-fake-perfect",
  scenarios,
  moveProvider: perfectProvider,
});

check("perfect fake model scores 100", perfect.score === 100, perfect);
check(
  "perfect run emits save-compatible GameIQ attempt fields",
  perfect.attempt.track === "gameiq" &&
    perfect.attempt.mode === "certified" &&
    perfect.attempt.status === "passed" &&
    perfect.attempt.gameIqScore === 100 &&
    perfect.attempt.verifiedQuality === 1 &&
    perfect.attempt.jobSuccessScore === 100 &&
    perfect.attempt.efficiencyScore === 100 &&
    perfect.attempt.scoringVersion === "certified-gameiq-v0.3",
  perfect.attempt
);
check(
  "GameIQ default timestamps reflect the actual run",
  !perfect.attempt.startedAt.startsWith("1970-") &&
    typeof perfect.attempt.completedAt === "string" &&
    Date.parse(perfect.attempt.completedAt) >= Date.parse(perfect.attempt.startedAt) &&
    perfect.attempt.durationMs >= 0,
  perfect.attempt
);
check(
  "perfect run records all actions as structured, legal, and correct",
  perfect.metrics.structuredReliability === 1 &&
    perfect.metrics.legalActionRate === 1 &&
    perfect.metrics.outcomeScore === 1 &&
    perfect.metrics.moveQuality === 1 &&
    perfect.metrics.fallbackRate === 0,
  perfect.metrics
);

const slowPerfect = await runGameIqScenarios({
  runId: "gameiq-test-run-slow-perfect",
  modelId: "fake:slow-perfect",
  teamCompositionId: "team-fake-slow-perfect",
  scenarios,
  moveProvider: ({ scenario }) => ({
    action: scenario.expectedActions[0]?.action,
    rawResponse: JSON.stringify({ action: scenario.expectedActions[0]?.action }),
    latencyMs: 10_000_000,
  }),
});
check("GameIQ score ignores wall-clock latency", slowPerfect.score === 100, slowPerfect);

const invalidProvider: GameIqMoveProvider = () => ({
  action: "not-json-action",
  rawResponse: "not-json-action",
  latencyMs: 0,
});

const invalid = await runGameIqScenarios({
  runId: "gameiq-test-run-invalid",
  modelId: "fake:invalid",
  teamCompositionId: "team-fake-invalid",
  scenarios,
  moveProvider: invalidProvider,
});

check("invalid fake model scores low", invalid.score < 25, invalid);
check(
  "invalid fake model loses structure and legality credit",
  invalid.metrics.structuredReliability === 0 &&
    invalid.metrics.legalActionRate === 0 &&
    invalid.metrics.outcomeScore === 0 &&
    invalid.metrics.moveQuality === 0 &&
    invalid.attempt.status === "failed_tool_use",
  { metrics: invalid.metrics, attempt: invalid.attempt }
);

let providerErrorPropagated = false;
try {
  await runGameIqScenarios({
    runId: "gameiq-test-run-provider-error",
    modelId: "fake:provider-error",
    teamCompositionId: "team-fake-provider-error",
    scenarios: [scenarios[0]],
    moveProvider: () => {
      throw new Error("Provider unavailable: simulated scenario failure");
    },
  });
} catch (error) {
  providerErrorPropagated =
    error instanceof Error &&
    error.message === "Provider unavailable: simulated scenario failure";
}
check(
  "GameIQ propagates move provider errors instead of scoring them as model actions",
  providerErrorPropagated
);

const connectFourScenario = getGameIqScenarioPack("connect-four")?.scenarios[0];
if (!connectFourScenario) {
  check("Connect Four scenarios available for illegal action check", false);
} else {
  const illegalStructured = await runGameIqScenarios({
    runId: "gameiq-test-run-illegal",
    modelId: "fake:illegal",
    teamCompositionId: "team-fake-illegal",
    scenarios: [connectFourScenario],
    moveProvider: () => ({
      action: { column: 99 },
      rawResponse: JSON.stringify({ action: { column: 99 } }),
      latencyMs: 0,
    }),
  });

  check(
    "illegal structured action reduces legal action and structured reliability",
    illegalStructured.metrics.legalActionRate === 0 &&
      illegalStructured.metrics.structuredReliability === 0 &&
      illegalStructured.score < 25,
    illegalStructured
  );
}

const chessPack = getGameIqScenarioPack("chess");
const firstChessScenario = chessPack?.scenarios[0];
const distinctChessScenario = chessPack?.scenarios.find(
  (scenario) =>
    JSON.stringify(scenario.expectedActions) !==
    JSON.stringify(firstChessScenario?.expectedActions)
);
if (!firstChessScenario || !distinctChessScenario) {
  check("Chess scenarios available for de-dup aggregation check", false);
} else {
  const clonedChessScenarios: GameIqScenario[] = [
    { ...firstChessScenario, id: `${firstChessScenario.id}-clone-a` },
    { ...firstChessScenario, id: `${firstChessScenario.id}-clone-b` },
    distinctChessScenario,
  ];
  const dedupedResult = await runGameIqScenarios({
    runId: "gameiq-test-run-deduped-clones",
    modelId: "fake:deduped",
    teamCompositionId: "team-fake-deduped",
    scenarios: clonedChessScenarios,
    moveProvider: ({ scenarioIndex, scenario }) => ({
      action:
        scenarioIndex === 1
          ? { from: "a1", to: "a1" }
          : scenario.expectedActions[0]?.action,
      rawResponse: "dedupe-check",
      latencyMs: 0,
    }),
  });
  const expectedDedupedOutcome = 0.75;
  check(
    "identical chess clones collapse to one group in outcomeScore",
    Math.abs(dedupedResult.metrics.outcomeScore - expectedDedupedOutcome) < 1e-9,
    { outcomeScore: dedupedResult.metrics.outcomeScore, expectedDedupedOutcome }
  );
}

const codenamesScenario = getGameIqScenarioPack("codenames")?.scenarios[0];
if (!codenamesScenario) {
  check("Codenames scenarios available for behavioral clue scoring", false);
} else {
  // Since the 2026-07-02 re-authoring, codenames clue scenarios are
  // skill-binding ("hidden-cooperation"): a legal but board-blind clue that is
  // not in the scenario's defensible allowlist must count as LEGAL yet score
  // ZERO correctness. GALAXY is not a board word on any codenames board.
  const legalBoardBlindClue = await runGameIqScenarios({
    runId: "gameiq-test-run-codenames-legal-board-blind-clue",
    modelId: "fake:codenames",
    teamCompositionId: "team-fake-codenames",
    scenarios: [codenamesScenario],
    moveProvider: () => ({
      action: {
        type: "clue",
        clue: { word: "GALAXY", count: 2 },
        cardId: null,
      },
      rawResponse: JSON.stringify({
        action: {
          type: "clue",
          clue: { word: "GALAXY", count: 2 },
          cardId: null,
        },
      }),
      latencyMs: 0,
    }),
  });

  check(
    "Codenames binding clue: legal board-blind clue is legal but scores zero",
    legalBoardBlindClue.metrics.structuredReliability === 1 &&
      legalBoardBlindClue.metrics.legalActionRate === 1 &&
      legalBoardBlindClue.metrics.outcomeScore === 0 &&
      legalBoardBlindClue.metrics.moveQuality === 0 &&
      legalBoardBlindClue.attempt.status !== "passed",
    legalBoardBlindClue
  );
}

// --- v0.3 scoring: graded fireworks quality + correct bar + reweight ---
const hard27 = scenarios.find(
  (s) => s.id === "gameiq-fireworks-hard-v1-27"
) as FireworksGameIqScenario | undefined;
if (!hard27) {
  check("gameiq-fireworks-hard-v1-27 scenario available for graded-quality checks", false);
} else {
  check(
    "gradeFireworksAction: keyed clue_rank matches its weight (1)",
    gradeFireworksAction(hard27, {
      action: "clue_rank",
      targetPlayerId: "P2",
      rank: 2,
    }) === 1,
    hard27
  );
  check(
    "gradeFireworksAction: forbidden play scores 0",
    gradeFireworksAction(hard27, { action: "play", cardIndex: 2 }) === 0,
    hard27
  );
  const neutralDiscard = gradeFireworksAction(hard27, {
    action: "discard",
    cardIndex: 0,
  });
  check(
    "gradeFireworksAction: neutral legal discard (blue4, not critical, not keyed) scores 0.3",
    neutralDiscard === 0.3,
    neutralDiscard
  );
  check(
    "gradeFireworksAction: the 0.3 neutral floor is below the correct bar",
    neutralDiscard < GAMEIQ_CORRECT_QUALITY_BAR,
    { neutralDiscard, GAMEIQ_CORRECT_QUALITY_BAR }
  );
}

// Pin the partial-credit grade VALUES once (TeamIQ lockstep contract), so the
// constant-based assertions below cannot drift into tautologies.
check(
  "fireworks partial-credit grades stay pinned (0.1 dead clue / 0.3 neutral legal)",
  FIREWORKS_DEAD_CLUE_GRADE === 0.1 && FIREWORKS_NEUTRAL_LEGAL_GRADE === 0.3,
  { FIREWORKS_DEAD_CLUE_GRADE, FIREWORKS_NEUTRAL_LEGAL_GRADE }
);

// Dead-clue grade coverage: the most intricate branch of gradeFireworksAction
// (target-hand lookup, touched-set filter, null guards, stacks-vs-rank over
// every()). Search the SHIPPED fireworks packs for real scenarios exercising
// it, so these checks survive pack regeneration: a legal, non-keyed,
// non-forbidden clue touching ONLY already-played cards must grade exactly
// FIREWORKS_DEAD_CLUE_GRADE, and one touching a MIX of dead and live cards
// must fall through to the neutral floor — the mixed case is what
// distinguishes every() from some() (an all-dead touched set satisfies both).
const fireworksScenarios = scenarios.filter(
  (s): s is FireworksGameIqScenario => s.gameId === "fireworks"
);
function findClueTouching(
  kind: "all-dead" | "mixed"
): { scenario: FireworksGameIqScenario; clue: FireworksAction } | null {
  for (const scenario of fireworksScenarios) {
    const view = scenario.initialState;
    for (const legal of view.legalActions) {
      if (legal.action !== "clue_color" && legal.action !== "clue_rank") continue;
      if (
        (scenario.forbiddenActions ?? []).some((forbidden) =>
          fireworksActionsEqual(forbidden, legal)
        ) ||
        scenario.expectedActions.some((expected) =>
          fireworksActionsEqual(expected.action, legal)
        )
      ) {
        continue;
      }
      const target = view.otherHands.find(
        (hand) => hand.playerId === legal.targetPlayerId
      );
      const touched = (target?.cards ?? []).filter((card) =>
        legal.action === "clue_color"
          ? card.color === legal.color
          : card.rank === legal.rank
      );
      if (touched.length === 0) continue;
      const deadCount = touched.filter(
        (card) =>
          card.color !== null &&
          card.rank !== null &&
          view.stacks[card.color] >= card.rank
      ).length;
      const matches =
        kind === "all-dead"
          ? deadCount === touched.length
          : deadCount > 0 && deadCount < touched.length;
      if (matches) return { scenario, clue: legal };
    }
  }
  return null;
}

const deadClue = findClueTouching("all-dead");
if (!deadClue) {
  check(
    "a shipped fireworks scenario offers an all-dead-touch clue for the dead-clue branch",
    false
  );
} else {
  const grade = gradeFireworksAction(deadClue.scenario, deadClue.clue);
  check(
    `gradeFireworksAction: clue touching only already-played cards grades the dead-clue 0.1 (${deadClue.scenario.id})`,
    grade === FIREWORKS_DEAD_CLUE_GRADE && grade < GAMEIQ_CORRECT_QUALITY_BAR,
    { scenario: deadClue.scenario.id, clue: deadClue.clue, grade }
  );
}

const mixedClue = findClueTouching("mixed");
if (!mixedClue) {
  check(
    "a shipped fireworks scenario offers a mixed dead/live-touch clue for the neutral branch",
    false
  );
} else {
  const grade = gradeFireworksAction(mixedClue.scenario, mixedClue.clue);
  check(
    `gradeFireworksAction: clue touching dead AND live cards stays at the neutral floor, not dead-clue (${mixedClue.scenario.id})`,
    grade === FIREWORKS_NEUTRAL_LEGAL_GRADE,
    { scenario: mixedClue.scenario.id, clue: mixedClue.clue, grade }
  );
}

check(
  "GAMEIQ_SCORING_VERSION bumped to v0.3",
  GAMEIQ_SCORING_VERSION === "certified-gameiq-v0.3",
  GAMEIQ_SCORING_VERSION
);

check(
  "scoreGameIqAttempt: outcome/quality at 0.5 with full legality/structure scores 50",
  scoreGameIqAttempt({
    outcomeScore: 0.5,
    moveQuality: 0.5,
    legalActionRate: 1,
    structuredReliability: 1,
    fallbackRate: 0,
  }) === 50
);

check(
  "scoreGameIqAttempt: all-legal-but-all-wrong no longer harvests the 31 free legality/structure points",
  scoreGameIqAttempt({
    outcomeScore: 0,
    moveQuality: 0,
    legalActionRate: 1,
    structuredReliability: 1,
    fallbackRate: 0,
  }) === 0
);

// Regression guard for trap detection under graded scoring:
// matchesForbiddenAction (runner.ts) answers "is this action forbidden?" by
// DIRECT per-game membership (gameIqActionsEqual), never through
// actionMatchesExpected/gradeFireworksAction. If a probe-through-the-grader
// pattern were ever re-inlined it fails visibly: grading the trap action
// against a probe still carrying the scenario's forbiddenActions returns 0
// and THIS check fails, while clearing them lets the nonzero neutral legal
// floor false-flag every ordinary legal action as a trap, which the
// perfect-run score-100 check above catches.
if (hard27) {
  const forbiddenPlayResult = await runGameIqScenarios({
    runId: "gameiq-test-run-forbidden-probe-regression",
    modelId: "fake:forbidden-probe",
    teamCompositionId: "team-fake-forbidden-probe",
    scenarios: [hard27],
    moveProvider: () => ({
      action: {
        action: "play",
        targetPlayerId: null,
        color: null,
        rank: null,
        cardIndex: 2,
      },
      rawResponse: "forbidden-probe-regression",
      latencyMs: 0,
    }),
  });
  const forbiddenCaseResult = forbiddenPlayResult.caseResults[0];
  check(
    "direct-membership trap detection survives graded fireworks scoring",
    forbiddenCaseResult?.forbiddenBlunder === true &&
      forbiddenCaseResult.actionQuality === 0,
    forbiddenCaseResult
  );
}

// --- concurrency: bounded pool preserves scenario order regardless of
// completion order; concurrency omitted stays sequential (unchanged behavior) ---
const concurrencyScenarios = scenarios.slice(0, 8);
const order: number[] = [];
const parallel = await runGameIqScenarios({
  runId: "gameiq-test-run-concurrency",
  modelId: "fake:concurrency",
  teamCompositionId: "team-fake-concurrency",
  scenarios: concurrencyScenarios,
  concurrency: 4,
  moveProvider: async ({ scenario, scenarioIndex }) => {
    // Reverse-ordered delay so later-indexed scenarios finish first, forcing
    // completion order out of scenario order under a bounded pool.
    await new Promise((resolve) => setTimeout(resolve, (8 - scenarioIndex) * 5));
    order.push(scenarioIndex);
    return { action: scenario.expectedActions[0]?.action };
  },
});
check(
  "concurrency: caseResults preserve scenario order regardless of completion order",
  parallel.caseResults.map((r) => r.scenarioId).join() ===
    concurrencyScenarios.map((s) => s.id).join(),
  { got: parallel.caseResults.map((r) => r.scenarioId), expected: concurrencyScenarios.map((s) => s.id) }
);
check(
  "concurrency: completions actually interleaved out of scenario order",
  order.join() !== [...order].sort((a, b) => a - b).join(),
  order
);

const sequentialOrder: number[] = [];
const sequential = await runGameIqScenarios({
  runId: "gameiq-test-run-sequential-default",
  modelId: "fake:sequential-default",
  teamCompositionId: "team-fake-sequential-default",
  scenarios: concurrencyScenarios,
  // concurrency omitted: must stay sequential, byte-identical to pre-B4 behavior.
  moveProvider: async ({ scenario, scenarioIndex }) => {
    sequentialOrder.push(scenarioIndex);
    return { action: scenario.expectedActions[0]?.action };
  },
});
check(
  "concurrency omitted: caseResults in scenario order (sequential default unchanged)",
  sequential.caseResults.map((r) => r.scenarioId).join() ===
    concurrencyScenarios.map((s) => s.id).join()
);
check(
  "concurrency omitted: moveProvider invoked strictly in scenario order",
  sequentialOrder.join() === concurrencyScenarios.map((_, i) => i).join(),
  sequentialOrder
);
check(
  "concurrency omitted: metrics identical to a perfect run's shape (score 100)",
  sequential.score === 100 && sequential.metrics.scoredScenarioCount === concurrencyScenarios.length,
  sequential
);

// --- battleship graded rubric (v2) ---
const bsState = bsHistory(
  [
    bsShip("battleship", { row: 4, column: 3 }, "horizontal"),
    bsShip("carrier", { row: 0, column: 0 }, "horizontal"),
    bsShip("cruiser", { row: 9, column: 6 }, "horizontal"),
    bsShip("submarine", { row: 7, column: 0 }, "horizontal"),
    bsShip("destroyer", { row: 2, column: 8 }, "horizontal"),
  ],
  ["A1", "A2", "A3", "A4", "A5", "H1", "H2", "H3", "C9", "C10", "E5", "E6"].map(bsCell)
);
const bsScenario: BattleshipGameIqScenario = {
  id: "test-bs-grade",
  gameId: "battleship",
  title: "t",
  category: "target-priority",
  difficulty: "hard",
  version: "0.1.0",
  prompt: "t",
  initialState: bsState,
  expectedActions: battleshipKeyedCells(bsState, GAMEIQ_CORRECT_QUALITY_BAR).map((r) => ({
    action: { target: r.cell },
    label: `${r.cell.row},${r.cell.column}`,
    weight: Math.round(r.ratio * 10000) / 10000,
  })),
  tags: ["test"],
};
check("bs grade: keyed argmax (E4) = 1", gradeBattleshipAction(bsScenario, { target: bsCell("E4") }) === 1);
check(
  "bs grade: non-keyed legal cell earns its sub-bar ratio (E3 = 1/3)",
  Math.abs(gradeBattleshipAction(bsScenario, { target: bsCell("E3") }) - 1 / 3) < 1e-9
);
check("bs grade: already-shot cell = 0", gradeBattleshipAction(bsScenario, { target: bsCell("E5") }) === 0);
check("bs grade: out of bounds = 0", gradeBattleshipAction(bsScenario, { target: { row: 11, column: 0 } }) === 0);
check(
  "bs grade: routed through actionMatchesExpected",
  Math.abs(actionMatchesExpected(bsScenario, { target: bsCell("E8") }) - 1 / 3) < 1e-9
);

if (failures === 0) {
  console.log("PASS");
} else {
  console.log(`FAIL ${failures} check(s) failed`);
}

process.exit(failures === 0 ? 0 : 1);
