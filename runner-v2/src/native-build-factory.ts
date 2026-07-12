import { createHash } from "node:crypto";
import { join } from "node:path";

import { AccountRunnerModel } from "./account-runner-model.js";
import { AnthropicModel } from "./anthropic-model.js";
import type { AgentModel } from "./agent-contracts.js";
import { ArtifactStore } from "./artifact-store.js";
import { BuildRuntime, type IntegrationRuntimeDriver } from "./build-runtime.js";
import { PlaywrightBrowserBackend } from "./browser-tools.js";
import type { NativeBuildSpec } from "./build-spec.js";
import { IntegrationManager } from "./integration-manager.js";
import { GoogleModel } from "./google-model.js";
import { ManagedProcessService } from "./managed-process.js";
import type { NativeBuildRuntimeHandle } from "./native-build-manager.js";
import { NativeArchitectRuntime } from "./native-architect-runtime.js";
import { NativeWorkerDriver } from "./native-worker-driver.js";
import { OpenAICompatibleModel } from "./openai-compatible-model.js";
import type { McpManager } from "./mcp-tools.js";
import type { SqlitePermissionStore } from "./permission-store.js";
import type {
  ProviderConfigStore,
  RunnerProviderConfig,
} from "./provider-config-store.js";
import { ProviderHealthRegistry, type ProviderHealthState } from "./provider-health.js";
import { RuntimeRouter, type AgentRuntimeCandidate } from "./runtime-router.js";
import {
  rebuildSchedulerProjection,
  type SchedulerEvent,
} from "./scheduler-store.js";
import { SkillCatalog } from "./skill-catalog.js";
import { SqliteAgentSessionStore } from "./sqlite-agent-session-store.js";
import { SqliteBudgetLedger } from "./sqlite-budget-ledger.js";
import { SqliteEvidenceStore } from "./sqlite-evidence-store.js";
import { SqliteProjectMemoryStore } from "./sqlite-project-memory.js";
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
}

export class NativeBuildFactory {
  private readonly artifacts: ArtifactStore;
  private readonly memoryStore: SqliteProjectMemoryStore;
  private readonly browserBackend: PlaywrightBrowserBackend;
  private readonly managedProcesses: ManagedProcessService;
  private closed = false;

  constructor(private readonly options: NativeBuildFactoryOptions) {
    this.artifacts = new ArtifactStore(join(options.stateDirectory, "artifacts"));
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
    const candidates = selected.all;
    const workerCandidates = selected.workers;
    const models = new Map<string, AgentModel>(
      selectedConfigs.map((config) => [config.runtimeId, createProviderModel(config)])
    );
    const schedulerStore = new SqliteSchedulerStore(join(runRoot, "scheduler.sqlite"));
    const sessions = new SqliteAgentSessionStore(
      join(runRoot, "sessions.sqlite"),
      this.artifacts
    );
    const ledger = new SqliteToolLedger(join(runRoot, "tool-ledger.sqlite"));
    const evidenceStore = new SqliteEvidenceStore(join(runRoot, "evidence.sqlite"));
    const budgetLedger = new SqliteBudgetLedger(join(runRoot, "budget.sqlite"), {
      limitsFor: (scopeId) => {
        if (scopeId !== spec.runId) throw new Error(`Unknown budget scope ${scopeId}.`);
        return { ...spec.budgetLimits };
      },
    });
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
    const skillCatalog = new SkillCatalog({ projectRoot: this.options.projectRoot });
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
      browserBackend: this.browserBackend,
      ...(this.options.mcpManager ? { mcpManager: this.options.mcpManager } : {}),
      ...(this.options.permissions ? { permissions: this.options.permissions } : {}),
      managedProcesses: this.managedProcesses,
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
      budgetLedger,
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
      store: schedulerStore,
      workerDriver,
      architectDriver,
      integrationDriver,
      maxConcurrency: spec.maxConcurrency,
      workspaceFor: async (task) =>
        (await workspaceManager.createTaskWorkspace(task.id)).path,
    });
    let closed = false;
    return {
      runtime,
      usage: () => budgetLedger.snapshot(spec.runId),
      projectHandoff: async (choice) =>
        choice === "apply_to_project"
          ? await integrationManager.applyToProject()
          : integrationManager.descriptor(false),
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

export function createProviderModel(config: RunnerProviderConfig): AgentModel {
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
  });
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
