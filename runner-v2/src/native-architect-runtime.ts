import type {
  AgentMessage,
  AgentModel,
  ToolCallBlock,
  ToolExecutionContext,
  ToolResult,
} from "./agent-contracts.js";
import { runAgentLoop } from "./agent-loop.js";
import { buildArchitectContext, type PromptEvidence } from "./agent-prompts.js";
import type { ArtifactStore } from "./artifact-store.js";
import type { BudgetLedger } from "./budget-ledger.js";
import { BudgetedAgentModel } from "./budgeted-model.js";
import type {
  ArchitectActionRequest,
  ArchitectRuntimeDriver,
} from "./build-runtime.js";
import type { ContextLimits } from "./context-assembler.js";
import type { EvidenceStore } from "./evidence-store.js";
import { createMemoryTools } from "./memory-tools.js";
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
import {
  AgentProtocolError,
  ToolRegistry,
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
  clock?: () => string;
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
    const extras = new ToolRegistry();
    for (const tool of createSkillTools(this.options.skillCatalog)) extras.register(tool);
    for (const tool of createMemoryTools({
      store: this.options.memoryStore,
      projectId: this.options.projectId,
      runId: request.runId,
      clock: this.clock,
    })) extras.register(tool);
    const tools = new LayeredToolRuntime(request.tools, extras);
    const runtimeModel = this.options.budgetLedger
      ? new BudgetedAgentModel({
          model,
          ledger: this.options.budgetLedger,
          scopeId: request.runId,
          outputTokenReserve: this.options.outputTokenReserve ?? 16_384,
          clock: this.clock,
        })
      : model;
    const result = await runAgentLoop({
      model: runtimeModel,
      registry: tools,
      context: request.context,
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
    if (handoff.candidates.length === 0) {
      this.options.schedulerStore.append({
        runId,
        type: "run.paused",
        occurredAt: this.clock(),
        actor: { role: "runner", id: "runtime-router" },
        idempotencyKey: `architect-unavailable:${this.options.schedulerStore.readRun(runId).length + 1}`,
        payload: {
          reason: "all_architect_runtimes_unavailable",
          providerFailure: reason,
          requiredCapabilities,
        },
      });
      return;
    }
    this.options.schedulerStore.append({
      runId,
      type: "architect.handoff_required",
      occurredAt: this.clock(),
      actor: { role: "runner", id: "runtime-router" },
      idempotencyKey: `architect-handoff:${this.options.schedulerStore.readRun(runId).length + 1}`,
      payload: {
        reason,
        requiredCapabilities,
        candidateRuntimeIds: handoff.candidates.map((candidate) => candidate.runtimeId),
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
        summary: `${record.taskId}: ${record.fact.command} exited ${record.fact.exitCode}`,
        artifactHashes: [record.fact.stdoutArtifactHash, record.fact.stderrArtifactHash],
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
