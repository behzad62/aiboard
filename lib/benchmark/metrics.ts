import type {
  BuildCheckpoint,
  GenericGameMatchRecord,
  ModelBuildStat,
} from "@/lib/db/schema";
import type {
  BenchmarkCase,
  BenchmarkFailure,
  BenchmarkMetricValue,
  BenchmarkRun,
} from "@/lib/benchmark/types";

export interface BenchmarkSummaryCards {
  totalRuns: number;
  totalCases: number;
  totalModels: number;
  completionRate: number | null;
  schemaValidRate: number | null;
  legalActionRate: number | null;
  fallbackRate: number | null;
  averageCostUsd: number | null;
  averageLatencyMs: number | null;
}

export interface BenchmarkModelScore {
  modelId: string;
  displayName: string;
  games: number;
  wins: number;
  losses: number;
  draws: number;
  buildAttempts: number;
  buildApprovals: number;
  buildFixes: number;
  buildBadOutput: number;
  providerErrors: number;
  completions: number;
  legalActions: number;
  invalidActions: number;
  schemaValid: number;
  schemaInvalid: number;
  fallbackActions: number;
  toolValid: number;
  toolInvalid: number;
  verifierPasses: number;
  verifierFailures: number;
  latencyMs: number;
  latencySamples: number;
  estimatedUsd: number;
  costSamples: number;
  inputTokens: number;
  outputTokens: number;
  qualityScore: number;
  strategyScore: number;
  ruleComplianceScore: number;
  structuredOutputScore: number;
  toolUseScore: number;
  reliabilityScore: number;
  costScore: number;
  latencyScore: number;
  winRate: number | null;
  legalActionRate: number | null;
  schemaValidRate: number | null;
  fallbackRate: number | null;
  verifierPassRate: number | null;
  averageLatencyMs: number | null;
  averageCostUsd: number | null;
}

export interface BenchmarkFailureChartRow {
  modelId: string;
  displayName: string;
  provider: number;
  parser: number;
  rules: number;
  tool: number;
  verifier: number;
  other: number;
}

export interface BenchmarkHeadToHeadRow {
  modelA: string;
  modelB: string;
  modelADisplay: string;
  modelBDisplay: string;
  modelAWins: number;
  modelBWins: number;
  draws: number;
  games: number;
}

export interface BenchmarkTrendRow {
  date: string;
  games: number;
  buildAttempts: number;
  quality: number;
}

export interface BenchmarkEvidenceItem {
  id: string;
  title: string;
  domain: "game" | "build" | "benchmark";
  timestamp: string;
  summary: string;
  detailsJson: string;
}

export interface BenchmarkDashboardData {
  summary: BenchmarkSummaryCards;
  models: BenchmarkModelScore[];
  radarRows: Array<{
    axis: string;
    [modelDisplayName: string]: number | string;
  }>;
  rateBars: Array<{
    modelId: string;
    displayName: string;
    winRate: number;
    legalActionRate: number;
    schemaValidRate: number;
    fallbackRate: number;
    verifierPassRate: number;
  }>;
  costQualityPoints: Array<{
    modelId: string;
    displayName: string;
    quality: number;
    cost: number;
  }>;
  latencyQualityPoints: Array<{
    modelId: string;
    displayName: string;
    quality: number;
    latency: number;
  }>;
  trendRows: BenchmarkTrendRow[];
  failureRows: BenchmarkFailureChartRow[];
  headToHeadRows: BenchmarkHeadToHeadRow[];
  evidenceByModel: Record<string, BenchmarkEvidenceItem[]>;
}

export interface BenchmarkMetricInputs {
  gameMatches: GenericGameMatchRecord[];
  buildStats: ModelBuildStat[];
  buildCheckpoints: BuildCheckpoint[];
  benchmarkRuns: BenchmarkRun[];
  benchmarkCases: BenchmarkCase[];
  benchmarkMetricValues: BenchmarkMetricValue[];
  benchmarkFailures: BenchmarkFailure[];
}

interface MutableScore {
  modelId: string;
  displayName: string;
  games: number;
  wins: number;
  losses: number;
  draws: number;
  buildAttempts: number;
  buildApprovals: number;
  buildFixes: number;
  buildBadOutput: number;
  providerErrors: number;
  completions: number;
  legalActions: number;
  invalidActions: number;
  schemaValid: number;
  schemaInvalid: number;
  fallbackActions: number;
  toolValid: number;
  toolInvalid: number;
  verifierPasses: number;
  verifierFailures: number;
  latencyMs: number;
  latencySamples: number;
  estimatedUsd: number;
  costSamples: number;
  inputTokens: number;
  outputTokens: number;
}

function createScore(modelId: string, displayName = modelId): MutableScore {
  return {
    modelId,
    displayName,
    games: 0,
    wins: 0,
    losses: 0,
    draws: 0,
    buildAttempts: 0,
    buildApprovals: 0,
    buildFixes: 0,
    buildBadOutput: 0,
    providerErrors: 0,
    completions: 0,
    legalActions: 0,
    invalidActions: 0,
    schemaValid: 0,
    schemaInvalid: 0,
    fallbackActions: 0,
    toolValid: 0,
    toolInvalid: 0,
    verifierPasses: 0,
    verifierFailures: 0,
    latencyMs: 0,
    latencySamples: 0,
    estimatedUsd: 0,
    costSamples: 0,
    inputTokens: 0,
    outputTokens: 0,
  };
}

export function buildBenchmarkDashboardData(
  input: BenchmarkMetricInputs
): BenchmarkDashboardData {
  const scores = new Map<string, MutableScore>();
  const evidenceByModel: Record<string, BenchmarkEvidenceItem[]> = {};
  const headToHead = new Map<string, BenchmarkHeadToHeadRow>();
  const failures = new Map<string, BenchmarkFailureChartRow>();
  const trends = new Map<string, BenchmarkTrendRow>();

  const scoreFor = (modelId: string, displayName = displayModelName(modelId)) => {
    const existing = scores.get(modelId);
    if (existing) {
      if (existing.displayName === existing.modelId) existing.displayName = displayName;
      return existing;
    }
    const created = createScore(modelId, displayName);
    scores.set(modelId, created);
    return created;
  };

  for (const stat of input.buildStats) {
    const score = scoreFor(stat.modelId, stat.displayName);
    score.buildAttempts += stat.attempts;
    score.buildApprovals += stat.approvals;
    score.buildFixes += stat.fixes;
    score.buildBadOutput += stat.badOutput;
    score.providerErrors += stat.unavailable;
    score.completions += Math.max(0, stat.attempts - stat.unavailable);
    score.schemaValid += stat.approvals + stat.fixes;
    score.schemaInvalid += stat.badOutput;
    score.toolValid += stat.approvals + stat.fixes;
    score.toolInvalid += stat.badOutput;
    score.verifierPasses += stat.approvals;
    score.verifierFailures += stat.fixes + stat.badOutput;
    if (stat.responseMs > 0) {
      score.latencyMs += stat.responseMs;
      score.latencySamples += Math.max(1, stat.approvals + stat.fixes);
    }

    addEvidence(evidenceByModel, stat.modelId, {
      id: `build-stat:${stat.modelId}`,
      title: "Build model aggregate",
      domain: "build",
      timestamp: stat.updatedAt,
      summary: `${stat.approvals} approvals, ${stat.fixes} fixes, ${stat.badOutput} bad output, ${stat.unavailable} unavailable.`,
      detailsJson: JSON.stringify(stat, null, 2),
    });
  }

  for (const checkpoint of input.buildCheckpoints) {
    const trend = trendFor(trends, checkpoint.updatedAt);
    trend.buildAttempts += checkpoint.usageWindow.models.reduce(
      (sum, model) => sum + model.calls,
      0
    );

    for (const usage of checkpoint.usageWindow.models) {
      const score = scoreFor(usage.modelId, usage.modelName);
      score.estimatedUsd += usage.estimatedUsd ?? 0;
      if (usage.estimatedUsd != null) score.costSamples += 1;
      score.inputTokens += usage.inputTokens;
      score.outputTokens += usage.outputTokens;
      addEvidence(evidenceByModel, usage.modelId, {
        id: `build-usage:${checkpoint.discussionId}:${usage.modelId}`,
        title: "Build usage window",
        domain: "build",
        timestamp: checkpoint.updatedAt,
        summary: `${usage.calls} calls, ${usage.totalTokens.toLocaleString()} tokens, ${formatUsd(usage.estimatedUsd)}.`,
        detailsJson: JSON.stringify(
          {
            discussionId: checkpoint.discussionId,
            status: checkpoint.status,
            stopReason: checkpoint.stopReason,
            usage,
          },
          null,
          2
        ),
      });
    }

    for (const problem of [
      ...(checkpoint.buildProblems ?? []),
      ...(checkpoint.stopReport?.problems ?? []),
      ...(checkpoint.toolReviewReport?.problems ?? []),
    ]) {
      const modelId = problem.modelId ?? "unknown";
      if (problem.modelId) incrementFailure(failures, problem.modelId, problem.code);
      if (problem.modelId) {
        addEvidence(evidenceByModel, problem.modelId, {
          id: `build-problem:${problem.id}`,
          title: problem.code,
          domain: "build",
          timestamp: problem.createdAt,
          summary: problem.message,
          detailsJson: JSON.stringify(problem, null, 2),
        });
      } else {
        incrementFailure(failures, modelId, problem.code);
      }
    }
  }

  for (const match of input.gameMatches) {
    addGameMatch({
      match,
      scoreFor,
      evidenceByModel,
      headToHead,
      trends,
      failures,
    });
  }

  for (const metric of input.benchmarkMetricValues) {
    if (!metric.modelId) continue;
    const score = scoreFor(metric.modelId);
    if (metric.key === "quality") score.verifierPasses += metric.value;
    addEvidence(evidenceByModel, metric.modelId, {
      id: `metric:${metric.id}`,
      title: metric.label,
      domain: metric.domain === "game" ? "game" : "benchmark",
      timestamp: new Date().toISOString(),
      summary: `${metric.label}: ${round(metric.value, 2)}${metric.unit ?? ""}`,
      detailsJson: JSON.stringify(metric, null, 2),
    });
  }

  for (const failure of input.benchmarkFailures) {
    const modelId = failure.modelId ?? "unknown";
    incrementFailure(failures, modelId, failure.code);
    if (failure.modelId) {
      addEvidence(evidenceByModel, failure.modelId, {
        id: `benchmark-failure:${failure.id}`,
        title: failure.code,
        domain: failure.domain === "game" ? "game" : "benchmark",
        timestamp: failure.createdAt,
        summary: failure.message,
        detailsJson: JSON.stringify(failure, null, 2),
      });
    }
  }

  const mutableRows = Array.from(scores.values());
  const maxCost = Math.max(0, ...mutableRows.map((row) => averageCost(row) ?? 0));
  const maxLatency = Math.max(
    0,
    ...mutableRows.map((row) => averageLatency(row) ?? 0)
  );
  const models = mutableRows
    .map((row) => finalizeScore(row, maxCost, maxLatency))
    .sort((a, b) => b.qualityScore - a.qualityScore);

  for (const trend of trends.values()) {
    const denominator = trend.games + trend.buildAttempts;
    trend.quality = denominator > 0 ? trend.quality / denominator : 0;
  }

  return {
    summary: summarize(models, input),
    models,
    radarRows: buildRadarRows(models.slice(0, 4)),
    rateBars: models.map((model) => ({
      modelId: model.modelId,
      displayName: model.displayName,
      winRate: pctNumber(model.winRate),
      legalActionRate: pctNumber(model.legalActionRate),
      schemaValidRate: pctNumber(model.schemaValidRate),
      fallbackRate: pctNumber(model.fallbackRate),
      verifierPassRate: pctNumber(model.verifierPassRate),
    })),
    costQualityPoints: models
      .filter((model) => model.averageCostUsd != null)
      .map((model) => ({
        modelId: model.modelId,
        displayName: model.displayName,
        quality: model.qualityScore,
        cost: model.averageCostUsd ?? 0,
      })),
    latencyQualityPoints: models
      .filter((model) => model.averageLatencyMs != null)
      .map((model) => ({
        modelId: model.modelId,
        displayName: model.displayName,
        quality: model.qualityScore,
        latency: model.averageLatencyMs ?? 0,
      })),
    trendRows: Array.from(trends.values()).sort((a, b) =>
      a.date.localeCompare(b.date)
    ),
    failureRows: Array.from(failures.values()),
    headToHeadRows: Array.from(headToHead.values()).sort(
      (a, b) => b.games - a.games
    ),
    evidenceByModel,
  };
}

function addGameMatch(input: {
  match: GenericGameMatchRecord;
  scoreFor: (modelId: string, displayName?: string) => MutableScore;
  evidenceByModel: Record<string, BenchmarkEvidenceItem[]>;
  headToHead: Map<string, BenchmarkHeadToHeadRow>;
  trends: Map<string, BenchmarkTrendRow>;
  failures: Map<string, BenchmarkFailureChartRow>;
}): void {
  const result = parseObject(input.match.resultJson);
  const stats = parseObject(input.match.statsJson);
  const aiParticipants = input.match.participants.filter((p) => p.modelId);
  const moves = readNumber(stats.moves);
  const invalidResponses = readNumber(stats.invalidResponses);
  const fallbackMoves = readNumber(stats.fallbackMoves);
  const durationMs = readNumber(stats.durationMs);
  const avgAiResponseMs = readNumber(stats.avgAiResponseMs);
  const perModelMoves = Math.max(1, Math.ceil(moves / Math.max(1, aiParticipants.length)));
  const perModelInvalid = distributeCount(invalidResponses, aiParticipants.length);
  const perModelFallback = distributeCount(fallbackMoves, aiParticipants.length);
  const winnerId =
    readString(result.winner) ?? readString(result.result) ?? readString(result.victor);
  const isDraw = Boolean(result.draw) || winnerId === "draw";

  const trend = trendFor(input.trends, input.match.timestamp);
  trend.games += 1;

  for (let i = 0; i < aiParticipants.length; i++) {
    const participant = aiParticipants[i];
    if (!participant.modelId) continue;
    const score = input.scoreFor(participant.modelId);
    score.games += 1;
    score.completions += 1;
    score.legalActions += perModelMoves;
    score.invalidActions += perModelInvalid[i] ?? 0;
    score.schemaValid += perModelMoves;
    score.schemaInvalid += perModelInvalid[i] ?? 0;
    score.fallbackActions += perModelFallback[i] ?? 0;
    if (avgAiResponseMs > 0) {
      score.latencyMs += avgAiResponseMs;
      score.latencySamples += 1;
    } else if (durationMs > 0 && moves > 0) {
      score.latencyMs += durationMs / moves;
      score.latencySamples += 1;
    }
    if (isDraw) score.draws += 1;
    else if (winnerId === participant.id) score.wins += 1;
    else score.losses += 1;
    trend.quality += isDraw ? 50 : winnerId === participant.id ? 100 : 0;

    if (invalidResponses > 0) incrementFailure(input.failures, participant.modelId, "invalid_action");
    if (fallbackMoves > 0) incrementFailure(input.failures, participant.modelId, "fallback_action");

    addEvidence(input.evidenceByModel, participant.modelId, {
      id: `game-match:${input.match.gameId}:${input.match.id}:${participant.id}`,
      title: `${input.match.gameId} match`,
      domain: "game",
      timestamp: input.match.timestamp,
      summary: `${participant.label}: ${isDraw ? "draw" : winnerId === participant.id ? "win" : "loss"} in ${moves} moves.`,
      detailsJson: JSON.stringify(input.match, null, 2),
    });
  }

  if (aiParticipants.length === 2) {
    const a = aiParticipants[0];
    const b = aiParticipants[1];
    if (a.modelId && b.modelId) {
      const key = [a.modelId, b.modelId].sort().join("::");
      const row =
        input.headToHead.get(key) ??
        createHeadToHeadRow(
          a.modelId,
          b.modelId,
          displayModelName(a.modelId),
          displayModelName(b.modelId)
        );
      row.games += 1;
      if (isDraw) row.draws += 1;
      else if (winnerId === a.id) {
        if (row.modelA === a.modelId) row.modelAWins += 1;
        else row.modelBWins += 1;
      } else if (winnerId === b.id) {
        if (row.modelA === b.modelId) row.modelAWins += 1;
        else row.modelBWins += 1;
      }
      input.headToHead.set(key, row);
    }
  }
}

function finalizeScore(
  row: MutableScore,
  maxCost: number,
  maxLatency: number
): BenchmarkModelScore {
  const winRate = rate(row.wins, row.games - row.draws);
  const legalActionRate = rate(row.legalActions, row.legalActions + row.invalidActions);
  const schemaValidRate = rate(row.schemaValid, row.schemaValid + row.schemaInvalid);
  const fallbackRate = rate(row.fallbackActions, row.legalActions + row.fallbackActions);
  const verifierPassRate = rate(
    row.verifierPasses,
    row.verifierPasses + row.verifierFailures
  );
  const completionRate = rate(
    row.completions,
    row.games + row.buildAttempts
  );
  const toolUseRate = rate(row.toolValid, row.toolValid + row.toolInvalid);
  const avgCost = averageCost(row);
  const avgLatency = averageLatency(row);
  const strategyScore = pctNumber(winRate ?? verifierPassRate ?? 0);
  const ruleComplianceScore = pctNumber(legalActionRate);
  const structuredOutputScore = pctNumber(schemaValidRate);
  const toolUseScore = pctNumber(toolUseRate);
  const reliabilityScore = pctNumber(completionRate);
  const costScore = avgCost == null ? 0 : inverseScore(avgCost, maxCost);
  const latencyScore = avgLatency == null ? 0 : inverseScore(avgLatency, maxLatency);
  const qualityScore = round(
    strategyScore * 0.3 +
      ruleComplianceScore * 0.2 +
      structuredOutputScore * 0.2 +
      toolUseScore * 0.15 +
      reliabilityScore * 0.15,
    1
  );

  return {
    ...row,
    qualityScore,
    strategyScore,
    ruleComplianceScore,
    structuredOutputScore,
    toolUseScore,
    reliabilityScore,
    costScore,
    latencyScore,
    winRate,
    legalActionRate,
    schemaValidRate,
    fallbackRate,
    verifierPassRate,
    averageLatencyMs: avgLatency,
    averageCostUsd: avgCost,
  };
}

function summarize(
  models: BenchmarkModelScore[],
  input: BenchmarkMetricInputs
): BenchmarkSummaryCards {
  const totals = models.reduce(
    (acc, model) => {
      acc.completions += model.completions;
      acc.work += model.games + model.buildAttempts;
      acc.schemaValid += model.schemaValid;
      acc.schemaTotal += model.schemaValid + model.schemaInvalid;
      acc.legal += model.legalActions;
      acc.legalTotal += model.legalActions + model.invalidActions;
      acc.fallback += model.fallbackActions;
      acc.fallbackTotal += model.legalActions + model.fallbackActions;
      acc.cost += model.estimatedUsd;
      acc.costSamples += model.costSamples;
      acc.latency += model.latencyMs;
      acc.latencySamples += model.latencySamples;
      return acc;
    },
    {
      completions: 0,
      work: 0,
      schemaValid: 0,
      schemaTotal: 0,
      legal: 0,
      legalTotal: 0,
      fallback: 0,
      fallbackTotal: 0,
      cost: 0,
      costSamples: 0,
      latency: 0,
      latencySamples: 0,
    }
  );

  return {
    totalRuns: input.benchmarkRuns.length + input.gameMatches.length + input.buildCheckpoints.length,
    totalCases: input.benchmarkCases.length,
    totalModels: models.length,
    completionRate: rate(totals.completions, totals.work),
    schemaValidRate: rate(totals.schemaValid, totals.schemaTotal),
    legalActionRate: rate(totals.legal, totals.legalTotal),
    fallbackRate: rate(totals.fallback, totals.fallbackTotal),
    averageCostUsd:
      totals.costSamples > 0 ? totals.cost / totals.costSamples : null,
    averageLatencyMs:
      totals.latencySamples > 0 ? totals.latency / totals.latencySamples : null,
  };
}

function buildRadarRows(models: BenchmarkModelScore[]) {
  const axes: Array<[string, keyof BenchmarkModelScore]> = [
    ["Strategy", "strategyScore"],
    ["Rule Compliance", "ruleComplianceScore"],
    ["Structured Output", "structuredOutputScore"],
    ["Tool Use", "toolUseScore"],
    ["Reliability", "reliabilityScore"],
    ["Cost", "costScore"],
    ["Latency", "latencyScore"],
  ];

  return axes.map(([axis, key]) => {
    const row: { axis: string; [modelDisplayName: string]: number | string } = {
      axis,
    };
    for (const model of models) {
      row[model.displayName] = Number(model[key]) || 0;
    }
    return row;
  });
}

function createHeadToHeadRow(
  modelA: string,
  modelB: string,
  modelADisplay: string,
  modelBDisplay: string
): BenchmarkHeadToHeadRow {
  return {
    modelA,
    modelB,
    modelADisplay,
    modelBDisplay,
    modelAWins: 0,
    modelBWins: 0,
    draws: 0,
    games: 0,
  };
}

function trendFor(
  trends: Map<string, BenchmarkTrendRow>,
  timestamp: string
): BenchmarkTrendRow {
  const date = timestamp.slice(0, 10);
  const existing = trends.get(date);
  if (existing) return existing;
  const created = { date, games: 0, buildAttempts: 0, quality: 0 };
  trends.set(date, created);
  return created;
}

function incrementFailure(
  failures: Map<string, BenchmarkFailureChartRow>,
  modelId: string,
  code: string
): void {
  const row =
    failures.get(modelId) ??
    {
      modelId,
      displayName: displayModelName(modelId),
      provider: 0,
      parser: 0,
      rules: 0,
      tool: 0,
      verifier: 0,
      other: 0,
    };
  const normalized = code.toLowerCase();
  if (/provider|unavailable|quota|401|403|api|request/.test(normalized)) row.provider += 1;
  else if (/tool|mcp|command|patch|edit/.test(normalized)) row.tool += 1;
  else if (/parse|json|schema|malformed/.test(normalized)) row.parser += 1;
  else if (/illegal|invalid|fallback|rule/.test(normalized)) row.rules += 1;
  else if (/verify|build|test|incomplete|progress/.test(normalized)) row.verifier += 1;
  else row.other += 1;
  failures.set(modelId, row);
}

function addEvidence(
  target: Record<string, BenchmarkEvidenceItem[]>,
  modelId: string,
  item: BenchmarkEvidenceItem
): void {
  target[modelId] ??= [];
  target[modelId].push(item);
}

function distributeCount(total: number, buckets: number): number[] {
  if (buckets <= 0) return [];
  const base = Math.floor(total / buckets);
  const remainder = total % buckets;
  return Array.from({ length: buckets }, (_, index) =>
    index < remainder ? base + 1 : base
  );
}

function parseObject(json: string): Record<string, unknown> {
  try {
    const value = JSON.parse(json);
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function readNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function rate(numerator: number, denominator: number): number | null {
  return denominator > 0 ? numerator / denominator : null;
}

function pctNumber(value: number | null): number {
  return value == null ? 0 : Math.round(value * 1000) / 10;
}

function averageCost(row: MutableScore): number | null {
  return row.costSamples > 0 ? row.estimatedUsd / row.costSamples : null;
}

function averageLatency(row: MutableScore): number | null {
  return row.latencySamples > 0 ? row.latencyMs / row.latencySamples : null;
}

function inverseScore(value: number, max: number): number {
  if (max <= 0) return 100;
  return round(Math.max(0, 100 - (value / max) * 100), 1);
}

function round(value: number, digits = 1): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function displayModelName(modelId: string): string {
  if (modelId === "unknown") return "Unknown";
  const parts = modelId.split(":");
  return parts[parts.length - 1] || modelId;
}

function formatUsd(value: number | null): string {
  return value == null ? "unknown cost" : `$${value.toFixed(3)}`;
}
