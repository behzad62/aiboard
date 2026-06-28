"use client";

import React from "react";

export function FireworksTranscriptViewer({ transcript }: { transcript: unknown }) {
  const cases = transcriptCases(transcript);
  return (
    <details className="rounded-md border px-3 py-2">
      <summary className="cursor-pointer text-sm font-medium">
        Transcript replay
      </summary>
      {cases.length === 0 ? (
        <p className="mt-3 text-sm text-muted-foreground">
          No Fireworks cases were recorded in this transcript.
        </p>
      ) : (
        <div className="mt-3 space-y-3">
          {cases.map((benchmarkCase) => (
            <article
              key={benchmarkCase.id}
              className="rounded-md border bg-background p-3"
            >
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <div className="font-medium">{benchmarkCase.id}</div>
                  <div className="text-xs text-muted-foreground">
                    {[benchmarkCase.suite, benchmarkCase.category]
                      .filter(Boolean)
                      .join(" / ")}
                  </div>
                </div>
                <div className="text-sm font-medium">
                  Final score {formatScore(benchmarkCase.score)}
                </div>
              </div>
              <div className="mt-2 text-xs text-muted-foreground">
                Final stacks: {formatStacks(benchmarkCase.finalState)}
              </div>
              <ol className="mt-3 space-y-2">
                {caseTurns(benchmarkCase).map((turn, index) => (
                  <li
                    key={`${benchmarkCase.id}:${turn.turn}:${index}`}
                    className="rounded-md bg-muted/40 px-3 py-2 text-sm"
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">
                        Turn {displayTurn(turn.turn)}
                      </span>
                      <span>{turn.playerId}</span>
                      <span>{formatAction(turn.action)}</span>
                      {turn.fallbackUsed && <Badge>Fallback</Badge>}
                      {turn.playResult === "misplay" && <Badge>Bad play</Badge>}
                      {turn.criticalDiscard && <Badge>Critical discard</Badge>}
                    </div>
                    {turn.message && (
                      <div className="mt-1 text-xs text-muted-foreground">
                        {turn.message}
                      </div>
                    )}
                  </li>
                ))}
              </ol>
            </article>
          ))}
        </div>
      )}
    </details>
  );
}

interface TranscriptCase {
  id: string;
  suite?: string;
  category?: string;
  score?: number;
  action?: unknown;
  fallbackUsed?: boolean;
  actions?: unknown[];
  finalState?: unknown;
  metrics?: { finalScore?: number };
}

interface TranscriptTurn {
  turn: number;
  playerId: string;
  action: unknown;
  fallbackUsed: boolean;
  playResult?: string;
  criticalDiscard: boolean;
  message?: string;
}

function transcriptCases(transcript: unknown): TranscriptCase[] {
  if (!isRecord(transcript)) return [];
  const cases = transcript.cases;
  if (!Array.isArray(cases)) return [];
  return cases.filter(isRecord).map((item) => ({
    id: stringValue(item.id, "unknown-case"),
    suite: optionalString(item.suite),
    category: optionalString(item.category),
    score: optionalNumber(item.score),
    action: item.action,
    fallbackUsed: item.fallbackUsed === true,
    actions: Array.isArray(item.actions) ? item.actions : undefined,
    finalState: item.finalState,
    metrics: isRecord(item.metrics)
      ? { finalScore: optionalNumber(item.metrics.finalScore) }
      : undefined,
  }));
}

function caseTurns(benchmarkCase: TranscriptCase): TranscriptTurn[] {
  const finalState = isRecord(benchmarkCase.finalState)
    ? benchmarkCase.finalState
    : null;
  const events = Array.isArray(finalState?.events) ? finalState.events : [];
  const eventTurns = events.filter(isRecord).map((event, index) => ({
    turn: numberValue(event.turn, index + 1),
    playerId: stringValue(event.playerId, "unknown-player"),
    action: event.action,
    fallbackUsed: event.fallbackUsed === true,
    playResult: optionalString(event.playResult),
    criticalDiscard: event.criticalDiscard === true,
    message: optionalString(event.message),
  }));
  if (eventTurns.length > 0) return eventTurns;

  if (benchmarkCase.actions) {
    return benchmarkCase.actions.filter(isRecord).map((action, index) => ({
      turn: numberValue(action.turn, index + 1),
      playerId: stringValue(action.playerId, "unknown-player"),
      action: action.action,
      fallbackUsed: action.fallbackUsed === true,
      criticalDiscard: false,
    }));
  }

  if (benchmarkCase.action) {
    return [
      {
        turn: 1,
        playerId: "acting player",
        action: benchmarkCase.action,
        fallbackUsed: benchmarkCase.fallbackUsed === true,
        criticalDiscard: false,
      },
    ];
  }
  return [];
}

function Badge({ children }: { children: React.ReactNode }) {
  return (
    <span className="rounded-sm border px-1.5 py-0.5 text-xs font-medium">
      {children}
    </span>
  );
}

function formatScore(score: number | undefined): string {
  if (score === undefined) return "n/a";
  return score <= 1 ? `${Math.round(score * 1000) / 10}%` : String(score);
}

function formatStacks(finalState: unknown): string {
  if (!isRecord(finalState) || !isRecord(finalState.stacks)) return "n/a";
  const stacks = finalState.stacks;
  return ["red", "blue", "green"]
    .map((color) => `${color} ${numberValue(stacks[color], 0)}`)
    .join(" / ");
}

function formatAction(action: unknown): string {
  if (!isRecord(action)) return "unknown action";
  if (action.action === "play") return `played card ${numberValue(action.cardIndex, 0)}`;
  if (action.action === "discard") {
    return `discarded card ${numberValue(action.cardIndex, 0)}`;
  }
  if (action.action === "clue_color") {
    return `clued ${stringValue(action.targetPlayerId, "player")} ${stringValue(action.color, "color")}`;
  }
  if (action.action === "clue_rank") {
    return `clued ${stringValue(action.targetPlayerId, "player")} rank ${numberValue(action.rank, 0)}`;
  }
  return stringValue(action.action, "unknown action");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function stringValue(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

function numberValue(value: unknown, fallback: number): number {
  return typeof value === "number" ? value : fallback;
}

function displayTurn(turn: number): number {
  return turn + 1;
}
