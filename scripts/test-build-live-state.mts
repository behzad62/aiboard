import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  applyDiscussionLiveStatus,
  applyNativeBuildPolicyEvent,
  createNativeBuildPolicySynchronizer,
  buildStopFallbackMessage,
  buildRunWorkflowStatus,
  durableBuildHandoffPanels,
  nativeBuildTaskStatus,
  nativeBuildAttachmentIdentityPatch,
  nativeBuildDiscussionStatus,
  nativeBuildRunPolicy,
  nativeBuildPolicyChange,
  nativeBuildRestorationPolicyPatch,
  reconcileNativeBuildTranscript,
  selectNativeBuildAttachmentView,
  shouldShowLegacyBuildFileFallback,
  nextNativeBuildPoll,
  createNativeBuildAttachmentPoller,
  createNativeBuildAttachmentController,
  createNativeBuildAttachmentRefresh,
  createNativeBuildFileLoader,
  nativeBuildFileIdentity,
  nativeBuildUsageWindow,
  shouldRestoreDurableBuildProjection,
  shouldShowBuildStopFallback,
} from "../lib/client/discussion-live-state";

assert.deepEqual(
  nativeBuildAttachmentIdentityPatch(
    "native-attached-run",
    "2026-07-14T06:00:00.000Z"
  ),
  {
    nativeBuildRunId: "native-attached-run",
    nativeBuildRequestedAt: null,
    updatedAt: "2026-07-14T06:00:00.000Z",
  },
  "authoritative attachment clears provisional new-pass provenance"
);

assert.equal(
  buildRunWorkflowStatus({
    status: "failed",
    stopReason: "blocked",
    projectHandoffRequested: true,
  }),
  "Awaiting project handoff"
);
const synchronizedPolicies: string[] = [];
const synchronizePolicy = createNativeBuildPolicySynchronizer(
  "budgeted",
  (event) => synchronizedPolicies.push(event.policy)
);
synchronizePolicy({ runPolicy: "finish" } as never);
synchronizePolicy({ runPolicy: "finish" } as never);
assert.deepEqual(
  synchronizedPolicies,
  ["finish"],
  "the engine persistence/emission callback runs only for an actual change",
);
assert.equal(
  buildRunWorkflowStatus({
    status: "stopped",
    stopReason: "blocked",
    projectHandoffRequested: false,
  }),
  "stopped (blocked)"
);

const stopped = {
  id: "discussion_1",
  mode: "build",
  status: "stopped",
  buildStopReason: "blocked",
  buildStoppedAt: "2026-07-12T00:00:00.000Z",
} as never;

assert.deepEqual(
  applyDiscussionLiveStatus(stopped, "running"),
  {
    id: "discussion_1",
    mode: "build",
    status: "running",
    buildStopReason: null,
    buildStoppedAt: null,
  }
);

assert.equal(
  buildStopFallbackMessage("blocked"),
  "Build paused at its durable checkpoint after a recoverable blocker."
);
assert.doesNotMatch(buildStopFallbackMessage("blocked"), /repeated|budget/i);
assert.equal(
  shouldShowBuildStopFallback({
    stopReason: "blocked",
    status: "stopped",
    hasStopReport: false,
    hasArchitectHandoff: false,
    hasProjectHandoff: true,
  }),
  false
);
assert.equal(
  shouldShowBuildStopFallback({
    stopReason: "blocked",
    status: "stopped",
    hasStopReport: false,
    hasArchitectHandoff: false,
    hasProjectHandoff: false,
  }),
  true
);
assert.deepEqual(
  durableBuildHandoffPanels({
    projectHandoff: {
      status: "requested",
      summary: "Ready",
      options: ["keep_integration_branch", "apply_to_project"],
    },
    runtime: { architect: {} },
  } as never),
  {
    architect: null,
    project: {
      summary: "Ready",
      options: ["keep_integration_branch", "apply_to_project"],
    },
  }
);
const automaticHandoffProjection = {
  runPolicy: "finish",
  projectHandoff: {
    status: "requested",
    summary: "Automatic apply pending",
    options: ["keep_integration_branch", "apply_to_project"],
  },
  runtime: { architect: {} },
} as never;
assert.equal(
  durableBuildHandoffPanels(automaticHandoffProjection, "running").project,
  null,
  "an in-flight successful automatic handoff does not flash a manual decision",
);
assert.notEqual(
  durableBuildHandoffPanels(automaticHandoffProjection, "paused").project,
  null,
  "a failed/recoverable automatic handoff remains actionable once the run pauses",
);
assert.equal(nativeBuildTaskStatus("integrated"), "done");
assert.equal(nativeBuildTaskStatus("running"), "in_progress");
assert.equal(nativeBuildTaskStatus("submitted"), "review");
assert.equal(nativeBuildDiscussionStatus({ status: "running" } as never), "running");
assert.equal(nativeBuildDiscussionStatus({ status: "paused" } as never), "stopped");
assert.equal(nativeBuildDiscussionStatus({ status: "completed" } as never), "completed");
assert.equal(nativeBuildRunPolicy({ runPolicy: "finish" } as never, "budgeted"), "finish");
assert.equal(nativeBuildRunPolicy({} as never, "plan_only"), "plan_only");
const policyChange = nativeBuildPolicyChange(
  "budgeted",
  { runPolicy: "finish" } as never
);
assert.deepEqual(policyChange, { type: "native_build_policy", policy: "finish" });
assert.equal(
  nativeBuildPolicyChange(policyChange!.policy, { runPolicy: "finish" } as never),
  null,
  "the engine emits and persists a durable policy change only once",
);
assert.equal(
  applyNativeBuildPolicyEvent(
    { ...stopped, buildRunPolicy: "budgeted" } as never,
    policyChange!
  ).buildRunPolicy,
  "finish",
  "the live discussion event updates React-facing discussion state",
);
assert.deepEqual(
  nativeBuildRestorationPolicyPatch(
    { ...stopped, buildRunPolicy: "budgeted" } as never,
    { status: "paused", runPolicy: "plan_only" } as never
  ),
  { buildRunPolicy: "plan_only" },
  "stopped restoration synchronizes the Runner policy even when status is unchanged",
);
assert.equal(shouldRestoreDurableBuildProjection("stopped"), true);
assert.equal(shouldRestoreDurableBuildProjection("failed"), true);
assert.equal(shouldRestoreDurableBuildProjection("running"), true);
assert.equal(shouldRestoreDurableBuildProjection("completed"), true);
assert.equal(shouldRestoreDurableBuildProjection("pending"), true);

const transcriptProjection = {
  runtime: {
    architect: { runtimeId: "runtime-architect" },
    workerAssignments: {
      worker_T1_1: { runtimeId: "runtime-worker" },
    },
  },
} as never;
const transcriptUsage = {
  models: [
    {
      runtimeId: "runtime-architect",
      modelId: "architect-model",
      displayName: "Architect Model",
    },
    {
      runtimeId: "runtime-worker",
      modelId: "worker-model",
      displayName: "Worker Model",
    },
  ],
} as never;
const nativeTranscript = reconcileNativeBuildTranscript(
  null,
  "run_native",
  {
    turns: [
      {
        id: "native-1",
        sessionId: "architect:run_native",
        actor: { role: "architect", id: "architect" },
        sequence: 1,
        occurredAt: "2026-07-14T00:00:01.000Z",
        text: "Architect response",
      },
      {
        id: "native-user",
        sessionId: "user:run_native",
        actor: { role: "user", id: "local-user" },
        sequence: 2,
        occurredAt: "2026-07-14T00:00:02.000Z",
        text: "User note must not appear",
      },
      {
        id: "native-3",
        sessionId: "worker:run_native:T1:1",
        actor: { role: "worker", id: "worker_T1_1" },
        sequence: 3,
        occurredAt: "2026-07-14T00:00:03.000Z",
        text: "Worker response",
      },
      {
        id: "native-blank",
        sessionId: "worker:run_native:T1:1",
        actor: { role: "worker", id: "worker_T1_1" },
        sequence: 4,
        occurredAt: "2026-07-14T00:00:04.000Z",
        text: "   ",
      },
    ],
    cursor: 4,
  } as never,
  transcriptProjection,
  transcriptUsage,
);

const sameCheckpointTranscript = reconcileNativeBuildTranscript(
  null,
  "run_same_checkpoint",
  {
    turns: [
      {
        id: "z-first-durable-turn",
        sessionId: "architect:run_same_checkpoint",
        actor: { role: "architect", id: "architect" },
        sequence: 9,
        ordinal: 2,
        occurredAt: "2026-07-14T00:00:09.000Z",
        text: "First durable response",
      },
      {
        id: "a-second-durable-turn",
        sessionId: "architect:run_same_checkpoint",
        actor: { role: "architect", id: "architect" },
        sequence: 9,
        ordinal: 5,
        occurredAt: "2026-07-14T00:00:09.000Z",
        text: "Second durable response",
      },
    ],
    cursor: 9,
  } as never,
  transcriptProjection,
  transcriptUsage,
);
assert.deepEqual(
  sameCheckpointTranscript.messages.map((message) => message.id),
  ["z-first-durable-turn", "a-second-durable-turn"],
  "same-checkpoint turns preserve Runner sequence, ordinal, id order",
);
assert.deepEqual(
  nativeTranscript.messages.map((message) => ({
    id: message.id,
    round: message.round,
    modelId: message.modelId,
    modelName: message.modelName,
    content: message.content,
  })),
  [
    {
      id: "native-1",
      round: 1,
      modelId: "runtime-architect",
      modelName: "Architect · Architect Model",
      content: "Architect response",
    },
    {
      id: "native-3",
      round: 3,
      modelId: "runtime-worker",
      modelName: "Worker worker_T1_1 · Worker Model",
      content: "Worker response",
    },
  ],
  "native attachment maps only textual assistant model turns with actor/runtime names",
);
const reconnectedTranscript = reconcileNativeBuildTranscript(
  nativeTranscript,
  "run_native",
  {
    turns: [
      {
        id: "native-3",
        sessionId: "worker:run_native:T1:1",
        actor: { role: "worker", id: "worker_T1_1" },
        sequence: 3,
        occurredAt: "2026-07-14T00:00:03.000Z",
        text: "Worker response",
      },
      {
        id: "native-5",
        sessionId: "subagent:run_native:T1:1",
        actor: { role: "subagent", id: "worker_T1_1:call_1" },
        sequence: 5,
        occurredAt: "2026-07-14T00:00:05.000Z",
        text: "Subagent response",
      },
      {
        id: "native-6",
        sessionId: "subagent:run_native:architect",
        actor: { role: "subagent", id: "architect_1:call_2" },
        sequence: 6,
        occurredAt: "2026-07-14T00:00:06.000Z",
        text: "Architect subagent response",
      },
    ],
    cursor: 6,
  },
  transcriptProjection,
  transcriptUsage,
);
assert.deepEqual(
  reconnectedTranscript.messages.map((message) => message.id),
  ["native-1", "native-3", "native-5", "native-6"],
  "overlapping reconnect pages deduplicate by stable native turn id",
);
assert.equal(
  reconnectedTranscript.messages.find((message) => message.id === "native-6")?.modelName,
  "Subagent architect_1:call_2 · Architect Model",
  "Architect subagents inherit the Architect runtime display name",
);
assert.equal(reconnectedTranscript.cursor, 6);
assert.equal(
  reconnectedTranscript.messages.find((message) => message.id === "native-5")?.modelName,
  "Subagent worker_T1_1:call_1 · Worker Model",
  "subagents inherit their parent worker runtime display name",
);
const legacyBrowserMessages = [{
  id: "legacy-browser-message",
  round: 1,
  modelId: "legacy-model",
  modelName: "Legacy model",
  content: "Legacy cached response",
}];
const legacyBrowserFiles = [{
  path: "src/legacy-cache.ts",
  content: "export const legacy = true;",
}];
const nativeFileAttachment = {
  runId: "run_native",
  key: "run_native:integration:revision-native",
  snapshot: {
    source: "integration" as const,
    revision: "revision-native",
    appliedToProject: false,
    omittedFileCount: 0,
    files: [{
      path: "src/native-runner.ts",
      content: "export const native = true;",
    }],
  },
};
const pendingAttachmentView = selectNativeBuildAttachmentView({
  authoritativeRunId: "run_native",
  legacyMessages: legacyBrowserMessages,
  legacyFiles: legacyBrowserFiles,
  nativeTranscript: null,
  nativeFiles: null,
});
assert.deepEqual(
  pendingAttachmentView.messages.map((message) => message.id),
  ["legacy-browser-message"],
  "legacy transcript remains the visible/downloadable fallback before attachment succeeds",
);
assert.deepEqual(
  pendingAttachmentView.files.map((file) => file.path),
  ["src/legacy-cache.ts"],
  "legacy files remain visible before attachment succeeds",
);
assert.equal(
  shouldShowLegacyBuildFileFallback({
    hasNativeFiles: false,
    hasFinalResult: false,
    legacyFileCount: pendingAttachmentView.files.length,
    streamConnected: true,
  }),
  true,
  "an active/retrying native connection does not hide the legacy file fallback",
);
const attachedView = selectNativeBuildAttachmentView({
  authoritativeRunId: "run_native",
  legacyMessages: legacyBrowserMessages,
  legacyFiles: legacyBrowserFiles,
  nativeTranscript: reconnectedTranscript,
  nativeFiles: nativeFileAttachment,
});
assert.deepEqual(
  attachedView.messages.map((message) => message.id),
  ["native-1", "native-3", "native-5", "native-6"],
  "successful native attachment replaces seeded legacy browser messages",
);
assert.deepEqual(
  attachedView.files.map((file) => file.path),
  ["src/native-runner.ts"],
  "successful native attachment replaces seeded legacy browser files",
);
const switchedRunView = selectNativeBuildAttachmentView({
  authoritativeRunId: "run_after_switch",
  legacyMessages: legacyBrowserMessages,
  legacyFiles: legacyBrowserFiles,
  nativeTranscript: reconnectedTranscript,
  nativeFiles: nativeFileAttachment,
});
assert.deepEqual(
  switchedRunView.messages.map((message) => message.id),
  ["legacy-browser-message"],
  "a stale old-run transcript response cannot overwrite the run-switch fallback",
);
assert.deepEqual(
  switchedRunView.files.map((file) => file.path),
  ["src/legacy-cache.ts"],
  "a stale old-run file response cannot overwrite the run-switch fallback",
);

let pollState = { observedActive: false, terminalRefreshScheduled: false };
let poll = nextNativeBuildPoll(pollState, "running");
assert.equal(poll.action, "poll");
pollState = poll.state;
poll = nextNativeBuildPoll(pollState, "paused");
assert.equal(poll.action, "stop", "running-to-paused performs one final reconciliation and stops");

const initiallyPausedQueue: Array<() => Promise<void>> = [];
const initiallyPausedPoller = createNativeBuildAttachmentPoller({
  refresh: async () => ({ runState: "paused" as const }),
  apply: () => undefined,
  schedule: (callback) => {
    initiallyPausedQueue.push(callback);
    return callback;
  },
  cancelScheduled: () => undefined,
  intervalMs: 1,
});
await initiallyPausedPoller.start();
assert.equal(initiallyPausedQueue.length, 0, "an initially paused run reconciles once and stops");

let fileFetches = 0;
const fileLoader = createNativeBuildFileLoader({
  load: async (runId, identity) => {
    fileFetches += 1;
    return {
      source: identity?.source ?? "integration" as const,
      revision: identity?.revision ?? (runId === "run_b" ? "b".repeat(40) : "a".repeat(40)),
      appliedToProject: false,
      omittedFileCount: 0,
      files: [],
    };
  },
});
const revisionA = { source: "integration" as const, revision: "a".repeat(40) };
await fileLoader.load("run_a", revisionA);
await fileLoader.load("run_a", revisionA);
assert.equal(fileFetches, 1, "an unchanged run/source/revision does not refetch files");
await fileLoader.load("run_a", { source: "integration", revision: "c".repeat(40) });
await fileLoader.load("run_a", { source: "integration", revision: "c".repeat(40) });
assert.equal(fileFetches, 2, "a revision change fetches files once");
await fileLoader.load("run_a", { source: "project", revision: "c".repeat(40) });
assert.equal(fileFetches, 3, "a source change fetches files once");
await fileLoader.load("run_b", { source: "integration", revision: "b".repeat(40) });
assert.equal(fileFetches, 4, "a run switch invalidates the old file snapshot");

assert.deepEqual(
  nativeBuildFileIdentity({
    tasks: {},
    projectHandoff: {
      status: "selected",
      appliedToProject: true,
      projectRevision: "d".repeat(40),
    },
  } as never),
  { source: "project", revision: "d".repeat(40) }
);
pollState = poll.state;
poll = nextNativeBuildPoll(pollState, "completed");
assert.equal(poll.action, "terminal_refresh", "active-to-terminal schedules one final refresh");
pollState = poll.state;
poll = nextNativeBuildPoll(pollState, "completed");
assert.equal(poll.action, "stop", "the terminal refresh is performed only once");

const queuedPolls: Array<() => Promise<void>> = [];
const observedPollStates: string[] = [];
const pollSnapshots = [
  { runState: "running" as const },
  { runState: "completed" as const },
  { runState: "completed" as const },
];
const attachmentPoller = createNativeBuildAttachmentPoller({
  refresh: async () => pollSnapshots.shift()!,
  apply: (snapshot) => observedPollStates.push(snapshot.runState),
  schedule: (callback) => {
    queuedPolls.push(callback);
    return callback;
  },
  cancelScheduled: () => undefined,
  intervalMs: 1,
});
await attachmentPoller.start();
assert.equal(queuedPolls.length, 1);
await queuedPolls.shift()!();
assert.equal(queuedPolls.length, 1, "terminal transition queues one final reconciliation");
await queuedPolls.shift()!();
assert.deepEqual(observedPollStates, ["running", "completed", "completed"]);
assert.equal(queuedPolls.length, 0, "polling stops after the final terminal refresh");

let releaseStale!: (snapshot: { runState: "running" }) => void;
const staleSnapshot = new Promise<{ runState: "running" }>((resolve) => {
  releaseStale = resolve;
});
let staleApplyCount = 0;
const stalePoller = createNativeBuildAttachmentPoller({
  refresh: async () => await staleSnapshot,
  apply: () => { staleApplyCount += 1; },
  schedule: () => 1,
  cancelScheduled: () => undefined,
  intervalMs: 1,
});
const staleStart = stalePoller.start();
stalePoller.cancel();
releaseStale({ runState: "running" });
await staleStart;
assert.equal(staleApplyCount, 0, "cancelled old-run responses cannot overwrite a newer attachment");

const attachmentRetryQueue: Array<() => Promise<void>> = [];
let resolutionAttempts = 0;
let fetchAttempts = 0;
const refreshAfterFailure = createNativeBuildAttachmentRefresh({
  savedRunId: "stale-saved-run",
  resolveRunId: async () => {
    resolutionAttempts += 1;
    if (resolutionAttempts === 1) throw new Error("runner temporarily unavailable");
    return "run_recovered";
  },
  load: async (runId) => {
    fetchAttempts += 1;
    if (fetchAttempts === 1) throw new Error("snapshot temporarily unavailable");
    return { runState: "completed" as const, marker: runId };
  },
});
const recoveredSnapshots: string[] = [];
const retryingAttachmentPoller = createNativeBuildAttachmentPoller({
  refresh: refreshAfterFailure,
  apply: (snapshot) => recoveredSnapshots.push(snapshot.marker),
  schedule: (callback) => {
    attachmentRetryQueue.push(callback);
    return callback;
  },
  cancelScheduled: () => undefined,
  intervalMs: 1,
});
await retryingAttachmentPoller.start();
assert.equal(attachmentRetryQueue.length, 1, "initial resolution failure schedules a retry");
await attachmentRetryQueue.shift()!();
assert.equal(attachmentRetryQueue.length, 1, "initial snapshot failure also schedules a retry");
await attachmentRetryQueue.shift()!();
assert.deepEqual(recoveredSnapshots, ["run_recovered"]);
assert.equal(attachmentRetryQueue.length, 0, "terminal recovery stops cleanly after attachment");

const stableControllerQueue: Array<() => Promise<void>> = [];
let authoritativeRunId = "run_stable_a";
let stableLoads = 0;
const stableApplies: string[] = [];
const stableController = createNativeBuildAttachmentController({
  initialSavedRunId: authoritativeRunId,
  resolveRunId: async () => authoritativeRunId,
  load: async (runId) => {
    stableLoads += 1;
    return { runState: "paused" as const, marker: runId };
  },
  apply: (snapshot) => stableApplies.push(snapshot.marker),
  schedule: (callback) => {
    stableControllerQueue.push(callback);
    return callback;
  },
  cancelScheduled: () => undefined,
  intervalMs: 1,
});
await stableController.start();
assert.deepEqual(stableApplies, ["run_stable_a"]);
assert.equal(stableLoads, 1);
assert.equal(stableControllerQueue.length, 1, "paused controllers keep lightweight discovery alive");
await stableControllerQueue.shift()!();
assert.deepEqual(stableApplies, ["run_stable_a"], "unchanged paused metadata does not reconcile twice");
assert.equal(stableLoads, 1, "unchanged paused metadata does not reload snapshots or files");
authoritativeRunId = "run_stable_b";
await stableControllerQueue.shift()!();
assert.deepEqual(stableApplies, ["run_stable_a", "run_stable_b"]);
assert.equal(stableLoads, 2, "a run switch loads the new run exactly once");
await stableControllerQueue.shift()!();
assert.deepEqual(stableApplies, ["run_stable_a", "run_stable_b"]);
assert.equal(stableLoads, 2, "the switched paused run is not fetched twice");
stableController.wake();
await stableControllerQueue.shift()!();
assert.deepEqual(
  stableApplies,
  ["run_stable_a", "run_stable_b", "run_stable_b"],
  "an explicit same-run Resume wakes the stable controller without recreating it"
);
assert.equal(stableLoads, 3);
stableController.cancel();

const wakeRaceQueue: Array<() => Promise<void>> = [];
let releaseOldResolution!: (runId: string) => void;
const oldResolution = new Promise<string>((resolve) => { releaseOldResolution = resolve; });
let resolveAttempt = 0;
const wakeRaceApplies: string[] = [];
const wakeRaceController = createNativeBuildAttachmentController({
  initialSavedRunId: "run_old",
  resolveRunId: async () => ++resolveAttempt === 1 ? await oldResolution : "run_new",
  load: async (runId) => ({ runState: "paused" as const, marker: runId }),
  apply: (snapshot) => wakeRaceApplies.push(snapshot.marker),
  schedule: (callback) => {
    wakeRaceQueue.push(callback);
    return callback;
  },
  cancelScheduled: () => undefined,
  intervalMs: 1,
});
const oldStart = wakeRaceController.start();
wakeRaceController.wake();
await wakeRaceQueue.shift()!();
releaseOldResolution("run_old");
await oldStart;
assert.deepEqual(
  wakeRaceApplies,
  ["run_new"],
  "an in-flight pre-wake response cannot overwrite the resumed controller"
);
wakeRaceController.cancel();

const staleErrorQueue: Array<() => Promise<void>> = [];
let rejectStaleResolution!: (error: Error) => void;
const staleResolutionFailure = new Promise<string>((_, reject) => {
  rejectStaleResolution = reject;
});
let staleErrorAttempt = 0;
const staleErrors: string[] = [];
const staleErrorApplies: string[] = [];
const staleErrorController = createNativeBuildAttachmentController({
  initialSavedRunId: "run_error_old",
  resolveRunId: async () => ++staleErrorAttempt === 1
    ? await staleResolutionFailure
    : "run_error_new",
  load: async (runId) => ({ runState: "paused" as const, marker: runId }),
  apply: (snapshot) => staleErrorApplies.push(snapshot.marker),
  onError: (error) => staleErrors.push(String(error)),
  schedule: (callback) => {
    staleErrorQueue.push(callback);
    return callback;
  },
  cancelScheduled: () => undefined,
  intervalMs: 1,
});
const staleErrorStart = staleErrorController.start();
staleErrorController.wake();
await staleErrorQueue.shift()!();
rejectStaleResolution(new Error("stale discovery failed"));
await staleErrorStart;
assert.deepEqual(staleErrors, [], "a stale pre-Resume rejection is not reported");
assert.deepEqual(staleErrorApplies, ["run_error_new"]);
assert.equal(staleErrorQueue.length, 1, "the stale rejection does not schedule a duplicate loop");
staleErrorController.cancel();

const discussionClientSource = readFileSync(
  new URL("../app/discussion/discussion-client.tsx", import.meta.url),
  "utf8"
);
assert.match(
  discussionClientSource,
  /useEffect\(\(\) => \{[\s\S]*?createNativeBuildAttachmentController[\s\S]*?\}, \[nativeAttachmentControllerKey\]\);/,
  "the component owns one stable native attachment controller keyed only by discussion/runner configuration"
);
assert.deepEqual(
  nativeBuildUsageWindow({
    scopeId: "run_1",
    reservations: {},
    activeSegments: {},
    effective: {
      modelCalls: 9,
      toolCalls: 27,
      inputTokens: 12_000,
      outputTokens: 3_000,
      estimatedCostMicros: 125_000,
      activeMs: 45_000,
      artifactBytes: 1_024,
    },
    lastSequence: 42,
  }, "2026-07-12T00:00:00.000Z"),
  {
    startedAt: "2026-07-12T00:00:00.000Z",
    elapsedMs: 45_000,
    estimatedUsd: 0.125,
    unknownPricedModelIds: [],
    models: [{
      modelId: "runner-v2:aggregate",
      modelName: "Runner V2 models (legacy aggregate)",
      providerId: "runner-v2",
      roles: [],
      calls: 9,
      inputTokens: 12_000,
      cachedInputTokens: 0,
      cacheWriteInputTokens: 0,
      outputTokens: 3_000,
      totalTokens: 15_000,
      estimatedUsd: null,
      priced: false,
      usageQuality: "estimated",
      costBasis: "unknown",
      lastUsedAt: null,
      usageOrigin: "legacy_aggregate",
    }],
  }
);

assert.deepEqual(
  nativeBuildUsageWindow({
    scopeId: "run_2",
    reservations: {},
    activeSegments: {},
    effective: {
      modelCalls: 1,
      toolCalls: 0,
      inputTokens: 20,
      cachedInputTokens: 5,
      cacheWriteInputTokens: 3,
      outputTokens: 7,
      estimatedCostMicros: 10_000,
      activeMs: 100,
      artifactBytes: 0,
    },
    models: [{
      runtimeId: "architect-runtime",
      providerId: "provider-a",
      modelId: "model-a",
      roles: ["architect"],
      status: "healthy",
      calls: 1,
      inputTokens: 20,
      cachedInputTokens: 5,
      cacheWriteInputTokens: 3,
      outputTokens: 7,
      totalTokens: 27,
      estimatedCostMicros: null,
      costBasis: "account_not_metered",
      usageQuality: "reported",
      lastUsedAt: "2026-07-12T01:02:03.000Z",
    }],
    lastSequence: 2,
  }, "2026-07-12T00:00:00.000Z"),
  {
    startedAt: "2026-07-12T00:00:00.000Z",
    elapsedMs: 100,
    estimatedUsd: 0.01,
    unknownPricedModelIds: [],
    models: [{
      runtimeId: "architect-runtime",
      modelId: "model-a",
      modelName: "model-a",
      providerId: "provider-a",
      roles: ["architect"],
      status: "healthy",
      calls: 1,
      inputTokens: 20,
      cachedInputTokens: 5,
      cacheWriteInputTokens: 3,
      outputTokens: 7,
      totalTokens: 27,
      estimatedUsd: null,
      priced: false,
      usageQuality: "reported",
      costBasis: "account_not_metered",
      lastUsedAt: "2026-07-12T01:02:03.000Z",
      usageOrigin: "native",
    }],
  }
);

const pricedWithUnusedRows = nativeBuildUsageWindow({
  scopeId: "run_3",
  reservations: {},
  activeSegments: {},
  effective: {
    modelCalls: 1,
    toolCalls: 0,
    inputTokens: 20,
    outputTokens: 7,
    estimatedCostMicros: 10_000,
    activeMs: 100,
    artifactBytes: 0,
  },
  models: [
    {
      runtimeId: "used-priced",
      providerId: "provider-a",
      modelId: "model-priced",
      roles: ["architect"],
      status: "healthy",
      calls: 1,
      inputTokens: 20,
      cachedInputTokens: 0,
      cacheWriteInputTokens: 0,
      outputTokens: 7,
      totalTokens: 27,
      estimatedCostMicros: 10_000,
      costBasis: "api_estimate",
      usageQuality: "reported",
      lastUsedAt: "2026-07-12T01:02:03.000Z",
    },
    {
      runtimeId: "unused-account",
      providerId: "provider-b",
      modelId: "model-account",
      roles: ["worker"],
      status: "unused",
      calls: 0,
      inputTokens: 0,
      cachedInputTokens: 0,
      cacheWriteInputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      estimatedCostMicros: null,
      costBasis: "account_not_metered",
      usageQuality: "none",
      lastUsedAt: null,
    },
    {
      runtimeId: "unused-unknown",
      providerId: "provider-c",
      modelId: "model-unused-unknown",
      roles: ["worker"],
      status: "unused",
      calls: 0,
      inputTokens: 0,
      cachedInputTokens: 0,
      cacheWriteInputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      estimatedCostMicros: null,
      costBasis: "unknown",
      usageQuality: "none",
      lastUsedAt: null,
    },
  ],
  lastSequence: 3,
}, "2026-07-12T00:00:00.000Z");
assert.deepEqual(pricedWithUnusedRows.unknownPricedModelIds, []);

const usedUnknownApi = nativeBuildUsageWindow({
  scopeId: "run_4",
  reservations: {},
  activeSegments: {},
  effective: {
    modelCalls: 1,
    toolCalls: 0,
    inputTokens: 0,
    outputTokens: 0,
    estimatedCostMicros: 0,
    activeMs: 100,
    artifactBytes: 0,
  },
  models: [{
    runtimeId: "used-unknown",
    providerId: "provider-d",
    modelId: "model-unknown",
    roles: ["architect"],
    status: "healthy",
    calls: 1,
    inputTokens: 0,
    cachedInputTokens: 0,
    cacheWriteInputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    estimatedCostMicros: null,
    costBasis: "unknown",
    usageQuality: "mixed",
    lastUsedAt: "2026-07-12T01:02:03.000Z",
  }],
  lastSequence: 4,
}, "2026-07-12T00:00:00.000Z");
assert.deepEqual(usedUnknownApi.unknownPricedModelIds, ["model-unknown"]);

const tokensOnlyUnknownApi = nativeBuildUsageWindow({
  scopeId: "run_5",
  reservations: {},
  activeSegments: {},
  effective: {
    modelCalls: 1,
    toolCalls: 0,
    inputTokens: 21,
    outputTokens: 7,
    estimatedCostMicros: 10_000,
    activeMs: 100,
    artifactBytes: 0,
  },
  models: [
    {
      runtimeId: "used-priced",
      providerId: "provider-a",
      modelId: "model-priced",
      roles: ["architect"],
      status: "healthy",
      calls: 1,
      inputTokens: 20,
      cachedInputTokens: 0,
      cacheWriteInputTokens: 0,
      outputTokens: 7,
      totalTokens: 27,
      estimatedCostMicros: 10_000,
      costBasis: "api_estimate",
      usageQuality: "reported",
      lastUsedAt: "2026-07-12T01:02:03.000Z",
    },
    {
      runtimeId: "tokens-only-unknown",
      providerId: "provider-e",
      modelId: "model-tokens-only",
      roles: ["worker"],
      status: "unused",
      calls: 0,
      inputTokens: 1,
      cachedInputTokens: 0,
      cacheWriteInputTokens: 0,
      outputTokens: 0,
      totalTokens: 1,
      estimatedCostMicros: null,
      costBasis: "unknown",
      usageQuality: "mixed",
      lastUsedAt: null,
    },
  ],
  lastSequence: 5,
}, "2026-07-12T00:00:00.000Z");
assert.deepEqual(
  tokensOnlyUnknownApi.unknownPricedModelIds,
  ["model-tokens-only"]
);

console.log("PASS Build live discussion state");
