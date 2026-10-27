import { createHash, randomBytes } from "node:crypto";
import { closeSync, constants, fstatSync, linkSync, lstatSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { lstat, mkdir, open, readdir, realpath, rename, stat, unlink, writeFile } from "node:fs/promises";
import { homedir, userInfo } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, win32, posix } from "node:path";
import { DatabaseSync } from "node:sqlite";

export interface LauncherIdentity {
  projectPath: string;
  projectKey: string;
  owner: string;
}

export interface LauncherInstance extends LauncherIdentity {
  schemaVersion: 1;
  pid: number;
  startedAt: number;
  port: number;
  controlPort: number;
  instanceId: string;
  version: string;
}

export interface StateLocationOptions {
  platform: NodeJS.Platform;
  environment: NodeJS.ProcessEnv;
  home: string;
}

export function projectDataDirectory(projectKey: string, options: StateLocationOptions): string {
  const paths = options.platform === "win32" ? win32 : posix;
  let base: string;
  if (options.platform === "win32") {
    const local = options.environment.LOCALAPPDATA;
    if (!local || !paths.isAbsolute(local)) {
      throw new Error("launcher_state_unverified: LOCALAPPDATA must be an absolute path inside the user profile; choose --state-dir.");
    }
    base = paths.join(local, "AIBoard");
  } else if (options.platform === "darwin") {
    base = paths.join(options.home, "Library", "Application Support", "AIBoard");
  } else {
    const xdg = options.environment.XDG_DATA_HOME;
    base = paths.join(xdg && paths.isAbsolute(xdg) ? xdg : paths.join(options.home, ".local", "share"), "aiboard");
  }
  const digest = createHash("sha256").update(projectKey).digest("hex");
  return paths.join(base, "projects", digest);
}

export function currentOwner(): string {
  const user = userInfo();
  return process.platform === "win32" ? `windows:${user.username.toLowerCase()}:${homedir().toLowerCase()}` : `uid:${user.uid}`;
}

export async function projectIdentity(project: string): Promise<LauncherIdentity> {
  const projectPath = await realpath(resolve(project));
  if (!(await stat(projectPath)).isDirectory()) throw new Error("invalid_project_directory: The project must be a directory.");
  return {
    projectPath,
    projectKey: process.platform === "win32" ? projectPath.toLowerCase() : projectPath,
    owner: currentOwner(),
  };
}

/** Resolve existing links before creating any state, then resolve the new directory again. */
export async function canonicalFuturePath(input: string): Promise<string> {
  let candidate = resolve(input);
  const missing: string[] = [];
  for (;;) {
    try {
      const existing = await realpath(candidate);
      return resolve(existing, ...missing.reverse());
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      try {
        await lstat(candidate);
        throw new Error("invalid_state_directory: A state path link has a missing target.");
      } catch (linkError) {
        if ((linkError as NodeJS.ErrnoException).code !== "ENOENT") throw linkError;
      }
      const parent = dirname(candidate);
      if (parent === candidate) throw new Error("invalid_state_directory: No existing state directory ancestor.");
      missing.push(candidate.slice(parent.length).replace(/^[\\/]+/, ""));
      candidate = parent;
    }
  }
}

export function assertExternalState(projectPath: string, stateDirectory: string): void {
  const traversal = relative(projectPath, stateDirectory);
  if (traversal === "" || (traversal !== ".." && !traversal.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) && !isAbsolute(traversal))) {
    throw new Error("invalid_state_directory: Runner state must be outside the project. Choose an external directory with --state-dir <absolute-path>.");
  }
}

export interface WindowsDefaultStateLocation {
  home: string;
  localAppData: string;
}

export async function assertWindowsStatePath(requested: string, location?: WindowsDefaultStateLocation): Promise<void> {
  if (process.platform !== "win32") return;
  let profile: string | undefined;
  if (location) {
    if (!win32.isAbsolute(location.home) || !win32.isAbsolute(location.localAppData)) {
      throw new Error("launcher_state_unverified: LOCALAPPDATA must be an absolute path inside the user profile; choose --state-dir.");
    }
    profile = await realpath(location.home);
    const local = await canonicalFuturePath(location.localAppData);
    if (!isWindowsPathInside(profile, local, false)) {
      throw new Error("launcher_state_unverified: LOCALAPPDATA must be inside the user profile; choose --state-dir.");
    }
  }

  const full = win32.resolve(requested);
  let component = win32.parse(full).root;
  const components = win32.relative(component, full).split(/[\\/]+/).filter(Boolean);
  let insideProfile = !profile;
  for (const part of ["", ...components]) {
    if (part) component = win32.join(component, part);
    let info;
    try { info = await lstat(component); }
    catch (error) { if (isMissing(error)) break; throw error; }
    if (profile && !insideProfile) insideProfile = isWindowsPathInside(profile, await realpath(component), true);
    if (insideProfile && info.isSymbolicLink()) {
      throw new Error("invalid_state_directory: Windows state paths must not contain symlinks or junctions.");
    }
    if (!info.isDirectory() && !info.isSymbolicLink()) {
      throw new Error("invalid_state_directory: State path components must be directories.");
    }
  }
}

function isWindowsPathInside(parent: string, candidate: string, allowEqual: boolean): boolean {
  const traversal = win32.relative(parent.toLowerCase(), candidate.toLowerCase());
  return (allowEqual || traversal !== "") && traversal !== ".." && !traversal.startsWith("..\\") && !win32.isAbsolute(traversal);
}

export async function prepareStateDirectory(
  projectPath: string,
  requested: string,
  identity: LauncherIdentity,
  windowsDefault?: WindowsDefaultStateLocation,
): Promise<string> {
  await assertWindowsStatePath(requested, windowsDefault);
  const prospective = await canonicalFuturePath(requested);
  assertExternalState(projectPath, prospective);
  if (process.platform === "win32" && windowsDefault) {
    // Trust the per-user profile's default ACL; OS keychain and ACL verification are deferred.
    await mkdir(dirname(prospective), { recursive: true, mode: 0o700 });
    await assertWindowsStatePath(requested, windowsDefault);
    const parent = await realpath(dirname(prospective));
    if (parent.toLowerCase() !== dirname(prospective).toLowerCase()) {
      throw new Error("invalid_state_directory: The state directory changed while it was being prepared.");
    }
    const release = await acquireDiscoveryLock(parent);
    try {
      await assertWindowsStatePath(requested, windowsDefault);
      let created = false;
      try { await mkdir(prospective, { mode: 0o700 }); created = true; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
      await assertWindowsStatePath(requested, windowsDefault);
      const actual = await realpath(requested);
      if (actual.toLowerCase() !== prospective.toLowerCase()) {
        throw new Error("invalid_state_directory: The state directory changed while it was being prepared.");
      }
      assertExternalState(projectPath, actual);
      if (!(await stat(actual)).isDirectory()) throw new Error("invalid_state_directory: State must be a directory.");
      await assertProjectBinding(actual, identity, created);
      return actual;
    } finally { release(); }
  }
  await mkdir(prospective, { recursive: true, mode: 0o700 });
  await assertWindowsStatePath(requested);
  const actual = await realpath(process.platform === "win32" ? requested : prospective);
  if (process.platform === "win32" && actual.toLowerCase() !== prospective.toLowerCase()) {
    throw new Error("invalid_state_directory: The state directory changed while it was being prepared.");
  }
  assertExternalState(projectPath, actual);
  const info = await stat(actual);
  if (!info.isDirectory()) throw new Error("invalid_state_directory: State must be a directory.");
  if (process.platform !== "win32" && (info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0)) {
    throw new Error("invalid_state_directory: State must be owned by the current user and private (mode 0700).");
  }
  return actual;
}

export async function assertProjectBinding(stateDirectory: string, identity: LauncherIdentity, allowNewBinding = true): Promise<void> {
  const file = join(stateDirectory, "launcher-project.json");
  const value = JSON.stringify({ schemaVersion: 1, projectKey: identity.projectKey, owner: identity.owner });
  try { await readPrivateFile(file, "utf8"); }
  catch (error) {
    if (!isMissing(error)) throw error;
    if (!allowNewBinding) {
      throw new Error("instance_unverified: Existing state has no launcher ownership record. Choose an empty --state-dir; no existing state was changed.");
    }
    const entries = await readdir(stateDirectory);
    const lockFiles = new Set(["launcher-discovery.sqlite", "launcher-discovery.sqlite.identity", "launcher-discovery.sqlite-journal"]);
    if (entries.some((entry) => !lockFiles.has(entry))) {
      throw new Error("instance_unverified: Existing state has no launcher ownership record. Choose an empty --state-dir; no existing state was changed.");
    }
  }
  try {
    await writeFile(file, value, { flag: "wx", mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const existing = JSON.parse(await readPrivateFile(file, "utf8")) as unknown;
    if (!isObject(existing) || existing.schemaVersion !== 1 || existing.projectKey !== identity.projectKey || existing.owner !== identity.owner) {
      throw new Error("instance_identity_mismatch: This state directory belongs to another user or project.");
    }
  }
}

export function tryAcquireLock(stateDirectory: string, kind: "discovery" | "lifetime"): (() => void) | null {
  const file = join(stateDirectory, `launcher-${kind}.sqlite`);
  assertLockFileIdentity(file);
  const database = new DatabaseSync(file, { timeout: 0 });
  try {
    database.exec("BEGIN IMMEDIATE");
    assertLockFileIdentity(file);
    let held = true;
    return () => {
      if (!held) return;
      held = false;
      try { database.exec("ROLLBACK"); } finally { database.close(); }
    };
  } catch (error) {
    database.close();
    if (/database is locked|database is busy|SQLITE_BUSY/i.test(String(error))) return null;
    throw error;
  }
}

export async function acquireDiscoveryLock(stateDirectory: string): Promise<() => void> {
  const deadline = Date.now() + 10_000;
  do {
    let release: (() => void) | null = null;
    try { release = tryAcquireLock(stateDirectory, "discovery"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "LAUNCHER_LOCK_NOT_READY") throw error; }
    if (release) return release;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
  } while (Date.now() < deadline);
  throw new Error("launcher_busy: Another launcher is starting or inspecting this project; retry shortly.");
}

/** Keep lock files in place: replacing one must never make a held lock appear free. */
function assertLockFileIdentity(file: string): void {
  const identityFile = `${file}.identity`;
  let descriptor: number | undefined;
  let created = false;
  try {
    try {
      descriptor = openSync(file, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR, 0o600);
      created = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      descriptor = openSync(file, constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW));
    }
    const info = fstatSync(descriptor);
    const pathInfo = lstatSync(file);
    if (!info.isFile() || !pathInfo.isFile() || info.nlink !== 1 || info.ino === 0 ||
        info.dev !== pathInfo.dev || info.ino !== pathInfo.ino ||
        (process.platform !== "win32" && (info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0))) {
      throw new Error("launcher_lock_unverified: The launcher lock is not a private, stable file.");
    }
    const expected = `${info.dev}:${info.ino}`;
    if (created) {
      const temporary = `${identityFile}.${randomBytes(8).toString("hex")}.tmp`;
      writeFileSync(temporary, expected, { flag: "wx", mode: 0o600 });
      try { linkSync(temporary, identityFile); }
      finally { unlinkSync(temporary); }
    }
    let identityDescriptor: number | undefined;
    try {
      identityDescriptor = openSync(identityFile, constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW));
      const identityInfo = fstatSync(identityDescriptor);
      const identityPathInfo = lstatSync(identityFile);
      if (!identityInfo.isFile() || !identityPathInfo.isFile() || identityInfo.nlink !== 1 ||
          identityInfo.dev !== identityPathInfo.dev || identityInfo.ino !== identityPathInfo.ino ||
          (process.platform !== "win32" && (identityInfo.uid !== process.getuid?.() || (identityInfo.mode & 0o077) !== 0)) ||
          readFileSync(identityDescriptor, "utf8") !== expected) {
        throw new Error("launcher_lock_unverified: The launcher lock identity changed.");
      }
    } catch (error) {
      if (!created && (error as NodeJS.ErrnoException).code === "ENOENT") {
        throw Object.assign(new Error("launcher_lock_unverified: The launcher lock identity is not yet available."), { code: "LAUNCHER_LOCK_NOT_READY" });
      }
      throw error;
    } finally { if (identityDescriptor !== undefined) closeSync(identityDescriptor); }
  } finally { if (descriptor !== undefined) closeSync(descriptor); }
}

export async function readInstance(stateDirectory: string): Promise<LauncherInstance | undefined> {
  let raw: string;
  try { raw = await readPrivateFile(join(stateDirectory, "launcher-instance.json"), "utf8"); }
  catch (error) { if (isMissing(error)) return undefined; throw error; }
  const value: unknown = JSON.parse(raw);
  if (!isObject(value) || value.schemaVersion !== 1 || typeof value.projectPath !== "string" || typeof value.projectKey !== "string" ||
      typeof value.owner !== "string" || !Number.isSafeInteger(value.pid) || Number(value.pid) < 1 ||
      !Number.isSafeInteger(value.startedAt) || Number(value.startedAt) < 1 ||
      !validPort(value.port) || !validPort(value.controlPort) ||
      typeof value.instanceId !== "string" || !/^[0-9a-f]{32}$/.test(value.instanceId) ||
      typeof value.version !== "string" || !value.version) {
    throw new Error("instance_invalid: The launcher instance record is invalid; no process was stopped.");
  }
  return value as unknown as LauncherInstance;
}

export function assertInstanceIdentity(instance: LauncherInstance, identity: LauncherIdentity): void {
  if (instance.projectKey !== identity.projectKey || instance.owner !== identity.owner ||
      (process.platform === "win32" ? instance.projectPath.toLowerCase() : instance.projectPath) !== identity.projectKey) {
    throw new Error("instance_identity_mismatch: The record belongs to another user or project; no process was stopped.");
  }
}

export async function writeInstance(stateDirectory: string, instance: LauncherInstance): Promise<void> {
  const target = join(stateDirectory, "launcher-instance.json");
  const temporary = `${target}.${randomBytes(8).toString("hex")}.tmp`;
  await writeFile(temporary, JSON.stringify(instance), { flag: "wx", mode: 0o600 });
  try { await rename(temporary, target); }
  catch (error) { await unlink(temporary).catch(() => undefined); throw error; }
}

export async function createControlKey(stateDirectory: string): Promise<Buffer> {
  const key = randomBytes(32);
  try { await writeFile(join(stateDirectory, "launcher-control.key"), key, { flag: "wx", mode: 0o600 }); }
  catch (error) { key.fill(0); throw error; }
  return key;
}

export async function readControlKey(stateDirectory: string): Promise<Buffer> {
  const key = await readPrivateFile(join(stateDirectory, "launcher-control.key"));
  if (key.length !== 32) { key.fill(0); throw new Error("instance_invalid: The launcher control key is invalid."); }
  return key;
}

/** Only called under the discovery lock after the lifetime lock is acquired. */
export async function clearStaleInstance(stateDirectory: string, identity: LauncherIdentity): Promise<void> {
  const instance = await readInstance(stateDirectory);
  if (instance) assertInstanceIdentity(instance, identity);
  for (const name of ["launcher-instance.json", "launcher-control.key"]) {
    const file = join(stateDirectory, name);
    try { const contents = await readPrivateFile(file); contents.fill(0); await unlink(file); }
    catch (error) { if (!isMissing(error)) throw error; }
  }
}

async function readPrivateFile(file: string, encoding: "utf8"): Promise<string>;
async function readPrivateFile(file: string): Promise<Buffer>;
async function readPrivateFile(file: string, encoding?: "utf8"): Promise<string | Buffer> {
  const flags = constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW);
  const handle = await open(file, flags);
  try {
    const info = await handle.stat();
    const link = await lstat(file);
    if (!info.isFile() || !link.isFile() || info.nlink !== 1 || info.size > 65_536 || info.dev !== link.dev || info.ino !== link.ino ||
        (process.platform !== "win32" && (info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0))) {
      throw new Error("instance_unprotected: Launcher state must be a private, user-owned regular file.");
    }
    return encoding ? await handle.readFile({ encoding }) : await handle.readFile();
  } finally { await handle.close(); }
}

function validPort(value: unknown): boolean { return Number.isInteger(value) && Number(value) > 0 && Number(value) <= 65_535; }
function isObject(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function isMissing(error: unknown): boolean { return (error as NodeJS.ErrnoException).code === "ENOENT"; }
