"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ChangeEvent } from "react";
import { Upload } from "lucide-react";
import { parseCodenamesJsonExport } from "@/lib/games/codenames/export";
import type { CodenamesSessionSnapshot } from "@/lib/games/codenames/session";
import { cn } from "@/lib/utils";

type ImportStatus = "idle" | "imported" | "error";

export function CodenamesImportMenu({
  onImport,
  onBeforeImport,
}: {
  onImport: (snapshot: CodenamesSessionSnapshot) => void;
  onBeforeImport?: () => boolean;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [status, setStatus] = useState<ImportStatus>("idle");
  const [message, setMessage] = useState("");

  useEffect(() => () => {
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
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

  const handleFileChange = useCallback(
    async (event: ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      event.target.value = "";
      if (!file) return;
      if (onBeforeImport && !onBeforeImport()) return;

      try {
        const result = parseCodenamesJsonExport(await file.text());
        if (!result.ok) {
          showStatus("error", result.error);
          return;
        }
        onImport(result.snapshot);
        showStatus("imported", "Imported");
      } catch {
        showStatus("error", "Could not read the selected file.");
      }
    },
    [onBeforeImport, onImport, showStatus]
  );

  return (
    <div className="relative" data-testid="codenames-import-menu">
      <input
        ref={inputRef}
        type="file"
        accept="application/json,.json"
        className="sr-only"
        onChange={(event) => void handleFileChange(event)}
      />
      <button
        type="button"
        onClick={() => inputRef.current?.click()}
        className="inline-flex w-full items-center justify-center gap-2 rounded-lg border border-slate-200 bg-white px-4 py-2.5 text-sm font-medium text-slate-700 shadow-sm transition hover:bg-slate-50 active:scale-95 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300 dark:hover:bg-slate-800"
      >
        <Upload className="h-4 w-4" aria-hidden="true" />
        Import
      </button>
      {message && (
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
          {message}
        </div>
      )}
    </div>
  );
}
