"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type React from "react";
import {
  ChevronDown,
  ClipboardCopy,
  Download,
  FileJson,
  FileText,
} from "lucide-react";
import { cn } from "@/lib/utils";
import {
  exportChessFenList,
  exportChessJson,
  exportChessPgnLike,
  type ChessPgnMetadata,
} from "@/lib/games/chess/export";
import type { ChessSessionSnapshot } from "@/lib/games/chess/session";
import type { GameState } from "@/lib/games/chess/types";
import {
  copyGameExportToClipboard,
  downloadGameExport,
} from "@/lib/games/core/export";
import type { GameExport } from "@/lib/games/core/types";

interface ExportGameMenuProps {
  state: GameState;
  snapshot: ChessSessionSnapshot;
  metadata?: ChessPgnMetadata;
  className?: string;
}

type ExportStatus = "idle" | "copied" | "downloaded" | "error";

export function ExportGameMenu({
  state,
  snapshot,
  metadata,
  className,
}: ExportGameMenuProps) {
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<ExportStatus>("idle");
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pgnExport = useMemo(
    () => exportChessPgnLike(state, metadata),
    [metadata, state]
  );
  const fenExport = useMemo(() => exportChessFenList(state), [state]);
  const jsonExport = useMemo(() => exportChessJson(snapshot), [snapshot]);

  useEffect(() => {
    return () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    };
  }, []);

  const showStatus = useCallback((nextStatus: ExportStatus) => {
    setStatus(nextStatus);
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    timeoutRef.current = setTimeout(() => setStatus("idle"), 1800);
  }, []);

  const runCopy = useCallback(
    async (exportData: GameExport) => {
      try {
        await copyGameExportToClipboard(exportData);
        setOpen(false);
        showStatus("copied");
      } catch (error) {
        console.warn("Failed to copy game export:", error);
        showStatus("error");
      }
    },
    [showStatus]
  );

  const runDownload = useCallback(
    (exportData: GameExport) => {
      try {
        downloadGameExport(exportData);
        setOpen(false);
        showStatus("downloaded");
      } catch (error) {
        console.warn("Failed to download game export:", error);
        showStatus("error");
      }
    },
    [showStatus]
  );

  const statusLabel =
    status === "copied"
      ? "Copied"
      : status === "downloaded"
        ? "Downloaded"
        : status === "error"
          ? "Unavailable"
          : "";

  return (
    <div className={cn("relative", className)} data-testid="game-export-menu">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className={cn(
          "inline-flex w-full items-center justify-center gap-2 rounded-lg px-4 py-2.5",
          "border border-gray-200 bg-white text-sm font-medium text-gray-700 shadow-sm",
          "transition-all duration-200 hover:bg-gray-50 hover:shadow active:scale-95",
          "dark:border-gray-700 dark:bg-gray-900 dark:text-gray-300 dark:hover:bg-gray-800"
        )}
        aria-expanded={open}
        data-testid="game-export-toggle"
        title="Export game"
      >
        <FileText className="h-4 w-4" aria-hidden="true" />
        <span>Export</span>
        <ChevronDown
          className={cn("h-4 w-4 transition-transform", open && "rotate-180")}
          aria-hidden="true"
        />
      </button>

      {open && (
        <div
          className={cn(
            "absolute right-0 z-20 mt-2 w-48 overflow-hidden rounded-lg",
            "border border-gray-200 bg-white py-1 shadow-lg",
            "dark:border-gray-700 dark:bg-gray-900"
          )}
        >
          <ExportMenuButton
            icon={<ClipboardCopy className="h-4 w-4" aria-hidden="true" />}
            label="Copy PGN"
            onClick={() => void runCopy(pgnExport)}
            testId="copy-pgn"
          />
          <ExportMenuButton
            icon={<Download className="h-4 w-4" aria-hidden="true" />}
            label="Download PGN"
            onClick={() => runDownload(pgnExport)}
            testId="download-pgn"
          />
          <ExportMenuButton
            icon={<FileJson className="h-4 w-4" aria-hidden="true" />}
            label="Download JSON"
            onClick={() => runDownload(jsonExport)}
            testId="download-json"
          />
          <ExportMenuButton
            icon={<ClipboardCopy className="h-4 w-4" aria-hidden="true" />}
            label="Copy FEN"
            onClick={() => void runCopy(fenExport)}
            testId="copy-fen"
          />
        </div>
      )}

      {statusLabel && (
        <div
          className={cn(
            "mt-2 text-center text-xs font-medium",
            status === "error"
              ? "text-red-600 dark:text-red-400"
              : "text-green-700 dark:text-green-400"
          )}
          data-testid="game-export-status"
          role="status"
          aria-live="polite"
          aria-atomic="true"
        >
          {statusLabel}
        </div>
      )}
    </div>
  );
}

interface ExportMenuButtonProps {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
  testId: string;
}

function ExportMenuButton({
  icon,
  label,
  onClick,
  testId,
}: ExportMenuButtonProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex w-full items-center gap-2 px-3 py-2 text-left text-sm",
        "text-gray-700 transition-colors hover:bg-gray-100",
        "dark:text-gray-300 dark:hover:bg-gray-800"
      )}
      data-testid={`game-export-${testId}`}
    >
      {icon}
      <span>{label}</span>
    </button>
  );
}

export default ExportGameMenu;
