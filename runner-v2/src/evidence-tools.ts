import { commandReuseMetadata } from "./command-evidence-reuse.js";
import { unknownWorkingTree, unknownChildEnvironment, settleWorkingTreeIdentity } from "./command-evidence-identity.js";
import { realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

import type {
  NativeTool,
  ToolExecutionOutput,
  ValidationResult,
} from "./agent-contracts.js";
import type { ArtifactStore } from "./artifact-store.js";
import type { CommandEvidenceFact, EvidenceStore, ExtendedEvidenceStore } from "./evidence-store.js";
import type { RunGitExecutionContext } from "./git-run-context.js";
import type { GitRunner } from "./git-repository.js";
import { isBenchmarkCommandAllowed } from "./benchmark-command-policy.js";
import {
  outputFor,
  type OneShotCommandExecutor,
} from "./one-shot-command-executor.js";
import type { BudgetLedger } from "./budget-ledger.js";
import { recordValidationEvidenceSegment } from "./validation-budget.js";

interface RunEvidenceInput {
  label: string;
  command: string;
  args: string[];
  cwd: string;
  timeoutMs: number;
}

export interface EvidenceValidationAccounting {
  ledger: BudgetLedger;
  runId: string;
}
export interface EvidenceToolsOptions {
  git?: RunGitExecutionContext;
  store: EvidenceStore;
  artifacts: ArtifactStore;
  taskId: string;
  maxOutputBytes?: number;
  defaultTimeoutMs?: number;
  maximumTimeoutMs?: number;
  clock?: () => string;
  allowedCommands?: readonly string[];
  attempt?: number;
  execution?: OneShotCommandExecutor;
  validationAccounting?: EvidenceValidationAccounting;
}

export function createEvidenceTools(options: EvidenceToolsOptions): NativeTool<unknown>[] {
  return [runEvidenceTool(options), inspectEvidenceTool(options)];
}

/**
 * T5 (P6.6): inspect tools for durable validation observations and
 * applicability decisions. Separate from createEvidenceTools so the existing
 * two-tool surface (and its tests) stays byte-identical; later tasks wire
 * these into role surfaces. Both tools are read-only with no verdict.
 */
export function createValidationEvidenceTools(options: EvidenceToolsOptions): NativeTool<unknown>[] {
  return [inspectObservationsTool(options), inspectApplicabilityTool(options)];
}

function extendedStore(store: EvidenceStore): ExtendedEvidenceStore | undefined {
  const candidate = store as Partial<ExtendedEvidenceStore>;
  return typeof candidate.recordObservation === "function" &&
    typeof candidate.listObservations === "function" &&
    typeof candidate.recordApplicability === "function" &&
    typeof candidate.listApplicability === "function"
    ? (candidate as ExtendedEvidenceStore)
    : undefined;
}

function inspectObservationsTool(options: EvidenceToolsOptions): NativeTool<Record<string, never>> {
  return {
    definition: {
      name: "inspect_validation_observations",
      description: "Inspect durable validation observations (outcomes/counts/snapshots); no semantic verdict is provided",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      readOnly: true,
      effect: "none",
    },
    validate: (input) => {
      if (typeof input !== "object" || input === null || Array.isArray(input)) {
        return { ok: false, issues: ["arguments must be an object"] };
      }
      return { ok: true, value: {} };
    },
    execute: async (_input, context) => {
      const store = extendedStore(options.store);
      if (!store) return failure("validation_store_unavailable", "This evidence store does not support validation observations.");
      return {
        content: [{ type: "json", value: store.listObservations({ runId: context.runId }) }],
        isError: false,
      };
    },
  };
}

function inspectApplicabilityTool(options: EvidenceToolsOptions): NativeTool<Record<string, never>> {
  return {
    definition: {
      name: "inspect_applicability_decisions",
      description: "Inspect durable evidence applicability decisions (reusable/invalidated); no semantic verdict is provided",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      readOnly: true,
      effect: "none",
    },
    validate: (input) => {
      if (typeof input !== "object" || input === null || Array.isArray(input)) {
        return { ok: false, issues: ["arguments must be an object"] };
      }
      return { ok: true, value: {} };
    },
    execute: async (_input, context) => {
      const store = extendedStore(options.store);
      if (!store) return failure("validation_store_unavailable", "This evidence store does not support applicability decisions.");
      return {
        content: [{ type: "json", value: store.listApplicability({ runId: context.runId }) }],
        isError: false,
      };
    },
  };
}

function runEvidenceTool(options: EvidenceToolsOptions): NativeTool<RunEvidenceInput> {
  const defaultTimeoutMs = options.defaultTimeoutMs ?? 120_000;
  const maximumTimeoutMs = options.maximumTimeoutMs ?? 30 * 60_000;
  const clock = options.clock ?? (() => new Date().toISOString());
  return {
    definition: {
      name: "run_evidence_command",
      description: "Run one executable without a shell and record its exit code and output as durable evidence (no verdict). `command` is the executable (e.g. `dotnet`, `python`, `cmake`, `cargo`, `npm`); `args` is the argument list; pipes, `&&` and redirection are not interpreted. `cwd` is relative to the workspace. Output is stored as artifacts: read them with artifact.read. Cite the returned evidence ID.",
      inputSchema: {
        type: "object",
        properties: {
          label: { type: "string", minLength: 1, description: "Short human label for this check, shown in evidence summaries." },
          command: { type: "string", minLength: 1, description: "One executable name or path; no shell, no argument string." },
          args: { type: "array", items: { type: "string" }, description: "Argument list passed verbatim; pipes and redirection are not interpreted." },
          cwd: { type: "string", description: "Working directory relative to the workspace." },
          timeoutMs: { type: "integer", minimum: 1, maximum: maximumTimeoutMs, description: "Timeout in milliseconds." },
        },
        required: ["label", "command", "args"],
        additionalProperties: false,
      },
      readOnly: false,
      effect: "external",
    },
    validate: (input) => validateRun(input, defaultTimeoutMs, maximumTimeoutMs),
    assessAccess: (input) => ({
      capability: "evidence.command",
      paths: [{ path: input.cwd, access: "write" }],
      external: true,
    }),
    execute: async (input, context) => {
      if (!context.workspacePath) return failure("workspace_required", "Evidence command requires a workspace.");
      if (!isBenchmarkCommandAllowed(input, options.allowedCommands)) {
        return failure(
          "benchmark_command_denied",
          "Command is not allowlisted for this WorkBench attempt."
        );
      }
      try {
        const cwd = await containedDirectory(context.workspacePath, input.cwd);
        const startedAt = clock();
        const commandTree = await options.git?.workingTreeForCall?.(context, cwd) ?? unknownWorkingTree();
        const revision = options.git ? await gitRevision(cwd, options.git.forCall(context).run) : undefined;
        if (!options.execution || !context.callId) {
          return failure(
            "process_runtime_unavailable",
            "The shared subprocess runtime is unavailable for this evidence command.",
          );
        }
        const commandRequest: Parameters<OneShotCommandExecutor["execute"]>[0] = {
          executable: input.command,
          arguments: input.args,
          workingDirectory: cwd,
          timeoutMs: input.timeoutMs,
          context: {
            runId: context.runId,
            sessionId: context.sessionId,
            actor: context.actor,
            taskId: options.taskId,
            callId: context.callId,
            toolName: "run_evidence_command",
            ...(context.executionGrant ? { executionGrant: context.executionGrant } : {}),
            ...(context.signal ? { signal: context.signal } : {}),
          },
        };
        const validationStart = clock();
        const execution = options.git
          ? await options.git.executeForCall(context, commandRequest)
          : await options.execution.execute(commandRequest);
        const validationFinish = clock();
        if (options.validationAccounting && !execution.reuseSource && context.callId) {
          recordValidationEvidenceSegment(options.validationAccounting.ledger, {
            runId: options.validationAccounting.runId,
            taskId: options.taskId,
            sessionId: context.sessionId,
            callId: context.callId,
            startedAt: validationStart,
            finishedAt: validationFinish,
          });
        }
        const postTree = await options.git?.workingTreeForCall?.(context, cwd) ?? unknownWorkingTree();
        const workingTreeIdentity = settleWorkingTreeIdentity(commandTree, postTree);
        const finishedAt = clock();
        const stdoutOutput = outputFor(execution.process, "stdout");
        const stderrOutput = outputFor(execution.process, "stderr");
        const [stdout, stderr] = await Promise.all([
          artifactForOutput(options.artifacts, stdoutOutput, `${input.label} stdout`),
          artifactForOutput(options.artifacts, stderrOutput, `${input.label} stderr`),
        ]);
        const fact: CommandEvidenceFact = {
          kind: "command",
          workingTreeIdentity,
          childEnvironmentIdentity: execution.childEnvironmentIdentity ?? unknownChildEnvironment(),
          ...(execution.childEnvironmentAudit ? {childEnvironmentAudit: execution.childEnvironmentAudit} : {}),
          label: input.label,
          command: input.command,
          args: [...input.args],
          cwd,
          startedAt,
          finishedAt,
          exitCode: execution.process.exitCode ?? null,
          signal: execution.process.signal ?? null,
          timedOut: execution.process.outcome === "timed_out",
          cancelled: execution.process.outcome === "cancelled",
          outputTruncated: execution.process.output.some((entry) => entry.truncated),
          outputLossy: execution.process.output.some((entry) => entry.lossyBytes > 0) ||
            stdout.fallbackLossy || stderr.fallbackLossy,
          cleanup: execution.process.cleanup,
          enforcement: execution.enforcement,
          disclosure: execution.disclosure,
          ...(execution.providerId ? { providerId: execution.providerId } : {}),
          stdoutArtifactHash: stdout.hash,
          stderrArtifactHash: stderr.hash,
          ...(revision ? { repositoryRevision: revision } : {}),
          ...commandReuseMetadata(execution),
        };
        const record = options.store.record({
          runId: context.runId,
          taskId: options.taskId,
          actor: context.actor,
          fact,
        createdAt: finishedAt,
        idempotencyKey: `evidence:${context.sessionId}:${context.callId}`,
        ...(options.attempt !== undefined ? { attempt: options.attempt } : {}),
      });
        return { content: [{ type: "json", value: record }], isError: false };
      } catch (error) {
        return failure(
          stableExecutionErrorCode(error) ?? "evidence_command_failed",
          error instanceof Error ? error.message : String(error)
        );
      }
    },
  };
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
  ]).has(code) ? code : undefined;
}

function inspectEvidenceTool(options: EvidenceToolsOptions): NativeTool<{ taskId?: string; evidenceId?: string }> {
  return {
    definition: {
      name: "inspect_evidence",
      description: "Inspect immutable command and browser evidence facts; no semantic verdict is provided. Without evidenceId, returns the task list; with evidenceId, returns only that exact record in the same JSON array shape. Prefer evidenceId when the full list would exceed the inline output bound.",
      inputSchema: {
        type: "object",
        properties: {
          taskId: { type: "string", minLength: 1 },
          evidenceId: { type: "string", minLength: 1, description: "Optional singular evidence ID to read exactly; scoped to this run and the requested task." },
        },
        additionalProperties: false,
      },
      readOnly: true,
      effect: "none",
    },
    validate: (input) => {
      if (typeof input !== "object" || input === null || Array.isArray(input)) {
        return { ok: false, issues: ["arguments must be an object"] };
      }
      const record = input as Record<string, unknown>;
      for (const key of Object.keys(record)) {
        if (key !== "taskId" && key !== "evidenceId") {
          return { ok: false, issues: [`unknown argument: ${key}`] };
        }
      }
      const taskId = record.taskId;
      const evidenceId = record.evidenceId;
      if (taskId !== undefined && (typeof taskId !== "string" || !taskId.trim())) {
        return { ok: false, issues: ["taskId must be a non-empty string"] };
      }
      if (evidenceId !== undefined && (typeof evidenceId !== "string" || !evidenceId.trim())) {
        return { ok: false, issues: ["evidenceId must be a non-empty string"] };
      }
      return {
        ok: true,
        value: {
          ...(taskId !== undefined ? { taskId: taskId as string } : {}),
          ...(evidenceId !== undefined ? { evidenceId: evidenceId as string } : {}),
        },
      };
    },
    execute: async (input, context) => {
      const taskId = input.taskId ?? options.taskId;
      if (input.evidenceId === undefined) {
        return {
          content: [
            {
              type: "json",
              value: options.store.list({ runId: context.runId, taskId }),
            },
          ],
          isError: false,
        };
      }
      const found = options.store.getByIds({ runId: context.runId, taskId, ids: [input.evidenceId] });
      const record = found.find((candidate) => candidate.id === input.evidenceId && candidate.runId === context.runId && candidate.taskId === taskId);
      if (!record) {
        return failure("evidence_not_found", "No evidence with that ID exists for this run and task.");
      }
      return {
        content: [{ type: "json", value: [record] }],
        isError: false,
      };
    },
  };
}

function validateRun(
  input: unknown,
  defaultTimeoutMs: number,
  maximumTimeoutMs: number
): ValidationResult<RunEvidenceInput> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return { ok: false, issues: ["arguments must be an object"] };
  }
  const value = input as Record<string, unknown>;
  if (
    typeof value.label !== "string" ||
    !value.label.trim() ||
    typeof value.command !== "string" ||
    !value.command.trim() ||
    !Array.isArray(value.args) ||
    !value.args.every((item) => typeof item === "string") ||
    (value.cwd !== undefined && typeof value.cwd !== "string") ||
    (value.timeoutMs !== undefined &&
      (!Number.isSafeInteger(value.timeoutMs) || (value.timeoutMs as number) < 1))
  ) return { ok: false, issues: ["label, command, string args, cwd, and timeoutMs are invalid"] };
  return {
    ok: true,
    value: {
      label: value.label,
      command: value.command,
      args: value.args as string[],
      cwd: (value.cwd as string | undefined) ?? ".",
      timeoutMs: Math.min((value.timeoutMs as number | undefined) ?? defaultTimeoutMs, maximumTimeoutMs),
    },
  };
}

async function containedDirectory(workspace: string, cwdInput: string): Promise<string> {
  const root = await realpath(resolve(workspace));
  const candidate = resolve(root, cwdInput);
  const traversal = relative(root, candidate);
  if (traversal.startsWith("..") || isAbsolute(traversal)) {
    throw new Error("Evidence cwd is outside workspace.");
  }
  const canonical = await realpath(candidate);
  const canonicalTraversal = relative(root, canonical);
  if (canonicalTraversal.startsWith("..") || isAbsolute(canonicalTraversal)) {
    throw new Error("Evidence cwd resolves outside workspace.");
  }
  return canonical;
}

async function gitRevision(cwd: string, execute: GitRunner): Promise<string | undefined> {
  try {
    const result = await execute({ cwd, args: ["rev-parse", "--verify", "HEAD"], allowFailure: true });
    return result.exitCode === 0 ? result.stdout.trim() || undefined : undefined;
  } catch (error) {
    throw error;
  }
}

async function artifactForOutput(
  artifacts: ArtifactStore,
  output: ReturnType<typeof outputFor>,
  label: string,
): Promise<{ hash: string; fallbackLossy: boolean }> {
  if (output.spillArtifactId) {
    try {
      await artifacts.verify(output.spillArtifactId);
      return { hash: output.spillArtifactId, fallbackLossy: false };
    } catch {
      // Runtime cleanup remains authoritative; artifact framing degrades to its bounded tail.
    }
  }
  const artifact = await artifacts.put(Buffer.from(output.tail), "text/plain", label);
  return { hash: artifact.hash, fallbackLossy: output.spillArtifactId !== undefined };
}

function failure(code: string, message: string): ToolExecutionOutput {
  return {
    content: [{ type: "text", text: message }],
    isError: true,
    error: { code, message },
  };
}
