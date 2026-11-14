import { lstat, stat } from "node:fs/promises";
import { isAbsolute, sep } from "node:path";

import type { RunnerProcessEnvironmentResolver } from "./child-environment.js";
import { languageServerCommandCandidates } from "./language-server-executable.js";
import {
  resolveProjectCheckForLookup,
  resolvedCheckLaunch,
  type ProjectVerificationCheck,
} from "./verification-plan-v2.js";

/**
 * VF2: the Runner's own lookup of a check's executable, made before it
 * launches the check. Only `missing` turns a check into `not_run: tool_missing`;
 * `found` and `unknown` launch as before, so a launch that fails for any other
 * reason stays a failure.
 */
export type CheckToolLookupResult =
  | { status: "found"; path: string }
  | { status: "missing" }
  | { status: "unknown"; reason: string };

/** VF4b: the session a looked-up command would run for (child-environment.ts processEnvironment). */
export interface CheckToolOwner {
  runId: string;
  sessionId: string;
}

export type CheckToolLookup = (
  executable: string,
  input: { cwd: string; owner?: CheckToolOwner },
) => Promise<CheckToolLookupResult>;

export interface CheckToolLookupOptions {
  /** The environment the Runner gives its children; read on every lookup. */
  environment: () => Readonly<Record<string, string | undefined>>;
  /**
   * VF4b: the Runner's own per-owner values (the Playwright CLI shims' folder). A launch puts the
   * owner's `pathPrepend` first on PATH, after its install-root filter (child-environment.ts), so
   * the lookup searches it first too: `playwright-cli-session` is found where the launch finds it.
   * Read on every lookup, so it follows the run's current configuration.
   */
  processEnvironment?: RunnerProcessEnvironmentResolver;
  /** Test seam for platform-specific resolution. */
  platform?: NodeJS.Platform;
}

/** One command a check launches, in the folder it launches in. */
export interface CheckToolLookupTarget {
  executable: string;
  cwd: string;
  environment?: Readonly<Record<string, string | undefined>>;
}

/**
 * VF2/VF4: the executables of these commands the lookup finds missing, in order. The one rule
 * both the final check and the pre-planning inventory use, so the two never disagree: each
 * command is looked up in the folder it launches in; a command that sets its own PATH searches
 * directories the Runner did not look in, so it is skipped; an undecided or failed lookup
 * launches as before.
 */
export async function missingCheckTools(
  targets: readonly CheckToolLookupTarget[],
  lookup: CheckToolLookup,
): Promise<string[]> {
  const missing: string[] = [];
  const seen = new Set<string>();
  for (const { executable, cwd, environment } of targets) {
    if (Object.keys(environment ?? {}).some((name) => name.toUpperCase() === "PATH")) continue;
    const key = `${cwd}\u0000${executable}`;
    if (seen.has(key)) continue;
    seen.add(key);
    let found;
    try {
      found = await lookup(executable, { cwd });
    } catch {
      continue;
    }
    if (found.status === "missing" && !missing.includes(executable)) missing.push(executable);
  }
  return missing;
}

/** VF4: a mandatory declared check and the tools it needs, as the lookup found them. */
export interface MandatoryCheckTools {
  checkId: string;
  label: string;
  /** The line of the check's id in aiboard-validation.json. */
  configLine?: number;
  /** The command names it launches that a lookup searches for (no paths). */
  tools: string[];
  /** Those of them the lookup found missing. */
  missing: string[];
}

/**
 * VF4: for each check aiboard-validation.json marks mandatory, the tools it launches and which
 * are missing, decided exactly as the final check decides it: the check resolved as the Runner
 * would launch it, the dependency provisioning first, each command looked up in the folder it
 * launches in (resolvedCheckLaunch) with the shared rule (missingCheckTools).
 */
export async function mandatoryProjectCheckTools(input: {
  checks: readonly ProjectVerificationCheck[];
  provisioning?: { executable: string; environment?: Readonly<Record<string, string | undefined>> };
  workspacePath: string;
  lookup: CheckToolLookup;
  nodeExecutable?: string;
}): Promise<MandatoryCheckTools[]> {
  const result: MandatoryCheckTools[] = [];
  for (const check of input.checks.filter((candidate) => candidate.mandatory)) {
    const resolved = resolveProjectCheckForLookup(check, input.nodeExecutable ?? process.execPath);
    const launch = await resolvedCheckLaunch(resolved, input.workspacePath, input.provisioning);
    const tools = [...new Set(launch.targets.map((target) => target.executable)
      .filter((executable) => !isAbsolute(executable) && !executable.includes("/") && !executable.includes("\\")))];
    result.push({
      checkId: check.id,
      label: check.label,
      ...(check.line !== undefined ? { configLine: check.line } : {}),
      tools,
      missing: await missingCheckTools(launch.targets, input.lookup),
    });
  }
  return result;
}

/** A lookup bound to the environment the Runner launches checks with. */
export function createCheckToolLookup(options: CheckToolLookupOptions): CheckToolLookup {
  return async (executable, input) => {
    const runner = input.owner ? options.processEnvironment?.(input.owner) : undefined;
    return await lookUpCheckTool(executable, {
      cwd: input.cwd,
      environment: options.environment(),
      ...(runner?.pathPrepend.length ? { pathPrepend: runner.pathPrepend } : {}),
      ...(options.platform ? { platform: options.platform } : {}),
    });
  };
}

/**
 * VF4b: the lookup for the commands one owner launches, so it searches that owner's PATH. A
 * final check passes its own owner (the run and the check's task id), which every process of
 * the check runs for, its program and its steps alike.
 */
export function checkToolLookupFor(lookup: CheckToolLookup, owner: CheckToolOwner): CheckToolLookup {
  const bound = Object.freeze({ runId: owner.runId, sessionId: owner.sessionId });
  return async (executable, input) => await lookup(executable, { cwd: input.cwd, owner: bound });
}

/**
 * Resolves a bare command the way the process launcher does (PATH, PATHEXT on
 * Windows, which also probes the working directory first; see
 * languageServerCommandCandidates). It never runs anything. A command that
 * names a path is not looked up: a missing file there belongs to the project,
 * so its launch failure stays a failure.
 */
export async function lookUpCheckTool(
  executable: string,
  input: {
    cwd: string;
    environment: Readonly<Record<string, string | undefined>>;
    /** VF4b: folders the launch puts first on PATH (the owner's processEnvironment). */
    pathPrepend?: readonly string[];
    platform?: NodeJS.Platform;
  },
): Promise<CheckToolLookupResult> {
  if (typeof executable !== "string" || !executable.trim() || executable.includes("\0")) {
    return { status: "unknown", reason: "The executable is not a command name." };
  }
  if (isAbsolute(executable) || executable.includes("/") || executable.includes("\\") || executable.includes(sep)) {
    return { status: "unknown", reason: "The executable names a path, not a tool on PATH." };
  }
  const platform = input.platform ?? process.platform;
  // With no PATH to search, absence proves nothing; never turn every check into not run.
  const pathName = Object.keys(input.environment).find((name) => platform === "win32" ? name.toUpperCase() === "PATH" : name === "PATH");
  const ambientPath = pathName ? input.environment[pathName] : undefined;
  const prepend = (input.pathPrepend ?? []).filter((entry) => typeof entry === "string" && entry.length > 0);
  if (!ambientPath?.trim() && prepend.length === 0) {
    return { status: "unknown", reason: "The Runner's environment has no PATH to search." };
  }
  // The launch's PATH: the owner's folders first, then the Runner's own PATH (child-environment.ts).
  const searchPath = [...prepend, ...(ambientPath?.trim() ? [ambientPath] : [])].join(platform === "win32" ? ";" : ":");
  const environment = { ...input.environment, [pathName ?? (platform === "win32" ? "Path" : "PATH")]: searchPath };
  const candidates = languageServerCommandCandidates(executable, {
    commandSearchDirectory: input.cwd,
    environment: environment as NodeJS.ProcessEnv,
    platform,
  });
  let undecided: string | undefined;
  for (const candidate of candidates) {
    const state = await candidateState(candidate, platform);
    if (state === "usable") return { status: "found", path: candidate };
    if (state !== "absent") undecided ??= state;
  }
  // Something with the name exists but could not be judged: launch it and let the result speak.
  if (undecided) return { status: "unknown", reason: undecided };
  // With only the owner's folders to search, absence there proves nothing about the Runner's PATH.
  if (!ambientPath?.trim()) return { status: "unknown", reason: "The Runner's environment has no PATH to search." };
  return { status: "missing" };
}

async function candidateState(path: string, platform: NodeJS.Platform): Promise<"usable" | "absent" | string> {
  let metadata;
  try {
    metadata = await lstat(path);
  } catch (error) {
    return isErrno(error, "ENOENT") || isErrno(error, "ENOTDIR") ? "absent" : `${path} could not be inspected.`;
  }
  if (metadata.isDirectory()) return "absent";
  let target = metadata;
  if (metadata.isSymbolicLink()) {
    try {
      target = await stat(path);
    } catch (error) {
      // A dangling link is skipped by the launcher's search like a missing file.
      if (isErrno(error, "ENOENT") || isErrno(error, "ENOTDIR") || isErrno(error, "ELOOP")) return "absent";
      // A Windows app execution alias cannot be opened but does launch.
      return platform === "win32" ? "usable" : `${path} could not be inspected.`;
    }
  }
  if (!target.isFile()) return "absent";
  if (platform !== "win32" && (target.mode & 0o111) === 0) return `${path} is not executable.`;
  return "usable";
}

function isErrno(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === code;
}
