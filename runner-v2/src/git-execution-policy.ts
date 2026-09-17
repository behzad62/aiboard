import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";

import { GitCommandError, type GitCommandOptions } from "./git-command.js";

export interface PreparedGitExecutionPolicy {
  readonly arguments: readonly string[];
  readonly environment: Readonly<Record<string, string | undefined>>;
}

const ALLOWED_CALLER_ENV = new Set([
  "GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL", "GIT_INDEX_FILE",
]);

const REMOVE_AMBIENT_ENV = [
  "GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_NAMESPACE", "GIT_CEILING_DIRECTORIES", "GIT_DISCOVERY_ACROSS_FILESYSTEM", "GIT_EXEC_PATH",
  "GIT_TEMPLATE_DIR", "GIT_CONFIG", "GIT_CONFIG_SYSTEM", "GIT_CONFIG_PARAMETERS", "GIT_PROXY_COMMAND",
  "GIT_PROTOCOL", "GIT_SSH", "GIT_SSH_COMMAND", "GIT_SSH_VARIANT", "GIT_EXTERNAL_DIFF", "GIT_DIFF_OPTS",
  "PAGER", "EDITOR", "VISUAL",
] as const;

const SAFE_CONFIG = [
  "core.hooksPath=", "core.fsmonitor=false", "credential.helper=", "credential.interactive=false",
  "core.askPass=", "core.editor=", "core.attributesFile=", "interactive.diffFilter=",
  "commit.gpgSign=false", "merge.gpgSign=false", "tag.gpgSign=false", "log.showSignature=false",
  "merge.verifySignatures=false", "submodule.recurse=false", "protocol.ext.allow=never",
] as const;
const ALLOWED_COMMANDS = new Set([
  "rev-parse", "symbolic-ref", "status", "show", "diff", "ls-files", "ls-tree", "log", "cat-file",
  "rev-list", "merge-base", "diff-tree", "for-each-ref", "branch", "init", "hash-object", "add",
  "write-tree", "commit-tree", "update-ref", "reset", "worktree", "checkout", "switch", "commit",
  "merge", "merge-tree", "cherry-pick", "clean", "apply", "mktree", "update-index", "read-tree",
  "remote", "push",
]);

const FORBIDDEN_LONG_ARGUMENTS = [
  "--config-env", "--git-dir", "--work-tree", "--exec-path", "--namespace", "--super-prefix", "--paginate",
] as const;

const MAX_CONFIG_BYTES = 1024 * 1024;
const MAX_ATTRIBUTES_BYTES = 1024 * 1024;
const MAX_ATTRIBUTE_ENTRIES = 500_000;
const ATTRIBUTE_SCAN_SKIP_DIRECTORIES = new Set([
  "node_modules", ".next", ".turbo", ".cache", "coverage", "out", "playwright-report", "test-results",
]);
const attributePolicyCache = new Map<string, Promise<void>>();

export function prepareGitExecutionPolicy(
  options: Readonly<GitCommandOptions>,
  platform: NodeJS.Platform = process.platform,
): PreparedGitExecutionPolicy {
  validateArguments(options.args);
  const caller = canonicalCallerEnvironment(options.env);
  const environment: Record<string, string | undefined> = { ...caller };
  for (const name of REMOVE_AMBIENT_ENV) environment[name] = undefined;
  Object.assign(environment, {
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: platform === "win32" ? "NUL" : "/dev/null",
    GIT_CONFIG_COUNT: "0",
    GIT_ATTR_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_PAGER: "",
    GIT_EDITOR: "",
    GIT_SEQUENCE_EDITOR: "",
    GIT_MERGE_AUTOEDIT: "no",
    GIT_ASKPASS: "",
    SSH_ASKPASS: "",
    SSH_ASKPASS_REQUIRE: "never",
    GIT_ALLOW_PROTOCOL: "file:git:http:https:ssh",
    GIT_CEILING_DIRECTORIES: dirname(resolve(options.cwd)),
    GIT_DISCOVERY_ACROSS_FILESYSTEM: "0",
  });
  const policyArguments = ["--no-pager"];
  for (const entry of SAFE_CONFIG) policyArguments.push("-c", entry);
  policyArguments.push(...options.args);
  return Object.freeze({ arguments: Object.freeze(policyArguments), environment: Object.freeze(environment) });
}

/** Inspect only repository-owned metadata reachable from the already-authorized
 * working directory. This never shells out to Git and must run before Git launch. */export async function enforceGitRepositoryExecutionPolicy(workingDirectory: string): Promise<void> {
  const repository = await repositoryMetadata(workingDirectory);
  if (!repository) return;
  await inspectConfigFile(join(repository.commonDir, "config"), "repository config", true);
  if (repository.gitDir !== repository.commonDir) {
    await inspectConfigFile(join(repository.gitDir, "config.worktree"), "worktree config", false);
  }
  await inspectConfigFile(join(repository.workTree, ".gitmodules"), ".gitmodules", false);
  await inspectAttributesFile(join(repository.commonDir, "info", "attributes"), "repository info attributes");
  await inspectWorkTreeAttributes(repository.workTree);
}

function validateArguments(args: readonly string[]): void {
  const command = args[0];
  if (!command || command.startsWith("-") || !ALLOWED_COMMANDS.has(command)) {
    throw policyError(`Git command '${command ?? ""}' is outside the Runner Git policy.`);
  }
  for (const argument of args.slice(1)) {
    if (FORBIDDEN_LONG_ARGUMENTS.some((name) => argument === name || argument.startsWith(`${name}=`))) {
      throw policyError(`Git argument '${argument}' can replace Runner execution policy.`);
    }
    if (argument === "--recurse-submodules" || argument.startsWith("--recurse-submodules=")) {
      throw policyError("Git submodule recursion is not permitted by Runner execution policy.");
    }
    if (argument === "--unsafe-paths") throw policyError("Git unsafe path writes are not permitted.");
    if (argument === "-S" || argument.startsWith("-S") || argument === "--gpg-sign" || argument.startsWith("--gpg-sign=")) {
      throw policyError("Git signing program execution is not permitted.");
    }
    if (argument === "--show-signature" || argument === "--verify-signatures") {
      throw policyError("Git signature program execution is not permitted.");
    }
  }
  if (["commit", "merge", "cherry-pick"].includes(command) && args.slice(1).some((arg) => arg === "-e" || arg === "--edit")) {
    throw policyError(`Git ${command} may not request an editor.`);
  }
  if (command === "remote") validateRemoteArguments(args);
  if (command === "push") validatePushArguments(args);
  if (command === "commit" && !hasNonInteractiveCommitMessage(args)) {
    throw policyError("Git commit requires a Runner-supplied message or --no-edit.");
  }
  if (command === "add" && args.slice(1).some((arg) => ["-p", "--patch", "-i", "--interactive", "-e", "--edit"].includes(arg))) {
    throw policyError("Interactive Git add modes are not permitted.");
  }
}

function validateRemoteArguments(args: readonly string[]): void {
  if (args.length === 1) return;
  if (args.length === 3 && args[1] === "get-url" && safeName(args[2]!)) return;
  if (args.length === 4 && args[1] === "get-url" && args[2] === "--push" && safeName(args[3]!)) return;
  throw policyError("Only read-only Git remote inspection is permitted.");
}

function validatePushArguments(args: readonly string[]): void {
  let index = 1;
  for (const flag of ["--force-with-lease", "--set-upstream"]) {
    if (args[index] === flag) index += 1;
  }
  if (args.length !== index + 2 || !safeName(args[index]!) || !safeRefspec(args[index + 1]!)) {
    throw policyError("Git push must use one explicit Runner remote and refspec.");
  }
  validateRemoteUrl(args[index]!, "Git push remote");
}

function hasNonInteractiveCommitMessage(args: readonly string[]): boolean {
  return args.includes("--no-edit") || args.some((arg, index) =>
    arg === "-m" ? typeof args[index + 1] === "string" : arg.startsWith("--message=") || /^-m.+/.test(arg));
}

function safeName(value: string): boolean {
  return value.length > 0 && !value.startsWith("-") && !value.includes("\0");
}

function safeRefspec(value: string): boolean {
  return safeName(value) && value.includes(":") && !/[\r\n]/.test(value);
}

function canonicalCallerEnvironment(
  requested: Readonly<Record<string, string | undefined>> | undefined,
): Record<string, string | undefined> {
  const result: Record<string, string | undefined> = {};
  const seen = new Set<string>();
  for (const [rawName, value] of Object.entries(requested ?? {})) {
    const name = rawName.toUpperCase();
    if (seen.has(name)) throw policyError(`Git environment override '${rawName}' duplicates another canonical variable.`);
    seen.add(name);
    if (!ALLOWED_CALLER_ENV.has(name)) throw policyError(`Git environment override '${rawName}' is not permitted.`);
    result[name] = value;
  }
  return result;
}
interface RepositoryMetadata {
  readonly workTree: string;
  readonly gitDir: string;
  readonly commonDir: string;
}

async function repositoryMetadata(workingDirectory: string): Promise<RepositoryMetadata | undefined> {
  const workingStat = await optionalLstat(workingDirectory);
  if (!workingStat) return undefined;
  if (!workingStat.isDirectory() || workingStat.isSymbolicLink()) {
    throw policyError("Authorized Git working directory must be a regular directory.");
  }
  const workTree = resolve(await realpath(workingDirectory));
  const marker = join(workTree, ".git");
  const markerStat = await optionalLstat(marker);
  if (!markerStat) return undefined;
  if (markerStat.isSymbolicLink()) throw policyError("Repository .git metadata must not be a symbolic link.");
  if (markerStat.isDirectory()) return Object.freeze({ workTree, gitDir: marker, commonDir: marker });
  if (!markerStat.isFile()) throw policyError("Repository .git metadata has an unsupported type.");

  const text = await readBoundedText(marker, 16 * 1024, "repository .git file");
  const match = /^gitdir:\s*(.+?)\s*$/i.exec(text.trim());
  if (!match) throw policyError("Repository .git file is malformed.");
  const gitDir = resolve(dirname(marker), match[1]!);
  const gitStat = await optionalLstat(gitDir);
  if (!gitStat?.isDirectory() || gitStat.isSymbolicLink()) {
    throw policyError("Repository gitdir target is not a regular directory.");
  }
  const canonicalGitDir = resolve(await realpath(gitDir));
  await verifyLinkedWorktree(marker, canonicalGitDir);
  const commonDir = await commonDirectory(canonicalGitDir);
  return Object.freeze({ workTree, gitDir: canonicalGitDir, commonDir });
}
async function verifyLinkedWorktree(marker: string, gitDir: string): Promise<void> {
  const backPointer = join(gitDir, "gitdir");
  const backText = await readOptionalBoundedText(backPointer, 16 * 1024, "linked-worktree gitdir pointer");
  if (!backText) throw policyError("External gitdir targets require a linked-worktree back pointer.");
  const actual = resolve(gitDir, backText.trim());
  if (!(await sameFile(marker, actual))) {
    throw policyError("Linked-worktree gitdir pointer does not match the authorized worktree.");
  }
}

async function commonDirectory(gitDir: string): Promise<string> {
  const text = await readOptionalBoundedText(join(gitDir, "commondir"), 16 * 1024, "Git commondir pointer");
  if (!text) return gitDir;
  const candidate = resolve(gitDir, text.trim());
  const stat = await optionalLstat(candidate);
  if (!stat?.isDirectory() || stat.isSymbolicLink()) {
    throw policyError("Git commondir target is not a regular directory.");
  }
  return resolve(await realpath(candidate));
}

async function inspectConfigFile(path: string, label: string, inspectRemoteUrls: boolean): Promise<void> {
  const text = await readOptionalBoundedText(path, MAX_CONFIG_BYTES, label);
  if (text === undefined) return;
  let section = "";
  let subsection = "";
  for (const rawLine of text.split(/\r?\n/)) {    const line = rawLine.trim();
    if (!line || line.startsWith("#") || line.startsWith(";")) continue;
    if (hasContinuation(rawLine)) throw policyError(`${label} uses unsupported continuation syntax.`);
    if (line.startsWith("[")) {
      const parsed = parseSection(line, label);
      section = parsed.section;
      subsection = parsed.subsection;
      if (["include", "includeif", "alias", "url"].includes(section)) {
        throw policyError(`${label} contains unsafe [${section}] configuration.`);
      }
      if (section === "gpg" || section.startsWith("gpg.")) {
        throw policyError(`${label} can select a signing program.`);
      }
      continue;
    }
    const entry = parseConfigEntry(line, label);
    const key = entry.key;
    const value = entry.value;
    if (section === "filter" && ["clean", "smudge", "process"].includes(key)) {
      throw policyError(`${label} can select a ${key} filter program.`);
    }
    if (section === "diff" && ["command", "textconv", "external"].includes(key)) {
      throw policyError(`${label} can select a diff program.`);
    }
    if (section === "merge" && key === "driver") {
      throw policyError(`${label} can select a merge driver program.`);
    }
    if (section === "credential" && key === "helper") {
      throw policyError(`${label} can select a credential helper program.`);
    }
    if (section === "core" && ["sshcommand", "gitproxy", "alternaterefscommand", "attributesfile", "worktree"].includes(key)) {
      throw policyError(`${label} contains unsafe core.${key} configuration.`);
    }
    if (section === "interactive" && key === "difffilter") {
      throw policyError(`${label} can select an interactive diff program.`);
    }
    if (section === "gc" && key === "recentobjectshook") {
      throw policyError(`${label} can select a GC hook program.`);
    }
    if (section === "uploadpack" && key === "packobjectshook") {
      throw policyError(`${label} can select an upload-pack helper program.`);
    }
    if (section === "remote" && ["uploadpack", "receivepack", "vcs"].includes(key)) {
      throw policyError(`${label} can select a remote helper program.`);
    }
    if (section === "submodule" && key === "update" && unquote(value).trimStart().startsWith("!")) {
      throw policyError(`${label} contains a custom submodule update command.`);
    }
    if (inspectRemoteUrls && section === "remote" && ["url", "pushurl"].includes(key)) {
      validateRemoteUrl(unquote(value), `${label} remote '${subsection}'`);
    }
    if (section === "submodule" && key === "url") {
      validateRemoteUrl(unquote(value), `${label} submodule '${subsection}'`);
    }
  }
}

function parseSection(line: string, label: string): { section: string; subsection: string } {
  const modern = /^\[\s*([A-Za-z0-9-]+)(?:\s+"((?:[^"\\]|\\.)*)")?\s*\](?:\s*[#;].*)?$/.exec(line);  if (modern) {
    return { section: modern[1]!.toLowerCase(), subsection: (modern[2] ?? "").toLowerCase() };
  }
  const legacy = /^\[\s*([A-Za-z0-9-]+)\.([^\]]+)\s*\](?:\s*[#;].*)?$/.exec(line);
  if (legacy) {
    return { section: legacy[1]!.toLowerCase(), subsection: legacy[2]!.trim().toLowerCase() };
  }
  throw policyError(`${label} contains configuration syntax the Runner cannot safely classify.`);
}

function parseConfigEntry(line: string, label: string): { key: string; value: string } {
  const match = /^([A-Za-z][A-Za-z0-9-]*)\s*(?:=\s*(.*))?$/.exec(line);
  if (!match) throw policyError(`${label} contains configuration syntax the Runner cannot safely classify.`);
  return { key: match[1]!.toLowerCase(), value: match[2] ?? "true" };
}

function hasContinuation(line: string): boolean {
  const trimmed = line.trimEnd();
  let slashes = 0;
  for (let index = trimmed.length - 1; index >= 0 && trimmed[index] === "\\"; index -= 1) {
    slashes += 1;
  }
  return slashes % 2 === 1;
}

function unquote(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1).replace(/\\([\\"])/g, "$1");  }
  return trimmed.replace(/\s+[;#].*$/, "").trim();
}

function validateRemoteUrl(value: string, label: string): void {
  const url = value.trim();
  if (!url || /^[A-Za-z][A-Za-z0-9+.-]*::/.test(url)) {
    throw policyError(`${label} uses a remote-helper transport.`);
  }
  const scheme = /^([A-Za-z][A-Za-z0-9+.-]*):\/\//.exec(url)?.[1]?.toLowerCase();
  if (scheme && !["file", "git", "http", "https", "ssh"].includes(scheme)) {
    throw policyError(`${label} uses unsupported '${scheme}' transport.`);
  }
}

async function inspectWorkTreeAttributes(workTree: string): Promise<void> {
  let scan = attributePolicyCache.get(workTree);
  if (!scan) {
    scan = scanWorkTreeAttributes(workTree);
    attributePolicyCache.set(workTree, scan);
  }
  try {
    await scan;
  } catch (error) {
    if (attributePolicyCache.get(workTree) === scan) attributePolicyCache.delete(workTree);
    throw error;
  }
}

async function scanWorkTreeAttributes(workTree: string): Promise<void> {
  let visited = 0;
  const walk = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      visited += 1;
      if (visited > MAX_ATTRIBUTE_ENTRIES) {
        throw policyError("Repository is too large to classify attributes safely.");
      }
      if (entry.name === ".git" || (entry.isDirectory() && ATTRIBUTE_SCAN_SKIP_DIRECTORIES.has(entry.name))) continue;
      const path = join(directory, entry.name);
      if (entry.name === ".gitattributes") {
        const stat = await lstat(path);
        if (stat.isSymbolicLink() || !stat.isFile()) {
          throw policyError("Repository .gitattributes must be a regular file.");
        }
        await inspectAttributesFile(path, relative(workTree, path) || ".gitattributes");
      } else if (entry.isDirectory() && !entry.isSymbolicLink()) {
        await walk(path);
      }
    }
  };
  await walk(workTree);
}

async function inspectAttributesFile(path: string, label: string): Promise<void> {
  const text = await readOptionalBoundedText(path, MAX_ATTRIBUTES_BYTES, label);
  if (text === undefined) return;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const tokens = line.split(/\s+/).slice(1);
    for (const token of tokens) {
      const lower = token.toLowerCase();
      if (lower === "filter" || lower.startsWith("filter=") || lower.startsWith("diff=") || lower.startsWith("merge=")) {
        throw policyError(`${label} selects a repository-controlled Git driver.`);
      }
    }
  }
}

async function readOptionalBoundedText(path: string, maximum: number, label: string): Promise<string | undefined> {
  const stat = await optionalLstat(path);
  if (!stat) return undefined;
  if (stat.isSymbolicLink() || !stat.isFile()) throw policyError(`${label} must be a regular file.`);  if (stat.size > maximum) throw policyError(`${label} is too large to classify safely.`);
  return await readFile(path, "utf8");
}

async function readBoundedText(path: string, maximum: number, label: string): Promise<string> {
  const text = await readOptionalBoundedText(path, maximum, label);
  if (text === undefined) throw policyError(`${label} is missing.`);
  return text;
}

async function optionalLstat(path: string): Promise<Awaited<ReturnType<typeof lstat>> | undefined> {
  try {
    return await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function sameFile(left: string, right: string): Promise<boolean> {
  const [leftStat, rightStat] = await Promise.all([optionalLstat(left), optionalLstat(right)]);
  return Boolean(leftStat && rightStat && !leftStat.isSymbolicLink() && !rightStat.isSymbolicLink() &&
    leftStat.isFile() && rightStat.isFile() && leftStat.dev === rightStat.dev && leftStat.ino === rightStat.ino);
}

function policyError(message: string): GitCommandError {
  return new GitCommandError("policy_refused", `Git execution policy refused the command: ${message}`);
}