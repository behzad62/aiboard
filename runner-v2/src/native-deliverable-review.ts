import { createHash } from "node:crypto";

import type {
  AgentMessage,
  AgentModel,
  NativeTool,
  ToolCallBlock,
  ToolExecutionContext,
  ToolExecutionOutput,
  ToolResult,
} from "./agent-contracts.js";
import { runAgentLoop, type AgentLoopResult } from "./agent-loop.js";
import { RUNNER_KERNEL_INVARIANTS } from "./agent-prompts.js";
import type { ArtifactStore } from "./artifact-store.js";
import type { BudgetLedger, ModelCostBasisSnapshot } from "./budget-ledger.js";
import { BudgetedAgentModel, type ModelCostEstimator } from "./budgeted-model.js";
import { BudgetedToolRuntime } from "./budgeted-tool-runtime.js";
import {
  ContextAssembler,
  ProtectedContextOverflowError,
  type ContextLimits,
  type ContextPack,
  type ContextSection,
} from "./context-assembler.js";
import { recordContextPack, type ContextManifestStore } from "./context-manifest-store.js";
import {
  DELIVERY_REVIEW_RUNNER_ID,
  assessDeliveryRisk,
  currentSubmissionReview,
  deliveryReviewDepthForTier,
  deliveryReviewId,
  diffLineCounts,
  latestCompletedReview,
  taskAcceptedFailuresUsed,
  type DeliveryAffectedTestsRecord,
  type DeliveryClaim,
  type DeliveryProbeRecord,
  type DeliveryReviewRecord,
  type DeliveryReviewTier,
} from "./delivery-acceptance.js";
import type { EvidenceStore } from "./evidence-store.js";
import type { ExecutionGrantAuthority } from "./execution-grants.js";
import type { RunGitExecutionContext } from "./git-run-context.js";
import {
  LayeredToolRuntime,
  createInspectionTools,
  createVerifierCommandBroker,
  verifierModelAttribution,
} from "./native-verifier-runtime.js";
import type { OneShotCommandExecutor } from "./one-shot-command-executor.js";
import type { PermissionProfile } from "./contracts.js";
import type { SqlitePermissionStore } from "./permission-store.js";
import { PLANNING_FINDING_CATEGORIES } from "./planning-contracts.js";
import type { RunnerProviderRetryRuntime } from "./provider-call-retry.js";
import { classifyProviderFailure } from "./provider-health.js";
import { assertRoleToolSurface, type RoleCapabilityBroker } from "./role-capabilities.js";
import type { AgentRuntimeCandidate, RuntimeRouter } from "./runtime-router.js";
import {
  rebuildSchedulerProjection,
  type SchedulerProjection,
  type SchedulerStore,
} from "./scheduler-store.js";
import type { SqliteAgentSessionStore } from "./sqlite-agent-session-store.js";
import type { BuildTask } from "./task-contracts.js";
import type { ToolInvocationLedger } from "./tool-ledger.js";
import { ToolRegistry, type AgentToolRuntime } from "./tool-registry.js";
import {
  assertFreshContextRequest,
  assertFreshContextSessionStarted,
  canonicalModelIdentity,
  type ReviewerIndependence,
} from "./verifier-contracts.js";

/**
 * T6a (P6.6, OA-3/OA-4/OA-10/OA-11/OA-13): the mandatory independent
 * deliverable reviewer for new-policy runs.
 *
 * Inputs come only from durable state: the plan-contract acceptance criteria,
 * the submitted change set (its real diff bytes from the artifact store), and
 * the worker's submit_task summary and cited evidence ids as claims. The risk
 * tier is the deterministic T5 tier of the real change.
 *
 * The review is a sequence of kernel-controlled passes. Each pass runs in its
 * own new session and ends with a lifecycle tool that writes one kernel event;
 * the next pass's context is built only after that event is durable:
 *
 *   A (high only): criteria only                 -> record_deliverable_obligations
 *   B: criteria (+obligations) + real diff + tools -> record_deliverable_findings
 *   C: + worker report and claims (+ prior findings) -> submit_deliverable_verdict
 *
 * At high tier the runtime (not the model) runs the affected-test command and
 * the OA-11 probe through the audited executor before pass B and attaches
 * their records to the findings event. Every medium/high findings event
 * carries the count of real inspection tool calls the reviewer made.
 */

export interface DeliverableReviewInputs {
  taskId: string;
  attempt: number;
  changeSetId: string;
  baselineRevision: string;
  taskRevision: string;
  diffArtifactHash: string;
  diffText: string;
  changedPaths: string[];
  objective: string;
  criteria: { id: string; text: string }[];
  workerSummary: string;
  unresolvedConcerns: string[];
  claims: DeliveryClaim[];
  authorRuntimeId: string;
}

export class DeliverableReviewInputsUnavailableError extends Error {}

export interface DeliveryReviewWorkspace {
  create(taskRevision: string): Promise<{ path: string }>;
  cleanup(): Promise<void>;
}

/** High-tier depth work the runtime performs through the audited executor. */
export interface DeliveryDepthRunner {
  run(input: {
    runId: string;
    taskId: string;
    reviewId: string;
    sessionId: string;
    reviewerRuntimeId: string;
    workspacePath: string;
    taskRevision: string;
    baselineRevision: string;
    changedFiles: readonly string[];
    diffText: string;
    signal?: AbortSignal;
  }): Promise<{ affectedTests: DeliveryAffectedTestsRecord; probe: DeliveryProbeRecord }>;
}

export interface NativeDeliverableReviewRuntimeOptions {
  store: SchedulerStore;
  architectRuntimeId: string;
  git?: RunGitExecutionContext;
  executionGrants?: ExecutionGrantAuthority;
  execution?: OneShotCommandExecutor;
  permissionProfile?: PermissionProfile;
  permissions?: SqlitePermissionStore;
  router: Pick<RuntimeRouter, "selectVerifier">;
  candidates: readonly AgentRuntimeCandidate[];
  models: ReadonlyMap<string, AgentModel>;
  reviewerRuntimeIds: readonly string[];
  sessions: SqliteAgentSessionStore;
  artifacts: ArtifactStore;
  evidenceStore: EvidenceStore;
  loadInputs(input: { runId: string; task: BuildTask; projection: SchedulerProjection }): Promise<DeliverableReviewInputs>;
  workspace: DeliveryReviewWorkspace;
  depth: DeliveryDepthRunner;
  budgetLedger?: BudgetLedger;
  ledger?: ToolInvocationLedger;
  modelCostEstimators?: ReadonlyMap<string, ModelCostEstimator>;
  modelCostBases?: ReadonlyMap<string, ModelCostBasisSnapshot>;
  outputTokenReserve?: number;
  contextManifests?: ContextManifestStore;
  recordContextPackText?: boolean;
  contextLimits?: ContextLimits;
  maxTurns?: number;
  providerRetryRuntime?: RunnerProviderRetryRuntime;
  clock?: () => string;
}

export interface NativeDeliverableReviewRequest {
  runId: string;
  taskId: string;
  signal?: AbortSignal;
  providerRetryDeadlineMs?: number;
}

export type NativeDeliverableReviewResult =
  | {
      readonly status: "reviewed";
      readonly reviewId: string;
      readonly runtimeId: string;
      readonly independence: ReviewerIndependence;
      readonly tier: DeliveryReviewTier;
      readonly replayed: boolean;
    }
  | {
      readonly status: "unavailable";
      readonly reviewId?: string;
      readonly reason: string;
      readonly detail?: string;
      readonly runtimeId?: string;
    }
  | {
      readonly status: "suspended";
      readonly reviewId: string;
      readonly reason: string;
      readonly runtimeId: string;
      readonly error?: string;
    };

type Pass = "obligations" | "findings" | "verdict";

/** Session identity per (review, pass, runtime, independence); the review id carries the durable generation. */
export function deliverySessionId(
  runId: string,
  reviewId: string,
  pass: Pass,
  runtimeId: string,
  independence: ReviewerIndependence,
): string {
  const digest = createHash("sha256")
    .update(JSON.stringify([runId, reviewId, pass, runtimeId, independence]))
    .digest("hex")
    .slice(0, 24);
  return `delivery:${runId}:${digest}`;
}

export class NativeDeliverableReviewRuntime {
  private readonly clock: () => string;
  private readonly candidateById: Map<string, AgentRuntimeCandidate>;

  constructor(private readonly options: NativeDeliverableReviewRuntimeOptions) {
    this.clock = options.clock ?? (() => new Date().toISOString());
    this.candidateById = new Map(options.candidates.map((candidate) => [candidate.runtimeId, candidate]));
  }

  async review(request: NativeDeliverableReviewRequest): Promise<NativeDeliverableReviewResult> {
    const projection = this.projection(request.runId);
    const task = projection.tasks[request.taskId];
    if (!task || task.status !== "submitted" || !task.changeSetId || projection.planningPolicyVersion !== 1) {
      throw new Error(`Deliverable review requires a submitted new-policy task ${request.taskId}.`);
    }
    const existing = currentSubmissionReview(projection.delivery, task);
    if (existing?.stage === "completed") {
      return {
        status: "reviewed",
        reviewId: existing.reviewId,
        runtimeId: existing.reviewerRuntimeId!,
        independence: existing.independence!,
        tier: existing.risk!.tier,
        replayed: true,
      };
    }
    let inputs: DeliverableReviewInputs;
    try {
      inputs = await this.options.loadInputs({ runId: request.runId, task, projection });
      assertInputs(inputs, task);
    } catch (error) {
      return { status: "unavailable", reason: "delivery_inputs_unavailable", detail: message(error) };
    }
    const architectRuntimeId = projection.runtime.architect.runtimeId ?? this.options.architectRuntimeId;
    const author = this.candidateById.get(inputs.authorRuntimeId);
    const architect = this.candidateById.get(architectRuntimeId);
    if (!author || !architect) {
      return {
        status: "unavailable",
        reason: "delivery_identity_unavailable",
        detail: `Author ${inputs.authorRuntimeId} or Architect ${architectRuntimeId} is not a configured runtime.`,
      };
    }
    const authorIdentity = canonicalModelIdentity(author.modelId);
    const generation = nextGeneration(projection, task.id);
    const reviewId = deliveryReviewId(task.id, task.attempt, generation);
    this.append(request.runId, "delivery.review_started", `${reviewId}:started`, {
      taskId: task.id,
      reviewId,
      generation,
      attempt: task.attempt,
      changeSetId: task.changeSetId,
      diffArtifactHash: inputs.diffArtifactHash,
      criteriaIds: inputs.criteria.map((criterion) => criterion.id),
      authorRuntimeId: inputs.authorRuntimeId,
      authorModelIdentity: authorIdentity,
      architectRuntimeId,
      architectModelIdentity: canonicalModelIdentity(architect.modelId),
    });
    const riskInput = {
      authorModelId: authorIdentity,
      changedFiles: [...inputs.changedPaths],
      ...diffLineCounts(inputs.diffText),
      attempts: task.attempt,
      // OA-4: a prior attempt's accepted evidence failure counts on a fix re-review.
      acceptedFailuresUsed: taskAcceptedFailuresUsed([
        ...(projection.reviewHistory?.[task.id] ?? []),
        ...(projection.reviews[task.id] ? [projection.reviews[task.id]!] : []),
      ]),
    };
    const risk = assessDeliveryRisk(riskInput);
    const authors = Object.keys(this.projection(request.runId).delivery?.authorModelIdentities ?? {});
    const selection = this.options.router.selectVerifier({
      requiredCapabilities: ["code"],
      candidateRuntimeIds: [...this.options.reviewerRuntimeIds],
      architectRuntimeId,
      acceptedChangeAuthorRuntimeIds: authors,
    });
    if (selection.status === "unavailable") {
      return { status: "unavailable", reviewId, reason: "delivery_reviewer_unavailable", detail: selection.reason };
    }
    const candidate = this.candidateById.get(selection.runtime.runtimeId);
    const model = this.options.models.get(selection.runtime.runtimeId);
    if (!candidate || !model) {
      return { status: "unavailable", reviewId, reason: "delivery_reviewer_unavailable", runtimeId: selection.runtime.runtimeId };
    }
    const independence = selection.independence;
    const prior = latestCompletedReview(this.projection(request.runId).delivery, task.id);
    this.append(request.runId, "delivery.review_requested", `${reviewId}:requested`, {
      taskId: task.id,
      reviewId,
      reviewerRuntimeId: candidate.runtimeId,
      reviewerModelIdentity: canonicalModelIdentity(candidate.modelId),
      independence,
      reviewTier: risk.tier,
      riskDigest: risk.digest,
      riskInput,
      ...(prior ? { priorReviewId: prior.reviewId } : {}),
    });
    const tier = risk.tier;
    const depth = deliveryReviewDepthForTier(tier);
    const context: PassContext = { request, reviewId, inputs, candidate, model, independence, tier };
    let workspace: { path: string } | undefined;
    try {
      if (depth.obligationsFirst) {
        const obligations = await this.runPass(context, "obligations", undefined);
        if (obligations) return obligations;
      }
      this.append(request.runId, "delivery.criteria_and_diff_delivered", `${reviewId}:diff`, {
        taskId: task.id,
        reviewId,
        diffArtifactHash: inputs.diffArtifactHash,
      });
      await this.options.workspace.cleanup();
      workspace = await this.options.workspace.create(inputs.taskRevision);
      if (depth.affectedTests) {
        try {
          context.depthRecords = await this.options.depth.run({
            runId: request.runId,
            taskId: task.id,
            reviewId,
            sessionId: deliverySessionId(request.runId, reviewId, "findings", candidate.runtimeId, independence),
            reviewerRuntimeId: candidate.runtimeId,
            workspacePath: workspace.path,
            taskRevision: inputs.taskRevision,
            baselineRevision: inputs.baselineRevision,
            changedFiles: inputs.changedPaths,
            diffText: inputs.diffText,
            ...(request.signal ? { signal: request.signal } : {}),
          });
        } catch (error) {
          return { status: "unavailable", reviewId, reason: "delivery_depth_unavailable", detail: message(error), runtimeId: candidate.runtimeId };
        }
      }
      const findings = await this.runPass(context, "findings", workspace.path);
      if (findings) return findings;
      this.append(request.runId, "delivery.report_delivered", `${reviewId}:report`, {
        taskId: task.id,
        reviewId,
        claims: inputs.claims.map((claim) => ({ ...claim, evidenceIds: [...claim.evidenceIds] })),
      });
      const verdict = await this.runPass(context, "verdict", workspace.path);
      if (verdict) return verdict;
    } finally {
      if (workspace) await this.options.workspace.cleanup().catch(() => undefined);
    }
    return { status: "reviewed", reviewId, runtimeId: candidate.runtimeId, independence, tier, replayed: false };
  }

  /** Runs one pass; returns a terminal result when the pass did not record its stage. */
  private async runPass(
    context: PassContext,
    pass: Pass,
    workspacePath: string | undefined,
  ): Promise<NativeDeliverableReviewResult | undefined> {
    const { request, reviewId, candidate, model, independence } = context;
    const limits = this.options.contextLimits ?? { maxBytes: 512 * 1024, maxEstimatedTokens: 128 * 1024 };
    let pack: ContextPack;
    try {
      pack = new ContextAssembler(limits).assemble(this.sections(context, pass));
    } catch (error) {
      if (error instanceof ProtectedContextOverflowError) {
        return { status: "unavailable", reviewId, reason: `delivery_${pass}_context_overflow`, detail: message(error), runtimeId: candidate.runtimeId };
      }
      throw error;
    }
    const sessionId = deliverySessionId(request.runId, reviewId, pass, candidate.runtimeId, independence);
    await recordContextPack({
      store: this.options.contextManifests,
      artifacts: this.options.artifacts,
      recordPackText: this.options.recordContextPackText,
      runId: request.runId,
      sessionId,
      actor: { role: "verifier", id: candidate.runtimeId },
      role: "verifier",
      purpose: `delivery:${pass}`,
      limits,
      pack,
      recordedAt: this.clock(),
    });
    const messages: AgentMessage[] = [
      { id: `delivery-${pass}-system`, role: "system", content: deliveryReviewerSystemPrompt(pass, context.tier) },
      { id: `context:${pack.digest}`, role: "user", content: pack.text },
    ];
    // Fresh-context device: every pass opens a new session whose event list
    // is empty, and its first request carries only the pack messages.
    assertFreshContextRequest({
      independence,
      priorEventCount: this.options.sessions.events(sessionId).length,
      messages,
      packMessageIds: messages.map((item) => item.id),
    });
    await this.options.sessions.create({
      sessionId,
      runId: request.runId,
      actor: { role: "verifier", id: candidate.runtimeId },
      occurredAt: this.clock(),
    });
    assertFreshContextSessionStarted(independence, this.options.sessions.events(sessionId));
    const counter = { calls: 0 };
    const tools = this.passTools(context, pass, sessionId, workspacePath, counter);
    const result = await runAgentLoop({
      model: this.budgetedModel(model, candidate, request.runId, sessionId),
      registry: tools,
      context: {
        runId: request.runId,
        sessionId,
        actor: { role: "verifier", id: candidate.runtimeId },
        ...(workspacePath ? { workspacePath } : {}),
        signal: request.signal,
      },
      initialMessages: messages,
      maxTurns: this.options.maxTurns ?? 24,
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
    const expectedStage: DeliveryReviewRecord["stage"] = pass === "obligations"
      ? "obligations_recorded"
      : pass === "findings" ? "findings_recorded" : "completed";
    const durable = this.projection(request.runId).delivery?.reviews[context.inputs.taskId];
    if (passEnded(result, pass, reviewId) && durable?.reviewId === reviewId && durable.stage === expectedStage) {
      this.options.sessions.complete(sessionId, this.clock());
      return undefined;
    }
    if (result.status === "suspended") {
      return {
        status: "suspended",
        reviewId,
        reason: result.reason,
        runtimeId: candidate.runtimeId,
        ...(result.error ? { error: result.error } : {}),
      };
    }
    return {
      status: "unavailable",
      reviewId,
      reason: `delivery_${pass}_incomplete`,
      detail: `The ${pass} pass ended with status ${result.status} and no durable ${expectedStage} stage.`,
      runtimeId: candidate.runtimeId,
    };
  }

  private sections(context: PassContext, pass: Pass): ContextSection[] {
    const { inputs } = context;
    const durable = this.projection(context.request.runId).delivery?.reviews[inputs.taskId];
    const sections: ContextSection[] = [
      section("kernel-invariants", "system", RUNNER_KERNEL_INVARIANTS),
      section("task-objective", "task", `Task ${inputs.taskId} objective:\n${inputs.objective}`),
      section(
        "acceptance-criteria",
        "criteria",
        `Plan-contract acceptance criteria (the source of truth):\n${inputs.criteria.map((criterion) => `- ${criterion.id}: ${criterion.text}`).join("\n")}`,
      ),
    ];
    if (pass === "obligations") return sections;
    if (durable?.obligations) {
      sections.push(section(
        "own-obligations",
        "obligations",
        `Obligations you recorded before seeing the diff:\n${JSON.stringify(durable.obligations, null, 2)}`,
      ));
    }
    sections.push(section(
      "submitted-diff",
      "diff",
      `Submitted change ${inputs.changeSetId} (baseline ${inputs.baselineRevision} -> task revision ${inputs.taskRevision}).\n` +
        `Changed files:\n${inputs.changedPaths.map((path) => `- ${path}`).join("\n")}\n\nUnified diff:\n${inputs.diffText}`,
    ));
    if (context.depthRecords) {
      sections.push(section(
        "runner-depth",
        "depth",
        `Runner-executed high-tier checks (audited; recorded with your findings):\n${JSON.stringify(context.depthRecords, null, 2)}`,
      ));
    }
    if (pass === "findings") return sections;
    sections.push(section(
      "own-findings",
      "own-findings",
      `Your durably recorded findings:\n${JSON.stringify(durable?.findings ?? [], null, 2)}`,
    ));
    sections.push(section(
      "worker-report",
      "report",
      `The worker's report (a claim, not evidence):\nSummary: ${inputs.workerSummary}\n` +
        `Unresolved concerns:\n${inputs.unresolvedConcerns.length > 0 ? inputs.unresolvedConcerns.map((item) => `- ${item}`).join("\n") : "- none"}`,
    ));
    sections.push(section(
      "worker-claims",
      "claims",
      `Worker claims to judge one by one (verified only when you confirmed it yourself):\n${JSON.stringify(inputs.claims, null, 2)}`,
    ));
    const prior = durable?.priorReviewId
      ? (this.projection(context.request.runId).delivery?.reviewHistory[inputs.taskId] ?? [])
          .find((review) => review.reviewId === durable.priorReviewId)
      : undefined;
    if (prior) {
      sections.push(section(
        "prior-findings",
        "prior-findings",
        `Prior review ${prior.reviewId} findings, released after your own findings were recorded. Check each one:\n${JSON.stringify(prior.findings ?? [], null, 2)}`,
      ));
    }
    return sections;
  }

  private passTools(
    context: PassContext,
    pass: Pass,
    sessionId: string,
    workspacePath: string | undefined,
    counter: { calls: number },
  ): AgentToolRuntime {
    const lifecycle: NativeTool<unknown> = pass === "obligations"
      ? createRecordDeliverableObligationsTool(this.lifecycleOptions(context, sessionId)) as NativeTool<unknown>
      : pass === "findings"
        ? createRecordDeliverableFindingsTool({
            ...this.lifecycleOptions(context, sessionId),
            depth: () => ({
              inspectionToolCalls: counter.calls,
              ...(context.depthRecords ? context.depthRecords : {}),
            }),
          }) as NativeTool<unknown>
        : createSubmitDeliverableVerdictTool(this.lifecycleOptions(context, sessionId)) as NativeTool<unknown>;
    let runtime: AgentToolRuntime;
    let broker: RoleCapabilityBroker;
    if (pass === "obligations") {
      broker = "delivery_obligations";
      const registry = new ToolRegistry();
      registry.register(lifecycle);
      runtime = registry;
    } else {
      const commands = pass === "findings" && deliveryReviewDepthForTier(context.tier).affectedTests;
      broker = commands ? "delivery_commands" : "delivery";
      const base = {
        git: this.options.git,
        executionGrants: this.options.executionGrants,
        workspacePath: workspacePath!,
        artifacts: this.options.artifacts,
        evidenceStore: this.options.evidenceStore,
        runId: context.request.runId,
        clock: this.clock,
        ...(this.options.ledger ? { ledger: this.options.ledger } : {}),
        ...(this.options.permissions ? { permissions: this.options.permissions } : {}),
      };
      const inspection = createInspectionTools({
        ...base,
        capabilityRole: "verifier",
        capabilityBroker: broker,
        lifecycleTool: lifecycle,
      });
      runtime = commands
        ? new LayeredToolRuntime(inspection, createVerifierCommandBroker({
            ...base,
            ...(this.options.execution ? { execution: this.options.execution } : {}),
            ...(this.options.permissionProfile ? { permissionProfile: this.options.permissionProfile } : {}),
          }))
        : inspection;
    }
    assertRoleToolSurface("verifier", broker, runtime.definitions().map((definition) => definition.name));
    const budgeted = this.options.budgetLedger
      ? new BudgetedToolRuntime({
          runtime,
          ledger: this.options.budgetLedger,
          scopeId: context.request.runId,
          clock: this.clock,
        })
      : runtime;
    return new InspectionCountingRuntime(budgeted, counter);
  }

  private lifecycleOptions(context: PassContext, sessionId: string): DeliveryLifecycleToolOptions {
    return {
      store: this.options.store,
      runId: context.request.runId,
      taskId: context.inputs.taskId,
      reviewId: context.reviewId,
      runtimeId: context.candidate.runtimeId,
      sessionId,
      clock: this.clock,
    };
  }

  private append(runId: string, type: string, key: string, payload: Record<string, unknown>): void {
    this.options.store.append({
      runId,
      type: type as Parameters<SchedulerStore["append"]>[0]["type"],
      occurredAt: this.clock(),
      actor: { role: "runner", id: DELIVERY_REVIEW_RUNNER_ID },
      idempotencyKey: `delivery-review:${key}`,
      payload,
    });
  }

  private projection(runId: string): SchedulerProjection {
    return rebuildSchedulerProjection(this.options.store.readRun(runId));
  }

  private budgetedModel(model: AgentModel, candidate: AgentRuntimeCandidate, runId: string, sessionId: string): AgentModel {
    if (!this.options.budgetLedger) return model;
    return new BudgetedAgentModel({
      model,
      ledger: this.options.budgetLedger,
      scopeId: runId,
      attribution: verifierModelAttribution(candidate, sessionId),
      outputTokenReserve: this.options.outputTokenReserve ?? 16_384,
      estimateCostMicros: this.options.modelCostEstimators?.get(candidate.runtimeId),
      costBasis: this.options.modelCostBases?.get(candidate.runtimeId),
      clock: this.clock,
    });
  }
}

interface PassContext {
  request: NativeDeliverableReviewRequest;
  reviewId: string;
  inputs: DeliverableReviewInputs;
  candidate: AgentRuntimeCandidate;
  model: AgentModel;
  independence: ReviewerIndependence;
  tier: DeliveryReviewTier;
  depthRecords?: { affectedTests: DeliveryAffectedTestsRecord; probe: DeliveryProbeRecord };
}

function passEnded(result: AgentLoopResult, pass: Pass, reviewId: string): boolean {
  if (pass === "verdict") return result.status === "verifier_verdict_submitted" && result.reviewId === reviewId;
  return result.status === "verifier_expectations_recorded" && result.reviewId === reviewId;
}

function nextGeneration(projection: SchedulerProjection, taskId: string): number {
  const current = projection.delivery?.reviews[taskId];
  const history = projection.delivery?.reviewHistory[taskId] ?? [];
  return Math.max(0, current?.generation ?? 0, ...history.map((review) => review.generation)) + 1;
}

function assertInputs(inputs: DeliverableReviewInputs, task: BuildTask): void {
  if (inputs.taskId !== task.id || inputs.attempt !== task.attempt || inputs.changeSetId !== task.changeSetId) {
    throw new DeliverableReviewInputsUnavailableError("Deliverable review inputs do not describe the current submission.");
  }
  if (!/^[a-f0-9]{64}$/.test(inputs.diffArtifactHash) || !inputs.diffText.trim()) {
    throw new DeliverableReviewInputsUnavailableError("The submitted diff is unavailable.");
  }
  if (inputs.changedPaths.length === 0) {
    throw new DeliverableReviewInputsUnavailableError("The submitted change lists no changed files.");
  }
  if (!inputs.workerSummary.trim()) {
    throw new DeliverableReviewInputsUnavailableError("The worker's submit_task summary is unavailable.");
  }
  const criteria = (task.acceptanceCriteria ?? []).map((criterion) => criterion.id).sort();
  if (criteria.length === 0 || JSON.stringify(inputs.criteria.map((criterion) => criterion.id).sort()) !== JSON.stringify(criteria)) {
    throw new DeliverableReviewInputsUnavailableError("Deliverable review inputs must carry the task's exact acceptance criteria.");
  }
}

function section(id: string, kind: string, content: string): ContextSection {
  return { id, kind, required: true, priority: 1000, content };
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export const DELIVERABLE_REVIEWER_INVARIANTS = [
  "You are an independent reviewer of a submitted change. You did not write it.",
  "The plan-contract acceptance criteria are the source of truth; the worker's report is a claim, not evidence.",
  "Never invent findings: every finding cites the file, line, command, or evidence that shows it.",
  "Your records are durable evidence; another reviewer may audit them without seeing your session.",
].join("\n");

export function deliveryReviewerSystemPrompt(pass: Pass, tier: DeliveryReviewTier): string {
  const instructions = pass === "obligations"
    ? [
        "You see the acceptance criteria only. You have NOT seen the diff yet.",
        "Derive the concrete obligations a correct change must meet, then call record_deliverable_obligations exactly once.",
      ]
    : pass === "findings"
      ? [
          "Inspect the task-revision checkout with your read tools and judge the diff against every criterion.",
          tier === "low"
            ? "Record your findings with record_deliverable_findings exactly once."
            : "At this risk tier you must use at least one inspection tool before record_deliverable_findings; the kernel refuses findings without a real inspection.",
          "Severity blocking means a criterion is not met or the change is unsafe; advisory means a gap worth noting. An empty list means the change checks out.",
          "You have NOT seen the worker's report. Form your own view first.",
        ]
      : [
          "Judge each worker claim as verified (you confirmed it yourself) or unverified, with a rationale.",
          "On a fix re-review, check each prior finding as resolved or outstanding.",
          "Set satisfied true only when no blocking finding and no unverified claim remains. Call submit_deliverable_verdict exactly once.",
        ];
  return `${DELIVERABLE_REVIEWER_INVARIANTS}\n${instructions.join("\n")}`;
}

// ---------------------------------------------------------------------------
// Lifecycle tools. Each pass registers exactly one. Each writes one kernel
// event as the bound reviewer; the kernel owns every refusal.
// ---------------------------------------------------------------------------

export interface DeliveryLifecycleToolOptions {
  store: SchedulerStore;
  runId: string;
  taskId: string;
  reviewId: string;
  runtimeId: string;
  sessionId: string;
  clock: () => string;
}

function assertDeliveryReviewerContext(context: ToolExecutionContext, options: DeliveryLifecycleToolOptions): void {
  if (context.runId !== options.runId || context.sessionId !== options.sessionId) {
    throw new Error("Deliverable reviewer tool context does not match its review session.");
  }
  if (context.actor.role !== "verifier" || context.actor.id !== options.runtimeId) {
    throw new Error("Only the bound deliverable reviewer runtime may use this tool.");
  }
}

function appendAsReviewer(
  options: DeliveryLifecycleToolOptions,
  context: ToolExecutionContext,
  type: string,
  pass: Pass,
  payload: Record<string, unknown>,
  lifecycle: NonNullable<ToolExecutionOutput["lifecycle"]>,
): ToolExecutionOutput {
  try {
    assertDeliveryReviewerContext(context, options);
    options.store.append({
      runId: options.runId,
      type: type as Parameters<SchedulerStore["append"]>[0]["type"],
      occurredAt: options.clock(),
      actor: { role: "verifier", id: options.runtimeId },
      idempotencyKey: `delivery-review:${options.reviewId}:${pass}`,
      payload: { taskId: options.taskId, reviewId: options.reviewId, sessionId: options.sessionId, ...payload },
    });
    return { content: [{ type: "json", value: { reviewId: options.reviewId, recorded: type } }], isError: false, lifecycle };
  } catch (error) {
    return {
      content: [{ type: "text", text: message(error) }],
      isError: true,
      error: { code: "mechanical_transition_rejected", message: message(error) },
    };
  }
}

function objectInput(input: unknown): Record<string, unknown> | null {
  return typeof input === "object" && input !== null && !Array.isArray(input) ? input as Record<string, unknown> : null;
}

export function createRecordDeliverableObligationsTool(
  options: DeliveryLifecycleToolOptions,
): NativeTool<{ obligations: unknown[] }> {
  return {
    definition: {
      name: "record_deliverable_obligations",
      description: "Record the obligations a correct change must meet, derived from the criteria only, exactly once.",
      inputSchema: {
        type: "object",
        properties: {
          obligations: {
            type: "array",
            minItems: 1,
            items: {
              type: "object",
              properties: {
                id: { type: "string", minLength: 1 },
                description: { type: "string", minLength: 1 },
                requirementId: { type: "string", minLength: 1 },
              },
              required: ["id", "description"],
              additionalProperties: false,
            },
          },
        },
        required: ["obligations"],
        additionalProperties: false,
      },
      readOnly: false,
      effect: "none",
      lifecycle: true,
    },
    validate: (input) => {
      const value = objectInput(input);
      return value && Array.isArray(value.obligations) && value.obligations.length > 0
        ? { ok: true, value: { obligations: value.obligations } }
        : { ok: false, issues: ["obligations must be a non-empty array"] };
    },
    execute: async (input, context) => appendAsReviewer(
      options,
      context,
      "delivery.obligations_recorded",
      "obligations",
      { obligations: input.obligations },
      { type: "verifier_expectations_recorded", reviewId: options.reviewId },
    ),
  };
}

export function createRecordDeliverableFindingsTool(
  options: DeliveryLifecycleToolOptions & { depth: () => Record<string, unknown> },
): NativeTool<{ findings: unknown[] }> {
  return {
    definition: {
      name: "record_deliverable_findings",
      description:
        "Record your own findings on the submitted change exactly once, before the worker's report is shown. " +
        "The runner attaches your inspection count and any runner-executed checks.",
      inputSchema: {
        type: "object",
        properties: {
          findings: {
            type: "array",
            items: {
              type: "object",
              properties: {
                id: { type: "string", minLength: 1 },
                category: { type: "string", enum: [...PLANNING_FINDING_CATEGORIES] },
                severity: { type: "string", enum: ["blocking", "advisory"] },
                claim: { type: "string", minLength: 1 },
                location: { type: "string", minLength: 1 },
                requirementId: { type: "string", minLength: 1 },
                evidenceRefs: { type: "array", items: { type: "string", minLength: 1 } },
              },
              required: ["id", "category", "severity", "claim", "evidenceRefs"],
              additionalProperties: false,
            },
          },
        },
        required: ["findings"],
        additionalProperties: false,
      },
      readOnly: false,
      effect: "none",
      lifecycle: true,
    },
    validate: (input) => {
      const value = objectInput(input);
      return value && Array.isArray(value.findings)
        ? { ok: true, value: { findings: value.findings } }
        : { ok: false, issues: ["findings must be an array"] };
    },
    execute: async (input, context) => appendAsReviewer(
      options,
      context,
      "delivery.findings_recorded",
      "findings",
      { findings: input.findings, depth: options.depth() },
      { type: "verifier_expectations_recorded", reviewId: options.reviewId },
    ),
  };
}

interface SubmitDeliverableVerdictInput {
  summary: string;
  satisfied: boolean;
  claimVerdicts: unknown[];
  priorFindingChecks?: unknown[];
}

export function createSubmitDeliverableVerdictTool(
  options: DeliveryLifecycleToolOptions,
): NativeTool<SubmitDeliverableVerdictInput> {
  return {
    definition: {
      name: "submit_deliverable_verdict",
      description:
        "Submit the deliverable verdict exactly once: a verdict per worker claim and, on a re-review, a check per prior finding.",
      inputSchema: {
        type: "object",
        properties: {
          summary: { type: "string", minLength: 1 },
          satisfied: { type: "boolean" },
          claimVerdicts: {
            type: "array",
            items: {
              type: "object",
              properties: {
                claimId: { type: "string", minLength: 1 },
                status: { type: "string", enum: ["verified", "unverified"] },
                rationale: { type: "string", minLength: 1 },
              },
              required: ["claimId", "status", "rationale"],
              additionalProperties: false,
            },
          },
          priorFindingChecks: {
            type: "array",
            items: {
              type: "object",
              properties: {
                findingId: { type: "string", minLength: 1 },
                resolution: { type: "string", enum: ["resolved", "outstanding"] },
                rationale: { type: "string", minLength: 1 },
              },
              required: ["findingId", "resolution", "rationale"],
              additionalProperties: false,
            },
          },
        },
        required: ["summary", "satisfied", "claimVerdicts"],
        additionalProperties: false,
      },
      readOnly: false,
      effect: "none",
      lifecycle: true,
    },
    validate: (input) => {
      const value = objectInput(input);
      if (!value || typeof value.summary !== "string" || !value.summary.trim() || typeof value.satisfied !== "boolean" || !Array.isArray(value.claimVerdicts)) {
        return { ok: false, issues: ["summary, satisfied, and claimVerdicts are required"] };
      }
      if (value.priorFindingChecks !== undefined && !Array.isArray(value.priorFindingChecks)) {
        return { ok: false, issues: ["priorFindingChecks must be an array"] };
      }
      return {
        ok: true,
        value: {
          summary: value.summary,
          satisfied: value.satisfied,
          claimVerdicts: value.claimVerdicts,
          ...(value.priorFindingChecks !== undefined ? { priorFindingChecks: value.priorFindingChecks as unknown[] } : {}),
        },
      };
    },
    execute: async (input, context) => appendAsReviewer(
      options,
      context,
      "delivery.review_recorded",
      "verdict",
      {
        summary: input.summary,
        satisfied: input.satisfied,
        claimVerdicts: input.claimVerdicts,
        ...(input.priorFindingChecks !== undefined ? { priorFindingChecks: input.priorFindingChecks } : {}),
      },
      { type: "verifier_verdict_submitted", reviewId: options.reviewId, satisfied: input.satisfied },
    ),
  };
}

/**
 * Counts the reviewer's successful non-lifecycle tool calls in a pass. The
 * count is attached to the findings event, and the kernel refuses a
 * medium/high review without at least one real inspection.
 */
class InspectionCountingRuntime implements AgentToolRuntime {
  constructor(private readonly inner: AgentToolRuntime, private readonly counter: { calls: number }) {}
  definitions() { return this.inner.definitions(); }
  isLifecycleTool(name: string): boolean { return this.inner.isLifecycleTool(name); }
  isReadOnlyTool(name: string): boolean { return this.inner.isReadOnlyTool(name); }
  assertUniqueCallIds(calls: readonly ToolCallBlock[], seen: ReadonlySet<string>): void {
    this.inner.assertUniqueCallIds(calls, seen);
  }
  async invoke(call: ToolCallBlock, context: ToolExecutionContext): Promise<ToolResult> {
    const result = await this.inner.invoke(call, context);
    if (!result.isError && !this.inner.isLifecycleTool(call.name)) this.counter.calls += 1;
    return result;
  }
}
