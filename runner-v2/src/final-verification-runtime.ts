import { spawn, type ChildProcess } from "node:child_process";

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
import { runGit } from "./git-command.js";
import type {
  VerificationWorkspace,
  VerificationWorkspaceManager,
} from "./verification-workspace.js";

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

export type FinalVerificationBrowserFailurePolicy = "fail" | "allow";

export interface FinalVerificationBrowserPolicy {
  consoleErrors?: FinalVerificationBrowserFailurePolicy;
  pageErrors?: FinalVerificationBrowserFailurePolicy;
  failedNetworkEvents?: FinalVerificationBrowserFailurePolicy;
  allowedConsoleErrorPatterns?: readonly string[];
  allowedPageErrorPatterns?: readonly string[];
  allowedNetworkFailurePatterns?: readonly string[];
}

export interface FinalVerificationBrowserInput {
  label: string;
  url: string;
  width?: number;
  height?: number;
  timeoutMs?: number;
  policy: FinalVerificationBrowserPolicy;
}

export interface FinalVerificationBrowserBackend {
  open(sessionId: string, input: { url: string; width: number; height: number }): Promise<{ url: string; title: string }>;
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
  workspaceManager: VerificationWorkspaceManager;
  artifacts: ArtifactStore;
  evidenceStore?: EvidenceStore;
  runId: string;
  taskId?: string;
  actor?: AgentActor;
  attempt?: number;
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
}

export interface FinalVerificationRunInput {
  plan: unknown;
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
}

export interface FinalVerificationBrowserSnapshotFact extends BrowserSnapshotEvidenceFact {
  category: "browser";
  sessionId: string;
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
  targetRevision: string;
  workspacePath: string;
  startedAt: string;
  finishedAt: string;
  checks: readonly FinalVerificationCheckResult[];
  green: boolean;
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
  private readonly clock: () => string;
  private readonly integrationRevision?: FinalVerificationRevisionSource;
  private readonly managedProcess?: FinalVerificationManagedProcess;
  private readonly browserSession?: FinalVerificationBrowserSession;
  private readonly maxOutputBytes: number;
  private readonly defaultTimeoutMs: number;
  private readonly maximumTimeoutMs: number;
  private readonly maximumDomBytes: number;
  private runOrdinal = 0;

  constructor(options: FinalVerificationRuntimeOptions) {
    if (!options.runId.trim()) throw new Error("Final verification runId is required.");
    if (options.taskId !== undefined && !options.taskId.trim()) {
      throw new Error("Final verification taskId is required.");
    }
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
      ? new BrowserBackendSessionAdapter(options.browserBackend, `${this.runId}:${this.taskId}`)
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
    if (this.defaultTimeoutMs > this.maximumTimeoutMs) {
      throw new Error("defaultTimeoutMs cannot exceed maximumTimeoutMs.");
    }
    if (this.attempt !== undefined && (!Number.isSafeInteger(this.attempt) || this.attempt < 1)) {
      throw new Error("attempt must be a positive integer.");
    }
  }

  async run(input: FinalVerificationRunInput): Promise<FinalVerificationRun> {
    const plan = planFinalVerification(input.plan);
    validateCommandMap(input.commands);
    const workspace = await this.workspaceManager.create();
    await this.assertCurrentRevision(workspace);

    const runOrdinal = ++this.runOrdinal;
    const generationId = generationFor(this.runId, workspace.targetRevision);
    const startedAt = this.clock();
    const checks: FinalVerificationCheckResult[] = [];
    for (const check of plan.checks) {
      checks.push(
        await this.runCheck({
          check,
          commands: input.commands?.[check.category],
          runtimeSmoke: input.runtimeSmoke,
          browser: input.browser,
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

  private async runCheck(input: {
    check: FinalVerificationCheck;
    commands: readonly FinalVerificationCommand[] | undefined;
    runtimeSmoke: FinalVerificationRuntimeSmokeInput | undefined;
    browser: FinalVerificationBrowserInput | undefined;
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
      const startState = await repositoryState(input.workspace.path);
      const startedAt = this.clock();
      const execution = await executeCommand(
        command,
        input.workspace.path,
        input.signal,
        this.maxOutputBytes,
        this.defaultTimeoutMs,
        this.maximumTimeoutMs,
      );
      const finishedAt = this.clock();
      const endState = await repositoryState(input.workspace.path);
      const stdoutArtifact = await this.artifacts.put(
        execution.stdout,
        "text/plain",
        `${check.category} ${command.label} stdout`,
      );
      const stderrArtifact = await this.artifacts.put(
        execution.stderr,
        "text/plain",
        `${check.category} ${command.label} stderr`,
      );
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
          `${check.category} command ${command.label} could not start: ${execution.startError.message}.`,
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
      if (execution.outputTruncated) {
        base.issues.push(`${check.category} command ${command.label} exceeded the output limit.`);
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
    const startState = await repositoryState(input.workspace.path);
    let observation: FinalVerificationManagedProcessObservation | undefined;
    let readinessSatisfied = false;
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
        } catch (error) {
          input.base.issues.push(`runtime_smoke process cleanup failed: ${asError(error).message}.`);
        }
      }
      if (smoke.releasePort) {
        try {
          await smoke.releasePort(smoke.endpoint);
        } catch (error) {
          input.base.issues.push(`runtime_smoke port cleanup failed: ${asError(error).message}.`);
        }
      }
    }

    const finishedAt = this.clock();
    const endState = await repositoryState(input.workspace.path);
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
    const startState = await repositoryState(input.workspace.path);
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
          policyViolations = browserPolicyViolations(events, browserInput.policy);
          for (const violation of policyViolations) {
            input.base.issues.push(`browser ${browserInput.label} policy violation: ${violation}`);
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
    }

    const finishedAt = this.clock();
    const endState = await repositoryState(input.workspace.path);
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
        startedAt,
        finishedAt,
        targetRevision: input.workspace.targetRevision,
        startState,
        endState,
      });
    }
    if (events && eventsArtifact) {
      const consoleErrors = events.console.filter(isConsoleError);
      const pageErrors = events.console.filter(isPageError);
      const failedNetworkEvents = events.network.filter(isFailedNetworkEvent);
      facts.push({
        kind: "browser_events",
        category: "browser",
        label: browserInput.label,
        capturedAt: finishedAt,
        eventsArtifactHash: eventsArtifact.hash,
        consoleEventCount: events.console.length,
        consoleErrorCount: consoleErrors.length,
        networkEventCount: events.network.length,
        networkFailureCount: failedNetworkEvents.length,
        sessionId,
        url: observedUrl,
        startedAt,
        finishedAt,
        targetRevision: input.workspace.targetRevision,
        startState,
        endState,
        consoleErrors,
        pageErrors,
        failedNetworkEvents,
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

async function repositoryState(cwd: string): Promise<RepositoryStateResult> {
  const [head, status] = await Promise.all([
    runGit({ cwd, args: ["rev-parse", "--verify", "HEAD^{commit}"] }),
    runGit({ cwd, args: ["status", "--porcelain=v1", "-z", "--untracked-files=all"] }),
  ]);
  const revision = head.stdout.trim();
  if (!isRevision(revision)) throw new Error(`Unable to determine verification revision in ${cwd}.`);
  return { revision, status: status.stdout };
}

async function executeCommand(
  command: FinalVerificationCommand,
  cwd: string,
  signal: AbortSignal | undefined,
  maxOutputBytes: number,
  defaultTimeoutMs: number,
  maximumTimeoutMs: number,
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
  const timeoutMs = Math.min(command.timeoutMs ?? defaultTimeoutMs, maximumTimeoutMs);
  return await new Promise<ProcessResult>((resolve) => {
    const child = spawn(command.executable, [...command.args], {
      cwd,
      env: { ...process.env },
      shell: false,
      windowsHide: true,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outputBytes = 0;
    let outputTruncated = false;
    let timedOut = false;
    let cancelled = false;
    let settled = false;
    let stopPromise: Promise<void> | undefined;

    const stop = (): Promise<void> => {
      if (!stopPromise) stopPromise = terminateProcessTree(child);
      return stopPromise;
    };
    const capture = (target: Buffer[], chunk: Buffer) => {
      if (outputTruncated) return;
      const remaining = maxOutputBytes - outputBytes;
      if (remaining <= 0) {
        outputTruncated = true;
        void stop();
        return;
      }
      if (chunk.byteLength > remaining) {
        target.push(chunk.subarray(0, remaining));
        outputBytes += remaining;
        outputTruncated = true;
        void stop();
        return;
      }
      target.push(chunk);
      outputBytes += chunk.byteLength;
    };
    child.stdout?.on("data", (chunk: Buffer) => capture(stdout, chunk));
    child.stderr?.on("data", (chunk: Buffer) => capture(stderr, chunk));

    const onAbort = () => {
      if (settled) return;
      cancelled = true;
      void stop();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    const timeout = setTimeout(() => {
      if (settled) return;
      timedOut = true;
      void stop();
    }, timeoutMs);
    timeout.unref();

    const finish = async (
      exitCode: number | null,
      exitedBy: NodeJS.Signals | null,
      startError?: Error,
    ) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
      if (stopPromise) await stopPromise;
      resolve({
        exitCode,
        signal: exitedBy,
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr),
        timedOut,
        cancelled,
        outputTruncated,
        ...(startError ? { startError } : {}),
      });
    };
    child.once("error", (error) => void finish(null, null, error));
    child.once("close", (exitCode, exitedBy) => void finish(exitCode, exitedBy));
  });
}

async function terminateProcessTree(child: ChildProcess): Promise<void> {
  if (!child.pid) return;
  if (process.platform === "win32") {
    await new Promise<void>((resolve) => {
      const killer = spawn(
        "taskkill.exe",
        ["/pid", String(child.pid), "/t", "/f"],
        { shell: false, windowsHide: true, stdio: "ignore" },
      );
      killer.once("error", () => resolve());
      killer.once("close", () => resolve());
    });
    return;
  }
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    // The process may already have exited before cancellation reached it.
  }
  try {
    child.kill("SIGTERM");
  } catch {
    // Preserve the original timeout/cancellation fact.
  }
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

function isConsoleError(event: BrowserConsoleEvent): boolean {
  const source = browserConsoleSource(event);
  return source !== "pageerror" && event.type === "error";
}

function isPageError(event: BrowserConsoleEvent): boolean {
  return browserConsoleSource(event) === "pageerror" || event.type === "pageerror";
}

function isFailedNetworkEvent(event: BrowserNetworkEvent): boolean {
  return Boolean(event.failure) || (event.status !== undefined && event.status >= 400);
}

function browserConsoleSource(event: BrowserConsoleEvent): "console" | "pageerror" | undefined {
  const source = (event as BrowserConsoleEvent & { source?: unknown }).source;
  return source === "console" || source === "pageerror" ? source : undefined;
}

function browserPolicyViolations(
  events: { console: BrowserConsoleEvent[]; network: BrowserNetworkEvent[] },
  policy: FinalVerificationBrowserPolicy,
): string[] {
  const violations: string[] = [];
  const consoleErrors = events.console.filter(isConsoleError);
  const pageErrors = events.console.filter(isPageError);
  const failedNetworkEvents = events.network.filter(isFailedNetworkEvent);
  if ((policy.consoleErrors ?? "fail") === "fail") {
    for (const event of consoleErrors) {
      if (!matchesBrowserPattern(event.text, policy.allowedConsoleErrorPatterns)) {
        violations.push(`unallowed console error: ${event.text}`);
      }
    }
  }
  if ((policy.pageErrors ?? "fail") === "fail") {
    for (const event of pageErrors) {
      if (!matchesBrowserPattern(event.text, policy.allowedPageErrorPatterns)) {
        violations.push(`unallowed page error: ${event.text}`);
      }
    }
  }
  if ((policy.failedNetworkEvents ?? "fail") === "fail") {
    for (const event of failedNetworkEvents) {
      const description = `${event.method} ${event.url} ${event.status ?? ""} ${event.failure ?? ""}`.trim();
      if (!matchesBrowserPattern(description, policy.allowedNetworkFailurePatterns)) {
        violations.push(`unallowed network failure: ${description}`);
      }
    }
  }
  return violations;
}

function matchesBrowserPattern(value: string, patterns: readonly string[] | undefined): boolean {
  return patterns?.some((pattern) => value.includes(pattern)) ?? false;
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
  ) {}

  async open(input: { url: string; width: number; height: number }): Promise<{ url: string; title: string }> {
    return await this.backend.open(this.sessionId, input);
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
