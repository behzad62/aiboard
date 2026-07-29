import assert from "node:assert/strict";
import {
  __resetBenchmarkStoreForTests,
  listBenchmarkAttemptsV2,
  listBenchmarkResultSets,
  listBenchmarkTraces,
  saveBenchmarkCaseV2,
  saveBenchmarkTeamComposition,
} from "../lib/benchmark/store";
import { runHarnessCertification } from "../lib/benchmark/certified/certification";
import { runCertifiedBenchmark } from "../lib/benchmark/certified/run-engine";
import {
  createPendingBenchmarkResultSet,
  failBenchmarkResultSet,
} from "../lib/benchmark/certified/result-set-publication";
import { getGameIqScenarioPack } from "../lib/benchmark/gameiq";
import { runCertifiedGameIq } from "../lib/benchmark/gameiq/certified-runner";
import {
  STATEFUL_REFERENCE_TRANSCRIPTS,
  TOOL_RELIABILITY_CASES,
} from "../lib/benchmark/toolreliability";
import { runCertifiedToolReliability } from "../lib/benchmark/toolreliability/certified-runner";
import {
  runCertifiedTeamIq,
  deriveTeamComposition,
} from "../lib/benchmark/teamiq";
import { runCertifiedFireworksTeamIq } from "../lib/benchmark/fireworks/certified-runner";
import {
  FIREWORKS_TACTICS_SCENARIOS,
  fireworksCaseToBenchmarkCaseV2,
} from "../lib/benchmark/fireworks/scenario-packs";
import type {
  BenchmarkCaseV2,
  BenchmarkTeamComposition,
  BenchmarkTrack,
} from "../lib/benchmark/types";
import type { CertifiedRetryRuntime } from "../lib/benchmark/certified/retry-policy";
import type { SelectedModel, StreamChunk } from "../lib/providers/base";

const now = "2026-07-29T10:00:00.000Z";
const retryRuntime: CertifiedRetryRuntime = {
  now: () => Date.parse(now),
  random: () => 0.5,
  sleep: async () => {},
};
const certification = {
  ...runHarnessCertification("raw-single-model"),
  passed: true,
};

function caseRecord(id: string, track: BenchmarkTrack): BenchmarkCaseV2 {
  return {
    id,
    schemaVersion: 2,
    track,
    title: id,
    description: "Retry accounting execution fixture.",
    difficulty: "easy",
    tags: ["retry-accounting"],
    caseVersion: "1",
    createdAt: now,
    updatedAt: now,
    prompt: { userRequest: "Execute the fixture." },
    environment: { type: "browser", timeoutSeconds: 60, network: "none" },
    verifier: { scorer: "rule-checker" },
    budget: { maxUsd: 10, maxModelCalls: 1_000 },
    scoring: {
      scoringVersion: "retry-accounting-v1",
      primary:
        track === "gameiq"
          ? "game_iq"
          : track === "toolreliability"
            ? "tool_reliability"
            : "team_lift",
    },
    contamination: {
      originalTask: true,
      canary: `AIBENCH-${id}`,
      referenceSolutionPrivate: true,
    },
  };
}

function soloTeam(id: string, modelId: string): BenchmarkTeamComposition {
  return {
    id,
    name: id,
    comboHash: `combo:${id}`,
    roles: [
      {
        role: "single",
        slot: "single",
        modelId,
        providerId: "openai",
        displayName: modelId,
        temperature: 0,
      },
    ],
  };
}

function flakyStream(success: (physicalCall: number) => string) {
  let physicalCalls = 0;
  const stream = async function* (): AsyncIterable<StreamChunk> {
    physicalCalls++;
    yield {
      type: "usage",
      usage: { inputTokens: physicalCalls * 10, outputTokens: physicalCalls },
    };
    if (physicalCalls === 1) {
      yield {
        type: "error",
        error: "temporary",
        errorMetadata: { statusCode: 503 },
      };
      return;
    }
    yield { type: "token", content: success(physicalCalls) };
    yield { type: "done" };
  };
  return { stream, calls: () => physicalCalls };
}

async function persistedAttempt(runId: string) {
  const attempt = (await listBenchmarkAttemptsV2()).find(
    (candidate) => candidate.runId === runId,
  );
  assert.ok(attempt, `${runId} must persist an attempt`);
  return attempt;
}

__resetBenchmarkStoreForTests();

// GameIQ: real scenario execution, first physical call fails, retry succeeds.
{
  const pack = getGameIqScenarioPack("connect-four");
  assert.ok(pack);
  const model: SelectedModel = {
    modelId: "openai:retry-gameiq",
    providerId: "openai",
    displayName: "Retry GameIQ",
  };
  const team = soloTeam("team-retry-gameiq", model.modelId);
  await saveBenchmarkCaseV2(caseRecord(pack.id, "gameiq"));
  await saveBenchmarkTeamComposition(team);
  let scenarioIndex = 0;
  const flaky = flakyStream(() =>
    JSON.stringify({
      action: pack.scenarios[scenarioIndex++]?.expectedActions[0]?.action,
    }),
  );
  await runCertifiedBenchmark({
    runId: "run-retry-gameiq",
    suiteId: "suite-retry-gameiq",
    track: "gameiq",
    harnessProfile: "raw-single-model",
    caseIds: [pack.id],
    teamCompositionIds: [team.id],
    certification,
    runner: (context) =>
      runCertifiedGameIq({
        context,
        models: [model],
        scenarioPackIds: [pack.id],
        teamCompositionIds: [team.id],
        teamCompositions: [team],
        trials: 1,
        retryDelaysMs: [0],
        retryRuntime,
        streamChat: flaky.stream,
      }),
  });
  const attempt = await persistedAttempt("run-retry-gameiq");
  assert.equal(attempt.modelCalls, flaky.calls());
  assert.equal(attempt.traceIds.length, flaky.calls());
  assert.equal(
    attempt.inputTokens,
    ((flaky.calls() * (flaky.calls() + 1)) / 2) * 10,
  );
  console.log("PASS GameIQ persists fail-then-success physical usage");
}

// GameIQ contains a terminal scenario failure and must still account for all
// three exhausted physical attempts before continuing the remaining pack.
{
  const pack = getGameIqScenarioPack("connect-four");
  assert.ok(pack);
  const model: SelectedModel = {
    modelId: "openai:retry-gameiq-terminal",
    providerId: "openai",
    displayName: "Retry GameIQ Terminal",
  };
  const team = soloTeam("team-retry-gameiq-terminal", model.modelId);
  await saveBenchmarkTeamComposition(team);
  let physicalCalls = 0;
  await runCertifiedBenchmark({
    runId: "run-retry-gameiq-terminal",
    suiteId: "suite-retry-gameiq-terminal",
    track: "gameiq",
    harnessProfile: "raw-single-model",
    caseIds: [pack.id],
    teamCompositionIds: [team.id],
    certification,
    runner: (context) =>
      runCertifiedGameIq({
        context,
        models: [model],
        scenarioPackIds: [pack.id],
        teamCompositionIds: [team.id],
        teamCompositions: [team],
        trials: 1,
        retryDelaysMs: [0, 0],
        retryRuntime,
        streamChat: async function* (): AsyncIterable<StreamChunk> {
          physicalCalls++;
          yield { type: "usage", usage: { inputTokens: 5, outputTokens: 1 } };
          if (physicalCalls <= 3) {
            yield {
              type: "error",
              error: "temporary",
              errorMetadata: { statusCode: 503 },
            };
            return;
          }
          yield { type: "token", content: "{}" };
          yield { type: "done" };
        },
      }),
  });
  const attempt = await persistedAttempt("run-retry-gameiq-terminal");
  assert.equal(attempt.modelCalls, physicalCalls);
  assert.equal(attempt.traceIds.length, physicalCalls);
  assert.equal(attempt.inputTokens, physicalCalls * 5);
  console.log(
    "PASS GameIQ terminal scenario exhaustion preserves physical usage",
  );
}

// ToolReliability: real stateful environment execution.
{
  const benchmarkCase = TOOL_RELIABILITY_CASES[0]!;
  const outputs = STATEFUL_REFERENCE_TRANSCRIPTS[benchmarkCase.id]!;
  const model: SelectedModel = {
    modelId: "openai:retry-toolrel",
    providerId: "openai",
    displayName: "Retry ToolRel",
  };
  const team = soloTeam("team-retry-toolrel", model.modelId);
  const caseId = "retry-toolrel-case";
  await saveBenchmarkCaseV2(caseRecord(caseId, "toolreliability"));
  await saveBenchmarkTeamComposition(team);
  let outputIndex = 0;
  const flaky = flakyStream(() => outputs[outputIndex++] ?? "{}");
  await runCertifiedBenchmark({
    runId: "run-retry-toolrel",
    suiteId: "suite-retry-toolrel",
    track: "toolreliability",
    harnessProfile: "raw-single-model",
    caseIds: [caseId],
    teamCompositionIds: [team.id],
    certification,
    runner: (context) =>
      runCertifiedToolReliability({
        context,
        models: [model],
        teamCompositionIds: [team.id],
        teamCompositions: [team],
        casePack: [benchmarkCase],
        retryDelaysMs: [0],
        retryRuntime,
        streamChat: flaky.stream,
      }),
  });
  const attempt = await persistedAttempt("run-retry-toolrel");
  assert.equal(attempt.modelCalls, flaky.calls());
  assert.equal(attempt.traceIds.length, flaky.calls());
  console.log("PASS ToolReliability persists fail-then-success physical usage");
}

// TeamIQ: real team turn execution over the same stateful substrate.
{
  const benchmarkCase = TOOL_RELIABILITY_CASES[0]!;
  const outputs = STATEFUL_REFERENCE_TRANSCRIPTS[benchmarkCase.id]!;
  const team = deriveTeamComposition({
    name: "Retry TeamIQ Solo",
    roles: [
      {
        role: "single",
        slot: "single",
        modelId: "openai:retry-teamiq",
        providerId: "openai",
        displayName: "Retry TeamIQ",
        temperature: 0,
      },
    ],
  });
  const caseId = "retry-teamiq-case";
  await saveBenchmarkCaseV2(caseRecord(caseId, "teamiq"));
  await saveBenchmarkTeamComposition(team);
  let outputIndex = 0;
  const flaky = flakyStream(() => outputs[outputIndex++] ?? "{}");
  await runCertifiedBenchmark({
    runId: "run-retry-teamiq",
    suiteId: "suite-retry-teamiq",
    track: "teamiq",
    harnessProfile: "raw-single-model",
    caseIds: [caseId],
    teamCompositionIds: [team.id],
    certification,
    runner: (context) =>
      runCertifiedTeamIq({
        context,
        teamCompositions: [team],
        task: { kind: "toolreliability", casePack: [benchmarkCase] },
        includeSoloBaselines: false,
        retryDelaysMs: [0],
        retryRuntime,
        streamChat: flaky.stream,
      }),
  });
  const attempt = await persistedAttempt("run-retry-teamiq");
  assert.equal(attempt.modelCalls, flaky.calls());
  assert.equal(attempt.traceIds.length, flaky.calls());
  console.log("PASS TeamIQ persists fail-then-success physical usage");
}

// Fireworks: real rules/scoring execution with one tactical scenario.
{
  const scenario = FIREWORKS_TACTICS_SCENARIOS[0]!;
  const team = deriveTeamComposition({
    name: "Retry Fireworks Duo",
    roles: ["P1", "P2"].map((slot) => ({
      role: "player",
      slot,
      modelId: `openai:retry-fireworks-${slot.toLowerCase()}`,
      providerId: "openai",
      displayName: `Retry Fireworks ${slot}`,
      temperature: 0,
    })),
  });
  const caseV2 = fireworksCaseToBenchmarkCaseV2(
    "retry-fireworks-case",
    "tactics",
  );
  await saveBenchmarkCaseV2(caseV2);
  await saveBenchmarkTeamComposition(team);
  const flaky = flakyStream(() => '{"action":"play","cardIndex":0}');
  await runCertifiedBenchmark({
    runId: "run-retry-fireworks",
    suiteId: "suite-retry-fireworks",
    track: "teamiq",
    harnessProfile: "raw-single-model",
    caseIds: [caseV2.id],
    teamCompositionIds: [team.id],
    certification,
    runner: (context) =>
      runCertifiedFireworksTeamIq({
        context,
        teamCompositions: [team],
        cases: [scenario],
        includeSoloBaselines: false,
        retryDelaysMs: [0],
        retryRuntime,
        streamChat: flaky.stream,
      }),
  });
  const attempt = await persistedAttempt("run-retry-fireworks");
  assert.equal(attempt.modelCalls, flaky.calls());
  assert.equal(attempt.traceIds.length, flaky.calls());
  console.log("PASS Fireworks persists fail-then-success physical usage");
}

// Fireworks contains provider errors with a deterministic gameplay fallback;
// terminal recovery still counts three model calls while applying one fallback.
{
  const scenario = FIREWORKS_TACTICS_SCENARIOS[0]!;
  const team = deriveTeamComposition({
    name: "Retry Fireworks Terminal",
    roles: ["P1", "P2"].map((slot) => ({
      role: "player",
      slot,
      modelId: `openai:retry-fireworks-terminal-${slot.toLowerCase()}`,
      providerId: "openai",
      displayName: `Retry Fireworks Terminal ${slot}`,
      temperature: 0,
    })),
  });
  const caseV2 = fireworksCaseToBenchmarkCaseV2(
    "retry-fireworks-terminal-case",
    "tactics",
  );
  await saveBenchmarkCaseV2(caseV2);
  await saveBenchmarkTeamComposition(team);
  let physicalCalls = 0;
  await runCertifiedBenchmark({
    runId: "run-retry-fireworks-terminal",
    suiteId: "suite-retry-fireworks-terminal",
    track: "teamiq",
    harnessProfile: "raw-single-model",
    caseIds: [caseV2.id],
    teamCompositionIds: [team.id],
    certification,
    runner: (context) =>
      runCertifiedFireworksTeamIq({
        context,
        teamCompositions: [team],
        cases: [scenario],
        includeSoloBaselines: false,
        retryDelaysMs: [0, 0],
        retryRuntime,
        streamChat: async function* (): AsyncIterable<StreamChunk> {
          physicalCalls++;
          yield { type: "usage", usage: { inputTokens: 9, outputTokens: 1 } };
          yield {
            type: "error",
            error: "temporary",
            errorMetadata: { statusCode: 503 },
          };
        },
      }),
  });
  const attempt = await persistedAttempt("run-retry-fireworks-terminal");
  assert.equal(physicalCalls, 3);
  assert.equal(attempt.modelCalls, 3);
  assert.equal(attempt.traceIds.length, 3);
  assert.equal(attempt.inputTokens, 27);
  console.log("PASS Fireworks terminal exhaustion preserves physical usage");
}

// Terminal exhaustion: a failed, unpublished result set still owns all billed
// traces and its synthesized failed attempt totals every physical call.
{
  const benchmarkCase = TOOL_RELIABILITY_CASES[0]!;
  const model: SelectedModel = {
    modelId: "openai:retry-exhausted",
    providerId: "openai",
    displayName: "Retry Exhausted",
  };
  const team = soloTeam("team-retry-exhausted", model.modelId);
  const caseId = "retry-exhausted-case";
  const resultSetId = "result-set-retry-exhausted";
  await saveBenchmarkCaseV2(caseRecord(caseId, "toolreliability"));
  await saveBenchmarkTeamComposition(team);
  const manifest = await createPendingBenchmarkResultSet({
    id: resultSetId,
    schemaVersion: 1,
    executionId: "execution-retry-exhausted",
    anchorRunId: "run-retry-exhausted",
    runIds: ["run-retry-exhausted"],
    configurationKey: "retry-exhausted",
    configuration: {
      subjectKind: "model",
      displayName: model.displayName,
      providerId: model.providerId,
      modelId: model.modelId,
      roles: [],
      tracks: [
        {
          track: "toolreliability",
          suiteId: "suite-retry-exhausted",
          caseManifest: [
            {
              caseId,
              caseVersion: "1",
              scoringVersion: "retry-accounting-v1",
            },
          ],
          maxTokens: null,
        },
      ],
    },
    expectedAttempts: [
      {
        runId: "run-retry-exhausted",
        track: "toolreliability",
        suiteId: "suite-retry-exhausted",
        caseId,
        caseVersion: "1",
        scoringVersion: "retry-accounting-v1",
        teamCompositionId: team.id,
      },
    ],
  });
  let physicalCalls = 0;
  await runCertifiedBenchmark({
    runId: manifest.anchorRunId,
    suiteId: "suite-retry-exhausted",
    track: "toolreliability",
    harnessProfile: "raw-single-model",
    caseIds: [caseId],
    teamCompositionIds: [team.id],
    certification,
    resultSetOwnership: {
      defaultResultSetId: resultSetId,
      byTeamCompositionId: {},
    },
    runner: (context) =>
      runCertifiedToolReliability({
        context,
        models: [model],
        teamCompositionIds: [team.id],
        teamCompositions: [team],
        casePack: [benchmarkCase],
        retryDelaysMs: [0, 0],
        retryRuntime,
        streamChat: async function* (): AsyncIterable<StreamChunk> {
          physicalCalls++;
          yield {
            type: "usage",
            usage: { inputTokens: 7, outputTokens: 2 },
          };
          yield {
            type: "error",
            error: "temporary",
            errorMetadata: { statusCode: 503 },
          };
        },
      }),
  });
  await failBenchmarkResultSet(resultSetId, {
    kind: "provider",
    code: "retry_exhausted",
    message: "Provider retries exhausted.",
  });
  const attempt = await persistedAttempt(manifest.anchorRunId);
  const ownedTraces = (await listBenchmarkTraces()).filter(
    (trace) => trace.resultSetId === resultSetId,
  );
  const storedManifest = (await listBenchmarkResultSets()).find(
    (resultSet) => resultSet.id === resultSetId,
  );
  assert.equal(physicalCalls, 3);
  assert.equal(attempt.modelCalls, 3);
  assert.equal(attempt.inputTokens, 21);
  assert.equal(attempt.outputTokens, 6);
  assert.equal(ownedTraces.length, 3);
  assert.equal(storedManifest?.status, "failed");
  assert.equal(storedManifest?.metrics, undefined);
  console.log(
    "PASS terminal exhaustion persists unpublished result-set audit totals",
  );
}

console.log("PASS");
