import { Script, createContext } from "node:vm";

import { PATTERN_WALL_CEILING_MS, runPatternWithCpuBudget } from "./pattern-cpu-budget.js";
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

/**
 * CPU-time bound on one pattern evaluation (pattern-cpu-budget.ts), never wall-clock time. Measured on a full 4 KiB
 * tail: ordinary patterns use 0-0.4 ms of CPU (Windows 16 CPUs and a 2-CPU Linux container, idle and with 2x and 4x
 * as many busy processes as CPUs); an earlier note recorded up to ~11 ms. 50 ms is about 4x that and three Windows
 * CPU-clock ticks (15.6 ms), while `a*a*!` uses 120 ms on 512 characters and seconds on 4 KiB.
 */
export const MANAGED_PATTERN_EVAL_CPU_BUDGET_MS = 50;
// One reusable context: V8 interrupts a backtracking RegExp only at a vm timeout, which no static
// guard can promise (two adjacent quantifiers already cost seconds on a 4 KiB tail).
const patternContext = createContext({ re: /(?:)/u, s: "" });
const patternScript = new Script("re.exec(s)");

/**
 * Assumes validateOutputPattern passed. Only the bounded tail is ever searched, and never with more than
 * MANAGED_PATTERN_EVAL_CPU_BUDGET_MS of CPU time: an over-budget pattern fails the wait with invalid_arguments
 * instead of stalling the Runner's event loop. A busy host that only delays the evaluation never fails it.
 */
export function matchOutputPattern(pattern: string, flags: "i" | undefined, plainTail: string): string | undefined {
  patternContext.re = new RegExp(pattern, flags === "i" ? "iu" : "u");
  patternContext.s = utf8Tail(plainTail, MANAGED_PATTERN_TAIL_BYTES);
  let evaluation;
  try { evaluation = runPatternWithCpuBudget<RegExpExecArray | null>(patternScript, patternContext, MANAGED_PATTERN_EVAL_CPU_BUDGET_MS); }
  finally { patternContext.s = ""; }
  if (!evaluation.ok) throw invalid(evaluation.reason === "cpu"
    ? `until.pattern used more than its ${MANAGED_PATTERN_EVAL_CPU_BUDGET_MS} ms CPU evaluation bound; use a simpler pattern.`
    : `until.pattern could not be evaluated within ${PATTERN_WALL_CEILING_MS} ms on this busy host.`);
  const match = evaluation.value;
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

const CONTROL_CHARACTER = /[\x00-\x08\x0b-\x1f\x7f]/;

/** renderPlain, line for line: nothing is folded and every newline stays, so a line keeps its number. */
export function renderPlainLines(text: string): string {
  const unified = text.replace(/\r\n/g, "\n");
  if (!CONTROL_CHARACTER.test(unified)) return unified;
  return unified
    // Unlike renderPlain, an unterminated OSC ends at its line.
    .replace(/\x1b\][^\x07\x1b\n]{0,4096}(?:\x07|\x1b\\)?/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b[ -/]*[0-~]/g, "")
    .replace(/\x1b/g, "")
    .split("\n").map(renderLine).join("\n");
}

/** renderPlain, unless its fold marks would make short repeated lines longer than they are. */
export function renderPlainCompact(text: string): string {
  const folded = renderPlain(text), whole = renderPlainLines(text);
  return Buffer.byteLength(folded) <= Buffer.byteLength(whole) ? folded : whole;
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

export interface ManagedOutputSummaryOptions {
  /** Output up to this size comes back whole, and a larger summary stays near it. Default: 8 KiB, and only line counts bound the summary. */
  readonly maxBytes?: number;
  readonly headLines?: number;
  readonly tailLines?: number;
  /** How to get at what was left out; it goes in the marker. Default: run something narrower. */
  readonly omittedHint?: string;
  /** The number of the first line. Default 0. null: it is not known, so lines carry no number. */
  readonly firstLine?: number | null;
}

/** Large output: head + tail + diagnostics found in the omitted middle, with absolute line numbers. */
export function summarizeOutput(plain: string, options: ManagedOutputSummaryOptions = {}): ManagedOutputSummary {
  const lines = splitLines(plain);
  if (Buffer.byteLength(plain) <= (options.maxBytes ?? SUMMARY_THRESHOLD_BYTES)) return Object.freeze({ text: plain, summarized: false, totalLines: lines.length, errorLines: Object.freeze([]) });
  const trailing = plain.endsWith("\n") ? "\n" : "";
  const share = (fraction: number) => options.maxBytes === undefined ? Number.POSITIVE_INFINITY : options.maxBytes * fraction;
  const head = linesWithin(lines.length, (n) => lines[n]!, options.headLines ?? SUMMARY_HEAD_LINES, share(1 / 3));
  const tail = linesWithin(lines.length - head, (n) => lines[lines.length - 1 - n]!, options.tailLines ?? SUMMARY_TAIL_LINES, share(1 / 2));
  const middleEnd = lines.length - tail;
  const errorLines: { line: number; text: string }[] = [];
  let diagnosticBytes = 0;
  for (let n = head; n < middleEnd && errorLines.length < SUMMARY_MAX_DIAGNOSTICS; n++) {
    const line = lines[n]!;
    if (!FILE_LOCATION.test(line) && !FAILURE_WORD.test(line)) continue;
    diagnosticBytes += Buffer.byteLength(clip(line)) + 8;
    if (diagnosticBytes > share(1 / 6)) break;
    errorLines.push(Object.freeze({ line: n + (options.firstLine ?? 0), text: clip(line) }));
  }
  const shownHead = lines.slice(0, head), shownTail = lines.slice(middleEnd);
  const hint = options.omittedHint ?? "run a narrower command, or send the output to a file, to see them";
  const clipped = options.omittedHint !== undefined && [...shownHead, ...shownTail].some((line) => line.length > SUMMARY_MAX_LINE_CHARS);
  // A client's text arrives unfolded, so that its lines keep their numbers; Build's was folded by renderPlain.
  // Folding comes before clipping: lines that differ only past the clip are not identical.
  const fold = (shown: readonly string[]): readonly string[] => options.maxBytes === undefined ? shown : foldRepeats(shown);
  const parts = [
    ...fold(shownHead).map(clip),
    ...(middleEnd > head ? [`… (${middleEnd - head} lines omitted; ${hint}) …`] : []),
    ...(errorLines.length ? ["Diagnostics from omitted lines:", ...errorLines.map((entry) => options.firstLine === null ? entry.text : `L${entry.line}: ${entry.text}`)] : []),
    ...fold(shownTail).map(clip),
    ...(clipped && middleEnd <= head ? [`… (long lines clipped; ${hint}) …`] : []),
  ];
  return Object.freeze({ text: parts.join("\n") + trailing, summarized: true, totalLines: lines.length, errorLines: Object.freeze(errorLines) });
}

/** How many lines, taken in order, fit the count and the budget. At least one, if there is one. */
function linesWithin(available: number, lineAt: (index: number) => string, limit: number, budget: number): number {
  let bytes = 0, count = 0;
  while (count < available && count < limit) {
    bytes += Buffer.byteLength(clip(lineAt(count))) + 1;
    if (bytes > budget && count > 0) break;
    count += 1;
  }
  return count;
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

/**
 * Tool-response status only, never persisted: a proven exit the Runner did not cause reads "exited",
 * matching completion { source: "exited", confidence: "certain" }. An unproven one stays "exited_unknown".
 */
export function reportedStatus(snapshot: Readonly<{ status: string; exitCode: number | null; signal: string | null }>): string {
  return snapshot.status === "exited_unknown" && exitProven(snapshot) ? "exited" : snapshot.status;
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
