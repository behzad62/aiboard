"use client";

import { Activity, Bot, Database, Hammer, ListChecks, Wrench } from "lucide-react";

import type { NativeBuildObservability } from "@/lib/client/runner-v2";
import { formatTokenCount } from "@/lib/client/token-usage";
import { Badge } from "@/components/ui/badge";

export function runnerObservabilitySummary(snapshot: NativeBuildObservability) {
  return {
    modelCalls: snapshot.budget.effective.modelCalls,
    toolCalls: snapshot.toolCallCount,
    totalTokens:
      snapshot.budget.effective.inputTokens +
      snapshot.budget.effective.outputTokens,
    agents: snapshot.agents.length,
    suspendedAgents: snapshot.agents.filter((agent) => agent.status === "suspended").length,
    toolErrors: snapshot.tools.filter((tool) => tool.isError).length,
    evidence: snapshot.evidence.length,
    memories: snapshot.memories.length,
    skills: snapshot.skills.length,
    runningProcesses: snapshot.processes.filter((process) => process.status === "running").length,
  };
}

export function RunnerV2ObservabilityPanel({
  snapshot,
}: {
  snapshot: NativeBuildObservability | null;
}) {
  if (!snapshot) return null;
  const summary = runnerObservabilitySummary(snapshot);
  return (
    <section className="rounded-lg border bg-card shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b px-4 py-3">
        <div className="flex items-center gap-2">
          <Activity className="h-4 w-4 text-muted-foreground" />
          <div>
            <h2 className="text-sm font-semibold">Runner V2 observability</h2>
            <p className="text-xs text-muted-foreground">
              Durable agents, tools, evidence, memory, skills, and processes
            </p>
          </div>
        </div>
        <Badge variant={summary.toolErrors > 0 ? "warning" : "secondary"}>
          {summary.toolErrors} tool error{summary.toolErrors === 1 ? "" : "s"}
        </Badge>
      </div>

      <div className="grid grid-cols-2 gap-px bg-border sm:grid-cols-3 lg:grid-cols-6">
        <Stat label="Model calls" value={String(summary.modelCalls)} />
        <Stat label="Tool calls" value={String(summary.toolCalls)} />
        <Stat label="Tokens" value={formatTokenCount(summary.totalTokens)} />
        <Stat label="Agents" value={String(summary.agents)} />
        <Stat label="Evidence" value={String(summary.evidence)} />
        <Stat label="Active processes" value={String(summary.runningProcesses)} />
      </div>

      <div className="grid gap-3 border-t p-4 lg:grid-cols-2">
        <ObservationList
          icon={<Bot className="h-3.5 w-3.5" />}
          title="Agent sessions"
          empty="No agent sessions recorded."
          items={snapshot.agents.slice(-12).reverse().map((agent) => ({
            key: agent.sessionId,
            title: `${agent.actor.role}: ${agent.actor.id}`,
            detail: `${agent.status} · ${agent.turns} turn${agent.turns === 1 ? "" : "s"}${
              agent.suspensionReason ? ` · ${agent.suspensionReason}` : ""
            }`,
          }))}
        />
        <ObservationList
          icon={<Wrench className="h-3.5 w-3.5" />}
          title="Recent tools"
          empty="No native tool calls recorded."
          items={snapshot.tools.slice(-12).reverse().map((tool) => ({
            key: `${tool.sessionId}:${tool.callId}`,
            title: tool.toolName,
            detail: `${tool.status}${tool.errorCode ? ` · ${tool.errorCode}` : ""}`,
          }))}
        />
        <ObservationList
          icon={<ListChecks className="h-3.5 w-3.5" />}
          title="Evidence"
          empty="No command evidence recorded."
          items={snapshot.evidence.slice(-8).reverse().map((evidence) => ({
            key: evidence.id,
            title: evidence.fact.label,
            detail: `${evidence.taskId} · exit ${evidence.fact.exitCode ?? "signal"}`,
          }))}
        />
        <ObservationList
          icon={<Database className="h-3.5 w-3.5" />}
          title="Context resources"
          empty="No skills or project memories discovered."
          items={[
            ...snapshot.skills.slice(0, 8).map((skill) => ({
              key: `skill:${skill.id}`,
              title: skill.name,
              detail: `${skill.source} skill`,
            })),
            ...snapshot.memories.slice(-4).reverse().map((memory) => ({
              key: `memory:${memory.id}`,
              title: memory.content.slice(0, 80),
              detail: `${memory.status} project memory`,
            })),
          ]}
        />
      </div>

      {snapshot.processes.length > 0 && (
        <div className="border-t px-4 py-3">
          <div className="mb-2 flex items-center gap-2 text-xs font-medium">
            <Hammer className="h-3.5 w-3.5" /> Background processes
          </div>
          <div className="space-y-1 font-mono text-xs text-muted-foreground">
            {snapshot.processes.slice(-8).reverse().map((process) => (
              <p key={process.processId} className="truncate">
                {process.status} · {process.command} {process.args.join(" ")}
              </p>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-card px-3 py-2.5">
      <p className="text-[0.65rem] uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="mt-0.5 font-mono text-sm font-semibold tabular-nums">{value}</p>
    </div>
  );
}

function ObservationList({
  icon,
  title,
  empty,
  items,
}: {
  icon: React.ReactNode;
  title: string;
  empty: string;
  items: Array<{ key: string; title: string; detail: string }>;
}) {
  return (
    <div className="rounded-md border bg-muted/10 p-3">
      <div className="mb-2 flex items-center gap-2 text-xs font-medium">
        {icon} {title}
      </div>
      {items.length > 0 ? (
        <ul className="space-y-2">
          {items.map((item) => (
            <li key={item.key} className="min-w-0">
              <p className="truncate text-xs font-medium">{item.title}</p>
              <p className="truncate text-[0.68rem] text-muted-foreground">{item.detail}</p>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-xs text-muted-foreground">{empty}</p>
      )}
    </div>
  );
}
