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

export function preserveEditedBuildNoteDraft(
  currentDraft: string,
  submittedDraft: string,
): string {
  return currentDraft === submittedDraft ? "" : currentDraft;
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

export async function resolveBuildNoteSubmissionRoute(
  discussion: Pick<Discussion, "nativeBuildRunId">,
  projection: NativeBuildProjection | null,
  loadNativeProjection: () => Promise<NativeBuildProjection>,
): Promise<{
  mode: Exclude<BuildNoteDeliveryMode, "native_unknown">;
  projection: NativeBuildProjection | null;
}> {
  let currentProjection = projection;
  let mode = classifyBuildNoteDelivery(discussion, currentProjection);
  if (mode === "native_unknown") {
    currentProjection = await loadNativeProjection();
    mode = classifyBuildNoteDelivery(discussion, currentProjection);
  }
  if (mode === "native_unknown") {
    throw new Error(
      `Runner returned Build ${currentProjection?.runId ?? "unknown"}, which does not match the saved Runner V2 Build ${discussion.nativeBuildRunId ?? "unknown"}. Reconnect Runner V2 before sending guidance or files.`,
    );
  }
  return { mode, projection: currentProjection };
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
