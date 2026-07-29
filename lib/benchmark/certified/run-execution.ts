// Certified run execution — extracted VERBATIM from CertifiedRunPanel.tsx
// (2026-07-17 benchmark UX overhaul, Task 4 Step 1). No behavior changes: the
// two entry points (`runSelected`, `runGameIqMultiModel`) and their pure
// helpers moved out of the component unchanged; component-local reads/setters
// that they used as closures became explicit `ctx` fields instead. Several
// helpers below are *shared* with CertifiedRunPanel.tsx's render code (e.g.
// TRACK_OPTIONS, fireworksCasesForSuiteId, workBenchModelsForRun, DIRECT_MODEL_HARNESS) —
// they live here as the single source of truth and the panel imports them back.
"use client";

import type { Dispatch, MutableRefObject, SetStateAction } from "react";
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
import {
  classifyGameIqModelRunOutcome,
  gameIqBundlePackIds,
  gameIqPackRunContext,
  isGameIqBundleSuite,
  listCertifiedSuiteOptions,
  reidGameIqPackAttempt,
  type CertifiedRunnableTrack,
} from "@/lib/benchmark/certified/suite-options";
import { isFireworksSuite } from "@/lib/benchmark/certified/ui-gates";
import { runHarnessCertification } from "@/lib/benchmark/certified/certification";
import type { CertifiedRunSummary } from "@/lib/benchmark/certified/run-status";
import {
  checkBenchRunner,
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
  fireworksCaseToBenchmarkCaseV2,
  getFireworksRuntimeCasesForSuite,
  type FireworksBenchmarkCase,
  type FireworksBenchmarkSuite,
} from "@/lib/benchmark/fireworks";
import {
  GAMEIQ_SCORING_VERSION,
  listGameIqScenarioPacks,
  runCertifiedGameIq,
} from "@/lib/benchmark/gameiq";
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
  publishBenchmarkResultSetIfComplete,
  type ResultSetOwnershipMap,
} from "./result-set-publication";

export const DIRECT_MODEL_HARNESS: HarnessProfile = "raw-single-model";
export const TEAM_HARNESS: HarnessProfile = "aiboard-panel";
const DEFAULT_CERTIFIED_MODEL_CALL_TIMEOUT_MS = 120_000;

// GameIQ runs every selected model as its own certified run. Each admitted
// model fans out to four scenario calls, so two concurrent model runs bound
// aggregate provider pressure to eight calls while queued models wait.
export const MAX_PARALLEL_GAMEIQ_MODELS = 2;
export const MAX_PARALLEL_GAMEIQ_SCENARIOS_PER_MODEL = 4;

export type RunnableTrack = CertifiedRunnableTrack;
export type TeamIqUiStrategy = Exclude<TeamIqStrategy, "solo">;
export type CertifiedRunPhase = "idle" | "certifying" | "running" | "persisting" | "done";

export const TRACK_OPTIONS: Array<{ id: RunnableTrack; label: string }> = [
  { id: "gameiq", label: "GameIQ" },
  { id: "toolreliability", label: "Tool Reliability" },
  { id: "teamiq", label: "TeamIQ" },
  { id: "workbench", label: "WorkBench" },
];

// "passed" = the run completed AND every pack attempt passed its verifier.
// "partial" = completed but only some packs passed. "failed" = the run errored
// OR completed with zero passing packs (the model's answers scored nothing).
// Basing this on the actual attempt outcomes — not merely on the run
// completing — keeps a model that scored 0 from showing a green "Passed".
export type GameIqModelRunStatus =
  | "queued"
  | "running"
  | "passed"
  | "partial"
  | "failed"
  | "cancelled";

export interface GameIqModelRunState {
  modelId: string;
  displayName: string;
  providerId: string;
  status: GameIqModelRunStatus;
  summary?: CertifiedRunSummary;
  /** Packs whose attempt passed its verifier, out of packs scored. */
  packsPassed?: number;
  packsScored?: number;
  /** Mean verified quality (0-100) across the model's pack attempts. */
  avgQuality?: number;
  error?: string;
}

// Shared "run in progress" plumbing both runSelected and runGameIqMultiModel
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
  if (reason instanceof Error) return reason.message;
  if (typeof reason === "string" && reason.length > 0) return reason;
  return reason === undefined
    ? "Certified run aborted by user."
    : String(reason);
}

export interface RunSelectedContext extends CertifiedRunActions {
  selectedTrack: RunnableTrack;
  suiteId: string;
  models: SelectedModel[];
  modelId: string;
  teamModelIds: string[];
  teamIqStrategy: TeamIqUiStrategy;
  fireworksPlayerCount: 2 | 3;
  includeSoloBaselines: boolean;
  workBenchModelIds: string[];
  workBenchRoleMode: WorkBenchRoleMode;
  workBenchRunnerUrl: string;
  workBenchRunnerToken: string;
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
    fireworksPlayerCount,
    includeSoloBaselines,
    workBenchModelIds,
    workBenchRoleMode,
    workBenchRunnerUrl,
    workBenchRunnerToken,
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
  } = ctx;
  if (!suiteId) return;
  if (selectedTrack === "gameiq") {
    // GameIQ has its own multi-model entry point (runGameIqMultiModel);
    // the single-model flow below never handles it.
    return;
  }
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
      signal
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
  try {
    throwIfCertifiedRunAborted(abortController.signal);
    const initialTeams =
      selectedTrack === "teamiq"
        ? teamIqCompositionsForRun({
            models,
            selectedModelIds: teamModelIds,
            strategy: teamIqStrategy,
            suiteId,
            roleMode: isFireworksSuite(suiteId)
              ? "fireworks_players"
              : "default",
            playerCount: fireworksPlayerCount,
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
    const teams =
      selectedTrack === "teamiq"
        ? expandTeamIqTeamsBeforeExecution(
            initialTeams,
            isFireworksSuite(suiteId) ? includeSoloBaselines : true
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
        : [caseForSelection(selectedTrack, suiteId, fireworksPlayerCount)];
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
            executionId:
              executionId ??
              `execution-${selectedTrack}-${Date.now()}-${Math.random()
                .toString(16)
                .slice(2, 10)}`,
            runId,
            suiteId:
              selectedTrack === "workbench"
                ? suiteId
                : `suite-${selectedTrack}`,
            track: selectedTrack,
            teams,
            cases: caseRecords,
          });
    throwIfCertifiedRunAborted(abortController.signal);
    const result = await runCertifiedBenchmark({
      runId,
      suiteId: selectedTrack === "workbench" ? suiteId : `suite-${selectedTrack}`,
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
            teamCompositionIds: [primaryTeam.id],
            teamCompositions: [primaryTeam],
            signal: options?.signal,
            runBuild: (buildInput) =>
              runNativeWorkBenchBuild({
                ...buildInput,
                context,
                models: workBenchSelectedModels,
                teamComposition: primaryTeam,
              }),
          });
        }
        return runCertifiedTeamIq({
          context,
          teamCompositions: teams,
          task: teamIqTaskForSuite(suiteId, fireworksPlayerCount),
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

export interface RunGameIqMultiModelContext extends CertifiedRunActions {
  models: SelectedModel[];
  gameIqModelIds: string[];
  suiteId: string;
  fireworksPlayerCount: 2 | 3;
  certification: HarnessCertificationResult;
  setGameIqModelRuns: Dispatch<SetStateAction<GameIqModelRunState[]>>;
  effortByModelId: BenchmarkModelEffortMap;
  executionId?: string;
  runIdsByModelId?: Record<string, string>;
  resultSetIdsByModelId?: Record<string, string>;
  allowIncompletePublication?: boolean;
}

export async function runGameIqMultiModel(
  ctx: RunGameIqMultiModelContext
): Promise<void> {
  const {
    models,
    gameIqModelIds,
    suiteId,
    fireworksPlayerCount,
    certification,
    runAbortRef,
    setRunning,
    setRunPhase,
    setSummary,
    setMessage,
    setGameIqModelRuns,
    effortByModelId,
    signal,
    onComplete,
    executionId,
    runIdsByModelId,
    resultSetIdsByModelId,
    allowIncompletePublication,
  } = ctx;
  const selectedModels = gameIqModelIds
    .map((id) => models.find((candidate) => candidate.modelId === id))
    .filter((model): model is SelectedModel => Boolean(model));
  if (selectedModels.length === 0) return;

  function updateGameIqModelRun(
    modelId: string,
    patch: Partial<GameIqModelRunState>
  ) {
    setGameIqModelRuns((current) =>
      current.map((run) =>
        run.modelId === modelId ? { ...run, ...patch } : run
      )
    );
  }

  const { controller: abortController, unlink } = linkRunController(signal);
  runAbortRef.current = abortController;
  setRunning(true);
  setRunPhase("certifying");
  setSummary(null);
  setMessage(null);
  setGameIqModelRuns(
    selectedModels.map((model) => ({
      modelId: model.modelId,
      displayName: model.displayName,
      providerId: model.providerId,
      status: "queued",
    }))
  );

  // GameIQ expands the selected suite to its concrete pack ids: the "All
  // GameIQ packs" bundle becomes one case (and one scored attempt) per pack,
  // so leaderboard attribution stays per-pack; a single-pack selection stays
  // a single case. The pack case ids are model-independent, so we build the
  // shared cases once and reuse them for every selected model.
  const gameIqPackIds = gameIqBundlePackIds(suiteId);
  const caseRecords = gameIqPackIds.map((packId) =>
    caseForSelection("gameiq", packId, fireworksPlayerCount)
  );
  const batchStamp = Date.now();
  const execution =
    executionId ??
    `execution-gameiq-${batchStamp}-${Math.random().toString(16).slice(2, 10)}`;
  const teamsByModelId = new Map(
    selectedModels.map((model) => [
      model.modelId,
      deriveSoloTeamComposition({
        modelId: model.modelId,
        providerId: model.providerId,
        displayName: model.displayName,
        reasoningEffort: normalizeBenchmarkEffortForModel(
          model,
          effortByModelId[model.modelId]
        ),
      }),
    ])
  );
  const plannedRunIds = Object.fromEntries(
    selectedModels.map((model, index) => [
      model.modelId,
      runIdsByModelId?.[model.modelId] ??
        `ui-gameiq-${batchStamp}-${slugForRunId(
          model.providerId
        )}-${slugForRunId(model.modelId)}-${index}`,
    ])
  );
  const publicationByModelId = new Map<
    string,
    { ownership: ResultSetOwnershipMap; resultSetIds: string[] }
  >();

  try {
    throwIfCertifiedRunAborted(abortController.signal);
    await saveHarnessCertificationResult(certification);
    throwIfCertifiedRunAborted(abortController.signal);
    for (const caseRecord of caseRecords) {
      throwIfCertifiedRunAborted(abortController.signal);
      await saveBenchmarkCaseV2(caseRecord);
      throwIfCertifiedRunAborted(abortController.signal);
    }
    for (const model of selectedModels) {
      const team = teamsByModelId.get(model.modelId)!;
      const existingResultSetId = resultSetIdsByModelId?.[model.modelId];
      publicationByModelId.set(
        model.modelId,
        existingResultSetId
          ? {
              ownership: {
                defaultResultSetId: existingResultSetId,
                byTeamCompositionId: { [team.id]: existingResultSetId },
              },
              resultSetIds: [existingResultSetId],
            }
          : await planResultSetsForRun({
              executionId: execution,
              runId: plannedRunIds[model.modelId]!,
              suiteId: "suite-gameiq",
              track: "gameiq",
              teams: [team],
              cases: caseRecords,
            })
      );
    }
    setRunPhase("running");

    const runOneModel = async (
      model: SelectedModel,
      index: number
    ): Promise<GameIqModelRunState> => {
      throwIfCertifiedRunAborted(abortController.signal);
      updateGameIqModelRun(model.modelId, { status: "running" });
      // Unique per model even if two runs start in the same millisecond: the
      // batch index disambiguates the shared timestamp.
      const runId = plannedRunIds[model.modelId]!;
      const team = teamsByModelId.get(model.modelId)!;
      const publication = publicationByModelId.get(model.modelId)!;
      throwIfCertifiedRunAborted(abortController.signal);
      await saveBenchmarkTeamComposition(team);
      throwIfCertifiedRunAborted(abortController.signal);
      // Capture this model's pack attempts from inside the runner so the
      // per-model badge reflects the real scores, not just run completion.
      let capturedAttempts: BenchmarkAttempt[] = [];
      const result = await runCertifiedBenchmark({
        runId,
        suiteId: "suite-gameiq",
        track: "gameiq",
        harnessProfile: DIRECT_MODEL_HARNESS,
        caseIds: caseRecords.map((caseRecord) => caseRecord.id),
        teamCompositionIds: [team.id],
        modelBudget: certifiedRunBudgetForCases(caseRecords, {
          maxModelCallMs: DEFAULT_CERTIFIED_MODEL_CALL_TIMEOUT_MS,
        }),
        certification,
        signal: abortController.signal,
        resultSetOwnership: publication.ownership,
        runner: async (context, options) => {
          // Run each selected pack as its own attempt so the bundle produces
          // one scored attempt per pack (distinct caseId + attempt id). The
          // certified GameIQ runner keys its attempt/verifier ids off the run
          // id alone, so a shared context would collide across packs; the
          // per-pack wrapper below scopes the case id and re-ids the returned
          // attempts and their verifiers by pack.
          const attempts: BenchmarkAttempt[] = [];
          for (const packId of gameIqPackIds) {
            throwIfCertifiedRunAborted(options?.signal);
            const packContext = gameIqPackRunContext(context, packId);
            const packAttempts = await runCertifiedGameIq({
              context: packContext,
              models: [model],
              scenarioPackIds: [packId],
              teamCompositionIds: [team.id],
              teamCompositions: [team],
              trials: 1,
              signal: options?.signal,
              // Scenario calls are independent single calls; this per-model
              // cap combines with the two-model cap above for eight calls.
              concurrency: MAX_PARALLEL_GAMEIQ_SCENARIOS_PER_MODEL,
            });
            throwIfCertifiedRunAborted(options?.signal);
            const reidd = packAttempts.map((attempt) =>
              reidGameIqPackAttempt(attempt, packId)
            );
            // Persist immediately: a fatal/budget failure in a LATER pack
            // must not void packs that already completed and verified
            // (createFailedAttemptsForRunError in run-engine.ts skips
            // already-recorded cases via its existingKeys check). Record
            // against the OUTER context — reidGameIqPackAttempt already
            // scopes the id/caseId/verifierResultId by pack, so no
            // packContext is needed here.
            throwIfCertifiedRunAborted(options?.signal);
            await persistReturnedAttempts(context, reidd);
            throwIfCertifiedRunAborted(options?.signal);
            attempts.push(...reidd);
            capturedAttempts = [...attempts];
          }
          // Already recorded incrementally above; returning attempts here
          // too would double-record (harmless — recordAttempt is a
          // Map-by-id and persistFailureForAttempt checks recordedFailureIds
          // — but returning [] keeps the final persistReturnedAttempts a
          // clean no-op).
          return [];
        },
      });
      await terminalizeRunPublication(
        publication.resultSetIds,
        result,
        abortController.signal,
        allowIncompletePublication
      );
      throwIfCertifiedRunAborted(abortController.signal);
      // runCertifiedBenchmark resolves (not rejects) on a failed run, folding
      // the provider/budget error into the summary status; treat that as a
      // failure for the batch tally too.
      if (result.status !== "completed") {
        // The run itself failed (fatal/budget error mid-run), but packs
        // already recorded before the failure are preserved by the engine
        // (see run-engine.ts's existingKeys skip). Surface those partial
        // numbers on the row instead of a bare failure so the badge can
        // read e.g. "failed (4/7 packs scored)".
        const partialOutcome =
          capturedAttempts.length > 0
            ? classifyGameIqModelRunOutcome(false, capturedAttempts)
            : undefined;
        const baseError = result.error ?? "Run did not complete.";
        const state: GameIqModelRunState = {
          modelId: model.modelId,
          displayName: model.displayName,
          providerId: model.providerId,
          status: "failed",
          summary: result,
          packsScored: partialOutcome?.packsScored,
          packsPassed: partialOutcome?.packsPassed,
          avgQuality: partialOutcome?.avgQuality,
          error: partialOutcome
            ? `${baseError} (${partialOutcome.packsPassed}/${partialOutcome.packsScored} packs scored before the failure)`
            : baseError,
        };
        updateGameIqModelRun(model.modelId, state);
        return state;
      }
      // Derive the real outcome from the pack attempts (a "failed_model"
      // attempt completes the run but scored 0), not from run completion.
      const outcome = classifyGameIqModelRunOutcome(true, capturedAttempts);
      const state: GameIqModelRunState = {
        modelId: model.modelId,
        displayName: model.displayName,
        providerId: model.providerId,
        status: outcome.status,
        summary: result,
        packsScored: outcome.packsScored,
        packsPassed: outcome.packsPassed,
        avgQuality: outcome.avgQuality,
        error:
          outcome.status === "failed"
            ? "The model completed the run but did not pass any pack (scored 0)."
            : undefined,
      };
      updateGameIqModelRun(model.modelId, state);
      return state;
    };

    // Promise.allSettled isolation: one model failing (provider error, budget,
    // thrown runner) does not abort the others. A per-model throw still resolves
    // to a "failed" row so the batch tally stays accurate.
    const settled = await mapWithConcurrency(
      selectedModels,
      MAX_PARALLEL_GAMEIQ_MODELS,
      async (model, index) => {
        // A worker that just finished an active model can claim the next queued
        // index after the shared batch was cancelled. Resolve that row before
        // runOneModel marks it running or persists its team/run/attempt.
        if (abortController.signal.aborted) {
          const cancellationError = abortReasonMessage(abortController.signal);
          const state: GameIqModelRunState = {
            modelId: model.modelId,
            displayName: model.displayName,
            providerId: model.providerId,
            status: "cancelled",
            error: cancellationError,
          };
          updateGameIqModelRun(model.modelId, state);
          return state;
        }
        try {
          const state = await runOneModel(model, index);
          if (!abortController.signal.aborted) return state;
          const cancelledState: GameIqModelRunState = {
            modelId: model.modelId,
            displayName: model.displayName,
            providerId: model.providerId,
            status: "cancelled",
            error: abortReasonMessage(abortController.signal),
          };
          updateGameIqModelRun(model.modelId, cancelledState);
          return cancelledState;
        } catch (error) {
          const publication = publicationByModelId.get(model.modelId);
          if (publication) {
            for (const resultSetId of publication.resultSetIds) {
              if (abortController.signal.aborted) {
                await cancelBenchmarkResultSet(
                  resultSetId,
                  abortReasonMessage(abortController.signal)
                );
              } else {
                await failBenchmarkResultSet(resultSetId, {
                  kind: "infrastructure",
                  code: "unpublished_infrastructure_failure",
                  message:
                    error instanceof Error ? error.message : String(error),
                });
              }
            }
          }
          const state: GameIqModelRunState = {
            modelId: model.modelId,
            displayName: model.displayName,
            providerId: model.providerId,
            status: abortController.signal.aborted ? "cancelled" : "failed",
            error: abortController.signal.aborted
              ? abortReasonMessage(abortController.signal)
              : error instanceof Error
                ? error.message
                : String(error),
          };
          updateGameIqModelRun(model.modelId, state);
          return state;
        }
      }
    );
    throwIfCertifiedRunAborted(abortController.signal);

    const passed = settled.filter((run) => run.status === "passed").length;
    const partial = settled.filter((run) => run.status === "partial").length;
    const failed = settled.filter((run) => run.status === "failed").length;
    const cancelled = settled.filter((run) => run.status === "cancelled").length;
    const tally = [
      `${passed} passed`,
      ...(partial > 0 ? [`${partial} partial`] : []),
      `${failed} failed`,
      ...(cancelled > 0 ? [`${cancelled} cancelled`] : []),
    ].join(", ");
    setRunPhase("persisting");
    setMessage(
      `Ran ${settled.length} model${
        settled.length === 1 ? "" : "s"
      } on ${gameIqSuiteLabel(suiteId)}: ${tally}`
    );
    throwIfCertifiedRunAborted(abortController.signal);
    await onComplete();
    throwIfCertifiedRunAborted(abortController.signal);
    setRunPhase("done");
  } catch (error) {
    setRunPhase("idle");
    if (abortController.signal.aborted) {
      const cancellationError = abortReasonMessage(abortController.signal);
      setGameIqModelRuns((current) =>
        current.map((run) =>
          run.status === "passed" ||
          run.status === "partial" ||
          run.status === "failed"
            ? run
            : {
                ...run,
                status: "cancelled",
                error: cancellationError,
              }
        )
      );
      setMessage(cancellationError);
    } else {
      setMessage(error instanceof Error ? error.message : String(error));
    }
  } finally {
    setRunning(false);
    if (runAbortRef.current === abortController) {
      runAbortRef.current = null;
    }
    unlink();
  }
}

// Runs `mapper` over `items` with at most `limit` in flight at once, preserving
// input order in the returned array. Used to cap how many GameIQ model runs open
// their provider calls simultaneously (see MAX_PARALLEL_GAMEIQ_MODELS), and
// reused by runPreset's solo legs for non-GameIQ tracks (ToolReliability).
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

function gameIqSuiteLabel(suiteId: string): string {
  const option = listCertifiedSuiteOptions("gameiq").find(
    (candidate) => candidate.id === suiteId
  );
  return option?.label ?? (isGameIqBundleSuite(suiteId) ? "all GameIQ packs" : suiteId);
}

export function caseForSelection(
  track: RunnableTrack,
  suiteId: string,
  fireworksPlayerCount: 2 | 3
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
        "Current schema, tool-call, large-file patch, repair, and safety challenge pack (33 distinct cases).",
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
    if (isFireworksSuite(suiteId)) {
      return fireworksCaseToBenchmarkCaseV2(
        suiteId,
        fireworksSuiteForSuiteId(suiteId),
        fireworksPlayerCount
      );
    }
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
  const pack = listGameIqScenarioPacks().find((candidate) => candidate.id === suiteId) ?? null;
  return {
    id: suiteId,
    schemaVersion: 2,
    track: "gameiq",
    title: pack?.label ?? suiteId,
    description: "Certified GameIQ scenario pack.",
    difficulty: pack?.certificationTier === "first-class" ? "medium" : "easy",
    tags: ["gameiq", pack?.gameId ?? "unknown"],
    caseVersion: "1.0.0",
    createdAt: timestamp,
    updatedAt: timestamp,
    prompt: {
      userRequest: "Solve each GameIQ scenario.",
      publicContext: JSON.stringify({
        gameId: pack?.gameId ?? "connect-four",
        scenarioPackId: suiteId,
        scenarioCount: pack?.scenarios.length ?? 0,
      }),
    },
    environment: { type: "browser", timeoutSeconds: 60, network: "none" },
    verifier: { scorer: "game-engine" },
    budget: { maxUsd: 5, maxWallClockSeconds: 600, maxModelCalls: 100 },
    // Live constant, not a literal: this case record is PERSISTED via
    // saveBenchmarkCaseV2 on every UI run and must agree with the attempt's
    // scoringVersion stamp (same invariant as TEAMIQ_SCORING_VERSION in
    // lib/benchmark/teamiq/certified-runner.ts).
    scoring: { scoringVersion: GAMEIQ_SCORING_VERSION, primary: "game_iq" },
    contamination: {
      originalTask: true,
      canary: "AIBENCH-UI-GAMEIQ",
      referenceSolutionPrivate: true,
    },
  };
}

function expandTeamIqTeamsBeforeExecution(
  teams: BenchmarkTeamComposition[],
  includeSoloBaselines: boolean
): BenchmarkTeamComposition[] {
  if (!includeSoloBaselines) return teams;
  const solos = new Map<string, BenchmarkTeamComposition>();
  for (const team of teams) {
    for (const role of team.roles) {
      const key = [
        role.providerId,
        role.modelId,
        normalizeBenchmarkReasoningEffort(role.reasoningEffort),
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
        maxTokens: role.maxTokens ?? null,
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
          maxTokens: null,
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
  allowIncomplete = false
): Promise<void> {
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
      await publishBenchmarkResultSetIfComplete(resultSetId);
    } catch (error) {
      if (allowIncomplete) continue;
      await failBenchmarkResultSet(resultSetId, {
        kind: "infrastructure",
        code: "incomplete_benchmark_output",
        message: error instanceof Error ? error.message : String(error),
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

function teamIqTaskForSuite(
  suiteId: string,
  fireworksPlayerCount: 2 | 3
) {
  if (isFireworksSuite(suiteId)) {
    return {
      kind: "fireworks" as const,
      suite: fireworksSuiteForSuiteId(suiteId),
      cases: fireworksCasesForSuiteId(suiteId, fireworksPlayerCount),
    };
  }
  return {
    kind: "toolreliability" as const,
    casePack: teamIqToolReliabilityCasePackForSuite(suiteId),
  };
}

export function teamIqCompositionsForRun(input: {
  models: SelectedModel[];
  selectedModelIds: string[];
  strategy: TeamIqUiStrategy;
  suiteId: string;
  roleMode: "default" | "fireworks_players";
  playerCount: 2 | 3;
  effortByModelId: BenchmarkModelEffortMap;
}): BenchmarkTeamComposition[] {
  if (
    input.roleMode === "default" &&
    isTeamIqToolReliabilityAllModesSuite(input.suiteId)
  ) {
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
      roleMode: input.roleMode,
      playerCount: input.playerCount,
      effortByModelId: input.effortByModelId,
      roleAssignments:
        input.roleMode === "default" &&
        !isTeamIqToolReliabilityAllModesSuite(input.suiteId)
          ? roleAssignmentsForTeamIqSelection(input)
          : undefined,
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

export function fireworksSuiteForSuiteId(suiteId: string): FireworksBenchmarkSuite {
  if (suiteId.includes("-tactics-")) return "tactics";
  if (suiteId.includes("-memory-")) return "memory";
  if (suiteId.includes("-full-")) return "full";
  return "mixed";
}

export function fireworksCasesForSuiteId(
  suiteId: string,
  playerCount: 2 | 3
): FireworksBenchmarkCase[] {
  return getFireworksRuntimeCasesForSuite(
    fireworksSuiteForSuiteId(suiteId),
    playerCount
  );
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
// time, looped with a concurrency cap for solo legs) or runGameIqMultiModel
// (already a multi-model batch) exactly as the Advanced/old flow does; the
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
  status: GameIqModelRunStatus;
  detail?: string;
}

export type PresetProgressEvent = PresetLegProgress | PresetModelProgress;

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
  fireworksPlayerCount: 2 | 3;
  signal: AbortSignal;
  onComplete: () => Promise<void>;
}

interface ModelIqPublicationPlan {
  executionId: string;
  gameRunIdsByModelId: Record<string, string>;
  toolRunIdsByModelId: Record<string, string>;
  resultSetIdsByModelId: Record<string, string>;
}

async function planModelIqPresetPublication(
  preset: BenchmarkPreset,
  ctx: RunPresetContext
): Promise<ModelIqPublicationPlan | undefined> {
  const gameLeg = preset.legs.find(
    (leg) => leg.mode === "solo" && leg.track === "gameiq"
  );
  const toolLeg = preset.legs.find(
    (leg) => leg.mode === "solo" && leg.track === "toolreliability"
  );
  if (!gameLeg || !toolLeg) return undefined;
  const models = ctx.soloModelIds
    .map((id) => ctx.models.find((candidate) => candidate.modelId === id))
    .filter((model): model is SelectedModel => Boolean(model));
  if (models.length === 0) return undefined;

  const executionId = `execution-modeliq-${Date.now()}-${Math.random()
    .toString(16)
    .slice(2, 10)}`;
  const gameCases = gameIqBundlePackIds(gameLeg.suiteId).map((packId) =>
    caseForSelection("gameiq", packId, ctx.fireworksPlayerCount)
  );
  const toolCase = caseForSelection(
    "toolreliability",
    toolLeg.suiteId,
    ctx.fireworksPlayerCount
  );
  for (const item of [...gameCases, toolCase]) {
    await saveBenchmarkCaseV2(item);
  }
  const gameRunIdsByModelId: Record<string, string> = {};
  const toolRunIdsByModelId: Record<string, string> = {};
  const resultSetIdsByModelId: Record<string, string> = {};
  for (const [index, model] of models.entries()) {
    const team = deriveSoloTeamComposition({
      modelId: model.modelId,
      providerId: model.providerId,
      displayName: model.displayName,
      reasoningEffort: normalizeBenchmarkEffortForModel(
        model,
        ctx.effortByModelId[model.modelId]
      ),
    });
    await saveBenchmarkTeamComposition(team);
    const gameRunId = `ui-gameiq-${slugForRunId(executionId)}-${index}`;
    const toolRunId = `ui-toolreliability-${slugForRunId(executionId)}-${index}`;
    const resultSetId = `result-${slugForRunId(executionId)}-${slugForRunId(
      model.modelId
    )}-${index}`;
    const tracks = [
      {
        track: "gameiq" as const,
        suiteId: "suite-gameiq",
        caseManifest: gameCases.map((item) => ({
          caseId: item.id,
          caseVersion: item.caseVersion,
          scoringVersion: item.scoring.scoringVersion,
        })),
        maxTokens: null,
      },
      {
        track: "toolreliability" as const,
        suiteId: "suite-toolreliability",
        caseManifest: [{
          caseId: toolCase.id,
          caseVersion: toolCase.caseVersion,
          scoringVersion: toolCase.scoring.scoringVersion,
        }],
        maxTokens: null,
      },
    ];
    const configuration = {
      subjectKind: "model" as const,
      displayName: model.displayName,
      providerId: model.providerId,
      modelId: model.modelId,
      reasoningEffort: team.roles[0]?.reasoningEffort ?? "default",
      roles: team.roles.map((role) => ({
        role: role.role,
        slot: role.slot,
        providerId: role.providerId,
        modelId: role.modelId,
        reasoningEffort: role.reasoningEffort ?? "default",
        maxTokens: role.maxTokens ?? null,
      })),
      tracks,
    };
    await createPendingBenchmarkResultSet({
      id: resultSetId,
      schemaVersion: 1,
      executionId,
      anchorRunId: gameRunId,
      runIds: [gameRunId, toolRunId],
      configurationKey: benchmarkResultConfigurationKey(configuration),
      configuration,
      expectedAttempts: [
        ...gameCases.map((item) => ({
          runId: gameRunId,
          track: "gameiq" as const,
          suiteId: "suite-gameiq",
          caseId: item.id,
          caseVersion: item.caseVersion,
          scoringVersion: item.scoring.scoringVersion,
          teamCompositionId: team.id,
        })),
        {
          runId: toolRunId,
          track: "toolreliability" as const,
          suiteId: "suite-toolreliability",
          caseId: toolCase.id,
          caseVersion: toolCase.caseVersion,
          scoringVersion: toolCase.scoring.scoringVersion,
          teamCompositionId: team.id,
        },
      ],
    });
    gameRunIdsByModelId[model.modelId] = gameRunId;
    toolRunIdsByModelId[model.modelId] = toolRunId;
    resultSetIdsByModelId[model.modelId] = resultSetId;
  }
  return {
    executionId,
    gameRunIdsByModelId,
    toolRunIdsByModelId,
    resultSetIdsByModelId,
  };
}

export async function runPreset(
  preset: BenchmarkPreset,
  ctx: RunPresetContext,
  onProgress: (event: PresetProgressEvent) => void
): Promise<void> {
  const modelIqPublication = await planModelIqPresetPublication(preset, ctx);
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
              modelIqPublication
            )
          : await runTeamLeg(leg, legIndex, ctx, onProgress);
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
  if (modelIqPublication) {
    const planned = await listBenchmarkResultSets();
    for (const resultSetId of Object.values(
      modelIqPublication.resultSetIdsByModelId
    )) {
      if (
        planned.find((item) => item.id === resultSetId)?.status !== "pending"
      ) {
        continue;
      }
      if (ctx.signal.aborted) {
        await cancelBenchmarkResultSet(
          resultSetId,
          abortReasonMessage(ctx.signal)
        );
      } else {
        await failBenchmarkResultSet(resultSetId, {
          kind: "infrastructure",
          code: "unpublished_infrastructure_failure",
          message:
            "Preset exited before every expected benchmark attempt was publishable.",
        });
      }
    }
  }
  await ctx.onComplete();
}

async function checkBenchRunnerForLeg(
  config: BenchRunnerConfig,
  signal?: AbortSignal
): Promise<{ ok: boolean; error?: string }> {
  if (!config.url.trim() || !config.token.trim()) {
    return { ok: false, error: "Bench runner not configured." };
  }
  const health = await checkBenchRunner(config, signal);
  if (!health.ok) return { ok: false, error: health.error };
  if (!health.runnerV2?.ready) {
    return {
      ok: false,
      error:
        health.runnerV2?.error ??
        "Managed Runner V2 is unavailable; configure --runner-v2-dir.",
    };
  }
  return { ok: true };
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
  publication?: ModelIqPublicationPlan
): Promise<PresetLegResult> {
  const selectedModels = ctx.soloModelIds
    .map((id) => ctx.models.find((candidate) => candidate.modelId === id))
    .filter((model): model is SelectedModel => Boolean(model));
  if (selectedModels.length === 0) {
    return { status: "skipped", detail: "No models selected." };
  }

  if (leg.track === "gameiq") {
    let latestRuns: GameIqModelRunState[] = [];
    const setGameIqModelRuns: Dispatch<SetStateAction<GameIqModelRunState[]>> = (
      updater
    ) => {
      latestRuns =
        typeof updater === "function"
          ? (updater as (prev: GameIqModelRunState[]) => GameIqModelRunState[])(
              latestRuns
            )
          : updater;
      for (const run of latestRuns) {
        onProgress({
          type: "model",
          legIndex,
          leg,
          modelId: run.modelId,
          displayName: run.displayName,
          status: run.status,
          detail: run.error,
        });
      }
    };
    await runGameIqMultiModel({
      models: ctx.models,
      gameIqModelIds: ctx.soloModelIds,
      suiteId: leg.suiteId,
      fireworksPlayerCount: ctx.fireworksPlayerCount,
      certification: runHarnessCertification(DIRECT_MODEL_HARNESS),
      effortByModelId: ctx.effortByModelId,
      signal: ctx.signal,
      runAbortRef: { current: null },
      setRunning: () => {},
      setRunPhase: () => {},
      setSummary: () => {},
      setMessage: () => {},
      setGameIqModelRuns,
      onComplete: async () => {},
      executionId: publication?.executionId,
      runIdsByModelId: publication?.gameRunIdsByModelId,
      resultSetIdsByModelId: publication?.resultSetIdsByModelId,
      allowIncompletePublication: Boolean(publication),
    });
    return { status: legStatusFromModelRuns(latestRuns) };
  }

  // Every other solo track (currently only ToolReliability) runs one model
  // at a time via runSelected — there is no multi-model batch entry point
  // for it the way GameIQ has — so loop with the same concurrency cap.
  const modelStatuses = new Array<GameIqModelRunStatus>(selectedModels.length);
  let cursor = 0;
  const worker = async () => {
    for (;;) {
      if (ctx.signal.aborted) return;
      const index = cursor;
      if (index >= selectedModels.length) return;
      cursor++;
      if (ctx.signal.aborted) return;
      const model = selectedModels[index]!;
      const plannedResultSetId = publication?.resultSetIdsByModelId[model.modelId];
      if (plannedResultSetId) {
        const planned = (await listBenchmarkResultSets()).find(
          (item) => item.id === plannedResultSetId
        );
        if (planned && planned.status !== "pending") {
          modelStatuses[index] =
            planned.status === "cancelled" ? "cancelled" : "failed";
          onProgress({
            type: "model",
            legIndex,
            leg,
            modelId: model.modelId,
            displayName: model.displayName,
            status: modelStatuses[index]!,
            detail:
              planned.status === "cancelled"
                ? "Cancelled."
                : "Skipped after unpublished infrastructure failure.",
          });
          continue;
        }
      }
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
          fireworksPlayerCount: ctx.fireworksPlayerCount,
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
          onComplete: async () => {},
          executionId: publication?.executionId,
          runId: publication?.toolRunIdsByModelId[model.modelId],
          resultSetOwnership: plannedResultSetId
            ? {
                defaultResultSetId: plannedResultSetId,
                byTeamCompositionId: {
                  [deriveSoloTeamComposition({
                    modelId: model.modelId,
                    providerId: model.providerId,
                    displayName: model.displayName,
                    reasoningEffort: normalizeBenchmarkEffortForModel(
                      model,
                      ctx.effortByModelId[model.modelId]
                    ),
                  }).id]: plannedResultSetId,
                },
              }
            : undefined,
        });
      } catch (error) {
        outcome.error = error instanceof Error ? error.message : String(error);
      }
      const status: GameIqModelRunStatus =
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
  _onProgress: (event: PresetProgressEvent) => void
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
      fireworksPlayerCount: ctx.fireworksPlayerCount,
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
      onComplete: async () => {},
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

function legStatusFromModelRuns(runs: GameIqModelRunState[]): PresetLegStatus {
  if (runs.length === 0) return "skipped";
  return legStatusFromStatuses(runs.map((run) => run.status));
}

function legStatusFromStatuses(
  statuses: GameIqModelRunStatus[]
): PresetLegStatus {
  if (statuses.length === 0) return "skipped";
  if (statuses.every((status) => status === "cancelled")) return "skipped";
  const passed = statuses.filter((status) => status === "passed").length;
  const partial = statuses.filter((status) => status === "partial").length;
  if (passed === statuses.length) return "passed";
  if (passed > 0 || partial > 0) return "partial";
  return "failed";
}
