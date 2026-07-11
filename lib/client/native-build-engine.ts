import type { Discussion, EffortLevel } from "@/lib/db/schema";
import type { OrchestratorEvent } from "@/lib/orchestrator/engine";
import { parseModelId } from "@/lib/providers/base";
import { getProviderDefinition } from "@/lib/providers/provider-registry";
import {
  getMessagesForDiscussion,
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
  getNativeRun,
  getNativeRunnerHealth,
  stepNativeBuild,
  type NativeBuildEvent,
  type NativeBuildProjection,
  type NativeProviderConfig,
  type NativeRunnerConnection,
} from "./runner-v2";

type Emit = (event: OrchestratorEvent) => void;

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
    permissionProfile: discussion.runnerAccess === "full" ? "full" : "guarded",
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
  if (run.state === "created") {
    await commandNativeRun(connection, runId, "start", `start:${runId}`);
  } else if (run.state === "paused") {
    const pausedProjection = await getNativeBuild(connection, runId);
    if (pausedProjection.projectHandoff?.status === "requested") {
      emitProjectHandoffPause(discussion, pausedProjection, emit);
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
  try {
    for (;;) {
      if (signal.aborted) throw abortError();
      const observed = await observeNativeStep(connection, runId, cursor, emit, signal);
      const result = observed.result;
      const events = observed.events;
      cursor = observed.cursor;
      const projection = await getNativeBuild(connection, runId);
      emitTaskProjection(projection, emit);
      if (result.status === "completed" || projection.status === "completed") {
        finalizeNativeBuild(
          discussion,
          completionSummary(events) ?? completionSummary(
            await getNativeBuildEvents(connection, runId, 0)
          ),
          emit
        );
        return;
      }
      if (result.status === "paused" || projection.status === "paused") {
        await pauseSupervisor(connection, runId);
        if (projection.projectHandoff?.status === "requested") {
          emitProjectHandoffPause(discussion, projection, emit);
          return;
        }
        const handoff = projection.runtime.architect.handoff;
        const message = handoff
          ? `Architect provider handoff requires your selection: ${handoff.candidateRuntimeIds.join(", ")}`
          : "Native Build paused safely; resume after resolving the reported blocker.";
        if (handoff) {
          emit({
            type: "architect_handoff_required",
            reason: handoff.reason,
            candidateRuntimeIds: [...handoff.candidateRuntimeIds],
          });
        }
        const now = new Date().toISOString();
        updateDiscussion(discussion.id, {
          status: "stopped",
          buildStopReason: "blocked",
          buildStoppedAt: now,
          updatedAt: now,
        });
        emit({ type: "build_stopped", reason: "blocked", message });
        return;
      }
      if (result.status === "idle") {
        throw new Error("Native Build made no mechanical progress and stopped to avoid wasting model calls.");
      }
    }
  } catch (error) {
    if (signal.aborted || (error instanceof Error && error.name === "AbortError")) {
      await pauseSupervisor(connection, runId).catch(() => undefined);
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
    await pauseSupervisor(connection, runId).catch(() => undefined);
    throw error;
  }
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

async function observeNativeStep(
  connection: NativeRunnerConnection,
  runId: string,
  initialCursor: number,
  emit: Emit,
  signal: AbortSignal
): Promise<{
  result: Awaited<ReturnType<typeof stepNativeBuild>>;
  cursor: number;
  events: NativeBuildEvent[];
}> {
  const step = stepNativeBuild(connection, runId, signal);
  let cursor = initialCursor;
  const collected: NativeBuildEvent[] = [];
  for (;;) {
    const outcome = await Promise.race([
      step.then(
        (result) => ({ done: true as const, result }),
        (error: unknown) => ({ done: true as const, error })
      ),
      delay(750, signal).then(() => ({ done: false as const })),
    ]);
    const events = await getNativeBuildEvents(connection, runId, cursor);
    for (const event of events) {
      cursor = Math.max(cursor, event.sequence);
      collected.push(event);
      emitSchedulerEvent(event, emit);
    }
    emitTaskProjection(await getNativeBuild(connection, runId), emit);
    if (!outcome.done) continue;
    if ("error" in outcome) throw outcome.error;
    return { result: outcome.result, cursor, events: collected };
  }
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
  const saved = getProviderKey(providerId);
  const definition = getProviderDefinition(providerId);
  if (!saved?.enabled || !saved.apiKey) {
    throw new Error(`Provider ${providerId} is not configured.`);
  }
  if (!definition?.accountRunner) {
    throw new Error(
      `Runner V2 currently requires an account-backed model; ${providerId}:${model} is not yet available in the native kernel.`
    );
  }
  if (!saved.baseURL) throw new Error(`Provider ${providerId} has no account-runner URL.`);
  return {
    runtimeId,
    providerId,
    modelId: model,
    transport: "account-runner",
    baseUrl: saved.baseURL,
    secret: saved.apiKey,
    ...(saved.runnerToken ? { runnerToken: saved.runnerToken } : {}),
    // Native coding agents can use the task-scoped tool registry regardless of
    // the descriptive labels the Architect chooses for a task.
    capabilities: ["*"],
    priority,
    ...(discussion.reasoningEffort && discussion.reasoningEffort !== "default"
      ? { reasoningEffort: discussion.reasoningEffort }
      : {}),
  };
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
      status: taskStatus(task.status),
    })),
  });
  for (const task of Object.values(projection.tasks)) {
    emit({
      type: "task_status",
      taskId: task.id,
      title: task.objective,
      status: taskStatus(task.status),
      worker: task.assignedWorkerId,
      cycle: projection.planRevision,
    });
  }
}

function taskStatus(status: string): "planned" | "in_progress" | "review" | "fixing" | "done" | "failed" {
  if (status === "planned") return "planned";
  if (["assigned", "running", "waiting_guidance"].includes(status)) return "in_progress";
  if (["submitted", "architect_review", "approved", "integrating"].includes(status)) return "review";
  if (["rejected", "integration_resolution"].includes(status)) return "fixing";
  if (["integrated", "cancelled"].includes(status)) return "done";
  return "failed";
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

async function pauseSupervisor(
  connection: NativeRunnerConnection,
  runId: string
): Promise<void> {
  const run = await getNativeRun(connection, runId);
  if (run.state === "running") {
    await commandNativeRun(connection, runId, "pause", `pause:${Date.now()}`, "user");
  }
}

function abortError(): Error {
  const error = new Error("Native Build aborted.");
  error.name = "AbortError";
  return error;
}
