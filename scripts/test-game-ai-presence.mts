import {
  buildGameAIThinkingInteraction,
  resolveGameAIDisplay,
} from "../lib/games/core/ai-interactions";
import { buildBattleshipPrompt } from "../lib/games/battleship/ai";
import { createInitialBattleshipState } from "../lib/games/battleship/engine";
import { buildChessPrompt } from "../lib/games/chess/ai";
import { createInitialState as createInitialChessState } from "../lib/games/chess/engine";
import { buildCodenamesSpymasterPrompt } from "../lib/games/codenames/ai";
import { createCodenamesStateFromBoard } from "../lib/games/codenames/engine";
import type { CodenamesCard } from "../lib/games/codenames/types";
import { buildConnectFourPrompt } from "../lib/games/connect-four/ai";
import { createInitialConnectFourState } from "../lib/games/connect-four/engine";

let failures = 0;

function check(name: string, ok: boolean, detail?: unknown): void {
  if (!ok) failures++;
  console.log(
    `${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` -> ${JSON.stringify(detail)}`}`
  );
}

const unsafeChessLine = resolveGameAIDisplay({
  actorId: "black",
  gesture: "confident",
  utterance: "Putting pressure on the c-file and targeting the c2 pawn.",
});

check(
  "unsafe tactical AI text is replaced with table-talk",
  unsafeChessLine?.utterance === "I like this turn.",
  unsafeChessLine
);
check(
  "AI voice labels the player instead of the robot",
  unsafeChessLine?.actorLabel === "Black",
  unsafeChessLine
);

const thinking = buildGameAIThinkingInteraction("yellow");
check(
  "thinking copy sounds like a player",
  thinking.utterance === "Give me a second..." &&
    !thinking.utterance.toLowerCase().includes("ai"),
  thinking
);

const quietConfident = resolveGameAIDisplay({
  actorId: "orange",
  gesture: "confident",
});
check(
  "non-neutral gesture gets a safe default line",
  quietConfident?.utterance === "I like this turn.",
  quietConfident
);

const chessPrompt = buildChessPrompt(createInitialChessState()).system;
check(
  "chess prompt asks for safe table-talk only",
  chessPrompt.includes("table-talk") &&
    chessPrompt.includes("Do not mention squares") &&
    chessPrompt.includes("future plans"),
  chessPrompt
);

const connectFourPrompt = buildConnectFourPrompt(
  createInitialConnectFourState()
).system;
check(
  "Connect Four prompt asks for safe table-talk only",
  connectFourPrompt.includes("table-talk") &&
    connectFourPrompt.includes("Do not mention columns") &&
    connectFourPrompt.includes("future plans"),
  connectFourPrompt
);

const battleshipPrompt = buildBattleshipPrompt(
  createInitialBattleshipState(),
  "blue"
).system;
check(
  "Battleship prompt asks for safe table-talk only",
  battleshipPrompt.includes("table-talk") &&
    battleshipPrompt.includes("Do not mention coordinates") &&
    battleshipPrompt.includes("search patterns"),
  battleshipPrompt
);

function card(id: string, word: string, role: CodenamesCard["role"]): CodenamesCard {
  return { id, word, role, revealed: false };
}

const codenamesPrompt = buildCodenamesSpymasterPrompt(
  createCodenamesStateFromBoard(
    [
      card("red-1", "MOON", "red"),
      card("red-2", "STAR", "red"),
      card("red-3", "RIVER", "red"),
      card("blue-1", "BANK", "blue"),
      card("blue-2", "PLANE", "blue"),
      card("neutral-1", "CHAIR", "neutral"),
      card("neutral-2", "COTTON", "neutral"),
      card("neutral-3", "PIANO", "neutral"),
      card("assassin", "BOMB", "assassin"),
      card("red-4", "SHIP", "red"),
      card("red-5", "CLOUD", "red"),
      card("red-6", "FOREST", "red"),
      card("red-7", "HORSE", "red"),
      card("red-8", "GOLD", "red"),
      card("red-9", "MOUSE", "red"),
      card("blue-3", "CROWN", "blue"),
      card("blue-4", "NURSE", "blue"),
      card("blue-5", "MOUNT", "blue"),
      card("blue-6", "BREAD", "blue"),
      card("blue-7", "WALL", "blue"),
      card("blue-8", "ROBOT", "blue"),
      card("neutral-4", "LAMP", "neutral"),
      card("neutral-5", "BRUSH", "neutral"),
      card("neutral-6", "CLOCK", "neutral"),
      card("neutral-7", "GLASS", "neutral"),
    ],
    "red"
  ),
  "red"
).system;
check(
  "Codenames prompt blocks hidden-info table-talk leaks",
  codenamesPrompt.includes("table-talk") &&
    codenamesPrompt.includes("Do not mention board words") &&
    codenamesPrompt.includes("intended words"),
  codenamesPrompt
);

if (failures === 0) {
  console.log("PASS");
} else {
  console.log(`FAIL ${failures} check(s) failed`);
}

process.exit(failures === 0 ? 0 : 1);
