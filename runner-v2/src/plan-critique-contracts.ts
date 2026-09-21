import type { BuildTask } from "./task-contracts.js";
import { isFinalVerificationTask } from "./task-contracts.js";
import type {
  VerifierExcludedModel,
  VerifierRuntimeBinding,
} from "./verifier-contracts.js";

export type PlanCritiqueMode = "risk_based" | "always" | "off";
export const PLAN_CRITIQUE_MODES: readonly PlanCritiqueMode[] = ["risk_based", "always", "off"];
export const PLAN_CRITIQUE_TASK_COUNT_THRESHOLD = 4;
export const PLAN_CRITIQUE_FAN_IN_THRESHOLD = 2;
export const PLAN_CRITIQUE_MAX_FINDINGS = 50;

export type PlanRiskLevel = "low" | "high";
export type PlanRiskReasonCode =
  | "architect_declared_high"
  | "stricter_qualification"
  | "task_count"
  | "dependency_fan_in";

export interface PlanRiskReason {
  code: PlanRiskReasonCode;
  evidence: string[];
}

export interface PlanRiskAssessment {
  risk: PlanRiskLevel;
  reasons: PlanRiskReason[];
}

export interface PlanRiskInput {
  architectDeclaration: PlanRiskLevel;
  stricterQualification: boolean;
  tasks: readonly Pick<BuildTask, "id" | "dependencies" | "status" | "kind">[];
}

export function assessPlanRisk(input: PlanRiskInput): PlanRiskAssessment {
  const reasons: PlanRiskReason[] = [];
  if (input.architectDeclaration === "high") {
    reasons.push({ code: "architect_declared_high", evidence: ["architect:high"] });
  }
  if (input.stricterQualification) {
    reasons.push({ code: "stricter_qualification", evidence: ["qualification:strict"] });
  }
  const live = input.tasks.filter(
    (task) => task.status !== "cancelled" && task.kind !== "final_verification",
  );
  if (live.length >= PLAN_CRITIQUE_TASK_COUNT_THRESHOLD) {
    reasons.push({ code: "task_count", evidence: [`tasks:${live.length}`] });
  }
  const fanIn = live
    .filter((task) => new Set(task.dependencies).size >= PLAN_CRITIQUE_FAN_IN_THRESHOLD)
    .map((task) => `${task.id}:${new Set(task.dependencies).size}`)
    .sort();
  if (fanIn.length > 0) reasons.push({ code: "dependency_fan_in", evidence: fanIn });
  return { risk: reasons.length > 0 ? "high" : "low", reasons };
}

export function planCritiqueRequired(
  mode: PlanCritiqueMode,
  assessment: PlanRiskAssessment,
): boolean {
  if (mode === "off") return false;
  if (mode === "always") return true;
  return assessment.risk === "high";
}

export type PlanCritiqueSeverity = "blocking" | "advisory";
export const PLAN_CRITIQUE_CATEGORIES = [
  "ambiguous_criterion",
  "untestable_criterion",
  "missing_dependency",
  "overlapping_scope",
  "missing_failure_mode",
  "unproven_assumption",
  "oversized_task",
  "missing_integration_task",
] as const;
export type PlanCritiqueCategory = (typeof PLAN_CRITIQUE_CATEGORIES)[number];

export interface PlanCritiqueFinding {
  findingId: string;
  severity: PlanCritiqueSeverity;
  category: PlanCritiqueCategory;
  taskIds: string[];
  criterionIds?: Array<{ taskId: string; criterionId: string }>;
  claim: string;
  evidence: string[];
}

export interface PlanCritiqueResolutionItem {
  findingId: string;
  resolution: "plan_reconciled" | "rejected";
  rationale: string;
}

export interface PlanCritiqueProjection {
  critiqueId: string;
  planRevision: number;
  runtime: VerifierRuntimeBinding;
  excludedModels: VerifierExcludedModel[];
  status: "requested" | "submitted" | "resolved";
  requestedAt: string;
  submittedAt?: string;
  resolvedAt?: string;
  findings?: PlanCritiqueFinding[];
  blockingFindingIds?: string[];
  resolution?: {
    planRevisionAfter: number;
    resolvedBy: "architect" | "runner";
    resolutions: PlanCritiqueResolutionItem[];
  };
  supersededByCritiqueId?: string;
}

export interface PlanCritiqueState {
  policy?: { mode: PlanCritiqueMode };
  risk?: {
    planRevision: number;
    architectDeclaration: PlanRiskLevel;
    stricterQualification: boolean;
    assessment: PlanRiskAssessment;
    assessedAt: string;
  };
  current?: PlanCritiqueProjection;
  history: PlanCritiqueProjection[];
  skipped?: { planRevision: number; reason: PlanCritiqueSkipReason; skippedAt: string };
}

export type PlanCritiqueSkipReason = "policy_off" | "low_plan_risk" | "critic_failed" | "plan_only";

export function parsePlanCritiqueFindings(
  value: unknown,
  tasks: Readonly<Record<string, BuildTask>>,
): PlanCritiqueFinding[] {
  if (!Array.isArray(value)) throw new Error("Plan critique findings must be an array.");
  if (value.length > PLAN_CRITIQUE_MAX_FINDINGS) {
    throw new Error(`Plan critique allows at most ${PLAN_CRITIQUE_MAX_FINDINGS} findings.`);
  }
  const seen = new Set<string>();
  return value.map((candidate, index) => {
    if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) {
      throw new Error(`Plan critique finding ${index} is invalid.`);
    }
    const record = candidate as Record<string, unknown>;
    const findingId = requiredText(record, "findingId");
    if (seen.has(findingId)) throw new Error(`Plan critique has a duplicate finding ${findingId}.`);
    seen.add(findingId);
    const severity = requiredText(record, "severity");
    if (severity !== "blocking" && severity !== "advisory") {
      throw new Error(`Plan critique finding ${findingId} severity ${severity} is invalid.`);
    }
    const category = requiredText(record, "category");
    if (!(PLAN_CRITIQUE_CATEGORIES as readonly string[]).includes(category)) {
      throw new Error(`Plan critique finding ${findingId} category ${category} is invalid.`);
    }
    const taskIds = textArray(record, "taskIds", findingId, 0);
    for (const taskId of taskIds) {
      const task = tasks[taskId];
      if (!task || task.status === "cancelled" || isFinalVerificationTask(task)) {
        throw new Error(`Plan critique finding ${findingId} references unknown task ${taskId}.`);
      }
    }
    const criterionIds = record.criterionIds === undefined
      ? undefined
      : parseCriterionRefs(record.criterionIds, findingId, tasks);
    const evidence = textArray(record, "evidence", findingId, 1);
    return {
      findingId,
      severity,
      category: category as PlanCritiqueCategory,
      taskIds: [...new Set(taskIds)],
      ...(criterionIds ? { criterionIds } : {}),
      claim: requiredText(record, "claim"),
      evidence,
    };
  });
}

function parseCriterionRefs(
  value: unknown,
  findingId: string,
  tasks: Readonly<Record<string, BuildTask>>,
): Array<{ taskId: string; criterionId: string }> {
  if (!Array.isArray(value)) throw new Error(`Plan critique finding ${findingId} criterionIds is invalid.`);
  return value.map((candidate) => {
    if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) {
      throw new Error(`Plan critique finding ${findingId} criterion reference is invalid.`);
    }
    const record = candidate as Record<string, unknown>;
    const taskId = requiredText(record, "taskId");
    const criterionId = requiredText(record, "criterionId");
    const known = tasks[taskId]?.acceptanceCriteria?.some((criterion) => criterion.id === criterionId);
    if (!known) {
      throw new Error(`Plan critique finding ${findingId} references unknown criterion ${taskId}:${criterionId}.`);
    }
    return { taskId, criterionId };
  });
}

function textArray(record: Record<string, unknown>, key: string, findingId: string, min: number): string[] {
  const value = record[key];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim())) {
    throw new Error(`Plan critique finding ${findingId} ${key} must contain non-empty strings.`);
  }
  if (value.length < min) {
    throw new Error(`Plan critique finding ${findingId} requires at least one ${key === "evidence" ? "evidence string" : key}.`);
  }
  return [...(value as string[])];
}

function requiredText(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string" || !value.trim()) throw new Error(`${key} is required.`);
  return value.trim();
}
