/**
 * Test report readers (Runner V2 P6.6 T5, OA-13/EP47).
 *
 * Pure, deterministic, zero model calls, zero new dependencies. Reads JUnit
 * XML and TRX reports into selected/passed/failed/skipped counts with a
 * linear-time tag scanner (no backtracking regex over raw text, no entity
 * expansion, no external DTD fetch). A missing, empty, unreadable,
 * malformed, truncated, self-contradicting, or nothing-ran report yields
 * `unknown`, never `passed`.
 *
 * Fail-closed rules:
 * - Comments and CDATA are stripped before scanning, so totals hidden in a
 *   comment can never shadow the real elements (and vice versa). Markup
 *   that only appears inside CDATA (such as a `<!DOCTYPE html>` page dump
 *   in a `system-out`) is never parsed as structure.
 * - `<!DOCTYPE` / `<!ENTITY` outside comments/CDATA is rejected as
 *   `unknown` (no entity expansion happens here, but such documents are
 *   not trusted reports). The check runs on the stripped text, so a
 *   doctype inside CDATA output does not poison a genuine pass.
 * - A report whose root element never closes (killed mid-write) is
 *   `unknown`, never a partial `passed`.
 * - When `<testcase>` elements exist, the aggregate totals must equal the
 *   element counts; any disagreement is `unknown`. Each testcase counts
 *   once as not-executed even when it carries both `status="notrun"` and
 *   a `<skipped/>` child (ctest writes exactly that for a skip).
 * - Nested `<testsuite>` totals are taken from the outermost suites that
 *   carry numbers (leaf suites when the outer wrapper has none), so a
 *   clean PHPUnit report is not double-counted.
 * - JUnit `disabled` attributes and `status="notrun"` testcases count as
 *   not executed (skipped), never passed.
 * - TRX `timeout` / `aborted` count as failed; `inconclusive`,
 *   `passedButRunAborted`, `notRunnable`, `disconnected`, and `inProgress`
 *   counts make the reading `unknown`; a `ResultSummary` outcome that
 *   disagrees with the counters is `unknown`. `<UnitTestResult>` outcomes
 *   are cross-checked against the counters, and a TRX cut before
 *   `</ResultSummary>` / `</TestRun>` is `unknown` (truncated).
 * - A reading with zero passing assertions (`passed === 0`, or TRX
 *   `executed === 0`) converts to `unknown` in `outcomeFromReportReading`.
 */

export interface ReportCounts {
  readonly selected: number;
  readonly passed: number;
  readonly failed: number;
  readonly skipped: number;
}

export type ReportReading =
  | { readonly status: "ok"; readonly counts: ReportCounts }
  | { readonly status: "unknown"; readonly reason: string };

export const MAX_REPORT_BYTES = 10 * 1024 * 1024;

/** Upper bound on a single tag's length; longer opens mean truncation. */
const MAX_TAG_BYTES = 8192;

function toBytesLength(content: string): number {
  return Buffer.byteLength(content, "utf8");
}

/** Safe attribute scan over ONE bounded tag string: name="value". */
function parseAttributes(tag: string): Map<string, string> {
  const attributes = new Map<string, string>();
  const pattern = /([A-Za-z_:][A-Za-z0-9_.:-]*)\s*=\s*("([^"]*)"|'([^']*)')/g;
  let match: RegExpExecArray | null;
  let guard = 0;
  while ((match = pattern.exec(tag)) !== null && guard < 500) {
    guard += 1;
    attributes.set(match[1].toLowerCase(), match[3] ?? match[4] ?? "");
  }
  return attributes;
}

function parseNonNegativeInt(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!/^\d+$/.test(value.trim())) return undefined;
  const parsed = Number.parseInt(value.trim(), 10);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

function unknown(reason: string): ReportReading {
  return { status: "unknown", reason };
}

function checkReadable(content: string | null | undefined, label: string): ReportReading | undefined {
  if (content === null || content === undefined) return unknown(`${label}: report is missing.`);
  if (content.trim() === "") return unknown(`${label}: report is empty.`);
  if (toBytesLength(content) > MAX_REPORT_BYTES) return unknown(`${label}: report exceeds size bound.`);
  return undefined;
}

interface ScannedTag {
  /** Lower-cased tag name without brackets or slash. */
  readonly name: string;
  /** True for `</...>` closes. */
  readonly close: boolean;
  /** True for `<.../>` self-closes. */
  readonly selfClose: boolean;
  /** Raw tag text (bounded by MAX_TAG_BYTES) for attribute parsing. */
  readonly raw: string;
}

/**
 * Linear-time tag scan: each pass advances through `indexOf` results, so
 * input with many `<` and no `>` (or very long inputs) cannot backtrack.
 * Returns `undefined` when the input is truncated mid-tag.
 */
function scanTags(text: string): ScannedTag[] | undefined {
  const tags: ScannedTag[] = [];
  let cursor = 0;
  for (;;) {
    const open = text.indexOf("<", cursor);
    if (open === -1) return tags;
    const shut = text.indexOf(">", open + 1);
    if (shut === -1) return undefined;
    if (shut - open > MAX_TAG_BYTES) return undefined;
    const raw = text.slice(open, shut + 1);
    const inner = raw.slice(1, -1).trim();
    const close = inner.startsWith("/");
    const selfClose = !close && inner.endsWith("/");
    const name = (close ? inner.slice(1) : inner).trim().split(/[\s/]/, 1)[0]?.toLowerCase() ?? "";
    if (name) tags.push({ name, close, selfClose, raw });
    cursor = shut + 1;
  }
}

/**
 * Strip XML comments and CDATA sections with a linear scan, so markup
 * hidden inside them (totals in a comment, elements in CDATA) is never
 * parsed as structure. Returns `undefined` on unterminated constructs.
 */
function stripNonStructure(text: string): string | undefined {
  let out = "";
  let cursor = 0;
  for (;;) {
    const commentAt = text.indexOf("<!--", cursor);
    const cdataAt = text.indexOf("<![CDATA[", cursor);
    let next = -1;
    let closer = "";
    let skip = 0;
    if (commentAt !== -1 && (cdataAt === -1 || commentAt < cdataAt)) {
      next = commentAt;
      closer = "-->";
      skip = 4;
    } else if (cdataAt !== -1) {
      next = cdataAt;
      closer = "]]>";
      skip = 9;
    } else {
      out += text.slice(cursor);
      return out;
    }
    const end = text.indexOf(closer, next + skip);
    if (end === -1) return undefined;
    out += text.slice(cursor, next);
    out += " ";
    cursor = end + closer.length;
  }
}

function hasDoctype(text: string): boolean {
  return text.toLowerCase().includes("<!doctype") || text.toLowerCase().includes("<!entity");
}

// ---------------------------------------------------------------------------
// JUnit XML
// ---------------------------------------------------------------------------

/** A `<testsuite>` open with its nesting depth and attributes. */
interface SuiteOpen {
  readonly attrs: Map<string, string>;
  /** Count of enclosing `<testsuite>` elements (0 = outermost). */
  readonly depth: number;
  /** True once a nested `<testsuite>` opens inside this one. */
  hasChildSuite: boolean;
}

interface JUnitStructure {
  /** Every `<testsuite>` open (for the numeric fallback pool). */
  readonly suites: SuiteOpen[];
  /** Every `<testcase>` open count. */
  readonly caseCount: number;
  /** `<failure>` + `<error>` element count. */
  readonly failedElements: number;
  /**
   * Not-executed testcase count: `<skipped>` elements plus
   * `status="notrun"/"disabled"/"skipped"` testcases, counting each
   * testcase once even when it carries both (ctest writes
   * `status="notrun"` with a `<skipped/>` child for a skip).
   */
  readonly notExecuted: number;
}

/**
 * One structure pass over the tag list: suite nesting (outer vs leaf),
 * testcase statuses, and skipped-element placement. Best-effort on
 * malformed nesting (unmatched closes pop to the nearest matching frame).
 */
function analyzeJUnitTags(tags: ScannedTag[]): JUnitStructure {
  const suites: SuiteOpen[] = [];
  let caseCount = 0;
  let failedElements = 0;
  let skippedElements = 0;
  let notrunCases = 0;
  // Open-element stack: suite frames track children; case frames track
  // whether the testcase itself is not-executed (for overlap dedup).
  const stack: Array<{ name: string; notrunCase: boolean; suiteRef?: SuiteOpen }> = [];
  const enclosingNotrunCase = (): boolean => {
    for (let i = stack.length - 1; i >= 0; i -= 1) {
      if (stack[i].name === "testcase") return stack[i].notrunCase;
    }
    return false;
  };
  const enclosingSuite = (): SuiteOpen | undefined => {
    for (let i = stack.length - 1; i >= 0; i -= 1) {
      if (stack[i].suiteRef) return stack[i].suiteRef;
    }
    return undefined;
  };
  for (const tag of tags) {
    if (tag.close) {
      for (let i = stack.length - 1; i >= 0; i -= 1) {
        if (stack[i].name === tag.name) {
          stack.length = i;
          break;
        }
      }
      continue;
    }
    if (tag.name === "testsuite") {
      const parent = enclosingSuite();
      if (parent) parent.hasChildSuite = true;
      const depth = stack.filter((f) => f.name === "testsuite").length;
      const entry: SuiteOpen = { attrs: parseAttributes(tag.raw), depth, hasChildSuite: false };
      suites.push(entry);
      if (!tag.selfClose) stack.push({ name: "testsuite", notrunCase: false, suiteRef: entry });
    } else if (tag.name === "testcase") {
      caseCount += 1;
      const status = (parseAttributes(tag.raw).get("status") ?? "").toLowerCase();
      const notrun = status === "notrun" || status === "disabled" || status === "skipped";
      if (notrun) notrunCases += 1;
      if (!tag.selfClose) stack.push({ name: "testcase", notrunCase: notrun });
    } else if (tag.name === "failure" || tag.name === "error") {
      failedElements += 1;
    } else if (tag.name === "skipped") {
      if (!enclosingNotrunCase()) skippedElements += 1;
    } else if (!tag.selfClose) {
      stack.push({ name: tag.name, notrunCase: false });
    }
  }
  return { suites, caseCount, failedElements, notExecuted: skippedElements + notrunCases };
}

const disabledOf = (attrs: Map<string, string>): number =>
  parseNonNegativeInt(attrs.get("disabled")) ?? 0;

/**
 * Read JUnit XML (Java, gtest, ctest --output-junit, pytest --junitxml,
 * jest-junit, cargo-nextest, go-junit-report, PHPUnit). Structure-first:
 * totals come from `<testsuites>` / `<testsuite>` attributes but must agree
 * with the `<testcase>` elements when any exist; otherwise the report is
 * `unknown`. selected = tests; failed = failures + errors; skipped =
 * skipped + disabled + status="notrun"; passed = selected - failed -
 * skipped. Nested `<testsuite>` totals are taken from the outermost suites
 * carrying numbers (leaf suites when the wrapper has none), never summed
 * at every level.
 */
export function readJUnitReport(content: string | null | undefined): ReportReading {
  const unreadable = checkReadable(content, "JUnit");
  if (unreadable) return unreadable;
  const text = content as string;
  const stripped = stripNonStructure(text);
  if (stripped === undefined) {
    return unknown("JUnit: unterminated comment or CDATA section (truncated).");
  }
  // The doctype check runs on the stripped text: a `<!DOCTYPE html>` page
  // dump inside a CDATA `system-out` is output, not a document type.
  if (hasDoctype(stripped)) {
    return unknown("JUnit: document type declarations / entities are not trusted (unreadable as JUnit).");
  }
  const tags = scanTags(stripped);
  if (tags === undefined) {
    return unknown("JUnit: truncated tag (report killed mid-write).");
  }
  const opens = tags.filter((t) => !t.close);
  const hasSuitesOpen = opens.some((t) => t.name === "testsuites");
  const hasSuiteOpen = opens.some((t) => t.name === "testsuite");
  if (!hasSuitesOpen && !hasSuiteOpen && !opens.some((t) => t.name === "testcase")) {
    return unknown("JUnit: no testsuites/testsuite/testcase data found (unreadable as JUnit).");
  }
  if (hasSuitesOpen && !tags.some((t) => t.close && t.name === "testsuites") &&
      !opens.some((t) => t.name === "testsuites" && t.selfClose)) {
    return unknown("JUnit: <testsuites> root never closes (truncated).");
  }
  if (hasSuiteOpen && !tags.some((t) => t.close && t.name === "testsuite") &&
      !opens.some((t) => t.name === "testsuite" && t.selfClose)) {
    return unknown("JUnit: <testsuite> element never closes (truncated).");
  }

  const suiteTags = opens.filter((t) => t.name === "testsuites");
  const structure = analyzeJUnitTags(tags);
  const caseCount = structure.caseCount;

  // Aggregate totals: prefer <testsuites>, step down to <testsuite> sums
  // when the outer totals are absent or non-numeric (comment-shadowed or
  // hand-written wrappers must never mask the real suite numbers).
  let aggregate: { tests: number; failed: number; skipped: number } | undefined;
  if (suiteTags.length > 0) {
    const attrs = parseAttributes(suiteTags[0].raw);
    const tests = parseNonNegativeInt(attrs.get("tests"));
    if (tests !== undefined) {
      const failed = (parseNonNegativeInt(attrs.get("failures")) ?? 0) +
        (parseNonNegativeInt(attrs.get("errors")) ?? 0);
      const skipped = (parseNonNegativeInt(attrs.get("skipped")) ?? parseNonNegativeInt(attrs.get("skip")) ?? 0) +
        disabledOf(attrs);
      aggregate = { tests, failed, skipped };
    }
  }
  if (aggregate === undefined && structure.suites.length > 0) {
    // Nested suites are summed once: the outermost suites carrying numbers
    // win (a PHPUnit wrapper repeats its child's totals); when the outer
    // wrapper carries no numbers, the leaf suites are summed instead.
    const outer = structure.suites.filter((s) => s.depth === 0);
    const outerNumbered = outer.filter((s) => parseNonNegativeInt(s.attrs.get("tests")) !== undefined);
    const pool = outerNumbered.length > 0 ? outerNumbered : structure.suites.filter((s) => !s.hasChildSuite);
    let tests = 0;
    let failed = 0;
    let skipped = 0;
    let anyNumbers = false;
    for (const suite of pool) {
      const t = parseNonNegativeInt(suite.attrs.get("tests"));
      if (t === undefined) continue;
      anyNumbers = true;
      tests += t;
      failed += (parseNonNegativeInt(suite.attrs.get("failures")) ?? 0) +
        (parseNonNegativeInt(suite.attrs.get("errors")) ?? 0);
      skipped += (parseNonNegativeInt(suite.attrs.get("skipped")) ?? parseNonNegativeInt(suite.attrs.get("skip")) ?? 0) +
        disabledOf(suite.attrs);
    }
    if (anyNumbers) {
      aggregate = { tests, failed, skipped };
    } else if (suiteTags.length > 0 || caseCount === 0) {
      return unknown("JUnit: suite totals are not numeric (unreadable as JUnit).");
    }
  }

  if (aggregate === undefined) {
    // Fallback: count testcase tags when no totals exist.
    if (caseCount === 0) {
      return unknown("JUnit: no testsuites/testsuite/testcase data found (unreadable as JUnit).");
    }
    return finishJUnit(caseCount, structure.failedElements, structure.notExecuted);
  }

  if (caseCount === 0 && aggregate.tests > 0) {
    return unknown("JUnit: aggregate totals claim executed tests without any testcase elements.");
  }

  // Cross-check structure against aggregates whenever elements exist.
  // Disabled / notrun testcases are not-executed elements, so they join the
  // element skipped side (a legit gtest report lists disabled tests with
  // status="notrun" while carrying them in the `disabled` aggregate). Each
  // testcase counts once: a ctest skip (`status="notrun"` plus a
  // `<skipped/>` child) is one not-executed test, not two.
  if (caseCount > 0) {
    const elementFailed = structure.failedElements;
    const elementSkippedAll = structure.notExecuted;
    if (aggregate.tests !== caseCount ||
        aggregate.failed !== elementFailed ||
        aggregate.skipped !== elementSkippedAll) {
      return unknown(
        "JUnit: aggregate totals disagree with testcase elements " +
        `(tests ${aggregate.tests} vs ${caseCount} cases, ` +
        `failed ${aggregate.failed} vs ${elementFailed}, skipped ${aggregate.skipped} vs ${elementSkippedAll}).`,
      );
    }
  }
  const skipped = aggregate.skipped + (caseCount === 0 ? structure.notExecuted : 0);
  return finishJUnit(aggregate.tests, aggregate.failed, skipped);
}

function finishJUnit(selected: number, failed: number, skipped: number): ReportReading {
  if (failed + skipped > selected) return unknown("JUnit: counts inconsistent (failed+skipped exceeds selected).");
  return {
    status: "ok",
    counts: { selected, passed: selected - failed - skipped, failed, skipped },
  };
}

// ---------------------------------------------------------------------------
// TRX (dotnet test --logger trx)
// ---------------------------------------------------------------------------

const TRX_UNKNOWN_OUTCOMES = new Set([
  "inconclusive", "passedbutrunaborted", "notrunnable", "disconnected", "inprogress",
]);

const TRX_FAILED_OUTCOMES = new Set(["failed", "error", "timeout", "aborted"]);

/**
 * Read a TRX report via its `<Counters>` tag. selected = total; failed =
 * failed + error + timeout + aborted; the inconclusive / passedButRunAborted
 * / notRunnable / disconnected / inProgress outcomes are `unknown`, never
 * skipped-as-pass; `executed === 0` is `unknown`; a `ResultSummary` outcome
 * that disagrees with the counters is `unknown`. `<UnitTestResult>`
 * outcomes are cross-checked against the counters whenever any exist, and
 * a report cut before `</ResultSummary>` / `</TestRun>` is `unknown`
 * (truncated), never a partial `passed`.
 */
export function readTrxReport(content: string | null | undefined): ReportReading {
  const unreadable = checkReadable(content, "TRX");
  if (unreadable) return unreadable;
  const text = content as string;
  const stripped = stripNonStructure(text);
  if (stripped === undefined) {
    return unknown("TRX: unterminated comment or CDATA section (truncated).");
  }
  if (hasDoctype(stripped)) {
    return unknown("TRX: document type declarations / entities are not trusted (unreadable as TRX).");
  }
  const tags = scanTags(stripped);
  if (tags === undefined) {
    return unknown("TRX: truncated tag (report killed mid-write).");
  }
  const counters = tags.filter((t) => !t.close && t.name === "counters");
  if (counters.length === 0) {
    return unknown("TRX: no <Counters> tag found (unreadable as TRX).");
  }
  if (!tags.some((t) => t.close && t.name === "resultsummary") &&
      !tags.some((t) => t.close && t.name === "testrun")) {
    return unknown("TRX: no </ResultSummary> or </TestRun> close (truncated).");
  }
  const attrs = parseAttributes(counters[0].raw);
  const total = parseNonNegativeInt(attrs.get("total"));
  const passed = parseNonNegativeInt(attrs.get("passed"));
  const failed = parseNonNegativeInt(attrs.get("failed"));
  if (total === undefined || passed === undefined || failed === undefined) {
    return unknown("TRX: <Counters> lacks total/passed/failed numbers.");
  }
  const error = parseNonNegativeInt(attrs.get("error")) ?? 0;
  const timeout = parseNonNegativeInt(attrs.get("timeout")) ?? 0;
  const aborted = parseNonNegativeInt(attrs.get("aborted")) ?? 0;
  const failedTotal = failed + error + timeout + aborted;
  for (const name of TRX_UNKNOWN_OUTCOMES) {
    if ((parseNonNegativeInt(attrs.get(name)) ?? 0) > 0) {
      return unknown(`TRX: outcome ${name} is neither pass nor fail (unknown).`);
    }
  }
  const executed = parseNonNegativeInt(attrs.get("executed"));
  if (executed === 0) {
    return unknown("TRX: executed is 0 (nothing ran).");
  }
  if (passed + failedTotal > total) {
    return unknown("TRX: counts inconsistent (passed+failed exceeds total).");
  }
  const summary = tags.filter((t) => !t.close && t.name === "resultsummary");
  if (summary.length > 0) {
    const outcome = (parseAttributes(summary[0].raw).get("outcome") ?? "").toLowerCase();
    if (outcome === "failed" || outcome === "aborted") {
      if (failedTotal === 0 && passed > 0) {
        return unknown(`TRX: ResultSummary outcome ${outcome} disagrees with passing counters.`);
      }
    } else if (outcome === "passed" || outcome === "completed") {
      if (failedTotal > 0) {
        return unknown(`TRX: ResultSummary outcome ${outcome} disagrees with failing counters.`);
      }
    } else if (outcome !== "") {
      return unknown(`TRX: ResultSummary outcome ${outcome} is a non-pass terminal outcome.`);
    }
  }
  const results = tags.filter((t) => !t.close && t.name === "unittestresult");
  if (results.length > 0) {
    let passResults = 0;
    let failResults = 0;
    let otherResults = 0;
    for (const tag of results) {
      const outcome = (parseAttributes(tag.raw).get("outcome") ?? "").toLowerCase();
      if (outcome === "passed") passResults += 1;
      else if (TRX_FAILED_OUTCOMES.has(outcome)) failResults += 1;
      else if (TRX_UNKNOWN_OUTCOMES.has(outcome)) {
        return unknown(`TRX: UnitTestResult outcome ${outcome} is neither pass nor fail (unknown).`);
      } else otherResults += 1;
    }
    if (passResults !== passed || failResults !== failedTotal ||
        passResults + failResults + otherResults !== total) {
      return unknown(
        "TRX: UnitTestResult outcomes disagree with counters " +
        `(results passed ${passResults} failed ${failResults} other ${otherResults} vs ` +
        `counters passed ${passed} failed ${failedTotal} total ${total}).`,
      );
    }
  }
  return {
    status: "ok",
    counts: { selected: total, passed, failed: failedTotal, skipped: total - passed - failedTotal },
  };
}

/**
 * Convert a report reading into a validation outcome fragment. `unknown`
 * stays unknown (never passed); zero selected stays unknown; and a reading
 * with zero passing assertions stays `unknown` as well — exit 0 with nothing
 * actually passing (all skipped / disabled / not executed) is not green.
 */
export function outcomeFromReportReading(reading: ReportReading): {
  readonly outcome: "passed" | "failed" | "unknown";
  readonly counts: ReportCounts;
} {
  if (reading.status === "unknown") {
    return { outcome: "unknown", counts: { selected: 0, passed: 0, failed: 0, skipped: 0 } };
  }
  const counts = reading.counts;
  if (counts.selected === 0) {
    return { outcome: "unknown", counts };
  }
  if (counts.passed === 0) {
    return { outcome: "unknown", counts };
  }
  return { outcome: counts.failed > 0 ? "failed" : "passed", counts };
}
