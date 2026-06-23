"use client";

import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { cn } from "@/lib/utils";
import { ChessBoard } from "@/components/games/ChessBoard";
import { ChessClock } from "@/components/games/chess/ChessClock";
import { MoveHistory } from "@/components/games/chess/MoveHistory";
import { GameControls } from "@/components/games/chess/GameControls";
import { ExportGameMenu } from "@/components/games/chess/ExportGameMenu";
import { ImportGameMenu } from "@/components/games/chess/ImportGameMenu";
import { AIPresence } from "@/components/games/chess/AIPresence";
import { CapturedPieces } from "@/components/games/chess/CapturedPieces";
import {
  PromotionDialog,
  type PromotionPieceType,
} from "@/components/games/chess/PromotionDialog";
import {
  createInitialState,
  fromFEN,
  generateLegalMoves,
  makeMove,
  generateLegalMovesFromSquare,
  isLegalMove,
  getPiece,
  squareToCoords,
} from "@/lib/games/chess/engine";
import {
  requestAIMove,
  getAvailableModels,
  getModelApiKey,
  getModelBaseURL,
} from "@/lib/games/chess/ai";
import { ensureReady } from "@/lib/client/api";
import {
  deleteGameSession as deleteStoredGameSession,
  upsertGameSession,
} from "@/lib/client/store";
import type {
  GameState,
  Square,
  Move,
  GameMode,
  PieceColor,
  Piece,
  GameMatchRecord,
} from "@/lib/games/chess/types";
import type { ReasoningEffort } from "@/lib/db/schema";
import { saveMatchRecord } from "@/lib/games/stats";
import {
  CHESS_ACTIVE_SESSION_ID,
  DEFAULT_CHESS_TIME_CONTROL,
  createChessSessionRecord,
  isChessActiveStatus,
  parseChessSessionRecord,
  type ChessTimeControl,
  type ChessTimeControlMode,
  type ChessSessionSnapshot,
} from "@/lib/games/chess/session";
import { listGameSessions } from "@/lib/games/core/session-store";
import type { ChessPgnMetadata } from "@/lib/games/chess/export";

// Reasoning effort levels for the slider
const REASONING_LEVELS: { value: ReasoningEffort; label: string }[] = [
  { value: "default", label: "Disabled" },
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
  { value: "max", label: "Max" },
];

// Game mode options
const GAME_MODES: { value: GameMode; label: string; description: string }[] = [
  { value: "pvp", label: "Player vs Player", description: "Two humans play" },
  { value: "pvai", label: "Player vs AI", description: "Play against an AI" },
  { value: "aivai", label: "AI vs AI", description: "Watch AIs compete" },
];

const TIME_CONTROLS: ChessTimeControl[] = [
  DEFAULT_CHESS_TIME_CONTROL,
  {
    mode: "blitz-5-0",
    initialMs: 5 * 60_000,
    incrementMs: 0,
    label: "5+0 blitz",
  },
  {
    mode: "rapid-10-0",
    initialMs: 10 * 60_000,
    incrementMs: 0,
    label: "10+0 rapid",
  },
  {
    mode: "rapid-15-10",
    initialMs: 15 * 60_000,
    incrementMs: 10_000,
    label: "15+10 rapid",
  },
];

const CUSTOM_TIME_CONTROL_MODE: ChessTimeControlMode = "custom";

type BoardOrientation = "white" | "black" | "auto";

const BOARD_ORIENTATIONS: Array<{ value: BoardOrientation; label: string }> = [
  { value: "white", label: "White" },
  { value: "black", label: "Black" },
  { value: "auto", label: "Auto" },
];

const CLOCK_AUTOSAVE_INTERVAL_MS = 5_000;
const PROMOTION_PIECES: PromotionPieceType[] = [
  "queen",
  "rook",
  "bishop",
  "knight",
];

function isTimedTimeControl(timeControl: ChessTimeControl): boolean {
  return timeControl.mode !== "untimed" && timeControl.initialMs > 0;
}

function initialRemainingMs(timeControl: ChessTimeControl): number | null {
  return isTimedTimeControl(timeControl) ? timeControl.initialMs : null;
}

function oppositeColor(color: PieceColor): PieceColor {
  return color === "white" ? "black" : "white";
}

function createCustomTimeControl(
  minutesInput: string,
  incrementInput: string
): ChessTimeControl {
  const minutes = Number.parseFloat(minutesInput);
  const incrementSeconds = Number.parseFloat(incrementInput);
  const safeMinutes = Number.isFinite(minutes) && minutes > 0 ? minutes : 1;
  const safeIncrementSeconds =
    Number.isFinite(incrementSeconds) && incrementSeconds > 0
      ? incrementSeconds
      : 0;
  const initialMs = Math.max(1_000, Math.round(safeMinutes * 60_000));
  const incrementMs = Math.max(0, Math.round(safeIncrementSeconds * 1000));

  return {
    mode: CUSTOM_TIME_CONTROL_MODE,
    initialMs,
    incrementMs,
    label: `${formatCustomMinutes(initialMs)}+${Math.round(
      incrementMs / 1000
    )} custom`,
  };
}

function formatCustomMinutes(ms: number): string {
  const minutes = ms / 60_000;
  return Number.isInteger(minutes) ? String(minutes) : minutes.toFixed(2);
}

function createAIAbortError(): Error {
  const err = new Error("AI request aborted");
  err.name = "AbortError";
  return err;
}

function waitForAIDelay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return Promise.reject(createAIAbortError());
  }

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);

    const onAbort = () => {
      clearTimeout(timeout);
      signal.removeEventListener("abort", onAbort);
      reject(createAIAbortError());
    };

    signal.addEventListener("abort", onAbort, { once: true });
  });
}

interface CapturedPiecesByPlayer {
  white: Piece[];
  black: Piece[];
}

interface BoardPlayerSummary {
  color: PieceColor;
  title: string;
  subtitle: string;
  kind: "human" | "ai";
}

function colorLabel(color: PieceColor): string {
  return color === "white" ? "White" : "Black";
}

function chooseFallbackAIMove(state: GameState): Move | null {
  return generateLegalMoves(state, state.turn)[0] ?? null;
}

function isRecoverableAIMoveError(error: string): boolean {
  const normalized = error.toLowerCase();
  const nonRecoverable =
    normalized.includes("aborted") ||
    normalized.includes("no legal moves") ||
    normalized.includes("unknown provider") ||
    normalized.includes("unauthorized") ||
    normalized.includes("forbidden") ||
    normalized.includes("invalid api key") ||
    normalized.includes("key limit") ||
    normalized.includes("quota") ||
    normalized.includes("rate limit") ||
    normalized.includes("429") ||
    normalized.includes("401") ||
    normalized.includes("403");

  if (nonRecoverable) return false;

  return (
    normalized.includes("parse") ||
    normalized.includes("illegal move") ||
    normalized.includes("valid move") ||
    normalized.includes("maximum retries") ||
    normalized.includes("request failed") ||
    normalized.includes("api_error") ||
    normalized.includes("internal server error") ||
    normalized.includes("server error") ||
    normalized.includes("timeout") ||
    normalized.includes("overloaded") ||
    normalized.includes("temporarily unavailable") ||
    normalized.includes("500") ||
    normalized.includes("502") ||
    normalized.includes("503") ||
    normalized.includes("504")
  );
}

function fallbackMoveReason(error: string): string {
  const normalized = error.toLowerCase();
  return normalized.includes("parse") ||
    normalized.includes("illegal move") ||
    normalized.includes("valid move")
    ? "returned an unreadable move"
    : "hit a transient provider error";
}

function getCapturedPiecesByPlayer(state: GameState): CapturedPiecesByPlayer {
  const captured: CapturedPiecesByPlayer = {
    white: [],
    black: [],
  };

  for (const record of state.moveHistory) {
    let beforeMove: GameState;

    try {
      beforeMove = fromFEN(record.fenBefore);
    } catch {
      continue;
    }

    const movingPiece = getPiece(beforeMove, record.move.from);
    if (!movingPiece) continue;

    let capturedPiece = getPiece(beforeMove, record.move.to);
    if (
      !capturedPiece &&
      movingPiece.type === "pawn" &&
      beforeMove.enPassantTarget === record.move.to &&
      record.move.from[0] !== record.move.to[0]
    ) {
      const [toRow, toCol] = squareToCoords(record.move.to);
      const capturedRow = movingPiece.color === "white" ? toRow + 1 : toRow - 1;
      capturedPiece = beforeMove.board[capturedRow]?.[toCol] ?? null;
    }

    if (capturedPiece) {
      captured[movingPiece.color].push(capturedPiece);
    }
  }

  return captured;
}

interface AIConfig {
  modelId: string;
  reasoningEffort: ReasoningEffort;
}

function BoardPlayerCard({
  player,
  active,
  testId,
}: {
  player: BoardPlayerSummary;
  active: boolean;
  testId: string;
}) {
  return (
    <div
      className={cn(
        "flex items-center justify-between gap-3 rounded-xl border px-3 py-2 shadow-sm",
        "border-slate-200 bg-white/85 text-slate-900",
        "dark:border-slate-700 dark:bg-slate-950/75 dark:text-slate-100",
        active &&
          "border-amber-400 bg-amber-50 shadow-amber-500/15 dark:border-amber-500 dark:bg-amber-950/30"
      )}
      data-testid={testId}
    >
      <div className="flex min-w-0 items-center gap-3">
        <div
          className={cn(
            "flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full border-2 shadow-inner",
            player.color === "white"
              ? "border-stone-300 bg-stone-50 text-stone-900"
              : "border-slate-600 bg-slate-950 text-slate-100"
          )}
          aria-hidden="true"
        >
          {player.color === "white" ? "W" : "B"}
        </div>
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold leading-tight">
            {player.title}
          </div>
          <div className="mt-0.5 flex items-center gap-2 text-xs uppercase tracking-wide text-slate-500 dark:text-slate-400">
            <span>{player.subtitle}</span>
            <span className="h-1 w-1 rounded-full bg-current" />
            <span>{player.kind === "ai" ? "AI" : "Human"}</span>
          </div>
        </div>
      </div>
      <span
        className={cn(
          "h-2.5 w-2.5 flex-shrink-0 rounded-full",
          active ? "bg-emerald-500 shadow-[0_0_0_4px_rgba(16,185,129,0.16)]" : "bg-slate-300 dark:bg-slate-700"
        )}
        aria-label={active ? "Active turn" : "Waiting"}
      />
    </div>
  );
}

// AI Configuration Panel Component
interface AIConfigPanelProps {
  title: string;
  color: PieceColor;
  config: AIConfig;
  onChange: (config: AIConfig) => void;
  models: { id: string; name: string }[];
}

function AIConfigPanel({
  title,
  color,
  config,
  onChange,
  models,
}: AIConfigPanelProps) {
  const reasoningIndex = REASONING_LEVELS.findIndex(
    (l) => l.value === config.reasoningEffort
  );

  return (
    <div
      className={cn(
        "p-4 rounded-xl border-2",
        color === "white"
          ? "border-gray-200 dark:border-gray-600 bg-gray-50 dark:bg-gray-700/50"
          : "border-gray-400 dark:border-gray-500 bg-gray-100 dark:bg-gray-800/50"
      )}
      data-testid={`ai-config-${color}`}
    >
      <div className="flex items-center gap-2 mb-3">
        <div
          className={cn(
            "w-4 h-4 rounded-full border-2",
            color === "white"
              ? "bg-white border-gray-400"
              : "bg-gray-900 border-gray-600"
          )}
        />
        <span className="font-semibold text-gray-900 dark:text-white">
          {title}
        </span>
      </div>

      {/* Model Selector */}
      <div className="mb-4">
        <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">
          Model
        </label>
        <select
          value={config.modelId}
          onChange={(e) => onChange({ ...config, modelId: e.target.value })}
          className={cn(
            "w-full p-2 rounded-lg border text-sm",
            "bg-white dark:bg-gray-800",
            "border-gray-300 dark:border-gray-600",
            "text-gray-900 dark:text-white",
            "focus:ring-2 focus:ring-amber-500 focus:border-amber-500"
          )}
          data-testid={`model-select-${color}`}
        >
          {models.map((model) => (
            <option key={model.id} value={model.id}>
              {model.name}
            </option>
          ))}
        </select>
      </div>

      {/* Reasoning Effort Slider */}
      <div>
        <div className="flex justify-between items-center mb-1">
          <label className="text-xs font-medium text-gray-600 dark:text-gray-400">
            Reasoning Level
          </label>
          <span className="text-xs font-semibold text-amber-600 dark:text-amber-400">
            {REASONING_LEVELS[reasoningIndex]?.label || "Disabled"}
          </span>
        </div>
        <input
          type="range"
          min={0}
          max={REASONING_LEVELS.length - 1}
          value={reasoningIndex >= 0 ? reasoningIndex : 0}
          onChange={(e) => {
            const idx = parseInt(e.target.value, 10);
            onChange({
              ...config,
              reasoningEffort: REASONING_LEVELS[idx].value,
            });
          }}
          className={cn(
            "w-full h-2 rounded-lg appearance-none cursor-pointer",
            "bg-gray-200 dark:bg-gray-600",
            "[&::-webkit-slider-thumb]:appearance-none",
            "[&::-webkit-slider-thumb]:w-4",
            "[&::-webkit-slider-thumb]:h-4",
            "[&::-webkit-slider-thumb]:rounded-full",
            "[&::-webkit-slider-thumb]:bg-amber-500",
            "[&::-webkit-slider-thumb]:cursor-pointer"
          )}
          data-testid={`reasoning-slider-${color}`}
        />
        <div className="flex justify-between text-[10px] text-gray-400 mt-1">
          {REASONING_LEVELS.map((level) => (
            <span key={level.value}>{level.label}</span>
          ))}
        </div>
      </div>
    </div>
  );
}

export function GamesClient() {
  // Setup state
  const [gameStarted, setGameStarted] = useState(false);
  const [gameMode, setGameMode] = useState<GameMode>("pvp");
  const [humanColor, setHumanColor] = useState<PieceColor>("white");
  const [availableModels, setAvailableModels] = useState<
    { id: string; name: string }[]
  >([]);
  const [whiteAI, setWhiteAI] = useState<AIConfig>({
    modelId: "",
    reasoningEffort: "default",
  });
  const [blackAI, setBlackAI] = useState<AIConfig>({
    modelId: "",
    reasoningEffort: "default",
  });

  // Game state - use lazy initializer for SSR safety
  const [gameState, setGameState] = useState<GameState>(() => createInitialState());
  const [selectedSquare, setSelectedSquare] = useState<Square | null>(null);
  const [pendingPromotion, setPendingPromotion] = useState<{
    from: Square;
    to: Square;
  } | null>(null);
  const [legalMoves, setLegalMoves] = useState<Move[]>([]);
  const [boardOrientation, setBoardOrientation] =
    useState<BoardOrientation>("auto");
  const [isPaused, setIsPaused] = useState(false);
  const [whiteTimeMs, setWhiteTimeMs] = useState(0);
  const [blackTimeMs, setBlackTimeMs] = useState(0);
  const [whiteRemainingMs, setWhiteRemainingMs] = useState<number | null>(null);
  const [blackRemainingMs, setBlackRemainingMs] = useState<number | null>(null);
  const [timeControl, setTimeControl] = useState<ChessTimeControl>(
    DEFAULT_CHESS_TIME_CONTROL
  );
  const [customMinutes, setCustomMinutes] = useState("5");
  const [customIncrementSeconds, setCustomIncrementSeconds] = useState("0");
  const [aiThinking, setAiThinking] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);
  const [aiWarning, setAiWarning] = useState<string | null>(null);
  const [gameStartTime, setGameStartTime] = useState<number>(0);
  const [lastAiInteraction, setLastAiInteraction] = useState<
    ChessSessionSnapshot["lastAiInteraction"]
  >(null);
  const [restoreSnapshot, setRestoreSnapshot] =
    useState<ChessSessionSnapshot | null>(null);

  // Refs for timer and AI
  const lastTickRef = useRef<number>(0);
  const aiRequestRef = useRef<boolean>(false);
  const aiRequestVersionRef = useRef(0);
  const activeAIAbortControllerRef = useRef<AbortController | null>(null);
  const matchSavedRef = useRef<boolean>(false);
  const autosaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latestSessionSnapshotRef = useRef<ChessSessionSnapshot | null>(null);
  const storageNeedsPassphraseRef = useRef(false);
  const persistenceTokenRef = useRef(0);
  const previousMoveCountRef = useRef(0);

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

  const invalidateAIRequests = useCallback(() => {
    aiRequestVersionRef.current += 1;
    activeAIAbortControllerRef.current?.abort();
    activeAIAbortControllerRef.current = null;
    aiRequestRef.current = false;
    return aiRequestVersionRef.current;
  }, []);

  const deleteActiveChessSession = useCallback(async () => {
    const token = invalidatePersistence();
    clearAutosaveTimer();
    latestSessionSnapshotRef.current = null;
    setRestoreSnapshot(null);

    try {
      const { needsPassphrase } = await ensureReady();
      if (token !== persistenceTokenRef.current) return;

      storageNeedsPassphraseRef.current = needsPassphrase;
      if (needsPassphrase) return;

      if (token !== persistenceTokenRef.current) return;
      deleteStoredGameSession(CHESS_ACTIVE_SESSION_ID);
    } catch (err) {
      console.warn("Failed to delete active chess session:", err);
    }
  }, [clearAutosaveTimer, invalidatePersistence]);

  const saveLatestChessSession = useCallback(async (token: number) => {
    if (token !== persistenceTokenRef.current) return;

    const snapshot = latestSessionSnapshotRef.current;
    if (!snapshot) return;

    try {
      const { needsPassphrase } = await ensureReady();
      if (token !== persistenceTokenRef.current) return;

      storageNeedsPassphraseRef.current = needsPassphrase;
      if (needsPassphrase) return;

      if (token !== persistenceTokenRef.current) return;
      upsertGameSession(createChessSessionRecord(snapshot));
    } catch (err) {
      console.warn("Failed to autosave chess session:", err);
    }
  }, []);

  // Load available models on mount (client-side only to avoid SSR issues with localStorage)
  useEffect(() => {
    // Ensure we're in the browser before accessing localStorage-dependent APIs
    if (typeof window === "undefined") return;

    let cancelled = false;

    async function loadModels() {
      try {
        const { needsPassphrase } = await ensureReady();
        if (cancelled || needsPassphrase) return;

        const models = getAvailableModels();
        setAvailableModels(
          models.map((m) => ({ id: m.modelId, name: m.displayName }))
        );
        if (models.length > 0) {
          setWhiteAI((prev) => ({ ...prev, modelId: models[0].modelId }));
          setBlackAI((prev) => ({ ...prev, modelId: models[0].modelId }));
        }
      } catch (err) {
        if (!cancelled) {
          // Silently handle errors during model loading (e.g., localStorage not available)
          console.warn("Failed to load available models:", err);
        }
      }
    }

    void loadModels();
    return () => {
      cancelled = true;
    };
  }, []);

  // Load an unfinished chess session on the setup screen.
  useEffect(() => {
    if (typeof window === "undefined") return;

    let cancelled = false;

    async function loadSavedSession() {
      try {
        const { needsPassphrase } = await ensureReady();
        if (cancelled) return;
        storageNeedsPassphraseRef.current = needsPassphrase;
        if (needsPassphrase) {
          setRestoreSnapshot(null);
          return;
        }

        const records = await listGameSessions();
        if (cancelled) return;

        const record = records.find(
          (session) =>
            session.id === CHESS_ACTIVE_SESSION_ID &&
            session.gameId === "chess" &&
            session.status !== "complete" &&
            session.status !== "abandoned"
        );
        const snapshot = record ? parseChessSessionRecord(record) : null;
        setRestoreSnapshot(
          snapshot &&
            (snapshot.isPaused || isChessActiveStatus(snapshot.gameState.status))
            ? snapshot
            : null
        );
      } catch (err) {
        if (!cancelled) {
          console.warn("Failed to load active chess session:", err);
        }
      }
    }

    void loadSavedSession();
    return () => {
      cancelled = true;
    };
  }, []);

  // Keep the latest serializable session in a ref so clock ticks do not
  // continuously postpone the debounced autosave.
  useEffect(() => {
    if (
      !gameStarted ||
      (!isPaused && !isChessActiveStatus(gameState.status))
    ) {
      latestSessionSnapshotRef.current = null;
      return;
    }

    latestSessionSnapshotRef.current = {
      gameMode,
      humanColor,
      whiteAI,
      blackAI,
      gameState,
      whiteTimeMs,
      blackTimeMs,
      whiteRemainingMs,
      blackRemainingMs,
      timeControl,
      gameStartTime,
      isPaused,
      lastAiInteraction,
    };
  }, [
    gameStarted,
    gameMode,
    humanColor,
    whiteAI,
    blackAI,
    gameState,
    whiteTimeMs,
    blackTimeMs,
    whiteRemainingMs,
    blackRemainingMs,
    timeControl,
    gameStartTime,
    isPaused,
    lastAiInteraction,
  ]);

  // Autosave active chess games after meaningful state changes.
  useEffect(() => {
    if (!latestSessionSnapshotRef.current || storageNeedsPassphraseRef.current) {
      return;
    }

    const token = persistenceTokenRef.current;
    clearAutosaveTimer();
    autosaveTimerRef.current = setTimeout(() => {
      void saveLatestChessSession(token);
    }, 400);

    return clearAutosaveTimer;
  }, [
    gameStarted,
    gameMode,
    humanColor,
    whiteAI,
    blackAI,
    gameState,
    timeControl,
    gameStartTime,
    isPaused,
    lastAiInteraction,
    clearAutosaveTimer,
    saveLatestChessSession,
  ]);

  // Clock ticks happen every 100ms; persist them on a coarse interval so a
  // long think or idle turn restores recent clock values without write spam.
  useEffect(() => {
    if (
      !gameStarted ||
      isPaused ||
      !isChessActiveStatus(gameState.status) ||
      storageNeedsPassphraseRef.current
    ) {
      return;
    }

    const interval = setInterval(() => {
      if (!latestSessionSnapshotRef.current || storageNeedsPassphraseRef.current) {
        return;
      }

      void saveLatestChessSession(persistenceTokenRef.current);
    }, CLOCK_AUTOSAVE_INTERVAL_MS);

    return () => clearInterval(interval);
  }, [gameStarted, isPaused, gameState.status, saveLatestChessSession]);

  // Check if current turn is AI controlled
  const isAIControlled = useCallback(
    (color: PieceColor): boolean => {
      if (gameMode === "pvp") return false;
      if (gameMode === "pvai") return color !== humanColor;
      return true; // aivai
    },
    [gameMode, humanColor]
  );

  // Get AI config for a color
  const getAIConfig = useCallback(
    (color: PieceColor): AIConfig => {
      if (gameMode === "pvai") {
        return color === humanColor ? whiteAI : blackAI;
      }
      return color === "white" ? whiteAI : blackAI;
    },
    [gameMode, humanColor, whiteAI, blackAI]
  );

  // Timer effect
  useEffect(() => {
    if (!gameStarted || isPaused || !isChessActiveStatus(gameState.status)) {
      return;
    }

    const isTimed = isTimedTimeControl(timeControl);
    const interval = setInterval(() => {
      const now = Date.now();
      if (lastTickRef.current === 0) {
        lastTickRef.current = now;
        return;
      }

      const delta = now - lastTickRef.current;
      lastTickRef.current = now;

      if (gameState.turn === "white") {
        setWhiteTimeMs((prev) => prev + delta);
        if (isTimed) {
          setWhiteRemainingMs((prev) =>
            prev === null ? prev : Math.max(0, prev - delta)
          );
        }
      } else {
        setBlackTimeMs((prev) => prev + delta);
        if (isTimed) {
          setBlackRemainingMs((prev) =>
            prev === null ? prev : Math.max(0, prev - delta)
          );
        }
      }
    }, 100);

    return () => clearInterval(interval);
  }, [gameStarted, isPaused, gameState.status, gameState.turn, timeControl]);

  useEffect(() => {
    if (
      !gameStarted ||
      isPaused ||
      !isTimedTimeControl(timeControl) ||
      !isChessActiveStatus(gameState.status)
    ) {
      return;
    }

    const timedOutColor =
      gameState.turn === "white" && whiteRemainingMs !== null && whiteRemainingMs <= 0
        ? "white"
        : gameState.turn === "black" &&
            blackRemainingMs !== null &&
            blackRemainingMs <= 0
          ? "black"
          : null;

    if (!timedOutColor) return;

    invalidateAIRequests();
    setPendingPromotion(null);
    setSelectedSquare(null);
    setLegalMoves([]);
    setAiThinking(false);
    setGameState((prev) =>
      isChessActiveStatus(prev.status) && prev.turn === timedOutColor
        ? {
            ...prev,
            status: "timeout",
            winner: oppositeColor(timedOutColor),
          }
        : prev
    );
  }, [
    blackRemainingMs,
    gameStarted,
    gameState.status,
    gameState.turn,
    invalidateAIRequests,
    isPaused,
    timeControl,
    whiteRemainingMs,
  ]);

  useEffect(() => {
    const currentMoveCount = gameState.moveHistory.length;
    const previousMoveCount = previousMoveCountRef.current;

    if (
      gameStarted &&
      currentMoveCount > previousMoveCount &&
      isTimedTimeControl(timeControl) &&
      timeControl.incrementMs > 0
    ) {
      const movedColor = oppositeColor(gameState.turn);
      if (movedColor === "white") {
        setWhiteRemainingMs((prev) =>
          prev === null ? prev : prev + timeControl.incrementMs
        );
      } else {
        setBlackRemainingMs((prev) =>
          prev === null ? prev : prev + timeControl.incrementMs
        );
      }
    }

    previousMoveCountRef.current = currentMoveCount;
  }, [
    gameStarted,
    gameState.moveHistory.length,
    gameState.turn,
    timeControl,
  ]);

  // AI move effect
  useEffect(() => {
    if (!gameStarted || isPaused || !isChessActiveStatus(gameState.status)) {
      return;
    }

    const currentTurn = gameState.turn;
    if (!isAIControlled(currentTurn)) {
      return;
    }

    if (aiRequestRef.current) {
      return;
    }

    const requestVersion = aiRequestVersionRef.current;
    const abortController = new AbortController();
    activeAIAbortControllerRef.current = abortController;
    const isCurrentAIRequest = () =>
      aiRequestVersionRef.current === requestVersion &&
      activeAIAbortControllerRef.current === abortController &&
      !abortController.signal.aborted;

    const makeAIMove = async () => {
      aiRequestRef.current = true;
      setAiThinking(true);
      setAiError(null);

      try {
        const config = getAIConfig(currentTurn);
        const apiKey = getModelApiKey(config.modelId) ?? "";
        const baseURL = getModelBaseURL(config.modelId);

        // Add delay for AI vs AI to make it watchable
        if (gameMode === "aivai") {
          await waitForAIDelay(500, abortController.signal);
          if (!isCurrentAIRequest()) return;
        }

        if (!isCurrentAIRequest()) return;
        const result = await requestAIMove({
          state: gameState,
          modelId: config.modelId,
          reasoningEffort: config.reasoningEffort,
          apiKey,
          baseURL,
          signal: abortController.signal,
        });

        if (!isCurrentAIRequest()) return;
        if ("move" in result) {
          setAiWarning(null);
          setLastAiInteraction(result.interaction);
          setGameState((prev) =>
            isLegalMove(prev, result.move) ? makeMove(prev, result.move) : prev
          );
        } else if ("error" in result) {
          const fallbackMove =
            gameMode === "aivai" && isRecoverableAIMoveError(result.error)
              ? chooseFallbackAIMove(gameState)
              : null;

          if (fallbackMove) {
            setAiWarning(
              `${colorLabel(currentTurn)} AI ${fallbackMoveReason(result.error)}. A legal fallback move was played so the AI vs AI match can continue.`
            );
            setLastAiInteraction({
              actorId: currentTurn,
              gesture: "confused",
              utterance:
                "I could not return valid move JSON, so the board used a legal fallback.",
              diagnostics: result.error,
            });
            setGameState((prev) =>
              prev.turn === currentTurn && isLegalMove(prev, fallbackMove)
                ? makeMove(prev, fallbackMove)
                : prev
            );
          } else {
            setAiWarning(null);
            setAiError(result.error);
          }
        }
      } catch (err) {
        if (!isCurrentAIRequest()) return;
        setAiWarning(null);
        setAiError(err instanceof Error ? err.message : "AI move failed");
      } finally {
        if (isCurrentAIRequest()) {
          setAiThinking(false);
          aiRequestRef.current = false;
          activeAIAbortControllerRef.current = null;
        }
      }
    };

    makeAIMove();
    return () => {
      if (activeAIAbortControllerRef.current === abortController) {
        abortController.abort();
        activeAIAbortControllerRef.current = null;
        aiRequestRef.current = false;
      }
    };
  }, [
    gameStarted,
    isPaused,
    gameState,
    isAIControlled,
    getAIConfig,
    gameMode,
  ]);

  // Save match record on game over
  useEffect(() => {
    if (
      !gameStarted ||
      matchSavedRef.current ||
      (gameState.status !== "checkmate" &&
        gameState.status !== "timeout" &&
        gameState.status !== "stalemate" &&
        gameState.status !== "draw")
    ) {
      return;
    }

    matchSavedRef.current = true;

    const record: GameMatchRecord = {
      id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      mode: gameMode,
      whiteModel:
        gameMode === "aivai" || (gameMode === "pvai" && humanColor === "black")
          ? whiteAI.modelId
          : undefined,
      blackModel:
        gameMode === "aivai" || (gameMode === "pvai" && humanColor === "white")
          ? blackAI.modelId
          : undefined,
      whiteReasoningEffort:
        gameMode !== "pvp" && isAIControlled("white")
          ? whiteAI.reasoningEffort
          : undefined,
      blackReasoningEffort:
        gameMode !== "pvp" && isAIControlled("black")
          ? blackAI.reasoningEffort
          : undefined,
      result:
        gameState.status === "checkmate" || gameState.status === "timeout"
          ? gameState.winner === "white"
            ? "white"
            : "black"
          : "draw",
      moves: gameState.moveHistory.length,
      durationMs: Date.now() - gameStartTime,
      whiteMoveMs: whiteTimeMs,
      blackMoveMs: blackTimeMs,
    };

    saveMatchRecord(record);
  }, [
    gameStarted,
    gameState.status,
    gameState.winner,
    gameState.moveHistory.length,
    gameMode,
    humanColor,
    whiteAI,
    blackAI,
    isAIControlled,
    gameStartTime,
    whiteTimeMs,
    blackTimeMs,
  ]);

  // Finished games are already represented by match records, so remove the
  // active restore point once a terminal state is reached.
  useEffect(() => {
    if (
      !gameStarted ||
      (gameState.status !== "checkmate" &&
        gameState.status !== "timeout" &&
        gameState.status !== "stalemate" &&
        gameState.status !== "draw")
    ) {
      return;
    }

    void deleteActiveChessSession();
  }, [gameStarted, gameState.status, deleteActiveChessSession]);

  const clearPendingPromotion = useCallback(() => {
    setPendingPromotion(null);
    setSelectedSquare(null);
    setLegalMoves([]);
  }, []);

  const clearBoardSelection = useCallback(() => {
    setSelectedSquare(null);
    setLegalMoves([]);
  }, []);

  const handlePromotionSelect = useCallback(
    (promotion: PromotionPieceType) => {
      if (!pendingPromotion) return;

      const move: Move = { ...pendingPromotion, promotion };
      setPendingPromotion(null);
      setSelectedSquare(null);
      setLegalMoves([]);
      setGameState((prev) =>
        isLegalMove(prev, move) ? makeMove(prev, move) : prev
      );
    },
    [pendingPromotion]
  );

  // Handle square click for human moves
  const handleSquareClick = useCallback(
    (square: Square) => {
      if (
        pendingPromotion ||
        isPaused ||
        !isChessActiveStatus(gameState.status) ||
        aiThinking
      ) {
        return;
      }

      if (isAIControlled(gameState.turn)) {
        return;
      }

      const piece = getPiece(gameState, square);

      // If no square selected, select piece of current turn
      if (!selectedSquare) {
        if (piece && piece.color === gameState.turn) {
          setSelectedSquare(square);
          setLegalMoves(generateLegalMovesFromSquare(gameState, square));
        }
        return;
      }

      // If clicking same square, deselect
      if (selectedSquare === square) {
        setSelectedSquare(null);
        setLegalMoves([]);
        return;
      }

      // If clicking own piece, switch selection
      if (piece && piece.color === gameState.turn) {
        setSelectedSquare(square);
        setLegalMoves(generateLegalMovesFromSquare(gameState, square));
        return;
      }

      // Try to make move
      const move: Move = { from: selectedSquare, to: square };

      // Check for pawn promotion
      const movingPiece = getPiece(gameState, selectedSquare);
      if (movingPiece?.type === "pawn") {
        const targetRank = square[1];
        if (
          (movingPiece.color === "white" && targetRank === "8") ||
          (movingPiece.color === "black" && targetRank === "1")
        ) {
          const legalPromotionMoves = generateLegalMovesFromSquare(
            gameState,
            selectedSquare
          ).filter(
            (legalMove) => legalMove.to === square && legalMove.promotion
          );

          if (legalPromotionMoves.length > 0) {
            setPendingPromotion({ from: selectedSquare, to: square });
            return;
          }
        }
      }

      if (isLegalMove(gameState, move)) {
        setGameState((prev) => makeMove(prev, move));
        setSelectedSquare(null);
        setLegalMoves([]);
      } else {
        // Invalid move, deselect
        setSelectedSquare(null);
        setLegalMoves([]);
      }
    },
    [
      gameState,
      selectedSquare,
      pendingPromotion,
      isPaused,
      aiThinking,
      isAIControlled,
    ]
  );

  const handleSquareDrag = useCallback(
    (from: Square, to: Square) => {
      if (
        from === to ||
        pendingPromotion ||
        isPaused ||
        !isChessActiveStatus(gameState.status) ||
        aiThinking ||
        isAIControlled(gameState.turn)
      ) {
        return;
      }

      const movingPiece = getPiece(gameState, from);
      if (!movingPiece || movingPiece.color !== gameState.turn) {
        return;
      }

      const move: Move = { from, to };

      if (movingPiece.type === "pawn") {
        const targetRank = to[1];
        if (
          (movingPiece.color === "white" && targetRank === "8") ||
          (movingPiece.color === "black" && targetRank === "1")
        ) {
          const legalPromotionMoves = generateLegalMovesFromSquare(
            gameState,
            from
          ).filter(
            (legalMove) => legalMove.to === to && legalMove.promotion
          );

          if (legalPromotionMoves.length > 0) {
            setPendingPromotion({ from, to });
            setSelectedSquare(null);
            setLegalMoves([]);
            return;
          }
        }
      }

      if (isLegalMove(gameState, move)) {
        setGameState((prev) => makeMove(prev, move));
      }

      setSelectedSquare(null);
      setLegalMoves([]);
    },
    [
      aiThinking,
      gameState,
      isAIControlled,
      isPaused,
      pendingPromotion,
    ]
  );

  // Handle reset
  const handleReset = useCallback(() => {
    invalidateAIRequests();
    void deleteActiveChessSession();
    setGameState(createInitialState());
    clearPendingPromotion();
    setWhiteTimeMs(0);
    setBlackTimeMs(0);
    setWhiteRemainingMs(initialRemainingMs(timeControl));
    setBlackRemainingMs(initialRemainingMs(timeControl));
    setIsPaused(false);
    setAiThinking(false);
    setAiError(null);
    setAiWarning(null);
    setLastAiInteraction(null);
    lastTickRef.current = 0;
    previousMoveCountRef.current = 0;
    matchSavedRef.current = false;
    setGameStarted(false);
  }, [
    clearPendingPromotion,
    deleteActiveChessSession,
    invalidateAIRequests,
    timeControl,
  ]);

  // Handle pause
  const handlePause = useCallback(() => {
    invalidateAIRequests();
    invalidatePersistence();
    clearPendingPromotion();
    setAiThinking(false);
    setIsPaused(true);
    lastTickRef.current = 0;
  }, [clearPendingPromotion, invalidateAIRequests, invalidatePersistence]);

  // Handle resume
  const handleResume = useCallback(() => {
    invalidateAIRequests();
    invalidatePersistence();
    setAiThinking(false);
    setIsPaused(false);
    lastTickRef.current = Date.now();
  }, [invalidateAIRequests, invalidatePersistence]);

  // Start game
  const handleStartGame = useCallback(() => {
    invalidateAIRequests();
    invalidatePersistence();
    clearPendingPromotion();
    setGameState(createInitialState());
    setWhiteTimeMs(0);
    setBlackTimeMs(0);
    setWhiteRemainingMs(initialRemainingMs(timeControl));
    setBlackRemainingMs(initialRemainingMs(timeControl));
    setGameStartTime(Date.now());
    setLastAiInteraction(null);
    setRestoreSnapshot(null);
    setAiThinking(false);
    setAiError(null);
    setAiWarning(null);
    lastTickRef.current = Date.now();
    previousMoveCountRef.current = 0;
    matchSavedRef.current = false;
    setGameStarted(true);
  }, [
    clearPendingPromotion,
    invalidateAIRequests,
    invalidatePersistence,
    timeControl,
  ]);

  const applyImportedSnapshot = useCallback(
    (snapshot: ChessSessionSnapshot) => {
      invalidateAIRequests();
      invalidatePersistence();
      clearPendingPromotion();
      setGameMode(snapshot.gameMode);
      setHumanColor(snapshot.humanColor);
      setWhiteAI(snapshot.whiteAI);
      setBlackAI(snapshot.blackAI);
      setGameState(snapshot.gameState);
      setWhiteTimeMs(snapshot.whiteTimeMs);
      setBlackTimeMs(snapshot.blackTimeMs);
      setWhiteRemainingMs(snapshot.whiteRemainingMs);
      setBlackRemainingMs(snapshot.blackRemainingMs);
      setTimeControl(snapshot.timeControl);
      if (snapshot.timeControl.mode === CUSTOM_TIME_CONTROL_MODE) {
        setCustomMinutes(formatCustomMinutes(snapshot.timeControl.initialMs));
        setCustomIncrementSeconds(
          String(Math.round(snapshot.timeControl.incrementMs / 1000))
        );
      }
      setGameStartTime(snapshot.gameStartTime);
      setIsPaused(snapshot.isPaused);
      setLastAiInteraction(snapshot.lastAiInteraction);
      setRestoreSnapshot(null);
      setAiThinking(false);
      setAiError(null);
      setAiWarning(null);
      setSelectedSquare(null);
      setLegalMoves([]);
      aiRequestRef.current = false;
      matchSavedRef.current = !isChessActiveStatus(snapshot.gameState.status);
      previousMoveCountRef.current = snapshot.gameState.moveHistory.length;
      lastTickRef.current = snapshot.isPaused ? 0 : Date.now();
      setGameStarted(true);
    },
    [clearPendingPromotion, invalidateAIRequests, invalidatePersistence]
  );

  const confirmImportOverwrite = useCallback(() => {
    if (!gameStarted) return true;
    return window.confirm(
      "Importing a chess game will replace the current board. Continue?"
    );
  }, [gameStarted]);

  const handleResumeSavedGame = useCallback(() => {
    if (!restoreSnapshot) return;

    invalidateAIRequests();
    invalidatePersistence();
    setGameMode(restoreSnapshot.gameMode);
    setHumanColor(restoreSnapshot.humanColor);
    setWhiteAI(restoreSnapshot.whiteAI);
    setBlackAI(restoreSnapshot.blackAI);
    setGameState(restoreSnapshot.gameState);
    setWhiteTimeMs(restoreSnapshot.whiteTimeMs);
    setBlackTimeMs(restoreSnapshot.blackTimeMs);
    setWhiteRemainingMs(restoreSnapshot.whiteRemainingMs);
    setBlackRemainingMs(restoreSnapshot.blackRemainingMs);
    setTimeControl(restoreSnapshot.timeControl);
    if (restoreSnapshot.timeControl.mode === "custom") {
      setCustomMinutes(formatCustomMinutes(restoreSnapshot.timeControl.initialMs));
      setCustomIncrementSeconds(
        String(Math.round(restoreSnapshot.timeControl.incrementMs / 1000))
      );
    }
    setGameStartTime(restoreSnapshot.gameStartTime);
    setIsPaused(restoreSnapshot.isPaused);
    setLastAiInteraction(restoreSnapshot.lastAiInteraction);
    clearPendingPromotion();
    setAiThinking(false);
    setAiError(null);
    setAiWarning(null);
    aiRequestRef.current = false;
    matchSavedRef.current = false;
    previousMoveCountRef.current = restoreSnapshot.gameState.moveHistory.length;
    lastTickRef.current = restoreSnapshot.isPaused ? 0 : Date.now();
    setRestoreSnapshot(null);
    setGameStarted(true);
  }, [
    clearPendingPromotion,
    invalidateAIRequests,
    invalidatePersistence,
    restoreSnapshot,
  ]);

  const handleStartNewGame = useCallback(() => {
    invalidateAIRequests();
    clearPendingPromotion();
    setAiThinking(false);
    setAiError(null);
    setAiWarning(null);
    void deleteActiveChessSession();
  }, [clearPendingPromotion, deleteActiveChessSession, invalidateAIRequests]);

  const handleGameModeChange = useCallback(
    (mode: GameMode) => {
      invalidateAIRequests();
      clearPendingPromotion();
      setAiThinking(false);
      setAiError(null);
      setAiWarning(null);
      setGameMode(mode);
    },
    [clearPendingPromotion, invalidateAIRequests]
  );

  const handleTimeControlSelect = useCallback(
    (selected: ChessTimeControl) => {
      setTimeControl(selected);
      if (selected.mode === CUSTOM_TIME_CONTROL_MODE) {
        setTimeControl(
          createCustomTimeControl(customMinutes, customIncrementSeconds)
        );
      }
    },
    [customIncrementSeconds, customMinutes]
  );

  const handleCustomMinutesChange = useCallback(
    (value: string) => {
      setCustomMinutes(value);
      if (timeControl.mode === CUSTOM_TIME_CONTROL_MODE) {
        setTimeControl(createCustomTimeControl(value, customIncrementSeconds));
      }
    },
    [customIncrementSeconds, timeControl.mode]
  );

  const handleCustomIncrementChange = useCallback(
    (value: string) => {
      setCustomIncrementSeconds(value);
      if (timeControl.mode === CUSTOM_TIME_CONTROL_MODE) {
        setTimeControl(createCustomTimeControl(customMinutes, value));
      }
    },
    [customMinutes, timeControl.mode]
  );

  // Auto orientation follows the human side in player-vs-AI games.
  const autoBoardFlipped = gameMode === "pvai" && humanColor === "black";
  const boardFlipped =
    boardOrientation === "black" ||
    (boardOrientation === "auto" && autoBoardFlipped);
  const activeGameStatus = isChessActiveStatus(gameState.status);
  const isTimedGame = isTimedTimeControl(timeControl);
  const showGameStatus =
    gameState.status === "check" ||
    (!activeGameStatus && gameState.status !== "paused");
  const capturedPieces = useMemo(
    () => getCapturedPiecesByPlayer(gameState),
    [gameState]
  );
  const getBoardPlayer = useCallback(
    (color: PieceColor): BoardPlayerSummary => {
      const isAI =
        gameMode === "aivai" ||
        (gameMode === "pvai" && humanColor !== color);
      const label = colorLabel(color);

      if (!isAI) {
        return {
          color,
          title:
            gameMode === "pvai" && humanColor === color
              ? `You (${label})`
              : `${label} Player`,
          subtitle: label,
          kind: "human",
        };
      }

      const config = color === "white" ? whiteAI : blackAI;
      const modelName =
        availableModels.find((model) => model.id === config.modelId)?.name ||
        config.modelId ||
        `${label} AI`;

      return {
        color,
        title: modelName,
        subtitle: `${label} AI`,
        kind: "ai",
      };
    },
    [availableModels, blackAI, gameMode, humanColor, whiteAI]
  );
  const topBoardPlayer = getBoardPlayer(boardFlipped ? "white" : "black");
  const bottomBoardPlayer = getBoardPlayer(boardFlipped ? "black" : "white");
  const exportSnapshot = useMemo<ChessSessionSnapshot>(
    () => ({
      gameMode,
      humanColor,
      whiteAI,
      blackAI,
      gameState,
      whiteTimeMs,
      blackTimeMs,
      whiteRemainingMs,
      blackRemainingMs,
      timeControl,
      gameStartTime,
      isPaused,
      lastAiInteraction,
    }),
    [
      blackAI,
      blackRemainingMs,
      blackTimeMs,
      gameMode,
      gameStartTime,
      gameState,
      humanColor,
      isPaused,
      lastAiInteraction,
      timeControl,
      whiteAI,
      whiteRemainingMs,
      whiteTimeMs,
    ]
  );
  const exportMetadata = useMemo<ChessPgnMetadata>(() => {
    const playerLabel = (color: PieceColor) => {
      const isAI =
        gameMode === "aivai" ||
        (gameMode === "pvai" && humanColor !== color);
      if (!isAI) return color === "white" ? "White Player" : "Black Player";

      const config = color === "white" ? whiteAI : blackAI;
      return config.modelId || (color === "white" ? "White AI" : "Black AI");
    };

    return {
      date: gameStartTime > 0 ? new Date(gameStartTime) : undefined,
      white: playerLabel("white"),
      black: playerLabel("black"),
    };
  }, [blackAI, gameMode, gameStartTime, humanColor, whiteAI]);

  useEffect(() => {
    if (!pendingPromotion) return;

    const movingPiece = getPiece(gameState, pendingPromotion.from);
    const targetRank = pendingPromotion.to[1];
    const isPromotionTarget =
      movingPiece?.type === "pawn" &&
      movingPiece.color === gameState.turn &&
      ((movingPiece.color === "white" && targetRank === "8") ||
        (movingPiece.color === "black" && targetRank === "1"));
    const hasLegalPromotion = PROMOTION_PIECES.some((promotion) =>
      isLegalMove(gameState, { ...pendingPromotion, promotion })
    );

    if (
      !gameStarted ||
      isPaused ||
      aiThinking ||
      !activeGameStatus ||
      isAIControlled(gameState.turn) ||
      !isPromotionTarget ||
      !hasLegalPromotion
    ) {
      clearPendingPromotion();
    }
  }, [
    activeGameStatus,
    aiThinking,
    clearPendingPromotion,
    gameStarted,
    gameState,
    isAIControlled,
    isPaused,
    pendingPromotion,
  ]);

  // Last move for highlighting
  const lastMove = useMemo(() => {
    const history = gameState.moveHistory;
    return history.length > 0 ? history[history.length - 1].move : null;
  }, [gameState.moveHistory]);

  // Check if start button should be disabled (only for AI modes without models)
  const isStartDisabled = gameMode !== "pvp" && availableModels.length === 0;

  // Render setup screen
  if (!gameStarted) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-amber-50 via-orange-50 to-yellow-50 dark:from-gray-900 dark:via-gray-850 dark:to-gray-900">
        <div className="container mx-auto px-4 py-8 max-w-5xl">
          {/* Header */}
          <div className="text-center mb-8">
            <h1 className="text-4xl font-bold text-gray-900 dark:text-white mb-2">
              ♟️ Chess
            </h1>
            <p className="text-gray-600 dark:text-gray-400">
              Configure your game and start playing
            </p>
          </div>

          {/* Main layout: Config on left, Board preview on right */}
          <div className="flex flex-col lg:flex-row gap-8 items-start justify-center">
            {/* Setup Card */}
            <div className="w-full lg:w-[450px] bg-white dark:bg-gray-800 rounded-2xl shadow-xl p-6 space-y-6">
              {restoreSnapshot && (
                <div
                  className="flex flex-col gap-3 rounded-lg border border-amber-200 bg-amber-50 p-3 dark:border-amber-800 dark:bg-amber-950/30"
                  data-testid="restore-game-banner"
                >
                  <div>
                    <div className="text-sm font-semibold text-amber-950 dark:text-amber-100">
                      Unfinished chess game
                    </div>
                    <div className="text-xs text-amber-800 dark:text-amber-300">
                      {restoreSnapshot.gameState.moveHistory.length} move
                      {restoreSnapshot.gameState.moveHistory.length === 1
                        ? ""
                        : "s"}{" "}
                      saved
                    </div>
                  </div>
                  <div className="flex gap-2">
                    <button
                      onClick={handleResumeSavedGame}
                      className="flex-1 rounded-md bg-amber-600 px-3 py-2 text-sm font-semibold text-white transition-colors hover:bg-amber-700"
                      data-testid="resume-game-button"
                    >
                      Resume game
                    </button>
                    <button
                      onClick={handleStartNewGame}
                      className="flex-1 rounded-md border border-amber-300 bg-white px-3 py-2 text-sm font-semibold text-amber-900 transition-colors hover:bg-amber-100 dark:border-amber-700 dark:bg-gray-900 dark:text-amber-100 dark:hover:bg-amber-950"
                      data-testid="start-new-game-button"
                    >
                      Start new
                    </button>
                  </div>
                </div>
              )}

              {/* Game Mode Selection */}
              <div>
                <label className="block text-sm font-semibold text-gray-700 dark:text-gray-300 mb-3">
                  Game Mode
                </label>
                <div className="grid grid-cols-1 gap-3">
                  {GAME_MODES.map((mode) => (
                    <button
                      key={mode.value}
                      onClick={() => handleGameModeChange(mode.value)}
                      className={cn(
                        "p-4 rounded-xl border-2 transition-all text-left",
                        gameMode === mode.value
                          ? "border-amber-500 bg-amber-50 dark:bg-amber-900/20"
                          : "border-gray-200 dark:border-gray-700 hover:border-amber-300"
                      )}
                      data-testid={`game-mode-${mode.value}`}
                    >
                      <div className="font-semibold text-gray-900 dark:text-white">
                        {mode.label}
                      </div>
                      <div className="text-sm text-gray-500 dark:text-gray-400">
                        {mode.description}
                      </div>
                    </button>
                  ))}
                </div>
              </div>

              {/* Human Color Selection (for PvAI) */}
              {gameMode === "pvai" && (
                <div>
                  <label className="block text-sm font-semibold text-gray-700 dark:text-gray-300 mb-3">
                    Play as
                  </label>
                  <div className="flex gap-3">
                    <button
                      onClick={() => setHumanColor("white")}
                      className={cn(
                        "flex-1 p-3 rounded-xl border-2 transition-all flex items-center justify-center gap-2",
                        humanColor === "white"
                          ? "border-amber-500 bg-amber-50 dark:bg-amber-900/20"
                          : "border-gray-200 dark:border-gray-700 hover:border-amber-300"
                      )}
                      data-testid="color-white"
                    >
                      <div className="w-6 h-6 rounded-full bg-white border-2 border-gray-300" />
                      <span className="font-medium text-gray-900 dark:text-white">
                        White
                      </span>
                    </button>
                    <button
                      onClick={() => setHumanColor("black")}
                      className={cn(
                        "flex-1 p-3 rounded-xl border-2 transition-all flex items-center justify-center gap-2",
                        humanColor === "black"
                          ? "border-amber-500 bg-amber-50 dark:bg-amber-900/20"
                          : "border-gray-200 dark:border-gray-700 hover:border-amber-300"
                      )}
                      data-testid="color-black"
                    >
                      <div className="w-6 h-6 rounded-full bg-gray-900 border-2 border-gray-600" />
                      <span className="font-medium text-gray-900 dark:text-white">
                        Black
                      </span>
                    </button>
                  </div>
                </div>
              )}

              {/* Time Control Selection */}
              <div>
                <label className="block text-sm font-semibold text-gray-700 dark:text-gray-300 mb-3">
                  Time Control
                </label>
                <div className="grid grid-cols-2 gap-2">
                  {TIME_CONTROLS.map((control) => (
                    <button
                      key={control.mode}
                      type="button"
                      onClick={() => handleTimeControlSelect(control)}
                      aria-pressed={timeControl.mode === control.mode}
                      className={cn(
                        "rounded-lg border-2 px-3 py-2 text-left transition-all",
                        "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-500",
                        timeControl.mode === control.mode
                          ? "border-amber-500 bg-amber-50 dark:bg-amber-900/20"
                          : "border-gray-200 hover:border-amber-300 dark:border-gray-700"
                      )}
                      data-testid={`time-control-${control.mode}`}
                    >
                      <div className="text-sm font-semibold text-gray-900 dark:text-white">
                        {control.label}
                      </div>
                    </button>
                  ))}
                  <button
                    type="button"
                    onClick={() =>
                      handleTimeControlSelect(
                        createCustomTimeControl(
                          customMinutes,
                          customIncrementSeconds
                        )
                      )
                    }
                    aria-pressed={timeControl.mode === CUSTOM_TIME_CONTROL_MODE}
                    className={cn(
                      "rounded-lg border-2 px-3 py-2 text-left transition-all",
                      "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-500",
                      timeControl.mode === CUSTOM_TIME_CONTROL_MODE
                        ? "border-amber-500 bg-amber-50 dark:bg-amber-900/20"
                        : "border-gray-200 hover:border-amber-300 dark:border-gray-700"
                    )}
                    data-testid="time-control-custom"
                  >
                    <div className="text-sm font-semibold text-gray-900 dark:text-white">
                      Custom
                    </div>
                    <div className="text-xs text-gray-500 dark:text-gray-400">
                      Minutes + increment
                    </div>
                  </button>
                </div>
                {timeControl.mode === CUSTOM_TIME_CONTROL_MODE && (
                  <div className="mt-3 grid grid-cols-2 gap-3">
                    <label className="block">
                      <span className="mb-1 block text-xs font-medium text-gray-600 dark:text-gray-400">
                        Minutes
                      </span>
                      <input
                        type="number"
                        min="0.02"
                        step="0.01"
                        value={customMinutes}
                        onChange={(e) =>
                          handleCustomMinutesChange(e.target.value)
                        }
                        className={cn(
                          "w-full rounded-lg border p-2 text-sm",
                          "border-gray-300 bg-white text-gray-900",
                          "focus:border-amber-500 focus:ring-2 focus:ring-amber-500",
                          "dark:border-gray-600 dark:bg-gray-800 dark:text-white"
                        )}
                        data-testid="custom-time-minutes"
                      />
                    </label>
                    <label className="block">
                      <span className="mb-1 block text-xs font-medium text-gray-600 dark:text-gray-400">
                        Increment seconds
                      </span>
                      <input
                        type="number"
                        min="0"
                        step="1"
                        value={customIncrementSeconds}
                        onChange={(e) =>
                          handleCustomIncrementChange(e.target.value)
                        }
                        className={cn(
                          "w-full rounded-lg border p-2 text-sm",
                          "border-gray-300 bg-white text-gray-900",
                          "focus:border-amber-500 focus:ring-2 focus:ring-amber-500",
                          "dark:border-gray-600 dark:bg-gray-800 dark:text-white"
                        )}
                        data-testid="custom-time-increment"
                      />
                    </label>
                  </div>
                )}
              </div>

              {/* AI Configuration */}
              {gameMode !== "pvp" && (
                <div className="space-y-4">
                  {/* White AI Config (for AIvAI or when human is black) */}
                  {(gameMode === "aivai" ||
                    (gameMode === "pvai" && humanColor === "black")) && (
                    <AIConfigPanel
                      title="White AI"
                      color="white"
                      config={whiteAI}
                      onChange={setWhiteAI}
                      models={availableModels}
                    />
                  )}

                  {/* Black AI Config (for AIvAI or when human is white) */}
                  {(gameMode === "aivai" ||
                    (gameMode === "pvai" && humanColor === "white")) && (
                    <AIConfigPanel
                      title="Black AI"
                      color="black"
                      config={blackAI}
                      onChange={setBlackAI}
                      models={availableModels}
                    />
                  )}
                </div>
              )}

              {/* Start Button */}
              <button
                onClick={handleStartGame}
                disabled={isStartDisabled}
                className={cn(
                  "w-full py-4 rounded-xl font-semibold text-lg transition-all",
                  "bg-gradient-to-r from-amber-500 to-orange-500 text-white",
                  "hover:from-amber-600 hover:to-orange-600",
                  "disabled:opacity-50 disabled:cursor-not-allowed",
                  "shadow-lg hover:shadow-xl"
                )}
                data-testid="start-game-button"
              >
                Start Game
              </button>

              {isStartDisabled && (
                <p className="text-center text-sm text-red-500">
                  No AI models configured. Please add models in Settings first.
                </p>
              )}

              <div className="pt-2">
                <ImportGameMenu
                  onImport={applyImportedSnapshot}
                  onBeforeImport={confirmImportOverwrite}
                  className="w-full"
                />
              </div>
            </div>

            {/* Board Preview */}
            <div className="w-full lg:flex-1 flex flex-col items-center">
              <div className="text-center mb-4">
                <h2 className="text-lg font-semibold text-gray-700 dark:text-gray-300">
                  Board Preview
                </h2>
                <p className="text-sm text-gray-500 dark:text-gray-400">
                  Starting position
                </p>
              </div>
              <div style={{ width: "100%", maxWidth: "500px" }}>
                <ChessBoard
                  state={gameState}
                  interactive={false}
                  flipped={boardFlipped}
                />
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // Render game screen
  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-100 via-stone-50 to-emerald-50 dark:from-slate-950 dark:via-slate-900 dark:to-slate-950">
      <div className="container mx-auto px-4 py-6">
        {/* Header */}
        <div className="text-center mb-6">
          <h1 className="text-3xl font-bold text-gray-900 dark:text-white">
            ♟️ Chess
          </h1>
          <p className="text-sm text-gray-600 dark:text-gray-400 mt-1">
            {gameMode === "pvp" && "Player vs Player"}
            {gameMode === "pvai" && `You (${humanColor}) vs AI`}
            {gameMode === "aivai" && "AI vs AI"}
          </p>
        </div>

        {/* Main Layout: Board + Controls */}
        <div className="flex flex-col lg:flex-row gap-6 items-start justify-center">
          {/* Chess Board Container */}
          <div className="w-full flex-shrink-0 lg:flex-1 lg:max-w-[860px]">
            <div className="grid w-full items-stretch gap-3 md:grid-cols-[minmax(84px,112px)_minmax(320px,600px)_minmax(84px,112px)]">
              <CapturedPieces
                player="white"
                pieces={capturedPieces.white}
                className="order-2 md:order-1 md:min-h-full"
              />
              <div className="order-1 flex flex-col gap-2 md:order-2">
                <BoardPlayerCard
                  player={topBoardPlayer}
                  active={
                    activeGameStatus && gameState.turn === topBoardPlayer.color
                  }
                  testId="board-player-top"
                />
                <div className="rounded-2xl border border-slate-200/80 bg-white/70 p-2 shadow-2xl shadow-slate-900/10 dark:border-slate-700/80 dark:bg-slate-950/60 dark:shadow-black/35 sm:p-3">
                  <ChessBoard
                    state={gameState}
                    onSquareClick={handleSquareClick}
                    onSquareDrag={handleSquareDrag}
                    onClearSelection={clearBoardSelection}
                    selectedSquare={selectedSquare}
                    legalMoves={legalMoves}
                    lastMove={lastMove}
                    flipped={boardFlipped}
                    interactive={
                      !pendingPromotion && !aiThinking && !isPaused && activeGameStatus
                    }
                  />
                </div>
                <BoardPlayerCard
                  player={bottomBoardPlayer}
                  active={
                    activeGameStatus && gameState.turn === bottomBoardPlayer.color
                  }
                  testId="board-player-bottom"
                />
              </div>
              <CapturedPieces
                player="black"
                pieces={capturedPieces.black}
                className="order-3 md:min-h-full"
              />
            </div>
          </div>

          {/* Control Panel */}
          <div className="w-full lg:w-96 lg:max-w-[36%] space-y-4">
            {/* Clocks */}
            <div className="flex flex-col gap-3">
              <ChessClock
                color="black"
                timeMs={isTimedGame ? blackRemainingMs ?? 0 : blackTimeMs}
                isTimed={isTimedGame}
                isActive={gameState.turn === "black" && activeGameStatus}
                isPaused={isPaused}
              />
              <ChessClock
                color="white"
                timeMs={isTimedGame ? whiteRemainingMs ?? 0 : whiteTimeMs}
                isTimed={isTimedGame}
                isActive={gameState.turn === "white" && activeGameStatus}
                isPaused={isPaused}
              />
            </div>

            {/* Game Status */}
            {showGameStatus && (
              <div
                className={cn(
                  "p-4 rounded-xl text-center font-semibold",
                  gameState.status === "checkmate" &&
                    "bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-300",
                  gameState.status === "check" &&
                    "bg-yellow-100 dark:bg-yellow-900/30 text-yellow-700 dark:text-yellow-300",
                  gameState.status === "timeout" &&
                    "bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-300",
                  (gameState.status === "stalemate" ||
                    gameState.status === "draw") &&
                    "bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300"
                )}
                data-testid="game-status"
              >
                {gameState.status === "checkmate" &&
                  `Checkmate! ${gameState.winner === "white" ? "White" : "Black"} wins!`}
                {gameState.status === "check" && "Check!"}
                {gameState.status === "timeout" &&
                  `Timeout! ${gameState.winner === "white" ? "White" : "Black"} wins on time!`}
                {gameState.status === "stalemate" && "Stalemate - Draw!"}
                {gameState.status === "draw" && "Draw!"}
              </div>
            )}

            {/* AI Thinking Indicator */}
            {aiThinking && (
              <div
                className="p-4 rounded-xl bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300 flex items-center gap-3"
                data-testid="ai-thinking"
              >
                <div className="animate-spin w-5 h-5 border-2 border-blue-500 border-t-transparent rounded-full" />
                <span>AI is thinking...</span>
              </div>
            )}

            {/* AI Error */}
            {aiError && (
              <div
                className="p-4 rounded-xl bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-300"
                data-testid="ai-error"
              >
                <div className="font-semibold mb-1">AI Error</div>
                <div className="text-sm">{aiError}</div>
              </div>
            )}

            {/* AI Warning */}
            {aiWarning && (
              <div
                className="p-4 rounded-xl bg-amber-100 text-amber-800 dark:bg-amber-950/40 dark:text-amber-200"
                data-testid="ai-warning"
              >
                <div className="font-semibold mb-1">AI fallback move</div>
                <div className="text-sm">{aiWarning}</div>
              </div>
            )}

            <AIPresence interaction={lastAiInteraction} />

            {/* Game Controls */}
            <div className="flex flex-wrap items-start gap-3">
              <div className="min-w-[220px] flex-1">
                <GameControls
                  onReset={handleReset}
                  onPause={handlePause}
                  onResume={handleResume}
                  isPaused={isPaused}
                  gameStatus={gameState.status}
                  canPause={!aiThinking}
                />
              </div>
              <div
                className="min-w-[220px] flex-1 rounded-xl border border-gray-200 bg-white p-4 shadow-sm dark:border-gray-700 dark:bg-gray-900"
                data-testid="board-orientation-controls"
              >
                <div className="mb-3 text-center text-sm font-semibold text-gray-700 dark:text-gray-300">
                  Board View
                </div>
                <div className="grid grid-cols-3 gap-1 rounded-lg bg-gray-100 p-1 dark:bg-gray-800">
                  {BOARD_ORIENTATIONS.map((orientation) => (
                    <button
                      key={orientation.value}
                      type="button"
                      onClick={() => setBoardOrientation(orientation.value)}
                      aria-pressed={boardOrientation === orientation.value}
                      className={cn(
                        "rounded-md px-2 py-2 text-sm font-medium transition-colors",
                        "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-500",
                        boardOrientation === orientation.value
                          ? "bg-white text-amber-700 shadow-sm dark:bg-gray-700 dark:text-amber-300"
                          : "text-gray-600 hover:bg-white/70 dark:text-gray-300 dark:hover:bg-gray-700/70"
                      )}
                      data-testid={`board-orientation-${orientation.value}`}
                    >
                      {orientation.label}
                    </button>
                  ))}
                </div>
              </div>
              <ExportGameMenu
                state={gameState}
                snapshot={exportSnapshot}
                metadata={exportMetadata}
                className="min-w-36 flex-1 sm:flex-none lg:flex-1"
              />
              <ImportGameMenu
                onImport={applyImportedSnapshot}
                onBeforeImport={confirmImportOverwrite}
                className="min-w-36 flex-1 sm:flex-none lg:flex-1"
              />
            </div>

            {/* Move History */}
            <MoveHistory moves={gameState.moveHistory} />
          </div>
        </div>
      </div>
      {pendingPromotion && (
        <PromotionDialog
          onCancel={clearPendingPromotion}
          onSelect={handlePromotionSelect}
        />
      )}
    </div>
  );
}

export default GamesClient;
