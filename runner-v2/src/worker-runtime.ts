import type {
  AgentMessage,
  AgentModel,
  NativeTool,
} from "./agent-contracts.js";
import { runAgentLoop, type AgentLoopResult } from "./agent-loop.js";
import type { ArtifactStore } from "./artifact-store.js";
import { createChangeSet, type ChangeSet } from "./change-set.js";
import type { PermissionProfile } from "./contracts.js";
import { createFilesystemTools } from "./filesystem-tools.js";
import { createGitTools } from "./git-tools.js";
import { createProcessTools } from "./process-tools.js";
import type { SqliteAgentSessionStore } from "./sqlite-agent-session-store.js";
import { ToolBroker } from "./tool-broker.js";
import type { ToolInvocationLedger } from "./tool-ledger.js";
import type {
  TaskWorkspace,
  WorkspaceManager,
} from "./workspace-manager.js";

export interface RunWorkerTaskOptions {
  model: AgentModel;
  runId: string;
  sessionId: string;
  taskId: string;
  actorId: string;
  permissionProfile: PermissionProfile;
  workspace: TaskWorkspace;
  workspaceManager: WorkspaceManager;
  artifacts: ArtifactStore;
  ledger: ToolInvocationLedger;
  sessions: SqliteAgentSessionStore;
  initialMessages: readonly AgentMessage[];
  clock?: () => string;
}

export interface WorkerTaskResult {
  loop: AgentLoopResult;
  changeSet?: ChangeSet;
}

export async function runWorkerTask(
  options: RunWorkerTaskOptions
): Promise<WorkerTaskResult> {
  const clock = options.clock ?? (() => new Date().toISOString());
  let messages = [...options.initialMessages];
  if (options.sessions.events(options.sessionId).length === 0) {
    await options.sessions.create({
      sessionId: options.sessionId,
      runId: options.runId,
      actor: { role: "worker", id: options.actorId },
      occurredAt: clock(),
    });
  } else {
    const recovered = await options.sessions.load(options.sessionId);
    if (recovered.checkpoint) messages = [...recovered.checkpoint.messages];
    if (recovered.status === "submitted" && recovered.changeSet) {
      return {
        loop: {
          status: "submitted",
          changeSetId: recovered.changeSet.id,
          turns: recovered.checkpoint?.turns ?? 0,
          messages,
        },
        changeSet: recovered.changeSet,
      };
    }
  }

  const broker = new ToolBroker({
    permissionProfile: options.permissionProfile,
    workspacePath: options.workspace.path,
    artifacts: options.artifacts,
    ledger: options.ledger,
  });
  for (const tool of createFilesystemTools({ artifacts: options.artifacts })) {
    broker.register(tool);
  }
  for (const tool of createProcessTools()) broker.register(tool);
  for (const tool of createGitTools()) broker.register(tool);

  let producedChangeSet: ChangeSet | undefined;
  broker.register(submitTaskTool(async (summary) => {
    const commit = await options.workspaceManager.commitTask(
      options.taskId,
      summary
    );
    producedChangeSet = await createChangeSet({
      workspacePath: options.workspace.path,
      taskCommit: commit,
      artifacts: options.artifacts,
    });
    return producedChangeSet;
  }));

  const loop = await runAgentLoop({
    model: options.model,
    registry: broker,
    context: {
      runId: options.runId,
      sessionId: options.sessionId,
      actor: { role: "worker", id: options.actorId },
      workspacePath: options.workspace.path,
    },
    initialMessages: messages,
    onCheckpoint: async (checkpoint) => {
      await options.sessions.checkpoint(options.sessionId, checkpoint, clock());
    },
  });

  if (loop.status === "submitted") {
    producedChangeSet ??= changeSetFromMessages(loop.messages, loop.changeSetId);
    if (!producedChangeSet) {
      throw new Error(`Submitted change set ${loop.changeSetId} is unavailable.`);
    }
    await options.sessions.submit(options.sessionId, producedChangeSet, clock());
  } else if (loop.status === "suspended") {
    options.sessions.suspend(
      options.sessionId,
      loop.reason,
      loop.error,
      clock()
    );
  }
  return { loop, ...(producedChangeSet ? { changeSet: producedChangeSet } : {}) };
}

function submitTaskTool(
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
      typeof input === "object" &&
      input !== null &&
      typeof (input as { summary?: unknown }).summary === "string" &&
      (input as { summary: string }).summary.trim()
        ? { ok: true, value: input as { summary: string } }
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

function changeSetFromMessages(
  messages: readonly AgentMessage[],
  changeSetId: string
): ChangeSet | undefined {
  for (const message of [...messages].reverse()) {
    if (
      message.role !== "tool" ||
      typeof message.content !== "object" ||
      Array.isArray(message.content)
    ) {
      continue;
    }
    for (const block of message.content.content) {
      if (
        block.type === "json" &&
        typeof block.value === "object" &&
        block.value !== null &&
        (block.value as { id?: unknown }).id === changeSetId
      ) {
        return block.value as ChangeSet;
      }
    }
  }
  return undefined;
}
