import type {
  AcceptanceCriterion,
  CriterionEvidenceLink,
} from "./acceptance-contracts.js";
import type { FinalVerificationPlan } from "./final-verification-contracts.js";

export type TaskStatus =
  | "planned"
  | "assigned"
  | "running"
  | "waiting_guidance"
  | "submitted"
  | "architect_review"
  | "approved"
  | "rejected"
  | "integrating"
  | "integration_resolution"
  | "integrated"
  | "failed"
  | "cancelled";

export type BuildTaskKind = "implementation" | "final_verification";

export interface BuildTask {
  id: string;
  /** Legacy implementation tasks omit this field; final verification is explicit. */
  kind?: BuildTaskKind;
  objective: string;
  dependencies: string[];
  status: TaskStatus;
  requiredCapabilities: string[];
  /** Immutable for an active attempt; absent only on legacy pre-P1 plans. */
  acceptanceCriteria?: AcceptanceCriterion[];
  /** Monotonically versions the criterion set across plan revisions. */
  acceptanceCriteriaVersion?: number;
  /** Immutable evidence mapping captured when the current attempt is submitted. */
  criterionEvidenceLinks?: CriterionEvidenceLink[];
  attempt: number;
  /** Architect-granted mechanical ceiling after revising an exhausted failure. */
  attemptLimit?: number;
  assignedWorkerId?: string;
  workspacePath?: string;
  workspaceId?: string;
  workspaceBaselineRevision?: string;
  changeSetId?: string;
  guidanceRequestId?: string;
  failureReason?: string;
  integrationRevision?: string;
  conflictPaths?: string[];
  /** Immutable identity and plan metadata for a kernel-owned final-verification task. */
  generationId?: string;
  targetRevision?: string;
  planVersion?: number;
  verificationPlan?: FinalVerificationPlan;
  verificationSubmissionId?: string;
  verificationReviewId?: string;
}

export type FinalVerificationTask = Omit<
  BuildTask,
  "kind" | "generationId" | "targetRevision" | "planVersion" | "verificationPlan" | "changeSetId"
> & {
  kind: "final_verification";
  generationId: string;
  targetRevision: string;
  planVersion: number;
  verificationPlan: FinalVerificationPlan;
  changeSetId?: never;
};

export function isFinalVerificationTask(task: BuildTask): task is FinalVerificationTask {
  return task.kind === "final_verification";
}

export interface TaskGraph {
  tasks: BuildTask[];
  revision: number;
}

export interface PlanTaskUpdate {
  taskId: string;
  action: "cancel" | "revise";
  objective?: string;
  dependencies?: string[];
  requiredCapabilities?: string[];
  acceptanceCriteria?: AcceptanceCriterion[];
}

export interface PlanReconciliation {
  revision: number;
  summary: string;
  taskUpdates: PlanTaskUpdate[];
}

export type TaskGraphIssueCode =
  | "duplicate_task_id"
  | "missing_dependency"
  | "dependency_cycle"
  | "invalid_final_verification_task"
  | "missing_acceptance_criteria"
  | "invalid_acceptance_criterion"
  | "duplicate_acceptance_criterion_id";

export interface TaskGraphIssue {
  code: TaskGraphIssueCode;
  taskId?: string;
  dependencyId?: string;
  cycle?: string[];
  message: string;
}

export interface TaskGraphValidation {
  valid: boolean;
  issues: TaskGraphIssue[];
}
