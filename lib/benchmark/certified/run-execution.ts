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
} from "@/lib/benchmark/store";
import { certifiedRunBudgetForCase } from "@/lib/benchmark/certified/run-budget";
import type { CertifiedRunBudget } from "@/lib/benchmark/certified/run-context";
import type { BenchmarkAttemptV2 as BenchmarkAttempt } from "@/lib/benchmark/types";
import { runCertifiedBenchmark } from "@/lib/benchmark/certified/run-engine";
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
  runWorkBenchBuild,
  workBenchCaseToBenchmarkCaseV2,
  workBenchHarnessProfileForRoleMode,
  workBenchRoleCount,
  type WorkBenchRoleMode,
} from "@/lib/benchmark/workbench";
import type { SelectedModel } from "@/lib/providers/base";

export const DIRECT_MODEL_HARNESS: HarnessProfile = "raw-single-model";
export const TEAM_HARNESS: HarnessProfile = "aiboard-panel";
const DEFAULT_CERTIFIED_MODEL_CALL_TIMEOUT_MS = 120_000;

// Safety valve: GameIQ runs every selected model as its own certified run. Each
// model already fans out to one provider call per scenario per pack, so an
// unbounded Promise.allSettled over 10 models would open 10x that many calls at
// once. We run models parallel up to this cap and queue the rest.
export const MAX_PARALLEL_GAMEIQ_MODELS = 4;

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
  | "failed";

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
  setRunning: (running: boolean) => void;
  setRunPhase: (phase: CertifiedRunPhase) => void;
  setSummary: (summary: CertifiedRunSummary | null) => void;
  setMessage: (message: string | null) => void;
  runAbortRef: MutableRefObject<AbortController | null>;
  onComplete: () => Promise<void>;
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
  const abortController = new AbortController();
  runAbortRef.current = abortController;
  setRunning(true);
  setRunPhase("certifying");
  setSummary(null);
  setMessage(null);
  try {
    const teams =
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
          })
        : [
            selectedTrack === "workbench"
              ? createWorkBenchTeamComposition({
                  models: workBenchSelectedModels,
                  roleMode: workBenchRoleMode,
                })
              : deriveSoloTeamComposition({
                  modelId: model!.modelId,
                  providerId: model!.providerId,
                  displayName: model!.displayName,
                }),
          ];
    const primaryTeam = teams[0]!;
    for (const team of teams) {
      await saveBenchmarkTeamComposition(team);
    }
    await saveHarnessCertificationResult(certification);
    setRunPhase("running");
    const runId = `ui-${selectedTrack}-${Date.now()}`;
    const caseRecords =
      selectedTrack === "workbench"
        ? selectedWorkBenchPack
          ? selectedWorkBenchPack.cases.map((caseOption) =>
              workBenchCaseToBenchmarkCaseV2(caseOption)
            )
          : []
        : [caseForSelection(selectedTrack, suiteId, fireworksPlayerCount)];
    for (const caseRecord of caseRecords) {
      await saveBenchmarkCaseV2(caseRecord);
    }
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
      runner: async (context, options) => {
        if (selectedTrack === "toolreliability") {
          return runCertifiedToolReliability({
            context,
            models: [model!],
            teamCompositionIds: [primaryTeam.id],
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
              runWorkBenchBuild({
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
          includeSoloBaselines: isFireworksSuite(suiteId)
            ? includeSoloBaselines
            : true,
          signal: options?.signal,
        });
      },
    });
    setRunPhase("persisting");
    setSummary(result);
    setMessage(
      selectedTrack === "workbench"
        ? `Certified WorkBench pack completed (${caseRecords.length} cases).`
        : `Certified ${trackLabel(selectedTrack)} run completed.`
    );
    await onComplete();
    setRunPhase("done");
  } catch (error) {
    setRunPhase("idle");
    setMessage(error instanceof Error ? error.message : String(error));
  } finally {
    setRunning(false);
    runAbortRef.current = null;
  }
}

export interface RunGameIqMultiModelContext extends CertifiedRunActions {
  models: SelectedModel[];
  gameIqModelIds: string[];
  suiteId: string;
  fireworksPlayerCount: 2 | 3;
  certification: HarnessCertificationResult;
  setGameIqModelRuns: Dispatch<SetStateAction<GameIqModelRunState[]>>;
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
    onComplete,
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

  const abortController = new AbortController();
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

  try {
    await saveHarnessCertificationResult(certification);
    for (const caseRecord of caseRecords) {
      await saveBenchmarkCaseV2(caseRecord);
    }
    setRunPhase("running");

    const batchStamp = Date.now();
    const runOneModel = async (
      model: SelectedModel,
      index: number
    ): Promise<GameIqModelRunState> => {
      updateGameIqModelRun(model.modelId, { status: "running" });
      // Unique per model even if two runs start in the same millisecond: the
      // batch index disambiguates the shared timestamp.
      const runId = `ui-gameiq-${batchStamp}-${slugForRunId(
        model.providerId
      )}-${slugForRunId(model.modelId)}-${index}`;
      const team = deriveSoloTeamComposition({
        modelId: model.modelId,
        providerId: model.providerId,
        displayName: model.displayName,
      });
      await saveBenchmarkTeamComposition(team);
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
        runner: async (context, options) => {
          // Run each selected pack as its own attempt so the bundle produces
          // one scored attempt per pack (distinct caseId + attempt id). The
          // certified GameIQ runner keys its attempt/verifier ids off the run
          // id alone, so a shared context would collide across packs; the
          // per-pack wrapper below scopes the case id and re-ids the returned
          // attempts and their verifiers by pack.
          const attempts: BenchmarkAttempt[] = [];
          for (const packId of gameIqPackIds) {
            const packContext = gameIqPackRunContext(context, packId);
            const packAttempts = await runCertifiedGameIq({
              context: packContext,
              models: [model],
              scenarioPackIds: [packId],
              teamCompositionIds: [team.id],
              trials: 1,
              signal: options?.signal,
              // Scenario calls are independent single calls; concurrency 4
              // cuts wall-clock ~4x and shrinks the provider-failure window.
              concurrency: 4,
            });
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
            await persistReturnedAttempts(context, reidd);
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
        try {
          return await runOneModel(model, index);
        } catch (error) {
          const state: GameIqModelRunState = {
            modelId: model.modelId,
            displayName: model.displayName,
            providerId: model.providerId,
            status: "failed",
            error: error instanceof Error ? error.message : String(error),
          };
          updateGameIqModelRun(model.modelId, state);
          return state;
        }
      }
    );

    const passed = settled.filter((run) => run.status === "passed").length;
    const partial = settled.filter((run) => run.status === "partial").length;
    const failed = settled.filter((run) => run.status === "failed").length;
    const tally = [
      `${passed} passed`,
      ...(partial > 0 ? [`${partial} partial`] : []),
      `${failed} failed`,
    ].join(", ");
    setRunPhase("persisting");
    setMessage(
      `Ran ${settled.length} model${
        settled.length === 1 ? "" : "s"
      } on ${gameIqSuiteLabel(suiteId)}: ${tally}`
    );
    await onComplete();
    setRunPhase("done");
  } catch (error) {
    setRunPhase("idle");
    setMessage(error instanceof Error ? error.message : String(error));
  } finally {
    setRunning(false);
    runAbortRef.current = null;
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

function caseForSelection(
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
        "Current schema, tool-call, large-file patch, repair, and safety challenge pack (29 distinct cases).",
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
      budget: { maxUsd: 5, maxWallClockSeconds: 900, maxModelCalls: 150 },
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

function teamIqCompositionsForRun(input: {
  models: SelectedModel[];
  selectedModelIds: string[];
  strategy: TeamIqUiStrategy;
  suiteId: string;
  roleMode: "default" | "fireworks_players";
  playerCount: 2 | 3;
}): BenchmarkTeamComposition[] {
  if (
    input.roleMode === "default" &&
    isTeamIqToolReliabilityAllModesSuite(input.suiteId)
  ) {
    return createTeamIqToolBenchCompositionsFromSelection({
      models: input.models,
      selectedModelIds: input.selectedModelIds,
    });
  }
  return [
    createTeamIqCompositionFromSelection({
      models: input.models,
      selectedModelIds: input.selectedModelIds,
      strategy: input.strategy,
      roleMode: input.roleMode,
      playerCount: input.playerCount,
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

function createWorkBenchTeamComposition(input: {
  models: SelectedModel[];
  roleMode: WorkBenchRoleMode;
}): BenchmarkTeamComposition {
  if (input.roleMode === "solo") {
    const model = input.models[0];
    return deriveSoloTeamComposition({
      modelId: model.modelId,
      providerId: model.providerId,
      displayName: model.displayName,
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

/** Caps how many models run in parallel within one solo preset leg. */
const MAX_PARALLEL_PRESET_LEG_MODELS = MAX_PARALLEL_GAMEIQ_MODELS;

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
  /** Team builder's role-ordered model ids, reused for TeamIQ AND WorkBench. */
  teamModelIds: string[];
  teamIqStrategy: TeamIqUiStrategy;
  workBenchRoleMode: WorkBenchRoleMode;
  workBenchRunnerUrl: string;
  workBenchRunnerToken: string;
  fireworksPlayerCount: 2 | 3;
  /** Cancel flag the panel's Cancel button flips; checked between legs AND
   * before starting each model within a leg so a cancel takes effect promptly
   * without needing a second AbortController plumbed through every helper. */
  cancelledRef: MutableRefObject<boolean>;
  /** Whichever leg/model call is currently in flight; Cancel aborts this. */
  runAbortRef: MutableRefObject<AbortController | null>;
  onComplete: () => Promise<void>;
}

export async function runPreset(
  preset: BenchmarkPreset,
  ctx: RunPresetContext,
  onProgress: (event: PresetProgressEvent) => void
): Promise<void> {
  ctx.cancelledRef.current = false;
  for (let legIndex = 0; legIndex < preset.legs.length; legIndex++) {
    const leg = preset.legs[legIndex]!;
    if (ctx.cancelledRef.current) {
      onProgress({ type: "leg", legIndex, leg, status: "skipped", detail: "Cancelled." });
      continue;
    }
    if (leg.requires === "bench-runner") {
      const health = await checkBenchRunnerForLeg({
        url: ctx.workBenchRunnerUrl,
        token: ctx.workBenchRunnerToken,
      });
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
    onProgress({ type: "leg", legIndex, leg, status: "running" });
    try {
      const result =
        leg.mode === "solo"
          ? await runSoloLeg(leg, legIndex, ctx, onProgress)
          : await runTeamLeg(leg, legIndex, ctx, onProgress);
      onProgress({ type: "leg", legIndex, leg, status: result.status, detail: result.detail });
    } catch (error) {
      onProgress({
        type: "leg",
        legIndex,
        leg,
        status: "failed",
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  }
  await ctx.onComplete();
}

async function checkBenchRunnerForLeg(
  config: BenchRunnerConfig
): Promise<{ ok: boolean; error?: string }> {
  if (!config.url.trim() || !config.token.trim()) {
    return { ok: false, error: "Bench runner not configured." };
  }
  const health = await checkBenchRunner(config);
  return { ok: health.ok, error: health.error };
}

interface PresetLegResult {
  status: PresetLegStatus;
  detail?: string;
}

async function runSoloLeg(
  leg: BenchmarkPresetLeg,
  legIndex: number,
  ctx: RunPresetContext,
  onProgress: (event: PresetProgressEvent) => void
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
      runAbortRef: ctx.runAbortRef,
      setRunning: () => {},
      setRunPhase: () => {},
      setSummary: () => {},
      setMessage: () => {},
      setGameIqModelRuns,
      onComplete: async () => {},
    });
    return { status: legStatusFromModelRuns(latestRuns) };
  }

  // Every other solo track (currently only ToolReliability) runs one model
  // at a time via runSelected — there is no multi-model batch entry point
  // for it the way GameIQ has — so loop with the same concurrency cap.
  const modelStatuses = await mapWithConcurrency(
    selectedModels,
    MAX_PARALLEL_PRESET_LEG_MODELS,
    async (model): Promise<GameIqModelRunStatus> => {
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
          runAbortRef: ctx.runAbortRef,
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
      const status: GameIqModelRunStatus =
        outcome.summary?.status === "completed" ? "passed" : "failed";
      onProgress({
        type: "model",
        legIndex,
        leg,
        modelId: model.modelId,
        displayName: model.displayName,
        status,
        detail: status === "failed" ? outcome.error : undefined,
      });
      return status;
    }
  );
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
      runAbortRef: ctx.runAbortRef,
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
    outcome.summary?.status === "completed" ? "passed" : "failed";
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
  const passed = statuses.filter((status) => status === "passed").length;
  const partial = statuses.filter((status) => status === "partial").length;
  if (passed === statuses.length) return "passed";
  if (passed > 0 || partial > 0) return "partial";
  return "failed";
}
