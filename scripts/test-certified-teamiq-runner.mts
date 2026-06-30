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
  TOOL_RELIABILITY_CASES,
} from "../lib/benchmark/toolreliability";
import {
  deriveTeamComposition,
  runCertifiedTeamIq,
} from "../lib/benchmark/teamiq";
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
        const repairAttempt = prompt.includes("previous answer was invalid") ? 1 : 0;
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
check(
  "certified TeamIQ records traces for solo and team calls",
  bundle.traces.length >
    selectedCases.length * roles.length &&
    teamAttempt?.traceIds.length ===
      selectedCases.length * roles.length,
  { traceCount: bundle.traces.length, teamAttempt }
);
const jsonCall = promptForCase("json-schema");
check(
  "certified TeamIQ reuses current ToolReliability JSON schema prompt and structured output",
  jsonCall.prompt.includes("Required JSON schema:") &&
    jsonCall.prompt.includes('"decision"') &&
    jsonCall.structuredOutput?.schema.required?.includes("decision") === true,
  jsonCall
);
const toolCall = promptForCase("tool-call");
check(
  "certified TeamIQ reuses current ToolReliability tool-action prompt",
  toolCall.prompt.includes("Expected JSON tool action:") &&
    toolCall.prompt.includes("read_range") &&
    toolCall.prompt.includes('"startLine"'),
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
const repairCall = promptForCase("repair-loop");
check(
  "certified TeamIQ seeds repair-loop feedback and requests structured repair output",
  repairCall.prompt.includes("Previous invalid answer:") &&
    repairCall.prompt.includes("Parser feedback") &&
    repairCall.structuredOutput?.schema.required?.length === 3,
  repairCall
);
const forbiddenCall = promptForCase("forbidden-action");
check(
  "certified TeamIQ reuses current ToolReliability safe-command prompt",
  forbiddenCall.prompt.includes("Allowed safe verification action:") &&
    forbiddenCall.prompt.includes('"command":"npm test"'),
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

if (failures === 0) {
  console.log("PASS");
} else {
  console.log(`FAIL ${failures} check(s) failed`);
}

process.exit(failures === 0 ? 0 : 1);
