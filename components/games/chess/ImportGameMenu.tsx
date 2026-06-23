"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Upload } from "lucide-react";
import { cn } from "@/lib/utils";
import { parseChessJsonExport } from "@/lib/games/chess/export";
import type { ChessSessionSnapshot } from "@/lib/games/chess/session";

interface ImportGameMenuProps {
  onImport: (snapshot: ChessSessionSnapshot) => void;
  onBeforeImport?: () => boolean;
  className?: string;
}

type ImportStatus = "idle" | "imported" | "error";

export function ImportGameMenu({
  onImport,
  onBeforeImport,
  className,
}: ImportGameMenuProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [status, setStatus] = useState<ImportStatus>("idle");
  const [message, setMessage] = useState("");

  useEffect(() => {
    return () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    };
  }, []);

  const showStatus = useCallback((nextStatus: ImportStatus, nextMessage: string) => {
    setStatus(nextStatus);
    setMessage(nextMessage);
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    timeoutRef.current = setTimeout(() => {
      setStatus("idle");
      setMessage("");
    }, 2400);
  }, []);

  const handleButtonClick = useCallback(() => {
    inputRef.current?.click();
  }, []);

  const handleFileChange = useCallback(
    async (event: React.ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      event.target.value = "";
      if (!file) return;

      if (onBeforeImport && !onBeforeImport()) {
        return;
      }

      try {
        const content = await file.text();
        const result = parseChessJsonExport(content);
        if (!result.ok) {
          showStatus("error", result.error);
          return;
        }

        onImport(result.snapshot);
        showStatus("imported", "Imported");
      } catch (error) {
        console.warn("Failed to import chess game:", error);
        showStatus("error", "Could not read the selected file.");
      }
    },
    [onBeforeImport, onImport, showStatus]
  );

  return (
    <div className={cn("relative", className)} data-testid="game-import-menu">
      <input
        ref={inputRef}
        type="file"
        accept="application/json,.json"
        className="sr-only"
        onChange={(event) => void handleFileChange(event)}
        data-testid="game-import-input"
      />
      <button
        type="button"
        onClick={handleButtonClick}
        className={cn(
          "inline-flex w-full items-center justify-center gap-2 rounded-lg px-4 py-2.5",
          "border border-gray-200 bg-white text-sm font-medium text-gray-700 shadow-sm",
          "transition-all duration-200 hover:bg-gray-50 hover:shadow active:scale-95",
          "dark:border-gray-700 dark:bg-gray-900 dark:text-gray-300 dark:hover:bg-gray-800"
        )}
        data-testid="game-import-button"
        title="Import game"
      >
        <Upload className="h-4 w-4" aria-hidden="true" />
        <span>Import</span>
      </button>

      {message && (
        <div
          className={cn(
            "mt-2 text-center text-xs font-medium",
            status === "error"
              ? "text-red-600 dark:text-red-400"
              : "text-green-700 dark:text-green-400"
          )}
          data-testid="game-import-status"
          role="status"
          aria-live="polite"
          aria-atomic="true"
        >
          {message}
        </div>
      )}
    </div>
  );
}

export default ImportGameMenu;
