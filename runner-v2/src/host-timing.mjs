// Polling for work whose duration depends on the machine (lock claims, SQLite opens, process-identity probes).
// Such work checks often, returns the moment it succeeds, and gives up only at a ceiling set from measured cases,
// which each caller documents at its own constant. A failure at the ceiling still fails closed.

/**
 * The longest single wait between two checks while polling host work. A waiter is late by at most this after the
 * thing it waits for ends. 50 ms is about 3x the fastest uncontended fence claim measured on Windows (15-23 ms idle)
 * and below the fastest in a 2-CPU Linux container (45-150 ms), so a long wait costs a check every 50 ms, not every
 * few ms.
 */
export const HOST_POLL_MAX_DELAY_MS = 50;

/** Gentle backoff: the next wait after `delayMs`, growing by half each time up to `maxMs` (never below `delayMs`). */
export function nextHostPollDelay(delayMs, maxMs = HOST_POLL_MAX_DELAY_MS) {
  if (!Number.isFinite(delayMs) || delayMs < 1) return 1;
  return Math.max(delayMs, Math.min(maxMs, Math.ceil(delayMs * 1.5)));
}
