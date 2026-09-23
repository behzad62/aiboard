import type { ExecutionGrantAuthority } from "./execution-grants.js";
import type { RunGitExecutionContext } from "./git-run-context.js";
import { createHash } from "node:crypto";

import type {
  AgentMessage,
  AgentModel,
} from "./agent-contracts.js";
import { runAgentLoop } from "./agent-loop.js";
import {
  buildPlanCritiqueContext,
  PLAN_CRITIC_INVARIANTS,
} from "./agent-prompts.js";
import type { ArtifactStore } from "./artifact-store.js";
import type {
  BudgetLedger,
  ModelCostBasisSnapshot,
} from "./budget-ledger.js";
import { BudgetedAgentModel, type ModelCostEstimator } from "./budgeted-model.js";
import { BudgetedToolRuntime } from "./budgeted-tool-runtime.js";
import type { ContextLimits } from "./context-assembler.js";
import { recordContextPack, type ContextManifestStore } from "./context-manifest-store.js";
import { classifyProviderFailure } from "./provider-health.js";
import type {
  RunnerProviderRetryRuntime,
} from "./provider-call-retry.js";
import type {
  AgentRuntimeCandidate,
  RuntimeRouter,
} from "./runtime-router.js";
import type { SqliteAgentSessionStore } from "./sqlite-agent-session-store.js";
import type { ToolInvocationLedger } from "./tool-ledger.js";
import {
  isFinalVerificationTask,
  type BuildTask,
} from "./task-contracts.js";
import {
  canonicalModelIdentity,
  type VerifierExcludedModel,
} from "./verifier-contracts.js";
import type {
  PlanCritiqueAuthority,
} from "./plan-critique-authority.js";
import type {
  PlanCritiqueFinding,
  PlanCritiqueProjection,
  PlanRiskReason,
} from "./plan-critique-contracts.js";
import { createSubmitPlanCritiqueTool } from "./plan-critique-tools.js";
import {
  createInspectionTools,
  verifierExcludedModels,
  verifierModelAttribution,
  type VerifierGuidanceSnapshot,
  type VerifierWorkspaceProvider,
} from "./native-verifier-runtime.js";

const REVISION_PATTERN = /^[a-f0-9]{40,64}$/;

export interface NativePlanCritiqueRequest {
  readonly runId: string;
  readonly objective: string;
  readonly planRevision: number;
  readonly baselineRevision: string;
  readonly architectRuntimeId: string;
  readonly tasks: readonly BuildTask[];
  readonly riskReasons: readonly PlanRiskReason[];
  readonly guidance: readonly VerifierGuidanceSnapshot[];
  readonly preferredRuntimeId?: string;
  readonly providerRetryDeadlineMs?: number;
  readonly signal?: AbortSignal;
}

export type NativePlanCritiqueResult =
  | { status: "submitted"; critiqueId: string; sessionId: string; runtimeId: string; findings: PlanCritiqueFinding[]; replayed: boolean }
  | { status: "unavailable"; reason: "no_independent_healthy_capability_match" | "runtime_unavailable"; runtimeId?: string }
  | { status: "suspended"; sessionId: string; runtimeId: string; reason: string; error?: string };

export interface NativePlanCriticRuntimeOptions {
  git?: RunGitExecutionContext;
  executionGrants?: ExecutionGrantAuthority;
  router: RuntimeRouter;
  candidates: readonly AgentRuntimeCandidate[];
  models: ReadonlyMap<string, AgentModel>;
  verifierRuntimeIds: readonly string[];
  sessions: SqliteAgentSessionStore;
  artifacts: ArtifactStore;
  workspaceManager: VerifierWorkspaceProvider;
  critiqueAuthority: PlanCritiqueAuthority;
  budgetLedger?: BudgetLedger;
  ledger?: ToolInvocationLedger;
  contextLimits?: ContextLimits;
  outputTokenReserve?: number;
  modelCostEstimators?: ReadonlyMap<string, ModelCostEstimator>;
  modelCostBases?: ReadonlyMap<string, ModelCostBasisSnapshot>;
  providerRetryRuntime?: RunnerProviderRetryRuntime;
  contextManifests?: ContextManifestStore;
  recordContextPackText?: boolean;
  maxTurns?: number;
  clock?: () => string;
}

export class NativePlanCriticRuntime {
  private readonly candidateById: Map<string, AgentRuntimeCandidate>;
  private readonly clock: () => string;

  constructor(private readonly options: NativePlanCriticRuntimeOptions) {
    if (options.workspaceManager.workspaceKind !== "independent-verifier") {
      throw new Error("Native plan critic requires an independent verifier workspace.");
    }
    this.candidateById = new Map(
      options.candidates.map((candidate) => [candidate.runtimeId, candidate])
    );
    this.clock = options.clock ?? (() => new Date().toISOString());
  }

  async critique(
    request: NativePlanCritiqueRequest
  ): Promise<NativePlanCritiqueResult> {
    assertCritiqueRequest(request);
    if (
      request.preferredRuntimeId &&
      !this.options.verifierRuntimeIds.includes(request.preferredRuntimeId)
    ) {
      throw new Error(
        `Preferred plan critic runtime ${request.preferredRuntimeId} is not configured for this Build.`,
      );
    }
    const selection = this.options.router.selectVerifier({
      requiredCapabilities: ["code"],
      candidateRuntimeIds: request.preferredRuntimeId
        ? [request.preferredRuntimeId]
        : this.options.verifierRuntimeIds,
      architectRuntimeId: request.architectRuntimeId,
      acceptedChangeAuthorRuntimeIds: [],
    });
    if (selection.status === "unavailable") {
      return {
        status: "unavailable",
        reason: selection.reason,
      };
    }

    const candidate = this.candidateById.get(selection.runtime.runtimeId);
    const model = this.options.models.get(selection.runtime.runtimeId);
    if (!candidate || !model) {
      return {
        status: "unavailable",
        reason: "runtime_unavailable",
        runtimeId: selection.runtime.runtimeId,
      };
    }

    const workspace = await this.options.workspaceManager.create(
      request.baselineRevision
    );
    if (workspace.targetRevision !== request.baselineRevision) {
      throw new Error(
        "Plan critic workspace target revision does not match the requested baseline revision."
      );
    }
    const contextLimits = this.options.contextLimits ?? {
      maxBytes: 512 * 1024,
      maxEstimatedTokens: 128 * 1024,
    };
    const context = buildPlanCritiqueContext({
      limits: contextLimits,
      objective: request.objective,
      planRevision: request.planRevision,
      baselineRevision: request.baselineRevision,
      tasks: planCritiqueTaskGraph(request.tasks),
      riskReasons: request.riskReasons,
      guidance: request.guidance,
    });
    const sessionId = planCriticSessionId(
      request.runId,
      request.planRevision,
      candidate.runtimeId,
      context.digest,
    );
    await recordContextPack({
      store: this.options.contextManifests,
      artifacts: this.options.artifacts,
      recordPackText: this.options.recordContextPackText,
      runId: request.runId,
      sessionId,
      actor: { role: "verifier", id: candidate.runtimeId },
      role: "verifier",
      purpose: "critic:plan_critique",
      repositoryRevision: request.baselineRevision,
      limits: contextLimits,
      pack: context,
      recordedAt: this.clock(),
    });
    const excludedModels = verifierExcludedModels(
      this.candidateById,
      request.architectRuntimeId,
      [],
    );
    const durableCritique = this.options.critiqueAuthority.requestCritique({
      runId: request.runId,
      critiqueId: planCritiqueId(
        request.runId,
        request.planRevision,
        sessionId,
      ),
      planRevision: request.planRevision,
      runtime: {
        runtimeId: candidate.runtimeId,
        providerId: candidate.providerId,
        modelId: candidate.modelId,
        modelIdentity: canonicalModelIdentity(candidate.modelId),
        sessionId,
      },
      excludedModels,
      occurredAt: this.clock(),
    });
    assertBoundPlanCritique({
      critique: durableCritique,
      request,
      candidate,
      sessionId,
      excludedModels,
    });
    const systemMessage: AgentMessage = {
      id: "plan-critic-system",
      role: "system",
      content: PLAN_CRITIC_INVARIANTS,
    };
    const contextMessage: AgentMessage = {
      id: `plan-critic-context:${context.digest}`,
      role: "user",
      content: context.text,
    };
    let messages: AgentMessage[] = [systemMessage, contextMessage];
    const sessionEvents = this.options.sessions.events(sessionId);
    let recoveredCompleted = false;
    if (sessionEvents.length === 0) {
      await this.options.sessions.create({
        sessionId,
        runId: request.runId,
        actor: { role: "verifier", id: candidate.runtimeId },
        occurredAt: this.clock(),
      });
    } else {
      const recovered = await this.options.sessions.load(sessionId);
      if (
        recovered.actor.role !== "verifier" ||
        recovered.actor.id !== candidate.runtimeId ||
        recovered.runId !== request.runId
      ) {
        throw new Error("Recovered plan critic session identity does not match the request.");
      }
      if (recovered.checkpoint) messages = [...recovered.checkpoint.messages];
      recoveredCompleted = recovered.status === "completed";
      if (!messages.some((message) => message.id === contextMessage.id)) {
        messages.push(contextMessage);
      }
    }

    if (durableCritique.status === "submitted" && durableCritique.findings) {
      this.options.sessions.complete(sessionId, this.clock());
      return submittedResult(durableCritique, candidate.runtimeId, true);
    }
    if (recoveredCompleted) {
      throw new Error(
        "Completed plan critic session has no durable typed critique.",
      );
    }

    const critiqueTasks = Object.fromEntries(
      request.tasks
        .filter((task) => task.status !== "cancelled" && !isFinalVerificationTask(task))
        .map((task) => [task.id, task]),
    );
    const broker = createInspectionTools({
      git: this.options.git,
      executionGrants: this.options.executionGrants,
      workspacePath: workspace.path,
      artifacts: this.options.artifacts,
      runId: request.runId,
      clock: this.clock,
      lifecycleTool: createSubmitPlanCritiqueTool({
        authority: this.options.critiqueAuthority,
        runId: request.runId,
        critiqueId: durableCritique.critiqueId,
        planRevision: durableCritique.planRevision,
        runtimeId: candidate.runtimeId,
        sessionId,
        tasks: critiqueTasks,
        clock: this.clock,
      }),
      ...(this.options.ledger ? { ledger: this.options.ledger } : {}),
    });
    const tools = this.options.budgetLedger
      ? new BudgetedToolRuntime({
          runtime: broker,
          ledger: this.options.budgetLedger,
          scopeId: request.runId,
          clock: this.clock,
        })
      : broker;
    const runtimeModel = this.options.budgetLedger
      ? new BudgetedAgentModel({
          model,
          ledger: this.options.budgetLedger,
          scopeId: request.runId,
          attribution: verifierModelAttribution(candidate, sessionId),
          outputTokenReserve: this.options.outputTokenReserve ?? 16_384,
          estimateCostMicros: this.options.modelCostEstimators?.get(
            candidate.runtimeId
          ),
          costBasis: this.options.modelCostBases?.get(candidate.runtimeId),
          clock: this.clock,
        })
      : model;
    const result = await runAgentLoop({
      model: runtimeModel,
      registry: tools,
      context: {
        runId: request.runId,
        sessionId,
        actor: { role: "verifier", id: candidate.runtimeId },
        workspacePath: workspace.path,
        signal: request.signal,
      },
      initialMessages: messages,
      maxTurns: this.options.maxTurns ?? 20,
      signal: request.signal,
      providerRetry: {
        runtimeId: candidate.runtimeId,
        providerId: candidate.providerId,
        modelId: candidate.modelId,
        deadlineMs: request.providerRetryDeadlineMs,
        classify: classifyProviderFailure,
        ...(this.options.providerRetryRuntime
          ? {
              now: this.options.providerRetryRuntime.now,
              random: this.options.providerRetryRuntime.random,
              sleep: this.options.providerRetryRuntime.sleep,
            }
          : {}),
      },
      onCheckpoint: async (checkpoint) => {
        await this.options.sessions.checkpoint(sessionId, checkpoint, this.clock());
      },
    });

    if (result.status === "plan_critique_submitted") {
      const submitted = this.options.critiqueAuthority.currentCritique(
        request.runId,
      );
      if (
        !submitted?.findings ||
        submitted.status !== "submitted" ||
        submitted.critiqueId !== result.critiqueId ||
        submitted.runtime.runtimeId !== candidate.runtimeId ||
        submitted.runtime.sessionId !== sessionId ||
        submitted.planRevision !== request.planRevision
      ) {
        throw new Error(
          "Plan critic lifecycle returned before its exact typed critique was durable.",
        );
      }
      this.options.router.recordSuccess(candidate.runtimeId);
      this.options.sessions.complete(sessionId, this.clock());
      return submittedResult(submitted, candidate.runtimeId, false);
    }
    if (result.status === "suspended") {
      if (result.reason === "provider_error") {
        this.options.router.recordFailure(
          candidate.runtimeId,
          classifyProviderFailure({
            ...result.providerError,
            message: result.error ?? "Plan critic provider failed.",
          })
        );
      }
      this.options.sessions.suspend(
        sessionId,
        result.reason,
        result.error,
        this.clock()
      );
      return {
        status: "suspended",
        sessionId,
        runtimeId: candidate.runtimeId,
        reason: result.reason,
        ...(result.error ? { error: result.error } : {}),
      };
    }

    const reason = `unexpected_plan_critic_lifecycle:${result.status}`;
    this.options.sessions.suspend(sessionId, reason, undefined, this.clock());
    return {
      status: "suspended",
      sessionId,
      runtimeId: candidate.runtimeId,
      reason,
    };
  }
}

function planCritiqueTaskGraph(tasks: readonly BuildTask[]): readonly unknown[] {
  return tasks
    .filter((task) => task.status !== "cancelled" && !isFinalVerificationTask(task))
    .map((task) => ({
      id: task.id,
      objective: task.objective,
      dependencies: task.dependencies,
      requiredCapabilities: task.requiredCapabilities,
      acceptanceCriteria: task.acceptanceCriteria,
    }));
}

function planCriticSessionId(
  runId: string,
  planRevision: number,
  runtimeId: string,
  contextDigest: string,
): string {
  const digest = createHash("sha256")
    .update(JSON.stringify([runId, planRevision, runtimeId, contextDigest]))
    .digest("hex")
    .slice(0, 24);
  return `plan-critic:${runId}:${digest}`;
}

function planCritiqueId(
  runId: string,
  planRevision: number,
  sessionId: string,
): string {
  const digest = createHash("sha256")
    .update(JSON.stringify([runId, planRevision, sessionId]))
    .digest("hex");
  return `plan-critique:${digest}`;
}

function assertCritiqueRequest(request: NativePlanCritiqueRequest): void {
  if (!request.runId.trim() || !request.objective.trim()) {
    throw new Error("Plan critic identity and objective are required.");
  }
  if (!Number.isSafeInteger(request.planRevision) || request.planRevision < 1) {
    throw new Error("Plan critic plan revision is invalid.");
  }
  if (!REVISION_PATTERN.test(request.baselineRevision)) {
    throw new Error("Plan critic baseline revision is invalid.");
  }
}

function assertBoundPlanCritique(input: {
  critique: PlanCritiqueProjection;
  request: NativePlanCritiqueRequest;
  candidate: AgentRuntimeCandidate;
  sessionId: string;
  excludedModels: readonly VerifierExcludedModel[];
}): void {
  if (
    input.critique.planRevision !== input.request.planRevision ||
    input.critique.runtime.runtimeId !== input.candidate.runtimeId ||
    input.critique.runtime.providerId !== input.candidate.providerId ||
    input.critique.runtime.modelId !== input.candidate.modelId ||
    input.critique.runtime.modelIdentity !==
      canonicalModelIdentity(input.candidate.modelId) ||
    input.critique.runtime.sessionId !== input.sessionId ||
    JSON.stringify(input.critique.excludedModels) !==
      JSON.stringify(input.excludedModels)
  ) {
    throw new Error(
      "Durable plan critique conflicts with its kernel-selected revision, identity, or excluded models.",
    );
  }
}

function submittedResult(
  critique: PlanCritiqueProjection,
  runtimeId: string,
  replayed: boolean,
): NativePlanCritiqueResult {
  return {
    status: "submitted",
    critiqueId: critique.critiqueId,
    sessionId: critique.runtime.sessionId,
    runtimeId,
    findings: (critique.findings ?? []).map((finding) => ({
      ...finding,
      taskIds: [...finding.taskIds],
      evidence: [...finding.evidence],
      ...(finding.criterionIds
        ? { criterionIds: finding.criterionIds.map((criterion) => ({ ...criterion })) }
        : {}),
    })),
    replayed,
  };
}
