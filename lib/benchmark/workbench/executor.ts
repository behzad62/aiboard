import { cleanupBenchRun, getBenchDiff, prepareBenchCase, runBenchVerifier } from "@/lib/client/bench-runner";
import type { BenchmarkAttemptV2, BenchmarkVerifierResult } from "@/lib/benchmark/types";
import { scoreWorkBenchAttempt } from "@/lib/benchmark/scoring/workbench";
import {
  createWorkBenchPatchArtifact,
  createWorkBenchVerifierArtifact,
} from "./artifacts";
import { parseVerifierResult } from "./verifier";
import type { WorkBenchExecutionInput, WorkBenchExecutionResult } from "./types";

export async function executeWorkBenchVerifierOnly(
  input: WorkBenchExecutionInput
): Promise<WorkBenchExecutionResult> {
  if (!input.runBuild) {
    throw new Error(
      "WorkBench execution requires a runBuild callback before verifier scoring."
    );
  }

  const startedAt = new Date().toISOString();
  const startedMs = Date.now();
  const harnessProfile = input.harnessProfile ?? "aiboard-build-multi-worker";
  const prepared = await prepareBenchCase(input.runner, {
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
  const attemptId = prepared.attemptId || input.attemptId;

  try {
    const buildResult = await input.runBuild({
      case: input.case,
      runner: input.runner,
      attemptId,
      runId: input.runId,
      teamCompositionId: input.teamCompositionId,
      harnessProfile,
      allowedCommands: input.case.allowedCommands,
    });
    const traceIds = uniqueStrings(buildResult.traceIds);
    const modelCalls = buildResult.modelCalls ?? input.modelCalls ?? 0;
    if (modelCalls <= 0 || traceIds.length === 0) {
      throw new Error(
        "WorkBench harness produced no model-call trace evidence before verifier scoring."
      );
    }

    const verifierRun = await runBenchVerifier(input.runner, {
      attemptId,
      timeoutSeconds: input.case.verifier.timeoutSeconds,
    });
    const parsedVerifierResult = parseVerifierResult(
      verifierRun.stdoutPreview,
      verifierRun.resultJson
    );
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
      id: `${input.attemptId}:verifier`,
      attemptId: input.attemptId,
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
      artifactIds: [`${input.attemptId}:verifier-result`],
    };
    const diff = await getBenchDiff(input.runner, { attemptId }).catch(() => ({ diff: "" }));
    const completedAt = new Date().toISOString();
    const durationMs = Math.max(0, Date.now() - startedMs);
    const artifacts = [
      createWorkBenchVerifierArtifact({
        id: `${input.attemptId}:verifier-result`,
        attemptId: input.attemptId,
        caseId: input.case.id,
        result: verifierArtifactContent(parsedVerifierResult.rawJson),
        createdAt: completedAt,
      }),
      ...(diff.diff
        ? [
            createWorkBenchPatchArtifact({
              id: `${input.attemptId}:patch`,
              attemptId: input.attemptId,
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
      id: input.attemptId,
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
  } finally {
    if (input.cleanup !== false) {
      await cleanupBenchRun(input.runner, { attemptId }).catch(() => undefined);
    }
  }
}

function verifierArtifactContent(rawJson: string): unknown {
  try {
    return JSON.parse(rawJson);
  } catch {
    return { rawJson };
  }
}

function uniqueStrings(values: string[] | undefined): string[] {
  return Array.from(new Set((values ?? []).filter(Boolean))).sort();
}
