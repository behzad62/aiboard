/* Chess rules regression checks (run: npx tsx lib/games/chess/rules-tests.mts) */
import {
  createInitialState,
  fromFEN,
  generateLegalMoves,
  generateLegalMovesFromSquare,
  getPiece,
  isLegalMove,
  makeMove,
} from "./engine";
import type { Move } from "./types";

let failures = 0;

function check(name: string, ok: boolean, detail?: unknown): void {
  if (!ok) failures++;
  console.log(
    `${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` -> ${JSON.stringify(detail)}`}`
  );
}

function sameMove(a: Move, b: Move): boolean {
  return a.from === b.from && a.to === b.to && a.promotion === b.promotion;
}

function hasMove(moves: Move[], expected: Move): boolean {
  return moves.some((move) => sameMove(move, expected));
}

function playMoves(moves: Move[]) {
  return moves.reduce((state, move) => makeMove(state, move), createInitialState());
}

const checkedState = fromFEN("4k3/8/8/8/8/8/4r3/R3K3 w - - 0 1");
const responseMove: Move = { from: "e1", to: "e2" };
const responseMoves = generateLegalMovesFromSquare(checkedState, "e1");

check("position with legal response is check", checkedState.status === "check", {
  status: checkedState.status,
});
check(
  "legal responses are generated while in check",
  responseMoves.some((move) => sameMove(move, responseMove)),
  responseMoves
);
check(
  "legal response is accepted while in check",
  isLegalMove(checkedState, responseMove),
  responseMoves
);

try {
  const nextState = makeMove(checkedState, responseMove);
  check("legal response can be made from check", nextState.status === "playing", {
    status: nextState.status,
  });
} catch (err) {
  check("legal response can be made from check", false, {
    error: err instanceof Error ? err.message : String(err),
  });
}

const castleInCheckState = fromFEN("4k3/8/8/8/8/8/4r3/R3K2R w KQ - 0 1");
const castleInCheckMoves = generateLegalMovesFromSquare(castleInCheckState, "e1");
check(
  "castling is blocked while king is in check",
  !hasMove(castleInCheckMoves, { from: "e1", to: "g1" }) &&
    !hasMove(castleInCheckMoves, { from: "e1", to: "c1" }),
  castleInCheckMoves
);

const enPassantState = fromFEN("4k3/8/8/3pP3/8/8/8/4K3 w - d6 0 1");
const enPassantMove: Move = { from: "e5", to: "d6" };
check(
  "en passant capture is legal",
  isLegalMove(enPassantState, enPassantMove),
  generateLegalMovesFromSquare(enPassantState, "e5")
);
try {
  const enPassantResult = makeMove(enPassantState, enPassantMove);
  check(
    "en passant removes the captured pawn",
    getPiece(enPassantResult, "d6")?.type === "pawn" &&
      getPiece(enPassantResult, "d6")?.color === "white" &&
      getPiece(enPassantResult, "d5") === null &&
      enPassantResult.enPassantTarget === null,
    {
      d6: getPiece(enPassantResult, "d6"),
      d5: getPiece(enPassantResult, "d5"),
      enPassantTarget: enPassantResult.enPassantTarget,
    }
  );
} catch (err) {
  check("en passant removes the captured pawn", false, {
    error: err instanceof Error ? err.message : String(err),
  });
}

const promotionState = fromFEN("4k3/P7/8/8/8/8/8/4K3 w - - 0 1");
const promotionMoves = generateLegalMovesFromSquare(promotionState, "a7");
check(
  "pawn promotion generates all promotion choices",
  ["queen", "rook", "bishop", "knight"].every((promotion) =>
    hasMove(promotionMoves, { from: "a7", to: "a8", promotion: promotion as Move["promotion"] })
  ),
  promotionMoves
);
check(
  "pawn promotion requires a promotion piece",
  !isLegalMove(promotionState, { from: "a7", to: "a8" }),
  promotionMoves
);
try {
  const promotionResult = makeMove(promotionState, {
    from: "a7",
    to: "a8",
    promotion: "queen",
  });
  check(
    "pawn promotion replaces pawn with selected piece",
    getPiece(promotionResult, "a8")?.type === "queen" &&
      getPiece(promotionResult, "a8")?.color === "white" &&
      getPiece(promotionResult, "a7") === null,
    { a8: getPiece(promotionResult, "a8"), a7: getPiece(promotionResult, "a7") }
  );
} catch (err) {
  check("pawn promotion replaces pawn with selected piece", false, {
    error: err instanceof Error ? err.message : String(err),
  });
}

const checkmateState = fromFEN("7k/6Q1/6K1/8/8/8/8/8 b - - 0 1");
check("checkmate position is detected", checkmateState.status === "checkmate", {
  status: checkmateState.status,
  legalMoves: generateLegalMoves(checkmateState, "black"),
});

const stalemateState = fromFEN("7k/5Q2/6K1/8/8/8/8/8 b - - 0 1");
check("stalemate position is detected", stalemateState.status === "stalemate", {
  status: stalemateState.status,
  legalMoves: generateLegalMoves(stalemateState, "black"),
});

const repeatedState = playMoves([
  { from: "g1", to: "f3" },
  { from: "g8", to: "f6" },
  { from: "f3", to: "g1" },
  { from: "f6", to: "g8" },
  { from: "g1", to: "f3" },
  { from: "g8", to: "f6" },
  { from: "f3", to: "g1" },
  { from: "f6", to: "g8" },
]);
check("threefold repetition is detected", repeatedState.status === "draw", {
  status: repeatedState.status,
});

const fiftyMoveState = fromFEN("4k3/8/8/8/8/8/8/R3K3 w Q - 100 1");
check("fifty-move rule draw is detected", fiftyMoveState.status === "draw", {
  status: fiftyMoveState.status,
});

const pinnedState = fromFEN("k3r3/8/8/8/8/8/4R3/4K3 w - - 0 1");
const pinnedRookMoves = generateLegalMovesFromSquare(pinnedState, "e2");
check(
  "legal move generation filters moves leaving own king in check",
  !hasMove(pinnedRookMoves, { from: "e2", to: "d2" }) &&
    !isLegalMove(pinnedState, { from: "e2", to: "d2" }),
  pinnedRookMoves
);

if (failures === 0) {
  console.log("PASS");
} else {
  console.log(`FAIL ${failures} check(s) failed`);
}

process.exit(failures === 0 ? 0 : 1);
