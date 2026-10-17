"use client";

import { useEffect, useRef, useState } from "react";
import { AlertCircle, AlertTriangle, X } from "lucide-react";
import type { DiagnosticEntry } from "@/components/DiscussionDiagnostics";
import { cn } from "@/lib/utils";

export type BuildAlertKind = "error" | "warning";
export interface BuildAlert {
  id: string;
  kind: BuildAlertKind;
  message: string;
  at?: string;
}

export function alertsFromDiagnostics(entries: readonly DiagnosticEntry[]): BuildAlert[] {
  return entries.flatMap((entry) => {
    const message = entry.message;
    const kind: BuildAlertKind | null =
      entry.phase === "model_failed" || /\b(error|failed|failure|exception|crash|denied|timed out)\b/i.test(message)
        ? "error"
        : /\b(warn(?:ing)?|retry(?:ing)?|reconnect(?:ing)?|blocked|paused|degraded|conflict|limit|attention|suspended)\b/i.test(message)
          ? "warning"
          : null;
    return kind ? [{ id: entry.id, kind, message, at: entry.at }] : [];
  });
}

const seenKey = (scope: string) => `aiboard:build-alerts-seen:${scope}`;

function readSeen(scope: string): string[] {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(seenKey(scope)) ?? "[]");
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : [];
  } catch {
    return [];
  }
}

function writeSeen(scope: string, ids: string[]) {
  try {
    window.localStorage.setItem(seenKey(scope), JSON.stringify(ids.slice(-500)));
  } catch {
    // Storage may be unavailable; the in-memory acknowledgement still works.
  }
}

export function BuildEventCenter({ scope, events }: { scope: string; events: BuildAlert[] }) {
  const [seenState, setSeenState] = useState<{ scope: string; ids: string[] } | null>(null);
  const [open, setOpen] = useState<BuildAlertKind | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setSeenState({ scope, ids: readSeen(scope) });
    setOpen(null);
  }, [scope]);

  useEffect(() => {
    if (!open) return;
    const dismiss = (event: PointerEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(null);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(null);
    };
    document.addEventListener("pointerdown", dismiss);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", dismiss);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);

  const seen = new Set(seenState?.scope === scope ? seenState.ids : []);
  const list = (kind: BuildAlertKind) => events.filter((event) => event.kind === kind);
  const unread = (kind: BuildAlertKind) => list(kind).filter((event) => !seen.has(event.id)).length;

  const toggle = (kind: BuildAlertKind) => {
    if (open === kind) {
      setOpen(null);
      return;
    }
    const ids = [...new Set([...(seenState?.scope === scope ? seenState.ids : []), ...list(kind).map((event) => event.id)])].slice(-500);
    setSeenState({ scope, ids });
    writeSeen(scope, ids);
    setOpen(kind);
  };

  return (
    <div ref={containerRef} className="relative flex items-center gap-1" aria-label="Build notices">
      {(["warning", "error"] as const).map((kind) => {
        const count = unread(kind);
        const Icon = kind === "error" ? AlertCircle : AlertTriangle;
        return (
          <button key={kind} type="button" aria-label={`View ${kind}s${count ? `, ${count} new` : ""}`}
            title={`${kind === "error" ? "Errors" : "Warnings"}${count ? ` · ${count} unseen` : ""}`}
            aria-expanded={open === kind}
            onClick={() => toggle(kind)}
            className={cn(
              "relative inline-flex h-9 items-center gap-1 rounded-lg px-2 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground",
              open === kind && "bg-accent text-foreground",
              count > 0 && (kind === "error" ? "text-destructive" : "text-warning")
            )}>
            {count > 0 && <span aria-hidden="true" className={cn("absolute left-2 top-2 h-5 w-5 rounded-full motion-safe:animate-ping opacity-30",
              kind === "error" ? "bg-destructive" : "bg-warning")} />}
            <Icon className="relative h-4 w-4" aria-hidden="true" />
            {count > 0 && <span className="text-[11px] font-semibold tabular-nums">{count}</span>}
          </button>
        );
      })}
      {open && (
        <div role="dialog" aria-label={open === "error" ? "Build errors" : "Build warnings"}
          className="absolute right-0 top-full z-50 mt-2 w-[min(24rem,calc(100vw-2rem))] overflow-hidden rounded-xl border bg-popover text-popover-foreground shadow-xl">
          <div className="flex items-center justify-between border-b px-4 py-3">
            <div>
              <h3 className="text-sm font-semibold">{open === "error" ? "Errors" : "Warnings"}</h3>
              <p className="text-xs text-muted-foreground">{list(open).length} recorded · acknowledged when opened</p>
            </div>
            <button type="button" onClick={() => setOpen(null)} aria-label="Close notices"
              className="rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground">
              <X className="h-4 w-4" />
            </button>
          </div>
          <div className="max-h-[min(25rem,55vh)] overflow-y-auto p-2">
            {list(open).length === 0 ? (
              <p className="p-4 text-sm text-muted-foreground">No {open}s recorded.</p>
            ) : (
              <ol className="space-y-1">
                {[...list(open)].reverse().map((event) => (
                  <li key={event.id} className="rounded-md px-3 py-2 text-sm hover:bg-accent/50">
                    <p className="break-words leading-relaxed">{event.message}</p>
                    {event.at && <span className="mt-1 block font-mono text-[11px] text-muted-foreground">{event.at}</span>}
                  </li>
                ))}
              </ol>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
