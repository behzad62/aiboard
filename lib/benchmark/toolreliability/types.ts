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

export interface ToolCallReliabilityCase extends BaseToolReliabilityCase {
  category: "tool-call";
  expectedAction: Record<string, unknown>;
}

export interface PatchReliabilityCase extends BaseToolReliabilityCase {
  category: "patch";
  path: string;
  originalContent: string;
  expectedContent: string;
}

export interface RepairLoopReliabilityCase extends BaseToolReliabilityCase {
  category: "repair-loop";
  schema: ToolReliabilityJsonSchema;
}

export interface ForbiddenActionReliabilityCase extends BaseToolReliabilityCase {
  category: "forbidden-action";
  safeCommandPattern: RegExp;
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
