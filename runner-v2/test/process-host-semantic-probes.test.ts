import assert from "node:assert/strict";
import { ownFiniteFixtureChild } from "./support/finite-fixture-child.js";
import { finalizeCertifiedFixture } from "./support/certified-fixture-cleanup.js";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  probeProcessHostSemantics,
  selectWindowsProcessBackendKinds,
  type ProcessHostSemanticProbeSource,
} from "../src/process-host-semantic-probes.js";
import { createWindowsJobProcessHost } from "../src/windows-job-process-host.js";
import { snapshotNativeBuildAmbientEnvironment } from "../src/native-build-factory.js";
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
  throw new Error(`Process ${pid} did not become absent within the fixture deadline.`);
}

function windowsBirth(pid: number): string {
  return execFileSync("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command",
    `$ErrorActionPreference='Stop';(Get-Process -Id ${pid}).StartTime.ToUniversalTime().ToString('o')`,
  ], { encoding: "utf8", windowsHide: true, timeout: 2_000 }).trim();
}

function currentWindowsBirth(pid: number): string | undefined {
  const output = execFileSync("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command",
    `$ErrorActionPreference='Stop';$p=Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}';if($null -ne $p){$p.CreationDate.ToUniversalTime().ToString('o')}`,
  ], { encoding: "utf8", windowsHide: true, timeout: 2_000 }).trim();
  return output || undefined;
}

function sameTestBirth(left: string, right: string): boolean {
  const normalize = (value: string) => value.replace(/(\.\d{6})\d+(Z)$/, "$1$2");
  return normalize(left) === normalize(right);
}

function createInactiveSemanticCleanupFixture(suffix: string): {
  readonly root: string;
  readonly binding: ProcessBackendBinding;
  readonly rootCreatedAt: number;
} {
  const root = mkdtempSync(join(tmpdir(), `aiboard-windows-semantic-${suffix}-`));
  const directory = join(root, "state", "owned-fixture");
  mkdirSync(directory, { recursive: true });
  const nonce = `semantic-${suffix}`;
  const supervisorPid = 2_147_483_646;
  writeFileSync(join(directory, "state.json"), JSON.stringify({
    protocol: "aiboard-portable-process/v1", nonce, supervisorPid,
    launchEffect: "not_started", status: "outcome_unknown", rootProcess: null,
    knownProcesses: [], updatedAt: new Date().toISOString(),
  }));
  return {
    root,
    rootCreatedAt: statSync(root).birthtimeMs,
    binding: {
      registryId: `semantic-${suffix}`, backendId: "runner-windows-supervisor-v1",
      implementationGeneration: "test", implementationDigest: "1".repeat(64),
      attestationVersion: 1, attestationDigest: "2".repeat(64),
      opaqueIdentity: Buffer.from(JSON.stringify({
        directory, nonce, supervisorPid, supervisorBirth: "2000-01-01T00:00:00.000000Z",
      })).toString("base64url"),
      birthFingerprint: { observedAt: new Date(0).toISOString(), discriminator: "3".repeat(64) },
      rootPid: supervisorPid, startedAt: new Date(0).toISOString(),
    },
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
  assert.match(factory, /activeJobCreateClose:\s*async\s*\(\)\s*=>\s*await windowsJobHost\.probeActiveJobCreateClose\(\)/);
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
  const active = createWindowsProcessSemanticProbeSource({ ambientEnvironment: snapshotNativeBuildAmbientEnvironment() });
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
  const startedAt = Date.now();
  const ambientEnvironment = snapshotNativeBuildAmbientEnvironment();
  const bounded = createWindowsProcessSemanticProbeSource({ ambientEnvironment, deadlineMs: 50, cleanupDeadlineMs: 15_000 });
  await assert.rejects(bounded.portableDuplex(), /timed out/i);
  assert.ok(Date.now() - startedAt < 1_000, "the positive operation deadline must bound prewarming and startup");
  const active = createWindowsProcessSemanticProbeSource({ ambientEnvironment, deadlineMs: 0 });
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
  const controllerBirth = windowsBirth(process.pid);
  const closedInventory = () => [{
    pid: process.pid, birth: controllerBirth, parentPid: 0,
    executableAccessible: true, commandLineAccessible: true,
    executable: process.execPath, commandLine: "unrelated test controller",
  }];
  try {
    assert.equal(removeInactiveSemanticProbeRoot(root, binding(outsideDirectory)), false, "an identity outside the exact generated root must preserve evidence");
    assert.equal(existsSync(root), true);
    assert.equal(removeInactiveSemanticProbeRoot(malformedRoot, binding(malformedDirectory)), false, "missing started-root proof must preserve evidence");
    assert.equal(existsSync(malformedRoot), true);
    assert.equal(removeInactiveSemanticProbeRoot(nestedRoot, binding(nestedDirectory)), false, "cleanup target must be an immediate generated Temp child");
    assert.equal(existsSync(nestedRoot), true);
    assert.equal(removeInactiveSemanticProbeRoot(root, binding(directory), { globalInventory: closedInventory }), true);
    assert.equal(existsSync(root), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outsideRoot, { recursive: true, force: true });
    rmSync(malformedRoot, { recursive: true, force: true });
    rmSync(nestedContainer, { recursive: true, force: true });
  }
});

test("semantic cleanup ignores a recorded descendant whose birth predates the exact root", () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-windows-semantic-temporal-mismatch-"));
  const directory = join(root, "state", "owned-fixture");
  mkdirSync(directory, { recursive: true });
  const nonce = "semantic-temporal-mismatch";
  const supervisorPid = 2_147_483_646;
  const rootProcess = { pid: 2_147_483_645, birth: "2026-08-31T07:36:23.000000Z" };
  const impossible = { pid: 4321, birth: "2026-08-27T13:26:36.000000Z" };
  writeFileSync(join(directory, "state.json"), JSON.stringify({
    nonce, supervisorPid, launchEffect: "started", rootProcess,
    knownProcesses: [rootProcess, impossible],
  }));
  const binding: ProcessBackendBinding = {
    registryId: "semantic-temporal-mismatch", backendId: "runner-windows-supervisor-v1",
    implementationGeneration: "test", implementationDigest: "1".repeat(64),
    attestationVersion: 1, attestationDigest: "2".repeat(64),
    opaqueIdentity: Buffer.from(JSON.stringify({
      directory, nonce, supervisorPid, supervisorBirth: "2026-08-31T07:36:22.000000Z",
    })).toString("base64url"),
    birthFingerprint: { observedAt: new Date().toISOString(), discriminator: "3".repeat(64) },
    rootPid: rootProcess.pid, startedAt: new Date().toISOString(),
  };
  try {
    assert.equal(removeInactiveSemanticProbeRoot(root, binding, {
      globalInventory: () => [{
        pid: impossible.pid, birth: impossible.birth, parentPid: 1,
        executableAccessible: true, commandLineAccessible: true,
        executable: "C:\\unrelated.exe", commandLine: "unrelated",
      }],
    }), true, "a process born before the exact root cannot be its descendant");
    assert.equal(existsSync(root), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("semantic cleanup preserves evidence when global inventory is unavailable or malformed", () => {
  for (const [label, globalInventory] of [
    ["timeout", () => { throw new Error("inventory timeout"); }],
    ["truncated", () => []],
    ["malformed", () => [{
      pid: 1, birth: "", parentPid: 0, executableAccessible: true,
      commandLineAccessible: true, executable: "node", commandLine: "",
    }]],
  ] as const) {
    const root = mkdtempSync(join(tmpdir(), `aiboard-windows-semantic-${label}-`));
    const directory = join(root, "state", "owned-fixture");
    mkdirSync(directory, { recursive: true });
    const nonce = `semantic-${label}`;
    const pid = 2_147_483_646;
    writeFileSync(join(directory, "state.json"), JSON.stringify({
      nonce, supervisorPid: pid, launchEffect: "not_started", rootProcess: null, knownProcesses: [],
    }));
    const binding: ProcessBackendBinding = {
      registryId: "semantic-cleanup-inventory-fault", backendId: "runner-windows-supervisor-v1",
      implementationGeneration: "test", implementationDigest: "1".repeat(64),
      attestationVersion: 1, attestationDigest: "2".repeat(64),
      opaqueIdentity: Buffer.from(JSON.stringify({ directory, nonce, supervisorPid: pid, supervisorBirth: "2000-01-01T00:00:00.000000Z" })).toString("base64url"),
      birthFingerprint: { observedAt: new Date(0).toISOString(), discriminator: "3".repeat(64) },
      rootPid: pid, startedAt: new Date(0).toISOString(),
    };
    try {
      assert.equal(removeInactiveSemanticProbeRoot(root, binding, { globalInventory }), false);
      assert.equal(existsSync(root), true);
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
});

test("semantic cleanup resolves only inaccessible processes born strictly before the exact root", () => {
  const old = createInactiveSemanticCleanupFixture("inaccessible-old");
  try {
    assert.equal(removeInactiveSemanticProbeRoot(old.root, old.binding, {
      globalInventory: () => [{
        pid: 41, birth: new Date(old.rootCreatedAt - 60_000).toISOString(), parentPid: 4,
        executableAccessible: false, commandLineAccessible: false, executable: "", commandLine: "",
      }],
    }), true, "an immutable command line born before the unpredictable root is independently excluded");
    assert.equal(existsSync(old.root), false);
  } finally { rmSync(old.root, { recursive: true, force: true }); }

  for (const [label, birth] of [
    ["equal", 0],
    ["newer", 60_000],
  ] as const) {
    const fixture = createInactiveSemanticCleanupFixture(`inaccessible-${label}`);
    try {
      assert.equal(removeInactiveSemanticProbeRoot(fixture.root, fixture.binding, {
        globalInventory: () => [{
          pid: 42, birth: new Date(fixture.rootCreatedAt + birth).toISOString(), parentPid: 4,
          executableAccessible: false, commandLineAccessible: false, executable: "", commandLine: "",
        }],
      }), false, `${label} inaccessible metadata must preserve the complete root`);
      assert.equal(existsSync(fixture.root), true);
    } finally { rmSync(fixture.root, { recursive: true, force: true }); }
  }
});

test("semantic cleanup stops an exact supervisor while inaccessible global evidence preserves the root", () => {
  const fixture = createInactiveSemanticCleanupFixture("inaccessible-owned-stop");
  const supervisorPid = fixture.binding.rootPid!;
  const supervisorBirth = "2000-01-01T00:00:00.000000Z";
  let supervisorLive = true;
  let signalledPid: number | undefined;
  try {
    assert.equal(removeInactiveSemanticProbeRoot(fixture.root, fixture.binding, {
      globalInventory: () => [
        ...(supervisorLive ? [{
          pid: supervisorPid, birth: supervisorBirth, parentPid: 0,
          executableAccessible: true, commandLineAccessible: true,
          executable: process.execPath, commandLine: `${process.execPath} ${fixture.root}`,
        }] : []),
        {
          pid: 42, birth: new Date(fixture.rootCreatedAt + 60_000).toISOString(), parentPid: 4,
          executableAccessible: false, commandLineAccessible: false, executable: "", commandLine: "",
        },
      ],
      processInventory: () => supervisorLive
        ? [{ pid: supervisorPid, birth: supervisorBirth, commandLine: `${process.execPath} ${fixture.root}` }]
        : [],
      taskkill: (pid) => { signalledPid = pid; supervisorLive = false; },
    }), false, "uncertain global evidence must preserve the complete root");
    assert.equal(signalledPid, supervisorPid, "only the exact authenticated supervisor may be stopped");
    assert.equal(supervisorLive, false);
    assert.equal(existsSync(fixture.root), true);
  } finally { rmSync(fixture.root, { recursive: true, force: true }); }
});

test("semantic cleanup stops an exact authenticated supervisor when descendant evidence is corrupt", () => {
  const fixture = createInactiveSemanticCleanupFixture("corrupt-descendant-stop");
  const identity = JSON.parse(Buffer.from(fixture.binding.opaqueIdentity, "base64url").toString("utf8")) as {
    directory: string; nonce: string; supervisorPid: number; supervisorBirth: string;
  };
  const effectFence = { ownerId: "windows-semantic-probe", fencingToken: 1 };
  const authenticatedIdentity = { ...identity, version: 1, backendId: "runner-windows-supervisor-v1", fence: effectFence };
  const binding = {
    ...fixture.binding,
    opaqueIdentity: Buffer.from(JSON.stringify(authenticatedIdentity)).toString("base64url"),
    birthFingerprint: {
      ...fixture.binding.birthFingerprint,
      discriminator: createHash("sha256").update(`${identity.nonce}\0${identity.supervisorBirth}`).digest("hex"),
    },
  };
  writeFileSync(join(identity.directory, "lock-holder.json"), JSON.stringify({
    nonce: identity.nonce, holderPid: identity.supervisorPid, holderBirth: identity.supervisorBirth,
  }));
  writeFileSync(join(identity.directory, "fence.json"), JSON.stringify({ nonce: identity.nonce, ...effectFence }));
  writeFileSync(join(identity.directory, "state.json"), JSON.stringify({
    protocol: "aiboard-portable-process/v1", nonce: identity.nonce, supervisorPid: identity.supervisorPid,
    launchEffect: "started", status: "outcome_unknown",
    rootProcess: { pid: 99, birth: "2001-01-01T00:00:00.000000Z" },
    knownProcesses: [{ pid: 99, birth: "2002-01-01T00:00:00.000000Z" }],
  }));
  let supervisorLive = true;
  let signalledPid: number | undefined;
  try {
    assert.equal(removeInactiveSemanticProbeRoot(fixture.root, binding, {
      processInventory: () => supervisorLive
        ? [{ pid: identity.supervisorPid, birth: identity.supervisorBirth, commandLine: `${process.execPath} ${fixture.root}` }]
        : [],
      taskkill: (pid) => { signalledPid = pid; supervisorLive = false; },
    }), false, "corrupt descendant evidence must remain available for investigation");
    assert.equal(signalledPid, identity.supervisorPid);
    assert.equal(supervisorLive, false);
    assert.equal(existsSync(fixture.root), true);
  } finally { rmSync(fixture.root, { recursive: true, force: true }); }
});

test("semantic cleanup detects executable and embedded strict base64 root references", () => {
  const cases: Array<[string, (root: string) => { executable: string; commandLine: string }]> = [
    ["executable", (root) => ({ executable: join(root, "unlisted.exe"), commandLine: "unrelated" })],
    ["base64url-option", (root) => ({
      executable: "C:\\safe.exe",
      commandLine: `node --payload=${Buffer.from(JSON.stringify({ retainedRoot: root })).toString("base64url")}`,
    })],
    ["base64url-quoted", (root) => ({
      executable: "C:\\safe.exe",
      commandLine: `node --payload=\"${Buffer.from(JSON.stringify({ retainedRoot: root })).toString("base64url")}\"`,
    })],
    ["base64url-alphabet-prefix", (root) => ({
      executable: "C:\\safe.exe",
      commandLine: `node --payload=A${Buffer.from(root).toString("base64url")}`,
    })],
    ["base64url-alphabet-suffix", (root) => ({
      executable: "C:\\safe.exe",
      commandLine: `node --payload=${Buffer.from(JSON.stringify({ retainedRoot: root })).toString("base64url")}A`,
    })],
    ["base64url-alphabet-wrap", (root) => ({
      executable: "C:\\safe.exe",
      commandLine: `node --payload=ABCDE${Buffer.from(JSON.stringify({ retainedRoot: root })).toString("base64url")}XYZAB`,
    })],
    ["standard-base64", (root) => {
      let encoded = "";
      for (let value = 0; value < 256 && !/[+/]/.test(encoded); value += 1)
        encoded = Buffer.from(JSON.stringify({ retainedRoot: root, marker: String.fromCharCode(value) })).toString("base64");
      assert.match(encoded, /[+/]/, "fixture must exercise the standard-base64 alphabet");
      return { executable: "C:\\safe.exe", commandLine: `node --payload=${encoded}` };
    }],
    ["standard-base64-mixed-wrapper", (root) => {
      let encoded = "";
      for (let value = 0; value < 256 && !/[+/]/.test(encoded); value += 1)
        encoded = Buffer.from(JSON.stringify({ retainedRoot: root, marker: String.fromCharCode(value) })).toString("base64");
      assert.match(encoded, /[+/]/, "fixture must exercise the standard-base64 alphabet");
      return { executable: "C:\\safe.exe", commandLine: `node --payload=_${encoded}-` };
    }],
    ["base64url-mixed-wrapper", (root) => {
      let encoded = "";
      for (let value = 0; value < 256 && !/[-_]/.test(encoded); value += 1)
        encoded = Buffer.from(JSON.stringify({ retainedRoot: root, marker: String.fromCharCode(value) })).toString("base64url");
      assert.match(encoded, /[-_]/, "fixture must exercise the base64url alphabet");
      return { executable: "C:\\safe.exe", commandLine: `node --payload=+${encoded}/` };
    }],
  ];
  for (const [label, reference] of cases) {
    const fixture = createInactiveSemanticCleanupFixture(`embedded-${label}`);
    try {
      const processReference = reference(fixture.root);
      assert.equal(removeInactiveSemanticProbeRoot(fixture.root, fixture.binding, {
        globalInventory: () => [{
          pid: 43, birth: new Date(fixture.rootCreatedAt - 60_000).toISOString(), parentPid: 4,
          executableAccessible: true, commandLineAccessible: true, ...processReference,
        }],
      }), false, `${label} must preserve the complete root even when the process predates it`);
      assert.equal(existsSync(fixture.root), true);
    } finally { rmSync(fixture.root, { recursive: true, force: true }); }
  }
});

test("semantic cleanup fails closed when encoded-reference scanning exceeds its bound", () => {
  const fixture = createInactiveSemanticCleanupFixture("encoded-bound");
  try {
    assert.equal(removeInactiveSemanticProbeRoot(fixture.root, fixture.binding, {
      globalInventory: () => [{
        pid: 44, birth: new Date(fixture.rootCreatedAt - 60_000).toISOString(), parentPid: 4,
        executableAccessible: true, commandLineAccessible: true, executable: "C:\\safe.exe",
        commandLine: Array.from({ length: 257 }, () => "A".repeat(40)).join(" "),
      }],
    }), false);
    assert.equal(existsSync(fixture.root), true);
  } finally { rmSync(fixture.root, { recursive: true, force: true }); }
});

test("semantic cleanup spends one caller-configured absolute budget across every host effect", () => {
  const makeFixture = (suffix: string) => {
    const root = mkdtempSync(join(tmpdir(), `aiboard-windows-semantic-${suffix}-`));
    const directory = join(root, "state", "owned-fixture"); mkdirSync(directory, { recursive: true });
    const nonce = `budget-${suffix}`; const supervisorPid = 9001; const supervisorBirth = "2026-01-01T00:00:00.000000Z";
    writeFileSync(join(directory, "state.json"), JSON.stringify({
      protocol: "aiboard-portable-process/v1", nonce, supervisorPid,
      launchEffect: "not_started", status: "outcome_unknown", rootProcess: null, knownProcesses: [], updatedAt: new Date().toISOString(),
    }));
    const binding: ProcessBackendBinding = {
      registryId: "semantic-budget", backendId: "runner-windows-supervisor-v1", implementationGeneration: "test",
      implementationDigest: "1".repeat(64), attestationVersion: 1, attestationDigest: "2".repeat(64),
      opaqueIdentity: Buffer.from(JSON.stringify({ directory, nonce, supervisorPid, supervisorBirth })).toString("base64url"),
      birthFingerprint: { observedAt: new Date().toISOString(), discriminator: "3".repeat(64) }, rootPid: supervisorPid, startedAt: new Date().toISOString(),
    };
    return { root, binding, supervisorPid, supervisorBirth };
  };
  const unrelated = {
    pid: 1, birth: "2025-01-01T00:00:00.000000Z", parentPid: 0,
    executableAccessible: true, commandLineAccessible: true,
    executable: "C:\\Windows\\system32\\safe.exe", commandLine: "safe",
  };

  const success = makeFixture("budget-success"); let clock = 1_000; const observed: Array<[string, number]> = []; let globallyLive = true; let exactlyLive = true;
  try {
    assert.equal(removeInactiveSemanticProbeRoot(success.root, success.binding, {
      deadlineMs: 100, now: () => clock,
      globalInventory: (remaining) => { observed.push(["global", remaining]); clock += 10; return globallyLive
        ? [unrelated, {
          pid: success.supervisorPid, birth: success.supervisorBirth, parentPid: 0,
          executableAccessible: true, commandLineAccessible: true,
          executable: process.execPath, commandLine: `${process.execPath} ${success.root}`,
        }]
        : [unrelated]; },
      processInventory: (_pids, remaining) => { observed.push(["exact", remaining]); clock += 10; return exactlyLive
        ? [{ pid: success.supervisorPid, birth: success.supervisorBirth, commandLine: `${process.execPath} ${success.root}` }]
        : []; },
      taskkill: (_pid, remaining) => { observed.push(["taskkill", remaining]); clock += 10; exactlyLive = false; globallyLive = false; },
      wait: (milliseconds) => { clock += milliseconds; },
    }), true);
    assert.deepEqual(observed, [["global", 100], ["exact", 90], ["taskkill", 80], ["exact", 70], ["global", 60]]);
    assert.equal(existsSync(success.root), false);
  } finally { rmSync(success.root, { recursive: true, force: true }); }

  const exhausted = makeFixture("budget-exhausted"); clock = 2_000; let taskkillCalled = false;
  try {
    assert.equal(removeInactiveSemanticProbeRoot(exhausted.root, exhausted.binding, {
      deadlineMs: 30, now: () => clock,
      globalInventory: () => { clock += 20; return [unrelated, {
        pid: exhausted.supervisorPid, birth: exhausted.supervisorBirth, parentPid: 0,
        executableAccessible: true, commandLineAccessible: true,
        executable: process.execPath, commandLine: `${process.execPath} ${exhausted.root}`,
      }]; },
      processInventory: () => { clock += 20; return [{ pid: exhausted.supervisorPid, birth: exhausted.supervisorBirth, commandLine: `${process.execPath} ${exhausted.root}` }]; },
      taskkill: () => { taskkillCalled = true; },
    }), false);
    assert.equal(taskkillCalled, false, "an exhausted prior inventory may not start a later control effect");
    assert.equal(existsSync(exhausted.root), true);
  } finally { rmSync(exhausted.root, { recursive: true, force: true }); }
});

test("semantic cleanup stops only the exact authenticated supervisor when the recorded child PID was replaced", async (t) => {
  if (process.platform !== "win32") { t.skip("The exact supervisor/replacement cleanup fixture requires Windows."); return; }
  const root = mkdtempSync(join(tmpdir(), "aiboard-windows-semantic-duplex-"));
  const directory = join(root, "state", "owned-fixture");
  mkdirSync(directory, { recursive: true });
  const owners: Array<ReturnType<typeof ownFiniteFixtureChild>> = [];
  const own = (child: ReturnType<typeof ownFiniteFixtureChild>) => { owners.push(child); return child; };
  let hasPrimaryFailure = false; let primaryFailure: unknown;
  try {
  const supervisor = own(ownFiniteFixtureChild(spawn(process.execPath, ["-e", "setInterval(()=>{},1000)", root], { windowsHide: true, stdio: "ignore" })));
  assert.ok(supervisor.pid);
  const supervisorBirth = windowsBirth(supervisor.pid!);
  const replacementBirth = windowsBirth(process.pid);
  const recordedBirth = new Date(Date.parse(replacementBirth) - 60_000).toISOString();
  const nonce = "semantic-recycled-child-cleanup";
  const binding: ProcessBackendBinding = {
    registryId: "semantic-cleanup-recycled-child", backendId: "runner-windows-supervisor-v1",
    implementationGeneration: "test", implementationDigest: "1".repeat(64),
    attestationVersion: 1, attestationDigest: "2".repeat(64),
    opaqueIdentity: Buffer.from(JSON.stringify({ directory, nonce, supervisorPid: supervisor.pid, supervisorBirth })).toString("base64url"),
    birthFingerprint: { observedAt: new Date().toISOString(), discriminator: "3".repeat(64) },
    rootPid: supervisor.pid, startedAt: new Date().toISOString(),
  };
  writeFileSync(join(directory, "state.json"), JSON.stringify({
    protocol: "aiboard-portable-process/v1", nonce, supervisorPid: supervisor.pid,
    launchEffect: "started", status: "outcome_unknown",
    rootProcess: { pid: process.pid, birth: recordedBirth },
    knownProcesses: [{ pid: process.pid, birth: recordedBirth }],
    updatedAt: new Date().toISOString(),
  }));
  const globalInventory = () => {
    const inventory = [{
      pid: process.pid, birth: replacementBirth, parentPid: 0,
      executableAccessible: true, commandLineAccessible: true,
      executable: process.execPath, commandLine: "unrelated test controller",
    }];
    const currentSupervisorBirth = currentWindowsBirth(supervisor.pid!);
    if (currentSupervisorBirth && sameTestBirth(currentSupervisorBirth, supervisorBirth)) inventory.push({
      pid: supervisor.pid!, birth: currentSupervisorBirth, parentPid: process.pid,
      executableAccessible: true, commandLineAccessible: true,
      executable: process.execPath, commandLine: `${process.execPath} ${root}`,
    });
    return inventory;
  };
    assert.equal(removeInactiveSemanticProbeRoot(root, binding, { globalInventory }), true);
    await waitUntilProcessAbsent(supervisor.pid!, 10_000);
    assert.equal(existsSync(root), false);
    assert.doesNotThrow(() => process.kill(process.pid, 0), "the replacement process must never be signalled");
  } catch (error) { hasPrimaryFailure = true; primaryFailure = error; }
  finally {
    await finalizeCertifiedFixture({
      fixtureName: "semantic finite-child fixture", root, hasPrimaryFailure, primaryFailure,
      cleanup: async () => {
        const failures: unknown[] = [];
        for (const owner of owners) { try { await owner.close(); } catch (error) { failures.push(error); } }
        if (failures.length) throw new AggregateError(failures, "Finite semantic fixture cleanup failed.");
      },
      certify: async () => { assert.equal(owners.length, 1, "all exact child handles must have been acquired and joined"); },
      removeRoot: () => rmSync(root, { recursive: true, force: true, maxRetries: 30, retryDelay: 50 }),
    });
  }
});

test("semantic cleanup preserves an unlisted process that references the exact root until global closure", async (t) => {
  if (process.platform !== "win32") { t.skip("The global Windows reference fixture requires Windows."); return; }
  const root = mkdtempSync(join(tmpdir(), "aiboard-windows-semantic-global-reference-"));
  const directory = join(root, "state", "owned-fixture");
  mkdirSync(directory, { recursive: true });
  const owners: Array<ReturnType<typeof ownFiniteFixtureChild>> = [];
  const own = (child: ReturnType<typeof ownFiniteFixtureChild>) => { owners.push(child); return child; };
  let hasPrimaryFailure = false; let primaryFailure: unknown;
  try {
  const supervisor = own(ownFiniteFixtureChild(spawn(process.execPath, ["-e", "setInterval(()=>{},1000)", root], { windowsHide: true, stdio: "ignore" })));
  const encodedRoot = Buffer.from(JSON.stringify({ retainedRoot: root })).toString("base64url");
  const unlisted = own(ownFiniteFixtureChild(spawn(process.execPath, ["-e", "setInterval(()=>{},1000)", encodedRoot], { windowsHide: true, stdio: "ignore", detached: true })));
  assert.ok(supervisor.pid); assert.ok(unlisted.pid);
  const supervisorBirth = windowsBirth(supervisor.pid!);
  const unlistedBirth = windowsBirth(unlisted.pid!);
  const nonce = "semantic-global-reference-cleanup";
  const binding: ProcessBackendBinding = {
    registryId: "semantic-cleanup-global-reference", backendId: "runner-windows-supervisor-v1",
    implementationGeneration: "test", implementationDigest: "1".repeat(64),
    attestationVersion: 1, attestationDigest: "2".repeat(64),
    opaqueIdentity: Buffer.from(JSON.stringify({ directory, nonce, supervisorPid: supervisor.pid, supervisorBirth })).toString("base64url"),
    birthFingerprint: { observedAt: new Date().toISOString(), discriminator: "3".repeat(64) },
    rootPid: supervisor.pid, startedAt: new Date().toISOString(),
  };
  writeFileSync(join(directory, "state.json"), JSON.stringify({
    protocol: "aiboard-portable-process/v1", nonce, supervisorPid: supervisor.pid,
    launchEffect: "not_started", status: "outcome_unknown", rootProcess: null, knownProcesses: [],
    updatedAt: new Date().toISOString(),
  }));
  const controllerBirth = windowsBirth(process.pid);
  const globalInventory = () => {
    const inventory = [{
      pid: process.pid, birth: controllerBirth, parentPid: 0,
      executableAccessible: true, commandLineAccessible: true,
      executable: process.execPath, commandLine: "unrelated test controller",
    }];
    for (const [child, birth, commandLine] of [
      [supervisor, supervisorBirth, `${process.execPath} ${root}`],
      [unlisted, unlistedBirth, `${process.execPath} --payload=${encodedRoot}`],
    ] as const) {
      const current = currentWindowsBirth(child.pid!);
      if (current && sameTestBirth(current, birth)) inventory.push({
        pid: child.pid!, birth: current, parentPid: process.pid,
        executableAccessible: true, commandLineAccessible: true,
        executable: process.execPath, commandLine,
      });
    }
    return inventory;
  };
    assert.equal(removeInactiveSemanticProbeRoot(root, binding, { globalInventory }), false, "an unlisted exact-root reference must preserve the complete root");
    await waitUntilProcessAbsent(supervisor.pid!, 10_000);
    assert.equal(existsSync(root), true);
    assert.equal(sameTestBirth(currentWindowsBirth(unlisted.pid!) ?? "", unlistedBirth), true, "cleanup must not signal the unlisted process");
    await unlisted.close();
    await waitUntilProcessAbsent(unlisted.pid!, 10_000);
    assert.equal(removeInactiveSemanticProbeRoot(root, binding, { globalInventory }), true);
    assert.equal(existsSync(root), false);
  } catch (error) { hasPrimaryFailure = true; primaryFailure = error; }
  finally {
    await finalizeCertifiedFixture({
      fixtureName: "semantic finite-child fixture", root, hasPrimaryFailure, primaryFailure,
      cleanup: async () => {
        const failures: unknown[] = [];
        for (const owner of owners) { try { await owner.close(); } catch (error) { failures.push(error); } }
        if (failures.length) throw new AggregateError(failures, "Finite semantic fixture cleanup failed.");
      },
      certify: async () => { assert.equal(owners.length, 2, "all exact child handles must have been acquired and joined"); },
      removeRoot: () => rmSync(root, { recursive: true, force: true, maxRetries: 30, retryDelay: 50 }),
    });
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
  const executionHost = readFileSync(new URL("../src/execution-host.ts", import.meta.url), "utf8");

  assert.match(host, /class AuthenticatedWindowsJobProcessHost/);
  assert.match(host, /spawn\(/);
  assert.match(host, /private readonly records/);
  assert.doesNotMatch(host, /from\s+["'][^"']*managed-process(?:\.js)?["']|agent-contracts|AgentActor|ToolExecutionContext|role:\s*["']worker["']/);
  assert.doesNotMatch(managed, /implements WindowsJobProcessHost|internalOwnershipContext|launchOwnedMechanics|signalOwnedMechanics|reconcileOwnedMechanics|releaseOwnedMechanics|readOwnedOutputMechanics|createWindowsJobProcessHost\(/);
  assert.match(executionHost, /createWindowsJobProcessHost\(/);
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
