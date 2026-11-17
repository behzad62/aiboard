/**
 * CLI worker failures (docs/plans/2026-11-14-cli-workers.md §3.8, packet CW2): the text and stated-reset rules the
 * three adapters share. An adapter picks the CLI's decisive message (Codex's `turn.failed`, Claude Code's `is_error`
 * result, agy's `ERROR` result) and its structured fields; this module turns text into a provider-health kind.
 *
 * - A message no rule matches is `transient`, never a success.
 * - A reset is set only from a time the CLI stated: a duration ("Resets in 4h53m36s", "try again in 3 hours"), a
 *   timestamp (ISO with a zone, Unix seconds), or a clock time ("try again at 3:02 PM", read as the next such local
 *   time within a day, since the CLI runs on this machine). A guessed reset never sets one, and agy's `retryable` is
 *   never read.
 * - A model the CLI rejects is `authentication`, not `invalid_request`: `invalid_request` never fails over, and a
 *   mistyped CLI model should hand the task to another worker (§3.8).
 *
 * Pure: no I/O. Messages are scrubbed (scrubCliMessage) before they leave this module.
 */

import { scrubCliMessage } from "./cli-worker-config.js";
import type { ProviderFailure, ProviderFailureKind } from "./provider-health.js";

/** The kinds a CLI failure can have. `invalid_request` and `cancelled` are never a CLI's (§3.8). */
export type CliFailureKind = Extract<ProviderFailureKind, "usage_limit" | "rate_limit" | "authentication" | "provider_unavailable" | "transient">;

/** A stated reset further away than this is read as a misparse and ignored (a weekly cap is about 7 days). */
export const CLI_STATED_RESET_MAX_MS = 31 * 24 * 60 * 60 * 1_000;

export interface StatedReset {
  retryAfterMs: number;
  /** The reset as `toISOString` writes it. */
  resetsAt: string;
}

const AUTHENTICATION: readonly RegExp[] = [
  /\bnot (?:logged|signed) in\b/i,
  /please run \/login/i,
  /\b(?:log|sign) ?in (?:again|required|expired)\b/i,
  /\bunauthori[sz]ed\b/i,
  /\b401\b/,
  /\b403\b|\bforbidden\b/i,
  /\bauthentication(?:[ _-](?:failed|error|required))\b/i,
  /\binvalid (?:api key|credentials|token|session)\b/i,
  /\b(?:token|session|login|credentials?) (?:has |have )?expired\b/i,
  /\brun `?(?:codex login|claude (?:auth )?login|agy login)\b/i,
];

/** The model or its effort is not available to this login: the owner must fix the setup (§3.8). */
const MODEL_UNAVAILABLE: readonly RegExp[] = [
  /\bmodel is not supported\b/i,
  /\bissue with the selected model\b/i,
  /\binvalid model selection\b/i,
  /\b(?:unknown|unsupported|unrecognized) model\b/i,
  /\bmodel[_ ]not[_ ]found\b/i,
  /\bnot_found_error\b/i,
  // Not across a colon: "model request failed: 503 Service Unavailable" is the service, not the model.
  /\bmodel\b[^.\n:]{0,60}\b(?:does not exist|not found|is not available|is unavailable)\b/i,
];

const USAGE_LIMIT: readonly RegExp[] = [
  /\busage limit\b/i,
  /\bhit your (?:usage |weekly |monthly |daily )?limit\b/i,
  /\b(?:\d+[- ]hour|five[- ]hour|session|daily|weekly|monthly) (?:usage )?(?:limit|cap) (?:reached|exceeded|hit)\b/i,
  /\bquota\b[^.\n]{0,40}\b(?:exhausted|exceeded|reached|used up)\b/i,
  // A quota, or a limit named as usage: "exceeded retry limit, last status: 429" is not one.
  /\b(?:exhausted|exceeded|used up) (?:your |the |all )?(?:\w+ ){0,3}quota\b/i,
  /\b(?:exhausted|exceeded|used up) (?:your |the )?(?:weekly |monthly |daily |usage |plan |session )+(?:limit|cap)\b/i,
  /\bout of (?:usage|credits|quota)\b/i,
];

const RATE_LIMIT: readonly RegExp[] = [/\b429\b/, /\btoo many requests\b/i, /\brate[ _-]?limit/i];

const PROVIDER_UNAVAILABLE: readonly RegExp[] = [
  /\b(?:status|error|code|http)\W{0,3}5\d\d\b/i,
  /\b5\d\d (?:internal|service|bad gateway|gateway|overloaded|server)/i,
  /\boverloaded\b/i,
  /\bservice (?:is )?(?:temporarily )?unavailable\b/i,
  /\binternal server error\b/i,
  /\bbad gateway\b|\bgateway time-?out\b/i,
  /\bserver error\b/i,
  /\btemporarily unavailable\b/i,
];

/**
 * The kind a CLI failure message names, by §3.8's rows in this order: model, login, usage limit, rate limit, server
 * error; anything else is `transient`. Model and login come first because their messages can quote a status code
 * the later rows also match; a usage limit comes before a rate limit because a quota message can carry a 429.
 */
export function classifyCliFailureText(text: string, options: { includeModel?: boolean } = {}): CliFailureKind {
  if (!text.trim()) return "transient";
  // A side message (a Codex warning that a model's metadata is unknown) is not a decisive one: callers that scan
  // side messages leave the model rule out, so a warning never fails a run over by itself.
  if (options.includeModel !== false && MODEL_UNAVAILABLE.some((pattern) => pattern.test(text))) return "authentication";
  if (AUTHENTICATION.some((pattern) => pattern.test(text))) return "authentication";
  if (USAGE_LIMIT.some((pattern) => pattern.test(text))) return "usage_limit";
  if (RATE_LIMIT.some((pattern) => pattern.test(text))) return "rate_limit";
  if (PROVIDER_UNAVAILABLE.some((pattern) => pattern.test(text))) return "provider_unavailable";
  return "transient";
}

/** True when the text says the model (or its effort) is not available: §3.8's "model unavailable" row. */
export function isCliModelUnavailableText(text: string): boolean {
  return MODEL_UNAVAILABLE.some((pattern) => pattern.test(text));
}

/**
 * The provider failure for a CLI message. A `usage_limit` or `rate_limit` gets `retryAfterMs` only from `reset`
 * (a structured time the adapter read) or from a time stated in the text itself.
 */
export function cliProviderFailure(kind: CliFailureKind, text: string, now: number, reset?: StatedReset): ProviderFailure {
  const message = scrubCliMessage(text.trim() || defaultMessage(kind));
  const stated = kind === "usage_limit" || kind === "rate_limit" ? reset ?? statedResetFromText(text, now) : undefined;
  return { kind, message: message.trim() ? message : defaultMessage(kind), ...(stated ? { retryAfterMs: stated.retryAfterMs } : {}) };
}

function defaultMessage(kind: CliFailureKind): string {
  switch (kind) {
    case "usage_limit": return "The CLI is out of usage.";
    case "rate_limit": return "The CLI was rate limited.";
    case "authentication": return "The CLI is not logged in, or its model is not available.";
    case "provider_unavailable": return "The CLI's service is unavailable.";
    default: return "The CLI failed without a result.";
  }
}

/** A reset from Unix seconds the CLI stated (Claude Code's `resetsAt`). */
export function statedResetFromUnixSeconds(value: unknown, now: number): StatedReset | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return undefined;
  return statedResetAt(value * 1_000, now);
}

/** A reset from a timestamp with a zone the CLI stated (agy `/quota`'s `reset_time`). */
export function statedResetFromIso(value: unknown, now: number): StatedReset | undefined {
  if (typeof value !== "string" || !ISO_WITH_ZONE.test(value.trim())) return undefined;
  return statedResetAt(Date.parse(value.trim()), now);
}

const ISO_WITH_ZONE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:?\d{2})$/;

function statedResetAt(time: number, now: number): StatedReset | undefined {
  if (!Number.isFinite(time)) return undefined;
  const retryAfterMs = Math.ceil(time - now);
  if (retryAfterMs <= 0 || retryAfterMs > CLI_STATED_RESET_MAX_MS) return undefined;
  return { retryAfterMs, resetsAt: new Date(now + retryAfterMs).toISOString() };
}

const DURATION_UNIT_MS: Readonly<Record<string, number>> = {
  d: 86_400_000, day: 86_400_000, days: 86_400_000,
  h: 3_600_000, hr: 3_600_000, hrs: 3_600_000, hour: 3_600_000, hours: 3_600_000,
  m: 60_000, min: 60_000, mins: 60_000, minute: 60_000, minutes: 60_000,
  s: 1_000, sec: 1_000, secs: 1_000, second: 1_000, seconds: 1_000,
};
const DURATION_PART = String.raw`\d{1,4}\s*(?:days?|d|hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)\b`;
const DURATION = new RegExp(
  String.raw`\b(?:resets?|reset(?:s)? in|try again|retry|available again|refresh(?:es)?)\b[^.\n\d]{0,24}?\bin\s+((?:${DURATION_PART}(?:\s*,?\s*(?:and\s+)?)?)+)`,
  "i",
);
const COMPACT_DURATION = new RegExp(
  String.raw`\b(?:resets?|try again|retry|available again|refresh(?:es)?)\b[^\n]{0,40}?\b(\d{1,4}d(?:\d{1,2}h)?(?:\d{1,2}m)?(?:\d{1,2}s)?|\d{1,4}h(?:\d{1,2}m)?(?:\d{1,2}s)?|\d{1,4}m\d{1,2}s)\b`,
  "i",
);
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const CLOCK_WITH_DATE = /\b(?:try again|resets?|available again)\b[^.\n]{0,12}?\b(?:at|on)\s+([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4}),?\s+(?:at\s+)?(\d{1,2}):(\d{2})\s*([AaPp][Mm])?(?!\s*\()/i;
const CLOCK_ONLY = /\b(?:try again|resets?|available again)\b[^.\n]{0,12}?\bat\s+(\d{1,2})(?::(\d{2}))?\s*([AaPp][Mm])\b(?!\s*\()/i;
const PIPE_EPOCH = /\blimit reached\|(\d{9,11})\b/i;

/**
 * A reset the text states, or undefined. Only explicit forms count: a duration after "resets in" / "try again in",
 * a compact duration such as "4h53m36s" near "resets" or "cap", an ISO timestamp with a zone, Claude Code's
 * `limit reached|<unix seconds>`, a dated clock time, or a clock time with AM/PM read as local time. A clock time
 * followed by a named zone ("resets 7pm (Europe/London)") is not read: its zone is not this machine's.
 */
export function statedResetFromText(text: string, now: number): StatedReset | undefined {
  const epoch = PIPE_EPOCH.exec(text);
  if (epoch) return statedResetFromUnixSeconds(Number(epoch[1]), now);
  const iso = /\b(?:resets?|try again|available again|until)\b[^\n]{0,20}?(\d{4}-\d{2}-\d{2}T[0-9:.]+(?:Z|[+-]\d{2}:?\d{2}))/i.exec(text);
  if (iso) return statedResetFromIso(iso[1], now);
  const duration = DURATION.exec(text);
  if (duration) {
    const ms = durationMs(duration[1]!);
    if (ms !== undefined) return statedResetAt(now + ms, now);
  }
  const compact = COMPACT_DURATION.exec(text);
  if (compact) {
    const ms = durationMs(compact[1]!);
    if (ms !== undefined) return statedResetAt(now + ms, now);
  }
  const dated = CLOCK_WITH_DATE.exec(text);
  if (dated) {
    const month = MONTHS.indexOf(dated[1]!.toLowerCase());
    const hour = clockHour(Number(dated[4]), dated[6]);
    if (month >= 0 && hour !== undefined) {
      const time = new Date(Number(dated[3]), month, Number(dated[2]), hour, Number(dated[5]), 0, 0).getTime();
      return statedResetAt(time, now);
    }
  }
  const clock = CLOCK_ONLY.exec(text);
  if (clock) {
    const hour = clockHour(Number(clock[1]), clock[3]);
    const minute = clock[2] === undefined ? 0 : Number(clock[2]);
    if (hour !== undefined && minute < 60) {
      const base = new Date(now);
      let time = new Date(base.getFullYear(), base.getMonth(), base.getDate(), hour, minute, 0, 0).getTime();
      if (time <= now) time = new Date(base.getFullYear(), base.getMonth(), base.getDate() + 1, hour, minute, 0, 0).getTime();
      return statedResetAt(time, now);
    }
  }
  return undefined;
}

function clockHour(hour: number, meridiem: string | undefined): number | undefined {
  if (!Number.isInteger(hour)) return undefined;
  if (meridiem === undefined) return hour >= 0 && hour < 24 ? hour : undefined;
  if (hour < 1 || hour > 12) return undefined;
  const pm = meridiem.toLowerCase() === "pm";
  return (hour % 12) + (pm ? 12 : 0);
}

function durationMs(text: string): number | undefined {
  let total = 0;
  let parts = 0;
  for (const match of text.matchAll(/(\d{1,4})\s*([a-z]+)/gi)) {
    const unit = DURATION_UNIT_MS[match[2]!.toLowerCase()];
    if (unit === undefined) return undefined;
    total += Number(match[1]) * unit;
    parts += 1;
  }
  return parts > 0 && total > 0 ? total : undefined;
}
