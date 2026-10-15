// Certified run execution — extracted VERBATIM from CertifiedRunPanel.tsx
// (2026-07-17 benchmark UX overhaul, Task 4 Step 1). No behavior changes: the
// entry point (`runSelected`) and its pure
// helpers moved out of the component unchanged; component-local reads/setters
// that they used as closures became explicit `ctx` fields instead. Several
// helpers below are *shared* with CertifiedRunPanel.tsx's render code (e.g.
// TRACK_OPTIONS, workBenchModelsForRun, DIRECT_MODEL_HARNESS) —
// they live here as the single source of truth and the panel imports them back.
"use client";

import type { MutableRefObject } from "react";
import {
  saveBenchmarkCaseV2,
  saveBenchmarkTeamComposition,
  saveHarnessCertificationResult,
  listBenchmarkResultSets,
} from "@/lib/benchmark/store";
import { certifiedRunBudgetForCase } from "@/lib/benchmark/certified/run-budget";
import type { CertifiedRunBudget } from "@/lib/benchmark/certified/run-context";
import type { BenchmarkAttemptV2 as BenchmarkAttempt } from "@/lib/benchmark/types";
import { runCertifiedBenchmark } from "@/lib/benchmark/certified/run-engine";
import { throwIfCertifiedRunAborted } from "@/lib/benchmark/certified/model-call";
import { persistReturnedAttempts } from "@/lib/benchmark/certified/model-runner";
import type { CertifiedRunnableTrack } from "@/lib/benchmark/certified/suite-options";
import { runHarnessCertification } from "@/lib/benchmark/certified/certification";
import type { CertifiedRunSummary } from "@/lib/benchmark/certified/run-status";
import {
  checkBenchRunner,
  getTrustedBenchRunnerReadiness,
  type BenchRunnerConfig,
} from "@/lib/client/bench-runner";
import type { BenchmarkPreset, BenchmarkPresetLeg } from "./run-presets";
import type {
  BenchmarkCaseV2,
  BenchmarkTeamComposition,
  BenchmarkTeamCompositionRole,
  HarnessCertificationResult,
  HarnessProfile,
  TeamIqStrategy,
} from "@/lib/benchmark/types";
import {
  createTeamIqCompositionFromSelection,
  createTeamIqToolBenchCompositionsFromSelection,
  deriveSoloTeamComposition,
  deriveTeamComposition,
  normalizeTeamIqModelSelectionForSlots,
  runCertifiedTeamIq,
  teamIqRoleSlotsForStrategy,
  teamIqToolReliabilityCasePackForSuite,
  teamIqToolReliabilityWallClockSecondsForSuite,
  type TeamIqRoleAssignment,
} from "@/lib/benchmark/teamiq";
import {
  TOOL_RELIABILITY_CASES,
  TOOL_RELIABILITY_CASE_PACK_VERSION,
  runCertifiedToolReliability,
} from "@/lib/benchmark/toolreliability";
import {
  getWorkBenchCasePack,
  normalizeWorkBenchModelSelection,
  runCertifiedWorkBench,
  workBenchCaseToBenchmarkCaseV2,
  workBenchHarnessProfileForRoleMode,
  workBenchRoleCount,
  type WorkBenchRoleMode,
} from "@/lib/benchmark/workbench";
import { runNativeWorkBenchBuild } from "@/lib/benchmark/workbench/native-runner-adapter";
import type { SelectedModel } from "@/lib/providers/base";
import { sanitizeBenchmarkDisplayText } from "@/lib/benchmark/configuration-display";
import {
  normalizeBenchmarkEffortForModel,
  normalizeBenchmarkReasoningEffort,
  type BenchmarkModelEffortMap,
} from "@/lib/benchmark/model-effort";
import { benchmarkResultConfigurationKey } from "./result-set-identity";
import {
  cancelBenchmarkResultSet,
  createPendingBenchmarkResultSet,
  failBenchmarkResultSet,
  publishBenchmarkResultSetAfterRuns,
  publishBenchmarkResultSetIfComplete,
  type ResultSetOwnershipMap,
} from "./result-set-publication";
import type { CertifiedRetryProgress } from "./retry-policy";
import {
  effectiveCertifiedRoleMaxTokens,
  effectiveCertifiedTrackMaxTokens,
} from "./effective-max-tokens";

export const DIRECT_MODEL_HARNESS: HarnessProfile = "raw-single-model";
export const TEAM_HARNESS: HarnessProfile = "aiboard-panel";
const DEFAULT_CERTIFIED_MODEL_CALL_TIMEOUT_MS = 120_000;

export type RunnableTrack = CertifiedRunnableTrack;
export type TeamIqUiStrategy = Exclude<TeamIqStrategy, "solo">;
export type CertifiedRunPhase = "idle" | "certifying" | "running" | "persisting" | "done";

export const TRACK_OPTIONS: Array<{ id: RunnableTrack; label: string }> = [
  { id: "toolreliability", label: "Tool Reliability" },
  { id: "teamiq", label: "TeamIQ" },
  { id: "workbench", label: "WorkBench" },
];

// Per-model progress inside a preset leg. "partial" is kept for legs whose
// models finished with mixed outcomes.
export type ModelRunStatus =
  | "queued"
  | "running"
  | "passed"
  | "partial"
  | "failed"
  | "cancelled";

// Shared "run in progress" plumbing runSelected and the preset legs
// write to: the abort ref, run phase/message/summary state, and the
// dashboard-refresh callback fired once persistence completes.
export interface CertifiedRunActions {
  signal?: AbortSignal;
  setRunning: (running: boolean) => void;
  setRunPhase: (phase: CertifiedRunPhase) => void;
  setSummary: (summary: CertifiedRunSummary | null) => void;
  setMessage: (message: string | null) => void;
  runAbortRef: MutableRefObject<AbortController | null>;
  onComplete: () => Promise<void>;
  onRetry?: (event: CertifiedRetryProgress) => void;
}

function linkRunController(parent?: AbortSignal): {
  controller: AbortController;
  unlink: () => void;
} {
  const controller = new AbortController();
  if (!parent) return { controller, unlink: () => {} };
  const abort = () => controller.abort(parent.reason);
  if (parent.aborted) abort();
  else parent.addEventListener("abort", abort, { once: true });
  return {
    controller,
    unlink: () => parent.removeEventListener("abort", abort),
  };
}

function abortReasonMessage(signal: AbortSignal): string {
  const reason = signal.reason;
  if (reason instanceof Error) return sanitizeBenchmarkDisplayText(reason.message);
  if (typeof reason === "string" && reason.length > 0) {
    return sanitizeBenchmarkDisplayText(reason);
  }
  return reason === undefined
    ? "Certified run aborted by user."
    : sanitizeBenchmarkDisplayText(String(reason));
}

function persistedExecutionErrorMessage(error: unknown): string {
  return sanitizeBenchmarkDisplayText(
    error instanceof Error ? error.message : String(error)
  );
}

export interface RunSelectedContext extends CertifiedRunActions {
  selectedTrack: RunnableTrack;
  suiteId: string;
  models: SelectedModel[];
  modelId: string;
  teamModelIds: string[];
  teamIqStrategy: TeamIqUiStrategy;
  includeSoloBaselines: boolean;
  workBenchModelIds: string[];
  workBenchRoleMode: WorkBenchRoleMode;
  workBenchRunnerUrl: string;
  workBenchRunnerToken: string;
  runNativeWorkBenchBuild?: typeof runNativeWorkBenchBuild;
  effectiveHarnessProfile: HarnessProfile;
  certification: HarnessCertificationResult;
  effortByModelId: BenchmarkModelEffortMap;
  executionId?: string;
  runId?: string;
  resultSetOwnership?: ResultSetOwnershipMap;
}

export async function runSelected(ctx: RunSelectedContext): Promise<void> {
  const {
    selectedTrack,
    suiteId,
    models,
    modelId,
    teamModelIds,
    teamIqStrategy,
    includeSoloBaselines,
    workBenchModelIds,
    workBenchRoleMode,
    workBenchRunnerUrl,
    workBenchRunnerToken,
    runNativeWorkBenchBuild: executeNativeWorkBenchBuild =
      runNativeWorkBenchBuild,
    effectiveHarnessProfile,
    certification,
    effortByModelId,
    executionId,
    runId: plannedRunId,
    resultSetOwnership: plannedOwnership,
    signal,
    runAbortRef,
    setRunning,
    setRunPhase,
    setSummary,
    setMessage,
    onComplete,
    onRetry,
  } = ctx;
  if (!suiteId) return;
  const model = models.find((candidate) => candidate.modelId === modelId);
  const workBenchSelectedModels = workBenchModelsForRun(
    models,
    workBenchModelIds,
    workBenchRoleMode
  );
  if (
    selectedTrack !== "teamiq" &&
    selectedTrack !== "workbench" &&
    !model
  ) return;
  if (selectedTrack === "workbench" && workBenchSelectedModels.length < workBenchRoleCount(workBenchRoleMode)) {
    return;
  }
  const selectedWorkBenchPack =
    selectedTrack === "workbench" ? getWorkBenchCasePack(suiteId) : null;
  if (selectedTrack === "workbench" && !selectedWorkBenchPack) return;
  if (selectedTrack === "workbench") {
    const health = await checkBenchRunnerForLeg(
      {
        url: workBenchRunnerUrl,
        token: workBenchRunnerToken,
      },
      signal,
      selectedWorkBenchPack?.cases[0]?.case
    );
    if (!health.ok) {
      setMessage(
        health.error
          ? `Bench runner offline — WorkBench skipped (${health.error}).`
          : "Bench runner offline — WorkBench skipped."
      );
      return;
    }
  }
  const { controller: abortController, unlink } = linkRunController(signal);
  runAbortRef.current = abortController;
  setRunning(true);
  setRunPhase("certifying");
  setSummary(null);
  setMessage(null);
  const runExecutionId =
    executionId ??
    `execution-${selectedTrack}-${Date.now()}-${Math.random()
      .toString(16)
      .slice(2, 10)}`;
  const plannedScopeIds = plannedOwnership
    ? uniqueResultSetIds(plannedOwnership)
    : [];
  try {
    throwIfCertifiedRunAborted(abortController.signal);
    const initialTeamsWithoutEffectiveCaps =
      selectedTrack === "teamiq"
        ? teamIqCompositionsForRun({
            models,
            selectedModelIds: teamModelIds,
            strategy: teamIqStrategy,
            suiteId,
            effortByModelId,
          })
        : [
            selectedTrack === "workbench"
              ? createWorkBenchTeamComposition({
                  models: workBenchSelectedModels,
                  roleMode: workBenchRoleMode,
                  effortByModelId,
                })
              : deriveSoloTeamComposition({
                  modelId: model!.modelId,
                  providerId: model!.providerId,
                  displayName: model!.displayName,
                  reasoningEffort: normalizeBenchmarkEffortForModel(
                    model!,
                    effortByModelId[model!.modelId]
                  ),
              }),
          ];
    const initialTeams = initialTeamsWithoutEffectiveCaps.map((team) =>
      teamWithEffectiveMaxTokens(team, selectedTrack, suiteId)
    );
    const teams =
      selectedTrack === "teamiq"
        ? expandTeamIqTeamsBeforeExecution(
            initialTeams,
            true,
            suiteId,
            "teamiq"
          )
        : selectedTrack === "workbench" && includeSoloBaselines
          ? expandTeamIqTeamsBeforeExecution(
              initialTeams,
              true,
              suiteId,
              "workbench"
            )
        : initialTeams;
    const primaryTeam = teams[0]!;
    for (const team of teams) {
      throwIfCertifiedRunAborted(abortController.signal);
      await saveBenchmarkTeamComposition(team);
      throwIfCertifiedRunAborted(abortController.signal);
    }
    throwIfCertifiedRunAborted(abortController.signal);
    await saveHarnessCertificationResult(certification);
    throwIfCertifiedRunAborted(abortController.signal);
    setRunPhase("running");
    const runId = plannedRunId ?? `ui-${selectedTrack}-${Date.now()}`;
    const caseRecords =
      selectedTrack === "workbench"
        ? selectedWorkBenchPack
          ? selectedWorkBenchPack.cases.map((caseOption) =>
              workBenchCaseToBenchmarkCaseV2(caseOption)
            )
          : []
        : [caseForSelection(selectedTrack, suiteId)];
    for (const caseRecord of caseRecords) {
      throwIfCertifiedRunAborted(abortController.signal);
      await saveBenchmarkCaseV2(caseRecord);
      throwIfCertifiedRunAborted(abortController.signal);
    }
    const publication =
      plannedOwnership
        ? {
            ownership: plannedOwnership,
            resultSetIds: uniqueResultSetIds(plannedOwnership),
          }
        : await planResultSetsForRun({
            executionId: runExecutionId,
            runId,
            suiteId,
            track: selectedTrack,
            teams,
            cases: caseRecords,
          });
    throwIfCertifiedRunAborted(abortController.signal);
    const result = await runCertifiedBenchmark({
      runId,
      suiteId,
      name:
        selectedTrack === "workbench" && selectedWorkBenchPack
          ? selectedWorkBenchPack.label
          : undefined,
      track: selectedTrack,
      harnessProfile: effectiveHarnessProfile,
      caseIds: caseRecords.map((caseRecord) => caseRecord.id),
      teamCompositionIds: teams.map((team) => team.id),
      modelBudget: certifiedRunBudgetForCases(caseRecords, {
        maxModelCallMs: DEFAULT_CERTIFIED_MODEL_CALL_TIMEOUT_MS,
      }),
      certification,
      signal: abortController.signal,
      resultSetOwnership: publication.ownership,
      reportRetry: (event) => {
        const displayName =
          models.find((candidate) => candidate.modelId === event.modelId)
            ?.displayName ?? event.modelId;
        setMessage(
          `${displayName}: temporary provider failure; retry ${event.retry}/${event.maxRetries} in ${Math.ceil(event.delayMs / 1_000)}s.`
        );
        onRetry?.(event);
      },
      onSubjectCompleted: async (teamCompositionId) => {
        const resultSetId =
          publication.ownership.byTeamCompositionId[teamCompositionId];
        if (resultSetId) await publishBenchmarkResultSetIfComplete(resultSetId);
      },
      runner: async (context, options) => {
        if (selectedTrack === "toolreliability") {
          return runCertifiedToolReliability({
            context,
            models: [model!],
            teamCompositionIds: [primaryTeam.id],
            teamCompositions: [primaryTeam],
            casePack: TOOL_RELIABILITY_CASES,
            signal: options?.signal,
          });
        }
        if (selectedTrack === "workbench") {
          if (!selectedWorkBenchPack) {
            throw new Error(`Unknown WorkBench case pack: ${suiteId}`);
          }
          return runCertifiedWorkBench({
            context,
            cases: selectedWorkBenchPack.cases.map((caseOption) => caseOption.case),
            runner: {
              url: workBenchRunnerUrl.trim(),
              token: workBenchRunnerToken.trim(),
            },
            teamCompositionIds: teams.map((team) => team.id),
            teamCompositions: teams,
            signal: options?.signal,
            runBuild: (buildInput) => {
              const teamComposition =
                teams.find(
                  (team) => team.id === buildInput.teamCompositionId
                ) ?? primaryTeam;
              return executeNativeWorkBenchBuild({
                ...buildInput,
                context,
                models: workBenchSelectedModels.filter((candidate) =>
                  teamComposition.roles.some(
                    (role) => role.modelId === candidate.modelId
                  )
                ),
                teamComposition,
              });
            },
          });
        }
        return runCertifiedTeamIq({
          context,
          teamCompositions: teams,
          task: {
            kind: "toolreliability",
            casePack: teamIqToolReliabilityCasePackForSuite(suiteId),
          },
          includeSoloBaselines: false,
          signal: options?.signal,
        });
      },
    });
    await terminalizeRunPublication(publication.resultSetIds, result, abortController.signal);
    throwIfCertifiedRunAborted(abortController.signal);
    setRunPhase("persisting");
    setSummary(result);
    setMessage(
      result.status === "completed"
        ? selectedTrack === "workbench"
          ? `Certified WorkBench pack completed (${caseRecords.length} cases).`
          : `Certified ${trackLabel(selectedTrack)} run completed.`
        : result.error ?? `Certified ${trackLabel(selectedTrack)} run failed.`
    );
    throwIfCertifiedRunAborted(abortController.signal);
    await onComplete();
    throwIfCertifiedRunAborted(abortController.signal);
    setRunPhase("done");
  } catch (error) {
    await terminalizePendingResultSets({
      resultSetIds: plannedScopeIds,
      executionId: plannedOwnership ? undefined : runExecutionId,
      signal: abortController.signal,
    });
    setRunPhase("idle");
    setMessage(error instanceof Error ? error.message : String(error));
  } finally {
    setRunning(false);
    if (runAbortRef.current === abortController) {
      runAbortRef.current = null;
    }
    unlink();
  }
}

// Runs `mapper` over `items` with at most `limit` in flight at once, preserving
// input order in the returned array.
export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  mapper: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const worker = async () => {
    for (;;) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await mapper(items[index]!, index);
    }
  };
  const workerCount = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

function slugForRunId(value: string): string {
  return value.replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "model";
}

export function caseForSelection(
  track: RunnableTrack,
  suiteId: string
): BenchmarkCaseV2 {
  const timestamp = new Date().toISOString();
  if (track === "workbench") {
    throw new Error("WorkBench runs require a selected case pack.");
  }
  if (track === "toolreliability") {
    return {
      id: "toolreliability-current-pack",
      schemaVersion: 2,
      track: "toolreliability",
      title: "ToolReliability current challenge pack",
      description:
        "Stateful multi-turn tool-use pack mined from real Build failures.",
      difficulty: "medium",
      tags: ["toolreliability"],
      caseVersion: TOOL_RELIABILITY_CASE_PACK_VERSION,
      createdAt: timestamp,
      updatedAt: timestamp,
      prompt: { userRequest: "Complete each current ToolReliability challenge." },
      environment: { type: "browser", timeoutSeconds: 60, network: "none" },
      verifier: { scorer: "rule-checker" },
      budget: { maxUsd: 5, maxWallClockSeconds: 1800, maxModelCalls: 150 },
      scoring: { scoringVersion: "toolreliability-v2", primary: "tool_reliability" },
      contamination: {
        originalTask: true,
        canary: "AIBENCH-UI-TOOLREL",
        referenceSolutionPrivate: true,
      },
    };
  }
  if (track === "teamiq") {
    const allModes = isTeamIqToolReliabilityAllModesSuite(suiteId);
    return {
      id: suiteId,
      schemaVersion: 2,
      track: "teamiq",
      title: allModes
        ? "TeamIQ ToolReliability quick all modes"
        : "TeamIQ ToolReliability quick",
      description:
        allModes
          ? "TeamIQ solo baselines and all team strategy modes over a cross-category ToolReliability sample."
          : "TeamIQ solo baselines and team attempt over a cross-category ToolReliability sample.",
      difficulty: "medium",
      tags: ["teamiq", "toolreliability"],
      caseVersion: "2.0.0",
      createdAt: timestamp,
      updatedAt: timestamp,
      prompt: {
        userRequest:
          "Run solo baselines and a model team over ToolReliability cases.",
      },
      environment: { type: "browser", timeoutSeconds: 60, network: "none" },
      verifier: { scorer: "rule-checker" },
      budget: {
        maxUsd: 5,
        maxWallClockSeconds:
          teamIqToolReliabilityWallClockSecondsForSuite(suiteId),
        maxModelCalls: 150,
      },
      scoring: { scoringVersion: "teamiq-toolreliability-v2", primary: "team_lift" },
      contamination: {
        originalTask: true,
        canary: "AIBENCH-UI-TEAMIQ",
        referenceSolutionPrivate: true,
      },
    };
  }
  throw new Error(`Unsupported certified track: ${track}`);
}

function expandTeamIqTeamsBeforeExecution(
  teams: BenchmarkTeamComposition[],
  includeSoloBaselines: boolean,
  suiteId: string,
  track: "teamiq" | "workbench"
): BenchmarkTeamComposition[] {
  if (!includeSoloBaselines) return teams;
  const solos = new Map<string, BenchmarkTeamComposition>();
  for (const team of teams) {
    for (const role of team.roles) {
      const key = [
        role.providerId,
        role.modelId,
        normalizeBenchmarkReasoningEffort(role.reasoningEffort),
        effectiveCertifiedRoleMaxTokens({
          track,
          suiteId,
          roleMaxTokens: role.maxTokens,
        }),
      ].join("\u0000");
      if (solos.has(key)) continue;
      solos.set(
        key,
        deriveSoloTeamComposition({
          modelId: role.modelId,
          providerId: role.providerId,
          displayName: role.displayName,
          reasoningEffort: role.reasoningEffort,
          temperature: role.temperature,
          maxTokens: role.maxTokens,
        })
      );
    }
  }
  const soloIds = new Set([...solos.values()].map((team) => team.id));
  return [...solos.values(), ...teams.filter((team) => !soloIds.has(team.id))];
}

function teamWithEffectiveMaxTokens(
  team: BenchmarkTeamComposition,
  track: RunnableTrack,
  suiteId: string
): BenchmarkTeamComposition {
  const roles = team.roles.map((role) => ({
    ...role,
    maxTokens:
      effectiveCertifiedRoleMaxTokens({
        track,
        suiteId,
        roleMaxTokens: role.maxTokens,
      }) ?? undefined,
  }));
  if (roles.every((role, index) => role.maxTokens === team.roles[index]?.maxTokens)) {
    return team;
  }
  if (roles.length === 1 && roles[0]?.role === "single") {
    const role = roles[0];
    return deriveSoloTeamComposition({
      modelId: role.modelId,
      providerId: role.providerId,
      displayName: role.displayName,
      reasoningEffort: role.reasoningEffort,
      temperature: role.temperature,
      maxTokens: role.maxTokens,
      name: team.name,
      strategy: "solo",
    });
  }
  return deriveTeamComposition({
    name: team.name,
    roles,
    strategy:
      team.strategy && team.strategy !== "solo" ? team.strategy : undefined,
  });
}

async function planResultSetsForRun(input: {
  executionId: string;
  runId: string;
  suiteId: string;
  track: RunnableTrack;
  teams: BenchmarkTeamComposition[];
  cases: BenchmarkCaseV2[];
}): Promise<{
  ownership: ResultSetOwnershipMap;
  resultSetIds: string[];
}> {
  const byTeamCompositionId: Record<string, string> = {};
  const resultSetIds: string[] = [];
  for (const team of input.teams) {
    const id = [
      "result",
      slugForRunId(input.executionId),
      slugForRunId(team.id),
    ].join("-");
    const configuration = {
      subjectKind:
        team.strategy === "solo" || team.roles.length === 1
          ? ("model" as const)
          : ("team" as const),
      displayName: team.name,
      ...(team.roles.length === 1
        ? {
            providerId: team.roles[0]!.providerId,
            modelId: team.roles[0]!.modelId,
            reasoningEffort: team.roles[0]!.reasoningEffort,
          }
        : {}),
      strategy: team.strategy,
      roles: team.roles.map((role) => ({
        role: role.role,
        slot: role.slot,
        providerId: role.providerId,
        modelId: role.modelId,
        reasoningEffort: role.reasoningEffort ?? "default",
        maxTokens: effectiveCertifiedRoleMaxTokens({
          track: input.track,
          suiteId: input.suiteId,
          roleMaxTokens: role.maxTokens,
        }),
      })),
      tracks: [
        {
          track: input.track,
          suiteId: input.suiteId,
          caseManifest: input.cases.map((item) => ({
            caseId: item.id,
            caseVersion: item.caseVersion,
            scoringVersion: item.scoring.scoringVersion,
          })),
          maxTokens: effectiveCertifiedTrackMaxTokens(
            input.track,
            input.suiteId
          ),
        },
      ],
    };
    await createPendingBenchmarkResultSet({
      id,
      schemaVersion: 1,
      executionId: input.executionId,
      anchorRunId: input.runId,
      runIds: [input.runId],
      configurationKey: benchmarkResultConfigurationKey(configuration),
      configuration,
      expectedAttempts: input.cases.map((item) => ({
        runId: input.runId,
        track: input.track,
        suiteId: input.suiteId,
        caseId: item.id,
        caseVersion: item.caseVersion,
        scoringVersion: item.scoring.scoringVersion,
        teamCompositionId: team.id,
      })),
    });
    byTeamCompositionId[team.id] = id;
    resultSetIds.push(id);
  }
  return {
    ownership: {
      ...(resultSetIds.length === 1
        ? { defaultResultSetId: resultSetIds[0] }
        : {}),
      byTeamCompositionId,
    },
    resultSetIds,
  };
}

function uniqueResultSetIds(ownership: ResultSetOwnershipMap): string[] {
  return Array.from(
    new Set([
      ...(ownership.defaultResultSetId
        ? [ownership.defaultResultSetId]
        : []),
      ...Object.values(ownership.byTeamCompositionId),
    ])
  );
}

async function terminalizeRunPublication(
  resultSetIds: string[],
  result: CertifiedRunSummary,
  signal: AbortSignal,
  settledRunIds?: string[]
): Promise<void> {
  let publicationError: Error | null = null;
  for (const resultSetId of resultSetIds) {
    if (signal.aborted) {
      await cancelBenchmarkResultSet(resultSetId, abortReasonMessage(signal));
      continue;
    }
    if (result.status !== "completed") {
      await failBenchmarkResultSet(resultSetId, {
        kind: "infrastructure",
        code: "unpublished_infrastructure_failure",
        message: result.error ?? "Certified benchmark output was not publishable.",
      });
      continue;
    }
    try {
      if (settledRunIds) {
        await publishBenchmarkResultSetAfterRuns(resultSetId, settledRunIds);
      } else {
        await publishBenchmarkResultSetIfComplete(resultSetId);
      }
    } catch (error) {
      const message = persistedExecutionErrorMessage(error);
      await failBenchmarkResultSet(resultSetId, {
        kind: "infrastructure",
        code: "incomplete_benchmark_output",
        message,
      });
      publicationError ??= new Error(
        `Unpublished infrastructure failure: ${message}`
      );
    }
  }
  if (publicationError) throw publicationError;
}

async function terminalizePendingResultSets(input: {
  resultSetIds?: string[];
  executionId?: string;
  signal: AbortSignal;
}): Promise<void> {
  const records = await listBenchmarkResultSets();
  const ids = new Set(input.resultSetIds ?? []);
  if (input.executionId) {
    for (const record of records) {
      if (record.executionId === input.executionId) ids.add(record.id);
    }
  }
  for (const resultSetId of ids) {
    const record = records.find((item) => item.id === resultSetId);
    if (!record || record.status !== "pending") continue;
    if (input.signal.aborted) {
      await cancelBenchmarkResultSet(
        resultSetId,
        "Certified benchmark execution was cancelled before publication."
      );
    } else {
      await failBenchmarkResultSet(resultSetId, {
        kind: "infrastructure",
        code: "unpublished_infrastructure_failure",
        message:
          "Certified benchmark execution stopped before this subject could be published.",
      });
    }
  }
}

function certifiedRunBudgetForCases(
  caseRecords: BenchmarkCaseV2[],
  defaults: CertifiedRunBudget = {}
): CertifiedRunBudget {
  const budgets = caseRecords.map((caseRecord) =>
    certifiedRunBudgetForCase(caseRecord, defaults)
  );
  return {
    ...defaults,
    maxUsd: sumBudgetField(budgets, "maxUsd"),
    maxModelCalls: sumBudgetField(budgets, "maxModelCalls"),
    maxInputTokens: sumBudgetField(budgets, "maxInputTokens"),
    maxOutputTokens: sumBudgetField(budgets, "maxOutputTokens"),
    maxWallClockMs: sumBudgetField(budgets, "maxWallClockMs"),
  };
}

function sumBudgetField(
  budgets: CertifiedRunBudget[],
  field: keyof Pick<
    CertifiedRunBudget,
    | "maxUsd"
    | "maxModelCalls"
    | "maxInputTokens"
    | "maxOutputTokens"
    | "maxWallClockMs"
  >
): number | undefined {
  let total = 0;
  let found = false;
  for (const budget of budgets) {
    const value = budget[field];
    if (typeof value !== "number") continue;
    total += value;
    found = true;
  }
  return found ? total : undefined;
}

export function teamIqCompositionsForRun(input: {
  models: SelectedModel[];
  selectedModelIds: string[];
  strategy: TeamIqUiStrategy;
  suiteId: string;
  effortByModelId: BenchmarkModelEffortMap;
}): BenchmarkTeamComposition[] {
  if (isTeamIqToolReliabilityAllModesSuite(input.suiteId)) {
    return createTeamIqToolBenchCompositionsFromSelection({
      models: input.models,
      selectedModelIds: input.selectedModelIds,
      effortByModelId: input.effortByModelId,
    });
  }
  return [
    createTeamIqCompositionFromSelection({
      models: input.models,
      selectedModelIds: input.selectedModelIds,
      strategy: input.strategy,
      effortByModelId: input.effortByModelId,
      roleAssignments: roleAssignmentsForTeamIqSelection(input),
    }),
  ];
}

function roleAssignmentsForTeamIqSelection(input: {
  models: SelectedModel[];
  selectedModelIds: string[];
  strategy: TeamIqUiStrategy;
}): TeamIqRoleAssignment[] {
  const slots = teamIqRoleSlotsForStrategy(input.strategy);
  const modelIds = normalizeTeamIqModelSelectionForSlots({
    models: input.models,
    selectedModelIds: input.selectedModelIds,
    slotCount: slots.length,
  });
  return slots.map((slot, index) => ({
    role: slot.role,
    slot: slot.slot,
    modelId: modelIds[index]!,
  }));
}

export function isTeamIqToolReliabilityAllModesSuite(suiteId: string): boolean {
  return suiteId === "teamiq-toolreliability-current-all-modes";
}

export function trackLabel(track: RunnableTrack): string {
  return TRACK_OPTIONS.find((option) => option.id === track)?.label ?? track;
}

export function workBenchModelsForRun(
  models: SelectedModel[],
  selectedModelIds: string[],
  roleMode: WorkBenchRoleMode
): SelectedModel[] {
  return normalizeWorkBenchModelSelection({
    models,
    selectedModelIds,
    roleMode,
  })
    .map((id) => models.find((model) => model.modelId === id))
    .filter((model): model is SelectedModel => Boolean(model));
}

export function createWorkBenchTeamComposition(input: {
  models: SelectedModel[];
  roleMode: WorkBenchRoleMode;
  effortByModelId: BenchmarkModelEffortMap;
}): BenchmarkTeamComposition {
  if (input.roleMode === "solo") {
    const model = input.models[0];
    return deriveSoloTeamComposition({
      modelId: model.modelId,
      providerId: model.providerId,
      displayName: model.displayName,
      reasoningEffort: normalizeBenchmarkEffortForModel(
        model,
        input.effortByModelId[model.modelId]
      ),
    });
  }
  const roles = input.models.map((model, index): BenchmarkTeamCompositionRole => {
    const role = workBenchRoleFor(input.roleMode, index);
    return {
      role,
      slot: `${String(index + 1).padStart(2, "0")}-${role}`,
      modelId: model.modelId,
      providerId: model.providerId,
      displayName: model.displayName,
      reasoningEffort: normalizeBenchmarkEffortForModel(
        model,
        input.effortByModelId[model.modelId]
      ),
      temperature: 0,
    };
  });
  return deriveTeamComposition({
    name: roles.map((role) => role.displayName).join(" + "),
    roles,
    strategy: input.roleMode,
  });
}

export function workBenchRoleFor(
  roleMode: WorkBenchRoleMode,
  index: number
): BenchmarkTeamCompositionRole["role"] {
  if (roleMode === "solo") return "single";
  if (roleMode === "architect_worker") return index === 0 ? "architect" : "worker";
  if (index === 0) return "architect";
  if (index === 1) return "worker";
  return "reviewer";
}

// ---------------------------------------------------------------------------
// Preset orchestration (2026-07-17 benchmark UX overhaul, Task 4 Step 3).
// runPreset SEQUENCES the existing per-track run functions above — it does
// not add a new run engine. Each leg reuses runSelected (single model at a
// time, looped with a concurrency cap for solo legs) exactly as the Advanced
// flow does; the
// only new logic here is: iterate legs in order, skip legs whose `requires`
// is unmet, and translate each leg's progress into PresetProgressEvents for
// RunProgressList instead of the single-flow's runPhase/summary state.
// ---------------------------------------------------------------------------

/** Tool Reliability keeps its deliberate, independent solo-preset cap. */
const MAX_PARALLEL_PRESET_LEG_MODELS = 4;

export type PresetLegStatus =
  | "queued"
  | "running"
  | "passed"
  | "partial"
  | "failed"
  | "skipped";

export interface PresetLegProgress {
  type: "leg";
  legIndex: number;
  leg: BenchmarkPresetLeg;
  status: PresetLegStatus;
  detail?: string;
}

export interface PresetModelProgress {
  type: "model";
  legIndex: number;
  leg: BenchmarkPresetLeg;
  modelId: string;
  displayName: string;
  status: ModelRunStatus;
  detail?: string;
}

export interface PresetRetryProgress {
  type: "retry";
  legIndex: number;
  leg: BenchmarkPresetLeg;
  modelId: string;
  displayName: string;
  resultSetId?: string;
  retry: number;
  maxRetries: 5;
  delayMs: number;
  detail: string;
}

export type PresetProgressEvent =
  | PresetLegProgress
  | PresetModelProgress
  | PresetRetryProgress;

// Everything runPreset needs across every leg kind: the shared model
// checklist (solo legs), the shared team builder's role selections (team
// legs — the same selection maps onto both TeamIQ and WorkBench role slots,
// per the plan's "one builder, both tracks"), and the WorkBench runner
// connection used both for the `requires: "bench-runner"` gate and the
// WorkBench run itself.
export interface RunPresetContext {
  models: SelectedModel[];
  /** Model ids checked in the shared ModelChecklist; drives every solo leg. */
  soloModelIds: string[];
  effortByModelId: BenchmarkModelEffortMap;
  /** Team builder's role-ordered model ids, reused for TeamIQ AND WorkBench. */
  teamModelIds: string[];
  teamIqStrategy: TeamIqUiStrategy;
  workBenchRoleMode: WorkBenchRoleMode;
  workBenchRunnerUrl: string;
  workBenchRunnerToken: string;
  signal: AbortSignal;
  onComplete: () => Promise<void>;
}

export async function runPreset(
  preset: BenchmarkPreset,
  ctx: RunPresetContext,
  onProgress: (event: PresetProgressEvent) => void
): Promise<void> {
  const presetExecutionId = `execution-${preset.id}-${Date.now()}-${Math.random()
    .toString(16)
    .slice(2, 10)}`;
  for (let legIndex = 0; legIndex < preset.legs.length; legIndex++) {
    const leg = preset.legs[legIndex]!;
    if (ctx.signal.aborted) {
      onProgress({ type: "leg", legIndex, leg, status: "skipped", detail: "Cancelled." });
      continue;
    }
    if (leg.requires === "bench-runner") {
      const health = await checkBenchRunnerForLeg({
        url: ctx.workBenchRunnerUrl,
        token: ctx.workBenchRunnerToken,
      }, ctx.signal);
      if (ctx.signal.aborted) {
        onProgress({ type: "leg", legIndex, leg, status: "skipped", detail: "Cancelled." });
        continue;
      }
      if (!health.ok) {
        onProgress({
          type: "leg",
          legIndex,
          leg,
          status: "skipped",
          detail: health.error
            ? `Bench runner offline — WorkBench skipped (${health.error}).`
            : "Bench runner offline — WorkBench skipped.",
        });
        continue;
      }
    }
    if (ctx.signal.aborted) {
      onProgress({ type: "leg", legIndex, leg, status: "skipped", detail: "Cancelled." });
      continue;
    }
    onProgress({ type: "leg", legIndex, leg, status: "running" });
    try {
      const result =
        leg.mode === "solo"
          ? await runSoloLeg(
              leg,
              legIndex,
              ctx,
              onProgress,
              presetExecutionId
            )
          : await runTeamLeg(
              leg,
              legIndex,
              ctx,
              onProgress,
              presetExecutionId
            );
      onProgress({ type: "leg", legIndex, leg, status: result.status, detail: result.detail });
    } catch (error) {
      onProgress({
        type: "leg",
        legIndex,
        leg,
        status: ctx.signal.aborted ? "skipped" : "failed",
        detail: ctx.signal.aborted
          ? "Cancelled."
          : error instanceof Error ? error.message : String(error),
      });
    }
  }
  await ctx.onComplete();
}

async function checkBenchRunnerForLeg(
  config: BenchRunnerConfig,
  signal?: AbortSignal,
  workBenchCase?: import("@/lib/benchmark/workbench/types").WorkBenchCase
): Promise<{ ok: boolean; error?: string }> {
  if (!config.url.trim() || !config.token.trim()) {
    return { ok: false, error: "Bench runner not configured." };
  }
  const health = await checkBenchRunner(config, signal);
  const readiness = getTrustedBenchRunnerReadiness(health, workBenchCase);
  return readiness.ready ? { ok: true } : { ok: false, error: readiness.error };
}

interface PresetLegResult {
  status: PresetLegStatus;
  detail?: string;
}

async function runSoloLeg(
  leg: BenchmarkPresetLeg,
  legIndex: number,
  ctx: RunPresetContext,
  onProgress: (event: PresetProgressEvent) => void,
  presetExecutionId: string
): Promise<PresetLegResult> {
  const selectedModels = ctx.soloModelIds
    .map((id) => ctx.models.find((candidate) => candidate.modelId === id))
    .filter((model): model is SelectedModel => Boolean(model));
  if (selectedModels.length === 0) {
    return { status: "skipped", detail: "No models selected." };
  }

  // Solo tracks (currently only ToolReliability) run one model at a time via
  // runSelected, looped with a concurrency cap.
  const modelStatuses = new Array<ModelRunStatus>(selectedModels.length);
  let cursor = 0;
  const worker = async () => {
    for (;;) {
      if (ctx.signal.aborted) return;
      const index = cursor;
      if (index >= selectedModels.length) return;
      cursor++;
      if (ctx.signal.aborted) return;
      const model = selectedModels[index]!;
      onProgress({
        type: "model",
        legIndex,
        leg,
        modelId: model.modelId,
        displayName: model.displayName,
        status: "running",
      });
      // A plain `let` here gets over-narrowed by TS across the nested
      // setSummary closure below; a boxed container reads back cleanly.
      const outcome: { summary: CertifiedRunSummary | null; error?: string } = {
        summary: null,
      };
      try {
        await runSelected({
          selectedTrack: leg.track,
          suiteId: leg.suiteId,
          models: ctx.models,
          modelId: model.modelId,
          teamModelIds: [],
          teamIqStrategy: ctx.teamIqStrategy,
          includeSoloBaselines: true,
          workBenchModelIds: [],
          workBenchRoleMode: ctx.workBenchRoleMode,
          workBenchRunnerUrl: ctx.workBenchRunnerUrl,
          workBenchRunnerToken: ctx.workBenchRunnerToken,
          effectiveHarnessProfile: DIRECT_MODEL_HARNESS,
          certification: runHarnessCertification(DIRECT_MODEL_HARNESS),
          effortByModelId: ctx.effortByModelId,
          signal: ctx.signal,
          runAbortRef: { current: null },
          setRunning: () => {},
          setRunPhase: () => {},
          setSummary: (summary) => {
            outcome.summary = summary;
          },
          setMessage: (message) => {
            if (message) outcome.error = message;
          },
          onRetry: (event) => {
            onProgress({
              type: "retry",
              legIndex,
              leg,
              modelId: event.modelId,
              displayName: model.displayName,
              resultSetId: event.resultSetId,
              retry: event.retry,
              maxRetries: event.maxRetries,
              delayMs: event.delayMs,
              detail: `${event.reason}; retry ${event.retry}/${event.maxRetries} in ${Math.ceil(event.delayMs / 1_000)}s.`,
            });
          },
          onComplete: async () => {},
          executionId: presetExecutionId,
        });
      } catch (error) {
        outcome.error = error instanceof Error ? error.message : String(error);
      }
      const status: ModelRunStatus =
        ctx.signal.aborted
          ? "cancelled"
          : outcome.summary?.status === "completed"
            ? "passed"
            : "failed";
      modelStatuses[index] = status;
      onProgress({
        type: "model",
        legIndex,
        leg,
        modelId: model.modelId,
        displayName: model.displayName,
        status,
        detail:
          status === "cancelled"
            ? "Cancelled."
            : status === "failed"
              ? outcome.error
              : undefined,
      });
    }
  };
  await Promise.all(
    Array.from(
      {
        length: Math.max(
          1,
          Math.min(MAX_PARALLEL_PRESET_LEG_MODELS, selectedModels.length)
        ),
      },
      () => worker()
    )
  );
  for (let index = 0; index < selectedModels.length; index++) {
    if (modelStatuses[index]) continue;
    const model = selectedModels[index]!;
    modelStatuses[index] = "cancelled";
    onProgress({
      type: "model",
      legIndex,
      leg,
      modelId: model.modelId,
      displayName: model.displayName,
      status: "cancelled",
      detail: "Cancelled.",
    });
  }
  return { status: legStatusFromStatuses(modelStatuses) };
}

async function runTeamLeg(
  leg: BenchmarkPresetLeg,
  _legIndex: number,
  ctx: RunPresetContext,
  _onProgress: (event: PresetProgressEvent) => void,
  presetExecutionId: string
): Promise<PresetLegResult> {
  if (ctx.teamModelIds.length === 0) {
    return { status: "skipped", detail: "No team composition selected." };
  }
  const effectiveHarnessProfile =
    leg.track === "workbench"
      ? workBenchHarnessProfileForRoleMode(ctx.workBenchRoleMode)
      : TEAM_HARNESS;
  // A plain `let` here gets over-narrowed by TS across the nested setSummary
  // closure below; a boxed container reads back cleanly (see runSoloLeg).
  const outcome: { summary: CertifiedRunSummary | null; error?: string } = {
    summary: null,
  };
  try {
    await runSelected({
      selectedTrack: leg.track,
      suiteId: leg.suiteId,
      models: ctx.models,
      modelId: "",
      teamModelIds: ctx.teamModelIds,
      teamIqStrategy: ctx.teamIqStrategy,
      includeSoloBaselines: leg.includeSoloBaselines ?? true,
      workBenchModelIds: ctx.teamModelIds,
      workBenchRoleMode: ctx.workBenchRoleMode,
      workBenchRunnerUrl: ctx.workBenchRunnerUrl,
      workBenchRunnerToken: ctx.workBenchRunnerToken,
      effectiveHarnessProfile,
      certification: runHarnessCertification(effectiveHarnessProfile),
      effortByModelId: ctx.effortByModelId,
      signal: ctx.signal,
      runAbortRef: { current: null },
      setRunning: () => {},
      setRunPhase: () => {},
      setSummary: (summary) => {
        outcome.summary = summary;
      },
      setMessage: (message) => {
        if (message) outcome.error = message;
      },
      onRetry: (event) => {
        _onProgress({
          type: "retry",
          legIndex: _legIndex,
          leg,
          modelId: event.modelId,
          displayName:
            ctx.models.find((candidate) => candidate.modelId === event.modelId)
              ?.displayName ?? event.modelId,
          resultSetId: event.resultSetId,
          retry: event.retry,
          maxRetries: event.maxRetries,
          delayMs: event.delayMs,
          detail: `${event.reason}; retry ${event.retry}/${event.maxRetries} in ${Math.ceil(event.delayMs / 1_000)}s.`,
        });
      },
      onComplete: async () => {},
      executionId: presetExecutionId,
    });
  } catch (error) {
    outcome.error = error instanceof Error ? error.message : String(error);
  }
  const status: PresetLegStatus =
    ctx.signal.aborted
      ? "skipped"
      : outcome.summary?.status === "completed"
        ? "passed"
        : "failed";
  if (ctx.signal.aborted) return { status, detail: "Cancelled." };
  return { status, detail: status === "failed" ? outcome.error : undefined };
}

function legStatusFromStatuses(
  statuses: ModelRunStatus[]
): PresetLegStatus {
  if (statuses.length === 0) return "skipped";
  if (statuses.every((status) => status === "cancelled")) return "skipped";
  const passed = statuses.filter((status) => status === "passed").length;
  const partial = statuses.filter((status) => status === "partial").length;
  if (passed === statuses.length) return "passed";
  if (passed > 0 || partial > 0) return "partial";
  return "failed";
}
