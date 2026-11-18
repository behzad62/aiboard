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
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { BuildCrew, BuildCrewMember } from "@/lib/client/build-crew";
import {
  CLI_WORKERS_FULL_ACCESS_REASON,
  cliRuntimeDisplayName,
  isCliRuntimeId,
  type CliWorkerCrewOption,
} from "@/lib/client/cli-workers";
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
  /**
   * CLI workers set up in Settings (CW9): offered as workers only, never as Architect or reviewer. A row is
   * unpickable when the CLI is refused on this computer or the Build's access is not Full.
   */
  cliWorkers?: CliWorkerCrewOption[];
  /** The Build's access ceiling: CLI workers need "full" (§3.12). */
  access?: "ask" | "project" | "full" | null;
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
  cliWorkers = [],
  value,
  onChange,
  disabled,
  label,
  placeholder,
}: {
  id: string;
  models: BuildCrewPickerModel[];
  /** Only the worker select passes these. */
  cliWorkers?: CliWorkerCrewOption[];
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
        {cliWorkers.length > 0 && (
          <SelectGroup>
            <div className="px-2 pb-1 pt-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">CLI workers</div>
            {cliWorkers.map((option) => (
              <SelectItem key={option.runtimeId} value={option.runtimeId} disabled={Boolean(option.disabledReason)}>
                {option.name}
                {option.health.state !== "ready" ? ` (${option.health.label.toLowerCase()})` : ""}
              </SelectItem>
            ))}
          </SelectGroup>
        )}
      </SelectContent>
    </Select>
  );
}

/** A CLI worker row's health, as Settings shows it. */
export function CliHealthBadge({ option }: { option: CliWorkerCrewOption | undefined }) {
  if (!option) return <Badge variant="secondary">CLI · not set up</Badge>;
  const { state, label, reason } = option.health;
  const variant = state === "ready" ? "success" : state === "refused" ? "destructive" : state === "unavailable" ? "warning" : "secondary";
  return <Badge variant={variant} title={reason}>CLI · {label}</Badge>;
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
  cliWorkers = [],
  access,
}: BuildCrewPickerProps) {
  const full = guidance === "full";
  // CLI runtimes are workers only (§3.13): never offered as Architect or reviewer.
  const apiModels = models.filter((model) => !isCliRuntimeId(model.fullId));
  const apiArchitectModels = architectModels.filter((model) => !isCliRuntimeId(model.fullId));
  const cliOption = (id: string) => cliWorkers.find((option) => option.runtimeId === id);
  const nameOf = (id: string) =>
    models.find((model) => model.fullId === id)?.name ?? cliOption(id)?.name ?? cliRuntimeDisplayName(id) ?? id;
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
  const draftIsCli = isCliRuntimeId(draftWorker.modelId);
  // A CLI's effort is set in Settings, and one CLI model is one runtime: it is in the crew at most once.
  const duplicateDraft = value.workers.some(
    (worker) => worker.modelId === draftWorker.modelId && (draftIsCli || worker.reasoningEffort === draftWorker.reasoningEffort)
  );
  const draftRefusal = draftIsCli ? cliOption(draftWorker.modelId)?.disabledReason : undefined;
  const addWorker = () => {
    if (!draftWorker.modelId || duplicateDraft || draftRefusal) return;
    const member: BuildCrewMember = draftIsCli
      ? { modelId: draftWorker.modelId, reasoningEffort: "default" }
      : { ...draftWorker };
    onChange({ ...value, workers: [...value.workers, member] });
    setDraftWorker({ modelId: "", reasoningEffort: draftWorker.reasoningEffort });
  };
  const cliCrewWorkers = value.workers.filter((worker) => isCliRuntimeId(worker.modelId));

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
            models={apiArchitectModels}
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
            models={apiModels}
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
            {value.workers.map((worker, index) => {
              const cli = isCliRuntimeId(worker.modelId);
              const option = cli ? cliOption(worker.modelId) : undefined;
              return (
              <li
                key={`${worker.modelId}:${index}`}
                className="grid items-center gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,14rem)_7.5rem]"
              >
                <div className="flex min-w-0 items-center gap-2 rounded-md border bg-background/40 px-3 py-2 text-sm">
                  <span className="w-4 shrink-0 text-xs text-muted-foreground">{index + 1}</span>
                  <span className="truncate">{nameOf(worker.modelId)}</span>
                  {cli ? <CliHealthBadge option={option} /> : <ProbeBadge status={probeStatus?.(worker.modelId)} />}
                </div>
                {cli ? (
                  <span className="px-1 text-xs text-muted-foreground">
                    {option?.reasoningEffort ? `${option.reasoningEffort} effort` : "CLI default effort"}, set in Settings
                  </span>
                ) : (
                  <EffortSelect
                    id={`${idPrefix}-worker-${index}-effort`}
                    label={`${nameOf(worker.modelId)} reasoning effort`}
                    value={worker.reasoningEffort}
                    onChange={(reasoningEffort) => setWorker(index, { reasoningEffort })}
                    disabled={disabled}
                  />
                )}
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
              );
            })}
          </ul>
        )}
        <div className="grid items-center gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,14rem)_7.5rem]">
          <ModelSelect
            id={`${idPrefix}-worker-add`}
            label="Worker model to add"
            models={apiModels}
            cliWorkers={cliWorkers}
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
            disabled={disabled || draftIsCli}
          />
          <Button
            type="button"
            variant="outline"
            onClick={addWorker}
            disabled={disabled || !draftWorker.modelId || duplicateDraft || Boolean(draftRefusal)}
          >
            <Plus className="h-4 w-4" aria-hidden="true" />
            Add
          </Button>
        </div>
        {duplicateDraft && (
          <p className="text-xs text-muted-foreground">
            {draftIsCli ? "That CLI model is already a worker." : "That model is already a worker at this reasoning effort."}
          </p>
        )}
        {(cliWorkers.length > 0 || cliCrewWorkers.length > 0) && (
          <CliCrewNotes
            options={cliWorkers}
            crewCliWorkers={cliCrewWorkers.map((worker) => ({ name: nameOf(worker.modelId), option: cliOption(worker.modelId) }))}
            access={access}
          />
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

/**
 * Why a CLI row can't be picked, and what a picked one still needs: the Build's Full access, a CLI that isn't refused
 * on this computer, and its setup in Settings. A CLI's use is not counted toward a USD budget (CWD-5).
 */
function CliCrewNotes({
  options,
  crewCliWorkers,
  access,
}: {
  options: CliWorkerCrewOption[];
  crewCliWorkers: { name: string; option: CliWorkerCrewOption | undefined }[];
  access?: "ask" | "project" | "full" | null;
}) {
  const refusedByCli = [
    ...new Map(options.filter((option) => option.health.state === "refused").map((option) => [option.providerId, option])).values(),
  ];
  const waiting = crewCliWorkers.filter(
    (worker) => worker.option && (worker.option.health.state === "unavailable" || worker.option.health.state === "unknown") && worker.option.health.reason
  );
  return (
    <div className="space-y-1.5 rounded-md bg-muted/40 px-3 py-2 text-xs">
      {access !== "full" && (
        <p className={crewCliWorkers.length > 0 ? "font-medium text-warning" : undefined}>
          {CLI_WORKERS_FULL_ACCESS_REASON}{" "}
          {crewCliWorkers.length > 0
            ? "Choose Full access for the project folder, or remove the CLI workers, to start this Build."
            : "Choose Full access for the project folder to pick one."}
        </p>
      )}
      {refusedByCli.map((option) => (
        <p key={option.providerId}>{option.health.reason}</p>
      ))}
      {crewCliWorkers
        .filter((worker) => !worker.option)
        .map((worker) => (
          <p key={worker.name} className="font-medium text-warning">
            {worker.name} is not turned on in Settings &gt; Providers &gt; CLI workers.
          </p>
        ))}
      {waiting.map((worker) => (
        <p key={worker.name}>
          {worker.name}: {worker.option!.health.reason} A Build gives its tasks to the other workers meanwhile.
        </p>
      ))}
      <p className="text-muted-foreground">
        CLI workers use your own CLI logins. Their use isn&apos;t counted toward a USD budget; the time limits apply.
      </p>
    </div>
  );
}
