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
import { CaseSuitePicker } from "./CaseSuitePicker";
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
import { certifiedRunBudgetForCase } from "@/lib/benchmark/certified/run-budget";
import { runCertifiedBenchmark } from "@/lib/benchmark/certified/run-engine";
import {
  listCertifiedSuiteOptions,
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
  TEAMIQ_TOOL_RELIABILITY_QUICK_CASES,
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
  listGameIqScenarioPacks,
  runCertifiedGameIq,
} from "@/lib/benchmark/gameiq";
import {
  TOOL_RELIABILITY_CASES,
  runCertifiedToolReliability,
} from "@/lib/benchmark/toolreliability";
import {
  getWorkBenchCaseOption,
  listWorkBenchCaseOptions,
  runCertifiedWorkBench,
  runWorkBenchBuild,
  workBenchCaseToBenchmarkCaseV2,
} from "@/lib/benchmark/workbench";
import type { SelectedModel } from "@/lib/providers/base";

const DIRECT_MODEL_HARNESS: HarnessProfile = "raw-single-model";
const TEAM_HARNESS: HarnessProfile = "aiboard-panel";
const DEFAULT_CERTIFIED_MODEL_CALL_TIMEOUT_MS = 120_000;

type RunnableTrack = CertifiedRunnableTrack;
type TeamIqUiStrategy = Exclude<TeamIqStrategy, "solo">;
type WorkBenchRoleMode = "solo" | "architect_worker" | "architect_worker_reviewer";

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
  const lockedTrack = track === "all" ? null : (track as RunnableTrack);
  const initialTrack: RunnableTrack = lockedTrack ?? "gameiq";
  const [selectedTrack, setSelectedTrack] = useState<RunnableTrack>(initialTrack);
  const [models, setModels] = useState<SelectedModel[]>([]);
  const [modelId, setModelId] = useState("");
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
  const [summary, setSummary] = useState<CertifiedRunSummary | null>(null);

  const suites = useMemo(() => listCertifiedSuiteOptions(selectedTrack), [selectedTrack]);
  const workBenchCases = useMemo(() => listWorkBenchCaseOptions(), []);
  const executionMode = executionModeCopy(selectedTrack, harnessProfile);
  const certification = useMemo(
    () => runHarnessCertification(harnessProfile),
    [harnessProfile]
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
      if (!WORKBENCH_HARNESS_PROFILES.some((profile) => profile.id === harnessProfile)) {
        setHarnessProfile("aiboard-build-single-worker");
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
  }, [selectedTrack, harnessProfile]);

  const runGate = getCertifiedRunGate({
    suiteId,
    running,
    selectedTrack,
    modelId,
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
          <div className="grid gap-3 md:grid-cols-4">
            {lockedTrack ? (
              <StaticField label="Track" value={trackLabel(selectedTrack)} />
            ) : (
              <CaseSuitePicker
                value={selectedTrack}
                options={TRACK_OPTIONS}
                onChange={(value) => setSelectedTrack(value as RunnableTrack)}
              />
            )}
            {selectedTrack === "workbench" ? (
              <StaticField label="Case set" value="Choose WorkBench case below" />
            ) : (
              <CaseSuitePicker value={suiteId} options={suites} onChange={setSuiteId} />
            )}
            {selectedTrack === "teamiq" ? (
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
              <HarnessProfilePicker
                value={harnessProfile}
                onChange={setHarnessProfile}
                profiles={WORKBENCH_HARNESS_PROFILES}
              />
            ) : (
              <StaticField
                label="Execution"
                value={executionMode.title}
                description={executionMode.description}
              />
            )}
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
                    ).join(" / ")}
                  </div>
                </div>
              )}
            </div>
          )}
          {selectedTrack === "workbench" && (
            <div className="space-y-4">
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
              <WorkBenchTeamBuilder
                models={models}
                roleMode={workBenchRoleMode}
                selectedModelIds={workBenchModelIds}
                onRoleModeChange={(next) => {
                  setWorkBenchRoleMode(next);
                  setWorkBenchModelIds((current) =>
                    current.slice(0, workBenchRoleCount(next))
                  );
                }}
                onChange={setWorkBenchModelIds}
              />
            </div>
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
    const selectedWorkBenchCase =
      selectedTrack === "workbench" ? getWorkBenchCaseOption(suiteId) : null;
    if (selectedTrack === "workbench" && !selectedWorkBenchCase) return;
    setRunning(true);
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
        teamCompositionIds: teams.map((team) => team.id),
        modelBudget: certifiedRunBudgetForCase(caseRecord, {
          maxModelCallMs: DEFAULT_CERTIFIED_MODEL_CALL_TIMEOUT_MS,
        }),
        certification,
        runner: (context) => {
          if (selectedTrack === "gameiq") {
            return runCertifiedGameIq({
              context,
              models: [model!],
              scenarioPackIds: [suiteId],
              teamCompositionIds: [primaryTeam.id],
              trials: 1,
            });
          }
          if (selectedTrack === "toolreliability") {
            return runCertifiedToolReliability({
              context,
              models: [model!],
              teamCompositionIds: [primaryTeam.id],
              casePack: TOOL_RELIABILITY_CASES,
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
              teamCompositionIds: [primaryTeam.id],
              teamCompositions: [primaryTeam],
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
          });
        },
      });
      setSummary(result);
      setMessage(`Certified ${trackLabel(selectedTrack)} run completed.`);
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

function caseForSelection(track: RunnableTrack, suiteId: string): BenchmarkCaseV2 {
  const timestamp = new Date().toISOString();
  if (track === "workbench") {
    const selectedCase = getWorkBenchCaseOption(suiteId);
    if (!selectedCase) {
      throw new Error(`Unknown WorkBench case: ${suiteId}`);
    }
    return workBenchCaseToBenchmarkCaseV2(selectedCase, timestamp);
  }
  if (track === "toolreliability") {
    return {
      id: "toolreliability-current-pack",
      schemaVersion: 2,
      track: "toolreliability",
      title: "ToolReliability current challenge pack",
      description: "Current schema, tool-call, large-file patch, repair, and safety challenge pack.",
      difficulty: "medium",
      tags: ["toolreliability"],
      caseVersion: "current",
      createdAt: timestamp,
      updatedAt: timestamp,
      prompt: { userRequest: "Complete each current ToolReliability challenge." },
      environment: { type: "browser", timeoutSeconds: 60, network: "none" },
      verifier: { scorer: "rule-checker" },
      budget: { maxUsd: 5, maxWallClockSeconds: 1800, maxModelCalls: 150 },
      scoring: { scoringVersion: "toolreliability-current", primary: "tool_reliability" },
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
      caseVersion: "1.0.0",
      createdAt: timestamp,
      updatedAt: timestamp,
      prompt: {
        userRequest:
          "Run solo baselines and a model team over ToolReliability cases.",
      },
      environment: { type: "browser", timeoutSeconds: 60, network: "none" },
      verifier: { scorer: "rule-checker" },
      budget: { maxUsd: 5, maxWallClockSeconds: 900, maxModelCalls: 150 },
      scoring: { scoringVersion: "teamiq-toolreliability-current", primary: "team_lift" },
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
    scoring: { scoringVersion: "certified-gameiq-v1", primary: "game_iq" },
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
  if (suiteId === "teamiq-toolreliability-current-quick") {
    return {
      kind: "toolreliability" as const,
      casePack: TEAMIQ_TOOL_RELIABILITY_QUICK_CASES,
    };
  }
  return {
    kind: "toolreliability" as const,
    casePack: TOOL_RELIABILITY_CASES,
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
    title:
      WORKBENCH_HARNESS_PROFILES.find((profile) => profile.id === harnessProfile)?.label ??
      "Build harness",
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
  const selected = Array.from({ length: roleCount }, (_, index) =>
    selectedModelIds[index] ?? models[index]?.modelId ?? ""
  );

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

function workBenchRoleCount(roleMode: WorkBenchRoleMode): number {
  if (roleMode === "architect_worker_reviewer") return 3;
  if (roleMode === "architect_worker") return 2;
  return 1;
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
  const required = workBenchRoleCount(roleMode);
  return selectedModelIds
    .slice(0, required)
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
