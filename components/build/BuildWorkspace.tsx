"use client";

import {
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import Link from "next/link";
import {
  Activity,
  ArrowLeft,
  FileCode2,
  LayoutDashboard,
  ListTodo,
  PanelRight,
  Settings2,
  X,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { BuildTaskCriterionView, BuildTaskView } from "@/components/BuildTaskBoard";

export interface WorkspaceTask {
  id: string;
  title: string;
  status: BuildTaskView["status"];
  worker?: string;
  kind?: BuildTaskView["kind"];
  dependencies: string[];
  attempt?: number;
  failureReason?: string;
  conflictPaths?: string[];
  changeSetId?: string;
  integrationRevision?: string;
  criteria: BuildTaskCriterionView[];
}

export type BuildView =
  | { kind: "overview" }
  | { kind: "tasks" }
  | { kind: "task"; taskId: string }
  | { kind: "files" }
  | { kind: "transcript" }
  | { kind: "activity" }
  | { kind: "settings" };

export interface WorkspaceCrew {
  architect?: string;
  workers: string[];
  verifiers: string[];
}

export interface WorkspaceDecision {
  id: string;
  node: ReactNode;
}

const TASK_STATUS: Record<
  BuildTaskView["status"],
  { word: string; dot: string; tone: string }
> = {
  planned: {
    word: "Queued",
    dot: "border-2 border-muted-foreground/50",
    tone: "text-muted-foreground",
  },
  in_progress: {
    word: "Building",
    dot: "bg-primary motion-safe:animate-pulse",
    tone: "text-primary",
  },
  review: { word: "In review", dot: "bg-warning", tone: "text-warning" },
  fixing: { word: "Fixing", dot: "bg-warning", tone: "text-warning" },
  done: { word: "Done", dot: "bg-success", tone: "text-success" },
  failed: { word: "Failed", dot: "bg-destructive", tone: "text-destructive" },
};

export function taskStatusWord(status: BuildTaskView["status"]): string {
  return TASK_STATUS[status].word;
}

function needsAttention(task: WorkspaceTask): boolean {
  return task.status === "failed" || task.status === "fixing" || task.status === "review";
}

/** Role glyphs shared with the home composer: ◆ architect, ● worker, ◯ verifier. */
export function RoleGlyph({ role }: { role: "architect" | "worker" | "verifier" }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "inline-block h-2.5 w-2.5 shrink-0",
        role === "architect" && "rotate-45 rounded-[2px] bg-primary",
        role === "worker" && "rounded-full bg-foreground/70",
        role === "verifier" && "rounded-full border-2 border-success"
      )}
    />
  );
}

export function DecisionCard({
  title,
  tone = "warn",
  children,
  actions,
}: {
  title: string;
  tone?: "warn" | "danger" | "info" | "success";
  children?: ReactNode;
  actions?: ReactNode;
}) {
  const headingId = useId();
  return (
    <section
      aria-labelledby={headingId}
      className={cn(
        "glass-strong rounded-2xl border p-4",
        tone === "warn" && "border-warning/50",
        tone === "danger" && "border-destructive/50",
        tone === "info" && "border-primary/40",
        tone === "success" && "border-success/50"
      )}
    >
      <h3 id={headingId} className="text-sm font-semibold">
        {title}
      </h3>
      {children && (
        <div className="mt-1 space-y-1 text-sm text-muted-foreground">{children}</div>
      )}
      {actions && <div className="mt-3 flex flex-wrap gap-2">{actions}</div>}
    </section>
  );
}

export function BuildWorkspace({
  topic,
  statusPill,
  crew,
  runnerChip,
  actions,
  notifications,
  live,
  banner,
  tasks,
  view,
  onViewChange,
  overview,
  files,
  transcript,
  activity,
  settings,
  fileCount,
  decisions,
  composer,
  details,
}: {
  topic: string;
  statusPill: ReactNode;
  crew: WorkspaceCrew;
  runnerChip: ReactNode;
  actions: ReactNode;
  notifications?: ReactNode;
  live?: string | null;
  banner?: ReactNode;
  tasks: WorkspaceTask[];
  view: BuildView;
  onViewChange: (view: BuildView) => void;
  overview: ReactNode;
  files: ReactNode;
  transcript: ReactNode;
  activity: ReactNode;
  settings: ReactNode;
  fileCount?: number;
  decisions: WorkspaceDecision[];
  composer: ReactNode;
  details: ReactNode;
}) {
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [attentionOnly, setAttentionOnly] = useState(false);
  const detailsButtonRef = useRef<HTMLButtonElement>(null);
  const wide = useMediaQuery("(min-width: 1280px)");

  const implementation = tasks.filter((task) => task.kind !== "final_verification");
  const doneCount = implementation.filter((task) => task.status === "done").length;
  const attentionCount = tasks.filter(needsAttention).length;
  const visibleTasks = attentionOnly ? tasks.filter(needsAttention) : tasks;
  const selectedTask =
    view.kind === "task" ? tasks.find((task) => task.id === view.taskId) : undefined;

  const closeDetails = () => {
    setDetailsOpen(false);
    detailsButtonRef.current?.focus();
  };

  const navItems: Array<{
    view: BuildView;
    label: string;
    icon: typeof LayoutDashboard;
    count?: number;
    mobileOnly?: boolean;
  }> = [
    { view: { kind: "overview" }, label: "Overview", icon: LayoutDashboard },
    {
      view: { kind: "tasks" },
      label: "Tasks",
      icon: ListTodo,
      count: implementation.length,
      mobileOnly: true,
    },
    { view: { kind: "files" }, label: "Files", icon: FileCode2, count: fileCount },
    { view: { kind: "activity" }, label: "Activity", icon: Activity },
    { view: { kind: "settings" }, label: "Session settings", icon: Settings2 },
  ];

  const taskList = (
    <TaskList
      tasks={visibleTasks}
      selectedId={selectedTask?.id}
      onSelect={(taskId) => onViewChange({ kind: "task", taskId })}
      empty={
        attentionOnly
          ? "Nothing needs attention."
          : "No tasks yet. The architect plans them first."
      }
    />
  );

  const main = (() => {
    switch (view.kind) {
      case "task":
        return selectedTask ? (
          <TaskDetail
            task={selectedTask}
            tasks={tasks}
            onSelect={(taskId) => onViewChange({ kind: "task", taskId })}
          />
        ) : (
          <p className="text-sm text-muted-foreground">That task is no longer in the plan.</p>
        );
      case "tasks":
        return (
          <section aria-labelledby="tasks-view-title" className="space-y-3">
            <TaskListHeading
              id="tasks-view-title"
              doneCount={doneCount}
              total={implementation.length}
              attentionCount={attentionCount}
              attentionOnly={attentionOnly}
              onToggle={() => setAttentionOnly((current) => !current)}
            />
            {taskList}
          </section>
        );
      case "files":
        return files;
      case "transcript":
        return transcript;
      case "activity":
        return activity;
      case "settings":
        return settings;
      default:
        return overview;
    }
  })();

  return (
    <div className="-mx-4 -my-8 sm:-mx-6">
      <div
        className={cn(
          "grid min-h-[calc(100dvh-3.5rem)] lg:grid-cols-[272px_minmax(0,1fr)]",
          detailsOpen && wide && "xl:grid-cols-[272px_minmax(0,1fr)_360px]"
        )}
      >
        <aside
          aria-label="Build navigation"
          className="glass-bar sticky top-14 hidden h-[calc(100dvh-3.5rem)] overflow-y-auto border-r px-3 py-5 lg:block"
        >
          <Link
            href="/"
            className="mb-4 inline-flex items-center gap-1.5 px-2 text-sm text-muted-foreground hover:text-foreground"
          >
            <ArrowLeft className="h-4 w-4" aria-hidden="true" />
            Workspace
          </Link>
          <NavList
            items={navItems.filter((item) => !item.mobileOnly)}
            view={view}
            onViewChange={onViewChange}
          />
          <div className="mt-6 space-y-2">
            <TaskListHeading
              id="sidebar-tasks-title"
              doneCount={doneCount}
              total={implementation.length}
              attentionCount={attentionCount}
              attentionOnly={attentionOnly}
              onToggle={() => setAttentionOnly((current) => !current)}
            />
            {taskList}
          </div>
        </aside>

        <div className="flex min-w-0 flex-col">
          <div className="flex-1 space-y-5 px-4 pb-6 pt-6 sm:px-8">
            <header className="space-y-3">
              <Link
                href="/"
                className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground lg:hidden"
              >
                <ArrowLeft className="h-4 w-4" aria-hidden="true" />
                Workspace
              </Link>
              <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between md:gap-4">
                <h1
                  className="line-clamp-2 min-w-0 max-w-4xl font-display text-xl font-semibold leading-tight tracking-tight sm:text-2xl xl:text-[1.75rem]"
                  title={topic}
                >
                  {topic}
                </h1>
                <div className="flex shrink-0 flex-wrap items-center gap-2 md:justify-end">
                  {notifications}
                  {actions}
                  <button
                    ref={detailsButtonRef}
                    type="button"
                    aria-expanded={detailsOpen}
                    aria-controls="run-details"
                    onClick={() => (detailsOpen ? closeDetails() : setDetailsOpen(true))}
                    className={cn(
                      "inline-flex h-9 items-center gap-2 rounded-md border px-3 text-sm font-medium transition-colors hover:bg-accent",
                      detailsOpen && "bg-accent text-accent-foreground"
                    )}
                  >
                    <PanelRight className="h-4 w-4" aria-hidden="true" />
                    <span className="sr-only sm:not-sr-only">Run details</span>
                  </button>
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
                {statusPill}
                <CrewLine crew={crew} />
                {runnerChip}
              </div>
              {implementation.length > 0 && (
                <div className="flex max-w-xl items-center gap-3">
                  <div
                    className="h-1.5 flex-1 overflow-hidden rounded-full bg-foreground/10"
                    role="progressbar"
                    aria-label="Tasks done"
                    aria-valuemin={0}
                    aria-valuemax={implementation.length}
                    aria-valuenow={doneCount}
                  >
                    <div
                      className="h-full rounded-full bg-success transition-[width] duration-500"
                      style={{ width: `${(doneCount / implementation.length) * 100}%` }}
                    />
                  </div>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {doneCount} of {implementation.length} tasks done
                  </span>
                </div>
              )}
              {live && (
                <p className="flex min-w-0 items-center gap-2 text-sm text-muted-foreground" aria-live="polite">
                  <span className="relative flex h-2 w-2 shrink-0" aria-hidden="true">
                    <span className="absolute inline-flex h-full w-full rounded-full bg-primary/60 motion-safe:animate-ping" />
                    <span className="relative inline-flex h-2 w-2 rounded-full bg-primary" />
                  </span>
                  <span className="truncate">{live}</span>
                </p>
              )}
            </header>

            <nav
              aria-label="Build views"
              className="-mx-4 flex gap-1 overflow-x-auto px-4 pb-1 [scrollbar-width:none] lg:hidden"
            >
              {navItems.map((item) => (
                <NavButton key={item.label} item={item} view={view} onViewChange={onViewChange} compact />
              ))}
            </nav>

            {banner}
            <div className="min-w-0">{main}</div>
          </div>

          <div className="sticky bottom-0 z-20 px-4 pb-4 sm:px-8">
            <div
              aria-hidden="true"
              className="pointer-events-none absolute inset-x-0 -top-10 bottom-0 bg-gradient-to-b from-transparent via-background/85 to-background backdrop-blur-md [mask-image:linear-gradient(to_bottom,transparent,#000_40px)]"
            />
            <div className="relative space-y-3">
              {decisions.length > 0 && (
                <section aria-labelledby="needs-you-title" aria-live="polite" className="space-y-2">
                  <h2
                    id="needs-you-title"
                    className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.14em] text-warning"
                  >
                    <span className="h-1.5 w-1.5 rounded-full bg-warning" aria-hidden="true" />
                    Needs you · {decisions.length}
                  </h2>
                  <div className="max-h-[45vh] space-y-2 overflow-y-auto">
                    {decisions.map((decision) => (
                      <div key={decision.id}>{decision.node}</div>
                    ))}
                  </div>
                </section>
              )}
              {composer}
            </div>
          </div>
        </div>

        {detailsOpen && wide && (
          <aside
            id="run-details"
            aria-labelledby="run-details-title"
            className="glass-bar sticky top-14 h-[calc(100dvh-3.5rem)] overflow-y-auto border-l px-5 py-5"
            onKeyDown={(event) => {
              if (event.key === "Escape") closeDetails();
            }}
          >
            <DetailsHeader onClose={closeDetails} />
            <div className="mt-4 space-y-5">{details}</div>
          </aside>
        )}
      </div>

      {detailsOpen && !wide && (
        <DetailsSheet onClose={closeDetails}>{details}</DetailsSheet>
      )}
    </div>
  );
}

function DetailsHeader({ onClose, autoFocus = true }: { onClose: () => void; autoFocus?: boolean }) {
  const headingRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (autoFocus) headingRef.current?.focus();
  }, [autoFocus]);
  return (
    <div className="flex items-center justify-between gap-3">
      <h2
        id="run-details-title"
        ref={headingRef}
        tabIndex={-1}
        className="text-base font-semibold outline-none"
      >
        Run details
      </h2>
      <button
        type="button"
        onClick={onClose}
        aria-label="Close run details"
        className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
      >
        <X className="h-4 w-4" aria-hidden="true" />
      </button>
    </div>
  );
}

function DetailsSheet({ onClose, children }: { onClose: () => void; children: ReactNode }) {
  const panelRef = useRef<HTMLDivElement>(null);
  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key !== "Tab" || !panelRef.current) return;
    const focusable = Array.from(
      panelRef.current.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"])'
      )
    );
    if (focusable.length === 0) return;
    const first = focusable[0]!;
    const last = focusable[focusable.length - 1]!;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };
  return (
    <div className="fixed inset-0 z-50">
      <div
        aria-hidden="true"
        className="absolute inset-0 bg-[#0613296b] backdrop-blur-[3px]"
        onClick={onClose}
      />
      <div
        ref={panelRef}
        id="run-details"
        role="dialog"
        aria-modal="true"
        aria-labelledby="run-details-title"
        onKeyDown={onKeyDown}
        className="glass-strong absolute inset-y-0 right-0 w-full max-w-md overflow-y-auto border-l px-5 py-5"
      >
        <DetailsHeader onClose={onClose} />
        <div className="mt-4 space-y-5">{children}</div>
      </div>
    </div>
  );
}

function CrewLine({ crew }: { crew: WorkspaceCrew }) {
  return (
    <span className="flex flex-wrap items-center gap-x-3 gap-y-1 text-muted-foreground">
      {crew.architect && (
        <span className="inline-flex items-center gap-1.5">
          <RoleGlyph role="architect" />
          <span className="sr-only">Architect:</span>
          <span className="text-foreground">{crew.architect}</span>
        </span>
      )}
      {crew.workers.length > 0 && (
        <span className="inline-flex items-center gap-1.5">
          <RoleGlyph role="worker" />
          <span className="sr-only">Workers:</span>
          <span className="text-foreground">{crew.workers.join(", ")}</span>
        </span>
      )}
      {crew.verifiers.length > 0 && (
        <span className="inline-flex items-center gap-1.5">
          <RoleGlyph role="verifier" />
          <span className="sr-only">Verifier:</span>
          <span className="text-foreground">{crew.verifiers.join(", ")}</span>
        </span>
      )}
    </span>
  );
}

function NavList({
  items,
  view,
  onViewChange,
}: {
  items: Array<{ view: BuildView; label: string; icon: typeof LayoutDashboard; count?: number }>;
  view: BuildView;
  onViewChange: (view: BuildView) => void;
}) {
  return (
    <ul className="space-y-0.5">
      {items.map((item) => (
        <li key={item.label}>
          <NavButton item={item} view={view} onViewChange={onViewChange} />
        </li>
      ))}
    </ul>
  );
}

function NavButton({
  item,
  view,
  onViewChange,
  compact = false,
}: {
  item: { view: BuildView; label: string; icon: typeof LayoutDashboard; count?: number };
  view: BuildView;
  onViewChange: (view: BuildView) => void;
  compact?: boolean;
}) {
  const active = item.view.kind === view.kind;
  const Icon = item.icon;
  return (
    <button
      type="button"
      aria-current={active ? "page" : undefined}
      onClick={() => onViewChange(item.view)}
      className={cn(
        "flex items-center gap-2 rounded-lg text-sm transition-colors hover:bg-accent hover:text-accent-foreground",
        compact ? "shrink-0 px-3 py-1.5" : "w-full px-2 py-1.5",
        active ? "bg-accent font-medium text-accent-foreground" : "text-muted-foreground"
      )}
    >
      <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />
      <span className="truncate">{item.label}</span>
      {item.count !== undefined && item.count > 0 && (
        <span className={cn("text-xs tabular-nums text-muted-foreground", !compact && "ml-auto")}>
          {item.count}
        </span>
      )}
    </button>
  );
}

function TaskListHeading({
  id,
  doneCount,
  total,
  attentionCount,
  attentionOnly,
  onToggle,
}: {
  id: string;
  doneCount: number;
  total: number;
  attentionCount: number;
  attentionOnly: boolean;
  onToggle: () => void;
}) {
  return (
    <div className="flex items-center justify-between gap-2 px-2">
      <h2 id={id} className="text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">
        Tasks {total > 0 && <span className="normal-case tracking-normal">· {doneCount}/{total}</span>}
      </h2>
      {attentionCount > 0 && (
        <button
          type="button"
          aria-pressed={attentionOnly}
          onClick={onToggle}
          className={cn(
            "rounded-full border px-2 py-0.5 text-xs transition-colors",
            attentionOnly
              ? "border-warning/60 bg-warning-soft text-warning"
              : "text-muted-foreground hover:bg-accent"
          )}
        >
          {attentionCount} need attention
        </button>
      )}
    </div>
  );
}

function TaskList({
  tasks,
  selectedId,
  onSelect,
  empty,
}: {
  tasks: WorkspaceTask[];
  selectedId?: string;
  onSelect: (taskId: string) => void;
  empty: string;
}) {
  if (tasks.length === 0) {
    return <p className="px-2 text-sm text-muted-foreground">{empty}</p>;
  }
  return (
    <ul className="space-y-0.5">
      {tasks.map((task) => {
        const meta = TASK_STATUS[task.status];
        const selected = task.id === selectedId;
        return (
          <li key={task.id}>
            <button
              type="button"
              aria-current={selected ? "true" : undefined}
              onClick={() => onSelect(task.id)}
              className={cn(
                "flex w-full items-start gap-2.5 rounded-lg px-2 py-2 text-left transition-colors hover:bg-accent",
                selected && "bg-accent"
              )}
            >
              <span className={cn("mt-1.5 h-2 w-2 shrink-0 rounded-full", meta.dot)} aria-hidden="true" />
              <span className="min-w-0 flex-1">
                <span className="line-clamp-2 text-sm leading-snug text-foreground">{task.title}</span>
                <span className="mt-0.5 block truncate text-xs text-muted-foreground">
                  <span className={meta.tone}>{meta.word}</span>
                  {task.kind === "final_verification" && " · Final verification"}
                  {task.kind === "verification_repair" && " · Repair"}
                  {task.worker && ` · ${task.worker}`}
                </span>
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

function TaskDetail({
  task,
  tasks,
  onSelect,
}: {
  task: WorkspaceTask;
  tasks: WorkspaceTask[];
  onSelect: (taskId: string) => void;
}) {
  const meta = TASK_STATUS[task.status];
  const satisfied = task.criteria.filter((criterion) => criterion.verdict?.verdict === "satisfied").length;
  return (
    <article aria-labelledby="task-detail-title" className="space-y-5">
      <header className="space-y-2">
        <p className="font-mono text-xs text-muted-foreground">
          {task.id}
          {task.kind === "final_verification" && " · final verification"}
          {task.kind === "verification_repair" && " · verification repair"}
        </p>
        <h2 id="task-detail-title" className="font-display text-2xl font-semibold tracking-tight">
          {task.title}
        </h2>
        <dl className="flex flex-wrap gap-x-6 gap-y-1 text-sm">
          <div className="flex gap-1.5">
            <dt className="text-muted-foreground">Status</dt>
            <dd className={cn("font-medium", meta.tone)}>{meta.word}</dd>
          </div>
          {task.worker && (
            <div className="flex gap-1.5">
              <dt className="text-muted-foreground">Worker</dt>
              <dd>{task.worker}</dd>
            </div>
          )}
          {task.attempt !== undefined && task.attempt > 1 && (
            <div className="flex gap-1.5">
              <dt className="text-muted-foreground">Attempt</dt>
              <dd>{task.attempt}</dd>
            </div>
          )}
        </dl>
      </header>

      {task.failureReason && (
        <p role="status" className="rounded-xl border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm">
          {task.failureReason}
        </p>
      )}
      {task.conflictPaths && task.conflictPaths.length > 0 && (
        <div className="rounded-xl border border-warning/40 bg-warning-soft px-4 py-3 text-sm">
          <p className="font-medium text-warning">Integration conflict</p>
          <ul className="mt-1 list-disc pl-5 font-mono text-xs">
            {task.conflictPaths.map((path) => (
              <li key={path}>{path}</li>
            ))}
          </ul>
        </div>
      )}

      <section aria-labelledby="task-criteria-title" className="glass rounded-2xl border p-5">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h3 id="task-criteria-title" className="text-sm font-semibold">
            Acceptance criteria
          </h3>
          {task.criteria.length > 0 && (
            <span className="text-xs text-muted-foreground">
              {satisfied} of {task.criteria.length} accepted by the verifier
            </span>
          )}
        </div>
        {task.criteria.length === 0 ? (
          <p className="mt-2 text-sm text-muted-foreground">No acceptance criteria were recorded for this task.</p>
        ) : (
          <ol className="mt-3 space-y-3">
            {task.criteria.map((criterion) => (
              <li key={criterion.id} className="rounded-xl border bg-background/40 px-4 py-3">
                <p className="text-sm">
                  <span className="mr-2 font-mono text-xs text-muted-foreground">{criterion.id}</span>
                  {criterion.text}
                </p>
                <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs">
                  <span className={criterion.evidence ? "text-foreground" : "text-muted-foreground"}>
                    {criterion.evidence
                      ? `Evidence ${criterion.evidence.evidenceId.slice(0, 12)}`
                      : "No evidence yet"}
                  </span>
                  <span
                    className={
                      criterion.verdict?.verdict === "satisfied"
                        ? "font-medium text-success"
                        : criterion.verdict?.verdict === "unsatisfied"
                          ? "font-medium text-destructive"
                          : "text-muted-foreground"
                    }
                  >
                    {criterion.verdict?.verdict === "satisfied"
                      ? "Accepted"
                      : criterion.verdict?.verdict === "unsatisfied"
                        ? "Rejected"
                        : "Not reviewed"}
                  </span>
                </div>
                {criterion.verdict?.rationale && (
                  <p className="mt-2 border-l-2 pl-3 text-xs text-muted-foreground">
                    {criterion.verdict.rationale}
                  </p>
                )}
              </li>
            ))}
          </ol>
        )}
      </section>

      {task.dependencies.length > 0 && (
        <section aria-labelledby="task-deps-title" className="space-y-2">
          <h3 id="task-deps-title" className="text-sm font-semibold">
            Depends on
          </h3>
          <ul className="flex flex-wrap gap-2">
            {task.dependencies.map((dependencyId) => {
              const dependency = tasks.find((candidate) => candidate.id === dependencyId);
              return (
                <li key={dependencyId}>
                  <button
                    type="button"
                    onClick={() => onSelect(dependencyId)}
                    className="inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs hover:bg-accent"
                  >
                    <span
                      className={cn(
                        "h-1.5 w-1.5 rounded-full",
                        dependency ? TASK_STATUS[dependency.status].dot : "bg-muted-foreground"
                      )}
                      aria-hidden="true"
                    />
                    {dependency?.title ?? dependencyId}
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      )}

      {(task.changeSetId || task.integrationRevision) && (
        <dl className="grid gap-1 text-xs text-muted-foreground sm:grid-cols-[auto_1fr] sm:gap-x-4">
          {task.changeSetId && (
            <>
              <dt>Change set</dt>
              <dd className="font-mono">{task.changeSetId}</dd>
            </>
          )}
          {task.integrationRevision && (
            <>
              <dt>Integrated at</dt>
              <dd className="font-mono">{task.integrationRevision.slice(0, 12)}</dd>
            </>
          )}
        </dl>
      )}
    </article>
  );
}

function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(false);
  useEffect(() => {
    const media = window.matchMedia(query);
    const update = () => setMatches(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, [query]);
  return matches;
}
