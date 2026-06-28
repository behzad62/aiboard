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
  TOOL_RELIABILITY_V0_1_CASES,
} from "../lib/benchmark/toolreliability";
import {
  deriveTeamComposition,
  runCertifiedTeamIq,
} from "../lib/benchmark/teamiq";
import type {
  BenchmarkCaseV2,
  BenchmarkTeamCompositionRole,
} from "../lib/benchmark/types";
import type { StreamChunk } from "../lib/providers/base";

let failures = 0;

function check(name: string, ok: boolean, detail?: unknown): void {
  if (!ok) failures++;
  console.log(
    `${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` -> ${JSON.stringify(detail)}`}`
  );
}

const now = "2026-06-28T13:00:00.000Z";
const caseV2: BenchmarkCaseV2 = {
  id: "teamiq-toolreliability-v0.1-pack",
  schemaVersion: 2,
  track: "teamiq",
  title: "TeamIQ over ToolReliability v0.1",
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
    scoringVersion: "teamiq-toolreliability-v0.1",
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
const selectedCases = TOOL_RELIABILITY_V0_1_CASES.slice(0, 5);
const outputByCase = new Map(
  selectedCases.flatMap((benchmarkCase) =>
    (perfectOutputs[benchmarkCase.id] ?? []).map((output, index) => [
      `${benchmarkCase.canary}:${index}`,
      output,
    ])
  )
);
const callsByProvider = new Map<string, number>();

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
      selectedCases.reduce(
        (sum, benchmarkCase) =>
          sum + roles.length * (benchmarkCase.category === "repair-loop" ? 2 : 1),
        0
      ),
  { traceCount: bundle.traces.length, teamAttempt }
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
