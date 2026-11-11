/**
 * Anthropic's bash tool (`bash_20250124`, named `bash`) for Build with Claude models, in place of process.run. Claude
 * expects one shell that keeps its state, so every command runs as process.run with shell bash in one shell session
 * (shell-session.ts): the same allowlist, grant, Job and output handling as any other process.run. restart ends that
 * shell; the next command starts a new one.
 * Docs: platform.claude.com/docs/en/agents-and-tools/tool-use/bash-tool (read 2026-11-11): input is {command} or
 * {restart: true}; the client owns the timeout and returns the output, or an error result.
 */
import type { ToolCallBlock, ToolContentBlock, ToolResult } from "./agent-contracts.js";
import { bashExecutable, shellMayRun } from "./shell-inventory.js";
import { SESSION_MAX_TIMEOUT_MS } from "./shell-session.js";

export const BASH_NAME = "bash";
export const BASH_WIRE: Readonly<Record<string, unknown>> = Object.freeze({ type: "bash_20250124", name: BASH_NAME });
export const BASH_REPLACES: readonly string[] = Object.freeze(["process.run"]);
/** One shell per agent: the session belongs to the run, the agent's session and its actor. */
export const BASH_SESSION = "claude-bash";

/** Claude 4 and later, which the bash tool's docs cover. */
export function supportsBash(modelId: string): boolean {
  return /^claude-(fable|mythos)-/u.test(modelId) || /^claude-(opus|sonnet|haiku)-(4|5)(-|$)/u.test(modelId);
}

/** Offered only where a bash can run: Git Bash on Windows. */
export function bashAvailable(): boolean {
  return shellMayRun("bash") && bashExecutable() !== undefined;
}

type Mapped = { restart: boolean; arguments: Record<string, unknown> } | { error: string };

export function mapBashInput(input: unknown): Mapped {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return { error: "The input must be {command} or {restart: true}." };
  const value = input as Record<string, unknown>;
  if (value.restart === true) return { restart: true, arguments: { shell: "bash", shellSession: BASH_SESSION, script: "exit 0" } };
  if (typeof value.command !== "string" || value.command.trim() === "") return { error: "command is required: the bash command to run." };
  return { restart: false, arguments: { shell: "bash", shellSession: BASH_SESSION, script: value.command } };
}

/** The bash call as a process.run call; input bash does not take runs nothing (no tool is named bash) and says why. */
export function bashCall(callId: string, input: unknown): ToolCallBlock {
  const mapped = mapBashInput(input);
  return {
    type: "tool_call",
    callId,
    name: "error" in mapped ? BASH_NAME : "process.run",
    arguments: "error" in mapped ? (input ?? {}) : mapped.arguments,
    nativeCall: { callId, name: BASH_NAME, input: JSON.stringify(input ?? {}), part: 1, parts: 1 },
  };
}

/** The result as a terminal shows it: the output, then what Claude needs to know about the exit code and the shell. */
export function bashResult(nativeInput: string, result: ToolResult): { text: string; isError: boolean } {
  let input: unknown;
  try { input = JSON.parse(nativeInput); } catch { input = undefined; }
  const mapped = mapBashInput(input);
  if ("error" in mapped) return { text: `Error: ${mapped.error}`, isError: true };
  const meta = firstJson(result.content);
  const session = isRecord(meta.shellSession) ? meta.shellSession : {};
  if (mapped.restart) {
    return typeof session.ended === "string" ? { text: "The bash shell has been restarted.", isError: false }
      : { text: `Error: the shell did not restart${result.error ? `: ${result.error.message}` : "."}`, isError: true };
  }
  const notes: string[] = [];
  if (session.replaced === true) notes.push("[A new shell started: the previous one had ended, so its variables and directory are gone.]");
  const output = streamText(result.content, "STDOUT") + streamText(result.content, "STDERR");
  if (meta.timedOut === true) {
    notes.push(`[The command ran past ${SESSION_MAX_TIMEOUT_MS / 1000} s and was stopped. ${typeof session.ended === "string" ? "The shell was restarted, so its variables and directory are gone. " : ""}Start longer jobs with process_start.]`);
  } else if (result.isError) {
    return { text: `Error: ${result.error?.message ?? "the command did not run."}`, isError: true };
  } else if (typeof session.ended === "string") {
    notes.push("[The shell exited, so its variables and directory are gone; the next command starts a new one.]");
  }
  if (typeof meta.exitCode === "number" && meta.exitCode !== 0) notes.push(`[exit code ${meta.exitCode}]`);
  const text = [output.replace(/\n$/u, ""), ...notes].filter(Boolean).join("\n");
  return { text: text || "(no output)", isError: meta.timedOut === true };
}

/** One stream's text from a process.run result ("STDOUT\n..."), already summarized there when it was large. */
function streamText(content: readonly ToolContentBlock[], name: "STDOUT" | "STDERR"): string {
  const block = content.find((item) => item.type === "text" && item.text.startsWith(`${name}\n`)) as { text: string } | undefined;
  if (!block) return "";
  const text = block.text.slice(name.length + 1);
  return text.endsWith("\n") ? text : `${text}\n`;
}

function firstJson(content: readonly ToolContentBlock[]): Record<string, unknown> {
  const block = content.find((item) => item.type === "json") as { value?: unknown } | undefined;
  return isRecord(block?.value) ? block.value : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
