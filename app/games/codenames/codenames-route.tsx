"use client";

import { CodenamesGameClient } from "../codenames-game-client";
import { useBackToGames } from "../use-back-to-games";

export function CodenamesRoute() {
  const onBackToGames = useBackToGames();
  return <CodenamesGameClient onBackToGames={onBackToGames} />;
}
