import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import type { ToolExecutionOutput } from "../src/agent-contracts.js";
import { ArtifactStore } from "../src/artifact-store.js";
import { createEvidenceTools } from "../src/evidence-tools.js";
import { SqliteEvidenceStore } from "../src/sqlite-evidence-store.js";
import { type FinalVerificationCommandFact } from "../src/final-verification-runtime.js";
import { FinalVerificationRuntime } from "./support/git-fixture.js";
import type { ProcessBackend } from "../src/process-backend.js";
import { createProcessTools } from "../src/process-tools.js";
import { ToolBroker } from "../src/tool-broker.js";
import { VerificationWorkspaceManager } from "./support/git-fixture.js";
import { createProductionOneShotCommandFixture } from "./support/one-shot-command-executor.js";

type Family = "process" | "evidence" | "final-verification";
const FAMILIES: readonly Family[] = ["process", "evidence", "final-verification"];
interface FamilyResult { outcome?: string; errorCode?: string; errorMessage?: string; cleanupState?: string }
interface FamilyAdapter {
  workspace: string;
  graph: ReturnType<typeof createProductionOneShotCommandFixture>;
  run(input: { args: string[]; timeoutMs: number; signal?: AbortSignal }): Promise<FamilyResult>;
  launched(): boolean;
  close(): Promise<void>;
}

for (const family of FAMILIES) {
  test(`${family} public family times out and cleans a TERM-ignoring grandchild`, async (t) => {
    const adapter = await createFamilyAdapter(t, family);
    const marker = join(adapter.workspace, "timeout-grandchild.pid");
    try {
      // The runtime deadline starts before the Windows supervisor's bounded 5s handshake.
      // Leave enough budget to prove a launched identity before forcing command timeout.
      const result = await adapter.run({ args: hangingTree(marker), timeoutMs: 6_500 });
      assert.equal(result.outcome, "timed_out", JSON.stringify(result));
      assert.equal(result.cleanupState, "verified_empty");
      assert.equal(await processExited(Number(readFileSync(marker, "utf8"))), true);
    } finally { await adapter.close(); }
  });

  test(`${family} public family cancellation cleans its TERM-ignoring grandchild`, async (t) => {
    const adapter = await createFamilyAdapter(t, family);
    const marker = join(adapter.workspace, "cancel-grandchild.pid");
    const controller = new AbortController();
    try {
      const running = adapter.run({ args: hangingTree(marker), timeoutMs: 10_000, signal: controller.signal });
      await waitFor(() => existsSync(marker) && adapter.launched(), 8_000);
      controller.abort();
      const result = await running;
      assert.equal(result.outcome, "cancelled", JSON.stringify(result));
      assert.equal(result.cleanupState, "verified_empty");
      assert.equal(await processExited(Number(readFileSync(marker, "utf8"))), true);
    } finally { controller.abort(); await adapter.close(); }
  });

  test(`${family} public family maps strict capability failure before launch`, async (t) => {
    const adapter = await createFamilyAdapter(t, family, { permissionProfile: "project" });
    const marker = join(adapter.workspace, "must-not-launch");
    try {
      const result = await adapter.run({ args: ["-e", `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'launched')`], timeoutMs: 5_000 });
      assert.equal(result.errorCode, "isolation_capability_unavailable");
      assert.equal(existsSync(marker), false);
    } finally { await adapter.close(); }
  });

  test(`${family} public family maps restart outcome_unknown and retains cleanup ownership`, async (t) => {
    const adapter = await createFamilyAdapter(t, family, {
      backend: outcomeUnknownBackend(), backendId: "fixture-outcome",
      leaseDurationMs: 20, leaseHeartbeatMs: 5,
    });
    try {
      const result = await adapter.run({ args: ["--version"], timeoutMs: 5_000 });
      assert.equal(result.cleanupState, "failed", "family mapping exposes the initial cleanup failure");
      await new Promise((resolve) => setTimeout(resolve, 50));
      const recovery = await adapter.graph.reconcileStartup();
      assert.equal(recovery.some((entry) => entry.state === "cleanup_blocked"), true, JSON.stringify(recovery));
    } finally { await adapter.close(); }
  });
}

test("process public family queues cancellation after workload start but before durable bind", async (t) => {
  const barrier = launchBindingBarrier();
  const adapter = await createFamilyAdapter(t, "process", { backendDecorator: barrier.decorate });
  const marker = join(adapter.workspace, "prebind-cancel-grandchild.pid");
  const controller = new AbortController();
  try {
    const running = adapter.run({ args: hangingTree(marker), timeoutMs: 10_000, signal: controller.signal });
    await waitFor(() => existsSync(marker), 8_000);
    assert.equal(adapter.launched(), false, "controlled launch result is not durably bound yet");
    controller.abort();
    barrier.release();
    const result = await running;
    assert.equal(result.outcome, "cancelled", JSON.stringify(result));
    assert.equal(result.cleanupState, "verified_empty", JSON.stringify(result));
    assert.equal(await processExited(Number(readFileSync(marker, "utf8"))), true);
  } finally { controller.abort(); barrier.release(); await adapter.close(); }
});

test("process public family queues timeout after workload start but before durable bind", async (t) => {
  const barrier = launchBindingBarrier();
  const adapter = await createFamilyAdapter(t, "process", { backendDecorator: barrier.decorate });
  const marker = join(adapter.workspace, "prebind-timeout-grandchild.pid");
  try {
    const running = adapter.run({ args: hangingTree(marker), timeoutMs: 300 });
    await waitFor(() => existsSync(marker), 8_000);
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.equal(adapter.launched(), false, "controlled launch result is not durably bound yet");
    barrier.release();
    const result = await running;
    assert.equal(result.outcome, "timed_out", JSON.stringify(result));
    assert.equal(result.cleanupState, "verified_empty", JSON.stringify(result));
    assert.equal(await processExited(Number(readFileSync(marker, "utf8"))), true);
  } finally { barrier.release(); await adapter.close(); }
});

async function createFamilyAdapter(t: TestContext, family: Family,
  options: Parameters<typeof createProductionOneShotCommandFixture>[1] = {}): Promise<FamilyAdapter> {
  const root = mkdtempSync(join(tmpdir(), `aiboard-${family}-${randomUUID()}-`));
  const workspace = family === "final-verification" ? join(root, "project") : join(root, "workspace");
  mkdirSync(workspace);
  const artifacts = new ArtifactStore(join(root, "artifacts"));
  const graph = createProductionOneShotCommandFixture(undefined, {
    managedProcessStartDeadlineMs: 20_000,
    ...options,
    artifacts,
  });
  const identity = randomUUID();
  let closed = false;
  const finish = (run: FamilyAdapter["run"], launched: () => boolean, visibleWorkspace = workspace,
    closeExtra?: () => void | Promise<void>): FamilyAdapter => {
    const adapter: FamilyAdapter = {
      workspace: visibleWorkspace, graph, run, launched,
      async close() {
        if (closed) return;
        closed = true;
        await closeExtra?.();
        await graph.close();
        rmSync(root, { recursive: true, force: true });
      },
    };
    t.after(async () => await adapter.close());
    return adapter;
  };

  if (family === "process") {
    const runId = `run-${identity}`; const sessionId = `session-${identity}`; const callId = `process-${identity}`;
    const broker = brokerFor(workspace, graph, options.permissionProfile);
    for (const tool of createProcessTools({ execution: graph.execution })) broker.register(tool);
    return finish(async ({ args, timeoutMs, signal }) => mapProcess(await broker.invoke({
      type: "tool_call", callId, name: "process.run",
      arguments: { command: process.execPath, args, timeoutMs },
    }, context(identity, signal))), () => graph.hasBackendBinding(runId, sessionId, callId));
  }

  if (family === "evidence") {
    const runId = `run-${identity}`; const sessionId = `session-${identity}`; const callId = `evidence-${identity}`;
    const store = new SqliteEvidenceStore(join(root, "evidence.sqlite"));
    const broker = brokerFor(workspace, graph, options.permissionProfile);
    for (const tool of createEvidenceTools({ store, artifacts, taskId: `task-${identity}`, execution: graph.execution })) broker.register(tool);
    return finish(async ({ args, timeoutMs, signal }) => mapEvidence(await broker.invoke({
      type: "tool_call", callId, name: "run_evidence_command",
      arguments: { label: "matrix", command: process.execPath, args, cwd: ".", timeoutMs },
    }, context(identity, signal))), () => graph.hasBackendBinding(runId, sessionId, callId), workspace, () => store.close());
  }

  initializeGitProject(workspace);
  const revision = execFileSync("git", ["rev-parse", "HEAD"], { cwd: workspace, encoding: "utf8" }).trim();
  const manager = new VerificationWorkspaceManager({ repositoryRoot: workspace,
    stateDirectory: join(root, "verification-state"), runId: `run-${identity}`, targetRevision: revision });
  await manager.create();
  const generationId = `generation-${identity}`;
  const runtime = new FinalVerificationRuntime({ workspaceManager: manager, artifacts,
    runId: `run-${identity}`, taskId: "final-verification", integrationRevision: () => revision,
    generationId, execution: graph.runnerOwnedExecution });
  return finish(async ({ args, timeoutMs, signal }) => {
    const command = { label: "matrix", executable: process.execPath, args, timeoutMs };
    const run = await runtime.run({ plan: finalPlan(), executionProfile: {
      version: 1, targetRevision: revision, inspectedPaths: ["package.json"],
      detectedSignals: [{ category: "build", source: "matrix", detail: "matrix" }], commands: { build: [command] },
    }, commands: { build: [command] }, ...(signal ? { signal } : {}) });
    const fact = run.checks.flatMap((check) => check.facts)
      .find((candidate): candidate is FinalVerificationCommandFact => candidate.kind === "command")!;
    return { outcome: fact.timedOut ? "timed_out" : fact.cancelled ? "cancelled" : undefined,
      errorCode: fact.errorCode, cleanupState: fact.cleanup?.state };
  }, () => graph.hasBackendBinding(`run-${identity}`, "final-verification", `${generationId}:build:0:1`),
  manager.path, async () => await manager.cleanup().catch(() => undefined));
}

function brokerFor(workspace: string, graph: ReturnType<typeof createProductionOneShotCommandFixture>, profile = "full") {
  return new ToolBroker({ permissionProfile: profile as "full" | "project", workspacePath: workspace,
    executionGrants: graph.executionGrants, toolTimeoutMs: 20_000,
    ...(profile === "full" ? {} : { approve: async () => true }) });
}

function mapProcess(output: ToolExecutionOutput): FamilyResult {
  const value = json(output) as { timedOut?: boolean; cancelled?: boolean; cleanup?: { state: string } };
  return { outcome: value.timedOut ? "timed_out" : value.cancelled ? "cancelled" : undefined,
    errorCode: output.error?.code, errorMessage: output.error?.message, cleanupState: value.cleanup?.state };
}
function mapEvidence(output: ToolExecutionOutput): FamilyResult {
  if (output.isError) return { errorCode: output.error?.code, errorMessage: output.error?.message };
  const value = json(output) as { fact: { timedOut: boolean; cancelled: boolean; cleanup?: { state: string } } };
  return { outcome: value.fact.timedOut ? "timed_out" : value.fact.cancelled ? "cancelled" : undefined,
    cleanupState: value.fact.cleanup?.state };
}
function json(output: ToolExecutionOutput): unknown {
  return output.content.find((entry) => entry.type === "json")?.value ?? {};
}
function context(identity: string, signal?: AbortSignal) {
  return { runId: `run-${identity}`, sessionId: `session-${identity}`,
    actor: { role: "worker" as const, id: `worker-${identity}` }, ...(signal ? { signal } : {}) };
}
function initializeGitProject(workspace: string): void {
  writeFileSync(join(workspace, "package.json"), "{}\n");
  execFileSync("git", ["init"], { cwd: workspace, stdio: "ignore" });
  execFileSync("git", ["add", "package.json"], { cwd: workspace, stdio: "ignore" });
  execFileSync("git", ["-c", "user.name=Matrix", "-c", "user.email=matrix@example.com", "commit", "-m", "fixture"], { cwd: workspace, stdio: "ignore" });
}
function finalPlan() {
  return { checks: [
    { category: "build" as const, status: "required" as const },
    ...(["tests", "runtime_smoke", "browser"] as const).map((category) =>
      ({ category, status: "not_applicable" as const, rationale: "No command is configured for this matrix category.",
        repositoryInspection: { paths: ["package.json"], summary: "The fixture configures only the build command." } })),
  ] };
}
function hangingTree(marker: string): string[] {
  const child = "process.on('SIGTERM',()=>{}); setInterval(()=>{},1000)";
  return ["-e", `const fs=require('node:fs'); const {spawn}=require('node:child_process'); const child=spawn(process.execPath,['-e',${JSON.stringify(child)}],{stdio:'ignore'}); fs.writeFileSync(${JSON.stringify(marker)},String(child.pid)); process.on('SIGTERM',()=>{}); setInterval(()=>{},1000);`];
}
function outcomeUnknownBackend(): ProcessBackend {
  return {
    probe: async () => ({ attestationVersion: 2, backendId: "fixture-outcome", verified: true, platformLabel: "fault-injected-beneath-runtime",
      capabilities: { tree_termination: "enforced", crash_cleanup: "enforced", verified_emptiness: "enforced", write_confinement: "unavailable" },
      lifecycle: { scope: "process_group", termination: "enforced", emptiness: "enforced" } }),
    launch: async () => ({ opaqueIdentity: `owned-${randomUUID()}`,
      birthFingerprint: { observedAt: new Date().toISOString(), discriminator: randomUUID() }, rootPid: 999_999, startedAt: new Date().toISOString() }),
    observe: async () => ({ state: "exited", exitCode: 0 }), signal: async () => ({ state: "exited" }),
    verifyEmpty: async () => ({ empty: false, detail: "fault-injected unknown ownership" }),
    reconcile: async () => ({ state: "outcome_unknown" }), release: async () => ({ released: true }),
  };
}

function launchBindingBarrier(): { decorate(backend: ProcessBackend): ProcessBackend; release(): void } {
  let release!: () => void;
  let released = false;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  return {
    decorate: (backend) => ({
      probe: async () => await backend.probe(),
      launch: async (request) => { const launched = await backend.launch(request); await gate; return launched; },
      observe: async (binding, output, fence) => await backend.observe(binding, output, fence),
      signal: async (binding, action, fence) => await backend.signal(binding, action, fence),
      verifyEmpty: async (binding, fence) => await backend.verifyEmpty(binding, fence),
      reconcile: async (binding, fence) => await backend.reconcile(binding, fence),
      release: async (binding, fence) => await backend.release(binding, fence),
    }),
    release: () => { if (!released) { released = true; release(); } },
  };
}
async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) { if (Date.now() >= deadline) throw new Error("Fixture condition timed out.");
    await new Promise((resolve) => setTimeout(resolve, 25)); }
}
async function processExited(pid: number): Promise<boolean> {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try { process.kill(pid, 0); } catch { return true; }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return false;
}
