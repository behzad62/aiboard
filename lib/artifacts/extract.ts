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

export interface ArtifactExtraction {
  files: ExtractedFile[];
  /** The original text with recognized file blocks removed. */
  prose: string;
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

function lastNonEmpty(lines: string[]): string | undefined {
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].trim().length > 0) return lines[i];
  }
  return undefined;
}

export function extractArtifacts(text: string): ArtifactExtraction {
  const lines = (text ?? "").split("\n");
  const files: ExtractedFile[] = [];
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

    const path =
      pathFromInfo(info) ??
      pathFromFirstLine(body) ??
      pathFromLabel(lastNonEmpty(proseLines));

    if (path) {
      files.push({
        path: normalizePath(path),
        language: languageFromInfo(info, path),
        content: body.join("\n"),
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
