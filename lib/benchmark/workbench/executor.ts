import { cleanupBenchRun, getBenchDiff, prepareBenchCase, runBenchVerifier } from "@/lib/client/bench-runner";
import type { BenchmarkAttemptV2, BenchmarkVerifierResult, CertifiedAttemptStatus } from "@/lib/benchmark/types";
import { scoreWorkBenchAttempt } from "@/lib/benchmark/scoring/workbench";
import { round } from "@/lib/benchmark/scoring/types";
import { isProviderFailureMessage } from "@/lib/benchmark/certified/classify-provider-failure";
import { throwIfCertifiedRunAborted } from "@/lib/benchmark/certified/model-call";
import {
  createWorkBenchLogArtifact,
  createWorkBenchPatchArtifact,
  createWorkBenchRetainedStateArtifact,
  createWorkBenchVerifierArtifact,
} from "./artifacts";
import { parseVerifierResult } from "./verifier";
import type {
  ParsedWorkBenchVerifierResult,
  WorkBenchBuildExecutionResult,
  WorkBenchExecutionInput,
  WorkBenchExecutionResult,
  WorkBenchRunVerifierResult,
} from "./types";

export async function executeWorkBenchVerifierOnly(
  input: WorkBenchExecutionInput
): Promise<WorkBenchExecutionResult> {
  const startedAt = new Date().toISOString();
  const startedMs = Date.now();
  const harnessProfile = input.harnessProfile ?? "aiboard-build-multi-worker";
  let attemptId = input.attemptId;
  let prepared = false;
  let cleanupEligible = false;

  if (!input.runBuild) {
    return createFailedWorkBenchAttempt(input, {
      attemptId,
      startedAt,
      startedMs,
      harnessProfile,
      status: "invalid_harness",
      code: "missing_run_build",
      message: "WorkBench execution requires a runBuild callback before verifier scoring.",
    });
  }

  try {
    throwIfCertifiedRunAborted(input.signal);
    const preparedAttempt = await prepareBenchCase(input.runner, {
      attemptId: input.attemptId,
      caseId: input.case.id,
      repoUrl: input.case.repo.url,
      baseCommit: input.case.repo.baseCommit,
      setupCommand: input.case.environment.setupCommand,
      network: input.case.environment.network,
      timeoutSeconds: input.case.environment.timeoutSeconds,
      verifierCommand: input.case.verifier.command,
      verifierResultFile: input.case.verifier.resultFile,
      allowedCommands: input.case.allowedCommands,
      files: input.case.fixtureFiles,
    });
    attemptId = preparedAttempt.attemptId || input.attemptId;
    prepared = true;

    let buildResult: WorkBenchBuildExecutionResult;
    try {
      throwIfCertifiedRunAborted(input.signal);
      buildResult = await input.runBuild({
        case: input.case,
        runner: input.runner,
        attemptId,
        runId: input.runId,
        teamCompositionId: input.teamCompositionId,
        harnessProfile,
        allowedCommands: input.case.allowedCommands,
        signal: input.signal,
      });
      throwIfCertifiedRunAborted(input.signal);
    } catch (error) {
      const failure = classifyBuildFailure(error);
      return createFailedWorkBenchAttempt(input, {
        attemptId,
        startedAt,
        startedMs,
        harnessProfile,
        status: failure.status,
        code: failure.code,
        message: errorMessage(error),
        buildResult: buildResultFromError(error),
        retainedPaths: retainedRunnerPaths(error),
      });
    }

    const traceIds = uniqueStrings(buildResult.traceIds);
    const modelCalls = buildResult.modelCalls ?? input.modelCalls ?? 0;
    if (modelCalls <= 0 || traceIds.length === 0) {
      return createFailedWorkBenchAttempt(input, {
        attemptId,
        startedAt,
        startedMs,
        harnessProfile,
        status: "invalid_harness",
        code: "trace_evidence_missing",
        message: "WorkBench harness produced no model-call trace evidence before verifier scoring.",
        buildResult,
      });
    }

    // Budget checks use model-attributable build time; attempt.durationMs below
    // still reports the full prepare -> verifier wall clock.
    const buildDurationMs =
      buildResult.durationMs ?? Math.max(0, Date.now() - startedMs);
    const budgetFailure = findBudgetFailure(input, buildResult, buildDurationMs);
    if (budgetFailure) {
      return createFailedWorkBenchAttempt(input, {
        attemptId,
        startedAt,
        startedMs,
        harnessProfile,
        status: "failed_budget",
        code: budgetFailure.code,
        message: budgetFailure.message,
        buildResult,
      });
    }

    let verifierRun: WorkBenchRunVerifierResult;
    let parsedVerifierResult: ParsedWorkBenchVerifierResult;
    try {
      throwIfCertifiedRunAborted(input.signal);
      verifierRun = await runBenchVerifier(input.runner, {
        attemptId,
        timeoutSeconds: input.case.verifier.timeoutSeconds,
      });
      parsedVerifierResult = parseVerifierResult(
        verifierRun.stdoutPreview,
        verifierRun.resultJson
      );
      throwIfCertifiedRunAborted(input.signal);
    } catch (error) {
      return createFailedWorkBenchAttempt(input, {
        attemptId,
        startedAt,
        startedMs,
        harnessProfile,
        status: "invalid_case",
        code: "verifier_failed",
        message: errorMessage(error),
        buildResult,
      });
    }

    const scoreDurationMs =
      buildResult.durationMs ?? Math.max(0, Date.now() - startedMs);
    const score = scoreWorkBenchAttempt({
      verifierScore: parsedVerifierResult.score,
      verifierPassed: parsedVerifierResult.passed,
      actualCostUsd: buildResult.costUsd ?? input.costUsd ?? null,
      targetCostUsd: input.case.scoring.costTargetUsd,
      actualDurationMs: scoreDurationMs,
      targetDurationMs:
        typeof input.case.scoring.timeTargetSeconds === "number"
          ? input.case.scoring.timeTargetSeconds * 1000
          : undefined,
      validToolCalls: buildResult.validToolCalls ?? input.validToolCalls ?? 0,
      totalToolCalls: buildResult.toolCalls ?? input.toolCalls ?? 0,
    });
    const verifierResult: BenchmarkVerifierResult = {
      id: `${attemptId}:verifier`,
      attemptId,
      caseId: input.case.id,
      command: input.case.verifier.command,
      passed: parsedVerifierResult.passed,
      score: parsedVerifierResult.score,
      durationMs: verifierRun.durationMs,
      exitCode: verifierRun.exitCode,
      stdoutPreview: verifierRun.stdoutPreview,
      stderrPreview: verifierRun.stderrPreview,
      resultJson: parsedVerifierResult.rawJson,
      assertionResults: parsedVerifierResult.assertions,
      artifactIds: [`${attemptId}:verifier-result`],
    };
    const diff = await getBenchDiff(input.runner, { attemptId }).catch(() => ({ diff: "" }));
    const completedAt = new Date().toISOString();
    const durationMs = Math.max(0, Date.now() - startedMs);
    const artifacts = [
      createWorkBenchVerifierArtifact({
        id: `${attemptId}:verifier-result`,
        attemptId,
        caseId: input.case.id,
        result: verifierArtifactContent(parsedVerifierResult.rawJson),
        createdAt: completedAt,
      }),
      ...(diff.diff
        ? [
            createWorkBenchPatchArtifact({
              id: `${attemptId}:patch`,
              attemptId,
              caseId: input.case.id,
              diff: diff.diff,
              createdAt: completedAt,
            }),
          ]
        : []),
    ];
    const artifactIds = uniqueStrings([
      ...(buildResult.artifactIds ?? []),
      ...verifierResult.artifactIds,
      ...artifacts.map((artifact) => artifact.id),
    ]);
    const attempt: BenchmarkAttemptV2 = {
      id: attemptId,
      runId: input.runId,
      caseId: input.case.id,
      teamCompositionId: input.teamCompositionId,
      mode: "certified",
      track: "workbench",
      harnessProfile,
      status: parsedVerifierResult.passed ? "passed" : "failed_verifier",
      startedAt,
      completedAt,
      verifiedQuality: score.verifiedQuality,
      jobSuccessScore: score.jobSuccessScore,
      efficiencyScore: score.efficiencyScore,
      toolReliabilityScore: scaleToolReliabilityScore(score.toolReliability),
      costUsd: buildResult.costUsd ?? input.costUsd ?? null,
      inputTokens: buildResult.inputTokens ?? input.inputTokens ?? 0,
      outputTokens: buildResult.outputTokens ?? input.outputTokens ?? 0,
      modelCalls,
      toolCalls: buildResult.toolCalls ?? input.toolCalls ?? 0,
      durationMs,
      verifierResultId: verifierResult.id,
      artifactIds,
      traceIds,
      failureIds: [],
      harnessVersion: "workbench-runner-v0.1",
      promptSetVersion: "workbench-prompts-v0.1",
      scoringVersion: input.case.scoring.scoringVersion,
    };
    cleanupEligible = attempt.status === "passed";
    return { attempt, verifierResult, parsedVerifierResult, score, artifacts };
  } catch (error) {
    const failure = classifyPrepareFailure(error);
    return createFailedWorkBenchAttempt(input, {
      attemptId,
      startedAt,
      startedMs,
      harnessProfile,
      status: failure.status,
      code: failure.code,
      message: errorMessage(error),
    });
  } finally {
    if (prepared && cleanupEligible && input.cleanup !== false) {
      await cleanupBenchRun(input.runner, { attemptId }).catch(() => undefined);
    }
  }
}

interface FailedWorkBenchAttemptContext {
  attemptId?: string;
  startedAt?: string;
  startedMs?: number;
  harnessProfile?: BenchmarkAttemptV2["harnessProfile"];
  status?: CertifiedAttemptStatus;
  code?: string;
  message?: string;
  buildResult?: Partial<WorkBenchBuildExecutionResult>;
  retainedPaths?: { projectPath: string; statePath: string };
}

export function createFailedWorkBenchAttempt(
  input: WorkBenchExecutionInput,
  context: FailedWorkBenchAttemptContext = {}
): WorkBenchExecutionResult {
  const attemptId = context.attemptId ?? input.attemptId;
  const status = context.status ?? "invalid_harness";
  const code = sanitizeFailureCode(context.code ?? status);
  const message = context.message ?? failureSummaryForStatus(status);
  const startedAt = context.startedAt ?? new Date().toISOString();
  const startedMs = context.startedMs ?? Date.now();
  const completedAt = new Date().toISOString();
  const durationMs = Math.max(0, Date.now() - startedMs);
  const harnessProfile = context.harnessProfile ?? input.harnessProfile ?? "aiboard-build-multi-worker";
  const logArtifact = createWorkBenchLogArtifact({
    id: `${attemptId}:failure-log`,
    attemptId,
    caseId: input.case.id,
    label: "WorkBench failure",
    content: message,
    createdAt: completedAt,
  });
  const retainedArtifact = context.retainedPaths
    ? createWorkBenchRetainedStateArtifact({
        id: `${attemptId}:runner-v2-retained-state`,
        attemptId,
        caseId: input.case.id,
        projectPath: context.retainedPaths.projectPath,
        statePath: context.retainedPaths.statePath,
        createdAt: completedAt,
      })
    : null;
  const failureArtifactIds = [
    ...(context.buildResult?.artifactIds ?? []),
    logArtifact.id,
    ...(retainedArtifact ? [retainedArtifact.id] : []),
  ].filter((id, index, values) => values.indexOf(id) === index);
  const verifierResult: BenchmarkVerifierResult = {
    id: `${attemptId}:verifier`,
    attemptId,
    caseId: input.case.id,
    command: input.case.verifier.command,
    passed: false,
    score: 0,
    durationMs,
    exitCode: 1,
    stdoutPreview: "",
    stderrPreview: message,
    resultJson: JSON.stringify({
      passed: false,
      score: 0,
      summary: message,
      assertions: [
        {
          id: code,
          label: failureSummaryForStatus(status),
          passed: false,
          weight: 1,
          message,
        },
      ],
    }),
    assertionResults: [
      {
        id: code,
        label: failureSummaryForStatus(status),
        passed: false,
        weight: 1,
        message,
      },
    ],
    artifactIds: failureArtifactIds,
  };
  const score = scoreWorkBenchAttempt({
    verifierScore: 0,
    verifierPassed: false,
    actualCostUsd: context.buildResult?.costUsd ?? input.costUsd ?? null,
    targetCostUsd: input.case.scoring.costTargetUsd,
    actualDurationMs: durationMs,
    targetDurationMs:
      typeof input.case.scoring.timeTargetSeconds === "number"
        ? input.case.scoring.timeTargetSeconds * 1000
        : undefined,
    validToolCalls: context.buildResult?.validToolCalls ?? input.validToolCalls ?? 0,
    totalToolCalls: context.buildResult?.toolCalls ?? input.toolCalls ?? 0,
  });
  const attempt: BenchmarkAttemptV2 = {
    id: attemptId,
    runId: input.runId,
    caseId: input.case.id,
    teamCompositionId: input.teamCompositionId,
    mode: "certified",
    track: "workbench",
    harnessProfile,
    status,
    startedAt,
    completedAt,
    verifiedQuality: score.verifiedQuality,
    jobSuccessScore: score.jobSuccessScore,
    efficiencyScore: score.efficiencyScore,
    toolReliabilityScore: scaleToolReliabilityScore(score.toolReliability),
    costUsd: context.buildResult?.costUsd ?? input.costUsd ?? null,
    inputTokens: context.buildResult?.inputTokens ?? input.inputTokens ?? 0,
    outputTokens: context.buildResult?.outputTokens ?? input.outputTokens ?? 0,
    modelCalls: context.buildResult?.modelCalls ?? input.modelCalls ?? 0,
    toolCalls: context.buildResult?.toolCalls ?? input.toolCalls ?? 0,
    durationMs,
    verifierResultId: verifierResult.id,
    artifactIds: failureArtifactIds,
    traceIds: context.buildResult?.traceIds ?? [],
    failureIds: [`${attemptId}:failure:${code}`],
    harnessVersion: "workbench-runner-v0.1",
    promptSetVersion: "workbench-prompts-v0.1",
    scoringVersion: input.case.scoring.scoringVersion,
  };
  return {
    attempt,
    verifierResult,
    parsedVerifierResult: parseVerifierResult("", verifierResult.resultJson),
    score,
    artifacts: [logArtifact, ...(retainedArtifact ? [retainedArtifact] : [])],
  };
}

function retainedRunnerPaths(
  error: unknown
): { projectPath: string; statePath: string } | undefined {
  if (!error || typeof error !== "object") return undefined;
  const value = error as {
    runnerProjectPath?: unknown;
    runnerStatePath?: unknown;
  };
  return typeof value.runnerProjectPath === "string" &&
    typeof value.runnerStatePath === "string"
    ? { projectPath: value.runnerProjectPath, statePath: value.runnerStatePath }
    : undefined;
}

function buildResultFromError(
  error: unknown
): Partial<WorkBenchBuildExecutionResult> | undefined {
  if (!error || typeof error !== "object") return undefined;
  const buildResult = (error as { buildResult?: unknown }).buildResult;
  return buildResult && typeof buildResult === "object"
    ? buildResult as Partial<WorkBenchBuildExecutionResult>
    : undefined;
}

function scaleToolReliabilityScore(value: number | null): number | undefined {
  return value == null ? undefined : round(value * 100);
}

function findBudgetFailure(
  input: WorkBenchExecutionInput,
  buildResult: WorkBenchBuildExecutionResult,
  durationMs: number
): { code: string; message: string } | null {
  const budget = input.case.budget;
  const costUsd = buildResult.costUsd ?? input.costUsd ?? null;
  if (typeof budget.maxUsd === "number" && costUsd !== null && costUsd > budget.maxUsd) {
    return { code: "budget_cost_exceeded", message: `Cost ${costUsd} exceeded maxUsd ${budget.maxUsd}.` };
  }
  const modelCalls = buildResult.modelCalls ?? input.modelCalls ?? 0;
  if (typeof budget.maxModelCalls === "number" && modelCalls > budget.maxModelCalls) {
    return { code: "budget_model_calls_exceeded", message: `Model calls ${modelCalls} exceeded maxModelCalls ${budget.maxModelCalls}.` };
  }
  const toolCalls = buildResult.toolCalls ?? input.toolCalls ?? 0;
  if (typeof budget.maxToolCalls === "number" && toolCalls > budget.maxToolCalls) {
    return { code: "budget_tool_calls_exceeded", message: `Tool calls ${toolCalls} exceeded maxToolCalls ${budget.maxToolCalls}.` };
  }
  const inputTokens = buildResult.inputTokens ?? input.inputTokens ?? 0;
  if (typeof budget.maxInputTokens === "number" && inputTokens > budget.maxInputTokens) {
    return { code: "budget_input_tokens_exceeded", message: `Input tokens ${inputTokens} exceeded maxInputTokens ${budget.maxInputTokens}.` };
  }
  const outputTokens = buildResult.outputTokens ?? input.outputTokens ?? 0;
  if (typeof budget.maxOutputTokens === "number" && outputTokens > budget.maxOutputTokens) {
    return { code: "budget_output_tokens_exceeded", message: `Output tokens ${outputTokens} exceeded maxOutputTokens ${budget.maxOutputTokens}.` };
  }
  // `durationMs` is the model-attributable build duration passed by the caller,
  // not the full prepare/verifier reporting duration.
  if (typeof budget.maxWallClockSeconds === "number" && durationMs > budget.maxWallClockSeconds * 1000) {
    return { code: "budget_wall_clock_exceeded", message: `Duration ${durationMs}ms exceeded maxWallClockSeconds ${budget.maxWallClockSeconds}.` };
  }
  return null;
}

function classifyPrepareFailure(error: unknown): { status: CertifiedAttemptStatus; code: string } {
  const message = errorMessage(error).toLowerCase();
  if (/abort|cancel/.test(message)) {
    return { status: "aborted_user", code: "aborted_user" };
  }
  if (/runner|connect|network|fetch|workspace/.test(message)) {
    return { status: "invalid_environment", code: "runner_unavailable" };
  }
  if (/case|manifest|fixture|setup|verifier/.test(message)) {
    return { status: "invalid_case", code: "case_setup_failed" };
  }
  return { status: "invalid_harness", code: "workbench_prepare_failed" };
}

function classifyBuildFailure(error: unknown): { status: CertifiedAttemptStatus; code: string } {
  const typed = typedBuildFailure(error);
  if (typed) return typed;
  const message = errorMessage(error).toLowerCase();
  if (/abort|cancel/.test(message)) {
    return { status: "aborted_user", code: "aborted_user" };
  }
  if (isProviderFailureMessage(message)) {
    return { status: "provider_unavailable", code: "provider_unavailable" };
  }
  if (/budget|token limit|cost limit|wall.?clock/.test(message)) {
    return { status: "failed_budget", code: "budget_exhausted" };
  }
  if (/tool|patch|command|forbidden|malformed/.test(message)) {
    return { status: "failed_tool_use", code: "tool_execution_failed" };
  }
  return { status: "invalid_harness", code: "workbench_build_failed" };
}

function typedBuildFailure(
  error: unknown
): { status: CertifiedAttemptStatus; code: string } | null {
  if (!error || typeof error !== "object") return null;
  const value = error as {
    certifiedStatus?: unknown;
    certifiedCode?: unknown;
  };
  const statuses = new Set<CertifiedAttemptStatus>([
    "failed_model",
    "failed_tool_use",
    "failed_budget",
    "provider_unavailable",
    "invalid_harness",
    "invalid_environment",
    "invalid_case",
    "aborted_user",
  ]);
  if (
    typeof value.certifiedStatus !== "string" ||
    !statuses.has(value.certifiedStatus as CertifiedAttemptStatus) ||
    typeof value.certifiedCode !== "string" ||
    !value.certifiedCode.trim()
  ) return null;
  return {
    status: value.certifiedStatus as CertifiedAttemptStatus,
    code: sanitizeFailureCode(value.certifiedCode),
  };
}

function failureSummaryForStatus(status: CertifiedAttemptStatus): string {
  switch (status) {
    case "failed_model":
      return "Model failed task";
    case "failed_verifier":
      return "Verifier rejected output";
    case "failed_tool_use":
      return "Tool use failed";
    case "failed_budget":
      return "Budget exhausted";
    case "provider_unavailable":
      return "Provider unavailable";
    case "invalid_environment":
      return "Environment invalid";
    case "invalid_case":
      return "Case invalid";
    case "aborted_user":
      return "User aborted";
    case "passed":
      return "Passed";
    case "invalid_harness":
    default:
      return "Harness invalid";
  }
}

function verifierArtifactContent(rawJson: string): string {
  try {
    return JSON.stringify(JSON.parse(rawJson), null, 2);
  } catch {
    return rawJson;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sanitizeFailureCode(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "") || "workbench_failure";
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean)));
}
