import type { Discussion, EffortLevel } from "@/lib/db/schema";
import type { OrchestratorEvent } from "@/lib/orchestrator/engine";
import { parseModelId } from "@/lib/providers/base";
import { MODEL_CATALOG } from "@/lib/providers/catalog";
import { getProviderDefinition } from "@/lib/providers/provider-registry";
import {
  getMessagesForDiscussion,
  getCustomModelById,
  getProviderKey,
  insertFinalResult,
  updateDiscussion,
} from "./store";
import {
  commandNativeRun,
  configureNativeProviders,
  createNativeBuild,
  getNativeBuild,
  getNativeBuildEvents,
  getNativeBuildUsage,
  getNativePermissions,
  getNativeRun,
  getNativeRunnerHealth,
  type NativeBuildEvent,
  type NativeBuildProjection,
  type NativeProviderConfig,
  type NativeRunnerConnection,
} from "./runner-v2";
import {
  nativeBuildTaskStatus,
  nativeBuildUsageWindow,
} from "./discussion-live-state";

type Emit = (event: OrchestratorEvent) => void;

export type NativeBuildPauseGate =
  | { kind: "resume" }
  | { kind: "project_handoff" }
  | {
      kind: "architect_handoff";
      reason: string;
      candidateRuntimeIds: string[];
    };

export function nativeBuildPauseGate(
  projection: NativeBuildProjection
): NativeBuildPauseGate {
  if (projection.projectHandoff?.status === "requested") {
    return { kind: "project_handoff" };
  }
  const handoff = projection.runtime.architect.handoff;
  if (handoff) {
    return {
      kind: "architect_handoff",
      reason: handoff.reason,
      candidateRuntimeIds: [...handoff.candidateRuntimeIds],
    };
  }
  return { kind: "resume" };
}

export async function runNativeBuildDiscussion(
  discussion: Discussion,
  emit: Emit,
  signal: AbortSignal
): Promise<void> {
  if (!discussion.runnerUrl || !discussion.runnerToken) {
    throw new Error("Build mode requires a connected Runner V2 instance.");
  }
  const connection: NativeRunnerConnection = {
    url: discussion.runnerUrl,
    token: discussion.runnerToken,
  };
  const runId = discussion.nativeBuildRunId ?? `native-${crypto.randomUUID()}`;
  if (!discussion.nativeBuildRunId) {
    updateDiscussion(discussion.id, {
      nativeBuildRunId: runId,
      updatedAt: new Date().toISOString(),
    });
  }
  emit({ type: "status", status: "running" });
  emit({
    type: "diagnostic",
    phase: "initializing",
    message: "Connecting to the native Runner V2 agent kernel",
  });
  const health = await getNativeRunnerHealth(connection);
  if (health.nodeVersion !== "24.18.0") {
    throw new Error(`Runner V2 requires Node.js 24.18.0; connected runner uses ${health.nodeVersion}.`);
  }
  const modelIds = JSON.parse(discussion.modelIds) as string[];
  const architectRuntimeId = discussion.judgeModelId ?? modelIds[0];
  if (!architectRuntimeId) throw new Error("Build mode requires an Architect model.");
  const { configuredRuntimeIds, workerRuntimeIds } = selectNativeBuildRuntimes(
    modelIds,
    architectRuntimeId
  );
  await configureNativeProviders(
    connection,
    configuredRuntimeIds.map((runtimeId, index) =>
      providerConfig(runtimeId, discussion, index)
    )
  );
  const objective = buildObjective(discussion);
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
      maxConcurrency: Math.max(1, Math.min(4, workerRuntimeIds.length)),
      budgetLimits: buildBudgets(discussion.effort),
    },
  });
  const run = await getNativeRun(connection, runId);
  emit({
    type: "build_usage",
    usage: nativeBuildUsageWindow(
      await getNativeBuildUsage(connection, runId),
      run.createdAt
    ),
  });
  if (run.state === "created") {
    await commandNativeRun(connection, runId, "start", `start:${runId}`);
  } else if (run.state === "paused") {
    const pausedProjection = await getNativeBuild(connection, runId);
    const pauseGate = nativeBuildPauseGate(pausedProjection);
    if (pauseGate.kind === "project_handoff") {
      emitProjectHandoffPause(discussion, pausedProjection, emit);
      return;
    }
    if (pauseGate.kind === "architect_handoff") {
      emitArchitectHandoffPause(discussion, pauseGate, emit);
      return;
    }
    await commandNativeRun(connection, runId, "resume", `resume:${Date.now()}`);
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
        if (pauseGate.kind === "architect_handoff") {
          emitArchitectHandoffPause(discussion, pauseGate, emit);
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
          message: "Native Build paused safely; resume after resolving the reported blocker.",
        });
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

function emitArchitectHandoffPause(
  discussion: Discussion,
  handoff: Extract<NativeBuildPauseGate, { kind: "architect_handoff" }>,
  emit: Emit
): void {
  emit({
    type: "architect_handoff_required",
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

export function selectNativeBuildRuntimes(
  modelIds: readonly string[],
  architectRuntimeId: string
): {
  configuredRuntimeIds: string[];
  workerRuntimeIds: string[];
} {
  const workers = [
    ...new Set(modelIds.filter((runtimeId) => runtimeId !== architectRuntimeId)),
  ];
  if (workers.length === 0) workers.push(architectRuntimeId);
  return {
    configuredRuntimeIds: [...new Set([architectRuntimeId, ...workers])],
    workerRuntimeIds: workers,
  };
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

function providerConfig(
  runtimeId: string,
  discussion: Discussion,
  priority: number
): NativeProviderConfig {
  const { providerId, model } = parseModelId(runtimeId);
  if (providerId === "custom") {
    const custom = getCustomModelById(model);
    if (!custom) throw new Error(`Custom model ${model} is not configured.`);
    return {
      runtimeId,
      providerId,
      modelId: custom.model,
      transport: "openai-compatible",
      baseUrl: custom.baseURL,
      secret: custom.apiKey || "aiboard-local-endpoint",
      capabilities: ["*"],
      priority,
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
  return {
    runtimeId,
    providerId,
    modelId: model,
    transport: native.transport,
    ...(native.baseUrl ? { baseUrl: native.baseUrl } : {}),
    secret: saved.apiKey,
    ...(native.transport === "account-runner" && saved.runnerToken
      ? { runnerToken: saved.runnerToken }
      : {}),
    // Native coding agents can use the task-scoped tool registry regardless of
    // the descriptive labels the Architect chooses for a task.
    capabilities: ["*"],
    priority,
    ...(discussion.reasoningEffort && discussion.reasoningEffort !== "default"
      ? { reasoningEffort: discussion.reasoningEffort }
      : {}),
    ...(native.transport === "openai-compatible"
      ? { protocol: nativeProviderProtocol(providerId, model) }
      : {}),
  };
}

export function nativeProviderProtocol(
  providerId: string,
  modelId: string
): "chat-completions" | "responses" {
  return providerId === "openai" &&
    MODEL_CATALOG.some((model) =>
      model.providerId === "openai" && model.id === modelId && model.api === "responses"
    )
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
    .filter((message) => message.role === "user")
    .map((message) => message.content.trim())
    .filter(Boolean);
  return notes.length > 0
    ? `${discussion.topic.trim()}\n\nUser follow-up guidance:\n${notes.map((note) => `- ${note}`).join("\n")}`
    : discussion.topic.trim();
}

function buildBudgets(effort: EffortLevel) {
  if (effort === "low") return { maxModelCalls: 40, maxToolCalls: 500 };
  if (effort === "medium") return { maxModelCalls: 100, maxToolCalls: 1_500 };
  return { maxModelCalls: 200, maxToolCalls: 3_000 };
}

function emitTaskProjection(projection: NativeBuildProjection, emit: Emit): void {
  emit({
    type: "build_plan",
    cycle: projection.planRevision,
    tasks: Object.values(projection.tasks).map((task) => ({
      id: task.id,
      title: task.objective,
      status: nativeBuildTaskStatus(task.status),
    })),
  });
  for (const task of Object.values(projection.tasks)) {
    emit({
      type: "task_status",
      taskId: task.id,
      title: task.objective,
      status: nativeBuildTaskStatus(task.status),
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
