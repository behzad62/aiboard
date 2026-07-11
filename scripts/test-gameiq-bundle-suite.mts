/* GameIQ "All packs" bundle suite checks
 * (run: npx tsx scripts/test-gameiq-bundle-suite.mts)
 *
 * Verifies the certified GameIQ bundle: running the bundle in one certified
 * run produces one scored attempt per bundle pack with distinct case ids,
 * covers all bundle packs, and completes within the computed model-call
 * budget. Uses the same fake/oracle model path as
 * scripts/test-certified-e2e-gameiq.mts.
 *
 * The bundle excludes only the saturated v1 Battleship pack (11/11 across
 * all four 2026-07 reference models — see lib/benchmark/gameiq/saturation.ts);
 * v2 Battleship (gameiq-v0.2-battleship, oracle-graded, unsaturated) rejoined
 * the bundle when it shipped, so the default bundle is 7 of the 8 catalog
 * packs. v1 Battleship stays in the full pack catalog and remains selectable
 * as its own standalone suite option; this file checks both halves of that
 * split. Pack counts below are computed from the live catalog/bundle
 * expansion, not hardcoded, so this file does not need updating every time a
 * pack is added or removed -- only this comment's prose does.
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
  GAMEIQ_SCORING_VERSION,
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

// The full pack CATALOG still includes every pack (battleship included) —
// standalone single-pack selection must keep working for all of them. The
// BUNDLE ("All GameIQ packs") excludes battleship: it is 11/11 saturated
// across all four 2026-07 reference models (see
// lib/benchmark/gameiq/saturation.ts), so it carries zero discrimination
// signal in an aggregate run. Battleship stays selectable as its own
// standalone suite option — only the bundle expansion drops it.
const packs = listGameIqScenarioPacks();
const packIds = packs.map((pack) => pack.id);
const GAMEIQ_BUNDLE_EXCLUDED_PACK_ID = "gameiq-v0.1-battleship";
const bundlePacks = packs.filter(
  (pack) => pack.id !== GAMEIQ_BUNDLE_EXCLUDED_PACK_ID
);
const bundlePackIds = bundlePacks.map((pack) => pack.id);
const totalScenarios = bundlePacks.reduce(
  (sum, pack) => sum + pack.scenarios.length,
  0
);

check(
  "battleship stays in the full pack catalog (only excluded from the bundle)",
  packIds.includes(GAMEIQ_BUNDLE_EXCLUDED_PACK_ID),
  packIds
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
  "bundle label states what it actually runs (7 packs, v1 battleship excluded)",
  suiteOptions[0]?.label ===
    `All GameIQ packs (${bundlePackIds.length} packs - one run per pack)`,
  suiteOptions[0]?.label
);
check(
  "single-pack options follow the bundle unchanged and still list every pack (incl. battleship)",
  suiteOptions.length === packs.length + 1 &&
    suiteOptions.slice(1).map((option) => option.id).join(",") ===
      packIds.join(","),
  suiteOptions.map((option) => option.id)
);
check(
  "bundle suite expands to every GameIQ pack id EXCEPT battleship",
  gameIqBundlePackIds(GAMEIQ_ALL_PACKS_SUITE_ID).join(",") ===
    bundlePackIds.join(",") &&
    !gameIqBundlePackIds(GAMEIQ_ALL_PACKS_SUITE_ID).includes(
      GAMEIQ_BUNDLE_EXCLUDED_PACK_ID
    ),
  gameIqBundlePackIds(GAMEIQ_ALL_PACKS_SUITE_ID)
);
check(
  "single-pack suite expands to just itself",
  gameIqBundlePackIds(bundlePackIds[0]!).join(",") === bundlePackIds[0],
  gameIqBundlePackIds(bundlePackIds[0]!)
);
check(
  "battleship remains standalone-selectable: expands to itself, not swallowed by the bundle exclusion",
  gameIqBundlePackIds(GAMEIQ_BUNDLE_EXCLUDED_PACK_ID).join(",") ===
    GAMEIQ_BUNDLE_EXCLUDED_PACK_ID,
  gameIqBundlePackIds(GAMEIQ_BUNDLE_EXCLUDED_PACK_ID)
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
    scoring: { scoringVersion: GAMEIQ_SCORING_VERSION, primary: "game_iq" },
    contamination: {
      originalTask: true,
      canary: "AIBENCH-UI-GAMEIQ",
      referenceSolutionPrivate: true,
    },
  };
}
// Mirrors CertifiedRunPanel: caseRecords are built from gameIqBundlePackIds
// (the bundle's expansion), not from the raw pack catalog — so battleship
// (excluded from the bundle) gets no case here, matching real behavior.
const caseRecords = bundlePacks.map((pack) => caseForPack(pack.id, pack.label));

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
// Scoped to bundlePacks (battleship excluded), matching what the bundle
// actually runs.
const oracleQueue = bundlePacks.flatMap((pack) =>
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
  "bundle produces one attempt per pack (v1 battleship excluded, 7 packs)",
  attempts.length === bundlePacks.length &&
    summary.attemptCount === bundlePacks.length,
  { attemptCount: attempts.length, packs: bundlePacks.length }
);
check(
  "bundle attempts carry distinct case ids",
  new Set(attempts.map((attempt) => attempt.caseId)).size === bundlePacks.length,
  attempts.map((attempt) => attempt.caseId)
);
check(
  "bundle attempts cover every bundle pack id (and never include battleship)",
  new Set(attempts.map((attempt) => attempt.caseId)).size ===
    bundlePacks.length &&
    bundlePackIds.every((packId) =>
      attempts.some((attempt) => attempt.caseId === packId)
    ) &&
    !attempts.some(
      (attempt) => attempt.caseId === GAMEIQ_BUNDLE_EXCLUDED_PACK_ID
    ),
  { caseIds: attempts.map((attempt) => attempt.caseId), bundlePackIds }
);
check(
  "bundle attempts have distinct ids (no cross-pack collision)",
  new Set(attempts.map((attempt) => attempt.id)).size === bundlePacks.length,
  attempts.map((attempt) => attempt.id)
);
check(
  "bundle records one verifier per pack, each linked to its attempt",
  verifiers.length === bundlePacks.length &&
    attempts.every((attempt) =>
      verifiers.some(
        (verifier) =>
          verifier.id === attempt.verifierResultId &&
          verifier.attemptId === attempt.id &&
          verifier.caseId === attempt.caseId
      )
    ),
  { verifiers: verifiers.length, packs: bundlePacks.length }
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
