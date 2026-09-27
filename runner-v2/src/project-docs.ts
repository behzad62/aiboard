/**
 * Architect project-documentation constants, templates, marker splice,
 * and entry-point statement checks. Filesystem and git stay in
 * IntegrationManager so this module does not become a filesystem owner.
 */

export const PROJECT_DOCS_ROOT = "docs/project/";

export const AGENTS_SECTION_START = "<!-- aiboard:architect:start -->";
export const AGENTS_SECTION_END = "<!-- aiboard:architect:end -->";

export const DOCS_MARKER_HOLDS = "<!-- aiboard:docs:holds -->";
export const DOCS_MARKER_READ_FIRST = "<!-- aiboard:docs:read-first -->";
export const DOCS_MARKER_UPDATE = "<!-- aiboard:docs:update -->";

export const DOCS_LAYOUT_LINES: readonly string[] = Object.freeze([
  "- `docs/project/README.md` — how this documentation works and the rules every agent follows.",
  "- `docs/project/STATE.md` — where the project stands now and the next action.",
  "- `docs/project/specs/` — approved specifications and their amendments.",
  "- `docs/project/plans/` — implementation plans, requirements and tasks.",
  "- `docs/project/decisions.md` — decisions and the reason for each.",
  "- `docs/project/evidence/` — proof that work was verified.",
]);

export const DOCS_READ_FIRST_SENTENCE =
  "Before any work on this project, read `docs/project/README.md` and `docs/project/STATE.md`.";

export const DOCS_UPDATE_SENTENCE =
  "Keep specs, plans and decisions current as they change; update `STATE.md` last, with where things stand and the next action.";

export const CLAUDE_POINTER_LINE = "See AGENTS.md for this project's documentation rules.";

/**
 * Docs policy v2 (C2b, AR-R04): the static AGENTS.md marked-section body the
 * kernel writes at every handoff commit. Plain prose, no markers: the splice
 * wraps it in AGENTS_SECTION_START/END. The v1 body and checks below are
 * unchanged (legacy-planning runs keep docs v1 exactly).
 */
export const V2_AGENTS_SECTION_BODY = "This project was built with AIBoard. Read docs/project/STATE.md first: it is a generated snapshot and names the exact revision it describes; changes after that revision are in git log. You do not need to keep a journal. If you finish an item listed under Open work, you may tick it in the same commit.";

/** Docs policy v2 (C2b): the marked CLAUDE.md line, the documented import form. */
export const V2_CLAUDE_POINTER_LINE = "@AGENTS.md";

export const DEFAULT_AGENTS_SECTION_BODY = [
  DOCS_MARKER_HOLDS,
  ...DOCS_LAYOUT_LINES,
  DOCS_MARKER_READ_FIRST,
  DOCS_READ_FIRST_SENTENCE,
  DOCS_MARKER_UPDATE,
  DOCS_UPDATE_SENTENCE,
].join("\n");

export const DEFAULT_README_TEMPLATE = [
  "# Project documentation",
  "",
  "How this documentation works, and the rules every agent follows.",
  "",
  ...DOCS_LAYOUT_LINES,
  "",
  DOCS_READ_FIRST_SENTENCE,
  "",
  DOCS_UPDATE_SENTENCE,
].join("\n");

export const DEFAULT_STATE_TEMPLATE = [
  "# State",
  "",
  "## Where things stand",
  "",
  "## Next action",
].join("\n");

/** 256 KiB. One write, measured in UTF-8 bytes. */
export const PROJECT_DOC_MAX_BYTES = 262144;

export type ProjectDocPathRefusal =
  | "empty"
  | "nul"
  | "absolute"
  | "backslash"
  | "trailing_slash"
  | "empty_segment"
  | "parent"
  | "dot_segment"
  | "case_variant"
  | "not_admitted";

export type ProjectDocPathResult =
  | { ok: true; path: string }
  | { ok: false; reason: ProjectDocPathRefusal };

/**
 * Deterministic id for one project-document request.
 * `logSequence` is the scheduler log position the append will occupy
 * (`projection.lastSequence + 1`, read immediately before the append).
 * The same log position and path always produce the same id, so the
 * reducer rejects a replay of that request. A later write in the same
 * Architect turn occupies the next log position and gets a different id.
 */
export function projectDocRequestId(logSequence: number, path: string): string {
  return `project-doc:${logSequence}:${path}`;
}

/**
 * Pure lexical admission. Symlinks are not visible here; A5 checks them
 * with lstat when the request is committed.
 */
export function validateProjectDocPath(input: string): ProjectDocPathResult {
  if (typeof input !== "string" || input.length === 0) {
    return { ok: false, reason: "empty" };
  }
  if (input.includes("\0")) return { ok: false, reason: "nul" };
  if (isAbsoluteProjectDocPath(input)) return { ok: false, reason: "absolute" };
  if (input.includes("\\")) return { ok: false, reason: "backslash" };
  if (input.endsWith("/")) return { ok: false, reason: "trailing_slash" };
  const segments = input.split("/");
  if (segments.some((segment) => segment.length === 0)) {
    return { ok: false, reason: "empty_segment" };
  }
  if (segments.some((segment) => segment === "..")) {
    return { ok: false, reason: "parent" };
  }
  if (segments.some((segment) => segment === ".")) {
    return { ok: false, reason: "dot_segment" };
  }
  const canonical = canonicalProjectDocPath(input);
  if (canonical === null) return { ok: false, reason: "not_admitted" };
  if (rejectsCaseVariant(input, canonical)) {
    return { ok: false, reason: "case_variant" };
  }
  return { ok: true, path: canonical };
}

function rejectsCaseVariant(input: string, canonical: string): boolean {
  return input !== canonical;
}

function canonicalProjectDocPath(path: string): string | null {
  const lower = path.toLowerCase();
  if (lower === "agents.md") return "AGENTS.md";
  if (lower === "claude.md") return "CLAUDE.md";
  if (!lower.startsWith(PROJECT_DOCS_ROOT)) return null;
  const remainder = path.slice(PROJECT_DOCS_ROOT.length);
  if (!isProjectDocFileRemainder(remainder)) return null;
  return `${PROJECT_DOCS_ROOT}${remainder}`;
}

function isProjectDocFileRemainder(remainder: string): boolean {
  if (remainder.length === 0 || remainder.endsWith("/")) return false;
  return remainder.split("/").every((segment) =>
    segment.length > 0 && segment !== "." && segment !== ".."
  );
}

function isAbsoluteProjectDocPath(path: string): boolean {
  return path.startsWith("/") || path.startsWith("\\") || /^[A-Za-z]:/.test(path);
}

export interface ProjectDocWrite {
  path: string;
  content: string;
}

export interface ProjectDocCommitRequest {
  writes: readonly ProjectDocWrite[];
  summary: string;
  runId: string;
  requestId: string;
}

export interface ProjectDocEntryPointFacts {
  readme: boolean;
  agentsMarkedSection: boolean;
  claudePointer: boolean;
  /**
   * Docs policy v2 (C2b): the committed tree holds the static v2 AGENTS.md
   * section and the marked `@AGENTS.md` line. Read from the commit, never
   * the checkout. The v1 fields above are unchanged.
   */
  agentsMarkedSectionV2: boolean;
  claudePointerV2: boolean;
  /**
   * Docs policy v2 repair (C2b m5): the worktree CLAUDE.md is a symbolic link
   * to AGENTS.md, so the pointer is satisfied through the link although the
   * committed blob holds no marked line. Present-and-true only then.
   */
  claudePointerV2ViaAgentsLink?: boolean;
}

export interface ProjectDocCommitResult {
  /** True when the commit was found by key and reused, never duplicated. Absent means freshly committed. */
  reused?: boolean;
  /** Writes skipped with a recorded reason (never silent). Absent means nothing was skipped. */
  skipped?: Array<{ path: string; reason: string }>;
  commit: string;
  parent: string;
  head: string;
  entryPoint: ProjectDocEntryPointFacts;
}

export type DocumentTipRelation = "strict_descendant" | "equal_to_tip" | "ancestor";

const DOC_STATEMENT_MARKERS = [
  DOCS_MARKER_HOLDS,
  DOCS_MARKER_READ_FIRST,
  DOCS_MARKER_UPDATE,
] as const;

/**
 * Replace the marked Architect section, or append one when the file has no
 * start/end pair. Bytes outside the markers are unchanged.
 */
export function spliceMarkedArchitectSection(existing: string, body: string): string {
  const start = existing.indexOf(AGENTS_SECTION_START);
  const end = start < 0
    ? -1
    : existing.indexOf(AGENTS_SECTION_END, start + AGENTS_SECTION_START.length);
  if (start >= 0 && end > start) {
    return existing.slice(0, start + AGENTS_SECTION_START.length)
      + "\n"
      + body
      + "\n"
      + existing.slice(end);
  }
  const separator = existing.length === 0 || existing.endsWith("\n") ? "" : "\n";
  return `${existing}${separator}${AGENTS_SECTION_START}\n${body}\n${AGENTS_SECTION_END}\n`;
}

/**
 * Byte-level marked-section splice for entry files on disk (C2b repair m3).
 * The markers and every section body the kernel or Architect writes are
 * ASCII, so the marker search runs on raw bytes: bytes outside the markers
 * survive untouched, including files that are not valid UTF-8. The inserted
 * section uses the file's own line ending (CRLF when the file holds a CRLF,
 * otherwise LF), so no mixed endings are introduced. A missing or empty file
 * is created with just the section (LF). The string overload above keeps its
 * exact behavior for in-memory callers; only file writes go through this.
 */
export function spliceMarkedArchitectSectionBytes(existing: Buffer | null, body: string): Buffer {
  const startMarker = Buffer.from(AGENTS_SECTION_START, "ascii");
  const endMarker = Buffer.from(AGENTS_SECTION_END, "ascii");
  const bodyForNewline = (newline: Buffer): Buffer => {
    // C2b repair N-5: a multi-line body takes the file's own line ending, so
    // a CRLF file never gains lone LF lines from the inserted section.
    const text = newline.equals(Buffer.from("\r\n", "ascii"))
      ? body.replace(/\r\n/g, "\n").replace(/\n/g, "\r\n")
      : body;
    return Buffer.from(text, "utf8");
  };
  if (existing === null || existing.length === 0) {
    const created = bodyForNewline(Buffer.from("\n", "ascii"));
    return Buffer.concat([
      startMarker,
      Buffer.from("\n", "ascii"),
      created,
      Buffer.from("\n", "ascii"),
      endMarker,
      Buffer.from("\n", "ascii"),
    ]);
  }
  const newline: Buffer = existing.includes(Buffer.from("\r\n", "ascii"))
    ? Buffer.from("\r\n", "ascii")
    : Buffer.from("\n", "ascii");
  const bodyBytes = bodyForNewline(newline);
  const start = existing.indexOf(startMarker);
  const end = start < 0 ? -1 : existing.indexOf(endMarker, start + startMarker.length);
  if (start >= 0 && end > start) {
    return Buffer.concat([
      existing.subarray(0, start + startMarker.length),
      newline,
      bodyBytes,
      newline,
      existing.subarray(end),
    ]);
  }
  const needsSeparator = existing[existing.length - 1] !== 0x0a;
  return Buffer.concat([
    existing,
    ...(needsSeparator ? [newline] : []),
    startMarker,
    newline,
    bodyBytes,
    newline,
    endMarker,
    newline,
  ]);
}

/** True when the marked AGENTS.md section contains each statement under its own marker. */
export function agentsMarkedSectionSatisfies(content: string): boolean {
  const section = architectSectionBody(content);
  if (section === null) return false;
  if (DOC_STATEMENT_MARKERS.some((marker) => !section.includes(marker))) return false;
  const holds = statementSpan(section, DOCS_MARKER_HOLDS);
  const readFirst = statementSpan(section, DOCS_MARKER_READ_FIRST);
  const update = statementSpan(section, DOCS_MARKER_UPDATE);
  if (holds === null || readFirst === null || update === null) return false;
  if (!DOCS_LAYOUT_LINES.every((line) => containsNormalized(holds, line))) return false;
  if (!containsNormalized(readFirst, DOCS_READ_FIRST_SENTENCE)) return false;
  if (!containsNormalized(update, DOCS_UPDATE_SENTENCE)) return false;
  return true;
}

/** True when the marked AGENTS.md section holds the static docs-v2 body. */
export function agentsMarkedSectionSatisfiesV2(content: string): boolean {
  const section = architectSectionBody(content);
  if (section === null) return false;
  return section.includes(V2_AGENTS_SECTION_BODY);
}

/** True when the marked CLAUDE.md section holds the `@AGENTS.md` line. */
export function claudePointerSatisfiesV2(content: string): boolean {
  const section = architectSectionBody(content);
  if (section === null) return false;
  return section.split("\n").some((line) => line.trim() === V2_CLAUDE_POINTER_LINE);
}

/** True when the marked CLAUDE.md section contains the documentation pointer. */
export function claudePointerSatisfies(content: string): boolean {
  const section = architectSectionBody(content);
  if (section === null) return false;
  return containsNormalized(section, CLAUDE_POINTER_LINE);
}

function architectSectionBody(content: string): string | null {
  const start = content.indexOf(AGENTS_SECTION_START);
  if (start < 0) return null;
  const end = content.indexOf(AGENTS_SECTION_END, start + AGENTS_SECTION_START.length);
  if (end < 0) return null;
  return content.slice(start + AGENTS_SECTION_START.length, end);
}

function statementSpan(section: string, marker: string): string | null {
  const at = section.indexOf(marker);
  if (at < 0) return null;
  const from = at + marker.length;
  let next = section.length;
  for (const other of DOC_STATEMENT_MARKERS) {
    const pos = section.indexOf(other, from);
    if (pos >= 0 && pos < next) next = pos;
  }
  return section.slice(from, next);
}

function containsNormalized(span: string, statement: string): boolean {
  return normalizeDocWhitespace(span).includes(normalizeDocWhitespace(statement));
}

function normalizeDocWhitespace(value: string): string {
  return value.replace(/[ \t\r\n]+/g, " ").trim();
}
