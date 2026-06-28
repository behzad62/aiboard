/* Fireworks engine checks (run: npx tsx scripts/test-fireworks-engine.mts) */
import {
  applyFireworksAction,
  createEmptyFireworksKnowledge,
  createFireworksGame,
  isGameComplete,
  scoreFireworksState,
} from "../lib/games/fireworks/engine";
import type { FireworksGameState } from "../lib/games/fireworks/types";

let failures = 0;

function check(name: string, ok: boolean, detail?: unknown): void {
  if (!ok) failures++;
  console.log(
    `${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` -> ${JSON.stringify(detail)}`}`
  );
}

function cardSignature(state: FireworksGameState): string {
  return [
    ...state.hands.flatMap((hand) => hand.cards),
    ...state.deck,
  ]
    .map((card) => `${card.id}:${card.color}${card.rank}`)
    .join("|");
}

function setCurrentCard(
  state: FireworksGameState,
  color: "red" | "blue" | "green",
  rank: 1 | 2 | 3 | 4 | 5
): FireworksGameState {
  const next = structuredClone(state) as FireworksGameState;
  next.hands[0].cards[0] = { id: `${color}-${rank}-test`, color, rank };
  next.hands[0].knowledge[0] = createEmptyFireworksKnowledge();
  return next;
}

const deterministicA = createFireworksGame({
  seed: "deterministic",
  players: [
    { id: "P1", label: "Player 1", kind: "human" },
    { id: "P2", label: "Player 2", kind: "human" },
  ],
});
const deterministicB = createFireworksGame({
  seed: "deterministic",
  players: [
    { id: "P1", label: "Player 1", kind: "human" },
    { id: "P2", label: "Player 2", kind: "human" },
  ],
});

check(
  "deck and deal are deterministic for the same seed",
  cardSignature(deterministicA) === cardSignature(deterministicB),
  { left: cardSignature(deterministicA), right: cardSignature(deterministicB) }
);

const clueBase = createFireworksGame({
  seed: "clue",
  players: [
    { id: "P1", label: "Player 1", kind: "human" },
    { id: "P2", label: "Player 2", kind: "human" },
  ],
});
clueBase.hands[1].cards[0] = { id: "red-1-clue", color: "red", rank: 1 };
const afterClue = applyFireworksAction(clueBase, "P1", {
  action: "clue_color",
  targetPlayerId: "P2",
  color: "red",
});
check(
  "color clue consumes one clue token and records positive knowledge",
  afterClue.clueTokens === clueBase.clueTokens - 1 &&
    afterClue.hands[1].knowledge[0]?.color === "red",
  afterClue
);

const discardBase = setCurrentCard(
  createFireworksGame({
    seed: "discard",
    players: [
      { id: "P1", label: "Player 1", kind: "human" },
      { id: "P2", label: "Player 2", kind: "human" },
    ],
    clueTokens: 4,
  }),
  "blue",
  3
);
const discardDeckBefore = discardBase.deck.length;
const afterDiscard = applyFireworksAction(discardBase, "P1", {
  action: "discard",
  cardIndex: 0,
});
check(
  "discard restores one clue token up to max and draws replacement",
  afterDiscard.clueTokens === 5 &&
    afterDiscard.discardPile[0]?.reason === "discarded" &&
    afterDiscard.deck.length === discardDeckBefore - 1 &&
    afterDiscard.hands[0].cards.length === 4,
  afterDiscard
);

const playBase = setCurrentCard(
  createFireworksGame({
    seed: "play",
    players: [
      { id: "P1", label: "Player 1", kind: "human" },
      { id: "P2", label: "Player 2", kind: "human" },
    ],
  }),
  "green",
  1
);
const afterPlay = applyFireworksAction(playBase, "P1", {
  action: "play",
  cardIndex: 0,
});
check(
  "legal play advances the matching stack",
  afterPlay.stacks.green === 1 && scoreFireworksState(afterPlay) === 1,
  afterPlay
);

const badPlayBase = setCurrentCard(
  createFireworksGame({
    seed: "bad-play",
    players: [
      { id: "P1", label: "Player 1", kind: "human" },
      { id: "P2", label: "Player 2", kind: "human" },
    ],
    mistakeTokens: 1,
  }),
  "red",
  3
);
const afterBadPlay = applyFireworksAction(badPlayBase, "P1", {
  action: "play",
  cardIndex: 0,
});
check(
  "bad play consumes final mistake token and fails the game",
  afterBadPlay.mistakeTokens === 0 &&
    afterBadPlay.status === "failed" &&
    afterBadPlay.discardPile[0]?.reason === "misplayed",
  afterBadPlay
);

const completeBase = setCurrentCard(
  createFireworksGame({
    seed: "complete",
    players: [
      { id: "P1", label: "Player 1", kind: "human" },
      { id: "P2", label: "Player 2", kind: "human" },
    ],
  }),
  "blue",
  5
);
completeBase.stacks = { red: 5, blue: 4, green: 5 };
const afterCompletion = applyFireworksAction(completeBase, "P1", {
  action: "play",
  cardIndex: 0,
});
check(
  "game completes at max stack score",
  isGameComplete(afterCompletion) &&
    afterCompletion.status === "completed" &&
    scoreFireworksState(afterCompletion) === 15,
  afterCompletion
);

if (failures === 0) {
  console.log("PASS");
} else {
  console.log(`FAIL ${failures} check(s) failed`);
}

process.exit(failures === 0 ? 0 : 1);
