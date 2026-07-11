/* Battleship v2 pack guard (run: npx tsx scripts/test-gameiq-battleship-v2-pack.mts)
 * Section 1 (Task 1): oracle unit rows on hand-computed states.
 * Section 2 (Task 4): INDEPENDENT-enumerator pack guard over every scenario in
 * BATTLESHIP_V2_GAMEIQ_SCENARIOS -- completeness (keyed set == independently
 * re-derived >=0.75-ratio set), a lib-oracle-vs-independent cross-check,
 * legality, hunt-chain consistency, de-leak, the first-class rigor floor, and
 * a keyed-size/ratio-tier authoring table.
 */
import {
  battleshipCellRatios,
  battleshipKeyedCells,
} from "../lib/benchmark/gameiq/battleship-oracle";
import {
  blueShotHistory,
  cell,
  shipFor,
} from "../lib/benchmark/gameiq/battleship-builders";
import { BATTLESHIP_V2_GAMEIQ_SCENARIOS } from "../lib/benchmark/gameiq/battleship-v2";
import {
  gameIqPackFirstClassFloor,
  getGameIqScenarioPackById,
} from "../lib/benchmark/gameiq/packs";
import { gameIqScenarioPrompt } from "../lib/benchmark/gameiq/certified-runner";
import { GAMEIQ_CORRECT_QUALITY_BAR } from "../lib/benchmark/gameiq/types";
import type { BattleshipGameIqScenario } from "../lib/benchmark/gameiq/types";
import {
  BATTLESHIP_BOARD_SIZE,
  fireBattleshipShot,
  isLegalBattleshipTarget,
  targetToLabel,
} from "../lib/games/battleship/engine";
import type {
  BattleshipCoordinate,
  BattleshipGameState,
  BattleshipOrientation,
} from "../lib/games/battleship/types";

let failures = 0;
function check(name: string, ok: boolean, detail?: unknown): void {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` -> ${JSON.stringify(detail)}`}`);
}
const k = (label: string) => {
  const c = cell(label);
  return `${c.row},${c.column}`;
};

// Hand-computed case: only a cruiser(3) and a battleship(4) remain (others sunk
// is impossible to author tersely, so use a 2-ship fleet is NOT allowed by
// validateBattleshipFleet — instead sink three ships explicitly).
// Board: full fleet; sink carrier(5), submarine(3), destroyer(2) with exact
// shots; leave hits E5,E6 (battleship at E4..E7 horizontal), cruiser(3) intact
// elsewhere. Unresolved hits {E5,E6}; remaining sizes multiset {4,3}.
// Placements covering E5+E6 avoiding blocked:
//   len 3: E4-E5-E6, E5-E6-E7            -> E4:1, E7:1
//   len 4: E3..E6, E4..E7, E5..E8        -> E3:1, E4:2? no — count per cell:
//     E3 in [E3..E6] only -> 1
//     E4 in [E3..E6],[E4..E7] and len3 [E4-E5-E6] -> 3
//     E7 in [E4..E7],[E5..E8] and len3 [E5-E6-E7] -> 3
//     E8 in [E5..E8] only -> 1
// total placements = 5; maxCount = 3 (E4 and E7).
// ratio: E4=1, E7=1, E3=1/3, E8=1/3.
const twoHitState = blueShotHistory(
  [
    shipFor("battleship", { row: 4, column: 3 }, "horizontal"), // E4..E7
    shipFor("carrier", { row: 0, column: 0 }, "horizontal"), // A1..A5
    shipFor("cruiser", { row: 9, column: 6 }, "horizontal"), // J7..J9 (intact)
    shipFor("submarine", { row: 7, column: 0 }, "horizontal"), // H1..H3
    shipFor("destroyer", { row: 2, column: 8 }, "horizontal"), // C9..C10
  ],
  [
    // sink carrier
    "A1", "A2", "A3", "A4", "A5",
    // sink submarine
    "H1", "H2", "H3",
    // sink destroyer
    "C9", "C10",
    // two unresolved hits on the battleship
    "E5", "E6",
  ].map(cell)
);
const ratios = battleshipCellRatios(twoHitState);
check("oracle: E4 ratio 1", Math.abs((ratios.get(k("E4"))?.ratio ?? 0) - 1) < 1e-9, ratios.get(k("E4")));
check("oracle: E7 ratio 1", Math.abs((ratios.get(k("E7"))?.ratio ?? 0) - 1) < 1e-9);
check("oracle: E3 ratio 1/3", Math.abs((ratios.get(k("E3"))?.ratio ?? 0) - 1 / 3) < 1e-9, ratios.get(k("E3")));
check("oracle: E8 ratio 1/3", Math.abs((ratios.get(k("E8"))?.ratio ?? 0) - 1 / 3) < 1e-9);
check("oracle: shot cell absent", !ratios.has(k("E5")));
check(
  "oracle: keyed at 0.75 = exactly E4,E7",
  JSON.stringify(battleshipKeyedCells(twoHitState, 0.75).map((c) => `${c.cell.row},${c.cell.column}`).sort()) ===
    JSON.stringify([k("E4"), k("E7")].sort()),
  battleshipKeyedCells(twoHitState, 0.75)
);
// multiset regression: probability of E4 must be 3/5 (five placements incl.
// BOTH the len-3 and len-4 families) — a deduped-sizes bug would change totals.
check("oracle: E4 probability 3/5", Math.abs((ratios.get(k("E4"))?.probability ?? 0) - 0.6) < 1e-9);

// --- oracle hardening: maxCount === 0 must throw loud, not return an empty
// map silently. Construct a state whose ONLY consistent placement is
// fully-hit: destroyer(2) is the sole remaining (unsunk) ship, its two cells
// (E5,E6) are both already hit, and every orthogonal extension cell around
// that pair is a miss (E4,E7,D5,D6,F5,F6). The only length-2 placement that
// covers both hits IS {E5,E6} itself, but both cells are already shot, so it
// contributes to no unshot cell's count: total=1 (a placement was found) but
// maxCount=0 (no unshot cell is coverable).
//
// This state cannot be produced by firing real shots through the engine:
// hitting BOTH cells of a size-2 ship always auto-sinks it (isShipSunk /
// fireBattleshipShot in lib/games/battleship/engine.ts), which would drop it
// from remainingSizes and resolve the hits — contradicting the "unsunk ship,
// unresolved hits" premise by construction. So this is a hand-built minimal
// BattleshipGameState object literal instead; the oracle only reads
// state.boards.orange (ships + shotsReceived), so the other 4 fleet ships
// are safely omitted rather than fabricated as sunk.
const degenerateState: BattleshipGameState = {
  boards: {
    orange: {
      ships: [
        { id: "destroyer", name: "Destroyer", size: 2, cells: [cell("E5"), cell("E6")] },
      ],
      shotsReceived: [
        { target: cell("E4"), result: "miss", timestamp: 1 },
        { target: cell("E7"), result: "miss", timestamp: 2 },
        { target: cell("D5"), result: "miss", timestamp: 3 },
        { target: cell("D6"), result: "miss", timestamp: 4 },
        { target: cell("F5"), result: "miss", timestamp: 5 },
        { target: cell("F6"), result: "miss", timestamp: 6 },
        { target: cell("E5"), result: "hit", shipId: "destroyer", timestamp: 7 },
        { target: cell("E6"), result: "hit", shipId: "destroyer", timestamp: 8 },
      ],
    },
    blue: { ships: [], shotsReceived: [] },
  },
  turn: "blue",
  status: "playing",
  winner: null,
  moveHistory: [],
};
let threwOnDegenerateMaxCount = false;
let degenerateThrowMessage = "";
try {
  battleshipCellRatios(degenerateState);
} catch (error) {
  threwOnDegenerateMaxCount = error instanceof Error;
  degenerateThrowMessage = error instanceof Error ? error.message : String(error);
}
check(
  "oracle: all-fully-hit-placements corner throws (maxCount === 0) instead of returning an empty map",
  threwOnDegenerateMaxCount &&
    degenerateThrowMessage === "battleship oracle: no unshot cell is coverable — degenerate scenario state",
  degenerateThrowMessage
);

// -----------------------------------------------------------------------------
// Section 2 (Task 4): INDEPENDENT-enumerator pack guard.
//
// Every v2 scenario's answer key comes from `battleshipKeyedCells`, which is
// itself computed by the SAME oracle this test imports above for Section 1's
// hand-computed rows. If that oracle has a bug, the pack's keys are wrong in
// a way no lib-based check can catch (self-consistently wrong -- the keys
// would agree with the buggy oracle by construction). So everything below
// re-derives the per-cell placement posterior FROM SCRATCH -- adapted from
// v1's test enumerator (analyze/placement/placementOk in
// scripts/test-gameiq-battleship-pack.mts), extended to (a) treat remaining
// ship sizes as a MULTISET (the fleet carries two size-3 ships -- cruiser AND
// submarine -- v1's `sizes` dedupes via Set, which this must not do) and (b)
// produce per-cell placement COUNTS in both target mode and hunt mode, rather
// than v1's per-archetype viable-cell sets.
//
// `battleshipCellRatios` (imported above for Section 1) is used ONLY in the
// cross-check guard below, to compare the lib oracle's output against this
// independent one -- never to COMPUTE the independent map itself.
//
// IMPORTANT: if this independent enumerator ever disagrees with the lib
// oracle on a pack scenario, that is a genuine discrepancy to diagnose (which
// side is wrong -- hand-check the smaller/simpler board), not a cue to edit
// the pack boards until the numbers happen to agree. See the plan's Task 4
// critical-nuance note (docs/superpowers/plans/2026-07-05-battleship-v2.md).
// -----------------------------------------------------------------------------

const coordKey = (c: BattleshipCoordinate) => `${c.row},${c.column}`;
const inBoundsCoord = (c: BattleshipCoordinate) =>
  c.row >= 0 &&
  c.row < BATTLESHIP_BOARD_SIZE &&
  c.column >= 0 &&
  c.column < BATTLESHIP_BOARD_SIZE;
function labelFromKey(keyStr: string): string {
  const [row, column] = keyStr.split(",").map(Number);
  return targetToLabel({ row, column });
}

interface IndependentAnalysis {
  shotAll: Set<string>;
  unresolvedHits: BattleshipCoordinate[];
  blocked: Set<string>;
  remainingSizes: number[]; // MULTISET -- duplicates (two 3s) kept, never deduped
}

function independentAnalyze(state: BattleshipGameState): IndependentAnalysis {
  const shots = state.boards.orange.shotsReceived;
  const sunkIds = new Set(
    shots.map((s) => s.sunkShipId).filter((id): id is string => typeof id === "string")
  );
  const sunkCells = new Set<string>();
  for (const ship of state.boards.orange.ships) {
    if (sunkIds.has(ship.id)) for (const c of ship.cells) sunkCells.add(coordKey(c));
  }
  const misses = new Set<string>();
  const shotAll = new Set<string>();
  const unresolvedHits: BattleshipCoordinate[] = [];
  for (const shot of shots) {
    shotAll.add(coordKey(shot.target));
    if (shot.result === "miss") {
      misses.add(coordKey(shot.target));
    } else if (!sunkCells.has(coordKey(shot.target))) {
      unresolvedHits.push({ ...shot.target });
    }
  }
  const remainingSizes = state.boards.orange.ships
    .filter((ship) => !sunkIds.has(ship.id))
    .map((ship) => ship.size);
  return {
    shotAll,
    unresolvedHits,
    blocked: new Set([...misses, ...sunkCells]),
    remainingSizes,
  };
}

function independentPlacement(
  start: BattleshipCoordinate,
  len: number,
  o: BattleshipOrientation
): BattleshipCoordinate[] {
  return Array.from({ length: len }, (_, i) =>
    o === "horizontal"
      ? { row: start.row, column: start.column + i }
      : { row: start.row + i, column: start.column }
  );
}
function independentPlacementOk(
  cells: BattleshipCoordinate[],
  blocked: Set<string>
): boolean {
  return cells.every((c) => inBoundsCoord(c) && !blocked.has(coordKey(c)));
}

interface IndependentCellStats {
  cell: BattleshipCoordinate;
  count: number;
  probability: number;
  ratio: number;
}

// Full unshot-cell posterior, independently enumerated per the oracle
// CONTRACT (docs/superpowers/plans/2026-07-05-battleship-v2.md, Task 1) --
// target mode enumerates placements covering every unresolved hit; hunt mode
// enumerates every remaining ship's placements avoiding every shot cell.
// `ratio` is relative to the best UNSHOT cell's count only: in target mode
// every valid placement covers every unresolved hit by definition, so a hit
// cell's own count always equals `total` -- including hit cells when taking
// the max would silently deflate every real (unshot) candidate's ratio.
function independentCellRatios(state: BattleshipGameState): {
  map: Map<string, IndependentCellStats>;
  total: number;
  targetMode: boolean;
} {
  const a = independentAnalyze(state);
  const targetMode = a.unresolvedHits.length > 0;
  const counts = new Map<string, number>();
  let total = 0;
  for (const len of a.remainingSizes) {
    for (const o of ["horizontal", "vertical"] as const) {
      for (let r = 0; r < BATTLESHIP_BOARD_SIZE; r++) {
        for (let c = 0; c < BATTLESHIP_BOARD_SIZE; c++) {
          const cells = independentPlacement({ row: r, column: c }, len, o);
          if (!independentPlacementOk(cells, a.blocked)) continue;
          if (targetMode) {
            if (
              !a.unresolvedHits.every((h) => cells.some((x) => coordKey(x) === coordKey(h)))
            )
              continue;
          } else if (cells.some((x) => a.shotAll.has(coordKey(x)))) {
            continue;
          }
          total++;
          for (const x of cells) {
            counts.set(coordKey(x), (counts.get(coordKey(x)) ?? 0) + 1);
          }
        }
      }
    }
  }
  let maxCount = 0;
  for (const [cellKeyStr, n] of counts) {
    if (!a.shotAll.has(cellKeyStr)) maxCount = Math.max(maxCount, n);
  }
  const map = new Map<string, IndependentCellStats>();
  for (const [cellKeyStr, n] of counts) {
    if (a.shotAll.has(cellKeyStr)) continue;
    const [row, column] = cellKeyStr.split(",").map(Number);
    map.set(cellKeyStr, {
      cell: { row, column },
      count: n,
      probability: total === 0 ? 0 : n / total,
      ratio: maxCount === 0 ? 0 : n / maxCount,
    });
  }
  return { map, total, targetMode };
}

// Self-check: the independent enumerator must reproduce Section 1's
// hand-computed twoHitState ratios before it is trusted against the pack.
{
  const { map: selfCheckMap } = independentCellRatios(twoHitState);
  const e4 = selfCheckMap.get(k("E4"));
  const e7 = selfCheckMap.get(k("E7"));
  const e3 = selfCheckMap.get(k("E3"));
  const e8 = selfCheckMap.get(k("E8"));
  check(
    "independent enumerator self-check: reproduces hand-computed twoHitState ratios (E4=1, E7=1, E3=1/3, E8=1/3)",
    !!e4 &&
      !!e7 &&
      !!e3 &&
      !!e8 &&
      Math.abs(e4.ratio - 1) < 1e-9 &&
      Math.abs(e7.ratio - 1) < 1e-9 &&
      Math.abs(e3.ratio - 1 / 3) < 1e-9 &&
      Math.abs(e8.ratio - 1 / 3) < 1e-9,
    { e4, e7, e3, e8 }
  );
}

// -----------------------------------------------------------------------------
// Guards 1-3 and 7: per-scenario completeness, lib-vs-independent cross-check,
// legality, and the keyed-size/tier authoring table. One pass over
// BATTLESHIP_V2_GAMEIQ_SCENARIOS, computing the independent map once per
// scenario and reusing it across guards.
// -----------------------------------------------------------------------------
interface TierTableRow {
  id: string;
  keyedSize: number;
  tiers: number;
}
const tierTable: TierTableRow[] = [];

for (const scenario of BATTLESHIP_V2_GAMEIQ_SCENARIOS) {
  const state = scenario.initialState as BattleshipGameState;
  const { map: indepMap } = independentCellRatios(state);

  // --- Guard 1: keyed set == independent >=0.75-ratio set (ids + count); ---
  // --- each keyed weight == independent ratio within 1e-4 (4dp rounding). ---
  const indepKeyed = [...indepMap.values()]
    .filter((r) => r.ratio >= GAMEIQ_CORRECT_QUALITY_BAR)
    .sort((x, y) => x.cell.row - y.cell.row || x.cell.column - y.cell.column);
  const indepKeyedIds = indepKeyed.map((r) => coordKey(r.cell));
  const packKeyed = [...scenario.expectedActions].sort(
    (x, y) =>
      x.action.target.row - y.action.target.row ||
      x.action.target.column - y.action.target.column
  );
  const packKeyedIds = packKeyed.map((e) => coordKey(e.action.target));
  check(
    `${scenario.id}: keyed set equals independent >=0.75-ratio unshot-cell set (ids + count)`,
    packKeyedIds.length === indepKeyedIds.length &&
      packKeyedIds.every((idStr, i) => idStr === indepKeyedIds[i]),
    { pack: packKeyedIds.map(labelFromKey), independent: indepKeyedIds.map(labelFromKey) }
  );

  const weightMismatches = packKeyed
    .map((e) => {
      const indep = indepMap.get(coordKey(e.action.target));
      const diff = indep ? Math.abs(indep.ratio - e.weight) : Number.POSITIVE_INFINITY;
      return { label: e.label, weight: e.weight, independentRatio: indep?.ratio, diff };
    })
    .filter((row) => row.diff >= 1e-4);
  check(
    `${scenario.id}: every keyed weight equals the independent ratio within 1e-4`,
    weightMismatches.length === 0,
    weightMismatches
  );

  // --- Guard 2: lib oracle vs independent counts -- exact domain, ---
  // --- probability agrees within 1e-9 (catches lib-oracle drift). ---
  const libMap = battleshipCellRatios(state);
  const libKeys = [...libMap.keys()].sort();
  const indepKeys = [...indepMap.keys()].sort();
  check(
    `${scenario.id}: lib oracle and independent enumerator agree on the unshot-cell domain`,
    libKeys.length === indepKeys.length && libKeys.every((kk, i) => kk === indepKeys[i]),
    { lib: libKeys.map(labelFromKey), independent: indepKeys.map(labelFromKey) }
  );
  const probabilityMismatches = libKeys
    .filter((kk) => indepMap.has(kk))
    .map((kk) => {
      const libStat = libMap.get(kk)!;
      const indepStat = indepMap.get(kk)!;
      return {
        cell: labelFromKey(kk),
        lib: libStat.probability,
        independent: indepStat.probability,
        diff: Math.abs(libStat.probability - indepStat.probability),
      };
    })
    .filter((row) => row.diff >= 1e-9);
  check(
    `${scenario.id}: lib oracle probability matches independent enumerator exactly (1e-9)`,
    probabilityMismatches.length === 0,
    probabilityMismatches
  );

  // --- Guard 3: legality -- no keyed cell already shot, every keyed cell ---
  // --- in bounds, shot history itself legal (no dupes, all in bounds). ---
  const shots = state.boards.orange.shotsReceived;
  const shotKeys = shots.map((s) => coordKey(s.target));
  const shotKeySet = new Set(shotKeys);
  check(
    `${scenario.id}: shot history has no duplicate targets`,
    shotKeySet.size === shotKeys.length,
    { shots: shotKeys.length, distinct: shotKeySet.size }
  );
  const outOfBoundsShots = shots.filter((s) => !inBoundsCoord(s.target));
  check(
    `${scenario.id}: every shot in the history is in bounds`,
    outOfBoundsShots.length === 0,
    outOfBoundsShots.map((s) => s.target)
  );
  const illegalKeyed = scenario.expectedActions.filter((e) => {
    const t = e.action.target;
    return (
      !inBoundsCoord(t) ||
      shotKeySet.has(coordKey(t)) ||
      !isLegalBattleshipTarget(state, state.turn, t)
    );
  });
  check(
    `${scenario.id}: every keyed cell is unshot, in bounds, and engine-legal`,
    illegalKeyed.length === 0,
    illegalKeyed.map((e) => e.label)
  );

  // --- Guard 7 (part 1): keyed-set size in [1,6]; collect the tier table. ---
  check(
    `${scenario.id}: keyed-set size is in [1,6]`,
    scenario.expectedActions.length >= 1 && scenario.expectedActions.length <= 6,
    scenario.expectedActions.length
  );
  const distinctTiers = new Set(
    [...indepMap.values()].map((r) => Math.round(r.ratio * 1e6) / 1e6)
  ).size;
  tierTable.push({
    id: scenario.id,
    keyedSize: scenario.expectedActions.length,
    tiers: distinctTiers,
  });
}

console.log("\n--- v2 battleship keyed-size / ratio-tier table (authoring feedback) ---");
for (const row of tierTable) {
  console.log(`  ${row.id.padEnd(52)} keyed=${row.keyedSize}  tiers=${row.tiers}`);
}
console.log("");

// --- Guard 7 (part 2): at least 8 scenarios discriminate (>=2 ratio tiers). ---
const multiTierScenarios = tierTable.filter((row) => row.tiers >= 2).length;
check(
  "at least 8 of the pack's scenarios have >=2 distinct ratio tiers among unshot cells",
  multiTierScenarios >= 8,
  { multiTierScenarios, total: tierTable.length }
);

// -----------------------------------------------------------------------------
// Guard 4: hunt-chain consistency. For hunt<N>-s<k+1>: its shot list is
// s<k>'s + exactly one cell; that cell is a ratio-1 cell of s<k>'s
// INDEPENDENT map; and its recorded hit/miss/sunk result matches engine truth
// for the seeded fleet (re-fired through the real battleship engine against
// s<k>'s own raw, unredacted ships -- independent of the oracle, which is the
// thing under guard here; the game-rules engine is a separate, already-real
// codepath, not the placement-probability model this file exists to check).
// -----------------------------------------------------------------------------
const chainScenarios = BATTLESHIP_V2_GAMEIQ_SCENARIOS.filter((s) =>
  s.tags.includes("hunt-chain")
);
const chainGroups = new Map<string, BattleshipGameIqScenario[]>();
for (const scenario of chainScenarios) {
  const m = /^(.*)-s(\d+)$/.exec(scenario.id);
  if (!m) {
    check(`${scenario.id}: chain scenario id matches <prefix>-sN`, false);
    continue;
  }
  const prefix = m[1];
  const group = chainGroups.get(prefix) ?? [];
  group.push(scenario);
  chainGroups.set(prefix, group);
}
check(
  "exactly 2 hunt chains of 4 states each",
  chainGroups.size === 2 && [...chainGroups.values()].every((g) => g.length === 4),
  [...chainGroups.entries()].map(([prefix, g]) => [prefix, g.length])
);

function chainStep(id: string): number {
  return Number(/-s(\d+)$/.exec(id)![1]);
}
for (const [, group] of chainGroups) {
  const sorted = [...group].sort((a, b) => chainStep(a.id) - chainStep(b.id));
  for (let i = 0; i + 1 < sorted.length; i++) {
    const sK = sorted[i];
    const sK1 = sorted[i + 1];
    const stateK = sK.initialState as BattleshipGameState;
    const stateK1 = sK1.initialState as BattleshipGameState;
    const shotsK = stateK.boards.orange.shotsReceived;
    const shotsK1 = stateK1.boards.orange.shotsReceived;

    const isPrefixExtension =
      shotsK1.length === shotsK.length + 1 &&
      shotsK.every((s, idx) => coordKey(s.target) === coordKey(shotsK1[idx].target));
    check(
      `${sK1.id}: shot list equals ${sK.id}'s + exactly one cell`,
      isPrefixExtension,
      { prevLen: shotsK.length, nextLen: shotsK1.length }
    );
    if (!isPrefixExtension) continue;

    const newShot = shotsK1[shotsK.length];
    const newCell = newShot.target;

    const { map: indepMapK } = independentCellRatios(stateK);
    const newCellStat = indepMapK.get(coordKey(newCell));
    check(
      `${sK1.id}: new shot ${targetToLabel(newCell)} is a ratio-1 cell of ${sK.id}'s independent map`,
      newCellStat !== undefined && Math.abs(newCellStat.ratio - 1) < 1e-9,
      newCellStat
    );

    let engineTruth: { result: string; sunkShipId?: string } | { error: string };
    try {
      const fired = fireBattleshipShot({ ...stateK, turn: "blue" }, newCell, 999999);
      const lastShot =
        fired.boards.orange.shotsReceived[fired.boards.orange.shotsReceived.length - 1];
      engineTruth = { result: lastShot.result, sunkShipId: lastShot.sunkShipId };
    } catch (error) {
      engineTruth = { error: error instanceof Error ? error.message : String(error) };
    }
    check(
      `${sK1.id}: recorded result at ${targetToLabel(newCell)} matches engine truth for the seeded fleet`,
      "result" in engineTruth &&
        engineTruth.result === newShot.result &&
        engineTruth.sunkShipId === newShot.sunkShipId,
      { recorded: { result: newShot.result, sunkShipId: newShot.sunkShipId }, engineTruth }
    );
  }
}

// -----------------------------------------------------------------------------
// Guard 5: de-leak. Every v2 scenario shares the same generic instruction
// (never board-specific), and neither the title nor the fully assembled
// model-facing prompt (instruction + rules + redacted state JSON + shape
// example, via gameIqScenarioPrompt) ever names one of ITS OWN keyed cells.
// -----------------------------------------------------------------------------
const SHARED_HUNT_PROMPT =
  "You are firing at the hidden enemy fleet. Choose the single best next target cell.";
BATTLESHIP_V2_GAMEIQ_SCENARIOS.forEach((scenario, index) => {
  check(
    `${scenario.id}: prompt is the shared generic hunt instruction (never board-specific)`,
    scenario.prompt === SHARED_HUNT_PROMPT,
    scenario.prompt
  );
  const keyedLabels = scenario.expectedActions.map((e) => e.label);
  const assembledPrompt = gameIqScenarioPrompt(
    scenario,
    index,
    BATTLESHIP_V2_GAMEIQ_SCENARIOS.length
  );
  const titleLeaks = keyedLabels.filter((label) => new RegExp(`\\b${label}\\b`).test(scenario.title));
  const promptLeaks = keyedLabels.filter((label) => new RegExp(`\\b${label}\\b`).test(assembledPrompt));
  check(`${scenario.id}: title never names a keyed cell label`, titleLeaks.length === 0, titleLeaks);
  check(
    `${scenario.id}: assembled model prompt never names a keyed cell label`,
    promptLeaks.length === 0,
    promptLeaks
  );
});

// -----------------------------------------------------------------------------
// Guard 6: the pack passes the mechanical first-class rigor floor (>=10
// distinct decisions; no constant answer scores correct on >=50%).
// -----------------------------------------------------------------------------
const v2Pack = getGameIqScenarioPackById("gameiq-v0.2-battleship");
if (!v2Pack) {
  check("gameiq-v0.2-battleship pack is registered", false);
} else {
  const floor = gameIqPackFirstClassFloor(v2Pack);
  check(
    "gameiq-v0.2-battleship pack passes the mechanical first-class rigor floor",
    floor.ok,
    floor
  );
}

console.log(failures === 0 ? "PASS" : `FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
