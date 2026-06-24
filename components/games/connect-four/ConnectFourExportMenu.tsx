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
  exportConnectFourJson,
  exportConnectFourMoveList,
} from "@/lib/games/connect-four/export";
import type { ConnectFourSessionSnapshot } from "@/lib/games/connect-four/session";
import type { ConnectFourGameState } from "@/lib/games/connect-four/types";
import {
  copyGameExportToClipboard,
  downloadGameExport,
} from "@/lib/games/core/export";
import type { GameExport } from "@/lib/games/core/types";

interface ConnectFourExportMenuProps {
  state: ConnectFourGameState;
  snapshot: ConnectFourSessionSnapshot;
  className?: string;
}

type ExportStatus = "idle" | "copied" | "downloaded" | "error";

export function ConnectFourExportMenu({
  state,
  snapshot,
  className,
}: ConnectFourExportMenuProps) {
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<ExportStatus>("idle");
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const moveListExport = useMemo(() => exportConnectFourMoveList(state), [state]);
  const jsonExport = useMemo(() => exportConnectFourJson(snapshot), [snapshot]);

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
        console.warn("Failed to copy Connect Four export:", error);
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
        console.warn("Failed to download Connect Four export:", error);
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
    <div
      className={cn("relative", className)}
      data-testid="connect-four-export-menu"
    >
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className={cn(
          "inline-flex w-full items-center justify-center gap-2 rounded-lg px-4 py-2.5",
          "border border-slate-200 bg-white text-sm font-medium text-slate-700 shadow-sm",
          "transition hover:bg-slate-50 active:scale-95 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300 dark:hover:bg-slate-800"
        )}
        aria-expanded={open}
        data-testid="connect-four-export-toggle"
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
            "absolute right-0 z-20 mt-2 w-52 overflow-hidden rounded-lg border border-slate-200 bg-white py-1 shadow-lg",
            "dark:border-slate-700 dark:bg-slate-900"
          )}
        >
          <ExportMenuButton
            icon={<ClipboardCopy className="h-4 w-4" aria-hidden="true" />}
            label="Copy moves"
            onClick={() => void runCopy(moveListExport)}
            testId="copy-moves"
          />
          <ExportMenuButton
            icon={<Download className="h-4 w-4" aria-hidden="true" />}
            label="Download moves"
            onClick={() => runDownload(moveListExport)}
            testId="download-moves"
          />
          <ExportMenuButton
            icon={<FileJson className="h-4 w-4" aria-hidden="true" />}
            label="Download JSON"
            onClick={() => runDownload(jsonExport)}
            testId="download-json"
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
          data-testid="connect-four-export-status"
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
      className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-slate-700 transition hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800"
      data-testid={`connect-four-export-${testId}`}
    >
      {icon}
      <span>{label}</span>
    </button>
  );
}

export default ConnectFourExportMenu;
