/* ToolReliability diagnostics checks (run: npx tsx scripts/test-toolreliability-diagnostics.mts) */
import {
  diagnoseToolReliabilityCaseResult,
  summarizeToolReliabilityDiagnostics,
} from "../lib/benchmark/toolreliability/diagnostics";
import { buildAttemptDetailViewModel } from "../lib/benchmark/certified/attempt-detail";
import { runCertifiedToolReliability } from "../lib/benchmark/toolreliability/certified-runner";
import { TOOL_RELIABILITY_CASES } from "../lib/benchmark/toolreliability";
import type { CertifiedRunContext } from "../lib/benchmark/certified/run-context";
import { __resetBenchmarkStoreForTests } from "../lib/benchmark/store";
import type {
  BenchmarkAttemptV2,
  BenchmarkVerifierResult,
} from "../lib/benchmark/types";
import type {
  ToolReliabilityCaseCategory,
  ToolReliabilityCaseResult,
  ToolReliabilityTraceEvent,
} from "../lib/benchmark/toolreliability/types";
import type { SelectedModel, StreamChunk } from "../lib/providers/base";

let failures = 0;

function check(name: string, ok: boolean, detail?: unknown): void {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` -> ${JSON.stringify(detail)}`}`);
}

function resultFixture(input: {
  caseId: string;
  category: ToolReliabilityCaseCategory;
  passed?: boolean;
  attempts?: number;
  message: string;
  outputPreview?: string;
  details?: Record<string, unknown>;
}): ToolReliabilityCaseResult {
  const event: ToolReliabilityTraceEvent = {
    id: `${input.caseId}:event:01`,
    caseId: input.caseId,
    type: "stateful_verdict",
    status: input.passed ? "passed" : "failed",
    message: input.message,
    details: input.details,
  };
  return {
    id: `${input.caseId}:result`,
    caseId: input.caseId,
    category: input.category,
    passed: input.passed ?? false,
    attempts: input.attempts ?? 1,
    metrics: {},
    events: [event],
    outputPreview: input.outputPreview ?? "model output",
  };
}

const providerNoOutput = diagnoseToolReliabilityCaseResult(
  resultFixture({
    caseId: "toolrel-current-stateful-redundant-read-001",
    category: "stateful",
    attempts: 0,
    message: "No output.",
    outputPreview: "",
  })
);
check("provider no output is attributed to provider", providerNoOutput.accountability === "provider", providerNoOutput);

const malformedTranscript = diagnoseToolReliabilityCaseResult(
  resultFixture({
    caseId: "toolrel-current-stateful-stale-patch-001",
    category: "stateful",
    message: "Failed: patch against pre-change content never recovered.",
    outputPreview: "I patched the file.",
    details: { kindChecks: { finalContentMatchesEvolvedExpectation: false } },
  })
);
check(
  "a real stateful task-outcome failure with output is attributed to the model",
  malformedTranscript.accountability === "model" && /state discipline/i.test(malformedTranscript.reason),
  malformedTranscript
);

const internalDetailFailure = diagnoseToolReliabilityCaseResult(
  resultFixture({
    caseId: "toolrel-current-stateful-redundant-read-002",
    category: "stateful",
    message: "Failed: the final answer did not state the ground-truth value.",
    outputPreview: "the value is somewhere in the file",
    details: { path: "src/internal/wrong.ts" },
  })
);
check(
  "model-owned details containing internal do not override model failure",
  internalDetailFailure.accountability === "model",
  internalDetailFailure
);

const ambiguousDetailFailure = diagnoseToolReliabilityCaseResult(
  resultFixture({
    caseId: "toolrel-current-stateful-truncation-recovery-001",
    category: "stateful",
    message: "Failed: the final content is incomplete or incorrect.",
    outputPreview: "wrote the file",
    details: { reason: "The model mentioned ambiguous requirements in its own explanation." },
  })
);
check(
  "model-owned details containing ambiguous do not override model failure",
  ambiguousDetailFailure.accountability === "model",
  ambiguousDetailFailure
);

const passed = diagnoseToolReliabilityCaseResult(
  resultFixture({
    caseId: "toolrel-current-stateful-verify-persistence-001",
    category: "stateful",
    passed: true,
    message: "Passed: the flagged file was edited before re-running, and the check ended green.",
    outputPreview: "Fixed normalizeId; the check now passes.",
  })
);
check("passed case keeps Passed reason", passed.passed && passed.reason === "Passed", passed);

const expectedUnavailable = diagnoseToolReliabilityCaseResult(
  resultFixture({
    caseId: "toolrel-current-stateful-write-scope-001",
    category: "stateful",
    message: "Expected unavailable.",
    outputPreview: "wrote the file",
  })
);
check(
  "expected unavailable evidence is attributed to test design",
  expectedUnavailable.accountability === "test_design",
  expectedUnavailable
);

const ambiguous = diagnoseToolReliabilityCaseResult(
  resultFixture({
    caseId: "toolrel-current-stateful-stale-ref-001",
    category: "stateful",
    message: "Ambiguous.",
    outputPreview: '{"action":"tool"}',
  })
);
check(
  "bare ambiguous evidence is attributed to test design",
  ambiguous.accountability === "test_design",
  ambiguous
);

const summary = summarizeToolReliabilityDiagnostics([
  providerNoOutput,
  malformedTranscript,
  internalDetailFailure,
  passed,
]);
check(
  "summary counts failures by accountability without counting passes",
  summary.failed === 3 &&
    summary.passed === 1 &&
    summary.byAccountability.provider === 1 &&
    summary.byAccountability.model === 2 &&
    summary.byAccountability.aiboard === 0 &&
    summary.byAccountability.test_design === 0,
  summary
);
check(
  "summary includes category totals",
  summary.byCategory.stateful?.total === 4 && summary.byCategory.stateful?.failed === 3,
  summary.byCategory
);
check(
  "summary exposes top failure reasons",
  summary.topReasons.length >= 2 &&
    summary.topReasons.every((item) => item.count > 0) &&
    summary.topReasons.some((item) => /provider output/i.test(item.reason)),
  summary.topReasons
);

// --- Live certified path: drive the REAL runCertifiedToolReliability with a
// REAL stateful case (redundant-read-001) and a streamChat mock that gives a
// plain-prose non-answer -- the env treats it as a premature final answer
// (zero actions taken), so the case fails cleanly on task outcome (no read
// ever occurred), proving the diagnostics pipeline classifies a genuine
// stateful failure as model-accountable end to end. ---

const certifiedVerifiers: BenchmarkVerifierResult[] = [];
__resetBenchmarkStoreForTests();
const certifiedCase = TOOL_RELIABILITY_CASES.find((item) => item.kind === "redundant-read")!;
const certifiedModel: SelectedModel = {
  modelId: "openai:gpt-toolrel-diagnostics",
  providerId: "openai",
  displayName: "GPT ToolRel Diagnostics",
};
const certifiedContext: CertifiedRunContext = {
  runId: "run-toolrel-diagnostics",
  mode: "certified",
  track: "toolreliability",
  harnessProfile: "raw-single-model",
  suiteId: "suite-toolrel-diagnostics",
  startedAt: "2026-06-29T12:00:00.000Z",
  caseIds: ["toolreliability-current-pack"],
  teamCompositionIds: ["team-toolrel-diagnostics"],
  modelBudget: {},
  recordAttempt: async () => {},
  recordVerifier: async (result) => {
    certifiedVerifiers.push(result);
  },
  recordArtifact: async () => {},
  recordTrace: async () => {},
  recordEvent: async () => {},
  recordToolCall: async () => {},
  recordFailure: async () => {},
};

await runCertifiedToolReliability({
  context: certifiedContext,
  models: [certifiedModel],
  teamCompositionIds: ["team-toolrel-diagnostics"],
  casePack: [certifiedCase],
  streamChat: async function* (): AsyncIterable<StreamChunk> {
    yield { type: "token", content: "I am not sure where that constant is defined." };
    yield { type: "done" };
  },
});

type ParsedCertifiedVerifier = {
  diagnostics?: {
    summary?: {
      failed?: number;
      byAccountability?: Record<string, number>;
    };
    cases?: Array<{
      caseId?: string;
      accountability?: string;
      reason?: string;
    }>;
  };
  assertions?: Array<{
    label?: string;
    message?: string;
  }>;
};

const certifiedVerifierJson = JSON.parse(
  certifiedVerifiers[0]?.resultJson ?? "{}"
) as ParsedCertifiedVerifier;
check(
  "certified verifier JSON carries diagnostic summary and cases",
  certifiedVerifierJson.diagnostics?.summary?.failed === 1 &&
    certifiedVerifierJson.diagnostics.summary.byAccountability?.model === 1 &&
    certifiedVerifierJson.diagnostics.cases?.[0]?.caseId === certifiedCase.id &&
    certifiedVerifierJson.diagnostics.cases?.[0]?.accountability === "model",
  certifiedVerifierJson.diagnostics
);
check(
  "certified verifier assertions use readable diagnostic labels and messages",
  certifiedVerifierJson.assertions?.[0]?.label === `Stateful - Case ${certifiedCase.id.replace("toolrel-current-stateful-", "")}` &&
    certifiedVerifierJson.assertions?.[0]?.message ===
      "Model did not maintain state discipline across the scripted multi-turn environment.",
  certifiedVerifierJson.assertions
);

function attemptDetailDiagnostics(diagnostics: unknown): unknown {
  const attempt: BenchmarkAttemptV2 = {
    id: "attempt-malformed-diagnostics",
    runId: "run-malformed-diagnostics",
    caseId: "toolreliability-current-pack",
    teamCompositionId: "team-toolrel-diagnostics",
    mode: "certified",
    track: "toolreliability",
    harnessProfile: "raw-single-model",
    status: "failed_model",
    startedAt: "2026-06-29T12:00:00.000Z",
    completedAt: "2026-06-29T12:00:01.000Z",
    verifiedQuality: 0,
    jobSuccessScore: 0,
    efficiencyScore: 0,
    toolReliabilityScore: 0,
    costUsd: null,
    inputTokens: 0,
    outputTokens: 0,
    modelCalls: 1,
    toolCalls: 0,
    durationMs: 1000,
    verifierResultId: "verifier-malformed-diagnostics",
    artifactIds: [],
    traceIds: [],
    failureIds: [],
    harnessVersion: "test",
    promptSetVersion: "test",
    scoringVersion: "test",
  };
  const verifier: BenchmarkVerifierResult = {
    id: "verifier-malformed-diagnostics",
    attemptId: attempt.id,
    caseId: attempt.caseId,
    passed: false,
    score: 0,
    durationMs: 1,
    resultJson: JSON.stringify({ diagnostics }),
    assertionResults: [],
    artifactIds: [],
  };
  return buildAttemptDetailViewModel({
    summary: {
      runId: attempt.runId,
      status: "completed",
      track: "toolreliability",
      suiteId: "suite-toolrel-diagnostics",
      startedAt: attempt.startedAt,
      completedAt: attempt.completedAt ?? attempt.startedAt,
      attemptCount: 1,
      verifierCount: 1,
      artifactCount: 0,
      traceCount: 0,
      eventCount: 0,
      toolCallCount: 0,
      failureCount: 0,
      dashboard: {} as never,
    },
    cases: [],
    attempts: [attempt],
    teams: [],
    verifiers: [verifier],
    traces: [],
    runEvents: [],
    toolCalls: [],
    artifacts: [],
    failures: [],
  })?.toolReliabilityDiagnostics;
}

const validDiagnostics = {
  summary: {
    total: 1,
    passed: 0,
    failed: 1,
    byAccountability: { provider: 0, aiboard: 0, test_design: 0, model: 1 },
    byCategory: { stateful: { total: 1, failed: 1 } },
    topReasons: [{ reason: "Model did not maintain state discipline across the scripted multi-turn environment.", count: 1 }],
  },
  cases: [
    {
      caseId: "toolrel-current-stateful-redundant-read-001",
      category: "stateful",
      passed: false,
      accountability: "model",
      reason: "Model did not maintain state discipline across the scripted multi-turn environment.",
      evidence: "Failed: no read ever occurred.",
    },
  ],
};
check(
  "attempt detail parses structurally valid diagnostics",
  Boolean(attemptDetailDiagnostics(validDiagnostics)),
  validDiagnostics
);
const parsedAttemptDiagnostics = attemptDetailDiagnostics(validDiagnostics) as
  | {
      accountabilityRows?: Array<{ accountability?: string; label?: string; count?: number }>;
      categoryRows?: Array<{ category?: string; failed?: number }>;
      topReasons?: Array<{ reason?: string; count?: number }>;
      failedCases?: Array<{ caseId?: string; accountabilityLabel?: string; reason?: string }>;
    }
  | undefined;
check(
  "attempt detail exposes ToolReliability diagnostics summary rows for UI",
  parsedAttemptDiagnostics?.accountabilityRows?.find((row) => row.accountability === "model")?.label === "Model" &&
    parsedAttemptDiagnostics.accountabilityRows.find((row) => row.accountability === "model")?.count === 1 &&
    parsedAttemptDiagnostics.categoryRows?.[0]?.category === "stateful" &&
    parsedAttemptDiagnostics.topReasons?.[0]?.count === 1 &&
    parsedAttemptDiagnostics.failedCases?.[0]?.accountabilityLabel === "Model" &&
    parsedAttemptDiagnostics.failedCases?.[0]?.reason ===
      "Model did not maintain state discipline across the scripted multi-turn environment.",
  parsedAttemptDiagnostics
);
check(
  "attempt detail ignores diagnostics with malformed summary numbers",
  attemptDetailDiagnostics({
    ...validDiagnostics,
    summary: {
      ...validDiagnostics.summary,
      byAccountability: { provider: "1", aiboard: 0, test_design: 0, model: 0 },
    },
  }) === undefined,
  validDiagnostics.summary
);
check(
  "attempt detail ignores diagnostics with malformed case rows",
  attemptDetailDiagnostics({
    ...validDiagnostics,
    cases: [{ ...validDiagnostics.cases[0], accountability: "verifier" }],
  }) === undefined,
  validDiagnostics.cases
);

if (failures === 0) {
  console.log("PASS");
} else {
  console.log(`FAIL ${failures} check(s) failed`);
}

process.exit(failures === 0 ? 0 : 1);
