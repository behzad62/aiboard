import { BATTLESHIP_BOARD_SIZE } from "@/lib/games/battleship/engine";
import type {
  BattleshipCoordinate,
  BattleshipGameState,
  BattleshipOrientation,
} from "@/lib/games/battleship/types";

export interface BattleshipCellRatio {
  cell: BattleshipCoordinate;
  /** covering placements / total placements */
  probability: number;
  /** covering placements / best cell's covering placements */
  ratio: number;
}

const keyOf = (c: BattleshipCoordinate) => `${c.row},${c.column}`;
const inBounds = (c: BattleshipCoordinate) =>
  c.row >= 0 && c.row < BATTLESHIP_BOARD_SIZE && c.column >= 0 && c.column < BATTLESHIP_BOARD_SIZE;

function straight(
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

// Per-cell posterior over remaining-ship placements, derived from the FULL
// state (Orange is the target board, as in every v1 scenario).
// - remainingSizes is a MULTISET (the fleet carries two size-3 ships).
// - Target mode (unresolved hits exist): single-cluster convention — every
//   placement must cover ALL unresolved hits; authoring guarantees the hits
//   belong to one ship. Zero placements => authoring bug => throw.
// - Hunt mode: placements avoid every shot cell.
export function battleshipCellRatios(
  state: BattleshipGameState
): Map<string, BattleshipCellRatio> {
  const shots = state.boards.orange.shotsReceived;
  const sunkIds = new Set(
    shots.map((s) => s.sunkShipId).filter((id): id is string => typeof id === "string")
  );
  const sunkCells = new Set<string>();
  for (const ship of state.boards.orange.ships) {
    if (sunkIds.has(ship.id)) for (const c of ship.cells) sunkCells.add(keyOf(c));
  }
  const misses = new Set<string>();
  const shotAll = new Set<string>();
  const unresolvedHits: BattleshipCoordinate[] = [];
  for (const s of shots) {
    shotAll.add(keyOf(s.target));
    if (s.result === "miss") misses.add(keyOf(s.target));
    else if (!sunkCells.has(keyOf(s.target))) unresolvedHits.push({ ...s.target });
  }
  const blocked = new Set([...misses, ...sunkCells]);
  const remainingSizes = state.boards.orange.ships
    .filter((ship) => !sunkIds.has(ship.id))
    .map((ship) => ship.size); // multiset — do NOT dedupe

  const targetMode = unresolvedHits.length > 0;
  const counts = new Map<string, number>();
  let total = 0;
  for (const len of remainingSizes) {
    for (const o of ["horizontal", "vertical"] as const) {
      for (let r = 0; r < BATTLESHIP_BOARD_SIZE; r++) {
        for (let c = 0; c < BATTLESHIP_BOARD_SIZE; c++) {
          const cells = straight({ row: r, column: c }, len, o);
          if (!cells.every((x) => inBounds(x) && !blocked.has(keyOf(x)))) continue;
          if (targetMode) {
            if (!unresolvedHits.every((h) => cells.some((x) => keyOf(x) === keyOf(h)))) continue;
          } else if (cells.some((x) => shotAll.has(keyOf(x)))) {
            continue;
          }
          // A target-mode placement lying entirely on the unresolved hits (fully-hit, contradicting not-sunk) still counts here toward `total` — making `probability` slightly conservative — but covers no unshot cell, so `ratio` (what keys/grading use) is unaffected.
          total++;
          for (const x of cells) counts.set(keyOf(x), (counts.get(keyOf(x)) ?? 0) + 1);
        }
      }
    }
  }
  if (total === 0) {
    throw new Error(
      "battleship oracle: zero consistent placements — degenerate scenario state"
    );
  }
  let maxCount = 0;
  for (const [cellKey, n] of counts) {
    if (!shotAll.has(cellKey)) maxCount = Math.max(maxCount, n);
  }
  if (maxCount === 0) {
    throw new Error(
      "battleship oracle: no unshot cell is coverable — degenerate scenario state"
    );
  }
  const out = new Map<string, BattleshipCellRatio>();
  for (const [cellKey, n] of counts) {
    if (shotAll.has(cellKey)) continue; // only unshot cells are targets
    const [row, column] = cellKey.split(",").map(Number);
    out.set(cellKey, {
      cell: { row, column },
      probability: n / total,
      ratio: n / maxCount,
    });
  }
  return out;
}

/** Unshot cells whose ratio clears the bar, sorted (row, then column). */
export function battleshipKeyedCells(
  state: BattleshipGameState,
  bar: number
): BattleshipCellRatio[] {
  return [...battleshipCellRatios(state).values()]
    .filter((r) => r.ratio >= bar)
    .sort((a, b) => a.cell.row - b.cell.row || a.cell.column - b.cell.column);
}
