import { createHash } from "node:crypto";

import type {
  NativeTool,
  ToolExecutionContext,
  ToolExecutionOutput,
  ValidationResult,
} from "./agent-contracts.js";
import {
  rebuildSchedulerProjection,
  type SchedulerStore,
} from "./scheduler-store.js";
import type { NativeBuildRunPolicy } from "./build-spec.js";
import type {
  BuildTask,
  PlanReconciliation,
  PlanTaskUpdate,
} from "./task-contracts.js";
import {
  validateAcceptanceCriteria,
  validateCriterionReviewVerdicts,
  type AcceptanceCriterion,
  type CriterionReviewVerdict,
} from "./acceptance-contracts.js";
import type { EvidenceStore } from "./evidence-store.js";
import { validateTaskGraph } from "./task-graph.js";

export interface ArchitectToolsOptions {
  store: SchedulerStore;
  clock?: () => string;
  runPolicy?: NativeBuildRunPolicy;
  planOnlyCompletionAvailable?: boolean;
  evidenceStore?: EvidenceStore;
}

interface PlanTaskInput {
  id: string;
  objective: string;
  dependencies: string[];
  requiredCapabilities: string[];
  acceptanceCriteria: AcceptanceCriterion[];
}

interface PlanTasksInput {
  revision: number;
  tasks: PlanTaskInput[];
}

interface ReviseTaskInput {
  taskId: string;
  revision: number;
  objective?: string;
  dependencies?: string[];
  requiredCapabilities?: string[];
  acceptanceCriteria?: AcceptanceCriterion[];
}

interface AnswerGuidanceInput {
  requestId: string;
  expectedVersion: number;
  answer: string;
}

interface ReviewTaskInput {
  taskId: string;
  decision: "approved" | "rejected";
  summary: string;
  evidenceArtifactHashes: string[];
  criterionVerdicts?: CriterionReviewVerdict[];
  planReconciliation?: PlanReconciliation;
}

interface TaskIdInput { taskId: string }
interface CompleteRunInput { summary: string }

export function createArchitectTools(
  options: ArchitectToolsOptions
): NativeTool<unknown>[] {
  const clock = options.clock ?? (() => new Date().toISOString());
  const core = [
    planTasksTool(options.store, clock),
    reviseTaskTool(options.store, clock),
    answerGuidanceTool(options.store, clock),
  ];
  if (options.runPolicy === "plan_only") {
    return options.planOnlyCompletionAvailable
      ? [...core, completeRunTool(options.store, clock, "plan_only")]
      : core;
  }
  return [
    ...core,
    reconcilePlanTool(options.store, clock),
    reviewTaskTool(options.store, clock, options.evidenceStore),
    requestIntegrationTool(options.store, clock),
    completeRunTool(options.store, clock, options.runPolicy ?? "finish"),
  ];
}

function reconcilePlanTool(
  store: SchedulerStore,
  clock: () => string
): NativeTool<PlanReconciliation> {
  return lifecycleTool({
    name: "reconcile_plan",
    description: "Atomically cancel or revise stale pending tasks and rewire their dependencies when current evidence invalidates the existing plan",
    schema: planReconciliationSchema(),
    validate: validatePlanReconciliation,
    execute: async (input, context) => {
      const denied = architectOnly(context);
      if (denied) return denied;
      return appendEvent(store, {
        runId: context.runId,
        type: "plan.reconciled",
        occurredAt: clock(),
        actor: { role: "architect", id: context.actor.id },
        idempotencyKey: `plan-reconciliation:${input.revision}:${shortHash(input.summary)}`,
        payload: { ...input },
      }, {
        type: "architect_action",
        action: "plan_reconciled",
        referenceId: String(input.revision),
      });
    },
  });
}

function planTasksTool(
  store: SchedulerStore,
  clock: () => string
): NativeTool<PlanTasksInput> {
  return lifecycleTool({
    name: "plan_tasks",
    description: "Create the Architect-owned task graph; only graph mechanics are validated",
    schema: {
      type: "object",
      properties: {
        revision: { type: "integer", minimum: 1 },
        tasks: { type: "array", items: taskSchema() },
      },
      required: ["revision", "tasks"],
      additionalProperties: false,
    },
    validate: validatePlan,
    execute: async (input, context) => {
      const denied = architectOnly(context);
      if (denied) return denied;
      const tasks: BuildTask[] = input.tasks.map((task) => ({
        ...task,
        dependencies: [...task.dependencies],
        requiredCapabilities: [...task.requiredCapabilities],
        acceptanceCriteria: task.acceptanceCriteria.map((criterion) => ({ ...criterion })),
        acceptanceCriteriaVersion: 1,
        status: "planned",
        attempt: 0,
      }));
      const validation = validateTaskGraph(tasks, { requireAcceptanceCriteria: true });
      if (!validation.valid) {
        return errorOutput(
          "invalid_task_graph",
          `Plan has mechanical issues: ${validation.issues
            .map((issue) => issue.code)
            .join(", ")}.`,
          validation.issues.map((issue) => issue.message)
        );
      }
      return appendEvent(
        store,
        {
          runId: context.runId,
          type: "plan.created",
          occurredAt: clock(),
          actor: { role: "architect", id: context.actor.id },
          idempotencyKey: `plan:${input.revision}`,
          payload: { revision: input.revision, tasks },
        },
        {
          type: "architect_action",
          action: "plan_created",
          referenceId: String(input.revision),
        }
      );
    },
  });
}

function reviseTaskTool(
  store: SchedulerStore,
  clock: () => string
): NativeTool<ReviseTaskInput> {
  return lifecycleTool({
    name: "revise_task",
    description: "Revise a task; when it has already been attempted, grant the revised task one fresh attempt without interpreting its semantic intent",
    schema: {
      type: "object",
      properties: {
        taskId: { type: "string", minLength: 1 },
        revision: { type: "integer", minimum: 1 },
        objective: { type: "string", minLength: 1 },
        dependencies: { type: "array", items: { type: "string" } },
        requiredCapabilities: { type: "array", items: { type: "string" } },
        acceptanceCriteria: { type: "array", minItems: 1, items: criterionSchema() },
      },
      required: ["taskId", "revision"],
      additionalProperties: false,
    },
    validate: validateRevision,
    execute: async (input, context) => {
      const denied = architectOnly(context);
      if (denied) return denied;
      const patch = {
        ...(input.objective !== undefined ? { objective: input.objective } : {}),
        ...(input.dependencies ? { dependencies: [...input.dependencies] } : {}),
        ...(input.requiredCapabilities
          ? { requiredCapabilities: [...input.requiredCapabilities] }
          : {}),
        ...(input.acceptanceCriteria
          ? { acceptanceCriteria: input.acceptanceCriteria.map((criterion) => ({ ...criterion })) }
          : {}),
      };
      return appendEvent(store, {
        runId: context.runId,
        type: "task.revised",
        occurredAt: clock(),
        actor: { role: "architect", id: context.actor.id },
        idempotencyKey: `task-revision:${input.revision}:${input.taskId}`,
        payload: { taskId: input.taskId, revision: input.revision, patch },
      }, {
        type: "architect_action",
        action: "task_revised",
        referenceId: input.taskId,
      });
    },
  });
}

function answerGuidanceTool(
  store: SchedulerStore,
  clock: () => string
): NativeTool<AnswerGuidanceInput> {
  return lifecycleTool({
    name: "answer_guidance",
    description: "Answer a worker guidance request as the Architect",
    schema: objectSchema({
      requestId: { type: "string", minLength: 1 },
      expectedVersion: { type: "integer", minimum: 1 },
      answer: { type: "string", minLength: 1 },
    }, ["requestId", "expectedVersion", "answer"]),
    validate: (input) => validateObject(input, (value) => {
      if (!nonEmpty(value.requestId) || !positiveInteger(value.expectedVersion) || !nonEmpty(value.answer)) return null;
      return value as unknown as AnswerGuidanceInput;
    }, "requestId, expectedVersion, and answer are required"),
    execute: async (input, context) => {
      const denied = architectOnly(context);
      if (denied) return denied;
      return appendEvent(store, {
        runId: context.runId,
        type: "guidance.answered",
        occurredAt: clock(),
        actor: { role: "architect", id: context.actor.id },
        idempotencyKey: `guidance-answer:${input.requestId}:${input.expectedVersion}:${shortHash(input.answer)}`,
        payload: {
          requestId: input.requestId,
          expectedVersion: input.expectedVersion,
          answer: input.answer,
        },
      }, {
        type: "architect_action",
        action: "guidance_answered",
        referenceId: input.requestId,
      });
    },
  });
}

function reviewTaskTool(
  store: SchedulerStore,
  clock: () => string,
  evidenceStore?: EvidenceStore
): NativeTool<ReviewTaskInput> {
  return lifecycleTool({
    name: "review_task",
    description: "Record the Architect semantic review decision for a submitted task",
    schema: objectSchema({
      taskId: { type: "string", minLength: 1 },
      decision: { type: "string", enum: ["approved", "rejected"] },
      summary: { type: "string", minLength: 1 },
      evidenceArtifactHashes: {
        type: "array",
        items: { type: "string", pattern: "^[a-f0-9]{64}$" },
      },
      criterionVerdicts: {
        type: "array",
        minItems: 1,
        items: criterionReviewVerdictSchema(),
      },
      planReconciliation: planReconciliationSchema(),
    }, ["taskId", "decision", "summary", "evidenceArtifactHashes"]),
    validate: validateReview,
    execute: async (input, context) => {
      const denied = architectOnly(context);
      if (denied) return denied;
      const task = rebuildSchedulerProjection(
        store.readRun(context.runId)
      ).tasks[input.taskId];
      if (!task) return errorOutput("unknown_task", `Unknown task ${input.taskId}.`);
      if (task.acceptanceCriteria) {
        if (!input.criterionVerdicts) {
          return errorOutput(
            "criterion_review_required",
            `Task ${input.taskId} review requires one verdict per acceptance criterion.`
          );
        }
        if (!task.criterionEvidenceLinks) {
          return errorOutput(
            "criterion_evidence_required",
            `Task ${input.taskId} has no submitted criterion evidence mappings.`
          );
        }
        if (!evidenceStore) {
          return errorOutput(
            "evidence_store_required",
            "Criterion review requires the durable evidence store."
          );
        }
        const validation = validateCriterionReviewVerdicts(
          task.acceptanceCriteria,
          input.criterionVerdicts,
          task.criterionEvidenceLinks,
          {
            evidenceRecords: evidenceStore.list({
              runId: context.runId,
              taskId: task.id,
              limit: 1_000,
            }),
            runId: context.runId,
            taskId: task.id,
            attempt: task.attempt,
          }
        );
        if (!validation.valid) {
          return errorOutput(
            "invalid_criterion_review",
            `Task review has invalid criterion verdicts: ${validation.issues.join(" ")}`
          );
        }
        if (input.decision === "approved" && validation.unsatisfiedCriterionIds.length > 0) {
          return errorOutput(
            "unsatisfied_criterion",
            `Task ${input.taskId} cannot be approved with unsatisfied criteria: ${validation.unsatisfiedCriterionIds.join(", ")}.`
          );
        }
        if (input.decision === "rejected" && validation.unsatisfiedCriterionIds.length === 0) {
          return errorOutput(
            "rejection_requires_unsatisfied_criterion",
            `Rejected task ${input.taskId} must identify an unsatisfied criterion.`
          );
        }
      }
      return appendEvent(store, {
        runId: context.runId,
        type: "review.decided",
        occurredAt: clock(),
        actor: { role: "architect", id: context.actor.id },
        idempotencyKey: task
          ? `review:${input.taskId}:attempt:${task.attempt}:changeset:${task.changeSetId ?? "none"}`
          : `review:${input.taskId}:unknown`,
        payload: {
          taskId: input.taskId,
          decision: input.decision,
          summary: input.summary,
          evidenceArtifactHashes: input.evidenceArtifactHashes,
          ...(input.criterionVerdicts
            ? {
                criterionVerdicts: input.criterionVerdicts.map((verdict) => ({
                  ...verdict,
                  evidenceIds: [...verdict.evidenceIds],
                  ...(verdict.artifactHashes
                    ? { artifactHashes: [...verdict.artifactHashes] }
                    : {}),
                })),
              }
            : {}),
          ...(input.planReconciliation
            ? { planReconciliation: input.planReconciliation }
            : {}),
        },
      }, {
        type: "architect_action",
        action: "review_decided",
        referenceId: input.taskId,
      });
    },
  });
}

function requestIntegrationTool(
  store: SchedulerStore,
  clock: () => string
): NativeTool<TaskIdInput> {
  return lifecycleTool({
    name: "request_integration",
    description: "Request serialized integration of an Architect-approved task",
    schema: objectSchema(
      { taskId: { type: "string", minLength: 1 } },
      ["taskId"]
    ),
    validate: (input) => validateObject(input, (value) =>
      nonEmpty(value.taskId) ? value as unknown as TaskIdInput : null,
    "taskId is required"),
    execute: async (input, context) => {
      const denied = architectOnly(context);
      if (denied) return denied;
      return appendEvent(store, {
        runId: context.runId,
        type: "task.transitioned",
        occurredAt: clock(),
        actor: { role: "architect", id: context.actor.id },
        idempotencyKey: `integration-request:${input.taskId}`,
        payload: { taskId: input.taskId, status: "integrating" },
      }, {
        type: "architect_action",
        action: "integration_requested",
        referenceId: input.taskId,
      });
    },
  });
}

function completeRunTool(
  store: SchedulerStore,
  clock: () => string,
  runPolicy: NativeBuildRunPolicy
): NativeTool<CompleteRunInput> {
  return lifecycleTool({
    name: "complete_run",
    description: runPolicy === "plan_only"
      ? "Record the Architect's semantic decision that the plan is complete and request explicit project handoff"
      : "Record the Architect's semantic decision that the build is complete",
    schema: objectSchema(
      { summary: { type: "string", minLength: 1 } },
      ["summary"]
    ),
    validate: (input) => validateObject(input, (value) =>
      nonEmpty(value.summary) ? value as unknown as CompleteRunInput : null,
    "summary is required"),
    execute: async (input, context) => {
      const denied = architectOnly(context);
      if (denied) return denied;
      return appendEvent(store, {
        runId: context.runId,
        type: "project.handoff_requested",
        occurredAt: clock(),
        actor: { role: "architect", id: context.actor.id },
        idempotencyKey: "project-handoff-requested",
        payload: { summary: input.summary },
      }, { type: "architect_action", action: "run_completed" });
    },
  });
}

interface LifecycleToolOptions<T> {
  name: string;
  description: string;
  schema: Record<string, unknown>;
  validate: (input: unknown) => ValidationResult<T>;
  execute: NativeTool<T>["execute"];
}

function lifecycleTool<T>(options: LifecycleToolOptions<T>): NativeTool<T> {
  return {
    definition: {
      name: options.name,
      description: options.description,
      inputSchema: options.schema,
      readOnly: false,
      effect: "none",
      lifecycle: true,
    },
    validate: options.validate,
    execute: options.execute,
  };
}

function validatePlan(input: unknown): ValidationResult<PlanTasksInput> {
  return validateObject(input, (value) => {
    if (!positiveInteger(value.revision) || !Array.isArray(value.tasks)) return null;
    const tasks: PlanTaskInput[] = [];
    for (const candidate of value.tasks) {
      if (!isRecord(candidate) || !nonEmpty(candidate.id) || !nonEmpty(candidate.objective)) return null;
      const dependencies = stringList(candidate.dependencies);
      const capabilities = stringList(candidate.requiredCapabilities);
      const acceptanceCriteria = parseAcceptanceCriteria(candidate.acceptanceCriteria);
      if (!dependencies || !capabilities || !acceptanceCriteria) return null;
      tasks.push({
        id: candidate.id,
        objective: candidate.objective,
        dependencies,
        requiredCapabilities: capabilities,
        acceptanceCriteria,
      });
    }
    return { revision: value.revision, tasks };
  }, "revision and valid tasks are required");
}

function validateRevision(input: unknown): ValidationResult<ReviseTaskInput> {
  return validateObject(input, (value) => {
    if (!nonEmpty(value.taskId) || !positiveInteger(value.revision)) return null;
    const objective = value.objective === undefined ? undefined : nonEmpty(value.objective) ? value.objective : null;
    const dependencies = value.dependencies === undefined ? undefined : stringList(value.dependencies);
    const capabilities = value.requiredCapabilities === undefined ? undefined : stringList(value.requiredCapabilities);
    const acceptanceCriteria = value.acceptanceCriteria === undefined
      ? undefined
      : parseAcceptanceCriteria(value.acceptanceCriteria);
    if (objective === null || dependencies === null || capabilities === null || acceptanceCriteria === null) return null;
    if (
      objective === undefined &&
      dependencies === undefined &&
      capabilities === undefined &&
      acceptanceCriteria === undefined
    ) return null;
    return {
      taskId: value.taskId,
      revision: value.revision,
      ...(objective !== undefined ? { objective } : {}),
      ...(dependencies !== undefined ? { dependencies } : {}),
      ...(capabilities !== undefined ? { requiredCapabilities: capabilities } : {}),
      ...(acceptanceCriteria !== undefined ? { acceptanceCriteria } : {}),
    };
  }, "taskId, revision, and at least one valid revision field are required");
}

function validateReview(input: unknown): ValidationResult<ReviewTaskInput> {
  return validateObject(input, (value) => {
    if (!nonEmpty(value.taskId) || (value.decision !== "approved" && value.decision !== "rejected") || !nonEmpty(value.summary)) return null;
    const hashes = stringList(value.evidenceArtifactHashes);
    if (!hashes || hashes.some((hash) => !/^[a-f0-9]{64}$/.test(hash))) return null;
    const criterionVerdicts = value.criterionVerdicts === undefined
      ? undefined
      : parseCriterionReviewVerdicts(value.criterionVerdicts);
    if (criterionVerdicts === null) return null;
    const planReconciliation = value.planReconciliation === undefined
      ? undefined
      : parsePlanReconciliation(value.planReconciliation);
    if (value.planReconciliation !== undefined && !planReconciliation) return null;
    return {
      taskId: value.taskId,
      decision: value.decision,
      summary: value.summary,
      evidenceArtifactHashes: hashes,
      ...(criterionVerdicts !== undefined ? { criterionVerdicts } : {}),
      ...(planReconciliation ? { planReconciliation } : {}),
    };
  }, "taskId, decision, summary, and valid evidenceArtifactHashes are required");
}

function validatePlanReconciliation(input: unknown): ValidationResult<PlanReconciliation> {
  return validateObject(
    input,
    parsePlanReconciliation,
    "revision, summary, and valid taskUpdates are required"
  );
}

function parsePlanReconciliation(
  input: Record<string, unknown> | unknown
): PlanReconciliation | null {
  if (!isRecord(input)) return null;
  if (
    !positiveInteger(input.revision) ||
    !nonEmpty(input.summary) ||
    !Array.isArray(input.taskUpdates) ||
    input.taskUpdates.length === 0
  ) return null;
  const taskUpdates: PlanTaskUpdate[] = [];
  for (const candidate of input.taskUpdates) {
    if (!isRecord(candidate) || !nonEmpty(candidate.taskId)) return null;
    if (candidate.action !== "cancel" && candidate.action !== "revise") return null;
    const objective = candidate.objective === undefined
      ? undefined
      : nonEmpty(candidate.objective) ? candidate.objective : null;
    const dependencies = candidate.dependencies === undefined
      ? undefined
      : stringList(candidate.dependencies);
    const capabilities = candidate.requiredCapabilities === undefined
      ? undefined
      : stringList(candidate.requiredCapabilities);
    const acceptanceCriteria = candidate.acceptanceCriteria === undefined
      ? undefined
      : parseAcceptanceCriteria(candidate.acceptanceCriteria);
    if (objective === null || dependencies === null || capabilities === null || acceptanceCriteria === null) return null;
    taskUpdates.push({
      taskId: candidate.taskId,
      action: candidate.action,
      ...(objective !== undefined ? { objective } : {}),
      ...(dependencies !== undefined ? { dependencies } : {}),
      ...(capabilities !== undefined ? { requiredCapabilities: capabilities } : {}),
      ...(acceptanceCriteria !== undefined ? { acceptanceCriteria } : {}),
    });
  }
  return {
    revision: input.revision,
    summary: input.summary,
    taskUpdates,
  };
}

function validateObject<T>(
  input: unknown,
  parse: (value: Record<string, unknown>) => T | null,
  issue: string
): ValidationResult<T> {
  if (!isRecord(input)) return { ok: false, issues: [issue] };
  const value = parse(input);
  return value ? { ok: true, value } : { ok: false, issues: [issue] };
}

function appendEvent(
  store: SchedulerStore,
  event: Parameters<SchedulerStore["append"]>[0],
  lifecycle: NonNullable<ToolExecutionOutput["lifecycle"]>
): ToolExecutionOutput {
  try {
    const appended = store.append(event);
    return {
      content: [{ type: "json", value: appended }],
      isError: false,
      lifecycle,
    };
  } catch (error) {
    return errorOutput(
      "mechanical_transition_rejected",
      error instanceof Error ? error.message : String(error)
    );
  }
}

function architectOnly(context: ToolExecutionContext): ToolExecutionOutput | null {
  return context.actor.role === "architect"
    ? null
    : errorOutput("architect_only", "Only the Architect may use this tool.");
}

function errorOutput(code: string, message: string, issues?: string[]): ToolExecutionOutput {
  return {
    content: [{ type: "text", text: message }],
    isError: true,
    error: { code, message, ...(issues ? { issues } : {}) },
  };
}

function taskSchema(): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      id: { type: "string", minLength: 1 },
      objective: { type: "string", minLength: 1 },
      dependencies: { type: "array", items: { type: "string" } },
      requiredCapabilities: { type: "array", items: { type: "string" } },
      acceptanceCriteria: { type: "array", minItems: 1, items: criterionSchema() },
    },
    required: ["id", "objective", "dependencies", "requiredCapabilities", "acceptanceCriteria"],
    additionalProperties: false,
  };
}

function planReconciliationSchema(): Record<string, unknown> {
  return objectSchema({
    revision: { type: "integer", minimum: 1 },
    summary: { type: "string", minLength: 1 },
    taskUpdates: {
      type: "array",
      minItems: 1,
      items: objectSchema({
        taskId: { type: "string", minLength: 1 },
        action: { type: "string", enum: ["cancel", "revise"] },
        objective: { type: "string", minLength: 1 },
        dependencies: { type: "array", items: { type: "string" } },
        requiredCapabilities: { type: "array", items: { type: "string" } },
        acceptanceCriteria: { type: "array", minItems: 1, items: criterionSchema() },
      }, ["taskId", "action"]),
    },
  }, ["revision", "summary", "taskUpdates"]);
}

function criterionSchema(): Record<string, unknown> {
  return objectSchema({
    id: { type: "string", minLength: 1 },
    text: { type: "string", minLength: 1 },
  }, ["id", "text"]);
}

function criterionReviewVerdictSchema(): Record<string, unknown> {
  return objectSchema({
    criterionId: { type: "string", minLength: 1 },
    verdict: { type: "string", enum: ["satisfied", "unsatisfied"] },
    rationale: { type: "string", minLength: 1 },
    evidenceIds: {
      type: "array",
      minItems: 1,
      items: { type: "string", minLength: 1 },
    },
    artifactHashes: {
      type: "array",
      minItems: 1,
      items: { type: "string", pattern: "^[a-f0-9]{64}$" },
    },
  }, ["criterionId", "verdict", "rationale", "evidenceIds"]);
}

function parseCriterionReviewVerdicts(value: unknown): CriterionReviewVerdict[] | null {
  if (!Array.isArray(value)) return null;
  const verdicts: CriterionReviewVerdict[] = [];
  for (const candidate of value) {
    if (!isRecord(candidate) || !nonEmpty(candidate.criterionId)) return null;
    if (candidate.verdict !== "satisfied" && candidate.verdict !== "unsatisfied") return null;
    if (!nonEmpty(candidate.rationale)) return null;
    const evidenceIds = stringList(candidate.evidenceIds);
    if (!evidenceIds || evidenceIds.length === 0) return null;
    const artifactHashes = candidate.artifactHashes === undefined
      ? undefined
      : stringList(candidate.artifactHashes);
    if (
      candidate.artifactHashes !== undefined &&
      (!artifactHashes || artifactHashes.length === 0 || artifactHashes.some((hash) => !/^[a-f0-9]{64}$/.test(hash)))
    ) return null;
    verdicts.push({
      criterionId: candidate.criterionId,
      verdict: candidate.verdict,
      rationale: candidate.rationale,
      evidenceIds,
      ...(artifactHashes ? { artifactHashes } : {}),
    });
  }
  return verdicts;
}

function parseAcceptanceCriteria(value: unknown): AcceptanceCriterion[] | null {
  if (!Array.isArray(value)) return null;
  const criteria: AcceptanceCriterion[] = [];
  for (const candidate of value) {
    if (!isRecord(candidate) || !nonEmpty(candidate.id) || !nonEmpty(candidate.text)) {
      return null;
    }
    criteria.push({ id: candidate.id, text: candidate.text });
  }
  const validation = validateAcceptanceCriteria(criteria);
  return validation.valid ? criteria : null;
}

function objectSchema(
  properties: Record<string, unknown>,
  required: string[]
): Record<string, unknown> {
  return {
    type: "object",
    properties,
    required,
    additionalProperties: false,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
function positiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}
function stringList(value: unknown): string[] | null {
  return Array.isArray(value) && value.every(nonEmpty) ? [...value] : null;
}

function shortHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}
