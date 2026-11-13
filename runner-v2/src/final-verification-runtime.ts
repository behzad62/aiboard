import { commandReuseMetadata } from "./command-evidence-reuse.js";
import { workingTreeForRunner, unknownChildEnvironment, settleWorkingTreeIdentity } from "./command-evidence-identity.js";
import type { AgentActor, ToolExecutionContext } from "./agent-contracts.js";
import type { TempRecordSink } from "./cleanup-ownership.js";
import { existsSync } from "node:fs";
import { readFile, realpath, stat } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import type { ArtifactStore } from "./artifact-store.js";
import type {
  BrowserConsoleEvent,
  BrowserNetworkEvent,
} from "./browser-tools.js";
import type { ManagedProcessService, ManagedProcessSnapshot } from "./managed-process.js";
import type { PermissionProfile } from "./contracts.js";
import type { ExecutionGrantAuthority } from "./execution-grants.js";
import {
  planFinalVerification,
  verificationCheckFailed,
  type FinalVerificationCategory,
  type FinalVerificationCheck,
  type FinalVerificationPlan,
  type FinalVerificationRepositoryInspection,
  type FinalVerificationStatus,
  type VerificationNotRun,
} from "./final-verification-contracts.js";
import type { CheckToolLookup } from "./check-tool-lookup.js";
import {
  captureCommandOutputs,
  outputCaptureBlocker,
  outputsNotCaptured,
  type CommandOutputCapture,
} from "./command-output-files.js";
import {
  joinWorkspace,
  type ResolvedVerificationCheckV2,
  type VerificationCheckResultV2,
} from "./verification-plan-v2.js";
import type {
  BrowserEventsEvidenceFact,
  BrowserScreenshotEvidenceFact,
  BrowserSnapshotEvidenceFact,
  CommandEvidenceFact,
  EvidenceStore,
} from "./evidence-store.js";
import { unavailableGitRunner } from "./git-command.js";
import { hasTestSelectionFlag, isDirectNodeTestCommand } from "./flaky-rerun.js";
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
  type FinalVerificationReportDescriptor,
} from "./final-verification-profile.js";
import type { FinalVerificationPortLease } from "./final-verification-port-authority.js";
import type { RunActivityTracker } from "./run-activity.js";
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
  /**
   * T6a (real counts): explicit child-environment overrides for this command
   * (an `undefined` value removes the name). Passed to the audited executor,
   * which still applies its forbidden-name policy.
   */
  environment?: Readonly<Record<string, string | undefined>>;
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
  /**
   * The user's workflow, run in order against the live program once it is ready; each must exit 0.
   * Tunnel run: the smoke only proved the relay answered /healthz, and the pairing command it
   * printed failed for every user.
   */
  steps?: FinalVerificationCommand[];
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
  /**
   * The value the first run's ordinal follows. Run ordinals name each run's process calls, evidence
   * keys and report files, so they must not repeat across runner processes; the default is the time
   * this runtime was created. Tests that predict names pass 0.
   */
  runOrdinalStart?: number;
  git?: GitRunner;
  workspaceManager: VerificationWorkspaceManager;
  artifacts: ArtifactStore;
  evidenceStore?: EvidenceStore;
  runId: string;
  taskId?: string;
  actor?: AgentActor;
  attempt?: number;
  generationId?: string;
  checkCategory?: FinalVerificationCategory;
  clock?: () => string;
  integrationRevision?: FinalVerificationRevisionSource;
  currentIntegrationRevision?: FinalVerificationRevisionSource;
  managedProcess?: FinalVerificationManagedProcess;
  managedProcessService?: ManagedProcessService;
  managedProcessAuthority?: Readonly<{ executionGrants: ExecutionGrantAuthority; permissionProfile: PermissionProfile }>;
  browserSession?: FinalVerificationBrowserSession;
  browserBackend?: FinalVerificationBrowserBackend;
  maximumDomBytes?: number;
  maxOutputBytes?: number;
  defaultTimeoutMs?: number;
  maximumTimeoutMs?: number;
  validatePortLease?: (lease: FinalVerificationPortLease) => void | Promise<void>;
  execution?: OneShotCommandExecutor;
  /**
   * T6b repair (B2): the ambient NODE_OPTIONS the audited executor passes
   * to children (wired by the factory from its ambient snapshot, mirroring
   * the T6a delivery boundary). The reporter's own flags are appended to
   * it; this module never reads the ambient process environment itself.
   */
  ambientNodeOptions?: string;
  /**
   * T6b repair (R2-B4): the OA-14 flaky rerun of package `run test`
   * commands. The failing-test pattern is added to the node --test
   * NODE_OPTIONS (npm forwards the environment to the script), so the
   * rerun report must show at least one real selected test.
   */
  testNamePattern?: string;
  /**
   * T6b repair (R2-B6, OA-17): durable creation records for the
   * runner-owned junit report files this runtime writes into the
   * verification workspace; the temp search later removes them.
   */
  tempRecorders?: Pick<TempRecordSink, "recorded">;
  /** Reports the checkout, install and check steps to the owner's live view. */
  activity?: RunActivityTracker;
  /**
   * VF2: the Runner's PATH lookup of each executable a check needs, made
   * before anything launches. A tool it does not find makes the check
   * `not_run: tool_missing`. Absent, nothing is looked up and every check
   * launches as before.
   */
  toolLookup?: CheckToolLookup;
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
  /**
   * v1: the category. VF3 (v2): how the Runner ran the check (build: a one-shot command, tests: a
   * one-shot command with test-report wiring, runtime_smoke: a managed program and its steps),
   * and `checkId` names the check.
   */
  category: FinalVerificationCategory;
  /** VF3: the v2 check this fact belongs to. */
  checkId?: string;
  executable: string;
  targetRevision: string;
  startState: FinalVerificationRepositoryState;
  endState: FinalVerificationRepositoryState;
  endpoint?: string;
  readinessSatisfied?: boolean;
  cleanupRequested?: boolean;
  cleanupSucceeded?: boolean;
  /** A runtime_smoke workflow step run against the live program (facts after the program's own). */
  workflowStep?: true;
  /** Machine-readable test-report identities used for OA-14 rerun selection. */
  report?: {
    readonly failingTestIds?: readonly string[];
    /** Real counts from the rerun report: executed and failed test
     * totals. The OA-14 verdict requires executed >= 1 with zero failed
     * and the named ids absent from the rerun failures. */
    readonly executed?: number;
    readonly failed?: number;
  };
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
  /**
   * VF2: set by the Runner when a tool the check needs is missing. The check
   * then has `green: false`, no facts, no evidence and no issues: it is not a
   * failure and asks for no repair.
   */
  notRun?: VerificationNotRun;
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

/** VF3: one executed v2 check, the v2 twin of FinalVerificationCategoryRun. */
export interface FinalVerificationCheckRunV2 {
  generationId: string;
  runId: string;
  taskId: string;
  attempt?: number;
  targetRevision: string;
  workspacePath: string;
  startedAt: string;
  finishedAt: string;
  check: VerificationCheckResultV2;
}

/** VF3: how runCheck runs one command-mode v2 check. */
interface V2CommandContext {
  checkId: string;
  /** Absolute working directory inside the checkout. */
  cwd?: string;
  /** Set when the requested working directory is not a directory inside the checkout. */
  cwdIssue?: string;
  /** Exit codes other than 0 that mean success, by command index. */
  expectedExitCodes?: ReadonlyMap<number, number>;
  /** Commands from this index on are workflow steps after the program. */
  workflowStepsFrom?: number;
  outputs: (index: number) => readonly string[] | undefined;
}

/** VF3: how runRuntimeSmokeCheck runs one program-mode v2 check. */
interface V2ProgramContext {
  checkId: string;
  outputs?: readonly string[];
  stepOutputs: (index: number) => readonly string[] | undefined;
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
  private readonly ambientNodeOptions?: string;
  private readonly testNamePattern?: string;
  private readonly tempRecorders?: Pick<TempRecordSink, "recorded">;
  private readonly activity?: RunActivityTracker;
  private readonly toolLookup?: CheckToolLookup;
  // Restarted at 0 in every runner process, a re-run after a restart reused the previous process's
  // call ids and failed with "Process idempotency conflict" (tunnel run).
  private runOrdinal: number;

  constructor(options: FinalVerificationRuntimeOptions) {
    this.runOrdinal = options.runOrdinalStart ?? Date.now();
    if (!Number.isSafeInteger(this.runOrdinal) || this.runOrdinal < 0) throw new Error("runOrdinalStart must be a non-negative integer.");
    if (!options.runId.trim()) throw new Error("Final verification runId is required.");
    if (options.taskId !== undefined && !options.taskId.trim()) {
      throw new Error("Final verification taskId is required.");
    }
    this.git = options.git ?? unavailableGitRunner;
    this.ambientNodeOptions = options.ambientNodeOptions;
    this.testNamePattern = options.testNamePattern;
    this.tempRecorders = options.tempRecorders;
    this.activity = options.activity;
    this.toolLookup = options.toolLookup;
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
    if (options.managedProcessService && !options.managedProcessAuthority && !options.managedProcess) {
      throw new Error("Final verification managed processes require explicit run-owned execution grant authority.");
    }
    this.managedProcess = options.managedProcess ?? (options.managedProcessService && options.managedProcessAuthority
      ? createFinalVerificationManagedProcessAdapter({
          service: options.managedProcessService,
          executionGrants: options.managedProcessAuthority.executionGrants,
          permissionProfile: options.managedProcessAuthority.permissionProfile,
          runId: this.runId,
          taskId: this.taskId,
          callScope: `${options.generationId ?? "generation"}:${options.attempt ?? 1}:${options.checkCategory ?? "check"}`,
          actor: this.actor,
        })
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
      reports: execution.reports,
      inventoryIncomplete: execution.inventoryIncomplete,
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
      // A not-run check is not a failure (VF2).
      green: !checks.some(verificationCheckFailed),
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
    const workspace = await this.tracked("Preparing the verification checkout", () => this.createOrResumeCategoryWorkspace());
    await this.assertCurrentRevision(workspace);
    const execution = authoritativeExecutionInput(input, workspace.targetRevision);
    if (input.executionProfile.portLease && this.validatePortLease) {
      await this.validatePortLease(input.executionProfile.portLease);
    }
    const runOrdinal = ++this.runOrdinal;
    const generationId = this.generationId ?? generationFor(this.runId, workspace.targetRevision);
    const startedAt = this.clock();
    const result = await this.tracked(`Running the ${categoryActivityName(category)} check`, () => this.runCheck({
      check,
      commands: category === "build" || category === "tests"
        ? execution.commands[category]
        : undefined,
      runtimeSmoke: execution.runtimeSmoke,
      browser: execution.browser,
      provisioning: execution.provisioning,
      reports: execution.reports,
      inventoryIncomplete: execution.inventoryIncomplete,
      workspace,
      generationId,
      runOrdinal,
      signal: input.signal,
    }));
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

  /**
   * VF3: execute one check of a v2 plan, exactly as the execution profile resolved it, in the
   * fresh verification checkout. A tool the Runner's PATH lookup does not find makes the check
   * not_run (tool_missing); anything else that keeps it from passing is a failure.
   */
  async runCheckV2(input: {
    executionProfile: FinalVerificationExecutionProfile;
    checkId: string;
    signal?: AbortSignal;
  }): Promise<FinalVerificationCheckRunV2> {
    const resolved = input.executionProfile.verification?.checks.find((check) => check.checkId === input.checkId);
    if (!resolved) throw new Error(`Final verification check ${input.checkId} is not planned.`);
    const workspace = await this.tracked("Preparing the verification checkout", () => this.createOrResumeCategoryWorkspace());
    await this.assertCurrentRevision(workspace);
    assertFinalVerificationExecutionProfile(input.executionProfile, workspace.targetRevision);
    if (input.executionProfile.portLease && this.validatePortLease) {
      await this.validatePortLease(input.executionProfile.portLease);
    }
    const runOrdinal = ++this.runOrdinal;
    const generationId = this.generationId ?? generationFor(this.runId, workspace.targetRevision);
    const startedAt = this.clock();
    const result = await this.tracked(`Running the check ${resolved.label}`, () => this.runResolvedCheck({
      resolved,
      profile: input.executionProfile,
      workspace,
      generationId,
      runOrdinal,
      ...(input.signal ? { signal: input.signal } : {}),
    }));
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
      check: Object.freeze({
        ...result,
        evidenceIds: [...result.evidenceIds],
        facts: Object.freeze(result.facts.map(freezeFact)),
        issues: [...result.issues],
      }) as VerificationCheckResultV2,
    };
  }

  private async runResolvedCheck(input: {
    resolved: ResolvedVerificationCheckV2;
    profile: FinalVerificationExecutionProfile;
    workspace: VerificationWorkspace;
    generationId: string;
    runOrdinal: number;
    signal?: AbortSignal;
  }): Promise<VerificationCheckResultV2> {
    const { resolved } = input;
    const identity = {
      checkId: resolved.checkId,
      kind: resolved.kind,
      label: resolved.label,
      origin: resolved.origin,
      mandatory: resolved.mandatory,
    };
    const toResult = (check: FinalVerificationCheckResult): VerificationCheckResultV2 => ({
      ...identity,
      outcome: check.notRun ? "not_run" : check.green ? "passed" : "failed",
      green: check.notRun ? false : check.green,
      evidenceIds: [...check.evidenceIds],
      facts: [...check.facts],
      issues: [...check.issues],
      ...(check.notRun ? { notRun: { ...check.notRun } } : {}),
    });
    const provisioning = input.profile.provisioning;
    const notRun = await this.missingTool([
      ...(provisioning ? [provisioning.command] : []),
      ...resolved.commands,
    ], input.workspace.path);
    if (notRun) {
      return {
        ...identity,
        outcome: "not_run",
        green: false,
        evidenceIds: [],
        facts: [],
        issues: [],
        notRun,
      };
    }
    // A check is required on v2 by being in the plan; v1's category is only how the Runner runs it.
    const mode = resolved.mode;
    const base: MutableVerificationCheck = {
      category: mode === "tests" ? "tests" : mode === "program" ? "runtime_smoke" : "build",
      status: "required",
      evidenceIds: [],
      facts: [],
      issues: [],
    };
    if (provisioning) {
      const issue = await this.tracked(`Installing dependencies (${provisioning.manager})`, () => this.provisionDependencies(
        provisioning,
        input.workspace,
        input.signal,
        `${input.generationId}:${resolved.checkId}:${input.runOrdinal}`,
      ));
      if (issue) {
        base.issues.push(issue);
        return toResult({ ...base, green: false });
      }
    }
    if (mode === "program") {
      const [program, ...steps] = resolved.commands;
      const outputLine = resolved.outputLine;
      const smoke: FinalVerificationRuntimeSmokeInput = {
        label: program!.label,
        executable: program!.executable,
        args: [...program!.args],
        ...(resolved.endpoint ? { endpoint: resolved.endpoint } : {}),
        ...(program!.timeoutMs !== undefined ? { timeoutMs: program!.timeoutMs } : {}),
        readiness: {
          ...(resolved.readinessTimeoutMs !== undefined ? { timeoutMs: resolved.readinessTimeoutMs } : {}),
          pollIntervalMs: 100,
          ...(resolved.expectedStatus !== undefined ? { expectedStatus: resolved.expectedStatus } : {}),
          ...(outputLine !== undefined
            ? { healthCheck: ({ observation }) => observation.stdout.includes(outputLine) || observation.stderr.includes(outputLine) }
            : {}),
        },
        ...(steps.length ? { steps: steps.map(({ outputs: _outputs, cwd: _cwd, ...step }) => step) } : {}),
      };
      return toResult(await this.runRuntimeSmokeCheck({
        base,
        input: smoke,
        workspace: input.workspace,
        generationId: input.generationId,
        runOrdinal: input.runOrdinal,
        ...(input.signal ? { signal: input.signal } : {}),
        v2: {
          checkId: resolved.checkId,
          ...(resolved.outputs?.length ? { outputs: resolved.outputs } : {}),
          stepOutputs: (index) => steps[index]?.outputs,
        },
      }));
    }
    const first = resolved.commands[0]!;
    const cwd = first.cwd ? joinWorkspace(input.workspace.path, first.cwd) : undefined;
    const cwdIssue = cwd ? await directoryInsideIssue(input.workspace.path, cwd, resolved.checkId) : undefined;
    const reports = mode === "tests" ? reportDescriptorsFor(first, input.profile) : undefined;
    return toResult(await this.runCheck({
      check: { category: mode === "tests" ? "tests" : "build", status: "required" },
      commands: resolved.commands.map(({ outputs: _outputs, cwd: _cwd, ...command }) => command),
      runtimeSmoke: undefined,
      browser: undefined,
      // Provisioning ran above, once.
      provisioning: undefined,
      reports,
      inventoryIncomplete: undefined,
      workspace: input.workspace,
      generationId: input.generationId,
      runOrdinal: input.runOrdinal,
      ...(input.signal ? { signal: input.signal } : {}),
      v2: {
        checkId: resolved.checkId,
        ...(cwd ? { cwd } : {}),
        ...(cwdIssue ? { cwdIssue } : {}),
        ...(mode === "exit" ? {
          expectedExitCodes: new Map([[0, resolved.expectedExitCode ?? 0]]),
          workflowStepsFrom: 1,
        } : {}),
        outputs: (index) => {
          const own = resolved.commands[index]?.outputs ?? [];
          const checkLevel = index === 0 ? resolved.outputs ?? [] : [];
          const patterns = [...new Set([...own, ...checkLevel])];
          return patterns.length ? patterns : undefined;
        },
      },
    }));
  }

  /** VF6: the files a finished v2 command was asked to keep, read only once its process tree is proven gone. */
  private async captureOutputs(
    execution: ProcessResult,
    patterns: readonly string[],
    workspace: string,
    label: string,
  ): Promise<CommandOutputCapture> {
    if (!execution.routed) return outputsNotCaptured(patterns, "process_not_proven_ended");
    const blocker = outputCaptureBlocker({ ...execution.routed.process, reused: execution.routed.reuseSource !== undefined });
    if (blocker) return outputsNotCaptured(patterns, blocker);
    return await captureCommandOutputs({ workspace, patterns, artifacts: this.artifacts, label });
  }

  private async tracked<T>(label: string, work: () => Promise<T>): Promise<T> {
    return this.activity ? await this.activity.track(label, work, this.taskId) : await work();
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
    reports: FinalVerificationReportDescriptor[] | undefined;
    inventoryIncomplete: boolean | undefined;
    workspace: VerificationWorkspace;
    generationId: string;
    runOrdinal: number;
    signal?: AbortSignal;
    /** VF3: running one command-mode v2 check; absent on v1, whose behavior it never changes. */
    v2?: V2CommandContext;
  }): Promise<FinalVerificationCheckResult> {
    const { check } = input;
    const v2 = input.v2;
    const name = v2 ? `check ${v2.checkId}` : check.category;
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
      // F2: inspection uncertainty precedes absence-based applicability.
      // An incomplete inventory cannot prove no family applies, so an
      // absence-based not-applicable build/tests category fails closed.
      // Non-executable categories carry no marker-absence claim and keep
      // their floor.
      if (input.inventoryIncomplete === true && EXECUTABLE_CATEGORIES.has(check.category)) {
        base.issues.push(`Required category ${check.category} was inspected with an incomplete file inventory; marker absence proves nothing.`);
        return { ...base, green: false };
      }
      if (input.commands !== undefined && input.commands.length > 0) {
        base.issues.push(`Not-applicable category ${check.category} supplied executable commands.`);
        return { ...base, green: false };
      }
      return { ...base, green: true };
    }
    // VF2: every tool this check needs is looked up before any of it launches.
    // A missing one is recorded as not run, never as a failure.
    const notRun = await this.missingTool([
      ...(input.provisioning ? [input.provisioning.command] : []),
      ...checkCommands(check.category, input),
    ], input.workspace.path);
    if (notRun) return { ...base, green: false, notRun };
    if (input.provisioning) {
      const provisioning = input.provisioning;
      const issue = await this.tracked(`Installing dependencies (${provisioning.manager})`, () => this.provisionDependencies(
        provisioning,
        input.workspace,
        input.signal,
        `${input.generationId}:${check.category}:${input.runOrdinal}`,
      ));
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
      const issuesBefore = base.issues.length;
      validateCommand(command, check.category, index, this.maximumTimeoutMs);
      // T6b repair (B2): direct node --test commands report through a
      // runner-owned junit file named for this exact run, so a stale file
      // from another run can never be mistaken for this run report.
      const reportFileName = junitReportFileName(input.generationId, check.category, index, input.runOrdinal);
      let runCommand = command;
      let junitDestination: string | undefined;
      let familyReport: { destination: string; format: "junit" | "trx"; runner: string } | undefined;
      let familyReportSet: { kind: "maven-surefire-reports"; runner: string; format: "junit" | "trx" } | undefined;
      let familyReportSetBefore: Map<string, { size: number; mtimeMs: number }> | undefined;
      let junitFiltered = false;
      let directJunit = false;
      if (executableCategory === "tests" && isDirectNodeTestCommand(command)) {
        junitDestination = join(input.workspace.path, reportFileName);
        junitFiltered = hasTestSelectionFlag(command.args);
        directJunit = true;
      }
      // Node reporter planning keeps its NODE_OPTIONS gate below; the
      // V3 language-family wiring after it runs independently of it.
      if (executableCategory === "tests" && !junitDestination) {
        // A caller that already sets NODE_OPTIONS (the T6a delivery
        // boundary plans its own report) keeps its reporter and report path.
        // T6b repair (R2-B4): the production tests command is the package
        // `run test` script. The T6a planner models a node --test script and
        // adds the reporter through NODE_OPTIONS (npm forwards it), so the
        // run records real failing ids and counts from this run's report.
        // Loaded on use: delivery-execution imports this module.
        // A caller that already sets NODE_OPTIONS keeps its own reporter;
        // only plan the Node report when the runner flags can reach it.
        const nodeReportEligible = !Object.hasOwn(command.environment ?? {}, "NODE_OPTIONS");
        const { planTestReport } = await import("./delivery-execution.js");
        const plan = planTestReport({
          checkoutPath: input.workspace.path,
          command,
          reportName: reportFileName.replace(/^\.aiboard-report-/, "").replace(/\.xml$/, ""),
          ambientNodeOptions: nodeOptionsWithTestNamePattern(this.ambientNodeOptions, this.testNamePattern),
        });
        if (nodeReportEligible && plan.runner === "node --test" && plan.command && plan.reportPath) {
          runCommand = plan.command;
          junitDestination = resolve(input.workspace.path, plan.reportPath);
          junitFiltered = plan.filtered === true;
        }
        // V3 (AR-R26): detected non-package.json families report through
        // their own wired flags, independent of Node reporter handling.
        // The trusted descriptor must agree with the plan, or the run
        // fails closed instead of reading a foreign file or minting
        // counts for an unsupported or ambiguous runner.
        {
          const { planLanguageTestReport, languageReportFormat } = await import("./language-execution-profile.js");
          const language = planLanguageTestReport({
            checkoutPath: input.workspace.path,
            command: { label: command.label, executable: command.executable, args: [...command.args] },
            reportName: reportFileName.replace(/^\.aiboard-report-/, "").replace(/\.xml$/, ""),
          });
          const v2Undescribed = v2 !== undefined && language !== undefined &&
            !input.reports?.some((entry) => entry.commandLabel === command.label);
          if (v2Undescribed) {
            // VF3: a v2 tests command the Runner holds no trusted report descriptor for runs on its
            // exit code alone; the Runner never mints counts it cannot read from a trusted report.
          } else if (language === undefined) {
            const orphan = input.reports?.find((entry) => entry.commandLabel === command.label);
            if (orphan) {
              base.issues.push(`tests command ${command.label} carries a trusted report descriptor but matches no language report plan; refusing to guess its report.`);
            }
          } else if (!language.format || (!language.reportPath && !language.reportSet)) {
            base.issues.push(`tests command ${command.label} has no usable machine-readable report: ${language.unsupported ?? "the language test runner has no wired report."}.`);
          } else if (languageReportFormat(language.runner) !== language.format) {
            base.issues.push(`tests command ${command.label} report plan disagrees with the trusted execution profile.`);
          } else {
            const descriptor = input.reports?.find((entry) => entry.commandLabel === command.label);
            if (!descriptor) {
              base.issues.push(`tests command ${command.label} plans a ${language.runner} report but the trusted execution profile carries no report descriptor; refusing to mint counts.`);
            } else if (descriptor.runner !== language.runner || descriptor.format !== language.format) {
              base.issues.push(`tests command ${command.label} report plan disagrees with the trusted execution profile.`);
            } else if (language.reportSet) {
              familyReportSet = { kind: language.reportSet.kind, runner: language.runner, format: language.format };
            } else if (language.reportPath) {
              if (language.command) {
                runCommand = {
                  label: command.label,
                  executable: language.command.executable,
                  args: [...language.command.args],
                  ...(command.timeoutMs !== undefined ? { timeoutMs: command.timeoutMs } : {}),
                  ...(command.environment ? { environment: { ...command.environment } } : {}),
                };
              }
              familyReport = { destination: resolve(input.workspace.path, language.reportPath), format: language.format, runner: language.runner };
            }
          }
        }
      }
      if (junitDestination) {
        try {
          this.tempRecorders?.recorded({ path: junitDestination, kind: "file", createdAt: this.clock() });
        } catch { /* bookkeeping never breaks verification */ }
      }
      if (familyReport) {
        try {
          this.tempRecorders?.recorded({ path: familyReport.destination, kind: "file", createdAt: this.clock() });
        } catch { /* bookkeeping never breaks verification */ }
        if (existsSync(familyReport.destination)) {
          base.issues.push(`tests command ${command.label} report path already exists before this run; refusing to read a report this run did not write.`);
          familyReport = undefined;
          runCommand = command;
        }
      }
      if (familyReportSet) {
        const { scanMavenSurefireReportFiles } = await import("./language-execution-profile.js");
        try {
          const snapshot = await scanMavenSurefireReportFiles({ checkoutPath: input.workspace.path });
          if (snapshot.incomplete) {
            base.issues.push(`tests command ${command.label} report-set inventory is incomplete before this run; refusing to collect reports.`);
            familyReportSet = undefined;
          } else {
            familyReportSetBefore = snapshot.snapshot;
          }
        } catch {
          base.issues.push(`tests command ${command.label} report-set inventory is unavailable before this run; refusing to collect reports.`);
          familyReportSet = undefined;
        }
      }
      if (input.inventoryIncomplete) {
        base.issues.push(`Required category ${check.category} was inspected with an incomplete file inventory; marker absence proves nothing.`);
      }
      const startState = await repositoryState(input.workspace.path, this.git);
      const workingTreeIdentity = await workingTreeForRunner(this.git, input.workspace.path);
      const commandCwd = v2?.cwd ?? input.workspace.path;
      const outputPatterns = v2?.outputs(index);
      const startedAt = this.clock();
      const execution = v2?.cwdIssue
        ? cwdRefused(v2.cwdIssue)
        : await executeCommand(
          runCommand,
          commandCwd,
          input.signal,
          this.defaultTimeoutMs,
          this.maximumTimeoutMs,
          this.execution,
          {
            runId: this.runId,
            sessionId: this.taskId,
            actor: this.actor,
            taskId: this.taskId,
            callId: `${input.generationId}:${v2 ? v2.checkId : check.category}:${index}:${input.runOrdinal}`,
            ...(outputPatterns?.length ? { freshExecution: true as const } : {}),
          },
          directJunit && junitDestination ? { destination: junitDestination, ambientNodeOptions: this.ambientNodeOptions } : undefined,
        );
      const finishedAt = this.clock();
      const outputs = outputPatterns?.length
        ? await this.captureOutputs(execution, outputPatterns, input.workspace.path, `${name} ${command.label}`)
        : undefined;
      const junitReport = junitDestination
        ? await readJUnitTestReport(junitDestination, input.workspace.path, junitFiltered)
        : undefined;
      const familyReportReading = familyReport
        ? await readLanguageTestReportFile({
          checkoutPath: input.workspace.path,
          destination: familyReport.destination,
          format: familyReport.format,
          artifacts: this.artifacts,
        })
        : undefined;
      const familyReportSetReading = familyReportSet && familyReportSetBefore
        ? await readLanguageTestReportSet({
          checkoutPath: input.workspace.path,
          before: familyReportSetBefore,
          artifacts: this.artifacts,
        })
        : undefined;
      const familySetFactReport = familyReportSetReading?.reading
        ? {
          failingTestIds: [] as string[],
          executed: familyReportSetReading.reading.executed,
          failed: familyReportSetReading.reading.failed,
          ...(familyReportSetReading.artifactHash ? { artifactHash: familyReportSetReading.artifactHash } : {}),
        }
        : undefined;
      const familyFactReport = familyReportReading?.reading
        ? {
          failingTestIds: [] as string[],
          executed: familyReportReading.reading.executed,
          failed: familyReportReading.reading.failed,
          ...(familyReportReading.artifactHash ? { artifactHash: familyReportReading.artifactHash } : {}),
        }
        : familySetFactReport;
      if (familyReport && execution.exitCode === 0) {
        if (!familyReportReading?.reading) {
          base.issues.push(`tests command ${command.label} planned a ${familyReport.format} report but this run produced no readable report at the runner-owned path.`);
        } else if (familyReportReading.reading.executed < 1) {
          base.issues.push(`tests command ${command.label} report shows zero executed tests; at least one executed test is required.`);
        } else if (familyReportReading.reading.failed > 0) {
          base.issues.push(`tests command ${command.label} report shows ${familyReportReading.reading.failed} failed tests; report failures prevent a green run.`);
        }
      }
      if (familyReportSet && execution.exitCode === 0) {
        if (!familyReportSetReading?.reading) {
          base.issues.push(`tests command ${command.label} planned a ${familyReportSet.format} report set but this run produced no readable fresh reports at the runner-owned paths.`);
        } else if (familyReportSetReading.reading.executed < 1) {
          base.issues.push(`tests command ${command.label} report set shows zero executed tests; at least one executed test is required.`);
        } else if (familyReportSetReading.reading.failed > 0) {
          base.issues.push(`tests command ${command.label} report set shows ${familyReportSetReading.reading.failed} failed tests; report failures prevent a green run.`);
        }
      }
      const endState = await repositoryState(input.workspace.path, this.git);
      const [stdoutArtifact, stderrArtifact] = await Promise.all([
        artifactForFinalOutput(this.artifacts, execution, "stdout", `${name} ${command.label} stdout`),
        artifactForFinalOutput(this.artifacts, execution, "stderr", `${name} ${command.label} stderr`),
      ]);
      const executionErrorCode = stableExecutionErrorCode(execution.startError);
      const fact: FinalVerificationCommandFact = {
        kind: "command",
        workingTreeIdentity: settleWorkingTreeIdentity(workingTreeIdentity, await workingTreeForRunner(this.git, input.workspace.path)),
        childEnvironmentIdentity: execution.routed?.childEnvironmentIdentity ?? unknownChildEnvironment(),
        ...(execution.routed?.childEnvironmentAudit ? {childEnvironmentAudit: execution.routed.childEnvironmentAudit} : {}),
        category: executableCategory,
        ...(v2 ? { checkId: v2.checkId } : {}),
        label: command.label,
        executable: command.executable,
        command: command.executable,
        args: [...command.args],
        cwd: commandCwd,
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
        ...(junitReport ? { report: junitReport } : {}),
        ...(familyFactReport ? { report: familyFactReport } : {}),
        ...(execution.routed ? commandReuseMetadata(execution.routed) : {}),
        ...(execution.routed?.reuseSource?.fact.kind === "command" && "report" in execution.routed.reuseSource.fact ? {report: (execution.routed.reuseSource.fact as FinalVerificationCommandFact).report} : {}),
        ...(v2 && index >= (v2.workflowStepsFrom ?? Number.POSITIVE_INFINITY) ? { workflowStep: true as const } : {}),
        ...(outputs ? { outputs } : {}),
      };
      base.facts.push(fact);

      const expectedExitCode = v2?.expectedExitCodes?.get(index) ?? 0;
      if (execution.exitCode !== expectedExitCode && !v2?.cwdIssue) {
        base.issues.push(expectedExitCode === 0
          ? `${name} command ${command.label} exited with non-zero code ${String(execution.exitCode)}.`
          : `${name} command ${command.label} exited with code ${String(execution.exitCode)}, not the expected ${expectedExitCode}.`);
      }
      if (execution.startError) {
        base.issues.push(
          `${name} command ${command.label} could not start${executionErrorCode ? ` [${executionErrorCode}]` : ""}: ${execution.startError.message}.`,
        );
      }
      if (execution.signal) {
        base.issues.push(`${name} command ${command.label} ended by ${execution.signal}.`);
      }
      if (execution.timedOut) {
        base.issues.push(`${name} command ${command.label} timed out.`);
      }
      if (execution.cancelled) {
        base.issues.push(`${name} command ${command.label} was cancelled.`);
      }
      if (startState.revision !== input.workspace.targetRevision) {
        base.issues.push(
          `${name} command ${command.label} started at revision ${startState.revision}, ` +
            `not target revision ${input.workspace.targetRevision}.`,
        );
      }
      if (endState.revision !== input.workspace.targetRevision) {
        base.issues.push(
          `${name} command ${command.label} changed the verification revision from ` +
            `${input.workspace.targetRevision} to ${endState.revision}.`,
        );
      }

      const evidenceId = this.recordEvidence(
        fact,
        input.generationId,
        v2 ? v2.checkId : executableCategory,
        index,
        finishedAt,
        input.runOrdinal,
      );
      if (evidenceId) base.evidenceIds.push(evidenceId);
      else base.issues.push(`${name} command ${command.label} has no durable evidence record.`);
      // VF3: a v2 program that failed is not followed by its steps.
      if (v2 && base.issues.length > issuesBefore) break;
    }
    return {
      ...base,
      green: base.issues.length === 0 && base.evidenceIds.length === base.facts.length,
    };
  }

  private async missingTool(
    commands: readonly { executable: string; environment?: Readonly<Record<string, string | undefined>> }[],
    cwd: string,
  ): Promise<VerificationNotRun | undefined> {
    if (!this.toolLookup) return undefined;
    const missing: string[] = [];
    const seen = new Set<string>();
    for (const command of commands) {
      // A command that sets its own PATH searches directories the Runner did not look in.
      if (Object.keys(command.environment ?? {}).some((name) => name.toUpperCase() === "PATH")) continue;
      if (seen.has(command.executable)) continue;
      seen.add(command.executable);
      let found;
      try {
        found = await this.toolLookup(command.executable, { cwd });
      } catch {
        continue; // An undecided lookup launches as before.
      }
      if (found.status === "missing") missing.push(command.executable);
    }
    if (missing.length === 0) return undefined;
    return {
      reason: "tool_missing",
      tool: missing[0]!,
      detail: `${missing.join(", ")} ${missing.length === 1 ? "was" : "were"} not found on PATH, so the check was not run.`.slice(0, 1_024),
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
    /** VF3: running one program-mode v2 check; absent on v1, whose behavior it never changes. */
    v2?: V2ProgramContext;
  }): Promise<FinalVerificationCheckResult> {
    const smoke = input.input;
    const v2 = input.v2;
    const name = v2 ? `check ${v2.checkId}` : "runtime_smoke";
    if (!smoke) {
      input.base.issues.push("Required runtime_smoke check has no runtime command.");
      return { ...input.base, green: false };
    }
    if (!this.managedProcess) {
      input.base.issues.push("Required runtime_smoke check has no managed process service.");
      return { ...input.base, green: false };
    }
    validateRuntimeSmoke(smoke, this.maximumTimeoutMs);

    const workingTreeIdentity = await workingTreeForRunner(this.git, input.workspace.path);
    const startedAt = this.clock();
    const startState = await repositoryState(input.workspace.path, this.git);
    let observation: FinalVerificationManagedProcessObservation | undefined;
    let readinessSatisfied = false;
    let cleanupSucceeded = false;
    let timedOut = false;
    let cancelled = false;
    let startError: Error | undefined;
    const steps: Array<{ fact: FinalVerificationCommandFact; issues: string[]; passed: boolean }> = [];

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
        if (observation && readinessSatisfied && smoke.steps?.length) {
          for (const [index, step] of smoke.steps.entries()) {
            const run = await this.runSmokeStep(smoke, step, index, input, v2);
            steps.push(run);
            if (!run.passed) break;
          }
          observation = await this.managedProcess.poll(observation.processId).catch(() => observation!);
          if (observation.status !== "running") {
            input.base.issues.push(
              `${name} command ${smoke.label} stopped while its workflow steps ran` +
                `${observation.exitCode !== null ? ` (exit code ${String(observation.exitCode)})` : ""}.`,
            );
          }
        }
      }
    } finally {
      if (observation) {
        try {
          observation = (await this.managedProcess.stop(observation.processId)) ?? observation;
          cleanupSucceeded = true;
        } catch (error) {
          input.base.issues.push(`${name} process cleanup failed: ${asError(error).message}.`);
        }
      }
      if (smoke.releasePort) {
        try {
          await smoke.releasePort(smoke.endpoint);
        } catch (error) {
          cleanupSucceeded = false;
          input.base.issues.push(`${name} port cleanup failed: ${asError(error).message}.`);
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
    // VF3: the program's own outputs are read only after it was stopped and its cleanup succeeded.
    const programOutputs = v2?.outputs?.length
      ? observation?.status === "stopped" && cleanupSucceeded
        ? await captureCommandOutputs({ workspace: input.workspace.path, patterns: v2.outputs, artifacts: this.artifacts, label: `${name} ${smoke.label}` })
        : outputsNotCaptured(v2.outputs, "process_not_proven_ended")
      : undefined;
    const fact: FinalVerificationCommandFact = {
      kind: "command",
      workingTreeIdentity: settleWorkingTreeIdentity(workingTreeIdentity, await workingTreeForRunner(this.git, input.workspace.path)),
      childEnvironmentIdentity: unknownChildEnvironment(),
      category: "runtime_smoke",
      ...(v2 ? { checkId: v2.checkId } : {}),
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
      ...(programOutputs ? { outputs: programOutputs } : {}),
    };
    input.base.facts.push(fact);

    if (startError) {
      input.base.issues.push(`${name} command ${smoke.label} could not start: ${startError.message}.`);
    }
    if (cancelled) input.base.issues.push(`${name} command ${smoke.label} was cancelled.`);
    if (timedOut) input.base.issues.push(`${name} command ${smoke.label} timed out before readiness.`);
    if (!readinessSatisfied && !timedOut && !cancelled) {
      input.base.issues.push(`${name} command ${smoke.label} did not become ready.`);
    }
    if (observation && observation.exitCode !== null && observation.exitCode !== 0) {
      input.base.issues.push(
        `${name} command ${smoke.label} exited with non-zero code ${String(observation.exitCode)}.`,
      );
    }
    if (startState.revision !== input.workspace.targetRevision) {
      input.base.issues.push(
        `${name} command ${smoke.label} started at revision ${startState.revision}, ` +
          `not target revision ${input.workspace.targetRevision}.`,
      );
    }
    if (endState.revision !== input.workspace.targetRevision) {
      input.base.issues.push(
        `${name} command ${smoke.label} changed the verification revision from ` +
          `${input.workspace.targetRevision} to ${endState.revision}.`,
      );
    }

    const evidenceId = this.recordEvidence(
      fact,
      input.generationId,
      v2 ? v2.checkId : "runtime_smoke",
      0,
      finishedAt,
      input.runOrdinal,
    );
    if (evidenceId) input.base.evidenceIds.push(evidenceId);
    else input.base.issues.push(`${name} command ${smoke.label} has no durable evidence record.`);
    for (const [index, step] of steps.entries()) {
      input.base.facts.push(step.fact);
      input.base.issues.push(...step.issues);
      const stepEvidenceId = this.recordEvidence(
        step.fact,
        input.generationId,
        v2 ? v2.checkId : "runtime_smoke",
        index + 1,
        step.fact.finishedAt,
        input.runOrdinal,
      );
      if (stepEvidenceId) input.base.evidenceIds.push(stepEvidenceId);
      else input.base.issues.push(`${name} step ${step.fact.label} has no durable evidence record.`);
    }
    return {
      ...input.base,
      green: input.base.issues.length === 0 && input.base.evidenceIds.length === input.base.facts.length,
    };
  }

  /** One user-workflow command against the live runtime_smoke program; never reused from an earlier run. */
  private async runSmokeStep(
    smoke: FinalVerificationRuntimeSmokeInput,
    step: FinalVerificationCommand,
    index: number,
    input: { workspace: VerificationWorkspace; generationId: string; runOrdinal: number; signal?: AbortSignal },
    v2?: V2ProgramContext,
  ): Promise<{ fact: FinalVerificationCommandFact; issues: string[]; passed: boolean }> {
    // A v2 step's label already names its check (the resolved command carries it).
    const label = v2 ? step.label : `${smoke.label} › ${step.label}`;
    const name = v2 ? `check ${v2.checkId}` : "runtime_smoke";
    const outputPatterns = v2?.stepOutputs(index);
    const startState = await repositoryState(input.workspace.path, this.git);
    const workingTreeIdentity = await workingTreeForRunner(this.git, input.workspace.path);
    const startedAt = this.clock();
    const execution = await executeCommand(
      step,
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
        callId: `${input.generationId}:${v2 ? v2.checkId : "runtime_smoke"}:step${index}:${input.runOrdinal}`,
        // A step's result depends on the live program, so it must never be reused from an earlier run.
        toolName: "final-verification.runtime_smoke_step",
        ...(outputPatterns?.length ? { freshExecution: true as const } : {}),
      },
    );
    const finishedAt = this.clock();
    const outputs = outputPatterns?.length
      ? await this.captureOutputs(execution, outputPatterns, input.workspace.path, `${name} ${label}`)
      : undefined;
    const endState = await repositoryState(input.workspace.path, this.git);
    const [stdoutArtifact, stderrArtifact] = await Promise.all([
      artifactForFinalOutput(this.artifacts, execution, "stdout", `${name} ${label} stdout`),
      artifactForFinalOutput(this.artifacts, execution, "stderr", `${name} ${label} stderr`),
    ]);
    const executionErrorCode = stableExecutionErrorCode(execution.startError);
    const fact: FinalVerificationCommandFact = {
      kind: "command",
      workingTreeIdentity: settleWorkingTreeIdentity(workingTreeIdentity, await workingTreeForRunner(this.git, input.workspace.path)),
      childEnvironmentIdentity: execution.routed?.childEnvironmentIdentity ?? unknownChildEnvironment(),
      ...(execution.routed?.childEnvironmentAudit ? {childEnvironmentAudit: execution.routed.childEnvironmentAudit} : {}),
      category: "runtime_smoke",
      ...(v2 ? { checkId: v2.checkId } : {}),
      label,
      executable: step.executable,
      command: step.executable,
      args: [...step.args],
      cwd: input.workspace.path,
      startedAt,
      finishedAt,
      exitCode: execution.exitCode,
      signal: execution.signal,
      timedOut: execution.timedOut,
      cancelled: execution.cancelled,
      outputTruncated: execution.outputTruncated,
      ...(executionErrorCode ? { errorCode: executionErrorCode } : {}),
      stdoutArtifactHash: stdoutArtifact.hash,
      stderrArtifactHash: stderrArtifact.hash,
      repositoryRevision: input.workspace.targetRevision,
      targetRevision: input.workspace.targetRevision,
      startState,
      endState,
      ...(smoke.endpoint ? { endpoint: smoke.endpoint } : {}),
      workflowStep: true,
      ...(outputs ? { outputs } : {}),
    };
    const issues: string[] = [];
    if (execution.startError) issues.push(`${name} step ${label} could not start: ${execution.startError.message}.`);
    if (execution.cancelled) issues.push(`${name} step ${label} was cancelled.`);
    if (execution.timedOut) issues.push(`${name} step ${label} timed out.`);
    if (execution.signal) issues.push(`${name} step ${label} ended by ${execution.signal}.`);
    if (!execution.startError && !execution.cancelled && !execution.timedOut && execution.exitCode !== 0) {
      const detail = (execution.stderr.length ? execution.stderr : execution.stdout).toString("utf8").trim().slice(-400);
      issues.push(
        `${name} step ${label} exited with non-zero code ${String(execution.exitCode)}` +
          `${detail ? `: ${detail}` : ""}.`,
      );
    }
    if (endState.revision !== input.workspace.targetRevision) {
      issues.push(
        `${name} step ${label} changed the verification revision from ` +
          `${input.workspace.targetRevision} to ${endState.revision}.`,
      );
    }
    return { fact, issues, passed: issues.length === 0 };
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
    let browserMissing: string | undefined;

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
        const missing = label === "navigation" ? browserExecutableMissing(result.error) : undefined;
        if (missing) browserMissing = missing;
        else input.base.issues.push(`browser ${browserInput.label} ${label} failed: ${asError(result.error).message}.`);
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
    if (browserMissing) {
      // VF2: no browser to launch is a missing tool, unless something else also went wrong.
      if (input.base.issues.length === 0 && facts.length === 0) {
        return { ...input.base, green: false, notRun: { reason: "tool_missing", tool: "browser", detail: browserMissing } };
      }
      input.base.issues.push(`browser ${browserInput.label} navigation failed: ${browserMissing}.`);
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
    /** The v1 category, or the v2 check id. */
    category: string,
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

/** VF3: a v2 command that could not run because its working directory is not inside the checkout. */
function cwdRefused(issue: string): ProcessResult {
  return {
    exitCode: null,
    signal: null,
    stdout: Buffer.alloc(0),
    stderr: Buffer.alloc(0),
    timedOut: false,
    cancelled: false,
    outputTruncated: false,
    startError: Object.assign(new Error(issue), { code: "cwd_not_in_checkout" }),
  };
}

/** VF3: why a v2 command's working directory is unusable, or undefined when it is a directory inside the checkout. */
async function directoryInsideIssue(workspacePath: string, cwd: string, checkId: string): Promise<string | undefined> {
  try {
    const [root, target] = await Promise.all([realpath(workspacePath), realpath(cwd)]);
    const inside = relative(root, target);
    if (inside.startsWith("..") || resolve(root, inside) !== target) {
      return `check ${checkId} working directory leaves the verification checkout`;
    }
    if (!(await stat(target)).isDirectory()) return `check ${checkId} working directory is not a directory`;
    return undefined;
  } catch {
    return `check ${checkId} working directory does not exist in the verification checkout`;
  }
}

/** VF3: the trusted report descriptors for a v2 tests command that is one of the profile's own. */
function reportDescriptorsFor(
  command: FinalVerificationCommand,
  profile: FinalVerificationExecutionProfile,
): FinalVerificationReportDescriptor[] | undefined {
  const own = (profile.commands.tests ?? []).find((candidate) =>
    candidate.executable === command.executable && sameStringArray(candidate.args, command.args));
  const descriptor = own ? profile.reports?.find((entry) => entry.commandLabel === own.label) : undefined;
  return descriptor ? [{ ...descriptor, commandLabel: command.label }] : undefined;
}

/** VF2: the commands a check launches, in order, for the Runner's tool lookup. */
function checkCommands(
  category: FinalVerificationCategory,
  input: {
    commands: readonly FinalVerificationCommand[] | undefined;
    runtimeSmoke: FinalVerificationRuntimeSmokeInput | undefined;
    browser: FinalVerificationBrowserInput | undefined;
  },
): Array<{ executable: string; environment?: Readonly<Record<string, string | undefined>> }> {
  if (category === "build" || category === "tests") return [...(input.commands ?? [])];
  const program = category === "runtime_smoke" ? input.runtimeSmoke : input.browser?.server;
  return program ? [program, ...(program.steps ?? [])] : [];
}

/**
 * VF2: Playwright's own report that the browser it launches is not installed
 * (its install hint starts "Executable doesn't exist at"). Any other browser
 * error stays an issue of the check.
 */
export function browserExecutableMissing(error: unknown): string | undefined {
  const message = error instanceof Error ? error.message : String(error);
  if (!message.includes("Executable doesn't exist")) return undefined;
  const line = message.split(/\r?\n/).find((entry) => entry.includes("Executable doesn't exist")) ?? message;
  return line.trim().slice(0, 1_024);
}

function authoritativeExecutionInput(
  input: FinalVerificationRunInput,
  targetRevision: string,
): {
  commands: FinalVerificationExecutionProfile["commands"];
  provisioning?: FinalVerificationDependencyProvisioning;
  reports?: FinalVerificationReportDescriptor[];
  inventoryIncomplete?: boolean;
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
    ...(input.executionProfile.reports
      ? { reports: input.executionProfile.reports.map((report) => ({ ...report })) }
      : {}),
    ...(input.executionProfile.inventoryIncomplete !== undefined
      ? { inventoryIncomplete: input.executionProfile.inventoryIncomplete }
      : {}),
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

/** Key-order independent; a removal (`undefined`) differs from an absent name. */
function sameEnvironment(
  left: Readonly<Record<string, string | undefined>> | undefined,
  right: Readonly<Record<string, string | undefined>> | undefined,
): boolean {
  const entries = (value: Readonly<Record<string, string | undefined>> | undefined) =>
    Object.entries(value ?? {})
      .map(([name, entry]) => `${name}\u0000${entry === undefined ? "\u0001removed" : `=${entry}`}`)
      .sort();
  const leftEntries = entries(left);
  const rightEntries = entries(right);
  return leftEntries.length === rightEntries.length && leftEntries.every((entry, index) => entry === rightEntries[index]);
}

function sameCommands(
  left: readonly FinalVerificationCommand[] | undefined,
  right: readonly FinalVerificationCommand[] | undefined,
): boolean {
  if (!left || !right) return left === right || (!left?.length && !right?.length);
  return left.length === right.length && left.every((command, index) => {
    const expected = right[index]!;
    return command.label === expected.label && command.executable === expected.executable &&
      command.timeoutMs === expected.timeoutMs && sameStringArray(command.args, expected.args) &&
      sameEnvironment(command.environment, expected.environment);
  });
}

function sameSmokeBinding(
  left: FinalVerificationRuntimeSmokeInput,
  right: FinalVerificationRuntimeSmokeInput | undefined,
): boolean {
  return Boolean(right) && left.label === right!.label && left.executable === right!.executable &&
    left.endpoint === right!.endpoint && left.timeoutMs === right!.timeoutMs &&
    sameStringArray(left.args, right!.args) &&
    (left.steps ?? []).length === (right!.steps ?? []).length &&
    (left.steps ?? []).every((step, index) => {
      const other = right!.steps![index]!;
      return step.label === other.label && step.executable === other.executable &&
        step.timeoutMs === other.timeoutMs && sameStringArray(step.args, other.args);
    });
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

/** T6b repair (B2): runner-owned junit report name for one exact command run. */
export function junitReportFileName(generationId: string, category: string, index: number, runOrdinal: number): string {
  const key = `${generationId}-${category}-${index}-${runOrdinal}`.replace(/[^A-Za-z0-9_-]+/g, "_");
  return `.aiboard-report-fv-${key}.xml`;
}

/**
 * T6b repair (B2/N1): child environment for final-verification commands.
 * NODE_TEST_CONTEXT is always stripped (it would make node --test exit 0
 * with a failing file); direct node --test commands additionally report
 * through a runner-owned junit file (T6a reporter flags, forward slashes:
 * NODE_OPTIONS unescapes backslashes, so a Windows path would corrupt).
 * Commands that already select a reporter keep their own options and produce no report.
 */
function junitEnvironment(
  command: FinalVerificationCommand,
  junit: { destination: string; ambientNodeOptions?: string } | undefined,
): Record<string, string | undefined> {
  const explicitEnvironment: Record<string, string | undefined> = {
    NODE_TEST_CONTEXT: undefined,
    ...command.environment,
  };
  if (!junit) return explicitEnvironment;
  const effectiveNodeOptions = explicitEnvironment.NODE_OPTIONS ?? junit.ambientNodeOptions ?? "";
  if (effectiveNodeOptions.includes("--test-reporter")) return explicitEnvironment;
  return {
    ...explicitEnvironment,
    NODE_OPTIONS: `${effectiveNodeOptions} --test-reporter=spec --test-reporter-destination=stdout --test-reporter=junit --test-reporter-destination="${junit.destination.replace(/\\/g, "/")}"`.trim(),
  };
}

interface JUnitTestReport {
  readonly failingTestIds: string[];
  readonly executed: number;
  readonly failed: number;
  /** V3: immutable capture of the family report bytes that were read. */
  readonly artifactHash?: string;
}

/**
 * T6b repair (R2-B4): the owner real-counts reading of one node junit
 * report, through the reviewed T6a parser (nodeJunitOutcome): file-level
 * synthetic entries, skipped tests, and suites never count as executed.
 * Executed = real passed + failed; a filtered run with no real test yields
 * executed 0, which the OA-14 verdict never treats as a clean rerun.
 */
/**
 * V3 (AR-R26): the owner real-counts reading of one wired language-family
 * report, through the conservative T5 JUnit/TRX readers. Anything missing,
 * malformed, truncated, contradictory, or zero-test yields no reading, so
 * the caller fails closed instead of minting counts. A readable report is
 * captured into the immutable artifact store.
 */
async function readLanguageTestReportFile(input: {
  checkoutPath: string;
  destination: string;
  format: "junit" | "trx";
  artifacts: ArtifactStore;
}): Promise<{ reading?: { executed: number; failed: number }; artifactHash?: string }> {
  // Loaded on use: delivery-execution imports this module.
  const { outcomeFromReportReading, readBoundedReportBytes, readJUnitReport, readTrxReport } = await import("./test-report-readers.js");
  let bytes: Buffer;
  try {
    bytes = readBoundedReportBytes({ checkoutPath: input.checkoutPath, reportPath: relative(input.checkoutPath, input.destination) });
  } catch {
    return {};
  }
  const xml = bytes.toString("utf8");
  const parsed = input.format === "junit" ? readJUnitReport(xml) : readTrxReport(xml);
  const outcome = outcomeFromReportReading(parsed);
  let stored: { hash: string };
  try {
    stored = await input.artifacts.put(bytes, "application/xml", `final verification test report ${input.destination}`);
  } catch {
    return {};
  }
  // Malformed bounded bytes stay archived without granting counts.
  if (parsed.status !== "ok" || outcome.outcome === "unknown") return {};
  return {
    reading: { executed: outcome.counts.passed + outcome.counts.failed, failed: outcome.counts.failed },
    artifactHash: stored.hash,
  };
}

/**
 * V3 (AR-R26): the owner real-counts reading of one invocation-owned
 * Maven Surefire fresh report set. Only files new or changed since the
 * pre-run snapshot are collected, each through the shared bounded
 * confined reader and the existing JUnit reader, then aggregated. A
 * stale, missing, oversized, symlinked, malformed, or incomplete set
 * yields no reading, so the caller fails closed instead of minting
 * counts. The exact aggregated bytes are archived immutably.
 */
async function readLanguageTestReportSet(input: {
  checkoutPath: string;
  before: ReadonlyMap<string, { size: number; mtimeMs: number }>;
  artifacts: ArtifactStore;
}): Promise<{ reading?: { executed: number; failed: number }; artifactHash?: string }> {
  const { scanMavenSurefireReportFiles } = await import("./language-execution-profile.js");
  const { aggregateJUnitReportSet, outcomeFromReportReading, readBoundedReportBytes, readJUnitReport } = await import("./test-report-readers.js");
  let scan: Awaited<ReturnType<typeof scanMavenSurefireReportFiles>>;
  try {
    scan = await scanMavenSurefireReportFiles({ checkoutPath: input.checkoutPath, before: input.before });
  } catch {
    return {};
  }
  if (scan.incomplete || scan.fresh.length === 0) return {};
  const parts: Buffer[] = [];
  const readings = [];
  for (const reportPath of scan.fresh) {
    let bytes: Buffer;
    try {
      bytes = readBoundedReportBytes({ checkoutPath: input.checkoutPath, reportPath });
    } catch {
      // An unusable member refuses ALL counts, but the bounded bytes
      // already collected stay archived as safe diagnostics.
      try {
        if (parts.length > 0) {
          await input.artifacts.put(Buffer.concat(parts), "application/xml", "final verification maven surefire report set");
        }
      } catch {
        // Diagnostic preservation never masks the refusal.
      }
      return {};
    }
    parts.push(bytes);
    readings.push(readJUnitReport(bytes.toString("utf8")));
  }
  const aggregate = aggregateJUnitReportSet(readings);
  const outcome = outcomeFromReportReading(aggregate);
  let stored: { hash: string };
  try {
    const separator = Buffer.from("\n", "utf8");
    const joined: Buffer[] = [];
    for (const part of parts) {
      if (joined.length > 0) joined.push(separator);
      joined.push(part);
    }
    stored = await input.artifacts.put(Buffer.concat(joined), "application/xml", "final verification maven surefire report set");
  } catch {
    return {};
  }
  // The exact bytes stay archived even when they grant no counts.
  if (aggregate.status !== "ok" || outcome.outcome === "unknown") return {};
  return {
    reading: { executed: outcome.counts.passed + outcome.counts.failed, failed: outcome.counts.failed },
    artifactHash: stored.hash,
  };
}

async function readJUnitTestReport(
  destination: string,
  workspacePath: string,
  filtered: boolean,
): Promise<JUnitTestReport | undefined> {
  let xml: string;
  try {
    xml = await readFile(destination, "utf8");
  } catch {
    return undefined;
  }
  // Loaded on use: delivery-execution imports this module.
  const { nodeJunitOutcome } = await import("./delivery-execution.js");
  const outcome = nodeJunitOutcome(xml, workspacePath, filtered);
  if (!outcome.counts) return undefined;
  return {
    failingTestIds: [...(outcome.failingTestIds ?? [])],
    executed: outcome.counts.passed + outcome.counts.failed,
    failed: outcome.counts.failed,
  };
}

/**
 * T6b repair (R2-B4): NODE_OPTIONS for a narrowed package rerun. The
 * pattern is double-quoted with backslashes and quotes escaped, because
 * NODE_OPTIONS unescapes them.
 */
export function nodeOptionsWithTestNamePattern(ambient: string | undefined, pattern: string | undefined): string | undefined {
  if (pattern === undefined) return ambient;
  const quoted = pattern.replace(/\\/g, "\\\\").replace(/"/g, "\\\"");
  return `${ambient?.trim() ?? ""} --test-name-pattern="${quoted}"`.trim();
}

async function executeCommand(  command: FinalVerificationCommand,
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
    toolName?: string;
    /** VF6: a command that keeps output files never answers from earlier evidence. */
    freshExecution?: true;
  },
  junit?: { destination: string; ambientNodeOptions?: string },
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
      // T6b repair (B2/N1): the reviewed harness never leaks its own
      // test-runner context into the child. NODE_TEST_CONTEXT would make
      // node --test exit 0 with a failing file, so it is always stripped.
      // Direct node --test commands additionally report through a
      // runner-owned junit file, so the run records the real failing
      // test ids from this run report (mirrors the T6a reporter flags).
      ...(junitEnvironment(command, junit) ? { explicitEnvironment: junitEnvironment(command, junit) } : {}),
      ...(identity.freshExecution ? { freshExecution: true as const } : {}),
      context: {
        runId: identity.runId,
        sessionId: identity.sessionId,
        actor: identity.actor,
        taskId: identity.taskId,
        callId: identity.callId,
        toolName: identity.toolName ?? "final-verification.command",
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
    ...(check.notRun ? { notRun: Object.freeze({ ...check.notRun }) } : {}),
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
  if (input.steps !== undefined) {
    if (!Array.isArray(input.steps)) throw new Error("runtime_smoke steps must be an array.");
    input.steps.forEach((step, index) => validateCommand(step, "runtime_smoke", index, maximumTimeoutMs));
  }
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

export function createFinalVerificationManagedProcessAdapter(options: Readonly<{
  service: ManagedProcessService;
  executionGrants: ExecutionGrantAuthority;
  permissionProfile: PermissionProfile;
  runId: string;
  taskId: string;
  callScope: string;
  actor: AgentActor;
}>): FinalVerificationManagedProcess {
  if (!options.callScope.trim()) throw new Error("Final verification managed call scope is required.");
  const sessionId = `final-verification:${options.taskId}`;
  const workspaces = new Map<string, string>();
  let sequence = 0;
  const invoke = async <T>(input: Readonly<{
    toolName: "process.start" | "process.poll" | "process.signal";
    workspacePath: string;
    access: "read" | "write";
  }>, perform: (context: ToolExecutionContext) => Promise<T>): Promise<T> => {
    const callId = `final-verification-managed:${options.taskId}:${options.callScope}:${++sequence}:${input.toolName}`;
    const grant = await options.executionGrants.issue({
      runId: options.runId,
      sessionId,
      actor: options.actor,
      toolName: input.toolName,
      callId,
      permissionProfile: options.permissionProfile,
      workspacePath: input.workspacePath,
      access: [{ path: input.workspacePath, mode: input.access }],
      externalApproved: false,
      destructiveApproved: false,
      networkApproved: false,
    });
    try {
      return await perform({
        runId: options.runId,
        sessionId,
        actor: { ...options.actor },
        callId,
        toolName: input.toolName,
        workspacePath: input.workspacePath,
        executionGrant: grant,
      });
    } finally {
      await options.executionGrants.revoke(grant, "completed");
    }
  };
  return Object.freeze({
    async start(input: FinalVerificationManagedProcessInput): Promise<ManagedProcessSnapshot> {
      const snapshot = await invoke({ toolName: "process.start", workspacePath: input.cwd, access: "write" }, context =>
        options.service.start({ command: input.executable, args: [...input.args], cwd: "." }, context, input.cwd));
      workspaces.set(snapshot.processId, input.cwd);
      return snapshot;
    },
    async poll(processId: string): Promise<ManagedProcessSnapshot> {
      const workspacePath = workspaces.get(processId);
      if (!workspacePath) throw new Error("Final verification cannot observe a managed process it did not start.");
      return await invoke({ toolName: "process.poll", workspacePath, access: "read" }, context =>
        options.service.poll(processId, context));
    },
    async stop(processId: string): Promise<ManagedProcessSnapshot> {
      const workspacePath = workspaces.get(processId);
      if (!workspacePath) throw new Error("Final verification cannot stop a managed process it did not start.");
      const snapshot = await invoke({ toolName: "process.signal", workspacePath, access: "write" }, context =>
        options.service.signal(processId, "SIGTERM", context));
      if (snapshot.status === "stopped") workspaces.delete(processId);
      return snapshot;
    },
  });
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

function categoryActivityName(category: FinalVerificationCategory): string {
  return category === "runtime_smoke" ? "runtime smoke" : category;
}
