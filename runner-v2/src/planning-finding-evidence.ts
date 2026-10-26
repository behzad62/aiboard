/** Browser-safe contracts and mechanical checks. Technical necessity remains a review judgment. */
export type PlanningFindingCriterion =
  | { kind: "task"; taskId: string; criterionId: string; text: string }
  | { kind: "requirement"; requirementId: string; criterionId: string; text: string }
  | { kind: "obligation"; obligationId: string; text: string }
  | { kind: "objective"; text: string };

export interface PlanningFindingEvidence {
  taskIds: string[];
  criteria: PlanningFindingCriterion[];
  /** The API, data contract, file, behavior or acceptance boundary actually required. */
  requiredContract: string;
  /** Concrete setup/order and observable acceptance failure, not mere feature relatedness. */
  failureWithoutChange: string;
  proposedFix: string;
  dependency?: { taskId: string; missingDependency: string };
  surfaces?: Array<{ taskId: string; surface: string }>;
}

export interface PlanningFindingEvidenceContext {
  tasks: readonly {
    id: string;
    dependencies: readonly string[];
    criteria: readonly { id: string; text: string }[];
    /** Absent in the basic planner; present scopes must be cited exactly. */
    writableSurfaces?: readonly string[];
  }[];
  requirements?: readonly { id: string; acceptanceConditions: readonly { id: string; description: string }[] }[];
  obligations?: readonly { id: string; description: string }[];
  objective?: string;
}

const textSchema = { type: "string", minLength: 1 };
function citationSchema(kind: string, fields: string[]) {
  return {
    type: "object", properties: { kind: { const: kind }, ...Object.fromEntries(fields.map((field) => [field, textSchema])) },
    required: ["kind", ...fields], additionalProperties: false,
  };
}

export const PLANNING_FINDING_EVIDENCE_SCHEMA = {
  type: "object",
  description: "Required for blocking planning findings under evidence policy 1. Cite existing IDs and exact criterion text; explain the required contract, reproducible failure and specific fix. Optional suggestions can be advisory without this object.",
  properties: {
    taskIds: { type: "array", items: textSchema, description: "Every affected task; consumer and producer for a dependency. Empty only for a source obligation with no owning task." },
    criteria: {
      type: "array", minItems: 1,
      description: "Task/requirement criterion text and blind obligation descriptions must match the reviewed records exactly. Objective text is an exact excerpt. A dependency must cite the consumer's own task criterion.",
      items: { oneOf: [
        citationSchema("task", ["taskId", "criterionId", "text"]),
        citationSchema("requirement", ["requirementId", "criterionId", "text"]),
        citationSchema("obligation", ["obligationId", "text"]),
        citationSchema("objective", ["text"]),
      ] },
    },
    requiredContract: textSchema,
    failureWithoutChange: textSchema,
    proposedFix: textSchema,
    dependency: {
      type: "object", description: "Required for missing_dependency: the consumer and the task whose output it needs.",
      properties: { taskId: textSchema, missingDependency: textSchema },
      required: ["taskId", "missingDependency"], additionalProperties: false,
    },
    surfaces: {
      type: "array", minItems: 1,
      description: "Required for blocking overlapping_scope/scope_creep. Cite actual declared writable surfaces when the full contract publishes them.",
      items: { type: "object", properties: { taskId: textSchema, surface: textSchema }, required: ["taskId", "surface"], additionalProperties: false },
    },
  },
  required: ["taskIds", "criteria", "requiredContract", "failureWithoutChange", "proposedFix"],
  additionalProperties: false,
};

/** Publish only citation sources actually available to this reviewer. */
export function planningFindingEvidenceSchema(reviewer: "basic" | "coverage") {
  const allowed = reviewer === "basic" ? ["task", "objective"] : ["task", "requirement", "obligation"];
  const criteria = PLANNING_FINDING_EVIDENCE_SCHEMA.properties.criteria;
  return {
    ...PLANNING_FINDING_EVIDENCE_SCHEMA,
    properties: {
      ...PLANNING_FINDING_EVIDENCE_SCHEMA.properties,
      criteria: { ...criteria, items: { oneOf: criteria.items.oneOf.filter((schema) => allowed.includes(schema.properties.kind.const)) } },
    },
  };
}

export const PLANNING_FINDING_GROUNDING_INSTRUCTIONS = [
  "Every blocking planning finding requires blockingEvidence: actual task ids and criterion references with exact text, the required API/data contract/file/behavior or acceptance boundary, a reproducible failureWithoutChange, and a specific proposedFix. Cite an existing requirement acceptance condition or your recorded blind source obligation for omitted source work; never invent a requirement. An optional improvement belongs in an advisory finding, not a blocker.",
  "For missing_dependency answer all three: exactly which output the consumer needs from the producer; which of the consumer's EXISTING acceptance criteria requires it; and what concretely fails if the consumer runs first. Populate blockingEvidence.dependency with taskId (consumer) and missingDependency (producer), and cite the consumer's own criterion. Related features, preferred ordering, possible enhancements, and a producer's criterion alone do not establish necessity. A transitive dependency already supplies the output; do not add a redundant edge.",
  "Example: an invitation UI does not depend on presence merely because showing online friends first would be nice. Only an existing criterion such as 'the invitation picker displays only online friends' can justify consuming the presence endpoint; quote that actual criterion and explain the failure when the endpoint is absent.",
  "For scope findings identify the actual affected surfaces and the criterion or source obligation violated. For cohesion findings cite each affected task's real acceptance criteria and demonstrate the missing independent acceptance boundary or unrelated required outcomes. Shared files, feature relatedness, task counts and aesthetic grouping preferences alone never justify blocking a plan.",
].join("\n");

function object(value: unknown, label: string, allowed: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object.`);
  const result = value as Record<string, unknown>;
  const unknown = Object.keys(result).filter((key) => !allowed.includes(key));
  if (unknown.length) throw new Error(`${label} has unknown fields: ${unknown.join(", ")}.`);
  return result;
}
function text(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string" || !value.trim()) throw new Error(`blockingEvidence requires ${key}.`);
  return value.trim();
}
function hasDependency(context: PlanningFindingEvidenceContext, consumer: string, producer: string): boolean {
  const tasks = new Map(context.tasks.map((task) => [task.id, task]));
  const pending = [...(tasks.get(consumer)?.dependencies ?? [])];
  const visited = new Set<string>();
  while (pending.length) {
    const id = pending.pop()!;
    if (id === producer) return true;
    if (visited.has(id)) continue;
    visited.add(id);
    pending.push(...(tasks.get(id)?.dependencies ?? []));
  }
  return false;
}

export function parsePlanningFindingEvidence(
  value: unknown,
  finding: { category: string; severity: string; taskIds?: readonly string[]; references: readonly string[] },
  context: PlanningFindingEvidenceContext,
  requireBlockingEvidence: boolean,
): PlanningFindingEvidence | undefined {
  const blocking = finding.severity === "blocking";
  if (value === undefined) {
    if (blocking && requireBlockingEvidence) throw new Error("Blocking planning findings require blockingEvidence. Supply verified criteria, a required contract, a reproducible failure and a fix; optional improvements can be advisory.");
    return undefined;
  }
  const record = object(value, "blockingEvidence", ["taskIds", "criteria", "requiredContract", "failureWithoutChange", "proposedFix", "dependency", "surfaces"]);
  const tasks = new Map(context.tasks.map((task) => [task.id, task]));
  if (!Array.isArray(record.taskIds) || record.taskIds.some((id) => typeof id !== "string" || !tasks.has(id))) throw new Error("blockingEvidence taskIds must reference existing active tasks.");
  const taskIds = [...new Set(record.taskIds as string[])];
  if (finding.taskIds && (new Set(finding.taskIds).size !== taskIds.length || finding.taskIds.some((id) => !taskIds.includes(id)))) throw new Error("blockingEvidence taskIds must match the finding's affected taskIds.");
  if (!Array.isArray(record.criteria) || record.criteria.length === 0) throw new Error("blockingEvidence requires actual acceptance criteria or source obligations.");
  const criteria = record.criteria.map((value): PlanningFindingCriterion => {
    const entry = object(value, "blockingEvidence criterion", ["kind", "taskId", "criterionId", "requirementId", "obligationId", "text"]);
    const citedText = text(entry, "text");
    if (entry.kind === "task") {
      object(value, "task criterion", ["kind", "taskId", "criterionId", "text"]);
      const taskId = text(entry, "taskId"), criterionId = text(entry, "criterionId");
      const criterion = tasks.get(taskId)?.criteria.find((criterion) => criterion.id === criterionId);
      if (!taskIds.includes(taskId) || !criterion) throw new Error(`blockingEvidence references unknown task criterion ${taskId}:${criterionId}.`);
      if (criterion.text.trim() !== citedText) throw new Error(`blockingEvidence criterion ${taskId}:${criterionId} text does not match the existing acceptance criterion.`);
      return { kind: "task", taskId, criterionId, text: citedText };
    }
    if (entry.kind === "requirement") {
      object(value, "requirement criterion", ["kind", "requirementId", "criterionId", "text"]);
      const requirementId = text(entry, "requirementId"), criterionId = text(entry, "criterionId");
      const criterion = context.requirements?.find((requirement) => requirement.id === requirementId)?.acceptanceConditions.find((condition) => condition.id === criterionId);
      if (!criterion || criterion.description.trim() !== citedText) throw new Error(`blockingEvidence requirement criterion ${requirementId}:${criterionId} or its text does not match the reviewed plan.`);
      return { kind: "requirement", requirementId, criterionId, text: citedText };
    }
    if (entry.kind === "obligation") {
      object(value, "source obligation", ["kind", "obligationId", "text"]);
      const obligationId = text(entry, "obligationId");
      if (!context.obligations?.some((obligation) => obligation.id === obligationId && obligation.description.trim() === citedText)) throw new Error(`blockingEvidence obligation ${obligationId} or its text does not match the recorded blind source obligations.`);
      return { kind: "obligation", obligationId, text: citedText };
    }
    if (entry.kind === "objective" && context.objective?.includes(citedText)) {
      object(value, "objective excerpt", ["kind", "text"]);
      return { kind: "objective", text: citedText };
    }
    throw new Error("blockingEvidence criterion must cite a task, requirement, recorded source obligation, or an exact objective excerpt.");
  });
  const result: PlanningFindingEvidence = {
    taskIds, criteria, requiredContract: text(record, "requiredContract"),
    failureWithoutChange: text(record, "failureWithoutChange"), proposedFix: text(record, "proposedFix"),
  };
  if (blocking && (finding.references.length === 0 || finding.references.some((ref) => !ref.trim()))) throw new Error("Blocking planning findings require non-empty evidence references.");
  if (record.dependency !== undefined) {
    const entry = object(record.dependency, "blockingEvidence dependency", ["taskId", "missingDependency"]);
    const taskId = text(entry, "taskId"), missingDependency = text(entry, "missingDependency");
    if (!taskIds.includes(taskId) || !taskIds.includes(missingDependency)) throw new Error("Dependency consumer and producer must be existing tasks included in blockingEvidence.taskIds.");
    if (taskId === missingDependency) throw new Error("A missing dependency cannot reference the same task.");
    if (!criteria.some((criterion) => criterion.kind === "task" && criterion.taskId === taskId)) throw new Error("A missing dependency must cite the consumer task's own existing acceptance criterion.");
    if (hasDependency(context, taskId, missingDependency)) throw new Error("The required output is already available through a direct or transitive dependency.");
    if (hasDependency(context, missingDependency, taskId)) throw new Error("The proposed missing dependency would create a cycle.");
    result.dependency = { taskId, missingDependency };
  }
  if (blocking && finding.category === "missing_dependency" && !result.dependency) throw new Error("missing_dependency requires blockingEvidence.dependency naming the consumer and producer.");
  if (record.surfaces !== undefined) {
    if (!Array.isArray(record.surfaces) || record.surfaces.length === 0) throw new Error("blockingEvidence surfaces must name affected task surfaces.");
    result.surfaces = record.surfaces.map((value) => {
      const entry = object(value, "blockingEvidence surface", ["taskId", "surface"]);
      const taskId = text(entry, "taskId"), surface = text(entry, "surface");
      const task = tasks.get(taskId);
      if (!taskIds.includes(taskId) || !task) throw new Error(`blockingEvidence surface cites unknown affected task ${taskId}.`);
      if (task.writableSurfaces && !task.writableSurfaces.includes(surface)) throw new Error(`blockingEvidence surface ${surface} is not a declared writable surface of ${taskId}.`);
      return { taskId, surface };
    });
  }
  if (blocking && ["overlapping_scope", "scope_creep"].includes(finding.category)) {
    if (!result.surfaces || taskIds.length === 0 || taskIds.some((id) => !result.surfaces!.some((surface) => surface.taskId === id))) throw new Error("Blocking scope findings require actual surfaces for every affected task.");
    if (finding.category === "overlapping_scope" && taskIds.length < 2) throw new Error("overlapping_scope requires at least two affected tasks.");
  }
  if (blocking && ["oversized_task", "undersized_task", "incoherent_task"].includes(finding.category)) {
    if (taskIds.length === 0 || taskIds.some((id) => !criteria.some((criterion) => criterion.kind === "task" && criterion.taskId === id))) throw new Error("Blocking cohesion findings require each affected task's actual acceptance criteria.");
    if (finding.category === "undersized_task" && taskIds.length < 2) throw new Error("undersized_task requires at least two tasks to demonstrate unnecessary fragmentation.");
  }
  return result;
}
