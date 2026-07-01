import type { ChessGameIqScenario, ChessGameIqAction } from "./types";

function expected(
  action: ChessGameIqAction,
  label: string,
  note?: string
): Array<{ action: ChessGameIqAction; label: string; weight: number; note?: string }> {
  return [{ action, label, weight: 1, note }];
}

const CHESS_BASE_SCENARIOS: ChessGameIqScenario[] = [
  {
    id: "gameiq-v0.1-chess-back-rank-mate",
    gameId: "chess",
    title: "Chess: back-rank mate in one",
    category: "mate-in-one",
    difficulty: "easy",
    version: "0.1.0",
    prompt:
      "White to move from the FEN. Return the legal move that checkmates black in one.",
    initialState: {
      fen: "6k1/5ppp/8/8/8/8/5PPP/4R1K1 w - - 0 1",
    },
    expectedActions: expected(
      { from: "e1", to: "e8" },
      "Re8#",
      "The rook gives back-rank mate."
    ),
    tags: ["chess", "mate", "back-rank"],
    maxResponseMs: 15_000,
  },
  {
    id: "gameiq-v0.1-chess-queen-mate",
    gameId: "chess",
    title: "Chess: queen mate in one",
    category: "mate-in-one",
    difficulty: "easy",
    version: "0.1.0",
    prompt:
      "White to move from the FEN. Return the legal queen move that checkmates black.",
    initialState: {
      fen: "7k/8/5K2/8/8/8/8/6Q1 w - - 0 1",
    },
    expectedActions: expected(
      { from: "g1", to: "g7" },
      "Qg7#",
      "The queen is protected by the king and boxes black into the corner."
    ),
    tags: ["chess", "mate", "queen"],
    maxResponseMs: 15_000,
  },
  {
    id: "gameiq-v0.1-chess-knight-wins-queen",
    gameId: "chess",
    title: "Chess: knight captures a loose queen",
    category: "legal-tactic",
    difficulty: "easy",
    version: "0.1.0",
    prompt:
      "White to move from the FEN. Return the legal knight move that wins black's queen.",
    initialState: {
      fen: "4k3/8/8/8/3q4/8/4N3/4K3 w - - 0 1",
    },
    expectedActions: expected(
      { from: "e2", to: "d4" },
      "Nxd4",
      "The knight legally captures the queen on d4."
    ),
    tags: ["chess", "capture", "material"],
    maxResponseMs: 15_000,
  },
  {
    id: "gameiq-v0.1-chess-promotion-tactic",
    gameId: "chess",
    title: "Chess: promote the passed pawn",
    category: "legal-tactic",
    difficulty: "medium",
    version: "0.1.0",
    prompt:
      "White to move from the FEN. Return the legal promotion move that makes a queen.",
    initialState: {
      fen: "4k3/P7/8/8/8/8/8/4K3 w - - 0 1",
    },
    expectedActions: expected(
      { from: "a7", to: "a8", promotion: "queen" },
      "a8=Q",
      "Promote the pawn to a queen."
    ),
    tags: ["chess", "promotion", "material"],
    maxResponseMs: 15_000,
  },
];

export const CHESS_GAMEIQ_SCENARIOS: ChessGameIqScenario[] = CHESS_BASE_SCENARIOS;
