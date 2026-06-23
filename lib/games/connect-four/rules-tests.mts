/* Connect Four rules regression checks (run: npx tsx lib/games/connect-four/rules-tests.mts) */
import {
  CONNECT_FOUR_COLUMNS,
  CONNECT_FOUR_ROWS,
  createInitialConnectFourState,
  dropDisc,
  getLegalColumns,
  isLegalColumn,
  setConnectFourPaused,
} from "./engine";
import type { ConnectFourGameState } from "./types";

let failures = 0;

function check(name: string, ok: boolean, detail?: unknown): void {
  if (!ok) failures++;
  console.log(
    `${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` -> ${JSON.stringify(detail)}`}`
  );
}

function playColumns(columns: number[]): ConnectFourGameState {
  return columns.reduce(
    (state, column, index) => dropDisc(state, column, 1_000 + index),
    createInitialConnectFourState()
  );
}

function assertWinningSequence(name: string, columns: number[], winner: "red" | "yellow"): void {
  const state = playColumns(columns);
  check(name, state.status === "win" && state.winner === winner, {
    status: state.status,
    winner: state.winner,
    board: state.board,
  });
}

const initial = createInitialConnectFourState();
check("dropDisc requires explicit timestamp", dropDisc.length === 3, {
  arity: dropDisc.length,
});
check(
  "board is 7 columns by 6 rows",
  CONNECT_FOUR_COLUMNS === 7 &&
    CONNECT_FOUR_ROWS === 6 &&
    initial.board.length === 6 &&
    initial.board.every((row) => row.length === 7),
  { rows: initial.board.length, columns: initial.board.map((row) => row.length) }
);
check("red starts", initial.turn === "red", { turn: initial.turn });
check(
  "all columns initially legal",
  JSON.stringify(getLegalColumns(initial)) === JSON.stringify([0, 1, 2, 3, 4, 5, 6]) &&
    [0, 1, 2, 3, 4, 5, 6].every((column) => isLegalColumn(initial, column)),
  getLegalColumns(initial)
);

const pausedState = setConnectFourPaused(initial, true);
const unpausedState = setConnectFourPaused(pausedState, false);
check(
  "paused games have no legal columns and can resume playing",
  pausedState.status === "paused" &&
    getLegalColumns(pausedState).length === 0 &&
    unpausedState.status === "playing",
  { pausedStatus: pausedState.status, unpausedStatus: unpausedState.status }
);

const afterFirstMove = dropDisc(initial, 0, 1_234);
check("disc drops to bottom row", afterFirstMove.board[5][0] === "red", afterFirstMove.board);
check("turn alternates", afterFirstMove.turn === "yellow", { turn: afterFirstMove.turn });
check(
  "move history stores one-based displayColumn",
  afterFirstMove.moveHistory.length === 1 &&
    afterFirstMove.moveHistory[0].displayColumn === 1 &&
    afterFirstMove.moveHistory[0].move.column === 0 &&
    afterFirstMove.moveHistory[0].timestamp === 1_234,
  afterFirstMove.moveHistory
);

const fullColumnState = playColumns([0, 0, 0, 0, 0, 0]);
check(
  "full column is illegal",
  !isLegalColumn(fullColumnState, 0) &&
    !getLegalColumns(fullColumnState).includes(0) &&
    getLegalColumns(fullColumnState).length === 6,
  getLegalColumns(fullColumnState)
);
try {
  dropDisc(fullColumnState, 0, 2_000);
  check("dropping in a full column throws a full-column error", false);
} catch (err) {
  check(
    'dropping in a full column throws an error containing "Column 1 is full"',
    err instanceof Error && err.message.includes("Column 1 is full"),
    { error: err instanceof Error ? err.message : String(err) }
  );
}

assertWinningSequence("horizontal win", [0, 0, 1, 1, 2, 2, 3], "red");
assertWinningSequence("vertical win", [0, 1, 0, 1, 0, 1, 0], "red");
assertWinningSequence("diagonal win", [0, 1, 1, 2, 3, 2, 2, 3, 4, 3, 3], "red");

const drawColumns = [
  4, 5, 3, 0, 5, 0, 0, 3, 2, 0, 0, 3, 2, 5, 5, 0, 3, 6, 3, 2, 2, 1, 6,
  2, 3, 1, 4, 2, 4, 4, 1, 4, 1, 1, 5, 4, 6, 6, 5, 6, 6, 1,
];
const drawState = playColumns(drawColumns);
check("full-board draw", drawState.status === "draw" && drawState.winner === null, {
  status: drawState.status,
  winner: drawState.winner,
  legalColumns: getLegalColumns(drawState),
  board: drawState.board,
});

if (failures === 0) {
  console.log("PASS");
} else {
  console.log(`FAIL ${failures} check(s) failed`);
}

process.exit(failures === 0 ? 0 : 1);
