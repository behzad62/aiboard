import type { EvidenceRecord } from "../../src/evidence-store.js";

export function commandEvidence(
  id: string,
  overrides: Partial<Extract<EvidenceRecord["fact"], { kind: "command" }>> = {},
): EvidenceRecord {
  return {
    id,
    runId: "run_gate",
    taskId: "T1",
    actor: { role: "worker", id: "worker:T1:1" },
    status: "observed",
    fact: {
      kind: "command",
      label: "tests",
      command: "npm",
      args: ["test"],
      cwd: ".",
      startedAt: "2026-09-02T00:00:00.000Z",
      finishedAt: "2026-09-02T00:00:01.000Z",
      exitCode: 0,
      signal: null,
      timedOut: false,
      cancelled: false,
      outputTruncated: false,
      stdoutArtifactHash: "a".repeat(64),
      stderrArtifactHash: "b".repeat(64),
      ...overrides,
    },
    createdAt: "2026-09-02T00:00:01.000Z",
    idempotencyKey: `evidence:${id}`,
    attempt: 1,
  };
}
