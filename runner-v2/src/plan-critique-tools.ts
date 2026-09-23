import type {
  NativeTool,
  ToolExecutionContext,
  ValidationResult,
} from "./agent-contracts.js";
import type { PlanCritiqueAuthority } from "./plan-critique-authority.js";
import {
  parsePlanCritiqueFindings,
  PLAN_CRITIQUE_CATEGORIES,
  type PlanCritiqueFinding,
} from "./plan-critique-contracts.js";
import type { BuildTask } from "./task-contracts.js";

export interface SubmitPlanCritiqueToolInput {
  findings: PlanCritiqueFinding[];
}

export interface SubmitPlanCritiqueToolOptions {
  authority: PlanCritiqueAuthority;
  runId: string;
  critiqueId: string;
  planRevision: number;
  runtimeId: string;
  sessionId: string;
  tasks: Readonly<Record<string, BuildTask>>;
  clock?: () => string;
}

export function createSubmitPlanCritiqueTool(
  options: SubmitPlanCritiqueToolOptions,
): NativeTool<SubmitPlanCritiqueToolInput> {
  const clock = options.clock ?? (() => new Date().toISOString());
  return {
    definition: {
      name: "submit_plan_critique",
      description:
        "Submit the typed plan critique: zero or more findings, each with severity, category, task/criterion references, a claim, and evidence. Blocking findings force one Architect resolution; this tool grants no plan authority.",
      inputSchema: {
        type: "object",
        properties: {
          findings: {
            type: "array",
            items: {
              type: "object",
              properties: {
                findingId: { type: "string", minLength: 1 },
                severity: {
                  type: "string",
                  enum: ["blocking", "advisory"],
                },
                category: {
                  type: "string",
                  enum: [...PLAN_CRITIQUE_CATEGORIES],
                },
                taskIds: {
                  type: "array",
                  items: { type: "string", minLength: 1 },
                },
                criterionIds: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      taskId: { type: "string", minLength: 1 },
                      criterionId: { type: "string", minLength: 1 },
                    },
                    required: ["taskId", "criterionId"],
                    additionalProperties: false,
                  },
                },
                claim: { type: "string", minLength: 1 },
                evidence: {
                  type: "array",
                  minItems: 1,
                  items: { type: "string", minLength: 1 },
                },
              },
              required: [
                "findingId",
                "severity",
                "category",
                "taskIds",
                "claim",
                "evidence",
              ],
              additionalProperties: false,
            },
          },
        },
        required: ["findings"],
        additionalProperties: false,
      },
      readOnly: true,
      effect: "none",
      lifecycle: true,
    },
    validate: (input) => validateSubmitPlanCritique(input, options.tasks),
    assessAccess: () => ({
      capability: "plan_critique.submit",
      external: false,
    }),
    execute: async (input, context) => {
      assertBoundContext(context, options);
      const critique = options.authority.submitFindings({
        runId: options.runId,
        critiqueId: options.critiqueId,
        planRevision: options.planRevision,
        sessionId: options.sessionId,
        actor: { role: "verifier", id: options.runtimeId },
        findings: input.findings.map((finding) => ({
          ...finding,
          taskIds: [...finding.taskIds],
          evidence: [...finding.evidence],
          ...(finding.criterionIds
            ? { criterionIds: finding.criterionIds.map((criterion) => ({ ...criterion })) }
            : {}),
        })),
        occurredAt: clock(),
      });
      const blockingFindingCount = (critique.blockingFindingIds ?? input.findings
        .filter((finding) => finding.severity === "blocking")
        .map((finding) => finding.findingId)).length;
      return {
        content: [{ type: "json", value: critique }],
        isError: false,
        lifecycle: {
          type: "plan_critique_submitted",
          critiqueId: options.critiqueId,
          blockingFindingCount,
        },
      };
    },
  };
}

function validateSubmitPlanCritique(
  input: unknown,
  tasks: Readonly<Record<string, BuildTask>>,
): ValidationResult<SubmitPlanCritiqueToolInput> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return { ok: false, issues: ["Plan critique input must be an object."] };
  }
  const record = input as Record<string, unknown>;
  const unknown = Object.keys(record).filter((key) => key !== "findings");
  if (unknown.length > 0) {
    return {
      ok: false,
      issues: [`Plan critique has unknown fields: ${unknown.join(", ")}.`],
    };
  }
  try {
    return {
      ok: true,
      value: {
        findings: parsePlanCritiqueFindings(record.findings, tasks),
      },
    };
  } catch (error) {
    return {
      ok: false,
      issues: [error instanceof Error ? error.message : String(error)],
    };
  }
}

function assertBoundContext(
  context: ToolExecutionContext,
  options: SubmitPlanCritiqueToolOptions,
): void {
  if (
    context.runId !== options.runId ||
    context.sessionId !== options.sessionId ||
    context.actor.role !== "verifier" ||
    context.actor.id !== options.runtimeId
  ) {
    throw new Error(
      "Plan critique tool context is stale or foreign to its kernel binding.",
    );
  }
}
