// PX-2b — fewer/cheaper fence effects and event-driven settlement.
//
// Covers each PX-2b product change on the REAL host (or, for the pure waits,
// against stub servers and the real filesystem):
// - A2: the fused claim+attach effect rejects stale writers before any
//   attachment observation, with exactly the claim predicates first.
// - E1: the fused claim+attach upgrade is durable — a new host instance on
//   the same state dir honors the new fence and rejects the old (the only
//   new write-transaction boundary; the terminal fusion is read-only).
// - B1/B2: a real call still settles through the single attested terminal
//   read (backend-level and production-path), with birth, stopped state and
//   ownership release all enforced.
// - C1: release still refuses a live tree (remaining pre-check) and succeeds
//   once empty (in-fence check) after the second pre-read was removed.
// - D1/D2: the file-activity and supervisor-startup waits resolve on events,
//   immediately when already terminal (lost wakeup), and by deadline.
// - D3: the authenticated long-poll helper returns terminal immediately,
//   wakes on change, and throws when the deadline fires.
// - D4: the live supervisor authenticates /wait-status with Bearer.
// Every fault below is restored byte-exact (sha256 before == after).
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, type TestContext } from "node:test";
import { Worker } from "node:worker_threads";

import { ArtifactStore } from "../src/artifact-store.js";
import { createExecutionHost, type ExecutionHost, type ExecutionHostRunBinding } from "../src/execution-host.js";
import {
  parseProcessEmptyVerification,
  parseProcessLaunchResult,
  parseProcessReconciliation,
  type ProcessBackendBinding,
  type ProcessEffectFence,
  type ProcessLaunchResult,
} from "../src/process-backend.js";
import { emptyRunnerCapabilitiesConfig } from "../src/runner-capabilities-config.js";
import type { RunnerCapabilityContract } from "../src/runner-capability-contract.js";
import {
  createWindowsJobProcessHost,
  waitForFileActivity,
  waitForSupervisor,
  waitForSupervisorStatusChange,
  type WindowsJobOwnershipKey,
  type WindowsJobWriterFence,
} from "../src/windows-job-process-host.js";
import {
  createWindowsJobProcessChannelProvider,
  type WindowsJobChannelAuthority,
} from "../src/windows-job-process-channel.js";
import { createWindowsProcessBackend, WindowsJobObjectProcessBackend } from "../src/windows-process-backend.js";
import { checkNoWindowsJobProcessesLeft, retireOwnedTreeForTests } from "./support/windows-job-leftover-guard.js";

const WINDOWS_SKIP = "Windows Job fence-effects pin requires a Windows host.";
const BACKEND_SKIP = "Windows Job fence-effects pin requires the runner-windows-job-v1 backend to be selected.";

function needsWindows(t: TestContext): boolean {
  if (process.platform !== "win32") {
    t.skip(WINDOWS_SKIP);
    return false;
  }
  return true;
}

function allowedEnv(): Record<string, string> {
  const keep = new Set(["systemroot", "windir", "comspec", "path", "pathext", "temp", "tmp"]);
  return Object.fromEntries(
    Object.entries(process.env).filter(([key, value]) => value !== undefined && keep.has(key.toLowerCase())),
  ) as Record<string, string>;
}

const OWNER: WindowsJobOwnershipKey = { runId: "px2b-run", sessionId: "px2b-session" };
const FENCE: WindowsJobWriterFence = { ownerId: "px2b-owner", fencingToken: 1 };

function launchArgs(script: string): { executable: string; args: string[] } {
  return { executable: process.execPath, args: ["-e", script] };
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/** Backend-level harness: the real backend over the real Job host. */
function backendHarness(root: string) {
  const service = createWindowsJobProcessHost({
    stateDirectory: join(root, "job-host"),
    startDeadlineMs: 15_000,
    stopDeadlineMs: 15_000,
  });
  const backend = createWindowsProcessBackend({
    jobObjects: { service },
    semanticFacts: {
      portableDuplex: "verified",
      windowsBatchArgv: "verified",
      exactTreeBirth: "partial",
      jobContainment: "verified",
    },
  });
  return { service, backend };
}

function launchRequest(invocationId: string, workspace: string, script: string, fence: ProcessEffectFence) {
  const target = launchArgs(script);
  return {
    intent: {
      invocationId,
      runId: OWNER.runId,
      kind: "command" as const,
      executable: target.executable,
      arguments: target.args,
      workingDirectory: workspace,
      requiredLifecycleScope: "process_group" as const,
      requestedCapabilities: [] as const,
    },
    grant: { grantId: `grant-${invocationId}`, runId: OWNER.runId, invocationId, issuedAt: new Date().toISOString(), access: [] },
    environment: allowedEnv(),
    outputOwnerId: "px2b-output",
    fence,
  };
}

function bindLaunch(launch: ProcessLaunchResult): ProcessBackendBinding {
  return {
    registryId: "registry",
    backendId: "runner-windows-job-v1",
    implementationGeneration: "px2b",
    implementationDigest: "1".repeat(64),
    attestationVersion: 1,
    attestationDigest: "2".repeat(64),
    ...launch,
  } as ProcessBackendBinding;
}

// A2 — the fused claim+attach runs the claim predicates before any
// attachment observation: invalid shape, a valid-shape lower token, and
// same-token foreign owner are all rejected; the current fence attaches.
// (Repair 1: the lower-token case used fencingToken 0, which takes the
// invalid-shape branch; it now upgrades first so "lower" is genuinely stale.)
test("px2b: fused claim+attach rejects stale writers before observing", { timeout: 55_000 }, async (t) => {
  if (!needsWindows(t)) return;
  const root = mkdtempSync(join(tmpdir(), "aiboard-px2b-fused-"));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 30, retryDelay: 50 }));
  const workspace = join(root, "workspace");
  mkdirSync(workspace, { recursive: true });
  const service = createWindowsJobProcessHost({ stateDirectory: join(root, "job-host") });
  const target = launchArgs("process.exit(0)");
  const launched = await service.launchOwned({
    ...OWNER,
    command: target.executable,
    args: target.args,
    workingDirectory: workspace,
    environment: allowedEnv(),
    interactive: true,
    fence: { ...FENCE },
  });
  const current: WindowsJobWriterFence = { ownerId: FENCE.ownerId, fencingToken: FENCE.fencingToken + 1 };
  await service.claimAndAttachOwnedChannel!(launched.processId, OWNER, { ...current });
  try {
    await assert.rejects(
      service.claimAndAttachOwnedChannel!(launched.processId, OWNER, { ownerId: "", fencingToken: 0 }),
      /writer fence is invalid/,
      "malformed fence must be rejected",
    );
    await assert.rejects(
      service.claimAndAttachOwnedChannel!(launched.processId, OWNER, { ...FENCE }),
      /writer fence is stale/,
      "valid-shape lower token must be rejected as stale",
    );
    await assert.rejects(
      service.claimAndAttachOwnedChannel!(launched.processId, OWNER, { ownerId: "foreign", fencingToken: current.fencingToken }),
      /writer fence is stale/,
      "same-token foreign owner must be rejected",
    );
    const state = await service.claimAndAttachOwnedChannel!(launched.processId, OWNER, { ...current });
    assert.equal(state.snapshot.processId, launched.processId, "current fence attaches");
    assert.equal(typeof state.snapshot.ownershipReleased, "boolean", "attach observes ownership");
  } finally {
    try {
      await service.signalOwned(launched.processId, "SIGKILL", OWNER, { ...current });
    } catch {
      // Already terminal.
    }
    try {
      await service.releaseOwned(launched.processId, OWNER, launched.startedAt, { ...current });
    } catch {
      // Best-effort cleanup only.
    }
  }
});

// E1 — the fused upgrade is the only new write boundary: after a fused
// acquire with a higher token, a NEW host instance on the same state dir
// honors the new fence and rejects the old one, then settles and releases.
// (Repair 1: the old-fence check runs through the fused method itself, and
// the release waits for stopped first — releasing straight after the upgrade
// raced the supervisor's exit detection under whole-file load, which was the
// intermittent whole-file failure. The poll count is reported; polls > 1
// proves the window exists.)
test("px2b: fused fence upgrade is durable across host instances", { timeout: 55_000 }, async (t) => {
  if (!needsWindows(t)) return;
  const root = mkdtempSync(join(tmpdir(), "aiboard-px2b-durable-"));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 30, retryDelay: 50 }));
  const workspace = join(root, "workspace");
  mkdirSync(workspace, { recursive: true });
  const stateDirectory = join(root, "job-host");
  const first = createWindowsJobProcessHost({ stateDirectory });
  const target = launchArgs("process.exit(0)");
  const launched = await first.launchOwned({
    ...OWNER,
    command: target.executable,
    args: target.args,
    workingDirectory: workspace,
    environment: allowedEnv(),
    interactive: true,
    fence: { ...FENCE },
  });
  const upgraded: WindowsJobWriterFence = { ownerId: FENCE.ownerId, fencingToken: FENCE.fencingToken + 1 };
  await first.claimAndAttachOwnedChannel!(launched.processId, OWNER, upgraded);
  const second = createWindowsJobProcessHost({ stateDirectory });
  try {
    await assert.rejects(
      second.claimAndAttachOwnedChannel!(launched.processId, OWNER, { ...FENCE }),
      /stale/,
      "old fence must stay rejected by the fused method after the upgrade",
    );
    const snapshot = await second.reconcileOwned(launched.processId, OWNER, upgraded);
    assert.equal(snapshot.processId, launched.processId, "new fence reconciles on the new instance");
    let polls = 0;
    for (;;) {
      const current = await second.reconcileOwned(launched.processId, OWNER, upgraded);
      polls += 1;
      if (current.status === "stopped" && current.ownershipReleased) break;
      if (polls > 200) throw new Error("upgraded call did not reach stopped before the test bound");
      await sleep(100);
    }
    t.diagnostic(`e1 stopped-settle polls: ${polls}`);
    const released = await second.releaseOwned(launched.processId, OWNER, launched.startedAt, upgraded);
    assert.equal(released.ownershipReleased, true, "upgraded fence releases once empty");
  } finally {
    try {
      await second.signalOwned(launched.processId, "SIGKILL", OWNER, upgraded);
    } catch {
      // Already terminal.
    }
    try {
      await second.releaseOwned(launched.processId, OWNER, launched.startedAt, upgraded);
    } catch {
      // Best-effort cleanup only.
    }
  }
});

// B1 — a real call settles through the single attested terminal read:
// birth, stopped state and ownership release are enforced on one
// fence-attested snapshot (backend-level, byte-exact stdout).
test("px2b: real call settles through the fused terminal proof", { timeout: 55_000 }, async (t) => {
  if (!needsWindows(t)) return;
  const root = mkdtempSync(join(tmpdir(), "aiboard-px2b-terminal-"));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 30, retryDelay: 50 }));
  const workspace = join(root, "workspace");
  mkdirSync(workspace, { recursive: true });
  const { backend } = backendHarness(root);
  const fence: ProcessEffectFence = { ownerId: "px2b-terminal", fencingToken: 1 };
  const launch = parseProcessLaunchResult(await backend.launch(launchRequest("px2b-terminal", workspace, "console.log('px2b-fused-ok')", fence)));
  const binding = bindLaunch(launch);
  try {
    const chunks: Uint8Array[] = [];
    const observed = (await backend.observe(binding, async (_stream, bytes) => {
      chunks.push(new Uint8Array(bytes));
    }, fence)) as { state: string; exitCode?: number };
    assert.equal(observed.state, "exited", "fused terminal proof must report exited");
    assert.equal(observed.exitCode, 0, "quick call must exit 0");
    const stdout = Buffer.concat(chunks).toString("utf8");
    assert.equal(stdout, "px2b-fused-ok\n", "output attribution stays byte-exact");
    assert.equal(parseProcessEmptyVerification(await backend.verifyEmpty(binding, fence)).empty, true);
    assert.deepEqual(await backend.release(binding, fence), { released: true });
  } finally {
    try {
      await backend.signal(binding, "force_terminate", fence);
    } catch {
      // Already terminal.
    }
    try {
      if (parseProcessReconciliation(await backend.reconcile(binding, fence)).state === "exited") {
        try {
          await backend.verifyEmpty(binding, fence);
        } catch {
          // Best-effort.
        }
        await backend.release(binding, fence).catch(() => undefined);
      }
    } catch {
      // Best-effort cleanup only.
    }
  }
});

// C1 — release still refuses a live tree at the remaining pre-check and
// succeeds once empty through the in-fence check (the removed re-read
// observed no intervening host action). The refused lane stays closed by
// design, so the kill and settle run through a fresh backend instance.
test("px2b: release refuses a live tree and succeeds once empty", { timeout: 55_000 }, async (t) => {
  if (!needsWindows(t)) return;
  const root = mkdtempSync(join(tmpdir(), "aiboard-px2b-release-"));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 30, retryDelay: 50 }));
  const workspace = join(root, "workspace");
  mkdirSync(workspace, { recursive: true });
  const { service, backend } = backendHarness(root);
  const fence: ProcessEffectFence = { ownerId: "px2b-release", fencingToken: 1 };
  const launch = parseProcessLaunchResult(
    await backend.launch(launchRequest("px2b-release", workspace, "setTimeout(() => process.exit(0), 90000)", fence)),
  );
  const binding = bindLaunch(launch);
  await assert.rejects(backend.release(binding, fence), /not verified terminal/, "live tree release must be refused");
  const fresh = createWindowsProcessBackend({
    jobObjects: { service },
    semanticFacts: {
      portableDuplex: "verified",
      windowsBatchArgv: "verified",
      exactTreeBirth: "partial",
      jobContainment: "verified",
    },
  });
  try {
    await fresh.signal(binding, "force_terminate", fence);
    const observed = (await fresh.observe(binding, async () => undefined, fence)) as { state: string };
    assert.equal(observed.state, "exited", "killed tree must observe exited");
    assert.equal(parseProcessEmptyVerification(await fresh.verifyEmpty(binding, fence)).empty, true);
    assert.deepEqual(await fresh.release(binding, fence), { released: true }, "empty tree must release");
  } finally {
    try {
      await fresh.signal(binding, "force_terminate", fence);
    } catch {
      // Already terminal.
    }
    try {
      await fresh.release(binding, fence).catch(() => undefined);
    } catch {
      // Best-effort cleanup only.
    }
  }
});

// B2 — the production path settles end to end through the fused terminal
// proof and the event-driven waits: exited, exit 0, verified_empty, with
// byte-exact stdout.
interface Px2bProd {
  readonly host: ExecutionHost;
  readonly binding: ExecutionHostRunBinding;
  readonly root: string;
  readonly project: string;
  readonly jobHostDir: string;
  readonly runId: string;
}

let prod: Px2bProd | undefined;

async function ensureProd(): Promise<Px2bProd | undefined> {
  if (process.platform !== "win32") return undefined;
  if (prod) return prod;
  const root = mkdtempSync(join(tmpdir(), "aiboard-px2b-prod-"));
  const project = join(root, "project");
  mkdirSync(project, { recursive: true });
  execFileSync("git", ["init", "-q", project]);
  execFileSync("git", ["-C", project, "config", "user.email", "px2b@example.test"]);
  execFileSync("git", ["-C", project, "config", "user.name", "px2b"]);
  writeFileSync(join(project, "f.txt"), "px2b\n");
  execFileSync("git", ["-C", project, "add", "."]);
  execFileSync("git", ["-C", project, "commit", "-qm", "px2b"]);
  const stateDir = join(root, "state");
  mkdirSync(stateDir, { recursive: true });
  const host = createExecutionHost({
    projectRoot: project,
    stateDirectory: stateDir,
    artifacts: new ArtifactStore(join(stateDir, "artifacts")),
    ambientEnvironment: { ...process.env },
  });
  const runId = `px2b-prod-${Date.now()}`;
  const binding = await host.bindRun({
    runId,
    permissionProfile: "full",
    capabilityContract: { digest: "c".repeat(64) } as RunnerCapabilityContract,
    capabilitiesConfig: emptyRunnerCapabilitiesConfig(),
  });
  const jobHostDir = join(stateDir, "managed-processes-job-host");
  await binding.git.lifecycle("integration").run({ cwd: project, args: ["rev-parse", "HEAD"] });
  let selected = false;
  try {
    selected = readdirSync(jobHostDir).filter((entry: string) => entry.endsWith(".json")).length > 0;
  } catch {
    selected = false;
  }
  if (!selected) {
    await binding.close().catch(() => undefined);
    await host.close().catch(() => undefined);
    rmSync(root, { recursive: true, force: true });
    return undefined;
  }
  prod = { host, binding, root, project, jobHostDir, runId };
  return prod;
}

after(async () => {
  if (!prod) return;
  const h = prod;
  prod = undefined;
  await h.binding.close().catch(() => undefined);
  await h.host.close().catch(() => undefined);
  rmSync(h.root, { recursive: true, force: true });
});

test("px2b: production call settles end to end", { timeout: 55_000 }, async (t) => {
  if (!needsWindows(t)) return;
  const h = await ensureProd();
  if (!h) {
    t.skip(BACKEND_SKIP);
    return;
  }
  const script = "console.log('px2b-prod-ok');";
  const result = await h.binding.commandExecution.execute({
    executable: process.execPath,
    arguments: ["-e", script],
    workingDirectory: h.project,
    timeoutMs: 30_000,
    captureOutputBytes: 1024 * 1024,
    context: {
      runId: h.runId,
      sessionId: `session-${h.runId}`,
      actor: { role: "worker" as const, id: "worker-px2b" },
      callId: `px2b-prod-${Date.now()}`,
      toolName: "process.run",
      runnerInternal: true as const,
    },
  });
  const proc = (result as { process?: { outcome?: unknown; exitCode?: unknown; cleanup?: { state?: unknown } } }).process;
  assert.equal(proc?.outcome, "exited", "production call must exit");
  assert.equal(proc?.exitCode, 0, "production call must exit 0");
  assert.equal(proc?.cleanup?.state, "verified_empty", "production call must verify empty");
  const captured = (result as { capturedOutput?: { stdout?: Uint8Array } }).capturedOutput;
  const stdout = captured?.stdout ? Buffer.from(captured.stdout).toString("utf8") : "";
  assert.equal(stdout, "px2b-prod-ok\n", "production stdout stays byte-exact");
});

// D1a — the file-activity wait resolves on the change event, not the timer.
test("px2b: file-activity wait resolves on change", { timeout: 15_000 }, async (t) => {
  if (!needsWindows(t)) return;
  const dir = mkdtempSync(join(tmpdir(), "aiboard-px2b-watch-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const name = "supervisor.jsonl";
  setTimeout(() => appendFileSync(join(dir, name), "{}\n"), 150).unref?.();
  const start = Date.now();
  await waitForFileActivity(dir, name, 5_000);
  const elapsed = Date.now() - start;
  assert.ok(elapsed < 2_000, `event wait must resolve on change, took ${elapsed}ms`);
});

// D1b — the file-activity wait resolves via its bounded timer when quiet
// and never rejects (the caller owns the deadline).
test("px2b: file-activity wait resolves via timer when quiet", { timeout: 15_000 }, async (t) => {
  if (!needsWindows(t)) return;
  const dir = mkdtempSync(join(tmpdir(), "aiboard-px2b-quiet-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const start = Date.now();
  await waitForFileActivity(dir, "never.jsonl", 200);
  const elapsed = Date.now() - start;
  assert.ok(elapsed >= 100, `timer backstop must bound the wait, took ${elapsed}ms`);
  assert.ok(elapsed < 3_000, `timer backstop must not hang, took ${elapsed}ms`);
});

const SUPERVISOR_PROTOCOL = "aiboard-managed-process/v1" as const;

function supervisorLine(overrides: Record<string, unknown>): string {
  return `${JSON.stringify({
    protocol: SUPERVISOR_PROTOCOL,
    processId: "px2b-wait",
    supervisorPid: 4242,
    childPid: 0,
    port: 0,
    status: "starting",
    exitCode: null,
    signal: null,
    error: null,
    ownershipReleased: false,
    updatedAt: new Date().toISOString(),
    ...overrides,
  })}\n`;
}

// D2a — the startup wait resolves when terminal status lands (event-driven).
test("px2b: supervisor-startup wait resolves on terminal persist", { timeout: 15_000 }, async (t) => {
  if (!needsWindows(t)) return;
  const dir = mkdtempSync(join(tmpdir(), "aiboard-px2b-sup-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const statusPath = join(dir, "supervisor.jsonl");
  appendFileSync(statusPath, supervisorLine({ port: 0 }));
  setTimeout(() => appendFileSync(statusPath, supervisorLine({ port: 9, status: "stopped", ownershipReleased: true })), 150).unref?.();
  const start = Date.now();
  const status = await waitForSupervisor(
    { protocol: SUPERVISOR_PROTOCOL, token: "t".repeat(32), statusPath, supervisorPid: 4242, port: 0 },
    "px2b-wait",
    10_000,
  );
  assert.equal(status.status, "stopped", "startup wait must return the terminal status");
  assert.ok(Date.now() - start < 3_000, "startup wait must be event-driven, not deadline-driven");
});

// D2b — the startup wait still rejects at the armed start deadline.
test("px2b: supervisor-startup wait rejects at its deadline", { timeout: 15_000 }, async (t) => {
  if (!needsWindows(t)) return;
  const dir = mkdtempSync(join(tmpdir(), "aiboard-px2b-supdead-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const statusPath = join(dir, "supervisor.jsonl");
  const start = Date.now();
  await assert.rejects(
    waitForSupervisor(
      { protocol: SUPERVISOR_PROTOCOL, token: "t".repeat(32), statusPath, supervisorPid: 4242, port: 0 },
      "px2b-wait",
      300,
    ),
    /did not become ready/,
    "missing supervisor must reject at the deadline",
  );
  assert.ok(Date.now() - start < 5_000, "deadline rejection must stay bounded");
});

// D2c — lost wakeup: terminal status already present resolves immediately.
test("px2b: supervisor-startup wait never misses landed status", { timeout: 15_000 }, async (t) => {
  if (!needsWindows(t)) return;
  const dir = mkdtempSync(join(tmpdir(), "aiboard-px2b-suplanded-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const statusPath = join(dir, "supervisor.jsonl");
  appendFileSync(statusPath, supervisorLine({ port: 9, status: "stopped", ownershipReleased: true }));
  const start = Date.now();
  const status = await waitForSupervisor(
    { protocol: SUPERVISOR_PROTOCOL, token: "t".repeat(32), statusPath, supervisorPid: 4242, port: 0 },
    "px2b-wait",
    10_000,
  );
  assert.equal(status.status, "stopped", "landed terminal status must resolve");
  assert.ok(Date.now() - start < 2_000, "landed status must not wait out the deadline");
});

// D3 — the authenticated long-poll helper against a stub supervisor.
async function withStatusStub(
  t: TestContext,
  handler: (url: string, auth: string | undefined) => { code: number; body: unknown; delayMs?: number },
  work: (port: number) => Promise<void>,
): Promise<void> {
  const server = createServer((request, response) => {
    const outcome = handler(request.url ?? "", request.headers.authorization);
    const send = (): void => {
      response.writeHead(outcome.code, { "content-type": "application/json" });
      response.end(JSON.stringify(outcome.body));
    };
    if (outcome.delayMs) setTimeout(send, outcome.delayMs).unref?.();
    else send();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address !== "string", "stub must bind TCP");
  await work(address.port);
}

function stubSupervisor(port: number) {
  return {
    protocol: SUPERVISOR_PROTOCOL,
    token: "s".repeat(32),
    statusPath: join(tmpdir(), "px2b-stub.jsonl"),
    supervisorPid: 4242,
    port,
  };
}

test("px2b: status-change wait returns landed terminal immediately", { timeout: 15_000 }, async (t) => {
  if (!needsWindows(t)) return;
  await withStatusStub(
    t,
    (url, auth) => {
      if (auth !== `Bearer ${"s".repeat(32)}`) return { code: 401, body: { error: "unauthorized" } };
      if (!url.startsWith("/wait-status")) return { code: 404, body: { error: "not_found" } };
      return { code: 200, body: { status: "stopped", ownershipReleased: true, processId: "px2b-wait" } };
    },
    async (port) => {
      const start = Date.now();
      const status = (await waitForSupervisorStatusChange(stubSupervisor(port), 2_000)) as { status: string };
      assert.equal(status.status, "stopped", "landed terminal status must return");
      assert.ok(Date.now() - start < 1_000, "landed terminal must not wait out the timeout");
      await assert.rejects(
        waitForSupervisorStatusChange({ ...stubSupervisor(port), token: "wrong-token-12345678901234567890" }, 500),
        /401/,
        "wrong Bearer must be rejected",
      );
    },
  );
});

test("px2b: status-change wait wakes on change before its timeout", { timeout: 15_000 }, async (t) => {
  if (!needsWindows(t)) return;
  await withStatusStub(
    t,
    (url, auth) => {
      if (auth !== `Bearer ${"s".repeat(32)}`) return { code: 401, body: { error: "unauthorized" } };
      if (!url.startsWith("/wait-status")) return { code: 404, body: { error: "not_found" } };
      return { code: 200, body: { status: "running", ownershipReleased: false }, delayMs: 300 };
    },
    async (port) => {
      const start = Date.now();
      const status = (await waitForSupervisorStatusChange(stubSupervisor(port), 2_000)) as { status: string };
      assert.equal(status.status, "running", "woken change must return");
      const elapsed = Date.now() - start;
      assert.ok(elapsed >= 200 && elapsed < 1_500, `wakeup must beat the timeout, took ${elapsed}ms`);
    },
  );
});

test("px2b: status-change wait throws when its deadline fires", { timeout: 15_000 }, async (t) => {
  if (!needsWindows(t)) return;
  await withStatusStub(
    t,
    (url, auth) => {
      if (auth !== `Bearer ${"s".repeat(32)}`) return { code: 401, body: { error: "unauthorized" } };
      if (!url.startsWith("/wait-status")) return { code: 404, body: { error: "not_found" } };
      return { code: 200, body: { status: "running" }, delayMs: 30_000 };
    },
    async (port) => {
      const start = Date.now();
      await assert.rejects(
        waitForSupervisorStatusChange(stubSupervisor(port), 300),
        /timed out/,
        "hung supervisor must trip the client deadline",
      );
      assert.ok(Date.now() - start < 5_000, "client deadline must stay bounded");
    },
  );
});

// D4 — the live supervisor authenticates /wait-status with Bearer.
test("px2b: live supervisor authenticates the status-change wait", { timeout: 55_000 }, async (t) => {
  if (!needsWindows(t)) return;
  const root = mkdtempSync(join(tmpdir(), "aiboard-px2b-auth-"));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 30, retryDelay: 50 }));
  const workspace = join(root, "workspace");
  mkdirSync(workspace, { recursive: true });
  const service = createWindowsJobProcessHost({ stateDirectory: join(root, "job-host") });
  const fence: WindowsJobWriterFence = { ownerId: "px2b-auth", fencingToken: 1 };
  const owner: WindowsJobOwnershipKey = { runId: "px2b-auth", sessionId: "px2b-auth" };
  const target = launchArgs("setTimeout(() => process.exit(0), 30000)");
  const launched = await service.launchOwned({
    ...owner,
    command: target.executable,
    args: target.args,
    workingDirectory: workspace,
    environment: allowedEnv(),
    interactive: true,
    fence: { ...fence },
  });
  try {
    const record = JSON.parse(readFileSync(join(root, "job-host", `${launched.processId}.json`), "utf8")) as {
      supervisor: { token: string; port: number };
    };
    const base = `http://127.0.0.1:${record.supervisor.port}/wait-status?timeoutMs=500`;
    const denied = await fetch(base, { headers: { authorization: "Bearer wrong-token-12345678901234567890" } });
    assert.equal(denied.status, 401, "live supervisor must reject a forged Bearer");
    await denied.arrayBuffer().catch(() => undefined);
    const allowed = await fetch(base, { headers: { authorization: `Bearer ${record.supervisor.token}` } });
    assert.equal(allowed.status, 200, "live supervisor must answer its Bearer");
    const body = (await allowed.json()) as { processId?: unknown; status?: unknown };
    assert.equal(body.processId, launched.processId, "wait response carries the process identity");
    assert.equal(typeof body.status, "string", "wait response carries status");
  } finally {
    try {
      await service.signalOwned(launched.processId, "SIGKILL", owner, { ...fence });
    } catch {
      // Already terminal.
    }
    try {
      await service.releaseOwned(launched.processId, owner, launched.startedAt, { ...fence });
    } catch {
      // Best-effort cleanup only.
    }
  }
});

// Repair cycle 1 (B1): the startup wait arms the watch before the read and
// parks a short tick, so a status line landing between read and registration
// cannot stall to the whole deadline. Offset sweep adapted from the review
// probe: a writer thread appends the terminal line 0-1200 us after the wait
// starts; every trial must return fast (pre-fix: 24 of 242 stalled to the
// 800 ms deadline).
test("px2b: supervisor-startup wait keeps no lost wakeup under a write sweep", { timeout: 55_000 }, async (t) => {
  if (!needsWindows(t)) return;
  const root = mkdtempSync(join(tmpdir(), "aiboard-px2b-sweep-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const statusPath = join(root, "supervisor.jsonl");
  const starting = supervisorLine({ port: 0 });
  const stopped = supervisorLine({ port: 9, status: "stopped", ownershipReleased: true });
  const sab = new SharedArrayBuffer(16);
  const flags = new Int32Array(sab);
  const worker = new Worker(`
const { workerData } = require("node:worker_threads");
const fs = require("node:fs");
const flags = new Int32Array(workerData.sab);
for (;;) {
  while (Atomics.load(flags, 0) === 0) { if (Atomics.load(flags, 3)) process.exit(0); }
  const us = Atomics.load(flags, 1);
  Atomics.store(flags, 0, 0);
  const t0 = process.hrtime.bigint();
  while (Number(process.hrtime.bigint() - t0) / 1000 < us) {}
  fs.appendFileSync(workerData.path, workerData.line);
  Atomics.store(flags, 2, 1);
}
`, { eval: true, workerData: { sab, path: statusPath, line: stopped } });
  t.after(() => worker.terminate());
  await sleep(300);
  const rec = { protocol: SUPERVISOR_PROTOCOL, token: "t".repeat(32), statusPath, supervisorPid: 4242, port: 0 };
  const stalls: number[] = [];
  let trials = 0;
  for (let pass = 0; pass < 2; pass++) {
    for (let us = 0; us <= 1200; us += 50) {
      writeFileSync(statusPath, starting);
      Atomics.store(flags, 1, us); Atomics.store(flags, 2, 0); Atomics.store(flags, 0, 1);
      const start = Date.now();
      let ok = true;
      try {
        await waitForSupervisor(rec, "px2b-wait", 800);
      } catch {
        ok = false;
      }
      const ms = Date.now() - start;
      while (Atomics.load(flags, 2) === 0) {}
      trials += 1;
      if (!ok || ms > 400) stalls.push(us);
      await sleep(5);
    }
  }
  Atomics.store(flags, 3, 1);
  assert.deepEqual(stalls, [], `lost wakeup stalled ${stalls.length}/${trials} trials at offsets ${stalls.join(",")}`);
});

// Repair cycle 1 (B1/probe J): when watch() itself fails, the file-activity
// wait falls back to the short tick, never to the whole remaining deadline.
test("px2b: file-activity wait falls back to a short tick when unwatchable", { timeout: 15_000 }, async (t) => {
  if (!needsWindows(t)) return;
  const missing = join(tmpdir(), `aiboard-px2b-nowatch-${process.pid}-${Date.now()}`);
  const start = Date.now();
  await waitForFileActivity(missing, "never.jsonl", 5_000);
  const elapsed = Date.now() - start;
  assert.ok(elapsed < 2_000, `unwatchable wait must fall back to the short tick, took ${elapsed}ms`);
});

// Repair cycle 1 (B2): fake-authority pins for each fused-terminal predicate
// (F1-F4), the fused-acquire reattest (F5), and the timed-delay fallback.
// The terminal proof path needs no sink: waitForTerminal polls (empty),
// reattests exited, and runs the single attested read.
const PX2B_FAKE_BIRTH = "2026-09-30T00:00:00.000Z";

async function px2bTerminalFixture(overrides: {
  attachStartedAt?: string;
  bindingStartedAt?: string | null;
  terminal?: Partial<{ processId: string; startedAt: string; status: "stopped" | "running"; ownershipReleased: boolean }>;
  reattest?: "live" | "exited" | "throw";
  fused?: boolean;
  waitNeverResolves?: boolean;
} = {}) {
  const attachStartedAt = overrides.attachStartedAt ?? PX2B_FAKE_BIRTH;
  const owner = { runId: "px2b-fake", sessionId: "px2b-fake" };
  const fence = { ownerId: "px2b-fake", fencingToken: 1 };
  const terminal = {
    processId: "px2b-fake-job",
    startedAt: attachStartedAt,
    status: "stopped" as "stopped" | "running",
    ownershipReleased: true,
    ...overrides.terminal,
  };
  const attachState = {
    nextSequence: 1,
    inputClosed: false,
    outputOffsets: { stdout: 0, stderr: 0 },
    outputSequences: { stdout: 0, stderr: 0 },
    snapshot: {
      processId: "px2b-fake-job", pid: 42, status: "running" as const, exitCode: null, signal: null,
      startedAt: attachStartedAt, updatedAt: attachStartedAt, stdout: "", stderr: "", ownershipReleased: false,
    },
  };
  const service: WindowsJobChannelAuthority["service"] = {
    launchOwned: async () => { throw new Error("No fixture workloads"); },
    signalOwned: async () => { throw new Error("No fixture workloads"); },
    reconcileOwned: async () => ({
      ...terminal, pid: 42, exitCode: 0, signal: null, updatedAt: attachStartedAt, stdout: "", stderr: "",
    }),
    releaseOwned: async () => { throw new Error("unused fixture service method"); },
    probeActiveJobCreateClose: async () => false,
    claimOwnedFence: async () => undefined,
    attachOwnedChannel: async () => ({ ...attachState }),
    writeOwnedInput: async (_id, _owner, _fence, sequence) => ({ acknowledged: true as const, sequence }),
    closeOwnedInput: async () => undefined,
    readOwnedOutput: async () => ({ stdout: new Uint8Array(), stderr: new Uint8Array(), next: { stdout: 0, stderr: 0 } }),
    acknowledgeOwnedOutput: async () => undefined,
    ...(overrides.fused === false
      ? {}
      : { claimAndAttachOwnedChannel: async () => ({ ...attachState }) }),
    ...(overrides.waitNeverResolves
      ? { waitOwnedStatusChange: async () => { await new Promise<void>(() => {}); } }
      : {}),
  };
  const mode = overrides.reattest ?? "exited";
  const provider = createWindowsJobProcessChannelProvider({
    replayCapacityChunks: 4,
    replayCapacityBytes: 16,
    pollIntervalMs: 1,
    clock: () => 1000,
    authority: (): WindowsJobChannelAuthority => ({
      processId: "px2b-fake-job",
      owner,
      fence,
      service,
      control: async <T>(effect: () => Promise<T>): Promise<T> => await effect(),
      reattest: async (): Promise<"live" | "exited"> => {
        if (mode === "throw") throw new Error("fake birth mismatch");
        return mode;
      },
    }),
  });
  const binding = (overrides.bindingStartedAt === null
    ? {}
    : { startedAt: overrides.bindingStartedAt ?? attachStartedAt }) as ProcessBackendBinding;
  const channel = await provider.acquire(binding, fence);
  return { channel };
}

test("px2b: fused terminal proof rejects a birth the attach snapshot never saw", async (t) => {
  if (!needsWindows(t)) return;
  const { channel } = await px2bTerminalFixture({
    attachStartedAt: PX2B_FAKE_BIRTH,
    bindingStartedAt: null,
    terminal: { startedAt: "2026-09-30T00:00:01.000Z" },
  });
  try {
    await assert.rejects(channel.waitForTerminal(), /not currently authenticated/);
  } finally {
    await channel.detach();
  }
});

test("px2b: fused terminal proof rejects a birth outside the binding", async (t) => {
  if (!needsWindows(t)) return;
  // Attach snapshot and terminal agree with each other but not with the
  // binding birth: only the restored binding leg can reject this.
  const { channel } = await px2bTerminalFixture({
    attachStartedAt: "2026-09-30T00:00:07.000Z",
    bindingStartedAt: PX2B_FAKE_BIRTH,
    terminal: { startedAt: "2026-09-30T00:00:07.000Z" },
  });
  try {
    await assert.rejects(channel.waitForTerminal(), /not currently authenticated/);
  } finally {
    await channel.detach();
  }
});

test("px2b: fused terminal proof accepts the attested birth", async (t) => {
  if (!needsWindows(t)) return;
  const { channel } = await px2bTerminalFixture({
    attachStartedAt: PX2B_FAKE_BIRTH,
    bindingStartedAt: PX2B_FAKE_BIRTH,
    terminal: { startedAt: PX2B_FAKE_BIRTH },
  });
  try {
    channel.subscribeBackpressuredOutput(async (metadata) => metadata);
    const terminal = (await channel.waitForTerminal()) as { state: string };
    assert.equal(terminal.state, "exited");
  } finally {
    await channel.detach();
  }
});

test("px2b: fused terminal proof rejects a foreign processId", async (t) => {
  if (!needsWindows(t)) return;
  const { channel } = await px2bTerminalFixture({ terminal: { processId: "px2b-other-job" } });
  try {
    await assert.rejects(channel.waitForTerminal(), /not currently authenticated/);
  } finally {
    await channel.detach();
  }
});

test("px2b: fused terminal proof rejects a non-stopped terminal", async (t) => {
  if (!needsWindows(t)) return;
  // Released but still running: only the stopped leg can reject this (the
  // ownership leg passes), so deleting the status predicate turns this red.
  const { channel } = await px2bTerminalFixture({
    terminal: { status: "running", ownershipReleased: true },
  });
  try {
    await assert.rejects(channel.waitForTerminal(), /not currently authenticated/);
  } finally {
    await channel.detach();
  }
});

test("px2b: fused terminal proof rejects an unreleased terminal", async (t) => {
  if (!needsWindows(t)) return;
  // Stopped but not released: only the ownership leg can reject this, so
  // deleting the ownershipReleased predicate turns this red.
  const { channel } = await px2bTerminalFixture({
    terminal: { status: "stopped", ownershipReleased: false },
  });
  try {
    await assert.rejects(channel.waitForTerminal(), /not currently authenticated/);
  } finally {
    await channel.detach();
  }
});

test("px2b: fused acquire withholds the channel when reattest fails", async (t) => {
  if (!needsWindows(t)) return;
  // The birth re-verification after the fused claim+attach throws: acquire
  // must reject and hand out no channel. Deleting the reattest turns red.
  await assert.rejects(
    px2bTerminalFixture({ reattest: "throw" }),
    /fake birth mismatch/,
  );
});

test("px2b: fused terminal proof settles through the timed delay without events", async (t) => {
  if (!needsWindows(t)) return;
  // The fake exposes no waitOwnedStatusChange (like a host without the
  // method): the channel falls back to its timed delay and still settles.
  const { channel } = await px2bTerminalFixture({
    attachStartedAt: PX2B_FAKE_BIRTH,
    bindingStartedAt: PX2B_FAKE_BIRTH,
  });
  try {
    const terminal = (await channel.waitForTerminal()) as { state: string };
    assert.equal(terminal.state, "exited");
  } finally {
    await channel.detach();
  }
});

// Repair cycle 1 (B3): detach cancels the in-flight event wait. The fake
// wait never resolves, so without the detach signal this parks forever;
// with it, waitForTerminal rejects at once with the detached error.
test("px2b: detach cancels a parked terminal wait", async (t) => {
  if (!needsWindows(t)) return;
  const { channel } = await px2bTerminalFixture({ reattest: "live", waitNeverResolves: true });
  const terminal = channel.waitForTerminal();
  void terminal.catch(() => undefined);
  await sleep(50);
  await channel.detach();
  await assert.rejects(terminal, /detached/);
});

// Repair cycle 1 (F6): the live supervisor wakes a parked /wait-status on
// its next durable persist. Quiet long-sleep process, so no persist can land
// between the host's file read and the request: only the event wake (the
// SIGTERM transition) can return this early. Deleting the settle call parks
// to the 5 s timeout instead.
test("px2b: supervisor wait wakes on a persist before its timeout", { timeout: 55_000 }, async (t) => {
  if (!needsWindows(t)) return;
  const root = mkdtempSync(join(tmpdir(), "aiboard-px2b-wake-"));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 30, retryDelay: 50 }));
  const workspace = join(root, "workspace");
  mkdirSync(workspace, { recursive: true });
  const service = createWindowsJobProcessHost({ stateDirectory: join(root, "job-host") });
  const owner: WindowsJobOwnershipKey = { runId: "px2b-wake", sessionId: "px2b-wake" };
  const fence: WindowsJobWriterFence = { ownerId: "px2b-wake", fencingToken: 1 };
  const target = launchArgs("setTimeout(() => process.exit(0), 30000)");
  const launched = await service.launchOwned({
    ...owner,
    command: target.executable,
    args: target.args,
    workingDirectory: workspace,
    environment: allowedEnv(),
    interactive: true,
    fence: { ...fence },
  });
  try {
    const start = Date.now();
    const waiting = service.waitOwnedStatusChange!(launched.processId, owner, { ...fence }, 5_000);
    await sleep(300);
    await service.signalOwned(launched.processId, "SIGTERM", owner, { ...fence }).catch(() => undefined);
    await waiting;
    const elapsed = Date.now() - start;
    assert.ok(elapsed < 4_000, `event wake must beat the 5 s timeout, took ${elapsed}ms`);
  } finally {
    try {
      await service.signalOwned(launched.processId, "SIGKILL", owner, { ...fence });
    } catch {
      // Already terminal.
    }
    try {
      await service.releaseOwned(launched.processId, owner, launched.startedAt, { ...fence });
    } catch {
      // Best-effort cleanup only.
    }
  }
});

// Repair cycle 1 (F7): the /wait-status immediate return fires for stopped
// only (N3), never for exited_unknown. This is pinned as a source-shape
// check, deliberately: a stopped supervisor exits within milliseconds (a
// fetch right after the stopped observation already refuses), and pipelined
// second requests do not observe it either — async handlers run concurrently
// and wake together on the next persist, so no live request can arrive after
// the fact to take the branch. Deleting the branch (the F7 fault) or
// restoring exited_unknown to it (the N3 fault) turns this red.
test("px2b: supervisor wait returns landed stopped immediately", async (t) => {
  if (!needsWindows(t)) return;
  const source = readFileSync(join(process.cwd(), "runner-v2", "src", "managed-process-supervisor.mjs"), "utf8");
  const handlerAt = source.indexOf('"/wait-status"');
  assert.ok(handlerAt >= 0, "the /wait-status handler must exist");
  const handler = source.slice(handlerAt, handlerAt + 2000);
  const immediateAt = handler.indexOf('if (status.status === "stopped") {');
  assert.ok(immediateAt >= 0, "landed stopped must return at once (no lost wakeup)");
  const immediateBody = handler.slice(immediateAt, immediateAt + 300);
  assert.ok(!immediateBody.includes("exited_unknown"), "exited_unknown is not final and must park");
});

// Repair cycle 1 (B2/release guard): the in-fence release check refuses a
// fence or status change that lands after the pre-lock checks (review probe
// D). Each scenario mutates durable state inside beforeFenceEffect("release")
// — between the pre-lock read and the fenced read — and must be refused with
// no tombstone. Deleting the in-fence final check lets scenario B write a
// tombstone on a live tree instead.
test("px2b: release refuses a post-check fence or status change", { timeout: 55_000 }, async (t) => {
  if (!needsWindows(t)) return;
  const root = mkdtempSync(join(tmpdir(), "aiboard-px2b-relguard-"));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 30, retryDelay: 50 }));
  const workspace = join(root, "workspace");
  mkdirSync(workspace, { recursive: true });
  const stateDirectory = join(root, "job-host");
  const owner: WindowsJobOwnershipKey = { runId: "px2b-relguard", sessionId: "px2b-relguard" };
  const fence: WindowsJobWriterFence = { ownerId: "px2b-relguard", fencingToken: 1 };
  let armed: "fence" | "status" | null = null;
  let paths = { record: "", status: "" };
  const service = createWindowsJobProcessHost({
    stateDirectory,
    beforeFenceEffect: (kind) => {
      if (kind !== "release" || armed === null) return;
      if (armed === "fence") {
        const disk = JSON.parse(readFileSync(paths.record, "utf8")) as { currentFence: unknown };
        disk.currentFence = { ownerId: "px2b-late-writer", fencingToken: 99 };
        writeFileSync(paths.record, JSON.stringify(disk, null, 2));
      } else {
        const lines = readFileSync(paths.status, "utf8").split(/\r?\n/).filter(Boolean);
        const last = JSON.parse(lines[lines.length - 1]!) as Record<string, unknown>;
        appendFileSync(paths.status, `${JSON.stringify({
          ...last, status: "running", ownershipReleased: false, jobEmptyProof: false, updatedAt: new Date().toISOString(),
        })}\n`);
      }
      armed = null;
    },
  });
  const target = launchArgs("process.exit(0)");
  const launched = await service.launchOwned({
    ...owner,
    command: target.executable,
    args: target.args,
    workingDirectory: workspace,
    environment: allowedEnv(),
    interactive: true,
    fence: { ...fence },
  });
  paths = {
    record: join(stateDirectory, `${launched.processId}.json`),
    status: join(stateDirectory, launched.processId, "supervisor.jsonl"),
  };
  const diskBackup = readFileSync(paths.record, "utf8");
  const tombstone = (): boolean =>
    (JSON.parse(readFileSync(paths.record, "utf8")) as { backendOwnershipReleasedAt?: unknown })
      .backendOwnershipReleasedAt !== undefined;
  try {
    let stopped = false;
    for (let attempt = 0; attempt < 200 && !stopped; attempt++) {
      const snapshot = await service.reconcileOwned(launched.processId, owner, { ...fence });
      stopped = snapshot.status === "stopped" && snapshot.ownershipReleased;
      if (!stopped) await sleep(100);
    }
    assert.ok(stopped, "call must reach stopped before arming the post-check mutations");
    armed = "fence";
    await assert.rejects(
      service.releaseOwned(launched.processId, owner, launched.startedAt, { ...fence }),
      /stale/,
      "a newer fence after the pre-checks must be refused",
    );
    assert.equal(tombstone(), false, "refused release must write no tombstone");
    writeFileSync(paths.record, diskBackup);
    // Scenario B needs the supervisor dead first: while it is alive its HTTP
    // channel masks the forged file line (live reads win over the file), so
    // only a dead supervisor makes the fenced read observe the flipped
    // status. Stopped supervisors exit on their own; wait for that (a live
    // one here would make the release succeed, which is the masking the
    // comment above describes — never a silent pass).
    const doomed = (JSON.parse(readFileSync(paths.record, "utf8")) as {
      supervisor: { port: number; token: string };
    }).supervisor;
    let supervisorDead = false;
    for (let attempt = 0; attempt < 150 && !supervisorDead; attempt++) {
      try {
        await fetch(`http://127.0.0.1:${doomed.port}/status`, {
          headers: { authorization: `Bearer ${doomed.token}` },
        });
        await sleep(100);
      } catch {
        supervisorDead = true;
      }
    }
    assert.ok(supervisorDead, "supervisor must be dead before arming the status flip");
    armed = "status";
    await assert.rejects(
      service.releaseOwned(launched.processId, owner, launched.startedAt, { ...fence }),
      /unavailable|ECONNREFUSED|not verified terminal|changed before release/,
      "a live status after the pre-checks must be refused",
    );
    writeFileSync(paths.record, diskBackup);
    assert.equal(tombstone(), false, "refused release must write no tombstone");
  } finally {
    try {
      writeFileSync(paths.record, diskBackup);
    } catch {
      // Best-effort restore only.
    }
    try {
      await service.signalOwned(launched.processId, "SIGKILL", owner, { ...fence });
    } catch {
      // Already terminal.
    }
    try {
      await service.releaseOwned(launched.processId, owner, launched.startedAt, { ...fence });
    } catch {
      // Best-effort cleanup only (the forged live line may still refuse).
    }
  }
});

// Repair cycle 1 (B3): detach during a live terminal wait settles promptly.
// Bound near the PX-2a numbers (19-64 ms detach-to-settled there, 452-1006
// on the unrepaired PX-2b): without the detach signal this parks to the
// 1 s wait timeout instead.
test("px2b: detach settles a live terminal wait promptly", { timeout: 55_000 }, async (t) => {
  if (!needsWindows(t)) return;
  const root = mkdtempSync(join(tmpdir(), "aiboard-px2b-detach-"));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 30, retryDelay: 50 }));
  const workspace = join(root, "workspace");
  mkdirSync(workspace, { recursive: true });
  const { backend } = backendHarness(root);
  const duplex = backend as WindowsJobObjectProcessBackend;
  const fence: ProcessEffectFence = { ownerId: "px2b-detach", fencingToken: 1 };
  const launch = parseProcessLaunchResult(
    await backend.launch(launchRequest("px2b-detach", workspace, "setTimeout(() => process.exit(0), 30000)", fence)),
  );
  const binding = bindLaunch(launch);
  const channel = await duplex.backpressuredChannelProvider().acquire(binding, fence);
  channel.subscribeBackpressuredOutput(async (metadata) => metadata);
  const terminal = channel.waitForTerminal();
  void terminal.catch(() => undefined);
  try {
    await sleep(300);
    const start = Date.now();
    await channel.detach();
    await assert.rejects(terminal, /detached/);
    const elapsed = Date.now() - start;
    assert.ok(elapsed < 250, `detach must settle the wait promptly, took ${elapsed}ms`);
  } finally {
    try {
      await backend.signal(binding, "force_terminate", fence);
    } catch {
      // Already terminal.
    }
    try {
      await backend.release(binding, fence).catch(() => undefined);
    } catch {
      // Best-effort cleanup only.
    }
  }
});

// Repair cycle 1 (N4): a failure between the two halves of the fused effect
// leaves the same durable state as the old split flow. Non-interactive record
// so the attach half throws after the claim CAS persisted; a new host
// instance then rejects the old fence and accepts the new one.
test("px2b: fused claim+attach failure between halves keeps the fence upgrade", { timeout: 55_000 }, async (t) => {
  if (!needsWindows(t)) return;
  const root = mkdtempSync(join(tmpdir(), "aiboard-px2b-crashmid-"));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 30, retryDelay: 50 }));
  const workspace = join(root, "workspace");
  mkdirSync(workspace, { recursive: true });
  const stateDirectory = join(root, "job-host");
  const owner: WindowsJobOwnershipKey = { runId: "px2b-crashmid", sessionId: "px2b-crashmid" };
  const oldFence: WindowsJobWriterFence = { ownerId: "px2b-crashmid", fencingToken: 1 };
  const newFence: WindowsJobWriterFence = { ownerId: "px2b-crashmid", fencingToken: 2 };
  const first = createWindowsJobProcessHost({ stateDirectory });
  const target = launchArgs("setTimeout(() => process.exit(0), 5000)");
  const launched = await first.launchOwned({
    ...owner,
    command: target.executable,
    args: target.args,
    workingDirectory: workspace,
    environment: allowedEnv(),
    fence: { ...oldFence },
  });
  await assert.rejects(
    first.claimAndAttachOwnedChannel!(launched.processId, owner, { ...newFence }),
    /no interactive input channel/,
    "attach half must throw on a non-interactive record",
  );
  const disk = JSON.parse(readFileSync(join(stateDirectory, `${launched.processId}.json`), "utf8")) as {
    currentFence: WindowsJobWriterFence;
  };
  assert.deepEqual(disk.currentFence, newFence, "claim half must have persisted the upgrade");
  const second = createWindowsJobProcessHost({ stateDirectory });
  try {
    await assert.rejects(
      second.reconcileOwned(launched.processId, owner, { ...oldFence }),
      /stale/,
      "new instance must reject the old fence",
    );
    const snapshot = await second.reconcileOwned(launched.processId, owner, { ...newFence });
    assert.equal(snapshot.processId, launched.processId, "new instance must accept the new fence");
  } finally {
    try {
      await second.signalOwned(launched.processId, "SIGKILL", owner, { ...newFence });
    } catch {
      // Already terminal.
    }
    try {
      await second.releaseOwned(launched.processId, owner, launched.startedAt, { ...newFence });
    } catch {
      // Best-effort cleanup only.
    }
  }
});

// Repair cycle 1 (N3): exited_unknown is not final, so /wait-status parks in
// that state instead of returning at once. Quick exit with unacknowledged
// retained output reaches exited_unknown; after the empty proof lands (the
// only persist still due), the probe parks to its timeout. Restoring the old
// immediate branch turns this red.
test("px2b: supervisor wait parks while the outcome is unknown", { timeout: 55_000 }, async (t) => {
  if (!needsWindows(t)) return;
  const root = mkdtempSync(join(tmpdir(), "aiboard-px2b-unknown-"));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 30, retryDelay: 50 }));
  const workspace = join(root, "workspace");
  mkdirSync(workspace, { recursive: true });
  const stateDirectory = join(root, "job-host");
  const service = createWindowsJobProcessHost({ stateDirectory });
  const owner: WindowsJobOwnershipKey = { runId: "px2b-unknown", sessionId: "px2b-unknown" };
  const fence: WindowsJobWriterFence = { ownerId: "px2b-unknown", fencingToken: 1 };
  const target = launchArgs("process.stderr.write('held')");
  const launched = await service.launchOwned({
    ...owner,
    command: target.executable,
    args: target.args,
    workingDirectory: workspace,
    environment: allowedEnv(),
    interactive: true,
    fence: { ...fence },
  });
  try {
    const statusPath = join(stateDirectory, launched.processId, "supervisor.jsonl");
    let proof = false;
    for (let attempt = 0; attempt < 200 && !proof; attempt++) {
      const lines = readFileSync(statusPath, "utf8").trim().split(/\r?\n/).filter(Boolean);
      const durable = JSON.parse(lines[lines.length - 1]!) as { status: string; jobEmptyProof?: boolean };
      proof = durable.status === "exited_unknown" && durable.jobEmptyProof === true;
      if (!proof) await sleep(100);
    }
    assert.ok(proof, "call must reach exited_unknown with the empty proof before probing");
    const record = JSON.parse(readFileSync(join(stateDirectory, `${launched.processId}.json`), "utf8")) as {
      supervisor: { token: string; port: number };
    };
    const start = Date.now();
    const response = await fetch(
      `http://127.0.0.1:${record.supervisor.port}/wait-status?timeoutMs=1000`,
      { headers: { authorization: `Bearer ${record.supervisor.token}` } },
    );
    const body = (await response.json()) as { status: string };
    await response.arrayBuffer().catch(() => undefined);
    const elapsed = Date.now() - start;
    assert.equal(response.status, 200);
    assert.equal(body.status, "exited_unknown");
    assert.ok(elapsed >= 700 && elapsed < 5_000, `unknown outcome must park, took ${elapsed}ms`);
  } finally {
    // PX-2e: this call ends with unacknowledged retained output
    // (exited_unknown with pending output), where a plain signal+release is
    // refused by design and the supervisor would park forever. Drain with
    // exact ACKs so the supervisor reaches stopped and exits itself.
    await retireOwnedTreeForTests(service, {
      processId: launched.processId,
      owner,
      fence: { ...fence },
      startedAt: launched.startedAt,
    });
  }
});

// Repair cycle 1 (N2): /wait-status carries a change cursor. A wait that
// starts after a non-terminal change landed returns at once with newer state
// (a ticking live process guarantees the cursor is stale); a wait with a
// fresh cursor parks. Deleting the since branch parks the stale case to its
// timeout instead.
test("px2b: supervisor wait returns at once on a stale change cursor", { timeout: 55_000 }, async (t) => {
  if (!needsWindows(t)) return;
  const root = mkdtempSync(join(tmpdir(), "aiboard-px2b-cursor-"));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 30, retryDelay: 50 }));
  const workspace = join(root, "workspace");
  mkdirSync(workspace, { recursive: true });
  const service = createWindowsJobProcessHost({ stateDirectory: join(root, "job-host") });
  const owner: WindowsJobOwnershipKey = { runId: "px2b-cursor", sessionId: "px2b-cursor" };
  const fence: WindowsJobWriterFence = { ownerId: "px2b-cursor", fencingToken: 1 };
  const target = launchArgs("let i = 0; setInterval(() => console.log('tick-' + (i++)), 3000)");
  const launched = await service.launchOwned({
    ...owner,
    command: target.executable,
    args: target.args,
    workingDirectory: workspace,
    environment: allowedEnv(),
    interactive: true,
    fence: { ...fence },
  });
  try {
    const record = JSON.parse(readFileSync(join(root, "job-host", `${launched.processId}.json`), "utf8")) as {
      supervisor: { token: string; port: number };
    };
    const base = `http://127.0.0.1:${record.supervisor.port}`;
    const auth = { authorization: `Bearer ${record.supervisor.token}` };
    const first = (await (await fetch(`${base}/status`, { headers: auth })).json()) as {
      status: string; updatedAt: string;
    };
    assert.equal(first.status, "running");
    let current = first.updatedAt;
    for (let attempt = 0; attempt < 100; attempt++) {
      const seen = (await (await fetch(`${base}/status`, { headers: auth })).json()) as { updatedAt: string };
      if (seen.updatedAt !== current) {
        current = seen.updatedAt;
        break;
      }
      await sleep(100);
    }
    assert.notEqual(current, first.updatedAt, "a non-terminal persist must land before probing");
    const start = Date.now();
    const response = await fetch(
      `${base}/wait-status?timeoutMs=2000&since=${encodeURIComponent(first.updatedAt)}`,
      { headers: auth },
    );
    const body = (await response.json()) as { status: string; updatedAt: string };
    await response.arrayBuffer().catch(() => undefined);
    const elapsed = Date.now() - start;
    assert.equal(response.status, 200);
    assert.equal(body.status, "running", "cursor return must not need terminal state");
    assert.notEqual(body.updatedAt, first.updatedAt, "cursor return must carry newer state");
    assert.ok(elapsed < 1_000, `stale cursor must return at once, took ${elapsed}ms`);
  } finally {
    // PX-2e: the ticking child leaves unacknowledged retained output, where
    // a plain signal+release is refused by design and the supervisor would
    // park forever. Drain with exact ACKs so it reaches stopped and exits.
    await retireOwnedTreeForTests(service, {
      processId: launched.processId,
      owner,
      fence: { ...fence },
      startedAt: launched.startedAt,
    });
  }
});

test("px2b: supervisor wait parks on a fresh change cursor", { timeout: 55_000 }, async (t) => {
  if (!needsWindows(t)) return;
  const root = mkdtempSync(join(tmpdir(), "aiboard-px2b-cursorfresh-"));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 30, retryDelay: 50 }));
  const workspace = join(root, "workspace");
  mkdirSync(workspace, { recursive: true });
  const service = createWindowsJobProcessHost({ stateDirectory: join(root, "job-host") });
  const owner: WindowsJobOwnershipKey = { runId: "px2b-cursorfresh", sessionId: "px2b-cursorfresh" };
  const fence: WindowsJobWriterFence = { ownerId: "px2b-cursorfresh", fencingToken: 1 };
  const target = launchArgs("setTimeout(() => process.exit(0), 30000)");
  const launched = await service.launchOwned({
    ...owner,
    command: target.executable,
    args: target.args,
    workingDirectory: workspace,
    environment: allowedEnv(),
    interactive: true,
    fence: { ...fence },
  });
  try {
    const record = JSON.parse(readFileSync(join(root, "job-host", `${launched.processId}.json`), "utf8")) as {
      supervisor: { token: string; port: number };
    };
    const base = `http://127.0.0.1:${record.supervisor.port}`;
    const auth = { authorization: `Bearer ${record.supervisor.token}` };
    const seen = (await (await fetch(`${base}/status`, { headers: auth })).json()) as { updatedAt: string };
    const start = Date.now();
    const response = await fetch(
      `${base}/wait-status?timeoutMs=800&since=${encodeURIComponent(seen.updatedAt)}`,
      { headers: auth },
    );
    await response.arrayBuffer().catch(() => undefined);
    const elapsed = Date.now() - start;
    assert.equal(response.status, 200);
    assert.ok(elapsed >= 600 && elapsed < 5_000, `fresh cursor must park, took ${elapsed}ms`);
  } finally {
    try {
      await service.signalOwned(launched.processId, "SIGKILL", owner, { ...fence });
    } catch {
      // Already terminal.
    }
    try {
      await service.releaseOwned(launched.processId, owner, launched.startedAt, { ...fence });
    } catch {
      // Best-effort cleanup only.
    }
  }
});

// Repair cycle 1 (N6): a missing timeoutMs means the 1 s default, not a 1 ms
// park (Number(null) is 0, which used to slip through the clamp).
test("px2b: supervisor wait defaults a missing timeout", { timeout: 55_000 }, async (t) => {
  if (!needsWindows(t)) return;
  const root = mkdtempSync(join(tmpdir(), "aiboard-px2b-deftimeout-"));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 30, retryDelay: 50 }));
  const workspace = join(root, "workspace");
  mkdirSync(workspace, { recursive: true });
  const service = createWindowsJobProcessHost({ stateDirectory: join(root, "job-host") });
  const owner: WindowsJobOwnershipKey = { runId: "px2b-deftimeout", sessionId: "px2b-deftimeout" };
  const fence: WindowsJobWriterFence = { ownerId: "px2b-deftimeout", fencingToken: 1 };
  const target = launchArgs("setTimeout(() => process.exit(0), 30000)");
  const launched = await service.launchOwned({
    ...owner,
    command: target.executable,
    args: target.args,
    workingDirectory: workspace,
    environment: allowedEnv(),
    interactive: true,
    fence: { ...fence },
  });
  try {
    const record = JSON.parse(readFileSync(join(root, "job-host", `${launched.processId}.json`), "utf8")) as {
      supervisor: { token: string; port: number };
    };
    const start = Date.now();
    const response = await fetch(`http://127.0.0.1:${record.supervisor.port}/wait-status`, {
      headers: { authorization: `Bearer ${record.supervisor.token}` },
    });
    await response.arrayBuffer().catch(() => undefined);
    const elapsed = Date.now() - start;
    assert.equal(response.status, 200);
    assert.ok(elapsed >= 700 && elapsed < 5_000, `missing timeout must park the 1 s default, took ${elapsed}ms`);
  } finally {
    try {
      await service.signalOwned(launched.processId, "SIGKILL", owner, { ...fence });
    } catch {
      // Already terminal.
    }
    try {
      await service.releaseOwned(launched.processId, owner, launched.startedAt, { ...fence });
    } catch {
      // Best-effort cleanup only.
    }
  }
});

// Repair cycle 1 (N5/backward compatibility): a supervisor without
// /wait-status (HTTP 404, like a pre-PX-2b supervisor) makes the helper
// throw, so the channel falls back to its timed delay.
test("px2b: status-change wait throws on an old supervisor without the endpoint", { timeout: 15_000 }, async (t) => {
  if (!needsWindows(t)) return;
  await withStatusStub(
    t,
    (url, auth) => {
      if (auth !== `Bearer ${"s".repeat(32)}`) return { code: 401, body: { error: "unauthorized" } };
      if (url.startsWith("/wait-status")) return { code: 404, body: { error: "not_found" } };
      return { code: 200, body: { status: "running", ownershipReleased: false } };
    },
    async (port) => {
      await assert.rejects(
        waitForSupervisorStatusChange(stubSupervisor(port), 500),
        /404/,
        "old supervisor must surface HTTP 404 so the caller falls back",
      );
    },
  );
});

// PX-2e: no supervisor or Job host started by this file (temp roots
// `aiboard-px2b-*`) may still be alive at file end. Leftovers are recorded,
// killed, and reported here; the per-test teardowns above must already have
// retired their trees through the designed drain path.
after(async () => {
  await checkNoWindowsJobProcessesLeft(["aiboard-px2b-"]);
});
