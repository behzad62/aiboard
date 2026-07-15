// Exact classification of every legal Connect Four column as win/draw/loss
// for the side to move under optimal play. This module intentionally does not
// import the game engine: gravity/orientation and winning lines are derived
// independently so pack guards can compare two implementations.

export type ConnectFourMoveClass = "win" | "draw" | "loss";

export interface ConnectFourColumnClass {
  column: number;
  moveClass: ConnectFourMoveClass;
}

type Cell = "red" | "yellow" | null;

const COLS = 7;
const ROWS = 6;
const ORDER = [3, 2, 4, 1, 5, 0, 6];

function bit(column: number, height: number): bigint {
  return BigInt(1) << BigInt(column * 7 + height);
}

function hasWon(bitboard: bigint): boolean {
  for (const shift of [BigInt(1), BigInt(7), BigInt(6), BigInt(8)]) {
    const pairs = bitboard & (bitboard >> shift);
    if ((pairs & (pairs >> (BigInt(2) * shift))) !== BigInt(0)) return true;
  }
  return false;
}

// Rows may be stored top-first or bottom-first. A partially-filled column
// provides the orientation signal; an empty/full board cannot be inferred.
export function detectBottomRow(board: Cell[][]): 0 | 5 {
  let bottomIsFive = false;
  let bottomIsZero = false;
  for (let column = 0; column < COLS; column++) {
    const cells = board.map((row) => row[column]);
    const count = cells.filter((cell) => cell !== null).length;
    if (count === 0 || count === ROWS) continue;

    const contiguousFromEnd =
      cells.slice(ROWS - count).every((cell) => cell !== null) &&
      cells.slice(0, ROWS - count).every((cell) => cell === null);
    const contiguousFromStart =
      cells.slice(0, count).every((cell) => cell !== null) &&
      cells.slice(count).every((cell) => cell === null);

    if (contiguousFromEnd && !contiguousFromStart) bottomIsFive = true;
    else if (contiguousFromStart && !contiguousFromEnd) bottomIsZero = true;
    else if (!contiguousFromEnd && !contiguousFromStart) {
      throw new Error(`connect-four solver: column ${column} has floating discs`);
    }
  }

  if (bottomIsFive && bottomIsZero) {
    throw new Error("connect-four solver: inconsistent gravity across columns");
  }
  if (!bottomIsFive && !bottomIsZero) {
    throw new Error(
      "connect-four solver: cannot detect gravity (board empty or all columns full/empty)"
    );
  }
  return bottomIsFive ? 5 : 0;
}

interface BitPosition {
  current: bigint;
  other: bigint;
  heights: number[];
  discs: number;
}

export function toBitPosition(
  board: Cell[][],
  turn: "red" | "yellow"
): BitPosition {
  const bottom = detectBottomRow(board);
  let current = BigInt(0);
  let other = BigInt(0);
  const heights = new Array<number>(COLS).fill(0);
  let discs = 0;

  for (let column = 0; column < COLS; column++) {
    for (let height = 0; height < ROWS; height++) {
      const row = bottom === 5 ? 5 - height : height;
      const cell = board[row][column];
      if (cell === null) break;
      if (cell === turn) current |= bit(column, height);
      else other |= bit(column, height);
      heights[column] = height + 1;
      discs++;
    }
  }

  return { current, other, heights, discs };
}

function solve(
  current: bigint,
  other: bigint,
  heights: number[],
  empties: number,
  memo: Map<bigint, number>
): number {
  for (const column of ORDER) {
    if (heights[column] >= ROWS) continue;
    if (hasWon(current | bit(column, heights[column]))) return 1;
  }
  if (empties === 0) return 0;

  const key = (current << BigInt(49)) | current | other;
  const cached = memo.get(key);
  if (cached !== undefined) return cached;

  let best = -1;
  for (const column of ORDER) {
    if (heights[column] >= ROWS) continue;
    const moved = current | bit(column, heights[column]);
    let value: number;
    if (empties - 1 === 0) {
      value = 0;
    } else {
      heights[column]++;
      value = -solve(other, moved, heights, empties - 1, memo);
      heights[column]--;
    }
    if (value > best) best = value;
    if (best === 1) break;
  }

  memo.set(key, best);
  return best;
}

export function classifyConnectFourColumns(
  board: Cell[][],
  turn: "red" | "yellow"
): ConnectFourColumnClass[] {
  const position = toBitPosition(board, turn);
  if (hasWon(position.current) || hasWon(position.other)) {
    throw new Error("connect-four solver: game is already over");
  }

  const memo = new Map<bigint, number>();
  const out: ConnectFourColumnClass[] = [];
  for (let column = 0; column < COLS; column++) {
    if (position.heights[column] >= ROWS) continue;
    const moved = position.current | bit(column, position.heights[column]);
    let moveClass: ConnectFourMoveClass;
    if (hasWon(moved)) {
      moveClass = "win";
    } else if (position.discs + 1 === COLS * ROWS) {
      moveClass = "draw";
    } else {
      position.heights[column]++;
      const value = -solve(
        position.other,
        moved,
        position.heights,
        COLS * ROWS - position.discs - 1,
        memo
      );
      position.heights[column]--;
      moveClass = value === 1 ? "win" : value === 0 ? "draw" : "loss";
    }
    out.push({ column, moveClass });
  }
  return out;
}
