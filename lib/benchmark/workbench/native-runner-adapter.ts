import type {
  BenchmarkArtifact,
  BenchmarkModelCallTrace,
  BenchmarkTeamComposition,
  BenchmarkToolCallTrace,
} from "@/lib/benchmark/types";
import { createJsonArtifact } from "@/lib/benchmark/artifacts";
import type { CertifiedRunContext } from "@/lib/benchmark/certified/run-context";
import {
  startManagedAttemptRunner,
  restoreManagedAttemptOracle,
  stopManagedAttemptRunner,
  type ManagedAttemptRunnerResult,
} from "@/lib/client/bench-runner";
import { createNativeProviderConfig } from "@/lib/client/native-build-engine";
import type {
  NativeBuildAuditExport,
  NativeBuildObservability,
  NativeBuildProjection,
  NativeBuildUsageProjection,
  NativeProviderConfig,
  NativeRunProjection,
  NativeRunnerConnection,
} from "@/lib/client/runner-v2";
import {
  commandNativeRun,
  configureNativeProviders,
  createNativeBuild,
  getNativeBuild,
  getNativeBuildAudit,
  getNativeRun,
  getNativeRunnerHealth,
  selectNativeArchitectHandoff,
  selectNativeProjectHandoff,
} from "@/lib/client/runner-v2";
import type { SelectedModel } from "@/lib/providers/base";
import type { WorkBenchBuildAdapterInput } from "./build-adapter";
import type { WorkBenchBuildExecutionResult } from "./types";

const WORKBENCH_HIDDEN_PATHS = [
  "case-meta.json",
  "negative-control.json",
  "reference-solution.md",
  ".bench-run.json",
];
const WORKBENCH_PROTECTED_PATHS = [
  ...WORKBENCH_HIDDEN_PATHS,
  "verifier.mjs",
  "verifier-result.json",
];

export interface NativeWorkBenchBuildInput extends WorkBenchBuildAdapterInput {
  context: CertifiedRunContext;
  models: SelectedModel[];
  teamComposition?: BenchmarkTeamComposition;
}

export interface NativeWorkBenchDependencies {
  startManagedAttemptRunner: typeof startManagedAttemptRunner;
  restoreManagedAttemptOracle: typeof restoreManagedAttemptOracle;
  stopManagedAttemptRunner: typeof stopManagedAttemptRunner;
  getNativeRunnerHealth: typeof getNativeRunnerHealth;
  createProviderConfigs: (
    runtimeIds: readonly string[],
    reasoningEffort?: string
  ) => NativeProviderConfig[];
  configureNativeProviders: typeof configureNativeProviders;
  createNativeBuild: typeof createNativeBuild;
  commandNativeRun: typeof commandNativeRun;
  getNativeRun: typeof getNativeRun;
  getNativeBuild: typeof getNativeBuild;
  selectNativeArchitectHandoff: typeof selectNativeArchitectHandoff;
  selectNativeProjectHandoff: typeof selectNativeProjectHandoff;
  getNativeBuildAudit: typeof getNativeBuildAudit;
  wait: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
}

export class NativeWorkBenchExecutionError extends Error {
  constructor(
    message: string,
    readonly runnerProjectPath: string,
    readonly runnerStatePath: string,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = "NativeWorkBenchExecutionError";
  }
}

const DEFAULT_DEPENDENCIES: NativeWorkBenchDependencies = {
  startManagedAttemptRunner,
  restoreManagedAttemptOracle,
  stopManagedAttemptRunner,
  getNativeRunnerHealth,
  createProviderConfigs: (runtimeIds, reasoningEffort) =>
    runtimeIds.map((runtimeId, index) =>
      createNativeProviderConfig(runtimeId, index, reasoningEffort)
    ),
  configureNativeProviders,
  createNativeBuild,
  commandNativeRun,
  getNativeRun,
  getNativeBuild,
  selectNativeArchitectHandoff,
  selectNativeProjectHandoff,
  getNativeBuildAudit,
  wait: waitFor,
};

export async function runNativeWorkBenchBuild(
  input: NativeWorkBenchBuildInput,
  dependencies: NativeWorkBenchDependencies = DEFAULT_DEPENDENCIES
): Promise<WorkBenchBuildExecutionResult> {
  const startedMs = Date.now();
  let managed: ManagedAttemptRunnerResult | undefined;
  let audit: NativeBuildAuditExport | undefined;
  try {
    throwIfAborted(input.signal);
    managed = await dependencies.startManagedAttemptRunner(input.runner, {
      attemptId: input.attemptId,
    });
    if (!managed.running || !managed.url || !managed.token) {
      throw new Error("Bench Runner did not return a live managed Runner V2 connection.");
    }
    const connection: NativeRunnerConnection = {
      url: managed.url,
      token: managed.token,
    };
    const health = await dependencies.getNativeRunnerHealth(connection);
    if (health.projectPath !== managed.projectPath) {
      throw new Error("Managed Runner V2 project path does not match the prepared attempt.");
    }
    await dependencies.restoreManagedAttemptOracle(input.runner, {
      attemptId: input.attemptId,
    });
    const roleMapping = nativeWorkBenchRoles(input.teamComposition, input.models);
    const configuredRuntimeIds = uniqueStrings([
      roleMapping.architectRuntimeId,
      ...roleMapping.workerRuntimeIds,
    ]);
    if (!roleMapping.architectRuntimeId || roleMapping.workerRuntimeIds.length === 0) {
      throw new Error("WorkBench native execution requires an Architect and at least one worker runtime.");
    }
    await dependencies.configureNativeProviders(
      connection,
      dependencies.createProviderConfigs(configuredRuntimeIds)
    );
    const nativeRunId = safeNativeId(`workbench-${input.attemptId}`);
    const budgetLimits = nativeBudgetLimits(input);
    await dependencies.createNativeBuild(connection, {
      runId: nativeRunId,
      projectPath: managed.projectPath,
      permissionProfile: "full",
      idempotencyKey: `create:${nativeRunId}`,
      build: {
        projectId: input.attemptId,
        objective: workBenchObjective(input),
        architectRuntimeId: roleMapping.architectRuntimeId,
        workerRuntimeIds: roleMapping.workerRuntimeIds,
        maxConcurrency: Math.max(1, Math.min(4, roleMapping.workerRuntimeIds.length)),
        runPolicy: Object.keys(budgetLimits).length > 0 ? "budgeted" : "finish",
        budgetLimits,
        benchmark: {
          attemptId: input.attemptId,
          allowedCommands: [...input.allowedCommands],
          hiddenPaths: [...WORKBENCH_HIDDEN_PATHS],
          protectedPaths: [...WORKBENCH_PROTECTED_PATHS],
        },
      },
    });
    await dependencies.commandNativeRun(
      connection,
      nativeRunId,
      "start",
      `start:${nativeRunId}`
    );

    const eligibleRuntimes = new Set(configuredRuntimeIds);
    for (;;) {
      throwIfAborted(input.signal);
      const [run, projection] = await Promise.all([
        dependencies.getNativeRun(connection, nativeRunId),
        dependencies.getNativeBuild(connection, nativeRunId),
      ]);
      if (run.state === "failed" || run.state === "stopped") {
        throw new Error(`Managed Runner V2 Build terminated in state ${run.state}.`);
      }
      if (projection.status === "completed") break;
      if (projection.status === "paused") {
        if (projection.projectHandoff?.status === "requested") {
          await dependencies.selectNativeProjectHandoff(
            connection,
            nativeRunId,
            "apply_to_project",
            `workbench-project-handoff:${nativeRunId}`
          );
          break;
        }
        const handoff = projection.runtime.architect.handoff;
        if (handoff) {
          const runtimeId = handoff.candidateRuntimeIds.find((candidate) =>
            eligibleRuntimes.has(candidate)
          );
          if (!runtimeId) {
            throw new Error("Runner V2 requested an Architect handoff with no eligible in-team runtime.");
          }
          await dependencies.selectNativeArchitectHandoff(
            connection,
            nativeRunId,
            runtimeId,
            `workbench-architect-handoff:${nativeRunId}:${runtimeId}`
          );
          continue;
        }
        throw new Error("Runner V2 paused without a deterministic WorkBench handoff.");
      }
      await dependencies.wait(500, input.signal);
    }

    audit = await dependencies.getNativeBuildAudit(connection, nativeRunId);
    const traces = mapNativeUsageToBenchmarkTraces({
      attemptId: input.attemptId,
      runId: input.runId,
      caseId: input.case.id,
      usage: audit.usage,
    });
    const toolTraces = mapNativeToolsToBenchmarkTraces({
      attemptId: input.attemptId,
      caseId: input.case.id,
      tools: audit.observability.tools,
    });
    const auditArtifact = nativeAuditArtifact(input, audit);
    await Promise.all([
      ...traces.map((trace) => input.context.recordTrace(trace)),
      ...toolTraces.map((trace) => input.context.recordToolCall(trace)),
      input.context.recordArtifact(auditArtifact),
    ]);
    const lifetime = audit.usage.lifetime ?? audit.usage.effective;
    return {
      traceIds: traces.map((trace) => trace.id),
      artifactIds: [auditArtifact.id],
      costUsd: nativeCostUsd(audit.usage),
      inputTokens: lifetime.inputTokens,
      outputTokens: lifetime.outputTokens,
      modelCalls: traces.length,
      toolCalls: toolTraces.length,
      validToolCalls: toolTraces.filter((trace) => trace.status === "ok").length,
      durationMs: Math.max(0, Date.now() - startedMs),
      runnerProjectPath: managed.projectPath,
      runnerStatePath: managed.statePath,
    };
  } catch (error) {
    if (managed) {
      throw new NativeWorkBenchExecutionError(
        error instanceof Error ? error.message : String(error),
        managed.projectPath,
        managed.statePath,
        { cause: error }
      );
    }
    throw error;
  } finally {
    if (managed) {
      await dependencies.stopManagedAttemptRunner(input.runner, {
        attemptId: input.attemptId,
      });
    }
  }
}

export function mapNativeUsageToBenchmarkTraces(input: {
  attemptId: string;
  runId: string;
  caseId: string;
  usage: NativeBuildUsageProjection;
}): BenchmarkModelCallTrace[] {
  return Object.entries(input.usage.reservations)
    .filter(([, reservation]) =>
      reservation.kind === "model" &&
      reservation.status === "settled" &&
      Boolean(reservation.attribution)
    )
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([reservationId, reservation]) => {
      const attribution = reservation.attribution!;
      const actual = reservation.actual ?? {};
      const inputTokens = actual.inputTokens ?? 0;
      const outputTokens = actual.outputTokens ?? 0;
      const settledAt = reservation.settledAt ?? new Date(0).toISOString();
      const priced = reservation.costBasis?.kind === "api_estimate";
      const estimatedUsd = priced
        ? (actual.estimatedCostMicros ?? 0) / 1_000_000
        : null;
      return {
        id: `${input.attemptId}:native-model:${reservationId}`,
        runId: input.runId,
        caseId: input.caseId,
        attemptId: input.attemptId,
        modelId: attribution.runtimeId,
        providerId: attribution.providerId,
        participantId: `${attribution.role}:${attribution.sessionId}`,
        startedAt: settledAt,
        completedAt: settledAt,
        inputTokens,
        ...(actual.cachedInputTokens !== undefined
          ? { cachedInputTokens: actual.cachedInputTokens }
          : {}),
        ...(actual.cacheWriteInputTokens !== undefined
          ? { cacheWriteInputTokens: actual.cacheWriteInputTokens }
          : {}),
        outputTokens,
        totalTokens: inputTokens + outputTokens,
        usageSource: usageSource(reservation.tokenSources),
        ...(priced
          ? {
              providerCost: estimatedUsd!,
              providerCostUnit: "usd" as const,
            }
          : {}),
        estimatedUsd,
        retryHistory: [],
      };
    });
}

export function mapNativeToolsToBenchmarkTraces(input: {
  attemptId: string;
  caseId: string;
  tools: NativeBuildObservability["tools"];
}): BenchmarkToolCallTrace[] {
  return input.tools
    .filter((tool) => tool.status === "completed")
    .sort((left, right) => left.sequence - right.sequence)
    .map((tool) => ({
      id: `${input.attemptId}:native-tool:${tool.callId}`,
      attemptId: input.attemptId,
      caseId: input.caseId,
      toolName: tool.toolName,
      status: tool.isError ? "failed" : "ok",
      startedAt: tool.occurredAt,
      completedAt: tool.occurredAt,
      ...(tool.errorCode ? { error: tool.errorCode } : {}),
    }));
}

function usageSource(
  sources:
    | { inputTokens: "reported" | "estimated"; outputTokens: "reported" | "estimated" }
    | undefined
): BenchmarkModelCallTrace["usageSource"] {
  if (!sources) return "partial";
  if (sources.inputTokens === "reported" && sources.outputTokens === "reported") {
    return "reported";
  }
  if (sources.inputTokens === "estimated" && sources.outputTokens === "estimated") {
    return "estimated";
  }
  return "partial";
}

function nativeWorkBenchRoles(
  team: BenchmarkTeamComposition | undefined,
  models: SelectedModel[]
): { architectRuntimeId: string; workerRuntimeIds: string[] } {
  if (!team) {
    const runtimeIds = uniqueStrings(models.map((model) => model.modelId));
    const architectRuntimeId = runtimeIds[0] ?? "";
    return {
      architectRuntimeId,
      workerRuntimeIds: runtimeIds.filter((runtimeId) => runtimeId !== architectRuntimeId).length > 0
        ? runtimeIds.filter((runtimeId) => runtimeId !== architectRuntimeId)
        : architectRuntimeId
          ? [architectRuntimeId]
          : [],
    };
  }
  const architect =
    team.roles.find((role) => role.role === "architect") ??
    team.roles.find((role) => role.role === "single") ??
    team.roles[0];
  const workers = team.roles.filter((role) => role.role === "worker");
  const workerRuntimeIds = uniqueStrings(
    (workers.length > 0 ? workers : architect ? [architect] : []).map(
      (role) => role.modelId
    )
  );
  return {
    architectRuntimeId: architect?.modelId ?? "",
    workerRuntimeIds,
  };
}

function nativeBudgetLimits(input: NativeWorkBenchBuildInput): {
  maxModelCalls?: number;
  maxToolCalls?: number;
  maxInputTokens?: number;
  maxOutputTokens?: number;
  maxActiveMs?: number;
} {
  const budget = input.case.budget;
  return {
    ...(budget.maxModelCalls ? { maxModelCalls: budget.maxModelCalls } : {}),
    ...(budget.maxToolCalls ? { maxToolCalls: budget.maxToolCalls } : {}),
    ...(budget.maxInputTokens ? { maxInputTokens: budget.maxInputTokens } : {}),
    ...(budget.maxOutputTokens ? { maxOutputTokens: budget.maxOutputTokens } : {}),
    ...(budget.maxWallClockSeconds
      ? { maxActiveMs: budget.maxWallClockSeconds * 1_000 }
      : {}),
  };
}

function workBenchObjective(input: NativeWorkBenchBuildInput): string {
  return [
    `Certified WorkBench case: ${input.case.title}`,
    input.case.description,
    input.case.prompt.userRequest,
    input.case.prompt.publicContext,
    "Modify only the prepared fixture. The deterministic verifier decides correctness.",
  ]
    .filter(Boolean)
    .join("\n\n");
}

function nativeAuditArtifact(
  input: NativeWorkBenchBuildInput,
  audit: NativeBuildAuditExport
): BenchmarkArtifact {
  return createJsonArtifact({
    id: `${input.attemptId}:runner-v2-audit`,
    runId: input.runId,
    attemptId: input.attemptId,
    caseId: input.case.id,
    label: "Runner V2 audit",
    content: audit,
  });
}

function nativeCostUsd(usage: NativeBuildUsageProjection): number | null {
  const hasApiCost = usage.models?.some(
    (model) => model.calls > 0 && model.costBasis === "api_estimate"
  );
  if (!hasApiCost) return null;
  return (usage.lifetime ?? usage.effective).estimatedCostMicros / 1_000_000;
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function safeNativeId(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "-").slice(0, 120);
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  const error = new Error("Native WorkBench execution aborted.");
  error.name = "AbortError";
  throw error;
}

function waitFor(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolveWait, rejectWait) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolveWait();
    }, milliseconds);
    const abort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      const error = new Error("Native WorkBench execution aborted.");
      error.name = "AbortError";
      rejectWait(error);
    };
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
  });
}
