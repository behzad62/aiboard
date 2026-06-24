import type {
  BattleshipCoordinate,
  BattleshipFleetValidationResult,
  BattleshipGameState,
  BattleshipOrientation,
  BattleshipMoveRecord,
  BattleshipPlayer,
  BattleshipPlayerBoard,
  BattleshipShip,
  BattleshipShipDefinition,
  BattleshipShipPlacement,
  BattleshipShotRecord,
  BattleshipShotResult,
} from "./types";

export const BATTLESHIP_BOARD_SIZE = 10;

export const BATTLESHIP_FLEET: BattleshipShipDefinition[] = [
  { id: "carrier", name: "Carrier", size: 5 },
  { id: "battleship", name: "Battleship", size: 4 },
  { id: "cruiser", name: "Cruiser", size: 3 },
  { id: "submarine", name: "Submarine", size: 3 },
  { id: "destroyer", name: "Destroyer", size: 2 },
];

const ROW_LABELS = "ABCDEFGHIJ";

function opponentOf(player: BattleshipPlayer): BattleshipPlayer {
  return player === "blue" ? "orange" : "blue";
}

function keyOf(target: BattleshipCoordinate): string {
  return `${target.row}:${target.column}`;
}

function cloneCoordinate(target: BattleshipCoordinate): BattleshipCoordinate {
  return { row: target.row, column: target.column };
}

function cloneShip(ship: BattleshipShip): BattleshipShip {
  return {
    ...ship,
    cells: ship.cells.map(cloneCoordinate),
  };
}

function cloneBoard(board: BattleshipPlayerBoard): BattleshipPlayerBoard {
  return {
    ships: board.ships.map(cloneShip),
    shotsReceived: board.shotsReceived.map((shot) => ({
      ...shot,
      target: cloneCoordinate(shot.target),
    })),
  };
}

function horizontalShip(
  definition: BattleshipShipDefinition,
  row: number,
  column: number
): BattleshipShip {
  return {
    ...definition,
    cells: Array.from({ length: definition.size }, (_, index) => ({
      row,
      column: column + index,
    })),
  };
}

function verticalShip(
  definition: BattleshipShipDefinition,
  row: number,
  column: number
): BattleshipShip {
  return {
    ...definition,
    cells: Array.from({ length: definition.size }, (_, index) => ({
      row: row + index,
      column,
    })),
  };
}

function createDefaultBoard(): BattleshipPlayerBoard {
  const [carrier, battleship, cruiser, submarine, destroyer] = BATTLESHIP_FLEET;
  return {
    ships: [
      horizontalShip(carrier, 0, 0),
      verticalShip(battleship, 2, 1),
      horizontalShip(cruiser, 4, 5),
      verticalShip(submarine, 6, 8),
      horizontalShip(destroyer, 8, 2),
    ],
    shotsReceived: [],
  };
}

export function createInitialBattleshipState(): BattleshipGameState {
  return createBattleshipStateWithBoards(createDefaultBoard(), createDefaultBoard());
}

export function createBattleshipStateWithBoards(
  blue: BattleshipPlayerBoard,
  orange: BattleshipPlayerBoard
): BattleshipGameState {
  const blueValidation = validateBattleshipFleet(blue.ships);
  if (!blueValidation.ok) {
    throw new Error(`Invalid blue fleet: ${blueValidation.error}`);
  }

  const orangeValidation = validateBattleshipFleet(orange.ships);
  if (!orangeValidation.ok) {
    throw new Error(`Invalid orange fleet: ${orangeValidation.error}`);
  }

  return {
    boards: {
      blue: cloneBoard(blue),
      orange: cloneBoard(orange),
    },
    turn: "blue",
    status: "playing",
    winner: null,
    moveHistory: [],
  };
}

export function targetToLabel(target: BattleshipCoordinate): string {
  return `${ROW_LABELS[target.row] ?? "?"}${target.column + 1}`;
}

export function parseBattleshipTargetLabel(
  value: string
): BattleshipCoordinate | null {
  const match = /^([A-J])\s*(10|[1-9])$/i.exec(value.trim());
  if (!match) return null;
  const row = ROW_LABELS.indexOf(match[1].toUpperCase());
  const column = Number.parseInt(match[2], 10) - 1;
  return isInBounds({ row, column }) ? { row, column } : null;
}

export function createBattleshipShip(
  definition: BattleshipShipDefinition,
  start: BattleshipCoordinate,
  orientation: BattleshipOrientation
): BattleshipShip {
  return {
    ...definition,
    cells: Array.from({ length: definition.size }, (_, index) =>
      orientation === "horizontal"
        ? { row: start.row, column: start.column + index }
        : { row: start.row + index, column: start.column }
    ),
  };
}

export function createBattleshipFleetFromPlacements(
  placements: BattleshipShipPlacement[]
): BattleshipFleetValidationResult {
  const ships: BattleshipShip[] = [];

  for (const placement of placements) {
    const definition = BATTLESHIP_FLEET.find(
      (ship) => ship.id === placement.id
    );
    if (!definition) {
      return { ok: false, error: `Unknown ship: ${placement.id}` };
    }

    const start = parseBattleshipTargetLabel(placement.start);
    if (!start) {
      return {
        ok: false,
        error: `Invalid start coordinate for ${definition.name}.`,
      };
    }

    ships.push(createBattleshipShip(definition, start, placement.orientation));
  }

  return validateBattleshipFleet(ships);
}

export function canPlaceBattleshipShip(
  existingShips: BattleshipShip[],
  definition: BattleshipShipDefinition,
  start: BattleshipCoordinate,
  orientation: BattleshipOrientation
): boolean {
  const candidate = createBattleshipShip(definition, start, orientation);
  return validateShipAgainstFleet(candidate, existingShips);
}

export function validateBattleshipFleet(
  ships: BattleshipShip[]
): BattleshipFleetValidationResult {
  if (ships.length !== BATTLESHIP_FLEET.length) {
    return {
      ok: false,
      error: `Expected ${BATTLESHIP_FLEET.length} ships, received ${ships.length}.`,
    };
  }

  const expectedDefinitions = new Map(
    BATTLESHIP_FLEET.map((definition) => [definition.id, definition])
  );
  const seenShipIds = new Set<string>();
  const occupied = new Set<string>();

  for (const ship of ships) {
    const definition = expectedDefinitions.get(ship.id);
    if (!definition) {
      return { ok: false, error: `Unknown ship: ${ship.id}` };
    }
    if (seenShipIds.has(ship.id)) {
      return { ok: false, error: `Duplicate ship: ${ship.id}` };
    }
    seenShipIds.add(ship.id);

    if (ship.name !== definition.name || ship.size !== definition.size) {
      return { ok: false, error: `Ship metadata mismatch: ${ship.id}` };
    }
    if (ship.cells.length !== definition.size) {
      return { ok: false, error: `${ship.name} has the wrong size.` };
    }

    const shipCells = new Set<string>();
    for (const cell of ship.cells) {
      if (!isInBounds(cell)) {
        return { ok: false, error: `${ship.name} extends outside the board.` };
      }
      const key = keyOf(cell);
      if (shipCells.has(key)) {
        return { ok: false, error: `${ship.name} overlaps itself.` };
      }
      if (occupied.has(key)) {
        return { ok: false, error: `${ship.name} overlaps another ship.` };
      }
      shipCells.add(key);
      occupied.add(key);
    }

    if (!isStraightContiguousShip(ship)) {
      return { ok: false, error: `${ship.name} is not straight and contiguous.` };
    }
  }

  for (const definition of BATTLESHIP_FLEET) {
    if (!seenShipIds.has(definition.id)) {
      return { ok: false, error: `Missing ship: ${definition.id}` };
    }
  }

  return { ok: true, ships: ships.map(cloneShip) };
}

export function createBattleshipBoard(
  ships: BattleshipShip[]
): BattleshipPlayerBoard {
  const validation = validateBattleshipFleet(ships);
  if (!validation.ok) {
    throw new Error(validation.error);
  }

  return {
    ships: validation.ships,
    shotsReceived: [],
  };
}

export function createRandomBattleshipBoard(
  rng: () => number = Math.random
): BattleshipPlayerBoard {
  const ships: BattleshipShip[] = [];

  for (const definition of BATTLESHIP_FLEET) {
    const candidates: Array<{
      start: BattleshipCoordinate;
      orientation: BattleshipOrientation;
    }> = [];

    for (const orientation of ["horizontal", "vertical"] as const) {
      for (let row = 0; row < BATTLESHIP_BOARD_SIZE; row++) {
        for (let column = 0; column < BATTLESHIP_BOARD_SIZE; column++) {
          const start = { row, column };
          const candidate = createBattleshipShip(definition, start, orientation);
          if (validateShipAgainstFleet(candidate, ships)) {
            candidates.push({ start, orientation });
          }
        }
      }
    }

    if (candidates.length === 0) {
      throw new Error(`Could not place ${definition.name}.`);
    }

    const index = Math.min(
      candidates.length - 1,
      Math.max(0, Math.floor(rng() * candidates.length))
    );
    const placement = candidates[index];
    ships.push(
      createBattleshipShip(definition, placement.start, placement.orientation)
    );
  }

  return createBattleshipBoard(ships);
}

export function isInBounds(target: BattleshipCoordinate): boolean {
  return (
    Number.isInteger(target.row) &&
    Number.isInteger(target.column) &&
    target.row >= 0 &&
    target.row < BATTLESHIP_BOARD_SIZE &&
    target.column >= 0 &&
    target.column < BATTLESHIP_BOARD_SIZE
  );
}

function isStraightContiguousShip(ship: BattleshipShip): boolean {
  if (ship.cells.length === 0) return false;

  const sameRow = ship.cells.every((cell) => cell.row === ship.cells[0].row);
  const sameColumn = ship.cells.every(
    (cell) => cell.column === ship.cells[0].column
  );
  if (!sameRow && !sameColumn) return false;

  const values = ship.cells
    .map((cell) => (sameRow ? cell.column : cell.row))
    .sort((a, b) => a - b);

  return values.every((value, index) =>
    index === 0 ? true : value === values[index - 1] + 1
  );
}

function validateShipAgainstFleet(
  ship: BattleshipShip,
  existingShips: BattleshipShip[]
): boolean {
  if (!isStraightContiguousShip(ship)) return false;
  if (!ship.cells.every(isInBounds)) return false;

  const occupied = new Set(
    existingShips.flatMap((existing) =>
      existing.cells.map((cell) => keyOf(cell))
    )
  );
  return ship.cells.every((cell) => !occupied.has(keyOf(cell)));
}

export function isLegalBattleshipTarget(
  state: BattleshipGameState,
  player: BattleshipPlayer,
  target: BattleshipCoordinate
): boolean {
  if (state.status !== "playing") return false;
  if (!isInBounds(target)) return false;
  const opponent = opponentOf(player);
  return !state.boards[opponent].shotsReceived.some(
    (shot) => keyOf(shot.target) === keyOf(target)
  );
}

export function getAvailableBattleshipTargets(
  state: BattleshipGameState,
  player: BattleshipPlayer
): BattleshipCoordinate[] {
  const targets: BattleshipCoordinate[] = [];
  for (let row = 0; row < BATTLESHIP_BOARD_SIZE; row++) {
    for (let column = 0; column < BATTLESHIP_BOARD_SIZE; column++) {
      const target = { row, column };
      if (isLegalBattleshipTarget(state, player, target)) {
        targets.push(target);
      }
    }
  }
  return targets;
}

function shipAt(
  board: BattleshipPlayerBoard,
  target: BattleshipCoordinate
): BattleshipShip | null {
  return (
    board.ships.find((ship) =>
      ship.cells.some((cell) => keyOf(cell) === keyOf(target))
    ) ?? null
  );
}

function isShipSunk(
  board: BattleshipPlayerBoard,
  ship: BattleshipShip,
  extraShot?: BattleshipCoordinate
): boolean {
  const hitKeys = new Set(
    board.shotsReceived
      .filter((shot) => shot.shipId === ship.id)
      .map((shot) => keyOf(shot.target))
  );
  if (extraShot) hitKeys.add(keyOf(extraShot));
  return ship.cells.every((cell) => hitKeys.has(keyOf(cell)));
}

function allShipsSunk(board: BattleshipPlayerBoard): boolean {
  return board.ships.every((ship) => isShipSunk(board, ship));
}

export function fireBattleshipShot(
  state: BattleshipGameState,
  target: BattleshipCoordinate,
  timestamp: number
): BattleshipGameState {
  const player = state.turn;
  if (!isLegalBattleshipTarget(state, player, target)) {
    throw new Error(`Illegal Battleship target: ${targetToLabel(target)}.`);
  }

  const opponent = opponentOf(player);
  const nextBoards = {
    blue: cloneBoard(state.boards.blue),
    orange: cloneBoard(state.boards.orange),
  };
  const targetBoard = nextBoards[opponent];
  const ship = shipAt(targetBoard, target);
  let result: BattleshipShotResult = ship ? "hit" : "miss";
  const shot: BattleshipShotRecord = {
    target: cloneCoordinate(target),
    result,
    ...(ship ? { shipId: ship.id } : {}),
    timestamp,
  };

  if (ship && isShipSunk(targetBoard, ship, target)) {
    result = "sunk";
    shot.result = result;
    shot.sunkShipId = ship.id;
  }

  targetBoard.shotsReceived.push(shot);
  const didWin = allShipsSunk(targetBoard);
  const move: BattleshipMoveRecord = {
    ...shot,
    player,
    displayTarget: targetToLabel(target),
  };

  return {
    boards: nextBoards,
    turn: didWin ? player : opponent,
    status: didWin ? "win" : "playing",
    winner: didWin ? player : null,
    moveHistory: [...state.moveHistory, move],
  };
}

export function setBattleshipPaused(
  state: BattleshipGameState,
  paused: boolean
): BattleshipGameState {
  if (paused && state.status === "playing") {
    return { ...state, status: "paused" };
  }
  if (!paused && state.status === "paused") {
    return { ...state, status: "playing" };
  }
  return state;
}

export function attachBattleshipAIInteractionToLatestMove(
  state: BattleshipGameState,
  aiInteraction: BattleshipMoveRecord["aiInteraction"]
): BattleshipGameState {
  if (!aiInteraction || state.moveHistory.length === 0) return state;
  return {
    ...state,
    moveHistory: state.moveHistory.map((move, index) =>
      index === state.moveHistory.length - 1
        ? { ...move, aiInteraction }
        : move
    ),
  };
}
