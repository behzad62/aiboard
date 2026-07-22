"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { GamePicker } from "@/components/games/GamePicker";
import { getGameCatalog, getGameDescriptor } from "@/lib/games/catalog";
import { listGameSessions } from "@/lib/games/core/session-store";
import type { GameSessionRecord } from "@/lib/games/core/types";

const ACTIVE_SESSION_STATUSES = new Set<GameSessionRecord["status"]>([
  "active",
  "paused",
]);

export function GamesClient() {
  const router = useRouter();
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
    void loadResumableSessions();
  }, [loadResumableSessions]);

  return (
    <GamePicker
      games={getGameCatalog()}
      resumableSessions={resumableSessions}
      onSelectGame={(gameId) => {
        // Each game is a real route now, so it gets its own URL, its own title
        // and description, and a working browser back button.
        if (getGameDescriptor(gameId)) {
          router.push(`/games/${gameId}`);
        }
      }}
    />
  );
}

export default GamesClient;
