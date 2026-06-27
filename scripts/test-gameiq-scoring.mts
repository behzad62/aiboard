/* Certified GameIQ v0.1 scoring runner checks (run: npx tsx scripts/test-gameiq-scoring.mts) */
import {
  getGameIqScenarioPack,
  listGameIqScenarios,
  runGameIqScenarios,
  type GameIqMoveProvider,
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

if (failures === 0) {
  console.log("PASS");
} else {
  console.log(`FAIL ${failures} check(s) failed`);
}

process.exit(failures === 0 ? 0 : 1);
