import { spawn, type ChildProcess } from "node:child_process";

import type { AgentActor } from "./agent-contracts.js";
import type { ArtifactStore } from "./artifact-store.js";
import {
  planFinalVerification,
  type FinalVerificationCategory,
  type FinalVerificationCheck,
  type FinalVerificationRepositoryInspection,
  type FinalVerificationStatus,
} from "./final-verification-contracts.js";
import type { CommandEvidenceFact, EvidenceStore } from "./evidence-store.js";
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
  maxOutputBytes?: number;
  defaultTimeoutMs?: number;
  maximumTimeoutMs?: number;
}

export interface FinalVerificationRunInput {
  plan: unknown;
  commands?: Partial<Record<FinalVerificationCategory, readonly FinalVerificationCommand[]>>;
  signal?: AbortSignal;
}

export interface FinalVerificationRepositoryState {
  revision: string;
  status: string;
}

export interface FinalVerificationCommandFact extends CommandEvidenceFact {
  category: "build" | "tests";
  executable: string;
  targetRevision: string;
  startState: FinalVerificationRepositoryState;
  endState: FinalVerificationRepositoryState;
}

export interface FinalVerificationEvidence {
  id: string;
  category: "build" | "tests";
  fact: FinalVerificationCommandFact;
}

export interface FinalVerificationCheckResult {
  category: FinalVerificationCategory;
  status: FinalVerificationStatus;
  green: boolean;
  rationale?: string;
  repositoryInspection?: FinalVerificationRepositoryInspection;
  evidenceIds: string[];
  facts: readonly FinalVerificationCommandFact[];
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
  private readonly maxOutputBytes: number;
  private readonly defaultTimeoutMs: number;
  private readonly maximumTimeoutMs: number;
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
    workspace: VerificationWorkspace;
    generationId: string;
    runOrdinal: number;
    signal?: AbortSignal;
  }): Promise<FinalVerificationCheckResult> {
    const { check } = input;
    const base = {
      category: check.category,
      status: check.status,
      ...(check.rationale !== undefined ? { rationale: check.rationale } : {}),
      ...(check.repositoryInspection
        ? { repositoryInspection: cloneInspection(check.repositoryInspection) }
        : {}),
      evidenceIds: [] as string[],
      facts: [] as FinalVerificationCommandFact[],
      issues: [] as string[],
    };
    if (check.status === "not_applicable") {
      if (input.commands !== undefined && input.commands.length > 0) {
        base.issues.push(`Not-applicable category ${check.category} supplied executable commands.`);
        return { ...base, green: false };
      }
      return { ...base, green: true };
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

  private recordEvidence(
    fact: FinalVerificationCommandFact,
    generationId: string,
    category: "build" | "tests",
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
    facts: Object.freeze(check.facts.map((fact) => Object.freeze({ ...fact, args: Object.freeze([...fact.args]) }))),
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
