/**
 * OpenAI's shell tool with a local environment (Responses only) for Build with GPT models, in place of process.run.
 * Docs: developers.openai.com/api/docs/guides/tools-shell (read 2026-11-11). The model sends shell_call
 * {call_id, action: {commands[], timeout_ms, max_output_length}}; the client runs each command and answers with one
 * shell_call_output {call_id, max_output_length, output: [{stdout, stderr, outcome: {type: "exit", exit_code} |
 * {type: "timeout"}}]}, one entry per command, keeping failed and timed-out commands' output so the model can recover.
 *
 * The docs' executors run each command in a fresh `sh -c` and never keep a directory or variables, so each command is
 * its own process.run with shell bash, in order (process.run is not read-only, so the loop never runs two at once):
 * the same allowlist, grant, Job and large-output handling as any other process.run. A kept shell would change what a
 * `cd` means to a model trained without one.
 */
import type { ToolCallBlock, ToolContentBlock, ToolResult } from "./agent-contracts.js";

export const SHELL_NAME = "shell";
export const SHELL_WIRE: Readonly<Record<string, unknown>> = Object.freeze({ type: "shell", environment: Object.freeze({ type: "local" }) });
export const SHELL_REPLACES: readonly string[] = Object.freeze(["process.run"]);
const PART_SEPARATOR = "::shell::";

/**
 * The GPT-6 family, whose model pages list the shell tool (as hosted_shell; the local environment is the same tool).
 * gpt-5.1's page lists apply_patch but no shell.
 */
export function supportsOpenAIShell(modelId: string): boolean {
  return /^gpt-6(\.|-|$)/u.test(modelId);
}

export interface ShellAction {
  commands: string[];
  timeout_ms?: number;
  max_output_length?: number;
}

export function parseShellAction(action: unknown): ShellAction | { error: string } {
  if (!isRecord(action) || !Array.isArray(action.commands) || action.commands.length === 0) {
    return { error: "action.commands must be a non-empty array of command strings." };
  }
  if (action.commands.some((command) => typeof command !== "string" || command.trim() === "")) {
    return { error: "Every entry of action.commands must be a non-empty command string." };
  }
  const positive = (value: unknown) => typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
  const timeout = positive(action.timeout_ms);
  const max = positive(action.max_output_length);
  return {
    commands: action.commands as string[],
    ...(timeout ? { timeout_ms: timeout } : {}),
    ...(max ? { max_output_length: max } : {}),
  };
}

export function shellPartId(callId: string, part: number): string {
  return `${callId}${PART_SEPARATOR}${part}`;
}

export function shellCallId(partId: string): string | undefined {
  const at = partId.lastIndexOf(PART_SEPARATOR);
  return at > 0 && /^\d+$/u.test(partId.slice(at + PART_SEPARATOR.length)) ? partId.slice(0, at) : undefined;
}

/**
 * One process.run per command, each carrying the original call so it is sent back once and its results merged.
 * An action shell cannot run becomes one call to the unregistered name shell: nothing runs, and the output says why.
 */
export function shellCallBlocks(callId: string, action: unknown): ToolCallBlock[] {
  const input = JSON.stringify(action ?? {});
  const parsed = parseShellAction(action);
  if ("error" in parsed) {
    return [{
      type: "tool_call", callId: shellPartId(callId, 1), name: SHELL_NAME, arguments: isRecord(action) ? action : {},
      nativeCall: { callId, name: SHELL_NAME, input, part: 1, parts: 1 },
    }];
  }
  return parsed.commands.map((command, index) => ({
    type: "tool_call" as const,
    callId: shellPartId(callId, index + 1),
    name: "process.run",
    arguments: { shell: "bash", script: command, ...(parsed.timeout_ms ? { timeoutMs: parsed.timeout_ms } : {}) },
    nativeCall: { callId, name: SHELL_NAME, input, part: index + 1, parts: parsed.commands.length },
  }));
}

/** The shell_call to send back in input: the action as the model sent it. */
export function shellCallItem(callId: string, nativeInput: string): Record<string, unknown> {
  let action: unknown;
  try { action = JSON.parse(nativeInput); } catch { action = {}; }
  return { type: "shell_call", call_id: callId, action, status: "completed" };
}

export interface ShellOutputEntry {
  stdout: string;
  stderr: string;
  outcome: { type: "exit"; exit_code: number } | { type: "timeout" };
}

/** The shell_call_output for a call, from its commands' process.run results in order. */
export function shellCallOutput(callId: string, nativeInput: string, results: readonly ToolResult[]): Record<string, unknown> {
  let action: unknown;
  try { action = JSON.parse(nativeInput); } catch { action = undefined; }
  const parsed = parseShellAction(action);
  const max = "error" in parsed ? undefined : parsed.max_output_length;
  const output = "error" in parsed
    ? [{ stdout: "", stderr: `Error: ${parsed.error} Nothing was run.`, outcome: { type: "exit", exit_code: 1 } } satisfies ShellOutputEntry]
    : results.map((result) => shellOutputEntry(result, max));
  return { type: "shell_call_output", call_id: callId, ...(max ? { max_output_length: max } : {}), output };
}

export function shellOutputEntry(result: ToolResult, maxOutputLength?: number): ShellOutputEntry {
  const meta = firstJson(result.content);
  const cap = (text: string) => maxOutputLength ? truncateMiddle(text, maxOutputLength) : text;
  const stdout = cap(streamText(result.content, "STDOUT"));
  let stderr = streamText(result.content, "STDERR");
  if (meta.timedOut === true) return { stdout, stderr: cap(stderr), outcome: { type: "timeout" } };
  if (typeof meta.exitCode === "number") return { stdout, stderr: cap(stderr), outcome: { type: "exit", exit_code: meta.exitCode } };
  // It never ran (refused, not approved, failed to launch): the reason goes where a shell would print it.
  const reason = result.error?.message ?? result.content.map((block) => block.type === "text" ? block.text : "").filter(Boolean).join("\n");
  stderr = `${stderr}${stderr && !stderr.endsWith("\n") ? "\n" : ""}AIBoard did not run this command: ${reason || "it failed to start."}`;
  return { stdout, stderr: cap(stderr), outcome: { type: "exit", exit_code: 1 } };
}

/** Keeps the start and the end, where the command and its errors usually are, within the model's limit. */
export function truncateMiddle(text: string, max: number): string {
  if (text.length <= max) return text;
  const marker = `\n…${text.length - max} characters omitted…\n`;
  if (max <= marker.length) return text.slice(text.length - max);
  const keep = max - marker.length;
  const head = Math.ceil(keep / 2);
  return `${text.slice(0, head)}${marker}${text.slice(text.length - (keep - head))}`;
}

/** One stream's text from a process.run result ("STDOUT\n..."), already summarized there when it was large. */
function streamText(content: readonly ToolContentBlock[], name: "STDOUT" | "STDERR"): string {
  const block = content.find((item) => item.type === "text" && item.text.startsWith(`${name}\n`)) as { text: string } | undefined;
  return block ? block.text.slice(name.length + 1) : "";
}

function firstJson(content: readonly ToolContentBlock[]): Record<string, unknown> {
  const block = content.find((item) => item.type === "json") as { value?: unknown } | undefined;
  return isRecord(block?.value) ? block.value : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
