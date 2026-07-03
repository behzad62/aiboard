/* Guard test for the generated GameIQ saturation registry
 * (run: npx tsx scripts/test-gameiq-saturation.mts).
 *
 * lib/benchmark/gameiq/saturation.ts is AUTO-GENERATED (from the four 2026-07
 * reference runs) and committed as code. This test pins the invariants a future
 * pack regeneration must not silently break:
 *  - every id in the set is a REAL scenario id (exists in listGameIqScenarios),
 *    so renaming/removing a scenario surfaces a stale saturation entry here
 *    instead of leaking a dead id into the C2 frontier report;
 *  - the set is non-empty and within a sane bound (the C1 collection produced
 *    108; anything outside 50-140 means the verdict collection or the registry
 *    drifted);
 *  - battleship is FULLY saturated (all 11 ids present) — the documented C2
 *    rationale for dropping battleship from the default bundle.
 */
import {
  GAMEIQ_SATURATED_SCENARIO_IDS,
  GAMEIQ_SATURATION_MIN_MODELS,
} from "../lib/benchmark/gameiq/saturation";
import { listGameIqScenarios } from "../lib/benchmark/gameiq";

let failures = 0;
function check(name: string, ok: boolean, detail?: unknown): void {
  if (!ok) failures++;
  console.log(
    `${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` -> ${JSON.stringify(detail)}`}`
  );
}

const scenarios = listGameIqScenarios();
const realIds = new Set(scenarios.map((scenario) => scenario.id));
const saturatedIds = [...GAMEIQ_SATURATED_SCENARIO_IDS];

check("min-models constant is 3", GAMEIQ_SATURATION_MIN_MODELS === 3, {
  GAMEIQ_SATURATION_MIN_MODELS,
});

const bogus = saturatedIds.filter((id) => !realIds.has(id));
check("every saturated id is a real scenario id", bogus.length === 0, {
  bogus,
});

check("saturation set is non-empty", saturatedIds.length > 0, {
  size: saturatedIds.length,
});

check(
  "saturation count within sane bound (50-140)",
  saturatedIds.length >= 50 && saturatedIds.length <= 140,
  { size: saturatedIds.length }
);

// Battleship: every battleship scenario is saturated (11/11) — documents that
// the pack has zero discrimination across the four reference models.
const battleshipIds = scenarios
  .filter((scenario) => scenario.id.startsWith("gameiq-v0.1-battleship"))
  .map((scenario) => scenario.id);
const battleshipMissing = battleshipIds.filter(
  (id) => !GAMEIQ_SATURATED_SCENARIO_IDS.has(id)
);
check(
  `all ${battleshipIds.length} battleship scenarios are saturated`,
  battleshipIds.length === 11 && battleshipMissing.length === 0,
  { total: battleshipIds.length, missing: battleshipMissing }
);

console.log(failures === 0 ? "PASS" : `FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
