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
import { ModelSelector } from "@/components/ModelSelector";
import { DetailControl } from "@/components/DetailControl";
import { ReasoningControl } from "@/components/ReasoningControl";
import { AttachmentPicker, type AttachmentSummary } from "@/components/AttachmentPicker";
import { DiscussionHistory } from "@/components/DiscussionHistory";
import type {
  Discussion,
  DiscussionMode,
  EffortLevel,
  ReasoningEffort,
  Verbosity,
} from "@/lib/db/schema";
import type { ModelInfo } from "@/lib/providers/base";
import {
  estimateDiscussionCost,
  estimateDiscussionCostUsd,
  getModeInfo,
} from "@/lib/orchestrator/config";
import { getRequiredCapabilityTypes } from "@/lib/attachments/classify";
import { supportsInputTypes } from "@/lib/providers/capabilities";
import {
  getModelPricing,
  type ModelPricingOverride,
} from "@/lib/providers/pricing";
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
    modelPricingOverrides?: Record<string, ModelPricingOverride>;
  };
  defaultSelectedModelIds: string[];
  enabledModels: Array<ModelInfo & { fullId: string }>;
}

function formatUsd(n: number): string {
  return n < 0.01 ? `$${n.toFixed(3)}` : `$${n.toFixed(2)}`;
}

export default function HomePage() {
  const router = useRouter();
  const [data, setData] = useState<DashboardData | null>(null);
  const [topic, setTopic] = useState("");
  const [mode, setMode] = useState<DiscussionMode>("panel");
  const [effort, setEffort] = useState<EffortLevel>("medium");
  const [selectedModels, setSelectedModels] = useState<string[]>([]);
  const [judgeModelId, setJudgeModelId] = useState<string>("");
  const [verbosity, setVerbosity] = useState<Verbosity>("balanced");
  const [styleNote, setStyleNote] = useState("");
  const [reasoningEffort, setReasoningEffort] =
    useState<ReasoningEffort>("default");
  const [attachments, setAttachments] = useState<AttachmentSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
    fetch("/api/discussions", { cache: "no-store" })
      .then((r) => r.json())
      .then((d: DashboardData) => {
        setData(d);
        setMode(d.settings.defaultMode);
        setEffort(d.settings.defaultEffort);
        setVerbosity(d.settings.defaultVerbosity ?? "balanced");
        setStyleNote(d.settings.defaultStyleNote ?? "");
        setReasoningEffort(d.settings.defaultReasoningEffort ?? "default");
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
      })
      .catch(() => setError("Failed to load dashboard"));
  }, []);

  useEffect(() => {
    setSelectedModels((prev) =>
      prev.filter((id) =>
        supportsInputTypes(capabilitiesById.get(id), requiredInputTypes)
      )
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
  }, [data?.enabledModels, capabilitiesById, requiredInputTypes]);

  const compatibleSelected = selectedModels.filter((id) =>
    supportsInputTypes(capabilitiesById.get(id), requiredInputTypes)
  );
  const compatibleJudgeOptions =
    data?.enabledModels.filter((model) =>
      supportsInputTypes(model.capabilities, requiredInputTypes)
    ) ?? [];

  const costEstimate =
    compatibleSelected.length > 0
      ? estimateDiscussionCost(compatibleSelected.length, effort, mode)
      : null;
  const usdEstimate =
    compatibleSelected.length > 0
      ? estimateDiscussionCostUsd(
          compatibleSelected.map((id) =>
            getModelPricing(id, data?.settings.modelPricingOverrides)
          ),
          effort,
          mode
        )
      : null;
  const modeInfo = getModeInfo(mode);
  const modeCards: DiscussionMode[] = ["panel", "debate", "specialist", "build"];
  const totalEnabledModels = data?.enabledModels.length ?? 0;
  const hasTopic = topic.trim().length > 0;
  const hasEnoughModels = compatibleSelected.length >= 2;
  const hasJudge = Boolean(judgeModelId || compatibleSelected[0]);
  // Only genuine blockers — no nagging about how the topic is phrased.
  const blockerHint =
    totalEnabledModels === 0
      ? "Add API keys and enable providers in Settings."
      : !hasEnoughModels
        ? "Select at least two models."
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
      const res = await fetch("/api/discussions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          topic,
          mode,
          effort,
          modelIds: compatibleSelected,
          judgeModelId: judgeModelId || compatibleSelected[0],
          attachmentIds: attachments.map((a) => a.id),
          verbosity,
          styleNote: styleNote.trim() || undefined,
          reasoningEffort,
        }),
      });
      const result = await res.json();
      if (!res.ok) throw new Error(result.error ?? "Failed to start");
      router.push(`/discussion/${result.id}`);
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
    })) ?? [];

  return (
    <div className="grid gap-8 lg:grid-cols-5">
      <div className="space-y-6 lg:col-span-3">
        <div>
          <h1 className="font-display text-3xl font-semibold tracking-tight">
            New Discussion
          </h1>
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
              e.g. BHPH math formulas in Texas DMS systems, or design a fleet notification system
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
                        selected
                          ? "rounded-lg border border-primary bg-primary/5 p-4 text-left ring-2 ring-primary"
                          : "rounded-lg border border-border p-4 text-left transition-colors hover:bg-accent"
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

            <EffortSlider value={effort} onChange={setEffort} />

            <DetailControl
              verbosity={verbosity}
              onVerbosityChange={setVerbosity}
              styleNote={styleNote}
              onStyleNoteChange={setStyleNote}
            />

            <ReasoningControl
              value={reasoningEffort}
              onChange={setReasoningEffort}
            />

            <ModelSelector
              models={modelsForSelector}
              selected={selectedModels}
              onChange={setSelectedModels}
              requiredInputTypes={requiredInputTypes}
            />

            {compatibleJudgeOptions.length > 0 && (
              <div className="space-y-2">
                <Label>Judge model (final synthesis)</Label>
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
                      Estimated API cost:{" "}
                      <strong>
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
              {loading ? "Starting..." : `Start Discussion${compatibleSelected.length > 0 ? ` with ${compatibleSelected.length} model${compatibleSelected.length === 1 ? "" : "s"}` : ""}`}
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
