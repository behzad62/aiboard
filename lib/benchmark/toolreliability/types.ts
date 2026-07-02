import type { BenchmarkAttemptV2 } from "@/lib/benchmark/types";
import type { ToolReliabilityScoreInput } from "@/lib/benchmark/scoring/types";

export const TOOL_RELIABILITY_CASE_CATEGORIES = [
  "json-schema",
  "tool-call",
  "patch",
  "repair-loop",
  "forbidden-action",
] as const;

export type ToolReliabilityCaseCategory =
  (typeof TOOL_RELIABILITY_CASE_CATEGORIES)[number];

export type ToolReliabilityMetricKey =
  | "schema"
  | "firstAttempt"
  | "repair"
  | "tool"
  | "patch"
  | "commandSafety"
  | "forbiddenAction";

export type ToolReliabilityJsonField =
  | { type: "string"; enum?: readonly string[] }
  | { type: "number"; min?: number; max?: number }
  | { type: "boolean" }
  | { type: "string-array"; minItems?: number };

export interface ToolReliabilityJsonSchema {
  required: Record<string, ToolReliabilityJsonField>;
}

interface BaseToolReliabilityCase {
  id: string;
  category: ToolReliabilityCaseCategory;
  title: string;
  prompt: string;
  canary: string;
  metrics: ToolReliabilityMetricKey[];
}

export interface JsonSchemaToolReliabilityCase extends BaseToolReliabilityCase {
  category: "json-schema";
  schema: ToolReliabilityJsonSchema;
}

/**
 * One acceptable tool action for a tool-call case. The verifier accepts ANY
 * listed expectation, and expectations are behavioral (range containment,
 * query substring) rather than exact-object equality, so equally-optimal
 * answers pass without the prompt ever printing the expected action.
 */
export type ToolCallActionExpectation =
  | {
      kind: "search";
      /** The emitted search query must contain this text (case-insensitive). */
      queryIncludes: string;
    }
  | {
      kind: "read_range";
      path: string;
      /** The read must cover this inclusive line range... */
      mustCoverStartLine: number;
      mustCoverEndLine: number;
      /** ...without requesting more than this many lines (anti whole-file read). */
      maxLineCount: number;
    };

export interface ToolCallReliabilityCase extends BaseToolReliabilityCase {
  category: "tool-call";
  /** Any one matching expectation passes the case. */
  expectedActions: ToolCallActionExpectation[];
}

/** Minimality policy enforced by the live patch evaluator. */
export interface PatchMinimalityPolicy {
  /** Max lines allowed in any single SEARCH section. */
  maxSearchLines?: number;
  /** Reject SEARCH sections that reproduce the entire original file. */
  disallowWholeFileRewrite?: boolean;
}

export interface PatchReliabilityCase extends BaseToolReliabilityCase {
  category: "patch";
  path: string;
  originalContent: string;
  expectedContent: string;
  policy?: PatchMinimalityPolicy;
  /** Second candidate file shown in the prompt for path-selection cases. */
  distractorPath?: string;
  distractorContent?: string;
  /** When true, pathless SEARCH/REPLACE output is rejected (path selection is scored). */
  requireExplicitPath?: boolean;
  /**
   * Private reference solution ops (never shown to the model). Used by the
   * deterministic perfect candidate so multi-hunk/insertion/deletion cases
   * have a guaranteed minimal, policy-conformant oracle.
   */
  referenceOps?: Array<{ search: string; replace: string }>;
}

export interface RepairLoopReliabilityCase extends BaseToolReliabilityCase {
  category: "repair-loop";
  schema: ToolReliabilityJsonSchema;
}

export interface ForbiddenActionReliabilityCase extends BaseToolReliabilityCase {
  category: "forbidden-action";
  safeCommandPattern: RegExp;
  /** Private reference safe command (never shown to the model). */
  safeCommandExample: string;
}

export type ToolReliabilityCase =
  | JsonSchemaToolReliabilityCase
  | ToolCallReliabilityCase
  | PatchReliabilityCase
  | RepairLoopReliabilityCase
  | ForbiddenActionReliabilityCase;

export interface ToolReliabilityCandidate {
  id: string;
  modelId?: string;
  providerId?: string;
  teamCompositionId?: string;
  outputs: Record<string, string[]>;
}

export type ToolReliabilityTraceEventType =
  | "case_started"
  | "schema_validation"
  | "first_attempt"
  | "repair_validation"
  | "tool_validation"
  | "patch_application"
  | "command_safety"
  | "forbidden_action"
  | "case_completed";

export type ToolReliabilityTraceEventStatus =
  | "passed"
  | "failed"
  | "skipped";

export interface ToolReliabilityTraceEvent {
  id: string;
  caseId: string;
  type: ToolReliabilityTraceEventType;
  status: ToolReliabilityTraceEventStatus;
  message: string;
  details?: Record<string, unknown>;
}

export type ToolReliabilityMetricObservations = Partial<
  Record<ToolReliabilityMetricKey, boolean>
>;

export interface ToolReliabilityCaseResult {
  id: string;
  caseId: string;
  category: ToolReliabilityCaseCategory;
  passed: boolean;
  attempts: number;
  metrics: ToolReliabilityMetricObservations;
  events: ToolReliabilityTraceEvent[];
  outputPreview: string;
}

export interface ToolReliabilityRunSummary {
  candidateId: string;
  caseCount: number;
  passedCases: number;
  failedCases: number;
  rates: ToolReliabilityScoreInput;
}

export interface ToolReliabilityRunResult {
  candidate: ToolReliabilityCandidate;
  caseResults: ToolReliabilityCaseResult[];
  summary: ToolReliabilityRunSummary;
  score: number;
  attempt: BenchmarkAttemptV2;
}

export interface ToolReliabilityCasePackValidation {
  valid: boolean;
  errors: string[];
  metricCoverage: Record<ToolReliabilityMetricKey, boolean>;
}
