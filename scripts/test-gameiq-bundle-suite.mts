/* GameIQ "All packs" bundle suite checks
 * (run: npx tsx scripts/test-gameiq-bundle-suite.mts)
 *
 * Verifies the certified GameIQ bundle: running EVERY scenario pack in one
 * certified run produces one scored attempt per pack with distinct case ids,
 * covers all packs, and completes within the computed model-call budget. Uses
 * the same fake/oracle model path as scripts/test-certified-e2e-gameiq.mts.
 */
import {
  __resetBenchmarkStoreForTests,
  listBenchmarkAttemptsV2,
  listBenchmarkVerifierResults,
  saveBenchmarkCaseV2,
  saveBenchmarkTeamComposition,
} from "../lib/benchmark/store";
import { runHarnessCertification } from "../lib/benchmark/certified/certification";
import { runCertifiedBenchmark } from "../lib/benchmark/certified/run-engine";
import { certifiedRunBudgetForCase } from "../lib/benchmark/certified/run-budget";
import {
  GAMEIQ_ALL_PACKS_SUITE_ID,
  gameIqBundlePackIds,
  gameIqPackRunContext,
  isGameIqBundleSuite,
  listCertifiedSuiteOptions,
  reidGameIqPackAttempt,
} from "../lib/benchmark/certified/suite-options";
import {
  listGameIqScenarioPacks,
  runCertifiedGameIq,
} from "../lib/benchmark/gameiq";
import type {
  BenchmarkAttemptV2,
  BenchmarkCaseV2,
  BenchmarkTeamComposition,
} from "../lib/benchmark/types";
import type { CertifiedRunBudget } from "../lib/benchmark/certified/run-context";
import type { SelectedModel, StreamChunk } from "../lib/providers/base";

let failures = 0;
function check(name: string, ok: boolean, detail?: unknown): void {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` -> ${JSON.stringify(detail)}`}`);
}

const packs = listGameIqScenarioPacks();
const packIds = packs.map((pack) => pack.id);
const totalScenarios = packs.reduce(
  (sum, pack) => sum + pack.scenarios.length,
  0
);

// --- Suite-option shape: bundle is first + default, single packs follow. -----
const suiteOptions = listCertifiedSuiteOptions("gameiq");
check(
  "bundle is the first GameIQ suite option (default selection)",
  suiteOptions[0]?.id === GAMEIQ_ALL_PACKS_SUITE_ID &&
    isGameIqBundleSuite(suiteOptions[0].id),
  suiteOptions[0]
);
check(
  "bundle label states what it does",
  suiteOptions[0]?.label === `All GameIQ packs (${packs.length} packs - one run per pack)`,
  suiteOptions[0]?.label
);
check(
  "single-pack options follow the bundle unchanged",
  suiteOptions.length === packs.length + 1 &&
    suiteOptions.slice(1).map((option) => option.id).join(",") ===
      packIds.join(","),
  suiteOptions.map((option) => option.id)
);
check(
  "bundle suite expands to every GameIQ pack id",
  gameIqBundlePackIds(GAMEIQ_ALL_PACKS_SUITE_ID).join(",") === packIds.join(","),
  gameIqBundlePackIds(GAMEIQ_ALL_PACKS_SUITE_ID)
);
check(
  "single-pack suite expands to just itself",
  gameIqBundlePackIds(packIds[0]!).join(",") === packIds[0],
  gameIqBundlePackIds(packIds[0]!)
);

// --- Build one case per pack (mirrors the panel's caseRecords). --------------
const now = "2026-07-02T09:00:00.000Z";
function caseForPack(packId: string, label: string): BenchmarkCaseV2 {
  return {
    id: packId,
    schemaVersion: 2,
    track: "gameiq",
    title: label,
    description: "Certified GameIQ scenario pack.",
    difficulty: "easy",
    tags: ["gameiq"],
    caseVersion: "1.0.0",
    createdAt: now,
    updatedAt: now,
    prompt: { userRequest: "Solve each GameIQ scenario." },
    environment: { type: "browser", timeoutSeconds: 60, network: "none" },
    verifier: { scorer: "game-engine" },
    budget: { maxUsd: 5, maxWallClockSeconds: 600, maxModelCalls: 100 },
    scoring: { scoringVersion: "certified-gameiq-v0.2", primary: "game_iq" },
    contamination: {
      originalTask: true,
      canary: "AIBENCH-UI-GAMEIQ",
      referenceSolutionPrivate: true,
    },
  };
}
const caseRecords = packs.map((pack) => caseForPack(pack.id, pack.label));

function sumBudgetField(
  budgets: CertifiedRunBudget[],
  field: "maxModelCalls" | "maxUsd" | "maxWallClockMs"
): number {
  return budgets.reduce(
    (sum, budget) =>
      sum + (typeof budget[field] === "number" ? (budget[field] as number) : 0),
    0
  );
}
const perCaseBudgets = caseRecords.map((caseRecord) =>
  certifiedRunBudgetForCase(caseRecord, { maxModelCallMs: 120_000 })
);
const modelBudget: CertifiedRunBudget = {
  maxModelCallMs: 120_000,
  maxModelCalls: sumBudgetField(perCaseBudgets, "maxModelCalls"),
  maxUsd: sumBudgetField(perCaseBudgets, "maxUsd"),
  maxWallClockMs: sumBudgetField(perCaseBudgets, "maxWallClockMs"),
};
check(
  "computed model-call budget fits every scenario across all packs",
  typeof modelBudget.maxModelCalls === "number" &&
    modelBudget.maxModelCalls >= totalScenarios,
  { maxModelCalls: modelBudget.maxModelCalls, totalScenarios }
);

// --- Fake/oracle model: answer each scenario with its expected action. -------
const team: BenchmarkTeamComposition = {
  id: "team-gameiq-bundle",
  name: "GameIQ bundle single model",
  comboHash: "combo:gameiq-bundle",
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
  checks: [
    { id: "gameiq-fixture", label: "GameIQ fixture certification", passed: true },
  ],
};

// Flat oracle queue in run order (packs run sequentially; each pack iterates its
// own scenarios in order), so each model call pops the matching expected action.
const oracleQueue = packs.flatMap((pack) =>
  pack.scenarios.map((scenario) => scenario.expectedActions[0]?.action)
);
let callIndex = 0;

__resetBenchmarkStoreForTests();
for (const caseRecord of caseRecords) {
  await saveBenchmarkCaseV2(caseRecord);
}
await saveBenchmarkTeamComposition(team);

const summary = await runCertifiedBenchmark({
  runId: "run-gameiq-bundle",
  suiteId: "suite-gameiq",
  track: "gameiq",
  harnessProfile: "raw-single-model",
  caseIds: caseRecords.map((caseRecord) => caseRecord.id),
  teamCompositionIds: [team.id],
  modelBudget,
  certification: passingCertification,
  runner: async (context, options) => {
    const attempts: BenchmarkAttemptV2[] = [];
    for (const packId of gameIqBundlePackIds(GAMEIQ_ALL_PACKS_SUITE_ID)) {
      const packContext = gameIqPackRunContext(context, packId);
      const packAttempts = await runCertifiedGameIq({
        context: packContext,
        models: [model],
        scenarioPackIds: [packId],
        teamCompositionIds: [team.id],
        trials: 1,
        pricing: { inputUsdPer1M: 1, outputUsdPer1M: 1 },
        signal: options?.signal,
        streamChat: async function* (): AsyncIterable<StreamChunk> {
          const action = oracleQueue[callIndex++];
          yield { type: "token", content: JSON.stringify({ action }) };
          yield { type: "done" };
        },
      });
      attempts.push(
        ...packAttempts.map((attempt) => reidGameIqPackAttempt(attempt, packId))
      );
    }
    return attempts;
  },
});

const attempts = await listBenchmarkAttemptsV2();
const verifiers = await listBenchmarkVerifierResults();

check(
  "bundle run completes (within budget, no budget failure)",
  summary.status === "completed",
  { status: summary.status, error: summary.error }
);
check(
  "bundle calls the model once per scenario across all packs",
  callIndex === totalScenarios,
  { callIndex, totalScenarios }
);
check(
  "bundle produces one attempt per pack",
  attempts.length === packs.length && summary.attemptCount === packs.length,
  { attemptCount: attempts.length, packs: packs.length }
);
check(
  "bundle attempts carry distinct case ids",
  new Set(attempts.map((attempt) => attempt.caseId)).size === packs.length,
  attempts.map((attempt) => attempt.caseId)
);
check(
  "bundle attempts cover every pack id",
  new Set(attempts.map((attempt) => attempt.caseId)).size === packs.length &&
    packIds.every((packId) =>
      attempts.some((attempt) => attempt.caseId === packId)
    ),
  { caseIds: attempts.map((attempt) => attempt.caseId), packIds }
);
check(
  "bundle attempts have distinct ids (no cross-pack collision)",
  new Set(attempts.map((attempt) => attempt.id)).size === packs.length,
  attempts.map((attempt) => attempt.id)
);
check(
  "bundle records one verifier per pack, each linked to its attempt",
  verifiers.length === packs.length &&
    attempts.every((attempt) =>
      verifiers.some(
        (verifier) =>
          verifier.id === attempt.verifierResultId &&
          verifier.attemptId === attempt.id &&
          verifier.caseId === attempt.caseId
      )
    ),
  { verifiers: verifiers.length, packs: packs.length }
);
check(
  "every pack attempt is scored (verifiedQuality present, runId matches run)",
  attempts.every(
    (attempt) =>
      attempt.runId === "run-gameiq-bundle" &&
      typeof attempt.gameIqScore === "number" &&
      typeof attempt.verifiedQuality === "number"
  ),
  attempts.map((attempt) => ({
    runId: attempt.runId,
    gameIqScore: attempt.gameIqScore,
  }))
);

if (failures === 0) {
  console.log("PASS");
} else {
  console.log(`FAIL ${failures} check(s) failed`);
}
process.exit(failures === 0 ? 0 : 1);
