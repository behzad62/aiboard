/**
 * Chess AI Bridge - LLM move generation for chess games
 * Sends game state to an LLM and parses its move response.
 */

import type { GameState, Move, ChessAIResponse, PieceType } from "./types";
import {
  toFEN,
  boardToAscii,
  generateLegalMoves,
  isLegalMove,
} from "./engine";
import type { ReasoningEffort } from "@/lib/db/schema";
import { parseModelId } from "@/lib/providers/base";
import { getProvider, getCustomModelByFullId, streamCustomChat, listCustomModelInfos, getDecryptedApiKey, getProviderBaseURL } from "@/lib/client/providers";
import { loadProviders } from "@/lib/client/settings-api";

// =============================================================================
// EXPORTED INTERFACES
// =============================================================================

/**
 * Configuration for an AI player in chess games.
 */
export interface AIPlayerConfig {
  modelId: string;
  providerId: string;
  displayName: string;
  reasoningEffort: string; // 'disabled' | 'low' | 'medium' | 'high' | etc.
  apiKey?: string;
  baseURL?: string;
}

// =============================================================================
// PROMPT CONSTRUCTION
// =============================================================================

/**
 * Build the system and user prompts for the chess AI.
 * @param state Current game state
 * @param legalMoves List of all legal moves in the current position
 * @returns Object containing system and user prompt strings
 */
export function buildChessPrompt(
  state: GameState,
  legalMoves?: Move[]
): { system: string; user: string } {
  // Generate legal moves if not provided
  const moves = legalMoves ?? generateLegalMoves(state, state.turn);
  const system = `You are a chess engine playing a game of chess. Your task is to analyze the position and choose the best legal move.

IMPORTANT: You must respond with ONLY valid JSON in this exact format:
{
  "from": "e2",
  "to": "e4",
  "promotion": "queen"
}

Rules for your response:
- "from" and "to" are required - use algebraic notation (a-h for files, 1-8 for ranks)
- "promotion" is ONLY included when a pawn reaches the last rank. Valid values: "queen", "rook", "bishop", "knight". Omit this field entirely for non-promotion moves.
- You MUST choose a move from the provided list of legal moves
- Do not include any text outside the JSON object
- Do not wrap the JSON in markdown code fences`;

  // Format move history as SAN notation
  const moveHistorySAN = state.moveHistory.map((record) => record.san);
  const moveHistoryStr =
    moveHistorySAN.length > 0
      ? moveHistorySAN.join(", ")
      : "(no moves yet - opening position)";

  // Format legal moves as a numbered list
  const legalMovesFormatted = moves.map((move, index) => {
    const moveStr = move.promotion
      ? `${move.from}${move.to}${move.promotion[0]}` // e.g., "e7e8q"
      : `${move.from}${move.to}`; // e.g., "e2e4"
    return `${index + 1}. ${moveStr}`;
  });

  const user = `Current position (FEN): ${toFEN(state)}

Board (from White's perspective, uppercase = White, lowercase = Black):
${boardToAscii(state)}

Turn: ${state.turn === "white" ? "White" : "Black"} to move

Move history: ${moveHistoryStr}

Legal moves (${moves.length} available):
${legalMovesFormatted.join("\n")}

Analyze the position and choose the best move. Respond with only the JSON object.`;

  return { system, user };
}

// =============================================================================
// RESPONSE PARSING
// =============================================================================

/**
 * Extract and parse JSON from LLM response text.
 * Handles responses that may be wrapped in markdown code fences or have extra text.
 * @param rawText The raw text response from the LLM
 * @returns Parsed ChessAIResponse or null if parsing fails
 */
export function parseAIResponse(rawText: string): ChessAIResponse | null {
  if (!rawText || typeof rawText !== "string") {
    return null;
  }

  let text = rawText.trim();

  // Try to extract JSON from markdown code fences
  const codeBlockMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (codeBlockMatch) {
    text = codeBlockMatch[1].trim();
  }

  // Try to find JSON object in the text
  const jsonMatch = text.match(/\{[\s\S]*?\}/);
  if (!jsonMatch) {
    return null;
  }

  try {
    const parsed = JSON.parse(jsonMatch[0]);

    // Validate required fields
    if (
      typeof parsed.from !== "string" ||
      typeof parsed.to !== "string"
    ) {
      return null;
    }

    // Normalize and validate from/to squares
    const from = parsed.from.toLowerCase().trim();
    const to = parsed.to.toLowerCase().trim();

    if (!/^[a-h][1-8]$/.test(from) || !/^[a-h][1-8]$/.test(to)) {
      return null;
    }

    const response: ChessAIResponse = {
      from,
      to,
    };

    // Handle optional promotion field
    if (parsed.promotion !== undefined && parsed.promotion !== null) {
      const promo = String(parsed.promotion).toLowerCase().trim();
      const validPromotions = ["queen", "rook", "bishop", "knight", "q", "r", "b", "n"];
      if (validPromotions.includes(promo)) {
        // Normalize single-letter promotions to full names
        const promoMap: Record<string, PieceType> = {
          q: "queen",
          r: "rook",
          b: "bishop",
          n: "knight",
          queen: "queen",
          rook: "rook",
          bishop: "bishop",
          knight: "knight",
        };
        response.promotion = promoMap[promo];
      }
    }

    // Include reasoning if present
    if (typeof parsed.reasoning === "string") {
      response.reasoning = parsed.reasoning;
    }

    return response;
  } catch {
    return null;
  }
}

// =============================================================================
// AI MOVE REQUEST
// =============================================================================

interface RequestAIMoveParams {
  state: GameState;
  modelId: string; // full model id like "openai:gpt-4o"
  reasoningEffort: ReasoningEffort;
  apiKey: string;
  baseURL?: string;
}

interface AIMoveSuccess {
  move: Move;
  reasoning?: string;
}

interface AIMoveError {
  error: string;
}

type AIMoveResult = AIMoveSuccess | AIMoveError;

/**
 * Request a move from an AI model.
 * @param params Request parameters including game state, model ID, and API credentials
 * @returns The chosen move and optional reasoning, or an error
 */
export async function requestAIMove(
  params: RequestAIMoveParams
): Promise<AIMoveResult> {
  const { state, modelId, reasoningEffort, apiKey, baseURL } = params;
  const MAX_RETRIES = 3;

  // Generate legal moves
  const legalMoves = generateLegalMoves(state, state.turn);
  if (legalMoves.length === 0) {
    return { error: "No legal moves available" };
  }

  // Parse the model ID
  const { providerId, model } = parseModelId(modelId);

  // Check if this is a custom model
  const customModel = getCustomModelByFullId(modelId);

  // Build the initial prompt
  const { system, user } = buildChessPrompt(state, legalMoves);

  // Track conversation for retries
  const messages: Array<{ role: "system" | "user" | "assistant"; content: string }> = [
    { role: "system", content: system },
    { role: "user", content: user },
  ];

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      let responseText = "";

      if (customModel) {
        // Use custom model streaming
        const stream = streamCustomChat(customModel, {
          apiKey: customModel.apiKey || apiKey,
          model: customModel.model,
          messages,
          maxTokens: 1024,
          temperature: 0.3,
          reasoningEffort,
        });

        for await (const chunk of stream) {
          if (chunk.type === "token" && chunk.content) {
            responseText += chunk.content;
          } else if (chunk.type === "error") {
            throw new Error(chunk.error || "Stream error");
          }
        }
      } else {
        // Use standard provider
        const provider = getProvider(providerId);
        if (!provider) {
          return { error: `Unknown provider: ${providerId}` };
        }

        const stream = provider.streamChat({
          apiKey,
          model,
          messages,
          maxTokens: 1024,
          temperature: 0.3,
          reasoningEffort,
          baseURL,
        });

        for await (const chunk of stream) {
          if (chunk.type === "token" && chunk.content) {
            responseText += chunk.content;
          } else if (chunk.type === "error") {
            throw new Error(chunk.error || "Stream error");
          }
        }
      }

      // Parse the response
      const parsed = parseAIResponse(responseText);
      if (!parsed) {
        // Add assistant response and correction for retry
        if (attempt < MAX_RETRIES - 1) {
          messages.push({ role: "assistant", content: responseText });
          messages.push({
            role: "user",
            content:
              "Your response could not be parsed as valid JSON. Please respond with ONLY a JSON object in the format: {\"from\": \"e2\", \"to\": \"e4\"}",
          });
          continue;
        }
        return { error: "Failed to parse AI response after multiple attempts" };
      }

      // Construct the move
      const move: Move = {
        from: parsed.from,
        to: parsed.to,
        promotion: parsed.promotion as PieceType | undefined,
      };

      // Validate the move is legal
      if (!isLegalMove(state, move)) {
        // Add assistant response and correction for retry
        if (attempt < MAX_RETRIES - 1) {
          messages.push({ role: "assistant", content: responseText });
          messages.push({
            role: "user",
            content: `Your move ${parsed.from}${parsed.to}${parsed.promotion ? parsed.promotion[0] : ""} is not legal. Please choose from the legal moves listed.`,
          });
          continue;
        }
        return {
          error: `AI returned illegal move: ${parsed.from}${parsed.to} after ${MAX_RETRIES} attempts`,
        };
      }

      // Success!
      return {
        move,
        reasoning: parsed.reasoning,
      };
    } catch (err) {
      if (attempt < MAX_RETRIES - 1) {
        // Retry on transient errors
        continue;
      }
      const errorMessage = err instanceof Error ? err.message : "Unknown error";
      return { error: `AI request failed: ${errorMessage}` };
    }
  }

  return { error: "Failed to get valid move after maximum retries" };
}

// =============================================================================
// MODEL LISTING
// =============================================================================

interface AvailableModel {
  modelId: string;
  displayName: string;
  providerId: string;
}

/**
 * Get all available AI models that can be used for chess.
 * Returns only models from providers that have API keys configured and are enabled.
 * @returns Array of available models with their IDs and display names
 */
export function getAvailableModels(): AvailableModel[] {
  const { providers } = loadProviders();
  const result: AvailableModel[] = [];

  // Add models from enabled providers with keys
  for (const provider of providers) {
    if (!provider.hasKey || !provider.enabled) {
      continue;
    }

    for (const model of provider.models) {
      result.push({
        modelId: `${provider.providerId}:${model.id}`,
        displayName: model.name,
        providerId: provider.providerId,
      });
    }
  }

  // Add custom models (they are always available since keys are stored per-model)
  const customModels = listCustomModelInfos();
  for (const model of customModels) {
    result.push({
      modelId: `custom:${model.id}`,
      displayName: model.name,
      providerId: "custom",
    });
  }

  return result;
}

/**
 * Get the API key for a given model ID.
 * Resolves the provider and returns the appropriate key.
 * @param modelId Full model ID (e.g., "openai:gpt-4o")
 * @returns The API key or null if not found
 */
export function getModelApiKey(modelId: string): string | null {
  const { providerId } = parseModelId(modelId);

  // Custom models have their own keys
  const customModel = getCustomModelByFullId(modelId);
  if (customModel) {
    return customModel.apiKey || null;
  }

  // Use provider key
  return getDecryptedApiKey(providerId);
}

/**
 * Get the base URL override for a given model ID.
 * @param modelId Full model ID
 * @returns The base URL or undefined if not set
 */
export function getModelBaseURL(modelId: string): string | undefined {
  const { providerId } = parseModelId(modelId);

  // Custom models have their own base URLs
  const customModel = getCustomModelByFullId(modelId);
  if (customModel) {
    return customModel.baseURL;
  }

  // Use provider base URL
  return getProviderBaseURL(providerId);
}