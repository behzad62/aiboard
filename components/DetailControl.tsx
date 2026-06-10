"use client";

import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { VERBOSITY_OPTIONS } from "@/lib/orchestrator/config";
import type { DiscussionMode, Verbosity } from "@/lib/db/schema";
import { cn } from "@/lib/utils";

interface DetailControlProps {
  verbosity: Verbosity;
  onVerbosityChange: (value: Verbosity) => void;
  styleNote: string;
  onStyleNoteChange: (value: string) => void;
  idPrefix?: string;
  /** Build mode notes that this mainly affects the hand-off summary. */
  mode?: DiscussionMode;
}

/**
 * Detail/conciseness control. This steers answer length through prompt
 * instructions only — it never caps tokens — so models comply instead of
 * getting truncated.
 */
export function DetailControl({
  verbosity,
  onVerbosityChange,
  styleNote,
  onStyleNoteChange,
  idPrefix = "detail",
  mode,
}: DetailControlProps) {
  const active = VERBOSITY_OPTIONS.find((o) => o.value === verbosity);

  return (
    <div className="space-y-3">
      <div className="space-y-2">
        <Label>Answer detail</Label>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {VERBOSITY_OPTIONS.map((option) => {
            const selected = option.value === verbosity;
            return (
              <button
                key={option.value}
                type="button"
                onClick={() => onVerbosityChange(option.value)}
                aria-pressed={selected}
                className={cn(
                  "rounded-lg border px-3 py-2 text-center text-sm font-medium transition-colors",
                  selected
                    ? "border-primary bg-primary/5 text-foreground ring-1 ring-primary"
                    : "text-muted-foreground hover:bg-accent hover:text-foreground"
                )}
              >
                {option.label}
              </button>
            );
          })}
        </div>
        {active && (
          <p className="text-xs text-muted-foreground">
            {active.description}
            {mode === "build" &&
              " In Build mode this mainly shapes the workers' notes and the final hand-off summary — emitted code files are always complete."}
          </p>
        )}
      </div>

      <div className="space-y-2">
        <Label htmlFor={`${idPrefix}-style`}>
          Extra style guidance{" "}
          <span className="font-normal text-muted-foreground">(optional)</span>
        </Label>
        <Textarea
          id={`${idPrefix}-style`}
          rows={2}
          placeholder="e.g. use bullet points, no preamble, target ~300 words, formal tone"
          value={styleNote}
          onChange={(e) => onStyleNoteChange(e.target.value)}
        />
        <p className="text-xs text-muted-foreground">
          Added to every model&apos;s instructions for this run.
        </p>
      </div>
    </div>
  );
}
