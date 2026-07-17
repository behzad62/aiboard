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
import { AttemptDetailPanel } from "./AttemptDetailPanel";
import { TeamCompositionBuilder } from "@/components/benchmark/teamiq/TeamCompositionBuilder";
import { WorkBenchRunPanel } from "@/components/benchmark/workbench/WorkBenchRunPanel";
import {
  ModelChecklist,
  persistModelChecklistSelection,
  readPersistedModelChecklistSelection,
} from "@/components/benchmark/run/ModelChecklist";
import { PresetCards, type PresetCardGate } from "@/components/benchmark/run/PresetCards";
import {
  RunProgressList,
  type RunProgressLegRow,
} from "@/components/benchmark/run/RunProgressList";
import type { CertifiedTrackView } from "./CertifiedBenchmarkOverview";
import {
  checkBenchRunner,
  DEFAULT_BENCH_RUNNER_URL,
  type BenchRunnerHealth,
} from "@/lib/client/bench-runner";
import { getEnabledModels } from "@/lib/client/providers";
import { runHarnessCertification } from "@/lib/benchmark/certified/certification";
import {
  listCertifiedSuiteOptions,
} from "@/lib/benchmark/certified/suite-options";
import {
  adjustFireworksPlayerSelectionForPlayerCount,
  getCertifiedRunGate,
  isFireworksSuite,
} from "@/lib/benchmark/certified/ui-gates";
import type { CertifiedRunSummary } from "@/lib/benchmark/certified/run-status";
import {
  DIRECT_MODEL_HARNESS,
  TEAM_HARNESS,
  TRACK_OPTIONS,
  fireworksCasesForSuiteId,
  isTeamIqToolReliabilityAllModesSuite,
  runGameIqMultiModel as runGameIqMultiModelExec,
  runPreset,
  runSelected as runSelectedTrack,
  workBenchModelsForRun,
  workBenchRoleFor,
  type GameIqModelRunState,
  type PresetProgressEvent,
  type RunnableTrack,
  type TeamIqUiStrategy,
} from "@/lib/benchmark/certified/run-execution";
import {
  BENCHMARK_PRESETS,
  type BenchmarkPreset,
} from "@/lib/benchmark/certified/run-presets";
import type {
  HarnessProfile,
} from "@/lib/benchmark/types";
import {
  normalizeTeamIqModelSelectionForSlots,
  teamIqRoleSlotsForStrategy,
} from "@/lib/benchmark/teamiq";
import {
  getWorkBenchCasePack,
  normalizeWorkBenchModelSelection,
  workBenchHarnessProfileForRoleMode,
  workBenchRoleCount,
  type WorkBenchRoleMode,
} from "@/lib/benchmark/workbench";
import type { SelectedModel } from "@/lib/providers/base";

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

  // --- Shared: which provider models exist, at all -------------------------
  const [models, setModels] = useState<SelectedModel[]>([]);

  // --- New preset-card flow state (2026-07-17 UX overhaul, Task 4 Step 4) --
  // One model checklist, reused by every preset; persisted so repeat runs
  // don't require re-checking models every visit.
  const [soloModelIds, setSoloModelIds] = useState<string[]>(() =>
    readPersistedModelChecklistSelection()
  );
  // One team builder, reused for the TeamIQ leg AND (by model-count mapping;
  // see workBenchRoleModeFromCount below) the WorkBench leg's roles.
  const [sharedTeamModelIds, setSharedTeamModelIds] = useState<string[]>([]);
  const [sharedTeamIqStrategy, setSharedTeamIqStrategy] =
    useState<TeamIqUiStrategy>("architect_worker_reviewer");
  const [focusedPresetId, setFocusedPresetId] =
    useState<BenchmarkPreset["id"]>("model-iq");
  const [presetRunning, setPresetRunning] = useState(false);
  const [runningPresetId, setRunningPresetId] =
    useState<BenchmarkPreset["id"] | null>(null);
  const [presetLegRows, setPresetLegRows] = useState<RunProgressLegRow[]>([]);
  const presetCancelledRef = useRef(false);
  const presetAbortRef = useRef<AbortController | null>(null);

  // --- Advanced (old single-suite/pack flow) state — UNCHANGED behavior ----
  const [selectedTrack, setSelectedTrack] = useState<RunnableTrack>(initialTrack);
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
  // WorkBench runner connection is shared: both the Advanced WorkBench flow
  // and the Full certified preset card's bench-runner gate/note read it.
  const [workBenchRunnerUrl, setWorkBenchRunnerUrl] = useState(
    DEFAULT_BENCH_RUNNER_URL
  );
  const [workBenchRunnerToken, setWorkBenchRunnerToken] = useState("");
  const [workBenchRunnerHealth, setWorkBenchRunnerHealth] =
    useState<BenchRunnerHealth | null>(null);
  const [checkingWorkBenchRunner, setCheckingWorkBenchRunner] = useState(false);
  const [running, setRunning] = useState(false);
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
    setSoloModelIds((current) =>
      current.length > 0
        ? current.filter((soloModelId) =>
            enabled.some((model) => model.modelId === soloModelId)
          )
        : enabled[0]
          ? [enabled[0].modelId]
          : []
    );
    setSharedTeamModelIds((current) =>
      current.length > 0
        ? current.filter((sharedTeamModelId) =>
            enabled.some((model) => model.modelId === sharedTeamModelId)
          )
        : enabled.slice(0, 3).map((model) => model.modelId)
    );
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
    persistModelChecklistSelection(soloModelIds);
  }, [soloModelIds]);

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

  const workBenchRunnerReady = Boolean(
    workBenchRunnerUrl.trim() &&
      workBenchRunnerToken.trim() &&
      workBenchRunnerHealth?.ok
  );
  const focusedPreset =
    BENCHMARK_PRESETS.find((preset) => preset.id === focusedPresetId) ??
    BENCHMARK_PRESETS[0]!;
  const focusedPresetHasTeamLeg = focusedPreset.legs.some(
    (leg) => leg.mode === "team"
  );
  const presetGates = presetCardGates({
    models,
    soloModelIds,
    sharedTeamModelIds,
    workBenchRunnerReady,
  });

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>Run a certified benchmark</CardTitle>
          <CardDescription>
            Check the models you want to measure, then run a preset. Certified
            scores come from current cases and deterministic verifiers.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <ModelChecklist
            models={models}
            selectedModelIds={soloModelIds}
            onChange={setSoloModelIds}
          />
          {focusedPresetHasTeamLeg && (
            <div className="space-y-2 rounded-md border p-3">
              <div className="text-sm font-medium">Team composition</div>
              <p className="text-xs text-muted-foreground">
                Used for the TeamIQ leg; the same role slots (architect /
                worker / reviewer) also drive the WorkBench leg when the
                preset includes one.
              </p>
              <TeamCompositionBuilder
                models={models}
                selectedModelIds={sharedTeamModelIds}
                strategy={sharedTeamIqStrategy}
                onChange={setSharedTeamModelIds}
                onStrategyChange={setSharedTeamIqStrategy}
              />
            </div>
          )}
          <PresetCards
            running={presetRunning}
            runningPresetId={runningPresetId}
            focusedPresetId={focusedPresetId}
            gates={presetGates}
            onFocus={setFocusedPresetId}
            onRun={(preset) => void runPresetFromUi(preset)}
          />
          <RunProgressList
            rows={presetLegRows}
            running={presetRunning}
            onCancel={cancelPresetRun}
          />
          {models.length === 0 && (
            <p className="text-sm text-muted-foreground">
              Add and enable at least one provider key in Settings to run
              certified model calls.
            </p>
          )}
        </CardContent>
      </Card>

      <details className="rounded-md border">
        <summary className="cursor-pointer select-none px-4 py-3 text-sm font-medium">
          Advanced: run a single suite or pack
        </summary>
        <div className="grid gap-4 border-t p-4 xl:grid-cols-[1.1fr_0.9fr]">
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
                    value={teamIqSelectionSummary({
                      models,
                      selectedModelIds: teamModelIds,
                      suiteId,
                      strategy: teamIqStrategy,
                      fireworksPlayerCount,
                    })}
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
                    roleMode={
                      isFireworksSuite(suiteId) ? "fireworks_players" : "default"
                    }
                    playerCount={fireworksPlayerCount}
                    allModes={isTeamIqToolReliabilityAllModesSuite(suiteId)}
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
              {selectedTrack === "gameiq" && (
                <GameIqModelRunProgress runs={gameIqModelRuns} />
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
      </details>
    </div>
  );

  // Sequences runPreset (run-execution.ts) against the shared checklist/team
  // builder above, translating its progress events into RunProgressList rows.
  async function runPresetFromUi(preset: BenchmarkPreset) {
    if (presetRunning) return;
    setFocusedPresetId(preset.id);
    setRunningPresetId(preset.id);
    setPresetRunning(true);
    presetCancelledRef.current = false;
    setPresetLegRows(
      preset.legs.map((leg, legIndex) => ({
        legIndex,
        leg,
        status: "queued",
        models: [],
      }))
    );
    setMessage(null);
    try {
      await runPreset(
        preset,
        {
          models,
          soloModelIds,
          teamModelIds: sharedTeamModelIds,
          teamIqStrategy: sharedTeamIqStrategy,
          workBenchRoleMode: workBenchRoleModeFromCount(
            sharedTeamModelIds.length
          ),
          workBenchRunnerUrl,
          workBenchRunnerToken,
          fireworksPlayerCount: 2,
          cancelledRef: presetCancelledRef,
          runAbortRef: presetAbortRef,
          onComplete,
        },
        handlePresetProgress
      );
    } finally {
      setPresetRunning(false);
      setRunningPresetId(null);
    }
  }

  function handlePresetProgress(event: PresetProgressEvent) {
    setPresetLegRows((current) => {
      const next = [...current];
      if (event.type === "leg") {
        const existing = next[event.legIndex];
        next[event.legIndex] = {
          legIndex: event.legIndex,
          leg: event.leg,
          status: event.status,
          detail: event.detail,
          models: existing?.models ?? [],
        };
      } else {
        const existing = next[event.legIndex] ?? {
          legIndex: event.legIndex,
          leg: event.leg,
          status: "running" as const,
          models: [],
        };
        const models = existing.models.filter(
          (model) => model.modelId !== event.modelId
        );
        models.push({
          modelId: event.modelId,
          displayName: event.displayName,
          status: event.status,
          detail: event.detail,
        });
        next[event.legIndex] = { ...existing, models };
      }
      return next;
    });
  }

  function cancelPresetRun() {
    presetCancelledRef.current = true;
    presetAbortRef.current?.abort("Cancelled from preset run.");
    setMessage("Cancelling preset run...");
  }

  // Dispatches to the extracted run-execution.ts implementations, mirroring
  // the original combined entry point: gameiq always ran as a multi-model
  // batch, every other track ran the single-selection flow. Kept as a thin
  // wrapper (rather than inlining the dispatch at the button callsite) so the
  // JSX above is untouched by the Step 1 extraction.
  async function runSelected() {
    if (!suiteId) return;
    if (selectedTrack === "gameiq") {
      await runGameIqMultiModelExec({
        models,
        gameIqModelIds,
        suiteId,
        fireworksPlayerCount,
        certification,
        runAbortRef,
        setRunning,
        // The Advanced flow no longer renders a phase timeline (deleted with
        // RunProgressTimeline); running/summary/message state still drives
        // the button + AttemptDetailPanel.
        setRunPhase: () => {},
        setSummary,
        setMessage,
        setGameIqModelRuns,
        onComplete,
      });
      return;
    }
    await runSelectedTrack({
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
      setRunPhase: () => {},
      setSummary,
      setMessage,
      onComplete,
    });
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

// WorkBench doesn't have TeamIQ's five strategies (panel/debate/swarm/...) —
// only solo/architect+worker/architect+worker+reviewer — so the shared team
// builder's role slots map onto it purely by how many distinct models are
// selected. This keeps "one builder, both tracks" correct regardless of
// which TeamIQ strategy the user picked for the TeamIQ leg itself.
function workBenchRoleModeFromCount(count: number): WorkBenchRoleMode {
  if (count >= 3) return "architect_worker_reviewer";
  if (count === 2) return "architect_worker";
  return "solo";
}

function presetCardGates(input: {
  models: SelectedModel[];
  soloModelIds: string[];
  sharedTeamModelIds: string[];
  workBenchRunnerReady: boolean;
}): Record<BenchmarkPreset["id"], PresetCardGate> {
  const noModels = input.models.length === 0;
  const soloGate: PresetCardGate =
    noModels || input.soloModelIds.length === 0
      ? {
          disabled: true,
          reason: noModels
            ? "Add and enable a provider model in Settings first."
            : "Select at least one model in the checklist above.",
        }
      : { disabled: false };
  const teamGate: PresetCardGate =
    noModels || input.sharedTeamModelIds.length === 0
      ? {
          disabled: true,
          reason: noModels
            ? "Add and enable a provider model in Settings first."
            : "Select a team composition below.",
        }
      : { disabled: false };
  const fullGate: PresetCardGate = soloGate.disabled
    ? soloGate
    : teamGate.disabled
      ? teamGate
      : {
          disabled: false,
          note: input.workBenchRunnerReady
            ? "Bench runner connected — all four legs will run."
            : "Bench runner offline — the WorkBench leg will be skipped.",
        };
  return {
    "model-iq": soloGate,
    "team-benchmark": teamGate,
    "full-certified": fullGate,
  };
}

function teamIqSelectionSummary(input: {
  models: SelectedModel[];
  selectedModelIds: string[];
  suiteId: string;
  strategy: TeamIqUiStrategy;
  fireworksPlayerCount: 2 | 3;
}): string {
  if (input.selectedModelIds.length < 1) return "Select at least one model";
  if (isFireworksSuite(input.suiteId)) {
    return `${input.selectedModelIds.length} / ${input.fireworksPlayerCount} Fireworks players selected`;
  }
  const slotCount = isTeamIqToolReliabilityAllModesSuite(input.suiteId)
    ? 3
    : teamIqRoleSlotsForStrategy(input.strategy).length;
  const normalized = normalizeTeamIqModelSelectionForSlots({
    models: input.models,
    selectedModelIds: input.selectedModelIds,
    slotCount,
  });
  if (isTeamIqToolReliabilityAllModesSuite(input.suiteId)) {
    return `${normalized.length} model slot${normalized.length === 1 ? "" : "s"} assigned`;
  }
  return `${normalized.length} role${normalized.length === 1 ? "" : "s"} assigned`;
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
