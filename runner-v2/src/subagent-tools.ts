import type {
  AgentMessage,
  AgentModel,
  NativeTool,
  ToolExecutionOutput,
  ValidationResult,
} from "./agent-contracts.js";
import { runAgentLoop } from "./agent-loop.js";
import type { ArtifactStore } from "./artifact-store.js";
import { createBrowserTools, type BrowserBackend } from "./browser-tools.js";
import type { PermissionProfile } from "./contracts.js";
import { createEvidenceTools } from "./evidence-tools.js";
import type { EvidenceStore } from "./evidence-store.js";
import { createFilesystemTools } from "./filesystem-tools.js";
import { createGitTools } from "./git-tools.js";
import { createMemoryTools } from "./memory-tools.js";
import { createMcpTools, type McpManager } from "./mcp-tools.js";
import type { SqlitePermissionStore } from "./permission-store.js";
import type { ProjectMemoryStore } from "./project-memory.js";
import { createProcessTools } from "./process-tools.js";
import { createResearchTools } from "./research-tools.js";
import type { SkillCatalog } from "./skill-catalog.js";
import { createSkillTools } from "./skill-tools.js";
import type { SqliteAgentSessionStore } from "./sqlite-agent-session-store.js";
import { ToolBroker } from "./tool-broker.js";
import type { ToolInvocationLedger } from "./tool-ledger.js";

interface SpawnSubagentInput {
  assignment: string;
  maxTurns: number;
}

interface ReturnSubagentInput {
  summary: string;
  artifactHashes: string[];
}

export interface SubagentToolsOptions {
  model: AgentModel;
  runId: string;
  parentSessionId: string;
  taskId: string;
  parentActorId: string;
  permissionProfile: PermissionProfile;
  workspacePath: string;
  artifacts: ArtifactStore;
  ledger: ToolInvocationLedger;
  sessions: SqliteAgentSessionStore;
  evidenceStore?: EvidenceStore;
  skillCatalog?: SkillCatalog;
  memoryStore?: ProjectMemoryStore;
  projectId?: string;
  clock?: () => string;
  browserBackend?: BrowserBackend;
  mcpManager?: McpManager;
  permissions?: SqlitePermissionStore;
}

export function createSubagentTools(
  options: SubagentToolsOptions
): NativeTool<SpawnSubagentInput>[] {
  const clock = options.clock ?? (() => new Date().toISOString());
  return [{
    definition: {
      name: "spawn_subagent",
      description:
        "Delegate one bounded investigation or implementation assignment inside this task workspace; the child returns structured findings and cannot submit or commit the parent task",
      inputSchema: {
        type: "object",
        properties: {
          assignment: { type: "string", minLength: 1 },
          maxTurns: { type: "integer", minimum: 1, maximum: 20 },
        },
        required: ["assignment"],
        additionalProperties: false,
      },
      readOnly: false,
      effect: "workspace",
    },
    validate: validateSpawn,
    assessAccess: () => ({
      capability: "coordination.subagent",
      paths: [{ path: ".", access: "write" }],
    }),
    execute: async (input, context) => {
      if (context.actor.role !== "worker") {
        return failure("worker_only", "Only a worker may spawn a task subagent.");
      }
      const callId = context.callId ?? "subagent";
      const sessionId = `${options.parentSessionId}:subagent:${callId}`;
      let messages: AgentMessage[] = [
        {
          id: "subagent-system",
          role: "system",
          content: [
            "You are a bounded AIBoard worker subagent.",
            "Work only on the delegated assignment inside the shared task workspace.",
            "You may inspect, edit, run tools, gather evidence, use project skills, and propose project memory.",
            "You cannot submit or commit the parent task, approve work, integrate changes, or declare the project complete.",
            "Finish with return_to_parent containing a concise factual summary and relevant artifact hashes.",
          ].join("\n"),
        },
        { id: "subagent-assignment", role: "user", content: input.assignment },
      ];
      if (options.sessions.events(sessionId).length === 0) {
        await options.sessions.create({
          sessionId,
          runId: options.runId,
          actor: { role: "subagent", id: `${options.parentActorId}:${callId}` },
          occurredAt: clock(),
        });
      } else {
        const recovered = await options.sessions.load(sessionId);
        if (recovered.checkpoint) messages = [...recovered.checkpoint.messages];
        const prior = returnedFromMessages(messages);
        if (prior) return await persistReturn(prior, sessionId, options.artifacts);
      }

      const broker = new ToolBroker({
        permissionProfile: options.permissionProfile,
        workspacePath: options.workspacePath,
        artifacts: options.artifacts,
        ledger: options.ledger,
        ...(options.permissions
          ? { approve: (request) => options.permissions!.requestTool(request) }
          : {}),
      });
      for (const tool of createFilesystemTools({ artifacts: options.artifacts })) {
        broker.register(tool);
      }
      for (const tool of createProcessTools()) broker.register(tool);
      for (const tool of createResearchTools({ artifacts: options.artifacts })) {
        broker.register(tool);
      }
      if (options.browserBackend) {
        for (const tool of createBrowserTools({
          backend: options.browserBackend,
          artifacts: options.artifacts,
          taskId: options.taskId,
        })) broker.register(tool);
      }
      if (options.mcpManager) {
        for (const tool of createMcpTools(options.mcpManager, options.artifacts)) {
          broker.register(tool);
        }
      }
      for (const tool of createGitTools()) {
        if (tool.definition.name !== "git.commit") broker.register(tool);
      }
      if (options.evidenceStore) {
        for (const tool of createEvidenceTools({
          store: options.evidenceStore,
          artifacts: options.artifacts,
          taskId: options.taskId,
          clock,
        })) broker.register(tool);
      }
      if (options.skillCatalog) {
        for (const tool of createSkillTools(options.skillCatalog)) broker.register(tool);
      }
      if (options.memoryStore && options.projectId) {
        for (const tool of createMemoryTools({
          store: options.memoryStore,
          projectId: options.projectId,
          runId: options.runId,
          taskId: options.taskId,
          clock,
        })) {
          if (["recall_project_memory", "propose_project_memory"].includes(tool.definition.name)) {
            broker.register(tool);
          }
        }
      }
      broker.register(createReturnToParentTool());
      const result = await runAgentLoop({
        model: options.model,
        registry: broker,
        context: {
          runId: options.runId,
          sessionId,
          actor: { role: "subagent", id: `${options.parentActorId}:${callId}` },
          workspacePath: options.workspacePath,
          signal: context.signal,
        },
        initialMessages: messages,
        maxTurns: input.maxTurns,
        signal: context.signal,
        onCheckpoint: async (checkpoint) => {
          await options.sessions.checkpoint(sessionId, checkpoint, clock());
        },
      });
      if (result.status !== "subagent_returned") {
        const reason = result.status === "suspended"
          ? `${result.reason}${result.error ? `: ${result.error}` : ""}`
          : `unexpected lifecycle ${result.status}`;
        options.sessions.suspend(sessionId, "subagent_incomplete", reason, clock());
        return failure("subagent_incomplete", reason);
      }
      return await persistReturn(result, sessionId, options.artifacts);
    },
  }];
}

export function createReturnToParentTool(): NativeTool<ReturnSubagentInput> {
  return {
    definition: {
      name: "return_to_parent",
      description: "Return structured findings to the accountable parent worker",
      inputSchema: {
        type: "object",
        properties: {
          summary: { type: "string", minLength: 1 },
          artifactHashes: { type: "array", items: { type: "string", minLength: 1 } },
        },
        required: ["summary"],
        additionalProperties: false,
      },
      readOnly: true,
      effect: "none",
      lifecycle: true,
    },
    validate: validateReturn,
    execute: async (input, context) => {
      if (context.actor.role !== "subagent") {
        return failure("subagent_only", "Only a subagent may return to a parent.");
      }
      return {
        content: [{ type: "json", value: input }],
        isError: false,
        lifecycle: { type: "return_subagent", ...input },
      };
    },
  };
}

function validateSpawn(input: unknown): ValidationResult<SpawnSubagentInput> {
  if (!record(input) || !nonEmpty(input.assignment)) {
    return { ok: false, issues: ["assignment must be a non-empty string"] };
  }
  const maxTurns = input.maxTurns === undefined ? 8 : input.maxTurns;
  return Number.isSafeInteger(maxTurns) && (maxTurns as number) >= 1 && (maxTurns as number) <= 20
    ? { ok: true, value: { assignment: input.assignment.trim(), maxTurns: maxTurns as number } }
    : { ok: false, issues: ["maxTurns must be from 1 to 20"] };
}

function validateReturn(input: unknown): ValidationResult<ReturnSubagentInput> {
  if (!record(input) || !nonEmpty(input.summary)) {
    return { ok: false, issues: ["summary must be a non-empty string"] };
  }
  const hashes = input.artifactHashes ?? [];
  if (!Array.isArray(hashes) || !hashes.every(nonEmpty)) {
    return { ok: false, issues: ["artifactHashes must contain non-empty strings"] };
  }
  return {
    ok: true,
    value: { summary: input.summary.trim(), artifactHashes: [...hashes] },
  };
}

function returnedFromMessages(messages: readonly AgentMessage[]): ReturnSubagentInput | undefined {
  for (const message of [...messages].reverse()) {
    if (
      message.role !== "tool" ||
      typeof message.content !== "object" ||
      Array.isArray(message.content) ||
      message.content.toolName !== "return_to_parent" ||
      message.content.isError
    ) continue;
    const block = message.content.content.find((item) => item.type === "json");
    if (block?.type === "json") {
      const validated = validateReturn(block.value);
      if (validated.ok) return validated.value;
    }
  }
  return undefined;
}

async function persistReturn(
  result: ReturnSubagentInput,
  sessionId: string,
  artifacts: ArtifactStore
): Promise<ToolExecutionOutput> {
  for (const hash of result.artifactHashes) await artifacts.verify(hash);
  const artifact = await artifacts.put(
    Buffer.from(JSON.stringify({ sessionId, ...result })),
    "application/json",
    `Subagent findings ${sessionId}`
  );
  return {
    content: [{
      type: "json",
      value: { sessionId, summary: result.summary, artifactHash: artifact.hash, artifactHashes: result.artifactHashes },
    }],
    isError: false,
  };
}

function failure(code: string, message: string): ToolExecutionOutput {
  return {
    content: [{ type: "text", text: message }],
    isError: true,
    error: { code, message },
  };
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
