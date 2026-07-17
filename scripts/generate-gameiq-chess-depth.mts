// Deterministic miner for quiet mate-in-2 positions.
// Usage: npx tsx scripts/generate-gameiq-chess-depth.mts --seed 1 --want 18
import {
  createInitialState,
  generateLegalMoves,
  getPiece,
  makeMove,
  toFEN,
} from "../lib/games/chess/engine";
import {
  givesCheck,
  isCaptureMove,
  isQuietMove,
  movesForcingMateWithin,
} from "../lib/benchmark/gameiq/chess-prover";
import type { GameState, Move, PieceColor, PieceType, Square } from "../lib/games/chess/types";

const FILES = "abcdefgh";
const RANKS = "12345678";
const MAX_GAMES = 400;
const MAX_PLIES = 80;
const MAX_SCANNED = 20_000;

const PIECE_VALUES: Record<PieceType, number> = {
  pawn: 1,
  knight: 3,
  bishop: 3,
  rook: 5,
  queen: 9,
  king: 0,
};

interface Candidate {
  fen: string;
  key: Move;
  legalMoveCount: number;
  forcingBaitCount: number;
}

interface Diagnostics {
  rejectedWidth: number;
  rejectedForcingBaits: number;
  rejectedQuietReplyWitness: number;
  rejectedMateInOne: number;
  rejectedMateInTwoCount: number;
  rejectedNonQuiet: number;
  mateInTwoMs: number[];
}

function mulberry32(seed: number): () => number {
  let value = seed >>> 0;
  return () => {
    value |= 0;
    value = (value + 0x6d2b79f5) | 0;
    let t = Math.imul(value ^ (value >>> 15), 1 | value);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function readFlag(args: string[], name: string, fallback: number): number {
  const index = args.indexOf(name);
  if (index < 0) return fallback;
  const value = Number(args[index + 1]);
  return Number.isFinite(value) ? value : fallback;
}

function hasFlag(args: string[], name: string): boolean {
  return args.includes(name);
}

function materialPoints(state: GameState, color: PieceColor): number {
  let points = 0;
  for (const file of FILES) {
    for (const rank of RANKS) {
      const piece = getPiece(state, `${file}${rank}` as Square);
      if (piece?.color === color) points += PIECE_VALUES[piece.type];
    }
  }
  return points;
}

function hasTwoNonPawnPieces(state: GameState): boolean {
  let count = 0;
  for (const file of FILES) {
    for (const rank of RANKS) {
      const piece = getPiece(state, `${file}${rank}` as Square);
      if (piece?.color === state.turn && piece.type !== "king" && piece.type !== "pawn") {
        count++;
      }
    }
  }
  return count >= 2;
}

function chooseMove(state: GameState, legalMoves: Move[], random: () => number): Move {
  const bothSidesRich =
    materialPoints(state, "white") >= 10 && materialPoints(state, "black") >= 10;
  const nonCaptures = bothSidesRich
    ? legalMoves.filter((move) => !isCaptureMove(state, move))
    : [];
  const choices = nonCaptures.length > 0 && random() < 0.7 ? nonCaptures : legalMoves;
  return choices[Math.floor(random() * choices.length)];
}

function keyFor(move: Move): Move {
  return move.promotion
    ? { from: move.from, to: move.to, promotion: move.promotion }
    : { from: move.from, to: move.to };
}

export function decideCandidateHit(
  fen: string,
  seenPlacements: ReadonlySet<string>
): { placement: string; emit: boolean; stopGame: true } {
  const placement = fen.split(" ")[0];
  return {
    placement,
    emit: !seenPlacements.has(placement),
    stopGame: true,
  };
}

function isTerminal(state: GameState): boolean {
  return state.status !== "playing" && state.status !== "check";
}

// Necessary condition for a quiet mate-in-2: at least one quiet key must
// survive every legal reply. A single reply with no mate-in-1 is therefore an
// exact escape witness for that key. Survivors still go through the full prover.
function hasQuietKeyWithoutFirstReplyEscape(state: GameState, legalMoves: Move[]): boolean {
  for (const move of legalMoves) {
    if (!isQuietMove(state, move)) continue;
    const afterKey = makeMove(state, move);
    const replies = generateLegalMoves(afterKey, afterKey.turn);
    if (replies.length === 0) continue;
    const afterReply = makeMove(afterKey, replies[0]);
    if (isTerminal(afterReply)) continue;
    if (movesForcingMateWithin(afterReply, 1).length > 0) return true;
  }
  return false;
}

function scanPosition(state: GameState, diagnostics?: Diagnostics): Candidate | null {
  const legalMoves = generateLegalMoves(state, state.turn);
  if (legalMoves.length < 20) {
    if (diagnostics) diagnostics.rejectedWidth++;
    return null;
  }

  const forcingBaitCount = legalMoves.filter(
    (move) => isCaptureMove(state, move) || givesCheck(state, move)
  ).length;
  if (forcingBaitCount < 3) {
    if (diagnostics) diagnostics.rejectedForcingBaits++;
    return null;
  }

  if (!hasQuietKeyWithoutFirstReplyEscape(state, legalMoves)) {
    if (diagnostics) diagnostics.rejectedQuietReplyWitness++;
    return null;
  }

  if (movesForcingMateWithin(state, 1).length > 0) {
    if (diagnostics) diagnostics.rejectedMateInOne++;
    return null;
  }
  const mateInTwoStarted = diagnostics ? performance.now() : 0;
  const mateInTwo = movesForcingMateWithin(state, 3);
  if (diagnostics) diagnostics.mateInTwoMs.push(performance.now() - mateInTwoStarted);
  if (mateInTwo.length !== 1) {
    if (diagnostics) diagnostics.rejectedMateInTwoCount++;
    return null;
  }
  if (!isQuietMove(state, mateInTwo[0])) {
    if (diagnostics) diagnostics.rejectedNonQuiet++;
    return null;
  }

  return {
    fen: toFEN(state),
    key: keyFor(mateInTwo[0]),
    legalMoveCount: legalMoves.length,
    forcingBaitCount,
  };
}

function main(): void {
  const args = process.argv.slice(2);
  const seed = Math.floor(readFlag(args, "--seed", 1));
  const want = Math.max(1, Math.floor(readFlag(args, "--want", 18)));
  const maxScanned = Math.max(
    1,
    Math.min(MAX_SCANNED, Math.floor(readFlag(args, "--max-scanned", MAX_SCANNED)))
  );
  const diagnostics: Diagnostics | undefined = hasFlag(args, "--diagnostics")
    ? {
        rejectedWidth: 0,
        rejectedForcingBaits: 0,
        rejectedQuietReplyWitness: 0,
        rejectedMateInOne: 0,
        rejectedMateInTwoCount: 0,
        rejectedNonQuiet: 0,
        mateInTwoMs: [],
      }
    : undefined;
  const random = mulberry32(seed);
  const found: Candidate[] = [];
  const seenPlacements = new Set<string>();
  let games = 0;
  let scanned = 0;

  while (games < MAX_GAMES && scanned < maxScanned && found.length < want) {
    games++;
    let state = createInitialState();

    for (let ply = 1; ply <= MAX_PLIES; ply++) {
      if (state.status !== "playing" && state.status !== "check") break;
      const legalMoves = generateLegalMoves(state, state.turn);
      if (legalMoves.length === 0) break;
      state = makeMove(state, chooseMove(state, legalMoves, random));
      if (state.status !== "playing" && state.status !== "check") break;
      if (ply < 20 || !hasTwoNonPawnPieces(state)) continue;
      if (scanned >= maxScanned) break;

      scanned++;
      const candidate = scanPosition(state, diagnostics);
      if (!candidate) continue;

      const decision = decideCandidateHit(candidate.fen, seenPlacements);
      if (decision.emit) {
        seenPlacements.add(decision.placement);
        found.push(candidate);
      }
      if (decision.stopGame) break;
    }
  }

  console.log(`seed=${seed} games=${games} scanned=${scanned} candidates=${found.length}`);
  for (const candidate of found) console.log(JSON.stringify(candidate));
  if (diagnostics) {
    const sortedTimes = [...diagnostics.mateInTwoMs].sort((left, right) => left - right);
    const middle = Math.floor(sortedTimes.length / 2);
    const medianMs =
      sortedTimes.length === 0
        ? 0
        : sortedTimes.length % 2 === 0
          ? (sortedTimes[middle - 1] + sortedTimes[middle]) / 2
          : sortedTimes[middle];
    console.error(
      `diagnostics=${JSON.stringify({
        scanned,
        rejected: {
          widthBelow20: diagnostics.rejectedWidth,
          forcingBaitsBelow3: diagnostics.rejectedForcingBaits,
          quietReplyEscapeWitness: diagnostics.rejectedQuietReplyWitness,
          mateInOne: diagnostics.rejectedMateInOne,
          mateInTwoCountNotOne: diagnostics.rejectedMateInTwoCount,
          nonQuiet: diagnostics.rejectedNonQuiet,
        },
        mateInTwoCalls: sortedTimes.length,
        mateInTwoTimingMs: {
          total: diagnostics.mateInTwoMs.reduce((sum, duration) => sum + duration, 0),
          median: medianMs,
          max: sortedTimes.at(-1) ?? 0,
        },
      })}`
    );
  }
}

if (import.meta.main) main();
