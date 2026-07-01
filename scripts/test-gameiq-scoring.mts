/* Certified GameIQ v0.1 scoring runner checks (run: npx tsx scripts/test-gameiq-scoring.mts) */
import {
  getGameIqScenarioPack,
  listGameIqScenarios,
  runGameIqScenarios,
  type GameIqMoveProvider,
  type GameIqScenario,
} from "../lib/benchmark/gameiq";

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
    perfect.attempt.scoringVersion === "certified-gameiq-v0.1",
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
    invalid.attempt.status === "failed_model",
  { metrics: invalid.metrics, attempt: invalid.attempt }
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
  const alternateLegalClue = await runGameIqScenarios({
    runId: "gameiq-test-run-codenames-alternate-legal-clue",
    modelId: "fake:codenames",
    teamCompositionId: "team-fake-codenames",
    scenarios: [codenamesScenario],
    moveProvider: () => ({
      action: {
        type: "clue",
        clue: { word: "PLANET", count: 2 },
        cardId: null,
      },
      rawResponse: JSON.stringify({
        action: {
          type: "clue",
          clue: { word: "PLANET", count: 2 },
          cardId: null,
        },
      }),
      latencyMs: 0,
    }),
  });

  check(
    "Codenames clue-selection scores alternate legal clues behaviorally",
    alternateLegalClue.metrics.structuredReliability === 1 &&
      alternateLegalClue.metrics.legalActionRate === 1 &&
      alternateLegalClue.metrics.outcomeScore === 1 &&
      alternateLegalClue.metrics.moveQuality === 1 &&
      alternateLegalClue.attempt.status === "passed",
    alternateLegalClue
  );
}

if (failures === 0) {
  console.log("PASS");
} else {
  console.log(`FAIL ${failures} check(s) failed`);
}

process.exit(failures === 0 ? 0 : 1);
