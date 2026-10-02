/**
 * Break-it (mutation) probe (Runner V2 P6.6 T5, OA-11/EP45).
 *
 * Library only (injectable command runner + file system); not wired into the
 * scheduler. Zero model calls. Ladder: configured project mutation tool
 * (Stryker, Stryker.NET, PIT, mutmut, cargo-mutants, Mull) -> built-in
 * token-level mutator on changed lines for the C family and Python family
 * with a comment- and string-aware lexer -> `not_available`.
 *
 * Rules: disposable copy; non-building mutants discarded (not counted as
 * caught); count/time caps with partial coverage recorded; survivors are
 * reviewer evidence, never an automatic block; rung recorded.
 */

export type MutationRung = "project_tool" | "builtin_mutator" | "not_available";
export type MutationFamily = "c" | "python";

export const C_FAMILY_EXTENSIONS: ReadonlySet<string> = new Set([
  ".c", ".h", ".cpp", ".hpp", ".hxx", ".cc", ".hh",
  ".cs", ".java", ".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx",
  ".go", ".rs", ".kt", ".swift",
]);
export const PYTHON_FAMILY_EXTENSIONS: ReadonlySet<string> = new Set([".py"]);

export const KNOWN_MUTATION_TOOLS: ReadonlySet<string> = new Set([
  "stryker", "stryker_dotnet", "stryker.net", "pit", "mutmut", "cargo_mutants", "cargo-mutants", "mull",
]);

export function familyForPath(path: string): MutationFamily | undefined {
  const lower = path.toLowerCase();
  const dot = lower.lastIndexOf(".");
  const ext = dot >= 0 ? lower.slice(dot) : "";
  if (C_FAMILY_EXTENSIONS.has(ext)) return "c";
  if (PYTHON_FAMILY_EXTENSIONS.has(ext)) return "python";
  return undefined;
}

// ---------------------------------------------------------------------------
// Comment- and string-aware lexer (per family)
// ---------------------------------------------------------------------------

export interface CodeSpan {
  readonly start: number;
  readonly end: number;
}

/**
 * Compute code spans (non-comment, non-string ranges) for one line, given
 * the file-level carry state (inside block comment / multi-line string).
 * Returns spans plus the updated carry state for the next line.
 */
export interface LexerCarry {
  readonly inBlockComment: boolean;
  /** Nesting depth for nested block comments (Rust/Swift/Kotlin). */
  readonly blockDepth: number;
  readonly inTripleString: string | undefined;
  readonly inTemplateString: boolean;
  /** Inside a C# verbatim (@") string, where "" is an escape. */
  readonly inVerbatimString: boolean;
  /** Inside a Rust r#".."# / C++ R"(..)" raw string: the expected closer. */
  readonly inRawCloser: string | undefined;
  /** Inside a plain `"…"` string continued from a previous line. */
  readonly inDquote: boolean;
}

export const INITIAL_CARRY: LexerCarry = {
  inBlockComment: false,
  blockDepth: 0,
  inTripleString: undefined,
  inTemplateString: false,
  inVerbatimString: false,
  inRawCloser: undefined,
  inDquote: false,
};

export function codeSpansForLine(
  line: string,
  family: MutationFamily,
  carry: LexerCarry,
  filePath = "",
): { readonly spans: readonly CodeSpan[]; readonly next: LexerCarry } {
  if (family === "python") return pythonSpans(line, carry);
  return cSpans(line, carry, filePath);
}

function pythonSpans(line: string, carry: LexerCarry): { spans: CodeSpan[]; next: LexerCarry } {
  const spans: CodeSpan[] = [];
  let codeStart: number | undefined = carry.inTripleString ? undefined : 0;
  let i = 0;
  let inTriple = carry.inTripleString;
  const closeSpan = (end: number): void => {
    if (codeStart !== undefined && end > codeStart) spans.push({ start: codeStart, end });
    codeStart = undefined;
  };
  const openSpan = (start: number): void => {
    if (codeStart === undefined) codeStart = start;
  };
  while (i < line.length) {
    if (inTriple) {
      const end = line.indexOf(inTriple, i);
      if (end === -1) {
        i = line.length;
        break;
      }
      i = end + inTriple.length;
      inTriple = undefined;
      openSpan(i);
      continue;
    }
    const ch = line[i];
    const next3 = line.slice(i, i + 3);
    if (next3 === '"""' || next3 === "'''") {
      closeSpan(i);
      const end = line.indexOf(next3, i + 3);
      if (end === -1) {
        inTriple = next3;
        i = line.length;
        break;
      }
      i = end + 3;
      openSpan(i);
      continue;
    }
    if (ch === "#") {
      closeSpan(i);
      break;
    }
    if (ch === '"' || ch === "'") {
      closeSpan(i);
      i = skipQuoted(line, i);
      openSpan(i);
      continue;
    }
    i += 1;
  }
  if (codeStart !== undefined && codeStart < line.length) spans.push({ start: codeStart, end: line.length });
  return {
    spans,
    next: {
      inBlockComment: false,
      blockDepth: 0,
      inTripleString: inTriple,
      inTemplateString: false,
      inVerbatimString: false,
      inRawCloser: undefined,
      inDquote: false,
    },
  };
}

function cSpans(line: string, carry: LexerCarry, filePath: string): { spans: CodeSpan[]; next: LexerCarry } {
  const spans: CodeSpan[] = [];
  let depth = carry.inBlockComment ? Math.max(1, carry.blockDepth) : 0;
  let inTriple = carry.inTripleString;
  let inTemplate = carry.inTemplateString;
  let inVerbatim = carry.inVerbatimString;
  let rawCloser = carry.inRawCloser;
  let inDquote = carry.inDquote;
  let codeStart: number | undefined =
    depth > 0 || inTriple !== undefined || inTemplate || inVerbatim || rawCloser !== undefined || inDquote ? undefined : 0;
  let i = 0;
  const closeSpan = (end: number): void => {
    if (codeStart !== undefined && end > codeStart) spans.push({ start: codeStart, end });
    codeStart = undefined;
  };
  const openSpan = (start: number): void => {
    if (codeStart === undefined) codeStart = start;
  };
  const jsTs = /\.([cm]?[jt]sx?|[jt]s)$/i.test(filePath);
  while (i < line.length) {
    if (inDquote) {
      const end = findUnescaped(line, i, '"');
      if (end === -1) {
        i = line.length;
        break;
      }
      i = end + 1;
      inDquote = false;
      openSpan(i);
      continue;
    }
    if (rawCloser !== undefined) {
      const end = line.indexOf(rawCloser, i);
      if (end === -1) {
        i = line.length;
        break;
      }
      i = end + rawCloser.length;
      rawCloser = undefined;
      openSpan(i);
      continue;
    }
    if (inTriple !== undefined) {
      const end = line.indexOf(inTriple, i);
      if (end === -1) {
        i = line.length;
        break;
      }
      i = end + inTriple.length;
      inTriple = undefined;
      openSpan(i);
      continue;
    }
    if (inVerbatim) {
      const end = scanVerbatimClose(line, i);
      if (end === -1) {
        i = line.length;
        break;
      }
      i = end;
      inVerbatim = false;
      openSpan(i);
      continue;
    }
    if (inTemplate) {
      const end = findUnescaped(line, i, "`");
      if (end === -1) {
        i = line.length;
        break;
      }
      i = end + 1;
      inTemplate = false;
      openSpan(i);
      continue;
    }
    if (depth > 0) {
      const openIdx = line.indexOf("/*", i);
      const shutIdx = line.indexOf("*/", i);
      if (openIdx !== -1 && (shutIdx === -1 || openIdx < shutIdx)) {
        depth += 1;
        i = openIdx + 2;
      } else if (shutIdx !== -1) {
        depth -= 1;
        i = shutIdx + 2;
        if (depth === 0) openSpan(i);
      } else {
        i = line.length;
      }
      continue;
    }
    const two = line.slice(i, i + 2);
    if (two === "//") {
      closeSpan(i);
      break;
    }
    if (two === "/*") {
      closeSpan(i);
      depth = 1;
      i += 2;
      continue;
    }
    // Triple-quoted text blocks: Java 15+, Kotlin, Swift, C# raw strings.
    if (line.startsWith('"""', i)) {
      closeSpan(i);
      const end = line.indexOf('"""', i + 3);
      if (end === -1) {
        inTriple = '"""';
        i = line.length;
        break;
      }
      i = end + 3;
      openSpan(i);
      continue;
    }
    const ch = line[i];
    // Rust raw strings r"..." / r#"..."# / r##"..."##.
    if (ch === "r") {
      const rustRaw = /^r(#+)?"/.exec(line.slice(i, i + 16));
      if (rustRaw) {
        closeSpan(i);
        const closer = `"${rustRaw[1] ?? ""}`;
        const body = line.indexOf(closer, i + rustRaw[0].length);
        if (body === -1) {
          rawCloser = closer;
          i = line.length;
          break;
        }
        i = body + closer.length;
        openSpan(i);
        continue;
      }
    }
    // C++ raw strings R"(...)" / R"delim(...)delim".
    if (ch === "R") {
      const cppRaw = /^R"([^()\s\\]{0,16})\(/.exec(line.slice(i, i + 32));
      if (cppRaw) {
        closeSpan(i);
        const closer = `)${cppRaw[1]}"`;
        const body = line.indexOf(closer, i + cppRaw[0].length);
        if (body === -1) {
          rawCloser = closer;
          i = line.length;
          break;
        }
        i = body + closer.length;
        openSpan(i);
        continue;
      }
    }
    // C# verbatim strings @"..." / $@"..." / @$"..." ("" is an escape).
    if (ch === "@" || ch === "$") {
      const verbatim = line.startsWith('@"', i) ? 2
        : line.startsWith('$@"', i) || line.startsWith('@$"', i) ? 3
        : 0;
      if (verbatim > 0) {
        closeSpan(i);
        const end = scanVerbatimClose(line, i + verbatim);
        if (end === -1) {
          inVerbatim = true;
          i = line.length;
          break;
        }
        i = end;
        openSpan(i);
        continue;
      }
    }
    if (ch === '"' || ch === "'") {
      closeSpan(i);
      const after = skipQuoted(line, i);
      // A plain `"…"` string that never closes on this line (a Rust plain
      // string over several lines) continues on the next line: the carry
      // keeps its operators out of the mutant set. Single quotes never
      // continue a line in the C family (chars, lifetimes).
      if (after >= line.length && ch === '"') inDquote = true;
      i = after;
      openSpan(i);
      continue;
    }
    if (ch === "`") {
      closeSpan(i);
      const end = findUnescaped(line, i + 1, "`");
      if (end === -1) {
        inTemplate = true;
        i = line.length;
        break;
      }
      i = end + 1;
      openSpan(i);
      continue;
    }
    // JS/TS regex literals `/pat/flags` where a value cannot precede.
    if (jsTs && ch === "/" && line[i + 1] !== "/" && line[i + 1] !== "*" && isRegexStart(line, i)) {
      closeSpan(i);
      const end = scanRegexClose(line, i);
      if (end !== -1) {
        i = end;
        openSpan(i);
        continue;
      }
    }
    i += 1;
  }
  if (codeStart !== undefined && codeStart < line.length) spans.push({ start: codeStart, end: line.length });
  return {
    spans,
    next: {
      inBlockComment: depth > 0,
      blockDepth: depth,
      inTripleString: inTriple,
      inTemplateString: inTemplate,
      inVerbatimString: inVerbatim,
      inRawCloser: rawCloser,
      inDquote,
    },
  };
}

function skipQuoted(line: string, start: number): number {
  const quote = line[start];
  let i = start + 1;
  while (i < line.length) {
    if (line[i] === "\\") {
      i += 2;
      continue;
    }
    if (line[i] === quote) return i + 1;
    i += 1;
  }
  return i;
}

/** Scan a C# verbatim string body: `""` is an escape; a lone `"` closes. */
function scanVerbatimClose(line: string, start: number): number {
  let i = start;
  while (i < line.length) {
    if (line[i] === '"') {
      if (line[i + 1] === '"') {
        i += 2;
        continue;
      }
      return i + 1;
    }
    i += 1;
  }
  return -1;
}

const REGEX_KEYWORDS = new Set([
  "return", "typeof", "case", "in", "of", "do", "else", "yield", "await", "void", "delete", "throw",
]);

/**
 * Heuristic: a `/` starts a JS/TS regex literal when the previous
 * significant character cannot end a value (`= ( , [ ! & | ? { } ;` and
 * arithmetic operators), or the preceding word is a keyword like return.
 */
function isRegexStart(line: string, slash: number): boolean {
  let i = slash - 1;
  while (i >= 0 && (line[i] === " " || line[i] === "\t")) i -= 1;
  if (i < 0) return true;
  const prev = line[i];
  if ("=(:,[!&|?{};+-*~^%<>\n".includes(prev)) return true;
  if (/[A-Za-z0-9_$]/.test(prev)) {
    let start = i;
    while (start >= 0 && /[A-Za-z0-9_$]/.test(line[start])) start -= 1;
    if (REGEX_KEYWORDS.has(line.slice(start + 1, i + 1))) return true;
  }
  return false;
}

/** Scan a JS/TS regex literal: honors escapes and `[...]` classes, then flags. */
function scanRegexClose(line: string, slash: number): number {
  let i = slash + 1;
  let inClass = false;
  while (i < line.length) {
    const ch = line[i];
    if (ch === "\\") {
      i += 2;
      continue;
    }
    if (ch === "\n") return -1;
    if (ch === "[" && !inClass) {
      inClass = true;
      i += 1;
      continue;
    }
    if (ch === "]" && inClass) {
      inClass = false;
      i += 1;
      continue;
    }
    if (ch === "/" && !inClass) {
      i += 1;
      while (i < line.length && /[a-z]/i.test(line[i])) i += 1;
      return i;
    }
    i += 1;
  }
  return -1;
}

function findUnescaped(line: string, start: number, quote: string): number {
  let i = start;
  while (i < line.length) {
    if (line[i] === "\\") {
      i += 2;
      continue;
    }
    if (line[i] === quote) return i;
    i += 1;
  }
  return -1;
}

function inSpans(index: number, length: number, spans: readonly CodeSpan[]): boolean {
  return spans.some((s) => index >= s.start && index + length <= s.end);
}

/**
 * True when the `<` at `index` opens a JSX element (`<div …>`, `</div>`),
 * not a comparison. Shape: `<` (or `</`) immediately followed by a tag
 * name that is terminated by whitespace, `/`, `>`, or end of line. A `<`
 * glued to a word char (`a<b`) or a name followed by anything else
 * (`f(a<b)`) stays a comparison candidate. Conservative: a skipped genuine
 * comparison is a missed mutant, never a false survivor.
 */
function isJsxOpen(line: string, index: number): boolean {
  const prev = line[index - 1];
  if (prev !== undefined && /[A-Za-z0-9_$]/.test(prev)) return false;
  const rest = line.slice(index);
  const open = /^<[A-Za-z][A-Za-z0-9.-]*/.exec(rest);
  if (open) {
    const after = rest[open[0].length];
    return after === undefined || after === " " || after === "\t" || after === "/" || after === ">";
  }
  const close = /^<\/[A-Za-z][A-Za-z0-9.-]*/.exec(rest);
  return close !== null;
}

// ---------------------------------------------------------------------------
// Token-level mutator (changed lines only)
// ---------------------------------------------------------------------------

export interface Mutant {
  readonly id: string;
  readonly file: string;
  readonly lineNumber: number;
  readonly column: number;
  readonly original: string;
  readonly mutated: string;
  readonly description: string;
}

export interface MutableFile {
  readonly path: string;
  readonly content: string;
  readonly changedLineNumbers: readonly number[];
}

function isWordChar(ch: string | undefined): boolean {
  return ch !== undefined && /[A-Za-z0-9_$]/.test(ch);
}

/**
 * Generate mutants for changed lines only, mutating code spans only.
 * Deterministic order: file sorted, line sorted, column sorted.
 */
export function generateMutants(files: readonly MutableFile[]): readonly Mutant[] {
  const mutants: Mutant[] = [];
  const sorted = [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  for (const file of sorted) {
    const family = familyForPath(file.path);
    if (!family) continue;
    const lines = file.content.split("\n");
    const changed = new Set(file.changedLineNumbers);
    let carry: LexerCarry = INITIAL_CARRY;
    for (let index = 0; index < lines.length; index += 1) {
      const lineNumber = index + 1;
      const line = lines[index];
      const { spans, next } = codeSpansForLine(line, family, carry, file.path);
      carry = next;
      if (!changed.has(lineNumber)) continue;
      mutants.push(...mutantsForLine(file.path, lineNumber, line, spans, family));
    }
  }
  mutants.sort((a, b) =>
    a.file < b.file ? -1 : a.file > b.file ? 1 : a.lineNumber - b.lineNumber || a.column - b.column ||
    (a.original < b.original ? -1 : a.original > b.original ? 1 : 0));
  return mutants.map((m, i) => ({ ...m, id: `mutant_${i + 1}` }));
}

function mutantsForLine(
  file: string,
  lineNumber: number,
  line: string,
  spans: readonly CodeSpan[],
  family: MutationFamily,
): Mutant[] {
  const mutants: Mutant[] = [];
  const push = (column: number, original: string, mutated: string, description: string): void => {
    if (inSpans(column, original.length, spans)) {
      mutants.push({ id: "", file, lineNumber, column, original, mutated, description });
    }
  };

  // Comparison operators (longest first to avoid overlap).
  const comparisons: ReadonlyArray<readonly [string, string]> = family === "python"
    ? [["==", "!="], ["!=", "=="], ["<=", "<"], [">=", ">"]]
    : [["===", "!=="], ["!==", "==="], ["==", "!="], ["!=", "=="], ["<=", "<"], [">=", ">"]];
  for (const [from, to] of comparisons) {
    let index = line.indexOf(from);
    while (index !== -1) {
      // Avoid mutating `<` inside `<=` etc. (handled by longest-first + span check on exact length).
      push(index, from, to, `comparison ${from} -> ${to}`);
      index = line.indexOf(from, index + from.length);
    }
  }
  // Bare < and > (not part of <=, >=, ==, !=, ->, =>, <<, >>, or generic
  // brackets such as List<String>, f<'a>, or ArrayList<> which cannot build
  // once mutated). Generic-adjacent brackets are skipped conservatively:
  // a missed relational mutant is noise avoided, never a false survivor.
  // JSX element brackets (`<div>`, `</div>`, `/>`) in JS/TS files are
  // markup, not comparisons, and are skipped the same way: mutating them
  // only inflates `caught` on script families with no build oracle.
  const jsTsFile = /\.([cm]?[jt]sx?|[jt]s)$/i.test(file);
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch !== "<" && ch !== ">") continue;
    const prev = line[i - 1];
    const next = line[i + 1];
    if (prev === "<" || prev === ">" || prev === "=" || prev === "-" || prev === "!") continue;
    if (next === "<" || next === ">" || next === "=") continue;
    if (ch === ">" && prev === "/") continue;
    if (jsTsFile && ch === "<" && isJsxOpen(line, i)) continue;
    if (ch === "<" && next === "<") continue;
    if (ch === ">" && (next === ">" || prev === "-")) continue;
    if (ch === "<" && prev === "=") continue;
    if (ch === "<" && prev === "<") continue;
    if (ch === ">" && prev === "<") continue;
    if (ch === "<" && isWordChar(prev) &&
        (isWordChar(next) || next === "?" || next === "'" || next === '"' || next === ">")) continue;
    if (ch === ">" && (isWordChar(prev) || prev === "?" || prev === "'" || prev === '"' || prev === "]") &&
        (next === undefined || " \t,;)>\"'?([{\n".includes(next))) continue;
    push(i, ch, ch === "<" ? "<=" : ">=", `comparison ${ch} widened`);
  }

  // Boolean literals (whole words).
  const booleans: ReadonlyArray<readonly [string, string]> = family === "python"
    ? [["True", "False"], ["False", "True"]]
    : [["true", "false"], ["false", "true"]];
  for (const [from, to] of booleans) {
    let index = line.indexOf(from);
    while (index !== -1) {
      if (!isWordChar(line[index - 1]) && !isWordChar(line[index + from.length])) {
        push(index, from, to, `boolean ${from} -> ${to}`);
      }
      index = line.indexOf(from, index + from.length);
    }
  }

  // + / - (standalone only: not ++, --, +=, -=, ->, =>).
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch !== "+" && ch !== "-") continue;
    const prev = line[i - 1];
    const next = line[i + 1];
    if (ch === "+" && (prev === "+" || next === "+" || next === "=")) continue;
    if (ch === "-" && (prev === "-" || next === "-" || next === "=" || next === ">")) continue;
    if (ch === "-" && prev === "<") continue;
    if (ch === "+" && prev === "=" && next === "=") continue;
    push(i, ch, ch === "+" ? "-" : "+", `arithmetic ${ch} flipped`);
  }

  // && / ||  (C) and and/or (Python, whole words).
  if (family === "python") {
    for (const [from, to] of [["and", "or"], ["or", "and"]] as const) {
      let index = line.indexOf(from);
      while (index !== -1) {
        if (!isWordChar(line[index - 1]) && !isWordChar(line[index + from.length])) {
          push(index, from, to, `logical ${from} -> ${to}`);
        }
        index = line.indexOf(from, index + from.length);
      }
    }
  } else {
    let index = line.indexOf("&&");
    while (index !== -1) {
      push(index, "&&", "||", "logical && -> ||");
      index = line.indexOf("&&", index + 2);
    }
    index = line.indexOf("||");
    while (index !== -1) {
      push(index, "||", "&&", "logical || -> &&");
      index = line.indexOf("||", index + 2);
    }
  }
  return mutants;
}

/** Apply one mutant to file content (pure; caller writes to the disposable copy). */
export function applyMutant(content: string, mutant: Mutant): string {
  const lines = content.split("\n");
  const index = mutant.lineNumber - 1;
  if (index < 0 || index >= lines.length) throw new Error(`Mutant ${mutant.id} line out of range.`);
  const line = lines[index];
  if (line.slice(mutant.column, mutant.column + mutant.original.length) !== mutant.original) {
    throw new Error(`Mutant ${mutant.id} does not match original text (stale content).`);
  }
  lines[index] = line.slice(0, mutant.column) + mutant.mutated + line.slice(mutant.column + mutant.original.length);
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Probe (library with injectable runner + filesystem)
// ---------------------------------------------------------------------------

export interface MutationCommandResult {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
}

export interface MutationCommandRunner {
  readonly run: (input: {
    readonly command: string;
    readonly args: readonly string[];
    readonly cwd: string;
    readonly timeoutMs: number;
  }) => Promise<MutationCommandResult>;
  readonly now: () => number;
}

export interface MutationFileSystem {
  readonly readFile: (path: string) => string;
  readonly writeFile: (path: string, content: string) => void;
  readonly createDisposableCopy: () => string;
  readonly cleanupDisposableCopy: (copyRoot: string) => void;
  readonly join: (root: string, path: string) => string;
}

export interface ConfiguredMutationTool {
  readonly name: string;
  readonly command: string;
  readonly args: readonly string[];
  /**
   * Required: parses tool-reported survivor ids from the tool report.
   * A configured tool without a survivor parser is a failed rung ("report
   * unparseable"), never "success with 0 survivors".
   */
  readonly parseSurvivors: (stdout: string, stderr: string) => readonly string[];
  /** Exit codes that mean a completed run (default: exit 0 only). */
  readonly successExitCodes?: readonly (number | null)[];
  /**
   * Exit codes that mean "completed, survivors found" per the tool's docs:
   * the report is parsed and the survivors kept (reviewer evidence), not a
   * tool failure. Defaults come from exitMeansSurvivorsFound; explicit
   * config overrides the default.
   */
  readonly survivorsFoundExitCodes?: readonly (number | null)[];
}

/**
 * Default "survivors found" exit codes per tool docs. cargo-mutants exits 2
 * when missed mutants are found (0 = clean, 1 = usage error). mutmut 1.x
 * bit-ORs status codes where bit 2 means survived (mutmut 2.x/3.x `run`
 * exits 0 regardless, so the report carries the signal). Every other tool
 * signals survivors through its report on exit 0 only.
 */
export function exitMeansSurvivorsFound(toolName: string, exitCode: number | null): boolean {
  if (typeof exitCode !== "number") return false;
  const name = toolName.toLowerCase().replace(/[-_.\s]/g, "");
  if (name === "cargomutants") return exitCode === 2;
  if (name === "mutmut") return (exitCode & 1) === 0 && (exitCode & 2) !== 0;
  return false;
}

export interface BreakItProbeInput {
  readonly files: readonly MutableFile[];
  readonly affectedTestCommand?: { readonly command: string; readonly args: readonly string[] };
  readonly buildCommand?: { readonly command: string; readonly args: readonly string[] };
  readonly configuredTool?: ConfiguredMutationTool;
  readonly maxMutants: number;
  readonly maxMs: number;
  readonly perCommandTimeoutMs: number;
  readonly runner: MutationCommandRunner;
  readonly fileSystem: MutationFileSystem;
  /** Optional build-failure detector when no buildCommand is given. Default: none (all failures count as caught). */
  readonly isBuildFailure?: (result: MutationCommandResult) => boolean;
}

/**
 * Extensions whose mutants need a build oracle (buildCommand or
 * isBuildFailure) before a test failure may count as caught. Script
 * families (JS/TS/Python) fail at test time, so their failures are caught.
 */
export const COMPILED_MUTANT_EXTENSIONS: ReadonlySet<string> = new Set([
  ".c", ".h", ".cpp", ".hpp", ".hxx", ".cc", ".hh",
  ".cs", ".java", ".go", ".rs", ".kt", ".swift",
]);

export function mutantNeedsBuildOracle(path: string): boolean {
  const lower = path.toLowerCase();
  const dot = lower.lastIndexOf(".");
  return dot >= 0 && COMPILED_MUTANT_EXTENSIONS.has(lower.slice(dot));
}

export interface BreakItProbeResult {
  readonly rung: MutationRung;
  readonly mutantsGenerated: number;
  readonly mutantsExecuted: number;
  readonly mutantsDiscardedNonBuilding: number;
  readonly mutantsCaught: number;
  /**
   * Test failures on compiled families without a build oracle: unknown
   * (possibly non-building), never counted as caught.
   */
  readonly mutantsCaughtUnverified: number;
  readonly survivors: readonly Mutant[];
  /** Tool-reported survivor IDs for the project_tool rung (reviewer evidence). */
  readonly toolSurvivors: readonly string[];
  readonly partial: boolean;
  readonly partialReason?: string;
  /** Survivors never block: always false. */
  readonly blocks: false;
  readonly notes: readonly string[];
}

/**
 * Run the break-it probe. Project tool when configured (scoped to changed
 * files); else the built-in mutator; else `not_available` (unknown language
 * or no affected-test command). Work runs in a disposable copy; the original
 * tree is never written.
 */
export async function runBreakItProbe(input: BreakItProbeInput): Promise<BreakItProbeResult> {
  if (!Number.isSafeInteger(input.maxMutants) || input.maxMutants < 1) {
    throw new Error("maxMutants must be a positive integer.");
  }
  if (!Number.isSafeInteger(input.maxMs) || input.maxMs < 1) {
    throw new Error("maxMs must be a positive integer.");
  }
  const notes: string[] = [];
  const startedAt = input.runner.now();

  // Rung 1: configured project tool. The tool's survivors are carried into
  // toolSurvivors (reviewer evidence, never a block). A tool that fails to
  // run (crash, timeout, a genuine failure exit), a tool with no survivor
  // parser ("report unparseable"), or an unparseable report is a FAILED
  // rung: step down to the built-in mutator and record the step-down, never
  // "success with 0 survivors". Exits that mean "survivors found" per the
  // tool's docs (cargo-mutants 2, mutmut bit-2 codes, or explicit config)
  // still parse the report and keep the survivors.
  if (input.configuredTool && input.affectedTestCommand) {
    const copyRoot = input.fileSystem.createDisposableCopy();
    try {
      const toolName = input.configuredTool.name;
      const changedArgs = [...input.configuredTool.args, ...input.files.map((f) => f.path)];
      let toolResult: MutationCommandResult | undefined;
      let toolError: string | undefined;
      try {
        toolResult = await input.runner.run({
          command: input.configuredTool.command,
          args: changedArgs,
          cwd: copyRoot,
          timeoutMs: Math.min(input.perCommandTimeoutMs, input.maxMs),
        });
      } catch (error) {
        toolError = error instanceof Error ? error.message : String(error);
      }
      const parse = input.configuredTool.parseSurvivors;
      if (toolError === undefined && typeof parse === "function" &&
          toolResult && !toolResult.timedOut) {
        const exit = toolResult.exitCode;
        const completed = input.configuredTool.successExitCodes !== undefined
          ? input.configuredTool.successExitCodes.includes(exit)
          : exit === 0;
        const survivorsExit = input.configuredTool.survivorsFoundExitCodes !== undefined
          ? input.configuredTool.survivorsFoundExitCodes.includes(exit)
          : exitMeansSurvivorsFound(toolName, exit);
        if (completed || survivorsExit) {
          let toolSurvivors: readonly string[] = [];
          let parseError: string | undefined;
          try {
            toolSurvivors = parse(toolResult.stdout, toolResult.stderr);
          } catch (error) {
            parseError = error instanceof Error ? error.message : String(error);
          }
          if (parseError === undefined) {
            notes.push(survivorsExit
              ? `project tool ${toolName} exit ${String(exit)} (survivors found per tool docs) in disposable copy`
              : `project tool ${toolName} exit 0 in disposable copy`);
            return {
              rung: "project_tool",
              mutantsGenerated: 0,
              mutantsExecuted: 0,
              mutantsDiscardedNonBuilding: 0,
              mutantsCaught: 0,
              mutantsCaughtUnverified: 0,
              survivors: [],
              toolSurvivors: [...toolSurvivors],
              partial: false,
              blocks: false,
              notes: [...notes, `tool-reported survivors: ${toolSurvivors.length} (reviewer evidence, not a block)`],
            };
          }
          notes.push(`project tool ${toolName} failed (tool report unparseable (${parseError})); stepping down to built-in mutator`);
        } else {
          notes.push(`project tool ${toolName} failed (tool exit ${String(exit)} timedOut=${String(toolResult.timedOut)}); stepping down to built-in mutator`);
        }
      } else {
        const why = toolError !== undefined
          ? `tool crashed (${toolError})`
          : typeof parse !== "function"
            ? `tool report unparseable (no survivor parser for ${toolName})`
            : `tool exit ${String(toolResult?.exitCode)} timedOut=${String(toolResult?.timedOut)}`;
        notes.push(`project tool ${toolName} failed (${why}); stepping down to built-in mutator`);
      }
    } finally {
      input.fileSystem.cleanupDisposableCopy(copyRoot);
    }
  }

  // Rung 2: built-in mutator.
  const families = new Set(input.files.map((f) => familyForPath(f.path)).filter((f) => f !== undefined));
  if (families.size > 0 && input.affectedTestCommand) {
    const all = generateMutants(input.files);
    const capped = all.slice(0, input.maxMutants);
    const partialByCount = all.length > capped.length;
    const copyRoot = input.fileSystem.createDisposableCopy();
    const survivors: Mutant[] = [];
    let caught = 0;
    let unverified = 0;
    let discarded = 0;
    let executed = 0;
    let timedOut = false;
    const hasBuildOracle = input.buildCommand !== undefined || input.isBuildFailure !== undefined;
    try {
      for (const mutant of capped) {
        if (input.runner.now() - startedAt >= input.maxMs) {
          timedOut = true;
          break;
        }
        const original = input.fileSystem.readFile(mutant.file);
        const mutated = applyMutant(original, mutant);
        input.fileSystem.writeFile(input.fileSystem.join(copyRoot, mutant.file), mutated);
        try {
          if (input.buildCommand) {
            const build = await input.runner.run({
              command: input.buildCommand.command,
              args: input.buildCommand.args,
              cwd: copyRoot,
              timeoutMs: input.perCommandTimeoutMs,
            });
            if (build.exitCode !== 0) {
              discarded += 1;
              continue;
            }
          }
          const test = await input.runner.run({
            command: input.affectedTestCommand.command,
            args: input.affectedTestCommand.args,
            cwd: copyRoot,
            timeoutMs: input.perCommandTimeoutMs,
          });
          executed += 1;
          if (!input.buildCommand && input.isBuildFailure?.(test)) {
            discarded += 1;
            executed -= 1;
            continue;
          }
          if (test.exitCode === 0 && !test.timedOut) {
            survivors.push(mutant);
          } else if (!hasBuildOracle && mutantNeedsBuildOracle(mutant.file)) {
            unverified += 1;
          } else {
            caught += 1;
          }
        } finally {
          input.fileSystem.writeFile(input.fileSystem.join(copyRoot, mutant.file), original);
        }
      }
    } finally {
      input.fileSystem.cleanupDisposableCopy(copyRoot);
    }
    const partial = partialByCount || timedOut;
    const runNotes = [...notes, `built-in mutator on changed lines; ${survivors.length} survivor(s) for reviewer evidence`];
    if (unverified > 0) {
      runNotes.push(`${unverified} test failure(s) on compiled families without a build oracle are unknown (possibly non-building), not caught`);
    }
    return {
      rung: "builtin_mutator",
      mutantsGenerated: all.length,
      mutantsExecuted: executed,
      mutantsDiscardedNonBuilding: discarded,
      mutantsCaught: caught,
      mutantsCaughtUnverified: unverified,
      survivors,
      toolSurvivors: [],
      partial,
      ...(partial
        ? { partialReason: `partial coverage: executed ${executed} of ${all.length} generated (${timedOut ? "time cap" : "count cap"})` }
        : {}),
      blocks: false,
      notes: runNotes,
    };
  }

  // Rung 3: not available.
  const reason = !input.affectedTestCommand
    ? "no affected-test command exists"
    : "unknown language for all changed files";
  return {
    rung: "not_available",
    mutantsGenerated: 0,
    mutantsExecuted: 0,
    mutantsDiscardedNonBuilding: 0,
    mutantsCaught: 0,
    mutantsCaughtUnverified: 0,
    survivors: [],
    toolSurvivors: [],
    partial: false,
    blocks: false,
    notes: [`mutation probe not available: ${reason}`],
  };
}
