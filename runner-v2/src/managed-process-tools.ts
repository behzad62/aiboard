import type {
  NativeTool,
  ToolExecutionOutput,
  ValidationResult,
} from "./agent-contracts.js";
import {
  MANAGED_INPUT_MAX_BYTES,
  MANAGED_OUTPUT_READ_MAX_BYTES,
  MANAGED_OUTPUT_WAIT_MAX_MS,
  ManagedProcessError,
  type ManagedOutputReadRequest,
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
          const snapshot = await service.start(
            {
              command: input.command as string,
              args: (input.args as string[] | undefined) ?? [],
              cwd: input.cwd as string | undefined,
              env: input.env as Record<string, string> | undefined,
              ...(input.interactive === true ? { interactive: true } : {}),
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
          return snapshotOutput(await service.poll(input.processId as string, context));
        } catch (error) {
          return managedError(error);
        }
      },
    },
    {
      definition: definition(
        "process.write_stdin",
        "Send line-oriented UTF-8 input to an owned process started with interactive: true. Returns only after the input is acknowledged (status acknowledged), refused before delivery (rejected) or not acknowledged (outcome_unknown; never resent automatically). Reuse the same writeId to retry safely; it is never sent twice. closeInput sends end-of-input (EOF), not a signal. Read responses with process.read_output.",
        false,
        "workspace",
      ),
      validate: validateWriteStdin,
      assessAccess: () => ({ capability: "process.write_stdin" }),
      execute: async (input, context) => {
        try {
          const result = await service.writeInput(input.processId as string, {
            writeId: input.writeId as string,
            ...(input.data !== undefined ? { data: input.data as string } : {}),
            ...(input.appendNewline !== undefined ? { appendNewline: input.appendNewline as boolean } : {}),
            ...(input.closeInput !== undefined ? { closeInput: input.closeInput as boolean } : {}),
          }, context);
          return {
            content: [{ type: "json", value: result }],
            isError: result.status !== "acknowledged",
            ...(result.status !== "acknowledged" ? { error: { code: result.errorCode ?? `process_input_${result.status}`, message: result.message ?? `Input ${result.status}.` } } : {}),
          };
        } catch (error) {
          return managedError(error);
        }
      },
    },
    {
      definition: definition(
        "process.read_output",
        "Read an owned process's output incrementally. Pass the cursor from the previous result to get only new output; omit it to start from the beginning; use tailBytes for the latest output or range for an earlier retained byte range. waitMs waits (bounded) for new output or exit. Results report offsets, hasMore, and any gap where bounded retention lost bytes.",
        true,
        "none",
      ),
      validate: validateReadOutput,
      execute: async (input, context) => {
        try {
          const request: ManagedOutputReadRequest = {
            ...(input.cursor !== undefined ? { cursor: input.cursor as string } : {}),
            ...(input.stream !== undefined ? { stream: input.stream as "stdout" | "stderr" | "both" } : {}),
            ...(input.maxBytes !== undefined ? { maxBytes: input.maxBytes as number } : {}),
            ...(input.waitMs !== undefined ? { waitMs: input.waitMs as number } : {}),
            ...(input.tailBytes !== undefined ? { tailBytes: input.tailBytes as number } : {}),
            ...(input.range !== undefined ? { range: input.range as { stream: "stdout" | "stderr"; startOffset: number } } : {}),
          };
          return { content: [{ type: "json", value: await service.readOutput(input.processId as string, request, context) }], isError: false };
        } catch (error) {
          return managedError(error);
        }
      },
      timeoutMs: (input) => (typeof input.waitMs === "number" ? Math.min(input.waitMs, MANAGED_OUTPUT_WAIT_MAX_MS) : 0) + 30_000,
    },
    {
      definition: definition("process.list", "List owned background processes", true, "none"),
      validate: objectInput,
      execute: async (_input, context) => {
        try {
          return { content: [{ type: "json", value: { processes: await service.list(context) } }], isError: false };
        } catch (error) { return managedError(error); }
      },
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
        interactive: { type: "boolean", description: "Enable process.write_stdin (line-oriented pipe, not a terminal)." },
      }, ["command"]);
    case "process.write_stdin":
      return objectSchema({
        processId: { type: "string", minLength: 1 },
        writeId: { type: "string", pattern: "^[A-Za-z0-9._:-]{1,128}$", description: "Idempotency key; reuse it only to retry the same input." },
        data: { type: "string", maxLength: MANAGED_INPUT_MAX_BYTES },
        appendNewline: { type: "boolean", description: "Append exactly one \\n after data." },
        closeInput: { type: "boolean", description: "Send end-of-input (EOF) after data." },
      }, ["processId", "writeId"]);
    case "process.read_output":
      return objectSchema({
        processId: { type: "string", minLength: 1 },
        cursor: { type: "string" },
        stream: { type: "string", enum: ["stdout", "stderr", "both"] },
        maxBytes: { type: "integer", minimum: 4, maximum: MANAGED_OUTPUT_READ_MAX_BYTES },
        waitMs: { type: "integer", minimum: 0, maximum: MANAGED_OUTPUT_WAIT_MAX_MS },
        tailBytes: { type: "integer", minimum: 1, maximum: MANAGED_OUTPUT_READ_MAX_BYTES },
        range: objectSchema({
          stream: { type: "string", enum: ["stdout", "stderr"] },
          startOffset: { type: "integer", minimum: 0 },
        }, ["stream", "startOffset"]),
      }, ["processId"]);
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

function validateWriteStdin(input: unknown): ValidationResult<Input> {
  if (!isObject(input) || typeof input.processId !== "string" || typeof input.writeId !== "string") {
    return { ok: false, issues: ["processId and writeId must be strings"] };
  }
  const issues: string[] = [];
  if (input.data !== undefined && typeof input.data !== "string") issues.push("data must be a string");
  for (const key of ["appendNewline", "closeInput"]) if (input[key] !== undefined && typeof input[key] !== "boolean") issues.push(`${key} must be a boolean`);
  for (const key of Object.keys(input)) if (!["processId", "writeId", "data", "appendNewline", "closeInput"].includes(key)) issues.push(`${key} is not allowed`);
  return issues.length ? { ok: false, issues } : { ok: true, value: input };
}

function validateReadOutput(input: unknown): ValidationResult<Input> {
  if (!isObject(input) || typeof input.processId !== "string") return { ok: false, issues: ["processId must be a string"] };
  const issues: string[] = [];
  for (const key of Object.keys(input)) if (!["processId", "cursor", "stream", "maxBytes", "waitMs", "tailBytes", "range"].includes(key)) issues.push(`${key} is not allowed`);
  if (input.cursor !== undefined && typeof input.cursor !== "string") issues.push("cursor must be a string");
  for (const key of ["maxBytes", "waitMs", "tailBytes"]) if (input[key] !== undefined && !Number.isSafeInteger(input[key])) issues.push(`${key} must be an integer`);
  if (input.range !== undefined && (!isObject(input.range) || typeof input.range.stream !== "string" || !Number.isSafeInteger(input.range.startOffset))) issues.push("range needs stream and integer startOffset");
  return issues.length ? { ok: false, issues } : { ok: true, value: input };
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
