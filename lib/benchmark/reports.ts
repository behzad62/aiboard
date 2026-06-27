import type { BenchmarkDashboardData } from "@/lib/benchmark/metrics";
import {
  classifyBenchmarkFailure,
  explainCertifiedFailureStatus,
  groupFailureClassifications,
} from "@/lib/benchmark/failures";
import { aggregateCertifiedRunScores } from "@/lib/benchmark/scoring/aggregate";
import type {
  BenchmarkAttemptV2,
  BenchmarkCaseV2,
  BenchmarkFailure,
  BenchmarkReportBundle,
  BenchmarkReportBundleV2,
  BenchmarkTeamComposition,
  BenchmarkVerifierResult,
  HarnessCertificationResult,
} from "@/lib/benchmark/types";

export type BenchmarkReportBundleAny =
  | BenchmarkReportBundle
  | BenchmarkReportBundleV2;

export function formatBenchmarkMarkdownReport(
  bundle: BenchmarkReportBundleAny,
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

  if (isBenchmarkReportBundleV2(bundle)) {
  appendCertifiedReportSections(lines, bundle);
  }

  lines.push("## Raw Bundle Counts");
  lines.push(`- Suites: ${bundle.suites.length}`);
  lines.push(`- Runs: ${bundle.runs.length}`);
  lines.push(`- Cases: ${bundle.cases.length}`);
  lines.push(`- Attempts: ${bundle.attempts.length}`);
  lines.push(`- Metric values: ${bundle.metricValues.length}`);
  lines.push(`- Artifacts: ${bundle.artifacts.length}`);
  lines.push(`- Failures: ${bundle.failures.length}`);
  lines.push(`- Model-call traces: ${bundle.traces.length}`);
  lines.push(
    `- Game match records: ${bundle.sourceEvidence?.gameMatches.length ?? 0}`
  );
  lines.push(
    `- Build checkpoints: ${bundle.sourceEvidence?.buildCheckpoints.length ?? 0}`
  );
  lines.push(
    `- Build model stats: ${bundle.sourceEvidence?.buildStats.length ?? 0}`
  );
  lines.push("");
  lines.push(
    "Paste this report with the exported JSON bundle when you want Codex to debug a benchmark result."
  );
  return lines.join("\n");
}

export function downloadBenchmarkJson(bundle: BenchmarkReportBundleAny): void {
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

function appendCertifiedReportSections(
  lines: string[],
  bundle: BenchmarkReportBundleV2
): void {
  const certifiedAttempts = bundle.attemptsV2.filter(isCertifiedModeAttempt);
  const certifiedAttemptIds = new Set(certifiedAttempts.map((attempt) => attempt.id));
  const certifiedVerifierResults = bundle.verifierResults.filter((result) =>
    certifiedAttemptIds.has(result.attemptId)
  );
  const completedAttempts = certifiedAttempts.filter((attempt) =>
    isCertifiedAttemptComplete(attempt.status)
  );
  const passedAttempts = certifiedAttempts.filter(
    (attempt) => attempt.status === "passed"
  );
  const verifiedAttempts = certifiedVerifierResults.filter(
    (result) => result.passed
  );
  const uniqueRunIds = uniqueValues(
    certifiedAttempts.map((attempt) => attempt.runId).filter(isNonEmptyString)
  );
  const uniqueCaseIds = uniqueValues(bundle.caseV2.map((item) => item.id));
  const averageQuality = average(
    completedAttempts
      .map((attempt) => attempt.verifiedQuality)
      .filter(isFiniteNumber)
  );
  const averageCost = average(
    completedAttempts.map((attempt) => attempt.costUsd).filter(isFiniteNumber)
  );
  const averageDuration = average(
    completedAttempts
      .map((attempt) => attempt.durationMs)
      .filter(isFiniteNumber)
  );

  lines.push("## Certified Run Summary");
  lines.push(`- Certified runs: ${uniqueRunIds.length}`);
  lines.push(`- Certified cases: ${uniqueCaseIds.length}`);
  lines.push(`- Certified attempts: ${certifiedAttempts.length}`);
  lines.push(
    `- Completed attempts: ${completedAttempts.length} (${formatPct(
      rate(completedAttempts.length, certifiedAttempts.length)
    )})`
  );
  lines.push(
    `- Verified pass rate: ${formatPct(
      rate(verifiedAttempts.length, certifiedVerifierResults.length)
    )}`
  );
  lines.push(
    `- Attempt pass rate: ${formatPct(
      rate(passedAttempts.length, certifiedAttempts.length)
    )}`
  );
  lines.push(`- Average verified quality: ${formatScore(averageQuality)}`);
  lines.push(`- Average cost: ${formatUsd(averageCost)}`);
  lines.push(`- Average duration: ${formatDuration(averageDuration)}`);
  lines.push("");

  appendTopCertifiedTeams(lines, bundle, certifiedAttempts);
  appendTopCertifiedModels(lines, bundle, certifiedAttempts);
  appendCertifiedTradeoffs(lines, bundle, certifiedAttempts);
  appendTeamLiftMatrix(lines, bundle, certifiedAttempts);
  appendCertifiedFailureTaxonomy(lines, bundle, certifiedAttempts);
  appendVerifierAssertionSummary(lines, certifiedVerifierResults);
  appendHarnessVersions(lines, bundle, certifiedAttempts);
  appendCaseVersions(lines, bundle.caseV2);
  appendReproducibilityHashes(lines, bundle);
  appendRawV2Counts(lines, bundle);
}

function appendTopCertifiedTeams(
  lines: string[],
  bundle: BenchmarkReportBundleV2,
  certifiedAttempts: BenchmarkAttemptV2[]
): void {
  const teamsById = new Map(bundle.teamCompositions.map((team) => [team.id, team]));
  const rows = Array.from(groupAttemptsByTeam(certifiedAttempts).entries())
    .map(([teamId, attempts]) => {
      const team = teamsById.get(teamId);
      const quality = average(
        attempts.map((attempt) => attempt.verifiedQuality).filter(isFiniteNumber)
      );
      return {
        teamId,
        label: team?.name ?? teamId,
        attempts: attempts.length,
        passed: attempts.filter((attempt) => attempt.status === "passed").length,
        quality,
        cost: average(
          attempts.map((attempt) => attempt.costUsd).filter(isFiniteNumber)
        ),
      };
    })
    .sort((a, b) => (b.quality ?? -1) - (a.quality ?? -1))
    .slice(0, 8);

  lines.push("## Top Certified Teams");
  if (rows.length === 0) {
    lines.push("- No certified team attempts recorded.");
  } else {
    for (const row of rows) {
      lines.push(
        `- ${row.label}: quality ${formatScore(row.quality)}, pass rate ${formatPct(
          rate(row.passed, row.attempts)
        )}, ${row.attempts} attempt(s), avg cost ${formatUsd(row.cost)}`
      );
    }
  }
  lines.push("");
}

function appendTopCertifiedModels(
  lines: string[],
  bundle: BenchmarkReportBundleV2,
  certifiedAttempts: BenchmarkAttemptV2[]
): void {
  const teamsById = new Map(bundle.teamCompositions.map((team) => [team.id, team]));
  const rows = Array.from(groupAttemptsByModel(certifiedAttempts, teamsById).entries())
    .map(([modelId, item]) => ({
      modelId,
      displayName: item.displayName,
      attempts: item.attempts.length,
      quality: average(
        item.attempts
          .map((attempt) => attempt.verifiedQuality)
          .filter(isFiniteNumber)
      ),
      passed: item.attempts.filter((attempt) => attempt.status === "passed")
        .length,
    }))
    .sort((a, b) => (b.quality ?? -1) - (a.quality ?? -1))
    .slice(0, 8);

  lines.push("## Top Certified Models");
  if (rows.length === 0) {
    lines.push("- No certified model attempts recorded.");
  } else {
    for (const row of rows) {
      lines.push(
        `- ${row.displayName}: quality ${formatScore(
          row.quality
        )}, pass rate ${formatPct(rate(row.passed, row.attempts))}, ${
          row.attempts
        } attempt(s)`
      );
    }
  }
  lines.push("");
}

function appendCertifiedTradeoffs(
  lines: string[],
  bundle: BenchmarkReportBundleV2,
  certifiedAttempts: BenchmarkAttemptV2[]
): void {
  const rows = aggregateCertifiedRunScores({
    attempts: certifiedAttempts,
    cases: bundle.caseV2,
    teamCompositions: bundle.teamCompositions,
    verifierResults: bundle.verifierResults,
  })
    .sort(
      (a, b) =>
        b.efficiencyScore - a.efficiencyScore ||
        b.verifiedQuality - a.verifiedQuality ||
        a.displayName.localeCompare(b.displayName)
    )
    .slice(0, 8);

  lines.push("## Cost Speed Quality Tradeoffs");
  if (rows.length === 0) {
    lines.push("- No certified tradeoff rows recorded.");
  } else {
    for (const row of rows) {
      lines.push(
        `- ${row.displayName}: verified quality ${formatScore(
          row.verifiedQuality
        )}, efficiency ${formatScore(row.efficiencyScore)}, cost/pass ${formatUsd(
          row.costPerPass
        )}, speed/pass ${formatDuration(row.speedPerPassMs)}`
      );
    }
  }
  lines.push("");
}

function appendTeamLiftMatrix(
  lines: string[],
  bundle: BenchmarkReportBundleV2,
  certifiedAttempts: BenchmarkAttemptV2[]
): void {
  const rows = aggregateCertifiedRunScores({
    attempts: certifiedAttempts,
    cases: bundle.caseV2,
    teamCompositions: bundle.teamCompositions,
    verifierResults: bundle.verifierResults,
  }).filter((row) => row.modelIds.length > 1);

  lines.push("## Team Lift Matrix");
  if (rows.length === 0) {
    lines.push("- No multi-model certified teams with complete solo baselines recorded.");
  } else {
    for (const row of rows.slice(0, 12)) {
      lines.push(
        `- ${row.displayName}: team lift ${formatNumber(
          row.teamLift
        )}, best solo ${formatNumber(row.bestSoloScore)}, label ${
          row.teamLiftLabel ?? "n/a"
        }`
      );
    }
  }
  lines.push("");
}

function appendCertifiedFailureTaxonomy(
  lines: string[],
  bundle: BenchmarkReportBundleV2,
  certifiedAttempts: BenchmarkAttemptV2[]
): void {
  const certifiedAttemptIds = new Set(certifiedAttempts.map((attempt) => attempt.id));
  const relatedFailures = bundle.failures.filter((failure) =>
    isCertifiedFailureRecord(failure, certifiedAttemptIds)
  );
  const grouped = groupFailureClassifications(
    relatedFailures.map(classifyBenchmarkFailure)
  ).filter((row) => row.count > 0);
  const statusRows = countBy(
    certifiedAttempts
      .filter((attempt) => attempt.status !== "passed")
      .map((attempt) => attempt.status)
  );

  lines.push("## Failure Taxonomy");
  if (grouped.length === 0 && statusRows.length === 0) {
    lines.push("- No certified failures recorded.");
  } else {
    for (const row of grouped) {
      lines.push(
        `- ${row.group}: ${row.count} failure(s), ${row.invalidRuns} invalid run(s), ${row.modelAccountable} model-accountable`
      );
    }
    for (const row of statusRows.slice(0, 12)) {
      lines.push(
        `- Status ${row.label}: ${row.count} attempt(s). ${explainCertifiedFailureStatus(
          row.label as BenchmarkAttemptV2["status"]
        )}`
      );
    }
  }
  lines.push("");
}

function appendVerifierAssertionSummary(
  lines: string[],
  verifierResults: BenchmarkVerifierResult[]
): void {
  const assertions = new Map<
    string,
    { label: string; passed: number; total: number; weight: number }
  >();

  for (const result of verifierResults) {
    for (const assertion of result.assertionResults ?? []) {
      const key = assertion.id || assertion.label;
      const existing =
        assertions.get(key) ?? {
          label: assertion.label || assertion.id,
          passed: 0,
          total: 0,
          weight: 0,
        };
      existing.total += 1;
      existing.passed += assertion.passed ? 1 : 0;
      existing.weight += assertion.weight ?? 0;
      assertions.set(key, existing);
    }
  }

  lines.push("## Verifier Assertion Summary");
  if (assertions.size === 0) {
    lines.push("- No verifier assertions recorded.");
  } else {
    for (const row of Array.from(assertions.values()).slice(0, 12)) {
      lines.push(
        `- ${row.label}: ${row.passed}/${row.total} passed, avg weight ${formatNumber(
          rate(row.weight, row.total)
        )}`
      );
    }
  }
  lines.push("");
}

function appendHarnessVersions(
  lines: string[],
  bundle: BenchmarkReportBundleV2,
  certifiedAttempts: BenchmarkAttemptV2[]
): void {
  const versionRows = countBy(
    certifiedAttempts.map((attempt) =>
      [
        attempt.harnessProfile,
        attempt.harnessVersion,
        attempt.promptSetVersion,
        attempt.scoringVersion,
      ]
        .filter(isNonEmptyString)
        .join(" | ")
    )
  );

  lines.push("## Harness Versions");
  if (versionRows.length === 0) {
    lines.push("- No harness versions recorded.");
  } else {
    for (const row of versionRows.slice(0, 12)) {
      lines.push(`- ${row.label}: ${row.count} attempt(s)`);
    }
  }

  if (bundle.harnessCertifications.length > 0) {
    for (const certification of bundle.harnessCertifications.slice(0, 8)) {
      lines.push(
        `- Certification ${certification.harnessProfile}: ${
          certification.passed ? "passed" : "failed"
        }, ${certification.checks.length} check(s), ${formatCertificationVersion(
          certification
        )}`
      );
    }
  }
  lines.push("");
}

function appendCaseVersions(
  lines: string[],
  cases: BenchmarkCaseV2[]
): void {
  const rows = countBy(
    cases.map((item) =>
      `${item.track || "unknown"} @ ${item.caseVersion || "unversioned"}`
    )
  );

  lines.push("## Case Versions");
  if (rows.length === 0) {
    lines.push("- No certified case versions recorded.");
  } else {
    for (const row of rows.slice(0, 12)) {
      lines.push(`- ${row.label}: ${row.count} case(s)`);
    }
  }
  lines.push("");
}

function appendReproducibilityHashes(
  lines: string[],
  bundle: BenchmarkReportBundleV2
): void {
  const promptHashes = bundle.caseV2
    .map((item) => item.prompt?.hiddenNotesHash ?? readStringField(item, "promptHash"))
    .filter(isNonEmptyString);
  const fixtureHashes = bundle.caseV2
    .map((item) => item.repo?.fixtureHash)
    .filter(isNonEmptyString);
  const baseCommits = bundle.caseV2
    .map((item) => item.repo?.baseCommit)
    .filter(isNonEmptyString);
  const comboHashes = bundle.teamCompositions
    .map((team) => team.comboHash)
    .filter(isNonEmptyString);

  lines.push("## Reproducibility Hashes");
  lines.push(`- Bundle hash: ${bundle.bundleHash || "n/a"}`);
  lines.push(`- Prompt or hidden-note hashes: ${formatHashList(promptHashes)}`);
  lines.push(`- Fixture hashes: ${formatHashList(fixtureHashes)}`);
  lines.push(`- Base commits: ${formatHashList(baseCommits)}`);
  lines.push(`- Team combo hashes: ${formatHashList(comboHashes)}`);
  lines.push("");
}

function appendRawV2Counts(
  lines: string[],
  bundle: BenchmarkReportBundleV2
): void {
  const certifiedAttempts = bundle.attemptsV2.filter(isCertifiedModeAttempt);
  lines.push("## Raw V2 Counts");
  lines.push(`- Certified cases: ${bundle.caseV2.length}`);
  lines.push(`- Certified attempts: ${certifiedAttempts.length}`);
  lines.push(`- V2 attempts: ${bundle.attemptsV2.length}`);
  lines.push(`- Verifier results: ${bundle.verifierResults.length}`);
  lines.push(`- Run events: ${bundle.runEvents?.length ?? 0}`);
  lines.push(`- Tool-call traces: ${bundle.toolCallTraces?.length ?? 0}`);
  lines.push(`- Team compositions: ${bundle.teamCompositions.length}`);
  lines.push(`- Harness certifications: ${bundle.harnessCertifications.length}`);
  lines.push(
    `- Redaction scanned artifacts: ${
      bundle.redactionSummary?.scannedArtifacts ?? 0
    }`
  );
  lines.push(
    `- Redacted secrets: ${bundle.redactionSummary?.redactedSecrets ?? 0}`
  );
  lines.push("");
}

function isBenchmarkReportBundleV2(
  bundle: BenchmarkReportBundleAny
): bundle is BenchmarkReportBundleV2 {
  return bundle.version === 2;
}

function isCertifiedModeAttempt(attempt: BenchmarkAttemptV2): boolean {
  return attempt.mode === "certified";
}

function isCertifiedAttemptComplete(status: string): boolean {
  return (
    status === "passed" ||
    status === "failed_model" ||
    status === "failed_verifier" ||
    status === "failed_tool_use" ||
    status === "failed_budget" ||
    status === "provider_unavailable" ||
    status === "invalid_harness" ||
    status === "invalid_environment" ||
    status === "invalid_case" ||
    status === "aborted_user"
  );
}

function groupAttemptsByTeam(
  attempts: BenchmarkAttemptV2[]
): Map<string, BenchmarkAttemptV2[]> {
  const rows = new Map<string, BenchmarkAttemptV2[]>();
  for (const attempt of attempts) {
    const key = attempt.teamCompositionId || "unknown";
    rows.set(key, [...(rows.get(key) ?? []), attempt]);
  }
  return rows;
}

function groupAttemptsByModel(
  attempts: BenchmarkAttemptV2[],
  teamsById: Map<string, BenchmarkTeamComposition>
): Map<
  string,
  {
    displayName: string;
    attempts: BenchmarkAttemptV2[];
  }
> {
  const rows = new Map<
    string,
    {
      displayName: string;
      attempts: BenchmarkAttemptV2[];
    }
  >();

  for (const attempt of attempts) {
    const team = teamsById.get(attempt.teamCompositionId);
    for (const role of team?.roles ?? []) {
      const existing =
        rows.get(role.modelId) ?? {
          displayName: role.displayName || role.modelId,
          attempts: [],
        };
      existing.attempts.push(attempt);
      rows.set(role.modelId, existing);
    }
  }

  return rows;
}

function countBy(values: string[]): Array<{ label: string; count: number }> {
  const counts = new Map<string, number>();
  for (const value of values) {
    if (!value) continue;
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return Array.from(counts.entries())
    .map(([label, count]) => ({ label, count }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}

function isCertifiedFailureRecord(
  failure: BenchmarkFailure,
  certifiedAttemptIds: Set<string>
): boolean {
  return !failure.attemptId || certifiedAttemptIds.has(failure.attemptId);
}

function uniqueValues(values: string[]): string[] {
  return Array.from(new Set(values));
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function readStringField(value: unknown, key: string): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const field = (value as Record<string, unknown>)[key];
  return typeof field === "string" ? field : undefined;
}

function rate(numerator: number, denominator: number): number | null {
  return denominator > 0 ? numerator / denominator : null;
}

function average(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function formatScore(value: number | null): string {
  if (value == null) return "n/a";
  return value <= 1 ? `${Math.round(value * 1000) / 10}/100` : `${round(value)}/100`;
}

function formatNumber(value: number | null): string {
  return value == null ? "n/a" : String(round(value, 2));
}

function round(value: number, digits = 1): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function formatCertificationVersion(
  certification: HarnessCertificationResult
): string {
  return [
    certification.harnessVersion,
    certification.promptSetVersion,
    certification.benchmarkEngineVersion,
  ]
    .filter(isNonEmptyString)
    .join(" | ");
}

function formatHashList(values: string[]): string {
  const unique = uniqueValues(values);
  if (unique.length === 0) return "n/a";
  return unique.slice(0, 6).join(", ");
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
