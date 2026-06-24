"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, ClipboardCopy, Pause, Play, RotateCcw } from "lucide-react";
import { GameAIPresence } from "@/components/games/GameAIPresence";
import type {
  GameAIConfigValue,
  GameAIModelOption,
} from "@/components/games/GameAIConfigPanel";
import { CodenamesBoard } from "@/components/games/codenames/CodenamesBoard";
import { CodenamesCluePanel } from "@/components/games/codenames/CodenamesCluePanel";
import { CodenamesExportMenu } from "@/components/games/codenames/CodenamesExportMenu";
import { CodenamesHandoff } from "@/components/games/codenames/CodenamesHandoff";
import { CodenamesImportMenu } from "@/components/games/codenames/CodenamesImportMenu";
import { CodenamesMoveHistory } from "@/components/games/codenames/CodenamesMoveHistory";
import { CodenamesSetup } from "@/components/games/codenames/CodenamesSetup";
import { CodenamesTeamPanel } from "@/components/games/codenames/CodenamesTeamPanel";
import {
  modeLabel,
  roleLabel,
  teamLabel,
} from "@/components/games/codenames/view-helpers";
import {
  getCodenamesAIModels,
  getCodenamesModelApiKey,
  getCodenamesModelBaseURL,
  requestCodenamesGuesserMove,
  requestCodenamesSpymasterMove,
  type CodenamesAIDiagnosticAttempt,
} from "@/lib/games/codenames/ai";
import {
  createInitialCodenamesState,
  endCodenamesTurn,
  getCodenamesPublicBoard,
  getCodenamesSpymasterBoard,
  getRemainingCodenamesCards,
  isCodenamesActiveStatus,
  setCodenamesPaused,
  submitCodenamesClue,
  submitCodenamesGuess,
  validateCodenamesClue,
} from "@/lib/games/codenames/engine";
import {
  CODENAMES_ACTIVE_SESSION_ID,
  createCodenamesSessionRecord,
  parseCodenamesSessionRecord,
  type CodenamesPrivateView,
  type CodenamesSessionSnapshot,
} from "@/lib/games/codenames/session";
import type {
  CodenamesClue,
  CodenamesGameMode,
  CodenamesGameState,
  CodenamesPlayerRole,
  CodenamesTeam,
} from "@/lib/games/codenames/types";
import {
  deleteGameSession,
  listGameSessions,
  saveGameSession,
} from "@/lib/games/core/session-store";
import type { GameAIInteraction } from "@/lib/games/core/types";
import { cn } from "@/lib/utils";

type AIConfig = GameAIConfigValue;
type SeatKind = "human" | "ai";

const EMPTY_AI_CONFIG: AIConfig = {
  modelId: "",
  reasoningEffort: "default",
};

function normalizeAIConfig(
  config: AIConfig,
  models: GameAIModelOption[]
): AIConfig {
  if (config.modelId || models.length === 0) return config;
  return { ...config, modelId: models[0].modelId };
}

function samePrivateView(
  left: CodenamesPrivateView | null,
  right: CodenamesPrivateView | null
): boolean {
  return left?.team === right?.team && left?.role === right?.role;
}

function seatKind(
  mode: CodenamesGameMode,
  humanTeam: CodenamesTeam,
  team: CodenamesTeam
): SeatKind {
  if (mode === "aivai") return "ai";
  if (mode === "pvai" && team !== humanTeam) return "ai";
  return "human";
}

function requiredSeat(state: CodenamesGameState): CodenamesPrivateView | null {
  if (!isCodenamesActiveStatus(state.status)) return null;
  return {
    team: state.turnTeam,
    role: state.phase === "clue" ? "spymaster" : "operative",
  };
}

function modelLabel(models: GameAIModelOption[], modelId: string): string {
  return models.find((model) => model.modelId === modelId)?.displayName ?? modelId;
}

function actorId(team: CodenamesTeam, role: CodenamesPlayerRole): string {
  return `${team}-${role}`;
}

function attachAIInteractionToLatestMove(
  state: CodenamesGameState,
  interaction: GameAIInteraction | null
): CodenamesGameState {
  if (!interaction || state.moveHistory.length === 0) return state;
  return {
    ...state,
    moveHistory: state.moveHistory.map((move, index) =>
      index === state.moveHistory.length - 1
        ? { ...move, aiInteraction: interaction }
        : move
    ),
  };
}

function applyClueWithInteraction(
  state: CodenamesGameState,
  clue: CodenamesClue,
  timestamp: number,
  interaction: GameAIInteraction | null
): CodenamesGameState {
  return attachAIInteractionToLatestMove(
    submitCodenamesClue(state, clue, timestamp),
    interaction
  );
}

function applyGuessWithInteraction(
  state: CodenamesGameState,
  cardId: string,
  timestamp: number,
  interaction: GameAIInteraction | null
): CodenamesGameState {
  return attachAIInteractionToLatestMove(
    submitCodenamesGuess(state, cardId, timestamp),
    interaction
  );
}

function shouldPersistCodenamesSnapshot(snapshot: CodenamesSessionSnapshot): boolean {
  return snapshot.isPaused || isCodenamesActiveStatus(snapshot.gameState.status);
}

function createSnapshot(params: {
  gameState: CodenamesGameState;
  gameMode: CodenamesGameMode;
  humanTeam: CodenamesTeam;
  redSpymasterAI: AIConfig;
  redOperativeAI: AIConfig;
  blueSpymasterAI: AIConfig;
  blueOperativeAI: AIConfig;
  isPaused: boolean;
  currentPrivateView: CodenamesPrivateView | null;
  lastAiInteraction: GameAIInteraction | null;
  aiWarning: string | null;
  aiError: string | null;
  aiDiagnostics: CodenamesAIDiagnosticAttempt[];
}): CodenamesSessionSnapshot {
  return {
    gameState: params.gameState,
    gameMode: params.gameMode,
    humanTeam: params.humanTeam,
    redSpymasterAI: params.redSpymasterAI,
    redOperativeAI: params.redOperativeAI,
    blueSpymasterAI: params.blueSpymasterAI,
    blueOperativeAI: params.blueOperativeAI,
    isPaused: params.isPaused,
    currentPrivateView: params.currentPrivateView,
    lastAiInteraction: params.lastAiInteraction,
    aiWarning: params.aiWarning,
    aiError: params.aiError,
    ...(params.aiDiagnostics.length > 0
      ? { aiDiagnostics: params.aiDiagnostics }
      : {}),
  };
}

function formatAIDiagnostics(
  diagnostics: CodenamesAIDiagnosticAttempt[]
): string {
  return diagnostics
    .map((attempt) => {
      const lines = [
        `Attempt ${attempt.attempt} (${attempt.type})`,
        `Message: ${attempt.message}`,
        "Raw response:",
        attempt.rawResponse?.trim() ? attempt.rawResponse : "(no response text)",
      ];
      return lines.join("\n");
    })
    .join("\n\n---\n\n");
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

function fallbackInteraction(
  team: CodenamesTeam,
  role: CodenamesPlayerRole,
  error: string
): GameAIInteraction {
  return {
    actorId: actorId(team, role),
    gesture: "confused",
    utterance:
      role === "spymaster"
        ? "I had trouble with the clue, so a legal fallback was used."
        : "I had trouble guessing, so a legal fallback was used.",
    diagnostics: error,
  };
}

function chooseFallbackClue(state: CodenamesGameState): CodenamesClue | null {
  const count = getRemainingCodenamesCards(state, state.turnTeam) > 0 ? 1 : 0;
  for (const word of ["signal", "field", "link", "guide", "mark"]) {
    const validation = validateCodenamesClue(state, { word, count });
    if (validation.ok) return validation.clue;
  }
  return null;
}

function chooseFallbackGuess(state: CodenamesGameState): string | null {
  const own = state.cards.find(
    (card) => card.role === state.turnTeam && !card.revealed
  );
  if (own) return own.id;
  return state.cards.find((card) => !card.revealed)?.id ?? null;
}

export function CodenamesGameClient({
  onBackToGames,
}: {
  onBackToGames?: () => void;
}) {
  const [gameStarted, setGameStarted] = useState(false);
  const [gameMode, setGameMode] = useState<CodenamesGameMode>("pvp");
  const [humanTeam, setHumanTeam] = useState<CodenamesTeam>("red");
  const [redSpymasterAI, setRedSpymasterAI] = useState<AIConfig>(EMPTY_AI_CONFIG);
  const [redOperativeAI, setRedOperativeAI] = useState<AIConfig>(EMPTY_AI_CONFIG);
  const [blueSpymasterAI, setBlueSpymasterAI] =
    useState<AIConfig>(EMPTY_AI_CONFIG);
  const [blueOperativeAI, setBlueOperativeAI] =
    useState<AIConfig>(EMPTY_AI_CONFIG);
  const [availableModels, setAvailableModels] = useState<GameAIModelOption[]>([]);
  const [gameState, setGameState] = useState<CodenamesGameState>(() =>
    createInitialCodenamesState()
  );
  const [isPaused, setIsPaused] = useState(false);
  const [currentPrivateView, setCurrentPrivateView] =
    useState<CodenamesPrivateView | null>(null);
  const [aiThinking, setAiThinking] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);
  const [aiWarning, setAiWarning] = useState<string | null>(null);
  const [aiDiagnostics, setAiDiagnostics] = useState<
    CodenamesAIDiagnosticAttempt[]
  >([]);
  const [aiDiagnosticsCopied, setAiDiagnosticsCopied] = useState(false);
  const [lastAiInteraction, setLastAiInteraction] =
    useState<GameAIInteraction | null>(null);
  const [restoreSnapshot, setRestoreSnapshot] =
    useState<CodenamesSessionSnapshot | null>(null);
  const [restoreCreatedAt, setRestoreCreatedAt] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const activeAIAbortControllerRef = useRef<AbortController | null>(null);
  const aiRequestVersionRef = useRef(0);
  const aiRequestActiveRef = useRef(false);
  const latestSnapshotRef = useRef<CodenamesSessionSnapshot | null>(null);
  const activeSessionCreatedAtRef = useRef<string | null>(null);
  const autosaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const persistenceTokenRef = useRef(0);

  const activeGame = isCodenamesActiveStatus(gameState.status);
  const neededSeat = useMemo(() => requiredSeat(gameState), [gameState]);
  const neededSeatKind = neededSeat
    ? seatKind(gameMode, humanTeam, neededSeat.team)
    : "human";
  const showHandoff =
    gameStarted &&
    !isPaused &&
    neededSeat !== null &&
    neededSeatKind === "human" &&
    !samePrivateView(currentPrivateView, neededSeat);
  const currentSeatIsAI = neededSeat !== null && neededSeatKind === "ai";
  const canSeeSpymasterBoard =
    gameMode === "aivai" ||
    gameState.status === "win" ||
    currentPrivateView?.role === "spymaster";
  const boardCards = useMemo(
    () =>
      canSeeSpymasterBoard
        ? getCodenamesSpymasterBoard(gameState)
        : getCodenamesPublicBoard(gameState),
    [canSeeSpymasterBoard, gameState]
  );
  const canHumanAct =
    gameStarted &&
    activeGame &&
    !isPaused &&
    !showHandoff &&
    !aiThinking &&
    neededSeat !== null &&
    neededSeatKind === "human" &&
    samePrivateView(currentPrivateView, neededSeat);
  const exportSnapshot = useMemo(
    () =>
      createSnapshot({
        gameState,
        gameMode,
        humanTeam,
        redSpymasterAI,
        redOperativeAI,
        blueSpymasterAI,
        blueOperativeAI,
        isPaused,
        currentPrivateView,
        lastAiInteraction,
        aiWarning,
        aiError,
        aiDiagnostics,
      }),
    [
      aiDiagnostics,
      aiError,
      aiWarning,
      blueOperativeAI,
      blueSpymasterAI,
      currentPrivateView,
      gameMode,
      gameState,
      humanTeam,
      isPaused,
      lastAiInteraction,
      redOperativeAI,
      redSpymasterAI,
    ]
  );
  const aiDiagnosticsText = useMemo(
    () => formatAIDiagnostics(aiDiagnostics),
    [aiDiagnostics]
  );
  const canShowAIDiagnostics =
    aiDiagnostics.length > 0 &&
    (gameMode === "aivai" ||
      gameState.status === "win" ||
      currentPrivateView?.role === "spymaster");
  const canExportFullSnapshot = gameState.status === "win" || gameMode === "aivai";
  const visibleAiInteraction =
    activeGame &&
    lastAiInteraction?.actorId.endsWith("-spymaster") &&
    gameMode !== "aivai" &&
    currentPrivateView?.role !== "spymaster"
      ? null
      : lastAiInteraction;

  const invalidateAIRequests = useCallback(() => {
    aiRequestVersionRef.current += 1;
    activeAIAbortControllerRef.current?.abort();
    activeAIAbortControllerRef.current = null;
    aiRequestActiveRef.current = false;
    setAiThinking(false);
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
    const snapshot = latestSnapshotRef.current;
    if (!snapshot || !shouldPersistCodenamesSnapshot(snapshot)) return;

    const now = new Date(Date.now()).toISOString();
    const createdAt = activeSessionCreatedAtRef.current ?? now;
    try {
      await saveGameSession(createCodenamesSessionRecord(snapshot, now, createdAt));
      if (token === persistenceTokenRef.current) {
        activeSessionCreatedAtRef.current = createdAt;
      }
    } catch (error) {
      console.warn("Failed to autosave Codenames session:", error);
    }
  }, []);

  const flushLatestActiveSession = useCallback(async () => {
    const snapshot = latestSnapshotRef.current;
    if (!snapshot || !shouldPersistCodenamesSnapshot(snapshot)) {
      clearAutosaveTimer();
      return;
    }
    const token = persistenceTokenRef.current;
    clearAutosaveTimer();
    await saveLatestSession(token);
  }, [clearAutosaveTimer, saveLatestSession]);

  const deleteActiveSession = useCallback(async () => {
    invalidatePersistence();
    clearAutosaveTimer();
    latestSnapshotRef.current = null;
    activeSessionCreatedAtRef.current = null;
    setRestoreSnapshot(null);
    setRestoreCreatedAt(null);
    try {
      await deleteGameSession(CODENAMES_ACTIVE_SESSION_ID);
    } catch (error) {
      console.warn("Failed to delete active Codenames session:", error);
    }
  }, [clearAutosaveTimer, invalidatePersistence]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      const models = getCodenamesAIModels();
      setAvailableModels(models);
      setRedSpymasterAI((prev) => normalizeAIConfig(prev, models));
      setRedOperativeAI((prev) => normalizeAIConfig(prev, models));
      setBlueSpymasterAI((prev) => normalizeAIConfig(prev, models));
      setBlueOperativeAI((prev) => normalizeAIConfig(prev, models));
    } catch (error) {
      console.warn("Failed to load Codenames models:", error);
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
            session.id === CODENAMES_ACTIVE_SESSION_ID &&
            session.gameId === "codenames" &&
            session.status !== "complete" &&
            session.status !== "abandoned"
        );
        const snapshot = record ? parseCodenamesSessionRecord(record) : null;
        const restorable =
          snapshot &&
          (snapshot.isPaused || isCodenamesActiveStatus(snapshot.gameState.status));
        setRestoreSnapshot(restorable ? snapshot : null);
        setRestoreCreatedAt(restorable && record ? record.createdAt : null);
      } catch (error) {
        if (!cancelled) console.warn("Failed to restore Codenames session:", error);
      }
    }

    void restoreSavedSession();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!gameStarted || (!isPaused && !isCodenamesActiveStatus(gameState.status))) {
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
    if (!gameStarted || isCodenamesActiveStatus(gameState.status)) return;
    void deleteActiveSession();
  }, [deleteActiveSession, gameStarted, gameState.status]);

  const applySnapshot = useCallback(
    (snapshot: CodenamesSessionSnapshot, createdAt: string | null = null) => {
      invalidateAIRequests();
      invalidatePersistence();
      setGameMode(snapshot.gameMode);
      setHumanTeam(snapshot.humanTeam);
      setRedSpymasterAI(snapshot.redSpymasterAI);
      setRedOperativeAI(snapshot.redOperativeAI);
      setBlueSpymasterAI(snapshot.blueSpymasterAI);
      setBlueOperativeAI(snapshot.blueOperativeAI);
      setGameState(snapshot.gameState);
      setIsPaused(snapshot.isPaused || snapshot.gameState.status === "paused");
      setCurrentPrivateView(null);
      setLastAiInteraction(snapshot.lastAiInteraction);
      setAiWarning(snapshot.aiWarning);
      setAiError(snapshot.aiError);
      setAiDiagnostics(snapshot.aiDiagnostics ?? []);
      setAiDiagnosticsCopied(false);
      setActionError(null);
      activeSessionCreatedAtRef.current = createdAt;
      setRestoreSnapshot(null);
      setRestoreCreatedAt(null);
      setGameStarted(true);
    },
    [invalidateAIRequests, invalidatePersistence]
  );

  const handleStartGame = useCallback(() => {
    invalidateAIRequests();
    invalidatePersistence();
    setGameState(createInitialCodenamesState({ seed: String(Date.now()) }));
    setIsPaused(false);
    setCurrentPrivateView(null);
    setAiThinking(false);
    setAiError(null);
    setAiWarning(null);
    setAiDiagnostics([]);
    setAiDiagnosticsCopied(false);
    setLastAiInteraction(null);
    setActionError(null);
    activeSessionCreatedAtRef.current = null;
    setRestoreSnapshot(null);
    setRestoreCreatedAt(null);
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
    (snapshot: CodenamesSessionSnapshot) => {
      applySnapshot(snapshot, null);
    },
    [applySnapshot]
  );

  const confirmImportOverwrite = useCallback(() => {
    if (!gameStarted) return true;
    return window.confirm(
      "Importing a Codenames game will replace the current board. Continue?"
    );
  }, [gameStarted]);

  const handleSubmitClue = useCallback(
    (clue: CodenamesClue) => {
      if (!canHumanAct || gameState.phase !== "clue") return;
      try {
        setGameState((prev) => submitCodenamesClue(prev, clue, Date.now()));
        setCurrentPrivateView(null);
        setActionError(null);
      } catch (error) {
        setActionError(error instanceof Error ? error.message : "Could not submit clue.");
      }
    },
    [canHumanAct, gameState.phase]
  );

  const handleGuess = useCallback(
    (cardId: string) => {
      if (!canHumanAct || gameState.phase !== "guess") return;
      try {
        setGameState((prev) => submitCodenamesGuess(prev, cardId, Date.now()));
        setActionError(null);
      } catch (error) {
        setActionError(error instanceof Error ? error.message : "Could not guess card.");
      }
    },
    [canHumanAct, gameState.phase]
  );

  const handleEndTurn = useCallback(() => {
    if (!canHumanAct || gameState.phase !== "guess") return;
    try {
      setGameState((prev) => endCodenamesTurn(prev, Date.now()));
      setCurrentPrivateView(null);
      setActionError(null);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "Could not end turn.");
    }
  }, [canHumanAct, gameState.phase]);

  const handlePause = useCallback(() => {
    invalidateAIRequests();
    setGameState((prev) => setCodenamesPaused(prev, true));
    setIsPaused(true);
  }, [invalidateAIRequests]);

  const handleResume = useCallback(() => {
    setGameState((prev) => setCodenamesPaused(prev, false));
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

  useEffect(() => {
    if (
      !gameStarted ||
      isPaused ||
      showHandoff ||
      !activeGame ||
      !currentSeatIsAI ||
      !neededSeat ||
      aiError !== null ||
      aiRequestActiveRef.current
    ) {
      return;
    }

    const config =
      neededSeat.team === "red"
        ? neededSeat.role === "spymaster"
          ? redSpymasterAI
          : redOperativeAI
        : neededSeat.role === "spymaster"
          ? blueSpymasterAI
          : blueOperativeAI;
    if (!config.modelId) {
      setAiError(`${teamLabel(neededSeat.team)} ${roleLabel(neededSeat.role)} AI has no model selected.`);
      return;
    }

    const requestVersion = aiRequestVersionRef.current;
    const abortController = new AbortController();
    activeAIAbortControllerRef.current = abortController;
    const requestState = gameState;
    const seat = neededSeat;

    const isCurrentAIRequest = () =>
      aiRequestVersionRef.current === requestVersion &&
      activeAIAbortControllerRef.current === abortController &&
      !abortController.signal.aborted;

    async function makeAIMove() {
      aiRequestActiveRef.current = true;
      setAiThinking(true);
      setAiError(null);
      setAiWarning(null);
      setAiDiagnostics([]);
      setAiDiagnosticsCopied(false);

      try {
        const apiKey = getCodenamesModelApiKey(config.modelId) ?? "";
        const baseURL = getCodenamesModelBaseURL(config.modelId);

        if (seat.role === "spymaster") {
          const result = await requestCodenamesSpymasterMove({
            state: requestState,
            team: seat.team,
            modelId: config.modelId,
            reasoningEffort: config.reasoningEffort,
            apiKey,
            baseURL,
            signal: abortController.signal,
          });
          if (!isCurrentAIRequest()) return;

          if ("clue" in result) {
            setAiDiagnostics(result.diagnostics ?? []);
            setLastAiInteraction(result.interaction);
            setGameState((prev) =>
              prev === requestState
                ? applyClueWithInteraction(prev, result.clue, Date.now(), result.interaction)
                : prev
            );
            return;
          }

          const fallbackClue =
            gameMode === "aivai" && !isNonrecoverableAIError(result.error)
              ? chooseFallbackClue(requestState)
              : null;
          if (fallbackClue) {
            const interaction = fallbackInteraction(seat.team, seat.role, result.error);
            setAiDiagnostics(result.diagnostics ?? []);
            setAiWarning(
              `${teamLabel(seat.team)} spymaster AI hit a recoverable error. A legal fallback clue was used.`
            );
            setLastAiInteraction(interaction);
            setGameState((prev) =>
              prev === requestState
                ? applyClueWithInteraction(prev, fallbackClue, Date.now(), interaction)
                : prev
            );
          } else {
            setAiDiagnostics(result.diagnostics ?? []);
            setAiError(result.error);
          }
          return;
        }

        const result = await requestCodenamesGuesserMove({
          state: requestState,
          team: seat.team,
          modelId: config.modelId,
          reasoningEffort: config.reasoningEffort,
          apiKey,
          baseURL,
          signal: abortController.signal,
        });
        if (!isCurrentAIRequest()) return;

        if ("cardIds" in result) {
          setAiDiagnostics(result.diagnostics ?? []);
          setLastAiInteraction(result.interaction);
          setGameState((prev) => {
            if (prev !== requestState) return prev;
            let next = prev;
            for (const cardId of result.cardIds) {
              if (next.status !== "playing" || next.phase !== "guess") break;
              next = applyGuessWithInteraction(
                next,
                cardId,
                Date.now(),
                result.interaction
              );
            }
            return next;
          });
          return;
        }

        const fallbackCard =
          gameMode === "aivai" && !isNonrecoverableAIError(result.error)
            ? chooseFallbackGuess(requestState)
            : null;
        if (fallbackCard) {
          const interaction = fallbackInteraction(seat.team, seat.role, result.error);
          setAiDiagnostics(result.diagnostics ?? []);
          setAiWarning(
            `${teamLabel(seat.team)} operative AI hit a recoverable error. A legal fallback guess was used.`
          );
          setLastAiInteraction(interaction);
          setGameState((prev) =>
            prev === requestState
              ? applyGuessWithInteraction(prev, fallbackCard, Date.now(), interaction)
              : prev
          );
        } else {
          setAiDiagnostics(result.diagnostics ?? []);
          setAiError(result.error);
        }
      } catch (error) {
        if (!isCurrentAIRequest()) return;
        setAiDiagnostics([]);
        setAiError(error instanceof Error ? error.message : "Codenames AI move failed.");
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
    aiError,
    blueOperativeAI,
    blueSpymasterAI,
    currentSeatIsAI,
    gameMode,
    gameStarted,
    gameState,
    isPaused,
    neededSeat,
    redOperativeAI,
    redSpymasterAI,
    showHandoff,
  ]);

  useEffect(() => {
    return () => {
      activeAIAbortControllerRef.current?.abort();
      void flushLatestActiveSession();
    };
  }, [flushLatestActiveSession]);

  const redKind = seatKind(gameMode, humanTeam, "red");
  const blueKind = seatKind(gameMode, humanTeam, "blue");
  const redRemaining = getRemainingCodenamesCards(gameState, "red");
  const blueRemaining = getRemainingCodenamesCards(gameState, "blue");
  const statusMessage =
    gameState.status === "win"
      ? `${teamLabel(gameState.winner ?? "red")} wins`
      : isPaused || gameState.status === "paused"
        ? "Paused"
        : currentSeatIsAI
          ? `${teamLabel(gameState.turnTeam)} ${roleLabel(gameState.phase === "clue" ? "spymaster" : "operative")} AI thinking`
          : `${teamLabel(gameState.turnTeam)} ${gameState.phase === "clue" ? "spymaster clue" : "operatives guess"}`;

  if (!gameStarted) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-red-50 via-slate-50 to-blue-50 text-slate-950 dark:from-slate-950 dark:via-slate-900 dark:to-blue-950/30 dark:text-white">
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
          <CodenamesSetup
            gameMode={gameMode}
            humanTeam={humanTeam}
            redSpymasterAI={redSpymasterAI}
            redOperativeAI={redOperativeAI}
            blueSpymasterAI={blueSpymasterAI}
            blueOperativeAI={blueOperativeAI}
            models={availableModels}
            restoreMoves={restoreSnapshot?.gameState.moveHistory.length ?? null}
            onModeChange={setGameMode}
            onHumanTeamChange={setHumanTeam}
            onRedSpymasterAIChange={setRedSpymasterAI}
            onRedOperativeAIChange={setRedOperativeAI}
            onBlueSpymasterAIChange={setBlueSpymasterAI}
            onBlueOperativeAIChange={setBlueOperativeAI}
            onStart={handleStartGame}
            onResume={handleResumeSavedGame}
            onStartNew={handleStartNew}
          />
          <div className="mx-auto mt-4 w-full max-w-sm">
            <CodenamesImportMenu onImport={handleImport} />
          </div>
        </main>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-100 via-red-50 to-blue-50 text-slate-950 dark:from-slate-950 dark:via-slate-900 dark:to-blue-950/30 dark:text-white">
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
          <p className="text-sm font-semibold uppercase tracking-wide text-amber-600 dark:text-amber-300">
            Codenames
          </p>
          <h1 className="mt-2 text-3xl font-bold">Codenames</h1>
          <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
            {modeLabel(gameMode)}
          </p>
        </header>

        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_24rem]">
          {showHandoff && neededSeat ? (
            <CodenamesHandoff
              team={neededSeat.team}
              role={neededSeat.role}
              onShow={() => setCurrentPrivateView(neededSeat)}
            />
          ) : (
            <section className="space-y-4">
              <div className="grid gap-3 md:grid-cols-2">
                <CodenamesTeamPanel
                  team="red"
                  active={activeGame && gameState.turnTeam === "red"}
                  spymasterKind={redKind}
                  operativeKind={redKind}
                  remaining={redRemaining}
                  spymasterModelLabel={
                    redKind === "ai"
                      ? modelLabel(availableModels, redSpymasterAI.modelId)
                      : undefined
                  }
                  operativeModelLabel={
                    redKind === "ai"
                      ? modelLabel(availableModels, redOperativeAI.modelId)
                      : undefined
                  }
                  spymasterReasoning={redSpymasterAI.reasoningEffort}
                  operativeReasoning={redOperativeAI.reasoningEffort}
                  winner={gameState.winner === "red"}
                />
                <CodenamesTeamPanel
                  team="blue"
                  active={activeGame && gameState.turnTeam === "blue"}
                  spymasterKind={blueKind}
                  operativeKind={blueKind}
                  remaining={blueRemaining}
                  spymasterModelLabel={
                    blueKind === "ai"
                      ? modelLabel(availableModels, blueSpymasterAI.modelId)
                      : undefined
                  }
                  operativeModelLabel={
                    blueKind === "ai"
                      ? modelLabel(availableModels, blueOperativeAI.modelId)
                      : undefined
                  }
                  spymasterReasoning={blueSpymasterAI.reasoningEffort}
                  operativeReasoning={blueOperativeAI.reasoningEffort}
                  winner={gameState.winner === "blue"}
                />
              </div>
              <CodenamesBoard
                cards={boardCards}
                phase={gameState.phase}
                turnTeam={gameState.turnTeam}
                canGuess={canHumanAct && gameState.phase === "guess"}
                onGuess={handleGuess}
              />
            </section>
          )}

          <aside className="space-y-4">
            <section
              className="rounded-xl border border-slate-200 bg-white p-4 text-center shadow-sm dark:border-slate-800 dark:bg-slate-950"
              data-testid="codenames-status"
            >
              <div className="text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
                Status
              </div>
              <div
                className={cn(
                  "mt-1 text-lg font-bold",
                  gameState.winner === "red" && "text-red-600 dark:text-red-300",
                  gameState.winner === "blue" && "text-blue-600 dark:text-blue-300"
                )}
              >
                {statusMessage}
              </div>
              {currentPrivateView && (
                <div className="mt-2 text-xs text-slate-500 dark:text-slate-400">
                  View: {teamLabel(currentPrivateView.team)}{" "}
                  {roleLabel(currentPrivateView.role)}
                </div>
              )}
            </section>

            {aiThinking && (
              <div className="flex items-center gap-3 rounded-xl border border-sky-200 bg-sky-50 p-4 text-sky-800 shadow-sm dark:border-sky-800 dark:bg-sky-950/35 dark:text-sky-200">
                <span
                  className="h-5 w-5 animate-spin rounded-full border-2 border-sky-500 border-t-transparent"
                  aria-hidden="true"
                />
                <span className="text-sm font-semibold">AI is thinking...</span>
              </div>
            )}

            {(actionError || aiWarning || aiError) && (
              <div
                className={cn(
                  "rounded-xl border p-4 shadow-sm",
                  aiError || actionError
                    ? "border-red-200 bg-red-50 text-red-700 dark:border-red-900 dark:bg-red-950/35 dark:text-red-300"
                    : "border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-800 dark:bg-amber-950/35 dark:text-amber-200"
                )}
              >
                <div className="text-sm font-semibold">
                  {aiError ? "AI error" : actionError ? "Move error" : "AI fallback"}
                </div>
                <p className="mt-1 text-sm">{aiError ?? actionError ?? aiWarning}</p>
              </div>
            )}

            {aiDiagnostics.length > 0 && (
              <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-800 dark:bg-slate-950">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <div className="text-sm font-semibold">Raw AI responses</div>
                    <div className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
                      {canShowAIDiagnostics
                        ? `${aiDiagnostics.length} failed attempt${aiDiagnostics.length === 1 ? "" : "s"}`
                        : "Hidden in operative/public view"}
                    </div>
                  </div>
                  {canShowAIDiagnostics && (
                    <button
                      type="button"
                      onClick={handleCopyAIDiagnostics}
                      className="inline-flex items-center gap-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs font-semibold text-slate-700 transition hover:bg-slate-100 active:scale-95 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800"
                    >
                      <ClipboardCopy className="h-3.5 w-3.5" aria-hidden="true" />
                      {aiDiagnosticsCopied ? "Copied" : "Copy"}
                    </button>
                  )}
                </div>
                {canShowAIDiagnostics && (
                  <details className="mt-3">
                    <summary className="cursor-pointer text-sm font-medium text-slate-700 dark:text-slate-300">
                      Details
                    </summary>
                    <pre className="mt-3 max-h-72 overflow-auto whitespace-pre-wrap rounded-lg bg-slate-950 p-3 text-xs leading-relaxed text-slate-100">
                      {aiDiagnosticsText}
                    </pre>
                  </details>
                )}
              </section>
            )}

            <GameAIPresence interaction={visibleAiInteraction} />

            <CodenamesCluePanel
              phase={gameState.phase}
              turnTeam={gameState.turnTeam}
              activeClue={gameState.activeClue}
              guessesRemaining={gameState.guessesRemaining}
              guessesMade={gameState.guessesMadeForActiveClue}
              canGiveClue={canHumanAct && gameState.phase === "clue"}
              canEndTurn={canHumanAct && gameState.phase === "guess"}
              onSubmitClue={handleSubmitClue}
              onEndTurn={handleEndTurn}
            />

            <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-800 dark:bg-slate-950">
              <div className="flex justify-center">
                <span
                  className={cn(
                    "inline-flex items-center gap-2 rounded-full px-4 py-2 text-sm font-semibold",
                    activeGame
                      ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-300"
                      : "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300"
                  )}
                >
                  <span
                    className={cn(
                      "h-2 w-2 rounded-full",
                      activeGame ? "bg-emerald-500" : "bg-slate-400"
                    )}
                    aria-hidden="true"
                  />
                  {activeGame ? "Playing" : "Finished"}
                </span>
              </div>
              <div className="mt-4 grid grid-cols-2 gap-3">
                <button
                  type="button"
                  onClick={() => void handleReset()}
                  className="inline-flex items-center justify-center gap-2 rounded-lg border border-slate-200 bg-slate-50 px-4 py-2.5 text-sm font-semibold text-slate-700 transition hover:bg-slate-100 active:scale-95 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800"
                >
                  <RotateCcw className="h-4 w-4" aria-hidden="true" />
                  Reset
                </button>
                {isPaused ? (
                  <button
                    type="button"
                    onClick={handleResume}
                    className="inline-flex items-center justify-center gap-2 rounded-lg border border-emerald-300 bg-emerald-50 px-4 py-2.5 text-sm font-semibold text-emerald-700 transition hover:bg-emerald-100 active:scale-95 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300"
                  >
                    <Play className="h-4 w-4" aria-hidden="true" />
                    Resume
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={handlePause}
                    disabled={!activeGame}
                    className="inline-flex items-center justify-center gap-2 rounded-lg border border-orange-300 bg-orange-50 px-4 py-2.5 text-sm font-semibold text-orange-700 transition hover:bg-orange-100 active:scale-95 disabled:cursor-not-allowed disabled:opacity-50 dark:border-orange-800 dark:bg-orange-950/40 dark:text-orange-300"
                  >
                    <Pause className="h-4 w-4" aria-hidden="true" />
                    Pause
                  </button>
                )}
              </div>
            </section>

            <div className="grid grid-cols-2 gap-3">
              <CodenamesExportMenu
                state={gameState}
                snapshot={exportSnapshot}
                allowJsonExport={canExportFullSnapshot}
              />
              <CodenamesImportMenu
                onImport={handleImport}
                onBeforeImport={confirmImportOverwrite}
              />
            </div>

            <CodenamesMoveHistory moveHistory={gameState.moveHistory} />
          </aside>
        </div>
      </main>
    </div>
  );
}

export default CodenamesGameClient;
