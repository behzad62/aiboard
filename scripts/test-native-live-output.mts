import assert from "node:assert/strict";
import { followNativeLiveModelOutput } from "../lib/client/native-model-output";
import { applyLiveModelEvent } from "../lib/client/live-model-feed";
import type { NativeLiveModelEvent } from "../lib/client/native-model-output";

const base: NativeLiveModelEvent = {
  runId: "r1", sequence: 1, sessionId: "s1", turn: 1, attempt: 1,
  actor: { role: "architect", id: "a1" }, phase: "reset", text: "",
};
let turns = applyLiveModelEvent([], base);
turns = applyLiveModelEvent(turns, { ...base, sequence: 2, phase: "delta", text: "first " });
turns = applyLiveModelEvent(turns, { ...base, sequence: 3, phase: "delta", text: "half" });
assert.equal(turns[0]?.content, "first half");
turns = applyLiveModelEvent(turns, { ...base, sequence: 4, attempt: 2, phase: "reset", text: "" });
assert.equal(turns[0]?.content, "");
turns = applyLiveModelEvent(turns, { ...base, sequence: 5, attempt: 1, phase: "delta", text: "old" });
assert.equal(turns[0]?.content, "");
turns = applyLiveModelEvent(turns, { ...base, sequence: 6, attempt: 2, phase: "delta", text: "recovered" });
turns = applyLiveModelEvent(turns, { ...base, sequence: 6, attempt: 2, phase: "delta", text: "ignored", }, true);
assert.equal(turns[0]?.content, "ignored");
turns = applyLiveModelEvent(turns, { ...base, sequence: 7, attempt: 2, phase: "finish", text: "" });
assert.equal(turns[0]?.streaming, false);
turns = applyLiveModelEvent(turns, { ...base, sequence: 8, attempt: 2, phase: "discard", text: "" });
assert.equal(turns.length, 0);

const events = [
  { ...base, sequence: 1, phase: "reset" },
  { ...base, sequence: 2, phase: "delta", text: "hello" },
  { ...base, sequence: 3, phase: "finish" },
] as NativeLiveModelEvent[];
const frames = events.map((value) => `id: ${value.sequence}\nevent: ${value.phase}\ndata: ${JSON.stringify(value)}\n\n`).join("");
const encoder = new TextEncoder();
const bytes = encoder.encode(frames);
const controller = new AbortController();
const received: string[] = [];
const cursor = await followNativeLiveModelOutput(
  { url: "http://127.0.0.1:8787", token: "private" }, "r1", 0,
  (event) => received.push(event.phase), controller.signal,
  async (_url, init) => {
    assert.equal((init?.headers as Record<string, string>).Authorization, "Bearer private");
    const stream = new ReadableStream<Uint8Array>({
      start(state) {
        state.enqueue(bytes.slice(0, 13));
        state.enqueue(bytes.slice(13, 42));
        state.enqueue(bytes.slice(42));
        state.close();
      },
    });
    return new Response(stream, { headers: { "content-type": "text/event-stream" } });
  },
);
assert.equal(cursor, 3);
assert.deepEqual(received, ["reset", "delta", "finish"]);
// Channels: reasoning and tool starts become their own segments; content stays answer text only.
let channelTurns = applyLiveModelEvent([], { ...base, sessionId: "s2" });
channelTurns = applyLiveModelEvent(channelTurns, { ...base, sessionId: "s2", sequence: 2, phase: "delta", text: "plan ", channel: "reasoning" });
channelTurns = applyLiveModelEvent(channelTurns, { ...base, sessionId: "s2", sequence: 3, phase: "delta", text: "it", channel: "reasoning" });
channelTurns = applyLiveModelEvent(channelTurns, { ...base, sessionId: "s2", sequence: 4, phase: "delta", text: "Reading." });
channelTurns = applyLiveModelEvent(channelTurns, { ...base, sessionId: "s2", sequence: 5, phase: "delta", text: "fs_read", channel: "tool" });
assert.equal(channelTurns[0]?.content, "Reading.");
assert.deepEqual(channelTurns[0]?.segments, [
  { channel: "reasoning", text: "plan it" }, { channel: "text", text: "Reading." }, { channel: "tool", text: "fs_read" },
]);
const restored = applyLiveModelEvent([], { ...base, sessionId: "s3", sequence: 9, phase: "delta", text: "Reading.",
  segments: [{ channel: "reasoning", text: "x" }, { channel: "text", text: "Reading." }] }, true);
assert.equal(restored[0]?.segments.length, 2, "a reconnect snapshot restores the segment structure");
console.log("PASS native live browser: retry isolation, snapshots, SSE authorization, fragmented frames");
