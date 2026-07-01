/* Certified Fireworks runner checks (run: npx tsx scripts/test-certified-fireworks-runner.mts) */
import {
  __resetBenchmarkStoreForTests,
  exportBenchmarkReportBundleV2,
  listBenchmarkAttemptsV2,
  listBenchmarkArtifacts,
  listBenchmarkFailures,
  listBenchmarkTeamCompositions,
  listBenchmarkVerifierResults,
  saveBenchmarkCaseV2,
  saveBenchmarkTeamComposition,
} from "../lib/benchmark/store";
import { runHarnessCertification } from "../lib/benchmark/certified/certification";
import { runCertifiedBenchmark } from "../lib/benchmark/certified/run-engine";
import {
  FIREWORKS_FULL_GAME_CASES,
  FIREWORKS_TACTICS_SCENARIOS,
  fireworksCaseToBenchmarkCaseV2,
} from "../lib/benchmark/fireworks/scenario-packs";
import { runCertifiedFireworksTeamIq } from "../lib/benchmark/fireworks/certified-runner";
import { deriveTeamComposition } from "../lib/benchmark/teamiq";
import type { BenchmarkTeamCompositionRole } from "../lib/benchmark/types";
import type { StreamChunk } from "../lib/providers/base";

let failures = 0;

function check(name: string, ok: boolean, detail?: unknown): void {
  if (!ok) failures++;
  console.log(
    `${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` -> ${JSON.stringify(detail)}`}`
  );
}

const selectedCases = FIREWORKS_TACTICS_SCENARIOS.filter(
  (scenario) => scenario.category === "safe_play"
).slice(0, 3);
const caseV2 = fireworksCaseToBenchmarkCaseV2("fireworks-teamiq-test-safe-play");
const roles: BenchmarkTeamCompositionRole[] = [
  {
    role: "player",
    slot: "P1",
    modelId: "openai:perfect-fireworks-p1",
    providerId: "openai",
    displayName: "Perfect Fireworks P1",
    temperature: 0,
  },
  {
    role: "player",
    slot: "P2",
    modelId: "google:perfect-fireworks-p2",
    providerId: "google",
    displayName: "Perfect Fireworks P2",
    temperature: 0,
  },
];
const team = deriveTeamComposition({
  name: "Perfect Fireworks Duo",
  roles,
  strategy: "panel",
});

__resetBenchmarkStoreForTests();
await saveBenchmarkCaseV2(caseV2);
await saveBenchmarkTeamComposition(team);

const summary = await runCertifiedBenchmark({
  runId: "run-certified-fireworks",
  suiteId: "suite-certified-fireworks",
  track: "teamiq",
  harnessProfile: "raw-single-model",
  caseIds: [caseV2.id],
  teamCompositionIds: [team.id],
  certification: runHarnessCertification("raw-single-model"),
  runner: (context) =>
    runCertifiedFireworksTeamIq({
      context,
      teamCompositions: [team],
      cases: selectedCases,
      includeSoloBaselines: true,
      pricing: {
        inputUsdPer1M: 1,
        outputUsdPer1M: 1,
      },
      streamChat: async function* (): AsyncIterable<StreamChunk> {
        yield { type: "token", content: '{"action":"play","cardIndex":0}' };
        yield { type: "done" };
      },
    }),
});

const attempts = await listBenchmarkAttemptsV2();
const verifiers = await listBenchmarkVerifierResults();
const artifacts = await listBenchmarkArtifacts();
const teamCompositions = await listBenchmarkTeamCompositions();
const bundle = exportBenchmarkReportBundleV2();
const teamAttempt = attempts.find((attempt) => attempt.teamCompositionId === team.id);
const teamSummaryArtifact = artifacts.find(
  (artifact) =>
    artifact.attemptId === teamAttempt?.id &&
    artifact.id.endsWith(":fireworks-summary")
);
const teamSummary = teamSummaryArtifact
  ? JSON.parse(teamSummaryArtifact.content) as {
      metrics?: {
        scoreKind?: unknown;
        scenarioQualityScore?: unknown;
        fullGameStackScore?: unknown;
      };
    }
  : null;
const teamTranscriptArtifact = artifacts.find(
  (artifact) =>
    artifact.attemptId === teamAttempt?.id &&
    artifact.id.endsWith(":fireworks-transcript")
);
const teamTranscript = teamTranscriptArtifact
  ? JSON.parse(teamTranscriptArtifact.content) as {
      cases?: Array<{ expectedActions?: unknown }>;
    }
  : null;
const teamVerifier = verifiers.find(
  (verifier) => verifier.attemptId === teamAttempt?.id
);
const teamVerifierResult = teamVerifier
  ? JSON.parse(teamVerifier.resultJson) as {
      metricRates?: Record<string, unknown>;
    }
  : null;

check(
  "certified Fireworks run completes with solo baselines and team attempt",
  summary.status === "completed" &&
    attempts.length === roles.length + 1 &&
    teamCompositions.length === roles.length + 1,
  { summary, attempts: attempts.length, teamCompositions: teamCompositions.length }
);
check(
  "certified Fireworks records verifier results and transcript artifacts",
  verifiers.length === roles.length + 1 &&
    artifacts.some((artifact) => artifact.id.endsWith(":fireworks-transcript")) &&
    artifacts.some((artifact) => artifact.id.endsWith(":fireworks-summary")),
  { verifiers, artifacts }
);
check(
  "certified Fireworks records model traces for every action",
  bundle.traces.length >= selectedCases.length * (roles.length + 1) &&
    (teamAttempt?.traceIds.length ?? 0) === selectedCases.length,
  { traceCount: bundle.traces.length, teamAttempt }
);
check(
  "certified Fireworks computes team lift from baselines",
  teamAttempt?.status === "passed" &&
    teamAttempt.teamLift === 0 &&
    teamAttempt.jobSuccessScore >= 90,
  teamAttempt
);
check(
  "scenario-only Fireworks summaries expose scenario quality, not stack score",
  teamSummary?.metrics?.scoreKind === "scenario" &&
    typeof teamSummary.metrics.scenarioQualityScore === "number" &&
    teamSummary.metrics.fullGameStackScore === null,
  teamSummary
);
check(
  "scenario-only Fireworks verifier labels scenario quality",
  teamVerifier?.assertionResults.some(
    (assertion) => assertion.id === "scenario-quality"
  ) === true &&
    teamVerifier?.assertionResults.every(
      (assertion) => assertion.id !== "final-score"
    ) === true,
  teamVerifier
);
check(
  "Fireworks verifier result JSON includes sampled metric rates",
  typeof teamVerifierResult?.metricRates?.legalActionRate === "number" &&
    typeof teamVerifierResult.metricRates.usefulClueRate === "number",
  teamVerifierResult
);
check(
  "scenario Fireworks transcript records expected actions for debugging",
  Array.isArray(teamTranscript?.cases?.[0]?.expectedActions) &&
    teamTranscript?.cases?.[0]?.expectedActions.length > 0,
  teamTranscript
);

__resetBenchmarkStoreForTests();
await saveBenchmarkCaseV2(caseV2);
const illegalTeam = deriveTeamComposition({
  name: "Illegal Fireworks Solo",
  roles: [
    {
      role: "player",
      slot: "P1",
      modelId: "openai:illegal-fireworks",
      providerId: "openai",
      displayName: "Illegal Fireworks",
      temperature: 0,
    },
  ],
  strategy: "panel",
});
await saveBenchmarkTeamComposition(illegalTeam);
await runCertifiedBenchmark({
  runId: "run-certified-fireworks-illegal",
  suiteId: "suite-certified-fireworks",
  track: "teamiq",
  harnessProfile: "raw-single-model",
  caseIds: [caseV2.id],
  teamCompositionIds: [illegalTeam.id],
  certification: runHarnessCertification("raw-single-model"),
  runner: (context) =>
    runCertifiedFireworksTeamIq({
      context,
      teamCompositions: [illegalTeam],
      cases: selectedCases.slice(0, 1),
      includeSoloBaselines: false,
      streamChat: async function* (): AsyncIterable<StreamChunk> {
        yield {
          type: "token",
          content: '{"\\u0061ction":"clue_color","targetPlayerId":"P1","color":"red"}',
        };
        yield { type: "done" };
      },
    }),
});
const illegalAttempts = await listBenchmarkAttemptsV2();
const illegalFailures = await listBenchmarkFailures();
check(
  "illegal Fireworks clue records failed_tool_use and classified failure",
  illegalAttempts[0]?.status === "failed_tool_use" &&
    illegalFailures.some((failure) => failure.code === "fireworks_illegal_clue"),
  { illegalAttempts, illegalFailures }
);
check(
  "illegal Fireworks output is not scored via the deterministic fallback",
  illegalAttempts[0]?.verifiedQuality === 0 &&
    illegalAttempts[0]?.jobSuccessScore === 0,
  {
    verifiedQuality: illegalAttempts[0]?.verifiedQuality,
    jobSuccessScore: illegalAttempts[0]?.jobSuccessScore,
  }
);

async function runIllegalFailureIds(): Promise<string[]> {
  __resetBenchmarkStoreForTests();
  await saveBenchmarkCaseV2(caseV2);
  await saveBenchmarkTeamComposition(illegalTeam);
  await runCertifiedBenchmark({
    runId: "run-certified-fireworks-deterministic-illegal",
    suiteId: "suite-certified-fireworks",
    track: "teamiq",
    harnessProfile: "raw-single-model",
    caseIds: [caseV2.id],
    teamCompositionIds: [illegalTeam.id],
    certification: runHarnessCertification("raw-single-model"),
    runner: (context) =>
      runCertifiedFireworksTeamIq({
        context,
        teamCompositions: [illegalTeam],
        cases: selectedCases.slice(0, 1),
        includeSoloBaselines: false,
        streamChat: async function* (): AsyncIterable<StreamChunk> {
          yield {
            type: "token",
            content: '{"\\u0061ction":"clue_color","targetPlayerId":"P1","color":"red"}',
          };
          yield { type: "done" };
        },
      }),
  });
  return (await listBenchmarkFailures()).map((failure) => failure.id);
}

const firstIllegalFailureIds = await runIllegalFailureIds();
const secondIllegalFailureIds = await runIllegalFailureIds();
check(
  "same deterministic failing Fireworks run creates the same failure IDs",
  firstIllegalFailureIds.length > 0 &&
    JSON.stringify(firstIllegalFailureIds) === JSON.stringify(secondIllegalFailureIds),
  { firstIllegalFailureIds, secondIllegalFailureIds }
);

__resetBenchmarkStoreForTests();
const fullCase = { ...FIREWORKS_FULL_GAME_CASES[0], id: "fireworks-full-calibration-test", maxTurns: 1 };
await saveBenchmarkCaseV2(fireworksCaseToBenchmarkCaseV2("fireworks-teamiq-full-calibration-test", "full"));
await saveBenchmarkTeamComposition(illegalTeam);
await runCertifiedBenchmark({
  runId: "run-certified-fireworks-full-calibration",
  suiteId: "suite-certified-fireworks",
  track: "teamiq",
  harnessProfile: "raw-single-model",
  caseIds: ["fireworks-teamiq-full-calibration-test"],
  teamCompositionIds: [illegalTeam.id],
  certification: runHarnessCertification("raw-single-model"),
  runner: (context) =>
    runCertifiedFireworksTeamIq({
      context,
      teamCompositions: [illegalTeam],
      cases: [fullCase],
      includeSoloBaselines: false,
      streamChat: async function* (): AsyncIterable<StreamChunk> {
        yield { type: "token", content: '{"action":"discard","cardIndex":0}' };
        yield { type: "done" };
      },
    }),
});
const fullArtifacts = await listBenchmarkArtifacts();
check(
  "full-game Fireworks run records calibration summary artifact",
  fullArtifacts.some((artifact) => artifact.id.endsWith(":fireworks-calibration-summary")),
  fullArtifacts.map((artifact) => artifact.id)
);

if (failures === 0) {
  console.log("PASS");
} else {
  console.log(`FAIL ${failures} check(s) failed`);
}

process.exit(failures === 0 ? 0 : 1);
