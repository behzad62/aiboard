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
import { createWindowsProcessBackend } from "../src/windows-process-backend.js";

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
// attachment observation: invalid shape, lower token, and same-token
// foreign owner are all rejected; the current fence attaches exactly once.
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
  try {
    await assert.rejects(
      service.claimAndAttachOwnedChannel!(launched.processId, OWNER, { ownerId: "", fencingToken: 0 }),
      /writer fence is invalid/,
      "malformed fence must be rejected",
    );
    await assert.rejects(
      service.claimAndAttachOwnedChannel!(launched.processId, OWNER, { ownerId: FENCE.ownerId, fencingToken: 0 }),
      /writer fence is (invalid|stale)/,
      "lower token must be rejected",
    );
    await assert.rejects(
      service.claimAndAttachOwnedChannel!(launched.processId, OWNER, { ownerId: "foreign", fencingToken: FENCE.fencingToken }),
      /writer fence is stale/,
      "same-token foreign owner must be rejected",
    );
    const state = await service.claimAndAttachOwnedChannel!(launched.processId, OWNER, { ...FENCE });
    assert.equal(state.snapshot.processId, launched.processId, "current fence attaches");
    assert.equal(typeof state.snapshot.ownershipReleased, "boolean", "attach observes ownership");
  } finally {
    try {
      await service.signalOwned(launched.processId, "SIGKILL", OWNER, { ...FENCE });
    } catch {
      // Already terminal.
    }
    try {
      await service.releaseOwned(launched.processId, OWNER, launched.startedAt, { ...FENCE });
    } catch {
      // Best-effort cleanup only.
    }
  }
});

// E1 — the fused upgrade is the only new write boundary: after a fused
// acquire with a higher token, a NEW host instance on the same state dir
// honors the new fence and rejects the old one, then settles and releases.
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
      second.reconcileOwned(launched.processId, OWNER, { ...FENCE }),
      /stale/,
      "old fence must stay rejected after the fused upgrade",
    );
    const snapshot = await second.reconcileOwned(launched.processId, OWNER, upgraded);
    assert.equal(snapshot.processId, launched.processId, "new fence reconciles on the new instance");
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
