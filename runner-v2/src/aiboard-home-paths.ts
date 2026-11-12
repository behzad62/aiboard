import { homedir } from "node:os";
import { posix, win32 } from "node:path";

import { userDataRoot, type StateLocationOptions } from "./launcher-instance.js";
import { FixedPathDeny, type FixedDenyEntry } from "./remote-path-guard.js";

/**
 * Where the AIBoard home lives (Simple Build plan §5.8): `AIBOARD_HOME` when set, else `~/.aiboard`.
 * Its key sits in the user data root, outside the home, so a copied or synced home never carries
 * usable keys. This module only computes paths; aiboard-home-store.ts reads and writes them.
 */

export type AiboardHomeErrorCode =
  | "home_unsafe"
  | "home_unreadable"
  | "home_key_mismatch"
  | "home_busy"
  | "home_conflict"
  | "home_newer"
  | "home_invalid_op";

export class AiboardHomeError extends Error {
  constructor(readonly code: AiboardHomeErrorCode, message: string, readonly details?: unknown) {
    super(`${code}: ${message}`);
    this.name = "AiboardHomeError";
  }
}

export interface AiboardHomeLocation {
  readonly platform: NodeJS.Platform;
  /** The home folder, absolute. */
  readonly home: string;
  readonly source: "AIBOARD_HOME" | "default";
  readonly configPath: string;
  readonly credentialsPath: string;
  readonly lockPath: string;
  /** The user data root (per-folder state, the remote device key); the home key lives here. */
  readonly keyDirectory: string;
  readonly keyPath: string;
}

export const HOME_CONFIG_FILE = "config.json";
export const HOME_CREDENTIALS_FILE = "credentials.json";
export const HOME_LOCK_FILE = "home-lock.sqlite";
export const HOME_KEY_FILE = "home-key";

export function resolveAiboardHome(options: StateLocationOptions): AiboardHomeLocation {
  const paths = options.platform === "win32" ? win32 : posix;
  const configured = options.environment.AIBOARD_HOME;
  let home: string;
  let source: AiboardHomeLocation["source"];
  if (configured !== undefined && configured !== "") {
    assertUsableHomeSpelling(configured, options.platform);
    home = paths.resolve(configured);
    source = "AIBOARD_HOME";
  } else {
    if (!options.home || !paths.isAbsolute(options.home)) {
      throw new AiboardHomeError("home_unsafe", "The user's home folder is not an absolute path, so ~/.aiboard cannot be found; set AIBOARD_HOME to an absolute path.");
    }
    home = paths.join(options.home, ".aiboard");
    source = "default";
  }
  let keyDirectory: string;
  try { keyDirectory = userDataRoot(options); }
  catch (error) {
    throw new AiboardHomeError("home_unsafe", `The AIBoard data root for the home key cannot be found (${error instanceof Error ? error.message : String(error)}).`);
  }
  return Object.freeze({
    platform: options.platform,
    home,
    source,
    configPath: paths.join(home, HOME_CONFIG_FILE),
    credentialsPath: paths.join(home, HOME_CREDENTIALS_FILE),
    lockPath: paths.join(home, HOME_LOCK_FILE),
    keyDirectory,
    keyPath: paths.join(keyDirectory, HOME_KEY_FILE),
  });
}

/** The current process's home location. */
export function currentAiboardHome(): AiboardHomeLocation {
  return resolveAiboardHome({ platform: process.platform, environment: process.env, home: homedir() });
}

function assertUsableHomeSpelling(value: string, platform: NodeJS.Platform): void {
  const paths = platform === "win32" ? win32 : posix;
  if (value.includes("\0")) throw new AiboardHomeError("home_unsafe", "AIBOARD_HOME contains a NUL character.");
  if (!paths.isAbsolute(value)) throw new AiboardHomeError("home_unsafe", "AIBOARD_HOME must be an absolute path.");
  if (platform === "win32") {
    // A drive-rooted path only: `\foo` is relative to the current drive, and UNC or device paths name another computer or namespace.
    if (!/^[a-zA-Z]:[\\/]/.test(value)) throw new AiboardHomeError("home_unsafe", "AIBOARD_HOME must be an absolute path on a local drive, such as C:\\Users\\you\\.aiboard.");
  }
}

/**
 * Every home file the tool brokers deny (§5.8 "Runner tools"): the credentials, the write lock
 * (with its identity record and journal) and the home key, to every actor; and writes to config.json.
 * Both the default `~/.aiboard` and an absolute `AIBOARD_HOME` are covered, so a surface that was
 * started with another environment still cannot reach the files the user's own CLI writes.
 */
export function aiboardHomeDenyEntries(options: StateLocationOptions): FixedDenyEntry[] {
  const paths = options.platform === "win32" ? win32 : posix;
  const homes = new Set<string>();
  if (options.home && paths.isAbsolute(options.home)) homes.add(paths.join(options.home, ".aiboard"));
  const configured = options.environment.AIBOARD_HOME;
  if (configured && paths.isAbsolute(configured) && !configured.includes("\0")) homes.add(paths.resolve(configured));
  const entries: FixedDenyEntry[] = [];
  for (const home of homes) {
    entries.push({ path: paths.join(home, HOME_CREDENTIALS_FILE), modes: "all", category: "aiboard_home_credentials", match: "prefix" });
    entries.push({ path: paths.join(home, HOME_LOCK_FILE), modes: "all", category: "aiboard_home_lock", match: "prefix" });
    entries.push({ path: paths.join(home, HOME_CONFIG_FILE), modes: "mutate", category: "aiboard_home_config", match: "prefix" });
  }
  try {
    entries.push({ path: paths.join(userDataRoot(options), HOME_KEY_FILE), modes: "all", category: "aiboard_home_key", match: "prefix" });
  } catch {
    // No data root can be resolved with this environment, so no home key can exist under it either.
  }
  return entries;
}

export function createAiboardHomeDeny(options: StateLocationOptions = { platform: process.platform, environment: process.env, home: homedir() }): FixedPathDeny {
  return new FixedPathDeny(aiboardHomeDenyEntries(options), options.platform);
}

/** The home's own files, for `aiboard uninstall --remove-state` (self-update.ts userStatePaths). */
export function aiboardHomeStatePaths(options: StateLocationOptions): string[] {
  const paths = options.platform === "win32" ? win32 : posix;
  let home: string;
  try { home = resolveAiboardHome(options).home; }
  catch {
    if (!options.home || !paths.isAbsolute(options.home)) return [];
    home = paths.join(options.home, ".aiboard");
  }
  const files = [
    HOME_CONFIG_FILE,
    HOME_CREDENTIALS_FILE,
    HOME_LOCK_FILE,
    `${HOME_LOCK_FILE}.identity`,
    `${HOME_LOCK_FILE}-journal`,
  ].map((name) => paths.join(home, name));
  try { files.push(paths.join(userDataRoot(options), HOME_KEY_FILE)); } catch { /* no data root, no key */ }
  return files;
}
