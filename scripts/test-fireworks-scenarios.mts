/* Fireworks scenario checks (run: npx tsx scripts/test-fireworks-scenarios.mts) */
import {
  FIREWORKS_FULL_GAME_CASES,
  FIREWORKS_MEMORY_SCENARIOS,
  FIREWORKS_TACTICS_SCENARIOS,
  scoreFireworksScenarioAction,
  stableFireworksScenarioPackDigest,
} from "../lib/benchmark/fireworks/scenario-packs";
import { getLegalFireworksActions } from "../lib/games/fireworks/engine";

let failures = 0;

function check(name: string, ok: boolean, detail?: unknown): void {
  if (!ok) failures++;
  console.log(
    `${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` -> ${JSON.stringify(detail)}`}`
  );
}

const scenarios = [...FIREWORKS_TACTICS_SCENARIOS, ...FIREWORKS_MEMORY_SCENARIOS];
const scenarioIds = scenarios.map((scenario) => scenario.id);

check(
  "Fireworks v0.1 corpus has 60 tactics, 40 memory, and 20 full-game cases",
  FIREWORKS_TACTICS_SCENARIOS.length === 60 &&
    FIREWORKS_MEMORY_SCENARIOS.length === 40 &&
    FIREWORKS_FULL_GAME_CASES.length === 20,
  {
    tactics: FIREWORKS_TACTICS_SCENARIOS.length,
    memory: FIREWORKS_MEMORY_SCENARIOS.length,
    full: FIREWORKS_FULL_GAME_CASES.length,
  }
);
check(
  "scenario IDs are unique",
  new Set(scenarioIds).size === scenarioIds.length,
  scenarioIds.filter((id, index) => scenarioIds.indexOf(id) !== index)
);
check(
  "every expected scenario action is legal",
  scenarios.every((scenario) => {
    const legal = getLegalFireworksActions(scenario.state, scenario.actingPlayerId);
    return scenario.expectedActions.every((expected) =>
      legal.some(
        (action) =>
          scoreFireworksScenarioAction(scenario, action) >= expected.weight
      )
    );
  }),
  scenarios.map((scenario) => scenario.id)
);
check(
  "forbidden actions score zero",
  scenarios.every((scenario) =>
    (scenario.forbiddenActions ?? []).every(
      (action) => scoreFireworksScenarioAction(scenario, action) === 0
    )
  ),
  scenarios.map((scenario) => scenario.id)
);

const firstDigest = stableFireworksScenarioPackDigest({
  id: "fireworks-combined-v0.1",
  scenarios,
  fullGames: FIREWORKS_FULL_GAME_CASES,
});
const secondDigest = stableFireworksScenarioPackDigest({
  id: "fireworks-combined-v0.1",
  scenarios,
  fullGames: FIREWORKS_FULL_GAME_CASES,
});
check(
  "scenario pack digest is stable",
  firstDigest === secondDigest && firstDigest.startsWith("fireworks-v0.1:"),
  { firstDigest, secondDigest }
);

if (failures === 0) {
  console.log("PASS");
} else {
  console.log(`FAIL ${failures} check(s) failed`);
}

process.exit(failures === 0 ? 0 : 1);
