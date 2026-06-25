"use client";

import { Badge } from "@/components/ui/badge";
import { getSkillCard } from "@/lib/skills/registry";
import type { BuildSkillEvent, SkillEvidence } from "@/lib/skills/types";
import { AlertTriangle, BrainCircuit, CheckCircle2 } from "lucide-react";

export type BuildSkillEventView = BuildSkillEvent;

function skillLabel(id: string): string {
  return getSkillCard(id)?.title ?? id;
}

function compactSkillId(id: string): string {
  return id.replace(/^agent:/, "").replace(/^superpowers:/, "sp:").replace(/^aiboard:/, "");
}

function latestEventsByScope(events: BuildSkillEventView[]): BuildSkillEventView[] {
  const byScope = new Map<string, BuildSkillEventView>();
  for (const event of events) {
    byScope.set(event.scope, event);
  }
  return [...byScope.values()].slice(-5).reverse();
}

function evidenceStatus(record: SkillEvidence): {
  label: string;
  variant: "success" | "warning";
} {
  return record.missingEvidence.length > 0
    ? { label: "missing", variant: "warning" }
    : { label: "complete", variant: "success" };
}

export function BuildSkillsPanel({ events }: { events: BuildSkillEventView[] }) {
  if (events.length === 0) return null;

  const active = latestEventsByScope(events);
  const evidence = events.flatMap((event) => event.evidence ?? []).slice(-8).reverse();
  const warnings = events
    .flatMap((event) => event.warnings ?? [])
    .filter(Boolean)
    .slice(-6)
    .reverse();

  return (
    <section className="rounded-lg border bg-card shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b px-4 py-3">
        <div className="flex min-w-0 items-center gap-2">
          <BrainCircuit className="h-4 w-4 shrink-0 text-muted-foreground" />
          <div className="min-w-0">
            <h2 className="text-sm font-semibold">Build skills</h2>
            <p className="truncate text-xs text-muted-foreground">
              AIBoard-routed overlays and evidence gates
            </p>
          </div>
        </div>
        <Badge variant="secondary">{events.length} update{events.length === 1 ? "" : "s"}</Badge>
      </div>

      <div className="grid gap-4 px-4 py-3 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)]">
        <div>
          <p className="mb-2 text-xs font-medium uppercase text-muted-foreground">
            Active skills
          </p>
          <ul className="space-y-2">
            {active.map((event) => (
              <li key={`${event.phase}-${event.scope}`} className="rounded-md border bg-muted/20 p-2">
                <div className="flex items-center justify-between gap-2">
                  <p className="min-w-0 truncate text-sm font-medium">{event.scope}</p>
                  <span className="shrink-0 text-xs text-muted-foreground">{event.phase}</span>
                </div>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {event.activeSkills.map((id) => (
                    <Badge key={id} variant="outline" title={skillLabel(id)}>
                      {compactSkillId(id)}
                    </Badge>
                  ))}
                </div>
              </li>
            ))}
          </ul>
        </div>

        <div className="space-y-4">
          <div>
            <p className="mb-2 text-xs font-medium uppercase text-muted-foreground">
              Evidence
            </p>
            {evidence.length > 0 ? (
              <ul className="space-y-2">
                {evidence.map((record, index) => {
                  const status = evidenceStatus(record);
                  return (
                    <li
                      key={`${record.taskId ?? "review"}-${record.skillId}-${index}`}
                      className="rounded-md border bg-muted/20 p-2"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <p className="min-w-0 truncate text-xs font-medium">
                          {record.taskId ? `${record.taskId} - ` : ""}
                          {compactSkillId(record.skillId)}
                        </p>
                        <Badge variant={status.variant} className="shrink-0 gap-1">
                          <CheckCircle2 className="h-3 w-3" />
                          {status.label}
                        </Badge>
                      </div>
                      <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">
                        {record.missingEvidence.length > 0
                          ? record.missingEvidence.join("; ")
                          : record.reportedEvidence.join(" | ") || "Evidence recorded"}
                      </p>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <p className="rounded-md border bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
                Evidence appears after workers finish tasks that require it.
              </p>
            )}
          </div>

          {warnings.length > 0 && (
            <div className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-100">
              <p className="mb-1 flex items-center gap-1.5 font-medium">
                <AlertTriangle className="h-3.5 w-3.5" />
                Warnings
              </p>
              <ul className="space-y-1">
                {warnings.map((warning, index) => (
                  <li key={`${warning}-${index}`} className="line-clamp-2">
                    {warning}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
