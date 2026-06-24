import type { ReasoningEffort } from "@/lib/db/schema";
import { buildGameAIInteraction } from "@/lib/games/core/ai-interactions";
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
import { estimateModelCallUsage } from "@/lib/client/token-usage";
import {
  createGameModelCallTrace,
  recordBenchmarkModelCallTrace,
} from "@/lib/benchmark/model-call-traces";
import {
  getCodenamesPublicBoard,
  getCodenamesSpymasterBoard,
  validateCodenamesClue,
} from "./engine";
import type {
  CodenamesGameState,
  CodenamesGuesserAIResponse,
  CodenamesSpymasterAIResponse,
  CodenamesTeam,
} from "./types";

export const CODENAMES_AI_MAX_TOKENS = 4096;
const MAX_AI_ATTEMPTS = 3;
const CODENAMES_RATIONALE_MAX_LENGTH = 120;
const CODENAMES_UTTERANCE_MAX_LENGTH = 70;
const CODENAMES_DIAGNOSTICS_MAX_LENGTH = 160;

export interface CodenamesAIModelOption {
  modelId: string;
  displayName: string;
  providerId: string;
}

export interface CodenamesAIDiagnosticAttempt {
  attempt: number;
  type: "parse" | "illegal" | "request";
  message: string;
  rawResponse?: string;
}

export type CodenamesAIParseResult<TParsed> =
  | { ok: true; parsed: TParsed }
  | { ok: false; type: "parse" | "illegal"; message: string };

export type CodenamesSpymasterMoveResult =
  | {
      clue: CodenamesSpymasterAIResponse["clue"];
      intendedWords?: string[];
      riskNotes?: string;
      interaction: GameAIInteraction | null;
      diagnostics?: CodenamesAIDiagnosticAttempt[];
    }
  | { error: string; diagnostics?: CodenamesAIDiagnosticAttempt[] };

export type CodenamesGuesserMoveResult =
  | {
      cardIds: string[];
      guesses: string[];
      interaction: GameAIInteraction | null;
      rationale?: string;
      diagnostics?: CodenamesAIDiagnosticAttempt[];
    }
  | { error: string; diagnostics?: CodenamesAIDiagnosticAttempt[] };

export function parseCodenamesSpymasterResponse(
  state: CodenamesGameState,
  rawText: string
): (CodenamesSpymasterAIResponse & { interaction: GameAIInteraction | null }) | null {
  const result = parseCodenamesSpymasterResponseResult(state, rawText);
  return result.ok ? result.parsed : null;
}

export function parseCodenamesSpymasterResponseResult(
  state: CodenamesGameState,
  rawText: string
): CodenamesAIParseResult<
  CodenamesSpymasterAIResponse & { interaction: GameAIInteraction | null }
> {
  const parsed = parseJsonObject(rawText);
  if (!parsed) {
    return {
      ok: false,
      type: "parse",
      message: "Response could not be parsed as Codenames spymaster JSON.",
    };
  }
  if (state.turnTeam === undefined) {
    return { ok: false, type: "illegal", message: "Codenames turn team is missing." };
  }

  const clueWord =
    typeof parsed.clue === "string"
      ? parsed.clue
      : typeof parsed.word === "string"
        ? parsed.word
        : null;
  const count =
    typeof parsed.count === "number"
      ? parsed.count
      : typeof parsed.number === "number"
        ? parsed.number
        : null;
  if (!clueWord || count === null || !Number.isInteger(count)) {
    return {
      ok: false,
      type: "parse",
      message: "Codenames spymaster JSON needs an integer clue count and clue word.",
    };
  }

  const intendedWords = Array.isArray(parsed.intendedWords)
    ? parsed.intendedWords.filter((value): value is string => typeof value === "string")
    : Array.isArray(parsed.intended_words)
      ? parsed.intended_words.filter((value): value is string => typeof value === "string")
      : undefined;
  const riskNotes =
    typeof parsed.riskNotes === "string"
      ? compactText(parsed.riskNotes, CODENAMES_DIAGNOSTICS_MAX_LENGTH)
      : typeof parsed.risk_notes === "string"
        ? compactText(parsed.risk_notes, CODENAMES_DIAGNOSTICS_MAX_LENGTH)
        : undefined;
  const validation = validateCodenamesClue(state, {
    word: clueWord,
    count,
  });
  if (!validation.ok) {
    return { ok: false, type: "illegal", message: validation.error };
  }

  const interaction = buildGameAIInteraction("spymaster", parsed);
  return {
    ok: true,
    parsed: {
      clue: validation.clue,
      ...(intendedWords ? { intendedWords: intendedWords.map(normalizeWord) } : {}),
      ...(riskNotes ? { riskNotes } : {}),
      ...(interaction?.gesture ? { gesture: interaction.gesture } : {}),
      ...(interaction?.utterance
        ? { utterance: compactText(interaction.utterance, CODENAMES_UTTERANCE_MAX_LENGTH) }
        : {}),
      ...(interaction?.confidence !== undefined ? { confidence: interaction.confidence } : {}),
      ...(interaction?.diagnostics
        ? { diagnostics: compactText(interaction.diagnostics, CODENAMES_DIAGNOSTICS_MAX_LENGTH) }
        : {}),
      interaction,
    },
  };
}

export function parseCodenamesGuesserResponse(
  state: CodenamesGameState,
  rawText: string
): (CodenamesGuesserAIResponse & { interaction: GameAIInteraction | null }) | null {
  const result = parseCodenamesGuesserResponseResult(state, rawText);
  return result.ok ? result.parsed : null;
}

export function parseCodenamesGuesserResponseResult(
  state: CodenamesGameState,
  rawText: string
): CodenamesAIParseResult<
  CodenamesGuesserAIResponse & { interaction: GameAIInteraction | null }
> {
  const parsed = parseJsonObject(rawText);
  if (!parsed || !Array.isArray(parsed.guesses)) {
    return {
      ok: false,
      type: "parse",
      message: "Response could not be parsed as Codenames operative JSON.",
    };
  }
  if (state.status !== "playing" || state.phase !== "guess") {
    return {
      ok: false,
      type: "illegal",
      message: "Codenames guesses can only be submitted in guess phase.",
    };
  }

  const seen = new Set<string>();
  const cardIds: string[] = [];
  const guesses: string[] = [];
  const maxGuesses = state.guessesRemaining;
  if (parsed.guesses.length < 1 || parsed.guesses.length > maxGuesses) {
    return {
      ok: false,
      type: "illegal",
      message: `Codenames operative must choose 1 to ${maxGuesses} guesses.`,
    };
  }

  for (const value of parsed.guesses) {
    if (typeof value !== "string") {
      return {
        ok: false,
        type: "parse",
        message: "Every Codenames guess must be a string.",
      };
    }
    const normalized = normalizeWord(value);
    if (seen.has(normalized)) {
      return {
        ok: false,
        type: "illegal",
        message: "Codenames operative cannot repeat the same guess.",
      };
    }
    seen.add(normalized);

    const card = state.cards.find(
      (candidate) =>
        normalizeWord(candidate.word) === normalized ||
        candidate.position === value.toUpperCase()
    );
    if (!card) {
      return {
        ok: false,
        type: "illegal",
        message: `Unknown Codenames guess: ${value}.`,
      };
    }
    if (card.revealed) {
      return {
        ok: false,
        type: "illegal",
        message: `${card.word} has already been revealed.`,
      };
    }
    cardIds.push(card.id);
    guesses.push(card.word);
  }

  const interaction = buildGameAIInteraction("operative", parsed);
  const rationale =
    typeof parsed.rationale === "string"
      ? compactText(parsed.rationale, CODENAMES_RATIONALE_MAX_LENGTH)
      : typeof parsed.reasoning === "string"
        ? compactText(parsed.reasoning, CODENAMES_RATIONALE_MAX_LENGTH)
        : undefined;

  return {
    ok: true,
    parsed: {
      cardIds,
      guesses,
      ...(rationale ? { rationale } : {}),
      ...(interaction?.gesture ? { gesture: interaction.gesture } : {}),
      ...(interaction?.utterance
        ? { utterance: compactText(interaction.utterance, CODENAMES_UTTERANCE_MAX_LENGTH) }
        : {}),
      ...(interaction?.confidence !== undefined ? { confidence: interaction.confidence } : {}),
      ...(interaction?.diagnostics
        ? { diagnostics: compactText(interaction.diagnostics, CODENAMES_DIAGNOSTICS_MAX_LENGTH) }
        : {}),
      interaction,
    },
  };
}

export function buildCodenamesSpymasterPrompt(
  state: CodenamesGameState,
  team: CodenamesTeam
): { system: string; user: string } {
  assertTurnTeam(state, team);
  const system = `You are the ${team.toUpperCase()} spymaster in Codenames.

Respond with ONLY compact valid JSON like {"clue":"space","count":2,"intendedWords":["MOON","STAR"]}.

Rules:
- The clue must be one word.
- The clue cannot be any visible board word.
- The count must be an integer from 0 to 9.
- Use count 0 only when you want the operative to avoid a danger theme.
- intendedWords should list your team's target words for this clue for private diagnostics.
- Avoid clues that point to opponent, neutral, or assassin words.
- Do not reveal hidden roles in utterance.
- Do not include text outside the JSON object.`;

  const board = getCodenamesSpymasterBoard(state)
    .map((card) => `${card.position} ${card.word} - ${card.role?.toUpperCase()}`)
    .join("\n");
  const ownWords = state.cards
    .filter((card) => card.role === team && !card.revealed)
    .map((card) => card.word)
    .join(", ");
  const dangers = state.cards
    .filter((card) => card.role !== team && !card.revealed)
    .map((card) => `${card.word}=${card.role.toUpperCase()}`)
    .join(", ");

  return {
    system,
    user: `Board:
${board}

Unrevealed ${team.toUpperCase()} words: ${ownWords}
Danger words: ${dangers}

Give the best legal clue for ${team.toUpperCase()}.`,
  };
}

export function buildCodenamesGuesserPrompt(
  state: CodenamesGameState,
  team: CodenamesTeam
): { system: string; user: string } {
  assertTurnTeam(state, team);
  const clue = state.activeClue;
  const system = `You are the ${team.toUpperCase()} operative in Codenames.

Respond with ONLY compact valid JSON like {"guesses":["MOON"]}.

Rules:
- Choose only visible unrevealed board words.
- Choose at least 1 and at most the remaining guess allowance.
- Do not guess revealed words.
- Do not include text outside the JSON object.`;
  const board = getCodenamesPublicBoard(state)
    .map((card) =>
      card.revealed
        ? `${card.position} ${card.word} - revealed ${card.role?.toUpperCase()}`
        : `${card.position} ${card.word}`
    )
    .join("\n");

  return {
    system,
    user: `Clue: ${clue ? `${clue.word}, ${clue.count}` : "(none)"}
Guesses remaining: ${state.guessesRemaining}

Visible board:
${board}

Choose the best guess or guesses for ${team.toUpperCase()}.`,
  };
}

export function buildCodenamesSpymasterResponseFormat(): StructuredOutputFormat {
  return {
    name: "codenames_spymaster_clue",
    strict: false,
    schema: {
      type: "object",
      properties: {
        clue: { type: "string", description: "One-word Codenames clue." },
        count: {
          type: "integer",
          description: "Number of intended words. Zero is allowed.",
        },
        intendedWords: {
          type: "array",
          items: { type: "string" },
        },
        riskNotes: {
          type: "string",
          maxLength: CODENAMES_DIAGNOSTICS_MAX_LENGTH,
        },
        gesture: {
          type: "string",
          enum: ["thinking", "confident", "confused", "celebrating", "apologetic", "neutral"],
        },
        utterance: { type: "string", maxLength: CODENAMES_UTTERANCE_MAX_LENGTH },
        confidence: { type: "number" },
        diagnostics: {
          type: "string",
          maxLength: CODENAMES_DIAGNOSTICS_MAX_LENGTH,
        },
      },
      required: ["clue", "count"],
      additionalProperties: false,
    },
  };
}

export function buildCodenamesGuessResponseFormat(): StructuredOutputFormat {
  return {
    name: "codenames_operative_guess",
    strict: false,
    schema: {
      type: "object",
      properties: {
        guesses: {
          type: "array",
          items: { type: "string" },
          description: "Visible board words to guess.",
        },
        rationale: { type: "string", maxLength: CODENAMES_RATIONALE_MAX_LENGTH },
        gesture: {
          type: "string",
          enum: ["thinking", "confident", "confused", "celebrating", "apologetic", "neutral"],
        },
        utterance: { type: "string", maxLength: CODENAMES_UTTERANCE_MAX_LENGTH },
        confidence: { type: "number" },
        diagnostics: {
          type: "string",
          maxLength: CODENAMES_DIAGNOSTICS_MAX_LENGTH,
        },
      },
      required: ["guesses"],
      additionalProperties: false,
    },
  };
}

export function getCodenamesAIModels(): CodenamesAIModelOption[] {
  return getEnabledModels().map((model) => ({
    modelId: `${model.providerId}:${model.id}`,
    displayName: model.name,
    providerId: model.providerId,
  }));
}

export function getCodenamesModelApiKey(modelId: string): string | null {
  const { providerId } = parseModelId(modelId);
  const customModel = getCustomModelByFullId(modelId);
  if (customModel) return customModel.apiKey || null;
  return getDecryptedApiKey(providerId);
}

export function getCodenamesModelBaseURL(modelId: string): string | undefined {
  const { providerId } = parseModelId(modelId);
  const customModel = getCustomModelByFullId(modelId);
  if (customModel) return customModel.baseURL;
  return getProviderBaseURL(providerId);
}

export async function requestCodenamesSpymasterMove(params: {
  state: CodenamesGameState;
  team: CodenamesTeam;
  modelId: string;
  reasoningEffort: ReasoningEffort;
  apiKey: string;
  baseURL?: string;
  signal?: AbortSignal;
}): Promise<CodenamesSpymasterMoveResult> {
  const { system, user } = buildCodenamesSpymasterPrompt(params.state, params.team);
  const result = await requestCodenamesJson({
    modelId: params.modelId,
    apiKey: params.apiKey,
    baseURL: params.baseURL,
    reasoningEffort: params.reasoningEffort,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    structuredOutput: buildCodenamesSpymasterResponseFormat(),
    signal: params.signal,
    participantId: `${params.team}:spymaster`,
    parse: (raw) => parseCodenamesSpymasterResponseResult(params.state, raw),
    correction:
      "Your Codenames clue was invalid. Respond with ONLY JSON like {\"clue\":\"space\",\"count\":2}.",
  });
  if ("error" in result) return result;
  return {
    clue: result.parsed.clue,
    intendedWords: result.parsed.intendedWords,
    riskNotes: result.parsed.riskNotes,
    interaction: result.parsed.interaction,
    diagnostics: result.diagnostics,
  };
}

export async function requestCodenamesGuesserMove(params: {
  state: CodenamesGameState;
  team: CodenamesTeam;
  modelId: string;
  reasoningEffort: ReasoningEffort;
  apiKey: string;
  baseURL?: string;
  signal?: AbortSignal;
}): Promise<CodenamesGuesserMoveResult> {
  const { system, user } = buildCodenamesGuesserPrompt(params.state, params.team);
  const result = await requestCodenamesJson({
    modelId: params.modelId,
    apiKey: params.apiKey,
    baseURL: params.baseURL,
    reasoningEffort: params.reasoningEffort,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    structuredOutput: buildCodenamesGuessResponseFormat(),
    signal: params.signal,
    participantId: `${params.team}:operative`,
    parse: (raw) => parseCodenamesGuesserResponseResult(params.state, raw),
    correction:
      "Your Codenames guesses were invalid. Respond with ONLY JSON like {\"guesses\":[\"MOON\"]}.",
  });
  if ("error" in result) return result;
  return {
    cardIds: result.parsed.cardIds,
    guesses: result.parsed.guesses,
    interaction: result.parsed.interaction,
    rationale: result.parsed.rationale,
    diagnostics: result.diagnostics,
  };
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

function normalizeWord(value: string): string {
  return value.trim().toUpperCase();
}

function assertTurnTeam(state: CodenamesGameState, team: CodenamesTeam): void {
  if (state.turnTeam !== team) {
    throw new Error(
      `Codenames AI requested ${team} while ${state.turnTeam} is on turn.`
    );
  }
}

function compactText(value: string, maxLength: number): string {
  const compact = value.replace(/\s+/g, " ").trim();
  if (compact.length <= maxLength) return compact;
  return `${compact.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
}

async function requestCodenamesJson<TParsed>(params: {
  modelId: string;
  apiKey: string;
  baseURL?: string;
  reasoningEffort: ReasoningEffort;
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
  structuredOutput: StructuredOutputFormat;
  signal?: AbortSignal;
  participantId?: string;
  parse: (rawText: string) => CodenamesAIParseResult<TParsed>;
  correction: string;
}): Promise<
  | { parsed: TParsed; diagnostics: CodenamesAIDiagnosticAttempt[] }
  | { error: string; diagnostics: CodenamesAIDiagnosticAttempt[] }
> {
  const { providerId, model } = parseModelId(params.modelId);
  const customModel = getCustomModelByFullId(params.modelId);
  const diagnostics: CodenamesAIDiagnosticAttempt[] = [];
  const messages = [...params.messages];
  const traceStartedAt = new Date().toISOString();
  const traceStartMs = Date.now();
  const tracePrompt = params.messages
    .map((message) => `${message.role}:\n${message.content}`)
    .join("\n\n");
  const recordTrace = async (input: {
    finalStatus: "parsed" | "parse_error" | "illegal" | "provider_error";
    rawResponse?: string;
    parsedResponseJson?: string;
    error?: string;
  }) => {
    const usage = estimateModelCallUsage({
      messages,
      output: input.rawResponse ?? "",
      maxTokens: CODENAMES_AI_MAX_TOKENS,
    });
    await recordBenchmarkModelCallTrace(
      createGameModelCallTrace({
        modelId: params.modelId,
        providerId,
        participantId: params.participantId,
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
    if (params.signal?.aborted) return { error: "AI request aborted", diagnostics };

    try {
      const responseText = await streamCodenamesResponseText({
        providerId,
        model,
        customModel,
        apiKey: params.apiKey,
        baseURL: params.baseURL,
        messages,
        reasoningEffort: params.reasoningEffort,
        structuredOutput: params.structuredOutput,
        signal: params.signal,
      });
      const parsed = params.parse(responseText);
      if (parsed.ok) {
        await recordTrace({
          finalStatus: "parsed",
          rawResponse: responseText,
          parsedResponseJson: JSON.stringify(parsed.parsed),
        });
        return { parsed: parsed.parsed, diagnostics };
      }

      diagnostics.push({
        attempt: attempt + 1,
        type: parsed.type,
        message: parsed.message,
        rawResponse: responseText,
      });
      if (attempt < MAX_AI_ATTEMPTS - 1) {
        messages.push({ role: "assistant", content: responseText });
        messages.push({
          role: "user",
          content: `${params.correction}\nIssue: ${parsed.message}`,
        });
        continue;
      }
      await recordTrace({
        finalStatus: parsed.type === "parse" ? "parse_error" : "illegal",
        rawResponse: responseText,
        error: "Failed to get a legal Codenames AI response",
      });
      return { error: "Failed to get a legal Codenames AI response", diagnostics };
    } catch (error) {
      if (params.signal?.aborted) return { error: "AI request aborted", diagnostics };
      diagnostics.push({
        attempt: attempt + 1,
        type: "request",
        message: error instanceof Error ? error.message : "Unknown error",
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

  return { error: "Failed to get valid Codenames response", diagnostics };
}

async function streamCodenamesResponseText(params: {
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
        maxTokens: CODENAMES_AI_MAX_TOKENS,
        temperature: 0.3,
        reasoningEffort: params.reasoningEffort,
        structuredOutput: params.structuredOutput,
      })
    : standardProviderStream(params);
  return collectCodenamesStreamTextForTests(stream, params.signal);
}

export async function collectCodenamesStreamTextForTests(
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
    maxTokens: CODENAMES_AI_MAX_TOKENS,
    temperature: 0.3,
    reasoningEffort: params.reasoningEffort,
    baseURL: params.baseURL,
    structuredOutput: params.structuredOutput,
  });
}
