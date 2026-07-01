import type { BuildHooks } from "@/lib/client/build-engine";
import {
  patchBenchFile,
  readBenchFile,
  readBenchTree,
  writeBenchFile,
} from "@/lib/client/bench-runner";
import { getBenchmarkTraces } from "@/lib/client/store";
import {
  callCertifiedModel,
  type CertifiedModelStream,
} from "@/lib/benchmark/certified/model-call";
import type { CertifiedRunContext } from "@/lib/benchmark/certified/run-context";
import type {
  BenchmarkModelCallTrace,
  BenchmarkTeamComposition,
  BenchmarkTeamCompositionRole,
} from "@/lib/benchmark/types";
import type { Discussion } from "@/lib/db/schema";
import type { OrchestratorEvent } from "@/lib/orchestrator/engine";
import type { SelectedModel, StructuredOutputFormat } from "@/lib/providers/base";
import type { ModelPricing } from "@/lib/providers/pricing";
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
        if (trace.status === "ok") validToolCallIds.add(trace.id);
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

async function loadRunBuildDiscussion(): Promise<RunBuildDiscussionFn> {
  const engine = await import("@/lib/client/build-engine");
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

export interface WorkBenchModelPatchBuildInput
  extends WorkBenchBuildExecutionInput {
  context: CertifiedRunContext;
  model: SelectedModel;
  streamChat?: CertifiedModelStream;
  apiKey?: string;
  pricing?: Pick<ModelPricing, "inputUsdPer1M" | "outputUsdPer1M"> | null;
}

interface WorkBenchPatchAction {
  path: string;
  search?: string;
  replace?: string;
  content?: string;
  summary?: string;
}

const WORKBENCH_PATCH_ACTION_SCHEMA: StructuredOutputFormat = {
  name: "workbench_patch_action",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["path", "summary"],
    properties: {
      path: {
        type: "string",
        description: "Relative path to the file that must be changed.",
      },
      search: {
        type: "string",
        description:
          "Exact text to replace. Required unless content contains the full replacement file.",
      },
      replace: {
        type: "string",
        description:
          "Replacement text for the search value. Required when search is provided.",
      },
      content: {
        type: "string",
        description:
          "Full replacement file content. Use only when search/replace cannot express the change.",
      },
      summary: {
        type: "string",
        description: "Short explanation of the patch.",
      },
    },
  },
};

const SOURCE_FILE_PATTERN = /\.(?:cjs|css|go|html|js|jsx|json|mjs|py|rs|ts|tsx)$/i;

export async function runWorkBenchModelPatchBuild(
  input: WorkBenchModelPatchBuildInput
): Promise<WorkBenchBuildExecutionResult> {
  const startedMs = Date.now();
  let toolCalls = 0;
  let validToolCalls = 0;

  const recordTool = async <T>(
    toolName: string,
    toolInput: Record<string, unknown>,
    operation: () => Promise<T>
  ): Promise<T> => {
    const callNumber = toolCalls + 1;
    toolCalls = callNumber;
    const startedAt = new Date().toISOString();
    const started = Date.now();
    try {
      const result = await operation();
      validToolCalls += 1;
      await input.context.recordToolCall({
        id: `${input.attemptId}:tool:${String(callNumber).padStart(3, "0")}`,
        attemptId: input.attemptId,
        caseId: input.case.id,
        toolName,
        status: "ok",
        startedAt,
        completedAt: new Date().toISOString(),
        durationMs: Math.max(0, Date.now() - started),
        inputJson: JSON.stringify(toolInput),
        outputPreview: preview(result),
      });
      return result;
    } catch (error) {
      await input.context.recordToolCall({
        id: `${input.attemptId}:tool:${String(callNumber).padStart(3, "0")}`,
        attemptId: input.attemptId,
        caseId: input.case.id,
        toolName,
        status: "failed",
        startedAt,
        completedAt: new Date().toISOString(),
        durationMs: Math.max(0, Date.now() - started),
        inputJson: JSON.stringify(toolInput),
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  };

  const tree = await recordTool("bench.read-tree", { attemptId: input.attemptId }, () =>
    readBenchTree(input.runner, { attemptId: input.attemptId })
  );
  const sourceFiles = tree.files.filter(isCandidateSourceFile).slice(0, 5);
  if (sourceFiles.length === 0) {
    throw new Error("WorkBench fixture contains no candidate source files to patch.");
  }

  const fileSnapshots = [];
  for (const path of sourceFiles) {
    const file = await recordTool(
      "bench.read-file",
      { attemptId: input.attemptId, path },
      () => readBenchFile(input.runner, { attemptId: input.attemptId, path })
    );
    fileSnapshots.push({
      path,
      content: truncate(file.content, 8000),
    });
  }

  const modelCall = await callCertifiedModel({
    model: input.model,
    system:
      "You are running a certified WorkBench fixture. Return one minimal patch action as strict JSON. Do not include markdown or prose.",
    user: buildPatchPrompt(input, fileSnapshots),
    structuredOutput: WORKBENCH_PATCH_ACTION_SCHEMA,
    maxTokens: 1600,
    temperature: 0,
    context: input.context,
    participantId: "workbench-builder",
    caseId: input.case.id,
    attemptId: input.attemptId,
    apiKey: input.apiKey,
    pricing: input.pricing,
    streamChat: input.streamChat,
  });
  const action = parsePatchAction(modelCall.parsedJson);
  if (!sourceFiles.includes(action.path)) {
    throw new Error(`Model selected a file outside the candidate set: ${action.path}`);
  }

  if (typeof action.content === "string") {
    await recordTool(
      "bench.write-file",
      { attemptId: input.attemptId, path: action.path },
      () =>
        writeBenchFile(input.runner, {
          attemptId: input.attemptId,
          path: action.path,
          content: action.content ?? "",
        })
    );
  } else {
    await recordTool(
      "bench.patch-file",
      {
        attemptId: input.attemptId,
        path: action.path,
        search: action.search,
        replace: action.replace,
      },
      async () => {
        const result = await patchBenchFile(input.runner, {
          attemptId: input.attemptId,
          path: action.path,
          search: action.search ?? "",
          replace: action.replace ?? "",
        });
        if (result.applied <= 0) {
          throw new Error(`Patch did not apply to ${action.path}.`);
        }
        return result;
      }
    );
  }

  return {
    traceIds: [modelCall.traceId],
    artifactIds: [],
    costUsd: modelCall.estimatedUsd,
    inputTokens: modelCall.inputTokens,
    outputTokens: modelCall.outputTokens,
    modelCalls: 1,
    toolCalls,
    validToolCalls,
    durationMs: Math.max(0, Date.now() - startedMs),
  };
}

function buildPatchPrompt(
  input: WorkBenchModelPatchBuildInput,
  files: Array<{ path: string; content: string }>
): string {
  return [
    `Case: ${input.case.title}`,
    `Task: ${input.case.prompt.userRequest}`,
    input.case.prompt.publicContext
      ? `Public context: ${input.case.prompt.publicContext}`
      : null,
    "Return JSON with either search/replace or full content.",
    "Only choose one of the files shown below.",
    ...files.map(
      (file) =>
        `\nFILE ${file.path}\n\`\`\`\n${file.content}\n\`\`\``
    ),
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n");
}

function parsePatchAction(value: unknown): WorkBenchPatchAction {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("WorkBench patch action must be a JSON object.");
  }
  const record = value as Record<string, unknown>;
  const path = stringField(record, "path");
  const content =
    typeof record.content === "string" && record.content.length > 0
      ? record.content
      : undefined;
  if (content !== undefined) {
    return {
      path,
      content,
      summary: optionalStringField(record, "summary"),
    };
  }
  const search = stringField(record, "search");
  const replace = stringField(record, "replace");
  return {
    path,
    search,
    replace,
    summary: optionalStringField(record, "summary"),
  };
}

function stringField(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`WorkBench patch action requires non-empty ${key}.`);
  }
  return value;
}

function optionalStringField(
  record: Record<string, unknown>,
  key: string
): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

function isCandidateSourceFile(path: string): boolean {
  const normalized = path.replace(/\\/g, "/");
  if (
    normalized.includes("/node_modules/") ||
    normalized.includes("/.git/") ||
    normalized.endsWith("verifier.mjs") ||
    normalized.endsWith("verifier-result.json") ||
    normalized.endsWith("negative-control.json") ||
    normalized.endsWith("case-meta.json") ||
    normalized.endsWith("reference-solution.md")
  ) {
    return false;
  }
  return SOURCE_FILE_PATTERN.test(normalized);
}

function preview(value: unknown): string {
  return truncate(JSON.stringify(value), 1000);
}

function truncate(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength)}...`;
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean))).sort();
}
