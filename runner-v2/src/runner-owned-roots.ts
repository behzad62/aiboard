import { realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { canonicalFuturePath, remoteDeviceDirectory, type StateLocationOptions } from "./launcher-instance.js";

export interface RunnerOwnedRootsInput {
  readonly projectPath: string;
  readonly stateDirectory: string;
  readonly deviceDirectory: string;
  readonly extensionsHome: string;
  readonly capabilitiesConfigPath?: string;
  readonly location: StateLocationOptions;
}

export interface RunnerOwnedRoots {
  readonly projectPath: string;
  readonly directories: readonly string[];
  readonly files: readonly string[];
  readonly nested: boolean;
}

/** Resolve trusted startup paths through existing ancestors, including aliases. */
export async function resolveRunnerOwnedRoots(input: RunnerOwnedRootsInput): Promise<RunnerOwnedRoots> {
  const state = input.stateDirectory;
  const directories = [
    state,
    dirname(remoteDeviceDirectory(input.location)),
    input.deviceDirectory,
    input.extensionsHome,
    join(state, "builds"),
    join(state, "verification-workspaces"),
    join(state, "verifier-workspaces"),
    join(state, "extensions"),
  ];
  const files = input.capabilitiesConfigPath ? [input.capabilitiesConfigPath] : [];
  if (![input.projectPath, ...directories, ...files].every(isAbsolute)) {
    throw new Error("invalid_runner_owned_root: Runner-owned paths must be absolute.");
  }
  const projectPath = await realpath(input.projectPath);
  const canonicalDirectories = await Promise.all(directories.map(canonicalFuturePath));
  const canonicalFiles = await Promise.all(files.map(canonicalFuturePath));
  return Object.freeze({
    projectPath,
    directories: Object.freeze(canonicalDirectories),
    files: Object.freeze(canonicalFiles),
    nested: [...canonicalDirectories, ...canonicalFiles].some((path) =>
      runnerOwnedPathContains(projectPath, path, input.location.platform)),
  });
}

export function runnerOwnedPathContains(parent: string, candidate: string, platform: NodeJS.Platform = process.platform): boolean {
  const normalize = (path: string) => {
    const value = resolve(path);
    return platform === "win32" || platform === "darwin" ? value.toLowerCase() : value;
  };
  const traversal = relative(normalize(parent), normalize(candidate));
  return traversal === "" || (traversal !== ".." && !traversal.startsWith(`..${sep}`) && !isAbsolute(traversal));
}
