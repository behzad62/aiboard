"use client";

import React from "react";

export function BuildNoteDraftField({
  value,
  onChange,
  onSubmit,
  compact = false,
}: {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  /** Composer layout: the label is visually hidden and the field is borderless. */
  compact?: boolean;
}) {
  return (
    <div className="min-w-0 flex-1 space-y-1.5">
      <label
        htmlFor="build-note-guidance"
        className={compact ? "sr-only" : "block text-xs font-medium"}
      >
        Guidance text
      </label>
      <textarea
        id="build-note-guidance"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
            event.preventDefault();
            onSubmit();
          }
        }}
        rows={2}
        placeholder={
          compact
            ? "Guide the architect…  (Ctrl+Enter to send)"
            : "e.g. Use Postgres instead of SQLite, and add a dark-mode toggle..."
        }
        className={
          compact
            ? "block max-h-48 min-h-[2.75rem] w-full resize-none rounded-md bg-transparent px-2 py-1.5 text-sm placeholder:text-muted-foreground focus-visible:outline-none"
            : "w-full resize-y rounded-md border bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        }
      />
    </div>
  );
}
