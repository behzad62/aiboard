import { createHash } from "node:crypto";
import type { ArtifactStore } from "./artifact-store.js";
import { evidenceFactArtifactHashes, type EvidenceRecord, type EvidenceStore } from "./evidence-store.js";

/** Record bookkeeping is excluded; output bytes stay addressed by verified immutable hashes. */
export function evidenceContentDigest(record: EvidenceRecord): string {
  const ignored = new Set(["label", "startedAt", "finishedAt", "capturedAt", "reused_from", "executionSnapshot"]);
  const fact = Object.fromEntries(Object.entries(record.fact).filter(([key]) => !ignored.has(key)));
  if (fact.cleanup && typeof fact.cleanup === "object") {
    // A fresh process proof nonce/time does not change the observed cleanup result.
    fact.cleanup = Object.fromEntries(Object.entries(fact.cleanup).filter(([key]) => !["verifiedAt", "failedAt", "proofArtifactId"].includes(key)));
  }
  const content = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(content);
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, content(item)]));
    return value;
  };
  return createHash("sha256").update(JSON.stringify(content(fact))).digest("hex");
}

export function resolveEvidenceContent(store: EvidenceStore, artifacts: Pick<ArtifactStore, "verifySync">, runId: string, ids: readonly string[]): Record<string, string> {
  const unique = [...new Set(ids)];
  const rows = store.getByIds({runId, ids: unique});
  const result: Record<string, string> = {};
  for (const id of unique) {
    const record = rows.find((row) => row.id === id && row.runId === runId && row.status === "observed");
    if (!record) throw new Error(`Unresolved current-run evidence ${id}.`);
    for (const hash of evidenceFactArtifactHashes(record.fact)) artifacts.verifySync(hash);
    result[id] = evidenceContentDigest(record);
  }
  return result;
}
