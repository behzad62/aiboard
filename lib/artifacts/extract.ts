/**
 * Client-side extraction of "files" from model markdown output.
 *
 * Models in Build mode are asked to emit each file as a fenced code block whose
 * info line carries a path (```ts path=src/index.ts). Real model output is
 * messy, so this parser is deliberately tolerant: it also recognizes a bare
 * path token in the info line, a `title="..."`/`file=...` attribute, a
 * label/heading line directly above the fence, or a `// path:` comment on the
 * first line inside the block. Anything without a resolvable path stays as
 * ordinary prose (non-file code is preserved).
 */

export interface ExtractedFile {
  path: string;
  language: string;
  content: string;
}

/** One SEARCH/REPLACE operation inside an ```edit path=...``` block. */
export interface ExtractedEditOp {
  search: string;
  replace: string;
}

export interface ExtractedEdit {
  path: string;
  ops: ExtractedEditOp[];
}

export interface ArtifactExtraction {
  files: ExtractedFile[];
  /** Targeted edits to existing files (```edit path=...``` blocks). */
  edits: ExtractedEdit[];
  /** The original text with recognized file blocks removed. */
  prose: string;
  /**
   * Paths of blocks whose closing fence never arrived — the model's output was
   * cut off mid-block. Truncated FILE blocks are rejected entirely (writing a
   * half file over a real one destroys it); truncated EDIT blocks keep only
   * their fully terminated ops. Callers should report these to the reviewer.
   */
  truncatedPaths: string[];
}

const FENCE_OPEN = /^(\s*)(`{3,}|~{3,})(.*)$/;

function looksLikePath(value: string): boolean {
  const v = value.trim();
  if (!v || /\s/.test(v)) return false;
  return v.includes("/") || /\.[A-Za-z0-9]+$/.test(v);
}

function normalizePath(raw: string): string {
  return raw
    .trim()
    .replace(/^["'`]+|["'`]+$/g, "")
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .replace(/^\/+/, "")
    .trim();
}

/** Resolve a path from a fence info string like "ts path=src/x.ts". */
function pathFromInfo(info: string): string | null {
  const attr =
    /(?:^|\s)(?:path|file|filename|src)\s*=\s*("([^"]+)"|'([^']+)'|([^\s]+))/i.exec(
      info
    );
  if (attr) return attr[2] ?? attr[3] ?? attr[4] ?? null;

  const title = /(?:^|\s)title\s*=\s*"([^"]+)"/i.exec(info);
  if (title) return title[1];

  // Bare token that looks like a path, e.g. ```tsx src/App.tsx
  for (const token of info.trim().split(/\s+/)) {
    if (looksLikePath(token)) return token;
  }
  return null;
}

function languageFromInfo(info: string, path: string): string {
  const first = info.trim().split(/\s+/)[0] ?? "";
  if (first && !first.includes("=") && !looksLikePath(first)) {
    return first.toLowerCase();
  }
  const ext = /\.([A-Za-z0-9]+)$/.exec(path);
  return ext ? ext[1].toLowerCase() : "";
}

/** A label line just above a fence, e.g. **File: `src/x.ts`** or ### src/x.ts */
function pathFromLabel(line: string | undefined): string | null {
  if (!line) return null;
  const labelled =
    /(?:file|filename|path)\s*[:=]\s*`?["']?([^\s`"'*]+)["']?`?/i.exec(line);
  if (labelled && looksLikePath(labelled[1])) return labelled[1];

  const headingOrBacktick =
    /^\s*(?:#{1,6}\s+|\*\*\s*)?`?([^\s`*]+\.[A-Za-z0-9]+)`?\s*\*?\*?\s*$/.exec(
      line
    );
  if (headingOrBacktick && looksLikePath(headingOrBacktick[1])) {
    return headingOrBacktick[1];
  }
  return null;
}

/** A path comment on the first content line, e.g. // path: src/x.ts */
function pathFromFirstLine(contentLines: string[]): string | null {
  const first = contentLines.find((l) => l.trim().length > 0);
  if (!first) return null;
  const m =
    /^\s*(?:\/\/|#|--|;|<!--|\/\*)\s*(?:file|path)\s*[:=]\s*([^\s*>]+)/i.exec(
      first
    );
  if (m && looksLikePath(m[1])) return m[1];
  return null;
}

/**
 * A BARE attribute line as the first content line, e.g. the model writes
 * ```html on the fence and `path=index.html` on the next line. Unlike the
 * comment form, this line is metadata, not file content — the caller strips it.
 */
function bareAttrFirstLineIndex(contentLines: string[]): number {
  const idx = contentLines.findIndex((l) => l.trim().length > 0);
  if (idx < 0) return -1;
  const m = /^\s*(?:path|file|filename)\s*[:=]\s*(\S+)\s*$/i.exec(
    contentLines[idx]
  );
  return m && looksLikePath(m[1]) ? idx : -1;
}

function bareAttrPath(line: string): string {
  return /^\s*(?:path|file|filename)\s*[:=]\s*(\S+)\s*$/i.exec(line)![1];
}

function lastNonEmpty(lines: string[]): string | undefined {
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].trim().length > 0) return lines[i];
  }
  return undefined;
}

/** Parse SEARCH/REPLACE operations from an edit block's body. */
function parseEditOps(body: string[]): ExtractedEditOp[] {
  const ops: ExtractedEditOp[] = [];
  let i = 0;
  while (i < body.length) {
    if (!/^<{4,}\s*SEARCH\s*$/.test(body[i].trim())) {
      i += 1;
      continue;
    }
    i += 1;
    const search: string[] = [];
    while (i < body.length && !/^={4,}\s*$/.test(body[i].trim())) {
      search.push(body[i]);
      i += 1;
    }
    i += 1; // skip =======
    const replace: string[] = [];
    let terminated = false;
    while (i < body.length) {
      if (/^>{4,}\s*REPLACE\s*$/.test(body[i].trim())) {
        terminated = true;
        break;
      }
      replace.push(body[i]);
      i += 1;
    }
    i += 1; // skip >>>>>>> REPLACE
    // An op whose REPLACE terminator never arrived is a truncated stream —
    // applying it would write half a replacement into the file.
    if (search.length > 0 && terminated) {
      ops.push({ search: search.join("\n"), replace: replace.join("\n") });
    }
  }
  return ops;
}

/**
 * Apply SEARCH/REPLACE ops to a file's content. Exact match first, then a
 * whitespace-tolerant line-wise fallback. Failed ops are skipped and counted.
 */
export function applyEditOps(
  content: string,
  ops: ExtractedEditOp[]
): { content: string; applied: number; failed: number } {
  let result = content;
  let applied = 0;
  let failed = 0;
  for (const op of ops) {
    const idx = result.indexOf(op.search);
    if (idx >= 0) {
      result =
        result.slice(0, idx) + op.replace + result.slice(idx + op.search.length);
      applied += 1;
      continue;
    }
    const fuzzy = fuzzyFindLines(result, op.search);
    if (fuzzy) {
      result = result.slice(0, fuzzy.start) + op.replace + result.slice(fuzzy.end);
      applied += 1;
    } else {
      failed += 1;
    }
  }
  return { content: result, applied, failed };
}

/** Find `needle` in `haystack` comparing lines with trimmed whitespace. */
function fuzzyFindLines(
  haystack: string,
  needle: string
): { start: number; end: number } | null {
  const hLines = haystack.split("\n");
  const nLines = needle.split("\n").map((l) => l.trim());
  if (nLines.length === 0) return null;
  for (let i = 0; i + nLines.length <= hLines.length; i++) {
    let ok = true;
    for (let k = 0; k < nLines.length; k++) {
      if (hLines[i + k].trim() !== nLines[k]) {
        ok = false;
        break;
      }
    }
    if (!ok) continue;
    const start = i === 0 ? 0 : hLines.slice(0, i).join("\n").length + 1;
    const end = start + hLines.slice(i, i + nLines.length).join("\n").length;
    return { start, end };
  }
  return null;
}

export function extractArtifacts(text: string): ArtifactExtraction {
  const lines = (text ?? "").split("\n");
  const files: ExtractedFile[] = [];
  const edits: ExtractedEdit[] = [];
  const truncatedPaths: string[] = [];
  const proseLines: string[] = [];

  let i = 0;
  while (i < lines.length) {
    const open = FENCE_OPEN.exec(lines[i]);
    if (!open) {
      proseLines.push(lines[i]);
      i += 1;
      continue;
    }

    const marker = open[2][0]; // ` or ~
    const info = open[3] ?? "";
    const closeRe = new RegExp(`^\\s*${marker === "`" ? "`{3,}" : "~{3,}"}\\s*$`);

    // Collect block body until the closing fence (or end of input).
    const body: string[] = [];
    let j = i + 1;
    while (j < lines.length && !closeRe.test(lines[j])) {
      body.push(lines[j]);
      j += 1;
    }
    const hadClose = j < lines.length;

    // ```edit path=...``` blocks are targeted edits, never whole files.
    // Models also sometimes emit SEARCH/REPLACE ops under a normal language
    // fence (```js path=...) — detect those by their first content line so
    // conflict markers are never written into a file as literal content.
    const firstContent = body.find((l) => l.trim().length > 0) ?? "";
    const infoFirst = info.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
    if (infoFirst === "edit" || /^<{4,}\s*SEARCH\s*$/.test(firstContent.trim())) {
      const editPath = pathFromInfo(info);
      const ops = parseEditOps(body);
      if (editPath && ops.length > 0) {
        edits.push({ path: normalizePath(editPath), ops });
        // A cut-off edit block: the terminated ops above are safe, but the
        // tail op was lost — surface it so the reviewer knows.
        if (!hadClose) truncatedPaths.push(normalizePath(editPath));
      } else if (editPath && !hadClose) {
        truncatedPaths.push(normalizePath(editPath));
        proseLines.push(lines[i], ...body);
      } else {
        // Malformed edit block — keep it visible as prose.
        proseLines.push(lines[i], ...body);
        if (hadClose) proseLines.push(lines[j]);
      }
      i = hadClose ? j + 1 : j;
      continue;
    }

    const bareAttrIdx = bareAttrFirstLineIndex(body);
    const path =
      pathFromInfo(info) ??
      (bareAttrIdx >= 0 ? bareAttrPath(body[bareAttrIdx]) : null) ??
      pathFromFirstLine(body) ??
      pathFromLabel(lastNonEmpty(proseLines));

    if (path && !hadClose) {
      // The closing fence never arrived — the stream was cut off mid-file.
      // Writing a half file over a real one destroys it, so reject the block
      // and keep it visible as prose.
      truncatedPaths.push(normalizePath(path));
      proseLines.push(lines[i], ...body);
    } else if (path) {
      // The bare `path=...` line is metadata, not file content — drop it.
      const content =
        bareAttrIdx >= 0 && !pathFromInfo(info)
          ? body.filter((_, idx) => idx !== bareAttrIdx)
          : body;
      files.push({
        path: normalizePath(path),
        language: languageFromInfo(info, path),
        content: content.join("\n"),
      });
    } else {
      // Not a file — keep the whole block verbatim in the prose.
      proseLines.push(lines[i], ...body);
      if (hadClose) proseLines.push(lines[j]);
    }

    i = hadClose ? j + 1 : j;
  }

  return {
    files: dedupeLastWins(files),
    edits,
    truncatedPaths: [...new Set(truncatedPaths)],
    prose: proseLines.join("\n").replace(/\n{3,}/g, "\n\n").trim(),
  };
}

/** Later definitions of the same path win (the integrator's pass overrides drafts). */
function dedupeLastWins(files: ExtractedFile[]): ExtractedFile[] {
  const byPath = new Map<string, ExtractedFile>();
  for (const file of files) {
    if (!file.path) continue;
    byPath.set(file.path, file);
  }
  return Array.from(byPath.values()).sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * Merge artifacts across many messages (document order). Useful for collecting
 * every file produced over a whole discussion; last definition of a path wins.
 */
export function collectArtifacts(texts: string[]): ExtractedFile[] {
  const all: ExtractedFile[] = [];
  for (const text of texts) {
    all.push(...extractArtifacts(text).files);
  }
  return dedupeLastWins(all);
}
