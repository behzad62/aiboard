import {
  buildGameAIInteraction,
  hasVisibleGameAIInteraction,
} from "../lib/games/core/ai-interactions";
import { CHESS_AI_MAX_TOKENS, parseAIResponse } from "../lib/games/chess/ai";

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
check(
  "chess AI uses enough output budget for structured JSON with reasoning",
  CHESS_AI_MAX_TOKENS >= 4096,
  CHESS_AI_MAX_TOKENS
);

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

if (failures === 0) {
  console.log("PASS");
} else {
  console.log(`FAIL ${failures} check(s) failed`);
}

process.exit(failures === 0 ? 0 : 1);
