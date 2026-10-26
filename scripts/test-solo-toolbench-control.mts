import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { ToolBenchSessions } from "../runner-v2/src/toolbench-session";
import { SqliteBudgetLedger } from "../runner-v2/src/sqlite-budget-ledger";
import { providerUsageConfig } from "../runner-v2/src/provider-config-store";
import { ControlServer } from "../runner-v2/src/control-server";
import { ArtifactStore } from "../runner-v2/src/artifact-store";
import { createExecutionHost } from "../runner-v2/src/execution-host";
import { snapshotNativeBuildAmbientEnvironment, providerModelCostBasis } from "../runner-v2/src/native-build-factory";
import { emptyRunnerCapabilitiesConfig } from "../runner-v2/src/runner-capabilities-config";
import { getNativeToolBenchPack, NATIVE_TOOLBENCH_SUITE } from "../lib/benchmark/toolreliability/native-cases";
import { runSoloToolBench, SOLO_TOOLBENCH_DEPENDENCIES } from "../lib/benchmark/toolreliability/solo-runner-adapter";
import { NativeWorkBenchExecutionError } from "../lib/benchmark/workbench/native-runner-adapter";
import type { BenchmarkModelCallTrace } from "../lib/benchmark/types";
import type { ModelTurn } from "../runner-v2/src/agent-contracts";

const root = realpathSync.native(mkdtempSync(join(tmpdir(), "solo-control-")));
const project = join(root, "project"); const state = join(root, "state"); mkdirSync(project); mkdirSync(state);
const fixture = getNativeToolBenchPack(NATIVE_TOOLBENCH_SUITE)!.cases[0].case;
for (const [path, content] of Object.entries(fixture.fixtureFiles!)) { mkdirSync(dirname(join(project, path)), { recursive: true }); writeFileSync(join(project, path), content); }
const host = createExecutionHost({ projectRoot: project, stateDirectory: state, artifacts: new ArtifactStore(join(state, "artifacts")), ambientEnvironment: snapshotNativeBuildAmbientEnvironment() });
const config = { runtimeId: "test:model", providerId: "test", modelId: "model", transport: "openai-compatible" as const, secret: "test", capabilities: ["tools"], priority: 0, billingBasis: "api_priced" as const, inputCostMicrosPerMillion: 100_000, outputCostMicrosPerMillion: 200_000 };
let calls = 0; let entered!: () => void; let turn = 0;
const sessions = new ToolBenchSessions({ projectRoot: project, stateDirectory: state, providerConfigs: { load: () => [config], save() {}, close() {} }, executionHost: host, capabilitiesConfig: emptyRunnerCapabilitiesConfig(),
  modelFactory: () => ({ async complete(request): Promise<ModelTurn> {
    calls++; entered?.();
    if (request.sessionId.includes("cancel") || request.sessionId.includes("deadline")) return new Promise((_resolve, reject) => {
      request.signal!.addEventListener("abort", () => reject(request.signal!.reason), { once: true });
    });
    const name = request.sessionId.includes("scope") && turn++ === 0 ? "fs.write" : request.sessionId.includes("hidden") && turn++ === 0 ? "run_evidence_command" : request.sessionId.includes("environment") && turn++ === 0 ? "process.run" : "finish_toolbench";
    return { stopReason: "tool_calls", blocks: [{ type: "tool_call", callId: `call-${calls}`, name, arguments: name === "fs.write" ? { path: "unrelated.txt", content: "Forbidden" } : name === "run_evidence_command" ? { label: "Forbidden oracle", command: "node", args: ["verifier.mjs"] } : name === "process.run" ? { command: "node", args: ["check.mjs"], env: { NODE_OPTIONS: "--import=./verifier.mjs" } } : {} }], usage: { inputTokens: 100, outputTokens: 10, providerReportedCostUsd: 0.0001 } };
  } }),
});
const server = new ControlServer({ toolBench: sessions, supervisor: {} as never, token: "local-test-token", runnerInfo: { projectPath: project, nodeVersion: process.versions.node }, checkGit: async () => ({ available: true, version: "test" }), bootstrapRun: async () => { throw new Error("ToolBench must never bootstrap a Build."); } });
const address = await server.start(0);
let stopped = 0;
const dependencies = { ...SOLO_TOOLBENCH_DEPENDENCIES,
  startManagedAttemptRunner: async (_config: unknown, input: { attemptId: string }) => ({ running: true, attemptId: input.attemptId, url: address.url, token: "local-test-token", projectPath: project, statePath: state }),
  restoreManagedAttemptOracle: async () => ({ restored: true, attemptId: "test" }),
  stopManagedAttemptRunner: async () => { stopped++; return { running: false, attemptId: "test", projectPath: project, statePath: state }; },
  configureNativeProviders: async () => {}, createNativeProviderConfig: () => config,
};
try {
  const unauthorized = await fetch(address.url + "/v2/toolbench-sessions/guess");
  assert.equal(unauthorized.status, 401);
  for (const scenario of ["early-finish", "scope", "hidden", "environment", "budget", "cancel", "deadline"]) {
    calls = 0; turn = 0;
    const controller = new AbortController(); const cancellation = new Error("User cancelled calibration.");
    const modelEntered = new Promise<void>(resolve => { entered = resolve; });
    const traces: BenchmarkModelCallTrace[] = []; const artifacts: unknown[] = [];
    const pending = runSoloToolBench({ attemptId: scenario, runId: scenario, teamCompositionId: "solo", harnessProfile: "raw-single-model", runner: { url: "http://unused", token: "test" },
      case: { ...fixture, budget: { ...fixture.budget, ...(scenario === "budget" ? { maxInputTokens: 1 } : {}), ...(scenario === "deadline" ? { maxWallClockSeconds: .05 } : {}) } },
      allowedCommands: fixture.allowedCommands, models: [{ modelId: "test:model", providerId: "test", displayName: "Model" }],
      teamComposition: { roles: [{ role: "single", modelId: "test:model", providerId: "test", displayName: "Model" }] }, signal: controller.signal,
      context: { recordTrace: async (trace: BenchmarkModelCallTrace) => { const index = traces.findIndex(t => t.id === trace.id); if (index >= 0) traces[index] = trace; else traces.push(trace); }, recordToolCall: async () => {}, recordArtifact: async (artifact: unknown) => { artifacts.push(artifact); } },
    } as never, dependencies);
    const rejection = assert.rejects(pending, error => scenario === "cancel" ? error === cancellation : error instanceof NativeWorkBenchExecutionError && error.certifiedStatus === (["budget", "deadline"].includes(scenario) ? "failed_budget" : "failed_tool_use") && Boolean(error.buildResult));
    if (scenario === "cancel") { await modelEntered; controller.abort(cancellation); }
    await rejection;
    assert.ok(artifacts.length > 0, `${scenario}: durable terminal evidence must be published`);
    if (scenario === "budget") assert.equal(calls, 0, "Budget preflight must stop before a paid request.");
    if (scenario === "early-finish") assert.equal(traces[0].inputTokens, 100);
    if (scenario === "cancel") assert.ok(traces.length > 0 && traces[0].usageSource === "estimated", "A cancelled request retains its uncertain usage instead of reporting free execution.");
    const snapshot = await sessions.get(`toolbench-${scenario}`);
    assert.notEqual(snapshot.status, "running");
    assert.equal(host.activeRunIds().length, 0, "Terminal session must release its execution binding.");
    console.log(`PASS authenticated solo control, ${scenario}, preserved evidence and settled cleanup`);
  }
  assert.equal(stopped, 7);
  const recovered = new ToolBenchSessions({ projectRoot: project, stateDirectory: state, providerConfigs: { load: () => [], save() {}, close() {} }, executionHost: host, capabilitiesConfig: emptyRunnerCapabilitiesConfig() });
  assert.equal((await recovered.get("toolbench-cancel")).status, "cancelled", "A fresh manager recovers terminal evidence without new calls.");
  const restart = join(state, "toolbench", "toolbench-restart"); mkdirSync(restart, { recursive: true });
  writeFileSync(join(restart, "snapshot.json"), JSON.stringify({ sessionId: "toolbench-restart", status: "running", reason: "", updatedAt: new Date().toISOString(), tools: [], evidence: [], toolEvidence: { runId: "toolbench-restart", tools: [] } }));
  writeFileSync(join(restart, "manifest.json"), JSON.stringify({ request: { sessionId: "toolbench-restart", budget: {} }, runtime: providerUsageConfig(config) }));
  const pendingBudget = new SqliteBudgetLedger(join(restart, "budget.sqlite"), { limitsFor: () => ({}) });
  try { pendingBudget.reserve({ scopeId: "toolbench-restart", reservationId: "interrupted", kind: "model", attribution: { runtimeId: config.runtimeId, providerId: config.providerId, modelId: config.modelId, sessionId: "toolbench-restart", role: "worker" }, costBasis: providerModelCostBasis(config), estimate: { inputTokens: 42, outputTokens: 17, estimatedCostMicros: 30 }, occurredAt: new Date().toISOString(), idempotencyKey: "reserve" }); }
  finally { pendingBudget.close(); }
  await recovered.recover();
  const interrupted = await recovered.get("toolbench-restart");
  assert.equal(interrupted.status, "failed"); assert.equal(interrupted.reason, "runner_restarted");
  assert.equal(interrupted.usage!.lifetime.inputTokens, 42);
  assert.deepEqual(interrupted.usage!.reservations.interrupted.tokenSources, { inputTokens: "estimated", outputTokens: "estimated" });
  console.log("PASS restart preserves interrupted request estimates and never resumes model work");
} finally {
  await server.close(); await host.close();
  assert.ok(resolve(root).startsWith(resolve(tmpdir())));
  rmSync(root, { recursive: true, force: true });
}
