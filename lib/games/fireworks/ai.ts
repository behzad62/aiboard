import type { ReasoningEffort } from "@/lib/db/schema";
import type {
  ChatParams,
  StreamChunk,
  StructuredOutputFormat,
} from "@/lib/providers/base";
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
  applyFireworksAction,
  fireworksActionsEqual,
  getLegalFireworksActions,
  isPlayableCard,
} from "./engine";
import { getFireworksPlayerView } from "./hidden-view";
import type {
  FireworksAction,
  FireworksAiActionResult,
  FireworksColor,
  FireworksGameState,
  FireworksRank,
} from "./types";

export const FIREWORKS_AI_MAX_TOKENS = 1024;

export interface FireworksAIModelOption {
  modelId: string;
  displayName: string;
  providerId: string;
}

export type FireworksAIParseResult =
  | { ok: true; action: FireworksAction; parsedResponseJson: string }
  | { ok: false; type: "parse" | "illegal"; message: string };

export function buildFireworksActionSchema(): StructuredOutputFormat {
  return {
    name: "fireworks_action",
    strict: true,
    schema: {
      type: "object",
      additionalProperties: false,
      required: ["action"],
      properties: {
        action: {
          type: "string",
          enum: ["clue_color", "clue_rank", "play", "discard"],
        },
        targetPlayerId: { type: "string" },
        color: { type: "string", enum: ["red", "blue", "green"] },
        rank: { type: "number" },
        cardIndex: { type: "number" },
        reason: { type: "string" },
      },
    },
  };
}

export function buildFireworksPrompt(
  state: FireworksGameState,
  playerId: string
): { system: string; user: string } {
  const view = getFireworksPlayerView(state, playerId);
  return {
    system: `You are playing Fireworks, a cooperative hidden-information card game.

You can see other players' cards but not your own.
You must choose exactly one legal action.

Your goal is to maximize the final stack score.
Prefer safe plays when your clue knowledge proves a card is playable, useful clues when a teammate can play or avoid danger, and safe discards when clues are low.
Avoid playing unknown cards, discarding critical cards, illegal clues, and self-clues.
Return only compact JSON for one legal action.`,
    user: `You are ${playerId}.

Current hidden-safe player view JSON:
${JSON.stringify(view)}

Choose exactly one legal action.`,
  };
}

export function parseFireworksActionResponseResult(
  state: FireworksGameState,
  playerId: string,
  rawText: string
): FireworksAIParseResult {
  const parsed = parseJsonObject(rawText);
  if (!parsed) {
    return {
      ok: false,
      type: "parse",
      message: "Response could not be parsed as Fireworks action JSON.",
    };
  }

  const action = normalizeFireworksAction(parsed);
  if (!action) {
    return {
      ok: false,
      type: "parse",
      message: "Fireworks action JSON does not match the action schema.",
    };
  }

  const legal = getLegalFireworksActions(state, playerId).some((candidate) =>
    fireworksActionsEqual(candidate, action)
  );
  if (!legal) {
    return {
      ok: false,
      type: "illegal",
      message: `Fireworks action is illegal for ${playerId}: ${JSON.stringify(action)}`,
    };
  }

  return {
    ok: true,
    action,
    parsedResponseJson: JSON.stringify(action),
  };
}

export function chooseDeterministicFireworksFallback(
  state: FireworksGameState,
  playerId: string
): FireworksAction {
  const legalActions = getLegalFireworksActions(state, playerId);
  if (legalActions.length === 0) {
    return { action: "discard", cardIndex: 0 };
  }

  const hand = state.hands.find((candidate) => candidate.playerId === playerId);
  if (hand) {
    for (let index = 0; index < hand.knowledge.length; index++) {
      const knowledge = hand.knowledge[index];
      if (
        knowledge.color &&
        knowledge.rank &&
        isPlayableCard(state, {
          id: "known",
          color: knowledge.color,
          rank: knowledge.rank,
        })
      ) {
        const play: FireworksAction = { action: "play", cardIndex: index };
        if (legalActions.some((candidate) => fireworksActionsEqual(candidate, play))) {
          return play;
        }
      }
    }
  }

  const usefulClue = legalActions.find((action) => {
    if (action.action !== "clue_color" && action.action !== "clue_rank") return false;
    const target = state.hands.find((candidate) => candidate.playerId === action.targetPlayerId);
    if (!target) return false;
    return target.cards.some((card) => {
      const matches =
        action.action === "clue_color"
          ? card.color === action.color
          : card.rank === action.rank;
      return matches && isPlayableCard(state, card);
    });
  });
  if (usefulClue) return usefulClue;

  if (hand) {
    for (let index = 0; index < hand.cards.length; index++) {
      const card = hand.cards[index];
      if (state.stacks[card.color] >= card.rank) {
        const discard: FireworksAction = { action: "discard", cardIndex: index };
        if (
          legalActions.some((candidate) => fireworksActionsEqual(candidate, discard))
        ) {
          return discard;
        }
      }
    }
  }

  return (
    legalActions.find((action) => action.action === "discard") ??
    legalActions.find((action) => action.action === "play") ??
    legalActions[0]
  );
}

export function getFireworksAIModels(): FireworksAIModelOption[] {
  return getEnabledModels().map((model) => ({
    modelId: `${model.providerId}:${model.id}`,
    displayName: model.name,
    providerId: model.providerId,
  }));
}

export function getFireworksModelApiKey(modelId: string): string | null {
  const { providerId } = parseModelId(modelId);
  const customModel = getCustomModelByFullId(modelId);
  if (customModel) return customModel.apiKey || null;
  return getDecryptedApiKey(providerId);
}

export function getFireworksModelBaseURL(modelId: string): string | undefined {
  const { providerId } = parseModelId(modelId);
  const customModel = getCustomModelByFullId(modelId);
  if (customModel) return customModel.baseURL;
  return getProviderBaseURL(providerId);
}

export async function requestFireworksAiAction(params: {
  state: FireworksGameState;
  playerId: string;
  modelId: string;
  reasoningEffort: ReasoningEffort;
  apiKey: string;
  baseURL?: string;
  signal?: AbortSignal;
}): Promise<FireworksAiActionResult> {
  const startedAt = Date.now();
  const { system, user } = buildFireworksPrompt(params.state, params.playerId);
  let rawResponse = "";

  try {
    rawResponse = await collectFireworksStreamText(
      streamFireworksResponse({
        modelId: params.modelId,
        apiKey: params.apiKey,
        baseURL: params.baseURL,
        reasoningEffort: params.reasoningEffort,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        signal: params.signal,
      }),
      params.signal
    );
    const parsed = parseFireworksActionResponseResult(
      params.state,
      params.playerId,
      rawResponse
    );
    if (parsed.ok) {
      return {
        action: parsed.action,
        rawResponse,
        parsedResponseJson: parsed.parsedResponseJson,
        legal: true,
        fallbackUsed: false,
        latencyMs: Date.now() - startedAt,
      };
    }
    return {
      action: chooseDeterministicFireworksFallback(params.state, params.playerId),
      rawResponse,
      legal: false,
      fallbackUsed: true,
      latencyMs: Date.now() - startedAt,
      error: parsed.message,
    };
  } catch (error) {
    return {
      action: chooseDeterministicFireworksFallback(params.state, params.playerId),
      rawResponse,
      legal: false,
      fallbackUsed: true,
      latencyMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export function applyFireworksAiResult(
  state: FireworksGameState,
  playerId: string,
  result: FireworksAiActionResult
): FireworksGameState {
  if (!result.action) return state;
  return applyFireworksAction(state, playerId, result.action, {
    fallbackUsed: result.fallbackUsed,
  });
}

function normalizeFireworksAction(parsed: Record<string, unknown>): FireworksAction | null {
  if (parsed.action === "clue_color") {
    if (
      typeof parsed.targetPlayerId === "string" &&
      isFireworksColor(parsed.color)
    ) {
      return {
        action: "clue_color",
        targetPlayerId: parsed.targetPlayerId,
        color: parsed.color,
      };
    }
    return null;
  }
  if (parsed.action === "clue_rank") {
    if (
      typeof parsed.targetPlayerId === "string" &&
      isFireworksRank(parsed.rank)
    ) {
      return {
        action: "clue_rank",
        targetPlayerId: parsed.targetPlayerId,
        rank: parsed.rank,
      };
    }
    return null;
  }
  if (parsed.action === "play") {
    return integerCardAction("play", parsed.cardIndex);
  }
  if (parsed.action === "discard") {
    return integerCardAction("discard", parsed.cardIndex);
  }
  return null;
}

function integerCardAction(
  action: "play" | "discard",
  value: unknown
): FireworksAction | null {
  if (!Number.isInteger(value) || typeof value !== "number") return null;
  return action === "play"
    ? { action: "play", cardIndex: value }
    : { action: "discard", cardIndex: value };
}

function isFireworksColor(value: unknown): value is FireworksColor {
  return value === "red" || value === "blue" || value === "green";
}

function isFireworksRank(value: unknown): value is FireworksRank {
  return value === 1 || value === 2 || value === 3 || value === 4 || value === 5;
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
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed
      : null;
  } catch {
    return null;
  }
}

async function* streamFireworksResponse(params: {
  modelId: string;
  apiKey: string;
  baseURL?: string;
  reasoningEffort: ReasoningEffort;
  messages: ChatParams["messages"];
  signal?: AbortSignal;
}): AsyncIterable<StreamChunk> {
  const { providerId, model } = parseModelId(params.modelId);
  const customModel = getCustomModelByFullId(params.modelId);
  if (customModel) {
    yield* streamCustomChat(customModel, {
      apiKey: customModel.apiKey || params.apiKey,
      model: customModel.model,
      messages: params.messages,
      maxTokens: FIREWORKS_AI_MAX_TOKENS,
      temperature: 0.2,
      reasoningEffort: params.reasoningEffort,
      structuredOutput: buildFireworksActionSchema(),
    });
    return;
  }

  const provider = getProvider(providerId);
  if (!provider) throw new Error(`Unknown provider: ${providerId}`);
  yield* provider.streamChat({
    apiKey: params.apiKey,
    model,
    messages: params.messages,
    maxTokens: FIREWORKS_AI_MAX_TOKENS,
    temperature: 0.2,
    reasoningEffort: params.reasoningEffort,
    baseURL: params.baseURL,
    structuredOutput: buildFireworksActionSchema(),
  });
}

async function collectFireworksStreamText(
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
