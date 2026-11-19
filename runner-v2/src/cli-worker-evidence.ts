/**
 * The Runner's re-runs of the checks a CLI worker reported (docs/plans/2026-11-14-cli-workers.md §3.6, packet CW6).
 *
 * A CLI's checks are claims. After the CLI's processes are proven stopped and its work collected (§3.5 steps 5-6), the
 * Runner runs each reported check itself, through the same `run_evidence_command` tool an API worker calls, behind a
 * ToolBroker that issues each call's grant, as the assigned worker and its attempt. So each record satisfies the
 * submission rule (acceptance-contracts.ts), keeps its `outputs` as artifacts (VF6), and carries
 * `source: "runner_rerun_of_cli_claim"` so the Architect sees who ran it.
 *
 * - A shell line (`a && b`, pipes, redirection, a shell given a command string) is not run.
 * - An executable the Runner's lookup does not find (VF2) is `not_run: tool_missing`, never a failure.
 * - A `playwright-cli` check is not run when the CLI ran without a browser (§3.11 case 3).
 * - Each re-run's timeout is the task's remaining validation budget, at least one minute and at most ten. A re-run the
 *   budget cut short is `not_run: validation_budget_spent`, never a failure, and never support: its criterion gets the
 *   fix round, and after it is submitted as not verified by the Runner, linked to the timed-out record.
 * - Files a re-run changed are restored right after it, so every check runs on, and the Runner submits, the tree the
 *   CLI left. A pass supports a criterion only when its record proves it ran on that tree.
 * - A re-run whose processes are not proven gone throws a classified error (process-stop-proof.ts), never a result: a
 *   cleanup not verified, any tool error but those that mean nothing started, or no evidence record. The CLI loop holds
 *   the attempt (`cli_reruns_pending`), and its stop proof requires the owner's one-shot commands settled
 *   (`createCliOneShotSettlement`).
 *
 * Which gaps send the CLI into its one fix round (CWD-3), and which fail the attempt, is `cliCheckDecision`, which the
 * CLI loop (cli-worker-runtime.ts) applies.
 */

import { randomUUID } from "node:crypto";
import { isAbsolute, resolve } from "node:path";

import type { AcceptanceCriterion, CriterionEvidenceLink } from "./acceptance-contracts.js";
import type { ToolResult } from "./agent-contracts.js";
import type { ArtifactStore } from "./artifact-store.js";
import type { BudgetLedger } from "./budget-ledger.js";
import type { CheckToolLookup } from "./check-tool-lookup.js";
import type { CliCheckRerunner, CliWorkerOwner } from "./cli-worker-runtime.js";
import type { CliWorkerCheckV1 } from "./cli-worker-result.js";
import type { WorkingTreeIdentity } from "./command-evidence-identity.js";
import type { PermissionProfile } from "./contracts.js";
import { evidenceFactArtifactHashes, RUNNER_RERUN_OF_CLI_CLAIM, type EvidenceRecord, type EvidenceStore } from "./evidence-store.js";
import { createEvidenceTools } from "./evidence-tools.js";
import type { ExecutionGrantAuthority } from "./execution-grants.js";
import type { RunGitExecutionContext } from "./git-run-context.js";
import type { OneShotCommandExecutor } from "./one-shot-command-executor.js";
import type { ProcessRecoveryRuntime, RecoveryTarget } from "./process-recovery.js";
import { redactSensitiveText } from "./sensitive-redaction.js";
import { ToolBroker } from "./tool-broker.js";
import type { ToolInvocationLedger } from "./tool-ledger.js";
import { summarizeValidationBudget } from "./validation-budget.js";

/** §3.6: one re-run never waits longer than this, whatever validation budget is left. */
export const CLI_RERUN_TIMEOUT_CAP_MS = 10 * 60_000;
/** §3.6: a re-run gets at least this much when the advisory budget has less left, so every check leaves a record. */
export const CLI_RERUN_MIN_TIMEOUT_MS = 60_000;
/** CWD-3: fix rounds a CLI gets when a criterion has no passing re-run or a re-run failed. */
export const CLI_FIX_ROUNDS = 1;
/** The attempt fails with these when the gap remains after the fix round (§3.6). */
export const CLI_CHECKS_UNSUPPORTED = "cli_checks_unsupported";
export const CLI_CHECKS_FAILING = "cli_checks_failing";
/** The re-runs themselves could not be completed (the tree could not be read or restored): nothing is submitted. */
export const CLI_CHECKS_RERUN_FAILED = "cli_checks_rerun_failed";

const OUTPUT_TAIL_CHARS = 1_500;
const TEXT_MAX = 500;

export type CliCheckNotRunReason =
  | "shell_line"
  | "tool_missing"
  | "browser_unavailable"
  | "validation_budget_spent"
  | "refused"
  | "cancelled";

/** What the Runner observed when it re-ran one check the CLI reported. */
export interface CliCheckRerun {
  label: string;
  /** The program and its arguments, for display. */
  command: string;
  criterionIds: string[];
  status: "passed" | "failed" | "not_run";
  /** The observed result: the exit code, a timeout, or why the check was not run. */
  detail: string;
  notRunReason?: CliCheckNotRunReason;
  /** The re-run's record: every check that ran has one, a budget-cut one included. */
  evidenceId?: string;
  artifactHashes?: string[];
  /** A pass whose record proves it ran on the tree the CLI left and that changed no file: it supports its criteria. */
  supports?: boolean;
  /** Files this re-run changed, which the Runner restored before the next check ran. */
  changedFiles?: string[];
  /** A failed re-run: the end of its output, redacted and bounded, for the fix round. */
  outputTail?: string;
}

export interface CliCheckRerunnerOptions {
  git?: RunGitExecutionContext;
  evidenceStore: EvidenceStore;
  artifacts: ArtifactStore;
  execution: OneShotCommandExecutor;
  executionGrants?: ExecutionGrantAuthority;
  ledger?: ToolInvocationLedger;
  permissionProfile: PermissionProfile;
  /** Re-runs count as validation time, as any worker's evidence commands do (§3.5 step 9). */
  budgetLedger?: BudgetLedger;
  /** VF2: the lookup a final check uses; only `missing` makes a check not run. */
  toolLookup?: CheckToolLookup;
  /** The working files' tree before and after the re-runs (command-evidence-identity.ts). */
  captureTree: (cwd: string) => Promise<WorkingTreeIdentity>;
  /** Puts the working files back to a captured tree; returns the paths it restored (restoreWorkingTree). */
  restoreTree: (cwd: string, treeId: string) => Promise<string[]>;
  allowedCommands?: readonly string[];
  hiddenPaths?: readonly string[];
  /**
   * Why the owner's one-shot commands are not settled, or undefined (createCliOneShotSettlement). A re-run that ends in
   * a tool error that does not mean "nothing started" is a refusal only when this proves nothing of it runs; without
   * it, or when it does not, the re-run holds the attempt.
   */
  oneShotCommands?: (owner: Pick<CliWorkerOwner, "runId" | "sessionId">) => Promise<string | undefined>;
  clock?: () => string;
}

/** A re-run the Runner could not complete: the attempt fails with this code and nothing is submitted. */
export class CliCheckRerunError extends Error {
  readonly code = CLI_CHECKS_RERUN_FAILED;
  constructor(message: string) {
    super(message);
    this.name = "CliCheckRerunError";
  }
}

/** The production re-runner the CLI loop calls after a `done` (CliWorkerRuntimeDeps.rerunChecks). */
export function createCliCheckRerunner(options: CliCheckRerunnerOptions): CliCheckRerunner {
  const clock = options.clock ?? (() => new Date().toISOString());
  return async (input) => {
    const { owner, workspace, taskId, attempt, result, submission } = input;
    const current = await options.captureTree(workspace.path);
    if (current.status !== "known") throw new CliCheckRerunError("The worktree's files could not be read before the re-runs, so they could not be restored after them.");
    // The tree the CLI left, which the loop persisted before calling (a restart restores it, cli-worker-runtime.ts).
    if (input.treeBefore !== undefined && input.treeBefore !== current.treeId) {
      throw new CliCheckRerunError(`The worktree's files are not the ones the CLI left (tree ${current.treeId}, not ${input.treeBefore}).`);
    }
    const before = current.treeId;
    const broker = new ToolBroker({
      ...(options.git ? { git: options.git } : {}),
      permissionProfile: options.permissionProfile,
      workspacePath: workspace.path,
      artifacts: options.artifacts,
      clock,
      ...(options.ledger ? { ledger: options.ledger } : {}),
      ...(options.executionGrants ? { executionGrants: options.executionGrants } : {}),
    });
    const tool = createEvidenceTools({
      ...(options.git ? { git: options.git } : {}),
      store: options.evidenceStore,
      artifacts: options.artifacts,
      taskId,
      attempt,
      execution: options.execution,
      clock,
      maximumTimeoutMs: CLI_RERUN_TIMEOUT_CAP_MS,
      ...(options.budgetLedger ? { validationAccounting: { ledger: options.budgetLedger, runId: owner.runId } } : {}),
      ...(options.allowedCommands ? { allowedCommands: options.allowedCommands } : {}),
      ...(options.hiddenPaths ? { hiddenPaths: options.hiddenPaths } : {}),
      factSource: RUNNER_RERUN_OF_CLI_CLAIM,
    }).find((candidate) => candidate.definition.name === "run_evidence_command");
    if (!tool) throw new Error("The evidence tools have no run_evidence_command.");
    broker.register(tool);

    const reruns: CliCheckRerun[] = [];
    const restored = new Set<string>();
    for (const check of result.checks) {
      const base = {
        label: bounded(check.label) || "a check",
        command: bounded([check.executable, ...check.args].join(" ")),
        criterionIds: [...new Set(check.criterionIds ?? [])],
      };
      const notRun = (reason: CliCheckNotRunReason, detail: string): CliCheckRerun =>
        ({ ...base, status: "not_run", notRunReason: reason, detail: bounded(detail) });
      if (input.signal?.aborted) {
        reruns.push(notRun("cancelled", "not re-run: the attempt was cancelled"));
        continue;
      }
      const shell = cliCheckShellLine(check);
      if (shell) {
        reruns.push(notRun("shell_line", `not re-run: shell line (${shell}); report each check as one program and its arguments`));
        continue;
      }
      if (input.browserUnavailable && isBrowserCheck(check)) {
        reruns.push(notRun("browser_unavailable", "not re-run: no browser ran for this task, so its browser checks are not run"));
        continue;
      }
      if (options.toolLookup) {
        let found: Awaited<ReturnType<CheckToolLookup>> | undefined;
        try {
          found = await options.toolLookup(check.executable, { cwd: resolve(workspace.path, check.cwd ?? "."), owner: { runId: owner.runId, sessionId: owner.sessionId } });
        } catch {
          found = undefined;
        }
        if (found?.status === "missing") {
          reruns.push(notRun("tool_missing", `not run (tool_missing): ${check.executable} is not installed on this PC; not a failure`));
          continue;
        }
      }
      // The budget is advisory (validation-budget.ts): a spent one still gives each re-run a minute, so every reported
      // check leaves a record, and a re-run it cut short is not run, never a failure (§3.6).
      const remaining = remainingValidationMs(options.budgetLedger, owner.runId, taskId, submission.validationBudgetMs);
      const timeoutMs = Math.floor(Math.min(CLI_RERUN_TIMEOUT_CAP_MS, Math.max(remaining, CLI_RERUN_MIN_TIMEOUT_MS)));
      const callId = `cli-rerun:${attempt}:${randomUUID()}`;
      const output = await broker.invoke({
        type: "tool_call",
        callId,
        name: "run_evidence_command",
        arguments: {
          label: check.label,
          command: check.executable,
          args: [...check.args],
          cwd: check.cwd ?? ".",
          timeoutMs,
          ...(check.outputs?.length ? { outputs: [...check.outputs] } : {}),
        },
      }, {
        runId: owner.runId,
        sessionId: owner.sessionId,
        actor: { ...owner.actor },
        workspacePath: workspace.path,
        callId,
        toolName: "run_evidence_command",
        ...(input.signal ? { signal: input.signal } : {}),
      });
      // A re-run whose processes are not proven gone throws before anything is restored: they may still write, and the
      // scheduler keeps the claim and pauses (#220); the next entry restores the tree the loop persisted.
      let rerun: CliCheckRerun;
      try {
        rerun = rerunFromResult(base, output, options.evidenceStore, owner.runId, taskId, timeoutMs, before, notRun);
      } catch (error) {
        if (!(error instanceof CliRerunUnrecordedError)) throw error;
        let unsettled: string | undefined;
        try {
          unsettled = options.oneShotCommands ? await options.oneShotCommands(owner) : "the Runner cannot check the commands it ran";
        } catch (checkError) {
          unsettled = `the commands the Runner ran could not be checked: ${bounded(checkError instanceof Error ? checkError.message : String(checkError))}`;
        }
        if (unsettled) throw new CliRerunStopUnprovenError(`${error.message} ${unsettled}`);
        rerun = notRun(error.toolCode === "tool_cancelled" ? "cancelled" : "refused",
          `not re-run: ${error.toolCode ?? "no evidence record"}: ${error.detail}`);
      }
      // Every check runs on the tree the CLI left: files a re-run changed are put back before the next one runs.
      const after = await options.captureTree(workspace.path);
      if (after.status !== "known") throw new CliCheckRerunError(`The worktree's files could not be read after the re-run of ${base.label}, so the next check could not be proven to run on the tree the CLI left.`);
      if (after.treeId !== before) {
        let paths: string[];
        try {
          paths = await options.restoreTree(workspace.path, before);
        } catch (error) {
          throw new CliCheckRerunError(`The re-run of ${base.label} changed the worktree's files and they could not be restored: ${error instanceof Error ? error.message : String(error)}`);
        }
        // CW8's browser output folder (.aiboard-browser/) ignores itself, so what a browser check keeps there is never a
        // change to the tree.
        for (const path of paths) restored.add(path);
        rerun.changedFiles = paths;
        rerun.supports = false;
        if (rerun.status === "passed") rerun.detail = `passed, but it changed ${paths.length} file(s), so it supports nothing`;
      }
      reruns.push(rerun);
    }
    return {
      criterionEvidenceLinks: cliCheckEvidenceLinks(submission.acceptanceCriteria, reruns, taskId, attempt),
      notRun: reruns.filter((rerun) => rerun.status === "not_run").map((rerun) => ({ what: `${rerun.label}: ${rerun.command}`, why: rerun.detail })),
      reruns,
      restoredPaths: [...restored].sort(),
    };
  };
}

/**
 * The tool error codes that mean no process was started: the broker or the evidence tool refused the call before the
 * execution (an approval or permission denial, a path denial, invalid arguments, no workspace, a WorkBench allowlist,
 * no process runtime, no isolation for it, the tool budget). Only these are "not re-run: refused". (A missing execution
 * grant reaches a re-run as `evidence_command_failed`: evidence-tools.ts keeps no code for it.)
 * Every other code, an unknown one included, may leave a process running (a broker `tool_timeout` stopped waiting for
 * it, `backend_unavailable` and `identity_mismatch` could not observe or signal it, `tool_execution_failed` or
 * `evidence_command_failed` threw around it, a `tool_cancelled` may come mid-run), so it holds the attempt (§3.6).
 */
const NOT_STARTED_CODES = new Set([
  "approval_required", "permission_denied", "path_denied", "outside_only_here", "invalid_arguments", "invalid_arguments_json",
  "workspace_required", "benchmark_command_denied", "process_runtime_unavailable",
  "isolation_capability_unavailable", "budget_exhausted",
]);

/**
 * The tool error codes that always hold the attempt, whatever the subprocess store shows. `tool_timeout`: the broker
 * stopped waiting without awaiting the call, which may still be on its way to a launch, so no read of the store can
 * prove it will not run. `process_cleanup_unverified`, `outcome_unknown`, `cleanup_blocked`: the executor's own word
 * that the stop is unproven, the first of a managed cleanup the one-shot store does not cover.
 */
const ALWAYS_HOLD_CODES = new Set(["tool_timeout", "process_cleanup_unverified", "outcome_unknown", "cleanup_blocked"]);

/**
 * §3.6: the owner's one-shot commands (the Runner's re-runs) whose subprocess records are not settled. A re-run is a
 * one-shot command of the shared subprocess runtime, which the owner's `closeAgent` does not cover, so a stop proof of
 * a CLI attempt (proveCliStop) also requires each of them settled: cleaned with its cleanup verified empty, or never
 * launched, with no effect pending (the rule assertSubprocessCleanupSettled applies at run teardown). Read-only: the
 * runtime's own reconciliation (a Runner restart) or the owner's process recovery settles a record; Resume checks again.
 */
export function createCliOneShotSettlement(
  recovery: Pick<ProcessRecoveryRuntime, "list" | "listGradually">,
): (owner: Pick<CliWorkerOwner, "runId" | "sessionId">) => Promise<string | undefined> {
  return async (owner) => {
    // listGradually shares a scan already in flight, which may have listed the rows before a re-run's record existed:
    // the first call lets it finish, and the second is a scan that began after this check did.
    let targets: readonly RecoveryTarget[] | undefined;
    if (recovery.listGradually) {
      await recovery.listGradually();
      targets = await recovery.listGradually();
    } else {
      targets = recovery.list?.();
    }
    if (!targets) return "the Runner cannot list the commands it ran for this attempt, so their stop is not proven";
    const open = targets.filter((target) => target.scope.kind === "subprocess" && target.scope.runId === owner.runId &&
      target.scope.sessionId === owner.sessionId && !settledOneShot(target));
    if (open.length === 0) return undefined;
    const named = open.slice(0, 4).map((target) => `${target.scope.invocationId} (${target.scope.state}, cleanup ${target.cleanup.state})`).join(", ");
    return `${open.length} command(s) the Runner ran for this attempt are not proven stopped: ${named}${open.length > 4 ? ", …" : ""}. A Runner restart reconciles them, or stop them with Process recovery; Resume checks again`;
  };
}

function settledOneShot(target: RecoveryTarget): boolean {
  if (target.pendingEffects) return false;
  if (target.scope.state === "cleaned") return target.cleanup.state === "verified_empty";
  return !target.backend && (target.scope.state === "reused" || target.scope.state === "launch_not_proven") && target.cleanup.state === "not_required";
}

/** A re-run whose processes are not proven gone: classified as an unproven stop (process-stop-proof.ts). */
export class CliRerunStopUnprovenError extends Error {
  readonly code = "process_cleanup_unverified";
  constructor(message: string) {
    super(message);
    this.name = "CliRerunStopUnprovenError";
  }
}

/**
 * A re-run that ended with no record of how its processes stopped: a tool error that does not mean nothing started, or
 * no evidence record. Classified as an unproven stop wherever it escapes; the re-runner makes it a refusal only once the
 * owner's one-shot commands are proven settled.
 */
class CliRerunUnrecordedError extends CliRerunStopUnprovenError {
  constructor(label: string, readonly toolCode: string | undefined, readonly detail: string) {
    super(`The re-run of ${label} ended without a record that its processes stopped (${toolCode ?? "no evidence record"}: ${detail}).`);
  }
}

/** Whether a re-run's tool error code means no process was started (exported for its table test). */
export function cliRerunNothingStarted(code: string | undefined): boolean {
  return code !== undefined && NOT_STARTED_CODES.has(code);
}

/** Whether a re-run's tool error code holds the attempt even when the owner's one-shot commands read settled. */
export function cliRerunAlwaysHolds(code: string | undefined): boolean {
  return code !== undefined && ALWAYS_HOLD_CODES.has(code);
}

function rerunFromResult(
  base: Pick<CliCheckRerun, "label" | "command" | "criterionIds">,
  output: ToolResult,
  store: EvidenceStore,
  runId: string,
  taskId: string,
  timeoutMs: number,
  treeBefore: string,
  notRun: (reason: CliCheckNotRunReason, detail: string) => CliCheckRerun,
): CliCheckRerun {
  if (output.isError) {
    const code = output.error?.code;
    if (code && NOT_STARTED_CODES.has(code)) {
      return notRun("refused", `not re-run: ${code}: ${output.error?.message ?? "the Runner refused the command"}`);
    }
    if (code && ALWAYS_HOLD_CODES.has(code)) {
      throw new CliRerunStopUnprovenError(`The re-run of ${base.label} did not prove its processes stopped (${code}): ${bounded(output.error?.message ?? "")}`);
    }
    throw new CliRerunUnrecordedError(base.label, code, bounded(output.error?.message ?? "the Runner refused the command"));
  }
  const view = output.content.find((block) => block.type === "json")?.value as { id?: unknown } | undefined;
  const id = typeof view?.id === "string" ? view.id : undefined;
  const record: EvidenceRecord | undefined = id ? store.getByIds({ runId, taskId, ids: [id] }).find((candidate) => candidate.id === id) : undefined;
  // A command that ran leaves a record of how it stopped; without one, nothing proves it did.
  if (!record || record.fact.kind !== "command") throw new CliRerunUnrecordedError(base.label, undefined, "the Runner recorded no evidence for the command");
  const fact = record.fact;
  // Only a cleanup the executor verified empty ends a re-run (as command-evidence-reuse.ts requires for a reuse).
  if (fact.cleanup?.state !== "verified_empty") {
    throw new CliRerunStopUnprovenError(`The re-run of ${base.label} did not prove its processes stopped (cleanup ${fact.cleanup?.state ?? "not recorded"}${fact.cleanup?.state === "failed" ? `: ${bounded(fact.cleanup.detail)}` : ""}).`);
  }
  if (fact.cancelled) return notRun("cancelled", "not re-run: the attempt was cancelled");
  const recorded = { evidenceId: record.id, artifactHashes: evidenceFactArtifactHashes(fact) };
  // §3.6: a timeout the validation budget cut below the ten-minute cap is not run, never a failure. Its record is kept
  // and linked, so the Architect sees what ran and how far.
  if (fact.timedOut && timeoutMs < CLI_RERUN_TIMEOUT_CAP_MS) {
    return { ...notRun("validation_budget_spent", `not finished: the task's validation budget left it ${Math.round(timeoutMs / 1000)} s, and it timed out; not a failure`), ...recorded };
  }
  const passed = fact.exitCode === 0 && !fact.timedOut && fact.signal === null;
  const detail = fact.timedOut ? `timed out after ${Math.round(timeoutMs / 1000)} s`
    : fact.signal ? `stopped by signal ${fact.signal}` : `exit ${fact.exitCode ?? "unknown"}`;
  const tail = passed ? undefined : outputTail(output);
  // A pass supports a criterion only when it ran on the tree the CLI left, proven by its own record (§3.6).
  const identity = fact.workingTreeIdentity;
  const onCliTree = identity?.status === "known" && identity.treeId === treeBefore;
  return {
    ...base,
    status: passed ? "passed" : "failed",
    detail: passed && !onCliTree ? "passed, but the Runner could not prove it ran on the files the CLI left" : detail,
    ...recorded,
    supports: passed && onCliTree,
    ...(tail ? { outputTail: tail } : {}),
  };
}

/** The tail of stdout and stderr the tool showed inline, redacted, for the fix round. */
function outputTail(output: ToolResult): string | undefined {
  const text = output.content.flatMap((block) => block.type === "text" && /^(?:stdout|stderr)\b/.test(block.text) ? [block.text] : []).join("\n").trim();
  if (!text) return undefined;
  return redactSensitiveText(text.length > OUTPUT_TAIL_CHARS ? `…${text.slice(-OUTPUT_TAIL_CHARS)}` : text, OUTPUT_TAIL_CHARS + 1);
}

function remainingValidationMs(ledger: BudgetLedger | undefined, runId: string, taskId: string, budgetMs: number): number {
  if (!ledger) return budgetMs;
  try {
    return budgetMs - summarizeValidationBudget(ledger, { runId, taskId, budgetMs }).usedMs;
  } catch {
    // A ledger without validation scopes counts no validation time (validation-budget.ts).
    return budgetMs;
  }
}

/** A re-run the validation budget cut short, with the record of what it ran. */
function budgetRecord(rerun: CliCheckRerun): boolean {
  return rerun.notRunReason === "validation_budget_spent" && !!rerun.evidenceId && !!rerun.artifactHashes?.length;
}

/**
 * Each criterion's link: the first supporting re-run the CLI linked to it. Only a supporting pass is linked here; a
 * re-run the budget cut short is linked only by `cliCheckDecision`, after the fix round, as not verified. Unknown
 * criterion ids are left out.
 */
export function cliCheckEvidenceLinks(
  criteria: readonly AcceptanceCriterion[] | undefined,
  reruns: readonly CliCheckRerun[],
  taskId: string,
  attempt: number,
): CriterionEvidenceLink[] {
  if (!criteria) return [];
  const links: CriterionEvidenceLink[] = [];
  for (const criterion of criteria) {
    const rerun = reruns.find((candidate) => candidate.criterionIds.includes(criterion.id) && candidate.supports === true &&
      candidate.evidenceId && candidate.artifactHashes?.length);
    if (rerun) links.push({ criterionId: criterion.id, evidenceId: rerun.evidenceId!, artifactHashes: [...rerun.artifactHashes!], taskId, attempt });
  }
  return links;
}

export interface CliCheckGaps {
  /**
   * Criteria with no linked supporting re-run; with no criteria, the task itself. `failing`: a failed re-run is linked
   * to it. `budgetCut`: the record of a linked re-run the validation budget cut short, when no linked re-run failed.
   */
  unsupported: { id: string; text: string; failing: boolean; budgetCut?: CliCheckRerun }[];
  /** Every re-run that failed, linked to a criterion or not. */
  failing: CliCheckRerun[];
}

/**
 * §3.6: what keeps a CLI's `done` from being submitted: a criterion with no linked supporting re-run, or any re-run
 * that failed. A check that was not run (a missing tool, a shell line, a re-run the budget cut short) is never a
 * failure; it leaves its criteria unsupported unless another re-run supports them.
 */
export function cliCheckGaps(
  criteria: readonly AcceptanceCriterion[] | undefined,
  rerun: { criterionEvidenceLinks: readonly CriterionEvidenceLink[]; reruns?: readonly CliCheckRerun[] },
): CliCheckGaps {
  const reruns = rerun.reruns ?? [];
  const failing = reruns.filter((candidate) => candidate.status === "failed");
  const budgetCut = (linked: readonly CliCheckRerun[]) =>
    linked.some((candidate) => candidate.status === "failed") ? {} : (() => {
      const record = linked.find(budgetRecord);
      return record ? { budgetCut: record } : {};
    })();
  if (!criteria) {
    if (reruns.some((candidate) => candidate.supports === true)) return { unsupported: [], failing };
    return { unsupported: [{ id: "task", text: "at least one check of the task's work", failing: failing.length > 0, ...budgetCut(reruns) }], failing };
  }
  const linked = new Set(rerun.criterionEvidenceLinks.map((link) => link.criterionId));
  return {
    unsupported: criteria.filter((criterion) => !linked.has(criterion.id)).map((criterion) => {
      const named = reruns.filter((candidate) => candidate.criterionIds.includes(criterion.id));
      return { id: criterion.id, text: criterion.text, failing: named.some((candidate) => candidate.status === "failed"), ...budgetCut(named) };
    }),
    failing,
  };
}

export function hasCliCheckGaps(gaps: CliCheckGaps): boolean {
  return gaps.unsupported.length > 0 || gaps.failing.length > 0;
}

export type CliCheckDecision =
  | {
    type: "submit";
    /** The criteria's links: the supporting re-runs, plus a not-verified criterion's budget-cut record. */
    criterionEvidenceLinks: CriterionEvidenceLink[];
    /** Re-runs that still fail after the fix round while no criterion depends on them alone. */
    knownDefects: CliCheckRerun[];
    /** Criteria (or the task) the Runner could not verify: their re-runs the budget cut short, even after the fix round. */
    notVerified: { id: string; text: string; rerun: CliCheckRerun }[];
  }
  | { type: "fix_round"; gaps: CliCheckGaps }
  | { type: "fail"; reason: string };

/**
 * §3.6 and CWD-3: any gap gives the CLI one fix round, a criterion whose re-run the budget cut short included. After
 * it, a criterion without support fails the attempt (`cli_checks_failing` when a failed re-run is linked to it, else
 * `cli_checks_unsupported`), unless its linked re-run was cut short by the budget: the work is then submitted with the
 * criterion named as not verified by the Runner (its link is the timed-out record, never a pass), so the budget alone
 * never fails the attempt. A re-run that still fails while no criterion depends on it is a known defect.
 */
export function cliCheckDecision(
  name: string,
  criteria: readonly AcceptanceCriterion[] | undefined,
  rerun: { criterionEvidenceLinks: readonly CriterionEvidenceLink[]; reruns?: readonly CliCheckRerun[] },
  fixRoundUsed: boolean,
  link: { taskId: string; attempt: number },
): CliCheckDecision {
  const gaps = cliCheckGaps(criteria, rerun);
  const links = [...rerun.criterionEvidenceLinks];
  if (!hasCliCheckGaps(gaps)) return { type: "submit", criterionEvidenceLinks: links, knownDefects: [], notVerified: [] };
  if (!fixRoundUsed) return { type: "fix_round", gaps };
  const blocking = gaps.unsupported.filter((criterion) => !criterion.budgetCut);
  if (blocking.length > 0) return { type: "fail", reason: cliCheckGapFailure(name, { unsupported: blocking, failing: gaps.failing }) };
  const notVerified = gaps.unsupported.map((criterion) => ({ id: criterion.id, text: criterion.text, rerun: criterion.budgetCut! }));
  for (const entry of notVerified) {
    if (!criteria) continue;
    links.push({ criterionId: entry.id, evidenceId: entry.rerun.evidenceId!, artifactHashes: [...entry.rerun.artifactHashes!], taskId: link.taskId, attempt: link.attempt });
  }
  return { type: "submit", criterionEvidenceLinks: links, knownDefects: gaps.failing, notVerified };
}

/** The attempt's failure when a criterion is still unsupported after the fix round (§3.6). */
export function cliCheckGapFailure(name: string, gaps: CliCheckGaps): string {
  const failingCriteria = gaps.unsupported.filter((criterion) => criterion.failing);
  const describe = (criteria: CliCheckGaps["unsupported"]) => criteria.map((criterion) => `${criterion.id}: ${criterion.text}`).join("; ");
  const failingReruns = gaps.failing
    .filter((rerun) => failingCriteria.some((criterion) => criterion.id === "task" || rerun.criterionIds.includes(criterion.id)))
    .map((rerun) => `${rerun.label} (${rerun.command}: ${rerun.detail})`).join("; ");
  const others = gaps.unsupported.filter((criterion) => !criterion.failing);
  const text = failingCriteria.length > 0
    ? `${CLI_CHECKS_FAILING}: after its fix round, the Runner's re-runs of ${name}'s checks still fail for ${describe(failingCriteria)}: ${failingReruns}.${others.length ? ` Criteria without a passing re-run: ${describe(others)}.` : ""}`
    : `${CLI_CHECKS_UNSUPPORTED}: after its fix round, no passing re-run of ${name}'s checks supports: ${describe(others)}.`;
  return text.length <= 2_000 ? text : `${text.slice(0, 1_999)}…`;
}

/**
 * The fix round's prompt (§3.5 step 1, §3.6): the re-run results and the missing criteria, for the CLI's resumed
 * session. The CLI loop wraps it in the worker rules (buildCliWorkerPrompt).
 */
export function cliFixRoundPrompt(input: { name: string; gaps: CliCheckGaps; reruns: readonly CliCheckRerun[] }): string {
  const lines = [
    "## Fix round: the Runner's re-runs of your checks",
    `AIBoard re-ran the checks you reported, in this worktree as you left it. Only these re-runs count as evidence. Your work is not submitted yet: this is your one fix round.`,
    "",
    "### Re-run results",
    ...(input.reruns.length
      ? input.reruns.map((rerun) => `- ${rerun.label} (\`${rerun.command}\`): ${rerun.status === "passed" ? (rerun.supports === false ? rerun.detail : "passed") : rerun.status === "failed" ? `failed, ${rerun.detail}` : rerun.detail}` +
        `${rerun.criterionIds.length ? ` [criteria: ${rerun.criterionIds.join(", ")}]` : " [no criteria]"}` +
        `${rerun.changedFiles?.length ? `\n  It changed files, which the Runner put back as you left them: ${listed(rerun.changedFiles)}` : ""}` +
        `${rerun.outputTail ? `\n  Output tail:\n${indent(rerun.outputTail)}` : ""}`)
      : ["- You reported no checks."]),
  ];
  if (input.gaps.unsupported.length) {
    lines.push("", "### Criteria without a passing re-run",
      ...input.gaps.unsupported.map((criterion) => `- ${criterion.id}: ${criterion.text}`),
      "Report, for each of them, a check that supports it, with its id in criterionIds.");
  }
  if (input.gaps.failing.length) lines.push("", "Fix what makes the failing checks fail (never by weakening a test), then run them again yourself.");
  if (input.reruns.some((rerun) => rerun.changedFiles?.length)) {
    lines.push("", "A check that changes files (a formatter, a code generator, an install) supports nothing: every check runs on the files as you left them. Run such a step yourself, keep its changes, and report checks that only read.");
  }
  if (input.reruns.some((rerun) => rerun.notRunReason === "shell_line")) {
    lines.push("", "Some checks were shell lines (&&, pipes, redirection, or a shell given a command string) and were not run. Report each check as one program and its arguments.");
  }
  if (input.reruns.some((rerun) => rerun.notRunReason === "validation_budget_spent")) {
    lines.push("", "A check the task's validation budget cut short supports nothing: report a narrower check that finishes quickly (a single test file, not the whole suite).");
  }
  if (input.reruns.some((rerun) => rerun.notRunReason === "tool_missing")) {
    lines.push("", "A check whose program is not installed on this PC was not run. That is not a failure, but it supports nothing: support its criteria with a check this PC can run.");
  }
  lines.push("", "Then end your turn with the JSON result again. List in checks every check the Runner should run again, each with the criterion ids it supports.");
  return lines.join("\n");
}

function listed(paths: readonly string[]): string {
  return `${paths.slice(0, 20).join(", ")}${paths.length > 20 ? ` (+${paths.length - 20} more)` : ""}`;
}

function indent(text: string): string {
  return text.split(/\r?\n/).map((line) => `    ${line}`).join("\n");
}

const SHELL_OPERATOR = /^(?:&&|\|\||\||;|&|>|>>|<|<<|<<<|[12]>|[12]>>|2>&1|1>&2|&>|&>>)$/;
/** Shells whose `-c` (in any flag group) runs a command string. */
const POSIX_SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "mksh", "ash", "fish", "csh", "tcsh"]);
/** Programs that always run what they are given through a shell. */
const SHELL_RUNNERS = new Set(["wsl"]);
/**
 * Programs that run their arguments as another program: the check is judged by that program. `values`: the options
 * that take the next argument as their value; `leading`: positional arguments before the program (timeout's duration).
 */
const WRAPPERS: Readonly<Record<string, { values: readonly string[]; leading?: number }>> = {
  env: { values: ["-u", "--unset", "-C", "--chdir"] },
  busybox: { values: [] },
  timeout: { values: ["-s", "--signal", "-k", "--kill-after"], leading: 1 },
  nohup: { values: [] },
  nice: { values: ["-n", "--adjustment"] },
  sudo: { values: ["-u", "--user", "-g", "--group", "-C", "--close-from", "-D", "--chdir", "-h", "--host", "-p", "--prompt", "-r", "--role", "-t", "--type", "-T", "--command-timeout", "-U", "--other-user"] },
  doas: { values: ["-u", "-C"] },
  xargs: { values: ["-a", "--arg-file", "-d", "--delimiter", "-E", "-I", "-L", "--max-lines", "-n", "--max-args", "-P", "--max-procs", "-s", "--max-chars"] },
  stdbuf: { values: ["-i", "-o", "-e"] },
  time: { values: ["-f", "--format", "-o", "--output"] },
  command: { values: [] },
  setsid: { values: [] },
  ionice: { values: ["-c", "--class", "-n", "--classdata", "-p", "--pid", "-P", "--pgid", "-u", "--uid"] },
  flock: { values: ["-w", "--wait", "--timeout", "-E", "--conflict-exit-code"], leading: 1 },
  npx: { values: ["-p", "--package"] },
  pnpx: { values: ["-p", "--package"] },
  bunx: { values: ["-p", "--package"] },
};
/** Programs whose `-c` option (alone or in a flag group) runs a command string through a shell. */
const COMMAND_OPTION_PROGRAMS = new Set(["su", "script", "flock"]);
/** Package managers whose subcommand runs the program after it: judged by that program. */
const PACKAGE_EXEC_SUBCOMMANDS: Readonly<Record<string, readonly string[]>> = {
  npm: ["exec", "x"], pnpm: ["exec", "dlx"], yarn: ["exec", "dlx"], bun: ["x", "exec"],
};
/** Package runners whose option runs a command string through a shell: npx and npm exec `-c`/`--call`, pnpm's shell mode. */
function packageRunnerShell(program: string, args: readonly string[]): boolean {
  const call = (arg: string) => arg === "-c" || /^--call(?:=|$)/.test(arg);
  if (program === "npx") return args.some(call);
  if (program === "npm") return (args.includes("exec") || args.includes("x")) && args.some(call);
  if (program === "pnpm" || program === "pnpx") return args.some((arg) => arg === "-c" || /^--shell-mode(?:=|$)/.test(arg));
  return false;
}
/**
 * PowerShell's parameters that take a value, by the names and prefixes PowerShell accepts without ambiguity
 * (`powershell -?`, `pwsh -?`). An ambiguous short prefix (`-i` is Interactive in pwsh) is not listed, so its next
 * argument stays an argument: skipping a value wrongly could hide a command string.
 */
const POWERSHELL_VALUE_PARAMETERS = ["executionpolicy", "ep", "ex", "version", "psconsolefile", "windowstyle", "outputformat", "of",
  "inputformat", "if", "configurationname", "configurationfile", "settingsfile", "workingdirectory", "wd", "custompipename"];

/**
 * Why a reported check is a shell line, which the Runner does not run (§3.6): its executable holds a command line, an
 * argument is a shell operator (a pipe, `&&`, a redirection), or a shell is given a command string, also through a
 * wrapper (`env`, `timeout`, `nohup`, `sudo`, `xargs`, `setsid`, `flock`, `ionice`, `npx`, …) or a package manager's exec
 * subcommand (`yarn exec`, `bun x`, …), `wsl`, a `-c` command string (`su`, `script`, `flock`), or a package runner's
 * shell option (`npx -c`, `npm exec --call`, `pnpm --shell-mode`). Undefined when the check is one program and its
 * arguments.
 */
export function cliCheckShellLine(check: Pick<CliWorkerCheckV1, "executable" | "args">, depth = 0): string | undefined {
  const executable = check.executable.trim();
  // An absolute path may hold spaces and parentheses (C:\Program Files (x86)\…); a bare name holds neither.
  if (isAbsolute(executable) ? /[|;<>`]|&&/.test(executable) : /\s/.test(executable) || /[&|;<>`$()]/.test(executable)) {
    return "the executable holds a command line";
  }
  // An operator alone, or a stream redirection joined to its target (`2>/dev/null`). Any other argument that only
  // starts with `>`, `<` or `|` stays an argument (a range such as `>=1.2.3`, a pattern such as `<div`).
  const operator = check.args.find((arg) => SHELL_OPERATOR.test(arg.trim()) || /^[12]>/.test(arg.trim()));
  if (operator !== undefined) return `the argument ${JSON.stringify(operator.slice(0, 20))} is a shell operator`;
  const program = programName(executable);
  const given = `${program} is given a command string`;
  if (SHELL_RUNNERS.has(program)) return `${program} runs its arguments through a shell`;
  const trimmed = check.args.map((arg) => arg.trim());
  if (packageRunnerShell(program, trimmed)) return given;
  if (COMMAND_OPTION_PROGRAMS.has(program) &&
    trimmed.some((arg) => /^-[a-zA-Z]*c$/.test(arg) || /^--(?:session-)?command(?:=|$)/.test(arg))) return given;
  const subcommands = PACKAGE_EXEC_SUBCOMMANDS[program];
  if (subcommands) {
    // The package manager's options, its exec subcommand, the subcommand's options (and a package's name), then the
    // program it runs.
    const at = trimmed.findIndex((arg) => !arg.startsWith("-"));
    if (at >= 0 && subcommands.includes(trimmed[at]!)) {
      let index = at + 1;
      while (index < trimmed.length && trimmed[index]!.startsWith("-")) {
        const option = trimmed[index]!;
        index += option === "--" ? 1 : option === "-p" || option === "--package" ? 2 : 1;
        if (option === "--") break;
      }
      if (index < trimmed.length && depth < 4) return cliCheckShellLine({ executable: trimmed[index]!, args: trimmed.slice(index + 1) }, depth + 1);
    }
  }
  const wrapper = WRAPPERS[program];
  if (wrapper) {
    // The wrapper's options (and env's NAME=value assignments), then the program it runs; `env -S` splits a string itself.
    const args = check.args.map((arg) => arg.trim());
    if (program === "env" && args.some((arg) => /^-[a-zA-Z]*S|^--split-string/.test(arg))) return "env splits a command string";
    let index = 0;
    while (index < args.length) {
      const arg = args[index]!;
      if (arg === "--") { index += 1; break; }
      if (arg.startsWith("-") && arg.length > 1) { index += wrapper.values.includes(arg) ? 2 : 1; continue; }
      if (program === "env" && /^[A-Za-z_][A-Za-z0-9_]*=/.test(arg)) { index += 1; continue; }
      break;
    }
    index += wrapper.leading ?? 0;
    if (index >= args.length || depth >= 4) return undefined;
    return cliCheckShellLine({ executable: args[index]!, args: args.slice(index + 1) }, depth + 1);
  }
  if (program === "cmd") return check.args.some((arg) => /^\/[ck]/i.test(arg.trim())) ? given : undefined;
  if (program === "powershell" || program === "pwsh") return powershellCommand(program, check.args) ? given : undefined;
  if (POSIX_SHELLS.has(program)) {
    return check.args.some((arg) => /^-[a-z]*c[a-z]*$/i.test(arg.trim()) || /^--command(?:=|$)/i.test(arg.trim())) ? given : undefined;
  }
  return undefined;
}

/**
 * PowerShell runs a command string under `-Command`, `-EncodedCommand`, `-CommandWithArgs` or any prefix of them,
 * wherever it appears, and Windows PowerShell also under its first positional argument (pwsh's is `-File`, a script).
 */
function powershellCommand(program: "powershell" | "pwsh", args: readonly string[]): boolean {
  const flags = args.map((arg) => /^(?:--?|\/)([a-z]+)(:.*)?$/i.exec(arg.trim()));
  const isCommand = (name: string) => "command".startsWith(name) || "commandwithargs".startsWith(name) || name === "cwa" ||
    "encodedcommand".startsWith(name) || name === "ec";
  if (flags.some((flag) => flag && isCommand(flag[1]!.toLowerCase()))) return true;
  if (program !== "powershell") return false;
  for (let index = 0; index < args.length; index += 1) {
    const flag = flags[index];
    if (!flag) return true;
    const name = flag[1]!.toLowerCase();
    if ("file".startsWith(name)) return false;
    if (flag[2] === undefined && POWERSHELL_VALUE_PARAMETERS.some((parameter) => parameter === name || (name.length >= 3 && parameter.startsWith(name)))) index += 1;
  }
  return false;
}

/** A check that drives the browser through the Runner's Playwright CLI session (§3.10). */
function isBrowserCheck(check: Pick<CliWorkerCheckV1, "executable">): boolean {
  const program = programName(check.executable.trim());
  return program === "playwright-cli" || program === "playwright-cli-session";
}

function programName(executable: string): string {
  return (executable.split(/[\\/]/).at(-1) ?? executable).toLowerCase().replace(/\.(?:exe|cmd|bat|com|ps1)$/, "");
}

function bounded(text: string): string {
  const trimmed = text.trim();
  return trimmed.length <= TEXT_MAX ? trimmed : `${trimmed.slice(0, TEXT_MAX - 1)}…`;
}
