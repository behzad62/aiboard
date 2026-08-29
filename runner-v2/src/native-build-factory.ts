import { createHash } from "node:crypto";
import { statSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { AccountRunnerModel } from "./account-runner-model.js";
import { AnthropicModel } from "./anthropic-model.js";
import type { AgentModel } from "./agent-contracts.js";
import {
  rebuildBudgetProjection,
  type BudgetProjection,
  type ModelCostBasisSnapshot,
} from "./budget-ledger.js";
import { ArtifactStore } from "./artifact-store.js";
import { ArtifactReachabilityGuard } from "./artifact-reachability.js";
import { CapabilityRegistry } from "./capability-registry.js";
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
import { cloneBuildSpec, type NativeBuildSpec } from "./build-spec.js";
import { IntegrationManager } from "./integration-manager.js";
import { FinalVerificationRuntime } from "./final-verification-runtime.js";
import {
  finalVerificationProfileDigest,
  FinalVerificationProfileAuthority,
} from "./final-verification-profile.js";
import { FinalVerificationPortAuthority } from "./final-verification-port-authority.js";
import {
  FinalVerificationDiagnosticsArchive,
  OwnedFinalVerificationCleanup,
  retireInvalidatedFinalVerificationGeneration,
  validateOwnedFinalVerificationCleanupReceipt,
  type FinalVerificationCleanupReceiptIdentity,
} from "./final-verification-cleanup.js";
import { GoogleModel } from "./google-model.js";
import { LanguageProviderRouter } from "./language-provider-router.js";
import {
  ManagedProcessService,
  readHistoricalManagedProcessObservations,
} from "./managed-process.js";
import type {
  HistoricalTerminalState,
  NativeBuildRuntimeHandle,
} from "./native-build-manager.js";
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
import { createConfiguredOciIsolationSelector } from "./oci-execution-isolation-provider.js";
import { createMcpTools, type McpManager } from "./mcp-tools.js";
import type { SqlitePermissionStore } from "./permission-store.js";
import type {
  ProviderConfigStore,
  RunnerProviderConfig,
} from "./provider-config-store.js";
import {
  LocalPluginLoader,
  RunnerExtensionLoadError,
  type LoadedRunnerExtensions,
  type RunnerExtensionCleanupDisposer,
} from "./plugin-loader.js";
import {
  emptyRunnerCapabilitiesConfig,
  type RunnerCapabilitiesConfig,
} from "./runner-capabilities-config.js";
import {
  attestRunnerCapabilitiesLanguageServers,
  RunnerCapabilityContractError,
  cloneRunnerCapabilityContract,
  createRunnerCapabilityContractSnapshot,
  runnerCapabilitiesForContract,
  runnerCapabilitySnapshotExtensionDirectories,
  validateRunnerCapabilityContract,
  validateRunnerCapabilityContractSnapshot,
  type RunnerCapabilityContractErrorCode,
} from "./runner-capability-contract.js";
import { RUNNER_BUILTIN_TOOL_NAMES } from "./runner-extension.js";
import { RepositoryIntelligence } from "./repository-intelligence.js";
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
  type SkillMetadata,
} from "./skill-catalog.js";
import type {
  HistoricalReadProvenance,
} from "./historical-read-provenance.js";
import { SqliteAgentSessionStore } from "./sqlite-agent-session-store.js";
import { SqliteBudgetLedger } from "./sqlite-budget-ledger.js";
import { SqliteEvidenceStore } from "./sqlite-evidence-store.js";
import { SqliteProjectMemoryStore } from "./sqlite-project-memory.js";
import { rebuildProjectMemories } from "./project-memory.js";
import { SqliteSchedulerStore } from "./sqlite-scheduler-store.js";
import { SqliteToolLedger } from "./sqlite-tool-ledger.js";
import type { ToolLedgerEvent } from "./tool-ledger.js";
import { TypeScriptIntelligence } from "./typescript-intelligence.js";
import { SchedulerVerifierVerdictAuthority } from "./verifier-verdict-authority.js";
import { WorkspaceManager } from "./workspace-manager.js";
import { VerificationWorkspaceManager } from "./verification-workspace.js";

export type NativeBuildRuntimeResourceStage =
  | "capabilities"
  | "execution_isolation"
  | "evidence_store"
  | "scheduler_store"
  | "session_store"
  | "tool_ledger"
  | "budget_ledger"
  | "workspace_manager"
  | "integration_workspace"
  | "verification_workspace"
  | "independent_verifier_workspace"
  | "memory_store"
  | "managed_process_service";

export type NativeBuildRuntimeInitializationStage =
  | NativeBuildRuntimeResourceStage
  | "baseline"
  | "runtime_configuration"
  | "runtime_drivers";

/** A bounded, attributable failure while rebuilding a live native Build. */
export class NativeBuildRuntimeInitializationError extends Error {
  constructor(
    readonly stage: NativeBuildRuntimeInitializationStage,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "NativeBuildRuntimeInitializationError";
  }
}

export type NativeBuildRecoveryErrorClassification =
  | { kind: "capability"; code: RunnerCapabilityContractErrorCode }
  | { kind: "runtime"; stage: NativeBuildRuntimeInitializationStage };

/**
 * Cleanup aggregation must not erase the attributable construction failure.
 * The primary error is always first, but recursively walking also handles the
 * capability loader's own startup-plus-cleanup aggregate.
 */
export function classifyNativeBuildRecoveryError(
  error: unknown,
): NativeBuildRecoveryErrorClassification | undefined {
  return classifyNativeBuildRecoveryErrorValue(error, new Set());
}

function classifyNativeBuildRecoveryErrorValue(
  error: unknown,
  seen: Set<unknown>,
): NativeBuildRecoveryErrorClassification | undefined {
  if (seen.has(error)) return undefined;
  seen.add(error);
  if (error instanceof RunnerCapabilityContractError) {
    return { kind: "capability", code: error.code };
  }
  if (error instanceof NativeBuildRuntimeInitializationError) {
    return { kind: "runtime", stage: error.stage };
  }
  if (error instanceof AggregateError) {
    for (const nested of error.errors) {
      const classified = classifyNativeBuildRecoveryErrorValue(nested, seen);
      if (classified) return classified;
    }
  }
  if (error instanceof Error && error.cause !== undefined) {
    return classifyNativeBuildRecoveryErrorValue(error.cause, seen);
  }
  return undefined;
}

/** Test seam for exercising every construction boundary with real resources. */
export interface NativeBuildRuntimeConstructionHooks {
  afterAcquire?(stage: NativeBuildRuntimeResourceStage): void | Promise<void>;
  beforeCleanup?(stage: NativeBuildRuntimeResourceStage): void | Promise<void>;
}

export interface NativeBuildFactoryOptions {
  projectRoot: string;
  stateDirectory: string;
  providerConfigs: ProviderConfigStore;
  mcpManager?: McpManager;
  permissions?: SqlitePermissionStore;
  capabilitiesConfig?: RunnerCapabilitiesConfig;
  baselineFor(runId: string): string;
  skillRoots?: readonly SharedSkillRoot[];
  /** The CLI owns provider configuration cleanup when it manages the full process lifecycle. */
  closeProviderConfigs?: boolean;
  /** Injected only by focused lifecycle tests; live callers leave this undefined. */
  runtimeConstructionHooks?: NativeBuildRuntimeConstructionHooks;
}

export class NativeBuildFactory {
  private readonly artifacts: ArtifactStore;
  private readonly artifactReachability: ArtifactReachabilityGuard;
  private memoryStore: SqliteProjectMemoryStore | undefined;
  private readonly browserBackend: PlaywrightBrowserBackend;
  private managedProcesses: ManagedProcessService | undefined;
  private readonly incompleteConstructionCleanups = new Set<NativeBuildResourceCleanupStack>();
  private closePromise: Promise<void> | undefined;
  private providerConfigsClosed = false;
  private browserBackendClosed = false;
  private closed = false;

  constructor(private readonly options: NativeBuildFactoryOptions) {
    this.artifacts = new ArtifactStore(join(options.stateDirectory, "artifacts"));
    this.artifactReachability = new ArtifactReachabilityGuard(
      options.stateDirectory,
      this.artifacts
    );
    this.browserBackend = new PlaywrightBrowserBackend(
      join(options.stateDirectory, "browser-sessions")
    );
  }

  async prepareSpec(spec: NativeBuildSpec): Promise<NativeBuildSpec> {
    if (this.closed) throw new Error("Native Build factory is closed.");
    const config = this.capabilitiesConfig();
    return {
      ...cloneBuildSpec(spec),
      capabilityContract: await createRunnerCapabilityContractSnapshot(
        config,
        this.options.stateDirectory,
        { commandSearchDirectory: this.options.projectRoot },
      ),
    };
  }

  async validateRecoveryCapabilityContract(spec: NativeBuildSpec): Promise<void> {
    if (this.closed) throw new Error("Native Build factory is closed.");
    await validateRunnerCapabilityContract(
      spec.capabilityContract,
      this.capabilitiesConfig(),
      { commandSearchDirectory: this.options.projectRoot },
    );
  }

  async create(spec: NativeBuildSpec): Promise<NativeBuildRuntimeHandle> {
    if (this.closed) throw new Error("Native Build factory is closed.");
    await this.closeIncompleteConstructionResources();
    if (!spec.capabilityContract) {
      throw new Error("Native Build runtime requires a Runner-prepared capability contract.");
    }
    await this.validateRecoveryCapabilityContract(spec);
    await validateRunnerCapabilityContractSnapshot(
      spec.capabilityContract,
      this.options.stateDirectory,
    );
    const capabilitiesConfig = runnerCapabilitiesForContract(
      this.capabilitiesConfig(),
      spec.capabilityContract,
    );
    const runRoot = join(this.options.stateDirectory, "builds", safeSegment(spec.runId));
    await mkdir(runRoot, { recursive: true });
    const constructionResources = new NativeBuildResourceCleanupStack(
      this.options.runtimeConstructionHooks,
    );
    let initializationStage: NativeBuildRuntimeInitializationStage = "capabilities";
    try {
    initializationStage = "execution_isolation";
    const executionIsolation = await createConfiguredOciIsolationSelector(
      capabilitiesConfig,
      join(runRoot, "execution-isolation"),
    );
    assertIsolationRecoveryClear(await executionIsolation.recoverOwnedLeases());
    constructionResources.add("execution_isolation", async () => {
      assertIsolationRecoveryClear(await executionIsolation.recoverOwnedLeases());
    }, true);
    await this.options.runtimeConstructionHooks?.afterAcquire?.("execution_isolation");
    initializationStage = "capabilities";
    const runCapabilities = await createNativeRunCapabilities({
      config: {
        ...capabilitiesConfig,
        extensions: runnerCapabilitySnapshotExtensionDirectories(
          spec.capabilityContract,
          this.options.stateDirectory,
        ),
      },
      projectDirectory: this.options.projectRoot,
      stateDirectory: runRoot,
      verifyExtensionIntegrity: async () => {
        await validateRunnerCapabilityContractSnapshot(
          spec.capabilityContract!,
          this.options.stateDirectory,
        );
      },
      reservedToolNames: [
        ...RUNNER_BUILTIN_TOOL_NAMES,
        ...(this.options.mcpManager
          ? createMcpTools(this.options.mcpManager, this.artifacts).map(
              (tool) => tool.definition.name,
            )
          : []),
      ],
    });
    constructionResources.add("capabilities", () => runCapabilities.close(), true);
    await this.options.runtimeConstructionHooks?.afterAcquire?.("capabilities");
    initializationStage = "baseline";
    const baselineRevision = this.options.baselineFor(spec.runId);
    initializationStage = "runtime_configuration";
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
    initializationStage = "evidence_store";
    const evidenceStore = new SqliteEvidenceStore(join(runRoot, "evidence.sqlite"));
    constructionResources.add("evidence_store", () => evidenceStore.close(), true);
    await this.options.runtimeConstructionHooks?.afterAcquire?.("evidence_store");
    const finalVerificationPorts = new FinalVerificationPortAuthority(this.options.stateDirectory);
    const finalVerificationProfiles = new FinalVerificationProfileAuthority({
      stateDirectory: this.options.stateDirectory,
      runId: spec.runId,
      portAuthority: finalVerificationPorts,
    });
    initializationStage = "scheduler_store";
    const schedulerStore = new SqliteSchedulerStore(join(runRoot, "scheduler.sqlite"), {
      evidenceStore,
      artifacts: this.artifacts,
      validateCleanupReceipt: (identity) =>
        validateOwnedFinalVerificationCleanupReceipt(this.options.stateDirectory, identity),
      validateExecutionProfile: ({ targetRevision, profile }) =>
        finalVerificationProfiles.validate(profile, targetRevision),
    });
    constructionResources.add("scheduler_store", () => schedulerStore.close(), true);
    await this.options.runtimeConstructionHooks?.afterAcquire?.("scheduler_store");
    const schedulerEvents = schedulerStore.readRun(spec.runId);
    initializationStage = "session_store";
    const sessions = new SqliteAgentSessionStore(
      join(runRoot, "sessions.sqlite"),
      this.artifacts,
      {
        deleteArtifactIfGloballyUnreachable: (hash) =>
          this.artifactReachability.removeIfGloballyUnreachable(hash),
      }
    );
    constructionResources.add("session_store", () => sessions.close(), true);
    await this.options.runtimeConstructionHooks?.afterAcquire?.("session_store");
    initializationStage = "tool_ledger";
    const ledger = new SqliteToolLedger(join(runRoot, "tool-ledger.sqlite"));
    constructionResources.add("tool_ledger", () => ledger.close(), true);
    await this.options.runtimeConstructionHooks?.afterAcquire?.("tool_ledger");
    initializationStage = "budget_ledger";
    const budgetLedger = new SqliteBudgetLedger(join(runRoot, "budget.sqlite"), {
      limitsFor: (scopeId) => {
        if (scopeId !== spec.runId) throw new Error(`Unknown budget scope ${scopeId}.`);
        return { ...spec.budgetLimits };
      },
    });
    constructionResources.add("budget_ledger", () => budgetLedger.close(), true);
    await this.options.runtimeConstructionHooks?.afterAcquire?.("budget_ledger");
    budgetLedger.recoverInterruptedActive(
      spec.runId,
      `startup-recovery:${spec.runId}`,
    );
    initializationStage = "workspace_manager";
    const workspaceManager = new WorkspaceManager({
      repositoryRoot: this.options.projectRoot,
      stateDirectory: this.options.stateDirectory,
      runId: spec.runId,
      baselineRevision,
    });
    constructionResources.add("workspace_manager", () => workspaceManager.cleanup());
    await this.options.runtimeConstructionHooks?.afterAcquire?.("workspace_manager");
    initializationStage = "integration_workspace";
    const integrationManager = new IntegrationManager({
      repositoryRoot: this.options.projectRoot,
      stateDirectory: this.options.stateDirectory,
      runId: spec.runId,
      baselineRevision,
      initializationMode: integrationInitializationModeFromEvents(schedulerEvents),
    });
    constructionResources.add("integration_workspace", () => integrationManager.cleanup());
    await integrationManager.initialize();
    await this.options.runtimeConstructionHooks?.afterAcquire?.("integration_workspace");
    initializationStage = "verification_workspace";
    const verificationWorkspace = new VerificationWorkspaceManager({
      repositoryRoot: integrationManager.path,
      stateDirectory: this.options.stateDirectory,
      runId: spec.runId,
      integrationManager,
    });
    constructionResources.add("verification_workspace", () => verificationWorkspace.cleanup());
    await this.options.runtimeConstructionHooks?.afterAcquire?.("verification_workspace");
    initializationStage = "independent_verifier_workspace";
    const verifierWorkspace = new VerificationWorkspaceManager({
      repositoryRoot: integrationManager.path,
      stateDirectory: this.options.stateDirectory,
      runId: spec.runId,
      integrationManager,
      kind: "independent-verifier",
    });
    constructionResources.add(
      "independent_verifier_workspace",
      () => verifierWorkspace.cleanup(),
    );
    await this.options.runtimeConstructionHooks?.afterAcquire?.("independent_verifier_workspace");
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
      stopRun: (runId) => this.liveManagedProcesses().stopRun(runId),
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
    const hadMemoryStore = this.memoryStore !== undefined;
    initializationStage = "memory_store";
    const memoryStore = this.liveMemoryStore();
    if (!hadMemoryStore) {
      constructionResources.add("memory_store", () => {
        memoryStore.close();
        if (this.memoryStore === memoryStore) this.memoryStore = undefined;
      });
    }
    await this.options.runtimeConstructionHooks?.afterAcquire?.("memory_store");
    const hadManagedProcesses = this.managedProcesses !== undefined;
    initializationStage = "managed_process_service";
    const managedProcesses = this.liveManagedProcesses();
    if (!hadManagedProcesses) {
      constructionResources.add("managed_process_service", () => {
        managedProcesses.close();
        if (this.managedProcesses === managedProcesses) this.managedProcesses = undefined;
      });
    }
    await this.options.runtimeConstructionHooks?.afterAcquire?.("managed_process_service");
    initializationStage = "runtime_drivers";
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
      memoryStore,
      projectId: spec.projectId,
      projectRoot: this.options.projectRoot,
      capabilityRegistry: runCapabilities.registry,
      language: runCapabilities.language,
      budgetLedger,
      modelCostEstimators,
      modelCostBases,
      browserBackend: this.browserBackend,
      ...(this.options.mcpManager ? { mcpManager: this.options.mcpManager } : {}),
      ...(this.options.permissions ? { permissions: this.options.permissions } : {}),
      managedProcesses,
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
      memoryStore,
      evidenceStore,
      projectId: spec.projectId,
      projectRoot: this.options.projectRoot,
      canonicalProjectRoot: integrationManager.path,
      objective: spec.objective,
      runPolicy: spec.runPolicy,
      capabilityRegistry: runCapabilities.registry,
      language: runCapabilities.language,
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
          managedProcessService: this.liveManagedProcesses(),
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
    let closing: Promise<void> | undefined;
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
            this.liveMemoryStore().events(spec.projectId)
          ).values()],
          skills: await skillCatalog.discover(),
          processes: this.liveManagedProcesses().listRun(spec.runId).slice(-100).map(
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
          capabilities: {
            extensions: runCapabilities.registry.manifests(),
            languageProviders: runCapabilities.language.providerMetadata(),
            languageRoutes: runCapabilities.language.auditRecords(),
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
          () => this.liveManagedProcesses().stopRun(spec.runId),
          [
            () => runCapabilities.close(),
            () => sessions.compactRun(spec.runId),
            () => workspaceManager.cleanup(),
            () => verifierWorkspace.cleanup(),
            () => integrationManager.cleanup(),
          ],
          spec.runId
        );
      },
      close: async () => {
        if (closed) return;
        if (closing) return await closing;
        const attempt = (async (): Promise<void> => {
          await constructionResources.close("handle");
          closed = true;
        })();
        closing = attempt;
        try {
          await attempt;
        } finally {
          if (closing === attempt) closing = undefined;
        }
      },
    };
    } catch (error) {
      const pendingCapabilityCleanup = nativeCapabilityCleanupDisposer(error);
      if (pendingCapabilityCleanup) {
        constructionResources.add(
          "capabilities",
          () => pendingCapabilityCleanup.close(),
          true,
        );
      }
      const primary = nativeBuildConstructionFailure(initializationStage, error);
      try {
        await constructionResources.close("failure");
      } catch (cleanupError) {
        this.incompleteConstructionCleanups.add(constructionResources);
        throw aggregateConstructionFailure(spec.runId, primary, cleanupError);
      }
      throw primary;
    }
  }

  private capabilitiesConfig(): RunnerCapabilitiesConfig {
    return this.options.capabilitiesConfig ?? emptyRunnerCapabilitiesConfig();
  }

  private async closeIncompleteConstructionResources(): Promise<void> {
    const failures: unknown[] = [];
    for (const resources of [...this.incompleteConstructionCleanups]) {
      try {
        await resources.close("failure");
        if (resources.isComplete("failure")) {
          this.incompleteConstructionCleanups.delete(resources);
        }
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length > 0) {
      throw new AggregateError(
        failures,
        "Could not finish cleanup from an earlier native Build construction failure.",
      );
    }
  }

  /** Mutable global stores are constructed only for a live runtime. */
  private liveMemoryStore(): SqliteProjectMemoryStore {
    return this.memoryStore ??= new SqliteProjectMemoryStore(
      join(this.options.stateDirectory, "project-memory.sqlite"),
    );
  }

  /** Historical readers must never reconcile or persist managed-process state. */
  private liveManagedProcesses(): ManagedProcessService {
    return this.managedProcesses ??= new ManagedProcessService({
      stateDirectory: join(this.options.stateDirectory, "managed-processes"),
    });
  }

  /**
   * Reopens only durable records for a terminal Build. It deliberately does
   * not load capability code, construct models, or start owned processes.
   */
  async createHistorical(
    spec: NativeBuildSpec,
    terminalState: HistoricalTerminalState,
  ): Promise<NativeBuildRuntimeHandle> {
    if (this.closed) throw new Error("Native Build factory is closed.");
    assertHistoricalTerminalState(terminalState);
    const runRoot = join(this.options.stateDirectory, "builds", safeSegment(spec.runId));
    let evidenceStore: SqliteEvidenceStore | undefined;
    let ledger: SqliteToolLedger | undefined;
    let sessions: SqliteAgentSessionStore | undefined;
    let budgetLedger: SqliteBudgetLedger | undefined;
    let schedulerStore: SqliteSchedulerStore | undefined;
    let historicalMemoryStore: SqliteProjectMemoryStore | undefined;
    const historicalSqliteSnapshots: string[] = [];
    const closedHistoricalStores = new Set<HistoricalCloseable>();
    const removedHistoricalSqliteSnapshots = new Set<string>();
    const closeHistoricalResources = async (): Promise<unknown[]> => {
      const failures: unknown[] = [];
      // Close in reverse acquisition order. Each successful close/removal is
      // remembered so a transient failure can be retried without double-closing
      // resources that were already released.
      const stores: Array<HistoricalCloseable | undefined> = [
        historicalMemoryStore,
        schedulerStore,
        budgetLedger,
        sessions,
        ledger,
        evidenceStore,
      ];
      for (const store of stores) {
        if (!store || closedHistoricalStores.has(store)) continue;
        try {
          store.close();
          closedHistoricalStores.add(store);
        } catch (error) {
          failures.push(error);
        }
      }
      for (const directory of [...historicalSqliteSnapshots].reverse()) {
        if (removedHistoricalSqliteSnapshots.has(directory)) continue;
        try {
          await rm(directory, { recursive: true, force: true });
          removedHistoricalSqliteSnapshots.add(directory);
        } catch (error) {
          // Leave a failed directory recorded for a later close retry.
          failures.push(error);
        }
      }
      return failures;
    };
    try {
      const evidencePath = join(runRoot, "evidence.sqlite");
      const ledgerPath = join(runRoot, "tools.sqlite");
      const sessionsPath = join(runRoot, "sessions.sqlite");
      const budgetPath = join(runRoot, "budget.sqlite");
      const schedulerPath = join(runRoot, "scheduler.sqlite");
      const memoryPath = join(this.options.stateDirectory, "project-memory.sqlite");
      const managedProcessPath = join(this.options.stateDirectory, "managed-processes");
      const snapshotStorePath = async (source: string): Promise<string> => {
        const snapshot = await materializeHistoricalSqliteSnapshot(source);
        historicalSqliteSnapshots.push(snapshot.directory);
        return snapshot.databasePath;
      };
      if (hasHistoricalStore(evidencePath)) {
        evidenceStore = new SqliteEvidenceStore(await snapshotStorePath(evidencePath), {
          readOnly: true,
        });
      }
      if (hasHistoricalStore(ledgerPath)) {
        ledger = new SqliteToolLedger(await snapshotStorePath(ledgerPath), { readOnly: true });
      }
      if (hasHistoricalStore(sessionsPath)) {
        sessions = new SqliteAgentSessionStore(
          await snapshotStorePath(sessionsPath),
          this.artifacts,
          { readOnly: true },
        );
      }
      if (hasHistoricalStore(budgetPath)) {
        budgetLedger = new SqliteBudgetLedger(await snapshotStorePath(budgetPath), {
          limitsFor: () => spec.budgetLimits,
          readOnly: true,
        });
      }
      const historicalSchedulerPath = hasHistoricalStore(schedulerPath)
        ? await snapshotStorePath(schedulerPath)
        : undefined;
      if (hasHistoricalStore(memoryPath)) {
        historicalMemoryStore = new SqliteProjectMemoryStore(await snapshotStorePath(memoryPath), {
          readOnly: true,
        });
      }
      if (historicalSchedulerPath) {
        const ports = new FinalVerificationPortAuthority(this.options.stateDirectory);
        const profiles = new FinalVerificationProfileAuthority({
          stateDirectory: this.options.stateDirectory,
          runId: spec.runId,
          portAuthority: ports,
        });
        const acceptedProfiles = new Set<string>();
        const acceptedCleanupReceipts = new Set<string>();
        const profileKey = (targetRevision: string, profile: Parameters<typeof finalVerificationProfileDigest>[1]) =>
          `${targetRevision}\u0000${finalVerificationProfileDigest(spec.runId, profile)}`;
        const cleanupReceiptKey = (identity: FinalVerificationCleanupReceiptIdentity) =>
          JSON.stringify(identity);
        const openingSchedulerStore = new SqliteSchedulerStore(historicalSchedulerPath, {
          evidenceStore,
          artifacts: this.artifacts,
          validateExecutionProfile: ({ targetRevision, profile }) => {
            profiles.validate(profile, targetRevision);
            acceptedProfiles.add(profileKey(targetRevision, profile));
          },
          validateCleanupReceipt: (identity) => {
            validateOwnedFinalVerificationCleanupReceipt(this.options.stateDirectory, identity);
            acceptedCleanupReceipts.add(cleanupReceiptKey(identity));
          },
          readOnly: true,
        });
        try {
          // Authenticate every terminal event against the live Runner-owned
          // archives once, before freezing the accepted identities below.
          openingSchedulerStore.readRun(spec.runId);
        } finally {
          openingSchedulerStore.close();
        }
        schedulerStore = new SqliteSchedulerStore(historicalSchedulerPath, {
          evidenceStore,
          artifacts: this.artifacts,
          validateExecutionProfile: ({ targetRevision, profile }) => {
            if (!acceptedProfiles.has(profileKey(targetRevision, profile))) {
              throw new Error("Historical final verification profile was not authenticated at handle open.");
            }
          },
          validateCleanupReceipt: (identity) => {
            if (!acceptedCleanupReceipts.has(cleanupReceiptKey(identity))) {
              throw new Error("Historical final verification cleanup receipt was not authenticated at handle open.");
            }
          },
          readOnly: true,
        });
      }
      let integrationManager: IntegrationManager | undefined;
      const historicalIntegrationManager = (): IntegrationManager => {
        integrationManager ??= new IntegrationManager({
          repositoryRoot: this.options.projectRoot,
          stateDirectory: this.options.stateDirectory,
          runId: spec.runId,
          baselineRevision: this.options.baselineFor(spec.runId),
          initializationMode: "cleanup-only",
        });
        return integrationManager;
      };
      const readEvents = (afterSequence = 0): SchedulerEvent[] =>
        schedulerStore?.readRun(spec.runId, afterSequence) ?? [];
      const budgetProjection = () =>
        budgetLedger?.snapshot(spec.runId) ?? rebuildBudgetProjection(spec.runId, []);
      const usageProvenance: HistoricalReadProvenance = budgetLedger
        ? "durable"
        : "unavailable";
      const transcriptProvenance = async (): Promise<HistoricalReadProvenance> =>
        sessions
          ? await sessions.historicalTranscriptProvenance(spec.runId)
          : "unavailable";
      const evidenceProvenance = (): HistoricalReadProvenance =>
        evidenceStore?.historicalProvenance() ?? "unavailable";
      const memoryProvenance = (): HistoricalReadProvenance =>
        historicalMemoryStore?.historicalProvenance() ?? "unavailable";
      const processProvenance: HistoricalReadProvenance = hasHistoricalDirectory(managedProcessPath)
        ? "durable"
        : "unavailable";
      const historicalUsage = () => {
        const budget = budgetProjection();
        return {
          ...budget,
          attributedModelReservationCount: Object.values(budget.reservations).filter(
            (reservation) => reservation.kind === "model" && reservation.attribution,
          ).length,
          models: usageProvenance === "durable"
            ? projectNativeModelUsage({
                budget,
                runtimes: historicalModelUsageRuntimes(budget),
                providerHealth: providerHealthFromSchedulerEvents(readEvents()),
              })
            : [],
          historicalProvenance: usageProvenance,
        };
      };
      const historicalSkills = (): {
        skills: SkillMetadata[];
        provenance: HistoricalReadProvenance;
      } => {
        if (!ledger) return { skills: [], provenance: "unavailable" };
        const skills = skillsFromHistoricalToolLedger(ledger.listRun(spec.runId));
        return skills
          ? { skills, provenance: "durable" }
          : { skills: [], provenance: "unavailable" };
      };
      const historicalMemories = (): import("./project-memory.js").ProjectMemoryEntry[] => {
        if (memoryProvenance() === "unavailable") return [];
        return [...rebuildProjectMemories(
          historicalMemoryStore!.events(spec.projectId),
        ).values()].filter((memory) => memory.runId === spec.runId);
      };
      const projection = () => historicalSchedulerProjection(
        spec,
        readEvents(),
        terminalState,
      );
      // SQLite inputs are materialized above, but managed-process records and
      // diagnostic archives are bounded filesystem surfaces. Freeze them at
      // historical-open time so every later audit remains an observation of
      // the terminal state rather than a fresh read of mutable live files.
      const historicalProcesses = processProvenance === "durable"
        ? readHistoricalManagedProcessObservations(managedProcessPath, spec.runId)
        : [];
      const historicalFinalGeneration = projection().finalVerification?.current;
      const historicalFinalVerificationDiagnostics = historicalFinalGeneration
        ? await loadHistoricalFinalVerificationDiagnostics({
            stateDirectory: this.options.stateDirectory,
            runId: spec.runId,
            diagnosticsPath: historicalFinalGeneration.cleanup?.diagnosticsPath,
            generationId: historicalFinalGeneration.generationId,
            taskId: historicalFinalGeneration.taskId,
            targetRevision: historicalFinalGeneration.targetRevision,
          })
        : undefined;
      const readOnlyError = (): never => {
        throw new Error(`Historical Build ${spec.runId} is read-only.`);
      };
      const runtime = {
        id: spec.runId,
        projection,
        events: (afterSequence = 0) => readEvents(afterSequence),
        step: async () => readOnlyError(),
        runUntilBlocked: async () => readOnlyError(),
        pause: () => readOnlyError(),
        resume: () => readOnlyError(),
        continue: () => readOnlyError(),
        selectArchitectHandoff: () => readOnlyError(),
        selectVerifierRuntime: () => readOnlyError(),
        submitUserGuidance: () => readOnlyError(),
        submitManagedUserGuidance: () => readOnlyError(),
        completeManagedUserGuidanceInterruption: () => readOnlyError(),
        answerArchitectQuestion: () => readOnlyError(),
        selectProjectHandoff: () => readOnlyError(),
      } as unknown as BuildRuntime;
      let closed = false;
      let closing: Promise<void> | undefined;
      return {
        runtime,
        historical: true,
        usage: historicalUsage,
        observability: async (): Promise<BuildObservabilitySnapshot> => {
          const schedulerEvents = readEvents();
          const transcriptHistoryProvenance = await transcriptProvenance();
          const schedulerProjection = historicalSchedulerProjection(
            spec,
            schedulerEvents,
            terminalState,
          );
          const agentSessions = transcriptHistoryProvenance === "unavailable"
            ? []
            : await sessions!.listRun(spec.runId);
          const toolCalls = ledger ? summarizeToolCalls(ledger.listRun(spec.runId)) : [];
          const skillSnapshot = historicalSkills();
          const integrationRevision = schedulerProjection.projectHandoff?.integrationRevision
            ?? schedulerProjection.integrationRevision;
          return {
            runId: spec.runId,
            budget: historicalUsage(),
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
            evidence: evidenceProvenance() === "unavailable"
              ? []
              : evidenceStore!.list({ runId: spec.runId, limit: 1_000 }),
            memories: historicalMemories(),
            skills: skillSnapshot.skills,
            processes: processProvenance === "durable"
              ? structuredClone(historicalProcesses)
              : [],
            providers: Object.values(schedulerProjection.runtime.providerHealth),
            events: schedulerEvents.slice(-1_000),
            git: {
              integrationBranch: schedulerProjection.projectHandoff?.integrationBranch ?? "",
              integrationRevision: integrationRevision ?? "",
              commits: integrationRevision
                ? await historicalIntegrationManager().historicalHistory(integrationRevision)
                : [],
            },
            ...(spec.capabilityContract
              ? {
                  capabilities: {
                    extensions: [],
                    languageProviders: [],
                    languageRoutes: [],
                    historicalContract: cloneRunnerCapabilityContract(spec.capabilityContract),
                  },
                }
              : {}),
            historical: {
              terminalState,
              provenance: {
                usage: usageProvenance,
                transcript: transcriptHistoryProvenance,
                evidence: evidenceProvenance(),
                memories: memoryProvenance(),
                skills: skillSnapshot.provenance,
                processes: processProvenance,
                capabilities: spec.capabilityContract ? "durable" : "unavailable",
                events: schedulerStore ? "durable" : "unavailable",
                files: integrationRevision ||
                  (schedulerProjection.projectHandoff?.appliedToProject &&
                    schedulerProjection.projectHandoff.projectRevision)
                  ? "durable"
                  : "unavailable",
              },
            },
            finalVerification: projectFinalVerificationObservability(
              schedulerProjection,
              historicalFinalVerificationDiagnostics && structuredClone(historicalFinalVerificationDiagnostics),
            ),
            independentVerifier:
              projectIndependentVerifierObservability(schedulerProjection),
          };
        },
        transcript: async (afterSequence = 0) => {
          const provenance = await transcriptProvenance();
          const page = provenance === "unavailable"
            ? { turns: [], cursor: afterSequence }
            : await sessions!.transcript(spec.runId, afterSequence);
          return { ...page, historicalProvenance: provenance };
        },
        files: async () => {
          const schedulerProjection = projection();
          const handoff = schedulerProjection.projectHandoff;
          const integrationRevision = handoff?.integrationRevision
            ?? schedulerProjection.integrationRevision;
          if (!integrationRevision && !(handoff?.appliedToProject && handoff.projectRevision)) {
            return {
              source: "integration",
              revision: "",
              appliedToProject: false,
              omittedFileCount: 0,
              files: [],
              historicalProvenance: "unavailable",
            };
          }
          return {
            ...(await historicalIntegrationManager().historicalFiles({
            integrationRevision,
            appliedToProject: handoff?.appliedToProject,
            projectRevision: handoff?.projectRevision,
            })),
            historicalProvenance: "durable",
          };
        },
        compact: () => readOnlyError(),
        projectHandoff: async () => readOnlyError(),
        cleanup: () => readOnlyError(),
        close: async () => {
          if (closed) return;
          if (closing) return await closing;
          const attempt = (async (): Promise<void> => {
            const failures = await closeHistoricalResources();
            if (failures.length > 0) {
              throw new AggregateError(
                failures,
                `Could not close all historical Build ${spec.runId} resources.`,
              );
            }
            closed = true;
          })();
          closing = attempt;
          try {
            await attempt;
          } finally {
            if (closing === attempt) closing = undefined;
          }
        },
      };
    } catch (error) {
      const cleanupFailures = await closeHistoricalResources();
      if (cleanupFailures.length > 0) {
        throw new AggregateError(
          [error, ...cleanupFailures],
          `Could not open historical Build ${spec.runId} and clean up its resources.`,
        );
      }
      throw error;
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    if (this.closePromise) return await this.closePromise;
    const attempt = (async (): Promise<void> => {
      const failures: unknown[] = [];
      try {
        await this.closeIncompleteConstructionResources();
      } catch (error) {
        failures.push(error);
      }
      if (this.memoryStore) {
        try {
          this.memoryStore.close();
          this.memoryStore = undefined;
        } catch (error) {
          failures.push(error);
        }
      }
      if (!this.providerConfigsClosed && this.options.closeProviderConfigs !== false) {
        try {
          this.options.providerConfigs.close();
          this.providerConfigsClosed = true;
        } catch (error) {
          failures.push(error);
        }
      }
      if (this.managedProcesses) {
        try {
          this.managedProcesses.close();
          this.managedProcesses = undefined;
        } catch (error) {
          failures.push(error);
        }
      }
      if (!this.browserBackendClosed) {
        try {
          await this.browserBackend.closeAll();
          this.browserBackendClosed = true;
        } catch (error) {
          failures.push(error);
        }
      }
      if (failures.length > 0) {
        throw new AggregateError(failures, "Could not close native Build factory resources.");
      }
      this.closed = true;
    })();
    this.closePromise = attempt;
    try {
      await attempt;
    } finally {
      if (this.closePromise === attempt) this.closePromise = undefined;
    }
  }

  async runArtifactCompaction<T>(operation: () => Promise<T>): Promise<T> {
    return await this.artifactReachability.runQuiescent(operation);
  }

  async prepareArtifactCleanup(): Promise<void> {
    await this.artifactReachability.prepareReachabilityIndex();
  }
}

type NativeBuildResourceCleanupMode = "failure" | "handle";

interface NativeBuildResourceCleanupEntry {
  stage: NativeBuildRuntimeResourceStage;
  cleanup(): void | Promise<void>;
  closeOnHandle: boolean;
  completedOnFailure: boolean;
  completedOnHandle: boolean;
}

/**
 * Keeps live Build construction ownership explicit until the returned handle
 * takes over. Failed cleanup entries remain retryable instead of being hidden
 * behind a prematurely-set closed flag.
 */
class NativeBuildResourceCleanupStack {
  private readonly entries: NativeBuildResourceCleanupEntry[] = [];
  private readonly closing = new Map<NativeBuildResourceCleanupMode, Promise<void>>();

  constructor(private readonly hooks?: NativeBuildRuntimeConstructionHooks) {}

  add(
    stage: NativeBuildRuntimeResourceStage,
    cleanup: () => void | Promise<void>,
    closeOnHandle = false,
  ): void {
    this.entries.push({
      stage,
      cleanup,
      closeOnHandle,
      completedOnFailure: false,
      completedOnHandle: false,
    });
  }

  isComplete(mode: NativeBuildResourceCleanupMode): boolean {
    return this.entries.every((entry) =>
      mode === "failure"
        ? entry.completedOnFailure
        : !entry.closeOnHandle || entry.completedOnHandle,
    );
  }

  async close(mode: NativeBuildResourceCleanupMode): Promise<void> {
    const inFlight = this.closing.get(mode);
    if (inFlight) return await inFlight;
    const attempt = this.closeEntries(mode);
    this.closing.set(mode, attempt);
    try {
      await attempt;
    } finally {
      if (this.closing.get(mode) === attempt) this.closing.delete(mode);
    }
  }

  private async closeEntries(mode: NativeBuildResourceCleanupMode): Promise<void> {
    const failures: unknown[] = [];
    for (const entry of [...this.entries].reverse()) {
      if (mode === "handle" && !entry.closeOnHandle) continue;
      if (mode === "failure" ? entry.completedOnFailure : entry.completedOnHandle) continue;
      try {
        await this.hooks?.beforeCleanup?.(entry.stage);
        await entry.cleanup();
        if (mode === "failure") {
          entry.completedOnFailure = true;
        } else {
          entry.completedOnHandle = true;
        }
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length > 0) {
      throw new AggregateError(
        failures,
        `Could not close all native Build ${mode} resources.`,
      );
    }
  }
}

function nativeBuildConstructionFailure(
  stage: NativeBuildRuntimeInitializationStage,
  error: unknown,
): unknown {
  if (error instanceof RunnerCapabilityContractError) return error;
  if (error instanceof NativeBuildRuntimeInitializationError) return error;
  if (stage === "capabilities") {
    return new RunnerCapabilityContractError(
      "capability_preflight_failed",
      `Native Build capability startup failed: ${boundedErrorMessage(error)}.`,
      { cause: error },
    );
  }
  return new NativeBuildRuntimeInitializationError(
    stage,
    `Native Build ${stage} initialization failed: ${boundedErrorMessage(error)}.`,
    { cause: error },
  );
}

function aggregateConstructionFailure(
  runId: string,
  primary: unknown,
  cleanupError: unknown,
): AggregateError {
  const cleanupFailures = cleanupError instanceof AggregateError
    ? [...cleanupError.errors]
    : [cleanupError];
  return new AggregateError(
    [primary, ...cleanupFailures],
    `Native Build ${runId} construction failed and cleanup reported errors.`,
  );
}

export interface RunnerCapabilityPreflightOptions {
  config: RunnerCapabilitiesConfig;
  projectDirectory: string;
  stateDirectory: string;
  reservedToolNames: readonly string[];
  verifyExtensionIntegrity?: () => Promise<void>;
}

export interface RecoveredRunnerCapabilityPreflightOptions {
  spec: Pick<NativeBuildSpec, "runId" | "capabilityContract">;
  config: RunnerCapabilitiesConfig;
  projectDirectory: string;
  stateDirectory: string;
  reservedToolNames: readonly string[];
}

interface ClosableLanguageProvider {
  close(): Promise<void>;
}

class NativeCapabilityStartupCleanupError extends AggregateError {
  constructor(
    errors: readonly unknown[],
    readonly disposer: NativeCapabilityCleanupOwner,
  ) {
    super(errors, "Runner capability startup failed and cleanup remains incomplete.");
    this.name = "NativeCapabilityStartupCleanupError";
  }
}

class NativeCapabilityCleanupOwner {
  private closePromise?: Promise<void>;
  private closed = false;

  constructor(
    private pendingProviders: ClosableLanguageProvider[],
    private pendingExtensions?: RunnerExtensionCleanupDisposer,
  ) {
    this.pendingProviders = uniqueClosableProviders(pendingProviders);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    if (this.closePromise) return await this.closePromise;
    const attempt = this.closeOwnedResources();
    this.closePromise = attempt;
    try {
      await attempt;
      this.closed = true;
    } catch (error) {
      if (this.closePromise === attempt) this.closePromise = undefined;
      throw error;
    }
  }

  private async closeOwnedResources(): Promise<void> {
    const failures: unknown[] = [];
    const failedProviders: ClosableLanguageProvider[] = [];
    for (const provider of this.pendingProviders) {
      try {
        await provider.close();
      } catch (error) {
        failures.push(error);
        failedProviders.push(provider);
      }
    }
    this.pendingProviders = failedProviders;
    if (this.pendingExtensions) {
      try {
        await this.pendingExtensions.close();
        this.pendingExtensions = undefined;
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length > 0) {
      throw new AggregateError(
        failures,
        "One or more partially started Runner capability resources failed to close.",
      );
    }
  }
}

class NativeRunCapabilities {
  private closePromise?: Promise<void>;
  private closed = false;

  constructor(
    readonly registry: CapabilityRegistry,
    readonly language: LanguageProviderRouter,
    private readonly projectDirectory: string,
    private readonly extensions?: LoadedRunnerExtensions,
  ) {}

  async close(): Promise<void> {
    if (this.closed) return;
    if (this.closePromise) return await this.closePromise;
    const attempt = closeCapabilityResources(
      [this.language],
      this.extensions,
    );
    this.closePromise = attempt;
    try {
      await attempt;
      this.closed = true;
    } catch (error) {
      if (this.closePromise === attempt) this.closePromise = undefined;
      throw error;
    }
  }

  async preflight(): Promise<void> {
    await this.language.preflightConfiguredServers(this.projectDirectory);
  }
}

async function createNativeRunCapabilities(
  options: RunnerCapabilityPreflightOptions,
): Promise<NativeRunCapabilities> {
  const config = await attestRunnerCapabilitiesLanguageServers(options.config, {
    commandSearchDirectory: options.projectDirectory,
  });
  const builtInLanguage = new TypeScriptIntelligence(
    new RepositoryIntelligence(),
  );
  let extensions: LoadedRunnerExtensions | undefined;
  let registry: CapabilityRegistry | undefined;
  let language: LanguageProviderRouter | undefined;
  try {
    if (config.extensions.length > 0) {
      extensions = await new LocalPluginLoader({
        pluginDirectories: config.extensions,
        projectDirectory: options.projectDirectory,
        stateDirectory: options.stateDirectory,
        reservedToolNames: options.reservedToolNames,
        ...(options.verifyExtensionIntegrity
          ? { verifyExtensionIntegrity: options.verifyExtensionIntegrity }
          : {}),
      }).load();
    }
    registry = extensions?.registry ?? new CapabilityRegistry([], {
      reservedToolNames: options.reservedToolNames,
    });
    language = new LanguageProviderRouter({
      builtInProvider: builtInLanguage,
      extensionProviders: registry.languageProviders(),
      configuredServers: config.languageServers,
    });
    return new NativeRunCapabilities(
      registry,
      language,
      options.projectDirectory,
      extensions,
    );
  } catch (error) {
    const extensionProviders = language
      ? []
      : (registry?.languageProviders().map((registration) => registration.provider) ?? [])
        .reverse();
    const disposer = new NativeCapabilityCleanupOwner(
      language ? [language] : [...extensionProviders, builtInLanguage],
      extensions ?? extensionCleanupDisposer(error),
    );
    const cleanup = await boundedCapabilityCleanup(disposer);
    if (cleanup.incomplete) {
      throw new NativeCapabilityStartupCleanupError(
        [error, ...cleanup.failures],
        disposer,
      );
    }
    if (cleanup.failures.length > 0) {
      throw new AggregateError(
        [error, ...cleanup.failures],
        "Runner capability startup failed and cleanup reported errors.",
      );
    }
    throw error;
  }
}

async function boundedCapabilityCleanup(
  disposer: NativeCapabilityCleanupOwner,
): Promise<{ failures: unknown[]; incomplete: boolean }> {
  const failures: unknown[] = [];
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await disposer.close();
      return { failures, incomplete: false };
    } catch (error) {
      failures.push(error);
    }
  }
  return { failures, incomplete: true };
}

function extensionCleanupDisposer(
  error: unknown,
): RunnerExtensionCleanupDisposer | undefined {
  return error instanceof RunnerExtensionLoadError ? error.disposer : undefined;
}

function nativeCapabilityCleanupDisposer(
  error: unknown,
): NativeCapabilityCleanupOwner | undefined {
  return error instanceof NativeCapabilityStartupCleanupError
    ? error.disposer
    : undefined;
}

function uniqueClosableProviders(
  providers: readonly ClosableLanguageProvider[],
): ClosableLanguageProvider[] {
  const seen = new Set<ClosableLanguageProvider>();
  return providers.filter((provider) => {
    if (seen.has(provider)) return false;
    seen.add(provider);
    return true;
  });
}

/** Validates and starts configured capabilities before accepting control-plane traffic. */
export async function preflightRunnerCapabilities(
  options: RunnerCapabilityPreflightOptions,
): Promise<void> {
  const capabilities = await createNativeRunCapabilities(options);
  try {
    await capabilities.preflight();
  } catch (error) {
    try {
      await closePreflightCapabilities(capabilities);
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "Runner capability preflight failed and cleanup reported errors.",
      );
    }
    throw error;
  }
  await closePreflightCapabilities(capabilities);
}

async function closePreflightCapabilities(
  capabilities: NativeRunCapabilities,
): Promise<void> {
  try {
    await capabilities.close();
  } catch (firstError) {
    try {
      await capabilities.close();
    } catch (retryError) {
      throw new AggregateError(
        [firstError, retryError],
        "Runner capability preflight cleanup failed after a retry.",
      );
    }
    throw firstError;
  }
}

/**
 * Validates and starts only the capabilities attributable to one active Build
 * before CLI startup can acquire provider, MCP, or live Build resources.
 */
export async function preflightRecoveredRunnerCapabilities(
  options: RecoveredRunnerCapabilityPreflightOptions,
): Promise<void> {
  await validateRunnerCapabilityContract(options.spec.capabilityContract, options.config, {
    commandSearchDirectory: options.projectDirectory,
  });
  const contract = options.spec.capabilityContract;
  if (!contract) {
    throw new RunnerCapabilityContractError(
      "capability_contract_missing",
      "Active Build recovery requires a persisted Runner capability contract.",
    );
  }
  await validateRunnerCapabilityContractSnapshot(contract, options.stateDirectory);
  const contractConfig = runnerCapabilitiesForContract(options.config, contract);
  const preflightDirectory = join(
    options.stateDirectory,
    "capability-preflight",
    "recovery",
    safeSegment(options.spec.runId),
  );
  try {
    await mkdir(preflightDirectory, { recursive: true });
    await preflightRunnerCapabilities({
      config: {
        ...contractConfig,
        extensions: runnerCapabilitySnapshotExtensionDirectories(
          contract,
          options.stateDirectory,
        ),
      },
      projectDirectory: options.projectDirectory,
      stateDirectory: preflightDirectory,
      reservedToolNames: options.reservedToolNames,
      verifyExtensionIntegrity: async () => {
        await validateRunnerCapabilityContractSnapshot(contract, options.stateDirectory);
      },
    });
  } catch (error) {
    throw new RunnerCapabilityContractError(
      "capability_preflight_failed",
      `Active Build recovery capability preflight failed: ${boundedErrorMessage(error)}.`,
      { cause: error },
    );
  }
}

async function closeCapabilityResources(
  languageProviders: readonly ClosableLanguageProvider[],
  extensions: LoadedRunnerExtensions | undefined,
): Promise<void> {
  const failures: unknown[] = [];
  for (const provider of languageProviders) {
    try {
      await provider.close();
    } catch (error) {
      failures.push(error);
    }
  }
  if (extensions) {
    try {
      await extensions.close();
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(
      failures,
      "One or more Runner capabilities failed to close.",
    );
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
      ...(event.extensionId
        ? { extensionId: event.extensionId }
        : previous?.extensionId
          ? { extensionId: previous.extensionId }
          : {}),
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

async function loadHistoricalFinalVerificationDiagnostics(input: {
  stateDirectory: string;
  runId: string;
  diagnosticsPath?: string;
  generationId: string;
  taskId: string;
  targetRevision: string;
}) {
  const read = async (expectedRunSegment: string) => await loadFinalVerificationDiagnostics({
    ...input,
    expectedRunSegment,
  });
  // Older historical layouts used the Build run-root segment. Cleanup's
  // production archive uses its own hashed ownership segment; accept either
  // exact Runner-owned root without widening the containment check.
  return await read(safeSegment(input.runId)) ?? await read(
    createHash("sha256").update(input.runId).digest("hex").slice(0, 32),
  );
}

function boundedErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.length <= 512 ? message : `${message.slice(0, 512)}…`;
}

function assertIsolationRecoveryClear(
  results: readonly { providerId: string; blockers: readonly string[] }[],
): void {
  const blockers = results.flatMap((result) =>
    result.blockers.map((blocker) => `${result.providerId}: ${blocker}`));
  if (blockers.length > 0) {
    throw new Error(
      `Configured execution-isolation recovery is blocked: ${blockers.join("; ")}`,
    );
  }
}

/** Derives usage identities solely from settled, attributable budget records. */
function historicalModelUsageRuntimes(
  budget: BudgetProjection,
): NativeModelUsageRuntime[] {
  const runtimes = new Map<string, {
    providerId: string;
    modelId: string;
    roles: Set<NativeModelUsageRuntime["roles"][number]>;
  }>();
  for (const reservation of Object.values(budget.reservations)) {
    if (
      reservation.kind !== "model" ||
      reservation.status !== "settled" ||
      !reservation.actual ||
      !reservation.attribution
    ) continue;
    const attribution = reservation.attribution;
    const existing = runtimes.get(attribution.runtimeId);
    if (
      existing &&
      (existing.providerId !== attribution.providerId ||
        existing.modelId !== attribution.modelId)
    ) {
      throw new Error(
        `Historical model attribution conflicts for ${attribution.runtimeId}.`,
      );
    }
    const runtime = existing ?? {
      providerId: attribution.providerId,
      modelId: attribution.modelId,
      roles: new Set<NativeModelUsageRuntime["roles"][number]>(),
    };
    runtime.roles.add(attribution.role);
    runtimes.set(attribution.runtimeId, runtime);
  }
  return [...runtimes.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([runtimeId, runtime]) => ({
      runtimeId,
      providerId: runtime.providerId,
      modelId: runtime.modelId,
      // A terminal reader intentionally does not consult current provider config.
      billingBasis: "unknown" as const,
      transport: "openai-compatible" as const,
      roles: [...runtime.roles],
      selectable: false,
    }));
}

/** Returns the latest durable `list_skills` result for this run, if recorded. */
function skillsFromHistoricalToolLedger(
  events: readonly ToolLedgerEvent[],
): SkillMetadata[] | undefined {
  let latest: SkillMetadata[] | undefined;
  for (const event of events) {
    const result = event.result;
    if (
      event.type !== "tool.completed" ||
      event.toolName !== "list_skills" ||
      !result ||
      result.isError
    ) continue;
    for (const block of result.content) {
      if (block.type !== "json" || !Array.isArray(block.value)) continue;
      latest = block.value.map((value, index) => historicalSkillMetadata(value, index));
    }
  }
  return latest?.map((skill) => ({ ...skill }));
}

function historicalSkillMetadata(value: unknown, index: number): SkillMetadata {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Historical list_skills result ${index} is malformed.`);
  }
  const skill = value as Record<string, unknown>;
  if (
    typeof skill.id !== "string" ||
    typeof skill.name !== "string" ||
    typeof skill.description !== "string" ||
    typeof skill.relativePath !== "string" ||
    typeof skill.digest !== "string" ||
    !/^[a-f0-9]{64}$/.test(skill.digest) ||
    !Number.isSafeInteger(skill.byteLength) ||
    (skill.byteLength as number) < 0 ||
    (skill.source !== "project" && skill.source !== "built-in" && skill.source !== "user")
  ) {
    throw new Error(`Historical list_skills result ${index} is malformed.`);
  }
  return {
    id: skill.id,
    name: skill.name,
    description: skill.description,
    relativePath: skill.relativePath,
    digest: skill.digest,
    byteLength: skill.byteLength as number,
    source: skill.source as SkillMetadata["source"],
  };
}

/**
 * Node's SQLite read-only connections may still create WAL shared-memory
 * sidecars beside the opened file. Historical reads therefore open a private
 * copy outside Runner state, including WAL-visible committed content.
 */
async function materializeHistoricalSqliteSnapshot(source: string): Promise<{
  directory: string;
  databasePath: string;
}> {
  const directory = await mkdtemp(join(tmpdir(), "aiboard-historical-sqlite-"));
  const databasePath = join(directory, basename(source));
  try {
    await copyFile(source, databasePath);
    for (const suffix of ["-wal", "-shm"] as const) {
      const sidecar = `${source}${suffix}`;
      if (hasOptionalHistoricalFile(sidecar)) {
        await copyFile(sidecar, `${databasePath}${suffix}`);
      }
    }
    return { directory, databasePath };
  } catch (error) {
    try {
      await rm(directory, { recursive: true, force: true });
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        `Could not materialize historical SQLite snapshot ${source}.`,
      );
    }
    throw error;
  }
}

interface HistoricalCloseable {
  close(): void;
}

/**
 * Historical readers never bootstrap a database. A terminal Build may predate
 * one of these optional stores, in which case callers receive the equivalent
 * empty projection while the path remains absent.
 */
function hasHistoricalStore(path: string): boolean {
  try {
    const metadata = statSync(path);
    if (metadata.isFile()) return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  throw new Error(`Historical Runner store ${path} must be a regular file.`);
}

function hasOptionalHistoricalFile(path: string): boolean {
  try {
    const metadata = statSync(path);
    if (metadata.isFile()) return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  throw new Error(`Historical Runner store sidecar ${path} must be a regular file.`);
}

function hasHistoricalDirectory(path: string): boolean {
  try {
    const metadata = statSync(path);
    if (metadata.isDirectory()) return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  throw new Error(`Historical Runner directory ${path} must be a directory.`);
}

function historicalSchedulerProjection(
  spec: NativeBuildSpec,
  events: readonly SchedulerEvent[],
  terminalState: HistoricalTerminalState,
): SchedulerProjection {
  if (events.length > 0) {
    return { ...rebuildSchedulerProjection(events), status: terminalState };
  }
  return {
    runId: spec.runId,
    initialObjective: spec.objective,
    runPolicy: spec.runPolicy,
    status: terminalState,
    planRevision: 0,
    tasks: {},
    guidance: {},
    userGuidance: {},
    userGuidanceVersion: 0,
    architectQuestions: {},
    architectQuestionVersion: 0,
    reviews: {},
    runtime: { providerHealth: {}, workerAssignments: {}, architect: {} },
    lastSequence: 0,
  };
}

function assertHistoricalTerminalState(value: unknown): asserts value is HistoricalTerminalState {
  if (value !== "completed" && value !== "failed" && value !== "stopped") {
    throw new Error("Historical Build requires an authoritative terminal RunSupervisor state.");
  }
}
