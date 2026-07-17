// Independent reference classifier for Connect Four positions.
// Deliberately uses plain arrays and string memoization rather than the
// production solver's bitboards. It is intentionally kept in scripts/ so pack
// guards cannot verify the oracle with the same implementation.

type Cell = "red" | "yellow" | null;
export type RefClass = "win" | "draw" | "loss";

const COLS = 7;
const ROWS = 6;

function landingRow(board: Cell[][], col: number, bottom: 0 | 5): number {
  const step = bottom === 5 ? -1 : 1;
  for (let row = bottom; row >= 0 && row < ROWS; row += step) {
    if (board[row][col] === null) return row;
  }
  return -1;
}

function winsAt(board: Cell[][], row: number, col: number, player: Cell): boolean {
  const directions = [
    [0, 1],
    [1, 0],
    [1, 1],
    [1, -1],
  ] as const;
  for (const [dr, dc] of directions) {
    let count = 1;
    for (const sign of [1, -1] as const) {
      let r = row + dr * sign;
      let c = col + dc * sign;
      while (
        r >= 0 &&
        r < ROWS &&
        c >= 0 &&
        c < COLS &&
        board[r][c] === player
      ) {
        count++;
        r += dr * sign;
        c += dc * sign;
      }
    }
    if (count >= 4) return true;
  }
  return false;
}

function solveRef(
  board: Cell[][],
  turn: "red" | "yellow",
  bottom: 0 | 5,
  memo: Map<string, number>
): number {
  const key =
    turn + board.flat().map((cell) => (cell === null ? "." : cell === "red" ? "r" : "y")).join("");
  const hit = memo.get(key);
  if (hit !== undefined) return hit;

  const opponent = turn === "red" ? "yellow" : "red";
  let sawMove = false;
  let best = -1;
  for (let col = 0; col < COLS; col++) {
    const row = landingRow(board, col, bottom);
    if (row < 0) continue;
    sawMove = true;
    board[row][col] = turn;
    const value = winsAt(board, row, col, turn)
      ? 1
      : -solveRef(board, opponent, bottom, memo);
    board[row][col] = null;
    if (value > best) best = value;
    if (best === 1) break;
  }

  const result = sawMove ? best : 0;
  memo.set(key, result);
  return result;
}

export function referenceClassify(
  boardIn: Cell[][],
  turn: "red" | "yellow",
  bottom: 0 | 5
): { column: number; moveClass: RefClass }[] {
  const board = boardIn.map((row) => [...row]);
  const memo = new Map<string, number>();
  const out: { column: number; moveClass: RefClass }[] = [];
  for (let col = 0; col < COLS; col++) {
    const row = landingRow(board, col, bottom);
    if (row < 0) continue;
    board[row][col] = turn;
    const value = winsAt(board, row, col, turn)
      ? 1
      : -solveRef(board, turn === "red" ? "yellow" : "red", bottom, memo);
    board[row][col] = null;
    out.push({
      column: col,
      moveClass: value === 1 ? "win" : value === 0 ? "draw" : "loss",
    });
  }
  return out;
}
