"use client";

import { useState } from "react";
import { ArrowDown, ArrowUp, Plus, X } from "lucide-react";
import { RoleGlyph } from "@/components/build/BuildWorkspace";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { BuildCrew, BuildCrewMember } from "@/lib/client/build-crew";
import type { BuildActionProtocolStatus } from "@/lib/client/build-capabilities";
import type { BuildRunPolicy, ReasoningEffort } from "@/lib/db/schema";
import { REASONING_OPTIONS, getReasoningLabel } from "@/lib/orchestrator/config";

export interface BuildCrewPickerModel {
  fullId: string;
  name: string;
}

/** The run options that decide which review steps the Reviewer performs. */
export interface BuildCrewPlanningContext {
  evidenceGatedPlanning: boolean;
  answerReview: boolean;
  alwaysRequireIndependentVerifier: boolean;
  runPolicy: BuildRunPolicy;
}

interface BuildCrewPickerProps {
  models: BuildCrewPickerModel[];
  /** The Architect reads the attachments, so it may be limited to models that accept them. */
  architectModels?: BuildCrewPickerModel[];
  value: BuildCrew;
  onChange: (crew: BuildCrew) => void;
  planning: BuildCrewPlanningContext;
  /** "full" on the composer; "compact" in session settings, where the owner has seen it before. */
  guidance?: "full" | "compact";
  probeStatus?: (modelId: string) => BuildActionProtocolStatus;
  disabled?: boolean;
  idPrefix?: string;
}

const MAX_PARALLEL_WORKERS = 4;

/** Explain each independent review gate without conflating task and final-build verification. */
export function reviewerDuties(planning: BuildCrewPlanningContext): Array<{ step: string; detail: string; runs: boolean }> {
  const strict = planning.alwaysRequireIndependentVerifier;
  const planOnly = planning.runPolicy === "plan_only";
  return [
    ...(planning.evidenceGatedPlanning
      ? [{
          step: "Requirement coverage",
          detail: "An independent model checks whether the plan covers your request, before you approve it.",
          runs: true,
        }]
      : []),
    {
      step: "Plan critique",
      detail: planOnly
        ? "Skipped in plan-only runs."
        : strict
          ? "Independent critique runs for every executable plan before workers start."
          : "Independent critique runs for risky executable plans; low-risk plans skip it.",
      runs: !planOnly,
    },
    {
      step: "Independent task review",
      detail: planOnly
        ? "Skipped: plan-only runs do not start workers."
        : planning.evidenceGatedPlanning
          ? "Every submitted task is checked. Low-risk tasks get lighter inspection; high-risk tasks get deeper checks and tests."
          : "Off: the Architect reviews submitted tasks; no mandatory separate task Reviewer runs.",
      runs: !planOnly && planning.evidenceGatedPlanning,
    },
    {
      step: "Final integrated verification",
      detail: planOnly
        ? "Skipped: there is no implemented build to verify."
        : strict
          ? "Runs even for low-risk builds, after integration and final checks."
          : "Runs after integration for high-risk builds; low-risk builds skip this extra check.",
      runs: !planOnly,
    },
    ...(planning.evidenceGatedPlanning && planning.answerReview
      ? [{
          step: "Answer review",
          detail: "If your request produces an answer instead of code, an independent model checks the answer.",
          runs: true,
        }]
      : []),
  ];
}

function EffortSelect({
  id,
  value,
  onChange,
  disabled,
  label,
}: {
  id: string;
  value: ReasoningEffort;
  onChange: (value: ReasoningEffort) => void;
  disabled?: boolean;
  label: string;
}) {
  return (
    <Select value={value} onValueChange={(next) => onChange(next as ReasoningEffort)} disabled={disabled}>
      <SelectTrigger id={id} aria-label={label}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {REASONING_OPTIONS.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {option.value === "default" ? "Provider default reasoning" : `${option.label} reasoning`}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function ModelSelect({
  id,
  models,
  value,
  onChange,
  disabled,
  label,
  placeholder,
}: {
  id: string;
  models: BuildCrewPickerModel[];
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  label: string;
  placeholder?: string;
}) {
  return (
    <Select value={value || undefined} onValueChange={onChange} disabled={disabled}>
      <SelectTrigger id={id} aria-label={label}>
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent>
        {models.map((model) => (
          <SelectItem key={model.fullId} value={model.fullId}>
            {model.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function ProbeBadge({ status }: { status?: BuildActionProtocolStatus }) {
  if (status !== "not_passed") return null;
  return (
    <Badge variant="warning" title="This model failed the AI Board Build Protocol probe in Settings; it may struggle with Build tool calls.">
      Build probe failed
    </Badge>
  );
}

export function BuildCrewPicker({
  models,
  architectModels = models,
  value,
  onChange,
  planning,
  guidance = "full",
  probeStatus,
  disabled,
  idPrefix = "crew",
}: BuildCrewPickerProps) {
  const full = guidance === "full";
  const nameOf = (id: string) => models.find((model) => model.fullId === id)?.name ?? id;
  const [draftWorker, setDraftWorker] = useState<BuildCrewMember>({ modelId: "", reasoningEffort: "default" });
  const reviewer = value.reviewer;
  const reviewerSharesArchitect = reviewer?.modelId === value.architect.modelId;
  const reviewerAlsoWorks = reviewer ? value.workers.some((worker) => worker.modelId === reviewer.modelId) : false;
  const duties = reviewerDuties(planning);

  const setArchitect = (patch: Partial<BuildCrewMember>) =>
    onChange({ ...value, architect: { ...value.architect, ...patch } });
  const setReviewer = (patch: Partial<BuildCrewMember>) =>
    onChange({
      ...value,
      reviewer: { modelId: reviewer?.modelId ?? value.architect.modelId, reasoningEffort: reviewer?.reasoningEffort ?? "default", ...patch },
    });
  const setWorker = (index: number, patch: Partial<BuildCrewMember>) =>
    onChange({ ...value, workers: value.workers.map((worker, i) => (i === index ? { ...worker, ...patch } : worker)) });
  const removeWorker = (index: number) =>
    onChange({ ...value, workers: value.workers.filter((_, i) => i !== index) });
  const moveWorker = (index: number, offset: -1 | 1) => {
    const workers = [...value.workers];
    const [moved] = workers.splice(index, 1);
    workers.splice(index + offset, 0, moved!);
    onChange({ ...value, workers });
  };
  const duplicateDraft = value.workers.some(
    (worker) => worker.modelId === draftWorker.modelId && worker.reasoningEffort === draftWorker.reasoningEffort
  );
  const addWorker = () => {
    if (!draftWorker.modelId || duplicateDraft) return;
    onChange({ ...value, workers: [...value.workers, { ...draftWorker }] });
    setDraftWorker({ modelId: "", reasoningEffort: draftWorker.reasoningEffort });
  };

  return (
    <div className="space-y-5">
      {full && (
        <p className="text-sm text-muted-foreground">
          A Build has three roles. Give each the model that suits it, and how hard it should reason.
          The same model can fill several roles, each at its own reasoning effort.
        </p>
      )}

      <section aria-labelledby={`${idPrefix}-architect-label`} className="space-y-2">
        <div className="flex items-center gap-2">
          <RoleGlyph role="architect" />
          <Label id={`${idPrefix}-architect-label`} htmlFor={`${idPrefix}-architect`}>Architect</Label>
          <ProbeBadge status={probeStatus?.(value.architect.modelId)} />
        </div>
        <p className="text-xs text-muted-foreground">
          {full
            ? "Reads your request, plans the tasks, hands them to workers, decides on every review finding and integrates the result. Every decision flows through it, so pick your most capable model; reasoning effort pays off most here."
            : "Plans, assigns, decides on review findings, integrates."}
        </p>
        <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,14rem)]">
          <ModelSelect
            id={`${idPrefix}-architect`}
            label="Architect model"
            models={architectModels}
            value={value.architect.modelId}
            onChange={(modelId) => setArchitect({ modelId })}
            disabled={disabled}
          />
          <EffortSelect
            id={`${idPrefix}-architect-effort`}
            label="Architect reasoning effort"
            value={value.architect.reasoningEffort}
            onChange={(reasoningEffort) => setArchitect({ reasoningEffort })}
            disabled={disabled}
          />
        </div>
      </section>

      <section aria-labelledby={`${idPrefix}-reviewer-label`} className="space-y-2">
        <div className="flex items-center gap-2">
          <RoleGlyph role="verifier" />
          <Label id={`${idPrefix}-reviewer-label`} htmlFor={`${idPrefix}-reviewer`}>Reviewer</Label>
          {reviewer && <ProbeBadge status={probeStatus?.(reviewer.modelId)} />}
        </div>
        <p className="text-xs text-muted-foreground">
          {full
            ? "Preferred model for independent plan checks, task reviews when plan approval is enabled, and final integrated-build verification when required. It reports findings; the Architect decides on repairs and acceptance."
            : "Preferred for enabled independent review gates; reports findings but does not approve work."}
        </p>
        <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,14rem)]">
          <ModelSelect
            id={`${idPrefix}-reviewer`}
            label="Reviewer model"
            models={models}
            value={reviewer?.modelId ?? ""}
            onChange={(modelId) => setReviewer({ modelId })}
            disabled={disabled}
            placeholder="Choose a reviewer"
          />
          <EffortSelect
            id={`${idPrefix}-reviewer-effort`}
            label="Reviewer reasoning effort"
            value={reviewer?.reasoningEffort ?? "default"}
            onChange={(reasoningEffort) => setReviewer({ reasoningEffort })}
            disabled={disabled || !reviewer}
          />
        </div>
        {reviewerSharesArchitect && (
          <p className="rounded-md border border-warning/40 bg-warning-soft px-3 py-2 text-xs">
            {planning.alwaysRequireIndependentVerifier
              ? `${nameOf(value.architect.modelId)} is also the Architect, and "Independently verify the final build" is on, so reviews go to a different model in this build whenever one is available. ${nameOf(value.architect.modelId)} reviews only when no other model is.`
              : `${nameOf(value.architect.modelId)} is also the Architect. It reviews in a fresh session with no memory of the planning, which catches less than a different model would.`}
          </p>
        )}
        {reviewerAlsoWorks && reviewer && (
          <p className="rounded-md border border-warning/40 bg-warning-soft px-3 py-2 text-xs">
            {nameOf(reviewer.modelId)} is also a worker. It never reviews its own tasks; those go to another model.
          </p>
        )}
        <details className="rounded-md bg-muted/40 px-3 py-2 text-xs" open={full}>
          <summary className="cursor-pointer select-none font-medium">Which review checks will run?</summary>
          <ul className="mt-2 space-y-1.5">
            {duties.map((duty) => (
              <li key={duty.step} className={duty.runs ? "" : "text-muted-foreground"}>
                <span className="font-medium">{duty.step}:</span> {duty.detail}
              </li>
            ))}
          </ul>
          <p className="mt-2 text-muted-foreground">
            If the Reviewer is unavailable (out of credits, rate-limited) or wrote the change itself, the runner
            uses another model from this build instead, preferring one that isn&apos;t the Architect&apos;s.
            These steps follow the planning and verification options below.
          </p>
        </details>
      </section>

      <section aria-labelledby={`${idPrefix}-workers-label`} className="space-y-2">
        <div className="flex items-center gap-2">
          <RoleGlyph role="worker" />
          <Label id={`${idPrefix}-workers-label`}>Workers</Label>
          <span className="text-xs text-muted-foreground">{value.workers.length}</span>
        </div>
        <p className="text-xs text-muted-foreground">
          {full
            ? "Write the code for each task. Every worker is used: each new task goes to the least busy one, a retried task stays with the worker that already has its context, and a worker that is out of credits, failing, or doing poorly is skipped while others can take the work. The list order breaks ties. Fast, inexpensive coding models do well here."
            : "Implement tasks; each new task goes to the least busy healthy worker."}
        </p>
        {value.workers.length === 0 ? (
          <p className="rounded-md bg-muted/40 px-3 py-2 text-xs">
            No workers: the Architect&apos;s model ({nameOf(value.architect.modelId)}, {getReasoningLabel(value.architect.reasoningEffort).toLowerCase()} reasoning) implements the tasks itself.
          </p>
        ) : (
          <ul className="space-y-2">
            {value.workers.map((worker, index) => (
              <li
                key={`${worker.modelId}:${index}`}
                className="grid items-center gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,14rem)_7.5rem]"
              >
                <div className="flex min-w-0 items-center gap-2 rounded-md border bg-background/40 px-3 py-2 text-sm">
                  <span className="w-4 shrink-0 text-xs text-muted-foreground">{index + 1}</span>
                  <span className="truncate">{nameOf(worker.modelId)}</span>
                  <ProbeBadge status={probeStatus?.(worker.modelId)} />
                </div>
                <EffortSelect
                  id={`${idPrefix}-worker-${index}-effort`}
                  label={`${nameOf(worker.modelId)} reasoning effort`}
                  value={worker.reasoningEffort}
                  onChange={(reasoningEffort) => setWorker(index, { reasoningEffort })}
                  disabled={disabled}
                />
                <div className="flex items-center justify-end">
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  onClick={() => moveWorker(index, -1)}
                  disabled={disabled || index === 0}
                  aria-label={`Move ${nameOf(worker.modelId)} up`}
                >
                  <ArrowUp className="h-4 w-4" aria-hidden="true" />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  onClick={() => moveWorker(index, 1)}
                  disabled={disabled || index === value.workers.length - 1}
                  aria-label={`Move ${nameOf(worker.modelId)} down`}
                >
                  <ArrowDown className="h-4 w-4" aria-hidden="true" />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  onClick={() => removeWorker(index)}
                  disabled={disabled}
                  aria-label={`Remove ${nameOf(worker.modelId)} from workers`}
                >
                  <X className="h-4 w-4" aria-hidden="true" />
                </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
        <div className="grid items-center gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,14rem)_7.5rem]">
          <ModelSelect
            id={`${idPrefix}-worker-add`}
            label="Worker model to add"
            models={models}
            value={draftWorker.modelId}
            onChange={(modelId) => setDraftWorker((draft) => ({ ...draft, modelId }))}
            disabled={disabled}
            placeholder="Add a worker model"
          />
          <EffortSelect
            id={`${idPrefix}-worker-add-effort`}
            label="New worker reasoning effort"
            value={draftWorker.reasoningEffort}
            onChange={(reasoningEffort) => setDraftWorker((draft) => ({ ...draft, reasoningEffort }))}
            disabled={disabled}
          />
          <Button
            type="button"
            variant="outline"
            onClick={addWorker}
            disabled={disabled || !draftWorker.modelId || duplicateDraft}
          >
            <Plus className="h-4 w-4" aria-hidden="true" />
            Add
          </Button>
        </div>
        {duplicateDraft && (
          <p className="text-xs text-muted-foreground">That model is already a worker at this reasoning effort.</p>
        )}
        {value.workers.length > 0 && (
          <p className="text-xs text-muted-foreground">
            {Math.min(MAX_PARALLEL_WORKERS, value.workers.length) === 1 ? "1 task runs" : `Up to ${Math.min(MAX_PARALLEL_WORKERS, value.workers.length)} tasks run`} at a time (one per listed worker, at most {MAX_PARALLEL_WORKERS}).
          </p>
        )}
      </section>
    </div>
  );
}
