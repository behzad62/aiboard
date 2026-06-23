"use client";

import { useMemo, useCallback, useRef, useState } from "react";
import type { KeyboardEvent, PointerEvent } from "react";
import { cn } from "@/lib/utils";
import { ChessPiece } from "./pieces";
import type { GameState, Square, Move } from "@/lib/games/chess/types";
import {
  coordsToSquare,
  isInCheck,
  squareToCoords,
} from "@/lib/games/chess/engine";

interface ChessBoardProps {
  state: GameState;
  onSquareClick?: (square: Square) => void;
  onSquareDrag?: (from: Square, to: Square) => void;
  onClearSelection?: () => void;
  selectedSquare?: Square | null;
  legalMoves?: Move[];
  lastMove?: Move | null;
  flipped?: boolean;
  interactive?: boolean;
}

// Board colors - warm wood palette
const LIGHT_SQUARE = "#f0d9b5";
const DARK_SQUARE = "#b58863";
const SELECTED_COLOR = "rgba(255, 255, 100, 0.5)";
const LAST_MOVE_COLOR = "rgba(255, 255, 0, 0.3)";
const LEGAL_MOVE_DOT = "rgba(0, 0, 0, 0.15)";
const CAPTURE_RING = "rgba(0, 0, 0, 0.15)";
const CHECK_OUTLINE = "rgba(220, 38, 38, 0.95)";

// File and rank labels
const FILES = ["a", "b", "c", "d", "e", "f", "g", "h"];
const RANKS = ["8", "7", "6", "5", "4", "3", "2", "1"];

export function ChessBoard({
  state,
  onSquareClick,
  onSquareDrag,
  onClearSelection,
  selectedSquare = null,
  legalMoves = [],
  lastMove = null,
  flipped = false,
  interactive = true,
}: ChessBoardProps) {
  const squareButtonsRef = useRef<Map<Square, HTMLButtonElement>>(new Map());
  const dragOriginRef = useRef<Square | null>(null);
  const suppressNextClickRef = useRef(false);
  const [focusedSquare, setFocusedSquare] = useState<Square>(() =>
    coordsToSquare(flipped ? 7 : 0, flipped ? 7 : 0)
  );

  // Create a set of legal move target squares for quick lookup
  const legalMoveTargets = useMemo(() => {
    return new Set(legalMoves.map((m) => m.to));
  }, [legalMoves]);

  const checkedKingSquare = useMemo(() => {
    if (
      (state.status !== "check" && state.status !== "checkmate") ||
      !isInCheck(state, state.turn)
    ) {
      return null;
    }

    for (let row = 0; row < 8; row++) {
      for (let col = 0; col < 8; col++) {
        const piece = state.board[row][col];
        if (piece?.type === "king" && piece.color === state.turn) {
          return coordsToSquare(row, col);
        }
      }
    }

    return null;
  }, [state]);

  // Check if a square is a capture target (has an opponent's piece)
  const isCapture = useCallback(
    (square: Square): boolean => {
      if (!legalMoveTargets.has(square)) return false;
      const [row, col] = squareToCoords(square);
      const piece = state.board[row][col];
      return piece !== null;
    },
    [legalMoveTargets, state.board]
  );

  // Handle square click
  const handleSquareClick = useCallback(
    (square: Square) => {
      if (interactive && onSquareClick) {
        setFocusedSquare(square);
        onSquareClick(square);
      }
    },
    [interactive, onSquareClick]
  );

  const setSquareButtonRef = useCallback(
    (square: Square, node: HTMLButtonElement | null) => {
      if (node) {
        squareButtonsRef.current.set(square, node);
      } else {
        squareButtonsRef.current.delete(square);
      }
    },
    []
  );

  const squareToDisplayCoords = useCallback(
    (square: Square) => {
      const [row, col] = squareToCoords(square);
      return {
        row: flipped ? 7 - row : row,
        col: flipped ? 7 - col : col,
      };
    },
    [flipped]
  );

  const displayCoordsToSquare = useCallback(
    (displayRow: number, displayCol: number) => {
      const actualRow = flipped ? 7 - displayRow : displayRow;
      const actualCol = flipped ? 7 - displayCol : displayCol;
      return coordsToSquare(actualRow, actualCol);
    },
    [flipped]
  );

  const focusSquare = useCallback((square: Square) => {
    setFocusedSquare(square);
    squareButtonsRef.current.get(square)?.focus();
  }, []);

  const squareFromPoint = useCallback(
    (clientX: number, clientY: number): Square | null => {
      if (typeof document === "undefined") return null;

      const target = document.elementFromPoint(clientX, clientY);
      const squareElement = target?.closest<HTMLElement>("[data-square]");
      return squareElement?.dataset.square ?? null;
    },
    []
  );

  const handlePointerDown = useCallback(
    (square: Square, event: PointerEvent<HTMLButtonElement>) => {
      if (!interactive) return;
      if (event.pointerType === "mouse" && event.button !== 0) return;

      const [row, col] = squareToCoords(square);
      const piece = state.board[row][col];
      dragOriginRef.current = piece ? square : null;
      suppressNextClickRef.current = false;

      try {
        event.currentTarget.setPointerCapture(event.pointerId);
      } catch {
        // Some synthetic pointer events used by tests do not support capture.
      }
    },
    [interactive, state.board]
  );

  const handlePointerUp = useCallback(
    (square: Square, event: PointerEvent<HTMLButtonElement>) => {
      if (!interactive) return;

      const from = dragOriginRef.current;
      dragOriginRef.current = null;
      if (!from) return;

      const to = squareFromPoint(event.clientX, event.clientY) ?? square;
      if (to === from) return;

      suppressNextClickRef.current = true;
      setFocusedSquare(to);
      if (onSquareDrag) {
        onSquareDrag(from, to);
      } else {
        handleSquareClick(from);
        handleSquareClick(to);
      }
    },
    [handleSquareClick, interactive, onSquareDrag, squareFromPoint]
  );

  const handlePointerCancel = useCallback(() => {
    dragOriginRef.current = null;
  }, []);

  const handleClick = useCallback(
    (square: Square) => {
      if (suppressNextClickRef.current) {
        suppressNextClickRef.current = false;
        return;
      }

      handleSquareClick(square);
    },
    [handleSquareClick]
  );

  const handleSquareKeyDown = useCallback(
    (square: Square, event: KeyboardEvent<HTMLButtonElement>) => {
      if (!interactive) return;

      const { row, col } = squareToDisplayCoords(square);
      let nextSquare: Square | null = null;

      switch (event.key) {
        case "ArrowUp":
          nextSquare = row > 0 ? displayCoordsToSquare(row - 1, col) : square;
          break;
        case "ArrowDown":
          nextSquare = row < 7 ? displayCoordsToSquare(row + 1, col) : square;
          break;
        case "ArrowLeft":
          nextSquare = col > 0 ? displayCoordsToSquare(row, col - 1) : square;
          break;
        case "ArrowRight":
          nextSquare = col < 7 ? displayCoordsToSquare(row, col + 1) : square;
          break;
        case "Enter":
        case " ":
        case "Spacebar":
          event.preventDefault();
          handleSquareClick(square);
          return;
        case "Escape":
          event.preventDefault();
          onClearSelection?.();
          return;
        default:
          return;
      }

      event.preventDefault();
      focusSquare(nextSquare);
    },
    [
      displayCoordsToSquare,
      focusSquare,
      handleSquareClick,
      interactive,
      onClearSelection,
      squareToDisplayCoords,
    ]
  );

  // Get display order based on flipped state
  const displayRanks = flipped ? [...RANKS].reverse() : RANKS;
  const displayFiles = flipped ? [...FILES].reverse() : FILES;

  // Render a single square
  const renderSquare = (displayRow: number, displayCol: number) => {
    // Map display coordinates to actual board coordinates
    const actualRow = flipped ? 7 - displayRow : displayRow;
    const actualCol = flipped ? 7 - displayCol : displayCol;
    
    const square = coordsToSquare(actualRow, actualCol);
    const piece = state.board[actualRow][actualCol];
    const isLight = (actualRow + actualCol) % 2 === 0;
    const isSelected = selectedSquare === square;
    const isLastMoveSquare = lastMove && (lastMove.from === square || lastMove.to === square);
    const isLegalTarget = legalMoveTargets.has(square);
    const isCaptureTarget = isCapture(square);
    const isCheckedKing = checkedKingSquare === square;
    const pieceLabel = piece ? `${piece.color} ${piece.type}` : "empty";

    // Determine background color with overlays
    const bgColor = isLight ? LIGHT_SQUARE : DARK_SQUARE;

    return (
      <button
        type="button"
        key={square}
        className={cn(
          "relative flex items-center justify-center appearance-none border-0 p-0",
          "aspect-square",
          interactive && "cursor-pointer hover:brightness-110",
          "transition-all duration-150",
          "focus-visible:z-30 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-blue-600"
        )}
        style={{ backgroundColor: bgColor, width: '100%', height: '100%' }}
        onClick={() => handleClick(square)}
        onFocus={() => setFocusedSquare(square)}
        onKeyDown={(event) => handleSquareKeyDown(square, event)}
        onPointerDown={(event) => handlePointerDown(square, event)}
        onPointerUp={(event) => handlePointerUp(square, event)}
        onPointerCancel={handlePointerCancel}
        onLostPointerCapture={handlePointerCancel}
        disabled={!interactive}
        tabIndex={interactive ? (focusedSquare === square ? 0 : -1) : -1}
        aria-label={`${square} ${pieceLabel}`}
        aria-pressed={isSelected}
        data-square={square}
        data-testid={`square-${square}`}
        ref={(node) => setSquareButtonRef(square, node)}
      >
        {/* Last move highlight */}
        {isLastMoveSquare && (
          <div
            className="absolute inset-0 pointer-events-none"
            style={{ backgroundColor: LAST_MOVE_COLOR }}
            data-testid="last-move-highlight"
          />
        )}

        {/* Selected square highlight */}
        {isSelected && (
          <div
            className="absolute inset-0 pointer-events-none"
            style={{ backgroundColor: SELECTED_COLOR }}
          />
        )}

        {/* Piece */}
        {piece && (
          <div className="absolute inset-[5%] flex items-center justify-center z-10 transition-transform duration-150">
            <div className="w-full h-full flex items-center justify-center">
              <ChessPiece piece={piece} />
            </div>
          </div>
        )}

        {/* Legal move indicator */}
        {isLegalTarget && !isCaptureTarget && (
          <div
            className="absolute w-[30%] h-[30%] rounded-full pointer-events-none z-20"
            style={{ backgroundColor: LEGAL_MOVE_DOT }}
            data-testid="legal-move-dot"
          />
        )}

        {/* Capture indicator (ring) */}
        {isCaptureTarget && (
          <div
            className="absolute inset-[5%] rounded-full pointer-events-none z-20 border-[4px]"
            style={{ borderColor: CAPTURE_RING }}
            data-testid="legal-capture-ring"
          />
        )}

        {/* Checked king danger outline */}
        {isCheckedKing && (
          <div
            className="absolute inset-[6%] rounded-sm pointer-events-none z-30 border-[4px] shadow-[0_0_0_2px_rgba(255,255,255,0.65)]"
            style={{ borderColor: CHECK_OUTLINE }}
            data-testid="king-check-outline"
          />
        )}

        {/* Coordinate labels */}
        {/* File label on bottom row */}
        {displayRow === 7 && (
          <span
            className={cn(
              "absolute bottom-0.5 right-1 text-[10px] font-semibold pointer-events-none select-none",
              isLight ? "text-[#b58863]" : "text-[#f0d9b5]"
            )}
          >
            {displayFiles[displayCol]}
          </span>
        )}
        {/* Rank label on left column */}
        {displayCol === 0 && (
          <span
            className={cn(
              "absolute top-0.5 left-1 text-[10px] font-semibold pointer-events-none select-none",
              isLight ? "text-[#b58863]" : "text-[#f0d9b5]"
            )}
          >
            {displayRanks[displayRow]}
          </span>
        )}
      </button>
    );
  };

  return (
    <div
      className="flex flex-col items-center w-full max-w-[600px] mx-auto"
      style={{ width: '100%', minHeight: '300px' }}
    >
      {/* Board container with shadow and border */}
      <div
        className={cn(
          "w-full aspect-square",
          "rounded-lg overflow-hidden",
          "shadow-xl",
          "border-4 border-[#5c4033]",
          "bg-[#5c4033]" // Border color shows through as frame
        )}
        style={{ width: '100%', minHeight: '300px' }}
        data-testid="chess-board"
      >
        {/* Inner board with grid */}
        <div
          className="w-full h-full grid grid-cols-8 grid-rows-8 gap-0"
          role="grid"
          aria-label={flipped ? "Chess board, black view" : "Chess board, white view"}
          style={{
            width: '100%',
            height: '100%',
            boxShadow: "inset 0 0 20px rgba(0,0,0,0.3)",
          }}
        >
          {Array.from({ length: 8 }, (_, displayRow) =>
            Array.from({ length: 8 }, (_, displayCol) =>
              renderSquare(displayRow, displayCol)
            )
          )}
        </div>
      </div>
    </div>
  );
}

export default ChessBoard;
