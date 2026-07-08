import type { ReasoningEffort } from "@/lib/db/schema";
import {
  buildGameAIInteraction,
  type GameAIInteractionResult,
} from "@/lib/games/core/ai-interactions";
import type { GameAIInteraction } from "@/lib/games/core/types";
import {
  buildProvisionalStrategyNoteSection,
  compactGameAIStrategyNote,
  GAME_AI_STRATEGY_NOTE_MAX_LENGTH,
} from "@/lib/games/core/strategy-notes";
import type { StreamChunk, StructuredOutputFormat } from "@/lib/providers/base";
import { parseModelId } from "@/lib/providers/base";
import { isRecoverableGameAIError } from "@/lib/games/core/ai-errors";
import {
  getCustomModelByFullId,
  getDecryptedApiKey,
  getEnabledModels,
  getProvider,
  getProviderBaseURL,
  getProviderRunnerToken,
  streamCustomChat,
} from "@/lib/client/providers";
import { estimateModelCallUsage } from "@/lib/client/token-usage";
import {
  createGameModelCallTrace,
  recordBenchmarkModelCallTrace,
  type GameAIDiagnosticLike,
} from "@/lib/benchmark/model-call-traces";
import {
  BATTLESHIP_FLEET,
  createBattleshipFleetFromPlacements,
  getAvailableBattleshipTargets,
  isLegalBattleshipTarget,
  parseBattleshipTargetLabel,
  targetToLabel,
} from "./engine";
import type {
  BattleshipAIResponse,
  BattleshipCoordinate,
  BattleshipGameState,
  BattleshipOrientation,
  BattleshipPlayer,
  BattleshipShip,
  BattleshipShipPlacement,
} from "./types";

export const BATTLESHIP_AI_MAX_TOKENS = 4096;
const MAX_AI_ATTEMPTS = 3;
const BATTLESHIP_REASONING_MAX_LENGTH = 80;
const BATTLESHIP_UTTERANCE_MAX_LENGTH = 48;
const BATTLESHIP_DIAGNOSTICS_MAX_LENGTH = 120;

export interface BattleshipAIModelOption {
  modelId: string;
  displayName: string;
  providerId: string;
}

export interface RequestBattleshipAIMoveParams {
  state: BattleshipGameState;
  player: BattleshipPlayer;
  modelId: string;
  reasoningEffort: ReasoningEffort;
  apiKey: string;
  baseURL?: string;
  runnerToken?: string;
  signal?: AbortSignal;
}

export interface BattleshipAIMoveSuccess
  extends GameAIInteractionResult<BattleshipCoordinate> {
  target: BattleshipCoordinate;
  interaction: GameAIInteraction | null;
  strategyNote?: string;
}

export interface BattleshipAIDiagnosticAttempt {
  attempt: number;
  type: "parse" | "illegal" | "request";
  message: string;
  legalTargets: string[];
  rawResponse?: string;
  rejectedTarget?: string;
}

export type BattleshipAIMoveResult =
  | BattleshipAIMoveSuccess
  | { error: string; diagnostics?: BattleshipAIDiagnosticAttempt[] };

export interface BattleshipAIPlacementSuccess {
  ships: BattleshipShip[];
}

export type BattleshipAIPlacementResult =
  | BattleshipAIPlacementSuccess
  | { error: string; rawResponse?: string };

function compactText(value: string, maxLength: number): string {
  const compact = value.replace(/\s+/g, " ").trim();
  if (compact.length <= maxLength) return compact;
  return `${compact.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
}

export function parseBattleshipAIResponse(
  rawText: string
): BattleshipAIResponse | null {
  if (!rawText || typeof rawText !== "string") return null;

  let text = rawText.trim();
  const codeBlockMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (codeBlockMatch) text = codeBlockMatch[1].trim();

  const jsonMatch = text.match(/\{[\s\S]*?\}/);
  if (!jsonMatch) return null;

  try {
    const parsed = JSON.parse(jsonMatch[0]);
    const rawTarget =
      typeof parsed.target === "string"
        ? parsed.target
        : typeof parsed.coordinate === "string"
          ? parsed.coordinate
          : null;
    if (!rawTarget) return null;
    const target = parseBattleshipTargetLabel(rawTarget);
    if (!target) return null;

    const response: BattleshipAIResponse = { target };
    if (typeof parsed.reasoning === "string") {
      response.reasoning = compactText(
        parsed.reasoning,
        BATTLESHIP_REASONING_MAX_LENGTH
      );
    }
    response.strategyNote = compactGameAIStrategyNote(
      parsed.strategyNote ?? parsed.strategy_note
    );

    const interaction = buildGameAIInteraction("ai", parsed);
    if (interaction?.gesture) response.gesture = interaction.gesture;
    if (interaction?.utterance) {
      response.utterance = compactText(
        interaction.utterance,
        BATTLESHIP_UTTERANCE_MAX_LENGTH
      );
    }
    if (interaction?.confidence !== undefined) {
      response.confidence = interaction.confidence;
    }
    if (interaction?.diagnostics) {
      response.diagnostics = compactText(
        interaction.diagnostics,
        BATTLESHIP_DIAGNOSTICS_MAX_LENGTH
      );
    }

    return response;
  } catch {
    return null;
  }
}

export function parseBattleshipPlacementResponse(
  rawText: string
): BattleshipShip[] | null {
  const parsed = parseJsonObject(rawText);
  if (!parsed || !Array.isArray(parsed.ships)) return null;

  const placements: BattleshipShipPlacement[] = [];
  for (const item of parsed.ships) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      return null;
    }

    const record = item as Record<string, unknown>;
    const id = typeof record.id === "string" ? record.id : null;
    const start =
      typeof record.start === "string"
        ? record.start
        : typeof record.coordinate === "string"
          ? record.coordinate
          : null;
    const orientation = normalizePlacementOrientation(record.orientation);

    if (!id || !start || !orientation) return null;
    placements.push({ id, start, orientation });
  }

  const result = createBattleshipFleetFromPlacements(placements);
  return result.ok ? result.ships : null;
}

function parseJsonObject(rawText: string): Record<string, unknown> | null {
  if (!rawText || typeof rawText !== "string") return null;

  let text = rawText.trim();
  const codeBlockMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (codeBlockMatch) text = codeBlockMatch[1].trim();

  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return null;

  try {
    const parsed = JSON.parse(jsonMatch[0]);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? parsed
      : null;
  } catch {
    return null;
  }
}

function normalizePlacementOrientation(
  value: unknown
): BattleshipOrientation | null {
  if (value === "horizontal" || value === "h") return "horizontal";
  if (value === "vertical" || value === "v") return "vertical";
  return null;
}

function boardIntel(state: BattleshipGameState, player: BattleshipPlayer): string {
  const opponent = player === "blue" ? "orange" : "blue";
  const shots = state.boards[opponent].shotsReceived;
  if (shots.length === 0) return "No shots fired yet.";
  return shots
    .map((shot) => `${targetToLabel(shot.target)} ${shot.result}`)
    .join(", ");
}

export function buildBattleshipPrompt(
  state: BattleshipGameState,
  player: BattleshipPlayer
): { system: string; user: string } {
  const legalTargets = getAvailableBattleshipTargets(state, player);
  const availableTargets = legalTargets.map(targetToLabel).join(", ");
  const system = `You are a Battleship engine choosing one legal shot.

Respond with ONLY compact valid JSON like {"target":"A1"}.

Rules:
- "target" is required and must be one of the available A1-J10 targets.
- Omit optional fields unless they add clear value.
- Optional "utterance" must be short table-talk for the other player. Do not mention coordinates, ships, hits, misses, search patterns, targets, or future plans.
- Optional "reasoning" must be under ${BATTLESHIP_REASONING_MAX_LENGTH} characters.
- Do not include text outside the JSON object.
- Do not wrap the JSON in markdown code fences.`;

  const strategyNote = buildProvisionalStrategyNoteSection(
    state.aiStrategyNotes?.[player],
    "board and legal targets are authoritative"
  );
  const strategyNoteBlock = strategyNote ? `\n\n${strategyNote}` : "";
  const user = `You are ${player === "blue" ? "Blue" : "Orange"}.

Previous shots against opponent:
${boardIntel(state, player)}
${strategyNoteBlock}

Available targets: ${availableTargets}

Choose the best legal target.`;

  return { system, user };
}

export function buildBattleshipMoveResponseFormat(): StructuredOutputFormat {
  return {
    name: "battleship_move",
    strict: false,
    schema: {
      type: "object",
      properties: {
        target: {
          type: "string",
          description: "A Battleship target coordinate from A1 through J10.",
        },
        reasoning: {
          type: "string",
          maxLength: BATTLESHIP_REASONING_MAX_LENGTH,
          description: "Brief target rationale. Omit unless useful.",
        },
        strategyNote: {
          type: "string",
          maxLength: GAME_AI_STRATEGY_NOTE_MAX_LENGTH,
          description:
            "Optional provisional note for your future turns. Keep it short, observational, and re-checkable.",
        },
        gesture: {
          type: "string",
          enum: [
            "thinking",
            "confident",
            "confused",
            "celebrating",
            "apologetic",
            "neutral",
          ],
        },
        utterance: {
          type: "string",
          maxLength: BATTLESHIP_UTTERANCE_MAX_LENGTH,
          description: "Optional short phrase, under 48 characters.",
        },
        confidence: {
          type: "number",
          description: "Confidence from 0 to 1.",
        },
        diagnostics: {
          type: "string",
          maxLength: BATTLESHIP_DIAGNOSTICS_MAX_LENGTH,
          description: "Optional diagnostics, under 120 characters.",
        },
      },
      required: ["target"],
      additionalProperties: false,
    },
  };
}

export function buildBattleshipPlacementResponseFormat(): StructuredOutputFormat {
  return {
    name: "battleship_fleet_placement",
    strict: false,
    schema: {
      type: "object",
      properties: {
        ships: {
          type: "array",
          items: {
            type: "object",
            properties: {
              id: {
                type: "string",
                enum: BATTLESHIP_FLEET.map((ship) => ship.id),
              },
              start: {
                type: "string",
                description: "Top or left starting coordinate, A1 through J10.",
              },
              orientation: {
                type: "string",
                enum: ["horizontal", "vertical"],
              },
            },
            required: ["id", "start", "orientation"],
            additionalProperties: false,
          },
        },
      },
      required: ["ships"],
      additionalProperties: false,
    },
  };
}

export function buildBattleshipPlacementPrompt(
  player: BattleshipPlayer
): { system: string; user: string } {
  const fleet = BATTLESHIP_FLEET.map(
    (ship) => `${ship.id}=${ship.size}`
  ).join(", ");
  const system = `You are placing a Battleship fleet on a 10x10 board.

Respond with ONLY compact valid JSON like {"ships":[{"id":"carrier","start":"A1","orientation":"horizontal"}]}.

Rules:
- Place exactly these ships: ${fleet}.
- Coordinates use A1 through J10.
- Ships must be straight, horizontal or vertical.
- Ships must not overlap and must stay inside the board.
- Do not include text outside the JSON object.`;

  const user = `Place the ${player === "blue" ? "Blue" : "Orange"} fleet. Choose a legal, varied setup.`;

  return { system, user };
}

export function chooseFallbackBattleshipTarget(
  state: BattleshipGameState,
  player: BattleshipPlayer
): BattleshipCoordinate | null {
  const targets = getAvailableBattleshipTargets(state, player);
  if (targets.length === 0) return null;

  const checkerboard = targets.find(
    (target) => (target.row + target.column) % 2 === 0
  );
  return checkerboard ?? targets[0];
}

export function isRecoverableBattleshipAIError(error: string): boolean {
  return isRecoverableGameAIError(error);
}

export function getBattleshipAIModels(): BattleshipAIModelOption[] {
  return getEnabledModels().map((model) => ({
    modelId: `${model.providerId}:${model.id}`,
    displayName: model.name,
    providerId: model.providerId,
  }));
}

export function getBattleshipModelApiKey(modelId: string): string | null {
  const { providerId } = parseModelId(modelId);
  const customModel = getCustomModelByFullId(modelId);
  if (customModel) return customModel.apiKey || null;
  return getDecryptedApiKey(providerId);
}

export function getBattleshipModelBaseURL(
  modelId: string
): string | undefined {
  const { providerId } = parseModelId(modelId);
  const customModel = getCustomModelByFullId(modelId);
  if (customModel) return customModel.baseURL;
  return getProviderBaseURL(providerId);
}

export function getBattleshipModelRunnerToken(
  modelId: string
): string | undefined {
  const { providerId } = parseModelId(modelId);
  const customModel = getCustomModelByFullId(modelId);
  if (customModel) return undefined;
  return getProviderRunnerToken(providerId);
}

function correctionPrompt(
  reason: "parse" | "illegal",
  legalTargets: string[],
  rejectedTarget?: string
): string {
  if (reason === "parse") {
    return `Your response was not valid Battleship target JSON. Respond with ONLY JSON like {"target":"A1"}. Available targets: ${legalTargets.join(", ")}`;
  }
  return `Target ${rejectedTarget ?? ""} is not legal. Respond with ONLY JSON like {"target":"A1"}. Available targets: ${legalTargets.join(", ")}`;
}

async function streamBattleshipResponseText(params: {
  providerId: string;
  model: string;
  customModel: ReturnType<typeof getCustomModelByFullId>;
  apiKey: string;
  baseURL?: string;
  runnerToken?: string;
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
  reasoningEffort: ReasoningEffort;
  structuredOutput: StructuredOutputFormat;
  signal?: AbortSignal;
}): Promise<string> {
  const stream = params.customModel
    ? streamCustomChat(params.customModel, {
        apiKey: params.customModel.apiKey || params.apiKey,
        model: params.customModel.model,
        messages: params.messages,
        maxTokens: BATTLESHIP_AI_MAX_TOKENS,
        temperature: 0.3,
        reasoningEffort: params.reasoningEffort,
        structuredOutput: params.structuredOutput,
      })
    : standardProviderStream(params);
  return collectBattleshipStreamTextForTests(stream, params.signal);
}

export async function collectBattleshipStreamTextForTests(
  stream: AsyncIterable<StreamChunk>,
  signal?: AbortSignal
): Promise<string> {
  const iterator = stream[Symbol.asyncIterator]();
  let text = "";

  while (true) {
    if (signal?.aborted) {
      await iterator.return?.();
      throw new Error("AI request aborted");
    }

    const chunk = await iterator.next();
    if (chunk.done) return text;
    if (chunk.value.type === "token" && chunk.value.content) {
      text += chunk.value.content;
    } else if (chunk.value.type === "error") {
      throw new Error(chunk.value.error || "Stream error");
    }
  }
}

function standardProviderStream(params: {
  providerId: string;
  model: string;
  apiKey: string;
  baseURL?: string;
  runnerToken?: string;
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
  reasoningEffort: ReasoningEffort;
  structuredOutput: StructuredOutputFormat;
}) {
  const provider = getProvider(params.providerId);
  if (!provider) throw new Error(`Unknown provider: ${params.providerId}`);
  return provider.streamChat({
    apiKey: params.apiKey,
    model: params.model,
    messages: params.messages,
    maxTokens: BATTLESHIP_AI_MAX_TOKENS,
    temperature: 0.3,
    reasoningEffort: params.reasoningEffort,
    baseURL: params.baseURL,
    runnerToken: params.runnerToken,
    structuredOutput: params.structuredOutput,
  });
}

export async function requestBattleshipAIMove(
  params: RequestBattleshipAIMoveParams
): Promise<BattleshipAIMoveResult> {
  const legalTargets = getAvailableBattleshipTargets(
    params.state,
    params.player
  );
  if (legalTargets.length === 0) return { error: "No legal targets available" };

  const legalLabels = legalTargets.map(targetToLabel);
  const { providerId, model } = parseModelId(params.modelId);
  const customModel = getCustomModelByFullId(params.modelId);
  const { system, user } = buildBattleshipPrompt(params.state, params.player);
  const traceStartedAt = new Date().toISOString();
  const traceStartMs = Date.now();
  const tracePrompt = `${system}\n\n${user}`;
  const structuredOutput = buildBattleshipMoveResponseFormat();
  const messages: Array<{
    role: "system" | "user" | "assistant";
    content: string;
  }> = [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
  const diagnostics: BattleshipAIDiagnosticAttempt[] = [];
  const recordTrace = async (input: {
    finalStatus: "parsed" | "parse_error" | "illegal" | "provider_error";
    rawResponse?: string;
    parsedResponseJson?: string;
    error?: string;
  }) => {
    const usage = estimateModelCallUsage({
      messages,
      output: input.rawResponse ?? "",
      maxTokens: BATTLESHIP_AI_MAX_TOKENS,
    });
    await recordBenchmarkModelCallTrace(
      createGameModelCallTrace({
        modelId: params.modelId,
        providerId,
        participantId: params.player,
        reasoningEffort: params.reasoningEffort,
        schemaMode: "structured",
        promptText: tracePrompt,
        startedAt: traceStartedAt,
        completedAt: new Date().toISOString(),
        latencyMs: Date.now() - traceStartMs,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        rawResponse: input.rawResponse,
        parsedResponseJson: input.parsedResponseJson,
        diagnostics,
        finalStatus: input.finalStatus,
        error: input.error,
      })
    );
  };

  for (let attempt = 0; attempt < MAX_AI_ATTEMPTS; attempt++) {
    if (params.signal?.aborted) return { error: "AI request aborted" };

    try {
      const responseText = await streamBattleshipResponseText({
        providerId,
        model,
        customModel,
        apiKey: params.apiKey,
        baseURL: params.baseURL,
        runnerToken: params.runnerToken,
        messages,
        reasoningEffort: params.reasoningEffort,
        structuredOutput,
        signal: params.signal,
      });
      const parsed = parseBattleshipAIResponse(responseText);
      if (!parsed) {
        diagnostics.push({
          attempt: attempt + 1,
          type: "parse",
          message: "Response could not be parsed as Battleship JSON.",
          legalTargets: legalLabels,
          rawResponse: responseText,
        });
        if (attempt < MAX_AI_ATTEMPTS - 1) {
          messages.push({ role: "assistant", content: responseText });
          messages.push({
            role: "user",
            content: correctionPrompt("parse", legalLabels),
          });
          continue;
        }
        await recordTrace({
          finalStatus: "parse_error",
          rawResponse: responseText,
          error: "Failed to parse AI response after multiple attempts",
        });
        return { error: "Failed to parse AI response after multiple attempts", diagnostics };
      }

      if (!isLegalBattleshipTarget(params.state, params.player, parsed.target)) {
        const rejectedTarget = targetToLabel(parsed.target);
        diagnostics.push({
          attempt: attempt + 1,
          type: "illegal",
          message: `AI selected illegal target ${rejectedTarget}.`,
          legalTargets: legalLabels,
          rawResponse: responseText,
          rejectedTarget,
        });
        if (attempt < MAX_AI_ATTEMPTS - 1) {
          messages.push({ role: "assistant", content: responseText });
          messages.push({
            role: "user",
            content: correctionPrompt("illegal", legalLabels, rejectedTarget),
          });
          continue;
        }
        await recordTrace({
          finalStatus: "illegal",
          rawResponse: responseText,
          parsedResponseJson: JSON.stringify(parsed),
          error: `AI returned illegal target: ${rejectedTarget}`,
        });
        return { error: `AI returned illegal target: ${rejectedTarget}`, diagnostics };
      }

      const interaction = buildGameAIInteraction(params.player, parsed);
      await recordTrace({
        finalStatus: "parsed",
        rawResponse: responseText,
        parsedResponseJson: JSON.stringify(parsed),
      });
      return {
        action: parsed.target,
        target: parsed.target,
        interaction,
        ...(parsed.strategyNote ? { strategyNote: parsed.strategyNote } : {}),
        ...(parsed.gesture ? { gesture: parsed.gesture } : {}),
        ...(parsed.utterance ? { utterance: parsed.utterance } : {}),
        ...(parsed.confidence !== undefined ? { confidence: parsed.confidence } : {}),
        ...(parsed.diagnostics ? { diagnostics: parsed.diagnostics } : {}),
      };
    } catch (error) {
      if (params.signal?.aborted) return { error: "AI request aborted" };
      diagnostics.push({
        attempt: attempt + 1,
        type: "request",
        message: error instanceof Error ? error.message : "Unknown error",
        legalTargets: legalLabels,
      });
      if (attempt === MAX_AI_ATTEMPTS - 1) {
        const errorMessage =
          error instanceof Error ? error.message : "Unknown error";
        await recordTrace({
          finalStatus: "provider_error",
          error: errorMessage,
        });
        return {
          error: `AI request failed: ${errorMessage}`,
          diagnostics,
        };
      }
    }
  }

  return { error: "Failed to get valid target after maximum retries", diagnostics };
}

export async function requestBattleshipAIPlacement(params: {
  player: BattleshipPlayer;
  modelId: string;
  reasoningEffort: ReasoningEffort;
  apiKey: string;
  baseURL?: string;
  runnerToken?: string;
  signal?: AbortSignal;
}): Promise<BattleshipAIPlacementResult> {
  const { providerId, model } = parseModelId(params.modelId);
  const customModel = getCustomModelByFullId(params.modelId);
  const { system, user } = buildBattleshipPlacementPrompt(params.player);
  const traceStartedAt = new Date().toISOString();
  const traceStartMs = Date.now();
  const tracePrompt = `${system}\n\n${user}`;
  const diagnostics: GameAIDiagnosticLike[] = [];
  const recordTrace = async (input: {
    finalStatus: "parsed" | "parse_error" | "provider_error";
    rawResponse?: string;
    parsedResponseJson?: string;
    error?: string;
  }) => {
    const usage = estimateModelCallUsage({
      messages,
      output: input.rawResponse ?? "",
      maxTokens: BATTLESHIP_AI_MAX_TOKENS,
    });
    await recordBenchmarkModelCallTrace(
      createGameModelCallTrace({
        modelId: params.modelId,
        providerId,
        participantId: `${params.player}:placement`,
        reasoningEffort: params.reasoningEffort,
        schemaMode: "structured",
        promptText: tracePrompt,
        startedAt: traceStartedAt,
        completedAt: new Date().toISOString(),
        latencyMs: Date.now() - traceStartMs,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        rawResponse: input.rawResponse,
        parsedResponseJson: input.parsedResponseJson,
        diagnostics,
        finalStatus: input.finalStatus,
        error: input.error,
      })
    );
  };
  const messages: Array<{
    role: "system" | "user" | "assistant";
    content: string;
  }> = [
    { role: "system", content: system },
    { role: "user", content: user },
  ];

  for (let attempt = 0; attempt < MAX_AI_ATTEMPTS; attempt++) {
    if (params.signal?.aborted) return { error: "AI placement aborted" };

    try {
      const responseText = await streamBattleshipResponseText({
        providerId,
        model,
        customModel,
        apiKey: params.apiKey,
        baseURL: params.baseURL,
        runnerToken: params.runnerToken,
        messages,
        reasoningEffort: params.reasoningEffort,
        structuredOutput: buildBattleshipPlacementResponseFormat(),
        signal: params.signal,
      });
      const ships = parseBattleshipPlacementResponse(responseText);
      if (ships) {
        await recordTrace({
          finalStatus: "parsed",
          rawResponse: responseText,
          parsedResponseJson: JSON.stringify({ ships }),
        });
        return { ships };
      }

      if (attempt < MAX_AI_ATTEMPTS - 1) {
        diagnostics.push({
          attempt: attempt + 1,
          type: "parse",
          message: "Battleship fleet placement was invalid.",
          rawResponse: responseText,
        });
        messages.push({ role: "assistant", content: responseText });
        messages.push({
          role: "user",
          content:
            "Your fleet placement was invalid. Respond with ONLY JSON containing exactly five non-overlapping ships inside A1-J10.",
        });
        continue;
      }

      diagnostics.push({
        attempt: attempt + 1,
        type: "parse",
        message: "Failed to parse AI fleet placement after multiple attempts",
        rawResponse: responseText,
      });
      await recordTrace({
        finalStatus: "parse_error",
        rawResponse: responseText,
        error: "Failed to parse AI fleet placement after multiple attempts",
      });
      return {
        error: "Failed to parse AI fleet placement after multiple attempts",
        rawResponse: responseText,
      };
    } catch (error) {
      if (params.signal?.aborted) return { error: "AI placement aborted" };
      if (attempt === MAX_AI_ATTEMPTS - 1) {
        const errorMessage =
          error instanceof Error ? error.message : "Unknown error";
        diagnostics.push({
          attempt: attempt + 1,
          type: "request",
          message: errorMessage,
        });
        await recordTrace({
          finalStatus: "provider_error",
          error: errorMessage,
        });
        return {
          error: `AI placement request failed: ${errorMessage}`,
        };
      }
      diagnostics.push({
        attempt: attempt + 1,
        type: "request",
        message: error instanceof Error ? error.message : "Unknown error",
      });
    }
  }

  await recordTrace({
    finalStatus: "parse_error",
    error: "Failed to get valid fleet placement after maximum retries",
  });
  return { error: "Failed to get valid fleet placement after maximum retries" };
}
