import type {
  ConnectFourGameIqScenario,
  ConnectFourGameIqAction,
} from "./types";
import type {
  ConnectFourBoard,
  ConnectFourGameState,
  ConnectFourPlayer,
} from "@/lib/games/connect-four/types";

const EMPTY_CLOCK = {
  redElapsedMs: 0,
  yellowElapsedMs: 0,
  turnStartedAt: 0,
};

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
  column: number,
  label: string,
  note?: string
): Array<{ action: ConnectFourGameIqAction; label: string; weight: number; note?: string }> {
  return [{ action: { column }, label, weight: 1, note }];
}

export const CONNECT_FOUR_GAMEIQ_SCENARIOS: ConnectFourGameIqScenario[] = [
  {
    id: "gameiq-v0.1-connect-four-win-horizontal",
    gameId: "connect-four",
    title: "Connect Four: complete the bottom-row four",
    category: "win-in-one",
    difficulty: "easy",
    version: "0.1.0",
    prompt:
      "Red to move. Return the column index that wins immediately for red.",
    initialState: state(
      [
        [null, null, null, null, null, null, null],
        [null, null, null, null, null, null, null],
        [null, null, null, null, null, null, null],
        [null, null, null, null, null, null, null],
        [null, null, null, null, null, null, null],
        ["red", "red", "red", null, "yellow", "yellow", null],
      ],
      "red"
    ),
    expectedActions: expected(3, "Column 4", "Drop in column 4 to make four."),
    tags: ["connect-four", "tactical", "win"],
    maxResponseMs: 15_000,
  },
  {
    id: "gameiq-v0.1-connect-four-block-horizontal",
    gameId: "connect-four",
    title: "Connect Four: block the bottom-row threat",
    category: "block-win",
    difficulty: "easy",
    version: "0.1.0",
    prompt:
      "Yellow to move. Red threatens a bottom-row win; return the blocking column index.",
    initialState: state(
      [
        [null, null, null, null, null, null, null],
        [null, null, null, null, null, null, null],
        [null, null, null, null, null, null, null],
        [null, null, null, null, null, null, null],
        [null, null, null, null, null, null, null],
        ["red", "red", "red", null, "yellow", null, null],
      ],
      "yellow"
    ),
    expectedActions: expected(3, "Column 4", "Block red's immediate four."),
    tags: ["connect-four", "defense", "block"],
    maxResponseMs: 15_000,
  },
  {
    id: "gameiq-v0.1-connect-four-open-three-trap",
    gameId: "connect-four",
    title: "Connect Four: build an open-ended three",
    category: "trap-setup",
    difficulty: "medium",
    version: "0.1.0",
    prompt:
      "Red to move. Return the column index that creates two bottom-row threats.",
    initialState: state(
      [
        [null, null, null, null, null, null, null],
        [null, null, null, null, null, null, null],
        [null, null, null, null, null, null, null],
        [null, null, null, null, null, null, null],
        [null, null, null, null, null, null, null],
        [null, "red", "red", null, null, "yellow", "yellow"],
      ],
      "red"
    ),
    expectedActions: expected(
      3,
      "Column 4",
      "Create red threats on both column 1 and column 5."
    ),
    tags: ["connect-four", "trap", "tempo"],
    maxResponseMs: 15_000,
  },
  {
    id: "gameiq-v0.1-connect-four-avoid-vertical-loss",
    gameId: "connect-four",
    title: "Connect Four: avoid allowing a vertical loss",
    category: "avoid-losing-move",
    difficulty: "medium",
    version: "0.1.0",
    prompt:
      "Red to move. Yellow has a vertical threat; return the only safe blocking column index.",
    initialState: state(
      [
        [null, null, null, null, null, null, null],
        [null, null, null, null, null, null, null],
        [null, null, null, null, null, null, null],
        [null, null, null, null, "yellow", null, null],
        ["red", null, null, null, "yellow", null, null],
        ["red", null, null, null, "yellow", null, null],
      ],
      "red"
    ),
    expectedActions: expected(
      4,
      "Column 5",
      "Occupy column 5 before yellow completes the vertical four."
    ),
    tags: ["connect-four", "defense", "avoid-loss"],
    maxResponseMs: 15_000,
  },
];
