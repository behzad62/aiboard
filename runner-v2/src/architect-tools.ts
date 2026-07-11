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
import type { BuildTask } from "./task-contracts.js";
import { validateTaskGraph } from "./task-graph.js";

export interface ArchitectToolsOptions {
  store: SchedulerStore;
  clock?: () => string;
}

interface PlanTaskInput {
  id: string;
  objective: string;
  dependencies: string[];
  requiredCapabilities: string[];
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
}

interface TaskIdInput { taskId: string }
interface CompleteRunInput { summary: string }

export function createArchitectTools(
  options: ArchitectToolsOptions
): NativeTool<unknown>[] {
  const clock = options.clock ?? (() => new Date().toISOString());
  return [
    planTasksTool(options.store, clock),
    reviseTaskTool(options.store, clock),
    answerGuidanceTool(options.store, clock),
    reviewTaskTool(options.store, clock),
    requestIntegrationTool(options.store, clock),
    completeRunTool(options.store, clock),
  ];
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
        status: "planned",
        attempt: 0,
      }));
      const validation = validateTaskGraph(tasks);
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
    description: "Revise a planned task without interpreting its semantic intent",
    schema: {
      type: "object",
      properties: {
        taskId: { type: "string", minLength: 1 },
        revision: { type: "integer", minimum: 1 },
        objective: { type: "string", minLength: 1 },
        dependencies: { type: "array", items: { type: "string" } },
        requiredCapabilities: { type: "array", items: { type: "string" } },
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
  clock: () => string
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
    }, ["taskId", "decision", "summary", "evidenceArtifactHashes"]),
    validate: validateReview,
    execute: async (input, context) => {
      const denied = architectOnly(context);
      if (denied) return denied;
      const task = rebuildSchedulerProjection(
        store.readRun(context.runId)
      ).tasks[input.taskId];
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
  clock: () => string
): NativeTool<CompleteRunInput> {
  return lifecycleTool({
    name: "complete_run",
    description: "Record the Architect's semantic decision that the build is complete",
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
        type: "run.completed",
        occurredAt: clock(),
        actor: { role: "architect", id: context.actor.id },
        idempotencyKey: "run-completed",
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
      if (!dependencies || !capabilities) return null;
      tasks.push({
        id: candidate.id,
        objective: candidate.objective,
        dependencies,
        requiredCapabilities: capabilities,
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
    if (objective === null || dependencies === null || capabilities === null) return null;
    if (objective === undefined && dependencies === undefined && capabilities === undefined) return null;
    return {
      taskId: value.taskId,
      revision: value.revision,
      ...(objective !== undefined ? { objective } : {}),
      ...(dependencies !== undefined ? { dependencies } : {}),
      ...(capabilities !== undefined ? { requiredCapabilities: capabilities } : {}),
    };
  }, "taskId, revision, and at least one valid revision field are required");
}

function validateReview(input: unknown): ValidationResult<ReviewTaskInput> {
  return validateObject(input, (value) => {
    if (!nonEmpty(value.taskId) || (value.decision !== "approved" && value.decision !== "rejected") || !nonEmpty(value.summary)) return null;
    const hashes = stringList(value.evidenceArtifactHashes);
    if (!hashes || hashes.some((hash) => !/^[a-f0-9]{64}$/.test(hash))) return null;
    return {
      taskId: value.taskId,
      decision: value.decision,
      summary: value.summary,
      evidenceArtifactHashes: hashes,
    };
  }, "taskId, decision, summary, and valid evidenceArtifactHashes are required");
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
    },
    required: ["id", "objective", "dependencies", "requiredCapabilities"],
    additionalProperties: false,
  };
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
