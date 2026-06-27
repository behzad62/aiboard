/* Certified benchmark scoring checks (run: npx tsx scripts/test-benchmark-scoring.mts) */
import { scoreGameIqAttempt } from "../lib/benchmark/scoring/gameiq";
import { aggregateCertifiedRunScores } from "../lib/benchmark/scoring/aggregate";
import { scoreTeamLift } from "../lib/benchmark/scoring/teamiq";
import { scoreToolReliability } from "../lib/benchmark/scoring/toolreliability";
import { scoreWorkBenchAttempt } from "../lib/benchmark/scoring/workbench";
import type {
  BenchmarkAttemptV2,
  BenchmarkTeamComposition,
} from "../lib/benchmark/types";

let failures = 0;

function check(name: string, ok: boolean, detail?: unknown): void {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` -> ${JSON.stringify(detail)}`}`);
}

const failed = scoreWorkBenchAttempt({
  verifierScore: 0,
  verifierPassed: false,
  actualCostUsd: 5,
  targetCostUsd: 1,
  actualDurationMs: 120_000,
  targetDurationMs: 60_000,
  validToolCalls: 5,
  totalToolCalls: 10,
});
check("failed verifier gives efficiency score 0", failed.efficiencyScore === 0, failed);
check("failed verifier preserves verified quality", failed.verifiedQuality === 0, failed);

const cheap = scoreWorkBenchAttempt({
  verifierScore: 0.8,
  verifierPassed: true,
  actualCostUsd: 0.5,
  targetCostUsd: 1,
  actualDurationMs: 30_000,
  targetDurationMs: 60_000,
  validToolCalls: 10,
  totalToolCalls: 10,
});
const expensive = scoreWorkBenchAttempt({
  verifierScore: 0.8,
  verifierPassed: true,
  actualCostUsd: 4,
  targetCostUsd: 1,
  actualDurationMs: 30_000,
  targetDurationMs: 60_000,
  validToolCalls: 10,
  totalToolCalls: 10,
});
check("high cost lowers efficiency but not verified quality", expensive.efficiencyScore < cheap.efficiencyScore && expensive.verifiedQuality === cheap.verifiedQuality, { cheap, expensive });
check("workbench efficiency uses weighted factor formula", cheap.efficiencyScore === 80 && expensive.efficiencyScore === 65, { cheap, expensive });
check("workbench score exposes plan field names", cheap.timeFactor === 1 && cheap.toolReliability === 1, cheap);

const unknownCost = scoreWorkBenchAttempt({
  verifierScore: 1,
  verifierPassed: true,
  actualCostUsd: null,
  targetCostUsd: 1,
  actualDurationMs: 60_000,
  targetDurationMs: 60_000,
  validToolCalls: 0,
  totalToolCalls: 0,
});
check("unknown cost does not crash scoring", unknownCost.costFactor === null && Number.isFinite(unknownCost.efficiencyScore), unknownCost);

const gameIq = scoreGameIqAttempt({
  outcomeScore: 1,
  moveQuality: 1,
  legalActionRate: 1,
  structuredReliability: 1,
  fallbackRate: 0,
  latencyFactor: 1,
});
check("perfect GameIQ scores 100", gameIq === 100, gameIq);
const weightedGameIq = scoreGameIqAttempt({
  outcomeScore: 0,
  moveQuality: 1,
  legalActionRate: 1,
  structuredReliability: 1,
  fallbackRate: 0.2,
  latencyFactor: 1,
});
check("GameIQ uses plan weights and fallback multiplier", weightedGameIq === 58.5, weightedGameIq);

const toolReliability = scoreToolReliability({
  schemaValidRate: 1,
  firstAttemptValidRate: 1,
  repairSuccessRate: 1,
  toolValidRate: 1,
  patchSuccessRate: 1,
  commandSafetyRate: 1,
  forbiddenActionRate: 0.2,
});
check("forbidden actions penalize tool reliability", toolReliability === 80, toolReliability);
const schemaOnlyReliability = scoreToolReliability({
  schemaValidRate: 1,
  firstAttemptValidRate: 0,
  repairSuccessRate: 0,
  toolValidRate: 0,
  patchSuccessRate: 0,
  commandSafetyRate: 0,
  forbiddenActionRate: 0,
});
check("ToolReliability uses plan weights", schemaOnlyReliability === 25, schemaOnlyReliability);

const lift = scoreTeamLift({
  teamScore: 84,
  memberSoloScores: [60, 74, 71],
  teamCostUsd: 1,
  bestSoloCostUsd: 0.8,
  teamDurationMs: 50_000,
  bestSoloDurationMs: 60_000,
});
check("team lift uses best solo baseline", lift.bestSoloScore === 74 && lift.teamLift === 10, lift);
check("team lift exposes adjusted lift values", lift.costAdjustedTeamLift === 8 && lift.speedAdjustedTeamLift === 12, lift);
check("strong positive team classification works", lift.label === "strong_positive", lift);

const wasteful = scoreTeamLift({
  teamScore: 70,
  memberSoloScores: [75],
  teamCostUsd: 2,
  bestSoloCostUsd: 1,
  teamDurationMs: 90_000,
  bestSoloDurationMs: 30_000,
});
check("wasteful team classification works", wasteful.label === "wasteful", wasteful);

const soloTeamA: BenchmarkTeamComposition = {
  id: "solo-a",
  name: "Model A",
  comboHash: "solo:a",
  roles: [
    {
      role: "single",
      slot: "single",
      modelId: "model:a",
      providerId: "test",
      displayName: "Model A",
      temperature: 0,
    },
  ],
};
const teamAB: BenchmarkTeamComposition = {
  id: "team-ab",
  name: "Model A plus Model B",
  comboHash: "team:a-b",
  roles: [
    {
      role: "architect",
      slot: "architect",
      modelId: "model:a",
      providerId: "test",
      displayName: "Model A",
      temperature: 0,
    },
    {
      role: "worker",
      slot: "worker",
      modelId: "model:b",
      providerId: "test",
      displayName: "Model B",
      temperature: 0,
    },
  ],
};
const aggregateRows = aggregateCertifiedRunScores({
  attempts: [
    certifiedAttempt("attempt-solo-a", soloTeamA.id, 60),
    certifiedAttempt("attempt-team-ab", teamAB.id, 90),
  ],
  cases: [],
  teamCompositions: [soloTeamA, teamAB],
  verifierResults: [],
});
const partialBaselineTeam = aggregateRows.find(
  (row) => row.teamCompositionId === teamAB.id
);
check(
  "aggregate team lift requires every member solo baseline",
  partialBaselineTeam?.teamLift === null && partialBaselineTeam?.bestSoloScore === null,
  aggregateRows
);

if (failures === 0) {
  console.log("PASS");
} else {
  console.log(`FAIL ${failures} check(s) failed`);
}

process.exit(failures === 0 ? 0 : 1);

function certifiedAttempt(
  id: string,
  teamCompositionId: string,
  jobSuccessScore: number
): BenchmarkAttemptV2 {
  return {
    id,
    runId: `run-${id}`,
    caseId: "case-lift",
    teamCompositionId,
    mode: "certified",
    track: "workbench",
    harnessProfile: "aiboard-build-multi-worker",
    status: "passed",
    startedAt: "2026-06-27T10:00:00.000Z",
    completedAt: "2026-06-27T10:01:00.000Z",
    verifiedQuality: jobSuccessScore / 100,
    jobSuccessScore,
    efficiencyScore: jobSuccessScore,
    costUsd: 0.01,
    inputTokens: 100,
    outputTokens: 50,
    modelCalls: 1,
    toolCalls: 1,
    durationMs: 1000,
    artifactIds: [],
    traceIds: [`trace-${id}`],
    failureIds: [],
    harnessVersion: "test",
    promptSetVersion: "test",
    scoringVersion: "certified-v0.1",
  };
}
