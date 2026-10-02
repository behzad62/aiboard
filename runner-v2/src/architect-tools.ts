import { createHash } from "node:crypto";

import type {
  NativeTool,
  ToolExecutionContext,
  ToolExecutionOutput,
  ValidationResult,
} from "./agent-contracts.js";
import {
  assertPendingUserGuidanceAllowsEvent,
  assertOpenArchitectQuestionAllowsEvent,
  buildCompletionReadiness,
  latestUnresolvedContextRecordingNote,
  readyPlanIdentity,
  rebuildSchedulerProjection,
  type SchedulerActor,
  type SchedulerStore,
} from "./scheduler-store.js";
import type { NativeBuildRunPolicy } from "./build-spec.js";
import type {
  BuildTask,
  PlanNewTask,
  PlanReconciliation,
  PlanTaskUpdate,
} from "./task-contracts.js";
import {
  assertSatisfiedVerdictsCiteGreenEvidence,
  validateAcceptanceCriteria,
  validateCriterionReviewVerdicts,
  type AcceptanceCriterion,
  type AcceptedEvidenceFailure,
  type CriterionReviewVerdict,
} from "./acceptance-contracts.js";
import type { EvidenceStore } from "./evidence-store.js";
import type { ArtifactStore } from "./artifact-store.js";
import {
  PROJECT_DOC_MAX_BYTES,
  projectDocRequestId,
  validateProjectDocPath,
} from "./project-docs.js";
import { validateTaskGraph } from "./task-graph.js";
import {
  FINAL_VERIFICATION_CATEGORIES,
  finalVerificationPlanSchema,
  planFinalVerification,
  validateFinalVerificationPlan,
  type FinalVerificationPlan,
  type FinalVerificationCategory,
} from "./final-verification-contracts.js";
import {
  cloneFinalVerificationExecutionProfile,
  type FinalVerificationExecutionProfile,
} from "./final-verification-profile.js";
import type {
  ArchitectActionReason,
  ArchitectQuestionDecisionKind,
  UserGuidanceAcknowledgementResolution,
} from "./user-steering-contracts.js";
import {
  createPlanningTools,
  type PlanningSourceReader,
} from "./planning-tools.js";
import { createRequestTriageTools } from "./request-triage.js";
import { boundaryNeedsArchitect, boundaryResolutionGeneration, latestBoundary } from "./delivery-acceptance.js";
import { deliveryBoundaryRootCause, failingTestIdsByCategory, repairMemberIssues, withFailingIds } from "./repair-budget-contracts.js";
import { validateRepairApproachDecision } from "./repair-approach-contracts.js";

export interface ArchitectToolsOptions {
  store: SchedulerStore;
  clock?: () => string;
  runPolicy?: NativeBuildRunPolicy;
  planOnlyCompletionAvailable?: boolean;
  finalVerificationPlanAvailable?: boolean;
  finalVerificationReviewAvailable?: boolean;
  finalVerificationRepairPlanAvailable?: boolean;
  verifierRepairPlanAvailable?: boolean;
  repairApproachAvailable?: boolean;
  /** T6b repair (B5): project identity for per-root-cause repair issues. */
  repairProjectId?: string;
  /** T6a: offered on a `delivery_boundary_failed` turn. */
  deliveryBoundaryResolutionAvailable?: boolean;
  evidenceStore?: EvidenceStore;
  architectAction?: {
    reason: ArchitectActionReason;
    sequence: number;
  };
  planCritiqueResolutionAvailable?: boolean;
  /**
   * New-policy evidence-gated planning tools (T3a). Set for runs whose durable
   * projection carries planningPolicyVersion 1; legacy runs omit it and keep
   * today's tools.
   */
  planningTools?: {
    readSource?: PlanningSourceReader;
  };
  /**
   * T3a repair (B1b): set while a new-policy run is in planning state (no
   * ready plan, triage not `answer`). The legacy plan/task tools
   * (plan_tasks, revise_task, reconcile_plan) are then not registered at
   * all; the reducer refuses the matching direct events too. Omit or set
   * false on every other turn.
   */
  planningState?: boolean;
  /**
   * T9 (EP39): true on triage-`answer` turns. Mutation lifecycle tools are
   * not offered (plan/task/review/integration/final-verification/repairs/
   * critique/acceptance/guidance); ask_user, complete_run, write_project_doc,
   * and the triage tools stay. The reducer refuses forged invokes as well.
   */
  answerPath?: boolean;
  /**
   * T9 (EP39): when true, the run is new-policy and triage tools
   * (record_triage, record_answer, convert_to_build) are registered.
   */
  triageTools?: boolean;
  /**
   * T9 repair cycle 1 (B3): when true, the turn also offers
   * `acknowledge_user_guidance` for inline acknowledgement of pending user
   * guidance. The runner sets it only on new-policy `plan_required` turns
   * (triage/answer/planning) with guidance pending; the tool re-checks the
   * policy and targets the exact oldest pending guidance.
   */
  acknowledgeGuidanceAvailable?: boolean;
  /** When set, every Architect turn — including plan_only — can request project docs. */
  artifacts?: ArtifactStore;
  finalVerificationProfileFor?: (targetRevision: string) => Promise<FinalVerificationExecutionProfile>;
  discardFinalVerificationProfile?: (profile: FinalVerificationExecutionProfile) => Promise<void>;
}

interface PlanTaskInput {
  id: string;
  objective: string;
  dependencies: string[];
  requiredCapabilities: string[];
  acceptanceCriteria: AcceptanceCriterion[];
}

interface PlanTasksInput {
  revision: number;
  tasks: PlanTaskInput[];
  riskDeclaration?: { risk: "low" | "high"; rationale: string };
}

interface ReviseTaskInput {
  taskId: string;
  revision: number;
  objective?: string;
  dependencies?: string[];
  requiredCapabilities?: string[];
  acceptanceCriteria?: AcceptanceCriterion[];
}

interface AcknowledgeUserGuidanceInput {
  guidanceId: string;
  expectedVersion: number;
  resolution: UserGuidanceAcknowledgementResolution;
}

interface AskUserInput {
  questionId: string;
  version: number;
  decisionKind: ArchitectQuestionDecisionKind;
  question: string;
}

interface AcceptanceContractUpgradeInput {
  revision: number;
  criteriaByTask: Array<{
    taskId: string;
    acceptanceCriteria: AcceptanceCriterion[];
  }>;
}

interface AnswerGuidanceInput {
  requestId: string;
  expectedVersion: number;
  answer: string;
}

interface ReviewTaskInput {
  taskId: string;
  decision: "approved" | "rejected";
  summary: string;
  evidenceArtifactHashes: string[];
  criterionVerdicts?: CriterionReviewVerdict[];
  planReconciliation?: PlanReconciliation;
  findingDispositions?: Array<{ findingId: string; resolution: "plan_reconciled" | "rejected" | "deferred"; rationale: string }>;
  claimDispositions?: Array<{ claimId: string; status: "verified"; rationale: string }>;
}

interface TaskIdInput { taskId: string }
interface CompleteRunInput { summary: string }
interface PlanFinalVerificationInput { plan: FinalVerificationPlan }
interface FinalVerificationCategoryReviewInput {
  category: FinalVerificationCategory;
  verdict: "approved" | "repair_required";
  rationale: string;
  evidenceIds: string[];
}
interface ReviewFinalVerificationInput {
  taskId: string;
  generationId: string;
  targetRevision: string;
  submissionId: string;
  attempt: number;
  decision: "approved" | "repair_required";
  summary: string;
  architectRisk: "low" | "high";
  architectRiskRationale: string;
  categoryReviews: FinalVerificationCategoryReviewInput[];
}
interface VerificationRepairTaskInput {
  id: string;
  objective: string;
  categories: FinalVerificationCategory[];
  evidenceIds: string[];
  dependencies: string[];
  requiredCapabilities: string[];
  acceptanceCriteria: AcceptanceCriterion[];
}
interface PlanVerificationRepairsInput {
  finalVerificationTaskId: string;
  generationId: string;
  targetRevision: string;
  source:
    | { type: "semantic_review"; submissionId: string; reviewId: string }
    | { type: "mechanical_failure"; failureId: string; issueIds: string[]; factIds: string[] };
  tasks: VerificationRepairTaskInput[];
}

interface VerifierRepairTaskInput {
  id: string;
  objective: string;
  criteria: Array<{ taskId: string; criterionId: string }>;
  evidenceIds: string[];
  dependencies: string[];
  requiredCapabilities: string[];
  acceptanceCriteria: AcceptanceCriterion[];
}

interface PlanVerifierRepairsInput {
  reviewId: string;
  targetRevision: string;
  tasks: VerifierRepairTaskInput[];
}

interface WriteProjectDocInput {
  path: string;
  content: string;
  summary: string;
  contentBytes: number;
}

interface ResolvePlanCritiqueInput {
  critiqueId: string;
  planRevision: number;
  resolutions: Array<{
    findingId: string;
    resolution: "plan_reconciled" | "rejected";
    rationale: string;
  }>;
  planReconciliation?: PlanReconciliation;
}

export function resolvePlanCritiqueTool(
  store: SchedulerStore,
  clock: () => string,
): NativeTool<ResolvePlanCritiqueInput> {
  return lifecycleTool({
    name: "resolve_plan_critique",
    description: "Resolve every blocking plan-critique finding exactly once: reconcile the plan (one atomic planReconciliation) for accepted findings, reject the rest with evidence-based rationale",
    schema: objectSchema({
      critiqueId: { type: "string", minLength: 1 },
      planRevision: { type: "integer", minimum: 1 },
      resolutions: {
        type: "array",
        items: objectSchema({
          findingId: { type: "string", minLength: 1 },
          resolution: { enum: ["plan_reconciled", "rejected"] },
          rationale: { type: "string", minLength: 1 },
        }, ["findingId", "resolution", "rationale"]),
      },
      planReconciliation: planReconciliationSchema(),
    }, ["critiqueId", "planRevision", "resolutions"]),
    validate: validateResolvePlanCritique,
    execute: async (input, context) => {
      const denied = architectOnly(context);
      if (denied) return denied;
      const events = store.readRun(context.runId);
      const projection = events.length > 0 ? rebuildSchedulerProjection(events) : undefined;
      const current = projection?.planCritique?.current;
      const resolutionIds = input.resolutions.map((item) => item.findingId);
      if (
        !current ||
        current.status !== "submitted" ||
        current.critiqueId !== input.critiqueId ||
        current.planRevision !== input.planRevision ||
        !sameStringSet(current.blockingFindingIds ?? [], resolutionIds)
      ) {
        return errorOutput(
          "stale_plan_critique",
          "Plan critique resolution does not match the current submitted critique.",
        );
      }
      return appendEvent(store, {
        runId: context.runId,
        type: "plan_critique.resolved",
        occurredAt: clock(),
        actor: { role: "architect", id: context.actor.id },
        idempotencyKey: `plan-critique:resolve:${input.critiqueId}`,
        payload: {
          critiqueId: input.critiqueId,
          planRevision: input.planRevision,
          resolutions: input.resolutions.map((item) => ({ ...item })),
          ...(input.planReconciliation ? { planReconciliation: input.planReconciliation } : {}),
        },
      }, {
        type: "architect_action",
        action: "plan_critique_resolved",
        referenceId: input.critiqueId,
      });
    },
  });
}

function resolveContextRecordingTool(
  store: SchedulerStore,
  clock: () => string,
): NativeTool<{ resolution: "retry" | "proceed_without_manifest" | "abort"; rationale: string }> {
  return lifecycleTool({
    name: "resolve_context_recording",
    description: "Resolve a paused context-manifest recording failure by retrying, waiving the manifest with a rationale, or aborting the run",
    schema: objectSchema({
      resolution: { type: "string", enum: ["retry", "proceed_without_manifest", "abort"] },
      rationale: { type: "string", minLength: 1 },
    }, ["resolution", "rationale"]),
    validate: (input) => validateObject(input, (value) => {
      if (
        value.resolution !== "retry" &&
        value.resolution !== "proceed_without_manifest" &&
        value.resolution !== "abort"
      ) return null;
      if (typeof value.rationale !== "string" || value.rationale.length < 1) return null;
      if (value.resolution === "proceed_without_manifest" && value.rationale.trim().length === 0) {
        return null;
      }
      return {
        resolution: value.resolution,
        rationale: value.rationale,
      };
    }, "Context recording resolution is invalid."),
    execute: async (input, context) => {
      const denied = architectOnly(context);
      if (denied) return denied;
      const projection = rebuildSchedulerProjection(store.readRun(context.runId));
      const note = latestUnresolvedContextRecordingNote(projection);
      if (!note) {
        return errorOutput(
          "context_recording_note_missing",
          "No unresolved context-manifest recording failure is waiting for a decision.",
        );
      }
      const actor: SchedulerActor = { role: "architect", id: context.actor.id };
      return appendEvent(store, {
        runId: context.runId,
        type: "context_manifest.recording_resolved",
        occurredAt: clock(),
        actor,
        idempotencyKey: `context-recording-resolved:${note.sequence}`,
        payload: {
          noteSequence: note.sequence,
          resolution: input.resolution,
          rationale: input.rationale,
        },
      }, {
        type: "architect_action",
        action: "context_recording_resolved",
        referenceId: String(note.sequence),
      });
    },
  });
}

function writeProjectDocTool(
  store: SchedulerStore,
  clock: () => string,
  artifacts: ArtifactStore,
): NativeTool<WriteProjectDocInput> {
  return lifecycleTool({
    name: "write_project_doc",
    description: "Request a project document write for docs/project/** or the marked AGENTS.md or CLAUDE.md section. Stores the content and records the request. It does not change any project file.",
    schema: objectSchema({
      path: { type: "string", minLength: 1 },
      content: { type: "string" },
      summary: {
        type: "string",
        minLength: 1,
        maxLength: 200,
        pattern: "^[^\\r\\n\\u0000]+$",
        description: "One line; used as the commit message.",
      },
    }, ["path", "content", "summary"]),
    validate: validateWriteProjectDoc,
    execute: async (input, context) => {
      const denied = architectOnly(context);
      if (denied) return denied;
      const contentBytes = Buffer.byteLength(input.content, "utf8");
      if (contentBytes !== input.contentBytes || contentBytes > PROJECT_DOC_MAX_BYTES) {
        return errorOutput(
          "project_doc_too_large",
          `Project document content exceeds ${PROJECT_DOC_MAX_BYTES} bytes.`,
        );
      }
      let record;
      try {
        record = await artifacts.put(
          Buffer.from(input.content, "utf8"),
          "text/markdown",
          input.path,
        );
      } catch (error) {
        return errorOutput(
          "project_doc_artifact_failed",
          error instanceof Error ? error.message : String(error),
        );
      }
      if (record.hash !== digestBytes(input.content) || record.byteLength !== contentBytes) {
        return errorOutput(
          "project_doc_artifact_failed",
          "Project document artifact does not match the requested content.",
        );
      }
      let requestId: string;
      try {
        const events = store.readRun(context.runId);
        const projection = events.length > 0 ? rebuildSchedulerProjection(events) : undefined;
        // Next log position, read immediately before append. Append is
        // synchronous and the store transaction is serialized, so two writes
        // in one Architect turn get different ids. A replay of an id already
        // on the pending list is still rejected by the reducer.
        requestId = projectDocRequestId((projection?.lastSequence ?? 0) + 1, input.path);
        const event = {
          runId: context.runId,
          type: "project_doc.requested" as const,
          occurredAt: clock(),
          actor: { role: "architect" as const, id: context.actor.id },
          idempotencyKey: requestId,
          payload: {
            requestId,
            path: input.path,
            contentArtifactHash: record.hash,
            contentBytes,
            summary: input.summary,
          },
        };
        if (projection) {
          assertPendingUserGuidanceAllowsEvent(projection, event);
          assertOpenArchitectQuestionAllowsEvent(projection, event);
        }
        store.append(event);
      } catch (error) {
        return errorOutput(
          "mechanical_transition_rejected",
          error instanceof Error ? error.message : String(error),
        );
      }
      return {
        content: [{ type: "text", text: `Project document requested: ${requestId}` }],
        isError: false,
      };
    },
  });
}

function validateWriteProjectDoc(input: unknown): ValidationResult<WriteProjectDocInput> {
  return validateObject(input, (value) => {
    if (typeof value.path !== "string" || typeof value.content !== "string" || typeof value.summary !== "string") {
      return null;
    }
    if (!projectDocSummaryAccepted(value.summary)) return null;
    const checked = validateProjectDocPath(value.path);
    if (!checked.ok) return null;
    const contentBytes = Buffer.byteLength(value.content, "utf8");
    if (contentBytes > PROJECT_DOC_MAX_BYTES) return null;
    return {
      path: checked.path,
      content: value.content,
      summary: value.summary.trim(),
      contentBytes,
    };
  }, "Project document write is invalid.");
}

/** One line the integration commit can accept as its message. */
function projectDocSummaryAccepted(summary: string): boolean {
  if (summary.length < 1 || summary.length > 200) return false;
  if (/[\r\n\0]/.test(summary)) return false;
  const trimmed = summary.trim();
  return trimmed.length > 0 && trimmed.length <= 200;
}

function digestBytes(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

export function createArchitectTools(
  options: ArchitectToolsOptions
): NativeTool<unknown>[] {
  const clock = options.clock ?? (() => new Date().toISOString());
  if (options.architectAction?.reason.type === "context_recording_decision_required") {
    return [
      resolveContextRecordingTool(options.store, clock),
      askUserTool(options.store, clock, options.architectAction),
    ];
  }
  // T3a repair (B1b): while a new-policy run is in planning state the
  // legacy plan/task tools are not offered; the reducer (plus the per-tool
  // check below) refuses forged invokes as well. T9: same on the answer path.
  const answerPath = options.answerPath === true;
  const legacyPlanTools = options.planningState === true || answerPath
    ? []
    : [
        planTasksTool(options.store, clock),
        reviseTaskTool(options.store, clock),
      ];
  const baseCore = answerPath
    ? [...legacyPlanTools]
    : [
        ...legacyPlanTools,
        answerGuidanceTool(options.store, clock),
        upgradeAcceptanceContractTool(options.store, clock),
      ];
  const withQuestion = options.architectAction
    ? [...baseCore, askUserTool(options.store, clock, options.architectAction)]
    : baseCore;
  // T9 repair cycle 1 (B3): the dedicated guidance turn offers the
  // acknowledgement, and so does a new-policy triage/answer/planning turn
  // with guidance pending — the pending-guidance gate's "must be
  // acknowledged" refusal is then actionable in the same turn.
  const core = options.architectAction !== undefined &&
      (options.architectAction.reason.type === "user_guidance_required" ||
        options.acknowledgeGuidanceAvailable === true)
    ? [
        ...withQuestion,
        acknowledgeUserGuidanceTool(
          options.store,
          clock,
          options.architectAction,
          options.evidenceStore
        ),
      ]
    : withQuestion;
  const planning = options.finalVerificationPlanAvailable && !answerPath
    ? [...core, planFinalVerificationTool(
        options.store,
        clock,
        options.finalVerificationProfileFor,
        options.discardFinalVerificationProfile,
      )]
    : core;
  const verification = options.finalVerificationReviewAvailable && !answerPath
    ? [...planning, reviewFinalVerificationTool(
        options.store,
        clock,
        options.evidenceStore,
      )]
    : planning;
  const repairPlanning = options.finalVerificationRepairPlanAvailable && !answerPath
    ? [...verification, planVerificationRepairsTool(options.store, clock, { projectId: options.repairProjectId, evidenceStore: options.evidenceStore })]
    : verification;
  const verifierRepairPlanning = options.verifierRepairPlanAvailable && !answerPath
    ? [...repairPlanning, planVerifierRepairsTool(options.store, clock, { projectId: options.repairProjectId, evidenceStore: options.evidenceStore })]
    : repairPlanning;
  const repairApproach = options.repairApproachAvailable && !answerPath
    ? [...verifierRepairPlanning, recordRepairApproachDecisionTool(options.store, clock, options.evidenceStore), recordExternalBlockerTool(options.store, clock, options.evidenceStore)]
    : verifierRepairPlanning;
  const boundaryResolution = options.deliveryBoundaryResolutionAvailable && !answerPath
    ? [...repairApproach, resolveDeliveryBoundaryFailureTool(options.store, clock, { projectId: options.repairProjectId, evidenceStore: options.evidenceStore })]
    : repairApproach;
  const critiqueResolution = options.planCritiqueResolutionAvailable && !answerPath
    ? [...boundaryResolution, resolvePlanCritiqueTool(options.store, clock)]
    : boundaryResolution;
  const tools = options.runPolicy === "plan_only"
    ? options.planOnlyCompletionAvailable
      ? [...critiqueResolution, completeRunTool(options.store, clock, "plan_only")]
      : critiqueResolution
    : [
        ...critiqueResolution,
        ...(options.planningState === true || answerPath
          ? []
          : [reconcilePlanTool(options.store, clock)]),
        ...(answerPath
          ? []
          : [
              reviewTaskTool(options.store, clock, options.evidenceStore),
              requestIntegrationTool(options.store, clock),
            ]),
        completeRunTool(options.store, clock, options.runPolicy ?? "finish"),
      ];
  const withPlanning = options.planningTools
    ? [
        ...tools,
        ...createPlanningTools({
          store: options.store,
          clock,
          ...(options.artifacts ? { artifacts: options.artifacts } : {}),
          ...(options.planningTools.readSource
            ? { readSource: options.planningTools.readSource }
            : {}),
          // T9 repair cycle 1 (N5): answer turns keep only the durable
          // read; the plan-progressing tools always refuse there.
          ...(answerPath ? { answerPath: true as const } : {}),
        }),
      ]
    : tools;
  // T9 (EP39): triage tools ride the new-policy turn alongside planning tools.
  const withTriage = options.triageTools === true
    ? [...withPlanning, ...createRequestTriageTools({ store: options.store, clock })]
    : withPlanning;
  if (!options.artifacts) return withTriage;
  return [
    ...withTriage,
    writeProjectDocTool(
      options.store,
      clock,
      options.artifacts,
    ),
  ];
}

function planVerificationRepairsTool(
  store: SchedulerStore,
  clock: () => string,
  toolOptions?: RepairPlanningToolOptions,
): NativeTool<PlanVerificationRepairsInput> {
  return lifecycleTool({
    name: "plan_verification_repairs",
    description: "Atomically create narrowly scoped worker tasks for every failed final-verification review category",
    schema: objectSchema({
      finalVerificationTaskId: { type: "string", minLength: 1 },
      generationId: { type: "string", minLength: 1 },
      targetRevision: { type: "string", minLength: 1 },
      source: objectSchema({
        type: { type: "string", enum: ["semantic_review", "mechanical_failure"] },
        submissionId: { type: "string", minLength: 1 },
        reviewId: { type: "string", minLength: 1 },
        failureId: { type: "string", minLength: 1 },
        issueIds: { type: "array", items: { type: "string", minLength: 1 } },
        factIds: { type: "array", items: { type: "string", minLength: 1 } },
      }, ["type"]),
      tasks: {
        type: "array",
        minItems: 1,
        items: objectSchema({
          id: { type: "string", minLength: 1 },
          objective: { type: "string", minLength: 1 },
          categories: {
            type: "array",
            minItems: 1,
            items: { type: "string", enum: [...FINAL_VERIFICATION_CATEGORIES] },
          },
          evidenceIds: { type: "array", items: { type: "string", minLength: 1 } },
          dependencies: { type: "array", items: { type: "string", minLength: 1 } },
          requiredCapabilities: { type: "array", items: { type: "string", minLength: 1 } },
          acceptanceCriteria: {
            type: "array",
            minItems: 1,
            items: criterionSchema(),
          },
        }, [
          "id", "objective", "categories", "evidenceIds", "dependencies",
          "requiredCapabilities", "acceptanceCriteria",
        ]),
      },
    }, [
      "finalVerificationTaskId", "generationId", "targetRevision", "source", "tasks",
    ]),
    validate: validateVerificationRepairPlan,
    execute: async (input, context) => {
      const denied = architectOnly(context);
      if (denied) return denied;
      const projection = rebuildSchedulerProjection(store.readRun(context.runId));
      const current = projection.finalVerification?.current;
      if (
        !current ||
        current.taskId !== input.finalVerificationTaskId ||
        current.generationId !== input.generationId ||
        current.targetRevision !== input.targetRevision ||
        projection.integrationRevision !== input.targetRevision ||
        !repairSourceMatchesCurrent(current, input.source)
      ) {
        return errorOutput(
          "stale_verification_repair_plan",
          "Verification repairs must reference the current durable mechanical failure or repair-required semantic review.",
        );
      }
      if (current.repairTaskIds) {
        if (repairPlanMatches(projection.tasks, current.repairTaskIds, input.tasks)) {
          return {
            content: [{ type: "json", value: { repairTaskIds: current.repairTaskIds } }],
            isError: false,
            lifecycle: {
              type: "architect_action",
              action: "verification_repairs_planned",
              referenceId: current.generationId,
            },
          };
        }
        return errorOutput(
          "conflicting_verification_repair_plan",
          "Verification repairs already have a conflicting durable plan.",
        );
      }
      // T6b repair (B4/B5): require a live recorded decision for every
      // member issue and charge one cycle per member on dispatch. Legacy
      // runs bypass the gate and the charge unchanged.
      if (projection.planningPolicyVersion === 1) {
        const members = repairMemberIssues(toolProjectId(toolOptions, context.runId), input.tasks.flatMap((task) => task.categories.map((category) => withFailingIds(category, failingTestIdsByCategory(projection.finalVerification?.current?.completedChecks ?? [])))));
        const taskEvidence = [...new Set(input.tasks.flatMap((task) => task.evidenceIds))];
        // T6b repair (N7): repair tasks cite durable evidence.
        if (toolOptions?.evidenceStore) {
          const known = new Set(toolOptions.evidenceStore.getByIds({ runId: context.runId, ids: taskEvidence }).map((record) => record.id));
          const fabricated = taskEvidence.find((id) => !known.has(id));
          if (fabricated !== undefined) return errorOutput("unknown_evidence", `Repair tasks cite unknown evidence id ${fabricated}.`);
        }
        // T6b repair (R4-B1): validate EVERY member before charging ANY.
        // A partial check-and-charge consumes a decision and spends a cycle
        // on a dispatch that never happens, and the retry then collides on
        // the charge key forever. The store has no multi-event transaction,
        // so all validations run before any append.
        const validated: Array<{ member: (typeof members)[number]; live: { approachId: string; hypothesis: string; evidenceIds: string[] }; evidenceIds: string[] }> = [];
        for (const member of members) {
          const issue = projection.repairIssues?.[member.issueId];
          if (issue?.externalBlocker) {
            return errorOutput("repair_external_blocker", `Issue ${member.rootCause} has a recorded external blocker; no futile dispatch.`);
          }
          if (issue && issue.used >= issue.limit) {
            return errorOutput("repair_issue_budget_exhausted", `Issue ${member.rootCause} used ${issue.used}/${issue.limit} repair cycles.`);
          }
          const live = requireLiveRepairDecision(issue, member.issueId, member.rootCause);
          if ("isError" in live) return live;
          const evidenceIds = [...new Set([...live.evidenceIds, ...taskEvidence])];
          if (evidenceIds.length === 0) {
            return errorOutput("repair_charge_evidence_required", `Dispatch for ${member.rootCause} requires durable evidence.`);
          }
          validated.push({ member, live, evidenceIds });
        }
        for (const { member, live, evidenceIds } of validated) {
          chargeRepairDispatch(store, context.runId, clock(), [member], {
            hypothesis: live.hypothesis,
            evidenceIds,
            approachId: live.approachId,
            idempotencyKey: current.generationId,
          });
        }
      }
      return appendEvent(store, {
        runId: context.runId,
        type: "final_verification.repairs_planned",
        occurredAt: clock(),
        actor: { role: "architect", id: context.actor.id },
        idempotencyKey: `final-verification-repairs:${current.generationId}`,
        payload: {
          finalVerificationTaskId: input.finalVerificationTaskId,
          taskId: input.finalVerificationTaskId,
          generationId: input.generationId,
          targetRevision: input.targetRevision,
          source: input.source,
          revision: projection.planRevision + 1,
          tasks: input.tasks.map((task) => ({
            ...task,
            categories: [...task.categories],
            evidenceIds: [...task.evidenceIds],
            dependencies: [...task.dependencies],
            requiredCapabilities: [...task.requiredCapabilities],
            acceptanceCriteria: task.acceptanceCriteria.map((criterion) => ({ ...criterion })),
          })),
        },
      }, {
        type: "architect_action",
        action: "verification_repairs_planned",
        referenceId: current.generationId,
      });
    },
  });
}

function validateVerificationRepairPlan(
  input: unknown,
): ValidationResult<PlanVerificationRepairsInput> {
  return validateObject(input, (value) => {
    if (
      !nonEmpty(value.finalVerificationTaskId) ||
      !nonEmpty(value.generationId) ||
      !nonEmpty(value.targetRevision) ||
      !isRecord(value.source) ||
      !Array.isArray(value.tasks) || value.tasks.length === 0
    ) return null;
    const source = value.source.type === "semantic_review" &&
      nonEmpty(value.source.submissionId) && nonEmpty(value.source.reviewId)
      ? {
          type: "semantic_review" as const,
          submissionId: value.source.submissionId,
          reviewId: value.source.reviewId,
        }
      : value.source.type === "mechanical_failure" &&
          nonEmpty(value.source.failureId) &&
          stringList(value.source.issueIds)?.length &&
          stringList(value.source.factIds)
        ? {
            type: "mechanical_failure" as const,
            failureId: value.source.failureId,
            issueIds: stringList(value.source.issueIds)!,
            factIds: stringList(value.source.factIds)!,
          }
        : null;
    if (!source || new Set(source.type === "mechanical_failure" ? source.issueIds : []).size !==
      (source.type === "mechanical_failure" ? source.issueIds.length : 0)) return null;
    const tasks: VerificationRepairTaskInput[] = [];
    for (const candidate of value.tasks) {
      if (!isRecord(candidate) || !nonEmpty(candidate.id) || !nonEmpty(candidate.objective)) return null;
      const categories = stringList(candidate.categories) as FinalVerificationCategory[] | null;
      const evidenceIds = stringList(candidate.evidenceIds);
      const dependencies = stringList(candidate.dependencies);
      const requiredCapabilities = stringList(candidate.requiredCapabilities);
      const acceptanceCriteria = parseAcceptanceCriteria(candidate.acceptanceCriteria);
      if (
        !categories || categories.length === 0 ||
        categories.some((category) => !FINAL_VERIFICATION_CATEGORIES.includes(category)) ||
        new Set(categories).size !== categories.length ||
        !evidenceIds || new Set(evidenceIds).size !== evidenceIds.length ||
        !dependencies || !requiredCapabilities || !acceptanceCriteria
      ) return null;
      tasks.push({
        id: candidate.id,
        objective: candidate.objective,
        categories: FINAL_VERIFICATION_CATEGORIES.filter((category) => categories.includes(category)),
        evidenceIds: [...evidenceIds].sort(),
        dependencies: [...dependencies].sort(),
        requiredCapabilities: [...requiredCapabilities].sort(),
        acceptanceCriteria,
      });
    }
    if (new Set(tasks.map((task) => task.id)).size !== tasks.length) return null;
    return {
      finalVerificationTaskId: value.finalVerificationTaskId,
      generationId: value.generationId,
      targetRevision: value.targetRevision,
      source,
      tasks: tasks.sort((left, right) => left.id.localeCompare(right.id)),
    };
  }, "current repair provenance and at least one valid scoped repair task are required");
}

function repairSourceMatchesCurrent(
  current: import("./scheduler-store.js").FinalVerificationGenerationProjection,
  source: PlanVerificationRepairsInput["source"],
): boolean {
  if (source.type === "semantic_review") {
    return current.review?.status === "repair_required" &&
      Boolean(current.review.decision) &&
      current.submission?.submissionId === source.submissionId &&
      current.review.reviewId === source.reviewId;
  }
  return Boolean(
    current.failure &&
    current.cleanup?.status === "succeeded" &&
    current.failure.failureId === source.failureId &&
    JSON.stringify(current.failure.issueIds) === JSON.stringify(source.issueIds) &&
    JSON.stringify(current.failure.factIds) === JSON.stringify(source.factIds)
  );
}

function repairPlanMatches(
  tasks: Record<string, BuildTask>,
  ids: readonly string[],
  proposed: readonly VerificationRepairTaskInput[],
): boolean {
  if (ids.length !== proposed.length) return false;
  return proposed.every((candidate) => {
    const task = tasks[candidate.id];
    return task?.kind === "verification_repair" &&
      task.objective === candidate.objective &&
      JSON.stringify(task.dependencies) === JSON.stringify(candidate.dependencies) &&
      JSON.stringify(task.requiredCapabilities) === JSON.stringify(candidate.requiredCapabilities) &&
      JSON.stringify(task.acceptanceCriteria) === JSON.stringify(candidate.acceptanceCriteria) &&
      JSON.stringify(task.verificationRepair?.categories) === JSON.stringify(candidate.categories) &&
      JSON.stringify(task.verificationRepair?.evidenceIds) === JSON.stringify(candidate.evidenceIds);
  });
}

interface RecordRepairApproachDecisionInput {
  issueId: string;
  approachId: string;
  repeat: boolean;
  hypothesis: string;
  diagnosticSet: string[];
  evidenceIds: string[];
}

/** T6b repair (B4/B5): options shared by the repair planning tools. */
export interface RepairPlanningToolOptions {
  readonly projectId?: string;
  readonly evidenceStore?: EvidenceStore;
}

/**
 * T6b repair (B4): the kernel requires a live recorded decision before any
 * repair dispatch and never synthesizes one. A decision is live while the
 * latest recorded approach for the issue has not failed; after a failure
 * the Architect must record a new decision with new evidence first.
 * T6b repair (R3-B2): one decision authorizes exactly one dispatch — a
 * consumed (dispatched) approach is no longer live, while context and
 * display still show it pending (failed=false) until its validation
 * records it failed or a new decision supersedes it.
 */
function liveRepairApproach(issue: NonNullable<ReturnType<typeof rebuildSchedulerProjection>["repairIssues"]>[string]): { approachId: string; hypothesis: string; evidenceIds: string[] } | undefined {
  const latest = issue.approaches.at(-1);
  if (!latest || latest.failed || latest.dispatched) return undefined;
  return { approachId: latest.approachId, hypothesis: latest.hypothesis, evidenceIds: [...latest.evidenceIds] };
}

function requireLiveRepairDecision(
  issue: { approaches: { approachId: string; failed: boolean; dispatched: boolean; hypothesis: string; diagnosticSet: string[]; evidenceIds: string[]; failureEvidenceIds?: string[] }[] } | undefined,
  issueId: string,
  rootCause: string,
): { approachId: string; hypothesis: string; evidenceIds: string[] } | ReturnType<typeof errorOutput> {
  if (!issue) return errorOutput("unknown_repair_issue", `Repair dispatch requires the current durable issue ${issueId}.`);
  const live = liveRepairApproach(issue as Parameters<typeof liveRepairApproach>[0]);
  if (!live) {
    const failed = issue.approaches.filter((entry) => entry.failed).map((entry) => `${entry.approachId} (evidence ${entry.evidenceIds.join(", ") || "none"}; failure evidence ${(entry.failureEvidenceIds ?? []).join(", ") || "none"})`);
    return errorOutput(
      "repair_approach_decision_required",
      `No live repair approach for ${issueId} (${rootCause}). Call record_repair_approach_decision with that issueId first${failed.length > 0 ? `; prior failed approaches: ${failed.join("; ")}` : ""}.`,
    );
  }
  return live;
}

/**
 * T6b repair (B5): charge one issue-level cycle per member issue when a
 * correction is dispatched. The first failure opens the issue; the charge
 * lands here, so three real fixes are allowed and a fourth is refused by
 * the reducer guard (the dispatch gate pauses before ever reaching it).
 */
function toolProjectId(options: RepairPlanningToolOptions | undefined, runId: string): string {
  return options?.projectId ?? runId;
}

function chargeRepairDispatch(
  store: SchedulerStore,
  runId: string,
  occurredAt: string,
  members: readonly { issueId: string; rootCause: string }[],
  dispatch: { hypothesis: string; evidenceIds: readonly string[]; approachId: string; idempotencyKey: string },
): void {
  for (const member of members) {
    store.append({
      runId,
      type: "repair.cycle_recorded",
      occurredAt,
      actor: { role: "runner", id: "build-runtime" },
      idempotencyKey: `repair-cycle:${member.issueId}:${dispatch.idempotencyKey}:${dispatch.approachId}`,
      payload: {
        issueId: member.issueId,
        hypothesis: dispatch.hypothesis,
        outcome: "dispatched",
        evidenceIds: [...dispatch.evidenceIds],
        approachId: dispatch.approachId,
      },
    });
  }
}

function recordRepairApproachDecisionTool(
  store: SchedulerStore,
  clock: () => string,
  evidenceStore?: EvidenceStore,
): NativeTool<RecordRepairApproachDecisionInput> {
  return lifecycleTool({
    name: "record_repair_approach_decision",
    description: "Persist the Architect repair approach before dispatch; repeats require evidence NEW to the recorded diagnostic set",
    schema: objectSchema({
      issueId: { type: "string", minLength: 1 },
      approachId: { type: "string", minLength: 1 },
      repeat: { type: "boolean" },
      hypothesis: { type: "string", minLength: 1 },
      diagnosticSet: { type: "array", items: { type: "string", minLength: 1 } },
      evidenceIds: { type: "array", items: { type: "string", minLength: 1 } },
    }, ["issueId", "approachId", "repeat", "hypothesis", "diagnosticSet", "evidenceIds"]),
    validate: (input) => validateObject<RecordRepairApproachDecisionInput>(input, (value) => {
      const diagnosticSet = stringList(value.diagnosticSet);
      const evidenceIds = stringList(value.evidenceIds);
      if (!nonEmpty(value.issueId) || !nonEmpty(value.approachId) || typeof value.repeat !== "boolean" ||
          !nonEmpty(value.hypothesis) || !diagnosticSet || !evidenceIds) return null;
      return { issueId: value.issueId, approachId: value.approachId, repeat: value.repeat, hypothesis: value.hypothesis, diagnosticSet, evidenceIds };
    }, "issueId, approachId, repeat, hypothesis, diagnosticSet and evidenceIds are required"),
    execute: async (input, context) => {
      const denied = architectOnly(context);
      if (denied) return denied;
      const projection = rebuildSchedulerProjection(store.readRun(context.runId));
      const issue = projection.repairIssues?.[input.issueId];
      if (!issue) return errorOutput("unknown_repair_issue", "Repair approach requires the current durable issue.");
      // T6b repair (B4): the kernel validates actor, lineage, prior
      // failure, and immutable evidence references here, where the
      // evidence store is available. Every cited id must exist; repeats
      // need evidence NEW to the failed approach's diagnostic set and
      // must not cite the failure's own evidence.
      try {
        const cited = [...new Set([...input.diagnosticSet, ...input.evidenceIds])];
        const known = evidenceStore
          ? evidenceStore.getByIds({ runId: context.runId, ids: cited }).map((record) => record.id)
          : undefined;
        if (known !== undefined) {
          const unknownDiagnostic = input.diagnosticSet.find((id) => !known.includes(id));
          if (unknownDiagnostic) {
            return errorOutput("unknown_evidence", `Repair approach cites unknown diagnostic evidence ${unknownDiagnostic}.`);
          }
        }
        validateRepairApproachDecision({
          actorRole: "architect",
          actorId: context.actor.id,
          decisionActorRole: "architect",
          decisionActorId: context.actor.id,
          priorApproaches: issue.approaches.map((entry) => ({
            approachId: entry.approachId,
            failed: entry.failed,
            hypothesis: entry.hypothesis,
            diagnosticSet: [...entry.diagnosticSet],
            evidenceIds: [...entry.evidenceIds],
            failureEvidenceIds: [...(entry.failureEvidenceIds ?? [])],
          })),
          decision: {
            approachId: input.approachId,
            repeat: input.repeat,
            hypothesis: input.hypothesis,
            diagnosticSet: [...input.diagnosticSet],
            evidenceIds: [...input.evidenceIds],
          },
          ...(known !== undefined ? { knownEvidenceIds: known } : {}),
        });
      } catch (error) {
        return errorOutput("invalid_repair_approach_decision", error instanceof Error ? error.message : String(error));
      }
      // T6b repair (B4): recording the decision does NOT end the turn,
      // so the instructed record-then-plan sequence completes in one
      // turn. The reducer re-validates as a backstop.
      return appendEvent(store, {
        runId: context.runId,
        type: "repair.approach_decided",
        occurredAt: clock(),
        actor: { role: "architect", id: context.actor.id },
        idempotencyKey: `repair-approach:${input.issueId}:${input.approachId}:${input.repeat ? "repeat" : "new"}:${input.evidenceIds.join(",")}`,
        payload: {
          issueId: input.issueId,
          approachId: input.approachId,
          repeat: input.repeat,
          hypothesis: input.hypothesis,
          diagnosticSet: [...input.diagnosticSet],
          evidenceIds: [...input.evidenceIds],
        },
      });
    },
  });
}

interface RecordExternalBlockerInput {
  issueId: string;
  acceptanceCondition: string;
  evidence: string[];
  attemptedResolutions: string[];
  requiredOwnerAction: string;
}

function recordExternalBlockerTool(
  store: SchedulerStore,
  clock: () => string,
  evidenceStore?: EvidenceStore,
): NativeTool<RecordExternalBlockerInput> {
  return lifecycleTool({
    name: "record_external_blocker",
    description: "Record a proven external blocker for a repair issue with its exact acceptance condition, evidence, attempted resolutions and required owner action",
    schema: objectSchema({
      issueId: { type: "string", minLength: 1 },
      acceptanceCondition: { type: "string", minLength: 1 },
      evidence: { type: "array", items: { type: "string", minLength: 1 } },
      attemptedResolutions: { type: "array", items: { type: "string", minLength: 1 } },
      requiredOwnerAction: { type: "string", minLength: 1 },
    }, ["issueId", "acceptanceCondition", "evidence", "attemptedResolutions", "requiredOwnerAction"]),
    validate: (input) => validateObject<RecordExternalBlockerInput>(input, (value) => {
      const evidence = stringList(value.evidence);
      const attemptedResolutions = stringList(value.attemptedResolutions);
      if (!nonEmpty(value.issueId) || !nonEmpty(value.acceptanceCondition) ||
          !evidence || evidence.length === 0 || !attemptedResolutions || attemptedResolutions.length === 0 ||
          !nonEmpty(value.requiredOwnerAction)) return null;
      return { issueId: value.issueId, acceptanceCondition: value.acceptanceCondition, evidence, attemptedResolutions, requiredOwnerAction: value.requiredOwnerAction };
    }, "issueId, acceptanceCondition, non-empty evidence and attemptedResolutions, and requiredOwnerAction are required"),
    execute: async (input, context) => {
      const denied = architectOnly(context);
      if (denied) return denied;
      const projection = rebuildSchedulerProjection(store.readRun(context.runId));
      const issue = projection.repairIssues?.[input.issueId];
      if (!issue) return errorOutput("unknown_repair_issue", "External blocker requires the current durable issue.");
      // T6b repair (N7): blocker evidence must exist in the evidence store.
      if (evidenceStore) {
        const known = new Set(evidenceStore.getByIds({ runId: context.runId, ids: input.evidence }).map((record) => record.id));
        const fabricated = input.evidence.find((id) => !known.has(id));
        if (fabricated !== undefined) return errorOutput("unknown_evidence", `External blocker cites unknown evidence id ${fabricated}.`);
      }
      return appendEvent(store, {
        runId: context.runId,
        type: "repair.external_blocker_recorded",
        occurredAt: clock(),
        actor: { role: "architect", id: context.actor.id },
        idempotencyKey: `repair-blocker:${input.issueId}`,
        payload: {
          issueId: input.issueId,
          acceptanceCondition: input.acceptanceCondition,
          evidence: [...input.evidence],
          attemptedResolutions: [...input.attemptedResolutions],
          requiredOwnerAction: input.requiredOwnerAction,
        },
      }, {
        type: "architect_action",
        action: "verification_repairs_planned",
        referenceId: input.issueId,
      });
    },
  });
}

function planVerifierRepairsTool(
  store: SchedulerStore,
  clock: () => string,
  toolOptions?: RepairPlanningToolOptions,
): NativeTool<PlanVerifierRepairsInput> {
  return lifecycleTool({
    name: "plan_verifier_repairs",
    description:
      "Atomically create narrowly scoped worker tasks for every criterion rejected by the current independent verifier",
    schema: objectSchema({
      reviewId: { type: "string", minLength: 1 },
      targetRevision: { type: "string", minLength: 1 },
      tasks: {
        type: "array",
        minItems: 1,
        items: objectSchema({
          id: { type: "string", minLength: 1 },
          objective: { type: "string", minLength: 1 },
          criteria: {
            type: "array",
            minItems: 1,
            items: objectSchema({
              taskId: { type: "string", minLength: 1 },
              criterionId: { type: "string", minLength: 1 },
            }, ["taskId", "criterionId"]),
          },
          evidenceIds: { type: "array", items: { type: "string", minLength: 1 } },
          dependencies: { type: "array", items: { type: "string", minLength: 1 } },
          requiredCapabilities: {
            type: "array",
            minItems: 1,
            items: { type: "string", minLength: 1 },
          },
          acceptanceCriteria: {
            type: "array",
            minItems: 1,
            items: criterionSchema(),
          },
        }, [
          "id",
          "objective",
          "criteria",
          "evidenceIds",
          "dependencies",
          "requiredCapabilities",
          "acceptanceCriteria",
        ]),
      },
    }, ["reviewId", "targetRevision", "tasks"]),
    validate: validateVerifierRepairPlan,
    execute: async (input, context) => {
      const denied = architectOnly(context);
      if (denied) return denied;
      const projection = rebuildSchedulerProjection(store.readRun(context.runId));
      const current = projection.verifier?.current;
      if (
        !current || current.state !== "current" ||
        current.status !== "submitted" || current.verdict?.satisfied !== false ||
        current.reviewId !== input.reviewId ||
        current.targetRevision !== input.targetRevision ||
        projection.integrationRevision !== input.targetRevision
      ) {
        return errorOutput(
          "stale_verifier_repair_plan",
          "Verifier repairs must reference the current unsatisfied independent verdict.",
        );
      }
      if (current.repairTaskIds) {
        if (verifierRepairPlanMatches(
          projection.tasks,
          current.repairTaskIds,
          input.tasks,
        )) {
          return {
            content: [{
              type: "json",
              value: { repairTaskIds: [...current.repairTaskIds] },
            }],
            isError: false,
            lifecycle: {
              type: "architect_action",
              action: "verification_repairs_planned",
              referenceId: current.reviewId,
            },
          };
        }
        return errorOutput(
          "conflicting_verifier_repair_plan",
          "Verifier repairs already have a conflicting durable plan.",
        );
      }
      // T6b repair (B4/B5): require a live recorded decision for every
      // member criterion issue and charge one cycle per member on
      // dispatch. Legacy runs bypass the gate and the charge unchanged.
      if (projection.planningPolicyVersion === 1) {
        const members = repairMemberIssues(toolProjectId(toolOptions, context.runId), input.tasks.flatMap((task) => task.criteria.map((criterion) => `verifier:${criterion.taskId}:${criterion.criterionId}`)));
        const taskEvidence = [...new Set(input.tasks.flatMap((task) => task.evidenceIds))];
        // T6b repair (N7): repair tasks cite durable evidence.
        if (toolOptions?.evidenceStore) {
          const known = new Set(toolOptions.evidenceStore.getByIds({ runId: context.runId, ids: taskEvidence }).map((record) => record.id));
          const fabricated = taskEvidence.find((id) => !known.has(id));
          if (fabricated !== undefined) return errorOutput("unknown_evidence", `Repair tasks cite unknown evidence id ${fabricated}.`);
        }
        // T6b repair (R4-B1): validate EVERY member before charging ANY
        // (same partial-dispatch deadlock as the final-verification loop).
        const validated: Array<{ member: (typeof members)[number]; live: { approachId: string; hypothesis: string; evidenceIds: string[] }; evidenceIds: string[] }> = [];
        for (const member of members) {
          const issue = projection.repairIssues?.[member.issueId];
          if (issue?.externalBlocker) {
            return errorOutput("repair_external_blocker", `Issue ${member.rootCause} has a recorded external blocker; no futile dispatch.`);
          }
          if (issue && issue.used >= issue.limit) {
            return errorOutput("repair_issue_budget_exhausted", `Issue ${member.rootCause} used ${issue.used}/${issue.limit} repair cycles.`);
          }
          const live = requireLiveRepairDecision(issue, member.issueId, member.rootCause);
          if ("isError" in live) return live;
          const evidenceIds = [...new Set([...live.evidenceIds, ...taskEvidence])];
          if (evidenceIds.length === 0) {
            return errorOutput("repair_charge_evidence_required", `Dispatch for ${member.rootCause} requires durable evidence.`);
          }
          validated.push({ member, live, evidenceIds });
        }
        for (const { member, live, evidenceIds } of validated) {
          chargeRepairDispatch(store, context.runId, clock(), [member], {
            hypothesis: live.hypothesis,
            evidenceIds,
            approachId: live.approachId,
            idempotencyKey: current.reviewId,
          });
        }
      }
      return appendEvent(store, {
        runId: context.runId,
        type: "verifier.repairs_planned",
        occurredAt: clock(),
        actor: { role: "architect", id: context.actor.id },
        idempotencyKey: `verifier-repairs:${current.reviewId}`,
        payload: {
          reviewId: input.reviewId,
          targetRevision: input.targetRevision,
          revision: projection.planRevision + 1,
          tasks: input.tasks.map((task) => ({
            ...task,
            criteria: task.criteria.map((criterion) => ({ ...criterion })),
            evidenceIds: [...task.evidenceIds],
            dependencies: [...task.dependencies],
            requiredCapabilities: [...task.requiredCapabilities],
            acceptanceCriteria: task.acceptanceCriteria.map((criterion) => ({ ...criterion })),
          })),
        },
      }, {
        type: "architect_action",
        action: "verification_repairs_planned",
        referenceId: current.reviewId,
      });
    },
  });
}

interface ResolveDeliveryBoundaryFailureInput {
  taskId: string;
  boundaryId: string;
  resolution: "recheck" | "repair_planned";
  rationale: string;
  tasks?: Array<{
    id: string;
    objective: string;
    dependencies: string[];
    requiredCapabilities: string[];
    acceptanceCriteria: AcceptanceCriterion[];
  }>;
}

/**
 * T6a (B3/B4): the Architect's legal responses to a failed or unknown
 * integrated-boundary check. `recheck` grants one more run on the same
 * integration revision (once per revision); `repair_planned` creates repair
 * tasks bound to the failed task's parent contract. The task stays
 * `integrated` and unaccepted until a later boundary passes.
 */
function resolveDeliveryBoundaryFailureTool(
  store: SchedulerStore,
  clock: () => string,
  toolOptions?: RepairPlanningToolOptions,
): NativeTool<ResolveDeliveryBoundaryFailureInput> {
  return lifecycleTool({
    name: "resolve_delivery_boundary_failure",
    description:
      "Resolve a failed or unknown post-integration boundary check: recheck once on the same revision, or plan repair tasks",
    schema: objectSchema({
      taskId: { type: "string", minLength: 1 },
      boundaryId: { type: "string", minLength: 1 },
      resolution: { type: "string", enum: ["recheck", "repair_planned"] },
      rationale: { type: "string", minLength: 1 },
      tasks: { type: "array", minItems: 1, items: taskSchema() },
    }, ["taskId", "boundaryId", "resolution", "rationale"]),
    validate: (input) => validateObject(input, (value) => {
      if (!nonEmpty(value.taskId) || !nonEmpty(value.boundaryId) || !nonEmpty(value.rationale)) return null;
      if (value.resolution !== "recheck" && value.resolution !== "repair_planned") return null;
      if (value.resolution === "recheck") {
        if (value.tasks !== undefined) return null;
        return {
          taskId: value.taskId,
          boundaryId: value.boundaryId,
          resolution: "recheck" as const,
          rationale: value.rationale,
        };
      }
      if (!Array.isArray(value.tasks) || value.tasks.length === 0) return null;
      const tasks: NonNullable<ResolveDeliveryBoundaryFailureInput["tasks"]> = [];
      for (const candidate of value.tasks) {
        if (!isRecord(candidate) || !nonEmpty(candidate.id) || !nonEmpty(candidate.objective)) return null;
        const dependencies = stringList(candidate.dependencies);
        const requiredCapabilities = stringList(candidate.requiredCapabilities);
        const acceptanceCriteria = parseAcceptanceCriteria(candidate.acceptanceCriteria);
        if (!dependencies || !requiredCapabilities || !acceptanceCriteria) return null;
        tasks.push({ id: candidate.id, objective: candidate.objective, dependencies, requiredCapabilities, acceptanceCriteria });
      }
      return {
        taskId: value.taskId,
        boundaryId: value.boundaryId,
        resolution: "repair_planned" as const,
        rationale: value.rationale,
        tasks,
      };
    }, "taskId, boundaryId, resolution, rationale, and repair tasks for repair_planned are required"),
    execute: async (input, context) => {
      const denied = architectOnly(context);
      if (denied) return denied;
      const projection = rebuildSchedulerProjection(store.readRun(context.runId));
      const boundary = latestBoundary(projection.delivery, input.taskId);
      const resolutionGeneration = boundary?.boundaryId === input.boundaryId
        ? boundaryResolutionGeneration(boundary)
        : 1;
      // T6b repair (B4/B5): a repair_planned resolution is a repair
      // dispatch: require a live recorded decision per failed check and
      // charge one cycle per member. Rechecks plan no correction and
      // charge nothing. Legacy runs bypass the gate and the charge.
      if (projection.planningPolicyVersion === 1 && input.resolution === "repair_planned" && input.tasks) {
        // T6b repair (R4-B1/NB-1): validate the resolution itself BEFORE any
        // charge — a resolve for a stale boundary, a consumed generation, or
        // an already-resolved boundary must refuse with nothing charged.
        const resolvable = boundary !== undefined &&
          boundary.boundaryId === input.boundaryId &&
          boundaryNeedsArchitect(boundary, (id) => projection.tasks[id]?.status) &&
          boundary.integrationRevision === projection.integrationRevision &&
          projection.tasks[input.taskId]?.status === "integrated" &&
          projection.delivery?.taskAcceptances[input.taskId] === undefined &&
          resolutionGeneration === boundaryResolutionGeneration(boundary);
        if (!resolvable) {
          return errorOutput(
            "stale_delivery_boundary_resolution",
            "Only the current failed boundary awaiting the Architect can be resolved.",
          );
        }
        // T6b repair (R3-B1): per-task, per-check keys via the shared
        // helper — the same identity the kernel opened before this turn.
        const failedChecks = (boundary?.checks ?? []).filter((check) => check.outcome !== "passed");
        const failedKeys = failedChecks.length > 0 ? failedChecks.map((check) => deliveryBoundaryRootCause({ taskId: input.taskId, checkId: check.checkId, failingIds: check.report?.failingTestIds })) : [deliveryBoundaryRootCause({ taskId: input.taskId, checkId: input.boundaryId })];
        const members = repairMemberIssues(toolProjectId(toolOptions, context.runId), failedKeys);
        const checkEvidence = [...new Set(failedChecks.flatMap((check) => check.evidenceIds))];
        // T6b repair (R4-B1): validate EVERY member before charging ANY
        // (same partial-dispatch deadlock as the other two loops).
        const validated: Array<{ member: (typeof members)[number]; live: { approachId: string; hypothesis: string; evidenceIds: string[] }; evidenceIds: string[] }> = [];
        for (const member of members) {
          const issue = projection.repairIssues?.[member.issueId];
          if (issue?.externalBlocker) {
            return errorOutput("repair_external_blocker", `Issue ${member.rootCause} has a recorded external blocker; no futile dispatch.`);
          }
          if (issue && issue.used >= issue.limit) {
            return errorOutput("repair_issue_budget_exhausted", `Issue ${member.rootCause} used ${issue.used}/${issue.limit} repair cycles.`);
          }
          const live = requireLiveRepairDecision(issue, member.issueId, member.rootCause);
          if ("isError" in live) return live;
          const evidenceIds = [...new Set([...live.evidenceIds, ...checkEvidence])];
          if (evidenceIds.length === 0) {
            return errorOutput("repair_charge_evidence_required", `Dispatch for ${member.rootCause} requires durable evidence.`);
          }
          validated.push({ member, live, evidenceIds });
        }
        for (const { member, live, evidenceIds } of validated) {
          chargeRepairDispatch(store, context.runId, clock(), [member], {
            hypothesis: live.hypothesis,
            evidenceIds,
            approachId: live.approachId,
            idempotencyKey: `${input.boundaryId}:${resolutionGeneration}`,
          });
        }
      }
      return appendEvent(store, {
        runId: context.runId,
        type: "delivery.boundary_failure_resolved",
        occurredAt: clock(),
        actor: { role: "architect", id: context.actor.id },
        idempotencyKey: `delivery-boundary-resolution:${input.boundaryId}:${resolutionGeneration}`,
        payload: {
          taskId: input.taskId,
          boundaryId: input.boundaryId,
          resolutionGeneration,
          resolution: input.resolution,
          rationale: input.rationale,
          ...(input.tasks
            ? {
                revision: projection.planRevision + 1,
                tasks: input.tasks.map((task) => ({
                  ...task,
                  dependencies: [...task.dependencies],
                  requiredCapabilities: [...task.requiredCapabilities],
                  acceptanceCriteria: task.acceptanceCriteria.map((criterion) => ({ ...criterion })),
                })),
              }
            : {}),
        },
      }, {
        type: "architect_action",
        action: "delivery_boundary_failure_resolved",
        referenceId: input.boundaryId,
      });
    },
  });
}

function validateVerifierRepairPlan(
  input: unknown,
): ValidationResult<PlanVerifierRepairsInput> {
  return validateObject(input, (value) => {
    if (
      !nonEmpty(value.reviewId) || !nonEmpty(value.targetRevision) ||
      !Array.isArray(value.tasks) || value.tasks.length === 0
    ) return null;
    const tasks: VerifierRepairTaskInput[] = [];
    for (const candidate of value.tasks) {
      if (
        !isRecord(candidate) || !nonEmpty(candidate.id) ||
        !nonEmpty(candidate.objective) || !Array.isArray(candidate.criteria) ||
        candidate.criteria.length === 0
      ) return null;
      const criteria: Array<{ taskId: string; criterionId: string }> = [];
      for (const item of candidate.criteria) {
        if (!isRecord(item) || !nonEmpty(item.taskId) || !nonEmpty(item.criterionId)) {
          return null;
        }
        criteria.push({ taskId: item.taskId, criterionId: item.criterionId });
      }
      const criterionKeys = criteria.map(
        (criterion) => `${criterion.taskId}\u0000${criterion.criterionId}`,
      );
      const evidenceIds = stringList(candidate.evidenceIds);
      const dependencies = stringList(candidate.dependencies);
      const requiredCapabilities = stringList(candidate.requiredCapabilities);
      const acceptanceCriteria = parseAcceptanceCriteria(candidate.acceptanceCriteria);
      if (
        new Set(criterionKeys).size !== criterionKeys.length ||
        !evidenceIds || new Set(evidenceIds).size !== evidenceIds.length ||
        !dependencies || !requiredCapabilities || requiredCapabilities.length === 0 ||
        !acceptanceCriteria
      ) return null;
      tasks.push({
        id: candidate.id,
        objective: candidate.objective,
        criteria: criteria.sort((left, right) =>
          left.taskId.localeCompare(right.taskId) ||
          left.criterionId.localeCompare(right.criterionId)
        ),
        evidenceIds: [...evidenceIds].sort(),
        dependencies: [...dependencies].sort(),
        requiredCapabilities: [...requiredCapabilities].sort(),
        acceptanceCriteria,
      });
    }
    if (new Set(tasks.map((task) => task.id)).size !== tasks.length) return null;
    return {
      reviewId: value.reviewId,
      targetRevision: value.targetRevision,
      tasks: tasks.sort((left, right) => left.id.localeCompare(right.id)),
    };
  }, "current verifier provenance and at least one valid scoped repair task are required");
}

function verifierRepairPlanMatches(
  tasks: Record<string, BuildTask>,
  ids: readonly string[],
  proposed: readonly VerifierRepairTaskInput[],
): boolean {
  if (ids.length !== proposed.length) return false;
  return proposed.every((candidate) => {
    const task = tasks[candidate.id];
    return task?.kind === "verification_repair" &&
      task.objective === candidate.objective &&
      JSON.stringify(task.dependencies) === JSON.stringify(candidate.dependencies) &&
      JSON.stringify(task.requiredCapabilities) ===
        JSON.stringify(candidate.requiredCapabilities) &&
      JSON.stringify(task.acceptanceCriteria) ===
        JSON.stringify(candidate.acceptanceCriteria) &&
      JSON.stringify(task.verifierRepair?.criteria) ===
        JSON.stringify(candidate.criteria) &&
      JSON.stringify(task.verifierRepair?.evidenceIds) ===
        JSON.stringify(candidate.evidenceIds);
  });
}

function reviewFinalVerificationTool(
  store: SchedulerStore,
  clock: () => string,
  evidenceStore?: EvidenceStore,
): NativeTool<ReviewFinalVerificationInput> {
  return lifecycleTool({
    name: "review_final_verification",
    description: "Record the Architect's category-level semantic decision for the current verified integration revision",
    schema: objectSchema({
      taskId: { type: "string", minLength: 1 },
      generationId: { type: "string", minLength: 1 },
      targetRevision: { type: "string", minLength: 1 },
      submissionId: { type: "string", minLength: 1 },
      attempt: { type: "integer", minimum: 1 },
      decision: { type: "string", enum: ["approved", "repair_required"] },
      summary: { type: "string", minLength: 1 },
      architectRisk: { type: "string", enum: ["low", "high"] },
      architectRiskRationale: { type: "string", minLength: 1 },
      categoryReviews: {
        type: "array",
        minItems: FINAL_VERIFICATION_CATEGORIES.length,
        maxItems: FINAL_VERIFICATION_CATEGORIES.length,
        items: objectSchema({
          category: { type: "string", enum: [...FINAL_VERIFICATION_CATEGORIES] },
          verdict: { type: "string", enum: ["approved", "repair_required"] },
          rationale: { type: "string", minLength: 1 },
          evidenceIds: {
            type: "array",
            items: { type: "string", minLength: 1 },
          },
        }, ["category", "verdict", "rationale", "evidenceIds"]),
      },
    }, [
      "taskId",
      "generationId",
      "targetRevision",
      "submissionId",
      "attempt",
      "decision",
      "summary",
      "architectRisk",
      "architectRiskRationale",
      "categoryReviews",
    ]),
    validate: validateFinalVerificationReview,
    execute: async (input, context) => {
      const denied = architectOnly(context);
      if (denied) return denied;
      const projection = rebuildSchedulerProjection(store.readRun(context.runId));
      const current = projection.finalVerification?.current;
      if (
        !current ||
        current.taskId !== input.taskId ||
        current.generationId !== input.generationId ||
        current.targetRevision !== input.targetRevision ||
        current.targetRevision !== projection.integrationRevision
      ) {
        return errorOutput(
          "stale_final_verification_review",
          "Final verification review must reference the current generation and integration revision.",
        );
      }
      if (
        !current.submission ||
        current.submission.submissionId !== input.submissionId ||
        current.submission.attempt !== input.attempt ||
        !current.submissionResult ||
        current.submissionResult.green !== true
      ) {
        return errorOutput(
          "final_verification_submission_not_green",
          "Final verification review requires the current fully executed mechanically green submission.",
        );
      }
      if (!current.review || current.review.status !== "requested") {
        if (
          current.review?.status === input.decision &&
          current.review.decision &&
          sameSemanticReview(current.review.decision, input)
        ) {
          return {
            content: [{ type: "json", value: current.review }],
            isError: false,
            lifecycle: {
              type: "architect_action",
              action: "final_verification_review_decided",
              referenceId: input.generationId,
            },
          };
        }
        return errorOutput(
          "final_verification_review_unavailable",
          "Final verification review is not currently requested or was already decided differently.",
        );
      }
      const checks = new Map(
        current.submissionResult.checks.map((check) => [check.category, check]),
      );
      for (const review of input.categoryReviews) {
        const check = checks.get(review.category);
        if (!check || !check.green) {
          return errorOutput(
            "final_verification_check_not_green",
            `Final verification category ${review.category} is not mechanically green.`,
          );
        }
        const expected = [...check.evidenceIds].sort();
        const cited = [...new Set(review.evidenceIds)].sort();
        if (check.status === "required" && expected.length === 0) {
          return errorOutput(
            "missing_final_verification_evidence",
            `Required final verification category ${review.category} has no persisted evidence.`,
          );
        }
        if (JSON.stringify(expected) !== JSON.stringify(cited)) {
          return errorOutput(
            "invalid_final_verification_evidence",
            `Final verification category ${review.category} cites unknown or incomplete evidence.`,
          );
        }
      }
      const evidenceIds = input.categoryReviews.flatMap((review) => review.evidenceIds);
      if (evidenceIds.length > 0) {
        if (!evidenceStore) {
          return errorOutput("evidence_store_required", "Final verification review requires the durable evidence store.");
        }
        const records = evidenceStore.getByIds({
          runId: context.runId,
          taskId: current.taskId,
          ids: [...new Set(evidenceIds)],
        });
        if (records.length !== new Set(evidenceIds).size) {
          return errorOutput(
            "invalid_final_verification_evidence",
            "Final verification review cites missing or foreign evidence.",
          );
        }
      }
      return appendFinalVerificationReview(store, clock, context, input);
    },
  });
}

function appendFinalVerificationReview(
  store: SchedulerStore,
  clock: () => string,
  context: ToolExecutionContext,
  input: ReviewFinalVerificationInput,
): ToolExecutionOutput {
  return appendEvent(store, {
    runId: context.runId,
    type: "final_verification.review_decided",
    occurredAt: clock(),
    actor: { role: "architect", id: context.actor.id },
    idempotencyKey: `final-verification-review:${input.generationId}`,
    payload: {
      ...input,
      reviewId: `final-verification-review:${input.generationId}`,
      categoryReviews: input.categoryReviews.map((review) => ({
        ...review,
        evidenceIds: [...review.evidenceIds],
      })),
    },
  }, {
    type: "architect_action",
    action: "final_verification_review_decided",
    referenceId: input.generationId,
  });
}

function validateFinalVerificationReview(
  input: unknown,
): ValidationResult<ReviewFinalVerificationInput> {
  return validateObject(input, (value) => {
    if (
      !nonEmpty(value.taskId) ||
      !nonEmpty(value.generationId) ||
      !nonEmpty(value.targetRevision) ||
      !nonEmpty(value.submissionId) ||
      !positiveInteger(value.attempt) ||
      (value.decision !== "approved" && value.decision !== "repair_required") ||
      !nonEmpty(value.summary) ||
      (value.architectRisk !== "low" && value.architectRisk !== "high") ||
      !nonEmpty(value.architectRiskRationale) ||
      !Array.isArray(value.categoryReviews)
    ) return null;
    const categoryReviews: FinalVerificationCategoryReviewInput[] = [];
    for (const candidate of value.categoryReviews) {
      if (!isRecord(candidate)) return null;
      if (!FINAL_VERIFICATION_CATEGORIES.includes(candidate.category as FinalVerificationCategory)) return null;
      if (candidate.verdict !== "approved" && candidate.verdict !== "repair_required") return null;
      if (!nonEmpty(candidate.rationale)) return null;
      const evidenceIds = stringList(candidate.evidenceIds);
      if (!evidenceIds || new Set(evidenceIds).size !== evidenceIds.length) return null;
      categoryReviews.push({
        category: candidate.category as FinalVerificationCategory,
        verdict: candidate.verdict,
        rationale: candidate.rationale,
        evidenceIds,
      });
    }
    if (
      categoryReviews.length !== FINAL_VERIFICATION_CATEGORIES.length ||
      new Set(categoryReviews.map((review) => review.category)).size !== FINAL_VERIFICATION_CATEGORIES.length
    ) return null;
    const reviewsByCategory = new Map(
      categoryReviews.map((review) => [review.category, review]),
    );
    const canonicalCategoryReviews = FINAL_VERIFICATION_CATEGORIES.map(
      (category) => reviewsByCategory.get(category)!,
    );
    const repairCount = canonicalCategoryReviews.filter(
      (review) => review.verdict === "repair_required",
    ).length;
    if (
      (value.decision === "approved" && repairCount > 0) ||
      (value.decision === "repair_required" && repairCount === 0)
    ) return null;
    return {
      taskId: value.taskId,
      generationId: value.generationId,
      targetRevision: value.targetRevision,
      submissionId: value.submissionId,
      attempt: value.attempt,
      decision: value.decision,
      summary: value.summary,
      architectRisk: value.architectRisk,
      architectRiskRationale: value.architectRiskRationale,
      categoryReviews: canonicalCategoryReviews,
    };
  }, "current final verification identity, decision, summary, and exactly one valid review per category are required");
}

function sameSemanticReview(
  decision: import("./scheduler-store.js").FinalVerificationReviewDecisionProjection,
  input: ReviewFinalVerificationInput,
): boolean {
  return decision.decision === input.decision &&
    decision.summary === input.summary &&
    decision.targetRevision === input.targetRevision &&
    decision.architectRisk.risk === input.architectRisk &&
    decision.architectRisk.rationale === input.architectRiskRationale &&
    decision.architectRisk.source === "architect" &&
    JSON.stringify(decision.categoryReviews) === JSON.stringify(input.categoryReviews);
}

function planFinalVerificationTool(
  store: SchedulerStore,
  clock: () => string,
  profileFor?: ArchitectToolsOptions["finalVerificationProfileFor"],
  discardProfile?: ArchitectToolsOptions["discardFinalVerificationProfile"],
): NativeTool<PlanFinalVerificationInput> {
  return lifecycleTool({
    name: "plan_final_verification",
    description: "Create the kernel-owned final-verification generation for the current canonical integration revision",
    schema: objectSchema({ plan: finalVerificationPlanSchema() }, ["plan"]),
    validate: (input) => validateObject(input, (value) => {
      const validation = validateFinalVerificationPlan(value.plan);
      if (!validation.valid) return null;
      return { plan: canonicalFinalVerificationPlan(planFinalVerification(value.plan)) };
    }, "plan must explicitly and validly represent build, tests, runtime_smoke, and browser"),
    execute: async (input, context) => {
      const denied = architectOnly(context);
      if (denied) return denied;
      const projection = rebuildSchedulerProjection(store.readRun(context.runId));
      const implementationTasks = Object.values(projection.tasks).filter(
        (task) => task.kind !== "final_verification",
      );
      if (
        implementationTasks.some(
          (task) => task.status !== "integrated" && task.status !== "cancelled",
        )
      ) {
        return errorOutput(
          "implementation_tasks_not_terminal",
          "Final verification cannot be planned until every implementation task is integrated or cancelled.",
        );
      }
      if (!projection.integrationRevision) {
        return errorOutput(
          "integration_revision_required",
          "Final verification requires a canonical integration revision.",
        );
      }
      if (!profileFor) {
        return errorOutput(
          "final_verification_profile_unavailable",
          "Final verification requires a runner-owned exact-revision execution profile authority.",
        );
      }
      let executionProfile: FinalVerificationExecutionProfile;
      try {
        executionProfile = cloneFinalVerificationExecutionProfile(
          await profileFor(projection.integrationRevision),
        );
      } catch (error) {
        return errorOutput(
          "final_verification_profile_unavailable",
          error instanceof Error ? error.message : String(error),
        );
      }
      const authoritativeValidation = validateFinalVerificationPlan(input.plan, {
        detectedSignals: executionProfile.detectedSignals,
      });
      if (!authoritativeValidation.valid) {
        if (discardProfile) {
          try { await discardProfile(executionProfile); }
          catch (error) {
            return errorOutput(
              "final_verification_profile_cleanup_failed",
              error instanceof Error ? error.message : String(error),
            );
          }
        }
        return errorOutput(
          "final_verification_plan_conflicts_with_repository",
          authoritativeValidation.issues.join(" "),
        );
      }
      const revisionKey = shortHash(projection.integrationRevision);
      const planVersion = (projection.finalVerification?.history.length ?? 0) + 1;
      const generationSuffix = planVersion === 1 ? "" : `-${planVersion}`;
      try {
        const output = appendEvent(store, {
          runId: context.runId,
          type: "final_verification.generation_created",
          occurredAt: clock(),
          actor: { role: "runner", id: "build-runtime" },
          idempotencyKey: `final-verification-plan:${projection.integrationRevision}${generationSuffix}`,
          payload: {
            taskId: `final-verification-${revisionKey}${generationSuffix}`,
            generationId: `final-verification-generation-${revisionKey}${generationSuffix}`,
            targetRevision: projection.integrationRevision,
            planVersion,
            plan: input.plan,
            executionProfile,
          },
        }, {
          type: "architect_action",
          action: "final_verification_planned",
          referenceId: projection.integrationRevision,
        });
        if (output.isError && discardProfile) {
          try { await discardProfile(executionProfile); }
          catch (error) {
            return errorOutput(
              "final_verification_profile_cleanup_failed",
              error instanceof Error ? error.message : String(error),
            );
          }
        }
        return output;
      } catch (error) {
        if (discardProfile) await discardProfile(executionProfile);
        throw error;
      }
    },
  });
}

function canonicalFinalVerificationPlan(plan: FinalVerificationPlan): FinalVerificationPlan {
  const checks = new Map(plan.checks.map((check) => [check.category, check]));
  return {
    checks: FINAL_VERIFICATION_CATEGORIES.map((category) => checks.get(category)!),
  };
}

function upgradeAcceptanceContractTool(
  store: SchedulerStore,
  clock: () => string
): NativeTool<AcceptanceContractUpgradeInput> {
  return lifecycleTool({
    name: "upgrade_acceptance_contract",
    description: "Record structured acceptance criteria for every non-cancelled task in a legacy in-flight run",
    schema: objectSchema({
      revision: { type: "integer", minimum: 1 },
      criteriaByTask: {
        type: "array",
        minItems: 1,
        items: objectSchema({
          taskId: { type: "string", minLength: 1 },
          acceptanceCriteria: {
            type: "array",
            minItems: 1,
            items: criterionSchema(),
          },
        }, ["taskId", "acceptanceCriteria"]),
      },
    }, ["revision", "criteriaByTask"]),
    validate: validateAcceptanceContractUpgrade,
    execute: async (input, context) => {
      const denied = architectOnly(context);
      if (denied) return denied;
      return appendEvent(store, {
        runId: context.runId,
        type: "acceptance_contract.upgraded",
        occurredAt: clock(),
        actor: { role: "architect", id: context.actor.id },
        idempotencyKey: `acceptance-contract-upgrade:${input.revision}`,
        payload: {
          revision: input.revision,
          criteriaByTask: input.criteriaByTask.map((entry) => ({
            taskId: entry.taskId,
            acceptanceCriteria: entry.acceptanceCriteria.map((criterion) => ({ ...criterion })),
          })),
        },
      }, {
        type: "architect_action",
        action: "acceptance_contract_upgraded",
        referenceId: String(input.revision),
      });
    },
  });
}

function reconcilePlanTool(
  store: SchedulerStore,
  clock: () => string
): NativeTool<PlanReconciliation> {
  return lifecycleTool({
    name: "reconcile_plan",
    description: "Atomically cancel or revise stale pending tasks and rewire their dependencies when current evidence invalidates the existing plan",
    schema: planReconciliationSchema(),
    validate: validatePlanReconciliation,
    execute: async (input, context) => {
      const denied = architectOnly(context);
      if (denied) return denied;
      const answered = answeredRunRefused(store, context.runId, "reconcile the plan");
      if (answered) return answered;
      const notReady = newPolicyPlanNotReady(store, context.runId);
      if (notReady) return notReady;
      return appendEvent(store, {
        runId: context.runId,
        type: "plan.reconciled",
        occurredAt: clock(),
        actor: { role: "architect", id: context.actor.id },
        idempotencyKey: `plan-reconciliation:${input.revision}:${shortHash(input.summary)}`,
        payload: { ...input },
      }, {
        type: "architect_action",
        action: "plan_reconciled",
        referenceId: String(input.revision),
      });
    },
  });
}

function planTasksTool(
  store: SchedulerStore,
  clock: () => string
): NativeTool<PlanTasksInput> {
  return lifecycleTool({
    name: "plan_tasks",
    description: "Create the Architect-owned task graph; only graph mechanics are validated; declare riskDeclaration low or high with a rationale",
    schema: {
      type: "object",
      properties: {
        revision: { type: "integer", minimum: 1 },
        tasks: { type: "array", items: taskSchema() },
        riskDeclaration: objectSchema({
          risk: { enum: ["low", "high"] },
          rationale: { type: "string", minLength: 1 },
        }, ["risk", "rationale"]),
      },
      required: ["revision", "tasks"],
      additionalProperties: false,
    },
    validate: validatePlan,
    execute: async (input, context) => {
      const denied = architectOnly(context);
      if (denied) return denied;
      const answered = answeredRunRefused(store, context.runId, "create tasks");
      if (answered) return answered;
      const notReady = newPolicyPlanNotReady(store, context.runId);
      if (notReady) return notReady;
      const tasks: BuildTask[] = input.tasks.map((task) => ({
        ...task,
        dependencies: [...task.dependencies],
        requiredCapabilities: [...task.requiredCapabilities],
        acceptanceCriteria: task.acceptanceCriteria.map((criterion) => ({ ...criterion })),
        acceptanceCriteriaVersion: 1,
        status: "planned",
        attempt: 0,
      }));
      const validation = validateTaskGraph(tasks, { requireAcceptanceCriteria: true });
      if (!validation.valid) {
        return errorOutput(
          "invalid_task_graph",
          `Plan has mechanical issues: ${validation.issues
            .map((issue) => issue.code)
            .join(", ")}.`,
          validation.issues.map((issue) => issue.message)
        );
      }
      return appendEvent(
        store,
        {
          runId: context.runId,
          type: "plan.created",
          occurredAt: clock(),
          actor: { role: "architect", id: context.actor.id },
          idempotencyKey: `plan:${input.revision}`,
          payload: {
            revision: input.revision,
            tasks,
            ...(input.riskDeclaration ? { riskDeclaration: input.riskDeclaration } : {}),
          },
        },
        {
          type: "architect_action",
          action: "plan_created",
          referenceId: String(input.revision),
        }
      );
    },
  });
}

function reviseTaskTool(
  store: SchedulerStore,
  clock: () => string
): NativeTool<ReviseTaskInput> {
  return lifecycleTool({
    name: "revise_task",
    description: "Revise a task; when it has already been attempted, grant the revised task one fresh attempt without interpreting its semantic intent",
    schema: {
      type: "object",
      properties: {
        taskId: { type: "string", minLength: 1 },
        revision: { type: "integer", minimum: 1 },
        objective: { type: "string", minLength: 1 },
        dependencies: { type: "array", items: { type: "string" } },
        requiredCapabilities: { type: "array", items: { type: "string" } },
        acceptanceCriteria: { type: "array", minItems: 1, items: criterionSchema() },
      },
      required: ["taskId", "revision"],
      additionalProperties: false,
    },
    validate: validateRevision,
    execute: async (input, context) => {
      const denied = architectOnly(context);
      if (denied) return denied;
      const answered = answeredRunRefused(store, context.runId, "revise tasks");
      if (answered) return answered;
      const notReady = newPolicyPlanNotReady(store, context.runId);
      if (notReady) return notReady;
      const patch = {
        ...(input.objective !== undefined ? { objective: input.objective } : {}),
        ...(input.dependencies ? { dependencies: [...input.dependencies] } : {}),
        ...(input.requiredCapabilities
          ? { requiredCapabilities: [...input.requiredCapabilities] }
          : {}),
        ...(input.acceptanceCriteria
          ? { acceptanceCriteria: input.acceptanceCriteria.map((criterion) => ({ ...criterion })) }
          : {}),
      };
      return appendEvent(store, {
        runId: context.runId,
        type: "task.revised",
        occurredAt: clock(),
        actor: { role: "architect", id: context.actor.id },
        idempotencyKey: `task-revision:${input.revision}:${input.taskId}`,
        payload: { taskId: input.taskId, revision: input.revision, patch },
      }, {
        type: "architect_action",
        action: "task_revised",
        referenceId: input.taskId,
      });
    },
  });
}

function answerGuidanceTool(
  store: SchedulerStore,
  clock: () => string
): NativeTool<AnswerGuidanceInput> {
  return lifecycleTool({
    name: "answer_guidance",
    description: "Answer a worker guidance request as the Architect",
    schema: objectSchema({
      requestId: { type: "string", minLength: 1 },
      expectedVersion: { type: "integer", minimum: 1 },
      answer: { type: "string", minLength: 1 },
    }, ["requestId", "expectedVersion", "answer"]),
    validate: (input) => validateObject(input, (value) => {
      if (!nonEmpty(value.requestId) || !positiveInteger(value.expectedVersion) || !nonEmpty(value.answer)) return null;
      return value as unknown as AnswerGuidanceInput;
    }, "requestId, expectedVersion, and answer are required"),
    execute: async (input, context) => {
      const denied = architectOnly(context);
      if (denied) return denied;
      return appendEvent(store, {
        runId: context.runId,
        type: "guidance.answered",
        occurredAt: clock(),
        actor: { role: "architect", id: context.actor.id },
        idempotencyKey: `guidance-answer:${input.requestId}:${input.expectedVersion}:${shortHash(input.answer)}`,
        payload: {
          requestId: input.requestId,
          expectedVersion: input.expectedVersion,
          answer: input.answer,
        },
      }, {
        type: "architect_action",
        action: "guidance_answered",
        referenceId: input.requestId,
      });
    },
  });
}

function reviewTaskTool(
  store: SchedulerStore,
  clock: () => string,
  evidenceStore?: EvidenceStore
): NativeTool<ReviewTaskInput> {
  return lifecycleTool({
    name: "review_task",
    description: "Record the Architect semantic review decision for a submitted task",
    schema: objectSchema({
      taskId: { type: "string", minLength: 1 },
      decision: { type: "string", enum: ["approved", "rejected"] },
      summary: { type: "string", minLength: 1 },
      evidenceArtifactHashes: {
        type: "array",
        items: { type: "string", pattern: "^[a-f0-9]{64}$" },
      },
      criterionVerdicts: {
        type: "array",
        minItems: 1,
        items: criterionReviewVerdictSchema(),
      },
      planReconciliation: planReconciliationSchema(),
      findingDispositions: {
        type: "array",
        items: objectSchema({
          findingId: { type: "string", minLength: 1 },
          resolution: { type: "string", enum: ["plan_reconciled", "rejected", "deferred"] },
          rationale: { type: "string", minLength: 1 },
        }, ["findingId", "resolution", "rationale"]),
      },
      claimDispositions: {
        type: "array",
        items: objectSchema({
          claimId: { type: "string", minLength: 1 },
          status: { type: "string", enum: ["verified"] },
          rationale: { type: "string", minLength: 1 },
        }, ["claimId", "status", "rationale"]),
      },
    }, ["taskId", "decision", "summary", "evidenceArtifactHashes"]),
    validate: validateReview,
    execute: async (input, context) => {
      const denied = architectOnly(context);
      if (denied) return denied;
      const projection = rebuildSchedulerProjection(store.readRun(context.runId));
      if (
        projection.acceptanceContractStatus ===
        "acceptance_contract_upgrade_required"
      ) {
        return errorOutput(
          "acceptance_contract_upgrade_required",
          "Task review is blocked until the Architect upgrades acceptance criteria for every non-cancelled task."
        );
      }
      const answered = answeredRunRefused(store, context.runId, "review tasks");
      if (answered) return answered;
      const task = projection.tasks[input.taskId];
      if (!task) return errorOutput("unknown_task", `Unknown task ${input.taskId}.`);
      if (task.acceptanceCriteria) {
        if (!input.criterionVerdicts) {
          return errorOutput(
            "criterion_review_required",
            `Task ${input.taskId} review requires one verdict per acceptance criterion.`
          );
        }
        if (!task.criterionEvidenceLinks) {
          return errorOutput(
            "criterion_evidence_required",
            `Task ${input.taskId} has no submitted criterion evidence mappings.`
          );
        }
        if (!evidenceStore) {
          return errorOutput(
            "evidence_store_required",
            "Criterion review requires the durable evidence store."
          );
        }
        const evidenceRecords = evidenceStore.getByIds({
          runId: context.runId,
          taskId: task.id,
          ids: [...new Set(task.criterionEvidenceLinks.flatMap((link) => [link.evidenceId]))],
        });
        const validation = validateCriterionReviewVerdicts(
          task.acceptanceCriteria,
          input.criterionVerdicts,
          task.criterionEvidenceLinks,
          {
            evidenceRecords,
            runId: context.runId,
            taskId: task.id,
            attempt: task.attempt,
            ...(task.assignedWorkerId
              ? { assignedWorkerId: task.assignedWorkerId }
              : {}),
          }
        );
        if (!validation.valid) {
          return errorOutput(
            "invalid_criterion_review",
            `Task review has invalid criterion verdicts: ${validation.issues.join(" ")}`
          );
        }
        try {
          assertSatisfiedVerdictsCiteGreenEvidence(
            input.criterionVerdicts,
            evidenceRecords,
            "Task review",
          );
        } catch (error) {
          return errorOutput(
            "failing_evidence_cited",
            error instanceof Error ? error.message : String(error),
          );
        }
        if (input.decision === "approved" && validation.unsatisfiedCriterionIds.length > 0) {
          return errorOutput(
            "unsatisfied_criterion",
            `Task ${input.taskId} cannot be approved with unsatisfied criteria: ${validation.unsatisfiedCriterionIds.join(", ")}.`
          );
        }
        if (input.decision === "rejected" && validation.unsatisfiedCriterionIds.length === 0) {
          return errorOutput(
            "rejection_requires_unsatisfied_criterion",
            `Rejected task ${input.taskId} must identify an unsatisfied criterion.`
          );
        }
      }
      return appendEvent(store, {
        runId: context.runId,
        type: "review.decided",
        occurredAt: clock(),
        actor: { role: "architect", id: context.actor.id },
        idempotencyKey: task
          ? `review:${input.taskId}:attempt:${task.attempt}:changeset:${task.changeSetId ?? "none"}`
          : `review:${input.taskId}:unknown`,
        payload: {
          taskId: input.taskId,
          decision: input.decision,
          summary: input.summary,
          evidenceArtifactHashes: input.evidenceArtifactHashes,
          ...(input.criterionVerdicts
            ? {
                criterionVerdicts: input.criterionVerdicts.map((verdict) => ({
                  ...verdict,
                  evidenceIds: [...verdict.evidenceIds],
                  ...(verdict.artifactHashes
                    ? { artifactHashes: [...verdict.artifactHashes] }
                    : {}),
                })),
              }
            : {}),
          ...(input.planReconciliation
            ? { planReconciliation: input.planReconciliation }
            : {}),
          ...(input.findingDispositions ? { findingDispositions: input.findingDispositions } : {}),
          ...(input.claimDispositions ? { claimDispositions: input.claimDispositions } : {}),
        },
      }, {
        type: "architect_action",
        action: "review_decided",
        referenceId: input.taskId,
      });
    },
  });
}

function requestIntegrationTool(
  store: SchedulerStore,
  clock: () => string
): NativeTool<TaskIdInput> {
  return lifecycleTool({
    name: "request_integration",
    description: "Request serialized integration of an Architect-approved task",
    schema: objectSchema(
      { taskId: { type: "string", minLength: 1 } },
      ["taskId"]
    ),
    validate: (input) => validateObject(input, (value) =>
      nonEmpty(value.taskId) ? value as unknown as TaskIdInput : null,
    "taskId is required"),
    execute: async (input, context) => {
      const denied = architectOnly(context);
      if (denied) return denied;
      const answered = answeredRunRefused(store, context.runId, "request integration");
      if (answered) return answered;
      const events = store.readRun(context.runId);
      const task = rebuildSchedulerProjection(events).tasks[input.taskId];
      const resolutionSequence = task?.status === "integration_resolution"
        ? events.findLast((event) =>
            event.type === "task.transitioned" &&
            event.payload.taskId === input.taskId &&
            event.payload.status === "integration_resolution"
          )?.sequence
        : undefined;
      const idempotencyKey = task?.status === "integration_resolution"
        ? `integration-resolution-request:${input.taskId}:sequence:${resolutionSequence ?? "missing"}`
        : `integration-request:${input.taskId}`;
      return appendEvent(store, {
        runId: context.runId,
        type: "task.transitioned",
        occurredAt: clock(),
        actor: { role: "architect", id: context.actor.id },
        idempotencyKey,
        payload: { taskId: input.taskId, status: "integrating" },
      }, {
        type: "architect_action",
        action: "integration_requested",
        referenceId: input.taskId,
      });
    },
  });
}

function completeRunTool(
  store: SchedulerStore,
  clock: () => string,
  runPolicy: NativeBuildRunPolicy
): NativeTool<CompleteRunInput> {
  return lifecycleTool({
    name: "complete_run",
    description: runPolicy === "plan_only"
      ? "Record the Architect's semantic decision that the plan is complete and request explicit project handoff"
      : "Record the Architect's semantic decision that the build is complete",
    schema: objectSchema(
      { summary: { type: "string", minLength: 1 } },
      ["summary"]
    ),
    validate: (input) => validateObject(input, (value) =>
      nonEmpty(value.summary) ? value as unknown as CompleteRunInput : null,
    "summary is required"),
    execute: async (input, context) => {
      const denied = architectOnly(context);
      if (denied) return denied;
      const projection = rebuildSchedulerProjection(store.readRun(context.runId));
      if (
        projection.acceptanceContractStatus ===
        "acceptance_contract_upgrade_required"
      ) {
        return errorOutput(
          "acceptance_contract_upgrade_required",
          "Run completion is blocked until the Architect upgrades acceptance criteria for every non-cancelled task."
        );
      }
      const readiness = buildCompletionReadiness(projection);
      if (!readiness.ready) {
        return errorOutput(
          "completion_not_ready",
          `Build completion is not ready: ${readiness.issues.join(" ")}`,
          readiness.issues,
        );
      }
      // FX-2 (CR-1): key each handoff request by the withdrawals it follows.
      // Guidance withdraws a requested handoff into projectHandoffHistory
      // (history only grows), so its length is durable log state that is
      // stable on replay: 0 keeps the old key shape so old logs replay
      // unchanged, N keys the request after N withdrawals. The reducer never
      // inspects the key.
      const handoffRequests = projection.projectHandoffHistory?.length ?? 0;
      const handoffRequestKey = handoffRequests === 0
        ? "project-handoff-requested"
        : `project-handoff-requested:${handoffRequests}`;
      return appendEvent(store, {
        runId: context.runId,
        type: "project.handoff_requested",
        occurredAt: clock(),
        actor: { role: "architect", id: context.actor.id },
        idempotencyKey: handoffRequestKey,
        payload: { summary: input.summary },
      }, { type: "architect_action", action: "run_completed" });
    },
  });
}

interface LifecycleToolOptions<T> {
  name: string;
  description: string;
  schema: Record<string, unknown>;
  validate: (input: unknown) => ValidationResult<T>;
  execute: NativeTool<T>["execute"];
}

function lifecycleTool<T>(options: LifecycleToolOptions<T>): NativeTool<T> {
  return {
    definition: {
      name: options.name,
      description: options.description,
      inputSchema: options.schema,
      readOnly: false,
      effect: "none",
      lifecycle: true,
    },
    validate: options.validate,
    execute: options.execute,
  };
}

function validatePlan(input: unknown): ValidationResult<PlanTasksInput> {
  return validateObject(input, (value) => {
    if (!positiveInteger(value.revision) || !Array.isArray(value.tasks)) return null;
    const tasks: PlanTaskInput[] = [];
    for (const candidate of value.tasks) {
      if (!isRecord(candidate) || !nonEmpty(candidate.id) || !nonEmpty(candidate.objective)) return null;
      const dependencies = stringList(candidate.dependencies);
      const capabilities = stringList(candidate.requiredCapabilities);
      const acceptanceCriteria = parseAcceptanceCriteria(candidate.acceptanceCriteria);
      if (!dependencies || !capabilities || !acceptanceCriteria) return null;
      tasks.push({
        id: candidate.id,
        objective: candidate.objective,
        dependencies,
        requiredCapabilities: capabilities,
        acceptanceCriteria,
      });
    }
    let riskDeclaration: PlanTasksInput["riskDeclaration"];
    if (value.riskDeclaration !== undefined) {
      if (!isRecord(value.riskDeclaration)) return null;
      const risk = value.riskDeclaration.risk;
      if (risk !== "low" && risk !== "high") return null;
      if (!nonEmpty(value.riskDeclaration.rationale)) return null;
      riskDeclaration = { risk, rationale: value.riskDeclaration.rationale };
    }
    return {
      revision: value.revision,
      tasks,
      ...(riskDeclaration ? { riskDeclaration } : {}),
    };
  }, "revision and valid tasks are required");
}

function validateRevision(input: unknown): ValidationResult<ReviseTaskInput> {
  return validateObject(input, (value) => {
    if (!nonEmpty(value.taskId) || !positiveInteger(value.revision)) return null;
    const objective = value.objective === undefined ? undefined : nonEmpty(value.objective) ? value.objective : null;
    const dependencies = value.dependencies === undefined ? undefined : stringList(value.dependencies);
    const capabilities = value.requiredCapabilities === undefined ? undefined : stringList(value.requiredCapabilities);
    const acceptanceCriteria = value.acceptanceCriteria === undefined
      ? undefined
      : parseAcceptanceCriteria(value.acceptanceCriteria);
    if (objective === null || dependencies === null || capabilities === null || acceptanceCriteria === null) return null;
    if (
      objective === undefined &&
      dependencies === undefined &&
      capabilities === undefined &&
      acceptanceCriteria === undefined
    ) return null;
    return {
      taskId: value.taskId,
      revision: value.revision,
      ...(objective !== undefined ? { objective } : {}),
      ...(dependencies !== undefined ? { dependencies } : {}),
      ...(capabilities !== undefined ? { requiredCapabilities: capabilities } : {}),
      ...(acceptanceCriteria !== undefined ? { acceptanceCriteria } : {}),
    };
  }, "taskId, revision, and at least one valid revision field are required");
}

function acknowledgeUserGuidanceTool(
  store: SchedulerStore,
  clock: () => string,
  architectAction: { reason: ArchitectActionReason; sequence: number },
  evidenceStore?: EvidenceStore,
): NativeTool<AcknowledgeUserGuidanceInput> {
  return lifecycleTool({
    name: "acknowledge_user_guidance",
    description: "Acknowledge the exact oldest pending user guidance: folded_into_planning only while the run has no ready plan, otherwise durable evidence proving no semantic plan change or one atomic plan reconciliation",
    schema: objectSchema({
      guidanceId: { type: "string", minLength: 1 },
      expectedVersion: { type: "integer", minimum: 1 },
      resolution: objectSchema({
        type: { type: "string", enum: ["no_plan_change", "plan_reconciled", "folded_into_planning"] },
        rationale: { type: "string", minLength: 1 },
        evidenceIds: {
          type: "array",
          minItems: 1,
          items: { type: "string", minLength: 1 },
        },
        planReconciliation: planReconciliationSchema(),
      }, ["type", "rationale"]),
    }, ["guidanceId", "expectedVersion", "resolution"]),
    validate: validateAcknowledgeUserGuidance,
    execute: async (input, context) => {
      const denied = architectOnly(context);
      if (denied) return denied;
      const reason = architectAction.reason;
      if (reason.type !== "user_guidance_required" && reason.type !== "plan_required") {
        return errorOutput("wrong_architect_action", "User guidance acknowledgement is unavailable for this Architect action.");
      }
      const projection = rebuildSchedulerProjection(store.readRun(context.runId));
      // T9 repair cycle 1 (B3): the inline acknowledgement on a plan_required
      // turn is new-policy only — legacy initial-plan turns proceed with
      // guidance pending by design (the plan.created carve-out).
      if (reason.type === "plan_required" && projection.planningPolicyVersion !== 1) {
        return errorOutput("wrong_architect_action", "User guidance acknowledgement is unavailable for this Architect action.");
      }
      const oldest = Object.values(projection.userGuidance)
        .filter((guidance) => guidance.status === "submitted")
        .sort((left, right) => left.version - right.version || left.guidanceId.localeCompare(right.guidanceId))[0];
      if (
        !oldest ||
        input.guidanceId !== oldest.guidanceId ||
        input.expectedVersion !== oldest.version ||
        (reason.type === "user_guidance_required" &&
          (reason.guidanceId !== oldest.guidanceId || reason.version !== oldest.version))
      ) {
        return errorOutput(
          "wrong_pending_guidance",
          "Acknowledgement must target the exact oldest pending guidance ID and version exposed by the current Architect action."
        );
      }
      if (input.resolution.type === "no_plan_change") {
        if (!evidenceStore) {
          return errorOutput(
            "authoritative_evidence_required",
            "No-plan-change acknowledgement requires the current run's authoritative durable evidence store."
          );
        }
        const records = evidenceStore.getByIds({
          runId: context.runId,
          ids: input.resolution.evidenceIds,
        });
        if (records.length !== input.resolution.evidenceIds.length) {
          return errorOutput(
            "invalid_guidance_evidence",
            "No-plan-change acknowledgement cites missing or foreign evidence."
          );
        }
      }
      return appendEvent(store, {
        runId: context.runId,
        type: "user.guidance_acknowledged",
        occurredAt: clock(),
        actor: { role: "architect", id: context.actor.id },
        idempotencyKey: `user-guidance-ack:${input.guidanceId}:${input.expectedVersion}`,
        payload: {
          guidanceId: input.guidanceId,
          expectedVersion: input.expectedVersion,
          resolution: cloneGuidanceAcknowledgementResolution(input.resolution),
        },
      }, {
        type: "architect_action",
        action: "user_guidance_acknowledged",
        referenceId: input.guidanceId,
      });
    },
  });
}

function askUserTool(
  store: SchedulerStore,
  clock: () => string,
  architectAction: { reason: ArchitectActionReason; sequence: number },
): NativeTool<AskUserInput> {
  return lifecycleTool({
    name: "ask_user",
    description: "Block on a genuine user authority decision, destructive action, unresolved requirement conflict, unavailable external dependency, control weakening, or exhausted governed repair budget; never ask about routine technical work",
    schema: objectSchema({
      questionId: { type: "string", minLength: 1 },
      version: { type: "integer", minimum: 1 },
      decisionKind: {
        type: "string",
        enum: [
          "authority_decision",
          "destructive_action",
          "requirement_conflict",
          "external_dependency",
          "control_weakening",
          "repair_budget_exhausted",
        ],
      },
      question: { type: "string", minLength: 1 },
    }, ["questionId", "version", "decisionKind", "question"]),
    validate: validateAskUser,
    execute: async (input, context) => {
      const denied = architectOnly(context);
      if (denied) return denied;
      const projection = rebuildSchedulerProjection(store.readRun(context.runId));
      if (projection.blockingArchitectQuestionId) {
        return errorOutput(
          "architect_question_open",
          `Architect question ${projection.blockingArchitectQuestionId} is already open.`
        );
      }
      if (input.version !== projection.architectQuestionVersion + 1) {
        return errorOutput(
          "architect_question_version",
          `Architect question version must be ${projection.architectQuestionVersion + 1}.`
        );
      }
      return appendEvent(store, {
        runId: context.runId,
        type: "architect.question_requested",
        occurredAt: clock(),
        actor: { role: "architect", id: context.actor.id },
        idempotencyKey: `architect-question:${input.version}:${input.questionId}`,
        payload: {
          questionId: input.questionId,
          question: input.question,
          version: input.version,
          decisionKind: input.decisionKind,
          checkpoint: {
            reason: structuredClone(architectAction.reason),
            sequence: architectAction.sequence,
          },
        },
      }, {
        type: "architect_action",
        action: "user_question_requested",
        referenceId: input.questionId,
      });
    },
  });
}

function validateAcceptanceContractUpgrade(
  input: unknown
): ValidationResult<AcceptanceContractUpgradeInput> {
  return validateObject(input, (value) => {
    if (!positiveInteger(value.revision) || !Array.isArray(value.criteriaByTask)) {
      return null;
    }
    const criteriaByTask: AcceptanceContractUpgradeInput["criteriaByTask"] = [];
    for (const candidate of value.criteriaByTask) {
      if (!isRecord(candidate) || !nonEmpty(candidate.taskId)) return null;
      const acceptanceCriteria = parseAcceptanceCriteria(candidate.acceptanceCriteria);
      if (!acceptanceCriteria) return null;
      criteriaByTask.push({ taskId: candidate.taskId, acceptanceCriteria });
    }
    if (criteriaByTask.length === 0) return null;
    return { revision: value.revision, criteriaByTask };
  }, "revision and criteria for every non-cancelled task are required");
}

function validateReview(input: unknown): ValidationResult<ReviewTaskInput> {
  return validateObject(input, (value) => {
    if (!nonEmpty(value.taskId) || (value.decision !== "approved" && value.decision !== "rejected") || !nonEmpty(value.summary)) return null;
    const hashes = stringList(value.evidenceArtifactHashes);
    if (!hashes || hashes.some((hash) => !/^[a-f0-9]{64}$/.test(hash))) return null;
    const criterionVerdicts = value.criterionVerdicts === undefined
      ? undefined
      : parseCriterionReviewVerdicts(value.criterionVerdicts);
    if (criterionVerdicts === null) return null;
    const planReconciliation = value.planReconciliation === undefined
      ? undefined
      : parsePlanReconciliation(value.planReconciliation);
    if (value.planReconciliation !== undefined && !planReconciliation) return null;
    const rawFindingDispositions: unknown = value.findingDispositions;
    const findingDispositions = rawFindingDispositions === undefined ? undefined : Array.isArray(rawFindingDispositions) ? rawFindingDispositions.map((candidate: unknown) => isRecord(candidate) && nonEmpty(candidate.findingId) && (candidate.resolution === "plan_reconciled" || candidate.resolution === "rejected" || candidate.resolution === "deferred") && nonEmpty(candidate.rationale) ? { findingId: candidate.findingId, resolution: candidate.resolution as "plan_reconciled" | "rejected" | "deferred", rationale: candidate.rationale } : null) : null;
    if (findingDispositions === null || findingDispositions?.some((candidate) => candidate === null)) return null;
    const claimDispositions = value.claimDispositions === undefined ? undefined : Array.isArray(value.claimDispositions) ? value.claimDispositions.map((candidate: unknown) => isRecord(candidate) && nonEmpty(candidate.claimId) && candidate.status === "verified" && nonEmpty(candidate.rationale) ? { claimId: candidate.claimId, status: "verified" as const, rationale: candidate.rationale } : null) : null;
    if (claimDispositions === null || claimDispositions?.some((candidate) => candidate === null)) return null;
    return {
      taskId: value.taskId,
      decision: value.decision,
      summary: value.summary,
      evidenceArtifactHashes: hashes,
      ...(criterionVerdicts !== undefined ? { criterionVerdicts } : {}),
      ...(planReconciliation ? { planReconciliation } : {}),
      ...(findingDispositions ? { findingDispositions: findingDispositions.filter((candidate): candidate is NonNullable<typeof candidate> => candidate !== null) } : {}),
      ...(claimDispositions ? { claimDispositions: claimDispositions.filter((candidate): candidate is NonNullable<typeof candidate> => candidate !== null) } : {}),
    };
  }, "taskId, decision, summary, and valid evidenceArtifactHashes are required");
}

function validatePlanReconciliation(input: unknown): ValidationResult<PlanReconciliation> {
  return validateObject(
    input,
    parsePlanReconciliation,
    "revision, summary, and valid taskUpdates are required"
  );
}

function validateResolvePlanCritique(input: unknown): ValidationResult<ResolvePlanCritiqueInput> {
  return validateObject(input, (value) => {
    if (!nonEmpty(value.critiqueId) || !positiveInteger(value.planRevision) || !Array.isArray(value.resolutions)) {
      return null;
    }
    const resolutions: ResolvePlanCritiqueInput["resolutions"] = [];
    for (const candidate of value.resolutions) {
      if (
        !isRecord(candidate) ||
        !nonEmpty(candidate.findingId) ||
        (candidate.resolution !== "plan_reconciled" && candidate.resolution !== "rejected") ||
        !nonEmpty(candidate.rationale)
      ) return null;
      resolutions.push({
        findingId: candidate.findingId,
        resolution: candidate.resolution,
        rationale: candidate.rationale,
      });
    }
    const planReconciliation = value.planReconciliation === undefined
      ? undefined
      : parsePlanReconciliation(value.planReconciliation);
    if (value.planReconciliation !== undefined && !planReconciliation) return null;
    return {
      critiqueId: value.critiqueId,
      planRevision: value.planRevision,
      resolutions,
      ...(planReconciliation ? { planReconciliation } : {}),
    };
  }, "critiqueId, planRevision, and resolutions are required");
}

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const remaining = new Set(left);
  for (const value of right) {
    if (!remaining.delete(value)) return false;
  }
  return remaining.size === 0;
}

function validateAcknowledgeUserGuidance(
  input: unknown
): ValidationResult<AcknowledgeUserGuidanceInput> {
  return validateObject(input, (value) => {
    if (
      !nonEmpty(value.guidanceId) ||
      !positiveInteger(value.expectedVersion) ||
      !isRecord(value.resolution) ||
      !nonEmpty(value.resolution.rationale)
    ) return null;
    if (value.resolution.type === "no_plan_change") {
      const evidenceIds = stringList(value.resolution.evidenceIds);
      if (!evidenceIds || evidenceIds.length === 0 ||
        new Set(evidenceIds).size !== evidenceIds.length ||
        value.resolution.planReconciliation !== undefined) return null;
      return {
        guidanceId: value.guidanceId,
        expectedVersion: value.expectedVersion,
        resolution: { type: "no_plan_change" as const, rationale: value.resolution.rationale, evidenceIds },
      };
    }
    if (value.resolution.type === "plan_reconciled") {
      if (value.resolution.evidenceIds !== undefined) return null;
      const planReconciliation = parsePlanReconciliation(value.resolution.planReconciliation);
      if (!planReconciliation) return null;
      return {
        guidanceId: value.guidanceId,
        expectedVersion: value.expectedVersion,
        resolution: {
          type: "plan_reconciled" as const,
          rationale: value.resolution.rationale,
          planReconciliation,
        },
      };
    }
    // T9 repair cycle 2 (B3-r2): folded-into-planning carries no evidence
    // and no reconciliation — the kernel accepts it only while the run has
    // no ready plan. Extras are rejected so it cannot smuggle either path.
    if (value.resolution.type === "folded_into_planning") {
      if (value.resolution.evidenceIds !== undefined || value.resolution.planReconciliation !== undefined) return null;
      return {
        guidanceId: value.guidanceId,
        expectedVersion: value.expectedVersion,
        resolution: {
          type: "folded_into_planning" as const,
          rationale: value.resolution.rationale,
        },
      };
    }
    return null;
  }, "guidanceId, expectedVersion, and one valid acknowledgement resolution are required");
}

function validateAskUser(input: unknown): ValidationResult<AskUserInput> {
  const decisionKinds: ArchitectQuestionDecisionKind[] = [
    "authority_decision", "destructive_action", "requirement_conflict",
    "external_dependency", "control_weakening", "repair_budget_exhausted",
  ];
  return validateObject(input, (value) =>
    nonEmpty(value.questionId) && positiveInteger(value.version) &&
    typeof value.decisionKind === "string" &&
    decisionKinds.includes(value.decisionKind as ArchitectQuestionDecisionKind) &&
    nonEmpty(value.question)
      ? value as unknown as AskUserInput
      : null,
  "questionId, version, decisionKind, and a nonblank question are required");
}

function parsePlanReconciliation(
  input: Record<string, unknown> | unknown
): PlanReconciliation | null {
  if (!isRecord(input)) return null;
  if (
    !positiveInteger(input.revision) ||
    !nonEmpty(input.summary) ||
    !Array.isArray(input.taskUpdates)
  ) return null;
  const newTasks = input.newTasks === undefined
    ? undefined
    : parsePlanNewTasks(input.newTasks);
  if (input.newTasks !== undefined && newTasks === null) return null;
  if (input.taskUpdates.length === 0 && (!newTasks || newTasks.length === 0)) return null;
  const taskUpdates: PlanTaskUpdate[] = [];
  for (const candidate of input.taskUpdates) {
    if (!isRecord(candidate) || !nonEmpty(candidate.taskId)) return null;
    if (candidate.action !== "cancel" && candidate.action !== "revise") return null;
    const objective = candidate.objective === undefined
      ? undefined
      : nonEmpty(candidate.objective) ? candidate.objective : null;
    const dependencies = candidate.dependencies === undefined
      ? undefined
      : stringList(candidate.dependencies);
    const capabilities = candidate.requiredCapabilities === undefined
      ? undefined
      : stringList(candidate.requiredCapabilities);
    const acceptanceCriteria = candidate.acceptanceCriteria === undefined
      ? undefined
      : parseAcceptanceCriteria(candidate.acceptanceCriteria);
    if (objective === null || dependencies === null || capabilities === null || acceptanceCriteria === null) return null;
    taskUpdates.push({
      taskId: candidate.taskId,
      action: candidate.action,
      ...(objective !== undefined ? { objective } : {}),
      ...(dependencies !== undefined ? { dependencies } : {}),
      ...(capabilities !== undefined ? { requiredCapabilities: capabilities } : {}),
      ...(acceptanceCriteria !== undefined ? { acceptanceCriteria } : {}),
    });
  }
  return {
    revision: input.revision,
    summary: input.summary,
    taskUpdates,
    ...(newTasks ? { newTasks } : {}),
  };
}

function parsePlanNewTasks(value: unknown): PlanNewTask[] | null {
  if (!Array.isArray(value)) return null;
  const tasks: PlanNewTask[] = [];
  for (const candidate of value) {
    if (!isRecord(candidate)) return null;
    const allowed = ["id", "objective", "dependencies", "requiredCapabilities", "acceptanceCriteria"];
    if (Object.keys(candidate).some((key) => !allowed.includes(key))) return null;
    if (!nonEmpty(candidate.id) || !nonEmpty(candidate.objective)) return null;
    const dependencies = stringList(candidate.dependencies);
    const requiredCapabilities = stringList(candidate.requiredCapabilities);
    const acceptanceCriteria = parseAcceptanceCriteria(candidate.acceptanceCriteria);
    if (!dependencies || !requiredCapabilities || !acceptanceCriteria) return null;
    tasks.push({
      id: candidate.id,
      objective: candidate.objective,
      dependencies,
      requiredCapabilities,
      acceptanceCriteria,
    });
  }
  return tasks.length > 0 ? tasks : null;
}

function validateObject<T>(
  input: unknown,
  parse: (value: Record<string, unknown>) => T | null,
  issue: string
): ValidationResult<T> {
  if (!isRecord(input)) return { ok: false, issues: [issue] };
  const value = parse(input);
  return value ? { ok: true, value } : { ok: false, issues: [issue] };
}

function appendEvent(
  store: SchedulerStore,
  event: Parameters<SchedulerStore["append"]>[0],
  lifecycle?: ToolExecutionOutput["lifecycle"]
): ToolExecutionOutput {
  try {
    const events = store.readRun(event.runId);
    const projection = events.length > 0
      ? rebuildSchedulerProjection(events)
      : undefined;
    if (projection) {
      assertPendingUserGuidanceAllowsEvent(projection, event);
      assertOpenArchitectQuestionAllowsEvent(projection, event);
    }
    const appended = store.append(event);
    return {
      content: [{ type: "json", value: appended }],
      isError: false,
      ...(lifecycle ? { lifecycle } : {}),
    };
  } catch (error) {
    return errorOutput(
      "mechanical_transition_rejected",
      error instanceof Error ? error.message : String(error)
    );
  }
}

function architectOnly(context: ToolExecutionContext): ToolExecutionOutput | null {
  return context.actor.role === "architect"
    ? null
    : errorOutput("architect_only", "Only the Architect may use this tool.");
}

/**
 * T3a repair (B1a, extra): the tool-side half of the new-policy readiness
 * gate for the legacy plan/task tools. The reducer is the authority and
 * refuses the same events; this only produces a clearer error earlier.
 * Legacy runs and empty runs always pass.
 */
/**
 * T9 (EP39): per-tool half of the answered zero-mutation guarantee. The
 * reducer refuses forged invokes as well; this returns the precise error
 * before the tool does any other work.
 */
function answeredRunRefused(
  store: SchedulerStore,
  runId: string,
  action: string,
): ToolExecutionOutput | null {
  const events = store.readRun(runId);
  if (events.length === 0) return null;
  const projection = rebuildSchedulerProjection(events);
  if (projection.planningPolicyVersion === 1 && projection.planningTriageDecision === "answer") {
    return errorOutput(
      "answered_run",
      `Answered runs cannot ${action}; convert to build first.`,
    );
  }
  return null;
}

function newPolicyPlanNotReady(
  store: SchedulerStore,
  runId: string,
): ToolExecutionOutput | null {
  const events = store.readRun(runId);
  if (events.length === 0) return null;
  const projection = rebuildSchedulerProjection(events);
  if (projection.planningPolicyVersion === 1 && !readyPlanIdentity(projection)) {
    return errorOutput(
      "plan_not_ready",
      "Scheduler tasks on a new-policy run require a ready plan revision; finish evidence-gated planning first."
    );
  }
  return null;
}

function errorOutput(code: string, message: string, issues?: string[]): ToolExecutionOutput {
  return {
    content: [{ type: "text", text: message }],
    isError: true,
    error: { code, message, ...(issues ? { issues } : {}) },
  };
}

function taskSchema(): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      id: { type: "string", minLength: 1 },
      objective: { type: "string", minLength: 1 },
      dependencies: { type: "array", items: { type: "string" } },
      requiredCapabilities: { type: "array", items: { type: "string" } },
      acceptanceCriteria: { type: "array", minItems: 1, items: criterionSchema() },
    },
    required: ["id", "objective", "dependencies", "requiredCapabilities", "acceptanceCriteria"],
    additionalProperties: false,
  };
}

function planReconciliationSchema(): Record<string, unknown> {
  return objectSchema({
    revision: { type: "integer", minimum: 1 },
    summary: { type: "string", minLength: 1 },
    taskUpdates: {
      type: "array",
      items: objectSchema({
        taskId: { type: "string", minLength: 1 },
        action: { type: "string", enum: ["cancel", "revise"] },
        objective: { type: "string", minLength: 1 },
        dependencies: { type: "array", items: { type: "string" } },
        requiredCapabilities: { type: "array", items: { type: "string" } },
        acceptanceCriteria: { type: "array", minItems: 1, items: criterionSchema() },
      }, ["taskId", "action"]),
    },
    newTasks: {
      type: "array",
      minItems: 1,
      items: taskSchema(),
    },
  }, ["revision", "summary", "taskUpdates"]);
}

function criterionSchema(): Record<string, unknown> {
  return objectSchema({
    id: { type: "string", minLength: 1 },
    text: { type: "string", minLength: 1 },
  }, ["id", "text"]);
}

function criterionReviewVerdictSchema(): Record<string, unknown> {
  return objectSchema({
    criterionId: { type: "string", minLength: 1 },
    verdict: { type: "string", enum: ["satisfied", "unsatisfied"] },
    rationale: { type: "string", minLength: 1 },
    evidenceIds: {
      type: "array",
      minItems: 1,
      items: { type: "string", minLength: 1 },
    },
    artifactHashes: {
      type: "array",
      minItems: 1,
      items: { type: "string", pattern: "^[a-f0-9]{64}$" },
    },
    acceptedFailures: {
      type: "array",
      items: objectSchema({
        evidenceId: { type: "string", minLength: 1 },
        rationale: { type: "string", minLength: 1 },
      }, ["evidenceId", "rationale"]),
    },
  }, ["criterionId", "verdict", "rationale", "evidenceIds"]);
}

function parseCriterionReviewVerdicts(value: unknown): CriterionReviewVerdict[] | null {
  if (!Array.isArray(value)) return null;
  const verdicts: CriterionReviewVerdict[] = [];
  for (const candidate of value) {
    if (!isRecord(candidate) || !nonEmpty(candidate.criterionId)) return null;
    if (candidate.verdict !== "satisfied" && candidate.verdict !== "unsatisfied") return null;
    if (!nonEmpty(candidate.rationale)) return null;
    const evidenceIds = stringList(candidate.evidenceIds);
    if (!evidenceIds || evidenceIds.length === 0) return null;
    const artifactHashes = candidate.artifactHashes === undefined
      ? undefined
      : stringList(candidate.artifactHashes);
    if (
      candidate.artifactHashes !== undefined &&
      (!artifactHashes || artifactHashes.length === 0 || artifactHashes.some((hash) => !/^[a-f0-9]{64}$/.test(hash)))
    ) return null;
    const acceptedFailures = candidate.acceptedFailures === undefined
      ? undefined
      : parseAcceptedFailures(candidate.acceptedFailures);
    if (candidate.acceptedFailures !== undefined && acceptedFailures === null) return null;
    verdicts.push({
      criterionId: candidate.criterionId,
      verdict: candidate.verdict,
      rationale: candidate.rationale,
      evidenceIds,
      ...(artifactHashes ? { artifactHashes } : {}),
      ...(acceptedFailures ? { acceptedFailures } : {}),
    });
  }
  return verdicts;
}

function parseAcceptanceCriteria(value: unknown): AcceptanceCriterion[] | null {
  if (!Array.isArray(value)) return null;
  const criteria: AcceptanceCriterion[] = [];
  for (const candidate of value) {
    if (!isRecord(candidate) || !nonEmpty(candidate.id) || !nonEmpty(candidate.text)) {
      return null;
    }
    criteria.push({ id: candidate.id, text: candidate.text });
  }
  const validation = validateAcceptanceCriteria(criteria);
  return validation.valid ? criteria : null;
}

function objectSchema(
  properties: Record<string, unknown>,
  required: string[]
): Record<string, unknown> {
  return {
    type: "object",
    properties,
    required,
    additionalProperties: false,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
function positiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}
function stringList(value: unknown): string[] | null {
  return Array.isArray(value) && value.every(nonEmpty) ? [...value] : null;
}

function parseAcceptedFailures(value: unknown): AcceptedEvidenceFailure[] | null {
  if (!Array.isArray(value)) return null;
  const failures: AcceptedEvidenceFailure[] = [];
  const evidenceIds = new Set<string>();
  for (const candidate of value) {
    if (!isRecord(candidate) || !nonEmpty(candidate.evidenceId) || !nonEmpty(candidate.rationale)) {
      return null;
    }
    if (evidenceIds.has(candidate.evidenceId)) return null;
    evidenceIds.add(candidate.evidenceId);
    failures.push({
      evidenceId: candidate.evidenceId,
      rationale: candidate.rationale,
    });
  }
  return failures;
}

function shortHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function cloneGuidanceAcknowledgementResolution(
  resolution: UserGuidanceAcknowledgementResolution
): UserGuidanceAcknowledgementResolution {
  if (resolution.type === "no_plan_change") {
    return { ...resolution, evidenceIds: [...resolution.evidenceIds] };
  }
  if (resolution.type === "folded_into_planning") {
    return { ...resolution };
  }
  return {
    ...resolution,
    planReconciliation: {
      ...resolution.planReconciliation,
      taskUpdates: resolution.planReconciliation.taskUpdates.map((update) => ({
        ...update,
        ...(update.dependencies ? { dependencies: [...update.dependencies] } : {}),
        ...(update.requiredCapabilities
          ? { requiredCapabilities: [...update.requiredCapabilities] }
          : {}),
        ...(update.acceptanceCriteria
          ? { acceptanceCriteria: update.acceptanceCriteria.map((criterion) => ({ ...criterion })) }
          : {}),
      })),
      ...(resolution.planReconciliation.newTasks
        ? {
            newTasks: resolution.planReconciliation.newTasks.map((task) => ({
              ...task,
              dependencies: [...task.dependencies],
              requiredCapabilities: [...task.requiredCapabilities],
              acceptanceCriteria: task.acceptanceCriteria.map((criterion) => ({ ...criterion })),
            })),
          }
        : {}),
    },
  };
}
