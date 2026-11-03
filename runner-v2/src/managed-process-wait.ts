import { Script, createContext } from "node:vm";
import {
  MANAGED_INPUT_WAIT_CPU_FRACTION,
  MANAGED_PATTERN_MAX_CHARS,
  MANAGED_PATTERN_TAIL_BYTES,
  MANAGED_UNTIL_IDLE_DEFAULT_MS,
  MANAGED_UNTIL_IDLE_MAX_MS,
  MANAGED_UNTIL_IDLE_MIN_MS,
  ManagedProcessError,
  type ManagedInteractionState,
  type ManagedOutputCompletion,
  type ManagedOutputUntil,
} from "./managed-process-contracts.js";

/**
 * T1 pure wait/view rules for managed process output. No I/O, timers or process access: the
 * service supplies observed facts (quiet time, CPU delta, port probe, stdin-read observation) and
 * these functions decide whether a wait is satisfied and how output is shown to a model.
 * Completion is always labeled with its evidence; a heuristic can end a wait, never claim success.
 */

const UNTIL_KEYS = new Set(["exit", "pattern", "patternFlags", "port", "idleMs"]);

export function validateUntil(value: unknown): ManagedOutputUntil {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid("until must be an object.");
  const input = value as Record<string, unknown>;
  for (const key of Object.keys(input)) if (!UNTIL_KEYS.has(key)) throw invalid(`until.${key} is not allowed.`);
  if (input.exit !== undefined && input.exit !== true) throw invalid("until.exit must be true when present.");
  if (input.exit === true && Object.keys(input).length > 1) throw invalid("until.exit waits only for exit; it cannot be combined with other conditions.");
  if (input.pattern !== undefined) {
    if (typeof input.pattern !== "string") throw invalid("until.pattern must be a string.");
    const checked = validateOutputPattern(input.pattern);
    if (!checked.ok) throw invalid(`until.pattern is not allowed: ${checked.issue}`);
  }
  if (input.patternFlags !== undefined && (input.patternFlags !== "i" || input.pattern === undefined)) throw invalid("until.patternFlags must be \"i\" and needs until.pattern.");
  if (input.port !== undefined && (!Number.isSafeInteger(input.port) || (input.port as number) < 1 || (input.port as number) > 65_535)) throw invalid("until.port must be an integer 1..65535.");
  if (input.idleMs !== undefined && (!Number.isSafeInteger(input.idleMs) || (input.idleMs as number) < MANAGED_UNTIL_IDLE_MIN_MS || (input.idleMs as number) > MANAGED_UNTIL_IDLE_MAX_MS))
    throw invalid(`until.idleMs must be an integer ${MANAGED_UNTIL_IDLE_MIN_MS}..${MANAGED_UNTIL_IDLE_MAX_MS}.`);
  if (!Object.keys(input).length) return Object.freeze({ idleMs: MANAGED_UNTIL_IDLE_DEFAULT_MS });
  return Object.freeze({
    ...(input.exit === true ? { exit: true as const } : {}),
    ...(input.pattern !== undefined ? { pattern: input.pattern as string } : {}),
    ...(input.patternFlags !== undefined ? { patternFlags: "i" as const } : {}),
    ...(input.port !== undefined ? { port: input.port as number } : {}),
    ...(input.idleMs !== undefined ? { idleMs: input.idleMs as number } : {}),
  });
}

interface GroupFrame { quantified: boolean; alternation: boolean }

/**
 * Static ReDoS screen, decided before any RegExp touches output: no backreferences, no lookaround, and no
 * quantified group that itself contains a quantifier or an alternation. It is not a guarantee
 * (`a*a*!` passes and is polynomial); matchOutputPattern's evaluation time bound is.
 */
export function validateOutputPattern(pattern: string): { ok: true } | { ok: false; issue: string } {
  if (typeof pattern !== "string" || !pattern.length) return { ok: false, issue: "pattern is empty" };
  if (pattern.length > MANAGED_PATTERN_MAX_CHARS) return { ok: false, issue: `pattern exceeds ${MANAGED_PATTERN_MAX_CHARS} characters` };
  const stack: GroupFrame[] = [];
  let inClass = false, closedGroup: GroupFrame | undefined, afterQuantifier = false;
  const markQuantified = () => { const top = stack[stack.length - 1]; if (top) top.quantified = true; };
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]!;
    if (c === "\\") {
      const next = pattern[i + 1];
      if (!inClass && next !== undefined && /[1-9]/.test(next)) return { ok: false, issue: "backreferences are not supported" };
      if (!inClass && next === "k" && pattern[i + 2] === "<") return { ok: false, issue: "backreferences are not supported" };
      i++; closedGroup = undefined; afterQuantifier = false; continue;
    }
    if (inClass) { if (c === "]") inClass = false; continue; }
    if (c === "[") { inClass = true; closedGroup = undefined; afterQuantifier = false; continue; }
    if (c === "(") {
      if (/^\(\?(?:<=|<!|=|!)/.test(pattern.slice(i, i + 4))) return { ok: false, issue: "lookaround is not supported" };
      stack.push({ quantified: false, alternation: false }); closedGroup = undefined; afterQuantifier = false; continue;
    }
    if (c === ")") {
      const frame = stack.pop();
      if (!frame) return { ok: false, issue: "pattern does not compile" };
      const parent = stack[stack.length - 1];
      if (parent) { parent.quantified ||= frame.quantified; parent.alternation ||= frame.alternation; }
      closedGroup = frame; afterQuantifier = false; continue;
    }
    if (c === "|") { const top = stack[stack.length - 1]; if (top) top.alternation = true; closedGroup = undefined; afterQuantifier = false; continue; }
    const counted = c === "{" ? /^\{\d+(?:,\d*)?\}/.exec(pattern.slice(i)) : null;
    if (c === "*" || c === "+" || c === "?" || counted) {
      if (c === "?" && afterQuantifier) { afterQuantifier = false; continue; } // lazy modifier
      if (closedGroup && (closedGroup.quantified || closedGroup.alternation)) return { ok: false, issue: "nested quantifiers or quantified alternation are not supported" };
      markQuantified();
      if (counted) i += counted[0].length - 1;
      closedGroup = undefined; afterQuantifier = true; continue;
    }
    closedGroup = undefined; afterQuantifier = false;
  }
  try { new RegExp(pattern, "u"); }
  catch { return { ok: false, issue: "pattern does not compile" }; }
  return { ok: true };
}

/** Hard bound on one pattern evaluation. Ordinary patterns take ≤ ~11 ms on a full 4 KiB tail. */
export const MANAGED_PATTERN_EVAL_TIMEOUT_MS = 50;
// One reusable context: V8 interrupts a backtracking RegExp at the vm timeout, which no static
// guard can promise (two adjacent quantifiers already cost seconds on a 4 KiB tail).
const patternContext = createContext({ re: /(?:)/u, s: "" });
const patternScript = new Script("re.exec(s)");

/**
 * Assumes validateOutputPattern passed. Only the bounded tail is ever searched, and never for longer
 * than MANAGED_PATTERN_EVAL_TIMEOUT_MS: an over-budget pattern fails the wait with invalid_arguments
 * instead of stalling the Runner's event loop.
 */
export function matchOutputPattern(pattern: string, flags: "i" | undefined, plainTail: string): string | undefined {
  patternContext.re = new RegExp(pattern, flags === "i" ? "iu" : "u");
  patternContext.s = utf8Tail(plainTail, MANAGED_PATTERN_TAIL_BYTES);
  let match: RegExpExecArray | null;
  try { match = patternScript.runInContext(patternContext, { timeout: MANAGED_PATTERN_EVAL_TIMEOUT_MS }) as RegExpExecArray | null; }
  catch (error) {
    if ((error as { code?: string }).code === "ERR_SCRIPT_EXECUTION_TIMEOUT")
      throw invalid(`until.pattern exceeded its ${MANAGED_PATTERN_EVAL_TIMEOUT_MS} ms evaluation bound; use a simpler pattern.`);
    throw error;
  } finally { patternContext.s = ""; }
  return match ? match[0].slice(0, 200) : undefined;
}

/** What a terminal would leave on screen for pipe output: no escapes, progress collapsed, repeats folded. */
export function renderPlain(text: string): string {
  const stripped = text
    // OSC body bounded and ESC-free so an unterminated `ESC ]` can't make this quadratic.
    .replace(/\x1b\][^\x07\x1b]{0,4096}(?:\x07|\x1b\\)?/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b[ -/]*[0-~]/g, "")
    .replace(/\x1b/g, "")
    .replace(/\r\n/g, "\n");
  const trailing = stripped.endsWith("\n");
  const lines = (trailing ? stripped.slice(0, -1) : stripped).split("\n").map(renderLine);
  if (!stripped.length) return "";
  return foldRepeats(lines).join("\n") + (trailing ? "\n" : "");
}

function renderLine(line: string): string {
  // A carriage return rewinds the line: keep the last segment that wrote something.
  const segments = line.split("\r");
  let current = segments[segments.length - 1]!;
  for (let k = segments.length - 1; k >= 0 && !current.length; k--) current = segments[k]!;
  const chars: string[] = [];
  for (const ch of current) { if (ch === "\b") chars.pop(); else chars.push(ch); }
  return chars.join("").replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");
}

function foldRepeats(lines: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < lines.length;) {
    let j = i + 1;
    while (j < lines.length && lines[j] === lines[i]) j++;
    const run = j - i;
    if (run > 3) out.push(lines[i]!, `… (${run - 1} more identical lines)`);
    else for (let k = i; k < j; k++) out.push(lines[k]!);
    i = j;
  }
  return out;
}

export interface ManagedLineSlice {
  readonly lines: readonly string[];
  readonly startLine: number;
  readonly totalLines: number;
  readonly firstRetainedLine: number;
  readonly hasMore: boolean;
}

/** Absolute 0-based line window over retained plain text; negative start counts from the end. */
export function sliceLines(plain: string, request: Readonly<{ start: number; count: number }>, firstRetainedLine = 0): ManagedLineSlice {
  if (!Number.isSafeInteger(request.start)) throw invalid("lines.start must be an integer.");
  if (!Number.isSafeInteger(request.count) || request.count < 1 || request.count > 2000) throw invalid("lines.count must be an integer 1..2000.");
  if (!Number.isSafeInteger(firstRetainedLine) || firstRetainedLine < 0) throw invalid("firstRetainedLine must be a non-negative integer.");
  const retained = splitLines(plain);
  const totalLines = firstRetainedLine + retained.length;
  const wanted = request.start < 0 ? totalLines + request.start : request.start;
  const startLine = Math.min(Math.max(wanted, firstRetainedLine), totalLines);
  const lines = retained.slice(startLine - firstRetainedLine, startLine - firstRetainedLine + request.count);
  return Object.freeze({ lines: Object.freeze(lines), startLine, totalLines, firstRetainedLine, hasMore: startLine + lines.length < totalLines });
}

const SUMMARY_THRESHOLD_BYTES = 8 * 1024;
const SUMMARY_HEAD_LINES = 40;
const SUMMARY_TAIL_LINES = 80;
const SUMMARY_MAX_DIAGNOSTICS = 30;
const SUMMARY_MAX_LINE_CHARS = 300;
/** file:line[:col] or file(line,col), with an optional Windows drive prefix. */
const FILE_LOCATION = /(?:^|[\s(])(?:[A-Za-z]:)?[\w./\\-]+\.[A-Za-z0-9]{1,8}[:(]\d+(?:[:,]\d+)?\)?/;
const FAILURE_WORD = /\b(?:error|failed|fatal|exception|traceback)\b/i;

export interface ManagedOutputSummary {
  readonly text: string;
  readonly summarized: boolean;
  readonly totalLines: number;
  readonly errorLines: ReadonlyArray<Readonly<{ line: number; text: string }>>;
}

/** Large output: head + tail + diagnostics found in the omitted middle, with absolute line numbers. */
export function summarizeOutput(plain: string): ManagedOutputSummary {
  const lines = splitLines(plain);
  if (Buffer.byteLength(plain) <= SUMMARY_THRESHOLD_BYTES) return Object.freeze({ text: plain, summarized: false, totalLines: lines.length, errorLines: Object.freeze([]) });
  const trailing = plain.endsWith("\n") ? "\n" : "";
  if (lines.length <= SUMMARY_HEAD_LINES + SUMMARY_TAIL_LINES)
    return Object.freeze({ text: lines.map(clip).join("\n") + trailing, summarized: true, totalLines: lines.length, errorLines: Object.freeze([]) });
  const middleEnd = lines.length - SUMMARY_TAIL_LINES;
  const errorLines: { line: number; text: string }[] = [];
  for (let n = SUMMARY_HEAD_LINES; n < middleEnd && errorLines.length < SUMMARY_MAX_DIAGNOSTICS; n++) {
    const line = lines[n]!;
    if (FILE_LOCATION.test(line) || FAILURE_WORD.test(line)) errorLines.push(Object.freeze({ line: n, text: clip(line) }));
  }
  const parts = [
    ...lines.slice(0, SUMMARY_HEAD_LINES).map(clip),
    `… (${middleEnd - SUMMARY_HEAD_LINES} lines omitted; read the full output by cursor or lines) …`,
    ...(errorLines.length ? ["Diagnostics from omitted lines:", ...errorLines.map((entry) => `L${entry.line}: ${entry.text}`)] : []),
    ...lines.slice(middleEnd).map(clip),
  ];
  return Object.freeze({ text: parts.join("\n") + trailing, summarized: true, totalLines: lines.length, errorLines: Object.freeze(errorLines) });
}

/**
 * Same public prompt list as Desktop Commander's src/utils/process-detection.ts, used here only
 * as a labeled heuristic. `$ `, `# `, `% ` and `> ` match only as the whole line, so output such
 * as "progress 45% " is never mistaken for a shell prompt.
 */
const WHOLE_LINE_PROMPTS = new Set([">>> ", "... ", "> ", "$ ", "# ", "% ", "julia> ", "mysql> ", "    -> ", "redis> ", ">> "]);
const LINE_END_PROMPTS = [">>> ", "julia> ", "mysql> ", "redis> "];
const PROMPT_PATTERNS = [
  /^In \[\d+\]: $/, // IPython
  /^\w[\w-]*[=-][#>] $/, // psql: db=# db=> db-#
  /^PS [^<>|\n]*[\\/:][^<>|\n]*>>? $/, // PowerShell
  /^[A-Za-z]:\\[^<>|"*?\n]*>$/, // cmd.exe
];

export function matchKnownPrompt(lastLine: string): string | undefined {
  const line = lastLine.endsWith("\n") ? lastLine.slice(0, -1) : lastLine;
  if (WHOLE_LINE_PROMPTS.has(line)) return line;
  const suffix = LINE_END_PROMPTS.find((prompt) => line.endsWith(prompt));
  if (suffix) return suffix;
  return PROMPT_PATTERNS.some((pattern) => pattern.test(line)) ? line : undefined;
}

export interface ManagedCompletionFacts {
  /** undefined = legacy mode: any new byte satisfies the wait. */
  readonly until: ManagedOutputUntil | undefined;
  readonly running: boolean;
  /** When not running: exit is proven (released session, or an observed exit code or signal). */
  readonly exitProven: boolean;
  /** Bytes received on any stream since the wait began. */
  readonly newBytes: number;
  /** Milliseconds since the last byte on any stream (or since the wait began). */
  readonly quietMs: number;
  /** Tree CPU consumed during the quiet window; undefined = no CPU evidence. */
  readonly cpuDeltaMs?: number;
  readonly tailEndsWithNewline: boolean;
  /** renderPlain of output since the wait began (the caller bounds it). */
  readonly plainNewTail: string;
  /** Last line of the plain retained tail, without its newline. */
  readonly lastLine: string;
  readonly portOpen?: boolean;
  readonly preexistingPort?: boolean;
  /** Linux only: a tree member is blocked reading the owned stdin pipe. */
  readonly stdinReadObserved?: boolean;
}

/** First satisfied rule wins; undefined means keep waiting. */
export function evaluateCompletion(facts: ManagedCompletionFacts): ManagedOutputCompletion | undefined {
  const { until } = facts;
  if (!facts.running) return terminalCompletion(facts.exitProven);
  if (until === undefined) return facts.newBytes > 0 ? Object.freeze({ source: "changed", confidence: null }) : undefined;
  if (until.exit) return undefined;
  if (until.pattern !== undefined) {
    const matched = matchOutputPattern(until.pattern, until.patternFlags, facts.plainNewTail);
    if (matched !== undefined) return Object.freeze({ source: "pattern", confidence: "certain", matched });
  }
  if (until.port !== undefined && facts.portOpen)
    return Object.freeze(facts.preexistingPort ? { source: "port", confidence: "heuristic", preexistingPort: true } : { source: "port", confidence: "certain" });
  if (until.idleMs === undefined) return undefined;
  const cpu = facts.cpuDeltaMs !== undefined ? { cpuDeltaMs: facts.cpuDeltaMs } : {};
  if (facts.quietMs >= until.idleMs) {
    if (facts.stdinReadObserved === true) return Object.freeze({ source: "input_wait", confidence: "certain", quietMs: facts.quietMs, ...cpu });
    if (facts.cpuDeltaMs !== undefined) {
      if (facts.cpuDeltaMs > MANAGED_INPUT_WAIT_CPU_FRACTION * facts.quietMs) return undefined; // busy, not waiting
      if (!facts.tailEndsWithNewline) return Object.freeze({ source: "input_wait", confidence: "likely", quietMs: facts.quietMs, ...cpu });
    }
    const matched = matchKnownPrompt(facts.lastLine);
    if (matched !== undefined) return Object.freeze({ source: "known_prompt", confidence: "heuristic", matched, quietMs: facts.quietMs, ...cpu });
    return Object.freeze({ source: "idle", confidence: "heuristic", quietMs: facts.quietMs, ...cpu });
  }
  if (facts.quietMs >= until.idleMs / 2 && facts.cpuDeltaMs === undefined) {
    const matched = matchKnownPrompt(facts.lastLine);
    if (matched !== undefined) return Object.freeze({ source: "known_prompt", confidence: "heuristic", matched, quietMs: facts.quietMs });
  }
  return undefined;
}

export function timeoutCompletion(): ManagedOutputCompletion {
  return Object.freeze({ source: "timeout", confidence: null });
}

/** Exit is certain only for a released session or an observed exit code or signal. */
export function exitProven(snapshot: Readonly<{ status: string; exitCode: number | null; signal: string | null }>): boolean {
  return snapshot.status === "stopped" || snapshot.exitCode !== null || snapshot.signal !== null;
}

export function terminalCompletion(proven: boolean): ManagedOutputCompletion {
  return proven ? Object.freeze({ source: "exited", confidence: "certain" }) : Object.freeze({ source: "unavailable", confidence: null });
}

export function interactionState(completion: ManagedOutputCompletion | undefined, running: boolean): ManagedInteractionState {
  if (!running) return completion?.source === "unavailable" ? "unknown" : "exited";
  if (completion?.source === "input_wait" || completion?.source === "known_prompt") return "awaiting_input";
  return completion?.source === "idle" ? "idle" : "running";
}

function splitLines(plain: string): string[] {
  if (!plain.length) return [];
  return (plain.endsWith("\n") ? plain.slice(0, -1) : plain).split("\n");
}
function clip(line: string): string {
  return line.length > SUMMARY_MAX_LINE_CHARS ? `${line.slice(0, SUMMARY_MAX_LINE_CHARS)}…` : line;
}
function utf8Tail(text: string, maxBytes: number): string {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= maxBytes) return text;
  let start = bytes.length - maxBytes;
  while (start < bytes.length && (bytes[start]! & 0xc0) === 0x80) start++;
  return bytes.subarray(start).toString("utf8");
}
function invalid(message: string): ManagedProcessError {
  return new ManagedProcessError("invalid_arguments", message);
}
