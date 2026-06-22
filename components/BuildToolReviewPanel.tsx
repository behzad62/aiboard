"use client";

import { useMemo, useState } from "react";
import { Check, ClipboardCopy, Wrench } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { BuildToolReviewReport } from "@/lib/db/schema";
import { formatBuildToolReviewMarkdown } from "@/lib/orchestrator/build-tool-review-report";

interface BuildToolReviewPanelProps {
  report: BuildToolReviewReport;
}

function compact(text: string, max = 520): string {
  return text.length <= max ? text : `${text.slice(0, max).trimEnd()}...`;
}

function formatTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

export function BuildToolReviewPanel({ report }: BuildToolReviewPanelProps) {
  const [copied, setCopied] = useState(false);
  const markdown = useMemo(() => formatBuildToolReviewMarkdown(report), [report]);

  const copyReport = async () => {
    await navigator.clipboard.writeText(markdown);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  };

  return (
    <section className="rounded-lg border border-sky-300 bg-sky-50/80 text-sky-950 shadow-sm dark:border-sky-900 dark:bg-sky-950/25 dark:text-sky-50">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-sky-200 px-4 py-3 dark:border-sky-900">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <Wrench className="h-4 w-4 shrink-0" />
            <h2 className="text-sm font-semibold">Tool call review</h2>
            <Badge variant={report.errorCount > 0 ? "destructive" : "warning"}>
              {report.totalProblems} issue{report.totalProblems === 1 ? "" : "s"}
            </Badge>
            <span className="font-mono text-xs opacity-75">
              wave {report.wave} - {report.status}
            </span>
          </div>
          <p className="mt-1 text-sm">{report.summary}</p>
          <p className="mt-1 text-xs opacity-80">{formatTime(report.createdAt)}</p>
        </div>
        <Button size="sm" variant="outline" onClick={copyReport} className="shrink-0">
          {copied ? (
            <Check className="mr-2 h-4 w-4" />
          ) : (
            <ClipboardCopy className="mr-2 h-4 w-4" />
          )}
          {copied ? "Copied" : "Copy review"}
        </Button>
      </div>

      <div className="grid gap-px bg-sky-200/70 dark:bg-sky-900/70 lg:grid-cols-[1fr_1fr]">
        <div className="bg-sky-50/90 p-4 dark:bg-[#06131b]">
          <p className="text-xs font-semibold uppercase tracking-wide opacity-70">
            Problem groups
          </p>
          <ol className="mt-2 space-y-2">
            {report.groups.slice(0, 6).map((group) => (
              <li
                key={group.key}
                className="rounded-md border border-sky-200 bg-background/70 px-3 py-2 text-sm dark:border-sky-900"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant={group.severity === "warning" ? "warning" : "destructive"}>
                    {group.code}
                  </Badge>
                  <span className="font-mono text-xs opacity-75">x{group.count}</span>
                  <span className="text-xs opacity-75">{group.source}</span>
                </div>
                <p className="mt-1 text-sm">{group.actor}</p>
                <p className="mt-1 text-xs opacity-80">{compact(group.latestMessage, 260)}</p>
              </li>
            ))}
          </ol>
        </div>

        <div className="bg-sky-50/90 p-4 dark:bg-[#06131b]">
          <p className="text-xs font-semibold uppercase tracking-wide opacity-70">
            Recent examples
          </p>
          <ol className="mt-2 space-y-2">
            {report.problems.slice(0, 5).map((problem) => (
              <li
                key={problem.id}
                className="rounded-md border border-sky-200 bg-background/70 px-3 py-2 text-sm dark:border-sky-900"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-mono text-xs opacity-75">{problem.code}</span>
                  <span className="text-xs opacity-75">{problem.source}</span>
                  {problem.modelName && (
                    <span className="text-xs opacity-75">
                      {problem.modelName}
                      {problem.providerId ? ` / ${problem.providerId}` : ""}
                    </span>
                  )}
                  {problem.taskId && (
                    <span className="font-mono text-xs opacity-75">{problem.taskId}</span>
                  )}
                </div>
                <p className="mt-1">{problem.message}</p>
                {problem.details && (
                  <pre className="mt-2 max-h-28 overflow-auto whitespace-pre-wrap rounded border border-sky-200 bg-background/70 p-2 font-mono text-[0.7rem] text-muted-foreground dark:border-sky-900">
                    {compact(problem.details, 700)}
                  </pre>
                )}
              </li>
            ))}
          </ol>
        </div>
      </div>

      {report.commandProblems.length > 0 && (
        <div className="border-t border-sky-200 bg-sky-50/70 px-4 py-3 dark:border-sky-900 dark:bg-transparent">
          <p className="mb-2 text-sm font-medium">Failed commands and MCP calls</p>
          <ol className="space-y-2">
            {report.commandProblems.slice(0, 4).map((command) => (
              <li
                key={`${command.createdAt}:${command.command}`}
                className="rounded-md border border-sky-200 bg-background/70 p-2 dark:border-sky-900"
              >
                <div className="flex flex-wrap items-center justify-between gap-2 font-mono text-xs">
                  <span className="break-all">$ {command.command}</span>
                  <Badge variant="destructive">
                    exit {command.exitCode} - {(command.durationMs / 1000).toFixed(1)}s
                  </Badge>
                </div>
                {command.outputPreview && (
                  <pre className="mt-2 max-h-32 overflow-auto whitespace-pre-wrap font-mono text-[0.7rem] text-muted-foreground">
                    {command.outputPreview}
                  </pre>
                )}
              </li>
            ))}
          </ol>
        </div>
      )}
    </section>
  );
}
