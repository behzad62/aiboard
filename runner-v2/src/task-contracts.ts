import type {
  AcceptanceCriterion,
  CriterionEvidenceLink,
} from "./acceptance-contracts.js";

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

export interface BuildTask {
  id: string;
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
