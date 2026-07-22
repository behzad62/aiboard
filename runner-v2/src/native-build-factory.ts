import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { AccountRunnerModel } from "./account-runner-model.js";
import { AnthropicModel } from "./anthropic-model.js";
import type { AgentModel } from "./agent-contracts.js";
import type { ModelCostBasisSnapshot } from "./budget-ledger.js";
import { ArtifactStore } from "./artifact-store.js";
import { ArtifactReachabilityGuard } from "./artifact-reachability.js";
import { BuildRuntime, type IntegrationRuntimeDriver } from "./build-runtime.js";
import { nativeBuildBudgetEnforceabilityError } from "./budget-enforceability.js";
import type { ModelCostEstimator } from "./budgeted-model.js";
import type {
  BuildObservabilitySnapshot,
  BuildToolObservation,
} from "./build-observability.js";
import { PlaywrightBrowserBackend } from "./browser-tools.js";
import type { NativeBuildSpec } from "./build-spec.js";
import { IntegrationManager } from "./integration-manager.js";
import { GoogleModel } from "./google-model.js";
import { ManagedProcessService } from "./managed-process.js";
import type { NativeBuildRuntimeHandle } from "./native-build-manager.js";
import {
  projectNativeModelUsage,
  type NativeModelUsageRuntime,
} from "./model-usage-projection.js";
import { NativeArchitectRuntime } from "./native-architect-runtime.js";
import { NativeWorkerDriver } from "./native-worker-driver.js";
import { OpenAICompatibleModel } from "./openai-compatible-model.js";
import type { McpManager } from "./mcp-tools.js";
import type { SqlitePermissionStore } from "./permission-store.js";
import type {
  ProviderConfigStore,
  RunnerProviderConfig,
} from "./provider-config-store.js";
import {
  providerUsageConfig,
  resolvedProviderBillingBasis,
} from "./provider-config-store.js";
import { ProviderHealthRegistry, type ProviderHealthState } from "./provider-health.js";
import { RuntimeRouter, type AgentRuntimeCandidate } from "./runtime-router.js";
import {
  rebuildSchedulerProjection,
  type SchedulerEvent,
} from "./scheduler-store.js";
import {
  SkillCatalog,
  type SharedSkillRoot,
} from "./skill-catalog.js";
import { SqliteAgentSessionStore } from "./sqlite-agent-session-store.js";
import { SqliteBudgetLedger } from "./sqlite-budget-ledger.js";
import { SqliteEvidenceStore } from "./sqlite-evidence-store.js";
import { SqliteProjectMemoryStore } from "./sqlite-project-memory.js";
import { rebuildProjectMemories } from "./project-memory.js";
import { SqliteSchedulerStore } from "./sqlite-scheduler-store.js";
import { SqliteToolLedger } from "./sqlite-tool-ledger.js";
import { WorkspaceManager } from "./workspace-manager.js";

export interface NativeBuildFactoryOptions {
  projectRoot: string;
  stateDirectory: string;
  providerConfigs: ProviderConfigStore;
  mcpManager?: McpManager;
  permissions?: SqlitePermissionStore;
  baselineFor(runId: string): string;
  skillRoots?: readonly SharedSkillRoot[];
}

export class NativeBuildFactory {
  private readonly artifacts: ArtifactStore;
  private readonly artifactReachability: ArtifactReachabilityGuard;
  private readonly memoryStore: SqliteProjectMemoryStore;
  private readonly browserBackend: PlaywrightBrowserBackend;
  private readonly managedProcesses: ManagedProcessService;
  private closed = false;

  constructor(private readonly options: NativeBuildFactoryOptions) {
    this.artifacts = new ArtifactStore(join(options.stateDirectory, "artifacts"));
    this.artifactReachability = new ArtifactReachabilityGuard(
      options.stateDirectory,
      this.artifacts
    );
    this.memoryStore = new SqliteProjectMemoryStore(
      join(options.stateDirectory, "project-memory.sqlite")
    );
    this.browserBackend = new PlaywrightBrowserBackend(
      join(options.stateDirectory, "browser-sessions")
    );
    this.managedProcesses = new ManagedProcessService({
      stateDirectory: join(options.stateDirectory, "managed-processes"),
    });
  }

  async create(spec: NativeBuildSpec): Promise<NativeBuildRuntimeHandle> {
    if (this.closed) throw new Error("Native Build factory is closed.");
    const runRoot = join(this.options.stateDirectory, "builds", safeSegment(spec.runId));
    const baselineRevision = this.options.baselineFor(spec.runId);
    const selected = selectRuntimeCandidates(
      this.options.providerConfigs.load(),
      spec
    );
    const selectedConfigs = selected.configs;
    assertEnforceableBuildBudget(spec, selectedConfigs);
    const candidates = selected.all;
    const workerCandidates = selected.workers;
    const modelUsageRuntimes = selectedConfigs.map((config) =>
      configuredModelUsageRuntime(config, spec)
    );
    const models = new Map<string, AgentModel>(
      selectedConfigs.map((config) => [
        config.runtimeId,
        createProviderModel(config, this.artifacts),
      ])
    );
    const modelCostEstimators = new Map<string, ModelCostEstimator>(
      selectedConfigs.flatMap((config) => {
        const estimator = providerCostEstimator(config);
        return estimator ? [[config.runtimeId, estimator] as const] : [];
      })
    );
    const modelCostBases = new Map<string, ModelCostBasisSnapshot>(
      selectedConfigs.map((config) => [config.runtimeId, providerModelCostBasis(config)])
    );
    const schedulerStore = new SqliteSchedulerStore(join(runRoot, "scheduler.sqlite"));
    const schedulerEvents = schedulerStore.readRun(spec.runId);
    const sessions = new SqliteAgentSessionStore(
      join(runRoot, "sessions.sqlite"),
      this.artifacts,
      {
        deleteArtifactIfGloballyUnreachable: (hash) =>
          this.artifactReachability.removeIfGloballyUnreachable(hash),
      }
    );
    const ledger = new SqliteToolLedger(join(runRoot, "tool-ledger.sqlite"));
    const evidenceStore = new SqliteEvidenceStore(join(runRoot, "evidence.sqlite"));
    const budgetLedger = new SqliteBudgetLedger(join(runRoot, "budget.sqlite"), {
      limitsFor: (scopeId) => {
        if (scopeId !== spec.runId) throw new Error(`Unknown budget scope ${scopeId}.`);
        return { ...spec.budgetLimits };
      },
    });
    budgetLedger.recoverInterruptedActive(
      spec.runId,
      `startup-recovery:${spec.runId}`,
    );
    const workspaceManager = new WorkspaceManager({
      repositoryRoot: this.options.projectRoot,
      stateDirectory: this.options.stateDirectory,
      runId: spec.runId,
      baselineRevision,
    });
    const integrationManager = new IntegrationManager({
      repositoryRoot: this.options.projectRoot,
      stateDirectory: this.options.stateDirectory,
      runId: spec.runId,
      baselineRevision,
      initializationMode: integrationInitializationModeFromEvents(schedulerEvents),
    });
    await integrationManager.initialize();
    const initialHealth = providerHealthFromSchedulerEvents(
      schedulerStore.readRun(spec.runId)
    );
    const health = new ProviderHealthRegistry({ initial: initialHealth });
    const workerRouter = new RuntimeRouter({
      candidates: workerCandidates,
      health,
    });
    const architectRouter = new RuntimeRouter({ candidates, health });
    const skillCatalog = new SkillCatalog({
      projectRoot: this.options.projectRoot,
      sharedRoots: this.options.skillRoots ?? defaultSharedSkillRoots(),
    });
    const workerDriver = new NativeWorkerDriver({
      schedulerStore,
      router: workerRouter,
      health,
      candidates: workerCandidates,
      models,
      permissionProfile: spec.permissionProfile,
      workspaceManager,
      artifacts: this.artifacts,
      ledger,
      sessions,
      evidenceStore,
      skillCatalog,
      memoryStore: this.memoryStore,
      projectId: spec.projectId,
      projectRoot: this.options.projectRoot,
      budgetLedger,
      modelCostEstimators,
      modelCostBases,
      browserBackend: this.browserBackend,
      ...(this.options.mcpManager ? { mcpManager: this.options.mcpManager } : {}),
      ...(this.options.permissions ? { permissions: this.options.permissions } : {}),
      managedProcesses: this.managedProcesses,
      ...(spec.benchmark
        ? { allowedCommands: spec.benchmark.allowedCommands }
        : {}),
    });
    const architectDriver = new NativeArchitectRuntime({
      schedulerStore,
      router: architectRouter,
      health,
      candidates,
      models,
      initialRuntimeId: spec.architectRuntimeId,
      sessions,
      artifacts: this.artifacts,
      skillCatalog,
      memoryStore: this.memoryStore,
      evidenceStore,
      projectId: spec.projectId,
      projectRoot: this.options.projectRoot,
      objective: spec.objective,
      runPolicy: spec.runPolicy,
      ...(spec.benchmark
        ? { allowedCommands: spec.benchmark.allowedCommands }
        : {}),
      budgetLedger,
      modelCostEstimators,
      modelCostBases,
      permissionProfile: spec.permissionProfile,
      ledger,
      ...(this.options.permissions ? { permissions: this.options.permissions } : {}),
      browserBackend: this.browserBackend,
      ...(this.options.mcpManager ? { mcpManager: this.options.mcpManager } : {}),
    });
    const integrationDriver: IntegrationRuntimeDriver = {
      integrate: async ({ taskId, changeSetId }) => {
        const task = rebuildSchedulerProjection(
          schedulerStore.readRun(spec.runId)
        ).tasks[taskId];
        if (!task) throw new Error(`Unknown integration task ${taskId}.`);
        const session = await sessions.load(
          `worker:${spec.runId}:${taskId}:${task.attempt}`
        );
        if (!session.changeSet || session.changeSet.id !== changeSetId) {
          throw new Error(`Submitted change set ${changeSetId} is unavailable.`);
        }
        const result = await integrationManager.integrate(session.changeSet);
        return result.status === "integrated"
          ? { status: "integrated", integrationRevision: result.integrationRevision }
          : {
              status: "conflict",
              integrationRevision: result.integrationRevision,
              conflictPaths: [...result.conflictPaths],
            };
      },
    };
    const runtime = new BuildRuntime({
      runId: spec.runId,
      runPolicy: spec.runPolicy,
      store: schedulerStore,
      workerDriver,
      architectDriver,
      integrationDriver,
      maxConcurrency: spec.maxConcurrency,
      workspaceFor: async (task, attempt) => {
        const workspace = await workspaceManager.createTaskWorkspace(task.id, {
          workspaceId: `${task.id}:attempt:${attempt}`,
          baselineRevision: integrationManager.revision,
        });
        return {
          path: workspace.path,
          workspaceId: workspace.workspaceId,
          baselineRevision: workspace.baselineRevision,
        };
      },
      renewBudgetWindow: (idempotencyKey, occurredAt) => {
        budgetLedger.startWindow({
          scopeId: spec.runId,
          occurredAt,
          idempotencyKey,
        });
      },
    });
    let closed = false;
    return {
      runtime,
      usage: () => {
        const budget = budgetLedger.snapshot(spec.runId);
        return {
          ...budget,
          attributedModelReservationCount: Object.values(budget.reservations).filter(
            (reservation) => reservation.kind === "model" && reservation.attribution
          ).length,
          models: projectNativeModelUsage({
            budget,
            runtimes: modelUsageRuntimes,
            providerHealth: health.snapshot(),
          }),
        };
      },
      observability: async (): Promise<BuildObservabilitySnapshot> => {
        const agentSessions = await sessions.listRun(spec.runId);
        const toolCalls = summarizeToolCalls(ledger.listRun(spec.runId));
        const schedulerEvents = schedulerStore.readRun(spec.runId);
        const schedulerProjection = rebuildSchedulerProjection(schedulerEvents);
        return {
          runId: spec.runId,
          budget: budgetLedger.snapshot(spec.runId),
          toolCallCount: toolCalls.length,
          agents: agentSessions.map((session) => ({
            sessionId: session.sessionId,
            actor: { ...session.actor },
            status: session.status,
            turns: session.checkpoint?.turns ?? 0,
            ...(session.suspensionReason
              ? { suspensionReason: session.suspensionReason }
              : {}),
            ...(session.error ? { error: session.error } : {}),
            ...(session.changeSetId ? { changeSetId: session.changeSetId } : {}),
            lastSequence: session.lastSequence,
          })),
          tools: toolCalls.slice(-1_000),
          evidence: evidenceStore.list({ runId: spec.runId, limit: 1_000 }),
          memories: [...rebuildProjectMemories(
            this.memoryStore.events(spec.projectId)
          ).values()],
          skills: await skillCatalog.discover(),
          processes: this.managedProcesses.listRun(spec.runId).slice(-100).map(
            (process) => ({
              ...process,
              stdout: process.stdout.slice(-8 * 1024),
              stderr: process.stderr.slice(-8 * 1024),
            })
          ),
          providers: Object.values(schedulerProjection.runtime.providerHealth),
          events: schedulerEvents.slice(-1_000),
          git: {
            integrationBranch: integrationManager.integrationBranch,
            integrationRevision: integrationManager.revision,
            commits: await integrationManager.history(50),
          },
        };
      },
      transcript: async (afterSequence = 0) =>
        await sessions.transcript(spec.runId, afterSequence),
      files: async () => {
        const handoff = runtime.projection().projectHandoff;
        if (
          handoff?.status === "selected" &&
          handoff.appliedToProject &&
          handoff.projectRevision
        ) {
          return await integrationManager.files("project", handoff.projectRevision);
        }
        return await integrationManager.files("integration");
      },
      compact: async () => {
        await sessions.compactRun(spec.runId);
      },
      projectHandoff: async (choice) =>
        choice === "apply_to_project"
          ? await integrationManager.applyToProject()
          : integrationManager.descriptor(false),
      cleanup: async () => {
        await cleanupSettledNativeBuild(
          () => this.managedProcesses.stopRun(spec.runId),
          [
            () => sessions.compactRun(spec.runId),
            () => workspaceManager.cleanup(),
            () => integrationManager.cleanup(),
          ],
          spec.runId
        );
      },
      close: () => {
        if (closed) return;
        closed = true;
        budgetLedger.close();
        evidenceStore.close();
        ledger.close();
        sessions.close();
        schedulerStore.close();
      },
    };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.memoryStore.close();
    this.options.providerConfigs.close();
    this.managedProcesses.close();
    await this.browserBackend.closeAll();
  }

  async runArtifactCompaction<T>(operation: () => Promise<T>): Promise<T> {
    return await this.artifactReachability.runQuiescent(operation);
  }

  async prepareArtifactCleanup(): Promise<void> {
    await this.artifactReachability.prepareReachabilityIndex();
  }
}

export async function cleanupSettledNativeBuild(
  stopManagedProcesses: () => Promise<void>,
  operations: readonly (() => Promise<unknown>)[],
  runId = "run"
): Promise<void> {
  await stopManagedProcesses();
  const failures: unknown[] = [];
  for (const operation of operations) {
    try {
      await operation();
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(
      failures,
      `Could not clean settled Build ${runId}.`
    );
  }
}

export function integrationInitializationModeFromEvents(
  events: readonly SchedulerEvent[]
): "active" | "cleanup-only" {
  if (events.length === 0) return "active";
  return rebuildSchedulerProjection(events).status === "completed"
    ? "cleanup-only"
    : "active";
}

function summarizeToolCalls(
  events: ReturnType<SqliteToolLedger["listRun"]>
): BuildToolObservation[] {
  const calls = new Map<string, BuildToolObservation>();
  for (const event of events) {
    if (!event.sessionId || !event.callId || !event.toolName) continue;
    const previous = calls.get(event.key);
    calls.set(event.key, {
      sequence: event.sequence,
      sessionId: event.sessionId,
      callId: event.callId,
      toolName: event.toolName,
      status: event.type === "tool.completed"
        ? "completed"
        : event.type === "tool.retry_started"
          ? "retrying"
          : "started",
      occurredAt: event.occurredAt,
      ...(event.result ? { isError: event.result.isError } : previous?.isError !== undefined
        ? { isError: previous.isError }
        : {}),
      ...(event.result?.error?.code
        ? { errorCode: event.result.error.code }
        : previous?.errorCode
          ? { errorCode: previous.errorCode }
          : {}),
    });
  }
  return [...calls.values()].sort((left, right) => left.sequence - right.sequence);
}

export function defaultSharedSkillRoots(): SharedSkillRoot[] {
  const builtIn = resolve(dirname(fileURLToPath(import.meta.url)), "..", "skills");
  const home = homedir();
  return [
    { path: builtIn, source: "built-in" },
    { path: join(home, ".codex", "skills"), source: "user" },
    { path: join(home, ".claude", "skills"), source: "user" },
    { path: join(home, ".aiboard", "skills"), source: "user" },
  ];
}

export function providerHealthFromSchedulerEvents(
  events: readonly SchedulerEvent[]
): ProviderHealthState[] {
  if (events.length === 0) return [];
  return Object.values(
    rebuildSchedulerProjection(events).runtime.providerHealth
  ).filter(isProviderHealthState);
}

function selectConfigs(
  configs: readonly RunnerProviderConfig[],
  spec: NativeBuildSpec
): RunnerProviderConfig[] {
  const required = new Set([spec.architectRuntimeId, ...spec.workerRuntimeIds]);
  const selected = configs.filter((config) => required.has(config.runtimeId));
  for (const runtimeId of required) {
    if (!selected.some((config) => config.runtimeId === runtimeId)) {
      throw new Error(`Provider runtime ${runtimeId} is not configured.`);
    }
  }
  return selected;
}

export function selectRuntimeCandidates(
  configs: readonly RunnerProviderConfig[],
  spec: NativeBuildSpec
): {
  configs: RunnerProviderConfig[];
  all: AgentRuntimeCandidate[];
  workers: AgentRuntimeCandidate[];
} {
  const selected = selectConfigs(configs, spec);
  const all = selected.map(toCandidate);
  const workerIds = new Set(spec.workerRuntimeIds);
  return {
    configs: selected,
    all,
    workers: all.filter((candidate) => workerIds.has(candidate.runtimeId)),
  };
}

function toCandidate(config: RunnerProviderConfig): AgentRuntimeCandidate {
  return {
    runtimeId: config.runtimeId,
    providerId: config.providerId,
    modelId: config.modelId,
    capabilities: [...config.capabilities],
    priority: config.priority,
  };
}

export function configuredModelUsageRuntime(
  config: RunnerProviderConfig,
  spec: NativeBuildSpec
): NativeModelUsageRuntime {
  const roles = new Set<NativeModelUsageRuntime["roles"][number]>();
  if (config.runtimeId === spec.architectRuntimeId) roles.add("architect");
  if (spec.workerRuntimeIds.includes(config.runtimeId)) roles.add("worker");
  return {
    ...providerUsageConfig(config),
    roles: [...roles],
    selectable:
      roles.has("worker") ||
      config.capabilities.includes("*") ||
      config.capabilities.includes("code"),
  };
}

export function createProviderModel(
  config: RunnerProviderConfig,
  artifacts?: ArtifactStore
): AgentModel {
  if (config.transport === "account-runner") {
    if (!config.baseUrl) {
      throw new Error(`Account runtime ${config.runtimeId} requires a baseUrl.`);
    }
    return new AccountRunnerModel({
      baseUrl: config.baseUrl,
      runnerPath: config.providerId,
      runnerToken: config.runnerToken ?? config.secret,
      modelId: config.modelId,
      ...(config.runnerToken ? { providerApiKey: config.secret } : {}),
      ...(config.reasoningEffort ? { reasoningEffort: config.reasoningEffort } : {}),
      ...(config.inputCapabilities
        ? { inputCapabilities: { ...config.inputCapabilities } }
        : {}),
      ...(artifacts
        ? { readArtifact: (hash: string) => artifacts.get(hash) }
        : {}),
    });
  }
  if (config.transport === "anthropic") {
    return new AnthropicModel({
      ...(config.baseUrl ? { baseUrl: config.baseUrl } : {}),
      apiKey: config.secret,
      modelId: config.modelId,
    });
  }
  if (config.transport === "google") {
    return new GoogleModel({
      ...(config.baseUrl ? { baseUrl: config.baseUrl } : {}),
      apiKey: config.secret,
      modelId: config.modelId,
    });
  }
  if (!config.baseUrl) {
    throw new Error(`OpenAI-compatible runtime ${config.runtimeId} requires a baseUrl.`);
  }
  return new OpenAICompatibleModel({
    baseUrl: config.baseUrl,
    apiKey: config.secret,
    modelId: config.modelId,
    ...(config.protocol ? { protocol: config.protocol } : {}),
    ...(config.providerId === "openai" ? { promptCaching: true } : {}),
  });
}

export function providerCostEstimator(
  config: RunnerProviderConfig
): ModelCostEstimator | undefined {
  if (
    resolvedProviderBillingBasis(config) !== "api_priced" ||
    config.inputCostMicrosPerMillion === undefined ||
    config.outputCostMicrosPerMillion === undefined
  ) return undefined;
  const inputRate = config.inputCostMicrosPerMillion;
  const outputRate = config.outputCostMicrosPerMillion;
  const cachedRate = config.cachedInputCostMicrosPerMillion ?? inputRate;
  const cacheWriteRate = config.cacheWriteInputCostMicrosPerMillion ?? inputRate;
  return (inputTokens, outputTokens, cachedInputTokens = 0, cacheWriteInputTokens = 0) => {
    const cached = Math.min(inputTokens, cachedInputTokens);
    const cacheWrite = Math.min(inputTokens - cached, cacheWriteInputTokens);
    const uncached = inputTokens - cached - cacheWrite;
    return Math.round((
      uncached * inputRate +
      cached * cachedRate +
      cacheWrite * cacheWriteRate +
      outputTokens * outputRate
    ) / 1_000_000);
  };
}

export function providerModelCostBasis(
  config: RunnerProviderConfig
): ModelCostBasisSnapshot {
  const billingBasis = resolvedProviderBillingBasis(config);
  if (billingBasis === "account_not_metered") {
    return { kind: "account_not_metered", billingBasis };
  }
  if (
    billingBasis !== "api_priced" ||
    config.inputCostMicrosPerMillion === undefined ||
    config.outputCostMicrosPerMillion === undefined
  ) return { kind: "unknown", billingBasis: "unknown" };
  return {
    kind: "api_estimate",
    billingBasis,
    inputCostMicrosPerMillion: config.inputCostMicrosPerMillion,
    outputCostMicrosPerMillion: config.outputCostMicrosPerMillion,
    cachedInputCostMicrosPerMillion:
      config.cachedInputCostMicrosPerMillion ?? config.inputCostMicrosPerMillion,
    cacheWriteInputCostMicrosPerMillion:
      config.cacheWriteInputCostMicrosPerMillion ?? config.inputCostMicrosPerMillion,
  };
}

export function assertEnforceableBuildBudget(
  spec: NativeBuildSpec,
  configs: readonly RunnerProviderConfig[]
): void {
  const message = nativeBuildBudgetEnforceabilityError(
    spec,
    configs.map((config) => ({
      runtimeId: config.runtimeId,
      costBasis:
        resolvedProviderBillingBasis(config) === "account_not_metered"
          ? "account_not_metered"
          : resolvedProviderBillingBasis(config) === "api_priced"
            ? "priced_api"
            : "unknown",
    }))
  );
  if (message) throw new Error(message);
}

function isProviderHealthState(value: unknown): value is ProviderHealthState {
  if (!value || typeof value !== "object") return false;
  const state = value as Partial<ProviderHealthState>;
  return (
    typeof state.providerId === "string" &&
    (state.status === "healthy" || state.status === "cooldown") &&
    typeof state.consecutiveFailures === "number" &&
    typeof state.updatedAt === "number"
  );
}

function safeSegment(value: string): string {
  const readable = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "run";
  return `${readable}-${createHash("sha256").update(value).digest("hex").slice(0, 10)}`;
}
