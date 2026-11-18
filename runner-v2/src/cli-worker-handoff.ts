/**
 * The handoff across a CLI boundary (docs/plans/2026-11-14-cli-workers.md §3.9, packet CW7).
 *
 * Failover keeps the task, the attempt, the worktree and the worker session. An API worker that takes over from another
 * API worker inherits the conversation, so it needs nothing here. Across a CLI boundary neither side can read the
 * other's conversation, so the Runner writes a handoff from what it holds:
 *
 * - the previous worker and why it stopped (the failure `failOver` recorded on the assignment it made, or the CLI's
 *   latest `worker.cli_attempt_recorded` event);
 * - its last assistant text or CLI summary from its own turn on the attempt, at most 2,000 characters, quoted line by
 *   line as the previous worker's claim;
 * - the changed files with line counts from `git diff --numstat <baseline>` in the worktree, and the files Git does not
 *   track yet: facts;
 * - the evidence ids the Runner recorded for this attempt: facts;
 * - "do not repeat completed work".
 *
 * API → CLI (and CLI → another CLI runtime): the CLI prompt's "Earlier work on this task" section, on the CLI's first
 * run after the switch only. CLI → API: one continuation message on the API worker's resume path. The same CLI runtime
 * again resumes its own recorded session (cli-worker-runtime.ts); one with no session of its own to resume after its
 * own earlier run starts fresh with the handoff section (§3.5 step 10).
 *
 * Reads only: Git inspection and the stores. Nothing here decides an outcome; a handoff that cannot read the worktree
 * says so and the attempt goes on.
 */

import type { AgentMessage } from "./agent-contracts.js";
import { CLI_WORKER_DISPLAY_NAMES } from "./cli-worker-adapters.js";
import { CLI_ATTEMPT_RECORDED_EVENT_TYPE, parseCliAttemptRecord, type CliAttemptRecord } from "./cli-worker-attempt-record.js";
import type { CliWorkerProviderId } from "./cli-worker-config.js";
import type { GitRunner } from "./git-repository.js";
import type { ProviderFailure, ProviderFailureKind } from "./provider-health.js";
import type { SchedulerEvent } from "./scheduler-store.js";
import { redactSensitiveText } from "./sensitive-redaction.js";

/** The previous worker's last text, as the handoff carries it (§3.9). */
export const HANDOFF_LAST_TEXT_MAX = 2_000;
const STOP_MESSAGE_MAX = 500;
const LABEL_MAX = 300;
const FILES_MAX = 200;
const EVIDENCE_IDS_MAX = 50;
const FAILURE_KINDS = new Set<ProviderFailureKind>(["usage_limit", "rate_limit", "authentication", "provider_unavailable", "transient", "invalid_request", "cancelled"]);

/**
 * Why the worker before this assignment stopped: the `handoff` field `failOver` writes on the `worker.runtime_assigned`
 * event that moves the attempt to another runtime. Durable, so a Runner restart between the failover and the next
 * worker's start still has it.
 */
export interface WorkerHandoffCause {
  fromRuntimeId: string;
  failureKind: ProviderFailureKind;
  /** The failure's message, redacted and bounded. */
  message: string;
}

export function workerHandoffCause(fromRuntimeId: string, failure: ProviderFailure): WorkerHandoffCause {
  return { fromRuntimeId, failureKind: failure.kind, message: bounded(redactSensitiveText(failure.message, STOP_MESSAGE_MAX * 2), STOP_MESSAGE_MAX) || "no message" };
}

/**
 * One runtime's turn on this attempt's worker session: from the `worker.runtime_assigned` event that gave it the
 * attempt to the next one. Its CLI records are the `worker.cli_attempt_recorded` events it wrote in that turn; why it
 * stopped is the cause on the next assignment.
 */
export interface AttemptWorkerSpan {
  runtimeId: string;
  cause?: WorkerHandoffCause;
  cliRecords: CliAttemptRecord[];
}

/** This attempt's worker spans for one worker session, oldest first. */
export function attemptWorkerSpans(
  events: readonly SchedulerEvent[],
  input: { taskId: string; attempt: number; sessionId: string },
): AttemptWorkerSpan[] {
  const spans: AttemptWorkerSpan[] = [];
  for (const event of events) {
    const payload = event.payload as Record<string, unknown>;
    if (payload?.taskId !== input.taskId || payload.attempt !== input.attempt || payload.sessionId !== input.sessionId) continue;
    if (event.type === "worker.runtime_assigned") {
      if (typeof payload.runtimeId !== "string") continue;
      const cause = parseCause(payload.handoff);
      const previous = spans.at(-1);
      if (previous && cause && cause.fromRuntimeId === previous.runtimeId) previous.cause = cause;
      spans.push({ runtimeId: payload.runtimeId, cliRecords: [] });
    } else if (event.type === CLI_ATTEMPT_RECORDED_EVENT_TYPE) {
      let record: CliAttemptRecord;
      try { record = parseCliAttemptRecord(payload); } catch { continue; }
      const current = spans.at(-1);
      if (current && record.runtimeId === current.runtimeId) current.cliRecords.push(record);
    }
  }
  return spans;
}

/**
 * The worker whose work the current runtime takes over, on the current runtime's first run after the switch: the
 * latest earlier span of another runtime that did run. A CLI that was assigned but never launched (it has no record) did
 * no work and is skipped. Undefined when there is none, when the latest worker that ran is the current runtime itself
 * (it resumes its own work), or when the current CLI already ran since the switch (its own later runs: guidance, a
 * restart, another Resume, get no handoff again).
 */
export function handoffPredecessor(
  spans: readonly AttemptWorkerSpan[],
  isCli: (runtimeId: string) => boolean,
): { span: AttemptWorkerSpan; index: number } | undefined {
  const current = spans.at(-1);
  if (!current || current.cliRecords.length > 0) return undefined;
  for (let index = spans.length - 2; index >= 0; index -= 1) {
    const span = spans[index]!;
    if (isCli(span.runtimeId) && span.cliRecords.length === 0) continue;
    return span.runtimeId === current.runtimeId ? undefined : { span, index };
  }
  return undefined;
}

/** The id of the handoff message the API worker of span `index` (0-based) got: one per span, so a resume adds none. */
export function handoffMessageId(taskId: string, attempt: number, index: number): string {
  return `worker-handoff:${taskId}:${attempt}:${index + 1}`;
}

/**
 * Where the API conversation of span `index` starts: the handoff message of the first API span after the latest CLI
 * that ran before it, or undefined when no CLI ran before it (the conversation from its start). API workers in a row
 * share one conversation, so their text is one span here.
 */
export function apiConversationStart(
  spans: readonly AttemptWorkerSpan[],
  index: number,
  isCli: (runtimeId: string) => boolean,
  ids: { taskId: string; attempt: number },
): string | undefined {
  for (let cli = index - 1; cli >= 0; cli -= 1) {
    if (spans[cli]!.cliRecords.length === 0) continue;
    for (let api = cli + 1; api <= index; api += 1) {
      if (!isCli(spans[api]!.runtimeId)) return handoffMessageId(ids.taskId, ids.attempt, api);
    }
  }
  return undefined;
}

/** The changed files in a task worktree against its baseline (facts the Runner read from Git). */
export interface WorktreeChanges {
  /** `added\tremoved\tpath` rows of `git diff --numstat <baseline>`; a binary file shows `-` for both counts. */
  numstat: string[];
  /** Files Git does not track yet, which `git diff` does not list. */
  untracked: string[];
}

export type WorktreeChangesReading = { status: "read"; changes: WorktreeChanges } | { status: "unavailable"; reason: string };

/** Reads the worktree's changes with read-only Git: no optional index lock, no diff program, no rename detection. */
export async function readWorktreeChanges(git: GitRunner, worktree: string, baseline: string): Promise<WorktreeChangesReading> {
  const env = { GIT_OPTIONAL_LOCKS: "0" };
  try {
    const [diff, others] = await Promise.all([
      git({ cwd: worktree, args: ["diff", "--numstat", "-z", "--no-renames", "--no-ext-diff", "--no-textconv", baseline, "--"], env, allowFailure: true }),
      git({ cwd: worktree, args: ["ls-files", "--others", "--exclude-standard", "-z"], env, allowFailure: true }),
    ]);
    if (diff.exitCode !== 0 || others.exitCode !== 0) {
      return { status: "unavailable", reason: bounded(redactSensitiveText(`git exited ${diff.exitCode !== 0 ? diff.exitCode : others.exitCode}: ${diff.stderr || others.stderr}`, 1_000), 300) };
    }
    const numstat = diff.stdout.split("\0").filter(Boolean).map((row) => {
      const [added = "?", removed = "?", ...path] = row.split("\t");
      return `${added}\t${removed}\t${displayPath(path.join("\t"))}`;
    });
    const untracked = others.stdout.split("\0").filter(Boolean).map(displayPath);
    return { status: "read", changes: { numstat, untracked } };
  } catch (error) {
    return { status: "unavailable", reason: bounded(redactSensitiveText(error instanceof Error ? error.message : String(error), 1_000), 300) };
  }
}

export interface WorkerHandoff {
  /** Who worked on this attempt before: "Claude Code worker claude-code:default", "API worker primary:code (model code)". */
  previousWorker: string;
  /** Why it stopped, as the Runner recorded it. */
  stopped: string;
  /** Its last assistant text or CLI summary: a claim. */
  lastText?: string;
  changes: WorktreeChangesReading;
  /** The evidence the Runner recorded for this attempt, oldest first. */
  evidenceIds: readonly string[];
}

/** The label of a CLI worker in a handoff. */
export function cliWorkerLabel(record: Pick<CliAttemptRecord, "providerId" | "runtimeId">): string {
  return bounded(`${CLI_WORKER_DISPLAY_NAMES[record.providerId]} worker ${record.runtimeId}`, LABEL_MAX);
}

/** The label of an API worker in a handoff. */
export function apiWorkerLabel(runtimeId: string, modelId?: string): string {
  return bounded(`API worker ${runtimeId}${modelId ? ` (model ${modelId})` : ""}`, LABEL_MAX);
}

/** Why a worker stopped, from the failure `failOver` recorded. */
export function describeHandoffCause(cause: Pick<WorkerHandoffCause, "failureKind" | "message">): string {
  return `${FAILURE_PHRASES[cause.failureKind]} (${cause.failureKind}): ${cause.message}`;
}

/** Why a CLI run ended, from its attempt record. */
export function describeCliRecordStop(record: CliAttemptRecord): string {
  if (record.outcome === "failure" && record.failureKind) {
    return describeHandoffCause({ failureKind: record.failureKind, message: bounded(record.summary ?? "no message", STOP_MESSAGE_MAX) });
  }
  if (record.outcome === "stopped") return `the Runner stopped it${record.stoppedBy ? ` (${record.stoppedBy})` : ""}`;
  return `its run ended with the outcome ${record.outcome}`;
}

/** A CLI record's summary, when it is the CLI's own report rather than a failure message. */
export function cliRecordLastText(record: CliAttemptRecord): string | undefined {
  return record.outcome === "failure" ? undefined : record.summary;
}

/**
 * The text of the newest assistant message that has any: the API worker's last words. With `afterMessageId`, only
 * messages after that one count (the worker's own part of the conversation); a missing start message means the worker
 * left nothing in the conversation.
 */
export function lastAssistantText(messages: readonly AgentMessage[], afterMessageId?: string): string | undefined {
  const start = afterMessageId === undefined ? -1 : messages.findIndex((message) => message.id === afterMessageId);
  if (afterMessageId !== undefined && start < 0) return undefined;
  for (let index = messages.length - 1; index > start; index -= 1) {
    const message = messages[index]!;
    if (message.role !== "assistant") continue;
    const text = typeof message.content === "string" ? message.content
      : Array.isArray(message.content)
        ? message.content.filter((block) => block.type === "text").map((block) => (block as { text: string }).text).join("\n")
        : "";
    if (text.trim()) return text;
  }
  return undefined;
}

/** The handoff's body: the previous worker, its claim, and the Runner's facts. */
export function renderWorkerHandoff(handoff: WorkerHandoff): string {
  const lines = [
    `The previous worker on this task attempt was the ${handoff.previousWorker}. It stopped: ${sentence(handoff.stopped)}`,
    "You continue its work in the same worktree; its changes are in place.",
    "",
  ];
  const lastText = handoff.lastText?.trim() ? lastTextForHandoff(handoff.lastText) : undefined;
  if (lastText) {
    // Every line of the claim is quoted, so nothing in it can read as one of the Runner's lines below.
    lines.push("What the previous worker wrote last, quoted line by line. This is its own claim; AIBoard has not checked it:",
      ...lastText.split(/\r?\n/).map((line) => `> ${line}`));
  } else {
    lines.push("The previous worker left no summary or text.");
  }
  lines.push("");
  if (handoff.changes.status === "unavailable") {
    lines.push(`The Runner could not read the worktree's changed files (${handoff.changes.reason}). Check them with git yourself.`);
  } else {
    const { numstat, untracked } = handoff.changes.changes;
    if (numstat.length === 0 && untracked.length === 0) {
      lines.push("Changed files (a fact the Runner read from Git): no file differs from the task's baseline.");
    } else {
      if (numstat.length > 0) {
        lines.push("Changed files against the task's baseline (facts the Runner read with `git diff --numstat <baseline>`: lines added, lines removed, path):");
        lines.push(...numstat.slice(0, FILES_MAX));
        if (numstat.length > FILES_MAX) lines.push(`… and ${numstat.length - FILES_MAX} more.`);
      }
      if (untracked.length > 0) {
        lines.push("New files Git does not track yet (facts the Runner read from Git):");
        lines.push(...untracked.slice(0, FILES_MAX));
        if (untracked.length > FILES_MAX) lines.push(`… and ${untracked.length - FILES_MAX} more.`);
      }
    }
  }
  lines.push("");
  if (handoff.evidenceIds.length === 0) {
    lines.push("Evidence (a fact the Runner holds): none is recorded for this attempt yet.");
  } else {
    const shown = handoff.evidenceIds.slice(-EVIDENCE_IDS_MAX);
    lines.push(`Evidence the Runner recorded for this attempt (facts): ${shown.join(", ")}${handoff.evidenceIds.length > shown.length ? ` (the newest ${shown.length} of ${handoff.evidenceIds.length})` : ""}.`);
  }
  lines.push("", "Do not repeat completed work: check the current files and evidence, then continue from there.");
  return lines.join("\n");
}

/** API → CLI and CLI → CLI: the body of the CLI prompt's "Earlier work on this task" section. */
export function earlierWorkSection(handoff: WorkerHandoff): string {
  return renderWorkerHandoff(handoff);
}

/** CLI → API: the one continuation message the API worker's resume path gets. */
export function cliHandoffContinuationMessage(id: string, handoff: WorkerHandoff): AgentMessage {
  return {
    id,
    role: "user",
    content: [
      "AIBoard handoff: another worker worked on this task attempt before you, and you take it over. You cannot read its conversation; this is what the Runner holds.",
      "",
      renderWorkerHandoff(handoff),
    ].join("\n"),
  };
}

/** What the driver gives the handoff: its reads of this attempt, each run only when a handoff is due. */
export interface WorkerHandoffSources {
  taskId: string;
  attempt: number;
  /** The runtime that runs now. */
  runtimeId: string;
  /** The scheduler events of the run, read once per handoff. */
  events: () => readonly SchedulerEvent[];
  sessionId: string;
  /** The CLI provider of a runtime that is a CLI worker; undefined for an API worker. */
  cliProvider: (runtimeId: string) => CliWorkerProviderId | undefined;
  /** An API runtime's model id, for its label. */
  modelId: (runtimeId: string) => string | undefined;
  /** The worker session's checkpointed conversation (the API workers' messages). */
  messages: () => Promise<readonly AgentMessage[]>;
  changes: () => Promise<WorktreeChangesReading>;
  /** This attempt's evidence ids, oldest first. */
  evidenceIds: () => readonly string[];
}

/**
 * The handoff on the first run of `runtimeId` after the attempt switched to it from another worker that ran, when
 * either side is a CLI. API → API gets none: the new worker inherits the conversation.
 */
export async function switchHandoff(sources: WorkerHandoffSources):
  Promise<{ handoff: WorkerHandoff; fromCli: boolean; id: string } | undefined> {
  const spans = attemptWorkerSpans(sources.events(), sources);
  if (spans.at(-1)?.runtimeId !== sources.runtimeId) return undefined;
  const isCli = (runtimeId: string) => sources.cliProvider(runtimeId) !== undefined;
  const previous = handoffPredecessor(spans, isCli);
  if (!previous) return undefined;
  const record = previous.span.cliRecords.at(-1);
  const fromCli = record !== undefined;
  if (!fromCli && !isCli(sources.runtimeId)) return undefined;
  const lastText = record ? cliRecordLastText(record)
    : lastAssistantText(await sources.messages(), apiConversationStart(spans, previous.index, isCli, sources));
  const handoff: WorkerHandoff = {
    previousWorker: record ? cliWorkerLabel(record) : apiWorkerLabel(previous.span.runtimeId, sources.modelId(previous.span.runtimeId)),
    stopped: previous.span.cause ? describeHandoffCause(previous.span.cause)
      : record ? describeCliRecordStop(record) : "the Runner holds no record of why",
    ...(lastText ? { lastText } : {}),
    changes: await sources.changes(),
    evidenceIds: sources.evidenceIds(),
  };
  return { handoff, fromCli, id: handoffMessageId(sources.taskId, sources.attempt, spans.length - 1) };
}

/**
 * §3.5 step 10: the handoff a CLI gets when it starts fresh after a run of its own on this attempt that left no CLI
 * session to resume. `relaunch` is a launch of its own that a Runner restart cut off before it was recorded.
 */
export async function freshRestartHandoff(sources: WorkerHandoffSources, relaunch: boolean): Promise<WorkerHandoff> {
  const own = attemptWorkerSpans(sources.events(), sources)
    .filter((span) => span.runtimeId === sources.runtimeId).flatMap((span) => span.cliRecords).at(-1);
  const providerId = own?.providerId ?? sources.cliProvider(sources.runtimeId);
  const label = providerId ? cliWorkerLabel({ providerId, runtimeId: sources.runtimeId }) : apiWorkerLabel(sources.runtimeId);
  const lastText = own ? cliRecordLastText(own) : undefined;
  return {
    previousWorker: `${label} (an earlier run of yours whose CLI session cannot be resumed, so you start a new one)`,
    stopped: relaunch ? "a Runner restart cut its last run off before the Runner recorded how it ended"
      : own ? describeCliRecordStop(own) : "the Runner holds no record of why",
    ...(lastText ? { lastText } : {}),
    changes: await sources.changes(),
    evidenceIds: sources.evidenceIds(),
  };
}

const FAILURE_PHRASES: Readonly<Record<ProviderFailureKind, string>> = Object.freeze({
  usage_limit: "it ran out of usage",
  rate_limit: "it was rate-limited",
  authentication: "its login or model setup failed",
  provider_unavailable: "its provider was unavailable",
  transient: "it failed without a usable result",
  invalid_request: "its request was refused",
  cancelled: "it was cancelled",
});

function lastTextForHandoff(text: string): string {
  const redacted = redactSensitiveText(text.trim(), HANDOFF_LAST_TEXT_MAX * 2).trim();
  return bounded(redacted, HANDOFF_LAST_TEXT_MAX);
}

function parseCause(value: unknown): WorkerHandoffCause | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const cause = value as Record<string, unknown>;
  if (typeof cause.fromRuntimeId !== "string" || typeof cause.message !== "string" || !FAILURE_KINDS.has(cause.failureKind as ProviderFailureKind)) return undefined;
  return { fromRuntimeId: cause.fromRuntimeId, failureKind: cause.failureKind as ProviderFailureKind, message: bounded(cause.message, STOP_MESSAGE_MAX) };
}

/** A path as one line: a control character would break the list, so such a path is shown JSON-quoted. */
function displayPath(path: string): string {
  return /[\u0000-\u001f\u007f]/.test(path) ? JSON.stringify(path) : path;
}

/** A stop description as one sentence: a message that already ends a sentence gets no second period. */
function sentence(text: string): string {
  return /[.!?…]$/.test(text) ? text : `${text}.`;
}

function bounded(text: string, limit: number): string {
  const trimmed = text.trim();
  return trimmed.length <= limit ? trimmed : `${trimmed.slice(0, limit - 1)}…`;
}
