import { createHash } from "node:crypto";

import type {
  AgentMessage,
  AgentModel,
  ToolDefinition,
} from "./agent-contracts.js";
import { runAgentLoop } from "./agent-loop.js";
import {
  buildVerifierContext,
  VERIFIER_AUTHORITY_INVARIANTS,
} from "./agent-prompts.js";
import type { ArtifactStore } from "./artifact-store.js";
import { createArtifactTools } from "./artifact-tools.js";
import type {
  BudgetLedger,
  ModelCallAttribution,
  ModelCostBasisSnapshot,
} from "./budget-ledger.js";
import { BudgetedAgentModel, type ModelCostEstimator } from "./budgeted-model.js";
import { BudgetedToolRuntime } from "./budgeted-tool-runtime.js";
import type { ContextLimits } from "./context-assembler.js";
import {
  assertAcceptanceCriteria,
  type AcceptanceCriterion,
  type CriterionReviewVerdict,
} from "./acceptance-contracts.js";
import { createEvidenceTools } from "./evidence-tools.js";
import type { EvidenceStore } from "./evidence-store.js";
import { createFilesystemTools } from "./filesystem-tools.js";
import type { FinalVerificationCheckResult } from "./final-verification-runtime.js";
import { createGitTools } from "./git-tools.js";
import { classifyProviderFailure } from "./provider-health.js";
import type {
  RunnerProviderRetryRuntime,
} from "./provider-call-retry.js";
import { RepositoryIntelligence } from "./repository-intelligence.js";
import type { BuildRiskReason } from "./risk-policy.js";
import type {
  AgentRuntimeCandidate,
  RuntimeRouter,
} from "./runtime-router.js";
import type { SqliteAgentSessionStore } from "./sqlite-agent-session-store.js";
import { ToolBroker } from "./tool-broker.js";
import type { ToolInvocationLedger } from "./tool-ledger.js";
import type { VerificationWorkspace } from "./verification-workspace.js";

const REVISION_PATTERN = /^[a-f0-9]{40,64}$/;
const ARTIFACT_PATTERN = /^[a-f0-9]{64}$/;

export interface VerifierCriterionSnapshot {
  readonly taskId: string;
  readonly taskTitle: string;
  readonly criterion: AcceptanceCriterion;
}

export interface VerifierReviewSnapshot {
  readonly taskId: string;
  readonly attempt: number;
  readonly status: "requested" | "approved" | "rejected";
  readonly summary?: string;
  readonly evidenceArtifactHashes: readonly string[];
  readonly criterionVerdicts?: readonly CriterionReviewVerdict[];
}

export interface VerifierGuidanceSnapshot {
  readonly id: string;
  readonly kind: "user_guidance" | "architect_answer";
  readonly version: number;
  readonly text: string;
}

export interface VerifierChangeSnapshot {
  readonly taskId: string;
  readonly attempt: number;
  readonly changeSetId: string;
  readonly authorRuntimeId: string;
  readonly baselineRevision: string;
  readonly taskRevision: string;
  readonly changedPaths: readonly string[];
  readonly diffArtifactHash: string;
}

export interface VerifierFinalVerificationSnapshot {
  readonly generationId: string;
  readonly targetRevision: string;
  readonly green: boolean;
  readonly checks: readonly FinalVerificationCheckResult[];
}

export interface NativeVerifierInspectionRequest {
  readonly runId: string;
  readonly objective: string;
  readonly targetRevision: string;
  readonly architectRuntimeId: string;
  readonly criteria: readonly VerifierCriterionSnapshot[];
  readonly reviews: readonly VerifierReviewSnapshot[];
  readonly guidance: readonly VerifierGuidanceSnapshot[];
  readonly changes: readonly VerifierChangeSnapshot[];
  readonly finalVerification: VerifierFinalVerificationSnapshot;
  readonly riskReasons: readonly BuildRiskReason[];
  readonly providerRetryDeadlineMs?: number;
  readonly signal?: AbortSignal;
}

export type NativeVerifierInspectionResult =
  | {
      readonly status: "inspected";
      readonly sessionId: string;
      readonly runtimeId: string;
      readonly targetRevision: string;
      readonly messages: readonly AgentMessage[];
      readonly summary: string;
      readonly replayed: boolean;
    }
  | {
      readonly status: "unavailable";
      readonly reason:
        | "no_independent_healthy_capability_match"
        | "runtime_unavailable";
      readonly runtimeId?: string;
    }
  | {
      readonly status: "suspended";
      readonly sessionId: string;
      readonly runtimeId: string;
      readonly targetRevision: string;
      readonly reason: string;
      readonly error?: string;
      readonly messages: readonly AgentMessage[];
    };

export interface VerifierWorkspaceProvider {
  readonly workspaceKind: "independent-verifier";
  create(targetRevision: string): Promise<VerificationWorkspace>;
}

export interface NativeVerifierRuntimeOptions {
  router: RuntimeRouter;
  candidates: readonly AgentRuntimeCandidate[];
  models: ReadonlyMap<string, AgentModel>;
  verifierRuntimeIds: readonly string[];
  sessions: SqliteAgentSessionStore;
  artifacts: ArtifactStore;
  evidenceStore: EvidenceStore;
  workspaceManager: VerifierWorkspaceProvider;
  budgetLedger?: BudgetLedger;
  ledger?: ToolInvocationLedger;
  contextLimits?: ContextLimits;
  outputTokenReserve?: number;
  modelCostEstimators?: ReadonlyMap<string, ModelCostEstimator>;
  modelCostBases?: ReadonlyMap<string, ModelCostBasisSnapshot>;
  providerRetryRuntime?: RunnerProviderRetryRuntime;
  maxTurns?: number;
  clock?: () => string;
}

export class NativeVerifierRuntime {
  private readonly candidateById: Map<string, AgentRuntimeCandidate>;
  private readonly clock: () => string;

  constructor(private readonly options: NativeVerifierRuntimeOptions) {
    if (options.workspaceManager.workspaceKind !== "independent-verifier") {
      throw new Error("Native verifier requires an independent verifier workspace.");
    }
    this.candidateById = new Map(
      options.candidates.map((candidate) => [candidate.runtimeId, candidate])
    );
    this.clock = options.clock ?? (() => new Date().toISOString());
  }

  async inspect(
    request: NativeVerifierInspectionRequest
  ): Promise<NativeVerifierInspectionResult> {
    assertInspectionRequest(request);
    const authorRuntimeIds = [
      ...new Set(request.changes.map((change) => change.authorRuntimeId)),
    ];
    const selection = this.options.router.selectVerifier({
      requiredCapabilities: ["code"],
      candidateRuntimeIds: this.options.verifierRuntimeIds,
      architectRuntimeId: request.architectRuntimeId,
      acceptedChangeAuthorRuntimeIds: authorRuntimeIds,
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
      request.targetRevision
    );
    if (workspace.targetRevision !== request.targetRevision) {
      throw new Error(
        "Verifier workspace target revision does not match the requested integration revision."
      );
    }
    const context = buildVerifierContext({
      limits: this.options.contextLimits ?? {
        maxBytes: 512 * 1024,
        maxEstimatedTokens: 128 * 1024,
      },
      objective: request.objective,
      targetRevision: request.targetRevision,
      criteria: request.criteria,
      reviews: request.reviews,
      guidance: request.guidance,
      changes: request.changes,
      finalVerification: request.finalVerification,
      riskReasons: request.riskReasons,
    });
    const sessionId = verifierSessionId(
      request.runId,
      request.targetRevision,
      candidate.runtimeId,
      context.digest
    );
    const systemMessage: AgentMessage = {
      id: "verifier-system",
      role: "system",
      content: VERIFIER_AUTHORITY_INVARIANTS,
    };
    const contextMessage: AgentMessage = {
      id: `verifier-context:${context.digest}`,
      role: "user",
      content: context.text,
    };
    let messages: AgentMessage[] = [systemMessage, contextMessage];
    const sessionEvents = this.options.sessions.events(sessionId);
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
        throw new Error("Recovered verifier session identity does not match the request.");
      }
      if (recovered.checkpoint) messages = [...recovered.checkpoint.messages];
      if (recovered.status === "completed") {
        return inspectedResult(
          sessionId,
          candidate.runtimeId,
          request.targetRevision,
          messages,
          true
        );
      }
      if (!messages.some((message) => message.id === contextMessage.id)) {
        messages.push(contextMessage);
      }
    }

    const broker = createInspectionTools({
      workspacePath: workspace.path,
      artifacts: this.options.artifacts,
      evidenceStore: this.options.evidenceStore,
      runId: request.runId,
      clock: this.clock,
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

    if (
      result.status === "suspended" &&
      result.reason === "model_ended_without_lifecycle"
    ) {
      this.options.router.recordSuccess(candidate.runtimeId);
      this.options.sessions.complete(sessionId, this.clock());
      return inspectedResult(
        sessionId,
        candidate.runtimeId,
        request.targetRevision,
        result.messages,
        false
      );
    }
    if (result.status === "suspended") {
      if (result.reason === "provider_error") {
        this.options.router.recordFailure(
          candidate.runtimeId,
          classifyProviderFailure({
            ...result.providerError,
            message: result.error ?? "Verifier provider failed.",
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
        targetRevision: request.targetRevision,
        reason: result.reason,
        ...(result.error ? { error: result.error } : {}),
        messages: result.messages,
      };
    }

    const reason = `unexpected_verifier_lifecycle:${result.status}`;
    this.options.sessions.suspend(sessionId, reason, undefined, this.clock());
    return {
      status: "suspended",
      sessionId,
      runtimeId: candidate.runtimeId,
      targetRevision: request.targetRevision,
      reason,
      messages: result.messages,
    };
  }
}

export function verifierModelAttribution(
  candidate: AgentRuntimeCandidate,
  sessionId: string
): ModelCallAttribution {
  return {
    runtimeId: candidate.runtimeId,
    providerId: candidate.providerId,
    modelId: candidate.modelId,
    role: "verifier",
    sessionId,
  };
}

function createInspectionTools(input: {
  workspacePath: string;
  artifacts: ArtifactStore;
  evidenceStore: EvidenceStore;
  runId: string;
  clock: () => string;
  ledger?: ToolInvocationLedger;
}): ToolBroker {
  const broker = new ToolBroker({
    permissionProfile: "guarded",
    workspacePath: input.workspacePath,
    artifacts: input.artifacts,
    clock: input.clock,
    ...(input.ledger ? { ledger: input.ledger } : {}),
  });
  const repository = new RepositoryIntelligence();
  const tools = [
    ...createFilesystemTools({
      artifacts: input.artifacts,
      repository,
    }),
    ...createGitTools(),
    ...createArtifactTools(input.artifacts),
    ...createEvidenceTools({
      store: input.evidenceStore,
      artifacts: input.artifacts,
      taskId: "verifier",
      clock: input.clock,
    }).filter((tool) => tool.definition.name === "inspect_evidence"),
  ].filter(
    (tool) =>
      tool.definition.readOnly &&
      tool.definition.effect === "none" &&
      tool.definition.lifecycle !== true &&
      tool.definition.name !== "git.remotes"
  );
  for (const tool of tools) {
    assertReadOnlyInspectionDefinition(tool.definition);
    broker.register(tool);
  }
  return broker;
}

function assertReadOnlyInspectionDefinition(definition: ToolDefinition): void {
  if (
    !definition.readOnly ||
    definition.effect !== "none" ||
    definition.lifecycle === true
  ) {
    throw new Error(
      `Verifier inspection tool ${definition.name} exceeds read-only authority.`
    );
  }
}

function assertInspectionRequest(request: NativeVerifierInspectionRequest): void {
  if (!request.runId.trim() || !request.objective.trim()) {
    throw new Error("Verifier inspection identity and objective are required.");
  }
  if (!REVISION_PATTERN.test(request.targetRevision)) {
    throw new Error("Verifier integration revision is invalid.");
  }
  if (
    !request.finalVerification.generationId.trim() ||
    request.finalVerification.targetRevision !== request.targetRevision
  ) {
    throw new Error(
      "Final-verification facts must target the verifier integration revision."
    );
  }
  if (request.criteria.length === 0) {
    throw new Error("Verifier inspection requires build criteria.");
  }
  const criterionKeys = new Set<string>();
  for (const item of request.criteria) {
    if (!item.taskId.trim() || !item.taskTitle.trim()) {
      throw new Error("Verifier criteria require task identity and title.");
    }
    assertAcceptanceCriteria([item.criterion]);
    const key = `${item.taskId}\u0000${item.criterion.id}`;
    if (criterionKeys.has(key)) {
      throw new Error(
        `Duplicate verifier criterion ${item.taskId}:${item.criterion.id}.`
      );
    }
    criterionKeys.add(key);
  }
  for (const change of request.changes) {
    if (
      !change.taskId.trim() ||
      !change.changeSetId.trim() ||
      !change.authorRuntimeId.trim() ||
      !REVISION_PATTERN.test(change.baselineRevision) ||
      !REVISION_PATTERN.test(change.taskRevision) ||
      !ARTIFACT_PATTERN.test(change.diffArtifactHash)
    ) {
      throw new Error("Verifier accepted change history is invalid.");
    }
  }
  if (request.riskReasons.length === 0) {
    throw new Error("High-risk verifier inspection requires durable risk reasons.");
  }
}

function verifierSessionId(
  runId: string,
  targetRevision: string,
  runtimeId: string,
  contextDigest: string
): string {
  const digest = createHash("sha256")
    .update(JSON.stringify([runId, targetRevision, runtimeId, contextDigest]))
    .digest("hex")
    .slice(0, 24);
  return `verifier:${runId}:${digest}`;
}

function inspectedResult(
  sessionId: string,
  runtimeId: string,
  targetRevision: string,
  messages: readonly AgentMessage[],
  replayed: boolean
): NativeVerifierInspectionResult {
  return {
    status: "inspected",
    sessionId,
    runtimeId,
    targetRevision,
    messages: [...messages],
    summary: finalAssistantText(messages),
    replayed,
  };
}

function finalAssistantText(messages: readonly AgentMessage[]): string {
  const message = [...messages].reverse().find((item) => item.role === "assistant");
  if (!message || !Array.isArray(message.content)) return "";
  return message.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n")
    .trim();
}
