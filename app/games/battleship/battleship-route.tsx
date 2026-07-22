"use client";

import { BattleshipGameClient } from "../battleship-game-client";
import { useBackToGames } from "../use-back-to-games";

export function BattleshipRoute() {
  const onBackToGames = useBackToGames();
  return <BattleshipGameClient onBackToGames={onBackToGames} />;
}
