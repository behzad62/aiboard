"use client";

import { useEffect, useMemo, useState } from "react";
import { Play, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import type { BenchmarkReportCounts } from "@/components/benchmark/useBenchmarkDashboard";
import { CaseSuitePicker, type CertifiedSuiteOption } from "./CaseSuitePicker";
import { HarnessProfilePicker } from "./HarnessProfilePicker";
import { ModelTeamPicker } from "./ModelTeamPicker";
import { RunBundlePanel } from "./RunBundlePanel";
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
import { runCertifiedBenchmark } from "@/lib/benchmark/certified/run-engine";
import {
  adjustFireworksPlayerSelectionForPlayerCount,
  getCertifiedRunGate,
  isFireworksSuite,
} from "@/lib/benchmark/certified/ui-gates";
import type { CertifiedRunSummary } from "@/lib/benchmark/certified/run-status";
import type {
  BenchmarkCaseV2,
  HarnessProfile,
  TeamIqStrategy,
} from "@/lib/benchmark/types";
import {
  createTeamIqCompositionFromSelection,
  deriveSoloTeamComposition,
  runCertifiedTeamIq,
} from "@/lib/benchmark/teamiq";
import {
  FIREWORKS_FULL_GAME_CASES,
  FIREWORKS_MEMORY_SCENARIOS,
  FIREWORKS_TACTICS_SCENARIOS,
  fireworksCaseToBenchmarkCaseV2,
  type FireworksBenchmarkCase,
  type FireworksBenchmarkSuite,
} from "@/lib/benchmark/fireworks";
import {
  getGameIqScenarioPack,
  runCertifiedGameIq,
} from "@/lib/benchmark/gameiq";
import {
  TOOL_RELIABILITY_V0_1_CASES,
  runCertifiedToolReliability,
} from "@/lib/benchmark/toolreliability";
import {
  getWorkBenchV1CaseOption,
  listWorkBenchV1CaseOptions,
  runCertifiedWorkBench,
  runWorkBenchBuild,
  workBenchCaseToBenchmarkCaseV2,
} from "@/lib/benchmark/workbench";
import type { SelectedModel } from "@/lib/providers/base";

type RunnableTrack = "gameiq" | "toolreliability" | "teamiq" | "workbench";
type TeamIqUiStrategy = Exclude<TeamIqStrategy, "solo">;

const TRACK_OPTIONS: Array<{ id: RunnableTrack; label: string }> = [
  { id: "gameiq", label: "GameIQ" },
  { id: "toolreliability", label: "Tool Reliability" },
  { id: "teamiq", label: "TeamIQ" },
  { id: "workbench", label: "WorkBench" },
];

const WORKBENCH_HARNESS_PROFILES: Array<{ id: HarnessProfile; label: string }> = [
  { id: "aiboard-build-single-worker", label: "Build single worker" },
  { id: "aiboard-build-multi-worker", label: "Build multi-worker" },
];

export function CertifiedRunPanel({
  track,
  counts,
  onComplete,
  setMessage,
}: {
  track: CertifiedTrackView;
  counts: BenchmarkReportCounts;
  onComplete: () => Promise<void>;
  setMessage: (message: string | null) => void;
}) {
  const initialTrack: RunnableTrack =
    track === "toolreliability"
      ? "toolreliability"
      : track === "teamiq"
        ? "teamiq"
        : track === "workbench"
          ? "workbench"
        : "gameiq";
  const [selectedTrack, setSelectedTrack] = useState<RunnableTrack>(initialTrack);
  const [models, setModels] = useState<SelectedModel[]>([]);
  const [modelId, setModelId] = useState("");
  const [teamModelIds, setTeamModelIds] = useState<string[]>([]);
  const [teamIqStrategy, setTeamIqStrategy] =
    useState<TeamIqUiStrategy>("architect_worker_reviewer");
  const [fireworksPlayerCount, setFireworksPlayerCount] = useState<2 | 3>(2);
  const [includeSoloBaselines, setIncludeSoloBaselines] = useState(true);
  const [suiteId, setSuiteId] = useState("");
  const [harnessProfile, setHarnessProfile] =
    useState<HarnessProfile>("raw-single-model");
  const [workBenchRunnerUrl, setWorkBenchRunnerUrl] = useState(
    DEFAULT_BENCH_RUNNER_URL
  );
  const [workBenchRunnerToken, setWorkBenchRunnerToken] = useState("");
  const [workBenchRunnerHealth, setWorkBenchRunnerHealth] =
    useState<BenchRunnerHealth | null>(null);
  const [checkingWorkBenchRunner, setCheckingWorkBenchRunner] = useState(false);
  const [running, setRunning] = useState(false);
  const [summary, setSummary] = useState<CertifiedRunSummary | null>(null);

  const suites = useMemo(() => suiteOptions(selectedTrack), [selectedTrack]);
  const workBenchCases = useMemo(() => listWorkBenchV1CaseOptions(), []);
  const harnessProfiles =
    selectedTrack === "workbench" ? WORKBENCH_HARNESS_PROFILES : undefined;
  useEffect(() => {
    const enabled = getEnabledModels().map((model) => ({
      modelId: `${model.providerId}:${model.id}`,
      providerId: model.providerId,
      displayName: model.name,
      contextProfile: model.contextProfile,
    }));
    setModels(enabled);
    setModelId((current) => current || enabled[0]?.modelId || "");
    setTeamModelIds((current) =>
      current.length > 0
        ? current.filter((modelId) =>
            enabled.some((model) => model.modelId === modelId)
          )
        : enabled.slice(0, 3).map((model) => model.modelId)
    );
  }, []);
  useEffect(() => {
    setSuiteId(suites[0]?.id ?? "");
  }, [suites]);
  useEffect(() => {
    if (
      selectedTrack === "workbench" &&
      !WORKBENCH_HARNESS_PROFILES.some((profile) => profile.id === harnessProfile)
    ) {
      setHarnessProfile("aiboard-build-single-worker");
    }
    if (
      selectedTrack !== "workbench" &&
      WORKBENCH_HARNESS_PROFILES.some((profile) => profile.id === harnessProfile)
    ) {
      setHarnessProfile("raw-single-model");
    }
  }, [selectedTrack, harnessProfile]);

  const certification = useMemo(
    () => runHarnessCertification(harnessProfile),
    [harnessProfile]
  );
  const runGate = getCertifiedRunGate({
    suiteId,
    running,
    selectedTrack,
    modelId,
    teamModelIds,
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
            Certified scores come from versioned cases and deterministic
            verifiers. Lab scores remain exploratory evidence.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-3 md:grid-cols-4">
            <CaseSuitePicker
              value={selectedTrack}
              options={TRACK_OPTIONS}
              onChange={(value) => setSelectedTrack(value as RunnableTrack)}
            />
            {selectedTrack === "workbench" ? (
              <div className="rounded-md border px-3 py-2 text-sm text-muted-foreground">
                WorkBench v1 fixtures
              </div>
            ) : (
              <CaseSuitePicker value={suiteId} options={suites} onChange={setSuiteId} />
            )}
            {selectedTrack === "teamiq" ? (
              <div className="md:col-span-1">
                <div className="rounded-md border px-3 py-2 text-sm text-muted-foreground">
                  {teamModelIds.length >= 2
                    ? isFireworksSuite(suiteId)
                      ? `${teamModelIds.length} / ${fireworksPlayerCount} Fireworks players selected`
                      : `${teamModelIds.length} models selected`
                    : "Select at least two models"}
                </div>
              </div>
            ) : (
              <ModelTeamPicker value={modelId} models={models} onChange={setModelId} />
            )}
            <HarnessProfilePicker
              value={harnessProfile}
              onChange={setHarnessProfile}
              profiles={harnessProfiles}
            />
          </div>
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
                    ).join(" · ")}
                  </div>
                </div>
              )}
            </div>
          )}
          {selectedTrack === "workbench" && (
            <WorkBenchRunPanel
              cases={workBenchCases}
              selectedCaseId={suiteId}
              runnerUrl={workBenchRunnerUrl}
              runnerToken={workBenchRunnerToken}
              runnerHealth={workBenchRunnerHealth}
              checkingRunner={checkingWorkBenchRunner}
              onCaseChange={setSuiteId}
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
          )}
          <RunProgressTimeline
            items={[
              { label: "Select", status: canRun ? "done" : "idle" },
              { label: "Certify", status: running ? "running" : summary ? "done" : "idle" },
              { label: "Run", status: running ? "running" : summary ? "done" : "idle" },
              { label: "Persist", status: summary ? "done" : "idle" },
            ]}
          />
          <div className="flex flex-wrap gap-2">
            <Button disabled={!canRun} onClick={() => void runSelected()}>
              {running ? <RefreshCw className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
              Run selected benchmark
            </Button>
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
        <RunBundlePanel counts={counts} />
        <AttemptDetailPanel summary={summary} />
      </div>
    </div>
  );

  async function runSelected() {
    if (!suiteId) return;
    const model = models.find((candidate) => candidate.modelId === modelId);
    if (selectedTrack !== "teamiq" && !model) return;
    const selectedWorkBenchCase =
      selectedTrack === "workbench" ? getWorkBenchV1CaseOption(suiteId) : null;
    if (selectedTrack === "workbench" && !selectedWorkBenchCase) return;
    setRunning(true);
    setMessage(null);
    try {
      const team =
        selectedTrack === "teamiq"
          ? createTeamIqCompositionFromSelection({
              models,
              selectedModelIds: teamModelIds,
              strategy: teamIqStrategy,
              roleMode: isFireworksSuite(suiteId)
                ? "fireworks_players"
                : "default",
              playerCount: fireworksPlayerCount,
            })
          : deriveSoloTeamComposition({
              modelId: model!.modelId,
              providerId: model!.providerId,
              displayName: model!.displayName,
            });
      await saveBenchmarkTeamComposition(team);
      await saveHarnessCertificationResult(certification);
      const runId = `ui-${selectedTrack}-${Date.now()}`;
      const caseRecord =
        selectedTrack === "workbench"
          ? workBenchCaseToBenchmarkCaseV2(selectedWorkBenchCase!)
          : caseForSelection(selectedTrack, suiteId);
      await saveBenchmarkCaseV2(caseRecord);
      const result = await runCertifiedBenchmark({
        runId,
        suiteId: `suite-${selectedTrack}`,
        track: selectedTrack,
        harnessProfile,
        caseIds: [caseRecord.id],
        teamCompositionIds: [team.id],
        certification,
        runner: (context) => {
          if (selectedTrack === "gameiq") {
            return runCertifiedGameIq({
              context,
              models: [model!],
              scenarioPackIds: [suiteId],
              teamCompositionIds: [team.id],
              trials: 1,
            });
          }
          if (selectedTrack === "toolreliability") {
            return runCertifiedToolReliability({
              context,
              models: [model!],
              teamCompositionIds: [team.id],
              casePack: TOOL_RELIABILITY_V0_1_CASES,
            });
          }
          if (selectedTrack === "workbench") {
            return runCertifiedWorkBench({
              context,
              cases: [selectedWorkBenchCase!.case],
              runner: {
                url: workBenchRunnerUrl.trim(),
                token: workBenchRunnerToken.trim(),
              },
              teamCompositionIds: [team.id],
              runBuild: (buildInput) =>
                runWorkBenchBuild({
                  ...buildInput,
                  context,
                  models: [model!],
                }),
            });
          }
          return runCertifiedTeamIq({
            context,
            teamCompositions: [team],
            task: teamIqTaskForSuite(suiteId, fireworksPlayerCount),
            includeSoloBaselines: isFireworksSuite(suiteId)
              ? includeSoloBaselines
              : true,
          });
        },
      });
      setSummary(result);
      setMessage(`Certified ${selectedTrack} run completed.`);
      await onComplete();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setRunning(false);
    }
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

function suiteOptions(track: RunnableTrack): CertifiedSuiteOption[] {
  if (track === "toolreliability") {
    return [{ id: "toolreliability-v0.1-pack", label: "ToolReliability v0.1" }];
  }
  if (track === "teamiq") {
    return [
      {
        id: "teamiq-toolreliability-v0.1-quick",
        label: "TeamIQ ToolReliability quick",
      },
      {
        id: "fireworks-teamiq-tactics-v0.1",
        label: "Fireworks Tactics",
      },
      {
        id: "fireworks-teamiq-memory-v0.1",
        label: "Fireworks Memory",
      },
      {
        id: "fireworks-teamiq-full-v0.1",
        label: "Fireworks Full",
      },
      {
        id: "fireworks-teamiq-mixed-v0.1",
        label: "Fireworks Mixed",
      },
    ];
  }
  if (track === "workbench") {
    return listWorkBenchV1CaseOptions().map((item) => ({
      id: item.id,
      label: item.label,
    }));
  }
  return ["connect-four", "chess", "battleship", "codenames", "fireworks"]
    .map((gameId) => getGameIqScenarioPack(gameId as never))
    .filter((pack): pack is NonNullable<ReturnType<typeof getGameIqScenarioPack>> => Boolean(pack))
    .map((pack) => ({ id: pack.id, label: pack.label }));
}

function caseForSelection(track: RunnableTrack, suiteId: string): BenchmarkCaseV2 {
  const timestamp = new Date().toISOString();
  if (track === "workbench") {
    const selectedCase = getWorkBenchV1CaseOption(suiteId);
    if (!selectedCase) {
      throw new Error(`Unknown WorkBench case: ${suiteId}`);
    }
    return workBenchCaseToBenchmarkCaseV2(selectedCase, timestamp);
  }
  if (track === "toolreliability") {
    return {
      id: "toolreliability-v0.1-pack",
      schemaVersion: 2,
      track: "toolreliability",
      title: "ToolReliability v0.1 pack",
      description: "Schema, tool-call, patch, repair, and safety checks.",
      difficulty: "easy",
      tags: ["toolreliability"],
      caseVersion: "0.1.0",
      createdAt: timestamp,
      updatedAt: timestamp,
      prompt: { userRequest: "Complete each ToolReliability case." },
      environment: { type: "browser", timeoutSeconds: 60, network: "none" },
      verifier: { scorer: "rule-checker" },
      budget: { maxUsd: 5, maxModelCalls: 100 },
      scoring: { scoringVersion: "toolreliability-v0.1", primary: "tool_reliability" },
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
        fireworksSuiteForSuiteId(suiteId)
      );
    }
    return {
      id: suiteId,
      schemaVersion: 2,
      track: "teamiq",
      title: "TeamIQ ToolReliability quick",
      description:
        "TeamIQ solo baselines and team attempt over deterministic ToolReliability cases.",
      difficulty: "medium",
      tags: ["teamiq", "toolreliability"],
      caseVersion: "0.1.0",
      createdAt: timestamp,
      updatedAt: timestamp,
      prompt: {
        userRequest:
          "Run solo baselines and a model team over ToolReliability cases.",
      },
      environment: { type: "browser", timeoutSeconds: 60, network: "none" },
      verifier: { scorer: "rule-checker" },
      budget: { maxUsd: 5, maxModelCalls: 100 },
      scoring: { scoringVersion: "teamiq-toolreliability-v0.1", primary: "team_lift" },
      contamination: {
        originalTask: true,
        canary: "AIBENCH-UI-TEAMIQ",
        referenceSolutionPrivate: true,
      },
    };
  }
  const pack =
    ["connect-four", "chess", "battleship", "codenames", "fireworks"]
      .map((gameId) => getGameIqScenarioPack(gameId as never))
      .find((candidate) => candidate?.id === suiteId) ?? null;
  return {
    id: suiteId,
    schemaVersion: 2,
    track: "gameiq",
    title: pack?.label ?? suiteId,
    description: "Certified GameIQ scenario pack.",
    difficulty: "easy",
    tags: ["gameiq"],
    caseVersion: "0.1.0",
    createdAt: timestamp,
    updatedAt: timestamp,
    prompt: {
      userRequest: "Solve each GameIQ scenario.",
      publicContext: JSON.stringify({
        gameId: pack?.gameId ?? "connect-four",
        scenarioPackId: suiteId,
      }),
    },
    environment: { type: "browser", timeoutSeconds: 60, network: "none" },
    verifier: { scorer: "game-engine" },
    budget: { maxUsd: 5, maxModelCalls: 100 },
    scoring: { scoringVersion: "certified-gameiq-v0.1", primary: "game_iq" },
    contamination: {
      originalTask: true,
      canary: "AIBENCH-UI-GAMEIQ",
      referenceSolutionPrivate: true,
    },
  };
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
  if (suiteId === "teamiq-toolreliability-v0.1-quick") {
    return {
      kind: "toolreliability" as const,
      casePack: TOOL_RELIABILITY_V0_1_CASES.slice(0, 5),
    };
  }
  return {
    kind: "toolreliability" as const,
    casePack: TOOL_RELIABILITY_V0_1_CASES,
  };
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
  const suite = fireworksSuiteForSuiteId(suiteId);
  if (suite === "tactics") return FIREWORKS_TACTICS_SCENARIOS.slice(0, 20);
  if (suite === "memory") return FIREWORKS_MEMORY_SCENARIOS.slice(0, 10);
  if (suite === "full") {
    return FIREWORKS_FULL_GAME_CASES.filter(
      (benchmarkCase) => benchmarkCase.playerCount === playerCount
    );
  }
  return [
    ...FIREWORKS_TACTICS_SCENARIOS.slice(0, 20),
    ...FIREWORKS_MEMORY_SCENARIOS.slice(0, 10),
    ...FIREWORKS_FULL_GAME_CASES.filter(
      (benchmarkCase) => benchmarkCase.playerCount === playerCount
    ).slice(0, 5),
  ];
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
