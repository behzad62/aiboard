export const WINDOWS_PATH_TOO_LONG: "windows_path_too_long";
export const WINDOWS_MAX_WORKING_DIRECTORY: number;
export const WINDOWS_PLAIN_PATH_LIMIT: number;
export const WINDOWS_MAX_TEMP_DIRECTORY: number;
export const SQLITE_MAX_LOCATION_BYTES: number;
export const STATE_DATABASE_RESERVE: number;
export class WindowsPathTooLongError extends Error {
  readonly code: "windows_path_too_long";
  readonly path: string;
  readonly pathLength: number;
  readonly effectNotStarted: boolean;
  constructor(what: string, path: string, length: number, limit: string, effectNotStarted?: boolean, advice?: string);
}
export function windowsNativeFilePath(path: string, platform?: NodeJS.Platform): string;
export function sqliteDatabaseLocation(path: string, platform?: NodeJS.Platform): string;
export function assertUsableWorkingDirectory(path: string, platform?: NodeJS.Platform): void;
export function assertStateDirectoryUsable(stateDirectory: string, platform?: NodeJS.Platform): void;
export function assertTempDirectoryUsable(tempDirectory: string, platform?: NodeJS.Platform): void;
export function buildWorkspacePathProblem(deepestWorkingDirectory: string, platform?: NodeJS.Platform): string | undefined;
export function findWindowsPathTooLongError(error: unknown): WindowsPathTooLongError | undefined;
