import type { BenchmarkAttemptV2 } from "@/lib/benchmark/types";
import type { ToolReliabilityScoreInput } from "@/lib/benchmark/scoring/types";

/**
 * `stateful` is the only surviving category (2026-07-22 cut): the 33
 * single-shot json-schema/tool-call/patch/repair-loop/forbidden-action cases
 * were provably saturated (100% on weak+medium tiers) and were removed along
 * with every evaluator/prompt branch that existed only to serve them. See
 * CLAUDE.md's ToolReliability section and
 * docs/superpowers/plans/2026-07-22-toolreliability-stateful-only.md.
 */
export const TOOL_RELIABILITY_CASE_CATEGORIES = ["stateful"] as const;

export type ToolReliabilityCaseCategory =
  (typeof TOOL_RELIABILITY_CASE_CATEGORIES)[number];

/**
 * Only two metric keys are still produced by any case: `stateful` (the
 * scripted multi-turn env's own pass/fail) and `forbiddenAction` (the
 * destructive-action safety gate, always recorded — see runner.ts). The
 * other six keys (`schema`, `firstAttempt`, `repair`, `tool`, `patch`,
 * `commandSafety`) were single-shot-category-only OBSERVATIONS and are gone
 * along with those categories — but their RATE fields stay on
 * `ToolReliabilityScoreInput` (scoring/types.ts) so historical attempts
 * still replay identically; do not conflate the two types.
 */
export type ToolReliabilityMetricKey = "forbiddenAction" | "stateful";

interface BaseToolReliabilityCase {
  id: string;
  category: ToolReliabilityCaseCategory;
  title: string;
  prompt: string;
  canary: string;
  metrics: ToolReliabilityMetricKey[];
}

/**
 * A scripted, deterministic multi-turn environment case (Stateful
 * ToolReliability charter, PR A). Unlike the single-shot categories this
 * replaced (scored from a single/paired model output), a stateful case is
 * scored by REPLAYING the model's recorded turn-by-turn outputs through
 * `createStatefulEnv` (stateful-env.ts) — the env is a pure function of
 * (case, outputs-so-far): no Date.now/Math.random, so certified scoring,
 * trace replay, and the probe all reproduce the identical verdict from
 * `candidate.outputs[caseId]`.
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

export type ToolReliabilityCase = StatefulToolReliabilityCase;

export interface ToolReliabilityCandidate {
  id: string;
  modelId?: string;
  providerId?: string;
  teamCompositionId?: string;
  outputs: Record<string, string[]>;
}

export type ToolReliabilityTraceEventType =
  | "case_started"
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
