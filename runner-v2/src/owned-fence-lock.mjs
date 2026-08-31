import { unlinkSync } from "node:fs";

const waiter = new Int32Array(new SharedArrayBuffer(4));
const TRANSIENT_CODES = new Set(["EPERM", "EACCES", "EBUSY"]);

export function isOwnedFenceLockContention(error) {
  return error?.code === "EEXIST" || TRANSIENT_CODES.has(error?.code);
}

export function unlinkOwnedFenceLock(path, options = {}) {
  const deadline = Date.now() + (options.deadlineMs ?? 2_000);
  const retryDelayMs = options.retryDelayMs ?? 5;
  for (;;) {
    try { unlinkSync(path); return; }
    catch (error) {
      if (error?.code === "ENOENT") return;
      if (!TRANSIENT_CODES.has(error?.code) || Date.now() >= deadline) {
        const cleanupError = new Error("Owned writer fence lock cleanup is unavailable.", { cause: error });
        if (options.primaryError !== undefined) {
          throw new AggregateError(
            [options.primaryError, cleanupError],
            "Owned writer fence effect and lock cleanup both failed.",
            { cause: options.primaryError },
          );
        }
        throw cleanupError;
      }
      Atomics.wait(waiter, 0, 0, retryDelayMs);
    }
  }
}
