"use client";

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { Play, RefreshCw, Square } from "lucide-react";
import Link from "next/link";
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
import { WorkBenchRunnerStatus } from "@/components/benchmark/workbench/WorkBenchRunnerStatus";
import {
  ModelChecklist,
  persistModelChecklistConfig,
  readPersistedModelChecklistConfig,
} from "@/components/benchmark/run/ModelChecklist";
import { ModelEffortSelect } from "@/components/benchmark/run/ModelEffortSelect";
import { PresetCards, type PresetCardGate } from "@/components/benchmark/run/PresetCards";
import {
  applyPresetProgressEvent,
  RunProgressList,
  type RunProgressLegRow,
} from "@/components/benchmark/run/RunProgressList";
import type { CertifiedTrackView } from "./CertifiedBenchmarkOverview";
import {
  checkBenchRunner,
  DEFAULT_BENCH_RUNNER_URL,
  getTrustedBenchRunnerReadiness,
  type BenchRunnerHealth,
} from "@/lib/client/bench-runner";
import { getEnabledModels } from "@/lib/client/providers";
import { getNativeBenchmarkPack, isNativeBenchmarkTrack, HARNESSBENCH_SUITE, NATIVE_TOOLBENCH_SUITE } from "@/lib/benchmark/native-suites";
import { runHarnessCertification } from "@/lib/benchmark/certified/certification";
import {
  listCertifiedSuiteOptions,
} from "@/lib/benchmark/certified/suite-options";
import { getCertifiedRunGate } from "@/lib/benchmark/certified/ui-gates";
import { certifiedTabRunCoordinator } from "@/lib/benchmark/certified/run-session";
import type { CertifiedRunSummary } from "@/lib/benchmark/certified/run-status";
import {
  DIRECT_MODEL_HARNESS,
  TEAM_HARNESS,
  TRACK_OPTIONS,
  isTeamIqToolReliabilityAllModesSuite,
  runPreset,
  runSelected as runSelectedTrack,
  workBenchModelsForRun,
  workBenchRoleFor,
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
  normalizeWorkBenchModelSelection,
  workBenchHarnessProfileForRoleMode,
  workBenchRoleCount,
  type WorkBenchRoleMode,
  type WorkBenchCase,
} from "@/lib/benchmark/workbench";
import type { SelectedModel } from "@/lib/providers/base";
import type { ReasoningEffort } from "@/lib/db/schema";
import {
  normalizeBenchmarkEffortForModel,
  type BenchmarkModelEffortMap,
} from "@/lib/benchmark/model-effort";

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
  const initialTrack: RunnableTrack = lockedTrack && !["harnessbench", "toolreliability"].includes(lockedTrack) ? lockedTrack : "workbench";

  // --- Shared: which provider models exist, at all -------------------------
  const [models, setModels] = useState<SelectedModel[]>([]);

  // ToolBench's solo-model checklist is separate from HarnessBench's role slots.
  const [initialModelChecklistConfig] = useState(() =>
    readPersistedModelChecklistConfig()
  );
  const [soloModelIds, setSoloModelIds] = useState<string[]>(
    initialModelChecklistConfig.selectedModelIds
  );
  const [effortByModelId, setEffortByModelId] =
    useState<BenchmarkModelEffortMap>(
      initialModelChecklistConfig.effortByModelId
    );
  // Repeated model IDs are intentional: one model may fill every Build role.
  const [sharedTeamModelIds, setSharedTeamModelIds] = useState<string[]>([]);
  const [toolBenchSuiteId, setToolBenchSuiteId] = useState(NATIVE_TOOLBENCH_SUITE);
  const [sharedTeamIqStrategy] =
    useState<TeamIqUiStrategy>("architect_worker_reviewer");
  const [focusedPresetId, setFocusedPresetId] =
    useState<BenchmarkPreset["id"]>(track === "toolreliability" ? "model-iq" : "team-benchmark");
  const [presetRunning, setPresetRunning] = useState(false);
  const [runningPresetId, setRunningPresetId] =
    useState<BenchmarkPreset["id"] | null>(null);
  const [presetLegRows, setPresetLegRows] = useState<RunProgressLegRow[]>([]);
  // Integration smoke and experimental TeamIQ remain under Advanced.
  const [selectedTrack, setSelectedTrack] = useState<RunnableTrack>(initialTrack);
  const [modelId, setModelId] = useState("");
  const [teamModelIds, setTeamModelIds] = useState<string[]>([]);
  const workBenchRoleMode: WorkBenchRoleMode = selectedTrack === "toolreliability" ? "solo" : "architect_worker_reviewer";
  const [workBenchModelIds, setWorkBenchModelIds] = useState<string[]>([]);
  const [teamIqStrategy, setTeamIqStrategy] =
    useState<TeamIqUiStrategy>("architect_worker_reviewer");
  const includeSoloBaselines = false;
  const [suiteId, setSuiteId] = useState("");
  const [harnessProfile, setHarnessProfile] =
    useState<HarnessProfile>(DIRECT_MODEL_HARNESS);
  // The local runner connection is shared across the benchmark paths.
  const [workBenchRunnerUrl, setWorkBenchRunnerUrl] = useState(
    DEFAULT_BENCH_RUNNER_URL
  );
  const [workBenchRunnerToken, setWorkBenchRunnerToken] = useState("");
  const [workBenchRunnerHealth, setWorkBenchRunnerHealth] =
    useState<BenchRunnerHealth | null>(null);
  const [checkingWorkBenchRunner, setCheckingWorkBenchRunner] = useState(false);
  const [running, setRunning] = useState(false);
  const [summary, setSummary] = useState<CertifiedRunSummary | null>(null);
  const runAbortRef = useRef<AbortController | null>(null);
  const tabRun = useSyncExternalStore(
    certifiedTabRunCoordinator.subscribe,
    certifiedTabRunCoordinator.getSnapshot,
    certifiedTabRunCoordinator.getSnapshot
  );
  const busy = tabRun.owner !== null;

  const suites = useMemo(() => listCertifiedSuiteOptions(selectedTrack), [selectedTrack]);
  const selectedWorkBenchPack = useMemo(
    () => (isNativeBenchmarkTrack(selectedTrack) ? getNativeBenchmarkPack(selectedTrack, suiteId) : null),
    [selectedTrack, suiteId]
  );
  const effectiveHarnessProfile =
    isNativeBenchmarkTrack(selectedTrack)
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
    if (lockedTrack && !["harnessbench", "toolreliability"].includes(lockedTrack) && selectedTrack !== lockedTrack) {
      setSelectedTrack(lockedTrack);
    }
  }, [lockedTrack, selectedTrack]);

  useEffect(() => {
    if (tabRun.error) setMessage(tabRun.error);
  }, [setMessage, tabRun.error]);

  useEffect(() => {
    const enabled = getEnabledModels().map((model) => ({
      modelId: `${model.providerId}:${model.id}`,
      providerId: model.providerId,
      displayName: model.name,
      contextProfile: model.contextProfile,
    }));
    setModels(enabled);
    setEffortByModelId((current) =>
      Object.fromEntries(
        enabled.map((model) => [
          model.modelId,
          normalizeBenchmarkEffortForModel(model, current[model.modelId]),
        ])
      )
    );
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
      normalizeWorkBenchModelSelection({ models: enabled, selectedModelIds: current, roleMode: "architect_worker_reviewer" })
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
    persistModelChecklistConfig({ selectedModelIds: soloModelIds, effortByModelId });
  }, [soloModelIds, effortByModelId]);

  useEffect(() => {
    setSuiteId(suites[0]?.id ?? "");
  }, [suites]);

  useEffect(() => {
    if (isNativeBenchmarkTrack(selectedTrack)) {
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

  const selectedWorkBenchReadiness = getTrustedBenchRunnerReadiness(
    workBenchRunnerHealth,
    selectedWorkBenchPack?.cases[0]?.case
  );
  const runGate = getCertifiedRunGate({
    suiteId,
    running: busy,
    selectedTrack,
    modelId,
    teamModelIds,
    workBenchModelIds,
    workBenchRoleMode,
    workBenchRunnerReady:
      !isNativeBenchmarkTrack(selectedTrack) ||
      Boolean(workBenchRunnerUrl.trim() && workBenchRunnerToken.trim()) &&
      selectedWorkBenchReadiness.ready,
    certification,
  });
  const canRun = runGate.canRun;

  const workBenchRunnerReady = Boolean(
    workBenchRunnerUrl.trim() &&
      workBenchRunnerToken.trim() &&
      getTrustedBenchRunnerReadiness(workBenchRunnerHealth).ready
  );
  const focusedPresetBase =
    BENCHMARK_PRESETS.find((preset) => preset.id === focusedPresetId) ??
    BENCHMARK_PRESETS[0]!;
  const focusedPreset = { ...focusedPresetBase, legs: focusedPresetBase.legs.map(leg => leg.track === "toolreliability" ? { ...leg, suiteId: toolBenchSuiteId } : leg) };
  const focusedPack = getNativeBenchmarkPack(focusedPreset.legs[0].track, focusedPreset.legs[0].suiteId);
  const focusedPresetHasTeamLeg = focusedPreset.legs.some(
    (leg) => leg.mode === "team"
  );
  const presetGates = presetCardGates({
    models,
    soloModelIds,
    sharedTeamModelIds,
    workBenchRunnerReady,
    toolBenchRunnerReady: getTrustedBenchRunnerReadiness(workBenchRunnerHealth, getNativeBenchmarkPack("toolreliability", toolBenchSuiteId)?.cases[0]?.case).ready,
    harnessBenchRunnerReady: getTrustedBenchRunnerReadiness(workBenchRunnerHealth, getNativeBenchmarkPack("harnessbench", HARNESSBENCH_SUITE)?.cases[0]?.case).ready,
  });
  const handleEffortChange = (
    changedModelId: string,
    effort: ReasoningEffort
  ) => {
    setEffortByModelId((current) => ({
      ...current,
      [changedModelId]: effort,
    }));
  };

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Run a benchmark</CardTitle>
          <CardDescription>
            ToolBench measures model tool use. HarnessBench measures the full Build workflow. Both record tokens, cost, time, and deterministic outcomes.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {models.length === 0 ? (
            <div className="rounded-lg border border-dashed px-4 py-6 text-center text-sm text-muted-foreground">
              No models are enabled yet.{" "}
              <Link
                href="/settings"
                className="font-medium text-foreground underline underline-offset-4"
              >
                Connect a provider
              </Link>{" "}
              to run benchmarks.
            </div>
          ) : !focusedPresetHasTeamLeg ? (
          <div className="space-y-3">
          <label className="block space-y-1 text-sm">
            <span className="font-medium">ToolBench case pack</span>
            <CaseSuitePicker value={toolBenchSuiteId} options={listCertifiedSuiteOptions("toolreliability")} ariaLabel="ToolBench case pack" onChange={setToolBenchSuiteId} />
          </label>
          <ModelChecklist
            models={models}
            selectedModelIds={soloModelIds}
            effortByModelId={effortByModelId}
            onChange={setSoloModelIds}
            onEffortChange={handleEffortChange}
          />
          </div>
          ) : null}
          {focusedPresetHasTeamLeg && models.length > 0 && (
            <div className="space-y-2 rounded-lg border bg-background/40 p-3">
              <div className="text-sm font-medium">HarnessBench models</div>
              <p className="text-xs text-muted-foreground">
                Assign each role separately. The same model can fill all three roles; each role runs in its own context. Deterministic verification checks the service contract.
              </p>
              <WorkBenchTeamBuilder
                models={models}
                selectedModelIds={sharedTeamModelIds}
                effortByModelId={effortByModelId}
                roleMode="architect_worker_reviewer"
                onChange={setSharedTeamModelIds}
                onEffortChange={handleEffortChange}
              />
            </div>
          )}
          <PresetCards
            busy={busy}
            runningPresetId={
              tabRun.owner === "preset"
                ? tabRun.presetId ?? runningPresetId
                : null
            }
            focusedPresetId={focusedPresetId}
            gates={presetGates}
            onFocus={setFocusedPresetId}
            onRun={(preset) => void runPresetFromUi(preset)}
          />
          {focusedPreset.legs.some((leg) => leg.requires === "bench-runner") && (
            <WorkBenchRunnerStatus
              idPrefix="preset-runner"
              workBenchCase={focusedPack?.cases[0]?.case}
              url={workBenchRunnerUrl}
              token={workBenchRunnerToken}
              health={workBenchRunnerHealth}
              checking={checkingWorkBenchRunner}
              onUrlChange={(value) => {
                setWorkBenchRunnerUrl(value);
                setWorkBenchRunnerHealth(null);
              }}
              onTokenChange={(value) => {
                setWorkBenchRunnerToken(value);
                setWorkBenchRunnerHealth(null);
              }}
              onCheck={() => void checkWorkBenchRunner(focusedPack?.cases[0]?.case)}
            />
          )}
          <RunProgressList
            rows={presetLegRows}
            running={tabRun.owner === "preset"}
            onCancel={cancelPresetRun}
          />
          {tabRun.owner !== null && !running && !presetRunning && (
            <div role="status" className="flex items-center gap-2 text-sm">
              <span>A certified {tabRun.owner} run continues in this tab.</span>
              <Button variant="outline" size="sm" onClick={cancelActiveTabRun}>
                Cancel
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      {(!lockedTrack || !["harnessbench", "toolreliability"].includes(lockedTrack)) && <details className="glass rounded-xl border">
        <summary className="cursor-pointer select-none px-4 py-3 text-sm font-medium">
          Advanced: integration smoke and experimental suites
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
                    options={TRACK_OPTIONS.filter(option => option.id === "teamiq" || option.id === "workbench")}
                    ariaLabel="Track"
                    onChange={(value) => setSelectedTrack(value as RunnableTrack)}
                  />
                )}
                <CaseSuitePicker
                  value={suiteId}
                  options={suites}
                  ariaLabel={
                    isNativeBenchmarkTrack(selectedTrack) ? "Benchmark case pack" : "Case suite"
                  }
                  onChange={setSuiteId}
                />
                {selectedTrack === "teamiq" ? (
                  <StaticField
                    label="Models"
                    value={teamIqSelectionSummary({
                      models,
                      selectedModelIds: teamModelIds,
                      suiteId,
                      strategy: teamIqStrategy,
                    })}
                  />
                ) : isNativeBenchmarkTrack(selectedTrack) ? (
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
                {isNativeBenchmarkTrack(selectedTrack) ? (
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
              {selectedTrack !== "teamiq" &&
                !isNativeBenchmarkTrack(selectedTrack) && (
                  <AdvancedModelEffortControl
                    models={models}
                    modelId={modelId}
                    effortByModelId={effortByModelId}
                    onEffortChange={handleEffortChange}
                  />
                )}
              {selectedTrack === "teamiq" && (
                <div className="space-y-4">
                  <TeamCompositionBuilder
                    models={models}
                    selectedModelIds={teamModelIds}
                    effortByModelId={effortByModelId}
                    strategy={teamIqStrategy}
                    allModes={isTeamIqToolReliabilityAllModesSuite(suiteId)}
                    onChange={setTeamModelIds}
                    onEffortChange={handleEffortChange}
                    onStrategyChange={setTeamIqStrategy}
                  />
                </div>
              )}
              {isNativeBenchmarkTrack(selectedTrack) && (
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
                    effortByModelId={effortByModelId}
                    onChange={setWorkBenchModelIds}
                    onEffortChange={handleEffortChange}
                  />
                </div>
              )}
              <div className="flex flex-wrap gap-2">
                <Button disabled={!canRun || busy} onClick={runSelected}>
                  {tabRun.owner === "advanced" ? <RefreshCw className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
                  Run selected benchmark
                </Button>
                {tabRun.owner === "advanced" && (
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
            <AttemptDetailPanel summary={summary} />
          </div>
        </div>
      </details>}
    </div>
  );

  // Sequences runPreset (run-execution.ts) against the shared checklist/team
  // builder above, translating its progress events into RunProgressList rows.
  function runPresetFromUi(preset: BenchmarkPreset) {
    preset = { ...preset, legs: preset.legs.map(leg => leg.track === "toolreliability" ? { ...leg, suiteId: toolBenchSuiteId } : leg) };
    certifiedTabRunCoordinator.tryStart(
      "preset",
      { presetId: preset.id },
      async (signal) => {
        setFocusedPresetId(preset.id);
        setRunningPresetId(preset.id);
        setPresetRunning(true);
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
              effortByModelId,
              teamModelIds: sharedTeamModelIds,
              teamIqStrategy: sharedTeamIqStrategy,
              workBenchRoleMode: "architect_worker_reviewer",
              workBenchRunnerUrl,
              workBenchRunnerToken,
              signal,
              onComplete,
            },
            handlePresetProgress
          );
        } finally {
          setPresetRunning(false);
          setRunningPresetId(null);
        }
      }
    );
  }

  function handlePresetProgress(event: PresetProgressEvent) {
    setPresetLegRows((current) => applyPresetProgressEvent(current, event));
  }

  function cancelPresetRun() {
    certifiedTabRunCoordinator.cancel("Cancelled from preset run.");
    setMessage("Cancelling preset run...");
  }

  // Runs the Advanced single-suite selection through run-execution.ts.
  function runSelected() {
    certifiedTabRunCoordinator.tryStart("advanced", {}, async (signal) => {
      const executionId = `benchmark-execution-${crypto.randomUUID()}`;
      if (!suiteId) return;
      await runSelectedTrack({
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
        effectiveHarnessProfile,
        certification,
        effortByModelId,
        signal,
        runAbortRef,
        setRunning,
        setRunPhase: () => {},
        setSummary,
        setMessage,
        onComplete,
        executionId,
      });
    });
  }

  function cancelRun() {
    certifiedTabRunCoordinator.cancel(
      "Cancelled from certified benchmark panel."
    );
    setMessage("Cancelling certified run...");
  }

  function cancelActiveTabRun() {
    certifiedTabRunCoordinator.cancel(
      tabRun.owner === "preset"
        ? "Cancelled from preset run."
        : "Cancelled from certified benchmark panel."
    );
    setMessage("Cancelling certified run...");
  }

  async function checkWorkBenchRunner(benchmarkCase: WorkBenchCase | undefined = selectedWorkBenchPack?.cases[0]?.case) {
    setCheckingWorkBenchRunner(true);
    setMessage(null);
    try {
      const health = await checkBenchRunner({
        url: workBenchRunnerUrl.trim(),
        token: workBenchRunnerToken.trim(),
      });
      setWorkBenchRunnerHealth(health);
      const readiness = getTrustedBenchRunnerReadiness(
        health,
        benchmarkCase
      );
      setMessage(
        readiness.ready
          ? "Bench Runner source and benchmark runtime are available."
          : readiness.error ?? "Bench runner check failed."
      );
    } finally {
      setCheckingWorkBenchRunner(false);
    }
  }
}

function presetCardGates(input: {
  models: SelectedModel[];
  soloModelIds: string[];
  sharedTeamModelIds: string[];
  workBenchRunnerReady: boolean;
  toolBenchRunnerReady: boolean;
  harnessBenchRunnerReady: boolean;
}): Record<BenchmarkPreset["id"], PresetCardGate> {
  // With no models at all the panel shows one empty state instead of a
  // reason under every card.
  const noModels = input.models.length === 0;
  const soloGate: PresetCardGate = noModels
    ? { disabled: true }
    : input.soloModelIds.length === 0
      ? { disabled: true, reason: "Select at least one model above." }
      : { disabled: false };
  const nativeGate: PresetCardGate = soloGate.disabled ? soloGate
    : input.workBenchRunnerReady && input.toolBenchRunnerReady ? { disabled: false }
    : { disabled: true, reason: "Connect and check the benchmark runner below." };
  const signatureGate: PresetCardGate = noModels ? { disabled: true }
    : input.sharedTeamModelIds.length !== 3 || input.sharedTeamModelIds.some(id => !input.models.some(model => model.modelId === id)) ? { disabled: true, reason: "Select a model for Architect, Worker, and Reviewer/Verifier." }
    : !input.workBenchRunnerReady ? { disabled: true, reason: "Connect and check the benchmark runner below." }
    : input.harnessBenchRunnerReady ? { disabled: false }
    : { disabled: true, reason: "The runner must include the qualified Recoverable Job Service runtime." };
  return {
    "model-iq": nativeGate,
    "team-benchmark": signatureGate,
    "full-certified": signatureGate,
  };
}

function teamIqSelectionSummary(input: {
  models: SelectedModel[];
  selectedModelIds: string[];
  suiteId: string;
  strategy: TeamIqUiStrategy;
}): string {
  if (input.selectedModelIds.length < 1) return "Select at least one model";
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

function executionModeCopy(track: RunnableTrack, harnessProfile: HarnessProfile): {
  title: string;
  description: string;
} {
  if (track === "toolreliability") {
    return { title: "Native ToolBench", description: "Runner V2 tools and provider adapters, executed behavioral checks, and recorded tool-use qualification." };
  }
  if (track === "teamiq") {
    return {
      title: "Experimental TeamIQ",
      description: "A small legacy scripted role/synthesis experiment; it does not measure the live Build crew.",
    };
  }
  if (track === "harnessbench") return { title: "HarnessBench — Recoverable Job Service", description: "The signature model benchmark: complete the modeled service contract using Runner V2. Every mandatory family and variant must pass." };
  return {
    title: workBenchHarnessProfileLabel(harnessProfile),
    description: "Three behavioral fixtures exercise native Build integration. Smoke results are separate from model qualification.",
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

export function AdvancedModelEffortControl({
  models,
  modelId,
  effortByModelId,
  onEffortChange,
}: {
  models: SelectedModel[];
  modelId: string;
  effortByModelId: BenchmarkModelEffortMap;
  onEffortChange: (modelId: string, effort: ReasoningEffort) => void;
}) {
  const model = models.find((candidate) => candidate.modelId === modelId);
  if (!model) return null;

  return (
    <div className="max-w-sm space-y-1">
      <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        Reasoning effort
      </div>
      <ModelEffortSelect
        model={model}
        value={effortByModelId[model.modelId] ?? "default"}
        onChange={(effort) => onEffortChange(model.modelId, effort)}
      />
    </div>
  );
}

export function WorkBenchTeamBuilder({
  models,
  roleMode,
  selectedModelIds,
  effortByModelId,
  onChange,
  onEffortChange,
}: {
  models: SelectedModel[];
  roleMode: WorkBenchRoleMode;
  selectedModelIds: string[];
  effortByModelId: BenchmarkModelEffortMap;
  onChange: (value: string[]) => void;
  onEffortChange: (modelId: string, effort: ReasoningEffort) => void;
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
      {roleCount === 3 && selected[0] && (
        <div className="md:col-span-3">
          <Button variant="outline" size="sm" onClick={() => onChange([selected[0], selected[0], selected[0]])}>
            Use Architect model for all roles
          </Button>
        </div>
      )}
      {selected.map((modelId, index) => {
        const model = models.find((candidate) => candidate.modelId === modelId);
        return (
          <div key={`${roleMode}-${index}`} className="space-y-2">
            <label className="space-y-1">
              <span className="font-medium">
                {workBenchRoleLabel(roleMode, index)}
              </span>
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
                {models.map((candidate) => (
                  <option key={candidate.modelId} value={candidate.modelId}>
                    {candidate.displayName}
                  </option>
                ))}
              </select>
            </label>
            {model && (
              <ModelEffortSelect
                model={model}
                value={effortByModelId[model.modelId] ?? "default"}
                onChange={(effort) => onEffortChange(model.modelId, effort)}
                compact
              />
            )}
          </div>
        );
      })}
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
      return "Reviewer/Verifier";
    default:
      return role;
  }
}
