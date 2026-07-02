/* Certified GameIQ Connect Four pack checks
 * (run: npx tsx scripts/test-gameiq-connect-four-pack.mts)
 *
 * Engine-verifies EVERY Connect Four scenario against the real game engine so
 * the pack is provably correct, not plausibly correct:
 *  - reachability: alternating-move parity (red moves first) holds, and no
 *    board already contains a completed four;
 *  - legality: every expected column is legal;
 *  - win-in-one: every expected column wins immediately AND every engine-winning
 *    column is listed as an expected action (so a perfect deterministic
 *    candidate scores 100 and no equally-optimal alternative is scored wrong);
 *  - block-win: the opponent has exactly one immediate winning column, the mover
 *    has no immediate win, and the expected move removes the threat;
 *  - trap-setup: the expected drop creates a genuine double threat (>=2 winning
 *    follow-ups) via the shared validator, with no pre-existing mover win or
 *    opponent threat;
 *  - avoid-losing-move: the opponent threatens, the mover has no win, and the
 *    expected column is the UNIQUE safe move while >=1 alternative loses;
 *  - de-leak: no model-facing prompt names the tactic, direction, row, or the
 *    expected column, and never contains the title or a note;
 *  - no duplicates: no two boards are byte-identical or pure color swaps;
 *  - the pack still passes gameIqPackFirstClassFloor.
 */
import {
  dropDisc,
  getLegalColumns,
  isWinningPlacement,
} from "../lib/games/connect-four/engine";
import type {
  ConnectFourBoard,
  ConnectFourGameState,
  ConnectFourPlayer,
} from "../lib/games/connect-four/types";
import { CONNECT_FOUR_GAMEIQ_SCENARIOS } from "../lib/benchmark/gameiq/connect-four";
import {
  getGameIqScenarioPack,
  gameIqPackFirstClassFloor,
} from "../lib/benchmark/gameiq/packs";
import {
  gameIqScenarioPrompt,
} from "../lib/benchmark/gameiq/certified-runner";
import { validateGameIqScenario } from "../lib/benchmark/gameiq/validation";
import type {
  ConnectFourGameIqAction,
  ConnectFourGameIqScenario,
} from "../lib/benchmark/gameiq/types";

let failures = 0;

function check(name: string, ok: boolean, detail?: unknown): void {
  if (!ok) failures++;
  console.log(
    `${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` -> ${JSON.stringify(detail)}`}`
  );
}

const scenarios = CONNECT_FOUR_GAMEIQ_SCENARIOS as ConnectFourGameIqScenario[];

function other(player: ConnectFourPlayer): ConnectFourPlayer {
  return player === "red" ? "yellow" : "red";
}

function counts(board: ConnectFourBoard): { red: number; yellow: number } {
  let red = 0;
  let yellow = 0;
  for (const row of board) {
    for (const cell of row) {
      if (cell === "red") red++;
      else if (cell === "yellow") yellow++;
    }
  }
  return { red, yellow };
}

// Alternating-move parity, derived from turn order (red always moves first):
//  - red to move  => equal counts (red == yellow);
//  - yellow to move => red is exactly one ahead (red == yellow + 1).
function parityOk(state: ConnectFourGameState): boolean {
  const { red, yellow } = counts(state.board);
  return state.turn === "red" ? red === yellow : red === yellow + 1;
}

function hasCompletedFour(board: ConnectFourBoard): boolean {
  for (let row = 0; row < 6; row++) {
    for (let column = 0; column < 7; column++) {
      const cell = board[row][column];
      if (cell && isWinningPlacement(board, row, column, cell)) return true;
    }
  }
  return false;
}

function winningColumns(
  state: ConnectFourGameState,
  player: ConnectFourPlayer
): number[] {
  const test = { ...state, turn: player };
  return getLegalColumns(test).filter((column) => {
    try {
      return dropDisc(test, column, 0).winner === player;
    } catch {
      return false;
    }
  });
}

function expectedColumns(scenario: ConnectFourGameIqScenario): number[] {
  return scenario.expectedActions.map(
    (expected) => (expected.action as ConnectFourGameIqAction).column
  );
}

// Color-swap canonical form of a board (for duplicate detection): every red
// becomes yellow and vice versa. Two scenarios that are color mirrors have the
// same canonical (board + swapped-turn) signature.
function colorSwapKey(scenario: ConnectFourGameIqScenario): string {
  const state = scenario.initialState as ConnectFourGameState;
  const swapped = state.board.map((row) =>
    row.map((cell) =>
      cell === "red" ? "yellow" : cell === "yellow" ? "red" : null
    )
  );
  return JSON.stringify({ board: swapped, turn: other(state.turn) });
}

function boardKey(scenario: ConnectFourGameIqScenario): string {
  const state = scenario.initialState as ConnectFourGameState;
  return JSON.stringify({ board: state.board, turn: state.turn });
}

// --- pack shape ---------------------------------------------------------
check(
  "pack has exactly 40 scenarios",
  scenarios.length === 40,
  scenarios.length
);
const byCategory = new Map<string, number>();
for (const scenario of scenarios) {
  byCategory.set(scenario.category, (byCategory.get(scenario.category) ?? 0) + 1);
}
for (const category of [
  "win-in-one",
  "block-win",
  "trap-setup",
  "avoid-losing-move",
]) {
  check(
    `pack has 10 ${category} scenarios`,
    byCategory.get(category) === 10,
    byCategory.get(category)
  );
}
const ids = scenarios.map((scenario) => scenario.id);
check("scenario ids are unique", new Set(ids).size === ids.length, ids);

// --- no duplicates (byte-identical boards or pure color swaps) -----------
const boardKeys = scenarios.map(boardKey);
check(
  "no two boards are byte-identical",
  new Set(boardKeys).size === boardKeys.length,
  boardKeys
);
const swapCollisions: string[] = [];
for (let i = 0; i < scenarios.length; i++) {
  for (let j = i + 1; j < scenarios.length; j++) {
    if (boardKey(scenarios[i]) === colorSwapKey(scenarios[j])) {
      swapCollisions.push(`${scenarios[i].id} <-> ${scenarios[j].id}`);
    }
  }
}
check(
  "no board is a pure color-swap of another",
  swapCollisions.length === 0,
  swapCollisions
);

// --- per-scenario engine verification -----------------------------------
for (const scenario of scenarios) {
  const state = scenario.initialState as ConnectFourGameState;
  const board = state.board;
  const mover = state.turn;
  const opponent = other(mover);
  const expected = expectedColumns(scenario);

  check(`${scenario.id}: reachable parity`, parityOk(state), counts(board));
  check(`${scenario.id}: no completed four`, !hasCompletedFour(board), scenario.id);
  check(
    `${scenario.id}: every expected column is legal`,
    expected.length > 0 &&
      expected.every((column) => getLegalColumns(state).includes(column)),
    { expected, legal: getLegalColumns(state) }
  );
  // shared authoring validator (category-specific engine checks + trap oracle)
  check(
    `${scenario.id}: passes shared validateGameIqScenario`,
    validateGameIqScenario(scenario).ok,
    validateGameIqScenario(scenario)
  );

  const moverWins = winningColumns(state, mover);
  const opponentWins = winningColumns(state, opponent);

  if (scenario.category === "win-in-one") {
    check(
      `${scenario.id}: every expected column wins immediately`,
      expected.every((column) => {
        const next = dropDisc(state, column, 0);
        return next.status === "win" && next.winner === mover;
      }),
      expected
    );
    // Fix (1): every engine-winning column must be an accepted answer so an
    // equally-optimal alternative is never scored wrong.
    check(
      `${scenario.id}: expected columns == all engine-winning columns`,
      JSON.stringify([...expected].sort((a, b) => a - b)) ===
        JSON.stringify([...moverWins].sort((a, b) => a - b)),
      { expected, moverWins }
    );
  }

  if (scenario.category === "block-win") {
    check(
      `${scenario.id}: mover has no immediate win of its own`,
      moverWins.length === 0,
      moverWins
    );
    check(
      `${scenario.id}: opponent has exactly one immediate threat`,
      opponentWins.length === 1,
      opponentWins
    );
    check(
      `${scenario.id}: expected block removes the threat`,
      expected.length === 1 &&
        winningColumns(dropDisc(state, expected[0], 0), opponent).length === 0,
      { expected, opponentWins }
    );
  }

  if (scenario.category === "trap-setup") {
    check(
      `${scenario.id}: mover has no immediate win before the trap`,
      moverWins.length === 0,
      moverWins
    );
    check(
      `${scenario.id}: opponent has no immediate threat`,
      opponentWins.length === 0,
      opponentWins
    );
    check(
      `${scenario.id}: single expected trap column`,
      expected.length === 1,
      expected
    );
    const next = dropDisc(state, expected[0], 0);
    check(
      `${scenario.id}: trap drop does not win immediately`,
      next.winner == null,
      next.winner
    );
    check(
      `${scenario.id}: trap creates a genuine double threat`,
      winningColumns(next, mover).length >= 2,
      winningColumns(next, mover)
    );
  }

  if (scenario.category === "avoid-losing-move") {
    check(
      `${scenario.id}: mover has no immediate win`,
      moverWins.length === 0,
      moverWins
    );
    check(
      `${scenario.id}: opponent threatens an immediate win`,
      opponentWins.length >= 1,
      opponentWins
    );
    const legal = getLegalColumns(state);
    const safe = legal.filter(
      (column) => winningColumns(dropDisc(state, column, 0), opponent).length === 0
    );
    check(
      `${scenario.id}: exactly one safe column, and it is expected`,
      safe.length === 1 && expected.length === 1 && safe[0] === expected[0],
      { safe, expected }
    );
    check(
      `${scenario.id}: at least one alternative move loses`,
      legal.length - safe.length >= 1,
      { legal, safe }
    );
  }
}

// --- de-leak: prompts never name the tactic/direction/row/answer ---------
const LEAK_TERMS = [
  "win",
  "block",
  "trap",
  "threat",
  "diagonal",
  "vertical",
  "horizontal",
  "row",
  "double",
  "fork",
  "four",
];
for (const scenario of scenarios) {
  const index = scenarios.indexOf(scenario);
  const prompt = gameIqScenarioPrompt(scenario, index, scenarios.length);
  // The prompt must not contain the title or any note.
  const titleLeak = prompt.includes(scenario.title);
  const noteLeak = scenario.expectedActions.some(
    (expected) => expected.note && prompt.includes(expected.note)
  );
  check(
    `${scenario.id}: prompt contains neither title nor note`,
    !titleLeak && !noteLeak,
    { titleLeak, noteLeak }
  );
  // Only inspect the scenario-specific instruction line (game rules text is
  // shared boilerplate that legitimately mentions "column" and the grid).
  const instruction = scenario.prompt.toLowerCase();
  const leaked = LEAK_TERMS.filter((term) => instruction.includes(term));
  check(
    `${scenario.id}: instruction names no tactic/direction/row`,
    leaked.length === 0,
    leaked
  );
  // The expected column number must not appear as a 1-based hint in the title.
  const expected = expectedColumns(scenario);
  const titleLeaksColumn = expected.some((column) =>
    new RegExp(`\\b${column + 1}\\b`).test(scenario.title)
  );
  check(
    `${scenario.id}: title does not leak the answer column`,
    !titleLeaksColumn,
    { title: scenario.title, expected }
  );
}

// --- first-class rigor floor --------------------------------------------
const pack = getGameIqScenarioPack("connect-four");
if (!pack) {
  check("connect-four pack is registered", false);
} else {
  const floor = gameIqPackFirstClassFloor(pack);
  check(
    "pack passes the first-class rigor floor",
    floor.ok,
    floor
  );
  check(
    `pack tier matches floor result (${floor.ok ? "first-class" : "lightweight"})`,
    floor.ok
      ? pack.certificationTier === "first-class"
      : pack.certificationTier === "lightweight",
    { tier: pack.certificationTier, floor }
  );
}

if (failures === 0) {
  console.log("PASS");
} else {
  console.log(`FAIL ${failures} check(s) failed`);
}

process.exit(failures === 0 ? 0 : 1);
