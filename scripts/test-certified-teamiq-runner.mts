/* Certified TeamIQ runner checks (run: npx tsx scripts/test-certified-teamiq-runner.mts) */
import {
  __resetBenchmarkStoreForTests,
  exportBenchmarkReportBundleV2,
  listBenchmarkAttemptsV2,
  listBenchmarkTeamCompositions,
  listBenchmarkVerifierResults,
  saveBenchmarkCaseV2,
  saveBenchmarkTeamComposition,
} from "../lib/benchmark/store";
import { runHarnessCertification } from "../lib/benchmark/certified/certification";
import { runCertifiedBenchmark } from "../lib/benchmark/certified/run-engine";
import {
  buildPerfectToolReliabilityCandidate,
  runToolReliabilityPack,
  TOOL_RELIABILITY_CASES,
  type ToolReliabilityCandidate,
} from "../lib/benchmark/toolreliability";
import {
  deriveSoloTeamComposition,
  deriveTeamComposition,
  runCertifiedTeamIq,
} from "../lib/benchmark/teamiq";
import type { CertifiedRunContext } from "../lib/benchmark/certified/run-context";
import type {
  BenchmarkCaseV2,
  BenchmarkTeamCompositionRole,
} from "../lib/benchmark/types";
import type { ChatParams, StreamChunk, StructuredOutputFormat } from "../lib/providers/base";

let failures = 0;

function check(name: string, ok: boolean, detail?: unknown): void {
  if (!ok) failures++;
  console.log(
    `${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` -> ${JSON.stringify(detail)}`}`
  );
}

function makeTeamIqContext(
  runId: string,
  caseIds: string[],
  teamCompositionIds: string[]
): CertifiedRunContext {
  return {
    runId,
    mode: "certified",
    track: "teamiq",
    harnessProfile: "raw-single-model",
    suiteId: "suite-certified-teamiq",
    startedAt: "2026-06-28T13:00:00.000Z",
    caseIds,
    teamCompositionIds,
    modelBudget: {},
    recordAttempt: async () => {},
    recordVerifier: async () => {},
    recordArtifact: async () => {},
    recordTrace: async () => {},
    recordEvent: async () => {},
    recordToolCall: async () => {},
    recordFailure: async () => {},
  };
}

const now = "2026-06-28T13:00:00.000Z";
const caseV2: BenchmarkCaseV2 = {
  id: "teamiq-toolreliability-current-pack",
  schemaVersion: 2,
  track: "teamiq",
  title: "TeamIQ over ToolReliability current pack",
  description:
    "TeamIQ benchmark using deterministic ToolReliability tasks as the scored substrate.",
  difficulty: "medium",
  tags: ["teamiq", "toolreliability"],
  caseVersion: "0.1.0",
  createdAt: now,
  updatedAt: now,
  prompt: {
    userRequest: "Run solo baselines and a model team over ToolReliability cases.",
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
    maxModelCalls: 100,
  },
  scoring: {
    scoringVersion: "teamiq-toolreliability-current",
    primary: "team_lift",
  },
  contamination: {
    originalTask: true,
    canary: "AIBENCH-CERTIFIED-TEAMIQ-RUNNER",
    referenceSolutionPrivate: true,
  },
};

const roles: BenchmarkTeamCompositionRole[] = [
  {
    role: "architect",
    slot: "architect",
    modelId: "openai:gpt-team-architect",
    providerId: "openai",
    displayName: "GPT Team Architect",
    temperature: 0,
  },
  {
    role: "worker",
    slot: "worker",
    modelId: "google:gemini-team-worker",
    providerId: "google",
    displayName: "Gemini Team Worker",
    temperature: 0,
  },
  {
    role: "reviewer",
    slot: "reviewer",
    modelId: "anthropic:claude-team-reviewer",
    providerId: "anthropic",
    displayName: "Claude Team Reviewer",
    temperature: 0,
  },
];
const team = deriveTeamComposition({
  name: "Architect Worker Reviewer",
  roles,
});

const perfectOutputs = buildPerfectToolReliabilityCandidate().outputs;
const selectedCases = [
  TOOL_RELIABILITY_CASES.find((benchmarkCase) => benchmarkCase.category === "json-schema"),
  TOOL_RELIABILITY_CASES.find((benchmarkCase) => benchmarkCase.category === "tool-call"),
  TOOL_RELIABILITY_CASES.find((benchmarkCase) => benchmarkCase.category === "patch"),
  TOOL_RELIABILITY_CASES.find((benchmarkCase) => benchmarkCase.category === "repair-loop"),
  TOOL_RELIABILITY_CASES.find((benchmarkCase) => benchmarkCase.category === "forbidden-action"),
].filter((benchmarkCase): benchmarkCase is (typeof TOOL_RELIABILITY_CASES)[number] =>
  Boolean(benchmarkCase)
);
const outputByCase = new Map(
  selectedCases.flatMap((benchmarkCase) =>
    (perfectOutputs[benchmarkCase.id] ?? []).map((output, index) => [
      `${benchmarkCase.canary}:${index}`,
      output,
    ])
  )
);
const callsByProvider = new Map<string, number>();
const capturedCalls: Array<{
  providerId: string;
  params: Pick<ChatParams, "messages" | "structuredOutput">;
}> = [];

__resetBenchmarkStoreForTests();
await saveBenchmarkCaseV2(caseV2);
await saveBenchmarkTeamComposition(team);

const summary = await runCertifiedBenchmark({
  runId: "run-certified-teamiq",
  suiteId: "suite-certified-teamiq",
  track: "teamiq",
  harnessProfile: "raw-single-model",
  caseIds: [caseV2.id],
  teamCompositionIds: [team.id],
  certification: runHarnessCertification("raw-single-model"),
  runner: (context) =>
    runCertifiedTeamIq({
      context,
      teamCompositions: [team],
      task: {
        kind: "toolreliability",
        casePack: selectedCases,
      },
      includeSoloBaselines: true,
      pricing: {
        inputUsdPer1M: 1,
        outputUsdPer1M: 1,
      },
      streamChat: async function* ({ providerId, params }): AsyncIterable<StreamChunk> {
        callsByProvider.set(providerId, (callsByProvider.get(providerId) ?? 0) + 1);
        capturedCalls.push({
          providerId,
          params: {
            messages: params.messages,
            structuredOutput: params.structuredOutput,
          },
        });
        const prompt = params.messages.map((message) => message.content).join("\n");
        const caseCanary = selectedCases.find((benchmarkCase) =>
          prompt.includes(benchmarkCase.canary)
        )?.canary;
        // The genuine repair round carries the team's own previous output plus
        // parser feedback ("Previous invalid answer:" / "Parser feedback:").
        // Attempt 0 (no such markers) returns the malformed first output; the
        // repair round returns the valid JSON at index 1.
        const repairAttempt =
          prompt.includes("Parser feedback:") &&
          prompt.includes("Previous invalid answer:")
            ? 1
            : 0;
        yield {
          type: "token",
          content:
            outputByCase.get(`${caseCanary}:${repairAttempt}`) ??
            outputByCase.get(`${caseCanary}:0`) ??
            "{}",
        };
        yield { type: "done" };
      },
    }),
});

const attempts = await listBenchmarkAttemptsV2();
const teamCompositions = await listBenchmarkTeamCompositions();
const verifiers = await listBenchmarkVerifierResults();
const bundle = exportBenchmarkReportBundleV2();
const soloAttempts = attempts.filter(
  (attempt) => attempt.track === "teamiq" && attempt.teamCompositionId !== team.id
);
const teamAttempt = attempts.find((attempt) => attempt.teamCompositionId === team.id);
const teamVerifier = verifiers.find((verifier) => verifier.attemptId === teamAttempt?.id);

function promptForCase(caseCategory: string): {
  prompt: string;
  structuredOutput?: StructuredOutputFormat;
} {
  const benchmarkCase = selectedCases.find((item) => item.category === caseCategory);
  const captured = capturedCalls.find((call) =>
    call.params.messages.some((message) =>
      benchmarkCase ? message.content.includes(benchmarkCase.canary) : false
    )
  );
  return {
    prompt: captured?.params.messages.map((message) => message.content).join("\n") ?? "",
    structuredOutput: captured?.params.structuredOutput,
  };
}

check(
  "certified TeamIQ run completes",
  summary.status === "completed" &&
    summary.attemptCount === roles.length + 1 &&
    summary.verifierCount === roles.length + 1,
  summary
);
check(
  "certified TeamIQ automatically saves solo baselines",
  soloAttempts.length === roles.length &&
    roles.every((role) =>
      teamCompositions.some(
        (composition) =>
          composition.roles.length === 1 &&
          composition.roles[0]?.modelId === role.modelId
      )
    ),
  { soloAttempts, teamCompositions }
);
check(
  "certified TeamIQ computes team lift after baselines",
  teamAttempt?.status === "passed" &&
    teamAttempt.teamLift === 0 &&
    teamAttempt.verifiedQuality === 1,
  teamAttempt
);
// Each round costs one call per role plus one synthesis call. Non-repair cases
// run a single round; the repair-loop case runs a second (repair) round because
// its genuine first attempt is malformed.
const repairCaseCount = selectedCases.filter(
  (benchmarkCase) => benchmarkCase.category === "repair-loop"
).length;
const expectedTeamTraceCount = (roles.length + 1) * (selectedCases.length + repairCaseCount);
check(
  "certified TeamIQ records traces for solo and team calls",
  bundle.traces.length >
    selectedCases.length * roles.length &&
    teamAttempt?.traceIds.length === expectedTeamTraceCount,
  { traceCount: bundle.traces.length, expectedTeamTraceCount, teamAttempt }
);
const jsonCall = promptForCase("json-schema");
check(
  "certified TeamIQ states the JSON schema in the prompt without provider enforcement",
  jsonCall.prompt.includes("Required JSON schema:") &&
    jsonCall.prompt.includes('"decision"') &&
    jsonCall.structuredOutput === undefined,
  jsonCall
);
const toolCall = promptForCase("tool-call");
check(
  "certified TeamIQ documents the tool-action grammar without leaking the expected action",
  toolCall.prompt.includes("Available JSON tool actions:") &&
    toolCall.prompt.includes("read_range") &&
    !toolCall.prompt.includes("Expected JSON tool action:"),
  toolCall.prompt
);
const patchCall = promptForCase("patch");
check(
  "certified TeamIQ reuses current ToolReliability patch grammar and structured output",
  patchCall.prompt.includes("Accepted patch response formats:") &&
    patchCall.prompt.includes("<<<<<<< SEARCH") &&
    patchCall.structuredOutput?.name === "toolreliability_patch",
  patchCall
);
const repairCase = selectedCases.find(
  (benchmarkCase) => benchmarkCase.category === "repair-loop"
)!;
const repairFirstOutput = outputByCase.get(`${repairCase.canary}:0`) ?? "";
const repairRoundCalls = capturedCalls.filter(
  (call) =>
    call.params.messages.some((message) =>
      message.content.includes(repairCase.canary)
    ) &&
    call.params.messages.some(
      (message) =>
        message.content.includes("Previous invalid answer:") &&
        message.content.includes("Parser feedback:")
    )
);
const repairRoundPrompt =
  repairRoundCalls[0]?.params.messages.map((message) => message.content).join("\n") ??
  "";
check(
  "certified TeamIQ runs a genuine repair round carrying the team's own failed output",
  // A repair round only happens because attempt 0 (the team's own output) was
  // malformed; the repair prompt echoes that exact failed output plus feedback.
  repairRoundCalls.length > 0 &&
    repairRoundPrompt.includes("Previous invalid answer:") &&
    repairRoundPrompt.includes("Parser feedback:") &&
    repairRoundPrompt.includes(repairFirstOutput) &&
    repairRoundCalls.every((call) => call.params.structuredOutput === undefined),
  { repairRoundCount: repairRoundCalls.length, repairRoundPrompt }
);
const forbiddenCall = promptForCase("forbidden-action");
check(
  "certified TeamIQ describes the run-action shape without printing an allowed command",
  forbiddenCall.prompt.includes('"action":"run"') &&
    !forbiddenCall.prompt.includes("Allowed safe verification action:") &&
    !forbiddenCall.prompt.includes('"command":"npm test"'),
  forbiddenCall.prompt
);
check(
  "certified TeamIQ model traces are keyed to individual ToolReliability cases",
  teamAttempt?.traceIds.every((traceId) => {
    const trace = bundle.traces.find((candidate) => candidate.id === traceId);
    return trace?.caseId ? selectedCases.some((benchmarkCase) => benchmarkCase.id === trace.caseId) : false;
  }) === true,
  teamAttempt?.traceIds.map((traceId) => bundle.traces.find((candidate) => candidate.id === traceId)?.caseId)
);
const parsedTeamVerifier = JSON.parse(teamVerifier?.resultJson ?? "{}") as {
  diagnostics?: { summary?: { total?: number }; cases?: unknown[] };
};
check(
  "certified TeamIQ verifier includes ToolReliability diagnostics",
  parsedTeamVerifier.diagnostics?.summary?.total === selectedCases.length &&
    parsedTeamVerifier.diagnostics.cases?.length === selectedCases.length,
  parsedTeamVerifier
);
check(
  "certified TeamIQ verifier results export",
  verifiers.length === roles.length + 1 &&
    bundle.verifierResults.length === verifiers.length,
  { verifiers, bundleVerifierCount: bundle.verifierResults.length }
);
check(
  "certified TeamIQ calls every team provider",
  roles.every((role) => (callsByProvider.get(role.providerId) ?? 0) > 0),
  Object.fromEntries(callsByProvider)
);

__resetBenchmarkStoreForTests();
const synthesisCase = selectedCases.find(
  (benchmarkCase) => benchmarkCase.category === "json-schema"
)!;
const twoRoleTeam = deriveTeamComposition({
  name: "Synthesis required team",
  roles: roles.slice(0, 2),
});
await saveBenchmarkCaseV2(caseV2);
await saveBenchmarkTeamComposition(twoRoleTeam);
let synthesisModelCalls = 0;
let synthesisPrompts = 0;
const synthesisSummary = await runCertifiedBenchmark({
  runId: "run-certified-teamiq-synthesis",
  suiteId: "suite-certified-teamiq",
  track: "teamiq",
  harnessProfile: "raw-single-model",
  caseIds: [caseV2.id],
  teamCompositionIds: [twoRoleTeam.id],
  certification: runHarnessCertification("raw-single-model"),
  runner: (context) =>
    runCertifiedTeamIq({
      context,
      teamCompositions: [twoRoleTeam],
      task: {
        kind: "toolreliability",
        casePack: [synthesisCase],
      },
      includeSoloBaselines: false,
      pricing: {
        inputUsdPer1M: 1,
        outputUsdPer1M: 1,
      },
      streamChat: async function* ({ params }): AsyncIterable<StreamChunk> {
        synthesisModelCalls++;
        const prompt = params.messages.map((message) => message.content).join("\n");
        const isSynthesis = prompt.includes("Synthesize the team outputs");
        if (isSynthesis) synthesisPrompts++;
        yield {
          type: "token",
          content: isSynthesis
            ? outputByCase.get(`${synthesisCase.canary}:0`) ?? "{}"
            : JSON.stringify({ member: "not the final answer" }),
        };
        yield { type: "done" };
      },
    }),
});
const synthesisAttempt = (await listBenchmarkAttemptsV2()).find(
  (attempt) => attempt.runId === synthesisSummary.runId
);
check(
  "multi-role TeamIQ adds one synthesis model call per case",
  synthesisModelCalls === twoRoleTeam.roles.length + 1 && synthesisPrompts === 1,
  { synthesisModelCalls, synthesisPrompts }
);
check(
  "multi-role TeamIQ scores the synthesized answer, not a member output",
  synthesisAttempt?.status === "passed" &&
    synthesisAttempt.modelCalls === twoRoleTeam.roles.length + 1,
  synthesisAttempt
);

// Genuine repair flow through the TeamIQ path: attempt 0 is the team's OWN
// output. When it fails post-hoc validation the team gets exactly one repair
// round that echoes its own failed output plus the parser feedback, and the
// runner labels firstAttemptSource='model' (not 'seeded').
{
  const repairCase = selectedCases.find(
    (benchmarkCase) => benchmarkCase.category === "repair-loop"
  )!;
  const repairPerfect = perfectOutputs[repairCase.id] ?? [];
  const validRepair = repairPerfect[repairPerfect.length - 1] ?? "{}";
  const soloTeam = deriveSoloTeamComposition({
    modelId: "openai:gpt-solo-repair",
    providerId: "openai",
    displayName: "GPT Solo Repair",
    temperature: 0,
  });
  const repairUserPrompts: string[] = [];
  let repairCallIndex = 0;
  const responses = ["totally not json", validRepair];
  const genuineAttempts = await runCertifiedTeamIq({
    context: makeTeamIqContext("run-teamiq-genuine-repair", [repairCase.id], [soloTeam.id]),
    teamCompositions: [soloTeam],
    task: { kind: "toolreliability", casePack: [repairCase] },
    includeSoloBaselines: false,
    pricing: { inputUsdPer1M: 1, outputUsdPer1M: 1 },
    streamChat: async function* ({ params }): AsyncIterable<StreamChunk> {
      repairUserPrompts.push(
        params.messages.find((message) => message.role === "user")?.content ?? ""
      );
      yield { type: "token", content: responses[repairCallIndex++] ?? "{}" };
      yield { type: "done" };
    },
  });
  check(
    "TeamIQ genuine repair round echoes the team's own failed output plus parser feedback",
    repairUserPrompts.length === 2 &&
      !repairUserPrompts[0].includes("Previous invalid answer:") &&
      repairUserPrompts[1].includes("Previous invalid answer:") &&
      repairUserPrompts[1].includes("totally not json") &&
      repairUserPrompts[1].includes("Parser feedback:"),
    repairUserPrompts.map((prompt) => prompt.slice(0, 300))
  );
  check(
    "TeamIQ genuine repair flow passes with exactly two model calls",
    genuineAttempts[0]?.status === "passed" &&
      genuineAttempts[0].toolReliabilityScore === 100 &&
      genuineAttempts[0].modelCalls === 2,
    genuineAttempts[0]
  );
  // Re-run the pack over the exact outputs TeamIQ produced (its own malformed
  // first answer, then the valid repair) to confirm the runner labels the
  // first attempt 'model' rather than 'seeded'.
  const genuineCandidate: ToolReliabilityCandidate = {
    id: "teamiq-genuine-repair-candidate",
    teamCompositionId: soloTeam.id,
    outputs: { [repairCase.id]: ["totally not json", validRepair] },
  };
  const genuineResult = runToolReliabilityPack(genuineCandidate, [repairCase]);
  const genuineEvents = genuineResult.caseResults[0]?.events ?? [];
  check(
    "TeamIQ genuine repair labels firstAttemptSource='model'",
    genuineResult.caseResults[0]?.passed === true &&
      genuineEvents.every(
        (event) =>
          event.details?.firstAttemptSource === undefined ||
          event.details.firstAttemptSource === "model"
      ) &&
      genuineEvents.some((event) => event.details?.firstAttemptSource === "model"),
    genuineEvents.map((event) => ({
      type: event.type,
      firstAttemptSource: event.details?.firstAttemptSource,
    }))
  );
}

// No-repair-needed flow through the TeamIQ path: a genuinely valid first
// attempt is scored on a single model call with no repair round.
{
  const repairCase = selectedCases.find(
    (benchmarkCase) => benchmarkCase.category === "repair-loop"
  )!;
  const repairPerfect = perfectOutputs[repairCase.id] ?? [];
  const validFirst = repairPerfect[repairPerfect.length - 1] ?? "{}";
  const soloTeam = deriveSoloTeamComposition({
    modelId: "openai:gpt-solo-clean",
    providerId: "openai",
    displayName: "GPT Solo Clean",
    temperature: 0,
  });
  let noRepairCalls = 0;
  const noRepairAttempts = await runCertifiedTeamIq({
    context: makeTeamIqContext("run-teamiq-no-repair", [repairCase.id], [soloTeam.id]),
    teamCompositions: [soloTeam],
    task: { kind: "toolreliability", casePack: [repairCase] },
    includeSoloBaselines: false,
    pricing: { inputUsdPer1M: 1, outputUsdPer1M: 1 },
    streamChat: async function* (): AsyncIterable<StreamChunk> {
      noRepairCalls++;
      yield { type: "token", content: validFirst };
      yield { type: "done" };
    },
  });
  check(
    "TeamIQ no-repair-needed flow scores a valid first attempt on a single model call",
    noRepairCalls === 1 &&
      noRepairAttempts[0]?.status === "passed" &&
      noRepairAttempts[0].modelCalls === 1,
    { noRepairCalls, attempt: noRepairAttempts[0] }
  );
}

if (failures === 0) {
  console.log("PASS");
} else {
  console.log(`FAIL ${failures} check(s) failed`);
}

process.exit(failures === 0 ? 0 : 1);
