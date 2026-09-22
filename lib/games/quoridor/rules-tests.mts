/* Quoridor rules regression checks (run: npx tsx lib/games/quoridor/rules-tests.mts) */
import {
  QUORIDOR_SIZE,
  QUORIDOR_WALL_GRID,
  QUORIDOR_WALLS_PER_PLAYER,
  applyQuoridorAction,
  createInitialQuoridorState,
  getLegalActions,
  hasPathToGoal,
  isLegalAction,
  setQuoridorPaused,
} from "./engine";
import type {
  QuoridorAction,
  QuoridorGameState,
  QuoridorWall,
} from "./types";

let failures = 0;

function check(name: string, ok: boolean, detail?: unknown): void {
  if (!ok) failures++;
  console.log(
    `${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` -> ${JSON.stringify(detail)}`}`
  );
}

function play(
  actions: QuoridorAction[],
  startedAt = 1_000
): QuoridorGameState {
  return actions.reduce(
    (state, action, index) =>
      applyQuoridorAction(state, action, startedAt + index + 1),
    createInitialQuoridorState(startedAt)
  );
}

function move(row: number, col: number): QuoridorAction {
  return { type: "move", row, col };
}

function wall(
  row: number,
  col: number,
  orientation: QuoridorWall["orientation"]
): QuoridorAction {
  return { type: "wall", row, col, orientation };
}

function hasAction(
  actions: QuoridorAction[],
  expected: QuoridorAction
): boolean {
  return actions.some((action) => actionEquals(action, expected));
}

function actionEquals(left: QuoridorAction, right: QuoridorAction): boolean {
  if (left.type !== right.type) return false;
  if (left.type === "move" && right.type === "move") {
    return left.row === right.row && left.col === right.col;
  }
  if (left.type === "wall" && right.type === "wall") {
    return (
      left.row === right.row &&
      left.col === right.col &&
      left.orientation === right.orientation
    );
  }
  return false;
}

function expectThrows(name: string, fn: () => void, match: string): void {
  try {
    fn();
    check(name, false, "expected throw");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    check(name, message.includes(match), { message });
  }
}

const initial = createInitialQuoridorState(1_000);
check(
  "applyQuoridorAction requires explicit timestamp",
  applyQuoridorAction.length === 3,
  { arity: applyQuoridorAction.length }
);
check(
  "board is 9x9 with an 8x8 wall intersection grid",
  QUORIDOR_SIZE === 9 && QUORIDOR_WALL_GRID === 8,
  { size: QUORIDOR_SIZE, wallGrid: QUORIDOR_WALL_GRID }
);
check("south starts", initial.turn === "south", { turn: initial.turn });
check(
  "pawns start on opposite center squares",
  initial.pawns.south.row === 8 &&
    initial.pawns.south.col === 4 &&
    initial.pawns.north.row === 0 &&
    initial.pawns.north.col === 4,
  initial.pawns
);
check(
  "each player starts with 10 walls",
  initial.wallsLeft.south === QUORIDOR_WALLS_PER_PLAYER &&
    initial.wallsLeft.north === QUORIDOR_WALLS_PER_PLAYER &&
    QUORIDOR_WALLS_PER_PLAYER === 10,
  initial.wallsLeft
);
check(
  "aggregate clock starts at zero for both players",
  initial.clock.southElapsedMs === 0 &&
    initial.clock.northElapsedMs === 0 &&
    initial.clock.turnStartedAt === 1_000,
  initial.clock
);
check(
  "both players have a path to their goal on an empty board",
  hasPathToGoal(initial, "south") && hasPathToGoal(initial, "north")
);

const southLegal = getLegalActions(initial);
check(
  "south can step orthogonally from e1",
  hasAction(southLegal, move(7, 4)) &&
    hasAction(southLegal, move(8, 3)) &&
    hasAction(southLegal, move(8, 5)) &&
    !hasAction(southLegal, move(8, 4)) &&
    !hasAction(southLegal, move(9, 4)),
  southLegal.filter((action) => action.type === "move")
);
check(
  "south cannot move diagonally",
  !hasAction(southLegal, move(7, 3)) && !hasAction(southLegal, move(7, 5))
);

const afterSouthStep = applyQuoridorAction(initial, move(7, 4), 1_100);
check(
  "turn alternates after a pawn move",
  afterSouthStep.turn === "north" &&
    afterSouthStep.pawns.south.row === 7 &&
    afterSouthStep.pawns.south.col === 4,
  afterSouthStep.pawns
);
check(
  "pawn move adds elapsed time to the player who moved",
  afterSouthStep.clock.southElapsedMs === 100 &&
    afterSouthStep.clock.northElapsedMs === 0,
  afterSouthStep.clock
);

const pausedState = setQuoridorPaused(initial, true, 1_750);
const unpausedState = setQuoridorPaused(pausedState, false, 2_000);
check(
  "paused games have no legal actions and can resume playing",
  pausedState.status === "paused" &&
    getLegalActions(pausedState).length === 0 &&
    unpausedState.status === "playing",
  { pausedStatus: pausedState.status, unpausedStatus: unpausedState.status }
);
check(
  "pause freezes active player elapsed time and resume restarts that turn",
  pausedState.clock.southElapsedMs === 750 &&
    pausedState.clock.northElapsedMs === 0 &&
    pausedState.clock.turnStartedAt === null &&
    unpausedState.clock.southElapsedMs === 750 &&
    unpausedState.clock.turnStartedAt === 2_000,
  { paused: pausedState.clock, resumed: unpausedState.clock }
);

expectThrows(
  "illegal pawn move throws",
  () => applyQuoridorAction(initial, move(6, 4), 1_200),
  "Illegal"
);

const afterHorizontalWall = applyQuoridorAction(
  initial,
  wall(7, 3, "H"),
  1_300
);
check(
  "horizontal wall uses 0-7 intersection coordinates and spends a wall",
  afterHorizontalWall.walls.length === 1 &&
    afterHorizontalWall.walls[0].row === 7 &&
    afterHorizontalWall.walls[0].col === 3 &&
    afterHorizontalWall.walls[0].orientation === "H" &&
    afterHorizontalWall.wallsLeft.south === 9,
  {
    walls: afterHorizontalWall.walls,
    wallsLeft: afterHorizontalWall.wallsLeft,
  }
);
check(
  "horizontal wall blocks the two vertical edges it covers",
  !isLegalAction(
    { ...afterHorizontalWall, turn: "south" },
    move(7, 4)
  ) &&
    !isLegalAction(
      {
        ...afterHorizontalWall,
        turn: "south",
        pawns: { south: { row: 8, col: 3 }, north: { row: 0, col: 4 } },
      },
      move(7, 3)
    )
);

const afterVerticalWall = applyQuoridorAction(initial, wall(7, 3, "V"), 1_400);
check(
  "vertical wall blocks the two horizontal edges it covers",
  !isLegalAction(
    { ...afterVerticalWall, turn: "south" },
    move(8, 3)
  )
);

expectThrows(
  "wall outside the 0-7 intersection grid is rejected",
  () => applyQuoridorAction(initial, wall(8, 0, "H"), 1_500),
  "Illegal"
);

const overlappingBase = applyQuoridorAction(initial, wall(3, 3, "H"), 1_600);
check(
  "identical wall overlap is illegal",
  !isLegalAction(overlappingBase, wall(3, 3, "H"))
);
check(
  "same-orientation walls that share a segment overlap",
  !isLegalAction(overlappingBase, wall(3, 4, "H")) &&
    !isLegalAction(overlappingBase, wall(3, 2, "H"))
);
check(
  "crossing H and V walls at the same intersection is illegal",
  !isLegalAction(overlappingBase, wall(3, 3, "V"))
);
check(
  "non-overlapping nearby walls remain legal",
  isLegalAction(overlappingBase, wall(3, 5, "H")) &&
    isLegalAction(overlappingBase, wall(4, 3, "H")) &&
    isLegalAction(overlappingBase, wall(3, 4, "V"))
);

function approachForJump(): QuoridorGameState {
  return play([
    move(7, 4),
    move(1, 4),
    move(6, 4),
    move(2, 4),
    move(5, 4),
    move(3, 4),
    move(4, 4),
    wall(0, 0, "H"),
  ]);
}

const faceToFace = approachForJump();
check(
  "straight jump: adjacent opponent with open square behind",
  faceToFace.pawns.south.row === 4 &&
    faceToFace.pawns.south.col === 4 &&
    faceToFace.pawns.north.row === 3 &&
    faceToFace.pawns.north.col === 4 &&
    isLegalAction(faceToFace, move(2, 4)),
  faceToFace.pawns
);
check(
  "straight jump is not also offered as a diagonal when behind is open",
  !isLegalAction(faceToFace, move(3, 3)) &&
    !isLegalAction(faceToFace, move(3, 5))
);

const afterStraightJump = applyQuoridorAction(faceToFace, move(2, 4), 2_000);
check(
  "straight jump lands on the square behind the opponent",
  afterStraightJump.pawns.south.row === 2 &&
    afterStraightJump.pawns.south.col === 4 &&
    afterStraightJump.pawns.north.row === 3,
  afterStraightJump.pawns
);

const diagonalSetup = play([
  move(7, 4),
  move(1, 4),
  move(6, 4),
  move(2, 4),
  move(5, 4),
  move(3, 4),
  move(4, 4),
  wall(2, 4, "H"),
]);
check(
  "diagonal jump: square behind opponent is blocked by a wall",
  isLegalAction(diagonalSetup, move(3, 3)) &&
    isLegalAction(diagonalSetup, move(3, 5)) &&
    !isLegalAction(diagonalSetup, move(2, 4)),
  getLegalActions(diagonalSetup).filter((action) => action.type === "move")
);

const edgeJumpSetup = play([
  move(7, 4),
  move(0, 5),
  move(6, 4),
  move(0, 4),
  move(5, 4),
  move(0, 5),
  move(4, 4),
  move(0, 4),
  move(3, 4),
  move(0, 5),
  move(2, 4),
  move(0, 4),
  move(1, 4),
  wall(7, 0, "H"),
]);
check(
  "diagonal jump: square behind opponent is off the board edge",
  edgeJumpSetup.pawns.south.row === 1 &&
    edgeJumpSetup.pawns.north.row === 0 &&
    edgeJumpSetup.pawns.north.col === 4 &&
    isLegalAction(edgeJumpSetup, move(0, 3)) &&
    isLegalAction(edgeJumpSetup, move(0, 5)) &&
    !isLegalAction(edgeJumpSetup, move(-1, 4)),
  {
    pawns: edgeJumpSetup.pawns,
    moves: getLegalActions(edgeJumpSetup).filter(
      (action) => action.type === "move"
    ),
  }
);

const noJumpSetup = play([
  move(7, 4),
  move(1, 4),
  move(6, 4),
  move(2, 4),
  move(5, 4),
  move(3, 4),
  wall(3, 4, "H"),
  wall(5, 0, "H"),
  move(4, 4),
  wall(5, 2, "H"),
]);
check(
  "no jump when a wall stands between the pawns",
  noJumpSetup.pawns.south.row === 4 &&
    noJumpSetup.pawns.north.row === 3 &&
    !isLegalAction(noJumpSetup, move(2, 4)) &&
    !isLegalAction(noJumpSetup, move(3, 3)) &&
    !isLegalAction(noJumpSetup, move(3, 5)) &&
    isLegalAction(noJumpSetup, move(4, 3)),
  {
    pawns: noJumpSetup.pawns,
    moves: getLegalActions(noJumpSetup).filter((action) => action.type === "move"),
  }
);

const opponentTrap = play([
  wall(0, 3, "H"),
  move(0, 5),
  wall(0, 2, "V"),
  move(0, 4),
]);
check(
  "BFS rejects a wall that blocks the opponent's last path",
  !isLegalAction(opponentTrap, wall(0, 4, "V")) &&
    hasPathToGoal(opponentTrap, "north") &&
    hasPathToGoal(opponentTrap, "south"),
  {
    northPath: hasPathToGoal(opponentTrap, "north"),
    legalWall: isLegalAction(opponentTrap, wall(0, 4, "V")),
  }
);

const selfTrap = play([
  wall(7, 3, "H"),
  move(1, 4),
  wall(7, 2, "V"),
  move(0, 4),
]);
check(
  "BFS rejects a wall that blocks the placing player's own last path",
  !isLegalAction(selfTrap, wall(7, 4, "V")) &&
    hasPathToGoal(selfTrap, "south") &&
    hasPathToGoal(selfTrap, "north"),
  {
    southPath: hasPathToGoal(selfTrap, "south"),
    legalWall: isLegalAction(selfTrap, wall(7, 4, "V")),
  }
);

expectThrows(
  "placing a blocking wall throws",
  () => applyQuoridorAction(opponentTrap, wall(0, 4, "V"), 9_000),
  "path"
);

const towardGoal = play([
  move(7, 4),
  move(0, 5),
  move(6, 4),
  move(0, 4),
  move(5, 4),
  move(0, 5),
  move(4, 4),
  move(0, 4),
  move(3, 4),
  move(0, 5),
  move(2, 4),
  move(0, 4),
  move(1, 4),
  move(0, 5),
]);
const southWin = applyQuoridorAction(towardGoal, move(0, 4), 10_000);
check(
  "south wins by reaching the opposite row",
  southWin.status === "win" &&
    southWin.winner === "south" &&
    southWin.pawns.south.row === 0,
  { status: southWin.status, winner: southWin.winner, pawns: southWin.pawns }
);
check(
  "finished games have no legal actions",
  getLegalActions(southWin).length === 0
);
expectThrows(
  "acting after a finished game throws",
  () => applyQuoridorAction(southWin, move(0, 3), 10_100),
  "ended"
);

const noWallsLeft: QuoridorGameState = {
  ...initial,
  wallsLeft: { south: 0, north: 10 },
};
check(
  "a player with zero walls cannot place one",
  !getLegalActions(noWallsLeft).some((action) => action.type === "wall") &&
    !isLegalAction(noWallsLeft, wall(3, 3, "H"))
);

if (failures > 0) {
  console.log(`\n${failures} FAIL`);
  process.exit(1);
}

console.log("\nPASS");
