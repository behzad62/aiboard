import type { BuildStopReport } from "@/lib/db/schema";
import type { BenchmarkArtifact, BenchmarkCase } from "@/lib/benchmark/types";
import { formatBuildStopReportMarkdown } from "@/lib/orchestrator/build-stop-report";

/**
 * Captured "real-work" build cases are minted from Build-mode stop reports as
 * diagnostics only. No runner, executor, or scorer can ever consume them: they
 * feed no leaderboard, pass rate, or verifier output. They must therefore never
 * be presented as benchmark coverage — they are excluded from the dashboard
 * "Cases" count / coverage metrics and flagged (not counted as evidence) in
 * export bundles. See docs/bench/case-quality-review-2026-07-02.md (Task E).
 *
 * This is a read-time classifier, not a migration: old persisted v1 cases in
 * user stores still load unchanged; we only decline to count them as coverage.
 */
export function isCapturedBuildCase(
  benchmarkCase: Pick<BenchmarkCase, "kind">
): boolean {
  return benchmarkCase.kind === "real-work";
}

export interface PartitionedBenchmarkCases {
  /** Cases a runner can actually execute and score. */
  runnable: BenchmarkCase[];
  /** Captured stop-report cases — diagnostics only, never runnable/scored. */
  captured: BenchmarkCase[];
}

/**
 * Split v1 benchmark cases into runnable vs captured-stop-report cases so
 * callers can present an honest count. Captured cases are diagnostics, not
 * benchmark coverage.
 */
export function partitionBenchmarkCases(
  cases: readonly BenchmarkCase[]
): PartitionedBenchmarkCases {
  const runnable: BenchmarkCase[] = [];
  const captured: BenchmarkCase[] = [];
  for (const benchmarkCase of cases) {
    if (isCapturedBuildCase(benchmarkCase)) captured.push(benchmarkCase);
    else runnable.push(benchmarkCase);
  }
  return { runnable, captured };
}

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
