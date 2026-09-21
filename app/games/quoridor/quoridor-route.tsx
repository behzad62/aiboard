"use client";

import { QuoridorGameClient } from "../quoridor-game-client";
import { useBackToGames } from "../use-back-to-games";

export function QuoridorRoute() {
  const onBackToGames = useBackToGames();
  return <QuoridorGameClient onBackToGames={onBackToGames} />;
}
