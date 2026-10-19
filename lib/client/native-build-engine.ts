import type { Discussion } from "@/lib/db/schema";
import type { OrchestratorEvent } from "@/lib/orchestrator/engine";
import { normalizeBuildSettings } from "@/lib/orchestrator/build-policy";
import { parseModelId } from "@/lib/providers/base";
import { MODEL_CATALOG } from "@/lib/providers/catalog";
import { getModelPricing, type ModelPricing } from "@/lib/providers/pricing";
import { getProviderDefinition } from "@/lib/providers/provider-registry";
import { resolveProviderCapabilityProfile } from "@/lib/providers/capability-resolution";
import {
  getDiscoveredModelMetadata,
  getPersistedProviderCapabilityEvidence,
} from "./providers";
import {
  getMessagesForDiscussion,
  getCustomModelById,
  getProviderKey,
  getUserSettings,
  insertFinalResult,
  updateDiscussion,
} from "./store";
import {
  commandNativeRun,
  configureNativeProviders,
  createNativeBuild,
  prepareNativeBuildInitialVisuals,
  getNativeBuild,
  getNativeBuildEvents,
  getNativeBuildUsage,
  getNativePermissions,
  getNativeRun,
  getNativeRunnerHealth,
  registerNativePlanningSource,
  resolveNativeBuildRunId,
  type NativeBuildEvent,
  type NativeBuildProjection,
  type NativeProviderConfig,
  type NativeRunProjection,
  type NativeRunnerConnection,
} from "./runner-v2";
import { requestSpecificationSource } from "./native-planning-view";
import { loadAttachmentPayloads } from "./attachments";
import { initialNativeBuildTextAttachments } from "./build-guidance-files";
import { initialBuildVisualInputs } from "./build-user-attachments";
import { buildCrewFromDiscussion, runtimeModelId, selectBuildCrewRuntimes } from "./build-crew";
import {
  nativeBuildAttachmentIdentityPatch,
  nativeBuildTaskStatus,
  createNativeBuildPolicySynchronizer,
  nativeBuildUsageWindow,
} from "./discussion-live-state";
import {
  effectiveNativeBuildPolicy,
  explicitNativePlanningOptions,
  type NativePlanningProvisioningOptions,
  NATIVE_RUNNER_NODE_POLICY_DESCRIPTION,
  nativeProviderBillingBasis,
  supportsNativeRunnerNodeVersion,
} from "./native-build-policy";

type Emit = (event: OrchestratorEvent) => void;

export type NativeBuildPauseGate =
  | { kind: "resume" }
  | { kind: "project_handoff" }
  | {
      kind: "verifier_selection";
      requiredSequence?: number;
      reason: string;
      requiredCapabilities: string[];
      candidateRuntimeIds: string[];
    }
  | {
      kind: "architect_handoff";
      requiredSequence?: number;
      reason: string;
      candidateRuntimeIds: string[];
    };

export function nativeBuildPauseGate(
  projection: NativeBuildProjection
): NativeBuildPauseGate {
  if (projection.projectHandoff?.status === "requested") {
    return { kind: "project_handoff" };
  }
  if (projection.verifierSelection?.status === "required") {
    return {
      kind: "verifier_selection",
      requiredSequence: projection.verifierSelection.requiredSequence,
      reason: projection.verifierSelection.reason,
      requiredCapabilities: [
        ...projection.verifierSelection.requiredCapabilities,
      ],
      candidateRuntimeIds: [
        ...projection.verifierSelection.candidateRuntimeIds,
      ],
    };
  }
  const handoff = projection.runtime.architect.handoff;
  if (handoff) {
    return {
      kind: "architect_handoff",
      requiredSequence: handoff.requiredSequence,
      reason: handoff.reason,
      candidateRuntimeIds: [...handoff.candidateRuntimeIds],
    };
  }
  return { kind: "resume" };
}

export function nativeBuildAttachAction(
  state: NativeRunProjection["state"]
): "start" | "observe_paused" | "observe" {
  if (state === "created") return "start";
  if (state === "paused") return "observe_paused";
  return "observe";
}

export function nativeBuildProvisioningRunId(
  reservedRunId: string | null | undefined
): string {
  return reservedRunId ?? `native-${crypto.randomUUID()}`;
}

export async function loadNativeBuildAuthoritativeSnapshot<TRun, TBuild>(options: {
  loadRun: () => Promise<TRun>;
  loadBuild: () => Promise<TBuild>;
  onAttached: () => void | Promise<void>;
}): Promise<{ run: TRun; build: TBuild }> {
  const [run, build] = await Promise.all([
    options.loadRun(),
    options.loadBuild(),
  ]);
  await options.onAttached();
  return { run, build };
}

export async function runNativeBuildDiscussion(
  discussion: Discussion,
  emit: Emit,
  signal: AbortSignal,
  planningOptions?: NativePlanningProvisioningOptions
): Promise<void> {
  if (!discussion.runnerUrl || !discussion.runnerToken) {
    throw new Error("Build mode requires a connected Runner V2 instance.");
  }
  const connection: NativeRunnerConnection = {
    url: discussion.runnerUrl,
    token: discussion.runnerToken,
  };
  const syncDurablePolicy = createNativeBuildPolicySynchronizer(
    discussion.buildRunPolicy ?? "finish",
    (change) => {
      updateDiscussion(discussion.id, {
        buildRunPolicy: change.policy,
        updatedAt: new Date().toISOString(),
      });
      emit(change);
    }
  );
  emit({ type: "status", status: "running" });
  emit({
    type: "diagnostic",
    phase: "initializing",
    message: "Connecting to the native Runner V2 agent kernel",
  });
  const health = await getNativeRunnerHealth(connection);
  if (!supportsNativeRunnerNodeVersion(health.nodeVersion)) {
    throw new Error(
      `Runner V2 supports ${NATIVE_RUNNER_NODE_POLICY_DESCRIPTION}; connected runner uses ${health.nodeVersion}.`
    );
  }
  let runId = discussion.nativeBuildRunId
    ? discussion.status === "pending"
      ? await resolveNativeBuildRunId(
          connection,
          discussion.nativeBuildRunId,
          discussion.id,
          fetch,
          {
            allowMissing: true,
            requestedAt: discussion.nativeBuildRequestedAt,
          }
        )
      : await resolveNativeBuildRunId(
          connection,
          discussion.nativeBuildRunId,
          discussion.id
        )
    : undefined;
  const shouldPersistResolvedIdentity = Boolean(
    runId &&
    (runId !== discussion.nativeBuildRunId || discussion.nativeBuildRequestedAt)
  );
  const crew = buildCrewFromDiscussion(discussion);
  if (!crew) throw new Error("Build mode requires an Architect model.");
  const {
    runtimes,
    architectRuntimeId,
    reviewerRuntimeId,
    workerRuntimeIds,
    verifierRuntimeIds,
  } = selectBuildCrewRuntimes(crew);
  const providerConfigs: NativeProviderConfig[] = [];
  for (const [index, runtime] of runtimes.entries()) {
    try {
      providerConfigs.push(createNativeProviderConfig(
        runtime.runtimeId,
        index,
        runtime.reasoningEffort
      ));
    } catch (error) {
      // Attaching to an existing run: the runner already holds durable (merged) provider configs,
      // so a browser without this key (another device, an observer tab) can still watch the run.
      if (!runId) throw error;
    }
  }
  if (providerConfigs.length > 0) await configureNativeProviders(connection, providerConfigs);
  if (!runId) {
    runId = nativeBuildProvisioningRunId(discussion.nativeBuildRunId);
    let objective = buildObjective(discussion);
    const initialAttachmentIds: string[] = discussion.attachmentIds ? JSON.parse(discussion.attachmentIds) : [];
    const visuals = initialBuildVisualInputs(loadAttachmentPayloads(initialAttachmentIds));
    if (visuals.length) {
      emit({ type: "diagnostic", phase: "initializing", message: "Preparing initial image/PDF evidence with a compatible model" });
      const prepared = await prepareNativeBuildInitialVisuals(connection, {
        runId, architectRuntimeId, text: objective, attachments: visuals,
      });
      objective = `${objective}\n\n${prepared.visualEvidence}`;
    }
    const nativePolicy = effectiveNativeBuildPolicy(
      normalizeBuildSettings(discussion)
    );
    await createNativeBuild(connection, {
      runId,
      projectPath: health.projectPath,
      permissionProfile:
        discussion.runnerAccess === "full"
          ? "full"
          : discussion.runnerAccess === "project"
            ? "project"
            : "guarded",
      idempotencyKey: `create:${runId}`,
      build: {
        projectId: discussion.id,
        objective,
        architectRuntimeId,
        workerRuntimeIds,
        verifierRuntimeIds,
        ...(reviewerRuntimeId ? { reviewerRuntimeId } : {}),
        maxConcurrency: Math.max(1, Math.min(4, workerRuntimeIds.length)),
        ...nativePolicy,
        ...explicitNativePlanningOptions(planningOptions ?? (discussion.buildEvidenceGatedPlanning === true ? {
          planningPolicy: { version: 1 }, specCopy: discussion.buildSpecCopy ?? true, answerReview: discussion.buildAnswerReview === true,
          handoffFiles: discussion.buildHandoffFiles ?? "commit",
        } : {})),
      },
    });
    updateDiscussion(
      discussion.id,
      nativeBuildAttachmentIdentityPatch(runId, new Date().toISOString())
    );
    if (discussion.buildEvidenceGatedPlanning === true && !planningOptions) {
      // The request the owner just submitted is the approved specification; without this the run
      // would stop at once asking for a separately uploaded document.
      emit({ type: "diagnostic", phase: "initializing", message: "Registering your request as the approved specification" });
      try {
        await registerNativePlanningSource(connection, runId, {
          approvedSource: requestSpecificationSource(objective),
          idempotencyKey: `source-approval:${runId}:request`,
        });
      } catch (error) {
        emit({
          type: "diagnostic",
          phase: "initializing",
          message: `Could not register the request as the specification (${error instanceof Error ? error.message : String(error)}); approve one in "Needs you".`,
        });
      }
    }
  }
  const { run, build: initialProjection } =
    await loadNativeBuildAuthoritativeSnapshot({
      loadRun: async () => await getNativeRun(connection, runId),
      loadBuild: async () => await getNativeBuild(connection, runId),
      onAttached: () => {
        if (!shouldPersistResolvedIdentity) return;
        updateDiscussion(
          discussion.id,
          nativeBuildAttachmentIdentityPatch(runId, new Date().toISOString())
        );
      },
    });
  syncDurablePolicy(initialProjection);
  emit({
    type: "build_usage",
    usage: nativeBuildUsageWindow(
      await getNativeBuildUsage(connection, runId),
      run.createdAt
    ),
  });
  const attachAction = nativeBuildAttachAction(run.state);
  if (attachAction === "start") {
    await commandNativeRun(connection, runId, "start", `start:${runId}`);
  } else if (attachAction === "observe_paused") {
    const pausedProjection = initialProjection;
    const pauseGate = nativeBuildPauseGate(pausedProjection);
    if (pauseGate.kind === "project_handoff") {
      emitProjectHandoffPause(discussion, pausedProjection, emit);
      return;
    }
    if (pauseGate.kind === "verifier_selection") {
      emitVerifierSelectionPause(discussion, pauseGate, emit);
      return;
    }
    if (pauseGate.kind === "architect_handoff") {
      emitArchitectHandoffPause(discussion, pauseGate, emit);
      return;
    }
    emitResumablePause(discussion, emit);
    return;
  } else if (run.state === "completed") {
    const events = await getNativeBuildEvents(connection, runId, 0);
    finalizeNativeBuild(discussion, completionSummary(events), emit);
    return;
  } else if (["failed", "stopped"].includes(run.state)) {
    throw new Error(`Native Build ${runId} is terminal (${run.state}); start a new pass.`);
  }

  updateDiscussion(discussion.id, {
    status: "running",
    buildStopReason: null,
    buildStoppedAt: null,
    updatedAt: new Date().toISOString(),
  });
  let cursor = 0;
  const announcedPermissions = new Set<string>();
  try {
    for (;;) {
      if (signal.aborted) throw abortError();
      const events = await getNativeBuildEvents(connection, runId, cursor);
      for (const event of events) {
        cursor = Math.max(cursor, event.sequence);
        emitSchedulerEvent(event, emit);
      }
      const [projection, usage] = await Promise.all([
        getNativeBuild(connection, runId),
        getNativeBuildUsage(connection, runId),
      ]);
      syncDurablePolicy(projection);
      emitTaskProjection(projection, emit);
      emit({
        type: "build_usage",
        usage: nativeBuildUsageWindow(usage, run.createdAt),
      });
      const permissions = await getNativePermissions(connection, runId);
      for (const permission of permissions) {
        if (permission.status !== "pending" || announcedPermissions.has(permission.requestId)) {
          continue;
        }
        announcedPermissions.add(permission.requestId);
        emit({
          type: "native_permission_required",
          requestId: permission.requestId,
          toolName: permission.toolName,
          capability: permission.access.capability,
          actor: `${permission.actor.role}:${permission.actor.id}`,
          outsideWorkspace: permission.outsideWorkspace,
          external: permission.access.external === true,
          destructive: permission.access.destructive === true,
          credentialChange: permission.access.credentialChange === true,
        });
      }
      if (projection.status === "completed") {
        finalizeNativeBuild(
          discussion,
          completionSummary(events) ?? completionSummary(
            await getNativeBuildEvents(connection, runId, 0)
          ),
          emit
        );
        return;
      }
      if (projection.status === "paused") {
        const pauseGate = nativeBuildPauseGate(projection);
        if (pauseGate.kind === "project_handoff") {
          emitProjectHandoffPause(discussion, projection, emit);
          return;
        }
        if (pauseGate.kind === "verifier_selection") {
          emitVerifierSelectionPause(discussion, pauseGate, emit);
          return;
        }
        if (pauseGate.kind === "architect_handoff") {
          emitArchitectHandoffPause(discussion, pauseGate, emit);
          return;
        }
        emitResumablePause(discussion, emit);
        return;
      }
      await delay(750, signal);
    }
  } catch (error) {
    if (signal.aborted || (error instanceof Error && error.name === "AbortError")) {
      const now = new Date().toISOString();
      updateDiscussion(discussion.id, {
        status: "stopped",
        buildStopReason: "user",
        buildStoppedAt: now,
        updatedAt: now,
      });
      emit({ type: "build_stopped", reason: "user", message: "Native Build paused by the user." });
      return;
    }
    const now = new Date().toISOString();
    updateDiscussion(discussion.id, {
      status: "stopped",
      buildStopReason: "blocked",
      buildStoppedAt: now,
      updatedAt: now,
    });
    emit({
      type: "build_stopped",
      reason: "blocked",
      message:
        "Lost the Runner V2 observer connection. The native Build may still be running; Resume reconnects to the same durable run.",
    });
    return;
  }
}

function emitResumablePause(discussion: Discussion, emit: Emit): void {
  const now = new Date().toISOString();
  updateDiscussion(discussion.id, {
    status: "stopped",
    buildStopReason: "blocked",
    buildStoppedAt: now,
    updatedAt: now,
  });
  emit({
    type: "build_stopped",
    reason: "blocked",
    message: "Native Build paused safely; resume after resolving the reported blocker.",
  });
}

function emitArchitectHandoffPause(
  discussion: Discussion,
  handoff: Extract<NativeBuildPauseGate, { kind: "architect_handoff" }>,
  emit: Emit
): void {
  emit({
    type: "architect_handoff_required",
    requiredSequence: handoff.requiredSequence,
    reason: handoff.reason,
    candidateRuntimeIds: [...handoff.candidateRuntimeIds],
  });
  const now = new Date().toISOString();
  updateDiscussion(discussion.id, {
    status: "stopped",
    buildStopReason: "blocked",
    buildStoppedAt: now,
    updatedAt: now,
  });
  emit({
    type: "build_stopped",
    reason: "blocked",
    message: `Architect provider handoff requires your selection: ${handoff.candidateRuntimeIds.join(", ")}`,
  });
}

/**
 * Runtime order is provider priority (index), and Runner V2 picks the plan critic and independent
 * verifier as the highest-priority model that is neither the Architect nor an accepted-change author.
 * An explicit reviewer is therefore configured right after the Architect and is never a worker, so it
 * stays independent of every change it reviews.
 */
export function selectNativeBuildRuntimes(
  modelIds: readonly string[],
  architectRuntimeId: string,
  reviewerRuntimeId?: string | null
): {
  configuredRuntimeIds: string[];
  workerRuntimeIds: string[];
  verifierRuntimeIds: string[];
} {
  const reviewer =
    reviewerRuntimeId && reviewerRuntimeId !== architectRuntimeId
      ? reviewerRuntimeId
      : null;
  const workers = [
    ...new Set(
      modelIds.filter(
        (runtimeId) => runtimeId !== architectRuntimeId && runtimeId !== reviewer
      )
    ),
  ];
  if (workers.length === 0) workers.push(architectRuntimeId);
  const configuredRuntimeIds = [
    ...new Set([architectRuntimeId, ...(reviewer ? [reviewer] : []), ...workers]),
  ];
  return {
    configuredRuntimeIds,
    workerRuntimeIds: workers,
    verifierRuntimeIds: [...configuredRuntimeIds],
  };
}

function emitVerifierSelectionPause(
  discussion: Discussion,
  selection: Extract<NativeBuildPauseGate, { kind: "verifier_selection" }>,
  emit: Emit,
): void {
  emit({
    type: "verifier_selection_required",
    requiredSequence: selection.requiredSequence,
    reason: selection.reason,
    requiredCapabilities: [...selection.requiredCapabilities],
    candidateRuntimeIds: [...selection.candidateRuntimeIds],
  });
  const now = new Date().toISOString();
  updateDiscussion(discussion.id, {
    status: "stopped",
    buildStopReason: "blocked",
    buildStoppedAt: now,
    updatedAt: now,
  });
  emit({
    type: "build_stopped",
    reason: "blocked",
    message:
      "Independent verification requires your selection before the exact revision can be approved.",
  });
}

function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, milliseconds);
    const abort = () => {
      window.clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      reject(abortError());
    };
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
  });
}

export function createNativeProviderConfig(
  runtimeId: string,
  priority: number,
  reasoningEffort?: string | null
): NativeProviderConfig {
  const settings = getUserSettings();
  // A role at a second reasoning effort runs the same model under `model#effort`.
  const modelRef = runtimeModelId(runtimeId);
  const { providerId, model } = parseModelId(modelRef);
  const pricing = nativePricingMicros(
    getModelPricing(
      modelRef,
      settings.modelPricingOverrides,
      settings.discoveredModelMetadata,
    )
  );
  if (providerId === "custom") {
    const custom = getCustomModelById(model);
    if (!custom) throw new Error(`Custom model ${model} is not configured.`);
    return {
      runtimeId,
      providerId,
      modelId: custom.model,
      displayName: custom.label,
      billingBasis: nativeProviderBillingBasis({
        hasApiPricing:
          pricing.inputCostMicrosPerMillion !== undefined &&
          pricing.outputCostMicrosPerMillion !== undefined,
        accountSubscription: false,
      }),
      transport: "openai-compatible",
      baseUrl: custom.baseURL,
      secret: custom.apiKey || "aiboard-local-endpoint",
      capabilities: ["*"],
      inputCapabilities: nativeInputCapabilities(custom.capabilities),
      priority,
      ...pricing,
    };
  }
  const saved = getProviderKey(providerId);
  const definition = getProviderDefinition(providerId);
  if (!saved?.enabled || !saved.apiKey) {
    throw new Error(`Provider ${providerId} is not configured.`);
  }
  const native = resolveNativeProviderTransport(
    providerId,
    saved.baseURL ?? undefined,
    saved.runnerToken ?? undefined,
    Boolean(definition?.accountRunner)
  );
  const catalogModel = MODEL_CATALOG.find(
    (candidate) => candidate.providerId === providerId && candidate.id === model
  );
  const discoveredMetadata = getDiscoveredModelMetadata(modelRef);
  const inputCapabilities = discoveredMetadata ?? catalogModel?.capabilities ?? {
    image: false,
    document: false,
    audio: false,
    video: false,
  };
  const resolvedFunctionTools = resolveProviderCapabilityProfile({
    providerId,
    modelId: model,
    catalogEvidence: getPersistedProviderCapabilityEvidence(providerId, model),
  }).capabilities.function_calling;
  return {
    runtimeId,
    providerId,
    modelId: model,
    ...(catalogModel?.name ? { displayName: catalogModel.name } : {}),
    billingBasis: nativeProviderBillingBasis({
      hasApiPricing:
        pricing.inputCostMicrosPerMillion !== undefined &&
        pricing.outputCostMicrosPerMillion !== undefined,
      accountSubscription: Boolean(definition?.accountRunner),
    }),
    transport: native.transport,
    ...(native.baseUrl ? { baseUrl: native.baseUrl } : {}),
    secret: saved.apiKey,
    ...(native.transport === "account-runner" && saved.runnerToken
      ? { runnerToken: saved.runnerToken }
      : {}),
    // Native coding agents can use the task-scoped tool registry regardless of
    // the descriptive labels the Architect chooses for a task.
    capabilities: ["*"],
    inputCapabilities: nativeInputCapabilities(inputCapabilities),
    ...(providerId === "openrouter"
      ? {
          supportsTools:
            resolvedFunctionTools?.descriptor.support === "supported" &&
            resolvedFunctionTools.readiness.status === "available",
          hostedTools: [
            { type: "web_search" as const },
            { type: "web_fetch" as const },
            { type: "datetime" as const },
          ],
        }
      : {}),
    priority,
    ...pricing,
    ...(reasoningEffort && reasoningEffort !== "default"
      ? { reasoningEffort }
      : {}),
    ...(native.transport === "openai-compatible"
      ? { protocol: nativeProviderProtocol(providerId, model) }
      : {}),
  };
}

function nativeInputCapabilities(capabilities: {
  image?: boolean;
  document?: boolean;
  audio?: boolean;
  video?: boolean;
} | undefined): NonNullable<NativeProviderConfig["inputCapabilities"]> {
  return {
    image: capabilities?.image === true,
    document: capabilities?.document === true,
    audio: capabilities?.audio === true,
    video: capabilities?.video === true,
  };
}

export function nativePricingMicros(
  pricing: ModelPricing | null
): Pick<
  NativeProviderConfig,
  | "inputCostMicrosPerMillion"
  | "outputCostMicrosPerMillion"
  | "cachedInputCostMicrosPerMillion"
  | "cacheWriteInputCostMicrosPerMillion"
> {
  if (!pricing) return {};
  const input = usdToMicros(pricing.inputUsdPer1M);
  return {
    inputCostMicrosPerMillion: input,
    outputCostMicrosPerMillion: usdToMicros(pricing.outputUsdPer1M),
    ...(pricing.cachedInputUsdPer1M === undefined
      ? {}
      : { cachedInputCostMicrosPerMillion: usdToMicros(pricing.cachedInputUsdPer1M) }),
    // The pricing catalog currently has no separate cache-write field. Use
    // normal input pricing instead of pretending cache creation is free.
    cacheWriteInputCostMicrosPerMillion: input,
  };
}

function usdToMicros(usd: number): number {
  return Math.round(usd * 1_000_000);
}

export function nativeProviderProtocol(
  providerId: string,
  _modelId: string
): "chat-completions" | "responses" {
  return providerId === "openai" || providerId === "openrouter"
    ? "responses"
    : "chat-completions";
}

export function resolveNativeProviderTransport(
  providerId: string,
  baseUrl?: string,
  runnerToken?: string,
  accountRunner = false
): Pick<NativeProviderConfig, "transport" | "baseUrl"> {
  if (accountRunner || runnerToken) {
    if (!baseUrl) throw new Error(`Provider ${providerId} has no account-runner URL.`);
    return { transport: "account-runner", baseUrl };
  }
  if (providerId === "anthropic" || providerId === "foundry") {
    return { transport: "anthropic", ...(baseUrl ? { baseUrl } : {}) };
  }
  if (providerId === "google") {
    return { transport: "google", ...(baseUrl ? { baseUrl } : {}) };
  }
  const resolvedBaseUrl = baseUrl ?? ({
    openai: "https://api.openai.com/v1",
    deepseek: "https://api.deepseek.com",
    openrouter: "https://openrouter.ai/api/v1",
    xai: "https://api.x.ai/v1",
  } as Record<string, string>)[providerId];
  if (!resolvedBaseUrl) {
    throw new Error(`Provider ${providerId} needs an OpenAI-compatible base URL.`);
  }
  return { transport: "openai-compatible", baseUrl: resolvedBaseUrl };
}

function buildObjective(discussion: Discussion): string {
  const notes = getMessagesForDiscussion(discussion.id)
    .filter((message) => message.role === "user" && !message.id.startsWith("native-message:"))
    .map((message) => message.content.trim())
    .filter(Boolean);
  const text = notes.length > 0
    ? `${discussion.topic.trim()}\n\nUser follow-up guidance:\n${notes.map((note) => `- ${note}`).join("\n")}`
    : discussion.topic.trim();
  const ids: string[] = discussion.attachmentIds ? JSON.parse(discussion.attachmentIds) : [];
  const attachments = loadAttachmentPayloads(ids);
  const unsupported = attachments.find((file) =>
    file.category !== "text_inline" && file.category !== "image" &&
    !(file.category === "document" && file.mimeType === "application/pdf"));
  if (unsupported) {
    throw new Error(`Native Build cannot deliver ${unsupported.filename} (${unsupported.category}) to the Architect yet. Remove this attachment or provide its contents as text.`);
  }
  const attachmentText = initialNativeBuildTextAttachments(attachments);
  return attachmentText ? `${text}\n\n${attachmentText}` : text;
}

function emitTaskProjection(projection: NativeBuildProjection, emit: Emit): void {
  const verificationState = (task: NativeBuildProjection["tasks"][string]) => {
    if (task.kind !== "final_verification") return { kind: task.kind };
    const current = projection.finalVerification?.current;
    return {
      kind: task.kind,
      ...(current && current.taskId === task.id ? { generation: {
        categories: (current.completedChecks ?? []).map((check) => ({ status: check.green ? "passed" : "failed" })),
        cleanup: { status: current.cleanup?.status ?? "pending" },
        review: { status: current.review?.status ?? "pending" },
        repairs: (current.repairTaskIds ?? []).map((taskId) => ({ status: projection.tasks[taskId]?.status ?? "missing" })),
      } } : {}),
    };
  };
  emit({
    type: "build_plan",
    cycle: projection.planRevision,
    tasks: Object.values(projection.tasks).map((task) => ({
      id: task.id,
      title: task.objective,
      status: nativeBuildTaskStatus(task.status, verificationState(task)),
      kind: task.kind,
    })),
  });
  for (const task of Object.values(projection.tasks)) {
    emit({
      type: "task_status",
      taskId: task.id,
      title: task.objective,
      status: nativeBuildTaskStatus(task.status, verificationState(task)),
      kind: task.kind,
      worker: task.assignedWorkerId,
      cycle: projection.planRevision,
    });
  }
}

function emitSchedulerEvent(event: NativeBuildEvent, emit: Emit): void {
  const actor = `${event.actor.role} ${event.actor.id}`;
  emit({
    type: "diagnostic",
    phase: event.actor.role === "architect" ? "judging" : "model_streaming",
    message: `${actor}: ${event.type}${eventSummary(event)}`,
  });
}

function eventSummary(event: NativeBuildEvent): string {
  const taskId = typeof event.payload.taskId === "string" ? event.payload.taskId : undefined;
  const status = typeof event.payload.status === "string" ? event.payload.status : undefined;
  return taskId ? ` — ${taskId}${status ? ` → ${status}` : ""}` : "";
}

function completionSummary(events: NativeBuildEvent[]): string | undefined {
  const completed = [...events].reverse().find(
    (event) => event.type === "project.handoff_requested" || event.type === "run.completed"
  );
  return typeof completed?.payload.summary === "string"
    ? completed.payload.summary
    : undefined;
}

function emitProjectHandoffPause(
  discussion: Discussion,
  projection: NativeBuildProjection,
  emit: Emit
): void {
  const handoff = projection.projectHandoff;
  if (!handoff || handoff.status !== "requested") return;
  emit({
    type: "project_handoff_required",
    summary: handoff.summary,
    options: [...handoff.options],
  });
  const now = new Date().toISOString();
  updateDiscussion(discussion.id, {
    status: "stopped",
    buildStopReason: "blocked",
    buildStoppedAt: now,
    updatedAt: now,
  });
  emit({
    type: "build_stopped",
    reason: "blocked",
    message: "The Architect finished. Choose how Runner V2 should hand the integrated result back to the project.",
  });
}

function finalizeNativeBuild(
  discussion: Discussion,
  summary: string | undefined,
  emit: Emit
): void {
  const answer = summary ?? "Build completed by the Architect.";
  const now = new Date().toISOString();
  insertFinalResult({
    discussionId: discussion.id,
    answer,
    confidence: 1,
    dissent: "[]",
    createdAt: now,
  });
  updateDiscussion(discussion.id, {
    status: "completed",
    buildStopReason: "completed",
    buildStoppedAt: now,
    updatedAt: now,
  });
  emit({ type: "final_answer", answer, confidence: 1, dissent: [] });
  emit({ type: "diagnostic", phase: "finished", message: "Native Build completed" });
  emit({ type: "complete" });
}

function abortError(): Error {
  const error = new Error("Native Build aborted.");
  error.name = "AbortError";
  return error;
}
