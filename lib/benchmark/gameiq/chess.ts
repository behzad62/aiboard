import type { ChessGameIqScenario, ChessGameIqAction } from "./types";

interface ExpectedInput {
  action: ChessGameIqAction;
  label: string;
  note?: string;
}

function expected(
  ...inputs: ExpectedInput[]
): Array<{ action: ChessGameIqAction; label: string; weight: number; note?: string }> {
  return inputs.map((input) => ({ ...input, weight: 1 }));
}

// GameIQ Chess pack.
//
// Every scenario is engine-verified by scripts/test-gameiq-chess-pack.mts, which
// parses each FEN, asserts the side to move, asserts every expected action is
// legal, and behaviourally verifies the tactical claim (mates are the only /
// exactly the listed checkmates; hanging captures net material and survive the
// best one-ply recapture while the tempting distractor loses; the defensive
// move is the ONLY reply that averts mate; promotions beat every non-promoting
// alternative). The test — not hand analysis — is the correctness gate.
//
// Answer-leak discipline: scenario `prompt` strings are task-neutral ("Find the
// best move for White/Black") and NEVER name the tactic, piece, or square. The
// `title`/`note` fields are authoring/UI metadata only (the shared prompt
// builder in certified-runner.ts does not send them to the model, and
// scripts/test-gameiq-shared-guards.mts asserts the prompt never contains them),
// but they are kept non-leaking too.
//
// Categories: mates use "mate-in-one" (shared validateChessMateInOne replays
// them). Captures, defenses and promotions use "avoid-losing-move"; the shared
// validator only checks expected-action legality for that chess category, so the
// deep tactical assertions live in the pack test. The weak "legal-tactic"
// category is deliberately unused by this pack (its validator was removed
// 2026-07-02).
const WHITE_MOVE_PROMPT = "It is White to move. Return White's single best move as JSON.";
const BLACK_MOVE_PROMPT = "It is Black to move. Return Black's single best move as JSON.";

const CHESS_BASE_SCENARIOS: ChessGameIqScenario[] = [
  // ---- mate-in-one: White ----
  {
    id: "gameiq-v0.1-chess-back-rank-mate",
    gameId: "chess",
    title: "Chess position 1 (White to move)",
    category: "mate-in-one",
    difficulty: "easy",
    version: "0.1.0",
    prompt: WHITE_MOVE_PROMPT,
    initialState: { fen: "6k1/5ppp/8/8/8/8/5PPP/4R1K1 w - - 0 1" },
    expectedActions: expected({
      action: { from: "e1", to: "e8" },
      label: "Re8#",
      note: "Back-rank checkmate; the only mate among 20 legal moves.",
    }),
    tags: ["chess", "mate"],
    maxResponseMs: 15_000,
  },
  {
    id: "gameiq-v0.1-chess-queen-mate",
    gameId: "chess",
    title: "Chess position 2 (White to move)",
    category: "mate-in-one",
    difficulty: "easy",
    version: "0.1.0",
    prompt: WHITE_MOVE_PROMPT,
    initialState: { fen: "7k/8/5K2/8/8/8/8/6Q1 w - - 0 1" },
    expectedActions: expected({
      action: { from: "g1", to: "g7" },
      label: "Qg7#",
      note: "King-supported queen mate; the only mate, though several other checks exist.",
    }),
    tags: ["chess", "mate"],
    maxResponseMs: 15_000,
  },
  {
    id: "gameiq-v0.1-chess-smothered-mate",
    gameId: "chess",
    title: "Chess position 3 (White to move)",
    category: "mate-in-one",
    difficulty: "medium",
    version: "0.1.0",
    prompt: WHITE_MOVE_PROMPT,
    initialState: { fen: "6rk/6pp/7N/8/8/8/8/6K1 w - - 0 1" },
    expectedActions: expected({
      action: { from: "h6", to: "f7" },
      label: "Nf7#",
      note: "Smothered mate; capturing the rook instead only wins material.",
    }),
    tags: ["chess", "mate"],
    maxResponseMs: 15_000,
  },
  {
    id: "gameiq-v0.1-chess-promotion-mate",
    gameId: "chess",
    title: "Chess position 4 (White to move)",
    category: "mate-in-one",
    difficulty: "medium",
    version: "0.1.0",
    prompt: WHITE_MOVE_PROMPT,
    initialState: { fen: "k7/1P6/8/8/8/8/8/1R4K1 w - - 0 1" },
    expectedActions: expected({
      action: { from: "b7", to: "b8", promotion: "queen" },
      label: "b8=Q#",
      note: "Promote with mate; promoting to a rook only checks.",
    }),
    tags: ["chess", "mate", "promotion"],
    maxResponseMs: 15_000,
  },
  {
    id: "gameiq-v0.1-chess-double-mate",
    gameId: "chess",
    title: "Chess position 5 (White to move)",
    category: "mate-in-one",
    difficulty: "medium",
    version: "0.1.0",
    prompt: WHITE_MOVE_PROMPT,
    initialState: { fen: "6k1/5ppp/8/8/8/8/5PPP/R3Q1K1 w - - 0 1" },
    expectedActions: expected(
      {
        action: { from: "a1", to: "a8" },
        label: "Ra8#",
        note: "One of two equally forcing back-rank mates.",
      },
      {
        action: { from: "e1", to: "e8" },
        label: "Qe8#",
        note: "One of two equally forcing back-rank mates.",
      }
    ),
    tags: ["chess", "mate"],
    maxResponseMs: 15_000,
  },
  // ---- mate-in-one: Black ----
  {
    id: "gameiq-v0.1-chess-black-back-rank-mate",
    gameId: "chess",
    title: "Chess position 6 (Black to move)",
    category: "mate-in-one",
    difficulty: "easy",
    version: "0.1.0",
    prompt: BLACK_MOVE_PROMPT,
    initialState: { fen: "3r2k1/5ppp/8/8/8/8/5PPP/6K1 b - - 0 1" },
    expectedActions: expected({
      action: { from: "d8", to: "d1" },
      label: "Rd1#",
      note: "Back-rank checkmate for Black.",
    }),
    tags: ["chess", "mate"],
    maxResponseMs: 15_000,
  },
  {
    id: "gameiq-v0.1-chess-black-smothered-mate",
    gameId: "chess",
    title: "Chess position 7 (Black to move)",
    category: "mate-in-one",
    difficulty: "medium",
    version: "0.1.0",
    prompt: BLACK_MOVE_PROMPT,
    initialState: { fen: "6k1/8/8/8/8/7n/6PP/6RK b - - 0 1" },
    expectedActions: expected({
      action: { from: "h3", to: "f2" },
      label: "Nf2#",
      note: "Smothered mate for Black in the corner.",
    }),
    tags: ["chess", "mate"],
    maxResponseMs: 15_000,
  },
  {
    id: "gameiq-v0.1-chess-black-queen-mate",
    gameId: "chess",
    title: "Chess position 8 (Black to move)",
    category: "mate-in-one",
    difficulty: "easy",
    version: "0.1.0",
    prompt: BLACK_MOVE_PROMPT,
    initialState: { fen: "6q1/8/8/8/8/5k2/8/7K b - - 0 1" },
    expectedActions: expected({
      action: { from: "g8", to: "g2" },
      label: "Qg2#",
      note: "King-supported queen mate for Black.",
    }),
    tags: ["chess", "mate"],
    maxResponseMs: 15_000,
  },
  {
    id: "gameiq-v0.1-chess-black-double-mate",
    gameId: "chess",
    title: "Chess position 9 (Black to move)",
    category: "mate-in-one",
    difficulty: "medium",
    version: "0.1.0",
    prompt: BLACK_MOVE_PROMPT,
    initialState: { fen: "r3q1k1/5ppp/8/8/8/8/5PPP/6K1 b - - 0 1" },
    expectedActions: expected(
      {
        action: { from: "a8", to: "a1" },
        label: "Ra1#",
        note: "One of two equally forcing back-rank mates for Black.",
      },
      {
        action: { from: "e8", to: "e1" },
        label: "Qe1#",
        note: "One of two equally forcing back-rank mates for Black.",
      }
    ),
    tags: ["chess", "mate"],
    maxResponseMs: 15_000,
  },
  // ---- winning captures ----
  {
    id: "gameiq-v0.1-chess-knight-wins-queen",
    gameId: "chess",
    title: "Chess position 10 (White to move)",
    category: "avoid-losing-move",
    difficulty: "easy",
    version: "0.1.0",
    prompt: WHITE_MOVE_PROMPT,
    initialState: { fen: "4k3/8/8/8/3q4/8/4N3/4K3 w - - 0 1" },
    expectedActions: expected({
      action: { from: "e2", to: "d4" },
      label: "Nxd4",
      note: "Capture the undefended queen; nothing recaptures.",
    }),
    tags: ["chess", "capture", "material"],
    maxResponseMs: 15_000,
  },
  {
    id: "gameiq-v0.1-chess-hanging-rook-trap",
    gameId: "chess",
    title: "Chess position 11 (White to move)",
    category: "avoid-losing-move",
    difficulty: "medium",
    version: "0.1.0",
    prompt: WHITE_MOVE_PROMPT,
    initialState: { fen: "4k3/8/6p1/3r1p2/8/4N3/8/4K3 w - - 0 1" },
    expectedActions: expected({
      action: { from: "e3", to: "d5" },
      label: "Nxd5",
      note: "Win the undefended rook; the f5 pawn is defended and capturing it loses the knight.",
    }),
    tags: ["chess", "capture", "distractor", "material"],
    maxResponseMs: 15_000,
  },
  {
    id: "gameiq-v0.1-chess-black-wins-rook-trap",
    gameId: "chess",
    title: "Chess position 12 (Black to move)",
    category: "avoid-losing-move",
    difficulty: "medium",
    version: "0.1.0",
    prompt: BLACK_MOVE_PROMPT,
    initialState: { fen: "4k3/8/4n3/8/3R1P2/6P1/8/4K3 b - - 0 1" },
    expectedActions: expected({
      action: { from: "e6", to: "d4" },
      label: "Nxd4",
      note: "Win the undefended rook; the f4 pawn is defended and capturing it loses the knight.",
    }),
    tags: ["chess", "capture", "distractor", "material"],
    maxResponseMs: 15_000,
  },
  // ---- defense: the only move that averts mate ----
  {
    id: "gameiq-v0.1-chess-only-defense",
    gameId: "chess",
    title: "Chess position 13 (White to move)",
    category: "avoid-losing-move",
    difficulty: "hard",
    version: "0.1.0",
    prompt: WHITE_MOVE_PROMPT,
    initialState: { fen: "6k1/1b6/8/8/6q1/8/5NPP/7K w - - 0 1" },
    expectedActions: expected({
      action: { from: "f2", to: "g4" },
      label: "Nxg4",
      note: "Capturing the queen is the only move that stops the threatened mate on g2.",
    }),
    tags: ["chess", "defense", "mate-threat"],
    maxResponseMs: 15_000,
  },
  // ---- promotion best-move ----
  {
    id: "gameiq-v0.1-chess-promotion-tactic",
    gameId: "chess",
    title: "Chess position 14 (White to move)",
    category: "avoid-losing-move",
    difficulty: "easy",
    version: "0.1.0",
    prompt: WHITE_MOVE_PROMPT,
    initialState: { fen: "4k3/P7/8/8/8/8/8/4K3 w - - 0 1" },
    expectedActions: expected({
      action: { from: "a7", to: "a8", promotion: "queen" },
      label: "a8=Q",
      note: "Promote to a queen; every non-promoting alternative keeps the pawn.",
    }),
    tags: ["chess", "promotion", "material"],
    maxResponseMs: 15_000,
  },
  {
    id: "gameiq-v0.1-chess-black-promotion",
    gameId: "chess",
    title: "Chess position 15 (Black to move)",
    category: "avoid-losing-move",
    difficulty: "easy",
    version: "0.1.0",
    prompt: BLACK_MOVE_PROMPT,
    initialState: { fen: "4k3/8/8/8/8/8/p7/4K3 b - - 0 1" },
    expectedActions: expected({
      action: { from: "a2", to: "a1", promotion: "queen" },
      label: "a1=Q",
      note: "Promote to a queen; every non-promoting alternative keeps the pawn.",
    }),
    tags: ["chess", "promotion", "material"],
    maxResponseMs: 15_000,
  },
];

export const CHESS_GAMEIQ_SCENARIOS: ChessGameIqScenario[] = CHESS_BASE_SCENARIOS;
