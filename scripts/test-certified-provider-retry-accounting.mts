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
import {
  STATEFUL_REFERENCE_TRANSCRIPTS,
  TOOL_RELIABILITY_CASES,
} from "../lib/benchmark/toolreliability";
import { runCertifiedToolReliability } from "../lib/benchmark/toolreliability/certified-runner";
import {
  runCertifiedTeamIq,
  deriveTeamComposition,
} from "../lib/benchmark/teamiq";
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
      primary: track === "toolreliability" ? "tool_reliability" : "team_lift",
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
