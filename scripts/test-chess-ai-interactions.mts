import {
  buildGameAIInteraction,
  hasVisibleGameAIInteraction,
} from "../lib/games/core/ai-interactions";
import {
  buildAICorrectionPrompt,
  chooseFallbackAIMove,
  formatLegalMoveList,
  getAIMoveRetryDelayMs,
  parseAIResponse,
} from "../lib/games/chess/ai";
import { fromFEN, generateLegalMoves } from "../lib/games/chess/engine";
import type { Move } from "../lib/games/chess/types";

let failures = 0;

function check(name: string, ok: boolean, detail?: unknown): void {
  if (!ok) failures++;
  console.log(
    `${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` -> ${JSON.stringify(detail)}`}`
  );
}

const parsed = parseAIResponse(`{
  "from": "e2",
  "to": "e4",
  "gesture": "confident",
  "utterance": "I like the central control here. The rest should be trimmed.",
  "confidence": 1.4,
  "diagnostics": "center push"
}`);

check("AI response parses move with metadata", parsed?.from === "e2" && parsed.to === "e4", parsed);
check("gesture is retained", parsed?.gesture === "confident", parsed);
check(
  "utterance is limited to one short sentence",
  parsed?.utterance === "I like the central control here.",
  parsed
);
check("confidence is clamped", parsed?.confidence === 1, parsed);
check("diagnostics are retained", parsed?.diagnostics === "center push", parsed);

const invalidGesture = parseAIResponse(`{
  "from": "g1",
  "to": "f3",
  "gesture": "dramatic",
  "utterance": "Developing the knight."
}`);

check("invalid gesture is ignored", invalidGesture?.gesture === undefined, invalidGesture);
check("valid utterance still survives invalid gesture", invalidGesture?.utterance === "Developing the knight.", invalidGesture);

const quiet = buildGameAIInteraction("black", {
  gesture: "neutral",
  confidence: 0.45,
});

check("quiet metadata can be stored", quiet?.confidence === 0.45, quiet);
check("neutral confidence-only metadata is not visible", !hasVisibleGameAIInteraction(quiet), quiet);

const visible = buildGameAIInteraction("white", {
  gesture: "celebrating",
});

check("non-neutral gesture is visible", hasVisibleGameAIInteraction(visible), visible);

const correctionMoves: Move[] = [
  { from: "e2", to: "e4" },
  { from: "g1", to: "f3" },
  { from: "e7", to: "e8", promotion: "queen" },
];
const legalMoveText = formatLegalMoveList(correctionMoves);
check("compact legal move list uses long algebraic notation", legalMoveText === "e2e4, g1f3, e7e8q", legalMoveText);

const parseCorrection = buildAICorrectionPrompt("parse", correctionMoves);
check("parse correction includes legal moves", parseCorrection.includes("Legal moves: e2e4, g1f3, e7e8q"), parseCorrection);
check("parse correction demands JSON only", parseCorrection.includes("ONLY valid JSON"), parseCorrection);

const illegalCorrection = buildAICorrectionPrompt("illegal", correctionMoves, {
  from: "a2",
  to: "a5",
});
check("illegal correction names bad move", illegalCorrection.includes("a2a5"), illegalCorrection);
check("illegal correction includes legal moves", illegalCorrection.includes("Legal moves: e2e4, g1f3, e7e8q"), illegalCorrection);

check("provider retry delay starts short", getAIMoveRetryDelayMs(0) === 250, getAIMoveRetryDelayMs(0));
check("provider retry delay backs off", getAIMoveRetryDelayMs(1) === 500, getAIMoveRetryDelayMs(1));

const captureState = fromFEN("3r3k/8/8/8/8/8/8/3QK3 w - - 0 1");
const legalCaptures = generateLegalMoves(captureState, "white").map((move) =>
  formatLegalMoveList([move])
);
const fallbackCapture = chooseFallbackAIMove(captureState);
check("fallback test position has quiet moves before capture", legalCaptures[0] !== "d1d8", legalCaptures.slice(0, 5));
check(
  "fallback prefers a queen capture over the first legal move",
  fallbackCapture?.from === "d1" && fallbackCapture.to === "d8",
  { fallbackCapture, legalCaptures: legalCaptures.slice(0, 12) }
);

if (failures === 0) {
  console.log("PASS");
} else {
  console.log(`FAIL ${failures} check(s) failed`);
}

process.exit(failures === 0 ? 0 : 1);
