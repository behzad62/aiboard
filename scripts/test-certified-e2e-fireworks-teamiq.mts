/* Certified Fireworks TeamIQ e2e checks (run: npx tsx scripts/test-certified-e2e-fireworks-teamiq.mts) */
import {
  __resetBenchmarkStoreForTests,
  exportBenchmarkReportBundleV2,
  importBenchmarkReportBundleV2,
  listBenchmarkAttemptsV2,
  listBenchmarkFailures,
  saveBenchmarkCaseV2,
  saveBenchmarkTeamComposition,
} from "../lib/benchmark/store";
import { runHarnessCertification } from "../lib/benchmark/certified/certification";
import { runCertifiedBenchmark } from "../lib/benchmark/certified/run-engine";
import {
  FIREWORKS_MEMORY_SCENARIOS,
  FIREWORKS_TACTICS_SCENARIOS,
  fireworksCaseToBenchmarkCaseV2,
} from "../lib/benchmark/fireworks/scenario-packs";
import { runCertifiedTeamIq } from "../lib/benchmark/teamiq";
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

const cases = [
  ...FIREWORKS_TACTICS_SCENARIOS.filter((scenario) => scenario.category === "safe_play").slice(0, 2),
  ...FIREWORKS_MEMORY_SCENARIOS.filter((scenario) => scenario.category === "combine_color_and_rank").slice(0, 1),
];
const caseV2 = fireworksCaseToBenchmarkCaseV2("fireworks-teamiq-e2e");
const roles: BenchmarkTeamCompositionRole[] = [
  {
    role: "player",
    slot: "P1",
    modelId: "openai:fireworks-e2e-a",
    providerId: "openai",
    displayName: "Fireworks E2E A",
    temperature: 0,
  },
  {
    role: "player",
    slot: "P2",
    modelId: "anthropic:fireworks-e2e-b",
    providerId: "anthropic",
    displayName: "Fireworks E2E B",
    temperature: 0,
  },
];
const team = deriveTeamComposition({
  name: "Fireworks E2E Duo",
  roles,
  strategy: "panel",
});

__resetBenchmarkStoreForTests();
await saveBenchmarkCaseV2(caseV2);
await saveBenchmarkTeamComposition(team);

const summary = await runCertifiedBenchmark({
  runId: "run-certified-fireworks-e2e",
  suiteId: "suite-certified-fireworks",
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
        kind: "fireworks",
        suite: "mixed",
        cases,
      },
      includeSoloBaselines: true,
      streamChat: async function* (): AsyncIterable<StreamChunk> {
        yield {
          type: "token",
          content: '{"action":"clue_color","targetPlayerId":"P1","color":"red"}',
        };
        yield { type: "done" };
      },
    }),
});

const attempts = await listBenchmarkAttemptsV2();
const teamAttempt = attempts.find((attempt) => attempt.teamCompositionId === team.id);
const bundle = exportBenchmarkReportBundleV2();
const scoreBeforeImport = teamAttempt?.jobSuccessScore ?? null;

__resetBenchmarkStoreForTests();
await importBenchmarkReportBundleV2(bundle);
const importedBundle = exportBenchmarkReportBundleV2();
const importedAttempt = (await listBenchmarkAttemptsV2()).find(
  (attempt) => attempt.id === teamAttempt?.id
);
const importedFailures = await listBenchmarkFailures();

check(
  "Fireworks TeamIQ route creates solo baselines, mixed attempt, and team lift",
  summary.status === "completed" &&
    attempts.length === roles.length + 1 &&
    teamAttempt?.teamLift === 0,
  { summary, attempts, teamAttempt }
);
check(
  "v2 bundle export includes Fireworks attempts, verifiers, traces, artifacts, and failures",
  bundle.attemptsV2.length === roles.length + 1 &&
    bundle.verifierResults.length === roles.length + 1 &&
    bundle.traces.length >= cases.length * (roles.length + 1) &&
    bundle.artifacts.some((artifact) => artifact.id.endsWith(":fireworks-transcript")) &&
    bundle.failures.length > 0,
  {
    attempts: bundle.attemptsV2.length,
    verifiers: bundle.verifierResults.length,
    traces: bundle.traces.length,
    artifacts: bundle.artifacts.length,
    failures: bundle.failures.length,
  }
);
check(
  "imported bundle reproduces Fireworks score and failures",
  importedBundle.attemptsV2.length === bundle.attemptsV2.length &&
    importedAttempt?.jobSuccessScore === scoreBeforeImport &&
    importedFailures.length === bundle.failures.length,
  { importedAttempt, scoreBeforeImport, importedFailures, bundleFailures: bundle.failures }
);

if (failures === 0) {
  console.log("PASS");
} else {
  console.log(`FAIL ${failures} check(s) failed`);
}

process.exit(failures === 0 ? 0 : 1);
