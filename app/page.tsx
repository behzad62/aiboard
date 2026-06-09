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
import { AttachmentPicker, type AttachmentSummary } from "@/components/AttachmentPicker";
import { DiscussionHistory } from "@/components/DiscussionHistory";
import type { Discussion, DiscussionMode, EffortLevel } from "@/lib/db/schema";
import type { ModelInfo } from "@/lib/providers/base";
import { estimateDiscussionCost, getModeLabel } from "@/lib/orchestrator/config";
import { getRequiredCapabilityTypes } from "@/lib/attachments/classify";
import { modelSupportsInputTypes } from "@/lib/providers/capabilities";
import { AlertTriangle, Sparkles } from "lucide-react";

interface DashboardData {
  discussions: Discussion[];
  settings: {
    defaultEffort: EffortLevel;
    defaultMode: DiscussionMode;
    judgeModelId?: string | null;
  };
  enabledModels: Array<ModelInfo & { fullId: string }>;
}

export default function HomePage() {
  const router = useRouter();
  const [data, setData] = useState<DashboardData | null>(null);
  const [topic, setTopic] = useState("");
  const [mode, setMode] = useState<DiscussionMode>("panel");
  const [effort, setEffort] = useState<EffortLevel>("medium");
  const [selectedModels, setSelectedModels] = useState<string[]>([]);
  const [judgeModelId, setJudgeModelId] = useState<string>("");
  const [attachments, setAttachments] = useState<AttachmentSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const requiredInputTypes = useMemo(
    () => getRequiredCapabilityTypes(attachments.map((a) => a.category)),
    [attachments]
  );

  useEffect(() => {
    fetch("/api/discussions")
      .then((r) => r.json())
      .then((d: DashboardData) => {
        setData(d);
        setMode(d.settings.defaultMode);
        setEffort(d.settings.defaultEffort);
        const models = d.enabledModels.map((m) => m.fullId);
        setSelectedModels(models.slice(0, Math.min(3, models.length)));
        setJudgeModelId(d.settings.judgeModelId ?? models[0] ?? "");
      })
      .catch(() => setError("Failed to load dashboard"));
  }, []);

  useEffect(() => {
    setSelectedModels((prev) =>
      prev.filter((id) => modelSupportsInputTypes(id, requiredInputTypes))
    );
    setJudgeModelId((prev) =>
      prev && modelSupportsInputTypes(prev, requiredInputTypes) ? prev : ""
    );
  }, [requiredInputTypes]);

  const compatibleSelected = selectedModels.filter((id) =>
    modelSupportsInputTypes(id, requiredInputTypes)
  );

  const costEstimate =
    compatibleSelected.length > 0
      ? estimateDiscussionCost(compatibleSelected.length, effort)
      : null;

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
          <h1 className="text-3xl font-bold tracking-tight">New Discussion</h1>
          <p className="mt-2 text-muted-foreground">
            Ask a question and let multiple AI models discuss before delivering the best answer.
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

            <div className="space-y-2">
              <Label>Discussion mode</Label>
              <Select value={mode} onValueChange={(v) => setMode(v as DiscussionMode)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="panel">{getModeLabel("panel")}</SelectItem>
                  <SelectItem value="debate">{getModeLabel("debate")}</SelectItem>
                  <SelectItem value="specialist">{getModeLabel("specialist")}</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <EffortSlider value={effort} onChange={setEffort} />

            <ModelSelector
              models={modelsForSelector}
              selected={selectedModels}
              onChange={setSelectedModels}
              requiredInputTypes={requiredInputTypes}
            />

            {compatibleSelected.length > 0 && (
              <div className="space-y-2">
                <Label>Judge model (final synthesis)</Label>
                <Select value={judgeModelId} onValueChange={setJudgeModelId}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {compatibleSelected.map((id) => {
                      const model = data?.enabledModels.find((m) => m.fullId === id);
                      return (
                        <SelectItem key={id} value={id}>
                          {model?.name ?? id}
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
                <span>
                  Estimated API cost: {costEstimate.label}. Higher effort uses more rounds and tokens.
                </span>
              </div>
            )}

            {error && <p className="text-sm text-destructive">{error}</p>}

            <Button
              onClick={startDiscussion}
              disabled={
                loading ||
                topic.length < 10 ||
                compatibleSelected.length < 2
              }
              className="w-full"
              size="lg"
            >
              {loading ? "Starting..." : "Start Discussion"}
            </Button>
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
            <DiscussionHistory discussions={data?.discussions ?? []} />
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
