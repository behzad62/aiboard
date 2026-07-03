import { isCertifiedProviderError } from "@/lib/benchmark/certified/classify-provider-failure";
import { scoreGameIqAttempt } from "@/lib/benchmark/scoring/gameiq";
import { round } from "@/lib/benchmark/scoring/types";
import { gameIqDecisionKey } from "./packs";
import {
  GAMEIQ_CORRECT_QUALITY_BAR,
  GAMEIQ_HARNESS_VERSION,
  GAMEIQ_MAX_UNSCORED_RATE,
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
  let providerResult: GameIqProviderResult;
  try {
    providerResult = normalizeProviderResult(
      await input.moveProvider({ scenario, scenarioIndex, totalScenarios })
    );
  } catch (error) {
    if (isCertifiedProviderError(error) && error.classification === "transient") {
      // Transient transport failure survived B1's retries: contain it as an
      // unscored scenario instead of scoring it wrong or voiding the whole
      // run. Excluded from every metric denominator by runGameIqScenarios.
      // Uses a STRUCTURAL guard (not `instanceof`): this runner is a .ts/CJS
      // module and a .mts/ESM caller can hold a distinct CertifiedProviderError
      // class object under tsx interop, so `instanceof` would spuriously miss a
      // genuinely-typed error crossing that boundary.
      return {
        scenarioId: scenario.id,
        gameId: scenario.gameId,
        category: scenario.category,
        initialState: scenario.initialState,
        expectedActions: scenario.expectedActions,
        action: null,
        rawResponse: error.message,
        structured: false,
        legal: false,
        correct: false,
        actionQuality: 0,
        latencyMs: 0,
        forbiddenBlunder: false,
        fallbackUsed: false,
        unscored: "transport",
        messages: [`Provider transport failure after retries: ${error.message}`],
      };
    }
    // Fatal / other classification, budget errors, or any non-provider throw:
    // abort the attempt (caller/run engine handle the rethrow).
    throw error;
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

  // Bounded worker pool: up to `concurrency` scenarios evaluate in parallel,
  // but each result is written to its own scenario-indexed slot so
  // `caseResults` always comes out in scenario order regardless of which
  // worker finishes first. Default concurrency 1 = one worker = the original
  // sequential loop, byte-identical to pre-B4 behavior.
  const concurrency = Math.max(1, Math.floor(input.concurrency ?? 1));
  const caseResults: GameIqScenarioResult[] = new Array(input.scenarios.length);
  let cursor = 0;
  // Doubles as the stop-sentinel (truthy → stop pulling work) and the error
  // to rethrow. Invariant: every value ever assigned here is a truthy thrown
  // error (evaluateScenario contains all transients and only ever rethrows a
  // real Error / CertifiedBudgetExceededError), so `if (firstFatal)` is a
  // sound guard. A future refactor that could `throw 0`/`throw ""` must add a
  // separate boolean flag rather than rely on this truthiness.
  let firstFatal: unknown = null;
  const workers = Array.from(
    { length: Math.min(concurrency, input.scenarios.length) },
    async () => {
      for (;;) {
        if (firstFatal) return;
        const index = cursor++;
        if (index >= input.scenarios.length) return;
        try {
          caseResults[index] = await evaluateScenario(
            input.scenarios[index],
            index,
            input.scenarios.length,
            input
          );
        } catch (error) {
          // Fatal/budget: evaluateScenario already contained every transient
          // provider error into an "unscored" result, so only a fatal/budget
          // throw reaches here. Record the first one and stop pulling new
          // work; other in-flight workers finish their current scenario (its
          // slot fills normally) then exit on the next `firstFatal` check.
          firstFatal = firstFatal ?? error;
          return;
        }
      }
    }
  );
  await Promise.all(workers);
  // Rethrow before any metrics are computed: `caseResults` can have empty
  // slots at this point (scenarios never picked up by a worker once
  // firstFatal was set), but that can never reach the `scored` filter below
  // because we throw first — there is no scenario where a hole survives to
  // the metrics computation.
  if (firstFatal) throw firstFatal;

  const scenarioCount = caseResults.length;
  // Transport-failed scenarios are excluded from every scoring metric
  // denominator (informational counts + grouped rate metrics) so a transport
  // blip never masquerades as a wrong answer nor trips the failed_tool_use
  // gate on a pack the model otherwise aced.
  const scored = caseResults.filter((result) => !result.unscored);
  const unscoredTransport = caseResults.length - scored.length;
  const structuredActions = scored.filter((result) => result.structured).length;
  const legalActions = scored.filter((result) => result.legal).length;
  const correctActions = scored.filter((result) => result.correct).length;
  const fallbackActions = scored.filter((result) => result.fallbackUsed).length;
  const forbiddenBlunders = scored.filter(
    (result) => result.forbiddenBlunder
  ).length;
  const groups = new Map<string, GameIqScenarioResult[]>();
  for (const result of scored) {
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
    scoredScenarioCount: scored.length,
    unscoredTransport,
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
  // Validity rule: too many transport gaps (or none scored at all) means this
  // attempt cannot honestly represent the model's GameIQ ability, so it is
  // invalidated for the leaderboard rather than scored on a partial pack.
  const unscoredRate =
    caseResults.length === 0 ? 0 : (caseResults.length - scored.length) / caseResults.length;
  const status =
    scored.length === 0 || unscoredRate > GAMEIQ_MAX_UNSCORED_RATE
      ? "provider_unavailable"
      : statusFromScore(score, metrics);
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
      status,
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
