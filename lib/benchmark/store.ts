import {
  deleteBenchmarkAttemptV2ById,
  deleteBenchmarkArtifactsByAttemptId,
  deleteBenchmarkArtifactsByIds,
  deleteBenchmarkArtifactsByRunId,
  deleteBenchmarkFailuresByAttemptId,
  deleteBenchmarkFailuresByRunId,
  deleteBenchmarkRunById,
  deleteBenchmarkRunEventsByAttemptId,
  deleteBenchmarkToolCallTracesByAttemptId,
  deleteBenchmarkTracesByAttemptId,
  deleteBenchmarkTracesByRunId,
  deleteBenchmarkVerifierResultsByAttemptId,
  exportStore,
  flush,
  getBenchmarkArtifacts,
  getBenchmarkAttempts,
  getBenchmarkAttemptsV2,
  getBenchmarkCases,
  getBenchmarkCaseV2,
  getBenchmarkFailures,
  getBenchmarkHarnessCertifications,
  getBenchmarkMetricValues,
  getBenchmarkRuns,
  getBenchmarkRunEvents,
  getBenchmarkSuites,
  getBenchmarkTeamCompositions,
  getBenchmarkToolCallTraces,
  getBenchmarkTraces,
  getBenchmarkVerifierResults,
  initStore,
  isInitialized,
  getBuildCheckpoints,
  getGenericGameMatchRecords,
  getModelStats,
  replaceStore,
  upsertBenchmarkArtifact,
  upsertBenchmarkAttempt,
  upsertBenchmarkAttemptV2,
  upsertBenchmarkCase,
  upsertBenchmarkCaseV2,
  upsertBenchmarkFailure,
  upsertBenchmarkHarnessCertification,
  upsertBenchmarkMetricValue,
  upsertBenchmarkRun,
  upsertBenchmarkRunEvent,
  upsertBenchmarkSuite,
  upsertBenchmarkTeamComposition,
  upsertBenchmarkToolCallTrace,
  upsertBenchmarkTrace,
  upsertBenchmarkVerifierResult,
  __resetClientStoreForTests,
  deleteBenchmarkRunBlob,
  saveBenchmarkRunBlob,
} from "../client/store";
import type { ClientStore } from "../client/store";
import { redactBenchmarkBundle } from "./redaction";
import type {
  BenchmarkArtifact,
  BenchmarkAttempt,
  BenchmarkAttemptV2,
  BenchmarkCase,
  BenchmarkCaseV2,
  BenchmarkFailure,
  BenchmarkMetricValue,
  BenchmarkModelCallTrace,
  BenchmarkReportBundleV2,
  BenchmarkRun,
  BenchmarkRunEvent,
  BenchmarkSuite,
  BenchmarkTeamComposition,
  BenchmarkToolCallTrace,
  BenchmarkVerifierResult,
  CertifiedAttemptStatus,
  HarnessCertificationResult,
} from "./types";

export {
  __enableBenchmarkRunBlobStorageForTests,
  __exportClientStoreForPersistenceForTests,
  __getBenchmarkRunBlobsForTests,
  __setAdapterForTests,
} from "../client/store";
export {
  clearAllBenchmarkData,
  type ClearAllBenchmarkDataResult,
} from "../client/store";
// Re-export the store-level persistence entry points that already back the
// benchmark save functions, so a single-instance test can drive both the
// benchmark record path (saveBenchmarkTrace) and the raw adapter path
// (flush/saveBenchmarkRunBlob) through the SAME client-store module instance.
// Importing these directly from ../client/store in the same test file as a
// benchmark save loads two client-store copies under tsx (ESM + the CJS
// pre-parse), which desyncs the module-level memory/adapter.
export { flush, saveBenchmarkRunBlob, __resetClientStoreForTests };

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

export async function listBenchmarkCaseV2(): Promise<BenchmarkCaseV2[]> {
  if (!isInitialized()) {
    const { needsPassphrase } = await initStore();
    if (needsPassphrase) return [];
  }
  return [...getBenchmarkCaseV2()];
}

export async function listBenchmarkAttemptsV2(): Promise<BenchmarkAttemptV2[]> {
  if (!isInitialized()) {
    const { needsPassphrase } = await initStore();
    if (needsPassphrase) return [];
  }
  return [...getBenchmarkAttemptsV2()];
}

export async function listBenchmarkArtifacts(): Promise<BenchmarkArtifact[]> {
  if (!isInitialized()) {
    const { needsPassphrase } = await initStore();
    if (needsPassphrase) return [];
  }
  return [...getBenchmarkArtifacts()];
}

export async function listBenchmarkFailures(): Promise<BenchmarkFailure[]> {
  if (!isInitialized()) {
    const { needsPassphrase } = await initStore();
    if (needsPassphrase) return [];
  }
  return [...getBenchmarkFailures()];
}

export async function listBenchmarkVerifierResults(): Promise<
  BenchmarkVerifierResult[]
> {
  if (!isInitialized()) {
    const { needsPassphrase } = await initStore();
    if (needsPassphrase) return [];
  }
  return [...getBenchmarkVerifierResults()];
}

export async function listBenchmarkRunEvents(): Promise<BenchmarkRunEvent[]> {
  if (!isInitialized()) {
    const { needsPassphrase } = await initStore();
    if (needsPassphrase) return [];
  }
  return [...getBenchmarkRunEvents()];
}

export async function listBenchmarkToolCallTraces(): Promise<
  BenchmarkToolCallTrace[]
> {
  if (!isInitialized()) {
    const { needsPassphrase } = await initStore();
    if (needsPassphrase) return [];
  }
  return [...getBenchmarkToolCallTraces()];
}

export async function listBenchmarkTraces(): Promise<BenchmarkModelCallTrace[]> {
  if (!isInitialized()) {
    const { needsPassphrase } = await initStore();
    if (needsPassphrase) return [];
  }
  return [...getBenchmarkTraces()];
}

export async function listBenchmarkTeamCompositions(): Promise<
  BenchmarkTeamComposition[]
> {
  if (!isInitialized()) {
    const { needsPassphrase } = await initStore();
    if (needsPassphrase) return [];
  }
  return [...getBenchmarkTeamCompositions()];
}

export async function listHarnessCertificationResults(): Promise<
  HarnessCertificationResult[]
> {
  if (!isInitialized()) {
    const { needsPassphrase } = await initStore();
    if (needsPassphrase) return [];
  }
  return [...getBenchmarkHarnessCertifications()];
}

export async function saveBenchmarkCase(record: BenchmarkCase): Promise<void> {
  await ensureWritableStore();
  upsertBenchmarkCase(record);
  await persistBenchmarkRunIds(runIdsForCaseId(record.id));
  await flush();
}

export async function saveBenchmarkCaseV2(record: BenchmarkCaseV2): Promise<void> {
  validateBenchmarkCaseV2(record);
  await ensureWritableStore();
  upsertBenchmarkCaseV2(record);
  await persistBenchmarkRunIds(runIdsForCaseId(record.id));
  await flush();
}

export async function saveBenchmarkRun(record: BenchmarkRun): Promise<void> {
  await ensureWritableStore();
  upsertBenchmarkRun(record);
  await persistBenchmarkRunFile(record.id);
  await flush();
}

export async function saveBenchmarkSuite(record: BenchmarkSuite): Promise<void> {
  await ensureWritableStore();
  upsertBenchmarkSuite(record);
  await persistBenchmarkRunIds(
    getBenchmarkRuns()
      .filter((run) => run.suiteId === record.id)
      .map((run) => run.id)
  );
  await flush();
}

export async function saveBenchmarkAttempt(record: BenchmarkAttempt): Promise<void> {
  await ensureWritableStore();
  upsertBenchmarkAttempt(record);
  await persistBenchmarkRunIds(runIdsForRunOrAttempt(record));
  await flush();
}

export async function saveBenchmarkAttemptV2(
  record: BenchmarkAttemptV2
): Promise<void> {
  validateBenchmarkAttemptV2(record);
  await ensureWritableStore();
  upsertBenchmarkAttemptV2(record);
  await persistBenchmarkRunFile(record.runId);
  await flush();
}

export async function saveBenchmarkMetricValue(
  record: BenchmarkMetricValue
): Promise<void> {
  await ensureWritableStore();
  upsertBenchmarkMetricValue(record);
  await persistBenchmarkRunIds(runIdsForRunOrAttempt(record));
  await flush();
}

export async function saveBenchmarkArtifact(
  record: BenchmarkArtifact
): Promise<void> {
  await ensureWritableStore();
  upsertBenchmarkArtifact(record);
  await persistBenchmarkRunIds(runIdsForRunOrAttempt(record));
  await flush();
}

export async function saveBenchmarkFailure(record: BenchmarkFailure): Promise<void> {
  await ensureWritableStore();
  upsertBenchmarkFailure(record);
  await persistBenchmarkRunIds(runIdsForRunOrAttempt(record));
  await flush();
}

export async function saveBenchmarkTrace(
  record: BenchmarkModelCallTrace
): Promise<void> {
  await ensureWritableStore();
  upsertBenchmarkTrace(record);
  await persistBenchmarkRunIds(runIdsForRunOrAttempt(record));
  await flush();
}

export async function saveBenchmarkVerifierResult(
  record: BenchmarkVerifierResult
): Promise<void> {
  validateBenchmarkVerifierResult(record);
  await ensureWritableStore();
  upsertBenchmarkVerifierResult(record);
  await persistBenchmarkRunIds(runIdsForRunOrAttempt(record));
  await flush();
}

export async function saveBenchmarkRunEvent(record: BenchmarkRunEvent): Promise<void> {
  validateBenchmarkRunEvent(record);
  await ensureWritableStore();
  upsertBenchmarkRunEvent(record);
  await persistBenchmarkRunIds(runIdsForRunOrAttempt(record));
  await flush();
}

export async function saveBenchmarkToolCallTrace(
  record: BenchmarkToolCallTrace
): Promise<void> {
  validateBenchmarkToolCallTrace(record);
  await ensureWritableStore();
  upsertBenchmarkToolCallTrace(record);
  await persistBenchmarkRunIds(runIdsForRunOrAttempt(record));
  await flush();
}

export async function saveBenchmarkTeamComposition(
  record: BenchmarkTeamComposition
): Promise<void> {
  validateBenchmarkTeamComposition(record);
  await ensureWritableStore();
  upsertBenchmarkTeamComposition(record);
  await persistBenchmarkRunIds(
    getBenchmarkAttemptsV2()
      .filter((attempt) => attempt.teamCompositionId === record.id)
      .map((attempt) => attempt.runId)
  );
  await flush();
}

export async function saveHarnessCertificationResult(
  record: HarnessCertificationResult
): Promise<void> {
  validateHarnessCertificationResult(record);
  await ensureWritableStore();
  upsertBenchmarkHarnessCertification(record);
  await persistBenchmarkRunIds(
    getBenchmarkAttemptsV2()
      .filter((attempt) => attempt.harnessProfile === record.harnessProfile)
      .map((attempt) => attempt.runId)
  );
  await flush();
}

export interface BenchmarkDeleteSummary {
  runs: number;
  attempts: number;
  verifiers: number;
  artifacts: number;
  failures: number;
  traces: number;
  runEvents: number;
  toolCallTraces: number;
}

export async function deleteBenchmarkAttemptCascade(
  attemptId: string
): Promise<BenchmarkDeleteSummary> {
  return deleteBenchmarkAttemptsCascade([attemptId]);
}

export async function deleteBenchmarkAttemptsCascade(
  attemptIds: string[]
): Promise<BenchmarkDeleteSummary> {
  await ensureWritableStore();
  const uniqueAttemptIds = Array.from(new Set(attemptIds)).filter(Boolean);
  const affectedRunIds = new Set(
    uniqueAttemptIds.flatMap((attemptId) => runIdsForAttemptId(attemptId))
  );
  const summary = createDeleteSummary();
  for (const attemptId of uniqueAttemptIds) {
    addDeleteSummary(summary, deleteBenchmarkAttemptCascadeInMemory(attemptId));
  }
  await persistBenchmarkRunIds(affectedRunIds);
  await flush();
  return summary;
}

export async function deleteBenchmarkRunCascade(
  runId: string
): Promise<BenchmarkDeleteSummary> {
  await ensureWritableStore();
  const run = getBenchmarkRuns().find((record) => record.id === runId);
  const attemptIds = getBenchmarkAttemptsV2()
    .filter((attempt) => attempt.runId === runId)
    .map((attempt) => attempt.id);
  const summary = createDeleteSummary();
  summary.runs += deleteBenchmarkRunById(runId);
  for (const attemptId of attemptIds) {
    addDeleteSummary(summary, deleteBenchmarkAttemptCascadeInMemory(attemptId));
  }
  summary.failures += deleteBenchmarkFailuresByRunId(runId);
  summary.traces += deleteBenchmarkTracesByRunId(runId);
  summary.artifacts += deleteBenchmarkArtifactsByIds(run?.artifactIds ?? []);
  summary.artifacts += deleteBenchmarkArtifactsByRunId(runId);
  await deleteBenchmarkRunBlob(runId);
  await flush();
  return summary;
}

function deleteBenchmarkAttemptCascadeInMemory(
  attemptId: string
): BenchmarkDeleteSummary {
  const artifactIds = new Set<string>();
  const attempt = getBenchmarkAttemptsV2().find((record) => record.id === attemptId);
  for (const artifactId of attempt?.artifactIds ?? []) artifactIds.add(artifactId);
  const verifierResults = getBenchmarkVerifierResults().filter(
    (record) => record.attemptId === attemptId
  );
  for (const verifier of verifierResults) {
    for (const artifactId of verifier.artifactIds) artifactIds.add(artifactId);
  }

  const summary = createDeleteSummary();
  summary.attempts += deleteBenchmarkAttemptV2ById(attemptId);
  summary.verifiers += deleteBenchmarkVerifierResultsByAttemptId(attemptId);
  summary.artifacts += deleteBenchmarkArtifactsByIds(artifactIds);
  summary.artifacts += deleteBenchmarkArtifactsByAttemptId(attemptId);
  summary.failures += deleteBenchmarkFailuresByAttemptId(attemptId);
  summary.traces += deleteBenchmarkTracesByAttemptId(attemptId);
  summary.runEvents += deleteBenchmarkRunEventsByAttemptId(attemptId);
  summary.toolCallTraces += deleteBenchmarkToolCallTracesByAttemptId(attemptId);
  return summary;
}

function createDeleteSummary(): BenchmarkDeleteSummary {
  return {
    runs: 0,
    attempts: 0,
    verifiers: 0,
    artifacts: 0,
    failures: 0,
    traces: 0,
    runEvents: 0,
    toolCallTraces: 0,
  };
}

function addDeleteSummary(
  target: BenchmarkDeleteSummary,
  source: BenchmarkDeleteSummary
): void {
  target.runs += source.runs;
  target.attempts += source.attempts;
  target.verifiers += source.verifiers;
  target.artifacts += source.artifacts;
  target.failures += source.failures;
  target.traces += source.traces;
  target.runEvents += source.runEvents;
  target.toolCallTraces += source.toolCallTraces;
}

async function persistBenchmarkRunIds(runIds: Iterable<string>): Promise<void> {
  for (const runId of Array.from(new Set(Array.from(runIds).filter(Boolean)))) {
    await persistBenchmarkRunFile(runId);
  }
}

async function persistBenchmarkRunFile(runId: string): Promise<void> {
  const bundle = buildBenchmarkRunBundle(runId);
  if (!hasBenchmarkRunEvidence(bundle)) {
    await deleteBenchmarkRunBlob(runId);
    return;
  }
  await saveBenchmarkRunBlob(runId, JSON.stringify(bundle, null, 2));
}

function hasBenchmarkRunEvidence(bundle: BenchmarkReportBundleV2): boolean {
  return (
    bundle.runs.length > 0 ||
    bundle.attempts.length > 0 ||
    bundle.attemptsV2.length > 0 ||
    bundle.traces.length > 0 ||
    bundle.runEvents.length > 0 ||
    bundle.toolCallTraces.length > 0 ||
    bundle.verifierResults.length > 0 ||
    bundle.artifacts.length > 0 ||
    bundle.failures.length > 0
  );
}

function buildBenchmarkRunBundle(runId: string): BenchmarkReportBundleV2 {
  const runs = getBenchmarkRuns().filter((run) => run.id === runId);
  const attempts = getBenchmarkAttempts().filter(
    (attempt) => attempt.runId === runId
  );
  const attemptsV2 = getBenchmarkAttemptsV2().filter(
    (attempt) => attempt.runId === runId
  );
  const attemptIds = new Set([
    ...attempts.map((attempt) => attempt.id),
    ...attemptsV2.map((attempt) => attempt.id),
  ]);
  const caseIds = new Set([
    ...runs.flatMap((run) => run.caseIds),
    ...attempts.map((attempt) => attempt.caseId).filter(isString),
    ...attemptsV2.map((attempt) => attempt.caseId),
  ]);
  const metricValueIds = new Set(runs.flatMap((run) => run.metricValueIds));
  const verifierResults = getBenchmarkVerifierResults().filter((verifier) =>
    attemptIds.has(verifier.attemptId)
  );
  const artifactIds = new Set([
    ...runs.flatMap((run) => run.artifactIds),
    ...attempts.flatMap((attempt) => attempt.artifactIds),
    ...attemptsV2.flatMap((attempt) => attempt.artifactIds),
    ...verifierResults.flatMap((verifier) => verifier.artifactIds),
  ]);
  const failures = getBenchmarkFailures().filter(
    (failure) =>
      failure.runId === runId ||
      (failure.attemptId ? attemptIds.has(failure.attemptId) : false)
  );
  for (const failure of failures) {
    caseIds.add(failure.caseId ?? "");
  }
  const traces = getBenchmarkTraces().filter(
    (trace) =>
      trace.runId === runId ||
      (trace.attemptId ? attemptIds.has(trace.attemptId) : false)
  );
  const runEvents = getBenchmarkRunEvents().filter((event) =>
    attemptIds.has(event.attemptId)
  );
  const toolCallTraces = getBenchmarkToolCallTraces().filter((trace) =>
    attemptIds.has(trace.attemptId)
  );
  const artifacts = getBenchmarkArtifacts().filter(
    (artifact) =>
      artifact.runId === runId ||
      artifactIds.has(artifact.id) ||
      (artifact.attemptId ? attemptIds.has(artifact.attemptId) : false)
  );
  const metricValues = getBenchmarkMetricValues().filter(
    (metric) =>
      metric.runId === runId ||
      metricValueIds.has(metric.id) ||
      (metric.attemptId ? attemptIds.has(metric.attemptId) : false)
  );
  const suiteIds = new Set(runs.map((run) => run.suiteId).filter(isString));
  const teamIds = new Set(attemptsV2.map((attempt) => attempt.teamCompositionId));
  const harnessProfiles = new Set(
    attemptsV2.map((attempt) => attempt.harnessProfile)
  );

  return {
    version: 2,
    exportedAt: new Date().toISOString(),
    suites: getBenchmarkSuites().filter((suite) => suiteIds.has(suite.id)),
    runs,
    cases: getBenchmarkCases().filter((benchmarkCase) =>
      caseIds.has(benchmarkCase.id)
    ),
    attempts,
    metricValues,
    artifacts,
    failures,
    traces,
    caseV2: getBenchmarkCaseV2().filter((benchmarkCase) =>
      caseIds.has(benchmarkCase.id)
    ),
    attemptsV2,
    verifierResults,
    runEvents,
    toolCallTraces,
    teamCompositions: getBenchmarkTeamCompositions().filter((team) =>
      teamIds.has(team.id)
    ),
    harnessCertifications: getBenchmarkHarnessCertifications().filter((cert) =>
      harnessProfiles.has(cert.harnessProfile)
    ),
  };
}

function runIdsForRunOrAttempt(record: {
  runId?: string;
  attemptId?: string;
}): string[] {
  if (record.runId) return [record.runId];
  return record.attemptId ? runIdsForAttemptId(record.attemptId) : [];
}

function runIdsForAttemptId(attemptId: string): string[] {
  return [
    ...getBenchmarkAttempts()
      .filter((attempt) => attempt.id === attemptId)
      .map((attempt) => attempt.runId)
      .filter(isString),
    ...getBenchmarkAttemptsV2()
      .filter((attempt) => attempt.id === attemptId)
      .map((attempt) => attempt.runId),
  ];
}

function runIdsForCaseId(caseId: string): string[] {
  return [
    ...getBenchmarkRuns()
      .filter((run) => run.caseIds.includes(caseId))
      .map((run) => run.id),
    ...getBenchmarkAttempts()
      .filter((attempt) => attempt.caseId === caseId)
      .map((attempt) => attempt.runId)
      .filter(isString),
    ...getBenchmarkAttemptsV2()
      .filter((attempt) => attempt.caseId === caseId)
      .map((attempt) => attempt.runId),
  ];
}

function isString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

export function exportBenchmarkReportBundleV2(): BenchmarkReportBundleV2 {
  const bundle: Omit<BenchmarkReportBundleV2, "bundleHash" | "redactionSummary"> = {
    version: 2,
    exportedAt: new Date().toISOString(),
    suites: [...getBenchmarkSuites()],
    runs: [...getBenchmarkRuns()],
    cases: [...getBenchmarkCases()],
    attempts: [...getBenchmarkAttempts()],
    metricValues: [...getBenchmarkMetricValues()],
    artifacts: [...getBenchmarkArtifacts()],
    failures: [...getBenchmarkFailures()],
    traces: [...getBenchmarkTraces()],
    caseV2: [...getBenchmarkCaseV2()],
    attemptsV2: [...getBenchmarkAttemptsV2()],
    verifierResults: [...getBenchmarkVerifierResults()],
    runEvents: [...getBenchmarkRunEvents()],
    toolCallTraces: [...getBenchmarkToolCallTraces()],
    teamCompositions: [...getBenchmarkTeamCompositions()],
    harnessCertifications: [...getBenchmarkHarnessCertifications()],
    sourceEvidence: {
      gameMatches: [...getGenericGameMatchRecords()],
      buildCheckpoints: [...getBuildCheckpoints()],
      buildStats: getModelStats(),
    },
  };
  const redacted = redactBenchmarkBundle(bundle);

  return { ...redacted, bundleHash: hashBenchmarkBundle(redacted) };
}

export interface BenchmarkImportResult {
  addedCount: number;
  updatedCount: number;
  addedByCategory: Record<string, number>;
  updatedByCategory: Record<string, number>;
  hashMismatch: boolean;
}

export async function importBenchmarkReportBundleV2(
  bundle: BenchmarkReportBundleV2
): Promise<BenchmarkImportResult> {
  validateBenchmarkReportBundleV2(bundle);
  const verification = verifyBenchmarkBundleHash(bundle);
  const result = await mergeBenchmarkReportBundle(bundle);
  return { ...result, hashMismatch: !verification.ok };
}

async function mergeBenchmarkReportBundle(
  bundle: BenchmarkReportBundleV2
): Promise<BenchmarkImportResult> {
  await ensureWritableStore();
  const current = exportStore();
  const importResult = summarizeBenchmarkImport(current, bundle);
  const next: Partial<ClientStore> = {
    benchmarkSuites: mergeByIdKeepExisting(current.benchmarkSuites ?? [], bundle.suites),
    benchmarkRuns: mergeByIdPreferNewer(
      current.benchmarkRuns ?? [],
      bundle.runs,
      completedOrStartedAt
    ),
    benchmarkCases: mergeByIdPreferNewer(
      current.benchmarkCases ?? [],
      bundle.cases,
      (record) => record.updatedAt || record.createdAt
    ),
    benchmarkAttempts: mergeByIdPreferNewer(
      current.benchmarkAttempts ?? [],
      bundle.attempts,
      completedOrStartedAt
    ),
    benchmarkMetricValues: mergeByIdKeepExisting(
      current.benchmarkMetricValues ?? [],
      bundle.metricValues
    ),
    benchmarkArtifacts: mergeByIdPreferNewer(
      current.benchmarkArtifacts ?? [],
      bundle.artifacts,
      (record) => record.createdAt
    ),
    benchmarkFailures: mergeByIdPreferNewer(
      current.benchmarkFailures ?? [],
      bundle.failures,
      (record) => record.createdAt
    ),
    benchmarkTraces: mergeByIdPreferNewer(
      current.benchmarkTraces ?? [],
      bundle.traces,
      completedOrStartedAt
    ),
    gameMatchRecords: mergeByIdKeepExisting(
      current.gameMatchRecords ?? [],
      bundle.sourceEvidence?.gameMatches ?? []
    ),
    buildCheckpoints: mergeByKeyPreferNewer(
      current.buildCheckpoints ?? [],
      bundle.sourceEvidence?.buildCheckpoints ?? [],
      (checkpoint) => checkpoint.discussionId,
      (checkpoint) => checkpoint.updatedAt
    ),
    // Model stats are cumulative aggregates; updatedAt is the best available
    // proportional import heuristic short of re-aggregating raw build evidence.
    modelStats: mergeByKeyPreferNewer(
      current.modelStats ?? [],
      bundle.sourceEvidence?.buildStats ?? [],
      (stat) => stat.modelId,
      (stat) => stat.updatedAt
    ),
  };

  next.benchmarkCaseV2 = mergeByIdPreferNewer(
    current.benchmarkCaseV2 ?? [],
    bundle.caseV2,
    (record) => record.updatedAt || record.createdAt
  );
  next.benchmarkAttemptsV2 = mergeByIdPreferNewer(
    current.benchmarkAttemptsV2 ?? [],
    bundle.attemptsV2,
    completedOrStartedAt
  );
  next.benchmarkVerifierResults = mergeByIdKeepExisting(
    current.benchmarkVerifierResults ?? [],
    bundle.verifierResults
  );
  next.benchmarkRunEvents = mergeByIdPreferNewer(
    current.benchmarkRunEvents ?? [],
    bundle.runEvents,
    (record) => record.at
  );
  next.benchmarkToolCallTraces = mergeByIdPreferNewer(
    current.benchmarkToolCallTraces ?? [],
    bundle.toolCallTraces,
    completedOrStartedAt
  );
  next.benchmarkTeamCompositions = mergeByIdKeepExisting(
    current.benchmarkTeamCompositions ?? [],
    bundle.teamCompositions
  );
  next.benchmarkHarnessCertifications = mergeByIdPreferNewer(
    current.benchmarkHarnessCertifications ?? [],
    bundle.harnessCertifications,
    (record) => record.createdAt
  );

  replaceStore({ ...current, ...next });
  await persistBenchmarkRunIds(bundle.runs.map((run) => run.id));
  await persistBenchmarkRunIds(
    bundle.attempts.map((attempt) => attempt.runId).filter(isString)
  );
  await persistBenchmarkRunIds(bundle.attemptsV2.map((attempt) => attempt.runId));
  await flush();
  return importResult;
}

function hashBenchmarkBundle(
  bundle: Omit<BenchmarkReportBundleV2, "bundleHash">
): string {
  const stable = stableStringify(bundle);
  let hash = 2166136261;
  for (let i = 0; i < stable.length; i++) {
    hash ^= stable.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return `fnv1a:${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

export function verifyBenchmarkBundleHash(
  bundle: BenchmarkReportBundleV2
): { ok: boolean; expected: string; actual: string | null } {
  const actual = bundle.bundleHash ?? null;
  const expected = hashBenchmarkBundle(
    bundle as Omit<BenchmarkReportBundleV2, "bundleHash">
  );
  return { ok: actual === null || actual === expected, expected, actual };
}

function stableStringify(value: unknown): string {
  return JSON.stringify(stableNormalize(value));
}

function stableNormalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableNormalize);
  if (!isPlainObject(value)) return value;

  const normalized: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    if (key === "bundleHash") continue;
    const normalizedValue = stableNormalize(value[key]);
    if (normalizedValue !== undefined) normalized[key] = normalizedValue;
  }
  return normalized;
}

function validateBenchmarkReportBundleV2(bundle: BenchmarkReportBundleV2): void {
  validateBenchmarkReportBundleBase(bundle);
  validateArrayWithStringKey("caseV2", bundle.caseV2, "id");
  validateArrayWithStringKey("attemptsV2", bundle.attemptsV2, "id");
  validateArrayWithStringKey("verifierResults", bundle.verifierResults, "id");
  validateArrayWithStringKey("runEvents", bundle.runEvents, "id");
  validateArrayWithStringKey("toolCallTraces", bundle.toolCallTraces, "id");
  validateArrayWithStringKey("teamCompositions", bundle.teamCompositions, "id");
  validateArrayWithStringKey(
    "harnessCertifications",
    bundle.harnessCertifications,
    "id"
  );

  for (const record of bundle.caseV2) validateBenchmarkCaseV2(record);
  for (const record of bundle.attemptsV2) validateBenchmarkAttemptV2(record);
  for (const record of bundle.verifierResults) {
    validateBenchmarkVerifierResult(record);
  }
  for (const record of bundle.runEvents) {
    validateBenchmarkRunEvent(record);
  }
  for (const record of bundle.toolCallTraces) {
    validateBenchmarkToolCallTrace(record);
  }
  for (const record of bundle.teamCompositions) {
    validateBenchmarkTeamComposition(record);
  }
  for (const record of bundle.harnessCertifications) {
    validateHarnessCertificationResult(record);
  }

  if (bundle.bundleHash !== undefined && typeof bundle.bundleHash !== "string") {
    throw new Error("Invalid bundleHash in benchmark report bundle.");
  }

  if (bundle.redactionSummary !== undefined) {
    validateRedactionSummary(bundle.redactionSummary);
  }
}

function validateBenchmarkReportBundleBase(
  bundle: BenchmarkReportBundleV2
): void {
  if (!bundle || typeof bundle !== "object") {
    throw new Error("Invalid benchmark report bundle.");
  }

  if (bundle.version !== 2) {
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

  for (const artifact of bundle.artifacts as BenchmarkArtifact[]) {
    if (
      typeof artifact.content !== "string" ||
      typeof artifact.label !== "string" ||
      typeof artifact.mimeType !== "string"
    ) {
      throw new Error("Invalid artifacts record in benchmark report bundle.");
    }
  }

  for (const trace of bundle.traces as BenchmarkModelCallTrace[]) {
    validateBenchmarkModelCallTrace(trace);
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

const CERTIFIED_ATTEMPT_STATUSES = new Set<CertifiedAttemptStatus>([
  "passed",
  "failed_model",
  "failed_verifier",
  "failed_tool_use",
  "failed_budget",
  "provider_unavailable",
  "invalid_harness",
  "invalid_environment",
  "invalid_case",
  "aborted_user",
]);

const BENCHMARK_TRACKS = new Set<BenchmarkCaseV2["track"]>([
  "workbench",
  "gameiq",
  "teamiq",
  "toolreliability",
  "harnessbench",
]);
const BENCHMARK_MODES = new Set<BenchmarkAttemptV2["mode"]>([
  "lab",
  "certified",
  "publish",
]);
const HARNESS_PROFILES = new Set<BenchmarkAttemptV2["harnessProfile"]>([
  "raw-single-model",
  "aiboard-single-model",
  "aiboard-panel",
  "aiboard-debate",
  "aiboard-specialist",
  "aiboard-build-single-worker",
  "aiboard-build-multi-worker",
  "external-mini-swe-agent",
  "external-custom",
]);
const CASE_DIFFICULTIES = new Set<BenchmarkCaseV2["difficulty"]>([
  "easy",
  "medium",
  "hard",
  "expert",
]);
const CASE_ENVIRONMENT_TYPES = new Set<BenchmarkCaseV2["environment"]["type"]>([
  "browser",
  "local-runner",
  "docker",
  "modal",
  "github-actions",
]);
const CASE_NETWORK_MODES = new Set<BenchmarkCaseV2["environment"]["network"]>([
  "none",
  "dependency-only",
  "open",
]);
const CASE_VERIFIER_SCORERS = new Set<BenchmarkCaseV2["verifier"]["scorer"]>([
  "verifier-json",
  "game-engine",
  "rule-checker",
]);
const CASE_SCORING_PRIMARIES = new Set<BenchmarkCaseV2["scoring"]["primary"]>([
  "verified_quality",
  "game_iq",
  "team_lift",
  "tool_reliability",
]);
const TEAM_ROLES = new Set<BenchmarkTeamComposition["roles"][number]["role"]>([
  "single",
  "architect",
  "worker",
  "reviewer",
  "critic",
  "judge",
  "player",
  "specialist",
]);
const TEAM_IQ_STRATEGIES = new Set<NonNullable<BenchmarkTeamComposition["strategy"]>>([
  "solo",
  "panel",
  "debate",
  "architect_worker",
  "architect_worker_reviewer",
  "cheap_swarm_strong_judge",
]);
const BENCHMARK_RUN_EVENT_TYPES = new Set<BenchmarkRunEvent["type"]>([
  "model_call_started",
  "model_call_completed",
  "model_call_failed",
  "tool_call_started",
  "tool_call_completed",
  "tool_call_blocked",
  "verifier_started",
  "verifier_completed",
  "run_blocked",
  "run_failed",
]);
const BENCHMARK_TOOL_TRACE_STATUSES = new Set<BenchmarkToolCallTrace["status"]>([
  "ok",
  "failed",
  "blocked",
  "denied",
]);

function validateBenchmarkCaseV2(record: BenchmarkCaseV2): void {
  if (!isPlainObject(record)) {
    throw new Error("Invalid caseV2 record in benchmark report bundle.");
  }

  if (!BENCHMARK_TRACKS.has(record.track)) {
    throw new Error("Invalid caseV2 track in benchmark report bundle.");
  }

  if (!CASE_DIFFICULTIES.has(record.difficulty)) {
    throw new Error("Invalid caseV2 difficulty in benchmark report bundle.");
  }

  if (
    !isNonEmptyString(record.id) ||
    record.schemaVersion !== 2 ||
    !BENCHMARK_TRACKS.has(record.track) ||
    !isNonEmptyString(record.title) ||
    !isNonEmptyString(record.description) ||
    !CASE_DIFFICULTIES.has(record.difficulty) ||
    !isStringArray(record.tags) ||
    !isNonEmptyString(record.caseVersion) ||
    !isNonEmptyString(record.createdAt) ||
    !isNonEmptyString(record.updatedAt)
  ) {
    throw new Error("Invalid caseV2 record in benchmark report bundle.");
  }

  if (
    !isPlainObject(record.prompt) ||
    !isNonEmptyString(record.prompt.userRequest) ||
    !isOptionalString(record.prompt.publicContext) ||
    !isOptionalString(record.prompt.hiddenNotesHash) ||
    !isOptionalString(record.prompt.systemPromptHash) ||
    (record.prompt.attachmentIds !== undefined &&
      !isStringArray(record.prompt.attachmentIds))
  ) {
    throw new Error("Invalid caseV2 prompt in benchmark report bundle.");
  }

  if (
    record.repo !== undefined &&
    (!isPlainObject(record.repo) ||
      !isNonEmptyString(record.repo.url) ||
      !isNonEmptyString(record.repo.baseCommit) ||
      !isOptionalString(record.repo.fixtureHash) ||
      typeof record.repo.shallowClone !== "boolean")
  ) {
    throw new Error("Invalid caseV2 repo in benchmark report bundle.");
  }

  if (
    !isPlainObject(record.environment) ||
    !CASE_ENVIRONMENT_TYPES.has(record.environment.type) ||
    !isFiniteNumber(record.environment.timeoutSeconds) ||
    !isOptionalFiniteNumber(record.environment.memoryMb) ||
    !CASE_NETWORK_MODES.has(record.environment.network) ||
    !isOptionalString(record.environment.image) ||
    !isOptionalString(record.environment.imageDigest) ||
    !isOptionalString(record.environment.setupCommand)
  ) {
    throw new Error("Invalid caseV2 environment in benchmark report bundle.");
  }

  if (
    !isPlainObject(record.verifier) ||
    !CASE_VERIFIER_SCORERS.has(record.verifier.scorer) ||
    !isOptionalString(record.verifier.command) ||
    !isOptionalString(record.verifier.resultFile) ||
    !isOptionalString(record.verifier.publicCommand) ||
    !isOptionalString(record.verifier.hiddenCommandHash) ||
    !isOptionalFiniteNumber(record.verifier.timeoutSeconds)
  ) {
    throw new Error("Invalid caseV2 verifier in benchmark report bundle.");
  }

  if (
    !isPlainObject(record.budget) ||
    !hasOnlyOptionalFiniteNumbers(record.budget, [
      "maxUsd",
      "maxWallClockSeconds",
      "maxModelCalls",
      "maxToolCalls",
      "maxInputTokens",
      "maxOutputTokens",
    ])
  ) {
    throw new Error("Invalid caseV2 budget in benchmark report bundle.");
  }

  if (
    !isPlainObject(record.scoring) ||
    !isNonEmptyString(record.scoring.scoringVersion) ||
    !CASE_SCORING_PRIMARIES.has(record.scoring.primary) ||
    !isOptionalFiniteNumber(record.scoring.costTargetUsd) ||
    !isOptionalFiniteNumber(record.scoring.timeTargetSeconds)
  ) {
    throw new Error("Invalid caseV2 scoring in benchmark report bundle.");
  }

  if (
    !isPlainObject(record.contamination) ||
    typeof record.contamination.originalTask !== "boolean" ||
    typeof record.contamination.referenceSolutionPrivate !== "boolean" ||
    !isNonEmptyString(record.contamination.canary) ||
    !isOptionalString(record.contamination.publicAfter)
  ) {
    throw new Error("Invalid caseV2 contamination in benchmark report bundle.");
  }
}

function validateBenchmarkAttemptV2(record: BenchmarkAttemptV2): void {
  if (!isPlainObject(record)) {
    throw new Error("Invalid attemptsV2 record in benchmark report bundle.");
  }

  if (!CERTIFIED_ATTEMPT_STATUSES.has(record.status)) {
    throw new Error("Invalid attempt status in benchmark report bundle.");
  }

  if (!BENCHMARK_MODES.has(record.mode)) {
    throw new Error("Invalid attempt mode in benchmark report bundle.");
  }

  if (!BENCHMARK_TRACKS.has(record.track)) {
    throw new Error("Invalid attempt track in benchmark report bundle.");
  }

  if (!HARNESS_PROFILES.has(record.harnessProfile)) {
    throw new Error("Invalid attempt harness profile in benchmark report bundle.");
  }

  if (
    !isNonEmptyString(record.id) ||
    !isNonEmptyString(record.runId) ||
    !isNonEmptyString(record.caseId) ||
    !isNonEmptyString(record.teamCompositionId) ||
    !isNonEmptyString(record.startedAt) ||
    !isOptionalString(record.completedAt) ||
    !isFiniteNumber(record.verifiedQuality) ||
    !isFiniteNumber(record.jobSuccessScore) ||
    !isFiniteNumber(record.efficiencyScore) ||
    !isOptionalFiniteNumber(record.gameIqScore) ||
    !isOptionalFiniteNumber(record.teamLift) ||
    !isOptionalFiniteNumber(record.toolReliabilityScore) ||
    !(record.costUsd === null || isFiniteNumber(record.costUsd)) ||
    !isFiniteNumber(record.inputTokens) ||
    !isFiniteNumber(record.outputTokens) ||
    !isFiniteNumber(record.modelCalls) ||
    !isFiniteNumber(record.toolCalls) ||
    !isFiniteNumber(record.durationMs) ||
    !isOptionalString(record.verifierResultId) ||
    !isStringArray(record.artifactIds) ||
    !isStringArray(record.traceIds) ||
    !isStringArray(record.failureIds) ||
    !isNonEmptyString(record.harnessVersion) ||
    !isNonEmptyString(record.promptSetVersion) ||
    !isNonEmptyString(record.scoringVersion)
  ) {
    throw new Error("Invalid attemptsV2 record in benchmark report bundle.");
  }
}

function validateBenchmarkVerifierResult(
  record: BenchmarkVerifierResult
): void {
  if (!isPlainObject(record)) {
    throw new Error("Invalid verifier result in benchmark report bundle.");
  }

  if (
    !isNonEmptyString(record.id) ||
    !isNonEmptyString(record.attemptId) ||
    !isNonEmptyString(record.caseId) ||
    !isOptionalString(record.command) ||
    typeof record.passed !== "boolean" ||
    !isFiniteNumber(record.score) ||
    !isFiniteNumber(record.durationMs) ||
    !isOptionalFiniteNumber(record.exitCode) ||
    !isOptionalString(record.stdoutPreview) ||
    !isOptionalString(record.stderrPreview) ||
    typeof record.resultJson !== "string" ||
    !isJsonObjectString(record.resultJson) ||
    !Array.isArray(record.assertionResults) ||
    !record.assertionResults.every(isVerifierAssertionResult) ||
    !isStringArray(record.artifactIds)
  ) {
    throw new Error("Invalid verifier result in benchmark report bundle.");
  }
}

function validateBenchmarkRunEvent(record: BenchmarkRunEvent): void {
  if (!isPlainObject(record)) {
    throw new Error("Invalid benchmark run event in benchmark report bundle.");
  }

  if (
    !isNonEmptyString(record.id) ||
    !isNonEmptyString(record.attemptId) ||
    !isNonEmptyString(record.caseId) ||
    !BENCHMARK_RUN_EVENT_TYPES.has(record.type) ||
    !isNonEmptyString(record.phase) ||
    !isNonEmptyString(record.at) ||
    !isNonEmptyString(record.message) ||
    !isOptionalString(record.modelId) ||
    !isOptionalString(record.providerId) ||
    !isOptionalJsonObjectString(record.detailsJson)
  ) {
    throw new Error("Invalid benchmark run event in benchmark report bundle.");
  }
}

function validateBenchmarkToolCallTrace(record: BenchmarkToolCallTrace): void {
  if (!isPlainObject(record)) {
    throw new Error("Invalid benchmark tool trace in benchmark report bundle.");
  }

  if (
    !isNonEmptyString(record.id) ||
    !isNonEmptyString(record.attemptId) ||
    !isNonEmptyString(record.caseId) ||
    !isNonEmptyString(record.toolName) ||
    !isOptionalString(record.command) ||
    !BENCHMARK_TOOL_TRACE_STATUSES.has(record.status) ||
    !isNonEmptyString(record.startedAt) ||
    !isOptionalString(record.completedAt) ||
    !isOptionalFiniteNumber(record.durationMs) ||
    !isOptionalJsonObjectString(record.inputJson) ||
    !isOptionalString(record.outputPreview) ||
    !isOptionalString(record.error)
  ) {
    throw new Error("Invalid benchmark tool trace in benchmark report bundle.");
  }
}

function validateBenchmarkModelCallTrace(record: BenchmarkModelCallTrace): void {
  if (!isPlainObject(record)) {
    throw new Error("Invalid benchmark trace in benchmark report bundle.");
  }

  if (
    !isNonEmptyString(record.id) ||
    !isOptionalString(record.runId) ||
    !isOptionalString(record.caseId) ||
    !isOptionalString(record.attemptId) ||
    !isNonEmptyString(record.modelId) ||
    !isNonEmptyString(record.providerId) ||
    !isOptionalString(record.participantId) ||
    !isOptionalString(record.reasoningEffort) ||
    !isOptionalString(record.schemaMode) ||
    !isOptionalString(record.promptHash) ||
    !isNonEmptyString(record.startedAt) ||
    !isOptionalString(record.completedAt) ||
    !isOptionalFiniteNumber(record.latencyMs) ||
    !isOptionalFiniteNumber(record.inputTokens) ||
    !isOptionalFiniteNumber(record.outputTokens) ||
    !isOptionalFiniteNumber(record.totalTokens) ||
    !isOptionalString(record.usageSource) ||
    !isOptionalFiniteNumber(record.reasoningTokens) ||
    !isOptionalFiniteNumber(record.cachedInputTokens) ||
    !isOptionalFiniteNumber(record.cacheWriteInputTokens) ||
    !isOptionalFiniteNumber(record.inputAudioTokens) ||
    !isOptionalFiniteNumber(record.outputAudioTokens) ||
    !isOptionalFiniteNumber(record.providerCost) ||
    !isOptionalString(record.providerCostUnit) ||
    !(record.estimatedUsd === undefined ||
      record.estimatedUsd === null ||
      isFiniteNumber(record.estimatedUsd)) ||
    !isOptionalString(record.rawResponse) ||
    !isOptionalString(record.parsedResponseJson) ||
    !Array.isArray(record.retryHistory) ||
    !record.retryHistory.every(isBenchmarkModelCallTraceAttempt) ||
    !isOptionalString(record.fallbackReason) ||
    !isOptionalString(record.error)
  ) {
    throw new Error("Invalid benchmark trace in benchmark report bundle.");
  }
}

function isBenchmarkModelCallTraceAttempt(value: unknown): boolean {
  if (!isPlainObject(value)) return false;
  return (
    isFiniteNumber(value.attempt) &&
    (value.status === "parsed" ||
      value.status === "parse_error" ||
      value.status === "illegal" ||
      value.status === "provider_error") &&
    typeof value.message === "string" &&
    isOptionalString(value.rawResponse) &&
    isOptionalString(value.parsedJson) &&
    isOptionalFiniteNumber(value.latencyMs)
  );
}

function validateBenchmarkTeamComposition(
  record: BenchmarkTeamComposition
): void {
  if (
    !isPlainObject(record) ||
    !isNonEmptyString(record.id) ||
    !isNonEmptyString(record.name) ||
    !isNonEmptyString(record.comboHash) ||
    (record.strategy !== undefined && !TEAM_IQ_STRATEGIES.has(record.strategy)) ||
    !Array.isArray(record.roles) ||
    record.roles.length === 0 ||
    !record.roles.every(isTeamCompositionRole)
  ) {
    throw new Error("Invalid team composition in benchmark report bundle.");
  }
}

function validateHarnessCertificationResult(
  record: HarnessCertificationResult
): void {
  if (
    !isPlainObject(record) ||
    !isNonEmptyString(record.id) ||
    !isNonEmptyString(record.createdAt) ||
    !isNonEmptyString(record.aiboardVersion) ||
    !isNonEmptyString(record.benchmarkEngineVersion) ||
    !HARNESS_PROFILES.has(record.harnessProfile) ||
    !isNonEmptyString(record.harnessVersion) ||
    !isNonEmptyString(record.promptSetVersion) ||
    typeof record.passed !== "boolean" ||
    !Array.isArray(record.checks) ||
    !record.checks.every(isHarnessCertificationCheck) ||
    (record.artifactIds !== undefined && !isStringArray(record.artifactIds))
  ) {
    throw new Error("Invalid harness certification in benchmark report bundle.");
  }
}

function validateRedactionSummary(
  value: BenchmarkReportBundleV2["redactionSummary"]
): void {
  if (
    !isPlainObject(value) ||
    !isFiniteNumber(value.scannedArtifacts) ||
    !isFiniteNumber(value.redactedSecrets) ||
    !isStringArray(value.warnings)
  ) {
    throw new Error("Invalid redactionSummary in benchmark report bundle.");
  }
}

function isVerifierAssertionResult(value: unknown): boolean {
  if (!isPlainObject(value)) return false;
  return (
    isNonEmptyString(value.id) &&
    isNonEmptyString(value.label) &&
    typeof value.passed === "boolean" &&
    isFiniteNumber(value.weight) &&
    isOptionalString(value.message) &&
    isOptionalString(value.details)
  );
}

function isTeamCompositionRole(value: unknown): boolean {
  if (!isPlainObject(value)) return false;
  return (
    TEAM_ROLES.has(value.role as BenchmarkTeamComposition["roles"][number]["role"]) &&
    isNonEmptyString(value.slot) &&
    isNonEmptyString(value.modelId) &&
    isNonEmptyString(value.providerId) &&
    isNonEmptyString(value.displayName) &&
    isOptionalString(value.reasoningEffort) &&
    isFiniteNumber(value.temperature) &&
    isOptionalFiniteNumber(value.maxTokens)
  );
}

function isHarnessCertificationCheck(value: unknown): boolean {
  if (!isPlainObject(value)) return false;
  return (
    isNonEmptyString(value.id) &&
    isNonEmptyString(value.label) &&
    typeof value.passed === "boolean" &&
    isOptionalString(value.message) &&
    isOptionalString(value.detailsJson)
  );
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

function isBuildTaskGuidanceRecord(value: unknown): boolean {
  if (!isPlainObject(value)) return false;
  const status = value.status;
  const hasValidOptionalAnswer =
    value.answer === undefined || typeof value.answer === "string";
  const hasRequiredAnsweredAnswer =
    status !== "answered" ||
    (typeof value.answer === "string" && value.answer.trim().length > 0);
  return (
    typeof value.id === "string" &&
    typeof value.taskId === "string" &&
    (value.mode === "blocking" || value.mode === "async") &&
    typeof value.question === "string" &&
    (value.reason === undefined || typeof value.reason === "string") &&
    (status === "pending" || status === "answered") &&
    hasValidOptionalAnswer &&
    hasRequiredAnsweredAnswer &&
    (value.requestedBy === undefined ||
      typeof value.requestedBy === "string") &&
    typeof value.requestedAtWave === "number" &&
    (value.answeredAtWave === undefined ||
      typeof value.answeredAtWave === "number")
  );
}

function isBuildTaskGuidanceArray(value: unknown): boolean {
  return Array.isArray(value) && value.every(isBuildTaskGuidanceRecord);
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
    (value.avoidWorkerIndexes === undefined ||
      isNumberArray(value.avoidWorkerIndexes)) &&
    (value.difficulty === undefined || typeof value.difficulty === "number") &&
    (value.guidance === undefined || isBuildTaskGuidanceArray(value.guidance))
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

function isOptionalJsonObjectString(value: unknown): boolean {
  return (
    value === undefined ||
    (typeof value === "string" && isJsonObjectString(value))
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isOptionalString(value: unknown): boolean {
  return value === undefined || typeof value === "string";
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isOptionalFiniteNumber(value: unknown): boolean {
  return value === undefined || isFiniteNumber(value);
}

function hasOnlyOptionalFiniteNumbers(value: unknown, keys: string[]): boolean {
  if (!isPlainObject(value)) return false;
  return keys.every((key) => isOptionalFiniteNumber(value[key]));
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

function mergeByIdKeepExisting<T extends { id: string }>(
  current: T[],
  incoming: T[]
): T[] {
  const map = new Map(current.map((item) => [item.id, item]));
  for (const item of incoming) {
    if (!map.has(item.id)) map.set(item.id, item);
  }
  return Array.from(map.values());
}

function mergeByIdPreferNewer<T extends { id: string }>(
  current: T[],
  incoming: T[],
  tsFor: (item: T) => string | undefined
): T[] {
  const map = new Map(current.map((item) => [item.id, item]));
  for (const item of incoming) {
    const existing = map.get(item.id);
    if (!existing || isSameOrNewerTimestamp(tsFor(item), tsFor(existing))) {
      map.set(item.id, item);
    }
  }
  return Array.from(map.values());
}

function mergeByKeyPreferNewer<T>(
  current: T[],
  incoming: T[],
  keyFor: (item: T) => string,
  tsFor: (item: T) => string
): T[] {
  const map = new Map(current.map((item) => [keyFor(item), item]));
  for (const item of incoming) {
    const key = keyFor(item);
    const existing = map.get(key);
    if (!existing || tsFor(item) >= tsFor(existing)) map.set(key, item);
  }
  return Array.from(map.values());
}

function completedOrStartedAt(record: {
  completedAt?: string;
  startedAt?: string;
}): string | undefined {
  return record.completedAt ?? record.startedAt;
}

function isSameOrNewerTimestamp(
  incoming: string | undefined,
  existing: string | undefined
): boolean {
  if (!existing) return true;
  if (!incoming) return false;
  const incomingMs = Date.parse(incoming);
  const existingMs = Date.parse(existing);
  if (Number.isFinite(incomingMs) && Number.isFinite(existingMs)) {
    return incomingMs >= existingMs;
  }
  return incoming >= existing;
}

function summarizeBenchmarkImport(
  current: ClientStore,
  bundle: BenchmarkReportBundleV2
): BenchmarkImportResult {
  const result: BenchmarkImportResult = {
    addedCount: 0,
    updatedCount: 0,
    addedByCategory: {},
    updatedByCategory: {},
    hashMismatch: false,
  };

  countById(result, "suites", current.benchmarkSuites ?? [], bundle.suites);
  countById(result, "runs", current.benchmarkRuns ?? [], bundle.runs);
  countById(result, "cases", current.benchmarkCases ?? [], bundle.cases);
  countById(result, "attempts", current.benchmarkAttempts ?? [], bundle.attempts);
  countById(
    result,
    "metricValues",
    current.benchmarkMetricValues ?? [],
    bundle.metricValues
  );
  countById(
    result,
    "artifacts",
    current.benchmarkArtifacts ?? [],
    bundle.artifacts
  );
  countById(result, "failures", current.benchmarkFailures ?? [], bundle.failures);
  countById(result, "traces", current.benchmarkTraces ?? [], bundle.traces);
  countById(
    result,
    "gameMatches",
    current.gameMatchRecords ?? [],
    bundle.sourceEvidence?.gameMatches ?? []
  );
  countByKeyPreferNewer(
    result,
    "buildCheckpoints",
    current.buildCheckpoints ?? [],
    bundle.sourceEvidence?.buildCheckpoints ?? [],
    (checkpoint) => checkpoint.discussionId,
    (checkpoint) => checkpoint.updatedAt
  );
  countByKeyPreferNewer(
    result,
    "modelStats",
    current.modelStats ?? [],
    bundle.sourceEvidence?.buildStats ?? [],
    (stat) => stat.modelId,
    (stat) => stat.updatedAt
  );
  countById(result, "caseV2", current.benchmarkCaseV2 ?? [], bundle.caseV2);
  countById(
    result,
    "attemptsV2",
    current.benchmarkAttemptsV2 ?? [],
    bundle.attemptsV2
  );
  countById(
    result,
    "verifierResults",
    current.benchmarkVerifierResults ?? [],
    bundle.verifierResults
  );
  countById(
    result,
    "runEvents",
    current.benchmarkRunEvents ?? [],
    bundle.runEvents
  );
  countById(
    result,
    "toolCallTraces",
    current.benchmarkToolCallTraces ?? [],
    bundle.toolCallTraces
  );
  countById(
    result,
    "teamCompositions",
    current.benchmarkTeamCompositions ?? [],
    bundle.teamCompositions
  );
  countById(
    result,
    "harnessCertifications",
    current.benchmarkHarnessCertifications ?? [],
    bundle.harnessCertifications
  );

  return result;
}

function countById<T extends { id: string }>(
  result: BenchmarkImportResult,
  category: string,
  current: T[],
  incoming: T[]
): void {
  countByKey(result, category, current, incoming, (item) => item.id);
}

function countByKey<T>(
  result: BenchmarkImportResult,
  category: string,
  current: T[],
  incoming: T[],
  keyFor: (item: T) => string
): void {
  const existing = new Set(current.map(keyFor));
  for (const item of incoming) {
    incrementImportCount(result, category, existing.has(keyFor(item)) ? "updated" : "added");
  }
}

function countByKeyPreferNewer<T>(
  result: BenchmarkImportResult,
  category: string,
  current: T[],
  incoming: T[],
  keyFor: (item: T) => string,
  tsFor: (item: T) => string
): void {
  const existing = new Map(current.map((item) => [keyFor(item), item]));
  for (const item of incoming) {
    const currentItem = existing.get(keyFor(item));
    if (!currentItem) {
      incrementImportCount(result, category, "added");
    } else if (tsFor(item) >= tsFor(currentItem)) {
      incrementImportCount(result, category, "updated");
    }
  }
}

function incrementImportCount(
  result: BenchmarkImportResult,
  category: string,
  kind: "added" | "updated"
): void {
  if (kind === "added") {
    result.addedCount += 1;
    result.addedByCategory[category] =
      (result.addedByCategory[category] ?? 0) + 1;
  } else {
    result.updatedCount += 1;
    result.updatedByCategory[category] =
      (result.updatedByCategory[category] ?? 0) + 1;
  }
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
