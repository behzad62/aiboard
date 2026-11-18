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
 * - Each re-run's timeout is the task's remaining validation budget, capped at ten minutes.
 * - Files a re-run changed are restored afterwards, so the tree the Runner submits is the one the CLI left.
 *
 * Which gaps send the CLI into its one fix round (CWD-3), and which fail the attempt, is decided by the CLI loop
 * (cli-worker-runtime.ts) from `cliCheckGaps`.
 */

import { randomUUID } from "node:crypto";
import { isAbsolute, resolve } from "node:path";

import type { AcceptanceCriterion, CriterionEvidenceLink } from "./acceptance-contracts.js";
import type { ToolResult } from "./agent-contracts.js";
import type { ArtifactStore } from "./artifact-store.js";
import type { BudgetLedger } from "./budget-ledger.js";
import type { CheckToolLookup } from "./check-tool-lookup.js";
import type { CliCheckRerunner } from "./cli-worker-runtime.js";
import type { CliWorkerCheckV1 } from "./cli-worker-result.js";
import type { WorkingTreeIdentity } from "./command-evidence-identity.js";
import type { PermissionProfile } from "./contracts.js";
import { evidenceFactArtifactHashes, RUNNER_RERUN_OF_CLI_CLAIM, type EvidenceRecord, type EvidenceStore } from "./evidence-store.js";
import { createEvidenceTools } from "./evidence-tools.js";
import type { ExecutionGrantAuthority } from "./execution-grants.js";
import type { RunGitExecutionContext } from "./git-run-context.js";
import type { OneShotCommandExecutor } from "./one-shot-command-executor.js";
import { redactSensitiveText } from "./sensitive-redaction.js";
import { ToolBroker } from "./tool-broker.js";
import type { ToolInvocationLedger } from "./tool-ledger.js";
import { summarizeValidationBudget } from "./validation-budget.js";

/** §3.6: one re-run never waits longer than this, whatever validation budget is left. */
export const CLI_RERUN_TIMEOUT_CAP_MS = 10 * 60_000;
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
  evidenceId?: string;
  artifactHashes?: string[];
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
  /** Puts the working files back to a captured tree; returns the paths it restored. */
  restoreTree: (cwd: string, treeId: string) => Promise<string[]>;
  allowedCommands?: readonly string[];
  hiddenPaths?: readonly string[];
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
    const before = await options.captureTree(workspace.path);
    if (before.status !== "known") throw new CliCheckRerunError("The worktree's files could not be read before the re-runs, so they could not be restored after them.");
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
      const remaining = remainingValidationMs(options.budgetLedger, owner.runId, taskId, submission.validationBudgetMs);
      if (remaining <= 0) {
        reruns.push(notRun("validation_budget_spent", `not re-run: the task's validation budget (${Math.round(submission.validationBudgetMs / 1000)} s) is spent`));
        continue;
      }
      const timeoutMs = Math.max(1, Math.floor(Math.min(remaining, CLI_RERUN_TIMEOUT_CAP_MS)));
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
      reruns.push(rerunFromResult(base, output, options.evidenceStore, owner.runId, taskId, timeoutMs, notRun));
    }

    const after = await options.captureTree(workspace.path);
    if (after.status !== "known") throw new CliCheckRerunError("The worktree's files could not be read after the re-runs, so the submitted tree could not be proven to be the one the CLI left.");
    let restoredPaths: string[] = [];
    if (after.treeId !== before.treeId) {
      try {
        restoredPaths = await options.restoreTree(workspace.path, before.treeId);
      } catch (error) {
        throw new CliCheckRerunError(`A re-run changed the worktree's files and they could not be restored: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return {
      criterionEvidenceLinks: cliCheckEvidenceLinks(submission.acceptanceCriteria, reruns, taskId, attempt),
      notRun: reruns.filter((rerun) => rerun.status === "not_run").map((rerun) => ({ what: `${rerun.label}: ${rerun.command}`, why: rerun.detail })),
      reruns,
      restoredPaths,
    };
  };
}

function rerunFromResult(
  base: Pick<CliCheckRerun, "label" | "command" | "criterionIds">,
  output: ToolResult,
  store: EvidenceStore,
  runId: string,
  taskId: string,
  timeoutMs: number,
  notRun: (reason: CliCheckNotRunReason, detail: string) => CliCheckRerun,
): CliCheckRerun {
  if (output.isError) {
    if (output.error?.code === "tool_cancelled") return notRun("cancelled", "not re-run: the attempt was cancelled");
    return notRun("refused", `not re-run: ${output.error?.code ?? "refused"}: ${output.error?.message ?? "the Runner refused the command"}`);
  }
  const view = output.content.find((block) => block.type === "json")?.value as { id?: unknown } | undefined;
  const id = typeof view?.id === "string" ? view.id : undefined;
  const record: EvidenceRecord | undefined = id ? store.getByIds({ runId, taskId, ids: [id] }).find((candidate) => candidate.id === id) : undefined;
  if (!record || record.fact.kind !== "command") return notRun("refused", "not re-run: the Runner recorded no evidence for the command");
  const fact = record.fact;
  if (fact.cancelled) return notRun("cancelled", "not re-run: the attempt was cancelled");
  const passed = fact.exitCode === 0 && !fact.timedOut && fact.signal === null;
  const detail = fact.timedOut ? `timed out after ${Math.round(timeoutMs / 1000)} s`
    : fact.signal ? `stopped by signal ${fact.signal}` : `exit ${fact.exitCode ?? "unknown"}`;
  const tail = passed ? undefined : outputTail(output);
  return {
    ...base,
    status: passed ? "passed" : "failed",
    detail,
    evidenceId: record.id,
    artifactHashes: evidenceFactArtifactHashes(fact),
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

/** Each criterion's link: the first passing re-run the CLI linked to it. Unknown criterion ids are left out. */
export function cliCheckEvidenceLinks(
  criteria: readonly AcceptanceCriterion[] | undefined,
  reruns: readonly CliCheckRerun[],
  taskId: string,
  attempt: number,
): CriterionEvidenceLink[] {
  if (!criteria) return [];
  const links: CriterionEvidenceLink[] = [];
  for (const criterion of criteria) {
    const rerun = reruns.find((candidate) => candidate.status === "passed" && candidate.evidenceId && candidate.artifactHashes?.length &&
      candidate.criterionIds.includes(criterion.id));
    if (rerun) links.push({ criterionId: criterion.id, evidenceId: rerun.evidenceId!, artifactHashes: [...rerun.artifactHashes!], taskId, attempt });
  }
  return links;
}

export interface CliCheckGaps {
  /** Criteria no passing re-run supports; with no criteria, the task itself when no re-run passed. */
  unsupported: { id: string; text: string }[];
  failing: CliCheckRerun[];
}

/**
 * §3.6: what keeps a CLI's `done` from being submitted: a criterion with no linked passing re-run, or any re-run that
 * failed. A check that was not run (a missing tool, a shell line) is never a failure; it leaves its criteria unsupported
 * unless another passing re-run supports them.
 */
export function cliCheckGaps(
  criteria: readonly AcceptanceCriterion[] | undefined,
  rerun: { criterionEvidenceLinks: readonly CriterionEvidenceLink[]; reruns?: readonly CliCheckRerun[] },
): CliCheckGaps {
  const failing = (rerun.reruns ?? []).filter((candidate) => candidate.status === "failed");
  if (!criteria) {
    const passed = (rerun.reruns ?? []).some((candidate) => candidate.status === "passed");
    return { unsupported: passed ? [] : [{ id: "task", text: "at least one check of the task's work" }], failing };
  }
  const linked = new Set(rerun.criterionEvidenceLinks.map((link) => link.criterionId));
  return { unsupported: criteria.filter((criterion) => !linked.has(criterion.id)).map((criterion) => ({ id: criterion.id, text: criterion.text })), failing };
}

export function hasCliCheckGaps(gaps: CliCheckGaps): boolean {
  return gaps.unsupported.length > 0 || gaps.failing.length > 0;
}

/** The attempt's failure when the gap remains after the fix round (§3.6): failing re-runs first, then missing support. */
export function cliCheckGapFailure(name: string, gaps: CliCheckGaps): string {
  const failing = gaps.failing.map((rerun) => `${rerun.label} (${rerun.command}: ${rerun.detail})`).join("; ");
  const unsupported = gaps.unsupported.map((criterion) => `${criterion.id}: ${criterion.text}`).join("; ");
  const text = gaps.failing.length > 0
    ? `${CLI_CHECKS_FAILING}: after its fix round, the Runner's re-runs of ${name}'s checks still fail: ${failing}.${unsupported ? ` Criteria without a passing re-run: ${unsupported}.` : ""}`
    : `${CLI_CHECKS_UNSUPPORTED}: after its fix round, no passing re-run of ${name}'s checks supports: ${unsupported}.`;
  return text.length <= 2_000 ? text : `${text.slice(0, 1_999)}…`;
}

/**
 * The fix round's prompt (§3.5 step 1, §3.6): the re-run results and the missing criteria, for the CLI's resumed
 * session. The CLI loop wraps it in the worker rules (buildCliWorkerPrompt).
 */
export function cliFixRoundPrompt(input: { name: string; gaps: CliCheckGaps; reruns: readonly CliCheckRerun[]; restoredPaths: readonly string[] }): string {
  const lines = [
    "## Fix round: the Runner's re-runs of your checks",
    `AIBoard re-ran the checks you reported, in this worktree as you left it. Only these re-runs count as evidence. Your work is not submitted yet: this is your one fix round.`,
    "",
    "### Re-run results",
    ...(input.reruns.length
      ? input.reruns.map((rerun) => `- ${rerun.label} (\`${rerun.command}\`): ${rerun.status === "passed" ? "passed" : rerun.status === "failed" ? `failed, ${rerun.detail}` : rerun.detail}` +
        `${rerun.criterionIds.length ? ` [criteria: ${rerun.criterionIds.join(", ")}]` : " [no criteria]"}` +
        `${rerun.outputTail ? `\n  Output tail:\n${indent(rerun.outputTail)}` : ""}`)
      : ["- You reported no checks."]),
  ];
  if (input.gaps.unsupported.length) {
    lines.push("", "### Criteria without a passing re-run",
      ...input.gaps.unsupported.map((criterion) => `- ${criterion.id}: ${criterion.text}`),
      "Report, for each of them, a check that supports it, with its id in criterionIds.");
  }
  if (input.gaps.failing.length) lines.push("", "Fix what makes the failing checks fail (never by weakening a test), then run them again yourself.");
  if (input.reruns.some((rerun) => rerun.notRunReason === "shell_line")) {
    lines.push("", "Some checks were shell lines (&&, pipes, redirection, or a shell given a command string) and were not run. Report each check as one program and its arguments.");
  }
  if (input.reruns.some((rerun) => rerun.notRunReason === "tool_missing")) {
    lines.push("", "A check whose program is not installed on this PC was not run. That is not a failure, but it supports nothing: support its criteria with a check this PC can run.");
  }
  if (input.restoredPaths.length) {
    lines.push("", `A re-run changed files in the worktree; the Runner put them back as you left them: ${input.restoredPaths.slice(0, 20).join(", ")}${input.restoredPaths.length > 20 ? ` (+${input.restoredPaths.length - 20} more)` : ""}.`);
  }
  lines.push("", "Then end your turn with the JSON result again. List in checks every check the Runner should run again, each with the criterion ids it supports.");
  return lines.join("\n");
}

function indent(text: string): string {
  return text.split(/\r?\n/).map((line) => `    ${line}`).join("\n");
}

const SHELL_OPERATOR = /^(?:&&|\|\||\||;|&|>|>>|<|<<|<<<|[12]>|[12]>>|2>&1|1>&2|&>|&>>)$/;
const SHELL_PROGRAMS = new Set(["sh", "bash", "zsh", "dash", "ksh", "fish", "cmd", "powershell", "pwsh"]);

/**
 * Why a reported check is a shell line, which the Runner does not run (§3.6): its executable holds a command line, an
 * argument is a shell operator (a pipe, `&&`, a redirection), or a shell is given a command string. Undefined when the
 * check is one program and its arguments.
 */
export function cliCheckShellLine(check: Pick<CliWorkerCheckV1, "executable" | "args">): string | undefined {
  const executable = check.executable.trim();
  // An absolute path may hold spaces and parentheses (C:\Program Files (x86)\…); a bare name holds neither.
  if (isAbsolute(executable) ? /[|;<>`]|&&/.test(executable) : /\s/.test(executable) || /[&|;<>`$()]/.test(executable)) {
    return "the executable holds a command line";
  }
  // An operator alone, or an output redirection or pipe joined to its target (`>out.txt`, `2>/dev/null`, `|tee`). An
  // argument that only starts with `<` stays an argument (a pattern such as `<div`).
  const operator = check.args.find((arg) => SHELL_OPERATOR.test(arg.trim()) || /^(?:[12]?>{1,2}|\|)/.test(arg.trim()));
  if (operator !== undefined) return `the argument ${JSON.stringify(operator.slice(0, 20))} is a shell operator`;
  const program = programName(executable);
  if (SHELL_PROGRAMS.has(program)) {
    const commandFlag = program === "cmd" ? /^\/[ck]$/i : program === "powershell" || program === "pwsh" ? /^-(?:c|command|e|ec|encodedcommand)$/i : /^-[a-z]*c[a-z]*$/i;
    if (check.args.some((arg) => commandFlag.test(arg))) return `${program} is given a command string`;
  }
  return undefined;
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
