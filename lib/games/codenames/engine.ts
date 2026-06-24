import type {
  CodenamesCard,
  CodenamesCardRole,
  CodenamesClue,
  CodenamesClueValidation,
  CodenamesGameState,
  CodenamesGuessResult,
  CodenamesMoveRecord,
  CodenamesPublicCard,
  CodenamesStatus,
  CodenamesTeam,
} from "./types";

export const CODENAMES_GRID_SIZE = 5;
export const CODENAMES_CARD_COUNT = CODENAMES_GRID_SIZE * CODENAMES_GRID_SIZE;

const DEFAULT_WORDS = [
  "MOON",
  "STAR",
  "RIVER",
  "BANK",
  "PLANE",
  "CHAIR",
  "COTTON",
  "PIANO",
  "BOMB",
  "SHIP",
  "CLOUD",
  "FOREST",
  "HORSE",
  "GOLD",
  "MOUSE",
  "CROWN",
  "NURSE",
  "MOUNT",
  "BREAD",
  "WALL",
  "ROBOT",
  "LAMP",
  "BRUSH",
  "CLOCK",
  "GLASS",
  "MERCURY",
  "PAPER",
  "FISH",
  "DRAGON",
  "FIELD",
  "MINT",
  "BRIDGE",
  "LION",
  "ENGINE",
  "SNOW",
  "PILOT",
  "CASTLE",
  "ROOT",
  "CIRCLE",
  "WAVE",
  "SPIDER",
  "MARBLE",
  "QUEEN",
  "BOTTLE",
  "TOWER",
  "SPRING",
  "MATCH",
  "BARK",
  "COMET",
  "TEMPLE",
];

function opponentOf(team: CodenamesTeam): CodenamesTeam {
  return team === "red" ? "blue" : "red";
}

function roleCounts(startingTeam: CodenamesTeam): Record<CodenamesCardRole, number> {
  const otherTeam = opponentOf(startingTeam);
  return {
    [startingTeam]: 9,
    [otherTeam]: 8,
    neutral: 7,
    assassin: 1,
  } as Record<CodenamesCardRole, number>;
}

function seededRandom(seed: string): () => number {
  let hash = 1779033703 ^ seed.length;
  for (let index = 0; index < seed.length; index++) {
    hash = Math.imul(hash ^ seed.charCodeAt(index), 3432918353);
    hash = (hash << 13) | (hash >>> 19);
  }

  return () => {
    hash = Math.imul(hash ^ (hash >>> 16), 2246822507);
    hash = Math.imul(hash ^ (hash >>> 13), 3266489909);
    hash ^= hash >>> 16;
    return (hash >>> 0) / 4294967296;
  };
}

function shuffle<T>(items: T[], rng: () => number): T[] {
  const copy = [...items];
  for (let index = copy.length - 1; index > 0; index--) {
    const swapIndex = Math.floor(rng() * (index + 1));
    [copy[index], copy[swapIndex]] = [copy[swapIndex], copy[index]];
  }
  return copy;
}

function positionForIndex(index: number): string {
  const row = Math.floor(index / CODENAMES_GRID_SIZE);
  const column = index % CODENAMES_GRID_SIZE;
  return `${String.fromCharCode(65 + row)}${column + 1}`;
}

function normalizeWord(value: string): string {
  return value.trim().toUpperCase();
}

function cloneCard(card: CodenamesCard, index: number): CodenamesCard {
  return {
    ...card,
    position: card.position ?? positionForIndex(index),
  };
}

function cloneState(state: CodenamesGameState): CodenamesGameState {
  return {
    ...state,
    cards: state.cards.map(cloneCard),
    activeClue: state.activeClue ? { ...state.activeClue } : null,
    moveHistory: state.moveHistory.map((move) => ({ ...move })),
  };
}

export function createInitialCodenamesState({
  seed = "codenames",
  startingTeam = "red",
  words = DEFAULT_WORDS,
}: {
  seed?: string;
  startingTeam?: CodenamesTeam;
  words?: string[];
} = {}): CodenamesGameState {
  if (words.length < CODENAMES_CARD_COUNT) {
    throw new Error("Codenames needs at least 25 words.");
  }

  const rng = seededRandom(seed);
  const selectedWords = shuffle(words.map(normalizeWord), rng).slice(
    0,
    CODENAMES_CARD_COUNT
  );
  const counts = roleCounts(startingTeam);
  const roles = shuffle(
    (Object.entries(counts) as Array<[CodenamesCardRole, number]>).flatMap(
      ([role, count]) => Array.from({ length: count }, () => role)
    ),
    rng
  );
  const cards = selectedWords.map<CodenamesCard>((word, index) => ({
    id: `card-${index + 1}`,
    position: positionForIndex(index),
    word,
    role: roles[index],
    revealed: false,
  }));

  return createCodenamesStateFromBoard(cards, startingTeam);
}

export function createCodenamesStateFromBoard(
  cards: CodenamesCard[],
  startingTeam: CodenamesTeam
): CodenamesGameState {
  validateBoard(cards, startingTeam);
  return {
    cards: cards.map(cloneCard),
    startingTeam,
    turnTeam: startingTeam,
    phase: "clue",
    status: "playing",
    winner: null,
    activeClue: null,
    guessesRemaining: 0,
    guessesMadeForActiveClue: 0,
    moveHistory: [],
  };
}

function validateBoard(cards: CodenamesCard[], startingTeam: CodenamesTeam): void {
  if (cards.length !== CODENAMES_CARD_COUNT) {
    throw new Error(`Expected ${CODENAMES_CARD_COUNT} Codenames cards.`);
  }
  const words = new Set<string>();
  const counts: Partial<Record<CodenamesCardRole, number>> = {};
  for (const card of cards) {
    const word = normalizeWord(card.word);
    if (!word) throw new Error("Codenames cards need words.");
    if (words.has(word)) throw new Error(`Duplicate Codenames word: ${word}.`);
    words.add(word);
    counts[card.role] = (counts[card.role] ?? 0) + 1;
  }
  const expected = roleCounts(startingTeam);
  for (const [role, count] of Object.entries(expected) as Array<
    [CodenamesCardRole, number]
  >) {
    if (counts[role] !== count) {
      throw new Error(`Expected ${count} ${role} cards, received ${counts[role] ?? 0}.`);
    }
  }
}

export function getCodenamesPublicBoard(
  state: CodenamesGameState
): CodenamesPublicCard[] {
  return state.cards.map((card, index) => ({
    id: card.id,
    position: card.position ?? positionForIndex(index),
    word: card.word,
    role: card.revealed ? card.role : null,
    revealed: card.revealed,
  }));
}

export function getCodenamesSpymasterBoard(
  state: CodenamesGameState
): CodenamesPublicCard[] {
  return state.cards.map((card, index) => ({
    id: card.id,
    position: card.position ?? positionForIndex(index),
    word: card.word,
    role: card.role,
    revealed: card.revealed,
  }));
}

export function getRemainingCodenamesCards(
  state: CodenamesGameState,
  team: CodenamesTeam
): number {
  return state.cards.filter((card) => card.role === team && !card.revealed).length;
}

export function validateCodenamesClue(
  state: CodenamesGameState,
  clue: Pick<CodenamesClue, "word" | "count"> & Partial<CodenamesClue>
): CodenamesClueValidation {
  if (state.status !== "playing" || state.phase !== "clue") {
    return { ok: false, error: "Codenames clue can only be submitted in clue phase." };
  }

  const word = clue.word.trim();
  if (!word) return { ok: false, error: "Codenames clue needs a word." };
  if (/\s/.test(word)) {
    return { ok: false, error: "Codenames clue must be one word." };
  }
  if (!Number.isInteger(clue.count) || clue.count < 0 || clue.count > 9) {
    return { ok: false, error: "Codenames clue count must be between 0 and 9." };
  }

  const normalizedClue = normalizeWord(word);
  const boardWords = new Set(
    state.cards
      .filter((card) => !card.revealed)
      .map((card) => normalizeWord(card.word))
  );
  if (boardWords.has(normalizedClue)) {
    return { ok: false, error: "Codenames clue cannot be a board word." };
  }
  if (clue.count > getRemainingCodenamesCards(state, state.turnTeam)) {
    return {
      ok: false,
      error: "Codenames clue count cannot exceed remaining team words.",
    };
  }

  return {
    ok: true,
    clue: {
      word,
      count: clue.count,
    },
  };
}

export function submitCodenamesClue(
  state: CodenamesGameState,
  clue: CodenamesClue,
  timestamp: number
): CodenamesGameState {
  const validation = validateCodenamesClue(state, clue);
  if (!validation.ok) throw new Error(validation.error);

  const clueMove: CodenamesMoveRecord = {
    type: "clue",
    team: state.turnTeam,
    clue: validation.clue,
    timestamp,
  };

  return {
    ...cloneState(state),
    phase: "guess",
    activeClue: validation.clue,
    guessesRemaining:
      validation.clue.count === 0
        ? state.cards.filter((card) => !card.revealed).length
        : validation.clue.count + 1,
    guessesMadeForActiveClue: 0,
    moveHistory: [...state.moveHistory, clueMove],
  };
}

export function submitCodenamesGuess(
  state: CodenamesGameState,
  cardId: string,
  timestamp: number
): CodenamesGameState {
  if (state.status !== "playing" || state.phase !== "guess") {
    throw new Error("Codenames guesses can only be submitted in guess phase.");
  }
  if (state.guessesRemaining <= 0) {
    throw new Error("No Codenames guesses remain for this clue.");
  }

  const nextState = cloneState(state);
  const card = nextState.cards.find((candidate) => candidate.id === cardId);
  if (!card) throw new Error(`Unknown Codenames card: ${cardId}.`);
  if (card.revealed) throw new Error(`${card.word} has already been revealed.`);

  card.revealed = true;
  const result = guessResultForRole(state.turnTeam, card.role);
  const move: CodenamesMoveRecord = {
    type: "guess",
    team: state.turnTeam,
    cardId: card.id,
    word: card.word,
    role: card.role,
    result,
    timestamp,
  };
  nextState.moveHistory = [...state.moveHistory, move];
  nextState.guessesRemaining = Math.max(0, state.guessesRemaining - 1);
  nextState.guessesMadeForActiveClue = state.guessesMadeForActiveClue + 1;

  if (card.role === "assassin") {
    return finishGame(nextState, opponentOf(state.turnTeam));
  }

  const ownRemaining = getRemainingCodenamesCards(nextState, state.turnTeam);
  if (ownRemaining === 0) {
    return finishGame(nextState, state.turnTeam);
  }
  const opponent = opponentOf(state.turnTeam);
  if (getRemainingCodenamesCards(nextState, opponent) === 0) {
    return finishGame(nextState, opponent);
  }

  if (result !== "own" || nextState.guessesRemaining === 0) {
    return switchTurn(nextState, timestamp, false);
  }

  return nextState;
}

export function endCodenamesTurn(
  state: CodenamesGameState,
  timestamp: number
): CodenamesGameState {
  if (state.status !== "playing" || state.phase !== "guess") {
    throw new Error("Codenames turn can only end during guess phase.");
  }
  if (state.guessesMadeForActiveClue < 1) {
    throw new Error("At least one Codenames guess is required before ending turn.");
  }
  return switchTurn(cloneState(state), timestamp, true);
}

function switchTurn(
  state: CodenamesGameState,
  timestamp: number,
  recordMove: boolean
): CodenamesGameState {
  const move: CodenamesMoveRecord | null = recordMove
    ? { type: "end-turn", team: state.turnTeam, timestamp }
    : null;
  return {
    ...state,
    turnTeam: opponentOf(state.turnTeam),
    phase: "clue",
    activeClue: null,
    guessesRemaining: 0,
    guessesMadeForActiveClue: 0,
    moveHistory: move ? [...state.moveHistory, move] : state.moveHistory,
  };
}

function finishGame(
  state: CodenamesGameState,
  winner: CodenamesTeam
): CodenamesGameState {
  return {
    ...state,
    status: "win",
    winner,
    phase: "finished",
    activeClue: null,
    guessesRemaining: 0,
    guessesMadeForActiveClue: 0,
  };
}

function guessResultForRole(
  team: CodenamesTeam,
  role: CodenamesCardRole
): CodenamesGuessResult {
  if (role === "assassin") return "assassin";
  if (role === "neutral") return "neutral";
  return role === team ? "own" : "opponent";
}

export function setCodenamesPaused(
  state: CodenamesGameState,
  paused: boolean
): CodenamesGameState {
  if (paused && state.status === "playing") {
    return { ...cloneState(state), status: "paused" };
  }
  if (!paused && state.status === "paused") {
    return { ...cloneState(state), status: "playing" };
  }
  return cloneState(state);
}

export function isCodenamesActiveStatus(status: CodenamesStatus): boolean {
  return status === "playing" || status === "paused";
}
