/* Certified GameIQ v0.1 scoring runner checks (run: npx tsx scripts/test-gameiq-scoring.mts) */
import {
  getGameIqScenarioPack,
  listGameIqScenarios,
  runGameIqScenarios,
  type GameIqMoveProvider,
  type GameIqScenario,
} from "../lib/benchmark/gameiq";
import { gradeFireworksAction } from "../lib/benchmark/gameiq/validation";
import {
  GAMEIQ_CORRECT_QUALITY_BAR,
  GAMEIQ_SCORING_VERSION,
} from "../lib/benchmark/gameiq/types";
import { scoreGameIqAttempt } from "../lib/benchmark/scoring/gameiq";

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
const hard27 = scenarios.find((s) => s.id === "gameiq-fireworks-hard-v1-27");
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

// Regression guard for the forbidden-action probe interaction bug: the probe
// constructed by matchesForbiddenAction (runner.ts) must clear the scenario's
// own forbiddenActions, or the graded fireworks path would check the
// (still-present) forbidden list FIRST and return 0, making the probe
// misreport "not forbidden" and silently breaking trap detection.
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
    "forbidden-action probe still detects the trap under graded fireworks scoring",
    forbiddenCaseResult?.forbiddenBlunder === true &&
      forbiddenCaseResult.actionQuality === 0,
    forbiddenCaseResult
  );
}

if (failures === 0) {
  console.log("PASS");
} else {
  console.log(`FAIL ${failures} check(s) failed`);
}

process.exit(failures === 0 ? 0 : 1);
