import { createHash } from "node:crypto";

import { withLanguageAgentLifecycle } from "./language-agent-lifecycle.js";
import { withMcpAgentLifecycle } from "./mcp-agent-lifecycle.js";
import type { ExecutionGrantAuthority } from "./execution-grants.js";
import type { RunGitExecutionContext } from "./git-run-context.js";
import type {
  AgentMessage,
  AgentModel,
  NativeTool,
  ToolCallBlock,
  ToolExecutionContext,
  ToolResult,
} from "./agent-contracts.js";
import {
  runAgentLoop,
  type AgentProviderRetryEvent,
} from "./agent-loop.js";
import {
  buildArchitectContext,
  architectContextSections,
  type ArchitectReviewSubmission,
  type PromptEvidence,
} from "./agent-prompts.js";
import { evidenceFactArtifactHashes, evidenceFactSummary } from "./evidence-store.js";
import type { ArtifactStore } from "./artifact-store.js";
import { createArtifactTools } from "./artifact-tools.js";
import { createBrowserTools, type BrowserBackend } from "./browser-tools.js";
import { createCodeIntelligenceTools } from "./code-intelligence-tools.js";
import type {
  BudgetLedger,
  ModelCallAttribution,
  ModelCostBasisSnapshot,
} from "./budget-ledger.js";
import { BudgetedAgentModel, type ModelCostEstimator } from "./budgeted-model.js";
import { BudgetedToolRuntime } from "./budgeted-tool-runtime.js";
import type {
  ArchitectActionReason,
  ArchitectActionRequest,
  ArchitectRuntimeDriver,
} from "./build-runtime.js";
import { ContextAssembler, type ContextLimits } from "./context-assembler.js";
import { recordContextPack, type ContextManifestStore } from "./context-manifest-store.js";
import type { CapabilityRegistry } from "./capability-registry.js";
import type { EvidenceStore } from "./evidence-store.js";
import { createEvidenceTools } from "./evidence-tools.js";
import { createFilesystemTools } from "./filesystem-tools.js";
import { createGitTools } from "./git-tools.js";
import { createMemoryTools } from "./memory-tools.js";
import { resolveWorkerSessionId, standardWorkerId } from "./worker-identity.js";
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
import { rankSkillsForTask } from "./skill-routing.js";
import { createSkillTools } from "./skill-tools.js";
import { createResearchTools } from "./research-tools.js";
import { RepositoryIntelligence } from "./repository-intelligence.js";
import { createSessionTools } from "./session-tools.js";
import {
  assertArchitectInspectionMcpClass,
  assertRoleToolSurface,
  isCatalogToolName,
  isMcpToolName,
  mcpToolAdmitted,
  roleToolSurface,
  staticToolAdmitted,
} from "./role-capabilities.js";
import { ToolBroker } from "./tool-broker.js";
import { TypeScriptIntelligence } from "./typescript-intelligence.js";
import type { LanguageIntelligenceProvider } from "./language-intelligence.js";
import {
  assembleContextWithExtensions,
  registerExtensionCapabilities,
} from "./extension-runtime.js";
import type { OneShotCommandExecutor } from "./one-shot-command-executor.js";
import type { ToolInvocationLedger } from "./tool-ledger.js";
import {
  AgentProtocolError,
  ToolRegistry,
  type AgentToolRuntime,
} from "./tool-registry.js";
import type {
  RunnerProviderRetryRuntime,
} from "./provider-call-retry.js";

export interface NativeArchitectRuntimeOptions {
  git?: RunGitExecutionContext;
  executionGrants?: ExecutionGrantAuthority;
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
  canonicalProjectRoot?: string;
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
  allowedCommands?: readonly string[];
  hiddenPaths?: readonly string[];
  protectedPaths?: readonly string[];
  capabilityRegistry?: CapabilityRegistry;
  language?: LanguageIntelligenceProvider;
  providerRetryRuntime?: RunnerProviderRetryRuntime;
  contextManifests?: ContextManifestStore;
  recordContextPackText?: boolean;
  /** Disposable copy for `run_evidence_command`. Absent means the tool is absent. */
  commandWorkspace?: ArchitectCommandWorkspaceProvider;
  execution?: OneShotCommandExecutor;
}

export interface ArchitectCommandWorkspaceProvider {
  readonly workspaceKind: "independent-verifier";
  create(targetRevision: string): Promise<{ readonly path: string }>;
  cleanup(): Promise<void>;
}

export class NativeArchitectRuntime implements ArchitectRuntimeDriver {
  private static readonly DEFAULT_CONTEXT_LIMITS: ContextLimits = {
    maxBytes: 512 * 1024,
    maxEstimatedTokens: 128 * 1024,
  };
  private readonly clock: () => string;
  private readonly candidateById: Map<string, AgentRuntimeCandidate>;
  private architectCommandCopyOpen = false;

  constructor(private readonly options: NativeArchitectRuntimeOptions) {
    this.clock = options.clock ?? (() => new Date().toISOString());
    this.candidateById = new Map(
      options.candidates.map((candidate) => [candidate.runtimeId, candidate])
    );
  }

  private get contextLimits(): ContextLimits {
    return this.options.contextLimits ?? NativeArchitectRuntime.DEFAULT_CONTEXT_LIMITS;
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
    await recordContextPack({
      store: this.options.contextManifests,
      artifacts: this.options.artifacts,
      recordPackText: this.options.recordContextPackText,
      runId: request.runId,
      sessionId,
      actor: { role: "architect", id: candidate.runtimeId },
      role: "architect",
      purpose: `architect:${request.reason.type}`,
      ...("taskId" in request.reason ? { taskId: request.reason.taskId } : {}),
      repositoryRevision: projection.integrationRevision,
      limits: this.contextLimits,
      pack: context,
      recordedAt: this.clock(),
    });
    let messages: AgentMessage[] = [
      {
        id: "architect-system",
        role: "system",
        content: [
          "You are the AIBoard Architect. End each action with exactly one decision tool. write_project_doc does not end the action; call it (alone in its turn) as many times as needed before the decision tool.",
          "You may run commands only in the disposable copy created for this turn, never in the user's project. On review_required the copy is the submission's taskRevision; on every other turn it is the integration revision.",
          "The immutable initial objective is the permanent user authority: guidance may augment its scope but must never replace or rewrite it.",
          "For user_guidance_required, acknowledge the exact guidance with acknowledge_user_guidance. Use no_plan_change only for evidence-proven semantic equivalence supported by authoritative durable evidence IDs; otherwise reconcile the plan, including newTasks when guidance adds real scope.",
          "Use ask_user only for a genuine authority decision, destructive action, unresolved requirement conflict, unavailable external dependency, requested control weakening, or exhausted governed repair budget. Routine technical problems must be resolved autonomously.",
          "A resumed action reflects current runner state; retry the semantically correct lifecycle tool when an earlier mechanical error may have been repaired.",
          "Do not invent replacement tasks or unrelated lifecycle operations merely to route around a kernel error.",
          "When current evidence proves that a planned task is already satisfied or its assumptions are stale, reconcile the Architect-owned plan: cancel or revise that task and rewire its pending dependents. Do not require a fabricated code change merely because a task exists.",
          "When a legacy in-flight run requires an acceptance-contract upgrade, record criteria for every non-cancelled task with upgrade_acceptance_contract before reviewing or completing work.",
          "A satisfied criterion verdict may cite a command that did not exit 0 only with an explicit acceptedFailures entry naming that evidence ID and a rationale, for example an intentionally failing pre-fix test. Otherwise mark the criterion unsatisfied.",
          "A guidance request of kind replan means the worker cannot complete the task within its objective. Either reconcile the plan with reconcile_plan (cancel or revise that task, add replacement tasks) or refuse with answer_guidance citing evidence; never leave a replan request open.",
          "When final verification planning is requested, inspect the canonical repository state and use plan_final_verification with an explicit build, tests, runtime_smoke, and browser plan.",
          "When final verification review is requested, inspect the exact current submission and persisted category evidence, then use review_final_verification with one semantic rationale per category plus an explicit low/high Architect risk declaration and rationale. Require repair when the evidence does not support approval, and declare high risk whenever semantic concerns exceed the kernel-observed paths and effects.",
          "When final verification repairs are requested, use plan_verification_repairs to create narrowly scoped ordinary tasks whose provenance and acceptance criteria cover every failed category exactly once.",
          "When plan critique resolution is requested, read every blocking finding, inspect the baseline repository where a finding cites files, then call resolve_plan_critique exactly once: reconcile the plan for findings you accept (cancel, revise, or add tasks in one planReconciliation) and reject the rest with evidence-based rationale.",
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
          "Re-evaluate the requested action. End each action with exactly one decision tool. write_project_doc does not end the action; call it (alone in its turn) as many times as needed before the decision tool. Do not substitute prose or an unrelated lifecycle operation.",
          `Current action: ${JSON.stringify(request.reason)}`,
        ].join("\n"),
      };
      if (!messages.some((message) => message.id === reminder.id)) {
        messages.push(reminder);
      }
    }
    const commandRevision = this.architectCommandRevision(
      await this.architectCommandCheckoutRevision(request, projection),
    );
    try {
    const extras = createArchitectInspectionBroker({
      git: this.options.git,
      executionGrants: this.options.executionGrants,
      permissionProfile: this.options.permissionProfile ?? "project",
      projectRoot: this.options.projectRoot,
      artifacts: this.options.artifacts,
      sessions: this.options.sessions,
      evidenceStore: this.options.evidenceStore,
      skillCatalog: this.options.skillCatalog,
      memoryStore: this.options.memoryStore,
      projectId: this.options.projectId,
      runId: request.runId,
      clock: this.clock,
      ...(this.options.ledger ? { ledger: this.options.ledger } : {}),
      ...(this.options.permissions ? { permissions: this.options.permissions } : {}),
      ...(this.options.hiddenPaths ? { hiddenPaths: this.options.hiddenPaths } : {}),
      ...(this.options.protectedPaths ? { protectedPaths: this.options.protectedPaths } : {}),
      ...(this.options.browserBackend ? { browserBackend: this.options.browserBackend } : {}),
      ...(this.options.mcpManager ? { mcpManager: this.options.mcpManager } : {}),
      ...(this.options.language ? { language: this.options.language } : {}),
    });
    if (this.options.capabilityRegistry) {
      registerExtensionCapabilities(this.options.capabilityRegistry, extras, {
        includeTool: ({ tool }) =>
          tool.definition.readOnly === true && tool.definition.effect === "none",
      });
    }
    const inspectionTools = this.options.runPolicy === "plan_only"
      ? new PlanOnlyInspectionRuntime(extras)
      : commandRevision
        ? composeArchitectInspection(extras, new LazyArchitectCommandRuntime(
            () => this.openArchitectCommandCopy(commandRevision),
            {
              projectRoot: this.options.projectRoot,
              permissionProfile: this.options.permissionProfile ?? "project",
              artifacts: this.options.artifacts,
              evidenceStore: this.options.evidenceStore,
              clock: this.clock,
              ...(this.options.git ? { git: this.options.git } : {}),
              ...(this.options.executionGrants ? { executionGrants: this.options.executionGrants } : {}),
              ...(this.options.ledger ? { ledger: this.options.ledger } : {}),
              ...(this.options.permissions ? { permissions: this.options.permissions } : {}),
              ...(this.options.execution ? { execution: this.options.execution } : {}),
              ...(this.options.allowedCommands ? { allowedCommands: this.options.allowedCommands } : {}),
            },
          ))
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
    const result = await withLanguageAgentLifecycle(this.options.language, request.context, () => withMcpAgentLifecycle(this.options.mcpManager, request.context, () => runAgentLoop({
      model: runtimeModel,
      registry: tools,
      context: {
        ...request.context,
        workspacePath: architectInspectionWorkspace(
          request.reason,
          projection,
          this.options.projectRoot,
          this.options.canonicalProjectRoot,
        ),
      },
      initialMessages: messages,
      signal: request.context.signal,
      providerRetry: {
        runtimeId: candidate.runtimeId,
        providerId: candidate.providerId,
        modelId: candidate.modelId,
        deadlineMs: request.providerRetryDeadlineMs,
        classify: classifyProviderFailure,
        onRetry: (event) => this.persistProviderRetry(request.runId, event),
        ...(this.options.providerRetryRuntime
          ? {
              now: this.options.providerRetryRuntime.now,
              random: this.options.providerRetryRuntime.random,
              sleep: this.options.providerRetryRuntime.sleep,
            }
          : {}),
      },
      onCheckpoint: async (checkpoint) => {
        await this.options.sessions.checkpoint(sessionId, checkpoint, this.clock());
      },
    })));
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
    if (
      result.status === "suspended" &&
      result.reason === "cancelled" &&
      Object.values(
        rebuildSchedulerProjection(
          this.options.schedulerStore.readRun(request.runId)
        ).userGuidance
      ).some((guidance) => guidance.status === "submitted")
    ) {
      return;
    }
    const reason =
      result.status === "suspended"
        ? result.reason === "protocol_error"
          ? `${result.reason}:${result.errorCode ?? "protocol_error"}:${result.error ?? ""}`
          : `${result.reason}:${result.error ?? ""}`
        : `unexpected_architect_lifecycle:${result.status}`;
    this.options.schedulerStore.append({
      runId: request.runId,
      type: "run.paused",
      occurredAt: this.clock(),
      actor: { role: "runner", id: "native-architect-runtime" },
      idempotencyKey: `architect-pause:${projection.lastSequence}`,
      payload: { reason },
    });
    } finally {
      await this.closeArchitectCommandCopy();
    }
  }

  /**
   * review_required checks out the submission's taskRevision.
   * Every other reason checks out the integration revision.
   * A missing review revision is an error, never a fallback to integration.
   */
  private async architectCommandCheckoutRevision(
    request: ArchitectActionRequest,
    projection: ReturnType<typeof rebuildSchedulerProjection>,
  ): Promise<string | undefined> {
    if (request.reason.type !== "review_required") return projection.integrationRevision;
    const submission = await loadArchitectReviewSubmission(
      this.options.sessions,
      request.runId,
      request.reason,
      projection,
    );
    if (!submission?.taskRevision) {
      throw new Error("Review command copy requires the submission task revision.");
    }
    return submission.taskRevision;
  }

  /** Lists the command tool without creating a worktree. Creation waits for the first call. */
  private architectCommandRevision(revision: string | undefined): string | undefined {
    const provider = this.options.commandWorkspace;
    if (!provider || this.options.runPolicy === "plan_only") return undefined;
    if (provider.workspaceKind !== "independent-verifier") {
      throw new Error("Architect command workspace must be an independent verifier workspace.");
    }
    if (!revision || !/^[a-f0-9]{40,64}$/.test(revision)) return undefined;
    return revision;
  }

  private async openArchitectCommandCopy(revision: string): Promise<string> {
    const provider = this.options.commandWorkspace;
    if (!provider) throw new Error("Architect command workspace is unavailable.");
    if (provider.workspaceKind !== "independent-verifier") {
      throw new Error("Architect command workspace must be an independent verifier workspace.");
    }
    const workspace = await provider.create(revision);
    if (!workspace?.path) throw new Error("Architect command copy was not created.");
    this.architectCommandCopyOpen = true;
    return workspace.path;
  }

  private async closeArchitectCommandCopy(): Promise<void> {
    if (!this.architectCommandCopyOpen) return;
    this.architectCommandCopyOpen = false;
    await this.options.commandWorkspace?.cleanup();
  }

  private ensureInitialized(runId: string): void {
    const events = this.options.schedulerStore.readRun(runId);
    if (events.length > 0) {
      const durableObjective = rebuildSchedulerProjection(events).initialObjective;
      if (
        durableObjective !== undefined &&
        durableObjective !== this.options.objective
      ) {
        throw new Error(
          "The durable initial objective does not match the native Architect configuration."
        );
      }
      return;
    }
    this.options.schedulerStore.append({
      runId,
      type: "run.initialized",
      occurredAt: this.clock(),
      actor: { role: "runner", id: "native-architect-runtime" },
      idempotencyKey: "run-initialized",
      payload: { objective: this.options.objective },
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

  private persistProviderRetry(
    runId: string,
    event: AgentProviderRetryEvent
  ): void {
    this.options.schedulerStore.append({
      runId,
      type: "provider.retry_scheduled",
      occurredAt: this.clock(),
      actor: { role: "runner", id: "native-architect-runtime" },
      idempotencyKey: [
        "provider-retry",
        event.runtimeId,
        event.sessionId,
        event.turn,
        event.retry,
      ].join(":"),
      payload: { ...event },
    });
  }

  private async context(
    request: ArchitectActionRequest,
    projection: ReturnType<typeof rebuildSchedulerProjection>
  ) {
    const reviewSubmission = await this.reviewSubmission(request, projection);
    const projectDocsStateText = await this.loadCommittedStateText(request.runId, projection);
    const [instructions, metadata] = await Promise.all([
      discoverProjectInstructions({ projectRoot: this.options.projectRoot }),
      this.options.skillCatalog.discover(),
    ]);
    const relevantTasks = Object.values(projection.tasks).filter(
      (task) => task.status !== "integrated" && task.status !== "cancelled"
    );
    const requiredCapabilities = prioritizedArchitectCapabilities(
      request.reason,
      relevantTasks
    );
    const rankedSkills = rankSkillsForTask(
      metadata,
      `${this.options.objective}\n${JSON.stringify(request.reason)}`,
      requiredCapabilities,
      5
    );
    const skills = await Promise.all(rankedSkills.map((skill) =>
      this.options.skillCatalog.read(skill.id)
    ));
    const memories = this.options.memoryStore.search({
      projectId: this.options.projectId,
      query: JSON.stringify(request.reason),
      limit: 20,
    });
    const focusedWorkerId = reviewSubmission
      ? projection.tasks[reviewSubmission.taskId]?.assignedWorkerId
      : undefined;
    const evidence: PromptEvidence[] = this.options.evidenceStore
      .list({
        runId: request.runId,
        ...(reviewSubmission ? { taskId: reviewSubmission.taskId } : {}),
        limit: 1_000,
      })
      .filter(
        (record) =>
          !reviewSubmission ||
          !focusedWorkerId ||
          record.actor.id === focusedWorkerId ||
          (record.actor.role === "subagent" &&
            record.actor.id.startsWith(`${focusedWorkerId}:`))
      )
      .map((record) => ({
        id: record.id,
        summary: `${record.taskId}: ${evidenceFactSummary(record.fact)}`,
        artifactHashes: evidenceFactArtifactHashes(record.fact),
      }));
    const limits = this.contextLimits;
    const input = {
      limits,
      objective: this.options.objective,
      reason: request.reason,
      projection,
      ...(reviewSubmission ? { reviewSubmission } : {}),
      instructions,
      skills,
      memories,
      evidence,
      recentHistory: [],
      ...(projectDocsStateText !== undefined ? { projectDocsStateText } : {}),
    };
    if (!this.options.capabilityRegistry) return buildArchitectContext(input);
    return (await assembleContextWithExtensions({
      registry: this.options.capabilityRegistry,
      assembler: new ContextAssembler(limits),
      baseSections: architectContextSections(input),
      request: {
        runId: request.runId,
        sessionId: request.context.sessionId,
        actor: request.context.actor,
        objective: this.options.objective,
        workspacePath: request.context.workspacePath ?? architectInspectionWorkspace(
          request.reason,
          projection,
          this.options.projectRoot,
          this.options.canonicalProjectRoot,
        ),
        ...("taskId" in request.reason ? { taskId: request.reason.taskId } : {}),
        signal: request.context.signal ?? new AbortController().signal,
      },
      artifacts: this.options.artifacts,
    })).pack;
  }

  private async loadCommittedStateText(
    runId: string,
    projection: ReturnType<typeof rebuildSchedulerProjection>,
  ): Promise<string | undefined> {
    const latest = [...(projection.projectDocs?.committed ?? [])]
      .filter((commit) => commit.path === "docs/project/STATE.md")
      .sort((left, right) => left.sequence - right.sequence)
      .at(-1);
    if (!latest) return undefined;
    const requested = this.options.schedulerStore.readRun(runId).find((event) =>
      event.type === "project_doc.requested" && event.payload.requestId === latest.requestId
    );
    const hash = requested?.payload.contentArtifactHash;
    if (typeof hash !== "string") return undefined;
    try {
      const bytes = await this.options.artifacts.get(hash);
      if (createHash("sha256").update(bytes).digest("hex") !== hash) return undefined;
      return bytes.toString("utf8");
    } catch {
      return undefined;
    }
  }

  private async reviewSubmission(
    request: ArchitectActionRequest,
    projection: ReturnType<typeof rebuildSchedulerProjection>
  ): Promise<ArchitectReviewSubmission | undefined> {
    return await loadArchitectReviewSubmission(
      this.options.sessions,
      request.runId,
      request.reason,
      projection
    );
  }
}

export async function loadArchitectReviewSubmission(
  sessions: Pick<SqliteAgentSessionStore, "load">,
  runId: string,
  reason: ArchitectActionReason,
  projection: ReturnType<typeof rebuildSchedulerProjection>
): Promise<ArchitectReviewSubmission | undefined> {
  if (reason.type !== "review_required") return undefined;
  const task = projection.tasks[reason.taskId];
  if (!task) throw new Error(`Unknown review task ${reason.taskId}.`);
  const sessionId = resolveWorkerSessionId(
    runId,
    task.id,
    task.attempt,
    task.assignedWorkerId ?? standardWorkerId(task.id, task.attempt),
    projection.runtime.workerAssignments[`${task.id}:${task.attempt}`]?.sessionId
  );
  const session = await sessions.load(sessionId);
  const changeSet = session.changeSet;
  if (!changeSet || changeSet.id !== reason.changeSetId) {
    throw new Error(
      `Submitted change set ${reason.changeSetId} is unavailable for review.`
    );
  }
  return {
    taskId: task.id,
    attempt: task.attempt,
    changeSetId: changeSet.id,
    baselineRevision: changeSet.baselineRevision,
    taskRevision: changeSet.taskRevision,
    changedPaths: [...changeSet.changedPaths],
    diffArtifactHash: changeSet.diffArtifactHash,
    evidenceArtifactHashes: [...changeSet.evidenceArtifactHashes],
    ...(changeSet.acceptanceCriteria
      ? { acceptanceCriteria: changeSet.acceptanceCriteria.map((criterion) => ({ ...criterion })) }
      : {}),
    ...(changeSet.acceptanceCriteriaVersion !== undefined
      ? { acceptanceCriteriaVersion: changeSet.acceptanceCriteriaVersion }
      : {}),
    ...(changeSet.criterionEvidenceLinks
      ? {
          criterionEvidenceLinks: changeSet.criterionEvidenceLinks.map((link) => ({
            ...link,
            artifactHashes: [...link.artifactHashes],
          })),
        }
      : {}),
  };
}

export function architectInspectionWorkspace(
  reason: ArchitectActionReason,
  projection: ReturnType<typeof rebuildSchedulerProjection>,
  projectRoot: string,
  canonicalProjectRoot?: string,
): string {
  if (reason.type === "review_required") {
    return projection.tasks[reason.taskId]?.workspacePath?.trim() || projectRoot;
  }
  if (
    reason.type === "final_verification_plan_required" ||
    reason.type === "final_verification_review_required" ||
    reason.type === "final_verification_repair_plan_required" ||
    reason.type === "verifier_repair_plan_required" ||
    reason.type === "plan_critique_resolution_required"
  ) {
    return canonicalProjectRoot?.trim() || projectRoot;
  }
  return projectRoot;
}

export function prioritizedArchitectCapabilities(
  reason: ArchitectActionReason,
  tasks: readonly {
    id: string;
    requiredCapabilities: readonly string[];
  }[]
): string[] {
  const focusedTaskId = "taskId" in reason ? reason.taskId : undefined;
  const focused = focusedTaskId
    ? tasks.find((task) => task.id === focusedTaskId)?.requiredCapabilities ?? []
    : [];
  const broader = tasks
    .filter((task) => task.id !== focusedTaskId)
    .flatMap((task) => task.requiredCapabilities);
  return [...new Set([...focused, ...broader])];
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

export interface ArchitectInspectionBrokerInput {
  git?: RunGitExecutionContext;
  executionGrants?: ExecutionGrantAuthority;
  permissionProfile: PermissionProfile;
  projectRoot: string;
  artifacts: ArtifactStore;
  sessions: SqliteAgentSessionStore;
  evidenceStore: EvidenceStore;
  skillCatalog: SkillCatalog;
  memoryStore: ProjectMemoryStore;
  projectId: string;
  runId: string;
  clock: () => string;
  ledger?: ToolInvocationLedger;
  permissions?: SqlitePermissionStore;
  hiddenPaths?: readonly string[];
  protectedPaths?: readonly string[];
  browserBackend?: BrowserBackend;
  mcpManager?: McpManager;
  language?: LanguageIntelligenceProvider;
  /** Unlisted tools registered before the allow-list assert, so a missing assert fails open. */
  probeTools?: readonly NativeTool<unknown>[];
}

/** Correct wiring returns the disposable copy. `projectRoot` is the prove-red target. */
export function architectCommandWorkspacePath(disposablePath: string, projectRoot: string): string {
  void projectRoot;
  return disposablePath;
}

export interface ArchitectCommandBrokerInput {
  disposablePath: string;
  projectRoot: string;
  permissionProfile: PermissionProfile;
  artifacts: ArtifactStore;
  evidenceStore: EvidenceStore;
  clock: () => string;
  git?: RunGitExecutionContext;
  executionGrants?: ExecutionGrantAuthority;
  ledger?: ToolInvocationLedger;
  permissions?: SqlitePermissionStore;
  execution?: OneShotCommandExecutor;
  allowedCommands?: readonly string[];
  /** Test double. Production uses `run_evidence_command` from `createEvidenceTools`. */
  commandTool?: NativeTool<unknown>;
}

export function createArchitectCommandBroker(input: ArchitectCommandBrokerInput): ToolBroker {
  const workspacePath = architectCommandWorkspacePath(input.disposablePath, input.projectRoot);
  const broker = new ToolBroker({
    ...(input.git ? { git: input.git } : {}),
    ...(input.executionGrants ? { executionGrants: input.executionGrants } : {}),
    permissionProfile: input.permissionProfile,
    workspacePath,
    artifacts: input.artifacts,
    clock: input.clock,
    ...(input.ledger ? { ledger: input.ledger } : {}),
    ...(input.permissions
      ? { approve: (approval) => input.permissions!.requestTool(approval) }
      : {}),
  });
  const tool = input.commandTool ?? evidenceCommandTool(createEvidenceTools({
    ...(input.git ? { git: input.git } : {}),
    store: input.evidenceStore,
    artifacts: input.artifacts,
    taskId: "architect",
    clock: input.clock,
    ...(input.execution ? { execution: input.execution } : {}),
    ...(input.allowedCommands ? { allowedCommands: input.allowedCommands } : {}),
  }));
  if (tool.definition.name !== "run_evidence_command") {
    throw new Error("Architect command broker only registers run_evidence_command.");
  }
  if (!staticToolAdmitted("architect", "inspection", tool.definition.name)) {
    throw new Error("Architect command tool is not on the inspection allow-list.");
  }
  broker.register(tool);
  return broker;
}

/** Lists `run_evidence_command` immediately and creates the disposable copy on first execute. */
class LazyArchitectCommandRuntime implements AgentToolRuntime {
  private opening: Promise<ToolBroker> | undefined;
  private readonly listing = new ToolRegistry();
  private readonly input: Omit<ArchitectCommandBrokerInput, "disposablePath">;

  constructor(
    private readonly openCopy: () => Promise<string>,
    input: Omit<ArchitectCommandBrokerInput, "disposablePath">,
  ) {
    const tool = input.commandTool ?? evidenceCommandTool(createEvidenceTools({
      ...(input.git ? { git: input.git } : {}),
      store: input.evidenceStore,
      artifacts: input.artifacts,
      taskId: "architect",
      clock: input.clock,
      ...(input.execution ? { execution: input.execution } : {}),
      ...(input.allowedCommands ? { allowedCommands: input.allowedCommands } : {}),
    }));
    this.input = { ...input, commandTool: tool };
    this.listing.register(tool);
  }

  definitions() {
    return this.listing.definitions();
  }

  isLifecycleTool(name: string): boolean {
    return this.listing.isLifecycleTool(name);
  }

  isReadOnlyTool(name: string): boolean {
    return this.listing.isReadOnlyTool(name);
  }

  assertUniqueCallIds(calls: readonly ToolCallBlock[], seen: ReadonlySet<string>): void {
    this.listing.assertUniqueCallIds(calls, seen);
  }

  async invoke(call: ToolCallBlock, context: ToolExecutionContext): Promise<ToolResult> {
    let broker: ToolBroker;
    try {
      broker = await this.ensureBroker();
    } catch (error) {
      const message = error instanceof Error
        ? error.message
        : "Architect command copy could not be created.";
      return {
        callId: call.callId,
        toolName: call.name,
        content: [{ type: "text", text: message }],
        isError: true,
        error: { code: "command_workspace_unavailable", message },
      };
    }
    return await broker.invoke(call, context);
  }

  private ensureBroker(): Promise<ToolBroker> {
    this.opening ??= this.openCopy().then((disposablePath) =>
      createArchitectCommandBroker({ ...this.input, disposablePath }),
    );
    return this.opening;
  }
}

export function composeArchitectInspection(
  reads: AgentToolRuntime,
  command: AgentToolRuntime,
): AgentToolRuntime {
  const composed = new LayeredToolRuntime(reads, command);
  assertArchitectInspectionMcpClass(composed.definitions());
  assertRoleToolSurface(
    "architect",
    "inspection",
    composed.definitions().map((definition) => definition.name),
  );
  return composed;
}

function evidenceCommandTool(tools: readonly NativeTool<unknown>[]): NativeTool<unknown> {
  const tool = tools.find((candidate) => candidate.definition.name === "run_evidence_command");
  if (!tool) throw new Error("Evidence tools did not include run_evidence_command.");
  return tool;
}

export function createArchitectInspectionBroker(input: ArchitectInspectionBrokerInput): ToolBroker {
  const broker = new ToolBroker({
    git: input.git,
    executionGrants: input.executionGrants,
    permissionProfile: input.permissionProfile,
    workspacePath: input.projectRoot,
    artifacts: input.artifacts,
    ...(input.ledger ? { ledger: input.ledger } : {}),
    ...(input.permissions
      ? { approve: (approval) => input.permissions!.requestTool(approval) }
      : {}),
  });
  const repository = new RepositoryIntelligence(input.git ? (request) => input.git!.current().run(request) : undefined);
  const language = input.language ?? new TypeScriptIntelligence(repository);
  registerAdmitted(broker, createFilesystemTools({
    artifacts: input.artifacts,
    repository,
    ...(input.hiddenPaths ? { hiddenPaths: input.hiddenPaths } : {}),
    ...(input.protectedPaths ? { protectedPaths: input.protectedPaths } : {}),
  }));
  registerAdmitted(broker, createCodeIntelligenceTools({ repository, language }));
  registerAdmitted(broker, createArtifactTools(input.artifacts));
  registerAdmitted(broker, createSessionTools(input.sessions));
  registerAdmitted(broker, createGitTools(input.git));
  registerAdmitted(broker, createEvidenceTools({
    git: input.git,
    store: input.evidenceStore,
    artifacts: input.artifacts,
    taskId: "architect",
    clock: input.clock,
  }));
  registerAdmitted(broker, createSkillTools(input.skillCatalog));
  registerAdmitted(broker, createMemoryTools({
    store: input.memoryStore,
    projectId: input.projectId,
    runId: input.runId,
    clock: input.clock,
  }));
  registerAdmitted(broker, createResearchTools({ artifacts: input.artifacts }));
  if (input.browserBackend) {
    registerAdmitted(broker, createBrowserTools({
      backend: input.browserBackend,
      artifacts: input.artifacts,
      evidenceStore: input.evidenceStore,
      taskId: "architect",
      clock: input.clock,
    }));
  }
  if (input.mcpManager) {
    const policy = roleToolSurface("architect", "inspection").mcpPolicy;
    for (const tool of createMcpTools(input.mcpManager, input.artifacts)) {
      if (mcpToolAdmitted(policy, tool.definition)) broker.register(tool);
    }
  }
  for (const tool of input.probeTools ?? []) broker.register(tool);
  assertArchitectInspectionMcpClass(broker.definitions());
  assertRoleToolSurface(
    "architect",
    "inspection",
    broker.definitions().map((definition) => definition.name),
  );
  return broker;
}

function registerAdmitted(broker: ToolBroker, tools: readonly NativeTool<unknown>[]): void {
  for (const tool of tools) {
    if (tool.definition.name === "run_evidence_command") continue;
    if (staticToolAdmitted("architect", "inspection", tool.definition.name)) broker.register(tool);
  }
}

export class PlanOnlyInspectionRuntime implements AgentToolRuntime {
  private readonly allowed: ReadonlySet<string>;

  constructor(
    private readonly runtime: AgentToolRuntime,
    options?: { readonly probeToolNames?: readonly string[] },
  ) {
    const probe = new Set(options?.probeToolNames ?? []);
    const policy = roleToolSurface("architect", "planOnly").mcpPolicy;
    const admitted = new Set<string>();
    const staticAdmitted: string[] = [];
    for (const definition of runtime.definitions()) {
      if (isMcpToolName(definition.name)) {
        if (mcpToolAdmitted(policy, definition)) admitted.add(definition.name);
        continue;
      }
      if (staticToolAdmitted("architect", "planOnly", definition.name)) {
        admitted.add(definition.name);
        staticAdmitted.push(definition.name);
        continue;
      }
      if (
        !isCatalogToolName(definition.name) &&
        definition.readOnly === true &&
        definition.effect !== "workspace"
      ) {
        admitted.add(definition.name);
      }
    }
    for (const name of probe) {
      admitted.add(name);
      staticAdmitted.push(name);
    }
    assertRoleToolSurface("architect", "planOnly", staticAdmitted);
    this.allowed = admitted;
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
