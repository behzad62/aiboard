// Windows limits that apply to the Runner's own state paths, in one place. Node's fs calls already reach past
// 260 characters (they use the \\?\ form internally); these do not:
//
// 1. SQLite, opened with a plain path, stops working once the database path plus its "-journal" suffix passes
//    MAX_PATH. That is true even with Windows long paths enabled (measured at 252 characters on Windows 10 with
//    LongPathsEnabled=1). Given the \\?\ form it works up to its own 1040-byte path limit, which is what
//    sqliteDatabaseLocation does. File locks belong to the file, not the spelling of its path, so a Runner using
//    the \\?\ form and one using the plain form still exclude each other.
// 2. A process cannot start in a working directory past 258 characters, whatever the registry says. Nothing can
//    move that limit, so assertUsableWorkingDirectory reports it before any process is spawned.
// 3. The Windows PowerShell Job host opens its log files with plain Win32 and .NET calls, which pass 260 characters
//    only when the machine has long paths enabled. windowsNativeFilePath hands it the \\?\ form instead.
// 4. Windows PowerShell depends on a short TEMP, and the Runner proves process identity and contains its commands
//    with PowerShell. On Windows 10, by TEMP length: 200 works, from 220 Add-Type cannot compile the Job host (not
//    on every attempt), 260 drops PowerShell to constrained language mode, 270 and up hangs it. %TEMP% normally
//    lives under %LOCALAPPDATA%, so a long one brings this along. assertTempDirectoryUsable refuses it at startup.
import { win32 } from "node:path";

export const WINDOWS_PATH_TOO_LONG = "windows_path_too_long";
/** The longest working directory CreateProcess accepts (measured: 258 starts, 259 fails with ENOENT). */
export const WINDOWS_MAX_WORKING_DIRECTORY = 258;
/** At or past this many characters a path goes through the \\?\ form; shorter paths are left exactly as given. */
export const WINDOWS_PLAIN_PATH_LIMIT = 240;
/** The longest TEMP the Runner accepts: the longest measured to work every time (see 4 above). */
export const WINDOWS_MAX_TEMP_DIRECTORY = 200;
/** SQLite's Windows path buffer is 1040 bytes and must also hold "-journal" (measured: 1024 opens, 1034 fails). */
export const SQLITE_MAX_LOCATION_BYTES = 1032;
/**
 * How far below the state folder the Runner keeps a database: builds\<51-character run>\process-backend\
 * owned-<uuid>\.fence.lock is the deepest, 129 characters.
 */
export const STATE_DATABASE_RESERVE = 140;

const SHORTER_STATE = "Start the Runner with a shorter state folder, for example --state-dir C:\\aiboard-state, or shorten LOCALAPPDATA.";
const SHORTER_FOLDER = `Run it from a shorter folder. If this folder is inside the Runner's state folder: ${SHORTER_STATE}`;

export class WindowsPathTooLongError extends Error {
  /** @param {string} what @param {string} path @param {number} length @param {string} limit @param {boolean} effectNotStarted @param {string} [advice] */
  constructor(what, path, length, limit, effectNotStarted = false, advice = effectNotStarted ? SHORTER_FOLDER : SHORTER_STATE) {
    super(`${WINDOWS_PATH_TOO_LONG}: ${what} is ${length} characters long, past ${limit}: ${path} ${advice}`);
    this.name = "WindowsPathTooLongError";
    this.code = WINDOWS_PATH_TOO_LONG;
    this.path = path;
    this.pathLength = length;
    /** True only where the check ran before the operation it guards, so the caller knows nothing happened. */
    this.effectNotStarted = effectNotStarted;
  }
}

/** The form of a file path that works past MAX_PATH on any Windows machine. Everything else comes back unchanged. */
export function windowsNativeFilePath(path, platform = process.platform) {
  if (platform !== "win32" || path === "" || path === undefined || path === null) return path;
  const full = win32.resolve(path);
  return full.length < WINDOWS_PLAIN_PATH_LIMIT ? path : win32.toNamespacedPath(full);
}

/** What to hand DatabaseSync for a database file. */
export function sqliteDatabaseLocation(path, platform = process.platform) {
  if (path === ":memory:" || path.startsWith("file:")) return path;
  const location = windowsNativeFilePath(path, platform);
  if (location !== path && Buffer.byteLength(location, "utf8") > SQLITE_MAX_LOCATION_BYTES) {
    const full = win32.resolve(path);
    throw new WindowsPathTooLongError("A Runner database path", full, full.length, `the ${SQLITE_MAX_LOCATION_BYTES} bytes SQLite can open`);
  }
  return location;
}

/** Fails before a process is spawned, because the failure it replaces is a bare ENOENT that reads as "command not found". */
export function assertUsableWorkingDirectory(path, platform = process.platform) {
  if (platform !== "win32") return;
  const full = win32.resolve(path);
  if (full.length > WINDOWS_MAX_WORKING_DIRECTORY) {
    throw new WindowsPathTooLongError("A process working directory", full, full.length, `the ${WINDOWS_MAX_WORKING_DIRECTORY} characters Windows allows`, true);
  }
}

/** Refuses at startup a state folder whose databases could never open, before any state is created in it. */
export function assertStateDirectoryUsable(stateDirectory, platform = process.platform) {
  if (platform !== "win32") return;
  const full = win32.resolve(stateDirectory);
  const available = SQLITE_MAX_LOCATION_BYTES - "\\\\?\\".length - STATE_DATABASE_RESERVE;
  if (Buffer.byteLength(full, "utf8") > available) {
    throw new WindowsPathTooLongError("The Runner state folder", full, full.length, `the ${available} bytes that leave room for its databases`);
  }
}

/** Refuses at startup a TEMP folder that would leave every process launch unprovable, with the way out. */
export function assertTempDirectoryUsable(tempDirectory, platform = process.platform) {
  if (platform !== "win32") return;
  const full = win32.resolve(tempDirectory);
  if (full.length > WINDOWS_MAX_TEMP_DIRECTORY) {
    throw new WindowsPathTooLongError("The TEMP folder", full, full.length, `the ${WINDOWS_MAX_TEMP_DIRECTORY} characters Windows PowerShell can work with`, false,
      "Set TEMP and TMP to a shorter folder, for example C:\\Temp, and start the Runner again.");
  }
}

/** Why Build cannot run under this state folder, or undefined when it can. Chat and Remote do not run there. */
export function buildWorkspacePathProblem(deepestWorkingDirectory, platform = process.platform) {
  if (platform !== "win32" || deepestWorkingDirectory.length <= WINDOWS_MAX_WORKING_DIRECTORY) return undefined;
  return `${WINDOWS_PATH_TOO_LONG}: Build and ToolBench are off, because their workspaces would be ${deepestWorkingDirectory.length} characters long and Windows cannot start a process in a folder past ${WINDOWS_MAX_WORKING_DIRECTORY}: ${deepestWorkingDirectory} ${SHORTER_STATE} Chat and Remote still work.`;
}

/** This error anywhere in an Error / AggregateError chain, so it survives the layers that wrap launch failures. */
export function findWindowsPathTooLongError(error, seen = new Set()) {
  if (error === null || typeof error !== "object" || seen.has(error)) return undefined;
  seen.add(error);
  if (error.code === WINDOWS_PATH_TOO_LONG && typeof error.message === "string") return error;
  for (const nested of Array.isArray(error.errors) ? error.errors : []) {
    const found = findWindowsPathTooLongError(nested, seen);
    if (found) return found;
  }
  return findWindowsPathTooLongError(error.cause, seen);
}
