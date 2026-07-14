import type {
  BuildStopReason,
  BuildRunPolicy,
  BuildUsageWindow,
  Discussion,
  DiscussionStatus,
} from "@/lib/db/schema";
import type {
  NativeBuildProjection,
  NativeBuildFileSnapshot,
  NativeBuildTranscriptPage,
  NativeBuildUsageProjection,
  NativeProjectHandoffChoice,
  NativeRunProjection,
} from "@/lib/client/runner-v2";
import { mapNativeBuildUsageModels } from "@/lib/client/native-model-usage";

export function applyDiscussionLiveStatus(
  discussion: Discussion,
  status: DiscussionStatus
): Discussion {
  if (discussion.mode !== "build" || status !== "running") {
    return discussion.status === status ? discussion : { ...discussion, status };
  }
  return {
    ...discussion,
    status,
    buildStopReason: null,
    buildStoppedAt: null,
  };
}

export function buildStopFallbackMessage(reason: BuildStopReason): string {
  if (reason === "blocked") {
    return "Build paused at its durable checkpoint after a recoverable blocker.";
  }
  if (reason === "user") {
    return "Build was interrupted or stopped before it could finish.";
  }
  if (reason === "completed") {
    return "Build completed and is awaiting its final handoff.";
  }
  return `Build stopped because the ${reason} guardrail was reached.`;
}

export function buildRunWorkflowStatus(input: {
  status: string;
  stopReason?: BuildStopReason | null;
  projectHandoffRequested?: boolean;
}): string {
  if (input.projectHandoffRequested) return "Awaiting project handoff";
  if (
    input.status === "completed" ||
    !input.stopReason ||
    input.stopReason === "completed"
  ) {
    return input.status;
  }
  return `${input.status} (${input.stopReason})`;
}

export function shouldShowBuildStopFallback(input: {
  stopReason: BuildStopReason | null | undefined;
  status: string;
  hasStopReport: boolean;
  hasArchitectHandoff: boolean;
  hasProjectHandoff: boolean;
}): boolean {
  return Boolean(
    input.stopReason &&
      input.status === "stopped" &&
      !input.hasStopReport &&
      !input.hasArchitectHandoff &&
      !input.hasProjectHandoff
  );
}

export function shouldRestoreDurableBuildProjection(
  status: string
): boolean {
  return status !== "loading" && status !== "locked";
}

export interface NativeBuildTimelineMessage {
  id: string;
  round: number;
  ordinal: number;
  modelId: string;
  modelName: string;
  content: string;
  streaming?: boolean;
}

export interface NativeBuildTranscriptAttachment {
  runId: string;
  cursor: number;
  messages: NativeBuildTimelineMessage[];
}

export interface NativeBuildAttachmentViewMessage {
  id: string;
  round: number;
  ordinal?: number;
  modelId: string;
  modelName: string;
  content: string;
  streaming?: boolean;
}

export interface NativeBuildAttachmentViewFile {
  path: string;
  content: string;
}

export function selectNativeBuildAttachmentView(input: {
  authoritativeRunId: string | null | undefined;
  legacyMessages: readonly NativeBuildAttachmentViewMessage[];
  legacyFiles: readonly NativeBuildAttachmentViewFile[];
  nativeTranscript: NativeBuildTranscriptAttachment | null;
  nativeFiles: NativeBuildFileAttachment | null;
}): {
  messages: NativeBuildAttachmentViewMessage[];
  files: NativeBuildAttachmentViewFile[];
  nativeTranscript: NativeBuildTranscriptAttachment | null;
  nativeFiles: NativeBuildFileAttachment | null;
  nativeAttached: boolean;
} {
  const nativeTranscript = input.authoritativeRunId &&
    input.nativeTranscript?.runId === input.authoritativeRunId
    ? input.nativeTranscript
    : null;
  const nativeFiles = input.authoritativeRunId &&
    input.nativeFiles?.runId === input.authoritativeRunId
    ? input.nativeFiles
    : null;
  return {
    messages: [...(nativeTranscript?.messages ?? input.legacyMessages)],
    files: [...(nativeFiles?.snapshot.files ?? input.legacyFiles)],
    nativeTranscript,
    nativeFiles,
    nativeAttached: Boolean(nativeTranscript || nativeFiles),
  };
}

export function shouldShowLegacyBuildFileFallback(input: {
  hasNativeFiles: boolean;
  hasFinalResult: boolean;
  legacyFileCount: number;
  streamConnected: boolean;
}): boolean {
  return !input.hasNativeFiles && !input.hasFinalResult && input.legacyFileCount > 0;
}

export function reconcileNativeBuildTranscript(
  current: NativeBuildTranscriptAttachment | null,
  runId: string,
  page: NativeBuildTranscriptPage,
  projection: Pick<NativeBuildProjection, "runtime">,
  usage: Pick<NativeBuildUsageProjection, "models">
): NativeBuildTranscriptAttachment {
  const retained = current?.runId === runId ? current.messages : [];
  const byId = new Map(retained.map((message) => [message.id, message]));
  for (const turn of page.turns) {
    if (
      !["architect", "worker", "subagent"].includes(turn.actor.role) ||
      !turn.text.trim()
    ) continue;
    const runtimeId = nativeActorRuntimeId(turn.actor, projection);
    const runtime = usage.models?.find((model) => model.runtimeId === runtimeId);
    const actorName = turn.actor.role === "architect"
      ? "Architect"
      : `${capitalize(turn.actor.role)} ${turn.actor.id}`;
    byId.set(turn.id, {
      id: turn.id,
      round: turn.sequence,
      ordinal: turn.ordinal,
      modelId: runtimeId ?? `native:${turn.actor.role}:${turn.actor.id}`,
      modelName: runtimeId
        ? `${actorName} · ${runtime?.displayName ?? runtime?.modelId ?? runtimeId}`
        : actorName,
      content: turn.text,
    });
  }
  return {
    runId,
    cursor: Math.max(current?.runId === runId ? current.cursor : 0, page.cursor),
    messages: [...byId.values()].sort(compareNativeBuildTimelineMessages),
  };
}

function compareNativeBuildTimelineMessages(
  left: NativeBuildTimelineMessage,
  right: NativeBuildTimelineMessage
): number {
  return left.round - right.round ||
    left.ordinal - right.ordinal ||
    compareCodeUnits(left.id, right.id);
}

function compareCodeUnits(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function nativeActorRuntimeId(
  actor: { role: "architect" | "worker" | "subagent"; id: string },
  projection: Pick<NativeBuildProjection, "runtime">
): string | undefined {
  if (actor.role === "architect") return projection.runtime.architect.runtimeId;
  const assignments = projection.runtime.workerAssignments;
  const workerId = Object.keys(assignments)
    .filter((candidate) => actor.id === candidate || actor.id.startsWith(`${candidate}:`))
    .sort((left, right) => right.length - left.length)[0];
  if (workerId) return assignments[workerId]?.runtimeId;
  return actor.role === "subagent"
    ? projection.runtime.architect.runtimeId
    : undefined;
}

function capitalize(value: string): string {
  return value.length === 0 ? value : `${value[0].toUpperCase()}${value.slice(1)}`;
}

export interface NativeBuildPollState {
  observedActive: boolean;
  terminalRefreshScheduled: boolean;
}

export function createNativeBuildAttachmentRefresh<TSnapshot extends object>(options: {
  savedRunId: string;
  resolveRunId: (savedRunId: string) => Promise<string>;
  load: (runId: string) => Promise<TSnapshot>;
}): () => Promise<TSnapshot & { runId: string }> {
  let savedRunId = options.savedRunId;
  return async () => {
    const runId = await options.resolveRunId(savedRunId);
    const snapshot = await options.load(runId);
    savedRunId = runId;
    return { ...snapshot, runId };
  };
}

export interface NativeBuildFileAttachment {
  runId: string;
  key: string;
  snapshot: NativeBuildFileSnapshot;
}

export function reconcileNativeBuildFiles(
  current: NativeBuildFileAttachment | null,
  runId: string,
  snapshot: NativeBuildFileSnapshot
): NativeBuildFileAttachment {
  const key = `${runId}:${snapshot.source}:${snapshot.revision}`;
  return current?.key === key
    ? current
    : { runId, key, snapshot };
}

export function nextNativeBuildPoll(
  state: NativeBuildPollState,
  runState: NativeRunProjection["state"]
): { state: NativeBuildPollState; action: "poll" | "terminal_refresh" | "stop" } {
  if (["created", "running", "paused", "stopping"].includes(runState)) {
    return {
      state: { observedActive: true, terminalRefreshScheduled: false },
      action: "poll",
    };
  }
  if (state.observedActive && !state.terminalRefreshScheduled) {
    return {
      state: { ...state, terminalRefreshScheduled: true },
      action: "terminal_refresh",
    };
  }
  return { state, action: "stop" };
}

export function createNativeBuildAttachmentPoller<
  TSnapshot extends { runState: NativeRunProjection["state"] },
>(options: {
  refresh: () => Promise<TSnapshot>;
  apply: (snapshot: TSnapshot) => void;
  schedule: (callback: () => Promise<void>, delayMs: number) => unknown;
  cancelScheduled: (handle: unknown) => void;
  intervalMs: number;
  onError?: (error: unknown) => void;
}): { start: () => Promise<void>; cancel: () => void } {
  let cancelled = false;
  let scheduled: unknown;
  let pollState: NativeBuildPollState = {
    observedActive: false,
    terminalRefreshScheduled: false,
  };

  const schedule = (delayMs: number) => {
    if (cancelled) return;
    scheduled = options.schedule(run, delayMs);
  };
  const run = async (): Promise<void> => {
    scheduled = undefined;
    try {
      const snapshot = await options.refresh();
      if (cancelled) return;
      options.apply(snapshot);
      const next = nextNativeBuildPoll(pollState, snapshot.runState);
      pollState = next.state;
      if (next.action === "poll") schedule(options.intervalMs);
      if (next.action === "terminal_refresh") schedule(0);
    } catch (error) {
      if (cancelled) return;
      options.onError?.(error);
      schedule(options.intervalMs);
    }
  };

  return {
    start: run,
    cancel: () => {
      cancelled = true;
      if (scheduled !== undefined) options.cancelScheduled(scheduled);
    },
  };
}

export function durableBuildHandoffPanels(
  projection: NativeBuildProjection,
  runState?: NativeRunProjection["state"]
): {
  architect: { reason: string; candidateRuntimeIds: string[] } | null;
  project: {
    summary: string;
    options: NativeProjectHandoffChoice[];
  } | null;
} {
  const projectHandoff = projection.projectHandoff;
  if (projectHandoff?.status === "requested") {
    if (
      runState === "running" &&
      (projection.runPolicy === "finish" || projection.runPolicy === "budgeted")
    ) {
      return { architect: null, project: null };
    }
    return {
      architect: null,
      project: {
        summary: projectHandoff.summary,
        options: [...projectHandoff.options],
      },
    };
  }
  const architectHandoff = projection.runtime.architect.handoff;
  return {
    architect: architectHandoff
      ? {
          reason: architectHandoff.reason,
          candidateRuntimeIds: [...architectHandoff.candidateRuntimeIds],
        }
      : null,
    project: null,
  };
}

export function nativeBuildTaskStatus(
  status: string
): "planned" | "in_progress" | "review" | "fixing" | "done" | "failed" {
  if (status === "planned") return "planned";
  if (["assigned", "running", "waiting_guidance"].includes(status)) {
    return "in_progress";
  }
  if (["submitted", "architect_review", "approved", "integrating"].includes(status)) {
    return "review";
  }
  if (["rejected", "integration_resolution"].includes(status)) return "fixing";
  if (["integrated", "cancelled"].includes(status)) return "done";
  return "failed";
}

export function nativeBuildDiscussionStatus(
  projection: Pick<NativeBuildProjection, "status">
): DiscussionStatus {
  return projection.status === "paused" ? "stopped" : projection.status;
}

export function nativeBuildUsageWindow(
  projection: NativeBuildUsageProjection,
  startedAt: string
): BuildUsageWindow {
  const usage = projection.effective;
  const estimatedUsd = usage.estimatedCostMicros / 1_000_000;
  const models = mapNativeBuildUsageModels(projection);
  return {
    startedAt,
    elapsedMs: usage.activeMs,
    estimatedUsd,
    unknownPricedModelIds: [...new Set(
      models.filter(hasUnpricedContributingNativeUsage).map((model) => model.modelId)
    )].sort(),
    models,
  };
}

export function nativeBuildRunPolicy(
  projection: Pick<NativeBuildProjection, "runPolicy">,
  fallback: BuildRunPolicy
): BuildRunPolicy {
  return projection.runPolicy ?? fallback;
}

export interface NativeBuildPolicyEvent {
  type: "native_build_policy";
  policy: BuildRunPolicy;
}

export function nativeBuildPolicyChange(
  current: BuildRunPolicy,
  projection: Pick<NativeBuildProjection, "runPolicy">
): NativeBuildPolicyEvent | null {
  const policy = nativeBuildRunPolicy(projection, current);
  return policy === current ? null : { type: "native_build_policy", policy };
}

export function createNativeBuildPolicySynchronizer(
  initial: BuildRunPolicy,
  onChange: (event: NativeBuildPolicyEvent) => void
): (projection: Pick<NativeBuildProjection, "runPolicy">) => void {
  let current = initial;
  return (projection) => {
    const change = nativeBuildPolicyChange(current, projection);
    if (!change) return;
    current = change.policy;
    onChange(change);
  };
}

export function applyNativeBuildPolicyEvent(
  discussion: Discussion,
  event: NativeBuildPolicyEvent
): Discussion {
  return discussion.buildRunPolicy === event.policy
    ? discussion
    : { ...discussion, buildRunPolicy: event.policy };
}

export function nativeBuildRestorationPolicyPatch(
  discussion: Pick<Discussion, "buildRunPolicy">,
  projection: Pick<NativeBuildProjection, "runPolicy">
): Pick<Discussion, "buildRunPolicy"> | Record<string, never> {
  const policy = nativeBuildRunPolicy(
    projection,
    discussion.buildRunPolicy ?? "finish"
  );
  return discussion.buildRunPolicy === policy ? {} : { buildRunPolicy: policy };
}

function hasUnpricedContributingNativeUsage(
  model: BuildUsageWindow["models"][number]
): boolean {
  if (
    model.usageOrigin !== "native" ||
    model.priced ||
    model.costBasis === "account_not_metered"
  ) return false;
  return (
    model.calls > 0 ||
    model.inputTokens > 0 ||
    (model.cachedInputTokens ?? 0) > 0 ||
    (model.cacheWriteInputTokens ?? 0) > 0 ||
    model.outputTokens > 0 ||
    model.totalTokens > 0
  );
}
