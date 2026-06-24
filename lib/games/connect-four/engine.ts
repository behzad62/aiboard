import type {
  ConnectFourBoard,
  ConnectFourClockState,
  ConnectFourGameState,
  ConnectFourMoveRecord,
  ConnectFourPlayer,
} from "./types";

export const CONNECT_FOUR_COLUMNS = 7;
export const CONNECT_FOUR_ROWS = 6;

function createEmptyBoard(): ConnectFourBoard {
  return Array.from({ length: CONNECT_FOUR_ROWS }, () =>
    Array.from({ length: CONNECT_FOUR_COLUMNS }, () => null)
  );
}

function cloneBoard(board: ConnectFourBoard): ConnectFourBoard {
  return board.map((row) => [...row]);
}

function nextPlayer(player: ConnectFourPlayer): ConnectFourPlayer {
  return player === "red" ? "yellow" : "red";
}

function createInitialClock(startedAt: number): ConnectFourClockState {
  return {
    redElapsedMs: 0,
    yellowElapsedMs: 0,
    turnStartedAt: startedAt,
  };
}

function addElapsedForPlayer(
  clock: ConnectFourClockState,
  player: ConnectFourPlayer,
  timestamp: number
): ConnectFourClockState {
  const turnStartedAt = clock.turnStartedAt ?? timestamp;
  const elapsedMs = Math.max(0, timestamp - turnStartedAt);

  return player === "red"
    ? {
        ...clock,
        redElapsedMs: clock.redElapsedMs + elapsedMs,
      }
    : {
        ...clock,
        yellowElapsedMs: clock.yellowElapsedMs + elapsedMs,
      };
}

function isInBounds(row: number, column: number): boolean {
  return (
    row >= 0 &&
    row < CONNECT_FOUR_ROWS &&
    column >= 0 &&
    column < CONNECT_FOUR_COLUMNS
  );
}

export function createInitialConnectFourState(
  startedAt = Date.now()
): ConnectFourGameState {
  return {
    board: createEmptyBoard(),
    turn: "red",
    status: "playing",
    winner: null,
    moveHistory: [],
    clock: createInitialClock(startedAt),
  };
}

export function getLegalColumns(state: ConnectFourGameState): number[] {
  if (state.status !== "playing") return [];

  const legalColumns: number[] = [];
  for (let column = 0; column < CONNECT_FOUR_COLUMNS; column++) {
    if (state.board[0][column] === null) {
      legalColumns.push(column);
    }
  }
  return legalColumns;
}

export function isLegalColumn(state: ConnectFourGameState, column: number): boolean {
  return getLegalColumns(state).includes(column);
}

export function getLandingRow(
  state: ConnectFourGameState,
  column: number
): number | null {
  if (!isLegalColumn(state, column)) return null;

  for (let row = CONNECT_FOUR_ROWS - 1; row >= 0; row--) {
    if (state.board[row][column] === null) {
      return row;
    }
  }

  return null;
}

export function dropDisc(
  state: ConnectFourGameState,
  column: number,
  timestamp: number
): ConnectFourGameState {
  if (state.status !== "playing") {
    throw new Error("Cannot drop a disc after the game has ended or paused.");
  }

  if (!Number.isInteger(column) || column < 0 || column >= CONNECT_FOUR_COLUMNS) {
    throw new Error(`Column ${column + 1} is out of bounds.`);
  }

  if (state.board[0][column] !== null) {
    throw new Error(`Column ${column + 1} is full.`);
  }

  const board = cloneBoard(state.board);
  let placedRow = -1;
  for (let row = CONNECT_FOUR_ROWS - 1; row >= 0; row--) {
    if (board[row][column] === null) {
      board[row][column] = state.turn;
      placedRow = row;
      break;
    }
  }

  const player = state.turn;
  const didWin = isWinningPlacement(board, placedRow, column, player);
  const status = didWin
    ? "win"
    : board[0].every((cell) => cell !== null)
      ? "draw"
      : "playing";
  const elapsedClock = addElapsedForPlayer(state.clock, player, timestamp);
  const boardAfter = cloneBoard(board);
  const moveRecord: ConnectFourMoveRecord = {
    move: { column },
    player,
    displayColumn: column + 1,
    boardAfter,
    timestamp,
  };

  return {
    board,
    turn: nextPlayer(player),
    status,
    winner: didWin ? player : null,
    moveHistory: [...state.moveHistory, moveRecord],
    clock: {
      ...elapsedClock,
      turnStartedAt: status === "playing" ? timestamp : null,
    },
  };
}

export function isWinningPlacement(
  board: ConnectFourBoard,
  row: number,
  column: number,
  player: ConnectFourPlayer
): boolean {
  const directions: Array<[number, number]> = [
    [0, 1],
    [1, 0],
    [1, 1],
    [1, -1],
  ];

  return directions.some(([rowStep, columnStep]) => {
    const count =
      1 +
      countDirection(board, row, column, rowStep, columnStep, player) +
      countDirection(board, row, column, -rowStep, -columnStep, player);
    return count >= 4;
  });
}

function countDirection(
  board: ConnectFourBoard,
  row: number,
  column: number,
  rowStep: number,
  columnStep: number,
  player: ConnectFourPlayer
): number {
  let count = 0;
  let currentRow = row + rowStep;
  let currentColumn = column + columnStep;

  while (
    isInBounds(currentRow, currentColumn) &&
    board[currentRow][currentColumn] === player
  ) {
    count++;
    currentRow += rowStep;
    currentColumn += columnStep;
  }

  return count;
}

export function setConnectFourPaused(
  state: ConnectFourGameState,
  paused: boolean,
  timestamp = Date.now()
): ConnectFourGameState {
  if (paused && state.status === "playing") {
    const elapsedClock = addElapsedForPlayer(
      state.clock,
      state.turn,
      timestamp
    );
    return {
      ...state,
      status: "paused",
      clock: { ...elapsedClock, turnStartedAt: null },
    };
  }

  if (!paused && state.status === "paused") {
    return {
      ...state,
      status: "playing",
      clock: { ...state.clock, turnStartedAt: timestamp },
    };
  }

  return state;
}
