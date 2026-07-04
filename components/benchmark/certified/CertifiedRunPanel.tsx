"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Play, RefreshCw, Square } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { CaseSuitePicker } from "./CaseSuitePicker";
import { ModelTeamPicker } from "./ModelTeamPicker";
import { RunProgressTimeline } from "./RunProgressTimeline";
import { AttemptDetailPanel } from "./AttemptDetailPanel";
import { TeamCompositionBuilder } from "@/components/benchmark/teamiq/TeamCompositionBuilder";
import { WorkBenchRunPanel } from "@/components/benchmark/workbench/WorkBenchRunPanel";
import type { CertifiedTrackView } from "./CertifiedBenchmarkOverview";
import {
  checkBenchRunner,
  DEFAULT_BENCH_RUNNER_URL,
  type BenchRunnerHealth,
} from "@/lib/client/bench-runner";
import { getEnabledModels } from "@/lib/client/providers";
import {
  saveBenchmarkCaseV2,
  saveBenchmarkTeamComposition,
  saveHarnessCertificationResult,
} from "@/lib/benchmark/store";
import { runHarnessCertification } from "@/lib/benchmark/certified/certification";
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
import {
  adjustFireworksPlayerSelectionForPlayerCount,
  getCertifiedRunGate,
  isFireworksSuite,
} from "@/lib/benchmark/certified/ui-gates";
import type { CertifiedRunSummary } from "@/lib/benchmark/certified/run-status";
import type {
  BenchmarkCaseV2,
  BenchmarkTeamComposition,
  BenchmarkTeamCompositionRole,
  HarnessProfile,
  TeamIqStrategy,
} from "@/lib/benchmark/types";
import {
  createTeamIqCompositionFromSelection,
  createTeamIqToolBenchCompositionsFromSelection,
  deriveSoloTeamComposition,
  deriveTeamComposition,
  runCertifiedTeamIq,
  teamIqToolReliabilityCasePackForSuite,
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

const DIRECT_MODEL_HARNESS: HarnessProfile = "raw-single-model";
const TEAM_HARNESS: HarnessProfile = "aiboard-panel";
const DEFAULT_CERTIFIED_MODEL_CALL_TIMEOUT_MS = 120_000;

// Safety valve: GameIQ runs every selected model as its own certified run. Each
// model already fans out to one provider call per scenario per pack, so an
// unbounded Promise.allSettled over 10 models would open 10x that many calls at
// once. We run models parallel up to this cap and queue the rest.
const MAX_PARALLEL_GAMEIQ_MODELS = 4;

// "passed" = the run completed AND every pack attempt passed its verifier.
// "partial" = completed but only some packs passed. "failed" = the run errored
// OR completed with zero passing packs (the model's answers scored nothing).
// Basing this on the actual attempt outcomes — not merely on the run
// completing — keeps a model that scored 0 from showing a green "Passed".
type GameIqModelRunStatus =
  | "queued"
  | "running"
  | "passed"
  | "partial"
  | "failed";

interface GameIqModelRunState {
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

type RunnableTrack = CertifiedRunnableTrack;
type TeamIqUiStrategy = Exclude<TeamIqStrategy, "solo">;
type CertifiedRunPhase = "idle" | "certifying" | "running" | "persisting" | "done";

const TRACK_OPTIONS: Array<{ id: RunnableTrack; label: string }> = [
  { id: "gameiq", label: "GameIQ" },
  { id: "toolreliability", label: "Tool Reliability" },
  { id: "teamiq", label: "TeamIQ" },
  { id: "workbench", label: "WorkBench" },
];

export function CertifiedRunPanel({
  track,
  onComplete,
  setMessage,
}: {
  track: CertifiedTrackView;
  onComplete: () => Promise<void>;
  setMessage: (message: string | null) => void;
}) {
  const lockedTrack = track === "all" ? null : (track as RunnableTrack);
  const initialTrack: RunnableTrack = lockedTrack ?? "gameiq";
  const [selectedTrack, setSelectedTrack] = useState<RunnableTrack>(initialTrack);
  const [models, setModels] = useState<SelectedModel[]>([]);
  const [modelId, setModelId] = useState("");
  const [gameIqModelIds, setGameIqModelIds] = useState<string[]>([]);
  const [teamModelIds, setTeamModelIds] = useState<string[]>([]);
  const [workBenchRoleMode, setWorkBenchRoleMode] =
    useState<WorkBenchRoleMode>("solo");
  const [workBenchModelIds, setWorkBenchModelIds] = useState<string[]>([]);
  const [teamIqStrategy, setTeamIqStrategy] =
    useState<TeamIqUiStrategy>("architect_worker_reviewer");
  const [fireworksPlayerCount, setFireworksPlayerCount] = useState<2 | 3>(2);
  const [includeSoloBaselines, setIncludeSoloBaselines] = useState(true);
  const [suiteId, setSuiteId] = useState("");
  const [harnessProfile, setHarnessProfile] =
    useState<HarnessProfile>(DIRECT_MODEL_HARNESS);
  const [workBenchRunnerUrl, setWorkBenchRunnerUrl] = useState(
    DEFAULT_BENCH_RUNNER_URL
  );
  const [workBenchRunnerToken, setWorkBenchRunnerToken] = useState("");
  const [workBenchRunnerHealth, setWorkBenchRunnerHealth] =
    useState<BenchRunnerHealth | null>(null);
  const [checkingWorkBenchRunner, setCheckingWorkBenchRunner] = useState(false);
  const [running, setRunning] = useState(false);
  const [runPhase, setRunPhase] = useState<CertifiedRunPhase>("idle");
  const [summary, setSummary] = useState<CertifiedRunSummary | null>(null);
  const [gameIqModelRuns, setGameIqModelRuns] = useState<GameIqModelRunState[]>(
    []
  );
  const runAbortRef = useRef<AbortController | null>(null);

  const suites = useMemo(() => listCertifiedSuiteOptions(selectedTrack), [selectedTrack]);
  const selectedWorkBenchPack = useMemo(
    () => (selectedTrack === "workbench" ? getWorkBenchCasePack(suiteId) : null),
    [selectedTrack, suiteId]
  );
  const effectiveHarnessProfile =
    selectedTrack === "workbench"
      ? workBenchHarnessProfileForRoleMode(workBenchRoleMode)
      : harnessProfile;
  const executionMode = executionModeCopy(
    selectedTrack,
    effectiveHarnessProfile
  );
  const certification = useMemo(
    () => runHarnessCertification(effectiveHarnessProfile),
    [effectiveHarnessProfile]
  );

  useEffect(() => {
    if (lockedTrack && selectedTrack !== lockedTrack) {
      setSelectedTrack(lockedTrack);
    }
  }, [lockedTrack, selectedTrack]);

  useEffect(() => {
    const enabled = getEnabledModels().map((model) => ({
      modelId: `${model.providerId}:${model.id}`,
      providerId: model.providerId,
      displayName: model.name,
      contextProfile: model.contextProfile,
    }));
    setModels(enabled);
    setModelId((current) => current || enabled[0]?.modelId || "");
    setGameIqModelIds((current) =>
      current.length > 0
        ? current.filter((gameIqModelId) =>
            enabled.some((model) => model.modelId === gameIqModelId)
          )
        : enabled[0]
          ? [enabled[0].modelId]
          : []
    );
    setTeamModelIds((current) =>
      current.length > 0
        ? current.filter((modelId) =>
            enabled.some((model) => model.modelId === modelId)
          )
        : enabled.slice(0, 3).map((model) => model.modelId)
    );
    setWorkBenchModelIds((current) =>
      current.length > 0
        ? current.filter((workBenchModelId) =>
            enabled.some((model) => model.modelId === workBenchModelId)
          )
        : enabled.slice(0, 3).map((model) => model.modelId)
    );
  }, []);

  useEffect(() => {
    setSuiteId(suites[0]?.id ?? "");
  }, [suites]);

  useEffect(() => {
    if (selectedTrack === "workbench") {
      const derivedProfile = workBenchHarnessProfileForRoleMode(workBenchRoleMode);
      if (harnessProfile !== derivedProfile) {
        setHarnessProfile(derivedProfile);
      }
      return;
    }
    if (selectedTrack === "teamiq") {
      if (harnessProfile !== TEAM_HARNESS) setHarnessProfile(TEAM_HARNESS);
      return;
    }
    if (harnessProfile !== DIRECT_MODEL_HARNESS) {
      setHarnessProfile(DIRECT_MODEL_HARNESS);
    }
  }, [selectedTrack, workBenchRoleMode, harnessProfile]);

  const runGate = getCertifiedRunGate({
    suiteId,
    running,
    selectedTrack,
    modelId,
    gameIqModelIds,
    teamModelIds,
    workBenchModelIds,
    workBenchRoleMode,
    fireworksPlayerCount: isFireworksSuite(suiteId)
      ? fireworksPlayerCount
      : undefined,
    workBenchRunnerReady:
      selectedTrack !== "workbench" ||
      Boolean(
        workBenchRunnerUrl.trim() &&
          workBenchRunnerToken.trim() &&
          workBenchRunnerHealth?.ok
      ),
    certification,
  });
  const canRun = runGate.canRun;

  return (
    <div className="grid gap-4 xl:grid-cols-[1.1fr_0.9fr]">
      <Card>
        <CardHeader>
          <CardTitle>Run certified benchmark</CardTitle>
          <CardDescription>
            Certified scores come from current cases and deterministic
            verifiers. Lab scores remain exploratory evidence.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div
            className={`grid gap-3 ${lockedTrack ? "md:grid-cols-3" : "md:grid-cols-4"}`}
          >
            {!lockedTrack && (
              <CaseSuitePicker
                value={selectedTrack}
                options={TRACK_OPTIONS}
                ariaLabel="Track"
                onChange={(value) => setSelectedTrack(value as RunnableTrack)}
              />
            )}
            <CaseSuitePicker
              value={suiteId}
              options={suites}
              ariaLabel={
                selectedTrack === "workbench" ? "WorkBench case pack" : "Case suite"
              }
              onChange={setSuiteId}
            />
            {selectedTrack === "gameiq" ? (
              <StaticField
                label="Models"
                value={
                  gameIqModelIds.length >= 1
                    ? `${gameIqModelIds.length} model${
                        gameIqModelIds.length === 1 ? "" : "s"
                      } selected`
                    : "Select at least one model"
                }
              />
            ) : selectedTrack === "teamiq" ? (
              <StaticField
                label="Models"
                value={
                  teamModelIds.length >= 1
                    ? isFireworksSuite(suiteId)
                      ? `${teamModelIds.length} / ${fireworksPlayerCount} Fireworks players selected`
                      : `${teamModelIds.length} models selected`
                    : "Select at least one model"
                }
              />
            ) : selectedTrack === "workbench" ? (
              <StaticField
                label="Models"
                value={workBenchRoleSummary(
                  models,
                  workBenchModelIds,
                  workBenchRoleMode
                )}
              />
            ) : (
              <ModelTeamPicker value={modelId} models={models} onChange={setModelId} />
            )}
            {selectedTrack === "workbench" ? (
              <StaticField
                label="Harness"
                value={executionMode.title}
                description={executionMode.description}
              />
            ) : (
              <StaticField
                label="Execution"
                value={executionMode.title}
                description={executionMode.description}
              />
            )}
          </div>
          {selectedTrack === "gameiq" && (
            <GameIqModelChecklist
              models={models}
              selectedModelIds={gameIqModelIds}
              onChange={setGameIqModelIds}
            />
          )}
          {selectedTrack === "teamiq" && (
            <div className="space-y-4">
              <TeamCompositionBuilder
                models={models}
                selectedModelIds={teamModelIds}
                strategy={teamIqStrategy}
                onChange={setTeamModelIds}
                onStrategyChange={setTeamIqStrategy}
              />
              {isFireworksSuite(suiteId) && (
                <div className="grid gap-3 rounded-md border p-3 text-sm md:grid-cols-3">
                  <label className="space-y-1">
                    <span className="font-medium">Players</span>
                    <select
                      value={fireworksPlayerCount}
                      onChange={(event) => {
                        const nextPlayerCount = Number(event.target.value) as 2 | 3;
                        setFireworksPlayerCount(nextPlayerCount);
                        setTeamModelIds((current) =>
                          adjustFireworksPlayerSelectionForPlayerCount(
                            current,
                            nextPlayerCount
                          )
                        );
                      }}
                      className="w-full rounded-md border bg-background px-3 py-2"
                    >
                      <option value={2}>2-player</option>
                      <option value={3}>3-player</option>
                    </select>
                  </label>
                  <label className="flex items-center gap-2 pt-6">
                    <input
                      type="checkbox"
                      checked={includeSoloBaselines}
                      onChange={(event) =>
                        setIncludeSoloBaselines(event.target.checked)
                      }
                    />
                    <span>Run solo self-play baselines</span>
                  </label>
                  <div className="pt-6 text-muted-foreground">
                    {fireworksCaseCountForSuite(suiteId, fireworksPlayerCount)} Fireworks cases
                  </div>
                  <div className="rounded-md bg-muted/50 px-3 py-2 text-xs text-muted-foreground md:col-span-3">
                    {fireworksPlayerAssignments(
                      models,
                      teamModelIds,
                      fireworksPlayerCount
                    ).join(" / ")}
                  </div>
                </div>
              )}
            </div>
          )}
          {selectedTrack === "workbench" && (
            <div className="space-y-4">
              <WorkBenchRunPanel
                selectedPack={selectedWorkBenchPack}
                runnerUrl={workBenchRunnerUrl}
                runnerToken={workBenchRunnerToken}
                runnerHealth={workBenchRunnerHealth}
                checkingRunner={checkingWorkBenchRunner}
                onRunnerUrlChange={(value) => {
                  setWorkBenchRunnerUrl(value);
                  setWorkBenchRunnerHealth(null);
                }}
                onRunnerTokenChange={(value) => {
                  setWorkBenchRunnerToken(value);
                  setWorkBenchRunnerHealth(null);
                }}
                onCheckRunner={() => void checkWorkBenchRunner()}
              />
              <WorkBenchTeamBuilder
                models={models}
                roleMode={workBenchRoleMode}
                selectedModelIds={workBenchModelIds}
                onRoleModeChange={(next) => {
                  setWorkBenchRoleMode(next);
                  setWorkBenchModelIds((current) =>
                    normalizeWorkBenchModelSelection({
                      models,
                      selectedModelIds: current,
                      roleMode: next,
                    })
                  );
                }}
                onChange={setWorkBenchModelIds}
              />
            </div>
          )}
          {selectedTrack === "gameiq" ? (
            <GameIqModelRunProgress runs={gameIqModelRuns} />
          ) : (
            <RunProgressTimeline
              items={[
                {
                  label: "Select",
                  status:
                    canRun || runPhase !== "idle" || summary ? "done" : "idle",
                },
                {
                  label: "Certify",
                  status:
                    runPhase === "certifying"
                      ? "running"
                      : runPhase === "running" ||
                          runPhase === "persisting" ||
                          runPhase === "done" ||
                          summary
                        ? "done"
                        : "idle",
                },
                {
                  label: "Run",
                  status:
                    runPhase === "running"
                      ? "running"
                      : runPhase === "persisting" ||
                          runPhase === "done" ||
                          summary
                        ? "done"
                        : "idle",
                },
                {
                  label: "Persist",
                  status:
                    runPhase === "persisting"
                      ? "running"
                      : runPhase === "done" || summary
                        ? "done"
                        : "idle",
                },
              ]}
            />
          )}
          <div className="flex flex-wrap gap-2">
            <Button disabled={!canRun} onClick={() => void runSelected()}>
              {running ? <RefreshCw className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
              Run selected benchmark
            </Button>
            {running && (
              <Button variant="outline" onClick={cancelRun}>
                <Square className="h-4 w-4" />
                Cancel
              </Button>
            )}
          </div>
          {!canRun && runGate.reason && (
            <p className="text-sm text-muted-foreground">{runGate.reason}</p>
          )}
          {models.length === 0 && (
            <p className="text-sm text-muted-foreground">
              Add and enable at least one provider key in Settings to run
              certified model calls.
            </p>
          )}
        </CardContent>
      </Card>
      <div className="space-y-4">
        {selectedTrack === "gameiq" ? (
          <GameIqModelRunSummaryPanel runs={gameIqModelRuns} models={models} />
        ) : (
          <AttemptDetailPanel summary={summary} />
        )}
      </div>
    </div>
  );

  async function runSelected() {
    if (!suiteId) return;
    if (selectedTrack === "gameiq") {
      await runGameIqMultiModel();
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

  async function runGameIqMultiModel() {
    const selectedModels = gameIqModelIds
      .map((id) => models.find((candidate) => candidate.modelId === id))
      .filter((model): model is SelectedModel => Boolean(model));
    if (selectedModels.length === 0) return;

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

  function cancelRun() {
    runAbortRef.current?.abort("Cancelled from certified benchmark panel.");
    setMessage("Cancelling certified run...");
  }

  async function checkWorkBenchRunner() {
    setCheckingWorkBenchRunner(true);
    setMessage(null);
    try {
      const health = await checkBenchRunner({
        url: workBenchRunnerUrl.trim(),
        token: workBenchRunnerToken.trim(),
      });
      setWorkBenchRunnerHealth(health);
      setMessage(
        health.ok
          ? "Bench runner connected."
          : health.error ?? "Bench runner check failed."
      );
    } finally {
      setCheckingWorkBenchRunner(false);
    }
  }
}

// Runs `mapper` over `items` with at most `limit` in flight at once, preserving
// input order in the returned array. Used to cap how many GameIQ model runs open
// their provider calls simultaneously (see MAX_PARALLEL_GAMEIQ_MODELS).
async function mapWithConcurrency<T, R>(
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
        "Current schema, tool-call, large-file patch, repair, and safety challenge pack (44 distinct cases).",
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
    }),
  ];
}

function isTeamIqToolReliabilityAllModesSuite(suiteId: string): boolean {
  return suiteId === "teamiq-toolreliability-current-all-modes";
}

function fireworksSuiteForSuiteId(suiteId: string): FireworksBenchmarkSuite {
  if (suiteId.includes("-tactics-")) return "tactics";
  if (suiteId.includes("-memory-")) return "memory";
  if (suiteId.includes("-full-")) return "full";
  return "mixed";
}

function fireworksCasesForSuiteId(
  suiteId: string,
  playerCount: 2 | 3
): FireworksBenchmarkCase[] {
  return getFireworksRuntimeCasesForSuite(
    fireworksSuiteForSuiteId(suiteId),
    playerCount
  );
}

function fireworksCaseCountForSuite(
  suiteId: string,
  playerCount: 2 | 3
): number {
  return fireworksCasesForSuiteId(suiteId, playerCount).length;
}

function fireworksPlayerAssignments(
  models: SelectedModel[],
  selectedModelIds: string[],
  playerCount: 2 | 3
): string[] {
  return Array.from({ length: playerCount }, (_, index) => {
    const modelId = selectedModelIds[index];
    if (!modelId) return `P${index + 1} select model ${index + 1}`;
    const model = models.find((candidate) => candidate.modelId === modelId);
    return `P${index + 1} ${model?.displayName ?? modelId}`;
  });
}

function trackLabel(track: RunnableTrack): string {
  return TRACK_OPTIONS.find((option) => option.id === track)?.label ?? track;
}

function executionModeCopy(track: RunnableTrack, harnessProfile: HarnessProfile): {
  title: string;
  description: string;
} {
  if (track === "gameiq") {
    return {
      title: "Direct model call",
      description: "The model receives the game state and returns one structured move. No AI Board discussion layer is added.",
    };
  }
  if (track === "toolreliability") {
    return {
      title: "Direct tool-use call",
      description: "Each case is a direct schema/tool/patch prompt scored by deterministic validators.",
    };
  }
  if (track === "teamiq") {
    return {
      title: "AI Board team harness",
      description: "Models are assigned team roles, then compared against required solo baselines when applicable.",
    };
  }
  return {
    title: workBenchHarnessProfileLabel(harnessProfile),
    description: "WorkBench uses the local bench runner and Build-mode tool protocol.",
  };
}

function StaticField({
  label,
  value,
  description,
}: {
  label: string;
  value: string;
  description?: string;
}) {
  return (
    <div className="rounded-md border px-3 py-2 text-sm">
      <div className="text-xs font-medium uppercase text-muted-foreground">
        {label}
      </div>
      <div className="mt-1 font-medium leading-snug">{value}</div>
      {description && (
        <div className="mt-1 text-xs leading-snug text-muted-foreground">
          {description}
        </div>
      )}
    </div>
  );
}

function GameIqModelChecklist({
  models,
  selectedModelIds,
  onChange,
}: {
  models: SelectedModel[];
  selectedModelIds: string[];
  onChange: (modelIds: string[]) => void;
}) {
  if (models.length === 0) {
    return (
      <div className="rounded-md border border-dashed px-3 py-2 text-sm text-muted-foreground">
        Add and enable at least one provider model in Settings to run GameIQ.
      </div>
    );
  }
  return (
    <div className="space-y-2">
      <div className="grid gap-2 md:grid-cols-3">
        {models.map((model) => {
          const checked = selectedModelIds.includes(model.modelId);
          return (
            <label
              key={model.modelId}
              className={`flex min-h-16 cursor-pointer items-start gap-2 rounded-md border px-3 py-2 text-sm ${
                checked ? "border-primary bg-primary/5" : "bg-card"
              }`}
            >
              <input
                type="checkbox"
                className="mt-1 h-4 w-4"
                checked={checked}
                onChange={(event) => {
                  if (event.target.checked) {
                    onChange([...selectedModelIds, model.modelId]);
                  } else {
                    onChange(
                      selectedModelIds.filter((id) => id !== model.modelId)
                    );
                  }
                }}
              />
              <span className="min-w-0">
                <span className="block truncate font-medium">
                  {model.displayName || model.modelId}
                </span>
                <span className="block truncate text-xs text-muted-foreground">
                  {model.providerId}
                </span>
              </span>
            </label>
          );
        })}
      </div>
      <p className="text-xs text-muted-foreground">
        {selectedModelIds.length === 0
          ? "Select at least one model. Each selected model runs the benchmark on its own, in parallel."
          : `${selectedModelIds.length} model${
              selectedModelIds.length === 1 ? "" : "s"
            } selected. Each runs the benchmark on its own, in parallel.`}
      </p>
    </div>
  );
}

function GameIqModelRunProgress({ runs }: { runs: GameIqModelRunState[] }) {
  if (runs.length === 0) {
    return (
      <div className="rounded-md border border-dashed px-3 py-3 text-sm text-muted-foreground">
        Select models and start the run to see per-model progress here.
      </div>
    );
  }
  return (
    <div className="space-y-2">
      {runs.map((run) => (
        <div
          key={run.modelId}
          className="flex items-start justify-between gap-3 rounded-md border px-3 py-2 text-sm"
        >
          <div className="min-w-0">
            <div className="truncate font-medium">{run.displayName}</div>
            <div className="truncate text-xs text-muted-foreground">
              {run.providerId}
            </div>
            {run.status === "failed" && run.error && (
              <div className="mt-1 text-xs leading-snug text-destructive">
                {run.error}
              </div>
            )}
          </div>
          <GameIqModelStatusBadge run={run} />
        </div>
      ))}
    </div>
  );
}

function GameIqModelStatusBadge({ run }: { run: GameIqModelRunState }) {
  const label =
    run.status === "queued"
      ? "Queued"
      : run.status === "running"
        ? "Running"
        : run.status === "passed"
          ? "Passed"
          : run.status === "partial"
            ? "Partial"
            : "Failed";
  const tone =
    run.status === "passed"
      ? "border-primary/40 bg-primary/10 text-primary"
      : run.status === "partial"
        ? "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300"
        : run.status === "failed"
          ? "border-destructive/40 bg-destructive/10 text-destructive"
          : run.status === "running"
            ? "border-border bg-muted text-foreground"
            : "border-border bg-muted/50 text-muted-foreground";
  return (
    <span
      className={`shrink-0 rounded-full border px-2 py-0.5 text-xs font-medium ${tone}`}
    >
      {label}
    </span>
  );
}

function GameIqModelRunSummaryPanel({
  runs,
  models,
}: {
  runs: GameIqModelRunState[];
  models: SelectedModel[];
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Per-model results</CardTitle>
        <CardDescription>
          Each selected model runs the GameIQ suite as its own certified run.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-2 text-sm">
        {runs.length === 0 ? (
          <p className="text-muted-foreground">
            {models.length === 0
              ? "Enable a provider model in Settings to run GameIQ."
              : "No run yet. Select models and start the benchmark."}
          </p>
        ) : (
          runs.map((run) => (
            <div key={run.modelId} className="rounded-md border px-3 py-2">
              <div className="flex items-center justify-between gap-2">
                <span className="truncate font-medium">{run.displayName}</span>
                <GameIqModelStatusBadge run={run} />
              </div>
              {run.packsScored !== undefined && run.packsScored > 0 && (
                <div className="mt-1 text-xs text-muted-foreground">
                  Avg quality {Math.round(run.avgQuality ?? 0)} · {run.packsPassed}
                  /{run.packsScored} pack
                  {run.packsScored === 1 ? "" : "s"} passed
                </div>
              )}
              {run.status === "failed" && run.error && (
                <div className="mt-1 text-xs leading-snug text-destructive">
                  {run.error}
                </div>
              )}
            </div>
          ))
        )}
      </CardContent>
    </Card>
  );
}

function WorkBenchTeamBuilder({
  models,
  roleMode,
  selectedModelIds,
  onRoleModeChange,
  onChange,
}: {
  models: SelectedModel[];
  roleMode: WorkBenchRoleMode;
  selectedModelIds: string[];
  onRoleModeChange: (value: WorkBenchRoleMode) => void;
  onChange: (value: string[]) => void;
}) {
  const roleCount = workBenchRoleCount(roleMode);
  const selected = normalizeWorkBenchModelSelection({
    models,
    selectedModelIds,
    roleMode,
  });
  while (selected.length < roleCount) selected.push("");

  return (
    <div className="grid gap-3 rounded-md border p-3 text-sm md:grid-cols-3">
      <label className="space-y-1">
        <span className="font-medium">Team</span>
        <select
          value={roleMode}
          onChange={(event) =>
            onRoleModeChange(event.target.value as WorkBenchRoleMode)
          }
          className="w-full rounded-md border bg-background px-3 py-2"
        >
          <option value="solo">Solo</option>
          <option value="architect_worker">Architect + Worker</option>
          <option value="architect_worker_reviewer">
            Architect + Worker + Reviewer
          </option>
        </select>
      </label>
      {selected.map((modelId, index) => (
        <label key={`${roleMode}-${index}`} className="space-y-1">
          <span className="font-medium">{workBenchRoleLabel(roleMode, index)}</span>
          <select
            value={modelId}
            onChange={(event) => {
              const next = [...selected];
              next[index] = event.target.value;
              onChange(next);
            }}
            className="w-full rounded-md border bg-background px-3 py-2"
          >
            <option value="">Select model</option>
            {models.map((model) => (
              <option key={model.modelId} value={model.modelId}>
                {model.displayName}
              </option>
            ))}
          </select>
        </label>
      ))}
    </div>
  );
}

function workBenchHarnessProfileLabel(harnessProfile: HarnessProfile): string {
  if (harnessProfile === "aiboard-build-single-worker") {
    return "Build single worker";
  }
  if (harnessProfile === "aiboard-build-multi-worker") {
    return "Build multi-worker";
  }
  return "Build harness";
}

function workBenchRoleSummary(
  models: SelectedModel[],
  selectedModelIds: string[],
  roleMode: WorkBenchRoleMode
): string {
  const selected = workBenchModelsForRun(models, selectedModelIds, roleMode);
  const required = workBenchRoleCount(roleMode);
  if (selected.length < required) {
    return `Select ${required} model${required === 1 ? "" : "s"}`;
  }
  if (roleMode === "solo") return selected[0]?.displayName ?? "Solo";
  return selected
    .map(
      (model, index) =>
        `${workBenchRoleLabel(roleMode, index)}: ${model.displayName}`
    )
    .join(" / ");
}

function workBenchModelsForRun(
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

function workBenchRoleFor(
  roleMode: WorkBenchRoleMode,
  index: number
): BenchmarkTeamCompositionRole["role"] {
  if (roleMode === "solo") return "single";
  if (roleMode === "architect_worker") return index === 0 ? "architect" : "worker";
  if (index === 0) return "architect";
  if (index === 1) return "worker";
  return "reviewer";
}

function workBenchRoleLabel(roleMode: WorkBenchRoleMode, index: number): string {
  const role = workBenchRoleFor(roleMode, index);
  switch (role) {
    case "single":
      return "Solo";
    case "architect":
      return "Architect";
    case "worker":
      return "Worker";
    case "reviewer":
      return "Reviewer";
    default:
      return role;
  }
}
