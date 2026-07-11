/* Battleship v2 pack guard (run: npx tsx scripts/test-gameiq-battleship-v2-pack.mts)
 * Section 1 (this task): oracle unit rows on hand-computed states.
 * Later tasks append: independent-enumerator completeness, chain consistency,
 * de-leak, rigor floor.
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
import type { BattleshipGameState } from "../lib/games/battleship/types";

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

console.log(failures === 0 ? "PASS" : `FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
