/** Quoridor AI parse/fallback checks (run: npx tsx scripts/test-quoridor-ai.mts) */
import {
  buildQuoridorCorrectionPrompt,
  chooseFallbackQuoridorAction,
  formatLegalActionList,
  parseQuoridorAIResponse,
} from "../lib/games/quoridor/ai";
import {
  applyQuoridorAction,
  createInitialQuoridorState,
  formatQuoridorAction,
} from "../lib/games/quoridor/engine";
import type { QuoridorAction } from "../lib/games/quoridor/types";

let failures = 0;

function check(name: string, ok: boolean, detail?: unknown): void {
  if (!ok) failures++;
  console.log(
    `${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` -> ${JSON.stringify(detail)}`}`
  );
}

const parsed = parseQuoridorAIResponse(`Here is my move:
\`\`\`json
{
  "action": "move",
  "square": "e2",
  "reasoning": "Step forward.",
  "gesture": "confident",
  "utterance": "Advancing.",
  "confidence": 0.8,
  "diagnostics": "opening"
}
\`\`\``);

check(
  "AI response parses algebraic pawn move",
  parsed?.action.type === "move" &&
    parsed.action.row === 7 &&
    parsed.action.col === 4,
  parsed
);
check("reasoning is retained", parsed?.reasoning === "Step forward.", parsed);
check("gesture is retained", parsed?.gesture === "confident", parsed);

const wallParsed = parseQuoridorAIResponse(
  '{"action":"wall","square":"c6","orientation":"H"}'
);
check(
  "AI response parses algebraic wall",
  wallParsed?.action.type === "wall" &&
    wallParsed.action.orientation === "H" &&
    wallParsed.action.row === 3 &&
    wallParsed.action.col === 2,
  wallParsed
);

check(
  "non-json response is rejected",
  parseQuoridorAIResponse("move the pawn up") === null
);

const legal: QuoridorAction[] = [
  { type: "move", row: 7, col: 4 },
  { type: "wall", row: 3, col: 2, orientation: "H" },
];
check(
  "legal actions format uses algebraic notation",
  formatLegalActionList(legal) === "e2, c6h",
  formatLegalActionList(legal)
);

const correction = buildQuoridorCorrectionPrompt("illegal", legal, "e4");
check(
  "illegal correction includes rejected action",
  correction.includes("e4") && correction.includes("e2"),
  correction
);

const initial = createInitialQuoridorState(1_000);
const fallback = chooseFallbackQuoridorAction(initial);
check(
  "fallback on an empty board is the shortest-path pawn step",
  fallback !== null &&
    fallback.type === "move" &&
    formatQuoridorAction(fallback) === "e2",
  fallback
);

const almostWin = applyQuoridorAction(
  [
    { type: "move", row: 7, col: 4 },
    { type: "move", row: 0, col: 5 },
    { type: "move", row: 6, col: 4 },
    { type: "move", row: 0, col: 4 },
    { type: "move", row: 5, col: 4 },
    { type: "move", row: 0, col: 5 },
    { type: "move", row: 4, col: 4 },
    { type: "move", row: 0, col: 4 },
    { type: "move", row: 3, col: 4 },
    { type: "move", row: 0, col: 5 },
    { type: "move", row: 2, col: 4 },
    { type: "move", row: 0, col: 4 },
    { type: "move", row: 1, col: 4 },
    { type: "move", row: 0, col: 5 },
  ].reduce(
    (state, action, index) => applyQuoridorAction(state, action, 2_000 + index),
    createInitialQuoridorState(2_000)
  ),
  { type: "move", row: 0, col: 4 },
  3_000
);
check(
  "winning south pawn is recognized after reaching rank 9",
  almostWin.status === "win" && almostWin.winner === "south",
  { status: almostWin.status, winner: almostWin.winner }
);

if (failures === 0) {
  console.log("PASS");
} else {
  console.log(`FAIL ${failures} check(s) failed`);
}

process.exit(failures === 0 ? 0 : 1);
