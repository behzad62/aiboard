"use client";

import type { OrchestratorEvent } from "@/lib/orchestrator/engine";
import { classifyRepoBranchSafety } from "@/lib/client/repo-runner";
import { Badge } from "@/components/ui/badge";
import {
  GitBranch,
  GitCommitHorizontal,
  GitPullRequestArrow,
  FileDiff,
  Cloud,
  CircleDot,
  CheckCircle2,
  AlertTriangle,
} from "lucide-react";

/**
 * UI views derived from the event union so they can't drift from the engine's
 * `repo_status` / `repo_diff` payloads (lib/orchestrator/engine.ts). The status
 * shape intentionally has NO `root` / absolute path and NO `gitAvailable` — the
 * engine omits those.
 */
export type RepoStatusView = Extract<
  OrchestratorEvent,
  { type: "repo_status" }
>["status"];

export type RepoDiffView = Extract<
  OrchestratorEvent,
  { type: "repo_diff" }
>["diff"];

function CountChip({
  label,
  count,
  variant,
}: {
  label: string;
  count: number;
  variant: "secondary" | "warning" | "success" | "destructive";
}) {
  return (
    <Badge variant={count > 0 ? variant : "secondary"} className="gap-1">
      <span className="font-mono tabular-nums">{count}</span>
      {label}
    </Badge>
  );
}

export function RepoWorkflowPanel({
  status,
  diff,
}: {
  status: RepoStatusView | null;
  diff: RepoDiffView | null;
}) {
  // Nothing captured yet (no runner, old runner, or fetch failed): render
  // nothing rather than an empty shell.
  if (!status) return null;

  // The runner folder exists but is not a Git repository.
  if (!status.isRepo) {
    return (
      <section className="rounded-2xl border bg-card p-5 shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="flex items-center gap-2 font-display text-lg font-semibold">
            <GitBranch className="h-5 w-5 text-primary" />
            Repository
          </h2>
        </div>
        <p className="mt-3 flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-100">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            The runner folder is not a Git repository — native repo workflow
            (branch, diff, commit) is unavailable for this folder.
          </span>
        </p>
      </section>
    );
  }

  const dirtyCount =
    status.staged.length +
    status.unstaged.length +
    status.untracked.length +
    status.conflicted.length;

  // Recompute the branch-safety decision from the status the panel already has
  // (no new event / engine plumbing needed). Surfaces WHY commit/PR-capable
  // repo workflow is paused: on the default/main/master branch with no feature
  // branch, or when conflicts make repo workflow unsafe.
  const safety = classifyRepoBranchSafety({
    isRepo: status.isRepo,
    currentBranch: status.currentBranch,
    defaultBranch: status.defaultBranch,
    clean: status.clean,
    conflicted: status.conflicted,
  });

  return (
    <section className="rounded-2xl border bg-card p-5 shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="flex items-center gap-2 font-display text-lg font-semibold">
          <GitBranch className="h-5 w-5 text-primary" />
          Repository
        </h2>
        <Badge variant={status.clean ? "success" : "warning"} className="gap-1">
          {status.clean ? (
            <CheckCircle2 className="h-3.5 w-3.5" />
          ) : (
            <CircleDot className="h-3.5 w-3.5" />
          )}
          {status.clean ? "Clean" : `${dirtyCount} change${dirtyCount === 1 ? "" : "s"}`}
        </Badge>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-2 text-sm">
        <Badge variant="outline" className="gap-1">
          <GitBranch className="h-3.5 w-3.5" />
          <span className="font-mono">{status.currentBranch ?? "(detached)"}</span>
        </Badge>
        {status.defaultBranch && (
          <span className="text-xs text-muted-foreground">
            default <span className="font-mono">{status.defaultBranch}</span>
          </span>
        )}
        {status.upstream && (
          <Badge variant="secondary" className="gap-1">
            <GitPullRequestArrow className="h-3.5 w-3.5" />
            <span className="font-mono">{status.upstream}</span>
          </Badge>
        )}
        {(status.ahead > 0 || status.behind > 0) && (
          <span className="font-mono text-xs text-muted-foreground">
            {status.ahead > 0 && `↑${status.ahead}`}
            {status.ahead > 0 && status.behind > 0 && " "}
            {status.behind > 0 && `↓${status.behind}`}
          </span>
        )}
      </div>

      {safety.needsBranch && (
        <p className="mt-3 flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-100">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            Commit &amp; PR workflow paused — create a feature branch first
            (you&apos;re on{" "}
            <span className="font-mono">
              {status.currentBranch ?? "(detached)"}
            </span>
            ).
          </span>
        </p>
      )}

      {!safety.safe && !safety.needsBranch && status.conflicted.length > 0 && (
        <p className="mt-3 flex items-start gap-2 rounded-md border border-red-300 bg-red-50 px-3 py-2 text-xs text-red-900 dark:border-red-900 dark:bg-red-950/30 dark:text-red-100">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            Commit &amp; PR workflow unavailable — {status.conflicted.length}{" "}
            conflicted file
            {status.conflicted.length === 1 ? "" : "s"} must be resolved first.
          </span>
        </p>
      )}

      {status.remotes.length > 0 && (
        <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <Cloud className="h-3.5 w-3.5" />
          {status.remotes.map((r) => (
            <span key={r.name} className="font-mono">
              {r.name}
            </span>
          ))}
        </div>
      )}

      <div className="mt-4 flex flex-wrap gap-2">
        <CountChip label="staged" count={status.staged.length} variant="success" />
        <CountChip label="unstaged" count={status.unstaged.length} variant="warning" />
        <CountChip label="untracked" count={status.untracked.length} variant="secondary" />
        <CountChip label="conflicted" count={status.conflicted.length} variant="destructive" />
      </div>

      {status.recentCommits.length > 0 && (
        <div className="mt-4">
          <p className="mb-2 flex items-center gap-1.5 text-sm font-medium">
            <GitCommitHorizontal className="h-4 w-4 text-primary" />
            Recent commits
          </p>
          <ul className="space-y-1">
            {status.recentCommits.map((c) => (
              <li
                key={c.hash}
                className="flex items-center gap-2 rounded border bg-muted/20 px-2 py-1 text-xs"
              >
                <span className="shrink-0 font-mono text-muted-foreground">
                  {c.hash.slice(0, 7)}
                </span>
                <span className="truncate">{c.subject}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {diff && (diff.summary || diff.files.length > 0) && (
        <div className="mt-4">
          <p className="mb-2 flex items-center gap-1.5 text-sm font-medium">
            <FileDiff className="h-4 w-4 text-primary" />
            Latest changes
            {diff.truncated && (
              <span className="text-xs font-normal text-muted-foreground">
                (truncated)
              </span>
            )}
          </p>
          {diff.summary && (
            <pre className="max-h-32 overflow-auto whitespace-pre-wrap rounded border bg-muted/20 p-2 text-[0.7rem] text-muted-foreground">
              {diff.summary}
            </pre>
          )}
          {diff.files.length > 0 && (
            <ul className="mt-1 grid gap-1 sm:grid-cols-2">
              {diff.files.map((f) => (
                <li
                  key={f}
                  className="truncate rounded border bg-muted/20 px-2 py-1 font-mono text-xs"
                >
                  {f}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}
