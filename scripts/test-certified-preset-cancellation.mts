import assert from "node:assert/strict";
import { createServer, type ServerResponse } from "node:http";
import {
  DIRECT_MODEL_HARNESS,
  runPreset,
  runSelected,
  type PresetProgressEvent,
} from "../lib/benchmark/certified/run-execution";
import { BENCHMARK_PRESETS } from "../lib/benchmark/certified/run-presets";
import { installNativeBenchmarkTestTransport } from "./native-benchmark-test-support";
import { runHarnessCertification } from "../lib/benchmark/certified/certification";
import {
  __resetBenchmarkStoreForTests,
  __setAdapterForTests,
  listBenchmarkAttemptsV2,
  listBenchmarkCaseV2,
  listBenchmarkRuns,
  listBenchmarkResultSets,
  listBenchmarkTeamCompositions,
  listHarnessCertificationResults,
} from "../lib/benchmark/store";
import type { StorageAdapter } from "../lib/client/storage-adapter";
import {
  __resetClientStoreForTests,
  upsertProviderKey,
} from "../lib/client/store";
import { openaiProvider } from "../lib/providers/openai";
import type { SelectedModel, StreamChunk } from "../lib/providers/base";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

function deferredWriteAdapter(blockAtWrite: number): {
  adapter: StorageAdapter;
  entered: Promise<void>;
  release: () => void;
  writes: () => number;
} {
  const entered = deferred<void>();
  const gate = deferred<void>();
  let writes = 0;
  const write = async () => {
    writes++;
    if (writes !== blockAtWrite) return;
    entered.resolve();
    await gate.promise;
  };
  return {
    adapter: {
      kind: "indexeddb",
      load: async () => null,
      save: write,
      listDiscussionIds: async () => [],
      loadDiscussionFile: async () => null,
      saveDiscussionFile: async () => {},
      deleteDiscussionFile: async () => {},
      deleteDiscussion: async () => {},
      listBenchmarkRunIds: async () => [],
      loadBenchmarkRun: async () => null,
      saveBenchmarkRun: async () => write(),
      deleteBenchmarkRun: async () => {},
      label: () => "deferred certified persistence",
    },
    entered: entered.promise,
    release: () => gate.resolve(),
    writes: () => writes,
  };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  assert.fail("Timed out waiting for certified preset state.");
}

function configureStore(): void {
  __setAdapterForTests(null);
  __resetBenchmarkStoreForTests();
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

function selectedModel(name: string): SelectedModel {
  return {
    modelId: `openai:${name}`,
    providerId: "openai",
    displayName: name,
  };
}


const nativeTransport = installNativeBenchmarkTestTransport(true, { browser: true });
const nativeBuildForTests = nativeTransport.runBuild;

const toolReliabilityLeg = BENCHMARK_PRESETS.find(preset => preset.id === "model-iq")!.legs.find(
  (leg) => leg.track === "toolreliability"
)!;
const toolReliabilityPreset = {
  ...BENCHMARK_PRESETS.find(preset => preset.id === "model-iq")!,
  legs: [toolReliabilityLeg],
};

async function persistedFor(modelName: string) {
  const teams = await listBenchmarkTeamCompositions();
  const teamIds = new Set(
    teams
      .filter((team) =>
        team.roles.some((role) => role.modelId.endsWith(modelName))
      )
      .map((team) => team.id)
  );
  const runs = await listBenchmarkRuns();
  const attempts = await listBenchmarkAttemptsV2();
  return {
    teams: [...teamIds],
    runs: runs.filter((run) =>
      run.modelIds.some((modelId) => modelId.endsWith(modelName))
    ),
    attempts: attempts.filter((attempt) =>
      teamIds.has(attempt.teamCompositionId)
    ),
  };
}

async function assertNoCertifiedPersistence(): Promise<void> {
  assert.deepEqual(
    {
      teams: (await listBenchmarkTeamCompositions()).length,
      certifications: (await listHarnessCertificationResults()).length,
      cases: (await listBenchmarkCaseV2()).length,
      runs: (await listBenchmarkRuns()).length,
      attempts: (await listBenchmarkAttemptsV2()).length,
    },
    { teams: 0, certifications: 0, cases: 0, runs: 0, attempts: 0 }
  );
}

// The suite includes a browser case. A runner without that capability must be
// rejected before any model call or result persistence.
{
  configureStore();
  const noBrowser = installNativeBenchmarkTestTransport(true, { browser: false });
  const model = selectedModel("browser-unavailable");
  let message: string | null = null;
  let modelCalls = 0;
  const originalStreamChat = openaiProvider.streamChat;
  openaiProvider.streamChat = async function* (): AsyncIterable<StreamChunk> {
    modelCalls++;
    yield { type: "token", content: "unexpected" };
  };
  try {
    await runSelected({
      runNativeWorkBenchBuild: nativeBuildForTests,
      runSoloToolBench: nativeBuildForTests,
      selectedTrack: "toolreliability", suiteId: toolReliabilityLeg.suiteId,
      models: [model], modelId: model.modelId, teamModelIds: [], teamIqStrategy: "panel",
      includeSoloBaselines: true, workBenchModelIds: [], workBenchRoleMode: "solo",
      workBenchRunnerUrl: "http://native-benchmark.test", workBenchRunnerToken: "test",
      effectiveHarnessProfile: DIRECT_MODEL_HARNESS, certification: runHarnessCertification(DIRECT_MODEL_HARNESS),
      effortByModelId: {}, signal: new AbortController().signal, runAbortRef: { current: null },
      setRunning: () => {}, setRunPhase: () => {}, setSummary: () => {},
      setMessage: (next) => { message = next; }, onComplete: async () => {},
    });
    assert.match(message ?? "", /requires the runner browser/i);
    assert.equal(modelCalls, 0);
    await assertNoCertifiedPersistence();
  } finally {
    openaiProvider.streamChat = originalStreamChat;
    noBrowser.restore();
  }
  console.log("PASS browser-unavailable ToolBench refuses before persistence");
}

{
  configureStore();
  const model = selectedModel("pre-aborted-toolrel");
  const parent = new AbortController();
  const cancellation = new Error("cancel before Tool Reliability setup");
  parent.abort(cancellation);
  let providerCalls = 0;
  let message: string | null = null;
  const originalStreamChat = openaiProvider.streamChat;
  openaiProvider.streamChat = async function* (): AsyncIterable<StreamChunk> {
    providerCalls++;
    yield { type: "token", content: "{}" };
  };
  try {
    await runSelected({
      runNativeWorkBenchBuild: nativeBuildForTests,
      runSoloToolBench: nativeBuildForTests,
      selectedTrack: "toolreliability",
      suiteId: toolReliabilityLeg.suiteId,
      models: [model],
      modelId: model.modelId,
      teamModelIds: [],
      teamIqStrategy: "panel",
      includeSoloBaselines: true,
      workBenchModelIds: [],
      workBenchRoleMode: "solo",
      workBenchRunnerUrl: "http://native-benchmark.test",
      workBenchRunnerToken: "test",
      effectiveHarnessProfile: DIRECT_MODEL_HARNESS,
      certification: runHarnessCertification(DIRECT_MODEL_HARNESS),
      effortByModelId: {},
      signal: parent.signal,
      runAbortRef: { current: null },
      setRunning: () => {},
      setRunPhase: () => {},
      setSummary: () => {},
      setMessage: (next) => {
        message = next;
      },
      onComplete: async () => {},
    });
  } finally {
    openaiProvider.streamChat = originalStreamChat;
  }
  assert.equal(providerCalls, 0);
  assert.equal(message, cancellation.message);
  await assertNoCertifiedPersistence();
  console.log("PASS pre-aborted Tool Reliability persists and calls nothing");
}

for (const boundary of [
  { write: 1, name: "team", expected: { certifications: 0, cases: 0, runs: 0 } },
  { write: 2, name: "certification", expected: { cases: 0, runs: 0 } },
  { write: 3, name: "case", expected: { runs: 0 } },
  { write: 4, name: "run", expected: {} },
] as const) {
  configureStore();
  const model = selectedModel(`deferred-${boundary.name}`);
  const parent = new AbortController();
  const cancellation = new Error(
    `cancel during deferred ${boundary.name} persistence`
  );
  const persistence = deferredWriteAdapter(boundary.write);
  __setAdapterForTests(persistence.adapter);
  let providerCalls = 0;
  let message: string | null = null;
  const originalStreamChat = openaiProvider.streamChat;
  openaiProvider.streamChat = async function* (): AsyncIterable<StreamChunk> {
    providerCalls++;
    yield { type: "token", content: "{}" };
  };
  try {
    const pending = runSelected({
      runNativeWorkBenchBuild: nativeBuildForTests,
      runSoloToolBench: nativeBuildForTests,
      selectedTrack: "toolreliability",
      suiteId: toolReliabilityLeg.suiteId,
      models: [model],
      modelId: model.modelId,
      teamModelIds: [],
      teamIqStrategy: "panel",
      includeSoloBaselines: true,
      workBenchModelIds: [],
      workBenchRoleMode: "solo",
      workBenchRunnerUrl: "http://native-benchmark.test",
      workBenchRunnerToken: "test",
      effectiveHarnessProfile: DIRECT_MODEL_HARNESS,
      certification: runHarnessCertification(DIRECT_MODEL_HARNESS),
      effortByModelId: {},
      signal: parent.signal,
      runAbortRef: { current: null },
      setRunning: () => {},
      setRunPhase: () => {},
      setSummary: () => {},
      setMessage: (next) => {
        message = next;
      },
      onComplete: async () => {},
    });
    await persistence.entered;
    parent.abort(cancellation);
    persistence.release();
    await pending;
  } finally {
    persistence.release();
    __setAdapterForTests(null);
    openaiProvider.streamChat = originalStreamChat;
  }
  const actual = {
    certifications: (await listHarnessCertificationResults()).length,
    cases: (await listBenchmarkCaseV2()).length,
    runs: (await listBenchmarkRuns()).length,
  };
  assert.equal(providerCalls, 0);
  assert.equal(message, cancellation.message);
  assert.deepEqual(
    Object.fromEntries(
      Object.keys(boundary.expected).map((key) => [
        key,
        actual[key as keyof typeof actual],
      ])
    ),
    boundary.expected
  );
  assert.equal((await listBenchmarkAttemptsV2()).length, 0);
  console.log(
    `PASS cancellation at deferred ${boundary.name} persistence admits no later boundary`
  );
}


// Removing parent-to-child signal linking makes this fail: only the child
// currently stored in the shared ref aborts and the queued fifth model starts.
{
  configureStore();
  const models = Array.from({ length: 5 }, (_, index) =>
    selectedModel(`toolrel-${index + 1}`)
  );
  const parent = new AbortController();
  const cancellation = new Error("cancel every Tool Reliability descendant");
  const startedModels = new Set<string>();
  const abortedModels = new Set<string>();
  const activeSignals: AbortSignal[] = [];
  const gates = new Map<string, ReturnType<typeof deferred<void>>>();
  const progress: PresetProgressEvent[] = [];
  const originalStreamChat = openaiProvider.streamChat;
  openaiProvider.streamChat = async function* (params): AsyncIterable<StreamChunk> {
    startedModels.add(params.model);
    assert.ok(params.signal);
    activeSignals.push(params.signal);
    const gate = deferred<void>();
    gates.set(params.model, gate);
    const abort = () => {
      abortedModels.add(params.model);
      gate.reject(params.signal?.reason);
    };
    params.signal?.addEventListener("abort", abort, { once: true });
    try {
      await gate.promise;
      yield { type: "token", content: "done" };
      yield { type: "done" };
    } finally {
      params.signal?.removeEventListener("abort", abort);
    }
  };
  try {
    const pending = runPreset(
      toolReliabilityPreset,
      {
        models,
        runNativeWorkBenchBuild: nativeBuildForTests,
        runSoloToolBench: nativeBuildForTests,
        soloModelIds: models.map((model) => model.modelId),
        effortByModelId: {},
        teamModelIds: [],
        teamIqStrategy: "panel",
        workBenchRoleMode: "solo",
        workBenchRunnerUrl: "http://native-benchmark.test",
        workBenchRunnerToken: "test",
        signal: parent.signal,
        onComplete: async () => {},
      },
      (event) => progress.push(event)
    );
    await waitFor(() => startedModels.size === 4);
    parent.abort(cancellation);
    await pending;
  } finally {
    openaiProvider.streamChat = originalStreamChat;
    for (const gate of gates.values()) gate.resolve();
  }

  assert.deepEqual([...abortedModels].sort(), [
    "toolrel-1",
    "toolrel-2",
    "toolrel-3",
    "toolrel-4",
  ]);
  assert.equal(activeSignals.length, 4);
  assert.ok(
    activeSignals.every(
      (signal) => signal.aborted && signal.reason === cancellation
    )
  );
  assert.equal(startedModels.has("toolrel-5"), false);
  const fifth = await persistedFor("toolrel-5");
  assert.equal(fifth.teams.length, 0);
  assert.equal(fifth.runs.length, 0);
  assert.equal(fifth.attempts.length, 0);
  assert.equal(
    progress.some(
      (event) =>
        event.type === "model" &&
        event.modelId.endsWith("toolrel-5") &&
        event.status === "cancelled"
    ),
    true
  );
  assert.equal(
    (await listBenchmarkResultSets()).some(
      (resultSet) => resultSet.status === "pending"
    ),
    false
  );
  console.log("PASS preset cancellation aborts four active children and never admits the fifth");
}

// A child failure must remain isolated: parent cancellation is the only event
// that may fan out to sibling signals.
{
  configureStore();
  const models = Array.from({ length: 5 }, (_, index) =>
    selectedModel(`isolated-${index + 1}`)
  );
  const parent = new AbortController();
  const abortedModels = new Set<string>();
  const progress: PresetProgressEvent[] = [];
  const originalStreamChat = openaiProvider.streamChat;
  openaiProvider.streamChat = async function* (params): AsyncIterable<StreamChunk> {
    const abort = () => abortedModels.add(params.model);
    params.signal?.addEventListener("abort", abort, { once: true });
    try {
      if (params.model === "isolated-1") {
        throw new Error("isolated provider failure");
      }
      yield { type: "token", content: "done" };
      yield { type: "done" };
    } finally {
      params.signal?.removeEventListener("abort", abort);
    }
  };
  try {
    await runPreset(
      toolReliabilityPreset,
      {
        models,
        runNativeWorkBenchBuild: nativeBuildForTests,
        runSoloToolBench: nativeBuildForTests,
        soloModelIds: models.map((model) => model.modelId),
        effortByModelId: {},
        teamModelIds: [],
        teamIqStrategy: "panel",
        workBenchRoleMode: "solo",
        workBenchRunnerUrl: "http://native-benchmark.test",
        workBenchRunnerToken: "test",
        signal: parent.signal,
        onComplete: async () => {},
      },
      (event) => progress.push(event)
    );
  } finally {
    openaiProvider.streamChat = originalStreamChat;
  }
  assert.equal(parent.signal.aborted, false);
  assert.deepEqual([...abortedModels], []);
  const failedModelProgress = progress.find(
    (event) =>
      event.type === "model" &&
      event.modelId.endsWith("isolated-1") &&
      event.status === "failed"
  );
  assert.equal(
    failedModelProgress?.detail,
    "Certified provider request failed temporarily."
  );
  assert.doesNotMatch(failedModelProgress?.detail ?? "", /completed|success/i);
  for (const model of models.slice(1)) {
    assert.equal(
      progress.some(
        (event) =>
          event.type === "model" &&
          event.modelId === model.modelId &&
          event.status === "passed"
      ),
      true,
      JSON.stringify(progress.filter(event => event.type === "model"))
    );
  }
  assert.equal(
    (await listBenchmarkResultSets()).some(
      (resultSet) => resultSet.status === "pending"
    ),
    false
  );
  assert.equal(
    new Set((await listBenchmarkResultSets()).map((set) => set.executionId)).size,
    1,
    "every independently published subject in one preset launch shares its execution ID"
  );
  console.log("PASS one Tool Reliability provider failure does not abort siblings");
}

// Removing the post-health signal check admits WorkBench persistence and POSTs
// after an explicit cancellation that happened while health was in flight.
{
  configureStore();
  const model = selectedModel("workbench-health");
  const parent = new AbortController();
  const healthGate = deferred<void>();
  const progress: PresetProgressEvent[] = [];
  let healthRequests = 0;
  let healthSocketClosed = false;
  let workBenchPostRequests = 0;
  let unexpectedRoute: string | null = null;
  const healthyRunnerV2Response = {
    ok: true,
    version: "test",
    runnerV2: { ready: true },
  };
  const server = createServer(async (request, response) => {
    if (request.url !== "/bench/health" || request.method !== "GET") {
      workBenchPostRequests++;
      unexpectedRoute = `${request.method} ${request.url}`;
      sendJson(response, 500, { error: `unexpected route ${unexpectedRoute}` });
      return;
    }
    healthRequests++;
    request.on("aborted", () => {
      healthSocketClosed = true;
    });
    response.on("close", () => {
      if (!response.writableEnded) healthSocketClosed = true;
    });
    await healthGate.promise;
    if (!response.destroyed) sendJson(response, 200, healthyRunnerV2Response);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const workBenchLeg = { track: "workbench" as const, suiteId: "workbench-native-smoke-v1", mode: "team" as const, requires: "bench-runner" as const };
  const workBenchPreset = {
    ...BENCHMARK_PRESETS[2]!,
    legs: [workBenchLeg],
  };
  try {
    const pending = runPreset(
      workBenchPreset,
      {
        models: [model],
        soloModelIds: [],
        effortByModelId: {},
        teamModelIds: [model.modelId],
        teamIqStrategy: "panel",
        workBenchRoleMode: "solo",
        workBenchRunnerUrl: `http://127.0.0.1:${address.port}`,
        workBenchRunnerToken: "test-token",
        signal: parent.signal,
        onComplete: async () => {},
      },
      (event) => progress.push(event)
    );
    await waitFor(() => healthRequests === 1);
    parent.abort(new Error("cancel during runner health"));
    await waitFor(() => healthSocketClosed);
    healthGate.resolve();
    await pending;
  } finally {
    healthGate.resolve();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    );
  }
  const teams = await listBenchmarkTeamCompositions();
  const runs = await listBenchmarkRuns();
  assert.equal(workBenchPostRequests, 0, unexpectedRoute ?? undefined);
  assert.equal(healthSocketClosed, true);
  assert.equal(teams.length, 0);
  assert.equal(runs.length, 0);
  assert.equal(
    progress.some(
      (event) =>
        event.type === "leg" &&
        event.leg.track === "workbench" &&
        event.status === "skipped" &&
        event.detail === "Cancelled."
    ),
    true
  );
  console.log("PASS cancellation during WorkBench health prevents leg admission");
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload),
  });
  response.end(payload);
}

nativeTransport.restore();
