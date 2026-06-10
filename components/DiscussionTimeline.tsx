"use client";

import { useMemo } from "react";
import { Download } from "lucide-react";
import { Markdown } from "@/components/Markdown";
import { cn } from "@/lib/utils";
import {
  accentFor,
  modelMonogram,
  type ModelAccent,
} from "@/lib/ui/model-accent";
import { downloadMarkdown, fileSlug } from "@/lib/ui/download";

export interface TimelineMessage {
  id: string;
  round: number;
  modelId: string;
  modelName: string;
  content: string;
  streaming?: boolean;
}

interface DiscussionTimelineProps {
  messages: TimelineMessage[];
  accentMap: Map<string, ModelAccent>;
  emptyTitle?: string;
  emptyHint?: string;
}

export function DiscussionTimeline({
  messages,
  accentMap,
  emptyTitle,
  emptyHint,
}: DiscussionTimelineProps) {
  const rounds = useMemo(() => {
    const grouped = new Map<number, TimelineMessage[]>();
    for (const msg of messages) {
      const list = grouped.get(msg.round) ?? [];
      list.push(msg);
      grouped.set(msg.round, list);
    }
    return Array.from(grouped.entries()).sort((a, b) => a[0] - b[0]);
  }, [messages]);

  if (rounds.length === 0) {
    return (
      <div className="rounded-2xl border border-dashed bg-card/40 p-12 text-center">
        <p className="font-display text-lg text-foreground">
          {emptyTitle ?? "The panel is convening…"}
        </p>
        <p className="mt-1 text-sm text-muted-foreground">
          {emptyHint ??
            "Each model’s response will stream in here as the discussion unfolds."}
        </p>
      </div>
    );
  }

  return (
    <section className="space-y-10">
      {rounds.map(([round, roundMessages]) => (
        <div key={round}>
          <div className="mb-4 flex items-center gap-3">
            <span className="font-mono text-[0.7rem] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
              Round {round}
            </span>
            <span className="h-px flex-1 bg-gradient-to-r from-border to-transparent" />
            <span className="font-mono text-[0.7rem] text-muted-foreground">
              {roundMessages.length}{" "}
              {roundMessages.length === 1 ? "voice" : "voices"}
            </span>
          </div>
          <div className="space-y-4">
            {roundMessages.map((msg) => (
              <ContributionCard
                key={msg.id}
                message={msg}
                accent={accentFor(accentMap, msg.modelId)}
              />
            ))}
          </div>
        </div>
      ))}
    </section>
  );
}

function ContributionCard({
  message,
  accent,
}: {
  message: TimelineMessage;
  accent: ModelAccent;
}) {
  return (
    <article className="group relative animate-fade-rise overflow-hidden rounded-xl border bg-card shadow-sm transition-shadow duration-300 hover:shadow-md">
      <span
        className={cn("absolute inset-y-0 left-0 w-1", accent.bar)}
        aria-hidden
      />
      <span
        className={cn(
          "pointer-events-none absolute inset-0 bg-gradient-to-r to-transparent opacity-70",
          accent.tint
        )}
        aria-hidden
      />
      <div className="relative p-5 pl-6">
        <header className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1.5">
          <span
            className={cn(
              "flex h-9 w-9 shrink-0 items-center justify-center rounded-lg font-mono text-xs font-bold",
              accent.chipBg,
              accent.text
            )}
          >
            {modelMonogram(message.modelId)}
          </span>
          <span className={cn("font-semibold tracking-tight", accent.text)}>
            {message.modelName}
          </span>
          {message.streaming && <StreamingBadge />}
          {!message.streaming && message.content && (
            <button
              type="button"
              onClick={() =>
                downloadMarkdown(
                  `round-${message.round}-${fileSlug(message.modelName)}.md`,
                  `# ${message.modelName} — Round ${message.round}\n\n${message.content}\n`
                )
              }
              title="Download this response as Markdown"
              aria-label={`Download ${message.modelName}'s round ${message.round} response as Markdown`}
              className="ml-auto rounded-md p-1.5 text-muted-foreground opacity-0 transition-opacity hover:bg-muted hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100"
            >
              <Download className="h-4 w-4" />
            </button>
          )}
        </header>

        {message.streaming ? (
          <StreamingBody content={message.content} />
        ) : (
          <Markdown content={message.content} />
        )}
      </div>
    </article>
  );
}

function StreamingBadge() {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full bg-amber-500/10 px-2 py-0.5 text-[0.7rem] font-medium text-amber-700 dark:text-amber-300">
      <span className="relative flex h-1.5 w-1.5">
        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-amber-500/70" />
        <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-amber-500" />
      </span>
      Streaming
    </span>
  );
}

/**
 * While streaming we render plain text (not markdown): partial markdown — half
 * a code fence, an unclosed table — reflows on every token and looks broken.
 * Once the message completes we switch to the full markdown renderer.
 */
function StreamingBody({ content }: { content: string }) {
  if (!content) {
    return (
      <p className="flex items-center gap-2 text-sm text-muted-foreground">
        <span className="flex gap-1">
          <Dot delay="0ms" />
          <Dot delay="150ms" />
          <Dot delay="300ms" />
        </span>
        Composing response…
      </p>
    );
  }

  return (
    <p className="whitespace-pre-wrap text-[0.95rem] leading-relaxed text-foreground/90">
      {content}
      <span className="ml-0.5 inline-block h-[1.1em] w-[3px] translate-y-[0.15em] animate-pulse rounded-full bg-primary align-middle" />
    </p>
  );
}

function Dot({ delay }: { delay: string }) {
  return (
    <span
      className="inline-block h-1.5 w-1.5 animate-bounce rounded-full bg-current"
      style={{ animationDelay: delay }}
    />
  );
}
