import { spawn } from "node:child_process";
import { realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

import type {
  NativeTool,
  ToolExecutionOutput,
  ValidationResult,
} from "./agent-contracts.js";
import type { ArtifactStore } from "./artifact-store.js";
import type { CommandEvidenceFact, EvidenceStore } from "./evidence-store.js";
import { runGit } from "./git-command.js";

interface RunEvidenceInput {
  label: string;
  command: string;
  args: string[];
  cwd: string;
  timeoutMs: number;
}

export interface EvidenceToolsOptions {
  store: EvidenceStore;
  artifacts: ArtifactStore;
  taskId: string;
  maxOutputBytes?: number;
  defaultTimeoutMs?: number;
  maximumTimeoutMs?: number;
  clock?: () => string;
}

export function createEvidenceTools(options: EvidenceToolsOptions): NativeTool<unknown>[] {
  return [runEvidenceTool(options), inspectEvidenceTool(options)];
}

function runEvidenceTool(options: EvidenceToolsOptions): NativeTool<RunEvidenceInput> {
  const maxOutputBytes = options.maxOutputBytes ?? 16 * 1024 * 1024;
  const defaultTimeoutMs = options.defaultTimeoutMs ?? 120_000;
  const maximumTimeoutMs = options.maximumTimeoutMs ?? 30 * 60_000;
  const clock = options.clock ?? (() => new Date().toISOString());
  return {
    definition: {
      name: "run_evidence_command",
      description: "Run an argument-array command and record exit/output/revision facts without a verdict",
      inputSchema: {
        type: "object",
        properties: {
          label: { type: "string", minLength: 1 },
          command: { type: "string", minLength: 1 },
          args: { type: "array", items: { type: "string" } },
          cwd: { type: "string" },
          timeoutMs: { type: "integer", minimum: 1, maximum: maximumTimeoutMs },
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
      try {
        const cwd = await containedDirectory(context.workspacePath, input.cwd);
        const startedAt = clock();
        const revision = await gitRevision(cwd);
        const execution = await execute(input, cwd, maxOutputBytes, context.signal);
        const finishedAt = clock();
        const [stdout, stderr] = await Promise.all([
          options.artifacts.put(execution.stdout, "text/plain", `${input.label} stdout`),
          options.artifacts.put(execution.stderr, "text/plain", `${input.label} stderr`),
        ]);
        const fact: CommandEvidenceFact = {
          kind: "command",
          label: input.label,
          command: input.command,
          args: [...input.args],
          cwd,
          startedAt,
          finishedAt,
          exitCode: execution.exitCode,
          signal: execution.signal,
          timedOut: execution.timedOut,
          cancelled: execution.cancelled,
          outputTruncated: execution.outputTruncated,
          stdoutArtifactHash: stdout.hash,
          stderrArtifactHash: stderr.hash,
          ...(revision ? { repositoryRevision: revision } : {}),
        };
        const record = options.store.record({
          runId: context.runId,
          taskId: options.taskId,
          actor: context.actor,
          fact,
          createdAt: finishedAt,
          idempotencyKey: `evidence:${context.sessionId}:${context.callId}`,
        });
        return { content: [{ type: "json", value: record }], isError: false };
      } catch (error) {
        return failure(
          "evidence_command_failed",
          error instanceof Error ? error.message : String(error)
        );
      }
    },
  };
}

function inspectEvidenceTool(options: EvidenceToolsOptions): NativeTool<{ taskId?: string }> {
  return {
    definition: {
      name: "inspect_evidence",
      description: "Inspect immutable command evidence facts; no semantic verdict is provided",
      inputSchema: {
        type: "object",
        properties: { taskId: { type: "string", minLength: 1 } },
        additionalProperties: false,
      },
      readOnly: true,
      effect: "none",
    },
    validate: (input) => {
      if (typeof input !== "object" || input === null || Array.isArray(input)) {
        return { ok: false, issues: ["arguments must be an object"] };
      }
      const taskId = (input as { taskId?: unknown }).taskId;
      return taskId === undefined || (typeof taskId === "string" && taskId.trim())
        ? { ok: true, value: taskId ? { taskId } as { taskId: string } : {} }
        : { ok: false, issues: ["taskId must be a non-empty string"] };
    },
    execute: async (input, context) => ({
      content: [
        {
          type: "json",
          value: options.store.list({
            runId: context.runId,
            taskId: input.taskId ?? options.taskId,
          }),
        },
      ],
      isError: false,
    }),
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

async function gitRevision(cwd: string): Promise<string | undefined> {
  try {
    const result = await runGit({ cwd, args: ["rev-parse", "--verify", "HEAD"] });
    return result.exitCode === 0 ? result.stdout.trim() || undefined : undefined;
  } catch {
    return undefined;
  }
}

async function execute(
  input: RunEvidenceInput,
  cwd: string,
  maxOutputBytes: number,
  parentSignal?: AbortSignal
): Promise<{
  stdout: Buffer;
  stderr: Buffer;
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  cancelled: boolean;
  outputTruncated: boolean;
}> {
  return await new Promise((resolveResult, reject) => {
    const child = spawn(input.command, input.args, {
      cwd,
      env: process.env,
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let total = 0;
    let outputTruncated = false;
    let timedOut = false;
    let cancelled = false;
    const capture = (target: Buffer[], chunk: Buffer) => {
      if (outputTruncated) return;
      const remaining = maxOutputBytes - total;
      if (chunk.byteLength > remaining) {
        if (remaining > 0) target.push(chunk.subarray(0, remaining));
        total = maxOutputBytes;
        outputTruncated = true;
        child.kill("SIGTERM");
        return;
      }
      target.push(chunk);
      total += chunk.byteLength;
    };
    child.stdout.on("data", (chunk: Buffer) => capture(stdout, chunk));
    child.stderr.on("data", (chunk: Buffer) => capture(stderr, chunk));
    const cancel = () => {
      cancelled = true;
      child.kill("SIGTERM");
    };
    parentSignal?.addEventListener("abort", cancel, { once: true });
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, input.timeoutMs);
    timeout.unref();
    child.once("error", reject);
    child.once("close", (exitCode, signal) => {
      clearTimeout(timeout);
      parentSignal?.removeEventListener("abort", cancel);
      resolveResult({
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr),
        exitCode,
        signal,
        timedOut,
        cancelled,
        outputTruncated,
      });
    });
  });
}

function failure(code: string, message: string): ToolExecutionOutput {
  return {
    content: [{ type: "text", text: message }],
    isError: true,
    error: { code, message },
  };
}
