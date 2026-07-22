"use client";

import { ChessGameClient } from "../chess-game-client";
import { useBackToGames } from "../use-back-to-games";

export function ChessRoute() {
  const onBackToGames = useBackToGames();
  return <ChessGameClient onBackToGames={onBackToGames} />;
}
