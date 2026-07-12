import type {
  AgentMessage,
  AgentModel,
} from "./agent-contracts.js";
import { runAgentLoop, type AgentLoopResult } from "./agent-loop.js";
import type { ArtifactStore } from "./artifact-store.js";
import { createChangeSet, type ChangeSet } from "./change-set.js";
import type { PermissionProfile } from "./contracts.js";
import { createEvidenceTools } from "./evidence-tools.js";
import type { EvidenceStore } from "./evidence-store.js";
import { createFilesystemTools } from "./filesystem-tools.js";
import { createGitTools } from "./git-tools.js";
import { createProcessTools } from "./process-tools.js";
import { createResearchTools } from "./research-tools.js";
import type { SqliteAgentSessionStore } from "./sqlite-agent-session-store.js";
import type { SchedulerStore } from "./scheduler-store.js";
import type { SkillCatalog } from "./skill-catalog.js";
import { createSkillTools } from "./skill-tools.js";
import { createSubagentTools } from "./subagent-tools.js";
import type { ProjectMemoryStore } from "./project-memory.js";
import { createMemoryTools } from "./memory-tools.js";
import { ToolBroker } from "./tool-broker.js";
import type { ToolInvocationLedger } from "./tool-ledger.js";
import type {
  TaskWorkspace,
  TaskCommit,
  WorkspaceManager,
} from "./workspace-manager.js";
import { NoTaskChangesError } from "./workspace-manager.js";
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
  evidenceStore?: EvidenceStore;
  skillCatalog?: SkillCatalog;
  memoryStore?: ProjectMemoryStore;
  projectId?: string;
  continuationMessages?: readonly AgentMessage[];
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
  if (options.continuationMessages) {
    const existingIds = new Set(messages.map((message) => message.id));
    messages.push(
      ...options.continuationMessages.filter(
        (message) => !existingIds.has(message.id)
      )
    );
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
  for (const tool of createResearchTools({ artifacts: options.artifacts })) {
    broker.register(tool);
  }
  for (const tool of createGitTools()) broker.register(tool);
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
    })) broker.register(tool);
  }
  if (options.schedulerStore) {
    for (const tool of createWorkerLifecycleTools({
      store: options.schedulerStore,
      taskId: options.taskId,
      clock,
    })) broker.register(tool);
  }
  for (const tool of createSubagentTools({
    model: options.model,
    runId: options.runId,
    parentSessionId: options.sessionId,
    taskId: options.taskId,
    parentActorId: options.actorId,
    permissionProfile: options.permissionProfile,
    workspacePath: options.workspace.path,
    artifacts: options.artifacts,
    ledger: options.ledger,
    sessions: options.sessions,
    ...(options.evidenceStore ? { evidenceStore: options.evidenceStore } : {}),
    ...(options.skillCatalog ? { skillCatalog: options.skillCatalog } : {}),
    ...(options.memoryStore ? { memoryStore: options.memoryStore } : {}),
    ...(options.projectId ? { projectId: options.projectId } : {}),
    ...(options.clock ? { clock: options.clock } : {}),
  })) broker.register(tool);

  let producedChangeSet: ChangeSet | undefined;
  broker.register(createSubmitTaskTool(async (summary) => {
    const evidenceHashes = options.evidenceStore
      ? evidenceArtifactHashes(
          options.evidenceStore.list({
            runId: options.runId,
            taskId: options.taskId,
            limit: 1_000,
          })
        )
      : [];
    if (evidenceHashes.length === 0) {
      throw new Error(
        "Task submission requires durable evidence; run run_evidence_command first."
      );
    }
    let commit: TaskCommit;
    try {
      commit = await options.workspaceManager.commitTask(
        options.taskId,
        summary
      );
    } catch (error) {
      if (!(error instanceof NoTaskChangesError)) throw error;
      commit = {
        runId: options.runId,
        taskId: options.taskId,
        revision: options.workspace.baselineRevision,
        baselineRevision: options.workspace.baselineRevision,
        commits: [],
        changedPaths: [],
      };
    }
    producedChangeSet = await createChangeSet({
      workspacePath: options.workspace.path,
      taskCommit: commit,
      artifacts: options.artifacts,
      evidenceArtifactHashes: evidenceHashes,
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

function evidenceArtifactHashes(
  records: ReturnType<EvidenceStore["list"]>
): string[] {
  return [
    ...new Set(
      records.flatMap((record) => [
        record.fact.stdoutArtifactHash,
        record.fact.stderrArtifactHash,
      ])
    ),
  ];
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
