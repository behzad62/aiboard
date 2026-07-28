import assert from "node:assert/strict";
import { createServer, type ServerResponse } from "node:http";
import {
  runPreset,
  type PresetProgressEvent,
} from "../lib/benchmark/certified/run-execution";
import { BENCHMARK_PRESETS } from "../lib/benchmark/certified/run-presets";
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

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  assert.fail("Timed out waiting for certified preset state.");
}

function configureStore(): void {
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
  const gates = new Map<string, ReturnType<typeof deferred<void>>>();
  const progress: PresetProgressEvent[] = [];
  const originalStreamChat = openaiProvider.streamChat;
  openaiProvider.streamChat = async function* (params): AsyncIterable<StreamChunk> {
    startedModels.add(params.model);
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
  assert.equal(
    progress.some(
      (event) =>
        event.type === "model" &&
        event.modelId.endsWith("isolated-1") &&
        event.status === "failed"
    ),
    true
  );
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
    await healthGate.promise;
    sendJson(response, 200, healthyRunnerV2Response);
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
