import {
  listBenchmarkAttemptsV2,
  listBenchmarkCaseV2,
  listBenchmarkRuns,
  listBenchmarkTeamCompositions,
  listBenchmarkVerifierResults,
  listHarnessCertificationResults,
  saveBenchmarkArtifact,
  saveBenchmarkAttemptV2,
  saveBenchmarkFailure,
  saveBenchmarkRun,
  saveBenchmarkRunEvent,
  saveBenchmarkTeamComposition,
  saveBenchmarkToolCallTrace,
  saveBenchmarkTrace,
  saveBenchmarkVerifierResult,
} from "@/lib/benchmark/store";
import { buildCertifiedBenchmarkDashboardData } from "@/lib/benchmark/metrics";
import type {
  BenchmarkArtifact,
  BenchmarkAttemptV2,
  BenchmarkFailure,
  BenchmarkModelCallTrace,
  BenchmarkRun,
  BenchmarkRunEvent,
  BenchmarkTeamComposition,
  BenchmarkToolCallTrace,
  BenchmarkVerifierResult,
} from "@/lib/benchmark/types";
import type {
  CertifiedRunBudget,
  CertifiedRunPersistenceSnapshot,
  PersistentCertifiedRunContext,
} from "./run-context";
import type { CertifiedBenchmarkDashboardData } from "@/lib/benchmark/scoring/types";
import { createCertifiedBudgetController } from "./budget";

const DEFAULT_STALE_CERTIFIED_RUN_MS = 24 * 60 * 60 * 1000;
const STALE_CERTIFIED_RUN_GRACE_MS = 5 * 60 * 1000;
const MIN_STALE_CERTIFIED_RUN_MS = 10 * 60 * 1000;

export interface CreateCertifiedRunContextInput {
  runId: string;
  suiteId: string;
  track: PersistentCertifiedRunContext["track"];
  harnessProfile: PersistentCertifiedRunContext["harnessProfile"];
  startedAt: string;
  caseIds: string[];
  teamCompositionIds: string[];
  modelBudget?: CertifiedRunBudget;
}

export function createCertifiedRunContext(
  input: CreateCertifiedRunContextInput
): PersistentCertifiedRunContext {
  const attempts = new Map<string, BenchmarkAttemptV2>();
  const verifierResults = new Map<string, BenchmarkVerifierResult>();
  const artifacts = new Map<string, BenchmarkArtifact>();
  const traces = new Map<string, BenchmarkModelCallTrace>();
  const events = new Map<string, BenchmarkRunEvent>();
  const toolCalls = new Map<string, BenchmarkToolCallTrace>();
  const failures = new Map<string, BenchmarkFailure>();
  const budgetController = createCertifiedBudgetController({
    budget: input.modelBudget ?? {},
    startedAt: input.startedAt,
  });

  return {
    runId: input.runId,
    mode: "certified",
    track: input.track,
    harnessProfile: input.harnessProfile,
    suiteId: input.suiteId,
    startedAt: input.startedAt,
    caseIds: [...input.caseIds],
    teamCompositionIds: [...input.teamCompositionIds],
    modelBudget: input.modelBudget ?? {},
    async recordAttempt(attempt) {
      assertAttemptBelongsToRun(attempt, input.runId, input.track);
      attempts.set(attempt.id, attempt);
      await saveBenchmarkAttemptV2(attempt);
    },
    async recordVerifier(result) {
      verifierResults.set(result.id, result);
      await saveBenchmarkVerifierResult(result);
    },
    async recordArtifact(artifact) {
      const record = { ...artifact, runId: artifact.runId ?? input.runId };
      artifacts.set(record.id, record);
      await saveBenchmarkArtifact(record);
    },
    async recordTrace(trace) {
      const record = { ...trace, runId: trace.runId ?? input.runId };
      traces.set(record.id, record);
      await saveBenchmarkTrace(record);
    },
    async recordEvent(event) {
      events.set(event.id, event);
      await saveBenchmarkRunEvent(event);
    },
    async recordToolCall(trace) {
      toolCalls.set(trace.id, trace);
      await saveBenchmarkToolCallTrace(trace);
    },
    async recordFailure(failure) {
      const record = { ...failure, runId: failure.runId ?? input.runId };
      failures.set(record.id, record);
      await saveBenchmarkFailure(record);
    },
    reserveModelCall(reservation) {
      budgetController.reserveModelCall(reservation);
    },
    recordModelCallUsage(usage) {
      budgetController.recordModelCallUsage(usage);
    },
    budgetSnapshot() {
      return budgetController.snapshot();
    },
    snapshot() {
      return {
        attempts: [...attempts.values()],
        verifierResults: [...verifierResults.values()],
        artifacts: [...artifacts.values()],
        traces: [...traces.values()],
        events: [...events.values()],
        toolCalls: [...toolCalls.values()],
        failures: [...failures.values()],
      };
    },
  };
}

export async function persistCertifiedRunRecord(run: BenchmarkRun): Promise<void> {
  await saveBenchmarkRun(run);
}

export async function reconcileStaleCertifiedRuns(
  nowMs = Date.now()
): Promise<number> {
  const completedAt = new Date(nowMs).toISOString();
  let reconciled = 0;
  for (const run of await listBenchmarkRuns()) {
    if (run.status !== "running" || !isCertifiedRunRecord(run)) continue;
    const startedMs = Date.parse(run.startedAt);
    if (!Number.isFinite(startedMs)) continue;
    if (nowMs - startedMs < staleCertifiedRunMs(run)) continue;
    await saveBenchmarkRun({
      ...run,
      status: "failed",
      completedAt,
      summaryJson: JSON.stringify({
        ...parseRunSummary(run.summaryJson),
        staleReconciledAt: completedAt,
        staleReason:
          "Certified run was still marked running after its budget window elapsed.",
      }),
    });
    reconciled += 1;
  }
  return reconciled;
}

export async function persistCertifiedTeamCompositions(
  teams: BenchmarkTeamComposition[]
): Promise<void> {
  for (const team of teams) {
    await saveBenchmarkTeamComposition(team);
  }
}

export async function rebuildCertifiedDashboardData(): Promise<CertifiedBenchmarkDashboardData> {
  await reconcileStaleCertifiedRuns();
  const [
    caseV2,
    attemptsV2,
    verifierResults,
    teamCompositions,
    harnessCertifications,
  ] = await Promise.all([
    listBenchmarkCaseV2(),
    listBenchmarkAttemptsV2(),
    listBenchmarkVerifierResults(),
    listBenchmarkTeamCompositions(),
    listHarnessCertificationResults(),
  ]);

  return buildCertifiedBenchmarkDashboardData({
    caseV2,
    attemptsV2,
    verifierResults,
    teamCompositions,
    harnessCertifications,
  });
}

function isCertifiedRunRecord(run: BenchmarkRun): boolean {
  return parseRunSummary(run.summaryJson).mode === "certified";
}

function staleCertifiedRunMs(run: BenchmarkRun): number {
  const summary = parseRunSummary(run.summaryJson);
  const budget = isRecord(summary.modelBudget) ? summary.modelBudget : {};
  const maxWallClockMs = finitePositiveNumber(budget.maxWallClockMs);
  const maxModelCalls = finitePositiveNumber(budget.maxModelCalls);
  const maxModelCallMs = finitePositiveNumber(budget.maxModelCallMs);
  const modelCallBudgetMs =
    maxModelCalls != null && maxModelCallMs != null
      ? maxModelCalls * maxModelCallMs
      : null;
  const budgetWindowMs = Math.max(maxWallClockMs ?? 0, modelCallBudgetMs ?? 0);
  if (budgetWindowMs > 0) {
    return Math.max(
      MIN_STALE_CERTIFIED_RUN_MS,
      budgetWindowMs + STALE_CERTIFIED_RUN_GRACE_MS
    );
  }
  return DEFAULT_STALE_CERTIFIED_RUN_MS;
}

function parseRunSummary(summaryJson: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(summaryJson) as unknown;
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function finitePositiveNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function assertAttemptBelongsToRun(
  attempt: BenchmarkAttemptV2,
  runId: string,
  track: BenchmarkAttemptV2["track"]
): void {
  if (attempt.runId !== runId) {
    throw new Error(`Certified attempt ${attempt.id} belongs to run ${attempt.runId}, expected ${runId}.`);
  }
  if (attempt.mode !== "certified") {
    throw new Error(`Certified attempt ${attempt.id} must use certified mode.`);
  }
  if (attempt.track !== track) {
    throw new Error(`Certified attempt ${attempt.id} uses track ${attempt.track}, expected ${track}.`);
  }
}

export function mergeSnapshots(
  base: CertifiedRunPersistenceSnapshot,
  extra: CertifiedRunPersistenceSnapshot
): CertifiedRunPersistenceSnapshot {
  return {
    attempts: mergeById(base.attempts, extra.attempts),
    verifierResults: mergeById(base.verifierResults, extra.verifierResults),
    artifacts: mergeById(base.artifacts, extra.artifacts),
    traces: mergeById(base.traces, extra.traces),
    events: mergeById(base.events, extra.events),
    toolCalls: mergeById(base.toolCalls, extra.toolCalls),
    failures: mergeById(base.failures, extra.failures),
  };
}

function mergeById<T extends { id: string }>(left: T[], right: T[]): T[] {
  return [...new Map([...left, ...right].map((item) => [item.id, item])).values()];
}
