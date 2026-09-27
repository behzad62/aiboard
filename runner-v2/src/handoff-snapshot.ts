/**
 * C1 — Handoff snapshot renderer (AR-R01, AR-R02).
 *
 * Pure, deterministic Markdown rendering of a run stop. No I/O, no clock, no
 * model, no randomness. The only runtime import is `node:crypto` (for the
 * body digest); every other import is `import type` and is erased at compile
 * time.
 *
 * Stop kinds (`completed | plan_only | paused | cancelled | failed |
 * `answered_export | in_progress`) come from the real run state, never from a
 * default: `projectHandoff.status === "requested"` renders `completed` (or
 * `plan_only` for a plan-only run) with the owner's handoff choice as the
 * next action; `failed` status renders `failed` with the recorded failure
 * reason whatever the triage or run policy; `stopped` renders `cancelled`;
 * a still-running run renders `in_progress`, never `completed`;
 * `answered_export` renders only when an answer is really recorded
 * (`requestAnswer` exists). A plan-only run that failed, was cancelled, is
 * paused or is still running renders that real outcome, not `plan_only`.
 *
 * Requirements come from the CURRENT plan revision when one exists (the
 * ledger only before any plan revision), matching the kernel gates. A
 * requirement counts as accepted only through a phase acceptance recorded
 * under the CURRENT revision's key (`planRevisionId` equals the current
 * revision id); a superseded revision's acceptance never counts.
 *
 * Open work lists the kernel's own unaccepted tasks: every scheduler task
 * except `final_verification` tasks and cancelled ones, without a task
 * acceptance, each with its REAL scheduler status (planned / running /
 * integrated / failed / …), including kernel repair tasks. Finding lines name
 * their task (`- <id> (task <taskId>): <claim>`) and tie-break
 * deterministically by task id, then finding id.
 *
 * Verification shows one line per final-verification category with that
 * check's own command(s), its own outcome and only its own counts; when only
 * some commands have reports, each command shows its own counts or
 * `not recorded`, position-aligned with the commands. A green
 * `not_applicable` category renders `not applicable (<rationale>)`, never a
 * pass; a `not_applicable` check with `green: false` is a red check and
 * renders `failed` with its rationale, never hidden. A missing count renders
 * `not recorded`, never 0. Planned categories with no completed check render
 * `pending`; a partial current generation never hides the other categories'
 * last history result (backfilled, marked stale). An `unknown` boundary
 * outcome renders `unknown`, never `failed`, with its recorded reason next
 * to `unknown`/`failed`. When no current generation exists, the last history
 * generation renders marked `stale (invalidated) at <revision>`. Boundary
 * checks render per check (`boundary <task> <check>`), each with its own
 * command, outcome and counts: the tests counts sit next to the tests
 * command, never the build command.
 *
 * Untrusted text can never open its own line or heading. Single-line fields
 * (ids, titles, commands, reasons, outcomes) collapse every line break and
 * other whitespace run to one space, drop C0/C1 controls and U+2028/U+2029,
 * then escape comment markers. Notes render as a blockquote (`> ` prefix on
 * every line, at most 30 lines / 2,000 chars) with the same removal, so forged
 * `## ` headings stay quoted text.
 *
 * Bounds: at most 200 lines / 16 KiB. NEVER truncated: the header; the exact
 * counts (open blocking findings, external blockers, exhausted repair issues,
 * unaccepted tasks, requirements by status); every external blocker with its
 * owner action; one line per final-verification category. Everything else may
 * truncate with an `N more — see AIBoard run <id>` line (a truncated note ends
 * with its own marker). The truncatable parts, lowest value first
 * (`SHRINK_STAGES`): accepted-task boundaries (collapsed into one summary
 * line), decisions, exhausted-issue lines, plan steps and criteria,
 * requirement rows, plan tasks, plan phases, finding lines, unaccepted-task
 * boundaries, open task lines, the notes, and the long caps on the source,
 * spec, pause-reason, notes-absent and next-action fields. Room is filled
 * highest value first, and each part keeps as many items as still fit.
 * Final-verification lines and then external blockers shrink only when the
 * never-truncated block alone, with every other part at its smallest
 * rendering, exceeds the cap; the exact counts always stay. A last-resort cut
 * ends with a visible `snapshot cut at the size cap` line, so over-cap output
 * is impossible and a cut is never silent.
 *
 * Body-digest rule (the C2 hand-edit check relies on this exact wording):
 * the rendered snapshot is `firstLine + "\n" + body`, where `firstLine` is
 * the exact `# AIBoard handoff snapshot — body_sha256: <hex>` line. `<hex>`
 * is the lowercase hex sha256 over the UTF-8 bytes of the body below the
 * header line AFTER normalizing line endings to LF (`\r\n` → `\n`, lone
 * `\r` → `\n`) and removing trailing whitespace at the very end. A verifier
 * normalizes the same way (so a Windows autocrlf checkout or an
 * editor-appended trailing newline does not look hand-edited), anchors the
 * header match to the exact generated first line, recomputes over that
 * substring and compares; any other hand edit below the header changes the
 * digest.
 */
import { createHash } from "node:crypto";
import type { FinalVerificationCompletedCheckProjection, ProjectHandoffChoice, SchedulerProjection } from "./scheduler-store.js";

export type HandoffStopKind =
  | "completed"
  | "plan_only"
  | "paused"
  | "cancelled"
  | "failed"
  | "answered_export"
  | "in_progress";

export type HandoffRequirementStatus =
  | "accepted"
  | "open"
  | "conditional_pending"
  | "not_applicable";

export interface HandoffSnapshotRequirement {
  readonly id: string;
  readonly outcome: string;
  readonly status: HandoffRequirementStatus;
  /** Authorized reason for not_applicable / conditional_pending. */
  readonly reason?: string;
}

export interface HandoffSnapshotTask {
  readonly id: string;
  readonly outcome: string;
  readonly status: string;
  readonly accepted: boolean;
}

export interface HandoffSnapshotFinding {
  readonly id: string;
  readonly taskId: string;
  readonly claim: string;
}

export interface HandoffSnapshotBlocker {
  readonly issueId: string;
  readonly requiredOwnerAction: string;
  readonly acceptanceCondition?: string;
}

export interface HandoffSnapshotExhaustedIssue {
  readonly issueId: string;
  readonly used: number;
  readonly limit: number;
}

export interface HandoffSnapshotVerificationEntry {
  /** For example "final verification tests" or "boundary T1 tests". */
  readonly label: string;
  readonly result: string;
  /** Real counts, for example "142 run, 0 failed"; "not recorded" when absent. */
  readonly counts: string;
  /** Exact build/test command; "not recorded" when absent. */
  readonly command: string;
  readonly revision: string;
  /**
   * True when this boundary line belongs to a task with a durable task
   * acceptance. The renderer collapses accepted-task boundaries into one
   * summary line before truncating anything else. Final-verification lines
   * never carry this flag and never collapse.
   */
  readonly taskAccepted?: boolean;
}

export interface HandoffSnapshotPlanTask {
  readonly id: string;
  readonly outcome: string;
  readonly phaseId: string;
  readonly dependencies: readonly string[];
  readonly steps: readonly string[];
  readonly criteria: readonly string[];
}

export interface HandoffSnapshotPlanPhase {
  readonly id: string;
  readonly purpose: string;
  readonly taskIds: readonly string[];
  readonly exitCriteria: readonly string[];
}

export interface HandoffSnapshotInput {
  readonly runId: string;
  /** The exact revision the snapshot describes; "not recorded" when unknown. */
  readonly revision: string;
  readonly stopKind: HandoffStopKind;
  readonly stopReason: string;
  /** Event time of the stop; "not recorded" when unknown. */
  readonly stopAt: string;
  readonly sourceTitle: string;
  readonly sourceDigest: string;
  /** Spec repo path or spec-copy path; "not recorded" when unknown. */
  readonly specPath: string;
  /**
   * Absent when the run has no requirement ledger and no plan revision: the
   * renderer then shows a task list instead of the requirement table.
   */
  readonly requirements?: readonly HandoffSnapshotRequirement[];
  readonly tasks: readonly HandoffSnapshotTask[];
  readonly openFindings: readonly HandoffSnapshotFinding[];
  readonly externalBlockers: readonly HandoffSnapshotBlocker[];
  readonly exhaustedRepairIssues: readonly HandoffSnapshotExhaustedIssue[];
  readonly verification: readonly HandoffSnapshotVerificationEntry[];
  /** planningDecisions plus acknowledged owner guidance, one line each. */
  readonly decisions: readonly string[];
  /** Architect notes (the complete_run summary at handoff). */
  readonly notes?: string;
  /** Required; used as "No Architect notes for this stop: <reason>". */
  readonly notesAbsentReason: string;
  readonly nextAction: string;
  /**
   * The recorded pause reason when a pause exists (a paused stop, or a pause
   * stacked on a handoff stop); absent otherwise. It is its own field so no
   * other text, such as a failure reason, can forge the `pause reason:` line.
   */
  readonly pauseReason?: string;
  /**
   * Present for plan-only runs (the plan is the product), with the revision's
   * real readiness (`ready` from the ready-plan identity, not a default).
   */
  readonly plan?: {
    readonly ready: boolean;
    readonly phases: readonly HandoffSnapshotPlanPhase[];
    readonly tasks: readonly HandoffSnapshotPlanTask[];
  };
}

/** Plain-data facts the projection does not hold, supplied by the caller. */
export interface HandoffSnapshotFacts {
  /** Event time of the stop (no stop timestamp exists in the projection). */
  readonly stopAt?: string;
  /** Exact build command used (from the execution profile / run evidence). */
  readonly buildCommand?: string;
  /** Exact test command used (from the execution profile / run evidence). */
  readonly testCommand?: string;
  /** Repo path of the approved spec or of its verbatim copy. */
  readonly specPath?: string;
  /** Overrides the default "no notes" reason. */
  readonly notesAbsentReason?: string;
}

export const HANDOFF_SNAPSHOT_MAX_LINES = 200;
export const HANDOFF_SNAPSHOT_MAX_BYTES = 16 * 1024;

/** Per-field cap for untrusted prose (notes use NOTES_MAX_LENGTH). */
export const HANDOFF_SNAPSHOT_FIELD_MAX_LENGTH = 500;
export const HANDOFF_SNAPSHOT_NOTES_MAX_LENGTH = 2000;
/** Notes blockquote cap: at most 30 lines (and NOTES_MAX_LENGTH chars). */
export const HANDOFF_SNAPSHOT_NOTES_MAX_LINES = 30;

const NOT_RECORDED = "not recorded";

/**
 * Neutralize untrusted text for prose: FIRST drop C0/C1 controls and
 * U+2028/U+2029 (keeping LF/CR for the cell mapper below), THEN escape
 * comment markers, cap length. The order matters: stripping first closes
 * the bypass where a control inside `<!--` or `-->` survived the escape
 * pass. Single-line and bullet rendering must use singleLine or
 * neutralizeSnapshotCell instead — this helper alone keeps newlines.
 */
export function neutralizeSnapshotText(value: string, maxLength: number = HANDOFF_SNAPSHOT_FIELD_MAX_LENGTH): string {
  const capped = value.length > maxLength ? value.slice(0, maxLength) : value;
  // Strip controls FIRST so a control planted inside a marker cannot bypass
  // the escape pass below (R2-B1); escape second.
  return capped
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u2028\u2029]/g, "")
    .replace(/<!--/g, "&lt;!--")
    .replace(/-->/g, "--&gt;");
}

/** Neutralize untrusted text for a Markdown table cell: as prose, plus pipe/newline escaping. */
export function neutralizeSnapshotCell(value: string, maxLength: number = HANDOFF_SNAPSHOT_FIELD_MAX_LENGTH): string {
  return neutralizeSnapshotText(value, maxLength)
    .replace(/\t/g, " ")
    .replace(/\|/g, "&#124;")
    .replace(/\r\n|\r|\n/g, "<br>");
}

/**
 * Single-line sanitizer for ids, titles, commands, reasons and outcomes:
 * every line break and other whitespace run becomes one space (untrusted text
 * can never open its own line or heading), C0/C1 controls and U+2028/U+2029
 * are removed, then the comment-marker escapes apply.
 */
function singleLine(value: string, maxLength: number = HANDOFF_SNAPSHOT_FIELD_MAX_LENGTH): string {
  const capped = value.length > maxLength ? value.slice(0, maxLength) : value;
  return capped
    .replace(/[\s\u0085]+/g, " ")
    .replace(/[\u0000-\u0008\u000B\u000E-\u001F\u007F-\u009F\u2028\u2029]/g, "")
    .replace(/<!--/g, "&lt;!--")
    .replace(/-->/g, "--&gt;");
}

/**
 * Render multi-line notes as a blockquote so no note line can be a heading.
 * Truncation is decided on the rendered text, so a truncated note always
 * ends with the visible marker. `maxLines` is the size budget's line allowance
 * (at most HANDOFF_SNAPSHOT_NOTES_MAX_LINES); fewer lines also end with the
 * marker.
 */
function renderNotesBlock(notes: string, runId: string, maxLines: number): string[] {
  const normalized = notes.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const rawLines = normalized.split("\n");
  let kept = rawLines.slice(0, HANDOFF_SNAPSHOT_NOTES_MAX_LINES).map((line) =>
    `> ${line
      .replace(/[\u0000-\u001F\u007F-\u009F\u2028\u2029]/g, "")
      .replace(/<!--/g, "&lt;!--")
      .replace(/-->/g, "--&gt;")}`,
  );
  let joined = kept.join("\n");
  // Decide truncation on the RENDERED length (the `> ` prefixes count), so
  // a note cut by the character cap still ends with the visible marker (n3).
  let truncated = rawLines.length > HANDOFF_SNAPSHOT_NOTES_MAX_LINES ||
    joined.length > HANDOFF_SNAPSHOT_NOTES_MAX_LENGTH;
  if (joined.length > HANDOFF_SNAPSHOT_NOTES_MAX_LENGTH) {
    joined = joined.slice(0, HANDOFF_SNAPSHOT_NOTES_MAX_LENGTH);
    kept = joined.split("\n");
  }
  if (kept.length > maxLines) {
    kept = kept.slice(0, Math.max(0, maxLines));
    truncated = true;
  }
  if (truncated) {
    kept.push(`> ... (truncated — see AIBoard run ${singleLine(runId, 120)})`);
  }
  return kept;
}

function orNotRecorded(value: string | undefined): string {
  return value === undefined || value.trim().length === 0 ? NOT_RECORDED : value;
}

/**
 * How much of each truncatable part renders. Every budget starts at its full
 * size, so an input that fits renders whole (n4).
 */
interface TruncationBudgets {
  /** 1 lists accepted-task boundaries; 0 collapses them into one summary line. */
  acceptedBoundaries: number;
  decisions: number;
  exhausted: number;
  /** Steps and criteria shown per plan task. */
  planSteps: number;
  requirements: number;
  /** Rows of the no-ledger `## Tasks` list (separate from the open-work task lines). */
  taskList: number;
  planTasks: number;
  planPhases: number;
  findings: number;
  unacceptedBoundaries: number;
  tasks: number;
  notesLines: number;
  /** 1 keeps the long caps on the source, spec, pause-reason, notes-absent and next-action fields; 0 uses short caps. */
  fullFixedFields: number;
  /** Never-truncated items: they shrink only after every earlier stage is at 0. */
  finalVerification: number;
  blockers: number;
}

/**
 * Budget stages, lowest value first. The last two hold never-truncated lines;
 * see `renderHandoffSnapshot` for how they are used.
 */
const SHRINK_STAGES: readonly (keyof TruncationBudgets)[] = [
  "acceptedBoundaries",
  "decisions",
  "exhausted",
  "planSteps",
  "requirements",
  "taskList",
  "planTasks",
  "planPhases",
  "findings",
  "unacceptedBoundaries",
  "tasks",
  "notesLines",
  "fullFixedFields",
  "finalVerification",
  "blockers",
];

/** Never-truncated stages, in the order they shrink when they alone do not fit. */
const PROTECTED_STAGES: readonly (keyof TruncationBudgets)[] = ["finalVerification", "blockers"];

/** Every other stage: these parts may truncate. */
const TRUNCATABLE_STAGES: readonly (keyof TruncationBudgets)[] = SHRINK_STAGES.filter(
  (stage) => !PROTECTED_STAGES.includes(stage),
);

/** Fill order, highest value first. */
const FILL_STAGES: readonly (keyof TruncationBudgets)[] = [...SHRINK_STAGES].reverse();

/** Short caps for the fixed prose fields once `fullFixedFields` is 0. */
const SHORT_FIXED_FIELD_LENGTH = 120;
const SHORT_NEXT_ACTION_LENGTH = 240;

function initialBudgets(input: HandoffSnapshotInput): TruncationBudgets {
  const fvEntries = input.verification.filter((entry) => entry.taskAccepted !== true);
  const unacceptedBoundaries = fvEntries.filter((entry) => entry.label.startsWith("boundary ")).length;
  const finalVerification = fvEntries.length - unacceptedBoundaries;
  let planSteps = 0;
  if (input.plan !== undefined) {
    for (const task of input.plan.tasks) {
      planSteps = Math.max(planSteps, task.steps.length, task.criteria.length);
    }
  }
  return {
    acceptedBoundaries: 1,
    decisions: input.decisions.length,
    exhausted: input.exhaustedRepairIssues.length,
    planSteps,
    requirements: input.requirements?.length ?? 0,
    taskList: input.requirements === undefined ? input.tasks.length : 0,
    planTasks: input.plan?.tasks.length ?? 0,
    planPhases: input.plan?.phases.length ?? 0,
    findings: input.openFindings.length,
    unacceptedBoundaries,
    tasks: input.tasks.length,
    notesLines: HANDOFF_SNAPSHOT_NOTES_MAX_LINES,
    fullFixedFields: 1,
    finalVerification,
    blockers: input.externalBlockers.length,
  };
}

function truncatedLine<T>(shown: readonly T[], total: number, runId: string): string | undefined {
  const more = total - shown.length;
  if (more <= 0) return undefined;
  return `${more} more — see AIBoard run ${singleLine(runId, 120)}`;
}

function byLabel(a: HandoffSnapshotVerificationEntry, b: HandoffSnapshotVerificationEntry): number {
  return a.label < b.label ? -1 : a.label > b.label ? 1 : 0;
}

/** Lower ranks are kept first when final-verification lines must truncate. */
function verificationKeepRank(entry: HandoffSnapshotVerificationEntry): number {
  if (entry.result.startsWith("failed")) return 0;
  if (entry.result.startsWith("unknown") || entry.result.startsWith("pending")) return 1;
  return 2;
}

function verificationLine(entry: HandoffSnapshotVerificationEntry): string {
  return `- ${singleLine(entry.label, 200)}: ${singleLine(entry.result, 200)}; counts: ${singleLine(entry.counts)}; command: ${singleLine(entry.command)}; revision: ${singleLine(entry.revision, 120)}`;
}

function byId<T extends { id: string }>(items: readonly T[]): T[] {
  return [...items].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

function requirementCounts(requirements: readonly HandoffSnapshotRequirement[]): string {
  let accepted = 0;
  let open = 0;
  let conditional = 0;
  let notApplicable = 0;
  for (const requirement of requirements) {
    if (requirement.status === "accepted") accepted += 1;
    else if (requirement.status === "open") open += 1;
    else if (requirement.status === "conditional_pending") conditional += 1;
    else notApplicable += 1;
  }
  return `${requirements.length} total (${accepted} accepted, ${open} open, ${conditional} conditional_pending, ${notApplicable} not_applicable)`;
}

function buildBody(input: HandoffSnapshotInput, budgets: TruncationBudgets): string[] {
  const lines: string[] = [];
  const fixedCap = budgets.fullFixedFields === 1 ? HANDOFF_SNAPSHOT_FIELD_MAX_LENGTH : SHORT_FIXED_FIELD_LENGTH;
  // Header (never truncated).
  lines.push(`generated by: AIBoard runner (handoff snapshot, docs policy v2)`);
  lines.push(`run: ${singleLine(input.runId, 120)}`);
  lines.push(`revision: ${singleLine(input.revision, 120)}`);
  lines.push(`stop: ${input.stopKind} — ${singleLine(input.stopReason)}`);
  lines.push(`stop at: ${singleLine(input.stopAt, 120)}`);
  lines.push(``);
  // What was asked.
  lines.push(`## What was asked`);
  lines.push(`source: ${singleLine(input.sourceTitle, fixedCap)} (digest ${singleLine(input.sourceDigest, 120)})`);
  lines.push(`spec: ${singleLine(input.specPath, fixedCap)}`);
  lines.push(``);
  // Requirements table, or the task list when there is no ledger and no plan revision.
  if (input.requirements !== undefined) {
    lines.push(`## Requirements`);
    lines.push(`requirements: ${requirementCounts(input.requirements)}`);
    lines.push(`| id | outcome | status |`);
    lines.push(`| --- | --- | --- |`);
    const ordered = byId(input.requirements);
    const shown = ordered.slice(0, budgets.requirements);
    for (const requirement of shown) {
      const status = requirement.status === "not_applicable" || requirement.status === "conditional_pending"
        ? `${requirement.status} (${singleLine(orNotRecorded(requirement.reason))})`
        : requirement.status;
      lines.push(`| ${neutralizeSnapshotCell(requirement.id, 120)} | ${neutralizeSnapshotCell(requirement.outcome)} | ${neutralizeSnapshotCell(status)} |`);
    }
    const more = truncatedLine(shown, ordered.length, input.runId);
    if (more !== undefined) lines.push(more);
    if (ordered.length === 0) lines.push(`no requirements recorded`);
    lines.push(``);
  } else {
    lines.push(`## Tasks (no requirement ledger)`);
    const ordered = [...input.tasks].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const shown = ordered.slice(0, budgets.taskList);
    for (const task of shown) {
      lines.push(`- ${singleLine(task.id, 120)}: ${singleLine(task.outcome)} [${singleLine(task.status, 120)}]`);
    }
    const more = truncatedLine(shown, ordered.length, input.runId);
    if (more !== undefined) lines.push(more);
    if (ordered.length === 0) lines.push(`no tasks recorded`);
    lines.push(``);
  }
  // Open work. The counts lines and the pause reason never truncate; the
  // lists below them truncate with exact N-more markers.
  lines.push(`## Open work`);
  const unacceptedTasks = [...input.tasks]
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .filter((task) => !task.accepted && task.status !== "cancelled");
  if (unacceptedTasks.length === 0) {
    lines.push(`unaccepted tasks: none`);
  } else {
    lines.push(`unaccepted tasks: ${unacceptedTasks.length} total`);
    const shownTasks = unacceptedTasks.slice(0, budgets.tasks);
    for (const task of shownTasks) {
      lines.push(`- ${singleLine(task.id, 120)}: ${singleLine(task.outcome)} [${singleLine(task.status, 120)}]`);
    }
    const more = truncatedLine(shownTasks, unacceptedTasks.length, input.runId);
    if (more !== undefined) lines.push(more);
  }
  const orderedFindings = [...input.openFindings].sort((a, b) =>
    a.taskId < b.taskId ? -1 : a.taskId > b.taskId ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
  );
  if (orderedFindings.length === 0) {
    lines.push(`open blocking findings: none`);
  } else {
    lines.push(`open blocking findings: ${orderedFindings.length} total`);
    const shownFindings = orderedFindings.slice(0, budgets.findings);
    for (const finding of shownFindings) {
      lines.push(`- ${singleLine(finding.id, 120)} (task ${singleLine(finding.taskId, 120)}): ${singleLine(finding.claim)}`);
    }
    const more = truncatedLine(shownFindings, orderedFindings.length, input.runId);
    if (more !== undefined) lines.push(more);
  }
  // External blockers never truncate until the never-truncate fallback:
  // the budget starts at the full size and shrinks last (after
  // final-verification lines), so the owner-action lines survive every
  // shrink that still leaves the never-truncated block within the cap.
  const orderedBlockers = [...input.externalBlockers].sort((a, b) => (a.issueId < b.issueId ? -1 : a.issueId > b.issueId ? 1 : 0));
  if (orderedBlockers.length === 0) {
    lines.push(`external blockers: none`);
  } else {
    lines.push(`external blockers: ${orderedBlockers.length} total`);
    const shownBlockers = orderedBlockers.slice(0, budgets.blockers);
    for (const blocker of shownBlockers) {
      const condition = blocker.acceptanceCondition !== undefined ? `; acceptance: ${singleLine(blocker.acceptanceCondition)}` : ``;
      lines.push(`- ${singleLine(blocker.issueId, 120)}: owner action: ${singleLine(blocker.requiredOwnerAction)}${condition}`);
    }
    const more = truncatedLine(shownBlockers, orderedBlockers.length, input.runId);
    if (more !== undefined) lines.push(more);
  }
  const orderedExhausted = [...input.exhaustedRepairIssues].sort((a, b) => (a.issueId < b.issueId ? -1 : a.issueId > b.issueId ? 1 : 0));
  if (orderedExhausted.length === 0) {
    lines.push(`exhausted repair issues: none`);
  } else {
    lines.push(`exhausted repair issues: ${orderedExhausted.length} total`);
    const shownExhausted = orderedExhausted.slice(0, budgets.exhausted);
    for (const issue of shownExhausted) {
      lines.push(`- ${singleLine(issue.issueId, 120)}: ${issue.used}/${issue.limit} cycles used`);
    }
    const more = truncatedLine(shownExhausted, orderedExhausted.length, input.runId);
    if (more !== undefined) lines.push(more);
  }
  lines.push(`pause reason: ${singleLine(pauseReasonText(input), fixedCap)}`);
  lines.push(``);
  // Verification. Final-verification lines never truncate until the
  // never-truncate fallback; accepted-task boundaries collapse into one
  // summary line once shrinking starts; unaccepted-task boundary checks
  // render exactly ONCE each, through their budget, with an N-more line.
  lines.push(`## Verification`);
  const fvEntries = input.verification.filter((entry) => entry.taskAccepted !== true);
  const acceptedBoundaryEntries = input.verification.filter((entry) => entry.taskAccepted === true);
  const finalVerificationEntries = fvEntries.filter((entry) => !entry.label.startsWith("boundary "));
  const boundaryEntries = fvEntries.filter((entry) => entry.label.startsWith("boundary "));
  // Sort before slicing so truncation never depends on input order; when
  // final-verification lines must truncate, red and undecided lines stay
  // first (r4 m8).
  const shownFv = [...finalVerificationEntries]
    .sort((a, b) => verificationKeepRank(a) - verificationKeepRank(b) || byLabel(a, b))
    .slice(0, budgets.finalVerification);
  const shownBoundaries = [...boundaryEntries].sort(byLabel).slice(0, budgets.unacceptedBoundaries);
  if (input.verification.length === 0) {
    lines.push(`no verification recorded`);
  } else {
    const orderedFv = [...shownFv].sort(byLabel);
    for (const entry of orderedFv) {
      lines.push(verificationLine(entry));
    }
    const fvMore = truncatedLine(shownFv, finalVerificationEntries.length, input.runId);
    if (fvMore !== undefined) lines.push(fvMore);
    if (budgets.acceptedBoundaries === 0 && acceptedBoundaryEntries.length > 0) {
      lines.push(`${acceptedBoundaryEntries.length} accepted-task boundaries — see AIBoard run ${singleLine(input.runId, 120)}`);
    } else {
      const orderedAccepted = [...acceptedBoundaryEntries].sort((a, b) => (a.label < b.label ? -1 : a.label > b.label ? 1 : 0));
      for (const entry of orderedAccepted) {
        lines.push(verificationLine(entry));
      }
    }
    const orderedUnaccepted = [...shownBoundaries].sort(byLabel);
    for (const entry of orderedUnaccepted) {
      lines.push(verificationLine(entry));
    }
    const unacceptedMore = truncatedLine(shownBoundaries, boundaryEntries.length, input.runId);
    if (unacceptedMore !== undefined) lines.push(unacceptedMore);
  }
  lines.push(``);
  // Decisions (lowest value: truncated first).
  lines.push(`## Decisions`);
  const orderedDecisions = [...input.decisions].sort();
  const shownDecisions = orderedDecisions.slice(0, budgets.decisions);
  if (shownDecisions.length === 0 && orderedDecisions.length === 0) {
    lines.push(`no decisions recorded`);
  } else {
    for (const decision of shownDecisions) {
      lines.push(`- ${singleLine(decision)}`);
    }
    const more = truncatedLine(shownDecisions, orderedDecisions.length, input.runId);
    if (more !== undefined) lines.push(more);
  }
  lines.push(``);
  // Notes slot: blockquoted so no note line can forge a heading.
  lines.push(`## Notes`);
  if (input.notes !== undefined) {
    for (const line of renderNotesBlock(input.notes, input.runId, budgets.notesLines)) lines.push(line);
  } else {
    lines.push(`No Architect notes for this stop: ${singleLine(input.notesAbsentReason, fixedCap)}`);
  }
  lines.push(``);
  lines.push(`## Next action`);
  lines.push(singleLine(input.nextAction, budgets.fullFixedFields === 1 ? 1000 : SHORT_NEXT_ACTION_LENGTH));
  // Plan view for plan-only runs, headed with the revision's real readiness.
  if (input.plan !== undefined) {
    lines.push(``);
    lines.push(`## Plan (${input.plan.ready ? "ready" : "not ready"})`);
    const orderedPhases = [...input.plan.phases].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const shownPhases = orderedPhases.slice(0, budgets.planPhases);
    for (const phase of shownPhases) {
      lines.push(`phase ${singleLine(phase.id, 120)}: ${singleLine(phase.purpose)}`);
      lines.push(`tasks: ${phase.taskIds.map((id) => singleLine(id, 120)).join(", ") || NOT_RECORDED}`);
      lines.push(`exit: ${phase.exitCriteria.map((criterion) => singleLine(criterion)).join("; ") || NOT_RECORDED}`);
    }
    const phasesMore = truncatedLine(shownPhases, orderedPhases.length, input.runId);
    if (phasesMore !== undefined) lines.push(phasesMore);
    const orderedPlanTasks = [...input.plan.tasks].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const shownPlanTasks = orderedPlanTasks.slice(0, budgets.planTasks);
    for (const task of shownPlanTasks) {
      lines.push(`task ${singleLine(task.id, 120)} (phase ${singleLine(task.phaseId, 120)}): ${singleLine(task.outcome)}`);
      lines.push(`depends on: ${task.dependencies.map((id) => singleLine(id, 120)).join(", ") || "none"}`);
      const shownSteps = task.steps.slice(0, budgets.planSteps);
      for (const step of shownSteps) lines.push(`step: ${singleLine(step)}`);
      const stepsMore = truncatedLine(shownSteps, task.steps.length, input.runId);
      if (stepsMore !== undefined) lines.push(`steps: ${stepsMore}`);
      const shownCriteria = task.criteria.slice(0, budgets.planSteps);
      for (const criterion of shownCriteria) lines.push(`criterion: ${singleLine(criterion)}`);
      const criteriaMore = truncatedLine(shownCriteria, task.criteria.length, input.runId);
      if (criteriaMore !== undefined) lines.push(`criteria: ${criteriaMore}`);
    }
    const more = truncatedLine(shownPlanTasks, orderedPlanTasks.length, input.runId);
    if (more !== undefined) lines.push(more);
  }
  return lines;
}

/**
 * Pause-reason text for the Open-work `pause reason:` line. It comes only from
 * the explicit `pauseReason` field (or, for a hand-built paused stop without
 * it, the stop reason); it is never parsed out of other text, so a failure
 * reason cannot forge it (r3 m5).
 */
function pauseReasonText(input: HandoffSnapshotInput): string {
  if (input.pauseReason !== undefined) return input.pauseReason;
  if (input.stopKind === "paused") {
    const prefix = `${input.stopKind} — `;
    if (input.stopReason.startsWith(prefix)) return input.stopReason.slice(prefix.length);
    return input.stopReason;
  }
  return "none";
}

/** Normalize a body for digesting: LF endings, no trailing end whitespace. */
function normalizeBody(body: string): string {
  // trimEnd() removes the same trailing set as /\s+$/ in linear time (n1:
  // the regex backtracks quadratically on a long whitespace run).
  return body.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trimEnd();
}

/**
 * Render the snapshot. Pure and deterministic: the same input always yields
 * byte-identical output (every list is sorted; truncation markers are
 * content-derived). Output is at most 200 lines and 16 KiB.
 *
 * Never-truncated lines shrink only when neither minimum configuration below
 * fits with all of them (r5 R5-B1, r6 R6-B1). Known limit (review r7 m16):
 * each part is at 0 or whole in those configurations, so a mixed trim could
 * sometimes still fit; reaching that needs dozens of external blockers.
 * 1. Two minimum configurations of the truncatable parts are built, one with
 *    the fewest bytes and one with the fewest lines: each part is at 0 items
 *    (with its `N more` line) or whole, whichever is smaller in that
 *    dimension (ties go to the other dimension). A short list can be smaller
 *    than its marker, and the cap has two dimensions, so one choice per part
 *    is not enough.
 * 2. If either configuration fits with every never-truncated line, it is the
 *    start. Only if neither fits do the never-truncated lines shrink, from the
 *    configuration closer to the cap: final-verification lines first,
 *    external blockers last, each keeping the most that fits; the exact
 *    counts always stay. If even that is over the cap, the last-resort cut
 *    ends with a visible marker line.
 * 3. Fill: in `FILL_STAGES` order (highest value first), the first part that
 *    can grow takes its whole content if it fits, else the most that fits,
 *    and the fill starts again from the highest value; it ends when no part
 *    can grow, so no part keeps room another part left.
 * Every accepted step renders within the cap, so the result always fits.
 */
export function renderHandoffSnapshot(input: HandoffSnapshotInput): string {
  const full = initialBudgets(input);
  const budgets: TruncationBudgets = { ...full };
  const render = (): string => withDigest(buildBody(input, budgets).join("\n"));
  const fits = (): boolean => fitsCap(render());
  if (fits()) return render();
  // 1. The fewest-bytes and the fewest-lines configurations.
  const byBytes = minimumConfiguration(input, full, "bytes");
  const byLines = minimumConfiguration(input, full, "lines");
  const renderWith = (candidate: TruncationBudgets): string => withDigest(buildBody(input, candidate).join("\n"));
  const start = fitsCap(renderWith(byBytes)) ? byBytes : fitsCap(renderWith(byLines)) ? byLines : undefined;
  if (start !== undefined) {
    Object.assign(budgets, start);
  } else {
    // 2. Never-truncated lines shrink only when they alone do not fit.
    Object.assign(budgets, capLoad(renderWith(byBytes)) <= capLoad(renderWith(byLines)) ? byBytes : byLines);
    for (const stage of PROTECTED_STAGES) {
      if (full[stage] === 0) continue;
      budgets[stage] = 0;
      if (fits()) {
        raiseBudget(budgets, stage, full[stage], fits);
        break;
      }
    }
    if (!fits()) return hardCap(render(), input.runId);
  }
  // 3. Fill, highest value first; after any growth start again from the top.
  for (let changed = true; changed;) {
    changed = false;
    for (const stage of FILL_STAGES) {
      if (budgets[stage] >= full[stage]) continue;
      const before = budgets[stage];
      raiseBudget(budgets, stage, full[stage], fits);
      if (budgets[stage] !== before) {
        changed = true;
        break;
      }
    }
  }
  return render();
}

/**
 * The truncatable parts at their minimum in one dimension of the cap: each
 * part is at 0 items or whole, whichever renders smaller in `primary` (ties
 * go to the other dimension). Never-truncated budgets stay full.
 */
function minimumConfiguration(
  input: HandoffSnapshotInput,
  full: TruncationBudgets,
  primary: "bytes" | "lines",
): TruncationBudgets {
  const candidate: TruncationBudgets = { ...full };
  const size = (): readonly [number, number] => {
    const output = withDigest(buildBody(input, candidate).join("\n"));
    const bytes = Buffer.byteLength(output, "utf8");
    const lines = linesOf(output);
    return primary === "bytes" ? [bytes, lines] : [lines, bytes];
  };
  for (const stage of TRUNCATABLE_STAGES) {
    if (full[stage] === 0) continue;
    const whole = size();
    candidate[stage] = 0;
    const empty = size();
    if (whole[0] < empty[0] || (whole[0] === empty[0] && whole[1] <= empty[1])) candidate[stage] = full[stage];
  }
  return candidate;
}

/** How close an output is to the cap: the larger of its line and byte shares. */
function capLoad(output: string): number {
  return Math.max(linesOf(output) / HANDOFF_SNAPSHOT_MAX_LINES, Buffer.byteLength(output, "utf8") / HANDOFF_SNAPSHOT_MAX_BYTES);
}

/**
 * Raise `budgets[stage]` from its current value (which fits) to the most, up
 * to `max`, that still fits. The whole part is tried first, because a list is
 * not monotone at its top end (at `max` its `N more` line disappears); below
 * the top a list grows with its budget, so the rest is a binary search.
 * `planSteps` is not monotone inside the range either (per-task marker lines
 * appear and disappear), so after the search it also tries a few values above
 * the result (r4 m6), a bounded number of renders (r5 m11).
 */
function raiseBudget(
  budgets: TruncationBudgets,
  stage: keyof TruncationBudgets,
  max: number,
  fits: () => boolean,
): void {
  const start = budgets[stage];
  if (start >= max) return;
  budgets[stage] = max;
  if (fits()) return;
  let low = start;
  let high = max - 1;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    budgets[stage] = mid;
    if (fits()) low = mid;
    else high = mid - 1;
  }
  if (stage === "planSteps") {
    for (let value = Math.min(max - 1, low + PLAN_STEPS_EXTRA_TRIES); value > low; value -= 1) {
      budgets[stage] = value;
      if (fits()) return;
    }
  }
  budgets[stage] = low;
}

/** Extra `planSteps` values tried above the binary-search result. */
const PLAN_STEPS_EXTRA_TRIES = 8;

function fitsCap(output: string): boolean {
  return linesOf(output) <= HANDOFF_SNAPSHOT_MAX_LINES && Buffer.byteLength(output, "utf8") <= HANDOFF_SNAPSHOT_MAX_BYTES;
}

function withDigest(body: string): string {
  const digest = createHash("sha256").update(normalizeBody(body), "utf8").digest("hex");
  return `# AIBoard handoff snapshot — body_sha256: ${digest}\n${body}`;
}

/**
 * Last-resort cut: reached only when the snapshot is still over the cap with
 * every stage at its minimum (for example when kernel ids and fixed fields are
 * very long). It drops trailing body lines and ends the body with a visible
 * `snapshot cut at the size cap` line, then recomputes the digest, so a cut
 * is never silent (r3 m4). The header and the exact counts lines at the top
 * survive.
 */
function hardCap(output: string, runId: string): string {
  const marker = `snapshot cut at the size cap — see AIBoard run ${singleLine(runId, 120)}`;
  let bodyLines = output.split("\n").slice(1);
  for (;;) {
    const candidate = withDigest([...bodyLines, marker].join("\n"));
    if (fitsCap(candidate) || bodyLines.length === 0) return candidate;
    bodyLines = bodyLines.slice(0, -1);
  }
}

function linesOf(output: string): number {
  return output.split("\n").length;
}

/** Recompute the header digest over the body below the header line. */
export function verifyHandoffSnapshotDigest(snapshot: string): boolean {
  const normalized = snapshot.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const newline = normalized.indexOf("\n");
  if (newline < 0) return false;
  const firstLine = normalized.slice(0, newline);
  const match = /^# AIBoard handoff snapshot — body_sha256: ([a-f0-9]{64})$/.exec(firstLine);
  if (!match) return false;
  const body = normalizeBody(normalized.slice(newline + 1));
  return createHash("sha256").update(body, "utf8").digest("hex") === match[1];
}

/**
 * Phase acceptances count only under the current revision id. The record
 * carries its own `planRevisionId` (keyed `${planRevisionId}:${phaseId}` by
 * the kernel's phaseAcceptanceKey); a superseded revision's acceptance never
 * accepts a current requirement. Inlined (no runtime import) to keep this
 * module pure.
 */
function acceptedRequirementIds(
  projection: SchedulerProjection,
  currentRevisionId: string | undefined,
): Set<string> {
  const accepted = new Set<string>();
  if (currentRevisionId === undefined) return accepted;
  const phaseAcceptances = projection.delivery?.phaseAcceptances;
  if (phaseAcceptances !== undefined) {
    for (const acceptance of Object.values(phaseAcceptances)) {
      if (acceptance.planRevisionId !== currentRevisionId) continue;
      for (const id of acceptance.requirementIds ?? []) accepted.add(id);
    }
  }
  return accepted;
}

function acceptedTaskIds(projection: SchedulerProjection): Set<string> {
  const accepted = new Set<string>();
  const taskAcceptances = projection.delivery?.taskAcceptances;
  if (taskAcceptances !== undefined) {
    for (const taskId of Object.keys(taskAcceptances)) accepted.add(taskId);
  }
  return accepted;
}

/**
 * One verification entry for a final-verification completed check. A green
 * `not_applicable` category renders `not applicable (<rationale>)`; a
 * `not_applicable` check with `green: false` is a red check and renders
 * `failed` with its rationale, never hidden (n8). Counts stay aligned with
 * their command: each command shows its own counts or `not recorded` (n10).
 */
function verificationEntryForCheck(
  check: FinalVerificationCompletedCheckProjection,
  suffix: string,
  revision: string,
): HandoffSnapshotVerificationEntry {
  if (check.status === "not_applicable" && check.green) {
    return {
      label: `final verification ${check.category}${suffix}`,
      result: `not applicable (${check.rationale ?? NOT_RECORDED})`,
      counts: NOT_RECORDED,
      command: NOT_RECORDED,
      revision,
    };
  }
  const commandFacts = check.facts.filter((fact): fact is typeof fact & { command: string; args: string[] } =>
    (fact as { kind: string }).kind === "command" &&
    typeof (fact as { command?: unknown }).command === "string");
  const command = commandFacts.length > 0
    ? commandFacts.map((fact) => `${fact.command} ${(fact.args ?? []).join(" ")}`.trim()).join("; ")
    : NOT_RECORDED;
  const counts = commandFacts.length === 0
    ? NOT_RECORDED
    : commandFacts.map((fact) => {
      const report = (fact as { report?: { executed?: number; failed?: number } }).report;
      if (report?.executed === undefined || report.failed === undefined) return NOT_RECORDED;
      return `${report.executed} run, ${report.failed} failed`;
    }).join("; ");
  const result = check.green
    ? "passed"
    : check.status === "not_applicable"
      ? `failed (not applicable: ${check.rationale ?? NOT_RECORDED})`
      : "failed";
  return {
    label: `final verification ${check.category}${suffix}`,
    result,
    counts,
    command,
    revision,
  };
}

/** The ready-plan identity the kernel gates on (inlined to stay pure). */
function readyRevisionId(projection: SchedulerProjection): string | undefined {
  if (projection.planningPolicyVersion !== 1) return undefined;
  const planning = projection.planning;
  if (planning?.readiness !== "ready" || !planning.plan) return undefined;
  if (!planning.plan.currentRevisionId || !planning.plan.currentDigest) return undefined;
  return planning.plan.currentRevisionId;
}

function isPlanOnlyRun(projection: SchedulerProjection): boolean {
  return projection.runPolicy === "plan_only";
}

/** True only when an answer is really recorded (not just triaged `answer`). */
function recordedAnswer(projection: SchedulerProjection): boolean {
  return projection.requestAnswer !== undefined;
}

/**
 * Build the renderer input from a projection rebuilt from real events, plus
 * plain-data facts the projection does not hold. Uses only fields that
 * really exist on the projection; anything missing renders "not recorded".
 *
 * Field provenance:
 * - runId: SchedulerProjection.runId; revision: integrationRevision.
 * - stop kind from the real run state, never a default: projectHandoff
 *   `requested` first (completed, or plan_only for a plan-only run); failed
 *   status (failed + failureReason, whatever the triage or run policy);
 *   stopped status (cancelled); a recorded answer (answered_export);
 *   running status (in_progress); paused (pauseReason); completed.
 * - source: planning.source manifestsById[currentManifestId] (sourceId stands
 *   in for the title: manifests carry no title field; artifactDigest is the
 *   digest). Spec path comes from facts (no spec path exists in projection).
 * - requirements: the CURRENT plan revision when one exists, else the ledger
 *   (only before any plan revision); accepted only by a phase acceptance
 *   under the current revision's key.
 * - tasks: every scheduler task except final_verification ones, with the real
 *   scheduler status; accepted means a task acceptance names the id
 *   (integrated alone never accepts). The renderer hides cancelled tasks
 *   from open work; kernel repair tasks stay listed with their real status.
 * - open blocking findings: delivery reviews filtered to blocking findings
 *   with no disposition (same rule as openBlockingFindings), each naming its
 *   review's task, sorted by task id then finding id.
 * - external blockers / exhausted issues: repairIssues.
 * - verification: the current final-verification generation (planned
 *   categories without a completed check render "pending"; uncovered
 *   categories backfill their last history result, marked stale), or the
 *   last history generation when there is no current one (marked
 *   stale (invalidated) at its revision); one line per category with that
 *   check's own commands, outcome and counts (per-command counts stay
 *   aligned; a missing count is "not recorded", never 0); a green
 *   not_applicable category renders "not applicable (<rationale>)", a red
 *   one renders failed with its rationale; plus the latest delivery
 *   boundary per task, one line per check with its own command, outcome
 *   (unknown stays unknown, with its recorded reason next to
 *   unknown/failed) and counts (tests counts only next to the tests
 *   command).
 * - decisions: current revision planningDecisions plus acknowledged owner
 *   guidance (userGuidance with status acknowledged).
 * - notes: projectHandoff.summary (the complete_run summary), blockquoted.
 * - next action: failed/cancelled from state; an external-blocker pause names
 *   the owner action; a required verifier/Architect selection names its
 *   owner action (select a verifier / an Architect runtime); otherwise
 *   resume (paused), the recorded handoff choice once selected (completed;
 *   the choice prompt only while requested), review-the-plan (plan_only),
 *   nothing (answered_export) or no-action-yet (in_progress). A pause
 *   stacked on a handoff stop keeps its pause reason on the pause line.
 * - plan: for plan-only runs with a revision, the plan view headed with the
 *   revision's real readiness (ready / not ready).
 */
export function handoffSnapshotInputFromProjection(
  projection: SchedulerProjection,
  facts: HandoffSnapshotFacts = {},
): HandoffSnapshotInput {
  const planning = projection.planning;
  const manifest = planning === undefined
    ? undefined
    : planning.source.manifestsById[planning.source.currentManifestId];
  const revisionRecord = planning?.plan === undefined
    ? undefined
    : planning.plan.revisionsById[planning.plan.currentRevisionId];
  const currentRevisionId = planning?.plan?.currentRevisionId;

  const planOnly = isPlanOnlyRun(projection);
  const handoffRequested = projection.projectHandoff?.status === "requested";
  const answerRecorded = recordedAnswer(projection);
  let stopKind: HandoffStopKind;
  let stopReason: string;
  if (projection.status === "failed") {
    stopKind = "failed";
    stopReason = projection.failureReason ?? NOT_RECORDED;
  } else if (projection.status === "stopped") {
    stopKind = "cancelled";
    stopReason = projection.failureReason ?? "run stopped";
  } else if (handoffRequested) {
    stopKind = planOnly ? "plan_only" : "completed";
    stopReason = `handoff ${projection.projectHandoff?.status ?? NOT_RECORDED}`;
    // A pause stacked on the handoff stop keeps its pause reason visible (n6).
    if (projection.pauseReason !== undefined) {
      stopReason += `; pause reason: ${projection.pauseReason.reason}${
        projection.pauseReason.detail !== undefined ? ` — ${projection.pauseReason.detail}` : ""}`;
    }
  } else if (answerRecorded) {
    stopKind = "answered_export";
    stopReason = "answered run — the answer stays in AIBoard, nothing is written to the project";
  } else if (planOnly && projection.status === "completed") {
    stopKind = "plan_only";
    stopReason = projection.projectHandoff !== undefined
      ? `handoff ${projection.projectHandoff.status}`
      : "plan completed — the plan is the product";
  } else if (projection.status === "running") {
    stopKind = "in_progress";
    stopReason = "run in progress";
  } else if (projection.status === "paused") {
    stopKind = "paused";
    // Pauses the reducer records without a pauseReason name their real cause:
    // a required verifier selection, or a required Architect runtime (n7).
    if (projection.pauseReason !== undefined) {
      stopReason = `${projection.pauseReason.reason}${
        projection.pauseReason.detail !== undefined ? ` — ${projection.pauseReason.detail}` : ""}`;
    } else if (projection.verifierSelection?.status === "required") {
      stopReason = `verifier selection required — ${projection.verifierSelection.reason}`;
    } else if (projection.runtime.architect.handoff !== undefined) {
      stopReason = `architect handoff required — ${projection.runtime.architect.handoff.reason}`;
    } else {
      stopReason = NOT_RECORDED;
    }
  } else {
    stopKind = "completed";
    stopReason = projection.projectHandoff !== undefined
      ? `handoff ${projection.projectHandoff.status}`
      : "run completed";
  }

  const acceptedRequirements = acceptedRequirementIds(projection, currentRevisionId);
  const ledgerRequirements = planning?.ledger?.requirements;
  const sourceRequirements = revisionRecord?.requirements ?? ledgerRequirements;
  const requirements: HandoffSnapshotRequirement[] | undefined = sourceRequirements?.map((requirement) => {
    if (requirement.applicability.status === "not_applicable") {
      const disposition = requirement.applicability.disposition;
      return {
        id: requirement.id,
        outcome: requirement.observableOutcome,
        status: "not_applicable" as const,
        reason: disposition !== undefined ? `${disposition.rationale} (authorized by ${disposition.authorizedBy})` : undefined,
      };
    }
    if (requirement.applicability.status === "conditional_pending") {
      return {
        id: requirement.id,
        outcome: requirement.observableOutcome,
        status: "conditional_pending" as const,
        reason: requirement.applicability.conditionExpression,
      };
    }
    return {
      id: requirement.id,
      outcome: requirement.observableOutcome,
      status: acceptedRequirements.has(requirement.id) ? ("accepted" as const) : ("open" as const),
    };
  });

  const acceptedTasks = acceptedTaskIds(projection);
  const tasks: HandoffSnapshotTask[] = Object.values(projection.tasks)
    .filter((task) => task.kind !== "final_verification")
    .map((task) => ({
      id: task.id,
      outcome: task.objective,
      status: task.status,
      accepted: acceptedTasks.has(task.id),
    }));

  const openFindings: HandoffSnapshotFinding[] = [];
  const reviews = projection.delivery?.reviews;
  if (reviews !== undefined) {
    for (const [taskId, review] of Object.entries(reviews)) {
      for (const finding of review.findings ?? []) {
        if (finding.severity === "blocking" && finding.disposition === undefined) {
          openFindings.push({ id: finding.id, taskId, claim: finding.claim });
        }
      }
    }
  }

  const externalBlockers: HandoffSnapshotBlocker[] = [];
  const exhaustedRepairIssues: HandoffSnapshotExhaustedIssue[] = [];
  for (const issue of Object.values(projection.repairIssues ?? {})) {
    if (issue.externalBlocker !== undefined) {
      externalBlockers.push({
        issueId: issue.issueId,
        requiredOwnerAction: issue.externalBlocker.requiredOwnerAction,
        acceptanceCondition: issue.externalBlocker.acceptanceCondition,
      });
    }
    if (issue.used >= issue.limit) {
      exhaustedRepairIssues.push({ issueId: issue.issueId, used: issue.used, limit: issue.limit });
    }
  }

  const verification: HandoffSnapshotVerificationEntry[] = [];
  const current = projection.finalVerification?.current;
  const history = projection.finalVerification?.history ?? [];
  if (current !== undefined) {
    const covered = new Set<string>();
    for (const check of current.completedChecks ?? []) {
      verification.push(verificationEntryForCheck(check, "", current.targetRevision));
      covered.add(check.category);
    }
    // Planned categories with no completed check render pending (n9).
    for (const planned of current.plan?.checks ?? []) {
      if (covered.has(planned.category)) continue;
      covered.add(planned.category);
      verification.push({
        label: `final verification ${planned.category}`,
        result: "pending",
        counts: NOT_RECORDED,
        command: NOT_RECORDED,
        revision: current.targetRevision,
      });
    }
    // A partial current generation must not hide the other categories' last
    // history result (n9): backfill uncovered categories from history, last
    // result first, marked with that generation's stale marker.
    for (let index = history.length - 1; index >= 0; index -= 1) {
      const past = history[index]!;
      const suffix = ` (stale (invalidated) at ${past.invalidatedByRevision ?? past.targetRevision})`;
      for (const check of past.completedChecks ?? []) {
        if (covered.has(check.category)) continue;
        covered.add(check.category);
        verification.push(verificationEntryForCheck(check, suffix, past.targetRevision));
      }
    }
  } else if (history.length > 0) {
    const generation = history[history.length - 1]!;
    const suffix = ` (stale (invalidated) at ${generation.invalidatedByRevision ?? generation.targetRevision})`;
    const covered = new Set<string>();
    for (const check of generation.completedChecks ?? []) {
      verification.push(verificationEntryForCheck(check, suffix, generation.targetRevision));
      covered.add(check.category);
    }
    for (const planned of generation.plan?.checks ?? []) {
      if (covered.has(planned.category)) continue;
      covered.add(planned.category);
      verification.push({
        label: `final verification ${planned.category}`,
        result: "pending",
        counts: NOT_RECORDED,
        command: NOT_RECORDED,
        revision: generation.targetRevision,
      });
    }
  }
  const boundaries = projection.delivery?.boundaries;
  if (boundaries !== undefined) {
    for (const [taskId, records] of Object.entries(boundaries)) {
      const latest = records[records.length - 1];
      if (latest === undefined) continue;
      for (const check of latest.checks) {
        const counts = check.checkId === "tests" && check.report?.counts !== undefined
          ? `${check.report.counts.selected} selected, ${check.report.counts.passed} passed, ${check.report.counts.failed} failed`
          : NOT_RECORDED;
        // A recorded reason travels next to unknown/failed outcomes (n10).
        const result = check.reason !== undefined && check.outcome !== "passed"
          ? `${check.outcome} (${check.reason})`
          : check.outcome;
        verification.push({
          label: `boundary ${taskId} ${check.checkId}`,
          result,
          counts,
          command: check.command !== undefined ? `${check.command} ${(check.args ?? []).join(" ")}`.trim() : NOT_RECORDED,
          revision: latest.integrationRevision,
          ...(acceptedTasks.has(taskId) ? { taskAccepted: true as const } : {}),
        });
      }
    }
  }

  const decisions: string[] = [];
  for (const decision of revisionRecord?.planningDecisions ?? []) {
    decisions.push(`${decision.id}: ${decision.description}`);
  }
  for (const guidance of Object.values(projection.userGuidance)) {
    if (guidance.status === "acknowledged") {
      decisions.push(`owner guidance ${guidance.guidanceId} (acknowledged): ${guidance.text}`);
    }
  }

  const notes = projection.projectHandoff?.summary;
  const pauseIssueId = projection.status === "paused" && projection.pauseReason !== undefined
    ? /^repair_issue_paused:(.+)$/.exec(projection.pauseReason.reason)?.[1]
    : undefined;
  const pauseBlocker = pauseIssueId !== undefined
    ? externalBlockers.find((blocker) => blocker.issueId === pauseIssueId)
    : undefined;
  // A required verifier/Architect selection names its owner action (n7).
  let selectionOwnerAction: string | undefined;
  if (projection.status === "paused") {
    if (projection.verifierSelection?.status === "required") {
      selectionOwnerAction =
        `select a verifier runtime (${projection.verifierSelection.candidateRuntimeIds.join(", ")})`;
    } else if (projection.runtime.architect.handoff !== undefined) {
      selectionOwnerAction =
        `select an Architect runtime (${projection.runtime.architect.handoff.candidateRuntimeIds.join(", ")})`;
    }
  }
  // A requested handoff always names the owner's handoff choice (completed
  // and plan_only alike). Once the owner has chosen, the next action follows
  // the recorded choice instead of the choice prompt (n2) — except for a
  // plan-only run, where reviewing the plan still comes first. Otherwise the
  // next action derives from the stop.
  const nextAction = handoffRequested
    ? "owner chooses apply_to_project or keep_integration_branch"
    : projection.projectHandoff?.status === "selected" && !planOnly
      ? selectedHandoffNextAction(projection.projectHandoff.choice)
      : deriveNextAction(stopKind, stopReason, pauseBlocker?.requiredOwnerAction ?? selectionOwnerAction);

  const readyId = readyRevisionId(projection);
  // The pause line comes from the recorded pause only (r3 m5): a paused stop's
  // own reason, or the pause stacked on a handoff stop.
  const recordedPause = projection.pauseReason !== undefined
    ? `${projection.pauseReason.reason}${projection.pauseReason.detail !== undefined ? ` — ${projection.pauseReason.detail}` : ""}`
    : undefined;
  const pauseReason = stopKind === "paused"
    ? stopReason
    : stopKind === "failed" || stopKind === "cancelled" ? undefined : recordedPause;
  return {
    runId: projection.runId,
    revision: projection.integrationRevision ?? NOT_RECORDED,
    stopKind,
    stopReason,
    stopAt: facts.stopAt ?? NOT_RECORDED,
    sourceTitle: manifest?.sourceId ?? NOT_RECORDED,
    sourceDigest: manifest?.artifactDigest ?? NOT_RECORDED,
    specPath: facts.specPath ?? NOT_RECORDED,
    requirements,
    tasks,
    openFindings,
    externalBlockers,
    exhaustedRepairIssues,
    verification,
    decisions,
    ...(notes !== undefined ? { notes } : {}),
    notesAbsentReason: facts.notesAbsentReason
      ?? (notes !== undefined ? "" : "no handoff summary recorded for this stop"),
    nextAction,
    ...(pauseReason !== undefined ? { pauseReason } : {}),
    ...(planOnly && revisionRecord !== undefined
      ? {
        plan: {
          ready: readyId !== undefined && readyId === revisionRecord.revisionId,
          phases: revisionRecord.phases.map((phase) => ({
            id: phase.id,
            purpose: phase.purpose,
            taskIds: [...phase.contributingTaskIds],
            exitCriteria: [...phase.exitCriteria],
          })),
          tasks: revisionRecord.tasks.map((task) => ({
            id: task.id,
            outcome: task.outcome.user,
            phaseId: task.accountablePhaseId,
            dependencies: [...task.dependencies],
            steps: [...task.steps],
            criteria: task.acceptance.criteria.map((criterion) => criterion.text),
          })),
        },
      }
      : {}),
  };
}

/** Next action once the owner has chosen a handoff option (n2). */
function selectedHandoffNextAction(choice: ProjectHandoffChoice | undefined): string {
  if (choice === "apply_to_project") {
    return "handoff apply_to_project selected — apply the integration revision to the project";
  }
  if (choice === "keep_integration_branch") {
    return "handoff keep_integration_branch selected — continue from the integration branch";
  }
  return `handoff selected (${NOT_RECORDED}) — confirm the handoff choice`;
}

function deriveNextAction(stopKind: HandoffStopKind, stopReason: string, ownerAction: string | undefined): string {
  if (stopKind === "failed") return `inspect the failure (${stopReason}) and repair or escalate`;
  if (stopKind === "cancelled") return `the run was cancelled (${stopReason}); restart the run or close it out`;
  if (ownerAction !== undefined) return `owner action required: ${ownerAction}`;
  if (stopKind === "paused") return `resume the run (${stopReason})`;
  if (stopKind === "completed") return "owner chooses apply_to_project or keep_integration_branch";
  if (stopKind === "plan_only") return "review the plan, then start the build";
  if (stopKind === "answered_export") return "nothing to do — the answer stays in AIBoard";
  if (stopKind === "in_progress") return "no action yet — the run is still in progress";
  return "continue the run";
}
