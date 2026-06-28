/* Certified GameIQ runner checks (run: npx tsx scripts/test-certified-gameiq-runner.mts) */
import {
  __resetBenchmarkStoreForTests,
  exportBenchmarkReportBundleV2,
  listBenchmarkAttemptsV2,
  listBenchmarkVerifierResults,
  saveBenchmarkCaseV2,
  saveBenchmarkTeamComposition,
} from "../lib/benchmark/store";
import { runHarnessCertification } from "../lib/benchmark/certified/certification";
import { runCertifiedBenchmark } from "../lib/benchmark/certified/run-engine";
import { getGameIqScenarioPack } from "../lib/benchmark/gameiq";
import { runCertifiedGameIq } from "../lib/benchmark/gameiq/certified-runner";
import type { BenchmarkCaseV2, BenchmarkTeamComposition } from "../lib/benchmark/types";
import type { SelectedModel, StreamChunk } from "../lib/providers/base";

let failures = 0;

function check(name: string, ok: boolean, detail?: unknown): void {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` -> ${JSON.stringify(detail)}`}`);
}

const pack = getGameIqScenarioPack("connect-four");
if (!pack) throw new Error("Connect Four GameIQ pack is required for this test.");

const now = "2026-06-28T09:00:00.000Z";
const caseV2: BenchmarkCaseV2 = {
  id: pack.id,
  schemaVersion: 2,
  track: "gameiq",
  title: pack.label,
  description: "Certified GameIQ Connect Four scenario pack.",
  difficulty: "easy",
  tags: ["gameiq", "connect-four"],
  caseVersion: pack.version,
  createdAt: now,
  updatedAt: now,
  prompt: {
    userRequest: "Solve each Connect Four scenario.",
    publicContext: "Return a JSON object with an action field.",
  },
  game: {
    gameId: "connect-four",
    seed: pack.id,
  },
  environment: {
    type: "browser",
    timeoutSeconds: 60,
    network: "none",
  },
  verifier: {
    scorer: "game-engine",
  },
  budget: {
    maxUsd: 1,
    maxModelCalls: pack.scenarios.length,
  },
  scoring: {
    scoringVersion: "certified-gameiq-v0.1",
    primary: "game_iq",
  },
  contamination: {
    originalTask: true,
    canary: "AIBENCH-CERTIFIED-GAMEIQ-RUNNER",
    referenceSolutionPrivate: true,
  },
};

const team: BenchmarkTeamComposition = {
  id: "team-certified-gameiq",
  name: "Certified GameIQ single model",
  comboHash: "combo:certified-gameiq",
  roles: [
    {
      role: "single",
      slot: "single",
      modelId: "openai:gpt-gameiq",
      providerId: "openai",
      displayName: "GPT GameIQ",
      temperature: 0,
      maxTokens: 512,
    },
  ],
};
const model: SelectedModel = {
  modelId: "openai:gpt-gameiq",
  providerId: "openai",
  displayName: "GPT GameIQ",
};
const passingCertification = {
  ...runHarnessCertification("raw-single-model"),
  passed: true,
  checks: [{ id: "gameiq-fixture", label: "GameIQ fixture certification", passed: true }],
};

__resetBenchmarkStoreForTests();
await saveBenchmarkCaseV2(caseV2);
await saveBenchmarkTeamComposition(team);

let callIndex = 0;
const summary = await runCertifiedBenchmark({
  runId: "run-certified-gameiq",
  suiteId: "suite-certified-gameiq",
  track: "gameiq",
  harnessProfile: "raw-single-model",
  caseIds: [pack.id],
  teamCompositionIds: [team.id],
  certification: passingCertification,
  runner: (context) =>
    runCertifiedGameIq({
      context,
      models: [model],
      scenarioPackIds: [pack.id],
      teamCompositionIds: [team.id],
      trials: 1,
      pricing: {
        inputUsdPer1M: 1,
        outputUsdPer1M: 1,
      },
      streamChat: async function* (): AsyncIterable<StreamChunk> {
        const scenario = pack.scenarios[callIndex++];
        yield {
          type: "token",
          content: JSON.stringify({
            action: scenario.expectedActions[0]?.action,
          }),
        };
        yield { type: "done" };
      },
    }),
});

const attempts = await listBenchmarkAttemptsV2();
const verifiers = await listBenchmarkVerifierResults();
const bundle = exportBenchmarkReportBundleV2();
const attempt = attempts[0];
const verifier = verifiers[0];

check("certified GameIQ run completes", summary.status === "completed" && summary.attemptCount === 1 && summary.verifierCount === 1, summary);
check("certified GameIQ calls one model per scenario", callIndex === pack.scenarios.length, { callIndex, scenarios: pack.scenarios.length });
check("certified GameIQ attempt persists verified score", attempt?.status === "passed" && attempt.gameIqScore === 100 && attempt.verifiedQuality === 1, attempt);
check("certified GameIQ attempt accumulates traces and cost", attempt?.traceIds.length === pack.scenarios.length && attempt.modelCalls === pack.scenarios.length && attempt.costUsd !== null && attempt.costUsd > 0, attempt);
check("certified GameIQ verifier records scenario assertions", verifier?.attemptId === attempt?.id && verifier.assertionResults.length === pack.scenarios.length && verifier.passed, verifier);
check("certified GameIQ dashboard updates", summary.dashboard.summary.certifiedAttempts === 1 && summary.dashboard.summary.verifiedPassRate === 1, summary.dashboard.summary);
check("certified GameIQ traces export", bundle.traces.length === pack.scenarios.length && bundle.traces.every((trace) => trace.runId === "run-certified-gameiq"), bundle.traces);

if (failures === 0) {
  console.log("PASS");
} else {
  console.log(`FAIL ${failures} check(s) failed`);
}

process.exit(failures === 0 ? 0 : 1);
