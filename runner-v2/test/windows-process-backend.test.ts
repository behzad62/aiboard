import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import {
  createWindowsProcessBackend,
  WindowsBatchLaunchUnavailableError,
  WindowsJobObjectProcessBackend,
  WindowsProcessBackend,
  type WindowsJobProcessService,
} from "../src/windows-process-backend.js";
import { ManagedProcessService } from "../src/managed-process.js";
import { createWindowsJobProcessHost, WindowsJobHostError } from "../src/windows-job-process-host.js";
import { NativeProcessLaunchBlockedError, type NativeProcessOperations } from "../src/native-process-backend.js";
import { probeProcessHostSemantics } from "../src/process-host-semantic-probes.js";
import {
  parseProcessEmptyVerification,
  parseProcessLaunchResult,
  parseProcessReconciliation,
  parseProcessSignalResult,
  type ProcessBackend,
  type ProcessBackendBinding,
  type ProcessLaunchResult,
  type ProcessEffectFence,
} from "../src/process-backend.js";

test("portable and Job fence owners share the crash-recoverable exact-identity lock authority", () => {
  const native = readFileSync(join(process.cwd(), "runner-v2", "src", "native-process-backend.ts"), "utf8");
  const supervisor = readFileSync(join(process.cwd(), "runner-v2", "src", "portable-process-supervisor.mjs"), "utf8");
  const job = readFileSync(join(process.cwd(), "runner-v2", "src", "windows-job-process-host.ts"), "utf8");
  assert.equal((native.match(/withOwnedFenceLockSync\(lock,/g) ?? []).length, 2);
  assert.equal((supervisor.match(/withOwnedFenceLockSync\(lock,/g) ?? []).length, 1);
  assert.equal((job.match(/withOwnedFenceLock\(lockPath,/g) ?? []).length, 2);
  for (const source of [native, supervisor, job]) assert.doesNotMatch(source, /openSync\(lock(?:Path)?,\s*["']wx["']/);
});

test("Windows Job supervisor request classifies a partial response reset through durable stopped proof", { timeout: 10_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-windows-job-reset-"));
  const stateDirectory = join(root, "state");
  const processId = "job-reset";
  const ownedDirectory = join(stateDirectory, processId);
  mkdirSync(ownedDirectory, { recursive: true });
  const statusPath = join(ownedDirectory, "supervisor.jsonl");
  const stdoutPath = join(ownedDirectory, "stdout.log");
  const stderrPath = join(ownedDirectory, "stderr.log");
  writeFileSync(stdoutPath, "");
  writeFileSync(stderrPath, "");
  const startedAt = new Date().toISOString();
  const token = "t".repeat(64);
  const server = createServer((request, response) => {
    request.once("error", () => undefined);
    request.once("aborted", () => undefined);
    response.once("error", () => undefined);
    response.socket?.once("error", () => undefined);
    writeFileSync(statusPath, `${JSON.stringify({ protocol: "aiboard-managed-process/v1", processId, supervisorPid: process.pid, childPid: 0, port: (server.address() as { port: number }).port, status: "stopped", exitCode: 0, signal: null, error: null, ownershipReleased: true, updatedAt: new Date().toISOString(), retainedOutputChunks: 0, retainedOutputBytes: 0 })}\n`);
    response.writeHead(200, { "content-type": "application/json" });
    response.write('{"partial":');
    response.flushHeaders();
    const socket = response.socket;
    setTimeout(() => socket?.destroy(), 25);
  });
  await new Promise<void>((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
  const port = (server.address() as { port: number }).port;
  writeFileSync(statusPath, `${JSON.stringify({ protocol: "aiboard-managed-process/v1", processId, supervisorPid: process.pid, childPid: process.pid, port, status: "running", exitCode: null, signal: null, error: null, ownershipReleased: false, updatedAt: startedAt, retainedOutputChunks: 0, retainedOutputBytes: 0 })}\n`);
  writeFileSync(join(stateDirectory, `${processId}.json`), JSON.stringify({
    processId, runId: "run-reset", sessionId: "session-reset", pid: process.pid,
    command: process.execPath, args: [], cwd: root, environmentKeys: [], startedAt,
    updatedAt: startedAt, status: "running", exitCode: null, signal: null,
    stdoutPath, stderrPath,
    supervisor: { protocol: "aiboard-managed-process/v1", token, statusPath, supervisorPid: process.pid, port },
    currentFence: fence,
  }));
  try {
    const host = createWindowsJobProcessHost({ stateDirectory, platform: "win32", stopDeadlineMs: 1_000 });
    const snapshot = await host.reconcileOwned(processId, { runId: "run-reset", sessionId: "session-reset" }, fence);
    assert.equal(snapshot.status, "stopped");
    assert.equal(snapshot.ownershipReleased, true);
  } finally {
    await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
    rmSync(root, { recursive: true, force: true, maxRetries: 30, retryDelay: 50 });
  }
});

test("Windows Job durable release refuses stale post-release fence resurrection without coordination residue", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-windows-job-retired-fence-"));
  const processId = "job-retired-fence";
  const ownedDirectory = join(root, processId);
  mkdirSync(ownedDirectory, { recursive: true });
  const startedAt = new Date().toISOString();
  const statusPath = join(ownedDirectory, "supervisor.jsonl");
  const stdoutPath = join(ownedDirectory, "stdout.log");
  const stderrPath = join(ownedDirectory, "stderr.log");
  writeFileSync(stdoutPath, ""); writeFileSync(stderrPath, "");
  writeFileSync(statusPath, `${JSON.stringify({
    protocol: "aiboard-managed-process/v1", processId, supervisorPid: process.pid, childPid: 0, port: 0,
    status: "stopped", exitCode: 0, signal: null, error: null, ownershipReleased: true,
    updatedAt: startedAt, retainedOutputChunks: 0, retainedOutputBytes: 0,
  })}\n`);
  writeFileSync(join(root, `${processId}.json`), JSON.stringify({
    processId, runId: "run-retired", sessionId: "session-retired", pid: 0,
    command: process.execPath, args: [], cwd: root, environmentKeys: [], startedAt, updatedAt: startedAt,
    status: "stopped", exitCode: 0, signal: null, stdoutPath, stderrPath, interactive: true,
    outputOffsets: { stdout: 0, stderr: 0 }, outputSequences: { stdout: 0, stderr: 0 },
    supervisor: { protocol: "aiboard-managed-process/v1", token: "t".repeat(64), statusPath, supervisorPid: process.pid, port: 0 },
    currentFence: fence,
  }));
  const owner = { runId: "run-retired", sessionId: "session-retired" };
  const higher = { ownerId: "later-stale-owner", fencingToken: 2 };
  const lockPath = join(root, `${processId}.fence.lock`);
  try {
    const host = createWindowsJobProcessHost({ stateDirectory: root, platform: "win32" });
    assert.equal((await host.releaseOwned(processId, owner, startedAt, fence)).ownershipReleased, true);
    assert.equal(existsSync(lockPath), false);
    await assert.rejects(host.claimOwnedFence!(processId, owner, higher), /released|inactive|ownership/i);
    await assert.rejects(host.reconcileOwned(processId, owner, higher), /released|inactive|ownership/i);
    assert.equal(existsSync(lockPath), false, "stale post-release callers must not recreate the coordination database");
    for (const suffix of ["-journal", "-wal", "-shm"]) assert.equal(existsSync(`${lockPath}${suffix}`), false);
  } finally { rmSync(root, { recursive: true, force: true, maxRetries: 30, retryDelay: 50 }); }
});

test("Windows Job exact release recovers a durable tombstone after SQLite holder finalization fails", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-windows-job-release-recovery-"));
  const processId = "job-release-recovery";
  const ownedDirectory = join(root, processId);
  mkdirSync(ownedDirectory, { recursive: true });
  const startedAt = new Date().toISOString();
  const statusPath = join(ownedDirectory, "supervisor.jsonl");
  const stdoutPath = join(ownedDirectory, "stdout.log");
  const stderrPath = join(ownedDirectory, "stderr.log");
  writeFileSync(stdoutPath, ""); writeFileSync(stderrPath, "");
  writeFileSync(statusPath, `${JSON.stringify({
    protocol: "aiboard-managed-process/v1", processId, supervisorPid: process.pid, childPid: 0, port: 0,
    status: "stopped", exitCode: 0, signal: null, error: null, ownershipReleased: true,
    updatedAt: startedAt, retainedOutputChunks: 0, retainedOutputBytes: 0,
  })}\n`);
  writeFileSync(join(root, `${processId}.json`), JSON.stringify({
    processId, runId: "run-release-recovery", sessionId: "session-release-recovery", pid: 0,
    command: process.execPath, args: [], cwd: root, environmentKeys: [], startedAt, updatedAt: startedAt,
    status: "stopped", exitCode: 0, signal: null, stdoutPath, stderrPath, interactive: true,
    outputOffsets: { stdout: 0, stderr: 0 }, outputSequences: { stdout: 0, stderr: 0 },
    supervisor: { protocol: "aiboard-managed-process/v1", token: "r".repeat(64), statusPath, supervisorPid: process.pid, port: 0 },
    currentFence: fence,
  }));
  const owner = { runId: "run-release-recovery", sessionId: "session-release-recovery" };
  const lockPath = join(root, `${processId}.fence.lock`);
  try {
    const host = createWindowsJobProcessHost({ stateDirectory: root, platform: "win32" });
    await host.claimOwnedFence!(processId, owner, fence);
    const fault = new DatabaseSync(lockPath);
    fault.exec("CREATE TRIGGER injected_release_delete_fault BEFORE DELETE ON owned_fence_holder BEGIN SELECT RAISE(ABORT, 'injected release holder finalization fault'); END;");
    fault.close();
    await assert.rejects(host.releaseOwned(processId, owner, startedAt, fence), /fence.*lock|finalization|unavailable/i);
    const releasedRecord = JSON.parse(readFileSync(join(root, `${processId}.json`), "utf8")) as { backendOwnershipReleasedAt?: string };
    assert.match(releasedRecord.backendOwnershipReleasedAt ?? "", /\S/);
    const retained = new DatabaseSync(lockPath);
    assert.equal(Number(retained.prepare("SELECT COUNT(*) AS count FROM owned_fence_holder").get()!.count), 1);
    retained.close();
    await assert.rejects(host.releaseOwned(processId, owner, startedAt, { ownerId: "foreign", fencingToken: fence.fencingToken }), /fence|identity|stale/i);
    await assert.rejects(host.releaseOwned(processId, { ...owner, sessionId: "foreign" }, startedAt, fence), /another session|owned/i);
    await assert.rejects(host.releaseOwned(processId, owner, new Date(Date.parse(startedAt) + 1).toISOString(), fence), /identity mismatch/i);
    const corrupt = new DatabaseSync(lockPath);
    corrupt.prepare("UPDATE owned_fence_protocol SET version = 99").run(); corrupt.close();
    await assert.rejects(host.releaseOwned(processId, owner, startedAt, fence), /protocol|corrupt|foreign|unavailable/i);
    assert.equal(existsSync(lockPath), true, "ambiguous protocol must preserve coordination evidence");
    const restored = new DatabaseSync(lockPath);
    restored.prepare("UPDATE owned_fence_protocol SET version = 1").run(); restored.close();
    const terminalStatus = readFileSync(statusPath, "utf8");
    writeFileSync(statusPath, `${JSON.stringify({
      protocol: "aiboard-managed-process/v1", processId, supervisorPid: process.pid, childPid: process.pid, port: 0,
      status: "running", exitCode: null, signal: null, error: null, ownershipReleased: false,
      updatedAt: startedAt, retainedOutputChunks: 0, retainedOutputBytes: 0,
    })}\n`);
    await assert.rejects(host.releaseOwned(processId, owner, startedAt, fence), /terminal|released|unavailable/i);
    assert.equal(existsSync(lockPath), true, "active nonreleased evidence must preserve coordination");
    writeFileSync(statusPath, terminalStatus);
    assert.equal((await host.releaseOwned(processId, owner, startedAt, fence)).ownershipReleased, true);
    assert.equal(existsSync(lockPath), false);
    for (const suffix of ["-journal", "-wal", "-shm"]) assert.equal(existsSync(`${lockPath}${suffix}`), false);
  } finally { rmSync(root, { recursive: true, force: true, maxRetries: 30, retryDelay: 50 }); }
});

test("Windows Job release rejects a substituted record before touching another process lock", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-windows-job-record-substitution-"));
  const requestedId = "requested-a";
  const targetId = "target-b";
  const startedAt = new Date().toISOString();
  const owner = { runId: "run-record-substitution", sessionId: "session-record-substitution" };
  const targetDirectory = join(root, targetId);
  mkdirSync(targetDirectory, { recursive: true });
  const statusPath = join(targetDirectory, "supervisor.jsonl");
  const stdoutPath = join(targetDirectory, "stdout.log");
  const stderrPath = join(targetDirectory, "stderr.log");
  writeFileSync(stdoutPath, ""); writeFileSync(stderrPath, "");
  writeFileSync(statusPath, `${JSON.stringify({
    protocol: "aiboard-managed-process/v1", processId: targetId, supervisorPid: process.pid,
    childPid: 0, port: 0, status: "stopped", exitCode: 0, signal: null, error: null,
    ownershipReleased: true, updatedAt: startedAt, retainedOutputChunks: 0, retainedOutputBytes: 0,
  })}\n`);
  const record = {
    processId: targetId, ...owner, pid: 0, command: process.execPath, args: [], cwd: root,
    environmentKeys: [], startedAt, updatedAt: startedAt, status: "stopped", exitCode: 0,
    signal: null, stdoutPath, stderrPath, interactive: true,
    outputOffsets: { stdout: 0, stderr: 0 }, outputSequences: { stdout: 0, stderr: 0 },
    supervisor: { protocol: "aiboard-managed-process/v1", token: "s".repeat(64), statusPath, supervisorPid: process.pid, port: 0 },
    currentFence: fence,
  };
  const targetRecordPath = join(root, `${targetId}.json`);
  const requestedRecordPath = join(root, `${requestedId}.json`);
  writeFileSync(targetRecordPath, JSON.stringify(record));
  const targetLockPath = join(root, `${targetId}.fence.lock`);
  try {
    const host = createWindowsJobProcessHost({ stateDirectory: root, platform: "win32" });
    await host.claimOwnedFence!(targetId, owner, fence);
    const releasedAt = new Date(Date.parse(startedAt) + 1).toISOString();
    const releasedRecord = { ...record, backendOwnershipReleasedAt: releasedAt, updatedAt: releasedAt };
    writeFileSync(targetRecordPath, JSON.stringify(releasedRecord));
    writeFileSync(requestedRecordPath, JSON.stringify(releasedRecord));
    const before = new DatabaseSync(targetLockPath);
    const beforeHolders = Number(before.prepare("SELECT COUNT(*) AS count FROM owned_fence_holder").get()!.count);
    before.close();
    await assert.rejects(host.releaseOwned(requestedId, owner, startedAt, fence), /process.*identity|record.*identity|mismatch/i);
    assert.equal(existsSync(targetLockPath), true, "the unrelated target coordination database must remain");
    const after = new DatabaseSync(targetLockPath);
    assert.equal(Number(after.prepare("SELECT COUNT(*) AS count FROM owned_fence_holder").get()!.count), beforeHolders);
    after.close();
    for (const suffix of ["-journal", "-wal", "-shm"])
      assert.equal(existsSync(`${targetLockPath}${suffix}`), false);
    assert.equal(readFileSync(targetRecordPath, "utf8"), JSON.stringify(releasedRecord));
  } finally { rmSync(root, { recursive: true, force: true, maxRetries: 30, retryDelay: 50 }); }
});

test("Windows Job release rejects hard-link and symbolic-link coordination aliases", async () => {
  for (const aliasKind of ["hard-link", "symbolic-link"] as const) {
    const root = mkdtempSync(join(tmpdir(), `aiboard-windows-job-${aliasKind}-alias-`));
    const owner = { runId: `run-${aliasKind}`, sessionId: `session-${aliasKind}` };
    const startedAt = new Date().toISOString();
    const requestedId = "requested-a";
    const targetId = "target-b";
    const writeRecord = (processId: string, released: boolean) => {
      const directory = join(root, processId); mkdirSync(directory);
      const statusPath = join(directory, "supervisor.jsonl");
      const stdoutPath = join(directory, "stdout.log");
      const stderrPath = join(directory, "stderr.log");
      writeFileSync(stdoutPath, ""); writeFileSync(stderrPath, "");
      writeFileSync(statusPath, `${JSON.stringify({
        protocol: "aiboard-managed-process/v1", processId, supervisorPid: process.pid,
        childPid: 0, port: 0, status: "stopped", exitCode: 0, signal: null, error: null,
        ownershipReleased: released, updatedAt: startedAt, retainedOutputChunks: 0, retainedOutputBytes: 0,
      })}\n`);
      writeFileSync(join(root, `${processId}.json`), JSON.stringify({
        processId, ...owner, pid: 0, command: process.execPath, args: [], cwd: root,
        environmentKeys: [], startedAt, updatedAt: startedAt, status: "stopped", exitCode: 0,
        signal: null, stdoutPath, stderrPath, interactive: true,
        outputOffsets: { stdout: 0, stderr: 0 }, outputSequences: { stdout: 0, stderr: 0 },
        supervisor: { protocol: "aiboard-managed-process/v1", token: "a".repeat(64), statusPath, supervisorPid: process.pid, port: 0 },
        currentFence: fence,
        ...(released ? { backendOwnershipReleasedAt: startedAt } : {}),
      }));
    };
    try {
      writeRecord(targetId, false);
      writeRecord(requestedId, true);
      const host = createWindowsJobProcessHost({ stateDirectory: root, platform: "win32" });
      await host.claimOwnedFence!(targetId, owner, fence);
      const targetLock = join(root, `${targetId}.fence.lock`);
      const requestedLock = join(root, `${requestedId}.fence.lock`);
      let inspectionPath = targetLock;
      if (aliasKind === "hard-link") {
        linkSync(targetLock, requestedLock);
        rmSync(targetLock);
        inspectionPath = requestedLock;
        assert.equal(statSync(requestedLock).nlink, 1,
          "the immutable database authority must reject an alias even after its original name disappears");
      } else symlinkSync(targetLock, requestedLock, "file");
      const before = new DatabaseSync(inspectionPath);
      assert.equal(before.prepare("SELECT retired FROM owned_fence_protocol").get()!.retired, 0);
      const beforeHolders = Number(before.prepare("SELECT COUNT(*) AS count FROM owned_fence_holder").get()!.count);
      before.close();
      await assert.rejects(host.releaseOwned(requestedId, owner, startedAt, fence), /authority|alias|identity|protocol|symbolic|link/i);
      const after = new DatabaseSync(inspectionPath);
      assert.equal(after.prepare("SELECT retired FROM owned_fence_protocol").get()!.retired, 0,
        `${aliasKind} must not retire the unrelated target coordination database`);
      assert.equal(Number(after.prepare("SELECT COUNT(*) AS count FROM owned_fence_holder").get()!.count), beforeHolders);
      after.close();
    } finally { rmSync(root, { recursive: true, force: true, maxRetries: 30, retryDelay: 50 }); }
  }
});

test("Windows Job rejects path-escaping process IDs before reading outside host state", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-windows-job-path-identity-"));
  const stateDirectory = join(root, "state");
  mkdirSync(stateDirectory);
  const outside = join(root, "escape.json");
  writeFileSync(outside, "outside evidence must not be parsed");
  try {
    const host = createWindowsJobProcessHost({ stateDirectory, platform: "win32" });
    await assert.rejects(
      host.reconcileOwned("../escape", { runId: "run", sessionId: "session" }, fence),
      /process.*identity|invalid.*process|path/i,
    );
    assert.equal(readFileSync(outside, "utf8"), "outside evidence must not be parsed");
    assert.equal(existsSync(join(root, "escape.fence.lock")), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("Windows Job startup refuses to cache a filename and embedded process identity mismatch", () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-windows-job-startup-identity-"));
  writeFileSync(join(root, "requested-a.json"), JSON.stringify({
    processId: "target-b", runId: "run", sessionId: "session", startedAt: new Date().toISOString(),
    stdoutPath: join(root, "stdout.log"), stderrPath: join(root, "stderr.log"), supervisor: {},
  }));
  try {
    assert.throws(
      () => createWindowsJobProcessHost({ stateDirectory: root, platform: "win32" }),
      /record.*identity|process.*identity|mismatch/i,
    );
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("Windows Job prequeued releases persist one tombstone and both retire exact coordination", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-windows-job-release-race-"));
  const processId = "job-release-race";
  const ownedDirectory = join(root, processId);
  mkdirSync(ownedDirectory, { recursive: true });
  const startedAt = new Date().toISOString();
  const statusPath = join(ownedDirectory, "supervisor.jsonl");
  const stdoutPath = join(ownedDirectory, "stdout.log");
  const stderrPath = join(ownedDirectory, "stderr.log");
  writeFileSync(stdoutPath, ""); writeFileSync(stderrPath, "");
  writeFileSync(statusPath, `${JSON.stringify({
    protocol: "aiboard-managed-process/v1", processId, supervisorPid: process.pid, childPid: 0, port: 0,
    status: "stopped", exitCode: 0, signal: null, error: null, ownershipReleased: true,
    updatedAt: startedAt, retainedOutputChunks: 0, retainedOutputBytes: 0,
  })}\n`);
  const recordPath = join(root, `${processId}.json`);
  writeFileSync(recordPath, JSON.stringify({
    processId, runId: "run-release-race", sessionId: "session-release-race", pid: 0,
    command: process.execPath, args: [], cwd: root, environmentKeys: [], startedAt, updatedAt: startedAt,
    status: "stopped", exitCode: 0, signal: null, stdoutPath, stderrPath, interactive: true,
    outputOffsets: { stdout: 0, stderr: 0 }, outputSequences: { stdout: 0, stderr: 0 },
    supervisor: { protocol: "aiboard-managed-process/v1", token: "q".repeat(64), statusPath, supervisorPid: process.pid, port: 0 },
    currentFence: fence,
  }));
  const owner = { runId: "run-release-race", sessionId: "session-release-race" };
  const lockPath = join(root, `${processId}.fence.lock`);
  try {
    const host = createWindowsJobProcessHost({ stateDirectory: root, platform: "win32" });
    const [first, second] = await Promise.all([
      host.releaseOwned(processId, owner, startedAt, fence),
      host.releaseOwned(processId, owner, startedAt, fence),
    ]);
    assert.equal(first.ownershipReleased, true); assert.equal(second.ownershipReleased, true);
    const durable = JSON.parse(readFileSync(recordPath, "utf8")) as { backendOwnershipReleasedAt?: string };
    assert.match(durable.backendOwnershipReleasedAt ?? "", /\S/);
    assert.equal(existsSync(lockPath), false);
    for (const suffix of ["-journal", "-wal", "-shm"]) assert.equal(existsSync(`${lockPath}${suffix}`), false);
    await assert.rejects(host.reconcileOwned(processId, owner, fence), /released|inactive|ownership/i);
  } finally { rmSync(root, { recursive: true, force: true, maxRetries: 30, retryDelay: 50 }); }
});

const verifiedWindowsSemanticFacts = {
  portableDuplex: "verified",
  windowsBatchArgv: "verified",
  exactTreeBirth: "partial",
  jobContainment: "verified",
} as const;

test("Windows portable baseline is selectable without Job Objects and reports crash cleanup honestly", async () => {
  const backend = createWindowsProcessBackend({ jobObjects: "unavailable" });
  const probe = await backend.probe() as {
    backendId: string;
    platformLabel: string;
    capabilities: Record<string, string>;
  };
  assert.equal(probe.backendId, "runner-windows-supervisor-v1");
  assert.equal(probe.platformLabel, "windows");
  assert.equal(probe.capabilities.tree_termination, "unavailable");
  assert.equal(probe.capabilities.verified_emptiness, "unavailable");
  assert.equal(probe.capabilities.crash_cleanup, "unavailable");
});

test("Windows portable launch consumes the caller's shared absolute startup deadline", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-windows-absolute-startup-deadline-"));
  const stateDirectory = join(root, "state");
  const backend = new WindowsProcessBackend({
    stateDirectory,
    startupDeadlineAt: Date.now() - 1,
    semanticFacts: verifiedWindowsSemanticFacts,
  });
  let unexpected: ProcessBackendBinding | undefined;
  let rejection: unknown;
  try {
    try {
      unexpected = bindingFor(parseProcessLaunchResult(await backend.launch(request(["-e", "process.exit(0)"]))));
    } catch (error) { rejection = error; }
    if (unexpected) await cleanupWindowsProcessFixture(backend, unexpected, fence);
    assert.match(String(rejection), /startup.*timed out|deadline.*exhausted/i);
    assert.deepEqual(readdirSync(stateDirectory), [], "an exhausted absolute deadline must refuse before creating launch state");
  } finally {
    if (unexpected) await cleanupWindowsProcessFixture(backend, unexpected, fence).catch(() => undefined);
    rmSync(root, { recursive: true, force: true, maxRetries: 30, retryDelay: 50 });
  }
});

test("Windows portable launch rejects a birth result that arrives after its absolute deadline", { timeout: 30_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-windows-late-birth-deadline-"));
  const stateDirectory = join(root, "state");
  const waiter = new Int32Array(new SharedArrayBuffer(4));
  let inspections = 0;
  const observedPids = new Set<number>();
  const cleanupPids = new Set<number>();
  const operations: NativeProcessOperations = {
    inspectProcessBirth: (pid) => {
      observedPids.add(pid);
      if (inspections++ === 0) Atomics.wait(waiter, 0, 0, 150);
      return processIsAlive(pid) ? { state: "present", fingerprint: "late-supervisor-birth" } : { state: "absent" };
    },
    listPosixGroup: () => undefined,
    signal: () => assert.fail("Windows late-birth cleanup must use the authenticated supervisor seam"),
  };
  const backend = new WindowsProcessBackend({
    stateDirectory,
    operations,
    startupDeadlineAt: Date.now() + 50,
    semanticFacts: verifiedWindowsSemanticFacts,
  });
  let unexpected: ProcessBackendBinding | undefined;
  let rejection: unknown;
  try {
    try {
      unexpected = bindingFor(parseProcessLaunchResult(await backend.launch(request(["-e", "setInterval(()=>{},1000)"]))));
    } catch (error) { rejection = error; }
    if (unexpected) await cleanupWindowsProcessFixture(backend, unexpected, fence);
    assert.ok(rejection, "a post-deadline birth result must not produce a successful launch");
    const messages = [String(rejection), ...(rejection instanceof AggregateError ? rejection.errors.map(String) : [])].join("\n");
    assert.match(messages, /startup deadline is exhausted/i,
      "the absolute deadline, not an incidental supervisor outcome, must reject the late birth result");
    assert.equal(unexpected, undefined, "a late exact birth is cleanup authority, never a successful launch binding");
    for (const pid of observedPids) cleanupPids.add(pid);
    for (const entry of readdirSync(stateDirectory)) {
      let state: {
        supervisorPid?: number;
        knownProcesses?: Array<{ pid: number }>;
      };
      try { state = JSON.parse(readFileSync(join(stateDirectory, entry, "state.json"), "utf8")); }
      catch { continue; }
      if (Number.isSafeInteger(state.supervisorPid)) cleanupPids.add(state.supervisorPid!);
      for (const process of state.knownProcesses ?? []) if (Number.isSafeInteger(process.pid)) cleanupPids.add(process.pid);
    }
    assert.ok(cleanupPids.size >= 2, "the fixture must observe both supervisor and target cleanup identities");
    await waitForCondition(() => [...cleanupPids].every((pid) => !processIsAlive(pid)), 5_000);
    assert.ok([...cleanupPids].every((pid) => !processIsAlive(pid)), "deadline rejection must leave no recorded owned process live");
    assert.deepEqual(readdirSync(stateDirectory), [], "authenticated deadline cleanup must remove its owned state root");
  } finally {
    if (unexpected) await cleanupWindowsProcessFixture(backend, unexpected, fence).catch(() => undefined);
    for (const pid of new Set([...observedPids, ...cleanupPids])) if (processIsAlive(pid))
      try { execFileSync("taskkill.exe", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", timeout: 5_000 }); } catch {}
    rmSync(root, { recursive: true, force: true, maxRetries: 30, retryDelay: 50 });
  }
});

test("omitted Windows semantic facts fail closed and service presence alone cannot select Job containment", async () => {
  let activeProbes = 0;
  let launches = 0;
  const service: WindowsJobProcessService = {
    probeActiveJobCreateClose: async () => { activeProbes += 1; return false; },
    launchOwned: async () => { launches += 1; return stoppedJobSnapshot(`unattested-${launches}`); },
    signalOwned: async (processId) => stoppedJobSnapshot(processId),
    reconcileOwned: async (processId) => stoppedJobSnapshot(processId),
    releaseOwned: async (processId) => stoppedJobSnapshot(processId),
    readOwnedOutput: (_processId, _owner, offsets) => ({ stdout: new Uint8Array(), stderr: new Uint8Array(), next: offsets }),
  };
  assert.ok(createWindowsProcessBackend({ jobObjects: { service } }) instanceof WindowsProcessBackend);
  const unavailableFacts = await probeProcessHostSemantics({
    portableDuplex: async () => true,
    windowsBatchArgv: async () => true,
    exactTreeBirth: async () => "partial",
    activeJobCreateClose: service.probeActiveJobCreateClose,
  });
  assert.ok(createWindowsProcessBackend({
    jobObjects: { service },
    semanticFacts: unavailableFacts,
  }) instanceof WindowsProcessBackend);
  assert.ok(createWindowsProcessBackend({
    jobObjects: { service },
    semanticFacts: { portableDuplex: "verified", windowsBatchArgv: "verified", exactTreeBirth: "partial", jobContainment: "verified" },
  }) instanceof WindowsJobObjectProcessBackend);
  assert.equal(activeProbes, 1, "selection consumes the independently settled active-probe fact");

  const root = mkdtempSync(join(tmpdir(), "aiboard-windows-unattested-batch-"));
  const shim = join(root, "argv.cmd");
  writeFileSync(shim, "@echo off\r\necho unreachable\r\n");
  try {
    const backend = createWindowsProcessBackend({ stateDirectory: join(root, "state"), jobObjects: "unavailable" });
    const batch = request([]);
    await assert.rejects(
      new WindowsJobObjectProcessBackend(service).launch({ ...batch, intent: { ...batch.intent, executable: shim, workingDirectory: root } }),
      (error) => error instanceof WindowsBatchLaunchUnavailableError,
    );
    await assert.rejects(
      backend.launch({ ...batch, intent: { ...batch.intent, executable: shim, workingDirectory: root } }),
      (error) => error instanceof WindowsBatchLaunchUnavailableError,
    );
    assert.equal(launches, 0, "neither omitted-fact backend may reach a Job or portable launch effect");
    assert.deepEqual(readdirSync(join(root, "state")), [], "unattested batch refusal occurs before durable launch state");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("Windows semantic facts independently gate batch launch and exact-tree attestation", async (t) => {
  if (process.platform !== "win32") { t.skip("Windows semantic launch consumer requires Windows."); return; }
  const root = mkdtempSync(join(tmpdir(), "aiboard-windows-semantic-consumers-"));
  const stateDirectory = join(root, "state");
  const workspace = join(root, "workspace");
  mkdirSync(workspace);
  const shim = join(workspace, "argv.cmd");
  writeFileSync(shim, "@echo off\r\necho unreachable\r\n");
  const backend = createWindowsProcessBackend({
    stateDirectory,
    jobObjects: "unavailable",
    semanticFacts: { portableDuplex: "verified", windowsBatchArgv: "unavailable", exactTreeBirth: "unavailable", jobContainment: "unavailable" },
  });
  let unexpectedBatchBinding: ReturnType<typeof bindingFor> | undefined;
  try {
    const attestation = await backend.probe() as { capabilities: Record<string, string> };
    assert.equal(attestation.capabilities.tree_termination, "unavailable");
    assert.equal(attestation.capabilities.verified_emptiness, "unavailable");
    let batchError: unknown;
    try {
      const unexpected = parseProcessLaunchResult(await backend.launch({ ...request([]), intent: { ...request([]).intent, executable: shim, invocationId: "batch-fact-false", workingDirectory: workspace }, grant: { ...request([]).grant, invocationId: "batch-fact-false" } }));
      unexpectedBatchBinding = bindingFor(unexpected);
    } catch (error) { batchError = error; }
    assert.ok(batchError instanceof WindowsBatchLaunchUnavailableError && batchError.code === "windows_batch_argv_unverified");
    assert.deepEqual(readdirSync(stateDirectory), [], "batch refusal must happen before an owned target is created");

    const nativeRequest = request(["-e", "process.stdout.write('native-ok')"]);
    const launch = parseProcessLaunchResult(await backend.launch({
      ...nativeRequest,
      intent: { ...nativeRequest.intent, invocationId: "native-fact-independent", workingDirectory: workspace },
      grant: { ...nativeRequest.grant, invocationId: "native-fact-independent" },
    }));
    const binding = bindingFor(launch);
    const output: Buffer[] = [];
    await backend.observe(binding, async (stream, bytes) => { if (stream === "stdout") output.push(Buffer.from(bytes)); }, fence);
    assert.equal(Buffer.concat(output).toString(), "native-ok");
    const emptyDeadline = Date.now() + 15_000;
    while (!parseProcessEmptyVerification(await backend.verifyEmpty(binding, fence)).empty) {
      if (Date.now() >= emptyDeadline) throw new Error("native semantic consumer did not reach stable verified emptiness");
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    await backend.release(binding, fence);
  } finally {
    if (unexpectedBatchBinding) {
      await backend.observe(unexpectedBatchBinding, async () => undefined, fence).catch(() => undefined);
      await backend.signal(unexpectedBatchBinding, "force_terminate", fence).catch(() => undefined);
      await backend.release(unexpectedBatchBinding, fence).catch(() => undefined);
    }
    rmSync(root, { recursive: true, force: true, maxRetries: 30, retryDelay: 50 });
  }
});

test("unverified batch argv rejects an extensionless PATH command that resolves first to cmd", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-windows-path-batch-"));
  const bin = join(root, "bin"); const state = join(root, "state"); mkdirSync(bin); mkdirSync(state);
  writeFileSync(join(bin, "path-tool.cmd"), "@echo off\r\necho unreachable\r\n");
  const backend = createWindowsProcessBackend({
    stateDirectory: state,
    jobObjects: "unavailable",
    semanticFacts: { portableDuplex: "verified", windowsBatchArgv: "unavailable", exactTreeBirth: "unavailable", jobContainment: "unavailable" },
  });
  const launch = request([]);
  try {
    await assert.rejects(backend.launch({
      ...launch,
      intent: { ...launch.intent, executable: "path-tool", workingDirectory: root },
      environment: { ...launch.environment, PATH: `"${bin}"`, Path: `"${bin}"`, PATHEXT: " CMD ; EXE " },
    }), (error) => error instanceof WindowsBatchLaunchUnavailableError);
    assert.deepEqual(readdirSync(state), [], "PATH-resolved batch refusal must precede supervisor launch");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("Windows extensionless resolution refuses conflicting case-insensitive PATH keys before launch", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-windows-path-ambiguity-")); const state = join(root, "state"); mkdirSync(state);
  const backend = createWindowsProcessBackend({ stateDirectory: state, jobObjects: "unavailable", semanticFacts: verifiedWindowsSemanticFacts });
  const launch = request([]);
  try {
    await assert.rejects(backend.launch({ ...launch, intent: { ...launch.intent, executable: "hidden-tool", workingDirectory: root }, environment: { ...launch.environment, PATH: root, Path: join(root, "other") } }), /ambiguous PATH/i);
    assert.deepEqual(readdirSync(state), []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("Windows extensionless resolution preserves directory priority before PATHEXT priority", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-windows-path-order-"));
  const earlier = join(root, "earlier"); const later = join(root, "later"); mkdirSync(earlier); mkdirSync(later);
  const expected = join(earlier, "ordered-tool.cmd");
  writeFileSync(expected, "@echo off\r\n");
  writeFileSync(join(later, "ordered-tool.exe"), "fixture");
  let launchedCommand = "";
  const service: WindowsJobProcessService = {
    probeActiveJobCreateClose: async () => true,
    launchOwned: async (input) => { launchedCommand = input.command; return stoppedJobSnapshot("path-order"); },
    signalOwned: async (processId) => stoppedJobSnapshot(processId),
    reconcileOwned: async (processId) => stoppedJobSnapshot(processId),
    releaseOwned: async (processId) => stoppedJobSnapshot(processId),
    readOwnedOutput: (_processId, _owner, offsets) => ({ stdout: new Uint8Array(), stderr: new Uint8Array(), next: offsets }),
  };
  const launch = request([]);
  const environment = Object.fromEntries(Object.entries(launch.environment).filter(([key]) => !["path", "pathext"].includes(key.toLowerCase())));
  try {
    await new WindowsJobObjectProcessBackend(service, "verified").launch({
      ...launch,
      intent: { ...launch.intent, executable: "ordered-tool", workingDirectory: root },
      environment: { ...environment, PATH: `"${earlier}";${later}`, PATHEXT: " EXE ; CMD " },
    });
    assert.equal(launchedCommand.toLowerCase(), expected.toLowerCase());
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("unverified batch argv rejects Job batch targets without disabling native Job launch", async () => {
  let launches = 0;
  const service: WindowsJobProcessService = {
    probeActiveJobCreateClose: async () => true,
    launchOwned: async () => { launches += 1; return stoppedJobSnapshot(`semantic-job-${launches}`); },
    signalOwned: async (processId) => stoppedJobSnapshot(processId),
    reconcileOwned: async (processId) => stoppedJobSnapshot(processId),
    releaseOwned: async (processId) => stoppedJobSnapshot(processId),
    readOwnedOutput: (_processId, _owner, offsets) => ({ stdout: new Uint8Array(), stderr: new Uint8Array(), next: offsets }),
  };
  const backend = new WindowsJobObjectProcessBackend(service, "unavailable");
  const batch = request([]);
  await assert.rejects(
    backend.launch({ ...batch, intent: { ...batch.intent, executable: "C:\\tools\\language-server.cmd" } }),
    (error) => error instanceof WindowsBatchLaunchUnavailableError,
  );
  assert.equal(launches, 0);
  await backend.launch(request([]));
  assert.equal(launches, 1, "the batch fact must not disable a native executable");
});

test("Windows portable supervisor reuses one birth-tagged tree snapshot per ownership tick", () => {
  const source = readFileSync(join(process.cwd(), "runner-v2", "src", "portable-process-supervisor.mjs"), "utf8");
  assert.equal(source.match(/Get-CimInstance Win32_Process/g)?.length, 1);
  assert.doesNotMatch(source, /Get-CimInstance Win32_Process -Filter/);
  assert.match(source, /lastWindowsProcesses/);
  assert.match(source, /windowsTreeRefreshInFlight/);
  assert.match(source, /WINDOWS_TREE_REFRESH_INTERVAL_MS\s*=\s*250/);
  assert.match(source, /const gap\s*=\s*now\s*-\s*lastWindowsTreeRefreshFinishedAt/);
  assert.match(source, /gap\s*<\s*WINDOWS_TREE_REFRESH_INTERVAL_MS/);
  assert.match(source, /WINDOWS_TREE_FAILURE_LIMIT/);
  assert.match(source, /acceptWindowsTreeResult\(code,[^\n]*inspector\.pid\)/);
  assert.match(source, /const inspectorTree = new Set\(\[inspectorPid\]\)/);
  assert.match(source, /rows = rows\.filter\(\(\{ pid \}\) => !inspectorTree\.has\(pid\)\)/);
  assert.doesNotMatch(source, /knownProcesses\.delete\(/,
    "historical exact identities must remain available for durable terminal proof");
  assert.match(source, /const owned = new Set\(\[\.\.\.knownProcesses\]\.filter\(\(\[pid, birth\]\) => \{\s*const observed = current\.get\(pid\);\s*return observed !== undefined && sameBirth\(observed, birth\);\s*\}\)\.map\(\(\[pid\]\) => pid\)\);/,
    "only currently birth-matched identities may seed descendant traversal");
  const tick = source.slice(source.indexOf("function tick"), source.indexOf("function installOutput"));
  assert.match(tick, /if \(config\.platform === "windows" && windowsTreeRefreshInFlight\) return;/,
    "destructive control must wait for the in-flight inventory instead of starting a competing query");
  const control = source.slice(source.indexOf("function handleControl"), source.indexOf("const WINDOWS_TREE_SCRIPT"));
  assert.match(control, /if \(config\.windowsControlInspector\) refreshWindowsTree\(\);/,
    "production control must reuse the fresh periodic snapshot; only an explicit test/control inspector may replace it");
  assert.match(control, /\["ENOENT", "EPERM", "EACCES", "EBUSY"\]/,
    "transient Windows sharing conflicts must leave control pending for the next tick");
});

test("Windows portable supervisor preserves historical proof without traversing a PID replacement", { timeout: 30_000 }, async (t) => {
  if (process.platform !== "win32") { t.skip("Windows PID-reuse fixture requires Windows."); return; }
  const root = mkdtempSync(join(tmpdir(), "aiboard-windows-recycled-tree-"));
  const directory = join(root, "owned-recycled-tree");
  mkdirSync(directory);
  const statePath = join(directory, "state.json");
  const replacementChildPid = 2_147_483_000;
  const inspector = [
    "const fs=require('node:fs')",
    "const state=JSON.parse(fs.readFileSync(process.argv[1],'utf8'))",
    "if(!state.rootProcess)process.exit(2)",
    "const replacementBirth='2000-01-01T00:00:00.000000Z'",
    "process.stdout.write(state.rootProcess.pid+',1,'+replacementBirth+'\\n')",
    `process.stdout.write('${replacementChildPid},'+state.rootProcess.pid+','+replacementBirth+'\\n')`,
  ].join(";");
  const encoded = Buffer.from(JSON.stringify({
    nonce: "recycled-tree-proof",
    directory,
    executable: process.execPath,
    arguments: ["-e", "process.exit(0)"],
    workingDirectory: process.cwd(),
    environment: fixtureEnvironment(),
    platform: "windows",
    pollIntervalMs: 20,
    windowsTreeInspector: { command: process.execPath, arguments: ["-e", inspector, statePath], deadlineMs: 2_000 },
  })).toString("base64url");
  const supervisor = spawn(process.execPath, [join(process.cwd(), "runner-v2", "src", "portable-process-supervisor.mjs"), encoded], {
    stdio: "ignore",
    windowsHide: true,
  });
  assert.ok(supervisor.pid);
  try {
    const stopped = await waitForPortableState(directory, (state) => state.status === "stopped");
    assert.ok(stopped.rootProcess);
    assert.deepEqual(stopped.knownProcesses, [stopped.rootProcess],
      "the exact root remains as historical proof and the replacement tree is never adopted");
    assert.equal(stopped.knownProcesses.some((candidate: { pid: number }) => candidate.pid === replacementChildPid), false);
    await waitForCondition(() => !processIsAlive(supervisor.pid!));
  } finally {
    if (supervisor.pid && processIsAlive(supervisor.pid)) {
      try { execFileSync("taskkill.exe", ["/PID", String(supervisor.pid), "/T", "/F"], { stdio: "ignore" }); } catch {}
    }
    rmSync(root, { recursive: true, force: true, maxRetries: 30, retryDelay: 50 });
  }
});

test("Windows Job supervisor durably settles final retained output before acknowledging it", () => {
  const source = readFileSync(join(process.cwd(), "runner-v2", "src", "managed-process-supervisor.mjs"), "utf8");
  const start = source.indexOf('request.url === "/ack-output"');
  const end = source.indexOf('request.url !== "/signal"', start);
  assert.ok(start >= 0 && end > start, "ack-output route must remain explicit");
  const route = source.slice(start, end);
  const settle = route.indexOf("tryMarkStopped();");
  const acknowledge = route.indexOf("json(response, 200, { acknowledged: true");
  assert.ok(settle >= 0 && acknowledge >= 0 && settle < acknowledge,
    "the durable stopped line must be committed before the final acknowledgement can trigger re-attestation");
});

test("Windows portable backend launches a batch shim with argv boundaries while Job containment is unavailable", async (t) => {
  if (process.platform !== "win32") { t.skip("Windows batch fixture requires Windows."); return; }
  const root = mkdtempSync(join(tmpdir(), "aiboard-portable-batch-"));
  const workspace = join(root, "workspace"); mkdirSync(workspace);
  const shim = join(workspace, "argv.cmd");
  writeFileSync(shim, "@echo off\r\necho [%~1][%~2]\r\n");
  const backend = createWindowsProcessBackend({
    stateDirectory: join(root, "state"),
    jobObjects: "unavailable",
    semanticFacts: { portableDuplex: "verified", windowsBatchArgv: "verified", exactTreeBirth: "partial", jobContainment: "unavailable" },
  });
  const batchRequest = request(["hello world", "literal"]);
  const launch = parseProcessLaunchResult(await backend.launch({ ...batchRequest, intent: { ...batchRequest.intent, executable: shim, invocationId: "portable-batch", workingDirectory: workspace }, grant: { ...batchRequest.grant, invocationId: "portable-batch" } }));
  const binding = bindingFor(launch); const output: Buffer[] = [];
  try {
    await backend.observe(binding, async (stream, bytes) => { if (stream === "stdout") output.push(Buffer.from(bytes)); }, fence);
    assert.equal(Buffer.concat(output).toString().trim(), "[hello world][literal]");
    const unsafe = request(["safe", "bad&injected"]);
    await assert.rejects(backend.launch({ ...unsafe, intent: { ...unsafe.intent, executable: shim, invocationId: "portable-batch-refusal", workingDirectory: workspace }, grant: { ...unsafe.grant, invocationId: "portable-batch-refusal" } }), /unsafe.*batch|launch/i);
  } finally {
    await backend.signal(binding, "force_terminate", fence).catch(() => undefined);
    await backend.release(binding, fence).catch(() => undefined);
    rmSync(root, { recursive: true, force: true, maxRetries: 30, retryDelay: 50 });
  }
});

test("Windows reconciliation distinguishes missing opaque identity from a birth mismatch", async () => {
  const backend = createWindowsProcessBackend({ jobObjects: "unavailable" });
  const missing = bindingFor({
    opaqueIdentity: "not-an-identity",
    birthFingerprint: { observedAt: "x", discriminator: "x" },
    startedAt: "x",
  });
  assert.deepEqual(await backend.reconcile(missing, fence), { state: "outcome_unknown" });
  const encoded = Buffer.from(JSON.stringify({
    version: 1,
    backendId: "runner-windows-supervisor-v1",
    nonce: "nonce",
    directory: process.cwd(),
    supervisorPid: process.pid,
    supervisorBirth: "recycled-birth",
  })).toString("base64url");
  const mismatch = bindingFor({
    opaqueIdentity: encoded,
    birthFingerprint: { observedAt: "x", discriminator: "0".repeat(64) },
    rootPid: process.pid,
    startedAt: "x",
  });
  assert.deepEqual(await backend.reconcile(mismatch, fence), { state: "identity_mismatch" });
});

test("Windows portable recovery treats a replaced historical process identity as absent", () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-windows-identity-contract-"));
  const operations: NativeProcessOperations = {
    inspectProcessBirth: (pid) => ({ state: "present", fingerprint: pid === 9001 ? "supervisor-birth" : "recycled-birth" }),
    listPosixGroup: () => undefined,
    signal: () => undefined,
  };
  const backend = createWindowsProcessBackend({ stateDirectory: root, operations });
  const stateDirectory = join(root, "identity");
  mkdirSync(stateDirectory);
  writeFileSync(join(stateDirectory, "state.json"), JSON.stringify({
    protocol: "aiboard-portable-process/v1",
    nonce: "windows-contract-nonce",
    supervisorPid: 9001,
    childPid: 9002,
    revision: 1,
    handledControl: 0,
    status: "running",
    exitCode: null,
    signal: null,
    launchEffect: "started",
    rootProcess: { pid: 9002, birth: "owned-descendant-birth" },
    knownProcesses: [{ pid: 9002, birth: "owned-descendant-birth" }],
    error: null,
    updatedAt: "2026-01-01T00:00:00.000Z",
  }));
  const stopped = JSON.parse(readFileSync(join(stateDirectory, "state.json"), "utf8"));
  stopped.status = "stopped";
  writeFileSync(join(stateDirectory, "state.json"), JSON.stringify(stopped));
  const identity = portableIdentity(stateDirectory, "supervisor-birth");
  const internal = backend as unknown as {
    emptiness(value: typeof identity): string;
    hasTerminalStoppedProof(value: typeof identity): boolean;
  };
  try {
    assert.equal(internal.emptiness(identity), "empty",
      "a different exact birth proves the recorded identity is gone, not that the replacement is owned");
    assert.equal(internal.hasTerminalStoppedProof(identity), true,
      "historical root membership must remain sufficient for durable terminal proof");
    assert.equal(existsSync(join(stateDirectory, "control.json")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Windows birth inspection failure is unknown and cannot prove empty, release, or signal", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-windows-inspection-unknown-"));
  const operations: NativeProcessOperations = {
    inspectProcessBirth: (pid) => pid === 9001
      ? { state: "present", fingerprint: "supervisor-birth" }
      : { state: "unknown" },
    listPosixGroup: () => undefined,
    signal: () => undefined,
  };
  const backend = createWindowsProcessBackend({ stateDirectory: root, operations });
  const stateDirectory = join(root, "identity");
  mkdirSync(stateDirectory);
  writePortableState(stateDirectory, {
    launchEffect: "started",
    rootProcess: { pid: 9002, birth: "owned-descendant-birth" },
    knownProcesses: [{ pid: 9002, birth: "owned-descendant-birth" }],
  });
  const binding = portableWindowsBinding(stateDirectory, "supervisor-birth");
  try {
    assert.deepEqual(parseProcessReconciliation(await backend.reconcile(binding, fence)), { state: "outcome_unknown" });
    assert.equal(parseProcessEmptyVerification(await backend.verifyEmpty(binding, fence)).empty, false);
    await assert.rejects(backend.release(binding, fence), /unknown|verify|empty/i);
    await assert.rejects(backend.signal(binding, "force_terminate", fence), /unknown|unavailable|inspect/i);
    assert.equal(existsSync(join(stateDirectory, "control.json")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Windows emptiness inspects every recorded birth in one bounded batch", () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-windows-batched-birth-"));
  const stateDirectory = join(root, "identity"); mkdirSync(stateDirectory);
  writePortableState(stateDirectory, {
    launchEffect: "started",
    rootProcess: { pid: 9002, birth: "owned-root-birth" },
    knownProcesses: [
      { pid: 9002, birth: "owned-root-birth" },
      { pid: 9003, birth: "owned-child-birth" },
    ],
  });
  const batches: number[][] = [];
  const operations = {
    inspectProcessBirth: (pid: number) => {
      if (pid === 9001) return { state: "present", fingerprint: "supervisor-birth" } as const;
      assert.fail(`per-process inspection escaped the bounded batch for ${pid}`);
    },
    inspectProcessBirths: (pids: readonly number[]) => {
      batches.push([...pids]);
      return new Map(pids.map((pid) => [pid, { state: "absent" } as const]));
    },
    listPosixGroup: () => undefined,
    signal: () => undefined,
  } satisfies NativeProcessOperations & {
    inspectProcessBirths(pids: readonly number[], platform: "posix" | "windows"): ReadonlyMap<number, { readonly state: "absent" }>;
  };
  const backend = createWindowsProcessBackend({ stateDirectory: root, operations });
  try {
    const internal = backend as unknown as { emptiness(identity: ReturnType<typeof portableIdentity>): string };
    assert.equal(internal.emptiness(portableIdentity(stateDirectory, "supervisor-birth")), "empty");
    assert.deepEqual(batches, [[9002, 9003]]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("Windows cannot imply control when the supervisor exited with a live birth-attested descendant", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-windows-dead-control-"));
  const stateDirectory = join(root, "identity"); mkdirSync(stateDirectory);
  writePortableState(stateDirectory, { launchEffect: "started", rootProcess: { pid: 9002, birth: "owned-descendant-birth" }, knownProcesses: [{ pid: 9002, birth: "owned-descendant-birth" }] });
  const backend = createWindowsProcessBackend({ stateDirectory: root, operations: {
    inspectProcessBirth: (pid) => pid === 9001 ? { state: "absent" } : { state: "present", fingerprint: "owned-descendant-birth" },
    listPosixGroup: () => undefined,
    signal: () => assert.fail("Windows portable control must not use a POSIX signal"),
  } });
  try {
    await assert.rejects(backend.signal(portableWindowsBinding(stateDirectory, "supervisor-birth"), "terminate", fence), /supervisor|control|unavailable|unknown/i);
    assert.equal(existsSync(join(stateDirectory, "control.json")), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("Windows emptiness and rollback reject a replaced well-formed supervisor state", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-windows-state-identity-"));
  const stateDirectory = join(root, "identity"); mkdirSync(stateDirectory);
  writePortableState(stateDirectory, { launchEffect: "not_started", rootProcess: null, knownProcesses: [] });
  const replacement = JSON.parse(readFileSync(join(stateDirectory, "state.json"), "utf8"));
  replacement.nonce = "replacement-nonce";
  replacement.supervisorPid = 9010;
  writeFileSync(join(stateDirectory, "state.json"), JSON.stringify(replacement));
  const signals: number[] = [];
  const backend = createWindowsProcessBackend({ stateDirectory: root, pollIntervalMs: 5, operations: {
    inspectProcessBirth: () => ({ state: "absent" }),
    listPosixGroup: () => undefined,
    signal: (pid) => { signals.push(pid); },
  } });
  const binding = portableWindowsBinding(stateDirectory, "supervisor-birth");
  const rollback = backend as unknown as { cleanupFailedLaunch(identity: ReturnType<typeof portableIdentity>): Promise<void> };
  try {
    assert.equal(parseProcessEmptyVerification(await backend.verifyEmpty(binding, fence)).empty, false);
    await assert.rejects(rollback.cleanupFailedLaunch(portableIdentity(stateDirectory, "supervisor-birth")), /identity|recycled|evidence|unknown|blocker/i);
    assert.deepEqual(signals, []);
    assert.equal(existsSync(join(stateDirectory, "state.json")), true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("Windows signal retries transient descendant inspection uncertainty without accepting persistent unknown", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-windows-signal-reattest-"));
  let descendantInspections = 0;
  const operations: NativeProcessOperations = {
    inspectProcessBirth: (pid) => pid === 9001
      ? { state: "present", fingerprint: "supervisor-birth" }
      : ++descendantInspections < 3
        ? { state: "unknown" }
        : { state: "present", fingerprint: "owned-descendant-birth" },
    listPosixGroup: () => undefined,
    signal: () => undefined,
  };
  const backend = createWindowsProcessBackend({ stateDirectory: root, operations, pollIntervalMs: 5 });
  const stateDirectory = join(root, "identity"); mkdirSync(stateDirectory);
  writePortableState(stateDirectory, {
    launchEffect: "started",
    rootProcess: { pid: 9002, birth: "owned-descendant-birth" },
    knownProcesses: [{ pid: 9002, birth: "owned-descendant-birth" }],
  });
  try {
    assert.equal(parseProcessSignalResult(await backend.signal(portableWindowsBinding(stateDirectory, "supervisor-birth"), "terminate", fence)).state, "running");
    assert.ok(descendantInspections >= 3);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Windows supervisor treats unavailable CIM inspection as unknown and ignores destructive control", async (t) => {
  if (process.platform !== "win32") {
    t.skip("Windows CIM failure fixture requires a Windows host.");
    return;
  }
  const root = mkdtempSync(join(tmpdir(), "aiboard-windows-cim-unknown-"));
  const directory = join(root, "owned-query-failure");
  mkdirSync(directory);
  const supervisor = join(process.cwd(), "runner-v2", "src", "portable-process-supervisor.mjs");
  const nonce = "cim-query-failure";
  const encoded = Buffer.from(JSON.stringify({
    nonce,
    directory,
    executable: process.execPath,
    arguments: ["-e", "setInterval(()=>{},1000)"],
    workingDirectory: process.cwd(),
    environment: fixtureEnvironment(),
    platform: "windows",
    pollIntervalMs: 20,
  })).toString("base64url");
  const child = spawn(process.execPath, [supervisor, encoded], {
    env: { ...process.env, Path: root, PATH: root },
    stdio: "ignore",
    windowsHide: true,
  });
  assert.ok(child.pid);
  try {
    const state = await waitForPortableState(directory, (value) => value.status === "outcome_unknown");
    assert.equal(state.launchEffect, "unknown");
    assert.equal(state.rootProcess, null);
    assert.deepEqual(state.knownProcesses, []);
    writeFileSync(join(directory, "control.json"), JSON.stringify({ revision: 1, action: "force_terminate" }));
    await new Promise((resolve) => setTimeout(resolve, 100));
    const afterControl = await waitForPortableState(directory, () => true);
    assert.equal(afterControl.handledControl, 0);
    assert.equal(afterControl.status, "outcome_unknown");
  } finally {
    try { execFileSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" }); } catch {}
    rmSync(root, { recursive: true, force: true });
  }
});

test("Windows supervisor watchdog terminates a hung CIM inspector and reaches durable unknown", { timeout: 30_000 }, async (t) => {
  if (process.platform !== "win32") { t.skip("Windows CIM watchdog fixture requires a Windows host."); return; }
  const root = mkdtempSync(join(tmpdir(), "aiboard-windows-cim-watchdog-"));
  const directory = join(root, "owned-hung-query"); mkdirSync(directory);
  const inspectorPids = join(root, "inspector-pids.txt");
  const supervisor = join(process.cwd(), "runner-v2", "src", "portable-process-supervisor.mjs");
  const nonce = "cim-watchdog";
  const encoded = Buffer.from(JSON.stringify({
    nonce, directory, executable: process.execPath, arguments: ["-e", "setInterval(()=>{},1000)"],
    workingDirectory: process.cwd(), environment: fixtureEnvironment(), platform: "windows", pollIntervalMs: 20,
    windowsTreeInspector: {
      command: process.execPath,
      arguments: ["-e", "require('node:fs').appendFileSync(process.argv[1],process.pid+'\\n');setInterval(()=>{},1000)", inspectorPids],
      deadlineMs: 1_000,
    },
  })).toString("base64url");
  const child = spawn(process.execPath, [supervisor, encoded], { stdio: "ignore", windowsHide: true });
  assert.ok(child.pid);
  try {
    const state = await waitForPortableState(directory, (value) => value.status === "outcome_unknown" && (value.windowsTreeFailures ?? 0) >= 3);
    assert.equal(state.launchEffect, "started");
    assert.match(String(state.error), /watchdog|timed out|inspection/i);
    const pids = readFileSync(inspectorPids, "utf8").trim().split(/\r?\n/).map(Number);
    assert.equal(pids.length, 3);
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.ok(pids.every((pid) => !processIsAlive(pid)), "every timed-out CIM inspector must be terminated");
    const stable = await waitForPortableState(directory, () => true);
    assert.equal(stable.windowsTreeFailures, 3);
    assert.equal(existsSync(join(directory, "state.json")), true);
    assert.equal(processIsAlive(state.rootProcess!.pid), true, "uncertain owned process must remain intact");
  } finally {
    try { execFileSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" }); } catch {}
    rmSync(root, { recursive: true, force: true, maxRetries: 30, retryDelay: 50 });
  }
});

test("Windows portable startup retries an exact birth inspection with an adaptive bounded budget", { timeout: 30_000 }, async (t) => {
  if (process.platform !== "win32") { t.skip("Windows adaptive birth fixture requires a Windows host."); return; }
  const root = mkdtempSync(join(tmpdir(), "aiboard-windows-adaptive-birth-"));
  const directory = join(root, "owned-adaptive-birth"); mkdirSync(directory);
  const inspector = "setTimeout(()=>process.stdout.write('PRESENT:2030-01-01T00:00:00.000000Z'),3000)";
  const encoded = Buffer.from(JSON.stringify({
    nonce: "adaptive-birth",
    directory,
    executable: process.execPath,
    arguments: ["-e", "setInterval(()=>{},1000)"],
    workingDirectory: process.cwd(),
    environment: fixtureEnvironment(),
    platform: "windows",
    pollIntervalMs: 20,
    windowsBirthInspector: { command: process.execPath, arguments: ["-e", inspector] },
  })).toString("base64url");
  const supervisorPath = join(process.cwd(), "runner-v2", "src", "portable-process-supervisor.mjs");
  const child = spawn(process.execPath, [supervisorPath, encoded], {
    stdio: "ignore",
    windowsHide: true,
    env: { ...process.env, PATH: join(root, "no-powershell-on-path") },
  });
  assert.ok(child.pid);
  try {
    const running = await waitForPortableState(directory, (state) =>
      state.status === "running" && state.windowsBirthInspectionAttempts === 2 &&
      (state.windowsBirthInspectionDeadlineMs ?? 0) >= 4_000,
    10_000);
    assert.equal(running.launchEffect, "started");
    assert.equal(running.rootProcess?.birth, "2030-01-01T00:00:00.000000Z");
  } finally {
    try { execFileSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", timeout: 5_000 }); } catch {}
    await waitForCondition(() => !processIsAlive(child.pid!), 10_000);
    rmSync(root, { recursive: true, force: true, maxRetries: 30, retryDelay: 50 });
  }
});

test("portable backend does not cap Windows supervisor birth discovery at the former one-second window", () => {
  const source = readFileSync(join(process.cwd(), "runner-v2", "src", "native-process-backend.ts"), "utf8");
  assert.doesNotMatch(source, /waitForBirth\(child\.pid,\s*1_000\)/);
  assert.match(source, /inspectProcessBirth\(pid,\s*this\.options\.platform,\s*attemptDeadlineMs\)/);
  assert.match(source, /WINDOWS_SUPERVISOR_BIRTH_INSPECTION_DEADLINE_MS/);
});

test("Windows supervisor adapts its default inventory attempt budget to a slower host", { timeout: 30_000 }, async (t) => {
  if (process.platform !== "win32") { t.skip("Windows adaptive CIM fixture requires a Windows host."); return; }
  const root = mkdtempSync(join(tmpdir(), "aiboard-windows-adaptive-cim-"));
  const directory = join(root, "owned-adaptive-query"); mkdirSync(directory);
  const statePath = join(directory, "state.json");
  const inspector = [
    "const fs=require('node:fs')",
    "setTimeout(()=>{",
    "const state=JSON.parse(fs.readFileSync(process.argv[1],'utf8'))",
    "if(!state.rootProcess)process.exit(2)",
    "process.stdout.write(state.rootProcess.pid+',1,'+state.rootProcess.birth+'\\n')",
    "},3000)",
  ].join(";");
  const encoded = Buffer.from(JSON.stringify({
    nonce: "adaptive-cim",
    directory,
    executable: process.execPath,
    arguments: ["-e", "setInterval(()=>{},1000)"],
    workingDirectory: process.cwd(),
    environment: fixtureEnvironment(),
    platform: "windows",
    pollIntervalMs: 20,
    windowsTreeInspector: { command: process.execPath, arguments: ["-e", inspector, statePath] },
  })).toString("base64url");
  const child = spawn(process.execPath, [join(process.cwd(), "runner-v2", "src", "portable-process-supervisor.mjs"), encoded], { stdio: "ignore", windowsHide: true });
  assert.ok(child.pid);
  try {
    const recovered = await waitForPortableState(directory, (state) =>
      state.status === "running" && (state.windowsTreeRefreshCount ?? 0) >= 2 &&
      (state.windowsTreeFailures ?? 0) === 0 && (state.windowsTreeInspectionDeadlineMs ?? 0) > 2_000,
    8_000);
    assert.ok(recovered.rootProcess);
    assert.equal(processIsAlive(recovered.rootProcess.pid), true);
  } finally {
    try { execFileSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", timeout: 5_000 }); } catch {}
    rmSync(root, { recursive: true, force: true, maxRetries: 30, retryDelay: 50 });
  }
});

test("Windows destructive control bounds a hung fresh inspector and never signals under uncertainty", { timeout: 30_000 }, async (t) => {
  if (process.platform !== "win32") { t.skip("Windows control inspector fixture requires Windows."); return; }
  const root = mkdtempSync(join(tmpdir(), "aiboard-windows-control-watchdog-"));
  const directory = join(root, "owned-control-query"); mkdirSync(directory);
  const inspectorPids = join(root, "control-inspector-pids.txt");
  const nonce = "control-query-watchdog";
  const encoded = Buffer.from(JSON.stringify({
    nonce, directory, executable: process.execPath, arguments: ["-e", "setInterval(()=>{},1000)"], workingDirectory: process.cwd(),
    environment: fixtureEnvironment(), platform: "windows", pollIntervalMs: 20,
    windowsControlInspector: { command: process.execPath, arguments: ["-e", "require('node:fs').appendFileSync(process.argv[1],process.pid+'\\n');setInterval(()=>{},1000)", inspectorPids], deadlineMs: 100 },
  })).toString("base64url");
  const child = spawn(process.execPath, [join(process.cwd(), "runner-v2", "src", "portable-process-supervisor.mjs"), encoded], { stdio: "ignore", windowsHide: true });
  assert.ok(child.pid);
  try {
    const running = await waitForPortableState(directory, (value) => value.status === "running" && !!value.rootProcess);
    writeFileSync(join(directory, "lock-holder.json"), JSON.stringify({
      nonce,
      holderPid: child.pid,
      holderBirth: windowsBirth(child.pid!),
    }));
    writeFileSync(join(directory, "fence.json"), JSON.stringify({ nonce, ownerId: "control-owner", fencingToken: 1 }));
    writeFileSync(join(directory, "control.json"), JSON.stringify({ nonce, ownerId: "control-owner", fencingToken: 1, sequence: 1, action: "force_terminate" }));
    const unknown = await waitForPortableState(directory, (value) => value.handledControl === 1 && value.status === "outcome_unknown");
    assert.match(String(unknown.error), /timed out|inspection|control/i);
    const inspectorPid = Number(readFileSync(inspectorPids, "utf8").trim());
    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.equal(processIsAlive(inspectorPid), false);
    assert.equal(processIsAlive(running.rootProcess!.pid), true, "uncertain control must preserve the owned target");
  } finally {
    try { execFileSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", timeout: 5_000 }); } catch {}
    rmSync(root, { recursive: true, force: true, maxRetries: 30, retryDelay: 50 });
  }
});

function windowsBirth(pid: number): string {
  const output = execFileSync("powershell.exe", [
    "-NoLogo", "-NoProfile", "-NonInteractive", "-Command",
    `$ErrorActionPreference='Stop';(Get-Process -Id ${pid}).StartTime.ToUniversalTime().ToString('o')`,
  ], { encoding: "utf8", windowsHide: true, timeout: 2_000 }).trim();
  assert.match(output, /\S/);
  return output.replace(/(\.\d{6})\d+(Z)$/, "$1$2");
}

test("Windows destructive control bounds taskkill and treats timeout as durable uncertainty", { timeout: 30_000 }, async (t) => {
  if (process.platform !== "win32") { t.skip("Windows taskkill watchdog fixture requires Windows."); return; }
  const root = mkdtempSync(join(tmpdir(), "aiboard-windows-taskkill-watchdog-"));
  const directory = join(root, "owned-taskkill"); mkdirSync(directory);
  const taskkillPids = join(root, "taskkill-pids.txt");
  const nonce = "taskkill-watchdog";
  const encoded = Buffer.from(JSON.stringify({
    nonce, directory, executable: process.execPath, arguments: ["-e", "setInterval(()=>{},1000)"], workingDirectory: process.cwd(),
    environment: fixtureEnvironment(), platform: "windows", pollIntervalMs: 20,
    windowsTaskkill: { command: process.execPath, arguments: ["-e", "require('node:fs').appendFileSync(process.argv[1],process.pid+'\\n');setInterval(()=>{},1000)", taskkillPids], deadlineMs: 100 },
  })).toString("base64url");
  const child = spawn(process.execPath, [join(process.cwd(), "runner-v2", "src", "portable-process-supervisor.mjs"), encoded], { stdio: "ignore", windowsHide: true });
  assert.ok(child.pid);
  try {
    const running = await waitForPortableState(directory, (value) => value.status === "running" && !!value.rootProcess);
    writeFileSync(join(directory, "lock-holder.json"), JSON.stringify({
      nonce,
      holderPid: child.pid,
      holderBirth: windowsBirth(child.pid!),
    }));
    writeFileSync(join(directory, "fence.json"), JSON.stringify({ nonce, ownerId: "control-owner", fencingToken: 1 }));
    writeFileSync(join(directory, "control.json"), JSON.stringify({ nonce, ownerId: "control-owner", fencingToken: 1, sequence: 1, action: "force_terminate" }));
    const unknown = await waitForPortableState(directory, (value) => value.handledControl === 1 && value.status === "outcome_unknown");
    assert.match(String(unknown.error), /taskkill|timed out|control/i);
    const taskkillPid = Number(readFileSync(taskkillPids, "utf8").trim());
    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.equal(processIsAlive(taskkillPid), false);
    assert.equal(processIsAlive(running.rootProcess!.pid), true, "failed taskkill cannot prove control");
  } finally {
    try { execFileSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", timeout: 5_000 }); } catch {}
    rmSync(root, { recursive: true, force: true, maxRetries: 30, retryDelay: 50 });
  }
});

test("Windows supervisor rejects successful empty CIM inventory as consecutive uncertainty", { timeout: 30_000 }, async (t) => {
  if (process.platform !== "win32") { t.skip("Windows CIM empty-inventory fixture requires a Windows host."); return; }
  const root = mkdtempSync(join(tmpdir(), "aiboard-windows-cim-empty-")); const directory = join(root, "owned-empty-query"); mkdirSync(directory);
  const supervisor = join(process.cwd(), "runner-v2", "src", "portable-process-supervisor.mjs");
  const encoded = Buffer.from(JSON.stringify({
    nonce: "cim-empty", directory, executable: process.execPath, arguments: ["-e", "setInterval(()=>{},1000)"], workingDirectory: process.cwd(), environment: fixtureEnvironment(), platform: "windows", pollIntervalMs: 20,
    windowsTreeInspector: { command: process.execPath, arguments: ["-e", "process.exit(0)"], deadlineMs: 500 },
  })).toString("base64url");
  const child = spawn(process.execPath, [supervisor, encoded], { stdio: "ignore", windowsHide: true }); assert.ok(child.pid);
  try {
    const state = await waitForPortableState(directory, (value) => value.status === "outcome_unknown" && value.windowsTreeFailures === 3);
    assert.match(String(state.error), /empty|inventory|inspection/i);
    assert.equal(processIsAlive(state.rootProcess!.pid), true);
  } finally {
    try { execFileSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" }); } catch {}
    rmSync(root, { recursive: true, force: true, maxRetries: 30, retryDelay: 50 });
  }
});

test("Windows state with a bare initial child PID is unknown and never traverses a recycled process", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-windows-bare-child-"));
  const inspected: number[] = [];
  const operations: NativeProcessOperations = {
    inspectProcessBirth: (pid) => {
      inspected.push(pid);
      return { state: "present", fingerprint: pid === 9001 ? "supervisor-birth" : "recycled-child-birth" };
    },
    listPosixGroup: () => undefined,
    signal: () => undefined,
  };
  const backend = createWindowsProcessBackend({ stateDirectory: root, operations });
  const stateDirectory = join(root, "identity");
  mkdirSync(stateDirectory);
  writePortableState(stateDirectory, { childPid: 9002, knownProcesses: [] });
  const binding = portableWindowsBinding(stateDirectory, "supervisor-birth");
  try {
    assert.deepEqual(parseProcessReconciliation(await backend.reconcile(binding, fence)), { state: "outcome_unknown" });
    assert.equal(parseProcessEmptyVerification(await backend.verifyEmpty(binding, fence)).empty, false);
    await assert.rejects(backend.release(binding, fence), /unknown|verify|empty/i);
    assert.ok(inspected.length >= 2);
    assert.ok(inspected.every((pid) => pid === 9001), "bare child PID must never be inspected or traversed");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Windows launch rollback persists a recoverable blocker when live-supervisor inspection is unknown", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-windows-live-inspection-unknown-"));
  const operations: NativeProcessOperations = {
    inspectProcessBirth: (pid) => pid === 9001
      ? { state: "present", fingerprint: "supervisor-birth" }
      : { state: "unknown" },
    listPosixGroup: () => undefined,
    signal: () => assert.fail("Windows unknown inspection must not call a native signal action."),
  };
  const backend = createWindowsProcessBackend({ stateDirectory: root, pollIntervalMs: 10, operations });
  writePortableState(root, {
    launchEffect: "unknown",
    rootProcess: null,
    knownProcesses: [],
  });
  const rollback = backend as unknown as { cleanupFailedLaunch(identity: ReturnType<typeof portableIdentity>): Promise<void> };
  try {
    await assert.rejects(
      rollback.cleanupFailedLaunch(portableIdentity(root, "supervisor-birth")),
      (error) => {
        assert.ok(error instanceof NativeProcessLaunchBlockedError);
        assert.equal(error.evidenceDirectory, root);
        return /inspection|verification|evidence/i.test(error.message);
      },
    );
    assert.equal(existsSync(join(root, "control.json")), false);
    assert.equal(existsSync(join(root, "state.json")), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Windows launch rollback retries transient identity uncertainty before proving empty", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-windows-transient-launch-"));
  let inspections = 0;
  const operations: NativeProcessOperations = {
    inspectProcessBirth: () => ++inspections <= 2 ? { state: "unknown" } : { state: "absent" },
    listPosixGroup: () => undefined,
    signal: () => assert.fail("transient launch cleanup must not signal an unverified identity"),
  };
  const backend = createWindowsProcessBackend({ stateDirectory: root, pollIntervalMs: 5, operations });
  const evidence = join(root, "identity");
  mkdirSync(evidence);
  writePortableState(evidence, { launchEffect: "not_started", rootProcess: null, knownProcesses: [] });
  const rollback = backend as unknown as { cleanupFailedLaunch(identity: ReturnType<typeof portableIdentity>): Promise<void> };
  try {
    await rollback.cleanupFailedLaunch(portableIdentity(evidence, "supervisor-birth"));
    assert.ok(inspections >= 3);
  } finally {
    try { rmSync(root, { recursive: true, force: true, maxRetries: 30, retryDelay: 50 }); } catch {}
  }
});

test("Windows launch rollback preserves an immediate blocker when the supervisor exited with an owned descendant", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-windows-dead-supervisor-"));
  const operations: NativeProcessOperations = {
    inspectProcessBirth: (pid) => pid === 9002
      ? { state: "present", fingerprint: "owned-descendant-birth" }
      : { state: "absent" },
    listPosixGroup: () => undefined,
    signal: () => undefined,
  };
  const backend = createWindowsProcessBackend({ stateDirectory: root, pollIntervalMs: 10, operations });
  writePortableState(root, {
    launchEffect: "started",
    rootProcess: { pid: 9002, birth: "owned-descendant-birth" },
    knownProcesses: [{ pid: 9002, birth: "owned-descendant-birth" }],
  });
  const rollback = backend as unknown as { cleanupFailedLaunch(identity: ReturnType<typeof portableIdentity>): Promise<void> };
  const started = Date.now();
  let blocker: NativeProcessLaunchBlockedError | undefined;
  try {
    await assert.rejects(
      rollback.cleanupFailedLaunch(portableIdentity(root, "supervisor-birth")),
      (error) => {
        assert.ok(error instanceof NativeProcessLaunchBlockedError);
        assert.equal(error.code, "native_process_launch_cleanup_blocked");
        assert.equal(error.evidenceDirectory, root);
        blocker = error;
        return /supervisor.*exited|blocker|evidence/i.test(error.message);
      },
    );
    assert.ok(Date.now() - started < 500, "rollback must not treat a polling timeout as its blocker proof");
    assert.equal(existsSync(join(root, "state.json")), true);
    assert.equal(existsSync(join(root, "control.json")), false);
    assert.ok(blocker);
    const retainedBinding = { ...bindingFor(blocker.launchResult), backendId: "runner-windows-supervisor-v1" };
    assert.deepEqual(parseProcessReconciliation(await backend.reconcile(retainedBinding, fence)), { state: "running" });
    await assert.rejects(backend.release(retainedBinding, fence), /non-empty/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(`${root}.fence.lock`, { force: true, maxRetries: 30, retryDelay: 50 });
    assert.equal(existsSync(root), false);
    assert.equal(existsSync(`${root}.fence.lock`), false);
  }
});

test("Windows portable launch failure verifies owned cleanup instead of killing only the supervisor PID", async () => {
  if (process.platform !== "win32") return;
  const root = mkdtempSync(join(tmpdir(), "aiboard-windows-launch-cleanup-"));
  const backend = createWindowsProcessBackend({ stateDirectory: root, pollIntervalMs: 20 });
  try {
    const failures = await Promise.all(Array.from({ length: 4 }, async (_, index) => {
      try {
        await backend.launch({
          ...request([]),
          intent: {
            ...request([]).intent,
            invocationId: `missing-executable-${index}`,
            executable: join(root, `missing-executable-${index}.exe`),
          },
        });
        assert.fail("missing executable unexpectedly launched");
      } catch (error) {
        assert.match(error instanceof Error ? error.message : String(error), /launch|process|supervisor|cleanup|ENOENT/i);
        return error;
      }
    }));
    assert.equal(failures.length, 4);
    const residue = readdirSync(root);
    assert.deepEqual(residue, [], JSON.stringify({
      failures: failures.map((error) => error instanceof Error ? error.message : String(error)),
      residue: residue.map((entry) => ({
        entry,
        state: existsSync(join(root, entry, "state.json")) ? readFileSync(join(root, entry, "state.json"), "utf8") : "missing",
      })),
    }));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Windows launch rollback authenticates force termination at the real live supervisor seam", { timeout: 30_000 }, async (t) => {
  if (process.platform !== "win32") { t.skip("Windows live rollback fixture requires Windows."); return; }
  const root = mkdtempSync(join(tmpdir(), "aiboard-windows-live-rollback-"));
  const operations: NativeProcessOperations = {
    inspectProcessBirth: (pid) => {
      for (const entry of readdirSync(root)) {
        try {
          const state = JSON.parse(readFileSync(join(root, entry, "state.json"), "utf8")) as { status: string; supervisorPid: number; knownProcesses: Array<{ pid: number; birth: string }> };
          if (state.supervisorPid === pid) return processIsAlive(pid) ? { state: "present", fingerprint: "fixture-supervisor-birth" } : { state: "absent" };
          const known = state.knownProcesses.find((candidate) => candidate.pid === pid);
          if (known) return state.status === "stopped" || !processIsAlive(pid) ? { state: "absent" } : { state: "present", fingerprint: known.birth };
        } catch {}
      }
      return processIsAlive(pid) ? { state: "present", fingerprint: "fixture-supervisor-birth" } : { state: "absent" };
    },
    listPosixGroup: () => undefined,
    signal: () => assert.fail("Windows live rollback must use the authenticated supervisor control seam"),
  };
  const backend = createWindowsProcessBackend({ stateDirectory: root, pollIntervalMs: 20, operations });
  const launch = parseProcessLaunchResult(await backend.launch(request(["-e", "setInterval(()=>{},1000)"])));
  const binding = bindingFor(launch);
  const identity = JSON.parse(Buffer.from(launch.opaqueIdentity, "base64url").toString("utf8")) as ReturnType<typeof portableIdentity> & { fence: ProcessEffectFence };
  const rollback = backend as unknown as { cleanupFailedLaunch(value: typeof identity): Promise<void> };
  try {
    let boundedBlocker: NativeProcessLaunchBlockedError | undefined;
    try {
      await rollback.cleanupFailedLaunch(identity);
    } catch (error) {
      assert.ok(error instanceof NativeProcessLaunchBlockedError, "bounded Windows inspection uncertainty must preserve exact cleanup evidence");
      assert.equal(error.evidenceDirectory, identity.directory);
      boundedBlocker = error;
    }
    const state = await waitForPortableState(identity.directory, (value) => value.status === "stopped");
    assert.equal(state.handledControl, 1);
    if (boundedBlocker) await rollback.cleanupFailedLaunch(identity);
    assert.equal(parseProcessEmptyVerification(await backend.verifyEmpty(binding, fence)).empty, true);
    await backend.release(binding, fence);
  } finally {
    await backend.signal(binding, "force_terminate", fence).catch(() => undefined);
    await backend.release(binding, fence).catch(() => undefined);
    rmSync(root, { recursive: true, force: true, maxRetries: 30, retryDelay: 50 });
  }
});

test("Windows portable fixture supervisor argv excludes ambient credential sentinels", { timeout: 30_000 }, async (t) => {
  if (process.platform !== "win32") { t.skip("Windows supervisor argv fixture requires Windows."); return; }
  const key = "AIBOARD_FIXTURE_AMBIENT_SECRET"; const value = `sentinel-${Date.now()}-${Math.random()}`;
  const previous = process.env[key]; process.env[key] = value;
  const root = mkdtempSync(join(tmpdir(), "aiboard-windows-fixture-env-")); const backend = createWindowsProcessBackend({ stateDirectory: root, pollIntervalMs: 20 });
  let binding: ReturnType<typeof bindingFor> | undefined;
  try {
    const launch = parseProcessLaunchResult(await backend.launch(request(["-e", "setInterval(()=>{},1000)"]))); binding = bindingFor(launch);
    const identity = JSON.parse(Buffer.from(launch.opaqueIdentity, "base64url").toString("utf8")) as { supervisorPid: number };
    const commandLine = execFileSync("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", `$p=Get-CimInstance Win32_Process -Filter 'ProcessId=${identity.supervisorPid}';$p.CommandLine`], { encoding: "utf8", windowsHide: true }).trim();
    const encoded = /\s([A-Za-z0-9_-]+)\s*$/.exec(commandLine)?.[1]; assert.ok(encoded);
    const config = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as { environment: Record<string, string> };
    assert.equal(Object.keys(config.environment).some((name) => name.toLowerCase() === key.toLowerCase()), false);
    assert.equal(Object.values(config.environment).includes(value), false);
  } finally {
    try { if (binding) await cleanupWindowsProcessFixture(backend, binding, fence); }
    finally { if (previous === undefined) delete process.env[key]; else process.env[key] = previous; }
    rmSync(root, { recursive: true, force: true, maxRetries: 30, retryDelay: 50 });
  }
});

test("Windows native supervisor owns a surviving descendant after launcher exit", async (t) => {
  if (process.platform !== "win32") {
    t.skip("Windows supervisor ownership requires a Windows host.");
    return;
  }
  const root = mkdtempSync(join(tmpdir(), "aiboard-windows-descendant-"));
  const backend = createWindowsProcessBackend({
    jobObjects: "unavailable",
    stateDirectory: root,
    pollIntervalMs: 20,
  });
  const launch = parseProcessLaunchResult(await backend.launch(request([
    "-e",
    "const{spawn}=require('node:child_process');const c=spawn(process.execPath,['-e',\"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)\"],{stdio:'ignore',detached:true});c.unref();console.log(c.pid);setTimeout(()=>process.exit(0),1500)",
  ])));
  const binding = bindingFor(launch);
  try {
    await new Promise((resolve) => setTimeout(resolve, 1_800));
    let reconciled = parseProcessReconciliation(await backend.reconcile(binding, fence));
    const inspectionDeadline = Date.now() + 5_000;
    while (reconciled.state === "outcome_unknown" && Date.now() < inspectionDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      reconciled = parseProcessReconciliation(await backend.reconcile(binding, fence));
    }
    const identity = JSON.parse(Buffer.from(launch.opaqueIdentity, "base64url").toString("utf8"));
    const diagnosticState = readFileSync(join(identity.directory, "state.json"), "utf8");
    assert.deepEqual(reconciled, { state: "running" }, diagnosticState);
    let terminated: unknown; const signalDeadline = Date.now() + 15_000;
    while (terminated === undefined) {
      try { terminated = await backend.signal(binding, "terminate", fence); }
      catch (error) {
        if (!/unknown|unavailable|inspect/i.test(error instanceof Error ? error.message : String(error)) || Date.now() >= signalDeadline) throw error;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    assert.equal(parseProcessSignalResult(terminated).state, "running");
    assert.equal(parseProcessEmptyVerification(await backend.verifyEmpty(binding, fence)).empty, false);
  } finally {
    await backend.signal(binding, "force_terminate", fence).catch(() => undefined);
    const identity = JSON.parse(Buffer.from(launch.opaqueIdentity, "base64url").toString("utf8"));
    const state = JSON.parse(readFileSync(join(identity.directory, "state.json"), "utf8")) as { knownProcesses: Array<{ pid: number; birth: string }> };
    assert.ok(state.knownProcesses.every((process) => process.birth.length > 0));
    for (const pid of [...state.knownProcesses.map((process) => process.pid), identity.supervisorPid]) {
      try { execFileSync("taskkill.exe", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" }); } catch {}
    }
    await backend.release(binding, fence).catch(() => undefined);
    rmSync(root, { recursive: true, force: true, maxRetries: 30, retryDelay: 50 });
  }
});

test("optional Windows Job adapter terminates and verifies a TERM-ignoring descendant tree", async (t) => {
  if (process.platform !== "win32") {
    t.skip("Windows Job Object fixture requires a Windows host.");
    return;
  }
  const root = mkdtempSync(join(tmpdir(), "aiboard-windows-backend-job-"));
  const workspace = join(root, "workspace");
  mkdirSync(workspace);
  const service = new ManagedProcessService({ stateDirectory: join(root, "state") });
  const backend = createWindowsProcessBackend({ jobObjects: { service }, semanticFacts: verifiedWindowsSemanticFacts });
  const attestation = await backend.probe() as { capabilities: Record<string, string> };
  assert.equal(attestation.capabilities.crash_cleanup, "enforced");
  const jobRequest = request([
    "-e",
    "const{spawn}=require('node:child_process');const c=spawn(process.execPath,['-e',\"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)\"],{stdio:'ignore',detached:true});c.unref();console.log(c.pid);setTimeout(()=>process.exit(0),30)",
  ]);
  const launch = parseProcessLaunchResult(await backend.launch({
    ...jobRequest,
    intent: {
      ...jobRequest.intent,
      invocationId: "windows-job-native",
      workingDirectory: workspace,
    },
    grant: { ...jobRequest.grant, invocationId: "windows-job-native" },
  }));
  const binding = { ...bindingFor(launch), backendId: "runner-windows-job-v1" };
  const jobIdentity = JSON.parse(Buffer.from(launch.opaqueIdentity, "base64url").toString("utf8")) as { processId: string };
  const hostRecord = JSON.parse(readFileSync(join(`${join(root, "state")}-job-host`, `${jobIdentity.processId}.json`), "utf8")) as { supervisor: { supervisorPid: number } };
  const takeoverFence = { ownerId: "job-recovery", fencingToken: fence.fencingToken + 1 };
  try {
    assert.equal(parseProcessReconciliation(await backend.reconcile(binding, takeoverFence)).state, "running");
    await assert.rejects(backend.signal(binding, "terminate", fence), /fence|identity/i);
    assert.deepEqual(
      parseProcessReconciliation(await backend.reconcile({
        ...binding,
        birthFingerprint: { ...binding.birthFingerprint, discriminator: "0".repeat(64) },
      }, takeoverFence)),
      { state: "identity_mismatch" },
    );
    assert.deepEqual(
      parseProcessReconciliation(await backend.reconcile({ ...binding, opaqueIdentity: "missing" }, takeoverFence)),
      { state: "outcome_unknown" },
    );
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(parseProcessReconciliation(await backend.reconcile(binding, takeoverFence)).state, "running");
    const observation = backend.observe(binding, async () => undefined, takeoverFence);
    const stopped = await backend.signal(binding, "force_terminate", takeoverFence).catch((error) => error);
    if (stopped instanceof Error) assert.match(stopped.message, /output|close|deadline|timeout/i);
    else assert.equal(parseProcessSignalResult(stopped).state, "exited");
    assert.equal((await observation as { state: string }).state, "exited");
    assert.equal(parseProcessEmptyVerification(await backend.verifyEmpty(binding, takeoverFence)).empty, true);
  } finally {
    await backend.signal(binding, "force_terminate", takeoverFence).catch(() => undefined);
    await backend.release(binding, takeoverFence).catch(() => undefined);
    await service.stopRun("run").catch(() => undefined);
    service.close();
    if (processIsAlive(hostRecord.supervisor.supervisorPid)) process.kill(hostRecord.supervisor.supervisorPid, "SIGKILL");
    await waitForCondition(() => !processIsAlive(hostRecord.supervisor.supervisorPid));
    rmSync(root, { recursive: true, force: true, maxRetries: 30, retryDelay: 50 });
  }
});

test("Windows Job v2 channel performs a real duplex roundtrip with detach and reattach", { timeout: 60_000 }, async (t) => {
  if (process.platform !== "win32") {
    t.skip("Windows Job Object duplex fixture requires a Windows host.");
    return;
  }
  const root = mkdtempSync(join(tmpdir(), "aiboard-windows-job-channel-"));
  const workspace = join(root, "workspace");
  mkdirSync(workspace);
  const service = new ManagedProcessService({ stateDirectory: join(root, "state") });
  const backend = createWindowsProcessBackend({ jobObjects: { service }, semanticFacts: verifiedWindowsSemanticFacts }) as WindowsJobObjectProcessBackend;
  const duplexRequest = request(["-e", "process.stdin.pipe(process.stdout)"]);
  const launch = parseProcessLaunchResult(await backend.launch({
    ...duplexRequest,
    intent: { ...duplexRequest.intent, invocationId: "windows-job-duplex", workingDirectory: workspace },
    grant: { ...duplexRequest.grant, invocationId: "windows-job-duplex" },
  }));
  const binding = { ...bindingFor(launch), backendId: "runner-windows-job-v1" };
  try {
    const provider = backend.backpressuredChannelProvider();
    const first = await provider.acquire(binding, fence);
    const received: Buffer[] = [];
    first.subscribeBackpressuredOutput(async (metadata, bytes) => {
      received.push(Buffer.from(bytes));
      return metadata;
    });
    const firstPayload = Buffer.from("one\n");
    assert.deepEqual(await first.write({ sequence: 1, byteLength: firstPayload.byteLength, digest: createHash("sha256").update(firstPayload).digest("hex"), timeoutMs: 2_000 }, firstPayload), { acknowledged: true, sequence: 1 });
    const higherFence = { ownerId: "recovery-owner", fencingToken: fence.fencingToken + 1 };
    const takeover = await provider.acquire(binding, higherFence);
    await assert.rejects(first.closeInput(), /fence|stale|ownership/i);
    await first.detach();
    await takeover.detach();
    const recovered = await provider.reattach(binding, higherFence);
    assert.equal(recovered.nextSequence, 2);
    recovered.channel.subscribeBackpressuredOutput(async (metadata, bytes) => { received.push(Buffer.from(bytes)); return metadata; });
    const payload = Buffer.alloc(64 * 1024, 0x61);
    assert.deepEqual(await recovered.channel.write({ sequence: 2, byteLength: payload.byteLength, digest: createHash("sha256").update(payload).digest("hex"), timeoutMs: 2_000 }, payload), { acknowledged: true, sequence: 2 });
    await recovered.channel.closeInput();
    await recovered.channel.waitForTerminal();
    assert.deepEqual(Buffer.concat(received), Buffer.concat([firstPayload, payload]));
  } finally {
    await backend.signal(binding, "force_terminate", { ownerId: "job-test-cleanup", fencingToken: fence.fencingToken + 2 }).catch(() => undefined);
    await service.stopRun("run").catch(() => undefined);
    service.close();
    try { rmSync(root, { recursive: true, force: true, maxRetries: 30, retryDelay: 50 }); } catch {}
  }
});

test("Windows Job lowest host boundary rejects held write after a higher-fence takeover", { timeout: 60_000 }, async (t) => {
  if (process.platform !== "win32") { t.skip("Windows Job fence fixture requires a Windows host."); return; }
  const root = mkdtempSync(join(tmpdir(), "aiboard-windows-job-write-fence-"));
  const workspace = join(root, "workspace"); mkdirSync(workspace);
  let entered!: () => void; let resume!: () => void; let hold = true;
  const atBoundary = new Promise<void>((resolve) => { entered = resolve; });
  const barrier = new Promise<void>((resolve) => { resume = resolve; });
  const host = createWindowsJobProcessHost({ stateDirectory: join(root, "state"), beforeFenceEffect: async (kind) => {
    if (kind === "write" && hold) { hold = false; entered(); await barrier; }
  } });
  const backend = new WindowsJobObjectProcessBackend(host);
  const duplexRequest = request(["-e", "process.stdin.on('data',b=>process.stdout.write(b));process.stdin.on('end',()=>process.exit(0))"]);
  const launch = parseProcessLaunchResult(await backend.launch({ ...duplexRequest, intent: { ...duplexRequest.intent, invocationId: "job-write-fence", workingDirectory: workspace }, grant: { ...duplexRequest.grant, invocationId: "job-write-fence" } }));
  const binding = { ...bindingFor(launch), backendId: "runner-windows-job-v1" };
  const provider = backend.backpressuredChannelProvider();
  const old = await provider.acquire(binding, fence);
  const payload = Buffer.from("stale");
  const stale = old.write({ sequence: 1, byteLength: payload.byteLength, digest: createHash("sha256").update(payload).digest("hex"), timeoutMs: 2_000 }, payload);
  await atBoundary;
  const higher = { ownerId: "job-recovery", fencingToken: fence.fencingToken + 1 };
  const recovered = await provider.acquire(binding, higher);
  resume();
  try {
    await assert.rejects(stale, /fence|stale|identity/i);
    const fresh = Buffer.from("fresh");
    recovered.subscribeBackpressuredOutput(async (metadata) => metadata);
    assert.deepEqual(await recovered.write({ sequence: 1, byteLength: fresh.byteLength, digest: createHash("sha256").update(fresh).digest("hex"), timeoutMs: 2_000 }, fresh), { acknowledged: true, sequence: 1 });
    await recovered.closeInput(); await recovered.waitForTerminal();
  } finally {
    resume(); await old.detach(); await recovered.detach();
    await backend.signal(binding, "force_terminate", higher).catch(() => undefined);
    await backend.release(binding, higher).catch(() => undefined);
    rmSync(root, { recursive: true, force: true, maxRetries: 30, retryDelay: 50 });
  }
});

test("Windows Job host rejects oversized input before any owned effect", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-windows-job-input-limit-"));
  let effects = 0;
  const host = createWindowsJobProcessHost({ stateDirectory: root, platform: "win32", maxInputBytes: 4, beforeFenceEffect: () => { effects += 1; } });
  try {
    await assert.rejects(host.writeOwnedInput!("missing", { runId: "run", sessionId: "session" }, fence, 1, Buffer.alloc(5)), /exceeds|limit|large/i);
    assert.equal(effects, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("Windows Job lowest host boundary rejects held output acknowledgement after takeover", { timeout: 60_000 }, async (t) => {
  if (process.platform !== "win32") { t.skip("Windows Job fence fixture requires a Windows host."); return; }
  const root = mkdtempSync(join(tmpdir(), "aiboard-windows-job-output-fence-"));
  const stateDirectory = join(root, "state"); const workspace = join(root, "workspace"); mkdirSync(workspace);
  let entered!: () => void; let resume!: () => void; let hold = true;
  const atBoundary = new Promise<void>((resolve) => { entered = resolve; });
  const barrier = new Promise<void>((resolve) => { resume = resolve; });
  const host = createWindowsJobProcessHost({ stateDirectory, beforeFenceEffect: async (kind) => {
    if (kind === "output_ack" && hold) { hold = false; entered(); await barrier; }
  } });
  const backend = new WindowsJobObjectProcessBackend(host);
  const outputRequest = request(["-e", "process.stdin.on('data',b=>process.stdout.write(Buffer.from('held:'+b)));process.stdin.on('end',()=>process.exit(0))"]);
  const launch = parseProcessLaunchResult(await backend.launch({ ...outputRequest, intent: { ...outputRequest.intent, invocationId: "job-output-fence", workingDirectory: workspace }, grant: { ...outputRequest.grant, invocationId: "job-output-fence" } }));
  const binding = { ...bindingFor(launch), backendId: "runner-windows-job-v1" };
  const identity = JSON.parse(Buffer.from(launch.opaqueIdentity, "base64url").toString("utf8")) as { processId: string };
  const provider = backend.backpressuredChannelProvider();
  const old = await provider.acquire(binding, fence);
  old.subscribeBackpressuredOutput(async (metadata) => metadata);
  const trigger = Buffer.from("one\n");
  await old.write({ sequence: 1, byteLength: trigger.byteLength, digest: createHash("sha256").update(trigger).digest("hex"), timeoutMs: 2_000 }, trigger);
  await old.closeInput();
  await atBoundary;
  const higher = { ownerId: "job-recovery", fencingToken: fence.fencingToken + 1 };
  const recovered = await provider.acquire(binding, higher);
  resume();
  try {
    await assert.rejects(old.waitForTerminal(), /fence|stale|identity/i);
    const record = JSON.parse(readFileSync(join(stateDirectory, `${identity.processId}.json`), "utf8")) as { outputOffsets: { stdout: number } };
    assert.equal(record.outputOffsets.stdout, 0);
    const replay: Buffer[] = [];
    recovered.subscribeBackpressuredOutput(async (metadata, bytes) => { replay.push(Buffer.from(bytes)); return metadata; });
    await recovered.closeInput(); await recovered.waitForTerminal();
    assert.equal(Buffer.concat(replay).toString(), "held:one\n");
  } finally {
    resume(); await old.detach(); await recovered.detach();
    await backend.signal(binding, "force_terminate", higher).catch(() => undefined);
    await backend.release(binding, higher).catch(() => undefined);
    rmSync(root, { recursive: true, force: true, maxRetries: 30, retryDelay: 50 });
  }
});

test("Windows Job lowest host boundary rejects held signal and release after takeover", { timeout: 60_000 }, async (t) => {
  if (process.platform !== "win32") { t.skip("Windows Job fence fixture requires a Windows host."); return; }
  await t.test("signal", async () => {
    const root = mkdtempSync(join(tmpdir(), "aiboard-windows-job-signal-fence-")); const workspace = join(root, "workspace"); mkdirSync(workspace);
    let entered!: () => void; let resume!: () => void; let hold = true;
    const atBoundary = new Promise<void>((resolve) => { entered = resolve; }); const barrier = new Promise<void>((resolve) => { resume = resolve; });
    const host = createWindowsJobProcessHost({ stateDirectory: join(root, "state"), beforeFenceEffect: async (kind) => { if (kind === "signal" && hold) { hold = false; entered(); await barrier; } } });
    const backend = new WindowsJobObjectProcessBackend(host);
    const launch = parseProcessLaunchResult(await backend.launch({ ...request(["-e", "setInterval(()=>{},1000)"]), intent: { ...request(["-e", "setInterval(()=>{},1000)"]).intent, invocationId: "job-signal-fence", workingDirectory: workspace }, grant: { ...request([]).grant, invocationId: "job-signal-fence" } }));
    const binding = { ...bindingFor(launch), backendId: "runner-windows-job-v1" };
    const identity = JSON.parse(Buffer.from(launch.opaqueIdentity, "base64url").toString("utf8")) as { processId: string; runId: string; sessionId: string };
    const stale = backend.signal(binding, "terminate", fence); await atBoundary;
    const higher = { ownerId: "job-recovery", fencingToken: fence.fencingToken + 1 };
    await host.claimOwnedFence!(identity.processId, { runId: identity.runId, sessionId: identity.sessionId }, higher); resume();
    try {
      await assert.rejects(stale, /fence|stale|identity/i);
      assert.equal(parseProcessReconciliation(await backend.reconcile(binding, higher)).state, "running");
    } finally {
      resume(); await backend.signal(binding, "force_terminate", higher).catch(() => undefined); await backend.release(binding, higher).catch(() => undefined);
      rmSync(root, { recursive: true, force: true, maxRetries: 30, retryDelay: 50 });
    }
  });
  await t.test("release", async () => {
    const root = mkdtempSync(join(tmpdir(), "aiboard-windows-job-release-fence-")); const stateDirectory = join(root, "state"); const workspace = join(root, "workspace"); mkdirSync(workspace);
    let entered!: () => void; let resume!: () => void; let hold = true;
    const atBoundary = new Promise<void>((resolve) => { entered = resolve; }); const barrier = new Promise<void>((resolve) => { resume = resolve; });
    const host = createWindowsJobProcessHost({ stateDirectory, beforeFenceEffect: async (kind) => { if (kind === "release" && hold) { hold = false; entered(); await barrier; } } });
    const backend = new WindowsJobObjectProcessBackend(host); const exitRequest = request(["-e", "process.exit(0)"]);
    const launch = parseProcessLaunchResult(await backend.launch({ ...exitRequest, intent: { ...exitRequest.intent, invocationId: "job-release-fence", workingDirectory: workspace }, grant: { ...exitRequest.grant, invocationId: "job-release-fence" } }));
    const binding = { ...bindingFor(launch), backendId: "runner-windows-job-v1" };
    const identity = JSON.parse(Buffer.from(launch.opaqueIdentity, "base64url").toString("utf8")) as { processId: string; runId: string; sessionId: string };
    await backend.observe(binding, async () => undefined, fence);
    const stale = backend.release(binding, fence); await atBoundary;
    const higher = { ownerId: "job-recovery", fencingToken: fence.fencingToken + 1 };
    await host.claimOwnedFence!(identity.processId, { runId: identity.runId, sessionId: identity.sessionId }, higher); resume();
    try {
      await assert.rejects(stale, /fence|stale|identity/i);
      const record = JSON.parse(readFileSync(join(stateDirectory, `${identity.processId}.json`), "utf8")) as { backendOwnershipReleasedAt?: string };
      assert.equal(record.backendOwnershipReleasedAt, undefined);
      assert.equal(parseProcessReconciliation(await backend.reconcile(binding, higher)).state, "exited", "higher-fence control must remain usable after stale release fails");
      assert.deepEqual(await backend.release(binding, higher), { released: true });
    } finally {
      resume(); await backend.signal(binding, "force_terminate", higher).catch(() => undefined); await backend.release(binding, higher).catch(() => undefined);
      rmSync(root, { recursive: true, force: true, maxRetries: 30, retryDelay: 50 });
    }
  });
});

test("Windows Job terminal and release fail closed when owned output evidence disappears", { timeout: 60_000 }, async (t) => {
  if (process.platform !== "win32") { t.skip("Windows Job output evidence fixture requires a Windows host."); return; }
  const root = mkdtempSync(join(tmpdir(), "aiboard-windows-job-missing-output-")); const stateDirectory = join(root, "state"); const workspace = join(root, "workspace"); mkdirSync(workspace);
  const host = createWindowsJobProcessHost({ stateDirectory }); const backend = new WindowsJobObjectProcessBackend(host);
  const exitRequest = request(["-e", "process.exit(0)"]);
  const launch = parseProcessLaunchResult(await backend.launch({ ...exitRequest, intent: { ...exitRequest.intent, invocationId: "job-missing-output", workingDirectory: workspace }, grant: { ...exitRequest.grant, invocationId: "job-missing-output" } }));
  const binding = { ...bindingFor(launch), backendId: "runner-windows-job-v1" };
  const identity = JSON.parse(Buffer.from(launch.opaqueIdentity, "base64url").toString("utf8")) as { processId: string };
  try { await backend.observe(binding, async () => undefined, fence); }
  catch (error) { throw new Error("Windows Job missing-output fixture failed during initial observe.", { cause: error }); }
  rmSync(join(stateDirectory, identity.processId, "stdout.log"), { force: true });
  try {
    assert.deepEqual(await backend.reconcile(binding, fence), { state: "outcome_unknown" });
    await assert.rejects(backend.release(binding, fence), /output|evidence|missing|unreadable/i);
    assert.equal(existsSync(join(stateDirectory, `${identity.processId}.json`)), true);
  } finally {
    await backend.signal(binding, "force_terminate", fence).catch(() => undefined);
    rmSync(root, { recursive: true, force: true, maxRetries: 30, retryDelay: 50 });
  }
});

test("Windows Job output read fails closed when evidence disappears after attach re-attestation", { timeout: 30_000 }, async (t) => {
  if (process.platform !== "win32") { t.skip("Windows Job output read fixture requires a Windows host."); return; }
  const root = mkdtempSync(join(tmpdir(), "aiboard-windows-job-read-missing-"));
  const stateDirectory = join(root, "state"); const workspace = join(root, "workspace"); mkdirSync(workspace);
  let stdoutPath = ""; let deleteBeforeRead = false;
  const host = createWindowsJobProcessHost({
    stateDirectory,
    beforeFenceEffect: (kind) => {
      if (kind === "read" && deleteBeforeRead) { deleteBeforeRead = false; rmSync(stdoutPath, { force: true }); }
    },
  });
  const backend = new WindowsJobObjectProcessBackend(host);
  const liveRequest = request(["-e", "setInterval(()=>{},1000)"]);
  const launch = parseProcessLaunchResult(await backend.launch({ ...liveRequest, intent: { ...liveRequest.intent, invocationId: "job-read-missing", workingDirectory: workspace }, grant: { ...liveRequest.grant, invocationId: "job-read-missing" } }));
  const binding = { ...bindingFor(launch), backendId: "runner-windows-job-v1" };
  const identity = JSON.parse(Buffer.from(launch.opaqueIdentity, "base64url").toString("utf8")) as { processId: string; runId: string; sessionId: string };
  stdoutPath = join(stateDirectory, identity.processId, "stdout.log");
  try {
    await host.attachOwnedChannel!(identity.processId, { runId: identity.runId, sessionId: identity.sessionId }, fence);
    deleteBeforeRead = true;
    await assert.rejects(
      async () => await host.readOwnedOutput(identity.processId, { runId: identity.runId, sessionId: identity.sessionId }, { stdout: 0, stderr: 0 }, fence),
      /output|evidence|missing|ENOENT|unreadable/i,
    );
  } finally {
    if (!existsSync(stdoutPath)) writeFileSync(stdoutPath, "");
    await backend.signal(binding, "force_terminate", fence).catch(() => undefined);
    await backend.release(binding, fence).catch(() => undefined);
    rmSync(root, { recursive: true, force: true, maxRetries: 30, retryDelay: 50 });
  }
});

test("Windows Job producer pauses at the retained chunk and byte window until exact acknowledgement", { timeout: 60_000 }, async (t) => {
  if (process.platform !== "win32") {
    t.skip("Windows Job Object producer backpressure requires a Windows host.");
    return;
  }
  for (const stream of ["stdout", "stderr"] as const) await t.test(stream, async () => {
    const root = mkdtempSync(join(tmpdir(), `aiboard-windows-job-backpressure-${stream}-`));
    const stateDirectory = join(root, "state");
    const workspace = join(root, "workspace");
    mkdirSync(workspace);
    const host = createWindowsJobProcessHost({
      stateDirectory,
      maxPollBytes: 16 * 1024,
      maxRetainedOutputChunks: 2,
      maxRetainedOutputBytes: 32 * 1024,
    } as Parameters<typeof createWindowsJobProcessHost>[0]);
    const backend = new WindowsJobObjectProcessBackend(host);
    const outputRequest = request(["-e", `process.${stream}.write('x'.repeat(131072))`]);
    const launch = parseProcessLaunchResult(await backend.launch({
      ...outputRequest,
      intent: { ...outputRequest.intent, invocationId: `windows-job-backpressure-${stream}`, workingDirectory: workspace },
      grant: { ...outputRequest.grant, invocationId: `windows-job-backpressure-${stream}` },
    }));
    const binding = { ...bindingFor(launch), backendId: "runner-windows-job-v1" };
    const identity = JSON.parse(Buffer.from(launch.opaqueIdentity, "base64url").toString("utf8")) as { processId: string };
    const hostRecord = JSON.parse(readFileSync(join(stateDirectory, `${identity.processId}.json`), "utf8")) as { supervisor: { supervisorPid: number } };
    let releaseFirst!: () => void;
    const held = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let first = true;
    let delivered = 0;
    const channel = await backend.backpressuredChannelProvider().acquire(binding, fence);
    channel.subscribeBackpressuredOutput(async (metadata, bytes) => {
      if (metadata.stream === stream) delivered += bytes.byteLength;
      if (first) { first = false; await held; }
      return metadata;
    });
    const evidencePath = join(stateDirectory, identity.processId, `${stream}.log`);
    const statusPath = join(stateDirectory, identity.processId, "supervisor.jsonl");
    try {
      await waitForCondition(() => existsSync(evidencePath) && statSync(evidencePath).size > 0);
      await new Promise((resolve) => setTimeout(resolve, 500));
      const durable = JSON.parse(readFileSync(statusPath, "utf8").trim().split(/\r?\n/).at(-1)!) as { retainedOutputChunks: number; retainedOutputBytes: number };
      assert.ok(durable.retainedOutputChunks <= 2, `${stream} producer exceeded the configured unacknowledged chunk window`);
      assert.ok(durable.retainedOutputBytes <= 32 * 1024, `${stream} producer exceeded the configured unacknowledged byte window: ${JSON.stringify(durable)}`);
      assert.ok(statSync(evidencePath).size <= 32 * 1024, `${stream} producer drained beyond the configured unacknowledged byte window`);
      releaseFirst();
      await channel.waitForTerminal();
      assert.equal(delivered, 131072);
      await backend.release(binding, fence);
      await waitForCondition(() => !processIsAlive(hostRecord.supervisor.supervisorPid));
    } finally {
      releaseFirst();
      await channel.detach();
      await backend.signal(binding, "force_terminate", fence).catch(() => undefined);
      await backend.release(binding, fence).catch(() => undefined);
      if (processIsAlive(hostRecord.supervisor.supervisorPid)) process.kill(hostRecord.supervisor.supervisorPid, "SIGKILL");
      await waitForCondition(() => !processIsAlive(hostRecord.supervisor.supervisorPid));
      rmSync(root, { recursive: true, force: true, maxRetries: 30, retryDelay: 50 });
    }
  });
});

test("Windows Job coalesced read acknowledges every exact retained chunk boundary through its end", { timeout: 60_000 }, async (t) => {
  if (process.platform !== "win32") { t.skip("Windows Job coalesced output fixture requires a Windows host."); return; }
  const root = mkdtempSync(join(tmpdir(), "aiboard-windows-job-coalesced-")); const stateDirectory = join(root, "state"); const workspace = join(root, "workspace"); mkdirSync(workspace);
  const host = createWindowsJobProcessHost({ stateDirectory, maxPollBytes: 128 * 1024, maxRetainedOutputChunks: 8, maxRetainedOutputBytes: 128 * 1024, maxRetainedOutputChunkBytes: 16 * 1024 });
  const backend = new WindowsJobObjectProcessBackend(host);
  const outputRequest = request(["-e", "process.stdout.write('a'.repeat(40000));setTimeout(()=>process.stdout.write('b'.repeat(40000)),250);process.stdin.resume();process.stdin.on('end',()=>setTimeout(()=>process.exit(0),500))"]);
  const launch = parseProcessLaunchResult(await backend.launch({ ...outputRequest, intent: { ...outputRequest.intent, invocationId: "job-coalesced", workingDirectory: workspace }, grant: { ...outputRequest.grant, invocationId: "job-coalesced" } }));
  const binding = { ...bindingFor(launch), backendId: "runner-windows-job-v1" };
  const identity = JSON.parse(Buffer.from(launch.opaqueIdentity, "base64url").toString("utf8")) as { processId: string };
  const hostRecord = JSON.parse(readFileSync(join(stateDirectory, `${identity.processId}.json`), "utf8")) as { supervisor: { supervisorPid: number } };
  const statusPath = join(stateDirectory, identity.processId, "supervisor.jsonl");
  let channel: Awaited<ReturnType<ReturnType<WindowsJobObjectProcessBackend["backpressuredChannelProvider"]>["acquire"]>> | undefined;
  try {
    channel = await backend.backpressuredChannelProvider().acquire(binding, fence);
    await channel.closeInput();
    await waitForCondition(() => {
      const durable = JSON.parse(readFileSync(statusPath, "utf8").trim().split(/\r?\n/).at(-1)!) as { retainedOutputChunks?: number };
      return (durable.retainedOutputChunks ?? 0) >= 2;
    });
    const output: Buffer[] = [];
    channel.subscribeBackpressuredOutput(async (metadata, bytes) => { output.push(Buffer.from(bytes)); return metadata; });
    await channel.waitForTerminal();
    assert.equal(Buffer.concat(output).toString(), `${"a".repeat(40000)}${"b".repeat(40000)}`);
    const settled = JSON.parse(readFileSync(statusPath, "utf8").trim().split(/\r?\n/).at(-1)!) as { retainedOutputChunks: number; retainedOutputBytes: number };
    assert.equal(settled.retainedOutputChunks, 0); assert.equal(settled.retainedOutputBytes, 0);
    await backend.release(binding, fence);
  } finally {
    await channel?.detach().catch(() => undefined);
    await backend.signal(binding, "force_terminate", fence).catch(() => undefined); await backend.release(binding, fence).catch(() => undefined);
    if (processIsAlive(hostRecord.supervisor.supervisorPid)) process.kill(hostRecord.supervisor.supervisorPid, "SIGKILL");
    await waitForCondition(() => !processIsAlive(hostRecord.supervisor.supervisorPid));
    rmSync(root, { recursive: true, force: true, maxRetries: 30, retryDelay: 50 });
  }
});

test("Windows Job signal reports exact empty while retained output drains and exits after acknowledgement", { timeout: 30_000 }, async (t) => {
  if (process.platform !== "win32") { t.skip("Windows Job retained signal fixture requires a Windows host."); return; }
  const root = mkdtempSync(join(tmpdir(), "aiboard-windows-job-signal-retained-")); const stateDirectory = join(root, "state"); const workspace = join(root, "workspace"); mkdirSync(workspace);
  const host = createWindowsJobProcessHost({ stateDirectory, stopDeadlineMs: 500 }); const backend = new WindowsJobObjectProcessBackend(host);
  const outputRequest = request(["-e", "const{spawn}=require('node:child_process');const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});c.unref();process.stdout.write('h'.repeat(131072));setTimeout(()=>process.exit(0),50)"]);
  const launch = parseProcessLaunchResult(await backend.launch({ ...outputRequest, intent: { ...outputRequest.intent, invocationId: "job-signal-retained", workingDirectory: workspace }, grant: { ...outputRequest.grant, invocationId: "job-signal-retained" } }));
  const binding = { ...bindingFor(launch), backendId: "runner-windows-job-v1" };
  const identity = JSON.parse(Buffer.from(launch.opaqueIdentity, "base64url").toString("utf8")) as { processId: string };
  const record = JSON.parse(readFileSync(join(stateDirectory, `${identity.processId}.json`), "utf8")) as { supervisor: { supervisorPid: number } };
  const statusPath = join(stateDirectory, identity.processId, "supervisor.jsonl");
  let channel: Awaited<ReturnType<ReturnType<WindowsJobObjectProcessBackend["backpressuredChannelProvider"]>["acquire"]>> | undefined;
  let entered!: () => void; let resume!: () => void; const atSink = new Promise<void>((resolve) => { entered = resolve; }); const barrier = new Promise<void>((resolve) => { resume = resolve; });
  const output: Buffer[] = [];
  try {
    channel = await backend.backpressuredChannelProvider().acquire(binding, fence);
    channel.subscribeBackpressuredOutput(async (metadata, bytes) => { output.push(Buffer.from(bytes)); entered(); await barrier; return metadata; });
    await atSink;
    let signalled = parseProcessSignalResult(await backend.signal(binding, "force_terminate", fence));
    if (signalled.state === "running") {
      await waitForCondition(() => {
        const durable = JSON.parse(readFileSync(statusPath, "utf8").trim().split(/\r?\n/).at(-1)!) as { jobEmptyProof?: boolean };
        return durable.jobEmptyProof === true;
      }, 20_000);
      signalled = parseProcessSignalResult(await backend.signal(binding, "force_terminate", fence));
    }
    assert.deepEqual(signalled, { state: "exited" });
    resume();
    await channel.waitForTerminal(); assert.equal(Buffer.concat(output).toString(), "h".repeat(131072)); await channel.detach(); channel = undefined;
    await backend.release(binding, fence);
    await waitForCondition(() => !processIsAlive(record.supervisor.supervisorPid));
  } finally {
    resume();
    await channel?.detach().catch(() => undefined);
    if (processIsAlive(record.supervisor.supervisorPid)) process.kill(record.supervisor.supervisorPid, "SIGKILL");
    await waitForCondition(() => !processIsAlive(record.supervisor.supervisorPid));
    rmSync(root, { recursive: true, force: true, maxRetries: 30, retryDelay: 50 });
  }
});

test("Windows Job observation uses absolute durable offsets beyond the configured tail", async (t) => {
  if (process.platform !== "win32") {
    t.skip("Windows Job Object output fixture requires a Windows host.");
    return;
  }
  const root = mkdtempSync(join(tmpdir(), "aiboard-windows-backend-output-"));
  const workspace = join(root, "workspace");
  mkdirSync(workspace);
  const maxPollBytes = 64 * 1024;
  const service = new ManagedProcessService({ stateDirectory: join(root, "state"), maxPollBytes });
  const backend = createWindowsProcessBackend({ jobObjects: { service }, semanticFacts: verifiedWindowsSemanticFacts });
  const oversized = "x".repeat(300_000);
  const outputRequest = request(["-e", "process.stdout.write('x'.repeat(300000))"]);
  const launch = parseProcessLaunchResult(await backend.launch({
    ...outputRequest,
    intent: { ...outputRequest.intent, invocationId: "windows-job-output", workingDirectory: workspace },
    grant: { ...outputRequest.grant, invocationId: "windows-job-output" },
  }));
  const binding = { ...bindingFor(launch), backendId: "runner-windows-job-v1" };
  const chunks: Buffer[] = [];
  try {
    const observation = await backend.observe(binding, async (stream, bytes) => {
      if (stream === "stdout") {
        assert.ok(bytes.byteLength <= maxPollBytes);
        chunks.push(Buffer.from(bytes));
      }
    }, fence);
    assert.equal(parseProcessReconciliation(observation).state, "exited");
    assert.equal(Buffer.concat(chunks).toString(), oversized);
    assert.equal(parseProcessEmptyVerification(await backend.verifyEmpty(binding, fence)).empty, true);
  } finally {
    await service.stopRun("run").catch(() => undefined);
    service.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 30, retryDelay: 50 });
  }
});

test("Windows Job observation advances absolute offsets across incremental durable reads", async () => {
  const durable = Buffer.from("first-second-third");
  const requestedOffsets: number[] = [];
  let deliveredThrough = 0;
  const service: WindowsJobProcessService = {
    probeActiveJobCreateClose: async () => true,
    launchOwned: async () => { throw new Error("fixture does not launch"); },
    signalOwned: async () => { throw new Error("fixture does not signal"); },
    releaseOwned: async (processId) => stoppedJobSnapshot(processId),
    readOwnedOutput: (_processId, _context, offsets) => {
      requestedOffsets.push(offsets.stdout);
      if (requestedOffsets.length > 4) throw new Error("absolute output offset did not advance");
      const end = Math.min(offsets.stdout + 6, durable.byteLength);
      const stdout = durable.subarray(offsets.stdout, end);
      deliveredThrough = end;
      return {
        stdout,
        stderr: new Uint8Array(),
        next: { stdout: end, stderr: offsets.stderr },
      };
    },
    reconcileOwned: async () => ({
      processId: "job-output-contract",
      pid: 9001,
      status: deliveredThrough === durable.byteLength ? "stopped" : "running",
      exitCode: deliveredThrough === durable.byteLength ? 0 : null,
      signal: null,
      startedAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      stdout: "",
      stderr: "",
      ownershipReleased: deliveredThrough === durable.byteLength,
    }),
  };
  const backend = new WindowsJobObjectProcessBackend(service);
  const chunks: Buffer[] = [];

  const observation = await backend.observe(jobBinding("job-output-contract"), async (stream, bytes) => {
    if (stream === "stdout") chunks.push(Buffer.from(bytes));
  }, fence);

  assert.deepEqual(requestedOffsets, [0, 6, 12, 18]);
  assert.equal(Buffer.concat(chunks).toString(), "first-second-third");
  assert.deepEqual(parseProcessReconciliation(observation), { state: "exited", exitCode: 0 });
});

test("Windows Job observation surfaces a throwing sink and retains unacknowledged output", async () => {
  const bytes = Buffer.from("held");
  let acknowledgements = 0;
  const service: WindowsJobProcessService = {
    probeActiveJobCreateClose: async () => true,
    launchOwned: async () => { throw new Error("fixture does not launch"); },
    signalOwned: async () => { throw new Error("fixture does not signal"); },
    releaseOwned: async (processId) => stoppedJobSnapshot(processId),
    readOwnedOutput: (_processId, _owner, offsets) => ({
      stdout: offsets.stdout === 0 ? bytes : new Uint8Array(),
      stderr: new Uint8Array(),
      next: { stdout: offsets.stdout === 0 ? bytes.byteLength : offsets.stdout, stderr: offsets.stderr },
    }),
    reconcileOwned: async () => stoppedJobSnapshot("job-throwing-sink"),
    attachOwnedChannel: async () => ({
      nextSequence: 1,
      inputClosed: false,
      outputOffsets: { stdout: 0, stderr: 0 },
      outputSequences: { stdout: 0, stderr: 0 },
      snapshot: stoppedJobSnapshot("job-throwing-sink"),
    }),
    writeOwnedInput: async (_processId, _owner, _fence, sequence) => ({ acknowledged: true, sequence }),
    closeOwnedInput: async () => undefined,
    acknowledgeOwnedOutput: async () => { acknowledgements += 1; },
    claimOwnedFence: async () => undefined,
  };
  const backend = new WindowsJobObjectProcessBackend(service);
  await assert.rejects(
    backend.observe(jobBinding("job-throwing-sink"), async () => { throw new Error("sink rejected bytes"); }, fence),
    /sink rejected bytes/,
  );
  assert.equal(acknowledgements, 0);
});

test("Windows Job detach settles a held sink without acknowledging and reattach replays it", async () => {
  const bytes = Buffer.from("held"); let acknowledgements = 0;
  const service: WindowsJobProcessService = {
    probeActiveJobCreateClose: async () => true, launchOwned: async () => { throw new Error("fixture does not launch"); },
    signalOwned: async () => { throw new Error("fixture does not signal"); }, releaseOwned: async (processId) => stoppedJobSnapshot(processId),
    readOwnedOutput: (_processId, _owner, offsets) => ({ stdout: offsets.stdout === 0 ? bytes : new Uint8Array(), stderr: new Uint8Array(), next: { stdout: bytes.byteLength, stderr: 0 } }),
    reconcileOwned: async () => stoppedJobSnapshot("job-detach-held"),
    attachOwnedChannel: async () => ({ nextSequence: 1, inputClosed: false, outputOffsets: { stdout: acknowledgements ? bytes.byteLength : 0, stderr: 0 }, outputSequences: { stdout: acknowledgements, stderr: 0 }, snapshot: stoppedJobSnapshot("job-detach-held") }),
    writeOwnedInput: async (_processId, _owner, _fence, sequence) => ({ acknowledged: true, sequence }), closeOwnedInput: async () => undefined,
    acknowledgeOwnedOutput: async () => { acknowledgements += 1; }, claimOwnedFence: async () => undefined,
  };
  const backend = new WindowsJobObjectProcessBackend(service); const provider = backend.backpressuredChannelProvider(); const binding = jobBinding("job-detach-held");
  let entered!: () => void; let resume!: () => void; const atSink = new Promise<void>((resolve) => { entered = resolve; }); const held = new Promise<void>((resolve) => { resume = resolve; });
  const first = await provider.acquire(binding, fence); first.subscribeBackpressuredOutput(async (metadata) => { entered(); await held; return metadata; });
  await atSink; const detached = first.detach(); resume(); await detached;
  assert.equal(acknowledgements, 0);
  const second = await provider.acquire(binding, fence); second.subscribeBackpressuredOutput(async (metadata) => metadata);
  try { await second.waitForTerminal(); assert.equal(acknowledgements, 1); }
  finally { resume(); await first.detach(); await second.detach(); }
});

test("Windows Job unsubscribe during held host acknowledgement never delivers the next stream to the old sink", async () => {
  const durable = { stdout: 0, stderr: 0 }; const sequences = { stdout: 0, stderr: 0 }; const delivered: string[] = []; const acknowledged: string[] = [];
  let entered!: () => void; let resume!: () => void; const atAck = new Promise<void>((resolve) => { entered = resolve; }); const held = new Promise<void>((resolve) => { resume = resolve; });
  const service: WindowsJobProcessService = {
    probeActiveJobCreateClose: async () => true, launchOwned: async () => { throw new Error("fixture does not launch"); }, signalOwned: async () => { throw new Error("fixture does not signal"); }, releaseOwned: async (processId) => stoppedJobSnapshot(processId),
    readOwnedOutput: (_processId, _owner, offsets) => ({ stdout: offsets.stdout === 0 ? Buffer.from("o") : new Uint8Array(), stderr: offsets.stderr === 0 ? Buffer.from("e") : new Uint8Array(), next: { stdout: 1, stderr: 1 } }),
    reconcileOwned: async () => ({ ...stoppedJobSnapshot("job-held-host-ack"), status: "running", ownershipReleased: false }),
    attachOwnedChannel: async () => ({ nextSequence: 1, inputClosed: false, outputOffsets: { ...durable }, outputSequences: { ...sequences }, snapshot: stoppedJobSnapshot("job-held-host-ack") }),
    writeOwnedInput: async (_processId, _owner, _fence, sequence) => ({ acknowledged: true, sequence }), closeOwnedInput: async () => undefined,
    acknowledgeOwnedOutput: async (_processId, _owner, _fence, stream, endOffset) => { acknowledged.push(stream); if (stream === "stdout") { entered(); await held; } durable[stream] = endOffset; sequences[stream] += 1; },
    claimOwnedFence: async () => undefined,
  };
  const backend = new WindowsJobObjectProcessBackend(service); const provider = backend.backpressuredChannelProvider(); const binding = jobBinding("job-held-host-ack");
  const first = await provider.acquire(binding, fence); const unsubscribe = first.subscribeBackpressuredOutput(async (metadata) => { delivered.push(metadata.stream); return metadata; });
  await atAck; unsubscribe(); resume(); await first.detach();
  assert.deepEqual(delivered, ["stdout"]); assert.deepEqual(acknowledged, ["stdout"]); assert.deepEqual(durable, { stdout: 1, stderr: 0 });
  const second = await provider.acquire(binding, fence); second.subscribeBackpressuredOutput(async (metadata) => { delivered.push(`replay-${metadata.stream}`); return metadata; });
  try { await waitForCondition(() => durable.stderr === 1); assert.deepEqual(delivered, ["stdout", "replay-stderr"]); }
  finally { resume(); await first.detach(); await second.detach(); }
});

test("Windows Job sink failure leaves a durable unknown terminal until retained output is acknowledged", { timeout: 30_000 }, async (t) => {
  if (process.platform !== "win32") {
    t.skip("Windows Job Object retained-output recovery requires a Windows host.");
    return;
  }
  const root = mkdtempSync(join(tmpdir(), "aiboard-windows-job-sink-failure-"));
  const stateDirectory = join(root, "state");
  const workspace = join(root, "workspace");
  mkdirSync(workspace);
  const host = createWindowsJobProcessHost({ stateDirectory });
  const backend = new WindowsJobObjectProcessBackend(host);
  const outputRequest = request(["-e", "process.stdout.write('held')"]);
  const launch = parseProcessLaunchResult(await backend.launch({
    ...outputRequest,
    intent: { ...outputRequest.intent, invocationId: "windows-job-sink-failure", workingDirectory: workspace },
    grant: { ...outputRequest.grant, invocationId: "windows-job-sink-failure" },
  }));
  const binding = { ...bindingFor(launch), backendId: "runner-windows-job-v1" };
  const identity = JSON.parse(Buffer.from(launch.opaqueIdentity, "base64url").toString("utf8")) as { processId: string };
  const statusPath = join(stateDirectory, identity.processId, "supervisor.jsonl");
  let recoveryChannel: Awaited<ReturnType<ReturnType<WindowsJobObjectProcessBackend["backpressuredChannelProvider"]>["acquire"]>> | undefined;
  try {
    await assert.rejects(
      backend.observe(binding, async () => { throw new Error("sink rejected retained bytes"); }, fence),
      /sink rejected retained bytes/,
    );
    await waitForCondition(() => {
      const durable = JSON.parse(readFileSync(statusPath, "utf8").trim().split(/\r?\n/).at(-1)!) as { status: string; retainedOutputChunks?: number };
      return durable.status === "exited_unknown" && (durable.retainedOutputChunks ?? 0) > 0;
    });
    await assert.rejects(backend.release(binding, fence), /terminal|output|retained|control/i);
  } finally {
    recoveryChannel = await backend.backpressuredChannelProvider().acquire(binding, fence).catch(() => undefined);
    if (recoveryChannel) {
      recoveryChannel.subscribeBackpressuredOutput(async (metadata) => metadata);
      await recoveryChannel.waitForTerminal().catch(() => undefined);
      await recoveryChannel.detach();
    }
    await backend.signal(binding, "force_terminate", fence).catch(() => undefined);
    await backend.release(binding, fence).catch(() => undefined);
    rmSync(root, { recursive: true, force: true, maxRetries: 30, retryDelay: 50 });
  }
});

test("Windows Job acknowledgement failure cannot report clean terminal or release retained output", { timeout: 30_000 }, async (t) => {
  if (process.platform !== "win32") {
    t.skip("Windows Job Object retained-output recovery requires a Windows host.");
    return;
  }
  const root = mkdtempSync(join(tmpdir(), "aiboard-windows-job-ack-failure-"));
  const stateDirectory = join(root, "state");
  const workspace = join(root, "workspace");
  mkdirSync(workspace);
  const host = createWindowsJobProcessHost({ stateDirectory });
  let rejectAcknowledgement = true;
  const service = new Proxy(host, {
    get(target, property) {
      if (property === "acknowledgeOwnedOutput") return async (...args: Parameters<NonNullable<WindowsJobProcessService["acknowledgeOwnedOutput"]>>) => {
        if (rejectAcknowledgement) throw new Error("injected durable acknowledgement failure");
        return await target.acknowledgeOwnedOutput!(...args);
      };
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as WindowsJobProcessService;
  const backend = new WindowsJobObjectProcessBackend(service);
  const outputRequest = request(["-e", "process.stderr.write('held')"]);
  const launch = parseProcessLaunchResult(await backend.launch({
    ...outputRequest,
    intent: { ...outputRequest.intent, invocationId: "windows-job-ack-failure", workingDirectory: workspace },
    grant: { ...outputRequest.grant, invocationId: "windows-job-ack-failure" },
  }));
  const binding = { ...bindingFor(launch), backendId: "runner-windows-job-v1" };
  const identity = JSON.parse(Buffer.from(launch.opaqueIdentity, "base64url").toString("utf8")) as { processId: string };
  const statusPath = join(stateDirectory, identity.processId, "supervisor.jsonl");
  let recoveryChannel: Awaited<ReturnType<ReturnType<WindowsJobObjectProcessBackend["backpressuredChannelProvider"]>["acquire"]>> | undefined;
  try {
    await assert.rejects(
      backend.observe(binding, async () => undefined, fence),
      /injected durable acknowledgement failure/,
    );
    await waitForCondition(() => {
      const durable = JSON.parse(readFileSync(statusPath, "utf8").trim().split(/\r?\n/).at(-1)!) as { status: string; retainedOutputChunks?: number };
      return durable.status === "exited_unknown" && (durable.retainedOutputChunks ?? 0) > 0;
    });
    await assert.rejects(backend.release(binding, fence), /terminal|output|retained|control/i);
  } finally {
    rejectAcknowledgement = false;
    recoveryChannel = await backend.backpressuredChannelProvider().acquire(binding, fence).catch(() => undefined);
    if (recoveryChannel) {
      recoveryChannel.subscribeBackpressuredOutput(async (metadata) => metadata);
      await recoveryChannel.waitForTerminal().catch(() => undefined);
      await recoveryChannel.detach();
    }
    await backend.signal(binding, "force_terminate", fence).catch(() => undefined);
    await backend.release(binding, fence).catch(() => undefined);
    rmSync(root, { recursive: true, force: true, maxRetries: 30, retryDelay: 50 });
  }
});

test("Windows Job serializes ownership observation with cancellation control", async () => {
  let running = true;
  let reconciliationActive = false;
  let signalCalls = 0;
  let releaseReconciliation!: () => void;
  const reconciliationBarrier = new Promise<void>((resolve) => { releaseReconciliation = resolve; });
  const snapshot = () => ({
    processId: "job-control-serialization",
    pid: 9001,
    status: running ? "running" as const : "stopped" as const,
    exitCode: running ? null : 143,
    signal: running ? null : "SIGTERM" as const,
    startedAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    stdout: "",
    stderr: "",
    ownershipReleased: !running,
  });
  const service: WindowsJobProcessService = {
    probeActiveJobCreateClose: async () => true,
    launchOwned: async () => { throw new Error("fixture does not launch"); },
    readOwnedOutput: (_processId, _context, offsets) => ({
      stdout: new Uint8Array(),
      stderr: new Uint8Array(),
      next: offsets,
    }),
    reconcileOwned: async () => {
      if (running) {
        reconciliationActive = true;
        await reconciliationBarrier;
        reconciliationActive = false;
      }
      return snapshot();
    },
    signalOwned: async () => {
      signalCalls += 1;
      if (reconciliationActive) {
        const error = new Error("read ECONNRESET") as Error & { code: string };
        error.code = "ECONNRESET";
        throw error;
      }
      running = false;
      return snapshot();
    },
    releaseOwned: async () => snapshot(),
  };
  const backend = new WindowsJobObjectProcessBackend(service);
  const binding = jobBinding("job-control-serialization");

  const observation = backend.observe(binding, async () => undefined, fence);
  while (!reconciliationActive) await new Promise((resolve) => setImmediate(resolve));
  const cancellation = backend.signal(binding, "terminate");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(signalCalls, 0, "cancellation must queue behind the in-flight authenticated ownership observation");

  releaseReconciliation();
  assert.equal(parseProcessSignalResult(await cancellation).state, "exited");
  assert.deepEqual(parseProcessReconciliation(await observation), { state: "exited", exitCode: 143, signal: "SIGTERM" });
});

test("Windows Job cancellation accepts exact terminal state while retained output drains", async () => {
  const processId = "job-terminal-output-drain";
  const service: WindowsJobProcessService = {
    probeActiveJobCreateClose: async () => true,
    launchOwned: async () => { throw new Error("fixture does not launch"); },
    readOwnedOutput: (_processId, _owner, offsets) => ({ stdout: new Uint8Array(), stderr: new Uint8Array(), next: offsets }),
    reconcileOwned: async () => stoppedJobSnapshot(processId),
    signalOwned: async () => { throw new WindowsJobHostError("process_output_unsettled_terminal", "Windows Job retained output is unsettled."); },
    releaseOwned: async () => stoppedJobSnapshot(processId),
  };
  const backend = new WindowsJobObjectProcessBackend(service);
  assert.deepEqual(parseProcessSignalResult(await backend.signal(jobBinding(processId), "interrupt", fence)), { state: "exited" });
});

test("Windows Job cancellation fails closed without exact empty retained-output proof", async () => {
  const processId = "job-terminal-output-ambiguous";
  const base: WindowsJobProcessService = {
    probeActiveJobCreateClose: async () => true,
    launchOwned: async () => { throw new Error("fixture does not launch"); },
    readOwnedOutput: (_processId, _owner, offsets) => ({ stdout: new Uint8Array(), stderr: new Uint8Array(), next: offsets }),
    reconcileOwned: async () => ({ ...stoppedJobSnapshot(processId), status: "running", exitCode: null, ownershipReleased: false }),
    signalOwned: async () => { throw new WindowsJobHostError("process_control_unavailable", "Job membership remains active or ambiguous."); },
    releaseOwned: async () => stoppedJobSnapshot(processId),
  };
  const backend = new WindowsJobObjectProcessBackend(base);
  await assert.rejects(backend.signal(jobBinding(processId), "interrupt", fence), /active or ambiguous/i);

  const descendantsActive = new WindowsJobObjectProcessBackend({
    ...base,
    signalOwned: async () => ({ ...stoppedJobSnapshot(processId), status: "running", exitCode: null, ownershipReleased: false }),
  });
  assert.deepEqual(parseProcessSignalResult(await descendantsActive.signal(jobBinding(processId), "interrupt", fence)), { state: "running" });
});

test("Windows Job shared activation rejects a different exact birth before service action", async () => {
  let entered!: () => void;
  let resume!: () => void;
  const activationEntered = new Promise<void>((resolve) => { entered = resolve; });
  const activationBarrier = new Promise<void>((resolve) => { resume = resolve; });
  let reconciliations = 0;
  let signalCalls = 0;
  const processId = "job-shared-activation-identity";
  const service: WindowsJobProcessService = {
    probeActiveJobCreateClose: async () => true,
    launchOwned: async () => { throw new Error("fixture does not launch"); },
    readOwnedOutput: (_processId, _context, offsets) => ({ stdout: new Uint8Array(), stderr: new Uint8Array(), next: offsets }),
    reconcileOwned: async () => {
      reconciliations += 1;
      if (reconciliations === 1) { entered(); await activationBarrier; }
      return stoppedJobSnapshot(processId);
    },
    signalOwned: async () => { signalCalls += 1; return stoppedJobSnapshot(processId); },
    releaseOwned: async () => stoppedJobSnapshot(processId),
  };
  const backend = new WindowsJobObjectProcessBackend(service);
  const firstBirth = jobBindingAt(processId, "2026-01-01T00:00:00.000Z");
  const secondBirth = jobBindingAt(processId, "2026-01-02T00:00:00.000Z");

  const firstVerification = backend.verifyEmpty(firstBirth);
  await activationEntered;
  const wrongBirthSignal = backend.signal(secondBirth, "terminate");
  resume();

  assert.equal(parseProcessEmptyVerification(await firstVerification).empty, true);
  await assert.rejects(wrongBirthSignal, /identity mismatch/i);
  assert.equal(signalCalls, 0, "the different birth must be rejected before its service action");
  assert.equal(parseProcessEmptyVerification(await backend.verifyEmpty(firstBirth)).empty, true, "the valid lane must not be poisoned");
});

test("Windows Job release waits for active output delivery and closes later observation", async () => {
  let releaseOutput!: () => void;
  const barrier = new Promise<void>((resolve) => { releaseOutput = resolve; });
  let outputActive = false;
  let reads = 0;
  let released = false;
  const service: WindowsJobProcessService = {
    probeActiveJobCreateClose: async () => true,
    launchOwned: async () => { throw new Error("fixture does not launch"); },
    readOwnedOutput: (_processId, _context, offsets) => ++reads === 1
      ? { stdout: Buffer.from("held output"), stderr: new Uint8Array(), next: { stdout: 11, stderr: offsets.stderr } }
      : { stdout: new Uint8Array(), stderr: new Uint8Array(), next: offsets },
    reconcileOwned: async () => {
      if (released) throw new Error("backend ownership was released");
      return stoppedJobSnapshot("job-release-lane");
    },
    signalOwned: async () => stoppedJobSnapshot("job-release-lane"),
    releaseOwned: async () => { released = true; return stoppedJobSnapshot("job-release-lane"); },
  };
  const backend = new WindowsJobObjectProcessBackend(service);
  const binding = jobBinding("job-release-lane");
  const observation = backend.observe(binding, async () => {
    outputActive = true;
    await barrier;
    outputActive = false;
  }, fence);
  while (!outputActive) await new Promise((resolve) => setImmediate(resolve));

  let releaseSettled = false;
  const firstRelease = backend.release(binding);
  void firstRelease.then(() => { releaseSettled = true; });
  const concurrentRelease = backend.release(binding);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(releaseSettled, false, "release must queue behind active output delivery");
  await assert.rejects(backend.verifyEmpty(binding), /release is pending/i);
  await assert.rejects(backend.signal(binding, "terminate"), /release is pending/i);
  releaseOutput();
  assert.deepEqual(await Promise.all([firstRelease, concurrentRelease]), [{ released: true }, { released: true }]);
  await assert.rejects(observation, /released/i);
  assert.equal((backend as unknown as { offsets: Map<string, unknown> }).offsets.has("job-release-lane"), false);
});

test("Windows Job release drains callback and reconcile errors without retaining offsets", async (t) => {
  for (const mode of ["callback", "reconcile"] as const) {
    await t.test(mode, async () => {
      let entered!: () => void;
      let resume!: () => void;
      const active = new Promise<void>((resolve) => { entered = resolve; });
      const barrier = new Promise<void>((resolve) => { resume = resolve; });
      const processId = `job-release-${mode}-error`;
      let reconciliations = 0;
      const service: WindowsJobProcessService = {
        probeActiveJobCreateClose: async () => true,
        launchOwned: async () => { throw new Error("fixture does not launch"); },
        readOwnedOutput: (_processId, _context, offsets) => ({
          stdout: Buffer.from("fault output"), stderr: new Uint8Array(), next: { stdout: 12, stderr: offsets.stderr },
        }),
        reconcileOwned: async () => {
          reconciliations += 1;
          if (mode === "reconcile" && reconciliations > 1) { entered(); await barrier; throw new Error("injected reconcile failure"); }
          return stoppedJobSnapshot(processId);
        },
        signalOwned: async () => stoppedJobSnapshot(processId),
        releaseOwned: async () => stoppedJobSnapshot(processId),
      };
      const backend = new WindowsJobObjectProcessBackend(service);
      const observation = backend.observe(jobBinding(processId), async () => {
        if (mode === "callback") { entered(); await barrier; throw new Error("injected callback failure"); }
      }, fence);
      await active;
      const releasing = backend.release(jobBinding(processId));
      resume();
      await assert.rejects(observation, new RegExp(`injected ${mode} failure`));
      assert.deepEqual(await releasing, { released: true });
      assert.equal((backend as unknown as { offsets: Map<string, unknown> }).offsets.has(processId), false);
    });
  }
});

test("Windows Job control lane advances after an operation error and still releases", async () => {
  let fail = true;
  let signalCalls = 0;
  let releaseCalls = 0;
  const service: WindowsJobProcessService = {
    probeActiveJobCreateClose: async () => true,
    launchOwned: async () => { throw new Error("fixture does not launch"); },
    readOwnedOutput: (_processId, _context, offsets) => ({ stdout: new Uint8Array(), stderr: new Uint8Array(), next: offsets }),
    reconcileOwned: async () => {
      if (fail) { fail = false; throw new Error("injected ownership failure"); }
      return stoppedJobSnapshot("job-release-error");
    },
    signalOwned: async () => { signalCalls += 1; return stoppedJobSnapshot("job-release-error"); },
    releaseOwned: async () => {
      releaseCalls += 1;
      if (releaseCalls === 1) throw new Error("injected durable release failure");
      return stoppedJobSnapshot("job-release-error");
    },
  };
  const backend = new WindowsJobObjectProcessBackend(service);
  const binding = jobBinding("job-release-error");
  await assert.rejects(backend.observe(binding, async () => undefined, fence), /injected ownership failure/);
  assert.equal(parseProcessSignalResult(await backend.signal(binding, "terminate")).state, "exited");
  assert.equal(signalCalls, 1);
  await assert.rejects(backend.release(binding), /injected durable release failure/);
  await assert.rejects(backend.verifyEmpty(binding), /release is pending/i);
  assert.deepEqual(await backend.release(binding), { released: true });
  assert.equal(releaseCalls, 2);
});

test("Windows Job durable release authority rejects stale identities beyond prior cache capacity", async () => {
  const released = new Map<string, string>();
  let releasedReattestations = 0;
  const service: WindowsJobProcessService = {
    probeActiveJobCreateClose: async () => true,
    launchOwned: async () => { throw new Error("fixture does not launch"); },
    signalOwned: async () => { throw new Error("released identity reached signal"); },
    readOwnedOutput: () => { throw new Error("released identity reached output"); },
    reconcileOwned: async (processId, _context) => {
      if (released.has(processId)) {
        releasedReattestations += 1;
        throw new Error("durable backend ownership was released");
      }
      return stoppedJobSnapshot(processId);
    },
    releaseOwned: async (processId, _context, expectedStartedAt) => {
      assert.equal(expectedStartedAt, "2026-01-01T00:00:00.000Z");
      released.set(processId, expectedStartedAt);
      return stoppedJobSnapshot(processId);
    },
  };
  const backend = new WindowsJobObjectProcessBackend(service);
  const first = jobBinding("job-release-churn-0");
  for (let index = 0; index < 4_097; index += 1) {
    await backend.release(jobBinding(`job-release-churn-${index}`));
  }

  await assert.rejects(backend.verifyEmpty({ ...first }), /released/i);
  assert.equal(releasedReattestations, 1, "stale clone must fail during exact durable re-attestation");
  assert.equal((backend as unknown as { controls: Map<string, unknown> }).controls.size, 0);
});

test("Windows Job durable release rejects a stale clone after adapter restart and startedAt mismatch", async () => {
  const released = new Map<string, string>();
  const service: WindowsJobProcessService = {
    probeActiveJobCreateClose: async () => true,
    launchOwned: async () => { throw new Error("fixture does not launch"); },
    signalOwned: async () => { throw new Error("fixture does not signal"); },
    readOwnedOutput: () => { throw new Error("fixture does not read"); },
    reconcileOwned: async (processId) => {
      if (released.has(processId)) throw new Error("durable backend ownership was released");
      return stoppedJobSnapshot(processId);
    },
    releaseOwned: async (processId, _context, expectedStartedAt) => {
      if (expectedStartedAt !== "2026-01-01T00:00:00.000Z") throw new Error("exact startedAt mismatch");
      released.set(processId, expectedStartedAt);
      return stoppedJobSnapshot(processId);
    },
  };
  const binding = jobBinding("job-release-restart");
  const first = new WindowsJobObjectProcessBackend(service);
  assert.deepEqual(await Promise.all([first.release(binding), first.release({ ...binding })]), [{ released: true }, { released: true }]);

  const restarted = new WindowsJobObjectProcessBackend(service);
  await assert.rejects(restarted.verifyEmpty({ ...binding }), /released/i);
  const wrongStartedAt = jobBindingAt("job-release-restart", "2026-01-02T00:00:00.000Z");
  await assert.rejects(restarted.release(wrongStartedAt), /startedAt mismatch/i);
});

test("Windows Job backend restart activates an existing binding with the claimed takeover fence", async () => {
  const higher = { ownerId: "restart-owner", fencingToken: 7 } as const;
  let current: ProcessEffectFence = { ...fence };
  const reconciledFences: Array<ProcessEffectFence | undefined> = [];
  const service: WindowsJobProcessService = {
    probeActiveJobCreateClose: async () => true,
    launchOwned: async () => { throw new Error("restart fixture does not launch"); },
    claimOwnedFence: async (_processId, _owner, candidate) => { current = { ...candidate }; },
    signalOwned: async (processId) => stoppedJobSnapshot(processId),
    reconcileOwned: async (processId, _owner, candidate) => {
      reconciledFences.push(candidate);
      if (!candidate || candidate.ownerId !== current.ownerId || candidate.fencingToken !== current.fencingToken)
        throw new Error("restart activation omitted the current durable fence");
      return { ...stoppedJobSnapshot(processId), status: "running" as const, exitCode: null, ownershipReleased: false };
    },
    releaseOwned: async (processId) => stoppedJobSnapshot(processId),
    readOwnedOutput: (_processId, _owner, offsets) => ({ stdout: new Uint8Array(), stderr: new Uint8Array(), next: offsets }),
  };
  const restarted = new WindowsJobObjectProcessBackend(service);
  assert.deepEqual(await restarted.reconcile(jobBinding("job-restart-activation"), higher), { state: "running" });
  assert.deepEqual(reconciledFences, [higher, higher]);
});

test("Windows Job host signal returns the post-effect stopped snapshot", { timeout: 30_000 }, async (t) => {
  if (process.platform !== "win32") { t.skip("Windows Job signal snapshot fixture requires Windows."); return; }
  const root = mkdtempSync(join(tmpdir(), "aiboard-windows-job-signal-snapshot-"));
  const workspace = join(root, "workspace"); mkdirSync(workspace);
  const host = createWindowsJobProcessHost({ stateDirectory: join(root, "state") });
  const backend = new WindowsJobObjectProcessBackend(host);
  const live = request(["-e", "setInterval(()=>{},1000)"]);
  const launch = parseProcessLaunchResult(await backend.launch({ ...live, intent: { ...live.intent, invocationId: "job-signal-snapshot", workingDirectory: workspace }, grant: { ...live.grant, invocationId: "job-signal-snapshot" } }));
  const binding = { ...bindingFor(launch), backendId: "runner-windows-job-v1" };
  const identity = JSON.parse(Buffer.from(launch.opaqueIdentity, "base64url").toString("utf8")) as { processId: string; runId: string; sessionId: string };
  try {
    const snapshot = await host.signalOwned(identity.processId, "SIGKILL", { runId: identity.runId, sessionId: identity.sessionId }, fence);
    assert.equal(snapshot.status, "stopped");
  } finally {
    await backend.signal(binding, "force_terminate", fence).catch(() => undefined);
    await backend.release(binding, fence).catch(() => undefined);
    rmSync(root, { recursive: true, force: true, maxRetries: 30, retryDelay: 50 });
  }
});

const fence = { ownerId: "test-owner", fencingToken: 1 } as const;
function request(args: string[]) {
  return {
    intent: {
      invocationId: "windows-native",
      runId: "run",
      kind: "command" as const,
      executable: process.execPath,
      arguments: args,
      workingDirectory: process.cwd(),
      requestedCapabilities: ["tree_termination", "verified_emptiness"] as const,
    },
    grant: {
      grantId: "grant",
      runId: "run",
      invocationId: "windows-native",
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
    backendId: "runner-windows-supervisor-v1",
    implementationGeneration: "generation",
    implementationDigest: "1".repeat(64),
    attestationVersion: 1,
    attestationDigest: "2".repeat(64),
    ...launch,
  };
}

function portableWindowsBinding(directory: string, birth: string) {
  const identity = portableIdentity(directory, birth);
  return bindingFor({
    opaqueIdentity: Buffer.from(JSON.stringify(identity)).toString("base64url"),
    birthFingerprint: {
      observedAt: "2026-01-01T00:00:00.000Z",
      discriminator: createHash("sha256").update(`windows-contract-nonce\0${birth}`).digest("hex"),
    },
    rootPid: 9001,
    startedAt: "2026-01-01T00:00:00.000Z",
  });
}

function portableIdentity(directory: string, birth: string) {
  return {
    version: 1,
    backendId: "runner-windows-supervisor-v1",
    nonce: "windows-contract-nonce",
    directory,
    supervisorPid: 9001,
    supervisorBirth: birth,
  } as const;
}

async function waitForPortableState(
  directory: string,
  predicate: (state: {
    status: string;
    launchEffect?: string;
    rootProcess?: { pid: number; birth: string } | null;
    knownProcesses: Array<{ pid: number; birth: string }>;
    handledControl: number;
    windowsTreeRefreshCount?: number;
    windowsTreeFailures?: number;
    windowsTreeInspectionDeadlineMs?: number;
    windowsBirthInspectionAttempts?: number;
    windowsBirthInspectionDeadlineMs?: number;
    error?: string | null;
  }) => boolean,
  timeoutMs = 15_000,
) {
  const path = join(directory, "state.json");
  let latest: unknown;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const state = JSON.parse(readFileSync(path, "utf8"));
      latest = state;
      if (predicate(state)) return state;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Portable supervisor state did not settle at ${path}: ${JSON.stringify(latest)}.`);
}

async function waitForCondition(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("condition did not become true");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function processIsAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch { return false; }
}

function writePortableState(
  directory: string,
  overrides: {
    childPid?: number;
    launchEffect?: "not_started" | "started" | "unknown";
    rootProcess?: { pid: number; birth: string } | null;
    knownProcesses: Array<{ pid: number; birth: string }>;
  },
) {
  writeFileSync(join(directory, "state.json"), JSON.stringify({
    protocol: "aiboard-portable-process/v1",
    nonce: "windows-contract-nonce",
    supervisorPid: 9001,
    revision: 1,
    handledControl: 0,
    status: "running",
    exitCode: null,
    signal: null,
    error: null,
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  }));
}

function jobBinding(processId: string) {
  return jobBindingAt(processId, "2026-01-01T00:00:00.000Z");
}

async function cleanupWindowsProcessFixture(
  backend: ProcessBackend,
  binding: ProcessBackendBinding,
  cleanupFence: ProcessEffectFence,
): Promise<void> {
  const deadline = Date.now() + 15_000;
  let last = "cleanup not attempted";
  while (Date.now() < deadline) {
    try { await backend.signal(binding, "force_terminate", cleanupFence); } catch (error) { last = String(error); }
    const observation = parseProcessReconciliation(await backend.reconcile(binding, cleanupFence));
    last = observation.state;
    if (observation.state === "identity_mismatch") throw new Error("Windows fixture cleanup lost exact ownership.");
    if (observation.state === "exited") {
      try { await backend.release(binding, cleanupFence); return; }
      catch (error) { last = String(error); }
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Windows fixture cleanup did not reach durable terminal state: ${last}`);
}

function jobBindingAt(processId: string, startedAt: string) {
  const identity = { processId, runId: "run", sessionId: "session", startedAt };
  return {
    ...bindingFor({
      opaqueIdentity: Buffer.from(JSON.stringify(identity)).toString("base64url"),
      birthFingerprint: {
        observedAt: startedAt,
        discriminator: createHash("sha256").update(`${processId}\0${startedAt}`).digest("hex"),
      },
      rootPid: 9001,
      startedAt,
    }),
    backendId: "runner-windows-job-v1",
  };
}

function stoppedJobSnapshot(processId: string) {
  return {
    processId,
    pid: 9001,
    status: "stopped" as const,
    exitCode: 0,
    signal: null,
    startedAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    stdout: "",
    stderr: "",
    ownershipReleased: true,
  };
}
