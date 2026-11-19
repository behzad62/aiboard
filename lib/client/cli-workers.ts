/**
 * The web side of CLI workers (docs/plans/2026-11-14-cli-workers.md §3.2–§3.4, §3.12, §3.13, packet CW9).
 *
 * - The free checks and the Test button: `GET /v2/cli-workers` and `POST /v2/cli-workers/<id>/test` on the
 *   connected Runner (CW3). A Runner without them answers 404: the page then offers no CLI worker.
 * - What the page shows of a check is an allow-list: a CLI's login is shown as logged in or not, never how or as
 *   whom, so no account field (e-mail, organization, subscription) reaches the page.
 * - The crew picker's CLI rows: workers only, Full access only, a CLI refused on this host never picked.
 * - The config a Build pushes for a CLI worker (`transport: "cli"`, no secret, unmetered).
 * - Run details' CLI attempt card, from the Runner's `worker.cli_attempt_recorded` events (CW5) and the evidence
 *   it re-ran for the CLI (CW6).
 *
 * Settings writes go through home-client.ts (`cliWorkerOps`), never here. Pure apart from the two fetches.
 */

import { isCliRuntimeId } from "@/runner-v2/src/cli-crew-policy";
import { runtimeModelId } from "./build-crew";
import { CLI_DEFAULT_MODEL_ID, CLI_WORKER_DISPLAY_NAMES, cliRuntimeDisplayName } from "@/lib/providers/cli-workers";
import type { CliWorkerProviderId, HomeCliWorkerEntry } from "./home-client";
import type { NativeBuildEvent, NativeBuildObservability, NativeProviderConfig, NativeRunnerConnection } from "./runner-v2";

export { CLI_WORKER_DISPLAY_NAMES, cliRuntimeDisplayName, isCliRuntimeId };

export const CLI_WORKER_IDS: readonly CliWorkerProviderId[] = ["codex-cli", "claude-code", "agy"];

export function cliWorkerName(providerId: string): string {
  return CLI_WORKER_DISPLAY_NAMES[providerId] ?? providerId;
}

/** runner-v2/src/cli-worker-config.ts `isCliArgumentValue`: a model id or effort becomes a CLI argument. */
export function isCliArgumentValue(value: string): boolean {
  return /^[A-Za-z0-9._:/-]{1,128}$/.test(value) && !value.startsWith("-");
}

/** The per-attempt time limit (CWD-6): 5–240 minutes, 90 when unset. */
export const CLI_ATTEMPT_MINUTES = { default: 90, min: 5, max: 240 } as const;

/** §3.12: shown once, before the first enable, and stored as `consentedAt`. */
export const CLI_WORKER_CONSENT_NOTE =
  "This CLI runs any command as you, in the task's worktree, with its own permission prompts turned off.";

export const CLI_WORKERS_FULL_ACCESS_REASON =
  "CLI workers need Full access: the CLI runs any command as you, with its own permission prompts turned off.";

export const CLI_WORKERS_UPDATE_MESSAGE = "Update AI Board to use CLI workers: run `aiboard update`.";

// ------------------------------------------------------------------ the free checks (§3.2, CW3)

export type CliWorkerCheckStatus = "ready" | "refused" | "unavailable" | "unknown";

export interface CliWorkerModelChoiceView {
  /** null: "CLI default", no model flag. */
  id: string | null;
  name: string;
  reasoningEfforts?: string[];
  defaultReasoningEffort?: string;
}

export interface CliWorkerQuotaView {
  name: string;
  buckets: { window: string; remainingFraction: number; resetsAt?: string }[];
}

/** One CLI's free check as the page shows it. Built field by field: nothing the Runner adds later passes through. */
export interface CliWorkerCheckView {
  providerId: CliWorkerProviderId;
  displayName: string;
  status: CliWorkerCheckStatus;
  code?: string;
  reason?: string;
  executable?: { path: string; source: "home" | "path"; form: string };
  version?: string;
  /** Logged in or not; never how, or as whom. */
  login?: "logged_in" | "logged_out" | "unknown";
  models: CliWorkerModelChoiceView[];
  modelsSource?: "cli" | "catalog";
  modelsNote?: string;
  quota?: CliWorkerQuotaView[];
  checkedAt?: string;
}

export interface CliWorkerChecksView {
  checkedAt?: string;
  platform?: string;
  workers: CliWorkerCheckView[];
}

const STATUSES = new Set<CliWorkerCheckStatus>(["ready", "refused", "unavailable", "unknown"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function text(value: unknown, max = 2_000): string | undefined {
  return typeof value === "string" && value.trim() ? value.slice(0, max) : undefined;
}

function strings(value: unknown, max = 32): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const list = value.filter((item): item is string => typeof item === "string" && item.length <= 128).slice(0, max);
  return list.length ? list : undefined;
}

function parseModel(value: unknown): CliWorkerModelChoiceView | null {
  if (!isRecord(value)) return null;
  const id = value.id === null ? null : text(value.id, 128);
  if (id === undefined) return null;
  const name = text(value.name, 200) ?? (id ?? "CLI default");
  const efforts = strings(value.reasoningEfforts, 16);
  const defaultEffort = text(value.defaultReasoningEffort, 128);
  return { id, name, ...(efforts ? { reasoningEfforts: efforts } : {}), ...(defaultEffort ? { defaultReasoningEffort: defaultEffort } : {}) };
}

function parseQuota(value: unknown): CliWorkerQuotaView[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const groups: CliWorkerQuotaView[] = [];
  for (const group of value.slice(0, 32)) {
    if (!isRecord(group) || !Array.isArray(group.buckets)) continue;
    const buckets = group.buckets.slice(0, 16).flatMap((bucket) => {
      if (!isRecord(bucket) || typeof bucket.remainingFraction !== "number" || !Number.isFinite(bucket.remainingFraction)) return [];
      const resetsAt = text(bucket.resetsAt, 64);
      return [{ window: text(bucket.window, 64) ?? "", remainingFraction: bucket.remainingFraction, ...(resetsAt ? { resetsAt } : {}) }];
    });
    groups.push({ name: text(group.name, 200) ?? "Usage", buckets });
  }
  return groups.length ? groups : undefined;
}

/** One check from `GET /v2/cli-workers`, or null when it is not one. Only the named fields are kept. */
export function parseCliWorkerCheck(value: unknown): CliWorkerCheckView | null {
  if (!isRecord(value)) return null;
  const providerId = value.providerId;
  if (typeof providerId !== "string" || !(CLI_WORKER_IDS as readonly string[]).includes(providerId)) return null;
  const status = STATUSES.has(value.status as CliWorkerCheckStatus) ? (value.status as CliWorkerCheckStatus) : "unknown";
  const code = text(value.code, 64);
  const reason = text(value.reason, 1_000);
  const executable = isRecord(value.executable) && typeof value.executable.path === "string"
    ? {
        path: value.executable.path.slice(0, 1_024),
        source: value.executable.source === "home" ? "home" as const : "path" as const,
        form: text(value.executable.form, 16) ?? "exe",
      }
    : undefined;
  const version = text(value.version, 64);
  const loginStatus = isRecord(value.login) ? value.login.status : undefined;
  const login = loginStatus === "logged_in" || loginStatus === "logged_out" || loginStatus === "unknown" ? loginStatus : undefined;
  const models = Array.isArray(value.models)
    ? value.models.slice(0, 128).map(parseModel).filter((model): model is CliWorkerModelChoiceView => model !== null)
    : [];
  const modelsSource = value.modelsSource === "cli" || value.modelsSource === "catalog" ? value.modelsSource : undefined;
  const modelsNote = text(value.modelsNote, 500);
  const quota = parseQuota(value.quota);
  const checkedAt = text(value.checkedAt, 64);
  return {
    providerId: providerId as CliWorkerProviderId,
    displayName: cliWorkerName(providerId),
    status,
    ...(code ? { code } : {}),
    ...(reason ? { reason } : {}),
    ...(executable ? { executable } : {}),
    ...(version ? { version } : {}),
    ...(login ? { login } : {}),
    models,
    ...(modelsSource ? { modelsSource } : {}),
    ...(modelsNote ? { modelsNote } : {}),
    ...(quota ? { quota } : {}),
    ...(checkedAt ? { checkedAt } : {}),
  };
}

export function parseCliWorkerChecks(value: unknown): CliWorkerChecksView {
  const record = isRecord(value) ? value : {};
  const workers = Array.isArray(record.workers)
    ? record.workers.map(parseCliWorkerCheck).filter((check): check is CliWorkerCheckView => check !== null)
    : [];
  const checkedAt = text(record.checkedAt, 64);
  const platform = text(record.platform, 32);
  return { ...(checkedAt ? { checkedAt } : {}), ...(platform ? { platform } : {}), workers };
}

/** A Runner from before CW3 has no `/v2/cli-workers`: the page offers no CLI worker and says to update. */
export class CliWorkersUnsupportedError extends Error {
  readonly code = "cli_workers_unavailable";
  constructor() {
    super(CLI_WORKERS_UPDATE_MESSAGE);
    this.name = "CliWorkersUnsupportedError";
  }
}

async function runnerFetch(connection: NativeRunnerConnection, path: string, init: RequestInit, fetchImpl: typeof fetch): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetchImpl(`${connection.url.replace(/\/$/, "")}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${connection.token}`, "Content-Type": "application/json" },
  });
  const body = await response.json().catch(() => ({}));
  return { status: response.status, body: isRecord(body) ? body : {} };
}

/** `GET /v2/cli-workers` (cached 60 s by the Runner); `refresh` is Settings' Refresh button. */
export async function fetchCliWorkerChecks(
  connection: NativeRunnerConnection,
  options: { refresh?: boolean; signal?: AbortSignal; fetchImpl?: typeof fetch } = {},
): Promise<CliWorkerChecksView> {
  const { status, body } = await runnerFetch(connection, `/v2/cli-workers${options.refresh ? "?refresh=1" : ""}`,
    { method: "GET", ...(options.signal ? { signal: options.signal } : {}) }, options.fetchImpl ?? fetch);
  if (status === 404) throw new CliWorkersUnsupportedError();
  if (status < 200 || status >= 300) {
    throw new Error(text(body.error, 500) ?? `AI Board could not check the CLI workers (HTTP ${status}).`);
  }
  return parseCliWorkerChecks(body);
}

// ------------------------------------------------------------------ the Test button (§3.4)

export type CliTestOutcome = NonNullable<HomeCliWorkerEntry["lastTest"]>["outcome"];
export type CliLastTest = NonNullable<HomeCliWorkerEntry["lastTest"]>;

export type CliWorkerTestAnswer =
  | { kind: "tested"; lastTest: CliLastTest; stopVerified: boolean; endedCooldownIn: string[] }
  /** The free checks refuse a test before any launch (the OS, root, a `.cmd` this PC can't launch). */
  | { kind: "refused"; code: string; message: string; check?: CliWorkerCheckView }
  /** A test already running, the Runner shutting down, or any other answer. */
  | { kind: "not_run"; code?: string; message: string };

const OUTCOMES = new Set<CliTestOutcome>(["passed", "not_installed", "not_logged_in", "usage_limit", "model_unavailable", "timed_out", "unreadable_result"]);

export function parseCliLastTest(value: unknown): CliLastTest | undefined {
  if (!isRecord(value) || !OUTCOMES.has(value.outcome as CliTestOutcome)) return undefined;
  const at = text(value.at, 64);
  if (!at) return undefined;
  const resetsAt = text(value.resetsAt, 64);
  const message = text(value.message, 300);
  return {
    at,
    cliVersion: text(value.cliVersion, 64) ?? "unknown",
    modelId: typeof value.modelId === "string" ? value.modelId.slice(0, 128) : null,
    outcome: value.outcome as CliTestOutcome,
    ...(resetsAt ? { resetsAt } : {}),
    ...(message ? { message } : {}),
  };
}

/** `POST /v2/cli-workers/<id>/test`: one tiny prompt, in the CLI's most restricted mode; the Runner saves the result. */
export async function runCliWorkerTest(
  connection: NativeRunnerConnection,
  providerId: CliWorkerProviderId,
  request: { model: string | null; reasoningEffort?: string },
  options: { signal?: AbortSignal; fetchImpl?: typeof fetch } = {},
): Promise<CliWorkerTestAnswer> {
  const body = { model: request.model, ...(request.reasoningEffort ? { reasoningEffort: request.reasoningEffort } : {}) };
  const answer = await runnerFetch(connection, `/v2/cli-workers/${encodeURIComponent(providerId)}/test`,
    { method: "POST", body: JSON.stringify(body), ...(options.signal ? { signal: options.signal } : {}) }, options.fetchImpl ?? fetch);
  if (answer.status === 404) throw new CliWorkersUnsupportedError();
  if (answer.status === 200) {
    const lastTest = parseCliLastTest(answer.body.lastTest);
    if (!lastTest) return { kind: "not_run", message: "AI Board's answer to the test could not be read." };
    const ended = Array.isArray(answer.body.endedCooldownIn) ? answer.body.endedCooldownIn.filter((id): id is string => typeof id === "string") : [];
    return { kind: "tested", lastTest, stopVerified: answer.body.stopVerified !== false, endedCooldownIn: ended };
  }
  const code = text(answer.body.code, 64);
  const message = text(answer.body.error, 1_000) ?? `The test did not run (HTTP ${answer.status}).`;
  if (answer.status === 409 && answer.body.check !== undefined) {
    const check = parseCliWorkerCheck(answer.body.check);
    return { kind: "refused", code: code ?? "cli_worker_refused", message, ...(check ? { check } : {}) };
  }
  return { kind: "not_run", ...(code ? { code } : {}), message };
}

/** Each Test outcome's words: what happened and what to do (§3.4's reasons). */
export const CLI_TEST_OUTCOMES: Readonly<Record<CliTestOutcome, { label: string; tone: "success" | "warning" | "destructive"; reason: string }>> = {
  passed: { label: "Passed", tone: "success", reason: "The CLI answered with a result AIBoard can read, so it can take Build tasks." },
  not_installed: { label: "Not installed", tone: "destructive", reason: "AIBoard could not find or start the CLI. Install it, or set its path, then test again." },
  not_logged_in: { label: "Not logged in", tone: "destructive", reason: "Log in with the CLI in a terminal, then test again." },
  usage_limit: { label: "Out of usage", tone: "warning", reason: "The CLI's usage is spent for now. A Build hands its tasks to another worker until it resets." },
  model_unavailable: { label: "Model unavailable", tone: "destructive", reason: "The CLI refused this model: your plan may not include it, or the id is wrong." },
  timed_out: { label: "Timed out", tone: "warning", reason: "The CLI did not answer in time, or its programs could not be proven stopped." },
  unreadable_result: { label: "Unreadable result", tone: "warning", reason: "The CLI answered, but AIBoard could not read its result. An update of the CLI may have changed its output." },
};

function formatDuration(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours < 48) return rest ? `${hours} h ${rest} min` : `${hours} h`;
  return `${Math.round(hours / 24)} days`;
}

/** "Usage resets at <time> (in 3 h 12 min)." Only from a time the CLI stated; null when there is none. */
export function cliResetText(resetsAt: string | undefined, now: number = Date.now()): string | null {
  if (!resetsAt) return null;
  const at = Date.parse(resetsAt);
  if (!Number.isFinite(at)) return null;
  const when = new Date(at).toLocaleString(undefined, { weekday: "short", hour: "2-digit", minute: "2-digit" });
  return at > now ? `Usage resets ${when} (in ${formatDuration(at - now)}).` : `Usage was due to reset ${when}.`;
}

// ------------------------------------------------------------------ health and the crew picker (§3.11–§3.13)

export type CliWorkerHealthState = "ready" | "refused" | "unavailable" | "unknown" | "unchecked";

export interface CliWorkerHealth {
  state: CliWorkerHealthState;
  label: string;
  reason?: string;
  /**
   * False for a CLI refused on this host (the OS or root: it can never run here) and for one the Runner has not
   * checked yet, so a Build never starts with a CLI the Runner would refuse.
   */
  pickable: boolean;
}

/** The reason a CLI can't be picked before the Runner's free check for it is in. */
export const CLI_WORKER_UNCHECKED_REASON = "AI Board is still checking this CLI. It can be picked once the check is in.";

const UNAVAILABLE_LABELS: Record<string, string> = {
  not_installed: "Not installed",
  not_logged_in: "Not logged in",
  usage_limit: "Out of usage",
  executable_refused: "Path refused",
  job_containment_unavailable: "Can't run here",
  cmd_shim_schema: "Needs the .exe",
  cmd_launch_unavailable: "Can't launch .cmd",
  cmd_argument_unsafe: "Can't launch .cmd",
};

/** What the crew picker and Settings say about one CLI, from its free check. */
export function cliWorkerHealth(check: CliWorkerCheckView | undefined): CliWorkerHealth {
  if (!check) return { state: "unchecked", label: "Not checked", reason: CLI_WORKER_UNCHECKED_REASON, pickable: false };
  const reason = check.reason ? { reason: check.reason } : {};
  if (check.status === "ready") return { state: "ready", label: "Ready", pickable: true };
  if (check.status === "refused") {
    return { state: "refused", label: "Not available here", reason: check.reason ?? `${check.displayName} can't run as a worker on this computer.`, pickable: false };
  }
  if (check.status === "unavailable") {
    return { state: "unavailable", label: (check.code && UNAVAILABLE_LABELS[check.code]) ?? "Unavailable", ...reason, pickable: true };
  }
  return { state: "unknown", label: "Unknown", ...reason, pickable: true };
}

export interface CliWorkerCrewOption {
  /** `<providerId>:<model or "default">` (CW1): the crew member's model id and the Runner's runtime id. */
  runtimeId: string;
  providerId: CliWorkerProviderId;
  modelId: string | null;
  name: string;
  /** The effort set in Settings, or null for the CLI's own. */
  reasoningEffort: string | null;
  health: CliWorkerHealth;
  /** Why it can't be picked now: refused on this host, or the Build is not at Full access. */
  disabledReason?: string;
}

export function cliRuntimeId(providerId: string, modelId: string | null): string {
  return `${providerId}:${modelId ?? CLI_DEFAULT_MODEL_ID}`;
}

/**
 * The CLI rows the crew picker offers as workers: every model of every CLI enabled (with its consent) in Settings.
 * `access` is the Build's access ceiling; anything but Full makes every row unpickable (§3.12, OD-36).
 */
export function cliWorkerCrewOptions(
  entries: Partial<Record<CliWorkerProviderId, HomeCliWorkerEntry>>,
  checks: CliWorkerChecksView | null,
  access: "ask" | "project" | "full" | null | undefined,
): CliWorkerCrewOption[] {
  const options: CliWorkerCrewOption[] = [];
  for (const providerId of CLI_WORKER_IDS) {
    const entry = entries[providerId];
    if (!entry?.enabled || !entry.consentedAt) continue;
    const health = cliWorkerHealth(checks?.workers.find((check) => check.providerId === providerId));
    const seen = new Set<string>();
    for (const model of entry.models ?? []) {
      const runtimeId = cliRuntimeId(providerId, model.id);
      if (seen.has(runtimeId)) continue;
      seen.add(runtimeId);
      const disabledReason = !health.pickable
        ? health.reason
        : access !== "full"
          ? CLI_WORKERS_FULL_ACCESS_REASON
          : undefined;
      options.push({
        runtimeId,
        providerId,
        modelId: model.id,
        name: cliRuntimeDisplayName(runtimeId) ?? runtimeId,
        reasoningEffort: model.reasoningEffort ?? null,
        health,
        ...(disabledReason ? { disabledReason } : {}),
      });
    }
  }
  return options;
}

/**
 * Why a crew's CLI workers can't start now, or null: a CLI worker that is no longer turned on (with its consent) in
 * Settings, one the Runner hasn't checked yet, or one it refuses on this host. Checked before the discussion is
 * created or a crew change is saved, so the Runner's start refusal never leaves a dead Build behind. The roles and
 * access rule is `buildCrewCliRefusal` (lib/client/build-crew.ts).
 */
export function cliCrewAvailabilityRefusal(
  workerRuntimeIds: readonly string[],
  crew: { options: readonly CliWorkerCrewOption[]; status: "off" | "loading" | "ready" | "error" | "unsupported" },
): string | null {
  for (const runtimeId of workerRuntimeIds) {
    if (!isCliRuntimeId(runtimeId)) continue;
    const name = cliRuntimeDisplayName(runtimeId) ?? runtimeId;
    if (crew.status === "unsupported") return `${name}: ${CLI_WORKERS_UPDATE_MESSAGE}`;
    const option = crew.options.find((candidate) => candidate.runtimeId === runtimeId);
    if (!option) {
      return `${name} is not turned on as a CLI worker. Turn it on in Settings > CLI workers, or remove it from the crew.`;
    }
    if (!option.health.pickable) {
      if (option.health.state === "unchecked" && crew.status === "error") {
        return `${name}: AI Board could not check the CLI workers. It tries again shortly.`;
      }
      return `${name}: ${option.health.reason ?? option.health.label}`;
    }
  }
  return null;
}

// ------------------------------------------------------------------ the config a Build pushes (§3.1, §3.3)

/**
 * The config the web pushes for a CLI worker when a Build starts: no secret, base URL, token or secret source (the
 * CLI signs in with its own login), unmetered, text only; the effort comes from Settings.
 */
export function cliNativeProviderConfig(
  runtimeId: string,
  priority: number,
  entries: Partial<Record<CliWorkerProviderId, HomeCliWorkerEntry>>,
): NativeProviderConfig {
  if (!isCliRuntimeId(runtimeId)) throw new Error(`${runtimeId} is not a CLI worker.`);
  const separator = runtimeId.indexOf(":");
  const providerId = runtimeId.slice(0, separator) as CliWorkerProviderId;
  const modelId = runtimeId.slice(separator + 1);
  const name = cliWorkerName(providerId);
  const entry = entries[providerId];
  if (!entry?.enabled || !entry.consentedAt) throw new Error(`${name} is not turned on as a CLI worker. Turn it on in Settings > CLI workers.`);
  const model = entry.models?.find((candidate) => (candidate.id ?? CLI_DEFAULT_MODEL_ID) === modelId);
  if (!model) throw new Error(`${cliRuntimeDisplayName(runtimeId)} is not one of ${name}'s models in Settings > CLI workers.`);
  return {
    runtimeId,
    providerId,
    modelId,
    displayName: cliRuntimeDisplayName(runtimeId) ?? runtimeId,
    billingBasis: "account_not_metered",
    transport: "cli",
    secret: "",
    capabilities: ["*"],
    priority,
    ...(model.reasoningEffort ? { cli: { reasoningEffort: model.reasoningEffort } } : {}),
  };
}

// ------------------------------------------------------------------ Run details' CLI attempt card (§3.5–§3.7, CW5, CW6)

/**
 * cli-worker-runtime.ts `LIVE_TURN_BASE`: a CLI run's live tail is numbered apart from an API worker's turns
 * (scripts/test-cli-workers-ui.mts pins them equal).
 */
export const CLI_LIVE_TURN_BASE = 1_000_000;

/**
 * cli-worker-evidence.ts `CLI_RERUN_TIMEOUT_CAP_MS`: a re-run's longest time limit. A re-run that timed out sooner was
 * cut short by the task's validation budget, which the Runner counts as not run, never as a failure (§3.6). The record
 * keeps no time limit, so the page reads it from how long the re-run ran (pinned equal in scripts/test-cli-workers-ui.mts).
 */
export const CLI_RERUN_TIMEOUT_CAP_MS = 10 * 60_000;

export type CliAttemptOutcome = "done" | "needs_decision" | "cannot_do" | "failure" | "stopped";

export interface CliRerunView {
  id: string;
  label: string;
  command: string;
  exitCode: number | null;
  timedOut: boolean;
  passed: boolean;
  at: string;
  /** Timed out under the ten-minute cap: the task's validation budget cut it short (not run, not a failure). */
  budgetCut: boolean;
  /** Its cleanup was not verified empty: the Runner could not prove its programs stopped. */
  stopUnproven: boolean;
  cancelled: boolean;
}

/** CW7: the worker this CLI took the attempt over from, and why that one stopped (`worker.runtime_assigned` handoff). */
export interface CliTakeoverView {
  from: string;
  failure: string;
  message?: string;
}

export interface CliAttemptView {
  sequence: number;
  occurredAt: string;
  taskId: string;
  taskTitle?: string;
  attempt: number;
  providerId: string;
  name: string;
  runtimeId: string;
  workerId: string;
  sessionId: string;
  cliVersion?: string;
  model?: string;
  reportedModel?: string;
  outcome: CliAttemptOutcome;
  outcomeLabel: string;
  failureKind?: string;
  summary?: string;
  collected: boolean;
  exitCode: number | null;
  stoppedBy?: string;
  replacedCliCommits?: number;
  restoredProjectDocs: string[];
  projectChangedDuringAttempt: string[];
  browser?: { status: string; reason?: string };
  stopFailure?: string;
  usage?: { inputTokens: number; outputTokens: number };
  reruns: CliRerunView[];
  /** The run's number in its session's attempt (cli-worker-runtime.ts): its live tail is turn CLI_LIVE_TURN_BASE + runNumber. */
  runNumber: number;
  /** Collected later, once its programs were proven stopped (an earlier record said `collected: false`). */
  collectedAfterStop?: boolean;
  /** The CLI's fix round (CW6): the run after a `done` run of the same attempt whose re-runs left a gap. */
  fixRound?: boolean;
  /** The task was submitted right after this run, so its failing or cut-short re-runs went in with the work. */
  submittedAfter?: boolean;
  /** The first run after a switch from another worker (CW7). */
  takeover?: CliTakeoverView;
}

const OUTCOME_LABELS: Record<CliAttemptOutcome, string> = {
  done: "Done",
  needs_decision: "Asked the Architect",
  cannot_do: "Asked for a replan",
  failure: "Failed",
  stopped: "Stopped",
};

const FAILURE_LABELS: Record<string, string> = {
  usage_limit: "out of usage",
  rate_limit: "rate-limited",
  authentication: "login or model problem",
  provider_unavailable: "service unavailable",
  transient: "crashed or gave no result",
  invalid_request: "invalid request",
  cancelled: "cancelled",
};

export function cliAttemptOutcomeLabel(outcome: CliAttemptOutcome, failureKind?: string): string {
  if (outcome === "failure" && failureKind) return `Failed: ${FAILURE_LABELS[failureKind] ?? failureKind.replaceAll("_", " ")}`;
  return OUTCOME_LABELS[outcome];
}

type Evidence = NativeBuildObservability["evidence"][number];

/** A re-run the Runner did of a check the CLI reported (CW6: the fact's `source`). */
function isCliRerun(evidence: Evidence): boolean {
  return evidence.fact.kind === "command" && (evidence.fact as { source?: unknown }).source === "runner_rerun_of_cli_claim";
}

function rerunView(evidence: Evidence): CliRerunView | null {
  if (evidence.fact.kind !== "command") return null;
  const fact = evidence.fact as {
    label?: unknown; command?: unknown; args?: unknown; exitCode?: unknown; timedOut?: unknown; cancelled?: unknown;
    startedAt?: unknown; finishedAt?: unknown; cleanup?: unknown;
  };
  const args = Array.isArray(fact.args) ? fact.args.filter((arg): arg is string => typeof arg === "string") : [];
  const command = [typeof fact.command === "string" ? fact.command : "", ...args].join(" ").trim();
  const exitCode = typeof fact.exitCode === "number" ? fact.exitCode : null;
  const timedOut = fact.timedOut === true;
  const ranMs = typeof fact.startedAt === "string" && typeof fact.finishedAt === "string"
    ? Date.parse(fact.finishedAt) - Date.parse(fact.startedAt)
    : Number.NaN;
  const cleanupState = isRecord(fact.cleanup) ? fact.cleanup.state : undefined;
  return {
    id: evidence.id,
    label: (typeof fact.label === "string" && fact.label.trim()) || command || evidence.id,
    command,
    exitCode,
    timedOut,
    passed: exitCode === 0 && !timedOut,
    at: evidence.createdAt,
    budgetCut: timedOut && Number.isFinite(ranMs) && ranMs < CLI_RERUN_TIMEOUT_CAP_MS,
    stopUnproven: cleanupState !== undefined && cleanupState !== "verified_empty",
    cancelled: fact.cancelled === true,
  };
}

function nonNegative(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

/**
 * Every recorded CLI run, newest first, from the Build's events; each with the re-runs the Runner did for it (the
 * evidence of that task's worker recorded after that run and before the worker's next one).
 */
export function cliAttemptViews(
  events: readonly NativeBuildEvent[],
  options: { taskTitles?: Record<string, string | undefined>; evidence?: readonly Evidence[] } = {},
): CliAttemptView[] {
  const attempts: CliAttemptView[] = [];
  for (const event of events) {
    if (event.type !== "worker.cli_attempt_recorded") continue;
    const payload = event.payload;
    const taskId = text(payload.taskId, 512);
    const workerId = text(payload.workerId, 512);
    const sessionId = text(payload.sessionId, 1_024);
    const runtimeId = text(payload.runtimeId, 512);
    const providerId = text(payload.providerId, 64);
    const outcome = payload.outcome as CliAttemptOutcome;
    if (!taskId || !workerId || !sessionId || !runtimeId || !providerId || !(outcome in OUTCOME_LABELS)) continue;
    const failureKind = text(payload.failureKind, 64);
    const usage = isRecord(payload.usage) && nonNegative(payload.usage.inputTokens) !== undefined && nonNegative(payload.usage.outputTokens) !== undefined
      ? { inputTokens: payload.usage.inputTokens as number, outputTokens: payload.usage.outputTokens as number }
      : undefined;
    const browser = isRecord(payload.browser) && typeof payload.browser.status === "string"
      ? { status: payload.browser.status, ...(text(payload.browser.reason, 300) ? { reason: text(payload.browser.reason, 300)! } : {}) }
      : undefined;
    const optional = {
      taskTitle: options.taskTitles?.[taskId],
      cliVersion: text(payload.cliVersion, 64),
      model: text(payload.model, 128),
      reportedModel: text(payload.reportedModel, 128),
      failureKind,
      summary: text(payload.summary, 4_000),
      stoppedBy: text(payload.stoppedBy, 32),
      replacedCliCommits: nonNegative(payload.replacedCliCommits),
      browser,
      stopFailure: text(payload.stopFailure, 4_000),
      usage,
    };
    attempts.push({
      sequence: event.sequence,
      occurredAt: event.occurredAt,
      taskId,
      attempt: nonNegative(payload.attempt) ?? 1,
      providerId,
      name: cliWorkerName(providerId),
      runtimeId,
      workerId,
      sessionId,
      outcome,
      outcomeLabel: cliAttemptOutcomeLabel(outcome, failureKind),
      collected: payload.collected !== false,
      exitCode: typeof payload.exitCode === "number" ? payload.exitCode : null,
      restoredProjectDocs: strings(payload.restoredProjectDocs, 64) ?? [],
      projectChangedDuringAttempt: strings(payload.projectChangedDuringAttempt, 8) ?? [],
      reruns: [],
      runNumber: 1,
      ...Object.fromEntries(Object.entries(optional).filter(([, value]) => value !== undefined)),
      ...(text(payload.resultDigest, 128) ? { resultDigest: text(payload.resultDigest, 128) } : {}),
    } as CliAttemptView);
  }
  attempts.sort((left, right) => left.sequence - right.sequence);
  // Number each run as the Runner does (one more than the records of its task attempt and session so far); a record
  // that collects an earlier `collected: false` run (§3.11 case 2) is that same run and replaces its card.
  const recordsSoFar = new Map<string, number>();
  const uncollected = new Map<string, CliAttemptView & { resultDigest?: string }>();
  const replaced = new Set<CliAttemptView>();
  for (const attempt of attempts as Array<CliAttemptView & { resultDigest?: string }>) {
    const group = `${attempt.taskId}\u0000${attempt.attempt}\u0000${attempt.sessionId}`;
    const count = recordsSoFar.get(group) ?? 0;
    recordsSoFar.set(group, count + 1);
    const pending = uncollected.get(group);
    if (pending && attempt.collected && (!pending.resultDigest || !attempt.resultDigest || pending.resultDigest === attempt.resultDigest)) {
      attempt.runNumber = pending.runNumber;
      attempt.collectedAfterStop = true;
      if (pending.stopFailure && !attempt.stopFailure) attempt.stopFailure = pending.stopFailure;
      replaced.add(pending);
      uncollected.delete(group);
    } else {
      attempt.runNumber = count + 1;
      if (attempt.collected) uncollected.delete(group);
      else uncollected.set(group, attempt);
    }
  }
  const shown = attempts.filter((attempt) => !replaced.has(attempt));
  for (const attempt of shown) delete (attempt as { resultDigest?: string }).resultDigest;
  markRunContext(shown, events);
  attempts.length = 0;
  attempts.push(...shown);
  for (const evidence of options.evidence ?? []) {
    if (!isCliRerun(evidence) || evidence.actor.role !== "worker") continue;
    const view = rerunView(evidence);
    if (!view) continue;
    const owner = attempts.filter((attempt) =>
      attempt.taskId === evidence.taskId && attempt.workerId === evidence.actor.id && attempt.occurredAt <= evidence.createdAt).at(-1);
    owner?.reruns.push(view);
  }
  return attempts.reverse();
}

/**
 * The fix round, the submission after a run, and the takeover (CW6, CW7), read from the run's own events: a fix round
 * follows a collected `done` run of the same attempt and session; a `task.transitioned` to `submitted` with no CLI run
 * of the task in between follows this run; a `worker.runtime_assigned` with a `handoff` for this runtime, with no run of
 * the session in between, is this run's takeover.
 */
function markRunContext(shown: CliAttemptView[], events: readonly NativeBuildEvent[]): void {
  const group = (attempt: CliAttemptView) => `${attempt.taskId}\u0000${attempt.attempt}\u0000${attempt.sessionId}`;
  const previous = new Map<string, CliAttemptView>();
  for (const attempt of shown) {
    const before = previous.get(group(attempt));
    if (before?.outcome === "done" && before.collected) attempt.fixRound = true;
    previous.set(group(attempt), attempt);
  }
  const submissions = events
    .filter((event) => event.type === "task.transitioned" && event.payload.status === "submitted" && typeof event.payload.taskId === "string")
    .map((event) => ({ taskId: event.payload.taskId as string, sequence: event.sequence }));
  for (const attempt of shown) {
    const next = shown.find((other) => other !== attempt && other.taskId === attempt.taskId && other.sequence > attempt.sequence);
    if (submissions.some((submission) => submission.taskId === attempt.taskId && submission.sequence > attempt.sequence &&
      (!next || submission.sequence < next.sequence))) attempt.submittedAfter = true;
  }
  const assignments = events.filter((event) => event.type === "worker.runtime_assigned");
  for (const attempt of shown) {
    const assignment = assignments.filter((event) => event.sequence < attempt.sequence && event.payload.taskId === attempt.taskId &&
      event.payload.attempt === attempt.attempt && event.payload.sessionId === attempt.sessionId).at(-1);
    if (!assignment || assignment.payload.runtimeId !== attempt.runtimeId || !isRecord(assignment.payload.handoff)) continue;
    if (shown.some((other) => group(other) === group(attempt) && other.sequence > assignment.sequence && other.sequence < attempt.sequence)) continue;
    const handoff = assignment.payload.handoff;
    const from = text(handoff.fromRuntimeId, 512);
    const kind = text(handoff.failureKind, 64);
    if (!from || !kind) continue;
    const message = text(handoff.message, 600);
    attempt.takeover = {
      from: cliRuntimeDisplayName(from) ?? runtimeModelId(from),
      failure: FAILURE_LABELS[kind] ?? kind.replaceAll("_", " "),
      ...(message && message !== "no message" ? { message } : {}),
    };
  }
}

/** The live tail of a CLI run (CW5 publishes the CLI's stdout as `tool` deltas on a turn past CLI_LIVE_TURN_BASE). */
export interface CliLiveTailInput {
  sessionId: string;
  actor: { role: string; id: string };
  turn: number;
  streaming: boolean;
  segments: readonly { channel: string; text: string }[];
}

export interface CliLiveTail {
  sessionId: string;
  workerId: string;
  /** The CLI run's number in its session (the live turn minus CLI_LIVE_TURN_BASE). */
  runNumber: number;
  streaming: boolean;
  text: string;
}

const TAIL_CHARS = 4_000;

export function cliLiveTails(turns: readonly CliLiveTailInput[]): CliLiveTail[] {
  return turns
    .filter((turn) => turn.turn >= CLI_LIVE_TURN_BASE && turn.actor.role === "worker")
    .map((turn) => ({
      sessionId: turn.sessionId,
      workerId: turn.actor.id,
      runNumber: turn.turn - CLI_LIVE_TURN_BASE,
      streaming: turn.streaming,
      text: turn.segments.map((segment) => segment.text).join("").slice(-TAIL_CHARS),
    }))
    .filter((tail) => tail.streaming || tail.text);
}
