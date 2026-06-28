import type {
  FireworksAction,
  FireworksCard,
  FireworksCardKnowledge,
  FireworksColor,
  FireworksEvent,
  FireworksGameState,
  FireworksPlayer,
  FireworksPlayerHand,
  FireworksRank,
  FireworksStackState,
} from "./types";

export const FIREWORKS_COLORS: FireworksColor[] = ["red", "blue", "green"];
export const FIREWORKS_RANKS: FireworksRank[] = [1, 2, 3, 4, 5];
export const FIREWORKS_MAX_SCORE = 15;

const RANK_COPY_COUNTS: Record<FireworksRank, number> = {
  1: 3,
  2: 2,
  3: 2,
  4: 2,
  5: 1,
};

export interface CreateFireworksGameInput {
  id?: string;
  seed?: string;
  players?: FireworksPlayer[];
  playerCount?: 2 | 3;
  handSize?: number;
  clueTokens?: number;
  maxClueTokens?: number;
  mistakeTokens?: number;
  maxMistakeTokens?: number;
  deck?: FireworksCard[];
}

export function createEmptyFireworksKnowledge(): FireworksCardKnowledge {
  return {
    notColors: [],
    notRanks: [],
    clueHistory: [],
  };
}

export function createFireworksGame(
  input: CreateFireworksGameInput = {}
): FireworksGameState {
  const seed = input.seed ?? "fireworks";
  const players = input.players ?? createDefaultPlayers(input.playerCount ?? 2);
  if (players.length < 2 || players.length > 3) {
    throw new Error("Fireworks supports 2 or 3 players.");
  }

  const handSize = input.handSize ?? 4;
  const deck = input.deck ? cloneCards(input.deck) : createFireworksDeck(seed);
  const hands: FireworksPlayerHand[] = players.map((player) => ({
    playerId: player.id,
    cards: [],
    knowledge: [],
  }));

  for (let cardIndex = 0; cardIndex < handSize; cardIndex++) {
    for (const hand of hands) {
      const card = deck.shift();
      if (!card) break;
      hand.cards.push(card);
      hand.knowledge.push(createEmptyFireworksKnowledge());
    }
  }

  const maxClueTokens = input.maxClueTokens ?? 6;
  const maxMistakeTokens = input.maxMistakeTokens ?? 3;
  return {
    id: input.id ?? `fireworks:${seed}`,
    seed,
    players: players.map((player) => ({ ...player })),
    hands,
    deck,
    stacks: { red: 0, blue: 0, green: 0 },
    discardPile: [],
    clueTokens: Math.min(input.clueTokens ?? maxClueTokens, maxClueTokens),
    maxClueTokens,
    mistakeTokens: Math.min(input.mistakeTokens ?? maxMistakeTokens, maxMistakeTokens),
    maxMistakeTokens,
    currentPlayerIndex: 0,
    turn: 0,
    status: "playing",
    events: [],
  };
}

export function createFireworksDeck(seed: string): FireworksCard[] {
  const cards: FireworksCard[] = [];
  for (const color of FIREWORKS_COLORS) {
    for (const rank of FIREWORKS_RANKS) {
      for (let copy = 0; copy < RANK_COPY_COUNTS[rank]; copy++) {
        cards.push({
          id: `${color}-${rank}-${copy + 1}`,
          color,
          rank,
        });
      }
    }
  }
  return shuffle(cards, seededRandom(seed));
}

export function getCurrentPlayer(state: FireworksGameState): FireworksPlayer {
  const player = state.players[state.currentPlayerIndex];
  if (!player) throw new Error("Fireworks current player is missing.");
  return player;
}

export function getVisibleStateForPlayer(
  state: FireworksGameState,
  playerId: string
): unknown {
  const hand = getHand(state, playerId);
  return {
    playerId,
    currentPlayerId: getCurrentPlayer(state).id,
    ownCardCount: hand.cards.length,
    ownKnowledge: cloneKnowledgeList(hand.knowledge),
    otherHands: state.hands
      .filter((candidate) => candidate.playerId !== playerId)
      .map((candidate) => ({
        playerId: candidate.playerId,
        cards: candidate.cards.map((card) => ({ ...card })),
      })),
    stacks: { ...state.stacks },
    discardPile: state.discardPile.map((item) => ({
      ...item,
      card: { ...item.card },
    })),
    clueTokens: state.clueTokens,
    mistakeTokens: state.mistakeTokens,
    turn: state.turn,
    deckCount: state.deck.length,
    legalActions: getLegalFireworksActions(state, playerId),
  };
}

export function getLegalFireworksActions(
  state: FireworksGameState,
  playerId: string
): FireworksAction[] {
  if (state.status !== "playing") return [];
  if (getCurrentPlayer(state).id !== playerId) return [];
  const hand = getHand(state, playerId);
  const actions: FireworksAction[] = [];

  for (let cardIndex = 0; cardIndex < hand.cards.length; cardIndex++) {
    actions.push({ action: "play", cardIndex });
    actions.push({ action: "discard", cardIndex });
  }

  if (state.clueTokens > 0) {
    for (const targetHand of state.hands) {
      if (targetHand.playerId === playerId) continue;
      for (const color of FIREWORKS_COLORS) {
        if (targetHand.cards.some((card) => card.color === color)) {
          actions.push({
            action: "clue_color",
            targetPlayerId: targetHand.playerId,
            color,
          });
        }
      }
      for (const rank of FIREWORKS_RANKS) {
        if (targetHand.cards.some((card) => card.rank === rank)) {
          actions.push({
            action: "clue_rank",
            targetPlayerId: targetHand.playerId,
            rank,
          });
        }
      }
    }
  }

  return actions;
}

export function applyFireworksAction(
  state: FireworksGameState,
  playerId: string,
  action: FireworksAction,
  options: { fallbackUsed?: boolean; legalOverride?: boolean } = {}
): FireworksGameState {
  const legal = options.legalOverride
    ? true
    : getLegalFireworksActions(state, playerId).some((candidate) =>
        fireworksActionsEqual(candidate, action)
      );
  if (!legal) {
    throw new Error(`Illegal Fireworks action: ${JSON.stringify(action)}`);
  }

  const next = cloneState(state);
  const eventBase = {
    id: `fireworks-event:${next.id}:${next.turn}:${next.events.length + 1}`,
    turn: next.turn,
    playerId,
    action,
    legal: true,
    fallbackUsed: options.fallbackUsed,
  } satisfies Omit<FireworksEvent, "message" | "resultingScore">;
  let event: FireworksEvent;

  if (action.action === "clue_color" || action.action === "clue_rank") {
    applyClueInPlace(next, playerId, action);
    const useful = isUsefulClue(next, action);
    event = {
      ...eventBase,
      useful,
      memoryConsistent: true,
      message:
        action.action === "clue_color"
          ? `${playerId} clued ${action.targetPlayerId} about ${action.color}.`
          : `${playerId} clued ${action.targetPlayerId} about ${action.rank}s.`,
      resultingScore: scoreFireworksState(next),
    };
  } else if (action.action === "play") {
    const hand = getHand(next, playerId);
    const [card] = removeCardAt(hand, action.cardIndex);
    if (!card) throw new Error("Fireworks play card is missing.");
    const success = isPlayableCard(next, card);
    if (success) {
      next.stacks[card.color] = card.rank;
      if (card.rank === 5) {
        next.clueTokens = Math.min(next.maxClueTokens, next.clueTokens + 1);
      }
    } else {
      next.mistakeTokens = Math.max(0, next.mistakeTokens - 1);
      next.discardPile.push({
        card,
        reason: "misplayed",
        playerId,
        turn: next.turn,
        critical: isCriticalCard(state, card),
      });
    }
    drawReplacementCardInPlace(next, playerId);
    event = {
      ...eventBase,
      useful: success,
      memoryConsistent: isMemoryConsistentAction(state, playerId, action),
      playResult: success ? "success" : "misplay",
      message: success
        ? `${playerId} played ${card.color} ${card.rank}.`
        : `${playerId} misplayed ${card.color} ${card.rank}.`,
      resultingScore: scoreFireworksState(next),
    };
  } else {
    const hand = getHand(next, playerId);
    const [card] = removeCardAt(hand, action.cardIndex);
    if (!card) throw new Error("Fireworks discard card is missing.");
    const critical = isCriticalCard(state, card);
    next.clueTokens = Math.min(next.maxClueTokens, next.clueTokens + 1);
    next.discardPile.push({
      card,
      reason: "discarded",
      playerId,
      turn: next.turn,
      critical,
    });
    drawReplacementCardInPlace(next, playerId);
    event = {
      ...eventBase,
      useful: !critical,
      memoryConsistent: isMemoryConsistentAction(state, playerId, action),
      criticalDiscard: critical,
      message: `${playerId} discarded ${card.color} ${card.rank}.`,
      resultingScore: scoreFireworksState(next),
    };
  }

  next.events.push(event);
  next.turn += 1;
  updateStatusAfterAction(next);
  if (next.status === "playing") {
    next.currentPlayerIndex = (next.currentPlayerIndex + 1) % next.players.length;
  }
  return next;
}

export function isPlayableCard(
  state: Pick<FireworksGameState, "stacks">,
  card: FireworksCard
): boolean {
  return card.rank === state.stacks[card.color] + 1;
}

export function isCriticalCard(
  state: Pick<FireworksGameState, "stacks" | "discardPile">,
  card: FireworksCard
): boolean {
  if (state.stacks[card.color] >= card.rank) return false;
  const discardedCopies = state.discardPile.filter(
    (item) => item.card.color === card.color && item.card.rank === card.rank
  ).length;
  return discardedCopies >= RANK_COPY_COUNTS[card.rank] - 1;
}

export function drawReplacementCard(
  state: FireworksGameState,
  playerId: string
): FireworksGameState {
  const next = cloneState(state);
  drawReplacementCardInPlace(next, playerId);
  return next;
}

export function scoreFireworksState(
  state: Pick<FireworksGameState, "stacks">
): number {
  return state.stacks.red + state.stacks.blue + state.stacks.green;
}

export function isGameComplete(state: FireworksGameState): boolean {
  return (
    scoreFireworksState(state) >= FIREWORKS_MAX_SCORE ||
    state.status === "completed"
  );
}

export function fireworksActionsEqual(
  left: FireworksAction,
  right: FireworksAction
): boolean {
  if (left.action !== right.action) return false;
  switch (left.action) {
    case "clue_color":
      return (
        right.action === "clue_color" &&
        left.targetPlayerId === right.targetPlayerId &&
        left.color === right.color
      );
    case "clue_rank":
      return (
        right.action === "clue_rank" &&
        left.targetPlayerId === right.targetPlayerId &&
        left.rank === right.rank
      );
    case "play":
      return right.action === "play" && left.cardIndex === right.cardIndex;
    case "discard":
      return right.action === "discard" && left.cardIndex === right.cardIndex;
  }
}

export function cloneFireworksState(state: FireworksGameState): FireworksGameState {
  return cloneState(state);
}

export function getFireworksRankCopyCount(rank: FireworksRank): number {
  return RANK_COPY_COUNTS[rank];
}

function createDefaultPlayers(playerCount: 2 | 3): FireworksPlayer[] {
  return Array.from({ length: playerCount }, (_, index) => ({
    id: `P${index + 1}`,
    label: `Player ${index + 1}`,
    kind: "human" as const,
  }));
}

function applyClueInPlace(
  state: FireworksGameState,
  playerId: string,
  action: Extract<FireworksAction, { action: "clue_color" | "clue_rank" }>
): void {
  if (action.targetPlayerId === playerId) {
    throw new Error("Fireworks players may not clue themselves.");
  }
  const targetHand = getHand(state, action.targetPlayerId);
  const matchingIndexes = targetHand.cards
    .map((card, index) =>
      clueMatches(action, card) ? index : -1
    )
    .filter((index) => index >= 0);
  if (matchingIndexes.length === 0) {
    throw new Error("Fireworks clue must identify at least one card.");
  }
  state.clueTokens -= 1;

  targetHand.cards.forEach((card, index) => {
    const knowledge = targetHand.knowledge[index] ?? createEmptyFireworksKnowledge();
    const matches = clueMatches(action, card);
    if (action.action === "clue_color") {
      if (matches) {
        knowledge.color = action.color;
        knowledge.clueHistory.push(`Turn ${state.turn}: ${action.color}`);
      } else if (!knowledge.notColors.includes(action.color)) {
        knowledge.notColors.push(action.color);
      }
    } else if (matches) {
      knowledge.rank = action.rank;
      knowledge.clueHistory.push(`Turn ${state.turn}: rank ${action.rank}`);
    } else if (!knowledge.notRanks.includes(action.rank)) {
      knowledge.notRanks.push(action.rank);
    }
    targetHand.knowledge[index] = knowledge;
  });
}

function clueMatches(
  action: Extract<FireworksAction, { action: "clue_color" | "clue_rank" }>,
  card: FireworksCard
): boolean {
  return action.action === "clue_color"
    ? card.color === action.color
    : card.rank === action.rank;
}

function isUsefulClue(
  stateAfterClue: FireworksGameState,
  action: Extract<FireworksAction, { action: "clue_color" | "clue_rank" }>
): boolean {
  const hand = getHand(stateAfterClue, action.targetPlayerId);
  return hand.cards.some((card) => clueMatches(action, card) && isPlayableCard(stateAfterClue, card));
}

function isMemoryConsistentAction(
  state: FireworksGameState,
  playerId: string,
  action: Extract<FireworksAction, { action: "play" | "discard" }>
): boolean {
  const hand = getHand(state, playerId);
  const card = hand.cards[action.cardIndex];
  const knowledge = hand.knowledge[action.cardIndex];
  if (!card || !knowledge) return true;
  if (knowledge.color && knowledge.color !== card.color) return false;
  if (knowledge.rank && knowledge.rank !== card.rank) return false;
  if (knowledge.notColors.includes(card.color)) return false;
  if (knowledge.notRanks.includes(card.rank)) return false;
  return true;
}

function removeCardAt(
  hand: FireworksPlayerHand,
  cardIndex: number
): [FireworksCard | undefined] {
  const card = hand.cards.splice(cardIndex, 1)[0];
  hand.knowledge.splice(cardIndex, 1);
  return [card];
}

function drawReplacementCardInPlace(
  state: FireworksGameState,
  playerId: string
): void {
  const hand = getHand(state, playerId);
  const card = state.deck.shift();
  if (!card) return;
  hand.cards.push(card);
  hand.knowledge.push(createEmptyFireworksKnowledge());
}

function updateStatusAfterAction(state: FireworksGameState): void {
  if (state.mistakeTokens <= 0) {
    state.status = "failed";
    return;
  }
  if (scoreFireworksState(state) >= FIREWORKS_MAX_SCORE) {
    state.status = "completed";
    return;
  }
  const allHandsEmpty = state.hands.every((hand) => hand.cards.length === 0);
  if (state.deck.length === 0 && allHandsEmpty) {
    state.status = "completed";
  }
}

function getHand(state: FireworksGameState, playerId: string): FireworksPlayerHand {
  const hand = state.hands.find((candidate) => candidate.playerId === playerId);
  if (!hand) throw new Error(`Unknown Fireworks player: ${playerId}.`);
  return hand;
}

function cloneState(state: FireworksGameState): FireworksGameState {
  return {
    ...state,
    players: state.players.map((player) => ({ ...player })),
    hands: state.hands.map((hand) => ({
      playerId: hand.playerId,
      cards: cloneCards(hand.cards),
      knowledge: cloneKnowledgeList(hand.knowledge),
    })),
    deck: cloneCards(state.deck),
    stacks: { ...state.stacks },
    discardPile: state.discardPile.map((item) => ({
      ...item,
      card: { ...item.card },
    })),
    events: state.events.map((event) => ({
      ...event,
      action: { ...event.action } as FireworksAction,
    })),
  };
}

function cloneCards(cards: FireworksCard[]): FireworksCard[] {
  return cards.map((card) => ({ ...card }));
}

function cloneKnowledgeList(
  list: FireworksCardKnowledge[]
): FireworksCardKnowledge[] {
  return list.map((knowledge) => ({
    color: knowledge.color,
    rank: knowledge.rank,
    notColors: [...knowledge.notColors],
    notRanks: [...knowledge.notRanks],
    clueHistory: [...knowledge.clueHistory],
  }));
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

export function emptyStacks(): FireworksStackState {
  return { red: 0, blue: 0, green: 0 };
}
