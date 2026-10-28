import { languageInvocation } from "./language-intelligence.js";
import { preserveUtf8Bom } from "./encoding-safety.js";
import { submissionSecretNotice } from "./submission-guard.js";
import { createHash } from "node:crypto";
import { fencedWrite, fencedPatch, fencedMove, fencedDelete, filesystemMutationFailure,
  FilesystemMutationError, isFilesystemMutation } from "./filesystem-mutation-fence.js";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { RemotePathDeniedError, type RemotePathGuard } from "./remote-path-guard.js";
import { isAbsolute, posix, relative, resolve, sep } from "node:path";

import type { ArtifactStore } from "./artifact-store.js";
import type {
  NativeTool,
  ToolExecutionContext,
  ToolExecutionOutput,
  ValidationResult,
} from "./agent-contracts.js";
import type { LanguageIntelligenceProvider } from "./language-intelligence.js";
import { SEARCH_LIMITS, SearchError, SearchSessionStore, compileGlobs, contextAround, emptySkipCounts, normalizedQueryDigest,
  type SearchCandidate, type SearchQuery, type SearchSession, type SearchSkipCounts, type SearchState } from "./filesystem-search.js";
import type {
  RepositoryEntry,
  RepositoryIntelligence,
} from "./repository-intelligence.js";

export interface FilesystemToolsOptions {
  artifacts?: ArtifactStore;
  repository?: RepositoryIntelligence;
  diagnostics?: Pick<LanguageIntelligenceProvider, "diagnostics">;
  maxReadBytes?: number;
  maxEntries?: number;
  maxSearchMatches?: number;
  hiddenPaths?: readonly string[];
  protectedPaths?: readonly string[];
  /** Remote/local_mcp deny guard (S1a); unset for local Build brokers. */
  pathGuard?: RemotePathGuard;
  /** Resumable fs.search sessions; injectable for tests (clock). */
  searchSessions?: SearchSessionStore;
}

type Input = Record<string, unknown>;
// Reads were bounded at 6 KB per range and 8 KB inline, so an 11.5 KB STATE.md took a reviewer three
// calls (a head-and-tail preview, then two ranges) on a model with a 1M-token context (tunnel run).
// A range now returns up to the caller's inline budget; a line-count cap only refused calls the byte
// bound already clips (with nextStartLine).
const MAX_READ_RANGE_BYTES = 24 * 1024;
const rangeByteLimit = (context: ToolExecutionContext) =>
  Math.max(MAX_READ_RANGE_BYTES, (Number.isSafeInteger(context.inlineOutputBytes) ? context.inlineOutputBytes! : 0) - 2 * 1024);
const MAX_READ_INLINE_BYTES = 32 * 1024;
const MAX_PATCH_EDITS = 50;

/** T10 (M9): model-facing search contract: literal match, skipped outputs. */
export const FS_SEARCH_DESCRIPTION =
  "Search text files under `path` (literal, case-insensitive by default; set regex/caseSensitive to change). Git-ignored, generated, and build-output paths are skipped, but tracked source files are still searched. Filter with include/exclude globs and add contextLines. When state is \"running\" pass the returned cursor (with the same query) to get the next page instead of re-running with a bigger maxMatches; exhaustive=true means a zero-match result is definitive.";

/** T10 (M9): model-facing list contract: ignored paths skipped, plus name-based build-output skips without repository metadata. */
export const FS_LIST_DESCRIPTION =
  "List workspace files. Git-ignored paths are skipped; without repository metadata, build-output directories (bin, obj, build, target, dist, out, .venv, venv, __pycache__) are skipped too.";

/** T10 (M9): directory names treated as build output in every language. */
export const BUILD_OUTPUT_DIR_NAMES: ReadonlySet<string> = new Set([
  ".git",
  "node_modules",
  "bin",
  "obj",
  "out",
  "dist",
  "build",
  "target",
  ".venv",
  "venv",
  "__pycache__",
  ".pytest_cache",
  ".tox",
]);

/**
 * T10 (M9): true when any path segment is a build-output directory.
 * Compared case-insensitively (`Obj`, `Build`); a mere prefix such as
 * `build-notes.md` is not a match.
 */
export function isBuildOutputPath(path: string): boolean {
  return path
    .split("/")
    .some((segment) => BUILD_OUTPUT_DIR_NAMES.has(segment.toLowerCase()));
}

export function createFilesystemTools(
  options: FilesystemToolsOptions = {}
): NativeTool<unknown>[] {
  const maxReadBytes = options.maxReadBytes ?? 1024 * 1024;
  const maxEntries = options.maxEntries ?? 5_000;
  const maxSearchMatches = options.maxSearchMatches ?? 500;
  const searchSessions = options.searchSessions ?? new SearchSessionStore();
  const guard = options.pathGuard;
  const guardContext = (context: ToolExecutionContext) => ({ toolName: context.toolName ?? "fs", principal: context.actor ? `${context.actor.role}:${context.actor.id}` : "unknown" });
  const guardDeny = async (context: ToolExecutionContext, path: string, mode: "read" | "write" | "delete" | "list" | "search"): Promise<ToolExecutionOutput | undefined> => {
    if (!guard) return undefined;
    try { await guard.assertAllowed(path, mode, guardContext(context)); return undefined; }
    catch (cause) { if (cause instanceof RemotePathDeniedError) return error(cause.code, cause.message); throw cause; }
  };
  const guardTreeDeny = async (context: ToolExecutionContext, path: string, mode: "write" | "delete"): Promise<ToolExecutionOutput | undefined> => {
    if (!guard) return undefined;
    try { await guard.assertTreeAllowed(path, mode, guardContext(context)); return undefined; }
    catch (cause) { if (cause instanceof RemotePathDeniedError) return error(cause.code, cause.message); throw cause; }
  };
  // The revision each session last read or wrote per file. A write or patch without expectedSha256
  // replaces only that revision, so replacing a file the worker has read needs no extra round trip,
  // while content it has not seen is still refused (tunnel run: the refusal cost a model call).
  const seenRevisions = new Map<string, string>();
  const seenKey = (context: ToolExecutionContext, path: string) => `${context.sessionId}\0${path}`;
  const rememberRevision = (context: ToolExecutionContext, path: string, hash: string) => {
    const key = seenKey(context, path);
    seenRevisions.delete(key);
    seenRevisions.set(key, hash);
    if (seenRevisions.size > 4_096) seenRevisions.delete(seenRevisions.keys().next().value!);
  };
  const expectedRevision = (input: Input, context: ToolExecutionContext, path: string) =>
    input.expectedSha256 ?? seenRevisions.get(seenKey(context, path));
  let mutationQueue = Promise.resolve();
  const mutate = async <T>(operation: () => Promise<T>): Promise<T> => {
    const previous = mutationQueue;
    let release!: () => void;
    mutationQueue = new Promise<void>((resolveQueue) => {
      release = resolveQueue;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  };

  const tools: NativeTool<Input>[] = [
    {
      definition: definition(
        "fs.read",
        `Read a file with revision metadata. For large text files, request a 1-based inclusive line range with startLine and endLine. A range larger than one tool result returns the largest prefix that fits plus nextStartLine instead of failing.`,
        true,
        "none",
        MAX_READ_INLINE_BYTES,
      ),
      validate: validateRead,
      assessAccess: (input) => pathAccess(input, "read"),
      execute: async (input, context) => {
        const path = toolPath(context, input.path as string);
        if (matchesPolicyPath(context, path, options.hiddenPaths)) {
          return hiddenPathError(context, path);
        }
        if (hasPolicyPaths(options.hiddenPaths) && await matchesCanonicalPolicyTarget(context, path, options.hiddenPaths)) {
          return hiddenPathError(context, path);
        }
        const deniedRead = await guardDeny(context, path, "read");
        if (deniedRead) return deniedRead;
        const bytes = await readFile(path);
        const hash = sha256(bytes);
        rememberRevision(context, path, hash);
        const baseMetadata = {
          path: displayPath(context, path),
          sha256: hash,
          byteLength: bytes.byteLength,
        };
        if (input.startLine !== undefined && isUtf8Text(bytes)) {
          const source = decodeText(bytes);
          const starts = lineStarts(source);
          const startLine = input.startLine as number;
          const requestedEndLine = input.endLine as number;
          if (startLine > starts.length) {
            return error(
              "invalid_line_range",
              `startLine ${startLine} exceeds the file's ${starts.length} lines.`
            );
          }
          let endLine = Math.min(requestedEndLine, starts.length);
          const startOffset = starts[startLine - 1];
          let endOffset = endLine < starts.length ? starts[endLine] : source.length;
          let selected = source.slice(startOffset, endOffset);
          let selectedBytes = Buffer.byteLength(selected);
          const rangeLimit = rangeByteLimit(context);
          if (selectedBytes > rangeLimit) {
            const firstLineEndOffset = startLine < starts.length
              ? starts[startLine]
              : source.length;
            const firstLineBytes = Buffer.byteLength(
              source.slice(startOffset, firstLineEndOffset)
            );
            if (firstLineBytes > rangeLimit) {
              return error(
                "line_range_too_large",
                `Line ${startLine} contains ${firstLineBytes} bytes and cannot fit within the ${rangeLimit}-byte range limit; it is not possible to narrow the range further for this single line.`
              );
            }

            let low = startLine;
            let high = endLine;
            let bestEndLine = startLine;
            while (low <= high) {
              const candidate = Math.floor((low + high) / 2);
              const candidateEndOffset = candidate < starts.length
                ? starts[candidate]
                : source.length;
              const candidateBytes = Buffer.byteLength(
                source.slice(startOffset, candidateEndOffset)
              );
              if (candidateBytes <= rangeLimit) {
                bestEndLine = candidate;
                low = candidate + 1;
              } else {
                high = candidate - 1;
              }
            }
            endLine = bestEndLine;
            endOffset = endLine < starts.length ? starts[endLine] : source.length;
            selected = source.slice(startOffset, endOffset);
            selectedBytes = Buffer.byteLength(selected);
          }
          const rangeWasClipped = endLine < Math.min(requestedEndLine, starts.length);
          return {
            content: [
              json({
                ...baseMetadata,
                ...lineEndingMetadata(source, selected),
                totalLines: starts.length,
                startLine,
                endLine,
                truncated: startLine > 1 || endLine < starts.length,
                ...(rangeWasClipped
                  ? {
                      requestedEndLine,
                      nextStartLine: endLine + 1,
                      rangeByteLength: selectedBytes,
                    }
                  : {}),
              }),
              { type: "text", text: modelText(selected) },
            ],
            isError: false,
          };
        }
        const metadata = json(baseMetadata);
        if (bytes.byteLength > maxReadBytes || !isUtf8Text(bytes)) {
          if (!options.artifacts) {
            return error("artifact_store_required", "Binary or large file requires artifact storage.");
          }
          const artifact = await options.artifacts.put(
            bytes,
            isUtf8Text(bytes) ? "text/plain" : "application/octet-stream",
            displayPath(context, path)
          );
          return {
            content: [
              metadata,
              {
                type: "artifact",
                hash: artifact.hash,
                mediaType: artifact.mediaType,
                label: artifact.label,
              },
            ],
            isError: false,
          };
        }
        const whole = decodeText(bytes);
        return {
          content: [json({ ...baseMetadata, ...lineEndingMetadata(whole, whole) }), { type: "text", text: modelText(whole) }],
          isError: false,
        };
      },
    },
    {
      definition: definition("fs.stat", "Inspect file metadata without following links; a link reports its target when it stays inside the workspace. A missing path returns exists: false.", true, "none"),
      validate: objectWithString("path"),
      // lstat reads the entry in its parent directory. Granting the path itself refused every symbolic
      // link ("Grant roots cannot be symbolic links"), e.g. npm workspace links (tunnel run).
      assessAccess: (input) => ({
        capability: "filesystem.read",
        paths: [{ path: posix.dirname((input.path as string).replaceAll("\\", "/")) || ".", access: "read" as const }],
      }),
      execute: async (input, context) => {
        const path = toolPath(context, input.path as string);
        const deniedStat = await guardDeny(context, path, "read");
        if (deniedStat) return deniedStat;
        if (matchesPolicyPath(context, path, options.hiddenPaths)) {
          return hiddenPathError(context, path);
        }
        if (hasPolicyPaths(options.hiddenPaths) && await matchesCanonicalPolicyTarget(context, path, options.hiddenPaths)) {
          return hiddenPathError(context, path);
        }
        // Whether something exists is an answer, not a failure: workers probing node_modules or dist
        // got tool_execution_failed errors (tunnel run).
        const details = await lstat(path).catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT" || error.code === "ENOTDIR") return undefined;
          throw error;
        });
        if (!details) return { content: [json({ path: displayPath(context, path), exists: false })], isError: false };
        const linkTarget = details.isSymbolicLink() ? await workspaceLinkTarget(context, path) : undefined;
        return {
          content: [
            json({
              path: displayPath(context, path),
              type: details.isFile()
                ? "file"
                : details.isDirectory()
                  ? "directory"
                  : details.isSymbolicLink()
                    ? "symlink"
                    : "other",
              byteLength: details.size,
              modifiedAt: details.mtime.toISOString(),
              ...(details.isSymbolicLink() ? { linkTarget: linkTarget ?? "outside the workspace" } : {}),
            }),
          ],
          isError: false,
        };
      },
    },
    {
      definition: definition("fs.list", FS_LIST_DESCRIPTION, true, "none"),
      validate: objectWithString("path"),
      assessAccess: (input) => repositoryReadAccess(input),
      execute: async (input, context) => {
        const root = toolPath(context, input.path as string);
        const deniedList = await guardDeny(context, root, "list");
        if (deniedList) return deniedList;
        const depth = integer(input.maxDepth, 1, 0, 20);
        const entries: Array<{ path: string; type: string }> = [];
        if (options.repository && context.workspacePath) {
          const snapshot = await options.repository.snapshot(
            context.workspacePath,
            { maxEntries: Math.min(20_000, maxEntries) },
            context.signal,
          );
          entries.push(...repositoryListEntries(
            snapshot.entries,
            context.workspacePath,
            root,
            depth,
            maxEntries,
          ));
        } else {
          await walk(root, depth, async (path, type) => {
            if (guard && await guard.isDenied(path)) return true;
            if (entries.length >= maxEntries) return false;
            entries.push({ path: displayPath(context, path), type });
            return true;
          }, context.signal, 0, guard ? async (path) => await guard.isDenied(path) : undefined);
        }
        const visibleEntries = hasPolicyPaths(options.hiddenPaths)
          ? await filterHiddenListEntries(context, entries, options.hiddenPaths)
          : entries;
        visibleEntries.sort((left, right) => left.path.localeCompare(right.path));
        return { content: [json({ entries: visibleEntries, truncated: entries.length >= maxEntries })], isError: false };
      },
    },
    {
      definition: definition("fs.search", FS_SEARCH_DESCRIPTION, true, "none"),
      validate: objectWithStrings("path", "pattern"),
      assessAccess: (input) => repositoryReadAccess(input),
      execute: async (input, context) => {
        const root = toolPath(context, input.path as string);
        const deniedSearch = await guardDeny(context, root, "search");
        if (deniedSearch) return deniedSearch;
        const limit = integer(
          input.maxMatches,
          Math.min(100, maxSearchMatches),
          1,
          maxSearchMatches
        );
        let expression: RegExp;
        try {
          const source = input.regex === true
            ? (input.pattern as string)
            : escapeRegExp(input.pattern as string);
          expression = new RegExp(source, input.caseSensitive === true ? "g" : "gi");
        } catch (cause) {
          return error("invalid_pattern", cause instanceof Error ? cause.message : "Invalid pattern.");
        }
        let include: ((path: string) => boolean) | undefined, exclude: ((path: string) => boolean) | undefined;
        try {
          include = compileGlobs(input.include as unknown[] | undefined, "include");
          exclude = compileGlobs(input.exclude as unknown[] | undefined, "exclude");
        } catch (cause) {
          return error("invalid_glob", cause instanceof Error ? cause.message : "Invalid glob.");
        }
        const contextLines = integer(input.contextLines, 0, 0, SEARCH_LIMITS.maxContextLines);
        const query: SearchQuery = {
          root, pattern: input.pattern as string, regex: input.regex === true, caseSensitive: input.caseSensitive === true,
          include: (input.include as string[] | undefined) ?? [], exclude: (input.exclude as string[] | undefined) ?? [], contextLines,
          flags: { includeIgnored: input.includeIgnored === true, includeGenerated: input.includeGenerated === true,
            includeVendored: input.includeVendored === true, includeBinary: input.includeBinary === true },
        };
        const queryDigest = normalizedQueryDigest(query);
        const owner = { runId: context.runId, sessionId: context.sessionId, actor: { ...context.actor } };
        let searchWorkspaceCanonical: string | null | undefined;
        if (hasPolicyPaths(options.hiddenPaths) && context.workspacePath) {
          searchWorkspaceCanonical = await canonicalOrNull(context.workspacePath);
        }
        const hidden = async (path: string) => matchesPolicyPath(context, path, options.hiddenPaths) ||
          (guard ? await guard.isDenied(path) : false) ||
          (hasPolicyPaths(options.hiddenPaths) && await matchesCanonicalPolicyTarget(context, path, options.hiddenPaths, searchWorkspaceCanonical));
        let session: SearchSession, offset = 0;
        if (input.cursor !== undefined) {
          if (typeof input.cursor !== "string") return error("search_cursor_invalid", "cursor must be a string.");
          try { ({ session, offset } = searchSessions.resume(input.cursor, owner, queryDigest)); }
          catch (cause) {
            if (cause instanceof SearchError) return { content: [json({ matches: [], truncated: true, state: cause.code === "search_expired" ? "expired" : "failed", exhaustive: false })], isError: true, error: { code: cause.code, message: cause.message } };
            throw cause;
          }
          if (input.cancel === true) {
            searchSessions.cancel(session);
            return { content: [json({ matches: [], truncated: true, state: "cancelled", exhaustive: false, scope: searchScope(session, query, context) })], isError: false };
          }
        } else {
          const rootDetails = await lstat(root);
          if (!rootDetails.isFile() && !rootDetails.isDirectory()) return error("invalid_search_path", "Search path must be a file or directory.");
          const skipped = emptySkipCounts();
          const candidates: SearchCandidate[] = [];
          let source: SearchSession["source"] = "file", snapshotTruncated = false, listedWithin = 0;
          const admit = async (path: string) => {
            const display = displayPath(context, path);
            if ((include && !include(display)) || (exclude && exclude(display))) { skipped.excluded += 1; return; }
            if (await hidden(path)) { skipped.hidden += 1; return; }
            candidates.push({ absolutePath: path, displayPath: display });
          };
          if (rootDetails.isFile()) await admit(root);
          else if (options.repository && context.workspacePath) {
            const snapshot = await options.repository.snapshot(context.workspacePath, { includeIgnored: input.includeIgnored === true, maxEntries: 20_000 }, context.signal);
            source = snapshot.source; snapshotTruncated = snapshot.truncated;
            const entries = [...snapshot.entries].sort((left, right) => left.path.localeCompare(right.path));
            for (const entry of entries) {
              const path = resolve(context.workspacePath, entry.path);
              if (!isWithin(root, path)) continue;
              listedWithin += 1;
              const reason = searchSkipReason(entry, input);
              if (reason) { skipped[reason] += 1; continue; }
              await admit(path);
            }
          } else {
            source = "filesystem";
            await walk(root, 50, async (path, type) => {
              if (type !== "file") return true;
              if (candidates.length >= 20_000) { snapshotTruncated = true; return false; }
              await admit(path); return true;
            }, context.signal, 0, guard ? async (path) => await guard.isDenied(path) : undefined);
          }
          // The snapshot leaves ignored files out entirely, so a non-empty directory it lists nothing
          // under (node_modules, dist) is itself ignored.
          if (input.includeIgnored !== true && rootDetails.isDirectory() && options.repository && listedWithin === 0 &&
            (await readdir(root).catch(() => [])).length > 0) {
            skipped.ignored = Math.max(skipped.ignored, 1);
          }
          session = searchSessions.create({ owner, queryDigest, source, snapshotTruncated, candidates, skipped });
        }
        await scanSearchSession(session, offset + limit, expression, contextLines, hidden, context.signal, offset === 0 && input.cursor === undefined);
        const matches = session.matches.slice(offset, offset + limit);
        const next = offset + matches.length;
        const more = session.matches.length > next || (session.state === "running" && session.position < session.candidates.length);
        const state: SearchState = more && session.state === "running" ? "running"
          : session.state === "running" ? (session.overflow ? "capped" : "complete") : session.state;
        const exhaustive = state === "complete" && !session.snapshotTruncated && session.skipped.unreadable === 0 && !session.overflow;
        // An empty result says why it may be empty: a worker searched node_modules (skipped as
        // ignored) and an a|b pattern (matched literally), got nothing twice and fell back to shell
        // commands (tunnel run).
        const notes: string[] = [];
        const skippedIgnored = session.skipped.ignored + session.skipped.generated + session.skipped.vendored;
        if (!session.matches.length && skippedIgnored > 0) {
          notes.push(`${skippedIgnored} git-ignored or generated file(s) under this path were skipped; set includeIgnored: true to search them.`);
        }
        if (!session.matches.length && input.regex !== true && /[|*+?()[\]{}^$\\]/.test(String(input.pattern))) {
          notes.push("The pattern was matched literally; set regex: true to use it as a regular expression.");
        }
        if (state === "stale") notes.push("Files changed after this search started; results so far are from the original snapshot. Start a new search for current content.");
        if (state === "capped") notes.push(`Retained results reached the session cap (${SEARCH_LIMITS.maxRetainedMatches} matches or ${SEARCH_LIMITS.maxRetainedBytes} bytes); narrow path, include or pattern.`);
        if (state === "timed_out") notes.push("The search reached its total scan-time bound; results are partial.");
        return {
          content: [json({
            matches,
            truncated: state !== "complete" || more,
            state,
            exhaustive,
            ...(more && (state === "running" || session.matches.length > next) ? { cursor: searchSessions.encode(session, next) } : {}),
            scope: searchScope(session, query, context),
            ...(session.errors.length ? { errors: session.errors.slice(0, 10) } : {}),
            ...(notes.length ? { notes } : {}),
          })],
          isError: false,
        };
      },
      timeoutMs: () => SEARCH_LIMITS.pageTimeMs + 30_000,
    },
    {
      definition: definition("fs.write", "Atomically create a new text file only if absent, or replace existing text using the SHA-256 from a prior read/inspection. expectedSha256 defaults to the revision you last read or wrote; replacing a file you have not read is refused.", false, "workspace"),
      validate: objectWithStrings("path", "content"),
      assessAccess: (input) => pathAccess(input, "write"),
      execute: async (input, context) =>
        await mutate(async () => {
          const path = toolPath(context, input.path as string);
          const deniedWrite = await guardDeny(context, path, "write");
          if (deniedWrite) return deniedWrite;
          if (matchesPolicyPath(context, path, options.protectedPaths)) {
            return protectedPathError(context, path);
          }
          if (hasPolicyPaths(options.protectedPaths) && await matchesCanonicalPolicyTarget(context, path, options.protectedPaths)) {
            return protectedPathError(context, path);
          }
          const bytes = fencedWrite(context, path, (original) => preserveUtf8Bom(original, Buffer.from(keepLineEndings(original, input.content as string))),
            // Missing parents are created by default (the same fenced creation as the explicit flag):
            // the opt-in only made workers regenerate and resend whole files (tunnel run).
            expectedRevision(input, context, path), input.createDirectories !== false);
          if (guard) { const recheck = await guardDeny(context, path, "write"); if (recheck) return recheck; }
          rememberRevision(context, path, sha256(bytes));
          return await successRevision(context, path, bytes, options.diagnostics);
        }),
    },
    {
      definition: definition(
        "fs.patch",
        "Apply one or many exact replacements atomically to one file. Multiline edits tolerate LF/CRLF differences and preserve the file's newline style. Prefer the edits array when changing multiple regions; issue only one fs.patch per file per model turn. Every edit is validated before the file is written.",
        false,
        "workspace",
      ),
      validate: validatePatch,
      assessAccess: (input) => pathAccess(input, "write"),
      execute: async (input, context) =>
        await mutate(async () => {
          const path = toolPath(context, input.path as string);
          const deniedPatch = await guardDeny(context, path, "write");
          if (deniedPatch) return deniedPatch;
          if (matchesPolicyPath(context, path, options.protectedPaths)) {
            return protectedPathError(context, path);
          }
          if (hasPolicyPaths(options.protectedPaths) && await matchesCanonicalPolicyTarget(context, path, options.protectedPaths)) {
            return protectedPathError(context, path);
          }
          let noOpEdits: number[] = [];
          const next = fencedPatch(context, path, expectedRevision(input, context, path), (bytes) => {
            const original = decodeText(bytes);
            let nextText = original;
            const edits = patchEdits(input);
            noOpEdits = edits.flatMap((edit, index) => edit.search === edit.replace ? [index + 1] : []);
            if (noOpEdits.length === edits.length) {
              throw new FilesystemMutationError(
                "no_op_patch",
                `Every edit's replace is identical to its search, so nothing would change (edit ${noOpEdits.join(", ")}). No changes were written.`,
              );
            }
            for (const [index, edit] of edits.entries()) {
              const newline = preferredNewline(nextText);
              const exactCount = occurrences(nextText, edit.search);
              const adaptedSearch = newline
                ? normalizeNewlines(edit.search, newline)
                : edit.search;
              const search = exactCount === 0 && adaptedSearch !== edit.search
                ? adaptedSearch
                : edit.search;
              const count = exactCount === 0
                ? occurrences(nextText, search)
                : exactCount;
              if (count !== 1) {
                throw new FilesystemMutationError(
                  "ambiguous_patch",
                  `Edit ${index + 1}: expected one match, found ${count}. ${patchMatchHint(nextText, search, count, newline ? normalizeNewlines(edit.replace, newline) : edit.replace)}No changes were written.`,
                );
              }
              const replacement = newline
                ? normalizeNewlines(edit.replace, newline)
                : edit.replace;
              nextText = nextText.replace(search, replacement);
            }
            return preserveUtf8Bom(bytes, Buffer.from(nextText));
          });
          // A no-op edit used to succeed silently, so the model believed it had changed the code.
          rememberRevision(context, path, sha256(next));
          return await successRevision(context, path, next, options.diagnostics, noOpEdits.length > 0
            ? `Edit ${noOpEdits.join(", ")} changed nothing: its replace is identical to its search.`
            : undefined);
        }),
    },
    {
      definition: definition("fs.move", "Move a file or directory", false, "workspace"),
      validate: objectWithStrings("source", "destination"),
      assessAccess: (input) => ({
        capability: "filesystem.move",
        paths: [
          { path: input.source as string, access: "delete" },
          { path: input.destination as string, access: "write" },
        ],
      }),
      execute: async (input, context) =>
        await mutate(async () => {
          const source = toolPath(context, input.source as string);
          const destination = toolPath(context, input.destination as string);
          const deniedMoveSource = await guardTreeDeny(context, source, "delete");
          if (deniedMoveSource) return deniedMoveSource;
          const deniedMoveDest = await guardDeny(context, destination, "write");
          if (deniedMoveDest) return deniedMoveDest;
          if (matchesPolicyPath(context, source, options.protectedPaths)) {
            return protectedPathError(context, source);
          }
          if (matchesPolicyPath(context, destination, options.protectedPaths)) {
            return protectedPathError(context, destination);
          }
          if (hasPolicyPaths(options.protectedPaths) && await matchesCanonicalPolicyTarget(context, source, options.protectedPaths)) {
            return protectedPathError(context, source);
          }
          if (hasPolicyPaths(options.protectedPaths) && await matchesCanonicalPolicyTarget(context, destination, options.protectedPaths)) {
            return protectedPathError(context, destination);
          }
          fencedMove(context, source, destination, input.createDirectories === true);
          return {
            content: [json({ source: displayPath(context, source), destination: displayPath(context, destination) })],
            isError: false,
          };
        }),
    },
    {
      definition: definition("fs.delete", "Delete a file or explicitly recursive directory", false, "workspace"),
      validate: objectWithString("path"),
      assessAccess: (input) => ({
        capability: "filesystem.delete",
        destructive: true,
        paths: [{ path: input.path as string, access: "delete" }],
      }),
      execute: async (input, context) =>
        await mutate(async () => {
          const path = toolPath(context, input.path as string);
          const deniedDelete = await guardTreeDeny(context, path, "delete");
          if (deniedDelete) return deniedDelete;
          if (matchesPolicyPath(context, path, options.protectedPaths)) {
            return protectedPathError(context, path);
          }
          if (hasPolicyPaths(options.protectedPaths) && await matchesCanonicalPolicyTarget(context, path, options.protectedPaths)) {
            return protectedPathError(context, path);
          }
          fencedDelete(context, path, input.recursive === true);
          return { content: [json({ path: displayPath(context, path), deleted: true })], isError: false };
        }),
    },
  ];
  return tools.map((tool) => !isFilesystemMutation(tool.definition.name) ? tool : {
    ...tool,
    execute: async (input: Input, context: ToolExecutionContext) => {
      try { return await tool.execute(input, context); }
      catch (error) {
        const refusal = filesystemMutationFailure(error, context.workspacePath ?? "");
        if (refusal) return refusal;
        throw error;
      }
    },
  }) as NativeTool<unknown>[];
}

function definition(
  name: string,
  description: string,
  readOnly: boolean,
  effect: "none" | "workspace",
  inlineOutputBytes?: number,
) {
  return { name, description, inputSchema: filesystemSchema(name), readOnly, effect, ...(inlineOutputBytes ? { inlineOutputBytes } : {}) } as const;
}

function filesystemSchema(name: string): Record<string, unknown> {
  const path = { type: "string", minLength: 1 };
  const sha = { type: "string", pattern: "^[a-f0-9]{64}$" };
  switch (name) {
    case "fs.read":
      return objectSchema(
        {
          path,
          startLine: { type: "integer", minimum: 1 },
          endLine: { type: "integer", minimum: 1 },
        },
        ["path"]
      );
    case "fs.stat":
      return objectSchema({ path }, ["path"]);
    case "fs.list":
      return objectSchema(
        { path, maxDepth: { type: "integer", minimum: 0, maximum: 20 } },
        ["path"]
      );
    case "fs.search":
      return objectSchema(
        {
          path,
          pattern: { type: "string" },
          regex: { type: "boolean" },
          caseSensitive: { type: "boolean" },
          includeGenerated: { type: "boolean" },
          includeVendored: { type: "boolean" },
          includeIgnored: { type: "boolean" },
          includeBinary: { type: "boolean" },
          maxMatches: { type: "integer", minimum: 1 },
          include: { type: "array", items: { type: "string" }, maxItems: 32, description: "Only search paths matching these globs (e.g. \"*.ts\", \"src/**/*.tsx\")." },
          exclude: { type: "array", items: { type: "string" }, maxItems: 32, description: "Skip paths matching these globs." },
          contextLines: { type: "integer", minimum: 0, maximum: 5, description: "Lines of context before and after each match." },
          cursor: { type: "string", description: "Continue a previous search: pass its cursor with the same path, pattern and options." },
          cancel: { type: "boolean", description: "With cursor: end that search session." },
        },
        ["path", "pattern"]
      );
    case "fs.write":
      return objectSchema(
        {
          path,
          content: { type: "string" },
          expectedSha256: sha,
          createDirectories: { type: "boolean", description: "Missing parent folders are created by default; false refuses instead." },
        },
        ["path", "content"]
      );
    case "fs.patch":
      return objectSchema(
        {
          path,
          search: { type: "string", minLength: 1 },
          replace: { type: "string" },
          edits: {
            type: "array",
            minItems: 1,
            maxItems: MAX_PATCH_EDITS,
            items: objectSchema(
              {
                search: { type: "string", minLength: 1 },
                replace: { type: "string" },
              },
              ["search", "replace"],
            ),
          },
          expectedSha256: sha,
        },
        ["path", "expectedSha256"],
      );
    case "fs.move":
      return objectSchema(
        {
          source: path,
          destination: path,
          createDirectories: { type: "boolean" },
        },
        ["source", "destination"]
      );
    case "fs.delete":
      return objectSchema(
        { path, recursive: { type: "boolean" } },
        ["path"]
      );
    default:
      throw new Error(`Unknown filesystem tool ${name}.`);
  }
}

function repositoryListEntries(
  repositoryEntries: RepositoryEntry[],
  workspaceRoot: string,
  requestedRoot: string,
  maxDepth: number,
  maxEntries: number,
): Array<{ path: string; type: string }> {
  const paths = new Map<string, string>();
  for (const entry of repositoryEntries) {
    const absolutePath = resolve(workspaceRoot, entry.path);
    if (!isWithin(requestedRoot, absolutePath)) continue;
    const relation = relative(requestedRoot, absolutePath);
    const segments = relation.split(sep).filter(Boolean);
    if (segments.length === 0) continue;
    const maximumSegments = Math.min(segments.length, maxDepth + 1);
    for (let count = 1; count <= maximumSegments; count += 1) {
      const path = resolve(requestedRoot, ...segments.slice(0, count));
      const type = count === segments.length ? "file" : "directory";
      paths.set(path, type);
      if (paths.size >= maxEntries) break;
    }
    if (paths.size >= maxEntries) break;
  }
  return [...paths.entries()].map(([path, type]) => ({
    path: normalizeDisplayPath(workspaceRoot, path),
    type,
  }));
}

function searchSkipReason(entry: RepositoryEntry, input: Input): keyof SearchSkipCounts | undefined {
  if (entryIsSearchable(entry, input)) return undefined;
  if (entry.gitState !== "tracked" && (entry.gitState === "ignored" || isBuildOutputPath(entry.path))) return "ignored";
  if (entry.kind === "generated") return "generated";
  if (entry.kind === "vendored") return "vendored";
  if (entry.kind === "binary") return "binary";
  return "ignored";
}

function searchScope(session: SearchSession, query: SearchQuery, context: ToolExecutionContext) {
  return {
    path: displayPath(context, query.root),
    source: session.source,
    candidates: session.candidates.length,
    scanned: session.scanned,
    remaining: Math.max(0, session.candidates.length - session.position),
    skipped: { ...session.skipped },
    snapshotTruncated: session.snapshotTruncated,
    retainedMatches: session.matches.length,
  };
}

/**
 * Scan whole candidate files until `wanted` matches are retained or the page budget is spent.
 * `firstPage` reads happen inside the creating call, so no page boundary has been crossed yet.
 */
async function scanSearchSession(
  session: SearchSession,
  wanted: number,
  expression: RegExp,
  contextLines: number,
  hidden: (path: string) => Promise<boolean>,
  signal: AbortSignal | undefined,
  firstPage: boolean,
): Promise<void> {
  if (session.state !== "running") return;
  const started = Date.now();
  let bytes = 0;
  try {
    while (session.position < session.candidates.length && session.matches.length < wanted) {
      if (signal?.aborted) return;
      const elapsed = Date.now() - started;
      if (session.scanMs + elapsed > SEARCH_LIMITS.sessionScanTimeMs) { session.state = "timed_out"; return; }
      if (elapsed > SEARCH_LIMITS.pageTimeMs || bytes > SEARCH_LIMITS.pageScanBytes) return;
      const candidate = session.candidates[session.position]!;
      // Access policy is rechecked on every page; a revoked path is never read.
      if (await hidden(candidate.absolutePath)) { session.skipped.hidden += 1; session.position += 1; continue; }
      let details;
      try { details = await lstat(candidate.absolutePath); }
      catch (cause) {
        if ((cause as NodeJS.ErrnoException).code === "ENOENT" && !firstPage) {
          session.state = "stale"; session.errors.push(`${candidate.displayPath} was removed after the search started.`); return;
        }
        session.skipped.unreadable += 1; session.errors.push(`${candidate.displayPath}: unreadable`); session.position += 1; continue;
      }
      if (!details.isFile()) { session.skipped.unreadable += 1; session.position += 1; continue; }
      if (!firstPage && details.mtimeMs > session.createdAtMs) {
        session.state = "stale"; session.errors.push(`${candidate.displayPath} changed after the search started.`); return;
      }
      if (details.size > SEARCH_LIMITS.maxFileBytes) { session.skipped.tooLarge += 1; session.position += 1; continue; }
      let content: Buffer;
      try { content = await readFile(candidate.absolutePath); }
      catch { session.skipped.unreadable += 1; session.errors.push(`${candidate.displayPath}: unreadable`); session.position += 1; continue; }
      bytes += content.byteLength;
      session.scanned += 1;
      if (!isUtf8Text(content)) { session.skipped.notText += 1; session.position += 1; continue; }
      const lines = decodeText(content).split(/\r?\n/);
      const found: typeof session.matches = [];
      let foundBytes = 0;
      for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
        expression.lastIndex = 0;
        let match: RegExpExecArray | null;
        while ((match = expression.exec(lines[lineIndex]!)) !== null) {
          const line = lines[lineIndex]!;
          const clipped = line.length > SEARCH_LIMITS.maxLineChars;
          const entry = { path: candidate.displayPath, line: lineIndex + 1, column: match.index + 1,
            text: clipped ? `${line.slice(0, SEARCH_LIMITS.maxLineChars)}…` : line, ...(clipped ? { textTruncated: true } : {}),
            ...contextAround(lines, lineIndex, contextLines) };
          found.push(entry); foundBytes += JSON.stringify(entry).length;
          if (match[0].length === 0) expression.lastIndex += 1;
        }
      }
      // A file's matches are retained whole or not at all, so a page never splits a file's
      // results across a cap boundary and resumption needs no intra-file position.
      if (session.matches.length + found.length > SEARCH_LIMITS.maxRetainedMatches || session.retainedBytes + foundBytes > SEARCH_LIMITS.maxRetainedBytes) {
        session.overflow = true;
        const room = Math.max(0, SEARCH_LIMITS.maxRetainedMatches - session.matches.length);
        session.matches.push(...found.slice(0, room));
        session.position = session.candidates.length;
        return;
      }
      session.matches.push(...found); session.retainedBytes += foundBytes;
      session.position += 1;
    }
  } finally {
    session.scanMs += Date.now() - started;
  }
}

function entryIsSearchable(entry: RepositoryEntry, input: Input): boolean {
  // T10 (M9): repository metadata decides for tracked entries — a tracked
  // non-generated file under a build-output name (bin/obj/target) stays
  // searchable and is governed only by the gitState/kind flags below.
  // Name-based skips apply only without tracking proof; filesystem-only
  // traversal (walk) keeps the conservative directory-name skips.
  if (entry.gitState !== "tracked" && isBuildOutputPath(entry.path) && input.includeIgnored !== true) return false;
  if (entry.gitState === "ignored" && input.includeIgnored !== true) return false;
  if (entry.kind === "generated" && input.includeGenerated !== true) return false;
  if (entry.kind === "vendored" && input.includeVendored !== true) return false;
  if (entry.kind === "binary" && input.includeBinary !== true) return false;
  return true;
}

function isWithin(root: string, path: string): boolean {
  const relation = relative(root, path);
  return relation === "" || (relation !== ".." && !relation.startsWith(`..${sep}`) && !isAbsolute(relation));
}

function normalizeDisplayPath(root: string, path: string): string {
  const value = relative(root, path);
  return (value || ".").split(sep).join("/");
}

function objectSchema(
  properties: Record<string, unknown>,
  required: string[]
): Record<string, unknown> {
  return { type: "object", properties, required, additionalProperties: false };
}

function objectWithString(key: string) {
  return (input: unknown): ValidationResult<Input> =>
    isObject(input) && typeof input[key] === "string"
      ? { ok: true, value: input }
      : { ok: false, issues: [`${key} must be a string`] };
}

function validateRead(raw: unknown): ValidationResult<Input> {
  if (!isObject(raw) || typeof raw.path !== "string") {
    return { ok: false, issues: ["path must be a string"] };
  }
  let input = raw;
  const hasStart = input.startLine !== undefined;
  const hasEnd = input.endLine !== undefined;
  if (!hasStart && !hasEnd) return { ok: true, value: input };
  // One bound means the obvious range: endLine alone is "from line 1", startLine alone is "to the
  // end" (still clipped by the byte budget, with nextStartLine). Refusing endLine: 90 cost a retry
  // (tunnel run).
  if (hasStart !== hasEnd) {
    input = { ...input, ...(hasStart ? { endLine: Number.MAX_SAFE_INTEGER } : { startLine: 1 }) };
  }
  if (
    !Number.isSafeInteger(input.startLine) ||
    !Number.isSafeInteger(input.endLine) ||
    (input.startLine as number) < 1 ||
    (input.endLine as number) < (input.startLine as number)
  ) {
    return {
      ok: false,
      issues: ["startLine and endLine must form a positive ascending range"],
    };
  }
  return { ok: true, value: input };
}

function validatePatch(input: unknown): ValidationResult<Input> {
  if (
    !isObject(input) ||
    typeof input.path !== "string"
  ) {
    return {
      ok: false,
      issues: ["path must be a string"],
    };
  }
  const hasLegacy = input.search !== undefined || input.replace !== undefined;
  const hasEdits = input.edits !== undefined;
  if (hasLegacy === hasEdits) {
    return {
      ok: false,
      issues: ["provide either search and replace, or edits, but not both"],
    };
  }
  if (hasLegacy) {
    return typeof input.search === "string" &&
      input.search.length > 0 &&
      typeof input.replace === "string"
      ? { ok: true, value: input }
      : {
          ok: false,
          issues: ["search must be a non-empty string and replace must be a string"],
        };
  }
  if (
    !Array.isArray(input.edits) ||
    input.edits.length === 0 ||
    input.edits.length > MAX_PATCH_EDITS
  ) {
    return {
      ok: false,
      issues: [`edits must contain between 1 and ${MAX_PATCH_EDITS} replacements`],
    };
  }
  for (const [index, edit] of input.edits.entries()) {
    if (
      !isObject(edit) ||
      typeof edit.search !== "string" ||
      edit.search.length === 0 ||
      typeof edit.replace !== "string"
    ) {
      return {
        ok: false,
        issues: [
          `edits[${index}] must contain a non-empty search string and a replace string`,
        ],
      };
    }
  }
  return { ok: true, value: input };
}

function patchEdits(input: Input): Array<{ search: string; replace: string }> {
  if (Array.isArray(input.edits)) {
    return input.edits.map((edit) => ({
      search: (edit as Input).search as string,
      replace: (edit as Input).replace as string,
    }));
  }
  return [{
    search: input.search as string,
    replace: input.replace as string,
  }];
}

function objectWithStrings(...keys: string[]) {
  return (input: unknown): ValidationResult<Input> =>
    isObject(input) && keys.every((key) => typeof input[key] === "string")
      ? { ok: true, value: input }
      : { ok: false, issues: keys.map((key) => `${key} must be a string`) };
}

function isObject(input: unknown): input is Input {
  return typeof input === "object" && input !== null && !Array.isArray(input);
}

function lineStarts(source: string): number[] {
  const starts = [0];
  const newline = /\r\n|\r|\n/g;
  while (newline.exec(source) !== null) starts.push(newline.lastIndex);
  return starts;
}

function pathAccess(input: Input, access: "read" | "write") {
  return {
    capability: `filesystem.${access}`,
    paths: [{ path: input.path as string, access }],
  };
}

/**
 * List and search read the repository snapshot, which runs Git at the workspace root; with only the
 * requested folder granted, every folder-scoped search failed with "Git working directory is outside
 * the original call access" (tunnel run). Both may already list the whole workspace with ".".
 */
function repositoryReadAccess(input: Input) {
  return {
    capability: "filesystem.read",
    paths: [{ path: input.path as string, access: "read" as const }, { path: ".", access: "read" as const }],
  };
}

/** The workspace-relative target of a link, or undefined when it leaves the workspace or is broken. */
async function workspaceLinkTarget(context: ToolExecutionContext, path: string): Promise<string | undefined> {
  if (!context.workspacePath) return undefined;
  try {
    const target = await realpath(path);
    const workspace = await realpath(context.workspacePath);
    const inside = relative(workspace, target);
    if (inside.startsWith("..") || isAbsolute(inside)) return undefined;
    return inside.split(sep).join("/") || ".";
  } catch {
    return undefined;
  }
}

/** Same hidden-path policy as the filesystem tools (lexical, then canonical target). */
export async function isHiddenWorkspacePath(context: ToolExecutionContext, absolutePath: string, hiddenPaths: readonly string[] | undefined): Promise<boolean> {
  if (!hasPolicyPaths(hiddenPaths)) return false;
  return matchesPolicyPath(context, absolutePath, hiddenPaths) || await matchesCanonicalPolicyTarget(context, absolutePath, hiddenPaths);
}

function toolPath(context: ToolExecutionContext, path: string): string {
  if (!context.workspacePath) throw new Error("Filesystem tool requires a workspace.");
  return resolve(context.workspacePath, path);
}

function displayPath(context: ToolExecutionContext, path: string): string {
  const value = context.workspacePath ? relative(context.workspacePath, path) : path;
  return (value || ".").split(sep).join("/");
}

function normalizePolicyPath(path: string): string {
  return path.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/$/, "");
}

function matchesNormalizedPolicyPath(
  path: string,
  policyPaths: readonly string[] | undefined,
): boolean {
  const candidate = normalizePolicyPath(path);
  const foldedCandidate = foldHostPath(candidate);
  return (policyPaths ?? []).some((policyPath) => {
    const protectedPath = normalizePolicyPath(policyPath);
    const foldedProtected = foldHostPath(protectedPath);
    if (!foldedProtected.includes("/")) {
      return foldedCandidate.split("/").includes(foldedProtected);
    }
    return foldedCandidate === foldedProtected || foldedCandidate.startsWith(`${foldedProtected}/`);
  });
}

function foldHostPath(path: string): string {
  return process.platform === "win32" ? path.toLowerCase() : path;
}

function matchesPolicyPath(
  context: ToolExecutionContext,
  path: string,
  policyPaths: readonly string[] | undefined,
): boolean {
  return matchesNormalizedPolicyPath(displayPath(context, path), policyPaths);
}

// Canonical target check for existing objects only. Lexical matching stays
// first; this reuses it on the workspace-canonical display path so exact,
// basename, and nested scopes are preserved. Missing (ENOENT) returns false
// to keep missing/new-target behavior; other inspection failures throw.
async function matchesCanonicalPolicyTarget(
  context: ToolExecutionContext,
  absolutePath: string,
  policyPaths: readonly string[] | undefined,
  workspaceCanonical?: string | null,
): Promise<boolean> {
  if (!hasPolicyPaths(policyPaths)) return false;
  if (!context.workspacePath) return false;
  const canonicalRoot = workspaceCanonical !== undefined
    ? workspaceCanonical
    : await canonicalOrNull(context.workspacePath);
  if (canonicalRoot === null) return false;
  const canonicalTargetPath = await canonicalOrNull(absolutePath);
  if (canonicalTargetPath === null) return false;
  if (!isWithin(canonicalRoot, canonicalTargetPath)) return false;
  const canonicalDisplay = (relative(canonicalRoot, canonicalTargetPath) || ".").split(sep).join("/");
  return matchesNormalizedPolicyPath(canonicalDisplay, policyPaths);
}

async function canonicalOrNull(path: string): Promise<string | null> {
  try {
    return await realpath(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function hasPolicyPaths(policyPaths: readonly string[] | undefined): boolean {
  return !!policyPaths && policyPaths.length > 0;
}

async function filterHiddenListEntries(
  context: ToolExecutionContext,
  entries: Array<{ path: string; type: string }>,
  hiddenPaths: readonly string[] | undefined,
): Promise<Array<{ path: string; type: string }>> {
  if (!hasPolicyPaths(hiddenPaths)) return entries;
  if (!context.workspacePath) {
    return entries.filter((entry) => !matchesNormalizedPolicyPath(entry.path, hiddenPaths));
  }
  const canonicalRoot = await canonicalOrNull(context.workspacePath);
  if (canonicalRoot === null) {
    return entries.filter((entry) => !matchesNormalizedPolicyPath(entry.path, hiddenPaths));
  }
  const visible: Array<{ path: string; type: string }> = [];
  for (const entry of entries) {
    if (matchesNormalizedPolicyPath(entry.path, hiddenPaths)) continue;
    const absolute = resolve(context.workspacePath, entry.path);
    if (await matchesCanonicalPolicyTarget(context, absolute, hiddenPaths, canonicalRoot)) continue;
    visible.push(entry);
  }
  return visible;
}

function hiddenPathError(
  context: ToolExecutionContext,
  path: string,
): ToolExecutionOutput {
  return error(
    "benchmark_hidden_path",
    `benchmark_hidden_path: ${displayPath(context, path)} is unavailable to benchmark agents.`,
  );
}

function protectedPathError(
  context: ToolExecutionContext,
  path: string,
): ToolExecutionOutput {
  return error(
    "benchmark_protected_path",
    `benchmark_protected_path: ${displayPath(context, path)} cannot be modified by benchmark agents.`,
  );
}

async function walk(
  root: string,
  maxDepth: number,
  visit: (path: string, type: string) => Promise<boolean>,
  signal?: AbortSignal,
  depth = 0,
  prune?: (path: string) => Promise<boolean>
): Promise<void> {
  if (signal?.aborted) throw new Error("Search cancelled.");
  const entries = await readdir(root, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    if (BUILD_OUTPUT_DIR_NAMES.has(entry.name.toLowerCase())) continue;
    const path = resolve(root, entry.name);
    if (prune && await prune(path)) continue;
    const type = entry.isDirectory() ? "directory" : entry.isFile() ? "file" : entry.isSymbolicLink() ? "symlink" : "other";
    if (!(await visit(path, type))) return;
    if (entry.isDirectory() && depth < maxDepth) {
      await walk(path, maxDepth, visit, signal, depth + 1, prune);
    }
  }
}

function isUtf8Text(bytes: Buffer): boolean {
  if (bytes.includes(0)) return false;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}

function decodeText(bytes: Buffer): string {
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function json(value: unknown) {
  return { type: "json" as const, value };
}

function error(code: string, message: string): ToolExecutionOutput {
  return { content: [{ type: "text", text: message }], isError: true, error: { code, message } };
}

async function successRevision(
  context: ToolExecutionContext,
  path: string,
  bytes: Buffer,
  diagnostics?: Pick<LanguageIntelligenceProvider, "diagnostics">,
  notice?: string,
): Promise<ToolExecutionOutput> {
  const secretNotice = submissionSecretNotice(displayPath(context, path), bytes.toString("utf8"));
  const notices = [notice, secretNotice].filter((value): value is string => value !== undefined);
  const metadata: Record<string, unknown> = {
    path: displayPath(context, path),
    sha256: sha256(bytes),
    byteLength: bytes.byteLength,
    ...(notices.length > 0 ? { notices } : {}),
  };
  if (diagnostics && context.workspacePath) {
    try {
      const result = await diagnostics.diagnostics({
        root: context.workspacePath,
        path: displayPath(context, path),
      }, context.signal, languageInvocation(context));
      if (result.status === "unsupported_language") {
        metadata.diagnosticsSkipped = "unsupported_language";
      } else {
        metadata.diagnostics = {
          ...(result.projectConfig ? { projectConfig: result.projectConfig } : {}),
          results: result.results,
          truncated: result.truncated,
        };
      }
    } catch {
      metadata.diagnosticsUnavailable = "code_intelligence_failed";
    }
  }
  return {
    content: [json(metadata)],
    isError: false,
  };
}

/**
 * Where to look instead. A bare "found 0" left the worker re-reading the file or guessing again
 * (tunnel run: three refused patches in one task).
 */
function patchMatchHint(text: string, search: string, count: number, replace: string): string {
  const lines = text.split(/\r?\n/);
  // DeepSeek wrote replace before search in 37 of 40 edits and twice put the current text in replace
  // and the wanted text in search (tunnel run). Say so instead of leaving it to guess.
  if (count === 0 && replace.trim().length > 0 && occurrences(text, replace) === 1) {
    const line = text.slice(0, text.indexOf(replace)).split(/\r?\n/).length;
    return `Its replace text is already in the file at line ${line}: search and replace look swapped (search is the CURRENT text, replace the new text), or this edit is already applied. `;
  }
  if (count > 1) {
    const first = search.split(/\r?\n/)[0]!;
    const at = lines.flatMap((line, index) => line.includes(first) ? [index + 1] : []).slice(0, 10);
    return at.length ? `It starts on lines ${at.join(", ")}; include surrounding lines to make it unique. ` : "";
  }
  const wanted = search.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0);
  if (!wanted.length) return "";
  for (const probe of wanted) {
    const index = lines.findIndex((line) => line.trim() === probe);
    if (index >= 0) {
      const excerpt = lines.slice(index, index + Math.min(wanted.length + 2, 12)).map((line, offset) => `${index + offset + 1}: ${line}`).join("\n");
      return `The line "${probe.slice(0, 120)}" is at line ${index + 1}; the file there reads:\n${excerpt}\n`;
    }
  }
  return "No line of the search text occurs in the file; read the current content before patching. ";
}

function occurrences(value: string, search: string): number {
  let count = 0;
  let cursor = 0;
  while ((cursor = value.indexOf(search, cursor)) >= 0) {
    count += 1;
    cursor += search.length;
  }
  return count;
}

/**
 * Models read and write LF. CRLF files (a Windows checkout's README, then every file the workers
 * wrote in that style) put \r\n escapes into each large argument, and one 8.5 KB patch broke its
 * JSON switching between \r\n and \\n (tunnel run). The file keeps its own style on disk.
 */
function modelText(text: string): string {
  return text.includes("\r\n") ? text.replace(/\r\n/g, "\n") : text;
}

/** textByteLength is the returned text's size; a reader's completeness check compares against it. */
function lineEndingMetadata(file: string, returned: string): Record<string, unknown> {
  if (!file.includes("\r\n")) return {};
  return { lineEndings: "crlf", textByteLength: Buffer.byteLength(modelText(returned)) };
}

function keepLineEndings(original: Buffer | undefined, content: string): string {
  if (!original || content.includes("\r\n") || !isUtf8Text(original)) return content;
  return preferredNewline(decodeText(original)) === "\r\n" ? content.replace(/\n/g, "\r\n") : content;
}

function preferredNewline(value: string): "\r\n" | "\n" | "\r" | null {
  if (value.includes("\r\n")) return "\r\n";
  if (value.includes("\n")) return "\n";
  if (value.includes("\r")) return "\r";
  return null;
}

function normalizeNewlines(value: string, newline: "\r\n" | "\n" | "\r"): string {
  return value.replace(/\r\n|\r|\n/g, newline);
}

function integer(
  value: unknown,
  fallback: number,
  minimum: number,
  maximum: number
): number {
  return Number.isInteger(value)
    ? Math.min(maximum, Math.max(minimum, value as number))
    : fallback;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
