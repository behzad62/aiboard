import { setImmediate as nextTurn } from "node:timers/promises";
import { Script, createContext } from "node:vm";
import {
  MANAGED_PATTERN_MAX_CHARS,
  ManagedProcessError,
  type ManagedOutputStreamEvidence,
} from "./managed-process-contracts.js";
import { renderPlainLines, validateOutputPattern } from "./managed-process-wait.js";
import { runPatternWithCpuBudget } from "./pattern-cpu-budget.js";

/**
 * Line search over everything bounded retention kept of a command's output, so a model can find one
 * line of a huge log without reading it and without running the command again. Bytes retention no
 * longer holds are reported as not searched, never as "no match".
 */
export interface ManagedOutputSearchRequest {
  readonly pattern: string;
  /** Default: the pattern is literal text. A regex passes the same safety screen as until.pattern. */
  readonly regex?: boolean;
  /** Default false, as in fs.search. */
  readonly caseSensitive?: boolean;
  readonly contextLines?: number;
  readonly maxMatches?: number;
}

export interface ManagedOutputSearchMatch {
  readonly stream: "stdout" | "stderr";
  /** 1-based. Absent when the bytes before this line are gone, because its number is then unknown. */
  readonly line?: number;
  /** Where the line starts in the stream; process.read_output's range reads from here. */
  readonly byteOffset: number;
  readonly text: string;
  readonly before?: readonly string[];
  readonly after?: readonly string[];
}

export type ManagedOutputSearchTruncation = "max_matches" | "size_limit" | "time_limit";

export interface ManagedOutputSearchResult {
  readonly matches: readonly ManagedOutputSearchMatch[];
  /** Why the search stopped early. max_matches and size_limit mean at least one more match exists. */
  readonly truncated?: ManagedOutputSearchTruncation;
  /** Every byte produced so far was searched, line by whole line, so no match means there is none. */
  readonly exhaustive: boolean;
  readonly notSearched?: ReadonlyArray<Readonly<{ stream: "stdout" | "stderr"; fromOffset: number; toOffset: number }>>;
  /** A line over 1 MiB was searched in pieces, so a match across two pieces could be missed. */
  readonly splitLines?: true;
}

/** Lines of one stream by number, across everything kept of it. */
export interface ManagedOutputLineWindow {
  readonly stream: "stdout" | "stderr";
  readonly lines: readonly string[];
  /** 1-based. Counts from the byte in linesRelativeToByteOffset when the bytes before it are gone. */
  readonly startLine: number;
  readonly totalLines: number;
  /** The start to ask for next, when more follow these. Negative past a retention gap, where only counting from the end reaches them. */
  readonly nextLine?: number;
  readonly linesRelativeToByteOffset?: number;
  /** These lines end where retention lost bytes. A negative start reads what comes after them. */
  readonly gap?: Readonly<{ fromOffset: number; toOffset: number }>;
}

export interface RetainedOutputRegion {
  readonly fromOffset: number;
  readonly bytes: Uint8Array;
}

export type ReadOutputSpill = (artifactId: string) => Promise<Uint8Array>;

export const MANAGED_SEARCH_DEFAULT_MATCHES = 20;
export const MANAGED_SEARCH_MAX_MATCHES = 200;
export const MANAGED_SEARCH_MAX_CONTEXT_LINES = 5;
const MATCH_TEXT_CHARS = 300;
/** Characters kept ahead of a match when its line is too long to show whole. */
const MATCH_LEAD_CHARS = 80;
/** A result that fits a tool's inline output bound, so it is never cut into a preview. */
const RESULT_MAX_BYTES = 6 * 1024;
const CHUNK_BYTES = 1024 * 1024;
/**
 * CPU-time bound on one chunk (pattern-cpu-budget.ts), never wall-clock time. Ordinary patterns used 0-2.5 ms of CPU
 * on a full 1 MiB chunk of build output (Windows and a 2-CPU Linux container); 250 ms is 100x that, while
 * `a*a*a*a*a*a*b` uses 9-15 s of CPU on 64 characters.
 */
const CHUNK_EVALUATION_CPU_BUDGET_MS = 250;
const SEARCH_BUDGET_MS = 10_000;
const LINE_TEXT_CHARS = 2_000;
/** How much of a line to render for each character shown. Terminal control renders to nothing, so it is well above one; a huge line stops here. */
const RENDER_BYTES_PER_CHAR = 16;
const SEARCH_KEYS = new Set(["pattern", "regex", "caseSensitive", "contextLines", "maxMatches"]);

export const MANAGED_OUTPUT_SEARCH_SCHEMA = {
  type: "object",
  description: "Find lines in everything kept of the output, instead of reading it. A pattern sees one line at a time, as in grep. Returns each matching line with its 1-based line number; exhaustive means no match was missed.",
  properties: {
    pattern: { type: "string", minLength: 1, maxLength: MANAGED_PATTERN_MAX_CHARS },
    regex: { type: "boolean", description: "Treat pattern as a regular expression. Default: literal text." },
    caseSensitive: { type: "boolean", description: "Default false." },
    contextLines: { type: "integer", minimum: 0, maximum: MANAGED_SEARCH_MAX_CONTEXT_LINES },
    maxMatches: { type: "integer", minimum: 1, maximum: MANAGED_SEARCH_MAX_MATCHES, description: `Default ${MANAGED_SEARCH_DEFAULT_MATCHES}.` },
  },
  required: ["pattern"],
  additionalProperties: false,
} as const;

export function validateOutputSearch(value: unknown): ManagedOutputSearchRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid("search must be an object.");
  const input = value as Record<string, unknown>;
  for (const key of Object.keys(input)) if (!SEARCH_KEYS.has(key)) throw invalid(`search.${key} is not allowed.`);
  if (typeof input.pattern !== "string" || !input.pattern.length) throw invalid("search.pattern must be a non-empty string.");
  if (input.pattern.length > MANAGED_PATTERN_MAX_CHARS) throw invalid(`search.pattern exceeds ${MANAGED_PATTERN_MAX_CHARS} characters.`);
  // It could never match, and an answer of no match would read as if it had been looked for.
  if (input.pattern.includes("\n") || (input.regex === true && asksForNewline(input.pattern))) throw invalid("search.pattern sees one line at a time, so it cannot ask for a newline.");
  for (const key of ["regex", "caseSensitive"]) if (input[key] !== undefined && typeof input[key] !== "boolean") throw invalid(`search.${key} must be a boolean.`);
  if (input.contextLines !== undefined && !inRange(input.contextLines, 0, MANAGED_SEARCH_MAX_CONTEXT_LINES)) throw invalid(`search.contextLines must be an integer 0..${MANAGED_SEARCH_MAX_CONTEXT_LINES}.`);
  if (input.maxMatches !== undefined && !inRange(input.maxMatches, 1, MANAGED_SEARCH_MAX_MATCHES)) throw invalid(`search.maxMatches must be an integer 1..${MANAGED_SEARCH_MAX_MATCHES}.`);
  if (input.regex === true) {
    const checked = validateOutputPattern(input.pattern);
    if (!checked.ok) throw invalid(`search.pattern is not allowed: ${checked.issue}`);
  }
  return Object.freeze({ pattern: input.pattern,
    ...(input.regex !== undefined ? { regex: input.regex as boolean } : {}),
    ...(input.caseSensitive !== undefined ? { caseSensitive: input.caseSensitive as boolean } : {}),
    ...(input.contextLines !== undefined ? { contextLines: input.contextLines as number } : {}),
    ...(input.maxMatches !== undefined ? { maxMatches: input.maxMatches as number } : {}) });
}

/**
 * The bytes still held of one stream: its finalized prefix and its exact tail, as one region when
 * nothing lies between them. Give readSpill only for finalized evidence.
 */
export async function retainedRegions(value: ManagedOutputStreamEvidence, readSpill?: ReadOutputSpill): Promise<readonly RetainedOutputRegion[]> {
  const tailStart = value.totalBytes - value.tail.byteLength;
  const tail: RetainedOutputRegion = { fromOffset: tailStart, bytes: value.tail };
  if (!value.spill || !readSpill || tailStart === 0) return value.tail.byteLength ? [tail] : [];
  const whole = await readSpill(value.spill.artifactId);
  if (whole.byteLength < value.spill.bytes) throw new ManagedProcessError("process_output_unavailable", "Finalized output spill is shorter than its recorded length.");
  const prefix = whole.subarray(0, value.spill.bytes);
  if (tailStart > prefix.byteLength) return value.tail.byteLength ? [{ fromOffset: 0, bytes: prefix }, tail] : [{ fromOffset: 0, bytes: prefix }];
  const rest = value.tail.subarray(prefix.byteLength - tailStart);
  return [{ fromOffset: 0, bytes: rest.byteLength ? Buffer.concat([prefix, rest]) : prefix }];
}

interface SearchScan {
  readonly matches: ManagedOutputSearchMatch[];
  readonly limit: number;
  readonly contextLines: number;
  readonly deadline: number;
  readonly now: () => number;
  resultBytes: number;
  splitLine: boolean;
}

export async function searchOutput(input: Readonly<{
  streams: readonly ManagedOutputStreamEvidence[];
  request: ManagedOutputSearchRequest;
  readSpill?: ReadOutputSpill;
  now?: () => number;
}>): Promise<ManagedOutputSearchResult> {
  const now = input.now ?? Date.now;
  const expression = searchExpression(input.request);
  const scan: SearchScan = { matches: [], limit: input.request.maxMatches ?? MANAGED_SEARCH_DEFAULT_MATCHES,
    contextLines: input.request.contextLines ?? 0, deadline: now() + SEARCH_BUDGET_MS, now, resultBytes: 0, splitLine: false };
  const notSearched: { stream: "stdout" | "stderr"; fromOffset: number; toOffset: number }[] = [];
  let truncated: ManagedOutputSearchTruncation | undefined;
  for (const stream of input.streams) {
    let reached = 0;
    for (const region of await retainedRegions(stream, input.readSpill)) {
      if (region.fromOffset > reached) notSearched.push({ stream: stream.stream, fromOffset: reached, toOffset: region.fromOffset });
      reached = region.fromOffset + region.bytes.byteLength;
      truncated = await scanRegion(stream.stream, region, expression, scan);
      if (truncated) break;
    }
    if (truncated) break;
    if (reached < stream.totalBytes) notSearched.push({ stream: stream.stream, fromOffset: reached, toOffset: stream.totalBytes });
  }
  return Object.freeze({
    matches: Object.freeze(scan.matches),
    ...(truncated ? { truncated } : {}),
    exhaustive: !truncated && !notSearched.length && !scan.splitLine,
    ...(notSearched.length ? { notSearched: Object.freeze(notSearched.map((entry) => Object.freeze(entry))) } : {}),
    ...(scan.splitLine ? { splitLines: true as const } : {}),
  });
}

async function scanRegion(stream: "stdout" | "stderr", region: RetainedOutputRegion, expression: RegExp, scan: SearchScan): Promise<ManagedOutputSearchTruncation | undefined> {
  const bytes = regionBytes(region);
  let start = firstWholeCharacter(region, bytes);
  let chunkLine = region.fromOffset === 0 ? 1 : undefined;
  let insideLine = false, lineOrigin = start, matchedLine = -1;
  while (start < bytes.length) {
    if (scan.now() >= scan.deadline) return "time_limit";
    const end = chunkEnd(bytes, start);
    const endsInsideLine = end < bytes.length && bytes[end - 1] !== 0x0a;
    // renderPlainLines keeps every newline, so the nth line here is the nth line of the raw bytes.
    const text = renderPlainLines(bytes.toString("utf8", start, end));
    // One more than is still wanted shows whether the search stops early. A piece of a line that matched already can take one.
    const found = evaluate(expression, text, scan.limit - scan.matches.length + (insideLine ? 2 : 1), insideLine, endsInsideLine, scan.deadline - scan.now());
    // A host too busy to finish this chunk inside the search budget ends the search as its own time limit does.
    if (!found) return "time_limit";
    // The first line of a piece starts where its line does, which can be in an earlier piece.
    let textLine = 0, rawLine = lineOrigin, linesPassed = 0;
    for (let index = 0; index < found.length; index += 2) {
      const at = found[index]!, length = found[index + 1]!;
      const lineStart = at === 0 ? 0 : text.lastIndexOf("\n", at - 1) + 1;
      while (textLine < lineStart) {
        textLine = text.indexOf("\n", textLine) + 1;
        rawLine = bytes.indexOf(0x0a, rawLine) + 1;
        linesPassed += 1;
      }
      // A line too long for one chunk can match in more than one piece of it, and it is still one line.
      if (rawLine === matchedLine) continue;
      if (scan.matches.length >= scan.limit) return "max_matches";
      matchedLine = rawLine;
      const lineEnd = text.indexOf("\n", lineStart);
      const line = text.slice(lineStart, lineEnd < 0 ? text.length : lineEnd);
      const match = withContext({ stream,
        ...(chunkLine !== undefined ? { line: chunkLine + linesPassed } : {}),
        byteOffset: region.fromOffset + rawLine,
        text: clipAround(line, at - lineStart, length) }, bytes, rawLine, scan.contextLines, !scan.matches.length);
      const size = Buffer.byteLength(JSON.stringify(match));
      if (scan.matches.length && scan.resultBytes + size > RESULT_MAX_BYTES) return "size_limit";
      scan.resultBytes += size;
      scan.matches.push(match);
    }
    if (chunkLine !== undefined) for (let at = text.indexOf("\n"); at >= 0; at = text.indexOf("\n", at + 1)) chunkLine += 1;
    insideLine = endsInsideLine;
    if (insideLine) scan.splitLine = true; else lineOrigin = end;
    start = end;
    // A long search must not hold up the Runner's other work.
    if (start < bytes.length) await nextTurn();
  }
  return undefined;
}

/** A match with its context. The first of a result always goes in, with as much context as the result can hold. */
function withContext(match: ManagedOutputSearchMatch, bytes: Buffer, lineStart: number, contextLines: number, first: boolean): ManagedOutputSearchMatch {
  for (let context = contextLines; ; context -= 1) {
    const around = context > 0 ? neighbours(bytes, lineStart, context) : undefined;
    const full: ManagedOutputSearchMatch = Object.freeze({ ...match,
      ...(around?.before.length ? { before: Object.freeze(around.before) } : {}),
      ...(around?.after.length ? { after: Object.freeze(around.after) } : {}) });
    if (!first || context <= 0 || Buffer.byteLength(JSON.stringify(full)) <= RESULT_MAX_BYTES) return full;
  }
}

/**
 * Lines by number, as a terminal would show them, a page at a time. A positive start counts from the
 * first line kept, a negative one from the end of the output.
 */
export async function readOutputLines(input: Readonly<{
  streams: readonly ManagedOutputStreamEvidence[];
  start: number;
  count: number;
  readSpill?: ReadOutputSpill;
}>): Promise<readonly ManagedOutputLineWindow[]> {
  const windows: ManagedOutputLineWindow[] = [];
  for (const stream of input.streams) {
    const regions = await retainedRegions(stream, input.readSpill);
    if (!regions.length) continue;
    // With a gap, numbers hold only in the first region, and the end of the output is in the last.
    const fromEnd = input.start < 0, gapped = regions.length > 1;
    const region = fromEnd ? regions[regions.length - 1]! : regions[0]!;
    const bytes = regionBytes(region);
    const base = firstWholeCharacter(region, bytes);
    const total = await countLines(bytes, base);
    const first = fromEnd ? Math.max(1, total + input.start + 1) : Math.max(1, input.start);
    const lines: string[] = [];
    let at = await offsetOfLine(bytes, base, first), number = first, used = 0;
    while (at < bytes.length && lines.length < input.count) {
      const newline = bytes.indexOf(0x0a, at);
      const end = newline < 0 ? bytes.length : newline;
      const line = renderedLine(bytes, at, end, LINE_TEXT_CHARS);
      used += Buffer.byteLength(line) + 1;
      if (lines.length && used > RESULT_MAX_BYTES) break;
      lines.push(line);
      number += 1;
      at = newline < 0 ? bytes.length : newline + 1;
    }
    windows.push(Object.freeze({ stream: stream.stream, lines: Object.freeze(lines), startLine: first, totalLines: total,
      ...(number <= total ? { nextLine: gapped && fromEnd ? number - total - 1 : number } : {}),
      ...(region.fromOffset > 0 ? { linesRelativeToByteOffset: region.fromOffset } : {}),
      ...(gapped && !fromEnd && number > total ? { gap: Object.freeze({ fromOffset: region.bytes.byteLength, toOffset: regions[1]!.fromOffset }) } : {}) }));
  }
  return Object.freeze(windows);
}

function regionBytes(region: RetainedOutputRegion): Buffer {
  return Buffer.from(region.bytes.buffer, region.bytes.byteOffset, region.bytes.byteLength);
}

/** A region cut out of the middle of a stream can begin inside a character. */
function firstWholeCharacter(region: RetainedOutputRegion, bytes: Buffer): number {
  let start = 0;
  if (region.fromOffset > 0) while (start < bytes.length && start < 3 && (bytes[start]! & 0xc0) === 0x80) start += 1;
  return start;
}

async function forEachNewline(bytes: Buffer, from: number, visit: (offset: number, ordinal: number) => boolean): Promise<void> {
  let at = from, ordinal = 0, nextYield = from + CHUNK_BYTES;
  for (;;) {
    const newline = bytes.indexOf(0x0a, at);
    if (newline < 0) return;
    ordinal += 1;
    if (!visit(newline, ordinal)) return;
    at = newline + 1;
    if (at >= nextYield) { nextYield = at + CHUNK_BYTES; await nextTurn(); }
  }
}

async function countLines(bytes: Buffer, from: number): Promise<number> {
  let newlines = 0;
  await forEachNewline(bytes, from, () => { newlines += 1; return true; });
  return newlines + (bytes.length > from && bytes[bytes.length - 1] !== 0x0a ? 1 : 0);
}

/** How many lines end in these bytes. It yields as it goes, because they can be a whole stream. */
export async function newlinesIn(bytes: Uint8Array): Promise<number> {
  let newlines = 0;
  await forEachNewline(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength), 0, () => { newlines += 1; return true; });
  return newlines;
}

async function offsetOfLine(bytes: Buffer, from: number, line: number): Promise<number> {
  if (line <= 1) return from;
  let offset = bytes.length;
  await forEachNewline(bytes, from, (newline, ordinal) => {
    if (ordinal !== line - 1) return true;
    offset = newline + 1;
    return false;
  });
  return offset;
}

/** One line as a terminal would show it, in at most limit characters, without rendering more of a huge line than that takes. */
function renderedLine(bytes: Buffer, start: number, end: number, limit: number): string {
  const window = limit * RENDER_BYTES_PER_CHAR;
  let from = start;
  if (end - start > window) {
    // As renderPlain does, a progress line shows its last segment that still writes something, however far along it is.
    let written = end;
    while (written > start && bytes[written - 1] === 0x0d) written -= 1;
    const rewind = bytes.subarray(start, written).lastIndexOf(0x0d);
    if (rewind >= 0) from = start + rewind + 1;
  }
  const stop = Math.min(end, from + window);
  const line = renderPlainLines(bytes.toString("utf8", from, stop));
  return line.length > limit || stop < end ? `${line.slice(0, limit)}…` : line;
}

/** A regular expression asks for a newline with \\n outside a character class. Inside one, as in [^\\n], it is only something not to match. */
function asksForNewline(source: string): boolean {
  let inClass = false;
  for (let at = 0; at < source.length; at += 1) {
    const char = source[at];
    if (char === "\\") {
      if (!inClass && source[at + 1] === "n") return true;
      at += 1;
    } else if (char === "[") inClass = true;
    else if (char === "]") inClass = false;
  }
  return false;
}

function searchExpression(request: ManagedOutputSearchRequest): RegExp {
  const source = request.regex === true ? request.pattern : request.pattern.replace(/[\^$\\.*+?()[\]{}|/]/g, "\\$&");
  try { return new RegExp(source, request.caseSensitive === true ? "gmu" : "gimu"); }
  catch { throw invalid("search.pattern does not compile."); }
}

// One reusable context, as for until.pattern: V8 interrupts a backtracking RegExp at the vm timeout, which no
// static screen can promise. A pattern sees one line at a time, as in grep, so a match cannot run into the next line
// or start on the one above, and whitespace cannot go quadratic over blank lines. Where a chunk starts or ends inside
// a line too long for one, a character of padding keeps ^ and $ from matching at the cut; a match that needs the
// padding lies across the cut, and splitLines says those can be missed. Locals, because reading the context's
// globals is far slower, and this runs once a line.
const searchContext = createContext({ re: /(?:)/u, s: "", limit: 0, cutHead: false, cutTail: false });
const searchScript = new Script(`(() => {
  const text = s, rx = re, most = limit * 2, head = cutHead, tail = cutTail, found = [];
  for (let at = 0; found.length < most;) {
    if (at === text.length && at > 0) break; // past a final newline there is no line
    const newline = text.indexOf("\\n", at), end = newline < 0 ? text.length : newline;
    const lead = head && at === 0 ? 1 : 0, trail = tail && newline < 0 ? 1 : 0;
    const line = (lead ? "x" : "") + text.slice(at, end) + (trail ? "x" : "");
    rx.lastIndex = lead;
    const m = rx.exec(line);
    if (m && m.index + m[0].length <= line.length - trail) found.push(at + m.index - lead, m[0].length);
    if (newline < 0) break;
    at = newline + 1;
  }
  return found;
})()`);

function evaluate(expression: RegExp, text: string, limit: number, cutHead: boolean, cutTail: boolean, timeLeftMs: number): readonly number[] | undefined {
  searchContext.re = expression; searchContext.s = text; searchContext.limit = limit; searchContext.cutHead = cutHead; searchContext.cutTail = cutTail;
  let evaluation;
  try { evaluation = runPatternWithCpuBudget<number[]>(searchScript, searchContext, CHUNK_EVALUATION_CPU_BUDGET_MS, Math.max(1, timeLeftMs)); }
  finally { searchContext.s = ""; }
  if (evaluation.ok) return evaluation.value;
  if (evaluation.reason === "wall") return undefined;
  throw invalid(`search.pattern used more than its ${CHUNK_EVALUATION_CPU_BUDGET_MS} ms CPU bound on one chunk of output; use a simpler pattern.`);
}

/** The next chunk ends after a newline, or where a character ends on a line longer than a chunk. */
function chunkEnd(bytes: Buffer, start: number): number {
  const end = start + CHUNK_BYTES;
  if (end >= bytes.length) return bytes.length;
  const newline = bytes.subarray(start, end).lastIndexOf(0x0a);
  if (newline >= 0) return start + newline + 1;
  let cut = end;
  while (cut > start && (bytes[cut]! & 0xc0) === 0x80) cut -= 1;
  return cut > start ? cut : end;
}

function neighbours(bytes: Buffer, lineStart: number, count: number): { before: string[]; after: string[] } {
  const before: string[] = [], after: string[] = [];
  for (let start = lineStart; before.length < count && start > 0;) {
    const end = start - 1; // the newline that ends the line before
    start = end > 0 ? bytes.lastIndexOf(0x0a, end - 1) + 1 : 0;
    before.unshift(renderedLine(bytes, start, end, MATCH_TEXT_CHARS));
  }
  for (let end = bytes.indexOf(0x0a, lineStart); after.length < count && end >= 0 && end + 1 < bytes.length;) {
    const start = end + 1;
    end = bytes.indexOf(0x0a, start);
    after.push(renderedLine(bytes, start, end < 0 ? bytes.length : end, MATCH_TEXT_CHARS));
  }
  return { before, after };
}

function clipAround(line: string, column: number, length: number): string {
  if (line.length <= MATCH_TEXT_CHARS) return line;
  // A short match stays in view however far along a long line it is.
  const lead = length >= MATCH_TEXT_CHARS - MATCH_LEAD_CHARS ? 0 : MATCH_LEAD_CHARS;
  const start = Math.max(0, Math.min(column - lead, line.length - MATCH_TEXT_CHARS));
  return (start > 0 ? "…" : "") + line.slice(start, start + MATCH_TEXT_CHARS) + (start + MATCH_TEXT_CHARS < line.length ? "…" : "");
}

function inRange(value: unknown, minimum: number, maximum: number): boolean {
  return Number.isSafeInteger(value) && (value as number) >= minimum && (value as number) <= maximum;
}

function invalid(message: string): ManagedProcessError {
  return new ManagedProcessError("invalid_arguments", message);
}
