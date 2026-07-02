import {
  createCodenamesStateFromBoard,
  submitCodenamesClue,
  submitCodenamesGuess,
} from "@/lib/games/codenames/engine";
import type {
  CodenamesCard,
  CodenamesCardRole,
  CodenamesGameState,
  CodenamesTeam,
} from "@/lib/games/codenames/types";
import type { CodenamesGameIqAction, CodenamesGameIqScenario } from "./types";

// -------------------------------------------------------------------------
// Codenames GameIQ pack — re-authored 2026-07-02.
//
// Correctness here requires Codenames skill, not bare legality:
//  - GUESS scenarios (category "target-priority") are scored by EXACT cardId
//    match against expectedActions (validation.ts actionsEqual for guesses),
//    so guessing the wrong (or a board-blind first) card scores zero.
//  - CLUE scenarios with binding constraints (category "hidden-cooperation")
//    are scored by EXACT word+count match against a small allowlist of
//    defensible clues (validation.ts actionsEqual for clues); a legal but
//    board-blind constant clue (e.g. "ORBIT 1") is never in the allowlist and
//    scores zero, and the count is pinned to the number of linked team words.
//  - No "clue-selection" scenarios are kept: that category is scored on
//    legality alone (validation.ts actionMatchesExpected short-circuit), so a
//    legal board-blind constant clue would pass it. Every scenario here is
//    skill-binding, so a constant baseline scores zero across the whole pack.
//
// IMPORTANT — hidden-information redaction: certified-runner.ts
// gameIqModelStateView serializes scenario.initialState VERBATIM for codenames,
// so any scenario shown to a guesser must NOT carry unrevealed card roles or the
// answer key leaks. guessScenarioState() below rebuilds the state with every
// still-hidden card relabelled "neutral" (revealed cards keep their true role,
// which is public knowledge once flipped). Legality (submitCodenamesGuess only
// checks revealed/phase/guesses) and scoring (exact cardId) are role-blind, so
// redaction does not change the correct answer.
// -------------------------------------------------------------------------

function card(
  id: number,
  word: string,
  role: CodenamesCardRole
): CodenamesCard {
  return { id: `card-${id}`, word, role, revealed: false };
}

// Filler words used to pad boards up to 25 cards. None of these appear as a
// pinned/meaningful word in any scenario, and they carry no strong association
// with the clue families, so they never become competing answers.
// Fillers must stay OUTSIDE every clue family used by the scenarios below
// (animal, citrus/fruit, ocean, cold, twins/fortification, metal, instrument):
// a filler that fits an active clue family becomes a competing legal guess and
// un-forces the expected answer (review 2026-07-02 caught ZEBRA vs "ANIMAL 3"
// and YOGURT vs "COLD 1" doing exactly that).
const FILLER_WORDS = [
  "WALLET", "KETTLE", "LADDER", "PENCIL", "BUTTON",
  "CARPET", "SADDLE", "TUNNEL", "PEBBLE", "SOCKET",
  "HAMMER", "NAPKIN", "PLANET", "PUZZLE", "RIBBON",
  "SHOVEL", "TROPHY", "WAGON", "VELVET", "ANVIL",
  "CACTUS", "DENIM", "FOSSIL", "GRAVEL", "HELMET",
] as const;

// Required role distribution for a 25-card board (9/8/7/1 for the starting
// team). See engine.roleCounts.
function requiredCounts(startingTeam: CodenamesTeam): Record<CodenamesCardRole, number> {
  const other: CodenamesTeam = startingTeam === "red" ? "blue" : "red";
  return {
    [startingTeam]: 9,
    [other]: 8,
    neutral: 7,
    assassin: 1,
  } as Record<CodenamesCardRole, number>;
}

// Build a full, engine-valid 25-card board from a list of MEANINGFUL cards
// (the words the scenario actually reasons about, in the order that fixes their
// card ids). Remaining slots are auto-filled with neutral/inert filler words in
// whatever roles are still needed, so role counts are always exactly 9/8/7/1
// and no hand-counting is required. Pinned cards keep the leading ids
// (card-1, card-2, ...); fillers take the trailing ids.
function makeBoard(
  startingTeam: CodenamesTeam,
  pinned: Array<[string, CodenamesCardRole]>
): CodenamesCard[] {
  const need = requiredCounts(startingTeam);
  for (const [, role] of pinned) {
    need[role] -= 1;
    if (need[role] < 0) {
      throw new Error(`Too many ${role} cards pinned for a codenames board.`);
    }
  }
  const cards: CodenamesCard[] = pinned.map(([word, role], index) =>
    card(index + 1, word, role)
  );
  let fillerIndex = 0;
  (Object.entries(need) as Array<[CodenamesCardRole, number]>).forEach(
    ([role, count]) => {
      for (let i = 0; i < count; i++) {
        const word = FILLER_WORDS[fillerIndex++];
        if (!word) throw new Error("Ran out of filler words for a codenames board.");
        cards.push(card(cards.length + 1, word, role));
      }
    }
  );
  return cards;
}

// Replay clues/guesses onto a fresh board to reach a mid-game state.
type Step =
  | { kind: "clue"; word: string; count: number }
  | { kind: "guess"; cardId: string };

function play(
  cards: CodenamesCard[],
  startingTeam: CodenamesTeam,
  steps: Step[]
): CodenamesGameState {
  let state = createCodenamesStateFromBoard(cards, startingTeam);
  let clock = 1;
  for (const step of steps) {
    if (step.kind === "clue") {
      state = submitCodenamesClue(
        state,
        { word: step.word, count: step.count },
        clock++
      );
    } else {
      state = submitCodenamesGuess(state, step.cardId, clock++);
    }
  }
  return state;
}

// Redact still-hidden roles so a guesser view never leaks the answer key.
// Revealed cards keep their real role (public); everything hidden becomes
// "neutral" for the model's eyes only. Used for guess-phase scenarios, whose
// initialState is serialized verbatim to the model.
function redactHiddenRoles(state: CodenamesGameState): CodenamesGameState {
  return {
    ...state,
    cards: state.cards.map((c) => ({
      ...c,
      role: c.revealed ? c.role : "neutral",
    })),
  };
}

function guess(
  cardId: string,
  label: string,
  note?: string,
  weight = 1
): { action: CodenamesGameIqAction; label: string; weight: number; note?: string } {
  return { action: { type: "guess", cardId }, label, weight, note };
}

// A small allowlist of defensible clue words, all sharing one pinned count.
function clueSet(
  words: string[],
  count: number,
  note?: string
): Array<{
  action: CodenamesGameIqAction;
  label: string;
  weight: number;
  note?: string;
}> {
  return words.map((word) => ({
    action: { type: "clue", clue: { word, count } } as CodenamesGameIqAction,
    label: `${word} ${count}`,
    weight: 1,
    note,
  }));
}

const CLUE_MAX_MS = 15_000;
const GUESS_MAX_MS = 12_000;

// =========================================================================
// GUESS scenarios (category "target-priority", exact cardId scoring).
// Each board is hand-built so exactly one hidden card is the forced guess for
// the active clue. Roles are redacted in the shown state.
// =========================================================================

// Only the words a scenario actually reasons about are pinned; makeBoard fills
// the remaining 25 slots with inert filler words so role counts are always
// valid. Filler words carry no association with any clue family used below,
// so they never become competing answers. Guessed-then-revealed cards are
// pinned "red" (own) so replayed guesses keep the red turn alive.
//
// Each guess board leads with INERT red distractors (CANDLE / WINDOW / BASKET
// / JACKET / MIRROR / GARDEN / PICKLE / SADDLE...) that carry no clue-family
// association, and the target card id is deliberately SPREAD across the pack
// (card-2..card-6, never card-1) so NO single constant card id is the correct
// answer on more than two scenarios — a board-blind "always guess card-N"
// baseline scores at most 0.2 and card-1 scores zero.

// --- G1: unambiguous association. Clue CITRUS 1; LEMON is the only citrus
// word. Correct guess = LEMON (card-2).
const g1Cards = makeBoard("red", [
  ["CANDLE", "red"], // card-1 inert distractor
  ["LEMON", "red"], // card-2 target
]);
const g1State = redactHiddenRoles(
  play(g1Cards, "red", [{ kind: "clue", word: "CITRUS", count: 1 }])
);

// --- G2: process of elimination. Clue OCEAN 2 -> WHALE + SHARK. WHALE
// (card-4) already revealed (own), so SHARK (card-3) is the only ocean word
// left. Forced guess = card-3.
const g2Cards = makeBoard("red", [
  ["WINDOW", "red"], // card-1 inert distractor
  ["JACKET", "red"], // card-2 inert distractor
  ["SHARK", "red"], // card-3 target
  ["WHALE", "red"], // card-4 already guessed
]);
const g2State = redactHiddenRoles(
  play(g2Cards, "red", [
    { kind: "clue", word: "OCEAN", count: 2 },
    { kind: "guess", cardId: "card-4" },
  ])
);

// --- G3: count-driven second guess. Clue FRUIT 2 -> APPLE + LEMON. APPLE
// (card-5) already revealed; one guess remains, forced onto LEMON (card-4).
const g3Cards = makeBoard("red", [
  ["BASKET", "red"], // card-1 inert distractor
  ["MIRROR", "red"], // card-2 inert distractor
  ["GARDEN", "red"], // card-3 inert distractor
  ["LEMON", "red"], // card-4 target
  ["APPLE", "red"], // card-5 already guessed
]);
const g3State = redactHiddenRoles(
  play(g3Cards, "red", [
    { kind: "clue", word: "FRUIT", count: 2 },
    { kind: "guess", cardId: "card-5" },
  ])
);

// --- G4: two equally-forced guesses. Clue TWINS 2 -> CASTLE (card-2) and
// TOWER (card-3), both fortifications; neither revealed, so guessing either
// is equally correct (alternatives).
const g4Cards = makeBoard("red", [
  ["CANDLE", "red"], // card-1 inert distractor
  ["CASTLE", "red"], // card-2 target
  ["TOWER", "red"], // card-3 target
]);
const g4State = redactHiddenRoles(
  play(g4Cards, "red", [{ kind: "clue", word: "TWINS", count: 2 }])
);

// --- G5: single fitting word. Clue COLD 1 -> SNOW (card-5); no other board
// word is a cold thing. Forced guess = card-5.
const g5Cards = makeBoard("red", [
  ["BASKET", "red"], // card-1 inert distractor
  ["MIRROR", "red"], // card-2 inert distractor
  ["GARDEN", "red"], // card-3 inert distractor
  ["JACKET", "red"], // card-4 inert distractor
  ["SNOW", "red"], // card-5 target
]);
const g5State = redactHiddenRoles(
  play(g5Cards, "red", [{ kind: "clue", word: "COLD", count: 1 }])
);

// --- G6: elimination toward the last family member. Clue ANIMAL 3 -> TIGER
// (card-4), MOUSE (card-5), EAGLE (card-6). TIGER and MOUSE already revealed
// (own), so the last forced guess is EAGLE (card-6).
const g6Cards = makeBoard("red", [
  ["WINDOW", "red"], // card-1 inert distractor
  ["PICKLE", "red"], // card-2 inert distractor
  ["MIRROR", "red"], // card-3 inert distractor
  ["TIGER", "red"], // card-4 already guessed
  ["MOUSE", "red"], // card-5 already guessed
  ["EAGLE", "red"], // card-6 target
]);
const g6State = redactHiddenRoles(
  play(g6Cards, "red", [
    { kind: "clue", word: "ANIMAL", count: 3 },
    { kind: "guess", cardId: "card-4" },
    { kind: "guess", cardId: "card-5" },
  ])
);

// =========================================================================
// CLUE scenarios with binding constraints (category "hidden-cooperation",
// exact word+count scoring against a small allowlist).
// =========================================================================

// Clue-scenario boards pin only the linked team words plus any board-specific
// trap word (an on-board tempting clue, or the assassin the clue must avoid).
// Filler fills the rest; no filler word belongs to any clue family below.

// --- C1: the tempting clue word is ON the board (illegal). APPLE + PEAR are
// the two red fruits; the obvious "TREE" is itself a board word (neutral) and
// thus an illegal clue. Defensible clue = fruit family, count pinned to 2.
const c1Cards = makeBoard("red", [
  ["APPLE", "red"],
  ["PEAR", "red"],
  ["TREE", "neutral"], // tempting clue word, illegal because on board
]);
const c1State = createCodenamesStateFromBoard(c1Cards, "red");

// --- C2: count must match the linked family size. GOLD + SILVER + COPPER are
// the three red metals; clue = metal family, count pinned to 3.
const c2Cards = makeBoard("red", [
  ["GOLD", "red"],
  ["SILVER", "red"],
  ["COPPER", "red"],
]);
const c2State = createCodenamesStateFromBoard(c2Cards, "red");

// --- C3: avoid the assassin-adjacent trap. PIANO + FLUTE are the two red
// instruments; a broad "MUSIC" clue drags the guesser toward DRUM, the
// ASSASSIN. Defensible clue = a narrow instrument family excluding percussion,
// count pinned to 2.
const c3Cards = makeBoard("red", [
  ["PIANO", "red"],
  ["FLUTE", "red"],
  ["DRUM", "assassin"], // MUSIC would drag the guesser here
]);
const c3State = createCodenamesStateFromBoard(c3Cards, "red");

// --- C4: tight count of one. WHALE is the only red sea creature; nothing else
// fits, so the count is pinned to 1 (count>1 over-promises).
const c4Cards = makeBoard("red", [["WHALE", "red"]]);
const c4State = createCodenamesStateFromBoard(c4Cards, "red");

export const CODENAMES_GAMEIQ_SCENARIOS: CodenamesGameIqScenario[] = [
  // ---- CLUE scenarios with binding constraints ----
  // Listed first so the first codenames scenario is a clue-phase state (the
  // shared placeholder-word guard submits a clue action against it).
  {
    id: "gameiq-v0.1-codenames-clue-board-word-illegal",
    gameId: "codenames",
    title: "Codenames: avoid the on-board clue word",
    category: "hidden-cooperation",
    difficulty: "hard",
    version: "0.1.0",
    prompt:
      "You are the red spymaster. Give a one-word clue and a count that links exactly your team's two fruit words for your operative, without using any word printed on the board.",
    initialState: c1State,
    expectedActions: clueSet(
      ["FRUIT", "FRUITS", "ORCHARD", "PRODUCE", "GROCERY"],
      2,
      "APPLE + PEAR are the two red fruits; TREE is on the board (illegal). Count pinned to 2."
    ),
    tags: ["codenames", "clue", "legality", "binding"],
    maxResponseMs: CLUE_MAX_MS,
  },
  {
    id: "gameiq-v0.1-codenames-clue-count-three-metals",
    gameId: "codenames",
    title: "Codenames: count matches the linked family",
    category: "hidden-cooperation",
    difficulty: "hard",
    version: "0.1.0",
    prompt:
      "You are the red spymaster. Give a one-word clue and a count that links exactly your team's three metal words for your operative.",
    initialState: c2State,
    expectedActions: clueSet(
      ["METAL", "METALS", "MINE", "ELEMENT", "ELEMENTS", "SMELT"],
      3,
      "GOLD + SILVER + COPPER are the three red metals; count pinned to 3."
    ),
    tags: ["codenames", "clue", "count", "binding"],
    maxResponseMs: CLUE_MAX_MS,
  },
  {
    id: "gameiq-v0.1-codenames-clue-avoid-assassin",
    gameId: "codenames",
    title: "Codenames: steer clear of the assassin",
    category: "hidden-cooperation",
    difficulty: "hard",
    version: "0.1.0",
    prompt:
      "You are the red spymaster. Give a one-word clue and a count that links exactly your team's two instrument words for your operative, choosing a family narrow enough to exclude the percussion word on the board.",
    initialState: c3State,
    expectedActions: clueSet(
      // Only narrow, drum-free links: broad ensemble words (MUSIC, ORCHESTRA,
      // SYMPHONY) contain percussion and drag the guesser toward the assassin,
      // and WOODWIND excludes the piano. KEYS fits both instruments (piano
      // keys, flute keys); MELODY excludes rhythm instruments; CONCERTO,
      // SONATA, and RECITAL are canonical piano/flute forms with no drum
      // repertoire.
      ["KEYS", "MELODY", "CONCERTO", "SONATA", "RECITAL"],
      2,
      "PIANO + FLUTE are the two red instruments; DRUM is the assassin, so broad ensemble clues are traps. Count pinned to 2."
    ),
    tags: ["codenames", "clue", "assassin", "binding"],
    maxResponseMs: CLUE_MAX_MS,
  },
  {
    id: "gameiq-v0.1-codenames-clue-tight-count-one",
    gameId: "codenames",
    title: "Codenames: pin the count to one",
    category: "hidden-cooperation",
    difficulty: "medium",
    version: "0.1.0",
    prompt:
      "You are the red spymaster. Give a one-word clue and a count that links exactly your team's single sea-creature word for your operative.",
    initialState: c4State,
    expectedActions: clueSet(
      ["OCEAN", "SEA", "MAMMAL", "MARINE", "CETACEAN", "AQUATIC"],
      1,
      "WHALE is the only red sea creature; nothing else fits, so the count is pinned to 1."
    ),
    tags: ["codenames", "clue", "count", "binding"],
    maxResponseMs: CLUE_MAX_MS,
  },

  // ---- GUESS scenarios ----
  {
    id: "gameiq-v0.1-codenames-guess-unambiguous",
    gameId: "codenames",
    title: "Codenames: guess the single clued word",
    category: "target-priority",
    difficulty: "easy",
    version: "0.1.0",
    prompt:
      "You are the red operative. Read the active clue and the board, then return the guess (the card id) that the clue points to.",
    initialState: g1State,
    expectedActions: [
      guess(
        "card-2",
        "LEMON",
        "CITRUS 1 uniquely points to LEMON; no other board word is a citrus fruit."
      ),
    ],
    tags: ["codenames", "guess", "association"],
    maxResponseMs: GUESS_MAX_MS,
  },
  {
    id: "gameiq-v0.1-codenames-guess-elimination",
    gameId: "codenames",
    title: "Codenames: guess by elimination",
    category: "target-priority",
    difficulty: "medium",
    version: "0.1.0",
    prompt:
      "You are the red operative mid-turn. One card for the active clue has already been revealed. Return the card id of the remaining word the clue points to.",
    initialState: g2State,
    expectedActions: [
      guess(
        "card-3",
        "SHARK",
        "OCEAN 2 pointed to WHALE + SHARK; WHALE is already revealed, so SHARK is the only ocean word left."
      ),
    ],
    tags: ["codenames", "guess", "elimination"],
    maxResponseMs: GUESS_MAX_MS,
  },
  {
    id: "gameiq-v0.1-codenames-guess-count-second",
    gameId: "codenames",
    title: "Codenames: use the remaining count for the second word",
    category: "target-priority",
    difficulty: "medium",
    version: "0.1.0",
    prompt:
      "You are the red operative mid-turn with a guess remaining for the active clue. One clued word is already revealed. Return the card id of the other word the clue points to.",
    initialState: g3State,
    expectedActions: [
      guess(
        "card-4",
        "LEMON",
        "FRUIT 2 covered APPLE + LEMON; APPLE is revealed, so the remaining guess is forced onto LEMON."
      ),
    ],
    tags: ["codenames", "guess", "count"],
    maxResponseMs: GUESS_MAX_MS,
  },
  {
    id: "gameiq-v0.1-codenames-guess-either-twin",
    gameId: "codenames",
    title: "Codenames: two equally-forced guesses",
    category: "target-priority",
    difficulty: "medium",
    version: "0.1.0",
    prompt:
      "You are the red operative. The active clue points to two board words and neither is revealed yet. Return the card id of either word the clue points to.",
    initialState: g4State,
    expectedActions: [
      guess(
        "card-2",
        "CASTLE",
        "TWINS 2 links CASTLE and TOWER (fortifications); guessing either first is equally correct."
      ),
      guess(
        "card-3",
        "TOWER",
        "TWINS 2 links CASTLE and TOWER (fortifications); guessing either first is equally correct."
      ),
    ],
    tags: ["codenames", "guess", "either"],
    maxResponseMs: GUESS_MAX_MS,
  },
  {
    id: "gameiq-v0.1-codenames-guess-cold",
    gameId: "codenames",
    title: "Codenames: single fitting word",
    category: "target-priority",
    difficulty: "easy",
    version: "0.1.0",
    prompt:
      "You are the red operative. Return the card id of the one board word the active clue points to.",
    initialState: g5State,
    expectedActions: [
      guess(
        "card-5",
        "SNOW",
        "COLD 1 fits only SNOW; no other board word is a cold thing."
      ),
    ],
    tags: ["codenames", "guess", "association"],
    maxResponseMs: GUESS_MAX_MS,
  },
  {
    id: "gameiq-v0.1-codenames-guess-last-animal",
    gameId: "codenames",
    title: "Codenames: guess the last member of the family",
    category: "target-priority",
    difficulty: "hard",
    version: "0.1.0",
    prompt:
      "You are the red operative mid-turn. Two of the clued words are already revealed. Return the card id of the last word the clue points to.",
    initialState: g6State,
    expectedActions: [
      guess(
        "card-6",
        "EAGLE",
        "ANIMAL 3 covered TIGER, MOUSE, EAGLE; TIGER and MOUSE are revealed, so EAGLE is the last one."
      ),
    ],
    tags: ["codenames", "guess", "elimination"],
    maxResponseMs: GUESS_MAX_MS,
  },
];
