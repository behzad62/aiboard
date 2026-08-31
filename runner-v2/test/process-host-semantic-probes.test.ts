import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  probeProcessHostSemantics,
  selectWindowsProcessBackendKinds,
  type ProcessHostSemanticProbeSource,
} from "../src/process-host-semantic-probes.js";
import { createWindowsJobProcessHost } from "../src/windows-job-process-host.js";
import {
  createWindowsProcessSemanticProbeSource,
  minimalWindowsSemanticProbeEnvironment,
  removeInactiveSemanticProbeRoot,
  removeUnboundSemanticProbeRoot,
  requireEmptyAndRelease,
  waitForWindowsSemanticProbe,
} from "../src/windows-process-semantic-probes.js";
import type { ProcessBackendBinding } from "../src/process-backend.js";
import type { WindowsProcessBackend } from "../src/windows-process-backend.js";

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

async function waitUntilProcessAbsent(pid: number, deadlineMs: number): Promise<void> {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    try { process.kill(pid, 0); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return; throw error; }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
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

test("each Windows semantic fact toggles only its own backend or launch consumer", () => {
  const verified = {
    portableDuplex: "verified",
    windowsBatchArgv: "verified",
    exactTreeBirth: "partial",
    jobContainment: "verified",
  } as const;
  assert.deepEqual(selectWindowsProcessBackendKinds(verified), ["job", "portable"]);
  assert.deepEqual(selectWindowsProcessBackendKinds({ ...verified, jobContainment: "unavailable" }), ["portable"]);
  assert.deepEqual(selectWindowsProcessBackendKinds({ ...verified, portableDuplex: "unavailable" }), ["job"]);
  assert.deepEqual(selectWindowsProcessBackendKinds({ ...verified, windowsBatchArgv: "unavailable" }), ["job", "portable"]);
  assert.deepEqual(selectWindowsProcessBackendKinds({ ...verified, exactTreeBirth: "unavailable" }), ["job", "portable"]);
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

test("a hung optional active Job probe is killed without blocking verified portable facts", { timeout: 10_000 }, async (t) => {
  if (process.platform !== "win32") { t.skip("The real child watchdog fixture requires Windows."); return; }
  const root = mkdtempSync(join(tmpdir(), "aiboard-windows-job-probe-watchdog-"));
  const pidPath = join(root, "probe.pid");
  const host = createWindowsJobProcessHost({
    stateDirectory: join(root, "state"),
    activeJobProbe: {
      executable: process.execPath,
      arguments: ["-e", `require('node:fs').writeFileSync(${JSON.stringify(pidPath)},String(process.pid));setInterval(()=>{},1000)`],
      deadlineMs: 100,
    },
  } as Parameters<typeof createWindowsJobProcessHost>[0] & {
    activeJobProbe: { executable: string; arguments: string[]; deadlineMs: number };
  });
  try {
    const startedAt = Date.now();
    const facts = await probeProcessHostSemantics({
      portableDuplex: async () => true,
      windowsBatchArgv: async () => true,
      exactTreeBirth: async () => "partial",
      activeJobCreateClose: async () => await host.probeActiveJobCreateClose(),
    });
    assert.ok(Date.now() - startedAt < 2_000, "the optional Job fact must settle within its own watchdog");
    assert.deepEqual(facts, {
      portableDuplex: "verified",
      windowsBatchArgv: "verified",
      exactTreeBirth: "partial",
      jobContainment: "unavailable",
    });
    const pid = Number(readFileSync(pidPath, "utf8"));
    await waitUntilProcessAbsent(pid, 2_000);
    assert.throws(() => process.kill(pid, 0), (error: NodeJS.ErrnoException) => error.code === "ESRCH");
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 30, retryDelay: 50 });
  }
});

test("the healthy active Job probe still verifies real create-and-close semantics", async (t) => {
  if (process.platform !== "win32") { t.skip("The active Job fixture requires Windows."); return; }
  const stateDirectory = mkdtempSync(join(tmpdir(), "aiboard-windows-job-probe-healthy-"));
  try {
    const host = createWindowsJobProcessHost({ stateDirectory });
    assert.equal(await host.probeActiveJobCreateClose(), true);
  } finally {
    rmSync(stateDirectory, { recursive: true, force: true, maxRetries: 30, retryDelay: 50 });
  }
});

test("live Windows construction consumes semantic facts and keeps portable fallback after active Job failure", () => {
  const factory = readFileSync(new URL("../src/native-build-factory.ts", import.meta.url), "utf8");
  assert.match(factory, /probeProcessHostSemantics\(/);
  assert.match(factory, /activeJobCreateClose:\s*async\s*\(\)\s*=>\s*await managedProcesses\.probeActiveJobCreateClose\(\)/);
  assert.match(factory, /selectWindowsProcessBackendKinds\(windowsFacts\)/);
  assert.match(factory, /windowsBackendKinds\.has\(["']job["']\)/);
  assert.match(factory, /windowsBackendKinds\.has\(["']portable["']\)/);
  assert.match(factory, /semanticFacts:\s*windowsFacts/);
  const portable = factory.indexOf('stableAdapterId: "runner-windows-portable-adapter-v1"');
  const gatedJob = factory.indexOf('windowsBackendKinds.has("job")');
  assert.ok(portable > gatedJob, "portable registration must remain outside the optional Job fact gate");
});

test("Windows semantic probes exclude unrelated ambient credentials from the encoded target environment", () => {
  const environment = minimalWindowsSemanticProbeEnvironment({
    SystemRoot: "C:\\Windows",
    ComSpec: "C:\\Windows\\System32\\cmd.exe",
    Path: "C:\\Windows\\System32",
    PATHEXT: ".COM;.EXE;.BAT;.CMD",
    TEMP: "C:\\Temp",
    TMP: "C:\\Temp",
    RUNNER_FAKE_INHERITED_SECRET: "must-never-enter-supervisor-argv",
  }, {
    NODE_EXE: "C:\\node.exe",
    PROBE_SCRIPT: "C:\\probe.mjs",
  });

  assert.deepEqual(environment, {
    SystemRoot: "C:\\Windows",
    ComSpec: "C:\\Windows\\System32\\cmd.exe",
    Path: "C:\\Windows\\System32",
    PATHEXT: ".COM;.EXE;.BAT;.CMD",
    TEMP: "C:\\Temp",
    TMP: "C:\\Temp",
    NODE_EXE: "C:\\node.exe",
    PROBE_SCRIPT: "C:\\probe.mjs",
  });
  assert.doesNotMatch(JSON.stringify(environment), /RUNNER_FAKE_INHERITED_SECRET|must-never-enter-supervisor-argv/);
  const implementation = readFileSync(new URL("../src/windows-process-semantic-probes.ts", import.meta.url), "utf8");
  assert.doesNotMatch(implementation, /environment:\s*\{\s*\.\.\.process\.env/);
});

test("live Windows portable probes actively attest duplex, argv boundaries, and birth-tagged tree behavior", { timeout: 60_000 }, async (t) => {
  if (process.platform !== "win32") { t.skip("Windows semantic fixtures require Windows."); return; }
  const active = createWindowsProcessSemanticProbeSource();
  const portableDuplex = await active.portableDuplex();
  const windowsBatchArgv = await active.windowsBatchArgv();
  const exactTreeBirth = await active.exactTreeBirth();
  const facts = await probeProcessHostSemantics({
    portableDuplex: async () => portableDuplex,
    windowsBatchArgv: async () => windowsBatchArgv,
    exactTreeBirth: async () => exactTreeBirth,
    activeJobCreateClose: async () => false,
  });
  assert.equal(facts.portableDuplex, "verified");
  assert.equal(facts.windowsBatchArgv, "verified");
  assert.equal(facts.exactTreeBirth, "partial");
  assert.equal(facts.jobContainment, "unavailable");
});

test("semantic probe polling stops permanently on timeout or cancellation", async () => {
  let polls = 0;
  await assert.rejects(
    waitForWindowsSemanticProbe(() => { polls += 1; return false; }, { deadlineMs: 30 }),
    /timed out/i,
  );
  const settledPolls = polls;
  await new Promise((resolve) => setTimeout(resolve, 75));
  assert.equal(polls, settledPolls, "a timed-out probe must not schedule late polling effects");

  const controller = new AbortController();
  const cancelled = waitForWindowsSemanticProbe(() => false, { deadlineMs: 1_000, signal: controller.signal });
  controller.abort(new Error("probe cancelled"));
  await assert.rejects(cancelled, /probe cancelled/);
});

test("a timed-out live duplex probe tears down its channel, process, and owned root before rejection", { timeout: 30_000 }, async (t) => {
  if (process.platform !== "win32") { t.skip("Windows semantic timeout fixture requires Windows."); return; }
  const before = new Set(readdirSync(tmpdir()).filter((name) => name.startsWith("aiboard-windows-semantic-duplex-")));
  const active = createWindowsProcessSemanticProbeSource({ deadlineMs: 0 });
  await assert.rejects(active.portableDuplex(), /timed out/i);
  await new Promise((resolve) => setTimeout(resolve, 100));
  const after = new Set(readdirSync(tmpdir()).filter((name) => name.startsWith("aiboard-windows-semantic-duplex-")));
  assert.deepEqual(after, before, "timeout must not leave a late-created or retained probe root");
});

test("failed semantic-probe release removes evidence only after exact owner identities are absent", (t) => {
  if (process.platform !== "win32") { t.skip("Windows semantic cleanup audit requires Windows."); return; }
  const root = mkdtempSync(join(tmpdir(), "aiboard-windows-semantic-cleanup-"));
  const outsideRoot = mkdtempSync(join(tmpdir(), "aiboard-windows-semantic-cleanup-outside-"));
  const malformedRoot = mkdtempSync(join(tmpdir(), "aiboard-windows-semantic-cleanup-malformed-"));
  const nestedContainer = mkdtempSync(join(tmpdir(), "aiboard-windows-semantic-cleanup-container-"));
  const nestedRoot = join(nestedContainer, "aiboard-windows-semantic-cleanup-nested");
  const directory = join(root, "state", "owned-fixture");
  const outsideDirectory = join(outsideRoot, "state", "owned-fixture");
  const malformedDirectory = join(malformedRoot, "state", "owned-fixture");
  const nestedDirectory = join(nestedRoot, "state", "owned-fixture");
  mkdirSync(directory, { recursive: true });
  mkdirSync(outsideDirectory, { recursive: true });
  mkdirSync(malformedDirectory, { recursive: true });
  mkdirSync(nestedDirectory, { recursive: true });
  const pid = 2_147_483_646;
  const nonce = "semantic-cleanup-nonce";
  writeFileSync(join(directory, "state.json"), JSON.stringify({
    nonce, supervisorPid: pid, launchEffect: "not_started", rootProcess: null, knownProcesses: [],
  }));
  writeFileSync(join(outsideDirectory, "state.json"), JSON.stringify({
    nonce, supervisorPid: pid, launchEffect: "not_started", rootProcess: null, knownProcesses: [],
  }));
  writeFileSync(join(malformedDirectory, "state.json"), JSON.stringify({
    nonce, supervisorPid: pid, launchEffect: "started", rootProcess: null, knownProcesses: [],
  }));
  writeFileSync(join(nestedDirectory, "state.json"), JSON.stringify({
    nonce, supervisorPid: pid, launchEffect: "not_started", rootProcess: null, knownProcesses: [],
  }));
  const binding = (ownedDirectory: string): ProcessBackendBinding => ({
    registryId: "semantic-cleanup-fixture",
    backendId: "runner-windows-supervisor-v1",
    implementationGeneration: "test",
    implementationDigest: "1".repeat(64),
    attestationVersion: 1,
    attestationDigest: "2".repeat(64),
    opaqueIdentity: Buffer.from(JSON.stringify({ directory: ownedDirectory, nonce, supervisorPid: pid, supervisorBirth: "2000-01-01T00:00:00.000000Z" })).toString("base64url"),
    birthFingerprint: { observedAt: new Date(0).toISOString(), discriminator: "3".repeat(64) },
    rootPid: pid,
    startedAt: new Date(0).toISOString(),
  });
  try {
    assert.equal(removeInactiveSemanticProbeRoot(root, binding(outsideDirectory)), false, "an identity outside the exact generated root must preserve evidence");
    assert.equal(existsSync(root), true);
    assert.equal(removeInactiveSemanticProbeRoot(malformedRoot, binding(malformedDirectory)), false, "missing started-root proof must preserve evidence");
    assert.equal(existsSync(malformedRoot), true);
    assert.equal(removeInactiveSemanticProbeRoot(nestedRoot, binding(nestedDirectory)), false, "cleanup target must be an immediate generated Temp child");
    assert.equal(existsSync(nestedRoot), true);
    assert.equal(removeInactiveSemanticProbeRoot(root, binding(directory)), true);
    assert.equal(existsSync(root), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outsideRoot, { recursive: true, force: true });
    rmSync(malformedRoot, { recursive: true, force: true });
    rmSync(nestedContainer, { recursive: true, force: true });
  }
});

test("unbound semantic-probe cleanup preserves any owned launch evidence", () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-windows-semantic-unbound-"));
  mkdirSync(join(root, "state", "owned-blocked-launch"), { recursive: true });
  try {
    assert.equal(removeUnboundSemanticProbeRoot(root), false);
    assert.equal(existsSync(root), true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("semantic probe release retries a transient stable-emptiness refusal within its existing deadline", async () => {
  let releases = 0;
  const backend = {
    verifyEmpty: async () => ({ empty: true, proofArtifactId: "fixture-empty" }),
    release: async () => {
      releases += 1;
      if (releases === 1) throw new Error("Cannot release ownership without stable verified emptiness.");
      return { released: true };
    },
  } as unknown as WindowsProcessBackend;
  const binding: ProcessBackendBinding = {
    registryId: "semantic-release-fixture", backendId: "runner-windows-supervisor-v1",
    implementationGeneration: "test", implementationDigest: "1".repeat(64),
    attestationVersion: 1, attestationDigest: "2".repeat(64), opaqueIdentity: "fixture",
    birthFingerprint: { observedAt: new Date(0).toISOString(), discriminator: "3".repeat(64) },
    startedAt: new Date(0).toISOString(),
  };
  await requireEmptyAndRelease(backend, binding, 250);
  assert.equal(releases, 2);
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
