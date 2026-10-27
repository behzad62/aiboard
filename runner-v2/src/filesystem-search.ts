import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { AgentActor } from "./agent-contracts.js";

/**
 * Resumable content search (N3). A search session freezes its candidate file list (the declared
 * snapshot) and its start instant. Later pages continue that exact list; a candidate modified or
 * removed after the session started makes the session `stale` instead of mixing revisions. Matches
 * are retained (bounded) so a page can be re-fetched with the same cursor and pages never repeat or
 * skip matches within one stable generation.
 */
export const SEARCH_LIMITS = Object.freeze({
  /** Retained matches per session; reaching it yields state "capped" (not exhaustive). */
  maxRetainedMatches: 5_000,
  maxRetainedBytes: 8 * 1024 * 1024,
  /** Scan work per page before returning with a continuation (state "running"). */
  pageTimeMs: 8_000,
  pageScanBytes: 64 * 1024 * 1024,
  /** Whole-session scan time across pages; exceeding it yields "timed_out". */
  sessionScanTimeMs: 120_000,
  /** Files larger than this are skipped and counted, never read. */
  maxFileBytes: 16 * 1024 * 1024,
  maxLineChars: 2_000,
  maxContextLines: 5,
  maxSessions: 8,
  idleExpiryMs: 15 * 60_000,
  maxGlobs: 32,
});

export type SearchState = "running" | "complete" | "capped" | "cancelled" | "timed_out" | "stale" | "expired" | "failed";

export interface SearchMatch {
  readonly path: string;
  readonly line: number;
  readonly column: number;
  readonly text: string;
  readonly textTruncated?: boolean;
  readonly before?: readonly string[];
  readonly after?: readonly string[];
}

export interface SearchSkipCounts {
  ignored: number;
  generated: number;
  vendored: number;
  binary: number;
  hidden: number;
  excluded: number;
  tooLarge: number;
  unreadable: number;
  notText: number;
}

export interface SearchQuery {
  readonly root: string;
  readonly pattern: string;
  readonly regex: boolean;
  readonly caseSensitive: boolean;
  readonly include: readonly string[];
  readonly exclude: readonly string[];
  readonly contextLines: number;
  readonly flags: Readonly<Record<"includeIgnored" | "includeGenerated" | "includeVendored" | "includeBinary", boolean>>;
}

export interface SearchCandidate { readonly absolutePath: string; readonly displayPath: string }

export interface SearchSession {
  readonly id: string;
  readonly owner: Readonly<{ runId: string; sessionId: string; actor: AgentActor }>;
  readonly queryDigest: string;
  readonly createdAtMs: number;
  readonly source: "git" | "filesystem" | "file";
  readonly snapshotTruncated: boolean;
  readonly candidates: readonly SearchCandidate[];
  readonly matches: SearchMatch[];
  readonly skipped: SearchSkipCounts;
  readonly errors: string[];
  position: number;
  retainedBytes: number;
  scanned: number;
  scanMs: number;
  lastUsedMs: number;
  state: SearchState;
  /** Matches in the file currently being consumed that did not fit the retained cap. */
  overflow: boolean;
}

export function normalizedQueryDigest(query: SearchQuery): string {
  return createHash("sha256").update(JSON.stringify({ ...query, include: [...query.include].sort(), exclude: [...query.exclude].sort() })).digest("hex");
}

export function emptySkipCounts(): SearchSkipCounts {
  return { ignored: 0, generated: 0, vendored: 0, binary: 0, hidden: 0, excluded: 0, tooLarge: 0, unreadable: 0, notText: 0 };
}

export class SearchSessionStore {
  private readonly sessions = new Map<string, SearchSession>();
  private readonly key = randomBytes(32);
  constructor(private readonly clock: () => number = () => Date.now()) {}

  create(input: Omit<SearchSession, "id" | "matches" | "skipped" | "errors" | "position" | "retainedBytes" | "scanned" | "scanMs" | "lastUsedMs" | "state" | "overflow" | "createdAtMs"> & { skipped?: SearchSkipCounts }): SearchSession {
    this.sweep();
    while (this.sessions.size >= SEARCH_LIMITS.maxSessions) {
      const oldest = [...this.sessions.values()].sort((left, right) => left.lastUsedMs - right.lastUsedMs)[0]!;
      this.sessions.delete(oldest.id);
    }
    const now = this.clock();
    const session: SearchSession = { ...input, id: randomUUID(), createdAtMs: now, matches: [], skipped: input.skipped ?? emptySkipCounts(), errors: [],
      position: 0, retainedBytes: 0, scanned: 0, scanMs: 0, lastUsedMs: now, state: "running", overflow: false };
    this.sessions.set(session.id, session);
    return session;
  }

  /** Resolve a cursor to its session. Expired/unknown sessions are typed, never "no matches". */
  resume(cursor: string, owner: SearchSession["owner"], queryDigest: string): { session: SearchSession; offset: number } {
    const { sessionId, offset, digest } = this.decode(cursor);
    if (digest !== queryDigest.slice(0, 16)) throw new SearchError("search_cursor_mismatch", "This cursor belongs to a different query; repeat the original path, pattern and options with it.");
    this.sweep();
    const session = this.sessions.get(sessionId);
    if (!session) throw new SearchError("search_expired", "This search session expired or was evicted; start the search again (results are not exhaustive until a new search completes).");
    if (session.owner.runId !== owner.runId || session.owner.sessionId !== owner.sessionId || session.owner.actor.role !== owner.actor.role || session.owner.actor.id !== owner.actor.id)
      throw new SearchError("search_not_owned", "This search cursor belongs to another agent.");
    if (session.queryDigest !== queryDigest) throw new SearchError("search_cursor_mismatch", "This cursor belongs to a different query.");
    if (offset > session.matches.length) throw new SearchError("search_cursor_invalid", "Cursor offset is beyond the retained results.");
    session.lastUsedMs = this.clock();
    return { session, offset };
  }

  cancel(session: SearchSession): void {
    session.state = "cancelled";
    this.sessions.delete(session.id);
  }

  release(session: SearchSession): void { this.sessions.delete(session.id); }

  encode(session: SearchSession, offset: number): string {
    const body = Buffer.from(JSON.stringify({ v: 1, s: session.id, o: offset, q: session.queryDigest.slice(0, 16) })).toString("base64url");
    return `${body}.${this.mac(body)}`;
  }

  size(): number { return this.sessions.size; }

  private decode(cursor: string): { sessionId: string; offset: number; digest: string } {
    if (typeof cursor !== "string" || cursor.length > 512 || !/^[A-Za-z0-9_-]+\.[a-f0-9]{32}$/.test(cursor)) throw new SearchError("search_cursor_invalid", "Search cursor is malformed.");
    const [body, signature] = cursor.split(".") as [string, string];
    if (!timingSafeEqual(Buffer.from(this.mac(body), "hex"), Buffer.from(signature, "hex"))) throw new SearchError("search_expired", "This search cursor was issued by an earlier Runner process or was altered; start the search again.");
    try {
      const value = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as { v: number; s: string; o: number; q: string };
      if (value.v !== 1 || typeof value.s !== "string" || !Number.isSafeInteger(value.o) || value.o < 0 || typeof value.q !== "string") throw new Error("shape");
      return { sessionId: value.s, offset: value.o, digest: value.q };
    } catch { throw new SearchError("search_cursor_invalid", "Search cursor is malformed."); }
  }

  private mac(body: string): string { return createHmac("sha256", this.key).update(body).digest("hex").slice(0, 32); }

  private sweep(): void {
    const now = this.clock();
    for (const [id, session] of this.sessions) if (now - session.lastUsedMs > SEARCH_LIMITS.idleExpiryMs) this.sessions.delete(id);
  }
}

export class SearchError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = "SearchError"; }
}

/**
 * Minimal bounded glob: `*` (no slash), `**` (any depth), `?`, `{a,b}` and `[...]` classes.
 * A pattern without `/` matches the basename at any depth; otherwise the workspace-relative path.
 */
export function compileGlobs(patterns: readonly unknown[] | undefined, label: string): ((path: string) => boolean) | undefined {
  if (patterns === undefined) return undefined;
  if (!Array.isArray(patterns) || patterns.length > SEARCH_LIMITS.maxGlobs || patterns.some(item => typeof item !== "string" || !item || item.length > 256 || item.includes("\0")))
    throw new SearchError("invalid_glob", `${label} must be up to ${SEARCH_LIMITS.maxGlobs} non-empty glob strings.`);
  if (!patterns.length) return undefined;
  const compiled = (patterns as string[]).map(pattern => {
    const normalized = pattern.replace(/\\/g, "/").replace(/^\.\//, "");
    const basenameOnly = !normalized.includes("/");
    return { basenameOnly, expression: new RegExp(`^${globSource(normalized)}$`, "i") };
  });
  return (path: string) => {
    const normalized = path.replace(/\\/g, "/");
    const basename = normalized.slice(normalized.lastIndexOf("/") + 1);
    return compiled.some(entry => entry.expression.test(entry.basenameOnly ? basename : normalized));
  };
}

function globSource(pattern: string): string {
  let source = "", index = 0, braces = 0;
  while (index < pattern.length) {
    const char = pattern[index]!;
    if (char === "*") {
      if (pattern[index + 1] === "*") {
        const slash = pattern[index + 2] === "/";
        source += slash ? "(?:.*/)?" : ".*";
        index += slash ? 3 : 2;
        continue;
      }
      source += "[^/]*";
    } else if (char === "?") source += "[^/]";
    else if (char === "{") { braces += 1; source += "(?:"; }
    else if (char === "}" && braces > 0) { braces -= 1; source += ")"; }
    else if (char === "," && braces > 0) source += "|";
    else if (char === "[") {
      const end = pattern.indexOf("]", index + 1);
      if (end > index + 1) {
        const body = pattern.slice(index + 1, end).replace(/^!/, "^").replace(/\\/g, "\\\\");
        source += `[${body}]`; index = end + 1; continue;
      }
      source += "\\[";
    } else source += char.replace(/[.+^$()|\\/]/g, match => `\\${match}`);
    index += 1;
  }
  if (braces) throw new SearchError("invalid_glob", `Unbalanced braces in glob ${pattern}.`);
  return source;
}

/** Lines around a match, bounded in count and length. */
export function contextAround(lines: readonly string[], index: number, count: number): { before?: string[]; after?: string[] } {
  if (count <= 0) return {};
  const clip = (line: string) => line.length > SEARCH_LIMITS.maxLineChars ? `${line.slice(0, SEARCH_LIMITS.maxLineChars)}…` : line;
  return {
    before: lines.slice(Math.max(0, index - count), index).map(clip),
    after: lines.slice(index + 1, index + 1 + count).map(clip),
  };
}
