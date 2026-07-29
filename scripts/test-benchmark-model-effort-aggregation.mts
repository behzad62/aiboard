import assert from "node:assert/strict";
import {
  buildCertifiedBenchmarkDashboardData,
} from "../lib/benchmark/metrics";
import {
  aggregateCompletedResultSetFixtures,
  buildScopedModelIntelligenceRows,
} from "./benchmark-result-set-test-fixtures";
import { benchmarkResultConfigurationKey } from "../lib/benchmark/certified/result-set-identity";
import { withCompletedResultSetFixtures } from "./benchmark-result-set-test-fixtures";
import {
  readModelIntelligence,
  readTeamIqComboMatrixRows,
  readWorkBenchRoleRows,
} from "../lib/benchmark/certified/dashboard-selectors";
import type {
  BenchmarkAttemptV2,
  BenchmarkTeamComposition,
} from "../lib/benchmark/types";

const createdAt = "2026-07-26T00:00:00.000Z";
const modelId = "openai:model";

function solo(
  id: string,
  reasoningEffort?: BenchmarkTeamComposition["roles"][number]["reasoningEffort"]
): BenchmarkTeamComposition {
  return {
    id,
    name: "Model solo",
    comboHash: id,
    strategy: "solo",
    roles: [{
      role: "single",
      slot: "single",
      modelId,
      providerId: "openai",
      displayName: "Model",
      reasoningEffort,
      temperature: 0,
    }],
  };
}

function attempt(
  id: string,
  teamCompositionId: string,
  verifiedQuality: number,
  track: BenchmarkAttemptV2["track"] = "gameiq"
): BenchmarkAttemptV2 {
  return {
    id,
    runId: `run-${id}`,
    caseId: `case-${id}`,
    teamCompositionId,
    mode: "certified",
    track,
    harnessProfile: track === "workbench" ? "local-runner" : "raw-single-model",
    status: "passed",
    startedAt: createdAt,
    completedAt: createdAt,
    verifiedQuality,
    jobSuccessScore: verifiedQuality * 100,
    efficiencyScore: verifiedQuality * 100,
    costUsd: null,
    inputTokens: 10,
    outputTokens: 5,
    modelCalls: 1,
    toolCalls: 0,
    durationMs: 1_000,
    artifactIds: [],
    traceIds: [],
    failureIds: [],
    harnessVersion: "test-harness",
    promptSetVersion: "test-prompts",
    scoringVersion: "test-scoring",
  };
}

const low = solo("solo-low", "low");
const high = solo("solo-high", "high");
const legacy = solo("solo-legacy");
const explicitDefault = solo("solo-explicit-default", "default");
const attempts = [
  attempt("low", low.id, 0.4),
  attempt("high", high.id, 0.9),
  attempt("legacy", legacy.id, 0.6),
  attempt("explicit-default", explicitDefault.id, 0.8),
];

const aggregateRows = aggregateCompletedResultSetFixtures({
  attempts,
  teamCompositions: [low, high, legacy, explicitDefault],
});
assert.equal(aggregateRows.length, 3);
assert.deepEqual(
  aggregateRows.map((row) => row.displayName).sort(),
  ["Model · Default", "Model · High", "Model · Low"]
);
assert.deepEqual(
  aggregateRows.map((row) => row.teamName).sort(),
  ["Model · Default", "Model · High", "Model · Low"]
);
assert.deepEqual(
  aggregateRows.map((row) => row.modelVariantKeys[0]).sort(),
  ["openai:model\u0000default", "openai:model\u0000high", "openai:model\u0000low"]
);
const defaultAggregate = aggregateRows.find(
  (row) => row.modelVariantKeys[0] === "openai:model\u0000default"
);
assert.equal(defaultAggregate?.attempts, 2);
assert.deepEqual(
  defaultAggregate?.teamCompositionIds,
  ["solo-explicit-default", "solo-legacy"]
);
const sameDecisionLegacyAttempt = {
  ...attempt("same-decision-legacy", legacy.id, 0.4, "teamiq"),
  caseId: "same-default-decision",
};
const sameDecisionExplicitAttempt = {
  ...attempt(
    "same-decision-explicit",
    explicitDefault.id,
    0.8,
    "gameiq"
  ),
  caseId: "same-default-decision",
};
const sameDecisionHighAttempt = {
  ...attempt("same-decision-high", high.id, 0.9, "gameiq"),
  caseId: "same-default-decision",
};
const sameDecisionRows = aggregateCompletedResultSetFixtures({
  attempts: [
    sameDecisionLegacyAttempt,
    sameDecisionExplicitAttempt,
    sameDecisionHighAttempt,
  ],
  teamCompositions: [legacy, explicitDefault, high],
});
const sameDecisionDefaultRow = sameDecisionRows.find(
  (row) => row.modelVariantKeys[0] === "openai:model\u0000default"
);
const sameDecisionHighRow = sameDecisionRows.find(
  (row) => row.modelVariantKeys[0] === "openai:model\u0000high"
);
assert.equal(sameDecisionRows.length, 2);
assert.equal(sameDecisionDefaultRow?.attempts, 1);
assert.equal(sameDecisionDefaultRow?.verifiedQuality, 0.8);
assert.deepEqual(sameDecisionDefaultRow?.teamCompositionIds, [
  "solo-explicit-default",
  "solo-legacy",
]);
assert.deepEqual(sameDecisionHighRow?.teamCompositionIds, ["solo-high"]);
const defaultTeam: BenchmarkTeamComposition = {
  id: "team-default",
  name: "Default effort team",
  comboHash: "team-default",
  strategy: "parallel",
  roles: [
    { ...explicitDefault.roles[0], role: "architect", slot: "architect" },
    { ...explicitDefault.roles[0], role: "worker", slot: "worker" },
  ],
};
const defaultLiftRows = aggregateCompletedResultSetFixtures({
  attempts: [...attempts, attempt("team-default", defaultTeam.id, 0.9)],
  teamCompositions: [low, high, legacy, explicitDefault, defaultTeam],
});
assert.equal(
  defaultLiftRows.find((row) => row.teamCompositionId === defaultTeam.id)
    ?.teamLift,
  20
);

const highTeam: BenchmarkTeamComposition = {
  id: "team-high",
  name: "High effort team",
  comboHash: "team-high",
  strategy: "parallel",
  roles: [
    {
      ...high.roles[0],
      role: "architect",
      slot: "architect",
    },
    {
      ...high.roles[0],
      role: "worker",
      slot: "worker",
    },
  ],
};
const teamAttempt = attempt("team-high", highTeam.id, 0.8);
const lowBaselineAttempt = attempt("lift-low", low.id, 0.9);
const highBaselineAttempt = attempt("lift-high", high.id, 0.6);
const effortLiftRows = aggregateCompletedResultSetFixtures({
  attempts: [lowBaselineAttempt, highBaselineAttempt, teamAttempt],
  teamCompositions: [low, high, highTeam],
});
assert.equal(
  effortLiftRows.find((row) => row.teamCompositionId === highTeam.id)?.teamLift,
  20
);
const missingEffortLiftRows = aggregateCompletedResultSetFixtures({
  attempts: [lowBaselineAttempt, teamAttempt],
  teamCompositions: [low, highTeam],
});
assert.equal(
  missingEffortLiftRows.find((row) => row.teamCompositionId === highTeam.id)?.teamLift,
  null
);

const intelligenceRows = buildScopedModelIntelligenceRows({
  attempts,
  teamCompositions: [low, high, legacy, explicitDefault],
});
assert.equal(intelligenceRows.length, 3);
assert.deepEqual(
  intelligenceRows.map((row) => ({
    variantKey: row.variantKey,
    reasoningEffort: row.reasoningEffort,
    displayName: row.displayName,
  })).sort((a, b) => a.variantKey.localeCompare(b.variantKey)),
  [
    { variantKey: "openai:model\u0000default", reasoningEffort: "default", displayName: "Model · Default" },
    { variantKey: "openai:model\u0000high", reasoningEffort: "high", displayName: "Model · High" },
    { variantKey: "openai:model\u0000low", reasoningEffort: "low", displayName: "Model · Low" },
  ]
);

const dashboard = buildCertifiedBenchmarkDashboardData(withCompletedResultSetFixtures({
  caseV2: [],
  attemptsV2: [
    attempt("workbench-low", low.id, 0.4, "workbench"),
    attempt("workbench-high", high.id, 0.9, "workbench"),
  ],
  verifierResults: [],
  teamCompositions: [low, high],
  harnessCertifications: [],
}));
assert.deepEqual(
  dashboard.workBenchRoleLeaderboards.worker.map((row) => ({
    variantKey: row.variantKey,
    reasoningEffort: row.reasoningEffort,
    displayName: row.displayName,
  })).sort((a, b) => a.variantKey.localeCompare(b.variantKey)),
  [
    { variantKey: "openai:model\u0000high", reasoningEffort: "high", displayName: "Model · High" },
    { variantKey: "openai:model\u0000low", reasoningEffort: "low", displayName: "Model · Low" },
  ]
);

const exactConfigBase = withCompletedResultSetFixtures({
  caseV2: [],
  attemptsV2: [
    {
      ...attempt("exact-config-100", low.id, 0.1, "workbench"),
      caseId: "exact-config-case",
    },
    {
      ...attempt("exact-config-200", low.id, 0.2, "workbench"),
      caseId: "exact-config-case",
    },
  ],
  verifierResults: [],
  teamCompositions: [low],
  harnessCertifications: [],
});
const exactConfigResultSets = exactConfigBase.resultSets.map(
  (resultSet, index) => {
    const configuration = {
      ...resultSet.configuration,
      tracks: resultSet.configuration.tracks.map((track) => ({
        ...track,
        maxTokens: index === 0 ? 100 : 200,
      })),
    };
    const quality = index === 0 ? 0.9 : 0.7;
    return {
      ...resultSet,
      configuration,
      configurationKey: benchmarkResultConfigurationKey(configuration),
      metrics: {
        ...resultSet.metrics!,
        verifiedQuality: quality,
        overallScore: quality,
        jobSuccessScore: quality * 100,
        efficiencyScore: quality * 100,
        trackBreakdown: resultSet.metrics!.trackBreakdown.map((track) => ({
          ...track,
          averageVerifiedQuality: quality,
        })),
      },
    };
  }
);
const exactConfigDashboard = buildCertifiedBenchmarkDashboardData({
  ...exactConfigBase,
  resultSets: exactConfigResultSets,
});
assert.equal(exactConfigDashboard.leaderboard.length, 2);
assert.deepEqual(
  exactConfigDashboard.modelIntelligence
    .map((row) => row.combinedScore)
    .sort(),
  [0.7, 0.9],
  "model intelligence must preserve exact snapshot configurations"
);
assert.deepEqual(
  exactConfigDashboard.workBenchRoleLeaderboards.worker
    .map((row) => row.verifiedQuality)
    .sort(),
  [0.7, 0.9],
  "role rows must use each exact snapshot's immutable metrics"
);
assert.equal(
  exactConfigDashboard.summary.averageVerifiedQuality,
  0.8,
  "summary quality must be calculated from immutable snapshot metrics"
);

const exactTeam: BenchmarkTeamComposition = {
  id: "exact-team",
  name: "Exact team",
  comboHash: "exact-team",
  strategy: "architect_worker",
  roles: [
    { ...low.roles[0], role: "architect", slot: "architect" },
    { ...high.roles[0], role: "worker", slot: "worker" },
  ],
};
const exactComboBase = withCompletedResultSetFixtures({
  caseV2: [],
  attemptsV2: [
    {
      ...attempt("exact-combo-100", exactTeam.id, 0.1, "workbench"),
      caseId: "exact-combo-case",
    },
    {
      ...attempt("exact-combo-200", exactTeam.id, 0.2, "workbench"),
      caseId: "exact-combo-case",
    },
  ],
  verifierResults: [],
  teamCompositions: [low, high, exactTeam],
  harnessCertifications: [],
});
const exactComboResultSets = exactComboBase.resultSets.map((resultSet, index) => {
  const configuration = {
    ...resultSet.configuration,
    tracks: resultSet.configuration.tracks.map((track) => ({
      ...track,
      maxTokens: index === 0 ? 100 : 200,
    })),
  };
  const quality = index === 0 ? 0.4 : 0.85;
  return {
    ...resultSet,
    configuration,
    configurationKey: benchmarkResultConfigurationKey(configuration),
    metrics: {
      ...resultSet.metrics!,
      verifiedQuality: quality,
      overallScore: quality,
      jobSuccessScore: quality * 100,
      trackBreakdown: resultSet.metrics!.trackBreakdown.map((track) => ({
        ...track,
        averageVerifiedQuality: quality,
      })),
    },
  };
});
const exactComboDashboard = buildCertifiedBenchmarkDashboardData({
  ...exactComboBase,
  resultSets: exactComboResultSets,
});
assert.deepEqual(
  exactComboDashboard.teamIqComboMatrixRows
    .map((row) => row.verifiedQuality)
    .sort(),
  [0.4, 0.85],
  "combo rows must preserve exact snapshots and immutable quality"
);

assert.deepEqual(
  readModelIntelligence({
    modelIntelligence: [{ modelId, displayName: "Model", attempts: 1, tracks: [] }],
  })[0],
  {
    modelId,
    variantKey: "openai:model\u0000default",
    reasoningEffort: "default",
    displayName: "Model · Default",
    attempts: 1,
    passed: 0,
    verifiedPassRate: null,
    combinedScore: 0,
    trackCount: 0,
    preliminary: false,
    tracks: [],
  }
);
assert.deepEqual(
  readWorkBenchRoleRows([{ id: "worker:openai:model", modelId, displayName: "Model", attempts: 1 }])[0],
  {
    id: "worker:openai:model",
    modelId,
    variantKey: "openai:model\u0000default",
    reasoningEffort: "default",
    displayName: "Model · Default",
    attempts: 1,
    passed: 0,
    verifiedPassRate: null,
    verifiedQuality: null,
    efficiencyScore: null,
    averageCostUsd: null,
    averageDurationMs: null,
  }
);

const importedModelRow = {
  modelId,
  reasoningEffort: "invalid",
  variantKey: "attacker:model\u0000high",
  displayName: "Model",
  attempts: 1,
  tracks: [],
};
const importedModelPayload = { modelIntelligence: [importedModelRow] };
assert.equal(
  readModelIntelligence(importedModelPayload)[0]?.variantKey,
  "openai:model\u0000default"
);
assert.equal(importedModelRow.variantKey, "attacker:model\u0000high");

const importedRoleRow = {
  id: "worker:openai:model",
  modelId,
  reasoningEffort: "low",
  variantKey: "openai:model\u0000high",
  displayName: "Model",
  attempts: 1,
};
assert.equal(
  readWorkBenchRoleRows([importedRoleRow])[0]?.variantKey,
  "openai:model\u0000low"
);
assert.equal(importedRoleRow.variantKey, "openai:model\u0000high");

const importedComboRow = {
  id: "combo",
  teamCompositionId: "team",
  teamName: "Team",
  comboHash: "hash",
  track: "teamiq",
  modelIds: ["openai:model", "anthropic:model"],
  modelVariantKeys: [
    "openai:model\u0000HIGH",
    "anthropic:model\u0000high",
    "attacker:model\u0000max",
    "malformed-key",
  ],
  attempts: 1,
  verifiedQuality: 0.8,
  jobSuccessScore: 80,
  recommendationLabel: "recommended",
};
const importedComboPayload = { teamIqComboMatrixRows: [importedComboRow] };
assert.deepEqual(
  readTeamIqComboMatrixRows(importedComboPayload)[0]?.modelVariantKeys,
  ["anthropic:model\u0000high", "openai:model\u0000default"]
);
assert.deepEqual(importedComboRow.modelVariantKeys, [
  "openai:model\u0000HIGH",
  "anthropic:model\u0000high",
  "attacker:model\u0000max",
  "malformed-key",
]);

console.log("PASS benchmark model effort aggregation");
