import {
  buildConnectFourCorrectionPrompt,
  chooseFallbackConnectFourColumn,
  formatLegalColumnList,
  getConnectFourRetryDelayMs,
  parseConnectFourAIResponse,
} from "../lib/games/connect-four/ai";
import {
  createInitialConnectFourState,
  dropDisc,
} from "../lib/games/connect-four/engine";
import type { ConnectFourGameState } from "../lib/games/connect-four/types";

let failures = 0;

function check(name: string, ok: boolean, detail?: unknown): void {
  if (!ok) failures++;
  console.log(
    `${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` -> ${JSON.stringify(detail)}`}`
  );
}

function playColumns(columns: number[]): ConnectFourGameState {
  return columns.reduce(
    (state, column, index) => dropDisc(state, column, index),
    createInitialConnectFourState()
  );
}

const parsed = parseConnectFourAIResponse(`Here is my move:
\`\`\`json
{
  "column": 4,
  "reasoning": "Center control is best.",
  "gesture": "confident",
  "utterance": "Taking the center.",
  "confidence": 1.5,
  "diagnostics": "opening book"
}
\`\`\``);

check("AI response parses one-based column to zero-based", parsed?.column === 3, parsed);
check("reasoning is retained", parsed?.reasoning === "Center control is best.", parsed);
check("gesture is retained", parsed?.gesture === "confident", parsed);
check("utterance is retained", parsed?.utterance === "Taking the center.", parsed);
check("confidence is clamped", parsed?.confidence === 1, parsed);
check("diagnostics are retained", parsed?.diagnostics === "opening book", parsed);

check(
  "non-json response is rejected",
  parseConnectFourAIResponse("drop in column four") === null
);
check(
  "out-of-board column is rejected",
  parseConnectFourAIResponse('{"column":8}') === null
);
check(
  "legal columns are formatted as one-based list",
  formatLegalColumnList([0, 2, 6]) === "1, 3, 7",
  formatLegalColumnList([0, 2, 6])
);

const correction = buildConnectFourCorrectionPrompt("illegal", [0, 2, 6], 4);
check(
  "illegal correction includes rejected one-based column",
  correction.includes("5"),
  correction
);
check(
  "illegal correction includes legal one-based columns",
  correction.includes("Legal columns: 1, 3, 7"),
  correction
);

check("retry delay starts at 250ms", getConnectFourRetryDelayMs(0) === 250);
check("retry delay doubles on second attempt", getConnectFourRetryDelayMs(1) === 500);

check(
  "fallback chooses center on empty board",
  chooseFallbackConnectFourColumn(createInitialConnectFourState()) === 3
);

const immediateWin = playColumns([0, 3, 1, 3, 2, 4]);
check(
  "fallback wins immediately",
  chooseFallbackConnectFourColumn(immediateWin) === 3,
  {
    column: chooseFallbackConnectFourColumn(immediateWin),
    board: immediateWin.board,
  }
);

const mustBlock = playColumns([6, 0, 5, 1, 6, 2]);
check(
  "fallback blocks opponent immediate win",
  chooseFallbackConnectFourColumn(mustBlock) === 3,
  {
    column: chooseFallbackConnectFourColumn(mustBlock),
    board: mustBlock.board,
  }
);

if (failures === 0) {
  console.log("PASS");
} else {
  console.log(`FAIL ${failures} check(s) failed`);
}

process.exit(failures === 0 ? 0 : 1);
