/* GameIQ "All packs" bundle suite checks
 * (run: npx tsx scripts/test-gameiq-bundle-suite.mts)
 *
 * Verifies the certified GameIQ bundle: running the bundle in one certified
 * run produces one scored attempt per bundle pack with distinct case ids,
 * covers all bundle packs, and completes within the computed model-call
 * budget. Uses the same fake/oracle model path as
 * scripts/test-certified-e2e-gameiq.mts.
 *
 * The saturated v0.1 battleship/chess/connect-four packs were hard-deleted
 * 2026-07-17 (their v0.2 depth/quiet-mate/hunt packs are the sole surviving
 * pack per game), so there is no exclusion mechanism left: the bundle IS the
 * full pack catalog, full stop. Pack counts below are computed from the live
 * catalog/bundle expansion, not hardcoded, so this file does not need
 * updating every time a pack is added or removed -- only this comment's
 * prose does.
 */
import {
  __resetBenchmarkStoreForTests,
  listBenchmarkAttemptsV2,
  listBenchmarkRuns,
  listBenchmarkToolCallTraces,
  listBenchmarkTraces,
  listBenchmarkVerifierResults,
  saveBenchmarkCaseV2,
  saveBenchmarkTeamComposition,
} from "../lib/benchmark/store";
import { runHarnessCertification } from "../lib/benchmark/certified/certification";
import { runCertifiedBenchmark } from "../lib/benchmark/certified/run-engine";
import { persistReturnedAttempts } from "../lib/benchmark/certified/model-runner";
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

// The BUNDLE ("All GameIQ packs") is now simply the full pack CATALOG — the
// v0.1 battleship/chess/connect-four packs it used to exclude are hard-deleted,
// so there is nothing left to filter out.
const packs = listGameIqScenarioPacks();
const packIds = packs.map((pack) => pack.id);
const bundlePacks = packs;
const bundlePackIds = bundlePacks.map((pack) => pack.id);
const totalScenarios = bundlePacks.reduce(
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
  "bundle label states what it actually runs (7 packs)",
  suiteOptions[0]?.label ===
    `All GameIQ packs (${bundlePackIds.length} packs - one run per pack)`,
  suiteOptions[0]?.label
);
check(
  "single-pack options follow the bundle unchanged and still list every pack",
  suiteOptions.length === packs.length + 1 &&
    suiteOptions.slice(1).map((option) => option.id).join(",") ===
      packIds.join(","),
  suiteOptions.map((option) => option.id)
);
check(
  "bundle suite expands to every GameIQ pack id (no exclusions left)",
  gameIqBundlePackIds(GAMEIQ_ALL_PACKS_SUITE_ID).join(",") ===
    bundlePackIds.join(","),
  gameIqBundlePackIds(GAMEIQ_ALL_PACKS_SUITE_ID)
);
check(
  "single-pack suite expands to just itself",
  gameIqBundlePackIds(bundlePackIds[0]!).join(",") === bundlePackIds[0],
  gameIqBundlePackIds(bundlePackIds[0]!)
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
// (the bundle's expansion), which is now just every registered pack.
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
// Scoped to bundlePacks (every registered pack), matching what the bundle
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
  "bundle produces one attempt per pack (7 packs, the full catalog)",
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
  "bundle attempts cover every bundle pack id",
  new Set(attempts.map((attempt) => attempt.caseId)).size ===
    bundlePacks.length &&
    bundlePackIds.every((packId) =>
      attempts.some((attempt) => attempt.caseId === packId)
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

// Production-shaped partial recovery: run-execution reuses the same
// run/team/model/trial identity for every pack, wraps the context per pack,
// and persists each re-IDed pack attempt before advancing. The second pack
// fails after registering its owner and recording exact-owned evidence.
const partialPacks = bundlePacks.slice(0, 2);
const partialCaseRecords = partialPacks.map((pack) =>
  caseForPack(pack.id, pack.label)
);
const partialRunId = "run-gameiq-multi-pack-owner-recovery";
const rawAttemptId =
  `gameiq-attempt:${partialRunId}:${team.id}:${model.modelId}`;
const packAttemptId = (packId: string) => `${rawAttemptId}:pack:${packId}`;
let durableMultiPackOwners: unknown = null;

__resetBenchmarkStoreForTests();
for (const caseRecord of partialCaseRecords) {
  await saveBenchmarkCaseV2(caseRecord);
}
await saveBenchmarkTeamComposition(team);

const partialSummary = await runCertifiedBenchmark({
  runId: partialRunId,
  suiteId: "suite-gameiq",
  track: "gameiq",
  harnessProfile: "raw-single-model",
  caseIds: partialCaseRecords.map((caseRecord) => caseRecord.id),
  teamCompositionIds: [team.id],
  certification: passingCertification,
  runner: async (context, options) => {
    for (const [packIndex, pack] of partialPacks.entries()) {
      const packContext = gameIqPackRunContext(context, pack.id);
      let scenarioIndex = 0;
      let toolRecorded = false;
      const packAttempts = await runCertifiedGameIq({
        context: packContext,
        models: [model],
        scenarioPackIds: [pack.id],
        teamCompositionIds: [team.id],
        trials: 1,
        pricing: { inputUsdPer1M: 1, outputUsdPer1M: 1 },
        signal: options?.signal,
        streamChat: async function* (): AsyncIterable<StreamChunk> {
          if (packIndex === 0) {
            const action =
              pack.scenarios[scenarioIndex++]?.expectedActions[0]?.action;
            yield { type: "token", content: JSON.stringify({ action }) };
            yield { type: "done" };
            return;
          }
          const running = (await listBenchmarkRuns()).find(
            (candidate) => candidate.id === context.runId
          );
          durableMultiPackOwners = running
            ? (JSON.parse(running.summaryJson) as { attemptOwners?: unknown })
                .attemptOwners
            : null;
          if (!toolRecorded) {
            toolRecorded = true;
            await packContext.recordToolCall({
              id: `${rawAttemptId}:tool:pack-two`,
              attemptId: rawAttemptId,
              caseId: pack.id,
              toolName: "gameiq:pack-fixture",
              status: "ok",
              startedAt: context.startedAt,
              completedAt: new Date().toISOString(),
              durationMs: 1,
            });
          }
          yield { type: "token", content: '{"action":{"column":3}}' };
          yield {
            type: "error",
            error: "Your prepayment credits are depleted.",
          };
        },
      });
      const reidd = packAttempts.map((attempt) =>
        reidGameIqPackAttempt(attempt, pack.id)
      );
      await persistReturnedAttempts(context, reidd);
    }
    return [];
  },
});

const partialAttempts = (await listBenchmarkAttemptsV2()).filter(
  (attempt) => attempt.runId === partialRunId
);
const partialTraces = (await listBenchmarkTraces()).filter(
  (trace) => trace.runId === partialRunId
);
const partialToolCalls = (await listBenchmarkToolCallTraces()).filter(
  (trace) =>
    partialPacks.some((pack) => trace.caseId === pack.id) &&
    trace.id.endsWith(":tool:pack-two")
);
const firstPackAttempt = partialAttempts.find(
  (attempt) => attempt.caseId === partialPacks[0]?.id
);
const secondPackAttempt = partialAttempts.find(
  (attempt) => attempt.caseId === partialPacks[1]?.id
);
const durableOwnerIds = Array.isArray(durableMultiPackOwners)
  ? durableMultiPackOwners.map(
      (owner) => (owner as { attemptId?: unknown }).attemptId
    )
  : [];

check(
  "multi-pack wrapper durably registers two pack-scoped owners without conflict",
  partialSummary.status === "failed" &&
    !partialSummary.error?.includes("conflicting case/team metadata") &&
    durableOwnerIds.length === 2 &&
    partialPacks.every((pack) => durableOwnerIds.includes(packAttemptId(pack.id))),
  { summary: partialSummary, durableMultiPackOwners }
);
check(
  "completed pack one and fatal pack two recover as exactly two canonical attempts",
  partialAttempts.length === 2 &&
    firstPackAttempt?.id === packAttemptId(partialPacks[0]!.id) &&
    firstPackAttempt.status === "passed" &&
    secondPackAttempt?.id === packAttemptId(partialPacks[1]!.id) &&
    secondPackAttempt.status === "provider_unavailable" &&
    !partialAttempts.some((attempt) => attempt.id === rawAttemptId),
  partialAttempts
);
check(
  "multi-pack trace, token, cost, and tool evidence remains exact-owned",
  partialTraces.length === partialPacks[0]!.scenarios.length + 1 &&
    partialTraces.every((trace) =>
      partialPacks.some(
        (pack) =>
          trace.caseId === pack.id &&
          trace.attemptId === packAttemptId(pack.id)
      )
    ) &&
    partialToolCalls.length === 1 &&
    partialToolCalls[0]?.attemptId === packAttemptId(partialPacks[1]!.id) &&
    secondPackAttempt?.traceIds.length === 1 &&
    secondPackAttempt.modelCalls === 1 &&
    secondPackAttempt.toolCalls === 1 &&
    secondPackAttempt.inputTokens > 0 &&
    secondPackAttempt.outputTokens > 0 &&
    (secondPackAttempt.costUsd ?? 0) > 0,
  { partialAttempts, partialTraces, partialToolCalls }
);

if (failures === 0) {
  console.log("PASS");
} else {
  console.log(`FAIL ${failures} check(s) failed`);
}
process.exit(failures === 0 ? 0 : 1);
