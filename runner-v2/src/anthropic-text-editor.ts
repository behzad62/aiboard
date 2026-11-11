/**
 * Anthropic's text editor tool (`text_editor_20250728`, named `str_replace_based_edit_tool`) for Build
 * with Claude models. Claude is trained on this tool, so a session that can edit is offered it in place
 * of fs.read, fs.write and fs.patch. Each call runs as one of those shared tools: the grant, the fence,
 * revisions and policy paths are exactly what any other caller gets. Only the wire form and the result
 * text are Anthropic's.
 * Docs: platform.claude.com/docs/en/agents-and-tools/tool-use/text-editor-tool (read 2026-11-11).
 */
import type { ToolCallBlock, ToolContentBlock, ToolResult } from "./agent-contracts.js";
import { toolResultText } from "./provider-model-utils.js";

export const TEXT_EDITOR_NAME = "str_replace_based_edit_tool";
export const TEXT_EDITOR_WIRE: Readonly<Record<string, unknown>> = Object.freeze({ type: "text_editor_20250728", name: TEXT_EDITOR_NAME });
/** The generic tools the editor covers; it is offered only when the session has all three. */
export const TEXT_EDITOR_REPLACES: readonly string[] = Object.freeze(["fs.read", "fs.write", "fs.patch"]);

/** The models the docs list for text_editor_20250728: Claude 4.5 and later. */
export function supportsTextEditor(modelId: string): boolean {
  return /^claude-(fable|mythos)-/u.test(modelId) || /^claude-(opus|sonnet|haiku)-(5|4-[5-9])(-|$)/u.test(modelId);
}

type Mapped = { name: string; arguments: Record<string, unknown> } | { error: string };

/**
 * The editor call as a runner tool call. nativeCall keeps the call as Claude wrote it, so the adapter
 * sends it back unchanged and formats its result. Input the editor does not accept runs nothing: it
 * goes out under the editor's own name, which no tool is registered as, and its result says why.
 */
export function textEditorCall(callId: string, input: unknown): ToolCallBlock {
  const mapped = mapEditorInput(input);
  return {
    type: "tool_call",
    callId,
    name: "error" in mapped ? TEXT_EDITOR_NAME : mapped.name,
    arguments: "error" in mapped ? (input ?? {}) : mapped.arguments,
    nativeCall: { callId, name: TEXT_EDITOR_NAME, input: JSON.stringify(input ?? {}), part: 1, parts: 1 },
  };
}

export function mapEditorInput(input: unknown): Mapped {
  if (!isRecord(input)) return { error: "The input must be an object with command and path." };
  const { command, path } = input;
  if (typeof path !== "string" || path.length === 0) return { error: "path is required." };
  switch (command) {
    case "view": {
      if (input.view_range === undefined) return { name: "fs.read", arguments: { path, startLine: 1, endLine: Number.MAX_SAFE_INTEGER } };
      const range = input.view_range;
      if (!Array.isArray(range) || range.length !== 2 || !range.every((n) => Number.isSafeInteger(n))) {
        return { error: "view_range must be two line numbers, [start, end]; end -1 reads to the end of the file." };
      }
      const [start, end] = range as [number, number];
      if (start < 1 || (end !== -1 && end < start)) return { error: `view_range [${start}, ${end}] is not a range: lines start at 1, and end is -1 or at least start.` };
      return { name: "fs.read", arguments: { path, startLine: start, endLine: end === -1 ? Number.MAX_SAFE_INTEGER : end } };
    }
    case "create":
      return typeof input.file_text === "string"
        ? { name: "fs.write", arguments: { path, content: input.file_text } }
        : { error: "create needs file_text." };
    case "str_replace": {
      if (typeof input.old_str !== "string" || input.old_str.length === 0) return { error: "str_replace needs old_str, the exact text to replace." };
      const replacement = input.new_str ?? "";
      if (typeof replacement !== "string") return { error: "new_str must be a string." };
      return { name: "fs.patch", arguments: { path, search: input.old_str, replace: replacement } };
    }
    case "insert": {
      const text = input.insert_text ?? input.new_str;
      if (!Number.isSafeInteger(input.insert_line) || (input.insert_line as number) < 0) return { error: "insert needs insert_line: the line to insert after, 0 for the top of the file." };
      if (typeof text !== "string") return { error: "insert needs insert_text." };
      return { name: "fs.patch", arguments: { path, _insert: { afterLine: input.insert_line, text } } };
    }
    case "undo_edit":
      return { error: "undo_edit is not available in this version of the tool; make the change back with str_replace." };
    default:
      return { error: `Unknown command ${JSON.stringify(command)}; use view, create, str_replace or insert.` };
  }
}

/** The result of an editor call, as the text editor docs show it. */
export function textEditorResult(nativeInput: string, result: ToolResult): { text: string; isError: boolean } {
  let input: unknown;
  try { input = JSON.parse(nativeInput); } catch { input = undefined; }
  const mapped = mapEditorInput(input);
  if ("error" in mapped) return { text: `Error: ${mapped.error}`, isError: true };
  if (result.isError) return { text: `Error: ${result.error?.message ?? (toolResultText({ ...result, isError: false }) || "the edit failed.")}`, isError: true };
  const meta = firstJson(result.content);
  const text = result.content.filter((block) => block.type === "text").map((block) => (block as { text: string }).text).join("\n");
  const path = typeof meta.path === "string" ? meta.path : String((input as Record<string, unknown>).path);
  const command = (input as Record<string, unknown>).command;
  if (command === "view") {
    if (meta.type === "directory") {
      return { text: `Here are the files and directories up to 2 levels deep in ${path}, excluding hidden items:\n${text || "(empty)"}` +
        (meta.truncated ? "\n[The listing was cut short; view a subdirectory to see more.]" : ""), isError: false };
    }
    if (result.content.some((block) => block.type === "artifact")) {
      return { text: `${path} is not a UTF-8 text file (${String(meta.byteLength ?? "?")} bytes), so it cannot be shown as text.`, isError: false };
    }
    return { text: numbered(text, meta), isError: false };
  }
  const done = command === "create" ? `File written: ${path}`
    : command === "insert" ? `Inserted the text after line ${String((input as Record<string, unknown>).insert_line)} of ${path}.`
    : "Successfully replaced text at exactly one location.";
  return { text: [done, ...extras(meta)].join("\n"), isError: false };
}

function numbered(text: string, meta: Record<string, unknown>): string {
  if (text === "") return "The file is empty.";
  const start = typeof meta.startLine === "number" ? meta.startLine : 1;
  const lines = text.replace(/\n$/u, "").split("\n");
  const body = lines.map((line, index) => `${start + index}: ${line}`).join("\n");
  if (typeof meta.nextStartLine !== "number") return body;
  return `${body}\n[Lines ${start}-${String(meta.endLine)} of ${String(meta.totalLines)}: the rest did not fit in one result. View from line ${meta.nextStartLine} to read on.]`;
}

/** What the fs tool added beyond success: notices and diagnostics, which the model needs to see. */
function extras(meta: Record<string, unknown>): string[] {
  const lines: string[] = [];
  if (Array.isArray(meta.notices)) lines.push(...meta.notices.filter((notice): notice is string => typeof notice === "string"));
  if (meta.diagnostics !== undefined) lines.push(`Diagnostics: ${JSON.stringify(meta.diagnostics)}`);
  return lines;
}

function firstJson(content: readonly ToolContentBlock[]): Record<string, unknown> {
  const block = content.find((item) => item.type === "json") as { value?: unknown } | undefined;
  return isRecord(block?.value) ? block.value : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
