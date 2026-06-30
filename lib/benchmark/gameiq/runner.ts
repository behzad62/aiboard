import { scoreGameIqAttempt } from "@/lib/benchmark/scoring/gameiq";
import { round } from "@/lib/benchmark/scoring/types";
import {
  GAMEIQ_HARNESS_VERSION,
  GAMEIQ_PROMPT_SET_VERSION,
  GAMEIQ_SCORING_VERSION,
  type GameIqProviderResult,
  type GameIqRunMetrics,
  type GameIqRunResult,
  type GameIqScenario,
  type GameIqScenarioResult,
  type RunGameIqScenariosInput,
  statusFromScore,
} from "./types";
import {
  actionMatchesExpected,
  isStructuredGameIqAction,
  validateGameIqAction,
} from "./validation";

function isProviderResult(value: unknown): value is GameIqProviderResult {
  return (
    value !== null &&
    typeof value === "object" &&
    "action" in value
  );
}

function normalizeProviderResult(value: unknown): GameIqProviderResult {
  if (isProviderResult(value)) return value;
  return { action: value };
}

function latencyFactor(latencyMs: number, targetMs: number): number {
  if (!Number.isFinite(latencyMs) || latencyMs < 0) return 0;
  if (latencyMs <= targetMs) return 1;
  return round(targetMs / latencyMs, 4);
}

function average(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function attemptId(input: RunGameIqScenariosInput): string {
  return `gameiq-attempt:${input.runId}:${input.teamCompositionId}:${input.modelId}`;
}

async function evaluateScenario(
  scenario: GameIqScenario,
  scenarioIndex: number,
  totalScenarios: number,
  input: RunGameIqScenariosInput
): Promise<GameIqScenarioResult> {
  const started =
    typeof performance !== "undefined" && performance.now
      ? performance.now()
      : Date.now();
  let providerResult: GameIqProviderResult;

  try {
    providerResult = normalizeProviderResult(
      await input.moveProvider({ scenario, scenarioIndex, totalScenarios })
    );
  } catch (error) {
    providerResult = {
      action: null,
      rawResponse: error instanceof Error ? error.message : String(error),
      fallbackUsed: true,
    };
  }

  const completed =
    typeof performance !== "undefined" && performance.now
      ? performance.now()
      : Date.now();
  const latencyMs = round(
    typeof providerResult.latencyMs === "number"
      ? providerResult.latencyMs
      : completed - started
  );
  const structuredShape = isStructuredGameIqAction(
    scenario,
    providerResult.action
  );
  const validation = structuredShape
    ? validateGameIqAction(scenario, providerResult.action)
    : {
        ok: false,
        messages: ["Action does not match the expected GameIQ action shape."],
      };
  const quality = validation.ok
    ? actionMatchesExpected(scenario, providerResult.action)
    : 0;

  return {
    scenarioId: scenario.id,
    gameId: scenario.gameId,
    category: scenario.category,
    expectedActions: scenario.expectedActions,
    action: providerResult.action,
    rawResponse: providerResult.rawResponse,
    structured: structuredShape && validation.ok,
    legal: validation.ok,
    correct: quality > 0,
    actionQuality: quality,
    latencyMs,
    latencyFactor: latencyFactor(latencyMs, scenario.maxResponseMs),
    fallbackUsed: providerResult.fallbackUsed === true,
    messages: validation.messages,
  };
}

export async function runGameIqScenarios(
  input: RunGameIqScenariosInput
): Promise<GameIqRunResult> {
  const runStartedMs = Date.now();
  const startedAt = input.startedAt ?? new Date(runStartedMs).toISOString();
  const caseResults: GameIqScenarioResult[] = [];

  for (let index = 0; index < input.scenarios.length; index++) {
    caseResults.push(
      await evaluateScenario(
        input.scenarios[index],
        index,
        input.scenarios.length,
        input
      )
    );
  }

  const scenarioCount = caseResults.length;
  const structuredActions = caseResults.filter((result) => result.structured).length;
  const legalActions = caseResults.filter((result) => result.legal).length;
  const correctActions = caseResults.filter((result) => result.correct).length;
  const fallbackActions = caseResults.filter((result) => result.fallbackUsed).length;
  const metrics: GameIqRunMetrics = {
    scenarioCount,
    structuredActions,
    legalActions,
    correctActions,
    fallbackActions,
    outcomeScore: scenarioCount > 0 ? correctActions / scenarioCount : 0,
    moveQuality: average(caseResults.map((result) => result.actionQuality)),
    legalActionRate: scenarioCount > 0 ? legalActions / scenarioCount : 0,
    structuredReliability:
      scenarioCount > 0 ? structuredActions / scenarioCount : 0,
    fallbackRate: scenarioCount > 0 ? fallbackActions / scenarioCount : 0,
    latencyFactor: average(caseResults.map((result) => result.latencyFactor)),
  };
  const score = scoreGameIqAttempt(metrics);
  const completedAt = new Date().toISOString();
  const measuredDurationMs = Math.max(0, Date.now() - runStartedMs);
  const durationMs = round(
    Math.max(
      measuredDurationMs,
      caseResults.reduce((sum, result) => sum + result.latencyMs, 0)
    )
  );

  return {
    score,
    metrics,
    caseResults,
    attempt: {
      id: attemptId(input),
      runId: input.runId,
      caseId: input.caseId ?? "gameiq-v0.1-scenario-pack",
      teamCompositionId: input.teamCompositionId,
      mode: "certified",
      track: "gameiq",
      harnessProfile: input.harnessProfile ?? "raw-single-model",
      status: statusFromScore(score),
      startedAt,
      completedAt,
      verifiedQuality: score / 100,
      jobSuccessScore: round(metrics.outcomeScore * 100),
      efficiencyScore: score,
      gameIqScore: score,
      costUsd: null,
      inputTokens: 0,
      outputTokens: 0,
      modelCalls: scenarioCount,
      toolCalls: 0,
      durationMs,
      artifactIds: [],
      traceIds: [],
      failureIds: [],
      harnessVersion: GAMEIQ_HARNESS_VERSION,
      promptSetVersion: GAMEIQ_PROMPT_SET_VERSION,
      scoringVersion: GAMEIQ_SCORING_VERSION,
    },
  };
}
