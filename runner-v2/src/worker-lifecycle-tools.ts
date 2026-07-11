import type {
  NativeTool,
  ToolExecutionContext,
  ToolExecutionOutput,
  ValidationResult,
} from "./agent-contracts.js";
import type { SchedulerStore } from "./scheduler-store.js";
import type { ChangeSet } from "./change-set.js";

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

export function createWorkerLifecycleTools(
  options: WorkerLifecycleToolsOptions
): NativeTool<unknown>[] {
  const clock = options.clock ?? (() => new Date().toISOString());
  return [
    askArchitectTool(options.store, options.taskId, clock),
    challengeGuidanceTool(options.store, options.taskId, clock),
  ];
}

export function createSubmitTaskTool(
  submit: (summary: string) => Promise<ChangeSet>
): NativeTool<{ summary: string }> {
  return {
    definition: {
      name: "submit_task",
      description: "Commit the task workspace and submit a typed change set",
      inputSchema: {
        type: "object",
        properties: { summary: { type: "string" } },
        required: ["summary"],
        additionalProperties: false,
      },
      readOnly: false,
      effect: "workspace",
      lifecycle: true,
    },
    validate: (input) =>
      isRecord(input) && nonEmpty(input.summary)
        ? { ok: true, value: { summary: input.summary } }
        : { ok: false, issues: ["summary must be a non-empty string"] },
    assessAccess: () => ({
      capability: "task.submit",
      paths: [{ path: ".", access: "write" }],
    }),
    execute: async (input) => {
      const changeSet = await submit(input.summary.trim());
      return {
        content: [{ type: "json", value: changeSet }],
        isError: false,
        lifecycle: { type: "submit_task", changeSetId: changeSet.id },
      };
    },
  };
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
      const result = append(store, {
        runId: context.runId,
        type: "guidance.requested",
        occurredAt: clock(),
        actor: { role: "worker", id: context.actor.id },
        idempotencyKey: `guidance:${input.requestId}`,
        payload: { ...input, taskId },
      });
      if (result.isError || !input.blocking) return result;
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
