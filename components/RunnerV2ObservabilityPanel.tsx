"use client";

import { useState } from "react";
import {
  Activity,
  AlertTriangle,
  Bot,
  CheckCircle2,
  ChevronDown,
  CircleDot,
  Database,
  Download,
  GitBranch,
  Hammer,
  ListChecks,
  MessageSquareText,
  Search,
  Server,
  ShieldCheck,
  Wrench,
} from "lucide-react";

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

type UserFacingVerificationStatus = "passed" | "failed" | "recorded";

type UserFacingProblem = {
  key: string;
  title: string;
  detail: string;
};

const COMPLETE_TASK_STATUSES = new Set(["integrated", "cancelled"]);

const TASK_STATUS_LABELS: Record<string, string> = {
  planned: "Not started",
  assigned: "Preparing to start",
  running: "In progress",
  waiting_guidance: "Waiting for guidance",
  submitted: "Ready for review",
  architect_review: "Under review",
  approved: "Approved",
  rejected: "Changes requested",
  integrating: "Applying changes",
  integration_resolution: "Resolving source control conflicts",
  integrated: "Complete",
  failed: "Failed",
  cancelled: "No longer needed",
};

function taskStatusLabel(status: string): string {
  return TASK_STATUS_LABELS[status] ?? "Status unavailable";
}

function evidenceCategory(label: string, command: string): string {
  const value = `${label} ${command}`.toLowerCase();
  if (/\b(browser|playwright|screenshot|visual|console)\b/.test(value)) {
    return "Browser checks";
  }
  if (/\b(git|commit|branch|merge|diff|source control)\b/.test(value)) {
    return "Source control";
  }
  if (/\b(test|tests|lint|typecheck|type-check|tsc|vitest|jest)\b/.test(value)) {
    return "Tests";
  }
  return "Other checks";
}

function lifecycleLabel(projection: NativeBuildProjection | null): string {
  if (!projection) return "Waiting for build activity";
  if (projection.projectHandoff?.status === "requested") {
    return "Ready for your decision";
  }
  if (projection.projectHandoff?.status === "selected") {
    return projection.projectHandoff.appliedToProject
      ? "Changes applied to your project"
      : "Decision received";
  }
  if (projection.status === "completed") return "Build complete";
  if (projection.status === "paused") return "Build paused";

  const statuses = Object.values(projection.tasks).map((task) => task.status);
  if (statuses.some((status) => status === "integration_resolution")) {
    return "Resolving source control conflicts";
  }
  if (statuses.some((status) => ["submitted", "architect_review", "approved"].includes(status))) {
    return "Reviewing completed work";
  }
  if (statuses.some((status) => status === "integrating")) {
    return "Applying completed changes";
  }
  if (statuses.some((status) => status === "waiting_guidance")) {
    return "Waiting for guidance";
  }
  if (statuses.length > 0 && statuses.every((status) => status === "planned")) {
    return "Ready to start";
  }
  return "Build in progress";
}

function providerName(providerId: string): string {
  const knownNames: Record<string, string> = {
    anthropic: "Anthropic",
    chatgpt: "ChatGPT",
    google: "Google",
    openai: "OpenAI",
    openrouter: "OpenRouter",
    xai: "xAI",
  };
  return knownNames[providerId.toLowerCase()] ?? "A model provider";
}

export function runnerUserFacingObservability(
  snapshot: NativeBuildObservability,
  projection: NativeBuildProjection | null
): {
  lifecycle: string;
  progress: {
    completed: number;
    total: number;
    items: Array<{ key: string; title: string; detail: string }>;
  };
  verification: Array<{
    key: string;
    category: string;
    title: string;
    detail: string;
    status: UserFacingVerificationStatus;
  }>;
  problems: UserFacingProblem[];
} {
  const tasks = projection ? Object.values(projection.tasks) : [];
  const taskTitles = new Map(tasks.map((task) => [task.id, task.objective]));
  const newestEvidence = new Map<
    string,
    { category: string; record: NativeBuildObservability["evidence"][number] }
  >();

  for (const record of snapshot.evidence) {
    const category = evidenceCategory(record.fact.label, record.fact.command);
    const key = `${record.taskId}:${category}`;
    const current = newestEvidence.get(key);
    if (!current || record.createdAt > current.record.createdAt) {
      newestEvidence.set(key, { category, record });
    }
  }

  const verification = [...newestEvidence.entries()]
    .sort(([, left], [, right]) => right.record.createdAt.localeCompare(left.record.createdAt))
    .map(([key, { category, record }]) => {
      const status: UserFacingVerificationStatus = record.fact.exitCode === 0
        ? "passed"
        : record.fact.exitCode === null
          ? "recorded"
          : "failed";
      const statusLabel = status === "passed"
        ? "Passed"
        : status === "failed"
          ? "Failed"
          : "Recorded";
      return {
        key,
        category,
        title: taskTitles.get(record.taskId) ?? "Build verification",
        detail: `${record.fact.label} · ${statusLabel}`,
        status,
      };
    });

  const problems: UserFacingProblem[] = [];
  for (const provider of snapshot.providers) {
    if (provider.status !== "cooldown") continue;
    problems.push({
      key: `provider:${provider.providerId}`,
      title: `${providerName(provider.providerId)} is temporarily unavailable`,
      detail: "The runner will retry automatically when the provider cooldown ends.",
    });
  }
  for (const agent of snapshot.agents) {
    if (agent.status !== "suspended") continue;
    problems.push({
      key: `agent:${agent.sessionId}`,
      title: "An active agent is paused",
      detail: "Open Advanced diagnostics for the recorded reason and recovery details.",
    });
  }
  for (const guidance of projection ? Object.values(projection.guidance) : []) {
    if (!guidance.blocking || guidance.status !== "open") continue;
    const objective = taskTitles.get(guidance.taskId);
    problems.push({
      key: `guidance:${guidance.requestId}`,
      title: "A decision is needed",
      detail: objective ? `${objective}: ${guidance.question}` : guidance.question,
    });
  }
  for (const task of tasks) {
    if (task.status === "integration_resolution") {
      problems.push({
        key: `conflict:${task.id}`,
        title: "Source control conflicts need resolution",
        detail: task.conflictPaths?.length
          ? `${task.objective}: ${task.conflictPaths.join(", ")}`
          : `${task.objective} cannot be applied until its conflicts are resolved.`,
      });
    } else if (task.status === "failed") {
      problems.push({
        key: `task:${task.id}`,
        title: task.objective,
        detail: "This task failed and needs a new plan before work can continue.",
      });
    } else if (task.status === "rejected") {
      problems.push({
        key: `task:${task.id}`,
        title: task.objective,
        detail: "This task needs changes before it can continue.",
      });
    }
  }
  for (const review of projection ? Object.values(projection.reviews) : []) {
    if (review.status !== "rejected" || problems.some((problem) => problem.key === `task:${review.taskId}`)) {
      continue;
    }
    problems.push({
      key: `task:${review.taskId}`,
      title: taskTitles.get(review.taskId) ?? "A completed task",
      detail: review.summary || "This task needs changes before it can continue.",
    });
  }
  if (
    projection?.status === "paused" &&
    projection.projectHandoff?.status !== "requested" &&
    problems.length === 0
  ) {
    problems.push({
      key: "run:paused",
      title: "Build is paused",
      detail: "Resume the build when you are ready to continue.",
    });
  }

  return {
    lifecycle: lifecycleLabel(projection),
    progress: {
      completed: tasks.filter((task) => COMPLETE_TASK_STATUSES.has(task.status)).length,
      total: tasks.length,
      items: tasks.map((task) => ({
        key: task.id,
        title: task.objective,
        detail: taskStatusLabel(task.status),
      })),
    },
    verification,
    problems,
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
  const view = runnerUserFacingObservability(snapshot, projection ?? null);
  return (
    <section aria-labelledby="runner-activity-title" className="overflow-hidden rounded-lg border bg-card shadow-sm">
      <div className="border-b px-4 py-4 sm:px-5">
        <div className="flex items-center gap-2.5">
          <Activity className="h-4 w-4 text-primary" />
          <div>
            <h2 id="runner-activity-title" className="text-sm font-semibold">Build activity</h2>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Follow what is finished, what was checked, and what needs your attention.
            </p>
          </div>
        </div>
      </div>

      <div className="grid gap-3 p-4 sm:p-5 xl:grid-cols-3">
        <UserSection title="Progress" icon={<CircleDot className="h-4 w-4" />} accent="progress">
          <div className="rounded-md border border-primary/20 bg-primary/5 px-3 py-2.5">
            <p className="text-[0.68rem] font-medium uppercase tracking-wide text-primary">Current status</p>
            <p className="mt-1 text-sm font-semibold leading-snug">{view.lifecycle}</p>
            <p className="mt-1 text-xs text-muted-foreground">
              {view.progress.completed} of {view.progress.total} task{view.progress.total === 1 ? "" : "s"} complete
            </p>
          </div>
          {view.progress.items.length > 0 ? (
            <ul className="mt-3 space-y-2.5">
              {view.progress.items.map((item) => (
                <li key={item.key} className="flex min-w-0 items-start gap-2.5">
                  {item.detail === "Complete" || item.detail === "No longer needed" ? (
                    <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-500" />
                  ) : (
                    <CircleDot className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  )}
                  <div className="min-w-0">
                    <p className="text-xs font-medium leading-snug">{item.title}</p>
                    <p className="mt-0.5 text-[0.7rem] text-muted-foreground">{item.detail}</p>
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-3 text-xs text-muted-foreground">Tasks will appear when the build plan is ready.</p>
          )}
        </UserSection>

        <UserSection
          title="Verification"
          icon={<ShieldCheck className="h-4 w-4" />}
          accent={
            view.verification.some((item) => item.status === "failed")
              ? "error"
              : view.verification.length > 0
                ? "success"
                : "progress"
          }
        >
          {view.verification.length > 0 ? (
            <ul className="space-y-3">
              {view.verification.map((item) => (
                <li key={item.key} className="min-w-0">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <Badge variant="secondary" className="font-normal">{item.category}</Badge>
                    <span className={`text-[0.68rem] font-medium ${verificationStatusClass(item.status)}`}>
                      {item.status === "passed" ? "Passed" : item.status === "failed" ? "Failed" : "Recorded"}
                    </span>
                  </div>
                  <p className="mt-1.5 text-xs font-medium leading-snug">{item.title}</p>
                  <p className="mt-0.5 text-[0.7rem] leading-relaxed text-muted-foreground">{item.detail}</p>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-xs leading-relaxed text-muted-foreground">
              Verification results will appear after the runner records its first check.
            </p>
          )}
        </UserSection>

        <UserSection
          title="Problems requiring attention"
          icon={view.problems.length > 0
            ? <AlertTriangle className="h-4 w-4" />
            : <CheckCircle2 className="h-4 w-4" />}
          accent={view.problems.length > 0 ? "warning" : "success"}
        >
          {view.problems.length > 0 ? (
            <ul className="space-y-3">
              {view.problems.map((problem) => (
                <li key={problem.key} className="rounded-md border border-amber-500/20 bg-amber-500/5 px-3 py-2.5">
                  <p className="text-xs font-medium leading-snug">{problem.title}</p>
                  <p className="mt-1 text-[0.7rem] leading-relaxed text-muted-foreground">{problem.detail}</p>
                </li>
              ))}
            </ul>
          ) : (
            <div className="flex items-start gap-2.5 rounded-md border border-emerald-500/20 bg-emerald-500/5 px-3 py-2.5">
              <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-500" />
              <p className="text-xs leading-relaxed">No active blockers remain.</p>
            </div>
          )}
        </UserSection>
      </div>

      <details className="border-t">
        <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-4 py-3 text-xs font-medium outline-none marker:content-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring sm:px-5">
          <span>Advanced diagnostics</span>
          <ChevronDown className="h-4 w-4 text-muted-foreground" />
        </summary>

        <div className="flex flex-wrap items-start justify-between gap-3 border-t px-4 py-3">
        <div className="flex items-center gap-2">
          <Activity className="h-4 w-4 text-muted-foreground" />
          <div>
            <h3 className="text-sm font-semibold">Diagnostic overview</h3>
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
      </details>
    </section>
  );
}

function verificationStatusClass(status: UserFacingVerificationStatus): string {
  if (status === "passed") return "text-emerald-600 dark:text-emerald-400";
  if (status === "failed") return "text-destructive";
  return "text-amber-600 dark:text-amber-400";
}

function UserSection({
  title,
  icon,
  accent,
  children,
}: {
  title: string;
  icon: React.ReactNode;
  accent: "progress" | "success" | "warning" | "error";
  children: React.ReactNode;
}) {
  const accentClass = accent === "success"
    ? "border-emerald-500/25 text-emerald-600 dark:text-emerald-400"
    : accent === "warning"
      ? "border-amber-500/30 text-amber-600 dark:text-amber-400"
      : accent === "error"
        ? "border-destructive/30 text-destructive"
        : "border-primary/25 text-primary";
  return (
    <section className={`min-w-0 rounded-lg border bg-muted/10 p-3.5 ${accentClass}`}>
      <div className="mb-3 flex items-center gap-2">
        {icon}
        <h3 className="text-xs font-semibold text-foreground">{title}</h3>
        </div>
      <div className="text-foreground">{children}</div>
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
