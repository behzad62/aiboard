"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft } from "lucide-react";
import { GameAIPresence } from "@/components/games/GameAIPresence";
import type {
  GameAIConfigValue,
  GameAIModelOption,
} from "@/components/games/GameAIConfigPanel";
import { ConnectFourBoard } from "@/components/games/connect-four/ConnectFourBoard";
import { ConnectFourControls } from "@/components/games/connect-four/ConnectFourControls";
import { ConnectFourExportMenu } from "@/components/games/connect-four/ConnectFourExportMenu";
import { ConnectFourImportMenu } from "@/components/games/connect-four/ConnectFourImportMenu";
import { ConnectFourMoveHistory } from "@/components/games/connect-four/ConnectFourMoveHistory";
import { ConnectFourPlayerPanel } from "@/components/games/connect-four/ConnectFourPlayerPanel";
import { ConnectFourSetup } from "@/components/games/connect-four/ConnectFourSetup";
import {
  chooseFallbackConnectFourColumn,
  getAvailableConnectFourModels,
  getConnectFourModelApiKey,
  getConnectFourModelBaseURL,
  requestConnectFourAIMove,
} from "@/lib/games/connect-four/ai";
import {
  createInitialConnectFourState,
  dropDisc,
  getLegalColumns,
  isLegalColumn,
  setConnectFourPaused,
} from "@/lib/games/connect-four/engine";
import {
  CONNECT_FOUR_ACTIVE_SESSION_ID,
  createConnectFourSessionRecord,
  isConnectFourActiveStatus,
  parseConnectFourSessionRecord,
  type ConnectFourSessionSnapshot,
} from "@/lib/games/connect-four/session";
import type {
  ConnectFourGameMode,
  ConnectFourGameState,
  ConnectFourPlayer,
} from "@/lib/games/connect-four/types";
import type { GameAIInteraction } from "@/lib/games/core/types";
import {
  deleteGameSession,
  listGameSessions,
  saveGameSession,
} from "@/lib/games/core/session-store";
import { cn } from "@/lib/utils";

type AIConfig = GameAIConfigValue;

const EMPTY_AI_CONFIG: AIConfig = {
  modelId: "",
  reasoningEffort: "default",
};

function playerLabel(player: ConnectFourPlayer): string {
  return player === "red" ? "Red" : "Yellow";
}

function compactReasoningLabel(config: AIConfig): string {
  switch (config.reasoningEffort) {
    case "low":
      return "Low";
    case "medium":
      return "Medium";
    case "high":
      return "High";
    case "max":
      return "Max";
    case "default":
    default:
      return "Off";
  }
}

function isAIControlledPlayer(
  mode: ConnectFourGameMode,
  humanPlayer: ConnectFourPlayer,
  player: ConnectFourPlayer
): boolean {
  if (mode === "aivai") return true;
  if (mode === "pvai") return player !== humanPlayer;
  return false;
}

function shouldPersistConnectFourSnapshot(
  snapshot: ConnectFourSessionSnapshot
): boolean {
  return (
    snapshot.isPaused || isConnectFourActiveStatus(snapshot.gameState.status)
  );
}

function isNonrecoverableAIError(error: string): boolean {
  const normalized = error.toLowerCase();
  return (
    normalized.includes("aborted") ||
    normalized.includes("unknown provider") ||
    normalized.includes("unauthorized") ||
    normalized.includes("forbidden") ||
    normalized.includes("invalid api key") ||
    normalized.includes("quota") ||
    normalized.includes("key limit") ||
    normalized.includes("401") ||
    normalized.includes("403")
  );
}

function createFallbackInteraction(
  player: ConnectFourPlayer,
  error: string
): GameAIInteraction {
  return {
    actorId: player,
    gesture: "confused",
    utterance: "I could not play that move, so a legal fallback was used.",
    diagnostics: error,
  };
}

function attachAIInteractionToLatestMove(
  state: ConnectFourGameState,
  interaction: GameAIInteraction | null
): ConnectFourGameState {
  if (!interaction || state.moveHistory.length === 0) return state;

  const moveHistory = state.moveHistory.map((record, index) =>
    index === state.moveHistory.length - 1
      ? { ...record, aiInteraction: interaction }
      : record
  );

  return { ...state, moveHistory };
}

function applyDiscWithInteraction(
  state: ConnectFourGameState,
  column: number,
  timestamp: number,
  interaction: GameAIInteraction | null = null
): ConnectFourGameState {
  return attachAIInteractionToLatestMove(
    dropDisc(state, column, timestamp),
    interaction
  );
}

function createReplayState(
  liveState: ConnectFourGameState,
  replayIndex: number | null
): ConnectFourGameState {
  if (replayIndex === null) return liveState;
  if (replayIndex < 0) {
    return {
      ...createInitialConnectFourState(),
      moveHistory: liveState.moveHistory,
    };
  }

  const record = liveState.moveHistory[replayIndex];
  if (!record) return liveState;

  const nextTurn: ConnectFourPlayer =
    record.player === "red" ? "yellow" : "red";

  return {
    board: record.boardAfter.map((row) => [...row]),
    turn: nextTurn,
    status:
      replayIndex === liveState.moveHistory.length - 1
        ? liveState.status
        : "playing",
    winner:
      replayIndex === liveState.moveHistory.length - 1
        ? liveState.winner
        : null,
    moveHistory: liveState.moveHistory,
  };
}

function modelLabel(
  models: GameAIModelOption[],
  modelId: string
): string | undefined {
  return (
    models.find((model) => model.modelId === modelId)?.displayName ?? modelId
  );
}

function normalizeAIConfig(
  config: AIConfig,
  models: GameAIModelOption[]
): AIConfig {
  if (config.modelId || models.length === 0) return config;
  return { ...config, modelId: models[0].modelId };
}

export function ConnectFourGameClient({
  onBackToGames,
}: {
  onBackToGames?: () => void;
}) {
  const [gameStarted, setGameStarted] = useState(false);
  const [gameMode, setGameMode] = useState<ConnectFourGameMode>("pvp");
  const [humanPlayer, setHumanPlayer] = useState<ConnectFourPlayer>("red");
  const [redAI, setRedAI] = useState<AIConfig>(EMPTY_AI_CONFIG);
  const [yellowAI, setYellowAI] = useState<AIConfig>(EMPTY_AI_CONFIG);
  const [availableModels, setAvailableModels] = useState<GameAIModelOption[]>([]);
  const [gameState, setGameState] = useState<ConnectFourGameState>(() =>
    createInitialConnectFourState()
  );
  const [isPaused, setIsPaused] = useState(false);
  const [aiThinking, setAiThinking] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);
  const [aiWarning, setAiWarning] = useState<string | null>(null);
  const [lastAiInteraction, setLastAiInteraction] =
    useState<GameAIInteraction | null>(null);
  const [restoreSnapshot, setRestoreSnapshot] =
    useState<ConnectFourSessionSnapshot | null>(null);
  const [restoreCreatedAt, setRestoreCreatedAt] = useState<string | null>(null);
  const [replayIndex, setReplayIndex] = useState<number | null>(null);
  const [previewColumn, setPreviewColumn] = useState<number | null>(null);

  const aiRequestVersionRef = useRef(0);
  const activeAIAbortControllerRef = useRef<AbortController | null>(null);
  const aiRequestActiveRef = useRef(false);
  const latestSnapshotRef = useRef<ConnectFourSessionSnapshot | null>(null);
  const activeSessionCreatedAtRef = useRef<string | null>(null);
  const autosaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const persistenceTokenRef = useRef(0);
  const pendingSessionDeleteRef = useRef<Promise<void> | null>(null);
  const canPersistActiveSessionRef = useRef(false);

  const displayState = useMemo(
    () => createReplayState(gameState, replayIndex),
    [gameState, replayIndex]
  );
  const isReplayReviewing = replayIndex !== null;
  const activeGame = isConnectFourActiveStatus(gameState.status);
  canPersistActiveSessionRef.current = gameStarted && (isPaused || activeGame);
  const displayActiveGame = isConnectFourActiveStatus(displayState.status);
  const currentPlayerIsAI = isAIControlledPlayer(
    gameMode,
    humanPlayer,
    gameState.turn
  );
  const moveCount = gameState.moveHistory.length;
  const exportSnapshot = useMemo(
    () => ({
      gameState,
      gameMode,
      humanPlayer,
      redAI,
      yellowAI,
      isPaused,
      lastAiInteraction,
      aiWarning,
      aiError,
    }),
    [
      gameState,
      gameMode,
      humanPlayer,
      redAI,
      yellowAI,
      isPaused,
      lastAiInteraction,
      aiWarning,
      aiError,
    ]
  );

  const invalidateAIRequests = useCallback(() => {
    aiRequestVersionRef.current += 1;
    activeAIAbortControllerRef.current?.abort();
    activeAIAbortControllerRef.current = null;
    aiRequestActiveRef.current = false;
    setAiThinking(false);
    return aiRequestVersionRef.current;
  }, []);

  const clearAutosaveTimer = useCallback(() => {
    if (autosaveTimerRef.current) {
      clearTimeout(autosaveTimerRef.current);
      autosaveTimerRef.current = null;
    }
  }, []);

  const invalidatePersistence = useCallback(() => {
    persistenceTokenRef.current += 1;
    return persistenceTokenRef.current;
  }, []);

  const saveLatestSession = useCallback(async (token: number) => {
    if (token !== persistenceTokenRef.current) return;

    const pendingDelete = pendingSessionDeleteRef.current;
    if (pendingDelete) {
      await pendingDelete;
      if (token !== persistenceTokenRef.current) return;
    }

    const snapshot = latestSnapshotRef.current;
    if (!snapshot) return;
    if (!shouldPersistConnectFourSnapshot(snapshot)) return;

    const now = new Date(Date.now()).toISOString();
    const createdAt = activeSessionCreatedAtRef.current ?? now;

    try {
      await saveGameSession(
        createConnectFourSessionRecord(snapshot, now, createdAt)
      );
      if (token === persistenceTokenRef.current) {
        activeSessionCreatedAtRef.current = createdAt;
      }
    } catch (error) {
      console.warn("Failed to autosave Connect Four session:", error);
    }
  }, []);

  const flushLatestActiveSession = useCallback(async () => {
    const snapshot = latestSnapshotRef.current;
    if (
      !snapshot ||
      !canPersistActiveSessionRef.current ||
      !shouldPersistConnectFourSnapshot(snapshot)
    ) {
      clearAutosaveTimer();
      return;
    }

    const token = persistenceTokenRef.current;
    clearAutosaveTimer();
    await saveLatestSession(token);
  }, [clearAutosaveTimer, saveLatestSession]);

  const deleteActiveSession = useCallback(async () => {
    const token = invalidatePersistence();
    clearAutosaveTimer();
    latestSnapshotRef.current = null;
    activeSessionCreatedAtRef.current = null;
    setRestoreSnapshot(null);
    setRestoreCreatedAt(null);

    const previousDelete = pendingSessionDeleteRef.current ?? Promise.resolve();
    let deleteTail: Promise<void> | null = null;
    deleteTail = previousDelete
      .catch(() => undefined)
      .then(async () => {
        try {
          await deleteGameSession(CONNECT_FOUR_ACTIVE_SESSION_ID);
        } catch (error) {
          if (token === persistenceTokenRef.current) {
            console.warn("Failed to delete active Connect Four session:", error);
          }
        }
      })
      .finally(() => {
        if (pendingSessionDeleteRef.current === deleteTail) {
          pendingSessionDeleteRef.current = null;
        }
      });

    pendingSessionDeleteRef.current = deleteTail;
    await deleteTail;
  }, [clearAutosaveTimer, invalidatePersistence]);

  useEffect(() => {
    if (typeof window === "undefined") return;

    try {
      const models = getAvailableConnectFourModels();
      setAvailableModels(models);
      setRedAI((prev) => normalizeAIConfig(prev, models));
      setYellowAI((prev) => normalizeAIConfig(prev, models));
    } catch (error) {
      console.warn("Failed to load Connect Four models:", error);
    }
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;

    let cancelled = false;

    async function restoreSavedSession() {
      try {
        const sessions = await listGameSessions();
        if (cancelled) return;

        const record = sessions.find(
          (session) =>
            session.id === CONNECT_FOUR_ACTIVE_SESSION_ID &&
            session.gameId === "connect-four" &&
            session.status !== "complete" &&
            session.status !== "abandoned"
        );
        const snapshot = record ? parseConnectFourSessionRecord(record) : null;
        const restorable =
          snapshot &&
          (snapshot.isPaused ||
            isConnectFourActiveStatus(snapshot.gameState.status));

        setRestoreSnapshot(restorable ? snapshot : null);
        setRestoreCreatedAt(restorable && record ? record.createdAt : null);
      } catch (error) {
        if (!cancelled) {
          console.warn("Failed to restore Connect Four session:", error);
        }
      }
    }

    void restoreSavedSession();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!gameStarted || (!isPaused && !isConnectFourActiveStatus(gameState.status))) {
      latestSnapshotRef.current = null;
      return;
    }

    latestSnapshotRef.current = exportSnapshot;
  }, [exportSnapshot, gameStarted, gameState.status, isPaused]);

  useEffect(() => {
    if (!latestSnapshotRef.current) return;

    const token = persistenceTokenRef.current;
    clearAutosaveTimer();
    autosaveTimerRef.current = setTimeout(() => {
      void saveLatestSession(token);
    }, 350);

    return clearAutosaveTimer;
  }, [clearAutosaveTimer, exportSnapshot, saveLatestSession]);

  useEffect(() => {
    if (!gameStarted || isConnectFourActiveStatus(gameState.status)) return;
    void deleteActiveSession();
  }, [deleteActiveSession, gameStarted, gameState.status]);

  useEffect(() => {
    if (!gameStarted || isPaused || isReplayReviewing || !activeGame) return;
    if (!currentPlayerIsAI || aiRequestActiveRef.current) return;

    const config = gameState.turn === "red" ? redAI : yellowAI;
    if (!config.modelId) {
      setAiError(`${playerLabel(gameState.turn)} AI has no model selected.`);
      return;
    }

    const requestVersion = aiRequestVersionRef.current;
    const abortController = new AbortController();
    activeAIAbortControllerRef.current = abortController;
    const currentTurn = gameState.turn;
    const requestState = gameState;

    const isCurrentAIRequest = () =>
      aiRequestVersionRef.current === requestVersion &&
      activeAIAbortControllerRef.current === abortController &&
      !abortController.signal.aborted;

    async function makeAIMove() {
      aiRequestActiveRef.current = true;
      setAiThinking(true);
      setAiError(null);

      try {
        const apiKey = getConnectFourModelApiKey(config.modelId) ?? "";
        const baseURL = getConnectFourModelBaseURL(config.modelId);
        const result = await requestConnectFourAIMove({
          state: requestState,
          modelId: config.modelId,
          reasoningEffort: config.reasoningEffort,
          apiKey,
          baseURL,
          signal: abortController.signal,
        });

        if (!isCurrentAIRequest()) return;

        if ("column" in result) {
          const legal = isLegalColumn(requestState, result.column);
          const fallbackColumn =
            legal || getLegalColumns(requestState).length === 0
              ? null
              : chooseFallbackConnectFourColumn(requestState);
          const column = legal ? result.column : fallbackColumn;

          if (column === null) {
            setAiWarning(null);
            setAiError(`AI returned illegal column ${result.column + 1}.`);
            return;
          }

          const interaction = legal
            ? result.interaction
            : createFallbackInteraction(
                currentTurn,
                `AI returned illegal column ${result.column + 1}.`
              );

          setAiWarning(
            legal
              ? null
              : `${playerLabel(currentTurn)} AI returned illegal column ${
                  result.column + 1
                }. A legal fallback column was played.`
          );
          setLastAiInteraction(interaction);
          setGameState((prev) =>
            prev.turn === currentTurn &&
            isConnectFourActiveStatus(prev.status) &&
            isLegalColumn(prev, column)
              ? applyDiscWithInteraction(prev, column, Date.now(), interaction)
              : prev
          );
          return;
        }

        const fallbackColumn =
          gameMode === "aivai" && !isNonrecoverableAIError(result.error)
            ? chooseFallbackConnectFourColumn(requestState)
            : null;

        if (fallbackColumn !== null) {
          const interaction = createFallbackInteraction(currentTurn, result.error);
          setAiWarning(
            `${playerLabel(currentTurn)} AI hit a recoverable error. A legal fallback column was played so the AI vs AI match can continue.`
          );
          setAiError(null);
          setLastAiInteraction(interaction);
          setGameState((prev) =>
            prev.turn === currentTurn &&
            isConnectFourActiveStatus(prev.status) &&
            isLegalColumn(prev, fallbackColumn)
            ? applyDiscWithInteraction(
                prev,
                fallbackColumn,
                Date.now(),
                interaction
              )
              : prev
          );
        } else {
          setAiWarning(null);
          setAiError(result.error);
        }
      } catch (error) {
        if (!isCurrentAIRequest()) return;
        setAiWarning(null);
        setAiError(error instanceof Error ? error.message : "AI move failed.");
      } finally {
        if (isCurrentAIRequest()) {
          setAiThinking(false);
          aiRequestActiveRef.current = false;
          activeAIAbortControllerRef.current = null;
        }
      }
    }

    void makeAIMove();
    return () => {
      if (activeAIAbortControllerRef.current === abortController) {
        abortController.abort();
        activeAIAbortControllerRef.current = null;
      }
      aiRequestActiveRef.current = false;
    };
  }, [
    activeGame,
    currentPlayerIsAI,
    gameMode,
    gameStarted,
    gameState,
    isPaused,
    isReplayReviewing,
    redAI,
    yellowAI,
  ]);

  useEffect(() => {
    return () => {
      activeAIAbortControllerRef.current?.abort();
      void flushLatestActiveSession();
    };
  }, [flushLatestActiveSession]);

  const applySnapshot = useCallback(
    (snapshot: ConnectFourSessionSnapshot, createdAt: string | null = null) => {
      invalidateAIRequests();
      invalidatePersistence();
      setGameMode(snapshot.gameMode);
      setHumanPlayer(snapshot.humanPlayer);
      setRedAI(snapshot.redAI);
      setYellowAI(snapshot.yellowAI);
      setGameState(snapshot.gameState);
      setIsPaused(snapshot.isPaused || snapshot.gameState.status === "paused");
      setLastAiInteraction(snapshot.lastAiInteraction);
      setAiWarning(snapshot.aiWarning);
      setAiError(snapshot.aiError);
      setAiThinking(false);
      setReplayIndex(null);
      setPreviewColumn(null);
      setRestoreSnapshot(null);
      setRestoreCreatedAt(null);
      activeSessionCreatedAtRef.current = createdAt;
      setGameStarted(true);
    },
    [invalidateAIRequests, invalidatePersistence]
  );

  const handleStartGame = useCallback(() => {
    invalidateAIRequests();
    invalidatePersistence();
    setGameState(createInitialConnectFourState());
    setIsPaused(false);
    setAiThinking(false);
    setAiError(null);
    setAiWarning(null);
    setLastAiInteraction(null);
    setReplayIndex(null);
    setPreviewColumn(null);
    setRestoreSnapshot(null);
    setRestoreCreatedAt(null);
    activeSessionCreatedAtRef.current = null;
    setGameStarted(true);
  }, [invalidateAIRequests, invalidatePersistence]);

  const handleStartNew = useCallback(async () => {
    await deleteActiveSession();
    handleStartGame();
  }, [deleteActiveSession, handleStartGame]);

  const handleResumeSavedGame = useCallback(() => {
    if (!restoreSnapshot) return;
    applySnapshot(restoreSnapshot, restoreCreatedAt);
  }, [applySnapshot, restoreCreatedAt, restoreSnapshot]);

  const handleImport = useCallback(
    (snapshot: ConnectFourSessionSnapshot) => {
      applySnapshot(snapshot, null);
    },
    [applySnapshot]
  );

  const confirmImportOverwrite = useCallback(() => {
    if (!gameStarted) return true;
    return window.confirm(
      "Importing a Connect Four game will replace the current board. Continue?"
    );
  }, [gameStarted]);

  const handleColumnClick = useCallback(
    (column: number) => {
      if (
        !gameStarted ||
        isPaused ||
        isReplayReviewing ||
        aiThinking ||
        !activeGame ||
        currentPlayerIsAI ||
        !isLegalColumn(gameState, column)
      ) {
        return;
      }

      setGameState((prev) =>
        isLegalColumn(prev, column) ? dropDisc(prev, column, Date.now()) : prev
      );
      setAiWarning(null);
      setAiError(null);
      setPreviewColumn(null);
    },
    [
      activeGame,
      aiThinking,
      currentPlayerIsAI,
      gameStarted,
      gameState,
      isPaused,
      isReplayReviewing,
    ]
  );

  const handlePause = useCallback(() => {
    invalidateAIRequests();
    setGameState((prev) => setConnectFourPaused(prev, true));
    setIsPaused(true);
  }, [invalidateAIRequests]);

  const handleResume = useCallback(() => {
    setGameState((prev) => setConnectFourPaused(prev, false));
    setIsPaused(false);
  }, []);

  const handleReset = useCallback(async () => {
    await deleteActiveSession();
    handleStartGame();
  }, [deleteActiveSession, handleStartGame]);

  const handleBackToGames = useCallback(() => {
    if (!onBackToGames) return;
    void flushLatestActiveSession().finally(onBackToGames);
  }, [flushLatestActiveSession, onBackToGames]);

  const handleReplayStart = useCallback(() => {
    if (moveCount > 0) {
      invalidateAIRequests();
      setReplayIndex(-1);
    }
  }, [invalidateAIRequests, moveCount]);

  const handleReplayPrevious = useCallback(() => {
    setReplayIndex((current) => {
      if (current === null) return moveCount > 0 ? moveCount - 1 : null;
      return Math.max(-1, current - 1);
    });
  }, [moveCount]);

  const handleReplayNext = useCallback(() => {
    setReplayIndex((current) => {
      if (current === null) return null;
      const next = current + 1;
      return next >= moveCount ? null : next;
    });
  }, [moveCount]);

  const handleReplayExit = useCallback(() => {
    setReplayIndex(null);
  }, []);

  const redIsAI = isAIControlledPlayer(gameMode, humanPlayer, "red");
  const yellowIsAI = isAIControlledPlayer(gameMode, humanPlayer, "yellow");
  const canBoardInteract =
    gameStarted &&
    !isPaused &&
    !isReplayReviewing &&
    !aiThinking &&
    activeGame &&
    !currentPlayerIsAI;
  const statusMessage =
    gameState.status === "win"
      ? `${playerLabel(gameState.winner ?? "red")} wins`
      : gameState.status === "draw"
        ? "Draw"
        : isPaused
          ? "Paused"
          : currentPlayerIsAI
            ? `${playerLabel(gameState.turn)} AI thinking`
            : `${playerLabel(gameState.turn)} to move`;

  if (!gameStarted) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-red-50 via-yellow-50 to-slate-50 text-slate-950 dark:from-slate-950 dark:via-red-950/30 dark:to-slate-900 dark:text-white">
        <main className="mx-auto flex min-h-screen w-full max-w-5xl flex-col justify-center px-4 py-10 sm:px-6">
          {onBackToGames && (
            <button
              type="button"
              onClick={handleBackToGames}
              className="mb-5 inline-flex w-fit items-center gap-2 rounded-md border border-slate-300 bg-white/80 px-3 py-2 text-sm font-semibold text-slate-700 shadow-sm transition hover:bg-white dark:border-slate-700 dark:bg-slate-900/70 dark:text-slate-200 dark:hover:bg-slate-900"
            >
              <ArrowLeft className="h-4 w-4" aria-hidden="true" />
              Back to games
            </button>
          )}
          <ConnectFourSetup
            gameMode={gameMode}
            humanPlayer={humanPlayer}
            redAI={redAI}
            yellowAI={yellowAI}
            models={availableModels}
            restoreMoves={restoreSnapshot?.gameState.moveHistory.length ?? null}
            onModeChange={setGameMode}
            onHumanPlayerChange={setHumanPlayer}
            onRedAIChange={setRedAI}
            onYellowAIChange={setYellowAI}
            onStart={handleStartGame}
            onResume={handleResumeSavedGame}
            onStartNew={handleStartNew}
            onImport={handleImport}
          />
        </main>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-100 via-red-50 to-amber-50 text-slate-950 dark:from-slate-950 dark:via-slate-900 dark:to-red-950/30 dark:text-white">
      <main className="mx-auto w-full max-w-7xl px-4 py-6 sm:px-6">
        <header className="mb-6 text-center">
          {onBackToGames && (
            <button
              type="button"
              onClick={handleBackToGames}
              className="mb-4 inline-flex items-center gap-2 rounded-md border border-slate-300 bg-white/80 px-3 py-2 text-sm font-semibold text-slate-700 shadow-sm transition hover:bg-white dark:border-slate-700 dark:bg-slate-900/70 dark:text-slate-200 dark:hover:bg-slate-900"
            >
              <ArrowLeft className="h-4 w-4" aria-hidden="true" />
              Back to games
            </button>
          )}
          <p className="text-sm font-semibold uppercase tracking-wide text-red-600 dark:text-red-300">
            Connect Four
          </p>
          <h1 className="mt-2 text-3xl font-bold">Connect Four</h1>
          <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
            {gameMode === "pvp" && "Player vs Player"}
            {gameMode === "pvai" &&
              `${playerLabel(humanPlayer)} Player vs ${playerLabel(
                humanPlayer === "red" ? "yellow" : "red"
              )} AI`}
            {gameMode === "aivai" && "AI vs AI"}
          </p>
        </header>

        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_24rem]">
          <section className="flex min-w-0 flex-col items-center gap-3">
            <ConnectFourPlayerPanel
              player="red"
              label="Red"
              kind={redIsAI ? "ai" : "human"}
              modelLabel={
                redIsAI ? modelLabel(availableModels, redAI.modelId) : undefined
              }
              reasoningLabel={
                redIsAI ? compactReasoningLabel(redAI) : undefined
              }
              active={displayActiveGame && displayState.turn === "red"}
              winner={displayState.winner === "red"}
            />

            <ConnectFourBoard
              state={displayState}
              interactive={canBoardInteract}
              onColumnClick={handleColumnClick}
              previewColumn={previewColumn}
              onPreviewColumn={setPreviewColumn}
            />

            <ConnectFourPlayerPanel
              player="yellow"
              label="Yellow"
              kind={yellowIsAI ? "ai" : "human"}
              modelLabel={
                yellowIsAI ? modelLabel(availableModels, yellowAI.modelId) : undefined
              }
              reasoningLabel={
                yellowIsAI ? compactReasoningLabel(yellowAI) : undefined
              }
              active={displayActiveGame && displayState.turn === "yellow"}
              winner={displayState.winner === "yellow"}
            />
          </section>

          <aside className="space-y-4">
            <section
              className="rounded-xl border border-slate-200 bg-white p-4 text-center shadow-sm dark:border-slate-800 dark:bg-slate-950"
              data-testid="connect-four-status"
            >
              <div className="text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
                Status
              </div>
              <div
                className={cn(
                  "mt-1 text-lg font-bold",
                  gameState.winner === "red" && "text-red-600 dark:text-red-300",
                  gameState.winner === "yellow" &&
                    "text-yellow-600 dark:text-yellow-300"
                )}
              >
                {statusMessage}
              </div>
            </section>

            {aiThinking && (
              <div
                className="flex items-center gap-3 rounded-xl border border-sky-200 bg-sky-50 p-4 text-sky-800 shadow-sm dark:border-sky-800 dark:bg-sky-950/35 dark:text-sky-200"
                data-testid="connect-four-ai-thinking"
              >
                <span
                  className="h-5 w-5 animate-spin rounded-full border-2 border-sky-500 border-t-transparent"
                  aria-hidden="true"
                />
                <span className="text-sm font-semibold">AI is thinking...</span>
              </div>
            )}

            {aiWarning && (
              <div
                className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-amber-800 shadow-sm dark:border-amber-800 dark:bg-amber-950/35 dark:text-amber-200"
                data-testid="connect-four-ai-warning"
              >
                <div className="text-sm font-semibold">AI fallback move</div>
                <p className="mt-1 text-sm">{aiWarning}</p>
              </div>
            )}

            {aiError && (
              <div
                className="rounded-xl border border-red-200 bg-red-50 p-4 text-red-700 shadow-sm dark:border-red-900 dark:bg-red-950/35 dark:text-red-300"
                data-testid="connect-four-ai-error"
              >
                <div className="text-sm font-semibold">AI error</div>
                <p className="mt-1 text-sm">{aiError}</p>
              </div>
            )}

            <GameAIPresence interaction={lastAiInteraction} />

            <ConnectFourControls
              status={gameState.status}
              isPaused={isPaused}
              isReplayReviewing={isReplayReviewing}
              canReplay={moveCount > 0}
              onReset={handleReset}
              onPause={handlePause}
              onResume={handleResume}
              onReplayStart={handleReplayStart}
              onReplayPrevious={handleReplayPrevious}
              onReplayNext={handleReplayNext}
              onReplayExit={handleReplayExit}
              canReplayPrevious={replayIndex !== null && replayIndex > -1}
              canReplayNext={replayIndex !== null}
            />

            <div className="grid grid-cols-2 gap-3">
              <ConnectFourExportMenu state={gameState} snapshot={exportSnapshot} />
              <ConnectFourImportMenu
                onImport={handleImport}
                onBeforeImport={confirmImportOverwrite}
              />
            </div>

            <ConnectFourMoveHistory
              moveHistory={gameState.moveHistory}
              activeIndex={
                replayIndex === null || replayIndex < 0 ? undefined : replayIndex
              }
            />
          </aside>
        </div>
      </main>
    </div>
  );
}

export default ConnectFourGameClient;
