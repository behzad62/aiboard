export function isOwnedFenceLockContention(error: unknown): boolean;
export function unlinkOwnedFenceLock(
  path: string,
  options?: { readonly deadlineMs?: number; readonly retryDelayMs?: number; readonly primaryError?: unknown },
): void;
