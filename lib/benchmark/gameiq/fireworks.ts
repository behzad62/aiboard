import { getFireworksPlayerView } from "@/lib/games/fireworks/hidden-view";
import {
  FIREWORKS_MEMORY_SCENARIOS,
  FIREWORKS_TACTICS_SCENARIOS,
} from "@/lib/benchmark/fireworks/scenario-packs";
import type { FireworksScenario } from "@/lib/benchmark/fireworks/types";
import type { FireworksGameIqScenario } from "./types";

// Categories whose scenarios pre-seed resolved knowledge to test recall; the
// model-facing view must hide own-card identity for these so the benchmark
// measures memory, not transcription.
const MEMORY_CATEGORIES = new Set([
  "combine_color_and_rank",
  "old_clue_recall",
  "negative_information",
  "timing_inference",
]);

export function toGameIqScenario(input: {
  scenario: FireworksScenario;
  index: number;
  idPrefix: string;
  titlePrefix: string;
  difficulty: "easy" | "medium" | "hard";
  tags: string[];
}): FireworksGameIqScenario {
  return {
    id: `${input.idPrefix}-${String(input.index + 1).padStart(2, "0")}`,
    gameId: "fireworks",
    title: `${input.titlePrefix}: ${input.scenario.title}`,
    category: "hidden-cooperation",
    difficulty: input.difficulty,
    version: "0.1.0",
    prompt:
      "You control the active Fireworks player from this hidden-safe player view. Choose one legal action that maximizes team score.",
    initialState: getFireworksPlayerView(
      input.scenario.state,
      input.scenario.actingPlayerId,
      {
        omitRecommendations: true,
        redactOwnIdentity: MEMORY_CATEGORIES.has(input.scenario.category),
      }
    ),
    expectedActions: input.scenario.expectedActions.map((action) => ({
      action: action.action,
      label: action.label,
      weight: action.weight,
    })),
    tags: ["fireworks", "solo-control", "hidden-information", ...input.tags],
    maxResponseMs: 15_000,
  };
}

function mapScenarios(input: {
  scenarios: FireworksScenario[];
  idPrefix: string;
  titlePrefix: string;
  difficulty: (scenario: FireworksScenario, index: number) => "easy" | "medium" | "hard";
  tags: string[];
}): FireworksGameIqScenario[] {
  return input.scenarios.map((scenario, index) =>
    toGameIqScenario({
      scenario,
      index,
      idPrefix: input.idPrefix,
      titlePrefix: input.titlePrefix,
      difficulty: input.difficulty(scenario, index),
      tags: input.tags,
    })
  );
}

const BASIC_FIREWORKS_SOURCE = [
  ...FIREWORKS_TACTICS_SCENARIOS.filter(
    (scenario) =>
      scenario.category === "safe_play" || scenario.category === "needed_clue"
  ).slice(0, 10),
  ...FIREWORKS_MEMORY_SCENARIOS.filter(
    (scenario) => scenario.category === "combine_color_and_rank"
  ).slice(0, 10),
];

const HARD_FIREWORKS_SOURCE = FIREWORKS_TACTICS_SCENARIOS.filter(
  (scenario) =>
    scenario.category === "avoid_bad_play" ||
    scenario.category === "safe_discard" ||
    scenario.category === "critical_discard_avoidance" ||
    scenario.category === "endgame_play"
);

const MEMORY_STRESS_SOURCE = FIREWORKS_MEMORY_SCENARIOS.filter(
  (scenario) =>
    scenario.category === "old_clue_recall" ||
    scenario.category === "negative_information" ||
    scenario.category === "timing_inference"
);

export const FIREWORKS_GAMEIQ_BASIC_SCENARIOS: FireworksGameIqScenario[] =
  mapScenarios({
    scenarios: BASIC_FIREWORKS_SOURCE,
    idPrefix: "gameiq-fireworks-basic-v1",
    titlePrefix: "Fireworks Basic Solo Control",
    difficulty: (_scenario, index) => (index < 10 ? "easy" : "medium"),
    tags: ["basic", "sanity"],
  });

export const FIREWORKS_GAMEIQ_HARD_SCENARIOS: FireworksGameIqScenario[] =
  mapScenarios({
    scenarios: HARD_FIREWORKS_SOURCE,
    idPrefix: "gameiq-fireworks-hard-v1",
    titlePrefix: "Fireworks Trap-State Solo Control",
    difficulty: (scenario) =>
      scenario.category === "critical_discard_avoidance" ? "hard" : "medium",
    tags: ["hard", "trap-state"],
  });

export const FIREWORKS_GAMEIQ_MEMORY_STRESS_SCENARIOS: FireworksGameIqScenario[] =
  mapScenarios({
    scenarios: MEMORY_STRESS_SOURCE,
    idPrefix: "gameiq-fireworks-memory-v1",
    titlePrefix: "Fireworks Memory Stress",
    difficulty: () => "hard",
    tags: ["hard", "memory-stress"],
  });

export const FIREWORKS_GAMEIQ_SCENARIOS = FIREWORKS_GAMEIQ_BASIC_SCENARIOS;
