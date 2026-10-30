import { realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { Readable } from "node:stream";

export const APPROVAL_TOOLS: ReadonlySet<string> = new Set([
  "process.start", "process.run", "process.write_stdin", "process.signal",
]);

export interface CommandApprovalSummary {
  readonly jobId: string;
  readonly code: string;
  readonly toolName: string;
  readonly executable: string;
  readonly argumentCount: number;
  readonly commandLine: string;
  readonly cwdCategory: "inside launch dir" | "outside" | "not applicable";
}

export interface CommandApprovalRequest {
  readonly summary: CommandApprovalSummary;
  readonly nonce: string;
}

type TtyInput = Readable & {
  readonly isTTY?: boolean;
  readonly isRaw?: boolean;
  setRawMode?: (mode: boolean) => unknown;
};

/** Validate only the admitted process payload, before constructing anything displayed. */
export function commandApprovalSummary(jobId: string, code: string, toolName: string, payload: unknown,
  workspace: string, forceWorkspace = false): CommandApprovalSummary {
  if (!APPROVAL_TOOLS.has(toolName) || !isRecord(payload)) throw new Error("Invalid approval payload.");
  const launch = toolName === "process.start" || toolName === "process.run";
  const allowed = toolName === "process.start" ? ["command", "args", "cwd", "env", "interactive"] :
    toolName === "process.run" ? ["command", "args", "shell", "script", "cwd", "env", "timeoutMs"] :
    toolName === "process.write_stdin" ? ["processId", "writeId", "data", "appendNewline", "closeInput"] :
      ["processId", "signal"];
  if (Object.keys(payload).some((key) => !allowed.includes(key))) throw new Error("Invalid approval payload.");
  let executable = "";
  let args: string[] = [];
  if (launch) {
    const command = typeof payload.command === "string" && payload.command.length > 0;
    const shell = toolName === "process.run" && ["powershell", "cmd", "bash"].includes(String(payload.shell)) && typeof payload.script === "string";
    if (command === shell || (payload.args !== undefined && (!Array.isArray(payload.args) || !payload.args.every((item) => typeof item === "string"))) ||
      (payload.cwd !== undefined && typeof payload.cwd !== "string") ||
      (payload.env !== undefined && (!isRecord(payload.env) || !Object.values(payload.env).every((item) => typeof item === "string"))) ||
      (payload.interactive !== undefined && typeof payload.interactive !== "boolean") ||
      (payload.timeoutMs !== undefined && (!Number.isSafeInteger(payload.timeoutMs) || Number(payload.timeoutMs) < 1)) ||
      (shell && payload.args !== undefined) || (command && (payload.shell !== undefined || payload.script !== undefined))) {
      throw new Error("Invalid approval payload.");
    }
    executable = shell ? String(payload.shell) : String(payload.command);
    args = shell ? [String(payload.script)] : (payload.args as string[] | undefined) ?? [];
  } else if (toolName === "process.write_stdin") {
    if (typeof payload.processId !== "string" || !payload.processId || typeof payload.writeId !== "string" ||
      !/^[A-Za-z0-9._:-]{1,128}$/.test(payload.writeId) ||
      (payload.data !== undefined && typeof payload.data !== "string") ||
      (payload.appendNewline !== undefined && typeof payload.appendNewline !== "boolean") ||
      (payload.closeInput !== undefined && typeof payload.closeInput !== "boolean")) throw new Error("Invalid approval payload.");
  } else if (typeof payload.processId !== "string" || !payload.processId ||
    !["SIGTERM", "SIGINT", "SIGKILL"].includes(String(payload.signal))) {
    throw new Error("Invalid approval payload.");
  }
  const basename = executable.split(/[\\/]/).pop() ?? "";
  let line = "";
  if (launch) {
    for (const part of [basename, ...args]) {
      if (line.length >= 200) break;
      line += (line ? " " : "") + escapeControls(part, 200 - line.length - (line ? 1 : 0));
    }
  }
  return Object.freeze({
    jobId, code, toolName, executable: escapeControls(basename, 200), argumentCount: args.length,
    commandLine: line.slice(0, 200),
    cwdCategory: launch ? cwdCategory(workspace, forceWorkspace ? "." : typeof payload.cwd === "string" ? payload.cwd : ".") : "not applicable",
  });
}

function cwdCategory(workspace: string, cwd: string): "inside launch dir" | "outside" {
  try {
    const root = realpathSync(workspace);
    const target = realpathSync(resolve(workspace, cwd));
    const part = relative(root, target);
    return part === "" || (!isAbsolute(part) && part !== ".." && !part.startsWith(".." + sep)) ? "inside launch dir" : "outside";
  } catch { return "outside"; }
}

function escapeControls(value: string, limit: number): string {
  let output = "";
  for (const character of value) {
    const code = character.codePointAt(0)!;
    const escaped = code < 0x20 || (code >= 0x7f && code <= 0x9f) ||
      code === 0x2028 || code === 0x2029 || (code >= 0x202a && code <= 0x202e) || (code >= 0x2066 && code <= 0x2069)
      ? "\\u" + code.toString(16).padStart(4, "0") : character;
    if (output.length + escaped.length > limit) break;
    output += escaped;
  }
  return output;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Read one local key. A non-TTY, disconnect or abort supplies no decision. */
export async function promptCommandApproval(request: CommandApprovalRequest, input: TtyInput,
  write: (text: string) => void, signal?: AbortSignal, interrupt?: () => void): Promise<boolean | undefined> {
  if (!input.isTTY || !input.setRawMode || signal?.aborted) return undefined;
  const summary = request.summary;
  write("\nRemote command approval " + summary.code + " (job " + summary.jobId + ")\n" +
    "Tool: " + summary.toolName + "\nExecutable: " + (summary.executable || "(not available)") +
    "\nArguments: " + summary.argumentCount + "\nCommand: " + (summary.commandLine || "(not available)") +
    "\nCwd: " + summary.cwdCategory + "\nAllow? [y/N] ");
  return await new Promise<boolean | undefined>((finish) => {
    let done = false;
    const wasRaw = input.isRaw === true;
    const settle = (answer?: boolean) => {
      if (done) return;
      done = true;
      input.off("data", onData); input.off("end", onEnd); input.off("error", onEnd);
      signal?.removeEventListener("abort", onEnd);
      try { input.setRawMode?.(wasRaw); } catch { /* stdin may already have closed */ }
      input.pause();
      write("\n");
      finish(answer);
    };
    const onData = (chunk: Buffer | string) => {
      const key = String(chunk)[0];
      if (key === "\u0003") { settle(); interrupt?.(); }
      else if (key !== undefined) settle(key === "y" || key === "Y");
    };
    const onEnd = () => settle();
    input.once("data", onData); input.once("end", onEnd); input.once("error", onEnd);
    signal?.addEventListener("abort", onEnd, { once: true });
    try { input.setRawMode!(true); input.resume(); } catch { settle(); }
  });
}
