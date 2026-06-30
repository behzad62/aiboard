import type { CertifiedRunContext } from "@/lib/benchmark/certified/run-context";
import type { BenchmarkAttemptV2, BenchmarkTeamComposition } from "@/lib/benchmark/types";
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
  teamCompositionIds?: string[];
  teamCompositions?: BenchmarkTeamComposition[];
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
  const teamCompositionIds =
    input.teamCompositionIds ??
    input.teamCompositions?.map((team) => team.id) ??
    [];
  for (const teamCompositionId of teamCompositionIds) {
    const teamComposition =
      input.teamCompositions?.find((team) => team.id === teamCompositionId) ??
      null;
    const models = modelsForWorkBenchTeam(teamComposition, input.models ?? []);
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
              models,
              teamComposition: teamComposition ?? undefined,
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

function modelsForWorkBenchTeam(
  team: BenchmarkTeamComposition | null,
  fallbackModels: SelectedModel[]
): SelectedModel[] {
  if (!team) return fallbackModels;
  const byId = new Map(fallbackModels.map((model) => [model.modelId, model]));
  const selected = team.roles.map((role) => ({
    modelId: role.modelId,
    providerId: role.providerId,
    displayName: role.displayName,
    contextProfile: byId.get(role.modelId)?.contextProfile,
  }));
  return uniqueModels(selected.length > 0 ? selected : fallbackModels);
}

function uniqueModels(models: SelectedModel[]): SelectedModel[] {
  const seen = new Set<string>();
  const result: SelectedModel[] = [];
  for (const model of models) {
    if (seen.has(model.modelId)) continue;
    seen.add(model.modelId);
    result.push(model);
  }
  return result;
}

function attemptIdFor(runId: string, caseId: string, teamCompositionId: string): string {
  return `workbench-${safeId(runId)}-${safeId(caseId)}-${safeId(teamCompositionId)}`.slice(0, 120);
}

function safeId(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "id";
}

export type WorkBenchCertifiedBuildResult = WorkBenchBuildExecutionResult;
