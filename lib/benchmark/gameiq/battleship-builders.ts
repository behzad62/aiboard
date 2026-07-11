import {
  BATTLESHIP_FLEET,
  createBattleshipShip,
  createBattleshipStateWithBoards,
  fireBattleshipShot,
  targetToLabel,
} from "@/lib/games/battleship/engine";
import type {
  BattleshipCoordinate,
  BattleshipGameState,
  BattleshipOrientation,
  BattleshipPlayerBoard,
  BattleshipShip,
} from "@/lib/games/battleship/types";
import type { BattleshipGameIqAction } from "./types";

// -----------------------------------------------------------------------------
// Shared Battleship GameIQ builders — state/fleet construction helpers used by
// both the v1 pack (battleship.ts) and the v2 oracle-graded pack. Extracted
// verbatim from battleship.ts so both packs build engine-true states the same
// way; no behavior change.
// -----------------------------------------------------------------------------

export type ExpectedAction = {
  action: BattleshipGameIqAction;
  label: string;
  weight: number;
  note?: string;
};

export function shipFor(
  id: string,
  start: BattleshipCoordinate,
  orientation: BattleshipOrientation
): BattleshipShip {
  const definition = BATTLESHIP_FLEET.find((ship) => ship.id === id);
  if (!definition) throw new Error(`Unknown ship id: ${id}`);
  return createBattleshipShip(definition, start, orientation);
}

export function orangeBoard(ships: BattleshipShip[]): BattleshipPlayerBoard {
  return { ships, shotsReceived: [] };
}

// A valid, fixed Blue fleet. Blue's board is never fired upon in these
// scenarios (Blue is always the mover), so its placement is irrelevant to the
// model view; it exists only to satisfy fleet validation.
export function blueBoard(): BattleshipPlayerBoard {
  return orangeBoard([
    shipFor("carrier", { row: 0, column: 0 }, "horizontal"),
    shipFor("battleship", { row: 2, column: 0 }, "horizontal"),
    shipFor("cruiser", { row: 4, column: 0 }, "horizontal"),
    shipFor("submarine", { row: 6, column: 0 }, "horizontal"),
    shipFor("destroyer", { row: 8, column: 0 }, "horizontal"),
  ]);
}

// Fire an ordered list of Blue shots against the given Orange fleet, keeping the
// turn on Blue between shots so the whole history accrues to one player's view.
export function blueShotHistory(
  orangeShips: BattleshipShip[],
  shots: BattleshipCoordinate[]
): BattleshipGameState {
  let state = createBattleshipStateWithBoards(blueBoard(), orangeBoard(orangeShips));
  let timestamp = 1;
  for (const shot of shots) {
    const next = fireBattleshipShot({ ...state, turn: "blue" }, shot, timestamp++);
    state = { ...next, turn: "blue" as const };
  }
  return state;
}

export function cell(label: string): BattleshipCoordinate {
  const match = /^([A-J])(10|[1-9])$/.exec(label);
  if (!match) throw new Error(`Bad label: ${label}`);
  return {
    row: "ABCDEFGHIJ".indexOf(match[1]),
    column: Number(match[2]) - 1,
  };
}

export function target(label: string, weight = 1, note?: string): ExpectedAction {
  const coordinate = cell(label);
  return {
    action: { target: coordinate },
    label: targetToLabel(coordinate),
    weight,
    note,
  };
}
