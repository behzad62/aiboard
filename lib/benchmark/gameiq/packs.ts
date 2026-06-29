import { BATTLESHIP_GAMEIQ_SCENARIOS } from "./battleship";
import { CHESS_GAMEIQ_SCENARIOS } from "./chess";
import { CODENAMES_GAMEIQ_SCENARIOS } from "./codenames";
import { CONNECT_FOUR_GAMEIQ_SCENARIOS } from "./connect-four";
import {
  FIREWORKS_GAMEIQ_BASIC_SCENARIOS,
  FIREWORKS_GAMEIQ_HARD_SCENARIOS,
  FIREWORKS_GAMEIQ_MEMORY_STRESS_SCENARIOS,
} from "./fireworks";
import type { GameIqGameId, GameIqScenario, GameIqScenarioPack } from "./types";

const GAMEIQ_SCENARIO_PACKS: GameIqScenarioPack[] = [
  {
    id: "gameiq-v0.1-connect-four",
    gameId: "connect-four",
    label: "Certified GameIQ v1: Connect Four",
    version: "0.1.0",
    certificationTier: "first-class",
    scenarios: CONNECT_FOUR_GAMEIQ_SCENARIOS,
  },
  {
    id: "gameiq-v0.1-chess",
    gameId: "chess",
    label: "Certified GameIQ v1: Chess Tactics",
    version: "0.1.0",
    certificationTier: "first-class",
    scenarios: CHESS_GAMEIQ_SCENARIOS,
  },
  {
    id: "gameiq-v0.1-battleship",
    gameId: "battleship",
    label: "Certified GameIQ v1: Battleship Targeting",
    version: "0.1.0",
    certificationTier: "lightweight",
    scenarios: BATTLESHIP_GAMEIQ_SCENARIOS,
  },
  {
    id: "gameiq-v0.1-codenames",
    gameId: "codenames",
    label: "Certified GameIQ v1: Codenames Clues",
    version: "0.1.0",
    certificationTier: "lightweight",
    scenarios: CODENAMES_GAMEIQ_SCENARIOS,
  },
  {
    id: "gameiq-fireworks-basic-v1",
    gameId: "fireworks",
    label: "Certified GameIQ v1: Fireworks Solo Control Basic",
    version: "0.1.0",
    certificationTier: "lightweight",
    scenarios: FIREWORKS_GAMEIQ_BASIC_SCENARIOS,
  },
  {
    id: "gameiq-fireworks-hard-v1",
    gameId: "fireworks",
    label: "Certified GameIQ v1: Fireworks Trap States",
    version: "0.1.0",
    certificationTier: "first-class",
    scenarios: FIREWORKS_GAMEIQ_HARD_SCENARIOS,
  },
  {
    id: "gameiq-fireworks-memory-v1",
    gameId: "fireworks",
    label: "Certified GameIQ v1: Fireworks Memory Stress",
    version: "0.1.0",
    certificationTier: "first-class",
    scenarios: FIREWORKS_GAMEIQ_MEMORY_STRESS_SCENARIOS,
  },
];

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function listGameIqScenarioPacks(): GameIqScenarioPack[] {
  return GAMEIQ_SCENARIO_PACKS.map(clone);
}

export function getGameIqScenarioPack(
  gameId: GameIqGameId
): GameIqScenarioPack | null {
  const pack = GAMEIQ_SCENARIO_PACKS.find(
    (candidate) => candidate.gameId === gameId
  );
  return pack ? clone(pack) : null;
}

export function getGameIqScenarioPackById(packId: string): GameIqScenarioPack | null {
  const pack = GAMEIQ_SCENARIO_PACKS.find((candidate) => candidate.id === packId);
  return pack ? clone(pack) : null;
}

export function listGameIqScenarios(): GameIqScenario[] {
  return GAMEIQ_SCENARIO_PACKS.flatMap((pack) => pack.scenarios).map(clone);
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }

  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(",")}}`;
}

function hashString(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export function stableGameIqScenarioPackDigest(
  pack: GameIqScenarioPack
): string {
  return `gameiq-v1:${pack.id}:${hashString(stableStringify(pack))}`;
}
