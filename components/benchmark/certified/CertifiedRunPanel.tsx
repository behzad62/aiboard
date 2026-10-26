"use client";

import {
  useEffect,
  useState,
  useSyncExternalStore,
} from "react";
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
import {
  checkBenchRunner,
  DEFAULT_BENCH_RUNNER_URL,
  getTrustedBenchRunnerReadiness,
  type BenchRunnerHealth,
} from "@/lib/client/bench-runner";
import { getEnabledModels } from "@/lib/client/providers";
import { getNativeBenchmarkPack, HARNESSBENCH_SUITE, NATIVE_TOOLBENCH_SUITE } from "@/lib/benchmark/native-suites";
import {
  listCertifiedSuiteOptions,
} from "@/lib/benchmark/certified/suite-options";
import { certifiedTabRunCoordinator } from "@/lib/benchmark/certified/run-session";
import {
  runPreset,
  type PresetProgressEvent,
} from "@/lib/benchmark/certified/run-execution";
import {
  BENCHMARK_PRESETS,
  type BenchmarkPreset,
} from "@/lib/benchmark/certified/run-presets";
import {
  normalizeWorkBenchModelSelection,
  type WorkBenchCase,
} from "@/lib/benchmark/workbench";
import type { SelectedModel } from "@/lib/providers/base";
import type { ReasoningEffort } from "@/lib/db/schema";
import {
  normalizeBenchmarkEffortForModel,
  type BenchmarkModelEffortMap,
} from "@/lib/benchmark/model-effort";

export function CertifiedRunPanel({
  onComplete,
  setMessage,
}: {
  onComplete: () => Promise<void>;
  setMessage: (message: string | null) => void;
}) {
  // Both benchmarks use the enabled provider models.
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
  const [harnessModelIds, setHarnessModelIds] = useState<string[]>([]);
  const [toolBenchSuiteId, setToolBenchSuiteId] = useState(NATIVE_TOOLBENCH_SUITE);
  const [focusedPresetId, setFocusedPresetId] =
    useState<BenchmarkPreset["id"]>("team-benchmark");
  const [presetLegRows, setPresetLegRows] = useState<RunProgressLegRow[]>([]);
  // The local runner connection is shared across the benchmark paths.
  const [workBenchRunnerUrl, setWorkBenchRunnerUrl] = useState(
    DEFAULT_BENCH_RUNNER_URL
  );
  const [workBenchRunnerToken, setWorkBenchRunnerToken] = useState("");
  const [workBenchRunnerHealth, setWorkBenchRunnerHealth] =
    useState<BenchRunnerHealth | null>(null);
  const [checkingWorkBenchRunner, setCheckingWorkBenchRunner] = useState(false);
  const tabRun = useSyncExternalStore(
    certifiedTabRunCoordinator.subscribe,
    certifiedTabRunCoordinator.getSnapshot,
    certifiedTabRunCoordinator.getSnapshot
  );
  const busy = tabRun.owner !== null;

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
    setSoloModelIds((current) =>
      current.length > 0
        ? current.filter((soloModelId) =>
            enabled.some((model) => model.modelId === soloModelId)
          )
        : enabled[0]
          ? [enabled[0].modelId]
          : []
    );
    setHarnessModelIds((current) =>
      normalizeWorkBenchModelSelection({ models: enabled, selectedModelIds: current, roleMode: "architect_worker_reviewer" })
    );
  }, []);

  useEffect(() => {
    persistModelChecklistConfig({ selectedModelIds: soloModelIds, effortByModelId });
  }, [soloModelIds, effortByModelId]);

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
    harnessModelIds,
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
              <HarnessBenchModelPicker
                models={models}
                selectedModelIds={harnessModelIds}
                effortByModelId={effortByModelId}
                onChange={setHarnessModelIds}
                onEffortChange={handleEffortChange}
              />
            </div>
          )}
          <PresetCards
            busy={busy}
            runningPresetId={
              tabRun.owner === "preset"
                ? tabRun.presetId ?? null
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
          {tabRun.owner !== null && tabRun.owner !== "preset" && (
            <div role="status" className="flex items-center gap-2 text-sm">
              <span>A benchmark run continues in this tab.</span>
              <Button variant="outline" size="sm" onClick={cancelActiveTabRun}>
                Cancel
              </Button>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );

  // Capture the selected model/role configuration for the tab's running benchmark.
  function runPresetFromUi(preset: BenchmarkPreset) {
    preset = { ...preset, legs: preset.legs.map(leg => leg.track === "toolreliability" ? { ...leg, suiteId: toolBenchSuiteId } : leg) };
    certifiedTabRunCoordinator.tryStart(
      "preset",
      { presetId: preset.id },
      async (signal) => {
        setFocusedPresetId(preset.id);
        setPresetLegRows(
          preset.legs.map((leg, legIndex) => ({
            legIndex,
            leg,
            status: "queued",
            models: [],
          }))
        );
        setMessage(null);
        await runPreset(
          preset,
          {
            models,
            soloModelIds,
            effortByModelId,
            teamModelIds: harnessModelIds,
            teamIqStrategy: "architect_worker_reviewer",
            workBenchRoleMode: "architect_worker_reviewer",
            workBenchRunnerUrl,
            workBenchRunnerToken,
            signal,
            onComplete,
          },
          handlePresetProgress
        );
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

  function cancelActiveTabRun() {
    certifiedTabRunCoordinator.cancel(
      tabRun.owner === "preset"
        ? "Cancelled from preset run."
        : "Cancelled from certified benchmark panel."
    );
    setMessage("Cancelling certified run...");
  }

  async function checkWorkBenchRunner(benchmarkCase?: WorkBenchCase) {
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
  harnessModelIds: string[];
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
    : input.harnessModelIds.length !== 3 || input.harnessModelIds.some(id => !input.models.some(model => model.modelId === id)) ? { disabled: true, reason: "Select a model for Architect, Worker, and Reviewer/Verifier." }
    : !input.workBenchRunnerReady ? { disabled: true, reason: "Connect and check the benchmark runner below." }
    : input.harnessBenchRunnerReady ? { disabled: false }
    : { disabled: true, reason: "The runner must include the qualified Recoverable Job Service runtime." };
  return {
    "model-iq": nativeGate,
    "team-benchmark": signatureGate,
    "full-certified": signatureGate,
  };
}

export function HarnessBenchModelPicker({
  models,
  selectedModelIds,
  effortByModelId,
  onChange,
  onEffortChange,
}: {
  models: SelectedModel[];
  selectedModelIds: string[];
  effortByModelId: BenchmarkModelEffortMap;
  onChange: (value: string[]) => void;
  onEffortChange: (modelId: string, effort: ReasoningEffort) => void;
}) {
  const roleMode = "architect_worker_reviewer";
  const roleCount = 3;
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
                {["Architect", "Worker", "Reviewer/Verifier"][index]}
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
