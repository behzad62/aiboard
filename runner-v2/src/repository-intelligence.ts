import { lstat, readFile, readdir } from "node:fs/promises";
import { basename, dirname, extname, relative, resolve, sep } from "node:path";

import { runGit } from "./git-command.js";

export type RepositoryGitState =
  | "tracked"
  | "untracked"
  | "ignored"
  | "not_applicable";

export type RepositoryEntryKind =
  | "source"
  | "test"
  | "configuration"
  | "documentation"
  | "asset"
  | "generated"
  | "vendored"
  | "binary"
  | "other";

export interface RepositoryEntry {
  path: string;
  gitState: RepositoryGitState;
  kind: RepositoryEntryKind;
  language?: string;
  byteLength: number;
  classificationReasons: string[];
}

export interface RepositorySnapshot {
  root: string;
  source: "git" | "filesystem";
  entries: RepositoryEntry[];
  truncated: boolean;
}

export interface RepositorySnapshotOptions {
  includeIgnored?: boolean;
  maxEntries?: number;
}

export interface RepositoryManifestOptions extends RepositorySnapshotOptions {
  cursor?: string;
  pageSize?: number;
}

export interface RepositoryTotals {
  gitState: Record<RepositoryGitState, number>;
  kind: Record<RepositoryEntryKind, number>;
  language: Record<string, number>;
}

export interface RepositoryManifestPage {
  source: RepositorySnapshot["source"];
  entries: RepositoryEntry[];
  nextCursor?: string;
  totals: RepositoryTotals;
}

export interface RepositoryMapRoot {
  path: string;
  sources: string[];
}

export interface RepositoryMap {
  source: RepositorySnapshot["source"];
  topLevelDirectories: string[];
  configurationFiles: string[];
  sourceRoots: RepositoryMapRoot[];
  testRoots: RepositoryMapRoot[];
  languages: Record<string, number>;
  truncated: boolean;
}

const DEFAULT_MAX_ENTRIES = 20_000;
const MAX_CLASSIFICATION_PREFIX_BYTES = 4 * 1024;

export class RepositoryIntelligence {
  async snapshot(
    root: string,
    options: RepositorySnapshotOptions = {},
    signal?: AbortSignal,
  ): Promise<RepositorySnapshot> {
    const workspaceRoot = resolve(root);
    const maxEntries = boundedInteger(
      options.maxEntries,
      DEFAULT_MAX_ENTRIES,
      1,
      DEFAULT_MAX_ENTRIES,
    );
    throwIfAborted(signal);

    const repositoryCheck = await runGit({
      cwd: workspaceRoot,
      args: ["rev-parse", "--is-inside-work-tree"],
      allowFailure: true,
      maxOutputBytes: 16 * 1024,
    });
    if (repositoryCheck.exitCode !== 0) {
      return await this.filesystemSnapshot(workspaceRoot, maxEntries, signal);
    }

    const states = new Map<string, RepositoryGitState>();
    await collectGitPaths(workspaceRoot, ["ls-files", "-z"], "tracked", states);
    await collectGitPaths(
      workspaceRoot,
      ["ls-files", "-z", "--others", "--exclude-standard"],
      "untracked",
      states,
    );
    if (options.includeIgnored === true) {
      await collectGitPaths(
        workspaceRoot,
        ["ls-files", "-z", "--others", "--ignored", "--exclude-standard"],
        "ignored",
        states,
      );
    }

    const sortedPaths = [...states.keys()].sort((left, right) =>
      left.localeCompare(right),
    );
    const selected = sortedPaths.slice(0, maxEntries);
    const entries: RepositoryEntry[] = [];
    for (const path of selected) {
      throwIfAborted(signal);
      const absolutePath = containedPath(workspaceRoot, path);
      const details = await lstat(absolutePath);
      if (!details.isFile()) continue;
      entries.push(await classifyEntry(
        absolutePath,
        path,
        states.get(path) ?? "untracked",
        details.size,
      ));
    }

    return {
      root: workspaceRoot,
      source: "git",
      entries,
      truncated: sortedPaths.length > maxEntries,
    };
  }

  async manifest(
    root: string,
    options: RepositoryManifestOptions = {},
    signal?: AbortSignal,
  ): Promise<RepositoryManifestPage> {
    const snapshot = await this.snapshot(root, options, signal);
    const cursor = parseCursor(options.cursor);
    const pageSize = boundedInteger(options.pageSize, 100, 1, 200);
    const end = Math.min(snapshot.entries.length, cursor + pageSize);
    return {
      source: snapshot.source,
      entries: snapshot.entries.slice(cursor, end),
      ...(end < snapshot.entries.length ? { nextCursor: String(end) } : {}),
      totals: totalsFor(snapshot.entries),
    };
  }

  async map(
    root: string,
    options: RepositorySnapshotOptions = {},
    signal?: AbortSignal,
  ): Promise<RepositoryMap> {
    const snapshot = await this.snapshot(root, options, signal);
    const sourceRoots = rootsFor(snapshot.entries, "source");
    const testRoots = rootsFor(snapshot.entries, "test");
    const topLevelDirectories = [...new Set(
      snapshot.entries
        .map((entry) => entry.path.split("/")[0])
        .filter((value) => snapshot.entries.some((entry) => entry.path.startsWith(`${value}/`))),
    )].sort((left, right) => left.localeCompare(right));
    return {
      source: snapshot.source,
      topLevelDirectories,
      configurationFiles: snapshot.entries
        .filter((entry) => entry.kind === "configuration")
        .map((entry) => entry.path)
        .slice(0, 50),
      sourceRoots,
      testRoots,
      languages: totalsFor(snapshot.entries).language,
      truncated: snapshot.truncated || sourceRoots.some((item) => item.sources.length >= 50) ||
        testRoots.some((item) => item.sources.length >= 50),
    };
  }

  private async filesystemSnapshot(
    root: string,
    maxEntries: number,
    signal?: AbortSignal,
  ): Promise<RepositorySnapshot> {
    const paths: string[] = [];
    let truncated = false;
    const walk = async (directory: string): Promise<void> => {
      throwIfAborted(signal);
      const children = await readdir(directory, { withFileTypes: true });
      children.sort((left, right) => left.name.localeCompare(right.name));
      for (const child of children) {
        if (child.name === ".git" || child.name === "node_modules") continue;
        if (paths.length >= maxEntries) {
          truncated = true;
          return;
        }
        const absolutePath = resolve(directory, child.name);
        if (child.isDirectory()) {
          await walk(absolutePath);
          if (truncated) return;
        } else if (child.isFile()) {
          paths.push(displayPath(root, absolutePath));
        }
      }
    };
    await walk(root);

    const entries: RepositoryEntry[] = [];
    for (const path of paths) {
      const absolutePath = containedPath(root, path);
      const details = await lstat(absolutePath);
      entries.push(await classifyEntry(
        absolutePath,
        path,
        "not_applicable",
        details.size,
      ));
    }
    entries.sort((left, right) => left.path.localeCompare(right.path));
    return { root, source: "filesystem", entries, truncated };
  }
}

function parseCursor(value: string | undefined): number {
  if (value === undefined) return 0;
  if (!/^\d+$/.test(value)) throw new Error("Repository manifest cursor is invalid.");
  const cursor = Number(value);
  if (!Number.isSafeInteger(cursor)) throw new Error("Repository manifest cursor is invalid.");
  return cursor;
}

function totalsFor(entries: RepositoryEntry[]): RepositoryTotals {
  const gitState: Record<RepositoryGitState, number> = {
    tracked: 0,
    untracked: 0,
    ignored: 0,
    not_applicable: 0,
  };
  const kind: Record<RepositoryEntryKind, number> = {
    source: 0,
    test: 0,
    configuration: 0,
    documentation: 0,
    asset: 0,
    generated: 0,
    vendored: 0,
    binary: 0,
    other: 0,
  };
  const language: Record<string, number> = {};
  for (const entry of entries) {
    gitState[entry.gitState] += 1;
    kind[entry.kind] += 1;
    if (entry.language) language[entry.language] = (language[entry.language] ?? 0) + 1;
  }
  return { gitState, kind, language: sortedRecord(language) };
}

function rootsFor(
  entries: RepositoryEntry[],
  kind: Extract<RepositoryEntryKind, "source" | "test">,
): RepositoryMapRoot[] {
  const roots = new Map<string, string[]>();
  for (const entry of entries) {
    if (entry.kind !== kind) continue;
    const directory = dirname(entry.path).replaceAll("\\", "/");
    const root = directory === "." ? "." : directory.split("/")[0];
    const sources = roots.get(root) ?? [];
    if (sources.length < 50) sources.push(entry.path);
    roots.set(root, sources);
  }
  return [...roots.entries()]
    .map(([path, sources]) => ({ path, sources }))
    .sort((left, right) => left.path.localeCompare(right.path));
}

function sortedRecord(input: Record<string, number>): Record<string, number> {
  return Object.fromEntries(
    Object.entries(input).sort(([left], [right]) => left.localeCompare(right)),
  );
}

async function collectGitPaths(
  root: string,
  args: string[],
  state: RepositoryGitState,
  target: Map<string, RepositoryGitState>,
): Promise<void> {
  const result = await runGit({
    cwd: root,
    args,
    maxOutputBytes: 8 * 1024 * 1024,
  });
  for (const rawPath of result.stdout.split("\0")) {
    if (!rawPath) continue;
    const path = normalizeRepositoryPath(rawPath);
    containedPath(root, path);
    const existing = target.get(path);
    if (!existing || precedence(state) < precedence(existing)) target.set(path, state);
  }
}

function precedence(state: RepositoryGitState): number {
  switch (state) {
    case "tracked": return 0;
    case "untracked": return 1;
    case "ignored": return 2;
    case "not_applicable": return 3;
  }
}

async function classifyEntry(
  absolutePath: string,
  path: string,
  gitState: RepositoryGitState,
  byteLength: number,
): Promise<RepositoryEntry> {
  const reasons = [`git:${gitState}`];
  const prefix = await readPrefix(absolutePath);
  const language = languageFor(path);
  let kind: RepositoryEntryKind;
  if (!isUtf8Text(prefix)) {
    kind = "binary";
    reasons.push("content:binary");
  } else if (isVendored(path)) {
    kind = "vendored";
    reasons.push("path:vendored");
  } else if (isGenerated(path, prefix.toString("utf8"))) {
    kind = "generated";
    reasons.push("path-or-marker:generated");
  } else if (isTest(path)) {
    kind = "test";
    reasons.push("path:test");
  } else if (isConfiguration(path)) {
    kind = "configuration";
    reasons.push("name:configuration");
  } else if (isDocumentation(path)) {
    kind = "documentation";
    reasons.push("extension:documentation");
  } else if (language) {
    kind = "source";
    reasons.push("extension:source");
  } else if (isAsset(path)) {
    kind = "asset";
    reasons.push("extension:asset");
  } else {
    kind = "other";
    reasons.push("classification:other");
  }
  return {
    path,
    gitState,
    kind,
    ...(language ? { language } : {}),
    byteLength,
    classificationReasons: reasons,
  };
}

async function readPrefix(path: string): Promise<Buffer> {
  const bytes = await readFile(path);
  return bytes.subarray(0, MAX_CLASSIFICATION_PREFIX_BYTES);
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

function isVendored(path: string): boolean {
  return /(^|\/)(vendor|vendored|third_party|third-party)(\/|$)/i.test(path);
}

function isGenerated(path: string, prefix: string): boolean {
  return /(^|\/)(dist|build|out|coverage|\.next)(\/|$)/i.test(path) ||
    /(?:^|[._-])(generated|min)(?:[._-]|$)/i.test(basename(path)) ||
    /@generated|generated file|do not edit/i.test(prefix);
}

function isTest(path: string): boolean {
  return /(^|\/)(__tests__|tests?|spec)(\/|$)/i.test(path) ||
    /\.(?:test|spec)\.[^.]+$/i.test(path);
}

function isConfiguration(path: string): boolean {
  const name = basename(path).toLowerCase();
  return name === ".gitignore" || name === ".gitattributes" ||
    /^(?:package|tsconfig|jsconfig|eslint|prettier|vite|next|webpack)(?:\..+)?\.json$/i.test(name) ||
    /^(?:package\.json|tsconfig(?:\..+)?\.json|jsconfig(?:\..+)?\.json)$/i.test(name);
}

function isDocumentation(path: string): boolean {
  return [".md", ".mdx", ".rst", ".txt"].includes(extname(path).toLowerCase());
}

function isAsset(path: string): boolean {
  return [
    ".avif", ".gif", ".ico", ".jpeg", ".jpg", ".pdf", ".png", ".svg",
    ".webp", ".woff", ".woff2",
  ].includes(extname(path).toLowerCase());
}

function languageFor(path: string): string | undefined {
  const extension = extname(path).toLowerCase();
  return ({
    ".c": "c",
    ".cc": "cpp",
    ".cpp": "cpp",
    ".cs": "csharp",
    ".css": "css",
    ".go": "go",
    ".html": "html",
    ".java": "java",
    ".js": "javascript",
    ".jsx": "javascriptreact",
    ".json": "json",
    ".kt": "kotlin",
    ".mjs": "javascript",
    ".mts": "typescript",
    ".php": "php",
    ".py": "python",
    ".rb": "ruby",
    ".rs": "rust",
    ".scss": "scss",
    ".sh": "shell",
    ".sql": "sql",
    ".swift": "swift",
    ".ts": "typescript",
    ".tsx": "typescriptreact",
    ".vue": "vue",
    ".yaml": "yaml",
    ".yml": "yaml",
  } as Record<string, string>)[extension];
}

function containedPath(root: string, path: string): string {
  const absolutePath = resolve(root, path);
  const relation = relative(root, absolutePath);
  if (relation === ".." || relation.startsWith(`..${sep}`) || resolve(relation) === relation) {
    throw new Error(`Repository path escapes workspace: ${path}`);
  }
  return absolutePath;
}

function displayPath(root: string, path: string): string {
  return normalizeRepositoryPath(relative(root, path));
}

function normalizeRepositoryPath(path: string): string {
  return path.replaceAll("\\", "/").replace(/^\.\//, "");
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error("Repository scan cancelled.");
}

function boundedInteger(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  return Number.isSafeInteger(value) && value !== undefined
    ? Math.max(minimum, Math.min(maximum, value))
    : fallback;
}
