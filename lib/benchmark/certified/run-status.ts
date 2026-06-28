import type {
  BenchmarkRun,
  BenchmarkRunStatus,
  BenchmarkTrack,
} from "@/lib/benchmark/types";
import type { CertifiedBenchmarkDashboardData } from "@/lib/benchmark/scoring/types";
import type { CertifiedRunContext, CertifiedRunPersistenceSnapshot } from "./run-context";

export interface CertifiedRunSummary {
  runId: string;
  status: Extract<BenchmarkRunStatus, "completed" | "failed">;
  track: BenchmarkTrack;
  suiteId: string;
  startedAt: string;
  completedAt: string;
  attemptCount: number;
  verifierCount: number;
  artifactCount: number;
  traceCount: number;
  eventCount: number;
  toolCallCount: number;
  failureCount: number;
  dashboard: CertifiedBenchmarkDashboardData;
  error?: string;
}

export function benchmarkDomainForTrack(track: BenchmarkTrack): BenchmarkRun["domain"] {
  switch (track) {
    case "gameiq":
      return "game";
    case "workbench":
      return "build";
    case "teamiq":
    case "toolreliability":
    case "harnessbench":
    default:
      return "model-call";
  }
}

export function createBenchmarkRunRecord(input: {
  context: CertifiedRunContext;
  name?: string;
  modelIds: string[];
}): BenchmarkRun {
  return {
    id: input.context.runId,
    suiteId: input.context.suiteId,
    name: input.name ?? `Certified ${input.context.track}`,
    domain: benchmarkDomainForTrack(input.context.track),
    status: "running",
    startedAt: input.context.startedAt,
    source: "manual",
    modelIds: input.modelIds,
    caseIds: input.context.caseIds,
    summaryJson: JSON.stringify({
      mode: "certified",
      track: input.context.track,
      harnessProfile: input.context.harnessProfile,
      teamCompositionIds: input.context.teamCompositionIds,
      modelBudget: input.context.modelBudget,
    }),
    metricValueIds: [],
    artifactIds: [],
    failureIds: [],
  };
}

export function completeBenchmarkRunRecord(input: {
  run: BenchmarkRun;
  completedAt: string;
  status: CertifiedRunSummary["status"];
  summary: CertifiedRunSummary;
  snapshot: CertifiedRunPersistenceSnapshot;
}): BenchmarkRun {
  return {
    ...input.run,
    status: input.status,
    completedAt: input.completedAt,
    summaryJson: JSON.stringify(input.summary),
    artifactIds: input.snapshot.artifacts.map((artifact) => artifact.id),
    failureIds: input.snapshot.failures.map((failure) => failure.id),
  };
}

export function createCertifiedRunSummary(input: {
  context: CertifiedRunContext;
  completedAt: string;
  status: CertifiedRunSummary["status"];
  snapshot: CertifiedRunPersistenceSnapshot;
  dashboard: CertifiedBenchmarkDashboardData;
  error?: string;
}): CertifiedRunSummary {
  return {
    runId: input.context.runId,
    status: input.status,
    track: input.context.track,
    suiteId: input.context.suiteId,
    startedAt: input.context.startedAt,
    completedAt: input.completedAt,
    attemptCount: input.snapshot.attempts.length,
    verifierCount: input.snapshot.verifierResults.length,
    artifactCount: input.snapshot.artifacts.length,
    traceCount: input.snapshot.traces.length,
    eventCount: input.snapshot.events.length,
    toolCallCount: input.snapshot.toolCalls.length,
    failureCount: input.snapshot.failures.length,
    dashboard: input.dashboard,
    error: input.error,
  };
}
