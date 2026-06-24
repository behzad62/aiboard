"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type React from "react";
import { ChevronDown, ClipboardCopy, Download, FileJson, FileText } from "lucide-react";
import {
  exportCodenamesJson,
  exportCodenamesMoveList,
} from "@/lib/games/codenames/export";
import type { CodenamesSessionSnapshot } from "@/lib/games/codenames/session";
import type { CodenamesGameState } from "@/lib/games/codenames/types";
import {
  copyGameExportToClipboard,
  downloadGameExport,
} from "@/lib/games/core/export";
import type { GameExport } from "@/lib/games/core/types";
import { cn } from "@/lib/utils";

type ExportStatus = "idle" | "copied" | "downloaded" | "error";

export function CodenamesExportMenu({
  state,
  snapshot,
  allowJsonExport,
}: {
  state: CodenamesGameState;
  snapshot: CodenamesSessionSnapshot;
  allowJsonExport: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<ExportStatus>("idle");
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const moveListExport = useMemo(() => exportCodenamesMoveList(state), [state]);
  const jsonExport = useMemo(
    () => (allowJsonExport ? exportCodenamesJson(snapshot) : null),
    [allowJsonExport, snapshot]
  );

  useEffect(() => () => {
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
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
      } catch {
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
      } catch {
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
    <div className="relative" data-testid="codenames-export-menu">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="inline-flex w-full items-center justify-center gap-2 rounded-lg border border-slate-200 bg-white px-4 py-2.5 text-sm font-medium text-slate-700 shadow-sm transition hover:bg-slate-50 active:scale-95 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300 dark:hover:bg-slate-800"
        aria-expanded={open}
      >
        <FileText className="h-4 w-4" aria-hidden="true" />
        Export
        <ChevronDown
          className={cn("h-4 w-4 transition-transform", open && "rotate-180")}
          aria-hidden="true"
        />
      </button>
      {open && (
        <div className="absolute right-0 z-20 mt-2 w-52 overflow-hidden rounded-lg border border-slate-200 bg-white py-1 shadow-lg dark:border-slate-700 dark:bg-slate-900">
          <MenuButton
            icon={<ClipboardCopy className="h-4 w-4" aria-hidden="true" />}
            label="Copy moves"
            onClick={() => void runCopy(moveListExport)}
          />
          <MenuButton
            icon={<Download className="h-4 w-4" aria-hidden="true" />}
            label="Download moves"
            onClick={() => runDownload(moveListExport)}
          />
          <MenuButton
            icon={<FileJson className="h-4 w-4" aria-hidden="true" />}
            label={allowJsonExport ? "Download JSON" : "JSON after game"}
            disabled={!jsonExport}
            onClick={() => {
              if (jsonExport) runDownload(jsonExport);
            }}
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
          role="status"
          aria-live="polite"
        >
          {statusLabel}
        </div>
      )}
    </div>
  );
}

function MenuButton({
  icon,
  label,
  disabled = false,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition",
        disabled
          ? "cursor-not-allowed text-slate-400 dark:text-slate-600"
          : "text-slate-700 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800"
      )}
    >
      {icon}
      {label}
    </button>
  );
}
