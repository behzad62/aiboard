/** Transient, bounded, process-local model-output fanout. Never enters the audit log. */
import type { AgentActor, LiveOutputChannel } from "./agent-contracts.js";

export interface LiveModelSegment {
  channel: LiveOutputChannel;
  text: string;
}

export type LiveModelPhase = "reset" | "delta" | "finish" | "discard";
export interface LiveModelEvent {
  runId: string;
  sequence: number;
  sessionId: string;
  actor: AgentActor;
  turn: number;
  attempt: number;
  phase: LiveModelPhase;
  text: string;
  /** Delta channel; absent means answer text. */
  channel?: LiveOutputChannel;
  /** Active snapshots only: the in-flight turn as ordered channel segments. */
  segments?: LiveModelSegment[];
}
interface RunBuffer {
  sequence: number;
  events: LiveModelEvent[];
  active: Map<string, LiveModelEvent>;
  attempts: Map<string, number>;
  listeners: Set<(event: LiveModelEvent) => void>;
}
const MAX_RUNS = 12;
const MAX_EVENTS = 512;
const MAX_ACTIVE_BYTES = 100_000;
const runs = new Map<string, RunBuffer>();
export const liveModelKey = (e: Pick<LiveModelEvent, "sessionId" | "turn">) =>
  `${e.sessionId}:${e.turn}`;

function buffer(runId: string): RunBuffer {
  let run = runs.get(runId);
  if (!run) {
    // Never evict a run with live subscribers; the runner may serve multiple builds.
    if (runs.size >= MAX_RUNS) {
      const idle = [...runs].find(([, value]) => value.listeners.size === 0);
      if (idle) runs.delete(idle[0]);
    }
    run = { sequence: 0, events: [], active: new Map(), attempts: new Map(), listeners: new Set() };
    runs.set(runId, run);
  }
  return run;
}

export function publishLiveModelOutput(input: Omit<LiveModelEvent, "sequence">): void {
  const run = buffer(input.runId);
  const key = liveModelKey(input);
  const latestAttempt = run.attempts.get(key) ?? 0;
  if (input.attempt < latestAttempt) return;
  if (input.attempt > latestAttempt) {
    run.attempts.set(key, input.attempt);
    // Bound retained attempt identities independently of the recent-event ring.
    if (run.attempts.size > 2048) {
      const first = run.attempts.keys().next().value;
      if (first) run.attempts.delete(first);
    }
  }
  if (input.phase === "reset") run.active.delete(key);
  if (input.phase === "delta" && input.text) {
    const previous = run.active.get(key);
    const channel = input.channel ?? "text";
    const segments = [...(previous?.segments ?? [])];
    const last = segments.at(-1);
    if (last && last.channel === channel && channel !== "tool") segments[segments.length - 1] = { channel, text: last.text + input.text };
    else segments.push({ channel, text: input.text });
    let total = segments.reduce((sum, segment) => sum + segment.text.length, 0);
    while (total > MAX_ACTIVE_BYTES && segments.length > 1) total -= segments.shift()!.text.length;
    const answer = channel === "text" ? ((previous?.text ?? "") + input.text).slice(-MAX_ACTIVE_BYTES) : previous?.text ?? "";
    const { channel: _deltaChannel, ...rest } = input;
    run.active.set(key, { ...rest, text: answer, segments, sequence: run.sequence + 1 });
  }
  if (input.phase === "finish" || input.phase === "discard") run.active.delete(key);
  const event: LiveModelEvent = { ...input, sequence: ++run.sequence };
  run.events.push(event);
  if (run.events.length > MAX_EVENTS) run.events.splice(0, run.events.length - MAX_EVENTS);
  // A disconnected SSE client must never fail an agent's provider call.
  for (const listener of run.listeners) {
    try { listener(event); } catch { run.listeners.delete(listener); }
  }
}

export function recentLiveModelOutput(runId: string, after: number): LiveModelEvent[] {
  return (runs.get(runId)?.events ?? []).filter((event) => event.sequence > after);
}
export function activeLiveModelOutput(runId: string): LiveModelEvent[] {
  return [...(runs.get(runId)?.active.values() ?? [])];
}
export function subscribeLiveModelOutput(
  runId: string, listener: (event: LiveModelEvent) => void
): () => void {
  const run = buffer(runId);
  run.listeners.add(listener);
  return () => run.listeners.delete(listener);
}
