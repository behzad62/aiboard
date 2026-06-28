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
const teamVerifier = verifiers.find(
  (verifier) => verifier.attemptId === teamAttempt?.id
);

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
          content: '{"action":"clue_color","targetPlayerId":"P1","color":"red"}',
        };
        yield { type: "done" };
      },
    }),
});
const illegalAttempts = await listBenchmarkAttemptsV2();
const illegalFailures = await listBenchmarkFailures();
check(
  "illegal Fireworks action records failed_tool_use and classified failure",
  illegalAttempts[0]?.status === "failed_tool_use" &&
    illegalFailures.some((failure) => failure.code === "fireworks_illegal_action"),
  { illegalAttempts, illegalFailures }
);

if (failures === 0) {
  console.log("PASS");
} else {
  console.log(`FAIL ${failures} check(s) failed`);
}

process.exit(failures === 0 ? 0 : 1);
