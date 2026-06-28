/* Fireworks calibration bot checks (run: npx tsx scripts/test-fireworks-calibration-bots.mts) */
import {
  FIREWORKS_CALIBRATION_BOTS,
  runFireworksCalibrationBots,
} from "../lib/benchmark/fireworks/calibration-bots";
import { FIREWORKS_FULL_GAME_CASES } from "../lib/benchmark/fireworks/scenario-packs";

let failures = 0;

function check(name: string, ok: boolean, detail?: unknown): void {
  if (!ok) failures++;
  console.log(
    `${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` -> ${JSON.stringify(detail)}`}`
  );
}

check(
  "Fireworks calibration bots cover expected behavior profiles",
  ["random_legal", "always_discard", "safe_clue", "greedy_playable", "forgetful"].every(
    (id) => FIREWORKS_CALIBRATION_BOTS.some((bot) => bot.id === id)
  ),
  FIREWORKS_CALIBRATION_BOTS.map((bot) => bot.id)
);

const calibration = runFireworksCalibrationBots({
  cases: FIREWORKS_FULL_GAME_CASES.filter((benchmarkCase) => benchmarkCase.playerCount === 2)
    .slice(0, 2),
  playerCount: 2,
  maxTurns: 20,
});
check(
  "Fireworks calibration bots produce deterministic ranked scores",
  calibration.length === FIREWORKS_CALIBRATION_BOTS.length &&
    calibration.every((row) => row.caseCount === 2) &&
    JSON.stringify(calibration) ===
      JSON.stringify(
        runFireworksCalibrationBots({
          cases: FIREWORKS_FULL_GAME_CASES.filter(
            (benchmarkCase) => benchmarkCase.playerCount === 2
          ).slice(0, 2),
          playerCount: 2,
          maxTurns: 20,
        })
      ),
  calibration
);

const byId = new Map(calibration.map((row) => [row.botId, row]));
check(
  "greedy playable and safe clue baselines beat always discard",
  (byId.get("greedy_playable")?.averageScore ?? 0) >
    (byId.get("always_discard")?.averageScore ?? 0) &&
    (byId.get("safe_clue")?.averageScore ?? 0) >
      (byId.get("always_discard")?.averageScore ?? 0),
  Object.fromEntries(byId)
);

check(
  "forgetful baseline records model-quality penalties",
  (byId.get("forgetful")?.averageBadPlays ?? 0) > 0 ||
    (byId.get("forgetful")?.averageCriticalDiscards ?? 0) > 0,
  byId.get("forgetful")
);

if (failures === 0) {
  console.log("PASS");
} else {
  console.log(`FAIL ${failures} check(s) failed`);
}

process.exit(failures === 0 ? 0 : 1);
