import type { BenchmarkCaseV2 } from "@/lib/benchmark/types";
import type {
  FireworksAction,
  FireworksGameMetrics,
  FireworksGameState,
} from "@/lib/games/fireworks/types";

export type FireworksBenchmarkSuite = "tactics" | "memory" | "full" | "mixed";

export type FireworksTacticsCategory =
  | "safe_play"
  | "needed_clue"
  | "avoid_bad_play"
  | "safe_discard"
  | "critical_discard_avoidance"
  | "endgame_play";

export type FireworksMemoryCategory =
  | "combine_color_and_rank"
  | "old_clue_recall"
  | "negative_information"
  | "timing_inference";

export type FireworksScenarioCategory =
  | FireworksTacticsCategory
  | FireworksMemoryCategory;

export interface FireworksExpectedAction {
  action: FireworksAction;
  weight: number;
  label: string;
}

export interface FireworksScenario {
  id: string;
  suite: "fireworks-tactics-v0.1" | "fireworks-memory-v0.1";
  category: FireworksScenarioCategory;
  title: string;
  seed: string;
  state: FireworksGameState;
  actingPlayerId: string;
  expectedActions: FireworksExpectedAction[];
  forbiddenActions?: FireworksAction[];
  tags: string[];
}

export interface FireworksFullGameCase {
  id: string;
  suite: "fireworks-full-v0.1";
  playerCount: 2 | 3;
  seed: string;
  maxTurns: number;
  maxScore: number;
  clueTokens: number;
  mistakeTokens: number;
}

export type FireworksBenchmarkCase = FireworksScenario | FireworksFullGameCase;

export interface FireworksBenchmarkSummary {
  suite: FireworksBenchmarkSuite;
  caseCount: number;
  score: number;
  metrics: FireworksGameMetrics;
  teamScore: number;
  teamLift?: number;
}

export interface FireworksCaseManifest extends BenchmarkCaseV2 {
  prompt: BenchmarkCaseV2["prompt"] & {
    publicContext?: string;
  };
}
