"use client";

import { useMemo, useCallback } from "react";
import { cn } from "@/lib/utils";
import { ChessPiece } from "./pieces";
import type { GameState, Square, Move } from "@/lib/games/chess/types";
import { squareToCoords, coordsToSquare } from "@/lib/games/chess/engine";

interface ChessBoardProps {
  state: GameState;
  onSquareClick?: (square: Square) => void;
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

// File and rank labels
const FILES = ["a", "b", "c", "d", "e", "f", "g", "h"];
const RANKS = ["8", "7", "6", "5", "4", "3", "2", "1"];

export function ChessBoard({
  state,
  onSquareClick,
  selectedSquare = null,
  legalMoves = [],
  lastMove = null,
  flipped = false,
  interactive = true,
}: ChessBoardProps) {
  // Create a set of legal move target squares for quick lookup
  const legalMoveTargets = useMemo(() => {
    return new Set(legalMoves.map((m) => m.to));
  }, [legalMoves]);

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
        onSquareClick(square);
      }
    },
    [interactive, onSquareClick]
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

    // Determine background color with overlays
    const bgColor = isLight ? LIGHT_SQUARE : DARK_SQUARE;

    return (
      <div
        key={square}
        className={cn(
          "relative flex items-center justify-center",
          "aspect-square",
          interactive && "cursor-pointer hover:brightness-110",
          "transition-all duration-150"
        )}
        style={{ backgroundColor: bgColor }}
        onClick={() => handleSquareClick(square)}
      >
        {/* Last move highlight */}
        {isLastMoveSquare && (
          <div
            className="absolute inset-0 pointer-events-none"
            style={{ backgroundColor: LAST_MOVE_COLOR }}
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
          />
        )}

        {/* Capture indicator (ring) */}
        {isCaptureTarget && (
          <div
            className="absolute inset-[5%] rounded-full pointer-events-none z-20 border-[4px]"
            style={{ borderColor: CAPTURE_RING }}
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
      </div>
    );
  };

  return (
    <div className="flex flex-col items-center w-full max-w-[600px] mx-auto">
      {/* Board container with shadow and border */}
      <div
        className={cn(
          "w-full aspect-square",
          "rounded-lg overflow-hidden",
          "shadow-xl",
          "border-4 border-[#5c4033]",
          "bg-[#5c4033]" // Border color shows through as frame
        )}
      >
        {/* Inner board with grid */}
        <div
          className="w-full h-full grid grid-cols-8 grid-rows-8 gap-0"
          style={{
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