/* Certified GameIQ action normalization guards
 * (run: npx tsx scripts/test-gameiq-action-normalization.mts)
 *
 * Covers wave-1/2 chess-validation cleanup:
 * 1. Chess promotion synonyms (single-letter UCI q/r/b/n, any case, and case
 *    variants of the full words) normalize candidate-side to the canonical
 *    piece string, so a chess-correct promotion scores legal + correct even on
 *    providers without schema enforcement. ExpectedActions stay canonical.
 * 2. A wrong promotion piece still scores zero.
 * 3. Non-promotion moves are unaffected.
 * 4. The removed validateChessLegalTactic validator is really gone (no export).
 */
import {
  actionMatchesExpected,
  isStructuredGameIqAction,
  validateGameIqAction,
} from "../lib/benchmark/gameiq/validation";
import * as validationModule from "../lib/benchmark/gameiq/validation";
import type {
  ChessGameIqScenario,
  GameIqScenario,
} from "../lib/benchmark/gameiq/types";

let failures = 0;

function check(name: string, ok: boolean, detail?: unknown): void {
  if (!ok) failures++;
  console.log(
    `${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` -> ${JSON.stringify(detail)}`}`
  );
}

// White pawn on a7, expected promotion to queen at a8. Mirrors the real
// gameiq-v0.1-chess-promotion-tactic scenario shape.
const whitePromotion: ChessGameIqScenario = {
  id: "test-chess-white-promotion",
  gameId: "chess",
  title: "Chess promotion test",
  category: "avoid-losing-move",
  difficulty: "easy",
  version: "0.1.0",
  prompt: "White to move.",
  initialState: { fen: "4k3/P7/8/8/8/8/8/4K3 w - - 0 1" },
  expectedActions: [
    {
      action: { from: "a7", to: "a8", promotion: "queen" },
      label: "a8=Q",
      weight: 1,
    },
  ],
  tags: ["chess", "promotion"],
};

// Non-promotion scenario: a simple king move, expected e1->e2 (no promotion).
const nonPromotion: ChessGameIqScenario = {
  id: "test-chess-non-promotion",
  gameId: "chess",
  title: "Chess non-promotion test",
  category: "avoid-losing-move",
  difficulty: "easy",
  version: "0.1.0",
  prompt: "White to move.",
  initialState: { fen: "4k3/8/8/8/8/8/8/4K3 w - - 0 1" },
  expectedActions: [
    { action: { from: "e1", to: "e2" }, label: "Ke2", weight: 1 },
  ],
  tags: ["chess"],
};

// Replicate the runner's scoring sequence so we exercise the same boundary the
// production harness uses: shape gate -> legality -> correctness.
function score(
  scenario: GameIqScenario,
  candidate: unknown
): { structured: boolean; legal: boolean; quality: number } {
  const structured = isStructuredGameIqAction(scenario, candidate);
  const legal = structured
    ? validateGameIqAction(scenario, candidate).ok
    : false;
  const quality = legal ? actionMatchesExpected(scenario, candidate) : 0;
  return { structured, legal, quality };
}

// 1. Promotion synonyms normalize and score correct.
for (const promo of ["q", "Q", "queen", "QUEEN", "Queen", " Queen "]) {
  const result = score(whitePromotion, {
    from: "a7",
    to: "a8",
    promotion: promo,
  });
  check(
    `promotion synonym ${JSON.stringify(promo)} scores legal + correct`,
    result.structured && result.legal && result.quality === 1,
    result
  );
}

// Underpromotion synonyms also normalize (legality proven; correctness for the
// scenario's expected queen is separately checked below).
{
  const knightCandidate = { from: "a7", to: "a8", promotion: "n" as string };
  const knightScore = score(whitePromotion, knightCandidate);
  check(
    'promotion synonym "n" is legal (underpromotion to knight)',
    knightScore.structured && knightScore.legal,
    knightScore
  );
  // In-place normalization must have rewritten the candidate to canonical.
  check(
    'promotion synonym "n" normalized in place to "knight"',
    knightCandidate.promotion === "knight",
    knightCandidate.promotion
  );
}

// 2. Wrong promotion piece scores zero (legal but not the expected queen).
{
  const wrong = score(whitePromotion, {
    from: "a7",
    to: "a8",
    promotion: "n",
  });
  check(
    "wrong promotion piece (knight) is legal but scores quality 0",
    wrong.structured && wrong.legal && wrong.quality === 0,
    wrong
  );
  // Canonical full-word wrong piece likewise scores zero.
  const wrongRook = score(whitePromotion, {
    from: "a7",
    to: "a8",
    promotion: "R",
  });
  check(
    'wrong promotion piece "R" scores quality 0',
    wrongRook.quality === 0,
    wrongRook
  );
}

// 3. Non-promotion moves are unaffected: correct move scores 1, and a candidate
//    with no promotion field is untouched.
{
  const correct = score(nonPromotion, { from: "e1", to: "e2" });
  check(
    "non-promotion correct move scores legal + correct",
    correct.structured && correct.legal && correct.quality === 1,
    correct
  );
  const noPromoCandidate: Record<string, unknown> = { from: "e1", to: "e2" };
  isStructuredGameIqAction(nonPromotion, noPromoCandidate);
  check(
    "non-promotion candidate keeps promotion field absent after gate",
    !("promotion" in noPromoCandidate) ||
      noPromoCandidate.promotion === undefined,
    noPromoCandidate
  );
  // A wrong non-promotion move still scores zero.
  const wrongMove = score(nonPromotion, { from: "e1", to: "d2" });
  check(
    "non-promotion wrong move scores quality 0",
    wrongMove.quality === 0,
    wrongMove
  );
}

// An unrecognized promotion string is left as-is and correctly fails legality
// (not silently coerced to a piece).
{
  const bogus: Record<string, unknown> = {
    from: "a7",
    to: "a8",
    promotion: "dragon",
  };
  const result = score(whitePromotion, bogus);
  check(
    'unrecognized promotion "dragon" stays as-is and is illegal',
    bogus.promotion === "dragon" && !result.legal,
    { promotion: bogus.promotion, result }
  );
}

// 4. The removed weak validator must not be exported anymore.
check(
  "validateChessLegalTactic is no longer exported",
  !("validateChessLegalTactic" in validationModule),
  Object.keys(validationModule).filter((k) => k.toLowerCase().includes("tactic"))
);

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
