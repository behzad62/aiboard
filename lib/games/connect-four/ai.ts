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
  CONNECT_FOUR_COLUMNS,
  dropDisc,
  getLegalColumns,
  isLegalColumn,
} from "./engine";
import type {
  ConnectFourAIResponse,
  ConnectFourGameState,
  ConnectFourPlayer,
} from "./types";

const MAX_AI_ATTEMPTS = 3;
export const CONNECT_FOUR_AI_MAX_TOKENS = 4096;
const CONNECT_FOUR_REASONING_MAX_LENGTH = 80;
const CONNECT_FOUR_UTTERANCE_MAX_LENGTH = 48;
const CONNECT_FOUR_DIAGNOSTICS_MAX_LENGTH = 120;
const CENTER_FIRST_COLUMNS = [3, 2, 4, 1, 5, 0, 6] as const;

export interface RequestConnectFourAIMoveParams {
  state: ConnectFourGameState;
  modelId: string;
  reasoningEffort: ReasoningEffort;
  apiKey: string;
  baseURL?: string;
  runnerToken?: string;
  signal?: AbortSignal;
}

export interface ConnectFourAIMoveSuccess
  extends GameAIInteractionResult<number> {
  column: number;
  interaction: GameAIInteraction | null;
  reasoning?: string;
}

export interface ConnectFourAIDiagnosticAttempt {
  attempt: number;
  type: "parse" | "illegal" | "request";
  message: string;
  legalColumns: number[];
  rawResponse?: string;
  rejectedColumn?: number;
}

export interface ConnectFourAIMoveError {
  error: string;
  diagnostics?: ConnectFourAIDiagnosticAttempt[];
}

export type ConnectFourAIMoveResult =
  | ConnectFourAIMoveSuccess
  | ConnectFourAIMoveError;

export interface AvailableConnectFourModel {
  modelId: string;
  displayName: string;
  providerId: string;
}

export function formatLegalColumnList(columns: number[]): string {
  return columns.map((column) => String(column + 1)).join(", ");
}

export function buildConnectFourCorrectionPrompt(
  reason: "parse" | "illegal",
  legalColumns: number[],
  rejectedColumn?: number
): string {
  const legalList = formatLegalColumnList(legalColumns);
  if (reason === "parse") {
    return `Your response could not be parsed as valid Connect Four JSON. Respond with ONLY a JSON object like {"column":4}. Legal columns: ${legalList}`;
  }

  const rejected =
    rejectedColumn === undefined ? "that column" : `column ${rejectedColumn + 1}`;
  return `Your selected ${rejected} is not legal. Legal columns: ${legalList}. Respond with ONLY a JSON object like {"column":4}.`;
}

export function getConnectFourRetryDelayMs(attempt: number): number {
  return Math.min(1000, 250 * 2 ** Math.max(0, attempt));
}

export function parseConnectFourAIResponse(
  rawText: string
): ConnectFourAIResponse | null {
  if (!rawText || typeof rawText !== "string") return null;

  let text = rawText.trim();
  const codeBlockMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (codeBlockMatch) {
    text = codeBlockMatch[1].trim();
  }

  const jsonMatch = text.match(/\{[\s\S]*?\}/);
  if (!jsonMatch) return null;

  try {
    const parsed = JSON.parse(jsonMatch[0]);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      !Number.isInteger(parsed.column) ||
      parsed.column < 1 ||
      parsed.column > CONNECT_FOUR_COLUMNS
    ) {
      return null;
    }

    const response: ConnectFourAIResponse = {
      column: parsed.column - 1,
    };

    if (typeof parsed.reasoning === "string") {
      response.reasoning = compactConnectFourText(
        parsed.reasoning,
        CONNECT_FOUR_REASONING_MAX_LENGTH
      );
    }

    const interaction = buildGameAIInteraction("ai", parsed);
    if (interaction?.gesture) response.gesture = interaction.gesture;
    if (interaction?.utterance) {
      response.utterance = compactConnectFourText(
        interaction.utterance,
        CONNECT_FOUR_UTTERANCE_MAX_LENGTH
      );
    }
    if (interaction?.confidence !== undefined) {
      response.confidence = interaction.confidence;
    }
    if (interaction?.diagnostics) {
      response.diagnostics = compactConnectFourText(
        interaction.diagnostics,
        CONNECT_FOUR_DIAGNOSTICS_MAX_LENGTH
      );
    }

    return response;
  } catch {
    return null;
  }
}

function compactConnectFourText(value: string, maxLength: number): string {
  const compact = value.replace(/\s+/g, " ").trim();
  if (compact.length <= maxLength) return compact;
  return `${compact.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
}

export function chooseFallbackConnectFourColumn(
  state: ConnectFourGameState
): number | null {
  const legalColumns = getLegalColumns(state);
  if (legalColumns.length === 0) return null;

  const winningColumn = findImmediateWinningColumn(state, state.turn, legalColumns);
  if (winningColumn !== null) return winningColumn;

  const opponent = getNextConnectFourPlayer(state.turn);
  const blockingColumn = findImmediateWinningColumn(state, opponent, legalColumns);
  if (blockingColumn !== null) return blockingColumn;

  const preferredLegalColumns = CENTER_FIRST_COLUMNS.filter((column) =>
    legalColumns.includes(column)
  );
  const safeColumn = preferredLegalColumns.find(
    (column) => !allowsOpponentImmediateWin(state, column, opponent)
  );
  if (safeColumn !== undefined) return safeColumn;

  return preferredLegalColumns[0] ?? legalColumns[0] ?? null;
}

export function buildConnectFourPrompt(
  state: ConnectFourGameState,
  legalColumns = getLegalColumns(state)
): { system: string; user: string } {
  const system = `You are a Connect Four engine choosing a legal move.

Respond with ONLY compact valid JSON like {"column":4}.

Rules:
- "column" is required and must be one of the legal one-based columns.
- Omit optional fields unless they add clear value.
- Optional "gesture" values: "thinking", "confident", "confused", "celebrating", "apologetic", "neutral".
- Optional "utterance" must be short table-talk for the other player. Do not mention columns, threats, blocks, winning lines, calculations, or future plans.
- Optional "reasoning" must be under ${CONNECT_FOUR_REASONING_MAX_LENGTH} characters.
- Optional "confidence" must be a number from 0 to 1.
- Do not include text outside the JSON object.
- Do not wrap the JSON in markdown code fences.`;

  const moveHistory =
    state.moveHistory.length > 0
      ? state.moveHistory
          .map((record, index) => `${index + 1}. ${record.displayColumn}`)
          .join(", ")
      : "(no moves yet)";

  const boardRows = state.board
    .map((row) =>
      row
        .map((cell) => {
          if (cell === "red") return "R";
          if (cell === "yellow") return "Y";
          return ".";
        })
        .join(" ")
    )
    .join("\n");

  const user = `Board rows top-to-bottom (R = red, Y = yellow, . = empty):
${boardRows}

Turn: ${state.turn === "red" ? "Red" : "Yellow"}

Move history columns: ${moveHistory}

Legal columns: ${formatLegalColumnList(legalColumns)}

Choose the best legal column. Respond with only the JSON object.`;

  return { system, user };
}

export function buildConnectFourMoveResponseFormat(): StructuredOutputFormat {
  return {
    name: "connect_four_move",
    strict: false,
    schema: {
      type: "object",
      properties: {
        column: {
          type: "number",
          description: "One-based Connect Four column number to play.",
        },
        reasoning: {
          type: "string",
          maxLength: CONNECT_FOUR_REASONING_MAX_LENGTH,
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
          maxLength: CONNECT_FOUR_UTTERANCE_MAX_LENGTH,
          description: "Optional short phrase, under 48 characters.",
        },
        confidence: {
          type: "number",
          description: "Confidence from 0 to 1.",
        },
        diagnostics: {
          type: "string",
          maxLength: CONNECT_FOUR_DIAGNOSTICS_MAX_LENGTH,
          description: "Optional model diagnostics, under 120 characters.",
        },
      },
      required: ["column"],
      additionalProperties: false,
    },
  };
}

export async function requestConnectFourAIMove(
  params: RequestConnectFourAIMoveParams
): Promise<ConnectFourAIMoveResult> {
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

  const legalColumns = getLegalColumns(state);
  if (legalColumns.length === 0) {
    return { error: "No legal columns available" };
  }

  const { providerId, model } = parseModelId(modelId);
  const customModel = getCustomModelByFullId(modelId);
  const { system, user } = buildConnectFourPrompt(state, legalColumns);
  const traceStartedAt = new Date().toISOString();
  const traceStartMs = Date.now();
  const tracePrompt = `${system}\n\n${user}`;
  const structuredOutput = buildConnectFourMoveResponseFormat();
  const messages: Array<{
    role: "system" | "user" | "assistant";
    content: string;
  }> = [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
  const diagnostics: ConnectFourAIDiagnosticAttempt[] = [];
  const recordTrace = async (input: {
    finalStatus: "parsed" | "parse_error" | "illegal" | "provider_error";
    rawResponse?: string;
    parsedResponseJson?: string;
    error?: string;
  }) => {
    const usage = estimateModelCallUsage({
      messages,
      output: input.rawResponse ?? "",
      maxTokens: CONNECT_FOUR_AI_MAX_TOKENS,
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
  };

  for (let attempt = 0; attempt < MAX_AI_ATTEMPTS; attempt++) {
    if (signal?.aborted) {
      return { error: "AI request aborted" };
    }

    try {
      const responseText = await streamConnectFourResponseText({
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

      if (signal?.aborted) {
        return { error: "AI request aborted" };
      }

      const parsed = parseConnectFourAIResponse(responseText);
      if (!parsed) {
        diagnostics.push({
          attempt: attempt + 1,
          type: "parse",
          message: "Response could not be parsed as Connect Four JSON.",
          legalColumns,
          rawResponse: responseText,
        });
        if (attempt < MAX_AI_ATTEMPTS - 1) {
          messages.push({ role: "assistant", content: responseText });
          messages.push({
            role: "user",
            content: buildConnectFourCorrectionPrompt("parse", legalColumns),
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

      if (!isLegalColumn(state, parsed.column)) {
        diagnostics.push({
          attempt: attempt + 1,
          type: "illegal",
          message: `AI selected illegal column ${parsed.column + 1}.`,
          legalColumns,
          rawResponse: responseText,
          rejectedColumn: parsed.column,
        });
        if (attempt < MAX_AI_ATTEMPTS - 1) {
          messages.push({ role: "assistant", content: responseText });
          messages.push({
            role: "user",
            content: buildConnectFourCorrectionPrompt(
              "illegal",
              legalColumns,
              parsed.column
            ),
          });
          continue;
        }
        await recordTrace({
          finalStatus: "illegal",
          rawResponse: responseText,
          parsedResponseJson: JSON.stringify(parsed),
          error: `AI returned illegal column: ${parsed.column + 1} after ${MAX_AI_ATTEMPTS} attempts`,
        });
        return {
          error: `AI returned illegal column: ${parsed.column + 1} after ${MAX_AI_ATTEMPTS} attempts`,
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
        action: parsed.column,
        column: parsed.column,
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
          legalColumns,
        });
        await delayWithAbort(getConnectFourRetryDelayMs(attempt), signal);
        continue;
      }

      const errorMessage = err instanceof Error ? err.message : "Unknown error";
      diagnostics.push({
        attempt: attempt + 1,
        type: "request",
        message: errorMessage,
        legalColumns,
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
    error: "Failed to get valid column after maximum retries",
    diagnostics,
  };
}

export function getAvailableConnectFourModels(): AvailableConnectFourModel[] {
  return getEnabledModels().map((model) => ({
    modelId: `${model.providerId}:${model.id}`,
    displayName: model.name,
    providerId: model.providerId,
  }));
}

export function getConnectFourModelApiKey(modelId: string): string | null {
  const { providerId } = parseModelId(modelId);
  const customModel = getCustomModelByFullId(modelId);
  if (customModel) {
    return customModel.apiKey || null;
  }

  return getDecryptedApiKey(providerId);
}

export function getConnectFourModelBaseURL(
  modelId: string
): string | undefined {
  const { providerId } = parseModelId(modelId);
  const customModel = getCustomModelByFullId(modelId);
  if (customModel) {
    return customModel.baseURL;
  }

  return getProviderBaseURL(providerId);
}

export function getConnectFourModelRunnerToken(
  modelId: string
): string | undefined {
  const { providerId } = parseModelId(modelId);
  const customModel = getCustomModelByFullId(modelId);
  if (customModel) {
    return undefined;
  }

  return getProviderRunnerToken(providerId);
}

function getNextConnectFourPlayer(
  player: ConnectFourPlayer
): ConnectFourPlayer {
  return player === "red" ? "yellow" : "red";
}

function findImmediateWinningColumn(
  state: ConnectFourGameState,
  player: ConnectFourPlayer,
  legalColumns: number[]
): number | null {
  const stateForPlayer = player === state.turn ? state : { ...state, turn: player };
  for (const column of CENTER_FIRST_COLUMNS) {
    if (!legalColumns.includes(column)) continue;
    const nextState = dropDisc(stateForPlayer, column, 0);
    if (nextState.status === "win" && nextState.winner === player) {
      return column;
    }
  }
  return null;
}

function allowsOpponentImmediateWin(
  state: ConnectFourGameState,
  column: number,
  opponent: ConnectFourPlayer
): boolean {
  const nextState = dropDisc(state, column, 0);
  if (nextState.status !== "playing") return false;

  const legalColumns = getLegalColumns(nextState);
  return findImmediateWinningColumn(nextState, opponent, legalColumns) !== null;
}

async function streamConnectFourResponseText(params: {
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
        maxTokens: CONNECT_FOUR_AI_MAX_TOKENS,
        temperature: 0.3,
        reasoningEffort: params.reasoningEffort,
        structuredOutput: params.structuredOutput,
      })
    : getStandardProviderStream(params);

  return collectConnectFourStreamTextForTests(stream, params.signal);
}

export async function collectConnectFourStreamTextForTests(
  stream: AsyncIterable<StreamChunk>,
  signal?: AbortSignal
): Promise<string> {
  const iterator = stream[Symbol.asyncIterator]();
  let responseText = "";

  while (true) {
    const next = await nextConnectFourStreamChunk(iterator, signal);
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
    maxTokens: CONNECT_FOUR_AI_MAX_TOKENS,
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

async function nextConnectFourStreamChunk(
  iterator: AsyncIterator<StreamChunk>,
  signal: AbortSignal | undefined
): Promise<IteratorResult<StreamChunk>> {
  if (signal?.aborted) {
    closeConnectFourStreamIterator(iterator);
    throw new Error("AI request aborted");
  }

  if (!signal) {
    return iterator.next();
  }

  let abortHandler: (() => void) | undefined;
  const abortPromise = new Promise<never>((_, reject) => {
    abortHandler = () => {
      closeConnectFourStreamIterator(iterator);
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

function closeConnectFourStreamIterator(
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
