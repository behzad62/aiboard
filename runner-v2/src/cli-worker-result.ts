/**
 * The result a CLI worker ends its turn with (docs/plans/2026-11-14-cli-workers.md §3.5 step 1, packet CW2).
 *
 * Every CLI gets the same schema: Codex through `--output-schema <file>`, agy through `--json-schema <file>`, and
 * Claude Code through `--json-schema <inline JSON>`. Codex's flag needs OpenAI's strict-mode form, so the schema has
 * every field required, `additionalProperties: false`, and the optional fields nullable (CW0 report §9.7). The parser
 * maps `null` to absent and holds every field to a bound. The result is the CLI's claim, never evidence (§3.6).
 *
 * Pure: no I/O.
 */

export const CLI_WORKER_OUTCOMES = ["done", "needs_decision", "cannot_do"] as const;
export type CliWorkerOutcome = typeof CLI_WORKER_OUTCOMES[number];

export interface CliWorkerCheckV1 {
  label: string;
  executable: string;
  args: string[];
  cwd?: string;
  outputs?: string[];
  criterionIds?: string[];
}

export interface CliWorkerResultV1 {
  outcome: CliWorkerOutcome;
  /** At most CLI_RESULT_LIMITS.summary characters. */
  summary: string;
  /** Present for `needs_decision`. */
  question?: string;
  /** Present for `cannot_do`. */
  replanReason?: string;
  /** At most CLI_RESULT_LIMITS.checks. */
  checks: CliWorkerCheckV1[];
  notRun?: { what: string; why: string }[];
  concerns?: string[];
}

/**
 * The bounds the parser holds a result to. Longer text is cut; a check over a bound, or more checks than allowed,
 * are dropped with a concern.
 */
export const CLI_RESULT_LIMITS = Object.freeze({
  summary: 4_000,
  question: 4_000,
  replanReason: 4_000,
  checks: 12,
  label: 200,
  executable: 1_024,
  args: 64,
  arg: 8_192,
  cwd: 1_024,
  outputs: 16,
  output: 1_024,
  criterionIds: 32,
  criterionId: 128,
  notRun: 32,
  notRunText: 1_000,
  concerns: 32,
  concern: 2_000,
});

const NULLABLE_STRING = { type: ["string", "null"] } as const;
const NULLABLE_STRING_ARRAY = { type: ["array", "null"], items: { type: "string" } } as const;

/** `CliWorkerResultV1` in OpenAI's strict-mode form (§3.5 step 1): what every CLI is given. */
export const CLI_WORKER_RESULT_SCHEMA = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["outcome", "summary", "question", "replanReason", "checks", "notRun", "concerns"],
  properties: {
    outcome: { type: "string", enum: [...CLI_WORKER_OUTCOMES] },
    summary: { type: "string" },
    question: NULLABLE_STRING,
    replanReason: NULLABLE_STRING,
    checks: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["label", "executable", "args", "cwd", "outputs", "criterionIds"],
        properties: {
          label: { type: "string" },
          executable: { type: "string" },
          args: { type: "array", items: { type: "string" } },
          cwd: NULLABLE_STRING,
          outputs: NULLABLE_STRING_ARRAY,
          criterionIds: NULLABLE_STRING_ARRAY,
        },
      },
    },
    notRun: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["what", "why"],
        properties: { what: { type: "string" }, why: { type: "string" } },
      },
    },
    concerns: { type: "array", items: { type: "string" } },
  },
});

/** The schema as one line of JSON: the schema file's content, and Claude Code's inline `--json-schema` value. */
export function cliWorkerResultSchemaJson(): string {
  return JSON.stringify(CLI_WORKER_RESULT_SCHEMA);
}

export type CliWorkerResultParse =
  | { ok: true; result: CliWorkerResultV1 }
  | { ok: false; reason: string };

/** Parses result JSON text (a Codex `-o` file, or a `result` event's text). Empty or unparsable text is unreadable. */
export function parseCliWorkerResultText(text: string): CliWorkerResultParse {
  const trimmed = text.replace(/^﻿/, "").trim();
  if (!trimmed) return { ok: false, reason: "The result is empty." };
  let value: unknown;
  try {
    value = JSON.parse(trimmed);
  } catch {
    return { ok: false, reason: "The result is not JSON." };
  }
  return parseCliWorkerResult(value);
}

/** Validates a parsed result object and maps it to `CliWorkerResultV1`: `null` becomes absent, every field is bounded. */
export function parseCliWorkerResult(value: unknown): CliWorkerResultParse {
  if (!isRecord(value)) return { ok: false, reason: "The result is not an object." };
  const outcome = value.outcome;
  if (typeof outcome !== "string" || !(CLI_WORKER_OUTCOMES as readonly string[]).includes(outcome))
    return { ok: false, reason: "The result has no valid outcome." };
  if (typeof value.summary !== "string" || !value.summary.trim()) return { ok: false, reason: "The result has no summary." };
  const question = optionalString(value.question);
  const replanReason = optionalString(value.replanReason);
  if (question === false || replanReason === false) return { ok: false, reason: "The result's question or replanReason is not text." };
  if (outcome === "needs_decision" && !question?.trim()) return { ok: false, reason: "A needs_decision result has no question." };
  if (outcome === "cannot_do" && !replanReason?.trim()) return { ok: false, reason: "A cannot_do result has no replanReason." };
  if (!Array.isArray(value.checks)) return { ok: false, reason: "The result's checks are not a list." };
  const concerns: string[] = [];
  const checks: CliWorkerCheckV1[] = [];
  // A check the parser cannot keep (a field of the wrong type, an empty output path, more args, outputs or criterion
  // ids than allowed) is dropped with a concern, as a 13th check is: one bad claim never throws away the result.
  value.checks.forEach((entry, index) => {
    const check = parseCheck(entry);
    if (check) checks.push(check);
    else concerns.push(`Check ${index + 1} the CLI reported was dropped: it is malformed or over AIBoard's limits.`);
  });
  if (concerns.length > CLI_RESULT_LIMITS.checks) concerns.splice(CLI_RESULT_LIMITS.checks, Infinity, `${concerns.length - CLI_RESULT_LIMITS.checks} more checks were dropped.`);
  if (checks.length > CLI_RESULT_LIMITS.checks) {
    concerns.push(`The CLI reported ${checks.length} checks; only the first ${CLI_RESULT_LIMITS.checks} are kept.`);
    checks.length = CLI_RESULT_LIMITS.checks;
  }
  const notRun = optionalList(value.notRun, (entry) => {
    if (!isRecord(entry) || typeof entry.what !== "string" || typeof entry.why !== "string") return undefined;
    return { what: cut(entry.what, CLI_RESULT_LIMITS.notRunText), why: cut(entry.why, CLI_RESULT_LIMITS.notRunText) };
  });
  if (notRun === false) return { ok: false, reason: "The result's notRun is malformed." };
  const reported = optionalList(value.concerns, (entry) => typeof entry === "string" ? cut(entry, CLI_RESULT_LIMITS.concern) : undefined);
  if (reported === false) return { ok: false, reason: "The result's concerns are malformed." };
  const allConcerns = [...(reported ?? []).slice(0, CLI_RESULT_LIMITS.concerns), ...concerns];
  return {
    ok: true,
    result: {
      outcome: outcome as CliWorkerOutcome,
      summary: cut(value.summary, CLI_RESULT_LIMITS.summary),
      ...(question?.trim() ? { question: cut(question, CLI_RESULT_LIMITS.question) } : {}),
      ...(replanReason?.trim() ? { replanReason: cut(replanReason, CLI_RESULT_LIMITS.replanReason) } : {}),
      checks,
      ...(notRun?.length ? { notRun: notRun.slice(0, CLI_RESULT_LIMITS.notRun) } : {}),
      ...(allConcerns.length ? { concerns: allConcerns } : {}),
    },
  };
}

function parseCheck(entry: unknown): CliWorkerCheckV1 | undefined {
  if (!isRecord(entry)) return undefined;
  const { label, executable, args } = entry;
  if (typeof label !== "string" || typeof executable !== "string" || !executable.trim()) return undefined;
  if (executable.length > CLI_RESULT_LIMITS.executable || executable.includes("\0")) return undefined;
  if (!Array.isArray(args) || args.length > CLI_RESULT_LIMITS.args) return undefined;
  if (!args.every((arg) => typeof arg === "string" && arg.length <= CLI_RESULT_LIMITS.arg && !arg.includes("\0"))) return undefined;
  const cwd = optionalString(entry.cwd);
  if (cwd === false || (cwd !== undefined && (cwd.length > CLI_RESULT_LIMITS.cwd || cwd.includes("\0")))) return undefined;
  const outputs = optionalStringList(entry.outputs, CLI_RESULT_LIMITS.outputs, CLI_RESULT_LIMITS.output);
  const criterionIds = optionalStringList(entry.criterionIds, CLI_RESULT_LIMITS.criterionIds, CLI_RESULT_LIMITS.criterionId);
  if (outputs === false || criterionIds === false) return undefined;
  return {
    label: cut(label, CLI_RESULT_LIMITS.label),
    executable,
    args: [...args] as string[],
    ...(cwd?.trim() ? { cwd } : {}),
    ...(outputs?.length ? { outputs } : {}),
    ...(criterionIds?.length ? { criterionIds } : {}),
  };
}

/** undefined for absent or null; false for a value of the wrong type. */
function optionalString(value: unknown): string | undefined | false {
  if (value === undefined || value === null) return undefined;
  return typeof value === "string" ? value : false;
}

function optionalStringList(value: unknown, maxItems: number, maxLength: number): string[] | undefined | false {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.length > maxItems) return false;
  if (!value.every((item) => typeof item === "string" && item.length > 0 && item.length <= maxLength && !item.includes("\0"))) return false;
  return [...value] as string[];
}

function optionalList<T>(value: unknown, map: (entry: unknown) => T | undefined): T[] | undefined | false {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) return false;
  const items: T[] = [];
  for (const entry of value) {
    const item = map(entry);
    if (item === undefined) return false;
    items.push(item);
  }
  return items;
}

function cut(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
