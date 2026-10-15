import assert from "node:assert/strict";
import test from "node:test";

import { searchOwnedProcesses } from "../src/cleanup-ownership.js";

interface StubObservation {
  processId: string;
  runId: string;
  sessionId: string;
  status: "running" | "stopped" | "exited_unknown";
}

function stubService(initial: StubObservation[], calls: string[]) {
  const live = new Map(initial.map((entry) => [entry.processId, { ...entry }]));
  return {
    listRun: async () => [...live.values()].map((entry) => ({ ...entry })),
    stopRun: async () => {
      calls.push("stopRun");
      for (const entry of live.values()) {
        if (entry.status === "running") entry.status = "stopped";
      }
    },
    stopProcesses: async (processIds: readonly string[]) => {
      for (const id of processIds) {
        calls.push(`stop:${id}`);
        const entry = live.get(id);
        if (entry && entry.status === "running") entry.status = "stopped";
      }
    },
  };
}

/**
 * T6b repair (R2-N6): with an attempt scope, only the attempt's sessions
 * are stop candidates, stopped individually; a live process from another
 * session is retained and reported, never swept up by a run-wide stop.
 */
test("a scoped process search stops only the attempt's sessions", async () => {
  const calls: string[] = [];
  const service = stubService([
    { processId: "p-attempt", runId: "r", sessionId: "worker:r:T1:1", status: "running" },
    { processId: "p-other", runId: "r", sessionId: "worker:r:T2:1", status: "running" },
    { processId: "p-unknown", runId: "r", sessionId: "worker:r:T1:1", status: "exited_unknown" },
  ], calls);
  const findings = await searchOwnedProcesses(service as never, "r", { sessionIds: ["worker:r:T1:1"] });
  assert.ok(!calls.includes("stopRun"), "a scoped search never uses the run-wide stop");
  assert.deepEqual(calls, ["stop:p-attempt"]);
  const byId = new Map(findings.map((finding) => [finding.processId, finding]));
  assert.equal(byId.get("p-attempt")?.action, "cleaned");
  assert.equal(byId.get("p-attempt")?.ownership, "proven");
  assert.equal(byId.get("p-other")?.action, "retained");
  assert.match(byId.get("p-other")?.reason ?? "", /outside the attempt's sessions/);
  assert.equal(byId.get("p-unknown")?.action, "retained");
});

/**
 * T6b repair (R2-N6): without a scope the search keeps the legacy
 * run-wide stop so phase-boundary cleanup stays complete.
 */
test("an unscoped process search keeps the run-wide stop", async () => {
  const calls: string[] = [];
  const service = stubService([
    { processId: "p-a", runId: "r", sessionId: "worker:r:T1:1", status: "running" },
    { processId: "p-b", runId: "r", sessionId: "reviewer:r:x", status: "running" },
  ], calls);
  const findings = await searchOwnedProcesses(service as never, "r");
  assert.ok(calls.includes("stopRun"), "an unscoped search still stops the run");
  assert.equal(findings.filter((finding) => finding.action === "cleaned").length, 2);
});
