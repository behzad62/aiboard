import type { Context, Script } from "node:vm";

/**
 * A user regex is bounded by the CPU time it uses, not by wall-clock time. Wall time measures the host: on 16 CPUs
 * busy with 64 other processes an ordinary pattern on a 4 KiB tail took up to 1.8 s wall-clock while using at most one
 * 15.6 ms CPU-clock tick, and on macOS CI a plain pattern tripped the old 50 ms wall bound and failed a session start.
 * The CPU time this thread spends is what a runaway pattern costs and what an ordinary one does not: the ordinary
 * patterns measured used 0-0.4 ms of CPU on a 4 KiB tail and 0-2.5 ms on a 1 MiB chunk (Windows and a 2-CPU Linux
 * container, idle and loaded), where the pathological ones in the tests use 120 ms of CPU on 512 characters and
 * seconds on 4 KiB.
 *
 * V8 can interrupt a running RegExp only at a vm timeout, which is wall-clock. So an evaluation runs with a vm timeout
 * equal to its CPU budget; when that interrupt fires before this attempt used the budget in CPU time, the host kept
 * the thread waiting, not the pattern, and the evaluation runs again with twice the timeout (at most 4x the budget per
 * attempt). It fails when its attempts together used the whole CPU budget ("cpu"), or, on a host so starved that the
 * evaluation never finishes, when the timeouts reach the wall ceiling in all ("wall"); either way it fails closed.
 * A caller with less time left passes its own, lower wall ceiling.
 *
 * PATTERN_WALL_CEILING_MS: the slowest ordinary evaluation measured took 1.83 s wall-clock (4 KiB tail, Windows,
 * 64 busy processes on 16 CPUs; 0.76 s at 32), so 8 s is over 4x that. Only a host that starves this thread for that
 * long reaches it.
 */
export const PATTERN_WALL_CEILING_MS = 8_000;
const TIMEOUT_CODE = "ERR_SCRIPT_EXECUTION_TIMEOUT";

export type PatternEvaluation<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly reason: "cpu" | "wall" };

export function runPatternWithCpuBudget<T>(script: Script, context: Context, cpuBudgetMs: number, wallCeilingMs = PATTERN_WALL_CEILING_MS): PatternEvaluation<T> {
  const first = Math.max(1, Math.ceil(cpuBudgetMs));
  // One attempt never gets more than 4x the budget, so a late attempt on a host that has just freed up cannot burn
  // seconds of CPU; and the CPU of every attempt counts, so many starved attempts cannot add up past the budget.
  // At most about 5x the budget of CPU is ever spent on one evaluation.
  const longestAttemptMs = first * 4;
  const ceilingMs = Math.max(1, Math.min(PATTERN_WALL_CEILING_MS, Math.floor(wallCeilingMs)));
  // The timeouts granted so far: each attempt is interrupted at its own, so together they bound the wall time.
  let grantedMs = 0;
  let cpuMs = 0;
  for (let timeoutMs = first; ; timeoutMs = Math.min(longestAttemptMs, timeoutMs * 2)) {
    const allowedMs = Math.max(1, Math.min(timeoutMs, ceilingMs - grantedMs));
    grantedMs += allowedMs;
    const cpuBefore = process.threadCpuUsage();
    try {
      return { ok: true, value: script.runInContext(context, { timeout: allowedMs }) as T };
    } catch (error) {
      if ((error as { code?: string }).code !== TIMEOUT_CODE) throw error;
      const used = process.threadCpuUsage(cpuBefore);
      cpuMs += (used.user + used.system) / 1_000;
      if (cpuMs >= cpuBudgetMs) return { ok: false, reason: "cpu" };
      if (grantedMs >= ceilingMs) return { ok: false, reason: "wall" };
    }
  }
}
