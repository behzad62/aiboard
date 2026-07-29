/* Certified Fireworks TeamIQ e2e checks (run: npx tsx scripts/test-certified-e2e-fireworks-teamiq.mts) */
import assert from "node:assert/strict";
import {
  __resetBenchmarkStoreForTests,
  exportBenchmarkReportBundleV2,
  importBenchmarkReportBundleV2,
  listBenchmarkAttemptsV2,
  listBenchmarkResultSets,
} from "../lib/benchmark/store";
import {
  runSelected,
  TEAM_HARNESS,
} from "../lib/benchmark/certified/run-execution";
import { runHarnessCertification } from "../lib/benchmark/certified/certification";
import { benchmarkResultConfigurationKey } from "../lib/benchmark/certified/result-set-identity";
import {
  __resetClientStoreForTests,
  upsertProviderKey,
} from "../lib/client/store";
import { openaiProvider } from "../lib/providers/openai";
import type { SelectedModel, StreamChunk } from "../lib/providers/base";

const now = "2026-07-29T10:00:00.000Z";
const models: SelectedModel[] = [
  {
    modelId: "openai:fireworks-real-a",
    providerId: "openai",
    displayName: "Fireworks Real A",
  },
  {
    modelId: "openai:fireworks-real-b",
    providerId: "openai",
    displayName: "Fireworks Real B",
  },
];

__resetBenchmarkStoreForTests();
__resetClientStoreForTests();
upsertProviderKey({
  providerId: "openai",
  apiKey: "test-key",
  defaultModel: null,
  enabled: true,
  keyHint: null,
  updatedAt: now,
});

let pendingResultSetsAtFirstProviderAdmission: Awaited<
  ReturnType<typeof listBenchmarkResultSets>
> = [];
let providerAdmissionCount = 0;
const originalStreamChat = openaiProvider.streamChat;
openaiProvider.streamChat = async function* (): AsyncIterable<StreamChunk> {
  if (providerAdmissionCount++ === 0) {
    pendingResultSetsAtFirstProviderAdmission = (
      await listBenchmarkResultSets()
    ).filter((resultSet) => resultSet.status === "pending");
  }
  yield {
    type: "token",
    content: '{"action":"clue_color","targetPlayerId":"P1","color":"red"}',
  };
  yield { type: "done" };
};
try {
  await runSelected({
    selectedTrack: "teamiq",
    suiteId: "fireworks-teamiq-mixed-v0.1",
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
    executionId: "execution-real-fireworks-publication",
    runId: "run-real-fireworks-publication",
    runAbortRef: { current: null },
    setRunning: () => {},
    setRunPhase: () => {},
    setSummary: () => {},
    setMessage: () => {},
    onComplete: async () => {},
  });
} finally {
  openaiProvider.streamChat = originalStreamChat;
}

const attempts = await listBenchmarkAttemptsV2();
const resultSets = await listBenchmarkResultSets();
assert.equal(pendingResultSetsAtFirstProviderAdmission.length, 3);
assert.equal(
  new Set(pendingResultSetsAtFirstProviderAdmission.map((resultSet) => resultSet.id))
    .size,
  3
);
assert.equal(
  pendingResultSetsAtFirstProviderAdmission.every(
    (resultSet) => resultSet.status === "pending"
  ),
  true
);
assert.deepEqual(
  [...new Set(
    pendingResultSetsAtFirstProviderAdmission.map(
      (resultSet) => resultSet.executionId
    )
  )],
  ["execution-real-fireworks-publication"]
);
assert.deepEqual(
  pendingResultSetsAtFirstProviderAdmission
    .map((resultSet) =>
      resultSet.configuration.subjectKind === "model"
        ? `model:${resultSet.configuration.modelId}`
        : `team:${resultSet.configuration.roles
            .map((role) => role.modelId)
            .join("+")}`
    )
    .sort(),
  [
    "model:openai:fireworks-real-a",
    "model:openai:fireworks-real-b",
    "team:openai:fireworks-real-a+openai:fireworks-real-b",
  ]
);
assert.equal(resultSets.length, 3);
assert.equal(
  resultSets.every(
    (resultSet) =>
      resultSet.configuration.roles.every((role) => role.maxTokens === 512) &&
      resultSet.configuration.tracks.every((track) => track.maxTokens === 512)
  ),
  true
);
const plannedFireworksSolo = resultSets.find(
  (resultSet) =>
    resultSet.configuration.subjectKind === "model" &&
    resultSet.configuration.modelId === models[0]!.modelId
);
assert.ok(plannedFireworksSolo);
const sameModelAtToolCap = {
  ...plannedFireworksSolo.configuration,
  roles: plannedFireworksSolo.configuration.roles.map((role) => ({
    ...role,
    maxTokens: 16_384,
  })),
  tracks: plannedFireworksSolo.configuration.tracks.map((track) => ({
    ...track,
    maxTokens: 16_384,
  })),
};
assert.notEqual(
  benchmarkResultConfigurationKey(plannedFireworksSolo.configuration),
  benchmarkResultConfigurationKey(sameModelAtToolCap)
);
assert.equal(
  resultSets.every((resultSet) => resultSet.status === "completed"),
  true
);
assert.equal(attempts.length, 3);
assert.equal(
  attempts.every((attempt) =>
    resultSets.some((resultSet) => resultSet.id === attempt.resultSetId)
  ),
  true
);

const bundle = exportBenchmarkReportBundleV2();
assert.equal(bundle.verifierResults.length, 3);
assert.ok(bundle.traces.length > 0);
assert.ok(
  bundle.artifacts.some((artifact) =>
    artifact.id.endsWith(":fireworks-transcript")
  )
);
__resetBenchmarkStoreForTests();
await importBenchmarkReportBundleV2(bundle);
const importedAttempts = await listBenchmarkAttemptsV2();
const importedResultSets = await listBenchmarkResultSets();
assert.equal(importedResultSets.length, 3);
assert.equal(importedAttempts.length, 3);
assert.deepEqual(
  importedAttempts.map((attempt) => attempt.jobSuccessScore),
  attempts.map((attempt) => attempt.jobSuccessScore)
);

console.log("PASS certified Fireworks TeamIQ through runSelected");
