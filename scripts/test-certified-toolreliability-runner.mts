/* Certified ToolReliability runner checks (run: npx tsx scripts/test-certified-toolreliability-runner.mts) */
import {
  __resetBenchmarkStoreForTests,
  exportBenchmarkReportBundleV2,
  listBenchmarkAttemptsV2,
  listBenchmarkToolCallTraces,
  listBenchmarkVerifierResults,
  saveBenchmarkCaseV2,
  saveBenchmarkTeamComposition,
} from "../lib/benchmark/store";
import { runHarnessCertification } from "../lib/benchmark/certified/certification";
import { runCertifiedBenchmark } from "../lib/benchmark/certified/run-engine";
import {
  TOOL_RELIABILITY_CASES,
  buildPerfectToolReliabilityCandidate,
  type ToolReliabilityCaseResult,
} from "../lib/benchmark/toolreliability";
import {
  createToolReliabilityVerifierResult,
  runCertifiedToolReliability,
} from "../lib/benchmark/toolreliability/certified-runner";
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
} from "../lib/benchmark/types";
import type {
  ChatParams,
  SelectedModel,
  StreamChunk,
} from "../lib/providers/base";

let failures = 0;

function check(name: string, ok: boolean, detail?: unknown): void {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` -> ${JSON.stringify(detail)}`}`);
}

const now = "2026-06-28T09:30:00.000Z";
const caseV2: BenchmarkCaseV2 = {
  id: "toolreliability-current-pack",
  schemaVersion: 2,
  track: "toolreliability",
  title: "ToolReliability current challenge pack",
  description: "Certified ToolReliability current schema/tool/patch/repair/safety pack.",
  difficulty: "easy",
  tags: ["toolreliability"],
  caseVersion: "current",
  createdAt: now,
  updatedAt: now,
  prompt: {
    userRequest: "Complete each ToolReliability case.",
  },
  environment: {
    type: "browser",
    timeoutSeconds: 60,
    network: "none",
  },
  verifier: {
    scorer: "rule-checker",
  },
  budget: {
    maxUsd: 1,
    maxModelCalls: 10,
  },
  scoring: {
    scoringVersion: "toolreliability-current",
    primary: "tool_reliability",
  },
  contamination: {
    originalTask: true,
    canary: "AIBENCH-CERTIFIED-TOOLREL-RUNNER",
    referenceSolutionPrivate: true,
  },
};

const team: BenchmarkTeamComposition = {
  id: "team-certified-toolrel",
  name: "Certified ToolReliability single model",
  comboHash: "combo:certified-toolrel",
  roles: [
    {
      role: "single",
      slot: "single",
      modelId: "openai:gpt-toolrel",
      providerId: "openai",
      displayName: "GPT ToolRel",
      temperature: 0,
      maxTokens: 512,
    },
  ],
};
const model: SelectedModel = {
  modelId: "openai:gpt-toolrel",
  providerId: "openai",
  displayName: "GPT ToolRel",
};
const passingCertification = {
  ...runHarnessCertification("raw-single-model"),
  passed: true,
  checks: [{ id: "toolrel-fixture", label: "ToolReliability fixture certification", passed: true }],
};

__resetBenchmarkStoreForTests();
await saveBenchmarkCaseV2(caseV2);
await saveBenchmarkTeamComposition(team);

const perfectOutputs = buildPerfectToolReliabilityCandidate().outputs;
// Every remaining case is stateful, and its reference transcript has a
// VARIABLE number of turns (2-6, per case) -- so the flat call sequence is
// simply every case's reference transcript concatenated in order, and the
// starting call index for a given case is the CUMULATIVE turn count of
// every case before it (never a fixed 1-per-case stride, unlike the old
// single-shot pack where every case contributed exactly one output).
const streamOutputs = TOOL_RELIABILITY_CASES.flatMap(
  (benchmarkCase) => perfectOutputs[benchmarkCase.id] ?? []
);
function callIndexForCase(caseIndex: number): number {
  return TOOL_RELIABILITY_CASES.slice(0, caseIndex).reduce(
    (sum, benchmarkCase) => sum + (perfectOutputs[benchmarkCase.id]?.length ?? 0),
    0
  );
}
let callIndex = 0;
const capturedCalls: Array<{
  providerId: string;
  params: Pick<ChatParams, "messages" | "structuredOutput" | "maxTokens">;
}> = [];
const summary = await runCertifiedBenchmark({
  runId: "run-certified-toolrel",
  suiteId: "suite-certified-toolrel",
  track: "toolreliability",
  harnessProfile: "raw-single-model",
  caseIds: [caseV2.id],
  teamCompositionIds: [team.id],
  certification: passingCertification,
  runner: (context) =>
    runCertifiedToolReliability({
      context,
      models: [model],
      teamCompositionIds: [team.id],
      casePack: TOOL_RELIABILITY_CASES,
      pricing: {
        inputUsdPer1M: 1,
        outputUsdPer1M: 1,
      },
      streamChat: async function* (input): AsyncIterable<StreamChunk> {
        capturedCalls.push({
          providerId: input.providerId,
          params: {
            messages: input.params.messages,
            structuredOutput: input.params.structuredOutput,
            maxTokens: input.params.maxTokens,
          },
        });
        yield { type: "token", content: streamOutputs[callIndex++] ?? "{}" };
        yield { type: "done" };
      },
    }),
});

const attempts = await listBenchmarkAttemptsV2();
const verifiers = await listBenchmarkVerifierResults();
const toolTraces = await listBenchmarkToolCallTraces();
const bundle = exportBenchmarkReportBundleV2();
const attempt = attempts[0];
const verifier = verifiers[0];

check("certified ToolReliability run completes", summary.status === "completed" && summary.attemptCount === 1 && summary.verifierCount === 1, summary);
check("certified ToolReliability calls model for all outputs", callIndex === streamOutputs.length, { callIndex, expected: streamOutputs.length });
check("certified ToolReliability attempt persists perfect score", attempt?.status === "passed" && attempt.toolReliabilityScore === 100 && attempt.verifiedQuality === 1, attempt);
check("certified ToolReliability attempt accumulates traces and cost", attempt?.traceIds.length === streamOutputs.length && attempt.modelCalls === streamOutputs.length && attempt.costUsd !== null && attempt.costUsd > 0, attempt);
check("certified ToolReliability verifier records case assertions", verifier?.attemptId === attempt?.id && verifier.assertionResults.length === TOOL_RELIABILITY_CASES.length && verifier.passed, verifier);
const syntheticCaseResults: ToolReliabilityCaseResult[] = [
  {
    id: "toolrel-current-duration-test:result",
    caseId: "toolrel-current-duration-test",
    category: "stateful",
    passed: true,
    attempts: 42,
    metrics: { stateful: true, forbiddenAction: false },
    events: [],
    outputPreview: "{}",
  },
];
const syntheticVerifier = createToolReliabilityVerifierResult(
  "toolrel-duration-attempt",
  "toolrel-duration-suite",
  syntheticCaseResults,
  100,
  7
);
check(
  "certified ToolReliability verifier duration uses elapsed ms, not attempt count",
  syntheticVerifier.durationMs === 7,
  syntheticVerifier
);
check(
  "certified ToolReliability records tool traces (one forbidden_action event per case)",
  toolTraces.length === TOOL_RELIABILITY_CASES.length &&
    toolTraces.every((trace) => trace.attemptId === attempt?.id),
  toolTraces
);
check("certified ToolReliability traces export", bundle.traces.length === streamOutputs.length && bundle.toolCallTraces.length === toolTraces.length, bundle);
// The pack is now stateful-only, so the honest post-cut replacement for the
// old json-schema/tool-call/patch/repair-loop/forbidden-action per-category
// prompt-shape assertions is a single set of stateful-contract checks below
// (every case shares the SAME generic action-protocol prompt -- there is no
// per-category prompt shape left to distinguish).
const firstStatefulCallIndex = TOOL_RELIABILITY_CASES.findIndex((benchmarkCase) => benchmarkCase.category === "stateful");
const firstStatefulCall = capturedCalls[callIndexForCase(firstStatefulCallIndex)];
check(
  "certified ToolReliability stateful turns request no provider structured output (multi-action/prose turns would be mangled by a forced schema)",
  firstStatefulCall?.params.structuredOutput === undefined,
  firstStatefulCall?.params
);
check(
  "certified ToolReliability stateful turns get the 16384 reasoning-headroom token cap (never a length control -- the env's own truncationCharCap is the length discipline)",
  firstStatefulCall?.params.maxTokens === 16384,
  firstStatefulCall?.params
);
check(
  "certified ToolReliability stateful turns allow one-or-several JSON actions per response, batch-aligned with the env",
  (firstStatefulCall?.params.messages.find((message) => message.role === "user")?.content ?? "").includes(
    "one OR SEVERAL JSON tool actions"
  ),
  firstStatefulCall?.params
);

// Traces are keyed to individual cases, in the SAME cumulative-turn-index
// order streamOutputs was built in (case 0's traces first, then case 1's
// starting at callIndexForCase(1), etc.) -- proven for case 0 and case 1.
check(
  "certified ToolReliability traces are keyed to individual ToolReliability cases",
  bundle.traces[0]?.caseId === TOOL_RELIABILITY_CASES[0]?.id &&
    bundle.traces[callIndexForCase(1)]?.caseId === TOOL_RELIABILITY_CASES[1]?.id &&
    bundle.traces[0]?.rawResponse === perfectOutputs[TOOL_RELIABILITY_CASES[0]!.id]?.[0],
  {
    firstTraceCaseId: bundle.traces[0]?.caseId,
    expectedFirstCaseId: TOOL_RELIABILITY_CASES[0]?.id,
    secondCaseTraceCaseId: bundle.traces[callIndexForCase(1)]?.caseId,
    expectedSecondCaseId: TOOL_RELIABILITY_CASES[1]?.id,
    rawResponse: bundle.traces[0]?.rawResponse,
  }
);

const fallbackCase = TOOL_RELIABILITY_CASES[0]!;
const fallbackOutputs = perfectOutputs[fallbackCase.id] ?? [];
const fallbackArtifacts: BenchmarkArtifact[] = [];
const fallbackAttemptsRecorded: BenchmarkAttemptV2[] = [];
const fallbackEvents: BenchmarkRunEvent[] = [];
const fallbackFailures: BenchmarkFailure[] = [];
const fallbackToolCalls: BenchmarkToolCallTrace[] = [];
const fallbackTraces: BenchmarkModelCallTrace[] = [];
const fallbackVerifiers: BenchmarkVerifierResult[] = [];
let fallbackCallIndex = 0;
const fallbackAttempts = await runCertifiedToolReliability({
  context: {
    runId: "run-certified-toolrel-empty-caseids",
    mode: "certified",
    track: "toolreliability",
    harnessProfile: "raw-single-model",
    suiteId: "suite-certified-toolrel",
    startedAt: now,
    caseIds: [],
    teamCompositionIds: [team.id],
    modelBudget: {},
    recordAttempt: async (record) => {
      fallbackAttemptsRecorded.push(record);
    },
    recordVerifier: async (record) => {
      fallbackVerifiers.push(record);
    },
    recordArtifact: async (record) => {
      fallbackArtifacts.push(record);
    },
    recordTrace: async (record) => {
      fallbackTraces.push(record);
    },
    recordEvent: async (record) => {
      fallbackEvents.push(record);
    },
    recordToolCall: async (record) => {
      fallbackToolCalls.push(record);
    },
    recordFailure: async (record) => {
      fallbackFailures.push(record);
    },
  },
  models: [model],
  teamCompositionIds: [team.id],
  casePack: [fallbackCase],
  streamChat: async function* (): AsyncIterable<StreamChunk> {
    yield { type: "token", content: fallbackOutputs[fallbackCallIndex++] ?? "{}" };
    yield { type: "done" };
  },
});

check(
  "certified ToolReliability empty context keeps suite case id while traces use individual case id",
  fallbackAttempts[0]?.caseId === "toolreliability-current-pack" &&
    fallbackVerifiers[0]?.caseId === "toolreliability-current-pack" &&
    fallbackTraces.every((trace) => trace.caseId === fallbackCase.id) &&
    fallbackEvents.every((event) => event.caseId === fallbackCase.id),
  {
    attemptCaseId: fallbackAttempts[0]?.caseId,
    verifierCaseId: fallbackVerifiers[0]?.caseId,
    traceCaseIds: fallbackTraces.map((trace) => trace.caseId),
    eventCaseIds: fallbackEvents.map((event) => event.caseId),
    recordedAttempts: fallbackAttemptsRecorded.length,
    artifacts: fallbackArtifacts.length,
    failures: fallbackFailures.length,
    toolCalls: fallbackToolCalls.length,
  }
);

if (failures === 0) {
  console.log("PASS");
} else {
  console.log(`FAIL ${failures} check(s) failed`);
}

process.exit(failures === 0 ? 0 : 1);
