"use client";

import {
  AlertTriangle,
  Brain,
  ChevronDown,
  Cpu,
  Database,
  FileCode2,
  FileWarning,
  Gauge,
  Link2,
  Terminal,
} from "lucide-react";
import { useState, type ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { OrchestratorEvent } from "@/lib/orchestrator/engine";

const HISTORY_CAP = 40;

export type BuildContextAssemblyView = Extract<
  OrchestratorEvent,
  { type: "context_assembled" }
>;
export type BuildMemoryEventView = Extract<
  OrchestratorEvent,
  { type: "memory_event" }
>;
export type BuildContextBlobView = Extract<
  OrchestratorEvent,
  { type: "context_blob" }
>;
export type BuildCodeIntelStatusView = Extract<
  OrchestratorEvent,
  { type: "code_intel_status" }
>;
export type BuildBudgetView = Extract<
  OrchestratorEvent,
  { type: "build_budget" }
>;

export interface BuildContextPanelState {
  assemblies: BuildContextAssemblyView[];
  blobs: BuildContextBlobView[];
  memory: BuildMemoryEventView;
  codeIntel: BuildCodeIntelStatusView | null;
  budget: BuildBudgetView | null;
}

export interface VisibleDroppedContextPack {
  assemblyLabel: string;
  modelName: string;
  id: string;
  title: string;
  kind: string;
  reason: string;
  estimatedTokens: number;
}

export interface VisibleBuildContextRef {
  assemblyLabel?: string;
  action?: BuildContextBlobView["action"];
  id: string;
  label?: string;
  kind?: string;
  tokenEstimate?: number;
  charCount?: number;
}

export const EMPTY_BUILD_CONTEXT_PANEL_STATE: BuildContextPanelState = {
  assemblies: [],
  blobs: [],
  memory: {
    type: "memory_event",
    activeDecisions: [],
    failedApproaches: [],
    fragileFiles: [],
    warnings: [],
  },
  codeIntel: null,
  budget: null,
};

export function reduceBuildContextPanelState(
  state: BuildContextPanelState,
  event: OrchestratorEvent
): BuildContextPanelState {
  switch (event.type) {
    case "context_assembled":
      return {
        ...state,
        assemblies: [event, ...state.assemblies].slice(0, HISTORY_CAP),
      };
    case "memory_event":
      return { ...state, memory: event };
    case "context_blob":
      return {
        ...state,
        blobs: [event, ...state.blobs].slice(0, HISTORY_CAP),
      };
    case "code_intel_status": {
      const previous = state.codeIntel;
      return {
        ...state,
        codeIntel: {
          ...event,
          architectureDigestIncluded:
            event.architectureDigestIncluded ||
            previous?.architectureDigestIncluded === true,
          changeImpactDigestIncluded:
            event.changeImpactDigestIncluded ||
            previous?.changeImpactDigestIncluded === true,
        },
      };
    }
    case "build_budget":
      return { ...state, budget: event };
    default:
      return state;
  }
}

export function getVisibleBuildContextAssemblies(
  state: BuildContextPanelState
): BuildContextAssemblyView[] {
  return state.assemblies.slice(0, 8);
}

export function getVisibleBuildContextDroppedPacks(
  state: BuildContextPanelState
): VisibleDroppedContextPack[] {
  return state.assemblies
    .flatMap((assembly) =>
      assembly.droppedPacks.map((pack) => ({
        assemblyLabel: assembly.label,
        modelName: assembly.modelName,
        ...pack,
      }))
    )
    .slice(0, 12);
}

export function getVisibleBuildContextRetrieveRefs(
  state: BuildContextPanelState
): VisibleBuildContextRef[] {
  const assemblyRefs = state.assemblies.flatMap((assembly) =>
    assembly.retrieveRefs.map((ref) => ({
      assemblyLabel: assembly.label,
      id: ref.id,
      label: ref.label,
      kind: ref.kind,
      tokenEstimate: ref.tokenEstimate,
    }))
  );
  const blobRefs = state.blobs.map((blob) => ({
    action: blob.action,
    id: blob.ref,
    label: blob.label,
    kind: blob.kind,
    tokenEstimate: blob.tokenEstimate,
    charCount: blob.charCount,
  }));
  return [...assemblyRefs, ...blobRefs].slice(0, 12);
}

function formatTokens(tokens: number | undefined): string {
  if (tokens == null) return "n/a";
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}k`;
  return String(tokens);
}

function formatBytes(chars: number): string {
  if (chars >= 1_000_000) return `${(chars / 1_000_000).toFixed(1)} MB`;
  if (chars >= 1_000) return `${(chars / 1_000).toFixed(1)} KB`;
  return `${chars} B`;
}

function formatBudgetValue(value: number | undefined): string {
  return value == null ? "n/a" : `${value} left`;
}

function formatBudgetRatio(value: number | undefined, limit: number | undefined): string {
  if (value == null) return "n/a";
  return limit == null ? `${value} left` : `${value} left / ${limit}`;
}

export const formatBuildBudgetRatioForTest = formatBudgetRatio;

function BudgetCell({
  label,
  value,
  detail,
}: {
  label: string;
  value: string;
  detail?: string;
}) {
  return (
    <div className="min-w-0 rounded-md border bg-muted/20 px-2 py-1.5">
      <p className="truncate text-[0.65rem] font-medium uppercase text-muted-foreground">
        {label}
      </p>
      <p className="truncate text-sm font-semibold">{value}</p>
      {detail && <p className="truncate text-[0.65rem] text-muted-foreground">{detail}</p>}
    </div>
  );
}

function BuildBudgetStrip({ budget }: { budget: BuildBudgetView }) {
  return (
    <div className="border-t px-4 py-3">
      <div className="mb-3 grid gap-2">
        <div className="min-w-0">
          <p className="flex items-center gap-1.5 text-xs font-medium uppercase text-muted-foreground">
            <Gauge className="h-3.5 w-3.5" />
            Budgets remaining
          </p>
          <p className="mt-0.5 truncate text-xs text-muted-foreground">
            {budget.label}
            {budget.cycle == null ? "" : ` - wave ${budget.cycle}`}
          </p>
        </div>
        <span className="flex flex-wrap items-center gap-1.5">
          <Badge variant="outline">{budget.phase}</Badge>
          <Badge variant={budget.shell.toolAvailable ? "success" : "destructive"}>
            shell {budget.shell.toolAvailable ? "available" : "blocked"}
          </Badge>
          {budget.taskId && <Badge variant="outline">{budget.taskId}</Badge>}
          {budget.worker && <Badge variant="secondary">{budget.worker}</Badge>}
        </span>
      </div>
      <div className="grid gap-3">
        <div className="min-w-0">
          <p className="mb-1 flex items-center gap-1.5 text-[0.65rem] font-medium uppercase text-muted-foreground">
            <Terminal className="h-3 w-3" />
            Shell runs left
          </p>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
            <BudgetCell
              label="Task budget"
              value={formatBudgetValue(budget.shell.taskRunsLeft)}
              detail="worker"
            />
            <BudgetCell
              label="Phase budget"
              value={`${budget.shell.phaseRunsLeft}/${budget.shell.phaseRunsLimit}`}
            />
            <BudgetCell
              label="Run budget"
              value={`${budget.shell.totalRunsLeft}/${budget.shell.totalRunsLimit}`}
            />
          </div>
        </div>
        <div className="min-w-0">
          <p className="mb-1 flex items-center gap-1.5 text-[0.65rem] font-medium uppercase text-muted-foreground">
            <FileCode2 className="h-3 w-3" />
            File operations left
          </p>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-6">
            <BudgetCell
              label="Reads"
              value={formatBudgetRatio(budget.files.readsLeft, budget.files.readsLimit)}
            />
            <BudgetCell
              label="Ranges"
              value={formatBudgetRatio(budget.files.rangeReadsLeft, budget.files.rangeReadsLimit)}
            />
            <BudgetCell
              label="Searches"
              value={formatBudgetRatio(budget.files.searchesLeft, budget.files.searchesLimit)}
            />
            <BudgetCell
              label="Patches"
              value={formatBudgetRatio(budget.files.patchesLeft, budget.files.patchesLimit)}
            />
            <BudgetCell
              label="Appends"
              value={formatBudgetRatio(budget.files.appendsLeft, budget.files.appendsLimit)}
            />
            <BudgetCell
              label="Fetches"
              value={formatBudgetRatio(budget.files.fetchesLeft, budget.files.fetchesLimit)}
              detail={
                budget.files.phaseFetchesLeft == null
                  ? undefined
                  : `${formatBudgetRatio(
                      budget.files.phaseFetchesLeft,
                      budget.files.phaseFetchesLimit
                    )} phase`
              }
            />
          </div>
        </div>
      </div>
    </div>
  );
}

function statusVariant(
  status: BuildCodeIntelStatusView["status"] | undefined
): "success" | "warning" | "secondary" | "destructive" {
  switch (status) {
    case "available":
    case "auto_included":
      return "success";
    case "fallback":
      return "warning";
    case "error":
      return "destructive";
    default:
      return "secondary";
  }
}

function memoryCount(memory: BuildMemoryEventView): number {
  return (
    memory.activeDecisions.length +
    memory.failedApproaches.length +
    memory.fragileFiles.length
  );
}

function budgetLabel(budget: BuildBudgetView): string {
  return `${budget.label}${budget.cycle == null ? "" : ` - wave ${budget.cycle}`}`;
}

export function getBuildContextPanelSummaryForTest(state: BuildContextPanelState): {
  latestBudgetLabel: string | null;
  shellAvailable: boolean | null;
  contextCount: number;
  visibleContextCount: number;
  retrieveRefCount: number;
  memoryCount: number;
  droppedPackCount: number;
  hasCodeIntel: boolean;
} {
  return {
    latestBudgetLabel: state.budget ? budgetLabel(state.budget) : null,
    shellAvailable: state.budget?.shell.toolAvailable ?? null,
    contextCount: state.assemblies.length,
    visibleContextCount: getVisibleBuildContextAssemblies(state).length,
    retrieveRefCount: getVisibleBuildContextRetrieveRefs(state).length,
    memoryCount: memoryCount(state.memory),
    droppedPackCount: getVisibleBuildContextDroppedPacks(state).length,
    hasCodeIntel: state.codeIntel != null,
  };
}

export function hasBuildMemoryEntryRefs(
  item: BuildMemoryEventView["activeDecisions"][number]
): boolean {
  return (item.paths?.length ?? 0) > 0 || (item.taskIds?.length ?? 0) > 0;
}

function MemoryList({
  title,
  items,
}: {
  title: string;
  items: BuildMemoryEventView["activeDecisions"];
}) {
  if (items.length === 0) return null;
  return (
    <div>
      <p className="mb-1 text-xs font-medium uppercase text-muted-foreground">
        {title}
      </p>
      <ul className="space-y-1">
        {items.slice(0, 4).map((item) => (
          <li key={item.id} className="rounded-md border bg-muted/20 px-2 py-1.5">
            <p className="line-clamp-2 text-xs font-medium">{item.summary}</p>
            {hasBuildMemoryEntryRefs(item) && (
              <p className="mt-0.5 truncate font-mono text-[0.65rem] text-muted-foreground">
                {[...(item.paths ?? []), ...(item.taskIds ?? [])].slice(0, 3).join(" - ")}
              </p>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

function BuildMemoryPanel({ memory }: { memory: BuildMemoryEventView }) {
  return (
    <div>
      <p className="mb-2 flex items-center gap-1.5 text-xs font-medium uppercase text-muted-foreground">
        <Brain className="h-3.5 w-3.5" />
        Memory
      </p>
      {memoryCount(memory) > 0 ? (
        <div className="space-y-3">
          <MemoryList title="Decisions" items={memory.activeDecisions} />
          <MemoryList title="Failed approaches" items={memory.failedApproaches} />
          <MemoryList title="Fragile files" items={memory.fragileFiles} />
          {memory.warnings.length > 0 && (
            <div className="rounded-md border border-amber-300 bg-amber-50 px-2 py-1.5 text-xs text-amber-900 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-100">
              <p className="mb-1 flex items-center gap-1 font-medium">
                <FileWarning className="h-3.5 w-3.5" />
                Warnings
              </p>
              {memory.warnings.slice(0, 3).map((warning) => (
                <p key={warning} className="line-clamp-2">
                  {warning}
                </p>
              ))}
            </div>
          )}
        </div>
      ) : (
        <p className="rounded-md border bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
          No active Build memory warnings yet.
        </p>
      )}
    </div>
  );
}

function CompactDetails({
  title,
  count,
  icon,
  children,
}: {
  title: string;
  count?: number;
  icon: ReactNode;
  children: ReactNode;
}) {
  return (
    <details className="rounded-md border bg-muted/10">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-3 py-2 text-xs font-medium uppercase text-muted-foreground marker:hidden">
        <span className="flex min-w-0 items-center gap-1.5">
          {icon}
          <span className="truncate">{title}</span>
        </span>
        {count != null && <Badge variant="secondary">{count}</Badge>}
      </summary>
      <div className="border-t px-3 py-2">{children}</div>
    </details>
  );
}

export function BuildContextPanel({ state }: { state: BuildContextPanelState }) {
  const [open, setOpen] = useState(true);
  const latest = state.assemblies[0];
  const visibleAssemblies = getVisibleBuildContextAssemblies(state);
  const visibleDroppedPacks = getVisibleBuildContextDroppedPacks(state);
  const visibleRetrieveRefs = getVisibleBuildContextRetrieveRefs(state);
  const hasRetrieveRefs = visibleRetrieveRefs.length > 0;
  const summary = getBuildContextPanelSummaryForTest(state);
  const hasData =
    state.assemblies.length > 0 ||
    state.blobs.length > 0 ||
    memoryCount(state.memory) > 0 ||
    state.codeIntel != null ||
    state.budget != null;

  if (!hasData) return null;

  return (
    <section className="rounded-lg border bg-card shadow-sm">
      <div className="flex items-center justify-between gap-3 px-4 py-3">
        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          aria-expanded={open}
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
        >
          <Gauge className="h-4 w-4 shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-semibold">Build context</span>
            <span className="block truncate text-xs text-muted-foreground">
              {state.budget
                ? `Budget: ${budgetLabel(state.budget)}`
                : latest
                ? `${latest.modelName}: ~${formatTokens(latest.estimatedInputTokens)} / ${formatTokens(latest.totalInputBudgetTokens)} input tokens`
                : "Context, memory, refs, and code intelligence"}
            </span>
          </span>
          <ChevronDown
            className={cn(
              "h-4 w-4 shrink-0 text-muted-foreground transition-transform",
              open && "rotate-180"
            )}
          />
        </button>
        <span className="flex shrink-0 items-center gap-2">
          {latest && latest.omittedPackCount > 0 && (
            <Badge variant="warning">{latest.omittedPackCount} dropped</Badge>
          )}
          {state.assemblies.length > 1 && (
            <Badge variant="secondary">{state.assemblies.length} contexts</Badge>
          )}
          {state.codeIntel && (
            <Badge variant={statusVariant(state.codeIntel.status)}>
              {state.codeIntel.status.replaceAll("_", " ")}
            </Badge>
          )}
        </span>
      </div>

      {state.budget && <BuildBudgetStrip budget={state.budget} />}

      {open && (
        <div className="grid gap-4 border-t px-4 py-3 xl:grid-cols-[minmax(0,0.95fr)_minmax(0,1.05fr)]">
          <BuildMemoryPanel memory={state.memory} />

          <div className="space-y-2">
            <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
              <span className="mr-1 font-medium uppercase">Compact activity</span>
              <Badge variant="outline">{summary.contextCount} contexts</Badge>
              <Badge variant="outline">{summary.retrieveRefCount} refs</Badge>
              {summary.droppedPackCount > 0 && (
                <Badge variant="warning">{summary.droppedPackCount} dropped</Badge>
              )}
              {state.codeIntel && (
                <Badge variant={statusVariant(state.codeIntel.status)}>
                  {state.codeIntel.status.replaceAll("_", " ")}
                </Badge>
              )}
            </div>

            {latest ? (
              <CompactDetails
                title="Recent contexts"
                count={visibleAssemblies.length}
                icon={<Cpu className="h-3.5 w-3.5" />}
              >
                <ul className="space-y-1">
                  {visibleAssemblies.map((assembly) => (
                    <li
                      key={`${assembly.phase}-${assembly.label}-${assembly.modelId}`}
                      className="rounded-md border bg-muted/20 px-2 py-1.5"
                    >
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <p className="min-w-0 truncate text-xs font-medium">
                          {assembly.label}
                        </p>
                        <span className="flex shrink-0 items-center gap-1.5">
                          <Badge variant="outline">{assembly.contextTier}</Badge>
                          <Badge variant={assembly.omittedPackCount > 0 ? "warning" : "secondary"}>
                            {assembly.omittedPackCount} dropped
                          </Badge>
                        </span>
                      </div>
                      <p className="mt-1 truncate text-xs text-muted-foreground">
                        {assembly.modelName} - ~{formatTokens(assembly.estimatedInputTokens)} /{" "}
                        {formatTokens(assembly.totalInputBudgetTokens)} input tokens;{" "}
                        {assembly.selectedPackCount} packs selected
                      </p>
                    </li>
                  ))}
                </ul>
              </CompactDetails>
            ) : null}

            {hasRetrieveRefs && (
              <CompactDetails
                title="Retrieve refs"
                count={visibleRetrieveRefs.length}
                icon={<Link2 className="h-3.5 w-3.5" />}
              >
                <ul className="grid gap-1 sm:grid-cols-2">
                  {visibleRetrieveRefs.map((ref) => (
                    <li
                      key={`${ref.id}-${ref.action ?? ref.assemblyLabel ?? "selected"}`}
                      className="rounded-md border bg-muted/20 px-2 py-1.5"
                    >
                      <p className="truncate font-mono text-[0.7rem]">{ref.id}</p>
                      <p className="truncate text-xs text-muted-foreground">
                        {ref.label ?? "stored context"} -{" "}
                        {ref.charCount != null ? `${formatBytes(ref.charCount)}, ` : ""}
                        ~{formatTokens(ref.tokenEstimate)}
                      </p>
                      {(ref.assemblyLabel || ref.action) && (
                        <p className="truncate text-[0.65rem] text-muted-foreground">
                          {ref.assemblyLabel ?? ref.action}
                        </p>
                      )}
                    </li>
                  ))}
                </ul>
              </CompactDetails>
            )}

            {visibleDroppedPacks.length > 0 && (
              <CompactDetails
                title="Dropped packs"
                count={visibleDroppedPacks.length}
                icon={<AlertTriangle className="h-3.5 w-3.5" />}
              >
                <ul className="space-y-1">
                  {visibleDroppedPacks.map((pack) => (
                    <li
                      key={`${pack.assemblyLabel}-${pack.id}`}
                      className="flex items-center justify-between gap-2 rounded-md border bg-muted/20 px-2 py-1.5 text-xs"
                    >
                      <span className="min-w-0">
                        <span className="block truncate">{pack.title}</span>
                        <span className="block truncate text-muted-foreground">
                          {pack.assemblyLabel} - {pack.modelName}
                        </span>
                      </span>
                      <span className="shrink-0 text-right text-muted-foreground">
                        {pack.reason}
                        <br />~{formatTokens(pack.estimatedTokens)}
                      </span>
                    </li>
                  ))}
                </ul>
              </CompactDetails>
            )}

            <CompactDetails
              title="Code intelligence"
              count={state.codeIntel ? 1 : 0}
              icon={<Database className="h-3.5 w-3.5" />}
            >
              {state.codeIntel ? (
                <div className="rounded-md border bg-muted/20 p-2">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="text-sm font-medium">{state.codeIntel.provider}</p>
                    <Badge variant={statusVariant(state.codeIntel.status)}>
                      {state.codeIntel.available ? "available" : "unavailable"}
                    </Badge>
                  </div>
                  <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">
                    {state.codeIntel.detail}
                  </p>
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    <Badge variant={state.codeIntel.architectureDigestIncluded ? "success" : "outline"}>
                      architecture {state.codeIntel.architectureDigestIncluded ? "included" : "not included"}
                    </Badge>
                    <Badge variant={state.codeIntel.changeImpactDigestIncluded ? "success" : "outline"}>
                      impact {state.codeIntel.changeImpactDigestIncluded ? "included" : "not included"}
                    </Badge>
                    {state.codeIntel.callsLeft != null && (
                      <Badge variant="secondary">{state.codeIntel.callsLeft} calls left</Badge>
                    )}
                  </div>
                </div>
              ) : (
                <p className="rounded-md border bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
                  Code intelligence status appears after runner setup.
                </p>
              )}
            </CompactDetails>
          </div>
        </div>
      )}
    </section>
  );
}
