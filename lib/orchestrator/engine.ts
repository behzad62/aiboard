import { v4 as uuidv4 } from "uuid";
import type {
  DiscussionMode,
  EffortLevel,
  ReasoningEffort,
  Verbosity,
} from "../db/schema";
import { getDb, getDiscussionById } from "../db";
import {
  getDecryptedApiKey,
  getProvider,
} from "../providers";
import {
  CUSTOM_PROVIDER_ID,
  getCustomModelByFullId,
  streamCustomChat,
} from "../providers/custom";
import {
  parseModelId,
  type ChatMessage,
  type SelectedModel,
} from "../providers/base";
import {
  BUILD_INTEGRATOR_MIN_TOKENS,
  BUILD_ROUND_MIN_TOKENS,
  EFFORT_CONFIG,
} from "./config";
import { extractJudgeResult } from "./parse";
import {
  buildConvergencePrompt,
  buildIntegratorPrompt,
  buildJudgePrompt,
  buildRoundSystemPrompt,
  buildTranscriptFromMessages,
  buildUserPrompt,
  buildVerbosityInstruction,
} from "./prompts";
import { loadAttachmentPayloads } from "../attachments/storage";
import type { AttachmentPayload } from "../attachments/types";
import { buildAttachmentPromptSection } from "../attachments/prompt-text";
import { modelSupportsInputTypes } from "../providers/capabilities";

export type OrchestratorEvent =
  | { type: "status"; status: string; round?: number; maxRounds?: number }
  | {
      type: "diagnostic";
      phase:
        | "initializing"
        | "round_preparing"
        | "model_connecting"
        | "model_streaming"
        | "model_completed"
        | "model_failed"
        | "convergence_voting"
        | "judging"
        | "finished";
      message: string;
      modelId?: string;
      modelName?: string;
      providerId?: string;
      round?: number;
    }
  | { type: "message_start"; messageId: string; modelId: string; modelName: string; round: number; role: string }
  | { type: "message_token"; messageId: string; token: string }
  | { type: "message_complete"; messageId: string; content: string }
  | { type: "convergence"; score: number; reason?: string }
  | { type: "final_answer"; answer: string; confidence: number; dissent: string[] }
  // Build mode (architect-orchestrated): task board + file writes.
  | {
      type: "build_plan";
      tasks: Array<{ id: string; title: string; status: string }>;
      cycle: number;
    }
  | {
      type: "task_status";
      taskId: string;
      title: string;
      status: "planned" | "in_progress" | "review" | "fixing" | "done" | "failed";
      worker?: string;
      cycle?: number;
    }
  | {
      type: "file_written";
      path: string;
      bytes: number;
      location: "disk" | "virtual";
      taskId?: string;
    }
  | { type: "error"; message: string }
  | { type: "complete" };

type EventCallback = (event: OrchestratorEvent) => void;

const runningDiscussions = new Set<string>();

export function isDiscussionRunning(id: string): boolean {
  return runningDiscussions.has(id);
}

async function collectStream(
  modelId: string,
  providerId: string,
  model: string,
  messages: ChatMessage[],
  maxTokens: number,
  temperature: number,
  reasoningEffort: ReasoningEffort,
  attachments: AttachmentPayload[],
  onToken?: (token: string) => void
): Promise<string> {
  // Custom OpenAI-compatible endpoints stream via their own client (custom
  // baseURL + optional key). Forward only the media types the user declared the
  // model supports (text_inline already lives in the prompt).
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
    for await (const chunk of streamCustomChat(customModel, {
      apiKey: "",
      model: customModel.model,
      messages,
      attachments: customAttachments,
      maxTokens,
      temperature,
      reasoningEffort,
    })) {
      if (chunk.type === "token" && chunk.content) {
        customContent += chunk.content;
        onToken?.(chunk.content);
      }
      if (chunk.type === "error") {
        throw new Error(chunk.error ?? "Stream error");
      }
    }
    return customContent;
  }

  const provider = getProvider(providerId);
  const apiKey = getDecryptedApiKey(providerId);
  if (!provider || !apiKey) {
    throw new Error(`Provider ${providerId} is not configured`);
  }

  const modelAttachments = attachments.filter((a) => {
    if (a.category === "text_inline") return true;
    return modelSupportsInputTypes(modelId, [a.category]);
  });

  let content = "";
  for await (const chunk of provider.streamChat({
    apiKey,
    model,
    messages,
    attachments: modelAttachments,
    maxTokens,
    temperature,
    reasoningEffort,
  })) {
    if (chunk.type === "token" && chunk.content) {
      content += chunk.content;
      onToken?.(chunk.content);
    }
    if (chunk.type === "error") {
      throw new Error(chunk.error ?? "Stream error");
    }
  }
  return content;
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
  emit: EventCallback
): Promise<void> {
  if (runningDiscussions.has(discussionId)) {
    return;
  }

  runningDiscussions.add(discussionId);
  const db = getDb();

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
    const config = EFFORT_CONFIG[effort];
    const verbosity = (discussion.verbosity ?? "balanced") as Verbosity;
    const verbosityInstruction = buildVerbosityInstruction(
      verbosity,
      discussion.styleNote
    );
    const reasoningEffort = (discussion.reasoningEffort ??
      "default") as ReasoningEffort;
    // Generous ceilings only; conciseness is handled in the prompt. Build mode
    // emits multi-file code, so it gets extra headroom.
    const roundMaxTokens =
      mode === "build"
        ? Math.max(config.maxTokens, BUILD_ROUND_MIN_TOKENS)
        : config.maxTokens;
    const finalMaxTokens =
      mode === "build"
        ? Math.max(config.judgeMaxTokens, BUILD_INTEGRATOR_MIN_TOKENS)
        : config.judgeMaxTokens;
    const skipConvergenceVote = config.skipConvergenceVote || mode === "build";
    const modelNames = Object.fromEntries(
      models.map((m) => [m.modelId, m.displayName])
    );

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

    db.updateDiscussion(discussionId, {
      status: "running",
      maxRounds: config.maxRounds,
      updatedAt: new Date().toISOString(),
    });

    emit({
      type: "status",
      status: "running",
      round: 0,
      maxRounds: config.maxRounds,
    });

    const allMessages: Array<{
      id: string;
      round: number;
      modelId: string;
      content: string;
    }> = [];

    let previousRoundTexts: string[] = [];
    let shouldStopEarly = false;

    for (let round = 1; round <= config.maxRounds; round++) {
      if (shouldStopEarly) break;

      emit({
        type: "diagnostic",
        phase: "round_preparing",
        round,
        message: `Preparing round ${round} of ${config.maxRounds}`,
      });

      db.updateDiscussion(discussionId, {
        currentRound: round,
        updatedAt: new Date().toISOString(),
      });

      emit({
        type: "status",
        status: "running",
        round,
        maxRounds: config.maxRounds,
      });

      const leadIndex = (round - 1) % models.length;
      const currentRoundTexts: string[] = [];

      // Sequential within the round: each model sees what earlier speakers said
      // THIS round (the transcript is rebuilt before each turn), so the
      // discussion actually builds on itself instead of every model answering
      // the same frozen transcript in parallel.
      for (let index = 0; index < models.length; index++) {
        const model = models[index];

        // Specialist round 1: only the lead drafts. Afterwards the lead revises
        // and everyone else reviews, so all models participate.
        if (mode === "specialist" && round === 1 && index !== leadIndex) {
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
            (token) => emit({ type: "message_token", messageId, token })
          );

          db.insertMessage({
            id: messageId,
            discussionId,
            round,
            modelId: model.modelId,
            role: "assistant",
            content,
            createdAt: new Date().toISOString(),
          });

          allMessages.push({
            id: messageId,
            round,
            modelId: model.modelId,
            content,
          });
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
            const voteText = await collectStream(
              model.modelId,
              providerId,
              modelName,
              [
                {
                  role: "system",
                  content:
                    "You evaluate discussion completeness. Respond only with JSON.",
                },
                {
                  role: "user",
                  content: buildConvergencePrompt(discussion.topic, voteTranscript),
                },
              ],
              200,
              0.2,
              // A short 1-10 rating: keep reasoning low so it isn't consumed by
              // hidden thinking, which would leave no room for the JSON answer.
              "low",
              []
            );
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
          db.updateDiscussion(discussionId, {
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

    const isBuild = mode === "build";
    emit({ type: "status", status: "judging" });
    emit({
      type: "diagnostic",
      phase: "judging",
      message: isBuild
        ? "Integrator is assembling the final project"
        : "Judge model is synthesizing the final answer",
    });

    const judgeFullId = discussion.judgeModelId ?? modelIds[0];
    const { providerId: judgeProviderId, model: judgeModel } =
      parseModelId(judgeFullId);
    const finalTranscript = buildTranscriptFromMessages(allMessages, modelNames);

    const judgeRaw = await collectStream(
      judgeFullId,
      judgeProviderId,
      judgeModel,
      [
        {
          role: "system",
          content: isBuild
            ? "You are the integrator. Assemble the final, coherent project from the discussion. Output complete files plus build notes."
            : "You are the final judge. Synthesize the discussion into the single best answer in Markdown.",
        },
        {
          role: "user",
          content: isBuild
            ? buildIntegratorPrompt(
                discussion.topic,
                finalTranscript,
                verbosityInstruction
              )
            : buildJudgePrompt(
                discussion.topic,
                finalTranscript,
                verbosityInstruction
              ),
        },
      ],
      finalMaxTokens,
      0.3,
      reasoningEffort,
      allAttachments
    );

    const { answer, confidence, dissent } = extractJudgeResult(judgeRaw);

    db.insertFinalResult({
      discussionId,
      answer,
      confidence,
      dissent: JSON.stringify(dissent),
      createdAt: new Date().toISOString(),
    });

    db.updateDiscussion(discussionId, {
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
    db.updateDiscussion(discussionId, {
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
  } finally {
    runningDiscussions.delete(discussionId);
  }
}
