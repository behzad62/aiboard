import { resolve } from "node:path";

import { AUTHORIZED_STOP_CLEANUP_TIMEOUT_MS } from "./cleanup-timeouts.js";
import { renderPlainCompact, renderPlainLines, summarizeOutput } from "./managed-process-wait.js";
import { MANAGED_OUTPUT_SEARCH_SCHEMA, newlinesIn, retainedRegions, searchOutput, validateOutputSearch, type ManagedOutputSearchRequest } from "./managed-process-search.js";
import type { ManagedOutputStreamEvidence } from "./managed-process-contracts.js";
import type { ManagedProcessService, ManagedRetainedOutput } from "./managed-process.js";
import type { GenericProcessResult, ProcessOutputDisposition } from "./execution-safety-contracts.js";
import type {
  NativeTool,
  ToolExecutionContext,
  ToolExecutionOutput,
  ValidationResult,
} from "./agent-contracts.js";
import { isBenchmarkCommandAllowed } from "./benchmark-command-policy.js";
import { commandLineShell, shellInvocation } from "./command-line.js";
import { knownShells, SHELL_NAMES, shellMayRun, type ShellName } from "./shell-inventory.js";
import { SESSION_MAX_TIMEOUT_MS, SESSION_NAME_PATTERN, SESSION_SHELLS, shellSessionsFor, type SessionShell, type ShellSessions } from "./shell-session.js";
import {
  outputFor,
  type OneShotCommandExecutor,
  type OneShotCommandResult,
} from "./one-shot-command-executor.js";

interface ProcessInput {
  command?: string;
  args?: string[];
  shell?: ShellName;
  script?: string;
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  render?: "raw" | "summary";
  search?: ManagedOutputSearchRequest;
  shellSession?: string;
}

/**
 * The names a model sees the process tools by. Build's models call them process.start; a client of the MCP servers
 * (Remote, local MCP) sees process_start. Only the names differ: Build and the clients get the same tools, results
 * and descriptions, so a fix made for one reaches the other.
 */
export type ProcessToolNames = "build" | "mcp";

export function processToolName(names: ProcessToolNames | undefined, name: `process.${string}`): string {
  return names === "mcp" ? name.replace(".", "_") : name;
}

/** What process.run uses beyond the command: where a finished command's output stays readable by processId (search, lines), and the shell sessions. */
export interface ProcessRunSupport {
  /** Keeps a finished command's output readable through process.read_output; returns the id to read it by. */
  retainOutput?(context: Readonly<ToolExecutionContext>, output: ManagedRetainedOutput): string;
  readArtifact(artifactId: string): Promise<Uint8Array>;
  /** Runs a command with shellSession in a shell that stays up between calls (shell-session.ts). */
  sessions?: ShellSessions;
}

/**
 * What Build and the MCP servers both give process.run: the run's managed processes keep a finished command's output
 * readable by processId and hold its shell sessions, and its artifact store holds whatever spilled past the retained tail.
 */
export function processRunSupport(managedProcesses: ManagedProcessService | undefined,
  artifacts: { get(artifactId: string): Promise<Uint8Array> }): ProcessRunSupport {
  return Object.freeze({
    ...(managedProcesses ? { retainOutput: (context: Readonly<ToolExecutionContext>, output: ManagedRetainedOutput) => managedProcesses.retainOutput(context, output),
      sessions: shellSessionsFor(managedProcesses) } : {}),
    readArtifact: (artifactId: string) => artifacts.get(artifactId),
  });
}

/** No store: large output is still summarized, from the retained tail, and has no processId. */
const NO_RETENTION: ProcessRunSupport = Object.freeze({
  readArtifact: async () => { throw new Error("This command's stored output is not readable here."); },
});

/** Output at or under this size comes back whole. A stream's summary stays near it, inside the broker's 8 KiB inline bound. */
const SUMMARY_BYTES = 6 * 1024;
const SUMMARY_HEAD_LINES = 20;
const SUMMARY_TAIL_LINES = 40;
/** A summary's real head comes from the stored output; past this size only the retained tail is read for it. */
const WHOLE_SUMMARY_MAX_BYTES = 16 * 1024 * 1024;

/** What a result takes beyond the command: stopping what is left of it, then summarizing or searching its output. */
const RESULT_GRACE_MS = AUTHORIZED_STOP_CLEANUP_TIMEOUT_MS + 30_000;
/** A command's limit when the call names no timeoutMs. The MCP servers' instructions quote it. */
export const PROCESS_RUN_DEFAULT_TIMEOUT_MS = 120_000;

export interface ProcessToolsOptions {
  execution?: OneShotCommandExecutor;
  /** Retained for API compatibility; shared runtime output policy owns the effective bound. */
  maxOutputBytes?: number;
  defaultTimeoutMs?: number;
  maximumTimeoutMs?: number;
  allowedCommands?: readonly string[];
  /** Keeps large output readable by processId. Without it, process.run still summarizes large output, with no processId. */
  support?: ProcessRunSupport;
  /** The names the model sees: Build's (the default) or the MCP servers'. */
  names?: ProcessToolNames;
}

export function createProcessTools(
  options: ProcessToolsOptions = {}
): NativeTool<unknown>[] {
  const defaultTimeoutMs = options.defaultTimeoutMs ?? PROCESS_RUN_DEFAULT_TIMEOUT_MS;
  const maximumTimeoutMs = options.maximumTimeoutMs ?? 30 * 60_000;
  const name = (tool: `process.${string}`) => processToolName(options.names, tool);
  // Build's changes reach the project through its change sets, so its example of commands that belong together is a build and its tests.
  const together = options.names === "mcp" ? "such as git add then git commit or a build then its tests" : "such as a build then its tests";
  const tool: NativeTool<ProcessInput> = {
    definition: {
      name: "process.run",
      // Some clients give sub-agents tool descriptions but not the server's instructions, so this says what a long command needs.
      description: "Run a command and wait for it. " +
        `It is stopped at timeoutMs (default ${defaultTimeoutMs / 1000} s), which leaves its effect unknown, so start servers, long jobs and interactive programs with ${name("process.start")}. ` +
        `command is a whole command line, run by cmd.exe on Windows and bash elsewhere, or one program with its arguments in args; for another shell, such as PowerShell or Git Bash, send shell and script instead. Commands that run one after another, ${together}, go in one call. Large output comes back as its head, tail and diagnostics with a processId for ${name("process.read_output")}; search returns only the matching lines. ` +
        `With shellSession, a PowerShell script runs in a shell kept between calls that name the same shellSession, so its variables, functions, $env: values and location carry over.`,
      inputSchema: {
        type: "object",
        properties: {
          command: { type: "string" },
          args: { type: "array", items: { type: "string" } },
          shell: { enum: [...SHELL_NAMES], description: "powershell is Windows PowerShell 5.1, pwsh is PowerShell 7 where installed, bash is Git Bash on Windows." },
          script: { type: "string" },
          cwd: { type: "string" },
          env: { type: "object", additionalProperties: { type: "string" } },
          timeoutMs: { type: "integer", minimum: 1 },
          render: { enum: ["raw", "summary"], description: "summary: for large output, plain text head + tail + diagnostics found in the omitted middle. Default summary." },
          search: MANAGED_OUTPUT_SEARCH_SCHEMA,
          shellSession: { type: "string", description: `Optional; leave it out unless a later call needs this one's variables, functions or location. Any name, with shell powershell or pwsh and script; the first call starts that shell, and a command in it can run up to ${SESSION_MAX_TIMEOUT_MS / 1000} s.` },
        },
        additionalProperties: false,
      },
      readOnly: false,
      effect: "external",
    },
    validate: validateInput,
    // The command's own limit decides. The broker's default would end a longer one with nothing to show for it.
    timeoutMs: (input: ProcessInput) => Math.min(input.timeoutMs ?? defaultTimeoutMs, maximumTimeoutMs) + RESULT_GRACE_MS,
    assessAccess: (input) => ({
      capability: input.shell || (input.command !== undefined && commandLineShell(input.command, input.args)) ? "process.shell" : "process.execute",
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
        options.allowedCommands,
        options.support ?? NO_RETENTION,
        name("process.read_output"),
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
    (SHELL_NAMES as readonly unknown[]).includes(value.shell) &&
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
  if (value.render !== undefined && value.render !== "raw" && value.render !== "summary") {
    return { ok: false, issues: ["render must be raw or summary"] };
  }
  if (value.search !== undefined) {
    try { validateOutputSearch(value.search); }
    catch (error) { return { ok: false, issues: [error instanceof Error ? error.message : "search is invalid"] }; }
  }
  const line = asShellLine(value as ProcessInput);
  if (value.shellSession !== undefined) {
    if (typeof value.shellSession !== "string" || !SESSION_NAME_PATTERN.test(value.shellSession)) return { ok: false, issues: ["shellSession is a name of 1-64 letters, digits, '.', '_' or '-'"] };
    if (!(SESSION_SHELLS as readonly unknown[]).includes(line.shell) || line.script === undefined) return { ok: false, issues: ["a shellSession runs PowerShell: send shell powershell or pwsh with script"] };
    if (line.timeoutMs !== undefined && line.timeoutMs > SESSION_MAX_TIMEOUT_MS) {
      return { ok: false, issues: [`a shellSession command can run up to ${SESSION_MAX_TIMEOUT_MS} ms; start a longer job with process.start`] };
    }
  }
  return { ok: true, value: line };
}

async function executeProcess(
  input: ProcessInput,
  context: ToolExecutionContext,
  execution: OneShotCommandExecutor | undefined,
  defaultTimeoutMs: number,
  maximumTimeoutMs: number,
  allowedCommands: readonly string[] | undefined,
  retention: ProcessRunSupport,
  readTool: string,
): Promise<ToolExecutionOutput> {
  if (!context.workspacePath) {
    return processError("workspace_required", "Process tool requires a workspace.");
  }
  input = asShellLine(input);
  if (input.shell && !shellMayRun(input.shell)) {
    return processError("shell_unavailable", `${input.shell} is not installed on this device, so nothing ran. Its shells: ${knownShells()!.join(", ")}.`);
  }
  if ((!execution && input.shellSession === undefined) || !context.executionGrant || !context.callId) {
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
  if (input.shellSession !== undefined) return await executeSession(input, context, retention, readTool);
  const invocation = commandInvocation(input);
  const cwd = resolve(context.workspacePath, input.cwd ?? ".");
  const timeoutMs = Math.min(input.timeoutMs ?? defaultTimeoutMs, maximumTimeoutMs);
  try {
    const result = await execution!.execute({
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
    const failure = runFailure(result.process.outcome, timeoutMs);
    return await runResult(input, context, result, failure, retention, readTool);
  } catch (error) {
    const value = error as { code?: unknown; message?: unknown };
    const code = typeof value.code === "string" ? value.code : "process_runtime_failed";
    const message = typeof value.message === "string" ? value.message : String(error);
    return processError(code, message);
  }
}

function runFailure(outcome: GenericProcessResult["outcome"], timeoutMs: number): { code: string; message: string } | undefined {
  switch (outcome) {
    case "launch_failed": return { code: "process_start_failed", message: "Process launch was not proven." };
    case "timed_out": return { code: "process_timeout", message: `Process exceeded ${timeoutMs} ms.` };
    case "cancelled": return { code: "process_cancelled", message: "Process was cancelled." };
    case "cleanup_failed": return { code: "process_cleanup_failed", message: "Process cleanup could not be verified." };
    default: return undefined;
  }
}

/** A command's result: its one-shot run, told the way every process.run result is (presentRun). */
async function runResult(
  input: ProcessInput,
  context: ToolExecutionContext,
  result: OneShotCommandResult,
  failure: { code: string; message: string } | undefined,
  retention: ProcessRunSupport,
  readTool: string,
): Promise<ToolExecutionOutput> {
  const run = result.process;
  return await presentRun(input, context, {
    streams: (["stdout", "stderr"] as const).map((stream) => streamEvidence(outputFor(run, stream))),
    exitCode: run.exitCode ?? null,
    ...(run.signal ? { signal: run.signal } : {}),
    ...(failure ? { failure } : {}),
    details: {
      ...(run.outcome === "timed_out" ? { timedOut: true } : {}),
      ...(run.outcome === "cancelled" ? { cancelled: true } : {}),
      ...(run.cleanup.state === "verified_empty" || run.cleanup.state === "not_required" ? {} : { cleanup: run.cleanup }),
      ...(run.output.some((entry) => entry.lossyBytes > 0) ? { outputLossy: true, ...lossReasons(run) } : {}),
      ...(result.enforcement === "unconfined_explicit_full" ? {} : { enforcement: result.enforcement, disclosure: result.disclosure }),
      ...(result.providerId ? { providerId: result.providerId } : {}),
    },
  }, retention, readTool);
}

/** A command in a shell session (shell-session.ts). */
async function executeSession(input: ProcessInput, context: ToolExecutionContext, support: ProcessRunSupport, readTool: string): Promise<ToolExecutionOutput> {
  if (!support.sessions) return processError("session_unavailable", "Shell sessions are not available here, so nothing ran; run the command without shellSession.");
  const timeoutMs = Math.min(input.timeoutMs ?? SESSION_MAX_TIMEOUT_MS, SESSION_MAX_TIMEOUT_MS);
  try {
    const outcome = await support.sessions.run({ name: input.shellSession!, shell: input.shell as SessionShell, script: input.script!, timeoutMs,
      ...(input.cwd !== undefined ? { cwd: resolve(context.workspacePath!, input.cwd) } : {}), ...(input.env ? { env: input.env } : {}) }, context);
    const failure = outcome.error ?? (outcome.timedOut
      ? { code: "process_timeout", message: `Command exceeded ${timeoutMs} ms${outcome.ended ? "." : "; the session stopped it and kept its state."}` }
      : undefined);
    const moved = outcome.cwd !== undefined && !samePath(outcome.cwd, context.workspacePath!);
    return await presentRun(input, context, {
      streams: outcome.streams,
      exitCode: outcome.exitCode,
      ...(failure ? { failure } : {}),
      details: {
        ...(outcome.timedOut ? { timedOut: true } : {}),
        ...(outcome.lossReasons.length || outcome.streams.some((stream) => stream.lossyBytes > 0)
          ? { outputLossy: true, ...(outcome.lossReasons.length ? { lossReasons: [...outcome.lossReasons] } : {}) } : {}),
        shellSession: { name: input.shellSession, processId: outcome.processId, ...(outcome.began ? { [outcome.began]: true } : {}),
          ...(moved ? { cwd: outcome.cwd } : {}), ...(outcome.ended ? { ended: outcome.ended } : {}) },
      },
    }, support, readTool);
  } catch (error) {
    const value = error as { code?: unknown; message?: unknown };
    return processError(typeof value.code === "string" ? value.code : "process_runtime_failed", typeof value.message === "string" ? value.message : String(error));
  }
}

function samePath(a: string, b: string): boolean {
  const normal = (path: string) => resolve(path).replace(/[\\/]+$/u, "");
  return process.platform === "win32" ? normal(a).toLowerCase() === normal(b).toLowerCase() : normal(a) === normal(b);
}

interface RunOutcome {
  readonly streams: readonly ManagedOutputStreamEvidence[];
  readonly exitCode: number | null;
  readonly signal?: string;
  readonly failure?: { code: string; message: string };
  /** Shown after exitCode, signal and error. */
  readonly details: Record<string, unknown>;
}

/**
 * A command's result: what it did and what it printed, without the bookkeeping that holds for nearly every command.
 * Anything left out of the text stays readable by processId, so a model never has to run a command again to see
 * more of what it printed.
 */
async function presentRun(
  input: ProcessInput,
  context: ToolExecutionContext,
  run: RunOutcome,
  retention: ProcessRunSupport,
  readTool: string,
): Promise<ToolExecutionOutput> {
  const { streams, failure } = run;
  const printed = streams.some((stream) => stream.totalBytes > 0);
  const retain = input.search ? printed : streams.some((stream) => stream.totalBytes > SUMMARY_BYTES);
  const processId = retain && retention.retainOutput ? retention.retainOutput(context, { exitCode: run.exitCode, signal: run.signal ?? null, streams }) : undefined;
  // The command already ran, so a search that fails must not cost the model its result.
  const search = input.search
    ? await searchOutput({ streams, request: input.search, readSpill: retention.readArtifact }).catch((error: unknown) => ({ error: error instanceof Error ? error.message : String(error) }))
    : undefined;
  const failed = failure !== undefined || (run.exitCode ?? 0) !== 0 || run.signal !== undefined || (search !== undefined && "error" in search);
  const sections = search && !failed ? [] : await Promise.all(streams.map(async (stream) => {
    const text = await clientStreamText(stream, input.render ?? "summary", processId, retention, readTool);
    return text ? `${stream.stream.toUpperCase()}\n${text}` : "";
  }));
  const metadata = {
    exitCode: run.exitCode,
    ...(run.signal ? { signal: run.signal } : {}),
    ...(failure ? { error: failure.message } : {}),
    ...run.details,
    ...(processId ? { processId, stdoutBytes: streams[0]!.totalBytes, stderrBytes: streams[1]!.totalBytes } : {}),
    ...(search ? { search } : {}),
  };
  return {
    // One block per stream: each stays under the broker's inline bound on its own.
    content: [{ type: "json", value: metadata }, ...sections.filter(Boolean).map((text) => ({ type: "text" as const, text }))],
    isError: failure !== undefined,
    ...(failure ? { error: failure } : {}),
  };
}

/** Why output was lost, as the spool names it at the head of a stream's display tail (bounded-output-spool.ts). */
function lossReasons(run: GenericProcessResult): { lossReasons?: string[] } {
  const reasons = new Set(run.output.flatMap((entry) => /^\[runner output lossy: ([a-z0-9_,]+)\]\n/u.exec(entry.tail)?.[1]!.split(",") ?? []));
  return reasons.size ? { lossReasons: [...reasons] } : {};
}

function streamEvidence(output: ProcessOutputDisposition): ManagedOutputStreamEvidence {
  const bytes = output.tailBytesBase64 !== undefined ? Buffer.from(output.tailBytesBase64, "base64") : Buffer.from(output.tail);
  return Object.freeze({ stream: output.stream, totalBytes: output.totalBytes, tail: new Uint8Array(bytes.subarray(Math.max(0, bytes.byteLength - output.totalBytes))),
    lossyBytes: output.lossyBytes, lossReasons: Object.freeze([]),
    ...(output.spillArtifactId ? { spill: Object.freeze({ artifactId: output.spillArtifactId, bytes: output.spillBytes }) } : {}) });
}

export async function clientStreamText(stream: ManagedOutputStreamEvidence, render: "raw" | "summary", processId: string | undefined, retention: Pick<ProcessRunSupport, "readArtifact">, readTool = "process_read_output"): Promise<string> {
  if (render === "raw") return Buffer.from(stream.tail).toString("utf8");
  // A summary starts where the output really starts, not where the retained tail happens to.
  const regions = await retainedRegions(stream, retention.readArtifact).catch(() => undefined);
  const whole = regions?.length === 1 && regions[0]!.fromOffset === 0 ? regions[0]!.bytes : undefined;
  const bytes = whole && whole.byteLength <= WHOLE_SUMMARY_MAX_BYTES ? whole : stream.tail;
  const missing = stream.totalBytes - bytes.byteLength;
  // Its numbers are the ones search and lines use. Counting lines is cheap where rendering them is not, and past a gap nobody knows them.
  const firstLine = missing === 0 ? 1 : whole ? 1 + await newlinesIn(whole.subarray(0, missing)) : null;
  const text = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("utf8");
  const summary = summarizeOutput(renderPlainLines(text), { maxBytes: SUMMARY_BYTES, headLines: SUMMARY_HEAD_LINES, tailLines: SUMMARY_TAIL_LINES, firstLine,
    ...(processId ? { omittedHint: `find them with ${readTool} {processId: "${processId}", search: {pattern}} or read them with lines: {start, count}` } : {}) });
  const shown = summary.summarized ? summary.text : renderPlainCompact(text);
  return missing > 0 ? `… (first ${missing} bytes not shown) …\n${shown}` : shown;
}

/** A command line in command (see command-line.ts) becomes the shell script it is, so every later step sees a shell launch. */
function asShellLine(input: ProcessInput): ProcessInput {
  if (input.command === undefined) return input;
  const shell = commandLineShell(input.command, input.args);
  if (!shell) return input;
  const { command, args: _args, ...rest } = input;
  return { ...rest, shell, script: command.trim() };
}

function commandInvocation(input: ProcessInput): {
  command: string;
  args: string[];
} {
  if (input.command) return { command: input.command, args: input.args ?? [] };
  if (!input.shell || input.script === undefined) throw new Error("Invalid process invocation.");
  return shellInvocation(input.shell, input.script);
}

function processError(code: string, message: string): ToolExecutionOutput {
  return {
    content: [{ type: "text", text: message }],
    isError: true,
    error: { code, message },
  };
}
