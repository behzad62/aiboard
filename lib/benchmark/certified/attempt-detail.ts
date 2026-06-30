import type {
  BenchmarkArtifact,
  BenchmarkAttemptV2,
  BenchmarkCaseV2,
  BenchmarkFailure,
  BenchmarkModelCallTrace,
  BenchmarkRunEvent,
  BenchmarkTeamComposition,
  BenchmarkToolCallTrace,
  BenchmarkVerifierResult,
} from "@/lib/benchmark/types";
import { explainCertifiedFailureStatus } from "@/lib/benchmark/failures";
import { isScoredCertifiedAttempt } from "@/lib/benchmark/metrics";
import type {
  ToolReliabilityAccountability,
  ToolReliabilityCaseDiagnosis,
  ToolReliabilityDiagnosticSummary,
} from "@/lib/benchmark/toolreliability/diagnostics";
import {
  TOOL_RELIABILITY_CASE_CATEGORIES,
  type ToolReliabilityCaseCategory,
} from "@/lib/benchmark/toolreliability/types";
import type { CertifiedRunSummary } from "./run-status";

const TOOL_RELIABILITY_ACCOUNTABILITIES = [
  "provider",
  "aiboard",
  "test_design",
  "model",
] as const satisfies readonly ToolReliabilityAccountability[];
const TOOL_RELIABILITY_ACCOUNTABILITY_SET = new Set<string>(
  TOOL_RELIABILITY_ACCOUNTABILITIES
);
const TOOL_RELIABILITY_CASE_CATEGORY_SET = new Set<string>(
  TOOL_RELIABILITY_CASE_CATEGORIES
);

export interface AttemptDetailViewModelInput {
  summary: CertifiedRunSummary | null;
  cases: BenchmarkCaseV2[];
  attempts: BenchmarkAttemptV2[];
  teams: BenchmarkTeamComposition[];
  verifiers: BenchmarkVerifierResult[];
  traces: BenchmarkModelCallTrace[];
  runEvents: BenchmarkRunEvent[];
  toolCalls: BenchmarkToolCallTrace[];
  artifacts: BenchmarkArtifact[];
  failures: BenchmarkFailure[];
}

export interface AttemptDetailViewModel {
  attempt: BenchmarkAttemptV2;
  caseRecord: BenchmarkCaseV2 | null;
  team: BenchmarkTeamComposition | null;
  verifier: BenchmarkVerifierResult | null;
  scoreUse: {
    kind: "scored" | "excluded";
    accountability: "model" | "provider" | "harness" | "environment" | "user";
    label: string;
    explanation: string;
  };
  summary: {
    outcomeLabel: string;
    scoreUseLabel: string;
    scoreUseExplanation: string;
    modelCallCount: number;
    toolCallCount: number;
    budgetUsageLabel: string;
    verifierOutcome: "passed" | "failed" | "missing";
    verifierOutcomeLabel: string;
    assertionFailureCount: number;
    failureCount: number;
  };
  toolReliabilityDiagnostics?: {
    summary: ToolReliabilityDiagnosticSummary;
    cases: ToolReliabilityCaseDiagnosis[];
    accountabilityRows: Array<{
      accountability: ToolReliabilityAccountability;
      label: string;
      count: number;
    }>;
    categoryRows: Array<{
      category: string;
      label: string;
      total: number;
      failed: number;
    }>;
    topReasons: Array<{ reason: string; count: number }>;
    failedCases: Array<
      ToolReliabilityCaseDiagnosis & {
        categoryLabel: string;
        accountabilityLabel: string;
        modelResponses: Array<{
          id: string;
          label: string;
          meta: string;
          rawResponsePreview: string;
          parsedResponsePreview: string;
          error: string;
        }>;
        verifierEvents: Array<{
          id: string;
          label: string;
          status: string;
          detail: string;
        }>;
      }
    >;
  };
  modelTraces: BenchmarkModelCallTrace[];
  modelTraceRows: Array<{
    id: string;
    label: string;
    meta: string;
    caseId: string;
    schemaMode: string;
    rawResponsePreview: string;
    parsedResponsePreview: string;
    error: string;
  }>;
  runEvents: BenchmarkRunEvent[];
  toolCalls: BenchmarkToolCallTrace[];
  artifacts: BenchmarkArtifact[];
  patchArtifacts: BenchmarkArtifact[];
  failures: BenchmarkFailure[];
  metrics: {
    costUsd: number | null;
    inputTokens: number;
    outputTokens: number;
    modelCalls: number;
    toolCalls: number;
    durationMs: number;
    verifiedQuality: number;
    jobSuccessScore: number;
  };
  versions: {
    harnessVersion: string;
    promptSetVersion: string;
    scoringVersion: string;
  };
}

export function buildAttemptDetailViewModel(
  input: AttemptDetailViewModelInput
): AttemptDetailViewModel | null {
  if (!input.summary) return null;
  const attempt = input.attempts
    .filter((candidate) => candidate.runId === input.summary?.runId)
    .sort(compareAttemptRecency)[0];
  if (!attempt) return null;

  const artifacts = input.artifacts.filter(
    (artifact) =>
      artifact.attemptId === attempt.id ||
      attempt.artifactIds.includes(artifact.id)
  );
  const verifier =
    input.verifiers.find((candidate) => candidate.id === attempt.verifierResultId) ??
    input.verifiers.find((candidate) => candidate.attemptId === attempt.id) ??
    null;
  const failures = input.failures.filter(
    (failure) =>
      failure.attemptId === attempt.id || attempt.failureIds.includes(failure.id)
  );
  const scoreUse = classifyAttemptScoreUse(attempt);
  const assertionFailureCount = verifier?.assertionResults.filter(
    (assertion) => !assertion.passed
  ).length ?? 0;
  const modelTraces = input.traces.filter(
    (trace) => trace.attemptId === attempt.id || attempt.traceIds.includes(trace.id)
  );
  const toolCalls = input.toolCalls.filter((trace) => trace.attemptId === attempt.id);
  return {
    attempt,
    caseRecord:
      input.cases.find((caseRecord) => caseRecord.id === attempt.caseId) ?? null,
    team:
      input.teams.find((team) => team.id === attempt.teamCompositionId) ?? null,
    verifier,
    scoreUse,
    summary: {
      outcomeLabel: outcomeLabelForStatus(attempt.status),
      scoreUseLabel: scoreUse.label,
      scoreUseExplanation: scoreUse.explanation,
      modelCallCount: attempt.modelCalls,
      toolCallCount: attempt.toolCalls,
      budgetUsageLabel: formatBudgetUsage(attempt),
      verifierOutcome: verifier
        ? verifier.passed
          ? "passed"
          : "failed"
        : "missing",
      verifierOutcomeLabel: verifier
        ? verifier.passed
          ? "Verifier passed"
          : "Verifier failed"
        : "Verifier missing",
      assertionFailureCount,
      failureCount: failures.length,
    },
    toolReliabilityDiagnostics: parseToolReliabilityDiagnostics(
      attempt,
      verifier,
      modelTraces,
      toolCalls
    ),
    modelTraces,
    modelTraceRows: modelTraces.map(modelTraceRow),
    runEvents: input.runEvents
      .filter((event) => event.attemptId === attempt.id)
      .sort((left, right) => Date.parse(left.at) - Date.parse(right.at)),
    toolCalls,
    artifacts,
    patchArtifacts: artifacts.filter((artifact) => artifact.kind === "patch"),
    failures,
    metrics: {
      costUsd: attempt.costUsd,
      inputTokens: attempt.inputTokens,
      outputTokens: attempt.outputTokens,
      modelCalls: attempt.modelCalls,
      toolCalls: attempt.toolCalls,
      durationMs: attempt.durationMs,
      verifiedQuality: attempt.verifiedQuality,
      jobSuccessScore: attempt.jobSuccessScore,
    },
    versions: {
      harnessVersion: attempt.harnessVersion,
      promptSetVersion: attempt.promptSetVersion,
      scoringVersion: attempt.scoringVersion,
    },
  };
}

function modelTraceRow(trace: BenchmarkModelCallTrace): AttemptDetailViewModel["modelTraceRows"][number] {
  return {
    id: trace.id,
    label: trace.participantId ?? trace.modelId,
    meta: `${trace.providerId} - ${trace.inputTokens ?? 0}/${trace.outputTokens ?? 0} tokens`,
    caseId: trace.caseId ?? "unknown-case",
    schemaMode: trace.schemaMode ?? "unknown",
    rawResponsePreview: previewTraceText(trace.rawResponse),
    parsedResponsePreview: previewTraceText(trace.parsedResponseJson),
    error: trace.error ?? "",
  };
}

function previewTraceText(value: string | undefined): string {
  if (!value) return "";
  const limit = 1_500;
  if (value.length <= limit) return value;
  return `${value.slice(0, limit)}\n[truncated ${value.length - limit} chars]`;
}

function compareAttemptRecency(
  left: BenchmarkAttemptV2,
  right: BenchmarkAttemptV2
): number {
  const leftTime = Date.parse(left.completedAt ?? left.startedAt);
  const rightTime = Date.parse(right.completedAt ?? right.startedAt);
  return (Number.isFinite(rightTime) ? rightTime : 0) -
    (Number.isFinite(leftTime) ? leftTime : 0);
}

function parseToolReliabilityDiagnostics(
  attempt: BenchmarkAttemptV2,
  verifier: BenchmarkVerifierResult | null,
  modelTraces: BenchmarkModelCallTrace[],
  toolCalls: BenchmarkToolCallTrace[]
): AttemptDetailViewModel["toolReliabilityDiagnostics"] {
  if (!verifier) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(verifier.resultJson);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed)) return undefined;
  const diagnostics = parsed.diagnostics;
  if (!isRecord(diagnostics)) return undefined;
  const summary = parseToolReliabilityDiagnosticSummary(diagnostics.summary);
  const cases = parseToolReliabilityDiagnosticCases(diagnostics.cases);
  if (!summary || !cases) return undefined;
  const failedCases = cases
    .filter((item) => !item.passed)
    .map((item) => ({
      ...item,
      categoryLabel: toolReliabilityCategoryLabel(item.category),
      accountabilityLabel: toolReliabilityAccountabilityLabel(item.accountability),
      modelResponses: modelTraces
        .filter((trace) => trace.caseId === item.caseId)
        .map((trace) => {
          const row = modelTraceRow(trace);
          return {
            id: row.id,
            label: row.label,
            meta: `${row.caseId} - ${row.meta} - ${row.schemaMode}`,
            rawResponsePreview: row.rawResponsePreview,
            parsedResponsePreview: row.parsedResponsePreview,
            error: row.error,
          };
        }),
      verifierEvents: toolCalls
        .filter((trace) => trace.caseId === item.caseId)
        .map((trace) => ({
          id: trace.id,
          label: trace.toolName,
          status: trace.status,
          detail: [
            trace.outputPreview ?? "",
            trace.inputJson ? `Details\n${trace.inputJson}` : "",
            trace.error ? `Error\n${trace.error}` : "",
          ]
            .filter(Boolean)
            .join("\n\n"),
        })),
    }));
  return {
    summary,
    cases,
    accountabilityRows: TOOL_RELIABILITY_ACCOUNTABILITIES.map((accountability) => ({
      accountability,
      label: toolReliabilityAccountabilityLabel(accountability),
      count: summary.byAccountability[accountability],
    })),
    categoryRows: Object.entries(summary.byCategory)
      .map(([category, row]) => ({
        category,
        label: toolReliabilityCategoryLabel(category),
        total: row.total,
        failed: row.failed,
      }))
      .sort((left, right) => right.failed - left.failed || right.total - left.total),
    topReasons: summary.topReasons.filter((item) => item.count > 0),
    failedCases,
  };
}

function parseToolReliabilityDiagnosticSummary(
  value: unknown
): ToolReliabilityDiagnosticSummary | undefined {
  if (!isRecord(value)) return undefined;
  if (!isNumber(value.total) || !isNumber(value.passed) || !isNumber(value.failed)) {
    return undefined;
  }
  if (!isRecord(value.byAccountability)) return undefined;
  const byAccountability = parseByAccountability(value.byAccountability);
  if (!byAccountability) return undefined;
  const byCategory = parseByCategory(value.byCategory);
  if (!byCategory) return undefined;
  const topReasons = parseTopReasons(value.topReasons);
  if (!topReasons) return undefined;

  return {
    total: value.total,
    passed: value.passed,
    failed: value.failed,
    byAccountability,
    byCategory,
    topReasons,
  };
}

function parseByAccountability(
  value: Record<string, unknown>
): Record<ToolReliabilityAccountability, number> | undefined {
  const byAccountability: Record<ToolReliabilityAccountability, number> = {
    provider: 0,
    aiboard: 0,
    test_design: 0,
    model: 0,
  };

  for (const accountability of TOOL_RELIABILITY_ACCOUNTABILITIES) {
    const count = value[accountability];
    if (!isNumber(count)) return undefined;
    byAccountability[accountability] = count;
  }

  return byAccountability;
}

function parseByCategory(
  value: unknown
): ToolReliabilityDiagnosticSummary["byCategory"] | undefined {
  if (!isRecord(value)) return undefined;
  const byCategory: ToolReliabilityDiagnosticSummary["byCategory"] = {};

  for (const [category, row] of Object.entries(value)) {
    if (!isRecord(row) || !isNumber(row.total) || !isNumber(row.failed)) {
      return undefined;
    }
    byCategory[category] = {
      total: row.total,
      failed: row.failed,
    };
  }

  return byCategory;
}

function parseTopReasons(
  value: unknown
): ToolReliabilityDiagnosticSummary["topReasons"] | undefined {
  if (!Array.isArray(value)) return undefined;
  const topReasons: ToolReliabilityDiagnosticSummary["topReasons"] = [];

  for (const item of value) {
    if (!isRecord(item) || !isString(item.reason) || !isNumber(item.count)) {
      return undefined;
    }
    topReasons.push({
      reason: item.reason,
      count: item.count,
    });
  }

  return topReasons;
}

function parseToolReliabilityDiagnosticCases(
  value: unknown
): ToolReliabilityCaseDiagnosis[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const cases: ToolReliabilityCaseDiagnosis[] = [];

  for (const item of value) {
    if (!isRecord(item)) return undefined;
    if (
      !isString(item.caseId) ||
      !isToolReliabilityCaseCategory(item.category) ||
      typeof item.passed !== "boolean" ||
      !isToolReliabilityAccountability(item.accountability) ||
      !isString(item.reason) ||
      !isString(item.evidence)
    ) {
      return undefined;
    }
    cases.push({
      caseId: item.caseId,
      category: item.category,
      passed: item.passed,
      accountability: item.accountability,
      reason: item.reason,
      evidence: item.evidence,
    });
  }

  return cases;
}

function isToolReliabilityCaseCategory(
  value: unknown
): value is ToolReliabilityCaseCategory {
  return isString(value) && TOOL_RELIABILITY_CASE_CATEGORY_SET.has(value);
}

function isToolReliabilityAccountability(
  value: unknown
): value is ToolReliabilityAccountability {
  return isString(value) && TOOL_RELIABILITY_ACCOUNTABILITY_SET.has(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function classifyAttemptScoreUse(
  attempt: BenchmarkAttemptV2
): AttemptDetailViewModel["scoreUse"] {
  if (isScoredCertifiedAttempt(attempt)) {
    return {
      kind: "scored",
      accountability: "model",
      label: "Counts toward score",
      explanation: explainCertifiedFailureStatus(attempt.status),
    };
  }

  switch (attempt.status) {
    case "provider_unavailable":
      return excludedScoreUse(
        "provider",
        "Excluded from score (Provider)",
        attempt.status
      );
    case "invalid_harness":
      return excludedScoreUse(
        "harness",
        "Excluded from score (AIBoard harness)",
        attempt.status
      );
    case "invalid_environment":
      return excludedScoreUse(
        "environment",
        "Excluded from score (Environment)",
        attempt.status
      );
    case "invalid_case":
      return {
        kind: "excluded",
        accountability: "harness",
        label: "Excluded from score (Test design)",
        explanation: explainCertifiedFailureStatus(attempt.status),
      };
    case "aborted_user":
      return excludedScoreUse(
        "user",
        "Excluded from score (User cancelled)",
        attempt.status
      );
    default:
      return {
        kind: "scored",
        accountability: "model",
        label: "Counts toward score",
        explanation: explainCertifiedFailureStatus(attempt.status),
      };
  }
}

function excludedScoreUse(
  accountability: AttemptDetailViewModel["scoreUse"]["accountability"],
  label: string,
  status: BenchmarkAttemptV2["status"]
): AttemptDetailViewModel["scoreUse"] {
  return {
    kind: "excluded",
    accountability,
    label,
    explanation: explainCertifiedFailureStatus(status),
  };
}

function outcomeLabelForStatus(status: BenchmarkAttemptV2["status"]): string {
  switch (status) {
    case "passed":
      return "Passed";
    case "failed_model":
      return "Model failed task";
    case "failed_verifier":
      return "Verifier failed";
    case "failed_tool_use":
      return "Invalid tool use";
    case "failed_budget":
      return "Budget exhausted";
    case "provider_unavailable":
      return "Provider unavailable";
    case "invalid_harness":
      return "AIBoard harness invalid";
    case "invalid_environment":
      return "Environment invalid";
    case "invalid_case":
      return "Test design invalid";
    case "aborted_user":
      return "User aborted";
  }
}

function formatBudgetUsage(attempt: BenchmarkAttemptV2): string {
  const parts: string[] = [];
  if (attempt.costUsd != null) {
    parts.push(`$${attempt.costUsd.toFixed(4)}`);
  }
  parts.push(`${attempt.inputTokens + attempt.outputTokens} tokens`);
  parts.push(`${(attempt.durationMs / 1000).toFixed(1)}s`);
  return parts.join(" - ");
}

function toolReliabilityAccountabilityLabel(
  accountability: ToolReliabilityAccountability
): string {
  switch (accountability) {
    case "aiboard":
      return "AIBoard harness";
    case "test_design":
      return "Test design";
    case "model":
      return "Model";
    case "provider":
      return "Provider";
  }
}

function toolReliabilityCategoryLabel(category: string): string {
  switch (category) {
    case "json-schema":
      return "JSON schema";
    case "tool-call":
      return "Tool call";
    case "repair-loop":
      return "Repair loop";
    case "forbidden-action":
      return "Forbidden action";
    case "patch":
      return "Patch";
    default:
      return category;
  }
}
