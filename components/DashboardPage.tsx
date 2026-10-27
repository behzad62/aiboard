"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import {
  Card,
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
import { BuildCrewPicker } from "@/components/build/BuildCrewPicker";
import {
  buildCrewModelIds,
  defaultReviewerModelId,
  type BuildCrew,
} from "@/lib/client/build-crew";
import type {
  ToolRuntimeRunnerSettings,
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
import { getToolRuntimeRunner } from "@/lib/client/tool-runtime";
import { claimPendingProjectFolder } from "@/lib/client/project-fs";
import { ProjectAccessSetup } from "@/components/ProjectAccessSetup";
import type { RunnerSelection } from "@/components/RunnerSetup";
import { getRequiredCapabilityTypes } from "@/lib/attachments/classify";
import { supportsInputTypes } from "@/lib/providers/capabilities";
import {
  type DiscoveredModelPricingMetadata,
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
  actionProtocolStatusForId,
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
    discoveredModelMetadata?: Record<string, DiscoveredModelPricingMetadata>;
  };
  defaultSelectedModelIds: string[];
  enabledModels: Array<ModelInfo & { fullId: string }>;
}

type ChatMode = Exclude<DiscussionMode, "build">;

// Single model first: it is the default way to chat.
const CHAT_MODES: ChatMode[] = ["chat", "panel", "debate", "specialist"];
const CHAT_MODE_LABELS: Record<ChatMode, string> = {
  chat: "Single model",
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
  // Chat with Runner tools: the saved Tools-tab Runner hosts the reply (skills, extensions, project reads).
  const [toolRunner, setToolRunner] = useState<ToolRuntimeRunnerSettings | null>(null);
  const [chatRunnerTools, setChatRunnerTools] = useState(false);
  const [topic, setTopic] = useState("");
  const [mode, setMode] = useState<DiscussionMode>("chat");
  // The chat style to return to when switching back from Build.
  const [chatMode, setChatMode] = useState<ChatMode>("chat");
  // The one model a single-model chat talks to.
  const [chatModelId, setChatModelId] = useState("");
  const [effort, setEffort] = useState<EffortLevel>("medium");
  const [selectedModels, setSelectedModels] = useState<string[]>([]);
  const [judgeModelId, setJudgeModelId] = useState<string>("");
  const [verbosity, setVerbosity] = useState<Verbosity>("balanced");
  const [styleNote, setStyleNote] = useState("");
  const [reasoningEffort, setReasoningEffort] =
    useState<ReasoningEffort>("default");
  // Build roles: Architect, preferred Reviewer and the ordered worker list, each with its own effort.
  const [crew, setCrew] = useState<BuildCrew | null>(null);
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
      setToolRunner(getToolRuntimeRunner());
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
        const defaultLead =
          d.settings.judgeModelId && models.includes(d.settings.judgeModelId)
            ? d.settings.judgeModelId
            : defaultSelectedModels[0] ?? models[0] ?? "";
        setJudgeModelId(defaultLead);
        setChatModelId(defaultLead);
        if (defaultLead) {
          const defaultEffort = d.settings.defaultReasoningEffort ?? "default";
          const pool = defaultSelectedModels.length > 0 ? defaultSelectedModels : models;
          const reviewer = defaultReviewerModelId(defaultLead, pool.length > 1 ? pool : models);
          setCrew({
            architect: { modelId: defaultLead, reasoningEffort: defaultEffort },
            reviewer: reviewer ? { modelId: reviewer, reasoningEffort: defaultEffort } : null,
            workers: pool
              .filter((id) => id !== defaultLead && id !== reviewer)
              .map((modelId) => ({ modelId, reasoningEffort: defaultEffort })),
          });
        }
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
    // The Architect reads the attachments, so it must accept their types.
    setCrew((prev) =>
      prev && !supportsInputTypes(capabilitiesById.get(prev.architect.modelId), requiredInputTypes) && judgeOptions[0]
        ? { ...prev, architect: { ...prev.architect, modelId: judgeOptions[0] } }
        : prev
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
  const singleChat = mode === "chat";
  const effectiveChatModelId = compatibleJudgeOptions.some(
    (model) => model.fullId === chatModelId
  )
    ? chatModelId
    : compatibleJudgeOptions[0]?.fullId ?? "";
  // The models this session will actually call.
  const runModelIds = singleChat
    ? effectiveChatModelId
      ? [effectiveChatModelId]
      : []
    : mode === "build"
      ? crew ? buildCrewModelIds(crew) : []
      : effectiveSelectedModels;

  const costEstimate =
    runModelIds.length > 0
      ? estimateDiscussionCost(runModelIds.length, effectiveEffort, mode)
      : null;
  const usdEstimate =
    runModelIds.length > 0
      ? estimateDiscussionCostUsd(
          runModelIds.map((id) =>
            getModelPricing(
              id,
              data?.settings.modelPricingOverrides,
              data?.settings.discoveredModelMetadata,
            )
          ),
          effectiveEffort,
          mode
        )
      : null;
  const modeInfo = getModeInfo(mode);
  const totalEnabledModels = data?.enabledModels.length ?? 0;
  const hasTopic = topic.trim().length > 0;
  const hasEnoughModels = hasEnoughParticipatingModels(mode, runModelIds.length);
  const hasJudge = singleChat
    ? Boolean(effectiveChatModelId)
    : mode === "build"
      ? Boolean(crew?.architect.modelId)
      : Boolean(judgeModelId || effectiveSelectedModels[0]);
  const buildReviewerId = mode === "build" ? crew?.reviewer?.modelId ?? null : null;
  const buildWorkerCount = crew?.workers.length ?? 0;
  const buildBudgetEnforceabilityError = useMemo(() => {
    if (mode !== "build") return null;
    const runtimeIds = crew ? buildCrewModelIds(crew) : [];
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
        getModelPricing(
          runtimeId,
          data?.settings.modelPricingOverrides,
          data?.settings.discoveredModelMetadata,
        )
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
    crew,
    buildRunPolicy,
    buildBudgetUsd,
    buildTimeLimitMinutes,
    data?.settings.modelPricingOverrides,
    data?.settings.discoveredModelMetadata,
  ]);
  // Not a blocker (a time limit still bounds the run), but a USD cap silently counts $0 for models
  // without API pricing — say so instead of letting the owner believe the cap protects them.
  const buildBudgetUnpricedWarning = useMemo(() => {
    if (mode !== "build" || buildRunPolicy !== "budgeted" || !(buildBudgetUsd > 0)) return null;
    const runtimeIds = crew ? buildCrewModelIds(crew) : [];
    const unpriced = runtimeIds.filter((runtimeId) =>
      !getModelPricing(runtimeId, data?.settings.modelPricingOverrides, data?.settings.discoveredModelMetadata) &&
      !getProviderDefinition(parseModelId(runtimeId).providerId)?.accountRunner
    );
    if (unpriced.length === 0) return null;
    return `The ${buildBudgetUsd} cap can't count ${unpriced.map((id) => parseModelId(id).model).join(", ")}: ${unpriced.length === 1 ? "it has" : "they have"} no API pricing, so ${unpriced.length === 1 ? "its" : "their"} calls book $0. Add prices in Settings → Pricing${buildTimeLimitMinutes > 0 ? "; until then only the time limit bounds this run" : ""}.`;
  }, [mode, buildRunPolicy, buildBudgetUsd, buildTimeLimitMinutes, crew, data?.settings.modelPricingOverrides, data?.settings.discoveredModelMetadata]);

  // Only genuine blockers — no nagging about how the topic is phrased.
  const blockerHint =
    totalEnabledModels === 0
      ? "Add API keys and enable providers in Settings."
      : mode === "build" && !runner
        ? "Connect Runner V2 below to start a build."
      : !hasEnoughModels
        ? singleChat
          ? "Choose a model for this chat."
          : participatingModelRequirementMessage(mode)
      : !hasJudge
          ? "Choose a judge model."
          : buildBudgetEnforceabilityError
            ? buildBudgetEnforceabilityError
          : !hasTopic
            ? mode === "build"
              ? "Describe what to build."
              : singleChat
                ? "Type a message to begin."
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
        modelIds: runModelIds,
        judgeModelId: singleChat
          ? effectiveChatModelId
          : mode === "build"
            ? crew?.architect.modelId
            : judgeModelId || effectiveSelectedModels[0],
        attachmentIds: attachments.map((a) => a.id),
        verbosity,
        styleNote: styleNote.trim() || undefined,
        reasoningEffort,
        projectFolderName: mode === "build" ? projectFolderName : null,
        runnerUrl: mode === "build" ? runner?.url ?? null : singleChat && chatRunnerTools ? toolRunner?.url ?? null : null,
        runnerToken: mode === "build" ? runner?.token ?? null : singleChat && chatRunnerTools ? toolRunner?.token ?? null : null,
        runnerAccess: mode === "build" ? runner?.access ?? null : singleChat && chatRunnerTools ? toolRunner?.access ?? null : null,
        chatRunnerTools: singleChat && chatRunnerTools && Boolean(toolRunner),
        reviewerModelId: mode === "build" ? buildReviewerId : null,
        buildReviewerReasoningEffort: mode === "build" ? crew?.reviewer?.reasoningEffort ?? null : null,
        buildArchitectReasoningEffort: mode === "build" ? crew?.architect.reasoningEffort ?? null : null,
        buildWorkers: mode === "build" ? crew?.workers : undefined,
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
  const leadModelId = singleChat
    ? effectiveChatModelId
    : isBuild
      ? crew?.architect.modelId ?? ""
      : judgeModelId || effectiveSelectedModels[0] || "";
  const leadName =
    data?.enabledModels.find((model) => model.fullId === leadModelId)?.name ??
    "No model";
  const modelCountLabel = `${effectiveSelectedModels.length} model${
    effectiveSelectedModels.length === 1 ? "" : "s"
  }`;
  const reviewerName = buildReviewerId
    ? data?.enabledModels.find((model) => model.fullId === buildReviewerId)?.name ?? buildReviewerId
    : null;
  const optionsSummary = isBuild
    ? `Architect ${leadName} · ${reviewerName ? `reviewer ${reviewerName} · ` : ""}${buildWorkerCount === 0 ? "Architect implements" : `${buildWorkerCount} worker${
        buildWorkerCount === 1 ? "" : "s"
      }`} · ${
        buildBudgetUsd > 0 ? `$${buildBudgetUsd} budget` : "no budget cap"
      }`
    : singleChat
      ? `${verbosity} answers · ${reasoningEffort === "default" ? "provider default" : reasoningEffort} reasoning${
          attachments.length > 0 ? ` · ${attachments.length} attachment${attachments.length === 1 ? "" : "s"}` : ""
        }`
      : `${modelCountLabel} · judge ${leadName} · ${effort} effort`;
  const startLabel = loading
    ? "Starting…"
    : isBuild
      ? "Start build"
      : singleChat
        ? "Send"
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
            Chat with any model, put a panel of models on a hard question, or
            hand a build to an architect and its workers. Keys, sessions, and
            files stay on this device.
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
                Workers <strong className="font-medium text-foreground">{buildWorkerCount === 0 ? "Architect" : buildWorkerCount}</strong>
              </span>
              {reviewerName && (
                <span className="inline-flex items-center gap-1.5">
                  <span
                    aria-hidden="true"
                    className="inline-block h-2.5 w-2.5 rounded-full border-2 border-success"
                  />
                  Reviewer <strong className="font-medium text-foreground">{reviewerName}</strong>
                </span>
              )}
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
              {singleChat ? (
                compatibleJudgeOptions.length > 0 && (
                  <div className="flex flex-wrap items-center gap-x-4 gap-y-2 pt-1">
                    <Label htmlFor="chat-model" className="text-sm text-muted-foreground">
                      Model
                    </Label>
                    <Select value={effectiveChatModelId} onValueChange={setChatModelId}>
                      <SelectTrigger id="chat-model" className="h-9 w-auto min-w-[14rem] max-w-full">
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
                    {toolRunner && (
                      <label
                        className="flex items-center gap-2 text-sm text-muted-foreground"
                        title="Replies run on your Runner, where the model can use installed skills, read project files and install skills or MCP servers you ask for."
                      >
                        <input
                          type="checkbox"
                          checked={chatRunnerTools}
                          onChange={(event) => setChatRunnerTools(event.target.checked)}
                        />
                        Runner tools
                      </label>
                    )}
                  </div>
                )
              ) : (
                <p className="text-sm text-muted-foreground">{modeInfo.summary}</p>
              )}
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
            {isBuild && crew && (
              <BuildCrewPicker
                models={(data?.enabledModels ?? []).map((model) => ({ fullId: model.fullId, name: model.name }))}
                architectModels={compatibleJudgeOptions.map((model) => ({ fullId: model.fullId, name: model.name }))}
                value={crew}
                onChange={setCrew}
                planning={{
                  evidenceGatedPlanning: planningOptions.evidenceGatedPlanning,
                  answerReview: planningOptions.answerReview,
                  alwaysRequireIndependentVerifier: buildAlwaysRequireIndependentVerifier,
                  runPolicy: buildRunPolicy,
                }}
                probeStatus={(modelId) => actionProtocolStatusForId(modelId, capabilityProfiles)}
              />
            )}

            {!singleChat && !isBuild && (
              <ModelSelector
                models={modelsForSelector}
                selected={visibleSelectedModels}
                onChange={setSelectedModels}
                requiredInputTypes={participantRequiredInputTypes}
              />
            )}

            {!singleChat && !isBuild && compatibleJudgeOptions.length > 0 && (
              <div className="space-y-2">
                <Label>Judge — writes the final synthesis</Label>
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
            ) : singleChat ? null : (
              <EffortSlider value={effort} onChange={setEffort} mode={mode} />
            )}
            {isBuild && buildBudgetUnpricedWarning && (
              <p className="rounded-md border border-warning/40 bg-warning-soft px-3 py-2 text-xs">
                {buildBudgetUnpricedWarning}
              </p>
            )}

            <DetailControl
              verbosity={verbosity}
              onVerbosityChange={setVerbosity}
              styleNote={styleNote}
              onStyleNoteChange={setStyleNote}
              mode={mode}
            />

            {/* Build sets reasoning per role in the crew picker above. */}
            {!isBuild && (
              <ReasoningControl
                value={reasoningEffort}
                onChange={setReasoningEffort}
              />
            )}

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
