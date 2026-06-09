import { v4 as uuidv4 } from "uuid";
import type { DiscussionMode, EffortLevel } from "../db/schema";
import { getDb, getDiscussionById } from "../db";
import {
  getDecryptedApiKey,
  getProvider,
} from "../providers";
import {
  parseModelId,
  type ChatMessage,
  type SelectedModel,
} from "../providers/base";
import { EFFORT_CONFIG } from "./config";
import {
  buildConvergencePrompt,
  buildJudgePrompt,
  buildRoundSystemPrompt,
  buildTranscriptFromMessages,
  buildUserPrompt,
} from "./prompts";
import { loadAttachmentPayloads } from "../attachments/storage";
import type { AttachmentPayload } from "../attachments/types";
import { buildAttachmentPromptSection } from "../attachments/prompt-text";
import { modelSupportsInputTypes } from "../providers/capabilities";

export type OrchestratorEvent =
  | { type: "status"; status: string; round?: number; maxRounds?: number }
  | { type: "message_start"; messageId: string; modelId: string; modelName: string; round: number; role: string }
  | { type: "message_token"; messageId: string; token: string }
  | { type: "message_complete"; messageId: string; content: string }
  | { type: "convergence"; score: number; reason?: string }
  | { type: "final_answer"; answer: string; confidence: number; dissent: string[] }
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
  attachments: AttachmentPayload[],
  onToken?: (token: string) => void
): Promise<string> {
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
    const modelNames = Object.fromEntries(
      models.map((m) => [m.modelId, m.displayName])
    );

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

      const transcript = buildTranscriptFromMessages(allMessages, modelNames);
      const leadIndex = (round - 1) % models.length;
      const currentRoundTexts: string[] = [];

      await Promise.all(
        models.map(async (model, index) => {
          const isSpecialistReviewer =
            mode === "specialist" && index !== leadIndex && round > 1;
          const isSpecialistLead =
            mode === "specialist" && index === leadIndex;

          const systemPrompt = buildRoundSystemPrompt(
            mode,
            round,
            config.maxRounds,
            models,
            mode === "specialist" ? leadIndex : undefined
          );

          if (mode === "specialist" && round === 1 && index !== leadIndex) {
            return;
          }
          if (mode === "specialist" && round > 1 && !isSpecialistLead && !isSpecialistReviewer) {
            return;
          }

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
            const content = await collectStream(
              model.modelId,
              providerId,
              modelName,
              messages,
              config.maxTokens,
              config.temperature,
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

            emit({ type: "message_complete", messageId, content });
          } catch (err) {
            emit({
              type: "error",
              message: `${model.displayName}: ${err instanceof Error ? err.message : "Failed"}`,
            });
          }
        })
      );

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

      if (round >= 2 && !config.skipConvergenceVote && !shouldStopEarly) {
        const voteTranscript = buildTranscriptFromMessages(allMessages, modelNames);
        const scores: number[] = [];

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

    emit({ type: "status", status: "judging" });

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
          content:
            "You are the final judge. Synthesize the discussion into the best answer. Respond only with JSON.",
        },
        {
          role: "user",
          content: buildJudgePrompt(discussion.topic, finalTranscript),
        },
      ],
      config.maxTokens,
      0.3,
      allAttachments
    );

    const parsed = parseJsonResponse<{
      answer: string;
      confidence: number;
      dissent?: string[];
    }>(judgeRaw);

    const answer = parsed?.answer ?? judgeRaw;
    const confidence = parsed?.confidence ?? 7;
    const dissent = parsed?.dissent ?? [];

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
  } finally {
    runningDiscussions.delete(discussionId);
  }
}
