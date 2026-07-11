import type {
  AgentMessage,
  AgentModel,
} from "./agent-contracts.js";
import { runAgentLoop, type AgentLoopResult } from "./agent-loop.js";
import type { ArtifactStore } from "./artifact-store.js";
import { createChangeSet, type ChangeSet } from "./change-set.js";
import type { PermissionProfile } from "./contracts.js";
import { createFilesystemTools } from "./filesystem-tools.js";
import { createGitTools } from "./git-tools.js";
import { createProcessTools } from "./process-tools.js";
import type { SqliteAgentSessionStore } from "./sqlite-agent-session-store.js";
import type { SchedulerStore } from "./scheduler-store.js";
import { ToolBroker } from "./tool-broker.js";
import type { ToolInvocationLedger } from "./tool-ledger.js";
import type {
  TaskWorkspace,
  WorkspaceManager,
} from "./workspace-manager.js";
import {
  createSubmitTaskTool,
  createWorkerLifecycleTools,
} from "./worker-lifecycle-tools.js";

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
  schedulerStore?: SchedulerStore;
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
  if (options.schedulerStore) {
    for (const tool of createWorkerLifecycleTools({
      store: options.schedulerStore,
      taskId: options.taskId,
      clock,
    })) broker.register(tool);
  }

  let producedChangeSet: ChangeSet | undefined;
  broker.register(createSubmitTaskTool(async (summary) => {
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
  } else if (loop.status === "waiting_for_architect") {
    options.sessions.suspend(
      options.sessionId,
      "waiting_for_architect",
      loop.requestId,
      clock()
    );
  }
  return { loop, ...(producedChangeSet ? { changeSet: producedChangeSet } : {}) };
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
