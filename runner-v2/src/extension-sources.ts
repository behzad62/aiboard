import { randomUUID } from "node:crypto";
import { mkdir, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import type { GitCommandExecutor } from "./git-preflight.js";
import { ExtensionManagementError, type ResolvedSource } from "./extension-management-contracts.js";
import { removeOwnedTree, snapshotDirectory, subtree, type PackageTree } from "./extension-package-store.js";

/** What a caller asks to install from. Never carries credentials or approval. */
export type SourceRequest =
  | { readonly type: "local_directory"; readonly path: string }
  | { readonly type: "upload"; readonly uploadId: string }
  | { readonly type: "git"; readonly url: string; readonly ref?: string; readonly subdirectory?: string }
  | ({ readonly type: "npm"; readonly packageName: string; readonly version?: string; readonly bin?: string } & McpLaunchOptions)
  | ({ readonly type: "pypi"; readonly packageName: string; readonly version?: string; readonly entry?: string } & McpLaunchOptions)
  | ({ readonly type: "executable"; readonly command: string } & McpLaunchOptions)
  | { readonly type: "remote_http"; readonly url: string; readonly serverName?: string; readonly auth?: "none" | "bearer" | "oauth" };

/** Launch details a user supplies for an MCP server source. Environment entries are NAMES only. */
export interface McpLaunchOptions {
  readonly args?: readonly string[];
  readonly env?: readonly string[];
  readonly serverName?: string;
}

const SERVER_NAME = /^[a-z][a-z0-9_-]{0,31}$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const LAUNCH_KEYS = ["args", "env", "serverName"];
const NPM_NAME = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/;
const PYPI_NAME = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;
const GIT_REF = /^[A-Za-z0-9][A-Za-z0-9._\/-]{0,199}$/;

export function parseSourceRequest(raw: unknown): SourceRequest {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw invalid("source must be an object with a type.");
  const value = raw as Record<string, unknown>;
  const keys = (allowed: string[]) => { for (const key of Object.keys(value)) if (!["type", ...allowed].includes(key)) throw invalid(`source field ${key} is not allowed.`); };
  const text = (key: string, max = 2048) => {
    const field = value[key];
    if (typeof field !== "string" || !field.trim() || field.length > max || /[\0\r\n]/.test(field)) throw invalid(`source.${key} must be a non-empty string.`);
    return field.trim();
  };
  const optional = (key: string, max = 2048) => value[key] === undefined ? undefined : text(key, max);
  switch (value.type) {
    case "local_directory": keys(["path"]); return { type: "local_directory", path: text("path", 4096) };
    case "upload": keys(["uploadId"]); { const uploadId = text("uploadId", 80); if (!/^upl_[a-f0-9]{32}$/.test(uploadId)) throw invalid("uploadId is not an upload reference."); return { type: "upload", uploadId }; }
    case "git": {
      keys(["url", "ref", "subdirectory"]);
      const url = text("url");
      const ref = optional("ref", 200);
      if (ref !== undefined && (!GIT_REF.test(ref) || ref.includes(".."))) throw invalid("source.ref must be a branch, tag or commit name.");
      const subdirectory = optional("subdirectory", 400);
      return { type: "git", url, ...(ref ? { ref } : {}), ...(subdirectory ? { subdirectory } : {}) };
    }
    case "npm": {
      keys(["packageName", "version", "bin", ...LAUNCH_KEYS]);
      const packageName = text("packageName", 214);
      if (!NPM_NAME.test(packageName)) throw invalid("source.packageName is not a valid npm package name.");
      const version = optional("version", 64);
      if (version !== undefined && !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) throw invalid("source.version must be an exact version (no ranges or tags).");
      const bin = optional("bin", 214);
      if (bin !== undefined && !/^[A-Za-z0-9@._-]{1,214}$/.test(bin)) throw invalid("source.bin must be a package executable name.");
      return { type: "npm", packageName, ...(version ? { version } : {}), ...(bin ? { bin } : {}), ...launchOptions(value) };
    }
    case "pypi": {
      keys(["packageName", "version", "entry", ...LAUNCH_KEYS]);
      const packageName = text("packageName", 200);
      if (!PYPI_NAME.test(packageName)) throw invalid("source.packageName is not a valid Python package name.");
      const version = optional("version", 64);
      if (version !== undefined && !/^[0-9][0-9A-Za-z.!+-]*$/.test(version)) throw invalid("source.version must be an exact version.");
      const entry = optional("entry", 200);
      if (entry !== undefined && !/^[A-Za-z0-9._-]{1,200}$/.test(entry)) throw invalid("source.entry must be a console-script name.");
      return { type: "pypi", packageName, ...(version ? { version } : {}), ...(entry ? { entry } : {}), ...launchOptions(value) };
    }
    case "executable": {
      keys(["command", ...LAUNCH_KEYS]);
      return { type: "executable", command: text("command", 4096), ...launchOptions(value) };
    }
    case "remote_http": {
      keys(["url", "serverName", "auth"]);
      const url = text("url");
      const serverName = optional("serverName", 32);
      if (serverName !== undefined && !SERVER_NAME.test(serverName)) throw invalid("source.serverName must be lowercase letters, digits, - or _ (max 32).");
      if (value.auth !== undefined && !["none", "bearer", "oauth"].includes(value.auth as string)) throw invalid("source.auth must be none, bearer or oauth.");
      return { type: "remote_http", url, ...(serverName ? { serverName } : {}), ...(value.auth ? { auth: value.auth as "none" | "bearer" | "oauth" } : {}) };
    }
    default: throw invalid("source.type must be local_directory, upload, git, npm, pypi, executable or remote_http.");
  }
}

function launchOptions(value: Record<string, unknown>): McpLaunchOptions {
  const strings = (key: string, max: number, pattern?: RegExp) => {
    const field = value[key];
    if (field === undefined) return undefined;
    if (!Array.isArray(field) || field.length > max || field.some((entry) => typeof entry !== "string" || !entry || entry.length > 4096 || /[\0\r\n]/.test(entry) || (pattern !== undefined && !pattern.test(entry))))
      throw invalid(`source.${key} must be up to ${max} valid strings.`);
    return Object.freeze([...(field as string[])]);
  };
  const args = strings("args", 64);
  const env = strings("env", 32, ENV_NAME);
  const serverName = value.serverName;
  if (serverName !== undefined && (typeof serverName !== "string" || !SERVER_NAME.test(serverName))) throw invalid("source.serverName must be lowercase letters, digits, - or _ (max 32).");
  return { ...(args ? { args } : {}), ...(env ? { env } : {}), ...(typeof serverName === "string" ? { serverName } : {}) };
}

/**
 * A stable comparison key for a source, shared by human-intent matching and trusted-source policy.
 * Keys never include credentials, query strings or fragments.
 */
export function sourceKey(source: SourceRequest | ResolvedSource, canonicalPath?: string): string {
  switch (source.type) {
    case "local_directory": return `local:${normalizeLocal(canonicalPath ?? source.path)}`;
    case "git": return `git:${normalizeGitUrl(source.url)}${source.subdirectory ? `#${trimSlashes(source.subdirectory)}` : ""}`;
    case "npm": return `npm:${source.packageName}`;
    case "pypi": return `pypi:${source.packageName.toLowerCase().replace(/[-_.]+/g, "-")}`;
    case "remote_http": return `url:${normalizeHttpUrl(source.url)}`;
    case "executable": return `exec:${normalizeLocal(source.command)}${source.args?.length ? ` ${source.args.join(" ")}` : ""}`;
    case "upload": return `upload:${source.uploadId}`;
    case "archive": return `archive:${source.archiveDigest}`;
    case "single_file": return `file:${source.treeDigest}`;
    case "cli_config": return `cli:${source.name}`;
    case "provider_hosted": return `url:${normalizeHttpUrl(source.url)}`;
    case "external_skill": return `local:${normalizeLocal(source.path)}`;
  }
}

/** True when a requested key is covered by an intent/policy key (a repository covers its subfolders). */
export function sourceKeyCovers(granted: string, requested: string): boolean {
  if (granted === requested) return true;
  if (granted.startsWith("git:") && requested.startsWith(`${granted}#`)) return true;
  if (granted.startsWith("local:") && requested.startsWith(`${granted}/`)) return true;
  return false;
}

/** Glob match for policy patterns such as npm:@scope/* or git:https://github.com/acme/*. */
export function trustedPatternMatches(pattern: string, key: string): boolean {
  const regex = new RegExp(`^${pattern.split("*").map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join("[^#\\s]*")}(?:#.*)?$`);
  return regex.test(key);
}

/**
 * Extracts sources a human named in their own words: URLs (GitHub tree links become git
 * sources), npm package specs and absolute local paths. Used only on human-authored text.
 */
export function extractSourcesFromText(text: string, projectRoot?: string): SourceRequest[] {
  const found = new Map<string, SourceRequest>();
  const add = (source: SourceRequest) => found.set(sourceKey(source), source);
  for (const match of text.matchAll(/\bhttps?:\/\/[^\s<>"'`)\]]+/gi)) {
    const url = match[0].replace(/[.,;:!?]+$/, "");
    const github = url.match(/^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?(?:\/tree\/([^/\s]+)(?:\/(.+))?)?\/?$/);
    if (github) {
      add({ type: "git", url: `https://github.com/${github[1]}/${github[2]}`, ...(github[3] ? { ref: github[3] } : {}), ...(github[4] ? { subdirectory: trimSlashes(github[4]) } : {}) });
    } else if (/\.git$/i.test(new URL(url).pathname)) {
      add({ type: "git", url });
    } else {
      add({ type: "remote_http", url });
      if (/^https:\/\/(gitlab\.com|bitbucket\.org|codeberg\.org)\//.test(url)) add({ type: "git", url });
    }
  }
  for (const match of text.matchAll(/(?:^|\s)npm:?\s*((?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*)(?:@(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?))?/g)) {
    add({ type: "npm", packageName: match[1], ...(match[2] ? { version: match[2] } : {}) });
  }
  for (const match of text.matchAll(/(?:^|\s)(@[a-z0-9][a-z0-9._~-]*\/[a-z0-9][a-z0-9._~-]*)(?:@(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?))?/g)) {
    add({ type: "npm", packageName: match[1], ...(match[2] ? { version: match[2] } : {}) });
  }
  for (const match of text.matchAll(/(?:^|\s)(?:pypi|pip install|uvx)\s+([A-Za-z0-9][A-Za-z0-9._-]*)(?:==([0-9][0-9A-Za-z.!+-]*))?/gi)) {
    add({ type: "pypi", packageName: match[1], ...(match[2] ? { version: match[2] } : {}) });
  }
  for (const match of text.matchAll(/(?:^|[\s"'`])((?:[A-Za-z]:[\\/]|\/(?!\/))[^\s"'`<>|]+|\.{1,2}[\\/][^\s"'`<>|]+)/g)) {
    const path = match[1].replace(/[.,;:!?]+$/, "");
    if (/^\/\//.test(path)) continue;
    add({ type: "local_directory", path: isAbsolute(path) || !projectRoot ? path : resolve(projectRoot, path) });
  }
  return [...found.values()];
}

export interface ResolvedTree {
  readonly source: ResolvedSource;
  readonly tree: PackageTree;
  readonly key: string;
}

/** Resolves a local folder to an immutable snapshot; the folder itself is never modified or deleted. */
export async function resolveLocalDirectory(path: string, subdirectory?: string): Promise<ResolvedTree> {
  if (!isAbsolute(path)) throw invalid("Local sources must be absolute paths.");
  let canonical: string;
  try {
    canonical = await realpath(path);
  } catch {
    throw new ExtensionManagementError("source_not_found", `No folder at ${path}.`, 404);
  }
  const tree = await snapshotDirectory(canonical, undefined, (relativePath) => relativePath === ".git" || relativePath.startsWith(".git/"));
  const selected = subdirectory ? subtree(tree, subdirectory) : tree;
  const source: ResolvedSource = { type: "local_directory", path: canonical, treeDigest: selected.digest };
  return { source, tree: selected, key: sourceKey(source) };
}

export interface GitSourceOptions {
  /** Governed executor (Runner internal process kernel); never a raw spawn. */
  readonly executorFor: (cwd: string) => GitCommandExecutor;
  readonly scratchDirectory: string;
  /** Local repositories are allowed only for UI requests and tests; agents use https. */
  readonly allowLocal: boolean;
}

/**
 * Fetches exactly one commit of a repository into a private scratch folder (depth 1, no hooks, no
 * submodules, no credential prompts) and snapshots it. Repository content is never executed.
 */
export async function resolveGit(request: Extract<SourceRequest, { type: "git" }>, options: GitSourceOptions): Promise<ResolvedTree> {
  const url = validateGitUrl(request.url, options.allowLocal);
  const scratch = join(options.scratchDirectory, `git-${randomUUID()}`);
  await mkdir(scratch, { recursive: true });
  try {
    const git = options.executorFor(scratch);
    const run = async (args: string[], label: string) => {
      const result = await git("git", [
        "-c", `core.hooksPath=${join(scratch, "no-hooks")}`, "-c", "protocol.ext.allow=never", "-c", "protocol.file.allow=" + (options.allowLocal ? "always" : "never"),
        "-c", "credential.helper=", "-c", "core.symlinks=false", "-c", "core.autocrlf=false", ...args,
      ]);
      if (result.exitCode !== 0) throw new ExtensionManagementError("git_failed", `Git ${label} failed: ${redactGit(result.stderr || result.stdout).slice(0, 400)}`, 502);
      return result.stdout.trim();
    };
    await run(["init", "--quiet", "repo"], "init");
    const repo = join(scratch, "repo");
    const ref = request.ref ?? "HEAD";
    await run(["-C", repo, "fetch", "--quiet", "--depth", "1", "--no-tags", "--no-recurse-submodules", url, ref], "fetch");
    const commit = await run(["-C", repo, "rev-parse", "FETCH_HEAD^{commit}"], "rev-parse");
    if (!/^[a-f0-9]{40,64}$/.test(commit)) throw new ExtensionManagementError("git_failed", "Git did not report a commit id.", 502);
    await run(["-C", repo, "-c", "advice.detachedHead=false", "checkout", "--quiet", "--detach", commit], "checkout");
    const tree = await snapshotDirectory(repo, undefined, (path) => path === ".git" || path.startsWith(".git/"));
    const selected = request.subdirectory ? subtree(tree, request.subdirectory) : tree;
    const source: ResolvedSource = {
      type: "git", url, requestedRef: ref, commit,
      ...(request.subdirectory ? { subdirectory: trimSlashes(request.subdirectory) } : {}),
      treeDigest: selected.digest,
    };
    return { source, tree: selected, key: sourceKey(source) };
  } finally {
    await removeOwnedTree(scratch);
  }
}

export function validateGitUrl(url: string, allowLocal: boolean): string {
  if (/^https:\/\//i.test(url)) {
    const parsed = new URL(url);
    if (parsed.username || parsed.password) throw invalid("Git URLs cannot contain credentials.");
    if (parsed.search || parsed.hash) throw invalid("Git URLs cannot have a query or fragment.");
    return parsed.toString().replace(/\/$/, "");
  }
  if (allowLocal && (isAbsolute(url) || /^file:\/\//i.test(url))) return url;
  throw invalid(allowLocal ? "Git sources must be https:// URLs or local repository paths." : "Git sources must be https:// URLs.");
}

export function normalizeHttpUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.host.toLowerCase()}${parsed.pathname.replace(/\/+$/, "")}`;
  } catch {
    return url;
  }
}

function normalizeGitUrl(url: string): string {
  if (!/^https?:\/\//i.test(url)) return normalizeLocal(url.replace(/^file:\/\//i, ""));
  return normalizeHttpUrl(url).replace(/\.git$/i, "");
}

function normalizeLocal(path: string): string {
  const unified = resolve(path).split(sep).join("/");
  return process.platform === "win32" ? unified.toLowerCase() : unified;
}

function trimSlashes(path: string): string {
  return path.replaceAll("\\", "/").replace(/^\/+|\/+$/g, "");
}

function redactGit(text: string): string {
  return text.replace(/https?:\/\/[^@\s/]+@/g, "https://<redacted>@");
}

/** True when the candidate path is inside root (both canonical). */
export function isWithin(root: string, candidate: string): boolean {
  const traversal = relative(root, candidate);
  return traversal === "" || (!traversal.startsWith("..") && !isAbsolute(traversal));
}

function invalid(message: string): ExtensionManagementError {
  return new ExtensionManagementError("invalid_source", message);
}
