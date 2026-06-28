import {
  getCurrentPlayer,
  getLegalFireworksActions,
  isPlayableCard,
  isCriticalCard,
} from "./engine";
import type {
  FireworksAction,
  FireworksGameState,
  FireworksPlayerView,
  FireworksVisibleCard,
} from "./types";

export function getFireworksPlayerView(
  state: FireworksGameState,
  playerId: string
): FireworksPlayerView {
  const player = state.players.find((candidate) => candidate.id === playerId);
  const ownHand = state.hands.find((hand) => hand.playerId === playerId);
  if (!player || !ownHand) throw new Error(`Unknown Fireworks player: ${playerId}.`);

  const legalActions = getLegalFireworksActions(state, playerId);
  return {
    gameId: state.id,
    seed: state.seed,
    playerId,
    playerLabel: player.label,
    currentPlayerId: getCurrentPlayer(state).id,
    ownHand: {
      playerId,
      count: ownHand.cards.length,
      cards: ownHand.knowledge.map<FireworksVisibleCard>((knowledge) => ({
        id: null,
        color: knowledge.color ?? null,
        rank: knowledge.rank ?? null,
        knowledge: {
          color: knowledge.color,
          rank: knowledge.rank,
          notColors: [...knowledge.notColors],
          notRanks: [...knowledge.notRanks],
          clueHistory: [...knowledge.clueHistory],
        },
      })),
      knowledge: ownHand.knowledge.map((knowledge) => ({
        color: knowledge.color,
        rank: knowledge.rank,
        notColors: [...knowledge.notColors],
        notRanks: [...knowledge.notRanks],
        clueHistory: [...knowledge.clueHistory],
      })),
    },
    otherHands: state.hands
      .filter((hand) => hand.playerId !== playerId)
      .map((hand) => ({
        playerId: hand.playerId,
        label:
          state.players.find((candidate) => candidate.id === hand.playerId)?.label ??
          hand.playerId,
        cards: hand.cards.map((card) => ({
          id: card.id,
          color: card.color,
          rank: card.rank,
        })),
      })),
    stacks: { ...state.stacks },
    discardPile: state.discardPile.map((item) => ({
      ...item,
      card: { ...item.card },
    })),
    clueTokens: state.clueTokens,
    maxClueTokens: state.maxClueTokens,
    mistakeTokens: state.mistakeTokens,
    maxMistakeTokens: state.maxMistakeTokens,
    turn: state.turn,
    status: state.status,
    deckCount: state.deck.length,
    events: state.events.map((event) => ({
      ...event,
      action: { ...event.action } as FireworksAction,
    })),
    legalActions,
    recommendations: buildRecommendations(state, playerId, legalActions),
  };
}

function buildRecommendations(
  state: FireworksGameState,
  playerId: string,
  legalActions: FireworksAction[]
): FireworksPlayerView["recommendations"] {
  const ownHand = state.hands.find((hand) => hand.playerId === playerId);
  const knownPlayableCards: number[] = [];
  const safeDiscards: number[] = [];
  if (ownHand) {
    ownHand.knowledge.forEach((knowledge, index) => {
      if (
        knowledge.color &&
        knowledge.rank &&
        isPlayableCard(state, { id: "known", color: knowledge.color, rank: knowledge.rank })
      ) {
        knownPlayableCards.push(index);
      }
      if (
        knowledge.color &&
        knowledge.rank &&
        state.stacks[knowledge.color] >= knowledge.rank
      ) {
        safeDiscards.push(index);
      }
    });
  }

  const visiblePlayableClues = legalActions.filter((action) => {
    if (action.action !== "clue_color" && action.action !== "clue_rank") return false;
    const target = state.hands.find((hand) => hand.playerId === action.targetPlayerId);
    if (!target) return false;
    return target.cards.some((card) => {
      const matches =
        action.action === "clue_color"
          ? card.color === action.color
          : card.rank === action.rank;
      return matches && isPlayableCard(state, card);
    });
  });

  if (safeDiscards.length === 0 && ownHand) {
    ownHand.cards.forEach((card, index) => {
      if (!isCriticalCard(state, card)) safeDiscards.push(index);
    });
  }

  return {
    knownPlayableCards,
    visiblePlayableClues,
    safeDiscards,
  };
}
