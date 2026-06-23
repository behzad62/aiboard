"use client";

import { useEffect, useRef, type KeyboardEvent } from "react";
import { cn } from "@/lib/utils";
import type { PieceType } from "@/lib/games/chess/types";

export type PromotionPieceType = Extract<
  PieceType,
  "queen" | "rook" | "bishop" | "knight"
>;

interface PromotionOption {
  value: PromotionPieceType;
  label: string;
  notation: string;
}

const PROMOTION_OPTIONS: PromotionOption[] = [
  { value: "queen", label: "Queen", notation: "Q" },
  { value: "rook", label: "Rook", notation: "R" },
  { value: "bishop", label: "Bishop", notation: "B" },
  { value: "knight", label: "Knight", notation: "N" },
];

interface PromotionDialogProps {
  onCancel: () => void;
  onSelect: (piece: PromotionPieceType) => void;
}

export function PromotionDialog({
  onCancel,
  onSelect,
}: PromotionDialogProps) {
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const firstButton = panelRef.current?.querySelector<HTMLButtonElement>(
      "button:not([disabled])"
    );
    firstButton?.focus();
  }, []);

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.stopPropagation();
      onCancel();
      return;
    }

    if (event.key !== "Tab") return;

    const buttons = Array.from(
      panelRef.current?.querySelectorAll<HTMLButtonElement>(
        "button:not([disabled])"
      ) ?? []
    );
    if (buttons.length === 0) return;

    const firstButton = buttons[0];
    const lastButton = buttons[buttons.length - 1];
    const activeElement = document.activeElement;

    if (event.shiftKey && activeElement === firstButton) {
      event.preventDefault();
      lastButton.focus();
    } else if (!event.shiftKey && activeElement === lastButton) {
      event.preventDefault();
      firstButton.focus();
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="promotion-dialog-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 px-4"
      data-testid="promotion-dialog"
      onKeyDown={handleKeyDown}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          onCancel();
        }
      }}
    >
      <div
        ref={panelRef}
        className={cn(
          "w-full max-w-sm rounded-xl border-2 border-[#5c4033]",
          "bg-white p-4 shadow-2xl dark:bg-gray-900",
          "dark:border-amber-800"
        )}
      >
        <h2
          id="promotion-dialog-title"
          className="mb-3 text-center text-base font-semibold text-gray-900 dark:text-white"
        >
          Choose promotion
        </h2>
        <div className="grid grid-cols-4 gap-2">
          {PROMOTION_OPTIONS.map((option) => (
            <button
              key={option.value}
              type="button"
              aria-label={option.label}
              onClick={() => onSelect(option.value)}
              className={cn(
                "flex aspect-square flex-col items-center justify-center rounded-lg",
                "border border-amber-200 bg-amber-50 text-[#5c4033]",
                "transition-colors hover:bg-amber-100",
                "focus-visible:outline-none focus-visible:ring-2",
                "focus-visible:ring-amber-500 focus-visible:ring-offset-2",
                "dark:border-amber-800 dark:bg-gray-800 dark:text-amber-100",
                "dark:hover:bg-gray-700 dark:focus-visible:ring-offset-gray-900"
              )}
              data-testid={`promotion-${option.value}`}
            >
              <span className="text-2xl font-bold leading-none">
                {option.notation}
              </span>
              <span className="mt-1 text-xs font-semibold">
                {option.label}
              </span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

export default PromotionDialog;
