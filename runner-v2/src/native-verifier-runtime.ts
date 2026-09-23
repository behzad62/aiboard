import type { ExecutionGrantAuthority } from "./execution-grants.js";
import type { RunGitExecutionContext } from "./git-run-context.js";
import { createHash } from "node:crypto";

import type {
  AgentMessage,
  AgentModel,
  NativeTool,
} from "./agent-contracts.js";
import { runAgentLoop } from "./agent-loop.js";
import {
  buildVerifierContext,
  buildVerifierExpectationsContext,
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
import { recordContextPack, type ContextManifestStore } from "./context-manifest-store.js";
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
import {
  assertRoleToolSurface,
  staticToolAdmitted,
  type RoleCapabilityBroker,
  type RoleCapabilityRole,
} from "./role-capabilities.js";
import { ToolBroker } from "./tool-broker.js";
import type { ToolInvocationLedger } from "./tool-ledger.js";
import type { VerificationWorkspace } from "./verification-workspace.js";
import {
  canonicalModelIdentity,
  type VerifierExcludedModel,
  type VerifierReviewProjection,
  type VerifierVerdictProjection,
} from "./verifier-contracts.js";
import type { VerifierVerdictAuthority } from "./verifier-verdict-authority.js";
import {
  createRecordVerificationExpectationsTool,
  createSubmitVerifierVerdictTool,
} from "./verifier-tools.js";

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
  readonly baselineRevision?: string;
  readonly twoPass?: boolean;
  readonly preferredRuntimeId?: string;
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
      readonly status: "verdict_submitted";
      readonly sessionId: string;
      readonly runtimeId: string;
      readonly targetRevision: string;
      readonly reviewId: string;
      readonly verdict: VerifierVerdictProjection;
      readonly messages: readonly AgentMessage[];
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
  createBaseline(baselineRevision: string): Promise<VerificationWorkspace>;
  cleanupBaseline(): Promise<void>;
}

export interface NativeVerifierRuntimeOptions {
  git?: RunGitExecutionContext;
  executionGrants?: ExecutionGrantAuthority;
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
  verdictAuthority?: VerifierVerdictAuthority;
  contextManifests?: ContextManifestStore;
  recordContextPackText?: boolean;
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
    if (
      request.preferredRuntimeId &&
      !this.options.verifierRuntimeIds.includes(request.preferredRuntimeId)
    ) {
      throw new Error(
        `Preferred verifier runtime ${request.preferredRuntimeId} is not configured for this Build.`,
      );
    }
    const excludedRuntimeIds = new Set<string>();
    const pendingReview = this.options.verdictAuthority?.currentReview(request.runId);
    if (
      !request.preferredRuntimeId &&
      pendingReview?.status === "requested"
    ) {
      try {
        const pendingSession = await this.options.sessions.load(
          pendingReview.runtime.sessionId,
        );
        if (
          pendingSession.status === "suspended" &&
          pendingSession.suspensionReason === "provider_error"
        ) {
          excludedRuntimeIds.add(pendingReview.runtime.runtimeId);
        }
      } catch {
        // A crash may persist the review request before session creation. In
        // that window the same runtime must recover the exact pending review.
      }
    }
    const selection = this.options.router.selectVerifier({
      requiredCapabilities: ["code"],
      candidateRuntimeIds: request.preferredRuntimeId
        ? [request.preferredRuntimeId]
        : this.options.verifierRuntimeIds,
      architectRuntimeId: request.architectRuntimeId,
      acceptedChangeAuthorRuntimeIds: authorRuntimeIds,
      excludedRuntimeIds,
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
    const contextLimits = this.options.contextLimits ?? {
      maxBytes: 512 * 1024,
      maxEstimatedTokens: 128 * 1024,
    };
    const baseContext = buildVerifierContext({
      limits: contextLimits,
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
      baseContext.digest,
      this.options.verdictAuthority ? "verdict" : "inspection",
    );
    const excludedModels = this.options.verdictAuthority
      ? verifierExcludedModels(
          this.candidateById,
          request.architectRuntimeId,
          authorRuntimeIds,
        )
      : [];
    let durableReview = this.options.verdictAuthority
      ? this.options.verdictAuthority.requestReview({
          runId: request.runId,
          reviewId: verifierReviewId(
            request.runId,
            request.targetRevision,
            request.finalVerification.generationId,
            sessionId,
          ),
          targetRevision: request.targetRevision,
          finalVerificationGenerationId:
            request.finalVerification.generationId,
          runtime: {
            runtimeId: candidate.runtimeId,
            providerId: candidate.providerId,
            modelId: candidate.modelId,
            modelIdentity: canonicalModelIdentity(candidate.modelId),
            sessionId,
          },
          excludedModels,
          criteria: request.criteria.map((item) => ({
            taskId: item.taskId,
            criterionId: item.criterion.id,
          })),
          ...(request.twoPass === true ? { twoPass: true } : {}),
          ...(request.baselineRevision
            ? { baselineRevision: request.baselineRevision }
            : {}),
          occurredAt: this.clock(),
        })
      : undefined;
    if (durableReview) {
      assertBoundVerifierReview({
        review: durableReview,
        request,
        candidate,
        sessionId,
        excludedModels,
      });
    }
    if (
      request.twoPass === true &&
      durableReview &&
      !durableReview.expectations
    ) {
      const passOne = await this.runExpectationsPass({
        request,
        candidate,
        model,
        review: durableReview,
      });
      if (passOne) return passOne;
      durableReview = this.options.verdictAuthority?.currentReview(request.runId);
      if (!durableReview?.expectations) {
        throw new Error("Verifier expectations were not durable after pass 1.");
      }
    }
    const context = buildVerifierContext({
      limits: contextLimits,
      objective: request.objective,
      targetRevision: request.targetRevision,
      criteria: request.criteria,
      reviews: request.reviews,
      guidance: request.guidance,
      changes: request.changes,
      finalVerification: request.finalVerification,
      riskReasons: request.riskReasons,
      ...(durableReview?.expectations
        ? { expectations: durableReview.expectations }
        : {}),
    });
    await recordContextPack({
      store: this.options.contextManifests,
      artifacts: this.options.artifacts,
      recordPackText: this.options.recordContextPackText,
      runId: request.runId,
      sessionId,
      actor: { role: "verifier", id: candidate.runtimeId },
      role: "verifier",
      purpose: this.options.verdictAuthority ? "verifier:verdict" : "verifier:inspection",
      repositoryRevision: request.targetRevision,
      limits: contextLimits,
      pack: context,
      recordedAt: this.clock(),
    });
    const systemMessage: AgentMessage = {
      id: "verifier-system",
      role: "system",
      content: durableReview
        ? [
            VERIFIER_AUTHORITY_INVARIANTS,
            "Inspect the exact revision, then finish by calling submit_verifier_verdict exactly once with every protected task/criterion pair, a satisfied or unsatisfied verdict, a non-empty rationale, and durable evidence IDs. The kernel derives the overall result.",
          ].join("\n")
        : VERIFIER_AUTHORITY_INVARIANTS,
    };
    const contextMessage: AgentMessage = {
      id: `verifier-context:${context.digest}`,
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
        throw new Error("Recovered verifier session identity does not match the request.");
      }
      if (recovered.checkpoint) messages = [...recovered.checkpoint.messages];
      recoveredCompleted = recovered.status === "completed";
      if (!messages.some((message) => message.id === contextMessage.id)) {
        messages.push(contextMessage);
      }
    }

    if (durableReview?.status === "submitted" && durableReview.verdict) {
      this.options.sessions.complete(sessionId, this.clock());
      return verdictSubmittedResult(
        durableReview,
        durableReview.verdict,
        messages,
        candidate.runtimeId,
        true,
      );
    }
    if (recoveredCompleted) {
      if (durableReview) {
        throw new Error(
          "Completed verifier session has no durable typed verdict.",
        );
      }
      return inspectedResult(
        sessionId,
        candidate.runtimeId,
        request.targetRevision,
        messages,
        true,
      );
    }

    const broker = createVerifierReviewBroker({
      git: this.options.git, executionGrants: this.options.executionGrants,
      workspacePath: workspace.path,
      artifacts: this.options.artifacts,
      evidenceStore: this.options.evidenceStore,
      runId: request.runId,
      clock: this.clock,
      ...(durableReview && this.options.verdictAuthority
        ? {
            lifecycleTool: createSubmitVerifierVerdictTool({
              authority: this.options.verdictAuthority,
              runId: request.runId,
              reviewId: durableReview.reviewId,
              targetRevision: durableReview.targetRevision,
              runtimeId: candidate.runtimeId,
              sessionId,
              clock: this.clock,
            }),
          }
        : {}),
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

    if (result.status === "verifier_verdict_submitted") {
      const submitted = this.options.verdictAuthority?.currentReview(
        request.runId,
      );
      if (
        !submitted?.verdict ||
        submitted.status !== "submitted" ||
        submitted.reviewId !== result.reviewId ||
        submitted.runtime.runtimeId !== candidate.runtimeId ||
        submitted.runtime.sessionId !== sessionId ||
        submitted.targetRevision !== request.targetRevision
      ) {
        throw new Error(
          "Verifier lifecycle returned before its exact typed verdict was durable.",
        );
      }
      this.options.router.recordSuccess(candidate.runtimeId);
      this.options.sessions.complete(sessionId, this.clock());
      return verdictSubmittedResult(
        submitted,
        submitted.verdict,
        result.messages,
        candidate.runtimeId,
        false,
      );
    }
    if (
      !this.options.verdictAuthority &&
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

  private async runExpectationsPass(input: {
    request: NativeVerifierInspectionRequest;
    candidate: AgentRuntimeCandidate;
    model: AgentModel;
    review: VerifierReviewProjection;
  }): Promise<NativeVerifierInspectionResult | undefined> {
    const { request, candidate, model, review } = input;
    const baselineRevision = request.baselineRevision;
    if (!baselineRevision) {
      throw new Error("Two-pass verifier inspection requires a baseline revision.");
    }
    const baseline = await this.options.workspaceManager.createBaseline(baselineRevision);
    if (baseline.targetRevision !== baselineRevision) {
      throw new Error(
        "Verifier baseline workspace revision does not match the requested baseline.",
      );
    }
    const contextLimits = this.options.contextLimits ?? {
      maxBytes: 512 * 1024,
      maxEstimatedTokens: 128 * 1024,
    };
    const context = buildVerifierExpectationsContext({
      limits: contextLimits,
      objective: request.objective,
      baselineRevision,
      targetRevision: request.targetRevision,
      criteria: request.criteria,
      guidance: request.guidance,
      riskReasons: request.riskReasons,
    });
    const sessionId = verifierSessionId(
      request.runId,
      baselineRevision,
      candidate.runtimeId,
      context.digest,
      "expectations",
    );
    await recordContextPack({
      store: this.options.contextManifests,
      artifacts: this.options.artifacts,
      recordPackText: this.options.recordContextPackText,
      runId: request.runId,
      sessionId,
      actor: { role: "verifier", id: candidate.runtimeId },
      role: "verifier",
      purpose: "verifier:expectations",
      repositoryRevision: baselineRevision,
      limits: contextLimits,
      pack: context,
      recordedAt: this.clock(),
    });
    const systemMessage: AgentMessage = {
      id: "verifier-expectations-system",
      role: "system",
      content: [
        "You are inspecting the BASELINE revision: the repository as it was before this build's changes.",
        "No diff, review, or verification result is available yet.",
        "Derive expectations from the criteria and the existing code and tests, then call record_verification_expectations exactly once.",
      ].join("\n"),
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
        throw new Error("Recovered verifier expectations session identity does not match the request.");
      }
      if (recovered.checkpoint) messages = [...recovered.checkpoint.messages];
      if (!messages.some((message) => message.id === contextMessage.id)) {
        messages.push(contextMessage);
      }
    }
    const authority = this.options.verdictAuthority;
    if (!authority) {
      throw new Error("Two-pass verification requires a verdict authority.");
    }
    const broker = createVerifierExpectationsBroker({
      git: this.options.git,
      executionGrants: this.options.executionGrants,
      workspacePath: baseline.path,
      artifacts: this.options.artifacts,
      evidenceStore: this.options.evidenceStore,
      runId: request.runId,
      clock: this.clock,
      excludeToolNames: REVISION_REACHING_GIT_TOOLS,
      lifecycleTool: createRecordVerificationExpectationsTool({
        authority,
        runId: request.runId,
        reviewId: review.reviewId,
        targetRevision: review.targetRevision,
        baselineRevision,
        runtimeId: candidate.runtimeId,
        sessionId,
        criteria: review.criteria,
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
          estimateCostMicros: this.options.modelCostEstimators?.get(candidate.runtimeId),
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
        workspacePath: baseline.path,
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
    if (result.status === "verifier_expectations_recorded") {
      const recorded = authority.currentReview(request.runId);
      if (
        !recorded?.expectations ||
        recorded.expectationsSessionId !== sessionId ||
        recorded.reviewId !== result.reviewId
      ) {
        throw new Error("Verifier expectations were not durable after pass 1.");
      }
      this.options.sessions.complete(sessionId, this.clock());
      await this.options.workspaceManager.cleanupBaseline();
      return undefined;
    }
    if (result.status === "suspended") {
      if (result.reason === "provider_error") {
        this.options.router.recordFailure(
          candidate.runtimeId,
          classifyProviderFailure({
            ...result.providerError,
            message: result.error ?? "Verifier provider failed.",
          }),
        );
      }
      this.options.sessions.suspend(
        sessionId,
        result.reason,
        result.error,
        this.clock(),
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

const REVISION_REACHING_GIT_TOOLS = ["git.diff", "git.log", "git.show"] as const;

export interface InspectionToolsInput {
  git?: RunGitExecutionContext;
  executionGrants?: ExecutionGrantAuthority;
  workspacePath: string;
  artifacts: ArtifactStore;
  evidenceStore?: EvidenceStore;
  runId: string;
  clock: () => string;
  ledger?: ToolInvocationLedger;
  lifecycleTool?: NativeTool<unknown>;
  excludeToolNames?: readonly string[];
  capabilityRole: RoleCapabilityRole;
  capabilityBroker: RoleCapabilityBroker;
  probeTools?: readonly NativeTool<unknown>[];
}

export function createVerifierReviewBroker(
  input: Omit<InspectionToolsInput, "capabilityRole" | "capabilityBroker">,
): ToolBroker {
  const broker = createInspectionTools({
    ...input,
    capabilityRole: "verifier",
    capabilityBroker: "inspection",
  });
  assertRoleToolSurface(
    "verifier",
    "inspection",
    broker.definitions().map((definition) => definition.name),
  );
  return broker;
}

export function createVerifierExpectationsBroker(
  input: Omit<InspectionToolsInput, "capabilityRole" | "capabilityBroker">,
): ToolBroker {
  const broker = createInspectionTools({
    ...input,
    capabilityRole: "verifier",
    capabilityBroker: "expectations",
  });
  assertRoleToolSurface(
    "verifier",
    "expectations",
    broker.definitions().map((definition) => definition.name),
  );
  return broker;
}

export function createInspectionTools(input: InspectionToolsInput): ToolBroker {
  const broker = new ToolBroker({
    git: input.git, executionGrants: input.executionGrants,
    permissionProfile: "guarded",
    workspacePath: input.workspacePath,
    artifacts: input.artifacts,
    clock: input.clock,
    ...(input.ledger ? { ledger: input.ledger } : {}),
  });
  const repository = new RepositoryIntelligence(input.git ? (request) => input.git!.current().run(request) : undefined);
  const excludedToolNames = new Set<string>(["git.remotes", ...(input.excludeToolNames ?? [])]);
  const tools = [
    ...createFilesystemTools({
      artifacts: input.artifacts,
      repository,
    }),
    ...createGitTools(input.git),
    ...createArtifactTools(input.artifacts),
    ...(input.evidenceStore
      ? createEvidenceTools({
          git: input.git,
          store: input.evidenceStore,
          artifacts: input.artifacts,
          taskId: "verifier",
          clock: input.clock,
        })
      : []),
  ];
  for (const tool of tools) {
    if (excludedToolNames.has(tool.definition.name)) continue;
    if (staticToolAdmitted(input.capabilityRole, input.capabilityBroker, tool.definition.name)) {
      broker.register(tool);
    }
  }
  if (input.lifecycleTool) broker.register(input.lifecycleTool);
  for (const tool of input.probeTools ?? []) broker.register(tool);
  return broker;
}

function assertInspectionRequest(request: NativeVerifierInspectionRequest): void {
  if (!request.runId.trim() || !request.objective.trim()) {
    throw new Error("Verifier inspection identity and objective are required.");
  }
  if (!REVISION_PATTERN.test(request.targetRevision)) {
    throw new Error("Verifier integration revision is invalid.");
  }
  if (request.twoPass === true) {
    if (!request.baselineRevision || !REVISION_PATTERN.test(request.baselineRevision)) {
      throw new Error("Two-pass verifier inspection requires a baseline revision.");
    }
  } else if (
    request.baselineRevision !== undefined &&
    !REVISION_PATTERN.test(request.baselineRevision)
  ) {
    throw new Error("Verifier baseline revision is invalid.");
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
  contextDigest: string,
  mode: "inspection" | "verdict" | "expectations",
): string {
  const digest = createHash("sha256")
    .update(JSON.stringify([runId, targetRevision, runtimeId, contextDigest, mode]))
    .digest("hex")
    .slice(0, 24);
  return `verifier:${runId}:${digest}`;
}

function verifierReviewId(
  runId: string,
  targetRevision: string,
  finalVerificationGenerationId: string,
  sessionId: string,
): string {
  const digest = createHash("sha256")
    .update(JSON.stringify([
      runId,
      targetRevision,
      finalVerificationGenerationId,
      sessionId,
    ]))
    .digest("hex");
  return `verifier-review:${digest}`;
}

export function verifierExcludedModels(
  candidates: ReadonlyMap<string, AgentRuntimeCandidate>,
  architectRuntimeId: string,
  authorRuntimeIds: readonly string[],
): VerifierExcludedModel[] {
  const architect = candidates.get(architectRuntimeId);
  if (!architect) {
    throw new Error(`Unknown Architect runtime ${architectRuntimeId}.`);
  }
  const excluded: VerifierExcludedModel[] = [{
    source: "architect",
    runtimeId: architect.runtimeId,
    modelIdentity: canonicalModelIdentity(architect.modelId),
  }];
  for (const runtimeId of [...new Set(authorRuntimeIds)].sort()) {
    const author = candidates.get(runtimeId);
    if (!author) {
      throw new Error(`Unknown accepted change author runtime ${runtimeId}.`);
    }
    excluded.push({
      source: "accepted_change_author",
      runtimeId: author.runtimeId,
      modelIdentity: canonicalModelIdentity(author.modelId),
    });
  }
  return excluded;
}

function assertBoundVerifierReview(input: {
  review: VerifierReviewProjection;
  request: NativeVerifierInspectionRequest;
  candidate: AgentRuntimeCandidate;
  sessionId: string;
  excludedModels: readonly VerifierExcludedModel[];
}): void {
  const expectedCriteria = input.request.criteria
    .map((item) => ({
      taskId: item.taskId,
      criterionId: item.criterion.id,
    }))
    .sort((left, right) =>
      left.taskId.localeCompare(right.taskId) ||
      left.criterionId.localeCompare(right.criterionId),
    );
  const actualCriteria = input.review.criteria
    .map((criterion) => ({ ...criterion }))
    .sort((left, right) =>
      left.taskId.localeCompare(right.taskId) ||
      left.criterionId.localeCompare(right.criterionId),
    );
  if (
    input.review.targetRevision !== input.request.targetRevision ||
    input.review.finalVerificationGenerationId !==
      input.request.finalVerification.generationId ||
    input.review.runtime.runtimeId !== input.candidate.runtimeId ||
    input.review.runtime.providerId !== input.candidate.providerId ||
    input.review.runtime.modelId !== input.candidate.modelId ||
    input.review.runtime.modelIdentity !==
      canonicalModelIdentity(input.candidate.modelId) ||
    input.review.runtime.sessionId !== input.sessionId ||
    (input.request.twoPass === true) !== (input.review.twoPass === true) ||
    (input.request.baselineRevision ?? undefined) !== input.review.baselineRevision ||
    JSON.stringify(actualCriteria) !== JSON.stringify(expectedCriteria) ||
    JSON.stringify(input.review.excludedModels) !==
      JSON.stringify(input.excludedModels)
  ) {
    throw new Error(
      "Durable verifier review conflicts with its kernel-selected revision, identity, or criteria.",
    );
  }
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

function verdictSubmittedResult(
  review: VerifierReviewProjection,
  verdict: VerifierVerdictProjection,
  messages: readonly AgentMessage[],
  runtimeId: string,
  replayed: boolean,
): NativeVerifierInspectionResult {
  return {
    status: "verdict_submitted",
    sessionId: review.runtime.sessionId,
    runtimeId,
    targetRevision: review.targetRevision,
    reviewId: review.reviewId,
    verdict: structuredClone(verdict),
    messages: [...messages],
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
