import { createInitialCodenamesState } from "@/lib/games/codenames/engine";
import type { CodenamesGameIqAction, CodenamesGameIqScenario } from "./types";

function expected(
  action: CodenamesGameIqAction,
  label: string,
  note?: string
): Array<{ action: CodenamesGameIqAction; label: string; weight: number; note?: string }> {
  return [{ action, label, weight: 1, note }];
}

const openingState = createInitialCodenamesState({
  seed: "gameiq-v0.1-codenames-opening",
  startingTeam: "red",
});

export const CODENAMES_GAMEIQ_SCENARIOS: CodenamesGameIqScenario[] = [
  {
    id: "gameiq-v0.1-codenames-opening-safe-clue",
    gameId: "codenames",
    title: "Codenames: give a legal opening clue",
    category: "clue-selection",
    difficulty: "easy",
    version: "0.1.0",
    prompt:
      "Red spymaster to move. Return a one-word clue and count that is legal for the board.",
    initialState: openingState,
    expectedActions: expected(
      { type: "clue", clue: { word: "ORBIT", count: 1 } },
      "ORBIT 1",
      "A legal non-board clue with a conservative count."
    ),
    tags: ["codenames", "clue", "legality"],
    maxResponseMs: 15_000,
  },
];
