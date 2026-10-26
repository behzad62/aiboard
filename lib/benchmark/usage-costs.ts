import type { BenchmarkModelCallTrace, BenchmarkRun, BenchmarkResultSet } from "./types";

export interface BenchmarkUsageCostRow {
  runId: string;
  suite: string;
  models: string[];
  status: string;
  startedAt: string;
  calls: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reportedTokenCalls: number;
  estimatedTokenCalls: number;
  calculatedUsd: number | null;
  calculatedCalls: number;
  providerUsd: number | null;
  providerCalls: number;
}

const usd = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;

/** Deduplicate settled traces; provider dollars remain optional independent evidence. */
export function buildBenchmarkUsageCosts(runs: BenchmarkRun[], traces: BenchmarkModelCallTrace[], resultSets: BenchmarkResultSet[] = []): BenchmarkUsageCostRow[] {
  const unique = [...new Map(traces.map(trace => [trace.id, trace])).values()];
  return runs.filter(run => Boolean(run.suiteId)).map(run => {
    const calls = unique.filter(trace => trace.runId === run.id);
    const priced = calls.filter(trace => usd(trace.estimatedUsd));
    const reported = calls.filter(trace => usd(trace.providerReportedCostUsd));
    const subjects = resultSets.filter(subject => subject.runIds.includes(run.id));
    const subjectStates = [...new Set(subjects.map(subject => subject.status))];
    const status = run.status === "running" && subjects.length > 0 && !subjectStates.includes("pending")
      ? subjectStates.length === 1 ? subjectStates[0] : "partial" : run.status;
    return {
      runId: run.id, suite: run.suiteId!, models: [...new Set(calls.map(trace => trace.modelId))].length ? [...new Set(calls.map(trace => trace.modelId))] : run.modelIds,
      status, startedAt: run.startedAt, calls: calls.length,
      inputTokens: calls.reduce((sum, trace) => sum + (trace.inputTokens ?? 0), 0),
      cachedInputTokens: calls.reduce((sum, trace) => sum + (trace.cachedInputTokens ?? 0), 0),
      outputTokens: calls.reduce((sum, trace) => sum + (trace.outputTokens ?? 0), 0),
      reportedTokenCalls: calls.filter(trace => trace.usageSource === "reported").length,
      estimatedTokenCalls: calls.filter(trace => trace.usageSource !== "reported").length,
      calculatedUsd: priced.length ? priced.reduce((sum, trace) => sum + trace.estimatedUsd!, 0) : null,
      calculatedCalls: priced.length,
      providerUsd: reported.length ? reported.reduce((sum, trace) => sum + trace.providerReportedCostUsd!, 0) : null,
      providerCalls: reported.length,
    };
  }).sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}
