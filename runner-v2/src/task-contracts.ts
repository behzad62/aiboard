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

export type TaskGraphIssueCode =
  | "duplicate_task_id"
  | "missing_dependency"
  | "dependency_cycle";

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
