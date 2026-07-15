/* Bounded chess mate-prover fixtures for the GameIQ depth track. */
import { createInitialState, fromFEN } from "../lib/games/chess/engine";
import {
  givesCheck,
  isCaptureMove,
  isQuietMove,
  movesForcingMateWithin,
} from "../lib/benchmark/gameiq/chess-prover";

let failures = 0;

function check(name: string, ok: boolean, detail?: unknown): void {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` -> ${JSON.stringify(detail)}`}`);
}

function moveKey(move: { from: string; to: string; promotion?: string }): string {
  return `${move.from}->${move.to}${move.promotion ? `=${move.promotion}` : ""}`;
}

const morphyFen = "kbK5/pp6/1P6/8/8/8/8/R7 w - - 0 1";
function parseRequiredFen(fen: string) {
  try {
    return fromFEN(fen);
  } catch (error) {
    console.log(
      `BLOCKED required Morphy FEN could not be parsed: ${error instanceof Error ? error.message : String(error)}`
    );
    throw error;
  }
}
const morphyState = parseRequiredFen(morphyFen);

const morphyMateInTwo = movesForcingMateWithin(morphyState, 3);
check(
  "Morphy quiet mate-in-2 has exactly Ra6",
  morphyMateInTwo.length === 1 && moveKey(morphyMateInTwo[0]) === "a1->a6",
  morphyMateInTwo.map(moveKey)
);
check("Morphy Ra6 is quiet", isQuietMove(morphyState, morphyMateInTwo[0]), morphyMateInTwo[0]);
check(
  "Morphy position has no mate-in-1",
  movesForcingMateWithin(morphyState, 1).length === 0,
  movesForcingMateWithin(morphyState, 1).map(moveKey)
);

const backRankMate = fromFEN("6k1/5ppp/8/8/8/8/5PPP/4R1K1 w - - 0 1");
const backRankMateInOne = movesForcingMateWithin(backRankMate, 1);
const passesNoMateInOneFilter = backRankMateInOne.length === 0;
check(
  "back-rank fixture contains Re8 mate-in-1",
  backRankMateInOne.some((move) => moveKey(move) === "e1->e8"),
  backRankMateInOne.map(moveKey)
);
check(
  "Task 6 no-mate-in-1 uniqueness filter rejects mate-in-1 positions",
  !passesNoMateInOneFilter,
  { predicate: "movesForcingMateWithin(state, 1).length === 0", passesNoMateInOneFilter, moves: backRankMateInOne.map(moveKey) }
);

check(
  "initial chess position has no forced mate within three plies",
  movesForcingMateWithin(createInitialState(), 3).length === 0,
  movesForcingMateWithin(createInitialState(), 3).map(moveKey)
);

const enPassantState = fromFEN("4k3/8/8/3pP3/8/8/8/4K3 w - d6 0 1");
const enPassantMove = { from: "e5", to: "d6" };
check("en-passant capture is classified as a capture", isCaptureMove(enPassantState, enPassantMove));

const checkingState = fromFEN("4k3/8/8/8/8/8/4R3/4K3 w - - 0 1");
const checkingMove = { from: "e2", to: "e7" };
check("checking move is recognized as check", givesCheck(checkingState, checkingMove));

if (failures === 0) {
  console.log("PASS");
} else {
  console.log(`FAIL ${failures} check(s) failed`);
  throw new Error(`${failures} check(s) failed`);
}
