/**
 * Pure scheduling helpers for Build-mode tool batches. The model may request
 * several tool actions in one turn; the engine classifies them, runs safe reads
 * together, queues mutations in order (never overlapping the same path), keeps
 * risky shell commands single-step, and packs one combined, capped tool result
 * back to the model with an explicit served/skipped report.
 */

import type { ArchitectAction } from "@/lib/orchestrator/build";

export type BuildToolScheduleClass =
  | "batch_read"
  | "queued_mutation"
  | "safe_run"
  | "exclusive";

export interface ScheduledToolAction {
  action: ArchitectAction;
  label: string;
  scheduleClass: BuildToolScheduleClass;
}

export interface SkippedToolAction {
  action: ArchitectAction;
  label: string;
  reason: string;
}

export function classifyBuildToolActionForScheduling(
  action: ArchitectAction
): BuildToolScheduleClass {
  switch (action.action) {
    case "read":
    case "read_range":
    case "context_retrieve":
    case "search":
    case "repo_status":
    case "repo_diff":
    case "repo_issue_list":
    case "repo_issue_read":
      return "batch_read";
    case "patch":
    case "append":
    case "repo_branch_create":
    case "repo_commit":
    case "repo_push":
    case "repo_pr_create":
    case "repo_milestone_create":
    case "repo_issue_create":
      return "queued_mutation";
    case "run":
      return isSafeQueuedRunCommand(action.command) ? "safe_run" : "exclusive";
    default:
      return "exclusive";
  }
}

/**
 * A shell command safe to run inside a batch in full-access mode: read-only git
 * inspection, ripgrep, the project's test/build/lint/typecheck scripts, or a tsx
 * test script. Anything with shell chaining/redirection (`;`, `&`, `|`, `>`) is
 * excluded so a "safe" prefix can't smuggle a side effect.
 */
export function isSafeQueuedRunCommand(command: string): boolean {
  const trimmed = command.trim();
  return (
    (/^git\s+(?:status|diff|show|log|branch)(?:\s|$)/i.test(trimmed) ||
      /^rg(?:\s|$)/i.test(trimmed) ||
      /^npm\s+(?:test|run\s+(?:build|lint|test|typecheck))(?:\s|$)/i.test(trimmed) ||
      /^npx\s+tsx\s+scripts\/[\w.-]+\.mts(?:\s|$)/i.test(trimmed.replace(/\\/g, "/"))) &&
    !/[;&|]|\d?>|>>/.test(trimmed)
  );
}

function labelFor(action: ArchitectAction): string {
  switch (action.action) {
    case "read":
      return `read ${action.paths.join(", ")}`;
    case "read_range":
      return `read_range ${action.path}:${action.startLine}`;
    case "context_retrieve":
      return `context_retrieve ${action.ref}@${action.offsetChars ?? 0}`;
    case "search":
      return `search ${action.query}`;
    case "run":
      return `run ${action.command}`;
    case "tool":
      return `mcp:${action.server}.${action.tool}`;
    case "patch":
      return `patch ${action.path}`;
    case "append":
      return `append ${action.path}`;
    default:
      return action.action;
  }
}

export function scheduleBuildToolActions(
  actions: ArchitectAction[],
  options: { allowSafeRunQueue: boolean; maxSafeRuns: number }
): { served: ScheduledToolAction[]; skipped: SkippedToolAction[] } {
  const served: ScheduledToolAction[] = [];
  const skipped: SkippedToolAction[] = [];
  let safeRuns = 0;
  const mutationPaths = new Set<string>();

  for (const action of actions) {
    const scheduleClass = classifyBuildToolActionForScheduling(action);
    const label = labelFor(action);
    if (scheduleClass === "safe_run") {
      if (options.allowSafeRunQueue && safeRuns < options.maxSafeRuns) {
        safeRuns += 1;
        served.push({ action, label, scheduleClass });
        continue;
      }
      // Can't batch it (queue disabled, e.g. ask mode, or queue full). Fall back
      // to single-step: serve it alone so it still runs through the normal
      // (approval-gated) command path; skip it only if other actions already ran.
      if (served.length > 0) {
        skipped.push({ action, label, reason: "command must run alone — not batched here" });
        continue;
      }
      served.push({ action, label, scheduleClass: "exclusive" });
      continue;
    }
    if (scheduleClass === "queued_mutation") {
      const path =
        action.action === "patch" || action.action === "append"
          ? action.path.toLowerCase()
          : "";
      if (path && mutationPaths.has(path)) {
        skipped.push({ action, label, reason: "another mutation in this batch targets the same path" });
        continue;
      }
      if (path) mutationPaths.add(path);
      served.push({ action, label, scheduleClass });
      continue;
    }
    if (scheduleClass === "exclusive" && served.length > 0) {
      skipped.push({ action, label, reason: "exclusive action must run alone" });
      continue;
    }
    served.push({ action, label, scheduleClass });
  }

  return { served, skipped };
}

export function packToolBatchResult(input: {
  served: Array<{ label: string; result: string }>;
  skipped: Array<{ label: string; reason: string }>;
  maxChars: number;
}): string {
  const lines: string[] = ["TOOL BATCH RESULT", ""];
  lines.push("Served:");
  lines.push(...(input.served.length ? input.served.map((item) => `- ${item.label}`) : ["- none"]));
  lines.push("", "Skipped:");
  lines.push(...(input.skipped.length ? input.skipped.map((item) => `- ${item.label}: ${item.reason}`) : ["- none"]));
  lines.push("", "Results:");
  let remaining = input.maxChars - lines.join("\n").length;
  for (const item of input.served) {
    if (remaining <= 0) {
      lines.push(`\n--- ${item.label} ---\n[omitted: output cap reached]`);
      continue;
    }
    const header = `\n--- ${item.label} ---\n`;
    const slice = item.result.slice(0, Math.max(0, remaining - header.length));
    const suffix = slice.length < item.result.length ? "\n[truncated: output cap reached]" : "";
    lines.push(`${header}${slice}${suffix}`);
    remaining -= header.length + slice.length + suffix.length;
  }
  return lines.join("\n");
}
