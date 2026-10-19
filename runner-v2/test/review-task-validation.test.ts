import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createArchitectTools } from "../src/architect-tools.js";
import { SqliteSchedulerStore } from "../src/sqlite-scheduler-store.js";

test("review_task names the malformed field instead of the present top-level ones", () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-review-task-validation-"));
  const store = new SqliteSchedulerStore(join(root, "scheduler.sqlite"));
  try {
    const tool = createArchitectTools({
      store,
      clock: () => "2026-10-19T00:00:00.000Z",
      architectAction: { reason: { type: "review_required", taskId: "T1" }, sequence: 1 },
    } as never).find((candidate) => candidate.definition.name === "review_task");
    assert.ok(tool, "review_task is offered on review_required");
    const base = { taskId: "T1", decision: "approved", summary: "ok", evidenceArtifactHashes: ["a".repeat(64)] };
    assert.equal(tool.validate(base).ok, true);
    const issues = (input: unknown) => { const result = tool.validate(input); return result.ok ? [] : result.issues; };
    assert.match(issues({ ...base, planReconciliation: { revision: 7, summary: "scope only", taskUpdates: [] } })[0]!, /must change the plan.*findingDispositions/);
    assert.match(issues({ ...base, findingDispositions: [{ findingId: "f1", resolution: "accepted", rationale: "x" }] })[0]!, /findingDispositions is malformed/);
    assert.match(issues({ ...base, claimDispositions: [{ claimId: "c1", status: "maybe", rationale: "x" }] })[0]!, /claimDispositions is malformed/);
    assert.match(issues({ ...base, decision: "maybe" })[0]!, /taskId, decision, summary/);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
