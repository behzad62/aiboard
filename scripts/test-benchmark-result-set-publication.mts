import assert from "node:assert/strict";
import {
  __clearClientStoreForTests,
  __resetBenchmarkStoreForTests,
  listBenchmarkResultSets,
  listBenchmarkRuns,
  saveBenchmarkAttemptV2,
  saveBenchmarkCaseV2,
  saveBenchmarkRun,
  saveBenchmarkResultSet,
  saveBenchmarkToolCallTrace,
  saveBenchmarkTrace,
  saveBenchmarkVerifierResult,
} from "../lib/benchmark/store";
import {
  cancelBenchmarkResultSet,
  createPendingBenchmarkResultSet,
  failBenchmarkResultSet,
  publishBenchmarkResultSetAfterRuns,
  publishBenchmarkResultSetIfComplete,
  reconcileStaleBenchmarkResultSets,
} from "../lib/benchmark/certified/result-set-publication";
import {
  DIRECT_MODEL_HARNESS,
  runGameIqMultiModel,
  runPreset,
  type PresetProgressEvent,
} from "../lib/benchmark/certified/run-execution";
import { getGameIqScenarioPackById } from "../lib/benchmark/gameiq";
import { runHarnessCertification } from "../lib/benchmark/certified/certification";
import type { BenchmarkPreset } from "../lib/benchmark/certified/run-presets";
import { upsertProviderKey } from "../lib/client/store";
import { openaiProvider } from "../lib/providers/openai";
import type { StreamChunk } from "../lib/providers/base";
import { refreshBenchmarkDashboardStorage } from "../components/benchmark/useBenchmarkDashboard";
import { certifiedTabRunCoordinator } from "../lib/benchmark/certified/run-session";
import type {
  BenchmarkAttemptV2,
  BenchmarkCaseV2,
  BenchmarkExpectedResultAttempt,
  BenchmarkResultConfiguration,
  BenchmarkRun,
  BenchmarkVerifierResult,
} from "../lib/benchmark/types";

const now = "2026-07-29T10:00:00.000Z";
const configuration: BenchmarkResultConfiguration = {
  subjectKind: "model",
  displayName: "Luna",
  providerId: "test",
  modelId: "luna",
  reasoningEffort: "medium",
  roles: [],
  tracks: [],
};

function expected(
  runId: string,
  track: BenchmarkExpectedResultAttempt["track"],
  caseId: string,
  teamCompositionId = "solo-luna"
): BenchmarkExpectedResultAttempt {
  return {
    runId,
    track,
    suiteId: `suite-${track}`,
    caseId,
    caseVersion: "case-v1",
    scoringVersion: "score-v1",
    teamCompositionId,
  };
}

function run(id: string, track: string): BenchmarkRun {
  return {
    id,
    suiteId: `suite-${track}`,
    name: id,
    domain: "model-call",
    status: "running",
    startedAt: now,
    source: "manual",
    modelIds: ["luna"],
    caseIds: [],
    summaryJson: JSON.stringify({ mode: "certified", track }),
    metricValueIds: [],
    artifactIds: [],
    failureIds: [],
    resultSetIds: [],
  };
}

function benchmarkCase(
  id: string,
  track: BenchmarkCaseV2["track"]
): BenchmarkCaseV2 {
  return {
    id,
    schemaVersion: 2,
    track,
    title: id,
    description: id,
    difficulty: "easy",
    tags: [],
    caseVersion: "case-v1",
    createdAt: now,
    updatedAt: now,
    prompt: { userRequest: id },
    environment: {
      type: "browser",
      timeoutSeconds: 30,
      network: "none",
    },
    verifier: {
      scorer: "rule-checker",
    },
    budget: {},
    scoring: { scoringVersion: "score-v1", primary: "verified_quality" },
    contamination: {
      originalTask: true,
      canary: `canary-${id}`,
      referenceSolutionPrivate: true,
    },
  };
}

function verifier(id: string, attemptId: string, resultSetId: string): BenchmarkVerifierResult {
  return {
    id,
    attemptId,
    caseId: attemptId.split(":")[1]!,
    passed: false,
    score: 0,
    durationMs: 1,
    resultJson: "{}",
    assertionResults: [],
    artifactIds: [],
    resultSetId,
  };
}

function attempt(
  id: string,
  item: BenchmarkExpectedResultAttempt,
  resultSetId: string,
  score = 0
): BenchmarkAttemptV2 {
  return {
    id,
    runId: item.runId,
    caseId: item.caseId,
    teamCompositionId: item.teamCompositionId,
    mode: "certified",
    track: item.track,
    harnessProfile: "raw-single-model",
    status: score > 0 ? "passed" : "failed_model",
    startedAt: now,
    completedAt: now,
    verifiedQuality: score / 100,
    jobSuccessScore: score,
    efficiencyScore: score,
    costUsd: null,
    inputTokens: 1,
    outputTokens: 1,
    modelCalls: 1,
    toolCalls: 0,
    durationMs: 1,
    verifierResultId: `verifier:${id}`,
    artifactIds: [],
    traceIds: [],
    failureIds: [],
    harnessVersion: "h",
    promptSetVersion: "p",
    scoringVersion: item.scoringVersion,
    resultSetId,
  };
}

async function reset(): Promise<void> {
  __clearClientStoreForTests();
  __resetBenchmarkStoreForTests();
}

async function saveEvidence(
  item: BenchmarkExpectedResultAttempt,
  resultSetId: string,
  score = 0
): Promise<void> {
  const id = `attempt:${item.caseId}:${item.track}`;
  const ownedRun = (await listBenchmarkRuns()).find(
    (candidate) => candidate.id === item.runId
  );
  if (ownedRun && !ownedRun.caseIds.includes(item.caseId)) {
    await saveBenchmarkRun({
      ...ownedRun,
      caseIds: [...ownedRun.caseIds, item.caseId],
    });
  }
  await saveBenchmarkCaseV2(benchmarkCase(item.caseId, item.track));
  await saveBenchmarkVerifierResult(verifier(`verifier:${id}`, id, resultSetId));
  await saveBenchmarkAttemptV2(attempt(id, item, resultSetId, score));
}

await reset();
const zeroExpected = expected("run-zero", "gameiq", "zero");
await saveBenchmarkRun(run("run-zero", "gameiq"));
const zeroSet = await createPendingBenchmarkResultSet({
  id: "zero",
  schemaVersion: 1,
  executionId: "execution-zero",
  anchorRunId: "run-zero",
  runIds: ["run-zero"],
  configurationKey: "zero-key",
  configuration,
  expectedAttempts: [zeroExpected],
});
assert.equal(zeroSet.status, "pending");
await saveEvidence(zeroExpected, zeroSet.id, 0);
const publishedZero = await publishBenchmarkResultSetIfComplete(zeroSet.id);
assert.equal(publishedZero.status, "completed");
assert.equal(publishedZero.metrics?.overallScore, 0);

for (const traceKind of ["model", "tool"] as const) {
  await reset();
  const traceRunId = `run-incomplete-${traceKind}-trace`;
  const traceCaseId = `case-incomplete-${traceKind}-trace`;
  const traceResultSetId = `incomplete-${traceKind}-trace`;
  const traceExpected = expected(
    traceRunId,
    "toolreliability",
    traceCaseId
  );
  await saveBenchmarkRun(run(traceRunId, "toolreliability"));
  const traceSet = await createPendingBenchmarkResultSet({
    id: traceResultSetId,
    schemaVersion: 1,
    executionId: `execution-${traceResultSetId}`,
    anchorRunId: traceRunId,
    runIds: [traceRunId],
    configurationKey: `${traceResultSetId}-key`,
    configuration,
    expectedAttempts: [traceExpected],
  });
  await saveBenchmarkCaseV2(
    benchmarkCase(traceExpected.caseId, traceExpected.track)
  );
  await saveBenchmarkRun({
    ...(await listBenchmarkRuns())[0]!,
    caseIds: [traceExpected.caseId],
  });
  const traceAttemptId = `attempt:${traceExpected.caseId}:${traceExpected.track}`;
  await saveBenchmarkVerifierResult(
    verifier(
      `verifier:${traceAttemptId}`,
      traceAttemptId,
      traceResultSetId
    )
  );
  if (traceKind === "model") {
    await saveBenchmarkTrace({
      id: "incomplete-model-trace",
      runId: traceRunId,
      attemptId: traceAttemptId,
      modelId: "test:luna",
      providerId: "test",
      startedAt: now,
      retryHistory: [],
      resultSetId: traceResultSetId,
    });
  } else {
    await saveBenchmarkToolCallTrace({
      id: "incomplete-tool-trace",
      attemptId: traceAttemptId,
      caseId: traceExpected.caseId,
      toolName: "test-tool",
      status: "ok",
      startedAt: now,
      resultSetId: traceResultSetId,
    });
  }
  await saveBenchmarkAttemptV2({
    ...attempt(traceAttemptId, traceExpected, traceResultSetId, 100),
    traceIds: traceKind === "model" ? ["incomplete-model-trace"] : [],
  });
  await assert.rejects(
    publishBenchmarkResultSetIfComplete(traceSet.id),
    /trace|terminal|completed/i
  );
  assert.equal(
    (await listBenchmarkResultSets()).find((item) => item.id === traceSet.id)
      ?.status,
    "pending"
  );
}

await reset();
const game = expected("run-game", "gameiq", "game");
const tool = expected("run-tool", "toolreliability", "tool");
await saveBenchmarkRun(run("run-game", "gameiq"));
await saveBenchmarkRun({
  ...run("run-tool", "toolreliability"),
  caseIds: [tool.caseId],
});
await saveBenchmarkCaseV2(benchmarkCase(tool.caseId, tool.track));
const modelIq = await createPendingBenchmarkResultSet({
  id: "model-iq",
  schemaVersion: 1,
  executionId: "execution-model-iq",
  anchorRunId: "run-game",
  runIds: ["run-game", "run-tool"],
  configurationKey: "model-iq-key",
  configuration: {
    ...configuration,
    tracks: [
      { track: "gameiq", suiteId: "suite-gameiq", caseManifest: [], maxTokens: null },
      { track: "toolreliability", suiteId: "suite-toolreliability", caseManifest: [], maxTokens: null },
    ],
  },
  expectedAttempts: [game, tool],
});
await saveEvidence(game, modelIq.id, 75);
await assert.rejects(
  publishBenchmarkResultSetIfComplete(modelIq.id),
  /missing expected attempt/i
);
assert.equal((await listBenchmarkResultSets())[0]?.status, "pending");
await saveEvidence(tool, modelIq.id, 50);
assert.equal(
  (await publishBenchmarkResultSetIfComplete(modelIq.id)).status,
  "completed"
);

// A settled GameIQ leg may defer only the explicitly unstarted Tool
// Reliability run. Corrupt current-leg evidence must fail closed.
await reset();
const partialGame = expected("partial-game", "gameiq", "partial-game-case");
const futureTool = expected("future-tool", "toolreliability", "future-tool-case");
await saveBenchmarkRun(run(partialGame.runId, "gameiq"));
await saveBenchmarkRun(run(futureTool.runId, "toolreliability"));
const partialSet = await createPendingBenchmarkResultSet({
  id: "partial-valid",
  schemaVersion: 1,
  executionId: "execution-partial",
  anchorRunId: partialGame.runId,
  runIds: [partialGame.runId, futureTool.runId],
  configurationKey: "partial-valid-key",
  configuration,
  expectedAttempts: [partialGame, futureTool],
});
await saveEvidence(partialGame, partialSet.id, 75);
assert.equal(
  (
    await publishBenchmarkResultSetAfterRuns(partialSet.id, [
      partialGame.runId,
    ])
  ).status,
  "pending"
);

await reset();
const corruptGame = expected("corrupt-game", "gameiq", "corrupt-game-case");
const corruptFuture = expected("corrupt-tool", "toolreliability", "corrupt-tool-case");
await saveBenchmarkRun(run(corruptGame.runId, "gameiq"));
await saveBenchmarkRun(run(corruptFuture.runId, "toolreliability"));
const corruptSet = await createPendingBenchmarkResultSet({
  id: "partial-corrupt",
  schemaVersion: 1,
  executionId: "execution-partial-corrupt",
  anchorRunId: corruptGame.runId,
  runIds: [corruptGame.runId, corruptFuture.runId],
  configurationKey: "partial-corrupt-key",
  configuration,
  expectedAttempts: [corruptGame, corruptFuture],
});
await saveEvidence(corruptGame, corruptSet.id, 75);
await saveBenchmarkVerifierResult({
  ...verifier(
    `verifier:attempt:${corruptGame.caseId}:${corruptGame.track}`,
    "wrong-attempt",
    corruptSet.id
  ),
  caseId: corruptGame.caseId,
});
await assert.rejects(
  publishBenchmarkResultSetAfterRuns(corruptSet.id, [corruptGame.runId]),
  /verifier.*attempt/i
);

// Exact ownership/run-suite/verifier associations fail closed.
await reset();
const alienExpected = expected("alien-run", "gameiq", "alien-case");
await saveBenchmarkRun(run("anchor-run", "gameiq"));
await saveBenchmarkRun(run(alienExpected.runId, "gameiq"));
const alienSet = await createPendingBenchmarkResultSet({
  id: "alien",
  schemaVersion: 1,
  executionId: "execution-alien",
  anchorRunId: "anchor-run",
  runIds: ["anchor-run"],
  configurationKey: "alien-key",
  configuration,
  expectedAttempts: [alienExpected],
});
await saveEvidence(alienExpected, alienSet.id, 50);
await assert.rejects(
  publishBenchmarkResultSetIfComplete(alienSet.id),
  /run.*not owned/i
);

await reset();
const wrongSuiteExpected = expected("wrong-suite-run", "gameiq", "wrong-suite-case");
await saveBenchmarkRun({
  ...run(wrongSuiteExpected.runId, "gameiq"),
  suiteId: "suite-other",
});
const wrongSuiteSet = await createPendingBenchmarkResultSet({
  id: "wrong-suite",
  schemaVersion: 1,
  executionId: "execution-wrong-suite",
  anchorRunId: wrongSuiteExpected.runId,
  runIds: [wrongSuiteExpected.runId],
  configurationKey: "wrong-suite-key",
  configuration,
  expectedAttempts: [wrongSuiteExpected],
});
await saveEvidence(wrongSuiteExpected, wrongSuiteSet.id, 50);
await assert.rejects(
  publishBenchmarkResultSetIfComplete(wrongSuiteSet.id),
  /suite/i
);

await reset();
const wrongVerifierExpected = expected(
  "wrong-verifier-run",
  "gameiq",
  "wrong-verifier-case"
);
await saveBenchmarkRun(run(wrongVerifierExpected.runId, "gameiq"));
const wrongVerifierSet = await createPendingBenchmarkResultSet({
  id: "wrong-verifier",
  schemaVersion: 1,
  executionId: "execution-wrong-verifier",
  anchorRunId: wrongVerifierExpected.runId,
  runIds: [wrongVerifierExpected.runId],
  configurationKey: "wrong-verifier-key",
  configuration,
  expectedAttempts: [wrongVerifierExpected],
});
await saveEvidence(wrongVerifierExpected, wrongVerifierSet.id, 50);
await saveBenchmarkVerifierResult({
  ...verifier(
    `verifier:attempt:${wrongVerifierExpected.caseId}:${wrongVerifierExpected.track}`,
    `attempt:${wrongVerifierExpected.caseId}:${wrongVerifierExpected.track}`,
    wrongVerifierSet.id
  ),
  caseId: "different-case",
});
await assert.rejects(
  publishBenchmarkResultSetIfComplete(wrongVerifierSet.id),
  /verifier.*case/i
);

await reset();
for (const id of ["luna", "terra", "sol"]) {
  await saveBenchmarkRun(run(`run-${id}`, "gameiq"));
  const item = expected(`run-${id}`, "gameiq", `case-${id}`, `solo-${id}`);
  await createPendingBenchmarkResultSet({
    id,
    schemaVersion: 1,
    executionId: "execution-models",
    anchorRunId: item.runId,
    runIds: [item.runId],
    configurationKey: `${id}-key`,
    configuration: { ...configuration, displayName: id, modelId: id },
    expectedAttempts: [item],
  });
  if (id !== "sol") {
    await saveEvidence(item, id, id === "luna" ? 0 : 80);
    await publishBenchmarkResultSetIfComplete(id);
  }
}
await failBenchmarkResultSet("sol", {
  kind: "infrastructure",
  code: "provider_unavailable",
  message: "Sol provider unavailable.",
});
assert.deepEqual(
  (await listBenchmarkResultSets()).map(({ id, status }) => [id, status]),
  [["luna", "completed"], ["terra", "completed"], ["sol", "failed"]]
);
await cancelBenchmarkResultSet("luna", "late cancellation");
assert.equal(
  (await listBenchmarkResultSets()).find((item) => item.id === "luna")?.status,
  "completed"
);

await reset();
await saveBenchmarkRun(run("run-stale", "gameiq"));
const staleResultSet = await createPendingBenchmarkResultSet({
  id: "stale",
  schemaVersion: 1,
  executionId: "execution-stale",
  anchorRunId: "run-stale",
  runIds: ["run-stale"],
  configurationKey: "stale-key",
  configuration,
  expectedAttempts: [],
});
await saveBenchmarkResultSet({
  ...staleResultSet,
  createdAt: now,
});
assert.equal(
  await reconcileStaleBenchmarkResultSets({
    nowMs: Date.parse(now) + 25 * 60 * 60 * 1000,
    hasLiveTabRun: true,
  }),
  0
);
assert.equal(
  await reconcileStaleBenchmarkResultSets({
    nowMs: Date.parse(now) + 25 * 60 * 60 * 1000,
    hasLiveTabRun: false,
  }),
  1
);
assert.equal((await listBenchmarkResultSets())[0]?.status, "failed");

// Real Advanced orchestration: the pending manifest must be observable from
// inside the first provider admission, and honest failed_tool_use output still
// publishes as a complete scoreable subject.
await reset();
upsertProviderKey({
  providerId: "openai",
  apiKey: "test-key",
  defaultModel: null,
  enabled: true,
  keyHint: null,
  updatedAt: now,
});
let pendingObservedBeforeProvider = false;
const originalStreamChat = openaiProvider.streamChat;
openaiProvider.streamChat = async function* (): AsyncIterable<StreamChunk> {
  pendingObservedBeforeProvider ||= (await listBenchmarkResultSets()).some(
    (resultSet) => resultSet.status === "pending"
  );
  yield { type: "token", content: "{}" };
  yield { type: "done" };
};
try {
  await runGameIqMultiModel({
    models: [{
      modelId: "openai:advanced-publication",
      providerId: "openai",
      displayName: "Advanced publication",
    }],
    gameIqModelIds: ["openai:advanced-publication"],
    suiteId: "gameiq-v0.2-connect-four",
    fireworksPlayerCount: 2,
    certification: runHarnessCertification(DIRECT_MODEL_HARNESS),
    effortByModelId: {},
    runAbortRef: { current: null },
    setRunning: () => {},
    setRunPhase: () => {},
    setSummary: () => {},
    setMessage: () => {},
    setGameIqModelRuns: () => {},
    onComplete: async () => {},
  });
} finally {
  openaiProvider.streamChat = originalStreamChat;
}
assert.equal(pendingObservedBeforeProvider, true);
assert.deepEqual(
  (await listBenchmarkResultSets()).map((resultSet) => resultSet.status),
  ["completed"]
);

// Real Model IQ orchestration: a defect in the current GameIQ leg is an
// unpublished-infrastructure failure, not an "incomplete future leg". It must
// terminalize the subject and prevent the later paid Tool Reliability calls.
await reset();
upsertProviderKey({
  providerId: "openai",
  apiKey: "test-key",
  defaultModel: null,
  enabled: true,
  keyHint: null,
  updatedAt: now,
});
const modelIqPreset: BenchmarkPreset = {
  id: "model-iq",
  title: "Model IQ publication defect",
  description: "Publication validation containment fixture.",
  legs: [
    {
      track: "gameiq",
      suiteId: "gameiq-v0.2-connect-four",
      mode: "solo",
    },
    {
      track: "toolreliability",
      suiteId: "toolreliability-current-pack",
      mode: "solo",
    },
  ],
};
const modelIqProgress: PresetProgressEvent[] = [];
let modelIqProviderCalls = 0;
let injectedDuplicate = false;
openaiProvider.streamChat = async function* (): AsyncIterable<StreamChunk> {
  modelIqProviderCalls++;
  if (!injectedDuplicate) {
    const pending = (await listBenchmarkResultSets()).find(
      (resultSet) => resultSet.status === "pending"
    );
    const currentExpected = pending?.expectedAttempts.find(
      (item) => item.track === "gameiq"
    );
    assert.ok(pending);
    assert.ok(currentExpected);
    await saveBenchmarkAttemptV2(
      attempt(
        "injected-current-leg-duplicate",
        currentExpected,
        pending.id,
        0
      )
    );
    injectedDuplicate = true;
  }
  yield { type: "token", content: "{}" };
  yield { type: "done" };
};
try {
  await runPreset(
    modelIqPreset,
    {
      models: [{
        modelId: "openai:modeliq-publication",
        providerId: "openai",
        displayName: "Model IQ publication",
      }],
      soloModelIds: ["openai:modeliq-publication"],
      effortByModelId: {},
      teamModelIds: [],
      teamIqStrategy: "panel",
      workBenchRoleMode: "single",
      workBenchRunnerUrl: "",
      workBenchRunnerToken: "",
      fireworksPlayerCount: 2,
      signal: new AbortController().signal,
      onComplete: async () => {},
    },
    (event) => modelIqProgress.push(event)
  );
} finally {
  openaiProvider.streamChat = originalStreamChat;
}
const connectFourPack = getGameIqScenarioPackById("gameiq-v0.2-connect-four");
assert.ok(connectFourPack);
assert.equal(modelIqProviderCalls, connectFourPack.scenarios.length);
assert.equal((await listBenchmarkResultSets())[0]?.status, "failed");
assert.ok(
  modelIqProgress.some(
    (event) =>
      event.type === "model" &&
      event.leg.track === "gameiq" &&
      event.status === "failed" &&
      event.detail?.includes("Unpublished infrastructure failure")
  )
);
assert.ok(
  modelIqProgress.some(
    (event) =>
      event.type === "model" &&
      event.leg.track === "toolreliability" &&
      event.status === "failed" &&
      event.detail?.includes("Skipped after unpublished infrastructure failure")
  )
);

// Results/Data refresh owns stale reconciliation too, but must not interrupt a
// live same-tab execution.
await reset();
await saveBenchmarkRun(run("dashboard-stale-run", "gameiq"));
const dashboardStale = await createPendingBenchmarkResultSet({
  id: "dashboard-stale",
  schemaVersion: 1,
  executionId: "execution-dashboard-stale",
  anchorRunId: "dashboard-stale-run",
  runIds: ["dashboard-stale-run"],
  configurationKey: "dashboard-stale-key",
  configuration,
  expectedAttempts: [],
});
await saveBenchmarkResultSet({
  ...dashboardStale,
  createdAt: "2000-01-01T00:00:00.000Z",
});
let releaseLiveRun!: () => void;
const liveRun = new Promise<void>((resolve) => {
  releaseLiveRun = resolve;
});
assert.equal(
  certifiedTabRunCoordinator.tryStart("advanced", {}, async () => liveRun),
  true
);
await refreshBenchmarkDashboardStorage();
assert.equal((await listBenchmarkResultSets())[0]?.status, "pending");
releaseLiveRun();
for (let index = 0; index < 20; index++) {
  if (certifiedTabRunCoordinator.getSnapshot().owner === null) break;
  await new Promise((resolve) => setTimeout(resolve, 0));
}
await refreshBenchmarkDashboardStorage();
assert.equal((await listBenchmarkResultSets())[0]?.status, "failed");

console.log("PASS benchmark result-set publication");
