import {
  BATTLESHIP_BOARD_SIZE,
  BATTLESHIP_FLEET,
  canPlaceBattleshipShip,
  createBattleshipBoard,
  createBattleshipFleetFromPlacements,
  getBattleshipPlacementPreview,
  createBattleshipStateWithBoards,
  createInitialBattleshipState,
  createRandomBattleshipBoard,
  fireBattleshipShot,
  getAvailableBattleshipTargets,
  isLegalBattleshipTarget,
  targetToLabel,
  validateBattleshipFleet,
} from "./engine";

let failures = 0;

function check(name: string, ok: boolean, detail?: unknown): void {
  if (!ok) failures++;
  console.log(
    `${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` -> ${JSON.stringify(detail)}`}`
  );
}

const initial = createInitialBattleshipState();

check("board is 10 by 10", BATTLESHIP_BOARD_SIZE === 10, BATTLESHIP_BOARD_SIZE);
check(
  "fleet has classic ship sizes",
  BATTLESHIP_FLEET.map((ship) => ship.size).join(",") === "5,4,3,3,2",
  BATTLESHIP_FLEET
);
const customFleet = createBattleshipFleetFromPlacements([
  { id: "carrier", start: "A1", orientation: "horizontal" },
  { id: "battleship", start: "C1", orientation: "vertical" },
  { id: "cruiser", start: "J1", orientation: "horizontal" },
  { id: "submarine", start: "F6", orientation: "vertical" },
  { id: "destroyer", start: "H3", orientation: "horizontal" },
]);
check("custom fleet placement is accepted", customFleet.ok, customFleet);
check(
  "custom fleet creates every ship once",
  customFleet.ok && customFleet.ships.length === BATTLESHIP_FLEET.length,
  customFleet
);
check(
  "overlapping custom fleet is rejected",
  !createBattleshipFleetFromPlacements([
    { id: "carrier", start: "A1", orientation: "horizontal" },
    { id: "battleship", start: "A1", orientation: "vertical" },
    { id: "cruiser", start: "J1", orientation: "horizontal" },
    { id: "submarine", start: "F6", orientation: "vertical" },
    { id: "destroyer", start: "H3", orientation: "horizontal" },
  ]).ok
);
check(
  "out of bounds custom fleet is rejected",
  !createBattleshipFleetFromPlacements([
    { id: "carrier", start: "A7", orientation: "horizontal" },
    { id: "battleship", start: "C1", orientation: "vertical" },
    { id: "cruiser", start: "J1", orientation: "horizontal" },
    { id: "submarine", start: "F6", orientation: "vertical" },
    { id: "destroyer", start: "H3", orientation: "horizontal" },
  ]).ok
);
const randomBoard = createRandomBattleshipBoard(() => 0.42);
check(
  "auto placement creates a valid fleet",
  validateBattleshipFleet(randomBoard.ships).ok,
  randomBoard
);
const carrierDefinition = BATTLESHIP_FLEET.find((ship) => ship.id === "carrier")!;
const cruiserDefinition = BATTLESHIP_FLEET.find((ship) => ship.id === "cruiser")!;
const destroyerDefinition = BATTLESHIP_FLEET.find(
  (ship) => ship.id === "destroyer"
)!;
const horizontalPreview = getBattleshipPlacementPreview(
  [],
  carrierDefinition,
  { row: 0, column: 0 },
  "horizontal"
);
check(
  "placement preview includes every horizontal ship cell",
  horizontalPreview.isValid &&
    horizontalPreview.cells.map(targetToLabel).join(",") === "A1,A2,A3,A4,A5",
  horizontalPreview
);
const verticalPreview = getBattleshipPlacementPreview(
  [],
  destroyerDefinition,
  { row: 8, column: 9 },
  "vertical"
);
check(
  "placement preview includes every vertical ship cell",
  verticalPreview.isValid &&
    verticalPreview.cells.map(targetToLabel).join(",") === "I10,J10",
  verticalPreview
);
const outOfBoundsPreview = getBattleshipPlacementPreview(
  [],
  cruiserDefinition,
  { row: 0, column: 8 },
  "horizontal"
);
check(
  "placement preview keeps off-board cells but marks them invalid",
  !outOfBoundsPreview.isValid &&
    outOfBoundsPreview.outOfBounds &&
    outOfBoundsPreview.cells.map((cell) => `${cell.row}:${cell.column}`).join(",") ===
      "0:8,0:9,0:10",
  outOfBoundsPreview
);
if (customFleet.ok) {
  const carrier = customFleet.ships.find((ship) => ship.id === "carrier");
  check(
    "partial placement rejects a ship overlapping existing cells",
    Boolean(carrier && destroyerDefinition) &&
      !canPlaceBattleshipShip(
        carrier ? [carrier] : [],
        destroyerDefinition,
        { row: 0, column: 0 },
        "vertical"
      )
  );
  const overlapPreview = getBattleshipPlacementPreview(
    carrier ? [carrier] : [],
    destroyerDefinition,
    { row: 0, column: 1 },
    "horizontal"
  );
  check(
    "placement preview marks overlapping cells invalid",
    !overlapPreview.isValid && overlapPreview.overlaps,
    overlapPreview
  );
  const customState = createBattleshipStateWithBoards(
    createBattleshipBoard(customFleet.ships),
    randomBoard
  );
  check(
    "game can start from custom boards",
    customState.boards.blue.ships[0]?.cells[0]?.row === 0 &&
      customState.boards.orange.ships.length === BATTLESHIP_FLEET.length,
    customState
  );
}
check("blue starts", initial.turn === "blue", initial.turn);
check(
  "both players receive all ships",
  initial.boards.blue.ships.length === 5 &&
    initial.boards.orange.ships.length === 5,
  initial.boards
);
check(
  "initial target list has every enemy cell",
  getAvailableBattleshipTargets(initial, "blue").length === 100,
  getAvailableBattleshipTargets(initial, "blue").length
);
check(
  "coordinate labels use A1 style",
  targetToLabel({ row: 0, column: 0 }) === "A1" &&
    targetToLabel({ row: 9, column: 9 }) === "J10",
  [targetToLabel({ row: 0, column: 0 }), targetToLabel({ row: 9, column: 9 })]
);

const missState = fireBattleshipShot(initial, { row: 0, column: 9 }, 1_000);
check(
  "miss records a move and alternates turns",
  missState.turn === "orange" &&
    missState.moveHistory.length === 1 &&
    missState.moveHistory[0].result === "miss",
  missState.moveHistory[0]
);
check(
  "already targeted cell is illegal for the same attacker",
  !isLegalBattleshipTarget(missState, "blue", { row: 0, column: 9 }),
  missState.boards.orange.shotsReceived
);

const hitState = fireBattleshipShot(initial, { row: 0, column: 0 }, 2_000);
check(
  "hit records the target ship",
  hitState.moveHistory[0].result === "hit" &&
    hitState.moveHistory[0].shipId === "carrier",
  hitState.moveHistory[0]
);

let sinkingState = initial;
for (const [index, target] of [
  { row: 0, column: 0 },
  { row: 0, column: 1 },
  { row: 0, column: 2 },
  { row: 0, column: 3 },
  { row: 0, column: 4 },
].entries()) {
  sinkingState = {
    ...sinkingState,
    turn: "blue",
  };
  sinkingState = fireBattleshipShot(sinkingState, target, 3_000 + index);
}
check(
  "last hit on a ship reports sunk",
  sinkingState.moveHistory.at(-1)?.result === "sunk" &&
    sinkingState.moveHistory.at(-1)?.sunkShipId === "carrier",
  sinkingState.moveHistory.at(-1)
);

let winningState = initial;
for (const ship of initial.boards.orange.ships) {
  for (const [index, cell] of ship.cells.entries()) {
    winningState = { ...winningState, turn: "blue" };
    winningState = fireBattleshipShot(winningState, cell, 4_000 + index);
  }
}
check(
  "sinking every opponent ship wins the game",
  winningState.status === "win" && winningState.winner === "blue",
  { status: winningState.status, winner: winningState.winner }
);

if (failures === 0) {
  console.log("PASS");
} else {
  console.log(`FAIL ${failures} check(s) failed`);
}

process.exit(failures === 0 ? 0 : 1);
