export interface UserGuidanceSubmission {
  guidanceId: string;
  text: string;
  version: number;
}

export interface UserGuidanceNoPlanChangeResolution {
  type: "no_plan_change";
  rationale: string;
  evidenceIds: string[];
}

export interface UserGuidancePlanReconciledResolution {
  type: "plan_reconciled";
  rationale: string;
  /** Validated by the scheduler's existing reconciliation parser. */
  planReconciliation: PlanReconciliation;
}

export type UserGuidanceAcknowledgementResolution =
  | UserGuidanceNoPlanChangeResolution
  | UserGuidancePlanReconciledResolution;

export type ParsedUserGuidanceAcknowledgementResolution =
  | UserGuidanceNoPlanChangeResolution
  | Omit<UserGuidancePlanReconciledResolution, "planReconciliation"> & {
    planReconciliation: unknown;
  };

export interface UserGuidanceAcknowledgement {
  guidanceId: string;
  expectedVersion: number;
  resolution: ParsedUserGuidanceAcknowledgementResolution;
}

export interface ArchitectQuestionRequest {
  questionId: string;
  question: string;
  version: number;
}

export interface ArchitectQuestionAnswer {
  questionId: string;
  expectedVersion: number;
  answer: string;
}

export interface UserGuidanceItem extends UserGuidanceSubmission {
  status: "submitted" | "acknowledged";
  resolution?: UserGuidanceAcknowledgementResolution;
}

export interface ArchitectQuestionItem extends ArchitectQuestionRequest {
  status: "open" | "answered";
  answer?: string;
}

export function parseUserGuidanceSubmission(payload: Record<string, unknown>): UserGuidanceSubmission {
  assertExactKeys(payload, ["guidanceId", "text", "version"]);
  return {
    guidanceId: requiredText(payload, "guidanceId"),
    text: requiredText(payload, "text"),
    version: requiredPositiveInteger(payload, "version"),
  };
}

export function parseUserGuidanceAcknowledgement(payload: Record<string, unknown>): UserGuidanceAcknowledgement {
  assertExactKeys(payload, ["guidanceId", "expectedVersion", "resolution"]);
  return {
    guidanceId: requiredText(payload, "guidanceId"),
    expectedVersion: requiredPositiveInteger(payload, "expectedVersion"),
    resolution: parseAcknowledgementResolution(payload.resolution),
  };
}

export function parseArchitectQuestionRequest(payload: Record<string, unknown>): ArchitectQuestionRequest {
  assertExactKeys(payload, ["questionId", "question", "version"]);
  return {
    questionId: requiredText(payload, "questionId"),
    question: requiredText(payload, "question"),
    version: requiredPositiveInteger(payload, "version"),
  };
}

export function parseArchitectQuestionAnswer(payload: Record<string, unknown>): ArchitectQuestionAnswer {
  assertExactKeys(payload, ["questionId", "expectedVersion", "answer"]);
  return {
    questionId: requiredText(payload, "questionId"),
    expectedVersion: requiredPositiveInteger(payload, "expectedVersion"),
    answer: requiredText(payload, "answer"),
  };
}

function assertExactKeys(payload: Record<string, unknown>, allowed: readonly string[]): void {
  const unknown = Object.keys(payload).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) throw new Error(`Unknown user-steering payload field(s): ${unknown.join(", ")}.`);
}

function requiredText(payload: Record<string, unknown>, key: string): string {
  const value = payload[key];
  if (typeof value !== "string" || !value.trim()) throw new Error(`${key} must be nonblank.`);
  return value;
}

function parseAcknowledgementResolution(value: unknown): ParsedUserGuidanceAcknowledgementResolution {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("resolution is required.");
  }
  const resolution = value as Record<string, unknown>;
  const type = requiredText(resolution, "type");
  if (type === "no_plan_change") {
    assertExactKeys(resolution, ["type", "rationale", "evidenceIds"]);
    const evidenceIds = requiredTextArray(resolution, "evidenceIds");
    return { type, rationale: requiredText(resolution, "rationale"), evidenceIds };
  }
  if (type === "plan_reconciled") {
    assertExactKeys(resolution, ["type", "rationale", "planReconciliation"]);
    if (
      typeof resolution.planReconciliation !== "object" ||
      resolution.planReconciliation === null ||
      Array.isArray(resolution.planReconciliation)
    ) {
      throw new Error("planReconciliation is required.");
    }
    return {
      type,
      rationale: requiredText(resolution, "rationale"),
      planReconciliation: resolution.planReconciliation,
    };
  }
  throw new Error(`resolution type ${type} is invalid.`);
}

function requiredTextArray(payload: Record<string, unknown>, key: string): string[] {
  const value = payload[key];
  if (!Array.isArray(value) || value.length === 0) throw new Error(`${key} is required.`);
  return value.map((item) => {
    if (typeof item !== "string" || !item.trim()) throw new Error(`${key} must contain nonblank strings.`);
    return item;
  });
}

function requiredPositiveInteger(payload: Record<string, unknown>, key: string): number {
  const value = payload[key];
  if (!Number.isInteger(value) || (value as number) <= 0) {
    throw new Error(`${key} must be a positive integer.`);
  }
  return value as number;
}
import type { PlanReconciliation } from "./task-contracts.js";
