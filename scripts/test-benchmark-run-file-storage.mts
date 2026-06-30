/* Benchmark run file storage checks (run: npx tsx scripts/test-benchmark-run-file-storage.mts) */
import {
  __resetBenchmarkStoreForTests,
  __enableBenchmarkRunBlobStorageForTests,
  __exportClientStoreForPersistenceForTests,
  __getBenchmarkRunBlobsForTests,
  deleteBenchmarkRunCascade,
  saveBenchmarkAttemptV2,
  saveBenchmarkRun,
  saveBenchmarkRunEvent,
  saveBenchmarkTrace,
} from "../lib/benchmark/store";
import type {
  BenchmarkAttemptV2,
  BenchmarkModelCallTrace,
  BenchmarkRun,
  BenchmarkRunEvent,
} from "../lib/benchmark/types";

let failures = 0;

function check(name: string, ok: boolean, detail?: unknown): void {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` -> ${JSON.stringify(detail)}`}`);
}

const now = "2026-06-30T12:00:00.000Z";
const run: BenchmarkRun = {
  id: "run-file-storage-1",
  suiteId: "suite-file-storage",
  name: "Run-file storage fixture",
  domain: "model-call",
  status: "completed",
  startedAt: now,
  completedAt: now,
  source: "manual",
  modelIds: ["provider:model"],
  caseIds: ["case-file-storage"],
  summaryJson: "{}",
  metricValueIds: [],
  artifactIds: [],
  failureIds: [],
};
const attempt: BenchmarkAttemptV2 = {
  id: "attempt-file-storage-1",
  runId: run.id,
  caseId: "case-file-storage",
  teamCompositionId: "team-file-storage",
  mode: "certified",
  track: "toolreliability",
  harnessProfile: "raw-single-model",
  status: "passed",
  startedAt: now,
  completedAt: now,
  verifiedQuality: 1,
  jobSuccessScore: 100,
  efficiencyScore: 100,
  toolReliabilityScore: 100,
  costUsd: null,
  inputTokens: 100,
  outputTokens: 20,
  modelCalls: 1,
  toolCalls: 0,
  durationMs: 1000,
  artifactIds: [],
  traceIds: ["trace-file-storage-1"],
  failureIds: [],
  harnessVersion: "toolreliability-harness-current",
  promptSetVersion: "toolreliability-prompts-current",
  scoringVersion: "toolreliability-current",
};
const trace: BenchmarkModelCallTrace = {
  id: "trace-file-storage-1",
  runId: run.id,
  attemptId: attempt.id,
  caseId: attempt.caseId,
  modelId: "provider:model",
  providerId: "provider",
  startedAt: now,
  completedAt: now,
  inputTokens: 100,
  outputTokens: 20,
  rawResponse: "{\"ok\":true}",
  retryHistory: [],
};
const event: BenchmarkRunEvent = {
  id: "event-file-storage-1",
  attemptId: attempt.id,
  caseId: attempt.caseId,
  type: "model_call_completed",
  phase: "model-call",
  at: now,
  message: "Model call completed.",
};

__resetBenchmarkStoreForTests();
__enableBenchmarkRunBlobStorageForTests();

await saveBenchmarkRun(run);
await saveBenchmarkAttemptV2(attempt);
await saveBenchmarkTrace(trace);
await saveBenchmarkRunEvent(event);

const blobs = __getBenchmarkRunBlobsForTests();
const storedBlob = blobs[run.id];
const stored = storedBlob ? JSON.parse(storedBlob) : null;
check("benchmark run writes one separate run JSON blob", Object.keys(blobs).length === 1 && Boolean(stored), blobs);
check(
  "run JSON contains complete run evidence",
  stored?.runs?.[0]?.id === run.id &&
    stored?.attemptsV2?.[0]?.id === attempt.id &&
    stored?.traces?.[0]?.rawResponse === trace.rawResponse &&
    stored?.runEvents?.[0]?.id === event.id,
  stored
);

const persistedMainStore = __exportClientStoreForPersistenceForTests();
check(
  "main store persistence strips benchmark run evidence",
  persistedMainStore.benchmarkRuns.length === 0 &&
    persistedMainStore.benchmarkAttemptsV2.length === 0 &&
    persistedMainStore.benchmarkTraces.length === 0 &&
    persistedMainStore.benchmarkRunEvents.length === 0,
  persistedMainStore
);

await deleteBenchmarkRunCascade(run.id);
check("deleting a run removes its separate run JSON blob", !__getBenchmarkRunBlobsForTests()[run.id], __getBenchmarkRunBlobsForTests());

if (failures === 0) {
  console.log("PASS");
} else {
  console.log(`FAIL ${failures} check(s) failed`);
}

process.exit(failures === 0 ? 0 : 1);
