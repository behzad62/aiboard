import type {
  AgentMessage,
  AgentModel,
  NativeTool,
  ToolExecutionOutput,
  ValidationResult,
} from "./agent-contracts.js";
import { runAgentLoop } from "./agent-loop.js";
import type { ArtifactStore } from "./artifact-store.js";
import { createArtifactTools } from "./artifact-tools.js";
import type { BudgetLedger } from "./budget-ledger.js";
import { BudgetedToolRuntime } from "./budgeted-tool-runtime.js";
import { createBrowserTools, type BrowserBackend } from "./browser-tools.js";
import type { PermissionProfile } from "./contracts.js";
import { createEvidenceTools } from "./evidence-tools.js";
import type { EvidenceStore } from "./evidence-store.js";
import { createFilesystemTools } from "./filesystem-tools.js";
import { createGitTools } from "./git-tools.js";
import { createMemoryTools } from "./memory-tools.js";
import { createMcpTools, type McpManager } from "./mcp-tools.js";
import type { SqlitePermissionStore } from "./permission-store.js";
import type { ManagedProcessService } from "./managed-process.js";
import { createManagedProcessTools } from "./managed-process-tools.js";
import type { ProjectMemoryStore } from "./project-memory.js";
import { createProcessTools } from "./process-tools.js";
import { createResearchTools } from "./research-tools.js";
import { createSessionTools } from "./session-tools.js";
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
  managedProcesses?: ManagedProcessService;
  budgetLedger?: BudgetLedger;
}

export function createSubagentTools(
  options: SubagentToolsOptions
): NativeTool<SpawnSubagentInput>[] {
  return [
    spawnSubagentTool(options, "workspace"),
    spawnSubagentTool(options, "read_only"),
  ];
}

function spawnSubagentTool(
  options: SubagentToolsOptions,
  mode: "workspace" | "read_only"
): NativeTool<SpawnSubagentInput> {
  const clock = options.clock ?? (() => new Date().toISOString());
  const readOnly = mode === "read_only";
  return {
    definition: {
      name: readOnly ? "spawn_readonly_subagent" : "spawn_subagent",
      description: readOnly
        ? "Delegate a bounded read-only investigation; multiple calls in one turn may run concurrently and cannot mutate the workspace"
        : "Delegate one bounded investigation or implementation assignment inside this task workspace; the child returns structured findings and cannot submit or commit the parent task",
      inputSchema: {
        type: "object",
        properties: {
          assignment: { type: "string", minLength: 1 },
          maxTurns: { type: "integer", minimum: 1, maximum: 20 },
        },
        required: ["assignment"],
        additionalProperties: false,
      },
      readOnly,
      effect: readOnly ? "none" : "workspace",
    },
    validate: validateSpawn,
    assessAccess: () => readOnly
      ? { capability: "coordination.subagent.read" }
      : {
          capability: "coordination.subagent",
          paths: [{ path: ".", access: "write" }],
        },
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
            readOnly
              ? "This is a read-only parallel investigation. Inspect and research, but do not modify files, run arbitrary processes, record command evidence, or propose memory."
              : "You may inspect, edit, run tools, gather evidence, use project skills, and propose project memory.",
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
        if (prior) {
          const output = await persistReturn(prior, sessionId, options.artifacts);
          options.sessions.complete(sessionId, clock());
          return output;
        }
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
        if (!readOnly || tool.definition.readOnly) broker.register(tool);
      }
      for (const tool of createArtifactTools(options.artifacts)) broker.register(tool);
      for (const tool of createSessionTools(options.sessions)) broker.register(tool);
      if (!readOnly) for (const tool of createProcessTools()) broker.register(tool);
      if (!readOnly && options.managedProcesses) {
        for (const tool of createManagedProcessTools(options.managedProcesses)) {
          broker.register(tool);
        }
      }
      for (const tool of createResearchTools({ artifacts: options.artifacts })) {
        broker.register(tool);
      }
      if (!readOnly && options.browserBackend) {
        for (const tool of createBrowserTools({
          backend: options.browserBackend,
          artifacts: options.artifacts,
          ...(options.evidenceStore ? { evidenceStore: options.evidenceStore } : {}),
          taskId: options.taskId,
          clock,
        })) broker.register(tool);
      }
      if (!readOnly && options.mcpManager) {
        for (const tool of createMcpTools(options.mcpManager, options.artifacts)) {
          broker.register(tool);
        }
      }
      for (const tool of createGitTools()) {
        if (readOnly ? tool.definition.readOnly : tool.definition.name !== "git.commit") {
          broker.register(tool);
        }
      }
      if (!readOnly && options.evidenceStore) {
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
          if (
            tool.definition.name === "recall_project_memory" ||
            (!readOnly && tool.definition.name === "propose_project_memory")
          ) {
            broker.register(tool);
          }
        }
      }
      broker.register(createReturnToParentTool());
      const toolRuntime = options.budgetLedger
        ? new BudgetedToolRuntime({
            runtime: broker,
            ledger: options.budgetLedger,
            scopeId: options.runId,
            clock,
          })
        : broker;
      const result = await runAgentLoop({
        model: options.model,
        registry: toolRuntime,
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
      const output = await persistReturn(result, sessionId, options.artifacts);
      options.sessions.complete(sessionId, clock());
      return output;
    },
  };
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
