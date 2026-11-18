import { AsyncResource } from "node:async_hooks";
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
  /**
   * The test makes this cleanup fail on purpose and asserts the failure; it is then not recorded for the
   * retained-cleanup exit below. Only for synthetic owners that hold nothing once the test is done.
   */
  expectUnverifiedCleanup?: boolean;
}>): Promise<void> {
  try {
    await input.cleanup();
    await input.certify();
  } catch (cleanupFailure) {
    const retained = new AggregateError(
      input.hasPrimaryFailure ? [input.primaryFailure, cleanupFailure] : [cleanupFailure],
      `${input.fixtureName} cleanup remains unverified; exact evidence retained at ${input.root}.`,
    );
    if (input.expectUnverifiedCleanup !== true) noteUnverifiedCleanup(retained);
    throw retained;
  }
  if (input.hasPrimaryFailure) throw input.primaryFailure;
  await input.removeRoot();
}

/** finalizeCertifiedFixture for suites that run fixture cleanup bodies with failures they inject and assert. */
export const finalizeExpectingUnverifiedCleanup: typeof finalizeCertifiedFixture = (input) =>
  finalizeCertifiedFixture({ ...input, expectUnverifiedCleanup: true });

/**
 * Bounded end for a test file whose fixture cleanup stayed unverified.
 *
 * A cleanup that cannot prove its release keeps everything its owners still hold, on purpose: an ExecutionHost
 * whose run close failed keeps its inspection helpers (on Windows the birth helper child and its Worker) and any
 * supervisors, so a later close could still prove the stop. Those handles keep the event loop alive, so the file's
 * process never exits; on CI that cost a whole job (run 44299442959 sat 29 minutes after a 4 s failure).
 *
 * The first unverified cleanup adds one root `after` hook. Root hooks run in the order they were added, so this one
 * runs after the file's own (they are added when the file loads, or earlier in its root `after` phase); after it the
 * root only reports. From then on, a process that is still alive once its output has drained is ended: like a Runner
 * crash, which the durable owners are built to survive. Nothing is signalled, stopped or removed here, and the
 * evidence root stays. The exit code is 1: a recorded cleanup is never one a test expected (those pass
 * expectUnverifiedCleanup), and in a held process node:test never reaches its own summary, so a file run directly
 * would otherwise exit 0 with a failed test. The full nested cleanup errors are printed first, because the test
 * reporter shows only their first level. The watch is unref'd, so a process that drains by itself exits as before
 * and prints nothing. A cleanup that first fails after the root's after hooks have run (in an unawaited promise or a
 * beforeExit handler, say) adds a hook that never runs, so it is not bounded; no caller does that.
 */
const unverifiedCleanups: AggregateError[] = [];
/** The root reports right after its last `after` hook; this only lets those writes leave the process. */
const RETAINED_EXIT_FLUSH_MS = 1_000;
/** Ceiling for a stdout/stderr that never drains (a parent that stopped reading). */
const RETAINED_EXIT_CEILING_MS = 10_000;
const RETAINED_EXIT_POLL_MS = 50;
/** Created when the module loads, outside any test: `after()` run in its scope attaches to the root, not to a test. */
const rootScope = new AsyncResource("certified-fixture-root");
// Only in a test file's own process (its main module, under --test or run directly). Qualification scenarios import
// this helper into plain child processes, where a node:test hook would start a test harness of its own; they inherit
// the test runner's environment, so NODE_TEST_CONTEXT cannot tell them apart.
const inTestFile = /\.test\.[cm]?[jt]s$/.test(process.argv[1] ? basename(process.argv[1]) : "");

function noteUnverifiedCleanup(failure: AggregateError): void {
  unverifiedCleanups.push(failure);
  if (unverifiedCleanups.length === 1 && inTestFile) rootScope.runInAsyncScope(() => after(armRetainedCleanupExit));
}

function armRetainedCleanupExit(): void {
  const startedAt = performance.now();
  let reported = false;
  const watch = setInterval(() => {
    const elapsed = performance.now() - startedAt;
    const drained = process.stdout.writableLength === 0 && process.stderr.writableLength === 0;
    if (!reported && elapsed >= RETAINED_EXIT_FLUSH_MS && drained) {
      reported = true;
      for (const failure of unverifiedCleanups) {
        process.stderr.write(`[certified-fixture] ${inspect(failure, { depth: Infinity, breakLength: 160 })}\n`);
      }
      process.stderr.write(`[certified-fixture] ${unverifiedCleanups.length} fixture cleanup(s) remain unverified and what ` +
        "they retain keeps this test process alive after its last test; ending it now. Evidence roots are kept.\n");
      return;
    }
    if ((reported && drained) || elapsed >= RETAINED_EXIT_CEILING_MS) {
      clearInterval(watch);
      process.exit(1);
    }
  }, RETAINED_EXIT_POLL_MS);
  watch.unref();
}
