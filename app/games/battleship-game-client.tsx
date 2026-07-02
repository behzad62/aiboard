"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ChangeEvent } from "react";
import {
  ArrowLeft,
  ClipboardCopy,
  Download,
  Pause,
  Play,
  RotateCcw,
  Upload,
} from "lucide-react";
import { GameAIPresence } from "@/components/games/GameAIPresence";
import type {
  GameAIConfigValue,
  GameAIModelOption,
} from "@/components/games/GameAIConfigPanel";
import { BattleshipGrid } from "@/components/games/battleship/BattleshipGrid";
import { BattleshipHandoff } from "@/components/games/battleship/BattleshipHandoff";
import { BattleshipMoveHistory } from "@/components/games/battleship/BattleshipMoveHistory";
import { BattleshipPlacementPanel } from "@/components/games/battleship/BattleshipPlacementPanel";
import { BattleshipPlayerCard } from "@/components/games/battleship/BattleshipPlayerCard";
import { BattleshipSetup } from "@/components/games/battleship/BattleshipSetup";
import {
  compactReasoningLabel,
  isAIControlledPlayer,
  modeLabel,
  modelLabel,
  opponentOf,
  playerLabel,
} from "@/components/games/battleship/view-helpers";
import {
  chooseFallbackBattleshipTarget,
  getBattleshipAIModels,
  getBattleshipModelApiKey,
  getBattleshipModelBaseURL,
  isRecoverableBattleshipAIError,
  requestBattleshipAIPlacement,
  requestBattleshipAIMove,
  type BattleshipAIDiagnosticAttempt,
} from "@/lib/games/battleship/ai";
import {
  BATTLESHIP_FLEET,
  createBattleshipBoard,
  createInitialBattleshipState,
  createBattleshipStateWithBoards,
  createRandomBattleshipBoard,
  fireBattleshipShot,
  isLegalBattleshipTarget,
  setBattleshipPaused,
  targetToLabel,
  validateBattleshipFleet,
} from "@/lib/games/battleship/engine";
import {
  exportBattleshipJson,
  exportBattleshipMoveList,
  parseBattleshipJsonExport,
} from "@/lib/games/battleship/export";
import {
  BATTLESHIP_ACTIVE_SESSION_ID,
  createBattleshipSessionRecord,
  isBattleshipActiveStatus,
  parseBattleshipSessionRecord,
  type BattleshipSessionSnapshot,
} from "@/lib/games/battleship/session";
import type {
  BattleshipCoordinate,
  BattleshipGameMode,
  BattleshipGameState,
  BattleshipOrientation,
  BattleshipPlayer,
  BattleshipShip,
} from "@/lib/games/battleship/types";
import {
  copyGameExportToClipboard,
  downloadGameExport,
} from "@/lib/games/core/export";
import {
  deleteGameSession,
  listGameSessions,
  saveGameSession,
} from "@/lib/games/core/session-store";
import type { GameAIInteraction } from "@/lib/games/core/types";
import { cn } from "@/lib/utils";

type AIConfig = GameAIConfigValue;
type BattleshipHandoffMode = "placement" | "play";

const EMPTY_AI_CONFIG: AIConfig = {
  modelId: "",
  reasoningEffort: "none",
};
const EMPTY_PLACEMENTS: Record<BattleshipPlayer, BattleshipShip[]> = {
  blue: [],
  orange: [],
};
const HANDOFF_SECONDS = 5;

function normalizeAIConfig(
  config: AIConfig,
  models: GameAIModelOption[]
): AIConfig {
  if (config.modelId || models.length === 0) return config;
  return { ...config, modelId: models[0].modelId };
}

function shouldPersistBattleshipSnapshot(
  snapshot: BattleshipSessionSnapshot
): boolean {
  return snapshot.isPaused || isBattleshipActiveStatus(snapshot.gameState.status);
}

function createFallbackInteraction(
  player: BattleshipPlayer,
  error: string
): GameAIInteraction {
  return {
    actorId: player,
    gesture: "confused",
    utterance: "I had trouble choosing a shot, so a legal fallback was used.",
    diagnostics: error,
  };
}

function nextUnplacedShipId(ships: BattleshipShip[]): string {
  return (
    BATTLESHIP_FLEET.find(
      (definition) => !ships.some((ship) => ship.id === definition.id)
    )?.id ?? BATTLESHIP_FLEET[0].id
  );
}

function formatAIDiagnostics(
  diagnostics: BattleshipAIDiagnosticAttempt[]
): string {
  return diagnostics
    .map((attempt) => {
      const lines = [
        `Attempt ${attempt.attempt} (${attempt.type})`,
        `Message: ${attempt.message}`,
        `Legal targets: ${attempt.legalTargets.join(", ")}`,
      ];

      if (attempt.rejectedTarget) {
        lines.push(`Rejected target: ${attempt.rejectedTarget}`);
      }

      lines.push(
        "Raw response:",
        attempt.rawResponse?.trim() ? attempt.rawResponse : "(no response text)"
      );

      return lines.join("\n");
    })
    .join("\n\n---\n\n");
}

function applyShotWithInteraction(
  state: BattleshipGameState,
  target: BattleshipCoordinate,
  timestamp: number,
  interaction: GameAIInteraction | null = null
): BattleshipGameState {
  const next = fireBattleshipShot(state, target, timestamp);
  if (!interaction || next.moveHistory.length === 0) return next;

  return {
    ...next,
    moveHistory: next.moveHistory.map((move, index) =>
      index === next.moveHistory.length - 1
        ? { ...move, aiInteraction: interaction }
        : move
    ),
  };
}

function exportSnapshotFromState(params: {
  gameState: BattleshipGameState;
  gameMode: BattleshipGameMode;
  humanPlayer: BattleshipPlayer;
  blueAI: AIConfig;
  orangeAI: AIConfig;
  isPaused: boolean;
  lastAiInteraction: GameAIInteraction | null;
  aiWarning: string | null;
  aiError: string | null;
  aiDiagnostics: BattleshipAIDiagnosticAttempt[];
}): BattleshipSessionSnapshot {
  return {
    gameState: params.gameState,
    gameMode: params.gameMode,
    humanPlayer: params.humanPlayer,
    blueAI: params.blueAI,
    orangeAI: params.orangeAI,
    isPaused: params.isPaused,
    lastAiInteraction: params.lastAiInteraction,
    aiWarning: params.aiWarning,
    aiError: params.aiError,
    ...(params.aiDiagnostics.length > 0
      ? { aiDiagnostics: params.aiDiagnostics }
      : {}),
  };
}

export function BattleshipGameClient({
  onBackToGames,
}: {
  onBackToGames?: () => void;
}) {
  const [gameStarted, setGameStarted] = useState(false);
  const [gameMode, setGameMode] = useState<BattleshipGameMode>("pvp");
  const [humanPlayer, setHumanPlayer] = useState<BattleshipPlayer>("blue");
  const [blueAI, setBlueAI] = useState<AIConfig>(EMPTY_AI_CONFIG);
  const [orangeAI, setOrangeAI] = useState<AIConfig>(EMPTY_AI_CONFIG);
  const [availableModels, setAvailableModels] = useState<GameAIModelOption[]>([]);
  const [gameState, setGameState] = useState<BattleshipGameState>(() =>
    createInitialBattleshipState()
  );
  const [isPaused, setIsPaused] = useState(false);
  const [aiThinking, setAiThinking] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);
  const [aiWarning, setAiWarning] = useState<string | null>(null);
  const [aiDiagnostics, setAiDiagnostics] = useState<
    BattleshipAIDiagnosticAttempt[]
  >([]);
  const [aiDiagnosticsCopied, setAiDiagnosticsCopied] = useState(false);
  const [lastAiInteraction, setLastAiInteraction] =
    useState<GameAIInteraction | null>(null);
  const [restoreSnapshot, setRestoreSnapshot] =
    useState<BattleshipSessionSnapshot | null>(null);
  const [restoreCreatedAt, setRestoreCreatedAt] = useState<string | null>(null);
  const [importMessage, setImportMessage] = useState<string | null>(null);
  const [exportMessage, setExportMessage] = useState<string | null>(null);
  const [placementActive, setPlacementActive] = useState(false);
  const [placementPlayer, setPlacementPlayer] =
    useState<BattleshipPlayer>("blue");
  const [placementShips, setPlacementShips] =
    useState<Record<BattleshipPlayer, BattleshipShip[]>>(EMPTY_PLACEMENTS);
  const [selectedPlacementShipId, setSelectedPlacementShipId] = useState(
    BATTLESHIP_FLEET[0].id
  );
  const [placementOrientation, setPlacementOrientation] =
    useState<BattleshipOrientation>("horizontal");
  const [placementError, setPlacementError] = useState<string | null>(null);
  const [aiPlacing, setAiPlacing] = useState(false);
  const [handoffPlayer, setHandoffPlayer] =
    useState<BattleshipPlayer | null>(null);
  const [handoffMode, setHandoffMode] = useState<BattleshipHandoffMode | null>(
    null
  );
  const [handoffSeconds, setHandoffSeconds] = useState(HANDOFF_SECONDS);

  const activeAIAbortControllerRef = useRef<AbortController | null>(null);
  const aiRequestVersionRef = useRef(0);
  const aiRequestActiveRef = useRef(false);
  const latestSnapshotRef = useRef<BattleshipSessionSnapshot | null>(null);
  const activeSessionCreatedAtRef = useRef<string | null>(null);
  const autosaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const handoffIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const persistenceTokenRef = useRef(0);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const activeGame = isBattleshipActiveStatus(gameState.status);
  const handoffActive = handoffPlayer !== null;
  const currentPlayerIsAI = isAIControlledPlayer(
    gameMode,
    humanPlayer,
    gameState.turn
  );
  const viewPlayer =
    gameMode === "pvai"
      ? humanPlayer
      : activeGame || gameState.status === "paused"
        ? gameState.turn
        : gameState.winner ?? humanPlayer;
  const targetPlayer = opponentOf(viewPlayer);
  const currentAIConfig = gameState.turn === "blue" ? blueAI : orangeAI;
  const exportSnapshot = useMemo(
    () =>
      exportSnapshotFromState({
        gameState,
        gameMode,
        humanPlayer,
        blueAI,
        orangeAI,
        isPaused,
        lastAiInteraction,
        aiWarning,
        aiError,
        aiDiagnostics,
      }),
    [
      aiDiagnostics,
      aiError,
      aiWarning,
      blueAI,
      gameMode,
      gameState,
      humanPlayer,
      isPaused,
      lastAiInteraction,
      orangeAI,
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

  const clearHandoffTimer = useCallback(() => {
    if (handoffIntervalRef.current) {
      clearInterval(handoffIntervalRef.current);
      handoffIntervalRef.current = null;
    }
  }, []);

  const finishHandoff = useCallback(
    (
      nextPlayer: BattleshipPlayer | null = handoffPlayer,
      mode: BattleshipHandoffMode | null = handoffMode
    ) => {
      clearHandoffTimer();
      setHandoffPlayer(null);
      setHandoffMode(null);
      setHandoffSeconds(HANDOFF_SECONDS);

      if (mode === "placement" && nextPlayer) {
        setPlacementPlayer(nextPlayer);
        setSelectedPlacementShipId(BATTLESHIP_FLEET[0].id);
        setPlacementError(null);
      }
    },
    [clearHandoffTimer, handoffMode, handoffPlayer]
  );

  const startHandoff = useCallback(
    (nextPlayer: BattleshipPlayer, mode: BattleshipHandoffMode) => {
      clearHandoffTimer();
      setHandoffPlayer(nextPlayer);
      setHandoffMode(mode);
      setHandoffSeconds(HANDOFF_SECONDS);

      let remaining = HANDOFF_SECONDS;
      handoffIntervalRef.current = setInterval(() => {
        remaining -= 1;
        if (remaining <= 0) {
          finishHandoff(nextPlayer, mode);
          return;
        }
        setHandoffSeconds(remaining);
      }, 1000);
    },
    [clearHandoffTimer, finishHandoff]
  );

  const saveLatestSession = useCallback(async (token: number) => {
    if (token !== persistenceTokenRef.current) return;

    const snapshot = latestSnapshotRef.current;
    if (!snapshot || !shouldPersistBattleshipSnapshot(snapshot)) return;

    const now = new Date(Date.now()).toISOString();
    const createdAt = activeSessionCreatedAtRef.current ?? now;

    try {
      await saveGameSession(createBattleshipSessionRecord(snapshot, now, createdAt));
      if (token === persistenceTokenRef.current) {
        activeSessionCreatedAtRef.current = createdAt;
      }
    } catch (error) {
      console.warn("Failed to autosave Battleship session:", error);
    }
  }, []);

  const flushLatestActiveSession = useCallback(async () => {
    const snapshot = latestSnapshotRef.current;
    if (!snapshot || !shouldPersistBattleshipSnapshot(snapshot)) {
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
      await deleteGameSession(BATTLESHIP_ACTIVE_SESSION_ID);
    } catch (error) {
      console.warn("Failed to delete active Battleship session:", error);
    }
  }, [clearAutosaveTimer, invalidatePersistence]);

  useEffect(() => {
    if (typeof window === "undefined") return;

    try {
      const models = getBattleshipAIModels();
      setAvailableModels(models);
      setBlueAI((prev) => normalizeAIConfig(prev, models));
      setOrangeAI((prev) => normalizeAIConfig(prev, models));
    } catch (error) {
      console.warn("Failed to load Battleship models:", error);
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
            session.id === BATTLESHIP_ACTIVE_SESSION_ID &&
            session.gameId === "battleship" &&
            session.status !== "complete" &&
            session.status !== "abandoned"
        );
        const snapshot = record ? parseBattleshipSessionRecord(record) : null;
        const restorable =
          snapshot &&
          (snapshot.isPaused ||
            isBattleshipActiveStatus(snapshot.gameState.status));

        setRestoreSnapshot(restorable ? snapshot : null);
        setRestoreCreatedAt(restorable && record ? record.createdAt : null);
      } catch (error) {
        if (!cancelled) {
          console.warn("Failed to restore Battleship session:", error);
        }
      }
    }

    void restoreSavedSession();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!gameStarted || (!isPaused && !isBattleshipActiveStatus(gameState.status))) {
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
    if (!gameStarted || isBattleshipActiveStatus(gameState.status)) return;
    void deleteActiveSession();
  }, [deleteActiveSession, gameStarted, gameState.status]);

  useEffect(() => {
    if (!gameStarted || handoffActive || isPaused || !activeGame) return;
    if (!currentPlayerIsAI || aiRequestActiveRef.current) return;

    if (!currentAIConfig.modelId) {
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
      setAiWarning(null);
      setAiDiagnostics([]);
      setAiDiagnosticsCopied(false);

      try {
        const apiKey = getBattleshipModelApiKey(currentAIConfig.modelId) ?? "";
        const baseURL = getBattleshipModelBaseURL(currentAIConfig.modelId);
        const result = await requestBattleshipAIMove({
          state: requestState,
          player: currentTurn,
          modelId: currentAIConfig.modelId,
          reasoningEffort: currentAIConfig.reasoningEffort,
          apiKey,
          baseURL,
          signal: abortController.signal,
        });

        if (!isCurrentAIRequest()) return;

        if ("target" in result) {
          const legal = isLegalBattleshipTarget(
            requestState,
            currentTurn,
            result.target
          );
          const fallbackTarget =
            legal || gameMode !== "aivai"
              ? null
              : chooseFallbackBattleshipTarget(requestState, currentTurn);
          const target = legal ? result.target : fallbackTarget;

          if (!target) {
            setAiError(`AI returned illegal target ${targetToLabel(result.target)}.`);
            return;
          }

          const interaction = legal
            ? result.interaction
            : createFallbackInteraction(
                currentTurn,
                `AI returned illegal target ${targetToLabel(result.target)}.`
              );

          setAiWarning(
            legal
              ? null
              : `${playerLabel(currentTurn)} AI returned an illegal target. A legal fallback shot was fired.`
          );
          setLastAiInteraction(interaction);
          setGameState((prev) =>
            prev.turn === currentTurn &&
            isBattleshipActiveStatus(prev.status) &&
            isLegalBattleshipTarget(prev, currentTurn, target)
              ? applyShotWithInteraction(prev, target, Date.now(), interaction)
              : prev
          );
          return;
        }

        const fallbackTarget =
          gameMode === "aivai" && isRecoverableBattleshipAIError(result.error)
            ? chooseFallbackBattleshipTarget(requestState, currentTurn)
            : null;

        if (fallbackTarget) {
          const interaction = createFallbackInteraction(currentTurn, result.error);
          setAiDiagnostics(result.diagnostics ?? []);
          setAiWarning(
            `${playerLabel(currentTurn)} AI hit a recoverable error. A legal fallback shot was fired so the match can continue.`
          );
          setAiError(null);
          setLastAiInteraction(interaction);
          setGameState((prev) =>
            prev.turn === currentTurn &&
            isBattleshipActiveStatus(prev.status) &&
            isLegalBattleshipTarget(prev, currentTurn, fallbackTarget)
              ? applyShotWithInteraction(
                  prev,
                  fallbackTarget,
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
        setAiWarning(null);
        setAiError(error instanceof Error ? error.message : "AI shot failed.");
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
    currentAIConfig,
    currentPlayerIsAI,
    gameMode,
    gameStarted,
    gameState,
    handoffActive,
    isPaused,
  ]);

  useEffect(() => {
    return () => {
      clearHandoffTimer();
      activeAIAbortControllerRef.current?.abort();
      void flushLatestActiveSession();
    };
  }, [clearHandoffTimer, flushLatestActiveSession]);

  const applySnapshot = useCallback(
    (snapshot: BattleshipSessionSnapshot, createdAt: string | null = null) => {
      invalidateAIRequests();
      invalidatePersistence();
      clearHandoffTimer();
      setGameMode(snapshot.gameMode);
      setHumanPlayer(snapshot.humanPlayer);
      setBlueAI(snapshot.blueAI);
      setOrangeAI(snapshot.orangeAI);
      setGameState(snapshot.gameState);
      setIsPaused(snapshot.isPaused || snapshot.gameState.status === "paused");
      setLastAiInteraction(snapshot.lastAiInteraction);
      setAiWarning(snapshot.aiWarning);
      setAiError(snapshot.aiError);
      setAiDiagnostics(snapshot.aiDiagnostics ?? []);
      setAiDiagnosticsCopied(false);
      setAiThinking(false);
      setImportMessage(null);
      setExportMessage(null);
      setRestoreSnapshot(null);
      setRestoreCreatedAt(null);
      activeSessionCreatedAtRef.current = createdAt;
      setGameStarted(true);
    },
    [clearHandoffTimer, invalidateAIRequests, invalidatePersistence]
  );

  const requestAIPlacement = useCallback(
    async (player: BattleshipPlayer): Promise<BattleshipShip[]> => {
      const config = player === "blue" ? blueAI : orangeAI;
      if (config.modelId) {
        const abortController = new AbortController();
        activeAIAbortControllerRef.current = abortController;
        try {
          const result = await requestBattleshipAIPlacement({
            player,
            modelId: config.modelId,
            reasoningEffort: config.reasoningEffort,
            apiKey: getBattleshipModelApiKey(config.modelId) ?? "",
            baseURL: getBattleshipModelBaseURL(config.modelId),
            signal: abortController.signal,
          });

          if ("ships" in result) {
            return result.ships;
          }

          setAiWarning(
            `${playerLabel(player)} AI could not place a valid fleet. A legal auto-placement was used.`
          );
        } catch (error) {
          if (abortController.signal.aborted) throw error;
          const message =
            error instanceof Error ? error.message : "AI placement request failed.";
          setAiWarning(
            `${playerLabel(player)} AI placement failed (${message}). A legal auto-placement was used.`
          );
        } finally {
          if (activeAIAbortControllerRef.current === abortController) {
            activeAIAbortControllerRef.current = null;
          }
        }
      }

      return createRandomBattleshipBoard().ships;
    },
    [blueAI, orangeAI]
  );

  const startPlayingFromShips = useCallback(
    (
      shipsByPlayer: Record<BattleshipPlayer, BattleshipShip[]>,
      useInitialHandoff: boolean
    ) => {
      const blueValidation = validateBattleshipFleet(shipsByPlayer.blue);
      const orangeValidation = validateBattleshipFleet(shipsByPlayer.orange);
      if (!blueValidation.ok || !orangeValidation.ok) {
        setPlacementError(
          !blueValidation.ok
            ? blueValidation.error
            : !orangeValidation.ok
              ? orangeValidation.error
              : "Invalid fleet placement."
        );
        return;
      }

      invalidateAIRequests();
      invalidatePersistence();
      setGameState(
        createBattleshipStateWithBoards(
          createBattleshipBoard(blueValidation.ships),
          createBattleshipBoard(orangeValidation.ships)
        )
      );
      setIsPaused(false);
      setAiThinking(false);
      setAiError(null);
      setAiDiagnostics([]);
      setAiDiagnosticsCopied(false);
      setLastAiInteraction(null);
      setImportMessage(null);
      setExportMessage(null);
      setRestoreSnapshot(null);
      setRestoreCreatedAt(null);
      setPlacementActive(false);
      setAiPlacing(false);
      setPlacementError(null);
      activeSessionCreatedAtRef.current = null;
      setGameStarted(true);

      if (useInitialHandoff) {
        startHandoff("blue", "play");
      }
    },
    [invalidateAIRequests, invalidatePersistence, startHandoff]
  );

  const handleBeginPlacement = useCallback(async () => {
    invalidateAIRequests();
    invalidatePersistence();
    clearHandoffTimer();
    const emptyPlacements: Record<BattleshipPlayer, BattleshipShip[]> = {
      blue: [],
      orange: [],
    };

    setGameState(createInitialBattleshipState());
    setIsPaused(false);
    setAiThinking(false);
    setAiError(null);
    setAiWarning(null);
    setAiDiagnostics([]);
    setAiDiagnosticsCopied(false);
    setLastAiInteraction(null);
    setImportMessage(null);
    setExportMessage(null);
    setRestoreSnapshot(null);
    setRestoreCreatedAt(null);
    setPlacementShips(emptyPlacements);
    setPlacementError(null);
    setSelectedPlacementShipId(BATTLESHIP_FLEET[0].id);
    setPlacementOrientation("horizontal");
    setHandoffPlayer(null);
    setHandoffMode(null);
    setHandoffSeconds(HANDOFF_SECONDS);
    activeSessionCreatedAtRef.current = null;
    setGameStarted(false);

    if (gameMode === "aivai") {
      setAiPlacing(true);
      try {
        const [blueShips, orangeShips] = await Promise.all([
          requestAIPlacement("blue"),
          requestAIPlacement("orange"),
        ]);
        startPlayingFromShips(
          { blue: blueShips, orange: orangeShips },
          false
        );
      } catch (error) {
        setAiPlacing(false);
        setAiError(
          error instanceof Error ? error.message : "AI placement failed."
        );
      }
      return;
    }

    const nextPlacementPlayer = gameMode === "pvp" ? "blue" : humanPlayer;
    setPlacementPlayer(nextPlacementPlayer);
    setPlacementActive(true);
  }, [
    gameMode,
    humanPlayer,
    clearHandoffTimer,
    invalidateAIRequests,
    invalidatePersistence,
    requestAIPlacement,
    startPlayingFromShips,
  ]);

  const handleStartNew = useCallback(async () => {
    await deleteActiveSession();
    await handleBeginPlacement();
  }, [deleteActiveSession, handleBeginPlacement]);

  const handleResumeSavedGame = useCallback(() => {
    if (!restoreSnapshot) return;
    applySnapshot(restoreSnapshot, restoreCreatedAt);
  }, [applySnapshot, restoreCreatedAt, restoreSnapshot]);

  const handlePlaceShip = useCallback(
    (ship: BattleshipShip) => {
      setPlacementShips((current) => {
        const nextShips = [
          ...current[placementPlayer].filter((item) => item.id !== ship.id),
          ship,
        ];
        setSelectedPlacementShipId(nextUnplacedShipId(nextShips));
        setPlacementError(null);
        return {
          ...current,
          [placementPlayer]: nextShips,
        };
      });
    },
    [placementPlayer]
  );

  const handleRemovePlacedShip = useCallback(
    (shipId: string) => {
      setPlacementShips((current) => ({
        ...current,
        [placementPlayer]: current[placementPlayer].filter(
          (ship) => ship.id !== shipId
        ),
      }));
      setSelectedPlacementShipId(shipId);
      setPlacementError(null);
    },
    [placementPlayer]
  );

  const handleAutoPlaceFleet = useCallback(() => {
    const board = createRandomBattleshipBoard();
    setPlacementShips((current) => ({
      ...current,
      [placementPlayer]: board.ships,
    }));
    setSelectedPlacementShipId(BATTLESHIP_FLEET[0].id);
    setPlacementError(null);
  }, [placementPlayer]);

  const handleClearFleet = useCallback(() => {
    setPlacementShips((current) => ({
      ...current,
      [placementPlayer]: [],
    }));
    setSelectedPlacementShipId(BATTLESHIP_FLEET[0].id);
    setPlacementError(null);
  }, [placementPlayer]);

  const handleConfirmPlacement = useCallback(async () => {
    const currentShips = placementShips[placementPlayer];
    const validation = validateBattleshipFleet(currentShips);
    if (!validation.ok) {
      setPlacementError(validation.error);
      return;
    }

    const nextPlacements = {
      ...placementShips,
      [placementPlayer]: validation.ships,
    };
    setPlacementShips(nextPlacements);

    if (gameMode === "pvp" && placementPlayer === "blue") {
      startHandoff("orange", "placement");
      return;
    }

    if (gameMode === "pvp") {
      startPlayingFromShips(nextPlacements, true);
      return;
    }

    const aiPlayer = opponentOf(humanPlayer);
    setAiPlacing(true);
    try {
      const aiShips = await requestAIPlacement(aiPlayer);
      startPlayingFromShips(
        {
          ...nextPlacements,
          [aiPlayer]: aiShips,
        },
        false
      );
    } catch (error) {
      setAiPlacing(false);
      setPlacementError(
        error instanceof Error ? error.message : "AI placement failed."
      );
    }
  }, [
    gameMode,
    humanPlayer,
    placementPlayer,
    placementShips,
    requestAIPlacement,
    startHandoff,
    startPlayingFromShips,
  ]);

  const handleTargetClick = useCallback(
    (target: BattleshipCoordinate) => {
      if (
        !gameStarted ||
        isPaused ||
        aiThinking ||
        !activeGame ||
        currentPlayerIsAI ||
        viewPlayer !== gameState.turn ||
        !isLegalBattleshipTarget(gameState, gameState.turn, target)
      ) {
        return;
      }

      const nextState = fireBattleshipShot(gameState, target, Date.now());
      setGameState(nextState);
      if (gameMode === "pvp" && nextState.status === "playing") {
        startHandoff(nextState.turn, "play");
      }
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
      gameMode,
      isPaused,
      startHandoff,
      viewPlayer,
    ]
  );

  const handlePause = useCallback(() => {
    invalidateAIRequests();
    setGameState((prev) => setBattleshipPaused(prev, true));
    setIsPaused(true);
  }, [invalidateAIRequests]);

  const handleResume = useCallback(() => {
    setGameState((prev) => setBattleshipPaused(prev, false));
    setIsPaused(false);
  }, []);

  const handleReset = useCallback(async () => {
    await deleteActiveSession();
    clearHandoffTimer();
    setGameStarted(false);
    setPlacementActive(false);
    setAiPlacing(false);
    setHandoffPlayer(null);
    setHandoffMode(null);
  }, [clearHandoffTimer, deleteActiveSession]);

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

  const handleCopyMoves = useCallback(async () => {
    try {
      await copyGameExportToClipboard(exportBattleshipMoveList(gameState));
      setExportMessage("Moves copied");
    } catch {
      setExportMessage("Copy unavailable");
    }
  }, [gameState]);

  const handleDownloadJson = useCallback(() => {
    try {
      downloadGameExport(exportBattleshipJson(exportSnapshot));
      setExportMessage("JSON downloaded");
    } catch {
      setExportMessage("Download unavailable");
    }
  }, [exportSnapshot]);

  const handleImportFile = useCallback(
    async (event: ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      event.target.value = "";
      if (!file) return;

      if (
        gameStarted &&
        !window.confirm(
          "Importing a Battleship game will replace the current board. Continue?"
        )
      ) {
        return;
      }

      try {
        const content = await file.text();
        const result = parseBattleshipJsonExport(content);
        if (!result.ok) {
          setImportMessage(result.error);
          return;
        }

        applySnapshot(result.snapshot, null);
        setImportMessage("Imported");
      } catch {
        setImportMessage("Could not read the selected file.");
      }
    },
    [applySnapshot, gameStarted]
  );

  const blueIsAI = isAIControlledPlayer(gameMode, humanPlayer, "blue");
  const orangeIsAI = isAIControlledPlayer(gameMode, humanPlayer, "orange");
  const statusMessage =
    gameState.status === "win"
      ? `${playerLabel(gameState.winner ?? "blue")} wins`
      : isPaused || gameState.status === "paused"
        ? "Paused"
        : currentPlayerIsAI
          ? `${playerLabel(gameState.turn)} AI scanning`
          : `${playerLabel(gameState.turn)} to fire`;

  if (!gameStarted && aiPlacing) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-sky-50 via-slate-50 to-orange-50 text-slate-950 dark:from-slate-950 dark:via-slate-900 dark:to-sky-950/40 dark:text-white">
        <main className="mx-auto flex min-h-screen w-full max-w-3xl flex-col justify-center px-4 py-10 sm:px-6">
          <section className="rounded-2xl border border-slate-200 bg-white/90 p-8 text-center shadow-xl dark:border-slate-800 dark:bg-slate-950/90">
            <div
              className="mx-auto h-12 w-12 animate-spin rounded-full border-4 border-sky-200 border-t-sky-600"
              aria-hidden="true"
            />
            <h1 className="mt-6 text-2xl font-bold">AI fleet placement</h1>
            <p className="mt-2 text-sm text-slate-600 dark:text-slate-400">
              Models are choosing legal ship positions.
            </p>
          </section>
        </main>
      </div>
    );
  }

  if (!gameStarted && placementActive) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-sky-50 via-slate-50 to-orange-50 text-slate-950 dark:from-slate-950 dark:via-slate-900 dark:to-sky-950/40 dark:text-white">
        <main className="mx-auto flex min-h-screen w-full max-w-6xl flex-col justify-center px-4 py-10 sm:px-6">
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
          {handoffActive && handoffPlayer ? (
            <BattleshipHandoff
              nextPlayer={handoffPlayer}
              seconds={handoffSeconds}
              onSkip={finishHandoff}
            />
          ) : (
            <BattleshipPlacementPanel
              player={placementPlayer}
              ships={placementShips[placementPlayer]}
              selectedShipId={selectedPlacementShipId}
              orientation={placementOrientation}
              error={placementError}
              onSelectShip={setSelectedPlacementShipId}
              onOrientationChange={setPlacementOrientation}
              onPlaceShip={handlePlaceShip}
              onRemoveShip={handleRemovePlacedShip}
              onAutoPlace={handleAutoPlaceFleet}
              onClear={handleClearFleet}
              onConfirm={() => void handleConfirmPlacement()}
            />
          )}
        </main>
      </div>
    );
  }

  if (!gameStarted) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-sky-50 via-slate-50 to-orange-50 text-slate-950 dark:from-slate-950 dark:via-slate-900 dark:to-sky-950/40 dark:text-white">
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
          <BattleshipSetup
            gameMode={gameMode}
            humanPlayer={humanPlayer}
            blueAI={blueAI}
            orangeAI={orangeAI}
            models={availableModels}
            restoreMoves={restoreSnapshot?.gameState.moveHistory.length ?? null}
            importMessage={importMessage}
            onModeChange={setGameMode}
            onHumanPlayerChange={setHumanPlayer}
            onBlueAIChange={setBlueAI}
            onOrangeAIChange={setOrangeAI}
            onStart={() => void handleBeginPlacement()}
            onStartNew={handleStartNew}
            onResume={handleResumeSavedGame}
            onImportClick={() => fileInputRef.current?.click()}
          />
          <input
            ref={fileInputRef}
            type="file"
            accept="application/json,.json"
            className="sr-only"
            onChange={(event) => void handleImportFile(event)}
            data-testid="battleship-import-input"
          />
        </main>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-100 via-sky-50 to-orange-50 text-slate-950 dark:from-slate-950 dark:via-slate-900 dark:to-sky-950/30 dark:text-white">
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
          <p className="text-sm font-semibold uppercase tracking-wide text-sky-600 dark:text-sky-300">
            Battleship
          </p>
          <h1 className="mt-2 text-3xl font-bold">Battleship</h1>
          <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
            {modeLabel(gameMode, humanPlayer)}
          </p>
        </header>

        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_24rem]">
          {handoffActive && handoffPlayer ? (
            <BattleshipHandoff
              nextPlayer={handoffPlayer}
              seconds={handoffSeconds}
              onSkip={finishHandoff}
            />
          ) : (
            <section className="space-y-4">
              <div className="grid gap-3 md:grid-cols-2">
                <BattleshipPlayerCard
                  player="blue"
                  active={activeGame && gameState.turn === "blue"}
                  isAI={blueIsAI}
                  modelName={
                    blueIsAI
                      ? modelLabel(availableModels, blueAI.modelId)
                      : undefined
                  }
                  reasoning={blueIsAI ? compactReasoningLabel(blueAI) : undefined}
                  board={gameState.boards.blue}
                />
                <BattleshipPlayerCard
                  player="orange"
                  active={activeGame && gameState.turn === "orange"}
                  isAI={orangeIsAI}
                  modelName={
                    orangeIsAI
                      ? modelLabel(availableModels, orangeAI.modelId)
                      : undefined
                  }
                  reasoning={
                    orangeIsAI ? compactReasoningLabel(orangeAI) : undefined
                  }
                  board={gameState.boards.orange}
                />
              </div>

              {gameMode === "aivai" ? (
                <div className="grid gap-4 xl:grid-cols-2">
                  <BattleshipGrid
                    title="Blue fleet"
                    subtitle="Blue waters"
                    player="blue"
                    board={gameState.boards.blue}
                    revealShips
                    interactive={false}
                  />
                  <BattleshipGrid
                    title="Orange fleet"
                    subtitle="Orange waters"
                    player="orange"
                    board={gameState.boards.orange}
                    revealShips
                    interactive={false}
                  />
                </div>
              ) : (
                <div className="grid gap-4 xl:grid-cols-2">
                  <BattleshipGrid
                    title={`${playerLabel(viewPlayer)} fleet`}
                    subtitle="Own waters"
                    player={viewPlayer}
                    board={gameState.boards[viewPlayer]}
                    revealShips
                    interactive={false}
                  />
                  <BattleshipGrid
                    title={`${playerLabel(targetPlayer)} waters`}
                    subtitle="Target grid"
                    player={targetPlayer}
                    board={gameState.boards[targetPlayer]}
                    revealShips={gameState.status === "win"}
                    interactive={
                      gameStarted &&
                      !isPaused &&
                      !aiThinking &&
                      activeGame &&
                      !currentPlayerIsAI &&
                      !handoffActive
                    }
                    attacker={gameState.turn}
                    state={gameState}
                    onCellClick={handleTargetClick}
                  />
                </div>
              )}
            </section>
          )}

          <aside className="space-y-4">
            <section
              className="rounded-xl border border-slate-200 bg-white p-4 text-center shadow-sm dark:border-slate-800 dark:bg-slate-950"
              data-testid="battleship-status"
            >
              <div className="text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
                Status
              </div>
              <div
                className={cn(
                  "mt-1 text-lg font-bold",
                  gameState.winner === "blue" && "text-sky-600 dark:text-sky-300",
                  gameState.winner === "orange" &&
                    "text-orange-600 dark:text-orange-300"
                )}
              >
                {statusMessage}
              </div>
            </section>

            {aiThinking && (
              <div
                className="flex items-center gap-3 rounded-xl border border-sky-200 bg-sky-50 p-4 text-sky-800 shadow-sm dark:border-sky-800 dark:bg-sky-950/35 dark:text-sky-200"
                data-testid="battleship-ai-thinking"
              >
                <span
                  className="h-5 w-5 animate-spin rounded-full border-2 border-sky-500 border-t-transparent"
                  aria-hidden="true"
                />
                <span className="text-sm font-semibold">AI is scanning...</span>
              </div>
            )}

            {aiWarning && (
              <div
                className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-amber-800 shadow-sm dark:border-amber-800 dark:bg-amber-950/35 dark:text-amber-200"
                data-testid="battleship-ai-warning"
              >
                <div className="text-sm font-semibold">AI fallback shot</div>
                <p className="mt-1 text-sm">{aiWarning}</p>
              </div>
            )}

            {aiError && (
              <div
                className="rounded-xl border border-red-200 bg-red-50 p-4 text-red-700 shadow-sm dark:border-red-900 dark:bg-red-950/35 dark:text-red-300"
                data-testid="battleship-ai-error"
              >
                <div className="text-sm font-semibold">AI error</div>
                <p className="mt-1 text-sm">{aiError}</p>
              </div>
            )}

            {aiDiagnostics.length > 0 && (
              <section
                className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-800 dark:bg-slate-950"
                data-testid="battleship-ai-diagnostics"
              >
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <div className="text-sm font-semibold">Raw AI responses</div>
                    <div className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
                      {aiDiagnostics.length} failed attempt
                      {aiDiagnostics.length === 1 ? "" : "s"}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={handleCopyAIDiagnostics}
                    className="inline-flex items-center gap-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs font-semibold text-slate-700 transition hover:bg-slate-100 active:scale-95 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800"
                    data-testid="battleship-copy-ai-diagnostics"
                  >
                    <ClipboardCopy className="h-3.5 w-3.5" aria-hidden="true" />
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

            <GameAIPresence interaction={lastAiInteraction} />

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

            <section className="grid grid-cols-3 gap-3">
              <button
                type="button"
                onClick={() => void handleCopyMoves()}
                className="inline-flex items-center justify-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2.5 text-sm font-medium text-slate-700 shadow-sm transition hover:bg-slate-50 active:scale-95 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300 dark:hover:bg-slate-800"
              >
                <ClipboardCopy className="h-4 w-4" aria-hidden="true" />
                Moves
              </button>
              <button
                type="button"
                onClick={handleDownloadJson}
                className="inline-flex items-center justify-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2.5 text-sm font-medium text-slate-700 shadow-sm transition hover:bg-slate-50 active:scale-95 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300 dark:hover:bg-slate-800"
              >
                <Download className="h-4 w-4" aria-hidden="true" />
                JSON
              </button>
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className="inline-flex items-center justify-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2.5 text-sm font-medium text-slate-700 shadow-sm transition hover:bg-slate-50 active:scale-95 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300 dark:hover:bg-slate-800"
              >
                <Upload className="h-4 w-4" aria-hidden="true" />
                Import
              </button>
            </section>
            {(exportMessage || importMessage) && (
              <div className="text-center text-xs font-medium text-slate-600 dark:text-slate-400">
                {exportMessage ?? importMessage}
              </div>
            )}
            <input
              ref={fileInputRef}
              type="file"
              accept="application/json,.json"
              className="sr-only"
              onChange={(event) => void handleImportFile(event)}
              data-testid="battleship-import-input"
            />

            <BattleshipMoveHistory state={gameState} />
          </aside>
        </div>
      </main>
    </div>
  );
}

export default BattleshipGameClient;
