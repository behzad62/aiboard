import type { NativeLiveModelEvent } from "./native-model-output";

export interface LiveModelTurn {
  id: string;
  sessionId: string;
  actor: NativeLiveModelEvent["actor"];
  turn: number;
  attempt: number;
  content: string;
  streaming: boolean;
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
      attempt: event.attempt, content: "", streaming: true,
    }];
  }
  const content = snapshot
    ? event.text
    : event.phase === "delta"
      ? (existing?.attempt === event.attempt ? existing.content : "") + event.text
      : existing?.content ?? "";
  return [...other, {
    id: key, sessionId: event.sessionId, actor: event.actor, turn: event.turn,
    attempt: event.attempt, content: content.slice(-100_000),
    streaming: event.phase !== "finish",
  }].slice(-32);
}
