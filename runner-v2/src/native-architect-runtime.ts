import { createHash } from "node:crypto";

import { withLanguageAgentLifecycle } from "./language-agent-lifecycle.js";
import { withMcpAgentLifecycle } from "./mcp-agent-lifecycle.js";
import type { ExecutionGrantAuthority } from "./execution-grants.js";
import type { RunGitExecutionContext } from "./git-run-context.js";
import type {
  AgentMessage,
  AgentModel,
  ModelTurn,
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
  ARCHITECT_BASE_SNAPSHOT_SECTION_ID,
  architectBaseSnapshotEligible,
  buildArchitectContext,
  buildArchitectSystemPrompt,
  architectContextSections,
  type ArchitectBaseSnapshot,
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
  StopNotesOutcome,
  StopNotesRequest,
} from "./build-runtime.js";
import { ContextAssembler, type ContextLimits } from "./context-assembler.js";
import { currentSubmissionReview, deriveReviewTaskPrefill, type ReviewTaskPrefill } from "./delivery-acceptance.js";
import type { BuildTask } from "./task-contracts.js";
import { agreedValidationScope } from "./validation-scope.js";
import { HANDOFF_SNAPSHOT_NOTES_MAX_LENGTH } from "./handoff-snapshot.js";
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
import type { SchedulerProjection, SchedulerStore } from "./scheduler-store.js";
import { isPlanningState, rebuildSchedulerProjection } from "./scheduler-store.js";
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
  /**
   * T9 (EP41): the base revision for Architect command execution on the
   * answer path, where no integration revision exists yet. Production wires
   * the integration baseline; without it answer turns list no command tool.
   * Never used for plan_only runs (no execution there, before or after T9).
   */
  answerCommandRevision?: string;
  execution?: OneShotCommandExecutor;
  /**
   * C4 (AR-R11): live base-snapshot read for docs-v2 triage/planning turns.
   * Evaluated for each eligible context (never captured at construction):
   * the factory captures IntegrationManager.revision at call time and reads
   * `docs/project/STATE.md` from that immutable commit through the audited
   * Git path. Returns undefined when no snapshot is available; content null
   * labels an honestly missing or unreadable blob at a known revision.
   */
  readBaseSnapshot?: () => Promise<{ revision: string; content: string | null } | undefined>;
}

export interface ArchitectCommandWorkspaceProvider {
  readonly workspaceKind: "independent-verifier";
  create(targetRevision: string): Promise<{ readonly path: string }>;
  cleanup(): Promise<void>;
}

/** W3 (AR-3): runner-owned prefilled disposition for new-policy confirm/override turns, else {}. */
function architectDispositionPrefillSpread(
  projection: SchedulerProjection,
  task: BuildTask,
): { dispositionPrefill?: ReviewTaskPrefill } {
  if (projection.planningPolicyVersion !== 1) return {};
  const prefill = deriveReviewTaskPrefill({
    task: {
      id: task.id,
      attempt: task.attempt,
      changeSetId: task.changeSetId,
      acceptanceCriteria: task.acceptanceCriteria ?? [],
      criterionEvidenceLinks: task.criterionEvidenceLinks,
    },
    review: currentSubmissionReview(projection.delivery, task),
  });
  return prefill ? { dispositionPrefill: prefill } : {};
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
    // T10 (M1): the system prompt is built centrally so v1 keeps the exact
    // legacy lines (T9 NOTE-1 included) while v2 carries only the general
    // lines with per-reason guidance in the context section.
    let messages: AgentMessage[] = [
      {
        id: "architect-system",
        role: "system",
        content: buildArchitectSystemPrompt({
          planningPolicyVersion: projection.planningPolicyVersion,
          projectDocsPolicyVersion: projection.projectDocsPolicyVersion,
        }),
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
    // C4 (AR-R11): on docs-v2 runs, earlier context packs can carry snapshot
    // text into later requests. The fresh pack below carries the snapshot
    // exactly once on eligible turns and never otherwise, so stale
    // snapshot-bearing packs are dropped here. Tool results, assistant turns
    // and every other message survive untouched; v1 runs skip this entirely.
    if (projection.projectDocsPolicyVersion === 2) {
      messages = filterStaleBaseSnapshotPacks(messages);
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
    // T3a (OA-7/EP41): a new-policy run in planning state — no ready plan and
    // no triage `answer` — is refused Architect command execution at the tool
    // boundary, not only in the prompt. Legacy runs behave as today.
    let inspectionTools: AgentToolRuntime;
    if (this.options.runPolicy === "plan_only") {
      inspectionTools = new PlanOnlyInspectionRuntime(extras);
    } else if (isPlanningState(projection)) {
      inspectionTools = new PlanningStateInspectionRuntime(extras);
    } else if (commandRevision) {
      // T3a repair (N4): the command tool stays listed for the turn, but
      // every invoke re-reads the projection — losing readiness mid-turn
      // refuses run_evidence_command from that point on.
      inspectionTools = new PlanningStateCommandGuard(
        composeArchitectInspection(extras, new LazyArchitectCommandRuntime(
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
        )),
        () => rebuildSchedulerProjection(
          this.options.schedulerStore.readRun(request.runId),
        ),
      );
    } else {
      inspectionTools = extras;
    }
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
  /**
   * C3b (AR-R09): one bounded Architect stop-notes call for an eligible
   * stop. This is a single one-shot `complete()` on the run's Architect
   * runtime model -- never a normal Architect turn: no loop, no tools, no
   * session, no stop change. The cost records purpose `handoff_notes`
   * (EP40) through the shared context manifest and the shared budgeted
   * model; the caller persists the text as `handoff.notes_recorded` and
   * renders it through C1. Never throws: every failure is a `{failed}`
   * outcome so the stop snapshot still writes.
   */
  async requestStopNotes(input: StopNotesRequest): Promise<StopNotesOutcome> {
    const projection = rebuildSchedulerProjection(
      this.options.schedulerStore.readRun(input.runId)
    );
    const runtimeId = projection.runtime.architect.runtimeId ?? this.options.initialRuntimeId;
    const candidate = this.candidateById.get(runtimeId);
    const model = this.options.models.get(runtimeId);
    if (!candidate || !model) {
      return { status: "failed", reason: `no Architect runtime is available for stop notes (${boundStopNotesField(runtimeId, 100)})` };
    }
    const facts = buildStopNotesFacts({
      runId: input.runId,
      stopKind: input.stopKind,
      reason: input.reason,
      detail: input.detail,
      taskCount: Object.keys(projection.tasks ?? {}).length,
      planRevisionId: projection.planning?.plan?.currentRevisionId,
    });
    const limits = { maxBytes: 8192, maxEstimatedTokens: 2048 };
    const pack = new ContextAssembler(limits).assemble([
      { id: "stop-notes-facts", kind: "stop-notes", required: true, priority: 0, content: facts },
    ]);
    const sessionId = `architect-notes:${input.runId}:${input.stopSequence}`;
    try {
      await recordContextPack({
        store: this.options.contextManifests,
        artifacts: this.options.artifacts,
        recordPackText: this.options.recordContextPackText,
        runId: input.runId,
        sessionId,
        actor: { role: "architect", id: candidate.runtimeId },
        role: "architect",
        purpose: STOP_NOTES_CONTEXT_PURPOSE,
        repositoryRevision: projection.integrationRevision,
        limits,
        pack,
        recordedAt: this.clock(),
      });
    } catch (error) {
      return { status: "failed", reason: `stop notes context recording failed (${boundStopNotesField(error instanceof Error ? error.message : String(error), 200)})` };
    }
    const runtimeModel = this.options.budgetLedger
      ? new BudgetedAgentModel({
          model,
          ledger: this.options.budgetLedger,
          scopeId: input.runId,
          attribution: architectModelAttribution(candidate, sessionId),
          outputTokenReserve: STOP_NOTES_OUTPUT_TOKEN_RESERVE,
          estimateCostMicros: this.options.modelCostEstimators?.get(runtimeId),
          costBasis: this.options.modelCostBases?.get(runtimeId),
          clock: this.clock,
        })
      : model;
    const messages = buildStopNotesMessages(facts);
    let turn: ModelTurn;
    try {
      turn = await runtimeModel.complete({
        sessionId,
        messages,
        tools: [],
        toolChoice: "none",
        ...(input.signal ? { signal: input.signal } : {}),
      });
    } catch (error) {
      return { status: "failed", reason: `stop notes call failed (${boundStopNotesField(error instanceof Error ? error.message : String(error), 200)})` };
    }
    const notes = extractStopNotesText(turn);
    if (!notes) {
      return { status: "failed", reason: "the Architect returned no stop notes text" };
    }
    return { status: "noted", notes, runtimeId: candidate.runtimeId };
  }

  /**
  }

   * review_required checks out the submission's taskRevision.
   * Every other reason checks out the integration revision.
   * A missing review revision is an error, never a fallback to integration.
   */
  private async architectCommandCheckoutRevision(
    request: ArchitectActionRequest,
    projection: ReturnType<typeof rebuildSchedulerProjection>,
  ): Promise<string | undefined> {
    if (request.reason.type !== "review_required") {
      if (projection.integrationRevision) return projection.integrationRevision;
      // T9 (EP41 positive half): once triage is `answer` (not a planning
      // state), command execution is admitted against the answer-path base
      // revision — in a lazily created disposable copy only. Under `build`
      // without a ready plan and under `clarify` the run is in planning
      // state, so the inspection runtime refuses commands before this
      // matters; plan_only never reaches execution (architectCommandRevision
      // returns undefined there, before and after T9).
      if (
        projection.planningPolicyVersion === 1 &&
        projection.planningTriageDecision === "answer"
      ) {
        return this.options.answerCommandRevision?.trim()
          ? this.options.answerCommandRevision
          : undefined;
      }
      return undefined;
    }
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
    // C4 (AR-R11): docs v2 reads the existing STATE snapshot at the live base
    // revision on eligible turns only; every other policy keeps the exact
    // legacy artifact loader below. The v1 branch is frozen. The blob comes
    // from the audited immutable read at the captured revision — inherited
    // STATE or a later task integration — never the user's working tree, so
    // no snapshot-event gate stands between the read and the prompt. A known
    // revision with a missing blob renders its honest unavailable label.
    const docsV2 = projection.projectDocsPolicyVersion === 2;
    const baseSnapshot = docsV2 && architectBaseSnapshotEligible(request.reason, projection)
      ? await this.loadBaseSnapshot()
      : undefined;
    const projectDocsStateText = docsV2
      ? undefined
      : await this.loadCommittedStateText(request.runId, projection);
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
    // T10 (M11): the configured worker capability vocabulary (union over
    // candidates); rendered as a required section on docs-v2 turns only.
    const workerCapabilities = [...new Set(this.options.candidates.flatMap((candidate) => candidate.capabilities))];
    const input = {
      limits,
      objective: this.options.objective,
      reason: request.reason,
      projection,
      workerCapabilities,
      ...(reviewSubmission ? { reviewSubmission } : {}),
      ...(request.reason.type === "final_verification_plan_required" && request.reason.planPrefill ? { finalVerificationPrefill: request.reason.planPrefill } : {}),
      instructions,
      skills,
      memories,
      evidence,
      recentHistory: [],
      ...(projectDocsStateText !== undefined ? { projectDocsStateText } : {}),
      ...(baseSnapshot !== undefined ? { baseSnapshot } : {}),
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

  /**
   * C4 (AR-R11): read the docs-v2 base snapshot through the live factory
   * callback. Undefined when no bridge is wired or the read fails; a null
   * content labels an honestly missing or unreadable blob at its revision.
   */
  private async loadBaseSnapshot(): Promise<ArchitectBaseSnapshot | undefined> {
    if (!this.options.readBaseSnapshot) return undefined;
    try {
      return await this.options.readBaseSnapshot();
    } catch {
      return undefined;
    }
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
    ...architectDispositionPrefillSpread(projection, task),
    attempt: task.attempt,
    changeSetId: changeSet.id,
    baselineRevision: changeSet.baselineRevision,
    taskRevision: changeSet.taskRevision,
    changedPaths: [...changeSet.changedPaths],
    diffArtifactHash: changeSet.diffArtifactHash,
    evidenceArtifactHashes: [...changeSet.evidenceArtifactHashes],
    // IV-1 (F3): the durable scope rides the current submission beside
    // the prefill after bidirectional task/changeSet agreement, so the
    // Architect sees what was and was not validated. Ordering is not
    // authority; the scheduler-bound task copy stands after agreement.
    ...(agreedValidationScope(task.validationScope, changeSet.validationScope)
      ? { validationScope: agreedValidationScope(task.validationScope, changeSet.validationScope)! }
      : {}),
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

/**
 * C4 (AR-R11): drop recovered user context packs that carry a docs-v2 base
 * snapshot. Only `context:*` user messages whose text holds the snapshot
 * section marker match; tool results, assistant turns, reminders and legacy
 * packs are preserved untouched.
 */
function filterStaleBaseSnapshotPacks(messages: AgentMessage[]): AgentMessage[] {
  return messages.filter((message) =>
    message.role !== "user" ||
    !message.id.startsWith("context:") ||
    typeof message.content !== "string" ||
    !message.content.includes(ARCHITECT_BASE_SNAPSHOT_SECTION_ID)
  );
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
    reason.type === "plan_critique_resolution_required" ||
    // T6a: a failed boundary is judged on the integrated revision.
    reason.type === "delivery_boundary_failed"
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

/**
 * C3b (AR-R09, EP40): the context-manifest purpose every stop-notes model
 * pass records. The token cost rides along through the shared budgeted
 * model, exactly like every other Architect pass.
 */
export const STOP_NOTES_CONTEXT_PURPOSE = "handoff_notes";

/**
 * C3b: the budget reservation for one bounded stop-notes call. The notes
 * cap is 2000 characters (about 500 tokens), so this reserve bounds the
 * charge without starving the call.
 */
export const STOP_NOTES_OUTPUT_TOKEN_RESERVE = 2048;

/** C3b: bound one untrusted stop-notes field to a single capped line. */
export function boundStopNotesField(value: string, maxLength: number): string {
  return value
    .replace(/[\s\u0085]+/g, " ")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u2028\u2029]/g, "")
    .replace(/<!--/g, "&lt;!--")
    .replace(/-->/g, "--&gt;")
    .trim()
    .slice(0, maxLength);
}

/** C3b: the bounded actual run facts one stop-notes call may see. */
export function buildStopNotesFacts(input: {
  runId: string;
  stopKind: string;
  reason?: string;
  detail?: string;
  taskCount: number;
  planRevisionId?: string;
}): string {
  const lines = [
    `Run ${boundStopNotesField(input.runId, 100)} stopped (${boundStopNotesField(input.stopKind, 20)}${input.reason !== undefined ? `, reason: ${boundStopNotesField(input.reason, 200)}` : ""}).`,
  ];
  if (input.detail !== undefined && input.detail.trim()) {
    lines.push(`Detail: ${boundStopNotesField(input.detail, 200)}`);
  }
  lines.push(`Tasks recorded: ${Number.isSafeInteger(input.taskCount) && input.taskCount >= 0 ? input.taskCount : 0}.`);
  if (input.planRevisionId !== undefined && input.planRevisionId.trim()) {
    lines.push(`Plan revision: ${boundStopNotesField(input.planRevisionId, 100)}`);
  }
  return lines.join("\n");
}

/** C3b: the fixed short stop-notes prompt over bounded facts. No tools. */
export function buildStopNotesMessages(facts: string): AgentMessage[] {
  return [
    {
      id: "stop-notes-system",
      role: "system",
      content: "You are the AIBoard Architect writing stop notes for the next tool. In a few short lines record: notes for the next tool, what matters now, traps to avoid, and what to try next. Plain text only, no Markdown headings, no tool calls. Keep it under 1500 characters.",
    },
    {
      id: "stop-notes-facts",
      role: "user",
      content: facts,
    },
  ];
}

/**
 * C3b: the stop-notes text of one model turn: text blocks only, trimmed
 * and capped at the C1 notes bound. Tool calls (none are offered) and
 * non-text blocks never leak into the notes. Undefined when empty.
 */
export function extractStopNotesText(turn: ModelTurn): string | undefined {
  const text = turn.blocks
    .filter((block) => block.type === "text")
    .map((block) => (block as { text: string }).text)
    .join("\n")
    .trim();
  if (!text) return undefined;
  return text.length > HANDOFF_SNAPSHOT_NOTES_MAX_LENGTH
    ? text.slice(0, HANDOFF_SNAPSHOT_NOTES_MAX_LENGTH)
    : text;
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

/**
 * T3a (OA-7/EP41): the inspection surface for a new-policy run in planning
 * state. Full read-only inspection stays available; `run_evidence_command` is
 * neither listed nor invokable — forged calls are refused with
 * `planning_state_command_refused`, and no disposable copy is ever created.
 */
export class PlanningStateInspectionRuntime implements AgentToolRuntime {
  constructor(private readonly runtime: AgentToolRuntime) {}

  definitions() {
    return this.runtime.definitions().filter(
      (definition) => definition.name !== "run_evidence_command",
    );
  }

  isLifecycleTool(name: string): boolean {
    return name !== "run_evidence_command" && this.runtime.isLifecycleTool(name);
  }

  isReadOnlyTool(name: string): boolean {
    return name !== "run_evidence_command" && this.runtime.isReadOnlyTool(name);
  }

  assertUniqueCallIds(calls: readonly ToolCallBlock[], seen: ReadonlySet<string>): void {
    this.runtime.assertUniqueCallIds(calls, seen);
  }

  async invoke(call: ToolCallBlock, context: ToolExecutionContext): Promise<ToolResult> {
    if (call.name === "run_evidence_command") {
      return planningStateCommandRefused(call);
    }
    return await this.runtime.invoke(call, context);
  }
}

/**
 * T3a repair (N4): per-invoke planning-state gate for Architect turns that
 * started outside planning state. The command tool stays listed, but every
 * `run_evidence_command` invoke re-reads the durable projection and is
 * refused once the run has returned to planning state (e.g. readiness lost
 * mid-turn). All other tools delegate untouched.
 */
export class PlanningStateCommandGuard implements AgentToolRuntime {
  constructor(
    private readonly runtime: AgentToolRuntime,
    private readonly readProjection: () => SchedulerProjection,
  ) {}

  definitions() {
    return this.runtime.definitions();
  }

  isLifecycleTool(name: string): boolean {
    return this.runtime.isLifecycleTool(name);
  }

  isReadOnlyTool(name: string): boolean {
    return this.runtime.isReadOnlyTool(name);
  }

  assertUniqueCallIds(calls: readonly ToolCallBlock[], seen: ReadonlySet<string>): void {
    this.runtime.assertUniqueCallIds(calls, seen);
  }

  async invoke(call: ToolCallBlock, context: ToolExecutionContext): Promise<ToolResult> {
    if (call.name === "run_evidence_command" && isPlanningState(this.readProjection())) {
      return planningStateCommandRefused(call);
    }
    return await this.runtime.invoke(call, context);
  }
}

function planningStateCommandRefused(call: ToolCallBlock): ToolResult {
  const message =
    "Architect command execution is refused while the run is in planning state: " +
    "no ready plan exists and the triage decision is not answer.";
  return {
    callId: call.callId,
    toolName: call.name,
    content: [{ type: "text", text: message }],
    isError: true,
    error: { code: "planning_state_command_refused", message },
  };
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
