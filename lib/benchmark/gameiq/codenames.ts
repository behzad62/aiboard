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

const CODENAMES_BASE_SCENARIOS: CodenamesGameIqScenario[] = [
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

const GENERATED_CODENAMES_CLUES = [
  "VECTOR",
  "ORCHID",
  "QUARTZ",
  "NEBULA",
  "ANCHOR",
  "CIPHER",
  "ORACLE",
  "HARBOR",
  "GLACIER",
  "EMBER",
  "MOSAIC",
  "ZENITH",
  "RADAR",
  "NOVA",
  "ATLAS",
  "FABLE",
  "HORIZON",
  "PRISM",
  "SILVER",
  "COPPER",
  "SADDLE",
  "VOYAGE",
  "MEADOW",
  "ROCKET",
] as const;

const GENERATED_CODENAMES_SCENARIOS: CodenamesGameIqScenario[] =
  GENERATED_CODENAMES_CLUES.map((word, index) => {
    const scenarioNumber = String(index + 1).padStart(2, "0");
    const team = index % 2 === 0 ? "red" : "blue";
    return {
      id: `gameiq-v0.1-codenames-safe-clue-${scenarioNumber}`,
      gameId: "codenames",
      title: `Codenames: legal ${team} clue ${scenarioNumber}`,
      category: "clue-selection",
      difficulty: index < 12 ? "easy" : index < 20 ? "medium" : "hard",
      version: "0.1.0",
      prompt:
        `${team} spymaster to move. Return a legal one-word clue and a conservative count for this fixed board.`,
      initialState: createInitialCodenamesState({
        seed: `gameiq-v0.1-codenames-${scenarioNumber}`,
        startingTeam: team,
      }),
      expectedActions: expected(
        { type: "clue", clue: { word, count: 1 } },
        `${word} 1`,
        "A legal non-board clue with a conservative count."
      ),
      tags: ["codenames", "clue", "legality", team],
      maxResponseMs: 15_000,
    };
  });

export const CODENAMES_GAMEIQ_SCENARIOS: CodenamesGameIqScenario[] = [
  ...CODENAMES_BASE_SCENARIOS,
  ...GENERATED_CODENAMES_SCENARIOS,
];
