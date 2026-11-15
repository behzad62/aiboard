import type { ManagedProcessOwner } from "./managed-process-transport.js";

/**
 * An agent's stop that could not be proven: one of its cleanups (managed
 * processes, MCP servers, language servers, managed Build tools) failed, so
 * a process it started may still be running and writing in its worktree.
 *
 * The subclass keeps every existing message and `instanceof AggregateError`;
 * it only lets the scheduler tell an unproven stop from an ordinary failure.
 */
export class AgentCleanupUnverifiedError extends AggregateError {}

/** The pause a Build takes, with the worker's claim kept, while a worker's stop is unproven. */
export const PROCESS_STOP_UNPROVEN_PAUSE_PREFIX = "process_stop_unproven:";

export function processStopUnprovenPauseReason(taskId: string): string {
  return `${PROCESS_STOP_UNPROVEN_PAUSE_PREFIX}${taskId}`;
}

/**
 * Whether an error says an agent's stop is unproven: an
 * {@link AgentCleanupUnverifiedError}, or a `process_cleanup_unverified`
 * error anywhere in its aggregate or cause chain. Bounded in depth, so a
 * cyclic cause cannot loop.
 */
export function isProcessStopUnprovenError(error: unknown, depth = 0): boolean {
  if (depth > 8 || error === null || typeof error !== "object") return false;
  if (error instanceof AgentCleanupUnverifiedError) return true;
  if ((error as { code?: unknown }).code === "process_cleanup_unverified") return true;
  if (error instanceof AggregateError && error.errors.some((inner) => isProcessStopUnprovenError(inner, depth + 1))) return true;
  const cause = (error as { cause?: unknown }).cause;
  return cause !== undefined && isProcessStopUnprovenError(cause, depth + 1);
}

/** An error's message with its aggregated causes, so a pause names what actually failed. */
export function errorMessage(error: unknown, depth = 0): string {
  if (!(error instanceof Error)) return String(error);
  if (!(error instanceof AggregateError) || depth > 3 || error.errors.length === 0) return error.message;
  return `${error.message} (${error.errors.map((inner) => errorMessage(inner, depth + 1)).join("; ")})`;
}

/**
 * Stops every managed process the exact agent owner started once the agent
 * ends, keeping a primary failure visible. A stop that is not proven throws
 * {@link AgentCleanupUnverifiedError}.
 */
export async function withManagedProcessAgentLifecycle<T>(
  processes: { closeAgent(owner: ManagedProcessOwner): Promise<void> } | undefined,
  owner: ManagedProcessOwner,
  perform: () => Promise<T>,
): Promise<T> {
  let failed = false; let primary: unknown; let result: T | undefined;
  try { result = await perform(); } catch (error) { failed = true; primary = error; }
  try { await processes?.closeAgent(owner); }
  catch (cleanup) { throw new AgentCleanupUnverifiedError(failed ? [primary, cleanup] : [cleanup], "Agent managed-process cleanup remains unverified."); }
  if (failed) throw primary;
  return result!;
}
