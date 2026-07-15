/* Connect Four depth-oracle unit checks. */
import {
  classifyConnectFourColumns,
  detectBottomRow,
} from "../lib/benchmark/gameiq/connect-four-solver";
import { referenceClassify } from "./lib-gameiq-c4-reference.mjs";

type Cell = "red" | "yellow" | null;
type Stack = Array<Exclude<Cell, null>>;

let failures = 0;
function check(name: string, ok: boolean, detail?: unknown): void {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` -> ${JSON.stringify(detail)}`}`);
}

function boardFromStacks(stacks: Stack[]): Cell[][] {
  const board = Array.from({ length: 6 }, () => Array<Cell>(7).fill(null));
  for (let col = 0; col < 7; col++) {
    for (let height = 0; height < (stacks[col]?.length ?? 0); height++) {
      board[5 - height][col] = stacks[col][height];
    }
  }
  return board;
}

function rank(moveClass: "win" | "draw" | "loss"): number {
  return moveClass === "win" ? 2 : moveClass === "draw" ? 1 : 0;
}

function classAt(
  classes: Array<{ column: number; moveClass: "win" | "draw" | "loss" }>,
  column: number
) {
  return classes.find((entry) => entry.column === column)?.moveClass;
}

const verticalBoard = boardFromStacks([
  ["red", "red", "red"],
  ["yellow", "yellow", "red", "red", "yellow", "red"],
  ["red", "red", "yellow", "yellow", "red", "yellow"],
  ["yellow", "red", "red", "yellow", "yellow", "yellow"],
  ["yellow", "red", "yellow", "red", "red"],
  ["yellow", "yellow", "red", "yellow", "yellow", "red"],
  ["red", "yellow", "red", "red", "yellow", "yellow"],
]);
const verticalRed = classifyConnectFourColumns(verticalBoard, "red");
check("vertical completion is a win", classAt(verticalRed, 0) === "win", verticalRed);

const blockBoard = boardFromStacks([
  ["red", "yellow", "red", "yellow", "red"],
  ["yellow", "yellow", "red", "yellow"],
  ["red", "yellow", "yellow", "red", "red"],
  ["red", "red", "yellow", "red"],
  ["yellow", "red", "red", "red", "yellow"],
  ["red", "yellow", "red", "yellow", "red"],
  ["red", "red", "red", "yellow", "red"],
]);
const blockYellow = classifyConnectFourColumns(blockBoard, "yellow");
check(
  "defender's block is strictly better than every alternative",
  classAt(blockYellow, 3) !== undefined &&
    blockYellow
      .filter((entry) => entry.column !== 3)
      .every((entry) => rank(classAt(blockYellow, 3)!) > rank(entry.moveClass)),
  blockYellow
);

const nearFullStacks: Stack[] = [
  ["yellow", "red", "red", "red", "yellow", "red"],
  ["red", "yellow", "yellow", "yellow", "red", "yellow"],
  ["red", "red", "red", "yellow", "yellow", "yellow"],
  ["yellow", "red", "yellow", "red", "red"],
  ["red", "red", "red", "yellow", "yellow", "red"],
  ["red", "yellow", "yellow", "yellow", "red", "yellow"],
  ["yellow", "red", "red", "yellow", "yellow", "yellow"],
];
const nearFullWinStacks: Stack[] = [
  ["yellow", "red", "red", "red", "yellow", "red"],
  ["red", "yellow", "yellow", "yellow", "red", "red"],
  ["red", "red", "red", "yellow", "yellow", "red"],
  ["yellow", "red", "yellow", "red", "red"],
  ["red", "red", "red", "yellow", "yellow", "yellow"],
  ["red", "yellow", "yellow", "yellow", "red", "yellow"],
  ["red", "yellow", "red", "red", "yellow", "yellow"],
];
const nearFullBoard = boardFromStacks(nearFullStacks);
const nearFullWinBoard = boardFromStacks(nearFullWinStacks);
const nearFullRed = classifyConnectFourColumns(nearFullBoard, "red");
const nearFullWinRed = classifyConnectFourColumns(nearFullWinBoard, "red");
check("near-full non-winning fill is a draw", classAt(nearFullRed, 3) === "draw", nearFullRed);
check("near-full winning fill is a win", classAt(nearFullWinRed, 3) === "win", nearFullWinRed);

const reversedNearFull = nearFullBoard.slice().reverse();
check(
  "bottom-first orientation preserves classifications",
  detectBottomRow(reversedNearFull) === 0 &&
    JSON.stringify(classifyConnectFourColumns(reversedNearFull, "red")) ===
      JSON.stringify(nearFullRed),
  classifyConnectFourColumns(reversedNearFull, "red")
);

const floating = nearFullBoard.map((row) => [...row]);
floating[4][0] = "red";
floating[5][0] = null;
let floatingError = "";
try {
  detectBottomRow(floating);
} catch (error) {
  floatingError = error instanceof Error ? error.message : String(error);
}
check(
  "floating discs are rejected",
  floatingError.includes("floating discs") || floatingError.includes("inconsistent gravity"),
  floatingError
);

const redReference = referenceClassify(nearFullBoard, "red", 5);
const winReference = referenceClassify(nearFullWinBoard, "red", 5);
check("independent reference agrees for red", JSON.stringify(redReference) === JSON.stringify(nearFullRed), {
  redReference,
  nearFullRed,
});
check("independent reference agrees for winning board", JSON.stringify(winReference) === JSON.stringify(nearFullWinRed), {
  winReference,
  nearFullWinRed,
});
check(
  "classification is deterministic",
  JSON.stringify(classifyConnectFourColumns(verticalBoard, "red")) ===
    JSON.stringify(classifyConnectFourColumns(verticalBoard, "red"))
);

if (failures > 0) {
  console.log(`FAIL ${failures} check(s) failed`);
  process.exitCode = 1;
} else {
  console.log("PASS");
}
