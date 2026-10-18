import type { ExecutionPlanRevision } from "./planning-contracts.js";

/** Kernel-stamped per revision ("accepted plan revision <id>"); comparing it marked every task changed. */
const RESTAMPED_TASK_FIELDS = ["requiredBase"] as const;
/** Derived from the tasks and requirements, which are diffed themselves; omitted from the review. */
const DERIVED_REQUIREMENT_FIELDS = ["contributingTaskIds"] as const;
const DERIVED_PHASE_FIELDS = ["requirementIds", "contributingTaskIds"] as const;

type Keyed = { readonly id: string };

export interface PlanSectionDiff {
  added: unknown[];
  changed: unknown[];
  removed: string[];
  unchanged: unknown[];
}

export interface PlanRevisionDiff {
  priorRevisionId: string;
  revisionId: string;
  note: string;
  tasks: PlanSectionDiff;
  phases: PlanSectionDiff;
  requirements: PlanSectionDiff;
  planningDecisions: PlanSectionDiff;
  validationObligations: { changed: false } | { changed: true; before: readonly string[]; after: readonly string[] };
}

/**
 * What a coverage re-review needs from a revised plan: everything that changed since the revision the
 * prior review judged, in full, and only the ids of what did not. Re-sending the whole plan on every
 * revision made each re-review a full-plan review (tunnel run: ~118 KB per pass).
 */
export function planRevisionDiff(prior: ExecutionPlanRevision, current: ExecutionPlanRevision): PlanRevisionDiff {
  return {
    priorRevisionId: prior.revisionId,
    revisionId: current.revisionId,
    note: "Only what changed since the revision the prior review judged. Added and changed items are complete; removed and unchanged items are listed by id (unchanged tasks with their outcome).",
    tasks: diffSection(prior.tasks, current.tasks, (task) => without(task, RESTAMPED_TASK_FIELDS), (task) => ({
      id: task.id,
      outcome: truncate((task as { outcome?: { user?: string } }).outcome?.user ?? "", 120),
    })),
    phases: diffSection(prior.phases, current.phases, (phase) => without(phase, DERIVED_PHASE_FIELDS)),
    requirements: diffSection(prior.requirements, current.requirements, (requirement) => without(requirement, DERIVED_REQUIREMENT_FIELDS)),
    planningDecisions: diffSection(prior.planningDecisions, current.planningDecisions),
    validationObligations: stableJson(prior.validationObligations) === stableJson(current.validationObligations)
      ? { changed: false }
      : { changed: true, before: prior.validationObligations, after: current.validationObligations },
  };
}

function diffSection<T extends Keyed>(
  before: readonly T[],
  after: readonly T[],
  comparable: (item: T) => unknown = (item) => item,
  unchangedSummary: (item: T) => unknown = (item) => item.id,
): PlanSectionDiff {
  const prior = new Map(before.map((item) => [item.id, item]));
  const next = new Set(after.map((item) => item.id));
  const diff: PlanSectionDiff = { added: [], changed: [], removed: [], unchanged: [] };
  for (const item of after) {
    const earlier = prior.get(item.id);
    if (!earlier) diff.added.push(comparable(item));
    else if (stableJson(comparable(earlier)) !== stableJson(comparable(item))) diff.changed.push(comparable(item));
    else diff.unchanged.push(unchangedSummary(item));
  }
  for (const item of before) if (!next.has(item.id)) diff.removed.push(item.id);
  return diff;
}

function without<T>(item: T, fields: readonly string[]): T {
  const copy = { ...(item as Record<string, unknown>) };
  for (const field of fields) delete copy[field];
  return copy as T;
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** Key order is not meaning: an upserted item with reordered keys is not a change. */
function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, entry) => entry && typeof entry === "object" && !Array.isArray(entry)
    ? Object.fromEntries(Object.entries(entry as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)))
    : entry);
}
