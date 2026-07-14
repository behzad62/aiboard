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
  BuildRunPolicy,
  BuildSkillMode,
  ReasoningEffort,
  UserSettings,
  Verbosity,
} from "@/lib/db/schema";
import type { AttachmentSummary } from "@/lib/attachments/types";
import type { ModelInfo } from "@/lib/providers/base";
import {
  clearDiscussionRun,
  clearFinalResult,
  deleteDiscussion as storeDeleteDiscussion,
  getAttachments,
  getDiscussionById,
  getFinalResult,
  getBuildCheckpoint,
  getMessagesForDiscussion,
  getProviderKeys,
  insertMessage,
  getUserSettings,
  initStore,
  insertDiscussion,
  isInitialized,
  listDiscussions,
  updateDiscussion,
  updateUserSettings,
  upsertBuildCheckpoint,
} from "./store";
import {
  getEnabledModels,
  resolveModelName,
} from "./providers";
import {
  isDiscussionRunning,
  runDiscussion as runClientDiscussion,
  stopDiscussion,
} from "./engine";
import { queueBuildNote } from "./build-notes";
import { normalizeBuildTasksForResume } from "@/lib/orchestrator/build";
import { normalizeBuildSettings } from "@/lib/orchestrator/build-policy";

export { runClientDiscussion as runDiscussion, stopDiscussion };
export type { OrchestratorEvent } from "./engine";

function parseDiscussionAttachmentIds(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((id): id is string => typeof id === "string" && id.length > 0)
      : [];
  } catch {
    return [];
  }
}

function summarizeAttachment(record: ReturnType<typeof getAttachments>[number]): AttachmentSummary {
  return {
    id: record.id,
    filename: record.filename,
    mimeType: record.mimeType,
    category: record.category,
    size: record.size,
  };
}

/**
 * Reset a stopped/failed discussion so it can run again from the start:
 * wipes the previous run's messages and final result and re-queues it.
 */
export function restartDiscussion(id: string): Discussion | undefined {
  if (isDiscussionRunning(id)) {
    throw new Error("Stop the run before restarting it.");
  }
  clearDiscussionRun(id);
  const now = new Date().toISOString();
  updateDiscussion(id, {
    status: "pending",
    currentRound: 0,
    convergenceScore: null,
    buildStopReason: null,
    buildStoppedAt: null,
    nativeBuildRunId: `native-${uuidv4()}`,
    nativeBuildRequestedAt: now,
    updatedAt: now,
  });
  return getDiscussionById(id);
}

/**
 * Queue a user note for the build's Architect (picked up at its next plan,
 * review, or summary turn) and record it as a timeline message.
 */
export function addBuildNote(
  discussionId: string,
  note: string
): { id: string; round: number } {
  const trimmed = note.trim();
  if (!trimmed) throw new Error("The note is empty.");
  queueBuildNote(discussionId, trimmed);
  // Place the note after the latest message so the timeline reads in order.
  const round = getMessagesForDiscussion(discussionId).reduce(
    (max, m) => Math.max(max, m.round),
    0
  );
  const message = {
    id: uuidv4(),
    discussionId,
    round,
    modelId: "user",
    role: "user",
    content: trimmed,
    createdAt: new Date().toISOString(),
  };
  insertMessage(message);
  return { id: message.id, round };
}

/**
 * Add newly uploaded files to an existing discussion so a resumed build or
 * continued panel run can include them in subsequent provider calls.
 */
export function addDiscussionAttachments(
  discussionId: string,
  attachmentIds: string[]
): AttachmentSummary[] {
  const discussion = getDiscussionById(discussionId);
  if (!discussion) throw new Error("Discussion not found.");

  const existingIds = parseDiscussionAttachmentIds(discussion.attachmentIds);
  const uniqueIds = Array.from(
    new Set(attachmentIds.map((id) => id.trim()).filter(Boolean))
  );
  const candidateIds = uniqueIds.filter((id) => !existingIds.includes(id));
  if (candidateIds.length === 0) return [];

  const records = getAttachments(candidateIds);
  if (records.length !== candidateIds.length) {
    const found = new Set(records.map((record) => record.id));
    const missing = candidateIds.filter((id) => !found.has(id));
    throw new Error(`Attachment not found: ${missing.join(", ")}`);
  }

  updateDiscussion(discussionId, {
    attachmentIds: JSON.stringify([...existingIds, ...candidateIds]),
    updatedAt: new Date().toISOString(),
  });

  return records.map(summarizeAttachment);
}

/**
 * Re-queue a finished/stopped/failed build for a follow-up pass — the prior
 * transcript and final result stay; the Architect re-plans over the existing
 * files (and any queued user notes) and writes a fresh summary.
 */
export function continueDiscussion(
  id: string,
  forceNewBuildPass = false
): Discussion | undefined {
  if (isDiscussionRunning(id)) return getDiscussionById(id);
  const now = new Date().toISOString();
  const discussion = getDiscussionById(id);
  if (discussion?.mode === "build") {
    clearFinalResult(id);
  }
  const checkpoint = getBuildCheckpoint(id);
  if (checkpoint?.tasks.length) {
    const stoppedWithRunningCheckpoint =
      discussion?.mode === "build" &&
      discussion.status === "stopped" &&
      checkpoint.status === "running";
    upsertBuildCheckpoint({
      ...checkpoint,
      tasks: normalizeBuildTasksForResume(checkpoint.tasks),
      status: stoppedWithRunningCheckpoint ? "stopped" : checkpoint.status,
      stopReason: stoppedWithRunningCheckpoint
        ? discussion.buildStopReason ?? "user"
        : checkpoint.stopReason,
      updatedAt: now,
    });
  }
  const startsNewNativePass = discussion?.mode === "build" &&
    (forceNewBuildPass || discussion.status !== "stopped");
  updateDiscussion(id, {
    status: "pending",
    buildStopReason: null,
    buildStoppedAt: null,
    ...(startsNewNativePass
      ? {
          nativeBuildRunId: `native-${uuidv4()}`,
          nativeBuildRequestedAt: now,
        }
      : {}),
    updatedAt: now,
  });
  return getDiscussionById(id);
}

/**
 * Native Build execution is runner-owned. A stale browser-side "running"
 * marker is still interrupted so the UI requires an explicit reconnect and
 * Resume; Runner V2 keeps the authoritative checkpoint.
 */
export function interruptOrphanedRunningBuild(id: string): boolean {
  if (isDiscussionRunning(id)) return false;

  const discussion = getDiscussionById(id);
  if (discussion?.mode !== "build" || discussion.status !== "running") {
    return false;
  }
  // Runner V2 owns the durable process and survives browser reloads. A reload
  // is not an interruption and must never rewrite its authoritative state.
  if (discussion.runnerUrl && discussion.runnerToken) return false;

  const checkpoint = getBuildCheckpoint(id);
  const now = new Date().toISOString();
  if (checkpoint?.status === "running") {
    upsertBuildCheckpoint({
      ...checkpoint,
      status: "stopped",
      stopReason: "user",
      updatedAt: now,
      recoveryLog: [
        ...(checkpoint.recoveryLog ?? []),
        "Build was interrupted by a browser refresh or tab reload; Resume starts from the last durable checkpoint.",
      ],
    });
  }
  updateDiscussion(id, {
    status: "stopped",
    buildStopReason: "user",
    buildStoppedAt: now,
    updatedAt: now,
  });
  return true;
}

/**
 * Attach, replace, or clear the local runner for an existing discussion so a
 * later Resume continues with disk access. Pass null to disconnect. Runner
 * config is otherwise frozen at creation; this lets the user wire one up after
 * the fact.
 */
export function setDiscussionRunner(
  id: string,
  sel: { url: string; token: string; access: "ask" | "project" | "full" } | null
): void {
  updateDiscussion(
    id,
    sel
      ? {
          runnerUrl: sel.url,
          runnerToken: sel.token,
          runnerAccess: sel.access,
          updatedAt: new Date().toISOString(),
        }
      : {
          runnerUrl: null,
          runnerToken: null,
          runnerAccess: null,
          updatedAt: new Date().toISOString(),
        }
  );
}

export interface DiscussionConfigInput {
  effort: EffortLevel;
  modelIds: string[];
  judgeModelId?: string | null;
  verbosity?: Verbosity;
  reasoningEffort?: ReasoningEffort;
  styleNote?: string | null;
  buildRunPolicy?: BuildRunPolicy;
  buildSkillMode?: BuildSkillMode;
  buildBudgetUsd?: number;
  buildTimeLimitMinutes?: number;
}

export function minimumParticipatingModelsForMode(mode: DiscussionMode): number {
  return mode === "build" ? 1 : 2;
}

export function hasEnoughParticipatingModels(
  mode: DiscussionMode,
  modelCount: number
): boolean {
  return modelCount >= minimumParticipatingModelsForMode(mode);
}

export function participatingModelRequirementMessage(
  mode: DiscussionMode
): string {
  const min = minimumParticipatingModelsForMode(mode);
  const label = min === 1 ? "one" : min === 2 ? "two" : String(min);
  return `Select at least ${label} participating model${min === 1 ? "" : "s"}.`;
}

/**
 * Update the configuration used by the next Resume/follow-up pass. This keeps
 * the transcript and produced files intact; it only changes future model calls.
 */
export function updateDiscussionConfig(
  id: string,
  input: DiscussionConfigInput
): Discussion {
  if (isDiscussionRunning(id)) {
    throw new Error("Stop the discussion before editing its session settings.");
  }
  const discussion = getDiscussionById(id);
  if (!discussion) {
    throw new Error("Discussion not found.");
  }
  const modelIds = Array.from(
    new Set(input.modelIds.map((m) => m.trim()).filter(Boolean))
  );
  if (!hasEnoughParticipatingModels(discussion.mode, modelIds.length)) {
    throw new Error(participatingModelRequirementMessage(discussion.mode));
  }
  const judgeModelId =
    input.judgeModelId && input.judgeModelId.trim()
      ? input.judgeModelId.trim()
      : modelIds[0];
  const patch: Partial<Discussion> = {
    effort: input.effort,
    modelIds: JSON.stringify(modelIds),
    judgeModelId,
    verbosity: input.verbosity ?? discussion.verbosity ?? "balanced",
    reasoningEffort:
      input.reasoningEffort ?? discussion.reasoningEffort ?? "default",
    styleNote: input.styleNote ?? "",
    updatedAt: new Date().toISOString(),
  };
  if (discussion.mode === "build") {
    const buildSettings = normalizeBuildSettings({
      buildRunPolicy: input.buildRunPolicy ?? discussion.buildRunPolicy,
      buildSkillMode: input.buildSkillMode ?? discussion.buildSkillMode,
      buildBudgetUsd: input.buildBudgetUsd ?? discussion.buildBudgetUsd,
      buildTimeLimitMinutes:
        input.buildTimeLimitMinutes ?? discussion.buildTimeLimitMinutes,
    });
    patch.buildRunPolicy = buildSettings.runPolicy;
    patch.buildSkillMode = buildSettings.skillMode;
    patch.buildBudgetUsd = buildSettings.budgetUsd;
    patch.buildTimeLimitMinutes = buildSettings.timeLimitMinutes;
  }
  updateDiscussion(id, patch);
  return { ...discussion, ...patch };
}

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
  reviewerModelId?: string | null;
  verbosity?: Verbosity;
  reasoningEffort?: ReasoningEffort;
  styleNote?: string;
  attachmentIds?: string[];
  projectFolderName?: string | null;
  runnerUrl?: string | null;
  runnerToken?: string | null;
  runnerAccess?: "ask" | "project" | "full" | null;
  buildRunPolicy?: BuildRunPolicy;
  buildSkillMode?: BuildSkillMode;
  buildBudgetUsd?: number;
  buildTimeLimitMinutes?: number;
}

export function createDiscussion(input: CreateDiscussionInput): { id: string } {
  if (input.topic.trim().length < 10) {
    throw new Error("Give the discussion a clearer topic (at least 10 characters).");
  }
  if (!hasEnoughParticipatingModels(input.mode, input.modelIds.length)) {
    throw new Error(participatingModelRequirementMessage(input.mode));
  }
  const settings = getUserSettings();
  const buildSettings = normalizeBuildSettings({
    buildRunPolicy: input.buildRunPolicy ?? settings.defaultBuildRunPolicy,
    buildSkillMode: input.buildSkillMode ?? settings.defaultBuildSkillMode,
    buildBudgetUsd: input.buildBudgetUsd ?? settings.defaultBuildBudgetUsd,
    buildTimeLimitMinutes:
      input.buildTimeLimitMinutes ?? settings.defaultBuildTimeLimitMinutes,
  });
  const now = new Date().toISOString();
  const id = uuidv4();
  insertDiscussion({
    id,
    topic: input.topic.trim(),
    mode: input.mode,
    effort: input.effort,
    modelIds: JSON.stringify(input.modelIds),
    judgeModelId: input.judgeModelId ?? settings.judgeModelId ?? input.modelIds[0],
    reviewerModelId: input.reviewerModelId ?? null,
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
    nativeBuildRunId: input.mode === "build" ? `native-${uuidv4()}` : null,
    nativeBuildRequestedAt: input.mode === "build" ? now : null,
    buildRunPolicy: input.mode === "build" ? buildSettings.runPolicy : undefined,
    buildSkillMode: input.mode === "build" ? buildSettings.skillMode : undefined,
    buildBudgetUsd: input.mode === "build" ? buildSettings.budgetUsd : undefined,
    buildTimeLimitMinutes:
      input.mode === "build" ? buildSettings.timeLimitMinutes : undefined,
    buildStopReason: null,
    buildStoppedAt: null,
    createdAt: now,
    updatedAt: now,
  });
  return { id };
}

export function getDiscussionData(id: string) {
  const discussion = getDiscussionById(id);
  if (!discussion) return null;
  const modelIds: string[] = JSON.parse(discussion.modelIds);
  const attachmentIds = parseDiscussionAttachmentIds(discussion.attachmentIds);
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
    attachments: getAttachments(attachmentIds).map(summarizeAttachment),
  };
}

export function deleteDiscussion(id: string): void {
  storeDeleteDiscussion(id);
}

export function saveSettings(patch: Partial<UserSettings>): void {
  updateUserSettings(patch);
}
