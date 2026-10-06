/**
 * IV-3 (CD-23): advisory per-task validation wall-clock budget.
 *
 * Counts ONLY actual worker `run_evidence_command` wall-clock time plus
 * actual integrated delivery-boundary wall-clock time, per task across
 * attempts. Reuses the durable BudgetLedger active-segment machinery
 * (startActive/stopActive/snapshot) in a dedicated run/task-bound scope,
 * but NEVER routes through BudgetExceededError/maxActiveMs: validation
 * scopes carry no hard limits, overage never hard-fails correct work, and
 * the existing run-budget behavior stays unchanged.
 *
 * Runner timestamps only; model-supplied durations are never accepted.
 * Interrupted (open) segments contribute 0 and never invent elapsed time.
 * Old budget ledgers without validation scopes snapshot to zero usage.
 */
import {
  MAX_VALIDATION_BUDGET_MS,
  parseValidationBudgetMs,
} from "./project-validation-config.js";
import type { BudgetLedger } from "./budget-ledger.js";

/** Bounded worker justification for validation-budget overage. */
export const VALIDATION_BUDGET_JUSTIFICATION_MAX_LENGTH = 2000;
export const MAX_VALIDATION_BUDGET_SEGMENTS = 500;
export const MAX_VALIDATION_BUDGET_SEGMENT_ID_LENGTH = 500;
export const MAX_VALIDATION_BUDGET_SCOPE_ID_LENGTH = 500;

export type ValidationBudgetSegmentKind = "evidence" | "boundary";

export interface ValidationBudgetSegment {
  segmentId: string;
  kind: ValidationBudgetSegmentKind;
  startedAt: string;
  durationMs?: number;
}

export interface ValidationBudgetSummary {
  budgetMs: number;
  usedMs: number;
  overBudget: boolean;
  scopeId: string;
  segments: ValidationBudgetSegment[];
}

/**
 * Durable submit-time record: the authoritative measured snapshot plus the
 * worker's justification when (and only when) over budget.
 */
export interface ValidationBudgetSubmission {
  summary: ValidationBudgetSummary;
  justification?: string;
}

const SCOPE_PREFIX = "validation-budget:";
const EVIDENCE_SEGMENT_PREFIX = "validation-evidence:";
const BOUNDARY_SEGMENT_PREFIX = "validation-boundary:";

/** Deterministic run/task-bound scope; stable across attempts and restarts. */
export function validationBudgetScopeId(runId: string, taskId: string): string {
  if (!runId.trim() || !taskId.trim()) {
    throw new Error("Validation budget scope requires runId and taskId.");
  }
  return `${SCOPE_PREFIX}${runId}:${taskId}`;
}

/** Whether a ledger scope is a task validation-budget scope (any task). */
export function isValidationBudgetScope(scopeId: string): boolean {
  return scopeId.startsWith(SCOPE_PREFIX);
}

/** Whether a ledger scope is this run's task validation-budget scope. */
export function isRunValidationBudgetScope(scopeId: string, runId: string): boolean {
  return scopeId.startsWith(`${SCOPE_PREFIX}${runId}:`);
}

/** Deterministic segment id for one evidence call (session+call bound). */
export function validationEvidenceSegmentId(
  sessionId: string,
  callId: string,
): string {
  if (!sessionId.trim() || !callId.trim()) {
    throw new Error("Validation evidence segment requires sessionId and callId.");
  }
  return `${EVIDENCE_SEGMENT_PREFIX}${sessionId}:${callId}`;
}

/** Deterministic segment id for one boundary attempt. */
export function validationBoundarySegmentId(
  boundaryId: string,
  attempt: number,
): string {
  if (!boundaryId.trim() || !Number.isSafeInteger(attempt) || attempt < 1) {
    throw new Error("Validation boundary segment requires boundaryId and attempt >= 1.");
  }
  return `${BOUNDARY_SEGMENT_PREFIX}${boundaryId}:${attempt}`;
}

function segmentKind(segmentId: string): ValidationBudgetSegmentKind {
  if (segmentId.startsWith(EVIDENCE_SEGMENT_PREFIX)) return "evidence";
  if (segmentId.startsWith(BOUNDARY_SEGMENT_PREFIX)) return "boundary";
  throw new Error(`Unknown validation budget segment ${segmentId}.`);
}

/**
 * Record one actual evidence execution. No-op when the call was already
 * counted (idempotent retry/replay), when the ledger predates validation
 * scopes (run-only limitsFor), or when timestamps are missing. Reused
 * (V2 `reused_from`) executions must not call this (they add 0).
 */
export function recordValidationEvidenceSegment(
  ledger: BudgetLedger,
  input: {
    runId: string;
    taskId: string;
    sessionId: string;
    callId: string;
    startedAt: string;
    finishedAt: string;
  },
): void {
  const scopeId = validationBudgetScopeId(input.runId, input.taskId);
  const segmentId = validationEvidenceSegmentId(input.sessionId, input.callId);
  assertRunnerTimestamps(input.startedAt, input.finishedAt);
  const existing = ledger.snapshot(scopeId).activeSegments[segmentId];
  if (existing) return;
  try {
    ledger.startActive({
      scopeId,
      segmentId,
      reserveMs: 0,
      occurredAt: input.startedAt,
      idempotencyKey: `validation-evidence-start:${input.sessionId}:${input.callId}`,
    });
    ledger.stopActive({
      scopeId,
      segmentId,
      occurredAt: input.finishedAt,
      idempotencyKey: `validation-evidence-stop:${input.sessionId}:${input.callId}`,
    });
  } catch (error) {
    if (error instanceof Error && /Unknown budget scope/.test(error.message)) return;
    throw error;
  }
}

/**
 * Record one actual boundary attempt. No-op when already counted.
 * Replayed durable boundary results never reach the driver, so they add 0.
 */
export function recordValidationBoundarySegment(
  ledger: BudgetLedger,
  input: {
    runId: string;
    taskId: string;
    boundaryId: string;
    attempt: number;
    startedAt: string;
    finishedAt: string;
  },
): void {
  const scopeId = validationBudgetScopeId(input.runId, input.taskId);
  const segmentId = validationBoundarySegmentId(input.boundaryId, input.attempt);
  assertRunnerTimestamps(input.startedAt, input.finishedAt);
  const existing = ledger.snapshot(scopeId).activeSegments[segmentId];
  if (existing) return;
  try {
    ledger.startActive({
      scopeId,
      segmentId,
      reserveMs: 0,
      occurredAt: input.startedAt,
      idempotencyKey: `validation-boundary-start:${input.boundaryId}:${input.attempt}`,
    });
    ledger.stopActive({
      scopeId,
      segmentId,
      occurredAt: input.finishedAt,
      idempotencyKey: `validation-boundary-stop:${input.boundaryId}:${input.attempt}`,
    });
  } catch (error) {
    if (error instanceof Error && /Unknown budget scope/.test(error.message)) return;
    throw error;
  }
}

function assertRunnerTimestamps(startedAt: string, finishedAt: string): void {
  const start = Date.parse(startedAt);
  const finish = Date.parse(finishedAt);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(finish)) {
    throw new Error("Validation budget timestamps must be ISO strings.");
  }
  if (finish < start) {
    throw new Error("Validation budget stop time precedes its start.");
  }
}

/** Cumulative task usage across attempts (open segments contribute 0). */
export function getValidationBudgetUsage(
  ledger: BudgetLedger,
  runId: string,
  taskId: string,
): { usedMs: number; segments: ValidationBudgetSegment[] } {
  const scopeId = validationBudgetScopeId(runId, taskId);
  const snapshot = ledger.snapshot(scopeId);
  const segments = Object.values(snapshot.activeSegments)
    .map((segment) => ({
      segmentId: segment.segmentId,
      kind: segmentKind(segment.segmentId),
      startedAt: segment.startedAt,
      ...(segment.durationMs !== undefined ? { durationMs: segment.durationMs } : {}),
    }))
    .sort((left, right) =>
      left.segmentId < right.segmentId ? -1 : left.segmentId > right.segmentId ? 1 : 0,
    );
  return { usedMs: snapshot.lifetime.activeMs, segments };
}

/** Authoritative advisory summary for submit/reviewer. */
export function summarizeValidationBudget(
  ledger: BudgetLedger,
  input: { runId: string; taskId: string; budgetMs: number },
): ValidationBudgetSummary {
  const budgetMs = parseValidationBudgetMs(input.budgetMs);
  const scopeId = validationBudgetScopeId(input.runId, input.taskId);
  const usage = getValidationBudgetUsage(ledger, input.runId, input.taskId);
  return {
    budgetMs,
    usedMs: usage.usedMs,
    overBudget: usage.usedMs > budgetMs,
    scopeId,
    segments: usage.segments,
  };
}

/** Non-empty bounded justification; throws on missing/empty/oversize. */
export function parseValidationBudgetJustification(value: unknown): string {
  if (typeof value !== "string") {
    throw new Error("Validation budget justification must be a string.");
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new Error("Validation budget justification must be non-empty.");
  }
  if (trimmed.length > VALIDATION_BUDGET_JUSTIFICATION_MAX_LENGTH) {
    throw new Error(
      `Validation budget justification must be at most ${VALIDATION_BUDGET_JUSTIFICATION_MAX_LENGTH} characters.`,
    );
  }
  if (trimmed.includes("\0")) {
    throw new Error("Validation budget justification must not contain NUL.");
  }
  return trimmed;
}

export function cloneValidationBudgetSummary(
  summary: ValidationBudgetSummary,
): ValidationBudgetSummary {
  return parseValidationBudgetSummary(structuredClone(summary));
}

export function parseValidationBudgetSummary(value: unknown): ValidationBudgetSummary {
  if (!isRecord(value)) {
    throw new Error("Validation budget summary must be an object.");
  }
  assertKnownKeys(value, ["budgetMs", "usedMs", "overBudget", "scopeId", "segments"], "Validation budget summary");
  const budgetMs = parseValidationBudgetMs(value.budgetMs);
  if (
    typeof value.usedMs !== "number" ||
    !Number.isSafeInteger(value.usedMs) ||
    (value.usedMs as number) < 0
  ) {
    throw new Error("Validation budget usedMs must be a nonnegative safe integer.");
  }
  const usedMs = value.usedMs as number;
  if (typeof value.overBudget !== "boolean") {
    throw new Error("Validation budget overBudget must be a boolean.");
  }
  if ((value.overBudget as boolean) !== usedMs > budgetMs) {
    throw new Error("Validation budget overBudget disagrees with its measured usage.");
  }
  if (
    typeof value.scopeId !== "string" ||
    !value.scopeId.startsWith(SCOPE_PREFIX) ||
    value.scopeId.length > MAX_VALIDATION_BUDGET_SCOPE_ID_LENGTH
  ) {
    throw new Error("Validation budget scopeId is invalid.");
  }
  if (!Array.isArray(value.segments) || value.segments.length > MAX_VALIDATION_BUDGET_SEGMENTS) {
    throw new Error("Validation budget segments are invalid.");
  }
  const segments = (value.segments as unknown[]).map((entry, index) =>
    parseValidationBudgetSegment(entry, index),
  );
  segments.sort((left, right) =>
    left.segmentId < right.segmentId ? -1 : left.segmentId > right.segmentId ? 1 : 0,
  );
  return {
    budgetMs,
    usedMs,
    overBudget: value.overBudget as boolean,
    scopeId: value.scopeId as string,
    segments,
  };
}

function parseValidationBudgetSegment(value: unknown, index: number): ValidationBudgetSegment {
  const label = `Validation budget segment[${index}]`;
  if (!isRecord(value)) throw new Error(`${label} must be an object.`);
  assertKnownKeys(value, ["segmentId", "kind", "startedAt", "durationMs"], label);
  if (
    typeof value.segmentId !== "string" ||
    !value.segmentId.trim() ||
    (value.segmentId as string).length > MAX_VALIDATION_BUDGET_SEGMENT_ID_LENGTH
  ) {
    throw new Error(`${label} carries an invalid segmentId.`);
  }
  const segmentId = value.segmentId as string;
  if (value.kind !== "evidence" && value.kind !== "boundary") {
    throw new Error(`${label} carries an invalid kind.`);
  }
  if (value.kind !== segmentKind(segmentId)) {
    throw new Error(`${label} kind disagrees with its segment identity.`);
  }
  if (typeof value.startedAt !== "string" || Number.isNaN(Date.parse(value.startedAt))) {
    throw new Error(`${label} carries an invalid startedAt.`);
  }
  if (
    value.durationMs !== undefined &&
    (typeof value.durationMs !== "number" ||
      !Number.isSafeInteger(value.durationMs) ||
      (value.durationMs as number) < 0)
  ) {
    throw new Error(`${label} carries an invalid durationMs.`);
  }
  return {
    segmentId,
    kind: value.kind,
    startedAt: value.startedAt as string,
    ...(value.durationMs !== undefined ? { durationMs: value.durationMs as number } : {}),
  };
}

/**
 * Durable submit-time record. Over budget requires a justification; under
 * budget forbids noise. Throws otherwise (mechanical refusal at the trusted
 * boundary, fail-closed replay).
 */
export function parseValidationBudgetSubmission(value: unknown): ValidationBudgetSubmission {
  if (!isRecord(value)) {
    throw new Error("Validation budget submission must be an object.");
  }
  assertKnownKeys(value, ["summary", "justification"], "Validation budget submission");
  const summary = parseValidationBudgetSummary(value.summary);
  if (summary.overBudget) {
    if (value.justification === undefined) {
      throw new Error("Validation budget overage requires a justification.");
    }
    return { summary, justification: parseValidationBudgetJustification(value.justification) };
  }
  if (value.justification !== undefined) {
    throw new Error("Validation budget justification is accepted only when over budget.");
  }
  return { summary };
}

export function cloneValidationBudgetSubmission(
  submission: ValidationBudgetSubmission,
): ValidationBudgetSubmission {
  return parseValidationBudgetSubmission(structuredClone(submission));
}

export function validationBudgetMaxMs(): number {
  return MAX_VALIDATION_BUDGET_MS;
}

function assertKnownKeys(
  value: Record<string, unknown>,
  known: readonly string[],
  label: string,
): void {
  for (const key of Object.keys(value)) {
    if (!known.includes(key)) {
      throw new Error(`${label} carries an unknown field ${JSON.stringify(key)}.`);
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
