import { createHash } from "node:crypto";

import type { ExecutionGrantAuthority } from "./execution-grants.js";
import type { RunGitExecutionContext } from "./git-run-context.js";
import type {
  AgentMessage,
  AgentModel,
  NativeTool,
  ToolExecutionContext,
  ToolExecutionOutput,
  ValidationResult,
} from "./agent-contracts.js";
import { runAgentLoop } from "./agent-loop.js";
import {
  answerReviewerSystemPrompt,
  buildAnswerReviewFindingsContext,
  buildAnswerReviewVerdictContext,
} from "./agent-prompts.js";
import type { ArtifactStore } from "./artifact-store.js";
import type {
  BudgetLedger,
  ModelCostBasisSnapshot,
} from "./budget-ledger.js";
import { BudgetedAgentModel, type ModelCostEstimator } from "./budgeted-model.js";
import { BudgetedToolRuntime } from "./budgeted-tool-runtime.js";
import {
  ProtectedContextOverflowError,
  type ContextLimits,
} from "./context-assembler.js";
import { recordContextPack, type ContextManifestStore } from "./context-manifest-store.js";
import type { EvidenceStore } from "./evidence-store.js";
import {
  createInspectionTools,
  verifierModelAttribution,
} from "./native-verifier-runtime.js";
import type { SqlitePermissionStore } from "./permission-store.js";
import type {
  RunnerProviderRetryRuntime,
} from "./provider-call-retry.js";
import { classifyProviderFailure } from "./provider-health.js";
import { assertRoleToolSurface } from "./role-capabilities.js";
import type {
  AgentRuntimeCandidate,
  RuntimeRouter,
} from "./runtime-router.js";
import {
  assertOpenArchitectQuestionAllowsEvent,
  assertPendingUserGuidanceAllowsEvent,
  rebuildSchedulerProjection,
  type AnswerReviewFinding,
  type AnswerReviewFindingCheck,
  type AnswerReviewFindingsRecord,
  type AnswerReviewRecord,
  type AnswerReviewReleaseRecord,
  type AnswerReviewUnavailableRecord,
  type PlanningTriageDecision,
  type RequestAnswerRecord,
  type SchedulerStore,
} from "./scheduler-store.js";
import type { SqliteAgentSessionStore } from "./sqlite-agent-session-store.js";
import type { ToolInvocationLedger } from "./tool-ledger.js";
import {
  assertFreshContextRequest,
  assertFreshContextSessionStarted,
  type ReviewerIndependence,
} from "./verifier-contracts.js";

/**
 * Request triage and the answer path (Runner V2 P6.6, T9; OA-5/OA-6/OA-7/OA-10 #2).
 *
 * Triage is the Architect's FIRST action on a new-policy run, as lifecycle
 * tools in the Architect's normal turn — not an extra model call. The durable
 * decision is `answer`, `build`, or `clarify`:
 *
 * - `answer` completes the run with no plan, workers, integration, or final
 *   verification. The kernel (scheduler-store.ts) refuses every task,
 *   dispatch, integration, and plan-progressing event on an answered run, and
 *   the answer lists the question parts it addresses in the same turn.
 * - `build` (including mixed "explain X, then fix Y" requests) follows the
 *   normal T3 planning flow. Planning tools and events refuse to run before
 *   this decision, so triage precedes plan_required.
 * - `clarify` pauses through the existing ask_user flow and returns to triage
 *   on resume (scheduler-store.ts matches `plan_required` against triage and
 *   planning progress for new-policy runs).
 *
 * An answer that discovers a needed change converts explicitly to `build`
 * with a durable event; it never quietly edits the project. The opt-in
 * independent answer review below reuses `RuntimeRouter.selectVerifier`
 * (OA-3, no second selector), the fresh-context session device, and the
 * record-before-prior-findings device (OA-10 #2) from the coverage review.
 */

// ---------------------------------------------------------------------------
// Architect lifecycle tools: record_triage, record_answer, convert_to_build.
// ---------------------------------------------------------------------------

/** Stable lifecycle-surface names, in the sorted order the surface asserts. */
export const REQUEST_TRIAGE_TOOL_NAMES = Object.freeze([
  "convert_to_build",
  "record_answer",
  "record_triage",
]);

export interface RequestTriageToolsOptions {
  store: SchedulerStore;
  clock?: () => string;
}

export function createRequestTriageTools(
  options: RequestTriageToolsOptions,
): NativeTool<unknown>[] {
  const clock = options.clock ?? (() => new Date().toISOString());
  return [
    recordTriageTool(options.store, clock),
    recordAnswerTool(options.store, clock),
    convertToBuildTool(options.store, clock),
  ];
}

interface RecordTriageInput {
  decision: PlanningTriageDecision;
  rationale: string;
}

interface RecordAnswerInput {
  answerText: string;
  addressedParts: string[];
  evidenceIds?: string[];
}

interface ConvertToBuildInput {
  reason: string;
}

function recordTriageTool(
  store: SchedulerStore,
  clock: () => string,
): NativeTool<RecordTriageInput> {
  return lifecycleTool({
    name: "record_triage",
    description:
      "Record the durable triage decision as the run's first action: answer " +
      "for a pure question (no plan, workers, integration, or verification), " +
      "build for any requested change including mixed explain-then-fix " +
      "requests, or clarify when the request is unanswerable as stated.",
    schema: {
      type: "object",
      properties: {
        decision: { type: "string", enum: ["answer", "build", "clarify"] },
        rationale: { type: "string", minLength: 1 },
      },
      required: ["decision", "rationale"],
      additionalProperties: false,
    },
    validate: (input) =>
      validateObject(input, (value) => {
        if (value.decision !== "answer" && value.decision !== "build" && value.decision !== "clarify") {
          return null;
        }
        if (!nonEmpty(value.rationale)) return null;
        return { decision: value.decision, rationale: value.rationale };
      }, "decision and rationale are required."),
    execute: async (input, context) => {
      const denied = architectOnly(context);
      if (denied) return denied;
      const projection = rebuildSchedulerProjection(store.readRun(context.runId));
      if (projection.planningPolicyVersion !== 1) {
        return errorOutput(
          "triage_not_configured",
          "Request triage requires a new-policy run.",
        );
      }
      const prior = projection.planningTriageDecision;
      if (prior === "answer") {
        return errorOutput(
          "already_answered",
          "An answered run cannot be re-triaged; use convert_to_build when answering discovers a needed change.",
        );
      }
      if (prior === "build") {
        return errorOutput(
          "already_building",
          "A run already triaged to build cannot be re-triaged.",
        );
      }
      // T9 repair cycle 1 (N1, per-tool half): a clarify triage must ask the
      // user — re-triaging clarify without an answered user reply after the
      // last triage is refused. The reducer refuses forged invokes as well.
      if (prior === "clarify" && input.decision === "clarify") {
        const lastTriage = projection.requestTriage?.sequence ?? 0;
        const answeredAfterTriage =
          (projection.lastAnsweredArchitectQuestionSequence ?? 0) > lastTriage;
        if (!answeredAfterTriage) {
          return errorOutput(
            "clarify_without_question",
            "A clarify triage must ask the user: re-triaging clarify without an answered user reply is refused.",
          );
        }
      }
      return appendEvent(store, {
        runId: context.runId,
        type: "request.triaged",
        occurredAt: clock(),
        actor: { role: "architect", id: context.actor.id },
        idempotencyKey: `request-triaged:${projection.lastSequence}`,
        payload: { decision: input.decision, rationale: input.rationale },
      }, {
        type: "architect_action",
        action: "plan_created",
        referenceId: input.decision,
      });
    },
  });
}

function recordAnswerTool(
  store: SchedulerStore,
  clock: () => string,
): NativeTool<RecordAnswerInput> {
  return lifecycleTool({
    name: "record_answer",
    description:
      "Record the durable answer on a triage-answer run, listing the " +
      "question parts it addresses in the same call. Answering never mutates " +
      "the project: use convert_to_build when a change is needed.",
    schema: {
      type: "object",
      properties: {
        answerText: { type: "string", minLength: 1 },
        addressedParts: { type: "array", minItems: 1, items: { type: "string", minLength: 1 } },
        evidenceIds: { type: "array", items: { type: "string", minLength: 1 } },
      },
      required: ["answerText", "addressedParts"],
      additionalProperties: false,
    },
    validate: (input) =>
      validateObject(input, (value) => {
        if (!nonEmpty(value.answerText)) return null;
        const addressedParts = stringList(value.addressedParts);
        if (!addressedParts || addressedParts.length === 0) return null;
        const evidenceIds = value.evidenceIds === undefined ? undefined : stringList(value.evidenceIds);
        if (evidenceIds === null) return null;
        return {
          answerText: value.answerText,
          addressedParts,
          ...(evidenceIds !== undefined ? { evidenceIds } : {}),
        };
      }, "answerText and at least one addressed part are required."),
    execute: async (input, context) => {
      const denied = architectOnly(context);
      if (denied) return denied;
      const projection = rebuildSchedulerProjection(store.readRun(context.runId));
      if (projection.planningPolicyVersion !== 1) {
        return errorOutput(
          "triage_not_configured",
          "Request answers require a new-policy run.",
        );
      }
      if (projection.planningTriageDecision !== "answer") {
        return errorOutput(
          "triage_not_answer",
          "An answer requires a durable triage decision of answer.",
        );
      }
      return appendEvent(store, {
        runId: context.runId,
        type: "request.answered",
        occurredAt: clock(),
        actor: { role: "architect", id: context.actor.id },
        idempotencyKey: `request-answered:${projection.lastSequence}`,
        payload: {
          answerText: input.answerText,
          addressedParts: [...input.addressedParts],
          ...(input.evidenceIds !== undefined ? { evidenceIds: [...input.evidenceIds] } : {}),
        },
      }, {
        type: "architect_action",
        action: "plan_created",
        referenceId: "answer",
      });
    },
  });
}

function convertToBuildTool(
  store: SchedulerStore,
  clock: () => string,
): NativeTool<ConvertToBuildInput> {
  return lifecycleTool({
    name: "convert_to_build",
    description:
      "Convert an answered run explicitly to build when answering discovers " +
      "a needed change. The conversion is durable; afterwards the run follows " +
      "the normal planning flow.",
    schema: {
      type: "object",
      properties: {
        reason: { type: "string", minLength: 1 },
      },
      required: ["reason"],
      additionalProperties: false,
    },
    validate: (input) =>
      validateObject(input, (value) => {
        if (!nonEmpty(value.reason)) return null;
        return { reason: value.reason };
      }, "reason is required."),
    execute: async (input, context) => {
      const denied = architectOnly(context);
      if (denied) return denied;
      const projection = rebuildSchedulerProjection(store.readRun(context.runId));
      if (projection.planningPolicyVersion !== 1) {
        return errorOutput(
          "triage_not_configured",
          "Conversion to build requires a new-policy run.",
        );
      }
      if (projection.planningTriageDecision !== "answer") {
        return errorOutput(
          "triage_not_answer",
          "Only an answered run converts to build.",
        );
      }
      return appendEvent(store, {
        runId: context.runId,
        type: "request.converted_to_build",
        occurredAt: clock(),
        actor: { role: "architect", id: context.actor.id },
        idempotencyKey: `request-converted:${projection.lastSequence}`,
        payload: { reason: input.reason },
      }, {
        type: "architect_action",
        action: "plan_reconciled",
        referenceId: "answer-to-build",
      });
    },
  });
}

// NOTE (agent-contracts seam, as in T3a): the closed `architect_action`
// union has no triage values, so triage/answer emit `plan_created` and
// conversion emits `plan_reconciled`, with the decision in `referenceId`.
// The tool name in the transcript is the precise label; nothing mechanical
// switches on `action`. A follow-up with agent-contracts writable should add
// triage-specific values.

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

function appendEvent(
  store: SchedulerStore,
  event: Parameters<SchedulerStore["append"]>[0],
  lifecycle: NonNullable<ToolExecutionOutput["lifecycle"]>,
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
      error instanceof Error ? error.message : String(error),
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

function validateObject<T>(
  input: unknown,
  parse: (value: Record<string, unknown>) => T | null,
  message: string,
): ValidationResult<T> {
  if (!isRecord(input)) return { ok: false, issues: [message] };
  const parsed = parse(input);
  return parsed === null ? { ok: false, issues: [message] } : { ok: true, value: parsed };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function stringList(value: unknown): string[] | null {
  return Array.isArray(value) && value.every(nonEmpty) ? [...value] : null;
}

// ---------------------------------------------------------------------------
// Answer-review authority: durable reads plus the runner-owned appends. The
// reviewer tools append through this authority; the reducer re-validates, so
// there is no second authority.
// ---------------------------------------------------------------------------

export interface AnswerReviewAuthority {
  optedIn(runId: string): boolean;
  answer(runId: string): RequestAnswerRecord | undefined;
  findings(runId: string, reviewId: string): AnswerReviewFindingsRecord | undefined;
  release(runId: string, reviewId: string): AnswerReviewReleaseRecord | undefined;
  verdict(runId: string, reviewId: string): AnswerReviewRecord | undefined;
  currentVerdict(runId: string): AnswerReviewRecord | undefined;
  unavailable(runId: string): AnswerReviewUnavailableRecord | undefined;
  recordFindings(input: {
    runId: string;
    reviewId: string;
    findings: AnswerReviewFinding[];
    priorReviewId?: string;
    actor: { role: "verifier"; id: string };
    occurredAt: string;
  }): AnswerReviewFindingsRecord;
  releasePriorFindings(input: {
    runId: string;
    reviewId: string;
    priorReviewId: string;
    occurredAt: string;
  }): void;
  submitVerdict(input: {
    runId: string;
    id: string;
    reviewerRuntimeId: string;
    independence: ReviewerIndependence;
    answerSequence: number;
    findings: AnswerReviewFinding[];
    summary: string;
    answerAccurate: boolean;
    priorReviewId?: string;
    priorFindingChecks?: AnswerReviewFindingCheck[];
    actor: { role: "verifier"; id: string };
    occurredAt: string;
  }): AnswerReviewRecord;
  recordUnavailable(input: {
    runId: string;
    reviewId?: string;
    reason: string;
    detail?: string;
    occurredAt: string;
  }): AnswerReviewUnavailableRecord;
}

export class SchedulerAnswerReviewAuthority implements AnswerReviewAuthority {
  constructor(
    private readonly store: SchedulerStore,
    private readonly runnerId = "answer-review-runtime",
  ) {}

  optedIn(runId: string): boolean {
    return this.projectionOf(runId).answerReviewOptIn !== undefined;
  }

  answer(runId: string): RequestAnswerRecord | undefined {
    return this.projectionOf(runId).requestAnswer;
  }

  findings(runId: string, reviewId: string): AnswerReviewFindingsRecord | undefined {
    return this.projectionOf(runId).answerReviewFindings?.[reviewId];
  }

  release(runId: string, reviewId: string): AnswerReviewReleaseRecord | undefined {
    return this.projectionOf(runId).answerReviewReleases?.[reviewId];
  }

  verdict(runId: string, reviewId: string): AnswerReviewRecord | undefined {
    return this.projectionOf(runId).answerReviews?.[reviewId];
  }

  currentVerdict(runId: string): AnswerReviewRecord | undefined {
    const reviews = Object.values(this.projectionOf(runId).answerReviews ?? {});
    return reviews.sort((left, right) => left.sequence - right.sequence).at(-1);
  }

  unavailable(runId: string): AnswerReviewUnavailableRecord | undefined {
    return this.projectionOf(runId).answerReviewUnavailable;
  }

  recordFindings(input: {
    runId: string;
    reviewId: string;
    findings: AnswerReviewFinding[];
    priorReviewId?: string;
    actor: { role: "verifier"; id: string };
    occurredAt: string;
  }): AnswerReviewFindingsRecord {
    this.store.append({
      runId: input.runId,
      type: "answer.review_findings_recorded",
      occurredAt: input.occurredAt,
      actor: { ...input.actor },
      idempotencyKey: `answer:findings:${input.reviewId}`,
      payload: {
        reviewId: input.reviewId,
        findings: structuredClone(input.findings),
        ...(input.priorReviewId !== undefined ? { priorReviewId: input.priorReviewId } : {}),
      },
    });
    const recorded = this.findings(input.runId, input.reviewId);
    if (!recorded) throw new Error("Answer review findings were not durably projected.");
    return recorded;
  }

  releasePriorFindings(input: {
    runId: string;
    reviewId: string;
    priorReviewId: string;
    occurredAt: string;
  }): void {
    this.store.append({
      runId: input.runId,
      type: "answer.review_prior_findings_released",
      occurredAt: input.occurredAt,
      actor: { role: "runner", id: this.runnerId },
      idempotencyKey: `answer:release:${input.reviewId}`,
      payload: { reviewId: input.reviewId, priorReviewId: input.priorReviewId },
    });
  }

  submitVerdict(input: {
    runId: string;
    id: string;
    reviewerRuntimeId: string;
    independence: ReviewerIndependence;
    answerSequence: number;
    findings: AnswerReviewFinding[];
    summary: string;
    answerAccurate: boolean;
    priorReviewId?: string;
    priorFindingChecks?: AnswerReviewFindingCheck[];
    actor: { role: "verifier"; id: string };
    occurredAt: string;
  }): AnswerReviewRecord {
    this.store.append({
      runId: input.runId,
      type: "answer.review_recorded",
      occurredAt: input.occurredAt,
      actor: { ...input.actor },
      idempotencyKey: `answer:verdict:${input.id}`,
      payload: {
        id: input.id,
        reviewerRuntimeId: input.reviewerRuntimeId,
        independence: input.independence,
        answerSequence: input.answerSequence,
        findings: structuredClone(input.findings),
        summary: input.summary,
        answerAccurate: input.answerAccurate,
        ...(input.priorReviewId !== undefined ? { priorReviewId: input.priorReviewId } : {}),
        ...(input.priorFindingChecks !== undefined
          ? { priorFindingChecks: structuredClone(input.priorFindingChecks) }
          : {}),
      },
    });
    const recorded = this.verdict(input.runId, input.id);
    if (!recorded) throw new Error("Answer review verdict was not durably projected.");
    return recorded;
  }

  recordUnavailable(input: {
    runId: string;
    reviewId?: string;
    reason: string;
    detail?: string;
    occurredAt: string;
  }): AnswerReviewUnavailableRecord {
    const occurrence = this.store.readRun(input.runId)
      .filter((event) => event.type === "answer.review_unavailable").length;
    this.store.append({
      runId: input.runId,
      type: "answer.review_unavailable",
      occurredAt: input.occurredAt,
      actor: { role: "runner", id: this.runnerId },
      idempotencyKey: `answer:unavailable:${input.reviewId ?? "none"}:${input.reason}:${occurrence}`,
      payload: {
        ...(input.reviewId !== undefined ? { reviewId: input.reviewId } : {}),
        reason: input.reason,
        ...(input.detail !== undefined ? { detail: input.detail } : {}),
      },
    });
    const recorded = this.unavailable(input.runId);
    if (!recorded) throw new Error("Answer review unavailability was not durably projected.");
    return recorded;
  }

  private projectionOf(runId: string) {
    return rebuildSchedulerProjection(this.store.readRun(runId));
  }
}

// ---------------------------------------------------------------------------
// Reviewer lifecycle tools: record_answer_review_findings (own findings
// first, prior findings withheld) and submit_answer_review_verdict. Each
// review pass registers exactly one of the two.
// ---------------------------------------------------------------------------

export interface RecordAnswerReviewFindingsToolOptions {
  authority: AnswerReviewAuthority;
  runId: string;
  reviewId: string;
  priorReviewId?: string;
  runtimeId: string;
  sessionId: string;
  clock?: () => string;
}

interface RecordAnswerReviewFindingsInput {
  findings: AnswerReviewFinding[];
}

export function createRecordAnswerReviewFindingsTool(
  options: RecordAnswerReviewFindingsToolOptions,
): NativeTool<RecordAnswerReviewFindingsInput> {
  const clock = options.clock ?? (() => new Date().toISOString());
  return {
    definition: {
      name: "record_answer_review_findings",
      description:
        "Record your own findings on the answer exactly once. On a re-review " +
        "the prior findings are withheld until this call lands.",
      inputSchema: {
        type: "object",
        properties: {
          findings: {
            type: "array",
            items: {
              type: "object",
              properties: {
                id: { type: "string", minLength: 1 },
                statement: { type: "string", minLength: 1 },
                severity: { type: "string", enum: ["blocking", "non_blocking"] },
              },
              required: ["id", "statement", "severity"],
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
    validate: (input) =>
      validateObject(input, (value) => {
        if (!Array.isArray(value.findings)) return null;
        const findings: AnswerReviewFinding[] = [];
        for (const candidate of value.findings) {
          if (!isRecord(candidate)) return null;
          if (!nonEmpty(candidate.id) || !nonEmpty(candidate.statement)) return null;
          if (candidate.severity !== "blocking" && candidate.severity !== "non_blocking") return null;
          findings.push({ id: candidate.id, statement: candidate.statement, severity: candidate.severity });
        }
        if (new Set(findings.map((finding) => finding.id)).size !== findings.length) return null;
        return { findings };
      }, "findings with unique ids, statements, and severities are required."),
    execute: async (input, context) => {
      assertReviewerContext(context, options.runId, options.sessionId, options.runtimeId);
      const recordedAt = clock();
      try {
        const recorded = options.authority.recordFindings({
          runId: options.runId,
          reviewId: options.reviewId,
          findings: input.findings,
          ...(options.priorReviewId !== undefined ? { priorReviewId: options.priorReviewId } : {}),
          actor: { role: "verifier", id: options.runtimeId },
          occurredAt: recordedAt,
        });
        return {
          content: [{ type: "json", value: { reviewId: recorded.reviewId } }],
          isError: false,
          // The RG-6 lifecycle signal, reused: own findings recorded ends
          // the findings pass.
          lifecycle: { type: "verifier_expectations_recorded", reviewId: options.reviewId },
        };
      } catch (error) {
        return errorOutput(
          "mechanical_transition_rejected",
          error instanceof Error ? error.message : String(error),
        );
      }
    },
  };
}

export interface SubmitAnswerReviewVerdictToolOptions {
  authority: AnswerReviewAuthority;
  runId: string;
  reviewId: string;
  reviewerRuntimeId: string;
  independence: ReviewerIndependence;
  answerSequence: number;
  priorReviewId?: string;
  /** Prior finding ids from the DURABLE prior review — a re-review checks each one. */
  priorFindingIds?: readonly string[];
  runtimeId: string;
  sessionId: string;
  clock?: () => string;
}

interface SubmitAnswerReviewVerdictInput {
  summary: string;
  answerAccurate: boolean;
  priorFindingChecks?: AnswerReviewFindingCheck[];
}

export function createSubmitAnswerReviewVerdictTool(
  options: SubmitAnswerReviewVerdictToolOptions,
): NativeTool<SubmitAnswerReviewVerdictInput> {
  const clock = options.clock ?? (() => new Date().toISOString());
  return {
    definition: {
      name: "submit_answer_review_verdict",
      description:
        "Submit the answer review verdict exactly once: whether the answer " +
        "is accurate, with a summary. A re-review also checks each prior " +
        "finding as resolved or outstanding.",
      inputSchema: {
        type: "object",
        properties: {
          summary: { type: "string", minLength: 1 },
          answerAccurate: { type: "boolean" },
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
        required: ["summary", "answerAccurate"],
        additionalProperties: false,
      },
      readOnly: false,
      effect: "none",
      lifecycle: true,
    },
    validate: (input) =>
      validateObject(input, (value) => {
        if (!nonEmpty(value.summary)) return null;
        if (typeof value.answerAccurate !== "boolean") return null;
        if (value.priorFindingChecks === undefined) {
          return { summary: value.summary, answerAccurate: value.answerAccurate };
        }
        if (!Array.isArray(value.priorFindingChecks)) return null;
        const priorFindingChecks: AnswerReviewFindingCheck[] = [];
        for (const candidate of value.priorFindingChecks) {
          if (!isRecord(candidate)) return null;
          if (!nonEmpty(candidate.findingId) || !nonEmpty(candidate.rationale)) return null;
          if (candidate.resolution !== "resolved" && candidate.resolution !== "outstanding") return null;
          priorFindingChecks.push({
            findingId: candidate.findingId,
            resolution: candidate.resolution,
            rationale: candidate.rationale,
          });
        }
        return { summary: value.summary, answerAccurate: value.answerAccurate, priorFindingChecks };
      }, "summary, answerAccurate, and valid prior finding checks are required."),
    execute: async (input, context) => {
      assertReviewerContext(context, options.runId, options.sessionId, options.runtimeId);
      // Defense in depth; the reducer owns the refusal.
      const recorded = options.authority.findings(options.runId, options.reviewId);
      if (!recorded) {
        return errorOutput(
          "findings_not_recorded",
          `Answer review ${options.reviewId} has no durably recorded findings.`,
        );
      }
      if (options.priorReviewId !== undefined) {
        const expected = [...(options.priorFindingIds ?? [])].sort();
        const actual = (input.priorFindingChecks ?? []).map((check) => check.findingId).sort();
        if (
          expected.length !== actual.length ||
          expected.some((id, index) => id !== actual[index]) ||
          new Set(actual).size !== actual.length
        ) {
          return errorOutput(
            "prior_findings_unchecked",
            `Answer review ${options.reviewId} must check each prior finding exactly once.`,
          );
        }
      }
      const recordedAt = clock();
      try {
        const submitted = options.authority.submitVerdict({
          runId: options.runId,
          id: options.reviewId,
          reviewerRuntimeId: options.reviewerRuntimeId,
          independence: options.independence,
          answerSequence: options.answerSequence,
          findings: recorded.findings.map((finding) => ({ ...finding })),
          summary: input.summary,
          answerAccurate: input.answerAccurate,
          ...(options.priorReviewId !== undefined ? { priorReviewId: options.priorReviewId } : {}),
          ...(input.priorFindingChecks !== undefined
            ? { priorFindingChecks: input.priorFindingChecks.map((check) => ({ ...check })) }
            : {}),
          actor: { role: "verifier", id: options.runtimeId },
          occurredAt: recordedAt,
        });
        return {
          content: [{ type: "json", value: submitted }],
          isError: false,
          // The RG-6 lifecycle signal, reused: the verdict ends the verdict pass.
          lifecycle: {
            type: "verifier_verdict_submitted",
            reviewId: options.reviewId,
            satisfied: input.answerAccurate,
          },
        };
      } catch (error) {
        return errorOutput(
          "mechanical_transition_rejected",
          error instanceof Error ? error.message : String(error),
        );
      }
    },
  };
}

function assertReviewerContext(
  context: ToolExecutionContext,
  runId: string,
  sessionId: string,
  runtimeId: string,
): void {
  if (context.runId !== runId || context.sessionId !== sessionId) {
    throw new Error("Answer reviewer tool context does not match its review session.");
  }
  if (context.actor.role !== "verifier" || context.actor.id !== runtimeId) {
    throw new Error("Only the bound answer reviewer runtime may use this tool.");
  }
}

export function createAnswerReviewBroker(
  input: Omit<
    Parameters<typeof createInspectionTools>[0],
    "capabilityRole" | "capabilityBroker"
  >,
): ReturnType<typeof createInspectionTools> {
  const broker = createInspectionTools({
    ...input,
    capabilityRole: "verifier",
    capabilityBroker: "answer",
  });
  assertRoleToolSurface(
    "verifier",
    "answer",
    broker.definitions().map((definition) => definition.name),
  );
  return broker;
}

/**
 * The answer-review session identity includes the reviewer runtime id and
 * independence mode, like the coverage session id: failover opens a new
 * fresh session instead of colliding with a suspended reviewer's session.
 */
export function answerSessionId(
  runId: string,
  reviewId: string,
  contextDigest: string,
  mode: "findings" | "verdict",
  runtimeId: string,
  independence: ReviewerIndependence,
): string {
  const digest = createHash("sha256")
    .update(JSON.stringify([runId, reviewId, contextDigest, mode, runtimeId, independence]))
    .digest("hex")
    .slice(0, 24);
  return `answer:${runId}:${digest}`;
}

// ---------------------------------------------------------------------------
// Opt-in independent answer review runtime (OA-3/OA-5/OA-10 #2).
// ---------------------------------------------------------------------------

/** T9 repair cycle 3 (N-C): acknowledged user guidance the answer reviewer must see. */
export interface AnswerReviewGuidanceSnapshot {
  id: string;
  text: string;
}

export interface NativeAnswerReviewRequest {
  runId: string;
  reviewId: string;
  architectRuntimeId: string;
  /** The durable request text the answer addresses. */
  question: string;
  answerText: string;
  addressedParts: readonly string[];
  answerSequence: number;
  /**
   * T9 repair cycle 3 (N-C): acknowledged guidance text carried into the
   * review — including guidance folded after the recorded answer, which the
   * re-answer must reflect. Optional for older callers; the pump always sets
   * it (possibly empty).
   */
  guidance?: readonly AnswerReviewGuidanceSnapshot[];
  priorReview?: AnswerReviewRecord;
  preferredRuntimeId?: string;
  providerRetryDeadlineMs?: number;
  signal?: AbortSignal;
}

export type NativeAnswerReviewResult =
  | {
      readonly status: "reviewed";
      readonly review: AnswerReviewRecord;
      readonly findingsSessionId: string;
      readonly verdictSessionId: string;
      readonly runtimeId: string;
      readonly independence: ReviewerIndependence;
      readonly findingsMessages: readonly AgentMessage[];
      readonly verdictMessages: readonly AgentMessage[];
      readonly replayed: boolean;
    }
  | {
      readonly status: "unavailable";
      readonly reviewId: string;
      readonly reason: string;
      readonly detail?: string;
      readonly runtimeId?: string;
    }
  | {
      readonly status: "suspended";
      readonly reviewId: string;
      readonly reason: string;
      readonly runtimeId: string;
    };

export interface AnswerReviewDriver {
  candidateRuntimeIds: readonly string[];
  review(input: NativeAnswerReviewRequest): Promise<NativeAnswerReviewResult>;
}

export interface NativeAnswerReviewRuntimeOptions {
  git?: RunGitExecutionContext;
  executionGrants?: ExecutionGrantAuthority;
  router: RuntimeRouter;
  candidates: readonly AgentRuntimeCandidate[];
  models: ReadonlyMap<string, AgentModel>;
  answerRuntimeIds: readonly string[];
  sessions: SqliteAgentSessionStore;
  artifacts: ArtifactStore;
  // Required: the verifier:answer surface lists inspect_evidence, which
  // the inspection broker only registers with a store. The broker asserts
  // the exact surface, so omission fails fast instead of degrading.
  evidenceStore: EvidenceStore;
  projectRoot: string;
  authority: AnswerReviewAuthority;
  budgetLedger?: BudgetLedger;
  ledger?: ToolInvocationLedger;
  modelCostEstimators?: ReadonlyMap<string, ModelCostEstimator>;
  modelCostBases?: ReadonlyMap<string, ModelCostBasisSnapshot>;
  outputTokenReserve?: number;
  permissions?: SqlitePermissionStore;
  contextManifests?: ContextManifestStore;
  recordContextPackText?: boolean;
  contextLimits?: ContextLimits;
  maxTurns?: number;
  providerRetryRuntime?: RunnerProviderRetryRuntime;
  clock?: () => string;
}

export class NativeAnswerReviewRuntime {
  private readonly candidateById: Map<string, AgentRuntimeCandidate>;
  private readonly clock: () => string;

  constructor(private readonly options: NativeAnswerReviewRuntimeOptions) {
    this.candidateById = new Map(
      options.candidates.map((candidate) => [candidate.runtimeId, candidate]),
    );
    this.clock = options.clock ?? (() => new Date().toISOString());
  }

  async review(request: NativeAnswerReviewRequest): Promise<NativeAnswerReviewResult> {
    assertAnswerReviewRequest(request);
    // OA-3 via the shared selector (G-6: no second selector): prefer a model
    // distinct from the Architect's; an answer has no change authors, so
    // only the Architect identity is excluded. The fallback is recorded
    // fresh_context.
    const selection = this.options.router.selectVerifier({
      requiredCapabilities: ["code"],
      candidateRuntimeIds: request.preferredRuntimeId
        ? [request.preferredRuntimeId]
        : this.options.answerRuntimeIds,
      architectRuntimeId: request.architectRuntimeId,
      acceptedChangeAuthorRuntimeIds: [],
    });
    if (selection.status === "unavailable") {
      return await this.recordUnavailable(request, selection.reason);
    }
    const candidate = this.candidateById.get(selection.runtime.runtimeId);
    const model = this.options.models.get(selection.runtime.runtimeId);
    if (!candidate || !model) {
      return await this.recordUnavailable(
        request,
        "runtime_unavailable",
        undefined,
        selection.runtime.runtimeId,
      );
    }
    const independence = selection.independence;
    const isReReview = request.priorReview !== undefined;
    // The findings pass never sees prior findings — withheld until the own
    // findings are durable (OA-10 #2), for the first review and re-reviews.
    const findings = await this.runFindingsPass({ request, candidate, model, independence });
    if (findings.status !== "recorded") return findings.result;
    if (isReReview) {
      // The own view is durable, so the prior findings may now be released
      // — and only now. The reducer refuses a release without the recorded
      // view, and the verdict without the release.
      this.options.authority.releasePriorFindings({
        runId: request.runId,
        reviewId: request.reviewId,
        priorReviewId: request.priorReview!.id,
        occurredAt: this.clock(),
      });
    }
    return await this.runVerdictPass({
      request,
      candidate,
      model,
      independence,
      findingsSessionId: findings.sessionId,
      findingsMessages: findings.messages,
    });
  }

  private async recordUnavailable(
    request: NativeAnswerReviewRequest,
    reason: string,
    detail?: string,
    runtimeId?: string,
  ): Promise<NativeAnswerReviewResult> {
    // Never controller self-review, never relabelled: the gate is recorded
    // durably and the run pauses for the owner; resume re-drives the retry.
    this.options.authority.recordUnavailable({
      runId: request.runId,
      reviewId: request.reviewId,
      reason,
      ...(detail !== undefined ? { detail } : {}),
      occurredAt: this.clock(),
    });
    return {
      status: "unavailable",
      reviewId: request.reviewId,
      reason,
      ...(detail !== undefined ? { detail } : {}),
      ...(runtimeId !== undefined ? { runtimeId } : {}),
    };
  }

  private async runFindingsPass(input: {
    request: NativeAnswerReviewRequest;
    candidate: AgentRuntimeCandidate;
    model: AgentModel;
    independence: ReviewerIndependence;
  }): Promise<
    | { status: "recorded"; sessionId: string; messages: readonly AgentMessage[] }
    | { status: "not-recorded"; result: NativeAnswerReviewResult }
  > {
    const { request, candidate, model, independence } = input;
    const contextLimits = this.options.contextLimits ?? { maxBytes: 512 * 1024, maxEstimatedTokens: 128 * 1024 };
    let pack: ReturnType<typeof buildAnswerReviewFindingsContext>;
    try {
      pack = buildAnswerReviewFindingsContext({
        limits: contextLimits,
        question: request.question,
        answerText: request.answerText,
        addressedParts: request.addressedParts,
        // T9 repair cycle 3 (N-C): acknowledged guidance reaches the
        // findings pass, so the own view is formed with the guidance seen.
        ...(request.guidance !== undefined && request.guidance.length > 0
          ? { guidance: request.guidance.map((item) => ({ ...item })) }
          : {}),
      });
    } catch (error) {
      if (error instanceof ProtectedContextOverflowError) {
        return {
          status: "not-recorded",
          result: await this.recordUnavailable(
            request,
            "findings_context_overflow",
            error instanceof Error ? error.message : String(error),
            candidate.runtimeId,
          ),
        };
      }
      throw error;
    }
    const sessionId = answerSessionId(
      request.runId, request.reviewId, pack.digest, "findings", candidate.runtimeId, independence,
    );
    await recordContextPack({
      store: this.options.contextManifests,
      artifacts: this.options.artifacts,
      recordPackText: this.options.recordContextPackText,
      runId: request.runId,
      sessionId,
      actor: { role: "verifier", id: candidate.runtimeId },
      role: "verifier",
      purpose: request.priorReview !== undefined ? "answer:rereview-findings" : "answer:findings",
      limits: contextLimits,
      pack,
      recordedAt: this.clock(),
    });
    const systemMessage: AgentMessage = {
      id: "answer-findings-system",
      role: "system",
      content: answerReviewerSystemPrompt("findings"),
    };
    const contextMessage: AgentMessage = {
      id: `context:${pack.digest}`,
      role: "user",
      content: pack.text,
    };
    const opened = await this.openReviewSession({
      sessionId,
      runId: request.runId,
      candidate,
      independence,
      messages: [systemMessage, contextMessage],
    });
    const already = this.options.authority.findings(request.runId, request.reviewId);
    if (already) {
      this.options.sessions.complete(sessionId, this.clock());
      return { status: "recorded", sessionId, messages: opened.messages };
    }
    const broker = createAnswerReviewBroker({
      git: this.options.git,
      executionGrants: this.options.executionGrants,
      workspacePath: this.options.projectRoot,
      artifacts: this.options.artifacts,
      evidenceStore: this.options.evidenceStore,
      runId: request.runId,
      clock: this.clock,
      ...(this.options.ledger ? { ledger: this.options.ledger } : {}),
      ...(this.options.permissions ? { permissions: this.options.permissions } : {}),
      lifecycleTool: createRecordAnswerReviewFindingsTool({
        authority: this.options.authority,
        runId: request.runId,
        reviewId: request.reviewId,
        ...(request.priorReview !== undefined ? { priorReviewId: request.priorReview.id } : {}),
        runtimeId: candidate.runtimeId,
        sessionId,
        clock: this.clock,
      }),
    });
    const result = await runAgentLoop({
      model: this.budgetedModel(model, candidate, request.runId, sessionId),
      registry: this.budgetedTools(broker, request.runId),
      context: {
        runId: request.runId,
        sessionId,
        actor: { role: "verifier", id: candidate.runtimeId },
        workspacePath: this.options.projectRoot,
        signal: request.signal,
      },
      initialMessages: opened.messages,
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
      const durable = this.options.authority.findings(request.runId, request.reviewId);
      if (
        !durable ||
        result.reviewId !== request.reviewId ||
        (request.priorReview !== undefined && durable.priorReviewId !== request.priorReview.id)
      ) {
        throw new Error("Answer review findings pass ended without its durable record.");
      }
      this.options.sessions.complete(sessionId, this.clock());
      return { status: "recorded", sessionId, messages: result.messages };
    }
    if (result.status === "suspended") {
      return {
        status: "not-recorded",
        result: { status: "suspended", reviewId: request.reviewId, reason: result.reason, runtimeId: candidate.runtimeId },
      };
    }
    return {
      status: "not-recorded",
      result: await this.recordUnavailable(
        request,
        "findings_incomplete",
        `Findings pass ended with status ${result.status} and no recorded findings.`,
        candidate.runtimeId,
      ),
    };
  }

  private async runVerdictPass(input: {
    request: NativeAnswerReviewRequest;
    candidate: AgentRuntimeCandidate;
    model: AgentModel;
    independence: ReviewerIndependence;
    findingsSessionId: string;
    findingsMessages: readonly AgentMessage[];
  }): Promise<NativeAnswerReviewResult> {
    const { request, candidate, model, independence } = input;
    const isReReview = request.priorReview !== undefined;
    const ownFindings = this.options.authority.findings(request.runId, request.reviewId);
    if (!ownFindings) throw new Error("Answer review verdict pass requires recorded own findings.");
    const contextLimits = this.options.contextLimits ?? { maxBytes: 512 * 1024, maxEstimatedTokens: 128 * 1024 };
    let pack: ReturnType<typeof buildAnswerReviewVerdictContext>;
    try {
      pack = buildAnswerReviewVerdictContext({
        limits: contextLimits,
        question: request.question,
        answerText: request.answerText,
        addressedParts: request.addressedParts,
        // T9 repair cycle 3 (N-C): the verdict pass sees the same
        // acknowledged guidance as the findings pass.
        ...(request.guidance !== undefined && request.guidance.length > 0
          ? { guidance: request.guidance.map((item) => ({ ...item })) }
          : {}),
        ownFindingsJson: JSON.stringify(ownFindings.findings, null, 2),
        ...(request.priorReview !== undefined
          ? {
              priorFindingsJson: JSON.stringify(request.priorReview.findings, null, 2),
              priorSummary: request.priorReview.summary,
            }
          : {}),
      });
    } catch (error) {
      if (error instanceof ProtectedContextOverflowError) {
        return await this.recordUnavailable(
          request,
          "verdict_context_overflow",
          error instanceof Error ? error.message : String(error),
          candidate.runtimeId,
        );
      }
      throw error;
    }
    const mode = isReReview ? "rereview-verdict" : "verdict";
    const sessionId = answerSessionId(
      request.runId, request.reviewId, pack.digest, "verdict", candidate.runtimeId, independence,
    );
    await recordContextPack({
      store: this.options.contextManifests,
      artifacts: this.options.artifacts,
      recordPackText: this.options.recordContextPackText,
      runId: request.runId,
      sessionId,
      actor: { role: "verifier", id: candidate.runtimeId },
      role: "verifier",
      purpose: isReReview ? "answer:rereview-verdict" : "answer:verdict",
      limits: contextLimits,
      pack,
      recordedAt: this.clock(),
    });
    const systemMessage: AgentMessage = {
      id: `answer-${mode}-system`,
      role: "system",
      content: answerReviewerSystemPrompt(mode),
    };
    const contextMessage: AgentMessage = {
      id: `context:${pack.digest}`,
      role: "user",
      content: pack.text,
    };
    const opened = await this.openReviewSession({
      sessionId,
      runId: request.runId,
      candidate,
      independence,
      messages: [systemMessage, contextMessage],
    });
    const submitted = this.options.authority.verdict(request.runId, request.reviewId);
    if (submitted) {
      return {
        status: "reviewed",
        review: submitted,
        findingsSessionId: input.findingsSessionId,
        verdictSessionId: sessionId,
        runtimeId: candidate.runtimeId,
        independence,
        findingsMessages: input.findingsMessages,
        verdictMessages: opened.messages,
        replayed: true,
      };
    }
    if (!opened.freshStart) {
      const completed = await this.options.sessions.load(sessionId);
      if (completed.status === "completed") {
        throw new Error("Answer review verdict session completed without a durable verdict.");
      }
    }
    const broker = createAnswerReviewBroker({
      git: this.options.git,
      executionGrants: this.options.executionGrants,
      workspacePath: this.options.projectRoot,
      artifacts: this.options.artifacts,
      evidenceStore: this.options.evidenceStore,
      runId: request.runId,
      clock: this.clock,
      ...(this.options.ledger ? { ledger: this.options.ledger } : {}),
      ...(this.options.permissions ? { permissions: this.options.permissions } : {}),
      lifecycleTool: createSubmitAnswerReviewVerdictTool({
        authority: this.options.authority,
        runId: request.runId,
        reviewId: request.reviewId,
        reviewerRuntimeId: candidate.runtimeId,
        independence,
        answerSequence: request.answerSequence,
        ...(request.priorReview !== undefined
          ? {
              priorReviewId: request.priorReview.id,
              priorFindingIds: request.priorReview.findings.map((finding) => finding.id),
            }
          : {}),
        runtimeId: candidate.runtimeId,
        sessionId,
        clock: this.clock,
      }),
    });
    const result = await runAgentLoop({
      model: this.budgetedModel(model, candidate, request.runId, sessionId),
      registry: this.budgetedTools(broker, request.runId),
      context: {
        runId: request.runId,
        sessionId,
        actor: { role: "verifier", id: candidate.runtimeId },
        workspacePath: this.options.projectRoot,
        signal: request.signal,
      },
      initialMessages: opened.messages,
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
      const durable = this.options.authority.verdict(request.runId, request.reviewId);
      if (
        !durable ||
        durable.id !== request.reviewId ||
        result.reviewId !== request.reviewId ||
        durable.reviewerRuntimeId !== candidate.runtimeId ||
        durable.independence !== independence
      ) {
        throw new Error("Answer review verdict pass ended without its durable record.");
      }
      this.options.sessions.complete(sessionId, this.clock());
      return {
        status: "reviewed",
        review: durable,
        findingsSessionId: input.findingsSessionId,
        verdictSessionId: sessionId,
        runtimeId: candidate.runtimeId,
        independence,
        findingsMessages: input.findingsMessages,
        verdictMessages: result.messages,
        replayed: false,
      };
    }
    if (result.status === "suspended") {
      return { status: "suspended", reviewId: request.reviewId, reason: result.reason, runtimeId: candidate.runtimeId };
    }
    return await this.recordUnavailable(
      request,
      "verdict_incomplete",
      `Verdict pass ended with status ${result.status} and no recorded verdict.`,
      candidate.runtimeId,
    );
  }

  /**
   * Fresh review session per pass (the T3b device): on a fresh start the
   * session's event list is empty and the first request carries only the
   * pack messages; a resumed session must match the bound reviewer.
   */
  private async openReviewSession(input: {
    sessionId: string;
    runId: string;
    candidate: AgentRuntimeCandidate;
    independence: ReviewerIndependence;
    messages: AgentMessage[];
  }): Promise<{ messages: AgentMessage[]; freshStart: boolean }> {
    const { sessionId, runId, candidate, independence } = input;
    let messages = [...input.messages];
    const packMessageIds = messages.map((message) => message.id);
    const sessionEvents = this.options.sessions.events(sessionId);
    const freshStart = sessionEvents.length === 0;
    if (freshStart) {
      assertFreshContextRequest({
        independence,
        priorEventCount: sessionEvents.length,
        messages,
        packMessageIds,
      });
      await this.options.sessions.create({
        sessionId,
        runId,
        actor: { role: "verifier", id: candidate.runtimeId },
        occurredAt: this.clock(),
      });
      assertFreshContextSessionStarted(independence, this.options.sessions.events(sessionId));
    } else {
      const recovered = await this.options.sessions.load(sessionId);
      if (
        recovered.actor.role !== "verifier" ||
        recovered.actor.id !== candidate.runtimeId ||
        recovered.runId !== runId
      ) {
        throw new Error(
          independence === "fresh_context"
            ? "A fresh-context reviewer cannot resume or reuse another session."
            : "Recovered answer session identity does not match the request.",
        );
      }
      if (recovered.checkpoint) messages = [...recovered.checkpoint.messages];
      for (const message of input.messages) {
        if (!messages.some((candidate) => candidate.id === message.id)) {
          messages.push(message);
        }
      }
    }
    return { messages, freshStart };
  }

  private budgetedModel(
    model: AgentModel,
    candidate: AgentRuntimeCandidate,
    runId: string,
    sessionId: string,
  ): AgentModel {
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

  private budgetedTools(broker: ReturnType<typeof createInspectionTools>, runId: string) {
    if (!this.options.budgetLedger) return broker;
    return new BudgetedToolRuntime({
      runtime: broker,
      ledger: this.options.budgetLedger,
      scopeId: runId,
      clock: this.clock,
    });
  }
}

function assertAnswerReviewRequest(request: NativeAnswerReviewRequest): void {
  if (!request.runId.trim() || !request.reviewId.trim() || !request.architectRuntimeId.trim()) {
    throw new Error("Answer review requires a run, review, and Architect runtime identity.");
  }
  if (!request.question.trim() || !request.answerText.trim() || request.addressedParts.length === 0) {
    throw new Error("Answer review requires the question, the answer, and its addressed parts.");
  }
  if (!Number.isSafeInteger(request.answerSequence) || request.answerSequence < 1) {
    throw new Error("Answer review requires the answered sequence.");
  }
  // T9 repair cycle 3 (N-C): carried guidance must be well-formed id/text
  // snapshots when present; malformed entries fail closed.
  if (request.guidance !== undefined) {
    for (const item of request.guidance) {
      if (!item.id.trim() || !item.text.trim()) {
        throw new Error("Answer review guidance requires an id and text.");
      }
    }
  }
}
