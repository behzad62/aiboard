/* GameIQ multi-model orchestration checks
 * (run: npx tsx scripts/test-gameiq-multi-model.mts)
 *
 * Mirrors the panel's GameIQ multi-model run seam: each selected model runs the
 * "All GameIQ packs" bundle as its own independent certified run (own runId, own
 * solo team, one scored attempt per pack), fanned out with Promise.allSettled so
 * one model throwing does not abort the others. Uses the same fake/oracle model
 * path as scripts/test-certified-e2e-gameiq.mts / test-gameiq-bundle-suite.mts.
 *
 * The bundle excludes the saturated v1 Battleship pack (see
 * lib/benchmark/gameiq/saturation.ts / gameIqBundlePackIds) and the
 * standalone-selectable v1 Chess/Connect Four packs. Their v2 depth packs
 * join the bundle, so this test's per-run pack count is bundlePacks.length
 * (7), not the full catalog (10). Pack counts below are computed from the
 * live catalog/bundle expansion, not hardcoded.
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
  classifyGameIqModelRunOutcome,
  gameIqBundlePackIds,
  gameIqPackRunContext,
  reidGameIqPackAttempt,
} from "../lib/benchmark/certified/suite-options";
import {
  GAMEIQ_SCORING_VERSION,
  listGameIqScenarioPacks,
  runCertifiedGameIq,
} from "../lib/benchmark/gameiq";
import { deriveSoloTeamComposition } from "../lib/benchmark/teamiq";
import type {
  BenchmarkAttemptV2,
  BenchmarkCaseV2,
} from "../lib/benchmark/types";
import type { CertifiedRunBudget } from "../lib/benchmark/certified/run-context";
import type { CertifiedRunSummary } from "../lib/benchmark/certified/run-status";
import type { SelectedModel, StreamChunk } from "../lib/providers/base";

let failures = 0;
function check(name: string, ok: boolean, detail?: unknown): void {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` -> ${JSON.stringify(detail)}`}`);
}

// Full pack CATALOG (10 packs) vs the BUNDLE expansion (7 packs — v1
// Battleship, Chess, and Connect Four excluded). Mirrors CertifiedRunPanel:
// caseRecords/oracle/run loop are all scoped to the bundle's pack ids, not the
// raw catalog, so no excluded v1 pack gets a case or call in this bundle-driven
// run (all three v2 replacements do).
const packs = listGameIqScenarioPacks();
const packIdsInRunOrder = gameIqBundlePackIds(GAMEIQ_ALL_PACKS_SUITE_ID);
const bundlePacks = packs.filter((pack) => packIdsInRunOrder.includes(pack.id));
const packIds = bundlePacks.map((pack) => pack.id);
const totalScenarios = bundlePacks.reduce(
  (sum, pack) => sum + pack.scenarios.length,
  0
);

// --- Shared cases: model-independent pack case ids, built once. --------------
const now = "2026-07-02T12:00:00.000Z";
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
const caseRecords = bundlePacks.map((pack) => caseForPack(pack.id, pack.label));
const caseIds = caseRecords.map((caseRecord) => caseRecord.id);

check(
  "shared pack case ids are model-independent (no model in id)",
  caseIds.join(",") === packIds.join(","),
  caseIds
);

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

const passingCertification = {
  ...runHarnessCertification("raw-single-model"),
  passed: true,
  checks: [
    { id: "gameiq-fixture", label: "GameIQ fixture certification", passed: true },
  ],
};

// Three selected models; the middle one throws mid-run. Each model gets its own
// oracle queue so parallel execution can't cross-contaminate call ordering.
const selectedModels: SelectedModel[] = [
  { modelId: "openai:gpt-gameiq-a", providerId: "openai", displayName: "GPT GameIQ A" },
  { modelId: "openai:gpt-gameiq-b", providerId: "openai", displayName: "GPT GameIQ B" },
  { modelId: "openai:gpt-gameiq-c", providerId: "openai", displayName: "GPT GameIQ C" },
];
const throwingModelId = "openai:gpt-gameiq-b";

function oracleForModel(): string[] {
  return bundlePacks.flatMap((pack) =>
    pack.scenarios.map((scenario) => scenario.expectedActions[0]?.action)
  );
}

__resetBenchmarkStoreForTests();
for (const caseRecord of caseRecords) {
  await saveBenchmarkCaseV2(caseRecord);
}

const batchStamp = 1_700_000_000_000;
function slugForRunId(value: string): string {
  return value.replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "model";
}

interface ModelRunResult {
  modelId: string;
  status: "passed" | "failed";
  summary?: CertifiedRunSummary;
  error?: string;
  runId: string;
}

async function runOneModel(
  model: SelectedModel,
  index: number
): Promise<ModelRunResult> {
  const runId = `ui-gameiq-${batchStamp}-${slugForRunId(model.providerId)}-${slugForRunId(model.modelId)}-${index}`;
  const team = deriveSoloTeamComposition({
    modelId: model.modelId,
    providerId: model.providerId,
    displayName: model.displayName,
  });
  await saveBenchmarkTeamComposition(team);
  const oracle = oracleForModel();
  let callIndex = 0;
  try {
    const summary = await runCertifiedBenchmark({
      runId,
      suiteId: "suite-gameiq",
      track: "gameiq",
      harnessProfile: "raw-single-model",
      caseIds,
      teamCompositionIds: [team.id],
      modelBudget,
      certification: passingCertification,
      runner: async (context, options) => {
        // Simulate a provider becoming unavailable for model B: the runner throws
        // before producing any attempts. runCertifiedBenchmark folds this into a
        // failed summary (it does not reject), and Promise.allSettled/allWith the
        // other models keeps running.
        if (model.modelId === throwingModelId) {
          throw new Error("Provider unavailable: simulated failure for model B");
        }
        const attempts: BenchmarkAttemptV2[] = [];
        for (const packId of packIdsInRunOrder) {
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
              const action = oracle[callIndex++];
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
    if (summary.status !== "completed") {
      return { modelId: model.modelId, status: "failed", summary, error: summary.error, runId };
    }
    return { modelId: model.modelId, status: "passed", summary, runId };
  } catch (error) {
    return {
      modelId: model.modelId,
      status: "failed",
      error: error instanceof Error ? error.message : String(error),
      runId,
    };
  }
}

// Full parallel over all three (cap is 4 in the panel; 3 < cap so all run at once).
const settled = await Promise.all(
  selectedModels.map((model, index) => runOneModel(model, index))
);

const attempts = await listBenchmarkAttemptsV2();
const verifiers = await listBenchmarkVerifierResults();

const passedRuns = settled.filter((run) => run.status === "passed");
const failedRuns = settled.filter((run) => run.status === "failed");

check(
  "two models pass, the throwing middle model is reported failed",
  passedRuns.length === 2 &&
    failedRuns.length === 1 &&
    failedRuns[0]?.modelId === throwingModelId,
  settled.map((run) => ({ modelId: run.modelId, status: run.status }))
);

check(
  "Promise.allSettled isolation: model B failing did not abort A or C",
  passedRuns.map((run) => run.modelId).sort().join(",") ===
    "openai:gpt-gameiq-a,openai:gpt-gameiq-c",
  passedRuns.map((run) => run.modelId)
);

check(
  "each model produced a distinct runId",
  new Set(settled.map((run) => run.runId)).size === settled.length,
  settled.map((run) => run.runId)
);

check(
  "three distinct solo teams (one per model), all solo strategy",
  (() => {
    const passedSummaries = passedRuns.map((run) => run.summary!);
    // Attempts across the two passing runs carry two distinct team ids; the
    // failed run's synthesized failure attempts add a third distinct team.
    const teamIds = new Set(attempts.map((attempt) => attempt.teamCompositionId));
    return teamIds.size === 3 && passedSummaries.length === 2;
  })(),
  attempts.map((attempt) => attempt.teamCompositionId)
);

check(
  "three runs recorded (distinct runIds across all attempts)",
  new Set(attempts.map((attempt) => attempt.runId)).size === 3,
  Array.from(new Set(attempts.map((attempt) => attempt.runId)))
);

check(
  "each passing model has one scored attempt per bundle pack (model x pack, three v0.1 packs excluded)",
  passedRuns.every((run) => {
    const runAttempts = attempts.filter(
      (attempt) => attempt.runId === run.runId
    );
    return (
      runAttempts.length === bundlePacks.length &&
      new Set(runAttempts.map((attempt) => attempt.caseId)).size ===
        bundlePacks.length &&
      runAttempts.every(
        (attempt) =>
          typeof attempt.gameIqScore === "number" &&
          typeof attempt.verifiedQuality === "number"
      )
    );
  }),
  passedRuns.map((run) => ({
    runId: run.runId,
    attempts: attempts.filter((a) => a.runId === run.runId).length,
  }))
);

check(
  "passing runs cover every pack id",
  passedRuns.every((run) =>
    packIds.every((packId) =>
      attempts.some(
        (attempt) => attempt.runId === run.runId && attempt.caseId === packId
      )
    )
  ),
  { packIds }
);

check(
  "all scored attempt ids are distinct (no cross-model/pack collision)",
  (() => {
    const scored = attempts.filter((attempt) =>
      passedRuns.some((run) => run.runId === attempt.runId)
    );
    return new Set(scored.map((attempt) => attempt.id)).size === scored.length;
  })(),
  attempts.map((attempt) => attempt.id)
);

check(
  "each passing model records one verifier per pack, linked to its attempts",
  (() => {
    const scoredAttemptIds = new Set(
      attempts
        .filter((attempt) => passedRuns.some((run) => run.runId === attempt.runId))
        .map((attempt) => attempt.id)
    );
    const linkedVerifiers = verifiers.filter((verifier) =>
      scoredAttemptIds.has(verifier.attemptId)
    );
    return (
      linkedVerifiers.length === passedRuns.length * bundlePacks.length &&
      linkedVerifiers.every((verifier) => scoredAttemptIds.has(verifier.attemptId))
    );
  })(),
  { verifiers: verifiers.length, totalScenarios }
);

check(
  "each passing run completed within budget (status completed)",
  passedRuns.every((run) => run.summary?.status === "completed"),
  passedRuns.map((run) => run.summary?.status)
);

// A completed run whose attempts all scored 0 ("failed_model") must NOT read as
// passed — it is the exact bug the per-model badge had. classifyGameIqModelRun-
// Outcome is the shared classifier used by the UI.
const zeroScore = classifyGameIqModelRunOutcome(true, [
  { status: "failed_model", verifiedQuality: 0 },
  { status: "failed_model", verifiedQuality: 0 },
]);
check(
  "completed run with only failed_model attempts is 'failed', not 'passed'",
  zeroScore.status === "failed" &&
    zeroScore.packsPassed === 0 &&
    zeroScore.packsScored === 2,
  zeroScore
);

// verifiedQuality is a 0-1 ratio; avgQuality is reported as a 0-100 percentage.
const allPass = classifyGameIqModelRunOutcome(true, [
  { status: "passed", verifiedQuality: 0.82 },
  { status: "passed", verifiedQuality: 0.9 },
]);
check(
  "completed run with all attempts passed is 'passed' with 0-100 avg quality",
  allPass.status === "passed" &&
    allPass.packsPassed === 2 &&
    Math.round(allPass.avgQuality) === 86,
  allPass
);

const mixed = classifyGameIqModelRunOutcome(true, [
  { status: "passed", verifiedQuality: 0.8 },
  { status: "failed_model", verifiedQuality: 0 },
]);
check(
  "completed run with some passing packs is 'partial'",
  mixed.status === "partial" && mixed.packsPassed === 1,
  mixed
);

const errored = classifyGameIqModelRunOutcome(false, []);
check(
  "a run that did not complete is 'failed'",
  errored.status === "failed" && errored.packsScored === 0,
  errored
);

if (failures === 0) {
  console.log("PASS");
} else {
  console.log(`FAIL ${failures} check(s) failed`);
}
process.exit(failures === 0 ? 0 : 1);
