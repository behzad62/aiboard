import { hashExecutableDescriptor } from "./mcp-executable-digest.js";
import { lstat, realpath, stat } from "node:fs/promises";
import { extname, isAbsolute, join, resolve, sep } from "node:path";

const MAX_EXECUTABLE_BYTES = 512 * 1024 * 1024;
const WINDOWS_NATIVE_EXTENSIONS = new Set([".exe", ".com"]);
const WINDOWS_BATCH_EXTENSIONS = new Set([".cmd", ".bat"]);

export type LanguageServerLauncherKind = "native" | "batch";

/**
 * Canonical byte identity of the program Runner will actually launch. On
 * Windows a batch identity attests the `.cmd`/`.bat` shim handed to the Job
 * Object host; that host retains its safe argv-only launcher handling.
 */
export interface LanguageServerExecutableIdentity {
  path: string;
  digest: string;
  launcher: LanguageServerLauncherKind;
}

export interface LanguageServerExecutableResolutionOptions {
  commandSearchDirectory?: string;
  environment?: NodeJS.ProcessEnv;
  /** Test seam for platform-specific resolution behavior. */
  platform?: NodeJS.Platform;
}

export type LanguageServerCommandCandidateOptions =
  LanguageServerExecutableResolutionOptions;

/** Resolves a configured command once and records the exact launcher bytes. */
export async function resolveLanguageServerExecutable(
  command: string,
  options: LanguageServerExecutableResolutionOptions = {},
): Promise<LanguageServerExecutableIdentity> {
  if (typeof command !== "string" || !command.trim() || command.includes("\0")) {
    throw new Error("Language server command must be a non-empty string without NUL bytes.");
  }
  const cwd = resolve(options.commandSearchDirectory ?? process.cwd());
  const environment = options.environment ?? Object.freeze({});
  const platform = options.platform ?? process.platform;
  const searchesPath = isBareCommand(command);
  const candidates = languageServerCommandCandidates(command, {
    commandSearchDirectory: cwd,
    environment,
    platform,
  });
  let lastNotFound: unknown;
  for (const candidate of candidates) {
    try {
      return await identifyExecutable(candidate, platform);
    } catch (error) {
      if (isUnavailableCandidate(error)) {
        lastNotFound = error;
        if (searchesPath) continue;
      }
      throw error;
    }
  }
  throw new Error(
    `Language server command ${command} was not found as a regular supported executable.`,
    { cause: lastNotFound },
  );
}

/**
 * Rehashes immediately before process creation. The process launcher must use
 * `identity.path`, never the original PATH/bare command, so PATH replacement
 * and post-contract binary changes fail before a child exists.
 */
export async function assertLanguageServerExecutableIdentity(
  identity: LanguageServerExecutableIdentity,
): Promise<void> {
  if (!isIdentity(identity)) {
    throw new Error("Language server executable identity is invalid.");
  }
  const actual = await identifyExecutable(identity.path, process.platform);
  if (
    normalizePath(actual.path) !== normalizePath(identity.path) ||
    actual.digest !== identity.digest ||
    actual.launcher !== identity.launcher
  ) {
    throw new Error(
      `Language server executable ${identity.path} differs from its attested capability identity.`,
    );
  }
}

export function cloneLanguageServerExecutableIdentity(
  identity: LanguageServerExecutableIdentity,
): LanguageServerExecutableIdentity {
  if (!isIdentity(identity)) throw new Error("Language server executable identity is invalid.");
  return { ...identity };
}

/**
 * Produces the same conventional command-search candidates as the process
 * launcher. POSIX bare commands search PATH only (empty entries mean cwd);
 * Windows additionally probes cwd first before PATH and applies PATHEXT.
 */
export function languageServerCommandCandidates(
  command: string,
  options: LanguageServerCommandCandidateOptions = {},
): string[] {
  const cwd = resolve(options.commandSearchDirectory ?? process.cwd());
  const environment = options.environment ?? Object.freeze({});
  const platform = options.platform ?? process.platform;
  const hasSeparator = command.includes(sep) || command.includes("/") || command.includes("\\");
  const bases = isAbsolute(command)
    ? [resolve(command)]
    : hasSeparator
      ? [resolve(cwd, command)]
      : [
          ...(platform === "win32" ? [resolve(cwd, command)] : []),
          ...pathEntries(environment, cwd, platform).map((directory) => join(directory, command)),
        ];
  const suffixes = commandSuffixes(command, environment, platform);
  const candidates: string[] = [];
  for (const base of bases) {
    for (const suffix of suffixes) {
      const candidate = `${base}${suffix}`;
      if (!candidates.some((item) => normalizePath(item) === normalizePath(candidate))) {
        candidates.push(candidate);
      }
    }
  }
  return candidates;
}

function commandSuffixes(
  command: string,
  environment: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): string[] {
  if (platform !== "win32" || extname(command)) return [""];
  const value = environmentValue(environment, "PATHEXT", platform) ?? ".COM;.EXE;.BAT;.CMD";
  const extensions = value
    .split(";")
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => item.startsWith(".") ? item.toLowerCase() : `.${item.toLowerCase()}`)
    .filter((item) => WINDOWS_NATIVE_EXTENSIONS.has(item) || WINDOWS_BATCH_EXTENSIONS.has(item));
  return extensions.length > 0 ? extensions : [".com", ".exe", ".bat", ".cmd"];
}

function pathEntries(
  environment: NodeJS.ProcessEnv,
  cwd: string,
  platform: NodeJS.Platform,
): string[] {
  const value = environmentValue(environment, "PATH", platform);
  if (value === undefined) return [];
  return value
    .split(platform === "win32" ? ";" : ":")
    .map((item) => platform === "win32" ? item.trim().replace(/^"|"$/g, "") : item)
    // execvp treats empty PATH entries as the current working directory.
    .map((item) => item ? resolve(cwd, item) : cwd);
}

function environmentValue(
  environment: NodeJS.ProcessEnv,
  name: string,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  const direct = environment[name];
  if (typeof direct === "string") return direct;
  if (platform !== "win32") return undefined;
  const key = Object.keys(environment).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
  const value = key ? environment[key] : undefined;
  return typeof value === "string" ? value : undefined;
}

class UnusableLanguageServerExecutableCandidateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnusableLanguageServerExecutableCandidateError";
  }
}

async function identifyExecutable(
  path: string,
  platform: NodeJS.Platform,
): Promise<LanguageServerExecutableIdentity> {
  const requested = resolve(path);
  const metadata = await lstat(requested);
  if (!metadata.isFile() && !metadata.isSymbolicLink()) {
    throw new UnusableLanguageServerExecutableCandidateError(
      `Language server command ${requested} must be a regular file.`,
    );
  }
  const canonical = await realpath(requested);
  const actual = await stat(canonical);
  if (!actual.isFile()) {
    throw new UnusableLanguageServerExecutableCandidateError(
      `Language server command ${canonical} must be a regular file.`,
    );
  }
  if (actual.size > MAX_EXECUTABLE_BYTES) {
    throw new Error(`Language server command ${canonical} exceeds the ${MAX_EXECUTABLE_BYTES} byte limit.`);
  }
  const extension = extname(canonical).toLowerCase();
  let launcher: LanguageServerLauncherKind;
  if (platform === "win32") {
    if (WINDOWS_NATIVE_EXTENSIONS.has(extension)) launcher = "native";
    else if (WINDOWS_BATCH_EXTENSIONS.has(extension)) launcher = "batch";
    else {
      throw new UnusableLanguageServerExecutableCandidateError(
        `Language server command ${canonical} must be a .exe/.com program or a .cmd/.bat shim on Windows.`,
      );
    }
  } else {
    if ((actual.mode & 0o111) === 0) {
      throw new UnusableLanguageServerExecutableCandidateError(
        `Language server command ${canonical} must be executable.`,
      );
    }
    launcher = "native";
  }
  const digest = await hashExecutableDescriptor(canonical);
  return {
    path: canonical,
    digest,
    launcher,
  };
}

function isBareCommand(command: string): boolean {
  return !isAbsolute(command) &&
    !command.includes(sep) &&
    !command.includes("/") &&
    !command.includes("\\");
}

function isUnavailableCandidate(error: unknown): boolean {
  return isErrno(error, "ENOENT") ||
    isErrno(error, "ENOTDIR") ||
    error instanceof UnusableLanguageServerExecutableCandidateError;
}

function isIdentity(value: unknown): value is LanguageServerExecutableIdentity {
  return typeof value === "object" && value !== null &&
    typeof (value as { path?: unknown }).path === "string" &&
    typeof (value as { digest?: unknown }).digest === "string" &&
    /^[a-f0-9]{64}$/.test((value as { digest: string }).digest) &&
    ((value as { launcher?: unknown }).launcher === "native" ||
      (value as { launcher?: unknown }).launcher === "batch");
}

function normalizePath(path: string): string {
  const value = resolve(path);
  return process.platform === "win32" ? value.toLowerCase() : value;
}

function isErrno(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
