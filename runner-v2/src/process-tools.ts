import { spawn } from "node:child_process";
import { resolve } from "node:path";

import type {
  NativeTool,
  ToolExecutionContext,
  ToolExecutionOutput,
  ValidationResult,
} from "./agent-contracts.js";

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
  maxOutputBytes?: number;
  defaultTimeoutMs?: number;
  maximumTimeoutMs?: number;
}

export function createProcessTools(
  options: ProcessToolsOptions = {}
): NativeTool<unknown>[] {
  const maxOutputBytes = options.maxOutputBytes ?? 8 * 1024 * 1024;
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
        maxOutputBytes,
        defaultTimeoutMs,
        maximumTimeoutMs
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
  maxOutputBytes: number,
  defaultTimeoutMs: number,
  maximumTimeoutMs: number
): Promise<ToolExecutionOutput> {
  if (!context.workspacePath) {
    return processError("workspace_required", "Process tool requires a workspace.");
  }
  const invocation = commandInvocation(input);
  const cwd = resolve(context.workspacePath, input.cwd ?? ".");
  const timeoutMs = Math.min(input.timeoutMs ?? defaultTimeoutMs, maximumTimeoutMs);
  return await new Promise((resolveResult) => {
    const child = spawn(invocation.command, invocation.args, {
      cwd,
      env: { ...process.env, ...(input.env ?? {}) },
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outputBytes = 0;
    let outputExceeded = false;
    let timedOut = false;
    let cancelled = false;
    let settled = false;

    const capture = (target: Buffer[], chunk: Buffer) => {
      if (outputExceeded) return;
      outputBytes += chunk.byteLength;
      if (outputBytes > maxOutputBytes) {
        outputExceeded = true;
        child.kill("SIGTERM");
        return;
      }
      target.push(chunk);
    };
    child.stdout.on("data", (chunk: Buffer) => capture(stdout, chunk));
    child.stderr.on("data", (chunk: Buffer) => capture(stderr, chunk));

    const cancel = () => {
      cancelled = true;
      child.kill("SIGTERM");
    };
    context.signal?.addEventListener("abort", cancel, { once: true });
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, timeoutMs);
    timeout.unref();

    const finish = (
      exitCode: number | null,
      signal: NodeJS.Signals | null,
      startError?: Error
    ) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      context.signal?.removeEventListener("abort", cancel);
      const standardOutput = Buffer.concat(stdout).toString("utf8");
      const standardError = Buffer.concat(stderr).toString("utf8");
      const metadata = {
        exitCode,
        signal,
        timedOut,
        cancelled,
      };
      if (startError) {
        resolveResult(withEvidence(metadata, standardOutput, standardError, true, {
          code: "process_start_failed",
          message: startError.message,
        }));
      } else if (outputExceeded) {
        resolveResult(withEvidence(metadata, standardOutput, standardError, true, {
          code: "process_output_limit",
          message: `Process output exceeded ${maxOutputBytes} bytes.`,
        }));
      } else if (timedOut) {
        resolveResult(withEvidence(metadata, standardOutput, standardError, true, {
          code: "process_timeout",
          message: `Process exceeded ${timeoutMs} ms.`,
        }));
      } else if (cancelled) {
        resolveResult(withEvidence(metadata, standardOutput, standardError, true, {
          code: "process_cancelled",
          message: "Process was cancelled.",
        }));
      } else {
        resolveResult(withEvidence(metadata, standardOutput, standardError, false));
      }
    };
    child.once("error", (error) => finish(null, null, error));
    child.once("close", (exitCode, signal) => finish(exitCode, signal));
  });
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
