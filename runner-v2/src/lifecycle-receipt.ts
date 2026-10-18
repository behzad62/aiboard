import type { SchedulerEvent } from "./scheduler-store.js";

/** Payloads up to this size are echoed whole; larger ones become a compact receipt. */
export const LIFECYCLE_ECHO_MAX_CHARS = 4_000;

/**
 * The tool result for an appended lifecycle event. Echoing the whole event put an 86 KB plan
 * revision (and an 18 KB ledger) back into the Architect conversation, where it rode every later
 * call (tunnel run: a 109-token decision cost 115k input tokens). The model already has what it
 * sent; it needs the receipt: event identity plus the ids and digests it must cite later.
 */
export function lifecycleEventResult(event: SchedulerEvent): unknown {
  if (JSON.stringify(event.payload).length <= LIFECYCLE_ECHO_MAX_CHARS) return event;
  return {
    recorded: event.type,
    sequence: event.sequence,
    eventId: event.eventId,
    payload: summarize(event.payload, 0),
    note: "Recorded as sent. Large fields are summarized; read them back with the matching read tool when needed.",
  };
}

function summarize(value: unknown, depth: number): unknown {
  if (value === null || typeof value !== "object") {
    return typeof value === "string" && value.length > 200 ? `${value.slice(0, 200)}… (${value.length} chars)` : value;
  }
  if (Array.isArray(value)) return `[${value.length} item${value.length === 1 ? "" : "s"}]`;
  if (depth >= 2) return "{…}";
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, summarize(entry, depth + 1)]));
}
