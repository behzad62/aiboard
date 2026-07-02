import type {
  ConnectFourGameIqScenario,
  ConnectFourGameIqAction,
} from "./types";
import type {
  ConnectFourBoard,
  ConnectFourGameState,
  ConnectFourPlayer,
} from "@/lib/games/connect-four/types";

// GameIQ Connect Four pack (re-authored 2026-07-02).
//
// Every board is authored as a set of per-column stacks given BOTTOM-UP
// (index 0 is the disc resting on the floor of the column). This guarantees no
// floating discs and lets `boardFromStacks` place them at the correct rows.
//
// Correctness is not trusted from these labels: scripts/test-gameiq-connect-four-pack.mts
// re-derives every property from the real Connect Four engine — that expected
// win columns win immediately, that blocks remove the opponent's only immediate
// threat, that traps create a genuine unique double threat, that avoid-losing
// boards have exactly one safe move while alternatives lose, that every board is
// legally reachable (alternating-move parity) with no already-completed four,
// and that every expected column is legal.
//
// De-leak note (wave 1): scenario.prompt strings ARE sent to the model; titles
// and notes are NOT. Prompts here are task-neutral ("It is X's turn. Return the
// best column.") and never name the tactic, direction, row, or answer. Titles
// are kept non-leaking as well.

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

// Task-neutral prompt: it never names the tactic, direction, row, or answer.
function neutralPrompt(player: ConnectFourPlayer): string {
  return `It is ${player}'s turn. Return the column index of the single best move.`;
}

type ConnectFourCase = {
  id: string;
  title: string;
  category: ConnectFourGameIqScenario["category"];
  difficulty: ConnectFourGameIqScenario["difficulty"];
  player: ConnectFourPlayer;
  stacks: Stacks;
  columns: number[];
  note: string;
  tags: string[];
};

function scenarioFromCase(entry: ConnectFourCase): ConnectFourGameIqScenario {
  return {
    id: `gameiq-v0.1-connect-four-${entry.id}`,
    gameId: "connect-four",
    title: entry.title,
    category: entry.category,
    difficulty: entry.difficulty,
    version: "0.1.0",
    prompt: neutralPrompt(entry.player),
    initialState: state(boardFromStacks(entry.stacks), entry.player),
    expectedActions: expected(entry.columns, entry.note),
    tags: ["connect-four", ...entry.tags],
    maxResponseMs: 15_000,
  };
}

// ---------------------------------------------------------------------------
// win-in-one (10): the mover has at least one column that completes four this
// turn. When two columns both win, BOTH are listed so a perfect deterministic
// candidate scores 100. Several boards double as move-priority conflicts (the
// mover has a win while the opponent also threatens — taking the win is
// correct, blocking is scored wrong) and one exercises legality pressure (the
// tactical column is full, so the win must come from elsewhere).
// ---------------------------------------------------------------------------
const WIN_CASES: ConnectFourCase[] = [
  {
    id: "win-horizontal",
    title: "Connect Four win A",
    category: "win-in-one",
    difficulty: "easy",
    player: "red",
    stacks: [["red"], ["red"], ["red"], [], ["yellow"], ["yellow"], ["yellow"]],
    columns: [3],
    note: "Fill the gap to complete a bottom-row four.",
    tags: ["tactical", "win"],
  },
  {
    id: "win-horizontal-edge",
    title: "Connect Four win B",
    category: "win-in-one",
    difficulty: "easy",
    player: "red",
    stacks: [[], ["red"], ["red"], ["red"], ["yellow"], ["yellow"], ["yellow"]],
    columns: [0],
    note: "Extend the open end to complete four.",
    tags: ["tactical", "win"],
  },
  {
    id: "win-vertical",
    title: "Connect Four win C",
    category: "win-in-one",
    difficulty: "easy",
    player: "red",
    stacks: [
      ["yellow"],
      ["yellow"],
      ["yellow"],
      ["red", "red", "red"],
      [],
      [],
      [],
    ],
    columns: [3],
    note: "Top the three-stack to complete a vertical four.",
    tags: ["tactical", "win", "vertical"],
  },
  {
    id: "win-diagonal-up",
    title: "Connect Four win D",
    category: "win-in-one",
    difficulty: "medium",
    player: "yellow",
    stacks: [
      [],
      ["yellow"],
      ["red", "yellow"],
      ["red", "red", "yellow"],
      ["red", "yellow", "red"],
      [],
      [],
    ],
    columns: [4],
    note: "Complete the rising diagonal.",
    tags: ["tactical", "win", "diagonal"],
  },
  {
    id: "win-diagonal-down",
    title: "Connect Four win E",
    category: "win-in-one",
    difficulty: "medium",
    player: "yellow",
    stacks: [
      [],
      ["red", "yellow"],
      ["red", "yellow", "yellow"],
      ["red", "red", "red", "yellow"],
      [],
      [],
      [],
    ],
    columns: [0],
    note: "Complete the falling diagonal at the open bottom cell.",
    tags: ["tactical", "win", "diagonal"],
  },
  {
    id: "win-priority-vertical",
    title: "Connect Four win F",
    category: "win-in-one",
    difficulty: "medium",
    player: "red",
    stacks: [
      ["red", "red", "red"],
      [],
      [],
      [],
      ["yellow"],
      ["yellow"],
      ["yellow"],
    ],
    columns: [0],
    note: "Take the immediate win rather than blocking the opponent's threat.",
    tags: ["tactical", "win", "priority"],
  },
  {
    id: "win-legality-pressure",
    title: "Connect Four win G",
    category: "win-in-one",
    difficulty: "hard",
    player: "red",
    stacks: [
      ["red", "red", "red"],
      ["yellow", "red", "yellow", "red", "yellow", "red"],
      [],
      [],
      ["yellow"],
      ["yellow"],
      ["yellow"],
    ],
    columns: [0],
    note: "A full column cannot be played; take the available win.",
    tags: ["tactical", "win", "legality", "priority"],
  },
  {
    id: "win-above-row",
    title: "Connect Four win H",
    category: "win-in-one",
    difficulty: "medium",
    player: "yellow",
    stacks: [
      ["red", "yellow"],
      ["yellow", "yellow"],
      ["red", "yellow"],
      ["red"],
      [],
      [],
      ["red", "red"],
    ],
    columns: [3],
    note: "Complete a four that sits above the bottom row.",
    tags: ["tactical", "win", "stacked"],
  },
  {
    id: "win-double-winning-columns",
    title: "Connect Four win I",
    category: "win-in-one",
    difficulty: "easy",
    player: "red",
    stacks: [[], ["red"], ["red"], ["red"], [], ["yellow", "yellow"], ["yellow"]],
    columns: [0, 4],
    note: "Either open end completes four; both are equally winning.",
    tags: ["tactical", "win"],
  },
  {
    id: "win-priority-horizontal",
    title: "Connect Four win J",
    category: "win-in-one",
    difficulty: "medium",
    player: "red",
    stacks: [
      ["red"],
      ["red"],
      ["red"],
      [],
      ["yellow", "yellow", "yellow"],
      [],
      [],
    ],
    columns: [3],
    note: "Take the immediate win rather than blocking the opponent's stack.",
    tags: ["tactical", "win", "priority"],
  },
];

// ---------------------------------------------------------------------------
// block-win (10): the opponent has exactly one immediate winning column and the
// mover has no immediate win of its own; the expected move removes that threat.
// Threats span horizontal, vertical, both diagonals, an above-row line, and a
// board with a full decoy column (legality pressure).
// ---------------------------------------------------------------------------
const BLOCK_CASES: ConnectFourCase[] = [
  {
    id: "block-horizontal",
    title: "Connect Four defense A",
    category: "block-win",
    difficulty: "easy",
    player: "yellow",
    stacks: [["red"], ["red"], ["red"], [], ["yellow"], ["yellow"], []],
    columns: [3],
    note: "Occupy the gap before the opponent completes four.",
    tags: ["defense", "block"],
  },
  {
    id: "block-horizontal-edge",
    title: "Connect Four defense B",
    category: "block-win",
    difficulty: "easy",
    player: "yellow",
    stacks: [[], ["red"], ["red"], ["red"], ["yellow"], ["yellow"], []],
    columns: [0],
    note: "Plug the open end of the opponent's row.",
    tags: ["defense", "block"],
  },
  {
    id: "block-vertical",
    title: "Connect Four defense C",
    category: "block-win",
    difficulty: "easy",
    player: "yellow",
    stacks: [
      ["yellow"],
      ["yellow"],
      [],
      ["red", "red", "red"],
      [],
      [],
      [],
    ],
    columns: [3],
    note: "Cap the opponent's three-stack.",
    tags: ["defense", "block", "vertical"],
  },
  {
    id: "block-diagonal-up",
    title: "Connect Four defense D",
    category: "block-win",
    difficulty: "medium",
    player: "yellow",
    stacks: [
      [],
      ["red"],
      ["yellow", "red"],
      ["red", "yellow", "red"],
      ["yellow", "yellow", "red"],
      [],
      [],
    ],
    columns: [4],
    note: "Block the opponent's rising diagonal.",
    tags: ["defense", "block", "diagonal"],
  },
  {
    id: "block-diagonal-down",
    title: "Connect Four defense E",
    category: "block-win",
    difficulty: "medium",
    player: "yellow",
    stacks: [
      [],
      ["red", "red"],
      ["yellow", "red", "red"],
      ["yellow", "yellow", "yellow", "red"],
      [],
      [],
      [],
    ],
    columns: [0],
    note: "Block the opponent's falling diagonal at the open bottom cell.",
    tags: ["defense", "block", "diagonal"],
  },
  {
    id: "block-above-row",
    title: "Connect Four defense F",
    category: "block-win",
    difficulty: "medium",
    player: "yellow",
    stacks: [
      ["yellow", "red"],
      ["red", "red"],
      ["yellow", "red"],
      ["red"],
      [],
      [],
      ["yellow", "yellow"],
    ],
    columns: [3],
    note: "Block a threat that sits above the bottom row.",
    tags: ["defense", "block", "stacked"],
  },
  {
    id: "block-legality-pressure",
    title: "Connect Four defense G",
    category: "block-win",
    difficulty: "hard",
    player: "yellow",
    stacks: [
      ["red", "red", "red"],
      ["yellow", "red", "yellow", "red", "yellow", "red"],
      [],
      [],
      ["yellow"],
      ["yellow"],
      [],
    ],
    columns: [0],
    note: "A full decoy column is unplayable; cap the real vertical threat.",
    tags: ["defense", "block", "legality"],
  },
  {
    id: "block-vertical-yellow",
    title: "Connect Four defense H",
    category: "block-win",
    difficulty: "easy",
    player: "red",
    stacks: [
      ["red"],
      ["yellow", "yellow", "yellow"],
      ["red"],
      ["red"],
      [],
      [],
      [],
    ],
    columns: [1],
    note: "Cap the opponent's three-stack.",
    tags: ["defense", "block", "vertical"],
  },
  {
    id: "block-horizontal-mid",
    title: "Connect Four defense I",
    category: "block-win",
    difficulty: "medium",
    player: "yellow",
    stacks: [["yellow"], ["yellow"], ["red"], ["red"], ["red"], [], []],
    columns: [5],
    note: "Only the open end can be blocked; the other end is already closed.",
    tags: ["defense", "block"],
  },
  {
    id: "block-horizontal-mid-red",
    title: "Connect Four defense J",
    category: "block-win",
    difficulty: "medium",
    player: "red",
    stacks: [
      ["red"],
      [],
      ["yellow"],
      ["yellow"],
      ["yellow"],
      ["red"],
      ["red"],
    ],
    columns: [1],
    note: "The closed end forces the block to the single open column.",
    tags: ["defense", "block"],
  },
];

// ---------------------------------------------------------------------------
// trap-setup (10): the expected drop creates a DOUBLE threat — after it, the
// mover has two or more columns that win immediately, so the opponent can block
// only one. The mover has no immediate win before the drop and the opponent has
// no immediate threat. Includes centered open-threes and multi-directional
// double threats (a single drop completing two lines of different orientation).
// ---------------------------------------------------------------------------
const TRAP_CASES: ConnectFourCase[] = [
  {
    id: "trap-open-left",
    title: "Connect Four setup A",
    category: "trap-setup",
    difficulty: "medium",
    player: "red",
    stacks: [[], ["red"], ["red"], [], [], ["yellow"], ["yellow"]],
    columns: [3],
    note: "Create an open three with two winning follow-ups.",
    tags: ["trap", "planning"],
  },
  {
    id: "trap-open-mid",
    title: "Connect Four setup B",
    category: "trap-setup",
    difficulty: "medium",
    player: "red",
    stacks: [["yellow"], [], [], ["red"], ["red"], [], ["yellow"]],
    columns: [2],
    note: "Create an open three with two winning follow-ups.",
    tags: ["trap", "planning"],
  },
  {
    id: "trap-open-right",
    title: "Connect Four setup C",
    category: "trap-setup",
    difficulty: "medium",
    player: "red",
    stacks: [["yellow"], ["yellow"], [], [], ["red"], ["red"], []],
    columns: [3],
    note: "Create an open three with two winning follow-ups.",
    tags: ["trap", "planning"],
  },
  {
    id: "trap-open-left-yellow",
    title: "Connect Four setup D",
    category: "trap-setup",
    difficulty: "medium",
    player: "yellow",
    stacks: [[], ["yellow"], ["yellow"], [], [], ["red", "red"], ["red"]],
    columns: [3],
    note: "Create an open three with two winning follow-ups.",
    tags: ["trap", "planning"],
  },
  {
    id: "trap-open-mid-yellow",
    title: "Connect Four setup E",
    category: "trap-setup",
    difficulty: "medium",
    player: "yellow",
    stacks: [["red", "red"], [], [], ["yellow"], ["yellow"], [], ["red"]],
    columns: [2],
    note: "Create an open three with two winning follow-ups.",
    tags: ["trap", "planning"],
  },
  {
    id: "trap-open-right-yellow",
    title: "Connect Four setup F",
    category: "trap-setup",
    difficulty: "medium",
    player: "yellow",
    stacks: [["red", "red"], ["red"], [], [], ["yellow"], ["yellow"], []],
    columns: [3],
    note: "Create an open three with two winning follow-ups.",
    tags: ["trap", "planning"],
  },
  {
    id: "trap-fork-horizontal-diagonal",
    title: "Connect Four setup G",
    category: "trap-setup",
    difficulty: "hard",
    player: "red",
    stacks: [
      [],
      [],
      [],
      ["red", "red"],
      ["red", "yellow"],
      ["yellow", "yellow", "yellow", "red"],
      [],
    ],
    columns: [2],
    note: "One drop opens two threats on different lines.",
    tags: ["trap", "planning", "fork"],
  },
  {
    id: "trap-fork-diagonal-horizontal",
    title: "Connect Four setup H",
    category: "trap-setup",
    difficulty: "hard",
    player: "yellow",
    stacks: [
      [],
      ["red", "red", "red", "yellow"],
      ["yellow", "red"],
      ["yellow", "yellow", "red"],
      [],
      [],
      [],
    ],
    columns: [4],
    note: "One drop opens two threats on different lines.",
    tags: ["trap", "planning", "fork"],
  },
  {
    id: "trap-fork-diagonal-vertical",
    title: "Connect Four setup I",
    category: "trap-setup",
    difficulty: "hard",
    player: "yellow",
    stacks: [
      [],
      ["red", "red", "red", "yellow"],
      ["yellow", "yellow"],
      ["red"],
      ["yellow"],
      ["red"],
      [],
    ],
    columns: [2],
    note: "One drop opens two threats on different lines.",
    tags: ["trap", "planning", "fork"],
  },
  {
    id: "trap-fork-diagonal-vertical-2",
    title: "Connect Four setup J",
    category: "trap-setup",
    difficulty: "hard",
    player: "yellow",
    stacks: [
      [],
      ["red"],
      [],
      ["yellow"],
      ["red", "yellow"],
      ["red", "red"],
      ["red", "yellow", "yellow"],
    ],
    columns: [6],
    note: "One drop opens two threats on different lines.",
    tags: ["trap", "planning", "fork"],
  },
];

// ---------------------------------------------------------------------------
// avoid-losing-move (10): the opponent threatens an immediate win and exactly
// ONE legal column removes every immediate threat — every other legal move
// leaves the opponent able to win next turn. Unlike block-win, these emphasise
// that most candidate columns lose, including several richer midgame positions.
// ---------------------------------------------------------------------------
const AVOID_CASES: ConnectFourCase[] = [
  {
    id: "avoid-loss-1",
    title: "Connect Four survival A",
    category: "avoid-losing-move",
    difficulty: "medium",
    player: "yellow",
    stacks: [[], ["yellow"], ["red"], ["red"], [], ["red", "yellow"], []],
    columns: [4],
    note: "Only one column denies the opponent's immediate win.",
    tags: ["defense", "avoid-loss"],
  },
  {
    id: "avoid-loss-2",
    title: "Connect Four survival B",
    category: "avoid-losing-move",
    difficulty: "medium",
    player: "yellow",
    stacks: [
      ["yellow", "yellow"],
      ["red"],
      ["red"],
      ["red"],
      [],
      ["yellow"],
      ["red"],
    ],
    columns: [4],
    note: "Only one column denies the opponent's immediate win.",
    tags: ["defense", "avoid-loss"],
  },
  {
    id: "avoid-loss-3",
    title: "Connect Four survival C",
    category: "avoid-losing-move",
    difficulty: "medium",
    player: "red",
    stacks: [[], ["red"], ["yellow"], ["yellow"], [], ["yellow", "red"], ["red"]],
    columns: [4],
    note: "Only one column denies the opponent's immediate win.",
    tags: ["defense", "avoid-loss"],
  },
  {
    id: "avoid-loss-4",
    title: "Connect Four survival D",
    category: "avoid-losing-move",
    difficulty: "hard",
    player: "yellow",
    stacks: [
      ["yellow", "yellow"],
      [],
      [],
      ["yellow"],
      ["red", "red", "red"],
      ["red", "red"],
      ["yellow"],
    ],
    columns: [4],
    note: "Only one column denies the opponent's immediate win.",
    tags: ["defense", "avoid-loss"],
  },
  {
    id: "avoid-loss-5",
    title: "Connect Four survival E",
    category: "avoid-losing-move",
    difficulty: "hard",
    player: "red",
    stacks: [
      [],
      ["red"],
      ["red", "yellow", "red"],
      ["yellow", "yellow"],
      ["yellow", "red", "red"],
      [],
      ["yellow"],
    ],
    columns: [5],
    note: "Only one column denies the opponent's immediate win.",
    tags: ["defense", "avoid-loss"],
  },
  {
    id: "avoid-loss-6",
    title: "Connect Four survival F",
    category: "avoid-losing-move",
    difficulty: "medium",
    player: "yellow",
    stacks: [["yellow"], ["red"], [], ["red"], ["red"], [], ["yellow"]],
    columns: [2],
    note: "Only one column denies the opponent's immediate win.",
    tags: ["defense", "avoid-loss"],
  },
  {
    id: "avoid-loss-7",
    title: "Connect Four survival G",
    category: "avoid-losing-move",
    difficulty: "medium",
    player: "red",
    stacks: [
      ["red", "red"],
      [],
      [],
      ["red"],
      [],
      ["yellow", "yellow", "yellow"],
      [],
    ],
    columns: [5],
    note: "Only one column denies the opponent's immediate win.",
    tags: ["defense", "avoid-loss"],
  },
  {
    id: "avoid-loss-8",
    title: "Connect Four survival H",
    category: "avoid-losing-move",
    difficulty: "hard",
    player: "yellow",
    stacks: [
      [],
      ["red"],
      [],
      ["red", "yellow"],
      ["red"],
      ["yellow"],
      ["yellow", "red"],
    ],
    columns: [2],
    note: "Only one column denies the opponent's immediate win.",
    tags: ["defense", "avoid-loss"],
  },
  {
    id: "avoid-loss-9",
    title: "Connect Four survival I",
    category: "avoid-losing-move",
    difficulty: "hard",
    player: "red",
    stacks: [
      ["red", "red", "yellow", "red"],
      ["red"],
      ["yellow", "red"],
      [],
      ["yellow"],
      ["yellow", "yellow"],
      [],
    ],
    columns: [3],
    note: "Only one column denies the opponent's immediate win.",
    tags: ["defense", "avoid-loss"],
  },
  {
    id: "avoid-loss-10",
    title: "Connect Four survival J",
    category: "avoid-losing-move",
    difficulty: "medium",
    player: "yellow",
    stacks: [[], ["red"], ["red"], [], ["red", "yellow"], [], ["yellow"]],
    columns: [3],
    note: "Only one column denies the opponent's immediate win.",
    tags: ["defense", "avoid-loss"],
  },
];

export const CONNECT_FOUR_GAMEIQ_SCENARIOS: ConnectFourGameIqScenario[] = [
  ...WIN_CASES,
  ...BLOCK_CASES,
  ...TRAP_CASES,
  ...AVOID_CASES,
].map(scenarioFromCase);
