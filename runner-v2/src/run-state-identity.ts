import { createHash } from "node:crypto";

/**
 * Stable, filesystem-safe state segment for a public Runner run identity.
 * Every composition root that addresses builds/<run> must use this function.
 */
export function runnerRunStateSegment(runId: string): string {
  const readable = runId
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "run";
  return `${readable}-${createHash("sha256").update(runId).digest("hex").slice(0, 10)}`;
}
