/**
 * Browser-memory notes are retained for certified legacy builds and follow-up
 * passes. An active Runner V2 Build uses its durable guidance endpoint instead.
 */

import type { NativeBuildProjection } from "./runner-v2";
import type { Discussion } from "../db/schema";

export type BuildNoteDeliveryMode =
  | "memory_queue"
  | "native_unknown"
  | "native_active"
  | "follow_up";

export interface BuildGuidanceDeliveryIdentity {
  text: string;
  guidanceId: string;
  idempotencyKey: string;
}

export function resolveBuildGuidanceIdentity(
  current: BuildGuidanceDeliveryIdentity | null,
  text: string,
  createId: () => string,
): BuildGuidanceDeliveryIdentity {
  const trimmed = text.trim();
  if (current?.text === trimmed) return current;
  const identity = `guidance-${createId()}`;
  return { text: trimmed, guidanceId: identity, idempotencyKey: identity };
}

export function classifyBuildNoteDelivery(
  discussion: Pick<Discussion, "nativeBuildRunId">,
  projection: Pick<NativeBuildProjection, "runId" | "status"> | null,
): BuildNoteDeliveryMode {
  if (!discussion.nativeBuildRunId) return "memory_queue";
  if (!projection || projection.runId !== discussion.nativeBuildRunId) {
    return "native_unknown";
  }
  return projection.status === "completed" ? "follow_up" : "native_active";
}

export function nativeBuildAttachmentNotice(mode: BuildNoteDeliveryMode): string | null {
  if (mode !== "native_active" && mode !== "native_unknown") return null;
  return "Only text guidance is sent to this Runner V2 Build now; files require a new follow-up Build.";
}

const queues = new Map<string, string[]>();

export function queueBuildNote(discussionId: string, note: string): void {
  const queue = queues.get(discussionId) ?? [];
  queue.push(note);
  queues.set(discussionId, queue);
}

/** Return and clear all notes queued for a discussion. */
export function drainBuildNotes(discussionId: string): string[] {
  const queue = queues.get(discussionId) ?? [];
  queues.delete(discussionId);
  return queue;
}
