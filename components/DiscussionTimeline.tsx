"use client";

import { useMemo } from "react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

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
  currentRound?: number;
  maxRounds?: number;
  convergenceScore?: number | null;
}

const MODEL_COLORS = [
  "border-l-blue-500",
  "border-l-violet-500",
  "border-l-emerald-500",
  "border-l-amber-500",
  "border-l-rose-500",
];

export function DiscussionTimeline({
  messages,
  currentRound,
  maxRounds,
  convergenceScore,
}: DiscussionTimelineProps) {
  const modelColorMap = useMemo(() => {
    const map = new Map<string, string>();
    let i = 0;
    for (const m of messages) {
      if (!map.has(m.modelId)) {
        map.set(m.modelId, MODEL_COLORS[i % MODEL_COLORS.length]);
        i++;
      }
    }
    return map;
  }, [messages]);

  const rounds = useMemo(() => {
    const grouped = new Map<number, TimelineMessage[]>();
    for (const msg of messages) {
      const list = grouped.get(msg.round) ?? [];
      list.push(msg);
      grouped.set(msg.round, list);
    }
    return Array.from(grouped.entries()).sort((a, b) => a[0] - b[0]);
  }, [messages]);

  return (
    <div className="space-y-6">
      {(currentRound !== undefined || convergenceScore != null) && (
        <div className="flex flex-wrap items-center gap-3 text-sm text-muted-foreground">
          {currentRound !== undefined && maxRounds !== undefined && (
            <span>
              Round {currentRound} of {maxRounds}
            </span>
          )}
          {convergenceScore != null && (
            <Badge variant="secondary">
              Convergence: {convergenceScore.toFixed(1)}/10
            </Badge>
          )}
        </div>
      )}

      {rounds.length === 0 && (
        <div className="rounded-lg border border-dashed p-8 text-center text-muted-foreground">
          Waiting for models to start discussing...
        </div>
      )}

      {rounds.map(([round, roundMessages]) => (
        <div key={round} className="space-y-3">
          <h3 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            Round {round}
          </h3>
          <div className="space-y-3">
            {roundMessages.map((msg) => (
              <div
                key={msg.id}
                className={cn(
                  "rounded-lg border border-l-4 bg-card p-4",
                  modelColorMap.get(msg.modelId)
                )}
              >
                <div className="mb-2 flex items-center gap-2">
                  <span className="font-medium">{msg.modelName}</span>
                  {msg.streaming && (
                    <Badge variant="warning">Streaming...</Badge>
                  )}
                </div>
                <div className="whitespace-pre-wrap text-sm leading-relaxed">
                  {msg.content}
                  {msg.streaming && (
                    <span className="ml-1 inline-block h-4 w-1 animate-pulse bg-primary" />
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
