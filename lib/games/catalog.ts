export type GameCatalogMode = "pvp" | "pvai" | "aivai";

export interface GameDescriptor {
  id: string;
  title: string;
  summary: string;
  status: "ready" | "coming-soon";
  accent: "amber" | "red-yellow" | "blue-orange";
  modes: GameCatalogMode[];
}

const GAME_CATALOG: GameDescriptor[] = [
  {
    id: "chess",
    title: "Chess",
    summary: "Classic strategy with human and AI opponents.",
    status: "ready",
    accent: "amber",
    modes: ["pvp", "pvai", "aivai"],
  },
  {
    id: "connect-four",
    title: "Connect Four",
    summary: "Drop discs, build threats, and connect four in a row.",
    status: "ready",
    accent: "red-yellow",
    modes: ["pvp", "pvai", "aivai"],
  },
  {
    id: "battleship",
    title: "Battleship",
    summary: "Call coordinates, read the board, and sink the hidden fleet.",
    status: "ready",
    accent: "blue-orange",
    modes: ["pvp", "pvai", "aivai"],
  },
];

function copyDescriptor(descriptor: GameDescriptor): GameDescriptor {
  return {
    ...descriptor,
    modes: [...descriptor.modes],
  };
}

export function getGameCatalog(): GameDescriptor[] {
  return GAME_CATALOG.map(copyDescriptor);
}

export function getGameDescriptor(id: string): GameDescriptor | null {
  const descriptor = GAME_CATALOG.find((game) => game.id === id);
  return descriptor ? copyDescriptor(descriptor) : null;
}
