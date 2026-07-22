"use client";

import { FireworksGameClient } from "../fireworks-game-client";
import { useBackToGames } from "../use-back-to-games";

export function FireworksRoute() {
  const onBackToGames = useBackToGames();
  return <FireworksGameClient onBackToGames={onBackToGames} />;
}
