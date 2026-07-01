import {
  createInitialBattleshipState,
  fireBattleshipShot,
} from "@/lib/games/battleship/engine";
import type {
  BattleshipGameIqAction,
  BattleshipGameIqScenario,
} from "./types";

function expected(
  action: BattleshipGameIqAction,
  label: string,
  note?: string
): Array<{ action: BattleshipGameIqAction; label: string; weight: number; note?: string }> {
  return [{ action, label, weight: 1, note }];
}

const firstShotState = createInitialBattleshipState();
const firstCarrierHitState = fireBattleshipShot(
  createInitialBattleshipState(),
  { row: 0, column: 0 },
  0
);
const followCarrierLineState = {
  ...fireBattleshipShot(
    { ...firstCarrierHitState, turn: "blue" },
    { row: 0, column: 1 },
    1
  ),
  turn: "blue" as const,
};

const BATTLESHIP_BASE_SCENARIOS: BattleshipGameIqScenario[] = [
  {
    id: "gameiq-v0.1-battleship-corner-carrier-hit",
    gameId: "battleship",
    title: "Battleship: hit the known carrier corner",
    category: "target-priority",
    difficulty: "easy",
    version: "0.1.0",
    prompt:
      "Blue to move. Return the target coordinate for the known highest-value carrier hit.",
    initialState: firstShotState,
    expectedActions: expected(
      { target: { row: 0, column: 0 } },
      "A1",
      "The default orange carrier occupies A1-E1."
    ),
    tags: ["battleship", "targeting", "hit"],
    maxResponseMs: 15_000,
  },
  {
    id: "gameiq-v0.1-battleship-follow-line",
    gameId: "battleship",
    title: "Battleship: follow up after a carrier hit",
    category: "target-priority",
    difficulty: "easy",
    version: "0.1.0",
    prompt:
      "Blue to move after hitting the orange carrier at A1 and A2. Return the target coordinate that continues the known carrier line.",
    initialState: followCarrierLineState,
    expectedActions: expected(
      { target: { row: 0, column: 2 } },
      "A3",
      "Continue along the carrier row."
    ),
    tags: ["battleship", "targeting", "follow-up"],
    maxResponseMs: 15_000,
  },
];

const GENERATED_BATTLESHIP_TARGETS: Array<{
  id: string;
  title: string;
  target: BattleshipGameIqAction["target"];
  difficulty: BattleshipGameIqScenario["difficulty"];
  tags: string[];
}> = [
  { id: "carrier-second-cell", title: "follow the carrier line at B1", target: { row: 0, column: 1 }, difficulty: "easy", tags: ["target-priority"] },
  { id: "carrier-third-cell", title: "continue the carrier line at C1", target: { row: 0, column: 2 }, difficulty: "easy", tags: ["target-priority"] },
  { id: "carrier-fourth-cell", title: "continue the carrier line at D1", target: { row: 0, column: 3 }, difficulty: "easy", tags: ["target-priority"] },
  { id: "carrier-end-cell", title: "finish the carrier line at E1", target: { row: 0, column: 4 }, difficulty: "easy", tags: ["sink-completion"] },
  { id: "battleship-top", title: "target the battleship top at B3", target: { row: 2, column: 1 }, difficulty: "easy", tags: ["target-priority"] },
  { id: "battleship-middle-1", title: "target the battleship middle at B4", target: { row: 3, column: 1 }, difficulty: "medium", tags: ["target-priority"] },
  { id: "battleship-middle-2", title: "target the battleship middle at B5", target: { row: 4, column: 1 }, difficulty: "medium", tags: ["target-priority"] },
  { id: "battleship-bottom", title: "finish the battleship at B6", target: { row: 5, column: 1 }, difficulty: "medium", tags: ["sink-completion"] },
  { id: "cruiser-left", title: "target the cruiser left at F5", target: { row: 4, column: 5 }, difficulty: "easy", tags: ["target-priority"] },
  { id: "cruiser-center", title: "target the cruiser center at G5", target: { row: 4, column: 6 }, difficulty: "medium", tags: ["target-priority"] },
  { id: "cruiser-right", title: "finish the cruiser at H5", target: { row: 4, column: 7 }, difficulty: "medium", tags: ["sink-completion"] },
  { id: "submarine-top", title: "target the submarine top at I7", target: { row: 6, column: 8 }, difficulty: "easy", tags: ["target-priority"] },
  { id: "submarine-middle", title: "target the submarine middle at I8", target: { row: 7, column: 8 }, difficulty: "medium", tags: ["target-priority"] },
  { id: "submarine-bottom", title: "finish the submarine at I9", target: { row: 8, column: 8 }, difficulty: "medium", tags: ["sink-completion"] },
  { id: "destroyer-left", title: "target the destroyer left at C9", target: { row: 8, column: 2 }, difficulty: "easy", tags: ["target-priority"] },
  { id: "destroyer-right", title: "finish the destroyer at D9", target: { row: 8, column: 3 }, difficulty: "medium", tags: ["sink-completion"] },
  { id: "parity-corner", title: "choose unrepeated parity corner J10", target: { row: 9, column: 9 }, difficulty: "medium", tags: ["repeat-avoidance", "information-gain"] },
  { id: "parity-edge", title: "choose unrepeated parity edge A10", target: { row: 0, column: 9 }, difficulty: "medium", tags: ["repeat-avoidance", "information-gain"] },
  { id: "parity-center", title: "choose central information target E5", target: { row: 4, column: 4 }, difficulty: "medium", tags: ["information-gain"] },
  { id: "parity-diagonal", title: "choose diagonal information target F6", target: { row: 5, column: 5 }, difficulty: "medium", tags: ["information-gain"] },
  { id: "edge-scan", title: "choose legal edge scan J1", target: { row: 9, column: 0 }, difficulty: "hard", tags: ["information-gain"] },
  { id: "center-scan", title: "choose legal center scan E6", target: { row: 5, column: 4 }, difficulty: "hard", tags: ["information-gain"] },
  { id: "late-safe-target", title: "avoid repeats with a legal safe target H8", target: { row: 7, column: 7 }, difficulty: "hard", tags: ["repeat-avoidance"] },
];

const GENERATED_BATTLESHIP_SCENARIOS: BattleshipGameIqScenario[] =
  GENERATED_BATTLESHIP_TARGETS.map((item) => ({
    id: `gameiq-v0.1-battleship-${item.id}`,
    gameId: "battleship",
    title: `Battleship: ${item.title}`,
    category: "target-priority",
    difficulty: item.difficulty,
    version: "0.1.0",
    prompt:
      "Blue to move on the fixed default board. Return the target coordinate that best advances the stated targeting objective.",
    initialState: createInitialBattleshipState(),
    expectedActions: expected(
      { target: item.target },
      `${String.fromCharCode(65 + item.target.row)}${item.target.column + 1}`,
      "The coordinate is legal and tied to the deterministic default board."
    ),
    tags: ["battleship", ...item.tags],
    maxResponseMs: 15_000,
  }));

export const BATTLESHIP_GAMEIQ_SCENARIOS: BattleshipGameIqScenario[] = [
  ...BATTLESHIP_BASE_SCENARIOS,
  ...GENERATED_BATTLESHIP_SCENARIOS,
];
