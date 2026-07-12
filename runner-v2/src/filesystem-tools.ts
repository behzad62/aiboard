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
      definition: definition("fs.read", "Read a file with revision metadata", true, "none"),
      validate: objectWithString("path"),
      assessAccess: (input) => pathAccess(input, "read"),
      execute: async (input, context) => {
        const path = toolPath(context, input.path as string);
        const bytes = await readFile(path);
        const hash = sha256(bytes);
        const metadata = json({
          path: displayPath(context, path),
          sha256: hash,
          byteLength: bytes.byteLength,
        });
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
        "Apply one exact revision-aware replacement. Issue at most one fs.patch per file per model turn; use the returned sha256 as expectedSha256 for a later patch.",
        false,
        "workspace",
      ),
      validate: objectWithStrings("path", "search", "replace", "expectedSha256"),
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
          const search = input.search as string;
          if (!search) return error("invalid_patch", "Search text cannot be empty.");
          const count = occurrences(original, search);
          if (count !== 1) {
            return error("ambiguous_patch", `Expected one match, found ${count}.`);
          }
          const next = Buffer.from(original.replace(search, input.replace as string));
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
          expectedSha256: sha,
        },
        ["path", "search", "replace", "expectedSha256"]
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

function objectWithStrings(...keys: string[]) {
  return (input: unknown): ValidationResult<Input> =>
    isObject(input) && keys.every((key) => typeof input[key] === "string")
      ? { ok: true, value: input }
      : { ok: false, issues: keys.map((key) => `${key} must be a string`) };
}

function isObject(input: unknown): input is Input {
  return typeof input === "object" && input !== null && !Array.isArray(input);
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
