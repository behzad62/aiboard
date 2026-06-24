import {
  buildBattleshipMoveResponseFormat,
  buildBattleshipPrompt,
  chooseFallbackBattleshipTarget,
  parseBattleshipAIResponse,
} from "../lib/games/battleship/ai";
import {
  createInitialBattleshipState,
  fireBattleshipShot,
} from "../lib/games/battleship/engine";

let failures = 0;

function check(name: string, ok: boolean, detail?: unknown): void {
  if (!ok) failures++;
  console.log(
    `${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` -> ${JSON.stringify(detail)}`}`
  );
}

const parsed = parseBattleshipAIResponse(`Here is the shot:
\`\`\`json
{"target":"B7","gesture":"confident","utterance":"Testing that lane.","confidence":1.4}
\`\`\``);

check("AI response parses A1 target labels", parsed?.target.row === 1 && parsed.target.column === 6, parsed);
check("AI response clamps confidence", parsed?.confidence === 1, parsed);
check("invalid target is rejected", parseBattleshipAIResponse('{"target":"K1"}') === null);

const format = buildBattleshipMoveResponseFormat();
check(
  "Battleship structured output requires target",
  JSON.stringify(format.schema.required) === JSON.stringify(["target"]),
  format
);
check(
  "Battleship structured output keeps optional text compact",
  format.schema.properties?.utterance?.maxLength === 48,
  format
);

const state = createInitialBattleshipState();
const prompt = buildBattleshipPrompt(state, "blue");
check(
  "Battleship prompt asks for compact target JSON",
  prompt.system.includes('{"target":"A1"}') &&
    prompt.user.includes("Available targets"),
  prompt
);

const afterMiss = fireBattleshipShot(state, { row: 0, column: 9 }, 1_000);
const fallback = chooseFallbackBattleshipTarget(afterMiss, "blue");
check(
  "fallback skips already fired cells",
  fallback !== null && !(fallback.row === 0 && fallback.column === 9),
  fallback
);

if (failures === 0) {
  console.log("PASS");
} else {
  console.log(`FAIL ${failures} check(s) failed`);
}

process.exit(failures === 0 ? 0 : 1);
