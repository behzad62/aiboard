// Deterministic miner for depth-only-move Connect Four scenarios.
// Usage: npx tsx scripts/generate-gameiq-c4-depth.mts --seed 1 --want 24
import { classifyConnectFourColumns } from "../lib/benchmark/gameiq/connect-four-solver";

type Cell = "red" | "yellow" | null;
const COLS = 7;
const ROWS = 6;

function mulberry32(seed: number): () => number {
  let value = seed >>> 0;
  return () => {
    value |= 0;
    value = (value + 0x6d2b79f5) | 0;
    let t = Math.imul(value ^ (value >>> 15), 1 | value);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function emptyBoard(): Cell[][] {
  return Array.from({ length: ROWS }, () => Array<Cell>(COLS).fill(null));
}

function landing(board: Cell[][], column: number): number {
  for (let row = ROWS - 1; row >= 0; row--) {
    if (board[row][column] === null) return row;
  }
  return -1;
}

function winsAt(board: Cell[][], row: number, column: number, player: Cell): boolean {
  for (const [dr, dc] of [
    [0, 1],
    [1, 0],
    [1, 1],
    [1, -1],
  ] as const) {
    let count = 1;
    for (const sign of [1, -1] as const) {
      let r = row + dr * sign;
      let c = column + dc * sign;
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

function immediateWins(board: Cell[][], player: "red" | "yellow"): number[] {
  const out: number[] = [];
  for (let column = 0; column < COLS; column++) {
    const row = landing(board, column);
    if (row < 0) continue;
    board[row][column] = player;
    if (winsAt(board, row, column, player)) out.push(column);
    board[row][column] = null;
  }
  return out;
}

// A bait is natural-looking when it is central or creates a fresh own three.
function createsThree(board: Cell[][], column: number, player: "red" | "yellow"): boolean {
  const row = landing(board, column);
  if (row < 0) return false;
  board[row][column] = player;
  let creates = false;
  for (const [dr, dc] of [
    [0, 1],
    [1, 0],
    [1, 1],
    [1, -1],
  ] as const) {
    let count = 1;
    for (const sign of [1, -1] as const) {
      let r = row + dr * sign;
      let c = column + dc * sign;
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
    if (count === 3) creates = true;
  }
  board[row][column] = null;
  return creates;
}

interface Candidate {
  board: Cell[][];
  turn: "red" | "yellow";
  keyed: number;
  bestClass: "win" | "draw";
  baits: number[];
  discs: number;
}

function classRank(moveClass: string): number {
  return moveClass === "win" ? 2 : moveClass === "draw" ? 1 : 0;
}

function scanPosition(
  board: Cell[][],
  turn: "red" | "yellow",
  discs: number
): Candidate | null {
  if (discs < 20 || discs > 32) return null;
  const opponent = turn === "red" ? "yellow" : "red";
  if (immediateWins(board, turn).length > 0) return null;
  if (immediateWins(board, opponent).length > 0) return null;

  let classes;
  try {
    classes = classifyConnectFourColumns(board, turn);
  } catch {
    return null;
  }
  if (classes.length < 3) return null;

  const bestRank = Math.max(...classes.map((entry) => classRank(entry.moveClass)));
  if (bestRank === 0) return null;
  const best = classes.filter((entry) => classRank(entry.moveClass) === bestRank);
  if (best.length !== 1) return null;

  const baits = classes
    .filter((entry) => classRank(entry.moveClass) === bestRank - 1)
    .map((entry) => entry.column);
  if (baits.length < 2) return null;
  if (
    !baits.some(
      (column) => (column >= 2 && column <= 4) || createsThree(board, column, turn)
    )
  ) {
    return null;
  }

  return {
    board: board.map((row) => [...row]),
    turn,
    keyed: best[0].column,
    bestClass: bestRank === 2 ? "win" : "draw",
    baits,
    discs,
  };
}

function readFlag(args: string[], name: string, fallback: number): number {
  const index = args.indexOf(name);
  if (index < 0) return fallback;
  const value = Number(args[index + 1]);
  return Number.isFinite(value) ? value : fallback;
}

function stacksFor(board: Cell[][]): string[] {
  return Array.from({ length: COLS }, (_, column) => {
    let stack = "";
    for (let row = ROWS - 1; row >= 0; row--) {
      const cell = board[row][column];
      if (cell === null) break;
      stack += cell === "red" ? "R" : "Y";
    }
    return stack;
  });
}

function main(): void {
  const args = process.argv.slice(2);
  const seed = Math.floor(readFlag(args, "--seed", 1));
  const want = Math.max(1, Math.floor(readFlag(args, "--want", 24)));
  const random = mulberry32(seed);
  const found: Candidate[] = [];
  const seen = new Set<string>();
  let games = 0;

  while (found.length < want && games < 20_000) {
    games++;
    const board = emptyBoard();
    let turn: "red" | "yellow" = "red";
    let discs = 0;

    for (let ply = 0; ply < COLS * ROWS; ply++) {
      const legalColumns = Array.from({ length: COLS }, (_, column) => column).filter(
        (column) => landing(board, column) >= 0
      );
      if (legalColumns.length === 0) break;

      const weights = legalColumns.map((column) => 4 - Math.abs(3 - column) + 1);
      let pick = random * weights.reduce((sum, weight) => sum + weight, 0);
      let randomColumn = legalColumns[0];
      for (let index = 0; index < legalColumns.length; index++) {
        pick -= weights[index];
        if (pick <= 0) {
          randomColumn = legalColumns[index];
          break;
        }
      }

      const winningColumns = immediateWins(board, turn);
      const playedColumn =
        winningColumns.length > 0 && random() < 0.9
          ? winningColumns[0]
          : randomColumn;
      const row = landing(board, playedColumn);
      if (row < 0) break;
      board[row][playedColumn] = turn;
      discs++;
      if (winsAt(board, row, playedColumn, turn)) break;

      turn = turn === "red" ? "yellow" : "red";
      const candidate = scanPosition(board, turn, discs);
      if (candidate) {
        const fingerprint =
          candidate.turn + candidate.board.flat().map((cell) => cell ?? ".").join("");
        if (!seen.has(fingerprint)) {
          seen.add(fingerprint);
          found.push(candidate);
          break;
        }
      }
    }
  }

  console.log(`seed=${seed} games=${games} candidates=${found.length}`);
  for (const [index, candidate] of found.entries()) {
    console.log(
      JSON.stringify({
        index,
        turn: candidate.turn,
        discs: candidate.discs,
        keyedColumn: candidate.keyed,
        bestClass: candidate.bestClass,
        baitColumns: candidate.baits,
        stacks: stacksFor(candidate.board),
      })
    );
  }
}

main();
