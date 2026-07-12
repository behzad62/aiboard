import type { AgentModel } from "./agent-contracts.js";
import { buildWorkerContext, type PromptEvidence } from "./agent-prompts.js";
import type { ArtifactStore } from "./artifact-store.js";
import type { BudgetLedger } from "./budget-ledger.js";
import type { BrowserBackend } from "./browser-tools.js";
import type { McpManager } from "./mcp-tools.js";
import { BudgetedAgentModel } from "./budgeted-model.js";
import type { ContextLimits } from "./context-assembler.js";
import type { PermissionProfile } from "./contracts.js";
import type { EvidenceStore } from "./evidence-store.js";
import { runGit } from "./git-command.js";
import type { ProjectMemoryStore } from "./project-memory.js";
import { discoverProjectInstructions } from "./project-context.js";
import {
  classifyProviderFailure,
  type ProviderFailure,
  type ProviderHealthRegistry,
} from "./provider-health.js";
import type { RuntimeRouter, AgentRuntimeCandidate } from "./runtime-router.js";
import type { SchedulerStore } from "./scheduler-store.js";
import { rebuildSchedulerProjection } from "./scheduler-store.js";
import type { SqliteAgentSessionStore } from "./sqlite-agent-session-store.js";
import type { SkillCatalog, SkillDocument, SkillMetadata } from "./skill-catalog.js";
import type {
  WorkerAssignment,
  WorkerOutcome,
  WorkerRuntimeDriver,
} from "./task-scheduler.js";
import type { ToolInvocationLedger } from "./tool-ledger.js";
import type { WorkspaceManager } from "./workspace-manager.js";
import { runWorkerTask } from "./worker-runtime.js";

export interface NativeWorkerDriverOptions {
  schedulerStore: SchedulerStore;
  router: RuntimeRouter;
  health: ProviderHealthRegistry;
  candidates: readonly AgentRuntimeCandidate[];
  models: ReadonlyMap<string, AgentModel>;
  permissionProfile: PermissionProfile;
  workspaceManager: WorkspaceManager;
  artifacts: ArtifactStore;
  ledger: ToolInvocationLedger;
  sessions: SqliteAgentSessionStore;
  evidenceStore: EvidenceStore;
  skillCatalog: SkillCatalog;
  memoryStore: ProjectMemoryStore;
  projectId: string;
  projectRoot: string;
  budgetLedger?: BudgetLedger;
  browserBackend?: BrowserBackend;
  mcpManager?: McpManager;
  contextLimits?: ContextLimits;
  outputTokenReserve?: number;
  clock?: () => string;
}

export class NativeWorkerDriver implements WorkerRuntimeDriver {
  private readonly candidateById: Map<string, AgentRuntimeCandidate>;
  private readonly clock: () => string;
  private readonly contextLimits: ContextLimits;

  constructor(private readonly options: NativeWorkerDriverOptions) {
    this.candidateById = new Map(
      options.candidates.map((candidate) => [candidate.runtimeId, candidate])
    );
    this.clock = options.clock ?? (() => new Date().toISOString());
    this.contextLimits = options.contextLimits ?? {
      maxBytes: 256 * 1024,
      maxEstimatedTokens: 64 * 1024,
    };
  }

  async run(assignment: WorkerAssignment): Promise<WorkerOutcome> {
    let runtimeId = this.persistedRuntime(assignment);
    if (!runtimeId) {
      const selection = this.options.router.selectWorker(
        assignment.task.requiredCapabilities
      );
      if (selection.status === "unavailable") {
        return { type: "paused", reason: "no_healthy_capability_match" };
      }
      runtimeId = selection.runtime.runtimeId;
      this.assignRuntime(assignment, runtimeId);
    }

    for (;;) {
      const model = this.options.models.get(runtimeId);
      const candidate = this.candidateById.get(runtimeId);
      if (!model || !candidate) {
        return { type: "paused", reason: `runtime_unavailable:${runtimeId}` };
      }
      const workspace = await this.options.workspaceManager.createTaskWorkspace(
        assignment.task.id
      );
      const context = await this.workerContext(assignment, workspace.path);
      const sessionId = `worker:${assignment.runId}:${assignment.task.id}:${assignment.attempt}`;
      const budgetedModel = this.options.budgetLedger
        ? new BudgetedAgentModel({
            model,
            ledger: this.options.budgetLedger,
            scopeId: assignment.runId,
            outputTokenReserve: this.options.outputTokenReserve ?? 16_384,
            clock: this.clock,
          })
        : model;
      const result = await runWorkerTask({
        model: budgetedModel,
        runId: assignment.runId,
        sessionId,
        taskId: assignment.task.id,
        actorId: assignment.workerId,
        permissionProfile: this.options.permissionProfile,
        workspace,
        workspaceManager: this.options.workspaceManager,
        artifacts: this.options.artifacts,
        ledger: this.options.ledger,
        sessions: this.options.sessions,
        schedulerStore: this.options.schedulerStore,
        evidenceStore: this.options.evidenceStore,
        skillCatalog: this.options.skillCatalog,
        memoryStore: this.options.memoryStore,
        projectId: this.options.projectId,
        initialMessages: [
          {
            id: "worker-system",
            role: "system",
            content: [
              "You are an AIBoard native worker. Use tools and finish with submit_task.",
              "Batch independent read-only tool calls in one turn when that reduces model round trips.",
              "Keep command output narrow: prefer native search/read tools and targeted ranges over broad file dumps.",
              "Before every submit_task, record task-relevant durable command evidence with run_evidence_command; the Architect decides whether that evidence is sufficient.",
            ].join("\n"),
          },
        ],
        continuationMessages: [
          {
            id: `context:${context.digest}`,
            role: "user",
            content: context.text,
          },
        ],
        clock: this.clock,
        ...(this.options.browserBackend
          ? { browserBackend: this.options.browserBackend }
          : {}),
        ...(this.options.mcpManager ? { mcpManager: this.options.mcpManager } : {}),
      });
      if (result.loop.status === "submitted") {
        this.recordSuccess(assignment.runId, candidate.providerId);
        return { type: "submitted", changeSetId: result.loop.changeSetId };
      }
      if (result.loop.status === "waiting_for_architect") {
        const projection = rebuildSchedulerProjection(
          this.options.schedulerStore.readRun(assignment.runId)
        );
        const guidance = projection.guidance[result.loop.requestId];
        if (!guidance) {
          return { type: "failed", reason: `missing_guidance:${result.loop.requestId}` };
        }
        return {
          type: "guidance",
          requestId: guidance.requestId,
          blocking: guidance.blocking,
          question: guidance.question,
          evidenceSequence: guidance.evidenceSequence,
        };
      }
      if (
        result.loop.status === "suspended" &&
        result.loop.reason === "provider_error"
      ) {
        const failure = classifyProviderFailure({
          ...result.loop.providerError,
          message: result.loop.error ?? "Provider failed.",
        });
        this.options.health.recordFailure(candidate.providerId, failure);
        this.persistHealth(assignment.runId, candidate.providerId);
        if (!shouldFailoverWorkerFailure(failure)) {
          return {
            type: "failed",
            reason: `provider_${failure.kind}:${failure.message}`,
          };
        }
        const selection = this.options.router.selectWorker(
          assignment.task.requiredCapabilities,
          new Set([runtimeId])
        );
        if (selection.status === "unavailable") {
          return { type: "paused", reason: "all_worker_runtimes_unavailable" };
        }
        runtimeId = selection.runtime.runtimeId;
        this.assignRuntime(assignment, runtimeId);
        continue;
      }
      return {
        type: "failed",
        reason:
          result.loop.status === "suspended"
            ? `${result.loop.reason}:${result.loop.error ?? ""}`
            : `unexpected_worker_lifecycle:${result.loop.status}`,
      };
    }
  }

  private persistedRuntime(assignment: WorkerAssignment): string | undefined {
    const events = this.options.schedulerStore.readRun(assignment.runId);
    if (events.length === 0) return undefined;
    return rebuildSchedulerProjection(events).runtime.workerAssignments[
      `${assignment.task.id}:${assignment.attempt}`
    ]?.runtimeId;
  }

  private assignRuntime(assignment: WorkerAssignment, runtimeId: string): void {
    const existingCount = this.options.schedulerStore
      .readRun(assignment.runId)
      .filter((event) => event.type === "worker.runtime_assigned").length;
    this.options.schedulerStore.append({
      runId: assignment.runId,
      type: "worker.runtime_assigned",
      occurredAt: this.clock(),
      actor: { role: "runner", id: "runtime-router" },
      idempotencyKey: `worker-runtime:${assignment.task.id}:${assignment.attempt}:${existingCount + 1}`,
      payload: {
        taskId: assignment.task.id,
        attempt: assignment.attempt,
        runtimeId,
        sessionId: `worker:${assignment.runId}:${assignment.task.id}:${assignment.attempt}`,
      },
    });
  }

  private recordSuccess(runId: string, providerId: string): void {
    this.options.health.recordSuccess(providerId);
    this.persistHealth(runId, providerId);
  }

  private persistHealth(runId: string, providerId: string): void {
    const state = this.options.health.get(providerId);
    const count = this.options.schedulerStore
      .readRun(runId)
      .filter((event) => event.type === "provider.health_changed").length;
    this.options.schedulerStore.append({
      runId,
      type: "provider.health_changed",
      occurredAt: this.clock(),
      actor: { role: "runner", id: "runtime-router" },
      idempotencyKey: `provider-health:${providerId}:${count + 1}`,
      payload: { state },
    });
  }

  private async workerContext(
    assignment: WorkerAssignment,
    workspacePath: string
  ) {
    const [instructions, skillMetadata, repositorySnapshot] = await Promise.all([
      discoverProjectInstructions({
        projectRoot: workspacePath,
        targetPath: workspacePath,
      }),
      this.options.skillCatalog.discover(),
      snapshotRepository(workspacePath),
    ]);
    const skills = await selectedSkills(
      this.options.skillCatalog,
      skillMetadata,
      assignment.task.objective,
      3
    );
    const memories = this.options.memoryStore.search({
      projectId: this.options.projectId,
      query: assignment.task.objective,
      concepts: assignment.task.requiredCapabilities,
      limit: 10,
    });
    const projection = rebuildSchedulerProjection(
      this.options.schedulerStore.readRun(assignment.runId)
    );
    const guidance = Object.values(projection.guidance)
      .filter(
        (item) => item.taskId === assignment.task.id && item.status === "answered"
      )
      .map((item) => ({
        requestId: item.requestId,
        answer: item.answer ?? "",
        version: item.version,
      }));
    const evidence: PromptEvidence[] = this.options.evidenceStore
      .list({ runId: assignment.runId, taskId: assignment.task.id })
      .map((record) => ({
        id: record.id,
        summary: `${record.fact.command} exited ${record.fact.exitCode}`,
        artifactHashes: [
          record.fact.stdoutArtifactHash,
          record.fact.stderrArtifactHash,
        ],
      }));
    return buildWorkerContext({
      limits: this.contextLimits,
      task: projection.tasks[assignment.task.id],
      guidance,
      instructions,
      skills,
      memories,
      repositorySnapshot,
      evidence,
      recentHistory: [],
    });
  }
}

export function shouldFailoverWorkerFailure(failure: ProviderFailure): boolean {
  return failure.kind !== "invalid_request" && failure.kind !== "cancelled";
}

async function snapshotRepository(workspacePath: string): Promise<string> {
  const [head, status] = await Promise.all([
    runGit({ cwd: workspacePath, args: ["rev-parse", "HEAD"] }),
    runGit({ cwd: workspacePath, args: ["status", "--porcelain=v1"] }),
  ]);
  return `HEAD ${head.stdout.trim()}\n${status.stdout || "working tree clean"}`;
}

async function selectedSkills(
  catalog: SkillCatalog,
  metadata: SkillMetadata[],
  objective: string,
  limit: number
): Promise<SkillDocument[]> {
  const objectiveTokens = new Set(tokens(objective));
  const ranked = metadata
    .map((skill) => ({
      skill,
      score: tokens(`${skill.name} ${skill.description}`).filter((token) =>
        objectiveTokens.has(token)
      ).length,
    }))
    .filter((item) => item.score > 0)
    .sort(
      (left, right) =>
        right.score - left.score || left.skill.id.localeCompare(right.skill.id)
    )
    .slice(0, limit);
  return await Promise.all(ranked.map(({ skill }) => catalog.read(skill.id)));
}

function tokens(value: string): string[] {
  return value.toLowerCase().match(/[\p{L}\p{N}_-]+/gu) ?? [];
}
