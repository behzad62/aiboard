import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  probeProcessHostSemantics,
  type ProcessHostSemanticProbeSource,
} from "../src/process-host-semantic-probes.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

test("live Windows construction consumes semantic facts and keeps portable fallback after active Job failure", () => {
  const factory = readFileSync(new URL("../src/native-build-factory.ts", import.meta.url), "utf8");
  assert.match(factory, /probeProcessHostSemantics\(/);
  assert.match(factory, /activeJobCreateClose:\s*async\s*\(\)\s*=>\s*await managedProcesses\.probeActiveJobCreateClose\(\)/);
  assert.match(factory, /windowsFacts\?\.jobContainment\s*===\s*["']verified["']/);
  const portable = factory.indexOf('stableAdapterId: "runner-windows-portable-adapter-v1"');
  const gatedJob = factory.indexOf("windowsFacts?.jobContainment");
  assert.ok(portable > gatedJob, "portable registration must remain outside the optional Job fact gate");
});

test("Windows Job backend source cannot depend on managed facade or agent/model contracts", () => {
  const sourceText = readFileSync(
    new URL("../src/windows-process-backend.ts", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(sourceText, /managed-process(?:\.js)?/);
  assert.doesNotMatch(sourceText, /agent-contracts|AgentActor|role:\s*["']worker["']/);
});

test("extracted Windows Job host is concrete and the transitive backend path is actor-free", () => {
  const backend = readFileSync(new URL("../src/windows-process-backend.ts", import.meta.url), "utf8");
  const host = readFileSync(new URL("../src/windows-job-process-host.ts", import.meta.url), "utf8");
  const managed = readFileSync(new URL("../src/managed-process.ts", import.meta.url), "utf8");

  assert.match(host, /class AuthenticatedWindowsJobProcessHost/);
  assert.match(host, /spawn\(/);
  assert.match(host, /private readonly records/);
  assert.doesNotMatch(host, /from\s+["'][^"']*managed-process(?:\.js)?["']|agent-contracts|AgentActor|ToolExecutionContext|role:\s*["']worker["']/);
  assert.doesNotMatch(managed, /implements WindowsJobProcessHost|internalOwnershipContext|launchOwnedMechanics|signalOwnedMechanics|reconcileOwnedMechanics|releaseOwnedMechanics|readOwnedOutputMechanics/);
  assert.match(managed, /createWindowsJobProcessHost\(/);
  assert.match(backend, /WindowsJobProcessHost/);
});

test("concrete Windows Job host rejects launch before spawning off Windows", async () => {
  const stateDirectory = mkdtempSync(join(tmpdir(), "runner-job-host-"));
  try {
    const host = createWindowsJobProcessHost({ stateDirectory, platform: "linux" });
    await assert.rejects(
      host.launchOwned({ runId: "run", sessionId: "session", command: "tool", args: [], workingDirectory: ".", environment: {} }),
      /containment is unavailable/i,
    );
  } finally {
    rmSync(stateDirectory, { recursive: true, force: true });
  }
});
