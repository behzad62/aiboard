"use client";

import { useEffect, useRef, type KeyboardEvent } from "react";
import { AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface ClearBenchmarkDataDialogProps {
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}

/**
 * Confirmation modal for the destructive "Clear all benchmark data" action.
 * Follows the app's custom modal pattern (role="dialog" + aria-modal, focus
 * trap, Escape/backdrop cancel) since no Radix dialog primitive is bundled.
 */
export function ClearBenchmarkDataDialog({
  busy,
  onCancel,
  onConfirm,
}: ClearBenchmarkDataDialogProps) {
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const cancelButton =
      panelRef.current?.querySelector<HTMLButtonElement>(
        "[data-testid='clear-benchmark-cancel']"
      );
    cancelButton?.focus();
  }, []);

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.stopPropagation();
      if (!busy) onCancel();
      return;
    }

    if (event.key !== "Tab") return;

    const focusable = Array.from(
      panelRef.current?.querySelectorAll<HTMLButtonElement>(
        "button:not([disabled])"
      ) ?? []
    );
    if (focusable.length === 0) return;

    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const active = document.activeElement;

    if (event.shiftKey && active === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="clear-benchmark-title"
      aria-describedby="clear-benchmark-body"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 px-4"
      data-testid="clear-benchmark-dialog"
      onKeyDown={handleKeyDown}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) onCancel();
      }}
    >
      <div
        ref={panelRef}
        className={cn(
          "w-full max-w-lg rounded-xl border bg-background p-5 shadow-2xl",
          "text-foreground"
        )}
      >
        <div className="flex items-start gap-3">
          <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-destructive" />
          <div className="space-y-3">
            <h2
              id="clear-benchmark-title"
              className="text-lg font-semibold tracking-tight"
            >
              Clear all benchmark data?
            </h2>
            <div
              id="clear-benchmark-body"
              className="space-y-3 text-sm text-muted-foreground"
            >
              <p>
                This permanently deletes every benchmark record and cannot be
                undone:
              </p>
              <ul className="list-disc space-y-1 pl-5">
                <li>
                  All certified runs, attempts, verifier results, team
                  compositions, and harness certifications
                </li>
                <li>
                  All lab benchmark records (suites, runs, cases, attempts,
                  metric values, artifacts, failures, traces, run events, and
                  tool-call traces)
                </li>
                <li>Every saved benchmark run file</li>
              </ul>
              <p>
                Kept intact: game match history, Build Lab model stats, and all
                settings.
              </p>
              <p className="font-medium text-foreground">
                Recommended: export a benchmark bundle first so you can restore
                this data later if needed.
              </p>
            </div>
          </div>
        </div>

        <div className="mt-5 flex justify-end gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={onCancel}
            data-testid="clear-benchmark-cancel"
          >
            Cancel
          </Button>
          <Button
            type="button"
            variant="destructive"
            size="sm"
            disabled={busy}
            onClick={onConfirm}
            data-testid="clear-benchmark-confirm"
          >
            {busy ? "Clearing..." : "Clear all benchmark data"}
          </Button>
        </div>
      </div>
    </div>
  );
}

export default ClearBenchmarkDataDialog;
