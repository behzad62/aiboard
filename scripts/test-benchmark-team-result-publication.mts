import assert from "node:assert/strict";
import {
  __clearClientStoreForTests,
  __resetBenchmarkStoreForTests,
  listBenchmarkAttemptsV2,
  listBenchmarkResultSets,
} from "../lib/benchmark/store";
import {
  runSelected,
  TEAM_HARNESS,
} from "../lib/benchmark/certified/run-execution";
import { runHarnessCertification } from "../lib/benchmark/certified/certification";
import { upsertProviderKey } from "../lib/client/store";
import { openaiProvider } from "../lib/providers/openai";
import type { SelectedModel, StreamChunk } from "../lib/providers/base";

const now = "2026-07-29T10:00:00.000Z";
const models: SelectedModel[] = [
  {
    modelId: "openai:publication-a",
    providerId: "openai",
    displayName: "Publication A",
  },
  {
    modelId: "openai:publication-b",
    providerId: "openai",
    displayName: "Publication B",
  },
];

__clearClientStoreForTests();
__resetBenchmarkStoreForTests();
upsertProviderKey({
  providerId: "openai",
  apiKey: "test-key",
  defaultModel: null,
  enabled: true,
  keyHint: null,
  updatedAt: now,
});

let pendingCountAtFirstProviderAdmission = 0;
let message: string | null = null;
const originalStreamChat = openaiProvider.streamChat;
openaiProvider.streamChat = async function* (params): AsyncIterable<StreamChunk> {
  if (pendingCountAtFirstProviderAdmission === 0) {
    pendingCountAtFirstProviderAdmission = (
      await listBenchmarkResultSets()
    ).filter((resultSet) => resultSet.status === "pending").length;
  }
  if (params.model === "publication-b") {
    throw new Error("composition B infrastructure failed");
  }
  yield { type: "token", content: "{}" };
  yield { type: "done" };
};
try {
  await runSelected({
    selectedTrack: "teamiq",
    suiteId: "teamiq-toolreliability-current-quick",
    models,
    modelId: models[0]!.modelId,
    teamModelIds: models.map((model) => model.modelId),
    teamIqStrategy: "panel",
    fireworksPlayerCount: 2,
    includeSoloBaselines: true,
    workBenchModelIds: [],
    workBenchRoleMode: "solo",
    workBenchRunnerUrl: "",
    workBenchRunnerToken: "",
    effectiveHarnessProfile: TEAM_HARNESS,
    certification: runHarnessCertification(TEAM_HARNESS),
    effortByModelId: {},
    executionId: "execution-real-teamiq-publication",
    runId: "run-real-teamiq-publication",
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

const resultSets = await listBenchmarkResultSets();
const attempts = await listBenchmarkAttemptsV2();
const completed = resultSets.filter((resultSet) => resultSet.status === "completed");
assert.equal(pendingCountAtFirstProviderAdmission, 3);
assert.equal(completed.length, 1, JSON.stringify({ resultSets, attempts, message }));
assert.equal(resultSets.some((resultSet) => resultSet.status === "pending"), false);
assert.equal(resultSets.filter((resultSet) => resultSet.status === "failed").length, 2);
assert.ok(message?.includes("composition B infrastructure failed"));
assert.ok(
  attempts.some(
    (attempt) =>
      attempt.resultSetId === completed[0]!.id &&
      attempt.teamCompositionId ===
        completed[0]!.expectedAttempts[0]!.teamCompositionId
  )
);

console.log("PASS benchmark team result publication through runSelected");
