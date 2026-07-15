/* Certified GameIQ Chess v2 quiet-mate pack checks.
 *
 * Every tactical claim is re-derived from the rules engine and bounded prover.
 * This guard imports no miner code: the checked FEN/key pairs are immutable
 * copies of mechanically selected miner evidence documented in chess-v2.ts.
 */
import {
  fromFEN,
  generateLegalMoves,
  getPiece,
  makeMove,
  toFEN,
} from "../lib/games/chess/engine";
import type { GameState, Move, PieceType } from "../lib/games/chess/types";
import {
  givesCheck,
  isCaptureMove,
  isQuietMove,
  movesForcingMateWithin,
} from "../lib/benchmark/gameiq/chess-prover";
import {
  BLACK_MOVE_PROMPT,
  WHITE_MOVE_PROMPT,
} from "../lib/benchmark/gameiq/chess";
import { CHESS_V2_GAMEIQ_SCENARIOS } from "../lib/benchmark/gameiq/chess-v2";
import {
  gameIqDecisionKey,
  gameIqPackFirstClassFloor,
  getGameIqScenarioPackById,
} from "../lib/benchmark/gameiq/packs";
import type {
  ChessGameIqAction,
  ChessGameIqScenario,
} from "../lib/benchmark/gameiq/types";
import {
  actionMatchesExpected,
  validateGameIqScenario,
} from "../lib/benchmark/gameiq/validation";

const PACK_ID = "gameiq-v0.2-chess";
const scenarios = CHESS_V2_GAMEIQ_SCENARIOS as ChessGameIqScenario[];

let failures = 0;

function check(name: string, ok: boolean, detail?: unknown): void {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` -> ${JSON.stringify(detail)}`}`);
}

function moveKey(move: Pick<Move, "from" | "to" | "promotion">): string {
  return `${move.from}->${move.to}${move.promotion ? `=${move.promotion}` : ""}`;
}

function sameMove(left: Move, right: ChessGameIqAction): boolean {
  return (
    left.from === right.from &&
    left.to === right.to &&
    (left.promotion ?? null) === (right.promotion ?? null)
  );
}

function forcingBaits(state: GameState): Move[] {
  return generateLegalMoves(state, state.turn).filter(
    (move) => isCaptureMove(state, move) || givesCheck(state, move)
  );
}

// Independent mate-in-two refutation walk: a non-keyed first move fails when
// at least one legal reply reaches a terminal escape or a position with no
// prover-confirmed mate-in-one for the original mover.
function hasRefutingReply(state: GameState, firstMove: Move): boolean {
  const afterFirst = makeMove(state, firstMove);
  const replies = generateLegalMoves(afterFirst, afterFirst.turn);
  if (replies.length === 0) return afterFirst.status !== "checkmate";
  return replies.some((reply) => {
    const afterReply = makeMove(afterFirst, reply);
    if (afterReply.status !== "playing" && afterReply.status !== "check") return true;
    return movesForcingMateWithin(afterReply, 1).length === 0;
  });
}

check(`${PACK_ID}: pack has exactly 12 scenarios`, scenarios.length === 12, scenarios.length);
const pack = getGameIqScenarioPackById(PACK_ID);
check(
  `${PACK_ID}: registered as the first-class Chess v2 pack`,
  pack?.gameId === "chess" &&
    pack.label === "Certified GameIQ v2: Chess Quiet Mates" &&
    pack.version === "0.1.0" &&
    pack.certificationTier === "first-class" &&
    pack.scenarios.length === 12,
  pack
);

const decisionKeys = new Set(scenarios.map(gameIqDecisionKey));
check(`${PACK_ID}: has 12 distinct decisions`, decisionKeys.size === 12, decisionKeys.size);

const sideCounts = { white: 0, black: 0 };
const pieceTypeCounts = new Map<PieceType, number>();
for (const scenario of scenarios) {
  const state = fromFEN(scenario.initialState.fen);
  const keyed = scenario.expectedActions[0]?.action as ChessGameIqAction | undefined;
  if (!keyed) continue;
  sideCounts[state.turn]++;
  const keyedPiece = getPiece(state, keyed.from)?.type;
  if (keyedPiece) pieceTypeCounts.set(keyedPiece, (pieceTypeCounts.get(keyedPiece) ?? 0) + 1);
}
check(`${PACK_ID}: mixes White and Black evenly`, sideCounts.white === 6 && sideCounts.black === 6, sideCounts);
check(
  `${PACK_ID}: keyed piece types are diverse with no type above four`,
  pieceTypeCounts.size === 5 && [...pieceTypeCounts.values()].every((count) => count <= 4),
  Object.fromEntries(pieceTypeCounts)
);

for (const scenario of scenarios) {
  const state = fromFEN(scenario.initialState.fen);
  const keyed = scenario.expectedActions[0]?.action as ChessGameIqAction | undefined;
  const legalMoves = generateLegalMoves(state, state.turn);
  const mateInOne = movesForcingMateWithin(state, 1);
  const mateInTwo = movesForcingMateWithin(state, 3);
  const baits = forcingBaits(state);
  const nonKeyedBaits = keyed ? baits.filter((move) => !sameMove(move, keyed)) : baits;
  const promptForSide = state.turn === "white" ? WHITE_MOVE_PROMPT : BLACK_MOVE_PROMPT;
  const keyedSquares = keyed ? [keyed.from.toLowerCase(), keyed.to.toLowerCase()] : [];
  const leakFields = [
    ["title", scenario.title],
    ["prompt", scenario.prompt],
    ...scenario.expectedActions.map((expected) => ["label", expected.label] as const),
  ];
  const leaks = leakFields.flatMap(([field, value]) =>
    keyedSquares.filter((square) => value.toLowerCase().includes(square)).map((square) => ({ field, square }))
  );
  const legalNonKeyed = keyed
    ? legalMoves.find((move) => !sameMove(move, keyed))
    : undefined;
  const expectedPlacement = scenario.initialState.fen.split(" ")[0];
  const roundTrippedPlacement = toFEN(state).split(" ")[0];

  check(
    `${scenario.id}: prover re-derives exactly the keyed mate-in-two move`,
    keyed !== undefined && mateInTwo.length === 1 && sameMove(mateInTwo[0], keyed),
    { keyed, proven: mateInTwo.map(moveKey) }
  );
  check(`${scenario.id}: has no mate-in-one`, mateInOne.length === 0, mateInOne.map(moveKey));
  check(
    `${scenario.id}: keyed move is quiet`,
    keyed !== undefined && isQuietMove(state, keyed),
    keyed
  );
  check(`${scenario.id}: has at least three forcing baits`, baits.length >= 3, baits.map(moveKey));
  check(`${scenario.id}: has at least 20 legal moves`, legalMoves.length >= 20, legalMoves.length);
  check(
    `${scenario.id}: every non-keyed forcing bait has an independently walked refutation`,
    nonKeyedBaits.length >= 3 && nonKeyedBaits.every((bait) => hasRefutingReply(state, bait)),
    nonKeyedBaits.map((bait) => ({ move: moveKey(bait), refuted: hasRefutingReply(state, bait) }))
  );
  check(
    `${scenario.id}: FEN piece placement round-trips`,
    roundTrippedPlacement === expectedPlacement,
    { expectedPlacement, roundTrippedPlacement }
  );
  check(
    `${scenario.id}: side to move matches one shared prompt constant`,
    scenario.prompt === promptForSide &&
      (scenario.prompt === WHITE_MOVE_PROMPT || scenario.prompt === BLACK_MOVE_PROMPT),
    { turn: state.turn, prompt: scenario.prompt }
  );
  check(
    `${scenario.id}: title, prompt, and label do not leak keyed squares`,
    leaks.length === 0,
    leaks
  );
  check(
    `${scenario.id}: passes shared scenario validation`,
    validateGameIqScenario(scenario).ok,
    validateGameIqScenario(scenario)
  );
  check(
    `${scenario.id}: keyed move grades 1.0`,
    keyed !== undefined && actionMatchesExpected(scenario, keyed) === 1,
    keyed
  );
  check(
    `${scenario.id}: legal non-keyed move grades 0.15`,
    legalNonKeyed !== undefined && actionMatchesExpected(scenario, legalNonKeyed) === 0.15,
    legalNonKeyed
  );
  check(
    `${scenario.id}: illegal move grades 0`,
    actionMatchesExpected(scenario, { from: "a1", to: "a1" }) === 0
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
