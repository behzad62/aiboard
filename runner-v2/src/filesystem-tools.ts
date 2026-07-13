import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";

import type { ArtifactStore } from "./artifact-store.js";
import type {
  NativeTool,
  ToolExecutionContext,
  ToolExecutionOutput,
  ValidationResult,
} from "./agent-contracts.js";

export interface FilesystemToolsOptions {
  artifacts?: ArtifactStore;
  maxReadBytes?: number;
  maxEntries?: number;
  maxSearchMatches?: number;
}

type Input = Record<string, unknown>;
const MAX_READ_LINES = 500;
const MAX_READ_RANGE_BYTES = 6 * 1024;
const MAX_PATCH_EDITS = 50;

export function createFilesystemTools(
  options: FilesystemToolsOptions = {}
): NativeTool<unknown>[] {
  const maxReadBytes = options.maxReadBytes ?? 1024 * 1024;
  const maxEntries = options.maxEntries ?? 5_000;
  const maxSearchMatches = options.maxSearchMatches ?? 500;
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
        `Read a file with revision metadata. For large text files, request a targeted 1-based inclusive line range with startLine and endLine. Each ranged read is limited to ${MAX_READ_LINES} lines and ${MAX_READ_RANGE_BYTES} bytes; oversized multi-line ranges return the largest bounded prefix plus nextStartLine instead of failing.`,
        true,
        "none"
      ),
      validate: validateRead,
      assessAccess: (input) => pathAccess(input, "read"),
      execute: async (input, context) => {
        const path = toolPath(context, input.path as string);
        const bytes = await readFile(path);
        const hash = sha256(bytes);
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
          if (selectedBytes > MAX_READ_RANGE_BYTES) {
            const firstLineEndOffset = startLine < starts.length
              ? starts[startLine]
              : source.length;
            const firstLineBytes = Buffer.byteLength(
              source.slice(startOffset, firstLineEndOffset)
            );
            if (firstLineBytes > MAX_READ_RANGE_BYTES) {
              return error(
                "line_range_too_large",
                `Line ${startLine} contains ${firstLineBytes} bytes and cannot fit within the ${MAX_READ_RANGE_BYTES}-byte range limit; it is not possible to narrow the range further for this single line.`
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
              if (candidateBytes <= MAX_READ_RANGE_BYTES) {
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
              { type: "text", text: selected },
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
        return {
          content: [metadata, { type: "text", text: decodeText(bytes) }],
          isError: false,
        };
      },
    },
    {
      definition: definition("fs.stat", "Inspect file metadata", true, "none"),
      validate: objectWithString("path"),
      assessAccess: (input) => pathAccess(input, "read"),
      execute: async (input, context) => {
        const path = toolPath(context, input.path as string);
        const details = await lstat(path);
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
            }),
          ],
          isError: false,
        };
      },
    },
    {
      definition: definition("fs.list", "List workspace files", true, "none"),
      validate: objectWithString("path"),
      assessAccess: (input) => pathAccess(input, "read"),
      execute: async (input, context) => {
        const root = toolPath(context, input.path as string);
        const depth = integer(input.maxDepth, 1, 0, 20);
        const entries: Array<{ path: string; type: string }> = [];
        await walk(root, depth, async (path, type) => {
          if (entries.length >= maxEntries) return false;
          entries.push({ path: displayPath(context, path), type });
          return true;
        }, context.signal);
        entries.sort((left, right) => left.path.localeCompare(right.path));
        return { content: [json({ entries, truncated: entries.length >= maxEntries })], isError: false };
      },
    },
    {
      definition: definition("fs.search", "Search text files", true, "none"),
      validate: objectWithStrings("path", "pattern"),
      assessAccess: (input) => pathAccess(input, "read"),
      execute: async (input, context) => {
        const root = toolPath(context, input.path as string);
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
        const matches: Array<{ path: string; line: number; column: number; text: string }> = [];
        const searchFile = async (path: string): Promise<boolean> => {
          if (matches.length >= limit) return false;
          const bytes = await readFile(path);
          if (!isUtf8Text(bytes)) return true;
          const lines = decodeText(bytes).split(/\r?\n/);
          for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
            expression.lastIndex = 0;
            let match: RegExpExecArray | null;
            while ((match = expression.exec(lines[lineIndex])) !== null) {
              matches.push({
                path: displayPath(context, path),
                line: lineIndex + 1,
                column: match.index + 1,
                text: lines[lineIndex],
              });
              if (matches.length >= limit) break;
              if (match[0].length === 0) expression.lastIndex += 1;
            }
            if (matches.length >= limit) break;
          }
          return matches.length < limit;
        };
        const rootDetails = await lstat(root);
        if (rootDetails.isFile()) {
          await searchFile(root);
        } else if (rootDetails.isDirectory()) {
          await walk(root, 50, async (path, type) =>
            type === "file" ? await searchFile(path) : matches.length < limit,
          context.signal);
        } else {
          return error("invalid_search_path", "Search path must be a file or directory.");
        }
        return {
          content: [json({ matches, truncated: matches.length >= limit })],
          isError: false,
        };
      },
    },
    {
      definition: definition("fs.write", "Atomically create or replace a text file", false, "workspace"),
      validate: objectWithStrings("path", "content"),
      assessAccess: (input) => pathAccess(input, "write"),
      execute: async (input, context) =>
        await mutate(async () => {
          const path = toolPath(context, input.path as string);
          if (input.createDirectories === true) await mkdir(dirname(path), { recursive: true });
          const conflict = await checkExpected(context, path, input.expectedSha256);
          if (conflict) return conflict;
          const bytes = Buffer.from(input.content as string);
          await atomicWrite(path, bytes);
          return successRevision(context, path, bytes);
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
          const bytes = await readFile(path);
          if (sha256(bytes) !== input.expectedSha256) {
            return revisionConflict(
              context,
              path,
              input.expectedSha256 as string,
              bytes,
            );
          }
          const original = decodeText(bytes);
          let nextText = original;
          const edits = patchEdits(input);
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
              return error(
                "ambiguous_patch",
                `Edit ${index + 1}: expected one match, found ${count}. No changes were written.`,
              );
            }
            const replacement = newline
              ? normalizeNewlines(edit.replace, newline)
              : edit.replace;
            nextText = nextText.replace(search, replacement);
          }
          const next = Buffer.from(nextText);
          await atomicWrite(path, next);
          return successRevision(context, path, next);
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
          if (input.createDirectories === true) await mkdir(dirname(destination), { recursive: true });
          await rename(source, destination);
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
          await rm(path, { recursive: input.recursive === true, force: false });
          return { content: [json({ path: displayPath(context, path), deleted: true })], isError: false };
        }),
    },
  ];
  return tools as NativeTool<unknown>[];
}

function definition(
  name: string,
  description: string,
  readOnly: boolean,
  effect: "none" | "workspace"
) {
  return { name, description, inputSchema: filesystemSchema(name), readOnly, effect } as const;
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
          maxMatches: { type: "integer", minimum: 1 },
        },
        ["path", "pattern"]
      );
    case "fs.write":
      return objectSchema(
        {
          path,
          content: { type: "string" },
          expectedSha256: sha,
          createDirectories: { type: "boolean" },
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

function validateRead(input: unknown): ValidationResult<Input> {
  if (!isObject(input) || typeof input.path !== "string") {
    return { ok: false, issues: ["path must be a string"] };
  }
  const hasStart = input.startLine !== undefined;
  const hasEnd = input.endLine !== undefined;
  if (hasStart !== hasEnd) {
    return {
      ok: false,
      issues: ["startLine and endLine must be provided together"],
    };
  }
  if (!hasStart) return { ok: true, value: input };
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
  if ((input.endLine as number) - (input.startLine as number) + 1 > MAX_READ_LINES) {
    return {
      ok: false,
      issues: [`line ranges may contain at most ${MAX_READ_LINES} lines`],
    };
  }
  return { ok: true, value: input };
}

function validatePatch(input: unknown): ValidationResult<Input> {
  if (
    !isObject(input) ||
    typeof input.path !== "string" ||
    typeof input.expectedSha256 !== "string"
  ) {
    return {
      ok: false,
      issues: ["path and expectedSha256 must be strings"],
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

function toolPath(context: ToolExecutionContext, path: string): string {
  if (!context.workspacePath) throw new Error("Filesystem tool requires a workspace.");
  return resolve(context.workspacePath, path);
}

function displayPath(context: ToolExecutionContext, path: string): string {
  const value = context.workspacePath ? relative(context.workspacePath, path) : path;
  return (value || ".").split(sep).join("/");
}

async function walk(
  root: string,
  maxDepth: number,
  visit: (path: string, type: string) => Promise<boolean>,
  signal?: AbortSignal,
  depth = 0
): Promise<void> {
  if (signal?.aborted) throw new Error("Search cancelled.");
  const entries = await readdir(root, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    if (entry.name === ".git" || entry.name === "node_modules") continue;
    const path = resolve(root, entry.name);
    const type = entry.isDirectory() ? "directory" : entry.isFile() ? "file" : entry.isSymbolicLink() ? "symlink" : "other";
    if (!(await visit(path, type))) return;
    if (entry.isDirectory() && depth < maxDepth) {
      await walk(path, maxDepth, visit, signal, depth + 1);
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

async function checkExpected(
  context: ToolExecutionContext,
  path: string,
  expected: unknown,
): Promise<ToolExecutionOutput | null> {
  if (expected === undefined) return null;
  if (typeof expected !== "string") return error("invalid_revision", "expectedSha256 must be a string.");
  try {
    const bytes = await readFile(path);
    if (sha256(bytes) !== expected) {
      return revisionConflict(context, path, expected, bytes);
    }
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
    return revisionConflict(context, path, expected, null);
  }
  return null;
}

function revisionConflict(
  context: ToolExecutionContext,
  path: string,
  expectedSha256: string,
  currentBytes: Buffer | null,
): ToolExecutionOutput {
  const currentSha256 = currentBytes ? sha256(currentBytes) : null;
  const message = currentSha256
    ? "File changed since it was read. Use currentSha256 to retry after confirming the replacement still applies."
    : "Expected file does not exist. Re-inspect the path before retrying.";
  return {
    content: [
      { type: "text", text: message },
      json({
        path: displayPath(context, path),
        expectedSha256,
        currentSha256,
        recovery: currentSha256
          ? "Retry fs.patch with currentSha256 after confirming the replacement still applies."
          : "Re-inspect the path before retrying.",
      }),
    ],
    isError: true,
    error: { code: "revision_conflict", message },
  };
}

async function atomicWrite(path: string, bytes: Buffer): Promise<void> {
  const temporary = `${path}.aiboard-${randomUUID()}.tmp`;
  await writeFile(temporary, bytes, { flag: "wx" });
  try {
    await rename(temporary, path);
  } catch (cause) {
    await rm(temporary, { force: true });
    throw cause;
  }
}

function successRevision(
  context: ToolExecutionContext,
  path: string,
  bytes: Buffer
): ToolExecutionOutput {
  return {
    content: [json({ path: displayPath(context, path), sha256: sha256(bytes), byteLength: bytes.byteLength })],
    isError: false,
  };
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
