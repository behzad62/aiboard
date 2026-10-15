"use client";

import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";

/**
 * Visible progress for anything the Build page is waiting on (runner connection, file snapshot,
 * plan readiness). Shows elapsed time so a slow step reads as "working", not "broken".
 */
export function LoadingNotice({
  label,
  detail,
  since,
  compact = false,
}: {
  label: string;
  detail?: string;
  /** Epoch ms the wait started; enables the elapsed-time counter. */
  since?: number;
  compact?: boolean;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (since === undefined) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [since]);
  const elapsed = since === undefined ? null : Math.max(0, Math.floor((now - since) / 1000));
  return (
    <div
      role="status"
      aria-live="polite"
      className={
        compact
          ? "inline-flex items-center gap-2 text-xs text-muted-foreground"
          : "flex items-start gap-3 rounded-xl border bg-muted/40 px-4 py-3 text-sm"
      }
    >
      <Loader2
        className={`${compact ? "h-3.5 w-3.5" : "mt-0.5 h-4 w-4"} shrink-0 animate-spin text-primary`}
        aria-hidden="true"
      />
      <div className="min-w-0">
        <p className={compact ? "" : "font-medium"}>
          {label}
          {elapsed !== null && elapsed >= 2 && (
            <span className="ml-1.5 tabular-nums text-muted-foreground">{elapsed}s</span>
          )}
        </p>
        {detail && !compact && <p className="text-xs text-muted-foreground">{detail}</p>}
      </div>
    </div>
  );
}
