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
const followUpHitState = fireBattleshipShot(
  createInitialBattleshipState(),
  { row: 0, column: 0 },
  0
);

export const BATTLESHIP_GAMEIQ_SCENARIOS: BattleshipGameIqScenario[] = [
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
      "Orange to move after blue hit A1. Return a legal target that follows the known carrier line.",
    initialState: followUpHitState,
    expectedActions: expected(
      { target: { row: 0, column: 1 } },
      "A2",
      "Continue along the carrier row."
    ),
    tags: ["battleship", "targeting", "follow-up"],
    maxResponseMs: 15_000,
  },
];
