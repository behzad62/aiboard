import {
  buildCertifiedBenchmarkDashboardData,
  type BenchmarkDashboardData,
} from "@/lib/benchmark/metrics";
import {
  classifyBenchmarkFailure,
  explainCertifiedFailureStatus,
  groupFailureClassifications,
} from "@/lib/benchmark/failures";
import type { CertifiedRunScore } from "@/lib/benchmark/scoring/types";
import type {
  BenchmarkAttemptV2,
  BenchmarkCaseV2,
  BenchmarkFailure,
  BenchmarkReportBundleV2,
  BenchmarkTeamComposition,
  BenchmarkVerifierResult,
} from "@/lib/benchmark/types";
import {
  benchmarkVariantLabel,
  normalizeBenchmarkReasoningEffort,
} from "@/lib/benchmark/model-effort";

export function formatBenchmarkMarkdownReport(
  bundle: BenchmarkReportBundleV2,
  _dashboard: BenchmarkDashboardData
): string {
  const lines: string[] = [];
  lines.push("# LLM Benchmark Lab Report");
  lines.push("");
  lines.push(`Generated: ${bundle.exportedAt}`);
  lines.push("");
  appendCertifiedReportSections(lines, bundle);
  return lines.join("\n");
}

export function downloadBenchmarkJson(bundle: BenchmarkReportBundleV2): void {
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
  const certifiedDashboard = buildCertifiedBenchmarkDashboardData({
    resultSets: bundle.resultSets ?? [],
    runs: bundle.runs,
    caseV2: bundle.caseV2,
    attemptsV2: bundle.attemptsV2,
    verifierResults: bundle.verifierResults,
    artifacts: bundle.artifacts,
    failures: bundle.failures,
    traces: bundle.traces,
    runEvents: bundle.runEvents,
    toolCallTraces: bundle.toolCallTraces,
    teamCompositions: bundle.teamCompositions,
    harnessCertifications: bundle.harnessCertifications,
  });
  const latestResultSetIds = new Set(
    certifiedDashboard.leaderboard.flatMap((row) =>
      row.resultSetId ? [row.resultSetId] : []
    )
  );
  const certifiedAttempts = bundle.attemptsV2.filter(
    (attempt) =>
      isCertifiedModeAttempt(attempt) &&
      attempt.resultSetId !== undefined &&
      latestResultSetIds.has(attempt.resultSetId)
  );
  const scoredAttempts = certifiedAttempts;
  const scoredAttemptIds = new Set(certifiedAttempts.map((attempt) => attempt.id));
  const certifiedVerifierResults = bundle.verifierResults.filter((result) =>
    scoredAttemptIds.has(result.attemptId)
  );
  const latestCaseIds = new Set(certifiedAttempts.map((attempt) => attempt.caseId));
  const latestCases = bundle.caseV2.filter((item) => latestCaseIds.has(item.id));

  lines.push("## Certified Run Summary");
  lines.push(`- Certified runs: ${certifiedDashboard.summary.certifiedRuns}`);
  lines.push(`- Certified cases: ${certifiedDashboard.summary.certifiedCases}`);
  lines.push(`- Certified attempts: ${certifiedDashboard.summary.certifiedAttempts}`);
  lines.push(`- Scored attempts: ${certifiedDashboard.summary.scoredAttempts}`);
  lines.push(
    `- Excluded attempts: ${certifiedDashboard.summary.excludedAttempts} (provider ${certifiedDashboard.summary.excludedProviderAttempts}, harness ${certifiedDashboard.summary.excludedHarnessAttempts}, environment ${certifiedDashboard.summary.excludedEnvironmentAttempts}, user ${certifiedDashboard.summary.excludedUserAttempts})`
  );
  lines.push(
    `- Completed attempts: ${certifiedDashboard.summary.scoredAttempts} (${formatPct(
      rate(
        certifiedDashboard.summary.scoredAttempts,
        certifiedDashboard.summary.certifiedAttempts
      )
    )})`
  );
  lines.push(
    `- Verified pass rate: ${formatPct(certifiedDashboard.summary.verifiedPassRate)}`
  );
  lines.push(
    `- Attempt pass rate: ${formatPct(certifiedDashboard.summary.verifiedPassRate)}`
  );
  lines.push(
    `- Average verified quality: ${formatNormalizedScore(
      certifiedDashboard.summary.averageVerifiedQuality
    )}`
  );
  lines.push(
    `- Average cost: ${formatUsd(certifiedDashboard.summary.averageCostUsd)}`
  );
  lines.push(
    `- Average duration: ${formatDuration(
      certifiedDashboard.summary.averageDurationMs
    )}`
  );
  lines.push("");

  lines.push("## Latest Certified Snapshots");
  if (certifiedDashboard.leaderboard.length === 0) {
    lines.push("- No validated completed benchmark snapshots recorded.");
  } else {
    for (const row of certifiedDashboard.leaderboard) {
      lines.push(
        `- ${row.resultSetId}: ${row.displayName}, completed ${row.completedAt}, overall ${formatNormalizedScore(
          row.overallScore
        )}, pass rate ${formatPct(row.verifiedPassRate)}`
      );
    }
  }
  lines.push("");

  lines.push("## Certified Snapshot History");
  const historyRows = certifiedDashboard.resultHistory.flatMap(
    (series) => series.older
  );
  if (historyRows.length === 0) {
    lines.push("- No older validated completed snapshots recorded.");
  } else {
    for (const row of historyRows) {
      lines.push(
        `- ${row.resultSetId}: ${row.displayName}, completed ${row.completedAt}, overall ${formatNormalizedScore(
          row.overallScore
        )}, pass rate ${formatPct(row.verifiedPassRate)}`
      );
    }
  }
  lines.push("");

  appendTopCertifiedTeams(lines, bundle, certifiedDashboard.leaderboard);
  appendTopCertifiedModels(lines, certifiedDashboard.leaderboard);
  appendCertifiedTradeoffs(lines, certifiedDashboard.leaderboard);
  appendTeamLiftMatrix(lines, bundle, certifiedDashboard.leaderboard);
  appendCertifiedFailureTaxonomy(lines, bundle, certifiedAttempts);
  appendVerifierAssertionSummary(lines, certifiedVerifierResults);
  appendHarnessVersions(lines, scoredAttempts);
  appendCaseVersions(lines, latestCases);
  appendReproducibilityHashes(
    lines,
    bundle,
    latestCases,
    new Set(certifiedDashboard.leaderboard.map((row) => row.teamCompositionId))
  );
}

function appendTopCertifiedTeams(
  lines: string[],
  bundle: BenchmarkReportBundleV2,
  snapshotRows: CertifiedRunScore[]
): void {
  const teamsById = new Map(bundle.teamCompositions.map((team) => [team.id, team]));
  const rows = snapshotRows
    .map((row) => ({
      ...row,
      label: row.teamName,
      roster: formatTeamRoster(teamsById.get(row.teamCompositionId)),
    }))
    .sort((a, b) => b.verifiedQuality - a.verifiedQuality)
    .slice(0, 8);

  lines.push("## Top Certified Teams");
  if (rows.length === 0) {
    lines.push("- No certified team attempts recorded.");
  } else {
    for (const row of rows) {
      lines.push(
        `- ${row.label}: quality ${formatNormalizedScore(row.verifiedQuality)}, pass rate ${formatPct(
          row.verifiedPassRate
        )}, ${row.attempts} attempt(s), avg cost ${formatUsd(row.averageCostUsd)}${
          row.roster ? `; roster ${row.roster}` : ""
        }; snapshot ${row.resultSetId ?? "n/a"}; configuration ${
          row.configurationKey ?? "n/a"
        }`
      );
    }
  }
  lines.push("");
}

function appendTopCertifiedModels(
  lines: string[],
  snapshotRows: CertifiedRunScore[]
): void {
  const rows = snapshotRows
    .filter((row) => !row.isTeam)
    .sort((a, b) => b.verifiedQuality - a.verifiedQuality)
    .slice(0, 8);

  lines.push("## Top Certified Models");
  if (rows.length === 0) {
    lines.push("- No certified model attempts recorded.");
  } else {
    for (const row of rows) {
      lines.push(
        `- ${row.displayName}: quality ${formatNormalizedScore(
          row.verifiedQuality
        )}, pass rate ${formatPct(row.verifiedPassRate)}, ${
          row.attempts
        } attempt(s); snapshot ${row.resultSetId ?? "n/a"}; configuration ${
          row.configurationKey ?? "n/a"
        }`
      );
    }
  }
  lines.push("");
}

function appendCertifiedTradeoffs(
  lines: string[],
  snapshotRows: CertifiedRunScore[]
): void {
  const rows = [...snapshotRows]
    .sort(
      (a, b) =>
        b.efficiencyScore - a.efficiencyScore ||
        b.verifiedQuality - a.verifiedQuality ||
        a.displayName.localeCompare(b.displayName)
    )
    .slice(0, 8);

  lines.push("## Cost Speed Verified Quality Tradeoffs");
  if (rows.length === 0) {
    lines.push("- No certified tradeoff rows recorded.");
  } else {
    for (const row of rows) {
      lines.push(
        `- ${row.displayName}: verified quality ${formatNormalizedScore(
          row.verifiedQuality
        )}, efficiency ${formatScore(row.efficiencyScore)}, cost/pass ${formatUsd(
          row.costPerPass
        )}, speed/pass ${formatDuration(
          row.speedPerPassMs
        )}; snapshot ${row.resultSetId ?? "n/a"}; configuration ${
          row.configurationKey ?? "n/a"
        }`
      );
    }
  }
  lines.push("");
}

function appendTeamLiftMatrix(
  lines: string[],
  bundle: BenchmarkReportBundleV2,
  snapshotRows: CertifiedRunScore[]
): void {
  const rows = snapshotRows.filter((row) => row.isTeam);

  lines.push("## Team Lift Matrix");
  if (rows.length === 0) {
    lines.push("- No multi-model certified teams with complete solo baselines recorded.");
  } else {
    for (const row of rows.slice(0, 12)) {
      const team = bundle.teamCompositions.find(
        (item) => item.id === row.teamCompositionId
      );
      const roster = formatTeamRoster(team);
      const comparisonKeys = row.trackBreakdown
        .filter((track) => row.teamLiftTracks.includes(track.track))
        .map(
          (track) =>
            `${track.track}=${track.comparisonKey ?? "unavailable"}`
        )
        .join("; ");
      lines.push(
        `- ${row.displayName}: team lift ${formatNumber(
          row.teamLift
        )}, best solo ${formatNumber(row.bestSoloScore)}, label ${
          row.teamLiftLabel ?? "n/a"
        }; execution ${row.executionId ?? "n/a"}; comparison tracks ${
          row.teamLiftTracks.join(", ") || "n/a"
        }; comparison keys ${comparisonKeys || "n/a"}${
          roster ? `; roster ${roster}` : ""
        }; snapshot ${row.resultSetId ?? "n/a"}; configuration ${
          row.configurationKey ?? "n/a"
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
  bundle: BenchmarkReportBundleV2,
  cases: BenchmarkCaseV2[],
  teamCompositionIds: ReadonlySet<string>
): void {
  const promptHashes = cases
    .map((item) => item.prompt?.hiddenNotesHash ?? readStringField(item, "promptHash"))
    .filter(isNonEmptyString);
  const fixtureHashes = cases
    .map((item) => item.repo?.fixtureHash)
    .filter(isNonEmptyString);
  const baseCommits = cases
    .map((item) => item.repo?.baseCommit)
    .filter(isNonEmptyString);
  const comboHashes = bundle.teamCompositions
    .filter((team) => teamCompositionIds.has(team.id))
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

function isCertifiedModeAttempt(attempt: BenchmarkAttemptV2): boolean {
  return attempt.mode === "certified";
}

function formatTeamRoster(
  team: BenchmarkTeamComposition | undefined
): string {
  return (team?.roles ?? [])
    .map(
      (role) =>
        `${role.role}: ${benchmarkVariantLabel(
          role.displayName || role.modelId,
          normalizeBenchmarkReasoningEffort(role.reasoningEffort)
        )}`
    )
    .join(", ");
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
  return Boolean(
    failure.attemptId && certifiedAttemptIds.has(failure.attemptId)
  );
}

function uniqueValues(values: string[]): string[] {
  return Array.from(new Set(values));
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

function formatScore(value: number | null): string {
  if (value == null) return "n/a";
  return `${round(value)}/100`;
}

function formatNormalizedScore(value: number | null): string {
  if (value == null) return "n/a";
  return formatScore(value * 100);
}

function formatNumber(value: number | null): string {
  return value == null ? "n/a" : String(round(value, 2));
}

function round(value: number, digits = 1): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
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
  a.rel = "noopener";
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    URL.revokeObjectURL(url);
    a.remove();
  }, 0);
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
