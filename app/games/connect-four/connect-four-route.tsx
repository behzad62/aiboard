"use client";

import { ConnectFourGameClient } from "../connect-four-game-client";
import { useBackToGames } from "../use-back-to-games";

export function ConnectFourRoute() {
  const onBackToGames = useBackToGames();
  return <ConnectFourGameClient onBackToGames={onBackToGames} />;
}
