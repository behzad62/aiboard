import type {
  NativeTool,
  ToolExecutionContext,
  ToolExecutionOutput,
  ValidationResult,
} from "./agent-contracts.js";
import type { ProjectMemoryStore } from "./project-memory.js";

export interface MemoryToolsOptions {
  store: ProjectMemoryStore;
  projectId: string;
  runId: string;
  taskId?: string;
  clock?: () => string;
}

export function createMemoryTools(options: MemoryToolsOptions): NativeTool<unknown>[] {
  const clock = options.clock ?? (() => new Date().toISOString());
  return [
    recallTool(options),
    proposeTool(options, clock),
    promoteTool(options, clock),
    archiveTool(options, clock),
    listProposalsTool(options),
  ];
}

function recallTool(options: MemoryToolsOptions): NativeTool<{
  query: string;
  concepts: string[];
  limit: number;
}> {
  return {
    definition: {
      name: "recall_project_memory",
      description: "Recall promoted memory from this project only",
      inputSchema: objectSchema({
        query: { type: "string" },
        concepts: { type: "array", items: { type: "string", minLength: 1 } },
        limit: { type: "integer", minimum: 1, maximum: 100 },
      }, ["query"]),
      readOnly: true,
      effect: "none",
    },
    validate: (input) => parseSearch(input),
    execute: async (input) => ({
      content: [{ type: "json", value: options.store.search({ projectId: options.projectId, ...input }) }],
      isError: false,
    }),
  };
}

function proposeTool(
  options: MemoryToolsOptions,
  clock: () => string
): NativeTool<MemoryProposalArguments> {
  return {
    definition: {
      name: "propose_project_memory",
      description: "Propose a project learning for later Architect promotion",
      inputSchema: objectSchema({
        content: { type: "string", minLength: 1 },
        concepts: { type: "array", items: { type: "string", minLength: 1 } },
        workspaceRevision: { type: "string", minLength: 1, maxLength: 512 },
        confidence: { type: "number", minimum: 0, maximum: 1 },
        evidenceIds: {
          type: "array",
          maxItems: 100,
          items: { type: "string", minLength: 1, maxLength: 512 },
        },
        supersedes: {
          type: "array",
          maxItems: 100,
          items: { type: "string", minLength: 1, maxLength: 512 },
        },
      }, ["content", "concepts"]),
      readOnly: false,
      effect: "none",
    },
    validate: parseProposal,
    execute: async (input, context) => {
      try {
        const entry = options.store.propose({
          projectId: options.projectId,
          runId: options.runId,
          ...(options.taskId ? { taskId: options.taskId } : {}),
          actor: context.actor,
          content: input.content,
          concepts: input.concepts,
          ...(input.workspaceRevision
            ? { workspaceRevision: input.workspaceRevision }
            : {}),
          ...(input.confidence !== undefined ? { confidence: input.confidence } : {}),
          ...(input.evidenceIds ? { evidenceIds: input.evidenceIds } : {}),
          ...(input.supersedes ? { supersedes: input.supersedes } : {}),
          occurredAt: clock(),
          idempotencyKey: `proposal:${context.sessionId}:${context.callId}`,
        });
        return json({ memoryId: entry.id, status: entry.status });
      } catch (error) {
        return failure(error);
      }
    },
  };
}

function promoteTool(
  options: MemoryToolsOptions,
  clock: () => string
): NativeTool<{ memoryId: string }> {
  return architectMutation("promote_project_memory", "Promote a worker memory proposal", parseMemoryId, async (input, context) => {
    const entry = options.store.promote({
      projectId: options.projectId,
      memoryId: input.memoryId,
      actor: context.actor,
      occurredAt: clock(),
      idempotencyKey: `promote:${input.memoryId}`,
    });
    return json({ memoryId: entry.id, status: entry.status });
  });
}

function archiveTool(
  options: MemoryToolsOptions,
  clock: () => string
): NativeTool<{ memoryId: string; reason: string }> {
  return architectMutation("archive_project_memory", "Archive superseded project memory", parseArchive, async (input, context) => {
    const entry = options.store.archive({
      projectId: options.projectId,
      memoryId: input.memoryId,
      reason: input.reason,
      actor: context.actor,
      occurredAt: clock(),
      idempotencyKey: `archive:${input.memoryId}`,
    });
    return json({ memoryId: entry.id, status: entry.status });
  });
}

function listProposalsTool(options: MemoryToolsOptions): NativeTool<{ limit: number }> {
  return {
    definition: {
      name: "list_memory_proposals",
      description: "List unpromoted memory proposals for this project",
      inputSchema: objectSchema(
        { limit: { type: "integer", minimum: 1, maximum: 100 } },
        []
      ),
      readOnly: true,
      effect: "none",
    },
    validate: (input) => {
      if (!record(input)) return invalid("arguments must be an object");
      const limit = input.limit === undefined ? 100 : input.limit;
      return positiveLimit(limit)
        ? { ok: true, value: { limit } }
        : invalid("limit must be from 1 to 100");
    },
    execute: async (input, context) =>
      context.actor.role !== "architect"
        ? denied()
        : json(options.store.proposals(options.projectId, input.limit)),
  };
}

function architectMutation<T>(
  name: string,
  description: string,
  validate: (input: unknown) => ValidationResult<T>,
  mutate: (input: T, context: ToolExecutionContext) => Promise<ToolExecutionOutput>
): NativeTool<T> {
  return {
    definition: {
      name,
      description,
      inputSchema: memoryMutationSchema(name),
      readOnly: false,
      effect: "none",
    },
    validate,
    execute: async (input, context) => {
      if (context.actor.role !== "architect") return denied();
      try {
        return await mutate(input, context);
      } catch (error) {
        return failure(error);
      }
    },
  };
}

function memoryMutationSchema(name: string): Record<string, unknown> {
  if (name === "promote_project_memory") {
    return objectSchema(
      { memoryId: { type: "string", minLength: 1 } },
      ["memoryId"]
    );
  }
  if (name === "archive_project_memory") {
    return objectSchema(
      {
        memoryId: { type: "string", minLength: 1 },
        reason: { type: "string", minLength: 1 },
      },
      ["memoryId", "reason"]
    );
  }
  throw new Error(`Unknown memory mutation tool ${name}.`);
}

function objectSchema(
  properties: Record<string, unknown>,
  required: string[]
): Record<string, unknown> {
  return { type: "object", properties, required, additionalProperties: false };
}

function parseSearch(input: unknown): ValidationResult<{ query: string; concepts: string[]; limit: number }> {
  if (!record(input) || typeof input.query !== "string") return invalid("query is required");
  const concepts = input.concepts === undefined ? [] : strings(input.concepts);
  const limit = input.limit === undefined ? 10 : input.limit;
  return concepts && positiveLimit(limit)
    ? { ok: true, value: { query: input.query, concepts, limit } }
    : invalid("concepts must be strings and limit must be from 1 to 100");
}
interface MemoryProposalArguments {
  content: string;
  concepts: string[];
  workspaceRevision?: string;
  confidence?: number;
  evidenceIds?: string[];
  supersedes?: string[];
}

function parseProposal(input: unknown): ValidationResult<MemoryProposalArguments> {
  if (!record(input) || typeof input.content !== "string" || !input.content.trim()) return invalid("content is required");
  const concepts = strings(input.concepts);
  const workspaceRevision = input.workspaceRevision;
  const confidence = input.confidence;
  const evidenceIds = input.evidenceIds === undefined ? undefined : strings(input.evidenceIds);
  const supersedes = input.supersedes === undefined ? undefined : strings(input.supersedes);
  if (!concepts) return invalid("concepts must be strings");
  if (
    workspaceRevision !== undefined &&
    (typeof workspaceRevision !== "string" || !workspaceRevision.trim() || workspaceRevision.length > 512)
  ) return invalid("workspaceRevision must be a non-empty string of at most 512 characters");
  if (
    confidence !== undefined &&
    (typeof confidence !== "number" || !Number.isFinite(confidence) || confidence < 0 || confidence > 1)
  ) return invalid("confidence must be a number from 0 to 1");
  if (evidenceIds === null || supersedes === null) {
    return invalid("evidenceIds and supersedes must contain non-empty strings");
  }
  if ((evidenceIds?.length ?? 0) > 100 || (supersedes?.length ?? 0) > 100) {
    return invalid("evidenceIds and supersedes must contain at most 100 entries");
  }
  return {
    ok: true,
    value: {
      content: input.content,
      concepts,
      ...(workspaceRevision !== undefined ? { workspaceRevision } : {}),
      ...(confidence !== undefined ? { confidence } : {}),
      ...(evidenceIds ? { evidenceIds } : {}),
      ...(supersedes ? { supersedes } : {}),
    },
  };
}
function parseMemoryId(input: unknown): ValidationResult<{ memoryId: string }> {
  return record(input) && typeof input.memoryId === "string" && input.memoryId.trim()
    ? { ok: true, value: { memoryId: input.memoryId } }
    : invalid("memoryId is required");
}
function parseArchive(input: unknown): ValidationResult<{ memoryId: string; reason: string }> {
  return record(input) && typeof input.memoryId === "string" && input.memoryId.trim() && typeof input.reason === "string" && input.reason.trim()
    ? { ok: true, value: { memoryId: input.memoryId, reason: input.reason } }
    : invalid("memoryId and reason are required");
}
function json(value: unknown): ToolExecutionOutput {
  return { content: [{ type: "json", value }], isError: false };
}
function denied(): ToolExecutionOutput {
  return { content: [{ type: "text", text: "Only the Architect may use this tool." }], isError: true, error: { code: "architect_only", message: "Only the Architect may use this tool." } };
}
function failure(error: unknown): ToolExecutionOutput {
  const message = error instanceof Error ? error.message : String(error);
  return { content: [{ type: "text", text: message }], isError: true, error: { code: "memory_operation_rejected", message } };
}
function invalid<T>(issue: string): ValidationResult<T> { return { ok: false, issues: [issue] }; }
function record(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function strings(value: unknown): string[] | null { return Array.isArray(value) && value.every((item) => typeof item === "string" && item.trim()) ? value as string[] : null; }
function positiveLimit(value: unknown): value is number { return Number.isSafeInteger(value) && (value as number) >= 1 && (value as number) <= 100; }
