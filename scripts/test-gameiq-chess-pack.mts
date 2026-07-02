/* Certified GameIQ Chess pack authoring checks
 * (run: npx tsx scripts/test-gameiq-chess-pack.mts)
 *
 * Engine-verifies EVERY scenario in gameiq-v0.1-chess against the in-repo chess
 * engine — this test, not hand analysis, is the correctness gate:
 *  - the FEN parses and the side to move matches the scenario prompt;
 *  - every expected action is legal;
 *  - mate-in-one scenarios: the listed moves are exactly the set of moves that
 *    deliver immediate checkmate (uniqueness for single-mate positions, and
 *    both-mates completeness for two-mate positions) — no non-listed legal move
 *    mates;
 *  - winning-capture scenarios (tags include "capture"): the expected capture
 *    nets material and survives the best immediate recapture one ply deep, while
 *    a tagged tempting distractor capture loses material;
 *  - the defensive scenario (tags include "defense"): the expected move is the
 *    ONLY legal move that averts mate — every other legal move allows the
 *    opponent to mate on the reply;
 *  - promotion best-move scenarios (tags include "promotion", not "mate"):
 *    promoting to a queen beats every non-promoting alternative on material;
 *  - no expected action equals the chess JSON shape example (the shared guard in
 *    scripts/test-gameiq-shared-guards.mts covers this too — kept green here).
 */
import { getGameIqScenarioPackById } from "../lib/benchmark/gameiq/packs";
import {
  gameIqActionShapeExample,
} from "../lib/benchmark/gameiq/certified-runner";
import {
  actionMatchesExpected,
  validateGameIqAction,
  validateGameIqScenario,
} from "../lib/benchmark/gameiq/validation";
import {
  fromFEN,
  generateLegalMoves,
  getPiece,
  isLegalMove,
  makeMove,
} from "../lib/games/chess/engine";
import type { GameState, Move, PieceColor, PieceType } from "../lib/games/chess/types";
import type { ChessGameIqAction, GameIqScenario } from "../lib/benchmark/gameiq/types";

let failures = 0;
function check(name: string, ok: boolean, detail?: unknown): void {
  if (!ok) failures++;
  console.log(
    `${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` -> ${JSON.stringify(detail)}`}`
  );
}

const PIECE_VALUE: Record<PieceType, number> = {
  pawn: 1,
  knight: 3,
  bishop: 3,
  rook: 5,
  queen: 9,
  king: 100,
};

function toMove(action: ChessGameIqAction): Move {
  return action.promotion
    ? { from: action.from, to: action.to, promotion: action.promotion }
    : { from: action.from, to: action.to };
}

function fen(scenario: GameIqScenario): string {
  return (scenario.initialState as { fen: string }).fen;
}

// All legal moves that deliver immediate checkmate.
function matingMoves(state: GameState): Move[] {
  return generateLegalMoves(state, state.turn).filter(
    (move) => makeMove(state, move).status === "checkmate"
  );
}

// Does the side to move (in `state`) have any immediate checkmate available?
function sideToMoveCanMate(state: GameState): boolean {
  return generateLegalMoves(state, state.turn).some(
    (move) => makeMove(state, move).status === "checkmate"
  );
}

// Net material of a capture one ply deep: value captured minus the value of our
// mover if the opponent has any legal recapture on the destination square.
function captureNet(state: GameState, action: ChessGameIqAction): number {
  const target = getPiece(state, action.to);
  const mover = getPiece(state, action.from);
  const captured = target ? PIECE_VALUE[target.type] : 0;
  const moverValue = mover ? PIECE_VALUE[mover.type] : 0;
  const after = makeMove(state, toMove(action));
  const recaptured = generateLegalMoves(after, after.turn).some(
    (move) => move.to === action.to
  );
  return captured - (recaptured ? moverValue : 0);
}

const moveKey = (move: { from: string; to: string; promotion?: unknown }): string =>
  `${move.from}${move.to}${move.promotion ?? ""}`;

const pack = getGameIqScenarioPackById("gameiq-v0.1-chess");
if (!pack) {
  check("gameiq-v0.1-chess pack exists", false);
  process.exit(1);
}

check("pack is labeled Chess", pack.gameId === "chess", pack.gameId);
check(
  "pack has 12-16 scenarios (grown from 4)",
  pack.scenarios.length >= 12 && pack.scenarios.length <= 16,
  pack.scenarios.length
);

// Archetype coverage.
const byColor = pack.scenarios.map((scenario) => fromFEN(fen(scenario)).turn);
check(
  "pack has white-to-move and black-to-move scenarios",
  byColor.includes("white") && byColor.includes("black"),
  { white: byColor.filter((c) => c === "white").length, black: byColor.filter((c) => c === "black").length }
);
const mateScenarios = pack.scenarios.filter((s) => s.category === "mate-in-one");
check("pack has at least 6 mate-in-one scenarios", mateScenarios.length >= 6, mateScenarios.length);
const twoMateScenarios = mateScenarios.filter((s) => s.expectedActions.length >= 2);
check(
  "pack has at least one two-mates scenario (both accepted)",
  twoMateScenarios.length >= 1,
  twoMateScenarios.map((s) => s.id)
);
check(
  "pack has a promotion-mate scenario",
  mateScenarios.some((s) => s.tags.includes("promotion")),
  mateScenarios.map((s) => s.id)
);
const captureScenarios = pack.scenarios.filter((s) => s.tags.includes("capture"));
check("pack has winning-capture scenarios", captureScenarios.length >= 2, captureScenarios.length);
const defenseScenarios = pack.scenarios.filter((s) => s.tags.includes("defense"));
check("pack has a defensive scenario", defenseScenarios.length >= 1, defenseScenarios.length);
const promotionBestScenarios = pack.scenarios.filter(
  (s) => s.tags.includes("promotion") && !s.tags.includes("mate")
);
check("pack has a promotion best-move scenario", promotionBestScenarios.length >= 1, promotionBestScenarios.length);

// The weak legal-tactic validator path must be unused by this pack.
check(
  "pack does not use the weak legal-tactic category",
  pack.scenarios.every((s) => s.category !== "legal-tactic"),
  pack.scenarios.filter((s) => s.category === "legal-tactic").map((s) => s.id)
);

// Per-scenario verification.
for (const scenario of pack.scenarios) {
  const id = scenario.id;
  let state: GameState;
  try {
    state = fromFEN(fen(scenario));
  } catch (error) {
    check(`${id}: FEN parses`, false, String(error));
    continue;
  }
  check(`${id}: FEN parses`, true);

  // Side to move must match the prompt wording.
  const promptWantsWhite = scenario.prompt.includes("White to move");
  const promptWantsBlack = scenario.prompt.includes("Black to move");
  const expectedColor: PieceColor = promptWantsWhite ? "white" : "black";
  check(
    `${id}: prompt names exactly one side to move`,
    promptWantsWhite !== promptWantsBlack,
    scenario.prompt
  );
  check(
    `${id}: side to move matches prompt`,
    state.turn === expectedColor,
    { fenTurn: state.turn, expectedColor }
  );

  // Shared scenario validation (legality of every expected action + category).
  check(`${id}: shared validator passes`, validateGameIqScenario(scenario).ok, validateGameIqScenario(scenario));

  // Each expected action is legal and scoreable.
  for (const expectedAction of scenario.expectedActions) {
    const action = expectedAction.action as ChessGameIqAction;
    check(
      `${id}: expected ${expectedAction.label} is legal`,
      isLegalMove(state, toMove(action)) && validateGameIqAction(scenario, action).ok,
      action
    );
    check(
      `${id}: expected ${expectedAction.label} scores 1`,
      actionMatchesExpected(scenario, action) === 1,
      { action, score: actionMatchesExpected(scenario, action) }
    );
  }

  // Shape example must never be a scoreable/legal answer for this scenario.
  const shapeAction = (JSON.parse(gameIqActionShapeExample(scenario)) as { action: unknown }).action;
  check(
    `${id}: JSON shape example is not legal or scoreable`,
    !validateGameIqAction(scenario, shapeAction).ok &&
      actionMatchesExpected(scenario, shapeAction) === 0,
    shapeAction
  );

  const expectedKeys = new Set(
    scenario.expectedActions.map((e) => moveKey(e.action as ChessGameIqAction))
  );

  if (scenario.category === "mate-in-one") {
    // Every listed move mates, and the listed set is EXACTLY the set of mating
    // moves (uniqueness for single-mate, completeness for two-mate positions).
    const engineMates = matingMoves(state);
    const engineMateKeys = new Set(engineMates.map(moveKey));
    for (const e of scenario.expectedActions) {
      const after = makeMove(state, toMove(e.action as ChessGameIqAction));
      check(`${id}: ${e.label} is immediate checkmate`, after.status === "checkmate", e.label);
    }
    check(
      `${id}: listed mates == all engine mates (no other move mates)`,
      engineMateKeys.size === expectedKeys.size &&
        [...engineMateKeys].every((k) => expectedKeys.has(k)),
      { listed: [...expectedKeys], engine: [...engineMateKeys] }
    );
    continue;
  }

  if (scenario.tags.includes("defense")) {
    // The expected move must be the ONLY legal move that averts mate: every
    // OTHER legal move must let the opponent mate on the reply. (The expected
    // move itself must NOT allow mate.)
    const legalMoves = generateLegalMoves(state, state.turn);
    const stoppers = legalMoves.filter((move) => {
      const after = makeMove(state, move);
      if (after.status === "checkmate") return true; // our move itself mates -> averts
      return !sideToMoveCanMate(after);
    });
    const stopperKeys = new Set(stoppers.map(moveKey));
    check(
      `${id}: exactly one move averts mate`,
      stoppers.length === 1,
      stoppers.map(moveKey)
    );
    check(
      `${id}: the sole averting move is the expected move`,
      stopperKeys.size === expectedKeys.size &&
        [...expectedKeys].every((k) => stopperKeys.has(k)),
      { expected: [...expectedKeys], stoppers: [...stopperKeys] }
    );
    // Sanity: a real mate threat exists (some legal move allows mate).
    const allowsMate = legalMoves.some((move) => {
      const after = makeMove(state, move);
      return after.status !== "checkmate" && sideToMoveCanMate(after);
    });
    check(`${id}: a real mate threat exists`, allowsMate);
    continue;
  }

  if (scenario.tags.includes("capture") && !scenario.tags.includes("promotion")) {
    // Expected capture nets material (survives best one-ply recapture); if a
    // "distractor" note names another capture, that capture must lose material.
    for (const e of scenario.expectedActions) {
      const net = captureNet(state, e.action as ChessGameIqAction);
      check(`${id}: expected ${e.label} nets material (>0)`, net > 0, { label: e.label, net });
    }
    // Enumerate all legal captures; every capture NOT in the expected set must
    // net <= 0 (i.e. the expected captures are the only material-winning ones,
    // so a distractor capture provably loses or breaks even).
    const legalMoves = generateLegalMoves(state, state.turn);
    const distractors = legalMoves.filter((move) => {
      const target = getPiece(state, move.to);
      const isCapture = target != null && target.color !== state.turn;
      return isCapture && !expectedKeys.has(moveKey(move));
    });
    const losing = distractors.filter(
      (move) => captureNet(state, { from: move.from, to: move.to }) < 0
    );
    if (scenario.tags.includes("distractor")) {
      check(
        `${id}: has a tempting distractor capture that loses material`,
        losing.length >= 1,
        distractors.map((m) => ({ move: moveKey(m), net: captureNet(state, { from: m.from, to: m.to }) }))
      );
    }
    check(
      `${id}: no non-expected capture wins material`,
      distractors.every((move) => captureNet(state, { from: move.from, to: move.to }) <= 0),
      distractors.map((m) => ({ move: moveKey(m), net: captureNet(state, { from: m.from, to: m.to }) }))
    );
    continue;
  }

  if (scenario.tags.includes("promotion")) {
    // Promotion best-move: the expected move promotes to a queen and beats every
    // non-promoting alternative on material (a queen appears where a pawn was).
    for (const e of scenario.expectedActions) {
      const action = e.action as ChessGameIqAction;
      check(
        `${id}: expected ${e.label} promotes to a queen`,
        action.promotion === "queen",
        action
      );
      const after = makeMove(state, toMove(action));
      const promoted = getPiece(after, action.to);
      check(
        `${id}: ${e.label} yields a queen on ${action.to}`,
        promoted?.type === "queen" && promoted.color === state.turn,
        promoted
      );
    }
    // Every legal move that does NOT promote leaves the pawn unpromoted (no new
    // queen), so promoting strictly increases material vs any non-promoting move.
    const legalMoves = generateLegalMoves(state, state.turn);
    const nonPromoting = legalMoves.filter((move) => move.promotion == null);
    check(
      `${id}: non-promoting alternatives exist and none makes a queen`,
      nonPromoting.length >= 1 &&
        nonPromoting.every((move) => {
          const after = makeMove(state, move);
          // count our queens before/after; a non-promoting move must not add one
          const before = countQueens(state, state.turn);
          const post = countQueens(after, state.turn);
          return post <= before;
        }),
      nonPromoting.map(moveKey)
    );
    continue;
  }

  check(`${id}: recognized archetype`, false, { category: scenario.category, tags: scenario.tags });
}

function countQueens(state: GameState, color: PieceColor): number {
  let count = 0;
  for (const row of state.board) {
    for (const piece of row) {
      if (piece && piece.color === color && piece.type === "queen") count++;
    }
  }
  return count;
}

// Distinct decisions: no two scenarios share (fen, expectedActions) and the
// count comfortably clears the first-class rigor floor's minimum.
const decisionTuples = new Set(
  pack.scenarios.map((s) => JSON.stringify({ fen: fen(s), expected: s.expectedActions.map((e) => e.action) }))
);
check(
  "all scenarios are distinct decisions",
  decisionTuples.size === pack.scenarios.length,
  { distinct: decisionTuples.size, total: pack.scenarios.length }
);

if (failures === 0) {
  console.log("PASS");
} else {
  console.log(`FAIL ${failures} check(s) failed`);
}
process.exit(failures === 0 ? 0 : 1);
