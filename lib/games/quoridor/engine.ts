import type {
  QuoridorAction,
  QuoridorClockState,
  QuoridorGameState,
  QuoridorMoveRecord,
  QuoridorPlayer,
  QuoridorSnapshot,
  QuoridorSquare,
  QuoridorWall,
} from "./types";

export const QUORIDOR_SIZE = 9;
export const QUORIDOR_WALL_GRID = 8;
export const QUORIDOR_WALLS_PER_PLAYER = 10;

const ORTHOGONAL: Array<[number, number]> = [
  [-1, 0],
  [1, 0],
  [0, -1],
  [0, 1],
];

function opponentOf(player: QuoridorPlayer): QuoridorPlayer {
  return player === "south" ? "north" : "south";
}

function goalRow(player: QuoridorPlayer): number {
  return player === "south" ? 0 : QUORIDOR_SIZE - 1;
}

function cloneSquare(square: QuoridorSquare): QuoridorSquare {
  return { row: square.row, col: square.col };
}

function cloneWalls(walls: QuoridorWall[]): QuoridorWall[] {
  return walls.map((wall) => ({ ...wall }));
}

function cloneSnapshot(state: QuoridorSnapshot): QuoridorSnapshot {
  return {
    pawns: {
      south: cloneSquare(state.pawns.south),
      north: cloneSquare(state.pawns.north),
    },
    walls: cloneWalls(state.walls),
    wallsLeft: { ...state.wallsLeft },
  };
}

function squaresEqual(left: QuoridorSquare, right: QuoridorSquare): boolean {
  return left.row === right.row && left.col === right.col;
}

function isOnBoard(row: number, col: number): boolean {
  return (
    Number.isInteger(row) &&
    Number.isInteger(col) &&
    row >= 0 &&
    row < QUORIDOR_SIZE &&
    col >= 0 &&
    col < QUORIDOR_SIZE
  );
}

function isWallCoordinate(row: number, col: number): boolean {
  return (
    Number.isInteger(row) &&
    Number.isInteger(col) &&
    row >= 0 &&
    row < QUORIDOR_WALL_GRID &&
    col >= 0 &&
    col < QUORIDOR_WALL_GRID
  );
}

function createInitialClock(startedAt: number): QuoridorClockState {
  return {
    southElapsedMs: 0,
    northElapsedMs: 0,
    turnStartedAt: startedAt,
  };
}

function addElapsedForPlayer(
  clock: QuoridorClockState,
  player: QuoridorPlayer,
  timestamp: number
): QuoridorClockState {
  const turnStartedAt = clock.turnStartedAt ?? timestamp;
  const elapsedMs = Math.max(0, timestamp - turnStartedAt);

  return player === "south"
    ? { ...clock, southElapsedMs: clock.southElapsedMs + elapsedMs }
    : { ...clock, northElapsedMs: clock.northElapsedMs + elapsedMs };
}

export function createInitialQuoridorState(
  startedAt = Date.now()
): QuoridorGameState {
  return {
    pawns: {
      south: { row: QUORIDOR_SIZE - 1, col: 4 },
      north: { row: 0, col: 4 },
    },
    walls: [],
    wallsLeft: {
      south: QUORIDOR_WALLS_PER_PLAYER,
      north: QUORIDOR_WALLS_PER_PLAYER,
    },
    turn: "south",
    status: "playing",
    winner: null,
    moveHistory: [],
    clock: createInitialClock(startedAt),
  };
}

export function isEdgeBlocked(
  walls: QuoridorWall[],
  from: QuoridorSquare,
  to: QuoridorSquare
): boolean {
  const rowDelta = to.row - from.row;
  const colDelta = to.col - from.col;
  if (Math.abs(rowDelta) + Math.abs(colDelta) !== 1) return true;

  if (colDelta === 0) {
    const wallRow = Math.min(from.row, to.row);
    const col = from.col;
    return walls.some(
      (wall) =>
        wall.orientation === "H" &&
        wall.row === wallRow &&
        (wall.col === col || wall.col === col - 1)
    );
  }

  const wallCol = Math.min(from.col, to.col);
  const row = from.row;
  return walls.some(
    (wall) =>
      wall.orientation === "V" &&
      wall.col === wallCol &&
      (wall.row === row || wall.row === row - 1)
  );
}

function wallsOverlap(left: QuoridorWall, right: QuoridorWall): boolean {
  if (left.orientation === right.orientation) {
    if (left.orientation === "H") {
      return left.row === right.row && Math.abs(left.col - right.col) <= 1;
    }
    return left.col === right.col && Math.abs(left.row - right.row) <= 1;
  }

  return left.row === right.row && left.col === right.col;
}

function wallConflicts(existing: QuoridorWall[], candidate: QuoridorWall): boolean {
  return existing.some((wall) => wallsOverlap(wall, candidate));
}

export function hasPathToGoal(
  state: Pick<QuoridorSnapshot, "pawns" | "walls">,
  player: QuoridorPlayer
): boolean {
  const start = state.pawns[player];
  const targetRow = goalRow(player);
  const seen = new Set<string>([`${start.row},${start.col}`]);
  const queue: QuoridorSquare[] = [start];

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) break;
    if (current.row === targetRow) return true;

    for (const [rowStep, colStep] of ORTHOGONAL) {
      const next = { row: current.row + rowStep, col: current.col + colStep };
      const key = `${next.row},${next.col}`;
      if (!isOnBoard(next.row, next.col) || seen.has(key)) continue;
      if (isEdgeBlocked(state.walls, current, next)) continue;
      seen.add(key);
      queue.push(next);
    }
  }

  return false;
}

function bothPlayersHavePath(
  pawns: QuoridorSnapshot["pawns"],
  walls: QuoridorWall[]
): boolean {
  const snapshot = { pawns, walls };
  return hasPathToGoal(snapshot, "south") && hasPathToGoal(snapshot, "north");
}

function pawnDestinations(
  state: QuoridorSnapshot,
  player: QuoridorPlayer
): QuoridorSquare[] {
  const from = state.pawns[player];
  const other = state.pawns[opponentOf(player)];
  const destinations: QuoridorSquare[] = [];

  for (const [rowStep, colStep] of ORTHOGONAL) {
    const step = { row: from.row + rowStep, col: from.col + colStep };
    if (!isOnBoard(step.row, step.col)) continue;
    if (isEdgeBlocked(state.walls, from, step)) continue;

    if (!squaresEqual(step, other)) {
      destinations.push(step);
      continue;
    }

    const behind = { row: other.row + rowStep, col: other.col + colStep };
    const behindOpen =
      isOnBoard(behind.row, behind.col) &&
      !isEdgeBlocked(state.walls, other, behind);

    if (behindOpen) {
      destinations.push(behind);
      continue;
    }

    const perpendicular: Array<[number, number]> =
      rowStep === 0
        ? [
            [-1, 0],
            [1, 0],
          ]
        : [
            [0, -1],
            [0, 1],
          ];

    for (const [sideRow, sideCol] of perpendicular) {
      const diagonal = { row: other.row + sideRow, col: other.col + sideCol };
      if (!isOnBoard(diagonal.row, diagonal.col)) continue;
      if (isEdgeBlocked(state.walls, other, diagonal)) continue;
      if (squaresEqual(diagonal, from)) continue;
      destinations.push(diagonal);
    }
  }

  return destinations;
}

function isLegalWallPlacement(
  state: QuoridorSnapshot,
  player: QuoridorPlayer,
  candidate: QuoridorWall
): boolean {
  if (state.wallsLeft[player] <= 0) return false;
  if (!isWallCoordinate(candidate.row, candidate.col)) return false;
  if (candidate.orientation !== "H" && candidate.orientation !== "V") {
    return false;
  }
  if (wallConflicts(state.walls, candidate)) return false;

  return bothPlayersHavePath(state.pawns, [...state.walls, candidate]);
}

export function getLegalActions(state: QuoridorGameState): QuoridorAction[] {
  if (state.status !== "playing") return [];

  const actions: QuoridorAction[] = pawnDestinations(state, state.turn).map(
    (square) => ({ type: "move", row: square.row, col: square.col })
  );

  if (state.wallsLeft[state.turn] > 0) {
    for (let row = 0; row < QUORIDOR_WALL_GRID; row++) {
      for (let col = 0; col < QUORIDOR_WALL_GRID; col++) {
        for (const orientation of ["H", "V"] as const) {
          const candidate = { row, col, orientation };
          if (isLegalWallPlacement(state, state.turn, candidate)) {
            actions.push({ type: "wall", ...candidate });
          }
        }
      }
    }
  }

  return actions;
}

export function isLegalAction(
  state: QuoridorGameState,
  action: QuoridorAction
): boolean {
  return getLegalActions(state).some((legal) => actionEquals(legal, action));
}

export function actionEquals(
  left: QuoridorAction,
  right: QuoridorAction
): boolean {
  if (left.type !== right.type) return false;
  if (left.type === "move" && right.type === "move") {
    return left.row === right.row && left.col === right.col;
  }
  return (
    left.type === "wall" &&
    right.type === "wall" &&
    left.row === right.row &&
    left.col === right.col &&
    left.orientation === right.orientation
  );
}

export function formatQuoridorSquare(square: QuoridorSquare): string {
  return `${String.fromCharCode(97 + square.col)}${QUORIDOR_SIZE - square.row}`;
}

export function formatQuoridorAction(action: QuoridorAction): string {
  if (action.type === "move") {
    return formatQuoridorSquare(action);
  }
  return `${formatQuoridorSquare({ row: action.row, col: action.col })}${action.orientation.toLowerCase()}`;
}

export function parseQuoridorSquare(value: string): QuoridorSquare | null {
  const match = value.trim().toLowerCase().match(/^([a-i])([1-9])$/);
  if (!match) return null;
  return {
    col: match[1].charCodeAt(0) - 97,
    row: QUORIDOR_SIZE - Number(match[2]),
  };
}

export function parseQuoridorActionNotation(
  value: string
): QuoridorAction | null {
  const trimmed = value.trim().toLowerCase();
  const wallMatch = trimmed.match(/^([a-i][1-9])([hv])$/);
  if (wallMatch) {
    const square = parseQuoridorSquare(wallMatch[1]);
    if (!square) return null;
    return {
      type: "wall",
      row: square.row,
      col: square.col,
      orientation: wallMatch[2] === "h" ? "H" : "V",
    };
  }

  const square = parseQuoridorSquare(trimmed);
  if (!square) return null;
  return { type: "move", ...square };
}

export function shortestPathLength(
  state: Pick<QuoridorSnapshot, "pawns" | "walls">,
  player: QuoridorPlayer
): number | null {
  const start = state.pawns[player];
  const targetRow = goalRow(player);
  const seen = new Set<string>([`${start.row},${start.col}`]);
  const queue: Array<{ square: QuoridorSquare; dist: number }> = [
    { square: start, dist: 0 },
  ];

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) break;
    if (current.square.row === targetRow) return current.dist;

    for (const [rowStep, colStep] of ORTHOGONAL) {
      const next = {
        row: current.square.row + rowStep,
        col: current.square.col + colStep,
      };
      const key = `${next.row},${next.col}`;
      if (!isOnBoard(next.row, next.col) || seen.has(key)) continue;
      if (isEdgeBlocked(state.walls, current.square, next)) continue;
      seen.add(key);
      queue.push({ square: next, dist: current.dist + 1 });
    }
  }

  return null;
}

export function applyQuoridorAction(
  state: QuoridorGameState,
  action: QuoridorAction,
  timestamp: number
): QuoridorGameState {
  if (state.status !== "playing") {
    throw new Error("Cannot act after the game has ended or paused.");
  }

  if (!isLegalAction(state, action)) {
    if (action.type === "wall") {
      const candidate = {
        row: action.row,
        col: action.col,
        orientation: action.orientation,
      };
      if (
        isWallCoordinate(action.row, action.col) &&
        !wallConflicts(state.walls, candidate) &&
        !bothPlayersHavePath(state.pawns, [...state.walls, candidate])
      ) {
        throw new Error("Wall placement would block a path to a goal.");
      }
    }
    throw new Error("Illegal Quoridor action.");
  }

  const player = state.turn;
  const next = cloneSnapshot(state);

  if (action.type === "move") {
    next.pawns[player] = { row: action.row, col: action.col };
  } else {
    next.walls.push({
      row: action.row,
      col: action.col,
      orientation: action.orientation,
    });
    next.wallsLeft[player] -= 1;
  }

  const didWin = next.pawns[player].row === goalRow(player);
  const elapsedClock = addElapsedForPlayer(state.clock, player, timestamp);
  const snapshotAfter = cloneSnapshot(next);
  const moveRecord: QuoridorMoveRecord = {
    action: { ...action },
    player,
    notation: formatQuoridorAction(action),
    snapshotAfter,
    timestamp,
  };

  return {
    ...next,
    turn: opponentOf(player),
    status: didWin ? "win" : "playing",
    winner: didWin ? player : null,
    moveHistory: [...state.moveHistory, moveRecord],
    clock: {
      ...elapsedClock,
      turnStartedAt: didWin ? null : timestamp,
    },
  };
}

export function setQuoridorPaused(
  state: QuoridorGameState,
  paused: boolean,
  timestamp = Date.now()
): QuoridorGameState {
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
