import {
  listBenchmarkAttemptsV2,
  listBenchmarkCaseV2,
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

export async function persistCertifiedTeamCompositions(
  teams: BenchmarkTeamComposition[]
): Promise<void> {
  for (const team of teams) {
    await saveBenchmarkTeamComposition(team);
  }
}

export async function rebuildCertifiedDashboardData(): Promise<CertifiedBenchmarkDashboardData> {
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
