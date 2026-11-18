import { basename } from "node:path";
import { after } from "node:test";
import { inspect } from "node:util";

/** Test-only finalization policy. Callbacks must use the fixture's retained
 * capability and certify its complete release; a PID is never control authority.
 * This helper itself does not discover, signal, recover, or remove any resource.
 */
export async function finalizeCertifiedFixture(input: Readonly<{
  fixtureName: string;
  root: string;
  hasPrimaryFailure: boolean;
  primaryFailure?: unknown;
  cleanup(): Promise<void>;
  certify(): Promise<void>;
  removeRoot(): Promise<void> | void;
}>): Promise<void> {
  try {
    await input.cleanup();
    await input.certify();
  } catch (cleanupFailure) {
    const retained = new AggregateError(
      input.hasPrimaryFailure ? [input.primaryFailure, cleanupFailure] : [cleanupFailure],
      `${input.fixtureName} cleanup remains unverified; exact evidence retained at ${input.root}.`,
    );
    unverifiedCleanups.push(retained);
    throw retained;
  }
  if (input.hasPrimaryFailure) throw input.primaryFailure;
  await input.removeRoot();
}

/**
 * Bounded end for a test file whose fixture cleanup stayed unverified.
 *
 * A cleanup that cannot prove its release keeps everything its owners still hold, on purpose: an ExecutionHost
 * whose run close failed keeps its inspection helpers (on Windows the birth helper child and its Worker) and any
 * supervisors, so a later close could still prove the stop. Those handles keep the event loop alive, so the file's
 * process never exits; on CI that cost a whole job (run 44299442959 sat 29 minutes after a 4 s failure).
 *
 * Once every test of the file has finished (the root `after` hook), a process with an unverified cleanup is ended
 * as soon as the reporter has flushed: like a Runner crash, which the durable owners are built to survive. Nothing
 * is signalled, stopped or removed here; the evidence root stays, the failure stays reported, and the full nested
 * cleanup errors are printed (the test reporter shows only their first level). A file with no unverified cleanup,
 * or one that drains by itself, exits as before: the watch is unref'd.
 */
const unverifiedCleanups: AggregateError[] = [];
/** The reporter's events follow the root `after` hook at once; this only lets their pipe writes leave the process. */
const RETAINED_EXIT_FLUSH_MS = 1_000;
/** Ceiling for a stdout/stderr that never drains (a parent that stopped reading). */
const RETAINED_EXIT_CEILING_MS = 10_000;
const RETAINED_EXIT_POLL_MS = 50;

function armRetainedCleanupExit(): void {
  if (unverifiedCleanups.length === 0) return;
  const startedAt = performance.now();
  let reported = false;
  // Unref'd: a process that drains by itself exits before this fires and prints nothing (files that exercise a
  // failed cleanup on purpose hold nothing). Only a process still held alive after the flush window gets here.
  const watch = setInterval(() => {
    const elapsed = performance.now() - startedAt;
    const drained = process.stdout.writableLength === 0 && process.stderr.writableLength === 0;
    if (!reported && elapsed >= RETAINED_EXIT_FLUSH_MS && drained) {
      reported = true;
      for (const failure of unverifiedCleanups) {
        process.stderr.write(`[certified-fixture] ${inspect(failure, { depth: Infinity, breakLength: 160 })}\n`);
      }
      process.stderr.write(`[certified-fixture] ${unverifiedCleanups.length} fixture cleanup(s) remain unverified and what ` +
        "they retain keeps this test process alive; ending it now. Evidence roots are kept.\n");
      return;
    }
    if ((reported && drained) || elapsed >= RETAINED_EXIT_CEILING_MS) {
      clearInterval(watch);
      process.exit(1);
    }
  }, RETAINED_EXIT_POLL_MS);
  watch.unref();
}

// Only in a test file's own process (its main module, under --test or run directly). Qualification scenarios import
// this helper into plain child processes, where a node:test hook would start a test harness of its own; they inherit
// the test runner's environment, so NODE_TEST_CONTEXT cannot tell them apart.
if (/\.test\.[cm]?[jt]s$/.test(process.argv[1] ? basename(process.argv[1]) : "")) after(() => armRetainedCleanupExit());
