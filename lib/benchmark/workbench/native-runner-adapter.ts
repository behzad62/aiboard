import type {
  BenchmarkArtifact,
  BenchmarkModelCallTrace,
  BenchmarkTeamComposition,
  BenchmarkToolCallTrace,
  CertifiedAttemptStatus,
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
  NativeBuildUsageProjection,
  NativeProviderConfig,
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
    options?: ErrorOptions & {
      certifiedStatus?: CertifiedAttemptStatus;
      certifiedCode?: string;
      buildResult?: Partial<WorkBenchBuildExecutionResult>;
    }
  ) {
    super(message, options);
    this.name = "NativeWorkBenchExecutionError";
    this.certifiedStatus = options?.certifiedStatus;
    this.certifiedCode = options?.certifiedCode;
    this.buildResult = options?.buildResult;
  }

  readonly certifiedStatus?: CertifiedAttemptStatus;
  readonly certifiedCode?: string;
  readonly buildResult?: Partial<WorkBenchBuildExecutionResult>;
}

class NativeWorkBenchRunFailure extends Error {
  constructor(
    readonly certifiedStatus: CertifiedAttemptStatus,
    readonly certifiedCode: string,
    message: string
  ) {
    super(message);
    this.name = "NativeWorkBenchRunFailure";
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
  let connection: NativeRunnerConnection | undefined;
  let nativeRunId: string | undefined;
  try {
    throwIfAborted(input.signal);
    managed = await dependencies.startManagedAttemptRunner(input.runner, {
      attemptId: input.attemptId,
    });
    if (!managed.running || !managed.url || !managed.token) {
      throw new Error("Bench Runner did not return a live managed Runner V2 connection.");
    }
    connection = {
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
    nativeRunId = safeNativeId(`workbench-${input.attemptId}`);
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
          allowedCommands: uniqueStrings([...input.allowedCommands, "git diff --check"]),
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
    const continuationCounts = new Map<string, number>();
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
        const disposition = nativePauseDisposition(projection.pauseReason?.reason);
        const continuationCount = continuationCounts.get(disposition.key) ?? 0;
        if (disposition.action === "continue" && continuationCount < disposition.limit) {
          continuationCounts.set(disposition.key, continuationCount + 1);
          await dependencies.commandNativeRun(
            connection,
            nativeRunId,
            "continue",
            `workbench-auto-continue:${nativeRunId}:${disposition.key}:${continuationCount + 1}`
          );
          continue;
        }
        throw new NativeWorkBenchRunFailure(
          disposition.certifiedStatus,
          disposition.certifiedCode,
          disposition.message
        );
      }
      await dependencies.wait(500, input.signal);
    }

    audit = await dependencies.getNativeBuildAudit(connection, nativeRunId);
    return await recordNativeAudit(input, audit, managed, startedMs);
  } catch (error) {
    if (managed) {
      let buildResult: Partial<WorkBenchBuildExecutionResult> | undefined;
      if (connection && nativeRunId) {
        try {
          audit ??= await dependencies.getNativeBuildAudit(connection, nativeRunId);
          buildResult = nativeAuditResult(input, audit, managed, startedMs);
          try {
            await recordNativeAudit(input, audit, managed, startedMs);
          } catch {
            // The original Runner failure stays authoritative; audit-derived metrics remain attached.
          }
        } catch {
          // Preserve the original failure when the Runner audit itself is unavailable.
        }
      }
      const metadata = nativeFailureMetadata(error);
      throw new NativeWorkBenchExecutionError(
        error instanceof Error ? error.message : String(error),
        managed.projectPath,
        managed.statePath,
        {
          cause: error,
          ...(metadata.certifiedStatus
            ? { certifiedStatus: metadata.certifiedStatus }
            : {}),
          ...(metadata.certifiedCode ? { certifiedCode: metadata.certifiedCode } : {}),
          ...(buildResult ? { buildResult } : {}),
        }
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

interface NativePauseDisposition {
  action: "continue" | "fail";
  key: string;
  limit: number;
  certifiedStatus: CertifiedAttemptStatus;
  certifiedCode: string;
  message: string;
}

export function nativePauseDisposition(reason: string | undefined): NativePauseDisposition {
  const normalized = reason?.trim() ?? "";
  if (normalized.startsWith("budget_exhausted:")) {
    return pauseFailure("failed_budget", "budget_exhausted", normalized);
  }
  if (normalized === "task_attempt_budget") {
    return pauseFailure("failed_budget", "task_attempt_budget", normalized);
  }
  if (normalized.startsWith("protocol_error:")) {
    const protocolCode = nativeProtocolErrorCode(normalized);
    if (protocolCode === "invalid_provider_turn") {
      return pauseFailure("failed_model", protocolCode, normalized);
    }
    if (protocolCode !== "invalid_lifecycle_batch") {
      return pauseFailure("failed_tool_use", protocolCode, normalized);
    }
    return {
      action: "continue",
      key: "protocol-repair",
      limit: 1,
      certifiedStatus: "failed_tool_use",
      certifiedCode: "invalid_lifecycle_batch",
      message: `Runner V2 lifecycle protocol repair was exhausted: ${normalized}`,
    };
  }
  if (
    normalized.startsWith("model_ended_without_lifecycle:") ||
    normalized.startsWith("worker_model_ended_without_lifecycle")
  ) {
    return {
      action: "continue",
      key: "model-lifecycle-repair",
      limit: 2,
      certifiedStatus: "failed_model",
      certifiedCode: "model_ended_without_lifecycle",
      message: `Model did not produce a lifecycle decision after bounded recovery: ${normalized}`,
    };
  }
  if (normalized === "autonomous_pump_error") {
    return {
      action: "continue",
      key: "autonomous-pump-recovery",
      limit: 4,
      certifiedStatus: "invalid_harness",
      certifiedCode: "autonomous_pump_error",
      message: "Runner V2 autonomous pump remained paused after bounded recovery.",
    };
  }
  if (normalized.startsWith("provider_error:")) {
    return pauseFailure("provider_unavailable", "provider_unavailable", normalized);
  }
  if (/^(max_tokens|turn_limit|read_only_stall|repeated_evidence_failure):/.test(normalized)) {
    return pauseFailure("failed_model", "model_lifecycle_failed", normalized);
  }
  return pauseFailure(
    "invalid_harness",
    normalized ? "unrecognized_runner_pause" : "runner_pause_reason_missing",
    normalized || "Runner V2 paused without a structured reason."
  );
}

function nativeProtocolErrorCode(reason: string): string {
  const code = reason.slice("protocol_error:".length).split(":", 1)[0]?.trim();
  if (code === "invalid_lifecycle_batch") return code;
  if (code === "duplicate_call_id") return code;
  if (code === "invalid_call_id") return code;
  if (code === "invalid_provider_turn") return code;
  if (/lifecycle tool call must be the only tool call/i.test(reason)) {
    return "invalid_lifecycle_batch";
  }
  return "protocol_error";
}

function pauseFailure(
  certifiedStatus: CertifiedAttemptStatus,
  certifiedCode: string,
  reason: string
): NativePauseDisposition {
  return {
    action: "fail",
    key: certifiedCode,
    limit: 0,
    certifiedStatus,
    certifiedCode,
    message: `Runner V2 paused: ${reason}`,
  };
}

function nativeFailureMetadata(error: unknown): {
  certifiedStatus?: CertifiedAttemptStatus;
  certifiedCode?: string;
} {
  if (error instanceof NativeWorkBenchRunFailure) {
    return {
      certifiedStatus: error.certifiedStatus,
      certifiedCode: error.certifiedCode,
    };
  }
  if (error instanceof NativeWorkBenchExecutionError) {
    return {
      certifiedStatus: error.certifiedStatus,
      certifiedCode: error.certifiedCode,
    };
  }
  return {};
}

async function recordNativeAudit(
  input: NativeWorkBenchBuildInput,
  audit: NativeBuildAuditExport,
  managed: ManagedAttemptRunnerResult,
  startedMs: number
): Promise<WorkBenchBuildExecutionResult> {
  const result = nativeAuditResult(input, audit, managed, startedMs);
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
  return result;
}

function nativeAuditResult(
  input: NativeWorkBenchBuildInput,
  audit: NativeBuildAuditExport,
  managed: ManagedAttemptRunnerResult,
  startedMs: number
): WorkBenchBuildExecutionResult {
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
    "Create exactly one implementation task that performs the requested edit and its task-level evidence; do not split inspection, editing, verification, or completion into separate tasks.",
    "For task-level durable evidence, run exactly `git diff --check`; the official WorkBench verifier runs after integration.",
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
