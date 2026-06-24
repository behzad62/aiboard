import type { BenchmarkDashboardData } from "@/lib/benchmark/metrics";
import type { BenchmarkReportBundle } from "@/lib/benchmark/types";

export function formatBenchmarkMarkdownReport(
  bundle: BenchmarkReportBundle,
  dashboard: BenchmarkDashboardData
): string {
  const lines: string[] = [];
  lines.push("# LLM Benchmark Lab Report");
  lines.push("");
  lines.push(`Generated: ${bundle.exportedAt}`);
  lines.push("");
  lines.push("## Summary");
  lines.push(`- Total runs: ${dashboard.summary.totalRuns}`);
  lines.push(`- Total cases: ${dashboard.summary.totalCases}`);
  lines.push(`- Models: ${dashboard.summary.totalModels}`);
  lines.push(
    `- Completion rate: ${formatPct(dashboard.summary.completionRate)}`
  );
  lines.push(
    `- Schema-valid rate: ${formatPct(dashboard.summary.schemaValidRate)}`
  );
  lines.push(
    `- Legal-action rate: ${formatPct(dashboard.summary.legalActionRate)}`
  );
  lines.push(`- Fallback rate: ${formatPct(dashboard.summary.fallbackRate)}`);
  lines.push(`- Average cost: ${formatUsd(dashboard.summary.averageCostUsd)}`);
  lines.push(
    `- Average latency: ${formatDuration(dashboard.summary.averageLatencyMs)}`
  );
  lines.push("");

  lines.push("## Model Scorecards");
  for (const model of dashboard.models.slice(0, 12)) {
    lines.push(
      `- ${model.displayName}: quality ${model.qualityScore}/100, strategy ${model.strategyScore}/100, rules ${model.ruleComplianceScore}/100, structured output ${model.structuredOutputScore}/100, tool use ${model.toolUseScore}/100, reliability ${model.reliabilityScore}/100`
    );
  }
  lines.push("");

  lines.push("## Failure Categories");
  for (const row of dashboard.failureRows.slice(0, 12)) {
    lines.push(
      `- ${row.displayName}: provider ${row.provider}, parser ${row.parser}, rules ${row.rules}, tool ${row.tool}, verifier ${row.verifier}, other ${row.other}`
    );
  }
  if (dashboard.failureRows.length === 0) lines.push("- No failures recorded.");
  lines.push("");

  lines.push("## Head To Head");
  for (const row of dashboard.headToHeadRows.slice(0, 12)) {
    lines.push(
      `- ${row.modelADisplay} vs ${row.modelBDisplay}: ${row.modelAWins}-${row.modelBWins}-${row.draws} over ${row.games} game(s)`
    );
  }
  if (dashboard.headToHeadRows.length === 0) {
    lines.push("- No two-model game matches recorded.");
  }
  lines.push("");

  lines.push("## Raw Bundle Counts");
  lines.push(`- Suites: ${bundle.suites.length}`);
  lines.push(`- Runs: ${bundle.runs.length}`);
  lines.push(`- Cases: ${bundle.cases.length}`);
  lines.push(`- Attempts: ${bundle.attempts.length}`);
  lines.push(`- Metric values: ${bundle.metricValues.length}`);
  lines.push(`- Artifacts: ${bundle.artifacts.length}`);
  lines.push(`- Failures: ${bundle.failures.length}`);
  lines.push(`- Model-call traces: ${bundle.traces.length}`);
  lines.push("");
  lines.push(
    "Paste this report with the exported JSON bundle when you want Codex to debug a benchmark result."
  );
  return lines.join("\n");
}

export function downloadBenchmarkJson(bundle: BenchmarkReportBundle): void {
  downloadText(
    `ai-board-benchmark-${bundle.exportedAt.slice(0, 10)}.json`,
    "application/json",
    JSON.stringify(bundle, null, 2)
  );
}

export function downloadBenchmarkMarkdown(markdown: string): void {
  const date = new Date().toISOString().slice(0, 10);
  downloadText(`ai-board-benchmark-${date}.md`, "text/markdown", markdown);
}

function downloadText(filename: string, mimeType: string, content: string): void {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function formatPct(value: number | null): string {
  return value == null ? "n/a" : `${Math.round(value * 100)}%`;
}

function formatUsd(value: number | null): string {
  return value == null ? "n/a" : `$${value.toFixed(3)}`;
}

function formatDuration(value: number | null): string {
  if (value == null) return "n/a";
  if (value < 1000) return `${Math.round(value)}ms`;
  return `${(value / 1000).toFixed(1)}s`;
}
