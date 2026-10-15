import type { LateFindingBasis, PlanningFinding } from "./planning-contracts.js";

/**
 * W2 (AR-R28, S2 section 7.2 item 5, section 7.4, S3 L8): delta-first
 * re-review and bounded late findings. Pure mechanics only — no Git, no
 * store, no model. Every classifier here is mechanical: exact path
 * identity, verified hunk/line correspondence, tree identity and durable
 * report facts. Semantic completeness stays with the Architect; this
 * module never decides it.
 *
 * Two conservative directions, deliberately different:
 *
 * - Over-correction signal (delta files no prior finding names): an
 *   absent or ambiguous prior location cannot prove review, so it
 *   counts as UNNAMED and pulls the full cumulative diff up front.
 *   More context is the safe direction here.
 * - Late-finding rule (new blocking finding on unchanged reviewed code):
 *   only a concrete location proven UNTOUCHED (outside every verified
 *   fix hunk with intact old/new numbering) and proven REVIEWED (file
 *   membership for file-level findings; verified line coverage for
 *   line-level findings) is ever demoted. Deletions, structural shifts,
 *   out-of-range lines and ambiguous mappings stay BLOCKING (fail
 *   closed). Less demotion is the safe direction here.
 */

/** Reviewer finding identities the late-finding filter must never touch. */
export const RESERVED_REVIEW_FINDING_PREFIXES = [
  "submission-scope:",
  "submission-encoding:",
  "mutation-survivor:",
  "repair-oscillation:",
  "carried:",
] as const;

export function isReservedReviewFindingId(id: string): boolean {
  return RESERVED_REVIEW_FINDING_PREFIXES.some((prefix) => id.startsWith(prefix));
}

const CRITICAL_KINDS = new Set(["security", "data_loss", "false_acceptance"]);

/**
 * Structural validation of a reviewer-supplied late-finding basis. Accepts
 * undefined (no exception claimed). A blank rationale is accepted here
 * and denied at classification: a weak basis never breaks a findings
 * pass, it only fails to authorize the blocking exception.
 */
export function validateLateFindingBasis(value: unknown, findingId: string): LateFindingBasis | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`Deliverable finding ${findingId} lateFinding basis is invalid.`);
  }
  const candidate = value as Record<string, unknown>;
  if (candidate.basis !== "critical" && candidate.basis !== "failing_test") {
    throw new Error(`Deliverable finding ${findingId} lateFinding basis is invalid.`);
  }
  if (typeof candidate.rationale !== "string") {
    throw new Error(`Deliverable finding ${findingId} lateFinding rationale is invalid.`);
  }
  if (candidate.basis === "critical") {
    const criticalKind = candidate.criticalKind;
    if (criticalKind !== "security" && criticalKind !== "data_loss" && criticalKind !== "false_acceptance") {
      throw new Error(`Deliverable finding ${findingId} lateFinding criticalKind is invalid.`);
    }
    return { basis: "critical", criticalKind, rationale: candidate.rationale };
  }
  if (!Array.isArray(candidate.testIds) || candidate.testIds.length === 0 ||
    candidate.testIds.some((id) => typeof id !== "string" || !(id as string).trim())) {
    throw new Error(`Deliverable finding ${findingId} lateFinding testIds are invalid.`);
  }
  return {
    basis: "failing_test",
    testIds: (candidate.testIds as string[]).map((id) => id.trim()),
    rationale: candidate.rationale,
  };
}

/** Strict concrete location parsed from one finding location. */
export interface ConcreteFindingLocation {
  /**
   * Exact path identity. Model-side presentation (surrounding whitespace,
   * one redundant leading ./) is stripped at parse; everything else —
   * quotes, backslashes, rename arrows, a/b prefixes — is either exact
   * identity or ambiguity (unknown). Machine facts are NEVER normalized:
   * they compare byte-exact against this path.
   */
  readonly path: string;
  /** Concrete new-side line when unambiguously stated. */
  readonly line?: number;
}

/**
 * Model-side presentation normalization ONLY: surrounding whitespace and
 * one redundant leading ./. Applied to reviewer-written strings (finding
 * locations) — never to machine facts (NUL-delimited Git paths, captured
 * read paths, hunk header paths), which keep byte-exact identity:
 * leading/trailing spaces are identity there, and real `a`/`b`
 * directories are never stripped anywhere.
 */
export function normalizeModelPath(path: string): string {
  return path.trim().replace(/^\.\//, "");
}

/**
 * Strict concrete location from one finding location. Returns undefined
 * (unknown) unless the location names exactly one path:
 *
 * - No backslash unescaping: Git C-quoting and octal escapes are never
 *   decoded. Any interior quote or backslash is ambiguous: unknown.
 * - No a/ or b/ prefix stripping: repository directories literally
 *   named `a` or `b` keep their identity.
 * - No rename invention: a literal `->` may be prose: unknown.
 * - Only a single trailing :digits suffix binds a line; :line:col and
 *   other tails are unknown rather than misparsed.
 *
 * Unknown means conservative unknown/unmatched: unnamed for the
 * over-correction signal (more context) and blocking for late findings.
 */
export function parseConcreteLocation(location: string | undefined): ConcreteFindingLocation | undefined {
  if (typeof location !== "string") return undefined;
  const trimmed = location.trim();
  if (!trimmed || trimmed === "/dev/null" || trimmed.includes("\0")) return undefined;
  if (trimmed.includes("->")) return undefined;
  if (trimmed.includes('"') || trimmed.includes("\\")) return undefined;
  let candidate = trimmed;
  let line: number | undefined;
  const suffix = /:(\d+)\s*$/.exec(candidate);
  if (suffix) {
    candidate = candidate.slice(0, suffix.index);
    // A remaining :digits tail is a line:col form or prose: ambiguous.
    if (/:\d+$/.test(candidate)) return undefined;
    line = Number(suffix[1]);
    if (!Number.isSafeInteger(line) || line < 1) return undefined;
  }
  candidate = normalizeModelPath(candidate);
  if (!candidate || candidate === "/dev/null") return undefined;
  return line === undefined ? { path: candidate } : { path: candidate, line };
}

/**
 * Strict match of one finding location against one machine path: the
 * parsed concrete path must equal the machine path byte-exactly. A
 * stated line is ignored for naming — a finding at line 5 of a file
 * still proves the file was reviewed. Anything else, including an
 * unknown location, does not name the path.
 */
export function findingNamesPath(location: string | undefined, machinePath: string): boolean {
  const concrete = parseConcreteLocation(location);
  if (!concrete) return false;
  return concrete.path === machinePath;
}

export interface DeltaWithoutFindings {
  /** Delta files at least one prior finding location names. */
  readonly named: string[];
  /**
   * Delta files no prior finding location names. An absent or ambiguous
   * prior location cannot prove review, so it names nothing and the file
   * counts as unnamed (the full cumulative diff is then included up
   * front — more context is the safe direction).
   */
  readonly unnamed: string[];
}

/** Runner-computed fix-delta files that no prior finding location names. */
export function deltaFilesWithoutPriorFindings(
  deltaFiles: readonly string[],
  priorFindings: readonly Pick<PlanningFinding, "id" | "location">[],
): DeltaWithoutFindings {
  const named: string[] = [];
  const unnamed: string[] = [];
  for (const file of deltaFiles) {
    const known = priorFindings.some((finding) => findingNamesPath(finding.location, file));
    (known ? named : unnamed).push(file);
  }
  return { named, unnamed };
}

/** True when the fix delta touches files outside prior finding locations. */
export function isOverCorrection(delta: DeltaWithoutFindings): boolean {
  return delta.unnamed.length > 0;
}

/**
 * One verified unified-diff hunk: old/new start lines and counts with
 * git semantics (an omitted count means 1; a zero newCount marks a pure
 * deletion at newStart). Hunks are the ONLY line authority for the fix
 * delta: no line outside a hunk is called changed, and no line inside
 * one is called unchanged.
 */
export interface DeltaHunk {
  readonly oldStart: number;
  readonly oldCount: number;
  readonly newStart: number;
  readonly newCount: number;
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?: |$)/;

function plusHeaderPath(raw: string): string | undefined {
  // Structural new-side binding only: an unquoted `+++ b/<path>` drops
  // the one format-mandated prefix; C-quoted headers stay raw (they
  // then match nothing and stay blocking); /dev/null binds no file.
  // The header is sliced exactly — no trimming, so trailing spaces in
  // real filenames keep their identity.
  const header = raw.slice(4);
  if (header === "/dev/null") return undefined;
  if (header.startsWith('"')) return header;
  if (header.startsWith("b/")) return header.slice(2);
  return header;
}

/**
 * Verified fix-delta hunks per file from unified-diff bytes. Parses only
 * structural diff format (`diff --git` boundaries, `+++` headers, `@@`
 * headers). Unsupported sections contribute no hunks: unknown hunks
 * never authorize demotion.
 */
export function parseDiffHunks(diffText: string): Map<string, DeltaHunk[]> {
  const hunks = new Map<string, DeltaHunk[]>();
  let file: string | undefined;
  let inHunk = false;
  for (const raw of diffText.split(/\r\n?|\n/)) {
    if (raw.startsWith("diff --git ")) {
      file = undefined;
      inHunk = false;
      continue;
    }
    if (!inHunk && raw.startsWith("+++ ")) {
      file = plusHeaderPath(raw);
      continue;
    }
    const header = HUNK_HEADER.exec(raw);
    if (header) {
      if (file === undefined) {
        inHunk = false;
        continue;
      }
      const hunk: DeltaHunk = {
        oldStart: Number(header[1]),
        oldCount: header[2] === undefined ? 1 : Number(header[2]),
        newStart: Number(header[3]),
        newCount: header[4] === undefined ? 1 : Number(header[4]),
      };
      if (![hunk.oldStart, hunk.oldCount, hunk.newStart, hunk.newCount].every((n) => Number.isSafeInteger(n) && n >= 0)) {
        inHunk = false;
        continue;
      }
      hunks.set(file, [...(hunks.get(file) ?? []), hunk]);
      inHunk = true;
      continue;
    }
    if (!file || !inHunk) continue;
    // Hunk content lines carry no per-line hunk facts; headers do.
  }
  return hunks;
}

/**
 * New-side lines SHOWN in each file's diff hunks (context plus added
 * lines): the reviewer's actual line coverage of that diff surface.
 * Removed-only lines are old-side facts and never authorize a new-side
 * location. Same structural parsing as parseDiffHunks.
 */
export function parseShownLines(diffText: string): Map<string, number[]> {
  const lines = new Map<string, number[]>();
  let file: string | undefined;
  let next = 0;
  let inHunk = false;
  for (const raw of diffText.split(/\r\n?|\n/)) {
    if (raw.startsWith("diff --git ")) {
      file = undefined;
      inHunk = false;
      continue;
    }
    if (!inHunk && raw.startsWith("+++ ")) {
      file = plusHeaderPath(raw);
      continue;
    }
    const header = HUNK_HEADER.exec(raw);
    if (header) {
      if (file === undefined) {
        inHunk = false;
        continue;
      }
      next = Number(header[3]);
      if (!Number.isSafeInteger(next) || next < 0) {
        inHunk = false;
        continue;
      }
      inHunk = true;
      continue;
    }
    if (!file || !inHunk) continue;
    // Inside the content zone every +/- line is content: the ---/+++
    // headers were consumed before the first hunk, so an added "++..."
    // line still counts as shown. The "\ No newline" marker is not content.
    // A bare empty line is only the trailing split artifact (real content
    // lines always carry their one-character prefix); it must not mint a
    // phantom shown line past the end of the file.
    if (raw.length === 0) continue;
    if (raw.startsWith("+") || (!raw.startsWith("-") && !raw.startsWith("\\"))) {
      lines.set(file, [...(lines.get(file) ?? []), next]);
    }
    if (!raw.startsWith("-") && !raw.startsWith("\\")) next += 1;
  }
  return lines;
}

/**
 * Evidence ids the current review must treat as invalidated: every prior
 * cited id when the content tree moved (prior head != current head) or
 * when either tree is unknown. Tree/content identity is the only signal;
 * model prose never revalidates evidence. Only ids ride this list — never
 * finding text or claims.
 */
export function invalidatedEvidenceIds(
  priorEvidenceIds: readonly string[],
  priorHeadTree: string | undefined,
  currentHeadTree: string | undefined,
): string[] {
  const known = (tree: string | undefined): boolean =>
    typeof tree === "string" && (/^[a-f0-9]{40}$/.test(tree) || /^[a-f0-9]{64}$/.test(tree));
  if (!known(priorHeadTree) || !known(currentHeadTree) || priorHeadTree !== currentHeadTree) {
    return [...new Set(priorEvidenceIds)];
  }
  return [];
}

/** One authentic prior read range: the ACTUAL returned lines, never widened. */
export interface PriorReadRange {
  readonly path: string;
  readonly startLine: number;
  readonly endLine: number;
}

export interface LateFindingRuleContext {
  /** False on an initial review: the late rule never applies. */
  readonly isReReview: boolean;
  /**
   * Fix-delta files (prior reviewed head -> current head), byte-exact.
   * Undefined means unknown (no recorded delta): every finding stays
   * blocking. Never pass fallback/full-cumulative files here — an
   * unknown prior is fail-closed blocking, not a demotion surface.
   */
  readonly deltaFiles: readonly string[] | undefined;
  /**
   * Verified prior reviewed surface: prior cumulative changed files
   * from actual Git trees, byte-exact. Undefined means unknown: every
   * finding stays blocking. Read paths NEVER join this surface — a
   * ranged read authorizes only its range (see priorReadRanges).
   */
  readonly priorReviewedFiles: readonly string[] | undefined;
  /**
   * Verified fix-delta hunks per file, from verified diff bytes.
   * Absent, or a missing file entry, stays blocking: without hunk
   * correspondence no line is proven untouched.
   */
  readonly deltaHunks: Readonly<Record<string, readonly DeltaHunk[]>> | undefined;
  /**
   * Verified prior line coverage: new-side lines SHOWN in the prior
   * cumulative diff hunks, per file. A filename inventory never confers
   * line coverage: line-level findings need this or a read range.
   */
  readonly priorShownLines: Readonly<Record<string, readonly number[]>> | undefined;
  /**
   * Authentic prior read ranges (actual returned start/end lines).
   * Undefined means unknown: line authority then rests on shown lines
   * only. A range authorizes exactly its lines — never its whole file.
   */
  readonly priorReadRanges: readonly PriorReadRange[] | undefined;
  /** Failing test ids from THIS review's own FAILED runner report. */
  readonly failingTestIds: readonly string[] | undefined;
  /** True only when this review's own runner report actually failed. */
  readonly depthFailed: boolean;
  /**
   * Content hash of THIS review's stored report bytes. References, ids
   * and model claims alone cannot mint a failure: without stored bytes
   * the failing-test exception is denied.
   */
  readonly depthReportArtifactHash: string | undefined;
}

export interface LateFindingOutcome {
  readonly retained: PlanningFinding[];
  readonly followUp: PlanningFinding[];
}

/**
 * W2 late-finding rule (CD-4, S2 section 7.4): after the first review, a
 * NEW blocking finding is demoted to nonblocking follow-up only when it
 * is proven UNTOUCHED by the fix (outside every verified hunk with
 * intact old/new numbering — deletions, shifts, coverage and unknown
 * mappings stay blocking) AND proven REVIEWED (file membership for
 * file-level findings; verified line coverage for line-level findings)
 * AND it carries no valid exception (critical with explicit rationale,
 * or a failing-test basis bound to this review's stored failed report).
 * Changed, unreviewed and unknown surfaces stay blocking; reserved
 * runner facts are never filtered.
 */
export function applyLateFindingRule(
  findings: readonly PlanningFinding[],
  context: LateFindingRuleContext,
): LateFindingOutcome {
  const retained: PlanningFinding[] = [];
  const followUp: PlanningFinding[] = [];
  for (const finding of findings) {
    if (finding.severity !== "blocking") {
      retained.push(finding);
      continue;
    }
    if (isReservedReviewFindingId(finding.id)) {
      retained.push(finding);
      continue;
    }
    if (!context.isReReview || context.deltaFiles === undefined) {
      retained.push(finding);
      continue;
    }
    if (!isProvenUntouched(finding, context) || !isProvenReviewed(finding, context)) {
      retained.push(finding);
      continue;
    }
    // Unchanged already-reviewed code: only a valid exception stays blocking.
    if (isValidCriticalBasis(finding.lateFinding) || isValidFailingTestBasis(finding.lateFinding, context)) {
      retained.push(finding);
      continue;
    }
    followUp.push(finding);
  }
  return { retained, followUp };
}

/** A fix hunk covers a new-side line (a pure deletion covers its point). */
function hunkCovers(hunk: DeltaHunk, line: number): boolean {
  if (line < hunk.newStart) return false;
  if (hunk.newCount === 0) return line === hunk.newStart;
  return line < hunk.newStart + hunk.newCount;
}

/** A fix hunk lies entirely above a new-side line (and may shift it). */
function hunkAbove(hunk: DeltaHunk, line: number): boolean {
  return hunk.newStart + hunk.newCount <= line;
}

/**
 * Proven UNTOUCHED: the concrete file is outside the fix delta, or its
 * concrete line sits outside every verified fix hunk of its changed file
 * with zero net line shift above it. A covered line, a shifted line, a
 * file-level location on a changed file, and any missing or ambiguous
 * hunk mapping stay blocking. Never call a line untouched merely
 * because it was not added: deletions and structural shifts above or
 * around it void the proof.
 */
function isProvenUntouched(
  finding: PlanningFinding,
  context: LateFindingRuleContext,
): boolean {
  const concrete = parseConcreteLocation(finding.location);
  if (!concrete) return false;
  const deltaFiles = context.deltaFiles ?? [];
  const inChangedFile = deltaFiles.some((file) => file === concrete.path);
  if (!inChangedFile) return true;
  // Same-file correction elsewhere: only a concrete line outside every
  // verified hunk, with intact numbering above it, counts as untouched.
  if (concrete.line === undefined) return false;
  const hunks = context.deltaHunks?.[concrete.path];
  if (!hunks) return false;
  let shift = 0;
  for (const hunk of hunks) {
    if (hunkCovers(hunk, concrete.line)) return false;
    if (hunkAbove(hunk, concrete.line)) shift += hunk.oldCount - hunk.newCount;
  }
  return shift === 0;
}

/**
 * Proven REVIEWED, split by finding precision. File-level findings need
 * file membership in the verified prior surface (prior cumulative files
 * from actual Git trees — read paths never join). Line-level findings
 * need verified line coverage: a prior shown line or an authentic read
 * range covering the exact line. An untouched-but-unread line outside
 * the prior line surface stays blocking; a filename inventory never
 * confers line coverage.
 */
function isProvenReviewed(
  finding: PlanningFinding,
  context: LateFindingRuleContext,
): boolean {
  const concrete = parseConcreteLocation(finding.location);
  if (!concrete) return false;
  if (concrete.line === undefined) {
    if (context.priorReviewedFiles === undefined) return false;
    return context.priorReviewedFiles.some((file) => file === concrete.path);
  }
  const shown = context.priorShownLines?.[concrete.path];
  if (shown?.includes(concrete.line)) return true;
  const ranges = context.priorReadRanges;
  if (!ranges) return false;
  const line = concrete.line;
  return ranges.some((range) =>
    range.path === concrete.path && range.startLine <= line && line <= range.endLine,
  );
}

function isValidCriticalBasis(basis: PlanningFinding["lateFinding"]): boolean {
  return basis?.basis === "critical" &&
    CRITICAL_KINDS.has((basis as { criticalKind: string }).criticalKind) &&
    basis.rationale.trim().length > 0;
}

function isValidFailingTestBasis(
  basis: PlanningFinding["lateFinding"],
  context: LateFindingRuleContext,
): boolean {
  if (basis?.basis !== "failing_test") return false;
  // References, ids and model claims alone cannot fabricate a test
  // failure: every cited id must appear in this review's own FAILED
  // runner report whose bytes are content-stored (artifact hash), and
  // the claim needs an explicit rationale. Forged, foreign, successful
  // or byte-less evidence never authorizes the exception.
  if (!context.depthFailed || !context.failingTestIds) return false;
  if (typeof context.depthReportArtifactHash !== "string" || !/^[a-f0-9]{64}$/.test(context.depthReportArtifactHash)) return false;
  if (basis.rationale.trim().length === 0) return false;
  const failing = new Set(context.failingTestIds);
  return basis.testIds.length > 0 && basis.testIds.every((id) => failing.has(id));
}
