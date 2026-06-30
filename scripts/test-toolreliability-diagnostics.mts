/* ToolReliability diagnostics checks (run: npx tsx scripts/test-toolreliability-diagnostics.mts) */
import {
  diagnoseToolReliabilityCaseResult,
  summarizeToolReliabilityDiagnostics,
} from "../lib/benchmark/toolreliability/diagnostics";
import { buildAttemptDetailViewModel } from "../lib/benchmark/certified/attempt-detail";
import { runCertifiedToolReliability } from "../lib/benchmark/toolreliability/certified-runner";
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
  JsonSchemaToolReliabilityCase,
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
    type: input.category === "patch" ? "patch_application" : "schema_validation",
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
    caseId: "toolrel-current-json-schema-0001",
    category: "json-schema",
    attempts: 0,
    message: "No output.",
    outputPreview: "",
  })
);
check("provider no output is attributed to provider", providerNoOutput.accountability === "provider", providerNoOutput);

const malformedJson = diagnoseToolReliabilityCaseResult(
  resultFixture({
    caseId: "toolrel-current-json-schema-0002",
    category: "json-schema",
    message: "Output is not valid JSON.",
    outputPreview: "{ invalid",
    details: { error: "Unexpected token i" },
  })
);
check(
  "malformed JSON with output is attributed to model",
  malformedJson.accountability === "model" && /schema-valid JSON/i.test(malformedJson.reason),
  malformedJson
);

const internalDetailFailure = diagnoseToolReliabilityCaseResult(
  resultFixture({
    caseId: "toolrel-current-json-schema-0098",
    category: "json-schema",
    message: "Output is not valid JSON.",
    outputPreview: "{ invalid",
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
    caseId: "toolrel-current-patch-0099",
    category: "patch",
    message: "Patch did not apply.",
    outputPreview: "```edit path=src/example.ts\n<<<<<<< SEARCH\nold\n=======\nwrong\n>>>>>>> REPLACE\n```",
    details: { reason: "The model mentioned ambiguous requirements in its own explanation." },
  })
);
check(
  "model-owned details containing ambiguous do not override model failure",
  ambiguousDetailFailure.accountability === "model",
  ambiguousDetailFailure
);

const patchFailure = diagnoseToolReliabilityCaseResult(
  resultFixture({
    caseId: "toolrel-current-patch-0003",
    category: "patch",
    message: "Patch was missing, failed, or produced different content.",
    outputPreview: "```edit path=src/example.ts\n<<<<<<< SEARCH\nold\n=======\nwrong\n>>>>>>> REPLACE\n```",
    details: { editCount: 1, applied: 0, failed: 1 },
  })
);
check(
  "patch failure with output is attributed to model",
  patchFailure.accountability === "model" && /patch/i.test(patchFailure.reason),
  patchFailure
);

const unsupportedPatchDiagnosis = diagnoseToolReliabilityCaseResult(
  resultFixture({
    caseId: "toolrel-current-patch-0004",
    category: "patch",
    message: "unsupported_patch_format: response did not contain an accepted patch grammar.",
    outputPreview: "*** Begin Patch\n*** Update File: src/example.ts\n*** End Patch",
    details: { failureClass: "unsupported_patch_format" },
  })
);
check(
  "patch diagnostics surface specific patch failure class",
  unsupportedPatchDiagnosis.accountability === "model" &&
    unsupportedPatchDiagnosis.reason === "unsupported_patch_format",
  unsupportedPatchDiagnosis
);

const passed = diagnoseToolReliabilityCaseResult(
  resultFixture({
    caseId: "toolrel-current-tool-call-0004",
    category: "tool-call",
    passed: true,
    message: "Tool action matched the expected call.",
    outputPreview: '{"action":"read_file"}',
  })
);
check("passed case keeps Passed reason", passed.passed && passed.reason === "Passed", passed);

const expectedUnavailable = diagnoseToolReliabilityCaseResult(
  resultFixture({
    caseId: "toolrel-current-tool-call-0005",
    category: "tool-call",
    message: "Expected unavailable.",
    outputPreview: '{"action":"read_file"}',
  })
);
check(
  "expected unavailable evidence is attributed to test design",
  expectedUnavailable.accountability === "test_design",
  expectedUnavailable
);

const ambiguous = diagnoseToolReliabilityCaseResult(
  resultFixture({
    caseId: "toolrel-current-tool-call-0006",
    category: "tool-call",
    message: "Ambiguous.",
    outputPreview: '{"action":"read_file"}',
  })
);
check(
  "bare ambiguous evidence is attributed to test design",
  ambiguous.accountability === "test_design",
  ambiguous
);

const summary = summarizeToolReliabilityDiagnostics([
  providerNoOutput,
  malformedJson,
  patchFailure,
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
  summary.byCategory["json-schema"]?.total === 2 &&
    summary.byCategory["json-schema"]?.failed === 2 &&
    summary.byCategory.patch?.failed === 1 &&
    summary.byCategory["tool-call"]?.total === 1 &&
    summary.byCategory["tool-call"]?.failed === 0,
  summary.byCategory
);
check(
  "summary exposes top failure reasons",
  summary.topReasons.length >= 2 &&
    summary.topReasons.every((item) => item.count > 0) &&
    summary.topReasons.some((item) => /provider output/i.test(item.reason)),
  summary.topReasons
);

const certifiedVerifiers: BenchmarkVerifierResult[] = [];
__resetBenchmarkStoreForTests();
const certifiedCase: JsonSchemaToolReliabilityCase = {
  id: "toolrel-current-json-schema-9001",
  category: "json-schema",
  title: "Diagnostics malformed JSON fixture",
  prompt: "Return strict JSON with an answer field.",
  canary: "AIBENCH-TOOLREL-DIAGNOSTICS",
  metrics: ["schema", "firstAttempt"],
  schema: {
    required: {
      answer: { type: "string", enum: ["ok"] },
    },
  },
};
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
    yield { type: "token", content: "{ invalid" };
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
  certifiedVerifierJson.assertions?.[0]?.label === "JSON Schema - Case 9001" &&
    certifiedVerifierJson.assertions?.[0]?.message === "Model did not return strict schema-valid JSON.",
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
    byCategory: { "json-schema": { total: 1, failed: 1 } },
    topReasons: [{ reason: "Model did not return strict schema-valid JSON.", count: 1 }],
  },
  cases: [
    {
      caseId: "toolrel-current-json-schema-9001",
      category: "json-schema",
      passed: false,
      accountability: "model",
      reason: "Model did not return strict schema-valid JSON.",
      evidence: "Output is not valid JSON.",
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
    parsedAttemptDiagnostics.categoryRows?.[0]?.category === "json-schema" &&
    parsedAttemptDiagnostics.topReasons?.[0]?.count === 1 &&
    parsedAttemptDiagnostics.failedCases?.[0]?.accountabilityLabel === "Model" &&
    parsedAttemptDiagnostics.failedCases?.[0]?.reason === "Model did not return strict schema-valid JSON.",
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
