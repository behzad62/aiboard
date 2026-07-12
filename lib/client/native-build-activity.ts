import type { NativeBuildEvent } from "./runner-v2";

export interface NativeBuildActivityEntry {
  id: string;
  at: string;
  phase: "judging" | "model_streaming";
  message: string;
}

export function nativeBuildActivityEntries(
  runId: string,
  events: readonly NativeBuildEvent[],
  limit = 40,
  formatTime: (occurredAt: string) => string = (occurredAt) =>
    new Date(occurredAt).toLocaleTimeString()
): NativeBuildActivityEntry[] {
  const boundedLimit = Number.isSafeInteger(limit) && limit > 0 ? limit : 40;
  return [...events]
    .sort((left, right) => right.sequence - left.sequence)
    .slice(0, boundedLimit)
    .map((event) => {
      const taskId =
        typeof event.payload.taskId === "string"
          ? event.payload.taskId
          : undefined;
      const status =
        typeof event.payload.status === "string"
          ? event.payload.status
          : undefined;
      const summary = taskId
        ? ` — ${taskId}${status ? ` → ${status}` : ""}`
        : "";
      return {
        id: `native:${runId}:${event.sequence}`,
        at: formatTime(event.occurredAt),
        phase:
          event.actor.role === "architect" ? "judging" : "model_streaming",
        message: `${event.actor.role} ${event.actor.id}: ${event.type}${summary}`,
      };
    });
}
