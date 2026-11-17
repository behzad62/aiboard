/**
 * CLI workers' contracts (docs/plans/2026-11-14-cli-workers.md §3.1, §3.3, packet CW1).
 *
 * The owner's Codex CLI, Claude Code and agy run as Build workers. Their logins stay in each CLI's own
 * files: AIBoard never stores, reads or forwards a CLI credential (OD-35), so neither the runtime config
 * nor the home's `cliWorkers` section has any field that could hold one.
 *
 * This module holds only the names, bounds, charsets and the message scrub; it reads and writes nothing.
 */

import { redactSensitiveText } from "./sensitive-redaction.js";

/** The CLIs a Build can use as workers. Health is per provider id, so one login cools every worker of it. */
export const CLI_WORKER_PROVIDER_IDS = ["codex-cli", "claude-code", "agy"] as const;
export type CliWorkerProviderId = typeof CLI_WORKER_PROVIDER_IDS[number];

export function isCliWorkerProviderId(value: unknown): value is CliWorkerProviderId {
  return typeof value === "string" && (CLI_WORKER_PROVIDER_IDS as readonly string[]).includes(value);
}

/** The runtime id's model part for "the CLI's own default" (no model flag): `claude-code:default`. */
export const CLI_DEFAULT_MODEL_ID = "default";

/**
 * A model id and an effort become CLI arguments, so both are held to this set (§3.1): letters, digits,
 * `.`, `_`, `:`, `/` and `-`, 1 to 128 characters. A value starting with `-` would read as a flag.
 */
const CLI_ARGUMENT_VALUE = /^[A-Za-z0-9._:/][A-Za-z0-9._:/-]{0,127}$/;

export function isCliArgumentValue(value: unknown): value is string {
  return typeof value === "string" && CLI_ARGUMENT_VALUE.test(value);
}

/** CWD-6 (owner, 2026-11-16): one CLI attempt may run 90 minutes unless the home says otherwise, 5 to 240. */
export const CLI_ATTEMPT_MINUTES_DEFAULT = 90;
export const CLI_ATTEMPT_MINUTES_MIN = 5;
export const CLI_ATTEMPT_MINUTES_MAX = 240;

export function isCliAttemptMinutes(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= CLI_ATTEMPT_MINUTES_MIN && (value as number) <= CLI_ATTEMPT_MINUTES_MAX;
}

/** What the Settings Test button saw (§3.4); the outcome classes CW3 reaches. */
export const CLI_TEST_OUTCOMES = [
  "passed", "not_installed", "not_logged_in", "usage_limit", "model_unavailable", "timed_out", "unreadable_result",
] as const;
export type CliTestOutcome = typeof CLI_TEST_OUTCOMES[number];

/** At most this many characters of a test's (redacted) message are kept. */
export const CLI_TEST_MESSAGE_MAX = 300;

/** A CLI's version as the free checks record it: `0.167.1`, `2.1.325`, `1.5.6-beta.2`. */
const CLI_VERSION = /^[0-9A-Za-z][0-9A-Za-z.+_-]{0,63}$/;

export function isCliVersion(value: unknown): value is string {
  return typeof value === "string" && CLI_VERSION.test(value);
}

/** A time in exactly the form `Date.prototype.toISOString` writes, so prose can never pass as one. */
export function isIsoTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value;
}

/** Token shapes a CLI's error text can quote (as submission-guard.ts's), and account fields (e-mail, organization ids, §3.3). */
const MESSAGE_SCRUBS: readonly RegExp[] = [
  /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----[\s\S]*?(?:-----END (?:[A-Z0-9]+ )*PRIVATE KEY-----|$)/g,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g,
  /\bsk-(?:ant-|proj-|svcacct-)?[A-Za-z0-9_-]{20,}/g,
  /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{20,})\b/g,
  /\bAIza[0-9A-Za-z_-]{30,}/g,
  /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g,
  // Organization ids (§3.3: organization fields never reach events or the home): OpenAI's `org-…`, and a UUID that
  // follows an organization word, as in Anthropic's "rate limit for your organization (813ed5d4-…)".
  /\borg-[A-Za-z0-9]{8,}\b/g,
  /(?<=\b(?:org|organi[sz]ation)(?:[ _-]?id)?\W{1,20})[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi,
];

/**
 * A test message as the home keeps it: line endings as `\n`, known token shapes, e-mail addresses and
 * organization ids replaced, then the Runner's general redaction, cut to CLI_TEST_MESSAGE_MAX characters.
 */
export function scrubCliMessage(value: string): string {
  let text = value.replace(/\r\n?/g, "\n");
  for (const pattern of MESSAGE_SCRUBS) text = text.replace(pattern, "[redacted]");
  return redactSensitiveText(text, CLI_TEST_MESSAGE_MAX);
}
/** At most this many model choices per CLI. */
export const CLI_WORKER_MODELS_MAX = 64;

/** One model choice: `id: null` is the CLI's own default. */
export interface HomeCliWorkerModelV1 {
  id: string | null;
  reasoningEffort?: string;
}

export interface HomeCliWorkerTestV1 {
  at: string;
  cliVersion: string;
  modelId: string | null;
  outcome: CliTestOutcome;
  /** Only from a time the CLI stated. */
  resetsAt?: string;
  /** Redacted, at most CLI_TEST_MESSAGE_MAX characters. */
  message?: string;
}

/** One CLI's entry in the home (§3.3). There is no secret field, and none may be added. */
export interface HomeCliWorkerV1 {
  enabled: boolean;
  /** Overrides the PATH lookup. */
  executablePath?: string;
  models: HomeCliWorkerModelV1[];
  /** 5–240; CLI_ATTEMPT_MINUTES_DEFAULT when absent (CWD-6). */
  maxMinutesPerAttempt?: number;
  /** When the owner accepted the Full-access note (§3.12). */
  consentedAt?: string;
  lastTest?: HomeCliWorkerTestV1;
  /** Fields a newer writer added are kept verbatim. */
  [unknown: string]: unknown;
}

export type HomeCliWorkersV1 = { [providerId in CliWorkerProviderId]?: HomeCliWorkerV1 } & Record<string, unknown>;

/** The limit for one attempt of this CLI, in minutes: the home's value, else the default (CWD-6). */
export function cliAttemptLimitMinutes(entry: { maxMinutesPerAttempt?: unknown } | undefined | null): number {
  const value = entry?.maxMinutesPerAttempt;
  return isCliAttemptMinutes(value) ? value : CLI_ATTEMPT_MINUTES_DEFAULT;
}
