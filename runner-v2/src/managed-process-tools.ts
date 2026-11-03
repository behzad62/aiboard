import { createHash } from "node:crypto";
import type {
  NativeTool,
  ToolExecutionContext,
  ToolExecutionOutput,
  ValidationResult,
} from "./agent-contracts.js";
import {
  MANAGED_INPUT_MAX_BYTES,
  MANAGED_INTERACT_DEFAULT_WAIT_MS,
  MANAGED_OUTPUT_READ_MAX_BYTES,
  MANAGED_OUTPUT_WAIT_MAX_MS,
  MANAGED_PATTERN_MAX_CHARS,
  MANAGED_UNTIL_IDLE_MAX_MS,
  MANAGED_UNTIL_IDLE_MIN_MS,
  ManagedProcessError,
  type ManagedOutputReadRequest,
  type ManagedOutputReadResult,
  type ManagedOutputUntil,
  type ManagedProcessSnapshot,
  type ManagedProcessService,
} from "./managed-process.js";
import { renderPlain, sliceLines, validateUntil } from "./managed-process-wait.js";

type Input = Record<string, unknown>;

export function createManagedProcessTools(
  service: ManagedProcessService
): NativeTool<unknown>[] {
  const tools: NativeTool<Input>[] = [
    {
      definition: definition("process.start", "Start a durable background process. Optionally wait in the same call (until/waitMs) for readiness: a port, a pattern, a prompt or exit.", false, "external"),
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
          if (input.until === undefined && !input.waitMs) return snapshotOutput(snapshot);
          // T1: the start is already admitted and reported; a failed wait stays in-band.
          const output = snapshotOutput(snapshot);
          try {
            const read = await service.readOutput(snapshot.processId, {
              ...(input.until !== undefined ? { until: input.until as ManagedOutputUntil } : {}),
              // until without waitMs waits the interaction default rather than returning at once.
              waitMs: (input.waitMs as number | undefined) ?? (input.until !== undefined ? MANAGED_INTERACT_DEFAULT_WAIT_MS : 0),
            }, context);
            return { ...output, content: [...output.content, { type: "json", value: { read: presentRead(read, input) } }] };
          } catch (error) {
            return { ...output, content: [...output.content, { type: "json", value: { readError: errorValue(error) } }] };
          }
        } catch (error) {
          return managedError(error);
        }
      },
      timeoutMs: (input) => (typeof input.waitMs === "number" ? Math.min(input.waitMs, MANAGED_OUTPUT_WAIT_MAX_MS) : input.until !== undefined ? MANAGED_INTERACT_DEFAULT_WAIT_MS : 0) + 30_000,
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
        "Read an owned process's output incrementally. Pass the cursor from the previous result to get only new output; omit it to start from the beginning; use tailBytes for the latest output or range for an earlier retained byte range. waitMs waits (bounded) for new output or exit; until waits for evidence instead (exit, pattern, port, idleMs) and adds a labeled completion. render: plain strips terminal control sequences; lines selects a line window. Results report offsets, hasMore, and any gap where bounded retention lost bytes.",
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
            ...(input.until !== undefined ? { until: input.until as ManagedOutputUntil } : {}),
          };
          return { content: [{ type: "json", value: presentRead(await service.readOutput(input.processId as string, request, context), input) }], isError: false };
        } catch (error) {
          return managedError(error);
        }
      },
      timeoutMs: (input) => (typeof input.waitMs === "number" ? Math.min(input.waitMs, MANAGED_OUTPUT_WAIT_MAX_MS) : 0) + 30_000,
    },
    {
      definition: definition(
        "process.interact",
        "One turn with an owned process started with interactive: true: send a line of input (appendNewline defaults to true), then wait for evidence that the turn is done and return only this turn's output. until defaults to { idleMs: 1500 }. completion says how the wait ended and how sure it is: exited/pattern/port are certain; input_wait is certain or likely; known_prompt and idle are heuristics; timeout means still running. A write that was not acknowledged returns no output (never resent automatically).",
        false,
        "workspace",
      ),
      validate: validateInteract,
      assessAccess: () => ({ capability: "process.write_stdin" }),
      execute: async (input, context) => {
        try {
          const result = await service.interact(input.processId as string, {
            writeId: interactionWriteId(context),
            ...(input.data !== undefined ? { data: input.data as string } : {}),
            ...(input.appendNewline !== undefined ? { appendNewline: input.appendNewline as boolean } : {}),
            ...(input.closeInput !== undefined ? { closeInput: input.closeInput as boolean } : {}),
            ...(input.until !== undefined ? { until: input.until as ManagedOutputUntil } : {}),
            ...(input.waitMs !== undefined ? { waitMs: input.waitMs as number } : {}),
            ...(input.cursor !== undefined ? { cursor: input.cursor as string } : {}),
            ...(input.stream !== undefined ? { stream: input.stream as "stdout" | "stderr" | "both" } : {}),
            ...(input.maxBytes !== undefined ? { maxBytes: input.maxBytes as number } : {}),
          }, context);
          const value = { processId: result.processId, write: result.write,
            ...(result.read ? { read: presentRead(result.read, input) } : {}), ...(result.readError ? { readError: result.readError } : {}) };
          if (result.write.status === "acknowledged") return { content: [{ type: "json", value }], isError: false };
          // Same outcome contract as process.write_stdin: rejected stays failed, unacknowledged stays outcome_unknown.
          return { content: [{ type: "json", value }], isError: true,
            error: { code: result.write.errorCode ?? (result.write.status === "outcome_unknown" ? "process_input_outcome_unknown" : `process_input_${result.write.status}`),
              message: result.write.message ?? `Input ${result.write.status}.` } };
        } catch (error) {
          return managedError(error);
        }
      },
      timeoutMs: (input) => (typeof input.waitMs === "number" ? Math.min(input.waitMs, MANAGED_OUTPUT_WAIT_MAX_MS) : MANAGED_INTERACT_DEFAULT_WAIT_MS) + 30_000,
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
      definition: definition("process.signal", "Stop an owned background process. Every signal stops the process: over pipes SIGINT is not an interrupt-and-continue, so the session ends.", false, "workspace"),
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
        interactive: { type: "boolean", description: "Enable process.write_stdin / process.interact (line-oriented pipe, not a terminal)." },
        until: UNTIL_SCHEMA,
        waitMs: { type: "integer", minimum: 0, maximum: MANAGED_OUTPUT_WAIT_MAX_MS, description: "Wait in this call for until (or for any output when until is omitted). Default 0." },
        render: RENDER_SCHEMA,
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
        until: UNTIL_SCHEMA,
        render: RENDER_SCHEMA,
        lines: LINES_SCHEMA,
      }, ["processId"]);
    case "process.interact":
      return objectSchema({
        processId: { type: "string", minLength: 1 },
        data: { type: "string", maxLength: MANAGED_INPUT_MAX_BYTES },
        appendNewline: { type: "boolean", description: "Append exactly one \\n after data. Default true." },
        closeInput: { type: "boolean", description: "Send end-of-input (EOF) after data." },
        until: UNTIL_SCHEMA,
        waitMs: { type: "integer", minimum: 0, maximum: MANAGED_OUTPUT_WAIT_MAX_MS, description: "Default 15000." },
        cursor: { type: "string", description: "Read from this cursor instead of from the moment of this write." },
        stream: { type: "string", enum: ["stdout", "stderr", "both"] },
        maxBytes: { type: "integer", minimum: 4, maximum: MANAGED_OUTPUT_READ_MAX_BYTES },
        render: RENDER_SCHEMA,
        lines: LINES_SCHEMA,
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

const UNTIL_SCHEMA = {
  type: "object",
  description: "End the wait on evidence: exit (only exit), pattern (safe regex over new output), port (loopback TCP accepts), idleMs (quiet output; with CPU evidence this detects a program waiting for input). {} means { idleMs: 1500 }.",
  properties: {
    exit: { const: true },
    pattern: { type: "string", minLength: 1, maxLength: MANAGED_PATTERN_MAX_CHARS },
    patternFlags: { enum: ["i"] },
    port: { type: "integer", minimum: 1, maximum: 65_535 },
    idleMs: { type: "integer", minimum: MANAGED_UNTIL_IDLE_MIN_MS, maximum: MANAGED_UNTIL_IDLE_MAX_MS },
  },
  additionalProperties: false,
} as const;
const RENDER_SCHEMA = { enum: ["raw", "plain"], description: "plain: ANSI stripped, \\r progress collapsed, repeated lines folded. Default raw." } as const;
const LINES_SCHEMA = {
  type: "object",
  description: "Return lines of the plain text instead of the byte slice; negative start counts from the end.",
  properties: { start: { type: "integer" }, count: { type: "integer", minimum: 1, maximum: 2000 } },
  required: ["start", "count"],
  additionalProperties: false,
} as const;

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
  const waitIssues = [...untilIssues(input), ...renderIssues(input, false)];
  if (input.waitMs !== undefined && (!Number.isSafeInteger(input.waitMs) || (input.waitMs as number) < 0 || (input.waitMs as number) > MANAGED_OUTPUT_WAIT_MAX_MS)) waitIssues.push(`waitMs must be 0..${MANAGED_OUTPUT_WAIT_MAX_MS}`);
  if (waitIssues.length) return { ok: false, issues: waitIssues };
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
  for (const key of Object.keys(input)) if (!["processId", "cursor", "stream", "maxBytes", "waitMs", "tailBytes", "range", "until", "render", "lines"].includes(key)) issues.push(`${key} is not allowed`);
  issues.push(...untilIssues(input), ...renderIssues(input, true));
  if (input.cursor !== undefined && typeof input.cursor !== "string") issues.push("cursor must be a string");
  for (const key of ["maxBytes", "waitMs", "tailBytes"]) if (input[key] !== undefined && !Number.isSafeInteger(input[key])) issues.push(`${key} must be an integer`);
  if (input.range !== undefined && (!isObject(input.range) || typeof input.range.stream !== "string" || !Number.isSafeInteger(input.range.startOffset))) issues.push("range needs stream and integer startOffset");
  return issues.length ? { ok: false, issues } : { ok: true, value: input };
}

function validateInteract(input: unknown): ValidationResult<Input> {
  if (!isObject(input) || typeof input.processId !== "string") return { ok: false, issues: ["processId must be a string"] };
  const issues: string[] = [];
  for (const key of Object.keys(input)) if (!["processId", "data", "appendNewline", "closeInput", "until", "waitMs", "cursor", "stream", "maxBytes", "render", "lines"].includes(key)) issues.push(`${key} is not allowed`);
  if (input.data !== undefined && typeof input.data !== "string") issues.push("data must be a string");
  for (const key of ["appendNewline", "closeInput"]) if (input[key] !== undefined && typeof input[key] !== "boolean") issues.push(`${key} must be a boolean`);
  if (input.cursor !== undefined && typeof input.cursor !== "string") issues.push("cursor must be a string");
  if (input.stream !== undefined && !["stdout", "stderr", "both"].includes(input.stream as string)) issues.push("stream must be stdout, stderr or both");
  for (const key of ["maxBytes", "waitMs"]) if (input[key] !== undefined && !Number.isSafeInteger(input[key])) issues.push(`${key} must be an integer`);
  issues.push(...untilIssues(input), ...renderIssues(input, true));
  return issues.length ? { ok: false, issues } : { ok: true, value: input };
}

function untilIssues(input: Input): string[] {
  if (input.until === undefined) return [];
  try { validateUntil(input.until); return []; }
  catch (error) { return [error instanceof Error ? error.message : "until is invalid"]; }
}

function renderIssues(input: Input, allowLines: boolean): string[] {
  const issues: string[] = [];
  if (input.render !== undefined && input.render !== "raw" && input.render !== "plain") issues.push("render must be raw or plain");
  if (input.lines !== undefined) {
    if (!allowLines) issues.push("lines is not allowed");
    else if (!isObject(input.lines) || !Number.isSafeInteger(input.lines.start) || !Number.isSafeInteger(input.lines.count) ||
      (input.lines.count as number) < 1 || (input.lines.count as number) > 2000 || Object.keys(input.lines).some(key => key !== "start" && key !== "count")) issues.push("lines needs integer start and count 1..2000");
  }
  return issues;
}

/**
 * Model-facing presentation of a read. raw keeps today's slices; plain renders each slice as a
 * terminal would leave it; lines pages the plain text. Line numbers are absolute only when the
 * slice starts at byte 0; otherwise they count from the slice start and say so.
 */
function presentRead(read: ManagedOutputReadResult, input: Input): unknown {
  const render = input.render as "raw" | "plain" | undefined;
  const lines = input.lines as { start: number; count: number } | undefined;
  if (!lines && render !== "plain") return read;
  return {
    ...read,
    slices: read.slices.map(slice => {
      const plain = renderPlain(slice.text);
      if (!lines) return { ...slice, text: plain, render: "plain" };
      const { text: _text, ...rest } = slice;
      return { ...rest, render: "lines", ...sliceLines(plain, lines),
        ...(slice.startOffset === 0 ? {} : { linesRelativeToByteOffset: slice.startOffset }) };
    }),
  };
}

/** One logical turn per admitted call: the write identity is the call identity, never model-chosen. */
function interactionWriteId(context: ToolExecutionContext): string {
  return `interact-${createHash("sha256").update(context.callId ?? "").digest("hex").slice(0, 48)}`;
}

function errorValue(error: unknown): { code: string; message: string } {
  return { code: error instanceof ManagedProcessError ? error.code : "managed_process_failed", message: error instanceof Error ? error.message : String(error) };
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
