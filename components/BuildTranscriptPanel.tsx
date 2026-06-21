"use client";

import { useState } from "react";
import { ChevronDown, Download, ScrollText } from "lucide-react";
import { DiscussionTimeline, type TimelineMessage } from "@/components/DiscussionTimeline";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { ModelAccent } from "@/lib/ui/model-accent";

interface BuildTranscriptPanelProps {
  messages: TimelineMessage[];
  accentMap: Map<string, ModelAccent>;
  onDownload: () => void;
}

export function BuildTranscriptPanel({
  messages,
  accentMap,
  onDownload,
}: BuildTranscriptPanelProps) {
  const [open, setOpen] = useState(false);

  return (
    <section className="rounded-lg border bg-card shadow-sm">
      <div className="flex items-center justify-between gap-3 px-4 py-3">
        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          aria-expanded={open}
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
        >
          <ScrollText className="h-4 w-4 shrink-0 text-muted-foreground" />
          <span className="min-w-0">
            <span className="block text-sm font-semibold">Raw transcript</span>
            <span className="block truncate text-xs text-muted-foreground">
              {messages.length} model turn{messages.length === 1 ? "" : "s"} retained for audit and
              export
            </span>
          </span>
          <ChevronDown
            className={cn(
              "ml-auto h-4 w-4 shrink-0 text-muted-foreground transition-transform",
              open && "rotate-180",
            )}
          />
        </button>
        <Button
          variant="outline"
          size="sm"
          onClick={onDownload}
          disabled={messages.length === 0}
          title="Download the whole Build transcript as Markdown"
        >
          <Download className="mr-1 h-3.5 w-3.5" />
          Download .md
        </Button>
      </div>
      {open && (
        <div className="border-t p-4">
          <DiscussionTimeline
            messages={messages}
            accentMap={accentMap}
            emptyTitle="No raw model turns yet"
            emptyHint="Build progress appears in the task board and activity log."
          />
        </div>
      )}
    </section>
  );
}
