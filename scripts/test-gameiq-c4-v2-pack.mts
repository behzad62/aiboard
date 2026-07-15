/* Certified GameIQ Connect Four v2 depth-pack checks
 *
 * This guard compares every authored scenario against the independent array
 * reference classifier. It also re-checks reachability, no-immediate-win depth
 * predicates, answer-leak resistance, and the partial-credit grading contract.
 */
import { performance } from "node:perf_hooks";
import { getLegalColumns } from "../lib/games/connect-four/engine";
import type {
  ConnectFourBoard,
  ConnectFourGameState,
  ConnectFourPlayer,
} from "../lib/games/connect-four/types";
import { CONNECT_FOUR_V2_GAMEIQ_SCENARIOS } from "../lib/benchmark/gameiq/connect-four-v2";
import { classifyConnectFourColumns } from "../lib/benchmark/gameiq/connect-four-solver";
import {
  getGameIqScenarioPackById,
  gameIqPackFirstClassFloor,
} from "../lib/benchmark/gameiq/packs";
import type {
  ConnectFourGameIqAction,
  ConnectFourGameIqScenario,
} from "../lib/benchmark/gameiq/types";
import {
  actionMatchesExpected,
  validateGameIqScenario,
} from "../lib/benchmark/gameiq/validation";
import { referenceClassify } from "./lib-gameiq-c4-reference.mts";

const PACK_ID = "gameiq-v0.2-connect-four";
const scenarios = CONNECT_FOUR_V2_GAMEIQ_SCENARIOS as ConnectFourGameIqScenario[];

let failures = 0;

function check(name: string, ok: boolean, detail?: unknown): void {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` -> ${JSON.stringify(detail)}`}`);
}

function other(player: ConnectFourPlayer): ConnectFourPlayer {
  return player === "red" ? "yellow" : "red";
}

function classRank(moveClass: "win" | "draw" | "loss"): number {
  return moveClass === "win" ? 2 : moveClass === "draw" ? 1 : 0;
}

function expectedColumns(scenario: ConnectFourGameIqScenario): number[] {
  return scenario.expectedActions.map(
    (expected) => (expected.action as ConnectFourGameIqAction).column
  );
}

function landingRow(board: ConnectFourBoard, column: number): number {
  for (let row = 5; row >= 0; row--) {
    if (board[row][column] === null) return row;
  }
  return -1;
}

function winsAt(
  board: ConnectFourBoard,
  row: number,
  column: number,
  player: ConnectFourPlayer
): boolean {
  for (const [deltaRow, deltaColumn] of [
    [0, 1],
    [1, 0],
    [1, 1],
    [1, -1],
  ] as const) {
    let count = 1;
    for (const direction of [1, -1] as const) {
      let nextRow = row + deltaRow * direction;
      let nextColumn = column + deltaColumn * direction;
      while (
        nextRow >= 0 &&
        nextRow < 6 &&
        nextColumn >= 0 &&
        nextColumn < 7 &&
        board[nextRow][nextColumn] === player
      ) {
        count++;
        nextRow += deltaRow * direction;
        nextColumn += deltaColumn * direction;
      }
    }
    if (count >= 4) return true;
  }
  return false;
}

function immediateWins(board: ConnectFourBoard, player: ConnectFourPlayer): number[] {
  const copy = board.map((row) => [...row]) as ConnectFourBoard;
  const wins: number[] = [];
  for (let column = 0; column < 7; column++) {
    const row = landingRow(copy, column);
    if (row < 0) continue;
    copy[row][column] = player;
    if (winsAt(copy, row, column, player)) wins.push(column);
    copy[row][column] = null;
  }
  return wins;
}

function boardFacts(state: ConnectFourGameState): {
  red: number;
  yellow: number;
  gravityOk: boolean;
} {
  let red = 0;
  let yellow = 0;
  let gravityOk = true;
  for (let column = 0; column < 7; column++) {
    let sawEmptyBelowDisc = false;
    for (let row = 5; row >= 0; row--) {
      const cell = state.board[row][column];
      if (cell === null) sawEmptyBelowDisc = true;
      else {
        if (cell === "red") red++;
        else yellow++;
        if (sawEmptyBelowDisc) gravityOk = false;
      }
    }
  }
  return { red, yellow, gravityOk };
}

function turnMatchesCounts(state: ConnectFourGameState, red: number, yellow: number): boolean {
  return state.turn === "red" ? red === yellow : red === yellow + 1;
}

check(`${PACK_ID}: pack has exactly 12 scenarios`, scenarios.length === 12, scenarios.length);
const pack = getGameIqScenarioPackById(PACK_ID);
check(
  `${PACK_ID}: registered pack contains the v2 scenarios`,
  pack?.scenarios.length === scenarios.length &&
    pack.scenarios.every((scenario) => scenario.id.startsWith(`${PACK_ID}-depth-`)),
  pack
);

const decisionKeys = new Set(
  scenarios.map((scenario) =>
    JSON.stringify({ initialState: scenario.initialState, expectedActions: scenario.expectedActions })
  )
);
check(`${PACK_ID}: has 12 distinct decisions`, decisionKeys.size === 12, decisionKeys.size);
const keyedColumnCounts = scenarios.reduce<Map<number, number>>((counts, scenario) => {
  const column = expectedColumns(scenario)[0];
  counts.set(column, (counts.get(column) ?? 0) + 1);
  return counts;
}, new Map());
const moverCounts = scenarios.reduce<Record<ConnectFourPlayer, number>>(
  (counts, scenario) => {
    const player = (scenario.initialState as ConnectFourGameState).turn;
    counts[player]++;
    return counts;
  },
  { red: 0, yellow: 0 }
);
check(
  `${PACK_ID}: no keyed column appears more than three times`,
  [...keyedColumnCounts.values()].every((count) => count <= 3),
  [...keyedColumnCounts.entries()]
);
check(
  `${PACK_ID}: both movers are represented at least four times`,
  moverCounts.red >= 4 && moverCounts.yellow >= 4,
  moverCounts
);

for (const scenario of scenarios) {
  const state = scenario.initialState as ConnectFourGameState;
  const board = state.board;
  const keyed = expectedColumns(scenario);
  const productionStartedAt = performance.now();
  const production = classifyConnectFourColumns(board, state.turn);
  const productionSolveMs = performance.now() - productionStartedAt;
  const reference = referenceClassify(board, state.turn, 5);
  const referenceByColumn = [...reference].sort((left, right) => left.column - right.column);
  const productionByColumn = [...production].sort((left, right) => left.column - right.column);
  const bestRank = Math.max(...reference.map((entry) => classRank(entry.moveClass)));
  const uniqueBest = reference.filter((entry) => classRank(entry.moveClass) === bestRank);
  const baits = reference.filter((entry) => classRank(entry.moveClass) === bestRank - 1);
  const twoStep = reference.filter((entry) => classRank(entry.moveClass) === bestRank - 2);
  const facts = boardFacts(state);
  const legalColumns = getLegalColumns(state);
  const moverWins = immediateWins(board, state.turn);
  const opponentWins = immediateWins(board, other(state.turn));
  const instruction = scenario.prompt.toLowerCase();
  const title = scenario.title.toLowerCase();
  const keyedDigits = keyed.map(String);
  const leakedDigits = keyedDigits.filter(
    (digit) => title.includes(digit) || instruction.includes(digit)
  );
  const leakedTactics = ["win", "block", "threat"].filter(
    (term) => title.includes(term) || instruction.includes(term)
  );

  check(
    `${scenario.id}: first production classification ${Math.round(productionSolveMs)}ms <= 1000ms`,
    productionSolveMs <= 1_000,
    { productionSolveMs: Math.round(productionSolveMs) }
  );
  check(
    `${scenario.id}: reference classifier agrees with production on every legal column`,
    JSON.stringify(referenceByColumn) === JSON.stringify(productionByColumn),
    { reference: referenceByColumn, production: productionByColumn }
  );
  check(
    `${scenario.id}: keyed set is the reference solver's unique best-class column`,
    keyed.length === 1 &&
      uniqueBest.length === 1 &&
      keyed[0] === uniqueBest[0]?.column,
    { keyed, uniqueBest }
  );
  check(
    `${scenario.id}: mover has no immediate win`,
    moverWins.length === 0,
    moverWins
  );
  check(
    `${scenario.id}: opponent has no immediate win`,
    opponentWins.length === 0,
    opponentWins
  );
  check(
    `${scenario.id}: has at least two one-class-step-worse bait columns`,
    baits.length >= 2,
    baits
  );
  check(
    `${scenario.id}: has at least three legal columns`,
    legalColumns.length >= 3,
    legalColumns
  );
  check(
    `${scenario.id}: board has legal alternating-move counts and gravity`,
    Math.abs(facts.red - facts.yellow) <= 1 &&
      turnMatchesCounts(state, facts.red, facts.yellow) &&
      facts.gravityOk,
    facts
  );
  check(
    `${scenario.id}: board disc count is in [20,32]`,
    facts.red + facts.yellow >= 20 && facts.red + facts.yellow <= 32,
    facts.red + facts.yellow
  );
  check(
    `${scenario.id}: title and instruction leak no keyed-column digit or tactic`,
    leakedDigits.length === 0 && leakedTactics.length === 0,
    { leakedDigits, leakedTactics }
  );
  check(
    `${scenario.id}: passes shared scenario validation`,
    validateGameIqScenario(scenario).ok,
    validateGameIqScenario(scenario)
  );
  check(
    `${scenario.id}: keyed column grades 1.0`,
    keyed.length === 1 && actionMatchesExpected(scenario, { column: keyed[0] }) === 1,
    keyed
  );
  check(
    `${scenario.id}: one-step bait grades 0.3`,
    baits.length > 0 && actionMatchesExpected(scenario, { column: baits[0]?.column }) === 0.3,
    baits
  );
  check(
    `${scenario.id}: two-step-worse column grades 0.0`,
    twoStep.length > 0 && actionMatchesExpected(scenario, { column: twoStep[0]?.column }) === 0,
    twoStep
  );
}

if (pack) {
  const floor = gameIqPackFirstClassFloor(pack);
  check(`${PACK_ID}: passes the first-class rigor floor`, floor.ok, floor);
}

if (failures === 0) {
  console.log("PASS");
} else {
  console.log(`FAIL ${failures} check(s) failed`);
}

process.exit(failures === 0 ? 0 : 1);
