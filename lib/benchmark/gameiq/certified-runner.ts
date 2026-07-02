import {
  callCertifiedModel,
  throwIfCertifiedRunAborted,
  type CertifiedModelStream,
} from "@/lib/benchmark/certified/model-call";
import type { CertifiedRunContext } from "@/lib/benchmark/certified/run-context";
import type { BenchmarkAttemptV2, BenchmarkVerifierResult } from "@/lib/benchmark/types";
import type { ModelPricing } from "@/lib/providers/pricing";
import type {
  JsonSchemaObject,
  SelectedModel,
  StructuredOutputFormat,
} from "@/lib/providers/base";
import { targetToLabel } from "@/lib/games/battleship/engine";
import type {
  BattleshipGameState,
  BattleshipPlayer,
} from "@/lib/games/battleship/types";
import {
  GAMEIQ_SCORING_VERSION,
  type GameIqRunResult,
  type GameIqScenario,
} from "./types";
import { listGameIqScenarioPacks } from "./packs";
import { runGameIqScenarios } from "./runner";
import { GAMEIQ_PLACEHOLDER_CLUE_WORD } from "./validation";
import { FIREWORKS_MEMORY_RECALL_TAG } from "./fireworks";
import {
  buildFireworksMemoryEpisode,
  fireworksDecisionSlot,
} from "@/lib/benchmark/fireworks/memory-episode";
import type { ChatMessage } from "@/lib/providers/base";
import type { FireworksPlayerView } from "@/lib/games/fireworks/types";

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
  signal?: AbortSignal;
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
    throwIfCertifiedRunAborted(input.signal);
    for (const model of input.models) {
      throwIfCertifiedRunAborted(input.signal);
      for (let trial = 0; trial < trials; trial++) {
        throwIfCertifiedRunAborted(input.signal);
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
      const system =
        "You are a certified GameIQ benchmark participant. Return only the requested structured JSON.";
      // Fireworks memory-recall scenarios are delivered as a multi-turn episode:
      // the seeded clue history is replayed as earlier conversation turns and
      // the decision turn carries no clue-identity channels, so the model must
      // RECALL. Every other game/category stays single-turn and byte-identical.
      const memoryMessages = fireworksMemoryEpisodeMessages(
        scenario,
        scenarioIndex,
        totalScenarios,
        system
      );
      const call = await callCertifiedModel({
        model: input.model,
        system,
        user: gameIqScenarioPrompt(scenario, scenarioIndex, totalScenarios),
        ...(memoryMessages ? { messages: memoryMessages } : {}),
        structuredOutput: gameIqStructuredOutputForScenario(scenario),
        maxTokens: input.maxTokens ?? 512,
        temperature: 0,
        context: input.context,
        caseId: input.context.caseIds[0],
        attemptId: plannedAttemptId,
        participantId: input.teamCompositionId,
        pricing: input.pricing,
        streamChat: input.streamChat,
        signal: input.signal,
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
      // A trap failure is surfaced distinctly in the label so a forbidden-action
      // blunder reads as a trap failure, not a generic miss.
      label: scenario.forbiddenBlunder
        ? `${scenario.gameId} ${scenario.category} (trap blunder)`
        : `${scenario.gameId} ${scenario.category}`,
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
      forbiddenBlunder: scenario.forbiddenBlunder,
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

// The model-facing prompt deliberately carries ONLY the task instruction, the
// game rules/answer conventions, and the (per-game redacted) state. Scenario
// titles, categories, difficulty labels, and expected-action notes are
// authoring/UI metadata and must never reach the model: titles and notes have
// historically named the expected answer outright (answer leakage).
export function gameIqScenarioPrompt(
  scenario: GameIqScenario,
  scenarioIndex: number,
  totalScenarios: number
): string {
  return [
    `Scenario ${scenarioIndex + 1} of ${totalScenarios}.`,
    scenario.prompt,
    gameIqGameRules(scenario.gameId),
    `State JSON: ${JSON.stringify(gameIqModelStateView(scenario))}`,
    `Return JSON matching this shape (the example values are placeholders, not a suggested or legal move — replace them with your own answer): ${gameIqActionShapeExample(scenario)}.`,
  ].join("\n\n");
}

// Multi-turn recall delivery for fireworks memory scenarios. Returns null for
// every other scenario (single-turn, byte-identical to before). When non-null,
// the seeded clue history is narrated as earlier conversation turns and the
// final decision turn carries the GameIQ prompt over a clue-identity-stripped
// state view, so the model must RECALL the clues to answer. Still one call.
function fireworksMemoryEpisodeMessages(
  scenario: GameIqScenario,
  scenarioIndex: number,
  totalScenarios: number,
  system: string
): ChatMessage[] | null {
  if (
    scenario.gameId !== "fireworks" ||
    !scenario.tags.includes(FIREWORKS_MEMORY_RECALL_TAG)
  ) {
    return null;
  }
  const view = scenario.initialState as FireworksPlayerView;
  const episode = buildFireworksMemoryEpisode({
    system,
    view,
    decisionSlot: fireworksDecisionSlot(scenario),
    episodeId: scenario.id,
  });
  // Reuse the episode's system + narrated recall turns (everything before its
  // own fireworks-style decision turn), then append the GameIQ decision turn
  // built over the identity-stripped decision view so the model returns the
  // GameIQ structured shape it is scored against.
  const narration = episode.messages.slice(0, -1);
  const decisionScenario: GameIqScenario = {
    ...scenario,
    initialState: episode.decisionView,
  };
  return [
    ...narration,
    {
      role: "user",
      content: gameIqScenarioPrompt(
        decisionScenario,
        scenarioIndex,
        totalScenarios
      ),
    },
  ];
}

// Answer conventions each game needs so a correct answer never fails on
// formatting alone (e.g. the accepted promotion vocabulary, or Battleship's
// row-letter/column-number labels matching targetToLabel).
function gameIqGameRules(gameId: GameIqScenario["gameId"]): string {
  switch (gameId) {
    case "connect-four":
      return 'Rules: standard Connect Four on a 6-row by 7-column grid. "column" is the 0-based column index (0-6); a disc dropped in a column lands on the lowest empty cell.';
    case "chess":
      return 'Rules: squares use lowercase algebraic notation such as "e2". If your move promotes a pawn, set "promotion" to exactly one of "queen", "rook", "bishop", or "knight"; otherwise set "promotion" to null.';
    case "battleship":
      // The convention example cell must never be a scenario's expected
      // answer (guarded by scripts/test-gameiq-shared-guards.mts).
      return 'Rules: 10x10 board. "row" and "column" are 0-based indexes. Grid labels use the row letter followed by the column number: rows A-J map to row 0-9 and columns 1-10 map to column 0-9, so {"row":1,"column":6} is cell "B7". The state shows only your own shot history and the sizes of enemy ships still afloat; enemy ship positions are hidden. You may not target a cell you have already shot.';
    case "codenames":
      return `Rules: a clue is a single word that is not any unrevealed board word, plus an integer count from 0-9 that does not exceed your team's remaining unrevealed cards. The literal word "${GAMEIQ_PLACEHOLDER_CLUE_WORD}" is a reserved formatting placeholder and is never a legal clue. A guess names the card id to reveal.`;
    case "fireworks":
      return "Rules: choose exactly one action that is legal in the provided player view.";
  }
}

// Per-game model-facing state projection. Validation and scoring always use
// the full scenario.initialState; this view only controls what the MODEL
// sees, so hidden-information games stay hidden. Battleship redacts the
// opponent fleet: the model gets its own shot history (target, result, and
// the ship id only once a ship is sunk) plus remaining enemy ship sizes —
// never ship cells and never per-hit ship ids.
export function gameIqModelStateView(scenario: GameIqScenario): unknown {
  if (scenario.gameId === "battleship") {
    return battleshipModelView(scenario.initialState as BattleshipGameState);
  }
  return scenario.initialState;
}

interface BattleshipModelView {
  game: "battleship";
  boardSize: number;
  youAre: BattleshipPlayer;
  yourShots: Array<{
    target: { row: number; column: number };
    label: string;
    result: "miss" | "hit" | "sunk";
    sunkShipId?: string;
  }>;
  remainingEnemyShipSizes: number[];
}

function battleshipModelView(state: BattleshipGameState): BattleshipModelView {
  const you = state.turn;
  const opponent: BattleshipPlayer = you === "blue" ? "orange" : "blue";
  const opponentBoard = state.boards[opponent];
  const sunkShipIds = new Set(
    opponentBoard.shotsReceived
      .map((shot) => shot.sunkShipId)
      .filter((shipId): shipId is string => typeof shipId === "string")
  );
  return {
    game: "battleship",
    boardSize: 10,
    youAre: you,
    yourShots: opponentBoard.shotsReceived.map((shot) => ({
      target: { row: shot.target.row, column: shot.target.column },
      label: targetToLabel(shot.target),
      result: shot.result,
      ...(shot.sunkShipId ? { sunkShipId: shot.sunkShipId } : {}),
    })),
    remainingEnemyShipSizes: opponentBoard.ships
      .filter((ship) => !sunkShipIds.has(ship.id))
      .map((ship) => ship.size),
  };
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
    scenario.forbiddenBlunder ? "Trap blunder: yes (matched a forbidden action)" : "",
    scenario.messages.length > 0
      ? `Messages\n${scenario.messages.join("\n")}`
      : "",
    // Codenames clue-selection is scored on legality alone; its authored
    // expectedActions are illustrative, so printing them as "Expected result"
    // would misrepresent the verifier.
    scenario.gameId === "codenames" && scenario.category === "clue-selection"
      ? "Expected result\nAny legal clue (scored on legality; authored expected actions are illustrative only)"
      : `Expected result\n${previewJson(scenario.expectedActions)}`,
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

// Shape examples must never be a scoreable answer: every placeholder value is
// deliberately out of band (negative indexes, non-existent squares, the
// reserved codenames placeholder word) so a model that parrots the example
// earns zero credit on every scenario. scripts/test-gameiq-shared-guards.mts
// enforces this against all shipped packs.
export function gameIqActionShapeExample(scenario: GameIqScenario): string {
  switch (scenario.gameId) {
    case "connect-four":
      return '{"action":{"column":-1}}';
    case "chess":
      return '{"action":{"from":"a0","to":"b0","promotion":null}}';
    case "battleship":
      return '{"action":{"target":{"row":-1,"column":-1}}}';
    case "codenames":
      return `{"action":{"type":"clue","clue":{"word":"${GAMEIQ_PLACEHOLDER_CLUE_WORD}","count":2},"cardId":null}}`;
    case "fireworks":
      return '{"action":{"action":"play","targetPlayerId":null,"color":null,"rank":null,"cardIndex":-1}}';
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
