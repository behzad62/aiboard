/**
 * User notes for a running (or finished) build. The page queues notes here;
 * the build engine drains them at every Architect decision point (plan,
 * review, summary) so the Architect can act on them mid-build. Notes queued
 * after a build finished survive until a follow-up pass picks them up.
 *
 * Kept in its own module so the page can import it without pulling the whole
 * build engine into the main bundle (the engine is loaded dynamically).
 */

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
