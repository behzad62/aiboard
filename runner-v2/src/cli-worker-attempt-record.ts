/**
 * The durable record of one CLI worker run (docs/plans/2026-11-14-cli-workers.md §3.5 step 6, §3.11 case 2, packet
 * CW5): the scheduler event `worker.cli_attempt_recorded`.
 *
 * - `collected: true`: the Runner proved the CLI's processes stopped and collected what it did (undid its commits,
 *   restored `docs/project`, compared the project folder). The outcome follows from the CLI's report.
 * - `collected: false`: the CLI delivered its result or exited, but the stop that follows was not proven, so nothing
 *   was collected. The record keeps the digest of the result file the Runner wrote and the worktree as the CLI left
 *   it (HEAD and a tree hash). Once the stop is proven, the next run of the same attempt starts no CLI: it checks the
 *   file and the worktree against this record and collects from there, or collects nothing when they differ.
 *
 * Facts only, bounded; nothing in it is the CLI's credential or account. Pure: no I/O.
 */

import { isCliArgumentValue, isCliVersion, isCliWorkerProviderId, type CliWorkerProviderId } from "./cli-worker-config.js";
import type { ProviderFailureKind } from "./provider-health.js";

export const CLI_ATTEMPT_RECORDED_EVENT_TYPE = "worker.cli_attempt_recorded";
export const CLI_ATTEMPT_RECORD_VERSION = 1;
/** The actor that records it: the worker driver, never a model. */
export const CLI_ATTEMPT_RECORD_ACTOR = Object.freeze({ role: "runner" as const, id: "native-worker-driver" });

export type CliAttemptOutcomeKind = "done" | "needs_decision" | "cannot_do" | "failure" | "stopped";
export type CliProjectChange = "head" | "index" | "status";

export interface CliAttemptUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
  totalInputTokens: number;
}

export interface CliAttemptRecord {
  version: typeof CLI_ATTEMPT_RECORD_VERSION;
  taskId: string;
  attempt: number;
  workerId: string;
  /** The worker session (the handoff key): the same across runtimes for one attempt. */
  sessionId: string;
  runtimeId: string;
  providerId: CliWorkerProviderId;
  /** The CLI's version, from the run's latest free checks. */
  cliVersion?: string;
  /** The model the runtime asked for; absent for the CLI's default. */
  model?: string;
  /** The model the CLI reported using (Claude Code's `modelUsage` key or `init.model`), when it did. */
  reportedModel?: string;
  /** Codex's thread id, Claude Code's session id, agy's conversation id: the resume key. */
  cliSessionId?: string;
  /** null while the process was still running (a background task kept it up) or after a signal. */
  exitCode: number | null;
  /** The Runner stopped the CLI mid-turn. */
  stoppedBy?: "deadline" | "cancelled";
  outcome: CliAttemptOutcomeKind;
  failureKind?: ProviderFailureKind;
  /** The CLI's summary or the failure's message, bounded. */
  summary?: string;
  collected: boolean;
  /** sha256 of the result file the Runner wrote for this run. */
  resultDigest?: string;
  /** collected: false only. The worktree as the CLI left it. */
  worktree?: { head: string; tree?: string };
  replacedCliCommits?: number;
  restoredProjectDocs?: string[];
  projectChangedDuringAttempt?: CliProjectChange[];
  usage?: CliAttemptUsage;
  /** The browser session the Runner started for the CLI (§3.10, CW8), or why it has none. */
  browser?: { status: "started" | "start_failed" | "none"; reason?: string };
  /** Why the stop that followed was not proven (collected: false). */
  stopFailure?: string;
}

const TEXT_MAX = 4_000;
const SHORT_MAX = 300;
const PATHS_MAX = 64;
const KINDS = new Set<ProviderFailureKind>(["usage_limit", "rate_limit", "authentication", "provider_unavailable", "transient", "invalid_request", "cancelled"]);
const OUTCOMES = new Set<CliAttemptOutcomeKind>(["done", "needs_decision", "cannot_do", "failure", "stopped"]);
const CHANGES = new Set<CliProjectChange>(["head", "index", "status"]);
const OBJECT_ID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const DIGEST = /^[a-f0-9]{64}$/;
const SESSION = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FIELDS = new Set([
  "version", "taskId", "attempt", "workerId", "sessionId", "runtimeId", "providerId", "cliVersion", "model", "reportedModel",
  "cliSessionId", "exitCode", "stoppedBy", "outcome", "failureKind", "summary", "collected", "resultDigest", "worktree",
  "replacedCliCommits", "restoredProjectDocs", "projectChangedDuringAttempt", "usage", "browser", "stopFailure",
]);

/**
 * The CLI session a runtime picked up again resumes: its own latest recorded one. Matched by runtime, never by provider:
 * another model of the same CLI starts its own session and gets the handoff instead (CW7).
 */
export function resumableCliSession(records: readonly CliAttemptRecord[], runtimeId: string): string | undefined {
  return [...records].reverse().find((record) => record.runtimeId === runtimeId && record.cliSessionId)?.cliSessionId;
}

/** Text as a record keeps it: one string, cut to `limit` characters. */
export function boundedRecordText(text: string, limit = TEXT_MAX): string {
  const trimmed = text.trim();
  return trimmed.length <= limit ? trimmed : `${trimmed.slice(0, limit - 1)}…`;
}

/** Strict replay parse of a `worker.cli_attempt_recorded` payload: closed fields, bounded values. */
export function parseCliAttemptRecord(payload: unknown): CliAttemptRecord {
  const fail = (what: string): never => { throw new Error(`CLI attempt record is invalid: ${what}.`); };
  if (!isRecord(payload)) return fail("not an object");
  for (const key of Object.keys(payload)) if (!FIELDS.has(key)) fail(`unexpected field ${key}`);
  if (payload.version !== CLI_ATTEMPT_RECORD_VERSION) fail("version");
  const text = (key: string, limit: number, required: boolean): string | undefined => {
    const value = payload[key];
    if (value === undefined && !required) return undefined;
    if (typeof value !== "string" || !value.trim() || value.length > limit) return fail(key);
    return value as string;
  };
  const taskId = text("taskId", 512, true)!;
  const workerId = text("workerId", 512, true)!;
  const sessionId = text("sessionId", 1_024, true)!;
  const runtimeId = text("runtimeId", 512, true)!;
  if (!Number.isSafeInteger(payload.attempt) || (payload.attempt as number) < 1) fail("attempt");
  if (!isCliWorkerProviderId(payload.providerId)) fail("providerId");
  if (payload.cliVersion !== undefined && !isCliVersion(payload.cliVersion)) fail("cliVersion");
  for (const key of ["model", "reportedModel"] as const) {
    if (payload[key] !== undefined && !isCliArgumentValue(payload[key])) fail(key);
  }
  if (payload.cliSessionId !== undefined && (typeof payload.cliSessionId !== "string" || !SESSION.test(payload.cliSessionId))) fail("cliSessionId");
  if (payload.exitCode !== null && !Number.isSafeInteger(payload.exitCode)) fail("exitCode");
  if (payload.stoppedBy !== undefined && payload.stoppedBy !== "deadline" && payload.stoppedBy !== "cancelled") fail("stoppedBy");
  if (!OUTCOMES.has(payload.outcome as CliAttemptOutcomeKind)) fail("outcome");
  if (payload.failureKind !== undefined && !KINDS.has(payload.failureKind as ProviderFailureKind)) fail("failureKind");
  if ((payload.outcome === "failure") !== (payload.failureKind !== undefined)) fail("failureKind and outcome");
  const summary = text("summary", TEXT_MAX, false);
  if (typeof payload.collected !== "boolean") fail("collected");
  if (payload.resultDigest !== undefined && (typeof payload.resultDigest !== "string" || !DIGEST.test(payload.resultDigest))) fail("resultDigest");
  let worktree: CliAttemptRecord["worktree"];
  if (payload.worktree !== undefined) {
    const value = payload.worktree;
    if (!isRecord(value) || Object.keys(value).some((key) => key !== "head" && key !== "tree")) return fail("worktree");
    if (typeof value.head !== "string" || !OBJECT_ID.test(value.head)) fail("worktree.head");
    if (value.tree !== undefined && (typeof value.tree !== "string" || !OBJECT_ID.test(value.tree))) fail("worktree.tree");
    worktree = { head: value.head as string, ...(value.tree !== undefined ? { tree: value.tree as string } : {}) };
  }
  if (payload.collected === false && (!payload.resultDigest || !worktree)) fail("an uncollected record without its result digest and worktree");
  if (payload.replacedCliCommits !== undefined && (!Number.isSafeInteger(payload.replacedCliCommits) || (payload.replacedCliCommits as number) < 0)) fail("replacedCliCommits");
  const docs = payload.restoredProjectDocs;
  if (docs !== undefined && (!Array.isArray(docs) || docs.length > PATHS_MAX || docs.some((path) => typeof path !== "string" || !path || path.length > 1_024))) fail("restoredProjectDocs");
  const changes = payload.projectChangedDuringAttempt;
  if (changes !== undefined && (!Array.isArray(changes) || changes.length === 0 || changes.some((change) => !CHANGES.has(change as CliProjectChange)))) fail("projectChangedDuringAttempt");
  const usage = payload.usage === undefined ? undefined : parseUsage(payload.usage) ?? fail("usage");
  let browser: CliAttemptRecord["browser"];
  if (payload.browser !== undefined) {
    const value = payload.browser;
    if (!isRecord(value) || Object.keys(value).some((key) => key !== "status" && key !== "reason")) return fail("browser");
    if (value.status !== "started" && value.status !== "start_failed" && value.status !== "none") fail("browser.status");
    if (value.reason !== undefined && (typeof value.reason !== "string" || value.reason.length > SHORT_MAX)) fail("browser.reason");
    browser = { status: value.status as "started" | "start_failed" | "none", ...(value.reason !== undefined ? { reason: value.reason as string } : {}) };
  }
  const stopFailure = text("stopFailure", TEXT_MAX, false);
  return {
    version: CLI_ATTEMPT_RECORD_VERSION,
    taskId, attempt: payload.attempt as number, workerId, sessionId, runtimeId,
    providerId: payload.providerId as CliWorkerProviderId,
    ...(payload.cliVersion !== undefined ? { cliVersion: payload.cliVersion as string } : {}),
    ...(payload.model !== undefined ? { model: payload.model as string } : {}),
    ...(payload.reportedModel !== undefined ? { reportedModel: payload.reportedModel as string } : {}),
    ...(payload.cliSessionId !== undefined ? { cliSessionId: payload.cliSessionId as string } : {}),
    exitCode: payload.exitCode as number | null,
    ...(payload.stoppedBy !== undefined ? { stoppedBy: payload.stoppedBy as "deadline" | "cancelled" } : {}),
    outcome: payload.outcome as CliAttemptOutcomeKind,
    ...(payload.failureKind !== undefined ? { failureKind: payload.failureKind as ProviderFailureKind } : {}),
    ...(summary !== undefined ? { summary } : {}),
    collected: payload.collected as boolean,
    ...(payload.resultDigest !== undefined ? { resultDigest: payload.resultDigest as string } : {}),
    ...(worktree ? { worktree } : {}),
    ...(payload.replacedCliCommits !== undefined ? { replacedCliCommits: payload.replacedCliCommits as number } : {}),
    ...(docs !== undefined ? { restoredProjectDocs: [...(docs as string[])] } : {}),
    ...(changes !== undefined ? { projectChangedDuringAttempt: [...(changes as CliProjectChange[])] } : {}),
    ...(usage ? { usage } : {}),
    ...(browser ? { browser } : {}),
    ...(stopFailure !== undefined ? { stopFailure } : {}),
  };
}

function parseUsage(value: unknown): CliAttemptUsage | undefined {
  if (!isRecord(value)) return undefined;
  const allowed = new Set(["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens", "reasoningTokens", "totalInputTokens"]);
  if (Object.keys(value).some((key) => !allowed.has(key))) return undefined;
  const count = (key: string, required: boolean) => {
    const entry = value[key];
    if (entry === undefined) return required ? null : undefined;
    return Number.isSafeInteger(entry) && (entry as number) >= 0 ? entry as number : null;
  };
  const input = count("inputTokens", true), output = count("outputTokens", true), total = count("totalInputTokens", true);
  const read = count("cacheReadTokens", false), written = count("cacheWriteTokens", false), reasoning = count("reasoningTokens", false);
  if (input === null || output === null || total === null || read === null || written === null || reasoning === null) return undefined;
  return {
    inputTokens: input!, outputTokens: output!,
    ...(read !== undefined ? { cacheReadTokens: read } : {}),
    ...(written !== undefined ? { cacheWriteTokens: written } : {}),
    ...(reasoning !== undefined ? { reasoningTokens: reasoning } : {}),
    totalInputTokens: total!,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
