"use client";

import { useState } from "react";
import { ChevronDown, Download, ScrollText } from "lucide-react";
import { DiscussionTimeline, type TimelineMessage } from "@/components/DiscussionTimeline";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { ModelAccent } from "@/lib/ui/model-accent";

export const BUILD_TRANSCRIPT_INITIAL_ROUNDS = 5;
export const BUILD_TRANSCRIPT_ROUND_INCREMENT = 5;

type BuildTranscriptMessage = TimelineMessage & { ordinal?: number };

interface BuildTranscriptPanelProps {
  messages: BuildTranscriptMessage[];
  accentMap: Map<string, ModelAccent>;
  onDownload: () => void;
}

export function BuildTranscriptPanel({
  messages,
  accentMap,
  onDownload,
}: BuildTranscriptPanelProps) {
  const [open, setOpen] = useState(false);
  const [visibleRoundCount, setVisibleRoundCount] = useState(
    BUILD_TRANSCRIPT_INITIAL_ROUNDS
  );
  const visibleMessages = selectBuildTranscriptMessages(
    messages,
    visibleRoundCount
  );
  const totalRounds = countTranscriptRounds(messages);
  const hiddenRounds = Math.max(0, totalRounds - visibleRoundCount);

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
        <div className="space-y-4 border-t p-4">
          <DiscussionTimeline
            messages={visibleMessages}
            accentMap={accentMap}
            emptyTitle="No raw model turns yet"
            emptyHint="Build progress appears in the task board and activity log."
            roundOrder="desc"
          />
          {hiddenRounds > 0 && (
            <div className="flex justify-center border-t pt-4">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() =>
                  setVisibleRoundCount(
                    (count) => count + BUILD_TRANSCRIPT_ROUND_INCREMENT
                  )
                }
              >
                Load {Math.min(BUILD_TRANSCRIPT_ROUND_INCREMENT, hiddenRounds)}{" "}
                older round{hiddenRounds === 1 ? "" : "s"}
              </Button>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

export function selectBuildTranscriptMessages(
  messages: BuildTranscriptMessage[],
  visibleRoundCount: number
): BuildTranscriptMessage[] {
  if (visibleRoundCount <= 0) return [];

  const grouped = new Map<number, BuildTranscriptMessage[]>();
  for (const message of messages) {
    const roundMessages = grouped.get(message.round) ?? [];
    roundMessages.push(message);
    grouped.set(message.round, roundMessages);
  }

  return Array.from(grouped.entries())
    .sort((a, b) => b[0] - a[0])
    .slice(0, visibleRoundCount)
    .flatMap(([, roundMessages]) => roundMessages);
}

export function buildBuildTranscriptMarkdown(
  title: string,
  messages: BuildTranscriptMessage[]
): string {
  const lines = [`# ${title}`, ""];
  for (const message of [...messages].sort(
    (left, right) => left.round - right.round ||
      (left.ordinal ?? 0) - (right.ordinal ?? 0) ||
      compareCodeUnits(left.id, right.id)
  )) {
    if (!message.content || message.streaming) continue;
    lines.push(`## ${message.modelName}`, "", message.content, "");
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

function compareCodeUnits(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function countTranscriptRounds(messages: TimelineMessage[]): number {
  return new Set(messages.map((message) => message.round)).size;
}
