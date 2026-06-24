import {
  createCodenamesStateFromBoard,
  createInitialCodenamesState,
  endCodenamesTurn,
  getCodenamesPublicBoard,
  getCodenamesSpymasterBoard,
  getRemainingCodenamesCards,
  submitCodenamesClue,
  submitCodenamesGuess,
  setCodenamesPaused,
  validateCodenamesClue,
} from "./engine";
import type { CodenamesCard } from "./types";

let failures = 0;

function check(name: string, ok: boolean, detail?: unknown): void {
  if (!ok) failures++;
  console.log(
    `${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` -> ${JSON.stringify(detail)}`}`
  );
}

function card(
  id: string,
  word: string,
  role: CodenamesCard["role"]
): CodenamesCard {
  return {
    id,
    word,
    role,
    revealed: false,
  };
}

function testBoard(): CodenamesCard[] {
  return [
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
  ];
}

const generated = createInitialCodenamesState({ seed: "rules-test" });
const generatedRoles = generated.cards.reduce<Record<string, number>>(
  (counts, card) => {
    counts[card.role] = (counts[card.role] ?? 0) + 1;
    return counts;
  },
  {}
);

check("generated board has 25 cards", generated.cards.length === 25, {
  length: generated.cards.length,
});
check(
  "generated board uses 9/8/7/1 role distribution for starting team",
  generatedRoles.red === 9 &&
    generatedRoles.blue === 8 &&
    generatedRoles.neutral === 7 &&
    generatedRoles.assassin === 1,
  generatedRoles
);
check(
  "generated cards have stable A1 style positions",
  generated.cards[0].position === "A1" && generated.cards[24].position === "E5",
  [generated.cards[0].position, generated.cards[24].position]
);

const initial = createCodenamesStateFromBoard(testBoard(), "red");

check("red starts in clue phase", initial.turnTeam === "red" && initial.phase === "clue", initial);
check(
  "public board hides roles for unrevealed cards",
  getCodenamesPublicBoard(initial).every((card) => card.role === null),
  getCodenamesPublicBoard(initial)[0]
);
check(
  "spymaster board exposes roles",
  getCodenamesSpymasterBoard(initial)[0].role === "red" &&
    getCodenamesSpymasterBoard(initial).find((card) => card.id === "assassin")
      ?.role === "assassin",
  getCodenamesSpymasterBoard(initial).slice(0, 3)
);
check(
  "remaining team cards are counted",
  getRemainingCodenamesCards(initial, "red") === 9 &&
    getRemainingCodenamesCards(initial, "blue") === 8,
  {
    red: getRemainingCodenamesCards(initial, "red"),
    blue: getRemainingCodenamesCards(initial, "blue"),
  }
);

check(
  "valid clue is accepted",
  validateCodenamesClue(initial, { word: "space", count: 2 }).ok,
  validateCodenamesClue(initial, { word: "space", count: 2 })
);
check(
  "clue cannot be a board word",
  !validateCodenamesClue(initial, { word: "moon", count: 1 }).ok,
  validateCodenamesClue(initial, { word: "moon", count: 1 })
);
check(
  "clue must be one word",
  !validateCodenamesClue(initial, { word: "outer space", count: 1 }).ok,
  validateCodenamesClue(initial, { word: "outer space", count: 1 })
);
check(
  "zero-count clue is accepted",
  validateCodenamesClue(initial, { word: "avoid", count: 0 }).ok,
  validateCodenamesClue(initial, { word: "avoid", count: 0 })
);

const clueState = submitCodenamesClue(
  initial,
  { word: "space", count: 2 },
  1_000
);
check(
  "submitting a clue moves to guess phase with count plus one guesses",
  clueState.phase === "guess" &&
    clueState.activeClue?.word === "space" &&
    clueState.guessesRemaining === 3,
  clueState
);
const zeroClueState = submitCodenamesClue(initial, { word: "avoid", count: 0 }, 1_500);
check(
  "zero-count clue allows unlimited guesses over unrevealed cards",
  zeroClueState.guessesRemaining === 25,
  zeroClueState.guessesRemaining
);

const firstGuess = submitCodenamesGuess(clueState, "red-1", 2_000);
check(
  "revealed board words can be used as later clues",
  validateCodenamesClue(
    { ...firstGuess, phase: "clue", activeClue: null, guessesRemaining: 0 },
    { word: "moon", count: 1 }
  ).ok,
  validateCodenamesClue(
    { ...firstGuess, phase: "clue", activeClue: null, guessesRemaining: 0 },
    { word: "moon", count: 1 }
  )
);
check(
  "own-team guess reveals card and keeps turn",
  firstGuess.cards.find((nextCard) => nextCard.id === "red-1")?.revealed ===
    true &&
    firstGuess.turnTeam === "red" &&
    firstGuess.phase === "guess" &&
    firstGuess.guessesRemaining === 2,
  firstGuess
);

const wrongGuess = submitCodenamesGuess(firstGuess, "blue-1", 3_000);
check(
  "opponent guess reveals card and changes team",
  wrongGuess.cards.find((nextCard) => nextCard.id === "blue-1")?.revealed ===
    true &&
    wrongGuess.turnTeam === "blue" &&
    wrongGuess.phase === "clue" &&
    wrongGuess.activeClue === null,
  wrongGuess
);

check(
  "operative cannot end turn before making a guess",
  (() => {
    try {
      endCodenamesTurn(clueState, 4_000);
      return false;
    } catch {
      return true;
    }
  })()
);
const endedTurn = endCodenamesTurn(firstGuess, 4_000);
check(
  "operative can end turn after at least one guess",
  endedTurn.turnTeam === "blue" && endedTurn.phase === "clue",
  endedTurn
);

const assassinState = submitCodenamesGuess(clueState, "assassin", 5_000);
check(
  "assassin gives victory to the other team",
  assassinState.status === "win" &&
    assassinState.winner === "blue" &&
    assassinState.phase === "finished",
  assassinState
);

let redWinState = clueState;
for (const id of [
  "red-1",
  "red-2",
  "red-3",
  "red-4",
  "red-5",
  "red-6",
  "red-7",
  "red-8",
  "red-9",
]) {
  redWinState = {
    ...redWinState,
    turnTeam: "red",
    phase: "guess",
    guessesRemaining: 9,
  };
  redWinState = submitCodenamesGuess(redWinState, id, 6_000);
}
check(
  "revealing all team cards wins",
  redWinState.status === "win" &&
    redWinState.winner === "red" &&
    redWinState.phase === "finished",
  redWinState
);

check(
  "guesser cannot select an already revealed card",
  (() => {
    try {
      submitCodenamesGuess(firstGuess, "red-1", 7_000);
      return false;
    } catch {
      return true;
    }
  })()
);

const pausedState = setCodenamesPaused(clueState, true);
check(
  "pause keeps active clue and turn state",
  pausedState.status === "paused" &&
    pausedState.turnTeam === "red" &&
    pausedState.phase === "guess" &&
    pausedState.activeClue?.word === "space",
  pausedState
);
check(
  "paused games reject guesses",
  (() => {
    try {
      submitCodenamesGuess(pausedState, "red-1", 8_000);
      return false;
    } catch {
      return true;
    }
  })()
);
const resumedState = setCodenamesPaused(pausedState, false);
check(
  "resume restores playing without losing clue state",
  resumedState.status === "playing" &&
    resumedState.phase === "guess" &&
    resumedState.turnTeam === "red" &&
    resumedState.activeClue?.word === "space",
  resumedState
);

if (failures === 0) {
  console.log("PASS");
} else {
  console.log(`FAIL ${failures} check(s) failed`);
}

process.exit(failures === 0 ? 0 : 1);
