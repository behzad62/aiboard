import assert from "node:assert/strict";
import test from "node:test";

import { critiqueFindingsContent } from "../src/agent-prompts.js";
import { planCritiqueMismatchMessage } from "../src/architect-tools.js";
import { lifecycleEventResult } from "../src/lifecycle-receipt.js";
import type { SchedulerEvent } from "../src/scheduler-store.js";
import { ToolRegistry } from "../src/tool-registry.js";

const event = (payload: Record<string, unknown>): SchedulerEvent => ({
  eventId: "sched_1", runId: "run_1", sequence: 28, type: "planning.plan_drafted",
  occurredAt: "2026-10-18T00:00:00.000Z", actor: { role: "architect", id: "architect_1" },
  idempotencyKey: "draft-1", payload,
} as SchedulerEvent);

// Tunnel run: an 86 KB plan echo rode every later Architect call (115k input for a 109-token decision).
test("a large lifecycle event comes back as a compact receipt that keeps its ids and digest", () => {
  const small = event({ decision: "build", addressedParts: ["a", "b"] });
  assert.equal(lifecycleEventResult(small), small, "small events are echoed whole");
  const tasks = Array.from({ length: 40 }, (_, index) => ({ id: `task-${index}`, outcome: "x".repeat(200) }));
  const receipt = lifecycleEventResult(event({ revision: { revisionId: "plan-1", digest: "d".repeat(64), tasks } })) as {
    recorded: string; sequence: number; payload: { revision: Record<string, unknown> };
  };
  assert.equal(receipt.recorded, "planning.plan_drafted");
  assert.equal(receipt.sequence, 28);
  assert.equal(receipt.payload.revision.revisionId, "plan-1");
  assert.equal(receipt.payload.revision.digest, "d".repeat(64));
  assert.equal(receipt.payload.revision.tasks, "[40 items]");
  assert.ok(JSON.stringify(receipt).length < 1_000);
});

test("the critique-resolution action carries the blocking findings, not just their ids", () => {
  const finding = (findingId: string) => ({ findingId, severity: "blocking", category: "coverage", taskIds: ["t1"], claim: `claim ${findingId}`, evidence: ["e"] });
  const planCritique = {
    history: [],
    current: {
      critiqueId: "crit-1", planRevision: 1, status: "submitted", requestedAt: "x",
      findings: [finding("F-01"), finding("F-02"), { ...finding("N-01"), severity: "advisory" }],
      blockingFindingIds: ["F-01", "F-02"],
    },
  } as never;
  const content = critiqueFindingsContent({ type: "plan_critique_resolution_required", critiqueId: "crit-1" }, planCritique)!;
  assert.match(content, /claim F-01/);
  assert.match(content, /claim F-02/);
  assert.doesNotMatch(content, /N-01/);
  assert.equal(critiqueFindingsContent({ type: "plan_critique_resolution_required", critiqueId: "other" }, planCritique), undefined);
  assert.equal(critiqueFindingsContent({ type: "review_required" }, planCritique), undefined);
});

test("a refused critique resolution names the missing, unknown and repeated finding ids", () => {
  const current = { status: "submitted", critiqueId: "crit-1", planRevision: 1, blockingFindingIds: ["F-01", "F-02"] };
  const message = planCritiqueMismatchMessage(current, "crit-1", 1, ["F-01", "F-99", "F-01"]);
  assert.match(message, /missing blocking finding\(s\) F-02/);
  assert.match(message, /not blocking findings of this critique: F-99/);
  assert.match(message, /repeated: F-01/);
  assert.match(planCritiqueMismatchMessage(current, "crit-0", 2, ["F-01", "F-02"]), /critiqueId must be crit-1; planRevision must be 1/);
});

test("invalid tool arguments tell the model which fields failed", async () => {
  const registry = new ToolRegistry();
  registry.register({
    definition: { name: "submit_verdict", description: "Submit", inputSchema: { type: "object" }, readOnly: false, effect: "none" },
    validate: () => ({ ok: false, issues: ["obligationVerdicts[2].severity must be blocking or advisory"] }),
    execute: async () => ({ content: [], isError: false }),
  });
  const result = await registry.invoke(
    { type: "tool_call", callId: "c1", name: "submit_verdict", arguments: {} },
    { runId: "run_1", sessionId: "s1", actor: { role: "verifier", id: "v1" } },
  );
  assert.equal(result.isError, true);
  assert.match(JSON.stringify(result.content), /obligationVerdicts\[2\]\.severity must be blocking or advisory/);
});
