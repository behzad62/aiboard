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
  StructuredOutputFormat,
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
const streamOutputs = TOOL_RELIABILITY_CASES.flatMap((benchmarkCase) => {
  const outputs = perfectOutputs[benchmarkCase.id] ?? [];
  return benchmarkCase.category === "repair-loop" ? outputs.slice(1) : outputs;
});
function callIndexForCase(caseIndex: number): number {
  return TOOL_RELIABILITY_CASES.slice(0, caseIndex).length;
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
    category: "json-schema",
    passed: true,
    attempts: 42,
    metrics: { schema: true },
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
check("certified ToolReliability records tool traces", toolTraces.length > 0 && toolTraces.every((trace) => trace.attemptId === attempt?.id), toolTraces);
check("certified ToolReliability traces export", bundle.traces.length === streamOutputs.length && bundle.toolCallTraces.length === toolTraces.length, bundle);
const firstJsonCall = capturedCalls[0];
const firstJsonUserPrompt = firstJsonCall?.params.messages.find((message) => message.role === "user")?.content ?? "";
const firstJsonStructured = firstJsonCall?.params.structuredOutput as StructuredOutputFormat | undefined;
check(
  "certified ToolReliability states the JSON schema in the prompt without provider enforcement",
  firstJsonUserPrompt.includes('"severity"') &&
    firstJsonUserPrompt.includes('"affectedAreas"') &&
    firstJsonStructured === undefined,
  {
    userPrompt: firstJsonUserPrompt,
    structuredOutput: firstJsonStructured,
  }
);
const firstToolCallIndex = TOOL_RELIABILITY_CASES.findIndex((benchmarkCase) => benchmarkCase.category === "tool-call");
const firstToolCallPrompt =
  capturedCalls[callIndexForCase(firstToolCallIndex)]?.params.messages.find((message) => message.role === "user")?.content ?? "";
check(
  "certified ToolReliability documents the action grammar without printing the expected action",
  firstToolCallPrompt.includes("Available JSON tool actions:") &&
    firstToolCallPrompt.includes("read_range") &&
    !firstToolCallPrompt.includes("Expected JSON tool action:") &&
    !firstToolCallPrompt.includes('"startLine":214'),
  firstToolCallPrompt
);
const firstPatchCallIndex = TOOL_RELIABILITY_CASES.findIndex((benchmarkCase) => benchmarkCase.category === "patch");
const firstPatchStructured =
  capturedCalls[callIndexForCase(firstPatchCallIndex)]?.params.structuredOutput as StructuredOutputFormat | undefined;
const firstPatchPrompt =
  capturedCalls[callIndexForCase(firstPatchCallIndex)]?.params.messages.find((message) => message.role === "user")?.content ?? "";
check(
  "certified ToolReliability patch prompts show the exact accepted patch grammar",
  firstPatchPrompt.includes("```edit path=src/example.ts") &&
    firstPatchPrompt.includes("<<<<<<< SEARCH") &&
    firstPatchPrompt.includes("=======") &&
    firstPatchPrompt.includes(">>>>>>> REPLACE") &&
    firstPatchPrompt.includes('"path":"src/example.ts"') &&
    firstPatchPrompt.includes('"search":"exact current text"') &&
    firstPatchPrompt.includes('"replace":"replacement text"'),
  firstPatchPrompt
);
check(
  "certified ToolReliability patch calls request a multi-hunk structured envelope",
  firstPatchStructured?.name === "toolreliability_patch" &&
    firstPatchStructured.schema.required?.includes("path") === true &&
    firstPatchStructured.schema.required?.includes("ops") === true,
  firstPatchStructured
);
const firstRepairCallIndex = TOOL_RELIABILITY_CASES.findIndex((benchmarkCase) => benchmarkCase.category === "repair-loop");
const firstRepairCall = capturedCalls[callIndexForCase(firstRepairCallIndex)];
check(
  "certified ToolReliability repair-loop first attempt is genuine (no seed, no provider schema)",
  firstRepairCall?.params.structuredOutput === undefined &&
    !(firstRepairCall?.params.messages.find((message) => message.role === "user")?.content ?? "").includes("Parser feedback"),
  {
    repairCall: firstRepairCall?.params,
  }
);
const firstForbiddenCallIndex = TOOL_RELIABILITY_CASES.findIndex((benchmarkCase) => benchmarkCase.category === "forbidden-action");
const firstForbiddenPrompt =
  capturedCalls[callIndexForCase(firstForbiddenCallIndex)]?.params.messages.find((message) => message.role === "user")?.content ?? "";
check(
  "certified ToolReliability describes the run-action shape without printing an allowed command",
  firstForbiddenPrompt.includes('"action":"run"') &&
    !firstForbiddenPrompt.includes("Allowed safe verification action:") &&
    !firstForbiddenPrompt.includes('"command":"npm test"'),
  firstForbiddenPrompt
);

// Genuine repair loop: an invalid first answer triggers exactly one repair
// call that shows the model its OWN output plus the parser feedback.
{
  const repairCase = TOOL_RELIABILITY_CASES.find(
    (benchmarkCase) => benchmarkCase.category === "repair-loop"
  )!;
  const repairPerfect = perfectOutputs[repairCase.id] ?? [];
  const repairResponses = ["totally not json", repairPerfect[repairPerfect.length - 1] ?? "{}"];
  const repairCalls: Array<{ user: string }> = [];
  let repairCallIndex = 0;
  const repairAttempts = await runCertifiedToolReliability({
    context: {
      runId: "run-certified-toolrel-genuine-repair",
      mode: "certified",
      track: "toolreliability",
      harnessProfile: "raw-single-model",
      suiteId: "suite-certified-toolrel",
      startedAt: now,
      caseIds: ["toolreliability-current-pack"],
      teamCompositionIds: [team.id],
      modelBudget: {},
      recordAttempt: async () => {},
      recordVerifier: async () => {},
      recordArtifact: async () => {},
      recordTrace: async () => {},
      recordEvent: async () => {},
      recordToolCall: async () => {},
      recordFailure: async () => {},
    },
    models: [model],
    teamCompositionIds: [team.id],
    casePack: [repairCase],
    streamChat: async function* (input): AsyncIterable<StreamChunk> {
      repairCalls.push({
        user: input.params.messages.find((message) => message.role === "user")?.content ?? "",
      });
      yield { type: "token", content: repairResponses[repairCallIndex++] ?? "{}" };
      yield { type: "done" };
    },
  });
  check(
    "genuine repair loop feeds the model its own failed output and parser feedback",
    repairCalls.length === 2 &&
      !repairCalls[0].user.includes("Previous invalid answer:") &&
      repairCalls[1].user.includes("Previous invalid answer:") &&
      repairCalls[1].user.includes("totally not json") &&
      repairCalls[1].user.includes("Parser feedback:"),
    repairCalls.map((call) => call.user.slice(0, 400))
  );
  check(
    "genuine repair loop scores the repair and passes the attempt",
    repairAttempts[0]?.status === "passed" &&
      repairAttempts[0].toolReliabilityScore === 100 &&
      repairAttempts[0].modelCalls === 2,
    repairAttempts[0]
  );
}
check(
  "certified ToolReliability traces are keyed to individual ToolReliability cases",
  bundle.traces[0]?.caseId === TOOL_RELIABILITY_CASES[0]?.id &&
    bundle.traces[callIndexForCase(firstToolCallIndex)]?.caseId === TOOL_RELIABILITY_CASES[firstToolCallIndex]?.id &&
    bundle.traces[0]?.rawResponse === perfectOutputs[TOOL_RELIABILITY_CASES[0]!.id]?.[0],
  {
    firstTraceCaseId: bundle.traces[0]?.caseId,
    expectedFirstCaseId: TOOL_RELIABILITY_CASES[0]?.id,
    toolTraceCaseId: bundle.traces[callIndexForCase(firstToolCallIndex)]?.caseId,
    expectedToolCaseId: TOOL_RELIABILITY_CASES[firstToolCallIndex]?.id,
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
