import type { BuildStopReport } from "@/lib/db/schema";
import type { BenchmarkArtifact, BenchmarkCase } from "@/lib/benchmark/types";
import { formatBuildStopReportMarkdown } from "@/lib/orchestrator/build-stop-report";

export function createBuildBenchmarkCaseFromStopReport(
  report: BuildStopReport
): { benchmarkCase: BenchmarkCase; artifact: BenchmarkArtifact } {
  const now = new Date().toISOString();
  const id = `build-case-${report.discussionId}-${report.createdAt.replace(/[^0-9a-z]/gi, "")}`;
  const artifactId = `${id}-stop-report`;

  return {
    benchmarkCase: {
      id,
      kind: "real-work",
      domain: "build",
      title: report.topic.slice(0, 110) || "Build-mode benchmark case",
      description: report.summary,
      createdAt: now,
      updatedAt: now,
      discussionId: report.discussionId,
      sourceId: report.id,
      verifierCommand: report.verifyCommand,
      tags: [
        "real-work",
        "build-mode",
        report.status,
        report.stopReason,
        report.primaryCause?.code ?? "no-primary-cause",
      ],
      configJson: JSON.stringify(
        {
          topic: report.topic,
          branch: report.branch,
          prUrl: report.prUrl,
          wave: report.wave,
          tasksDone: report.tasksDone,
          tasksTotal: report.tasksTotal,
          incompleteTasks: report.incompleteTasks,
          repeatedFailureCount: report.repeatedFailureCount,
          primaryCause: report.primaryCause,
          commandProblems: report.commandProblems,
          recoveryLog: report.recoveryLog,
        },
        null,
        2
      ),
      expectedJson: JSON.stringify(
        {
          verifyCommand: report.verifyCommand,
          desiredOutcome: "All planned tasks complete and verification passes.",
        },
        null,
        2
      ),
    },
    artifact: {
      id: artifactId,
      caseId: id,
      kind: "markdown",
      label: "Build stop report",
      mimeType: "text/markdown",
      content: formatBuildStopReportMarkdown(report),
      createdAt: now,
    },
  };
}
