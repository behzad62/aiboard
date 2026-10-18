import type { LiveOutputSegment, NativeLiveModelEvent } from "./native-model-output";

export interface LiveModelTurn {
  id: string;
  sessionId: string;
  actor: NativeLiveModelEvent["actor"];
  turn: number;
  attempt: number;
  /** Answer text only (what the transcript keeps). */
  content: string;
  /** Everything streamed, in order: reasoning (collapsed in the UI), answer text, tool-call starts. */
  segments: LiveOutputSegment[];
  streaming: boolean;
}

const MAX_SEGMENT_CHARS = 100_000;

function appendSegment(segments: readonly LiveOutputSegment[], segment: LiveOutputSegment): LiveOutputSegment[] {
  const next = [...segments];
  const last = next.at(-1);
  if (last && last.channel === segment.channel && segment.channel !== "tool") {
    next[next.length - 1] = { channel: last.channel, text: (last.text + segment.text).slice(-MAX_SEGMENT_CHARS) };
  } else {
    next.push(segment);
  }
  return next.slice(-200);
}

export function applyLiveModelEvent(
  current: readonly LiveModelTurn[],
  event: NativeLiveModelEvent,
  snapshot = false
): LiveModelTurn[] {
  const key = `live:${event.sessionId}:${event.turn}`;
  const existing = current.find((item) => item.id === key);
  const other = current.filter((item) => item.id !== key);
  // Reject events from attempts superseded by a retry.
  if (existing && event.attempt < existing.attempt) return [...other, existing];
  if (event.phase === "discard") return other;
  if (event.phase === "reset") {
    return [...other, {
      id: key, sessionId: event.sessionId, actor: event.actor, turn: event.turn,
      attempt: event.attempt, content: "", segments: [], streaming: true,
    }];
  }
  const sameAttempt = existing?.attempt === event.attempt;
  const channel = event.channel ?? "text";
  const segments = snapshot
    ? event.segments ?? (event.text ? [{ channel: "text" as const, text: event.text }] : [])
    : event.phase === "delta" && event.text
      ? appendSegment(sameAttempt ? existing?.segments ?? [] : [], { channel, text: event.text })
      : existing?.segments ?? [];
  const content = snapshot
    ? event.text
    : event.phase === "delta" && channel === "text"
      ? (sameAttempt ? existing?.content ?? "" : "") + event.text
      : sameAttempt || event.phase !== "delta" ? existing?.content ?? "" : "";
  return [...other, {
    id: key, sessionId: event.sessionId, actor: event.actor, turn: event.turn,
    attempt: event.attempt, content: content.slice(-100_000), segments,
    streaming: event.phase !== "finish",
  }].slice(-32);
}
