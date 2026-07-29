import assert from "node:assert/strict";
import { createServer, type ServerResponse } from "node:http";
import {
  DIRECT_MODEL_HARNESS,
  runGameIqMultiModel,
  runPreset,
  runSelected,
  type GameIqModelRunState,
  type PresetProgressEvent,
} from "../lib/benchmark/certified/run-execution";
import { BENCHMARK_PRESETS } from "../lib/benchmark/certified/run-presets";
import { runHarnessCertification } from "../lib/benchmark/certified/certification";
import {
  __resetBenchmarkStoreForTests,
  __setAdapterForTests,
  listBenchmarkArtifacts,
  listBenchmarkAttemptsV2,
  listBenchmarkCaseV2,
  listBenchmarkFailures,
  listBenchmarkRunEvents,
  listBenchmarkRuns,
  listBenchmarkTeamCompositions,
  listBenchmarkToolCallTraces,
  listBenchmarkTraces,
  listBenchmarkVerifierResults,
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

const toolReliabilityLeg = BENCHMARK_PRESETS[0]!.legs.find(
  (leg) => leg.track === "toolreliability"
)!;
const toolReliabilityPreset = {
  ...BENCHMARK_PRESETS[0]!,
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
      selectedTrack: "toolreliability",
      suiteId: toolReliabilityLeg.suiteId,
      models: [model],
      modelId: model.modelId,
      teamModelIds: [],
      teamIqStrategy: "panel",
      fireworksPlayerCount: 2,
      includeSoloBaselines: true,
      workBenchModelIds: [],
      workBenchRoleMode: "solo",
      workBenchRunnerUrl: "",
      workBenchRunnerToken: "",
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

{
  configureStore();
  const model = selectedModel("pre-aborted-gameiq");
  const parent = new AbortController();
  const cancellation = new Error("cancel before GameIQ setup");
  parent.abort(cancellation);
  let providerCalls = 0;
  let message: string | null = null;
  let visibleRuns: GameIqModelRunState[] = [];
  const originalStreamChat = openaiProvider.streamChat;
  openaiProvider.streamChat = async function* (): AsyncIterable<StreamChunk> {
    providerCalls++;
    yield { type: "token", content: "{}" };
  };
  try {
    await runGameIqMultiModel({
      models: [model],
      gameIqModelIds: [model.modelId],
      suiteId: "gameiq-all-packs",
      fireworksPlayerCount: 2,
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
      setGameIqModelRuns: (updater) => {
        visibleRuns =
          typeof updater === "function" ? updater(visibleRuns) : updater;
      },
      onComplete: async () => {},
    });
  } finally {
    openaiProvider.streamChat = originalStreamChat;
  }
  assert.equal(providerCalls, 0);
  assert.equal(message, cancellation.message);
  assert.equal(visibleRuns[0]?.status, "cancelled");
  assert.equal(visibleRuns[0]?.error, cancellation.message);
  await assertNoCertifiedPersistence();
  console.log("PASS pre-aborted GameIQ persists and calls nothing");
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
      selectedTrack: "toolreliability",
      suiteId: toolReliabilityLeg.suiteId,
      models: [model],
      modelId: model.modelId,
      teamModelIds: [],
      teamIqStrategy: "panel",
      fireworksPlayerCount: 2,
      includeSoloBaselines: true,
      workBenchModelIds: [],
      workBenchRoleMode: "solo",
      workBenchRunnerUrl: "",
      workBenchRunnerToken: "",
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

// Removing the GameIQ post-persistence/next-admission abort gates makes these
// fail by entering the next durable boundary or provider path after the parent
// cancellation has already won.
const gameIqBoundaryFailures: Array<{ name: string; error: string }> = [];
for (const boundary of [
  {
    write: 3,
    finalWrites: 3,
    name: "team",
    expected: { teams: 1, certifications: 1, cases: 1, runs: 0 },
  },
  {
    write: 1,
    finalWrites: 1,
    name: "certification",
    expected: { teams: 0, certifications: 1, cases: 0, runs: 0 },
  },
  {
    write: 2,
    finalWrites: 2,
    name: "case",
    expected: { teams: 0, certifications: 1, cases: 1, runs: 0 },
  },
  {
    write: 4,
    // A durable run boundary writes its run blob and then the main store. Both
    // writes belong to the already-entered boundary and may settle after abort.
    finalWrites: 5,
    name: "run",
    expected: { teams: 1, certifications: 1, cases: 1, runs: 1 },
  },
] as const) {
  configureStore();
  const model = selectedModel(`gameiq-deferred-${boundary.name}`);
  const parent = new AbortController();
  const cancellation = new Error(
    `cancel GameIQ during deferred ${boundary.name} persistence`
  );
  const persistence = deferredWriteAdapter(boundary.write);
  __setAdapterForTests(persistence.adapter);
  const runAbortRef: { current: AbortController | null } = { current: null };
  let providerCalls = 0;
  let message: string | null = null;
  let summaryStatus: string | null = null;
  let onCompleteCalls = 0;
  let visibleRuns: GameIqModelRunState[] = [];
  let modelAdmittedAfterCancellation = false;
  let exactChildReason = false;
  const originalStreamChat = openaiProvider.streamChat;
  openaiProvider.streamChat = async function* (): AsyncIterable<StreamChunk> {
    providerCalls++;
    yield { type: "token", content: "{}" };
  };
  try {
    const pending = runGameIqMultiModel({
      models: [model],
      gameIqModelIds: [model.modelId],
      suiteId: "gameiq-v0.2-connect-four",
      fireworksPlayerCount: 2,
      certification: runHarnessCertification(DIRECT_MODEL_HARNESS),
      effortByModelId: {},
      signal: parent.signal,
      runAbortRef,
      setRunning: () => {},
      setRunPhase: () => {},
      setSummary: (next) => {
        summaryStatus = next?.status ?? null;
      },
      setMessage: (next) => {
        message = next;
      },
      setGameIqModelRuns: (updater) => {
        const previous = visibleRuns;
        const next =
          typeof updater === "function" ? updater(previous) : updater;
        if (
          parent.signal.aborted &&
          next.some(
            (run) =>
              run.status === "running" &&
              previous.find((candidate) => candidate.modelId === run.modelId)
                ?.status !== "running"
          )
        ) {
          modelAdmittedAfterCancellation = true;
        }
        visibleRuns = next;
      },
      onComplete: async () => {
        onCompleteCalls++;
      },
    });
    await persistence.entered;
    const activeController = runAbortRef.current;
    assert.ok(activeController);
    parent.abort(cancellation);
    exactChildReason = activeController.signal.reason === cancellation;
    persistence.release();
    await pending;
  } finally {
    persistence.release();
    __setAdapterForTests(null);
    openaiProvider.streamChat = originalStreamChat;
  }

  const persisted = {
    teams: (await listBenchmarkTeamCompositions()).length,
    certifications: (await listHarnessCertificationResults()).length,
    cases: (await listBenchmarkCaseV2()).length,
    runs: (await listBenchmarkRuns()).length,
  };
  const descendantEvidence = {
    attempts: (await listBenchmarkAttemptsV2()).length,
    traces: (await listBenchmarkTraces()).length,
    events: (await listBenchmarkRunEvents()).length,
    toolCalls: (await listBenchmarkToolCallTraces()).length,
    verifiers: (await listBenchmarkVerifierResults()).length,
    artifacts: (await listBenchmarkArtifacts()).length,
    failures: (await listBenchmarkFailures()).length,
  };
  try {
    assert.deepEqual(persisted, boundary.expected);
    assert.deepEqual(descendantEvidence, {
      attempts: 0,
      traces: 0,
      events: 0,
      toolCalls: 0,
      verifiers: 0,
      artifacts: 0,
      failures: 0,
    });
    assert.equal(persistence.writes(), boundary.finalWrites);
    assert.equal(providerCalls, 0);
    assert.equal(modelAdmittedAfterCancellation, false);
    assert.equal(exactChildReason, true);
    assert.equal(summaryStatus, null);
    assert.equal(onCompleteCalls, 0);
    assert.equal(message, cancellation.message);
    assert.equal(visibleRuns.length, 1);
    assert.equal(visibleRuns[0]?.status, "cancelled");
    assert.equal(visibleRuns[0]?.error, cancellation.message);
    assert.equal(visibleRuns[0]?.packsScored, undefined);
    assert.doesNotMatch(message ?? "", /completed|success/i);
    console.log(
      `PASS GameIQ cancellation at deferred ${boundary.name} persistence admits no later boundary`
    );
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    gameIqBoundaryFailures.push({ name: boundary.name, error: detail });
    console.error(
      `FAIL GameIQ cancellation at deferred ${boundary.name} persistence admits no later boundary -> ${detail}`
    );
  }
}
assert.deepEqual(gameIqBoundaryFailures, []);

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
        soloModelIds: models.map((model) => model.modelId),
        effortByModelId: {},
        teamModelIds: [],
        teamIqStrategy: "panel",
        workBenchRoleMode: "solo",
        workBenchRunnerUrl: "",
        workBenchRunnerToken: "",
        fireworksPlayerCount: 2,
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
        soloModelIds: models.map((model) => model.modelId),
        effortByModelId: {},
        teamModelIds: [],
        teamIqStrategy: "panel",
        workBenchRoleMode: "solo",
        workBenchRunnerUrl: "",
        workBenchRunnerToken: "",
        fireworksPlayerCount: 2,
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
  assert.equal(failedModelProgress?.detail, "isolated provider failure");
  assert.doesNotMatch(failedModelProgress?.detail ?? "", /completed|success/i);
  for (const model of models.slice(1)) {
    assert.equal(
      progress.some(
        (event) =>
          event.type === "model" &&
          event.modelId === model.modelId &&
          event.status === "passed"
      ),
      true
    );
  }
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
  const workBenchLeg = BENCHMARK_PRESETS[2]!.legs.find(
    (leg) => leg.track === "workbench"
  )!;
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
        fireworksPlayerCount: 2,
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
