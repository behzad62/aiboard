"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, Copy } from "lucide-react";
import type {
  GameAIConfigValue,
  GameAIModelOption,
} from "@/components/games/GameAIConfigPanel";
import {
  QuoridorBoard,
  type QuoridorActionMode,
} from "@/components/games/quoridor/QuoridorBoard";
import { QuoridorControls } from "@/components/games/quoridor/QuoridorControls";
import { QuoridorExportMenu } from "@/components/games/quoridor/QuoridorExportMenu";
import { QuoridorImportMenu } from "@/components/games/quoridor/QuoridorImportMenu";
import { QuoridorMoveHistory } from "@/components/games/quoridor/QuoridorMoveHistory";
import { QuoridorPlayerPanel } from "@/components/games/quoridor/QuoridorPlayerPanel";
import { QuoridorSetup } from "@/components/games/quoridor/QuoridorSetup";
import {
  chooseFallbackQuoridorAction,
  getAvailableQuoridorModels,
  getQuoridorModelApiKey,
  getQuoridorModelBaseURL,
  getQuoridorModelRunnerToken,
  requestQuoridorAIMove,
  type QuoridorAIDiagnosticAttempt,
} from "@/lib/games/quoridor/ai";
import { isNonrecoverableGameAIError } from "@/lib/games/core/ai-errors";
import {
  applyQuoridorAction,
  createInitialQuoridorState,
  formatQuoridorAction,
  isLegalAction,
  setQuoridorPaused,
} from "@/lib/games/quoridor/engine";
import {
  QUORIDOR_ACTIVE_SESSION_ID,
  createQuoridorSessionRecord,
  isQuoridorActiveStatus,
  parseQuoridorSessionRecord,
  type QuoridorSessionSnapshot,
} from "@/lib/games/quoridor/session";
import type {
  QuoridorAction,
  QuoridorClockState,
  QuoridorGameMode,
  QuoridorGameState,
  QuoridorPlayer,
  QuoridorWallOrientation,
} from "@/lib/games/quoridor/types";
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
  reasoningEffort: "none",
};

function playerLabel(player: QuoridorPlayer): string {
  return player === "south" ? "South" : "North";
}

function compactReasoningLabel(config: AIConfig): string {
  switch (config.reasoningEffort) {
    case "none":
      return "Off";
    case "default":
      return "Default";
    case "low":
      return "Low";
    case "medium":
      return "Medium";
    case "high":
      return "High";
    case "max":
      return "Max";
    default:
      return "Off";
  }
}

function formatAIDiagnostics(
  diagnostics: QuoridorAIDiagnosticAttempt[]
): string {
  return diagnostics
    .map((attempt) => {
      const lines = [
        `Attempt ${attempt.attempt} (${attempt.type})`,
        `Message: ${attempt.message}`,
        `Legal actions: ${attempt.legalActions.join(", ")}`,
      ];

      if (attempt.rejectedAction !== undefined) {
        lines.push(`Rejected action: ${attempt.rejectedAction}`);
      }

      lines.push(
        "Raw response:",
        attempt.rawResponse?.trim() ? attempt.rawResponse : "(no response text)"
      );

      return lines.join("\n");
    })
    .join("\n\n---\n\n");
}

function isAIControlledPlayer(
  mode: QuoridorGameMode,
  humanPlayer: QuoridorPlayer,
  player: QuoridorPlayer
): boolean {
  if (mode === "aivai") return true;
  if (mode === "pvai") return player !== humanPlayer;
  return false;
}

function shouldPersistQuoridorSnapshot(
  snapshot: QuoridorSessionSnapshot
): boolean {
  return snapshot.isPaused || isQuoridorActiveStatus(snapshot.gameState.status);
}

function createFallbackInteraction(
  player: QuoridorPlayer,
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
  state: QuoridorGameState,
  interaction: GameAIInteraction | null
): QuoridorGameState {
  if (!interaction || state.moveHistory.length === 0) return state;

  const moveHistory = state.moveHistory.map((record, index) =>
    index === state.moveHistory.length - 1
      ? { ...record, aiInteraction: interaction }
      : record
  );

  return { ...state, moveHistory };
}

function applyActionWithInteraction(
  state: QuoridorGameState,
  action: QuoridorAction,
  timestamp: number,
  interaction: GameAIInteraction | null = null
): QuoridorGameState {
  return attachAIInteractionToLatestMove(
    applyQuoridorAction(state, action, timestamp),
    interaction
  );
}

function createReplayState(
  liveState: QuoridorGameState,
  replayIndex: number | null
): QuoridorGameState {
  if (replayIndex === null) return liveState;
  if (replayIndex < 0) {
    return {
      ...createInitialQuoridorState(),
      clock: {
        southElapsedMs: 0,
        northElapsedMs: 0,
        turnStartedAt: null,
      },
      moveHistory: liveState.moveHistory,
    };
  }

  const record = liveState.moveHistory[replayIndex];
  if (!record) return liveState;

  const nextTurn: QuoridorPlayer =
    record.player === "south" ? "north" : "south";

  return {
    ...record.snapshotAfter,
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
    clock: liveState.clock,
  };
}

function displayClockForState(
  state: QuoridorGameState,
  now: number
): QuoridorClockState {
  if (state.status !== "playing" || state.clock.turnStartedAt === null) {
    return state.clock;
  }

  const delta = Math.max(0, now - state.clock.turnStartedAt);
  return state.turn === "south"
    ? {
        ...state.clock,
        southElapsedMs: state.clock.southElapsedMs + delta,
      }
    : {
        ...state.clock,
        northElapsedMs: state.clock.northElapsedMs + delta,
      };
}

function elapsedForPlayer(
  clock: QuoridorClockState,
  player: QuoridorPlayer
): number {
  return player === "south" ? clock.southElapsedMs : clock.northElapsedMs;
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

export function QuoridorGameClient({
  onBackToGames,
}: {
  onBackToGames?: () => void;
}) {
  const [gameStarted, setGameStarted] = useState(false);
  const [gameMode, setGameMode] = useState<QuoridorGameMode>("pvp");
  const [humanPlayer, setHumanPlayer] = useState<QuoridorPlayer>("south");
  const [southAI, setSouthAI] = useState<AIConfig>(EMPTY_AI_CONFIG);
  const [northAI, setNorthAI] = useState<AIConfig>(EMPTY_AI_CONFIG);
  const [availableModels, setAvailableModels] = useState<GameAIModelOption[]>(
    []
  );
  const [gameState, setGameState] = useState<QuoridorGameState>(() =>
    createInitialQuoridorState()
  );
  const [isPaused, setIsPaused] = useState(false);
  const [aiThinking, setAiThinking] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);
  const [aiWarning, setAiWarning] = useState<string | null>(null);
  const [aiDiagnostics, setAiDiagnostics] = useState<
    QuoridorAIDiagnosticAttempt[]
  >([]);
  const [aiDiagnosticsCopied, setAiDiagnosticsCopied] = useState(false);
  const [lastAiInteraction, setLastAiInteraction] =
    useState<GameAIInteraction | null>(null);
  const [restoreSnapshot, setRestoreSnapshot] =
    useState<QuoridorSessionSnapshot | null>(null);
  const [restoreCreatedAt, setRestoreCreatedAt] = useState<string | null>(null);
  const [replayIndex, setReplayIndex] = useState<number | null>(null);
  const [actionMode, setActionMode] = useState<QuoridorActionMode>("move");
  const [wallOrientation, setWallOrientation] =
    useState<QuoridorWallOrientation>("H");
  const [clockNow, setClockNow] = useState(() => Date.now());

  const aiRequestVersionRef = useRef(0);
  const activeAIAbortControllerRef = useRef<AbortController | null>(null);
  const aiRequestActiveRef = useRef(false);
  const latestSnapshotRef = useRef<QuoridorSessionSnapshot | null>(null);
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
  const displayedClock = useMemo(
    () =>
      isReplayReviewing
        ? displayState.clock
        : displayClockForState(gameState, clockNow),
    [clockNow, displayState.clock, gameState, isReplayReviewing]
  );
  const activeGame = isQuoridorActiveStatus(gameState.status);
  canPersistActiveSessionRef.current = gameStarted && (isPaused || activeGame);
  const displayActiveGame = isQuoridorActiveStatus(displayState.status);
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
      southAI,
      northAI,
      isPaused,
      lastAiInteraction,
      aiWarning,
      aiError,
      aiDiagnostics,
    }),
    [
      gameState,
      gameMode,
      humanPlayer,
      southAI,
      northAI,
      isPaused,
      lastAiInteraction,
      aiWarning,
      aiError,
      aiDiagnostics,
    ]
  );
  const aiDiagnosticsText = useMemo(
    () => formatAIDiagnostics(aiDiagnostics),
    [aiDiagnostics]
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
    if (!shouldPersistQuoridorSnapshot(snapshot)) return;

    const now = new Date(Date.now()).toISOString();
    const createdAt = activeSessionCreatedAtRef.current ?? now;

    try {
      await saveGameSession(
        createQuoridorSessionRecord(snapshot, now, createdAt)
      );
      if (token === persistenceTokenRef.current) {
        activeSessionCreatedAtRef.current = createdAt;
      }
    } catch (error) {
      console.warn("Failed to autosave Quoridor session:", error);
    }
  }, []);

  const flushLatestActiveSession = useCallback(async () => {
    const snapshot = latestSnapshotRef.current;
    if (
      !snapshot ||
      !canPersistActiveSessionRef.current ||
      !shouldPersistQuoridorSnapshot(snapshot)
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
          await deleteGameSession(QUORIDOR_ACTIVE_SESSION_ID);
        } catch (error) {
          if (token === persistenceTokenRef.current) {
            console.warn("Failed to delete active Quoridor session:", error);
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
      const models = getAvailableQuoridorModels();
      setAvailableModels(models);
      setSouthAI((prev) => normalizeAIConfig(prev, models));
      setNorthAI((prev) => normalizeAIConfig(prev, models));
    } catch (error) {
      console.warn("Failed to load Quoridor models:", error);
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
            session.id === QUORIDOR_ACTIVE_SESSION_ID &&
            session.gameId === "quoridor" &&
            session.status !== "complete" &&
            session.status !== "abandoned"
        );
        const snapshot = record ? parseQuoridorSessionRecord(record) : null;
        const restorable =
          snapshot &&
          (snapshot.isPaused ||
            isQuoridorActiveStatus(snapshot.gameState.status));

        setRestoreSnapshot(restorable ? snapshot : null);
        setRestoreCreatedAt(restorable && record ? record.createdAt : null);
      } catch (error) {
        if (!cancelled) {
          console.warn("Failed to restore Quoridor session:", error);
        }
      }
    }

    void restoreSavedSession();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (
      !gameStarted ||
      (!isPaused && !isQuoridorActiveStatus(gameState.status))
    ) {
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
    if (!gameStarted || isQuoridorActiveStatus(gameState.status)) return;
    void deleteActiveSession();
  }, [deleteActiveSession, gameStarted, gameState.status]);

  useEffect(() => {
    if (
      !gameStarted ||
      isPaused ||
      isReplayReviewing ||
      gameState.status !== "playing"
    ) {
      return;
    }

    setClockNow(Date.now());
    const interval = window.setInterval(() => setClockNow(Date.now()), 500);
    return () => window.clearInterval(interval);
  }, [gameStarted, gameState.status, isPaused, isReplayReviewing]);

  useEffect(() => {
    if (!gameStarted || isPaused || isReplayReviewing || !activeGame) return;
    if (!currentPlayerIsAI || aiRequestActiveRef.current) return;

    const config = gameState.turn === "south" ? southAI : northAI;
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
      setAiDiagnostics([]);
      setAiDiagnosticsCopied(false);

      try {
        const apiKey = getQuoridorModelApiKey(config.modelId) ?? "";
        const baseURL = getQuoridorModelBaseURL(config.modelId);
        const runnerToken = getQuoridorModelRunnerToken(config.modelId);
        const result = await requestQuoridorAIMove({
          state: requestState,
          modelId: config.modelId,
          reasoningEffort: config.reasoningEffort,
          apiKey,
          baseURL,
          runnerToken,
          signal: abortController.signal,
        });

        if (!isCurrentAIRequest()) return;

        if ("action" in result) {
          setAiDiagnostics([]);
          const legal = isLegalAction(requestState, result.action);
          const fallbackAction =
            legal || chooseFallbackQuoridorAction(requestState) === null
              ? null
              : chooseFallbackQuoridorAction(requestState);
          const action = legal ? result.action : fallbackAction;

          if (action === null) {
            setAiWarning(null);
            setAiError(
              `AI returned illegal action ${formatQuoridorAction(result.action)}.`
            );
            return;
          }

          const interaction = legal
            ? result.interaction
            : createFallbackInteraction(
                currentTurn,
                `AI returned illegal action ${formatQuoridorAction(result.action)}.`
              );

          setAiWarning(
            legal
              ? null
              : `${playerLabel(currentTurn)} AI returned illegal action ${formatQuoridorAction(
                  result.action
                )}. A legal fallback was played.`
          );
          setLastAiInteraction(interaction);
          setGameState((prev) =>
            prev.turn === currentTurn &&
            isQuoridorActiveStatus(prev.status) &&
            isLegalAction(prev, action)
              ? applyActionWithInteraction(prev, action, Date.now(), interaction)
              : prev
          );
          return;
        }

        const fallbackAction =
          gameMode === "aivai" && !isNonrecoverableGameAIError(result.error)
            ? chooseFallbackQuoridorAction(requestState)
            : null;

        if (fallbackAction !== null) {
          const interaction = createFallbackInteraction(
            currentTurn,
            result.error
          );
          setAiDiagnostics(result.diagnostics ?? []);
          setAiWarning(
            `${playerLabel(currentTurn)} AI hit a recoverable error. A legal fallback was played so the AI vs AI match can continue.`
          );
          setAiError(null);
          setLastAiInteraction(interaction);
          setGameState((prev) =>
            prev.turn === currentTurn &&
            isQuoridorActiveStatus(prev.status) &&
            isLegalAction(prev, fallbackAction)
              ? applyActionWithInteraction(
                  prev,
                  fallbackAction,
                  Date.now(),
                  interaction
                )
              : prev
          );
        } else {
          setAiDiagnostics(result.diagnostics ?? []);
          setAiWarning(null);
          setAiError(result.error);
        }
      } catch (error) {
        if (!isCurrentAIRequest()) return;
        setAiDiagnostics([]);
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
    northAI,
    southAI,
  ]);

  useEffect(() => {
    return () => {
      activeAIAbortControllerRef.current?.abort();
      void flushLatestActiveSession();
    };
  }, [flushLatestActiveSession]);

  const applySnapshot = useCallback(
    (snapshot: QuoridorSessionSnapshot, createdAt: string | null = null) => {
      invalidateAIRequests();
      invalidatePersistence();
      setGameMode(snapshot.gameMode);
      setHumanPlayer(snapshot.humanPlayer);
      setSouthAI(snapshot.southAI);
      setNorthAI(snapshot.northAI);
      setGameState(snapshot.gameState);
      setIsPaused(snapshot.isPaused || snapshot.gameState.status === "paused");
      setLastAiInteraction(snapshot.lastAiInteraction);
      setAiWarning(snapshot.aiWarning);
      setAiError(snapshot.aiError);
      setAiDiagnostics(snapshot.aiDiagnostics ?? []);
      setAiDiagnosticsCopied(false);
      setAiThinking(false);
      setReplayIndex(null);
      setActionMode("move");
      setClockNow(Date.now());
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
    setGameState(createInitialQuoridorState(Date.now()));
    setIsPaused(false);
    setAiThinking(false);
    setAiError(null);
    setAiWarning(null);
    setAiDiagnostics([]);
    setAiDiagnosticsCopied(false);
    setLastAiInteraction(null);
    setReplayIndex(null);
    setActionMode("move");
    setClockNow(Date.now());
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
    (snapshot: QuoridorSessionSnapshot) => {
      applySnapshot(snapshot, null);
    },
    [applySnapshot]
  );

  const confirmImportOverwrite = useCallback(() => {
    if (!gameStarted) return true;
    return window.confirm(
      "Importing a Quoridor game will replace the current board. Continue?"
    );
  }, [gameStarted]);

  const playAction = useCallback(
    (action: QuoridorAction) => {
      if (
        !gameStarted ||
        isPaused ||
        isReplayReviewing ||
        aiThinking ||
        !activeGame ||
        currentPlayerIsAI ||
        !isLegalAction(gameState, action)
      ) {
        return;
      }

      setGameState((prev) =>
        isLegalAction(prev, action)
          ? applyQuoridorAction(prev, action, Date.now())
          : prev
      );
      setAiWarning(null);
      setAiError(null);
      setAiDiagnostics([]);
      setAiDiagnosticsCopied(false);
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

  const handleMove = useCallback(
    (row: number, col: number) => {
      playAction({ type: "move", row, col });
    },
    [playAction]
  );

  const handlePlaceWall = useCallback(
    (row: number, col: number, orientation: QuoridorWallOrientation) => {
      playAction({ type: "wall", row, col, orientation });
    },
    [playAction]
  );

  const handlePause = useCallback(() => {
    invalidateAIRequests();
    setGameState((prev) => setQuoridorPaused(prev, true, Date.now()));
    setIsPaused(true);
  }, [invalidateAIRequests]);

  const handleResume = useCallback(() => {
    setGameState((prev) => setQuoridorPaused(prev, false, Date.now()));
    setClockNow(Date.now());
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

  const handleCopyAIDiagnostics = useCallback(async () => {
    if (!aiDiagnosticsText) return;

    try {
      await navigator.clipboard.writeText(aiDiagnosticsText);
      setAiDiagnosticsCopied(true);
      window.setTimeout(() => setAiDiagnosticsCopied(false), 1500);
    } catch {
      setAiDiagnosticsCopied(false);
    }
  }, [aiDiagnosticsText]);

  const southIsAI = isAIControlledPlayer(gameMode, humanPlayer, "south");
  const northIsAI = isAIControlledPlayer(gameMode, humanPlayer, "north");
  const canBoardInteract =
    gameStarted &&
    !isPaused &&
    !isReplayReviewing &&
    !aiThinking &&
    activeGame &&
    !currentPlayerIsAI;
  const statusMessage =
    gameState.status === "win"
      ? `${playerLabel(gameState.winner ?? "south")} wins`
      : isPaused
        ? "Paused"
        : currentPlayerIsAI
          ? `${playerLabel(gameState.turn)} is thinking`
          : `${playerLabel(gameState.turn)} to move`;

  if (!gameStarted) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-amber-50 via-orange-50 to-slate-50 text-slate-950 dark:from-slate-950 dark:via-amber-950/30 dark:to-slate-900 dark:text-white">
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
          <QuoridorSetup
            gameMode={gameMode}
            humanPlayer={humanPlayer}
            southAI={southAI}
            northAI={northAI}
            models={availableModels}
            restoreMoves={restoreSnapshot?.gameState.moveHistory.length ?? null}
            onModeChange={setGameMode}
            onHumanPlayerChange={setHumanPlayer}
            onSouthAIChange={setSouthAI}
            onNorthAIChange={setNorthAI}
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
    <div className="min-h-screen bg-gradient-to-br from-slate-100 via-amber-50 to-orange-50 text-slate-950 dark:from-slate-950 dark:via-slate-900 dark:to-amber-950/30 dark:text-white">
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
          <p className="text-sm font-semibold uppercase tracking-wide text-amber-700 dark:text-amber-300">
            Quoridor
          </p>
          <h1 className="mt-2 text-3xl font-bold">Quoridor</h1>
          <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
            {gameMode === "pvp" && "Player vs Player"}
            {gameMode === "pvai" &&
              `${playerLabel(humanPlayer)} Player vs ${playerLabel(
                humanPlayer === "south" ? "north" : "south"
              )} AI`}
            {gameMode === "aivai" && "AI vs AI"}
          </p>
        </header>

        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_24rem]">
          <section className="flex min-w-0 flex-col items-center gap-3">
            <QuoridorPlayerPanel
              player="north"
              label="North"
              kind={northIsAI ? "ai" : "human"}
              modelLabel={
                northIsAI
                  ? modelLabel(availableModels, northAI.modelId)
                  : undefined
              }
              reasoningLabel={
                northIsAI ? compactReasoningLabel(northAI) : undefined
              }
              active={displayActiveGame && displayState.turn === "north"}
              elapsedMs={elapsedForPlayer(displayedClock, "north")}
              wallsLeft={displayState.wallsLeft.north}
              winner={displayState.winner === "north"}
              aiInteraction={
                lastAiInteraction?.actorId === "north"
                  ? lastAiInteraction
                  : null
              }
              aiThinking={
                !isReplayReviewing &&
                aiThinking &&
                displayActiveGame &&
                displayState.turn === "north" &&
                northIsAI
              }
            />

            <QuoridorBoard
              state={displayState}
              interactive={canBoardInteract}
              actionMode={actionMode}
              wallOrientation={wallOrientation}
              onActionModeChange={setActionMode}
              onWallOrientationChange={setWallOrientation}
              onMove={handleMove}
              onPlaceWall={handlePlaceWall}
            />

            <QuoridorPlayerPanel
              player="south"
              label="South"
              kind={southIsAI ? "ai" : "human"}
              modelLabel={
                southIsAI
                  ? modelLabel(availableModels, southAI.modelId)
                  : undefined
              }
              reasoningLabel={
                southIsAI ? compactReasoningLabel(southAI) : undefined
              }
              active={displayActiveGame && displayState.turn === "south"}
              elapsedMs={elapsedForPlayer(displayedClock, "south")}
              wallsLeft={displayState.wallsLeft.south}
              winner={displayState.winner === "south"}
              aiInteraction={
                lastAiInteraction?.actorId === "south"
                  ? lastAiInteraction
                  : null
              }
              aiThinking={
                !isReplayReviewing &&
                aiThinking &&
                displayActiveGame &&
                displayState.turn === "south" &&
                southIsAI
              }
            />
          </section>

          <aside className="space-y-4">
            <section
              className="rounded-xl border border-slate-200 bg-white p-4 text-center shadow-sm dark:border-slate-800 dark:bg-slate-950"
              data-testid="quoridor-status"
            >
              <div className="text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
                Status
              </div>
              <div
                className={cn(
                  "mt-1 text-lg font-bold",
                  gameState.winner === "south" &&
                    "text-orange-700 dark:text-orange-300",
                  gameState.winner === "north" &&
                    "text-sky-700 dark:text-sky-300"
                )}
              >
                {statusMessage}
              </div>
            </section>

            {aiWarning && (
              <div
                className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-amber-800 shadow-sm dark:border-amber-800 dark:bg-amber-950/35 dark:text-amber-200"
                data-testid="quoridor-ai-warning"
              >
                <div className="text-sm font-semibold">AI fallback move</div>
                <p className="mt-1 text-sm">{aiWarning}</p>
              </div>
            )}

            {aiError && (
              <div
                className="rounded-xl border border-red-200 bg-red-50 p-4 text-red-700 shadow-sm dark:border-red-900 dark:bg-red-950/35 dark:text-red-300"
                data-testid="quoridor-ai-error"
              >
                <div className="text-sm font-semibold">AI error</div>
                <p className="mt-1 text-sm">{aiError}</p>
              </div>
            )}

            {aiDiagnostics.length > 0 && (
              <section
                className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-800 dark:bg-slate-950"
                data-testid="quoridor-ai-diagnostics"
              >
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <div className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                      Raw AI responses
                    </div>
                    <div className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
                      {aiDiagnostics.length} failed attempt
                      {aiDiagnostics.length === 1 ? "" : "s"}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={handleCopyAIDiagnostics}
                    className="inline-flex items-center gap-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs font-semibold text-slate-700 transition hover:bg-slate-100 active:scale-95 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800"
                    data-testid="quoridor-copy-ai-diagnostics"
                  >
                    <Copy className="h-3.5 w-3.5" aria-hidden="true" />
                    {aiDiagnosticsCopied ? "Copied" : "Copy"}
                  </button>
                </div>
                <details className="mt-3">
                  <summary className="cursor-pointer text-sm font-medium text-slate-700 dark:text-slate-300">
                    Details
                  </summary>
                  <pre className="mt-3 max-h-72 overflow-auto whitespace-pre-wrap rounded-lg bg-slate-950 p-3 text-xs leading-relaxed text-slate-100">
                    {aiDiagnosticsText}
                  </pre>
                </details>
              </section>
            )}

            <QuoridorControls
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
              <QuoridorExportMenu state={gameState} snapshot={exportSnapshot} />
              <QuoridorImportMenu
                onImport={handleImport}
                onBeforeImport={confirmImportOverwrite}
              />
            </div>

            <QuoridorMoveHistory
              moveHistory={gameState.moveHistory}
              activeIndex={
                replayIndex === null || replayIndex < 0
                  ? undefined
                  : replayIndex
              }
            />
          </aside>
        </div>
      </main>
    </div>
  );
}

export default QuoridorGameClient;
