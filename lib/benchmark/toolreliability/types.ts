import type { BenchmarkAttemptV2 } from "@/lib/benchmark/types";
import type { ToolReliabilityScoreInput } from "@/lib/benchmark/scoring/types";

export const TOOL_RELIABILITY_CASE_CATEGORIES = [
  "json-schema",
  "tool-call",
  "patch",
  "repair-loop",
  "forbidden-action",
  "stateful",
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
  | "forbiddenAction"
  | "stateful";

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
  /**
   * Alternate fully-correct final contents that must also pass (an `anyOf`
   * of accepted variants) — e.g. a legitimate JSX attribute or JSON key
   * reordering. Compared via `normalizePatchContent` (trailing whitespace
   * and final-newline insensitive, never a looser content check). Defaults
   * to `[expectedContent]` when omitted.
   */
  acceptableContents?: string[];
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

/**
 * A scripted, deterministic multi-turn environment case (Stateful
 * ToolReliability charter, PR A). Unlike every other category (scored from a
 * single/paired model output), a stateful case is scored by REPLAYING the
 * model's recorded turn-by-turn outputs through `createStatefulEnv`
 * (stateful-env.ts) — the env is a pure function of (case, outputs-so-far):
 * no Date.now/Math.random, so certified scoring, trace replay, and the probe
 * all reproduce the identical verdict from `candidate.outputs[caseId]`.
 */
export interface StatefulToolReliabilityCase extends BaseToolReliabilityCase {
  category: "stateful";
  kind:
    | "redundant-read"
    | "stale-patch"
    | "stale-ref"
    | "write-scope"
    | "truncation-recovery"
    | "verify-persistence";
  /** Turn budget — the difficulty pressure (per design, 3-6 turns). */
  maxTurns: number;
  /** The virtual FS at turn 0, path -> content. */
  initialFiles: Record<string, string>;
  /**
   * Environment-driven mutations mirroring Build's coordination broadcasts.
   * `afterModelTurn: N` fires the mutation upon ENTERING processing of turn N
   * (i.e. BEFORE turn N's own action is evaluated against file state, so a
   * patch built from an earlier read can genuinely mismatch) and the
   * `announce` text is folded into turn N's own rendered tool result (the
   * model sees the warning before choosing its next turn).
   */
  scheduledEvents?: Array<{
    afterModelTurn: number;
    path: string;
    newContent: string;
    announce: string;
  }>;
  /** Declared write scope for `write-scope` cases (strict — see design). */
  writeScope?: string[];
  /** Per-response char cap for `truncation-recovery` cases. */
  truncationCharCap?: number;
  /** Playwright-style ref rotation plan for `stale-ref` cases. */
  snapshotPlan?: {
    generations: Array<{ refs: Record<string, string>; description: string }>;
    requiredInteraction: { element: string };
  };
  /** Scripted red/green verification command for `verify-persistence` cases. */
  verifyPlan?: {
    command: string;
    fixPredicate: { path: string; mustInclude: string[] };
    redOutput: string;
    greenOutput: string;
  };
  /** Expected final FS state (semantic compare via `normalizePatchContent`). */
  expectedFinalFiles?: Record<string, { content: string; acceptable?: string[] }>;
  /** For `redundant-read`: the final free-text answer must state this value. */
  groundTruthAnswer?: { mustInclude: string[] };
  /** Doc-comment-style citation of the mined failure class/count/models. */
  provenance: string;
}

export type ToolReliabilityCase =
  | JsonSchemaToolReliabilityCase
  | ToolCallReliabilityCase
  | PatchReliabilityCase
  | RepairLoopReliabilityCase
  | ForbiddenActionReliabilityCase
  | StatefulToolReliabilityCase;

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
  | "env_step"
  | "stateful_verdict"
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
