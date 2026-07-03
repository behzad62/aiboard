/* Print exact model-facing own-hand knowledge for the 4 disputed scenarios. */
import {
  FIREWORKS_MEMORY_SCENARIOS,
  FIREWORKS_TACTICS_SCENARIOS,
} from "../lib/benchmark/fireworks/scenario-packs";
import { getFireworksPlayerView } from "../lib/games/fireworks/hidden-view";
import type { FireworksScenario } from "../lib/benchmark/fireworks/types";

const HARD = FIREWORKS_TACTICS_SCENARIOS.filter((s) =>
  ["avoid_bad_play", "safe_discard", "critical_discard_avoidance", "endgame_play"].includes(s.category)
);
const MEM = FIREWORKS_MEMORY_SCENARIOS.filter((s) =>
  ["old_clue_recall", "negative_information", "timing_inference"].includes(s.category)
);
const targets: Array<[string, FireworksScenario, boolean]> = [
  ["hard-14", HARD[13], false],
  ["hard-20", HARD[19], false],
  ["hard-27", HARD[26], false],
  ["memory-29", MEM[28], true],
];
for (const [name, s, redact] of targets) {
  console.log(`=== ${name} (${s.id}) — model-facing ownHand ===`);
  const view = getFireworksPlayerView(s.state, s.actingPlayerId, {
    omitRecommendations: true,
    redactOwnIdentity: redact,
  });
  view.ownHand.cards.forEach((c, i) => {
    const k = view.ownHand.knowledge[i];
    console.log(
      `  [${i}] visible color=${c.color} rank=${c.rank} | knowledge: color=${k.color} rank=${k.rank} notColors=[${k.notColors}] notRanks=[${k.notRanks}] clueHistory=${JSON.stringify(k.clueHistory)}`
    );
  });
  console.log(
    `  stacks=${JSON.stringify(view.stacks)} clues=${view.clueTokens} deck=${view.deckCount} events=${view.events.length}`
  );
}
