import {
  exportStore,
  flush,
  getBenchmarkArtifacts,
  getBenchmarkAttempts,
  getBenchmarkCases,
  getBenchmarkFailures,
  getBenchmarkMetricValues,
  getBenchmarkRuns,
  getBenchmarkSuites,
  getBenchmarkTraces,
  initStore,
  isInitialized,
  getBuildCheckpoints,
  getGenericGameMatchRecords,
  getModelStats,
  replaceStore,
  upsertBenchmarkArtifact,
  upsertBenchmarkAttempt,
  upsertBenchmarkCase,
  upsertBenchmarkFailure,
  upsertBenchmarkMetricValue,
  upsertBenchmarkRun,
  upsertBenchmarkSuite,
  upsertBenchmarkTrace,
  __resetClientStoreForTests,
} from "../client/store";
import type { ClientStore } from "../client/store";
import type {
  BenchmarkArtifact,
  BenchmarkAttempt,
  BenchmarkCase,
  BenchmarkFailure,
  BenchmarkMetricValue,
  BenchmarkModelCallTrace,
  BenchmarkReportBundle,
  BenchmarkRun,
  BenchmarkSuite,
} from "./types";

async function ensureWritableStore(): Promise<void> {
  if (!isInitialized()) {
    const { needsPassphrase } = await initStore();
    if (needsPassphrase) {
      throw new Error("Unlock storage before modifying benchmark data.");
    }
  }
}

export async function listBenchmarkSuites(): Promise<BenchmarkSuite[]> {
  if (!isInitialized()) {
    const { needsPassphrase } = await initStore();
    if (needsPassphrase) return [];
  }
  return [...getBenchmarkSuites()];
}

export async function listBenchmarkRuns(): Promise<BenchmarkRun[]> {
  if (!isInitialized()) {
    const { needsPassphrase } = await initStore();
    if (needsPassphrase) return [];
  }
  return [...getBenchmarkRuns()];
}

export async function listBenchmarkCases(): Promise<BenchmarkCase[]> {
  if (!isInitialized()) {
    const { needsPassphrase } = await initStore();
    if (needsPassphrase) return [];
  }
  return [...getBenchmarkCases()];
}

export async function saveBenchmarkCase(record: BenchmarkCase): Promise<void> {
  await ensureWritableStore();
  upsertBenchmarkCase(record);
  await flush();
}

export async function saveBenchmarkRun(record: BenchmarkRun): Promise<void> {
  await ensureWritableStore();
  upsertBenchmarkRun(record);
  await flush();
}

export async function saveBenchmarkSuite(record: BenchmarkSuite): Promise<void> {
  await ensureWritableStore();
  upsertBenchmarkSuite(record);
  await flush();
}

export async function saveBenchmarkAttempt(record: BenchmarkAttempt): Promise<void> {
  await ensureWritableStore();
  upsertBenchmarkAttempt(record);
  await flush();
}

export async function saveBenchmarkMetricValue(
  record: BenchmarkMetricValue
): Promise<void> {
  await ensureWritableStore();
  upsertBenchmarkMetricValue(record);
  await flush();
}

export async function saveBenchmarkArtifact(
  record: BenchmarkArtifact
): Promise<void> {
  await ensureWritableStore();
  upsertBenchmarkArtifact(record);
  await flush();
}

export async function saveBenchmarkFailure(record: BenchmarkFailure): Promise<void> {
  await ensureWritableStore();
  upsertBenchmarkFailure(record);
  await flush();
}

export async function saveBenchmarkTrace(
  record: BenchmarkModelCallTrace
): Promise<void> {
  await ensureWritableStore();
  upsertBenchmarkTrace(record);
  await flush();
}

export function exportBenchmarkReportBundle(): BenchmarkReportBundle {
  return {
    version: 1,
    exportedAt: new Date().toISOString(),
    suites: [...getBenchmarkSuites()],
    runs: [...getBenchmarkRuns()],
    cases: [...getBenchmarkCases()],
    attempts: [...getBenchmarkAttempts()],
    metricValues: [...getBenchmarkMetricValues()],
    artifacts: [...getBenchmarkArtifacts()],
    failures: [...getBenchmarkFailures()],
    traces: [...getBenchmarkTraces()],
    sourceEvidence: {
      gameMatches: [...getGenericGameMatchRecords()],
      buildCheckpoints: [...getBuildCheckpoints()],
      buildStats: getModelStats(),
    },
  };
}

export async function importBenchmarkReportBundle(
  bundle: BenchmarkReportBundle
): Promise<void> {
  validateBenchmarkReportBundle(bundle);

  await ensureWritableStore();
  const current = exportStore();
  replaceStore({
    ...current,
    benchmarkSuites: mergeById(current.benchmarkSuites ?? [], bundle.suites),
    benchmarkRuns: mergeById(current.benchmarkRuns ?? [], bundle.runs),
    benchmarkCases: mergeById(current.benchmarkCases ?? [], bundle.cases),
    benchmarkAttempts: mergeById(
      current.benchmarkAttempts ?? [],
      bundle.attempts
    ),
    benchmarkMetricValues: mergeById(
      current.benchmarkMetricValues ?? [],
      bundle.metricValues
    ),
    benchmarkArtifacts: mergeById(
      current.benchmarkArtifacts ?? [],
      bundle.artifacts
    ),
    benchmarkFailures: mergeById(
      current.benchmarkFailures ?? [],
      bundle.failures
    ),
    benchmarkTraces: mergeById(current.benchmarkTraces ?? [], bundle.traces),
    gameMatchRecords: mergeById(
      current.gameMatchRecords ?? [],
      bundle.sourceEvidence?.gameMatches ?? []
    ),
    buildCheckpoints: mergeByKey(
      current.buildCheckpoints ?? [],
      bundle.sourceEvidence?.buildCheckpoints ?? [],
      (checkpoint) => checkpoint.discussionId
    ),
    modelStats: mergeByKey(
      current.modelStats ?? [],
      bundle.sourceEvidence?.buildStats ?? [],
      (stat) => stat.modelId
    ),
  });
  await flush();
}

function validateBenchmarkReportBundle(bundle: BenchmarkReportBundle): void {
  if (!bundle || typeof bundle !== "object") {
    throw new Error("Invalid benchmark report bundle.");
  }

  if (bundle.version !== 1) {
    throw new Error(`Unsupported benchmark report version: ${bundle.version}`);
  }

  const keyedArrays: Array<[string, unknown, string]> = [
    ["suites", bundle.suites, "id"],
    ["runs", bundle.runs, "id"],
    ["cases", bundle.cases, "id"],
    ["attempts", bundle.attempts, "id"],
    ["metricValues", bundle.metricValues, "id"],
    ["artifacts", bundle.artifacts, "id"],
    ["failures", bundle.failures, "id"],
    ["traces", bundle.traces, "id"],
  ];

  for (const [label, value, key] of keyedArrays) {
    validateArrayWithStringKey(label, value, key);
  }

  if (bundle.sourceEvidence !== undefined) {
    if (
      !bundle.sourceEvidence ||
      typeof bundle.sourceEvidence !== "object" ||
      Array.isArray(bundle.sourceEvidence)
    ) {
      throw new Error("Invalid sourceEvidence in benchmark report bundle.");
    }
    validateArrayWithStringKey(
      "sourceEvidence.gameMatches",
      bundle.sourceEvidence.gameMatches,
      "id"
    );
    validateGameMatchRecords(bundle.sourceEvidence.gameMatches);
    validateArrayWithStringKey(
      "sourceEvidence.buildCheckpoints",
      bundle.sourceEvidence.buildCheckpoints,
      "discussionId"
    );
    validateBuildCheckpointRecords(bundle.sourceEvidence.buildCheckpoints);
    validateArrayWithStringKey(
      "sourceEvidence.buildStats",
      bundle.sourceEvidence.buildStats,
      "modelId"
    );
    validateModelBuildStatRecords(bundle.sourceEvidence.buildStats);
  }
}

function validateArrayWithStringKey(
  label: string,
  value: unknown,
  key: string
): void {
  if (!Array.isArray(value)) {
    throw new Error(`Invalid ${label} in benchmark report bundle.`);
  }

  for (const item of value) {
    if (
      !item ||
      typeof item !== "object" ||
      Array.isArray(item) ||
      typeof (item as Record<string, unknown>)[key] !== "string" ||
      ((item as Record<string, unknown>)[key] as string).length === 0
    ) {
      throw new Error(`Invalid ${label} record in benchmark report bundle.`);
    }
  }
}

function validateGameMatchRecords(records: unknown[]): void {
  for (const record of records) {
    const item = record as Record<string, unknown>;
    if (
      typeof item.gameId !== "string" ||
      typeof item.timestamp !== "string" ||
      !Array.isArray(item.participants) ||
      typeof item.resultJson !== "string" ||
      typeof item.statsJson !== "string" ||
      !isJsonObjectString(item.resultJson) ||
      !isJsonObjectString(item.statsJson)
    ) {
      throw new Error("Invalid sourceEvidence.gameMatches record in benchmark report bundle.");
    }

    for (const participant of item.participants) {
      if (!isValidGameParticipant(participant)) {
        throw new Error("Invalid sourceEvidence.gameMatches participant in benchmark report bundle.");
      }
    }
  }
}

function validateBuildCheckpointRecords(records: unknown[]): void {
  for (const record of records) {
    const item = record as Record<string, unknown>;
    if (
      typeof item.status !== "string" ||
      !["running", "stopped", "blocked", "completed"].includes(item.status) ||
      typeof item.updatedAt !== "string" ||
      typeof item.runPolicy !== "string" ||
      typeof item.wave !== "number" ||
      !Array.isArray(item.tasks) ||
      typeof item.architectNotes !== "string" ||
      typeof item.verifyCommand !== "string" ||
      !isNullableString(item.branch) ||
      !isNullableString(item.prUrl) ||
      !isNullableString(item.milestone) ||
      !isNumberArray(item.issueNumbers) ||
      !isNumberRecord(item.failureFingerprints) ||
      !isStringArray(item.recoveryLog) ||
      !isBuildUsageWindow(item.usageWindow) ||
      !item.tasks.every(isBuildCheckpointTask) ||
      (item.buildProblems !== undefined &&
        (!Array.isArray(item.buildProblems) ||
          !item.buildProblems.every(isBuildProblem))) ||
      (item.commandProblems !== undefined &&
        (!Array.isArray(item.commandProblems) ||
          !item.commandProblems.every(isBuildCommandProblem)))
    ) {
      throw new Error("Invalid sourceEvidence.buildCheckpoints record in benchmark report bundle.");
    }
  }
}

function validateModelBuildStatRecords(records: unknown[]): void {
  for (const record of records) {
    const item = record as Record<string, unknown>;
    const numericKeys = [
      "builds",
      "attempts",
      "approvals",
      "fixes",
      "badOutput",
      "unavailable",
      "wApprovals",
      "wFixes",
      "wBadOutput",
      "responseMs",
      "responseChars",
      "independentVerdicts",
    ];
    if (
      typeof item.displayName !== "string" ||
      typeof item.updatedAt !== "string" ||
      !isNumberRecord(item.judges) ||
      numericKeys.some((key) => typeof item[key] !== "number")
    ) {
      throw new Error("Invalid sourceEvidence.buildStats record in benchmark report bundle.");
    }
  }
}

function isValidGameParticipant(value: unknown): boolean {
  if (!isPlainObject(value)) return false;
  return (
    typeof value.id === "string" &&
    (value.kind === "human" || value.kind === "ai") &&
    typeof value.label === "string" &&
    (value.modelId === undefined || typeof value.modelId === "string") &&
    (value.reasoningEffort === undefined ||
      typeof value.reasoningEffort === "string")
  );
}

function isBuildUsageWindow(value: unknown): boolean {
  if (!isPlainObject(value)) return false;
  return (
    typeof value.startedAt === "string" &&
    typeof value.elapsedMs === "number" &&
    typeof value.estimatedUsd === "number" &&
    isStringArray(value.unknownPricedModelIds) &&
    Array.isArray(value.models) &&
    value.models.every(isBuildUsageModelTotal)
  );
}

function isBuildUsageModelTotal(value: unknown): boolean {
  if (!isPlainObject(value)) return false;
  return (
    typeof value.modelId === "string" &&
    typeof value.modelName === "string" &&
    typeof value.providerId === "string" &&
    typeof value.calls === "number" &&
    typeof value.inputTokens === "number" &&
    typeof value.outputTokens === "number" &&
    typeof value.totalTokens === "number" &&
    (value.estimatedUsd === null || typeof value.estimatedUsd === "number") &&
    typeof value.priced === "boolean"
  );
}

function isBuildCheckpointTask(value: unknown): boolean {
  if (!isPlainObject(value)) return false;
  return (
    typeof value.id === "string" &&
    typeof value.title === "string" &&
    typeof value.instructions === "string" &&
    isStringArray(value.contextFiles) &&
    isBuildTaskStatus(value.status) &&
    (value.outputPaths === undefined || isStringArray(value.outputPaths)) &&
    (value.expectedOutputs === undefined ||
      typeof value.expectedOutputs === "string") &&
    (value.dependsOn === undefined || isStringArray(value.dependsOn)) &&
    (value.assignTo === undefined || typeof value.assignTo === "string") &&
    (value.workerIndex === undefined || typeof value.workerIndex === "number") &&
    (value.failCount === undefined || typeof value.failCount === "number") &&
    (value.retryAfterMs === undefined ||
      typeof value.retryAfterMs === "number") &&
    (value.difficulty === undefined || typeof value.difficulty === "number")
  );
}

function isBuildTaskStatus(value: unknown): boolean {
  return (
    value === "planned" ||
    value === "in_progress" ||
    value === "review" ||
    value === "fixing" ||
    value === "done" ||
    value === "failed"
  );
}

function isBuildProblem(value: unknown): boolean {
  if (!isPlainObject(value)) return false;
  return (
    typeof value.id === "string" &&
    typeof value.createdAt === "string" &&
    typeof value.code === "string" &&
    typeof value.severity === "string" &&
    typeof value.source === "string" &&
    typeof value.message === "string"
  );
}

function isBuildCommandProblem(value: unknown): boolean {
  if (!isPlainObject(value)) return false;
  return (
    typeof value.command === "string" &&
    typeof value.exitCode === "number" &&
    typeof value.durationMs === "number" &&
    typeof value.outputPreview === "string" &&
    typeof value.createdAt === "string" &&
    (value.denied === undefined || typeof value.denied === "boolean") &&
    (value.background === undefined || typeof value.background === "boolean")
  );
}

function isJsonObjectString(value: string): boolean {
  try {
    const parsed = JSON.parse(value);
    return isPlainObject(parsed);
  } catch {
    return false;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isNullableString(value: unknown): boolean {
  return value === null || typeof value === "string";
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isNumberArray(value: unknown): value is number[] {
  return Array.isArray(value) && value.every((item) => typeof item === "number");
}

function isNumberRecord(value: unknown): value is Record<string, number> {
  return (
    isPlainObject(value) &&
    Object.values(value).every((item) => typeof item === "number")
  );
}

function mergeById<T extends { id: string }>(current: T[], incoming: T[]): T[] {
  const map = new Map(current.map((item) => [item.id, item]));
  for (const item of incoming) map.set(item.id, item);
  return Array.from(map.values());
}

function mergeByKey<T>(
  current: T[],
  incoming: T[],
  keyFor: (item: T) => string
): T[] {
  const map = new Map(current.map((item) => [keyFor(item), item]));
  for (const item of incoming) map.set(keyFor(item), item);
  return Array.from(map.values());
}

export function __resetBenchmarkStoreForTests(): void {
  __resetClientStoreForTests();
}

export function __exportBenchmarkStoreForTests(): ClientStore {
  return exportStore();
}

export function __replaceBenchmarkStoreForTests(data: Partial<ClientStore>): void {
  replaceStore(data);
}
