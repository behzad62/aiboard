import { isDeepStrictEqual } from "node:util";
import { canonicalModelIdentity } from "./verifier-contracts.js";
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
import { activeBrowserBackend, type BrowserBackend } from "./browser-tools.js";
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
import type { RuntimeRouter, AgentRuntimeCandidate, WorkerSelectionPreference } from "./runtime-router.js";
import type { SchedulerProjection, SchedulerStore } from "./scheduler-store.js";
import { rebuildSchedulerProjection, repairParentContractId, resolveTaskContractReference } from "./scheduler-store.js";
import type { ExecutionTaskContract } from "./planning-contracts.js";
import type { TaskContractRef } from "./task-contracts.js";
import type { SqliteAgentSessionStore } from "./sqlite-agent-session-store.js";
import type { SkillCatalog, SkillDocument, SkillMetadata } from "./skill-catalog.js";
import { rankSkillsForTask } from "./skill-routing.js";
import type {
  SettledWorkerOutcome,
  WorkerAssignment,
  WorkerOutcome,
  WorkerRuntimeDriver,
} from "./task-scheduler.js";
import { AgentCleanupUnverifiedError, errorMessage, isProcessStopUnprovenError, boundedText } from "./process-stop-proof.js";
import type { ToolInvocationLedger } from "./tool-ledger.js";
import { ForeignHistoryError, type TaskWorkspace, type WorkspaceManager } from "./workspace-manager.js";
import { runWorkerTask, workerSubmissionContext } from "./worker-runtime.js";
import type { ChangeSet } from "./change-set.js";
import {
  proveCliStop,
  cliAttemptRecords,
  cliHistoryRefusal,
  runCliWorkerAttempt,
  type CliWorkerRuntimeConfig,
  type CliWorkerRuntimeDeps,
} from "./cli-worker-runtime.js";
import {
  apiWorkerLabel,
  attemptRuntimeAssignments,
  cliHandoffContinuationMessage,
  cliRecordLastText,
  cliWorkerLabel,
  describeCliRecordStop,
  describeHandoffCause,
  earlierWorkSection,
  lastAssistantText,
  previousWorker,
  readWorktreeChanges,
  workerHandoffCause,
  type WorkerHandoff,
} from "./cli-worker-handoff.js";
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
  validationBudgetMs?: number;
  validationBudgetMsForTask?: (input: { taskId: string; baselineRevision: string; workspacePath: string }) => number | Promise<number>;
  browserBackend?: BrowserBackend;
  /** VF7b: true for a run that browses through the Playwright CLI; its workers and subagents get no browser.* tools. */
  browserToolsRetired?: () => boolean;
  mcpManager?: McpManager;
  managedBuildTools?: import("./managed-build-tools.js").ManagedBuildToolSource;
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
  defectClasses?: readonly string[];
  /** T6b repair (N-5): fresh top defect-class labels per worker turn; wins over defectClasses. */
  defectClassesFor?: () => readonly string[];
  /**
   * CW5 (CLI workers plan §3.5): the runtimes that are CLI workers, and what their attempts run with. A CLI runtime
   * takes the CLI branch in place of the model loop; the router assigns one only when this is set.
   */
  cliWorkers?: {
    runtimes: ReadonlyMap<string, CliWorkerRuntimeConfig>;
    runtime: CliWorkerRuntimeDeps;
  };
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
    "Verify by impact, narrowest first: run the new or changed tests first, then the owning test file or suite, then direct dependents and affected scope. Do not run the whole suite by default.",
    "Widen beyond affected scope only for a failure, a shared or public contract change, or a reviewer-named risk.",
    "Stay near the task's validation budget and justify anything broader in your submission.",
    "Extend or parameterize existing tests before adding new test files where sensible.",
    "Merging or deleting obsolete tests is allowed only with an explicit `behaviour proven in <test id or file>` statement naming where the behavior is still proven.",
    "Your submit_task validationScope must truthfully report what changed, what was verified, the tests actually run with counts, and what was not run and why.",
    "Do not submit while your own fresh evidence still shows a known acceptance failure. Continue fixing it; if you are mechanically blocked or the intended resolution is unclear, use ask_architect instead of submitting a known-bad changeset.",
    "If the task cannot be done within its objective (scope exceeded, requirement conflicts with the repository, missing dependency), call request_replan instead of improvising.",
  ].join("\n");
}

/**
 * C5 (AR-R16/EP40): the concrete worker context caps. Applied by the
 * assembler on both worker assembly paths (direct and extension) and
 * recorded on every worker context manifest beside the pack digest, token
 * count and limits of the actual request.
 */
export const NATIVE_WORKER_CONTEXT_LIMITS: ContextLimits = {
  maxBytes: 256 * 1024,
  maxEstimatedTokens: 64 * 1024,
};

/** C5: a new-policy worker whose accepted contract cannot be resolved from durable state. */
export class WorkerContractUnavailableError extends Error {
  constructor(readonly taskId: string, readonly resolution: string) {
    super(`Worker for task ${taskId} has no current accepted contract (resolution: ${resolution}); refusing to run without the authoritative compact contract.`);
    this.name = "WorkerContractUnavailableError";
  }
}

/**
 * C5 bridge: the authoritative accepted contract for a worker assignment,
 * resolved from durable state (current ready revision, digest and task
 * id). Legacy runs carry no plan contracts. Kernel repair tasks resolve
 * through their parent contract. Anything else without a current contract
 * fails closed.
 */
export function resolveWorkerTaskContract(
  projection: SchedulerProjection,
  taskId: string,
): { readonly contract: ExecutionTaskContract; readonly ref: TaskContractRef } | undefined {
  if (projection.planningPolicyVersion !== 1) return undefined;
  const resolution = resolveTaskContractReference(projection, taskId);
  if (resolution.status === "current") {
    const task = projection.tasks[taskId];
    if (resolution.ref.taskId === taskId) {
      const criteria = (values: readonly { id: string; text: string }[]) => values.map(({ id, text }) => ({ id, text })).sort((left, right) => left.id.localeCompare(right.id));
      if (!task || task.objective !== resolution.contract.outcome.user
        || !isDeepStrictEqual(criteria(task.acceptanceCriteria ?? []), criteria(resolution.contract.acceptance.criteria))) {
        throw new WorkerContractUnavailableError(taskId, "scheduler_contract_mismatch");
      }
    }
    return { contract: resolution.contract, ref: resolution.ref };
  }
  throw new WorkerContractUnavailableError(taskId, resolution.status);
}

export class NativeWorkerDriver implements WorkerRuntimeDriver {
  private readonly candidateById: Map<string, AgentRuntimeCandidate>;
  private readonly clock: () => string;
  private readonly contextLimits: ContextLimits;
  /**
   * Per attempt, cleanups only this Runner process can repeat (the attempt's
   * managed Build tool runtime). Kept until the attempt's stop is proven.
   */
  private readonly retainedCleanups = new Map<string, Array<() => Promise<void>>>();

  constructor(private readonly options: NativeWorkerDriverOptions) {
    this.candidateById = new Map(
      options.candidates.map((candidate) => [candidate.runtimeId, candidate])
    );
    this.clock = options.clock ?? (() => new Date().toISOString());
    this.contextLimits = options.contextLimits ?? { ...NATIVE_WORKER_CONTEXT_LIMITS };
  }

  private resolveDefectClasses(): readonly string[] {
    return this.options.defectClassesFor?.() ?? this.options.defectClasses ?? [];
  }

  /**
   * Runs the attempt, then proves its stop: every managed process the
   * attempt's worker started is stopped (closeAgent) before the outcome
   * counts. A stop that is not proven, here or in the attempt's own agent
   * cleanups, never returns its outcome: it returns `stop_unproven` with the
   * outcome it had, and the scheduler keeps the claim and pauses the run.
   */
  async run(assignment: WorkerAssignment): Promise<WorkerOutcome> {
    const key = attemptKey(assignment);
    // An entry left by an earlier run of this attempt is kept, never dropped.
    const retained = this.retainedCleanups.get(key) ?? [];
    this.retainedCleanups.set(key, retained);
    let outcome: WorkerOutcome | undefined;
    let threw = false;
    let primary: unknown;
    try {
      outcome = await this.runAttempt(assignment, (close) => retained.push(close));
    } catch (error) {
      threw = true;
      primary = error;
    }
    // The stop proof: every retained cleanup (the attempt's managed Build
    // tool runtime, and each subagent's exact owner: a subagent's own cleanup
    // failure only reaches the worker as a tool error result), then the
    // worker owner's managed processes.
    const stopFailures: unknown[] = [];
    for (const close of retained) {
      try { await close(); } catch (error) { stopFailures.push(error); }
    }
    try {
      await this.options.managedProcesses?.closeAgent(this.attemptOwner(assignment));
    } catch (error) {
      stopFailures.push(error);
    }
    const stopFailed = stopFailures.length > 0;
    const stopFailure = stopFailures.length === 1 ? stopFailures[0] : new AggregateError(stopFailures, stopFailures.map((failure) => errorMessage(failure)).join(" "));
    const cleanupUnproven = threw && isProcessStopUnprovenError(primary);
    // A CLI attempt whose own stop was not proven (§3.11 case 2) stays unproven: its retry runs on resume.
    const attemptUnproven = !threw && outcome?.type === "stop_unproven" ? outcome : undefined;
    if (!stopFailed && !cleanupUnproven && !attemptUnproven) {
      this.retainedCleanups.delete(key);
      if (threw) throw primary;
      return outcome!;
    }
    const reasons = [
      ...(attemptUnproven ? [attemptUnproven.reason] : []),
      ...(cleanupUnproven ? [errorMessage(primary)] : []),
      ...(stopFailed ? [`Managed process stop not proven: ${errorMessage(stopFailure)}`] : []),
    ];
    return {
      type: "stop_unproven",
      reason: reasons.join(" "),
      outcome: threw ? { type: "failed", reason: boundedText(errorMessage(primary)) }
        : attemptUnproven ? attemptUnproven.outcome : outcome as SettledWorkerOutcome,
      ...(threw ? { thrown: primary } : {}),
    };
  }

  /**
   * Stops again everything the attempt's owner started: the attempt's
   * retained cleanups, its language servers, its MCP servers and its managed
   * processes. Resolves only when every stop is proven.
   *
   * A fresh driver has nothing retained. It exists only after a crew or credential rebuild, which
   * refuses to build it unless the previous handle closed (native-build-manager.ts rebuildRuntime:
   * the binding close stops every managed process of the run and requires every streaming session
   * released), or after a Runner restart, whose construction recovery releases every recovered MCP
   * and language-server session fail-closed (native-build-factory.ts, cleanupRecovered*Transports).
   * Managed processes survive both as records, so this retry stops them by owner either way.
   */
  async retryStop(assignment: WorkerAssignment): Promise<void> {
    const key = attemptKey(assignment);
    const owner = this.attemptOwner(assignment);
    const failures: unknown[] = [];
    const retained = this.retainedCleanups.get(key) ?? [];
    for (const close of retained) {
      try { await close(); } catch (error) { failures.push(error); }
    }
    try { await this.options.language?.closeAgent?.(owner); } catch (error) { failures.push(error); }
    try { await this.options.mcpManager?.closeAgent(owner); } catch (error) { failures.push(error); }
    try { await this.options.managedProcesses?.closeAgent(owner); } catch (error) { failures.push(error); }
    // CW5 (§3.10, §3.11 case 2): a CLI attempt's stop is proven only with its browser record proven too.
    const cli = this.cliRuntime(this.persistedRuntimeAssignment(assignment)?.runtimeId);
    if (cli) {
      const unproven = await proveCliStop(cli.deps, owner);
      if (unproven) failures.push(new Error(`The CLI worker's stop is not proven: ${unproven}`));
    }
    // Its subagents run under their own owners. Their retained cleanups ran
    // above; after a Runner restart only their managed-process records are
    // left, so every live one of this attempt's subagents is stopped too.
    try {
      for (const subagent of await this.subagentOwnersWithLiveProcesses(owner)) {
        try { await this.options.managedProcesses!.closeAgent(subagent); } catch (error) { failures.push(error); }
      }
    } catch (error) { failures.push(error); }
    if (failures.length > 0) {
      throw new AgentCleanupUnverifiedError(failures, `The worker's stop is still not proven: ${failures.map((failure) => errorMessage(failure)).join("; ")}`);
    }
    this.retainedCleanups.delete(key);
    if (cli) cli.deps.owners?.release(owner);
  }

  /** The CLI branch's config for a runtime, when it is a CLI worker this driver can run. */
  private cliRuntime(runtimeId: string | undefined): { config: CliWorkerRuntimeConfig; deps: CliWorkerRuntimeDeps } | undefined {
    const config = runtimeId === undefined ? undefined : this.options.cliWorkers?.runtimes.get(runtimeId);
    return config ? { config, deps: this.options.cliWorkers!.runtime } : undefined;
  }

  private async subagentOwnersWithLiveProcesses(owner: ReturnType<NativeWorkerDriver["attemptOwner"]>) {
    if (!this.options.managedProcesses) return [];
    const owners = new Map<string, { runId: string; sessionId: string; actor: { role: "subagent"; id: string } }>();
    for (const record of await this.options.managedProcesses.listRun(owner.runId)) {
      if (record.status === "stopped" || record.actor.role !== "subagent") continue;
      if (!record.actor.id.startsWith(`${owner.actor.id}:`) || !record.sessionId.startsWith(`${owner.sessionId}:subagent:`)) continue;
      owners.set(JSON.stringify([record.sessionId, record.actor.id]), { runId: owner.runId, sessionId: record.sessionId, actor: { role: "subagent", id: record.actor.id } });
    }
    return [...owners.values()];
  }

  /** The exact owner every process of this attempt's worker session runs under. */
  private attemptOwner(assignment: WorkerAssignment) {
    const sessionId = resolveWorkerSessionId(
      assignment.runId,
      assignment.task.id,
      assignment.attempt,
      assignment.workerId,
      this.persistedRuntimeAssignment(assignment)?.sessionId,
    );
    return Object.freeze({
      runId: assignment.runId,
      sessionId,
      actor: Object.freeze({ role: "worker" as const, id: assignment.workerId }),
    });
  }

  private async runAttempt(
    assignment: WorkerAssignment,
    retainCleanup: (close: () => Promise<void>) => void,
  ): Promise<WorkerOutcome> {
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
        assignment.task.requiredCapabilities,
        new Set(),
        workerSelectionPreference(
          rebuildSchedulerProjection(this.options.schedulerStore.readRun(assignment.runId)),
          assignment.task.id,
        ),
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
      // §3.13: a CLI worker has no AgentModel; its branch runs instead of the model loop.
      const cli = this.cliRuntime(runtimeId);
      if (!candidate || (!model && !cli)) {
        return { type: "paused", reason: `runtime_unavailable:${runtimeId}` };
      }
      // C5: fail fast without the authoritative compact contract — the
      // context assembly below resolves the same reference again.
      try {
        resolveWorkerTaskContract(
          rebuildSchedulerProjection(this.options.schedulerStore.readRun(assignment.runId)),
          assignment.task.id,
        );
      } catch (error) {
        if (error instanceof WorkerContractUnavailableError) {
          // A final-verification repair naming no integrated task has no contract to run under. The
          // Architect can fix that with revise_task, so it is a task failure for the Architect, not an
          // owner pause (tunnel run: missing_task_contract:dropped at the build's last step).
          const projection = rebuildSchedulerProjection(this.options.schedulerStore.readRun(assignment.runId));
          const task = projection.tasks[assignment.task.id];
          if (task?.kind === "verification_repair" && repairParentContractId(projection, task) === undefined) {
            return {
              type: "failed",
              reason: `repair_contract_unresolvable: repair ${task.id} lists no dependency on an integrated task, so it has no task contract to run under. Use revise_task to set its dependencies to the integrated task(s) whose delivered work it repairs.`,
            };
          }
          return { type: "paused", reason: `missing_task_contract:${error.resolution}` };
        }
        throw error;
      }
      let workspace: TaskWorkspace;
      try {
        workspace = await this.options.workspaceManager.createTaskWorkspace(
          assignment.task.id,
          {
            workspaceId:
              assignment.task.workspaceId ?? assignment.task.id,
            ...(assignment.task.workspaceBaselineRevision
              ? { baselineRevision: assignment.task.workspaceBaselineRevision }
              : {}),
          }
        );
      } catch (error) {
        // §3.7: the same attempt run again (a Resume after its stop was proven, a restart) finds the worktree its CLI
        // left detached or on another branch. The workspace refuses it as before; the CLI worker's failure is coded.
        if (cli && error instanceof ForeignHistoryError) return { type: "failed", reason: cliHistoryRefusal(error) };
        throw error;
      }
      const validationBudgetMs = this.options.validationBudgetMsForTask
        ? await this.options.validationBudgetMsForTask({ taskId: assignment.task.id, baselineRevision: workspace.baselineRevision, workspacePath: workspace.path })
        : this.options.validationBudgetMs;
      const context = await this.workerContext(
        assignment,
        workspace.path,
        sessionId,
      );
      // CW7 (§3.9): across a CLI boundary, what the worker before this runtime left on this attempt.
      const handoff = await this.workerHandoff(assignment, runtimeId, sessionId, workspace);
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
      if (cli) {
        // CW5 (§3.5): the CLI runs in place of the model loop; everything before it (selection, contract, worktree,
        // context pack, context manifest) is the same.
        const result = await runCliWorkerAttempt(cli.deps, {
          runId: assignment.runId,
          taskId: assignment.task.id,
          attempt: assignment.attempt,
          workerId: assignment.workerId,
          sessionId,
          owner: this.attemptOwner(assignment),
          workspace,
          config: cli.config,
          contextText: context.pack.text,
          ...(handoff ? { earlierWork: earlierWorkSection(handoff.handoff) } : {}),
          submission: workerSubmissionContext({
            ...(this.options.git ? { git: this.options.git } : {}),
            runId: assignment.runId,
            sessionId,
            taskId: assignment.task.id,
            actorId: assignment.workerId,
            ...(assignment.task.acceptanceCriteria ? { acceptanceCriteria: assignment.task.acceptanceCriteria } : {}),
            ...(assignment.task.acceptanceCriteriaVersion !== undefined ? { acceptanceCriteriaVersion: assignment.task.acceptanceCriteriaVersion } : {}),
            attempt: assignment.attempt,
            workspace,
            workspaceManager: this.options.workspaceManager,
            artifacts: this.options.artifacts,
            ledger: this.options.ledger,
            schedulerStore: this.options.schedulerStore,
            evidenceStore: this.options.evidenceStore,
            ...(this.options.budgetLedger ? { budgetLedger: this.options.budgetLedger } : {}),
            ...(validationBudgetMs !== undefined ? { validationBudgetMs } : {}),
            memoryStore: this.options.memoryStore,
            projectId: this.options.projectId,
          }),
          ...(assignment.signal ? { signal: assignment.signal } : {}),
        });
        if (result.type === "submitted") {
          this.recordSuccess(assignment.runId, candidate.providerId);
          return submittedWorkerOutcome(result.changeSet);
        }
        if (result.type === "guidance") {
          return guidanceOutcomeFromProjection(
            rebuildSchedulerProjection(this.options.schedulerStore.readRun(assignment.runId)),
            result.requestId,
          );
        }
        if (result.type === "settled") return result.outcome;
        if (result.type === "stop_unproven") return { type: "stop_unproven", reason: result.reason, outcome: result.outcome };
        const next = this.failOver(assignment, runtimeId, candidate.providerId, result.failure, sessionId);
        if (next.type === "outcome") return next.outcome;
        runtimeId = next.runtimeId;
        continue;
      }
      const sessionEventCount = this.options.sessions.events(sessionId).length;
      const toolEventCountBefore = this.options.ledger
        .listRun(assignment.runId)
        .filter((entry) => entry.sessionId === sessionId).length;
      const budgetedModel = this.options.budgetLedger
        ? new BudgetedAgentModel({
            model: model!,
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
        : model!;
      const result = await runWorkerTask({
        model: budgetedModel,
        ...(this.options.budgetLedger
          ? {
              subagentModelForSession: (subagentSessionId: string) =>
                new BudgetedAgentModel({
                  model: model!,
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
        ...(validationBudgetMs !== undefined
          ? { validationBudgetMs }
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
        continuationMessages: [
          ...workerContinuationMessages(
            {
              id: `context:${context.pack.digest}`,
              role: "user",
              content: context.pack.text,
            },
            sessionEventCount > 0,
            assignment.task.id,
            sessionEventCount
          ),
          // CW7 (§3.9): CLI → API, one message built from the CLI's latest attempt record.
          ...(handoff?.fromCli ? [cliHandoffContinuationMessage(handoff.id, handoff.handoff)] : []),
        ],
        clock: this.clock,
        ...(this.options.allowedCommands
          ? { allowedCommands: this.options.allowedCommands }
          : {}),
        ...(this.options.hiddenPaths ? { hiddenPaths: this.options.hiddenPaths } : {}),
        ...(this.options.protectedPaths ? { protectedPaths: this.options.protectedPaths } : {}),
        ...activeBrowserBackend(this.options.browserBackend, this.options.browserToolsRetired),
        ...(this.options.mcpManager ? { mcpManager: this.options.mcpManager } : {}),
        ...(this.options.managedBuildTools ? { managedBuildTools: this.options.managedBuildTools } : {}),
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
        retainCleanup,
      });
      if (result.loop.status === "submitted") {
        this.recordSuccess(assignment.runId, candidate.providerId);
        return submittedWorkerOutcome(result.changeSet, result.loop.changeSetId);
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
        const next = this.failOver(assignment, runtimeId, candidate.providerId, failure, sessionId);
        if (next.type === "outcome") return next.outcome;
        runtimeId = next.runtimeId;
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

  /**
   * A worker's provider failed: record it, and hand the same task, attempt, worktree and session to another healthy
   * worker (API or CLI), or end the attempt when none is left or the failure must not fail over.
   */
  private failOver(
    assignment: WorkerAssignment,
    runtimeId: string,
    providerId: string,
    failure: ProviderFailure,
    sessionId: string,
  ): { type: "outcome"; outcome: SettledWorkerOutcome } | { type: "next"; runtimeId: string } {
    this.options.health.recordFailure(providerId, failure);
    this.persistHealth(assignment.runId, providerId);
    if (!shouldFailoverWorkerFailure(failure)) {
      return {
        type: "outcome",
        outcome: {
          type: "failed",
          reason: `provider_${failure.kind}:${failure.message}`,
        },
      };
    }
    const selection = this.options.router.selectWorker(
      assignment.task.requiredCapabilities,
      new Set([runtimeId]),
      workerSelectionPreference(
        rebuildSchedulerProjection(this.options.schedulerStore.readRun(assignment.runId)),
        assignment.task.id,
      ),
    );
    if (selection.status === "unavailable") {
      return { type: "outcome", outcome: { type: "paused", reason: "all_worker_runtimes_unavailable" } };
    }
    // CW7: the cause is durable on the assignment, so the next worker's handoff says why this one stopped.
    this.assignRuntime(assignment, selection.runtime.runtimeId, sessionId, workerHandoffCause(runtimeId, failure));
    return { type: "next", runtimeId: selection.runtime.runtimeId };
  }

  /**
   * CW7 (§3.9): the handoff from the worker that ran this attempt before `runtimeId`, when one of the two is a CLI. An
   * API worker that follows another API worker inherits its conversation and gets none. The previous worker's text is
   * a claim; the changed files and the evidence ids are facts the Runner read.
   */
  private async workerHandoff(
    assignment: WorkerAssignment,
    runtimeId: string,
    sessionId: string,
    workspace: TaskWorkspace,
  ): Promise<{ handoff: WorkerHandoff; fromCli: boolean; id: string } | undefined> {
    const key = { runId: assignment.runId, taskId: assignment.task.id, attempt: assignment.attempt, sessionId };
    const assignments = attemptRuntimeAssignments(this.options.schedulerStore.readRun(assignment.runId), key);
    const previous = assignments.at(-1)?.runtimeId === runtimeId ? previousWorker(assignments) : undefined;
    if (!previous) return undefined;
    const record = cliAttemptRecords(this.options.schedulerStore, key).filter((entry) => entry.runtimeId === previous.runtimeId).at(-1);
    const previousCli = this.cliRuntime(previous.runtimeId)?.config;
    const fromCli = record !== undefined || previousCli !== undefined;
    if (!fromCli && !this.cliRuntime(runtimeId)) return undefined;
    let lastText = record ? cliRecordLastText(record) : undefined;
    if (!fromCli) {
      // The API worker's last words, from its checkpointed conversation in this session.
      lastText = lastAssistantText((await this.options.sessions.load(sessionId).catch(() => undefined))?.checkpoint?.messages ?? []);
    }
    const handoff: WorkerHandoff = {
      previousWorker: record ? cliWorkerLabel(record)
        : previousCli ? cliWorkerLabel({ providerId: previousCli.providerId, runtimeId: previous.runtimeId })
          : apiWorkerLabel(previous.runtimeId, this.candidateById.get(previous.runtimeId)?.modelId),
      stopped: previous.cause ? describeHandoffCause(previous.cause)
        : record ? describeCliRecordStop(record) : "the Runner holds no record of why",
      ...(lastText ? { lastText } : {}),
      changes: await readWorktreeChanges(requireGitRunner(this.options.git).lifecycle("inspection").run, workspace.path, workspace.baselineRevision),
      evidenceIds: this.options.evidenceStore.list({ runId: assignment.runId, taskId: assignment.task.id, limit: 1_000 })
        .filter((entry) => entry.attempt === assignment.attempt)
        .map((entry) => entry.id),
    };
    return { handoff, fromCli, id: `worker-handoff:${assignment.task.id}:${assignment.attempt}:${previous.assignments}` };
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
    sessionId: string,
    handoff?: ReturnType<typeof workerHandoffCause>,
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
        ...(handoff ? { handoff } : {}),
        ...(rebuildSchedulerProjection(this.options.schedulerStore.readRun(assignment.runId)).reviewIntegrityPolicyVersion === 1
          ? { modelIdentity: canonicalModelIdentity(this.candidateById.get(runtimeId)!.modelId) } : {}),
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
    const defectClasses = this.resolveDefectClasses();
    // C5: both assembly paths (direct below and the extension runtime)
    // share this input, so both carry the authoritative compact contract.
    const resolved = resolveWorkerTaskContract(projection, assignment.task.id);
    // T10 (L6): resolve what each dependency is and what it delivered from
    // durable state; missing data renders as not-yet-delivered, never invented.
    const dependencySummaries = (projection.tasks[assignment.task.id]?.dependencies ?? []).map((id) => {
      const dependency = projection.tasks[id];
      const summary = projection.delivery?.reviews?.[id]?.summary;
      return {
        id,
        objective: dependency?.objective ?? "(unknown task)",
        status: dependency?.status ?? "unknown",
        ...(summary !== undefined && summary.length > 0 ? { summary } : {}),
      };
    });
    const input = {
      limits: this.contextLimits,
      task: projection.tasks[assignment.task.id],
      ...(resolved ? { contract: resolved.contract, contractRef: resolved.ref } : {}),
      ...(dependencySummaries.length > 0 ? { dependencySummaries } : {}),
      guidance,
      instructions,
      skills,
      memories,
      repositorySnapshot,
      evidence,
      recentHistory: [],
      ...(defectClasses.length > 0 ? { defectClasses: [...defectClasses] } : {}),
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

/** The scheduler outcome of a submission, from its change set (the API worker's and the CLI worker's alike). */
export function submittedWorkerOutcome(changeSet: ChangeSet | undefined, changeSetId = changeSet?.id): SettledWorkerOutcome {
  if (!changeSetId) throw new Error("A submitted worker outcome needs its change set.");
  return {
    type: "submitted",
    ...(changeSet?.reviewSignals ? { reviewSignals: structuredClone(changeSet.reviewSignals) } : {}),
    ...(changeSet?.submissionScope ? { submissionScope: structuredClone(changeSet.submissionScope) } : {}),
    ...(changeSet?.validationScope ? { validationScope: structuredClone(changeSet.validationScope) } : {}),
    ...(changeSet?.validationBudget ? { validationBudget: structuredClone(changeSet.validationBudget) } : {}),
    ...(changeSet?.encodingSubmission ? { encodingSubmission: structuredClone(changeSet.encodingSubmission) } : {}),
    changeSetId,
    ...(changeSet?.criterionEvidenceLinks
      ? {
          criterionEvidenceLinks: changeSet.criterionEvidenceLinks.map((link) => ({
            ...link,
            artifactHashes: [...link.artifactHashes],
          })),
        }
      : {}),
  };
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
): SettledWorkerOutcome | undefined {
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
): SettledWorkerOutcome {
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

const ACTIVE_WORKER_STATUSES = new Set(["assigned", "running", "waiting_guidance"]);
const APPROVED_WORKER_STATUSES = new Set(["approved", "integrating", "integration_resolution", "integrated"]);
/** A worker with this many superseded attempts and no approved task is used only as a last resort. */
const DEMOTE_AFTER_FAILED_ATTEMPTS = 2;

/**
 * How to spread `taskId` over the owner's workers, from the run's own record: the attempts each
 * worker is running now, the workers that ran this task before (newest first), and the workers
 * whose attempts keep being superseded without a single approved task.
 */
export function workerSelectionPreference(
  projection: SchedulerProjection,
  taskId: string,
): WorkerSelectionPreference {
  const assignments = Object.entries(projection.runtime.workerAssignments).map(([key, assignment]) => {
    const separator = key.lastIndexOf(":");
    return { taskId: key.slice(0, separator), attempt: Number(key.slice(separator + 1)), runtimeId: assignment.runtimeId };
  });
  const activeAssignments = new Map<string, number>();
  const failed = new Map<string, number>();
  const approved = new Map<string, number>();
  for (const assignment of assignments) {
    const task = projection.tasks[assignment.taskId];
    if (!task) continue;
    const current = assignment.attempt === task.attempt;
    const count = (map: Map<string, number>) => map.set(assignment.runtimeId, (map.get(assignment.runtimeId) ?? 0) + 1);
    if (current && assignment.taskId !== taskId && ACTIVE_WORKER_STATUSES.has(task.status)) count(activeAssignments);
    if (!current && assignment.attempt < task.attempt) count(failed);
    if (current && APPROVED_WORKER_STATUSES.has(task.status)) count(approved);
  }
  const affinity = [...new Set(assignments
    .filter((assignment) => assignment.taskId === taskId)
    .sort((left, right) => right.attempt - left.attempt)
    .map((assignment) => assignment.runtimeId))];
  const demoted = new Set([...failed]
    .filter(([runtimeId, attempts]) => attempts >= DEMOTE_AFTER_FAILED_ATTEMPTS && !approved.get(runtimeId))
    .map(([runtimeId]) => runtimeId));
  return { activeAssignments, affinity, demoted };
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

function attemptKey(assignment: Pick<WorkerAssignment, "runId" | "task" | "attempt" | "workerId">): string {
  return JSON.stringify([assignment.runId, assignment.task.id, assignment.attempt, assignment.workerId]);
}
