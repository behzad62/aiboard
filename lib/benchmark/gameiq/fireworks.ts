import { getFireworksPlayerView } from "@/lib/games/fireworks/hidden-view";
import type { FireworksAction } from "@/lib/games/fireworks/types";
import {
  FIREWORKS_MEMORY_SCENARIOS,
  FIREWORKS_TACTICS_SCENARIOS,
} from "@/lib/benchmark/fireworks/scenario-packs";
import type { FireworksGameIqScenario } from "./types";

function expected(
  action: FireworksAction,
  label: string,
  weight = 1
): Array<{ action: FireworksAction; label: string; weight: number }> {
  return [{ action, label, weight }];
}

export const FIREWORKS_GAMEIQ_SCENARIOS: FireworksGameIqScenario[] = [
  ...FIREWORKS_TACTICS_SCENARIOS.filter(
    (scenario) =>
      scenario.category === "safe_play" || scenario.category === "needed_clue"
  ).slice(0, 10),
  ...FIREWORKS_MEMORY_SCENARIOS.filter(
    (scenario) => scenario.category === "combine_color_and_rank"
  ).slice(0, 10),
].map((scenario, index) => ({
  id: `gameiq-fireworks-solo-v0.1-${String(index + 1).padStart(2, "0")}`,
  gameId: "fireworks",
  title: `Fireworks Solo Control: ${scenario.title}`,
  category: "hidden-cooperation",
  difficulty: index < 10 ? "easy" : "medium",
  version: "0.1.0",
  prompt:
    "You control the active Fireworks player from this hidden-safe player view. Choose one legal action that maximizes team score.",
  initialState: getFireworksPlayerView(
    scenario.state,
    scenario.actingPlayerId
  ),
  expectedActions: expected(
    scenario.expectedActions[0].action,
    scenario.expectedActions[0].label,
    scenario.expectedActions[0].weight
  ),
  tags: ["fireworks", "solo-control", "hidden-information"],
  maxResponseMs: 15_000,
}));
