import { callCertifiedModel, type CertifiedModelStream } from "@/lib/benchmark/certified/model-call";
import type { CertifiedRunContext } from "@/lib/benchmark/certified/run-context";
import type { BenchmarkAttemptV2, BenchmarkVerifierResult } from "@/lib/benchmark/types";
import type { ModelPricing } from "@/lib/providers/pricing";
import type {
  JsonSchemaObject,
  SelectedModel,
  StructuredOutputFormat,
} from "@/lib/providers/base";
import {
  GAMEIQ_SCORING_VERSION,
  type GameIqRunResult,
  type GameIqScenario,
} from "./types";
import { listGameIqScenarioPacks } from "./packs";
import { runGameIqScenarios } from "./runner";

const GAMEIQ_ACTION_OUTPUT_BY_GAME: Record<
  GameIqScenario["gameId"],
  StructuredOutputFormat
> = {
  "connect-four": actionOutput("gameiq_connect_four_action", {
    column: { type: "integer" },
  }),
  chess: actionOutput("gameiq_chess_action", {
    from: { type: "string" },
    to: { type: "string" },
    promotion: {
      type: ["string", "null"],
      enum: ["queen", "rook", "bishop", "knight", null],
    },
  }),
  battleship: actionOutput("gameiq_battleship_action", {
    target: {
      type: "object",
      additionalProperties: false,
      required: ["row", "column"],
      properties: {
        row: { type: "integer" },
        column: { type: "integer" },
      },
    },
  }),
  codenames: actionOutput("gameiq_codenames_action", {
    type: { type: "string", enum: ["clue", "guess"] },
    clue: {
      type: ["object", "null"],
      additionalProperties: false,
      required: ["word", "count"],
      properties: {
        word: { type: "string" },
        count: { type: "integer" },
      },
    },
    cardId: { type: ["string", "null"] },
  }),
  fireworks: actionOutput("gameiq_fireworks_action", {
    action: {
      type: "string",
      enum: ["play", "discard", "clue_color", "clue_rank"],
    },
    targetPlayerId: { type: ["string", "null"] },
    color: { type: ["string", "null"], enum: ["red", "blue", "green", null] },
    rank: { type: ["integer", "null"], enum: [1, 2, 3, 4, 5, null] },
    cardIndex: { type: ["integer", "null"] },
  }),
};

export interface RunCertifiedGameIqInput {
  context: CertifiedRunContext;
  models: SelectedModel[];
  scenarioPackIds: string[];
  teamCompositionIds: string[];
  trials: number;
  maxTokens?: number;
  streamChat?: CertifiedModelStream;
  pricing?: Pick<ModelPricing, "inputUsdPer1M" | "outputUsdPer1M"> | null;
}

export async function runCertifiedGameIq(
  input: RunCertifiedGameIqInput
): Promise<BenchmarkAttemptV2[]> {
  const packs = selectedScenarioPacks(input.scenarioPackIds);
  const scenarios = packs.flatMap((pack) => pack.scenarios);
  if (scenarios.length === 0) {
    throw new Error("Certified GameIQ requires at least one scenario.");
  }

  const attempts: BenchmarkAttemptV2[] = [];
  const trials = Math.max(1, Math.floor(input.trials));
  for (const teamCompositionId of input.teamCompositionIds) {
    for (const model of input.models) {
      for (let trial = 0; trial < trials; trial++) {
        attempts.push(
          await runCertifiedGameIqAttempt({
            ...input,
            model,
            teamCompositionId,
            scenarios,
            trial,
          })
        );
      }
    }
  }
  return attempts;
}

async function runCertifiedGameIqAttempt(input: RunCertifiedGameIqInput & {
  model: SelectedModel;
  teamCompositionId: string;
  scenarios: GameIqScenario[];
  trial: number;
}): Promise<BenchmarkAttemptV2> {
  const trialSuffix = input.trial === 0 ? "" : `:trial-${input.trial + 1}`;
  const plannedAttemptId = `gameiq-attempt:${input.context.runId}:${input.teamCompositionId}:${input.model.modelId}${trialSuffix}`;
  const calls: Array<{
    traceId: string;
    latencyMs: number;
    inputTokens: number;
    outputTokens: number;
    estimatedUsd: number | null;
  }> = [];

  const result = await runGameIqScenarios({
    runId: input.context.runId,
    modelId: input.model.modelId,
    teamCompositionId: input.teamCompositionId,
    scenarios: input.scenarios,
    caseId: input.context.caseIds[0] ?? "gameiq-v0.1-scenario-pack",
    startedAt: input.context.startedAt,
    harnessProfile: input.context.harnessProfile,
    moveProvider: async ({ scenario, scenarioIndex, totalScenarios }) => {
      const call = await callCertifiedModel({
        model: input.model,
        system: "You are a certified GameIQ benchmark participant. Return only the requested structured JSON.",
        user: gameIqScenarioPrompt(scenario, scenarioIndex, totalScenarios),
        structuredOutput: gameIqStructuredOutputForScenario(scenario),
        maxTokens: input.maxTokens ?? 512,
        temperature: 0,
        context: input.context,
        caseId: input.context.caseIds[0],
        attemptId: plannedAttemptId,
        participantId: input.teamCompositionId,
        pricing: input.pricing,
        streamChat: input.streamChat,
      });
      calls.push({
        traceId: call.traceId,
        latencyMs: call.latencyMs,
        inputTokens: call.inputTokens,
        outputTokens: call.outputTokens,
        estimatedUsd: call.estimatedUsd,
      });
      return {
        action: actionFromParsedJson(call.parsedJson),
        rawResponse: call.rawResponse,
        latencyMs: call.latencyMs,
      };
    },
  });

  const traceIds = calls.map((call) => call.traceId);
  const verifierResult = createGameIqVerifierResult(plannedAttemptId, result);
  await input.context.recordVerifier(verifierResult);

  return {
    ...result.attempt,
    id: plannedAttemptId,
    verifierResultId: verifierResult.id,
    traceIds,
    costUsd: costTotal(calls.map((call) => call.estimatedUsd)),
    inputTokens: calls.reduce((sum, call) => sum + call.inputTokens, 0),
    outputTokens: calls.reduce((sum, call) => sum + call.outputTokens, 0),
    modelCalls: calls.length,
    durationMs: Math.max(
      result.attempt.durationMs,
      calls.reduce((sum, call) => sum + call.latencyMs, 0)
    ),
  };
}

function createGameIqVerifierResult(
  attemptId: string,
  result: GameIqRunResult
): BenchmarkVerifierResult {
  const assertions = result.caseResults.map((scenario) => {
    const passed = scenario.legal && scenario.correct;
    return {
      id: scenario.scenarioId,
      label: `${scenario.gameId} ${scenario.category}`,
      passed,
      weight: 1,
      message:
        scenario.messages.length > 0 ? scenario.messages.join("; ") : undefined,
      ...(!passed ? { details: gameIqAssertionDetails(scenario) } : {}),
    };
  });
  const passed = result.attempt.status === "passed";
  const resultJson = JSON.stringify({
    passed,
    score: result.score / 100,
    summary: passed ? "GameIQ scenarios passed." : "GameIQ scenarios failed.",
    assertions,
    caseResults: result.caseResults.map((scenario) => ({
      scenarioId: scenario.scenarioId,
      gameId: scenario.gameId,
      category: scenario.category,
      passed: scenario.legal && scenario.correct,
      structured: scenario.structured,
      legal: scenario.legal,
      correct: scenario.correct,
      actionQuality: scenario.actionQuality,
      expectedActions: scenario.expectedActions,
      action: scenario.action,
      rawResponse: scenario.rawResponse,
      messages: scenario.messages,
    })),
  });
  return {
    id: `${attemptId}:verifier`,
    attemptId,
    caseId: result.attempt.caseId,
    passed,
    score: result.score / 100,
    durationMs: result.attempt.durationMs,
    resultJson,
    assertionResults: assertions,
    artifactIds: [],
  };
}

function selectedScenarioPacks(packIds: string[]) {
  const packs = listGameIqScenarioPacks();
  const byId = new Map(packs.map((pack) => [pack.id, pack]));
  return packIds.map((id) => {
    const pack = byId.get(id);
    if (!pack) throw new Error(`Unknown GameIQ scenario pack: ${id}`);
    return pack;
  });
}

function gameIqScenarioPrompt(
  scenario: GameIqScenario,
  scenarioIndex: number,
  totalScenarios: number
): string {
  return [
    `Scenario ${scenarioIndex + 1} of ${totalScenarios}: ${scenario.title}`,
    scenario.prompt,
    `Initial state JSON: ${JSON.stringify(scenario.initialState)}`,
    `Return JSON exactly in this shape: ${gameIqActionShapeExample(scenario)}.`,
  ].join("\n\n");
}

function gameIqStructuredOutputForScenario(
  scenario: GameIqScenario
): StructuredOutputFormat {
  return GAMEIQ_ACTION_OUTPUT_BY_GAME[scenario.gameId];
}

function actionOutput(
  name: string,
  actionProperties: Record<string, JsonSchemaObject>
): StructuredOutputFormat {
  return {
    name,
    strict: true,
    schema: {
      type: "object",
      additionalProperties: false,
      required: ["action"],
      properties: {
        action: {
          type: "object",
          additionalProperties: false,
          required: Object.keys(actionProperties),
          properties: actionProperties,
        },
      },
    },
  };
}

function gameIqAssertionDetails(
  scenario: GameIqRunResult["caseResults"][number]
): string {
  return [
    `Scenario: ${scenario.scenarioId}`,
    `Structured: ${scenario.structured ? "yes" : "no"}`,
    `Legal: ${scenario.legal ? "yes" : "no"}`,
    `Correct: ${scenario.correct ? "yes" : "no"}`,
    scenario.messages.length > 0
      ? `Messages\n${scenario.messages.join("\n")}`
      : "",
    `Expected result\n${previewJson(scenario.expectedActions)}`,
    `Parsed action\n${previewJson(scenario.action)}`,
    scenario.rawResponse ? `Raw response\n${previewText(scenario.rawResponse)}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

function previewJson(value: unknown): string {
  return previewText(JSON.stringify(value));
}

function previewText(value: string): string {
  const limit = 1_500;
  return value.length <= limit
    ? value
    : `${value.slice(0, limit)}\n[truncated ${value.length - limit} chars]`;
}

function gameIqActionShapeExample(scenario: GameIqScenario): string {
  switch (scenario.gameId) {
    case "connect-four":
      return '{"action":{"column":3}}';
    case "chess":
      return '{"action":{"from":"e2","to":"d4","promotion":null}}';
    case "battleship":
      return '{"action":{"target":{"row":1,"column":2}}}';
    case "codenames":
      return '{"action":{"type":"clue","clue":{"word":"example","count":2},"cardId":null}}';
    case "fireworks":
      return '{"action":{"action":"play","targetPlayerId":null,"color":null,"rank":null,"cardIndex":0}}';
  }
}

function actionFromParsedJson(parsedJson: unknown): unknown {
  if (
    parsedJson &&
    typeof parsedJson === "object" &&
    !Array.isArray(parsedJson) &&
    "action" in parsedJson
  ) {
    return (parsedJson as { action: unknown }).action;
  }
  return parsedJson;
}

function costTotal(values: Array<number | null>): number | null {
  if (values.every((value) => value === null)) {
    return null;
  }
  let total = 0;
  for (const value of values) {
    total += value ?? 0;
  }
  return total;
}

export { GAMEIQ_SCORING_VERSION };
