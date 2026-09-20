import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

import { createPosixProcessBackend } from "../src/posix-process-backend.js";
import {
  isExactPosixAnchorRelease,
  parsePosixBootstrapPrepared,
  parsePosixBootstrapGo,
  signalOwnedPosixGroup,
} from "../src/portable-process-posix-control.mjs";
import { createPortableProcessChannelProvider } from "../src/portable-process-channel.js";
import {
  resumePortableOutputRetirement,
  retirePortableOutputAcknowledgement,
  runPortableFenceEffectSync,
  settlePortableSupervisorCommand,
} from "../src/portable-process-protocol.mjs";
import {
  parseProcessEmptyVerification,
  parseProcessLaunchResult,
  parseProcessReconciliation,
  ProcessReleasePendingError,
  type ProcessBackend,
  type ProcessLaunchResult,
} from "../src/process-backend.js";
import type { NativeProcessOperations } from "../src/native-process-backend.js";
import { withOwnedFenceLock } from "../src/owned-fence-lock.mjs";
import { writeQualificationDiagnostics } from "./support/qualification-harness.js";

test("POSIX backend attests session ownership without claiming host-crash cleanup", async () => {
  const backend = createPosixProcessBackend();
  const probe = await backend.probe() as {
    backendId: string;
    platformLabel: string;
    capabilities: Record<string, string>;
  };
  assert.equal(probe.backendId, "runner-posix-process-group-v1");
  assert.equal(probe.platformLabel, "posix");
  assert.equal(probe.capabilities.tree_termination, "enforced");
  assert.equal(probe.capabilities.verified_emptiness, "enforced");
  assert.equal(probe.capabilities.crash_cleanup, "unavailable");
});

test("POSIX launch acceptance preserves a process that retires before the caller samples running", () => {
  const backend = createPosixProcessBackend();
  const accepts = (backend as unknown as { launchStateProvesAccepted(state: unknown): boolean }).launchStateProvesAccepted.bind(backend);
  const terminal = {
    protocol: "aiboard-portable-process/v2", nonce: "n", supervisorPid: 10, supervisorBirth: "birth",
    workloadGroup: { groupId: 11, leaderPid: 11, leaderBirth: "anchor" },
    workloadGroupRetirement: { state: "retired", cause: "anchor_release", at: "2026-09-18T00:00:00.000Z" },
    launchEffect: "started", rootProcess: null, revision: 3, handledControl: 0, status: "stopped",
    exitCode: 0, signal: null, knownProcesses: [], error: null, updatedAt: "2026-09-18T00:00:01.000Z",
  };
  assert.equal(accepts(terminal), true);
  assert.equal(accepts({ ...terminal, launchEffect: "unknown" }), false);
  assert.equal(accepts({ ...terminal, workloadGroupRetirement: { state: "active" } }), false);
  assert.equal(accepts({ ...terminal, status: "outcome_unknown" }), false);
});

test("generic POSIX birth discovery keeps its one-second absolute envelope", { timeout: 5_000 }, async () => {
  const waiter = new Int32Array(new SharedArrayBuffer(4));
  let attempts = 0;
  const operations: NativeProcessOperations = {
    inspectProcessBirth: (_pid, _platform, attemptDeadlineMs = 1_000) => {
      attempts += 1;
      Atomics.wait(waiter, 0, 0, Math.min(600, attemptDeadlineMs));
      return { state: "unknown" };
    },
    listPosixGroup: () => [],
    signal: () => undefined,
  };
  const backend = createPosixProcessBackend({ operations, pollIntervalMs: 10 });
  const internal = backend as unknown as {
    waitForBirth(pid: number, startupDeadline: number): Promise<unknown>;
  };
  const started = Date.now();
  await internal.waitForBirth(2_147_483_646, started + 4_000);
  const elapsed = Date.now() - started;
  assert.ok(elapsed >= 900 && elapsed < 1_750, `POSIX birth discovery exceeded its one-second envelope: ${elapsed}ms`);
  assert.ok(attempts >= 2 && attempts <= 3, `unexpected POSIX birth attempt count: ${attempts}`);
});

test("generic POSIX birth probes classify a failed ps after exact exit as absent", async () => {
  const source = readFileSync(new URL("../src/native-process-backend.ts", import.meta.url), "utf8");
  const syncContext = vm.createContext({
    PROCESS_BIRTH_INITIAL_INSPECTION_DEADLINE_MS: 2_000,
    WINDOWS_SUPERVISOR_BIRTH_INSPECTION_DEADLINE_MS: 15_000,
    process: { platform: "darwin" },
    execFileSync: () => { throw new Error("ps exited after target exit"); },
    pidAlive: () => false,
  });
  vm.runInContext(extractNamedTsFunction(source, "osProcessBirth"), syncContext);
  assert.deepEqual(
    JSON.parse(vm.runInContext("JSON.stringify(osProcessBirth(4242, 'posix'))", syncContext)),
    { state: "absent" },
  );

  const asyncContext = vm.createContext({
    PROCESS_BIRTH_INITIAL_INSPECTION_DEADLINE_MS: 2_000,
    process: { platform: "darwin" },
    pidAlive: () => false,
    parseBirthInspection: () => assert.fail("a failed ps must not be parsed as successful birth evidence"),
    execFile: (_command: unknown, _args: unknown, _options: unknown, callback: (error: Error, stdout: string) => void) => {
      queueMicrotask(() => callback(new Error("ps exited after target exit"), ""));
      return { once: (_event: string, handler: () => void) => { queueMicrotask(handler); } };
    },
    queueMicrotask,
  });
  vm.runInContext(extractNamedTsFunction(source, "osProcessBirthAsync"), asyncContext);
  assert.deepEqual(
    JSON.parse(await vm.runInContext("osProcessBirthAsync(4242, 'posix', { aborted: false }).then(JSON.stringify)", asyncContext)),
    { state: "absent" },
  );
});

test("generic POSIX birth probes treat empty ps for a still-live pid as retryable unknown", async () => {
  const source = readFileSync(new URL("../src/native-process-backend.ts", import.meta.url), "utf8");
  const syncContext = vm.createContext({
    PROCESS_BIRTH_INITIAL_INSPECTION_DEADLINE_MS: 2_000,
    WINDOWS_SUPERVISOR_BIRTH_INSPECTION_DEADLINE_MS: 15_000,
    process: { platform: "darwin" },
    execFileSync: () => "",
    pidAlive: () => true,
  });
  vm.runInContext(extractNamedTsFunction(source, "osProcessBirth"), syncContext);
  assert.deepEqual(JSON.parse(vm.runInContext("JSON.stringify(osProcessBirth(4242, 'posix'))", syncContext)), { state: "unknown" });

  const asyncContext = vm.createContext({
    PROCESS_BIRTH_INITIAL_INSPECTION_DEADLINE_MS: 2_000,
    process: { platform: "darwin" },
    pidAlive: () => true,
    parseBirthInspection: (value: string) => value ? { state: "present", fingerprint: value } : { state: "absent" },
    execFile: (_command: unknown, _args: unknown, _options: unknown, callback: (error: Error | null, stdout: string) => void) => {
      queueMicrotask(() => callback(null, ""));
      return { once: (_event: string, handler: () => void) => { queueMicrotask(handler); } };
    },
    queueMicrotask,
  });
  vm.runInContext(extractNamedTsFunction(source, "osProcessBirthAsync"), asyncContext);
  assert.deepEqual(JSON.parse(await vm.runInContext("osProcessBirthAsync(4242, 'posix', { aborted: false }).then(JSON.stringify)", asyncContext)), { state: "unknown" });
});


test("POSIX terminal observation retries transient unknown birth inspection without reporting terminal", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-posix-terminal-birth-retry-"));
  const directory = join(root, "owned-v2");
  const nonce = "terminal-birth-retry-nonce";
  const supervisorBirth = "supervisor-birth";
  const workloadGroup = { groupId: 9002, leaderPid: 9002, leaderBirth: "anchor-birth" } as const;
  for (const path of [directory, join(directory, "channel/output"), join(directory, "channel/input"), join(directory, "channel/ack")])
    mkdirSync(path, { recursive: true });
  writeFileSync(join(directory, "fence.json"), JSON.stringify({ nonce, ...fence }));
  writeFileSync(join(directory, "channel/output-checkpoint.json"), JSON.stringify({
    nonce, stdout: { sequence: 0, endOffset: 0 }, stderr: { sequence: 0, endOffset: 0 },
  }));
  writeFileSync(join(directory, "state.json"), JSON.stringify({
    protocol: "aiboard-portable-process/v2", nonce, supervisorPid: 9001, supervisorBirth, workloadGroup,
    workloadGroupRetirement: { state: "active" }, launchEffect: "started", rootProcess: null,
    handledControl: 0, status: "running", exitCode: null, signal: null, knownProcesses: [], error: null,
    revision: 1, updatedAt: "2026-09-19T00:00:00.000Z",
  }));
  let asyncInspections = 0;
  const backend = createPosixProcessBackend({
    stateDirectory: root, pollIntervalMs: 5,
    operations: {
      inspectProcessBirth: (pid) => pid === 9001
        ? { state: "present", fingerprint: supervisorBirth }
        : { state: "present", fingerprint: workloadGroup.leaderBirth },
      inspectProcessBirthAsync: async (pid) => {
        if (pid !== 9001) return { state: "present", fingerprint: workloadGroup.leaderBirth };
        asyncInspections += 1;
        return asyncInspections === 1
          ? { state: "unknown" }
          : { state: "present", fingerprint: supervisorBirth };
      },
      listPosixGroup: () => [workloadGroup.leaderPid],
      signal: () => undefined,
    },
  });
  const channel = await backend.backpressuredChannelProvider().acquire(
    portableV2Binding(directory, nonce, supervisorBirth, workloadGroup), fence,
  );
  let settled = false;
  const terminal = channel.waitForTerminal().then((value) => { settled = true; return value; });
  try {
    await new Promise((resolve) => setTimeout(resolve, 75));
    assert.ok(asyncInspections >= 2, "transient unknown birth evidence must be retried");
    assert.equal(settled, false, "transient birth uncertainty is not a terminal outcome");
  } finally {
    await channel.detach();
    await terminal.catch(() => undefined);
    removeFixtureRoot(root);
  }
});

test("POSIX terminal observation keeps persistent unknown birth inspection nonterminal until cancellation", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-posix-terminal-birth-unknown-"));
  const directory = join(root, "owned-v2");
  const nonce = "terminal-birth-unknown-nonce";
  const supervisorBirth = "supervisor-birth";
  const workloadGroup = { groupId: 9002, leaderPid: 9002, leaderBirth: "anchor-birth" } as const;
  for (const path of [directory, join(directory, "channel/output"), join(directory, "channel/input"), join(directory, "channel/ack")])
    mkdirSync(path, { recursive: true });
  writeFileSync(join(directory, "fence.json"), JSON.stringify({ nonce, ...fence }));
  writeFileSync(join(directory, "channel/output-checkpoint.json"), JSON.stringify({
    nonce, stdout: { sequence: 0, endOffset: 0 }, stderr: { sequence: 0, endOffset: 0 },
  }));
  writeFileSync(join(directory, "state.json"), JSON.stringify({
    protocol: "aiboard-portable-process/v2", nonce, supervisorPid: 9001, supervisorBirth, workloadGroup,
    workloadGroupRetirement: { state: "active" }, launchEffect: "started", rootProcess: null,
    handledControl: 0, status: "running", exitCode: null, signal: null, knownProcesses: [], error: null,
    revision: 1, updatedAt: "2026-09-19T00:00:00.000Z",
  }));
  let asyncInspections = 0;
  const backend = createPosixProcessBackend({
    stateDirectory: root, pollIntervalMs: 5,
    operations: {
      inspectProcessBirth: (pid) => pid === 9001
        ? { state: "present", fingerprint: supervisorBirth }
        : { state: "present", fingerprint: workloadGroup.leaderBirth },
      inspectProcessBirthAsync: async () => { asyncInspections += 1; return { state: "unknown" }; },
      listPosixGroup: () => [workloadGroup.leaderPid],
      signal: () => undefined,
    },
  });
  const channel = await backend.backpressuredChannelProvider().acquire(
    portableV2Binding(directory, nonce, supervisorBirth, workloadGroup), fence,
  );
  let settled = false;
  const terminal = channel.waitForTerminal().then((value) => { settled = true; return value; });
  try {
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.ok(asyncInspections > 2, "persistent birth uncertainty must keep being re-observed under the same durable authority");
    assert.equal(settled, false, "unverified passive birth evidence must not become a terminal process outcome");
  } finally {
    await channel.detach();
    await terminal.catch(() => undefined);
    removeFixtureRoot(root);
  }
});

test("POSIX channel re-attestation observes the durable fence without reclaiming the writer lock", async (t) => {
  if (process.platform === "win32") {
    t.skip("POSIX fence observation requires a POSIX host.");
    return;
  }
  const root = mkdtempSync(join(tmpdir(), "aiboard-posix-reattest-lock-"));
  const directory = join(root, "owned-v2");
  const nonce = "reattest-lock-nonce";
  const supervisorBirth = "supervisor-birth";
  const workloadGroup = { groupId: 9002, leaderPid: 9002, leaderBirth: "anchor-birth" } as const;
  for (const path of [directory, join(directory, "channel/output"), join(directory, "channel/input"), join(directory, "channel/ack")])
    mkdirSync(path, { recursive: true });
  writeFileSync(join(directory, "fence.json"), JSON.stringify({ nonce, ...fence }));
  writeFileSync(join(directory, "channel/output-checkpoint.json"), JSON.stringify({
    nonce, stdout: { sequence: 0, endOffset: 0 }, stderr: { sequence: 0, endOffset: 0 },
  }));
  writeFileSync(join(directory, "state.json"), JSON.stringify({
    protocol: "aiboard-portable-process/v2", nonce, supervisorPid: 9001, supervisorBirth, workloadGroup,
    workloadGroupRetirement: { state: "active" }, launchEffect: "started", rootProcess: null,
    handledControl: 0, status: "running", exitCode: null, signal: null, knownProcesses: [], error: null,
    revision: 1, updatedAt: "2026-09-19T00:00:00.000Z",
  }));
  const backend = createPosixProcessBackend({
    stateDirectory: root,
    operations: {
      inspectProcessBirth: (pid) => pid === 9001
        ? { state: "present", fingerprint: supervisorBirth }
        : { state: "present", fingerprint: workloadGroup.leaderBirth },
      listPosixGroup: () => [workloadGroup.leaderPid],
      signal: () => undefined,
    },
  });
  const channel = await backend.backpressuredChannelProvider().acquire(
    portableV2Binding(directory, nonce, supervisorBirth, workloadGroup), fence,
  );
  const authority = Reflect.get(channel, "authority") as { reattest(): "live" | "exited" };
  let entered!: () => void;
  let release!: () => void;
  const atLock = new Promise<void>((resolve) => { entered = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const heldLock = withOwnedFenceLock(join(directory, ".fence.lock"), async () => {
    entered();
    await gate;
  });
  try {
    await atLock;
    const started = Date.now();
    assert.equal(authority.reattest(), "live");
    assert.ok(Date.now() - started < 250,
      "read-side re-attestation must not contend on the writer lock after channel acquisition");
    const reconcileStarted = Date.now();
    assert.deepEqual(parseProcessReconciliation(await backend.reconcile(
      portableV2Binding(directory, nonce, supervisorBirth, workloadGroup), fence,
    )), { state: "running" });
    assert.ok(Date.now() - reconcileStarted < 250,
      "same-fence reconciliation must observe without reclaiming the writer lock");
  } finally {
    release();
    await heldLock;
    await channel.detach();
    removeFixtureRoot(root);
  }
});

test("POSIX native session fixture owns descendants after launcher exit", async (t) => {
  if (process.platform === "win32") {
    t.skip("POSIX session/process-group behavior requires a POSIX host.");
    return;
  }
  const root = mkdtempSync(join(tmpdir(), "aiboard-posix-c4-live-descendant-"));
  const backend = createPosixProcessBackend({ stateDirectory: root, pollIntervalMs: 20 });
  let binding: ReturnType<typeof bindingFor> | undefined;
  let authorityDirectory: string | undefined;
  let settleAndDetachChannel: (() => Promise<void>) | undefined;
  let primaryFailure: unknown;
  try {
    const launch = parseProcessLaunchResult(await backend.launch(request([
      "-e",
      "const{spawn}=require('node:child_process');const c=spawn(process.execPath,['-e',\"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)\"],{stdio:'ignore'});process.stdout.write(String(c.pid)+'\\n',()=>process.exit(0))",
    ])));
    const liveBinding = bindingFor(launch);
    binding = liveBinding;
    const supervisorPid = liveBinding.rootPid;
    if (typeof supervisorPid !== "number" || !Number.isSafeInteger(supervisorPid) || supervisorPid < 1)
      throw new Error("POSIX live fixture launch returned no exact supervisor witness PID.");
    const identity = JSON.parse(Buffer.from(launch.opaqueIdentity, "base64url").toString("utf8")) as { directory?: unknown };
    if (typeof identity.directory !== "string") throw new Error("POSIX live fixture launch returned no authenticated authority directory.");
    authorityDirectory = identity.directory;
    const channel = await backend.backpressuredChannelProvider().acquire(liveBinding, fence);
    const observedOutput: Buffer[] = [];
    let outputAcknowledgementReleased = false;
    let releaseOutputAcknowledgement!: () => void;
    const outputAcknowledgement = new Promise<void>((resolve) => { releaseOutputAcknowledgement = resolve; });
    const releaseOutput = () => {
      if (outputAcknowledgementReleased) return;
      outputAcknowledgementReleased = true;
      releaseOutputAcknowledgement();
    };
    const unsubscribe = channel.subscribeBackpressuredOutput(async (metadata, bytes) => {
      // A runtime diagnostic may appear on the inherited stderr pipe. Acknowledge
      // that unrelated diagnostic immediately so ordered delivery can reach the
      // workload stdout whose ACK this fixture
      // intentionally holds across the terminal-cleanup assertion.
      if (metadata.stream === "stderr") return metadata;
      observedOutput.push(Buffer.from(bytes));
      await outputAcknowledgement;
      return metadata;
    });
    settleAndDetachChannel = async () => {
      releaseOutput();
      const settlement = await channel.settleBackpressuredOutput?.(Date.now() + 5_000);
      if (settlement?.status !== "settled") throw new Error("POSIX live fixture output settlement did not reach the exact terminal proof.");
      unsubscribe();
      await channel.detach();
    };
    await waitForPosixLiveFixtureCondition(
      () => observedOutput.length > 0,
      Date.now() + 5_000,
      "POSIX live fixture did not receive the descendant output through the backpressured channel.",
    );
    const runningDeadline = Date.now() + 5_000;
    for (;;) {
      const reconciliation = parseProcessReconciliation(await backend.reconcile(liveBinding, fence));
      if (reconciliation.state === "running") break;
      if (reconciliation.state === "exited" || reconciliation.state === "identity_mismatch") {
        const state = readFileSync(join(authorityDirectory, "state.json"), "utf8");
        throw new Error(`POSIX live fixture reached definitive non-running state after launcher exit: ${JSON.stringify(reconciliation)}; supervisor=${state}`);
      }
      if (Date.now() >= runningDeadline) {
        const state = readFileSync(join(authorityDirectory, "state.json"), "utf8");
        throw new Error(`POSIX live fixture did not converge to running after launcher exit: ${JSON.stringify(reconciliation)}; supervisor=${state}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.deepEqual(await backend.signal(liveBinding, "terminate", fence), { state: "running" });
    await new Promise((resolve) => setTimeout(resolve, 100));
    if (!parseProcessEmptyVerification(await backend.verifyEmpty(liveBinding, fence)).empty)
      assert.deepEqual(await backend.signal(liveBinding, "force_terminate", fence), { state: "exited" });
    const retired = JSON.parse(readFileSync(join(authorityDirectory, "state.json"), "utf8")) as {
      workloadGroupRetirement?: { state?: unknown };
    };
    assert.equal(retired.workloadGroupRetirement?.state, "retired",
      "force must durably retire the workload before output acknowledgement is released");
    assert.equal(parseProcessEmptyVerification(await backend.verifyEmpty(liveBinding, fence)).empty, false,
      "unacknowledged output must keep terminal cleanup blocked while the retained supervisor witness is alive");
    assert.doesNotThrow(() => process.kill(supervisorPid, 0),
      "workload retirement and output terminal proof must not be confused with supervisor witness death");
    assert.match(Buffer.concat(observedOutput).toString("utf8"), /^\d+\r?\n$/, "the real descendant PID output must be observed before acknowledgement");
    releaseOutput();
    assert.equal((await channel.waitForTerminal() as { state: string }).state, "exited");
  } catch (error) {
    primaryFailure = error;
    throw error;
  } finally {
    if (binding && authorityDirectory) {
      try {
        await finalizePosixLiveFixture(backend, binding, fence, root, authorityDirectory, settleAndDetachChannel);
      } catch (cleanupError) {
        if (primaryFailure) throw new AggregateError([primaryFailure, cleanupError], "POSIX live fixture and exact cleanup both failed.");
        throw cleanupError;
      }
    } else if (primaryFailure) {
      throw new AggregateError([primaryFailure], `POSIX live fixture failed before authenticated cleanup identity; evidence retained at ${root}.`);
    } else {
      throw new Error(`POSIX live fixture completed without an authenticated cleanup identity; evidence retained at ${root}.`);
    }
  }
});

test("C4 POSIX force queues the exact workload group and retains the supervisor witness", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-posix-c4-force-"));
  const directory = join(root, "owned-v2");
  const nonce = "c4-force-nonce";
  const supervisorPid = 9001;
  const workloadGroup = { groupId: 9002, leaderPid: 9002, leaderBirth: "workload-anchor-birth" } as const;
  let supervisorAlive = true;
  let workloadAlive = true;
  let controlObserved = false;
  let retirementPublicationScheduled = false;
  const directSignals: Array<[number, NodeJS.Signals]> = [];
  mkdirSync(join(directory, "channel", "output"), { recursive: true });
  mkdirSync(join(directory, "channel", "input"), { recursive: true });
  mkdirSync(join(directory, "channel", "ack"), { recursive: true });
  writeFileSync(join(directory, "stdout.log"), "");
  writeFileSync(join(directory, "stderr.log"), "");
  writeFileSync(join(directory, "fence.json"), JSON.stringify({ nonce, ...fence }));
  writeFileSync(join(directory, "channel", "output-checkpoint.json"), JSON.stringify({
    nonce,
    stdout: { sequence: 0, endOffset: 0 },
    stderr: { sequence: 0, endOffset: 0 },
  }));
  const runningState = {
    protocol: "aiboard-portable-process/v2",
    nonce,
    supervisorPid,
    supervisorBirth: "supervisor-birth",
    workloadGroup,
    workloadGroupRetirement: { state: "active" },
    launchEffect: "started",
    rootProcess: null,
    revision: 1,
    handledControl: 0,
    status: "running",
    exitCode: null,
    signal: null,
    knownProcesses: [],
    error: null,
    updatedAt: "2026-09-06T00:00:00.000Z",
  } as const;
  writeFileSync(join(directory, "state.json"), JSON.stringify(runningState));
  const backend = createPosixProcessBackend({
    stateDirectory: root,
    pollIntervalMs: 1,
    operations: {
      inspectProcessBirth: (pid) => {
        if (pid === supervisorPid) return supervisorAlive
          ? { state: "present" as const, fingerprint: "supervisor-birth" }
          : { state: "absent" as const };
        if (pid === workloadGroup.leaderPid) return workloadAlive
          ? { state: "present" as const, fingerprint: workloadGroup.leaderBirth }
          : { state: "absent" as const };
        return { state: "absent" as const };
      },
      listPosixGroup: (groupId) => {
        if (groupId !== workloadGroup.groupId) return groupId === supervisorPid && supervisorAlive ? [supervisorPid] : [];
        if (existsSync(join(directory, "control.json"))) {
          controlObserved = true;
          workloadAlive = false;
          if (!retirementPublicationScheduled) {
            retirementPublicationScheduled = true;
            setTimeout(() => {
              const retired = {
                ...runningState,
                workloadGroupRetirement: { state: "retired", cause: "force_terminate", at: "2026-09-06T00:00:01.000Z" },
                revision: 2,
                status: "running",
              } as const;
              writeFileSync(join(directory, "state.json"), JSON.stringify(retired));
            }, 400);
          }
        }
        return workloadAlive ? [workloadGroup.leaderPid, 9003] : [];
      },
      signal: (pid, signal) => {
        directSignals.push([pid, signal]);
        if (pid === -supervisorPid) {
          supervisorAlive = false;
          workloadAlive = false;
        }
      },
    },
  });
  try {
    assert.deepEqual(
      await backend.signal(portableV2Binding(directory, nonce, "supervisor-birth", workloadGroup), "force_terminate", fence),
      { state: "exited" },
    );
    assert.equal(controlObserved, true, "the fenced control request must be observed before retirement");
    const retiredState = JSON.parse(readFileSync(join(directory, "state.json"), "utf8"));
    assert.equal(retiredState.workloadGroupRetirement.state, "retired", "force must await durable workload-group retirement");
    assert.equal(retiredState.status, "running", "force must not require supervisor/output finalization before workload quiescence is proven");
    assert.deepEqual(directSignals, [], "the backend must not directly signal the supervisor group");
    assert.equal(supervisorAlive, true, "force-stop must preserve the terminal supervisor witness");
  } finally {
    removeFixtureRoot(root);
  }
});

test("C4 POSIX v2 terminal observation preserves a live supervisor until authority release", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-posix-c4-terminal-witness-"));
  const directory = join(root, "owned-v2");
  const nonce = "c4-terminal-nonce";
  const workloadGroup = { groupId: 9002, leaderPid: 9002, leaderBirth: "anchor-birth" } as const;
  for (const path of ["channel/output", "channel/input", "channel/ack"]) mkdirSync(join(directory, path), { recursive: true });
  writeFileSync(join(directory, "stdout.log"), "");
  writeFileSync(join(directory, "stderr.log"), "");
  writeFileSync(join(directory, "fence.json"), JSON.stringify({ nonce, ...fence }));
  writeFileSync(join(directory, "channel", "output-checkpoint.json"), JSON.stringify({
    nonce,
    stdout: { sequence: 0, endOffset: 0 },
    stderr: { sequence: 0, endOffset: 0 },
  }));
  writeFileSync(join(directory, "state.json"), JSON.stringify({
    protocol: "aiboard-portable-process/v2",
    nonce,
    supervisorPid: 9001,
    supervisorBirth: "supervisor-birth",
    workloadGroup,
    workloadGroupRetirement: { state: "retired", cause: "anchor_release", at: "2026-09-06T00:00:01.000Z" },
    launchEffect: "started",
    rootProcess: null,
    revision: 2,
    handledControl: 0,
    status: "stopped",
    exitCode: 0,
    signal: null,
    knownProcesses: [],
    error: null,
    updatedAt: "2026-09-06T00:00:01.000Z",
  }));
  let reusedGroupListings = 0;
  const backend = createPosixProcessBackend({
    stateDirectory: root,
    operations: {
      inspectProcessBirth: (pid) => pid === 9001
        ? { state: "present", fingerprint: "supervisor-birth" }
        : { state: "absent" },
      listPosixGroup: () => {
        reusedGroupListings += 1;
        return [9177, 9178];
      },
      signal: () => assert.fail("terminal v2 observation must not directly signal a process group"),
    },
  });
  const binding = portableV2Binding(directory, nonce, "supervisor-birth", workloadGroup);
  try {
    assert.equal(parseProcessEmptyVerification(await backend.verifyEmpty(binding, fence)).empty, true);
    assert.deepEqual(parseProcessReconciliation(await backend.reconcile(binding, fence)), { state: "exited", exitCode: 0 },
      "durable workload retirement is terminal even while the supervisor witness remains alive for release");
    assert.deepEqual(await backend.signal(binding, "force_terminate", fence), { state: "exited" });
    assert.equal(existsSync(join(directory, "control.json")), false, "durable retirement must not re-control a numerically reused group");
    assert.equal(reusedGroupListings, 0, "durable retirement must not enumerate a numerically reused group");
    await assert.rejects(backend.release(binding, fence), /supervisor.*exit|witness/i);
    assert.equal(existsSync(directory), true, "release must retain authority while the terminal witness is alive");
  } finally {
    removeFixtureRoot(root);
  }
});

test("C4 POSIX v2 rejects durable state whose workload identity differs from opaque authority", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-posix-c4-v2-state-mismatch-"));
  const directory = join(root, "owned-v2");
  const nonce = "c4-state-mismatch";
  const workloadGroup = { groupId: 9002, leaderPid: 9002, leaderBirth: "anchor-birth" } as const;
  const stateWorkloadGroup = { ...workloadGroup, leaderBirth: "reused-anchor-birth" } as const;
  const directSignals: Array<[number, NodeJS.Signals]> = [];
  const listedGroups: number[] = [];
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "fence.json"), JSON.stringify({ nonce, ...fence }));
  writeFileSync(join(directory, "state.json"), JSON.stringify({
    protocol: "aiboard-portable-process/v2",
    nonce,
    supervisorPid: 9001,
    supervisorBirth: "supervisor-birth",
    workloadGroup: stateWorkloadGroup,
    workloadGroupRetirement: { state: "active" },
    launchEffect: "started",
    rootProcess: null,
    revision: 1,
    handledControl: 0,
    status: "running",
    exitCode: null,
    signal: null,
    knownProcesses: [],
    error: null,
    updatedAt: "2026-09-06T00:00:00.000Z",
  }));
  const backend = createPosixProcessBackend({
    stateDirectory: root,
    pollIntervalMs: 1,
    operations: {
      inspectProcessBirth: (pid) => pid === 9001
        ? { state: "present", fingerprint: "supervisor-birth" }
        : pid === workloadGroup.leaderPid
          ? { state: "present", fingerprint: workloadGroup.leaderBirth }
          : { state: "absent" },
      listPosixGroup: (groupId) => { listedGroups.push(groupId); return [workloadGroup.leaderPid]; },
      signal: (pid, signal) => { directSignals.push([pid, signal]); },
    },
  });
  const binding = portableV2Binding(directory, nonce, "supervisor-birth", workloadGroup);
  try {
    assert.deepEqual(await backend.reconcile(binding, fence), { state: "identity_mismatch" });
    await assert.rejects(backend.signal(binding, "force_terminate", fence), /identity mismatch/i);
    assert.equal(existsSync(join(directory, "control.json")), false, "a mismatched durable group must not receive a control record");
    assert.deepEqual(listedGroups, [], "a mismatched durable group must not be numerically enumerated");
    assert.deepEqual(directSignals, [], "a mismatched durable group must not receive a direct signal");
  } finally {
    removeFixtureRoot(root);
  }
});

test("C4 POSIX v2 blocks a supervisor crash before durable retirement despite an empty numeric group", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-posix-c4-pre-retirement-crash-"));
  const directory = join(root, "owned-v2");
  const nonce = "c4-pre-retirement-crash";
  const workloadGroup = { groupId: 9002, leaderPid: 9002, leaderBirth: "anchor-birth" } as const;
  const numericListings: number[] = [];
  const directSignals: Array<[number, NodeJS.Signals]> = [];
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "fence.json"), JSON.stringify({ nonce, ...fence }));
  writeFileSync(join(directory, "state.json"), JSON.stringify({
    protocol: "aiboard-portable-process/v2",
    nonce,
    supervisorPid: 9001,
    supervisorBirth: "supervisor-birth",
    workloadGroup,
    workloadGroupRetirement: { state: "active" },
    launchEffect: "started",
    rootProcess: null,
    revision: 1,
    handledControl: 0,
    status: "running",
    exitCode: null,
    signal: null,
    knownProcesses: [],
    error: null,
    updatedAt: "2026-09-06T00:00:00.000Z",
  }));
  const backend = createPosixProcessBackend({
    stateDirectory: root,
    operations: {
      inspectProcessBirth: () => ({ state: "absent" }),
      listPosixGroup: (groupId) => { numericListings.push(groupId); return []; },
      signal: (pid, signal) => { directSignals.push([pid, signal]); },
    },
  });
  const binding = portableV2Binding(directory, nonce, "supervisor-birth", workloadGroup);
  try {
    assert.deepEqual(await backend.reconcile(binding, fence), { state: "outcome_unknown" });
    await assert.rejects(backend.signal(binding, "force_terminate", fence), /membership|retirement|supervisor exited/i);
    assert.equal(existsSync(join(directory, "control.json")), false, "a pre-retirement crash must retain rather than recreate control authority");
    assert.deepEqual(numericListings, [], "a fresh empty numeric group cannot replace the missing anchor proof");
    assert.deepEqual(directSignals, [], "a pre-retirement crash must not revive numeric-only control");
  } finally {
    removeFixtureRoot(root);
  }
});

test("C4 POSIX v2 accepts post-retirement supervisor crash without adopting a reused numeric group", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-posix-c4-post-retirement-crash-"));
  const directory = join(root, "owned-v2");
  const nonce = "c4-post-retirement-crash";
  const workloadGroup = { groupId: 9002, leaderPid: 9002, leaderBirth: "anchor-birth" } as const;
  for (const path of ["channel/output", "channel/input", "channel/ack"]) mkdirSync(join(directory, path), { recursive: true });
  writeFileSync(join(directory, "stdout.log"), "");
  writeFileSync(join(directory, "stderr.log"), "");
  writeFileSync(join(directory, "fence.json"), JSON.stringify({ nonce, ...fence }));
  writeFileSync(join(directory, "channel", "output-checkpoint.json"), JSON.stringify({
    nonce,
    stdout: { sequence: 0, endOffset: 0 },
    stderr: { sequence: 0, endOffset: 0 },
  }));
  writeFileSync(join(directory, "state.json"), JSON.stringify({
    protocol: "aiboard-portable-process/v2",
    nonce,
    supervisorPid: 9001,
    supervisorBirth: "supervisor-birth",
    workloadGroup,
    workloadGroupRetirement: { state: "retired", cause: "force_terminate", at: "2026-09-06T00:00:01.000Z" },
    launchEffect: "started",
    rootProcess: null,
    revision: 2,
    handledControl: 0,
    status: "stopped",
    exitCode: 0,
    signal: null,
    knownProcesses: [],
    error: null,
    updatedAt: "2026-09-06T00:00:01.000Z",
  }));
  let reusedGroupListings = 0;
  const backend = createPosixProcessBackend({
    stateDirectory: root,
    operations: {
      inspectProcessBirth: () => ({ state: "absent" }),
      listPosixGroup: () => { reusedGroupListings += 1; return [9177, 9178]; },
      signal: () => assert.fail("post-retirement crash recovery must not signal a reused numeric group"),
    },
  });
  const binding = portableV2Binding(directory, nonce, "supervisor-birth", workloadGroup);
  try {
    assert.equal(parseProcessEmptyVerification(await backend.verifyEmpty(binding, fence)).empty, true);
    assert.deepEqual(await backend.reconcile(binding, fence), { state: "exited", exitCode: 0 });
    assert.deepEqual(await backend.release(binding, fence), { released: true });
    assert.equal(existsSync(directory), false, "only durable retirement plus the exited witness may retire authority");
    assert.equal(reusedGroupListings, 0, "post-retirement recovery must not adopt a numerically reused group");
  } finally {
    removeFixtureRoot(root);
  }
});

test("C4 POSIX v2 launch rollback queues workload control without signalling the supervisor group", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-posix-c4-v2-rollback-"));
  const directory = join(root, "owned-v2");
  const nonce = "c4-rollback-nonce";
  const workloadGroup = { groupId: 9002, leaderPid: 9002, leaderBirth: "anchor-birth" } as const;
  const running = {
    protocol: "aiboard-portable-process/v2",
    nonce,
    supervisorPid: 9001,
    supervisorBirth: "supervisor-birth",
    workloadGroup,
    workloadGroupRetirement: { state: "active" },
    launchEffect: "started",
    rootProcess: null,
    revision: 1,
    handledControl: 0,
    status: "running",
    exitCode: null,
    signal: null,
    knownProcesses: [],
    error: null,
    updatedAt: "2026-09-06T00:00:00.000Z",
  } as const;
  for (const path of ["channel/output", "channel/input", "channel/ack"]) mkdirSync(join(directory, path), { recursive: true });
  writeFileSync(join(directory, "stdout.log"), "");
  writeFileSync(join(directory, "stderr.log"), "");
  writeFileSync(join(directory, "channel", "output-checkpoint.json"), JSON.stringify({
    nonce,
    stdout: { sequence: 0, endOffset: 0 },
    stderr: { sequence: 0, endOffset: 0 },
  }));
  writeFileSync(join(directory, "fence.json"), JSON.stringify({ nonce, ...fence }));
  writeFileSync(join(directory, "state.json"), JSON.stringify(running));
  const directSignals: Array<[number, NodeJS.Signals]> = [];
  let controlObserved = false;
  let supervisorAlive = true;
  const backend = createPosixProcessBackend({
    stateDirectory: root,
    pollIntervalMs: 1,
    operations: {
      inspectProcessBirth: (pid) => pid === 9001
        ? supervisorAlive ? { state: "present", fingerprint: "supervisor-birth" } : { state: "absent" }
        : pid === 9002 ? { state: "present", fingerprint: "anchor-birth" } : { state: "absent" },
      listPosixGroup: (groupId) => {
        if (groupId === workloadGroup.groupId && existsSync(join(directory, "control.json"))) {
          controlObserved = true;
          supervisorAlive = false;
          writeFileSync(join(directory, "state.json"), JSON.stringify({
            ...running,
            workloadGroupRetirement: { state: "retired", cause: "force_terminate", at: "2026-09-06T00:00:01.000Z" },
            revision: 2,
            status: "stopped",
          }));
          return [workloadGroup.leaderPid];
        }
        return [workloadGroup.leaderPid];
      },
      signal: (pid, signal) => {
        directSignals.push([pid, signal]);
        supervisorAlive = false;
        writeFileSync(join(directory, "state.json"), JSON.stringify({
          ...running,
          workloadGroupRetirement: { state: "retired", cause: "force_terminate", at: "2026-09-06T00:00:01.000Z" },
          revision: 2,
          status: "stopped",
        }));
      },
    },
  });
  const rollback = backend as unknown as {
    cleanupFailedLaunch(identity: {
      version: 2;
      backendId: string;
      nonce: string;
      directory: string;
      supervisorPid: number;
      supervisorBirth: string;
      workloadGroup: typeof workloadGroup;
      fence: typeof fence;
    }): Promise<void>;
  };
  try {
    await rollback.cleanupFailedLaunch({
      version: 2,
      backendId: "runner-posix-process-group-v1",
      nonce,
      directory,
      supervisorPid: 9001,
      supervisorBirth: "supervisor-birth",
      workloadGroup,
      fence,
    });
    assert.equal(controlObserved, true, "rollback must wait for the fenced workload control to be observed");
    assert.deepEqual(directSignals, [], "rollback must never re-signal the supervisor's numeric group");
  } finally {
    removeFixtureRoot(root);
  }
});

test("C4 POSIX v2 launch rollback waits for durable retirement after exact force makes the anchor temporarily absent", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-posix-c4-v2-rollback-retirement-race-"));
  const directory = join(root, "owned-v2");
  const nonce = "c4-rollback-retirement-race-nonce";
  const workloadGroup = { groupId: 9002, leaderPid: 9002, leaderBirth: "anchor-birth" } as const;
  const running = {
    protocol: "aiboard-portable-process/v2", nonce, supervisorPid: 9001, supervisorBirth: "supervisor-birth",
    workloadGroup, workloadGroupRetirement: { state: "active" }, launchEffect: "started", rootProcess: null,
    revision: 1, handledControl: 0, status: "running", exitCode: null, signal: null, knownProcesses: [], error: null,
    updatedAt: "2026-09-19T00:00:00.000Z",
  } as const;
  for (const path of ["channel/output", "channel/input", "channel/ack"]) mkdirSync(join(directory, path), { recursive: true });
  writeFileSync(join(directory, "stdout.log"), "");
  writeFileSync(join(directory, "stderr.log"), "");
  writeFileSync(join(directory, "channel", "output-checkpoint.json"), JSON.stringify({
    nonce, stdout: { sequence: 0, endOffset: 0 }, stderr: { sequence: 0, endOffset: 0 },
  }));
  writeFileSync(join(directory, "fence.json"), JSON.stringify({ nonce, ...fence }));
  writeFileSync(join(directory, "state.json"), JSON.stringify(running));
  const controlPath = join(directory, "control.json");
  let supervisorAlive = true;
  let anchorInspectionsAfterControl = 0;
  const backend = createPosixProcessBackend({
    stateDirectory: root, pollIntervalMs: 1,
    operations: {
      inspectProcessBirth: (pid) => {
        if (pid === 9001) return supervisorAlive ? { state: "present", fingerprint: "supervisor-birth" } : { state: "absent" };
        if (pid !== 9002) return { state: "absent" };
        if (!existsSync(controlPath)) return { state: "present", fingerprint: "anchor-birth" };
        anchorInspectionsAfterControl += 1;
        if (anchorInspectionsAfterControl === 2) {
          supervisorAlive = false;
          writeFileSync(join(directory, "state.json"), JSON.stringify({
            ...running, workloadGroupRetirement: { state: "retired", cause: "force_terminate", at: "2026-09-19T00:00:01.000Z" },
            revision: 2, status: "stopped",
          }));
        }
        return { state: "absent" };
      },
      listPosixGroup: () => [],
      signal: () => { throw new Error("rollback must not directly signal outside the supervisor"); },
    },
  });
  const rollback = backend as unknown as { cleanupFailedLaunch(identity: { version: 2; backendId: string; nonce: string; directory: string; supervisorPid: number; supervisorBirth: string; workloadGroup: typeof workloadGroup; fence: typeof fence }): Promise<void> };
  try {
    await rollback.cleanupFailedLaunch({ version: 2, backendId: "runner-posix-process-group-v1", nonce, directory, supervisorPid: 9001, supervisorBirth: "supervisor-birth", workloadGroup, fence });
    assert.ok(existsSync(controlPath), "rollback must first queue the exact fenced force request");
    assert.ok(anchorInspectionsAfterControl >= 2, "rollback must tolerate the post-force gap until durable retirement is published");
  } finally {
    removeFixtureRoot(root);
  }
});

test("C4 POSIX parses a detached anchor's birth and group from synthetic proc state", async () => {
  const control = await import("../src/portable-process-posix-control.mjs");
  const fields = ["S", "1", "9002", ...Array.from({ length: 16 }, () => "0"), "712345", "0"];
  assert.deepEqual(
    control.parseLinuxProcStatIdentity(9002, `9002 (node (anchor)) ${fields.join(" ")}`),
    { pid: 9002, groupId: 9002, birth: "proc-start:712345" },
  );
  assert.equal(control.parseLinuxProcStatIdentity(9002, "malformed"), undefined);
});

test("C4 POSIX reattests the exact anchor birth and detached group before control", async () => {
  const control = await import("../src/portable-process-posix-control.mjs");
  const workloadGroup = { groupId: 9002, leaderPid: 9002, leaderBirth: "anchor-birth" } as const;
  const ready = control.reattestOwnedPosixAnchor(
    workloadGroup,
    () => ({ state: "present", value: { pid: 9002, groupId: 9002, birth: "anchor-birth" } }),
    () => [9002, 9003],
  );
  assert.deepEqual(ready, { state: "ready", members: [9002, 9003] });
  assert.deepEqual(
    control.reattestOwnedPosixAnchor(
      workloadGroup,
      () => ({ state: "present", value: { pid: 9002, groupId: 9002, birth: "reused-birth" } }),
      () => [9002],
    ),
    { state: "identity_mismatch" },
  );
  assert.deepEqual(
    control.reattestOwnedPosixAnchor(
      workloadGroup,
      () => ({ state: "present", value: { pid: 9002, groupId: 9003, birth: "anchor-birth" } }),
      () => [9002],
    ),
    { state: "identity_mismatch" },
  );
  assert.deepEqual(
    control.reattestOwnedPosixAnchor(
      workloadGroup,
      () => ({ state: "present", value: { pid: 9002, groupId: 9002, birth: "anchor-birth" } }),
      () => [9003],
    ),
    { state: "outcome_unknown" },
  );
});

test("C4 POSIX rejects malformed nonempty ps identity and membership rows", async () => {
  const control = await import("../src/portable-process-posix-control.mjs");
  assert.deepEqual(
    control.parsePosixPsIdentity(9002, "9002 9002 Mon Sep  6 00:00:00 2026"),
    { pid: 9002, groupId: 9002, birth: "Mon Sep  6 00:00:00 2026" },
  );
  assert.equal(control.parsePosixPsIdentity(9002, "not-a-process"), undefined);
  assert.deepEqual(control.parsePosixGroupMembers(" 9002 9002 S\n 9003 9002 R\n", 9002), [9002, 9003]);
  assert.equal(control.parsePosixGroupMembers("9002 9002 S\nmalformed-row\n", 9002), undefined);
  assert.equal(control.parsePosixGroupMembers("\n  \n", 9002), undefined,
    "an empty ps snapshot cannot prove that an owned group is empty");
  assert.deepEqual(
    control.parsePosixGroupMembers("2 0 I\n1 1 Ss\n 9002 9002 S\n 9003 9002 R\n", 9002),
    [9002, 9003],
    "kernel threads with pgid 0 must not void an otherwise exact membership snapshot",
  );
  assert.equal(control.parsePosixGroupMembers("0 9002 S\n9002 9002 S\n", 9002), undefined,
    "pid 0 with a positive pgid is not a kernel thread and must fail closed");
  assert.equal(control.parsePosixGroupMembers("9003 -1 S\n9002 9002 S\n", 9002), undefined,
    "a negative pgid row must fail closed");
  assert.equal(control.parsePosixGroupMembers("9002 12.5 S\n", 9002), undefined,
    "a non-integer numeric membership row must fail closed");
  assert.equal(control.parsePosixGroupMembers("abc 9002 S\n9002 9002 S\n", 9002), undefined,
    "a non-numeric membership row must fail closed");
});

test("qualification diagnostics retain POSIX prepared and child-status identity evidence", () => {
  const evidence = mkdtempSync(join(tmpdir(), "posix-qual-identity-"));
  const fixture = mkdtempSync(join(tmpdir(), "posix-qual-fixture-"));
  try {
    writeFileSync(join(fixture, "state.json"), JSON.stringify({ marker: "supervisor-state" }));
    writeFileSync(join(fixture, "child-prepared.json"), JSON.stringify({
      protocol: "aiboard-portable-process/v2-posix-prepared",
      nonce: "identity",
      groupId: 9002,
      leaderPid: 9002,
      leaderBirth: "anchor-birth",
    }));
    writeFileSync(join(fixture, "child-status.json"), JSON.stringify({
      protocol: "aiboard-portable-process/v2-posix-child",
      nonce: "identity",
      status: "prepared",
      workloadGroup: { groupId: 9002, leaderPid: 9002, leaderBirth: "anchor-birth" },
    }));
    const mapDir = join(evidence, "fixture-roots", "posix-identity");
    mkdirSync(mapDir, { recursive: true });
    writeFileSync(join(mapDir, "1-posix-identity.path.txt"), `${fixture}\n`);
    writeQualificationDiagnostics({ evidenceRoot: evidence, scenario: "posix-identity" });
    const capturedPrepared = findNamedFile(join(evidence, "diagnostics"), "child-prepared.json");
    const capturedStatus = findNamedFile(join(evidence, "diagnostics"), "child-status.json");
    assert.ok(capturedPrepared, "hosted POSIX identity failures must retain child-prepared.json");
    assert.ok(capturedStatus, "hosted POSIX identity failures must retain child-status.json");
    assert.match(readFileSync(capturedPrepared, "utf8"), /v2-posix-prepared/);
    assert.match(readFileSync(capturedStatus, "utf8"), /v2-posix-child/);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
    rmSync(evidence, { recursive: true, force: true });
  }
});

test("C4 POSIX native lifecycle never reconstructs ownership from PPID ancestry", () => {
  const root = resolve("runner-v2");
  const controlSource = readFileSync(join(root, "src", "portable-process-posix-control.mjs"), "utf8");
  const supervisorSource = readFileSync(join(root, "src", "portable-process-supervisor.mjs"), "utf8");
  for (const forbidden of ["listPosixProcessParents", "parsePosixProcessParents", "collectPosixDescendantPids"]) {
    assert.doesNotMatch(controlSource, new RegExp(forbidden), `${forbidden} must not participate in native POSIX ownership`);
    assert.doesNotMatch(supervisorSource, new RegExp(forbidden), `${forbidden} must not participate in native POSIX control`);
  }
  for (const forbidden of ["posixEscapedMembers", "captureOwnedPosixDescendantClosure", "signalOwnedPosixEscapedDescendants"]) {
    assert.doesNotMatch(supervisorSource, new RegExp(forbidden), `${forbidden} would reintroduce ancestry-derived control authority`);
  }
});
test("C4 POSIX membership excludes zombies but fails closed on unknown process state", async () => {
  const control = await import("../src/portable-process-posix-control.mjs");
  assert.deepEqual(
    control.parsePosixGroupMembers("1 1 Ss\n9002 9002 Zs\n9003 9002 S\n", 9002),
    [9003],
    "a zombie anchor is already non-executing membership and must not block exact workload quiescence",
  );
  assert.deepEqual(
    control.parsePosixGroupMembers("1 1 Ss\n9002 9002 Z+\n", 9002),
    [],
    "a successful host snapshot containing only zombie rows for the owned group proves no live members remain",
  );
  assert.equal(
    control.parsePosixGroupMembers("1 1 Ss\n9002 9002 mystery\n", 9002),
    undefined,
    "an unrecognized process state must fail closed instead of being treated as live or dead",
  );
});

test("C4 POSIX membership keeps an exact owned group when a foreign Darwin STAT modifier is present", async () => {
  const control = await import("../src/portable-process-posix-control.mjs");
  assert.deepEqual(
    control.parsePosixGroupMembers(
      "1 1 Ss\n2 0 I\n123 123 SW\n456 456 UE\n789 789 Ss+\n9002 9002 Ss\n9003 9002 S\n",
      9002,
    ),
    [9002, 9003],
    "documented Darwin STAT modifiers on unrelated rows must not void an otherwise exact owned-group snapshot",
  );
  assert.equal(
    control.parsePosixGroupMembers("1 1 Ss\n9002 9002 mystery\n", 9002),
    undefined,
    "an unrecognized process state must still fail closed",
  );
});

test("C4 POSIX membership keeps an exact owned group when a foreign Darwin Mach first-state is present", async () => {
  const control = await import("../src/portable-process-posix-control.mjs");
  // Apple ps mach_state_table is " RUSITH?": H = TH_STATE_HALTED, ? = unknown /
  // failed thread info. Hosted Gate G run 35525961170 retained an exact child
  // prepared identity while supervisor reattest via ps -e returned unknown.
  assert.deepEqual(
    control.parsePosixGroupMembers(
      "1 1 Ss\n42 42 ?\n88 88 Hs\n99 99 H+\n111 111 ?s\n9002 9002 Ss\n9003 9002 S\n",
      9002,
    ),
    [9002, 9003],
    "documented Darwin Mach first-states on unrelated rows must not void an otherwise exact owned-group snapshot",
  );
  assert.deepEqual(
    control.parsePosixGroupMembers("1 1 Ss\n9002 9002 Hs\n", 9002),
    [9002],
    "a halted owned leader remains exact group membership, not missing identity",
  );
  assert.equal(
    control.parsePosixGroupMembers("1 1 Ss\n9002 9002 mystery\n", 9002),
    undefined,
    "an unrecognized process state must still fail closed",
  );
});

test("C4 POSIX reattest stays ready when the host snapshot includes Darwin Mach first-states H and ?", async () => {
  const control = await import("../src/portable-process-posix-control.mjs");
  const workloadGroup = {
    groupId: 9651,
    leaderPid: 9651,
    leaderBirth: "Sun Sep 20 17:29:57 2026",
  } as const;
  const snapshot = [
    "1 1 Ss",
    "42 42 ?",
    "88 88 Hs",
    "99 99 H+",
    "9651 9651 Ss",
  ].join("\n");
  assert.deepEqual(
    control.reattestOwnedPosixAnchor(
      workloadGroup,
      () => ({
        state: "present",
        value: { pid: 9651, groupId: 9651, birth: workloadGroup.leaderBirth },
      }),
      (groupId: number) => control.parsePosixGroupMembers(snapshot, groupId),
    ),
    { state: "ready", members: [9651] },
    "an exact child-prepared identity must reattest ready when only foreign Darwin Mach first-states share the host ps -e snapshot",
  );
});

test("C4 POSIX tick preserves the bootstrap identity error when workload capture never completed", () => {
  const supervisorSource = readFileSync(new URL("../src/portable-process-supervisor.mjs", import.meta.url), "utf8");
  const publications: Array<{ status: string; error?: string | null }> = [];
  const bootstrapError = "POSIX detached bootstrap identity could not be independently re-attested before go.";
  const context = vm.createContext({
    Array, Error, JSON, Number, PortableAuthorityUnavailableError: Error,
    config: { directory: "root", nonce: "bootstrap-error", platform: "posix" },
    child: { pid: 9002, stdout: {}, stderr: {} },
    stdoutPath: "root/stdout.log", stderrPath: "root/stderr.log",
    handleChannelAcks: () => undefined, handleChannelInput: () => undefined, drainOutput: () => undefined,
    launchEffect: "unknown",
    posixSupervisorBirth: "Sun Sep 20 16:39:00 2026",
    posixTerminalError: bootstrapError,
    posixWorkloadGroup: null,
    posixWorkloadRetirement: { state: "active" },
    posixAnchorExited: false,
    posixControlInspectionDeferred: false,
    posixControlInspectionFailures: 0,
    posixControlInspectionDetail: "",
    posixDeferredControlSignature: null,
    POSIX_CONTROL_INSPECTION_FAILURE_LIMIT: 3,
    posixForceControlApplied: false,
    publish: (status: string, error?: string | null) => { publications.push({ status, error }); },
  });
  vm.runInContext(extractTickPosix(supervisorSource), context);
  vm.runInContext("tickPosix()", context);
  assert.equal(publications.at(-1)?.status, "outcome_unknown");
  assert.equal(publications.at(-1)?.error, bootstrapError,
    "tickPosix must retain the initial bootstrap identity error instead of overwriting it");
});

test("C4 POSIX child reports unavailable identity inspection separately from not becoming group leader", () => {
  const childSource = readFileSync(new URL("../src/portable-process-child.mjs", import.meta.url), "utf8");
  const published: unknown[] = [];
  let exits = 0;
  const context = vm.createContext({
    Error, JSON,
    config: {
      platform: "posix", nonce: "inspect-unknown", executable: "synthetic", arguments: [],
      workingDirectory: "root", environment: {}, goPath: "root/go", preparedPath: "root/prepared.json",
      statusPath: "root/status.json", posixSupervisor: { pid: 9001, birth: "supervisor-birth" },
    },
    inspectPosixProcessIdentity: () => ({ state: "unknown" }),
    process: { pid: 9002, on: () => undefined, exit: (code?: number) => { exits += 1; throw new Error(`synthetic child exit ${code}`); } },
    publishAtomic: (_path: string, value: unknown) => { published.push(value); },
    spawn: () => assert.fail("unknown identity inspection must not release an executable"),
    waiter: new Int32Array(new SharedArrayBuffer(4)),
    Atomics: { wait: () => undefined },
    existsSync: () => false,
    isExactPosixAnchorRelease: () => false,
    parsePosixBootstrapGo: () => undefined,
    runPortableFenceEffectSync: () => ({ status: "stale" }),
  });
  vm.runInContext(`${extractNamedFunction(childSource, "publishPosixStatus")}\n${extractNamedFunction(childSource, "runPosixBootstrap")}`, context);
  assert.throws(() => vm.runInContext("runPosixBootstrap()", context), /synthetic child exit 1/);
  assert.equal(exits, 1);
  assert.equal((published[0] as { error?: string }).error, "POSIX bootstrap identity inspection was unavailable.");
  assert.notEqual((published[0] as { error?: string }).error, "POSIX bootstrap did not become its detached workload group leader.");
});

test("C4 POSIX descendant reattestation refuses a recycled PGID without a recorded birth witness", async () => {
  const control = await import("../src/portable-process-posix-control.mjs");
  const workloadGroup = { groupId: 9002, leaderPid: 9002, leaderBirth: "anchor-birth" } as const;
  const recorded = new Map([[9003, "original-descendant-birth"]]);
  assert.deepEqual(
    control.reattestOwnedPosixDescendants(
      workloadGroup,
      recorded,
      (pid: number) => pid === 9100
        ? { state: "present", value: { pid: 9100, groupId: 9002, birth: "recycled-birth" } }
        : { state: "absent" },
      () => [9100],
    ),
    { state: "identity_mismatch" },
  );
  assert.deepEqual(
    control.reattestOwnedPosixDescendants(
      workloadGroup,
      recorded,
      (pid: number) => pid === 9003
        ? { state: "present", value: { pid: 9003, groupId: 9002, birth: "original-descendant-birth" } }
        : { state: "absent" },
      () => [9003, 9004],
    ),
    { state: "ready", members: [9003, 9004] },
  );
  assert.deepEqual(
    control.reattestOwnedPosixDescendants(
      workloadGroup,
      recorded,
      () => ({ state: "absent" }),
      () => [],
    ),
    { state: "empty" },
  );
  assert.deepEqual(
    control.reattestOwnedPosixDescendants(
      workloadGroup,
      recorded,
      () => ({ state: "absent" }),
      () => [9003],
    ),
    { state: "empty" },
    "a listed PID that is already gone between ps and inspect is emptiness, not an unprovable recycled group",
  );
});

test("C4 POSIX records exact descendant birth witnesses only while the authenticated anchor is live", () => {
  const supervisorSource = readFileSync(new URL("../src/portable-process-supervisor.mjs", import.meta.url), "utf8");
  const workloadGroup = { groupId: 9002, leaderPid: 9002, leaderBirth: "anchor-birth" } as const;
  const context = vm.createContext({
    Map,
    posixAnchorExited: false,
    posixControlInspectionDeferred: false,
    posixControlInspectionFailures: 0,
    posixControlInspectionDetail: "",
    posixDeferredControlSignature: null,
    POSIX_CONTROL_INSPECTION_FAILURE_LIMIT: 3,
    posixWorkloadGroup: workloadGroup,
    posixRecordedMembers: new Map<number, string>(),
    inspectPosixProcessIdentity: (pid: number) => pid === 9003
      ? { state: "present", value: { pid, groupId: workloadGroup.groupId, birth: "descendant-birth" } }
      : pid === 9004
        ? { state: "present", value: { pid, groupId: 9999, birth: "foreign-birth" } }
        : { state: "unknown" },
  });
  vm.runInContext(extractNamedFunction(supervisorSource, "recordOwnedPosixMembers"), context);
  vm.runInContext("recordOwnedPosixMembers([9003, 9004, 9005])", context);
  assert.deepEqual(
    JSON.parse(vm.runInContext("JSON.stringify([...posixRecordedMembers.entries()])", context)),
    [[9003, "descendant-birth"]],
    "only exact current members of the owned group receive durable birth witnesses",
  );
  vm.runInContext("posixAnchorExited = true; recordOwnedPosixMembers([9006])", context);
  assert.equal(vm.runInContext("posixRecordedMembers.has(9006)", context), false,
    "witness discovery must stop after real anchor exit so a recycled PGID cannot manufacture new ownership evidence");
});

test("C4 POSIX descendant continuity allows current same-group members to ride on one exact recorded birth witness", async () => {
  const control = await import("../src/portable-process-posix-control.mjs");
  const workloadGroup = { groupId: 9002, leaderPid: 9002, leaderBirth: "anchor-birth" } as const;
  const recorded = new Map([[9003, "recorded-birth"]]);
  assert.deepEqual(
    control.reattestOwnedPosixDescendants(
      workloadGroup,
      recorded,
      (pid: number) => ({ state: "present", value: { pid, groupId: 9002, birth: pid === 9003 ? "recorded-birth" : "later-member-birth" } }),
      () => [9003, 9004],
    ),
    { state: "ready", members: [9003, 9004] },
    "one exact live birth witness proves the group number never became free for recycling",
  );
});

test("C4 POSIX barrier records bind prepared, go, and anchor release to captured current authority", async () => {
  const control = await import("../src/portable-process-posix-control.mjs");
  const workloadGroup = { groupId: 9002, leaderPid: 9002, leaderBirth: "anchor-birth" } as const;
  const prepared = {
    protocol: "aiboard-portable-process/v2-posix-prepared",
    nonce: "barrier-nonce",
    ...workloadGroup,
  } as const;
  assert.deepEqual(control.parsePosixBootstrapPrepared(prepared, "barrier-nonce", 9002), workloadGroup);
  assert.equal(control.parsePosixBootstrapPrepared({ ...prepared, groupId: 9003 }, "barrier-nonce", 9002), undefined);
  const go = {
    protocol: "aiboard-portable-process/v2-posix-go",
    nonce: "barrier-nonce",
    supervisorPid: 9001,
    supervisorBirth: "supervisor-birth",
    ownerId: "owner",
    fencingToken: 1,
    workloadGroup,
  } as const;
  assert.deepEqual(
    control.parsePosixBootstrapGo(go, "barrier-nonce", workloadGroup),
    { supervisorPid: 9001, supervisorBirth: "supervisor-birth" },
  );
  assert.equal(control.parsePosixBootstrapGo({ ...go, workloadGroup: { ...workloadGroup, leaderBirth: "reused" } }, "barrier-nonce", workloadGroup), undefined);
  const release = { ...go, protocol: "aiboard-portable-process/v2-posix-anchor-release" } as const;
  const expectedSupervisor = { supervisorPid: 9001, supervisorBirth: "supervisor-birth" } as const;
  const currentFence = { ownerId: "owner", fencingToken: 1 } as const;
  assert.equal(control.isExactPosixAnchorRelease(release, "barrier-nonce", workloadGroup, expectedSupervisor, currentFence), true);
  assert.equal(control.isExactPosixAnchorRelease({ ...release, fencingToken: 2 }, "barrier-nonce", workloadGroup, expectedSupervisor, currentFence), false);
  assert.equal(control.isExactPosixAnchorRelease({ ...release, ownerId: "takeover", fencingToken: 2 }, "barrier-nonce", workloadGroup, expectedSupervisor, currentFence), false);
  assert.equal(control.isExactPosixAnchorRelease({ ...release, supervisorPid: 9003 }, "barrier-nonce", workloadGroup, expectedSupervisor, currentFence), false);
  assert.equal(control.isExactPosixAnchorRelease({ ...release, supervisorBirth: "" }, "barrier-nonce", workloadGroup, expectedSupervisor, currentFence), false);
  assert.equal(
    control.isExactPosixAnchorRelease({ ...release, ownerId: "takeover", fencingToken: 2 }, "barrier-nonce", workloadGroup, expectedSupervisor, { ownerId: "takeover", fencingToken: 2 }),
    true,
  );
});

test("C4 POSIX child consumes an anchor release only under captured current authority before go and after target exit", () => {
  const childSource = readFileSync(new URL("../src/portable-process-child.mjs", import.meta.url), "utf8");
  const nonce = "release-authority";
  const workloadGroup = { groupId: 9002, leaderPid: 9002, leaderBirth: "anchor-birth" } as const;
  const expectedSupervisor = { supervisorPid: 9001, supervisorBirth: "supervisor-birth" } as const;
  const originalFence = { ownerId: "owner", fencingToken: 1 } as const;
  const currentRelease = (fence: { ownerId: string; fencingToken: number }) => ({
    protocol: "aiboard-portable-process/v2-posix-anchor-release",
    nonce,
    ...expectedSupervisor,
    ...fence,
    workloadGroup,
  });
  const childFunctions = [
    "readJson",
    "configuredPosixSupervisorAuthority",
    "samePosixSupervisorAuthority",
    "readCurrentPosixFence",
    "readAnchorReleaseFence",
    "consumeExactPosixAnchorRelease",
    "publishPosixStatus",
    "waitForAnchorRelease",
    "waitForPosixBarrier",
    "runPosixBootstrap",
  ].map((name) => extractOptionalNamedFunction(childSource, name)).join("\n");

  function createHarness(release: Record<string, unknown>, currentFence: { ownerId: string; fencingToken: number }) {
    const published: unknown[] = [];
    let exits = 0;
    let callback: (() => void) | undefined;
    let transactionDepth = 0;
    let statusPublishedInsideTransaction = false;
    let transactions = 0;
    const harness = {
      release,
      currentFence,
      published,
      get exits() { return exits; },
      get callback() { return callback; },
      get statusPublishedInsideTransaction() { return statusPublishedInsideTransaction; },
      get transactions() { return transactions; },
    };
    const context = vm.createContext({
      Atomics: { wait: () => { throw new Error("synthetic child release wait"); } },
      Error,
      JSON,
      config: {
        anchorReleasePath: "root/anchor-release.json",
        arguments: [],
        executable: "synthetic-executable",
        fenceLockPath: "root/.fence.lock",
        fencePath: "root/fence.json",
        goPath: "root/go.json",
        lockHolderPath: "root/lock-holder.json",
        nonce,
        posixSupervisor: { pid: expectedSupervisor.supervisorPid, birth: expectedSupervisor.supervisorBirth },
        preparedPath: "root/prepared.json",
        statusPath: "root/status.json",
        workingDirectory: "root",
        environment: {},
      },
      existsSync: () => false,
      expectedSupervisor,
      inspectPosixProcessIdentity: (pid: number) => {
        if (pid === workloadGroup.leaderPid)
          return { state: "present", value: { pid, groupId: workloadGroup.groupId, birth: workloadGroup.leaderBirth } };
        if (pid === expectedSupervisor.supervisorPid)
          return { state: "present", value: { pid, groupId: expectedSupervisor.supervisorPid, birth: expectedSupervisor.supervisorBirth } };
        return { state: "absent" };
      },
      isExactPosixAnchorRelease,
      parsePosixBootstrapGo,
      process: { pid: workloadGroup.leaderPid, on: () => undefined, exit: () => { exits += 1; } },
      publishAtomic: (_path: string, value: unknown) => {
        published.push(value);
        if (transactionDepth > 0) statusPublishedInsideTransaction = true;
      },
      readFileSync: (path: string) => {
        if (path === "root/anchor-release.json") return JSON.stringify(harness.release);
        if (path === "root/fence.json") return JSON.stringify({ nonce, ...harness.currentFence });
        if (path === "root/lock-holder.json") return JSON.stringify({
          nonce,
          holderPid: expectedSupervisor.supervisorPid,
          holderBirth: expectedSupervisor.supervisorBirth,
        });
        throw new Error(`synthetic file is absent: ${path}`);
      },
      runPortableFenceEffectSync: (options: {
        expectedFence: { ownerId: string; fencingToken: number };
        readCurrentFence: () => unknown;
        effect: () => unknown;
      }) => {
        const current = options.readCurrentFence() as { ownerId?: unknown; fencingToken?: unknown } | undefined;
        if (!current || current.ownerId !== options.expectedFence.ownerId || current.fencingToken !== options.expectedFence.fencingToken)
          return { status: "stale" };
        transactions += 1;
        transactionDepth += 1;
        try { return { status: "applied", value: options.effect() }; }
        finally { transactionDepth -= 1; }
      },
      setInterval: (next: () => void) => { callback = next; return 1; },
      clearInterval: () => undefined,
      spawn: () => assert.fail("a rejected before-go marker must not release an executable"),
      waiter: new Int32Array(new SharedArrayBuffer(4)),
      workloadGroup,
    });
    vm.runInContext(childFunctions, context);
    return { context, harness };
  }

  const beforeGo = createHarness({ ...currentRelease(originalFence), supervisorBirth: "foreign-supervisor-birth" }, originalFence);
  assert.throws(() => vm.runInContext("runPosixBootstrap()", beforeGo.context), /synthetic child release wait/);
  assert.equal(beforeGo.harness.exits, 0, "a foreign supervisor marker must not release the anchor before go");
  assert.deepEqual(
    beforeGo.harness.published.map((value) => (value as { status?: unknown }).status).filter((status) => typeof status === "string"),
    ["prepared"],
  );

  const staleMarkers = [
    { name: "foreign nonce", release: { ...currentRelease(originalFence), nonce: "foreign" }, fence: originalFence },
    { name: "foreign group", release: { ...currentRelease(originalFence), workloadGroup: { ...workloadGroup, leaderBirth: "foreign" } }, fence: originalFence },
    { name: "foreign supervisor PID", release: { ...currentRelease(originalFence), supervisorPid: 9177 }, fence: originalFence },
    { name: "foreign supervisor birth", release: { ...currentRelease(originalFence), supervisorBirth: "foreign-supervisor-birth" }, fence: originalFence },
    { name: "stale fence token", release: currentRelease(originalFence), fence: { ownerId: originalFence.ownerId, fencingToken: 2 } },
    { name: "stale fence owner", release: currentRelease(originalFence), fence: { ownerId: "takeover", fencingToken: 2 } },
  ];
  for (const stale of staleMarkers) {
    const postExit = createHarness(stale.release, stale.fence);
    vm.runInContext("waitForAnchorRelease(workloadGroup, () => true, expectedSupervisor)", postExit.context);
    assert.ok(postExit.harness.callback, `${stale.name} schedule did not enter the actual settled-target release handler`);
    postExit.harness.callback?.();
    assert.equal(postExit.harness.exits, 0, `${stale.name} marker must not release the anchor after executable exit`);
    assert.deepEqual(postExit.harness.published, [], `${stale.name} marker must not publish a released child record`);
  }

  const takeoverFence = { ownerId: "takeover", fencingToken: 2 } as const;
  const replacement = createHarness(currentRelease(takeoverFence), takeoverFence);
  vm.runInContext("waitForAnchorRelease(workloadGroup, () => true, expectedSupervisor)", replacement.context);
  replacement.harness.callback?.();
  assert.equal(replacement.harness.exits, 1, "a correctly authorized higher-fence replacement must release the anchor");
  assert.equal(replacement.harness.statusPublishedInsideTransaction, true, "the released status effect must be committed inside the owned-fence transaction");
  assert.equal(replacement.harness.transactions, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(replacement.harness.published)), [{
    protocol: "aiboard-portable-process/v2-posix-child",
    nonce,
    status: "released",
    workloadGroup,
    anchorRelease: currentRelease(takeoverFence),
  }]);
});

test("C4 POSIX child-crash anchor release records its own holder so a live supervisor cannot wedge C1 reclamation", () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-posix-c4-anchor-lock-holder-"));
  const childSource = readFileSync(new URL("../src/portable-process-child.mjs", import.meta.url), "utf8");
  const nonce = "anchor-lock-holder";
  const childPid = 9002;
  const childBirth = "anchor-child-birth";
  const supervisorPid = 9001;
  const supervisorBirth = "live-supervisor-birth";
  const reclaimerPid = 9003;
  const workloadGroup = { groupId: childPid, leaderPid: childPid, leaderBirth: childBirth } as const;
  const expectedSupervisor = { supervisorPid, supervisorBirth } as const;
  const currentFence = { ownerId: "owner", fencingToken: 1 } as const;
  const lockPath = join(root, ".fence.lock");
  const anchorReleasePath = join(root, "anchor-release.json");
  const fencePath = join(root, "fence.json");
  const lockHolderPath = join(root, "lock-holder.json");
  const statusPath = join(root, "child-status.json");
  const childFunctions = [
    "readJson",
    "readCurrentPosixFence",
    "readAnchorReleaseFence",
    "consumeExactPosixAnchorRelease",
    "publishPosixStatus",
    "publishAtomic",
  ].map((name) => extractNamedFunction(childSource, name)).join("\n");
  const observations: Array<{ pid: number; birth: string }> = [];
  const inspectHolder = (pid: number, birth: string) => {
    observations.push({ pid, birth });
    if (pid === childPid && birth === childBirth) return "absent" as const;
    if (pid === supervisorPid && birth === supervisorBirth) return "same" as const;
    return "unknown" as const;
  };
  try {
    writeFileSync(anchorReleasePath, JSON.stringify({
      protocol: "aiboard-portable-process/v2-posix-anchor-release",
      nonce,
      ...expectedSupervisor,
      ...currentFence,
      workloadGroup,
    }));
    writeFileSync(fencePath, JSON.stringify({ nonce, ...currentFence }));
    writeFileSync(lockHolderPath, JSON.stringify({
      nonce,
      holderPid: supervisorPid,
      holderBirth: supervisorBirth,
    }));
    const childContext = vm.createContext({
      Error,
      JSON,
      config: { anchorReleasePath, fenceLockPath: lockPath, fencePath, lockHolderPath, nonce, statusPath },
      expectedSupervisor,
      workloadGroup,
      process: { pid: childPid },
      readFileSync,
      writeFileSync,
      renameSync: (from: string, to: string) => { renameSync(from, to); },
      inspectPosixProcessIdentity: (pid: number) => pid === supervisorPid
        ? { state: "present", value: { pid, groupId: pid, birth: supervisorBirth } }
        : { state: "absent" },
      isExactPosixAnchorRelease,
      runPortableFenceEffectSync: (options: Parameters<typeof runPortableFenceEffectSync>[0]) => runPortableFenceEffectSync({
        ...options,
        lockOptions: {
          ...options.lockOptions,
          afterClaim: () => { throw new Error("synthetic child crash after durable C1 claim"); },
          deadlineMs: 40,
          inspectHolder,
          retryDelayMs: 1,
        },
      }),
    });
    vm.runInContext(childFunctions, childContext);

    assert.equal(
      vm.runInContext("consumeExactPosixAnchorRelease(workloadGroup, expectedSupervisor)", childContext),
      false,
      "the interrupted child must not publish a completed release effect",
    );
    assert.equal(existsSync(statusPath), false, "the crash boundary is before the child status effect");

    const database = new DatabaseSync(lockPath, { readOnly: true });
    const staleHolder = database.prepare("SELECT holder_pid AS holderPid, holder_birth AS holderBirth FROM owned_fence_holder WHERE lock_key = 'owned'").get() as {
      holderPid: number;
      holderBirth: string;
    } | undefined;
    database.close();

    const reclaim = runPortableFenceEffectSync({
      lockPath,
      expectedFence: currentFence,
      readCurrentFence: () => currentFence,
      effect: () => "reclaimed",
      lockOptions: {
        deadlineMs: 40,
        holderPid: reclaimerPid,
        holderBirth: "reclaimer-birth",
        inspectHolder,
        retryDelayMs: 1,
      },
    });

    assert.deepEqual(
      reclaim,
      { status: "applied", value: "reclaimed" },
      "a crashed anchor must be reclaimed even while the logical supervisor remains live",
    );
    assert.deepEqual(
      staleHolder && { holderPid: Number(staleHolder.holderPid), holderBirth: String(staleHolder.holderBirth) },
      { holderPid: childPid, holderBirth: childBirth },
    );
    assert.deepEqual(observations, [{ pid: childPid, birth: childBirth }],
      "only the crashed acquiring anchor is queried at the C1 process-birth boundary");
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 30, retryDelay: 50 });
  }
});

test("C4 POSIX child does not spawn an executable after a mismatched go publication", () => {
  const childSource = readFileSync(new URL("../src/portable-process-child.mjs", import.meta.url), "utf8");
  const workloadGroup = { groupId: 9002, leaderPid: 9002, leaderBirth: "anchor-birth" } as const;
  const records = new Map<string, unknown>();
  let spawnCalls = 0;
  let releasePolls = 0;
  const context = vm.createContext({
    Error,
    JSON,
    config: {
      anchorReleasePath: "root/release.json",
      arguments: [],
      executable: "synthetic-executable",
      goPath: "root/go.json",
      posixSupervisor: { pid: 9001, birth: "supervisor-birth" },
      nonce: "interrupted-go",
      preparedPath: "root/prepared.json",
      statusPath: "root/status.json",
      workingDirectory: "root",
      environment: {},
    },
    existsSync: (path: string) => path === "root/go.json",
    inspectPosixProcessIdentity: () => ({ state: "present", value: { pid: 9002, groupId: 9002, birth: workloadGroup.leaderBirth } }),
    isExactPosixAnchorRelease,
    parsePosixBootstrapGo,
    process: { pid: 9002, on: () => undefined, exit: () => assert.fail("invalid go must retain the anchor for explicit release, not exit early") },
    publishAtomic: (path: string, value: unknown) => { records.set(path, value); },
    readFileSync: (path: string) => {
      if (path === "root/go.json") return JSON.stringify({
        protocol: "aiboard-portable-process/v2-posix-go",
        nonce: "interrupted-go",
        supervisorPid: 9001,
        supervisorBirth: "supervisor-birth",
        ownerId: "owner",
        fencingToken: 1,
        workloadGroup: { ...workloadGroup, leaderBirth: "reused-anchor-birth" },
      });
      throw new Error(`synthetic file is absent: ${path}`);
    },
    setInterval: () => { releasePolls += 1; return 1; },
    clearInterval: () => undefined,
    spawn: () => { spawnCalls += 1; throw new Error("executable must remain behind the invalid go barrier"); },
  });
  vm.runInContext(`${extractNamedFunction(childSource, "readJson")}\n${extractNamedFunction(childSource, "configuredPosixSupervisorAuthority")}\n${extractNamedFunction(childSource, "samePosixSupervisorAuthority")}\n${extractNamedFunction(childSource, "readCurrentPosixFence")}\n${extractNamedFunction(childSource, "readAnchorReleaseFence")}\n${extractNamedFunction(childSource, "consumeExactPosixAnchorRelease")}\n${extractNamedFunction(childSource, "publishPosixStatus")}\n${extractNamedFunction(childSource, "waitForAnchorRelease")}\n${extractNamedFunction(childSource, "waitForPosixBarrier")}\n${extractNamedFunction(childSource, "runPosixBootstrap")}`, context);

  vm.runInContext("runPosixBootstrap()", context);
  assert.deepEqual(JSON.parse(JSON.stringify(records.get("root/prepared.json"))), {
    protocol: "aiboard-portable-process/v2-posix-prepared",
    nonce: "interrupted-go",
    ...workloadGroup,
  });
  assert.deepEqual(JSON.parse(JSON.stringify(records.get("root/status.json"))), {
    protocol: "aiboard-portable-process/v2-posix-child",
    nonce: "interrupted-go",
    status: "error",
    error: "POSIX bootstrap go barrier identity is invalid.",
    workloadGroup,
  });
  assert.equal(spawnCalls, 0);
  assert.equal(releasePolls, 1, "the malformed go keeps the already-born anchor available for an explicit release record");
});

test("C4 POSIX child retains its exact prepared breadcrumb through a pre-go crash boundary", () => {
  const childSource = readFileSync(new URL("../src/portable-process-child.mjs", import.meta.url), "utf8");
  const workloadGroup = { groupId: 9002, leaderPid: 9002, leaderBirth: "anchor-birth" } as const;
  const records = new Map<string, unknown>();
  let spawnCalls = 0;
  let waits = 0;
  const context = vm.createContext({
    Atomics: {
      wait: () => {
        waits += 1;
        throw new Error("synthetic supervisor crash before go publication");
      },
    },
    Error,
    JSON,
    config: {
      anchorReleasePath: "root/release.json",
      arguments: [],
      executable: "synthetic-executable",
      goPath: "root/go.json",
      posixSupervisor: { pid: 9001, birth: "supervisor-birth" },
      nonce: "pre-go-crash",
      preparedPath: "root/prepared.json",
      statusPath: "root/status.json",
      workingDirectory: "root",
      environment: {},
    },
    existsSync: () => false,
    inspectPosixProcessIdentity: () => ({ state: "present", value: { pid: 9002, groupId: 9002, birth: workloadGroup.leaderBirth } }),
    isExactPosixAnchorRelease,
    parsePosixBootstrapGo,
    process: { pid: 9002, on: () => undefined, exit: () => assert.fail("pre-go interruption must not exit or release the anchor") },
    publishAtomic: (path: string, value: unknown) => { records.set(path, value); },
    readFileSync: (path: string) => { throw new Error(`synthetic file is absent: ${path}`); },
    spawn: () => { spawnCalls += 1; throw new Error("pre-go interruption must retain zero executable spawn"); },
    waiter: new Int32Array(new SharedArrayBuffer(4)),
  });
  vm.runInContext(`${extractNamedFunction(childSource, "readJson")}\n${extractNamedFunction(childSource, "configuredPosixSupervisorAuthority")}\n${extractNamedFunction(childSource, "samePosixSupervisorAuthority")}\n${extractNamedFunction(childSource, "readCurrentPosixFence")}\n${extractNamedFunction(childSource, "readAnchorReleaseFence")}\n${extractNamedFunction(childSource, "consumeExactPosixAnchorRelease")}\n${extractNamedFunction(childSource, "publishPosixStatus")}\n${extractNamedFunction(childSource, "waitForAnchorRelease")}\n${extractNamedFunction(childSource, "waitForPosixBarrier")}\n${extractNamedFunction(childSource, "runPosixBootstrap")}`, context);

  assert.throws(() => vm.runInContext("runPosixBootstrap()", context), /synthetic supervisor crash before go publication/);
  assert.equal(waits, 1, "the exact prepared anchor reaches the absent-go barrier before the interruption");
  assert.deepEqual(JSON.parse(JSON.stringify(records.get("root/prepared.json"))), {
    protocol: "aiboard-portable-process/v2-posix-prepared",
    nonce: "pre-go-crash",
    ...workloadGroup,
  });
  assert.deepEqual(JSON.parse(JSON.stringify(records.get("root/status.json"))), {
    protocol: "aiboard-portable-process/v2-posix-child",
    nonce: "pre-go-crash",
    status: "prepared",
    workloadGroup,
  });
  assert.equal(spawnCalls, 0, "pre-go supervisor loss cannot release an executable");
});

test("C4 POSIX supervisor retries transient inner anchor inspection before go", () => {
  const supervisorSource = readFileSync(new URL("../src/portable-process-supervisor.mjs", import.meta.url), "utf8");
  const workloadGroup = { groupId: 9002, leaderPid: 9002, leaderBirth: "anchor-birth" } as const;
  const nonce = "transient-inner-go";
  const publications: Array<{ status: string; error?: string }> = [];
  const writes: Array<{ path: string; value: unknown }> = [];
  let anchorChecks = 0;
  const context = vm.createContext({
    Atomics, Date, Error, JSON, Number, Int32Array, SharedArrayBuffer, PortableAuthorityUnavailableError: Error,
    child: { pid: workloadGroup.leaderPid }, childGoPath: "root/child-go.json", childPreparedPath: "root/child-prepared.json",
    config: { directory: "root", nonce, platform: "posix" }, fencePath: "root/fence.json", join, lockHolderPath: "root/lock-holder.json",
    launchEffect: "prepared", parsePosixBootstrapPrepared, posixBarrierWaiter: new Int32Array(new SharedArrayBuffer(4)),
    posixSupervisorBirth: null, posixWorkloadGroup: null, process: { pid: 9001 },
    targetExited: false, targetExitCode: null, targetSignal: null, posixTerminalError: null,
    publish: (status: string, error?: string) => { publications.push({ status, error }); },
    readFileSync: (path: string) => {
      if (path === "root/child-prepared.json") return JSON.stringify({ protocol: "aiboard-portable-process/v2-posix-prepared", nonce, ...workloadGroup });
      if (path === "root/lock-holder.json") return JSON.stringify({ nonce, holderPid: 9001, holderBirth: "supervisor-birth" });
      if (path === "root/fence.json") return JSON.stringify({ nonce, ownerId: "owner", fencingToken: 1 });
      throw new Error(`unexpected synthetic read ${path}`);
    },
    reattestOwnedPosixAnchor: () => { anchorChecks += 1; return anchorChecks === 2 ? { state: "outcome_unknown" } : { state: "ready", members: [workloadGroup.leaderPid] }; },
    runPortableFenceEffectSync: (options: { effect: () => unknown }) => ({ status: "applied", value: options.effect() }),
    writeAtomic: (path: string, value: unknown) => { writes.push({ path, value }); },
    inspectPosixProcessIdentity: () => ({ state: "present", value: { pid: 9001, groupId: 9001, birth: "supervisor-birth" } }),
    waitForPosixChildStartup: () => ({ status: "started" }),
  });
  vm.runInContext(`${extractNamedFunction(supervisorSource, "readJson")}\n${extractNamedFunction(supervisorSource, "readCurrentFence")}\n${extractNamedFunction(supervisorSource, "readCurrentFenceStrict")}\n${extractFenceEffectFunctions(supervisorSource)}\n${extractNamedFunction(supervisorSource, "waitForPosixPrepared")}\n${extractNamedFunction(supervisorSource, "hasExactPosixLockHolder")}\n${extractNamedFunction(supervisorSource, "waitForExactPosixLockHolder")}\n${extractNamedFunction(supervisorSource, "initializePosixBootstrap")}`, context);
  vm.runInContext("initializePosixBootstrap()", context);
  assert.ok(anchorChecks >= 3, "transient passive inner inspection must be retried under the unchanged exact fence");
  assert.equal(writes.filter(({ path }) => path === "root/child-go.json").length, 1);
  assert.equal(vm.runInContext("launchEffect", context), "started");
  assert.equal(publications.at(-1)?.status, "running");
  assert.equal(publications.some(({ status }) => status === "outcome_unknown"), false);
});

test("C4 POSIX supervisor does not publish go when the fenced publication is interrupted", () => {
  const supervisorSource = readFileSync(new URL("../src/portable-process-supervisor.mjs", import.meta.url), "utf8");
  const workloadGroup = { groupId: 9002, leaderPid: 9002, leaderBirth: "anchor-birth" } as const;
  const nonce = "stale-go";
  const publications: Array<{ status: string; error?: string }> = [];
  const writes: Array<{ path: string; value: unknown }> = [];
  const context = vm.createContext({
    Error,
    JSON,
    Number,
    PortableAuthorityUnavailableError: Error,
    child: { pid: workloadGroup.leaderPid },
    childGoPath: "root/child-go.json",
    childPreparedPath: "root/child-prepared.json",
    config: { directory: "root", nonce, platform: "posix" },
    fencePath: "root/fence.json",
    join,
    lockHolderPath: "root/lock-holder.json",
    launchEffect: "prepared",
    parsePosixBootstrapPrepared,
    posixBarrierWaiter: new Int32Array(new SharedArrayBuffer(4)),
    posixSupervisorBirth: null,
    posixWorkloadGroup: null,
    process: { pid: 9001 },
    publish: (status: string, error?: string) => { publications.push({ status, error }); },
    readFileSync: (path: string) => {
      if (path === "root/child-prepared.json") return JSON.stringify({
        protocol: "aiboard-portable-process/v2-posix-prepared", nonce, ...workloadGroup,
      });
      if (path === "root/lock-holder.json") return JSON.stringify({ nonce, holderPid: 9001, holderBirth: "supervisor-birth" });
      if (path === "root/fence.json") return JSON.stringify({ nonce, ownerId: "owner", fencingToken: 1 });
      throw new Error(`unexpected synthetic read ${path}`);
    },
    reattestOwnedPosixAnchor: () => ({ state: "ready", members: [workloadGroup.leaderPid] }),
    runPortableFenceEffectSync: () => ({ status: "stale" }),
    writeAtomic: (path: string, value: unknown) => { writes.push({ path, value }); },
    inspectPosixProcessIdentity: () => ({ state: "present", value: { pid: 9001, groupId: 9001, birth: "supervisor-birth" } }),
  });
  vm.runInContext(`${extractNamedFunction(supervisorSource, "readJson")}\n${extractNamedFunction(supervisorSource, "readCurrentFence")}\n${extractNamedFunction(supervisorSource, "readCurrentFenceStrict")}\n${extractFenceEffectFunctions(supervisorSource)}\n${extractNamedFunction(supervisorSource, "waitForPosixPrepared")}\n${extractNamedFunction(supervisorSource, "hasExactPosixLockHolder")}\n${extractNamedFunction(supervisorSource, "waitForExactPosixLockHolder")}\n${extractNamedFunction(supervisorSource, "initializePosixBootstrap")}`, context);

  vm.runInContext("initializePosixBootstrap()", context);
  assert.deepEqual(writes, [], "a stale publication fence must prevent executable release through child-go");
  assert.equal(vm.runInContext("launchEffect", context), "unknown");
  assert.equal(publications.at(-1)?.status, "outcome_unknown");
  assert.match(publications.at(-1)?.error ?? "", /go barrier.*committed/i);
});

test("C4 POSIX supervisor preserves its witness and reports outcome_unknown after anchor loss", () => {
  const supervisorSource = readFileSync(new URL("../src/portable-process-supervisor.mjs", import.meta.url), "utf8");
  const workloadGroup = { groupId: 9002, leaderPid: 9002, leaderBirth: "anchor-birth" } as const;
  const request = { nonce: "anchor-loss", ownerId: "owner", fencingToken: 1, sequence: 1, action: "force_terminate" } as const;
  const published: Array<{ status: string; error?: string }> = [];
  const signals: Array<{ groupId: number; action: string }> = [];
  let controlPresent = true;
  const context = vm.createContext({
    Array,
    Error,
    JSON,
    Number,
    PortableAuthorityUnavailableError: Error,
    config: { directory: "root", nonce: request.nonce, platform: "posix" },
    controlPath: "root/control.json",
    fencePath: "root/fence.json",
    lockHolderPath: "root/lock-holder.json",
    handledControl: 0,
    join,
    posixAnchorExited: false,
    posixControlInspectionDeferred: false,
    posixControlInspectionFailures: 0,
    posixControlInspectionDetail: "",
    posixDeferredControlSignature: null,
    POSIX_CONTROL_INSPECTION_FAILURE_LIMIT: 3,
    posixForceControlApplied: false,
    posixWorkloadGroup: workloadGroup,
    process: { pid: 9001 },
    publish: (status: string, error?: string) => { published.push({ status, error }); },
    reattestOwnedPosixAnchor: () => ({ state: "identity_mismatch" }),
    readFileSync: (path: string) => {
      if (path === "root/control.json") return JSON.stringify(request);
      if (path === "root/fence.json") return JSON.stringify({ nonce: request.nonce, ownerId: request.ownerId, fencingToken: request.fencingToken });
      if (path === "root/lock-holder.json") return JSON.stringify({ nonce: request.nonce, holderPid: 9001, holderBirth: "supervisor-birth" });
      throw new Error(`unexpected synthetic read ${path}`);
    },
    runPortableFenceEffectSync: (options: { effect: () => unknown }) => ({ status: "applied", value: options.effect() }),
    settlePortableSupervisorCommand,
    signalOwnedPosixGroup: (action: string, _signal: unknown, groupId: number) => { signals.push({ action, groupId }); },
    unlinkSync: () => { controlPresent = false; },
    existsSync: (path: string) => path === "root/control.json" && controlPresent,
  });
  vm.runInContext(`${extractNamedFunction(supervisorSource, "readCurrentFence")}\n${extractNamedFunction(supervisorSource, "readCurrentFenceStrict")}\n${extractFenceEffectFunctions(supervisorSource)}\n${extractNamedFunction(supervisorSource, "completeControl")}\n${extractNamedFunction(supervisorSource, "handleControl")}`, context);

  assert.doesNotThrow(() => vm.runInContext("handleControl()", context));
  assert.deepEqual(signals, [], "a missing anchor must never re-enable numeric group control");
  assert.equal(published.at(-1)?.status, "outcome_unknown");
  assert.match(published.at(-1)?.error ?? "", /anchor/i);
});

test("C4 POSIX supervisor reattests inside the fenced effect before a group signal", () => {
  const supervisorSource = readFileSync(new URL("../src/portable-process-supervisor.mjs", import.meta.url), "utf8");
  const workloadGroup = { groupId: 9002, leaderPid: 9002, leaderBirth: "anchor-birth" } as const;
  const request = { nonce: "anchor-race", ownerId: "owner", fencingToken: 1, sequence: 1, action: "force_terminate" } as const;
  const published: Array<{ status: string; error?: string }> = [];
  const signals: Array<{ groupId: number; action: string }> = [];
  let controlPresent = true;
  let reattestations = 0;
  const context = vm.createContext({
    Array,
    Error,
    JSON,
    Number,
    PortableAuthorityUnavailableError: Error,
    config: { directory: "root", nonce: request.nonce, platform: "posix" },
    controlPath: "root/control.json",
    fencePath: "root/fence.json",
    lockHolderPath: "root/lock-holder.json",
    handledControl: 0,
    join,
    posixAnchorExited: false,
    posixControlInspectionDeferred: false,
    posixControlInspectionFailures: 0,
    posixControlInspectionDetail: "",
    posixDeferredControlSignature: null,
    POSIX_CONTROL_INSPECTION_FAILURE_LIMIT: 3,
    posixForceControlApplied: false,
    posixWorkloadGroup: workloadGroup,
    process: { pid: 9001 },
    publish: (status: string, error?: string) => { published.push({ status, error }); },
    reattestOwnedPosixAnchor: () => ++reattestations === 1
      ? { state: "ready", members: [workloadGroup.leaderPid, 9003] }
      : { state: "outcome_unknown" },
    readFileSync: (path: string) => {
      if (path === "root/control.json") return JSON.stringify(request);
      if (path === "root/fence.json") return JSON.stringify({ nonce: request.nonce, ownerId: request.ownerId, fencingToken: request.fencingToken });
      if (path === "root/lock-holder.json") return JSON.stringify({ nonce: request.nonce, holderPid: 9001, holderBirth: "supervisor-birth" });
      throw new Error(`unexpected synthetic read ${path}`);
    },
    runPortableFenceEffectSync: (options: { effect: () => unknown }) => ({ status: "applied", value: options.effect() }),
    settlePortableSupervisorCommand,
    signalOwnedPosixGroup: (action: string, _signal: unknown, groupId: number) => { signals.push({ action, groupId }); },
    unlinkSync: () => { controlPresent = false; },
    existsSync: (path: string) => path === "root/control.json" && controlPresent,
  });
  vm.runInContext(`${extractNamedFunction(supervisorSource, "readCurrentFence")}\n${extractNamedFunction(supervisorSource, "readCurrentFenceStrict")}\n${extractFenceEffectFunctions(supervisorSource)}\n${extractNamedFunction(supervisorSource, "completeControl")}\n${extractNamedFunction(supervisorSource, "handleControl")}`, context);

  assert.doesNotThrow(() => vm.runInContext("handleControl()", context));
  assert.equal(reattestations, 2, "the exact anchor must be checked again inside the fence effect");
  assert.deepEqual(signals, [], "a transiently unprovable anchor during the fence effect must not receive numeric-only control");
  assert.equal(vm.runInContext("handledControl", context), 0, "a transient inner-fence inspection must leave the exact request retryable");
  assert.equal(vm.runInContext("posixControlInspectionDeferred", context), true, "transient inner-fence uncertainty must be carried back to the tick");
  assert.equal(published.some(({ status }) => status === "outcome_unknown"), false, "transient inner-fence uncertainty is retryable rather than terminal");
});

test("C4 POSIX supervisor consumes an inner-fence identity mismatch without signalling", () => {
  const supervisorSource = readFileSync(new URL("../src/portable-process-supervisor.mjs", import.meta.url), "utf8");
  const workloadGroup = { groupId: 9002, leaderPid: 9002, leaderBirth: "anchor-birth" } as const;
  const request = { nonce: "anchor-mismatch-race", ownerId: "owner", fencingToken: 1, sequence: 1, action: "force_terminate" } as const;
  const publications: Array<{ status: string; error?: string }> = [];
  const signals: Array<{ groupId: number; action: string }> = [];
  let reattestations = 0;
  const context = vm.createContext({
    Error, JSON, Number, Symbol, PortableAuthorityUnavailableError: Error,
    config: { directory: "root", nonce: request.nonce, platform: "posix" },
    controlPath: "root/control.json", fencePath: "root/fence.json", lockHolderPath: "root/lock-holder.json",
    handledControl: 0, join, posixAnchorExited: false,
    posixControlInspectionDeferred: false, posixControlInspectionFailures: 0, posixControlInspectionDetail: "",
    posixDeferredControlSignature: null, POSIX_CONTROL_INSPECTION_FAILURE_LIMIT: 3,
    posixForceControlApplied: false, posixWorkloadGroup: workloadGroup, process: { pid: 9001 },
    publish: (status: string, error?: string) => { publications.push({ status, error }); },
    reattestOwnedPosixAnchor: () => ++reattestations === 1
      ? { state: "ready", members: [workloadGroup.leaderPid, 9003] }
      : { state: "identity_mismatch" },
    readFileSync: (path: string) => path === "root/control.json" ? JSON.stringify(request)
      : path === "root/fence.json" ? JSON.stringify({ nonce: request.nonce, ownerId: request.ownerId, fencingToken: request.fencingToken })
      : path === "root/lock-holder.json" ? JSON.stringify({ nonce: request.nonce, holderPid: 9001, holderBirth: "supervisor-birth" })
      : (() => { throw new Error(`unexpected synthetic read ${path}`); })(),
    existsSync: (path: string) => path === "root/control.json", unlinkSync: () => undefined,
    runPortableFenceEffectSync: (options: { effect: () => unknown }) => ({ status: "applied", value: options.effect() }),
    settlePortableSupervisorCommand,
    signalOwnedPosixGroup: (action: string, _signal: unknown, groupId: number) => { signals.push({ action, groupId }); },
  });
  vm.runInContext(`${extractNamedFunction(supervisorSource, "readCurrentFence")}\n${extractNamedFunction(supervisorSource, "readCurrentFenceStrict")}\n${extractFenceEffectFunctions(supervisorSource)}\n${extractNamedFunction(supervisorSource, "completeControl")}\n${extractNamedFunction(supervisorSource, "handleControl")}`, context);
  vm.runInContext("handleControl()", context);
  assert.equal(reattestations, 2);
  assert.deepEqual(signals, [], "identity mismatch inside the fence must never reach numeric group control");
  assert.equal(vm.runInContext("handledControl", context), 1, "a definitive identity mismatch is consumed instead of retried against the numeric PGID");
  assert.equal(vm.runInContext("posixControlInspectionDeferred", context), false);
  assert.equal(publications.at(-1)?.status, "outcome_unknown");
  assert.match(publications.at(-1)?.error ?? "", /anchor.*unavailable|numeric-only/i);
});

test("C4 POSIX supervisor treats readable EOF as exact pipe completion even when stream close is delayed", () => {
  const supervisorSource = readFileSync(new URL("../src/portable-process-supervisor.mjs", import.meta.url), "utf8");
  const callbacks = new Map<string, () => void>();
  const stream = (name: "stdout" | "stderr") => ({
    once(event: string, callback: () => void) { callbacks.set(`${name}:${event}`, callback); return this; },
  });
  const context = vm.createContext({
    posixStdoutClosed: false,
    posixStderrClosed: false,
    stdout: stream("stdout"),
    stderr: stream("stderr"),
  });
  vm.runInContext(`${extractNamedFunction(supervisorSource, "markPosixPipeClosed")}\n${extractNamedFunction(supervisorSource, "installPosixOutputLifecycle")}`, context);
  vm.runInContext('installPosixOutputLifecycle("stdout", stdout); installPosixOutputLifecycle("stderr", stderr);', context);
  assert.equal(vm.runInContext("posixStdoutClosed", context), false);
  assert.equal(vm.runInContext("posixStderrClosed", context), false);
  assert.equal(typeof callbacks.get("stdout:end"), "function", "EOF must independently certify that no more stdout bytes can arrive");
  assert.equal(typeof callbacks.get("stderr:end"), "function", "EOF must independently certify that no more stderr bytes can arrive");
  callbacks.get("stdout:end")!();
  assert.equal(vm.runInContext("posixStdoutClosed", context), true);
  assert.equal(vm.runInContext("posixStderrClosed", context), false);
  callbacks.get("stderr:end")!();
  assert.equal(vm.runInContext("posixStderrClosed", context), true);
  assert.doesNotThrow(() => callbacks.get("stdout:close")!(), "later close is idempotent after EOF");
});
test("C4 POSIX output pump probes a zero-length readable so pending EOF can retire the exact pipe", () => {
  const supervisorSource = readFileSync(new URL("../src/portable-process-supervisor.mjs", import.meta.url), "utf8");
  let zeroLengthReads = 0;
  let end: (() => void) | undefined;
  const stdout = {
    readableLength: 0,
    once(event: string, callback: () => void) { if (event === "end") end = callback; return this; },
    read(size?: number) { if (size === 0) { zeroLengthReads += 1; end?.(); } return null; },
  };
  const context = vm.createContext({
    Buffer,
    Map,
    appendFileSync: () => assert.fail("zero-length EOF probe must not append bytes"),
    channelOutputDirectory: "unused",
    createHash,
    outputOffsets: { stdout: 0, stderr: 0 },
    outputSequences: { stdout: 0, stderr: 0 },
    posixStdoutClosed: false,
    posixStderrClosed: false,
    replayCapacityBytes: 256 * 1024,
    replayCapacityChunks: 16,
    retained: new Map(),
    retainedBytes: 0,
    stdout,
    writeAtomic: () => assert.fail("zero-length EOF probe must not publish output frames"),
  });
  vm.runInContext(`${extractNamedFunction(supervisorSource, "markPosixPipeClosed")}\n${extractNamedFunction(supervisorSource, "installPosixOutputLifecycle")}\n${extractNamedFunction(supervisorSource, "drainOutput")}`, context);
  vm.runInContext('installPosixOutputLifecycle("stdout", stdout); drainOutput("stdout", stdout, "unused")', context);
  assert.equal(zeroLengthReads, 1, "the readable-mode pump must explicitly advance a pending EOF when no bytes are buffered");
  assert.equal(vm.runInContext("posixStdoutClosed", context), true, "that EOF must retire the exact stdout pipe obligation");
});
test("C4 POSIX producer keeps the real channel unsettled until closed pipes drain a late tail", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-posix-c4-f1-channel-"));
  const nonce = "f1-closed-pipes";
  const workloadGroup = { groupId: 9002, leaderPid: 9002, leaderBirth: "anchor-birth" } as const;
  const channelDirectory = join(root, "channel");
  const channelOutputDirectory = join(channelDirectory, "output");
  const channelAckDirectory = join(channelDirectory, "ack");
  const statePath = join(root, "state.json");
  for (const path of [channelOutputDirectory, join(channelDirectory, "input"), channelAckDirectory]) mkdirSync(path, { recursive: true });
  writeFileSync(join(root, "fence.json"), JSON.stringify({ nonce, ...fence }));
  writeFileSync(join(root, "lock-holder.json"), JSON.stringify({ nonce, holderPid: 9001, holderBirth: "supervisor-birth" }));
  writeFileSync(join(channelDirectory, "output-checkpoint.json"), JSON.stringify({
    nonce,
    stdout: { sequence: 0, endOffset: 0 },
    stderr: { sequence: 0, endOffset: 0 },
  }));
  writeFileSync(join(root, "stdout.log"), "");
  writeFileSync(join(root, "stderr.log"), "");
  const publish = (status: string) => writeFileSync(statePath, JSON.stringify({ nonce, status }));
  publish("running");
  let lateStdout = Buffer.alloc(0);
  const stdout = {
    get readableLength() { return lateStdout.byteLength; },
    read(size: number) {
      if (lateStdout.byteLength === 0) return null;
      const bytes = lateStdout.subarray(0, size);
      lateStdout = lateStdout.subarray(bytes.byteLength);
      return bytes;
    },
  };
  const stderr = { get readableLength() { return 0; }, read: () => null };
  const supervisorSource = readFileSync(new URL("../src/portable-process-supervisor.mjs", import.meta.url), "utf8");
  let exits = 0;
  const context = vm.createContext({
    Array,
    Buffer,
    Date,
    Error,
    JSON,
    Map,
    Number,
    appendFileSync,
    createHash,
    channelAckDirectory,
    channelDirectory,
    channelOutputDirectory,
    child: { stdout, stderr },
    config: { directory: root, nonce, platform: "posix" },
    drainOutput: undefined,
    existsSync,
    handleChannelInput: () => undefined,
    handleControl: () => undefined,
    join,
    launchEffect: "started",
    outputOffsets: { stdout: 0, stderr: 0 },
    outputSequences: { stdout: 0, stderr: 0 },
    outputCheckpointPath: join(channelDirectory, "output-checkpoint.json"),
    posixAnchorExited: true,
    posixControlInspectionDeferred: false,
    posixControlInspectionFailures: 0,
    posixControlInspectionDetail: "",
    posixDeferredControlSignature: null,
    POSIX_CONTROL_INSPECTION_FAILURE_LIMIT: 3,
    posixAnchorReleaseRequested: false,
    posixForceControlApplied: true,
    posixStderrClosed: false,
    posixStdoutClosed: false,
    posixSupervisorBirth: "supervisor-birth",
    posixTerminalError: null,
    posixWorkloadGroup: workloadGroup,
    posixWorkloadRetirement: { state: "active" },
    process: { pid: 9001, exit: () => { exits += 1; } },
    publish,
    readCurrentFence: () => ({ nonce, ...fence }),
    readFileSync,
    readdirSync,
    refreshPosixChildStatus: () => undefined,
    replayCapacityBytes: 256 * 1024,
    replayCapacityChunks: 16,
    retained: new Map(),
    retainedBytes: 0,
    retirePortableOutputAcknowledgement,
    resumePortableOutputRetirement,
    stderrPath: join(root, "stderr.log"),
    stdoutPath: join(root, "stdout.log"),
    timer: "synthetic-timer",
    clearInterval: () => undefined,
    unlinkSync,
    withCurrentFenceEffect: (_ownerId: string, _fencingToken: number, effect: () => unknown) => ({ status: "applied", value: effect() }),
    writeAtomic: (path: string, value: string) => writeFileSync(path, value),
  });
  const pipeDrain = extractOptionalNamedFunction(supervisorSource, "posixOutputPipesDrained");
  vm.runInContext(`${extractNamedFunction(supervisorSource, "forgetRetiredOutput")}\n${extractNamedFunction(supervisorSource, "handleChannelAcks")}\n${extractNamedFunction(supervisorSource, "posixOutputSettled")}\n${extractNamedFunction(supervisorSource, "retirePosixWorkload")}\n${extractNamedFunction(supervisorSource, "markPosixPipeClosed")}\n${extractNamedFunction(supervisorSource, "drainOutput")}\n${pipeDrain}\n${extractTickPosix(supervisorSource)}`, context);
  const provider = createPortableProcessChannelProvider({
    replayCapacityChunks: 16,
    replayCapacityBytes: 256 * 1024,
    pollIntervalMs: 1,
    authority: () => ({
      directory: root,
      nonce,
      fence,
      reattest: () => "live" as const,
      effect: async <T>(_kind: "attach" | "write" | "close" | "signal" | "output_ack" | "ack_consume", effect: () => T): Promise<T> => effect(),
      snapshot: <T>(read: () => T) => ({ status: "applied" as const, value: read() }),
    }),
  });
  const earlyChannel = await provider.acquire(portableV2Binding(root, nonce, "supervisor-birth", workloadGroup), fence);
  const earlyUnsubscribe = earlyChannel.subscribeBackpressuredOutput(async (metadata) => metadata);
  let earlyDetached = false;
  const detachEarly = async () => {
    if (earlyDetached) return;
    earlyDetached = true;
    earlyUnsubscribe();
    await earlyChannel.detach();
  };
  try {
    vm.runInContext("retirePosixWorkload('force_terminate'); tickPosix()", context);
    assert.deepEqual(
      await earlyChannel.settleBackpressuredOutput?.(Date.now() + 100),
      { status: "blocked", reason: "deadline" },
      "the real portable settlement must remain blocked while the producer pipes are open, even with an empty snapshot",
    );
    await detachEarly();

    const delivered: Buffer[] = [];
    const outputChannel = await provider.acquire(portableV2Binding(root, nonce, "supervisor-birth", workloadGroup), fence);
    const outputUnsubscribe = outputChannel.subscribeBackpressuredOutput(async (metadata, bytes) => {
      delivered.push(Buffer.from(bytes));
      return metadata;
    });
    try {
      lateStdout = Buffer.from("late-tail");
      vm.runInContext("drainOutput('stdout', child.stdout, stdoutPath)", context);
      await waitForPosixLiveFixtureCondition(
        () => delivered.length === 1 && existsSync(join(channelAckDirectory, "stdout-000000000001.json")),
        Date.now() + 1_000,
        "late POSIX pipe tail did not reach the real backpressured sink and acknowledgement.",
      );
      assert.equal(Buffer.concat(delivered).toString("utf8"), "late-tail");
      vm.runInContext("handleChannelAcks()", context);
      assert.deepEqual(readdirSync(channelOutputDirectory), [], "the real ACK retirement must consume the durable tail exactly once");
      assert.deepEqual(readdirSync(channelAckDirectory), [], "the real ACK retirement must remove its acknowledgement exactly once");

      vm.runInContext("markPosixPipeClosed('stdout'); markPosixPipeClosed('stderr'); tickPosix()", context);
      assert.equal(JSON.parse(readFileSync(statePath, "utf8")).status, "stopped", "closed and drained pipes may now publish terminal stopped proof");
      assert.deepEqual(await outputChannel.settleBackpressuredOutput?.(Date.now() + 1_000), { status: "settled" });
      assert.equal(exits, 1, "the witness exits only after terminal proof and settled durable output");
    } finally {
      outputUnsubscribe();
      await outputChannel.detach();
    }
  } finally {
    await detachEarly();
    removeFixtureRoot(root);
  }
});

test("C4 POSIX producer drains a closed unread tail after backpressure before terminal proof", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-posix-c4-f1-closed-unread-"));
  const nonce = "f1-closed-unread";
  const workloadGroup = { groupId: 9002, leaderPid: 9002, leaderBirth: "anchor-birth" } as const;
  const channelDirectory = join(root, "channel");
  const channelOutputDirectory = join(channelDirectory, "output");
  const channelAckDirectory = join(channelDirectory, "ack");
  const statePath = join(root, "state.json");
  for (const path of [channelOutputDirectory, join(channelDirectory, "input"), channelAckDirectory]) mkdirSync(path, { recursive: true });
  writeFileSync(join(root, "fence.json"), JSON.stringify({ nonce, ...fence }));
  writeFileSync(join(root, "lock-holder.json"), JSON.stringify({ nonce, holderPid: 9001, holderBirth: "supervisor-birth" }));
  writeFileSync(join(channelDirectory, "output-checkpoint.json"), JSON.stringify({
    nonce,
    stdout: { sequence: 0, endOffset: 0 },
    stderr: { sequence: 0, endOffset: 0 },
  }));
  writeFileSync(join(root, "stdout.log"), "");
  writeFileSync(join(root, "stderr.log"), "");
  const publish = (status: string) => writeFileSync(statePath, JSON.stringify({ nonce, status }));
  publish("running");
  let stdoutBytes = Buffer.from("capacity-occupied");
  const stdout = {
    get readableLength() { return stdoutBytes.byteLength; },
    read(size: number) {
      if (stdoutBytes.byteLength === 0) return null;
      const bytes = stdoutBytes.subarray(0, size);
      stdoutBytes = stdoutBytes.subarray(bytes.byteLength);
      return bytes;
    },
  };
  const stderr = { get readableLength() { return 0; }, read: () => null };
  const supervisorSource = readFileSync(new URL("../src/portable-process-supervisor.mjs", import.meta.url), "utf8");
  let exits = 0;
  const context = vm.createContext({
    Array,
    Buffer,
    Date,
    Error,
    JSON,
    Map,
    Number,
    appendFileSync,
    createHash,
    channelAckDirectory,
    channelDirectory,
    channelOutputDirectory,
    child: { stdout, stderr },
    config: { directory: root, nonce, platform: "posix" },
    existsSync,
    handleChannelInput: () => undefined,
    handleControl: () => undefined,
    join,
    launchEffect: "started",
    outputOffsets: { stdout: 0, stderr: 0 },
    outputSequences: { stdout: 0, stderr: 0 },
    outputCheckpointPath: join(channelDirectory, "output-checkpoint.json"),
    posixAnchorExited: true,
    posixControlInspectionDeferred: false,
    posixControlInspectionFailures: 0,
    posixControlInspectionDetail: "",
    posixDeferredControlSignature: null,
    POSIX_CONTROL_INSPECTION_FAILURE_LIMIT: 3,
    posixAnchorReleaseRequested: false,
    posixForceControlApplied: true,
    posixStderrClosed: false,
    posixStdoutClosed: false,
    posixSupervisorBirth: "supervisor-birth",
    posixTerminalError: null,
    posixWorkloadGroup: workloadGroup,
    posixWorkloadRetirement: { state: "active" },
    process: { pid: 9001, exit: () => { exits += 1; } },
    publish,
    readCurrentFence: () => ({ nonce, ...fence }),
    readFileSync,
    readdirSync,
    refreshPosixChildStatus: () => undefined,
    replayCapacityBytes: 256 * 1024,
    replayCapacityChunks: 1,
    retained: new Map(),
    retainedBytes: 0,
    retirePortableOutputAcknowledgement,
    resumePortableOutputRetirement,
    stderrPath: join(root, "stderr.log"),
    stdoutPath: join(root, "stdout.log"),
    timer: "synthetic-timer",
    clearInterval: () => undefined,
    unlinkSync,
    withCurrentFenceEffect: (_ownerId: string, _fencingToken: number, effect: () => unknown) => ({ status: "applied", value: effect() }),
    writeAtomic: (path: string, value: string) => writeFileSync(path, value),
  });
  vm.runInContext(`${extractNamedFunction(supervisorSource, "forgetRetiredOutput")}\n${extractNamedFunction(supervisorSource, "handleChannelAcks")}\n${extractNamedFunction(supervisorSource, "posixOutputSettled")}\n${extractNamedFunction(supervisorSource, "posixOutputPipesDrained")}\n${extractNamedFunction(supervisorSource, "retirePosixWorkload")}\n${extractNamedFunction(supervisorSource, "markPosixPipeClosed")}\n${extractNamedFunction(supervisorSource, "drainOutput")}\n${extractTickPosix(supervisorSource)}`, context);
  const provider = createPortableProcessChannelProvider({
    replayCapacityChunks: 1,
    replayCapacityBytes: 256 * 1024,
    pollIntervalMs: 1,
    authority: () => ({
      directory: root,
      nonce,
      fence,
      reattest: () => "live" as const,
      effect: async <T>(_kind: "attach" | "write" | "close" | "signal" | "output_ack" | "ack_consume", effect: () => T): Promise<T> => effect(),
      snapshot: <T>(read: () => T) => ({ status: "applied" as const, value: read() }),
    }),
  });
  try {
    vm.runInContext("drainOutput('stdout', child.stdout, stdoutPath)", context);
    assert.equal(vm.runInContext("child.stdout.readableLength", context), 0, "the first durable chunk must fill the configured replay capacity");
    stdoutBytes = Buffer.from("closed-unread-tail");
    vm.runInContext("retirePosixWorkload('force_terminate'); markPosixPipeClosed('stdout'); markPosixPipeClosed('stderr'); tickPosix()", context);
    assert.equal(vm.runInContext("child.stdout.readableLength", context), Buffer.byteLength("closed-unread-tail"),
      "a full durable replay window must leave the closed pipe tail unread until an ACK frees capacity");
    assert.equal(JSON.parse(readFileSync(statePath, "utf8")).status, "running", "closed flags alone cannot publish terminal proof while pipe bytes remain unread");

    const earlyChannel = await provider.acquire(portableV2Binding(root, nonce, "supervisor-birth", workloadGroup), fence);
    let releaseEarly!: () => void;
    const earlyGate = new Promise<void>((resolve) => { releaseEarly = resolve; });
    const earlyDelivered: string[] = [];
    const unsubscribeEarly = earlyChannel.subscribeBackpressuredOutput(async (metadata, bytes) => {
      earlyDelivered.push(Buffer.from(bytes).toString("utf8"));
      await earlyGate;
      return metadata;
    });
    await waitForPosixLiveFixtureCondition(
      () => earlyDelivered.length === 1,
      Date.now() + 1_000,
      "the occupied durable chunk did not reach the real portable consumer",
    );
    assert.deepEqual(
      await earlyChannel.settleBackpressuredOutput?.(Date.now() + 100),
      { status: "blocked", reason: "deadline" },
      "the real channel must not settle while a closed pipe still contains unread bytes behind backpressure",
    );
    const earlyDetach = earlyChannel.detach();
    releaseEarly();
    await earlyDetach;
    unsubscribeEarly();
    assert.deepEqual(readdirSync(channelAckDirectory), [], "detaching the deadline observer must not manufacture an ACK that frees the producer capacity");

    const outputChannel = await provider.acquire(portableV2Binding(root, nonce, "supervisor-birth", workloadGroup), fence);
    let releaseOccupied!: () => void;
    const occupiedGate = new Promise<void>((resolve) => { releaseOccupied = resolve; });
    let releaseTail!: () => void;
    const tailGate = new Promise<void>((resolve) => { releaseTail = resolve; });
    let outputGatesReleased = false;
    const releaseOutputGates = () => {
      if (outputGatesReleased) return;
      outputGatesReleased = true;
      releaseOccupied();
      releaseTail();
    };
    const delivered: string[] = [];
    const unsubscribeOutput = outputChannel.subscribeBackpressuredOutput(async (metadata, bytes) => {
      const text = Buffer.from(bytes).toString("utf8");
      delivered.push(text);
      if (text === "capacity-occupied") await occupiedGate;
      if (text === "closed-unread-tail") await tailGate;
      return metadata;
    });
    try {
      await waitForPosixLiveFixtureCondition(
        () => delivered.includes("capacity-occupied"),
        Date.now() + 1_000,
        "the final real portable consumer did not observe the capacity-occupying chunk",
      );
      releaseOccupied();
      await waitForPosixLiveFixtureCondition(
        () => existsSync(join(channelAckDirectory, "stdout-000000000001.json")),
        Date.now() + 1_000,
        "the real consumer did not ACK the capacity-occupying durable chunk",
      );

      vm.runInContext("tickPosix()", context);
      const stateAfterCapacityFreed = JSON.parse(readFileSync(statePath, "utf8")) as { status: string };
      const retainedAfterCapacityFreed = vm.runInContext("retained.size", context) as number;
      const outputAfterCapacityFreed = readdirSync(channelOutputDirectory);
      assert.equal(stateAfterCapacityFreed.status, "stopped", `only the ACK-freed tick may publish stopped after it durably records the unread tail; retained=${retainedAfterCapacityFreed}, output=${outputAfterCapacityFreed.join(",")}`);
      assert.equal(retainedAfterCapacityFreed, 1, "the drained tail must remain retained until its own acknowledgement is retired");
      await waitForPosixLiveFixtureCondition(
        () => delivered.includes("closed-unread-tail"),
        Date.now() + 1_000,
        "the ACK-freed tick did not drain and deliver the closed pipe tail exactly once",
      );
      assert.deepEqual(delivered, ["capacity-occupied", "closed-unread-tail"], "the tail must be delivered only after capacity is actually freed");
      assert.equal(existsSync(join(channelAckDirectory, "stdout-000000000002.json")), false, "the blocked tail consumer must not fabricate its acknowledgement");
      assert.deepEqual(
        await outputChannel.settleBackpressuredOutput?.(Date.now() + 100),
        { status: "blocked", reason: "deadline" },
        "a stopped snapshot with the undelivered tail must remain unsettled in the real portable channel",
      );
      const outputDetach = outputChannel.detach();
      releaseOutputGates();
      await outputDetach;
      unsubscribeOutput();
      assert.equal(existsSync(join(channelAckDirectory, "stdout-000000000002.json")), false, "detaching the blocked tail observer must not create a tail ACK");

      const completionChannel = await provider.acquire(portableV2Binding(root, nonce, "supervisor-birth", workloadGroup), fence);
      const unsubscribeCompletion = completionChannel.subscribeBackpressuredOutput(async (metadata) => metadata);
      try {
        await waitForPosixLiveFixtureCondition(
          () => existsSync(join(channelAckDirectory, "stdout-000000000002.json")),
          Date.now() + 1_000,
          "the replacement real portable consumer did not acknowledge the drained tail",
        );
        vm.runInContext("tickPosix()", context);
        assert.equal(JSON.parse(readFileSync(statePath, "utf8")).status, "stopped", "tail acknowledgement retirement preserves the already-durable stopped proof");
        assert.deepEqual(await completionChannel.settleBackpressuredOutput?.(Date.now() + 1_000), { status: "settled" });
      } finally {
        unsubscribeCompletion();
        await completionChannel.detach();
      }
      assert.equal(exits, 1, "the witness exits only after the actual tail delivery and acknowledgement settle");
    } finally {
      releaseOutputGates();
      unsubscribeOutput();
      await outputChannel.detach();
    }
  } finally {
    removeFixtureRoot(root);
  }
});

test("C4 POSIX supervisor retires forced workload causally and waits for output ACK plus pipe closure", () => {
  const supervisorSource = readFileSync(new URL("../src/portable-process-supervisor.mjs", import.meta.url), "utf8");
  const workloadGroup = { groupId: 9002, leaderPid: 9002, leaderBirth: "anchor-birth" } as const;
  const request = { nonce: "forced-output", ownerId: "owner", fencingToken: 1, sequence: 1, action: "force_terminate" } as const;
  const metadata = { stream: "stdout", sequence: 1, startOffset: 0, endOffset: 4, byteLength: 4, digest: "d".repeat(64) } as const;
  const retained = new Map([["stdout-000000000001", metadata]]);
  const signals: Array<[number, NodeJS.Signals]> = [];
  const publications: Array<{ status: string; error?: string }> = [];
  let controlPresent = true;
  let acknowledgementPresent = false;
  let acknowledgementRetirements = 0;
  const acknowledgementListings: string[] = [];
  let groupMembers: number[] = [workloadGroup.leaderPid, 9003];
  let exits = 0;
  let intervalsCleared = 0;
  const context = vm.createContext({
    Array,
    child: { stdout: { readableLength: 0 }, stderr: { readableLength: 0 } },
    Error,
    JSON,
    Map,
    Number,
    PortableAuthorityUnavailableError: Error,
    channelAckDirectory: "root/channel/ack",
    channelDirectory: "root/channel",
    channelOutputDirectory: "root/channel/output",
    config: { directory: "root", nonce: request.nonce, platform: "posix" },
    controlPath: "root/control.json",
    fencePath: "root/fence.json",
    handledControl: 0,
    join,
    lockHolderPath: "root/lock-holder.json",
    posixAnchorExitCode: null,
    posixAnchorExited: false,
    posixControlInspectionDeferred: false,
    posixControlInspectionFailures: 0,
    posixControlInspectionDetail: "",
    posixDeferredControlSignature: null,
    POSIX_CONTROL_INSPECTION_FAILURE_LIMIT: 3,
    posixAnchorExitSignal: null,
    posixAnchorReleaseAuthority: null,
    posixAnchorReleaseRequested: false,
    posixChildReleasedAnchorRelease: null,
    posixForceControlApplied: false,
    posixOutputSettled: undefined,
    posixStderrClosed: false,
    posixStdoutClosed: false,
    posixSupervisorBirth: "supervisor-birth",
    posixTerminalError: null,
    posixWorkloadGroup: workloadGroup,
    posixWorkloadRetirement: { state: "active" },
    process: {
      pid: 9001,
      exit: () => { exits += 1; },
      kill: (pid: number, signal: NodeJS.Signals) => {
        signals.push([pid, signal]);
        if (pid === -workloadGroup.groupId && signal === "SIGKILL") groupMembers = [];
      },
    },
    publish: (status: string, error?: string) => { publications.push({ status, error }); },
    reattestOwnedPosixAnchor: () => ({ state: "ready", members: [...groupMembers] }),
    readFileSync: (path: string) => {
      const normalized = path.replace(/\\/g, "/");
      if (normalized === "root/control.json") return JSON.stringify(request);
      if (normalized === "root/fence.json") return JSON.stringify({ nonce: request.nonce, ownerId: request.ownerId, fencingToken: request.fencingToken });
      if (normalized === "root/lock-holder.json") return JSON.stringify({ nonce: request.nonce, holderPid: 9001, holderBirth: "supervisor-birth" });
      if (normalized === "root/channel/ack/stdout-000000000001.json")
        return JSON.stringify({ nonce: request.nonce, ownerId: request.ownerId, fencingToken: request.fencingToken, metadata });
      throw new Error(`unexpected synthetic read ${path}`);
    },
    readdirSync: (path: string) => {
      const normalized = path.replace(/\\/g, "/");
      if (normalized === "root/channel/ack") {
        acknowledgementListings.push(`ack:${acknowledgementPresent}`);
        return acknowledgementPresent ? ["stdout-000000000001.json"] : [];
      }
      if (normalized === "root/channel/output") return [];
      throw new Error(`unexpected synthetic listing ${path}`);
    },
    retained,
    retainedBytes: metadata.byteLength,
    retirePortableOutputAcknowledgement: () => { acknowledgementRetirements += 1; acknowledgementPresent = false; },
    resumePortableOutputRetirement: () => undefined,
    runPortableFenceEffectSync: (options: { effect: () => unknown }) => ({ status: "applied", value: options.effect() }),
    settlePortableSupervisorCommand,
    signalOwnedPosixGroup,
    listOwnedPosixGroupMembers: () => [...groupMembers],
    existsSync: (path: string) => path.replace(/\\/g, "/") === "root/control.json" ? controlPresent : false,
    unlinkSync: () => { controlPresent = false; },
    handleChannelInput: () => undefined,
    drainOutput: () => undefined,
    refreshPosixChildStatus: () => undefined,
    timer: "synthetic-timer",
    clearInterval: () => { intervalsCleared += 1; },
    targetExited: false,
    targetExitCode: null,
    targetSignal: null,
    outputCheckpointPath: "root/channel/output-checkpoint.json",
    stderrPath: "root/stderr.log",
    stdoutPath: "root/stdout.log",
    writeAtomic: () => undefined,
  });
  vm.runInContext(`${extractNamedFunction(supervisorSource, "readCurrentFence")}\n${extractNamedFunction(supervisorSource, "readCurrentFenceStrict")}\n${extractFenceEffectFunctions(supervisorSource)}\n${extractNamedFunction(supervisorSource, "completeControl")}\n${extractNamedFunction(supervisorSource, "handleControl")}\n${extractNamedFunction(supervisorSource, "forgetRetiredOutput")}\n${extractNamedFunction(supervisorSource, "handleChannelAcks")}\n${extractNamedFunction(supervisorSource, "posixOutputSettled")}\n${extractNamedFunction(supervisorSource, "posixOutputPipesDrained")}\n${extractNamedFunction(supervisorSource, "hasCausalPosixAnchorRelease")}\n${extractNamedFunction(supervisorSource, "retirePosixWorkload")}\n${extractNamedFunction(supervisorSource, "markPosixPipeClosed")}\n${extractNamedFunction(supervisorSource, "handlePosixAnchorExit")}\n${extractTickPosix(supervisorSource)}`, context);

  vm.runInContext("handleControl()", context);
  assert.deepEqual(signals, [[-workloadGroup.groupId, "SIGKILL"]], "the only forced signal targets the detached workload group");
  assert.equal(vm.runInContext("posixForceControlApplied", context), true);
  vm.runInContext("handlePosixAnchorExit(null, 'SIGKILL'); tickPosix()", context);
  assert.deepEqual(JSON.parse(vm.runInContext("JSON.stringify(posixWorkloadRetirement)", context)), {
    state: "retired", cause: "force_terminate", at: JSON.parse(vm.runInContext("JSON.stringify(posixWorkloadRetirement)", context)).at,
  });
  assert.equal(publications.at(-1)?.status, "running", "causal retirement is durable, but terminal stopped proof waits for closed and drained pipes");
  assert.equal(exits, 0, "the supervisor witness must survive while output is buffered and pipes remain open");

  vm.runInContext("tickPosix()", context);
  assert.equal(exits, 0, "a later retained-workload tick must still wait for both pipe closures and output ACK settlement");

  vm.runInContext("markPosixPipeClosed('stdout'); markPosixPipeClosed('stderr')", context);
  acknowledgementPresent = true;
  vm.runInContext("tickPosix()", context);
  assert.equal(acknowledgementRetirements, 1, `the supervisor must run the ACK retirement effect before considering output settled; listings=${acknowledgementListings.join(",")}`);
  assert.equal(retained.size, 0, "the actual ACK handler must retire the buffered output before supervisor exit");
  assert.equal(publications.at(-1)?.status, "stopped", "only closed and drained pipes may publish terminal stopped proof");
  assert.equal(exits, 1, "the supervisor exits only after causal retirement, ACK settlement, and both pipe closures");
  assert.equal(intervalsCleared, 1);
});

test("C4 POSIX supervisor releases an exact lone anchor only after executable exit and retains ACK lifetime", () => {
  const supervisorSource = readFileSync(new URL("../src/portable-process-supervisor.mjs", import.meta.url), "utf8");
  const workloadGroup = { groupId: 9002, leaderPid: 9002, leaderBirth: "anchor-birth" } as const;
  const nonce = "natural-anchor-release";
  const writes: Array<{ path: string; value: unknown }> = [];
  const publications: Array<{ status: string; error?: string }> = [];
  let groupMembers = [workloadGroup.leaderPid];
  let anchorRelease: Record<string, unknown> | undefined;
  let childStatus: Record<string, unknown> = {
    protocol: "aiboard-portable-process/v2-posix-child",
    nonce,
    status: "prepared",
    workloadGroup,
  };
  let exits = 0;
  let intervalsCleared = 0;
  let receiptPromotionAttempts = 0;
  const context = vm.createContext({
    Array,
    child: { stdout: { readableLength: 0 }, stderr: { readableLength: 0 } },
    Error,
    JSON,
    Map,
    Number,
    PortableAuthorityUnavailableError: Error,
    anchorReleasePath: "root/anchor-release.json",
    channelAckDirectory: "root/channel/ack",
    channelDirectory: "root/channel",
    channelOutputDirectory: "root/channel/output",
    childStatusPath: "root/child-status.json",
    config: { directory: "root", nonce, platform: "posix" },
    fencePath: "root/fence.json",
    handleChannelAcks: () => undefined,
    handleChannelInput: () => undefined,
    handleControl: () => undefined,
    join,
    launchEffect: "started",
    listOwnedPosixGroupMembers: () => [...groupMembers],
    lockHolderPath: "root/lock-holder.json",
    posixAnchorExited: false,
    posixControlInspectionDeferred: false,
    posixControlInspectionFailures: 0,
    posixControlInspectionDetail: "",
    posixDeferredControlSignature: null,
    POSIX_CONTROL_INSPECTION_FAILURE_LIMIT: 3,
    posixAnchorExitCode: null,
    posixAnchorExitSignal: null,
    posixAnchorReleaseAuthority: null,
    posixAnchorReleaseRequested: false,
    posixChildReleasedAnchorRelease: null,
    posixChildStatusSignature: undefined,
    posixForceControlApplied: false,
    posixStderrClosed: false,
    posixStdoutClosed: false,
    posixSupervisorBirth: "supervisor-birth",
    posixTerminalError: null,
    posixWorkloadGroup: workloadGroup,
    posixWorkloadRetirement: { state: "active" },
    process: { pid: 9001, exit: () => { exits += 1; } },
    publish: (status: string, error?: string) => { publications.push({ status, error }); },
    reattestOwnedPosixAnchor: () => ({ state: "ready", members: [...groupMembers] }),
    readFileSync: (path: string) => {
      const normalized = path.replace(/\\/g, "/");
      if (normalized === "root/fence.json") return JSON.stringify({ nonce, ownerId: "owner", fencingToken: 1 });
      if (normalized === "root/lock-holder.json") return JSON.stringify({ nonce, holderPid: 9001, holderBirth: "supervisor-birth" });
      if (normalized === "root/child-status.json") return JSON.stringify(childStatus);
      if (normalized === "root/anchor-release.json" && anchorRelease) return JSON.stringify(anchorRelease);
      throw new Error(`unexpected synthetic read ${path}`);
    },
    readdirSync: (path: string) => {
      const normalized = path.replace(/\\/g, "/");
      if (normalized === "root/channel/output" || normalized === "root/channel/ack") return [];
      throw new Error(`unexpected synthetic listing ${path}`);
    },
    retained: new Map(),
    runPortableFenceEffectSync: (options: { effect: () => unknown }) => {
      if ((childStatus as { status?: unknown }).status === "released") {
        receiptPromotionAttempts += 1;
        if (receiptPromotionAttempts === 1) {
          return { status: "unavailable", cause: "coordination", error: new Error("synthetic receipt lock contention") };
        }
      }
      return { status: "applied", value: options.effect() };
    },
    isExactPosixAnchorRelease,
    stdoutPath: "root/stdout.log",
    stderrPath: "root/stderr.log",
    targetExited: true,
    targetExitCode: 0,
    targetSignal: null,
    timer: "synthetic-timer",
    clearInterval: () => { intervalsCleared += 1; },
    drainOutput: () => undefined,
    writeAtomic: (path: string, value: string) => {
      const parsed = JSON.parse(value) as Record<string, unknown>;
      writes.push({ path, value: parsed });
      if (path.replace(/\\/g, "/") === "root/anchor-release.json") anchorRelease = parsed;
    },
    existsSync: () => false,
  });
  vm.runInContext(`${extractNamedFunction(supervisorSource, "samePosixWorkloadGroup")}\n${extractNamedFunction(supervisorSource, "readJson")}\n${extractNamedFunction(supervisorSource, "readPosixChildStatus")}\n${extractNamedFunction(supervisorSource, "refreshPosixChildStatus")}\n${extractNamedFunction(supervisorSource, "readCurrentFence")}\n${extractNamedFunction(supervisorSource, "readCurrentFenceStrict")}\n${extractFenceEffectFunctions(supervisorSource)}\n${extractNamedFunction(supervisorSource, "samePosixFenceAuthority")}\n${extractNamedFunction(supervisorSource, "hasCurrentPosixAnchorReleaseAuthority")}\n${extractNamedFunction(supervisorSource, "recordCausalPosixAnchorRelease")}\n${extractNamedFunction(supervisorSource, "hasCausalPosixAnchorRelease")}\n${extractNamedFunction(supervisorSource, "requestPosixAnchorRelease")}\n${extractNamedFunction(supervisorSource, "retirePosixWorkload")}\n${extractNamedFunction(supervisorSource, "posixOutputSettled")}\n${extractNamedFunction(supervisorSource, "posixOutputPipesDrained")}\n${extractNamedFunction(supervisorSource, "markPosixPipeClosed")}\n${extractNamedFunction(supervisorSource, "handlePosixAnchorExit")}\n${extractTickPosix(supervisorSource)}`, context);

  vm.runInContext("tickPosix()", context);
  assert.deepEqual(writes.map(({ path, value }) => ({ path, value: typeof value === "string" ? JSON.parse(value) : JSON.parse(JSON.stringify(value)) })), [{
    path: "root/anchor-release.json",
    value: {
      protocol: "aiboard-portable-process/v2-posix-anchor-release",
      nonce,
      supervisorPid: 9001,
      supervisorBirth: "supervisor-birth",
      ownerId: "owner",
      fencingToken: 1,
      workloadGroup,
    },
  }]);
  assert.equal(vm.runInContext("posixAnchorReleaseRequested", context), true);
  assert.equal(exits, 0, "the supervisor must remain alive after requesting anchor release");

  const expectedSupervisor = { supervisorPid: 9001, supervisorBirth: "supervisor-birth" } as const;
  const childSource = readFileSync(new URL("../src/portable-process-child.mjs", import.meta.url), "utf8");
  const childContext = vm.createContext({
    Error,
    JSON,
    config: {
      anchorReleasePath: "root/anchor-release.json",
      fenceLockPath: "root/.fence.lock",
      fencePath: "root/fence.json",
      lockHolderPath: "root/lock-holder.json",
      nonce,
      statusPath: "root/child-status.json",
    },
    expectedSupervisor,
    inspectPosixProcessIdentity: (pid: number) => pid === expectedSupervisor.supervisorPid
      ? { state: "present", value: { pid, groupId: pid, birth: expectedSupervisor.supervisorBirth } }
      : { state: "absent" },
    isExactPosixAnchorRelease,
    process: { pid: workloadGroup.leaderPid },
    publishAtomic: (_path: string, value: Record<string, unknown>) => { childStatus = value; },
    readFileSync: (path: string) => {
      if (path === "root/anchor-release.json" && anchorRelease) return JSON.stringify(anchorRelease);
      if (path === "root/fence.json") return JSON.stringify({ nonce, ownerId: "owner", fencingToken: 1 });
      if (path === "root/lock-holder.json") return JSON.stringify({ nonce, holderPid: 9001, holderBirth: "supervisor-birth" });
      throw new Error(`unexpected child synthetic read ${path}`);
    },
    runPortableFenceEffectSync: (options: { expectedFence: { ownerId: string; fencingToken: number }; readCurrentFence: () => { ownerId: string; fencingToken: number }; effect: () => unknown }) => {
      const current = options.readCurrentFence();
      if (current.ownerId !== options.expectedFence.ownerId || current.fencingToken !== options.expectedFence.fencingToken)
        return { status: "stale" };
      return { status: "applied", value: options.effect() };
    },
    workloadGroup,
  });
  vm.runInContext(`${extractNamedFunction(childSource, "readJson")}\n${extractNamedFunction(childSource, "readCurrentPosixFence")}\n${extractNamedFunction(childSource, "readAnchorReleaseFence")}\n${extractNamedFunction(childSource, "consumeExactPosixAnchorRelease")}\n${extractNamedFunction(childSource, "publishPosixStatus")}`, childContext);
  assert.equal(vm.runInContext("consumeExactPosixAnchorRelease(workloadGroup, expectedSupervisor)", childContext), true);
  assert.deepEqual(JSON.parse(JSON.stringify(childStatus)), {
    protocol: "aiboard-portable-process/v2-posix-child",
    nonce,
    status: "released",
    workloadGroup,
    anchorRelease,
  }, "the actual child fence effect must publish the consumed exact marker before its clean exit");
  groupMembers = [];
  vm.runInContext("handlePosixAnchorExit(0, null); tickPosix()", context);
  assert.equal(receiptPromotionAttempts, 1, "the first durable receipt join is intentionally coordination-blocked");
  assert.equal(vm.runInContext("posixChildReleasedAnchorRelease", context), null,
    "a coordination miss must not fabricate receipt promotion");
  assert.deepEqual(JSON.parse(vm.runInContext("JSON.stringify(posixWorkloadRetirement)", context)), { state: "active" },
    "anchor exit must remain pending while exact receipt observation is retryable");
  assert.equal(publications.at(-1)?.status, "running", "retryable receipt observation must not become outcome_unknown");

  vm.runInContext("tickPosix()", context);
  assert.equal(receiptPromotionAttempts, 2, "the unchanged released-child receipt must be retried after coordination contention");
  assert.deepEqual(JSON.parse(vm.runInContext("JSON.stringify(posixChildReleasedAnchorRelease)", context)), anchorRelease);
  const retirement = JSON.parse(vm.runInContext("JSON.stringify(posixWorkloadRetirement)", context));
  assert.equal(retirement.state, "retired");
  assert.equal(retirement.cause, "anchor_release");
  assert.equal(exits, 0, "workload retirement alone does not settle output or end the witness");

  vm.runInContext("markPosixPipeClosed('stdout'); markPosixPipeClosed('stderr'); tickPosix()", context);
  assert.equal(exits, 1);
  assert.equal(intervalsCleared, 1);
  assert.ok(publications.some(({ status }) => status === "stopped"));
});

test("C4 POSIX tick keeps an exact in-flight release running when the leader disappears before the exit event", () => {
  const supervisorSource = readFileSync(new URL("../src/portable-process-supervisor.mjs", import.meta.url), "utf8");
  const workloadGroup = { groupId: 9002, leaderPid: 9002, leaderBirth: "anchor-birth" } as const;
  const publications: Array<{ status: string; error?: string }> = [];
  const context = vm.createContext({
    Error, JSON, Number, PortableAuthorityUnavailableError: Error,
    child: { stdout: {}, stderr: {} },
    config: { directory: "root", nonce: "ubuntu-release-race", platform: "posix" },
    fencePath: "root/fence.json", lockHolderPath: "root/lock-holder.json", join,
    handleChannelAcks: () => undefined, handleChannelInput: () => undefined, handleControl: () => undefined,
    drainOutput: () => undefined, refreshPosixChildStatus: () => "unchanged",
    launchEffect: "started",
    posixAnchorExited: false,
    posixControlInspectionDeferred: false, posixControlInspectionFailures: 0, posixControlInspectionDetail: "",
    posixDeferredControlSignature: null, POSIX_CONTROL_INSPECTION_FAILURE_LIMIT: 3,
    posixForceControlApplied: false,
    posixAnchorReleaseRequested: true,
    posixAnchorReleaseAuthority: { ownerId: "owner", fencingToken: 1 },
    posixChildReleasedAnchorRelease: null,
    posixSupervisorBirth: "supervisor-birth", posixTerminalError: null,
    posixWorkloadGroup: workloadGroup, posixWorkloadRetirement: { state: "active" },
    process: { pid: 9001 },
    publish: (status: string, error?: string) => { publications.push({ status, error }); },
    reattestOwnedPosixAnchor: () => ({ state: "outcome_unknown" }),
    readFileSync: (path: string) => {
      const normalized = path.replace(/\\/g, "/");
      if (normalized === "root/fence.json") return JSON.stringify({ nonce: "ubuntu-release-race", ownerId: "owner", fencingToken: 1 });
      if (normalized === "root/lock-holder.json") return JSON.stringify({ nonce: "ubuntu-release-race", holderPid: 9001, holderBirth: "supervisor-birth" });
      throw new Error(`unexpected synthetic read ${path}`);
    },
    stdoutPath: "root/stdout.log", stderrPath: "root/stderr.log",
  });
  vm.runInContext(`${extractNamedFunction(supervisorSource, "readCurrentFence")}\n${extractNamedFunction(supervisorSource, "readCurrentFenceStrict")}\n${extractFenceEffectFunctions(supervisorSource)}\n${extractNamedFunction(supervisorSource, "samePosixFenceAuthority")}\n${extractNamedFunction(supervisorSource, "hasCurrentPosixAnchorReleaseAuthority")}\n${extractTickPosix(supervisorSource)}`, context);
  vm.runInContext("tickPosix()", context);
  assert.equal(publications.at(-1)?.status, "running",
    "a blocking reattest that loses a released leader must wait for the pending Node exit event, not publish outcome_unknown");
  assert.equal(publications.some(({ status }) => status === "outcome_unknown"), false);
  assert.equal(vm.runInContext("posixWorkloadRetirement.state", context), "active",
    "retirement still requires the later causal exit observation");
});

test("C4 POSIX tick waits for the pending exit after an exact consumed release receipt", () => {
  const supervisorSource = readFileSync(new URL("../src/portable-process-supervisor.mjs", import.meta.url), "utf8");
  const workloadGroup = { groupId: 9002, leaderPid: 9002, leaderBirth: "anchor-birth" } as const;
  const receipt = {
    protocol: "aiboard-portable-process/v2-posix-anchor-release",
    nonce: "ubuntu-release-receipt",
    supervisorPid: 9001,
    supervisorBirth: "supervisor-birth",
    ownerId: "owner",
    fencingToken: 1,
    workloadGroup,
  } as const;
  const publications: Array<{ status: string; error?: string }> = [];
  const context = vm.createContext({
    Error, JSON, Number, PortableAuthorityUnavailableError: Error,
    child: { stdout: {}, stderr: {} },
    config: { directory: "root", nonce: "ubuntu-release-receipt", platform: "posix" },
    fencePath: "root/fence.json", lockHolderPath: "root/lock-holder.json", join,
    handleChannelAcks: () => undefined, handleChannelInput: () => undefined, handleControl: () => undefined,
    drainOutput: () => undefined, refreshPosixChildStatus: () => "updated",
    launchEffect: "started",
    posixAnchorExited: false,
    posixControlInspectionDeferred: false, posixControlInspectionFailures: 0, posixControlInspectionDetail: "",
    posixDeferredControlSignature: null, POSIX_CONTROL_INSPECTION_FAILURE_LIMIT: 3,
    posixForceControlApplied: false,
    posixAnchorReleaseRequested: true,
    posixAnchorReleaseAuthority: { ownerId: "owner", fencingToken: 1 },
    posixChildReleasedAnchorRelease: receipt,
    posixSupervisorBirth: "supervisor-birth", posixTerminalError: null,
    posixWorkloadGroup: workloadGroup, posixWorkloadRetirement: { state: "active" },
    process: { pid: 9001 },
    publish: (status: string, error?: string) => { publications.push({ status, error }); },
    reattestOwnedPosixAnchor: () => ({ state: "outcome_unknown" }),
    readFileSync: (path: string) => {
      const normalized = path.replace(/\\/g, "/");
      if (normalized === "root/fence.json") return JSON.stringify({ nonce: "ubuntu-release-receipt", ownerId: "owner", fencingToken: 1 });
      if (normalized === "root/lock-holder.json") return JSON.stringify({ nonce: "ubuntu-release-receipt", holderPid: 9001, holderBirth: "supervisor-birth" });
      throw new Error(`unexpected synthetic read ${path}`);
    },
    stdoutPath: "root/stdout.log", stderrPath: "root/stderr.log",
  });
  vm.runInContext(`${extractNamedFunction(supervisorSource, "readCurrentFence")}\n${extractNamedFunction(supervisorSource, "readCurrentFenceStrict")}\n${extractFenceEffectFunctions(supervisorSource)}\n${extractNamedFunction(supervisorSource, "samePosixFenceAuthority")}\n${extractNamedFunction(supervisorSource, "hasCurrentPosixAnchorReleaseAuthority")}\n${extractTickPosix(supervisorSource)}`, context);
  vm.runInContext("tickPosix()", context);
  assert.equal(publications.at(-1)?.status, "running");
  assert.equal(publications.some(({ status }) => status === "outcome_unknown"), false,
    "an exact consumed receipt must not be overwritten by a same-tick unavailable reattest");
});

test("C4 POSIX tick still fails closed for identity mismatch, foreign fence, and unproven startup during release", () => {
  const supervisorSource = readFileSync(new URL("../src/portable-process-supervisor.mjs", import.meta.url), "utf8");
  const workloadGroup = { groupId: 9002, leaderPid: 9002, leaderBirth: "anchor-birth" } as const;

  function tickWith(overrides: Record<string, unknown>) {
    const publications: Array<{ status: string; error?: string }> = [];
    const context = vm.createContext({
      Error, JSON, Number, PortableAuthorityUnavailableError: Error,
      child: { stdout: {}, stderr: {} },
      config: { directory: "root", nonce: "ubuntu-release-negatives", platform: "posix" },
      fencePath: "root/fence.json", lockHolderPath: "root/lock-holder.json", join,
      handleChannelAcks: () => undefined, handleChannelInput: () => undefined, handleControl: () => undefined,
      drainOutput: () => undefined, refreshPosixChildStatus: () => "unchanged",
      launchEffect: "started",
      posixAnchorExited: false,
      posixControlInspectionDeferred: false, posixControlInspectionFailures: 0, posixControlInspectionDetail: "",
      posixDeferredControlSignature: null, POSIX_CONTROL_INSPECTION_FAILURE_LIMIT: 3,
      posixForceControlApplied: false,
      posixAnchorReleaseRequested: true,
      posixAnchorReleaseAuthority: { ownerId: "owner", fencingToken: 1 },
      posixChildReleasedAnchorRelease: null,
      posixSupervisorBirth: "supervisor-birth", posixTerminalError: null,
      posixWorkloadGroup: workloadGroup, posixWorkloadRetirement: { state: "active" },
      process: { pid: 9001 },
      publish: (status: string, error?: string) => { publications.push({ status, error }); },
      reattestOwnedPosixAnchor: () => ({ state: "outcome_unknown" }),
      readFileSync: (path: string) => {
        const normalized = path.replace(/\\/g, "/");
        if (normalized === "root/fence.json") return JSON.stringify({ nonce: "ubuntu-release-negatives", ownerId: "owner", fencingToken: 1 });
        if (normalized === "root/lock-holder.json") return JSON.stringify({ nonce: "ubuntu-release-negatives", holderPid: 9001, holderBirth: "supervisor-birth" });
        throw new Error(`unexpected synthetic read ${path}`);
      },
      stdoutPath: "root/stdout.log", stderrPath: "root/stderr.log",
      ...overrides,
    });
    vm.runInContext(`${extractNamedFunction(supervisorSource, "readCurrentFence")}\n${extractNamedFunction(supervisorSource, "readCurrentFenceStrict")}\n${extractFenceEffectFunctions(supervisorSource)}\n${extractNamedFunction(supervisorSource, "samePosixFenceAuthority")}\n${extractNamedFunction(supervisorSource, "hasCurrentPosixAnchorReleaseAuthority")}\n${extractTickPosix(supervisorSource)}`, context);
    vm.runInContext("tickPosix()", context);
    return publications.at(-1);
  }

  const mismatch = tickWith({ reattestOwnedPosixAnchor: () => ({ state: "identity_mismatch" }) });
  assert.equal(mismatch?.status, "outcome_unknown");
  assert.match(mismatch?.error ?? "", /birth or group identity changed/);

  const foreign = tickWith({
    posixAnchorReleaseAuthority: { ownerId: "owner", fencingToken: 1 },
    readFileSync: (path: string) => {
      const normalized = path.replace(/\\/g, "/");
      if (normalized === "root/fence.json") return JSON.stringify({ nonce: "ubuntu-release-negatives", ownerId: "takeover", fencingToken: 2 });
      if (normalized === "root/lock-holder.json") return JSON.stringify({ nonce: "ubuntu-release-negatives", holderPid: 9001, holderBirth: "supervisor-birth" });
      throw new Error(`unexpected synthetic read ${path}`);
    },
  });
  assert.equal(foreign?.status, "outcome_unknown");
  assert.match(foreign?.error ?? "", /identity or group membership is unavailable/);

  const unproven = tickWith({
    launchEffect: "unknown",
    posixAnchorReleaseRequested: false,
    posixAnchorReleaseAuthority: null,
  });
  assert.equal(unproven?.status, "outcome_unknown");
  assert.match(unproven?.error ?? "", /startup was never proven/);

  const lost = tickWith({
    posixAnchorReleaseRequested: false,
    posixAnchorReleaseAuthority: null,
  });
  assert.equal(lost?.status, "outcome_unknown");
  assert.match(lost?.error ?? "", /identity or group membership is unavailable/);
});

test("C4 POSIX supervisor refuses anchor release when membership changes inside its fence", () => {
  const supervisorSource = readFileSync(new URL("../src/portable-process-supervisor.mjs", import.meta.url), "utf8");
  const workloadGroup = { groupId: 9002, leaderPid: 9002, leaderBirth: "anchor-birth" } as const;
  const nonce = "anchor-release-race";
  const writes: Array<{ path: string; value: string }> = [];
  const publications: Array<{ status: string; error?: string }> = [];
  let reattestations = 0;
  const context = vm.createContext({
    child: { stdout: { readableLength: 0 }, stderr: { readableLength: 0 } },
    Error,
    JSON,
    Number,
    PortableAuthorityUnavailableError: Error,
    anchorReleasePath: "root/anchor-release.json",
    channelAckDirectory: "root/channel/ack",
    channelDirectory: "root/channel",
    channelOutputDirectory: "root/channel/output",
    config: { directory: "root", nonce, platform: "posix" },
    fencePath: "root/fence.json",
    handleChannelAcks: () => undefined,
    handleChannelInput: () => undefined,
    handleControl: () => undefined,
    join,
    launchEffect: "started",
    lockHolderPath: "root/lock-holder.json",
    posixAnchorExited: false,
    posixControlInspectionDeferred: false,
    posixControlInspectionFailures: 0,
    posixControlInspectionDetail: "",
    posixDeferredControlSignature: null,
    POSIX_CONTROL_INSPECTION_FAILURE_LIMIT: 3,
    posixAnchorReleaseAuthority: null,
    posixAnchorReleaseRequested: false,
    posixForceControlApplied: false,
    posixStderrClosed: false,
    posixStdoutClosed: false,
    posixSupervisorBirth: "supervisor-birth",
    posixTerminalError: null,
    posixWorkloadGroup: workloadGroup,
    posixWorkloadRetirement: { state: "active" },
    process: { pid: 9001, exit: () => assert.fail("release-race work remains observable") },
    publish: (status: string, error?: string) => { publications.push({ status, error }); },
    reattestOwnedPosixAnchor: () => {
      reattestations += 1;
      return { state: "ready", members: reattestations === 1 ? [workloadGroup.leaderPid] : [workloadGroup.leaderPid, 9003] };
    },
    readFileSync: (path: string) => {
      const normalized = path.replace(/\\/g, "/");
      if (normalized === "root/fence.json") return JSON.stringify({ nonce, ownerId: "owner", fencingToken: 1 });
      if (normalized === "root/lock-holder.json") return JSON.stringify({ nonce, holderPid: 9001, holderBirth: "supervisor-birth" });
      throw new Error(`unexpected synthetic read ${path}`);
    },
    readdirSync: (path: string) => {
      const normalized = path.replace(/\\/g, "/");
      if (normalized === "root/channel/output" || normalized === "root/channel/ack") return [];
      throw new Error(`unexpected synthetic listing ${path}`);
    },
    retained: new Map(),
    runPortableFenceEffectSync: (options: { effect: () => unknown }) => ({ status: "applied", value: options.effect() }),
    stdoutPath: "root/stdout.log",
    stderrPath: "root/stderr.log",
    targetExited: true,
    targetExitCode: 0,
    targetSignal: null,
    timer: "synthetic-timer",
    clearInterval: () => assert.fail("release-race work must retain the supervisor"),
    drainOutput: () => undefined,
    refreshPosixChildStatus: () => undefined,
    writeAtomic: (path: string, value: string) => { writes.push({ path, value }); },
    existsSync: () => false,
  });
  vm.runInContext(`${extractNamedFunction(supervisorSource, "readCurrentFence")}\n${extractNamedFunction(supervisorSource, "readCurrentFenceStrict")}\n${extractFenceEffectFunctions(supervisorSource)}\n${extractNamedFunction(supervisorSource, "samePosixFenceAuthority")}\n${extractNamedFunction(supervisorSource, "hasCurrentPosixAnchorReleaseAuthority")}\n${extractNamedFunction(supervisorSource, "requestPosixAnchorRelease")}\n${extractNamedFunction(supervisorSource, "posixOutputPipesDrained")}\n${extractTickPosix(supervisorSource)}`, context);

  vm.runInContext("tickPosix()", context);
  assert.equal(reattestations, 2, "the exact anchor must be observed again inside the release fence");
  assert.deepEqual(writes, [], "a descendant that appears inside the fence must block release publication");
  assert.equal(vm.runInContext("posixAnchorReleaseRequested", context), false);
  assert.equal(publications.at(-1)?.status, "outcome_unknown");
});

test("C4 POSIX supervisor retries transient inner anchor inspection while publishing release", () => {
  const supervisorSource = readFileSync(new URL("../src/portable-process-supervisor.mjs", import.meta.url), "utf8");
  const workloadGroup = { groupId: 9002, leaderPid: 9002, leaderBirth: "anchor-birth" } as const;
  const nonce = "anchor-release-inner-inspection-retry";
  const writes: Array<{ path: string; value: unknown }> = [];
  const publications: Array<{ status: string; error?: string }> = [];
  let reattestations = 0;
  const context = vm.createContext({
    child: { stdout: { readableLength: 0 }, stderr: { readableLength: 0 } },
    Error, JSON, Number, PortableAuthorityUnavailableError: Error,
    anchorReleasePath: "root/anchor-release.json", channelAckDirectory: "root/channel/ack", channelDirectory: "root/channel", channelOutputDirectory: "root/channel/output",
    config: { directory: "root", nonce, platform: "posix" }, fencePath: "root/fence.json", lockHolderPath: "root/lock-holder.json", join,
    handleChannelAcks: () => undefined, handleChannelInput: () => undefined, handleControl: () => undefined, launchEffect: "started",
    posixAnchorExited: false, posixControlInspectionDeferred: false, posixControlInspectionFailures: 0, posixControlInspectionDetail: "", posixDeferredControlSignature: null, POSIX_CONTROL_INSPECTION_FAILURE_LIMIT: 3,
    posixAnchorReleaseAuthority: null, posixAnchorReleaseRequested: false, posixForceControlApplied: false, posixStderrClosed: false, posixStdoutClosed: false,
    posixSupervisorBirth: "supervisor-birth", posixTerminalError: null, posixWorkloadGroup: workloadGroup, posixWorkloadRetirement: { state: "active" },
    process: { pid: 9001, exit: () => assert.fail("retryable inner inspection must retain the supervisor") },
    publish: (status: string, error?: string) => { publications.push({ status, error }); },
    reattestOwnedPosixAnchor: () => {
      reattestations += 1;
      return reattestations === 2
        ? { state: "outcome_unknown" }
        : { state: "ready", members: [workloadGroup.leaderPid] };
    },
    readFileSync: (path: string) => {
      const normalized = path.replace(/\\/g, "/");
      if (normalized === "root/fence.json") return JSON.stringify({ nonce, ownerId: "owner", fencingToken: 1 });
      if (normalized === "root/lock-holder.json") return JSON.stringify({ nonce, holderPid: 9001, holderBirth: "supervisor-birth" });
      throw new Error(`unexpected synthetic read ${path}`);
    },
    readdirSync: () => [], retained: new Map(),
    runPortableFenceEffectSync: (options: { effect: () => unknown }) => ({ status: "applied", value: options.effect() }),
    stdoutPath: "root/stdout.log", stderrPath: "root/stderr.log", targetExited: true, targetExitCode: 0, targetSignal: null, timer: "synthetic-timer",
    clearInterval: () => assert.fail("retryable inner inspection must retain the supervisor"), drainOutput: () => undefined, refreshPosixChildStatus: () => undefined,
    writeAtomic: (path: string, value: string) => { writes.push({ path, value: JSON.parse(value) }); }, existsSync: () => false,
  });
  vm.runInContext(`${extractNamedFunction(supervisorSource, "readCurrentFence")}\n${extractNamedFunction(supervisorSource, "readCurrentFenceStrict")}\n${extractFenceEffectFunctions(supervisorSource)}\n${extractNamedFunction(supervisorSource, "samePosixFenceAuthority")}\n${extractNamedFunction(supervisorSource, "hasCurrentPosixAnchorReleaseAuthority")}\n${extractNamedFunction(supervisorSource, "requestPosixAnchorRelease")}\n${extractNamedFunction(supervisorSource, "posixOutputPipesDrained")}\n${extractTickPosix(supervisorSource)}`, context);

  vm.runInContext("tickPosix()", context);
  assert.equal(reattestations, 2, "release publication must re-attest the exact anchor inside the fence");
  assert.deepEqual(writes, [], "transient inner inspection uncertainty must not publish a release");
  assert.equal(vm.runInContext("posixAnchorReleaseRequested", context), false);
  assert.equal(publications.at(-1)?.status, "running", "transient passive inspection must remain retryable");

  vm.runInContext("tickPosix()", context);
  assert.equal(reattestations, 4, "the unchanged release attempt must retry both outer and fenced inspection");
  assert.equal(writes.length, 1);
  assert.equal(vm.runInContext("posixAnchorReleaseRequested", context), true);
  assert.equal(publications.at(-1)?.status, "running");
});

test("C4 POSIX supervisor retries transient coordination while publishing anchor release", () => {
  const supervisorSource = readFileSync(new URL("../src/portable-process-supervisor.mjs", import.meta.url), "utf8");
  const workloadGroup = { groupId: 9002, leaderPid: 9002, leaderBirth: "anchor-birth" } as const;
  const nonce = "anchor-release-coordination-retry";
  const writes: Array<{ path: string; value: unknown }> = [];
  const publications: Array<{ status: string; error?: string }> = [];
  let fenceEffects = 0;
  const context = vm.createContext({
    child: { stdout: { readableLength: 0 }, stderr: { readableLength: 0 } }, Error, JSON, Number, PortableAuthorityUnavailableError: Error,
    anchorReleasePath: "root/anchor-release.json", channelAckDirectory: "root/channel/ack", channelDirectory: "root/channel", channelOutputDirectory: "root/channel/output",
    config: { directory: "root", nonce, platform: "posix" }, fencePath: "root/fence.json", lockHolderPath: "root/lock-holder.json", join,
    handleChannelAcks: () => undefined, handleChannelInput: () => undefined, handleControl: () => undefined, launchEffect: "started",
    posixAnchorExited: false, posixControlInspectionDeferred: false, posixControlInspectionFailures: 0, posixControlInspectionDetail: "", posixDeferredControlSignature: null, POSIX_CONTROL_INSPECTION_FAILURE_LIMIT: 3,
    posixAnchorReleaseAuthority: null, posixAnchorReleaseRequested: false, posixForceControlApplied: false, posixStderrClosed: false, posixStdoutClosed: false,
    posixSupervisorBirth: "supervisor-birth", posixTerminalError: null, posixWorkloadGroup: workloadGroup, posixWorkloadRetirement: { state: "active" },
    process: { pid: 9001, exit: () => assert.fail("retryable anchor release must retain the supervisor") },
    publish: (status: string, error?: string) => { publications.push({ status, error }); },
    reattestOwnedPosixAnchor: () => ({ state: "ready", members: [workloadGroup.leaderPid] }),
    readFileSync: (path: string) => { const normalized = path.replace(/\\/g, "/"); if (normalized === "root/fence.json") return JSON.stringify({ nonce, ownerId: "owner", fencingToken: 1 }); if (normalized === "root/lock-holder.json") return JSON.stringify({ nonce, holderPid: 9001, holderBirth: "supervisor-birth" }); throw new Error(`unexpected synthetic read ${path}`); },
    readdirSync: () => [], retained: new Map(),
    runPortableFenceEffectSync: (options: { effect: () => unknown }) => ++fenceEffects === 1 ? { status: "unavailable", cause: "coordination" } : { status: "applied", value: options.effect() },
    stdoutPath: "root/stdout.log", stderrPath: "root/stderr.log", targetExited: true, targetExitCode: 0, targetSignal: null, timer: "synthetic-timer",
    clearInterval: () => assert.fail("retryable anchor release must retain the supervisor"), drainOutput: () => undefined, refreshPosixChildStatus: () => undefined,
    writeAtomic: (path: string, value: string) => { writes.push({ path, value: JSON.parse(value) }); }, existsSync: () => false,
  });
  vm.runInContext(`${extractNamedFunction(supervisorSource, "readCurrentFence")}\n${extractNamedFunction(supervisorSource, "readCurrentFenceStrict")}\n${extractFenceEffectFunctions(supervisorSource)}\n${extractNamedFunction(supervisorSource, "samePosixFenceAuthority")}\n${extractNamedFunction(supervisorSource, "hasCurrentPosixAnchorReleaseAuthority")}\n${extractNamedFunction(supervisorSource, "requestPosixAnchorRelease")}\n${extractNamedFunction(supervisorSource, "posixOutputPipesDrained")}\n${extractTickPosix(supervisorSource)}`, context);

  vm.runInContext("tickPosix()", context);
  assert.equal(fenceEffects, 1);
  assert.deepEqual(writes, []);
  assert.equal(vm.runInContext("posixAnchorReleaseRequested", context), false);
  assert.equal(publications.at(-1)?.status, "running", "transient coordination must remain retryable");

  vm.runInContext("tickPosix()", context);
  assert.equal(fenceEffects, 2);
  assert.equal(writes.length, 1);
  assert.equal(vm.runInContext("posixAnchorReleaseRequested", context), true);
  assert.equal(publications.at(-1)?.status, "running");
});

test("C4 POSIX supervisor replaces an unconsumed anchor release marker after a higher-fence takeover", () => {
  const supervisorSource = readFileSync(new URL("../src/portable-process-supervisor.mjs", import.meta.url), "utf8");
  const workloadGroup = { groupId: 9002, leaderPid: 9002, leaderBirth: "anchor-birth" } as const;
  const nonce = "anchor-release-takeover";
  const writes: Array<{ path: string; value: unknown }> = [];
  const publications: Array<{ status: string; error?: string }> = [];
  const takeoverFence = { ownerId: "takeover", fencingToken: 2 } as const;
  const context = vm.createContext({
    Array,
    Error,
    JSON,
    Number,
    PortableAuthorityUnavailableError: Error,
    anchorReleasePath: "root/anchor-release.json",
    channelAckDirectory: "root/channel/ack",
    channelDirectory: "root/channel",
    channelOutputDirectory: "root/channel/output",
    child: { stdout: { readableLength: 0 }, stderr: { readableLength: 0 } },
    config: { directory: "root", nonce, platform: "posix" },
    fencePath: "root/fence.json",
    handleChannelAcks: () => undefined,
    handleChannelInput: () => undefined,
    handleControl: () => undefined,
    join,
    launchEffect: "started",
    lockHolderPath: "root/lock-holder.json",
    posixAnchorExited: false,
    posixControlInspectionDeferred: false,
    posixControlInspectionFailures: 0,
    posixControlInspectionDetail: "",
    posixDeferredControlSignature: null,
    POSIX_CONTROL_INSPECTION_FAILURE_LIMIT: 3,
    posixAnchorReleaseAuthority: { ownerId: "owner", fencingToken: 1 },
    posixAnchorReleaseRequested: true,
    posixForceControlApplied: false,
    posixStderrClosed: false,
    posixStdoutClosed: false,
    posixSupervisorBirth: "supervisor-birth",
    posixTerminalError: null,
    posixWorkloadGroup: workloadGroup,
    posixWorkloadRetirement: { state: "active" },
    process: { pid: 9001, exit: () => assert.fail("the unconsumed-release takeover must retain the supervisor") },
    publish: (status: string, error?: string) => { publications.push({ status, error }); },
    reattestOwnedPosixAnchor: () => ({ state: "ready", members: [workloadGroup.leaderPid] }),
    readFileSync: (path: string) => {
      const normalized = path.replace(/\\/g, "/");
      if (normalized === "root/fence.json") return JSON.stringify({ nonce, ...takeoverFence });
      if (normalized === "root/lock-holder.json") return JSON.stringify({ nonce, holderPid: 9001, holderBirth: "supervisor-birth" });
      throw new Error(`unexpected synthetic read ${path}`);
    },
    readdirSync: () => [],
    runPortableFenceEffectSync: (options: { effect: () => unknown }) => ({ status: "applied", value: options.effect() }),
    stderrPath: "root/stderr.log",
    stdoutPath: "root/stdout.log",
    targetExited: true,
    targetExitCode: 0,
    targetSignal: null,
    drainOutput: () => undefined,
    refreshPosixChildStatus: () => undefined,
    writeAtomic: (path: string, value: string) => { writes.push({ path, value: JSON.parse(value) }); },
  });
  vm.runInContext(`${extractNamedFunction(supervisorSource, "readCurrentFence")}\n${extractNamedFunction(supervisorSource, "readCurrentFenceStrict")}\n${extractFenceEffectFunctions(supervisorSource)}\n${extractNamedFunction(supervisorSource, "samePosixFenceAuthority")}\n${extractNamedFunction(supervisorSource, "hasCurrentPosixAnchorReleaseAuthority")}\n${extractNamedFunction(supervisorSource, "requestPosixAnchorRelease")}\n${extractTickPosix(supervisorSource)}`, context);

  vm.runInContext("tickPosix()", context);
  assert.deepEqual(writes, [{
    path: "root/anchor-release.json",
    value: {
      protocol: "aiboard-portable-process/v2-posix-anchor-release",
      nonce,
      supervisorPid: 9001,
      supervisorBirth: "supervisor-birth",
      ownerId: takeoverFence.ownerId,
      fencingToken: takeoverFence.fencingToken,
      workloadGroup,
    },
  }]);
  assert.deepEqual(JSON.parse(vm.runInContext("JSON.stringify(posixAnchorReleaseAuthority)", context)), takeoverFence);
  assert.equal(vm.runInContext("posixAnchorReleaseRequested", context), true);
  assert.equal(publications.at(-1)?.status, "running");
});

test("C4 POSIX supervisor retains authority when an anchor exits before reporting exact release consumption", () => {
  const supervisorSource = readFileSync(new URL("../src/portable-process-supervisor.mjs", import.meta.url), "utf8");
  const workloadGroup = { groupId: 9002, leaderPid: 9002, leaderBirth: "anchor-birth" } as const;
  const nonce = "anchor-release-unconsumed";
  const writes: Array<{ path: string; value: unknown }> = [];
  const publications: Array<{ status: string; error?: string }> = [];
  let members = [workloadGroup.leaderPid];
  const context = vm.createContext({
    Array,
    Error,
    JSON,
    Map,
    Number,
    PortableAuthorityUnavailableError: Error,
    anchorReleasePath: "root/anchor-release.json",
    channelAckDirectory: "root/channel/ack",
    channelDirectory: "root/channel",
    channelOutputDirectory: "root/channel/output",
    child: { stdout: { readableLength: 0 }, stderr: { readableLength: 0 } },
    childStatusPath: "root/child-status.json",
    config: { directory: "root", nonce, platform: "posix" },
    fencePath: "root/fence.json",
    handleChannelAcks: () => undefined,
    handleChannelInput: () => undefined,
    handleControl: () => undefined,
    join,
    launchEffect: "started",
    lockHolderPath: "root/lock-holder.json",
    posixAnchorExitCode: null,
    posixAnchorExited: false,
    posixControlInspectionDeferred: false,
    posixControlInspectionFailures: 0,
    posixControlInspectionDetail: "",
    posixDeferredControlSignature: null,
    POSIX_CONTROL_INSPECTION_FAILURE_LIMIT: 3,
    posixAnchorExitSignal: null,
    posixAnchorReleaseAuthority: null,
    posixAnchorReleaseRequested: false,
    posixChildReleasedAnchorRelease: null,
    posixChildStatusSignature: undefined,
    posixForceControlApplied: false,
    posixStderrClosed: false,
    posixStdoutClosed: false,
    posixSupervisorBirth: "supervisor-birth",
    posixTerminalError: null,
    posixWorkloadGroup: workloadGroup,
    posixWorkloadRetirement: { state: "active" },
    process: { pid: 9001, exit: () => assert.fail("unconsumed-release loss must retain the supervisor") },
    publish: (status: string, error?: string) => { publications.push({ status, error }); },
    reattestOwnedPosixAnchor: () => ({ state: "ready", members: [...members] }),
    listOwnedPosixGroupMembers: () => [...members],
    readFileSync: (path: string) => {
      const normalized = path.replace(/\\/g, "/");
      if (normalized === "root/fence.json") return JSON.stringify({ nonce, ownerId: "owner", fencingToken: 1 });
      if (normalized === "root/lock-holder.json") return JSON.stringify({ nonce, holderPid: 9001, holderBirth: "supervisor-birth" });
      if (normalized === "root/child-status.json") return JSON.stringify({
        protocol: "aiboard-portable-process/v2-posix-child",
        nonce,
        status: "prepared",
        workloadGroup,
      });
      throw new Error(`unexpected synthetic read ${path}`);
    },
    readdirSync: () => [],
    retained: new Map(),
    runPortableFenceEffectSync: (options: { effect: () => unknown }) => ({ status: "applied", value: options.effect() }),
    isExactPosixAnchorRelease,
    stderrPath: "root/stderr.log",
    stdoutPath: "root/stdout.log",
    targetExited: true,
    targetExitCode: 0,
    targetSignal: null,
    drainOutput: () => undefined,
    refreshPosixChildStatus: undefined,
    writeAtomic: (path: string, value: string) => { writes.push({ path, value: JSON.parse(value) }); },
  });
  vm.runInContext(`${extractNamedFunction(supervisorSource, "samePosixWorkloadGroup")}\n${extractNamedFunction(supervisorSource, "readJson")}\n${extractNamedFunction(supervisorSource, "readPosixChildStatus")}\n${extractNamedFunction(supervisorSource, "refreshPosixChildStatus")}\n${extractNamedFunction(supervisorSource, "readCurrentFence")}\n${extractNamedFunction(supervisorSource, "readCurrentFenceStrict")}\n${extractFenceEffectFunctions(supervisorSource)}\n${extractNamedFunction(supervisorSource, "samePosixFenceAuthority")}\n${extractNamedFunction(supervisorSource, "hasCurrentPosixAnchorReleaseAuthority")}\n${extractNamedFunction(supervisorSource, "recordCausalPosixAnchorRelease")}\n${extractNamedFunction(supervisorSource, "hasCausalPosixAnchorRelease")}\n${extractNamedFunction(supervisorSource, "requestPosixAnchorRelease")}\n${extractNamedFunction(supervisorSource, "retirePosixWorkload")}\n${extractNamedFunction(supervisorSource, "handlePosixAnchorExit")}\n${extractTickPosix(supervisorSource)}`, context);

  vm.runInContext("tickPosix()", context);
  assert.deepEqual(writes, [{
    path: "root/anchor-release.json",
    value: {
      protocol: "aiboard-portable-process/v2-posix-anchor-release",
      nonce,
      supervisorPid: 9001,
      supervisorBirth: "supervisor-birth",
      ownerId: "owner",
      fencingToken: 1,
      workloadGroup,
    },
  }], "the actual supervisor must first publish an exact release marker");
  members = [];
  vm.runInContext("handlePosixAnchorExit(0, null); tickPosix()", context);
  assert.deepEqual(JSON.parse(vm.runInContext("JSON.stringify(posixWorkloadRetirement)", context)), { state: "active" });
  assert.equal(publications.at(-1)?.status, "outcome_unknown");
  assert.match(publications.at(-1)?.error ?? "", /released[ -]child|causal anchor release|consumption/i);
});

test("C4 POSIX supervisor rejects mismatched released records and non-clean anchor exits", () => {
  const supervisorSource = readFileSync(new URL("../src/portable-process-supervisor.mjs", import.meta.url), "utf8");
  const workloadGroup = { groupId: 9002, leaderPid: 9002, leaderBirth: "anchor-birth" } as const;
  const nonce = "anchor-release-causal-cases";
  const authority = { ownerId: "owner", fencingToken: 1 } as const;
  const expectedSupervisor = { supervisorPid: 9001, supervisorBirth: "supervisor-birth" } as const;
  const exactRelease = {
    protocol: "aiboard-portable-process/v2-posix-anchor-release",
    nonce,
    ...expectedSupervisor,
    ...authority,
    workloadGroup,
  } as const;

  function runCase(childStatus: Record<string, unknown>, code: number | null, signal: string | null) {
    const publications: Array<{ status: string; error?: string }> = [];
    let exits = 0;
    const context = vm.createContext({
      Error,
      JSON,
      Number,
      PortableAuthorityUnavailableError: Error,
      anchorReleasePath: "root/anchor-release.json",
      channelAckDirectory: "root/channel/ack",
      channelDirectory: "root/channel",
      channelOutputDirectory: "root/channel/output",
      child: { stdout: { readableLength: 0 }, stderr: { readableLength: 0 } },
      childStatusPath: "root/child-status.json",
      config: { directory: "root", nonce, platform: "posix" },
      fencePath: "root/fence.json",
      handleChannelAcks: () => undefined,
      handleChannelInput: () => undefined,
      handleControl: () => undefined,
      isExactPosixAnchorRelease,
      join,
      launchEffect: "started",
      listOwnedPosixGroupMembers: () => [],
      lockHolderPath: "root/lock-holder.json",
      posixAnchorExitCode: null,
      posixAnchorExited: false,
    posixControlInspectionDeferred: false,
    posixControlInspectionFailures: 0,
    posixControlInspectionDetail: "",
    posixDeferredControlSignature: null,
    POSIX_CONTROL_INSPECTION_FAILURE_LIMIT: 3,
      posixAnchorExitSignal: null,
      posixAnchorReleaseAuthority: authority,
      posixAnchorReleaseRequested: true,
      posixChildReleasedAnchorRelease: null,
      posixChildStatusSignature: undefined,
      posixForceControlApplied: false,
      posixStderrClosed: false,
      posixStdoutClosed: false,
      posixSupervisorBirth: expectedSupervisor.supervisorBirth,
      posixTerminalError: null,
      posixWorkloadGroup: workloadGroup,
      posixWorkloadRetirement: { state: "active" },
      process: { pid: expectedSupervisor.supervisorPid, exit: () => { exits += 1; } },
      publish: (status: string, error?: string) => { publications.push({ status, error }); },
      readFileSync: (path: string) => {
        const normalized = path.replace(/\\/g, "/");
        if (normalized === "root/fence.json") return JSON.stringify({ nonce, ...authority });
        if (normalized === "root/lock-holder.json") return JSON.stringify({ nonce, holderPid: expectedSupervisor.supervisorPid, holderBirth: expectedSupervisor.supervisorBirth });
        if (normalized === "root/anchor-release.json") return JSON.stringify(exactRelease);
        if (normalized === "root/child-status.json") return JSON.stringify(childStatus);
        throw new Error(`unexpected synthetic read ${path}`);
      },
      reattestOwnedPosixAnchor: () => assert.fail("anchor-exit cases must not reattest a departed anchor"),
      retained: new Map(),
      runPortableFenceEffectSync: (options: { effect: () => unknown }) => ({ status: "applied", value: options.effect() }),
      stderrPath: "root/stderr.log",
      stdoutPath: "root/stdout.log",
      targetExited: true,
      targetExitCode: 0,
      targetSignal: null,
      drainOutput: () => undefined,
    });
    vm.runInContext(`${extractNamedFunction(supervisorSource, "samePosixWorkloadGroup")}\n${extractNamedFunction(supervisorSource, "readJson")}\n${extractNamedFunction(supervisorSource, "readPosixChildStatus")}\n${extractNamedFunction(supervisorSource, "refreshPosixChildStatus")}\n${extractNamedFunction(supervisorSource, "readCurrentFence")}\n${extractNamedFunction(supervisorSource, "readCurrentFenceStrict")}\n${extractFenceEffectFunctions(supervisorSource)}\n${extractNamedFunction(supervisorSource, "recordCausalPosixAnchorRelease")}\n${extractNamedFunction(supervisorSource, "hasCausalPosixAnchorRelease")}\n${extractNamedFunction(supervisorSource, "retirePosixWorkload")}\n${extractNamedFunction(supervisorSource, "handlePosixAnchorExit")}\n${extractTickPosix(supervisorSource)}`, context);
    vm.runInContext(`handlePosixAnchorExit(${code === null ? "null" : code}, ${signal === null ? "null" : JSON.stringify(signal)}); tickPosix()`, context);
    return {
      exits,
      publications,
      retirement: JSON.parse(vm.runInContext("JSON.stringify(posixWorkloadRetirement)", context)),
    };
  }

  const released = {
    protocol: "aiboard-portable-process/v2-posix-child",
    nonce,
    status: "released",
    workloadGroup,
    anchorRelease: exactRelease,
  } as const;
  const cases = [
    { name: "mismatched released marker", childStatus: { ...released, anchorRelease: { ...exactRelease, fencingToken: 2 } }, code: 0, signal: null },
    { name: "nonzero anchor exit", childStatus: released, code: 1, signal: null },
    { name: "signaled anchor exit", childStatus: released, code: null, signal: "SIGKILL" },
  ];
  for (const candidate of cases) {
    const result = runCase(candidate.childStatus, candidate.code, candidate.signal);
    assert.deepEqual(result.retirement, { state: "active" }, `${candidate.name} must not certify natural workload retirement`);
    assert.equal(result.exits, 0, `${candidate.name} must retain the supervisor witness`);
    assert.equal(result.publications.at(-1)?.status, "outcome_unknown");
    assert.match(result.publications.at(-1)?.error ?? "", /released-child|clean causal exit/i);
  }
});

test("C4 POSIX supervisor retains uncertain authority when a forced anchor exits with descendants remaining", () => {
  const supervisorSource = readFileSync(new URL("../src/portable-process-supervisor.mjs", import.meta.url), "utf8");
  const workloadGroup = { groupId: 9002, leaderPid: 9002, leaderBirth: "anchor-birth" } as const;
  const publications: Array<{ status: string; error?: string }> = [];
  let exits = 0;
  const context = vm.createContext({
    child: { stdout: { readableLength: 0 }, stderr: { readableLength: 0 } },
    Error,
    JSON,
    Number,
    channelAckDirectory: "root/channel/ack",
    channelDirectory: "root/channel",
    channelOutputDirectory: "root/channel/output",
    config: { directory: "root", nonce: "uncertain-force", platform: "posix" },
    handleChannelAcks: () => undefined,
    handleChannelInput: () => undefined,
    handleControl: () => undefined,
    launchEffect: "started",
    listOwnedPosixGroupMembers: () => [9003],
    posixAnchorExitCode: null,
    posixAnchorExited: false,
    posixControlInspectionDeferred: false,
    posixControlInspectionFailures: 0,
    posixControlInspectionDetail: "",
    posixDeferredControlSignature: null,
    POSIX_CONTROL_INSPECTION_FAILURE_LIMIT: 3,
    posixAnchorExitSignal: null,
    posixAnchorReleaseRequested: false,
    posixChildReleasedAnchorRelease: null,
    posixForceControlApplied: true,
    posixStderrClosed: false,
    posixStdoutClosed: false,
    posixSupervisorBirth: "supervisor-birth",
    posixTerminalError: null,
    posixWorkloadGroup: workloadGroup,
    posixWorkloadRetirement: { state: "active" },
    process: { exit: () => { exits += 1; } },
    publish: (status: string, error?: string) => { publications.push({ status, error }); },
    stdoutPath: "root/stdout.log",
    stderrPath: "root/stderr.log",
    targetExited: true,
    targetExitCode: null,
    targetSignal: null,
    drainOutput: () => undefined,
    refreshPosixChildStatus: () => undefined,
  });
  vm.runInContext(`${extractNamedFunction(supervisorSource, "handlePosixAnchorExit")}\n${extractNamedFunction(supervisorSource, "hasCausalPosixAnchorRelease")}\n${extractNamedFunction(supervisorSource, "retirePosixWorkload")}\n${extractNamedFunction(supervisorSource, "posixOutputPipesDrained")}\n${extractTickPosix(supervisorSource)}`, context);

  vm.runInContext("handlePosixAnchorExit(null, 'SIGKILL'); tickPosix()", context);
  assert.deepEqual(JSON.parse(vm.runInContext("JSON.stringify(posixWorkloadRetirement)", context)), { state: "active" });
  assert.equal(exits, 0);
  assert.equal(publications.at(-1)?.status, "outcome_unknown");
  assert.match(publications.at(-1)?.error ?? "", /released-child|clean causal exit/i);
});

test("C4 POSIX supervisor keeps its anchor through graceful control before one exact force signal", () => {
  const supervisorSource = readFileSync(new URL("../src/portable-process-supervisor.mjs", import.meta.url), "utf8");
  const workloadGroup = { groupId: 9002, leaderPid: 9002, leaderBirth: "anchor-birth" } as const;
  let request = { nonce: "graceful-force", ownerId: "owner", fencingToken: 1, sequence: 1, action: "terminate" };
  let groupMembers = [workloadGroup.leaderPid, 9003];
  const signals: Array<[number, NodeJS.Signals]> = [];
  const writes: Array<{ path: string; value: unknown }> = [];
  const publications: Array<{ status: string; error?: string }> = [];
  const context = vm.createContext({
    Array,
    child: { stdout: { readableLength: 0 }, stderr: { readableLength: 0 } },
    Error,
    JSON,
    Map,
    Number,
    PortableAuthorityUnavailableError: Error,
    anchorReleasePath: "root/anchor-release.json",
    channelAckDirectory: "root/channel/ack",
    channelDirectory: "root/channel",
    channelOutputDirectory: "root/channel/output",
    config: { directory: "root", nonce: request.nonce, platform: "posix" },
    controlPath: "root/control.json",
    fencePath: "root/fence.json",
    handledControl: 0,
    handleChannelAcks: () => undefined,
    handleChannelInput: () => undefined,
    join,
    launchEffect: "started",
    listOwnedPosixGroupMembers: () => [...groupMembers],
    lockHolderPath: "root/lock-holder.json",
    posixAnchorExitCode: null,
    posixAnchorExited: false,
    posixControlInspectionDeferred: false,
    posixControlInspectionFailures: 0,
    posixControlInspectionDetail: "",
    posixDeferredControlSignature: null,
    POSIX_CONTROL_INSPECTION_FAILURE_LIMIT: 3,
    posixAnchorExitSignal: null,
    posixAnchorReleaseAuthority: null,
    posixAnchorReleaseRequested: false,
    posixChildReleasedAnchorRelease: null,
    posixForceControlApplied: false,
    posixStderrClosed: false,
    posixStdoutClosed: false,
    posixSupervisorBirth: "supervisor-birth",
    posixTerminalError: null,
    posixWorkloadGroup: workloadGroup,
    posixWorkloadRetirement: { state: "active" },
    process: {
      pid: 9001,
      exit: () => assert.fail("pipes remain open in this control schedule"),
      kill: (pid: number, signal: NodeJS.Signals) => {
        signals.push([pid, signal]);
        if (pid === -workloadGroup.groupId && signal === "SIGKILL") groupMembers = [];
      },
    },
    publish: (status: string, error?: string) => { publications.push({ status, error }); },
    reattestOwnedPosixAnchor: () => ({ state: "ready", members: [...groupMembers] }),
    readFileSync: (path: string) => {
      const normalized = path.replace(/\\/g, "/");
      if (normalized === "root/control.json") return JSON.stringify(request);
      if (normalized === "root/fence.json") return JSON.stringify({ nonce: request.nonce, ownerId: request.ownerId, fencingToken: request.fencingToken });
      if (normalized === "root/lock-holder.json") return JSON.stringify({ nonce: request.nonce, holderPid: 9001, holderBirth: "supervisor-birth" });
      throw new Error(`unexpected synthetic read ${path}`);
    },
    readdirSync: (path: string) => {
      const normalized = path.replace(/\\/g, "/");
      if (normalized === "root/channel/output" || normalized === "root/channel/ack") return [];
      throw new Error(`unexpected synthetic listing ${path}`);
    },
    retained: new Map(),
    runPortableFenceEffectSync: (options: { effect: () => unknown }) => ({ status: "applied", value: options.effect() }),
    settlePortableSupervisorCommand,
    signalOwnedPosixGroup,
    existsSync: (path: string) => path.replace(/\\/g, "/") === "root/control.json",
    unlinkSync: () => assert.fail("current control must not be retired as stale"),
    timer: "synthetic-timer",
    clearInterval: () => assert.fail("the supervisor must survive this schedule"),
    stdoutPath: "root/stdout.log",
    stderrPath: "root/stderr.log",
    targetExited: true,
    targetExitCode: 0,
    targetSignal: null,
    drainOutput: () => undefined,
    refreshPosixChildStatus: () => undefined,
    writeAtomic: (path: string, value: unknown) => { writes.push({ path, value }); },
  });
  vm.runInContext(`${extractNamedFunction(supervisorSource, "readCurrentFence")}\n${extractNamedFunction(supervisorSource, "readCurrentFenceStrict")}\n${extractFenceEffectFunctions(supervisorSource)}\n${extractNamedFunction(supervisorSource, "samePosixFenceAuthority")}\n${extractNamedFunction(supervisorSource, "hasCurrentPosixAnchorReleaseAuthority")}\n${extractNamedFunction(supervisorSource, "completeControl")}\n${extractNamedFunction(supervisorSource, "handleControl")}\n${extractNamedFunction(supervisorSource, "requestPosixAnchorRelease")}\n${extractNamedFunction(supervisorSource, "hasCausalPosixAnchorRelease")}\n${extractNamedFunction(supervisorSource, "retirePosixWorkload")}\n${extractNamedFunction(supervisorSource, "posixOutputPipesDrained")}\n${extractNamedFunction(supervisorSource, "markPosixPipeClosed")}\n${extractNamedFunction(supervisorSource, "handlePosixAnchorExit")}\n${extractTickPosix(supervisorSource)}`, context);

  vm.runInContext("handleControl(); tickPosix()", context);
  assert.deepEqual(signals, [[-workloadGroup.groupId, "SIGTERM"]]);
  assert.equal(vm.runInContext("posixAnchorReleaseRequested", context), false, "a stubborn descendant keeps the exact anchor available for force control");
  assert.deepEqual(writes, [], "natural anchor release is forbidden while a descendant remains");

  request = { ...request, sequence: 2, action: "force_terminate" };
  vm.runInContext("handleControl(); handlePosixAnchorExit(null, 'SIGKILL'); tickPosix()", context);
  assert.deepEqual(signals, [[-workloadGroup.groupId, "SIGTERM"], [-workloadGroup.groupId, "SIGKILL"]]);
  const retirement = JSON.parse(vm.runInContext("JSON.stringify(posixWorkloadRetirement)", context));
  assert.equal(retirement.state, "retired");
  assert.equal(retirement.cause, "force_terminate");
  assert.equal(writes.length, 0);
  assert.equal(publications.some(({ status }) => status === "stopped"), false, "open pipes must keep terminal stopped proof withheld after force retirement");
  assert.ok(publications.some(({ status }) => status === "running"));
});

test("C4 POSIX force after authenticated anchor exit refuses a numeric group that cannot be re-attested", () => {
  const supervisorSource = readFileSync(new URL("../src/portable-process-supervisor.mjs", import.meta.url), "utf8");
  const workloadGroup = { groupId: 9002, leaderPid: 9002, leaderBirth: "anchor-birth" } as const;
  const request = { nonce: "recycled-pgid-force", ownerId: "owner", fencingToken: 1, sequence: 1, action: "force_terminate" };
  const signals: Array<[number, NodeJS.Signals]> = [];
  const publications: Array<{ status: string; error?: string }> = [];
  const context = vm.createContext({
    Error,
    JSON,
    Number,
    PortableAuthorityUnavailableError: Error,
    config: { directory: "root", nonce: request.nonce, platform: "posix" },
    controlPath: "root/control.json",
    fencePath: "root/fence.json",
    handledControl: 0,
    join,
    lockHolderPath: "root/lock-holder.json",
    posixAnchorExited: true,
    posixControlInspectionDeferred: false,
    posixControlInspectionFailures: 0,
    posixControlInspectionDetail: "",
    posixDeferredControlSignature: null,
    POSIX_CONTROL_INSPECTION_FAILURE_LIMIT: 3,
    posixForceControlApplied: false,
    posixRecordedMembers: new Map([[9003, "original-descendant-birth"]]),
    posixSupervisorBirth: "supervisor-birth",
    posixWorkloadGroup: workloadGroup,
    process: {
      pid: 9001,
      kill: (pid: number, signal: NodeJS.Signals) => { signals.push([pid, signal]); },
    },
    publish: (status: string, error?: string) => { publications.push({ status, error }); },
    reattestOwnedPosixAnchor: () => ({ state: "outcome_unknown" }),
    reattestOwnedPosixDescendants: () => ({ state: "identity_mismatch" }),
    readFileSync: (path: string) => {
      const normalized = path.replace(/\\/g, "/");
      if (normalized === "root/control.json") return JSON.stringify(request);
      if (normalized === "root/fence.json") return JSON.stringify({ nonce: request.nonce, ownerId: request.ownerId, fencingToken: request.fencingToken });
      if (normalized === "root/lock-holder.json") return JSON.stringify({ nonce: request.nonce, holderPid: 9001, holderBirth: "supervisor-birth" });
      throw new Error(`unexpected synthetic read ${path}`);
    },
    runPortableFenceEffectSync: (options: { effect: () => unknown }) => ({ status: "applied", value: options.effect() }),
    settlePortableSupervisorCommand,
    signalOwnedPosixGroup,
    existsSync: (path: string) => path.replace(/\\/g, "/") === "root/control.json",
    unlinkSync: () => undefined,
  });
  vm.runInContext(`${extractNamedFunction(supervisorSource, "readCurrentFence")}\n${extractNamedFunction(supervisorSource, "readCurrentFenceStrict")}\n${extractFenceEffectFunctions(supervisorSource)}\n${extractNamedFunction(supervisorSource, "completeControl")}\n${extractNamedFunction(supervisorSource, "handleControl")}`, context);
  vm.runInContext("handleControl()", context);
  assert.deepEqual(signals, [], "a recycled or unprovable PGID must never receive a destructive group signal");
  assert.equal(vm.runInContext("posixForceControlApplied", context), false);
  assert.equal(publications.at(-1)?.status, "outcome_unknown");
  assert.match(publications.at(-1)?.error ?? "", /refus(e|ing) numeric-only group control/i);
});

test("C4 POSIX force after authenticated anchor exit retries an unprovable inspect without poisoning status", () => {
  const supervisorSource = readFileSync(new URL("../src/portable-process-supervisor.mjs", import.meta.url), "utf8");
  const workloadGroup = { groupId: 9002, leaderPid: 9002, leaderBirth: "anchor-birth" } as const;
  const request = { nonce: "retry-unprovable-force", ownerId: "owner", fencingToken: 1, sequence: 1, action: "force_terminate" };
  const signals: Array<[number, NodeJS.Signals]> = [];
  const publications: Array<{ status: string; error?: string }> = [];
  let descendantInspections = 0;
  const context = vm.createContext({
    Error,
    JSON,
    Number,
    PortableAuthorityUnavailableError: Error,
    config: { directory: "root", nonce: request.nonce, platform: "posix" },
    controlPath: "root/control.json",
    fencePath: "root/fence.json",
    handledControl: 0,
    join,
    lockHolderPath: "root/lock-holder.json",
    posixAnchorExited: true,
    posixControlInspectionDeferred: false,
    posixControlInspectionFailures: 0,
    posixControlInspectionDetail: "",
    posixDeferredControlSignature: null,
    POSIX_CONTROL_INSPECTION_FAILURE_LIMIT: 3,
    posixForceControlApplied: false,
    posixRecordedMembers: new Map([[9003, "original-descendant-birth"]]),
    posixSupervisorBirth: "supervisor-birth",
    posixWorkloadGroup: workloadGroup,
    posixWorkloadRetirement: { state: "active" },
    launchEffect: "started",
    child: { stdout: {}, stderr: {} },
    stdoutPath: "root/stdout.log",
    stderrPath: "root/stderr.log",
    handleChannelAcks: () => undefined,
    handleChannelInput: () => undefined,
    drainOutput: () => undefined,
    refreshPosixChildStatus: () => undefined,
    listOwnedPosixGroupMembers: () => [9003],
    hasCausalPosixAnchorRelease: () => false,
    retirePosixWorkload: () => assert.fail("transient inspection must not retire the workload"),
    process: {
      pid: 9001,
      kill: (pid: number, signal: NodeJS.Signals) => { signals.push([pid, signal]); },
    },
    publish: (status: string, error?: string) => { publications.push({ status, error }); },
    reattestOwnedPosixAnchor: () => ({ state: "outcome_unknown" }),
    reattestOwnedPosixDescendants: () => { descendantInspections += 1; return { state: "outcome_unknown" }; },
    readFileSync: (path: string) => {
      const normalized = path.replace(/\\/g, "/");
      if (normalized === "root/control.json") return JSON.stringify(request);
      if (normalized === "root/fence.json") return JSON.stringify({ nonce: request.nonce, ownerId: request.ownerId, fencingToken: request.fencingToken });
      if (normalized === "root/lock-holder.json") return JSON.stringify({ nonce: request.nonce, holderPid: 9001, holderBirth: "supervisor-birth" });
      throw new Error(`unexpected synthetic read ${path}`);
    },
    runPortableFenceEffectSync: (options: { effect: () => unknown }) => ({ status: "applied", value: options.effect() }),
    settlePortableSupervisorCommand,
    signalOwnedPosixGroup,
    existsSync: (path: string) => path.replace(/\\/g, "/") === "root/control.json",
    unlinkSync: () => undefined,
  });
  vm.runInContext(`${extractNamedFunction(supervisorSource, "readCurrentFence")}\n${extractNamedFunction(supervisorSource, "readCurrentFenceStrict")}\n${extractFenceEffectFunctions(supervisorSource)}\n${extractNamedFunction(supervisorSource, "completeControl")}\n${extractNamedFunction(supervisorSource, "handleControl")}\n${extractTickPosix(supervisorSource)}`, context);
  vm.runInContext("tickPosix()", context);
  assert.deepEqual(signals, [], "an unprovable inspect must not receive a destructive group signal");
  assert.equal(vm.runInContext("posixForceControlApplied", context), false);
  assert.equal(vm.runInContext("handledControl", context), 0, "a transient inspect race must leave the force request retryable");
  assert.equal(publications.some(({ status }) => status === "outcome_unknown"), false, "output settlement requires running|stopping|stopped while inspection is retryable");
  assert.equal(publications.at(-1)?.status, "running", "a retryable ownership inspection keeps the workload conservatively running");
  vm.runInContext("tickPosix(); tickPosix(); tickPosix()", context);
  assert.equal(descendantInspections, 3, "the same exact force request must stop launching ownership inspections after the configured retry cap");
  assert.equal(vm.runInContext("posixControlInspectionFailures", context), 3);
  assert.equal(publications.at(-1)?.status, "outcome_unknown", "exhausted bounded retry must become visible durable uncertainty");
  assert.match(publications.at(-1)?.error ?? "", /attempt 3 of 3|remained unavailable after 3 attempts/i);
  assert.deepEqual(signals, [], "bounded retry exhaustion must never fall back to numeric-only group control");
});

test("C4 POSIX post-anchor graceful control cannot block retirement or terminal exit", () => {
  const supervisorSource = readFileSync(new URL("../src/portable-process-supervisor.mjs", import.meta.url), "utf8");
  const workloadGroup = { groupId: 9002, leaderPid: 9002, leaderBirth: "anchor-birth" } as const;
  let request = { nonce: "post-anchor-graceful", ownerId: "owner", fencingToken: 1, sequence: 1, action: "terminate" };
  let terminalOutput = false;
  let exits = 0;
  const publications: Array<{ status: string; error?: string }> = [];
  const context = vm.createContext({
    Date, Error, JSON, Number, Symbol, PortableAuthorityUnavailableError: Error,
    config: { directory: "root", nonce: request.nonce, platform: "posix" },
    controlPath: "root/control.json", fencePath: "root/fence.json", lockHolderPath: "root/lock-holder.json",
    handledControl: 0, join, launchEffect: "started",
    posixAnchorExited: true, posixAnchorReleaseRequested: false,
    posixControlInspectionDeferred: false, posixControlInspectionFailures: 0, posixControlInspectionDetail: "",
    posixDeferredControlSignature: null, POSIX_CONTROL_INSPECTION_FAILURE_LIMIT: 3,
    posixForceControlApplied: false, posixSupervisorBirth: "supervisor-birth",
    posixWorkloadGroup: workloadGroup, posixWorkloadRetirement: { state: "active" },
    child: { stdout: {}, stderr: {} }, stdoutPath: "root/stdout.log", stderrPath: "root/stderr.log",
    handleChannelAcks: () => undefined, handleChannelInput: () => undefined, drainOutput: () => undefined,
    refreshPosixChildStatus: () => undefined, listOwnedPosixGroupMembers: () => [],
    hasCausalPosixAnchorRelease: () => true,
    posixOutputPipesDrained: () => terminalOutput, posixOutputSettled: () => terminalOutput,
    process: { pid: 9001, exit: () => { exits += 1; } }, timer: "synthetic-timer", clearInterval: () => undefined,
    publish: (status: string, error?: string) => { publications.push({ status, error }); },
    readFileSync: (path: string) => {
      const normalized = path.replace(/\\/g, "/");
      if (normalized === "root/control.json") return JSON.stringify(request);
      if (normalized === "root/fence.json") return JSON.stringify({ nonce: request.nonce, ownerId: request.ownerId, fencingToken: request.fencingToken });
      if (normalized === "root/lock-holder.json") return JSON.stringify({ nonce: request.nonce, holderPid: 9001, holderBirth: "supervisor-birth" });
      throw new Error(`unexpected synthetic read ${path}`);
    },
    existsSync: (path: string) => path.replace(/\\/g, "/") === "root/control.json",
    unlinkSync: () => undefined,
    runPortableFenceEffectSync: (options: { effect: () => unknown }) => ({ status: "applied", value: options.effect() }),
    settlePortableSupervisorCommand,
    reattestOwnedPosixAnchor: () => assert.fail("a graceful request after real anchor exit must not re-attest or signal the dead anchor"),
  });
  vm.runInContext(`${extractNamedFunction(supervisorSource, "readCurrentFence")}\n${extractNamedFunction(supervisorSource, "readCurrentFenceStrict")}\n${extractFenceEffectFunctions(supervisorSource)}\n${extractNamedFunction(supervisorSource, "completeControl")}\n${extractNamedFunction(supervisorSource, "handleControl")}\n${extractNamedFunction(supervisorSource, "retirePosixWorkload")}\n${extractTickPosix(supervisorSource)}`, context);
  vm.runInContext("tickPosix()", context);
  assert.equal(vm.runInContext("handledControl", context), 1, "the stale graceful request is consumed as a no-op");
  assert.equal(vm.runInContext("posixWorkloadRetirement.state", context), "retired", "clean anchor exit still retires with output unsettled");
  assert.equal(exits, 0, "unsettled output still keeps the supervisor witness alive");
  request = { ...request, sequence: 2, action: "force_terminate" };
  terminalOutput = true;
  vm.runInContext("tickPosix()", context);
  assert.equal(exits, 1, "a newly published control request cannot block an already-retired workload from terminal exit");
  assert.equal(vm.runInContext("handledControl", context), 1, "retired workload exit occurs before polling the new control request");
  assert.equal(publications.at(-1)?.status, "stopped");
});

test("C4 POSIX bounds retry of one exact unavailable control inspection", () => {
  const supervisorSource = readFileSync(new URL("../src/portable-process-supervisor.mjs", import.meta.url), "utf8");
  const workloadGroup = { groupId: 9002, leaderPid: 9002, leaderBirth: "anchor-birth" } as const;
  const request = { nonce: "bounded-inspection", ownerId: "owner", fencingToken: 1, sequence: 1, action: "force_terminate" } as const;
  let inspections = 0;
  const context = vm.createContext({
    Error, JSON, Number, Symbol, PortableAuthorityUnavailableError: Error,
    config: { directory: "root", nonce: request.nonce, platform: "posix" },
    controlPath: "root/control.json", fencePath: "root/fence.json", lockHolderPath: "root/lock-holder.json",
    handledControl: 0, join, posixAnchorExited: false,
    posixControlInspectionDeferred: false, posixControlInspectionFailures: 0, posixControlInspectionDetail: "",
    posixDeferredControlSignature: null, POSIX_CONTROL_INSPECTION_FAILURE_LIMIT: 3,
    posixForceControlApplied: false, posixWorkloadGroup: workloadGroup, process: { pid: 9001 },
    publish: () => undefined,
    reattestOwnedPosixAnchor: () => { inspections += 1; return { state: "outcome_unknown" }; },
    readFileSync: (path: string) => path === "root/control.json" ? JSON.stringify(request)
      : path === "root/fence.json" ? JSON.stringify({ nonce: request.nonce, ownerId: request.ownerId, fencingToken: request.fencingToken })
      : path === "root/lock-holder.json" ? JSON.stringify({ nonce: request.nonce, holderPid: 9001, holderBirth: "supervisor-birth" })
      : (() => { throw new Error(`unexpected synthetic read ${path}`); })(),
    existsSync: (path: string) => path === "root/control.json", unlinkSync: () => undefined,
    runPortableFenceEffectSync: (options: { effect: () => unknown }) => ({ status: "applied", value: options.effect() }),
    settlePortableSupervisorCommand, signalOwnedPosixGroup,
  });
  vm.runInContext(`${extractNamedFunction(supervisorSource, "readCurrentFence")}\n${extractNamedFunction(supervisorSource, "readCurrentFenceStrict")}\n${extractFenceEffectFunctions(supervisorSource)}\n${extractNamedFunction(supervisorSource, "completeControl")}\n${extractNamedFunction(supervisorSource, "handleControl")}`, context);
  vm.runInContext("handleControl(); handleControl(); handleControl(); handleControl()", context);
  assert.equal(inspections, 3, "the fourth tick must not launch another host inspection for the same exact request");
  assert.equal(vm.runInContext("posixControlInspectionFailures", context), 3);
  assert.equal(vm.runInContext("posixControlInspectionDeferred", context), true);
  assert.match(vm.runInContext("posixControlInspectionDetail", context), /attempt 3 of 3/i);
});

test("C4 POSIX post-anchor force keeps the request retryable when the inner fence re-attestation is transiently unknown", () => {
  const supervisorSource = readFileSync(new URL("../src/portable-process-supervisor.mjs", import.meta.url), "utf8");
  const workloadGroup = { groupId: 9002, leaderPid: 9002, leaderBirth: "anchor-birth" } as const;
  const request = { nonce: "inner-descendant-race", ownerId: "owner", fencingToken: 1, sequence: 1, action: "force_terminate" };
  const signals: Array<[number, NodeJS.Signals]> = [];
  const publications: Array<{ status: string; error?: string }> = [];
  let descendantAttestations = 0;
  const context = vm.createContext({
    Error, JSON, Number, PortableAuthorityUnavailableError: Error,
    config: { directory: "root", nonce: request.nonce, platform: "posix" },
    controlPath: "root/control.json", fencePath: "root/fence.json", lockHolderPath: "root/lock-holder.json",
    handledControl: 0, join,
    posixAnchorExited: true,
    posixControlInspectionDeferred: false,
    posixControlInspectionFailures: 0,
    posixControlInspectionDetail: "",
    posixDeferredControlSignature: null,
    POSIX_CONTROL_INSPECTION_FAILURE_LIMIT: 3,
    posixForceControlApplied: false,
    posixRecordedMembers: new Map([[9003, "descendant-birth"]]),
    posixSupervisorBirth: "supervisor-birth",
    posixWorkloadGroup: workloadGroup,
    process: { pid: 9001, kill: (pid: number, signal: NodeJS.Signals) => { signals.push([pid, signal]); } },
    publish: (status: string, error?: string) => { publications.push({ status, error }); },
    reattestOwnedPosixAnchor: () => ({ state: "outcome_unknown" }),
    reattestOwnedPosixDescendants: () => ++descendantAttestations === 1
      ? { state: "ready", members: [9003] }
      : { state: "outcome_unknown" },
    readFileSync: (path: string) => {
      const normalized = path.replace(/\\/g, "/");
      if (normalized === "root/control.json") return JSON.stringify(request);
      if (normalized === "root/fence.json") return JSON.stringify({ nonce: request.nonce, ownerId: request.ownerId, fencingToken: request.fencingToken });
      if (normalized === "root/lock-holder.json") return JSON.stringify({ nonce: request.nonce, holderPid: 9001, holderBirth: "supervisor-birth" });
      throw new Error(`unexpected synthetic read ${path}`);
    },
    runPortableFenceEffectSync: (options: { effect: () => unknown }) => ({ status: "applied", value: options.effect() }),
    settlePortableSupervisorCommand,
    signalOwnedPosixGroup,
    existsSync: (path: string) => path.replace(/\\/g, "/") === "root/control.json",
    unlinkSync: () => undefined,
  });
  vm.runInContext(`${extractNamedFunction(supervisorSource, "readCurrentFence")}\n${extractNamedFunction(supervisorSource, "readCurrentFenceStrict")}\n${extractFenceEffectFunctions(supervisorSource)}\n${extractNamedFunction(supervisorSource, "completeControl")}\n${extractNamedFunction(supervisorSource, "handleControl")}`, context);
  vm.runInContext("handleControl()", context);
  assert.equal(descendantAttestations, 2);
  assert.deepEqual(signals, []);
  assert.equal(vm.runInContext("handledControl", context), 0, "transient inner-fence uncertainty must not consume the exact force request");
  assert.equal(vm.runInContext("posixControlInspectionDeferred", context), true);
  assert.equal(publications.some(({ status }) => status === "outcome_unknown"), false);
});

test("C4 POSIX force after authenticated anchor exit signals only a re-attested descendant group", () => {
  const supervisorSource = readFileSync(new URL("../src/portable-process-supervisor.mjs", import.meta.url), "utf8");
  const workloadGroup = { groupId: 9002, leaderPid: 9002, leaderBirth: "anchor-birth" } as const;
  const request = { nonce: "proven-descendant-force", ownerId: "owner", fencingToken: 1, sequence: 1, action: "force_terminate" };
  const signals: Array<[number, NodeJS.Signals]> = [];
  const publications: Array<{ status: string; error?: string }> = [];
  let descendantAttestations = 0;
  const context = vm.createContext({
    Error,
    JSON,
    Number,
    PortableAuthorityUnavailableError: Error,
    config: { directory: "root", nonce: request.nonce, platform: "posix" },
    controlPath: "root/control.json",
    fencePath: "root/fence.json",
    handledControl: 0,
    join,
    lockHolderPath: "root/lock-holder.json",
    posixAnchorExited: true,
    posixControlInspectionDeferred: false,
    posixControlInspectionFailures: 0,
    posixControlInspectionDetail: "",
    posixDeferredControlSignature: null,
    POSIX_CONTROL_INSPECTION_FAILURE_LIMIT: 3,
    posixForceControlApplied: false,
    posixRecordedMembers: new Map([[9003, "descendant-birth"]]),
    posixSupervisorBirth: "supervisor-birth",
    posixWorkloadGroup: workloadGroup,
    process: {
      pid: 9001,
      kill: (pid: number, signal: NodeJS.Signals) => { signals.push([pid, signal]); },
    },
    publish: (status: string, error?: string) => { publications.push({ status, error }); },
    reattestOwnedPosixAnchor: () => ({ state: "outcome_unknown" }),
    reattestOwnedPosixDescendants: () => {
      descendantAttestations += 1;
      return { state: "ready", members: [9003] };
    },
    readFileSync: (path: string) => {
      const normalized = path.replace(/\\/g, "/");
      if (normalized === "root/control.json") return JSON.stringify(request);
      if (normalized === "root/fence.json") return JSON.stringify({ nonce: request.nonce, ownerId: request.ownerId, fencingToken: request.fencingToken });
      if (normalized === "root/lock-holder.json") return JSON.stringify({ nonce: request.nonce, holderPid: 9001, holderBirth: "supervisor-birth" });
      throw new Error(`unexpected synthetic read ${path}`);
    },
    runPortableFenceEffectSync: (options: { effect: () => unknown }) => ({ status: "applied", value: options.effect() }),
    settlePortableSupervisorCommand,
    signalOwnedPosixGroup,
    existsSync: (path: string) => path.replace(/\\/g, "/") === "root/control.json",
    unlinkSync: () => undefined,
  });
  vm.runInContext(`${extractNamedFunction(supervisorSource, "readCurrentFence")}\n${extractNamedFunction(supervisorSource, "readCurrentFenceStrict")}\n${extractFenceEffectFunctions(supervisorSource)}\n${extractNamedFunction(supervisorSource, "completeControl")}\n${extractNamedFunction(supervisorSource, "handleControl")}`, context);
  vm.runInContext("handleControl()", context);
  assert.ok(descendantAttestations >= 1, "force after anchor exit must re-attest recorded descendants before signaling");
  assert.deepEqual(signals, [[-workloadGroup.groupId, "SIGKILL"]]);
  assert.equal(vm.runInContext("posixForceControlApplied", context), true);
});

test("C4 POSIX force after authenticated anchor exit does not signal an empty recorded group", () => {
  const supervisorSource = readFileSync(new URL("../src/portable-process-supervisor.mjs", import.meta.url), "utf8");
  const workloadGroup = { groupId: 9002, leaderPid: 9002, leaderBirth: "anchor-birth" } as const;
  const request = { nonce: "empty-descendant-force", ownerId: "owner", fencingToken: 1, sequence: 1, action: "force_terminate" };
  const signals: Array<[number, NodeJS.Signals]> = [];
  const publications: Array<{ status: string; error?: string }> = [];
  const context = vm.createContext({
    Error,
    JSON,
    Number,
    PortableAuthorityUnavailableError: Error,
    config: { directory: "root", nonce: request.nonce, platform: "posix" },
    controlPath: "root/control.json",
    fencePath: "root/fence.json",
    handledControl: 0,
    join,
    lockHolderPath: "root/lock-holder.json",
    posixAnchorExited: true,
    posixControlInspectionDeferred: false,
    posixControlInspectionFailures: 0,
    posixControlInspectionDetail: "",
    posixDeferredControlSignature: null,
    POSIX_CONTROL_INSPECTION_FAILURE_LIMIT: 3,
    posixForceControlApplied: false,
    posixRecordedMembers: new Map([[9003, "descendant-birth"]]),
    posixSupervisorBirth: "supervisor-birth",
    posixWorkloadGroup: workloadGroup,
    process: {
      pid: 9001,
      kill: (pid: number, signal: NodeJS.Signals) => { signals.push([pid, signal]); },
    },
    publish: (status: string, error?: string) => { publications.push({ status, error }); },
    reattestOwnedPosixAnchor: () => ({ state: "outcome_unknown" }),
    reattestOwnedPosixDescendants: () => ({ state: "empty" }),
    readFileSync: (path: string) => {
      const normalized = path.replace(/\\/g, "/");
      if (normalized === "root/control.json") return JSON.stringify(request);
      if (normalized === "root/fence.json") return JSON.stringify({ nonce: request.nonce, ownerId: request.ownerId, fencingToken: request.fencingToken });
      if (normalized === "root/lock-holder.json") return JSON.stringify({ nonce: request.nonce, holderPid: 9001, holderBirth: "supervisor-birth" });
      throw new Error(`unexpected synthetic read ${path}`);
    },
    runPortableFenceEffectSync: (options: { effect: () => unknown }) => ({ status: "applied", value: options.effect() }),
    settlePortableSupervisorCommand,
    signalOwnedPosixGroup,
    existsSync: (path: string) => path.replace(/\\/g, "/") === "root/control.json",
    unlinkSync: () => undefined,
  });
  vm.runInContext(`${extractNamedFunction(supervisorSource, "readCurrentFence")}\n${extractNamedFunction(supervisorSource, "readCurrentFenceStrict")}\n${extractFenceEffectFunctions(supervisorSource)}\n${extractNamedFunction(supervisorSource, "completeControl")}\n${extractNamedFunction(supervisorSource, "handleControl")}`, context);
  vm.runInContext("handleControl()", context);
  assert.deepEqual(signals, [], "an empty recorded group must not be signalled by numeric PGID");
  assert.equal(vm.runInContext("posixForceControlApplied", context), true, "an empty exact descendant snapshot is applied force without a destructive signal");
  assert.equal(publications.some(({ error }) => /numeric-only group control/i.test(error ?? "")), false);
});

test("C4 POSIX fixture finalizer fails closed and retains its exact authority on force failure", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-posix-c4-live-finalizer-"));
  const directory = join(root, "owned-fixture");
  mkdirSync(directory, { recursive: true });
  let releaseCalled = false;
  const backend: Pick<ProcessBackend, "signal" | "release"> = {
    signal: async () => { throw new Error("synthetic force cleanup failure"); },
    release: async () => { releaseCalled = true; return { released: true }; },
  };
  try {
    await assert.rejects(
      finalizePosixLiveFixture(backend, portableBinding(directory, "fixture-birth"), fence, root, directory),
      (error: unknown) => error instanceof AggregateError && /retained exact authority/i.test(error.message),
    );
    assert.equal(releaseCalled, false, "a failed force cleanup must not erase the retained authority through release");
    assert.equal(existsSync(directory), true, "cleanup failure must retain the exact owned authority directory");
    assert.equal(existsSync(root), true, "cleanup failure must retain the exact fixture root for diagnosis");
  } finally {
    removeFixtureRoot(root);
  }
});

test("C4 POSIX fixture finalizer retains its exact authority on release failure", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-posix-c4-live-release-failure-"));
  const directory = join(root, "owned-fixture");
  mkdirSync(directory, { recursive: true });
  let forceCalled = false;
  let releaseCalled = false;
  const backend: Pick<ProcessBackend, "signal" | "release"> = {
    signal: async () => { forceCalled = true; return { state: "exited" }; },
    release: async () => { releaseCalled = true; throw new Error("synthetic release cleanup failure"); },
  };
  try {
    await assert.rejects(
      finalizePosixLiveFixture(backend, portableBinding(directory, "fixture-birth"), fence, root, directory),
      (error: unknown) => error instanceof AggregateError,
    );
    assert.equal(forceCalled, true, "release cleanup is attempted only after force cleanup succeeds");
    assert.equal(releaseCalled, true, "release failure must remain observable");
    assert.equal(existsSync(directory), true, "release failure must retain the exact owned authority directory");
    assert.equal(existsSync(root), true, "release failure must retain the exact fixture root for diagnosis");
  } finally {
    removeFixtureRoot(root);
  }
});

test("C4 POSIX fixture finalizer rejects a release that leaves owned authority behind", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-posix-c4-live-retained-authority-"));
  const directory = join(root, "owned-fixture");
  mkdirSync(directory, { recursive: true });
  let forceCalled = false;
  let releaseCalled = false;
  const backend: Pick<ProcessBackend, "signal" | "release"> = {
    signal: async () => { forceCalled = true; return { state: "exited" }; },
    release: async () => { releaseCalled = true; return { released: true }; },
  };
  try {
    await assert.rejects(
      finalizePosixLiveFixture(backend, portableBinding(directory, "fixture-birth"), fence, root, directory),
      /release returned without retiring/i,
    );
    assert.equal(forceCalled, true);
    assert.equal(releaseCalled, true);
    assert.equal(existsSync(directory), true, "a misleading release result must not erase authority evidence");
    assert.equal(existsSync(root), true, "a misleading release result must not erase fixture evidence");
  } finally {
    removeFixtureRoot(root);
  }
});

test("C4 POSIX fixture finalizer retains its exact authority when channel settlement or detachment fails", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-posix-c4-live-channel-failure-"));
  const directory = join(root, "owned-fixture");
  mkdirSync(directory, { recursive: true });
  let forceCalled = false;
  let releaseCalled = false;
  const backend: Pick<ProcessBackend, "signal" | "release"> = {
    signal: async () => { forceCalled = true; return { state: "exited" }; },
    release: async () => { releaseCalled = true; rmSync(directory, { recursive: true, force: true }); return { released: true }; },
  };
  try {
    await assert.rejects(
      finalizePosixLiveFixture(
        backend,
        portableBinding(directory, "fixture-birth"),
        fence,
        root,
        directory,
        async () => { throw new Error("synthetic channel settlement or detachment failure"); },
      ),
      (error: unknown) => error instanceof AggregateError && /channel.*retained exact authority/i.test(error.message),
    );
    assert.equal(forceCalled, true, "channel finalization starts only after force cleanup succeeds");
    assert.equal(releaseCalled, false, "a failed channel finalizer must not erase the retained authority through release");
    assert.equal(existsSync(directory), true, "channel finalization failure must retain the exact owned authority directory");
    assert.equal(existsSync(root), true, "channel finalization failure must retain the exact fixture root for diagnosis");
  } finally {
    removeFixtureRoot(root);
  }
});

test("C4 POSIX fixture finalizer deletes only its exact root after confirmed release", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-posix-c4-live-success-"));
  const directory = join(root, "owned-fixture");
  mkdirSync(directory, { recursive: true });
  const calls: string[] = [];
  const backend: Pick<ProcessBackend, "signal" | "release"> = {
    signal: async () => { calls.push("force"); return { state: "exited" }; },
    release: async () => {
      calls.push("release");
      rmSync(directory, { recursive: true, force: true });
      return { released: true };
    },
  };
  try {
    await finalizePosixLiveFixture(
      backend,
      portableBinding(directory, "fixture-birth"),
      fence,
      root,
      directory,
      async () => { calls.push("channel"); },
    );
    assert.deepEqual(calls, ["force", "channel", "release"]);
    assert.equal(existsSync(directory), false);
    assert.equal(existsSync(root), false, "the exact fixture root is deleted only after authority retirement");
  } finally {
    removeFixtureRoot(root);
  }
});

test("C4 POSIX fixture finalizer refuses an authority target outside its exact namespace", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-posix-c4-live-unsafe-root-"));
  const unsafeDirectory = mkdtempSync(join(tmpdir(), "aiboard-posix-c4-unsafe-authority-"));
  let forceCalled = false;
  let releaseCalled = false;
  const backend: Pick<ProcessBackend, "signal" | "release"> = {
    signal: async () => { forceCalled = true; return { state: "exited" }; },
    release: async () => { releaseCalled = true; return { released: true }; },
  };
  try {
    await assert.rejects(
      finalizePosixLiveFixture(backend, portableBinding(unsafeDirectory, "fixture-birth"), fence, root, unsafeDirectory),
      /outside its exact temporary namespace/i,
    );
    assert.equal(forceCalled, false, "unsafe target refusal must happen before force control");
    assert.equal(releaseCalled, false, "unsafe target refusal must happen before release control");
    assert.equal(existsSync(root), true);
    assert.equal(existsSync(unsafeDirectory), true, "unsafe authority target must never be deleted by the fixture");
  } finally {
    removeFixtureRoot(root);
    removeFixtureRoot(unsafeDirectory);
  }
});

test("POSIX v1 contracts remain observable but block active destructive control", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-posix-contract-"));
  const signals: Array<[number, NodeJS.Signals]> = [];
  let members: readonly number[] | undefined;
  const operations: NativeProcessOperations = {
    inspectProcessBirth: () => ({ state: "present", fingerprint: "supervisor-birth" }),
    listPosixGroup: () => members,
    signal: (pid, signal) => { signals.push([pid, signal]); },
  };
  const backend = createPosixProcessBackend({ stateDirectory: root, operations });
  const binding = portableBinding(root, "supervisor-birth");
  writeFileSync(join(root, "state.json"), JSON.stringify({
    protocol: "aiboard-portable-process/v1",
    nonce: "contract-nonce",
    supervisorPid: 9001,
    childPid: 9002,
    revision: 1,
    handledControl: 0,
    status: "running",
    exitCode: null,
    signal: null,
    knownProcesses: [],
    error: null,
    updatedAt: "2026-01-01T00:00:00.000Z",
  }));
  try {
    const unknown = parseProcessEmptyVerification(await backend.verifyEmpty(binding, fence));
    assert.equal(unknown.empty, false);
    assert.match(unknown.empty ? "" : unknown.detail, /enumerat|unknown|verify/i);
    await assert.rejects(backend.release(binding, fence), /verify|unknown|empty/i);

    members = [9001, 9002];
    assert.equal(parseProcessEmptyVerification(await backend.verifyEmpty(binding, fence)).empty, false);
    assert.deepEqual(parseProcessReconciliation(await backend.reconcile(binding, fence)), { state: "running" });

    const terminate = await backend.signal(binding, "terminate", fence).then(() => undefined, (error: unknown) => error);
    const force = await backend.signal(binding, "force_terminate", fence).then(() => undefined, (error: unknown) => error);
    assert.deepEqual(signals, [], "v1 observation must never reinterpret the supervisor group as a workload group");
    assert.ok(terminate instanceof Error);
    assert.match(terminate.message, /legacy|workload group/i);
    assert.ok(force instanceof Error);
    assert.match(force.message, /legacy|workload group/i);
  } finally {
    removeFixtureRoot(root);
  }
});

test("POSIX validates birth identity before any group signal", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-posix-identity-"));
  const signals: number[] = [];
  const operations: NativeProcessOperations = {
    inspectProcessBirth: () => ({ state: "present", fingerprint: "recycled-birth" }),
    listPosixGroup: () => [9001],
    signal: (pid) => { signals.push(pid); },
  };
  const backend = createPosixProcessBackend({ stateDirectory: root, operations });
  try {
    await assert.rejects(backend.signal(portableBinding(root, "owned-birth"), "terminate", fence), /identity/i);
    assert.deepEqual(signals, []);
  } finally {
    removeFixtureRoot(root);
  }
});

test("POSIX v1 refuses active control after its supervisor exits with members remaining", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-posix-dead-signal-"));
  const signals: Array<[number, NodeJS.Signals]> = [];
  let live = true;
  const backend = createPosixProcessBackend({ stateDirectory: root, operations: {
    inspectProcessBirth: () => ({ state: "absent" }),
    listPosixGroup: () => live ? [9002] : [],
    signal: (pid, signal) => { signals.push([pid, signal]); live = false; },
  } });
  try {
    await assert.rejects(backend.signal(portableBinding(root, "supervisor-birth"), "terminate", fence), /supervisor exited|retirement/i);
    assert.deepEqual(signals, [], "an exited v1 witness must not permit numeric-only group control");
  } finally { removeFixtureRoot(root); }
});

test("POSIX terminal proof permits fenced empty verification and release without Windows tree records", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-posix-terminal-contract-"));
  for (const path of ["channel/output", "channel/input", "channel/ack"]) mkdirSync(join(root, path), { recursive: true });
  writeFileSync(join(root, "stdout.log"), "");
  writeFileSync(join(root, "stderr.log"), "");
  writeFileSync(join(root, "state.json"), JSON.stringify({ protocol: "aiboard-portable-process/v1", nonce: "contract-nonce", supervisorPid: 9001, revision: 2, handledControl: 0, status: "stopped", exitCode: 0, signal: null, launchEffect: "started", rootProcess: null, knownProcesses: [], error: null }));
  writeFileSync(join(root, "channel/output-checkpoint.json"), JSON.stringify({ nonce: "contract-nonce", stdout: { sequence: 0, endOffset: 0 }, stderr: { sequence: 0, endOffset: 0 } }));
  const operations: NativeProcessOperations = { inspectProcessBirth: () => ({ state: "absent" }), listPosixGroup: () => [], signal: () => assert.fail("terminal contract must not signal") };
  const backend = createPosixProcessBackend({ stateDirectory: root, operations });
  const binding = portableBinding(root, "supervisor-birth");
  try {
    assert.equal(parseProcessEmptyVerification(await backend.verifyEmpty(binding, fence)).empty, true);
    assert.deepEqual(await backend.release(binding, fence), { released: true });
    assert.equal(existsSync(root), false);
  } finally { removeFixtureRoot(root); }
});

test("POSIX v1 launch rollback retains active authority rather than killing its witness group", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-posix-launch-rollback-"));
  const signals: Array<[number, NodeJS.Signals]> = [];
  let signalled = false;
  let postSignalChecks = 0;
  const operations: NativeProcessOperations = {
    inspectProcessBirth: () => ({ state: "present", fingerprint: "supervisor-birth" }),
    listPosixGroup: () => {
      if (!signalled) return [9001, 9002];
      postSignalChecks += 1;
      return postSignalChecks === 2 ? [9002] : [];
    },
    signal: (pid, signal) => {
      signals.push([pid, signal]);
      signalled = true;
    },
  };
  const backend = createPosixProcessBackend({ stateDirectory: root, pollIntervalMs: 10, operations });
  const rollback = backend as unknown as {
    cleanupFailedLaunch(identity: {
      version: 1;
      backendId: string;
      nonce: string;
      directory: string;
      supervisorPid: number;
      supervisorBirth: string;
    }): Promise<void>;
  };
  try {
    await assert.rejects(rollback.cleanupFailedLaunch({
      version: 1,
      backendId: "runner-posix-process-group-v1",
      nonce: "rollback-nonce",
      directory: root,
      supervisorPid: 9001,
      supervisorBirth: "supervisor-birth",
    }), /legacy POSIX|retained/i);
    assert.deepEqual(signals, []);
    assert.equal(postSignalChecks, 0);
  } finally {
    removeFixtureRoot(root);
  }
});

test("POSIX v1 launch rollback retains authority after supervisor exit rather than resignal numerically", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-posix-dead-supervisor-"));
  const signals: Array<[number, NodeJS.Signals]> = [];
  let signalled = false;
  const operations: NativeProcessOperations = {
    inspectProcessBirth: () => ({ state: "absent" }),
    listPosixGroup: () => signalled ? [] : [9002],
    signal: (pid, signal) => {
      signals.push([pid, signal]);
      signalled = true;
    },
  };
  const backend = createPosixProcessBackend({ stateDirectory: root, pollIntervalMs: 10, operations });
  const rollback = backend as unknown as {
    cleanupFailedLaunch(identity: {
      version: 1;
      backendId: string;
      nonce: string;
      directory: string;
      supervisorPid: number;
      supervisorBirth: string;
    }): Promise<void>;
  };
  try {
    await assert.rejects(rollback.cleanupFailedLaunch({
      version: 1,
      backendId: "runner-posix-process-group-v1",
      nonce: "rollback-nonce",
      directory: root,
      supervisorPid: 9001,
      supervisorBirth: "supervisor-birth",
    }), /legacy POSIX|retained/i);
    assert.deepEqual(signals, []);
  } finally {
    removeFixtureRoot(root);
  }
});

test("C4 POSIX v2 launch rollback rechecks the durable fence before queuing workload control", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-posix-cleanup-fence-"));
  const original = { ownerId: "launch-owner", fencingToken: 1 } as const;
  const workloadGroup = { groupId: 9002, leaderPid: 9002, leaderBirth: "anchor-birth" } as const;
  let inspections = 0; const signals: number[] = [];
  writeFileSync(join(root, "fence.json"), JSON.stringify({ nonce: "rollback-nonce", ...original }));
  writeFileSync(join(root, "state.json"), JSON.stringify({
    protocol: "aiboard-portable-process/v2", nonce: "rollback-nonce", supervisorPid: 9001,
    supervisorBirth: "supervisor-birth", workloadGroup, workloadGroupRetirement: { state: "active" },
    launchEffect: "started", rootProcess: null, revision: 1, handledControl: 0, status: "running",
    exitCode: null, signal: null, knownProcesses: [], error: null, updatedAt: "2026-09-06T00:00:00.000Z",
  }));
  const operations: NativeProcessOperations = {
    inspectProcessBirth: (pid) => {
      inspections += 1;
      if (inspections === 1) writeFileSync(join(root, "fence.json"), JSON.stringify({ nonce: "rollback-nonce", ownerId: "takeover", fencingToken: 2 }));
      return pid === 9001 ? { state: "present", fingerprint: "supervisor-birth" } : { state: "present", fingerprint: "anchor-birth" };
    },
    listPosixGroup: () => [9002],
    signal: (pid) => { signals.push(pid); },
  };
  const backend = createPosixProcessBackend({ stateDirectory: root, operations });
  const rollback = backend as unknown as { cleanupFailedLaunch(identity: { version: 2; backendId: string; nonce: string; directory: string; supervisorPid: number; supervisorBirth: string; workloadGroup: typeof workloadGroup; fence: typeof original }): Promise<void> };
  try {
    await assert.rejects(rollback.cleanupFailedLaunch({ version: 2, backendId: "runner-posix-process-group-v1", nonce: "rollback-nonce", directory: root, supervisorPid: 9001, supervisorBirth: "supervisor-birth", workloadGroup, fence: original }), /fence|stale|identity/i);
    assert.deepEqual(signals, []);
    assert.equal(existsSync(join(root, "control.json")), false);
  } finally { removeFixtureRoot(root); }
});

test("portable POSIX control maps only an explicit workload group to fixed signals", async () => {
  const { signalOwnedPosixGroup } = await import("../src/portable-process-posix-control.mjs");
  const effects: Array<[number, NodeJS.Signals]> = [];
  signalOwnedPosixGroup("terminate", (pid: number, signal: NodeJS.Signals) => { effects.push([pid, signal]); return true; }, 9001);
  signalOwnedPosixGroup("force_terminate", (pid: number, signal: NodeJS.Signals) => { effects.push([pid, signal]); return true; }, 9001);
  assert.deepEqual(effects, [[-9001, "SIGTERM"], [-9001, "SIGKILL"]]);
  assert.throws(() => signalOwnedPosixGroup("terminate", (pid: number, signal: NodeJS.Signals) => { effects.push([pid, signal]); }, 0), /identity/i);
  assert.doesNotThrow(() => signalOwnedPosixGroup("force_terminate", () => {
    throw Object.assign(new Error("kill ESRCH"), { code: "ESRCH" });
  }, 9001));
  assert.throws(() => signalOwnedPosixGroup("force_terminate", () => {
    throw Object.assign(new Error("kill EPERM"), { code: "EPERM" });
  }, 9001), { code: "EPERM" });
});

const fence = { ownerId: "test-owner", fencingToken: 1 } as const;
function removeFixtureRoot(root: string): void {
  rmSync(root, { recursive: true, force: true, maxRetries: 30, retryDelay: 50 });
  rmSync(`${root}.fence.lock`, { force: true, maxRetries: 30, retryDelay: 50 });
  assert.equal(existsSync(root), false);
  assert.equal(existsSync(`${root}.fence.lock`), false);
}
async function finalizePosixLiveFixture(
  backend: Pick<ProcessBackend, "signal" | "release">,
  binding: ReturnType<typeof portableBinding>,
  effectFence: typeof fence,
  root: string,
  authorityDirectory: string,
  settleAndDetachChannel?: () => Promise<void>,
): Promise<void> {
  const resolvedRoot = resolve(root);
  const resolvedDirectory = resolve(authorityDirectory);
  if (dirname(resolvedRoot) !== resolve(tmpdir()) || !basename(resolvedRoot).startsWith("aiboard-posix-c4-live-") ||
      dirname(resolvedDirectory) !== resolvedRoot || !basename(resolvedDirectory).startsWith("owned-"))
    throw new Error("POSIX live fixture cleanup target is outside its exact temporary namespace.");
  try {
    await backend.signal(binding, "force_terminate", effectFence);
  } catch (error) {
    if (!existsSync(resolvedDirectory))
      throw new AggregateError([error], "POSIX live fixture force cleanup failed without retained exact authority.");
    throw new AggregateError([error], `POSIX live fixture force cleanup failed; retained exact authority at ${resolvedDirectory}.`);
  }
  if (settleAndDetachChannel) {
    try {
      await settleAndDetachChannel();
    } catch (error) {
      if (!existsSync(resolvedDirectory))
        throw new AggregateError([error], "POSIX live fixture channel cleanup failed without retained exact authority.");
      throw new AggregateError([error], `POSIX live fixture channel cleanup failed; retained exact authority at ${resolvedDirectory}.`);
    }
  }
  try {
    await releasePosixLiveFixtureAuthority(backend, binding, effectFence, Date.now() + 5_000);
  } catch (error) {
    if (!existsSync(resolvedDirectory))
      throw new AggregateError([error], "POSIX live fixture release failed without retained exact authority.");
    throw new AggregateError([error], `POSIX live fixture release failed; retained exact authority at ${resolvedDirectory}.`);
  }
  if (existsSync(resolvedDirectory))
    throw new Error("POSIX live fixture release returned without retiring its exact authority directory.");
  rmSync(resolvedRoot, { recursive: true, force: true, maxRetries: 30, retryDelay: 50 });
  if (existsSync(resolvedRoot)) throw new Error("POSIX live fixture root remained after successful exact cleanup.");
}
async function waitForPosixLiveFixtureCondition(
  condition: () => boolean,
  deadlineAt: number,
  failure: string,
): Promise<void> {
  while (!condition()) {
    if (Date.now() >= deadlineAt) throw new Error(failure);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
async function releasePosixLiveFixtureAuthority(
  backend: Pick<ProcessBackend, "release">,
  binding: ReturnType<typeof bindingFor>,
  effectFence: typeof fence,
  deadlineAt: number,
): Promise<void> {
  for (;;) {
    try {
      await backend.release(binding, effectFence);
      return;
    } catch (error) {
      if (!(error instanceof ProcessReleasePendingError) || Date.now() >= deadlineAt) throw error;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
}
function request(args: string[]) {
  return {
    intent: {
      invocationId: "posix-native",
      runId: "run",
      kind: "command" as const,
      executable: process.execPath,
      arguments: args,
      workingDirectory: process.cwd(),
      requiredLifecycleScope: "process_group" as const,
      requestedCapabilities: [] as const,
    },
    grant: {
      grantId: "grant",
      runId: "run",
      invocationId: "posix-native",
      issuedAt: new Date().toISOString(),
      access: [],
    },
    environment: fixtureEnvironment(),
    outputOwnerId: "output",
    fence,
  };
}
function fixtureEnvironment(): Record<string, string> {
  const allowed = new Set(["systemroot", "windir", "comspec", "path", "pathext", "temp", "tmp"]);
  return Object.fromEntries(Object.entries(process.env).filter(([key, value]) => allowed.has(key.toLowerCase()) && value !== undefined)) as Record<string, string>;
}
function bindingFor(launch: ProcessLaunchResult) {
  return {
    registryId: "registry",
    backendId: "runner-posix-process-group-v1",
    implementationGeneration: "generation",
    implementationDigest: "1".repeat(64),
    attestationVersion: 1,
    attestationDigest: "2".repeat(64),
    ...launch,
  };
}

function portableBinding(directory: string, birth: string) {
  const identity = {
    version: 1,
    backendId: "runner-posix-process-group-v1",
    nonce: "contract-nonce",
    directory,
    supervisorPid: 9001,
    supervisorBirth: birth,
  };
  return bindingFor({
    opaqueIdentity: Buffer.from(JSON.stringify(identity)).toString("base64url"),
    birthFingerprint: {
      observedAt: "2026-01-01T00:00:00.000Z",
      discriminator: createHash("sha256").update(`contract-nonce\0${birth}`).digest("hex"),
    },
    rootPid: 9001,
    startedAt: "2026-01-01T00:00:00.000Z",
  });
}

function portableV2Binding(
  directory: string,
  nonce: string,
  supervisorBirth: string,
  workloadGroup: { readonly groupId: number; readonly leaderPid: number; readonly leaderBirth: string },
) {
  const identity = {
    version: 2,
    backendId: "runner-posix-process-group-v1",
    nonce,
    directory,
    supervisorPid: 9001,
    supervisorBirth,
    workloadGroup,
    fence,
  } as const;
  return bindingFor({
    opaqueIdentity: Buffer.from(JSON.stringify(identity)).toString("base64url"),
    birthFingerprint: {
      observedAt: "2026-09-06T00:00:00.000Z",
      discriminator: createHash("sha256")
        .update(`${nonce}\0${supervisorBirth}\0${workloadGroup.groupId}\0${workloadGroup.leaderPid}\0${workloadGroup.leaderBirth}`)
        .digest("hex"),
    },
    rootPid: 9001,
    startedAt: "2026-09-06T00:00:00.000Z",
  });
}

function findNamedFile(root: string, name: string): string | undefined {
  if (!existsSync(root)) return undefined;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const candidate = join(root, entry.name);
    if (entry.isFile() && entry.name === name) return candidate;
    if (entry.isDirectory()) {
      const nested = findNamedFile(candidate, name);
      if (nested) return nested;
    }
  }
  return undefined;
}
function extractOptionalNamedFunction(source: string, name: string): string {
  const file = ts.createSourceFile("portable-process-supervisor.mjs", source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.JS);
  const declaration = file.statements.find((statement): statement is ts.FunctionDeclaration =>
    ts.isFunctionDeclaration(statement) && statement.name?.text === name,
  );
  return declaration?.getText(file) ?? "";
}
function extractTickPosix(source: string): string {
  return `function recordOwnedPosixMembers() {}\n${extractNamedFunction(source, "tickPosix")}`;
}
function extractFenceEffectFunctions(source: string): string {
  return `const FENCE_HOLDER_READ_RETRY_MS = 250;\nconst FENCE_HOLDER_READ_RETRY_DELAY_MS = 5;\n${extractNamedFunction(source, "readFenceHolderForEffect")}\n${extractNamedFunction(source, "withCurrentFenceEffect")}`;
}
function extractNamedTsFunction(source: string, name: string): string {
  const file = ts.createSourceFile("native-process-backend.ts", source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
  const declaration = file.statements.find((statement): statement is ts.FunctionDeclaration =>
    ts.isFunctionDeclaration(statement) && statement.name?.text === name,
  );
  if (!declaration) throw new Error(`missing production function ${name}`);
  return ts.transpileModule(declaration.getText(file), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText;
}
function extractNamedFunction(source: string, name: string): string {
  const file = ts.createSourceFile("portable-process-supervisor.mjs", source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.JS);
  const declaration = file.statements.find((statement): statement is ts.FunctionDeclaration =>
    ts.isFunctionDeclaration(statement) && statement.name?.text === name,
  );
  if (!declaration) throw new Error(`missing production function ${name}`);
  return declaration.getText(file);
}
