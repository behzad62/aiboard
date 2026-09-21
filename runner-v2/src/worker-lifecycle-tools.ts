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
import type { ChangeSet } from "./change-set.js";
import type { CriterionEvidenceLink } from "./acceptance-contracts.js";
import { REPLAN_REASONS, type ReplanReason } from "./task-contracts.js";

export interface WorkerLifecycleToolsOptions {
  store: SchedulerStore;
  taskId: string;
  clock?: () => string;
}

interface AskArchitectInput {
  requestId: string;
  question: string;
  blocking: boolean;
  evidenceSequence: number;
}

interface ChallengeGuidanceInput {
  requestId: string;
  expectedVersion: number;
  evidenceSequence: number;
  reason: string;
}

interface RequestReplanInput {
  requestId: string;
  reason: ReplanReason;
  summary: string;
  proposedChange: string;
  evidenceSequence: number;
}

export function createWorkerLifecycleTools(
  options: WorkerLifecycleToolsOptions
): NativeTool<unknown>[] {
  const clock = options.clock ?? (() => new Date().toISOString());
  return [
    askArchitectTool(options.store, options.taskId, clock),
    challengeGuidanceTool(options.store, options.taskId, clock),
    requestReplanTool(options.store, options.taskId, clock),
  ];
}

export function createSubmitTaskTool(
  submit: (input: SubmitTaskInput) => Promise<ChangeSet>,
  options: { requireCriterionEvidenceLinks?: boolean } = {}
): NativeTool<SubmitTaskInput> {
  const requireCriterionEvidenceLinks = options.requireCriterionEvidenceLinks === true;
  return {
    definition: {
      name: "submit_task",
      description:
        "Declare the task ready for Architect review, commit the workspace, and submit a typed change set. Do not use for a blocked state or while fresh evidence shows a known acceptance failure; use ask_architect instead.",
      inputSchema: {
        type: "object",
        properties: {
          summary: { type: "string" },
          readiness: {
            type: "string",
            enum: ["ready_for_architect_review"],
          },
          unresolvedConcerns: {
            type: "array",
            maxItems: 100,
            items: { type: "string", minLength: 1, maxLength: 2_000 },
          },
          criterionEvidenceLinks: {
            type: "array",
            minItems: requireCriterionEvidenceLinks ? 1 : 0,
            items: criterionEvidenceLinkSchema(),
          },
        },
        required: requireCriterionEvidenceLinks
          ? ["summary", "readiness", "criterionEvidenceLinks"]
          : ["summary", "readiness"],
        additionalProperties: false,
      },
      readOnly: false,
      effect: "workspace",
      lifecycle: true,
    },
    validate: (input) =>
      validateSubmit(input, requireCriterionEvidenceLinks),
    assessAccess: () => ({
      capability: "task.submit",
      paths: [{ path: ".", access: "write" }],
    }),
    execute: async (input) => {
      const changeSet = await submit({
        summary: input.summary.trim(),
        readiness: input.readiness,
        unresolvedConcerns: input.unresolvedConcerns.map((item) => item.trim()),
        criterionEvidenceLinks: input.criterionEvidenceLinks.map((link) => ({
          ...link,
          artifactHashes: [...link.artifactHashes],
        })),
      });
      return {
        content: [{ type: "json", value: changeSet }],
        isError: false,
        lifecycle: { type: "submit_task", changeSetId: changeSet.id },
      };
    },
  };
}

export interface SubmitTaskInput {
  summary: string;
  readiness: "ready_for_architect_review";
  unresolvedConcerns: string[];
  criterionEvidenceLinks: CriterionEvidenceLink[];
}

function validateSubmit(
  input: unknown,
  requireCriterionEvidenceLinks = false
): ValidationResult<SubmitTaskInput> {
  if (!isRecord(input) || !nonEmpty(input.summary)) {
    return invalid("summary must be a non-empty string");
  }
  if (input.readiness !== "ready_for_architect_review") {
    return invalid(
      "readiness must explicitly declare ready_for_architect_review; use ask_architect for blocked work"
    );
  }
  const concerns = input.unresolvedConcerns ?? [];
  if (
    !Array.isArray(concerns) ||
    concerns.length > 100 ||
    concerns.some(
      (item) => typeof item !== "string" || !item.trim() || item.length > 2_000
    )
  ) return invalid("unresolvedConcerns must contain at most 100 non-empty strings");
  const criterionEvidenceLinks = parseCriterionEvidenceLinks(
    input.criterionEvidenceLinks,
    requireCriterionEvidenceLinks
  );
  if (!criterionEvidenceLinks) {
    return invalid(
      "criterionEvidenceLinks must contain one valid mapping per acceptance criterion"
    );
  }
  return {
    ok: true,
    value: {
      summary: input.summary,
      readiness: input.readiness,
      unresolvedConcerns: (concerns as string[]).map((item) => item.trim()),
      criterionEvidenceLinks,
    },
  };
}

function criterionEvidenceLinkSchema(): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      criterionId: { type: "string", minLength: 1 },
      evidenceId: { type: "string", minLength: 1 },
      artifactHashes: {
        type: "array",
        minItems: 1,
        items: { type: "string", pattern: "^[a-f0-9]{64}$" },
      },
      taskId: { type: "string", minLength: 1 },
      attempt: { type: "integer", minimum: 1 },
    },
    required: ["criterionId", "evidenceId", "artifactHashes"],
    additionalProperties: false,
  };
}

function parseCriterionEvidenceLinks(
  value: unknown,
  required: boolean
): CriterionEvidenceLink[] | null {
  if (value === undefined && !required) return [];
  if (!Array.isArray(value)) return null;
  const links: CriterionEvidenceLink[] = [];
  for (const candidate of value) {
    if (!isRecord(candidate)) return null;
    if (!nonEmpty(candidate.criterionId) || !nonEmpty(candidate.evidenceId)) return null;
    if (
      !Array.isArray(candidate.artifactHashes) ||
      candidate.artifactHashes.length === 0 ||
      candidate.artifactHashes.some(
        (hash) => typeof hash !== "string" || !/^[a-f0-9]{64}$/.test(hash)
      )
    ) return null;
    if (candidate.taskId !== undefined && !nonEmpty(candidate.taskId)) return null;
    const attempt = candidate.attempt;
    if (
      attempt !== undefined &&
      (typeof attempt !== "number" || !Number.isSafeInteger(attempt) || attempt < 1)
    ) return null;
    links.push({
      criterionId: candidate.criterionId,
      evidenceId: candidate.evidenceId,
      artifactHashes: [...candidate.artifactHashes] as string[],
      ...(candidate.taskId !== undefined ? { taskId: candidate.taskId } : {}),
      ...(typeof attempt === "number" ? { attempt } : {}),
    });
  }
  return required && links.length === 0 ? null : links;
}

function askArchitectTool(
  store: SchedulerStore,
  taskId: string,
  clock: () => string
): NativeTool<AskArchitectInput> {
  return {
    definition: {
      name: "ask_architect",
      description: "Ask the Architect for task guidance, citing the latest durable evidence sequence",
      inputSchema: {
        type: "object",
        properties: {
          requestId: { type: "string" },
          question: { type: "string" },
          blocking: { type: "boolean" },
          evidenceSequence: { type: "integer", minimum: 0 },
        },
        required: ["requestId", "question", "blocking", "evidenceSequence"],
        additionalProperties: false,
      },
      readOnly: false,
      effect: "none",
      lifecycle: true,
    },
    validate: validateAsk,
    execute: async (input, context) => {
      const denied = workerOnly(context);
      if (denied) return denied;
      const requestId = allocateGuidanceRequestId(
        store,
        context.runId,
        input.requestId
      );
      const result = append(store, {
        runId: context.runId,
        type: "guidance.requested",
        occurredAt: clock(),
        actor: { role: "worker", id: context.actor.id },
        idempotencyKey: `guidance:${requestId}`,
        payload: { ...input, requestId, taskId },
      });
      if (result.isError || !input.blocking) return result;
      return {
        ...result,
        lifecycle: {
          type: "ask_architect",
          requestId,
          blocking: true,
        },
      };
    },
  };
}

function requestReplanTool(
  store: SchedulerStore,
  taskId: string,
  clock: () => string
): NativeTool<RequestReplanInput> {
  return {
    definition: {
      name: "request_replan",
      description:
        "End this attempt because the task cannot be completed within its objective: the scope is exceeded, a requirement conflicts with the repository, an architectural contradiction was found, or a dependency is missing. The Architect reconciles the plan or refuses with evidence; the task stays owned by this workspace.",
      inputSchema: {
        type: "object",
        properties: {
          requestId: { type: "string", minLength: 1 },
          reason: { type: "string", enum: [...REPLAN_REASONS] },
          summary: { type: "string", minLength: 1, maxLength: 4_000 },
          proposedChange: { type: "string", minLength: 1, maxLength: 4_000 },
          evidenceSequence: { type: "integer", minimum: 0 },
        },
        required: ["requestId", "reason", "summary", "proposedChange", "evidenceSequence"],
        additionalProperties: false,
      },
      readOnly: false,
      effect: "none",
      lifecycle: true,
    },
    validate: validateReplan,
    execute: async (input, context) => {
      const denied = workerOnly(context);
      if (denied) return denied;
      const requestId = allocateGuidanceRequestId(store, context.runId, input.requestId);
      const result = append(store, {
        runId: context.runId,
        type: "guidance.requested",
        occurredAt: clock(),
        actor: { role: "worker", id: context.actor.id },
        idempotencyKey: `guidance:${requestId}`,
        payload: {
          requestId,
          taskId,
          question: `Replan requested (${input.reason}): ${input.summary}\nProposed change: ${input.proposedChange}`,
          blocking: true,
          evidenceSequence: input.evidenceSequence,
          kind: "replan",
          replan: {
            reason: input.reason,
            summary: input.summary,
            proposedChange: input.proposedChange,
          },
        },
      });
      if (result.isError) return result;
      return { ...result, lifecycle: { type: "request_replan", requestId } };
    },
  };
}

function validateReplan(input: unknown): ValidationResult<RequestReplanInput> {
  if (!isRecord(input)) return invalid("Replan arguments must be an object.");
  if (
    !nonEmpty(input.requestId) ||
    !REPLAN_REASONS.includes(input.reason as ReplanReason) ||
    !nonEmpty(input.summary) ||
    !nonEmpty(input.proposedChange) ||
    !nonNegativeInteger(input.evidenceSequence)
  ) return invalid("requestId, reason, summary, proposedChange, and evidenceSequence are required.");
  return { ok: true, value: input as unknown as RequestReplanInput };
}

function allocateGuidanceRequestId(
  store: SchedulerStore,
  runId: string,
  proposedRequestId: string
): string {
  const events = store.readRun(runId);
  if (events.length === 0) return proposedRequestId;
  const guidance = rebuildSchedulerProjection(events).guidance;
  if (!guidance[proposedRequestId]) return proposedRequestId;
  let ordinal = 2;
  let requestId = `${proposedRequestId}:request:${ordinal}`;
  while (guidance[requestId]) {
    ordinal += 1;
    requestId = `${proposedRequestId}:request:${ordinal}`;
  }
  return requestId;
}

function challengeGuidanceTool(
  store: SchedulerStore,
  taskId: string,
  clock: () => string
): NativeTool<ChallengeGuidanceInput> {
  return {
    definition: {
      name: "challenge_guidance",
      description: "Challenge one Architect guidance version using newer durable evidence",
      inputSchema: {
        type: "object",
        properties: {
          requestId: { type: "string" },
          expectedVersion: { type: "integer", minimum: 1 },
          evidenceSequence: { type: "integer", minimum: 0 },
          reason: { type: "string" },
        },
        required: ["requestId", "expectedVersion", "evidenceSequence", "reason"],
        additionalProperties: false,
      },
      readOnly: false,
      effect: "none",
      lifecycle: true,
    },
    validate: validateChallenge,
    execute: async (input, context) => {
      const denied = workerOnly(context);
      if (denied) return denied;
      const current = store.readRun(context.runId);
      if (current.length === 0) return failure("unknown_run", `Unknown run ${context.runId}.`);
      const result = append(store, {
        runId: context.runId,
        type: "guidance.challenged",
        occurredAt: clock(),
        actor: { role: "worker", id: context.actor.id },
        idempotencyKey: `guidance-challenge:${input.requestId}:${input.expectedVersion}:${input.evidenceSequence}`,
        payload: { ...input, taskId },
      });
      if (result.isError) return result;
      return {
        ...result,
        lifecycle: {
          type: "ask_architect",
          requestId: input.requestId,
          blocking: true,
        },
      };
    },
  };
}

function validateAsk(input: unknown): ValidationResult<AskArchitectInput> {
  if (!isRecord(input)) return invalid("Guidance arguments must be an object.");
  if (
    !nonEmpty(input.requestId) ||
    !nonEmpty(input.question) ||
    typeof input.blocking !== "boolean" ||
    !nonNegativeInteger(input.evidenceSequence)
  ) return invalid("requestId, question, blocking, and evidenceSequence are required.");
  return {
    ok: true,
    value: {
      requestId: input.requestId,
      question: input.question,
      blocking: input.blocking,
      evidenceSequence: input.evidenceSequence,
    },
  };
}

function validateChallenge(input: unknown): ValidationResult<ChallengeGuidanceInput> {
  if (!isRecord(input)) return invalid("Challenge arguments must be an object.");
  if (
    !nonEmpty(input.requestId) ||
    !positiveInteger(input.expectedVersion) ||
    !nonNegativeInteger(input.evidenceSequence) ||
    !nonEmpty(input.reason)
  ) return invalid("requestId, expectedVersion, evidenceSequence, and reason are required.");
  return { ok: true, value: input as unknown as ChallengeGuidanceInput };
}

function append(
  store: SchedulerStore,
  event: Parameters<SchedulerStore["append"]>[0]
): ToolExecutionOutput {
  try {
    const appended = store.append(event);
    return { content: [{ type: "json", value: appended }], isError: false };
  } catch (error) {
    return failure(
      "mechanical_transition_rejected",
      error instanceof Error ? error.message : String(error)
    );
  }
}

function workerOnly(context: ToolExecutionContext): ToolExecutionOutput | null {
  return context.actor.role === "worker"
    ? null
    : failure("worker_only", "Only a worker may use this tool.");
}

function failure(code: string, message: string): ToolExecutionOutput {
  return {
    content: [{ type: "text", text: message }],
    isError: true,
    error: { code, message },
  };
}

function invalid<T>(message: string): ValidationResult<T> {
  return { ok: false, issues: [message] };
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
function nonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}
