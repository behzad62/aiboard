import type {
  NativeTool,
  ToolExecutionOutput,
  ValidationResult,
} from "./agent-contracts.js";
import {
  ManagedProcessError,
  type ManagedProcessSnapshot,
  type ManagedProcessService,
} from "./managed-process.js";

type Input = Record<string, unknown>;

export function createManagedProcessTools(
  service: ManagedProcessService
): NativeTool<unknown>[] {
  const tools: NativeTool<Input>[] = [
    {
      definition: definition("process.start", "Start a durable background process", false, "external"),
      validate: validateStart,
      assessAccess: (input) => ({
        capability: "process.start",
        paths: [{ path: (input.cwd as string | undefined) ?? ".", access: "write" }],
        external: true,
      }),
      execute: async (input, context) => {
        try {
          const snapshot = service.start(
            {
              command: input.command as string,
              args: (input.args as string[] | undefined) ?? [],
              cwd: input.cwd as string | undefined,
              env: input.env as Record<string, string> | undefined,
            },
            context,
            context.workspacePath!
          );
          return snapshotOutput(snapshot);
        } catch (error) {
          return managedError(error);
        }
      },
    },
    {
      definition: definition("process.poll", "Read background process state and output", true, "none"),
      validate: processIdInput,
      execute: async (input, context) => {
        try {
          return snapshotOutput(service.poll(input.processId as string, context));
        } catch (error) {
          return managedError(error);
        }
      },
    },
    {
      definition: definition("process.list", "List owned background processes", true, "none"),
      validate: objectInput,
      execute: async (_input, context) => ({
        content: [{ type: "json", value: { processes: service.list(context) } }],
        isError: false,
      }),
    },
    {
      definition: definition("process.signal", "Signal an owned background process", false, "workspace"),
      validate: validateSignal,
      assessAccess: () => ({ capability: "process.signal", destructive: true }),
      execute: async (input, context) => {
        try {
          return snapshotOutput(
            await service.signal(
              input.processId as string,
              input.signal as "SIGTERM" | "SIGINT" | "SIGKILL",
              context
            )
          );
        } catch (error) {
          return managedError(error);
        }
      },
    },
  ];
  return tools as NativeTool<unknown>[];
}

function definition(
  name: string,
  description: string,
  readOnly: boolean,
  effect: "none" | "workspace" | "external"
) {
  return { name, description, inputSchema: managedProcessSchema(name), readOnly, effect } as const;
}

function managedProcessSchema(name: string): Record<string, unknown> {
  switch (name) {
    case "process.start":
      return objectSchema({
        command: { type: "string", minLength: 1 },
        args: { type: "array", items: { type: "string" } },
        cwd: { type: "string" },
        env: {
          type: "object",
          additionalProperties: { type: "string" },
        },
      }, ["command"]);
    case "process.poll":
      return objectSchema(
        { processId: { type: "string", minLength: 1 } },
        ["processId"]
      );
    case "process.list":
      return objectSchema({}, []);
    case "process.signal":
      return objectSchema(
        {
          processId: { type: "string", minLength: 1 },
          signal: { type: "string", enum: ["SIGTERM", "SIGINT", "SIGKILL"] },
        },
        ["processId", "signal"]
      );
    default:
      throw new Error(`Unknown managed process tool ${name}.`);
  }
}

function objectSchema(
  properties: Record<string, unknown>,
  required: string[]
): Record<string, unknown> {
  return { type: "object", properties, required, additionalProperties: false };
}

function validateStart(input: unknown): ValidationResult<Input> {
  if (!isObject(input) || typeof input.command !== "string") {
    return { ok: false, issues: ["command must be a string"] };
  }
  if (
    input.args !== undefined &&
    (!Array.isArray(input.args) || !input.args.every((item) => typeof item === "string"))
  ) {
    return { ok: false, issues: ["args must be strings"] };
  }
  return { ok: true, value: input };
}

function processIdInput(input: unknown): ValidationResult<Input> {
  return isObject(input) && typeof input.processId === "string"
    ? { ok: true, value: input }
    : { ok: false, issues: ["processId must be a string"] };
}

function validateSignal(input: unknown): ValidationResult<Input> {
  if (!isObject(input) || typeof input.processId !== "string") {
    return { ok: false, issues: ["processId must be a string"] };
  }
  if (!(["SIGTERM", "SIGINT", "SIGKILL"] as unknown[]).includes(input.signal)) {
    return { ok: false, issues: ["signal is invalid"] };
  }
  return { ok: true, value: input };
}

function objectInput(input: unknown): ValidationResult<Input> {
  return isObject(input)
    ? { ok: true, value: input }
    : { ok: false, issues: ["input must be an object"] };
}

function isObject(input: unknown): input is Input {
  return typeof input === "object" && input !== null && !Array.isArray(input);
}

function snapshotOutput(snapshot: ManagedProcessSnapshot): ToolExecutionOutput {
  const { stdout, stderr, ...metadata } = snapshot;
  return {
    content: [
      { type: "json", value: metadata },
      ...(stdout || stderr
        ? [
            {
              type: "text" as const,
              text: [stdout ? `STDOUT\n${stdout}` : "", stderr ? `STDERR\n${stderr}` : ""]
                .filter(Boolean)
                .join("\n"),
            },
          ]
        : []),
    ],
    isError: false,
  };
}

function managedError(error: unknown): ToolExecutionOutput {
  const code = error instanceof ManagedProcessError ? error.code : "managed_process_failed";
  const message = error instanceof Error ? error.message : String(error);
  return {
    content: [{ type: "text", text: message }],
    isError: true,
    error: { code, message },
  };
}
