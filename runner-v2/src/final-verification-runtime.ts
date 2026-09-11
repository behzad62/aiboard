import type { AgentActor, ToolExecutionContext } from "./agent-contracts.js";
import type { ArtifactStore } from "./artifact-store.js";
import type {
  BrowserConsoleEvent,
  BrowserNetworkEvent,
} from "./browser-tools.js";
import type { ManagedProcessService, ManagedProcessSnapshot } from "./managed-process.js";
import {
  planFinalVerification,
  type FinalVerificationCategory,
  type FinalVerificationCheck,
  type FinalVerificationPlan,
  type FinalVerificationRepositoryInspection,
  type FinalVerificationStatus,
} from "./final-verification-contracts.js";
import type {
  BrowserEventsEvidenceFact,
  BrowserScreenshotEvidenceFact,
  BrowserSnapshotEvidenceFact,
  CommandEvidenceFact,
  EvidenceStore,
} from "./evidence-store.js";
import { unavailableGitRunner } from "./git-command.js";
import type { GitRunner } from "./git-repository.js";
import {
  outputFor,
  type OneShotCommandExecutor,
  type OneShotCommandResult,
} from "./one-shot-command-executor.js";
import type {
  VerificationWorkspace,
  VerificationWorkspaceManager,
} from "./verification-workspace.js";
import {
  assertFinalVerificationExecutionProfile,
  cloneFinalVerificationExecutionProfile,
  type FinalVerificationDependencyProvisioning,
  type FinalVerificationExecutionProfile,
} from "./final-verification-profile.js";
import type { FinalVerificationPortLease } from "./final-verification-port-authority.js";
import {
  captureFinalVerificationBrowserFailures,
  evaluateFinalVerificationBrowserPolicy,
  type FinalVerificationBrowserPolicy,
  type FinalVerificationBrowserPolicyEvaluation,
} from "./final-verification-browser-policy.js";

export type {
  FinalVerificationBrowserFailurePolicy,
  FinalVerificationBrowserPolicy,
} from "./final-verification-browser-policy.js";

export type { FinalVerificationPlan } from "./final-verification-contracts.js";

const EXECUTABLE_CATEGORIES = new Set<FinalVerificationCategory>([
  "build",
  "tests",
]);
const DEFAULT_MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAXIMUM_TIMEOUT_MS = 30 * 60_000;

export interface FinalVerificationCommand {
  label: string;
  executable: string;
  args: string[];
  timeoutMs?: number;
}

export interface FinalVerificationManagedProcessInput {
  executable: string;
  args: string[];
  cwd: string;
}

export interface FinalVerificationManagedProcess {
  start(input: FinalVerificationManagedProcessInput): Promise<FinalVerificationManagedProcessObservation>;
  poll(processId: string): Promise<FinalVerificationManagedProcessObservation>;
  stop(processId: string): Promise<FinalVerificationManagedProcessObservation>;
}

export interface FinalVerificationManagedProcessObservation {
  processId: string;
  status: "running" | "stopped" | "exited_unknown";
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

export interface FinalVerificationReadiness {
  timeoutMs?: number;
  pollIntervalMs?: number;
  healthCheck?: (input: {
    endpoint?: string;
    observation: FinalVerificationManagedProcessObservation;
  }) => boolean | Promise<boolean>;
  expectedStatus?: number;
}

export interface FinalVerificationRuntimeSmokeInput {
  label: string;
  executable: string;
  args: string[];
  endpoint?: string;
  timeoutMs?: number;
  readiness: FinalVerificationReadiness;
  releasePort?: (endpoint?: string) => void | Promise<void>;
}

export interface FinalVerificationBrowserInput {
  label: string;
  url: string;
  width?: number;
  height?: number;
  timeoutMs?: number;
  policy: FinalVerificationBrowserPolicy;
  /** Optional runner-owned server spec used only for this browser check. */
  server?: FinalVerificationRuntimeSmokeInput;
}

export interface FinalVerificationBrowserBackend {
  open(sessionId: string, input: { url: string; width: number; height: number }, ownerRunId: string): Promise<{ url: string; title: string }>;
  snapshot(sessionId: string): Promise<{ url: string; title: string; text: string; html: string }>;
  screenshot(sessionId: string): Promise<Buffer>;
  events(sessionId: string): Promise<{ console: BrowserConsoleEvent[]; network: BrowserNetworkEvent[] }>;
  close(sessionId: string): Promise<void>;
}

/** Narrow session seam used by final verification and easy to test in isolation. */
export interface FinalVerificationBrowserSession {
  open(input: { url: string; width: number; height: number }): Promise<{ url: string; title: string }>;
  snapshot(): Promise<{ url: string; title: string; text: string; html: string }>;
  screenshot(): Promise<Buffer>;
  events(): Promise<{ console: BrowserConsoleEvent[]; network: BrowserNetworkEvent[] }>;
  close(): Promise<void>;
}

export type FinalVerificationRevisionSource =
  | string
  | (() => string | Promise<string>);

export interface FinalVerificationRuntimeOptions {
  git?: GitRunner;
  workspaceManager: VerificationWorkspaceManager;
  artifacts: ArtifactStore;
  evidenceStore?: EvidenceStore;
  runId: string;
  taskId?: string;
  actor?: AgentActor;
  attempt?: number;
  generationId?: string;
  clock?: () => string;
  integrationRevision?: FinalVerificationRevisionSource;
  currentIntegrationRevision?: FinalVerificationRevisionSource;
  managedProcess?: FinalVerificationManagedProcess;
  managedProcessService?: ManagedProcessService;
  browserSession?: FinalVerificationBrowserSession;
  browserBackend?: FinalVerificationBrowserBackend;
  maximumDomBytes?: number;
  maxOutputBytes?: number;
  defaultTimeoutMs?: number;
  maximumTimeoutMs?: number;
  validatePortLease?: (lease: FinalVerificationPortLease) => void | Promise<void>;
  execution?: OneShotCommandExecutor;
}

export interface FinalVerificationRunInput {
  plan: unknown;
  executionProfile: FinalVerificationExecutionProfile;
  commands?: Partial<Record<FinalVerificationCategory, readonly FinalVerificationCommand[]>>;
  runtimeSmoke?: FinalVerificationRuntimeSmokeInput;
  browser?: FinalVerificationBrowserInput;
  signal?: AbortSignal;
}

export interface FinalVerificationRepositoryState {
  revision: string;
  status: string;
}

export interface FinalVerificationCommandFact extends CommandEvidenceFact {
  category: FinalVerificationCategory;
  executable: string;
  targetRevision: string;
  startState: FinalVerificationRepositoryState;
  endState: FinalVerificationRepositoryState;
  endpoint?: string;
  readinessSatisfied?: boolean;
  cleanupRequested?: boolean;
  cleanupSucceeded?: boolean;
}

export interface FinalVerificationBrowserSnapshotFact extends BrowserSnapshotEvidenceFact {
  category: "browser";
  sessionId: string;
  requestedUrl: string;
  startedAt: string;
  finishedAt: string;
  targetRevision: string;
  startState: FinalVerificationRepositoryState;
  endState: FinalVerificationRepositoryState;
}

export interface FinalVerificationBrowserScreenshotFact extends BrowserScreenshotEvidenceFact {
  category: "browser";
  sessionId: string;
  url: string;
  requestedUrl: string;
  startedAt: string;
  finishedAt: string;
  targetRevision: string;
  startState: FinalVerificationRepositoryState;
  endState: FinalVerificationRepositoryState;
}

export interface FinalVerificationBrowserEventsFact extends BrowserEventsEvidenceFact {
  category: "browser";
  sessionId: string;
  url: string;
  requestedUrl: string;
  startedAt: string;
  finishedAt: string;
  targetRevision: string;
  startState: FinalVerificationRepositoryState;
  endState: FinalVerificationRepositoryState;
  consoleErrors: BrowserConsoleEvent[];
  pageErrors: BrowserConsoleEvent[];
  failedNetworkEvents: BrowserNetworkEvent[];
  policyViolations: string[];
  timedOut: boolean;
  cancelled: boolean;
}

export type FinalVerificationFact =
  | FinalVerificationCommandFact
  | FinalVerificationBrowserSnapshotFact
  | FinalVerificationBrowserScreenshotFact
  | FinalVerificationBrowserEventsFact;

export interface FinalVerificationEvidence {
  id: string;
  category: FinalVerificationCategory;
  fact: FinalVerificationFact;
}

export interface FinalVerificationCheckResult {
  category: FinalVerificationCategory;
  status: FinalVerificationStatus;
  green: boolean;
  rationale?: string;
  repositoryInspection?: FinalVerificationRepositoryInspection;
  evidenceIds: string[];
  facts: readonly FinalVerificationFact[];
  issues: string[];
}

export interface FinalVerificationRun {
  generationId: string;
  runId: string;
  taskId: string;
  attempt?: number;
  /** The normalized P2.1 plan used to produce this immutable generation. */
  plan: FinalVerificationPlan;
  executionProfile: FinalVerificationExecutionProfile;
  targetRevision: string;
  workspacePath: string;
  startedAt: string;
  finishedAt: string;
  checks: readonly FinalVerificationCheckResult[];
  green: boolean;
}

export interface FinalVerificationCategoryRun {
  generationId: string;
  runId: string;
  taskId: string;
  attempt?: number;
  targetRevision: string;
  workspacePath: string;
  startedAt: string;
  finishedAt: string;
  check: FinalVerificationCheckResult;
}

interface MutableVerificationCheck {
  category: FinalVerificationCategory;
  status: FinalVerificationStatus;
  rationale?: string;
  repositoryInspection?: FinalVerificationRepositoryInspection;
  evidenceIds: string[];
  facts: FinalVerificationFact[];
  issues: string[];
}

interface ProcessResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: Buffer;
  stderr: Buffer;
  timedOut: boolean;
  cancelled: boolean;
  outputTruncated: boolean;
  startError?: Error;
  routed?: OneShotCommandResult;
}

interface RepositoryStateResult {
  revision: string;
  status: string;
}

/**
 * Runs build and test checks in one runner-owned verification worktree.
 *
 * This class records mechanical facts only. It does not create a ChangeSet,
 * merge anything, or decide semantic completion. The caller remains the
 * authority for interpreting a green run.
 */
export class FinalVerificationRuntime {
  private readonly workspaceManager: VerificationWorkspaceManager;
  private readonly artifacts: ArtifactStore;
  private readonly evidenceStore?: EvidenceStore;
  private readonly runId: string;
  private readonly taskId: string;
  private readonly actor: AgentActor;
  private readonly attempt?: number;
  private readonly generationId?: string;
  private readonly clock: () => string;
  private readonly integrationRevision?: FinalVerificationRevisionSource;
  private readonly managedProcess?: FinalVerificationManagedProcess;
  private readonly browserSession?: FinalVerificationBrowserSession;
  private readonly maxOutputBytes: number;
  private readonly defaultTimeoutMs: number;
  private readonly maximumTimeoutMs: number;
  private readonly maximumDomBytes: number;
  private readonly validatePortLease?: (lease: FinalVerificationPortLease) => void | Promise<void>;
  private readonly execution?: OneShotCommandExecutor;
  private readonly git: GitRunner;
  private runOrdinal = 0;

  constructor(options: FinalVerificationRuntimeOptions) {
    if (!options.runId.trim()) throw new Error("Final verification runId is required.");
    if (options.taskId !== undefined && !options.taskId.trim()) {
      throw new Error("Final verification taskId is required.");
    }
    this.git = options.git ?? unavailableGitRunner;
    this.workspaceManager = options.workspaceManager;
    this.artifacts = options.artifacts;
    this.evidenceStore = options.evidenceStore;
    this.runId = options.runId;
    this.taskId = options.taskId ?? "final-verification";
    this.actor = options.actor ?? {
      role: "architect",
      id: "final-verification-runtime",
    };
    this.attempt = options.attempt;
    this.generationId = options.generationId;
    this.clock = options.clock ?? (() => new Date().toISOString());
    this.integrationRevision = options.integrationRevision ?? options.currentIntegrationRevision;
    this.managedProcess = options.managedProcess ?? (options.managedProcessService
      ? new ManagedProcessServiceAdapter(
          options.managedProcessService,
          this.runId,
          this.taskId,
          this.actor,
        )
        : undefined);
    this.browserSession = options.browserSession ?? (options.browserBackend
      ? new BrowserBackendSessionAdapter(
          options.browserBackend,
          `${this.runId}:${this.generationId ?? "generation"}:${this.taskId}:${this.attempt ?? 1}`,
          this.runId,
        )
      : undefined);
    this.maxOutputBytes = positiveInteger(
      options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
      "maxOutputBytes",
    );
    this.defaultTimeoutMs = positiveInteger(
      options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS,
      "defaultTimeoutMs",
    );
    this.maximumTimeoutMs = positiveInteger(
      options.maximumTimeoutMs ?? DEFAULT_MAXIMUM_TIMEOUT_MS,
      "maximumTimeoutMs",
    );
    this.maximumDomBytes = positiveInteger(
      options.maximumDomBytes ?? 8 * 1024 * 1024,
      "maximumDomBytes",
    );
    this.validatePortLease = options.validatePortLease;
    this.execution = options.execution;
    if (this.defaultTimeoutMs > this.maximumTimeoutMs) {
      throw new Error("defaultTimeoutMs cannot exceed maximumTimeoutMs.");
    }
    if (this.attempt !== undefined && (!Number.isSafeInteger(this.attempt) || this.attempt < 1)) {
      throw new Error("attempt must be a positive integer.");
    }
    if (this.generationId !== undefined && !this.generationId.trim()) {
      throw new Error("generationId must be non-empty.");
    }
  }

  async run(input: FinalVerificationRunInput): Promise<FinalVerificationRun> {
    const plan = planFinalVerification(input.plan);
    const workspace = await this.workspaceManager.create();
    await this.assertCurrentRevision(workspace);
    const execution = authoritativeExecutionInput(input, workspace.targetRevision);
    if (input.executionProfile.portLease && this.validatePortLease) {
      await this.validatePortLease(input.executionProfile.portLease);
    }

    const runOrdinal = ++this.runOrdinal;
    const generationId = this.generationId ?? generationFor(this.runId, workspace.targetRevision);
    const startedAt = this.clock();
    const checks: FinalVerificationCheckResult[] = [];
    for (const check of plan.checks) {
      checks.push(
        await this.runCheck({
          check,
          commands: check.category === "build" || check.category === "tests"
            ? execution.commands[check.category]
            : undefined,
          runtimeSmoke: execution.runtimeSmoke,
          browser: execution.browser,
          provisioning: execution.provisioning,
          workspace,
          generationId,
          runOrdinal,
          signal: input.signal,
        }),
      );
    }
    const finishedAt = this.clock();
    return {
      generationId,
      runId: this.runId,
      taskId: this.taskId,
      ...(this.attempt !== undefined ? { attempt: this.attempt } : {}),
      plan: freezePlan(plan),
      executionProfile: cloneFinalVerificationExecutionProfile(input.executionProfile),
      targetRevision: workspace.targetRevision,
      workspacePath: workspace.path,
      startedAt,
      finishedAt,
      checks: checks.map((check) => freezeCheck(check)),
      green: checks.every((check) => check.green),
    };
  }

  /** Alias for callers that name the operation execute. */
  async execute(input: FinalVerificationRunInput): Promise<FinalVerificationRun> {
    return await this.run(input);
  }

  /** Execute one category while retaining the exact full-generation plan. */
  async runCategory(
    input: FinalVerificationRunInput,
    category: FinalVerificationCategory,
  ): Promise<FinalVerificationCategoryRun> {
    const plan = planFinalVerification(input.plan);
    const check = plan.checks.find((entry) => entry.category === category);
    if (!check) throw new Error(`Final verification category ${category} is not planned.`);
    const workspace = await this.createOrResumeCategoryWorkspace();
    await this.assertCurrentRevision(workspace);
    const execution = authoritativeExecutionInput(input, workspace.targetRevision);
    if (input.executionProfile.portLease && this.validatePortLease) {
      await this.validatePortLease(input.executionProfile.portLease);
    }
    const runOrdinal = ++this.runOrdinal;
    const generationId = this.generationId ?? generationFor(this.runId, workspace.targetRevision);
    const startedAt = this.clock();
    const result = await this.runCheck({
      check,
      commands: category === "build" || category === "tests"
        ? execution.commands[category]
        : undefined,
      runtimeSmoke: execution.runtimeSmoke,
      browser: execution.browser,
      provisioning: execution.provisioning,
      workspace,
      generationId,
      runOrdinal,
      signal: input.signal,
    });
    await this.assertCurrentRevision(workspace);
    const finishedAt = this.clock();
    return {
      generationId,
      runId: this.runId,
      taskId: this.taskId,
      ...(this.attempt !== undefined ? { attempt: this.attempt } : {}),
      targetRevision: workspace.targetRevision,
      workspacePath: workspace.path,
      startedAt,
      finishedAt,
      check: freezeCheck(result),
    };
  }

  private async assertCurrentRevision(workspace: VerificationWorkspace): Promise<void> {
    if (this.integrationRevision === undefined) return;
    const current = typeof this.integrationRevision === "function"
      ? await this.integrationRevision()
      : this.integrationRevision;
    if (!isRevision(current) || current !== workspace.targetRevision) {
      throw new Error(
        `Verification workspace is stale: target revision ${workspace.targetRevision} ` +
          `does not match current integration revision ${current}.`,
      );
    }
  }

  private async createOrResumeCategoryWorkspace(): Promise<VerificationWorkspace> {
    try {
      return await this.workspaceManager.create();
    } catch (error) {
      if (!(error instanceof Error) || error.message !== "Verification workspace is dirty.") {
        throw error;
      }
      return await this.workspaceManager.resumeForNextCheck();
    }
  }

  private async runCheck(input: {
    check: FinalVerificationCheck;
    commands: readonly FinalVerificationCommand[] | undefined;
    runtimeSmoke: FinalVerificationRuntimeSmokeInput | undefined;
    browser: FinalVerificationBrowserInput | undefined;
    provisioning: FinalVerificationDependencyProvisioning | undefined;
    workspace: VerificationWorkspace;
    generationId: string;
    runOrdinal: number;
    signal?: AbortSignal;
  }): Promise<FinalVerificationCheckResult> {
    const { check } = input;
    const base: MutableVerificationCheck = {
      category: check.category,
      status: check.status,
      ...(check.rationale !== undefined ? { rationale: check.rationale } : {}),
      ...(check.repositoryInspection
        ? { repositoryInspection: cloneInspection(check.repositoryInspection) }
        : {}),
      evidenceIds: [] as string[],
      facts: [] as FinalVerificationFact[],
      issues: [] as string[],
    };
    if (check.status === "not_applicable") {
      if (input.commands !== undefined && input.commands.length > 0) {
        base.issues.push(`Not-applicable category ${check.category} supplied executable commands.`);
        return { ...base, green: false };
      }
      return { ...base, green: true };
    }
    if (input.provisioning) {
      const issue = await this.provisionDependencies(
        input.provisioning,
        input.workspace,
        input.signal,
        `${input.generationId}:${check.category}:${input.runOrdinal}`,
      );
      if (issue) {
        base.issues.push(issue);
        return { ...base, green: false };
      }
    }
    if (check.category === "runtime_smoke") {
      return await this.runRuntimeSmokeCheck({
        base,
        input: input.runtimeSmoke,
        workspace: input.workspace,
        generationId: input.generationId,
        runOrdinal: input.runOrdinal,
        signal: input.signal,
      });
    }
    if (check.category === "browser") {
      return await this.runBrowserCheck({
        base,
        input: input.browser,
        workspace: input.workspace,
        generationId: input.generationId,
        runOrdinal: input.runOrdinal,
        signal: input.signal,
      });
    }
    if (!EXECUTABLE_CATEGORIES.has(check.category)) {
      base.issues.push(`Required category ${check.category} is not supported by this command runtime.`);
      return { ...base, green: false };
    }
    const executableCategory = check.category as "build" | "tests";
    if (!input.commands || input.commands.length === 0) {
      base.issues.push(`Required category ${check.category} has no command evidence.`);
      return { ...base, green: false };
    }

    for (const [index, command] of input.commands.entries()) {
      validateCommand(command, check.category, index, this.maximumTimeoutMs);
      const startState = await repositoryState(input.workspace.path, this.git);
      const startedAt = this.clock();
      const execution = await executeCommand(
        command,
        input.workspace.path,
        input.signal,
        this.defaultTimeoutMs,
        this.maximumTimeoutMs,
        this.execution,
        {
          runId: this.runId,
          sessionId: this.taskId,
          actor: this.actor,
          taskId: this.taskId,
          callId: `${input.generationId}:${check.category}:${index}:${input.runOrdinal}`,
        },
      );
      const finishedAt = this.clock();
      const endState = await repositoryState(input.workspace.path, this.git);
      const [stdoutArtifact, stderrArtifact] = await Promise.all([
        artifactForFinalOutput(this.artifacts, execution, "stdout", `${check.category} ${command.label} stdout`),
        artifactForFinalOutput(this.artifacts, execution, "stderr", `${check.category} ${command.label} stderr`),
      ]);
      const executionErrorCode = stableExecutionErrorCode(execution.startError);
      const fact: FinalVerificationCommandFact = {
        kind: "command",
        category: executableCategory,
        label: command.label,
        executable: command.executable,
        command: command.executable,
        args: [...command.args],
        cwd: input.workspace.path,
        startedAt,
        finishedAt,
        exitCode: execution.exitCode,
        signal: execution.signal,
        timedOut: execution.timedOut,
        cancelled: execution.cancelled,
        outputTruncated: execution.outputTruncated,
        ...(executionErrorCode ? { errorCode: executionErrorCode } : {}),
        ...(execution.routed ? {
          outputLossy: execution.routed.process.output.some((entry) => entry.lossyBytes > 0) ||
            stdoutArtifact.fallbackLossy || stderrArtifact.fallbackLossy,
          cleanup: execution.routed.process.cleanup,
          enforcement: execution.routed.enforcement,
          disclosure: execution.routed.disclosure,
          ...(execution.routed.providerId ? { providerId: execution.routed.providerId } : {}),
        } : {}),
        stdoutArtifactHash: stdoutArtifact.hash,
        stderrArtifactHash: stderrArtifact.hash,
        repositoryRevision: input.workspace.targetRevision,
        targetRevision: input.workspace.targetRevision,
        startState,
        endState,
      };
      base.facts.push(fact);

      if (execution.exitCode !== 0) {
        base.issues.push(
          `${check.category} command ${command.label} exited with non-zero code ${String(execution.exitCode)}.`,
        );
      }
      if (execution.startError) {
        base.issues.push(
          `${check.category} command ${command.label} could not start${executionErrorCode ? ` [${executionErrorCode}]` : ""}: ${execution.startError.message}.`,
        );
      }
      if (execution.signal) {
        base.issues.push(`${check.category} command ${command.label} ended by ${execution.signal}.`);
      }
      if (execution.timedOut) {
        base.issues.push(`${check.category} command ${command.label} timed out.`);
      }
      if (execution.cancelled) {
        base.issues.push(`${check.category} command ${command.label} was cancelled.`);
      }
      if (startState.revision !== input.workspace.targetRevision) {
        base.issues.push(
          `${check.category} command ${command.label} started at revision ${startState.revision}, ` +
            `not target revision ${input.workspace.targetRevision}.`,
        );
      }
      if (endState.revision !== input.workspace.targetRevision) {
        base.issues.push(
          `${check.category} command ${command.label} changed the verification revision from ` +
            `${input.workspace.targetRevision} to ${endState.revision}.`,
        );
      }

      const evidenceId = this.recordEvidence(
        fact,
        input.generationId,
        executableCategory,
        index,
        finishedAt,
        input.runOrdinal,
      );
      if (evidenceId) base.evidenceIds.push(evidenceId);
      else base.issues.push(`${check.category} command ${command.label} has no durable evidence record.`);
    }
    return {
      ...base,
      green: base.issues.length === 0 && base.evidenceIds.length === base.facts.length,
    };
  }

  private async provisionDependencies(
    provisioning: FinalVerificationDependencyProvisioning,
    workspace: VerificationWorkspace,
    signal?: AbortSignal,
    invocationKey = "provision",
  ): Promise<string | undefined> {
    const command = provisioning.command;
    validateCommand(command, "build", 0, 600_000);
    const startState = await repositoryState(workspace.path, this.git);
    const execution = await executeCommand(
      command,
      workspace.path,
      signal,
      this.defaultTimeoutMs,
      600_000,
      this.execution,
      {
        runId: this.runId,
        sessionId: this.taskId,
        actor: this.actor,
        taskId: this.taskId,
        callId: `provision:${workspace.targetRevision}:${invocationKey}`,
      },
    );
    const endState = await repositoryState(workspace.path, this.git);
    if (startState.revision !== workspace.targetRevision || endState.revision !== workspace.targetRevision) {
      return "Dependency provisioning crossed the exact integration revision boundary.";
    }
    if (execution.startError) return `Dependency provisioning could not start: ${execution.startError.message}.`;
    if (execution.cancelled) return "Dependency provisioning was cancelled.";
    if (execution.timedOut) return "Dependency provisioning timed out.";
    if (execution.signal) return `Dependency provisioning ended by ${execution.signal}.`;
    if (execution.exitCode !== 0) {
      return `Dependency provisioning exited with non-zero code ${String(execution.exitCode)}.`;
    }
    return undefined;
  }

  private async runRuntimeSmokeCheck(input: {
    base: MutableVerificationCheck;
    input: FinalVerificationRuntimeSmokeInput | undefined;
    workspace: VerificationWorkspace;
    generationId: string;
    runOrdinal: number;
    signal?: AbortSignal;
  }): Promise<FinalVerificationCheckResult> {
    const smoke = input.input;
    if (!smoke) {
      input.base.issues.push("Required runtime_smoke check has no runtime command.");
      return { ...input.base, green: false };
    }
    if (!this.managedProcess) {
      input.base.issues.push("Required runtime_smoke check has no managed process service.");
      return { ...input.base, green: false };
    }
    validateRuntimeSmoke(smoke, this.maximumTimeoutMs);

    const startedAt = this.clock();
    const startState = await repositoryState(input.workspace.path, this.git);
    let observation: FinalVerificationManagedProcessObservation | undefined;
    let readinessSatisfied = false;
    let cleanupSucceeded = false;
    let timedOut = false;
    let cancelled = false;
    let startError: Error | undefined;

    try {
      if (input.signal?.aborted) {
        cancelled = true;
      } else {
        try {
          observation = await this.managedProcess.start({
            executable: smoke.executable,
            args: [...smoke.args],
            cwd: input.workspace.path,
          });
        } catch (error) {
          startError = asError(error);
        }
        if (observation) {
          const readiness = await this.waitForRuntimeReadiness({
            smoke,
            observation,
            signal: input.signal,
          });
          observation = readiness.observation;
          readinessSatisfied = readiness.ready;
          timedOut = readiness.timedOut;
          cancelled = readiness.cancelled;
          if (readiness.issue) input.base.issues.push(readiness.issue);
        }
      }
    } finally {
      if (observation) {
        try {
          observation = (await this.managedProcess.stop(observation.processId)) ?? observation;
          cleanupSucceeded = true;
        } catch (error) {
          input.base.issues.push(`runtime_smoke process cleanup failed: ${asError(error).message}.`);
        }
      }
      if (smoke.releasePort) {
        try {
          await smoke.releasePort(smoke.endpoint);
        } catch (error) {
          cleanupSucceeded = false;
          input.base.issues.push(`runtime_smoke port cleanup failed: ${asError(error).message}.`);
        }
      }
    }

    const finishedAt = this.clock();
    const endState = await repositoryState(input.workspace.path, this.git);
    if (input.signal?.aborted && !cancelled) cancelled = true;
    const stdoutArtifact = await this.artifacts.put(
      Buffer.from(observation?.stdout ?? ""),
      "text/plain",
      `runtime_smoke ${smoke.label} stdout`,
    );
    const stderrArtifact = await this.artifacts.put(
      Buffer.from(observation?.stderr ?? (startError?.message ?? "")),
      "text/plain",
      `runtime_smoke ${smoke.label} stderr`,
    );
    const fact: FinalVerificationCommandFact = {
      kind: "command",
      category: "runtime_smoke",
      label: smoke.label,
      executable: smoke.executable,
      command: smoke.executable,
      args: [...smoke.args],
      cwd: input.workspace.path,
      startedAt,
      finishedAt,
      exitCode: observation?.exitCode ?? null,
      signal: observation?.signal ?? null,
      timedOut,
      cancelled,
      outputTruncated: false,
      stdoutArtifactHash: stdoutArtifact.hash,
      stderrArtifactHash: stderrArtifact.hash,
      repositoryRevision: input.workspace.targetRevision,
      targetRevision: input.workspace.targetRevision,
      startState,
      endState,
      ...(smoke.endpoint ? { endpoint: smoke.endpoint } : {}),
      readinessSatisfied,
      cleanupRequested: observation !== undefined,
      cleanupSucceeded,
    };
    input.base.facts.push(fact);

    if (startError) {
      input.base.issues.push(`runtime_smoke command ${smoke.label} could not start: ${startError.message}.`);
    }
    if (cancelled) input.base.issues.push(`runtime_smoke command ${smoke.label} was cancelled.`);
    if (timedOut) input.base.issues.push(`runtime_smoke command ${smoke.label} timed out before readiness.`);
    if (!readinessSatisfied && !timedOut && !cancelled) {
      input.base.issues.push(`runtime_smoke command ${smoke.label} did not become ready.`);
    }
    if (observation && observation.exitCode !== null && observation.exitCode !== 0) {
      input.base.issues.push(
        `runtime_smoke command ${smoke.label} exited with non-zero code ${String(observation.exitCode)}.`,
      );
    }
    if (startState.revision !== input.workspace.targetRevision) {
      input.base.issues.push(
        `runtime_smoke command ${smoke.label} started at revision ${startState.revision}, ` +
          `not target revision ${input.workspace.targetRevision}.`,
      );
    }
    if (endState.revision !== input.workspace.targetRevision) {
      input.base.issues.push(
        `runtime_smoke command ${smoke.label} changed the verification revision from ` +
          `${input.workspace.targetRevision} to ${endState.revision}.`,
      );
    }

    const evidenceId = this.recordEvidence(
      fact,
      input.generationId,
      "runtime_smoke",
      0,
      finishedAt,
      input.runOrdinal,
    );
    if (evidenceId) input.base.evidenceIds.push(evidenceId);
    else input.base.issues.push(`runtime_smoke command ${smoke.label} has no durable evidence record.`);
    return {
      ...input.base,
      green: input.base.issues.length === 0 && input.base.evidenceIds.length === input.base.facts.length,
    };
  }

  private async runBrowserCheck(input: {
    base: MutableVerificationCheck;
    input: FinalVerificationBrowserInput | undefined;
    workspace: VerificationWorkspace;
    generationId: string;
    runOrdinal: number;
    signal?: AbortSignal;
  }): Promise<FinalVerificationCheckResult> {
    const browserInput = input.input;
    if (!browserInput) {
      input.base.issues.push("Required browser check has no browser navigation input.");
      return { ...input.base, green: false };
    }
    if (!this.browserSession) {
      input.base.issues.push("Required browser check has no owned browser session.");
      return { ...input.base, green: false };
    }
    validateBrowserInput(browserInput, this.maximumTimeoutMs);

    const browser = this.browserSession;
    const sessionId = `${this.runId}:${this.taskId}`;
    const startedAt = this.clock();
    const startState = await repositoryState(input.workspace.path, this.git);
    let serverObservation: FinalVerificationManagedProcessObservation | undefined;
    if (browserInput.server) {
      if (!this.managedProcess) {
        input.base.issues.push("browser server requires the owned managed-process service.");
      } else {
        try {
          serverObservation = await this.managedProcess.start({
            executable: browserInput.server.executable,
            args: [...browserInput.server.args],
            cwd: input.workspace.path,
          });
          const readiness = await this.waitForRuntimeReadiness({
            smoke: browserInput.server,
            observation: serverObservation,
            signal: input.signal,
          });
          serverObservation = readiness.observation;
          if (readiness.issue) input.base.issues.push(`browser server ${readiness.issue}`);
          if (readiness.timedOut) input.base.issues.push("browser server timed out before readiness.");
          if (readiness.cancelled) input.base.issues.push("browser server startup was cancelled.");
          if (!readiness.ready && !readiness.issue && !readiness.timedOut && !readiness.cancelled) {
            input.base.issues.push("browser server did not become ready.");
          }
        } catch (error) {
          input.base.issues.push(`browser server could not start: ${asError(error).message}.`);
        }
      }
    }
    const timeoutMs = Math.min(
      browserInput.timeoutMs ?? this.defaultTimeoutMs,
      this.maximumTimeoutMs,
    );
    const deadline = Date.now() + timeoutMs;
    let timedOut = false;
    let cancelled = false;
    let navigation: { url: string; title: string } | undefined;
    let snapshot: { url: string; title: string; text: string; html: string } | undefined;
    let screenshot: Buffer | undefined;
    let events: { console: BrowserConsoleEvent[]; network: BrowserNetworkEvent[] } | undefined;
    let snapshotArtifact: { hash: string } | undefined;
    let screenshotArtifact: { hash: string } | undefined;
    let eventsArtifact: { hash: string } | undefined;
    let policyViolations: string[] = [];
    let policyEvaluation: FinalVerificationBrowserPolicyEvaluation | undefined;

    const operation = async <T>(
      label: string,
      callback: () => Promise<T>,
    ): Promise<T | undefined> => {
      if (timedOut || cancelled) return undefined;
      if (input.signal?.aborted) {
        cancelled = true;
        return undefined;
      }
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) {
        timedOut = true;
        input.base.issues.push(`browser ${browserInput.label} timed out during ${label}.`);
        return undefined;
      }
      const result = await raceWithAbortAndTimeout(
        Promise.resolve().then(callback),
        input.signal,
        remainingMs,
      );
      if (result.kind === "cancelled") {
        cancelled = true;
        return undefined;
      }
      if (result.kind === "timeout") {
        timedOut = true;
        input.base.issues.push(`browser ${browserInput.label} timed out during ${label}.`);
        return undefined;
      }
      if (result.kind === "error") {
        input.base.issues.push(`browser ${browserInput.label} ${label} failed: ${asError(result.error).message}.`);
        return undefined;
      }
      return result.value;
    };

    try {
      navigation = await operation("navigation", () => browser.open({
        url: browserInput.url,
        width: browserInput.width ?? 1280,
        height: browserInput.height ?? 720,
      }));
      if (navigation) {
        snapshot = await operation("DOM snapshot", () => browser.snapshot());
        if (snapshot) {
          if (typeof snapshot.html !== "string" || snapshot.html.length === 0) {
            input.base.issues.push(`browser ${browserInput.label} is missing DOM snapshot evidence.`);
          } else {
            const encoded = Buffer.from(snapshot.html);
            const bytes = encoded.subarray(0, this.maximumDomBytes);
            try {
              snapshotArtifact = await this.artifacts.put(
                bytes,
                "text/html",
                `Browser verification DOM ${browserInput.label}`,
              );
            } catch (error) {
              input.base.issues.push(
                `browser ${browserInput.label} DOM snapshot artifact failed: ${asError(error).message}.`,
              );
            }
          }
        } else if (!timedOut && !cancelled) {
          input.base.issues.push(`browser ${browserInput.label} is missing DOM snapshot evidence.`);
        }

        screenshot = await operation("screenshot", () => browser.screenshot());
        if (screenshot !== undefined) {
          if (!Buffer.isBuffer(screenshot) || screenshot.byteLength === 0) {
            input.base.issues.push(`browser ${browserInput.label} is missing screenshot evidence.`);
            screenshot = undefined;
          } else {
            try {
              screenshotArtifact = await this.artifacts.put(
                screenshot,
                "image/png",
                `Browser verification screenshot ${browserInput.label}`,
              );
            } catch (error) {
              input.base.issues.push(
                `browser ${browserInput.label} screenshot artifact failed: ${asError(error).message}.`,
              );
            }
          }
        } else if (!timedOut && !cancelled) {
          input.base.issues.push(`browser ${browserInput.label} is missing screenshot evidence.`);
        }

        events = await operation("browser events", () => browser.events());
        if (!events || !Array.isArray(events.console) || !Array.isArray(events.network)) {
          if (!timedOut && !cancelled) {
            input.base.issues.push(`browser ${browserInput.label} is missing browser events evidence.`);
          }
          events = undefined;
        } else {
          events = {
            console: events.console.map((event) => ({ ...event })),
            network: events.network.map((event) => ({ ...event })),
          };
          try {
            policyEvaluation = evaluateFinalVerificationBrowserPolicy(
              captureFinalVerificationBrowserFailures(events),
              browserInput.policy,
            );
            policyViolations = policyEvaluation.policyViolations;
            for (const violation of policyViolations) {
              input.base.issues.push(`browser ${browserInput.label} policy violation: ${violation}`);
            }
          } catch (error) {
            input.base.issues.push(
              `browser ${browserInput.label} events are invalid: ${asError(error).message}`,
            );
          }
          try {
            eventsArtifact = await this.artifacts.put(
              Buffer.from(JSON.stringify(events)),
              "application/json",
              `Browser verification events ${browserInput.label}`,
            );
          } catch (error) {
            input.base.issues.push(
              `browser ${browserInput.label} events artifact failed: ${asError(error).message}.`,
            );
          }
        }
      }
    } finally {
      try {
        await browser.close();
      } catch (error) {
        input.base.issues.push(`browser ${browserInput.label} session cleanup failed: ${asError(error).message}.`);
      }
      if (serverObservation && this.managedProcess) {
        try {
          await this.managedProcess.stop(serverObservation.processId);
        } catch (error) {
          input.base.issues.push(`browser server cleanup failed: ${asError(error).message}.`);
        }
      }
    }

    const finishedAt = this.clock();
    const endState = await repositoryState(input.workspace.path, this.git);
    if (input.signal?.aborted && !cancelled) cancelled = true;
    if (cancelled) input.base.issues.push(`browser ${browserInput.label} navigation was cancelled.`);
    if (timedOut) input.base.issues.push(`browser ${browserInput.label} verification timed out.`);
    if (startState.revision !== input.workspace.targetRevision) {
      input.base.issues.push(
        `browser ${browserInput.label} started at revision ${startState.revision}, ` +
          `not target revision ${input.workspace.targetRevision}.`,
      );
    }
    if (endState.revision !== input.workspace.targetRevision) {
      input.base.issues.push(
        `browser ${browserInput.label} changed the verification revision from ` +
          `${input.workspace.targetRevision} to ${endState.revision}.`,
      );
    }
    if (endState.status !== startState.status) {
      input.base.issues.push(`browser ${browserInput.label} changed files in the verification workspace.`);
    }

    const observedUrl = snapshot?.url ?? navigation?.url ?? browserInput.url;
    const observedTitle = snapshot?.title ?? navigation?.title ?? "";
    const facts: FinalVerificationFact[] = [];
    if (snapshot && snapshotArtifact) {
      const encoded = Buffer.from(snapshot.html);
      facts.push({
        kind: "browser_snapshot",
        category: "browser",
        label: browserInput.label,
        url: observedUrl,
        requestedUrl: browserInput.url,
        title: observedTitle,
        capturedAt: finishedAt,
        htmlArtifactHash: snapshotArtifact.hash,
        htmlBytes: encoded.byteLength,
        truncated: encoded.byteLength > this.maximumDomBytes,
        sessionId,
        startedAt,
        finishedAt,
        targetRevision: input.workspace.targetRevision,
        startState,
        endState,
      });
    }
    if (screenshot && screenshotArtifact) {
      facts.push({
        kind: "browser_screenshot",
        category: "browser",
        label: browserInput.label,
        capturedAt: finishedAt,
        screenshotArtifactHash: screenshotArtifact.hash,
        mediaType: "image/png",
        byteLength: screenshot.byteLength,
        sessionId,
        url: observedUrl,
        requestedUrl: browserInput.url,
        startedAt,
        finishedAt,
        targetRevision: input.workspace.targetRevision,
        startState,
        endState,
      });
    }
    if (events && eventsArtifact && policyEvaluation) {
      facts.push({
        kind: "browser_events",
        category: "browser",
        label: browserInput.label,
        capturedAt: finishedAt,
        eventsArtifactHash: eventsArtifact.hash,
        consoleEventCount: events.console.length,
        consoleErrorCount: policyEvaluation.consoleErrors.length,
        networkEventCount: events.network.length,
        networkFailureCount: policyEvaluation.failedNetworkEvents.length,
        sessionId,
        url: observedUrl,
        requestedUrl: browserInput.url,
        startedAt,
        finishedAt,
        targetRevision: input.workspace.targetRevision,
        startState,
        endState,
        consoleErrors: policyEvaluation.consoleErrors,
        pageErrors: policyEvaluation.pageErrors,
        failedNetworkEvents: policyEvaluation.failedNetworkEvents,
        policyViolations: [...policyViolations],
        timedOut,
        cancelled,
      });
    }
    input.base.facts.push(...facts);
    for (const [index, fact] of facts.entries()) {
      const evidenceId = this.recordEvidence(
        fact,
        input.generationId,
        "browser",
        index,
        finishedAt,
        input.runOrdinal,
      );
      if (evidenceId) input.base.evidenceIds.push(evidenceId);
      else input.base.issues.push(`browser ${browserInput.label} evidence ${fact.kind} has no durable record.`);
    }
    if (facts.length !== 3) {
      input.base.issues.push(`browser ${browserInput.label} is missing required evidence artifacts.`);
    }
    return {
      ...input.base,
      green: input.base.issues.length === 0 && input.base.evidenceIds.length === input.base.facts.length,
    };
  }

  private async waitForRuntimeReadiness(input: {
    smoke: FinalVerificationRuntimeSmokeInput;
    observation: FinalVerificationManagedProcessObservation;
    signal?: AbortSignal;
  }): Promise<{
    observation: FinalVerificationManagedProcessObservation;
    ready: boolean;
    timedOut: boolean;
    cancelled: boolean;
    issue?: string;
  }> {
    if (!this.managedProcess) {
      return {
        observation: input.observation,
        ready: false,
        timedOut: false,
        cancelled: false,
        issue: "Managed process service is unavailable.",
      };
    }
    const timeoutMs = Math.min(
      input.smoke.readiness.timeoutMs ?? input.smoke.timeoutMs ?? this.defaultTimeoutMs,
      this.maximumTimeoutMs,
    );
    const pollIntervalMs = Math.min(
      input.smoke.readiness.pollIntervalMs ?? 100,
      Math.max(1, timeoutMs),
    );
    const deadline = Date.now() + timeoutMs;
    let observation = input.observation;
    while (true) {
      if (input.signal?.aborted) {
        return { observation, ready: false, timedOut: false, cancelled: true };
      }
      if (observation.status !== "running") {
        return {
          observation,
          ready: false,
          timedOut: false,
          cancelled: false,
          issue: `runtime_smoke process exited before readiness (exit code ${String(observation.exitCode)}).`,
        };
      }
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) {
        return { observation, ready: false, timedOut: true, cancelled: false };
      }
      let healthOperation: Promise<boolean> | boolean;
      try {
        healthOperation = input.smoke.readiness.healthCheck
          ? input.smoke.readiness.healthCheck({ endpoint: input.smoke.endpoint, observation })
          : endpointIsHealthy(input.smoke.endpoint, input.smoke.readiness.expectedStatus);
      } catch (error) {
        return {
          observation,
          ready: false,
          timedOut: false,
          cancelled: false,
          issue: `runtime_smoke readiness probe failed: ${asError(error).message}.`,
        };
      }
      const health = await raceWithAbortAndTimeout(
        healthOperation,
        input.signal,
        remainingMs,
      );
      if (health.kind === "cancelled") {
        return { observation, ready: false, timedOut: false, cancelled: true };
      }
      if (health.kind === "timeout") {
        return { observation, ready: false, timedOut: true, cancelled: false };
      }
      if (health.kind === "error") {
        return {
          observation,
          ready: false,
          timedOut: false,
          cancelled: false,
          issue: `runtime_smoke readiness probe failed: ${asError(health.error).message}.`,
        };
      }
      if (health.value) return { observation, ready: true, timedOut: false, cancelled: false };
      const delay = await delayWithAbort(
        Math.min(pollIntervalMs, Math.max(1, deadline - Date.now())),
        input.signal,
      );
      if (delay.cancelled) return { observation, ready: false, timedOut: false, cancelled: true };
      if (Date.now() >= deadline) return { observation, ready: false, timedOut: true, cancelled: false };
      observation = await this.managedProcess.poll(observation.processId);
    }
  }

  private recordEvidence(
    fact: FinalVerificationFact,
    generationId: string,
    category: FinalVerificationCategory,
    index: number,
    createdAt: string,
    runOrdinal: number,
  ): string | undefined {
    if (!this.evidenceStore) return undefined;
    const record = this.evidenceStore.record({
      runId: this.runId,
      taskId: this.taskId,
      actor: { ...this.actor },
      fact,
      createdAt,
      idempotencyKey: `${generationId}:${runOrdinal}:${category}:${index}`,
      ...(this.attempt !== undefined ? { attempt: this.attempt } : {}),
    });
    return record.id;
  }
}

function authoritativeExecutionInput(
  input: FinalVerificationRunInput,
  targetRevision: string,
): {
  commands: FinalVerificationExecutionProfile["commands"];
  provisioning?: FinalVerificationDependencyProvisioning;
  runtimeSmoke?: FinalVerificationRuntimeSmokeInput;
  browser?: FinalVerificationBrowserInput;
} {
  assertFinalVerificationExecutionProfile(input.executionProfile, targetRevision);
  validateCommandMap(input.commands);
  if (input.commands !== undefined) {
    for (const category of ["build", "tests"] as const) {
      if (!sameCommands(input.commands[category], input.executionProfile.commands[category])) {
        throw new Error(`Final verification ${category} runtime commands conflict with the execution profile.`);
      }
    }
  }
  if (input.runtimeSmoke && !sameSmokeBinding(input.runtimeSmoke, input.executionProfile.runtimeSmoke)) {
    throw new Error("Final verification runtime_smoke input conflicts with the execution profile.");
  }
  if (input.browser && !sameBrowserBinding(input.browser, input.executionProfile.browser)) {
    throw new Error("Final verification browser input conflicts with the execution profile.");
  }
  return {
    commands: cloneFinalVerificationExecutionProfile(input.executionProfile).commands,
    ...(input.executionProfile.provisioning
      ? { provisioning: cloneFinalVerificationExecutionProfile(input.executionProfile).provisioning }
      : {}),
    ...(input.runtimeSmoke
      ? { runtimeSmoke: input.runtimeSmoke }
      : input.executionProfile.runtimeSmoke
        ? { runtimeSmoke: input.executionProfile.runtimeSmoke }
        : {}),
    ...(input.browser
      ? { browser: input.browser }
      : input.executionProfile.browser
        ? { browser: input.executionProfile.browser }
        : {}),
  };
}

function sameCommands(
  left: readonly FinalVerificationCommand[] | undefined,
  right: readonly FinalVerificationCommand[] | undefined,
): boolean {
  if (!left || !right) return left === right || (!left?.length && !right?.length);
  return left.length === right.length && left.every((command, index) => {
    const expected = right[index]!;
    return command.label === expected.label && command.executable === expected.executable &&
      command.timeoutMs === expected.timeoutMs && sameStringArray(command.args, expected.args);
  });
}

function sameSmokeBinding(
  left: FinalVerificationRuntimeSmokeInput,
  right: FinalVerificationRuntimeSmokeInput | undefined,
): boolean {
  return Boolean(right) && left.label === right!.label && left.executable === right!.executable &&
    left.endpoint === right!.endpoint && left.timeoutMs === right!.timeoutMs &&
    sameStringArray(left.args, right!.args);
}

function sameBrowserBinding(
  left: FinalVerificationBrowserInput,
  right: FinalVerificationBrowserInput | undefined,
): boolean {
  return Boolean(right) && left.label === right!.label && left.url === right!.url &&
    left.width === right!.width && left.height === right!.height && left.timeoutMs === right!.timeoutMs &&
    ((!left.server && !right!.server) ||
      Boolean(left.server && right!.server && sameSmokeBinding(left.server, right!.server)));
}

function sameStringArray(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function validateCommandMap(
  commands: Partial<Record<FinalVerificationCategory, readonly FinalVerificationCommand[]>> | undefined,
): void {
  if (commands === undefined) return;
  if (typeof commands !== "object" || commands === null || Array.isArray(commands)) {
    throw new Error("Final verification commands must be a category map.");
  }
  for (const key of Object.keys(commands)) {
    if (!isCategory(key)) throw new Error(`Unsupported final verification command category ${key}.`);
    const entries = commands[key as FinalVerificationCategory];
    if (!Array.isArray(entries)) {
      throw new Error(`Final verification commands for ${key} must be an array.`);
    }
  }
}

function validateCommand(
  command: FinalVerificationCommand,
  category: FinalVerificationCategory,
  index: number,
  maximumTimeoutMs: number,
): asserts command is FinalVerificationCommand {
  if (!command || typeof command !== "object" || Array.isArray(command)) {
    throw new Error(`Final verification ${category} command ${index} must be an object.`);
  }
  if (typeof command.label !== "string" || command.label.trim().length === 0) {
    throw new Error(`Final verification ${category} command ${index} requires a label.`);
  }
  if (typeof command.executable !== "string" || command.executable.trim().length === 0) {
    throw new Error(`Final verification ${category} command ${index} requires an executable.`);
  }
  if (!Array.isArray(command.args) || command.args.some((arg) => typeof arg !== "string")) {
    throw new Error(`Final verification ${category} command ${index} requires a string args array.`);
  }
  if (
    command.timeoutMs !== undefined &&
    (!Number.isSafeInteger(command.timeoutMs) || command.timeoutMs < 1 || command.timeoutMs > maximumTimeoutMs)
  ) {
    throw new Error(
      `Final verification ${category} command ${index} timeoutMs must be from 1 to ${maximumTimeoutMs}.`,
    );
  }
}

async function repositoryState(cwd: string, execute: GitRunner): Promise<RepositoryStateResult> {
  const [head, status] = await Promise.all([
    execute({ cwd, args: ["rev-parse", "--verify", "HEAD^{commit}"] }),
    execute({ cwd, args: ["status", "--porcelain=v1", "-z", "--untracked-files=all"] }),
  ]);
  const revision = head.stdout.trim();
  if (!isRevision(revision)) throw new Error(`Unable to determine verification revision in ${cwd}.`);
  return { revision, status: status.stdout };
}

async function executeCommand(
  command: FinalVerificationCommand,
  cwd: string,
  signal: AbortSignal | undefined,
  defaultTimeoutMs: number,
  maximumTimeoutMs: number,
  execution: OneShotCommandExecutor | undefined,
  identity: {
    runId: string;
    sessionId: string;
    actor: AgentActor;
    taskId: string;
    callId: string;
  },
): Promise<ProcessResult> {
  if (signal?.aborted) {
    return {
      exitCode: null,
      signal: null,
      stdout: Buffer.alloc(0),
      stderr: Buffer.alloc(0),
      timedOut: false,
      cancelled: true,
      outputTruncated: false,
    };
  }
  if (!execution) {
    return {
      exitCode: null,
      signal: null,
      stdout: Buffer.alloc(0),
      stderr: Buffer.alloc(0),
      timedOut: false,
      cancelled: false,
      outputTruncated: false,
      startError: Object.assign(
        new Error("The shared subprocess runtime is unavailable for final verification."),
        { code: "process_runtime_unavailable" },
      ),
    };
  }
  const timeoutMs = Math.min(command.timeoutMs ?? defaultTimeoutMs, maximumTimeoutMs);
  try {
    const routed = await execution.execute({
      executable: command.executable,
      arguments: command.args,
      workingDirectory: cwd,
      timeoutMs,
      context: {
        runId: identity.runId,
        sessionId: identity.sessionId,
        actor: identity.actor,
        taskId: identity.taskId,
        callId: identity.callId,
        toolName: "final-verification.command",
        runnerInternal: true,
        ...(signal ? { signal } : {}),
      },
    });
    const stdout = outputFor(routed.process, "stdout");
    const stderr = outputFor(routed.process, "stderr");
    return {
      exitCode: routed.process.exitCode ?? null,
      signal: (routed.process.signal ?? null) as NodeJS.Signals | null,
      stdout: Buffer.from(stdout.tail),
      stderr: Buffer.from(stderr.tail),
      timedOut: routed.process.outcome === "timed_out",
      cancelled: routed.process.outcome === "cancelled",
      outputTruncated: routed.process.output.some((entry) => entry.truncated),
      routed,
      ...(routed.process.outcome === "launch_failed"
        ? { startError: new Error("Process launch was not proven.") }
        : {}),
    };
  } catch (error) {
    return {
      exitCode: null,
      signal: null,
      stdout: Buffer.alloc(0),
      stderr: Buffer.alloc(0),
      timedOut: false,
      cancelled: signal?.aborted === true,
      outputTruncated: false,
      startError: asError(error),
    };
  }
}

async function artifactForFinalOutput(
  artifacts: ArtifactStore,
  execution: ProcessResult,
  stream: "stdout" | "stderr",
  label: string,
): Promise<{ hash: string; fallbackLossy: boolean }> {
  const output = execution.routed ? outputFor(execution.routed.process, stream) : undefined;
  if (output?.spillArtifactId) {
    try {
      await artifacts.verify(output.spillArtifactId);
      return { hash: output.spillArtifactId, fallbackLossy: false };
    } catch {
      // The runtime owns spill cleanup; final evidence degrades to its bounded tail.
    }
  }
  const artifact = await artifacts.put(
    stream === "stdout" ? execution.stdout : execution.stderr,
    "text/plain",
    label,
  );
  return { hash: artifact.hash, fallbackLossy: output?.spillArtifactId !== undefined };
}

function freezeCheck(check: FinalVerificationCheckResult): FinalVerificationCheckResult {
  return Object.freeze({
    ...check,
    evidenceIds: Object.freeze([...check.evidenceIds]),
    facts: Object.freeze(check.facts.map(freezeFact)),
    ...(check.repositoryInspection
      ? {
          repositoryInspection: Object.freeze({
            ...check.repositoryInspection,
            paths: Object.freeze([...check.repositoryInspection.paths]),
            ...(check.repositoryInspection.detectedSignals
              ? { detectedSignals: Object.freeze(check.repositoryInspection.detectedSignals.map((signal) => Object.freeze({ ...signal }))) }
              : {}),
          }),
        }
      : {}),
    issues: Object.freeze([...check.issues]),
  }) as unknown as FinalVerificationCheckResult;
}

function freezePlan(plan: FinalVerificationPlan): FinalVerificationPlan {
  return Object.freeze({
    checks: Object.freeze(plan.checks.map((check) => Object.freeze({
      ...check,
      ...(check.repositoryInspection
        ? {
            repositoryInspection: Object.freeze({
              ...check.repositoryInspection,
              paths: Object.freeze([...check.repositoryInspection.paths]),
              ...(check.repositoryInspection.detectedSignals
                ? {
                    detectedSignals: Object.freeze(
                      check.repositoryInspection.detectedSignals.map((signal) => Object.freeze({ ...signal })),
                    ),
                  }
                : {}),
            }),
          }
        : {}),
    }))),
  }) as unknown as FinalVerificationPlan;
}

function freezeFact(fact: FinalVerificationFact): FinalVerificationFact {
  const state = {
    startState: Object.freeze({ ...fact.startState }),
    endState: Object.freeze({ ...fact.endState }),
  };
  if (fact.kind === "command") {
    return Object.freeze({
      ...fact,
      ...state,
      args: Object.freeze([...fact.args]),
    }) as unknown as FinalVerificationCommandFact;
  }
  if (fact.kind === "browser_events") {
    return Object.freeze({
      ...fact,
      ...state,
      consoleErrors: Object.freeze(fact.consoleErrors.map((event) => Object.freeze({ ...event }))),
      pageErrors: Object.freeze(fact.pageErrors.map((event) => Object.freeze({ ...event }))),
      failedNetworkEvents: Object.freeze(fact.failedNetworkEvents.map((event) => Object.freeze({ ...event }))),
      policyViolations: Object.freeze([...fact.policyViolations]),
    }) as unknown as FinalVerificationBrowserEventsFact;
  }
  return Object.freeze({ ...fact, ...state }) as unknown as
    | FinalVerificationBrowserSnapshotFact
    | FinalVerificationBrowserScreenshotFact;
}

function cloneInspection(
  inspection: FinalVerificationRepositoryInspection,
): FinalVerificationRepositoryInspection {
  return {
    paths: [...inspection.paths],
    summary: inspection.summary,
    ...(inspection.detectedSignals
      ? { detectedSignals: inspection.detectedSignals.map((signal) => ({ ...signal })) }
      : {}),
  };
}

function isCategory(value: string): value is FinalVerificationCategory {
  return value === "build" || value === "tests" || value === "runtime_smoke" || value === "browser";
}

function isRevision(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{40,64}$/.test(value.trim());
}

function generationFor(runId: string, revision: string): string {
  return `final-verification:${runId}:${revision}`;
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive integer.`);
  return value;
}

async function endpointIsHealthy(endpoint: string | undefined, expectedStatus = 200): Promise<boolean> {
  if (!endpoint) return false;
  try {
    const response = await fetch(endpoint);
    return response.status === expectedStatus;
  } catch {
    return false;
  }
}

function validateBrowserInput(
  input: FinalVerificationBrowserInput,
  maximumTimeoutMs: number,
): void {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error("browser input must be an object.");
  }
  if (typeof input.label !== "string" || input.label.trim().length === 0 || input.label.length > 256) {
    throw new Error("browser label must be a non-empty string of at most 256 characters.");
  }
  if (typeof input.url !== "string" || input.url.length === 0 || input.url.length > 2_048) {
    throw new Error("browser URL must be a non-empty string of at most 2048 characters.");
  }
  let parsed: URL;
  try {
    parsed = new URL(input.url);
  } catch {
    throw new Error("browser URL must be an HTTP(S) URL.");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("browser URL must be an HTTP(S) URL.");
  }
  for (const [value, name] of [
    [input.width, "browser width"],
    [input.height, "browser height"],
  ] as const) {
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 320 || value > 4_096)) {
      throw new Error(`${name} must be an integer from 320 to 4096.`);
    }
  }
  validateTimeout(input.timeoutMs, maximumTimeoutMs, "browser timeoutMs");
  if (typeof input.policy !== "object" || input.policy === null || Array.isArray(input.policy)) {
    throw new Error("browser policy is required.");
  }
  for (const [value, name] of [
    [input.policy.consoleErrors, "browser consoleErrors policy"],
    [input.policy.pageErrors, "browser pageErrors policy"],
    [input.policy.failedNetworkEvents, "browser failedNetworkEvents policy"],
  ] as const) {
    if (value !== undefined && value !== "fail" && value !== "allow") {
      throw new Error(`${name} must be fail or allow.`);
    }
  }
  for (const [patterns, name] of [
    [input.policy.allowedConsoleErrorPatterns, "browser console error allowlist"],
    [input.policy.allowedPageErrorPatterns, "browser page error allowlist"],
    [input.policy.allowedNetworkFailurePatterns, "browser network failure allowlist"],
  ] as const) {
    if (patterns === undefined) continue;
    if (!Array.isArray(patterns) || patterns.length > 32 || patterns.some((pattern) => (
      typeof pattern !== "string" || pattern.trim().length === 0 || pattern.length > 256
    ))) {
      throw new Error(`${name} must contain at most 32 non-empty strings of at most 256 characters.`);
    }
  }
  if (input.server !== undefined) {
    validateRuntimeSmoke(input.server, maximumTimeoutMs);
    if (input.server.endpoint !== input.url) {
      throw new Error("browser server endpoint must match the browser URL.");
    }
  }
}

function validateRuntimeSmoke(
  input: FinalVerificationRuntimeSmokeInput,
  maximumTimeoutMs: number,
): void {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error("runtime_smoke input must be an object.");
  }
  if (typeof input.label !== "string" || input.label.trim().length === 0) {
    throw new Error("runtime_smoke label is required.");
  }
  if (typeof input.executable !== "string" || input.executable.trim().length === 0) {
    throw new Error("runtime_smoke executable is required.");
  }
  if (!Array.isArray(input.args) || input.args.some((arg) => typeof arg !== "string")) {
    throw new Error("runtime_smoke args must be a string array.");
  }
  if (input.endpoint !== undefined) {
    let parsed: URL;
    try {
      parsed = new URL(input.endpoint);
    } catch {
      throw new Error("runtime_smoke endpoint must be an HTTP(S) URL.");
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error("runtime_smoke endpoint must be an HTTP(S) URL.");
    }
  }
  validateTimeout(input.timeoutMs, maximumTimeoutMs, "runtime_smoke timeoutMs");
  if (!input.readiness || typeof input.readiness !== "object") {
    throw new Error("runtime_smoke readiness is required.");
  }
  if (typeof input.readiness.healthCheck !== "function" && !input.endpoint) {
    throw new Error("runtime_smoke readiness requires a healthCheck function or endpoint.");
  }
  validateTimeout(input.readiness.timeoutMs, maximumTimeoutMs, "runtime_smoke readiness timeoutMs");
  if (
    input.readiness.pollIntervalMs !== undefined &&
    (!Number.isSafeInteger(input.readiness.pollIntervalMs) || input.readiness.pollIntervalMs < 1)
  ) {
    throw new Error("runtime_smoke readiness pollIntervalMs must be a positive integer.");
  }
  if (
    input.readiness.expectedStatus !== undefined &&
    (!Number.isSafeInteger(input.readiness.expectedStatus) || input.readiness.expectedStatus < 100 || input.readiness.expectedStatus > 599)
  ) {
    throw new Error("runtime_smoke readiness expectedStatus must be an HTTP status.");
  }
  if (input.releasePort !== undefined && typeof input.releasePort !== "function") {
    throw new Error("runtime_smoke releasePort must be a function.");
  }
}

function validateTimeout(value: number | undefined, maximum: number, label: string): void {
  if (value !== undefined && (!Number.isSafeInteger(value) || value < 1 || value > maximum)) {
    throw new Error(`${label} must be from 1 to ${maximum}.`);
  }
}

type PromiseRaceResult<T> =
  | { kind: "value"; value: T }
  | { kind: "timeout" }
  | { kind: "cancelled" }
  | { kind: "error"; error: unknown };

function raceWithAbortAndTimeout<T>(
  operation: Promise<T> | T,
  signal: AbortSignal | undefined,
  timeoutMs: number,
): Promise<PromiseRaceResult<T>> {
  return new Promise((resolve) => {
    let settled = false;
    const timeout = setTimeout(() => settle({ kind: "timeout" }), timeoutMs);
    timeout.unref();
    const onAbort = () => settle({ kind: "cancelled" });
    signal?.addEventListener("abort", onAbort, { once: true });
    const settle = (result: PromiseRaceResult<T>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
      resolve(result);
    };
    if (signal?.aborted) {
      settle({ kind: "cancelled" });
      return;
    }
    Promise.resolve(operation).then(
      (value) => settle({ kind: "value", value }),
      (error: unknown) => settle({ kind: "error", error }),
    );
  });
}

async function delayWithAbort(
  milliseconds: number,
  signal: AbortSignal | undefined,
): Promise<{ cancelled: boolean }> {
  if (signal?.aborted) return { cancelled: true };
  return await new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => settle({ cancelled: false }), milliseconds);
    timer.unref();
    const onAbort = () => settle({ cancelled: true });
    signal?.addEventListener("abort", onAbort, { once: true });
    const settle = (result: { cancelled: boolean }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve(result);
    };
  });
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function stableExecutionErrorCode(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && new Set([
    "isolation_capability_unavailable",
    "isolation_revocation_failed",
    "outcome_unknown",
    "backend_unavailable",
    "identity_mismatch",
    "cleanup_blocked",
    "launch_not_proven",
    "process_runtime_unavailable",
  ]).has(code) ? code : undefined;
}

class ManagedProcessServiceAdapter implements FinalVerificationManagedProcess {
  private readonly sessionId: string;

  constructor(
    private readonly service: ManagedProcessService,
    private readonly runId: string,
    taskId: string,
    private readonly actor: AgentActor,
  ) {
    this.sessionId = `final-verification:${taskId}`;
  }

  async start(input: FinalVerificationManagedProcessInput): Promise<ManagedProcessSnapshot> {
    return await this.service.start(
      { command: input.executable, args: [...input.args], cwd: "." },
      this.context(),
      input.cwd,
    );
  }

  async poll(processId: string): Promise<ManagedProcessSnapshot> {
    return this.service.poll(processId, this.context());
  }

  async stop(processId: string): Promise<ManagedProcessSnapshot> {
    return await this.service.signal(processId, "SIGTERM", this.context());
  }

  private context(): ToolExecutionContext {
    return {
      runId: this.runId,
      sessionId: this.sessionId,
      actor: { ...this.actor },
    };
  }
}

class BrowserBackendSessionAdapter implements FinalVerificationBrowserSession {
  constructor(
    private readonly backend: FinalVerificationBrowserBackend,
    private readonly sessionId: string,
    private readonly runId: string,
  ) {}

  async open(input: { url: string; width: number; height: number }): Promise<{ url: string; title: string }> {
    return await this.backend.open(this.sessionId, input, this.runId);
  }

  async snapshot(): Promise<{ url: string; title: string; text: string; html: string }> {
    return await this.backend.snapshot(this.sessionId);
  }

  async screenshot(): Promise<Buffer> {
    return await this.backend.screenshot(this.sessionId);
  }

  async events(): Promise<{ console: BrowserConsoleEvent[]; network: BrowserNetworkEvent[] }> {
    return await this.backend.events(this.sessionId);
  }

  async close(): Promise<void> {
    await this.backend.close(this.sessionId);
  }
}
