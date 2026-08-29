import { resolve } from "node:path";

import type {
  NativeTool,
  ToolExecutionContext,
  ToolExecutionOutput,
  ValidationResult,
} from "./agent-contracts.js";
import { isBenchmarkCommandAllowed } from "./benchmark-command-policy.js";
import {
  outputFor,
  type OneShotCommandExecutor,
} from "./one-shot-command-executor.js";

interface ProcessInput {
  command?: string;
  args?: string[];
  shell?: "powershell" | "cmd" | "bash";
  script?: string;
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
}

export interface ProcessToolsOptions {
  execution?: OneShotCommandExecutor;
  /** Retained for API compatibility; shared runtime output policy owns the effective bound. */
  maxOutputBytes?: number;
  defaultTimeoutMs?: number;
  maximumTimeoutMs?: number;
  allowedCommands?: readonly string[];
}

export function createProcessTools(
  options: ProcessToolsOptions = {}
): NativeTool<unknown>[] {
  const defaultTimeoutMs = options.defaultTimeoutMs ?? 120_000;
  const maximumTimeoutMs = options.maximumTimeoutMs ?? 30 * 60_000;
  const tool: NativeTool<ProcessInput> = {
    definition: {
      name: "process.run",
      description:
        "Run an argument-array command or an explicitly selected shell script and record its mechanical result",
      inputSchema: {
        type: "object",
        properties: {
          command: { type: "string" },
          args: { type: "array", items: { type: "string" } },
          shell: { enum: ["powershell", "cmd", "bash"] },
          script: { type: "string" },
          cwd: { type: "string" },
          env: { type: "object", additionalProperties: { type: "string" } },
          timeoutMs: { type: "integer", minimum: 1 },
        },
        additionalProperties: false,
      },
      readOnly: false,
      effect: "external",
    },
    validate: validateInput,
    assessAccess: (input) => ({
      capability: input.shell ? "process.shell" : "process.execute",
      paths: [{ path: input.cwd ?? ".", access: "write" }],
      external: true,
    }),
    execute: async (input, context) =>
      await executeProcess(
        input,
        context,
        options.execution,
        defaultTimeoutMs,
        maximumTimeoutMs,
        options.allowedCommands
      ),
  };
  return [tool as NativeTool<unknown>];
}

function validateInput(input: unknown): ValidationResult<ProcessInput> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, issues: ["input must be an object"] };
  }
  const value = input as Record<string, unknown>;
  const commandMode =
    typeof value.command === "string" &&
    (value.args === undefined ||
      (Array.isArray(value.args) && value.args.every((item) => typeof item === "string")));
  const shellMode =
    (value.shell === "powershell" || value.shell === "cmd" || value.shell === "bash") &&
    typeof value.script === "string";
  if (commandMode === shellMode) {
    return {
      ok: false,
      issues: ["provide either command/args or an explicit shell/script"],
    };
  }
  if (value.cwd !== undefined && typeof value.cwd !== "string") {
    return { ok: false, issues: ["cwd must be a string"] };
  }
  if (
    value.env !== undefined &&
    (!value.env ||
      typeof value.env !== "object" ||
      Array.isArray(value.env) ||
      !Object.values(value.env).every((item) => typeof item === "string"))
  ) {
    return { ok: false, issues: ["env values must be strings"] };
  }
  if (
    value.timeoutMs !== undefined &&
    (!Number.isSafeInteger(value.timeoutMs) || (value.timeoutMs as number) < 1)
  ) {
    return { ok: false, issues: ["timeoutMs must be a positive integer"] };
  }
  return { ok: true, value: value as ProcessInput };
}

async function executeProcess(
  input: ProcessInput,
  context: ToolExecutionContext,
  execution: OneShotCommandExecutor | undefined,
  defaultTimeoutMs: number,
  maximumTimeoutMs: number,
  allowedCommands: readonly string[] | undefined
): Promise<ToolExecutionOutput> {
  if (!context.workspacePath) {
    return processError("workspace_required", "Process tool requires a workspace.");
  }
  if (!execution || !context.executionGrant || !context.callId) {
    return processError(
      "process_runtime_unavailable",
      "The shared subprocess runtime is unavailable for this command.",
    );
  }
  if (!isBenchmarkCommandAllowed(input, allowedCommands)) {
    return processError(
      "benchmark_command_denied",
      "Command is not allowlisted for this WorkBench attempt."
    );
  }
  const invocation = commandInvocation(input);
  const cwd = resolve(context.workspacePath, input.cwd ?? ".");
  const timeoutMs = Math.min(input.timeoutMs ?? defaultTimeoutMs, maximumTimeoutMs);
  try {
    const result = await execution.execute({
      executable: invocation.command,
      arguments: invocation.args,
      workingDirectory: cwd,
      ...(input.env ? { explicitEnvironment: input.env } : {}),
      timeoutMs,
      context: {
        runId: context.runId,
        sessionId: context.sessionId,
        actor: context.actor,
        callId: context.callId,
        toolName: "process.run",
        executionGrant: context.executionGrant,
        ...(context.signal ? { signal: context.signal } : {}),
      },
    });
    const stdout = outputFor(result.process, "stdout");
    const stderr = outputFor(result.process, "stderr");
    const timedOut = result.process.outcome === "timed_out";
    const cancelled = result.process.outcome === "cancelled";
    const metadata = {
      exitCode: result.process.exitCode ?? null,
      signal: result.process.signal ?? null,
      timedOut,
      cancelled,
      cleanup: result.process.cleanup,
      outputLossy: result.process.output.some((entry) => entry.lossyBytes > 0),
      enforcement: result.enforcement,
      disclosure: result.disclosure,
      ...(result.providerId ? { providerId: result.providerId } : {}),
    };
    if (result.process.outcome === "launch_failed") {
      return withEvidence(metadata, stdout.tail, stderr.tail, true, {
        code: "process_start_failed",
        message: "Process launch was not proven.",
      });
    }
    if (timedOut) return withEvidence(metadata, stdout.tail, stderr.tail, true, {
      code: "process_timeout",
      message: `Process exceeded ${timeoutMs} ms.`,
    });
    if (cancelled) return withEvidence(metadata, stdout.tail, stderr.tail, true, {
      code: "process_cancelled",
      message: "Process was cancelled.",
    });
    if (result.process.outcome === "cleanup_failed") return withEvidence(
      metadata,
      stdout.tail,
      stderr.tail,
      true,
      { code: "process_cleanup_failed", message: "Process cleanup could not be verified." },
    );
    return withEvidence(metadata, stdout.tail, stderr.tail, false);
  } catch (error) {
    const value = error as { code?: unknown; message?: unknown };
    const code = typeof value.code === "string" ? value.code : "process_runtime_failed";
    const message = typeof value.message === "string" ? value.message : String(error);
    return processError(code, message);
  }
}

function commandInvocation(input: ProcessInput): {
  command: string;
  args: string[];
} {
  if (input.command) return { command: input.command, args: input.args ?? [] };
  switch (input.shell) {
    case "powershell":
      return {
        command: "powershell.exe",
        args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", input.script!],
      };
    case "cmd":
      return { command: "cmd.exe", args: ["/d", "/s", "/c", input.script!] };
    case "bash":
      return { command: "bash", args: ["-lc", input.script!] };
    default:
      throw new Error("Invalid process invocation.");
  }
}

function withEvidence(
  metadata: unknown,
  stdout: string,
  stderr: string,
  isError: boolean,
  errorValue?: { code: string; message: string }
): ToolExecutionOutput {
  const sections = [
    stdout ? `STDOUT\n${stdout}` : "",
    stderr ? `STDERR\n${stderr}` : "",
  ].filter(Boolean);
  return {
    content: [
      { type: "json", value: metadata },
      ...(sections.length > 0
        ? [{ type: "text" as const, text: sections.join("\n") }]
        : []),
    ],
    isError,
    ...(errorValue ? { error: errorValue } : {}),
  };
}

function processError(code: string, message: string): ToolExecutionOutput {
  return {
    content: [{ type: "text", text: message }],
    isError: true,
    error: { code, message },
  };
}
