import type { ChessGameIqAction, ChessGameIqScenario } from "./types";
import { BLACK_MOVE_PROMPT, WHITE_MOVE_PROMPT } from "./chess";

interface ExpectedInput {
  action: ChessGameIqAction;
  label: string;
  note: string;
}

function expected(
  input: ExpectedInput
): Array<{ action: ChessGameIqAction; label: string; weight: number; note: string }> {
  return [{ ...input, weight: 1 }];
}

// Certified GameIQ Chess v2 quiet-mate pack.
//
// Provenance and immutable-evidence rule:
// - Source records are the JSON lines captured in
//   docs/benchmark/gameiq/chess-seed-results/seed-1.json through seed-30.json
//   (committed; regenerate any seed with scripts/generate-gameiq-chess-depth.mts
//   --seed <n> and diff — miner output is byte-deterministic).
// - The 20 exact candidates were de-duplicated by FEN + keyed move. Selection
//   then maximized represented keyed piece types, minimized the largest
//   piece-type bucket, balanced side-to-move, maximized forcing-bait count,
//   and used seed/candidate index as the final tie-breaker.
// - The result is 6 White / 6 Black with keyed B3/P3/Q3/N2/R1. Each scenario
//   below names its source seed and one-based candidate index.
// - NEVER hand-edit a FEN or keyed action. Replace the complete candidate with
//   a fresh miner JSON line, update its provenance, and rerun the pack guard.
//
// Labels intentionally use SAN piece designators without destination squares:
// the brief also requires title/prompt/label de-leak checks against both keyed
// squares, so full SAN would disclose the destination. The prover-backed note
// is identical across scenarios and contains no move information.
const CHESS_V2_BASE_SCENARIOS: ChessGameIqScenario[] = [
  // seed-5.json candidate 1: legalMoveCount=44, forcingBaitCount=15
  {
    id: "gameiq-v0.2-chess-quiet-mate-1",
    gameId: "chess",
    title: "Chess position D1 (Black to move)",
    category: "quiet-mate",
    difficulty: "hard",
    version: "0.1.0",
    prompt: BLACK_MOVE_PROMPT,
    initialState: { fen: "r1k3n1/6br/p2p1P1p/1P2p3/p2PKp1N/Bbq4P/P3P2R/6NB b - - 0 39" },
    expectedActions: expected({
      action: { from: "b3", to: "e6" },
      label: "B (quiet key)",
      note: "prover: unique quiet mate-in-2",
    }),
    tags: ["chess", "mate", "quiet", "depth"],
  },
  // seed-5.json candidate 2: legalMoveCount=38, forcingBaitCount=11
  {
    id: "gameiq-v0.2-chess-quiet-mate-2",
    gameId: "chess",
    title: "Chess position D2 (Black to move)",
    category: "quiet-mate",
    difficulty: "hard",
    version: "0.1.0",
    prompt: BLACK_MOVE_PROMPT,
    initialState: { fen: "b4k1r/2pr3p/1n2pppn/pp6/P2b1KPP/1PP2P1R/3BP1B1/RN4N1 b - - 1 27" },
    expectedActions: expected({
      action: { from: "d4", to: "f2" },
      label: "B (quiet key)",
      note: "prover: unique quiet mate-in-2",
    }),
    tags: ["chess", "mate", "quiet", "depth"],
  },
  // seed-6.json candidate 1: legalMoveCount=21, forcingBaitCount=5
  {
    id: "gameiq-v0.2-chess-quiet-mate-3",
    gameId: "chess",
    title: "Chess position D3 (Black to move)",
    category: "quiet-mate",
    difficulty: "hard",
    version: "0.1.0",
    prompt: BLACK_MOVE_PROMPT,
    initialState: { fen: "rn1rk3/p2p3q/bp2P1pB/b1pK1pPp/2P1PR1P/NP6/PR6/5BN1 b - - 6 36" },
    expectedActions: expected({
      action: { from: "d7", to: "d6" },
      label: "P (quiet key)",
      note: "prover: unique quiet mate-in-2",
    }),
    tags: ["chess", "mate", "quiet", "depth"],
  },
  // seed-12.json candidate 1: legalMoveCount=27, forcingBaitCount=9
  {
    id: "gameiq-v0.2-chess-quiet-mate-4",
    gameId: "chess",
    title: "Chess position D4 (Black to move)",
    category: "quiet-mate",
    difficulty: "hard",
    version: "0.1.0",
    prompt: BLACK_MOVE_PROMPT,
    initialState: { fen: "1n4nr/rb1p3q/pb3pk1/1PpPp1p1/QP2KBPp/P4P1P/4PR2/RN3BN1 b - - 1 23" },
    expectedActions: expected({
      action: { from: "c5", to: "c4" },
      label: "P (quiet key)",
      note: "prover: unique quiet mate-in-2",
    }),
    tags: ["chess", "mate", "quiet", "depth"],
  },
  // seed-13.json candidate 1: legalMoveCount=43, forcingBaitCount=9
  {
    id: "gameiq-v0.2-chess-quiet-mate-5",
    gameId: "chess",
    title: "Chess position D5 (White to move)",
    category: "quiet-mate",
    difficulty: "hard",
    version: "0.1.0",
    prompt: WHITE_MOVE_PROMPT,
    initialState: { fen: "1r1q1b1r/2p3pp/2NkBn2/pP6/1P1NppbP/2P2P2/3P2P1/R1B1KQR1 w - - 24 34" },
    expectedActions: expected({
      action: { from: "f1", to: "c4" },
      label: "Q (quiet key)",
      note: "prover: unique quiet mate-in-2",
    }),
    tags: ["chess", "mate", "quiet", "depth"],
  },
  // seed-18.json candidate 1: legalMoveCount=47, forcingBaitCount=21
  {
    id: "gameiq-v0.2-chess-quiet-mate-6",
    gameId: "chess",
    title: "Chess position D6 (White to move)",
    category: "quiet-mate",
    difficulty: "hard",
    version: "0.1.0",
    prompt: WHITE_MOVE_PROMPT,
    initialState: { fen: "rn4nr/pb6/B1pp1p2/3Qpk1p/1pR4P/PP4p1/2NPNPPb/B4K1R w - - 3 28" },
    expectedActions: expected({
      action: { from: "d5", to: "f7" },
      label: "Q (quiet key)",
      note: "prover: unique quiet mate-in-2",
    }),
    tags: ["chess", "mate", "quiet", "depth"],
  },
  // seed-19.json candidate 1: legalMoveCount=27, forcingBaitCount=7
  {
    id: "gameiq-v0.2-chess-quiet-mate-7",
    gameId: "chess",
    title: "Chess position D7 (Black to move)",
    category: "quiet-mate",
    difficulty: "hard",
    version: "0.1.0",
    prompt: BLACK_MOVE_PROMPT,
    initialState: { fen: "2b2b1r/1n2k1N1/1p1pP2n/rPpK1pqp/p1P4P/3P1PP1/P7/RQ1B2N1 b - - 1 31" },
    expectedActions: expected({
      action: { from: "b7", to: "d8" },
      label: "N (quiet key)",
      note: "prover: unique quiet mate-in-2",
    }),
    tags: ["chess", "mate", "quiet", "depth"],
  },
  // seed-23.json candidate 1: legalMoveCount=44, forcingBaitCount=10
  {
    id: "gameiq-v0.2-chess-quiet-mate-8",
    gameId: "chess",
    title: "Chess position D8 (Black to move)",
    category: "quiet-mate",
    difficulty: "hard",
    version: "0.1.0",
    prompt: BLACK_MOVE_PROMPT,
    initialState: { fen: "4k2r/r1qn2b1/1p3n2/1b2Nppp/P2p4/KP1PPPP1/R1P1B2P/2BQ1R2 b k - 2 26" },
    expectedActions: expected({
      action: { from: "c7", to: "c3" },
      label: "Q (quiet key)",
      note: "prover: unique quiet mate-in-2",
    }),
    tags: ["chess", "mate", "quiet", "depth"],
  },
  // seed-25.json candidate 1: legalMoveCount=38, forcingBaitCount=7
  {
    id: "gameiq-v0.2-chess-quiet-mate-9",
    gameId: "chess",
    title: "Chess position D9 (White to move)",
    category: "quiet-mate",
    difficulty: "hard",
    version: "0.1.0",
    prompt: WHITE_MOVE_PROMPT,
    initialState: { fen: "r6r/2pp1Qbk/p7/1p1PPPBP/PP3N2/3K2pR/2PRN1P1/5B2 w - - 1 34" },
    expectedActions: expected({
      action: { from: "h5", to: "h6" },
      label: "P (quiet key)",
      note: "prover: unique quiet mate-in-2",
    }),
    tags: ["chess", "mate", "quiet", "depth"],
  },
  // seed-27.json candidate 1: legalMoveCount=38, forcingBaitCount=12
  {
    id: "gameiq-v0.2-chess-quiet-mate-10",
    gameId: "chess",
    title: "Chess position D10 (White to move)",
    category: "quiet-mate",
    difficulty: "hard",
    version: "0.1.0",
    prompt: WHITE_MOVE_PROMPT,
    initialState: { fen: "rn2Q1nr/pb1p4/2pq1p1k/P6p/RpP1pp1P/1P1PP3/3NB3/2B2K1R w - - 0 35" },
    expectedActions: expected({
      action: { from: "h1", to: "g1" },
      label: "R (quiet key)",
      note: "prover: unique quiet mate-in-2",
    }),
    tags: ["chess", "mate", "quiet", "depth"],
  },
  // seed-29.json candidate 1: legalMoveCount=23, forcingBaitCount=5
  {
    id: "gameiq-v0.2-chess-quiet-mate-11",
    gameId: "chess",
    title: "Chess position D11 (White to move)",
    category: "quiet-mate",
    difficulty: "hard",
    version: "0.1.0",
    prompt: WHITE_MOVE_PROMPT,
    initialState: { fen: "r1bq2nb/5r2/1p1p1Pp1/p3p2p/2Pk2P1/P2P2N1/N2K1P1P/2B2B1R w - - 1 26" },
    expectedActions: expected({
      action: { from: "g3", to: "e4" },
      label: "N (quiet key)",
      note: "prover: unique quiet mate-in-2",
    }),
    tags: ["chess", "mate", "quiet", "depth"],
  },
  // seed-30.json candidate 1: legalMoveCount=49, forcingBaitCount=11
  {
    id: "gameiq-v0.2-chess-quiet-mate-12",
    gameId: "chess",
    title: "Chess position D12 (White to move)",
    category: "quiet-mate",
    difficulty: "hard",
    version: "0.1.0",
    prompt: WHITE_MOVE_PROMPT,
    initialState: { fen: "rqb3r1/2b2Bp1/pp4np/3ppP1k/2p1PBpP/1PN5/PN6/R3RQK1 w - - 4 36" },
    expectedActions: expected({
      action: { from: "f4", to: "g3" },
      label: "B (quiet key)",
      note: "prover: unique quiet mate-in-2",
    }),
    tags: ["chess", "mate", "quiet", "depth"],
  },
];

export const CHESS_V2_GAMEIQ_SCENARIOS: ChessGameIqScenario[] = CHESS_V2_BASE_SCENARIOS;
