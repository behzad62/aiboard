import type {
  AgentMessage,
  AgentModel,
  ToolCallBlock,
  ToolExecutionContext,
  ToolResult,
} from "./agent-contracts.js";
import { runAgentLoop } from "./agent-loop.js";
import { buildArchitectContext, type PromptEvidence } from "./agent-prompts.js";
import { evidenceFactArtifactHashes, evidenceFactSummary } from "./evidence-store.js";
import type { ArtifactStore } from "./artifact-store.js";
import { createArtifactTools } from "./artifact-tools.js";
import { createBrowserTools, type BrowserBackend } from "./browser-tools.js";
import type {
  BudgetLedger,
  ModelCallAttribution,
  ModelCostBasisSnapshot,
} from "./budget-ledger.js";
import { BudgetedAgentModel, type ModelCostEstimator } from "./budgeted-model.js";
import { BudgetedToolRuntime } from "./budgeted-tool-runtime.js";
import type {
  ArchitectActionRequest,
  ArchitectRuntimeDriver,
} from "./build-runtime.js";
import type { ContextLimits } from "./context-assembler.js";
import type { EvidenceStore } from "./evidence-store.js";
import { createEvidenceTools } from "./evidence-tools.js";
import { createFilesystemTools } from "./filesystem-tools.js";
import { createGitTools } from "./git-tools.js";
import { createMemoryTools } from "./memory-tools.js";
import { createMcpTools, type McpManager } from "./mcp-tools.js";
import type { SqlitePermissionStore } from "./permission-store.js";
import type { PermissionProfile } from "./contracts.js";
import type { NativeBuildRunPolicy } from "./build-spec.js";
import type { ProjectMemoryStore } from "./project-memory.js";
import { discoverProjectInstructions } from "./project-context.js";
import {
  classifyProviderFailure,
  type ProviderHealthRegistry,
} from "./provider-health.js";
import type { AgentRuntimeCandidate, RuntimeRouter } from "./runtime-router.js";
import type { SchedulerStore } from "./scheduler-store.js";
import { rebuildSchedulerProjection } from "./scheduler-store.js";
import type { SqliteAgentSessionStore } from "./sqlite-agent-session-store.js";
import type { SkillCatalog } from "./skill-catalog.js";
import { createSkillTools } from "./skill-tools.js";
import { createResearchTools } from "./research-tools.js";
import { createSessionTools } from "./session-tools.js";
import { ToolBroker } from "./tool-broker.js";
import type { ToolInvocationLedger } from "./tool-ledger.js";
import {
  AgentProtocolError,
  type AgentToolRuntime,
} from "./tool-registry.js";

export interface NativeArchitectRuntimeOptions {
  schedulerStore: SchedulerStore;
  router: RuntimeRouter;
  health: ProviderHealthRegistry;
  candidates: readonly AgentRuntimeCandidate[];
  models: ReadonlyMap<string, AgentModel>;
  initialRuntimeId: string;
  sessions: SqliteAgentSessionStore;
  artifacts: ArtifactStore;
  skillCatalog: SkillCatalog;
  memoryStore: ProjectMemoryStore;
  evidenceStore: EvidenceStore;
  projectId: string;
  projectRoot: string;
  objective: string;
  budgetLedger?: BudgetLedger;
  contextLimits?: ContextLimits;
  outputTokenReserve?: number;
  modelCostEstimators?: ReadonlyMap<string, ModelCostEstimator>;
  modelCostBases?: ReadonlyMap<string, ModelCostBasisSnapshot>;
  clock?: () => string;
  permissionProfile?: PermissionProfile;
  ledger?: ToolInvocationLedger;
  permissions?: SqlitePermissionStore;
  browserBackend?: BrowserBackend;
  mcpManager?: McpManager;
  runPolicy?: NativeBuildRunPolicy;
}

export class NativeArchitectRuntime implements ArchitectRuntimeDriver {
  private readonly clock: () => string;
  private readonly candidateById: Map<string, AgentRuntimeCandidate>;

  constructor(private readonly options: NativeArchitectRuntimeOptions) {
    this.clock = options.clock ?? (() => new Date().toISOString());
    this.candidateById = new Map(
      options.candidates.map((candidate) => [candidate.runtimeId, candidate])
    );
  }

  async run(request: ArchitectActionRequest): Promise<void> {
    this.ensureInitialized(request.runId);
    let projection = rebuildSchedulerProjection(
      this.options.schedulerStore.readRun(request.runId)
    );
    let runtimeId = projection.runtime.architect.runtimeId;
    if (!runtimeId) {
      this.options.router.confirmArchitectHandoff(
        this.options.initialRuntimeId,
        ["code"]
      );
      this.options.schedulerStore.append({
        runId: request.runId,
        type: "architect.runtime_assigned",
        occurredAt: this.clock(),
        actor: { role: "user", id: "local-user" },
        idempotencyKey: "architect-runtime:initial",
        payload: { runtimeId: this.options.initialRuntimeId },
      });
      runtimeId = this.options.initialRuntimeId;
      projection = rebuildSchedulerProjection(
        this.options.schedulerStore.readRun(request.runId)
      );
    }
    const model = this.options.models.get(runtimeId);
    const candidate = this.candidateById.get(runtimeId);
    if (!model || !candidate) {
      this.requireHandoff(request.runId, `runtime unavailable: ${runtimeId}`, ["code"], runtimeId);
      return;
    }
    const context = await this.context(request, projection);
    const sessionId = `architect:${request.runId}`;
    let messages: AgentMessage[] = [
      {
        id: "architect-system",
        role: "system",
        content: [
          "You are the AIBoard Architect. Use one native lifecycle tool for the requested decision.",
          "A resumed action reflects current runner state; retry the semantically correct lifecycle tool when an earlier mechanical error may have been repaired.",
          "Do not invent replacement tasks or unrelated lifecycle operations merely to route around a kernel error.",
        ].join("\n"),
      },
    ];
    if (this.options.sessions.events(sessionId).length === 0) {
      await this.options.sessions.create({
        sessionId,
        runId: request.runId,
        actor: { role: "architect", id: request.context.actor.id },
        occurredAt: this.clock(),
      });
    } else {
      const recovered = await this.options.sessions.load(sessionId);
      if (recovered.checkpoint) messages = [...recovered.checkpoint.messages];
    }
    const contextMessage: AgentMessage = {
      id: `context:${context.digest}`,
      role: "user",
      content: context.text,
    };
    if (!messages.some((message) => message.id === contextMessage.id)) {
      messages.push(contextMessage);
    } else {
      const reminder: AgentMessage = {
        id: `action-resume:${projection.lastSequence}`,
        role: "user",
        content: [
          "Resume the current Architect action from the runner's current durable state.",
          "Earlier mechanical tool errors may have been resolved since the prior attempt.",
          "Re-evaluate the requested action and invoke exactly one semantically appropriate lifecycle tool; do not substitute prose or an unrelated lifecycle operation.",
          `Current action: ${JSON.stringify(request.reason)}`,
        ].join("\n"),
      };
      if (!messages.some((message) => message.id === reminder.id)) {
        messages.push(reminder);
      }
    }
    const extras = new ToolBroker({
      permissionProfile: this.options.permissionProfile ?? "project",
      workspacePath: this.options.projectRoot,
      artifacts: this.options.artifacts,
      ...(this.options.ledger ? { ledger: this.options.ledger } : {}),
      ...(this.options.permissions
        ? { approve: (approval) => this.options.permissions!.requestTool(approval) }
        : {}),
    });
    for (const tool of createFilesystemTools({ artifacts: this.options.artifacts })) {
      if (tool.definition.readOnly) extras.register(tool);
    }
    for (const tool of createArtifactTools(this.options.artifacts)) extras.register(tool);
    for (const tool of createSessionTools(this.options.sessions)) extras.register(tool);
    for (const tool of createGitTools()) {
      if (tool.definition.readOnly) extras.register(tool);
    }
    for (const tool of createEvidenceTools({
      store: this.options.evidenceStore,
      artifacts: this.options.artifacts,
      taskId: "architect",
      clock: this.clock,
    })) {
      if (tool.definition.name === "inspect_evidence") extras.register(tool);
    }
    for (const tool of createSkillTools(this.options.skillCatalog)) extras.register(tool);
    for (const tool of createMemoryTools({
      store: this.options.memoryStore,
      projectId: this.options.projectId,
      runId: request.runId,
      clock: this.clock,
    })) extras.register(tool);
    for (const tool of createResearchTools({ artifacts: this.options.artifacts })) {
      extras.register(tool);
    }
    if (this.options.browserBackend) {
      for (const tool of createBrowserTools({
        backend: this.options.browserBackend,
        artifacts: this.options.artifacts,
        evidenceStore: this.options.evidenceStore,
        taskId: "architect",
        clock: this.clock,
      })) extras.register(tool);
    }
    if (this.options.mcpManager) {
      for (const tool of createMcpTools(this.options.mcpManager, this.options.artifacts)) {
        extras.register(tool);
      }
    }
    const inspectionTools = this.options.runPolicy === "plan_only"
      ? new PlanOnlyInspectionRuntime(extras)
      : extras;
    const layeredTools = new LayeredToolRuntime(request.tools, inspectionTools);
    const tools = this.options.budgetLedger
      ? new BudgetedToolRuntime({
          runtime: layeredTools,
          ledger: this.options.budgetLedger,
          scopeId: request.runId,
          clock: this.clock,
        })
      : layeredTools;
    const runtimeModel = this.options.budgetLedger
      ? new BudgetedAgentModel({
          model,
          ledger: this.options.budgetLedger,
          scopeId: request.runId,
          attribution: architectModelAttribution(candidate, sessionId),
          outputTokenReserve: this.options.outputTokenReserve ?? 16_384,
          estimateCostMicros: this.options.modelCostEstimators?.get(runtimeId),
          costBasis: this.options.modelCostBases?.get(runtimeId),
          clock: this.clock,
        })
      : model;
    const result = await runAgentLoop({
      model: runtimeModel,
      registry: tools,
      context: { ...request.context, workspacePath: this.options.projectRoot },
      initialMessages: messages,
      onCheckpoint: async (checkpoint) => {
        await this.options.sessions.checkpoint(sessionId, checkpoint, this.clock());
      },
    });
    if (result.status === "architect_action") {
      this.options.health.recordSuccess(candidate.providerId);
      this.persistHealth(request.runId, candidate.providerId);
      return;
    }
    if (result.status === "suspended" && result.reason === "provider_error") {
      this.options.sessions.suspend(
        sessionId,
        result.reason,
        result.error,
        this.clock()
      );
      const failure = classifyProviderFailure({
        ...result.providerError,
        message: result.error ?? "Architect provider failed.",
      });
      this.options.health.recordFailure(candidate.providerId, failure);
      this.persistHealth(request.runId, candidate.providerId);
      this.requireHandoff(request.runId, failure.message, ["code"], runtimeId);
      return;
    }
    const reason =
      result.status === "suspended"
        ? `${result.reason}:${result.error ?? ""}`
        : `unexpected_architect_lifecycle:${result.status}`;
    this.options.schedulerStore.append({
      runId: request.runId,
      type: "run.paused",
      occurredAt: this.clock(),
      actor: { role: "runner", id: "native-architect-runtime" },
      idempotencyKey: `architect-pause:${projection.lastSequence}`,
      payload: { reason },
    });
  }

  private ensureInitialized(runId: string): void {
    if (this.options.schedulerStore.readRun(runId).length > 0) return;
    this.options.schedulerStore.append({
      runId,
      type: "run.initialized",
      occurredAt: this.clock(),
      actor: { role: "runner", id: "native-architect-runtime" },
      idempotencyKey: "run-initialized",
      payload: {},
    });
  }

  private requireHandoff(
    runId: string,
    reason: string,
    requiredCapabilities: string[],
    failedRuntimeId: string
  ): void {
    const handoff = this.options.router.selectArchitectHandoff(
      requiredCapabilities,
      new Set([failedRuntimeId])
    );
    const candidateRuntimeIds = [
      failedRuntimeId,
      ...handoff.candidates.map((candidate) => candidate.runtimeId),
    ];
    this.options.schedulerStore.append({
      runId,
      type: "architect.handoff_required",
      occurredAt: this.clock(),
      actor: { role: "runner", id: "runtime-router" },
      idempotencyKey: `architect-handoff:${this.options.schedulerStore.readRun(runId).length + 1}`,
      payload: {
        reason,
        requiredCapabilities,
        candidateRuntimeIds,
      },
    });
  }

  private persistHealth(runId: string, providerId: string): void {
    const count = this.options.schedulerStore
      .readRun(runId)
      .filter((event) => event.type === "provider.health_changed").length;
    this.options.schedulerStore.append({
      runId,
      type: "provider.health_changed",
      occurredAt: this.clock(),
      actor: { role: "runner", id: "runtime-router" },
      idempotencyKey: `provider-health:${providerId}:${count + 1}`,
      payload: { state: this.options.health.get(providerId) },
    });
  }

  private async context(
    request: ArchitectActionRequest,
    projection: ReturnType<typeof rebuildSchedulerProjection>
  ) {
    const [instructions, metadata] = await Promise.all([
      discoverProjectInstructions({ projectRoot: this.options.projectRoot }),
      this.options.skillCatalog.discover(),
    ]);
    const skills = await Promise.all(metadata.slice(0, 5).map((skill) =>
      this.options.skillCatalog.read(skill.id)
    ));
    const memories = this.options.memoryStore.search({
      projectId: this.options.projectId,
      query: JSON.stringify(request.reason),
      limit: 20,
    });
    const evidence: PromptEvidence[] = this.options.evidenceStore
      .list({ runId: request.runId, limit: 1_000 })
      .map((record) => ({
        id: record.id,
        summary: `${record.taskId}: ${evidenceFactSummary(record.fact)}`,
        artifactHashes: evidenceFactArtifactHashes(record.fact),
      }));
    return buildArchitectContext({
      limits: this.options.contextLimits ?? {
        maxBytes: 512 * 1024,
        maxEstimatedTokens: 128 * 1024,
      },
      objective: this.options.objective,
      reason: request.reason,
      projection,
      instructions,
      skills,
      memories,
      evidence,
      recentHistory: [],
    });
  }
}

export function architectModelAttribution(
  candidate: AgentRuntimeCandidate,
  sessionId: string
): ModelCallAttribution {
  return {
    runtimeId: candidate.runtimeId,
    providerId: candidate.providerId,
    modelId: candidate.modelId,
    role: "architect",
    sessionId,
  };
}

export class PlanOnlyInspectionRuntime implements AgentToolRuntime {
  private readonly allowed: ReadonlySet<string>;

  constructor(private readonly runtime: AgentToolRuntime) {
    this.allowed = new Set(
      runtime.definitions()
        .filter((definition) => definition.readOnly && definition.effect !== "workspace")
        .map((definition) => definition.name)
    );
  }

  definitions() {
    return this.runtime.definitions().filter((definition) => this.allowed.has(definition.name));
  }

  isLifecycleTool(name: string): boolean {
    return this.allowed.has(name) && this.runtime.isLifecycleTool(name);
  }

  isReadOnlyTool(name: string): boolean {
    return this.allowed.has(name) && this.runtime.isReadOnlyTool(name);
  }

  assertUniqueCallIds(calls: readonly ToolCallBlock[], seen: ReadonlySet<string>): void {
    this.runtime.assertUniqueCallIds(calls, seen);
  }

  async invoke(call: ToolCallBlock, context: ToolExecutionContext): Promise<ToolResult> {
    if (this.allowed.has(call.name)) return await this.runtime.invoke(call, context);
    return {
      callId: call.callId,
      toolName: call.name,
      content: [{ type: "text", text: `Tool ${call.name} is unavailable in Plan-only.` }],
      isError: true,
      error: {
        code: "plan_only_tool_denied",
        message: `Tool ${call.name} is unavailable in Plan-only.`,
      },
    };
  }
}

class LayeredToolRuntime implements AgentToolRuntime {
  private readonly owner = new Map<string, AgentToolRuntime>();

  constructor(...layers: AgentToolRuntime[]) {
    for (const layer of layers) {
      for (const definition of layer.definitions()) {
        if (this.owner.has(definition.name)) {
          throw new Error(`Duplicate layered tool ${definition.name}.`);
        }
        this.owner.set(definition.name, layer);
      }
    }
  }

  definitions() {
    return [...this.owner.entries()]
      .map(([name, owner]) => owner.definitions().find((item) => item.name === name)!)
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  isLifecycleTool(name: string): boolean {
    return this.owner.get(name)?.isLifecycleTool(name) ?? false;
  }

  isReadOnlyTool(name: string): boolean {
    return this.owner.get(name)?.isReadOnlyTool(name) ?? false;
  }

  assertUniqueCallIds(calls: readonly ToolCallBlock[], seen: ReadonlySet<string>): void {
    const current = new Set<string>();
    for (const call of calls) {
      if (!call.callId || seen.has(call.callId) || current.has(call.callId)) {
        throw new AgentProtocolError("duplicate_call_id", `Tool call ID ${call.callId} was already used.`);
      }
      current.add(call.callId);
    }
  }

  async invoke(call: ToolCallBlock, context: ToolExecutionContext): Promise<ToolResult> {
    const owner = this.owner.get(call.name);
    if (owner) return await owner.invoke(call, context);
    return {
      callId: call.callId,
      toolName: call.name,
      content: [{ type: "text", text: `Tool ${call.name} is not registered.` }],
      isError: true,
      error: { code: "unknown_tool", message: `Tool ${call.name} is not registered.` },
    };
  }
}
