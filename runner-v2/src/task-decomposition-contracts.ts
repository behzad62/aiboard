/** Browser-safe diagnostic DTOs; no runner runtime dependencies. */
export interface TaskDecompositionObservation {
  taskId: string;
  status: string;
  attempts: number;
  submissions: number;
  submissionsWithFileInventory: number;
  /** Union across submitted attempts; null before submission or if any inventory is absent. */
  changedFileCount: number | null;
  /** Newly started delivery reviews, including reviews that have not completed. */
  independentReviews: number;
  /** Reused durable delivery reviews; these do not imply another model call. */
  reusedReviews: number;
  reviewDecisions: number;
  /** Rejected Architect review decisions, not budget resumes or ordinary plan edits. */
  correctionCycles: number;
  integrationConflicts: number;
}

export interface DecompositionReviewUsage {
  settledCalls: number;
  pendingCalls: number;
  inputTokens: number;
  outputTokens: number;
  /** Only settled, API-priced verifier calls; never a bill or an account-subscription price. */
  apiEstimatedCostMicros: number | null;
  apiPricedCalls: number;
  accountBackedCalls: number;
  unknownCostCalls: number;
  /** Historical model calls whose role is unknown; excluded from the verifier totals. */
  unattributedModelCalls: number;
}

export interface TaskDecompositionObservability {
  version: 1;
  /** All scheduler tasks except kernel-owned final verification, including cancelled tasks. */
  taskCount: number;
  /** Non-cancelled tasks, including already integrated work. */
  activeTaskCount: number;
  cancelledTaskCount: number;
  submissions: number;
  submissionsWithFileInventory: number;
  uniqueChangedFileCount: number | null;
  correctionCycles: number;
  integrationConflicts: number;
  /** All independent verifier-role usage, including plan and final review; null if unavailable. */
  reviewUsage: DecompositionReviewUsage | null;
  tasks: TaskDecompositionObservation[];
}
