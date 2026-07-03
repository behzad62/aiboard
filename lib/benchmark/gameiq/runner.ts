import { scoreGameIqAttempt } from "@/lib/benchmark/scoring/gameiq";
import { round } from "@/lib/benchmark/scoring/types";
import { gameIqDecisionKey } from "./packs";
import {
  GAMEIQ_CORRECT_QUALITY_BAR,
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
  gameIqActionsEqual,
  isStructuredGameIqAction,
  validateGameIqAction,
} from "./validation";

// Detect whether a (structured) action matches one of the scenario's
// forbiddenActions: direct per-game equality against the forbidden list, for
// every game. Membership-in-a-list must never be answered by a
// graded/legality-scoring function (actionMatchesExpected /
// gradeFireworksAction). This code used to probe actionMatchesExpected with a
// scenario whose expectedActions were relabeled as the forbidden list, which
// only worked while that function was a pure binary matcher (0 = no match,
// weight = match). The pattern breaks under scoring semantics: v0.3's graded
// fireworks path returns the nonzero neutral floor for any unrelated legal
// action, so ">0" false-flagged every ordinary legal move as forbidden
// (verified via a perfect-play run: 70 of 90 fireworks scenarios), and the
// codenames clue-selection branch scores bare legality while ignoring
// expectedActions, so any legal clue would have "matched" a forbidden list.
function matchesForbiddenAction(
  scenario: GameIqScenario,
  action: unknown
): boolean {
  const forbidden = scenario.forbiddenActions;
  if (!forbidden || forbidden.length === 0) return false;
  if (!isStructuredGameIqAction(scenario, action)) return false;
  return forbidden.some((forbiddenAction) =>
    gameIqActionsEqual(scenario.gameId, action, forbiddenAction)
  );
}

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

function average(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

// Metric de-duplication key: gameIqDecisionKey (game + canonical initial
// state + expected-action content, no label/note prose), shared with the
// first-class pack rigor floor in packs.ts.
function distinctGroupKey(result: GameIqScenarioResult): string {
  return gameIqDecisionKey(result);
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
  const providerResult = normalizeProviderResult(
    await input.moveProvider({ scenario, scenarioIndex, totalScenarios })
  );

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
  const forbiddenBlunder = matchesForbiddenAction(
    scenario,
    providerResult.action
  );
  // A forbidden (trap) action always scores 0 regardless of any weight it might
  // otherwise pick up, so a trap failure can never be rewarded.
  const quality = forbiddenBlunder
    ? 0
    : validation.ok
      ? actionMatchesExpected(scenario, providerResult.action)
      : 0;
  const messages = forbiddenBlunder
    ? [
        ...validation.messages,
        "Action fell into a forbidden trap state for this scenario.",
      ]
    : validation.messages;

  return {
    scenarioId: scenario.id,
    gameId: scenario.gameId,
    category: scenario.category,
    initialState: scenario.initialState,
    expectedActions: scenario.expectedActions,
    action: providerResult.action,
    rawResponse: providerResult.rawResponse,
    structured: structuredShape && validation.ok,
    legal: validation.ok,
    correct: quality >= GAMEIQ_CORRECT_QUALITY_BAR,
    actionQuality: quality,
    latencyMs,
    forbiddenBlunder,
    fallbackUsed: providerResult.fallbackUsed === true,
    messages,
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
  const forbiddenBlunders = caseResults.filter(
    (result) => result.forbiddenBlunder
  ).length;
  const groups = new Map<string, GameIqScenarioResult[]>();
  for (const result of caseResults) {
    const key = distinctGroupKey(result);
    const bucket = groups.get(key);
    if (bucket) bucket.push(result);
    else groups.set(key, [result]);
  }
  const groupAverages = Array.from(groups.values()).map((bucket) => ({
    correct: average(bucket.map((result) => (result.correct ? 1 : 0))),
    quality: average(bucket.map((result) => result.actionQuality)),
    legal: average(bucket.map((result) => (result.legal ? 1 : 0))),
    structured: average(bucket.map((result) => (result.structured ? 1 : 0))),
    fallback: average(bucket.map((result) => (result.fallbackUsed ? 1 : 0))),
  }));
  const metrics: GameIqRunMetrics = {
    scenarioCount,
    structuredActions,
    legalActions,
    correctActions,
    fallbackActions,
    forbiddenBlunders,
    outcomeScore: average(groupAverages.map((group) => group.correct)),
    moveQuality: average(groupAverages.map((group) => group.quality)),
    legalActionRate: average(groupAverages.map((group) => group.legal)),
    structuredReliability: average(
      groupAverages.map((group) => group.structured)
    ),
    fallbackRate: average(groupAverages.map((group) => group.fallback)),
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
      status: statusFromScore(score, metrics),
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
