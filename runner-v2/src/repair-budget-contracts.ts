import { createHash } from "node:crypto";

export const DEFAULT_ISSUE_REPAIR_CYCLE_LIMIT = 3;

export interface RepairIssueIdentityInput {
  readonly projectId: string;
  readonly rootCause: string;
}

export interface RepairBudgetRecord {
  readonly issueId: string;
  readonly rootCause: string;
  readonly limit: number;
  readonly used: number;
  readonly externalBlocker?: {
    readonly acceptanceCondition: string;
    readonly evidence: string[];
    readonly attemptedResolutions: string[];
    readonly requiredOwnerAction: string;
  };
  readonly hypotheses: string[];
  readonly outcomes: string[];
}

export interface RepairDispatchCheck {
  readonly allowed: boolean;
  readonly reason?: string;
}

export function repairIssueIdentity(input: RepairIssueIdentityInput): string {
  if (!input.projectId.trim() || !input.rootCause.trim()) {
    throw new Error("Repair issue identity requires project and root cause.");
  }
  const normal = input.rootCause.trim().toLowerCase().replace(/\s+/g, " ");
  return `repair:${createHash("sha256").update(`${input.projectId}\0${normal}`).digest("hex").slice(0, 24)}`;
}

/**
 * T6b repair (B5): one root-cause identity per repair source, shared by the
 * dispatch gate and the charge site. A root cause names the repair source
 * contract plus the failing check (category, affected obligation or
 * criterion, failing check ids) — never a task name, symptom text,
 * generation id, or evidence id, so renamed tasks and reworded symptoms
 * share the original issue while unrelated failures open their own.
 */
export function repairRootCauseForCategory(category: string): string {
  const namespaced = category.includes(":") ? category : `final-verification:${category}`;
  const [source, ...rest] = namespaced.split(":");
  if (source === "verifier") return namespaced;
  if (source === "delivery-boundary") return namespaced;
  if (source === "final-verification") return `final-verification:${rest.join(":")}`;
  return namespaced;
}

/**
 * T6b repair (R2-B5): the final-verification issue identity is the
 * category plus the sorted failing check/test ids — never the category
 * alone when failing ids are known. Already-qualified namespaces
 * (verifier criteria, delivery-boundary checks, delivery-review
 * criterion/finding keys) pass through unchanged: the affected
 * contract/criterion/check is part of their identity where known.
 */
export function repairRootCauseForCheck(input: {
  readonly category: string;
  readonly failingIds: readonly string[];
}): string {
  const namespaced = input.category.includes(":") ? input.category : `final-verification:${input.category}`;
  const [source] = namespaced.split(":");
  if (source !== "final-verification") return namespaced;
  const ids = [...new Set(input.failingIds.map((id) => id.trim()).filter((id) => id.length > 0))].sort();
  if (ids.length === 0) return namespaced;
  return `${namespaced}:${JSON.stringify(ids)}`;
}

/**
 * T6b repair (R3-B1): the delivery-boundary issue identity is per task
 * and per failing check — `delivery-boundary:<taskId>:<checkId>` plus the
 * sorted failing test ids from the check report when known — never the
 * category alone, so unrelated tasks never share one 3-cycle budget.
 * The single helper shared by the kernel dispatch gate (build-runtime)
 * and the Architect resolve tool (architect-tools).
 */
export function deliveryBoundaryRootCause(input: {
  readonly taskId: string;
  readonly checkId: string;
  readonly failingIds?: readonly string[];
}): string {
  const taskId = input.taskId.trim();
  const checkId = input.checkId.trim();
  if (!taskId || !checkId) {
    throw new Error("Delivery boundary issue identity requires task and check.");
  }
  const ids = [...new Set((input.failingIds ?? []).map((id) => id.trim()).filter((id) => id.length > 0))].sort();
  if (ids.length === 0) return `delivery-boundary:${taskId}:${checkId}`;
  return `delivery-boundary:${taskId}:${checkId}:${JSON.stringify(ids)}`;
}

/** Failing test ids per category from non-green completed checks. */
export function failingTestIdsByCategory(checks: readonly {
  readonly category: string;
  readonly green: boolean;
  readonly facts: readonly {
    readonly kind: string;
    readonly report?: { readonly failingTestIds?: readonly string[] } | null;
  }[];
}[]): Map<string, string[]> {
  const byCategory = new Map<string, string[]>();
  for (const check of checks) {
    if (check.green) continue;
    const ids = check.facts.flatMap((fact) => fact.kind === "command" ? fact.report?.failingTestIds ?? [] : []);
    byCategory.set(check.category, [...(byCategory.get(check.category) ?? []), ...ids]);
  }
  return byCategory;
}

/** Enrich bare final-verification categories with their failing ids. */
export function withFailingIds(
  category: string,
  failingIdsByCategory: ReadonlyMap<string, readonly string[]>,
): string {
  const namespaced = category.includes(":") ? category : `final-verification:${category}`;
  const [source, bare, ...rest] = namespaced.split(":");
  if (source !== "final-verification" || bare === undefined || rest.length > 0) return category;
  return repairRootCauseForCheck({ category: bare, failingIds: failingIdsByCategory.get(bare) ?? [] });
}

/** One member issue per category; a multi-category dispatch checks every member. */
export function repairMemberIssues(projectId: string, categories: readonly string[]): { issueId: string; rootCause: string }[] {
  const seen = new Map<string, { issueId: string; rootCause: string }>();
  for (const category of categories) {
    const rootCause = repairRootCauseForCategory(category);
    const issueId = repairIssueIdentity({ projectId, rootCause });
    if (!seen.has(issueId)) seen.set(issueId, { issueId, rootCause });
  }
  return [...seen.values()];
}

export function repairBudgetAllowsDispatch(record: RepairBudgetRecord, options: {
  readonly maxTaskAttemptsRemaining: number;
  readonly maxRepairPlanRemaining: number;
}): RepairDispatchCheck {
  if (record.externalBlocker) return { allowed: false, reason: "A proven external blocker does not consume futile attempts." };
  if (record.used >= record.limit) return { allowed: false, reason: "Issue repair budget is exhausted." };
  if (options.maxTaskAttemptsRemaining <= 0) return { allowed: false, reason: "Task attempt budget is exhausted." };
  if (options.maxRepairPlanRemaining <= 0) return { allowed: false, reason: "Run-level repair-plan budget is exhausted." };
  return { allowed: true };
}

export function isDiagnosticRepairCycle(hypothesis: string, outcome: string): boolean {
  return /^diagnostic(?:[\s:_\-]|$)/i.test(outcome.trim()) ||
    /^diagnostic(?:[\s:_\-]|$)/i.test(hypothesis.trim());
}

export function chargeRepairIssue(record: RepairBudgetRecord, cycle: {
  readonly hypothesis: string;
  readonly outcome: string;
  readonly evidenceIds: readonly string[];
}): RepairBudgetRecord {
  const diagnostic = isDiagnosticRepairCycle(cycle.hypothesis, cycle.outcome);
  if (!cycle.hypothesis.trim() || !cycle.outcome.trim() || (!diagnostic && cycle.evidenceIds.length === 0)) {
    throw new Error("A substantive repair cycle records hypothesis, outcome, and evidence.");
  }
  if (diagnostic) return record;
  return { ...record, used: record.used + 1, hypotheses: [...record.hypotheses, cycle.hypothesis], outcomes: [...record.outcomes, cycle.outcome] };
}

export function recordExternalBlocker(record: RepairBudgetRecord, blocker: RepairBudgetRecord["externalBlocker"]): RepairBudgetRecord {
  if (!blocker || !blocker.acceptanceCondition.trim() || blocker.evidence.length === 0 || blocker.attemptedResolutions.length === 0 || !blocker.requiredOwnerAction.trim()) {
    throw new Error("A blocker record requires exact acceptance condition, evidence, attempted resolutions, and owner action.");
  }
  return { ...record, externalBlocker: blocker };
}

export function newRepairBudgetRecord(issueId: string, rootCause: string, limit = DEFAULT_ISSUE_REPAIR_CYCLE_LIMIT): RepairBudgetRecord {
  return { issueId, rootCause, limit, used: 0, hypotheses: [], outcomes: [] };
}
