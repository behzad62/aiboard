"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { EffortSlider } from "@/components/EffortSlider";
import { BuildRunPolicyControl } from "@/components/BuildRunPolicyControl";
import { ModelSelector } from "@/components/ModelSelector";
import { DetailControl } from "@/components/DetailControl";
import { ReasoningControl } from "@/components/ReasoningControl";
import { AttachmentPicker, type AttachmentSummary } from "@/components/AttachmentPicker";
import { DiscussionHistory } from "@/components/DiscussionHistory";
import type {
  Discussion,
  DiscussionMode,
  EffortLevel,
  BuildRunPolicy,
  BuildSkillMode,
  ReasoningEffort,
  Verbosity,
} from "@/lib/db/schema";
import type { ModelInfo } from "@/lib/providers/base";
import {
  estimateDiscussionCost,
  estimateDiscussionCostUsd,
  getModeInfo,
} from "@/lib/orchestrator/config";
import {
  createDiscussion,
  ensureReady,
  hasEnoughParticipatingModels,
  loadDashboard,
  participatingModelRequirementMessage,
} from "@/lib/client/api";
import { claimPendingProjectFolder } from "@/lib/client/project-fs";
import { ProjectAccessSetup } from "@/components/ProjectAccessSetup";
import type { RunnerSelection } from "@/components/RunnerSetup";
import { getRequiredCapabilityTypes } from "@/lib/attachments/classify";
import { supportsInputTypes } from "@/lib/providers/capabilities";
import {
  getModelPricing,
  type ModelPricingOverride,
} from "@/lib/providers/pricing";
import {
  DEFAULT_BUILD_BUDGET_USD,
  DEFAULT_BUILD_RUN_POLICY,
  DEFAULT_BUILD_SKILL_MODE,
  DEFAULT_BUILD_TIME_LIMIT_MINUTES,
} from "@/lib/orchestrator/build-policy";
import { getCapabilityProfiles } from "@/lib/client/capability-api";
import {
  selectBuildModelIdsByCapabilities,
  participantRequiredInputTypesForMode,
  selectParticipantModelIdsByInputSupport,
  selectedModelIdsForMode,
} from "@/lib/client/build-capabilities";
import type { ModelCapabilityProbeProfile } from "@/lib/providers/capability-probes";
import { AlertTriangle, Sparkles } from "lucide-react";

interface DashboardData {
  discussions: Discussion[];
  settings: {
    defaultEffort: EffortLevel;
    defaultMode: DiscussionMode;
    judgeModelId?: string | null;
    defaultVerbosity?: Verbosity;
    defaultStyleNote?: string;
    defaultReasoningEffort?: ReasoningEffort;
    defaultBuildRunPolicy?: BuildRunPolicy;
    defaultBuildSkillMode?: BuildSkillMode;
    defaultBuildBudgetUsd?: number;
    defaultBuildTimeLimitMinutes?: number;
    modelPricingOverrides?: Record<string, ModelPricingOverride>;
  };
  defaultSelectedModelIds: string[];
  enabledModels: Array<ModelInfo & { fullId: string }>;
}

function formatUsd(n: number): string {
  return n < 0.01 ? `$${n.toFixed(3)}` : `$${n.toFixed(2)}`;
}

export default function DashboardPage() {
  const router = useRouter();
  const [data, setData] = useState<DashboardData | null>(null);
  const [locked, setLocked] = useState(false);
  const [projectFolderName, setProjectFolderName] = useState<string | null>(null);
  const [runner, setRunner] = useState<RunnerSelection | null>(null);
  const [topic, setTopic] = useState("");
  const [mode, setMode] = useState<DiscussionMode>("panel");
  const [effort, setEffort] = useState<EffortLevel>("medium");
  const [selectedModels, setSelectedModels] = useState<string[]>([]);
  const [judgeModelId, setJudgeModelId] = useState<string>("");
  const [verbosity, setVerbosity] = useState<Verbosity>("balanced");
  const [styleNote, setStyleNote] = useState("");
  const [reasoningEffort, setReasoningEffort] =
    useState<ReasoningEffort>("default");
  const [buildRunPolicy, setBuildRunPolicy] =
    useState<BuildRunPolicy>(DEFAULT_BUILD_RUN_POLICY);
  const [buildSkillMode, setBuildSkillMode] =
    useState<BuildSkillMode>(DEFAULT_BUILD_SKILL_MODE);
  const [buildBudgetUsd, setBuildBudgetUsd] = useState(
    DEFAULT_BUILD_BUDGET_USD
  );
  const [buildTimeLimitMinutes, setBuildTimeLimitMinutes] = useState(
    DEFAULT_BUILD_TIME_LIMIT_MINUTES
  );
  const [attachments, setAttachments] = useState<AttachmentSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [capabilityProfiles, setCapabilityProfiles] = useState<
    Record<string, ModelCapabilityProbeProfile>
  >({});

  const requiredInputTypes = useMemo(
    () => getRequiredCapabilityTypes(attachments.map((a) => a.category)),
    [attachments]
  );

  // fullId -> capabilities, sourced from the API (so custom models' declared
  // capabilities gate correctly, not the static catalog).
  const capabilitiesById = useMemo(
    () =>
      new Map((data?.enabledModels ?? []).map((m) => [m.fullId, m.capabilities])),
    [data?.enabledModels]
  );

  useEffect(() => {
    (async () => {
      const { needsPassphrase } = await ensureReady();
      if (needsPassphrase) {
        setLocked(true);
        return;
      }
      const d = loadDashboard();
      {
        setData(d);
        setCapabilityProfiles(getCapabilityProfiles());
        setMode(d.settings.defaultMode);
        setEffort(d.settings.defaultEffort);
        setVerbosity(d.settings.defaultVerbosity ?? "balanced");
        setStyleNote(d.settings.defaultStyleNote ?? "");
        setReasoningEffort(d.settings.defaultReasoningEffort ?? "default");
        setBuildRunPolicy(
          d.settings.defaultBuildRunPolicy ?? DEFAULT_BUILD_RUN_POLICY
        );
        setBuildSkillMode(
          d.settings.defaultBuildSkillMode ?? DEFAULT_BUILD_SKILL_MODE
        );
        setBuildBudgetUsd(
          d.settings.defaultBuildBudgetUsd ?? DEFAULT_BUILD_BUDGET_USD
        );
        setBuildTimeLimitMinutes(
          d.settings.defaultBuildTimeLimitMinutes ??
            DEFAULT_BUILD_TIME_LIMIT_MINUTES
        );
        const models = d.enabledModels.map((m) => m.fullId);
        const defaultSelectedModels = d.defaultSelectedModelIds.filter((modelId) =>
          models.includes(modelId)
        );
        setSelectedModels(
          defaultSelectedModels.length > 0 ? defaultSelectedModels : models
        );
        setJudgeModelId(
          d.settings.judgeModelId && models.includes(d.settings.judgeModelId)
            ? d.settings.judgeModelId
            : defaultSelectedModels[0] ?? models[0] ?? ""
        );
      }
    })().catch(() => setError("Failed to load dashboard"));
  }, []);

  useEffect(() => {
    setSelectedModels((prev) =>
      selectParticipantModelIdsByInputSupport({
        mode,
        selectedModelIds: prev,
        capabilitiesById,
        requiredInputTypes,
      })
    );
    const judgeOptions = (data?.enabledModels ?? [])
      .filter((model) =>
        supportsInputTypes(model.capabilities, requiredInputTypes)
      )
      .map((model) => model.fullId);
    setJudgeModelId((prev) =>
      prev && supportsInputTypes(capabilitiesById.get(prev), requiredInputTypes)
        ? prev
        : judgeOptions[0] ?? ""
    );
  }, [data?.enabledModels, capabilitiesById, mode, requiredInputTypes]);

  const participantRequiredInputTypes = participantRequiredInputTypesForMode(
    mode,
    requiredInputTypes
  );
  const compatibleSelected = selectParticipantModelIdsByInputSupport({
    mode,
    selectedModelIds: selectedModels,
    capabilitiesById,
    requiredInputTypes,
  });
  const buildCapabilityDecision = useMemo(
    () =>
      mode === "build"
        ? selectBuildModelIdsByCapabilities(compatibleSelected, capabilityProfiles)
        : { modelIds: compatibleSelected, diagnostics: [] },
    [mode, compatibleSelected, capabilityProfiles]
  );
  const effectiveSelectedModels = buildCapabilityDecision.modelIds;
  const visibleSelectedModels = selectedModelIdsForMode(
    mode,
    selectedModels,
    buildCapabilityDecision
  );
  const compatibleJudgeOptions =
    data?.enabledModels.filter((model) =>
      supportsInputTypes(model.capabilities, requiredInputTypes)
    ) ?? [];
  const effectiveEffort = mode === "build" ? "high" : effort;

  const costEstimate =
    effectiveSelectedModels.length > 0
      ? estimateDiscussionCost(effectiveSelectedModels.length, effectiveEffort, mode)
      : null;
  const usdEstimate =
    effectiveSelectedModels.length > 0
      ? estimateDiscussionCostUsd(
          effectiveSelectedModels.map((id) =>
            getModelPricing(id, data?.settings.modelPricingOverrides)
          ),
          effectiveEffort,
          mode
        )
      : null;
  const modeInfo = getModeInfo(mode);
  const modeCards: DiscussionMode[] = ["panel", "debate", "specialist", "build"];
  const totalEnabledModels = data?.enabledModels.length ?? 0;
  const hasTopic = topic.trim().length > 0;
  const hasEnoughModels = hasEnoughParticipatingModels(
    mode,
    effectiveSelectedModels.length
  );
  const hasJudge = Boolean(judgeModelId || effectiveSelectedModels[0]);
  // Only genuine blockers — no nagging about how the topic is phrased.
  const blockerHint =
    totalEnabledModels === 0
      ? "Add API keys and enable providers in Settings."
      : !hasEnoughModels
        ? participatingModelRequirementMessage(mode)
        : !hasJudge
          ? "Choose a judge model."
          : !hasTopic
            ? "Enter a topic to begin."
            : null;
  const canStart = !loading && !blockerHint;

  const startDiscussion = async () => {
    setLoading(true);
    setError(null);
    try {
      const result = createDiscussion({
        topic,
        mode,
        effort: mode === "build" ? "high" : effort,
        modelIds: effectiveSelectedModels,
        judgeModelId: judgeModelId || effectiveSelectedModels[0],
        attachmentIds: attachments.map((a) => a.id),
        verbosity,
        styleNote: styleNote.trim() || undefined,
        reasoningEffort,
        projectFolderName: mode === "build" ? projectFolderName : null,
        runnerUrl: mode === "build" ? runner?.url ?? null : null,
        runnerToken: mode === "build" ? runner?.token ?? null : null,
        runnerAccess: mode === "build" ? runner?.access ?? null : null,
        buildRunPolicy: mode === "build" ? buildRunPolicy : undefined,
        buildSkillMode: mode === "build" ? buildSkillMode : undefined,
        buildBudgetUsd: mode === "build" ? buildBudgetUsd : undefined,
        buildTimeLimitMinutes:
          mode === "build" ? buildTimeLimitMinutes : undefined,
      });
      if (mode === "build") {
        await claimPendingProjectFolder(result.id);
      }
      router.push(`/discussion?id=${result.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to start discussion");
    } finally {
      setLoading(false);
    }
  };

  const modelsForSelector =
    data?.enabledModels.map((m) => ({
      id: m.id,
      name: m.name,
      providerId: m.providerId,
      description: m.description,
      capabilities: m.capabilities,
      contextProfile: m.contextProfile,
    })) ?? [];

  if (locked) {
    return (
      <Card className="mx-auto max-w-md">
        <CardHeader>
          <CardTitle>Storage is locked</CardTitle>
          <CardDescription>
            Your data is encrypted. Open{" "}
            <a href="/settings?tab=storage" className="underline">
              Settings → Storage
            </a>{" "}
            and enter your passphrase to unlock it.
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }

  return (
    <div className="grid gap-8 lg:grid-cols-5">
      <div className="space-y-6 lg:col-span-3">
        <div>
          <h2 className="font-display text-3xl font-semibold tracking-tight">
            New Discussion
          </h2>
          <p className="mt-2 text-muted-foreground">
            Ask a question and let multiple AI models discuss, debate, or build
            together before delivering the best result.
          </p>
        </div>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Sparkles className="h-5 w-5 text-primary" />
              Topic
            </CardTitle>
            <CardDescription>
              e.g. Compare Postgres vs. MongoDB for a booking app, or build a recipe manager web app
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            <div className="space-y-2">
              <Label htmlFor="topic">Your question</Label>
              <Textarea
                id="topic"
                placeholder="Describe what you want the AI panel to discuss and resolve..."
                rows={5}
                value={topic}
                onChange={(e) => setTopic(e.target.value)}
              />
            </div>

            <AttachmentPicker attachments={attachments} onChange={setAttachments} />

            <div className="space-y-3">
              <Label>Discussion mode</Label>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                {modeCards.map((candidateMode) => {
                  const info = getModeInfo(candidateMode);
                  const selected = mode === candidateMode;
                  return (
                    <button
                      key={candidateMode}
                      type="button"
                      onClick={() => setMode(candidateMode)}
                      className={
                        // flex-col keeps the content top-aligned — buttons
                        // vertically center it when the grid stretches them.
                        selected
                          ? "flex flex-col items-start rounded-lg border border-primary bg-primary/5 p-4 text-left ring-2 ring-primary"
                          : "flex flex-col items-start rounded-lg border border-border p-4 text-left transition-colors hover:bg-accent"
                      }
                    >
                      <div className="flex items-center justify-between gap-3">
                        <span className="font-medium">{info.label}</span>
                      </div>
                      <p className="mt-2 text-sm text-foreground/90">{info.summary}</p>
                      <p className="mt-2 text-xs text-muted-foreground">{info.bestFor}</p>
                    </button>
                  );
                })}
              </div>
              <div className="rounded-lg border bg-muted/30 p-4 text-sm">
                <p className="font-medium">How {modeInfo.label} works</p>
                <p className="mt-1 text-muted-foreground">{modeInfo.flow}</p>
              </div>
            </div>

            {mode === "build" && (
              <>
                <ProjectAccessSetup
                  onFolderChange={setProjectFolderName}
                  onRunnerChange={setRunner}
                />
              </>
            )}

            {mode === "build" ? (
              <BuildRunPolicyControl
                value={{
                  runPolicy: buildRunPolicy,
                  skillMode: buildSkillMode,
                  budgetUsd: buildBudgetUsd,
                  timeLimitMinutes: buildTimeLimitMinutes,
                }}
                onChange={(next) => {
                  setBuildRunPolicy(next.runPolicy);
                  setBuildSkillMode(next.skillMode);
                  setBuildBudgetUsd(next.budgetUsd);
                  setBuildTimeLimitMinutes(next.timeLimitMinutes);
                }}
              />
            ) : (
              <EffortSlider value={effort} onChange={setEffort} mode={mode} />
            )}

            <DetailControl
              verbosity={verbosity}
              onVerbosityChange={setVerbosity}
              styleNote={styleNote}
              onStyleNoteChange={setStyleNote}
              mode={mode}
            />

            <ReasoningControl
              value={reasoningEffort}
              onChange={setReasoningEffort}
            />

            <ModelSelector
              models={modelsForSelector}
              selected={visibleSelectedModels}
              onChange={setSelectedModels}
              requiredInputTypes={participantRequiredInputTypes}
            />

            {mode === "build" && buildCapabilityDecision.diagnostics.length > 0 && (
              <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-100">
                {buildCapabilityDecision.diagnostics.map((line) => (
                  <p key={line}>{line}</p>
                ))}
              </div>
            )}

            {compatibleJudgeOptions.length > 0 && (
              <div className="space-y-2">
                <Label>
                  {mode === "build"
                    ? "Architect model (orchestrates: plans tasks, reviews & fixes)"
                    : "Judge model (final synthesis)"}
                </Label>
                {mode === "build" && (
                  <p className="text-xs text-muted-foreground">
                    The participating models above are the workers that implement
                    tasks. Pick your most capable model here to lead them.
                  </p>
                )}
                <Select value={judgeModelId} onValueChange={setJudgeModelId}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {compatibleJudgeOptions.map((model) => {
                      return (
                        <SelectItem key={model.fullId} value={model.fullId}>
                          {model.name}
                        </SelectItem>
                      );
                    })}
                  </SelectContent>
                </Select>
              </div>
            )}

            {costEstimate && (
              <div className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-100">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                <div>
                  {usdEstimate ? (
                    <p>
                      Estimated API cost: <strong>
                        {usdEstimate.minUsd === usdEstimate.maxUsd
                          ? formatUsd(usdEstimate.maxUsd)
                          : `${formatUsd(usdEstimate.minUsd)}–${formatUsd(usdEstimate.maxUsd)}`}
                      </strong>
                      {usdEstimate.pricedModelCount <
                        usdEstimate.totalModelCount &&
                        ` (priced ${usdEstimate.pricedModelCount}/${usdEstimate.totalModelCount} models; local/custom excluded)`}
                      .
                    </p>
                  ) : (
                    <p>
                      No API cost — the selected models have no pricing on file
                      (local / custom endpoints).
                    </p>
                  )}
                  <p className="mt-1 text-xs opacity-90">
                    Rough estimate (~{costEstimate.label}). Prompt caching and
                    early convergence usually lower it.
                  </p>
                </div>
              </div>
            )}

            {error && <p className="text-sm text-destructive">{error}</p>}

            <Button
              onClick={startDiscussion}
              disabled={!canStart}
              className="w-full"
              size="lg"
            >
              {loading ? "Starting..." : `Start Discussion${effectiveSelectedModels.length > 0 ? ` with ${effectiveSelectedModels.length} model${effectiveSelectedModels.length === 1 ? "" : "s"}` : ""}`}
            </Button>
            <p className="text-sm text-muted-foreground">
              {canStart
                ? "Live orchestration and diagnostics will appear on the discussion page."
                : blockerHint}
            </p>
          </CardContent>
        </Card>
      </div>

      <div className="lg:col-span-2">
        <Card>
          <CardHeader>
            <CardTitle>Recent Discussions</CardTitle>
            <CardDescription>Click to view live or completed results</CardDescription>
          </CardHeader>
          <CardContent>
            <DiscussionHistory
              discussions={data?.discussions ?? []}
              onDeleted={(id) =>
                setData((prev) =>
                  prev
                    ? {
                        ...prev,
                        discussions: prev.discussions.filter((x) => x.id !== id),
                      }
                    : prev
                )
              }
            />
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
