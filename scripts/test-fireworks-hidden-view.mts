/* Fireworks hidden-view checks (run: npx tsx scripts/test-fireworks-hidden-view.mts) */
import {
  applyFireworksAction,
  createFireworksGame,
} from "../lib/games/fireworks/engine";
import { getFireworksPlayerView } from "../lib/games/fireworks/hidden-view";

let failures = 0;

function check(name: string, ok: boolean, detail?: unknown): void {
  if (!ok) failures++;
  console.log(
    `${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` -> ${JSON.stringify(detail)}`}`
  );
}

let state = createFireworksGame({
  seed: "hidden-view",
  players: [
    { id: "P1", label: "Player 1", kind: "human" },
    { id: "P2", label: "Player 2", kind: "human" },
  ],
});
state.hands[0].cards[0] = { id: "secret-red-1", color: "red", rank: 1 };
state.hands[1].cards[0] = { id: "visible-blue-1", color: "blue", rank: 1 };

const p1InitialView = getFireworksPlayerView(state, "P1");
check(
  "player cannot see own card identities in hidden view",
  p1InitialView.ownHand.cards.every(
    (card) => card.color === null && card.rank === null
  ) &&
    !JSON.stringify(p1InitialView).includes("secret-red-1"),
  p1InitialView
);
check(
  "player can see other players' card identities",
  p1InitialView.otherHands[0]?.cards[0]?.color === "blue" &&
    p1InitialView.otherHands[0]?.cards[0]?.rank === 1,
  p1InitialView.otherHands
);
check(
  "hidden view exposes deck count but not future deck order",
  p1InitialView.deckCount === state.deck.length &&
    !("deck" in (p1InitialView as unknown as Record<string, unknown>)),
  p1InitialView
);

state = applyFireworksAction(state, "P1", {
  action: "clue_rank",
  targetPlayerId: "P2",
  rank: 1,
});
state = applyFireworksAction(state, "P2", {
  action: "clue_color",
  targetPlayerId: "P1",
  color: "red",
});
const p1CluedView = getFireworksPlayerView(state, "P1");
check(
  "player sees own public clue knowledge without raw hidden card object",
  p1CluedView.ownHand.cards[0]?.color === "red" &&
    p1CluedView.ownHand.cards[0]?.rank === null &&
    p1CluedView.stacks.red === state.stacks.red &&
    p1CluedView.discardPile.length === state.discardPile.length,
  p1CluedView
);
check(
  "legal action summary is available from player view",
  p1CluedView.legalActions.some((action) => action.action === "play") &&
    p1CluedView.legalActions.every((action) => action.action !== "clue_color" || action.targetPlayerId !== "P1"),
  p1CluedView.legalActions
);

if (failures === 0) {
  console.log("PASS");
} else {
  console.log(`FAIL ${failures} check(s) failed`);
}

process.exit(failures === 0 ? 0 : 1);
