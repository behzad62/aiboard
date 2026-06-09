import { EventEmitter } from "events";
import type { OrchestratorEvent } from "./engine";

const emitters = new Map<string, EventEmitter>();

export function getDiscussionEmitter(discussionId: string): EventEmitter {
  let emitter = emitters.get(discussionId);
  if (!emitter) {
    emitter = new EventEmitter();
    emitter.setMaxListeners(50);
    emitters.set(discussionId, emitter);
  }
  return emitter;
}

export function emitDiscussionEvent(
  discussionId: string,
  event: OrchestratorEvent
): void {
  getDiscussionEmitter(discussionId).emit("event", event);
}

export function cleanupDiscussionEmitter(discussionId: string): void {
  const emitter = emitters.get(discussionId);
  if (emitter) {
    emitter.removeAllListeners();
    emitters.delete(discussionId);
  }
}

export function subscribeToDiscussion(
  discussionId: string,
  callback: (event: OrchestratorEvent) => void
): () => void {
  const emitter = getDiscussionEmitter(discussionId);
  emitter.on("event", callback);
  return () => emitter.off("event", callback);
}
