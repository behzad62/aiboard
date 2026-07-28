/* GameIQ aggregate provider-concurrency guard
 * (run: npx tsx scripts/test-gameiq-concurrency-budget.mts).
 *
 * Three ModelIQ models must never exceed eight simultaneous GameIQ calls:
 * two admitted model jobs, each fanning out to four scenario calls.
 */
import assert from "node:assert/strict";
import {
  DIRECT_MODEL_HARNESS,
  MAX_PARALLEL_GAMEIQ_MODELS,
  mapWithConcurrency,
  runGameIqMultiModel,
  runPreset,
  type GameIqModelRunState,
  type PresetProgressEvent,
} from "../lib/benchmark/certified/run-execution";
import { BENCHMARK_PRESETS } from "../lib/benchmark/certified/run-presets";
import { runHarnessCertification } from "../lib/benchmark/certified/certification";
import {
  __resetBenchmarkStoreForTests,
  listBenchmarkAttemptsV2,
  listBenchmarkRuns,
  listBenchmarkTeamCompositions,
} from "../lib/benchmark/store";
import {
  __resetClientStoreForTests,
  upsertProviderKey,
} from "../lib/client/store";
import { openaiProvider } from "../lib/providers/openai";
import type { SelectedModel, StreamChunk } from "../lib/providers/base";

const executionModule = (await import(
  "../lib/benchmark/certified/run-execution"
)) as typeof import("../lib/benchmark/certified/run-execution") & {
  MAX_PARALLEL_GAMEIQ_SCENARIOS_PER_MODEL: number;
};
const { MAX_PARALLEL_GAMEIQ_SCENARIOS_PER_MODEL } = executionModule;

interface Deferred {
  promise: Promise<void>;
  release: () => void;
}

function deferred(): Deferred {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("Timed out waiting for the GameIQ concurrency batch.");
}

const modelIds = ["model-a", "model-b", "model-c"];
const scenarioCount = MAX_PARALLEL_GAMEIQ_SCENARIOS_PER_MODEL ?? 4;
const modelGates = new Map<string, Deferred[]>();
let activePhysicalCalls = 0;
let peakPhysicalCalls = 0;
let startedModelJobs = 0;
let completedModelJobs = 0;

const runs = mapWithConcurrency(
  modelIds,
  MAX_PARALLEL_GAMEIQ_MODELS,
  async (modelId) => {
    startedModelJobs++;
    const gates = Array.from({ length: scenarioCount }, () => deferred());
    modelGates.set(modelId, gates);
    const scenarioCalls = gates.map(async (gate) => {
      activePhysicalCalls++;
      peakPhysicalCalls = Math.max(peakPhysicalCalls, activePhysicalCalls);
      await gate.promise;
      activePhysicalCalls--;
    });
    await Promise.all(scenarioCalls);
    completedModelJobs++;
  }
);

await waitFor(
  () => startedModelJobs === Math.min(MAX_PARALLEL_GAMEIQ_MODELS, modelIds.length)
);
const startedModelJobsBeforeFirstRelease = startedModelJobs;

for (const modelId of modelIds.slice(0, startedModelJobsBeforeFirstRelease)) {
  modelGates.get(modelId)!.forEach((gate) => gate.release());
}

await waitFor(() => completedModelJobs === startedModelJobsBeforeFirstRelease);
await waitFor(() => startedModelJobs === modelIds.length);

for (const modelId of modelIds.slice(startedModelJobsBeforeFirstRelease)) {
  modelGates.get(modelId)!.forEach((gate) => gate.release());
}
await runs;

assert.ok(
  peakPhysicalCalls <= 8,
  `three ModelIQ models opened ${peakPhysicalCalls} simultaneous GameIQ calls`
);
assert.equal(
  startedModelJobsBeforeFirstRelease,
  2,
  `expected two admitted models before release, got ${startedModelJobsBeforeFirstRelease}`
);
assert.equal(MAX_PARALLEL_GAMEIQ_SCENARIOS_PER_MODEL, 4);
assert.equal(completedModelJobs, 3);
console.log("PASS three ModelIQ models never exceed eight simultaneous GameIQ calls");

function selectedModel(suffix: string): SelectedModel {
  return {
    modelId: `openai:gpt-${suffix}`,
    providerId: "openai",
    displayName: `GPT ${suffix}`,
  };
}

function configureTestOpenAiKey(): void {
  __resetClientStoreForTests();
  upsertProviderKey({
    providerId: "openai",
    apiKey: "test-openai-key",
    defaultModel: null,
    enabled: true,
    keyHint: null,
    updatedAt: "2026-07-28T00:00:00.000Z",
  });
}

// Behavioral cancellation regression through the live GameIQ orchestration:
// cancelling a saturated two-worker batch must not admit the queued model.
{
  __resetBenchmarkStoreForTests();
  configureTestOpenAiKey();
  const models = [
    selectedModel("cancel-a"),
    selectedModel("cancel-b"),
    selectedModel("cancel-c"),
  ];
  const queuedModel = models[2]!;
  const originalStreamChat = openaiProvider.streamChat;
  const providerGates = new Map<string, Deferred>();
  const providerModels = new Set<string>();
  openaiProvider.streamChat = async function* (
    params
  ): AsyncIterable<StreamChunk> {
    providerModels.add(params.model);
    let gate = providerGates.get(params.model);
    if (!gate) {
      gate = deferred();
      providerGates.set(params.model, gate);
    }
    await gate.promise;
    yield { type: "token", content: "{}" };
    yield { type: "done" };
  };

  let visibleRuns: GameIqModelRunState[] = [];
  const visibleStatusHistory = new Map<string, GameIqModelRunState["status"][]>();
  const runAbortRef: { current: AbortController | null } = { current: null };
  const cancellationReason = "Cancelled from the three-model regression.";
  try {
    const pending = runGameIqMultiModel({
      models,
      gameIqModelIds: models.map((model) => model.modelId),
      suiteId: "gameiq-all-packs",
      fireworksPlayerCount: 2,
      certification: runHarnessCertification(DIRECT_MODEL_HARNESS),
      effortByModelId: {},
      runAbortRef,
      setRunning: () => {},
      setRunPhase: () => {},
      setSummary: () => {},
      setMessage: () => {},
      setGameIqModelRuns: (updater) => {
        visibleRuns =
          typeof updater === "function" ? updater(visibleRuns) : updater;
        for (const run of visibleRuns) {
          const history = visibleStatusHistory.get(run.modelId) ?? [];
          if (history.at(-1) !== run.status) history.push(run.status);
          visibleStatusHistory.set(run.modelId, history);
        }
      },
      onComplete: async () => {},
    });

    await waitFor(() => providerModels.size === MAX_PARALLEL_GAMEIQ_MODELS);
    assert.ok(runAbortRef.current, "GameIQ batch exposes its active abort controller");
    runAbortRef.current.abort(cancellationReason);
    for (const gate of providerGates.values()) gate.release();
    await pending;
  } finally {
    openaiProvider.streamChat = originalStreamChat;
    for (const gate of providerGates.values()) gate.release();
  }

  const teams = await listBenchmarkTeamCompositions();
  const durableRuns = await listBenchmarkRuns();
  const attempts = await listBenchmarkAttemptsV2();
  const queuedVisible = visibleRuns.find(
    (run) => run.modelId === queuedModel.modelId
  );
  const queuedTeamIds = new Set(
    teams
      .filter((team) =>
        team.roles.some((role) => role.modelId === queuedModel.modelId)
      )
      .map((team) => team.id)
  );

  assert.deepEqual(
    {
      visibleStatuses: visibleStatusHistory.get(queuedModel.modelId),
      visibleReason: queuedVisible?.error,
      everyCancelledRowRetainsReason: visibleRuns
        .filter((run) => run.status === "cancelled")
        .every((run) => run.error === cancellationReason),
      enteredProviderWork: providerModels.has("gpt-cancel-c"),
      persistedTeamCount: queuedTeamIds.size,
      persistedRun: durableRuns.some((run) =>
        run.modelIds.includes(queuedModel.modelId)
      ),
      persistedAttempt: attempts.some((attempt) =>
        queuedTeamIds.has(attempt.teamCompositionId)
      ),
    },
    {
      visibleStatuses: ["queued", "cancelled"],
      visibleReason: cancellationReason,
      everyCancelledRowRetainsReason: true,
      enteredProviderWork: false,
      persistedTeamCount: 0,
      persistedRun: false,
      persistedAttempt: false,
    },
    "cancelled queued model must terminate visibly without persistence or provider work"
  );
  console.log(
    "PASS cancelling two active GameIQ models never admits or persists the queued third model"
  );
}

// Tool Reliability uses the live preset-to-solo-leg mapping and must retain
// its own four-model worker cap rather than inheriting GameIQ's cap of two.
{
  __resetBenchmarkStoreForTests();
  configureTestOpenAiKey();
  const models = Array.from({ length: 5 }, (_, index) =>
    selectedModel(`toolrel-${index + 1}`)
  );
  const originalStreamChat = openaiProvider.streamChat;
  const gates = new Map<string, Deferred>();
  const startedModels = new Set<string>();
  const activeModels = new Set<string>();
  let peakActiveModels = 0;
  openaiProvider.streamChat = async function* (
    params
  ): AsyncIterable<StreamChunk> {
    startedModels.add(params.model);
    activeModels.add(params.model);
    peakActiveModels = Math.max(peakActiveModels, activeModels.size);
    let gate = gates.get(params.model);
    if (!gate) {
      gate = deferred();
      gates.set(params.model, gate);
    }
    try {
      await gate.promise;
      throw new Error("Invalid API key released by concurrency regression.");
    } finally {
      activeModels.delete(params.model);
    }
    yield { type: "done" };
  };

  const progress: PresetProgressEvent[] = [];
  const toolReliabilityLeg = BENCHMARK_PRESETS[0]!.legs.find(
    (leg) => leg.track === "toolreliability"
  )!;
  const toolReliabilityPreset = {
    ...BENCHMARK_PRESETS[0]!,
    legs: [toolReliabilityLeg],
  };
  try {
    const pending = runPreset(
      toolReliabilityPreset,
      {
        models,
        soloModelIds: models.map((model) => model.modelId),
        effortByModelId: {},
        teamModelIds: [],
        teamIqStrategy: "panel",
        workBenchRoleMode: "solo",
        workBenchRunnerUrl: "",
        workBenchRunnerToken: "",
        fireworksPlayerCount: 2,
        signal: new AbortController().signal,
        onComplete: async () => {},
      },
      (event) => progress.push(event)
    );

    await waitFor(() => startedModels.size === 4);
    const startedBeforeFirstRelease = startedModels.size;
    for (const gate of gates.values()) gate.release();
    await waitFor(() => startedModels.size === models.length);
    for (const gate of gates.values()) gate.release();
    await pending;

    assert.equal(
      startedBeforeFirstRelease,
      4,
      "Tool Reliability must admit four models before the first release"
    );
    assert.ok(
      peakActiveModels <= 4,
      `Tool Reliability admitted ${peakActiveModels} active model jobs`
    );
    assert.equal(
      progress.filter(
        (event) => event.type === "model" && event.status === "running"
      ).length,
      models.length,
      "all Tool Reliability models eventually enter the live solo leg"
    );
  } finally {
    openaiProvider.streamChat = originalStreamChat;
    for (const gate of gates.values()) gate.release();
  }
  console.log(
    "PASS Tool Reliability independently admits at most four model jobs"
  );
}
