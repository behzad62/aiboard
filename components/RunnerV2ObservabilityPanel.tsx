"use client";

import { useState } from "react";
import { Activity, Bot, Database, Download, GitBranch, Hammer, ListChecks, MessageSquareText, Search, Server, Wrench } from "lucide-react";

import type { NativeBuildObservability, NativeBuildProjection } from "@/lib/client/runner-v2";
import { formatTokenCount } from "@/lib/client/token-usage";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

export function runnerObservabilitySummary(snapshot: NativeBuildObservability) {
  return {
    modelCalls: snapshot.budget.effective.modelCalls,
    toolCalls: snapshot.toolCallCount,
    totalTokens:
      snapshot.budget.effective.inputTokens +
      snapshot.budget.effective.outputTokens,
    cachedInputTokens: snapshot.budget.effective.cachedInputTokens ?? 0,
    cacheWriteInputTokens:
      snapshot.budget.effective.cacheWriteInputTokens ?? 0,
    agents: snapshot.agents.length,
    suspendedAgents: snapshot.agents.filter((agent) => agent.status === "suspended").length,
    toolErrors: snapshot.tools.filter((tool) => tool.isError).length,
    evidence: snapshot.evidence.length,
    memories: snapshot.memories.length,
    skills: snapshot.skills.length,
    runningProcesses: snapshot.processes.filter((process) => process.status === "running").length,
    providers: snapshot.providers.length,
    events: snapshot.events.length,
  };
}

type SearchableObservability = Pick<
  NativeBuildObservability,
  | "agents"
  | "tools"
  | "evidence"
  | "memories"
  | "skills"
  | "processes"
  | "providers"
  | "events"
>;

export function filterRunnerObservability<T extends SearchableObservability>(
  snapshot: T,
  query: string
): SearchableObservability {
  const normalized = query.trim().toLowerCase();
  const filter = <TValue,>(values: TValue[]) =>
    normalized
      ? values.filter((value) => JSON.stringify(value).toLowerCase().includes(normalized))
      : values;
  return {
    agents: filter(snapshot.agents),
    tools: filter(snapshot.tools),
    evidence: filter(snapshot.evidence),
    memories: filter(snapshot.memories),
    skills: filter(snapshot.skills),
    processes: filter(snapshot.processes),
    providers: filter(snapshot.providers),
    events: filter(snapshot.events),
  };
}

export function runnerBuildControlSummary(projection: NativeBuildProjection | null) {
  if (!projection) return { guidance: [], integration: [], branch: undefined, revision: undefined };
  return {
    guidance: Object.values(projection.guidance),
    integration: Object.values(projection.tasks)
      .filter((task) => task.changeSetId || task.integrationRevision || [
        "submitted",
        "architect_review",
        "approved",
        "integrating",
        "integration_resolution",
        "integrated",
      ].includes(task.status))
      .map((task) => ({
        taskId: task.id,
        objective: task.objective,
        status: task.status,
        changeSetId: task.changeSetId,
        revision: task.integrationRevision,
        conflictPaths: task.conflictPaths ?? [],
      })),
    branch: projection.projectHandoff?.integrationBranch,
    revision: projection.projectHandoff?.integrationRevision,
  };
}

export function RunnerV2ObservabilityPanel({
  snapshot,
  projection,
  onDownloadAudit,
}: {
  snapshot: NativeBuildObservability | null;
  projection?: NativeBuildProjection | null;
  onDownloadAudit?: () => void;
}) {
  const [query, setQuery] = useState("");
  if (!snapshot) return null;
  const summary = runnerObservabilitySummary(snapshot);
  const filtered = filterRunnerObservability(snapshot, query);
  const control = runnerBuildControlSummary(projection ?? null);
  const matches = <T,>(value: T) =>
    !query.trim() || JSON.stringify(value).toLowerCase().includes(query.trim().toLowerCase());
  const visibleGuidance = control.guidance.filter(matches);
  const visibleIntegration = control.integration.filter(matches);
  const integrationBranch = snapshot.git.integrationBranch || control.branch;
  const integrationRevision = snapshot.git.integrationRevision || control.revision;
  const visibleCommits = snapshot.git.commits.filter(matches);
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
        <div className="flex items-center gap-2">
          {onDownloadAudit && (
            <Button type="button" size="sm" variant="outline" onClick={onDownloadAudit}>
              <Download className="mr-1 h-3.5 w-3.5" />
              Download audit
            </Button>
          )}
          <Badge variant={summary.toolErrors > 0 ? "warning" : "secondary"}>
            {summary.toolErrors} tool error{summary.toolErrors === 1 ? "" : "s"}
          </Badge>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-px bg-border sm:grid-cols-3 lg:grid-cols-6">
        <Stat label="Model calls" value={String(summary.modelCalls)} />
        <Stat label="Tool calls" value={String(summary.toolCalls)} />
        <Stat label="Tokens" value={formatTokenCount(summary.totalTokens)} />
        <Stat
          label="Cache read / write"
          value={`${formatTokenCount(summary.cachedInputTokens)} / ${formatTokenCount(summary.cacheWriteInputTokens)}`}
        />
        <Stat label="Agents" value={String(summary.agents)} />
        <Stat label="Evidence" value={String(summary.evidence)} />
        <Stat label="Active processes" value={String(summary.runningProcesses)} />
      </div>

      <div className="border-t px-4 py-3">
        <label className="relative block max-w-xl">
          <Search className="pointer-events-none absolute left-2.5 top-2.5 h-3.5 w-3.5 text-muted-foreground" />
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search durable runner records"
            className="h-9 w-full rounded-md border bg-background pl-8 pr-3 text-xs outline-none focus:ring-2 focus:ring-ring"
          />
        </label>
      </div>

      <div className="grid gap-3 border-t p-4 lg:grid-cols-2">
        <ObservationList
          icon={<Bot className="h-3.5 w-3.5" />}
          title="Agent sessions"
          empty="No agent sessions recorded."
          items={filtered.agents.slice(-12).reverse().map((agent) => ({
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
          items={filtered.tools.slice(-12).reverse().map((tool) => ({
            key: `${tool.sessionId}:${tool.callId}`,
            title: tool.toolName,
            detail: `${tool.status}${tool.errorCode ? ` · ${tool.errorCode}` : ""}`,
          }))}
        />
        <ObservationList
          icon={<ListChecks className="h-3.5 w-3.5" />}
          title="Evidence"
          empty="No command evidence recorded."
          items={filtered.evidence.slice(-8).reverse().map((evidence) => ({
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
            ...filtered.skills.slice(0, 8).map((skill) => ({
              key: `skill:${skill.id}`,
              title: skill.name,
              detail: `${skill.source} skill`,
            })),
            ...filtered.memories.slice(-4).reverse().map((memory) => ({
              key: `memory:${memory.id}`,
              title: memory.content.slice(0, 80),
              detail: `${memory.status} project memory`,
            })),
          ]}
        />
        <ObservationList
          icon={<Server className="h-3.5 w-3.5" />}
          title="Provider health"
          empty="No provider health transitions recorded."
          items={filtered.providers.map((provider) => ({
            key: provider.providerId,
            title: provider.providerId,
            detail: `${provider.status} · ${provider.consecutiveFailures} consecutive failure${provider.consecutiveFailures === 1 ? "" : "s"}${provider.failureKind ? ` · ${provider.failureKind}` : ""}`,
          }))}
        />
        <ObservationList
          icon={<Activity className="h-3.5 w-3.5" />}
          title="Recent events"
          empty="No matching scheduler events."
          items={filtered.events.slice(-12).reverse().map((event) => ({
            key: `${event.sequence}:${event.type}`,
            title: event.type,
            detail: `${event.actor.role}: ${event.actor.id} · #${event.sequence}`,
          }))}
        />
        <ObservationList
          icon={<MessageSquareText className="h-3.5 w-3.5" />}
          title="Architect guidance"
          empty="No matching guidance exchanges."
          items={visibleGuidance.slice(-10).reverse().map((guidance) => ({
            key: guidance.requestId,
            title: `${guidance.taskId}: ${guidance.question}`,
            detail: `${guidance.status}${guidance.blocking ? " · blocking" : " · advisory"}${guidance.answer ? ` · ${guidance.answer}` : ""}`,
          }))}
        />
        <ObservationList
          icon={<GitBranch className="h-3.5 w-3.5" />}
          title="Integration queue and Git"
          empty="No change sets have entered integration."
          items={[
            ...(integrationBranch && matches(integrationBranch) ? [{
              key: `branch:${integrationBranch}`,
              title: integrationBranch,
              detail: `integration branch${integrationRevision ? ` · ${integrationRevision.slice(0, 12)}` : ""}`,
            }] : []),
            ...visibleCommits.slice(0, 10).map((commit) => ({
              key: `commit:${commit.revision}`,
              title: commit.subject,
              detail: `${commit.revision.slice(0, 12)} · ${commit.parents.length} parent${commit.parents.length === 1 ? "" : "s"}`,
            })),
            ...visibleIntegration.slice(-10).reverse().map((item) => ({
              key: `integration:${item.taskId}`,
              title: `${item.taskId}: ${item.objective}`,
              detail: `${item.status}${item.revision ? ` · ${item.revision.slice(0, 12)}` : ""}${item.conflictPaths.length ? ` · conflicts: ${item.conflictPaths.join(", ")}` : ""}`,
            })),
          ]}
        />
      </div>

      {filtered.processes.length > 0 && (
        <div className="border-t px-4 py-3">
          <div className="mb-2 flex items-center gap-2 text-xs font-medium">
            <Hammer className="h-3.5 w-3.5" /> Background processes
          </div>
          <div className="space-y-1 font-mono text-xs text-muted-foreground">
            {filtered.processes.slice(-8).reverse().map((process) => (
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
