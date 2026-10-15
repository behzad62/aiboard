import type { FinalVerificationCommand } from "./final-verification-runtime.js";

/**
 * T6b (OA-14): the precise rung of the flaky-rerun ladder. A failing check
 * re-runs ONLY its failing tests, once, when the recorded tests command is
 * a directly invoked `node --test` (the one runner whose test selection the
 * kernel can narrow mechanically). Every other shape reports unsupported —
 * the pump then charges the cycle with the recorded reason instead of
 * claiming a rerun it did not perform.
 */

const NODE_EXECUTABLES = new Set(["node", "node.exe"]);

function hasTestFlag(args: readonly string[]): boolean {
  return args.includes("--test");
}

function hasSelectionFlag(args: readonly string[]): boolean {
  return args.some((arg) => arg === "--test-name-pattern" || arg === "--test-only" || arg.startsWith("--test-name-pattern=") || arg === "--test-skip-pattern" || arg.startsWith("--test-skip-pattern="));
}

/** T6b repair (B2): a directly invoked `node --test`, the only shape the runner can capture and narrow. */
export function isDirectNodeTestCommand(command: Pick<FinalVerificationCommand, "executable" | "args">): boolean {
  const executable = command.executable.split("/").at(-1)?.split("\\").at(-1) ?? command.executable;
  return NODE_EXECUTABLES.has(executable) && hasTestFlag(command.args);
}

/**
 * T6b repair (R2-B4): the package `run test` command (the production
 * final-verification tests command). Its node --test script is narrowed
 * through NODE_OPTIONS, never by editing the script.
 */
export function isPackageRunTestCommand(command: Pick<FinalVerificationCommand, "args">): boolean {
  const runIndex = command.args.lastIndexOf("run");
  return runIndex >= 0 && command.args[runIndex + 1] === "test" && command.args.length === runIndex + 2;
}

/** T6b repair (B2): a command that already selects, skips, or isolates tests cannot be narrowed further. */
export function hasTestSelectionFlag(args: readonly string[]): boolean {
  return hasSelectionFlag(args);
}

export function escapeRegExpPattern(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Anchored alternation matching exactly the given test ids. */
export function flakyRerunPattern(failingTestIds: readonly string[]): string {
  return failingTestIds.map((id) => `^${escapeRegExpPattern(id)}$`).join("|");
}

/**
 * Narrow one recorded tests command to the failing tests. Returns undefined
 * when the command is not a filterable `node --test` invocation. The
 * selection flag is inserted before the first positional test path: node
 * ignores options placed after positionals, so appending would run the
 * whole suite again instead of narrowing it.
 */
export function narrowNodeTestCommand(
  command: FinalVerificationCommand,
  failingTestIds: readonly string[],
): FinalVerificationCommand | undefined {
  if (failingTestIds.length === 0) return undefined;
  const executable = command.executable.split("/").at(-1)?.split("\\").at(-1) ?? command.executable;
  if (!NODE_EXECUTABLES.has(executable)) return undefined;
  if (!hasTestFlag(command.args) || hasSelectionFlag(command.args)) return undefined;
  const flag = `--test-name-pattern=${flakyRerunPattern(failingTestIds)}`;
  const narrowed = [...command.args];
  const positional = narrowed.findIndex((arg) => arg === "--" || !arg.startsWith("-"));
  if (positional === -1) narrowed.push(flag);
  else narrowed.splice(positional, 0, flag);
  return {
    ...command,
    label: `${command.label} (flaky rerun)`,
    args: narrowed,
  };
}

export interface FlakyRerunReport {
  readonly failingTestIds?: readonly string[];
  readonly executed?: number;
  readonly failed?: number;
}

/**
 * T6b repair (B2): the owner real-counts verdict for one filtered rerun.
 * Flaky requires the rerun's OWN report to show the named tests executed
 * and passed (at least the named count executed, zero failed, none of the
 * named ids failing). A `--test-name-pattern` that matches nothing exits
 * 0 with zero executed — green but not flaky — as is a green rerun with
 * no report at all. Anything else is a consistent failure.
 */
export function judgeFlakyRerun(input: {
  readonly checkGreen: boolean;
  readonly reports: readonly FlakyRerunReport[];
  readonly failingTestIds: readonly string[];
}): { flaky: boolean; note: string } {
  const rerunFailingIds = [...new Set(input.reports.flatMap((report) => report.failingTestIds ?? []))];
  const rerunExecuted = input.reports.reduce((sum, report) => sum + (report.executed ?? 0), 0);
  const rerunFailed = input.reports.reduce((sum, report) => sum + (report.failed ?? 0), 0);
  const names = input.failingTestIds.join(", ");
  if (
    input.checkGreen && input.reports.length > 0 && rerunFailed === 0 &&
    rerunFailingIds.length === 0 && rerunExecuted >= Math.max(1, input.failingTestIds.length)
  ) {
    return { flaky: true, note: `The rerun executed ${rerunExecuted} test(s) with none failing, including [${names}].` };
  }
  if (input.checkGreen) {
    return {
      flaky: false,
      note: `The rerun exited green but its report does not show the failing tests executed and passed (executed ${rerunExecuted}, failed ${rerunFailed}, reports ${input.reports.length}); not flaky.`,
    };
  }
  return {
    flaky: false,
    note: `The rerun failed the same way [${rerunFailingIds.join(", ") || names}]; charging the cycle.`,
  };
}
