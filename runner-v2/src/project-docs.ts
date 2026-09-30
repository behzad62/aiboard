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
   * Docs policy v2 repair (C2b m5): the COMMIT tree holds CLAUDE.md as a
   * link (mode 120000) to AGENTS.md, so the pointer is satisfied through
   * the link although the committed blob holds no marked line.
   * Present-and-true only then. Read from the commit, never the checkout
   * (C2c NF-3).
   */
  claudePointerV2ViaAgentsLink?: boolean;
  /**
   * Docs policy v2 hardening (C2c NF-2/CD-15): the COMMIT tree holds the
   * entry file as a link whose regular-file target blob holds the marked
   * section (AGENTS.md) or line (CLAUDE.md) -- the runner wrote the
   * section into the target path directly, never through the link.
   * Present-and-true only then. Read from the commit, never the checkout.
   */
  agentsSectionV2ViaLink?: boolean;
  claudePointerV2ViaLink?: boolean;
  /**
   * Docs policy v2 hardening (C2c NF-2/CD-15): the COMMIT tree holds the
   * entry file as a link (mode 120000); the value is the raw link-target
   * text. Present only then. A link to a missing or outside target
   * carries no ViaLink flag above; the runner skips that entry file with
   * a recorded reason instead, and the AR-R05 gate accepts the reason.
   */
  agentsLinkTarget?: string;
  claudeLinkTarget?: string;
  /**
   * Docs policy v2 hardening (C2d repair cycle 1, escalation): the COMMIT
   * tree tracks two spellings of the entry file (say `AGENTS.md` and
   * `agents.md`), so the runner skips that entry file with a recorded
   * reason instead of wedging on it, and the AR-R05 gate accepts the
   * reason. Present only then (two or more distinct spellings, in commit
   * tree order). Read from the commit, never the checkout.
   */
  agentsCollisionSpellings?: readonly string[];
  claudeCollisionSpellings?: readonly string[];
}

export interface ProjectDocCommitResult {
  /** True when the commit was found by key and reused, never duplicated. Absent means freshly committed. */
  reused?: boolean;
  /**
   * Docs policy v2 hardening (C2c NF-2/CD-15): entry-file writes the
   * runner redirected into the link target path instead of writing
   * through the link. Absent means nothing was redirected.
   */
  redirected?: Array<{ path: string; target: string; reason: string }>;
  /** Writes skipped with a recorded reason (never silent). Absent means nothing was skipped. */
  skipped?: Array<{ path: string; reason: string }>;
  /**
   * Docs policy v2 hardening (C2c repair CD-17, cycle 2): the STATE.md
   * ancestor-or-self components (docs, docs/project, docs/project/STATE.md
   * itself) the COMMIT tree holds as links (mode 120000), in first-link
   * order. The runtime derives every skipped-STATE.md reason from these
   * through describeSnapshotCommitFacts. Absent means none. Read from the
   * commit, never the checkout (case-folded where the checkout is
   * case-insensitive).
   */
  dirLinks?: string[];
  /**
   * C2e repair cycle 1 (N-1): the kind of the first commit-tree STATE.md
   * blocker, present only for a non-link, non-collision blocker (a
   * regular file, a submodule entry or a directory). The runtime records
   * the accurate skip reason from this; absent means the legacy link
   * wording. Read from the commit, never the checkout. Additive: older
   * callers simply omit it.
   */
  stateBlockerKind?: HandoffStateBlockerKind;
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

/**
 * C2c repair cycle 2 (NB-1, NB-2, m-1, m-3, m-4): the path of the handoff
 * STATE.md file all snapshot paths share.
 */
export const HANDOFF_STATE_PATH = "docs/project/STATE.md";

/**
 * C2c repair cycle 2: the STATE.md ancestor-or-self components, in
 * first-link order. Only these back a STATE.md skip (m-1: specs is not an
 * ancestor of STATE.md, so it never does).
 */
export const HANDOFF_STATE_LINK_COMPONENTS: readonly string[] = [
  "docs",
  "docs/project",
  "docs/project/STATE.md",
];

/**
 * C2c repair cycle 2 (m-4): the recorded STATE.md skip for one commit-tree
 * link component. The single wording source for the fresh path, the
 * commit-reuse path and the withdrawn-stop path.
 *
 * Frozen: stored logs already carry this sentence, so it never changes;
 * new blockers get their own wording below and old records keep reading
 * through this function.
 */
export function handoffStateSkipReason(linkComponent: string): string {
  return `${HANDOFF_STATE_PATH} is not written: ${linkComponent} is a symbolic link or junction; the handoff proceeds without it.`;
}

/**
 * C2e repair cycle 1 (N-1): the kind of a commit-tree STATE.md blocker
 * that is not a link. Only these three kinds travel forward; links and
 * case collisions keep the legacy wording above so stored logs replay
 * unchanged.
 */
export type HandoffStateBlockerKind = "file" | "submodule" | "directory";

/**
 * C2e repair cycle 1 (N-1): the recorded STATE.md skip for one commit-tree
 * non-link blocker, naming the blocker accurately. The single wording
 * source for the fresh path, the commit-reuse path and the withdrawn-stop
 * path -- every path takes the kind from the commit tree, so all three
 * record the same sentence.
 */
export function handoffStateBlockerSkipReason(component: string, kind: HandoffStateBlockerKind): string {
  if (kind === "file") {
    return `${HANDOFF_STATE_PATH} is not written: ${component} is a regular file, not a directory; the handoff proceeds without it.`;
  }
  if (kind === "submodule") {
    return `${HANDOFF_STATE_PATH} is not written: ${component} is a submodule entry; the handoff proceeds without it.`;
  }
  return `${HANDOFF_STATE_PATH} is not written: ${component} is a directory; the handoff proceeds without it.`;
}

/**
 * C2c repair cycle 2 (NB-1, m-4): the recorded CLAUDE.md self-import
 * omission (repair M-6). AGENTS.md resolves into CLAUDE.md, so merging the
 * `@AGENTS.md` pointer there would import the file into itself; the merged
 * AGENTS.md section satisfies both entry lines instead.
 */
export const HANDOFF_CLAUDE_SELF_IMPORT_OMISSION =
  "CLAUDE.md pointer omitted: AGENTS.md resolves to CLAUDE.md, so @AGENTS.md here would import the file into itself; the AGENTS.md section satisfies both entry lines.";

/**
 * C2c repair cycle 2 (m-4): the generic commit-tree entry skip for a link
 * whose target blob holds no marked section or line. The single wording
 * source for every path that re-describes a skip from the tree.
 */
/**
 * C2d repair cycle 1 (escalation): the recorded skip for an entry file
 * the commit tree tracks under two spellings. The single wording source
 * for the stager and the tree re-description, so a fresh commit and a
 * reused commit of the same layout record the same reason.
 */
export function handoffEntryCollisionSkipReason(entryPath: "AGENTS.md" | "CLAUDE.md", firstSpelling: string, secondSpelling: string): string {
  return `${entryPath} is not written: the commit tree tracks both ${firstSpelling} and ${secondSpelling}; the handoff proceeds without it.`;
}

export function handoffEntryGenericSkipReason(entryPath: "AGENTS.md" | "CLAUDE.md", rawTarget: string): string {
  const line = entryPath === "AGENTS.md" ? "marked section" : "marked line";
  return `${entryPath} is a symbolic link to ${rawTarget}; the entry is skipped (the target holds no ${line}).`;
}

/**
 * C2c repair cycle 2: the commit-tree redirect wording for an entry file
 * whose regular-file target blob holds the marked section or line.
 */
export function handoffEntryRedirectReason(entryPath: "AGENTS.md" | "CLAUDE.md", target: string): string {
  return `${entryPath} is a symbolic link to ${target}; the section is written into ${target}.`;
}

/**
 * C2c repair cycle 2: resolve a raw entry-file link target to a
 * repository-relative path, or null when it escapes or is unusable.
 * Dot-only spellings ("./AGENTS.md") resolve to the sibling; an absolute
 * path, a drive-letter path, or any ".." escape is never followed.
 * Backslashes normalize to slashes first (git for Windows stores real-link
 * targets like "docs\notes.md"). Shared by the stager and the describer so
 * both spell the same target.
 */
export function resolveHandoffLinkTarget(target: string): string | null {
  const trimmed = target.trim().replace(/\\/g, "/");
  if (!trimmed || trimmed.includes("\0")) return null;
  if (trimmed.startsWith("/")) return null;
  if (/^[A-Za-z]:/.test(trimmed)) return null;
  const parts: string[] = [];
  for (const segment of trimmed.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") return null;
    parts.push(segment);
  }
  if (parts.length === 0) return null;
  return parts.join("/");
}

/**
 * C2c repair cycle 2 (NB-1): true when a raw commit-tree link target names
 * the sibling CLAUDE.md ("CLAUDE.md" and dot-only spellings, with the
 * backslash normalization; never an escape, an absolute path, or a
 * drive-letter path). Shared by the describer and the runtime gate helper.
 */
export function handoffLinkRawTargetsClaudeDotMd(rawTarget: string): boolean {
  const normalized = rawTarget.trim().replace(/\\/g, "/");
  if (!normalized || normalized.includes("\0")) return false;
  if (normalized.startsWith("/")) return false;
  if (/^[A-Za-z]:/.test(normalized)) return false;
  const parts: string[] = [];
  for (const segment of normalized.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") return false;
    parts.push(segment);
  }
  // C2d repair cycle 1 (B3): the identity folds case -- a redirect into
  // the index's own `claude.md` spelling counts the way `CLAUDE.md` does.
  // The fold applies only to this comparison; the caller still requires
  // the exact index entry (never a substituted spelling).
  return parts.length === 1 && (parts[0] ?? "").toLowerCase() === "claude.md";
}

/** Inputs to the single snapshot-commit describer. */
export interface SnapshotCommitDescriptionInput {
  entryPoint: ProjectDocCommitResult["entryPoint"];
  /** The commit's real paths (the read-back, fresh or reused). */
  storedPaths: readonly string[];
  /**
   * The first STATE.md ancestor-or-self link from the COMMIT tree
   * (expected spelling), if any. Case-folded where the checkout is
   * case-insensitive, including STATE.md itself.
   */
  commitStateLink?: string;
  /**
   * C2e repair cycle 1 (N-1): the kind of the first commit-tree STATE.md
   * blocker, when it is a regular file, a submodule entry or a
   * directory. Present only then; absent (links, collisions, older
   * callers) keeps the legacy link wording so stored logs replay
   * unchanged.
   */
  commitStateBlockerKind?: HandoffStateBlockerKind;
  /** Stage-time skips: kept only when the commit tree corroborates the link. */
  stageSkipped?: ReadonlyArray<{ path: string; reason: string }>;
  /** Stage-time redirects: kept only when the commit tree proves the ViaLink. */
  stageRedirected?: ReadonlyArray<{ path: string; target: string; reason: string }>;
}

/** Every recorded fact about one snapshot commit, derived from its tree. */
export interface SnapshotCommitDescription {
  stateChanged: boolean;
  stateSkippedReason?: string;
  agentsSkip?: string;
  claudeSkip?: string;
  agentsRedirect?: string;
  agentsRedirectTarget?: string;
  claudeRedirect?: string;
}

/**
 * C2c repair cycle 2 (NB-1, NB-2, m-1, m-3, m-4): the ONE describer. Given
 * a snapshot commit, derive every recorded fact from the COMMIT TREE (plus
 * the stop's stage-time inputs, which may only confirm the tree, never
 * replace it):
 * - STATE.md is recorded as written, or skipped with the canonical reason
 *   for the tree's first ancestor-or-self link (STATE.md itself counts).
 *   A case-colliding component (say `docs` with `Docs`, C2d repair cycle
 *   1) reports the same way through the shared reason. A stage-time
 *   reason alone -- an out-of-band junction the tree never held --
 *   records nothing, so the caller pauses fail-closed (m-3); a committed
 *   STATE.md never carries a reason (m-1).
 * - Each entry file keeps its stage-time reason only when the tree holds
 *   the link; otherwise the skip (and the M-6 omission, NB-1) is
 *   re-described from the tree in the single wording (m-4).
 * - A redirect reason counts only with its ViaLink proof, re-described
 *   from the tree when the stop carries no stage-time record (reuse).
 * The fresh path, the commit-reuse path and the withdrawn-stop path all
 * call this, so every reuse layout shares one derivation.
 */
export function describeSnapshotCommitFacts(input: SnapshotCommitDescriptionInput): SnapshotCommitDescription {
  const stateChanged = input.storedPaths.includes(HANDOFF_STATE_PATH);
  // C2e repair cycle 1 (N-1): a file, submodule or directory blocker is
  // recorded with its accurate wording; anything else (links, collisions,
  // older callers) keeps the legacy wording, so stored logs replay
  // unchanged.
  const stateSkippedReason = !stateChanged && input.commitStateLink !== undefined
    ? input.commitStateBlockerKind !== undefined
      ? handoffStateBlockerSkipReason(input.commitStateLink, input.commitStateBlockerKind)
      : handoffStateSkipReason(input.commitStateLink)
    : undefined;
  const stageSkipFor = (path: string): string | undefined =>
    input.stageSkipped?.find((entry) => entry.path === path)?.reason;
  const stageRedirectFor = (path: string): { target: string; reason: string } | undefined => {
    const found = input.stageRedirected?.find((entry) => entry.path === path);
    return found === undefined ? undefined : { target: found.target, reason: found.reason };
  };
  const agentsLink = input.entryPoint.agentsLinkTarget;
  const claudeLink = input.entryPoint.claudeLinkTarget;
  const agentsIntoClaude = agentsLink !== undefined
    && handoffLinkRawTargetsClaudeDotMd(agentsLink)
    && input.entryPoint.agentsSectionV2ViaLink === true;
  let agentsRedirect: string | undefined;
  let agentsRedirectTarget: string | undefined;
  if (input.entryPoint.agentsSectionV2ViaLink === true && agentsLink !== undefined) {
    const stage = stageRedirectFor("AGENTS.md");
    if (stage !== undefined) {
      agentsRedirect = stage.reason;
      agentsRedirectTarget = stage.target;
    } else {
      const target = resolveHandoffLinkTarget(agentsLink);
      if (target !== null) {
        agentsRedirect = handoffEntryRedirectReason("AGENTS.md", target);
        agentsRedirectTarget = target;
      }
    }
  }
  let claudeRedirect: string | undefined;
  if (input.entryPoint.claudePointerV2ViaLink === true && claudeLink !== undefined) {
    const stage = stageRedirectFor("CLAUDE.md");
    if (stage !== undefined) {
      claudeRedirect = stage.reason;
    } else {
      const target = resolveHandoffLinkTarget(claudeLink);
      if (target !== null) {
        claudeRedirect = handoffEntryRedirectReason("CLAUDE.md", target);
      }
    }
  }
  // C2d repair cycle 1 (escalation): a stage-time collision skip counts
  // only when the commit tree corroborates the two spellings, exactly
  // like a link skip counts only with its link. Without a stage-time
  // record (a reuse describing an older commit) the same wording is
  // re-derived from the tree, so fresh and reused commits agree.
  const agentsCollision = input.entryPoint.agentsCollisionSpellings ?? [];
  const agentsCollisionReason = agentsCollision.length > 1 && agentsCollision[0] !== undefined && agentsCollision[1] !== undefined
    ? handoffEntryCollisionSkipReason("AGENTS.md", agentsCollision[0], agentsCollision[1])
    : undefined;
  const agentsStageSkip = stageSkipFor("AGENTS.md");
  const agentsSkip = agentsStageSkip !== undefined && (agentsLink !== undefined || agentsCollisionReason !== undefined)
    ? agentsStageSkip
    : agentsLink !== undefined
      ? handoffEntryGenericSkipReason("AGENTS.md", agentsLink)
      : agentsCollisionReason;
  const claudeCollision = input.entryPoint.claudeCollisionSpellings ?? [];
  const claudeCollisionReason = claudeCollision.length > 1 && claudeCollision[0] !== undefined && claudeCollision[1] !== undefined
    ? handoffEntryCollisionSkipReason("CLAUDE.md", claudeCollision[0], claudeCollision[1])
    : undefined;
  const claudeStageSkip = stageSkipFor("CLAUDE.md");
  let claudeSkip: string | undefined;
  if (claudeStageSkip !== undefined && (claudeLink !== undefined || agentsIntoClaude || claudeCollisionReason !== undefined)) {
    claudeSkip = claudeStageSkip;
  } else if (claudeLink !== undefined) {
    claudeSkip = handoffEntryGenericSkipReason("CLAUDE.md", claudeLink);
  } else if (agentsIntoClaude) {
    claudeSkip = HANDOFF_CLAUDE_SELF_IMPORT_OMISSION;
  } else {
    claudeSkip = claudeCollisionReason;
  }
  return {
    stateChanged,
    ...(stateSkippedReason !== undefined ? { stateSkippedReason } : {}),
    ...(agentsSkip !== undefined ? { agentsSkip } : {}),
    ...(claudeSkip !== undefined ? { claudeSkip } : {}),
    ...(agentsRedirect !== undefined ? { agentsRedirect } : {}),
    ...(agentsRedirectTarget !== undefined ? { agentsRedirectTarget } : {}),
    ...(claudeRedirect !== undefined ? { claudeRedirect } : {}),
  };
}
function normalizeDocWhitespace(value: string): string {
  return value.replace(/[ \t\r\n]+/g, " ").trim();
}
