import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { join, relative, resolve, isAbsolute } from "node:path";
import type { AgentModel, NativeTool, ToolCallBlock, ToolExecutionContext } from "./agent-contracts.js";
import { runAgentLoop } from "./agent-loop.js";
import { ArtifactStore } from "./artifact-store.js";
import { createArtifactTools } from "./artifact-tools.js";
import { BudgetedAgentModel } from "./budgeted-model.js";
import { BudgetedToolRuntime } from "./budgeted-tool-runtime.js";
import { createBrowserTools, PlaywrightBrowserBackend } from "./browser-tools.js";
import { assertBudgetLimits } from "./budget-policy.js";
import { createEvidenceTools } from "./evidence-tools.js";
import type { ExecutionHost, ExecutionHostRunBinding } from "./execution-host.js";
import { createFilesystemTools } from "./filesystem-tools.js";
import { createOpenRouterApplyPatchTool } from "./openrouter-apply-patch-tool.js";
import { createProcessTools } from "./process-tools.js";
import { createManagedProcessTools } from "./managed-process-tools.js";
import { providerUsageConfig, type ProviderConfigStore, type RunnerProviderConfig } from "./provider-config-store.js";
import { createProviderModel, providerCostEstimator, providerModelCostBasis } from "./native-build-factory.js";
import { projectNativeModelUsage } from "./model-usage-projection.js";
import { createRunnerCapabilityContractSnapshot } from "./runner-capability-contract.js";
import type { RunnerCapabilitiesConfig } from "./runner-capabilities-config.js";
import { SkillCatalog } from "./skill-catalog.js";
import { createSkillTools } from "./skill-tools.js";
import { SqliteBudgetLedger } from "./sqlite-budget-ledger.js";
import { SqliteEvidenceStore } from "./sqlite-evidence-store.js";
import { SqliteToolLedger } from "./sqlite-tool-ledger.js";
import { ToolBroker } from "./tool-broker.js";
import { classifyProviderFailure } from "./provider-health.js";
import { redactSensitiveText } from "./sensitive-redaction.js";
import { isBenchmarkCommandAllowed } from "./benchmark-command-policy.js";

import type { ToolBenchEvidenceInput, ToolBenchSessionRequest, ToolBenchSessionSnapshot } from "./toolbench-contracts.js";
export type { ToolBenchSessionRequest } from "./toolbench-contracts.js";

export interface ToolBenchSessionOptions {
  projectRoot: string;
  stateDirectory: string;
  providerConfigs: ProviderConfigStore;
  executionHost: ExecutionHost;
  capabilitiesConfig: RunnerCapabilitiesConfig;
  /** Test seam substitutes only the model; tools and accounting remain real. */
  modelFactory?: (config: RunnerProviderConfig, artifacts: ArtifactStore) => AgentModel;
}

/** A solo tool session. No Build, scheduler, Architect, model judge, or documentation gate. */
export class ToolBenchSessions {
  private readonly sessions = new Map<string, { controller: AbortController; promise: Promise<void>; snapshot: ReturnType<ToolBenchSessions["emptySnapshot"]> }>();
  constructor(private readonly options: ToolBenchSessionOptions) {}

  /** Reconcile owned native resources before a restarted runner admits new sessions. */
  async recover(): Promise<void> {
    const root = join(this.options.stateDirectory, "toolbench");
    const entries = await readdir(root).catch(error => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    });
    for (const id of entries) {
      assertId(id);
      const directory = join(root, id);
      const bytes = await readFile(join(directory, "snapshot.json"), "utf8").catch(error => {
        // No binding or model call can start before the first durable snapshot.
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw error;
      });
      if (!bytes) continue;
      const saved = JSON.parse(bytes) as ToolBenchSessionSnapshot;
      if (saved.status !== "running" && !saved.reason.startsWith("cleanup_failed:")) continue;
      const manifest = JSON.parse(await readFile(join(directory, "manifest.json"), "utf8")) as { capabilityContract?: import("./runner-capability-contract.js").RunnerCapabilityContract };
      if (manifest.capabilityContract) {
        const binding = await this.options.executionHost.bindRun({ runId: id, permissionProfile: "full", capabilityContract: manifest.capabilityContract, capabilitiesConfig: this.options.capabilitiesConfig });
        await binding.close(); // Exact ownership/cleanup proof; failure blocks runner startup.
      }
      await this.get(id);
    }
  }

  private emptySnapshot(sessionId: string): ToolBenchSessionSnapshot {
    return { sessionId, status: "running" as "running" | "completed" | "failed" | "cancelled", reason: "", updatedAt: new Date().toISOString(),
      result: undefined,
      usage: undefined as import("./model-usage-projection.js").NativeBuildUsageProjection | undefined,
      tools: [],
      evidence: [] as ReturnType<SqliteEvidenceStore["list"]>,
      toolEvidence: { runId: sessionId, tools: [] as Array<{ sequence: number; callId: string; toolName: string; isError: boolean; errorCode?: string; input: ToolBenchEvidenceInput; outputText: string }> },
    };
  }

  async start(request: ToolBenchSessionRequest) {
    validateRequest(request);
    if (this.sessions.has(request.sessionId)) throw new Error("ToolBench session already exists; inspect its recorded outcome.");
    const directory = join(this.options.stateDirectory, "toolbench", request.sessionId);
    await mkdir(directory, { recursive: true });
    // Refuse replay after restart: a fresh attempt is required for a new measurement.
    try { await readFile(join(directory, "snapshot.json")); throw new Error("ToolBench session already recorded."); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const entry = { controller: new AbortController(), promise: Promise.resolve(), snapshot: this.emptySnapshot(request.sessionId) };
    this.sessions.set(request.sessionId, entry);
    entry.promise = this.execute(request, directory, entry).catch(error => {
      entry.snapshot.status = "failed";
      entry.snapshot.reason = `session_persistence_failed: ${redactSensitiveText(String(error), 2000)}`;
    });
    return entry.snapshot;
  }

  async get(sessionId: string): Promise<ToolBenchSessionSnapshot> {
    assertId(sessionId);
    const live = this.sessions.get(sessionId);
    if (live) return live.snapshot;
    const directory = join(this.options.stateDirectory, "toolbench", sessionId);
    const saved = JSON.parse(await readFile(join(directory, "snapshot.json"), "utf8")) as ToolBenchSessionSnapshot;
    if (saved.status !== "running") return saved;
    // A restart never resumes model work. Reconcile durable reservations as estimates so
    // interrupted provider calls do not disappear from the cost/token record.
    const manifest = JSON.parse(await readFile(join(directory, "manifest.json"), "utf8")) as { request: ToolBenchSessionRequest; runtime: ReturnType<typeof providerUsageConfig> };
    const ledger = new SqliteBudgetLedger(join(directory, "budget.sqlite"), { limitsFor: () => manifest.request.budget });
    try {
      for (const reservation of Object.values(ledger.snapshot(sessionId).reservations)) {
        if (reservation.status !== "reserved") continue;
        ledger.settle({ scopeId: sessionId, reservationId: reservation.reservationId, actual: reservation.estimate,
          ...(reservation.kind === "model" ? { tokenSources: { inputTokens: "estimated" as const, outputTokens: "estimated" as const }, costBasis: reservation.costBasis } : {}),
          occurredAt: new Date().toISOString(), idempotencyKey: `settle:${reservation.reservationId}` });
      }
      const budget = ledger.snapshot(sessionId);
      saved.usage = { ...budget, models: projectNativeModelUsage({ budget, runtimes: [{ ...manifest.runtime, roles: ["worker"], selectable: false }], providerHealth: [] }), attributedModelReservationCount: Object.values(budget.reservations).filter(r => r.kind === "model").length };
    } finally { ledger.close(); }
    saved.status = "failed"; saved.reason = "runner_restarted"; saved.updatedAt = new Date().toISOString();
    await writeFile(join(directory, "snapshot.tmp"), JSON.stringify(saved));
    await rename(join(directory, "snapshot.tmp"), join(directory, "snapshot.json"));
    this.sessions.set(sessionId, { controller: new AbortController(), promise: Promise.resolve(), snapshot: saved });
    return saved;
  }

  async stop(sessionId: string) {
    assertId(sessionId);
    const entry = this.sessions.get(sessionId);
    entry?.controller.abort(new Error("cancelled"));
    await entry?.promise;
    return this.get(sessionId);
  }

  async close() {
    for (const entry of this.sessions.values()) entry.controller.abort(new Error("runner_shutdown"));
    await Promise.all([...this.sessions.values()].map(entry => entry.promise));
  }

  private async execute(request: ToolBenchSessionRequest, directory: string, entry: { controller: AbortController; snapshot: ReturnType<ToolBenchSessions["emptySnapshot"]> }) {
    let binding: ExecutionHostRunBinding | undefined;
    let budget: SqliteBudgetLedger | undefined;
    let ledger: SqliteToolLedger | undefined;
    let evidence: SqliteEvidenceStore | undefined;
    let browser: PlaywrightBrowserBackend | undefined;
    const deadline = setTimeout(() => entry.controller.abort(new Error("wall_clock_limit")), request.maxWallClockMs);
    const signal = entry.controller.signal;
    let saveTail = Promise.resolve();
    let refresh = () => {};
    const save = () => {
      const json = JSON.stringify(entry.snapshot);
      saveTail = saveTail.then(async () => { await writeFile(join(directory, "snapshot.tmp"), json); await rename(join(directory, "snapshot.tmp"), join(directory, "snapshot.json")); });
      return saveTail;
    };
    try {
      const config = this.options.providerConfigs.load().find(config => config.runtimeId === request.runtimeId);
      if (!config) throw new Error("Selected ToolBench provider is not configured.");
      await writeFile(join(directory, "manifest.json"), JSON.stringify({ request, runtime: providerUsageConfig(config) }));
      const artifacts = new ArtifactStore(join(directory, "artifacts"));
      budget = new SqliteBudgetLedger(join(directory, "budget.sqlite"), { limitsFor: () => request.budget });
      ledger = new SqliteToolLedger(join(directory, "tools.sqlite"));
      evidence = new SqliteEvidenceStore(join(directory, "evidence.sqlite"));
      refresh = () => {
        const projection = budget!.snapshot(request.sessionId);
        entry.snapshot.usage = { ...projection, models: projectNativeModelUsage({ budget: projection, runtimes: [{ ...providerUsageConfig(config), roles: ["worker"], selectable: true }], providerHealth: [] }), attributedModelReservationCount: Object.values(projection.reservations).filter(r => r.kind === "model").length };
        entry.snapshot.tools = ledger!.listRun(request.sessionId).map(event => ({ sequence: event.sequence, sessionId: request.sessionId, callId: event.callId ?? event.result?.callId ?? "", toolName: event.toolName ?? event.result?.toolName ?? "", status: event.type === "tool.completed" ? "completed" : "started", occurredAt: event.occurredAt, isError: event.result?.isError, errorCode: event.result?.error?.code }));
        entry.snapshot.evidence = evidence!.list({ runId: request.sessionId });
        entry.snapshot.updatedAt = new Date().toISOString();
      };
      const contract = await createRunnerCapabilityContractSnapshot(this.options.capabilitiesConfig, this.options.stateDirectory);
      await writeFile(join(directory, "manifest.json"), JSON.stringify({ request, runtime: providerUsageConfig(config), capabilityContract: contract }));
      refresh(); await save();
      binding = await this.options.executionHost.bindRun({ runId: request.sessionId, artifacts, permissionProfile: "full", capabilitiesConfig: this.options.capabilitiesConfig, capabilityContract: contract });
      const broker = new ToolBroker({ git: binding.git, permissionProfile: "full", workspacePath: this.options.projectRoot, artifacts, ledger, executionGrants: binding.executionGrants });
      const tools: NativeTool<unknown>[] = [
        ...createFilesystemTools({ artifacts, hiddenPaths: request.hiddenPaths, protectedPaths: request.protectedPaths }),
        createOpenRouterApplyPatchTool({ protectedPaths: request.protectedPaths }),
        ...createArtifactTools(artifacts),
        ...createProcessTools({ execution: binding.commandExecution, allowedCommands: request.allowedCommands }),
        ...createManagedProcessTools(binding.managedProcesses),
        ...createEvidenceTools({ git: binding.git, store: evidence, artifacts, taskId: request.sessionId, execution: binding.commandExecution, allowedCommands: request.allowedCommands }),
      ];
      if (request.skills) tools.push(...createSkillTools(new SkillCatalog({ projectRoot: this.options.projectRoot, sharedRoots: [] })));
      if (request.browser) {
        browser = new PlaywrightBrowserBackend();
        tools.push(...createBrowserTools({ backend: browser, artifacts, evidenceStore: evidence, taskId: request.sessionId }));
      }
      tools.push({ definition: { name: "finish_toolbench", description: "Finish this tool task after completing its requested work. The external deterministic verifier scores the saved files and recorded actions.", inputSchema: { type: "object", properties: {}, additionalProperties: false }, readOnly: true, effect: "none", lifecycle: true },
        validate: input => input && typeof input === "object" && !Array.isArray(input) && Object.keys(input).length === 0 ? { ok: true, value: input } : { ok: false, issues: ["Expected an empty object."] },
        execute: async () => ({ isError: false, content: [{ type: "text", text: "Task submitted for deterministic scoring." }], lifecycle: { type: "submit_task", changeSetId: request.sessionId } }),
      });
      for (const tool of tools) broker.register(fenceTool(tool, request, this.options.projectRoot));
      entry.snapshot.availableTools = tools.map(tool => tool.definition.name).sort();
      const runtime = new BudgetedToolRuntime({ runtime: broker, ledger: budget, scopeId: request.sessionId });
      const originalInvoke = runtime.invoke.bind(runtime);
      runtime.invoke = async (call: ToolCallBlock, context: ToolExecutionContext) => {
        const result = await originalInvoke(call, context);
        const args = (call.arguments && typeof call.arguments === "object" ? call.arguments : {}) as Record<string, unknown>;
        if (["fs.read", "fs.search", "fs.patch", "fs.write", "artifact.read", "openrouter.apply_patch"].includes(call.name)) entry.snapshot.toolEvidence.tools.push({ sequence: ledger!.listRun(request.sessionId).at(-1)?.sequence ?? 0, callId: call.callId, toolName: call.name, isError: result.isError, errorCode: result.error?.code, input: {
          ...(typeof args.path === "string" ? { path: relative(this.options.projectRoot, resolve(this.options.projectRoot, args.path)).replace(/\\/g, "/") } : {}),
          ...(typeof args.startLine === "number" ? { startLine: args.startLine } : {}),
          ...(typeof args.endLine === "number" ? { endLine: args.endLine } : {}),
          ...(Array.isArray(args.edits) ? { editCount: args.edits.length } : {}),
          ...(call.name === "artifact.read" && typeof args.offset === "number" ? { offset: args.offset } : {}),
          ...(call.name === "fs.search" && typeof args.cursor === "string" ? { continued: true } : {}),
          ...(args.operation && typeof args.operation === "object" && "diff" in args.operation ? { editCount: Math.min((String(args.operation.diff).match(/^-[^-]/gm) ?? []).length, (String(args.operation.diff).match(/^\+[^+]/gm) ?? []).length) } : {}),
        // fs.search answers in JSON only; its bounded JSON is the evidence of what a page delivered.
        }, outputText: result.content.map(block => block.type === "text" ? block.text : call.name === "fs.search" && block.type === "json" ? JSON.stringify(block.value) : "").filter(Boolean).join("\n").slice(0, 64 * 1024) });
        if (Buffer.byteLength(JSON.stringify(entry.snapshot.toolEvidence)) > 4 * 1024 * 1024) throw new Error("ToolBench qualification evidence exceeded its export bound.");
        refresh(); await save(); return result;
      };
      const transport = (this.options.modelFactory ?? createProviderModel)(config, artifacts);
      const model = new BudgetedAgentModel({ model: { complete: request => transport.complete(request), contextWindowTokens: config.contextWindowTokens ?? transport.contextWindowTokens }, ledger: budget, scopeId: request.sessionId,
        attribution: { runtimeId: config.runtimeId, providerId: config.providerId, modelId: config.modelId, sessionId: request.sessionId, role: "worker" },
        outputTokenReserve: config.maxOutputTokens ?? 16_384, estimateCostMicros: providerCostEstimator(config), costBasis: providerModelCostBasis(config) });
      refresh(); await save();
      entry.snapshot.startedAt = new Date().toISOString();
      const loop = await runAgentLoop({ model, registry: runtime, context: { runId: request.sessionId, sessionId: request.sessionId, actor: { role: "worker", id: request.runtimeId }, workspacePath: this.options.projectRoot, signal }, signal,
        maxTurns: request.budget.maxModelCalls ?? 300,
        coordination: "solo",
        initialMessages: [{ id: "system", role: "system", content: "Complete the user's tool task directly using the available native tools. You are the only model. No planning, review, documentation, or project handoff is required. Use finish_toolbench as the only call in your final turn. Tool errors are ordinary tool feedback; hidden benchmark scores are never supplied. Token use, elapsed time and actions are measured; budgets are emergency guards." }, { id: "task", role: "user", content: request.prompt }],
        providerRetry: { runtimeId: config.runtimeId, providerId: config.providerId, modelId: config.modelId, classify: classifyProviderFailure },
        onCheckpoint: async checkpoint => { refresh(); await writeFile(join(directory, "transcript.json"), JSON.stringify(checkpoint)); await save(); },
      });
      refresh();
      entry.snapshot.status = loop.status === "submitted" ? "completed" : signal.aborted ? "cancelled" : "failed";
      entry.snapshot.reason = signal.aborted ? String(signal.reason?.message ?? "cancelled") : loop.status === "suspended" ? loop.reason : "";
      entry.snapshot.result = { status: loop.status, turns: loop.turns, ...(loop.status === "suspended" ? { reason: loop.reason, error: loop.error ? redactSensitiveText(loop.error, 2000) : undefined, errorCode: loop.errorCode } : {}) };
    } catch (error) {
      entry.snapshot.status = signal.aborted ? "cancelled" : "failed";
      entry.snapshot.reason = redactSensitiveText(signal.aborted ? String(signal.reason?.message ?? "cancelled") : error instanceof Error ? error.message : String(error), 2000);
    } finally {
      clearTimeout(deadline);
      if (entry.snapshot.startedAt) entry.snapshot.completedAt = new Date().toISOString();
      refresh();
      const cleanup = await Promise.allSettled([browser?.closeAll(), binding?.close()]);
      const cleanupFailure = cleanup.find(result => result.status === "rejected");
      if (cleanupFailure?.status === "rejected") { entry.snapshot.status = "failed"; entry.snapshot.reason = `cleanup_failed: ${redactSensitiveText(String(cleanupFailure.reason), 2000)}`; }
      try { await save(); }
      finally { ledger?.close(); evidence?.close(); budget?.close(); }
      // The durable transcript is separate; avoid copying a growing conversation on every poll.
    }
  }
}

function assertId(id: string) { if (typeof id !== "string" || !/^[a-zA-Z0-9_-]{1,120}$/.test(id)) throw new Error("Invalid ToolBench session ID."); }
function validateRequest(request: ToolBenchSessionRequest) {
  if (!request || typeof request !== "object") throw new Error("Invalid ToolBench request.");
  assertId(request.sessionId);
  if (!request.runtimeId || typeof request.prompt !== "string" || !request.prompt.trim()) throw new Error("ToolBench requires a model and prompt.");
  for (const paths of [request.allowedCommands, request.hiddenPaths, request.protectedPaths, request.editablePaths]) if (!Array.isArray(paths) || paths.some(p => typeof p !== "string" || !p)) throw new Error("Invalid ToolBench policy.");
  if (!Number.isSafeInteger(request.maxWallClockMs) || request.maxWallClockMs <= 0 || request.maxWallClockMs > 4_500_000) throw new Error("Invalid ToolBench wall-clock guard.");
  assertBudgetLimits(request.budget);
}
function fenceTool(tool: NativeTool<unknown>, request: ToolBenchSessionRequest, root: string): NativeTool<unknown> {
  return { ...tool, execute: async (input, context) => {
    if (tool.definition.name === "process.start" && !isBenchmarkCommandAllowed(input as { command?: string; args?: string[] }, request.allowedCommands)) {
      return { isError: true, error: { code: "benchmark_command_denied", message: "Command is not allowed by this benchmark." }, content: [{ type: "text", text: "Command is not allowed by this benchmark." }] };
    }
    for (const path of tool.assessAccess?.(input, context).paths ?? []) {
      const rel = relative(root, resolve(root, path.path)).replace(/\\/g, "/");
      const commandDirectory = ["process.start", "run_evidence_command", "process.run"].includes(tool.definition.name);
      if (isAbsolute(rel) || rel === ".." || rel.startsWith("../") || (!commandDirectory && path.access !== "read" && !request.editablePaths.includes(rel))) {
        return { isError: true, error: { code: "write_scope_violation", message: "Path is outside this benchmark's permitted scope." }, content: [{ type: "text", text: "Path is outside this benchmark's permitted scope." }] };
      }
    }
    return tool.execute(input, context);
  } };
}
