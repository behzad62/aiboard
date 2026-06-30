/* Certified result UI view-model checks (run: npx tsx scripts/test-certified-result-ui-viewmodel.mts) */
import {
  buildAttemptDetailViewModel,
  type AttemptDetailViewModel,
} from "../lib/benchmark/certified/attempt-detail";
import {
  groupVerifierAssertions,
  verifierAssertionDetailsForDisplay,
} from "../components/benchmark/certified/VerifierAssertionTable";
import { getGameIqScenarioPack } from "../lib/benchmark/gameiq";
import type {
  BenchmarkAttemptV2,
  BenchmarkModelCallTrace,
  BenchmarkToolCallTrace,
  BenchmarkVerifierResult,
} from "../lib/benchmark/types";

let failures = 0;

function check(name: string, ok: boolean, detail?: unknown): void {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` -> ${JSON.stringify(detail)}`}`);
}

function buildDetail(input: {
  status: BenchmarkAttemptV2["status"];
  verifierResultJson?: string;
  assertionResults?: BenchmarkVerifierResult["assertionResults"];
  traces?: BenchmarkModelCallTrace[];
  toolCalls?: BenchmarkToolCallTrace[];
}): AttemptDetailViewModel | null {
  const attempt: BenchmarkAttemptV2 = {
    id: `attempt-${input.status}`,
    runId: `run-${input.status}`,
    caseId: "case-viewmodel",
    teamCompositionId: "team-viewmodel",
    mode: "certified",
    track: "toolreliability",
    harnessProfile: "raw-single-model",
    status: input.status,
    startedAt: "2026-06-30T08:00:00.000Z",
    completedAt: "2026-06-30T08:00:05.000Z",
    verifiedQuality: 0.25,
    jobSuccessScore: 25,
    efficiencyScore: 10,
    toolReliabilityScore: 0.1,
    costUsd: 0.015,
    inputTokens: 120,
    outputTokens: 55,
    modelCalls: 3,
    toolCalls: 2,
    durationMs: 5_000,
    verifierResultId: `verifier-${input.status}`,
    artifactIds: [],
    traceIds: input.traces?.map((trace) => trace.id) ?? [],
    failureIds: [],
    harnessVersion: "harness-v1",
    promptSetVersion: "prompts-v1",
    scoringVersion: "scoring-v1",
  };
  const verifier: BenchmarkVerifierResult = {
    id: `verifier-${input.status}`,
    attemptId: attempt.id,
    caseId: attempt.caseId,
    passed: input.status === "passed",
    score: input.status === "passed" ? 1 : 0.25,
    durationMs: 250,
    resultJson: input.verifierResultJson ?? "{}",
    assertionResults:
      input.assertionResults ??
      [{ id: "assert-1", label: "Verifier assertion", passed: false, weight: 1 }],
    artifactIds: [],
  };

  return buildAttemptDetailViewModel({
    summary: {
      runId: attempt.runId,
      status: "completed",
      track: attempt.track,
      suiteId: "suite-viewmodel",
      startedAt: attempt.startedAt,
      completedAt: attempt.completedAt ?? attempt.startedAt,
      attemptCount: 1,
      verifierCount: 1,
      artifactCount: 0,
      traceCount: input.traces?.length ?? 0,
      eventCount: 0,
      toolCallCount: input.toolCalls?.length ?? 0,
      failureCount: 0,
      dashboard: {} as never,
    },
    cases: [],
    attempts: [attempt],
    teams: [],
    verifiers: [verifier],
    traces: input.traces ?? [],
    runEvents: [],
    toolCalls: input.toolCalls ?? [],
    artifacts: [],
    failures: [],
  });
}

const providerUnavailable = buildDetail({ status: "provider_unavailable" });
check(
  "provider_unavailable is excluded provider accountability",
  providerUnavailable?.scoreUse.kind === "excluded" &&
    providerUnavailable.scoreUse.accountability === "provider" &&
    /provider/i.test(providerUnavailable.scoreUse.label) &&
    /invalid for scoring/i.test(providerUnavailable.scoreUse.explanation),
  providerUnavailable?.scoreUse
);

const failedBudget = buildDetail({ status: "failed_budget" });
check(
  "failed_budget remains scored model accountability",
  failedBudget?.scoreUse.kind === "scored" &&
    failedBudget.scoreUse.accountability === "model" &&
    /budget/i.test(failedBudget.scoreUse.explanation),
  failedBudget?.scoreUse
);

check(
  "attempt detail summary exposes top-level counts and verifier state",
  failedBudget?.summary.outcomeLabel.length &&
    failedBudget.summary.scoreUseLabel.length &&
    failedBudget.summary.modelCallCount === 3 &&
    failedBudget.summary.toolCallCount === 2 &&
    failedBudget.summary.verifierOutcome === "failed" &&
    failedBudget.summary.failureCount === 0,
  failedBudget?.summary
);

const traceDetail = buildDetail({
  status: "failed_model",
  traces: [
    {
      id: "trace-json-001",
      runId: "run-failed_model",
      caseId: "toolrel-current-json-schema-001",
      attemptId: "attempt-failed_model",
      modelId: "foundry:claude-opus-4-5",
      providerId: "foundry",
      participantId: "team-opus",
      schemaMode: "structured",
      startedAt: "2026-06-30T08:00:00.000Z",
      completedAt: "2026-06-30T08:00:01.000Z",
      inputTokens: 100,
      outputTokens: 20,
      rawResponse: "{\"decision\":\"approve\",\"confidence\":1,\"risks\":[\"none\"]}",
      parsedResponseJson: "{\"decision\":\"approve\",\"confidence\":1,\"risks\":[\"none\"]}",
      retryHistory: [],
    },
  ],
});
check(
  "attempt detail exposes per-case raw model response rows for benchmark debugging",
  traceDetail?.modelTraceRows?.[0]?.caseId === "toolrel-current-json-schema-001" &&
    traceDetail.modelTraceRows[0].rawResponsePreview.includes("\"decision\"") &&
    traceDetail.modelTraceRows[0].schemaMode === "structured",
  traceDetail?.modelTraceRows
);

const toolReliabilityDiagnosticsJson = JSON.stringify({
  diagnostics: {
    summary: {
      total: 1,
      passed: 0,
      failed: 1,
      byAccountability: {
        provider: 0,
        aiboard: 0,
        test_design: 0,
        model: 1,
      },
      byCategory: {
        patch: { total: 1, failed: 1 },
      },
      topReasons: [{ reason: "Patch did not apply.", count: 1 }],
    },
    cases: [
      {
        caseId: "toolrel-current-patch-001",
        category: "patch",
        passed: false,
        accountability: "model",
        reason: "Patch did not apply.",
        evidence: "Patch was missing, failed, or produced different content.",
      },
    ],
  },
});
const failedCaseDetail = buildDetail({
  status: "failed_tool_use",
  verifierResultJson: toolReliabilityDiagnosticsJson,
  traces: [
    {
      id: "trace-patch-001",
      runId: "run-failed_tool_use",
      caseId: "toolrel-current-patch-001",
      attemptId: "attempt-failed_tool_use",
      modelId: "foundry:claude-opus-4-5",
      providerId: "foundry",
      participantId: "team-opus",
      schemaMode: "text",
      startedAt: "2026-06-30T08:00:00.000Z",
      completedAt: "2026-06-30T08:00:01.000Z",
      inputTokens: 127,
      outputTokens: 34,
      rawResponse: [
        "```typescript",
        "<<<<<<< SEARCH",
        'export const exportedValue = "old-001";',
        "=======",
        'export const exportedValue = "new-001";',
        ">>>>>>> REPLACE",
        "```",
      ].join("\n"),
      retryHistory: [],
    },
  ],
  toolCalls: [
    {
      id: "tool-patch-001",
      attemptId: "attempt-failed_tool_use",
      caseId: "toolrel-current-patch-001",
      toolName: "toolreliability:patch_application",
      status: "failed",
      startedAt: "2026-06-30T08:00:01.000Z",
      completedAt: "2026-06-30T08:00:01.000Z",
      inputJson: JSON.stringify({ editCount: 0, applied: 0, failed: 1 }),
      outputPreview: "Patch was missing, failed, or produced different content.",
    },
  ],
});
const failedPatchCase =
  failedCaseDetail?.toolReliabilityDiagnostics?.failedCases[0] as
    | {
        modelResponses?: Array<{ rawResponsePreview: string }>;
        verifierEvents?: Array<{ detail: string }>;
      }
    | undefined;
check(
  "ToolReliability failed-case diagnostics include raw model response and verifier details",
  failedPatchCase?.modelResponses?.[0]?.rawResponsePreview.includes("<<<<<<< SEARCH") === true &&
    failedPatchCase.verifierEvents?.[0]?.detail.includes("editCount") === true,
  failedCaseDetail?.toolReliabilityDiagnostics?.failedCases[0]
);

const groupedAssertions = groupVerifierAssertions([
  { id: "json-schema-0001", label: "JSON Schema - Case 0001", passed: false, weight: 1, message: "Bad JSON." },
  { id: "json-schema-0002", label: "JSON Schema - Case 0002", passed: false, weight: 1, message: "Bad JSON." },
  { id: "json-schema-0003", label: "JSON Schema - Case 0003", passed: true, weight: 2, message: "OK." },
  { id: "tool-call-0001", label: "Tool Call - Case 0001", passed: true, weight: 1 },
]);
check(
  "assertion grouping condenses repeated label families",
  groupedAssertions.length === 2 &&
    groupedAssertions[0]?.total === 3 &&
    groupedAssertions[0]?.failedCount === 2 &&
    groupedAssertions[0]?.totalWeight === 4 &&
    groupedAssertions[0]?.failedExamples.length === 2,
  groupedAssertions
);

const battleshipPack = getGameIqScenarioPack("battleship");
if (!battleshipPack) throw new Error("Battleship GameIQ pack is required for this test.");
const battleshipScenario = battleshipPack.scenarios[0];
const legacyGameIqDetails = [
  "Structured: yes",
  "Legal: yes",
  "Correct: no",
  'Parsed action\n{"target":{"row":0,"column":2}}',
  'Raw response\n{"action":{"target":{"row":0,"column":2}}}',
].join("\n\n");
const enrichedGameIqDetails = verifierAssertionDetailsForDisplay({
  id: battleshipScenario.id,
  label: "battleship target-priority",
  passed: false,
  weight: 1,
  message: "Incorrect target.",
  details: legacyGameIqDetails,
});
check(
  "legacy GameIQ failed samples are enriched with expected result details",
  enrichedGameIqDetails?.includes("Expected result") === true &&
    enrichedGameIqDetails.includes(
      JSON.stringify(battleshipScenario.expectedActions[0]?.action)
    ),
  enrichedGameIqDetails
);

const alreadyEnrichedGameIqDetails = `${legacyGameIqDetails}\n\nExpected result\n[]`;
check(
  "GameIQ expected result enrichment does not duplicate existing evidence",
  verifierAssertionDetailsForDisplay({
    id: battleshipScenario.id,
    label: "battleship target-priority",
    passed: false,
    weight: 1,
    details: alreadyEnrichedGameIqDetails,
  }) === alreadyEnrichedGameIqDetails,
  verifierAssertionDetailsForDisplay({
    id: battleshipScenario.id,
    label: "battleship target-priority",
    passed: false,
    weight: 1,
    details: alreadyEnrichedGameIqDetails,
  })
);

check(
  "non-GameIQ assertion details are not modified by expected result enrichment",
  verifierAssertionDetailsForDisplay({
    id: "toolrel-current-patch-001",
    label: "Patch",
    passed: false,
    weight: 1,
    details: "Patch did not apply.",
  }) === "Patch did not apply.",
  verifierAssertionDetailsForDisplay({
    id: "toolrel-current-patch-001",
    label: "Patch",
    passed: false,
    weight: 1,
    details: "Patch did not apply.",
  })
);

if (failures === 0) {
  console.log("PASS");
} else {
  console.log(`FAIL ${failures} check(s) failed`);
}

process.exit(failures === 0 ? 0 : 1);
