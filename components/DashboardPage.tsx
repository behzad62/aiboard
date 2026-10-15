"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
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
import { parseModelId, type ModelInfo } from "@/lib/providers/base";
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
  DEFAULT_BUILD_ALWAYS_REQUIRE_INDEPENDENT_VERIFIER,
  DEFAULT_BUILD_RUN_POLICY,
  DEFAULT_BUILD_SKILL_MODE,
  DEFAULT_BUILD_TIME_LIMIT_MINUTES,
} from "@/lib/orchestrator/build-policy";
import { getCapabilityProfiles } from "@/lib/client/capability-api";
import { getProviderDefinition } from "@/lib/providers/provider-registry";
import {
  nativeBuildBudgetEnforceabilityError,
  nativeProviderBillingBasis,
} from "@/lib/client/native-build-policy";
import {
  selectBuildModelIdsByCapabilities,
  participantRequiredInputTypesForMode,
  selectParticipantModelIdsByInputSupport,
  selectedModelIdsForMode,
} from "@/lib/client/build-capabilities";
import type { ModelCapabilityProbeProfile } from "@/lib/providers/capability-probes";
import { ArrowRight, ChevronDown, Hammer, MessagesSquare } from "lucide-react";

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
    defaultBuildAlwaysRequireIndependentVerifier?: boolean;
    modelPricingOverrides?: Record<string, ModelPricingOverride>;
  };
  defaultSelectedModelIds: string[];
  enabledModels: Array<ModelInfo & { fullId: string }>;
}

type ChatMode = Exclude<DiscussionMode, "build">;

const CHAT_MODES: ChatMode[] = ["panel", "debate", "specialist"];
const CHAT_MODE_LABELS: Record<ChatMode, string> = {
  panel: "Panel",
  debate: "Debate",
  specialist: "Specialist + reviewers",
};

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
  // The chat style to return to when switching back from Build.
  const [chatMode, setChatMode] = useState<ChatMode>("panel");
  const [effort, setEffort] = useState<EffortLevel>("medium");
  const [selectedModels, setSelectedModels] = useState<string[]>([]);
  const [judgeModelId, setJudgeModelId] = useState<string>("");
  const [verbosity, setVerbosity] = useState<Verbosity>("balanced");
  const [styleNote, setStyleNote] = useState("");
  const [reasoningEffort, setReasoningEffort] =
    useState<ReasoningEffort>("default");
  const [planningOptions, setPlanningOptions] = useState({
    answerReview: false,
    evidenceGatedPlanning: false,
    specCopy: true,
    handoffFiles: "commit" as "commit" | "export_only",
  });
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
  const [buildAlwaysRequireIndependentVerifier, setBuildAlwaysRequireIndependentVerifier] =
    useState(DEFAULT_BUILD_ALWAYS_REQUIRE_INDEPENDENT_VERIFIER);
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
        if (d.settings.defaultMode !== "build") {
          setChatMode(d.settings.defaultMode);
        }
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
        setBuildAlwaysRequireIndependentVerifier(
          d.settings.defaultBuildAlwaysRequireIndependentVerifier ??
            DEFAULT_BUILD_ALWAYS_REQUIRE_INDEPENDENT_VERIFIER
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
  const totalEnabledModels = data?.enabledModels.length ?? 0;
  const hasTopic = topic.trim().length > 0;
  const hasEnoughModels = hasEnoughParticipatingModels(
    mode,
    effectiveSelectedModels.length
  );
  const hasJudge = Boolean(judgeModelId || effectiveSelectedModels[0]);
  const buildBudgetEnforceabilityError = useMemo(() => {
    if (mode !== "build") return null;
    const runtimeIds = [...new Set([
      judgeModelId || effectiveSelectedModels[0],
      ...effectiveSelectedModels,
    ].filter((id): id is string => Boolean(id)))];
    return nativeBuildBudgetEnforceabilityError({
      runPolicy: buildRunPolicy,
      budgetLimits: {
        ...(buildBudgetUsd > 0
          ? { maxEstimatedCostMicros: Math.round(buildBudgetUsd * 1_000_000) }
          : {}),
        ...(buildTimeLimitMinutes > 0
          ? { maxActiveMs: Math.round(buildTimeLimitMinutes * 60_000) }
          : {}),
      },
    }, runtimeIds.map((runtimeId) => {
      const { providerId } = parseModelId(runtimeId);
      const hasApiPricing = Boolean(
        getModelPricing(runtimeId, data?.settings.modelPricingOverrides)
      );
      const billingBasis = nativeProviderBillingBasis({
        hasApiPricing,
        accountSubscription: Boolean(getProviderDefinition(providerId)?.accountRunner),
      });
      return {
        runtimeId,
        costBasis: billingBasis === "api_priced"
          ? "priced_api" as const
          : billingBasis,
      };
    }));
  }, [
    mode,
    judgeModelId,
    effectiveSelectedModels,
    buildRunPolicy,
    buildBudgetUsd,
    buildTimeLimitMinutes,
    data?.settings.modelPricingOverrides,
  ]);
  // Only genuine blockers — no nagging about how the topic is phrased.
  const blockerHint =
    totalEnabledModels === 0
      ? "Add API keys and enable providers in Settings."
      : mode === "build" && !runner
        ? "Connect Runner V2 below to start a build."
      : !hasEnoughModels
        ? participatingModelRequirementMessage(mode)
      : !hasJudge
          ? "Choose a judge model."
          : buildBudgetEnforceabilityError
            ? buildBudgetEnforceabilityError
          : !hasTopic
            ? mode === "build"
              ? "Describe what to build."
              : "Type a question to begin."
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
        buildAnswerReview: mode === "build" ? planningOptions.answerReview : undefined,
        buildEvidenceGatedPlanning: mode === "build" ? planningOptions.evidenceGatedPlanning : undefined,
        buildSpecCopy: mode === "build" ? planningOptions.specCopy : undefined,
        buildHandoffFiles: mode === "build" ? planningOptions.handoffFiles : undefined,
        buildRunPolicy: mode === "build" ? buildRunPolicy : undefined,
        buildSkillMode: mode === "build" ? buildSkillMode : undefined,
        buildBudgetUsd: mode === "build" ? buildBudgetUsd : undefined,
        buildTimeLimitMinutes:
          mode === "build" ? buildTimeLimitMinutes : undefined,
        buildAlwaysRequireIndependentVerifier:
          mode === "build" ? buildAlwaysRequireIndependentVerifier : undefined,
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

  const isBuild = mode === "build";
  const leadModelId = judgeModelId || effectiveSelectedModels[0] || "";
  const leadName =
    data?.enabledModels.find((model) => model.fullId === leadModelId)?.name ??
    "No model";
  const modelCountLabel = `${effectiveSelectedModels.length} model${
    effectiveSelectedModels.length === 1 ? "" : "s"
  }`;
  const optionsSummary = isBuild
    ? `Architect ${leadName} · ${modelCountLabel} as workers · ${
        buildBudgetUsd > 0 ? `$${buildBudgetUsd} budget` : "no budget cap"
      }`
    : `${modelCountLabel} · judge ${leadName} · ${effort} effort`;
  const startLabel = loading
    ? "Starting…"
    : isBuild
      ? "Start build"
      : `Start chat${
          effectiveSelectedModels.length > 0 ? ` · ${modelCountLabel}` : ""
        }`;

  return (
    <div className="mx-auto grid max-w-6xl gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
      <section aria-labelledby="composer-title" className="min-w-0 space-y-4">
        <div>
          <h1
            id="composer-title"
            className="font-display text-3xl font-semibold tracking-tight sm:text-4xl"
          >
            What are we working on?
          </h1>
          <p className="mt-2 max-w-2xl text-muted-foreground">
            Chat with a panel of models, or hand a build to an architect and
            its workers. Keys, sessions, and files stay on this device.
          </p>
        </div>

        <div className="glass rounded-2xl border p-4 sm:p-5">
          <div
            role="radiogroup"
            aria-label="Session type"
            className="inline-flex rounded-lg bg-muted p-1"
          >
            {(
              [
                { value: "chat", label: "Chat", icon: MessagesSquare },
                { value: "build", label: "Build", icon: Hammer },
              ] as const
            ).map(({ value, label, icon: Icon }) => {
              const checked = value === "build" ? isBuild : !isBuild;
              return (
                <button
                  key={value}
                  type="button"
                  role="radio"
                  aria-checked={checked}
                  onClick={() => setMode(value === "build" ? "build" : chatMode)}
                  className={
                    checked
                      ? "inline-flex items-center gap-2 rounded-md bg-card px-4 py-1.5 text-sm font-medium text-foreground shadow-sm"
                      : "inline-flex items-center gap-2 rounded-md px-4 py-1.5 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground"
                  }
                >
                  <Icon className="h-4 w-4" aria-hidden="true" />
                  {label}
                </button>
              );
            })}
          </div>

          <Label htmlFor="topic" className="sr-only">
            {isBuild ? "What should the team build?" : "What do you want to ask?"}
          </Label>
          <Textarea
            id="topic"
            rows={5}
            value={topic}
            onChange={(e) => setTopic(e.target.value)}
            placeholder={
              isBuild
                ? "Describe what to build, fix, or change in your project…"
                : "Ask a question, compare options, or get a second opinion…"
            }
            className="mt-3 min-h-[132px] resize-y text-base"
          />

          {isBuild ? (
            <p className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground">
              <span className="inline-flex items-center gap-1.5">
                <span
                  aria-hidden="true"
                  className="inline-block h-2.5 w-2.5 rotate-45 rounded-[2px] bg-primary"
                />
                Architect <strong className="font-medium text-foreground">{leadName}</strong>
              </span>
              <span className="inline-flex items-center gap-1.5">
                <span
                  aria-hidden="true"
                  className="inline-block h-2.5 w-2.5 rounded-full bg-foreground/70"
                />
                Workers <strong className="font-medium text-foreground">{modelCountLabel}</strong>
              </span>
              <span className="inline-flex items-center gap-1.5">
                <span
                  aria-hidden="true"
                  className="inline-block h-2.5 w-2.5 rounded-full border-2 border-success"
                />
                {buildAlwaysRequireIndependentVerifier
                  ? "Independent verifier required"
                  : "Verifier when available"}
              </span>
            </p>
          ) : (
            <div className="mt-3 space-y-2">
              <div
                role="radiogroup"
                aria-label="Chat style"
                className="flex flex-wrap gap-2"
              >
                {CHAT_MODES.map((candidate) => {
                  const info = getModeInfo(candidate);
                  const checked = mode === candidate;
                  return (
                    <button
                      key={candidate}
                      type="button"
                      role="radio"
                      aria-checked={checked}
                      onClick={() => {
                        setMode(candidate);
                        setChatMode(candidate);
                      }}
                      className={
                        checked
                          ? "rounded-full border border-primary bg-accent px-3 py-1 text-sm font-medium text-accent-foreground"
                          : "rounded-full border px-3 py-1 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
                      }
                    >
                      {CHAT_MODE_LABELS[candidate]}
                      <span className="sr-only">: {info.summary}</span>
                    </button>
                  );
                })}
              </div>
              <p className="text-sm text-muted-foreground">{modeInfo.summary}</p>
            </div>
          )}

          <div className="mt-4 flex flex-col gap-3 border-t pt-4 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-sm text-muted-foreground" role="status">
              {totalEnabledModels === 0 && data ? (
                <>
                  No models yet.{" "}
                  <Link
                    href="/settings"
                    className="font-medium text-foreground underline underline-offset-4"
                  >
                    Connect a provider
                  </Link>{" "}
                  to start.
                </>
              ) : blockerHint ??
                (usdEstimate
                  ? `Estimated cost ${
                      usdEstimate.minUsd === usdEstimate.maxUsd
                        ? formatUsd(usdEstimate.maxUsd)
                        : `${formatUsd(usdEstimate.minUsd)}–${formatUsd(usdEstimate.maxUsd)}`
                    }${
                      usdEstimate.pricedModelCount < usdEstimate.totalModelCount
                        ? ` (${usdEstimate.pricedModelCount}/${usdEstimate.totalModelCount} models priced)`
                        : ""
                    }`
                  : costEstimate
                    ? "No API cost on file for these models."
                    : "Ready.")}
            </p>
            <Button
              onClick={startDiscussion}
              disabled={!canStart}
              size="lg"
              className="shrink-0"
            >
              {startLabel}
              <ArrowRight className="h-4 w-4" aria-hidden="true" />
            </Button>
          </div>
          {error && <p className="mt-2 text-sm text-destructive">{error}</p>}
        </div>

        {isBuild && (
          <div className="glass rounded-2xl border p-4 sm:p-5">
            <ProjectAccessSetup
              onFolderChange={setProjectFolderName}
              onRunnerChange={setRunner}
            />
          </div>
        )}

        <details className="glass group rounded-2xl border">
          <summary className="flex cursor-pointer select-none items-center justify-between gap-3 px-4 py-3 sm:px-5">
            <span>
              <span className="block text-sm font-medium">
                Models &amp; options
              </span>
              <span className="block text-xs text-muted-foreground">
                {optionsSummary}
              </span>
            </span>
            <ChevronDown
              className="h-4 w-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-180"
              aria-hidden="true"
            />
          </summary>
          <div className="space-y-6 border-t px-4 py-5 sm:px-5">
            <ModelSelector
              models={modelsForSelector}
              selected={visibleSelectedModels}
              onChange={setSelectedModels}
              requiredInputTypes={participantRequiredInputTypes}
            />

            {isBuild && buildCapabilityDecision.diagnostics.length > 0 && (
              <div className="rounded-lg border border-warning/40 bg-warning-soft p-3 text-sm text-warning">
                {buildCapabilityDecision.diagnostics.map((line) => (
                  <p key={line}>{line}</p>
                ))}
              </div>
            )}

            {compatibleJudgeOptions.length > 0 && (
              <div className="space-y-2">
                <Label>
                  {isBuild
                    ? "Architect — plans tasks, reviews, and integrates"
                    : "Judge — writes the final synthesis"}
                </Label>
                {isBuild && (
                  <p className="text-xs text-muted-foreground">
                    The models above are the workers. Pick your most capable
                    model to lead them.
                  </p>
                )}
                <Select value={judgeModelId} onValueChange={setJudgeModelId}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {compatibleJudgeOptions.map((model) => (
                      <SelectItem key={model.fullId} value={model.fullId}>
                        {model.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}

            {isBuild ? (
              <BuildRunPolicyControl
                value={{
                  ...planningOptions,
                  runPolicy: buildRunPolicy,
                  skillMode: buildSkillMode,
                  budgetUsd: buildBudgetUsd,
                  timeLimitMinutes: buildTimeLimitMinutes,
                  alwaysRequireIndependentVerifier:
                    buildAlwaysRequireIndependentVerifier,
                }}
                onChange={(next) => {
                  setPlanningOptions({
                    answerReview: next.answerReview ?? false,
                    evidenceGatedPlanning: next.evidenceGatedPlanning ?? false,
                    specCopy: next.specCopy ?? true,
                    handoffFiles: next.handoffFiles ?? "commit",
                  });
                  setBuildRunPolicy(next.runPolicy);
                  setBuildSkillMode(next.skillMode);
                  setBuildBudgetUsd(next.budgetUsd);
                  setBuildTimeLimitMinutes(next.timeLimitMinutes);
                  setBuildAlwaysRequireIndependentVerifier(
                    next.alwaysRequireIndependentVerifier
                  );
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

            <AttachmentPicker attachments={attachments} onChange={setAttachments} />

            {costEstimate && (
              <p className="text-xs text-muted-foreground">
                Cost is a rough estimate (~{costEstimate.label}). Prompt caching
                and early convergence usually lower it.
              </p>
            )}
          </div>
        </details>
      </section>

      <aside
        aria-labelledby="recent-title"
        className="glass self-start rounded-2xl border p-4 lg:sticky lg:top-20"
      >
        <h2 id="recent-title" className="text-sm font-semibold">
          Recent sessions
        </h2>
        <div className="mt-3">
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
        </div>
      </aside>
    </div>
  );
}
