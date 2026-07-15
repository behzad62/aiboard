import type {
  ConnectFourGameIqAction,
  ConnectFourGameIqScenario,
} from "./types";
import type {
  ConnectFourBoard,
  ConnectFourGameState,
  ConnectFourPlayer,
} from "@/lib/games/connect-four/types";

// Generated from deterministic miner seeds 1, 2, 3, 4, and 6 (with --want 24
// for seed 1 and --want 6 for the remaining seeds). Candidates were sorted by
// disc count and alternated while selecting to cap each keyed column at three,
// represent both movers at least four times, and retain solver win/draw/loss
// grading rows. Never hand-edit these boards or keyed columns: re-mine and run
// scripts/test-gameiq-c4-v2-pack.mts instead.

const EMPTY_CLOCK = {
  redElapsedMs: 0,
  yellowElapsedMs: 0,
  turnStartedAt: 0,
};

type Stacks = Array<Array<ConnectFourPlayer>>;

function boardFromStacks(columns: Stacks): ConnectFourBoard {
  const board = Array.from({ length: 6 }, () =>
    Array.from({ length: 7 }, () => null)
  ) as ConnectFourBoard;
  for (let column = 0; column < 7; column++) {
    const stack = columns[column] ?? [];
    for (let height = 0; height < stack.length; height++) {
      board[5 - height][column] = stack[height];
    }
  }
  return board;
}

function state(
  board: ConnectFourBoard,
  turn: ConnectFourPlayer
): ConnectFourGameState {
  return {
    board,
    turn,
    status: "playing",
    winner: null,
    moveHistory: [],
    clock: EMPTY_CLOCK,
  };
}

function expected(
  columns: number[],
  note: string
): Array<{
  action: ConnectFourGameIqAction;
  label: string;
  weight: number;
  note?: string;
}> {
  return columns.map((column) => ({
    action: { column },
    label: `Column ${column + 1}`,
    weight: 1,
    note,
  }));
}

function neutralPrompt(player: ConnectFourPlayer): string {
  return `It is ${player}'s turn. Return the column index of the single best move.`;
}

function stacks(columns: string[]): Stacks {
  return columns.map((column) =>
    [...column].map((disc) => (disc === "R" ? "red" : "yellow"))
  );
}

function scenario(
  depth: number,
  player: ConnectFourPlayer,
  columns: string[],
  keyedColumn: number
): ConnectFourGameIqScenario {
  return {
    id: `gameiq-v0.2-connect-four-depth-${depth}`,
    gameId: "connect-four",
    title: `Connect Four depth ${depth}`,
    category: "depth-only-move",
    difficulty: "hard",
    version: "0.1.0",
    prompt: neutralPrompt(player),
    initialState: state(boardFromStacks(stacks(columns)), player),
    expectedActions: expected([keyedColumn], "solver: only class-preserving column"),
    tags: ["connect-four", "depth", "solver-keyed"],
  };
}

export const CONNECT_FOUR_V2_GAMEIQ_SCENARIOS: ConnectFourGameIqScenario[] = [
  scenario(1, "red", ["RY", "Y", "Y", "RYRYRY", "YRRY", "RRYRY", "R"], 2),
  scenario(2, "red", ["", "YR", "Y", "RRYRYR", "RYRRYR", "Y", "YRYY"], 0),
  scenario(3, "yellow", ["RY", "YYR", "RYRY", "YRYRYR", "YR", "RYR", "R"], 5),
  scenario(4, "yellow", ["YRYR", "R", "YY", "RRY", "RRYRY", "YYRY", "RR"], 2),
  scenario(5, "yellow", ["RRY", "RYYRRY", "YYR", "RYYRYR", "RR", "", "Y"], 2),
  scenario(6, "red", ["Y", "RY", "RYRYY", "RRYR", "YR", "YYRYRY", "RR"], 3),
  scenario(7, "red", ["RRY", "RYY", "YRYRRR", "RYRYYY", "RY", "YRRRY", "Y"], 1),
  scenario(8, "red", ["YR", "YRR", "RY", "YRYRY", "RYYR", "YY", "RR"], 1),
  scenario(9, "yellow", ["YR", "RRYRRY", "RY", "YYRY", "RRYR", "YRYRYR", "Y"], 4),
  scenario(10, "yellow", ["RYR", "YRY", "RYRRYR", "RYRYRY", "", "YRY", ""], 5),
  scenario(11, "red", ["YR", "R", "RYRYRY", "RYRY", "YRY", "RY", "RYRY"], 0),
  scenario(12, "red", ["R", "R", "YRYRYY", "RRYY", "YYR", "RY", "RRY"], 3),
];
