"use client";

import { useMemo, useState } from "react";
import {
  AlertTriangle,
  Check,
  ClipboardCopy,
  Download,
  ListTodo,
  Save,
  Terminal,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { BuildStopReport } from "@/lib/db/schema";
import { formatBuildStopReportMarkdown } from "@/lib/orchestrator/build-stop-report";
import { createBuildBenchmarkCaseFromStopReport } from "@/lib/benchmark/build-cases";
import {
  saveBenchmarkArtifact,
  saveBenchmarkCase,
} from "@/lib/benchmark/store";
import { downloadMarkdown, fileSlug } from "@/lib/ui/download";

interface BuildStopReportPanelProps {
  report: BuildStopReport;
}

function formatTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

function compact(text: string, max = 520): string {
  return text.length <= max ? text : `${text.slice(0, max).trimEnd()}...`;
}

export function BuildStopReportPanel({ report }: BuildStopReportPanelProps) {
  const [copied, setCopied] = useState(false);
  const [savedCase, setSavedCase] = useState(false);
  const markdown = useMemo(() => formatBuildStopReportMarkdown(report), [report]);
  const latestCommand = report.commandProblems[0];

  const copyReport = async () => {
    await navigator.clipboard.writeText(markdown);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  };

  const saveAsBenchmarkCase = async () => {
    const { benchmarkCase, artifact } = createBuildBenchmarkCaseFromStopReport(report);
    await saveBenchmarkCase(benchmarkCase);
    await saveBenchmarkArtifact(artifact);
    setSavedCase(true);
    window.setTimeout(() => setSavedCase(false), 1800);
  };

  const downloadReport = () => {
    const createdAt = report.createdAt.slice(0, 10);
    downloadMarkdown(
      `build-stop-report-${createdAt}-${fileSlug(report.topic, 36)}.md`,
      markdown
    );
  };

  return (
    <section className="rounded-lg border border-amber-300 bg-amber-50/80 text-amber-950 shadow-sm dark:border-amber-900 dark:bg-amber-950/25 dark:text-amber-50">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-amber-200 px-4 py-3 dark:border-amber-900">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <AlertTriangle className="h-4 w-4 shrink-0" />
            <h2 className="text-sm font-semibold">Why stopped</h2>
            <Badge variant="warning" className="font-mono">
              {report.stopReason}
            </Badge>
            <span className="font-mono text-xs opacity-75">
              wave {report.wave} - {report.tasksDone}/{report.tasksTotal} tasks
            </span>
          </div>
          <p className="mt-1 text-sm">{report.summary}</p>
          <p className="mt-1 text-xs opacity-80">{formatTime(report.createdAt)}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={downloadReport}
            className="shrink-0"
          >
            <Download className="mr-2 h-4 w-4" />
            Download report
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={saveAsBenchmarkCase}
            className="shrink-0"
          >
            {savedCase ? (
              <Check className="mr-2 h-4 w-4" />
            ) : (
              <Save className="mr-2 h-4 w-4" />
            )}
            {savedCase ? "Saved" : "Save to benchmarks"}
          </Button>
          <Button size="sm" variant="outline" onClick={copyReport} className="shrink-0">
            {copied ? (
              <Check className="mr-2 h-4 w-4" />
            ) : (
              <ClipboardCopy className="mr-2 h-4 w-4" />
            )}
            {copied ? "Copied" : "Copy report"}
          </Button>
        </div>
      </div>

      <div className="grid gap-px bg-amber-200/70 dark:bg-amber-900/70 lg:grid-cols-[1.1fr_0.9fr]">
        <div className="bg-amber-50/90 p-4 dark:bg-[#1b1304]">
          <p className="text-xs font-semibold uppercase tracking-wide opacity-70">
            Primary cause
          </p>
          {report.primaryCause ? (
            <div className="mt-2 space-y-2">
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant="destructive" className="font-mono">
                  {report.primaryCause.code}
                </Badge>
                <span className="text-xs opacity-75">{report.primaryCause.source}</span>
                {report.primaryCause.modelName && (
                  <span className="text-xs opacity-75">
                    {report.primaryCause.modelName}
                    {report.primaryCause.providerId
                      ? ` / ${report.primaryCause.providerId}`
                      : ""}
                  </span>
                )}
              </div>
              <p className="text-sm">{report.primaryCause.message}</p>
              {report.primaryCause.details && (
                <pre className="max-h-36 overflow-auto rounded-md border border-amber-200 bg-background/70 p-2 font-mono text-[0.7rem] text-foreground dark:border-amber-900">
                  {compact(report.primaryCause.details, 900)}
                </pre>
              )}
            </div>
          ) : (
            <p className="mt-2 text-sm opacity-80">No primary cause recorded.</p>
          )}
        </div>

        <div className="bg-amber-50/90 p-4 dark:bg-[#1b1304]">
          <p className="text-xs font-semibold uppercase tracking-wide opacity-70">
            Next action
          </p>
          <p className="mt-2 text-sm">{report.nextAction}</p>
          {report.repeatedFailureCount > 0 && (
            <p className="mt-2 font-mono text-xs opacity-75">
              repeated failure count: {report.repeatedFailureCount}
            </p>
          )}
        </div>
      </div>

      {latestCommand && (
        <div className="border-t border-amber-200 bg-amber-50/70 px-4 py-3 dark:border-amber-900 dark:bg-transparent">
          <p className="mb-2 flex items-center gap-2 text-sm font-medium">
            <Terminal className="h-4 w-4" />
            Latest failed command
          </p>
          <div className="rounded-md border border-amber-200 bg-background/70 p-2 dark:border-amber-900">
            <div className="flex flex-wrap items-center justify-between gap-2 font-mono text-xs">
              <span className="break-all">$ {latestCommand.command}</span>
              <Badge variant="destructive">
                exit {latestCommand.exitCode} -{" "}
                {(latestCommand.durationMs / 1000).toFixed(1)}s
              </Badge>
            </div>
            {latestCommand.outputPreview && (
              <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap font-mono text-[0.7rem] text-muted-foreground">
                {latestCommand.outputPreview}
              </pre>
            )}
          </div>
        </div>
      )}

      {report.incompleteTasks.length > 0 && (
        <div className="border-t border-amber-200 bg-amber-50/70 px-4 py-3 dark:border-amber-900 dark:bg-transparent">
          <p className="mb-2 flex items-center gap-2 text-sm font-medium">
            <ListTodo className="h-4 w-4" />
            Unfinished tasks
          </p>
          <ul className="grid gap-2 md:grid-cols-2">
            {report.incompleteTasks.map((task) => (
              <li
                key={task.id}
                className="rounded-md border border-amber-200 bg-background/70 px-3 py-2 text-sm dark:border-amber-900"
              >
                <span className="font-mono text-xs opacity-70">{task.id}</span>{" "}
                {task.title}
                <span className="ml-2 font-mono text-xs opacity-70">
                  {task.status}
                  {task.failCount ? ` - ${task.failCount} failed` : ""}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {report.problems.length > 0 && (
        <div className="border-t border-amber-200 bg-amber-50/70 px-4 py-3 dark:border-amber-900 dark:bg-transparent">
          <p className="mb-2 text-sm font-medium">Recent tool and build problems</p>
          <ol className="space-y-1.5">
            {report.problems.slice(0, 5).map((problem) => (
              <li key={problem.id} className="text-sm">
                <span className="font-mono text-xs opacity-70">{problem.code}</span>{" "}
                {problem.message}
              </li>
            ))}
          </ol>
        </div>
      )}
    </section>
  );
}
