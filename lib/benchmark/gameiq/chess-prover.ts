//
// Exhaustive bounded mate prover over the in-repo rules engine. Exact for the
// depths we ship (<= 3 plies: mate-in-2). No evaluation function, no judgment:
// a claim "this move forces mate in 2" is proven by AND/OR search over every
// legal reply.
import {
  generateLegalMoves,
  getPiece,
  isInCheck,
  makeMove,
} from "@/lib/games/chess/engine";
import type { GameState, Move, PieceColor } from "@/lib/games/chess/types";

function sideToMove(state: GameState): PieceColor {
  return state.turn;
}

function isMate(state: GameState): boolean {
  return state.status === "checkmate";
}

function isTerminal(state: GameState): boolean {
  return state.status !== "playing" && state.status !== "check";
}

// Can the side to move force checkmate within `plies` of its OWN tempo budget
// (1 = mate now, 3 = mate-in-2, 5 = mate-in-3)?
function forcesMateWithin(state: GameState, plies: number): boolean {
  if (plies < 1) return false;
  const mover = sideToMove(state);
  const moves = generateLegalMoves(state, mover);

  // Leaf searches only need to find an immediate mate. Check ordering cannot
  // prune anything here, so avoid the transition-heavy sort entirely.
  if (plies < 3) {
    return moves.some((move) => isMate(makeMove(state, move)));
  }

  // Order checks first: massive pruning for mate search.
  const ordered = moves
    .map((move) => {
      const next = makeMove(state, move);
      const mate = isMate(next);
      return {
        next,
        mate,
        givesCheck: mate || isInCheck(next, sideToMove(next)),
      };
    })
    .sort((a, b) => Number(b.givesCheck) - Number(a.givesCheck));
  for (const { next, mate } of ordered) {
    if (mate) return true;
    if (!isTerminal(next) && everyReplyLoses(next, plies - 2)) return true;
  }
  return false;
}

// Opponent to move: true iff EVERY legal reply leaves a position where we
// still force mate within `plies`.
function everyReplyLoses(state: GameState, plies: number): boolean {
  const opponent = sideToMove(state);
  const replies = generateLegalMoves(state, opponent);
  if (replies.length === 0) return false; // stalemate (mate was checked upstream)
  for (const reply of replies) {
    const next = makeMove(state, reply);
    if (isTerminal(next)) return false; // draw by rule = escape
    if (!forcesMateWithin(next, plies)) return false;
  }
  return true;
}

export function givesCheck(state: GameState, move: Move): boolean {
  const next = makeMove(state, move);
  return isMate(next) || isInCheck(next, sideToMove(next));
}

export function isCaptureMove(state: GameState, move: Move): boolean {
  if (getPiece(state, move.to) !== null) return true;
  // En passant: a pawn moving diagonally onto an empty square.
  const piece = getPiece(state, move.from);
  return piece?.type === "pawn" && move.from[0] !== move.to[0];
}

export function isQuietMove(state: GameState, move: Move): boolean {
  return !isCaptureMove(state, move) && !givesCheck(state, move);
}

// All first moves that force mate within `plies` (see forcesMateWithin).
export function movesForcingMateWithin(state: GameState, plies: number): Move[] {
  const mover = sideToMove(state);
  return generateLegalMoves(state, mover).filter((move) => {
    const next = makeMove(state, move);
    if (isMate(next)) return true;
    if (plies >= 3 && !isTerminal(next)) return everyReplyLoses(next, plies - 2);
    return false;
  });
}
