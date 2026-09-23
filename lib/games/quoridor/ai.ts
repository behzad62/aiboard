import type { ReasoningEffort } from "@/lib/db/schema";
import {
  buildGameAIInteraction,
  type GameAIInteractionResult,
} from "@/lib/games/core/ai-interactions";
import {
  createGameModelCallTrace,
  recordBenchmarkModelCallTrace,
} from "@/lib/benchmark/model-call-traces";
import { estimateModelCallUsage } from "@/lib/client/token-usage";
import type { GameAIInteraction } from "@/lib/games/core/types";
import { parseModelId, type StreamChunk } from "@/lib/providers/base";
import type { StructuredOutputFormat } from "@/lib/providers/base";
import {
  getCustomModelByFullId,
  getDecryptedApiKey,
  getEnabledModels,
  getProvider,
  getProviderBaseURL,
  getProviderRunnerToken,
  streamCustomChat,
} from "@/lib/client/providers";
import {
  formatQuoridorAction,
  getLegalActions,
  isLegalAction,
  parseQuoridorActionNotation,
  parseQuoridorSquare,
  shortestPathLength,
} from "./engine";
import type {
  QuoridorAction,
  QuoridorAIResponse,
  QuoridorGameState,
  QuoridorPlayer,
  QuoridorWallOrientation,
} from "./types";

const MAX_AI_ATTEMPTS = 3;
export const QUORIDOR_AI_MAX_TOKENS = 4096;
const QUORIDOR_REASONING_MAX_LENGTH = 80;
const QUORIDOR_UTTERANCE_MAX_LENGTH = 48;
const QUORIDOR_DIAGNOSTICS_MAX_LENGTH = 120;

export interface RequestQuoridorAIMoveParams {
  state: QuoridorGameState;
  modelId: string;
  reasoningEffort: ReasoningEffort;
  apiKey: string;
  baseURL?: string;
  runnerToken?: string;
  signal?: AbortSignal;
}

export interface QuoridorAIMoveSuccess
  extends GameAIInteractionResult<QuoridorAction> {
  action: QuoridorAction;
  interaction: GameAIInteraction | null;
  reasoning?: string;
}

export interface QuoridorAIDiagnosticAttempt {
  attempt: number;
  type: "parse" | "illegal" | "request";
  message: string;
  legalActions: string[];
  rawResponse?: string;
  rejectedAction?: string;
}

export interface QuoridorAIMoveError {
  error: string;
  diagnostics?: QuoridorAIDiagnosticAttempt[];
}

export type QuoridorAIMoveResult =
  | QuoridorAIMoveSuccess
  | QuoridorAIMoveError;

export interface AvailableQuoridorModel {
  modelId: string;
  displayName: string;
  providerId: string;
}

export function formatLegalActionList(actions: QuoridorAction[]): string {
  return actions.map((action) => formatQuoridorAction(action)).join(", ");
}

export function buildQuoridorCorrectionPrompt(
  reason: "parse" | "illegal",
  legalActions: QuoridorAction[],
  rejected?: string
): string {
  const legalList = formatLegalActionList(legalActions);
  if (reason === "parse") {
    return `Your response could not be parsed as valid Quoridor JSON. Respond with ONLY a JSON object like {"action":"move","square":"e2"} or {"action":"wall","square":"c4","orientation":"H"}. Legal actions: ${legalList}`;
  }

  const rejectedLabel = rejected ?? "that action";
  return `Your selected ${rejectedLabel} is not legal. Legal actions: ${legalList}. Respond with ONLY a JSON object like {"action":"move","square":"e2"}.`;
}

export function getQuoridorRetryDelayMs(attempt: number): number {
  return Math.min(1000, 250 * 2 ** Math.max(0, attempt));
}

function isOrientation(value: unknown): value is QuoridorWallOrientation {
  return value === "H" || value === "V" || value === "h" || value === "v";
}

function normalizeOrientation(
  value: QuoridorWallOrientation | "h" | "v"
): QuoridorWallOrientation {
  return value.toUpperCase() === "V" ? "V" : "H";
}

export function parseQuoridorAIResponse(
  rawText: string
): QuoridorAIResponse | null {
  if (!rawText || typeof rawText !== "string") return null;

  let text = rawText.trim();
  const codeBlockMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (codeBlockMatch) {
    text = codeBlockMatch[1].trim();
  }

  const jsonMatch = text.match(/\{[\s\S]*?\}/);
  if (!jsonMatch) return null;

  try {
    const parsed = JSON.parse(jsonMatch[0]) as Record<string, unknown>;
    if (typeof parsed !== "object" || parsed === null) return null;

    const action = parseActionFromAIJson(parsed);
    if (!action) return null;

    const response: QuoridorAIResponse = { action };

    if (typeof parsed.reasoning === "string") {
      response.reasoning = compactQuoridorText(
        parsed.reasoning,
        QUORIDOR_REASONING_MAX_LENGTH
      );
    }

    const interaction = buildGameAIInteraction("ai", parsed);
    if (interaction?.gesture) response.gesture = interaction.gesture;
    if (interaction?.utterance) {
      response.utterance = compactQuoridorText(
        interaction.utterance,
        QUORIDOR_UTTERANCE_MAX_LENGTH
      );
    }
    if (interaction?.confidence !== undefined) {
      response.confidence = interaction.confidence;
    }
    if (interaction?.diagnostics) {
      response.diagnostics = compactQuoridorText(
        interaction.diagnostics,
        QUORIDOR_DIAGNOSTICS_MAX_LENGTH
      );
    }

    return response;
  } catch {
    return null;
  }
}

function parseActionFromAIJson(
  parsed: Record<string, unknown>
): QuoridorAction | null {
  if (typeof parsed.notation === "string") {
    return parseQuoridorActionNotation(parsed.notation);
  }

  const kind =
    typeof parsed.action === "string"
      ? parsed.action
      : typeof parsed.type === "string"
        ? parsed.type
        : null;
  if (kind === null) return null;

  const normalized = kind.toLowerCase();
  if (normalized === "move") {
    if (typeof parsed.square === "string") {
      const square = parseQuoridorSquare(parsed.square);
      return square ? { type: "move", ...square } : null;
    }
    if (
      Number.isInteger(parsed.row) &&
      Number.isInteger(parsed.col) &&
      typeof parsed.row === "number" &&
      typeof parsed.col === "number"
    ) {
      return { type: "move", row: parsed.row, col: parsed.col };
    }
    return null;
  }

  if (normalized === "wall") {
    if (!isOrientation(parsed.orientation)) return null;
    const orientation = normalizeOrientation(parsed.orientation);
    if (typeof parsed.square === "string") {
      const square = parseQuoridorSquare(parsed.square);
      return square ? { type: "wall", ...square, orientation } : null;
    }
    if (
      Number.isInteger(parsed.row) &&
      Number.isInteger(parsed.col) &&
      typeof parsed.row === "number" &&
      typeof parsed.col === "number"
    ) {
      return {
        type: "wall",
        row: parsed.row,
        col: parsed.col,
        orientation,
      };
    }
  }

  return null;
}

function compactQuoridorText(value: string, maxLength: number): string {
  const compact = value.replace(/\s+/g, " ").trim();
  if (compact.length <= maxLength) return compact;
  return `${compact.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
}

export function chooseFallbackQuoridorAction(
  state: QuoridorGameState
): QuoridorAction | null {
  const legalActions = getLegalActions(state);
  if (legalActions.length === 0) return null;

  const pawnMoves = legalActions.filter(
    (action): action is Extract<QuoridorAction, { type: "move" }> =>
      action.type === "move"
  );
  if (pawnMoves.length === 0) return legalActions[0] ?? null;

  const goal = state.turn === "south" ? 0 : 8;
  const winningMove = pawnMoves.find((action) => action.row === goal);
  if (winningMove) return winningMove;

  let best = pawnMoves[0];
  let bestLength = Number.POSITIVE_INFINITY;
  for (const action of pawnMoves) {
    const nextPawns = {
      ...state.pawns,
      [state.turn]: { row: action.row, col: action.col },
    };
    const length = shortestPathLength(
      { pawns: nextPawns, walls: state.walls },
      state.turn
    );
    if (length !== null && length < bestLength) {
      bestLength = length;
      best = action;
    }
  }

  return best;
}

export function buildQuoridorPrompt(
  state: QuoridorGameState,
  legalActions = getLegalActions(state)
): { system: string; user: string } {
  const system = `You are a Quoridor engine choosing a legal action.

Respond with ONLY compact valid JSON like {"action":"move","square":"e2"} or {"action":"wall","square":"c4","orientation":"H"}.

Rules:
- Squares use files a-i left to right and ranks 1-9 from south to north. South starts on e1 and aims for rank 9. North starts on e9 and aims for rank 1.
- A turn is exactly one pawn move or one wall. Pawns move one orthogonal step. You may jump an adjacent opponent; if the square behind them is blocked or off-board, jump diagonally to either side. You cannot jump through a wall between you and the opponent.
- Walls sit on the 8x8 intersection grid. "square" is the top-left intersection coordinate, and orientation is "H" or "V". A wall covers two fence segments. Walls cannot overlap or cross, and both players must keep a path to their goal.
- Optional "gesture" values: "thinking", "confident", "confused", "celebrating", "apologetic", "neutral".
- Optional "utterance" must be short table-talk. Do not mention coordinates, walls, paths, or plans.
- Optional "reasoning" must be under ${QUORIDOR_REASONING_MAX_LENGTH} characters.
- Optional "confidence" must be a number from 0 to 1.
- Do not include text outside the JSON object.
- Do not wrap the JSON in markdown code fences.`;

  const moveHistory =
    state.moveHistory.length > 0
      ? state.moveHistory
          .map((record, index) => `${index + 1}. ${record.notation}`)
          .join(", ")
      : "(no moves yet)";

  const wallList =
    state.walls.length === 0
      ? "(none)"
      : state.walls
          .map((wall) =>
            formatQuoridorAction({
              type: "wall",
              row: wall.row,
              col: wall.col,
              orientation: wall.orientation,
            })
          )
          .join(", ");

  const user = `Pawns: South ${formatPawn(state, "south")}, North ${formatPawn(state, "north")}
Walls: ${wallList}
Walls left: South ${state.wallsLeft.south}, North ${state.wallsLeft.north}

Turn: ${state.turn === "south" ? "South" : "North"}

Move history: ${moveHistory}

Legal actions: ${formatLegalActionList(legalActions)}

Choose the best legal action. Respond with only the JSON object.`;

  return { system, user };
}

function formatPawn(state: QuoridorGameState, player: QuoridorPlayer): string {
  return `${player === "south" ? "S" : "N"} on ${formatQuoridorAction({
    type: "move",
    ...state.pawns[player],
  })}`;
}

export function buildQuoridorMoveResponseFormat(): StructuredOutputFormat {
  return {
    name: "quoridor_action",
    strict: false,
    schema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["move", "wall"],
          description: "Whether to move the pawn or place a wall.",
        },
        square: {
          type: "string",
          description:
            "Algebraic square, a1-i9. For walls this is the intersection coordinate.",
        },
        orientation: {
          type: "string",
          enum: ["H", "V"],
          description: "Required when action is wall.",
        },
        reasoning: {
          type: "string",
          maxLength: QUORIDOR_REASONING_MAX_LENGTH,
          description: "Brief move rationale. Omit unless useful.",
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
          maxLength: QUORIDOR_UTTERANCE_MAX_LENGTH,
          description: "Optional short phrase, under 48 characters.",
        },
        confidence: {
          type: "number",
          description: "Confidence from 0 to 1.",
        },
        diagnostics: {
          type: "string",
          maxLength: QUORIDOR_DIAGNOSTICS_MAX_LENGTH,
          description: "Optional model diagnostics, under 120 characters.",
        },
      },
      required: ["action", "square"],
      additionalProperties: false,
    },
  };
}

export async function requestQuoridorAIMove(
  params: RequestQuoridorAIMoveParams
): Promise<QuoridorAIMoveResult> {
  const {
    state,
    modelId,
    reasoningEffort,
    apiKey,
    baseURL,
    runnerToken,
    signal,
  } = params;

  if (signal?.aborted) {
    return { error: "AI request aborted" };
  }

  const legalActions = getLegalActions(state);
  if (legalActions.length === 0) {
    return { error: "No legal actions available" };
  }

  const { providerId, model } = parseModelId(modelId);
  const customModel = getCustomModelByFullId(modelId);
  const { system, user } = buildQuoridorPrompt(state, legalActions);
  const traceStartedAt = new Date().toISOString();
  const traceStartMs = Date.now();
  const tracePrompt = `${system}\n\n${user}`;
  const structuredOutput = buildQuoridorMoveResponseFormat();
  const messages: Array<{
    role: "system" | "user" | "assistant";
    content: string;
  }> = [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
  const diagnostics: QuoridorAIDiagnosticAttempt[] = [];

  const recordTrace = async (input: {
    finalStatus: "parsed" | "parse_error" | "illegal" | "provider_error";
    rawResponse?: string;
    parsedResponseJson?: string;
    error?: string;
  }) => {
    try {
      const usage = estimateModelCallUsage({
        messages,
        output: input.rawResponse ?? "",
        maxTokens: QUORIDOR_AI_MAX_TOKENS,
      });
      await recordBenchmarkModelCallTrace(
        createGameModelCallTrace({
          modelId,
          providerId,
          participantId: state.turn,
          reasoningEffort,
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
    } catch {
      // Tracing must never break a live move.
    }
  };

  for (let attempt = 0; attempt < MAX_AI_ATTEMPTS; attempt++) {
    if (signal?.aborted) {
      return { error: "AI request aborted" };
    }

    try {
      const responseText = await streamQuoridorResponseText({
        providerId,
        model,
        customModel,
        apiKey,
        baseURL,
        runnerToken,
        messages,
        reasoningEffort,
        structuredOutput,
        signal,
      });

      const parsed = parseQuoridorAIResponse(responseText);
      if (!parsed) {
        diagnostics.push({
          attempt: attempt + 1,
          type: "parse",
          message: "Failed to parse AI response as Quoridor JSON.",
          legalActions: legalActions.map(formatQuoridorAction),
          rawResponse: responseText,
        });
        if (attempt < MAX_AI_ATTEMPTS - 1) {
          messages.push({ role: "assistant", content: responseText });
          messages.push({
            role: "user",
            content: buildQuoridorCorrectionPrompt("parse", legalActions),
          });
          continue;
        }
        await recordTrace({
          finalStatus: "parse_error",
          rawResponse: responseText,
          error: "Failed to parse AI response after multiple attempts",
        });
        return {
          error: "Failed to parse AI response after multiple attempts",
          diagnostics,
        };
      }

      if (!isLegalAction(state, parsed.action)) {
        const rejected = formatQuoridorAction(parsed.action);
        diagnostics.push({
          attempt: attempt + 1,
          type: "illegal",
          message: `AI selected illegal action ${rejected}.`,
          legalActions: legalActions.map(formatQuoridorAction),
          rawResponse: responseText,
          rejectedAction: rejected,
        });
        if (attempt < MAX_AI_ATTEMPTS - 1) {
          messages.push({ role: "assistant", content: responseText });
          messages.push({
            role: "user",
            content: buildQuoridorCorrectionPrompt(
              "illegal",
              legalActions,
              rejected
            ),
          });
          continue;
        }
        await recordTrace({
          finalStatus: "illegal",
          rawResponse: responseText,
          parsedResponseJson: JSON.stringify(parsed),
          error: `AI returned illegal action: ${rejected} after ${MAX_AI_ATTEMPTS} attempts`,
        });
        return {
          error: `AI returned illegal action: ${rejected} after ${MAX_AI_ATTEMPTS} attempts`,
          diagnostics,
        };
      }

      const interaction = buildGameAIInteraction(state.turn, parsed);
      await recordTrace({
        finalStatus: "parsed",
        rawResponse: responseText,
        parsedResponseJson: JSON.stringify(parsed),
      });
      return {
        action: parsed.action,
        reasoning: parsed.reasoning,
        ...(parsed.gesture ? { gesture: parsed.gesture } : {}),
        ...(parsed.utterance ? { utterance: parsed.utterance } : {}),
        ...(parsed.confidence !== undefined
          ? { confidence: parsed.confidence }
          : {}),
        ...(parsed.diagnostics ? { diagnostics: parsed.diagnostics } : {}),
        interaction,
      };
    } catch (err) {
      if (signal?.aborted) {
        return { error: "AI request aborted" };
      }

      if (attempt < MAX_AI_ATTEMPTS - 1) {
        diagnostics.push({
          attempt: attempt + 1,
          type: "request",
          message: err instanceof Error ? err.message : "Unknown error",
          legalActions: legalActions.map(formatQuoridorAction),
        });
        await delayWithAbort(getQuoridorRetryDelayMs(attempt), signal);
        continue;
      }

      const errorMessage = err instanceof Error ? err.message : "Unknown error";
      diagnostics.push({
        attempt: attempt + 1,
        type: "request",
        message: errorMessage,
        legalActions: legalActions.map(formatQuoridorAction),
      });
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

  return {
    error: "Failed to get valid action after maximum retries",
    diagnostics,
  };
}

export function getAvailableQuoridorModels(): AvailableQuoridorModel[] {
  return getEnabledModels().map((model) => ({
    modelId: `${model.providerId}:${model.id}`,
    displayName: model.name,
    providerId: model.providerId,
  }));
}

export function getQuoridorModelApiKey(modelId: string): string | null {
  const { providerId } = parseModelId(modelId);
  const customModel = getCustomModelByFullId(modelId);
  if (customModel) {
    return customModel.apiKey || null;
  }

  return getDecryptedApiKey(providerId);
}

export function getQuoridorModelBaseURL(modelId: string): string | undefined {
  const { providerId } = parseModelId(modelId);
  const customModel = getCustomModelByFullId(modelId);
  if (customModel) {
    return customModel.baseURL;
  }

  return getProviderBaseURL(providerId);
}

export function getQuoridorModelRunnerToken(
  modelId: string
): string | undefined {
  const { providerId } = parseModelId(modelId);
  const customModel = getCustomModelByFullId(modelId);
  if (customModel) {
    return undefined;
  }

  return getProviderRunnerToken(providerId);
}

async function streamQuoridorResponseText(params: {
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
        maxTokens: QUORIDOR_AI_MAX_TOKENS,
        temperature: 0.3,
        reasoningEffort: params.reasoningEffort,
        structuredOutput: params.structuredOutput,
      })
    : getStandardProviderStream(params);

  return collectQuoridorStreamTextForTests(stream, params.signal);
}

export async function collectQuoridorStreamTextForTests(
  stream: AsyncIterable<StreamChunk>,
  signal?: AbortSignal
): Promise<string> {
  const iterator = stream[Symbol.asyncIterator]();
  let responseText = "";

  while (true) {
    const next = await nextQuoridorStreamChunk(iterator, signal);
    if (next.done) return responseText;

    const chunk = next.value;
    if (chunk.type === "token" && chunk.content) {
      responseText += chunk.content;
    } else if (chunk.type === "error") {
      throw new Error(chunk.error || "Stream error");
    }
  }
}

function getStandardProviderStream(params: {
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
  if (!provider) {
    throw new Error(`Unknown provider: ${params.providerId}`);
  }

  return provider.streamChat({
    apiKey: params.apiKey,
    model: params.model,
    messages: params.messages,
    maxTokens: QUORIDOR_AI_MAX_TOKENS,
    temperature: 0.3,
    reasoningEffort: params.reasoningEffort,
    baseURL: params.baseURL,
    runnerToken: params.runnerToken,
    structuredOutput: params.structuredOutput,
  });
}

async function delayWithAbort(
  delayMs: number,
  signal: AbortSignal | undefined
): Promise<void> {
  if (!signal) {
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    return;
  }

  await new Promise<void>((resolve) => {
    const timeout = setTimeout(resolve, delayMs);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timeout);
        resolve();
      },
      { once: true }
    );
  });
}

async function nextQuoridorStreamChunk(
  iterator: AsyncIterator<StreamChunk>,
  signal: AbortSignal | undefined
): Promise<IteratorResult<StreamChunk>> {
  if (signal?.aborted) {
    closeQuoridorStreamIterator(iterator);
    throw new Error("AI request aborted");
  }

  if (!signal) {
    return iterator.next();
  }

  let abortHandler: (() => void) | undefined;
  const abortPromise = new Promise<never>((_, reject) => {
    abortHandler = () => {
      closeQuoridorStreamIterator(iterator);
      reject(new Error("AI request aborted"));
    };
    signal.addEventListener("abort", abortHandler, { once: true });
  });

  try {
    return await Promise.race([iterator.next(), abortPromise]);
  } finally {
    if (abortHandler) {
      signal.removeEventListener("abort", abortHandler);
    }
  }
}

function closeQuoridorStreamIterator(
  iterator: AsyncIterator<StreamChunk>
): void {
  try {
    const closeResult = iterator.return?.();
    if (closeResult) {
      void Promise.resolve(closeResult).catch(() => undefined);
    }
  } catch {
    // The caller is already aborting or unwinding a failed stream.
  }
}
