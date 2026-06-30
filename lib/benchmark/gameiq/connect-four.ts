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

const CONNECT_FOUR_BASE_SCENARIOS: ConnectFourGameIqScenario[] = [
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

type ConnectFourTemplate = {
  id: string;
  title: string;
  player: ConnectFourPlayer;
  category: ConnectFourGameIqScenario["category"];
  difficulty: ConnectFourGameIqScenario["difficulty"];
  board: ConnectFourBoard;
  column: number;
  prompt: string;
  note: string;
  tags: string[];
};

function emptyBoard(): ConnectFourBoard {
  return Array.from({ length: 6 }, () =>
    Array.from({ length: 7 }, () => null)
  ) as ConnectFourBoard;
}

function opponentOf(player: ConnectFourPlayer): ConnectFourPlayer {
  return player === "red" ? "yellow" : "red";
}

function horizontalBoard(
  owner: ConnectFourPlayer,
  startColumn: number,
  targetColumn: number,
  fillers: Array<[number, ConnectFourPlayer]> = []
): ConnectFourBoard {
  const board = emptyBoard();
  for (let column = startColumn; column < startColumn + 4; column++) {
    if (column !== targetColumn) board[5][column] = owner;
  }
  for (const [column, player] of fillers) {
    if (board[5][column] == null && column !== targetColumn) {
      board[5][column] = player;
    }
  }
  return board;
}

function verticalThreatBoard(
  owner: ConnectFourPlayer,
  targetColumn: number,
  fillers: Array<[number, ConnectFourPlayer]> = []
): ConnectFourBoard {
  const board = emptyBoard();
  board[5][targetColumn] = owner;
  board[4][targetColumn] = owner;
  board[3][targetColumn] = owner;
  for (const [column, player] of fillers) {
    if (column !== targetColumn) board[5][column] = player;
  }
  return board;
}

function trapBoard(
  player: ConnectFourPlayer,
  targetColumn: number,
  supportColumns: [number, number],
  blockers: Array<[number, ConnectFourPlayer]>
): ConnectFourBoard {
  const board = emptyBoard();
  board[5][supportColumns[0]] = player;
  board[5][supportColumns[1]] = player;
  for (const [column, owner] of blockers) {
    if (board[5][column] == null && column !== targetColumn) {
      board[5][column] = owner;
    }
  }
  return board;
}

function scenarioFromTemplate(template: ConnectFourTemplate): ConnectFourGameIqScenario {
  return {
    id: `gameiq-v0.1-connect-four-${template.id}`,
    gameId: "connect-four",
    title: template.title,
    category: template.category,
    difficulty: template.difficulty,
    version: "0.1.0",
    prompt: template.prompt,
    initialState: state(template.board, template.player),
    expectedActions: expected(template.column, `Column ${template.column + 1}`, template.note),
    tags: ["connect-four", ...template.tags],
    maxResponseMs: 15_000,
  };
}

const GENERATED_CONNECT_FOUR_TEMPLATES: ConnectFourTemplate[] = [
  ...[
    ["win-left-edge", "red", 0, 3],
    ["win-center-gap", "yellow", 1, 2],
    ["win-right-edge", "red", 3, 6],
    ["win-open-left", "yellow", 2, 2],
    ["win-open-right", "red", 1, 4],
    ["win-middle-red", "red", 2, 4],
    ["win-middle-yellow", "yellow", 0, 1],
    ["win-wide-red", "red", 3, 4],
    ["win-wide-yellow", "yellow", 2, 5],
  ].map(([id, owner, start, target]) => {
    const player = owner as ConnectFourPlayer;
    return {
      id: String(id),
      title: `Connect Four: immediate horizontal win ${id}`,
      player,
      category: "win-in-one" as const,
      difficulty: "easy" as const,
      board: horizontalBoard(player, Number(start), Number(target), [
        [0, opponentOf(player)],
        [6, opponentOf(player)],
      ]),
      column: Number(target),
      prompt: `${player} to move. Return the column index that completes an immediate horizontal four.`,
      note: "Complete the only four-in-a-row available this turn.",
      tags: ["win", "horizontal"],
    };
  }),
  ...[
    ["block-left-edge", "yellow", 0, 3],
    ["block-center-gap", "red", 1, 2],
    ["block-right-edge", "yellow", 3, 6],
    ["block-open-left", "red", 2, 2],
    ["block-open-right", "yellow", 1, 4],
    ["block-middle-red", "yellow", 2, 4],
    ["block-middle-yellow", "red", 0, 1],
    ["block-wide-red", "yellow", 3, 4],
    ["block-wide-yellow", "red", 2, 5],
  ].map(([id, blocker, start, target]) => {
    const player = blocker as ConnectFourPlayer;
    const attacker = opponentOf(player);
    const startColumn = Number(start);
    const targetColumn = Number(target);
    const oppositeOpenEnd =
      targetColumn === startColumn
        ? startColumn + 4
        : targetColumn === startColumn + 3
          ? startColumn - 1
          : null;
    const fillers: Array<[number, ConnectFourPlayer]> = [
      [0, player],
      [6, player],
    ];
    if (oppositeOpenEnd != null && oppositeOpenEnd >= 0 && oppositeOpenEnd <= 6) {
      fillers.push([oppositeOpenEnd, player]);
    }
    return {
      id: String(id),
      title: `Connect Four: block horizontal threat ${id}`,
      player,
      category: "block-win" as const,
      difficulty: "easy" as const,
      board: horizontalBoard(attacker, startColumn, targetColumn, fillers),
      column: targetColumn,
      prompt: `${player} to move. Return the column index that blocks the opponent's immediate horizontal win.`,
      note: "Occupy the gap before the opponent completes four.",
      tags: ["defense", "block"],
    };
  }),
  ...[
    ["trap-center-red", "red", 3, [1, 2], [[5, "yellow"], [6, "yellow"]]],
    ["trap-center-yellow", "yellow", 3, [4, 5], [[0, "red"], [1, "red"]]],
    ["trap-left-red", "red", 1, [2, 3], [[5, "yellow"], [6, "yellow"]]],
    ["trap-right-yellow", "yellow", 5, [3, 4], [[0, "red"], [1, "red"]]],
    ["trap-spread-red", "red", 2, [3, 4], [[0, "yellow"], [6, "yellow"]]],
    ["trap-spread-yellow", "yellow", 4, [2, 3], [[0, "red"], [6, "red"]]],
    ["trap-low-red", "red", 2, [1, 3], [[5, "yellow"], [6, "yellow"]]],
    ["trap-high-yellow", "yellow", 4, [3, 5], [[0, "red"], [1, "red"]]],
    ["trap-balanced-red", "red", 4, [2, 3], [[0, "yellow"], [6, "yellow"]]],
  ].map(([id, owner, target, support, blockers]) => {
    const player = owner as ConnectFourPlayer;
    return {
      id: String(id),
      title: `Connect Four: create open threat ${id}`,
      player,
      category: "trap-setup" as const,
      difficulty: "medium" as const,
      board: trapBoard(
        player,
        Number(target),
        support as [number, number],
        blockers as Array<[number, ConnectFourPlayer]>
      ),
      column: Number(target),
      prompt: `${player} to move. Return the column index that creates the strongest open-ended bottom-row threat.`,
      note: "Build a three-stone threat with more than one follow-up.",
      tags: ["trap", "planning"],
    };
  }),
  ...[
    ["avoid-vertical-1", "red", 0],
    ["avoid-vertical-2", "yellow", 1],
    ["avoid-vertical-3", "red", 2],
    ["avoid-vertical-4", "yellow", 3],
    ["avoid-vertical-5", "red", 4],
    ["avoid-vertical-6", "yellow", 5],
    ["avoid-vertical-7", "red", 6],
    ["avoid-vertical-8", "yellow", 2],
    ["avoid-vertical-9", "red", 5],
  ].map(([id, blocker, target]) => {
    const player = blocker as ConnectFourPlayer;
    const attacker = opponentOf(player);
    return {
      id: String(id),
      title: `Connect Four: stop vertical loss ${id}`,
      player,
      category: "avoid-losing-move" as const,
      difficulty: "medium" as const,
      board: verticalThreatBoard(attacker, Number(target), [
        [(Number(target) + 2) % 7, player],
        [(Number(target) + 4) % 7, player],
      ]),
      column: Number(target),
      prompt: `${player} to move. Return the only column index that prevents an immediate vertical loss.`,
      note: "Play on top of the three-stack before it becomes four.",
      tags: ["defense", "avoid-loss", "vertical"],
    };
  }),
];

export const CONNECT_FOUR_GAMEIQ_SCENARIOS: ConnectFourGameIqScenario[] = [
  ...CONNECT_FOUR_BASE_SCENARIOS,
  ...GENERATED_CONNECT_FOUR_TEMPLATES.map(scenarioFromTemplate),
];
