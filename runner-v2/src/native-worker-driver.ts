import type { AgentMessage, AgentModel } from "./agent-contracts.js";
import type {
  AgentProviderRetryEvent,
  AgentSuspensionReason,
} from "./agent-loop.js";
import {
  buildWorkerContext,
  workerContextSections,
  type PromptEvidence,
} from "./agent-prompts.js";
import { evidenceFactArtifactHashes, evidenceFactSummary } from "./evidence-store.js";
import type { ArtifactStore } from "./artifact-store.js";
import type {
  BudgetLedger,
  ModelCallAttribution,
  ModelCallRole,
  ModelCostBasisSnapshot,
} from "./budget-ledger.js";
import type { BrowserBackend } from "./browser-tools.js";
import type { McpManager } from "./mcp-tools.js";
import type { SqlitePermissionStore } from "./permission-store.js";
import type { ManagedProcessService } from "./managed-process.js";
import { BudgetedAgentModel, type ModelCostEstimator } from "./budgeted-model.js";
import { ContextAssembler, type ContextLimits } from "./context-assembler.js";
import { recordContextPack, type ContextManifestStore } from "./context-manifest-store.js";
import type { CapabilityRegistry } from "./capability-registry.js";
import type { PermissionProfile } from "./contracts.js";
import type { EvidenceStore } from "./evidence-store.js";
import { assembleContextWithExtensions } from "./extension-runtime.js";
import { requireGitRunner } from "./git-command.js";
import type { RunGitExecutionContext } from "./git-run-context.js";
import type { GitRunner } from "./git-repository.js";
import type { ProjectMemoryStore } from "./project-memory.js";
import { discoverProjectInstructions } from "./project-context.js";
import {
  classifyProviderFailure,
  type ProviderFailure,
  type ProviderHealthRegistry,
} from "./provider-health.js";
import type { RuntimeRouter, AgentRuntimeCandidate } from "./runtime-router.js";
import type { SchedulerProjection, SchedulerStore } from "./scheduler-store.js";
import { rebuildSchedulerProjection } from "./scheduler-store.js";
import type { SqliteAgentSessionStore } from "./sqlite-agent-session-store.js";
import type { SkillCatalog, SkillDocument, SkillMetadata } from "./skill-catalog.js";
import { rankSkillsForTask } from "./skill-routing.js";
import type {
  WorkerAssignment,
  WorkerOutcome,
  WorkerRuntimeDriver,
} from "./task-scheduler.js";
import type { ToolInvocationLedger } from "./tool-ledger.js";
import type { WorkspaceManager } from "./workspace-manager.js";
import { runWorkerTask } from "./worker-runtime.js";
import { resolveWorkerSessionId } from "./worker-identity.js";
import type { LanguageIntelligenceProvider } from "./language-intelligence.js";
import type { OneShotCommandExecutor } from "./one-shot-command-executor.js";
import type { ExecutionGrantAuthority } from "./execution-grants.js";
import type {
  RunnerProviderRetryRuntime,
} from "./provider-call-retry.js";

export interface NativeWorkerDriverOptions {
  git?: RunGitExecutionContext;
  schedulerStore: SchedulerStore;
  router: RuntimeRouter;
  health: ProviderHealthRegistry;
  candidates: readonly AgentRuntimeCandidate[];
  models: ReadonlyMap<string, AgentModel>;
  permissionProfile: PermissionProfile;
  workspaceManager: WorkspaceManager;
  artifacts: ArtifactStore;
  ledger: ToolInvocationLedger;
  sessions: SqliteAgentSessionStore;
  evidenceStore: EvidenceStore;
  skillCatalog: SkillCatalog;
  memoryStore: ProjectMemoryStore;
  projectId: string;
  projectRoot: string;
  budgetLedger?: BudgetLedger;
  browserBackend?: BrowserBackend;
  mcpManager?: McpManager;
  permissions?: SqlitePermissionStore;
  managedProcesses?: ManagedProcessService;
  contextLimits?: ContextLimits;
  outputTokenReserve?: number;
  modelCostEstimators?: ReadonlyMap<string, ModelCostEstimator>;
  modelCostBases?: ReadonlyMap<string, ModelCostBasisSnapshot>;
  clock?: () => string;
  allowedCommands?: readonly string[];
  hiddenPaths?: readonly string[];
  protectedPaths?: readonly string[];
  providerRetryRuntime?: RunnerProviderRetryRuntime;
  capabilityRegistry?: CapabilityRegistry;
  language?: LanguageIntelligenceProvider;
  execution?: OneShotCommandExecutor;
  executionGrants?: ExecutionGrantAuthority;
  contextManifests?: ContextManifestStore;
  recordContextPackText?: boolean;
}

export function buildWorkerSystemPrompt(criterionIds: readonly string[] = []): string {
  return [
    "You are an AIBoard native worker. Use tools and finish with submit_task.",
    "Batch independent read-only tool calls in one turn when that reduces model round trips.",
    "Keep command output narrow: prefer native search/read tools and targeted ranges over broad file dumps.",
    "`docs/project/**` is maintained only by the Architect. Do not edit it; a change there makes your submission fail integration. Put decisions or state worth recording in your submit_task summary.",
    "Before every submit_task, record task-relevant durable evidence. Use run_evidence_command for command facts; browser snapshot, screenshot, and events tools record browser facts automatically. The Architect decides whether the evidence is sufficient.",
    ...(criterionIds.length > 0
      ? [
          `Submit one criterionEvidenceLinks entry for every acceptance criterion (${criterionIds.join(", ")}). Cite the durable evidence ID and only its recorded artifact hashes; the runner binds the mapping to this task attempt.`,
        ]
      : []),
    "Do not submit while your own fresh evidence still shows a known acceptance failure. Continue fixing it; if you are mechanically blocked or the intended resolution is unclear, use ask_architect instead of submitting a known-bad changeset.",
  ].join("\n");
}

export class NativeWorkerDriver implements WorkerRuntimeDriver {
  private readonly candidateById: Map<string, AgentRuntimeCandidate>;
  private readonly clock: () => string;
  private readonly contextLimits: ContextLimits;

  constructor(private readonly options: NativeWorkerDriverOptions) {
    this.candidateById = new Map(
      options.candidates.map((candidate) => [candidate.runtimeId, candidate])
    );
    this.clock = options.clock ?? (() => new Date().toISOString());
    this.contextLimits = options.contextLimits ?? {
      maxBytes: 256 * 1024,
      maxEstimatedTokens: 64 * 1024,
    };
  }

  async run(assignment: WorkerAssignment): Promise<WorkerOutcome> {
    let lifecycleContinuations = 0;
    const persistedAssignment = this.persistedRuntimeAssignment(assignment);
    let runtimeId = persistedAssignment?.runtimeId;
    const sessionId = resolveWorkerSessionId(
      assignment.runId,
      assignment.task.id,
      assignment.attempt,
      assignment.workerId,
      persistedAssignment?.sessionId
    );
    if (!runtimeId) {
      const selection = this.options.router.selectWorker(
        assignment.task.requiredCapabilities
      );
      if (selection.status === "unavailable") {
        return { type: "paused", reason: "no_healthy_capability_match" };
      }
      runtimeId = selection.runtime.runtimeId;
      this.assignRuntime(assignment, runtimeId, sessionId);
    }

    for (;;) {
      const model = this.options.models.get(runtimeId);
      const candidate = this.candidateById.get(runtimeId);
      if (!model || !candidate) {
        return { type: "paused", reason: `runtime_unavailable:${runtimeId}` };
      }
      const workspace = await this.options.workspaceManager.createTaskWorkspace(
        assignment.task.id,
        {
          workspaceId:
            assignment.task.workspaceId ?? assignment.task.id,
          ...(assignment.task.workspaceBaselineRevision
            ? { baselineRevision: assignment.task.workspaceBaselineRevision }
            : {}),
        }
      );
      const context = await this.workerContext(
        assignment,
        workspace.path,
        sessionId,
      );
      const repositoryRevision = /^HEAD ([0-9a-f]{40,64})/.exec(context.repositorySnapshot)?.[1];
      await recordContextPack({
        store: this.options.contextManifests,
        artifacts: this.options.artifacts,
        recordPackText: this.options.recordContextPackText,
        runId: assignment.runId,
        sessionId,
        actor: { role: "worker", id: assignment.workerId },
        role: "worker",
        purpose: "worker:task",
        taskId: assignment.task.id,
        attempt: assignment.attempt,
        ...(repositoryRevision ? { repositoryRevision } : {}),
        limits: this.contextLimits,
        pack: context.pack,
        recordedAt: this.clock(),
      });
      const sessionEventCount = this.options.sessions.events(sessionId).length;
      const toolEventCountBefore = this.options.ledger
        .listRun(assignment.runId)
        .filter((entry) => entry.sessionId === sessionId).length;
      const budgetedModel = this.options.budgetLedger
        ? new BudgetedAgentModel({
            model,
            ledger: this.options.budgetLedger,
            scopeId: assignment.runId,
            attribution: workerModelAttribution(
              candidate,
              sessionId,
              assignment.task.id,
              "worker"
            ),
            outputTokenReserve: this.options.outputTokenReserve ?? 16_384,
            estimateCostMicros: this.options.modelCostEstimators?.get(runtimeId),
            costBasis: this.options.modelCostBases?.get(runtimeId),
            clock: this.clock,
          })
        : model;
      const result = await runWorkerTask({
        model: budgetedModel,
        ...(this.options.budgetLedger
          ? {
              subagentModelForSession: (subagentSessionId: string) =>
                new BudgetedAgentModel({
                  model,
                  ledger: this.options.budgetLedger!,
                  scopeId: assignment.runId,
                  attribution: workerModelAttribution(
                    candidate,
                    subagentSessionId,
                    assignment.task.id,
                    "subagent"
                  ),
                  outputTokenReserve: this.options.outputTokenReserve ?? 16_384,
                  estimateCostMicros: this.options.modelCostEstimators?.get(
                    candidate.runtimeId
                  ),
                  costBasis: this.options.modelCostBases?.get(candidate.runtimeId),
                  clock: this.clock,
                }),
            }
          : {}),
        runId: assignment.runId,
        sessionId,
        taskId: assignment.task.id,
        ...(assignment.task.acceptanceCriteria
          ? { acceptanceCriteria: assignment.task.acceptanceCriteria }
          : {}),
        ...(assignment.task.acceptanceCriteriaVersion !== undefined
          ? { acceptanceCriteriaVersion: assignment.task.acceptanceCriteriaVersion }
          : {}),
        attempt: assignment.attempt,
        actorId: assignment.workerId,
        permissionProfile: this.options.permissionProfile,
        workspace,
        workspaceManager: this.options.workspaceManager,
        artifacts: this.options.artifacts,
        ledger: this.options.ledger,
        sessions: this.options.sessions,
        ...(this.options.budgetLedger
          ? { budgetLedger: this.options.budgetLedger }
          : {}),
        schedulerStore: this.options.schedulerStore,
        evidenceStore: this.options.evidenceStore,
        skillCatalog: this.options.skillCatalog,
        memoryStore: this.options.memoryStore,
        projectId: this.options.projectId,
        initialMessages: [
          {
            id: "worker-system",
            role: "system",
            content: buildWorkerSystemPrompt(
              assignment.task.acceptanceCriteria?.map((criterion) => criterion.id) ?? [],
            ),
          },
        ],
        providerRetry: {
          runtimeId: candidate.runtimeId,
          providerId: candidate.providerId,
          modelId: candidate.modelId,
          deadlineMs: assignment.providerRetryDeadlineMs,
          classify: classifyProviderFailure,
          onRetry: (event) => this.persistProviderRetry(
            assignment.runId,
            event
          ),
          ...(this.options.providerRetryRuntime
            ? {
                now: this.options.providerRetryRuntime.now,
                random: this.options.providerRetryRuntime.random,
                sleep: this.options.providerRetryRuntime.sleep,
              }
            : {}),
        },
        signal: assignment.signal,
        continuationMessages: workerContinuationMessages(
          {
            id: `context:${context.pack.digest}`,
            role: "user",
            content: context.pack.text,
          },
          sessionEventCount > 0,
          assignment.task.id,
          sessionEventCount
        ),
        clock: this.clock,
        ...(this.options.allowedCommands
          ? { allowedCommands: this.options.allowedCommands }
          : {}),
        ...(this.options.hiddenPaths ? { hiddenPaths: this.options.hiddenPaths } : {}),
        ...(this.options.protectedPaths ? { protectedPaths: this.options.protectedPaths } : {}),
        ...(this.options.browserBackend
          ? { browserBackend: this.options.browserBackend }
          : {}),
        ...(this.options.mcpManager ? { mcpManager: this.options.mcpManager } : {}),
        ...(this.options.permissions ? { permissions: this.options.permissions } : {}),
        ...(this.options.managedProcesses
          ? { managedProcesses: this.options.managedProcesses }
          : {}),
        ...(this.options.execution ? { execution: this.options.execution } : {}),
        ...(this.options.git ? { git: this.options.git } : {}),
        ...(this.options.executionGrants
          ? { executionGrants: this.options.executionGrants }
          : {}),
        ...(this.options.capabilityRegistry
          ? { capabilityRegistry: this.options.capabilityRegistry }
          : {}),
        ...(this.options.language ? { language: this.options.language } : {}),
      });
      if (result.loop.status === "submitted") {
        this.recordSuccess(assignment.runId, candidate.providerId);
        return {
          type: "submitted",
          changeSetId: result.loop.changeSetId,
          ...(result.changeSet?.criterionEvidenceLinks
            ? {
                criterionEvidenceLinks: result.changeSet.criterionEvidenceLinks.map((link) => ({
                  ...link,
                  artifactHashes: [...link.artifactHashes],
                })),
              }
            : {}),
        };
      }
      if (result.loop.status === "waiting_for_architect") {
        return guidanceOutcomeFromProjection(
          rebuildSchedulerProjection(this.options.schedulerStore.readRun(assignment.runId)),
          result.loop.requestId,
        );
      }
      if (result.loop.status === "replan_requested") {
        return guidanceOutcomeFromProjection(
          rebuildSchedulerProjection(this.options.schedulerStore.readRun(assignment.runId)),
          result.loop.requestId,
        );
      }
      if (
        result.loop.status === "suspended" &&
        result.loop.reason === "provider_error"
      ) {
        const failure = classifyProviderFailure({
          ...result.loop.providerError,
          message: result.loop.error ?? "Provider failed.",
        });
        this.options.health.recordFailure(candidate.providerId, failure);
        this.persistHealth(assignment.runId, candidate.providerId);
        if (!shouldFailoverWorkerFailure(failure)) {
          return {
            type: "failed",
            reason: `provider_${failure.kind}:${failure.message}`,
          };
        }
        const selection = this.options.router.selectWorker(
          assignment.task.requiredCapabilities,
          new Set([runtimeId])
        );
        if (selection.status === "unavailable") {
          return { type: "paused", reason: "all_worker_runtimes_unavailable" };
        }
        runtimeId = selection.runtime.runtimeId;
        this.assignRuntime(assignment, runtimeId, sessionId);
        continue;
      }
      if (result.loop.status === "suspended") {
        if (
          shouldAutoContinueWorker(
            result.loop.reason,
            lifecycleContinuations,
            this.options.ledger
              .listRun(assignment.runId)
              .filter((entry) => entry.sessionId === sessionId).length >
              toolEventCountBefore
          )
        ) {
          lifecycleContinuations += 1;
          continue;
        }
        const recoverable = recoverableWorkerSuspension(
          result.loop.reason,
          result.loop.error
        );
        if (recoverable) return recoverable;
      }
      return {
        type: "failed",
        reason:
          result.loop.status === "suspended"
            ? `${result.loop.reason}:${result.loop.error ?? ""}`
            : `unexpected_worker_lifecycle:${result.loop.status}`,
      };
    }
  }

  private persistedRuntimeAssignment(assignment: WorkerAssignment) {
    const events = this.options.schedulerStore.readRun(assignment.runId);
    if (events.length === 0) return undefined;
    return rebuildSchedulerProjection(events).runtime.workerAssignments[
      `${assignment.task.id}:${assignment.attempt}`
    ];
  }

  private assignRuntime(
    assignment: WorkerAssignment,
    runtimeId: string,
    sessionId: string
  ): void {
    const existingCount = this.options.schedulerStore
      .readRun(assignment.runId)
      .filter((event) => event.type === "worker.runtime_assigned").length;
    this.options.schedulerStore.append({
      runId: assignment.runId,
      type: "worker.runtime_assigned",
      occurredAt: this.clock(),
      actor: { role: "runner", id: "runtime-router" },
      idempotencyKey: `worker-runtime:${assignment.task.id}:${assignment.attempt}:${existingCount + 1}`,
      payload: {
        taskId: assignment.task.id,
        attempt: assignment.attempt,
        runtimeId,
        sessionId,
      },
    });
  }

  private recordSuccess(runId: string, providerId: string): void {
    this.options.health.recordSuccess(providerId);
    this.persistHealth(runId, providerId);
  }

  private persistHealth(runId: string, providerId: string): void {
    const state = this.options.health.get(providerId);
    const count = this.options.schedulerStore
      .readRun(runId)
      .filter((event) => event.type === "provider.health_changed").length;
    this.options.schedulerStore.append({
      runId,
      type: "provider.health_changed",
      occurredAt: this.clock(),
      actor: { role: "runner", id: "runtime-router" },
      idempotencyKey: `provider-health:${providerId}:${count + 1}`,
      payload: { state },
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
      actor: { role: "runner", id: "native-worker-driver" },
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

  private async workerContext(
    assignment: WorkerAssignment,
    workspacePath: string,
    sessionId: string,
  ) {
    const [instructions, skillMetadata, repositorySnapshot] = await Promise.all([
      discoverProjectInstructions({
        projectRoot: workspacePath,
        targetPath: workspacePath,
      }),
      this.options.skillCatalog.discover(),
      snapshotRepository(workspacePath, requireGitRunner(this.options.git).lifecycle("inspection").run),
    ]);
    const skills = await selectedSkills(
      this.options.skillCatalog,
      skillMetadata,
      assignment.task.objective,
      assignment.task.requiredCapabilities,
      3
    );
    const memories = this.options.memoryStore.search({
      projectId: this.options.projectId,
      query: assignment.task.objective,
      concepts: assignment.task.requiredCapabilities,
      limit: 10,
    });
    const projection = rebuildSchedulerProjection(
      this.options.schedulerStore.readRun(assignment.runId)
    );
    const guidance = Object.values(projection.guidance)
      .filter(
        (item) => item.taskId === assignment.task.id && item.status === "answered"
      )
      .map((item) => ({
        requestId: item.requestId,
        answer: item.answer ?? "",
        version: item.version,
      }));
    const evidence: PromptEvidence[] = this.options.evidenceStore
      .list({ runId: assignment.runId, taskId: assignment.task.id })
      .map((record) => ({
        id: record.id,
        summary: evidenceFactSummary(record.fact),
        artifactHashes: evidenceFactArtifactHashes(record.fact),
      }));
    const input = {
      limits: this.contextLimits,
      task: projection.tasks[assignment.task.id],
      guidance,
      instructions,
      skills,
      memories,
      repositorySnapshot,
      evidence,
      recentHistory: [],
    };
    if (!this.options.capabilityRegistry) {
      return { pack: buildWorkerContext(input), repositorySnapshot };
    }
    return {
      pack: (await assembleContextWithExtensions({
        registry: this.options.capabilityRegistry,
        assembler: new ContextAssembler(this.contextLimits),
        baseSections: workerContextSections(input),
        request: {
          runId: assignment.runId,
          sessionId,
          actor: { role: "worker", id: assignment.workerId },
          objective: assignment.task.objective,
          workspacePath,
          taskId: assignment.task.id,
          signal: assignment.signal ?? new AbortController().signal,
        },
        artifacts: this.options.artifacts,
      })).pack,
      repositorySnapshot,
    };
  }
}

export function workerModelAttribution(
  candidate: AgentRuntimeCandidate,
  sessionId: string,
  taskId: string,
  role: Extract<ModelCallRole, "worker" | "subagent">
): ModelCallAttribution {
  return {
    runtimeId: candidate.runtimeId,
    providerId: candidate.providerId,
    modelId: candidate.modelId,
    role,
    sessionId,
    taskId,
  };
}

export function recoverableWorkerSuspension(
  reason: AgentSuspensionReason,
  _error?: string
): WorkerOutcome | undefined {
  if (reason === "model_ended_without_lifecycle") {
    return {
      type: "paused",
      reason: "worker_model_ended_without_lifecycle",
    };
  }
  if (reason === "budget_exhausted") {
    return {
      type: "paused",
      reason: `budget_exhausted:${_error ?? "hard limit reached"}`,
    };
  }
  if (reason === "cancelled") {
    return { type: "paused", reason: "worker_cancelled" };
  }
  return undefined;
}

export function guidanceOutcomeFromProjection(
  projection: SchedulerProjection,
  requestId: string,
): WorkerOutcome {
  const guidance = projection.guidance[requestId];
  if (!guidance) return { type: "failed", reason: `missing_guidance:${requestId}` };
  return {
    type: "guidance",
    requestId: guidance.requestId,
    blocking: guidance.blocking,
    question: guidance.question,
    evidenceSequence: guidance.evidenceSequence,
  };
}

export function shouldAutoContinueWorker(
  reason: AgentSuspensionReason,
  continuations: number,
  madeToolProgress: boolean
): boolean {
  if (reason !== "model_ended_without_lifecycle") return false;
  return continuations < (madeToolProgress ? 5 : 1);
}

export function workerContinuationMessages(
  context: AgentMessage,
  resumed: boolean,
  taskId: string,
  resumeSequence: number
): AgentMessage[] {
  if (!resumed) return [context];
  return [
    context,
    {
      id: `worker-resume:${taskId}:${resumeSequence}`,
      role: "user",
      content: [
        "Resume the same durable task attempt with its existing workspace, tool results, and evidence.",
        "Do not repeat completed work. Inspect current state only as needed.",
        "Finish with submit_task when the task is ready; use ask_architect when an Architect decision is genuinely required; use request_replan when the task cannot be completed within its objective.",
        "Do not submit while your own fresh evidence still shows a known acceptance failure.",
      ].join("\n"),
    },
  ];
}

export function shouldFailoverWorkerFailure(failure: ProviderFailure): boolean {
  return failure.kind !== "invalid_request" && failure.kind !== "cancelled";
}

async function snapshotRepository(workspacePath: string, execute: GitRunner): Promise<string> {
  const [head, status] = await Promise.all([
    execute({ cwd: workspacePath, args: ["rev-parse", "HEAD"] }),
    execute({ cwd: workspacePath, args: ["status", "--porcelain=v1"] }),
  ]);
  return `HEAD ${head.stdout.trim()}\n${status.stdout || "working tree clean"}`;
}

async function selectedSkills(
  catalog: SkillCatalog,
  metadata: SkillMetadata[],
  objective: string,
  requiredCapabilities: readonly string[],
  limit: number
): Promise<SkillDocument[]> {
  const ranked = rankSkillsForTask(
    metadata,
    objective,
    requiredCapabilities,
    limit
  );
  return await Promise.all(ranked.map((skill) => catalog.read(skill.id)));
}
