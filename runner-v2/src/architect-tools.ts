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
  rebuildSchedulerProjection,
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
  validateAcceptanceCriteria,
  validateCriterionReviewVerdicts,
  type AcceptanceCriterion,
  type CriterionReviewVerdict,
} from "./acceptance-contracts.js";
import type { EvidenceStore } from "./evidence-store.js";
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

export interface ArchitectToolsOptions {
  store: SchedulerStore;
  clock?: () => string;
  runPolicy?: NativeBuildRunPolicy;
  planOnlyCompletionAvailable?: boolean;
  finalVerificationPlanAvailable?: boolean;
  finalVerificationReviewAvailable?: boolean;
  finalVerificationRepairPlanAvailable?: boolean;
  evidenceStore?: EvidenceStore;
  architectAction?: {
    reason: ArchitectActionReason;
    sequence: number;
  };
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

export function createArchitectTools(
  options: ArchitectToolsOptions
): NativeTool<unknown>[] {
  const clock = options.clock ?? (() => new Date().toISOString());
  const baseCore = [
    planTasksTool(options.store, clock),
    reviseTaskTool(options.store, clock),
    answerGuidanceTool(options.store, clock),
    upgradeAcceptanceContractTool(options.store, clock),
  ];
  const withQuestion = options.architectAction
    ? [...baseCore, askUserTool(options.store, clock, options.architectAction)]
    : baseCore;
  const core = options.architectAction?.reason.type === "user_guidance_required"
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
  const planning = options.finalVerificationPlanAvailable
    ? [...core, planFinalVerificationTool(
        options.store,
        clock,
        options.finalVerificationProfileFor,
        options.discardFinalVerificationProfile,
      )]
    : core;
  const verification = options.finalVerificationReviewAvailable
    ? [...planning, reviewFinalVerificationTool(
        options.store,
        clock,
        options.evidenceStore,
      )]
    : planning;
  const repairPlanning = options.finalVerificationRepairPlanAvailable
    ? [...verification, planVerificationRepairsTool(options.store, clock)]
    : verification;
  if (options.runPolicy === "plan_only") {
    return options.planOnlyCompletionAvailable
      ? [...repairPlanning, completeRunTool(options.store, clock, "plan_only")]
      : repairPlanning;
  }
  return [
    ...repairPlanning,
    reconcilePlanTool(options.store, clock),
    reviewTaskTool(options.store, clock, options.evidenceStore),
    requestIntegrationTool(options.store, clock),
    completeRunTool(options.store, clock, options.runPolicy ?? "finish"),
  ];
}

function planVerificationRepairsTool(
  store: SchedulerStore,
  clock: () => string,
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
      try {
        const output = appendEvent(store, {
          runId: context.runId,
          type: "final_verification.generation_created",
          occurredAt: clock(),
          actor: { role: "runner", id: "build-runtime" },
          idempotencyKey: `final-verification-plan:${projection.integrationRevision}`,
          payload: {
            taskId: `final-verification-${revisionKey}`,
            generationId: `final-verification-generation-${revisionKey}`,
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
    description: "Create the Architect-owned task graph; only graph mechanics are validated",
    schema: {
      type: "object",
      properties: {
        revision: { type: "integer", minimum: 1 },
        tasks: { type: "array", items: taskSchema() },
      },
      required: ["revision", "tasks"],
      additionalProperties: false,
    },
    validate: validatePlan,
    execute: async (input, context) => {
      const denied = architectOnly(context);
      if (denied) return denied;
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
          payload: { revision: input.revision, tasks },
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
      return appendEvent(store, {
        runId: context.runId,
        type: "project.handoff_requested",
        occurredAt: clock(),
        actor: { role: "architect", id: context.actor.id },
        idempotencyKey: "project-handoff-requested",
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
    return { revision: value.revision, tasks };
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
    description: "Acknowledge the exact oldest pending user guidance with either durable evidence proving no semantic plan change or one atomic plan reconciliation",
    schema: objectSchema({
      guidanceId: { type: "string", minLength: 1 },
      expectedVersion: { type: "integer", minimum: 1 },
      resolution: objectSchema({
        type: { type: "string", enum: ["no_plan_change", "plan_reconciled"] },
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
      if (architectAction.reason.type !== "user_guidance_required") {
        return errorOutput("wrong_architect_action", "User guidance acknowledgement is unavailable for this Architect action.");
      }
      const projection = rebuildSchedulerProjection(store.readRun(context.runId));
      const oldest = Object.values(projection.userGuidance)
        .filter((guidance) => guidance.status === "submitted")
        .sort((left, right) => left.version - right.version || left.guidanceId.localeCompare(right.guidanceId))[0];
      if (
        !oldest ||
        oldest.guidanceId !== architectAction.reason.guidanceId ||
        oldest.version !== architectAction.reason.version ||
        input.guidanceId !== oldest.guidanceId ||
        input.expectedVersion !== oldest.version
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
    return {
      taskId: value.taskId,
      decision: value.decision,
      summary: value.summary,
      evidenceArtifactHashes: hashes,
      ...(criterionVerdicts !== undefined ? { criterionVerdicts } : {}),
      ...(planReconciliation ? { planReconciliation } : {}),
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
  lifecycle: NonNullable<ToolExecutionOutput["lifecycle"]>
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
      lifecycle,
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
    verdicts.push({
      criterionId: candidate.criterionId,
      verdict: candidate.verdict,
      rationale: candidate.rationale,
      evidenceIds,
      ...(artifactHashes ? { artifactHashes } : {}),
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

function shortHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function cloneGuidanceAcknowledgementResolution(
  resolution: UserGuidanceAcknowledgementResolution
): UserGuidanceAcknowledgementResolution {
  if (resolution.type === "no_plan_change") {
    return { ...resolution, evidenceIds: [...resolution.evidenceIds] };
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
