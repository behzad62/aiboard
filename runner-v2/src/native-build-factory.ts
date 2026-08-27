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
import {
  BuildRuntime,
  type FinalVerificationCheckDriver,
  type IndependentVerifierDriver,
  type IntegrationRuntimeDriver,
} from "./build-runtime.js";
import type { AgentSessionProjection } from "./agent-session-store.js";
import { nativeBuildBudgetEnforceabilityError } from "./budget-enforceability.js";
import type { ModelCostEstimator } from "./budgeted-model.js";
import type {
  BuildObservabilitySnapshot,
  BuildToolObservation,
} from "./build-observability.js";
import {
  loadFinalVerificationDiagnostics,
  projectFinalVerificationObservability,
  projectIndependentVerifierObservability,
} from "./build-observability.js";
import { PlaywrightBrowserBackend } from "./browser-tools.js";
import type { NativeBuildSpec } from "./build-spec.js";
import { IntegrationManager } from "./integration-manager.js";
import { FinalVerificationRuntime } from "./final-verification-runtime.js";
import { FinalVerificationProfileAuthority } from "./final-verification-profile.js";
import { FinalVerificationPortAuthority } from "./final-verification-port-authority.js";
import {
  FinalVerificationDiagnosticsArchive,
  OwnedFinalVerificationCleanup,
  retireInvalidatedFinalVerificationGeneration,
  validateOwnedFinalVerificationCleanupReceipt,
} from "./final-verification-cleanup.js";
import { GoogleModel } from "./google-model.js";
import { ManagedProcessService } from "./managed-process.js";
import type { NativeBuildRuntimeHandle } from "./native-build-manager.js";
import {
  projectNativeModelUsage,
  type NativeModelUsageRuntime,
} from "./model-usage-projection.js";
import { NativeArchitectRuntime } from "./native-architect-runtime.js";
import {
  NativeVerifierRuntime,
  type NativeVerifierInspectionRequest,
} from "./native-verifier-runtime.js";
import { NativeWorkerDriver } from "./native-worker-driver.js";
import { resolveWorkerSessionId, standardWorkerId } from "./worker-identity.js";
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
import { runnerProviderRetryDeadlineMs } from "./provider-call-retry.js";
import { RuntimeRouter, type AgentRuntimeCandidate } from "./runtime-router.js";
import {
  rebuildSchedulerProjection,
  type SchedulerEvent,
  type SchedulerProjection,
  type BuildRiskAssessmentProjection,
} from "./scheduler-store.js";
import type { BuildRiskAssessmentInput } from "./risk-policy.js";
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
import type { ToolLedgerEvent } from "./tool-ledger.js";
import { SchedulerVerifierVerdictAuthority } from "./verifier-verdict-authority.js";
import { WorkspaceManager } from "./workspace-manager.js";
import { VerificationWorkspaceManager } from "./verification-workspace.js";

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
    const evidenceStore = new SqliteEvidenceStore(join(runRoot, "evidence.sqlite"));
    const finalVerificationPorts = new FinalVerificationPortAuthority(this.options.stateDirectory);
    const finalVerificationProfiles = new FinalVerificationProfileAuthority({
      stateDirectory: this.options.stateDirectory,
      runId: spec.runId,
      portAuthority: finalVerificationPorts,
    });
    const schedulerStore = new SqliteSchedulerStore(join(runRoot, "scheduler.sqlite"), {
      evidenceStore,
      artifacts: this.artifacts,
      validateCleanupReceipt: (identity) =>
        validateOwnedFinalVerificationCleanupReceipt(this.options.stateDirectory, identity),
      validateExecutionProfile: ({ targetRevision, profile }) =>
        finalVerificationProfiles.validate(profile, targetRevision),
    });
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
    const verificationWorkspace = new VerificationWorkspaceManager({
      repositoryRoot: integrationManager.path,
      stateDirectory: this.options.stateDirectory,
      runId: spec.runId,
      integrationManager,
    });
    const verifierWorkspace = new VerificationWorkspaceManager({
      repositoryRoot: integrationManager.path,
      stateDirectory: this.options.stateDirectory,
      runId: spec.runId,
      integrationManager,
      kind: "independent-verifier",
    });
    if (
      schedulerEvents.length > 0 &&
      rebuildSchedulerProjection(schedulerEvents).verifier?.current?.status ===
        "submitted"
    ) {
      await verifierWorkspace.cleanup();
    }
    const finalVerificationCleanup = new OwnedFinalVerificationCleanup({
      stateDirectory: this.options.stateDirectory,
      runId: spec.runId,
      stopRun: (runId) => this.managedProcesses.stopRun(runId),
      closeBrowserRun: (runId) => this.browserBackend.closeRun(runId),
      workspaceManager: verificationWorkspace,
      diagnostics: new FinalVerificationDiagnosticsArchive({
        stateDirectory: this.options.stateDirectory,
        runId: spec.runId,
        workspaceManager: verificationWorkspace,
      }),
    });
    const initialHealth = providerHealthFromSchedulerEvents(
      schedulerStore.readRun(spec.runId)
    );
    const health = new ProviderHealthRegistry({ initial: initialHealth });
    const workerRouter = new RuntimeRouter({
      candidates: workerCandidates,
      health,
    });
    const architectRouter = new RuntimeRouter({ candidates, health });
    const verifierRouter = new RuntimeRouter({ candidates, health });
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
        ? {
            allowedCommands: spec.benchmark.allowedCommands,
            hiddenPaths: spec.benchmark.hiddenPaths,
            protectedPaths: spec.benchmark.protectedPaths,
          }
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
      canonicalProjectRoot: integrationManager.path,
      objective: spec.objective,
      runPolicy: spec.runPolicy,
      ...(spec.benchmark
        ? {
            allowedCommands: spec.benchmark.allowedCommands,
            hiddenPaths: spec.benchmark.hiddenPaths,
            protectedPaths: spec.benchmark.protectedPaths,
          }
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
    const nativeVerifier = new NativeVerifierRuntime({
      router: verifierRouter,
      candidates,
      models,
      verifierRuntimeIds: spec.verifierRuntimeIds,
      sessions,
      artifacts: this.artifacts,
      evidenceStore,
      workspaceManager: {
        workspaceKind: "independent-verifier",
        create: async (targetRevision) =>
          await verifierWorkspace.create(targetRevision),
      },
      budgetLedger,
      ledger,
      modelCostEstimators,
      modelCostBases,
      verdictAuthority: new SchedulerVerifierVerdictAuthority(schedulerStore),
    });
    const independentVerifier: IndependentVerifierDriver = {
      candidateRuntimeIds: [...spec.verifierRuntimeIds],
      alwaysRequireIndependentVerifier:
        spec.alwaysRequireIndependentVerifier,
      assessRisk: async ({ projection }) => deriveNativeVerifierRiskInput({
        projection,
        sessions: await sessions.listRun(spec.runId),
        schedulerEvents: schedulerStore.readRun(spec.runId),
        toolEvents: ledger.listRun(spec.runId),
        stricterQualification: spec.alwaysRequireIndependentVerifier,
      }),
      verify: async (request) => {
        const result = await nativeVerifier.inspect(
          buildNativeVerifierInspectionRequest({
            runId: spec.runId,
            objective: spec.objective,
            architectRuntimeId:
              request.projection.runtime.architect.runtimeId ??
              spec.architectRuntimeId,
            projection: request.projection,
            sessions: await sessions.listRun(spec.runId),
            risk: request.risk,
            ...(request.preferredRuntimeId
              ? { preferredRuntimeId: request.preferredRuntimeId }
              : {}),
            ...(request.signal ? { signal: request.signal } : {}),
            providerRetryDeadlineMs: runnerProviderRetryDeadlineMs(
              spec.budgetLimits.maxActiveMs,
              budgetLedger.snapshot(spec.runId).effective.activeMs,
              Date.now(),
            ),
          }),
        );
        if (
          (result.status === "verdict_submitted" ||
            (result.status === "suspended" && result.reason === "provider_error")) &&
          result.runtimeId
        ) {
          const candidate = candidates.find(
            (item) => item.runtimeId === result.runtimeId,
          );
          if (candidate) {
            persistProviderHealth(
              schedulerStore,
              spec.runId,
              health.get(candidate.providerId),
              `verifier:${result.runtimeId}`,
            );
          }
        }
        if (result.status === "verdict_submitted") {
          await verifierWorkspace.cleanup();
          return { status: "verdict_submitted" };
        }
        if (result.status === "unavailable") {
          return { status: "unavailable", reason: result.reason };
        }
        if (result.status === "suspended") {
          return {
            status: "suspended",
            reason: result.reason,
            runtimeId: result.runtimeId,
            ...(result.error ? { error: result.error } : {}),
          };
        }
        return {
          status: "suspended",
          reason: `unexpected_verifier_result:${result.status}`,
        };
      },
    };
    const integrationDriver: IntegrationRuntimeDriver = {
      integrate: async ({ taskId, changeSetId }) => {
        const projection = rebuildSchedulerProjection(
          schedulerStore.readRun(spec.runId)
        );
        const task = projection.tasks[taskId];
        if (!task) throw new Error(`Unknown integration task ${taskId}.`);
        const sessionId = resolveWorkerSessionId(
          spec.runId,
          taskId,
          task.attempt,
          task.assignedWorkerId ?? standardWorkerId(taskId, task.attempt),
          projection.runtime.workerAssignments[`${taskId}:${task.attempt}`]?.sessionId
        );
        const session = await sessions.load(sessionId);
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
    const finalVerificationDriver: FinalVerificationCheckDriver = {
      executeCheck: async (input) => {
        const verification = new FinalVerificationRuntime({
          workspaceManager: verificationWorkspace,
          artifacts: this.artifacts,
          evidenceStore,
          runId: input.runId,
          taskId: input.taskId,
          attempt: input.attempt,
          generationId: input.generationId,
          currentIntegrationRevision: () => integrationManager.revision,
          managedProcessService: this.managedProcesses,
          browserBackend: this.browserBackend,
          validatePortLease: async (lease) => await finalVerificationPorts.validate(
            lease,
            spec.runId,
            input.targetRevision,
          ),
        });
        const result = await verification.runCategory(
          {
            plan: input.plan,
            executionProfile: input.executionProfile,
            ...(input.executionProfile?.commands
              ? { commands: input.executionProfile.commands }
              : {}),
            ...(input.executionProfile?.runtimeSmoke
              ? { runtimeSmoke: input.executionProfile.runtimeSmoke }
              : {}),
            ...(input.executionProfile?.browser
              ? { browser: input.executionProfile.browser }
              : {}),
            signal: input.signal,
          },
          input.category,
        );
        return {
          workspacePath: result.workspacePath,
          startedAt: result.startedAt,
          finishedAt: result.finishedAt,
          check: result.check,
        };
      },
    };
    const runtime = new BuildRuntime({
      runId: spec.runId,
      initialObjective: spec.objective,
      runPolicy: spec.runPolicy,
      store: schedulerStore,
      workerDriver,
      architectDriver,
      integrationDriver,
      finalVerificationDriver,
      finalVerificationCleanupDriver: {
        cleanup: async (input) => {
          const current = rebuildSchedulerProjection(schedulerStore.readRun(spec.runId))
            .finalVerification?.current;
          const lease = current?.generationId === input.generationId &&
            current.targetRevision === input.targetRevision
            ? current.executionProfile.portLease
            : undefined;
          try {
            return await finalVerificationCleanup.cleanup(input);
          } finally {
            if (lease) {
              await finalVerificationPorts.release(lease, spec.runId, input.targetRevision);
            }
          }
        },
      },
      finalVerificationProfileFor: async (targetRevision) =>
        await finalVerificationProfiles.inspectAndPersist({
          repositoryRoot: integrationManager.path,
          targetRevision,
        }),
      discardFinalVerificationProfile: async (profile) => {
        if (profile.portLease) {
          await finalVerificationPorts.release(profile.portLease, spec.runId, profile.targetRevision);
        }
      },
      independentVerifier,
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
      providerRetryDeadlineMs: () => {
        const usedActiveMs = budgetLedger.snapshot(spec.runId).effective.activeMs;
        return runnerProviderRetryDeadlineMs(
          spec.budgetLimits.maxActiveMs,
          usedActiveMs,
          Date.now()
        );
      },
      evidenceStore,
      artifacts: this.artifacts,
    });
    let closed = false;
    return {
      runtime,
      finalVerificationCleanup,
      retireInvalidatedFinalVerification: async (generation, currentGeneration) =>
        await retireInvalidatedFinalVerificationGeneration({
          cleanup: finalVerificationCleanup,
          generation,
          currentGeneration,
          releasePortLease: async (lease, targetRevision) =>
            await finalVerificationPorts.release(
              lease,
              spec.runId,
              targetRevision,
            ),
        }),
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
        const finalGeneration = schedulerProjection.finalVerification?.current;
        const diagnostics = finalGeneration
          ? await loadFinalVerificationDiagnostics({
              stateDirectory: this.options.stateDirectory,
              runId: spec.runId,
              expectedRunSegment: safeSegment(spec.runId),
              diagnosticsPath: finalGeneration.cleanup?.diagnosticsPath,
              generationId: finalGeneration.generationId,
              taskId: finalGeneration.taskId,
              targetRevision: finalGeneration.targetRevision,
            })
          : undefined;
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
          finalVerification: projectFinalVerificationObservability(
            schedulerProjection,
            diagnostics,
          ),
          independentVerifier:
            projectIndependentVerifierObservability(schedulerProjection),
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
            () => verifierWorkspace.cleanup(),
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
  // Callers obtain this list from SchedulerStore.readRun(), which already
  // replays and validates every event. Do not reinterpret a terminal legacy
  // history against today's stronger completion preconditions.
  return events.some((event) => event.type === "run.completed")
    ? "cleanup-only"
    : "active";
}

export function deriveNativeVerifierRiskInput(input: {
  projection: SchedulerProjection;
  sessions: readonly AgentSessionProjection[];
  schedulerEvents: readonly SchedulerEvent[];
  toolEvents: readonly ToolLedgerEvent[];
  stricterQualification: boolean;
}): BuildRiskAssessmentInput {
  const accepted = acceptedChangeSessions(input.projection, input.sessions);
  const toolEffects = input.toolEvents.filter(
    (event) => event.type === "tool.started" || event.type === "tool.retry_started",
  );
  return {
    architectDeclaration:
      input.projection.finalVerification?.current?.review?.decision
        ?.architectRisk.risk ?? "low",
    stricterQualification: input.stricterQualification,
    kernelFacts: {
      destructiveEffects: toolEffects.some(
        (event) => event.access?.destructive === true,
      ),
      credentialEffects: toolEffects.some(
        (event) => event.access?.credentialChange === true,
      ),
      externalWriteEffects:
        accepted.some((session) =>
          (session.changeSet?.externalEffects.length ?? 0) > 0
        ) ||
        toolEffects.some(
          (event) =>
            event.effect === "external" ||
            event.access?.external === true ||
            event.outsideWorkspace === true,
        ),
      integrationConflict: input.schedulerEvents.some(
        (event) =>
          event.type === "task.transitioned" &&
          event.payload.status === "integration_resolution",
      ),
      changedPaths: [...new Set(accepted.flatMap(
        (session) => session.changeSet?.changedPaths ?? [],
      ))].sort(),
    },
  };
}

export function buildNativeVerifierInspectionRequest(input: {
  runId: string;
  objective: string;
  architectRuntimeId: string;
  projection: SchedulerProjection;
  sessions: readonly AgentSessionProjection[];
  risk: BuildRiskAssessmentProjection;
  preferredRuntimeId?: string;
  providerRetryDeadlineMs?: number;
  signal?: AbortSignal;
}): NativeVerifierInspectionRequest {
  const integrationRevision = input.projection.integrationRevision;
  const finalVerification = input.projection.finalVerification?.current;
  if (
    !integrationRevision || !finalVerification ||
    finalVerification.state !== "current" ||
    finalVerification.targetRevision !== integrationRevision ||
    finalVerification.submissionResult?.green !== true ||
    input.risk.state !== "current" ||
    input.risk.targetRevision !== integrationRevision
  ) {
    throw new Error(
      "Native verifier context requires current risk and green final verification for the integration revision.",
    );
  }
  const reviews = Object.values(input.projection.reviewHistory ?? {})
    .flatMap((history) => history)
    .concat(
      Object.entries(input.projection.reviewHistory ?? {}).length === 0
        ? Object.values(input.projection.reviews)
        : [],
    )
    .sort((left, right) =>
      left.taskId.localeCompare(right.taskId) ||
      (left.attempt ?? 0) - (right.attempt ?? 0)
    );
  const guidance = [
    ...Object.values(input.projection.userGuidance).map((item) => ({
      id: item.guidanceId,
      kind: "user_guidance" as const,
      version: item.version,
      text: item.text,
    })),
    ...Object.values(input.projection.guidance)
      .filter((item) => item.status === "answered" && item.answer)
      .map((item) => ({
        id: item.requestId,
        kind: "architect_answer" as const,
        version: item.version,
        text: item.answer!,
      })),
    ...Object.values(input.projection.architectQuestions)
      .filter((item) => item.status === "answered" && item.answer)
      .map((item) => ({
        id: item.questionId,
        kind: "architect_answer" as const,
        version: item.version,
        text: item.answer!,
      })),
  ].sort((left, right) => left.id.localeCompare(right.id));
  const changes = acceptedChangeSessions(input.projection, input.sessions)
    .map((session) => {
      const changeSet = session.changeSet!;
      return {
        taskId: changeSet.taskId,
        attempt: input.projection.tasks[changeSet.taskId]?.attempt ?? 1,
        changeSetId: changeSet.id,
        authorRuntimeId: session.actor.id,
        baselineRevision: changeSet.baselineRevision,
        taskRevision: changeSet.taskRevision,
        changedPaths: [...changeSet.changedPaths],
        diffArtifactHash: changeSet.diffArtifactHash,
      };
    })
    .sort((left, right) =>
      left.taskId.localeCompare(right.taskId) ||
      left.changeSetId.localeCompare(right.changeSetId)
    );
  return {
    runId: input.runId,
    objective: input.objective,
    targetRevision: integrationRevision,
    architectRuntimeId: input.architectRuntimeId,
    criteria: Object.values(input.projection.tasks)
      .filter(
        (task) =>
          task.status !== "cancelled" &&
          task.kind !== "final_verification",
      )
      .flatMap((task) => (task.acceptanceCriteria ?? []).map((criterion) => ({
        taskId: task.id,
        taskTitle: task.objective,
        criterion: { ...criterion },
      })))
      .sort((left, right) =>
        left.taskId.localeCompare(right.taskId) ||
        left.criterion.id.localeCompare(right.criterion.id)
      ),
    reviews: reviews.map((review) => ({
      taskId: review.taskId,
      attempt: review.attempt ?? input.projection.tasks[review.taskId]?.attempt ?? 1,
      status: review.status,
      ...(review.summary ? { summary: review.summary } : {}),
      evidenceArtifactHashes: [...review.evidenceArtifactHashes],
      ...(review.criterionVerdicts
        ? {
            criterionVerdicts: review.criterionVerdicts.map((verdict) => ({
              ...verdict,
              evidenceIds: [...verdict.evidenceIds],
              ...(verdict.artifactHashes
                ? { artifactHashes: [...verdict.artifactHashes] }
                : {}),
            })),
          }
        : {}),
    })),
    guidance,
    changes,
    finalVerification: {
      generationId: finalVerification.generationId,
      targetRevision: finalVerification.targetRevision,
      green: finalVerification.submissionResult.green,
      checks: finalVerification.submissionResult.checks.map((check) => ({
        ...check,
        evidenceIds: [...check.evidenceIds],
        facts: check.facts.map((fact) => structuredClone(fact)),
        issues: [],
      })),
    },
    riskReasons: input.risk.assessment.reasons.map((reason) => ({
      ...reason,
      evidence: [...reason.evidence],
    })),
    ...(input.preferredRuntimeId
      ? { preferredRuntimeId: input.preferredRuntimeId }
      : {}),
    ...(input.providerRetryDeadlineMs !== undefined
      ? { providerRetryDeadlineMs: input.providerRetryDeadlineMs }
      : {}),
    ...(input.signal ? { signal: input.signal } : {}),
  };
}

function acceptedChangeSessions(
  projection: SchedulerProjection,
  sessions: readonly AgentSessionProjection[],
): AgentSessionProjection[] {
  const acceptedIds = new Set(
    Object.values(projection.tasks)
      .filter(
        (task) => task.status === "integrated" && Boolean(task.changeSetId),
      )
      .map((task) => task.changeSetId!),
  );
  return sessions.filter(
    (session) =>
      session.actor.role === "worker" &&
      Boolean(session.changeSet) &&
      acceptedIds.has(session.changeSet!.id) &&
      projection.tasks[session.changeSet!.taskId]?.changeSetId ===
        session.changeSet!.id,
  );
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

function persistProviderHealth(
  store: SqliteSchedulerStore,
  runId: string,
  state: ProviderHealthState,
  source: string,
): void {
  store.append({
    runId,
    type: "provider.health_changed",
    occurredAt: new Date(state.updatedAt).toISOString(),
    actor: { role: "runner", id: "runtime-router" },
    idempotencyKey: [
      "provider-health",
      source,
      state.providerId,
      state.updatedAt,
      state.consecutiveFailures,
      state.status,
    ].join(":"),
    payload: { state: { ...state } },
  });
}

function selectConfigs(
  configs: readonly RunnerProviderConfig[],
  spec: NativeBuildSpec
): RunnerProviderConfig[] {
  const required = new Set([
    spec.architectRuntimeId,
    ...spec.workerRuntimeIds,
    ...spec.verifierRuntimeIds,
  ]);
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
  verifiers: AgentRuntimeCandidate[];
} {
  const selected = selectConfigs(configs, spec);
  const all = selected.map(toCandidate);
  const workerIds = new Set(spec.workerRuntimeIds);
  const verifierIds = new Set(spec.verifierRuntimeIds);
  return {
    configs: selected,
    all,
    workers: all.filter((candidate) => workerIds.has(candidate.runtimeId)),
    verifiers: all.filter((candidate) => verifierIds.has(candidate.runtimeId)),
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
  if (spec.verifierRuntimeIds.includes(config.runtimeId)) roles.add("verifier");
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
      ...(config.reasoningEffort ? { reasoningEffort: config.reasoningEffort } : {}),
    });
  }
  if (config.transport === "google") {
    return new GoogleModel({
      ...(config.baseUrl ? { baseUrl: config.baseUrl } : {}),
      apiKey: config.secret,
      modelId: config.modelId,
      ...(config.reasoningEffort ? { reasoningEffort: config.reasoningEffort } : {}),
    });
  }
  if (!config.baseUrl) {
    throw new Error(`OpenAI-compatible runtime ${config.runtimeId} requires a baseUrl.`);
  }
  return new OpenAICompatibleModel({
    baseUrl: config.baseUrl,
    apiKey: config.secret,
    modelId: config.modelId,
    providerId: config.providerId,
    ...(config.protocol
      ? { protocol: config.protocol }
      : config.providerId === "xai"
        ? { protocol: "responses" as const }
        : {}),
    ...(config.reasoningEffort ? { reasoningEffort: config.reasoningEffort } : {}),
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
