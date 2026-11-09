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
  type ManagedInputWriteResult,
  type ManagedProcessSnapshot,
  type ManagedProcessService,
} from "./managed-process.js";
import { utf8CompleteLength } from "./managed-process-output.js";
import { renderPlain, renderPlainCompact, renderPlainLines, reportedStatus, sliceLines, validateUntil } from "./managed-process-wait.js";
import { MANAGED_OUTPUT_SEARCH_SCHEMA, validateOutputSearch, type ManagedOutputSearchRequest } from "./managed-process-search.js";
import { commandLineShell, shellInvocation } from "./command-line.js";

type Input = Record<string, unknown>;

export interface ManagedProcessToolsOptions {
  /** A client outside Build (remote or local MCP): results without Build's bookkeeping, and search on a read. */
  readonly external?: boolean;
}

/**
 * The most of one stream a read gives such a client. It goes in a text block of its own, and the broker bounds each
 * block at 8 KiB, so the page stays inline, with hasMore and a cursor, instead of losing its middle to a preview.
 */
const CLIENT_READ_MAX_BYTES = 7 * 1024;
/** The broker's bound on one block. */
const CLIENT_BLOCK_MAX_BYTES = 8 * 1024;

export function createManagedProcessTools(
  service: ManagedProcessService,
  options: ManagedProcessToolsOptions = {},
): NativeTool<unknown>[] {
  const external = options.external === true;
  const pageSize = (input: Input) => external
    ? { maxBytes: Math.min((input.maxBytes as number | undefined) ?? CLIENT_READ_MAX_BYTES, CLIENT_READ_MAX_BYTES) }
    : input.maxBytes !== undefined ? { maxBytes: input.maxBytes as number } : {};
  /** A read for Build is one JSON block; for a client, JSON about the read and then its output in text blocks. */
  const readContent = (read: ManagedOutputReadResult, input: Input, around: (value: unknown) => unknown): ToolExecutionOutput["content"] => {
    if (!external) return [{ type: "json", value: around(presentRead(read, input)) }];
    const { value, output } = presentClientRead(read, input);
    return [{ type: "json", value: around(value) }, ...output];
  };
  const tools: NativeTool<Input>[] = [
    {
      definition: definition("process.start", "Start a durable background process from a command line, or a program with args. Optionally wait in the same call (until/waitMs) for readiness: a port, a pattern, a prompt or exit. A job that takes a minute or more (a long test suite, a build, a slow script) starts here before the other steps, even if the task lists it later; do them while it runs, then read its result.", false, "external"),
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
          if (input.until === undefined && !input.waitMs) return external ? clientSnapshotOutput(snapshot) : snapshotOutput(snapshot);
          // T1: the start is already admitted and reported; a failed wait stays in-band.
          // A client's read holds everything the snapshot's text would repeat. The identity keeps a block of its own:
          // the connector binds the job to it, and the broker replaces a block it finds too large.
          const started: ToolExecutionOutput = external ? { content: [{ type: "json", value: clientSnapshot(snapshot) }], isError: false } : snapshotOutput(snapshot);
          const withRead = (content: ToolExecutionOutput["content"]): ToolExecutionOutput => ({ ...started, content: [...started.content, ...content] });
          try {
            const read = await service.readOutput(snapshot.processId, {
              ...(input.until !== undefined ? { until: input.until as ManagedOutputUntil } : {}),
              // until without waitMs waits the interaction default rather than returning at once.
              waitMs: (input.waitMs as number | undefined) ?? (input.until !== undefined ? MANAGED_INTERACT_DEFAULT_WAIT_MS : 0),
              ...(external ? { maxBytes: CLIENT_READ_MAX_BYTES } : {}),
            }, context);
            return withRead(readContent(read, input, (value) => ({ read: value })));
          } catch (error) {
            return withRead([{ type: "json", value: { readError: errorValue(error) } }]);
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
            content: [{ type: "json", value: external ? clientWrite(result) : result }],
            isError: result.status !== "acknowledged",
            ...(result.status !== "acknowledged" ? { error: { code: result.errorCode ?? `process_input_${result.status}`, message: result.message ?? `Input ${result.status}.` } } : {}),
          };
        } catch (error) {
          return managedError(error);
        }
      },
    },
    {
      definition: withSearch(external, definition(
        "process.read_output",
        "Read an owned process's output incrementally. Pass the cursor from the previous result to get only new output; omit it to start from the beginning; use tailBytes for the latest output or range for an earlier retained byte range. waitMs waits (bounded) for new output or exit; until waits for evidence instead (exit, pattern, port, idleMs) and adds a labeled completion. render: plain strips terminal control sequences; lines selects a line window. Results report offsets, hasMore, and any gap where bounded retention lost bytes.",
        true,
        "none",
      )),
      validate: (input) => validateReadOutput(input, external),
      execute: async (input, context) => {
        try {
          const request: ManagedOutputReadRequest = {
            ...(input.cursor !== undefined ? { cursor: input.cursor as string } : {}),
            ...(input.stream !== undefined ? { stream: input.stream as "stdout" | "stderr" | "both" } : {}),
            ...pageSize(input),
            ...(input.waitMs !== undefined ? { waitMs: input.waitMs as number } : {}),
            // A tail read is for the end of the output, so a client's stays one page that reaches it.
            ...(input.tailBytes !== undefined ? { tailBytes: external ? Math.min(input.tailBytes as number, CLIENT_READ_MAX_BYTES) : input.tailBytes as number } : {}),
            ...(input.range !== undefined ? { range: input.range as { stream: "stdout" | "stderr"; startOffset: number } } : {}),
            ...(input.until !== undefined ? { until: input.until as ManagedOutputUntil } : {}),
            ...(input.search !== undefined ? { search: input.search as ManagedOutputSearchRequest } : {}),
            ...(external && input.lines !== undefined ? { lines: input.lines as { start: number; count: number } } : {}),
          };
          return { content: readContent(await service.readOutput(input.processId as string, request, context), input, (value) => value), isError: false };
        } catch (error) {
          return managedError(error);
        }
      },
      timeoutMs: (input) => (typeof input.waitMs === "number" ? Math.min(input.waitMs, MANAGED_OUTPUT_WAIT_MAX_MS) : 0) + 30_000,
    },
    {
      definition: definition(
        "process.interact",
        "One turn with an owned process started with interactive: true: send a line of input (appendNewline defaults to true), then wait for evidence that the turn is done and return only this turn's output. until defaults to { idleMs: 1500 }. completion says how the wait ended and how sure it is: exited/pattern/port are certain; input_wait is certain or likely; known_prompt and idle are heuristics; timeout means still running; unavailable means it stopped running without a proven exit. A write that was not acknowledged returns no output (never resent automatically).",
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
            ...pageSize(input),
          }, context);
          const turn = (read?: unknown) => ({ ...(external ? {} : { processId: result.processId }), write: external ? clientWrite(result.write) : result.write,
            ...(read !== undefined ? { read } : {}), ...(result.readError ? { readError: result.readError } : {}) });
          const content: ToolExecutionOutput["content"] = result.read ? readContent(result.read, input, turn) : [{ type: "json", value: turn() }];
          if (result.write.status === "acknowledged") return { content, isError: false };
          // Same outcome contract as process.write_stdin: rejected stays failed, unacknowledged stays outcome_unknown.
          return { content, isError: true,
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
          const processes = (await service.list(context)).map(snapshot => external ? clientListedProcess(snapshot) : ({ ...snapshot, status: reportedStatus(snapshot) }));
          return { content: [{ type: "json", value: { processes } }], isError: false };
        } catch (error) { return managedError(error); }
      },
    },
    {
      definition: definition("process.signal", "Stop an owned background process. Every signal stops the process: over pipes SIGINT is not an interrupt-and-continue, so the session ends.", false, "workspace"),
      validate: validateSignal,
      assessAccess: () => ({ capability: "process.signal", destructive: true }),
      execute: async (input, context) => {
        try {
          const stopped = await service.signal(
            input.processId as string,
            input.signal as "SIGTERM" | "SIGINT" | "SIGKILL",
            context
          );
          // Stopping is what was asked; the output stays readable through read_output if it is wanted.
          return external ? { content: [{ type: "json", value: stoppedSnapshot(stopped) }], isError: false } : snapshotOutput(stopped);
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

function withSearch(external: boolean, base: ReturnType<typeof definition>) {
  if (!external) return base;
  const schema = base.inputSchema as { properties: Record<string, unknown> };
  return { ...base,
    description: `${base.description} A process.run that returned a processId reads the same way, whole. search finds lines in everything kept, and lines reads them by 1-based number; either replaces the byte slice.`,
    inputSchema: { ...base.inputSchema, properties: { ...schema.properties, search: MANAGED_OUTPUT_SEARCH_SCHEMA, lines: CLIENT_LINES_SCHEMA } } } as const;
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

const CLIENT_LINES_SCHEMA = {
  ...LINES_SCHEMA,
  description: "Read these lines of everything kept, as plain text, instead of a byte slice. start is the 1-based line number; negative counts from the end. Long results page: ask for nextLine.",
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
  // A command line (see command-line.ts) starts in the platform shell, which stays inside the owned process tree.
  const shell = commandLineShell(input.command, input.args as string[] | undefined);
  if (!shell) return { ok: true, value: input };
  const { command, args } = shellInvocation(shell, input.command.trim());
  return { ok: true, value: { ...input, command, args } };
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

function validateReadOutput(input: unknown, searchable: boolean): ValidationResult<Input> {
  if (!isObject(input) || typeof input.processId !== "string") return { ok: false, issues: ["processId must be a string"] };
  const issues: string[] = [];
  for (const key of Object.keys(input)) if (!["processId", "cursor", "stream", "maxBytes", "waitMs", "tailBytes", "range", "until", "render", "lines", ...(searchable ? ["search"] : [])].includes(key)) issues.push(`${key} is not allowed`);
  issues.push(...untilIssues(input), ...renderIssues(input, true));
  if (searchable && input.search !== undefined) {
    try { validateOutputSearch(input.search); } catch (error) { issues.push(error instanceof Error ? error.message : "search is invalid"); }
    for (const key of ["cursor", "tailBytes", "range", "lines"]) if (input[key] !== undefined) issues.push(`search covers everything kept, so it cannot be combined with ${key}`);
  }
  if (searchable && input.lines !== undefined) {
    for (const key of ["cursor", "tailBytes", "range"]) if (input[key] !== undefined) issues.push(`lines reads by number across everything kept, so it cannot be combined with ${key}`);
  }
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
  const reported = { ...read, status: reportedStatus(read) };
  if (!lines && render !== "plain") return reported;
  return {
    ...reported,
    slices: read.slices.map(slice => {
      const plain = renderPlain(slice.text);
      if (!lines) return { ...slice, text: plain, render: "plain" };
      const { text: _text, ...rest } = slice;
      return { ...rest, render: "lines", ...sliceLines(plain, lines),
        ...(slice.startOffset === 0 ? {} : { linesRelativeToByteOffset: slice.startOffset }) };
    }),
  };
}

/**
 * A read as a client outside Build needs it: nothing the model could not act on, nothing empty. Offsets appear
 * only when more output waits, and the cursor only when another read could return something. The output goes in
 * text blocks, one per stream, which the model reads without JSON escapes; a page that decoding grew past the
 * broker's bound takes more than one.
 */
function presentClientRead(read: ManagedOutputReadResult, input: Input): { value: Record<string, unknown>; output: ToolExecutionOutput["content"] } {
  const lines = input.lines as { start: number; count: number } | undefined;
  const output: ToolExecutionOutput["content"] = [];
  const show = (stream: string, text: string) => { if (text.length) output.push(...clientTextBlocks(`${stream.toUpperCase()}\n${text}`)); };
  const notes = read.slices.flatMap(slice => {
    // Lines keep their numbers, so nothing is folded for them.
    const text = lines ? renderPlainLines(slice.text) : input.render === "plain" ? renderPlainCompact(slice.text) : slice.text;
    if (!text.length && !slice.hasMore && !slice.gap && !slice.lossyBytes) return [];
    // Only a turn's own output gets here with lines. Like everything else a client sees, it counts from one.
    const window = lines ? sliceLines(text, { start: lines.start > 0 ? lines.start - 1 : lines.start, count: lines.count }) : undefined;
    show(slice.stream, window ? window.lines.join("\n") : text);
    const note = {
      ...(window ? { startLine: window.startLine + 1, totalLines: window.totalLines, ...(slice.startOffset === 0 ? {} : { linesRelativeToByteOffset: slice.startOffset }) } : {}),
      ...(slice.hasMore || window?.hasMore ? { hasMore: true } : {}),
      ...(slice.hasMore ? { endOffset: slice.endOffset, totalBytes: slice.totalBytes } : {}),
      // A tail that does not reach back to the start says where it starts, so range can read what comes before.
      ...(input.tailBytes !== undefined && slice.startOffset > 0 ? { startOffset: slice.startOffset, totalBytes: slice.totalBytes } : {}),
      ...(slice.gap ? { gap: slice.gap } : {}),
      ...(slice.lossyBytes ? { lossyBytes: slice.lossyBytes, lossReasons: slice.lossReasons } : {}) };
    return Object.keys(note).length ? [{ stream: slice.stream, ...note }] : [];
  });
  const windows = (read.lineWindows ?? []).map(({ lines: shown, ...window }) => { show(window.stream, shown.join("\n")); return window; });
  const slices = [...notes, ...windows];
  const value = { status: reportedStatus(read),
    ...(read.exitCode !== null ? { exitCode: read.exitCode } : {}),
    ...(read.signal !== null ? { signal: read.signal } : {}),
    ...(read.completion ? { completion: clientCompletion(read.completion) } : {}),
    ...(read.state ? { state: read.state } : {}),
    ...(read.waited && !read.completion && read.waited !== "changed" ? { waited: read.waited } : {}),
    ...(read.search ? { search: read.search } : slices.length ? { slices } : {}),
    // Lines and search cover everything kept, so a stopped process has nothing a cursor could return. nextLine and truncated say if there is more to see.
    ...(read.complete ? { complete: true } : (read.lineWindows || read.search) && read.status !== "running" ? {} : { cursor: read.cursor }) };
  return { value, output };
}

/** Each byte that is not UTF-8 decodes to three, so a page can outgrow the broker's bound. It is split on whole characters, leaving the broker nothing to cut. */
function clientTextBlocks(text: string): ToolExecutionOutput["content"] {
  const bytes = Buffer.from(text);
  if (bytes.byteLength <= CLIENT_BLOCK_MAX_BYTES) return [{ type: "text", text }];
  const blocks: ToolExecutionOutput["content"] = [];
  for (let at = 0; at < bytes.byteLength;) {
    const piece = bytes.subarray(at, at + CLIENT_BLOCK_MAX_BYTES);
    const length = utf8CompleteLength(piece, at + piece.byteLength < bytes.byteLength);
    blocks.push({ type: "text", text: piece.subarray(0, length).toString("utf8") });
    at += length;
  }
  return blocks;
}

/** How the wait ended and how sure that is. Its timing inputs say nothing the model can use. */
function clientCompletion(completion: NonNullable<ManagedOutputReadResult["completion"]>): Record<string, unknown> {
  return { source: completion.source,
    ...(completion.confidence !== null ? { confidence: completion.confidence } : {}),
    ...(completion.matched !== undefined ? { matched: completion.matched } : {}),
    ...(completion.preexistingPort ? { preexistingPort: true } : {}) };
}

function clientWrite(write: ManagedInputWriteResult): Record<string, unknown> {
  return { status: write.status,
    ...(write.inputClosed ? { inputClosed: true } : {}),
    ...(write.deduplicated ? { deduplicated: true } : {}),
    ...(write.errorCode ? { errorCode: write.errorCode } : {}),
    ...(write.message ? { message: write.message } : {}) };
}

function clientSnapshot(snapshot: ManagedProcessSnapshot): Record<string, unknown> {
  return { processId: snapshot.processId, pid: snapshot.pid, status: reportedStatus(snapshot),
    ...(snapshot.exitCode !== null ? { exitCode: snapshot.exitCode } : {}),
    ...(snapshot.signal !== null ? { signal: snapshot.signal } : {}) };
}

/**
 * A signal returns only after the Runner's verified release (otherwise it throws process_cleanup_unverified), so a
 * stopped or exited result means the whole owned tree is gone. Saying so answers the check a model would otherwise
 * spend a turn or two on (listing processes, probing the port).
 */
function stoppedSnapshot(snapshot: ManagedProcessSnapshot): Record<string, unknown> {
  const value = clientSnapshot(snapshot);
  return value.status === "stopped" || value.status === "exited"
    ? { ...value, confirmed: "The process and every process it started have exited, so any port it listened on is closed. No further check is needed." }
    : value;
}

function clientListedProcess(snapshot: ManagedProcessSnapshot): Record<string, unknown> {
  const last = snapshot as ManagedProcessSnapshot & Pick<ManagedOutputReadResult, "state"> & { lastCompletion?: ManagedOutputReadResult["completion"] };
  return { ...clientSnapshot(snapshot), startedAt: snapshot.startedAt,
    ...(last.state ? { state: last.state } : {}),
    ...(last.lastCompletion ? { lastCompletion: clientCompletion(last.lastCompletion) } : {}) };
}

/** Whatever a process has printed by the moment it starts is worth showing; a start that waits reports it as a read instead. */
function clientSnapshotOutput(snapshot: ManagedProcessSnapshot): ToolExecutionOutput {
  const output = snapshotOutput(snapshot);
  return { ...output, content: output.content.map(block => block.type === "json" ? { type: "json" as const, value: clientSnapshot(snapshot) } : block) };
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
      { type: "json", value: { ...metadata, status: reportedStatus(snapshot) } },
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
