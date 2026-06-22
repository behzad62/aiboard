"use client";

import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { cn } from "@/lib/utils";
import { ChessBoard } from "@/components/games/ChessBoard";
import { ChessClock } from "@/components/games/chess/ChessClock";
import { MoveHistory } from "@/components/games/chess/MoveHistory";
import { GameControls } from "@/components/games/chess/GameControls";
import {
  createInitialState,
  makeMove,
  generateLegalMovesFromSquare,
  isLegalMove,
  getPiece,
} from "@/lib/games/chess/engine";
import {
  requestAIMove,
  getAvailableModels,
  getModelApiKey,
  getModelBaseURL,
} from "@/lib/games/chess/ai";
import type {
  GameState,
  Square,
  Move,
  GameMode,
  PieceColor,
  GameMatchRecord,
} from "@/lib/games/chess/types";
import type { ReasoningEffort } from "@/lib/db/schema";
import { saveMatchRecord } from "@/lib/games/stats";

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

interface AIConfig {
  modelId: string;
  reasoningEffort: ReasoningEffort;
}

export function GamesClient() {
  // Setup state
  const [gameStarted, setGameStarted] = useState(false);
  const [gameMode, setGameMode] = useState<GameMode>("pvp");
  const [humanColor, setHumanColor] = useState<PieceColor>("white");
  const [availableModels, setAvailableModels] = useState<
    { modelId: string; displayName: string; providerId: string }[]
  >([]);
  const [whiteAI, setWhiteAI] = useState<AIConfig>({
    modelId: "",
    reasoningEffort: "default",
  });
  const [blackAI, setBlackAI] = useState<AIConfig>({
    modelId: "",
    reasoningEffort: "default",
  });

  // Game state
  const [gameState, setGameState] = useState<GameState>(createInitialState);
  const [selectedSquare, setSelectedSquare] = useState<Square | null>(null);
  const [legalMoves, setLegalMoves] = useState<Move[]>([]);
  const [isPaused, setIsPaused] = useState(false);
  const [whiteTimeMs, setWhiteTimeMs] = useState(0);
  const [blackTimeMs, setBlackTimeMs] = useState(0);
  const [aiThinking, setAiThinking] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);
  const [gameStartTime, setGameStartTime] = useState<number>(0);

  // Refs for timer and AI
  const lastTickRef = useRef<number>(0);
  const aiRequestRef = useRef<boolean>(false);
  const matchSavedRef = useRef<boolean>(false);

  // Load available models on mount
  useEffect(() => {
        const models = getAvailableModels();
        setAvailableModels(models);
        if (models.length > 0) {
          setWhiteAI((prev) => ({ ...prev, modelId: models[0].modelId }));
          setBlackAI((prev) => ({ ...prev, modelId: models[0].modelId }));
        }
  }, []);

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
    if (!gameStarted || isPaused || gameState.status !== "playing") {
      return;
    }

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
      } else {
        setBlackTimeMs((prev) => prev + delta);
      }
    }, 100);

    return () => clearInterval(interval);
  }, [gameStarted, isPaused, gameState.status, gameState.turn]);

  // AI move effect
  useEffect(() => {
    if (!gameStarted || isPaused || gameState.status !== "playing") {
      return;
    }

    const currentTurn = gameState.turn;
    if (!isAIControlled(currentTurn)) {
      return;
    }

    if (aiRequestRef.current || aiThinking) {
      return;
    }

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
          await new Promise((resolve) => setTimeout(resolve, 500));
        }

        const result = await requestAIMove({
          state: gameState,
          modelId: config.modelId,
          reasoningEffort: config.reasoningEffort,
          apiKey,
          baseURL,
        });

        if ("move" in result) {
          setGameState((prev) => makeMove(prev, result.move));
        } else if ("error" in result) {
          setAiError(result.error);
        }
      } catch (err) {
        setAiError(err instanceof Error ? err.message : "AI move failed");
      } finally {
        setAiThinking(false);
        aiRequestRef.current = false;
      }
    };

    makeAIMove();
  }, [
    gameStarted,
    isPaused,
    gameState,
    isAIControlled,
    getAIConfig,
    gameMode,
    aiThinking,
  ]);

  // Save match record on game over
  useEffect(() => {
    if (
      !gameStarted ||
      matchSavedRef.current ||
      (gameState.status !== "checkmate" &&
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
        gameState.status === "checkmate"
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

  // Handle square click for human moves
  const handleSquareClick = useCallback(
    (square: Square) => {
      if (isPaused || gameState.status !== "playing" || aiThinking) {
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
          move.promotion = "queen"; // Auto-promote to queen
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
    [gameState, selectedSquare, isPaused, aiThinking, isAIControlled]
  );

  // Handle reset
  const handleReset = useCallback(() => {
    setGameState(createInitialState());
    setSelectedSquare(null);
    setLegalMoves([]);
    setWhiteTimeMs(0);
    setBlackTimeMs(0);
    setIsPaused(false);
    setAiThinking(false);
    setAiError(null);
    lastTickRef.current = 0;
    aiRequestRef.current = false;
    matchSavedRef.current = false;
    setGameStarted(false);
  }, []);

  // Handle pause
  const handlePause = useCallback(() => {
    setIsPaused(true);
    lastTickRef.current = 0;
  }, []);

  // Handle resume
  const handleResume = useCallback(() => {
    setIsPaused(false);
    lastTickRef.current = Date.now();
  }, []);

  // Start game
  const handleStartGame = useCallback(() => {
    setGameState(createInitialState());
    setWhiteTimeMs(0);
    setBlackTimeMs(0);
    setGameStartTime(Date.now());
    lastTickRef.current = Date.now();
    matchSavedRef.current = false;
    setGameStarted(true);
  }, []);

  // Board should be flipped when human plays black
  const boardFlipped = gameMode === "pvai" && humanColor === "black";

  // Last move for highlighting
  const lastMove = useMemo(() => {
    const history = gameState.moveHistory;
    return history.length > 0 ? history[history.length - 1].move : null;
  }, [gameState.moveHistory]);

  // Render setup screen
  if (!gameStarted) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-amber-50 via-orange-50 to-yellow-50 dark:from-gray-900 dark:via-gray-850 dark:to-gray-900">
        <div className="container mx-auto px-4 py-8 max-w-4xl">
          {/* Header */}
          <div className="text-center mb-8">
            <h1 className="text-4xl font-bold text-gray-900 dark:text-white mb-2">
              ♟️ Chess
            </h1>
            <p className="text-gray-600 dark:text-gray-400">
              Configure your game and start playing
            </p>
          </div>

          {/* Setup Card */}
          <div className="bg-white dark:bg-gray-800 rounded-2xl shadow-xl p-6 space-y-6">
            {/* Game Mode Selection */}
            <div>
              <label className="block text-sm font-semibold text-gray-700 dark:text-gray-300 mb-3">
                Game Mode
              </label>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                {GAME_MODES.map((mode) => (
                  <button
                    key={mode.value}
                    onClick={() => setGameMode(mode.value)}
                    className={cn(
                      "p-4 rounded-xl border-2 transition-all text-left",
                      gameMode === mode.value
                        ? "border-amber-500 bg-amber-50 dark:bg-amber-900/20"
                        : "border-gray-200 dark:border-gray-700 hover:border-amber-300"
                    )}
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
                  >
                    <div className="w-6 h-6 rounded-full bg-gray-900 border-2 border-gray-600" />
                    <span className="font-medium text-gray-900 dark:text-white">
                      Black
                    </span>
                  </button>
                </div>
              </div>
            )}

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
              disabled={
                gameMode !== "pvp" &&
                availableModels.length === 0
              }
              className={cn(
                "w-full py-4 rounded-xl font-semibold text-lg transition-all",
                "bg-gradient-to-r from-amber-500 to-orange-500 text-white",
                "hover:from-amber-600 hover:to-orange-600",
                "disabled:opacity-50 disabled:cursor-not-allowed",
                "shadow-lg hover:shadow-xl"
              )}
            >
              Start Game
            </button>

            {gameMode !== "pvp" && availableModels.length === 0 && (
              <p className="text-center text-sm text-red-500">
                No AI models configured. Please add models in Settings first.
              </p>
            )}
          </div>
        </div>
      </div>
    );
  }

  // Render game screen
  return (
    <div className="min-h-screen bg-gradient-to-br from-amber-50 via-orange-50 to-yellow-50 dark:from-gray-900 dark:via-gray-850 dark:to-gray-900">
      <div className="container mx-auto px-4 py-6">
        {/* Header */}
        <div className="text-center mb-6">
          <h1 className="text-3xl font-bold text-gray-900 dark:text-white">
            ♟️ Chess
          </h1>
          <p className="text-sm text-gray-600 dark:text-gray-400 mt-1">
            {gameMode === "pvp" && "Player vs Player"}
            {gameMode === "pvai" &&
              `You (${humanColor}) vs AI`}
            {gameMode === "aivai" && "AI vs AI"}
          </p>
        </div>

        {/* Main Layout */}
        <div className="flex flex-col lg:flex-row gap-6 items-start justify-center">
          {/* Chess Board */}
          <div className="flex-shrink-0">
            <ChessBoard
              state={gameState}
              onSquareClick={handleSquareClick}
              selectedSquare={selectedSquare}
              legalMoves={legalMoves}
              lastMove={lastMove}
              flipped={boardFlipped}
              interactive={!aiThinking && !isPaused && gameState.status === "playing"}
            />
          </div>

          {/* Control Panel */}
          <div className="w-full lg:w-80 space-y-4">
            {/* Clocks */}
            <div className="flex flex-col gap-3">
              <ChessClock
                color="black"
                timeMs={blackTimeMs}
                isActive={gameState.turn === "black" && gameState.status === "playing"}
                isPaused={isPaused}
              />
              <ChessClock
                color="white"
                timeMs={whiteTimeMs}
                isActive={gameState.turn === "white" && gameState.status === "playing"}
                isPaused={isPaused}
              />
            </div>

            {/* Game Status */}
            {gameState.status !== "playing" && gameState.status !== "paused" && (
              <div
                className={cn(
                  "p-4 rounded-xl text-center font-semibold",
                  gameState.status === "checkmate" &&
                    "bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-300",
                  gameState.status === "check" &&
                    "bg-yellow-100 dark:bg-yellow-900/30 text-yellow-700 dark:text-yellow-300",
                  (gameState.status === "stalemate" ||
                    gameState.status === "draw") &&
                    "bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300"
                )}
              >
                {gameState.status === "checkmate" &&
                  `Checkmate! ${gameState.winner === "white" ? "White" : "Black"} wins!`}
                {gameState.status === "check" && "Check!"}
                {gameState.status === "stalemate" && "Stalemate - Draw!"}
                {gameState.status === "draw" && "Draw!"}
              </div>
            )}

            {/* AI Thinking Indicator */}
            {aiThinking && (
              <div className="p-4 rounded-xl bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300 flex items-center gap-3">
                <div className="animate-spin w-5 h-5 border-2 border-blue-500 border-t-transparent rounded-full" />
                <span>AI is thinking...</span>
              </div>
            )}

            {/* AI Error */}
            {aiError && (
              <div className="p-4 rounded-xl bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-300">
                <div className="font-semibold mb-1">AI Error</div>
                <div className="text-sm">{aiError}</div>
              </div>
            )}

            {/* Game Controls */}
            <GameControls
              onReset={handleReset}
              onPause={handlePause}
              onResume={handleResume}
              isPaused={isPaused}
              gameStatus={gameState.status}
              canPause={!aiThinking}
            />

            {/* Move History */}
            <MoveHistory moves={gameState.moveHistory} />
          </div>
        </div>
      </div>
    </div>
  );
}

// AI Configuration Panel Component
interface AIConfigPanelProps {
  title: string;
  color: PieceColor;
  config: AIConfig;
  onChange: (config: AIConfig) => void;
  models: { modelId: string; displayName: string; providerId: string }[];
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
        >
          {models.map((model) => (
            <option key={model.modelId} value={model.modelId}>
              {model.displayName}
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

export default GamesClient;