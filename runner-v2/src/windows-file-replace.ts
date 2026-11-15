import { renameSync } from "node:fs";
import { performance } from "node:perf_hooks";

/**
 * Replacing a file by renaming a temporary file over it fails on Windows with EPERM (at times EACCES or EBUSY) while
 * another process has the destination open, even a reader that allows deletion: the old file keeps its name until
 * its last handle closes. The Windows Job host's supervisor reads its process record to check the writer fence on
 * each fenced request, outside the Runner's lock, so a request it handles late can overlap the Runner's next write of
 * that record. On POSIX a rename over an open file always succeeds, so there it is never retried.
 *
 * Measured on Windows 10 with 16 CPUs and Node 24 (2026-11-16), each replace of a 4 KiB record retried every ms:
 * - nobody else opens the file: 0 of 644 replaces failed idle, and 0 of 172 with every core busy;
 * - another process read the file and closed it before the replace: 0 of 300 failed;
 * - another process read the file every 2 ms: the longest replace waited 2.4 s idle and 0.4 s with every core busy;
 * - another process read the file nonstop: the longest replace waited 0.9 s idle and 7.2 s with every core busy.
 * So a replace polls fast, from 1 ms backing off to 25 ms, on timers that leave the event loop free, up to a 10 s
 * ceiling, about 1.4x the longest wait measured. A destination held past the ceiling fails closed, as every hold did
 * before.
 *
 * The wait runs inside the Job host's fence effect, and most effects write the record twice (the status, then their
 * own change), so a rare effect can hold the owned fence lock for about 20 s plus its requests. A claim from another
 * process waiting behind it gives up at its 15 s default deadline and fails closed; effects in the same process queue
 * behind it without a deadline. The signal effect already holds the lock for up to its 60 s stop deadline.
 */
export const WINDOWS_REPLACE_CEILING_MS = 10_000;
const WINDOWS_REPLACE_FIRST_DELAY_MS = 1;
const WINDOWS_REPLACE_MAX_DELAY_MS = 25;
const WINDOWS_REPLACE_RETRY_CODES: ReadonlySet<string> = new Set(["EPERM", "EACCES", "EBUSY"]);

export interface ReplaceFileOptions {
  readonly platform?: NodeJS.Platform;
  readonly ceilingMs?: number;
  readonly rename?: (from: string, to: string) => void;
  readonly now?: () => number;
  readonly sleep?: (milliseconds: number) => Promise<void>;
}

/**
 * Renames `temporary` over `destination`. On Windows, while another process holds the destination open, it retries
 * until the rename lands or the ceiling passes, then throws the last error. Any other error throws at once.
 */
export async function replaceFileWhenFree(
  temporary: string,
  destination: string,
  options: ReplaceFileOptions = {},
): Promise<void> {
  const rename = options.rename ?? renameSync;
  const platform = options.platform ?? process.platform;
  // A monotonic clock: a wall clock stepped back would stretch a wait held inside the fence lock.
  const now = options.now ?? (() => performance.now());
  const sleep = options.sleep ?? ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const deadline = now() + (options.ceilingMs ?? WINDOWS_REPLACE_CEILING_MS);
  let delay = WINDOWS_REPLACE_FIRST_DELAY_MS;
  for (;;) {
    try {
      rename(temporary, destination);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | undefined)?.code;
      if (platform !== "win32" || typeof code !== "string" || !WINDOWS_REPLACE_RETRY_CODES.has(code)) throw error;
      const remaining = deadline - now();
      if (remaining <= 0) throw error;
      await sleep(Math.min(delay, remaining));
      delay = Math.min(WINDOWS_REPLACE_MAX_DELAY_MS, delay * 2);
    }
  }
}
