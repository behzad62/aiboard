import type {
  NativeTool,
  ToolExecutionContext,
  ValidationResult,
} from "./agent-contracts.js";
import {
  parseVerifierCriterionVerdicts,
  parseVerifierExpectations,
  type VerifierCriterionReference,
  type VerifierCriterionVerdict,
  type VerifierExpectation,
} from "./verifier-contracts.js";
import type { VerifierVerdictAuthority } from "./verifier-verdict-authority.js";

export interface SubmitVerifierVerdictToolInput {
  criterionVerdicts: VerifierCriterionVerdict[];
}

export interface SubmitVerifierVerdictToolOptions {
  authority: VerifierVerdictAuthority;
  runId: string;
  reviewId: string;
  targetRevision: string;
  runtimeId: string;
  sessionId: string;
  clock?: () => string;
}

export function createSubmitVerifierVerdictTool(
  options: SubmitVerifierVerdictToolOptions,
): NativeTool<SubmitVerifierVerdictToolInput> {
  const clock = options.clock ?? (() => new Date().toISOString());
  return {
    definition: {
      name: "submit_verifier_verdict",
      description:
        "Submit one evidence-grounded verdict for every protected build criterion. This does not complete the build or grant repair authority.",
      inputSchema: {
        type: "object",
        properties: {
          criterionVerdicts: {
            type: "array",
            minItems: 1,
            items: {
              type: "object",
              properties: {
                taskId: { type: "string", minLength: 1 },
                criterionId: { type: "string", minLength: 1 },
                verdict: {
                  type: "string",
                  enum: ["satisfied", "unsatisfied"],
                },
                rationale: { type: "string", minLength: 1 },
                evidenceIds: {
                  type: "array",
                  minItems: 1,
                  uniqueItems: true,
                  items: { type: "string", minLength: 1 },
                },
                acceptedFailures: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      evidenceId: { type: "string", minLength: 1 },
                      rationale: { type: "string", minLength: 1 },
                    },
                    required: ["evidenceId", "rationale"],
                    additionalProperties: false,
                  },
                },
                location: {
                  type: "object",
                  properties: {
                    path: { type: "string", minLength: 1 },
                    lines: { type: "string", pattern: "^\\d+(-\\d+)?$" },
                  },
                  required: ["path"],
                  additionalProperties: false,
                },
                reproduction: {
                  type: "array",
                  items: { type: "string", minLength: 1 },
                },
              },
              required: [
                "taskId",
                "criterionId",
                "verdict",
                "rationale",
                "evidenceIds",
              ],
              additionalProperties: false,
            },
          },
        },
        required: ["criterionVerdicts"],
        additionalProperties: false,
      },
      readOnly: true,
      effect: "none",
      lifecycle: true,
    },
    validate: validateSubmitVerifierVerdict,
    assessAccess: () => ({
      capability: "verifier.verdict.submit",
      external: false,
    }),
    execute: async (input, context) => {
      assertBoundContext(context, options);
      const verdict = options.authority.submitVerdict({
        runId: options.runId,
        reviewId: options.reviewId,
        targetRevision: options.targetRevision,
        sessionId: options.sessionId,
        actor: { role: "verifier", id: options.runtimeId },
        criterionVerdicts: input.criterionVerdicts.map((criterion) => ({
          ...criterion,
          evidenceIds: [...criterion.evidenceIds],
        })),
        occurredAt: clock(),
      });
      return {
        content: [{ type: "json", value: verdict }],
        isError: false,
        lifecycle: {
          type: "verifier_verdict_submitted",
          reviewId: verdict.reviewId,
          satisfied: verdict.satisfied,
        },
      };
    },
  };
}

function validateSubmitVerifierVerdict(
  input: unknown,
): ValidationResult<SubmitVerifierVerdictToolInput> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return { ok: false, issues: ["Verifier verdict input must be an object."] };
  }
  const record = input as Record<string, unknown>;
  const unknown = Object.keys(record).filter((key) => key !== "criterionVerdicts");
  if (unknown.length > 0) {
    return {
      ok: false,
      issues: [`Verifier verdict has unknown fields: ${unknown.join(", ")}.`],
    };
  }
  try {
    return {
      ok: true,
      value: {
        criterionVerdicts: parseVerifierCriterionVerdicts(
          record.criterionVerdicts,
        ),
      },
    };
  } catch (error) {
    return {
      ok: false,
      issues: [error instanceof Error ? error.message : String(error)],
    };
  }
}

export interface RecordVerificationExpectationsToolInput {
  expectations: VerifierExpectation[];
}

export interface RecordVerificationExpectationsToolOptions {
  authority: VerifierVerdictAuthority;
  runId: string;
  reviewId: string;
  targetRevision: string;
  baselineRevision: string;
  runtimeId: string;
  sessionId: string;
  criteria: readonly VerifierCriterionReference[];
  clock?: () => string;
}

export function createRecordVerificationExpectationsTool(
  options: RecordVerificationExpectationsToolOptions,
): NativeTool<RecordVerificationExpectationsToolInput> {
  const clock = options.clock ?? (() => new Date().toISOString());
  return {
    definition: {
      name: "record_verification_expectations",
      description:
        "Record, before seeing any implementation, what each criterion must do, its edge cases, likely regression surfaces, and the tests that should exist. Exactly one entry per protected task/criterion pair.",
      inputSchema: {
        type: "object",
        properties: {
          expectations: {
            type: "array",
            items: {
              type: "object",
              properties: {
                taskId: { type: "string", minLength: 1 },
                criterionId: { type: "string", minLength: 1 },
                expectedBehaviors: {
                  type: "array",
                  minItems: 1,
                  items: { type: "string", minLength: 1 },
                },
                edgeCases: {
                  type: "array",
                  minItems: 1,
                  items: { type: "string", minLength: 1 },
                },
                regressionSurfaces: {
                  type: "array",
                  items: { type: "string", minLength: 1 },
                },
                requiredTests: {
                  type: "array",
                  items: { type: "string", minLength: 1 },
                },
              },
              required: [
                "taskId",
                "criterionId",
                "expectedBehaviors",
                "edgeCases",
                "regressionSurfaces",
                "requiredTests",
              ],
              additionalProperties: false,
            },
          },
        },
        required: ["expectations"],
        additionalProperties: false,
      },
      readOnly: true,
      effect: "none",
      lifecycle: true,
    },
    validate: (input) => validateRecordVerificationExpectations(input, options.criteria),
    assessAccess: () => ({
      capability: "verifier.expectations.record",
      external: false,
    }),
    execute: async (input, context) => {
      assertExpectationsContext(context, options);
      const review = options.authority.recordExpectations({
        runId: options.runId,
        reviewId: options.reviewId,
        targetRevision: options.targetRevision,
        baselineRevision: options.baselineRevision,
        sessionId: options.sessionId,
        actor: { role: "verifier", id: options.runtimeId },
        expectations: input.expectations,
        occurredAt: clock(),
      });
      return {
        content: [{ type: "json", value: { reviewId: review.reviewId } }],
        isError: false,
        lifecycle: {
          type: "verifier_expectations_recorded",
          reviewId: options.reviewId,
        },
      };
    },
  };
}

function validateRecordVerificationExpectations(
  input: unknown,
  criteria: readonly VerifierCriterionReference[],
): ValidationResult<RecordVerificationExpectationsToolInput> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return { ok: false, issues: ["Verifier expectations input must be an object."] };
  }
  const record = input as Record<string, unknown>;
  const unknown = Object.keys(record).filter((key) => key !== "expectations");
  if (unknown.length > 0) {
    return {
      ok: false,
      issues: [`Verifier expectations have unknown fields: ${unknown.join(", ")}.`],
    };
  }
  try {
    return {
      ok: true,
      value: {
        expectations: parseVerifierExpectations(record.expectations, criteria),
      },
    };
  } catch (error) {
    return {
      ok: false,
      issues: [error instanceof Error ? error.message : String(error)],
    };
  }
}

function assertExpectationsContext(
  context: ToolExecutionContext,
  options: RecordVerificationExpectationsToolOptions,
): void {
  if (
    context.runId !== options.runId ||
    context.sessionId !== options.sessionId ||
    context.actor.role !== "verifier" ||
    context.actor.id !== options.runtimeId
  ) {
    throw new Error(
      "Verifier expectations tool context is stale or foreign to its kernel binding.",
    );
  }
}

function assertBoundContext(
  context: ToolExecutionContext,
  options: SubmitVerifierVerdictToolOptions,
): void {
  if (
    context.runId !== options.runId ||
    context.sessionId !== options.sessionId ||
    context.actor.role !== "verifier" ||
    context.actor.id !== options.runtimeId
  ) {
    throw new Error(
      "Verifier verdict tool context is stale or foreign to its kernel binding.",
    );
  }
}
