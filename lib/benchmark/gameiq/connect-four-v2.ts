import type {
  ConnectFourGameIqAction,
  ConnectFourGameIqScenario,
} from "./types";
import type {
  ConnectFourBoard,
  ConnectFourGameState,
  ConnectFourPlayer,
} from "@/lib/games/connect-four/types";

// Generated from deterministic miner seeds 1, 3, 4, 8, 9, 10, and 12. The
// performance replacement pool used --want 24 for seeds 8-10 and --want 12 for
// seed 12; candidates were selected by solver-derived key only, then sorted by
// depth and timing while capping each keyed column at three and representing
// both movers at least four times. Never hand-edit these boards or keyed
// columns: re-mine and run scripts/test-gameiq-c4-v2-pack.mts instead.

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
  scenario(1, "yellow", ["R", "YRYYR", "RYR", "RYRYRR", "RY", "YRYRYY", "YR"], 2),
  scenario(2, "yellow", ["RYRR", "Y", "RRY", "YYRRYR", "RYRYY", "", "YR"], 0),
  scenario(3, "yellow", ["YR", "RRYRRY", "RY", "YYRY", "RRYR", "YRYRYR", "Y"], 4),
  scenario(4, "yellow", ["RY", "RRY", "RYRR", "YYRYR", "RRYRY", "YRRYY", "YYR"], 3),
  scenario(5, "red", ["", "RRY", "YRYY", "RRYRRR", "YYRYRY", "R", "YY"], 2),
  scenario(6, "yellow", ["RRY", "RYYRRY", "YYR", "RYYRYR", "RR", "", "Y"], 2),
  scenario(7, "red", ["RRY", "RYY", "YRYRRR", "RYRYYY", "RY", "YRRRY", "Y"], 1),
  scenario(8, "red", ["", "RRYY", "YRYRY", "YRYRRY", "", "RYRY", "YRR"], 5),
  scenario(9, "red", ["Y", "YRR", "RRYRR", "RYRYYY", "R", "YYRYY", "R"], 4),
  scenario(10, "yellow", ["RYRY", "R", "YYR", "RRY", "RYRYYR", "RY", "YYRR"], 3),
  scenario(11, "red", ["R", "R", "YRRRYY", "RYY", "RYR", "RY", "YRYYYR"], 4),
  scenario(12, "yellow", ["YR", "RRYR", "YYRYR", "RRYRY", "YR", "RYY", ""], 5),
];
