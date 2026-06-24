/**
 * Browser engine — a port of lib/orchestrator/engine.ts that reads/writes the
 * client store and calls providers in-browser. Same logic; the only differences
 * are the data layer (client store) and that events go to an `emit` callback
 * (no SSE). The OrchestratorEvent type is reused (type-only) from the server
 * engine so the UI keeps a single definition.
 */

import { v4 as uuidv4 } from "uuid";
import type {
  DiscussionMode,
  EffortLevel,
  ReasoningEffort,
  Verbosity,
} from "@/lib/db/schema";
import {
  getDiscussionById,
  getMessagesForDiscussion,
  insertFinalResult,
  insertMessage,
  updateDiscussion,
} from "./store";
import {
  CUSTOM_PROVIDER_ID,
  getCustomModelByFullId,
  getDecryptedApiKey,
  getProvider,
  getProviderBaseURL,
  resolveModelCapabilities,
  streamCustomChat,
} from "./providers";
import {
  parseModelId,
  type ChatMessage,
  type SelectedModel,
  type StructuredOutputFormat,
} from "@/lib/providers/base";
import { EFFORT_CONFIG } from "@/lib/orchestrator/config";
import { extractJudgeResult } from "@/lib/orchestrator/parse";
import {
  buildConvergencePrompt,
  buildConvergenceVoteResponseFormat,
  buildJudgePrompt,
  buildRoundSystemPrompt,
  buildTranscriptFromMessages,
  buildUserPrompt,
  buildVerbosityInstruction,
} from "@/lib/orchestrator/prompts";
import { loadAttachmentPayloads } from "./attachments";
import type { AttachmentPayload } from "@/lib/attachments/types";
import { buildAttachmentPromptSection } from "@/lib/attachments/prompt-text";
import { modelSupportsInputTypes } from "@/lib/providers/capabilities";
import type { OrchestratorEvent } from "@/lib/orchestrator/engine";
import { estimateModelCallUsage } from "./token-usage";

export type { OrchestratorEvent } from "@/lib/orchestrator/engine";

type EventCallback = (event: OrchestratorEvent) => void;

const runningDiscussions = new Set<string>();
const abortControllers = new Map<string, AbortController>();

export function isDiscussionRunning(id: string): boolean {
  return runningDiscussions.has(id);
}

/** Stop a running discussion/build. The engine winds down at the next token. */
export function stopDiscussion(id: string): void {
  abortControllers.get(id)?.abort();
}

export function abortError(): DOMException {
  return new DOMException("Stopped by the user", "AbortError");
}

export function isAbortError(err: unknown): boolean {
  return err instanceof DOMException && err.name === "AbortError";
}

// ── Transient-error retry ─────────────────────────────────────────────────────
// Provider hiccups (503 high demand, 429 rate limits, network blips) shouldn't
// kill a whole run. Retried with backoff — but only while NOTHING has been
// streamed yet, so the UI never sees duplicated tokens.

const TRANSIENT_ERROR =
  /\b(408|409|429|500|502|503|504|529)\b|overloaded|rate.?limit|high demand|temporar|timeout|timed out|network|fetch failed|failed to fetch|econn|socket|unavailable|try again/i;

function isTransientError(err: unknown): boolean {
  return err instanceof Error && TRANSIENT_ERROR.test(err.message);
}

const RETRY_DELAYS_MS = [2_000, 6_000];

/**
 * Run `attempt` with retries on transient errors. `hasOutput` guards against
 * retrying a stream that already emitted tokens (which would duplicate them).
 */
async function withTransientRetry<T>(
  attempt: () => Promise<T>,
  hasOutput: () => boolean,
  label: string,
  signal?: AbortSignal
): Promise<T> {
  for (let tryNo = 0; ; tryNo++) {
    try {
      return await attempt();
    } catch (err) {
      if (
        isAbortError(err) ||
        hasOutput() ||
        tryNo >= RETRY_DELAYS_MS.length ||
        !isTransientError(err)
      ) {
        throw err;
      }
      console.warn(
        `[engine] transient error from ${label} — retrying in ${RETRY_DELAYS_MS[tryNo] / 1000}s (${tryNo + 1}/${RETRY_DELAYS_MS.length}):`,
        err instanceof Error ? err.message : err
      );
      await new Promise((resolve) =>
        setTimeout(resolve, RETRY_DELAYS_MS[tryNo])
      );
      if (signal?.aborted) throw abortError();
    }
  }
}

export async function collectStream(
  modelId: string,
  providerId: string,
  model: string,
  messages: ChatMessage[],
  maxTokens: number,
  temperature: number,
  reasoningEffort: ReasoningEffort,
  attachments: AttachmentPayload[],
  onToken?: (token: string) => void,
  signal?: AbortSignal,
  stopWhen?: (content: string) => boolean,
  structuredOutput?: StructuredOutputFormat
): Promise<string> {
  if (signal?.aborted) throw abortError();
  if (providerId === CUSTOM_PROVIDER_ID) {
    const customModel = getCustomModelByFullId(modelId);
    if (!customModel) {
      throw new Error("Custom model not found");
    }
    const customCaps = customModel.capabilities ?? {
      image: false,
      document: false,
      audio: false,
      video: false,
    };
    const customAttachments = attachments.filter(
      (a) => a.category !== "text_inline" && customCaps[a.category]
    );
    let customContent = "";
    return withTransientRetry(
      async () => {
        for await (const chunk of streamCustomChat(customModel, {
          apiKey: "",
          model: customModel.model,
          messages,
          attachments: customAttachments,
          maxTokens,
          temperature,
          reasoningEffort,
          structuredOutput,
        })) {
          if (signal?.aborted) throw abortError();
          if (chunk.type === "token" && chunk.content) {
            customContent += chunk.content;
            onToken?.(chunk.content);
            if (stopWhen?.(customContent)) break;
          }
          if (chunk.type === "error") {
            throw new Error(chunk.error ?? "Stream error");
          }
        }
        return customContent;
      },
      () => customContent.length > 0,
      modelId,
      signal
    );
  }

  const provider = getProvider(providerId);
  const apiKey = getDecryptedApiKey(providerId);
  if (!provider || !apiKey) {
    throw new Error(`Provider ${providerId} is not configured`);
  }

  // Foundry models (and any future gateway provider) aren't in the static
  // capability registry — resolve their caps explicitly.
  const resolvedCaps = resolveModelCapabilities(modelId);
  const modelAttachments = attachments.filter((a) => {
    if (a.category === "text_inline") return true;
    return resolvedCaps
      ? resolvedCaps[a.category]
      : modelSupportsInputTypes(modelId, [a.category]);
  });

  let content = "";
  return withTransientRetry(
    async () => {
      for await (const chunk of provider.streamChat({
        apiKey,
        baseURL: getProviderBaseURL(providerId),
        model,
        messages,
        attachments: modelAttachments,
        maxTokens,
        temperature,
        reasoningEffort,
        structuredOutput,
        ...(resolvedCaps ? { capabilities: resolvedCaps } : {}),
      })) {
        if (signal?.aborted) throw abortError();
        if (chunk.type === "token" && chunk.content) {
          content += chunk.content;
          onToken?.(chunk.content);
          if (stopWhen?.(content)) break;
        }
        if (chunk.type === "error") {
          throw new Error(chunk.error ?? "Stream error");
        }
      }
      return content;
    },
    () => content.length > 0,
    modelId,
    signal
  );
}

function parseJsonResponse<T>(text: string): T | null {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    return JSON.parse(match[0]) as T;
  } catch {
    return null;
  }
}

function wordOverlapSimilarity(a: string, b: string): number {
  const wordsA = new Set(a.toLowerCase().split(/\W+/).filter(Boolean));
  const wordsB = new Set(b.toLowerCase().split(/\W+/).filter(Boolean));
  if (wordsA.size === 0 || wordsB.size === 0) return 0;
  let overlap = 0;
  for (const w of wordsA) {
    if (wordsB.has(w)) overlap++;
  }
  return overlap / Math.max(wordsA.size, wordsB.size);
}

function resolveModels(modelIds: string[]): SelectedModel[] {
  return modelIds.map((fullId) => {
    const { providerId, model } = parseModelId(fullId);
    if (providerId === CUSTOM_PROVIDER_ID) {
      const customModel = getCustomModelByFullId(fullId);
      return {
        modelId: fullId,
        providerId,
        displayName: customModel?.label ?? model,
      };
    }
    const provider = getProvider(providerId);
    const modelInfo = provider?.listModels().find((m) => m.id === model);
    return {
      modelId: fullId,
      providerId,
      displayName: modelInfo?.name ?? model,
    };
  });
}

export async function runDiscussion(
  discussionId: string,
  emit: EventCallback,
  hooks?: import("./build-engine").BuildHooks
): Promise<void> {
  if (runningDiscussions.has(discussionId)) {
    return;
  }

  runningDiscussions.add(discussionId);
  const controller = new AbortController();
  abortControllers.set(discussionId, controller);
  const signal = controller.signal;

  try {
    const discussion = getDiscussionById(discussionId);
    if (!discussion) {
      emit({ type: "error", message: "Discussion not found" });
      return;
    }

    const modelIds: string[] = JSON.parse(discussion.modelIds);
    const models = resolveModels(modelIds);
    const effort = discussion.effort as EffortLevel;
    const mode = discussion.mode as DiscussionMode;

    if (mode === "build") {
      // Build runs an Architect-orchestrated task loop, not the round loop.
      // Dynamic import keeps the engine<->build-engine dependency acyclic.
      const { runBuildDiscussion } = await import("./build-engine");
      await runBuildDiscussion(discussion, models, emit, hooks, signal);
      return;
    }

    const config = EFFORT_CONFIG[effort];
    const verbosity = (discussion.verbosity ?? "balanced") as Verbosity;
    const verbosityInstruction = buildVerbosityInstruction(
      verbosity,
      discussion.styleNote
    );
    const reasoningEffort = (discussion.reasoningEffort ??
      "default") as ReasoningEffort;
    const roundMaxTokens = config.maxTokens;
    const finalMaxTokens = config.judgeMaxTokens;
    const skipConvergenceVote = config.skipConvergenceVote;
    const modelNames = Object.fromEntries(
      models.map((m) => [m.modelId, m.displayName])
    );
    const emitTokenUsage = (input: {
      messageId: string;
      modelId: string;
      modelName: string;
      providerId: string;
      round: number;
      label: string;
      messages: ChatMessage[];
      output: string;
      maxTokens: number;
    }): void => {
      const usage = estimateModelCallUsage({
        messages: input.messages,
        output: input.output,
        maxTokens: input.maxTokens,
      });
      emit({
        type: "token_usage",
        messageId: input.messageId,
        modelId: input.modelId,
        modelName: input.modelName,
        providerId: input.providerId,
        round: input.round,
        label: input.label,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        totalTokens: usage.totalTokens,
        maxTokens: usage.maxTokens,
        estimated: usage.estimated,
      });
    };

    emit({
      type: "diagnostic",
      phase: "initializing",
      message: `Starting discussion with ${models.length} model${models.length === 1 ? "" : "s"}`,
    });

    const attachmentIds: string[] = discussion.attachmentIds
      ? JSON.parse(discussion.attachmentIds)
      : [];
    const allAttachments = loadAttachmentPayloads(attachmentIds);
    const inlineAttachmentText = buildAttachmentPromptSection(
      allAttachments.filter((a) => a.category === "text_inline")
    );

    updateDiscussion(discussionId, {
      status: "running",
      maxRounds: config.maxRounds,
      updatedAt: new Date().toISOString(),
    });

    emit({ type: "status", status: "running", round: 0, maxRounds: config.maxRounds });

    // Resume support: responses persist per (round, model), so after a failure
    // (e.g. a network error during judging) we keep what's already saved, skip
    // those turns, and continue from the first missing one.
    const allMessages: Array<{
      id: string;
      round: number;
      modelId: string;
      content: string;
    }> = getMessagesForDiscussion(discussionId)
      .filter((m) => m.role === "assistant")
      .map((m) => ({
        id: m.id,
        round: m.round,
        modelId: m.modelId,
        content: m.content,
      }));
    const resumeRound = allMessages.reduce((max, m) => Math.max(max, m.round), 0);
    const startRound = Math.max(1, resumeRound);
    if (resumeRound > 0) {
      emit({
        type: "diagnostic",
        phase: "initializing",
        message: `Resuming from round ${resumeRound} — keeping ${allMessages.length} earlier response${allMessages.length === 1 ? "" : "s"}`,
      });
    }

    let previousRoundTexts: string[] = [];
    let shouldStopEarly = false;

    for (let round = startRound; round <= config.maxRounds; round++) {
      if (shouldStopEarly) break;
      if (signal.aborted) throw abortError();

      emit({
        type: "diagnostic",
        phase: "round_preparing",
        round,
        message: `Preparing round ${round} of ${config.maxRounds}`,
      });

      updateDiscussion(discussionId, {
        currentRound: round,
        updatedAt: new Date().toISOString(),
      });

      emit({ type: "status", status: "running", round, maxRounds: config.maxRounds });

      // The specialist lead is pinned to the first selected model for the whole
      // discussion — rotating it would tell a different model each round to
      // "revise your draft" for a draft it never wrote.
      const leadIndex = 0;
      const currentRoundTexts: string[] = [];

      for (let index = 0; index < models.length; index++) {
        const model = models[index];

        if (mode === "specialist" && round === 1 && index !== leadIndex) {
          continue;
        }

        // Already answered this round before a resume — keep the saved response.
        if (
          allMessages.some(
            (m) => m.round === round && m.modelId === model.modelId
          )
        ) {
          continue;
        }

        const transcript = buildTranscriptFromMessages(allMessages, modelNames);
        const systemPrompt = buildRoundSystemPrompt(
          mode,
          round,
          config.maxRounds,
          models,
          index,
          leadIndex,
          verbosityInstruction
        );

        const messageId = uuidv4();
        emit({
          type: "message_start",
          messageId,
          modelId: model.modelId,
          modelName: model.displayName,
          round,
          role: "assistant",
        });

        const { providerId, model: modelName } = parseModelId(model.modelId);
        emit({
          type: "diagnostic",
          phase: "model_connecting",
          round,
          modelId: model.modelId,
          modelName: model.displayName,
          providerId,
          message: `Connecting to ${model.displayName} via ${providerId}`,
        });

        const messages: ChatMessage[] = [
          { role: "system", content: systemPrompt },
          {
            role: "user",
            content: buildUserPrompt(
              discussion.topic,
              transcript,
              inlineAttachmentText
            ),
          },
        ];

        const roundAttachments = round === 1 ? allAttachments : [];

        try {
          emit({
            type: "diagnostic",
            phase: "model_streaming",
            round,
            modelId: model.modelId,
            modelName: model.displayName,
            providerId,
            message: `${model.displayName} is generating a response`,
          });

          const content = await collectStream(
            model.modelId,
            providerId,
            modelName,
            messages,
            roundMaxTokens,
            config.temperature,
            reasoningEffort,
            roundAttachments,
            (token) => emit({ type: "message_token", messageId, token }),
            signal
          );
          emitTokenUsage({
            messageId,
            modelId: model.modelId,
            modelName: model.displayName,
            providerId,
            round,
            label: `${model.displayName} round ${round}`,
            messages,
            output: content,
            maxTokens: roundMaxTokens,
          });

          insertMessage({
            id: messageId,
            discussionId,
            round,
            modelId: model.modelId,
            role: "assistant",
            content,
            createdAt: new Date().toISOString(),
          });

          allMessages.push({ id: messageId, round, modelId: model.modelId, content });
          currentRoundTexts.push(content);

          emit({
            type: "diagnostic",
            phase: "model_completed",
            round,
            modelId: model.modelId,
            modelName: model.displayName,
            providerId,
            message: `${model.displayName} finished round ${round}`,
          });

          emit({ type: "message_complete", messageId, content });
        } catch (err) {
          if (isAbortError(err)) throw err;
          emit({
            type: "diagnostic",
            phase: "model_failed",
            round,
            modelId: model.modelId,
            modelName: model.displayName,
            providerId,
            message: `${model.displayName} failed: ${err instanceof Error ? err.message : "Failed"}`,
          });
          emit({
            type: "error",
            message: `${model.displayName}: ${err instanceof Error ? err.message : "Failed"}`,
          });
        }
      }

      if (previousRoundTexts.length > 0 && currentRoundTexts.length > 0) {
        const prevCombined = previousRoundTexts.join(" ");
        const currCombined = currentRoundTexts.join(" ");
        if (wordOverlapSimilarity(prevCombined, currCombined) > 0.92) {
          shouldStopEarly = true;
          emit({
            type: "status",
            status: "stagnation_detected",
            round,
            maxRounds: config.maxRounds,
          });
        }
      }
      previousRoundTexts = currentRoundTexts;

      // A fully-skipped resume round generated nothing new: don't re-vote, but
      // honor a convergence score the previous run had already reached.
      if (currentRoundTexts.length === 0) {
        if (
          discussion.convergenceScore != null &&
          discussion.convergenceScore >= config.convergenceThreshold
        ) {
          shouldStopEarly = true;
        }
        continue;
      }

      if (round >= 2 && !skipConvergenceVote && !shouldStopEarly) {
        const voteTranscript = buildTranscriptFromMessages(allMessages, modelNames);
        const scores: number[] = [];

        emit({
          type: "diagnostic",
          phase: "convergence_voting",
          round,
          message: "Running convergence vote across participating models",
        });

        for (const model of models) {
          const { providerId, model: modelName } = parseModelId(model.modelId);
          try {
            const voteMessages: ChatMessage[] = [
              {
                role: "system",
                content:
                  "You evaluate discussion completeness. Respond only with JSON.",
              },
              {
                role: "user",
                content: buildConvergencePrompt(discussion.topic, voteTranscript),
              },
            ];
            const voteText = await collectStream(
              model.modelId,
              providerId,
              modelName,
              voteMessages,
              200,
              0.2,
              "low",
              [],
              undefined,
              undefined,
              undefined,
              buildConvergenceVoteResponseFormat()
            );
            emitTokenUsage({
              messageId: uuidv4(),
              modelId: model.modelId,
              modelName: model.displayName,
              providerId,
              round,
              label: `${model.displayName} convergence vote`,
              messages: voteMessages,
              output: voteText,
              maxTokens: 200,
            });
            const parsed = parseJsonResponse<{ score: number; reason?: string }>(
              voteText
            );
            if (parsed?.score) {
              scores.push(Math.min(10, Math.max(1, parsed.score)));
            }
          } catch {
            // skip failed vote
          }
        }

        if (scores.length > 0) {
          const avg = scores.reduce((a, b) => a + b, 0) / scores.length;
          updateDiscussion(discussionId, {
            convergenceScore: avg,
            updatedAt: new Date().toISOString(),
          });
          emit({ type: "convergence", score: avg });

          if (avg >= config.convergenceThreshold) {
            shouldStopEarly = true;
          }
        }
      }
    }

    if (signal.aborted) throw abortError();
    emit({ type: "status", status: "judging" });
    emit({
      type: "diagnostic",
      phase: "judging",
      message: "Judge model is synthesizing the final answer",
    });

    const judgeFullId = discussion.judgeModelId ?? modelIds[0];
    const { providerId: judgeProviderId, model: judgeModel } =
      parseModelId(judgeFullId);
    const finalTranscript = buildTranscriptFromMessages(allMessages, modelNames);
    const judgeMessages: ChatMessage[] = [
      {
        role: "system",
        content:
          "You are the final judge. Synthesize the discussion into the single best answer in Markdown.",
      },
      {
        role: "user",
        content: buildJudgePrompt(
          discussion.topic,
          finalTranscript,
          verbosityInstruction,
          mode
        ),
      },
    ];

    const judgeRaw = await collectStream(
      judgeFullId,
      judgeProviderId,
      judgeModel,
      judgeMessages,
      finalMaxTokens,
      0.3,
      reasoningEffort,
      allAttachments,
      undefined,
      signal
    );
    emitTokenUsage({
      messageId: uuidv4(),
      modelId: judgeFullId,
      modelName: modelNames[judgeFullId] ?? judgeFullId,
      providerId: judgeProviderId,
      round: config.maxRounds + 1,
      label: "Judge synthesis",
      messages: judgeMessages,
      output: judgeRaw,
      maxTokens: finalMaxTokens,
    });

    const { answer, confidence, dissent } = extractJudgeResult(judgeRaw);

    insertFinalResult({
      discussionId,
      answer,
      confidence,
      dissent: JSON.stringify(dissent),
      createdAt: new Date().toISOString(),
    });

    updateDiscussion(discussionId, {
      status: "completed",
      updatedAt: new Date().toISOString(),
    });

    emit({ type: "final_answer", answer, confidence, dissent });
    emit({
      type: "diagnostic",
      phase: "finished",
      message: "Discussion completed successfully",
    });
    emit({ type: "complete" });
  } catch (err) {
    if (isAbortError(err)) {
      updateDiscussion(discussionId, {
        status: "stopped",
        updatedAt: new Date().toISOString(),
      });
      emit({ type: "status", status: "stopped" });
      emit({
        type: "diagnostic",
        phase: "finished",
        message: "Stopped by the user — restart it whenever you're ready",
      });
    } else {
      updateDiscussion(discussionId, {
        status: "failed",
        updatedAt: new Date().toISOString(),
      });
      emit({
        type: "error",
        message: err instanceof Error ? err.message : "Discussion failed",
      });
      emit({
        type: "diagnostic",
        phase: "model_failed",
        message:
          err instanceof Error
            ? `Discussion failed: ${err.message}`
            : "Discussion failed",
      });
    }
  } finally {
    runningDiscussions.delete(discussionId);
    abortControllers.delete(discussionId);
  }
}
