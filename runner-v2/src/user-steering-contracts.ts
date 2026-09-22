export interface UserGuidanceSubmission {
  guidanceId: string;
  text: string;
  version: number;
  /** Absent only on durable submissions written before managed interruption gating. */
  interruptionProtocolVersion?: 1;
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
  decisionKind?: ArchitectQuestionDecisionKind;
  checkpoint?: ArchitectActionCheckpoint;
}

export type ArchitectActionReason =
  | { type: "plan_required" }
  | { type: "acceptance_contract_upgrade_required" }
  | { type: "user_guidance_required"; guidanceId: string; version: number }
  | { type: "guidance_required"; requestId: string; taskId: string }
  | { type: "review_required"; taskId: string; changeSetId: string }
  | { type: "integration_approval_required"; taskId: string; changeSetId: string }
  | { type: "completion_decision_required"; runPolicy?: "plan_only" }
  | { type: "final_verification_plan_required"; integrationRevision: string }
  | {
      type: "final_verification_review_required";
      taskId: string;
      generationId: string;
      submissionId: string;
      targetRevision: string;
    }
  | {
      type: "final_verification_repair_plan_required";
      finalVerificationTaskId: string;
      generationId: string;
      targetRevision: string;
      source:
        | { type: "semantic_review"; submissionId: string; reviewId: string }
        | { type: "mechanical_failure"; failureId: string; issueIds: string[]; factIds: string[] };
      failedCategories: string[];
      evidenceIds: string[];
    }
  | {
      type: "verifier_repair_plan_required";
      reviewId: string;
      targetRevision: string;
      unsatisfiedCriteria: Array<{
        taskId: string;
        criterionId: string;
        rationale: string;
        evidenceIds: string[];
      }>;
    }
  | { type: "task_failure_resolution_required"; taskId: string; attempt: number; failureReason: string }
  | { type: "integration_resolution_required"; taskId: string }
  | {
      type: "plan_critique_resolution_required";
      critiqueId: string;
      planRevision: number;
      blockingFindingIds: string[];
    };

export type ArchitectQuestionDecisionKind =
  | "authority_decision"
  | "destructive_action"
  | "requirement_conflict"
  | "external_dependency"
  | "control_weakening"
  | "repair_budget_exhausted";

export interface ArchitectActionCheckpoint {
  reason: ArchitectActionReason;
  sequence: number;
}

export interface ArchitectQuestionAnswer {
  questionId: string;
  expectedVersion: number;
  answer: string;
}

export interface UserGuidanceItem extends UserGuidanceSubmission {
  status: "submitted" | "acknowledged";
  interruptionStatus: "pending" | "completed";
  resolution?: UserGuidanceAcknowledgementResolution;
}

export interface ArchitectQuestionItem extends ArchitectQuestionRequest {
  status: "open" | "answered";
  answer?: string;
  resumeStatus?: "pending" | "started" | "consumed" | "superseded";
  resumeStartedSequence?: number;
  resumeConsumedSequence?: number;
  resumeSupersededSequence?: number;
  supersededByGuidanceId?: string;
  supersededRationale?: string;
}

export function parseUserGuidanceSubmission(payload: Record<string, unknown>): UserGuidanceSubmission {
  assertExactKeys(payload, ["guidanceId", "text", "version", "interruptionProtocolVersion"]);
  const interruptionProtocolVersion = payload.interruptionProtocolVersion;
  if (interruptionProtocolVersion !== undefined && interruptionProtocolVersion !== 1) {
    throw new Error("User guidance interruption protocol version is invalid.");
  }
  return {
    guidanceId: requiredText(payload, "guidanceId"),
    text: requiredText(payload, "text"),
    version: requiredPositiveInteger(payload, "version"),
    ...(interruptionProtocolVersion === 1 ? { interruptionProtocolVersion } : {}),
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
  assertExactKeys(payload, ["questionId", "question", "version", "decisionKind", "checkpoint"]);
  const decisionKind = payload.decisionKind === undefined
    ? undefined
    : parseDecisionKind(payload.decisionKind);
  const checkpoint = payload.checkpoint === undefined
    ? undefined
    : parseCheckpoint(payload.checkpoint);
  return {
    questionId: requiredText(payload, "questionId"),
    question: requiredText(payload, "question"),
    version: requiredPositiveInteger(payload, "version"),
    ...(decisionKind ? { decisionKind } : {}),
    ...(checkpoint ? { checkpoint } : {}),
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
    if (new Set(evidenceIds).size !== evidenceIds.length) {
      throw new Error("evidenceIds must be unique.");
    }
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

function parseDecisionKind(value: unknown): ArchitectQuestionDecisionKind {
  const allowed: ArchitectQuestionDecisionKind[] = [
    "authority_decision",
    "destructive_action",
    "requirement_conflict",
    "external_dependency",
    "control_weakening",
    "repair_budget_exhausted",
  ];
  if (typeof value !== "string" || !allowed.includes(value as ArchitectQuestionDecisionKind)) {
    throw new Error("decisionKind is invalid.");
  }
  return value as ArchitectQuestionDecisionKind;
}

function parseCheckpoint(value: unknown): ArchitectActionCheckpoint {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("checkpoint is invalid.");
  }
  const checkpoint = value as Record<string, unknown>;
  assertExactKeys(checkpoint, ["reason", "sequence"]);
  if (
    typeof checkpoint.reason !== "object" ||
    checkpoint.reason === null ||
    Array.isArray(checkpoint.reason) ||
    !Number.isSafeInteger(checkpoint.sequence) ||
    (checkpoint.sequence as number) < 1
  ) {
    throw new Error("checkpoint is invalid.");
  }
  return {
    reason: parseArchitectActionReason(checkpoint.reason),
    sequence: checkpoint.sequence as number,
  };
}

export function parseArchitectActionReason(value: unknown): ArchitectActionReason {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Architect action reason is invalid.");
  }
  const reason = value as Record<string, unknown>;
  const type = requiredText(reason, "type");
  const exact = (keys: string[]) => assertExactKeys(reason, ["type", ...keys]);
  const text = (key: string) => requiredText(reason, key);
  switch (type) {
    case "plan_required":
    case "acceptance_contract_upgrade_required":
      exact([]);
      return { type };
    case "user_guidance_required":
      exact(["guidanceId", "version"]);
      return { type, guidanceId: text("guidanceId"), version: requiredPositiveInteger(reason, "version") };
    case "guidance_required":
      exact(["requestId", "taskId"]);
      return { type, requestId: text("requestId"), taskId: text("taskId") };
    case "review_required":
    case "integration_approval_required":
      exact(["taskId", "changeSetId"]);
      return { type, taskId: text("taskId"), changeSetId: text("changeSetId") };
    case "completion_decision_required": {
      exact(["runPolicy"]);
      if (reason.runPolicy !== undefined && reason.runPolicy !== "plan_only") {
        throw new Error("Architect action runPolicy is invalid.");
      }
      return { type, ...(reason.runPolicy === "plan_only" ? { runPolicy: "plan_only" as const } : {}) };
    }
    case "final_verification_plan_required":
      exact(["integrationRevision"]);
      return { type, integrationRevision: text("integrationRevision") };
    case "final_verification_review_required":
      exact(["taskId", "generationId", "submissionId", "targetRevision"]);
      return {
        type,
        taskId: text("taskId"),
        generationId: text("generationId"),
        submissionId: text("submissionId"),
        targetRevision: text("targetRevision"),
      };
    case "final_verification_repair_plan_required": {
      exact(["finalVerificationTaskId", "generationId", "targetRevision", "source", "failedCategories", "evidenceIds"]);
      const source = parseRepairSource(reason.source);
      return {
        type,
        finalVerificationTaskId: text("finalVerificationTaskId"),
        generationId: text("generationId"),
        targetRevision: text("targetRevision"),
        source,
        failedCategories: requiredTextArray(reason, "failedCategories"),
        evidenceIds: requiredTextArray(reason, "evidenceIds"),
      };
    }
    case "verifier_repair_plan_required": {
      exact(["reviewId", "targetRevision", "unsatisfiedCriteria"]);
      if (
        !Array.isArray(reason.unsatisfiedCriteria) ||
        reason.unsatisfiedCriteria.length === 0
      ) {
        throw new Error("Verifier repair reason requires unsatisfied criteria.");
      }
      const unsatisfiedCriteria = reason.unsatisfiedCriteria.map((candidate) => {
        if (
          typeof candidate !== "object" || candidate === null ||
          Array.isArray(candidate)
        ) {
          throw new Error("Verifier repair criterion is invalid.");
        }
        const criterion = candidate as Record<string, unknown>;
        assertExactKeys(criterion, [
          "taskId",
          "criterionId",
          "rationale",
          "evidenceIds",
        ]);
        return {
          taskId: requiredText(criterion, "taskId"),
          criterionId: requiredText(criterion, "criterionId"),
          rationale: requiredText(criterion, "rationale"),
          evidenceIds: requiredTextArray(criterion, "evidenceIds"),
        };
      });
      return {
        type,
        reviewId: text("reviewId"),
        targetRevision: text("targetRevision"),
        unsatisfiedCriteria,
      };
    }
    case "task_failure_resolution_required":
      exact(["taskId", "attempt", "failureReason"]);
      return {
        type,
        taskId: text("taskId"),
        attempt: requiredPositiveInteger(reason, "attempt"),
        failureReason: text("failureReason"),
      };
    case "integration_resolution_required":
      exact(["taskId"]);
      return { type, taskId: text("taskId") };
    case "plan_critique_resolution_required": {
      exact(["critiqueId", "planRevision", "blockingFindingIds"]);
      if (
        !Array.isArray(reason.blockingFindingIds) ||
        reason.blockingFindingIds.length === 0
      ) {
        throw new Error("Plan critique resolution reason requires blocking findings.");
      }
      return {
        type,
        critiqueId: text("critiqueId"),
        planRevision: requiredPositiveInteger(reason, "planRevision"),
        blockingFindingIds: reason.blockingFindingIds.map((item) => {
          if (typeof item !== "string" || !item.trim()) {
            throw new Error("blockingFindingIds must contain nonblank strings.");
          }
          return item;
        }),
      };
    }
    default:
      throw new Error(`Architect action reason ${type} is invalid.`);
  }
}

function parseRepairSource(value: unknown): Extract<
  ArchitectActionReason,
  { type: "final_verification_repair_plan_required" }
>["source"] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Architect repair source is invalid.");
  }
  const source = value as Record<string, unknown>;
  const type = requiredText(source, "type");
  if (type === "semantic_review") {
    assertExactKeys(source, ["type", "submissionId", "reviewId"]);
    return {
      type,
      submissionId: requiredText(source, "submissionId"),
      reviewId: requiredText(source, "reviewId"),
    };
  }
  if (type === "mechanical_failure") {
    assertExactKeys(source, ["type", "failureId", "issueIds", "factIds"]);
    return {
      type,
      failureId: requiredText(source, "failureId"),
      issueIds: requiredTextArray(source, "issueIds"),
      factIds: requiredTextArray(source, "factIds"),
    };
  }
  throw new Error("Architect repair source is invalid.");
}
import type { PlanReconciliation } from "./task-contracts.js";
