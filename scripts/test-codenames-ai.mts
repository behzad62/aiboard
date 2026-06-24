import {
  buildCodenamesGuesserPrompt,
  buildCodenamesGuessResponseFormat,
  buildCodenamesSpymasterPrompt,
  buildCodenamesSpymasterResponseFormat,
  CODENAMES_AI_MAX_TOKENS,
  parseCodenamesGuesserResponse,
  parseCodenamesGuesserResponseResult,
  parseCodenamesSpymasterResponse,
  parseCodenamesSpymasterResponseResult,
} from "../lib/games/codenames/ai";
import {
  createCodenamesStateFromBoard,
  submitCodenamesClue,
  submitCodenamesGuess,
} from "../lib/games/codenames/engine";
import type { CodenamesCard } from "../lib/games/codenames/types";

let failures = 0;

function check(name: string, ok: boolean, detail?: unknown): void {
  if (!ok) failures++;
  console.log(
    `${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` -> ${JSON.stringify(detail)}`}`
  );
}

function card(id: string, word: string, role: CodenamesCard["role"]): CodenamesCard {
  return { id, word, role, revealed: false };
}

const state = createCodenamesStateFromBoard(
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
);

const parsedClue = parseCodenamesSpymasterResponse(
  state,
  `Here is the clue:
\`\`\`json
{
  "clue": "space",
  "count": 2,
  "intendedWords": ["MOON", "STAR"],
  "riskNotes": "Avoid BOMB.",
  "utterance": "Look upward.",
  "confidence": 0.9
}
\`\`\``
);

check("spymaster response parses clue", parsedClue?.clue.word === "space", parsedClue);
check("spymaster response parses count", parsedClue?.clue.count === 2, parsedClue);
check(
  "spymaster response retains private intended words outside public clue",
  parsedClue?.intendedWords?.join(",") === "MOON,STAR" &&
    !("intendedWords" in (parsedClue?.clue ?? {})),
  parsedClue
);
check("spymaster response retains interaction", parsedClue?.interaction?.utterance === "Look upward.", parsedClue);

check(
  "spymaster response rejects board-word clue",
  parseCodenamesSpymasterResponse(state, '{"clue":"moon","count":1}') === null
);
const boardWordFailure = parseCodenamesSpymasterResponseResult(
  state,
  '{"clue":"moon","count":1}'
);
check(
  "spymaster board-word clue is an illegal response",
  boardWordFailure.ok === false && boardWordFailure.type === "illegal",
  boardWordFailure
);
check(
  "spymaster response rejects multi-word clue",
  parseCodenamesSpymasterResponse(state, '{"clue":"outer space","count":1}') === null
);
check(
  "spymaster response accepts zero-count clue",
  parseCodenamesSpymasterResponse(state, '{"clue":"avoid","count":0}')?.clue.count === 0
);

const clueState = submitCodenamesClue(
  state,
  { word: "space", count: 2 },
  1_000
);
const parsedGuess = parseCodenamesGuesserResponse(
  clueState,
  `{"guesses":["MOON","STAR"],"rationale":"Both are space words.","gesture":"confident"}`
);

check(
  "guesser response maps words to card ids",
  parsedGuess?.cardIds.join(",") === "red-1,red-2",
  parsedGuess
);
check("guesser response retains rationale", parsedGuess?.rationale === "Both are space words.", parsedGuess);
check("guesser response retains gesture", parsedGuess?.interaction?.gesture === "confident", parsedGuess);

const revealedState = submitCodenamesGuess(clueState, "red-1", 2_000);
check(
  "guesser response rejects revealed words",
  parseCodenamesGuesserResponse(revealedState, '{"guesses":["MOON"]}') === null
);
check(
  "guesser response rejects duplicate guesses",
  parseCodenamesGuesserResponse(clueState, '{"guesses":["MOON","MOON"]}') === null
);
const duplicateGuessFailure = parseCodenamesGuesserResponseResult(
  clueState,
  '{"guesses":["MOON","MOON"]}'
);
check(
  "duplicate guesses are illegal responses",
  duplicateGuessFailure.ok === false && duplicateGuessFailure.type === "illegal",
  duplicateGuessFailure
);
check(
  "guesser response rejects guesses beyond remaining allowance",
  parseCodenamesGuesserResponse(
    clueState,
    '{"guesses":["MOON","STAR","RIVER","SHIP"]}'
  ) === null
);
check(
  "guesser response rejects card ids to avoid leaking role-bearing ids",
  parseCodenamesGuesserResponse(clueState, '{"guesses":["red-1"]}') === null
);

const spymasterPrompt = buildCodenamesSpymasterPrompt(state, "red");
check(
  "spymaster prompt includes hidden roles",
  spymasterPrompt.user.includes("MOON - RED") &&
    spymasterPrompt.user.includes("BOMB - ASSASSIN"),
  spymasterPrompt.user
);
const guesserPrompt = buildCodenamesGuesserPrompt(clueState, "red");
check(
  "guesser prompt hides hidden roles",
  guesserPrompt.user.includes("MOON") &&
    !guesserPrompt.user.includes("MOON - RED") &&
    !guesserPrompt.user.includes("ASSASSIN"),
  guesserPrompt.user
);

check(
  "Codenames AI uses enough output budget for structured JSON",
  CODENAMES_AI_MAX_TOKENS >= 4096,
  CODENAMES_AI_MAX_TOKENS
);
check(
  "spymaster structured output requires clue and count",
  JSON.stringify(buildCodenamesSpymasterResponseFormat().schema.required) ===
    JSON.stringify(["clue", "count"]) &&
    JSON.stringify(buildCodenamesSpymasterResponseFormat().schema).includes('"integer"'),
  buildCodenamesSpymasterResponseFormat()
);
check(
  "guesser structured output requires guesses",
  JSON.stringify(buildCodenamesGuessResponseFormat().schema.required) ===
    JSON.stringify(["guesses"]),
  buildCodenamesGuessResponseFormat()
);

if (failures === 0) {
  console.log("PASS");
} else {
  console.log(`FAIL ${failures} check(s) failed`);
}

process.exit(failures === 0 ? 0 : 1);
