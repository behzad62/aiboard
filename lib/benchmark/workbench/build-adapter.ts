import type { BuildHooks } from "@/lib/client/legacy-build-engine.benchmark";
import { getBenchmarkTraces } from "@/lib/client/store";
import type { CertifiedRunContext } from "@/lib/benchmark/certified/run-context";
import type {
  BenchmarkToolCallTrace,
  BenchmarkModelCallTrace,
  BenchmarkTeamComposition,
  BenchmarkTeamCompositionRole,
} from "@/lib/benchmark/types";
import type { Discussion } from "@/lib/db/schema";
import type { OrchestratorEvent } from "@/lib/orchestrator/engine";
import type { SelectedModel } from "@/lib/providers/base";
import type {
  WorkBenchBuildExecutionInput,
  WorkBenchBuildExecutionResult,
} from "./types";

export interface WorkBenchBuildAdapterInput extends WorkBenchBuildExecutionInput {
  executeBuild?: (input: {
    benchmark: NonNullable<BuildHooks["benchmark"]>;
  }) => Promise<WorkBenchBuildExecutionResult>;
  context?: CertifiedRunContext;
  models?: SelectedModel[];
  teamComposition?: BenchmarkTeamComposition;
  discussion?: Partial<Discussion>;
  emit?: (event: OrchestratorEvent) => void;
  hooks?: Omit<BuildHooks, "benchmark">;
  signal?: AbortSignal;
  runBuildDiscussion?: RunBuildDiscussionFn;
  getBenchmarkTraces?: () => BenchmarkModelCallTrace[];
}

export function createWorkBenchBenchmarkHooks(
  input: WorkBenchBuildExecutionInput
): NonNullable<BuildHooks["benchmark"]> {
  return {
    attemptId: input.attemptId,
    runId: input.runId,
    caseId: input.case.id,
    harnessProfile: input.harnessProfile,
    noHumanApproval: true,
    runnerOnly: true,
    disableMcp: true,
    allowedCommands: input.allowedCommands,
  };
}

export type RunBuildDiscussionFn = (
  discussion: Discussion,
  models: SelectedModel[],
  emit: (event: OrchestratorEvent) => void,
  hooks?: BuildHooks,
  signal?: AbortSignal
) => Promise<void>;

export async function runWorkBenchBuild(
  input: WorkBenchBuildAdapterInput
): Promise<WorkBenchBuildExecutionResult> {
  if (!input.executeBuild) {
    return runWorkBenchBuildDiscussion(input);
  }
  return input.executeBuild({
    benchmark: createWorkBenchBenchmarkHooks(input),
  });
}

async function runWorkBenchBuildDiscussion(
  input: WorkBenchBuildAdapterInput
): Promise<WorkBenchBuildExecutionResult> {
  const models = input.models ?? [];
  if (models.length === 0) {
    throw new Error("runWorkBenchBuild requires at least one selected model.");
  }

  const startedMs = Date.now();
  const beforeTraceIds = new Set(readBenchmarkTraces(input).map((trace) => trace.id));
  const recording: Array<Promise<unknown>> = [];
  const toolCallIds = new Set<string>();
  const validToolCallIds = new Set<string>();
  const benchmark = createWorkBenchBenchmarkHooks(input);
  const hooks: BuildHooks = {
    ...input.hooks,
    benchmark: {
      ...benchmark,
      recordEvent: (event) => {
        if (input.context) recording.push(input.context.recordEvent(event));
      },
      recordToolCall: (trace) => {
        toolCallIds.add(trace.id);
        if (isValidWorkBenchToolCall(trace)) validToolCallIds.add(trace.id);
        if (input.context) recording.push(input.context.recordToolCall(trace));
      },
      reserveModelCall: (reservation) => {
        input.context?.reserveModelCall?.(reservation);
      },
      recordModelCallUsage: (usage) => {
        input.context?.recordModelCallUsage?.(usage);
      },
    },
  };
  const discussion = createWorkBenchBuildDiscussion(input, models);
  const runBuildDiscussion =
    input.runBuildDiscussion ?? (await loadRunBuildDiscussion());

  await runBuildDiscussion(
    discussion,
    models,
    (event) => {
      input.emit?.(event);
    },
    hooks,
    input.signal
  );

  const traces = readBenchmarkTraces(input).filter(
    (trace) =>
      !beforeTraceIds.has(trace.id) &&
      (trace.attemptId === input.attemptId ||
        trace.runId === input.runId ||
        trace.caseId === input.case.id)
  );
  if (input.context) {
    for (const trace of traces) {
      recording.push(input.context.recordTrace(trace));
    }
  }
  await Promise.allSettled(recording);

  return summarizeBuildDiscussionResult({
    traces,
    toolCalls: toolCallIds.size,
    validToolCalls: validToolCallIds.size,
    durationMs: Math.max(0, Date.now() - startedMs),
  });
}

function isValidWorkBenchToolCall(trace: BenchmarkToolCallTrace): boolean {
  if (trace.status === "ok") return true;
  return (
    trace.toolName === "run" &&
    trace.status === "failed" &&
    typeof trace.exitCode === "number" &&
    Number.isFinite(trace.exitCode)
  );
}

async function loadRunBuildDiscussion(): Promise<RunBuildDiscussionFn> {
  const engine = await import("@/lib/client/legacy-build-engine.benchmark");
  return engine.runBuildDiscussion;
}

function createWorkBenchBuildDiscussion(
  input: WorkBenchBuildAdapterInput,
  models: SelectedModel[]
): Discussion {
  const now = new Date().toISOString();
  const roleMapping = workBenchRoleMapping(input.teamComposition, models);
  const modelIds = roleMapping.workerModelIds;
  const runnerUrl = `${input.runner.url.replace(/\/$/, "")}/bench/compat/${encodeURIComponent(
    input.attemptId
  )}`;
  return {
    id: input.discussion?.id ?? `workbench-build-${input.attemptId}`,
    topic:
      input.discussion?.topic ??
      [
        `Certified WorkBench case: ${input.case.title}`,
        input.case.description,
        "",
        input.case.prompt.userRequest,
        input.case.prompt.publicContext ?? "",
        "",
        "Modify the prepared fixture workspace only. The deterministic verifier decides correctness.",
      ]
        .filter(Boolean)
        .join("\n"),
    mode: "build",
    effort: input.discussion?.effort ?? "low",
    status: input.discussion?.status ?? "pending",
    modelIds: input.discussion?.modelIds ?? JSON.stringify(modelIds),
    judgeModelId:
      input.discussion?.judgeModelId ?? roleMapping.architectModelId ?? modelIds[0] ?? null,
    reviewerModelId:
      input.discussion?.reviewerModelId ?? roleMapping.reviewerModelId ?? null,
    attachmentIds: input.discussion?.attachmentIds ?? null,
    projectFolderName: input.discussion?.projectFolderName ?? null,
    runnerUrl: input.discussion?.runnerUrl ?? runnerUrl,
    runnerToken: input.discussion?.runnerToken ?? input.runner.token,
    runnerAccess: "full",
    buildRunPolicy: input.discussion?.buildRunPolicy ?? "finish",
    buildSkillMode: input.discussion?.buildSkillMode ?? "safe",
    buildBudgetUsd: input.discussion?.buildBudgetUsd ?? input.case.budget.maxUsd ?? 0,
    buildTimeLimitMinutes:
      input.discussion?.buildTimeLimitMinutes ??
      (typeof input.case.budget.maxWallClockSeconds === "number"
        ? Math.max(1, Math.ceil(input.case.budget.maxWallClockSeconds / 60))
        : 0),
    buildStopReason: input.discussion?.buildStopReason ?? null,
    buildStoppedAt: input.discussion?.buildStoppedAt ?? null,
    currentRound: input.discussion?.currentRound ?? 0,
    maxRounds: input.discussion?.maxRounds ?? 1,
    convergenceScore: input.discussion?.convergenceScore ?? null,
    verbosity: input.discussion?.verbosity ?? "brief",
    styleNote: input.discussion?.styleNote ?? null,
    reasoningEffort: input.discussion?.reasoningEffort ?? "default",
    createdAt: input.discussion?.createdAt ?? now,
    updatedAt: input.discussion?.updatedAt ?? now,
  };
}

function workBenchRoleMapping(
  team: BenchmarkTeamComposition | undefined,
  models: SelectedModel[]
): {
  architectModelId: string | null;
  reviewerModelId: string | null;
  workerModelIds: string[];
} {
  if (!team) {
    const modelIds = models.map((model) => model.modelId);
    return {
      architectModelId: modelIds[0] ?? null,
      reviewerModelId: null,
      workerModelIds: modelIds,
    };
  }
  const architect =
    firstRole(team.roles, "architect") ??
    firstRole(team.roles, "single") ??
    team.roles[0] ??
    null;
  const reviewer = firstRole(team.roles, "reviewer");
  let workers = team.roles.filter((role) => role.role === "worker");
  if (workers.length === 0) {
    const single = firstRole(team.roles, "single");
    if (single) workers = [single];
  }
  if (workers.length === 0 && architect) workers = [architect];
  return {
    architectModelId: architect?.modelId ?? null,
    reviewerModelId: reviewer?.modelId ?? null,
    workerModelIds: uniqueStrings(workers.map((role) => role.modelId)),
  };
}

function firstRole(
  roles: BenchmarkTeamCompositionRole[],
  role: BenchmarkTeamCompositionRole["role"]
): BenchmarkTeamCompositionRole | null {
  return roles.find((item) => item.role === role) ?? null;
}

function readBenchmarkTraces(
  input: Pick<WorkBenchBuildAdapterInput, "getBenchmarkTraces">
): BenchmarkModelCallTrace[] {
  try {
    return input.getBenchmarkTraces ? input.getBenchmarkTraces() : getBenchmarkTraces();
  } catch {
    return [];
  }
}

function summarizeBuildDiscussionResult(input: {
  traces: BenchmarkModelCallTrace[];
  toolCalls: number;
  validToolCalls: number;
  durationMs: number;
}): WorkBenchBuildExecutionResult {
  const traceIds = uniqueStrings(input.traces.map((trace) => trace.id));
  return {
    traceIds,
    artifactIds: [],
    // Sum the priced traces and return null only when every trace is unpriced
    // (mirrors the other certified runners' costTotal). The previous
    // all-or-nothing rule discarded partial cost data and yielded null whenever
    // any single call lacked pricing.
    costUsd: costTotal(input.traces.map((trace) => trace.estimatedUsd ?? null)),
    inputTokens: input.traces.reduce(
      (sum, trace) => sum + (trace.inputTokens ?? 0),
      0
    ),
    outputTokens: input.traces.reduce(
      (sum, trace) => sum + (trace.outputTokens ?? 0),
      0
    ),
    modelCalls: traceIds.length,
    toolCalls: input.toolCalls,
    validToolCalls: input.validToolCalls,
    durationMs: input.durationMs,
  };
}

function costTotal(values: Array<number | null>): number | null {
  if (values.every((value) => value === null)) {
    return null;
  }
  let total = 0;
  for (const value of values) {
    total += value ?? 0;
  }
  return total;
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean))).sort();
}
