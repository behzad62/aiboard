import { NativeRunnerError, type NativeRunnerConnection } from "./runner-v2";

export interface NativeLiveModelEvent {
  runId: string;
  sequence: number;
  sessionId: string;
  actor: { role: "architect" | "worker" | "subagent" | "verifier"; id: string };
  turn: number;
  attempt: number;
  phase: "reset" | "delta" | "finish" | "discard";
  text: string;
  /** Delta channel; absent means answer text. */
  channel?: LiveOutputChannel;
  /** Snapshots only: the in-flight turn as ordered channel segments. */
  segments?: LiveOutputSegment[];
}

export type LiveOutputChannel = "text" | "reasoning" | "tool";
export interface LiveOutputSegment {
  channel: LiveOutputChannel;
  text: string;
}

/** Authenticated SSE reader. Cursor is managed by the caller across reconnects. */
export async function followNativeLiveModelOutput(
  connection: NativeRunnerConnection,
  runId: string,
  after: number,
  onEvent: (event: NativeLiveModelEvent, snapshot: boolean) => void,
  signal: AbortSignal,
  fetchImpl: typeof fetch = fetch,
): Promise<number> {
  const response = await fetchImpl(
    `${connection.url.replace(/\/$/, "")}/v2/runs/${encodeURIComponent(runId)}/build/live-output?after=${after}`,
    {
      headers: { Authorization: `Bearer ${connection.token}`, Accept: "text/event-stream" },
      signal,
      cache: "no-store",
    },
  );
  if (!response.ok || !response.body) {
    throw new NativeRunnerError(`Live output unavailable (HTTP ${response.status})`, response.status);
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let cursor = after;
  try {
    while (!signal.aborted) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
      // Bound input in case of a malformed peer never terminating an SSE frame.
      if (buffer.length > 512_000) throw new Error("Live output event exceeded size limit");
      let boundary: number;
      while ((boundary = buffer.indexOf("\n\n")) >= 0) {
        const block = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const line = block.split("\n").find((value) => value.startsWith("data: "));
        if (!line) continue;
        let event: NativeLiveModelEvent;
        try { event = JSON.parse(line.slice(6)) as NativeLiveModelEvent; }
        catch { continue; }
        if (!event || event.runId !== runId || typeof event.text !== "string" ||
          typeof event.sessionId !== "string" || !event.actor ||
          !["reset", "delta", "finish", "discard"].includes(event.phase)) continue;
        const snapshot = block.startsWith("event: snapshot") || block.includes("\nevent: snapshot");
        if (snapshot || event.sequence > cursor) {
          if (!snapshot) cursor = event.sequence;
          onEvent(event, snapshot);
        }
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  return cursor;
}
