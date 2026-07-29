import assert from "node:assert/strict";
import {
  benchmarkResultConfigurationKey,
} from "../lib/benchmark/certified/result-set-identity";
import { selectBenchmarkResultSeries } from "../lib/benchmark/certified/result-set-selectors";
import type {
  BenchmarkResultConfiguration,
  BenchmarkResultSet,
  BenchmarkTeamComposition,
} from "../lib/benchmark/types";

const soloConfig: BenchmarkResultConfiguration = {
  subjectKind: "model",
  displayName: "GPT-5.6",
  providerId: "chatgpt",
  modelId: "gpt-5.6",
  reasoningEffort: "medium",
  roles: [],
  tracks: [{
    track: "gameiq",
    suiteId: "gameiq-v1",
    caseManifest: [{
      caseId: "case-1",
      caseVersion: "1",
      scoringVersion: "score-v1",
    }],
    maxTokens: null,
  }],
};

const teamAtTemperatureZero: BenchmarkTeamComposition = {
  id: "team-zero",
  name: "Ordered team",
  comboHash: "team-zero",
  strategy: "architect_worker",
  roles: [
    {
      role: "architect",
      slot: "architect",
      providerId: "openai",
      modelId: "gpt-5.6",
      displayName: "Architect",
      reasoningEffort: "high",
      temperature: 0,
      maxTokens: 1_000,
    },
    {
      role: "worker",
      slot: "worker",
      providerId: "anthropic",
      modelId: "claude-sonnet-5",
      displayName: "Worker",
      reasoningEffort: "medium",
      temperature: 0,
    },
  ],
};
const teamAtTemperatureOne: BenchmarkTeamComposition = {
  ...teamAtTemperatureZero,
  id: "team-one",
  comboHash: "team-one",
  roles: teamAtTemperatureZero.roles.map((role) => ({
    ...role,
    temperature: 1,
  })),
};

function configurationFromTeam(
  team: BenchmarkTeamComposition
): BenchmarkResultConfiguration {
  return {
    subjectKind: "team",
    displayName: team.name,
    strategy: team.strategy,
    roles: team.roles.map((role) => ({
      role: role.role,
      slot: role.slot,
      providerId: role.providerId,
      modelId: role.modelId,
      reasoningEffort: role.reasoningEffort ?? "default",
      maxTokens: role.maxTokens ?? null,
    })),
    tracks: soloConfig.tracks,
  };
}

const teamConfig = configurationFromTeam(teamAtTemperatureZero);
const key = benchmarkResultConfigurationKey;

assert.equal(
  key({ ...soloConfig, displayName: "GPT-5.6 Luna" }),
  key({ ...soloConfig, displayName: "Renamed display label" })
);
assert.notEqual(key(soloConfig), key({ ...soloConfig, reasoningEffort: "high" }));
assert.notEqual(key(soloConfig), key({ ...soloConfig, providerId: "openai" }));
assert.notEqual(
  key(teamConfig),
  key({ ...teamConfig, roles: [...teamConfig.roles].reverse() })
);
assert.equal(
  key(configurationFromTeam(teamAtTemperatureZero)),
  key(configurationFromTeam(teamAtTemperatureOne))
);

function resultSet(
  id: string,
  completedAt: string,
  overallScore: number,
  verifiedPassRate: number,
  configuration: BenchmarkResultConfiguration = soloConfig
): BenchmarkResultSet {
  return {
    id,
    schemaVersion: 1,
    executionId: `execution-${id}`,
    anchorRunId: `run-${id}`,
    runIds: [`run-${id}`],
    configurationKey: key(configuration),
    configuration,
    expectedAttempts: [],
    status: "completed",
    createdAt: "2026-07-29T09:00:00.000Z",
    completedAt,
    terminalAt: completedAt,
    metrics: {
      attempts: 10,
      passed: 8,
      failed: 2,
      verifiedPassRate,
      verifiedQuality: 80,
      overallScore,
      trackBreakdown: [],
      jobSuccessScore: 80,
      efficiencyScore: 80,
      toolReliabilityScore: null,
      toolReliabilitySamples: 0,
      costUsd: null,
      averageCostUsd: null,
      durationMs: null,
      costPerPass: null,
      speedPerPassMs: null,
      inputTokens: null,
      outputTokens: null,
      totalTokens: null,
      tokensPerPass: null,
      costBasis: null,
    },
  };
}

const a = resultSet("a", "2026-07-29T10:00:00.000Z", 60, 0.6);
const b = resultSet("b", "2026-07-29T11:00:00.000Z", 70, 0.5);
const c = resultSet("c", "2026-07-29T11:00:00.000Z", 85, 0.75);
const changedScoring = resultSet("score-v2", "2026-07-29T12:00:00.000Z", 90, 0.9, {
  ...soloConfig,
  tracks: [{
    ...soloConfig.tracks[0],
    caseManifest: [{
      ...soloConfig.tracks[0].caseManifest[0],
      scoringVersion: "score-v2",
    }],
  }],
});
const nonCompleted = ["pending", "failed", "cancelled", "deleting"] as const;
const invalidRecords = nonCompleted.map((status) => ({
  ...resultSet(status, "2026-07-29T12:00:00.000Z", 99, 0.99),
  status,
}));
const legacyUnvalidated = resultSet(
  "legacy-unvalidated",
  "2026-07-29T12:00:00.000Z",
  99,
  0.99
);

const series = selectBenchmarkResultSeries(
  [a, b, c, changedScoring, ...invalidRecords, legacyUnvalidated],
  (record) => record.id !== "legacy-unvalidated"
);
const soloSeries = series.find((entry) => entry.configurationKey === key(soloConfig));
assert.deepEqual(soloSeries?.latest.id, "c");
assert.deepEqual(soloSeries?.older.map((record) => record.id), ["b", "a"]);
assert.equal(soloSeries?.overallDelta, 15);
assert.equal(soloSeries?.passRateDelta, 0.25);
assert.equal(series.length, 2);
assert.equal(series.find((entry) => entry.configurationKey === key(changedScoring.configuration))?.latest.id, "score-v2");

console.log("PASS benchmark result-set identity");
