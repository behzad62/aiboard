/**
 * Client backend — the functions the React pages call instead of hitting the
 * server API routes. Everything runs against the in-browser client store and
 * the in-browser engine. This is the seam the page cutover plugs into.
 */

import { v4 as uuidv4 } from "uuid";
import type {
  Discussion,
  DiscussionMode,
  EffortLevel,
  ReasoningEffort,
  UserSettings,
  Verbosity,
} from "@/lib/db/schema";
import type { ModelInfo } from "@/lib/providers/base";
import {
  deleteDiscussion as storeDeleteDiscussion,
  getAttachments,
  getDiscussionById,
  getFinalResult,
  getMessagesForDiscussion,
  getProviderKeys,
  getUserSettings,
  initStore,
  insertDiscussion,
  isInitialized,
  listDiscussions,
  updateUserSettings,
} from "./store";
import {
  getEnabledModels,
  resolveModelName,
} from "./providers";
import { runDiscussion as runClientDiscussion } from "./engine";

export { runClientDiscussion as runDiscussion };
export type { OrchestratorEvent } from "./engine";

/** Load the client store (idempotent). Returns needsPassphrase when locked. */
export async function ensureReady(): Promise<{ needsPassphrase: boolean }> {
  if (isInitialized()) return { needsPassphrase: false };
  return initStore();
}

function withFullId(models: ModelInfo[]): Array<ModelInfo & { fullId: string }> {
  return models.map((m) => ({ ...m, fullId: `${m.providerId}:${m.id}` }));
}

export interface DashboardData {
  discussions: Discussion[];
  settings: UserSettings;
  defaultSelectedModelIds: string[];
  enabledModels: Array<ModelInfo & { fullId: string }>;
}

export function loadDashboard(): DashboardData {
  const settings = getUserSettings();
  const enabled = withFullId(getEnabledModels());
  const enabledIds = new Set(enabled.map((m) => m.fullId));

  // One default model per enabled provider — its chosen "default model", or the
  // first enabled model for that provider. Mirrors the old server behaviour.
  const defaultSelectedModelIds = getProviderKeys()
    .filter((key) => key.enabled)
    .map((key) => {
      const preferred = key.defaultModel
        ? `${key.providerId}:${key.defaultModel}`
        : null;
      if (preferred && enabledIds.has(preferred)) return preferred;
      const fallback = enabled.find((m) => m.providerId === key.providerId);
      return fallback?.fullId ?? null;
    })
    .filter((id): id is string => Boolean(id));

  return {
    discussions: listDiscussions(),
    settings,
    defaultSelectedModelIds,
    enabledModels: enabled,
  };
}

export interface CreateDiscussionInput {
  topic: string;
  mode: DiscussionMode;
  effort: EffortLevel;
  modelIds: string[];
  judgeModelId?: string | null;
  verbosity?: Verbosity;
  reasoningEffort?: ReasoningEffort;
  styleNote?: string;
  attachmentIds?: string[];
  projectFolderName?: string | null;
  runnerUrl?: string | null;
  runnerToken?: string | null;
  runnerAccess?: "ask" | "full" | null;
}

export function createDiscussion(input: CreateDiscussionInput): { id: string } {
  if (input.topic.trim().length < 10) {
    throw new Error("Give the discussion a clearer topic (at least 10 characters).");
  }
  if (input.modelIds.length < 2) {
    throw new Error("Select at least two models.");
  }
  const settings = getUserSettings();
  const now = new Date().toISOString();
  const id = uuidv4();
  insertDiscussion({
    id,
    topic: input.topic.trim(),
    mode: input.mode,
    effort: input.effort,
    modelIds: JSON.stringify(input.modelIds),
    judgeModelId: input.judgeModelId ?? settings.judgeModelId ?? input.modelIds[0],
    status: "pending",
    currentRound: 0,
    maxRounds: 0,
    convergenceScore: null,
    verbosity: input.verbosity ?? settings.defaultVerbosity ?? "balanced",
    styleNote: input.styleNote ?? settings.defaultStyleNote ?? "",
    reasoningEffort:
      input.reasoningEffort ?? settings.defaultReasoningEffort ?? "default",
    attachmentIds: input.attachmentIds?.length
      ? JSON.stringify(input.attachmentIds)
      : null,
    projectFolderName: input.projectFolderName ?? null,
    runnerUrl: input.runnerUrl ?? null,
    runnerToken: input.runnerToken ?? null,
    runnerAccess: input.runnerAccess ?? null,
    createdAt: now,
    updatedAt: now,
  });
  return { id };
}

export function getDiscussionData(id: string) {
  const discussion = getDiscussionById(id);
  if (!discussion) return null;
  const modelIds: string[] = JSON.parse(discussion.modelIds);
  const attachmentIds: string[] = discussion.attachmentIds
    ? JSON.parse(discussion.attachmentIds)
    : [];
  const rawFinal = getFinalResult(id);
  let finalResult: { answer: string; confidence: number; dissent: string[] } | null =
    null;
  if (rawFinal) {
    let dissent: string[] = [];
    try {
      dissent = JSON.parse(rawFinal.dissent ?? "[]") as string[];
    } catch {
      dissent = [];
    }
    finalResult = {
      answer: rawFinal.answer,
      confidence: rawFinal.confidence,
      dissent,
    };
  }

  return {
    discussion,
    messages: getMessagesForDiscussion(id),
    finalResult,
    modelNames: Object.fromEntries(
      modelIds.map((fullId) => [fullId, resolveModelName(fullId)])
    ),
    attachments: getAttachments(attachmentIds).map((a) => ({
      id: a.id,
      filename: a.filename,
      mimeType: a.mimeType,
      category: a.category,
      size: a.size,
    })),
  };
}

export function deleteDiscussion(id: string): void {
  storeDeleteDiscussion(id);
}

export function saveSettings(patch: Partial<UserSettings>): void {
  updateUserSettings(patch);
}
