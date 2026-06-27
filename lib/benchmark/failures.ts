import type { BuildProblemSource } from "../db/schema";
import type {
  BenchmarkFailure,
  CertifiedAttemptStatus,
} from "./types";

export type CertifiedFailureGroup =
  | "model"
  | "tool"
  | "harness"
  | "environment"
  | "case"
  | "provider"
  | "user";

export const CERTIFIED_FAILURE_GROUPS: CertifiedFailureGroup[] = [
  "model",
  "tool",
  "harness",
  "environment",
  "case",
  "provider",
  "user",
];

export type CertifiedFailureSource =
  | BenchmarkFailure["source"]
  | BuildProblemSource
  | "case"
  | "environment"
  | "harness"
  | "user"
  | "verifier"
  | "unknown";

export interface CertifiedFailureInput {
  code: string;
  source?: CertifiedFailureSource;
  message?: string;
  details?: string;
}

export interface CertifiedFailureClassification {
  code: string;
  normalizedCode: string;
  group: CertifiedFailureGroup;
  status: CertifiedAttemptStatus;
  invalidRun: boolean;
  modelAccountable: boolean;
  label: string;
  reason: string;
  source?: CertifiedFailureSource;
}

type FailureRule = {
  group: CertifiedFailureGroup;
  status: CertifiedAttemptStatus;
  invalidRun?: boolean;
  modelAccountable?: boolean;
  label: string;
  reason: string;
};

const TOOL_USE_FAILURE: FailureRule = {
  group: "tool",
  status: "failed_tool_use",
  label: "Invalid tool use",
  reason: "The model emitted an invalid, unsafe, denied, or unapplyable tool action.",
};

const MODEL_FAILURE: FailureRule = {
  group: "model",
  status: "failed_model",
  label: "Model failed task",
  reason: "The attempt failed because the model did not complete the task.",
};

const VERIFIER_FAILURE: FailureRule = {
  group: "model",
  status: "failed_verifier",
  label: "Verifier failed",
  reason: "The deterministic verifier rejected the final answer or code.",
};

const PROVIDER_FAILURE: FailureRule = {
  group: "provider",
  status: "provider_unavailable",
  invalidRun: true,
  modelAccountable: false,
  label: "Provider unavailable",
  reason: "The provider failed before a usable model output was produced.",
};

const HARNESS_FAILURE: FailureRule = {
  group: "harness",
  status: "invalid_harness",
  invalidRun: true,
  modelAccountable: false,
  label: "Harness invalid",
  reason: "AI Board or the benchmark harness mishandled an otherwise valid run.",
};

const ENVIRONMENT_FAILURE: FailureRule = {
  group: "environment",
  status: "invalid_environment",
  invalidRun: true,
  modelAccountable: false,
  label: "Environment invalid",
  reason: "The runner, container, dependency environment, or host setup failed.",
};

const CASE_FAILURE: FailureRule = {
  group: "case",
  status: "invalid_case",
  invalidRun: true,
  modelAccountable: false,
  label: "Case invalid",
  reason: "The case setup, manifest, verifier configuration, or fixture is broken.",
};

const USER_ABORTED_FAILURE: FailureRule = {
  group: "user",
  status: "aborted_user",
  invalidRun: true,
  modelAccountable: false,
  label: "User aborted",
  reason: "The run was cancelled by the user and must not count as a model failure.",
};

const BUDGET_FAILURE: FailureRule = {
  group: "model",
  status: "failed_budget",
  label: "Budget exhausted",
  reason: "The model or team exhausted the certified run budget before passing.",
};

const CODE_RULES: Record<string, FailureRule> = {
  malformed_tool_call: TOOL_USE_FAILURE,
  tool_warning: TOOL_USE_FAILURE,
  empty_tool_batch: TOOL_USE_FAILURE,
  duplicate_tool_call: TOOL_USE_FAILURE,
  patch_failed: TOOL_USE_FAILURE,
  edit_failed: TOOL_USE_FAILURE,
  write_conflict: TOOL_USE_FAILURE,
  write_scope_rejected: TOOL_USE_FAILURE,
  suspicious_rewrite: TOOL_USE_FAILURE,
  command_failed: TOOL_USE_FAILURE,
  tool_denied: TOOL_USE_FAILURE,
  invalid_tool_call: TOOL_USE_FAILURE,
  invalid_json_tool_call: TOOL_USE_FAILURE,
  forbidden_tool_call: TOOL_USE_FAILURE,
  forbidden_action: TOOL_USE_FAILURE,
  forbidden_command: TOOL_USE_FAILURE,
  unsafe_command: TOOL_USE_FAILURE,

  verification_failed: VERIFIER_FAILURE,
  verification_repeated: VERIFIER_FAILURE,
  verifier_failed: VERIFIER_FAILURE,
  assertion_failed: VERIFIER_FAILURE,

  no_output: MODEL_FAILURE,
  repeated_no_progress: MODEL_FAILURE,
  incomplete_tasks: MODEL_FAILURE,
  quality_gate_failed: MODEL_FAILURE,
  truncated_output: MODEL_FAILURE,
  skill_evidence_missing: MODEL_FAILURE,
  browser_acceptance_missing: MODEL_FAILURE,

  budget_exhausted: BUDGET_FAILURE,
  budget_failed: BUDGET_FAILURE,

  provider_429_before_output: PROVIDER_FAILURE,
  provider_unavailable: PROVIDER_FAILURE,
  provider_rate_limited: PROVIDER_FAILURE,
  provider_rate_limit: PROVIDER_FAILURE,
  provider_timeout_before_output: PROVIDER_FAILURE,
  provider_error_before_output: PROVIDER_FAILURE,
  provider_auth_failed: PROVIDER_FAILURE,
  provider_error: PROVIDER_FAILURE,

  parser_bug: HARNESS_FAILURE,
  harness_parser_bug: HARNESS_FAILURE,
  valid_output_discarded: HARNESS_FAILURE,
  harness_discarded_valid_output: HARNESS_FAILURE,
  benchmark_bug: HARNESS_FAILURE,
  scoring_bug: HARNESS_FAILURE,
  invalid_harness: HARNESS_FAILURE,

  runner_crash: ENVIRONMENT_FAILURE,
  docker_image_missing: ENVIRONMENT_FAILURE,
  docker_unavailable: ENVIRONMENT_FAILURE,
  dependency_install_failed: ENVIRONMENT_FAILURE,
  runner_unavailable: ENVIRONMENT_FAILURE,
  invalid_environment: ENVIRONMENT_FAILURE,

  case_setup_failed: CASE_FAILURE,
  setup_command_failed: CASE_FAILURE,
  verifier_config_error: CASE_FAILURE,
  manifest_invalid: CASE_FAILURE,
  fixture_missing: CASE_FAILURE,
  invalid_case: CASE_FAILURE,

  aborted_user: USER_ABORTED_FAILURE,
  user_aborted: USER_ABORTED_FAILURE,
  user_cancelled: USER_ABORTED_FAILURE,
};

export const CERTIFIED_FAILURE_STATUS_EXPLANATIONS: Record<
  CertifiedAttemptStatus,
  string
> = {
  passed: "The certified attempt passed and has no failure classification.",
  failed_model: "The model or team failed the task outside verifier/tool-specific categories.",
  failed_verifier: "The verifier ran and rejected the final model output.",
  failed_tool_use: "The model or team produced invalid, unsafe, denied, or unapplyable tool actions.",
  failed_budget: "The model or team exhausted the certified budget before passing.",
  provider_unavailable: "The provider failed before usable output, so the run is invalid for scoring.",
  invalid_harness: "AI Board or the benchmark harness mishandled the run, so the run is invalid for scoring.",
  invalid_environment: "The runner, container, dependency environment, or host failed, so the run is invalid for scoring.",
  invalid_case: "The case, fixture, setup command, or verifier configuration is broken, so the run is invalid for scoring.",
  aborted_user: "The user cancelled the run, so it is excluded from official scoring.",
};

const INVALID_STATUSES = new Set<CertifiedAttemptStatus>([
  "provider_unavailable",
  "invalid_harness",
  "invalid_environment",
  "invalid_case",
  "aborted_user",
]);

export function normalizeFailureCode(code: string): string {
  return code
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

export function classifyCertifiedFailure(
  input: CertifiedFailureInput
): CertifiedFailureClassification {
  const normalizedCode = normalizeFailureCode(input.code);
  const source = normalizeFailureSource(input.source);
  const text = `${input.message ?? ""}\n${input.details ?? ""}`.toLowerCase();
  const sourceRule = classifyBySourceAndText(source, normalizedCode, text);
  const rule = sourceRule ?? CODE_RULES[normalizedCode] ?? fallbackRule(source, text);
  const invalidRun = rule.invalidRun ?? INVALID_STATUSES.has(rule.status);

  return {
    code: input.code,
    normalizedCode,
    group: rule.group,
    status: rule.status,
    invalidRun,
    modelAccountable: rule.modelAccountable ?? !invalidRun,
    label: rule.label,
    reason: rule.reason,
    source,
  };
}

export function classifyBenchmarkFailure(
  failure: Pick<BenchmarkFailure, "code" | "source" | "message" | "details">
): CertifiedFailureClassification {
  return classifyCertifiedFailure({
    code: failure.code,
    source: failure.source,
    message: failure.message,
    details: failure.details,
  });
}

export function isInvalidCertifiedRun(
  value: CertifiedAttemptStatus | CertifiedFailureClassification
): boolean {
  return typeof value === "string"
    ? INVALID_STATUSES.has(value)
    : value.invalidRun;
}

export function explainCertifiedFailureStatus(
  status: CertifiedAttemptStatus
): string {
  return CERTIFIED_FAILURE_STATUS_EXPLANATIONS[status];
}

export interface CertifiedFailureGroupSummary {
  group: CertifiedFailureGroup;
  count: number;
  invalidRuns: number;
  modelAccountable: number;
  statuses: Partial<Record<CertifiedAttemptStatus, number>>;
}

export function groupFailureClassifications(
  classifications: CertifiedFailureClassification[]
): CertifiedFailureGroupSummary[] {
  const byGroup = new Map<CertifiedFailureGroup, CertifiedFailureGroupSummary>();
  for (const group of CERTIFIED_FAILURE_GROUPS) {
    byGroup.set(group, {
      group,
      count: 0,
      invalidRuns: 0,
      modelAccountable: 0,
      statuses: {},
    });
  }

  for (const classification of classifications) {
    const row = byGroup.get(classification.group);
    if (!row) continue;
    row.count += 1;
    if (classification.invalidRun) row.invalidRuns += 1;
    if (classification.modelAccountable) row.modelAccountable += 1;
    row.statuses[classification.status] =
      (row.statuses[classification.status] ?? 0) + 1;
  }

  return CERTIFIED_FAILURE_GROUPS.map((group) => byGroup.get(group)!).filter(
    (row) => row.count > 0
  );
}

function normalizeFailureSource(
  source: CertifiedFailureSource | undefined
): CertifiedFailureSource | undefined {
  if (!source) return undefined;
  const normalized = normalizeFailureCode(source);
  if (normalized === "parser") return "parser";
  if (normalized === "provider") return "provider";
  if (normalized === "runner") return "runner";
  if (normalized === "case") return "case";
  if (normalized === "environment") return "environment";
  if (normalized === "harness") return "harness";
  if (normalized === "user") return "user";
  if (normalized === "verifier") return "verifier";
  return source;
}

function classifyBySourceAndText(
  source: CertifiedFailureSource | undefined,
  code: string,
  text: string
): FailureRule | null {
  if (source === "provider" || mentionsProviderBeforeOutput(code, text)) {
    return PROVIDER_FAILURE;
  }
  if (source === "parser" || source === "harness" || mentionsHarnessBug(text)) {
    return HARNESS_FAILURE;
  }
  if (source === "case" || mentionsCaseSetup(text)) {
    return CASE_FAILURE;
  }
  if (source === "environment" || mentionsEnvironmentFailure(code, text)) {
    return ENVIRONMENT_FAILURE;
  }
  if (source === "user") {
    return USER_ABORTED_FAILURE;
  }
  return null;
}

function fallbackRule(
  source: CertifiedFailureSource | undefined,
  text: string
): FailureRule {
  if (source === "runner" && /crash|unavailable|docker|container/.test(text)) {
    return ENVIRONMENT_FAILURE;
  }
  if (source === "benchmark" || source === "rules") {
    return CASE_FAILURE;
  }
  return MODEL_FAILURE;
}

function mentionsProviderBeforeOutput(code: string, text: string): boolean {
  const haystack = `${code}\n${text}`;
  return (
    /provider|openai|anthropic|google|openrouter|rate.?limit|429|503|timeout/.test(
      haystack
    ) && /before.*output|no output|unavailable|rate.?limit|429|503/.test(haystack)
  );
}

function mentionsHarnessBug(text: string): boolean {
  return /parser bug|harness bug|valid output discarded|discarded valid|scoring bug/.test(
    text
  );
}

function mentionsCaseSetup(text: string): boolean {
  return /case setup|setup command|manifest|fixture|verifier config|broken case/.test(
    text
  );
}

function mentionsEnvironmentFailure(code: string, text: string): boolean {
  const haystack = `${code}\n${text}`;
  return /runner crash|docker image missing|docker unavailable|container missing|dependency install failed/.test(
    haystack
  );
}
