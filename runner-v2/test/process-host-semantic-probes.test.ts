import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  probeProcessHostSemantics,
  type ProcessHostSemanticProbeSource,
} from "../src/process-host-semantic-probes.js";
import { createWindowsJobProcessHost } from "../src/windows-job-process-host.js";

function source(
  values: Partial<Record<keyof ProcessHostSemanticProbeSource, boolean | "partial">> = {},
): ProcessHostSemanticProbeSource {
  return {
    portableDuplex: async () => values.portableDuplex ?? true,
    windowsBatchArgv: async () => values.windowsBatchArgv ?? true,
    exactTreeBirth: async () => values.exactTreeBirth ?? true,
    activeJobCreateClose: async () => values.activeJobCreateClose ?? false,
  };
}

test("process host semantic facts are independent, immutable, and preserve partial states", async () => {
  const facts = await probeProcessHostSemantics(source({
    portableDuplex: true,
    windowsBatchArgv: "partial",
    exactTreeBirth: false,
    activeJobCreateClose: true,
  }));

  assert.deepEqual(facts, {
    portableDuplex: "verified",
    windowsBatchArgv: "partial",
    exactTreeBirth: "unavailable",
    jobContainment: "verified",
  });
  assert.equal(Object.isFrozen(facts), true);
});

test("Job unavailability never disables independently verified portable or batch semantics", async () => {
  const facts = await probeProcessHostSemantics(source({ activeJobCreateClose: false }));
  assert.equal(facts.portableDuplex, "verified");
  assert.equal(facts.windowsBatchArgv, "verified");
  assert.equal(facts.jobContainment, "unavailable");
});

test("Job verification requires the active create-and-close probe result", async () => {
  let activeCalls = 0;
  const facts = await probeProcessHostSemantics({
    ...source(),
    activeJobCreateClose: async () => {
      activeCalls += 1;
      return false;
    },
  });
  assert.equal(activeCalls, 1);
  assert.equal(facts.jobContainment, "unavailable");
});

test("Windows Job backend source cannot depend on managed facade or agent/model contracts", () => {
  const sourceText = readFileSync(
    new URL("../src/windows-process-backend.ts", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(sourceText, /managed-process(?:\.js)?/);
  assert.doesNotMatch(sourceText, /agent-contracts|AgentActor|role:\s*["']worker["']/);
});

test("extracted Windows Job host exposes only the actor-free low-level contract", async () => {
  const calls: string[] = [];
  const host = createWindowsJobProcessHost({
    launchOwned: async (request) => { calls.push(`launch:${request.sessionId}`); return hostSnapshot(); },
    signalOwned: async (_id, _signal, owner) => { calls.push(`signal:${owner.sessionId}`); return hostSnapshot(); },
    reconcileOwned: async () => ({ ...hostSnapshot(), ownershipReleased: false }),
    releaseOwned: async () => ({ ...hostSnapshot(), ownershipReleased: true }),
    readOwnedOutput: () => ({ stdout: new Uint8Array(), stderr: new Uint8Array(), next: { stdout: 0, stderr: 0 } }),
    probeActiveJobCreateClose: async () => true,
  });
  await host.launchOwned({ runId: "run", sessionId: "session", command: "tool", args: [], workingDirectory: ".", environment: {} });
  await host.signalOwned("process", "SIGTERM", { runId: "run", sessionId: "session" });
  assert.deepEqual(calls, ["launch:session", "signal:session"]);
  assert.equal(Object.isFrozen(host), true);
  assert.deepEqual(Object.keys(host).sort(), ["launchOwned", "probeActiveJobCreateClose", "readOwnedOutput", "reconcileOwned", "releaseOwned", "signalOwned"]);
});

function hostSnapshot() {
  return { processId: "process", pid: 1, status: "running" as const, exitCode: null, signal: null, startedAt: "now", updatedAt: "now", stdout: "", stderr: "" };
}
