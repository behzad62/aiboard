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
  };
}

export async function importBenchmarkReportBundle(
  bundle: BenchmarkReportBundle
): Promise<void> {
  if (bundle.version !== 1) {
    throw new Error(`Unsupported benchmark report version: ${bundle.version}`);
  }

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
  });
  await flush();
}

function mergeById<T extends { id: string }>(current: T[], incoming: T[]): T[] {
  const map = new Map(current.map((item) => [item.id, item]));
  for (const item of incoming) map.set(item.id, item);
  return Array.from(map.values());
}

export function __resetBenchmarkStoreForTests(): void {
  __resetClientStoreForTests();
}
