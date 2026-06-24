import type { ReasoningEffort } from "@/lib/db/schema";
import {
  buildGameAIInteraction,
  type GameAIInteractionResult,
} from "@/lib/games/core/ai-interactions";
import type { GameAIInteraction } from "@/lib/games/core/types";
import type { StreamChunk, StructuredOutputFormat } from "@/lib/providers/base";
import { parseModelId } from "@/lib/providers/base";
import {
  getCustomModelByFullId,
  getDecryptedApiKey,
  getEnabledModels,
  getProvider,
  getProviderBaseURL,
  streamCustomChat,
} from "@/lib/client/providers";
import {
  getAvailableBattleshipTargets,
  isLegalBattleshipTarget,
  parseBattleshipTargetLabel,
  targetToLabel,
} from "./engine";
import type {
  BattleshipAIResponse,
  BattleshipCoordinate,
  BattleshipGameState,
  BattleshipPlayer,
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
  signal?: AbortSignal;
}

export interface BattleshipAIMoveSuccess
  extends GameAIInteractionResult<BattleshipCoordinate> {
  target: BattleshipCoordinate;
  interaction: GameAIInteraction | null;
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
- Optional "utterance" must be under ${BATTLESHIP_UTTERANCE_MAX_LENGTH} characters.
- Optional "reasoning" must be under ${BATTLESHIP_REASONING_MAX_LENGTH} characters.
- Do not include text outside the JSON object.
- Do not wrap the JSON in markdown code fences.`;

  const user = `You are ${player === "blue" ? "Blue" : "Orange"}.

Previous shots against opponent:
${boardIntel(state, player)}

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
  const normalized = error.toLowerCase();
  return (
    !normalized.includes("aborted") &&
    !normalized.includes("unknown provider") &&
    !normalized.includes("unauthorized") &&
    !normalized.includes("forbidden") &&
    !normalized.includes("invalid api key") &&
    !normalized.includes("quota") &&
    !normalized.includes("key limit") &&
    !normalized.includes("401") &&
    !normalized.includes("403")
  );
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
  const structuredOutput = buildBattleshipMoveResponseFormat();
  const messages: Array<{
    role: "system" | "user" | "assistant";
    content: string;
  }> = [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
  const diagnostics: BattleshipAIDiagnosticAttempt[] = [];

  for (let attempt = 0; attempt < MAX_AI_ATTEMPTS; attempt++) {
    if (params.signal?.aborted) return { error: "AI request aborted" };

    try {
      const responseText = await streamBattleshipResponseText({
        providerId,
        model,
        customModel,
        apiKey: params.apiKey,
        baseURL: params.baseURL,
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
        return { error: `AI returned illegal target: ${rejectedTarget}`, diagnostics };
      }

      const interaction = buildGameAIInteraction(params.player, parsed);
      return {
        action: parsed.target,
        target: parsed.target,
        interaction,
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
        return {
          error: `AI request failed: ${error instanceof Error ? error.message : "Unknown error"}`,
          diagnostics,
        };
      }
    }
  }

  return { error: "Failed to get valid target after maximum retries", diagnostics };
}
