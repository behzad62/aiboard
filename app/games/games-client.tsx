"use client";

import { useCallback, useEffect, useState } from "react";
import { GamePicker } from "@/components/games/GamePicker";
import { getGameCatalog } from "@/lib/games/catalog";
import { listGameSessions } from "@/lib/games/core/session-store";
import type { GameSessionRecord } from "@/lib/games/core/types";
import { BattleshipGameClient } from "./battleship-game-client";
import { ChessGameClient } from "./chess-game-client";
import { CodenamesGameClient } from "./codenames-game-client";
import { ConnectFourGameClient } from "./connect-four-game-client";
import { FireworksGameClient } from "./fireworks-game-client";

type SelectedGame =
  | "picker"
  | "chess"
  | "connect-four"
  | "battleship"
  | "codenames"
  | "fireworks";

const ACTIVE_SESSION_STATUSES = new Set<GameSessionRecord["status"]>([
  "active",
  "paused",
]);

export function GamesClient() {
  const [selectedGame, setSelectedGame] = useState<SelectedGame>("picker");
  const [resumableSessions, setResumableSessions] = useState<GameSessionRecord[]>(
    []
  );

  const loadResumableSessions = useCallback(async () => {
    const sessions = await listGameSessions();
    setResumableSessions(
      sessions.filter((session) => ACTIVE_SESSION_STATUSES.has(session.status))
    );
  }, []);

  useEffect(() => {
    if (selectedGame === "picker") {
      void loadResumableSessions();
    }
  }, [loadResumableSessions, selectedGame]);

  const handleBackToGames = useCallback(() => {
    setSelectedGame("picker");
  }, []);

  if (selectedGame === "chess") {
    return <ChessGameClient onBackToGames={handleBackToGames} />;
  }

  if (selectedGame === "connect-four") {
    return <ConnectFourGameClient onBackToGames={handleBackToGames} />;
  }

  if (selectedGame === "battleship") {
    return <BattleshipGameClient onBackToGames={handleBackToGames} />;
  }

  if (selectedGame === "codenames") {
    return <CodenamesGameClient onBackToGames={handleBackToGames} />;
  }

  if (selectedGame === "fireworks") {
    return <FireworksGameClient onBackToGames={handleBackToGames} />;
  }

  return (
    <GamePicker
      games={getGameCatalog()}
      resumableSessions={resumableSessions}
      onSelectGame={(gameId) => {
        if (
          gameId === "chess" ||
          gameId === "connect-four" ||
          gameId === "battleship" ||
          gameId === "codenames" ||
          gameId === "fireworks"
        ) {
          setSelectedGame(gameId);
        }
      }}
    />
  );
}

export default GamesClient;
