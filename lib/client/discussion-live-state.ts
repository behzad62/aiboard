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
import type { ModelPricing } from "@/lib/providers/pricing";

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

export interface NativeBuildPauseDescription {
  /** True when the run cannot continue until the owner acts (not just presses Resume). */
  waitingForOwner: boolean;
  title: string;
  detail: string;
}

/** Plain-language explanation of why a native Build is paused, or null when it is not paused. */
export function nativeBuildPauseDescription(
  projection: (Pick<NativeBuildProjection, "status" | "pauseReason"> &
    Partial<Pick<NativeBuildProjection, "verifierSelection" | "runtime" | "projectHandoff">>) | null | undefined
): NativeBuildPauseDescription | null {
  if (!projection || projection.status !== "paused") return null;
  // Typed owner gates can hold a paused run without a pause reason; they take precedence.
  if (projection.verifierSelection?.status === "required") {
    return {
      waitingForOwner: true,
      title: "Waiting for you: choose a verifier",
      detail: projection.verifierSelection.reason === "plan_critique_no_independent_runtime"
        ? "The independent plan review did not finish. Pick the model that should review the plan."
        : "Pick an independent verifier below to continue.",
    };
  }
  if (projection.runtime?.architect.handoff) {
    return { waitingForOwner: true, title: "Waiting for you: choose the Architect", detail: "The Architect's model call failed. Pick a runtime below to continue." };
  }
  if (projection.projectHandoff?.status === "requested") {
    return { waitingForOwner: true, title: "Waiting for you: choose the handoff", detail: "The Build finished. Choose how to hand the result to your project." };
  }
  const reason = projection.pauseReason?.reason ?? "";
  if (reason === "plan_start_required") {
    return {
      waitingForOwner: true,
      title: "Waiting for you: approve the plan",
      detail: "The Architect's plan passed its coverage review. Workers start only after you approve it.",
    };
  }
  if (reason === "planning_source_missing") {
    return {
      waitingForOwner: true,
      title: "Waiting for you: approve the specification",
      detail: "This Build plans only from an approved specification. Approve the exact document in Overview to let the Architect plan.",
    };
  }
  if (reason === "verifier.selection_required") {
    return { waitingForOwner: true, title: "Waiting for you: choose a verifier", detail: "Pick an independent verifier below to continue." };
  }
  if (reason === "architect.handoff_required") {
    return { waitingForOwner: true, title: "Waiting for you: choose the Architect", detail: "The Architect's model call failed. Pick a runtime below to continue." };
  }
  if (reason === "project_handoff_required" || reason.startsWith("project_handoff")) {
    return { waitingForOwner: true, title: "Waiting for you: choose the handoff", detail: "The Build finished. Choose how to hand the result to your project." };
  }
  if (reason === "coverage_reviewer_unavailable") {
    return {
      waitingForOwner: false,
      title: "Paused: the plan reviewer could not run",
      detail: "The coverage reviewer failed repeatedly (see Activity). Resume retries the review.",
    };
  }
  if (reason.startsWith("protocol_error")) {
    return {
      waitingForOwner: false,
      title: "Paused: the Architect broke the tool protocol",
      detail: "Nothing was executed. Resume lets the Architect see the error and retry.",
    };
  }
  if (reason === "budget_exhausted" || reason === "time_limit_reached") {
    return {
      waitingForOwner: false,
      title: reason === "budget_exhausted" ? "Paused: budget window used up" : "Paused: time limit reached",
      detail: "Resume starts a fresh budget window from the saved checkpoint.",
    };
  }
  return {
    waitingForOwner: false,
    title: "Paused",
    detail: `${reason ? `Reason: ${reason.replaceAll("_", " ")}. ` : ""}Resume continues from the saved checkpoint (task graph, files, and refs).`,
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
  taskId?: string;
  taskTitle?: string;
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
  taskId?: string;
  taskTitle?: string;
  content: string;
  streaming?: boolean;
}

export interface NativeBuildAttachmentViewFile {
  path: string;
  content: string;
}

export function nativeBuildAttachmentIdentityPatch(
  runId: string,
  updatedAt: string
): {
  nativeBuildRunId: string;
  nativeBuildRequestedAt: null;
  updatedAt: string;
} {
  return {
    nativeBuildRunId: runId,
    nativeBuildRequestedAt: null,
    updatedAt,
  };
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
  projection: Pick<NativeBuildProjection, "runtime"> & Partial<Pick<NativeBuildProjection, "tasks">>,
  usage: Pick<NativeBuildUsageProjection, "models" | "reservations">
): NativeBuildTranscriptAttachment {
  const retained = current?.runId === runId ? current.messages : [];
  const byId = new Map(retained.map((message) => [message.id, message]));
  for (const turn of page.turns) {
    if (
      !["architect", "worker", "subagent", "verifier"].includes(turn.actor.role) ||
      !turn.text.trim()
    ) continue;
    const identity = nativeActorModelIdentity(turn.actor, turn.sessionId, projection, usage, turn.occurredAt);
    const actorName = turn.actor.role === "architect"
      ? "Architect"
      : `${capitalize(turn.actor.role)} ${turn.actor.id}`;
    byId.set(turn.id, {
      id: turn.id,
      round: turn.sequence,
      ordinal: turn.ordinal,
      modelId: identity?.runtimeId ?? `native:${turn.actor.role}:${turn.actor.id}`,
      modelName: identity ? `${actorName} · ${identity.modelName}` : `${actorName} · Model unavailable`,
      ...(identity?.taskId ? { taskId: identity.taskId } : {}),
      ...(identity?.taskTitle ? { taskTitle: identity.taskTitle } : {}),
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

/**
 * Resolve the actual model used by a session. Worker actor IDs are NOT keys
 * in workerAssignments (whose keys are taskId:attempt). Model reservations
 * are session-attributed and remain available after worker failover.
 */
export function nativeActorModelIdentity(
  actor: { role: "architect" | "worker" | "subagent" | "verifier"; id: string },
  sessionId: string,
  projection: (Pick<NativeBuildProjection, "runtime"> &
    Partial<Pick<NativeBuildProjection, "tasks">>) | null | undefined,
  usage: Pick<NativeBuildUsageProjection, "models" | "reservations"> | null | undefined,
  occurredAt?: string
): { runtimeId: string; modelName: string; taskId?: string; taskTitle?: string } | null {
  const calls = Object.values(usage?.reservations ?? {})
    .filter((reservation) => reservation.kind === "model" &&
      reservation.attribution?.sessionId === sessionId &&
      reservation.attribution.role === actor.role)
    .sort((left, right) => {
      const prefix = `model:${sessionId}:`;
      const a = Number(left.reservationId.slice(prefix.length));
      const b = Number(right.reservationId.slice(prefix.length));
      return a - b;
    });
  // Checkpoint timestamps identify the model that finished before this
  // turn. On a fresh/live call (no timestamp), use the newest reservation.
  const completed = occurredAt
    ? calls.filter((call) => call.settledAt && call.settledAt <= occurredAt)
    : calls;
  const attributed = completed.at(-1)?.attribution ??
    (new Set(calls.map((call) => call.attribution?.runtimeId)).size === 1
      ? calls.at(-1)?.attribution
      : undefined);

  const assignments = Object.entries(projection?.runtime.workerAssignments ?? {});
  const assignmentEntry = assignments.find(([, value]) => value.sessionId === sessionId) ??
    assignments.find(([key]) => actor.id === key || actor.id.startsWith(`${key}:`));
  const assignment = assignmentEntry?.[1];
  // Subagents may inherit a worker's runtime without a direct assignment.
  const parentEntry = actor.role === "subagent"
    ? assignments.find(([key]) => actor.id.startsWith(`${key}:`))
    : undefined;
  const parent = parentEntry?.[1];
  const runtimeId = attributed?.runtimeId ??
    (actor.role === "architect" ? projection?.runtime.architect.runtimeId
      : actor.role === "verifier" ? actor.id
      : assignment?.runtimeId ?? parent?.runtimeId ??
        (actor.role === "subagent" ? projection?.runtime.architect.runtimeId : undefined));
  if (!runtimeId) return null;
  const catalog = usage?.models?.find((model) => model.runtimeId === runtimeId);
  // Use the provider and full model identifier, not a possibly-ambiguous
  // display alias. Different providers can expose identical model names.
  const providerId = attributed?.providerId ?? catalog?.providerId;
  const modelId = attributed?.modelId ?? catalog?.modelId;
  const modelName = providerId && modelId
    ? `${providerId} / ${modelId}`
    : catalog?.displayName ?? modelId ?? runtimeId;
  const selectedEntry = assignmentEntry ?? parentEntry;
  const key = selectedEntry?.[0];
  const taskIdFromAssignment = selectedEntry?.[1].taskId ??
    (key && key.lastIndexOf(":") > 0 ? key.slice(0, key.lastIndexOf(":")) : undefined);
  const taskId = actor.role === "worker" || actor.role === "subagent"
    ? attributed?.taskId ?? taskIdFromAssignment
    : undefined;
  const taskTitle = taskId ? projection?.tasks?.[taskId]?.objective : undefined;
  return {
    runtimeId,
    modelName,
    ...(taskId ? { taskId } : {}),
    ...(taskTitle ? { taskTitle } : {}),
  };
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

export interface NativeBuildFileIdentity {
  source: NativeBuildFileSnapshot["source"];
  revision: string;
}

export function nativeBuildFileIdentity(
  projection: Pick<
    NativeBuildProjection,
    "tasks" | "projectHandoff" | "integrationRevision"
  >
): NativeBuildFileIdentity | undefined {
  const handoff = projection.projectHandoff;
  if (handoff?.appliedToProject && handoff.projectRevision) {
    return { source: "project", revision: handoff.projectRevision };
  }
  if (handoff?.integrationRevision) {
    return { source: "integration", revision: handoff.integrationRevision };
  }
  if (projection.integrationRevision) {
    return { source: "integration", revision: projection.integrationRevision };
  }
  const revision = Object.values(projection.tasks)
    .map((task) => task.integrationRevision)
    .filter((candidate): candidate is string => Boolean(candidate))
    .at(-1);
  return revision ? { source: "integration", revision } : undefined;
}

export function createNativeBuildFileLoader(options: {
  load: (
    runId: string,
    identity?: NativeBuildFileIdentity
  ) => Promise<NativeBuildFileSnapshot>;
}): {
  load: (
    runId: string,
    identity?: NativeBuildFileIdentity
  ) => Promise<NativeBuildFileSnapshot>;
  /** The cached snapshot for this run/identity, without fetching. */
  peek: (
    runId: string,
    identity?: NativeBuildFileIdentity
  ) => NativeBuildFileSnapshot | undefined;
} {
  let cached: { key: string; snapshot: NativeBuildFileSnapshot } | undefined;
  // A file snapshot can take many seconds on a large repository; concurrent polls share one fetch.
  const inFlight = new Map<string, Promise<NativeBuildFileSnapshot>>();
  const keyFor = (runId: string, identity?: NativeBuildFileIdentity) => identity
    ? `${runId}:${identity.source}:${identity.revision}`
    : undefined;
  const hit = (runId: string, requestedKey: string | undefined) =>
    cached && (requestedKey ? cached.key === requestedKey : cached.key.startsWith(`${runId}:`))
      ? cached.snapshot
      : undefined;
  return {
    peek: (runId, identity) => hit(runId, keyFor(runId, identity)),
    load: async (runId, identity) => {
      const requestedKey = keyFor(runId, identity);
      const cachedSnapshot = hit(runId, requestedKey);
      if (cachedSnapshot) return cachedSnapshot;
      const flightKey = requestedKey ?? `${runId}:*`;
      const pending = inFlight.get(flightKey);
      if (pending) return await pending;
      const request = options.load(runId, identity).then((snapshot) => {
        cached = {
          key: `${runId}:${snapshot.source}:${snapshot.revision}`,
          snapshot,
        };
        return snapshot;
      }).finally(() => inFlight.delete(flightKey));
      inFlight.set(flightKey, request);
      return await request;
    },
  };
}

export function nextNativeBuildPoll(
  state: NativeBuildPollState,
  runState: NativeRunProjection["state"]
): { state: NativeBuildPollState; action: "poll" | "terminal_refresh" | "stop" } {
  if (runState === "paused") return { state, action: "stop" };
  if (["created", "running", "stopping"].includes(runState)) {
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

export function createNativeBuildAttachmentController<
  TSnapshot extends { runState: NativeRunProjection["state"] },
>(options: {
  initialSavedRunId: string;
  resolveRunId: (savedRunId: string) => Promise<string>;
  load: (runId: string) => Promise<TSnapshot>;
  apply: (snapshot: TSnapshot & { runId: string }) => void;
  schedule: (callback: () => Promise<void>, delayMs: number) => unknown;
  cancelScheduled: (handle: unknown) => void;
  intervalMs: number;
  onError?: (error: unknown) => void;
  /**
   * Cheap change detector for a settled (paused/terminal) run, e.g. `${state}:${lastSequence}` from
   * the run record. When it changes — a resume from another tab, the API, or runner recovery — the
   * controller reloads instead of showing the stale paused snapshot until a manual refresh.
   */
  probe?: (runId: string) => Promise<string>;
}): { start: () => Promise<void>; wake: () => void; cancel: () => void } {
  let cancelled = false;
  let scheduled: unknown;
  let savedRunId = options.initialSavedRunId;
  let observedRunId: string | undefined;
  let observedState: NativeRunProjection["state"] | undefined;
  let observedProbe: string | undefined;
  let generation = 0;

  const schedule = (delayMs = options.intervalMs) => {
    if (cancelled) return;
    scheduled = options.schedule(run, delayMs);
  };
  const run = async (): Promise<void> => {
    const runGeneration = generation;
    scheduled = undefined;
    try {
      const runId = await options.resolveRunId(savedRunId);
      if (cancelled || runGeneration !== generation) return;
      const settled = observedState !== undefined &&
        !["created", "running", "stopping"].includes(observedState);
      if (settled && observedRunId === runId) {
        const probed = options.probe ? await options.probe(runId) : undefined;
        if (cancelled || runGeneration !== generation) return;
        if (probed === undefined || probed === observedProbe) {
          schedule();
          return;
        }
      }
      const snapshot = await options.load(runId);
      if (cancelled || runGeneration !== generation) return;
      savedRunId = runId;
      observedRunId = runId;
      observedState = snapshot.runState;
      options.apply({ ...snapshot, runId });
      const nowSettled = !["created", "running", "stopping"].includes(snapshot.runState);
      observedProbe = nowSettled && options.probe ? await options.probe(runId) : undefined;
      if (cancelled || runGeneration !== generation) return;
      schedule();
    } catch (error) {
      if (cancelled || runGeneration !== generation) return;
      options.onError?.(error);
      schedule();
    }
  };

  return {
    start: run,
    wake: () => {
      if (cancelled) return;
      generation += 1;
      observedState = undefined;
      if (scheduled !== undefined) options.cancelScheduled(scheduled);
      schedule(0);
    },
    cancel: () => {
      cancelled = true;
      generation += 1;
      if (scheduled !== undefined) options.cancelScheduled(scheduled);
    },
  };
}

export function durableBuildHandoffPanels(
  projection: NativeBuildProjection,
  runState?: NativeRunProjection["state"]
): {
  architect: { requiredSequence?: number; reason: string; candidateRuntimeIds: string[] } | null;
  verifier: {
    requiredSequence?: number;
    reason: string;
    requiredCapabilities: string[];
    candidateRuntimeIds: string[];
  } | null;
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
      return { architect: null, verifier: null, project: null };
    }
    return {
      architect: null,
      verifier: null,
      project: {
        summary: projectHandoff.summary,
        options: [...projectHandoff.options],
      },
    };
  }
  const verifierSelection = projection.verifierSelection;
  if (verifierSelection?.status === "required") {
    return {
      architect: null,
      verifier: {
        requiredSequence: verifierSelection.requiredSequence,
        reason: verifierSelection.reason,
        requiredCapabilities: [...verifierSelection.requiredCapabilities],
        candidateRuntimeIds: [...verifierSelection.candidateRuntimeIds],
      },
      project: null,
    };
  }
  const architectHandoff = projection.runtime.architect.handoff;
  return {
    architect: architectHandoff
      ? {
          requiredSequence: architectHandoff.requiredSequence,
          reason: architectHandoff.reason,
          candidateRuntimeIds: [...architectHandoff.candidateRuntimeIds],
        }
      : null,
    verifier: null,
    project: null,
  };
}

export function nativeBuildTaskStatus(
  status: string,
  verification?: {
    kind?: string;
    generation?: {
      categories: Array<{ status: string }>;
      cleanup: { status: string };
      review: { status: string };
      repairs: Array<{ status: string }>;
    };
  },
): "planned" | "in_progress" | "review" | "fixing" | "done" | "failed" {
  if (verification?.kind === "final_verification" && verification.generation) {
    const generation = verification.generation;
    if (generation.repairs.length > 0 || generation.review.status === "repair_required") return "fixing";
    if (generation.categories.some((category) => category.status === "failed") || generation.cleanup.status === "failed") return "failed";
    if (generation.review.status === "approved") return "done";
    if (generation.cleanup.status === "succeeded" || generation.review.status === "requested") return "review";
    return "in_progress";
  }
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
  startedAt: string,
  pricingForModel?: (id: string) => ModelPricing | null,
): BuildUsageWindow {
  const usage = projection.effective;
  const estimatedUsd = usage.estimatedCostMicros / 1_000_000;
  const models = mapNativeBuildUsageModels(projection, pricingForModel);
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
