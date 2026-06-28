import { cleanupBenchRun, getBenchDiff, prepareBenchCase, runBenchVerifier } from "@/lib/client/bench-runner";
import type { BenchmarkAttemptV2, BenchmarkVerifierResult, CertifiedAttemptStatus } from "@/lib/benchmark/types";
import type { WorkBenchScore } from "@/lib/benchmark/scoring/types";
import { scoreWorkBenchAttempt } from "@/lib/benchmark/scoring/workbench";
import {
  createWorkBenchLogArtifact,
  createWorkBenchPatchArtifact,
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
    });
    attemptId = preparedAttempt.attemptId || input.attemptId;
    prepared = true;

    let buildResult: WorkBenchBuildExecutionResult;
    try {
      buildResult = await input.runBuild({
        case: input.case,
        runner: input.runner,
        attemptId,
        runId: input.runId,
        teamCompositionId: input.teamCompositionId,
        harnessProfile,
        allowedCommands: input.case.allowedCommands,
      });
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

    const budgetFailure = findBudgetFailure(input, buildResult, Math.max(0, Date.now() - startedMs));
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
      verifierRun = await runBenchVerifier(input.runner, {
        attemptId,
        timeoutSeconds: input.case.verifier.timeoutSeconds,
      });
      parsedVerifierResult = parseVerifierResult(
        verifierRun.stdoutPreview,
        verifierRun.resultJson
      );
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

    const durationForScore = Math.max(0, Date.now() - startedMs);
    const score = scoreWorkBenchAttempt({
      verifierScore: parsedVerifierResult.score,
      verifierPassed: parsedVerifierResult.passed,
      actualCostUsd: buildResult.costUsd ?? input.costUsd ?? null,
      targetCostUsd: input.case.scoring.costTargetUsd,
      actualDurationMs: durationForScore,
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
    if (prepared && input.cleanup !== false) {
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
  const costUsd = context.buildResult?.costUsd ?? input.costUsd ?? null;
  const inputTokens = context.buildResult?.inputTokens ?? input.inputTokens ?? 0;
  const outputTokens = context.buildResult?.outputTokens ?? input.outputTokens ?? 0;
  const modelCalls = context.buildResult?.modelCalls ?? input.modelCalls ?? 0;
  const toolCalls = context.buildResult?.toolCalls ?? input.toolCalls ?? 0;
  const validToolCalls = context.buildResult?.validToolCalls ?? input.validToolCalls ?? 0;
  const traceIds = uniqueStrings(context.buildResult?.traceIds);
  const failureId = `${attemptId}:failure:${code}`;
  const assertion = {
    id: code,
    label: failureSummaryForStatus(status),
    passed: false,
    weight: 1,
    message,
  };
  const rawJson = JSON.stringify({
    passed: false,
    score: 0,
    summary: message,
    assertions: [assertion],
  });
  const parsedVerifierResult: ParsedWorkBenchVerifierResult = {
    passed: false,
    score: 0,
    summary: message,
    assertions: [assertion],
    rawJson,
  };
  const score: WorkBenchScore = scoreWorkBenchAttempt({
    verifierScore: 0,
    verifierPassed: false,
    actualCostUsd: costUsd,
    targetCostUsd: input.case.scoring.costTargetUsd,
    actualDurationMs: durationMs,
    targetDurationMs:
      typeof input.case.scoring.timeTargetSeconds === "number"
        ? input.case.scoring.timeTargetSeconds * 1000
        : undefined,
    validToolCalls,
    totalToolCalls: toolCalls,
  });
  const verifierResult: BenchmarkVerifierResult = {
    id: `${attemptId}:verifier`,
    attemptId,
    caseId: input.case.id,
    command: input.case.verifier.command,
    passed: false,
    score: 0,
    durationMs,
    stdoutPreview: "",
    stderrPreview: message,
    resultJson: rawJson,
    assertionResults: parsedVerifierResult.assertions,
    artifactIds: [`${attemptId}:verifier-result`],
  };
  const artifacts = [
    createWorkBenchVerifierArtifact({
      id: `${attemptId}:verifier-result`,
      attemptId,
      caseId: input.case.id,
      result: verifierArtifactContent(rawJson),
      createdAt: completedAt,
    }),
    createWorkBenchLogArtifact({
      id: `${attemptId}:failure-log`,
      attemptId,
      caseId: input.case.id,
      label: "WorkBench failure log",
      content: JSON.stringify(
        {
          status,
          code,
          message,
          failureId,
          attemptId,
          caseId: input.case.id,
        },
        null,
        2
      ),
      createdAt: completedAt,
    }),
  ];
  const artifactIds = uniqueStrings([
    ...(context.buildResult?.artifactIds ?? []),
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
    status,
    startedAt,
    completedAt,
    verifiedQuality: score.verifiedQuality,
    jobSuccessScore: score.jobSuccessScore,
    efficiencyScore: score.efficiencyScore,
    costUsd,
    inputTokens,
    outputTokens,
    modelCalls,
    toolCalls,
    durationMs,
    verifierResultId: verifierResult.id,
    artifactIds,
    traceIds,
    failureIds: [failureId],
    harnessVersion: "workbench-runner-v0.1",
    promptSetVersion: "workbench-prompts-v0.1",
    scoringVersion: input.case.scoring.scoringVersion,
  };

  return { attempt, verifierResult, parsedVerifierResult, score, artifacts };
}

function verifierArtifactContent(rawJson: string): unknown {
  try {
    return JSON.parse(rawJson);
  } catch {
    return { rawJson };
  }
}

function classifyPrepareFailure(error: unknown): { status: CertifiedAttemptStatus; code: string } {
  const message = errorMessage(error).toLowerCase();
  if (
    message.includes("fetch failed") ||
    message.includes("failed to fetch") ||
    message.includes("econnrefused") ||
    message.includes("connect") ||
    message.includes("runner")
  ) {
    return { status: "invalid_environment", code: "runner_unavailable" };
  }
  if (
    message.includes("setup command failed") ||
    message.includes("fixture") ||
    message.includes("manifest") ||
    message.includes("repository") ||
    message.includes("verifier")
  ) {
    return { status: "invalid_case", code: "case_setup_failed" };
  }
  return { status: "invalid_environment", code: "environment_prepare_failed" };
}

function classifyBuildFailure(error: unknown): { status: CertifiedAttemptStatus; code: string } {
  const message = errorMessage(error).toLowerCase();
  if (
    message.includes("provider") ||
    message.includes("429") ||
    message.includes("rate limit") ||
    message.includes("quota") ||
    message.includes("api key") ||
    message.includes("unauthorized") ||
    message.includes("503") ||
    message.includes("502")
  ) {
    return { status: "provider_unavailable", code: "provider_error_before_output" };
  }
  return { status: "invalid_harness", code: "run_build_crashed" };
}

function findBudgetFailure(
  input: WorkBenchExecutionInput,
  buildResult: WorkBenchBuildExecutionResult,
  durationMs: number
): { code: string; message: string } | null {
  const budget = input.case.budget;
  const modelCalls = buildResult.modelCalls ?? input.modelCalls ?? 0;
  const toolCalls = buildResult.toolCalls ?? input.toolCalls ?? 0;
  const inputTokens = buildResult.inputTokens ?? input.inputTokens ?? 0;
  const outputTokens = buildResult.outputTokens ?? input.outputTokens ?? 0;
  const costUsd = buildResult.costUsd ?? input.costUsd ?? null;
  const wallClockMs = Math.max(durationMs, buildResult.durationMs ?? 0);

  if (exceeds(modelCalls, budget.maxModelCalls)) {
    return {
      code: "budget_model_calls_exceeded",
      message: `Model calls exceeded budget (${modelCalls} > ${budget.maxModelCalls}).`,
    };
  }
  if (exceeds(toolCalls, budget.maxToolCalls)) {
    return {
      code: "budget_tool_calls_exceeded",
      message: `Tool calls exceeded budget (${toolCalls} > ${budget.maxToolCalls}).`,
    };
  }
  if (exceeds(inputTokens, budget.maxInputTokens)) {
    return {
      code: "budget_input_tokens_exceeded",
      message: `Input tokens exceeded budget (${inputTokens} > ${budget.maxInputTokens}).`,
    };
  }
  if (exceeds(outputTokens, budget.maxOutputTokens)) {
    return {
      code: "budget_output_tokens_exceeded",
      message: `Output tokens exceeded budget (${outputTokens} > ${budget.maxOutputTokens}).`,
    };
  }
  if (exceeds(costUsd, budget.maxUsd)) {
    return {
      code: "budget_cost_exceeded",
      message: `Cost exceeded budget (${costUsd} > ${budget.maxUsd}).`,
    };
  }
  if (exceeds(wallClockMs / 1000, budget.maxWallClockSeconds)) {
    return {
      code: "budget_wall_clock_exceeded",
      message: `Wall clock exceeded budget (${Math.round(wallClockMs / 1000)}s > ${budget.maxWallClockSeconds}s).`,
    };
  }
  return null;
}

function exceeds(actual: number | null | undefined, limit: number | null | undefined): boolean {
  return (
    typeof actual === "number" &&
    Number.isFinite(actual) &&
    typeof limit === "number" &&
    Number.isFinite(limit) &&
    actual > limit
  );
}

function failureSummaryForStatus(status: CertifiedAttemptStatus): string {
  switch (status) {
    case "failed_budget":
      return "Certified budget exceeded";
    case "provider_unavailable":
      return "Provider unavailable";
    case "invalid_environment":
      return "Benchmark environment invalid";
    case "invalid_case":
      return "Benchmark case invalid";
    case "invalid_harness":
    default:
      return "Benchmark harness invalid";
  }
}

function sanitizeFailureCode(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "") || "workbench_failure";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function uniqueStrings(values: string[] | undefined): string[] {
  return Array.from(new Set((values ?? []).filter(Boolean))).sort();
}
