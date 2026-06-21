"use client";

import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, Save, Settings2 } from "lucide-react";
import { DetailControl } from "@/components/DetailControl";
import { EffortSlider } from "@/components/EffortSlider";
import { BuildRunPolicyControl } from "@/components/BuildRunPolicyControl";
import { ModelSelector } from "@/components/ModelSelector";
import { ReasoningControl } from "@/components/ReasoningControl";
import { RunnerSetup, type RunnerSelection } from "@/components/RunnerSetup";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { AttachmentSummary } from "@/lib/attachments/types";
import { getRequiredCapabilityTypes } from "@/lib/attachments/classify";
import type {
  BuildRunPolicy,
  Discussion,
  EffortLevel,
  ReasoningEffort,
  Verbosity,
} from "@/lib/db/schema";
import type { ModelInfo } from "@/lib/providers/base";
import { supportsInputTypes } from "@/lib/providers/capabilities";
import {
  hasEnoughParticipatingModels,
  participatingModelRequirementMessage,
} from "@/lib/client/api";
import {
  DEFAULT_BUILD_BUDGET_USD,
  DEFAULT_BUILD_RUN_POLICY,
  DEFAULT_BUILD_TIME_LIMIT_MINUTES,
} from "@/lib/orchestrator/build-policy";

export interface DiscussionSessionSettingsValue {
  effort: EffortLevel;
  modelIds: string[];
  judgeModelId: string | null;
  verbosity: Verbosity;
  styleNote: string;
  reasoningEffort: ReasoningEffort;
  buildRunPolicy?: BuildRunPolicy;
  buildBudgetUsd?: number;
  buildTimeLimitMinutes?: number;
}

interface DiscussionSessionSettingsProps {
  discussion: Discussion;
  enabledModels: Array<ModelInfo & { fullId: string }>;
  attachments: AttachmentSummary[];
  canEdit: boolean;
  busy?: boolean;
  onSave: (value: DiscussionSessionSettingsValue) => boolean;
  onRunnerChange: (selection: RunnerSelection | null) => void;
}

function parseModelIds(discussion: Discussion): string[] {
  try {
    return JSON.parse(discussion.modelIds) as string[];
  } catch {
    return [];
  }
}

export function DiscussionSessionSettings({
  discussion,
  enabledModels,
  attachments,
  canEdit,
  busy = false,
  onSave,
  onRunnerChange,
}: DiscussionSessionSettingsProps) {
  const [effort, setEffort] = useState<EffortLevel>(discussion.effort);
  const [selectedModels, setSelectedModels] = useState<string[]>(
    parseModelIds(discussion)
  );
  const [judgeModelId, setJudgeModelId] = useState(
    discussion.judgeModelId ?? ""
  );
  const [verbosity, setVerbosity] = useState<Verbosity>(
    discussion.verbosity ?? "balanced"
  );
  const [styleNote, setStyleNote] = useState(discussion.styleNote ?? "");
  const [reasoningEffort, setReasoningEffort] = useState<ReasoningEffort>(
    discussion.reasoningEffort ?? "default"
  );
  const [buildRunPolicy, setBuildRunPolicy] = useState<BuildRunPolicy>(
    discussion.buildRunPolicy ?? DEFAULT_BUILD_RUN_POLICY
  );
  const [buildBudgetUsd, setBuildBudgetUsd] = useState(
    discussion.buildBudgetUsd ?? DEFAULT_BUILD_BUDGET_USD
  );
  const [buildTimeLimitMinutes, setBuildTimeLimitMinutes] = useState(
    discussion.buildTimeLimitMinutes ?? DEFAULT_BUILD_TIME_LIMIT_MINUTES
  );
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    setEffort(discussion.effort);
    setSelectedModels(parseModelIds(discussion));
    setJudgeModelId(discussion.judgeModelId ?? "");
    setVerbosity(discussion.verbosity ?? "balanced");
    setStyleNote(discussion.styleNote ?? "");
    setReasoningEffort(discussion.reasoningEffort ?? "default");
    setBuildRunPolicy(discussion.buildRunPolicy ?? DEFAULT_BUILD_RUN_POLICY);
    setBuildBudgetUsd(discussion.buildBudgetUsd ?? DEFAULT_BUILD_BUDGET_USD);
    setBuildTimeLimitMinutes(
      discussion.buildTimeLimitMinutes ?? DEFAULT_BUILD_TIME_LIMIT_MINUTES
    );
    setMessage(null);
  }, [discussion]);

  const requiredInputTypes = useMemo(
    () => getRequiredCapabilityTypes(attachments.map((a) => a.category)),
    [attachments]
  );
  const capabilitiesById = useMemo(
    () => new Map(enabledModels.map((m) => [m.fullId, m.capabilities])),
    [enabledModels]
  );
  const compatibleSelected = selectedModels.filter((id) =>
    supportsInputTypes(capabilitiesById.get(id), requiredInputTypes)
  );
  const compatibleJudgeOptions = enabledModels.filter((model) =>
    supportsInputTypes(model.capabilities, requiredInputTypes)
  );
  const modelsForSelector = enabledModels.map((m) => ({
    id: m.id,
    name: m.name,
    providerId: m.providerId,
    description: m.description,
    capabilities: m.capabilities,
  }));
  const runnerSelection =
    discussion.runnerUrl && discussion.runnerToken
      ? {
          url: discussion.runnerUrl,
          token: discussion.runnerToken,
          access: discussion.runnerAccess ?? "ask",
        }
      : null;
  const hasEnoughModels = hasEnoughParticipatingModels(
    discussion.mode,
    compatibleSelected.length
  );
  const canSave = canEdit && !busy && hasEnoughModels;

  const save = () => {
    if (!canSave) return;
    const saved = onSave({
      effort,
      modelIds: compatibleSelected,
      judgeModelId: judgeModelId || compatibleSelected[0] || null,
      verbosity,
      styleNote,
      reasoningEffort,
      buildRunPolicy:
        discussion.mode === "build" ? buildRunPolicy : undefined,
      buildBudgetUsd: discussion.mode === "build" ? buildBudgetUsd : undefined,
      buildTimeLimitMinutes:
        discussion.mode === "build" ? buildTimeLimitMinutes : undefined,
    });
    if (saved) {
      setMessage("Saved. Resume will use these session settings.");
    }
  };

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant={canEdit ? "success" : "secondary"}>
            {canEdit ? "Editable" : "Locked while running"}
          </Badge>
          <Badge variant="secondary">{discussion.mode}</Badge>
        </div>
        <CardTitle className="flex items-center gap-2 text-xl">
          <Settings2 className="h-5 w-5 text-primary" />
          Session settings
        </CardTitle>
        <CardDescription>
          These settings affect the next Resume or follow-up pass. The current
          transcript and produced files stay intact.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {!canEdit && (
          <div className="flex items-start gap-2 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-100">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>Stop the session before changing models, effort, or runner.</span>
          </div>
        )}

        <fieldset disabled={!canEdit || busy} className="space-y-6">
          <div className="rounded-lg border bg-muted/25 p-4">
            <Label>Mode</Label>
            <p className="mt-1 text-sm text-muted-foreground">
              {discussion.mode} mode is fixed for this discussion. Start a new
              discussion to change modes.
            </p>
          </div>

          {discussion.mode === "build" ? (
            <BuildRunPolicyControl
              value={{
                runPolicy: buildRunPolicy,
                budgetUsd: buildBudgetUsd,
                timeLimitMinutes: buildTimeLimitMinutes,
              }}
              onChange={(next) => {
                setBuildRunPolicy(next.runPolicy);
                setBuildBudgetUsd(next.budgetUsd);
                setBuildTimeLimitMinutes(next.timeLimitMinutes);
              }}
              disabled={!canEdit || busy}
            />
          ) : (
            <EffortSlider
              value={effort}
              onChange={setEffort}
              mode={discussion.mode}
            />
          )}

          <DetailControl
            verbosity={verbosity}
            onVerbosityChange={setVerbosity}
            styleNote={styleNote}
            onStyleNoteChange={setStyleNote}
            idPrefix="session"
            mode={discussion.mode}
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
              <Label>
                {discussion.mode === "build"
                  ? "Architect model"
                  : "Judge model"}
              </Label>
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

          {discussion.mode === "build" && (
            <RunnerSetup
              initialSelection={runnerSelection}
              disabled={!canEdit || busy}
              onChange={onRunnerChange}
              pickedFolderName={discussion.projectFolderName}
            />
          )}
        </fieldset>

        {!hasEnoughModels && (
          <p className="text-sm text-destructive">
            {participatingModelRequirementMessage(discussion.mode).replace(
              "participating",
              "compatible participating"
            )}
          </p>
        )}
        {message && <p className="text-sm text-emerald-600">{message}</p>}
        <Button type="button" onClick={save} disabled={!canSave}>
          <Save className="mr-2 h-4 w-4" />
          {busy ? "Saving..." : "Save session settings"}
        </Button>
      </CardContent>
    </Card>
  );
}
