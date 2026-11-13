/**
 * VF3: the final verification as the Architect's own list of checks (VerificationPlanV2).
 *
 * The Runner offers what it detected as suggested checks; the Architect keeps, changes or skips
 * each one, giving a reason for every skip, and adds its own. The Runner resolves the plan into
 * the exact commands it will launch, records them in the runner-owned execution profile, runs
 * them in the fresh verification checkout and records what happened. It never decides what a
 * project needs. Only the Runner sets `mandatory` (from the project's aiboard-validation.json,
 * VF4); a mandatory check can never be skipped or changed.
 *
 * A run records `verificationContractVersion: 2` when it starts. A run started before VF3 keeps
 * the four fixed categories (final-verification-contracts.ts) to the end.
 */
import { resolve as resolvePath } from "node:path";

import { normalizeOutputPatterns } from "./command-output-files.js";
import {
  parseVerificationNotRun,
  planFinalVerification,
  validateFinalVerificationPlan,
  type FinalVerificationPlan,
  type VerificationNotRun,
} from "./final-verification-contracts.js";
import type { FinalVerificationCommand, FinalVerificationFact, FinalVerificationCommandFact } from "./final-verification-runtime.js";

export const VERIFICATION_CONTRACT_VERSION = 2 as const;

export const VERIFICATION_CHECK_KINDS = ["build", "tests", "start", "other"] as const;
export type VerificationCheckKind = (typeof VERIFICATION_CHECK_KINDS)[number];

export const VERIFICATION_CHECK_ORIGINS = ["detected", "project", "architect"] as const;
export type VerificationCheckOrigin = (typeof VERIFICATION_CHECK_ORIGINS)[number];

/** `{port}` in args is replaced with the port the Runner leases for the check. */
export const VERIFICATION_PORT_PLACEHOLDER = "{port}";

export const VERIFICATION_PLAN_LIMITS = Object.freeze({
  maxChecks: 32,
  maxSteps: 8,
  maxArgs: 64,
  maxArgLength: 4_096,
  maxLabelLength: 200,
  maxReasonLength: 1_000,
  minTimeoutMs: 1_000,
  maxRunTimeoutMs: 30 * 60_000,
  maxStartTimeoutMs: 300_000,
});

const CHECK_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export interface VerificationCommandRunV2 {
  executable: string;
  args: string[];
  /** A directory inside the verification checkout, relative to its root. */
  cwd?: string;
  timeoutMs?: number;
}

export type VerificationReadinessV2 =
  | { http: { path: string; status: number } }
  | { outputLine: string }
  | { exitCode: number };

export interface VerificationStartStepV2 {
  label: string;
  executable: string;
  args: string[];
  timeoutMs?: number;
  outputs?: string[];
}

export interface VerificationStartV2 {
  executable: string;
  args: string[];
  timeoutMs?: number;
  ready: VerificationReadinessV2;
  steps?: VerificationStartStepV2[];
}

export interface VerificationCheckV2 {
  /** Stable within the run. */
  id: string;
  label: string;
  kind: VerificationCheckKind;
  origin: VerificationCheckOrigin;
  /** Only the Runner sets it, from aiboard-validation.json; the Architect cannot. */
  mandatory: boolean;
  /** build, tests and other. */
  run?: VerificationCommandRunV2;
  /** start: run a program and see that it works. */
  start?: VerificationStartV2;
  /** Workspace-relative paths or globs kept as evidence (VF6). */
  outputs?: string[];
}

export interface VerificationSkippedCheckV2 {
  checkId: string;
  reason: string;
}

export interface VerificationPlanV2 {
  version: 2;
  checks: VerificationCheckV2[];
  /** Suggested checks the Architect drops, each with its reason. */
  skipped: VerificationSkippedCheckV2[];
}

/** What a check the Runner did not run carries: its tool is missing, or the plan skipped it. */
export type VerificationNotRunV2 =
  | VerificationNotRun
  | { reason: "skipped"; detail: string };

export type VerificationCheckOutcome = "passed" | "failed" | "not_run";

/** The Runner's mechanical result for one v2 check. */
export interface VerificationCheckResultV2 {
  checkId: string;
  kind: VerificationCheckKind;
  label: string;
  origin: VerificationCheckOrigin;
  mandatory: boolean;
  outcome: VerificationCheckOutcome;
  /** True only when the outcome is `passed`. */
  green: boolean;
  evidenceIds: string[];
  facts: readonly FinalVerificationFact[];
  issues: string[];
  notRun?: VerificationNotRunV2;
}

/**
 * How the Runner runs a resolved check, which is also the `category` of each fact it records:
 * `command` (a one-shot command, facts `build`), `tests` (a one-shot command with the Runner's
 * test-report wiring, facts `tests`), `program` (a managed program that must become ready on
 * HTTP or an output line, then the steps against it, facts `runtime_smoke`) and `exit` (a
 * program that must exit with a code, then the steps, facts `build`).
 */
export type ResolvedVerificationMode = "command" | "tests" | "program" | "exit";

export interface ResolvedVerificationCommandV2 extends FinalVerificationCommand {
  /** Absolute directory inside the checkout is derived at run time from this relative one. */
  cwd?: string;
  outputs?: string[];
}

/** One plan check as the exact commands the Runner launches. Recorded in the execution profile. */
export interface ResolvedVerificationCheckV2 {
  checkId: string;
  label: string;
  kind: VerificationCheckKind;
  origin: VerificationCheckOrigin;
  mandatory: boolean;
  mode: ResolvedVerificationMode;
  /** The check's command, or the program first and then its steps. */
  commands: ResolvedVerificationCommandV2[];
  /** Kept after the whole check, as outputs of its first fact. */
  outputs?: string[];
  /** program mode: the HTTP readiness probe on the leased port. */
  endpoint?: string;
  expectedStatus?: number;
  /** program mode: the line the program prints when it is ready. */
  outputLine?: string;
  /** exit mode: the exit code that means the program works. */
  expectedExitCode?: number;
  /** program mode: how long readiness may take. */
  readinessTimeoutMs?: number;
}

/** The plan as the Runner will run it; part of the runner-owned execution profile. */
export interface VerificationPlanResolution {
  version: 2;
  /** The suggestions the Runner offered for this revision. */
  suggestions: VerificationCheckV2[];
  checks: ResolvedVerificationCheckV2[];
}

/** The Runner's suggested checks for the Architect's plan (the v2 plan prefill). */
export interface VerificationPlanPrefillV2 {
  version: 2;
  targetRevision: string;
  profileDigest: string;
  suggestedChecks: VerificationCheckV2[];
}

export function isVerificationPlanV2(plan: unknown): plan is VerificationPlanV2 {
  return isRecord(plan) && plan.version === 2;
}

/** A generation's plan: the four v1 categories, or the v2 list of checks. */
export type AnyFinalVerificationPlan = FinalVerificationPlan | VerificationPlanV2;

/** Validate and clone either contract's plan at a durable boundary (structure only). */
export function planAnyFinalVerification(plan: unknown): AnyFinalVerificationPlan {
  return isVerificationPlanV2(plan) ? planVerificationV2(plan) : planFinalVerification(plan);
}

/** Structural validation of either contract's plan. */
export function validateAnyFinalVerificationPlan(plan: unknown): { valid: boolean; issues: string[] } {
  if (isVerificationPlanV2(plan)) return validateVerificationPlanV2(plan);
  const validation = validateFinalVerificationPlan(plan);
  return { valid: validation.valid, issues: validation.issues };
}

export function isVerificationCheckResultV2(check: unknown): check is VerificationCheckResultV2 {
  return isRecord(check) && typeof check.checkId === "string";
}

/** The key a check is known by: its id on v2, its category on v1. */
export function verificationCheckKey(check: { checkId?: unknown; category?: unknown }): string {
  return typeof check.checkId === "string" ? check.checkId : String(check.category);
}

export function factCategoryForMode(mode: ResolvedVerificationMode): "build" | "tests" | "runtime_smoke" {
  return mode === "tests" ? "tests" : mode === "program" ? "runtime_smoke" : "build";
}

// ---------------------------------------------------------------------------
// Plan validation
// ---------------------------------------------------------------------------

export interface VerificationPlanV2Validation {
  valid: boolean;
  issues: string[];
}

/**
 * Structural validation of a v2 plan, and with `suggestions` the rules the Runner holds the
 * Architect to: every suggested check is kept, changed or skipped with a reason; a mandatory
 * check is neither skipped nor changed; `origin` and `mandatory` are the Runner's.
 */
export function validateVerificationPlanV2(
  plan: unknown,
  options: { suggestions?: readonly VerificationCheckV2[] } = {},
): VerificationPlanV2Validation {
  const issues: string[] = [];
  if (!isRecord(plan) || plan.version !== 2) {
    return { valid: false, issues: ["The verification plan must be version 2."] };
  }
  const unknownKeys = Object.keys(plan).filter((key) => !["version", "checks", "skipped"].includes(key));
  if (unknownKeys.length) issues.push(`The verification plan has unknown fields: ${unknownKeys.join(", ")}.`);
  if (!Array.isArray(plan.checks)) issues.push("The verification plan requires a checks array.");
  if (!Array.isArray(plan.skipped)) issues.push("The verification plan requires a skipped array (it may be empty).");
  if (issues.length) return { valid: false, issues };
  const checks = plan.checks as unknown[];
  const skipped = plan.skipped as unknown[];
  if (checks.length > VERIFICATION_PLAN_LIMITS.maxChecks) {
    issues.push(`The verification plan allows at most ${VERIFICATION_PLAN_LIMITS.maxChecks} checks.`);
  }
  const ids = new Set<string>();
  for (const [index, candidate] of checks.entries()) {
    issues.push(...checkIssues(candidate, index, true));
    if (isRecord(candidate) && typeof candidate.id === "string") {
      if (ids.has(candidate.id)) issues.push(`Check id ${candidate.id} is used more than once.`);
      ids.add(candidate.id);
    }
  }
  const skippedIds = new Set<string>();
  for (const [index, candidate] of skipped.entries()) {
    if (!isRecord(candidate) || Object.keys(candidate).some((key) => key !== "checkId" && key !== "reason")) {
      issues.push(`skipped[${index}] must be { checkId, reason }.`);
      continue;
    }
    if (typeof candidate.checkId !== "string" || !CHECK_ID_PATTERN.test(candidate.checkId)) {
      issues.push(`skipped[${index}].checkId is not a check id.`);
      continue;
    }
    if (!nonEmpty(candidate.reason) || candidate.reason.length > VERIFICATION_PLAN_LIMITS.maxReasonLength) {
      issues.push(`Skipping ${candidate.checkId} needs a reason of 1 to ${VERIFICATION_PLAN_LIMITS.maxReasonLength} characters.`);
    }
    if (skippedIds.has(candidate.checkId)) issues.push(`Check ${candidate.checkId} is skipped more than once.`);
    if (ids.has(candidate.checkId)) issues.push(`Check ${candidate.checkId} is both planned and skipped.`);
    skippedIds.add(candidate.checkId);
  }
  if (checks.length === 0 && skipped.length === 0 && options.suggestions?.length) {
    issues.push("The verification plan has no checks.");
  }
  if (options.suggestions && issues.length === 0) {
    issues.push(...suggestionIssues(plan as unknown as VerificationPlanV2, options.suggestions));
  }
  return { valid: issues.length === 0, issues };
}

export function assertVerificationPlanV2(
  plan: unknown,
  options: { suggestions?: readonly VerificationCheckV2[] } = {},
): asserts plan is VerificationPlanV2 {
  const validation = validateVerificationPlanV2(plan, options);
  if (!validation.valid) throw new Error(validation.issues.join(" "));
}

/** Validate and clone a v2 plan at a durable boundary. */
export function planVerificationV2(
  plan: unknown,
  options: { suggestions?: readonly VerificationCheckV2[] } = {},
): VerificationPlanV2 {
  assertVerificationPlanV2(plan, options);
  return {
    version: 2,
    checks: plan.checks.map(cloneCheck),
    skipped: plan.skipped.map((entry) => ({ checkId: entry.checkId, reason: entry.reason })),
  };
}

/**
 * The Architect's plan_final_verification input as a full plan: the Runner fills in each check's
 * origin and mandatory flag from its suggestions. The Architect may echo them; a value that
 * differs from the Runner's is refused.
 */
export function completeVerificationPlanV2(
  input: unknown,
  suggestions: readonly VerificationCheckV2[],
): { ok: true; plan: VerificationPlanV2 } | { ok: false; issues: string[] } {
  if (!isRecord(input) || (input.version !== undefined && input.version !== 2)) {
    return { ok: false, issues: ["plan must be { version: 2, checks, skipped }."] };
  }
  if (!Array.isArray(input.checks)) return { ok: false, issues: ["plan.checks must be an array."] };
  const bySuggestion = new Map(suggestions.map((check) => [check.id, check]));
  const issues: string[] = [];
  const checks = input.checks.map((candidate, index) => {
    if (!isRecord(candidate)) return candidate;
    const suggestion = typeof candidate.id === "string" ? bySuggestion.get(candidate.id) : undefined;
    const origin: VerificationCheckOrigin = suggestion?.origin ?? "architect";
    const mandatory = suggestion?.mandatory ?? false;
    if (candidate.origin !== undefined && candidate.origin !== origin) {
      issues.push(`checks[${index}].origin is set by the Runner (${origin}).`);
    }
    if (candidate.mandatory !== undefined && candidate.mandatory !== mandatory) {
      issues.push(`checks[${index}].mandatory is set only by the Runner, from aiboard-validation.json (${String(mandatory)}).`);
    }
    return { ...candidate, origin, mandatory };
  });
  if (issues.length) return { ok: false, issues };
  const plan = { version: 2, checks, skipped: input.skipped ?? [] };
  const validation = validateVerificationPlanV2(plan, { suggestions });
  if (!validation.valid) return { ok: false, issues: validation.issues };
  return { ok: true, plan: planVerificationV2(plan) };
}

function suggestionIssues(plan: VerificationPlanV2, suggestions: readonly VerificationCheckV2[]): string[] {
  const issues: string[] = [];
  const bySuggestion = new Map(suggestions.map((check) => [check.id, check]));
  const planned = new Map(plan.checks.map((check) => [check.id, check]));
  const skipped = new Set(plan.skipped.map((entry) => entry.checkId));
  for (const check of plan.checks) {
    const suggestion = bySuggestion.get(check.id);
    if (!suggestion) {
      if (check.origin !== "architect") issues.push(`Check ${check.id} is not one the Runner suggested, so its origin is architect.`);
      if (check.mandatory) issues.push(`Check ${check.id} cannot be mandatory: only the project's aiboard-validation.json makes a check mandatory.`);
      continue;
    }
    if (check.origin !== suggestion.origin) issues.push(`Check ${check.id} keeps the origin ${suggestion.origin} the Runner gave it.`);
    if (check.mandatory !== suggestion.mandatory) issues.push(`Check ${check.id} keeps mandatory ${String(suggestion.mandatory)}: only the Runner sets it.`);
    if (suggestion.mandatory && !sameValue(cloneCheck(check), cloneCheck(suggestion))) {
      issues.push(`Check ${check.id} is mandatory and cannot be changed.`);
    }
  }
  for (const entry of plan.skipped) {
    const suggestion = bySuggestion.get(entry.checkId);
    if (!suggestion) {
      issues.push(`Skipped check ${entry.checkId} is not one the Runner suggested; leave out a check of your own instead of skipping it.`);
      continue;
    }
    if (suggestion.mandatory) issues.push(`Check ${entry.checkId} is mandatory and cannot be skipped.`);
  }
  for (const suggestion of suggestions) {
    if (!planned.has(suggestion.id) && !skipped.has(suggestion.id)) {
      issues.push(`Suggested check ${suggestion.id} must be kept, changed, or listed in skipped with a reason.`);
    }
  }
  return issues;
}

function checkIssues(candidate: unknown, index: number, full: boolean): string[] {
  const at = `checks[${index}]`;
  if (!isRecord(candidate)) return [`${at} must be an object.`];
  const issues: string[] = [];
  const allowed = ["id", "label", "kind", "origin", "mandatory", "run", "start", "outputs"];
  const unknown = Object.keys(candidate).filter((key) => !allowed.includes(key));
  if (unknown.length) issues.push(`${at} has unknown fields: ${unknown.join(", ")}.`);
  const id = candidate.id;
  if (typeof id !== "string" || !CHECK_ID_PATTERN.test(id)) {
    issues.push(`${at}.id must be 1 to 64 lowercase letters, digits, '.', '_' or '-', starting with a letter or digit.`);
  }
  const name = typeof id === "string" ? id : at;
  if (!nonEmpty(candidate.label) || candidate.label.length > VERIFICATION_PLAN_LIMITS.maxLabelLength) {
    issues.push(`Check ${name} needs a label of 1 to ${VERIFICATION_PLAN_LIMITS.maxLabelLength} characters.`);
  }
  const kind = candidate.kind;
  if (typeof kind !== "string" || !(VERIFICATION_CHECK_KINDS as readonly string[]).includes(kind)) {
    issues.push(`Check ${name} kind must be build, tests, start or other.`);
  }
  if (full) {
    if (typeof candidate.origin !== "string" || !(VERIFICATION_CHECK_ORIGINS as readonly string[]).includes(candidate.origin)) {
      issues.push(`Check ${name} origin must be detected, project or architect.`);
    }
    if (typeof candidate.mandatory !== "boolean") issues.push(`Check ${name} mandatory must be a boolean.`);
  }
  if (kind === "start") {
    if (candidate.run !== undefined) issues.push(`Check ${name} is a start check: give start, not run.`);
    issues.push(...startIssues(candidate.start, name));
  } else if (typeof kind === "string") {
    if (candidate.start !== undefined) issues.push(`Check ${name} is a ${kind} check: give run, not start.`);
    issues.push(...runIssues(candidate.run, name));
  }
  if (candidate.outputs !== undefined) issues.push(...outputsIssues(candidate.outputs, `Check ${name} outputs`));
  return issues;
}

function runIssues(value: unknown, name: string): string[] {
  if (!isRecord(value)) return [`Check ${name} needs run: { executable, args }.`];
  const issues: string[] = [];
  const unknown = Object.keys(value).filter((key) => !["executable", "args", "cwd", "timeoutMs"].includes(key));
  if (unknown.length) issues.push(`Check ${name} run has unknown fields: ${unknown.join(", ")}.`);
  issues.push(...commandIssues(value, `Check ${name} run`));
  if (value.cwd !== undefined && !relativeDirectory(value.cwd)) {
    issues.push(`Check ${name} run.cwd must be a directory inside the checkout, relative to its root (no '..', absolute or ':' paths).`);
  }
  issues.push(...timeoutIssues(value.timeoutMs, VERIFICATION_PLAN_LIMITS.maxRunTimeoutMs, `Check ${name} run.timeoutMs`));
  return issues;
}

function startIssues(value: unknown, name: string): string[] {
  if (!isRecord(value)) return [`Check ${name} needs start: { executable, args, ready }.`];
  const issues: string[] = [];
  const unknown = Object.keys(value).filter((key) => !["executable", "args", "timeoutMs", "ready", "steps"].includes(key));
  if (unknown.length) issues.push(`Check ${name} start has unknown fields: ${unknown.join(", ")}.`);
  issues.push(...commandIssues(value, `Check ${name} start`));
  issues.push(...timeoutIssues(value.timeoutMs, VERIFICATION_PLAN_LIMITS.maxStartTimeoutMs, `Check ${name} start.timeoutMs`));
  const ready = value.ready;
  const readyKeys = isRecord(ready) ? Object.keys(ready) : [];
  if (!isRecord(ready) || readyKeys.length !== 1) {
    issues.push(`Check ${name} start.ready must be exactly one of { http: { path, status } }, { outputLine } or { exitCode }.`);
  } else if (readyKeys[0] === "http") {
    const http = ready.http;
    if (!isRecord(http) || Object.keys(http).some((key) => key !== "path" && key !== "status") ||
      typeof http.path !== "string" || !/^\/[^\s?#]*(?:\?[^\s#]*)?$/.test(http.path) ||
      !Number.isSafeInteger(http.status) || (http.status as number) < 100 || (http.status as number) > 599) {
      issues.push(`Check ${name} start.ready.http needs a path such as /healthz and an HTTP status from 100 to 599.`);
    }
    if (Array.isArray(value.args) && !value.args.some((arg) => typeof arg === "string" && arg.includes(VERIFICATION_PORT_PLACEHOLDER))) {
      issues.push(`Check ${name} is ready on HTTP, so start.args must pass the Runner-leased port as ${VERIFICATION_PORT_PLACEHOLDER}; the Runner owns the port.`);
    }
  } else if (readyKeys[0] === "outputLine") {
    if (!nonEmpty(ready.outputLine) || ready.outputLine.length > 512) {
      issues.push(`Check ${name} start.ready.outputLine must be 1 to 512 characters the program prints when it is ready.`);
    }
  } else if (readyKeys[0] === "exitCode") {
    if (!Number.isSafeInteger(ready.exitCode) || (ready.exitCode as number) < 0 || (ready.exitCode as number) > 255) {
      issues.push(`Check ${name} start.ready.exitCode must be an integer from 0 to 255.`);
    }
  } else {
    issues.push(`Check ${name} start.ready must be exactly one of { http: { path, status } }, { outputLine } or { exitCode }.`);
  }
  if (value.steps !== undefined) {
    if (!Array.isArray(value.steps) || value.steps.length > VERIFICATION_PLAN_LIMITS.maxSteps) {
      issues.push(`Check ${name} start.steps must be an array of at most ${VERIFICATION_PLAN_LIMITS.maxSteps} steps.`);
    } else {
      for (const [index, step] of value.steps.entries()) {
        const at = `Check ${name} start.steps[${index}]`;
        if (!isRecord(step)) { issues.push(`${at} must be an object.`); continue; }
        const extra = Object.keys(step).filter((key) => !["label", "executable", "args", "timeoutMs", "outputs"].includes(key));
        if (extra.length) issues.push(`${at} has unknown fields: ${extra.join(", ")}.`);
        if (!nonEmpty(step.label) || step.label.length > VERIFICATION_PLAN_LIMITS.maxLabelLength) issues.push(`${at}.label must name the step.`);
        issues.push(...commandIssues(step, at));
        issues.push(...timeoutIssues(step.timeoutMs, VERIFICATION_PLAN_LIMITS.maxStartTimeoutMs, `${at}.timeoutMs`));
        if (step.outputs !== undefined) issues.push(...outputsIssues(step.outputs, `${at}.outputs`));
      }
    }
  }
  return issues;
}

function commandIssues(value: Record<string, unknown>, at: string): string[] {
  const issues: string[] = [];
  if (!nonEmpty(value.executable) || value.executable.includes("\0") || value.executable.length > 1_024) {
    issues.push(`${at}.executable must be a program name such as node.`);
  }
  if (!Array.isArray(value.args) || value.args.length > VERIFICATION_PLAN_LIMITS.maxArgs ||
    value.args.some((arg) => typeof arg !== "string" || arg.includes("\0") || arg.length > VERIFICATION_PLAN_LIMITS.maxArgLength)) {
    issues.push(`${at}.args must be at most ${VERIFICATION_PLAN_LIMITS.maxArgs} strings without NUL characters.`);
  }
  return issues;
}

function timeoutIssues(value: unknown, maximum: number, at: string): string[] {
  if (value === undefined) return [];
  return Number.isSafeInteger(value) && (value as number) >= VERIFICATION_PLAN_LIMITS.minTimeoutMs && (value as number) <= maximum
    ? []
    : [`${at} must be an integer from ${VERIFICATION_PLAN_LIMITS.minTimeoutMs} to ${maximum}.`];
}

function outputsIssues(value: unknown, at: string): string[] {
  const normalized = normalizeOutputPatterns(value);
  if (!normalized.ok) return normalized.issues.map((issue) => `${at}: ${issue}.`);
  if (!Array.isArray(value) || normalized.patterns.length !== value.length ||
    normalized.patterns.some((pattern, index) => pattern !== value[index])) {
    return [`${at} must be written normalized: ${JSON.stringify(normalized.patterns)}.`];
  }
  return [];
}

function relativeDirectory(value: unknown): value is string {
  if (!nonEmpty(value) || value.length > 512 || value.includes("\0") || value.includes(":")) return false;
  const slashed = value.replace(/\\/g, "/");
  if (slashed.startsWith("/") || slashed.startsWith("~")) return false;
  const segments = slashed.split("/").filter((segment) => segment !== "" && segment !== ".");
  return segments.length > 0 && !segments.includes("..");
}

// ---------------------------------------------------------------------------
// Suggestions and resolution
// ---------------------------------------------------------------------------

export interface DetectedVerificationSource {
  build?: readonly FinalVerificationCommand[];
  tests?: readonly FinalVerificationCommand[];
  /** A detected server program (Vite preview, Next start) on the leased port. */
  server?: {
    label: string;
    executable: string;
    args: readonly string[];
    endpoint?: string;
    timeoutMs?: number;
    readiness: { timeoutMs?: number; expectedStatus?: number };
    steps?: readonly FinalVerificationCommand[];
  };
  port?: number;
}

export interface VerificationSuggestion {
  check: VerificationCheckV2;
  /** The exact commands the Runner launches when the Architect keeps the check unchanged. */
  resolved: ResolvedVerificationCheckV2;
}

/**
 * The Runner's detected commands as suggested checks (origin `detected`, never mandatory): one
 * check per detected build command and per test command, and a `start` check for a detected Vite
 * or Next server, ready on HTTP on the leased port. There is no browser check: browsing comes
 * from Playwright CLI steps later (VF7b).
 */
export function detectedVerificationSuggestions(source: DetectedVerificationSource): VerificationSuggestion[] {
  const suggestions: VerificationSuggestion[] = [];
  const commandSuggestions = (kind: "build" | "tests", commands: readonly FinalVerificationCommand[] | undefined) => {
    for (const [index, command] of (commands ?? []).entries()) {
      const id = index === 0 ? kind : `${kind}-${index + 1}`;
      const check: VerificationCheckV2 = {
        id,
        label: command.label,
        kind,
        origin: "detected",
        mandatory: false,
        run: {
          executable: command.executable,
          args: [...command.args],
          ...(command.timeoutMs !== undefined ? { timeoutMs: command.timeoutMs } : {}),
        },
      };
      suggestions.push({
        check,
        resolved: {
          checkId: id,
          label: command.label,
          kind,
          origin: "detected",
          mandatory: false,
          mode: kind === "tests" ? "tests" : "command",
          commands: [cloneResolvedCommand({ ...command, label: command.label })],
        },
      });
    }
  };
  commandSuggestions("build", source.build);
  commandSuggestions("tests", source.tests);
  const server = source.server;
  if (server && source.port !== undefined) {
    const placeholder = (args: readonly string[]) => args.map((arg) => arg === String(source.port) ? VERIFICATION_PORT_PLACEHOLDER : arg);
    const endpoint = server.endpoint ? new URL(server.endpoint) : undefined;
    const status = server.readiness.expectedStatus ?? 200;
    const timeoutMs = server.readiness.timeoutMs ?? server.timeoutMs;
    const check: VerificationCheckV2 = {
      id: "start",
      label: server.label,
      kind: "start",
      origin: "detected",
      mandatory: false,
      start: {
        executable: server.executable,
        args: placeholder(server.args),
        ...(timeoutMs !== undefined ? { timeoutMs } : {}),
        ready: { http: { path: endpoint ? `${endpoint.pathname}${endpoint.search}` : "/", status } },
        ...(server.steps?.length ? {
          steps: server.steps.map((step) => ({ label: step.label, executable: step.executable, args: placeholder(step.args) })),
        } : {}),
      },
    };
    suggestions.push({
      check,
      resolved: {
        checkId: "start",
        label: server.label,
        kind: "start",
        origin: "detected",
        mandatory: false,
        mode: "program",
        commands: [
          { label: server.label, executable: server.executable, args: [...server.args], ...(server.timeoutMs !== undefined ? { timeoutMs: server.timeoutMs } : {}) },
          ...(server.steps ?? []).map((step) => cloneResolvedCommand({ ...step, label: `${server.label} › ${step.label}` })),
        ],
        ...(server.endpoint ? { endpoint: server.endpoint } : {}),
        expectedStatus: status,
        ...(timeoutMs !== undefined ? { readinessTimeoutMs: timeoutMs } : {}),
      },
    });
  }
  return suggestions;
}

/** True when a plan check launches commands the Architect wrote, not the Runner's suggestion. */
export function verificationCheckNamesArchitectCommands(
  check: VerificationCheckV2,
  suggestion: VerificationCheckV2 | undefined,
): boolean {
  if (!suggestion) return true;
  return !sameValue(commandSpec(check), commandSpec(suggestion));
}

/**
 * Resolve every plan check into the commands the Runner launches. A suggested check whose
 * commands are unchanged runs exactly as detected; any other check runs as written, with
 * {port} replaced by the leased port and `node` by the Runner's own Node.
 */
export function resolveVerificationPlanV2(input: {
  plan: VerificationPlanV2;
  suggestions: readonly VerificationSuggestion[];
  port?: number;
  nodeExecutable?: string;
}): ResolvedVerificationCheckV2[] {
  const bySuggestion = new Map(input.suggestions.map((suggestion) => [suggestion.check.id, suggestion]));
  return input.plan.checks.map((check) => {
    const suggestion = bySuggestion.get(check.id);
    const base = {
      checkId: check.id,
      label: check.label,
      kind: check.kind,
      origin: check.origin,
      mandatory: check.mandatory,
      ...(check.outputs?.length ? { outputs: [...check.outputs] } : {}),
    };
    if (suggestion && !verificationCheckNamesArchitectCommands(check, suggestion.check)) {
      const commands = suggestion.resolved.commands.map(cloneResolvedCommand);
      const steps = check.start?.steps ?? [];
      return {
        ...cloneResolved(suggestion.resolved),
        ...base,
        commands: commands.map((command, index) => ({
          ...command,
          label: index === 0 ? check.label : `${check.label} › ${steps[index - 1]?.label ?? command.label}`,
          ...(index > 0 && steps[index - 1]?.outputs?.length ? { outputs: [...steps[index - 1]!.outputs!] } : {}),
        })),
      };
    }
    const substitute = (args: readonly string[]) => {
      if (!args.some((arg) => arg.includes(VERIFICATION_PORT_PLACEHOLDER))) return [...args];
      if (input.port === undefined) throw new Error(`Check ${check.id} uses ${VERIFICATION_PORT_PLACEHOLDER}, but the Runner leased no port.`);
      return args.map((arg) => arg.replaceAll(VERIFICATION_PORT_PLACEHOLDER, String(input.port)));
    };
    const executable = (name: string) => name === "node" && input.nodeExecutable ? input.nodeExecutable : name;
    if (check.kind !== "start") {
      const run = check.run!;
      return {
        ...base,
        mode: check.kind === "tests" ? "tests" as const : "command" as const,
        commands: [{
          label: check.label,
          executable: executable(run.executable),
          args: substitute(run.args),
          ...(run.timeoutMs !== undefined ? { timeoutMs: run.timeoutMs } : {}),
          ...(run.cwd !== undefined ? { cwd: normalizeRelative(run.cwd) } : {}),
        }],
      };
    }
    const start = check.start!;
    const program: ResolvedVerificationCommandV2 = {
      label: check.label,
      executable: executable(start.executable),
      args: substitute(start.args),
      ...(start.timeoutMs !== undefined ? { timeoutMs: start.timeoutMs } : {}),
    };
    const steps = (start.steps ?? []).map((step): ResolvedVerificationCommandV2 => ({
      label: `${check.label} › ${step.label}`,
      executable: executable(step.executable),
      args: substitute(step.args),
      ...(step.timeoutMs !== undefined ? { timeoutMs: step.timeoutMs } : {}),
      ...(step.outputs?.length ? { outputs: [...step.outputs] } : {}),
    }));
    const ready = start.ready;
    if ("exitCode" in ready) {
      return { ...base, mode: "exit" as const, commands: [program, ...steps], expectedExitCode: ready.exitCode };
    }
    const timeoutMs = start.timeoutMs ?? 120_000;
    if ("http" in ready) {
      if (input.port === undefined) throw new Error(`Check ${check.id} is ready on HTTP, but the Runner leased no port.`);
      return {
        ...base,
        mode: "program" as const,
        commands: [{ ...program, timeoutMs }, ...steps],
        endpoint: `http://127.0.0.1:${input.port}${ready.http.path}`,
        expectedStatus: ready.http.status,
        readinessTimeoutMs: timeoutMs,
      };
    }
    return {
      ...base,
      mode: "program" as const,
      commands: [{ ...program, timeoutMs }, ...steps],
      outputLine: ready.outputLine,
      readinessTimeoutMs: timeoutMs,
    };
  });
}

/** Whether resolving the plan needs a leased port. */
export function verificationPlanNeedsPort(plan: VerificationPlanV2, suggestions: readonly VerificationSuggestion[]): boolean {
  const bySuggestion = new Map(suggestions.map((suggestion) => [suggestion.check.id, suggestion]));
  return plan.checks.some((check) => {
    const suggestion = bySuggestion.get(check.id);
    if (suggestion && !verificationCheckNamesArchitectCommands(check, suggestion.check)) {
      return suggestion.resolved.endpoint !== undefined;
    }
    const args = [...(check.run?.args ?? []), ...(check.start?.args ?? []), ...(check.start?.steps ?? []).flatMap((step) => step.args)];
    return args.some((arg) => arg.includes(VERIFICATION_PORT_PLACEHOLDER)) ||
      Boolean(check.start && "http" in check.start.ready);
  });
}

/** The tools a resolved check launches, for the Runner's PATH lookup (VF2). */
export function resolvedCheckTools(
  check: ResolvedVerificationCheckV2,
  provisioning?: { executable: string },
): string[] {
  return [...new Set([...(provisioning ? [provisioning.executable] : []), ...check.commands.map((command) => command.executable)])];
}

// ---------------------------------------------------------------------------
// Resolution validation (execution profile)
// ---------------------------------------------------------------------------

export function assertVerificationPlanResolution(value: unknown, port: number | undefined): asserts value is VerificationPlanResolution {
  if (!isRecord(value) || value.version !== 2 || !Array.isArray(value.suggestions) || !Array.isArray(value.checks)) {
    throw new Error("Final verification v2 resolution is invalid.");
  }
  for (const [index, suggestion] of value.suggestions.entries()) {
    const issues = checkIssues(suggestion, index, true);
    if (issues.length) throw new Error(`Final verification v2 suggestion is invalid: ${issues.join(" ")}`);
  }
  const ids = new Set<string>();
  for (const check of value.checks) {
    if (!isRecord(check) || typeof check.checkId !== "string" || !CHECK_ID_PATTERN.test(check.checkId) || ids.has(check.checkId)) {
      throw new Error("Final verification v2 resolved check identity is invalid.");
    }
    ids.add(check.checkId);
    if (!nonEmpty(check.label) || !(VERIFICATION_CHECK_KINDS as readonly string[]).includes(String(check.kind)) ||
      !(VERIFICATION_CHECK_ORIGINS as readonly string[]).includes(String(check.origin)) || typeof check.mandatory !== "boolean") {
      throw new Error(`Final verification v2 resolved check ${check.checkId} is invalid.`);
    }
    const mode = check.mode;
    if (mode !== "command" && mode !== "tests" && mode !== "program" && mode !== "exit") {
      throw new Error(`Final verification v2 resolved check ${check.checkId} mode is invalid.`);
    }
    if ((check.kind === "start") !== (mode === "program" || mode === "exit") || (check.kind === "tests") !== (mode === "tests")) {
      throw new Error(`Final verification v2 resolved check ${check.checkId} mode does not fit its kind.`);
    }
    if (!Array.isArray(check.commands) || check.commands.length === 0 ||
      ((mode === "command" || mode === "tests") && check.commands.length !== 1) ||
      check.commands.length > VERIFICATION_PLAN_LIMITS.maxSteps + 1 ||
      check.commands.some((command) => !validResolvedCommand(command))) {
      throw new Error(`Final verification v2 resolved check ${check.checkId} commands are invalid.`);
    }
    if (check.outputs !== undefined && outputsIssues(check.outputs, "outputs").length > 0) {
      throw new Error(`Final verification v2 resolved check ${check.checkId} outputs are invalid.`);
    }
    if (mode === "program") {
      const http = check.endpoint !== undefined;
      if (http === (check.outputLine !== undefined)) {
        throw new Error(`Final verification v2 resolved check ${check.checkId} needs exactly one readiness rule.`);
      }
      if (http) {
        const url = new URL(String(check.endpoint));
        if (url.hostname !== "127.0.0.1" || port === undefined || Number(url.port) !== port) {
          throw new Error(`Final verification v2 resolved check ${check.checkId} endpoint disagrees with the owned port lease.`);
        }
        if (!Number.isSafeInteger(check.expectedStatus)) throw new Error(`Final verification v2 resolved check ${check.checkId} status is invalid.`);
      } else if (!nonEmpty(check.outputLine)) {
        throw new Error(`Final verification v2 resolved check ${check.checkId} output line is invalid.`);
      }
      if (check.expectedExitCode !== undefined) throw new Error(`Final verification v2 resolved check ${check.checkId} mixes readiness rules.`);
    } else if (mode === "exit") {
      if (!Number.isSafeInteger(check.expectedExitCode) || check.endpoint !== undefined || check.outputLine !== undefined) {
        throw new Error(`Final verification v2 resolved check ${check.checkId} exit code is invalid.`);
      }
    } else if (check.endpoint !== undefined || check.outputLine !== undefined || check.expectedExitCode !== undefined) {
      throw new Error(`Final verification v2 resolved check ${check.checkId} has readiness for a command check.`);
    }
  }
}

function validResolvedCommand(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return nonEmpty(value.label) && nonEmpty(value.executable) && Array.isArray(value.args) &&
    value.args.every((arg) => typeof arg === "string") &&
    (value.timeoutMs === undefined || (Number.isSafeInteger(value.timeoutMs) && (value.timeoutMs as number) > 0)) &&
    (value.cwd === undefined || relativeDirectory(value.cwd)) &&
    (value.outputs === undefined || outputsIssues(value.outputs, "outputs").length === 0) &&
    (value.environment === undefined || (isRecord(value.environment) &&
      Object.values(value.environment).every((entry) => entry === undefined || typeof entry === "string")));
}

export function cloneVerificationPlanResolution(value: VerificationPlanResolution): VerificationPlanResolution {
  return {
    version: 2,
    suggestions: value.suggestions.map(cloneCheck),
    checks: value.checks.map(cloneResolved),
  };
}

// ---------------------------------------------------------------------------
// Check results: one mechanical authority for scheduler append/replay and submission
// ---------------------------------------------------------------------------

/** Validate and clone a v2 not-run record. Only `tool_missing` comes from a run; `skipped` from the plan. */
export function parseVerificationNotRunV2(value: unknown, label: string): VerificationNotRunV2 {
  if (isRecord(value) && value.reason === "skipped") {
    if (Object.keys(value).some((key) => key !== "reason" && key !== "detail") || !nonEmpty(value.detail) ||
      value.detail.length > VERIFICATION_PLAN_LIMITS.maxReasonLength) {
      throw new Error(`${label} not-run record is invalid.`);
    }
    return { reason: "skipped", detail: value.detail };
  }
  return parseVerificationNotRun(value, label);
}

/**
 * The result of one executed v2 check against the resolved check in the execution profile:
 * identity, outcome, and every fact in launch order with its exact command and workspace.
 */
export function assertVerificationCheckV2Semantics(input: {
  check: unknown;
  resolution: VerificationPlanResolution;
  provisioning?: { executable: string };
  targetRevision: string;
  workspacePath: string;
}): void {
  const check = input.check;
  if (!isRecord(check) || typeof check.checkId !== "string") throw new Error("Final verification v2 check is invalid.");
  const id = check.checkId;
  const resolved = input.resolution.checks.find((candidate) => candidate.checkId === id);
  if (!resolved) throw new Error(`Final verification check ${id} is not planned.`);
  if (check.kind !== resolved.kind || check.label !== resolved.label || check.origin !== resolved.origin ||
    check.mandatory !== resolved.mandatory) {
    throw new Error(`Final verification check ${id} conflicts with the planned check.`);
  }
  if (typeof check.green !== "boolean" || !Array.isArray(check.facts) || !Array.isArray(check.evidenceIds) ||
    !Array.isArray(check.issues) || check.issues.some((issue) => typeof issue !== "string") ||
    check.evidenceIds.some((evidenceId) => typeof evidenceId !== "string" || !evidenceId.trim())) {
    throw new Error(`Final verification check ${id} result schema is invalid.`);
  }
  const outcome = check.outcome;
  const notRun = check.notRun === undefined ? undefined : parseVerificationNotRunV2(check.notRun, `Final verification check ${id}`);
  const facts = check.facts;
  if (outcome === "not_run") {
    if (!notRun || notRun.reason !== "tool_missing" || check.green !== false || facts.length > 0 ||
      check.issues.length > 0 || check.evidenceIds.length > 0) {
      throw new Error(`Not-run final verification check ${id} cannot carry a result, evidence or issues.`);
    }
    if (!resolvedCheckTools(resolved, input.provisioning).includes(notRun.tool)) {
      throw new Error(`Not-run final verification check ${id} names a tool its planned commands do not use.`);
    }
    return;
  }
  if (notRun) throw new Error(`Final verification check ${id} has a not-run record but outcome ${String(outcome)}.`);
  if ((outcome === "passed") !== (check.green === true) || (outcome !== "passed" && outcome !== "failed")) {
    throw new Error(`Final verification check ${id} outcome conflicts with its green fact.`);
  }
  if (check.green === true && check.issues.length > 0) {
    throw new Error(`Passed final verification check ${id} cannot carry mechanical issues.`);
  }
  if (facts.length !== check.evidenceIds.length) {
    throw new Error(`Final verification check ${id} facts do not correspond exactly to evidence records.`);
  }
  if (new Set(check.evidenceIds).size !== check.evidenceIds.length) {
    throw new Error(`Final verification check ${id} evidence IDs must be unique.`);
  }
  if (check.green === true && facts.length !== resolved.commands.length) {
    throw new Error(`Passed final verification check ${id} requires exactly ${resolved.commands.length} command facts.`);
  }
  if (facts.length > resolved.commands.length) throw new Error(`Final verification check ${id} has excess command facts.`);
  const category = factCategoryForMode(resolved.mode);
  for (const [index, fact] of facts.entries()) {
    assertVerificationFactV2Schema(fact, id, input.targetRevision);
    const command = resolved.commands[index]!;
    const value = fact as FinalVerificationCommandFact;
    const cwd = command.cwd ? joinWorkspace(input.workspacePath, command.cwd) : input.workspacePath;
    if (value.category !== category || value.label !== command.label || value.executable !== command.executable ||
      value.command !== command.executable || !sameStrings(value.args, command.args) || value.cwd !== cwd) {
      throw new Error(`Final verification check ${id} fact ${index} conflicts with the exact planned command.`);
    }
    if (value.startState.revision !== input.targetRevision || value.endState.revision !== input.targetRevision) {
      throw new Error(`Final verification check ${id} fact crossed a revision boundary.`);
    }
    if ((value.workflowStep === true) !== (index > 0)) {
      throw new Error(`Final verification check ${id} workflow step facts are out of place.`);
    }
    if (resolved.mode === "program" && (value.endpoint ?? undefined) !== resolved.endpoint) {
      throw new Error(`Final verification check ${id} endpoint conflicts with the planned readiness.`);
    }
    if (check.green === true) {
      const exitOk = resolved.mode === "program" && index === 0
        ? value.exitCode === null || value.exitCode === 0
        : value.exitCode === (resolved.mode === "exit" && index === 0 ? resolved.expectedExitCode : 0);
      if (value.signal !== null || value.timedOut || value.cancelled || value.outputTruncated || !exitOk) {
        throw new Error(`Passed final verification check ${id} has non-passing process semantics.`);
      }
      if (resolved.mode === "program" && index === 0 &&
        (value.readinessSatisfied !== true || value.cleanupRequested !== true || value.cleanupSucceeded !== true)) {
        throw new Error(`Passed final verification check ${id} lacks readiness or successful cleanup proof.`);
      }
    }
  }
}

/** Schema of a fact recorded by a v2 check. */
export function assertVerificationFactV2Schema(
  fact: unknown,
  checkId: string,
  targetRevision: string,
): asserts fact is FinalVerificationCommandFact {
  if (!isRecord(fact) || fact.kind !== "command" || fact.checkId !== checkId) {
    throw new Error(`Final verification check ${checkId} fact schema is invalid.`);
  }
  if (fact.category !== "build" && fact.category !== "tests" && fact.category !== "runtime_smoke") {
    throw new Error(`Final verification check ${checkId} fact category is invalid.`);
  }
  for (const key of ["label", "startedAt", "finishedAt", "command", "executable", "cwd", "stdoutArtifactHash", "stderrArtifactHash"]) {
    if (!nonEmpty(fact[key])) throw new Error(`Final verification check ${checkId} fact ${key} is invalid.`);
  }
  if (fact.targetRevision !== targetRevision || fact.repositoryRevision !== targetRevision) {
    throw new Error(`Final verification check ${checkId} fact targets a stale revision.`);
  }
  for (const key of ["startState", "endState"]) {
    const state = fact[key];
    if (!isRecord(state) || state.revision !== targetRevision || typeof state.status !== "string") {
      throw new Error(`Final verification check ${checkId} fact ${key} is invalid.`);
    }
  }
  if (!Array.isArray(fact.args) || fact.args.some((arg) => typeof arg !== "string")) {
    throw new Error(`Final verification check ${checkId} fact args are invalid.`);
  }
  if (fact.exitCode !== null && !Number.isSafeInteger(fact.exitCode)) throw new Error(`Final verification check ${checkId} exit code is invalid.`);
  if (fact.signal !== null && typeof fact.signal !== "string") throw new Error(`Final verification check ${checkId} signal is invalid.`);
  for (const key of ["timedOut", "cancelled", "outputTruncated"]) {
    if (typeof fact[key] !== "boolean") throw new Error(`Final verification check ${checkId} ${key} is invalid.`);
  }
  if (fact.workflowStep !== undefined && fact.workflowStep !== true) {
    throw new Error(`Final verification check ${checkId} workflowStep is invalid.`);
  }
  if (fact.category === "runtime_smoke" && fact.workflowStep !== true &&
    (typeof fact.readinessSatisfied !== "boolean" || typeof fact.cleanupRequested !== "boolean" ||
      typeof fact.cleanupSucceeded !== "boolean")) {
    throw new Error(`Final verification check ${checkId} readiness and cleanup facts are invalid.`);
  }
}

/** Validate and clone a v2 check result at the scheduler boundary. */
export function parseVerificationCheckResultV2(value: unknown): VerificationCheckResultV2 {
  if (!isRecord(value) || typeof value.checkId !== "string" || !CHECK_ID_PATTERN.test(value.checkId)) {
    throw new Error("Final verification v2 check result is invalid.");
  }
  const id = value.checkId;
  const allowed = new Set(["checkId", "kind", "label", "origin", "mandatory", "outcome", "green", "evidenceIds", "facts", "issues", "notRun"]);
  if (Object.keys(value).some((key) => !allowed.has(key))) throw new Error(`Final verification check ${id} result has unknown fields.`);
  if (!(VERIFICATION_CHECK_KINDS as readonly string[]).includes(String(value.kind)) || !nonEmpty(value.label) ||
    !(VERIFICATION_CHECK_ORIGINS as readonly string[]).includes(String(value.origin)) || typeof value.mandatory !== "boolean" ||
    (value.outcome !== "passed" && value.outcome !== "failed" && value.outcome !== "not_run") ||
    typeof value.green !== "boolean" || !Array.isArray(value.evidenceIds) || !Array.isArray(value.facts) ||
    !Array.isArray(value.issues) || value.evidenceIds.some((entry) => typeof entry !== "string") ||
    value.issues.some((entry) => typeof entry !== "string")) {
    throw new Error(`Final verification check ${id} result schema is invalid.`);
  }
  return {
    checkId: id,
    kind: value.kind as VerificationCheckKind,
    label: value.label,
    origin: value.origin as VerificationCheckOrigin,
    mandatory: value.mandatory,
    outcome: value.outcome,
    green: value.green,
    evidenceIds: [...value.evidenceIds] as string[],
    facts: JSON.parse(JSON.stringify(value.facts)) as FinalVerificationFact[],
    issues: [...value.issues] as string[],
    ...(value.notRun !== undefined ? { notRun: parseVerificationNotRunV2(value.notRun, `Final verification check ${id}`) } : {}),
  };
}

/** The not-run results for the suggested checks a plan skips, in plan order. */
export function skippedVerificationResults(
  plan: VerificationPlanV2,
  suggestions: readonly VerificationCheckV2[],
): VerificationCheckResultV2[] {
  const bySuggestion = new Map(suggestions.map((check) => [check.id, check]));
  return plan.skipped.map((entry) => {
    const suggestion = bySuggestion.get(entry.checkId);
    if (!suggestion) throw new Error(`Skipped check ${entry.checkId} was not suggested.`);
    return {
      checkId: suggestion.id,
      kind: suggestion.kind,
      label: suggestion.label,
      origin: suggestion.origin,
      mandatory: suggestion.mandatory,
      outcome: "not_run",
      green: false,
      evidenceIds: [],
      facts: [],
      issues: [],
      notRun: { reason: "skipped", detail: entry.reason },
    };
  });
}

/** Parse the v2 plan prefill carried on a durable Architect reason. */
export function parseVerificationPlanPrefillV2(value: unknown): VerificationPlanPrefillV2 {
  if (!isRecord(value) || value.version !== 2) throw new Error("Final-verification plan prefill is invalid.");
  const keys = Object.keys(value);
  if (keys.length !== 4 || !["version", "targetRevision", "profileDigest", "suggestedChecks"].every((key) => keys.includes(key))) {
    throw new Error("Final-verification plan prefill has unexpected fields.");
  }
  if (!nonEmpty(value.targetRevision)) throw new Error("Final-verification plan prefill targetRevision is invalid.");
  if (typeof value.profileDigest !== "string" || !/^[a-f0-9]{64}$/.test(value.profileDigest)) {
    throw new Error("Final-verification plan prefill profileDigest is invalid.");
  }
  if (!Array.isArray(value.suggestedChecks) || value.suggestedChecks.length > VERIFICATION_PLAN_LIMITS.maxChecks) {
    throw new Error("Final-verification plan prefill suggestedChecks are invalid.");
  }
  for (const [index, check] of value.suggestedChecks.entries()) {
    const issues = checkIssues(check, index, true);
    if (issues.length) throw new Error(`Final-verification plan prefill suggestion is invalid: ${issues.join(" ")}`);
  }
  return {
    version: 2,
    targetRevision: value.targetRevision,
    profileDigest: value.profileDigest,
    suggestedChecks: (value.suggestedChecks as VerificationCheckV2[]).map(cloneCheck),
  };
}

// ---------------------------------------------------------------------------
// Tool schema
// ---------------------------------------------------------------------------

/** JSON schema of the v2 plan as the Architect writes it (origin and mandatory are the Runner's). */
export function verificationPlanV2Schema(): Record<string, unknown> {
  const command = {
    executable: { type: "string", minLength: 1, description: "Program to run in the verification checkout, e.g. node or npm." },
    args: { type: "array", items: { type: "string" }, maxItems: VERIFICATION_PLAN_LIMITS.maxArgs },
  };
  const outputs = {
    type: "array",
    maxItems: 16,
    items: { type: "string", minLength: 1 },
    description: "Workspace-relative files or globs (screenshots, reports) the Runner keeps as evidence after the command exits.",
  };
  return {
    type: "object",
    properties: {
      version: { type: "integer", enum: [2] },
      checks: {
        type: "array",
        maxItems: VERIFICATION_PLAN_LIMITS.maxChecks,
        items: {
          type: "object",
          properties: {
            id: { type: "string", pattern: CHECK_ID_PATTERN.source, description: "A suggested check's id to keep or change it, or a new id for your own check." },
            label: { type: "string", minLength: 1 },
            kind: { type: "string", enum: [...VERIFICATION_CHECK_KINDS] },
            origin: { type: "string", enum: [...VERIFICATION_CHECK_ORIGINS], description: "Set by the Runner; omit it." },
            mandatory: { type: "boolean", description: "Set by the Runner from aiboard-validation.json; omit it." },
            run: {
              type: "object",
              description: "For build, tests and other: one command; the check passes when it exits 0.",
              properties: {
                ...command,
                cwd: { type: "string", minLength: 1, description: "Directory inside the checkout, relative to its root." },
                timeoutMs: { type: "integer", minimum: VERIFICATION_PLAN_LIMITS.minTimeoutMs, maximum: VERIFICATION_PLAN_LIMITS.maxRunTimeoutMs },
              },
              required: ["executable", "args"],
              additionalProperties: false,
            },
            start: {
              type: "object",
              description: "For start: run a program and see that it works. A server is ready on an HTTP status on the Runner-leased port ({port} in args), a CLI on its exit code, a desktop or headless mode on a line of its output; steps then run in order against it and must each exit 0.",
              properties: {
                ...command,
                timeoutMs: { type: "integer", minimum: VERIFICATION_PLAN_LIMITS.minTimeoutMs, maximum: VERIFICATION_PLAN_LIMITS.maxStartTimeoutMs },
                ready: {
                  type: "object",
                  description: "Exactly one of http, outputLine or exitCode.",
                  properties: {
                    http: {
                      type: "object",
                      properties: { path: { type: "string", minLength: 1 }, status: { type: "integer", minimum: 100, maximum: 599 } },
                      required: ["path", "status"],
                      additionalProperties: false,
                    },
                    outputLine: { type: "string", minLength: 1 },
                    exitCode: { type: "integer", minimum: 0, maximum: 255 },
                  },
                  additionalProperties: false,
                },
                steps: {
                  type: "array",
                  maxItems: VERIFICATION_PLAN_LIMITS.maxSteps,
                  items: {
                    type: "object",
                    properties: {
                      label: { type: "string", minLength: 1 },
                      ...command,
                      timeoutMs: { type: "integer", minimum: VERIFICATION_PLAN_LIMITS.minTimeoutMs, maximum: VERIFICATION_PLAN_LIMITS.maxStartTimeoutMs },
                      outputs,
                    },
                    required: ["label", "executable", "args"],
                    additionalProperties: false,
                  },
                },
              },
              required: ["executable", "args", "ready"],
              additionalProperties: false,
            },
            outputs,
          },
          required: ["id", "label", "kind"],
          additionalProperties: false,
        },
      },
      skipped: {
        type: "array",
        description: "Suggested checks you drop, each with the reason (it is listed in the Build summary).",
        items: {
          type: "object",
          properties: {
            checkId: { type: "string", minLength: 1 },
            reason: { type: "string", minLength: 1, maxLength: VERIFICATION_PLAN_LIMITS.maxReasonLength },
          },
          required: ["checkId", "reason"],
          additionalProperties: false,
        },
      },
    },
    required: ["version", "checks", "skipped"],
    additionalProperties: false,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function commandSpec(check: VerificationCheckV2): unknown {
  return {
    kind: check.kind,
    ...(check.run ? { run: check.run } : {}),
    ...(check.start ? {
      start: {
        ...check.start,
        ...(check.start.steps ? { steps: check.start.steps.map(({ label: _label, outputs: _outputs, ...step }) => step) } : {}),
      },
    } : {}),
  };
}

function cloneCheck(check: VerificationCheckV2): VerificationCheckV2 {
  return {
    id: check.id,
    label: check.label,
    kind: check.kind,
    origin: check.origin,
    mandatory: check.mandatory,
    ...(check.run ? {
      run: {
        executable: check.run.executable,
        args: [...check.run.args],
        ...(check.run.cwd !== undefined ? { cwd: check.run.cwd } : {}),
        ...(check.run.timeoutMs !== undefined ? { timeoutMs: check.run.timeoutMs } : {}),
      },
    } : {}),
    ...(check.start ? {
      start: {
        executable: check.start.executable,
        args: [...check.start.args],
        ...(check.start.timeoutMs !== undefined ? { timeoutMs: check.start.timeoutMs } : {}),
        ready: "http" in check.start.ready
          ? { http: { path: check.start.ready.http.path, status: check.start.ready.http.status } }
          : "outputLine" in check.start.ready
            ? { outputLine: check.start.ready.outputLine }
            : { exitCode: check.start.ready.exitCode },
        ...(check.start.steps ? {
          steps: check.start.steps.map((step) => ({
            label: step.label,
            executable: step.executable,
            args: [...step.args],
            ...(step.timeoutMs !== undefined ? { timeoutMs: step.timeoutMs } : {}),
            ...(step.outputs ? { outputs: [...step.outputs] } : {}),
          })),
        } : {}),
      },
    } : {}),
    ...(check.outputs ? { outputs: [...check.outputs] } : {}),
  };
}

function cloneResolvedCommand(command: ResolvedVerificationCommandV2): ResolvedVerificationCommandV2 {
  return {
    label: command.label,
    executable: command.executable,
    args: [...command.args],
    ...(command.timeoutMs !== undefined ? { timeoutMs: command.timeoutMs } : {}),
    ...(command.environment ? { environment: { ...command.environment } } : {}),
    ...(command.cwd !== undefined ? { cwd: command.cwd } : {}),
    ...(command.outputs ? { outputs: [...command.outputs] } : {}),
  };
}

function cloneResolved(check: ResolvedVerificationCheckV2): ResolvedVerificationCheckV2 {
  return {
    checkId: check.checkId,
    label: check.label,
    kind: check.kind,
    origin: check.origin,
    mandatory: check.mandatory,
    mode: check.mode,
    commands: check.commands.map(cloneResolvedCommand),
    ...(check.outputs ? { outputs: [...check.outputs] } : {}),
    ...(check.endpoint !== undefined ? { endpoint: check.endpoint } : {}),
    ...(check.expectedStatus !== undefined ? { expectedStatus: check.expectedStatus } : {}),
    ...(check.outputLine !== undefined ? { outputLine: check.outputLine } : {}),
    ...(check.expectedExitCode !== undefined ? { expectedExitCode: check.expectedExitCode } : {}),
    ...(check.readinessTimeoutMs !== undefined ? { readinessTimeoutMs: check.readinessTimeoutMs } : {}),
  };
}

function normalizeRelative(value: string): string {
  return value.replace(/\\/g, "/").split("/").filter((segment) => segment !== "" && segment !== ".").join("/");
}

/** The absolute directory a resolved command's relative cwd names inside the checkout. */
export function joinWorkspace(workspacePath: string, cwd: string): string {
  return resolvePath(workspacePath, ...normalizeRelative(cwd).split("/"));
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sameValue(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().filter((key) => value[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
