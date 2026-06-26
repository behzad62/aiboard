"use client";

import {
  AlertTriangle,
  Brain,
  ChevronDown,
  Cpu,
  Database,
  FileWarning,
  Gauge,
  Link2,
} from "lucide-react";
import { useState } from "react";
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

export interface BuildContextPanelState {
  assemblies: BuildContextAssemblyView[];
  blobs: BuildContextBlobView[];
  memory: BuildMemoryEventView;
  codeIntel: BuildCodeIntelStatusView | null;
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
            {(item.paths?.length || item.taskIds?.length) && (
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

export function BuildContextPanel({ state }: { state: BuildContextPanelState }) {
  const [open, setOpen] = useState(true);
  const latest = state.assemblies[0];
  const visibleAssemblies = getVisibleBuildContextAssemblies(state);
  const visibleDroppedPacks = getVisibleBuildContextDroppedPacks(state);
  const visibleRetrieveRefs = getVisibleBuildContextRetrieveRefs(state);
  const hasRetrieveRefs = visibleRetrieveRefs.length > 0;
  const hasData =
    state.assemblies.length > 0 ||
    state.blobs.length > 0 ||
    memoryCount(state.memory) > 0 ||
    state.codeIntel != null;

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
              {latest
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

      {open && (
        <div className="grid gap-4 border-t px-4 py-3 xl:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
          <div className="space-y-4">
            <div>
              <p className="mb-2 flex items-center gap-1.5 text-xs font-medium uppercase text-muted-foreground">
                <Cpu className="h-3.5 w-3.5" />
                Context
              </p>
              {latest ? (
                <ul className="space-y-1">
                  {visibleAssemblies.map((assembly) => (
                    <li
                      key={`${assembly.phase}-${assembly.label}-${assembly.modelId}`}
                      className="rounded-md border bg-muted/20 p-2"
                    >
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <p className="min-w-0 truncate text-sm font-medium">
                          {assembly.label}
                        </p>
                        <span className="flex shrink-0 items-center gap-1.5">
                          <Badge variant="outline">{assembly.contextTier}</Badge>
                          <Badge variant={assembly.omittedPackCount > 0 ? "warning" : "secondary"}>
                            {assembly.omittedPackCount} dropped
                          </Badge>
                        </span>
                      </div>
                      <div className="mt-2 grid gap-2 text-xs text-muted-foreground sm:grid-cols-2">
                        <span>Model: {assembly.modelName}</span>
                        <span>
                          Context size: {formatTokens(assembly.modelContextWindowTokens)}
                        </span>
                        <span>
                          Input used: ~{formatTokens(assembly.estimatedInputTokens)} /{" "}
                          {formatTokens(assembly.totalInputBudgetTokens)}
                        </span>
                        <span>
                          Packs: {assembly.selectedPackCount} selected,{" "}
                          {assembly.omittedPackCount} dropped
                        </span>
                      </div>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="rounded-md border bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
                  Context assemblies appear when Build starts planning.
                </p>
              )}
            </div>

            {visibleDroppedPacks.length > 0 ? (
              <div>
                <p className="mb-2 flex items-center gap-1.5 text-xs font-medium uppercase text-muted-foreground">
                  <AlertTriangle className="h-3.5 w-3.5" />
                  Dropped packs
                </p>
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
              </div>
            ) : null}

            {hasRetrieveRefs && (
              <div>
                <p className="mb-2 flex items-center gap-1.5 text-xs font-medium uppercase text-muted-foreground">
                  <Link2 className="h-3.5 w-3.5" />
                  Retrieve refs
                </p>
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
              </div>
            )}
          </div>

          <div className="space-y-4">
            <div>
              <p className="mb-2 flex items-center gap-1.5 text-xs font-medium uppercase text-muted-foreground">
                <Brain className="h-3.5 w-3.5" />
                Memory
              </p>
              {memoryCount(state.memory) > 0 ? (
                <div className="space-y-3">
                  <MemoryList title="Decisions" items={state.memory.activeDecisions} />
                  <MemoryList title="Failed approaches" items={state.memory.failedApproaches} />
                  <MemoryList title="Fragile files" items={state.memory.fragileFiles} />
                  {state.memory.warnings.length > 0 && (
                    <div className="rounded-md border border-amber-300 bg-amber-50 px-2 py-1.5 text-xs text-amber-900 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-100">
                      <p className="mb-1 flex items-center gap-1 font-medium">
                        <FileWarning className="h-3.5 w-3.5" />
                        Warnings
                      </p>
                      {state.memory.warnings.slice(0, 3).map((warning) => (
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

            <div>
              <p className="mb-2 flex items-center gap-1.5 text-xs font-medium uppercase text-muted-foreground">
                <Database className="h-3.5 w-3.5" />
                Code intelligence
              </p>
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
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
