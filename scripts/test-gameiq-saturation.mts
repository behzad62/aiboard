/* Guard test for the generated GameIQ saturation registry
 * (run: npx tsx scripts/test-gameiq-saturation.mts).
 *
 * lib/benchmark/gameiq/saturation.ts is AUTO-GENERATED (originally clean-slate
 * from the four 2026-07 reference runs, then refined by evidence-cumulative
 * pruning against fresh runs via --prior) and committed as code. On
 * 2026-07-17 the saturated v0.1 battleship/chess/connect-four packs were
 * hard-deleted, and their scenario ids were pruned from the registry by hand
 * (not regeneration): 44 ids -> 18 survivors, then 16 after codenames was dropped from the benchmark 2026-07-20 (fireworks only).
 * This test pins the invariants a future regeneration must not silently
 * break:
 *  - every id in the set is a REAL scenario id (exists in listGameIqScenarios),
 *    so renaming/removing a scenario surfaces a stale saturation entry here
 *    instead of leaking a dead id into the C2 frontier report;
 *  - the set is EXACTLY the 16-id post-prune registry (fireworks
 *    only — no battleship/chess/connect-four ids survive the hard delete).
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

const EXPECTED_SATURATION_COUNT = 16;

check("min-models constant is 3", GAMEIQ_SATURATION_MIN_MODELS === 3, {
  GAMEIQ_SATURATION_MIN_MODELS,
});

const bogus = saturatedIds.filter((id) => !realIds.has(id));
check("every saturated id is a real scenario id", bogus.length === 0, {
  bogus,
});

check(
  `saturation set has exactly ${EXPECTED_SATURATION_COUNT} ids (the post-hard-delete survivor count)`,
  saturatedIds.length === EXPECTED_SATURATION_COUNT,
  { size: saturatedIds.length, expected: EXPECTED_SATURATION_COUNT }
);

// No battleship/chess/connect-four ids survive the 2026-07-17 hard delete —
// only fireworks ids remain.
const deletedGamePrefixes = [
  "gameiq-v0.1-battleship",
  "gameiq-v0.1-chess",
  "gameiq-v0.1-connect-four",
];
const revivedDeletedIds = saturatedIds.filter((id) =>
  deletedGamePrefixes.some((prefix) => id.startsWith(prefix))
);
check(
  "no battleship/chess/connect-four ids remain in the saturation registry",
  revivedDeletedIds.length === 0,
  revivedDeletedIds
);
check(
  "every saturated id is fireworks",
  saturatedIds.every(
    (id) => id.startsWith("gameiq-fireworks-")
  ),
  saturatedIds
);

console.log(failures === 0 ? "PASS" : `FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
