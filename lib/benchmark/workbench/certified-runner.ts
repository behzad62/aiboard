import type { CertifiedRunContext } from "@/lib/benchmark/certified/run-context";
import type { BenchmarkAttemptV2 } from "@/lib/benchmark/types";
import type { SelectedModel } from "@/lib/providers/base";
import {
  runWorkBenchBuild,
  type RunBuildDiscussionFn,
  type WorkBenchBuildAdapterInput,
} from "./build-adapter";
import type { WorkBenchRunnerConfig } from "./types";
import {
  executeWorkBenchVerifierOnly,
} from "./executor";
import type {
  WorkBenchBuildExecutionResult,
  WorkBenchCase,
  WorkBenchExecutionInput,
} from "./types";

export interface RunCertifiedWorkBenchInput {
  context: CertifiedRunContext;
  cases: WorkBenchCase[];
  runner: WorkBenchRunnerConfig;
  teamCompositionIds: string[];
  models?: SelectedModel[];
  runBuild?: NonNullable<WorkBenchExecutionInput["runBuild"]>;
  runBuildDiscussion?: RunBuildDiscussionFn;
  getBenchmarkTraces?: WorkBenchBuildAdapterInput["getBenchmarkTraces"];
  cleanup?: boolean;
}

export async function runCertifiedWorkBench(
  input: RunCertifiedWorkBenchInput
): Promise<BenchmarkAttemptV2[]> {
  const attempts: BenchmarkAttemptV2[] = [];
  for (const teamCompositionId of input.teamCompositionIds) {
    for (const workBenchCase of input.cases) {
      const result = await executeWorkBenchVerifierOnly({
        case: workBenchCase,
        runner: input.runner,
        attemptId: attemptIdFor(input.context.runId, workBenchCase.id, teamCompositionId),
        runId: input.context.runId,
        teamCompositionId,
        harnessProfile: input.context.harnessProfile,
        cleanup: input.cleanup,
        runBuild:
          input.runBuild ??
          ((buildInput) =>
            runWorkBenchBuild({
              ...buildInput,
              context: input.context,
              models: input.models ?? [],
              runBuildDiscussion: input.runBuildDiscussion,
              getBenchmarkTraces: input.getBenchmarkTraces,
            })),
      });
      await input.context.recordVerifier(result.verifierResult);
      for (const artifact of result.artifacts) {
        await input.context.recordArtifact(artifact);
      }
      attempts.push(result.attempt);
    }
  }
  return attempts;
}

function attemptIdFor(runId: string, caseId: string, teamCompositionId: string): string {
  return `workbench-${safeId(runId)}-${safeId(caseId)}-${safeId(teamCompositionId)}`.slice(0, 120);
}

function safeId(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "id";
}

export type WorkBenchCertifiedBuildResult = WorkBenchBuildExecutionResult;
